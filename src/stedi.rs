// SPDX-License-Identifier: AGPL-3.0-only
//! Stedi's published raw 837P and transaction-input contracts. No generic gateway envelope.
use crate::{
    clearinghouse::Submission,
    delivery::{Adapter, Route},
    error::{Error, Result},
};
use serde_json::{json, Value};
use uuid::Uuid;
pub const SUBMIT: &str = "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/professionalclaims/v3/raw-x12-submission";
pub const CORE: &str = "https://core.us.stedi.com/2023-08-01";
pub(crate) fn validate(r: &Route) -> Result<()> {
    if r.adapter != Adapter::Stedi {
        if r.adapter == Adapter::Gateway && (r.retrieval.is_some() || r.sftp.is_some()) {
            return Err(Error::Invalid(
                "generic gateway retrieval is not configured",
            ));
        }
        if r.adapter == Adapter::ClaimMd {
            crate::claimmd::validate(r)?;
        }
        return Ok(());
    }
    if r.sftp.is_some() {
        return Err(Error::Invalid("Stedi API route cannot carry SFTP settings"));
    }
    if !r.loopback_test && r.endpoint != SUBMIT {
        return Err(Error::Invalid(
            "Stedi submission endpoint must be the documented US endpoint",
        ));
    }
    if let Some(settings) = &r.retrieval {
        settings.validate(r)?;
    }
    Ok(())
}
pub(crate) struct Confirmation {
    pub correlation: String,
    pub acknowledgment: Option<String>,
}
pub(crate) fn receipt(code: u16, body: &[u8], out: &Submission) -> Option<Confirmation> {
    if code != 200 {
        return None;
    }
    let v: Value = serde_json::from_slice(body).ok()?;
    if v["status"] != "SUCCESS"
        || v.get("errors")
            .is_some_and(|e| e.as_array().is_none_or(|e| !e.is_empty()))
        || v["claimReference"]["patientControlNumber"] != out.claim_snapshot["control_number"]
    {
        return None;
    }
    let correlation = v["claimReference"]["correlationId"].as_str()?;
    if correlation.is_empty()
        || correlation.len() > 100
        || !correlation
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return None;
    }
    let acknowledgment = v["x12"]
        .as_str()
        .filter(|v| !v.is_empty() && v.is_ascii() && v.len() <= 48000)
        .map(str::to_owned);
    Some(Confirmation {
        correlation: correlation.into(),
        acknowledgment,
    })
}
pub(crate) fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| Error::Invalid("provider HTTP client unavailable"))
}
pub(crate) async fn bytes(mut r: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(c) = r
        .chunk()
        .await
        .map_err(|_| Error::Invalid("provider read failed"))?
    {
        if bytes.len() + c.len() > limit {
            return Err(Error::Invalid("provider response exceeds supported limit"));
        }
        bytes.extend_from_slice(&c);
    }
    Ok(bytes)
}
fn token(r: &Route) -> Result<String> {
    match &r.credential_env {
        Some(k) => std::env::var(k)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .ok_or(Error::Invalid("provider credential unavailable")),
        None if r.loopback_test => Ok("synthetic-loopback-key".into()),
        _ => Err(Error::Invalid("provider credential unavailable")),
    }
}
pub(crate) async fn page(
    r: &Route,
    page_token: Option<&str>,
    start: chrono::DateTime<chrono::Utc>,
) -> Result<Value> {
    let settings = r
        .retrieval
        .as_ref()
        .ok_or(Error::Invalid("retrieval not configured"))?;
    let mut u = url::Url::parse(&format!("{}/polling/transactions", settings.core_base))
        .map_err(|_| Error::Invalid("invalid provider base"))?;
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("pageSize", "25");
        if let Some(t) = page_token {
            q.append_pair("pageToken", t);
        } else {
            q.append_pair("startDateTime", &start.to_rfc3339());
        }
    }
    let response = client()?
        .get(u)
        .header("Authorization", token(r)?)
        .send()
        .await
        .map_err(|_| Error::Invalid("provider poll failed"))?;
    if response.status() != 200 {
        return Err(Error::Invalid("provider poll HTTP failure"));
    }
    serde_json::from_slice(&bytes(response, 262144).await?)
        .map_err(|_| Error::Invalid("invalid provider page"))
}
pub(crate) async fn input(r: &Route, id: Uuid) -> Result<String> {
    let settings = r
        .retrieval
        .as_ref()
        .ok_or(Error::Invalid("retrieval not configured"))?;
    let url = format!("{}/transactions/{id}/input", settings.core_base);
    let response = client()?
        .get(url)
        .header("Authorization", token(r)?)
        .send()
        .await
        .map_err(|_| Error::Invalid("provider input request failed"))?;
    let code = response.status().as_u16();
    let raw = if code == 302 {
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let v: Value = serde_json::from_slice(&bytes(response, 8192).await?).unwrap_or(json!({}));
        let body_url = v["documentDownloadUrl"].as_str();
        if location.as_ref().zip(body_url).is_some_and(|(a, b)| a != b) {
            return Err(Error::Invalid("provider download locations conflict"));
        }
        let target = location
            .as_deref()
            .or(body_url)
            .ok_or(Error::Invalid("provider download location missing"))?;
        let u = url::Url::parse(target)
            .map_err(|_| Error::Invalid("invalid provider download location"))?;
        if !u.username().is_empty() || u.password().is_some() || u.fragment().is_some() {
            return Err(Error::Invalid("invalid provider download credentials"));
        }
        let allowed = if r.loopback_test {
            u.origin() == url::Url::parse(&settings.core_base).unwrap().origin()
        } else {
            u.scheme() == "https"
                && u.port_or_known_default() == Some(443)
                && settings
                    .download_hosts
                    .iter()
                    .any(|h| Some(h.as_str()) == u.host_str())
        };
        if !allowed {
            return Err(Error::Invalid("provider download host is not allowlisted"));
        }
        // Signed document URLs have their own authorization. Never forward the API key.
        let download = client()?
            .get(u)
            .send()
            .await
            .map_err(|_| Error::Invalid("provider document download failed"))?;
        if download.status() != 200 {
            return Err(Error::Invalid("provider download HTTP failure"));
        }
        bytes(download, 48000).await?
    } else if code == 200 {
        bytes(response, 48000).await?
    } else {
        return Err(Error::Invalid("provider input HTTP failure"));
    };
    let text =
        String::from_utf8(raw).map_err(|_| Error::Invalid("provider document is not text"))?;
    if !text.is_ascii() || text.is_empty() {
        return Err(Error::Invalid("provider document requires bounded ASCII"));
    }
    Ok(text)
}
