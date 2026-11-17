// SPDX-License-Identifier: AGPL-3.0-only
//! Provider taxonomy codes filled in from the national NPI registry rather than
//! typed. A single read-only lookup, best-effort: any problem yields no code and
//! never fails the caller. Only the NPI leaves this process; the response body is
//! never logged.
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const SETTING: &str = "ENGINE_NPI_REGISTRY_URL";
const DEFAULT_BASE: &str = "https://npiregistry.cms.hhs.gov";
const FOUND_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MISS_TTL: Duration = Duration::from_secs(10 * 60);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(4);

/// The configured registry base, or `None` when the lookup is turned off. The
/// setting is read the way the other optional `ENGINE_*` settings are read: an
/// env var with a default. An empty value turns the lookup off. When a value is
/// present it must parse as an http(s) URL with a host and no credentials, query
/// or fragment; anything else is treated as off rather than trusting a bad value.
fn base_url() -> Option<String> {
    let raw = std::env::var(SETTING).unwrap_or_else(|_| DEFAULT_BASE.into());
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none_or(|h| h.is_empty())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(raw.trim_end_matches('/').to_owned())
}

fn client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .timeout(TOTAL_TIMEOUT)
        .user_agent(concat!("suncharts-ehr/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()
}

fn is_npi(npi: &str) -> bool {
    npi.len() == 10 && npi.bytes().all(|b| b.is_ascii_digit())
}

/// The taxonomy code a caller may store, or `None`. A found code lives 24 hours;
/// a miss or failure lives 10 minutes so a transient outage is retried soon
/// without hammering the registry on every save.
pub async fn primary_taxonomy(npi: &str) -> Option<String> {
    if !is_npi(npi) {
        return None;
    }
    let base = base_url()?;
    if let Some(cached) = cached(npi) {
        return cached;
    }
    let found = fetch(&base, npi).await;
    store(npi, found.clone());
    found
}

async fn fetch(base: &str, npi: &str) -> Option<String> {
    let url = format!("{base}/api/?version=2.1&number={npi}");
    let response = client()?
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    if response.status() != 200 {
        return None;
    }
    let body = response.bytes().await.ok()?;
    if body.len() > 262_144 {
        return None;
    }
    let value: Value = serde_json::from_slice(&body).ok()?;
    primary_taxonomy_from(&value)
}

/// Picks the code out of a registry response. The primary taxonomy wins; with no
/// primary and exactly one taxonomy that one is used; anything else yields none.
/// A code is accepted only as exactly ten ASCII letters or digits, uppercased.
fn primary_taxonomy_from(value: &Value) -> Option<String> {
    let taxonomies = value
        .get("results")
        .and_then(Value::as_array)?
        .first()?
        .get("taxonomies")
        .and_then(Value::as_array)?;
    let mut single: Option<&Value> = None;
    for taxonomy in taxonomies {
        if taxonomy.get("primary").and_then(Value::as_bool) == Some(true) {
            return clean_code(taxonomy.get("code").and_then(Value::as_str));
        }
        if single.is_some() {
            return None;
        }
        single = Some(taxonomy);
    }
    clean_code(single?.get("code").and_then(Value::as_str))
}

/// Exactly ten ASCII letters or digits, uppercased, or nothing.
fn clean_code(raw: Option<&str>) -> Option<String> {
    let code = raw?.trim();
    if code.len() == 10 && code.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Some(code.to_ascii_uppercase());
    }
    None
}

type Cache = Mutex<HashMap<String, (Instant, Option<String>)>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Cache::new(HashMap::new()))
}

fn cached(npi: &str) -> Option<Option<String>> {
    let guard = cache().lock().ok()?;
    let (at, value) = guard.get(npi)?;
    let ttl = if value.is_some() { FOUND_TTL } else { MISS_TTL };
    if at.elapsed() < ttl {
        return Some(value.clone());
    }
    None
}

fn store(npi: &str, value: Option<String>) {
    if let Ok(mut guard) = cache().lock() {
        guard.insert(npi.to_owned(), (Instant::now(), value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn primary_taxonomy_is_picked() {
        let v = json!({"result_count":1,"results":[{"number":"1234567893","taxonomies":[
            {"code":"207Q00000X","desc":"Family","primary":false,"state":"TX"},
            {"code":"207Q00000X","desc":"X","primary":true,"state":"ZZ"}]}]});
        assert_eq!(primary_taxonomy_from(&v).as_deref(), Some("207Q00000X"));
    }

    #[test]
    fn a_single_non_primary_taxonomy_is_picked() {
        let v = json!({"results":[{"taxonomies":[{"code":"207q00000x","primary":false}]}]});
        assert_eq!(primary_taxonomy_from(&v).as_deref(), Some("207Q00000X"));
    }

    #[test]
    fn two_non_primary_taxonomies_yield_nothing() {
        let v = json!({"results":[{"taxonomies":[
            {"code":"207Q00000X","primary":false},
            {"code":"174F00000X","primary":false}]}]});
        assert_eq!(primary_taxonomy_from(&v), None);
    }

    #[test]
    fn a_malformed_code_is_rejected() {
        let v = json!({"results":[{"taxonomies":[{"code":"207Q0000X","primary":true}]}]});
        assert_eq!(primary_taxonomy_from(&v), None);
        let v = json!({"results":[{"taxonomies":[{"code":"207Q00000-","primary":true}]}]});
        assert_eq!(primary_taxonomy_from(&v), None);
    }

    #[test]
    fn empty_results_yield_nothing() {
        assert_eq!(
            primary_taxonomy_from(&json!({"result_count":0,"results":[]})),
            None
        );
        assert_eq!(primary_taxonomy_from(&json!({"results":[]})), None);
        assert_eq!(primary_taxonomy_from(&json!({})), None);
    }

    #[test]
    fn a_non_digit_npi_is_not_looked_up() {
        assert!(!is_npi("123456789"));
        assert!(!is_npi("123456789a"));
        assert!(is_npi("1234567893"));
    }
}
