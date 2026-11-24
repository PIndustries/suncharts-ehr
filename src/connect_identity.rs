// SPDX-License-Identifier: AGPL-3.0-only
//! Passwordless staff and linked-patient sessions delegated by SunCharts Connect.

use crate::{
    auth::{Actor, Role},
    browser::BrowserAuth,
    error::{Error, Result},
    State,
};
use axum::{
    extract::State as ExtractState,
    http::{header, HeaderMap},
    Json,
};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;

// Must match the maximum Connect grant lifetime. The session remains revocable and is
// introspected against Connect on authenticated requests.
const MAX_SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptRequest {
    code: String,
    issuer: String,
}
#[derive(Serialize)]
struct ExchangeRequest<'a> {
    code: &'a str,
    audience: &'a str,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Claims {
    iss: String,
    aud: String,
    sub: String,
    jti: Uuid,
    kind: String,
    email: Option<String>,
    tenant_id: Uuid,
    patient_ehr_puuid: Option<String>,
    iat: i64,
    exp: i64,
}
#[derive(Serialize)]
struct IntrospectRequest<'a> {
    jti: Uuid,
    audience: &'a str,
}
#[derive(Deserialize)]
struct Introspection {
    active: bool,
    #[serde(default)]
    jti: Option<Uuid>,
    #[serde(default)]
    aud: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    tenant_id: Option<Uuid>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    patient_ehr_puuid: Option<String>,
    #[serde(default)]
    exp: Option<i64>,
}

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("suncharts-ehr/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| Error::Unauthorized)
}
fn issuer() -> Result<String> {
    crate::connect_onboarding::cloud_origin()
}
pub(crate) fn staff_sign_in_url(audience: &str) -> Result<String> {
    let cloud = issuer()?;
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("audience", audience)
        .finish();
    Ok(format!("{cloud}/ehr/launch?{query}"))
}
fn validate(c: &Claims, iss: &str, aud: &str, now: i64) -> Result<()> {
    if c.iss != iss
        || c.aud != aud
        || !matches!(c.kind.as_str(), "staff" | "patient")
        || c.sub.is_empty()
        || c.iat > now + 5
        || c.exp <= now
        || c.exp <= c.iat
        || c.exp - c.iat > MAX_SESSION_SECONDS
    {
        return Err(Error::Unauthorized);
    }
    match c.kind.as_str() {
        "staff" if c.email.is_some() && c.patient_ehr_puuid.is_none() => Ok(()),
        "patient" if c.email.is_none() && c.patient_ehr_puuid.is_some() => Ok(()),
        _ => Err(Error::Unauthorized),
    }
}
fn secret() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|v| format!("{v:02x}")).collect()
}
pub(crate) async fn connected(db: &sqlx::PgPool) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_service_settings WHERE enabled AND verified AND NOT revoked)")
        .fetch_one(db).await?)
}

async fn connected_local_tenant(db: &sqlx::PgPool) -> Result<Uuid> {
    let tenants: Vec<Uuid> = sqlx::query_scalar(
        "SELECT tenant_id FROM connect_service_settings WHERE enabled AND verified AND NOT revoked ORDER BY tenant_id LIMIT 2",
    )
    .fetch_all(db)
    .await?;
    match tenants.as_slice() {
        [tenant] => Ok(*tenant),
        _ => Err(Error::Unauthorized),
    }
}

pub async fn mode(ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    let auth = s.browser.as_ref().ok_or(Error::NotFound)?;
    let connected = connected(&auth.db).await?;
    let staff_sign_in_url = staff_sign_in_url(auth.origin())?;
    let cloud = issuer()?;
    let patient_query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("ehr_audience", auth.origin())
        .finish();
    Ok(Json(json!({
        "mode": if connected {"connect"} else {"local"}, "connected": connected,
        "staff_sign_in_url": connected.then_some(staff_sign_in_url),
        "patient_sign_in_url": connected.then(|| format!("{cloud}/patient/?{patient_query}")),
        "patient_identity": "explicit_link_required"
    })))
}

pub async fn accept(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(input): Json<AcceptRequest>,
) -> Result<(HeaderMap, Json<Value>)> {
    let auth = s.browser.as_ref().ok_or(Error::NotFound)?;
    // Embedded user agents may omit Origin on a same-origin POST. The custom
    // handoff header is an equivalent CSRF boundary: cross-origin forms cannot
    // set it, and cross-origin scripts cannot pass the CORS preflight. Existing
    // clients presenting the exact configured Origin remain supported.
    if auth.check_origin(&h).is_err()
        && h.get("x-suncharts-identity-handoff")
            .and_then(|value| value.to_str().ok())
            != Some("1")
    {
        return Err(Error::Forbidden);
    }
    let iss = issuer()?;
    if input.issuer != iss || input.code.len() < 32 || input.code.len() > 256 {
        return Err(Error::Unauthorized);
    }
    let response = http()?
        .post(format!("{iss}/api/v1/managed-ehr/identity/exchange"))
        .json(&ExchangeRequest {
            code: input.code.trim(),
            audience: auth.origin(),
        })
        .send()
        .await
        .map_err(|_| Error::Unauthorized)?;
    if !response.status().is_success() {
        return Err(Error::Unauthorized);
    }
    let c: Claims = response.json().await.map_err(|_| Error::Unauthorized)?;
    let now = Utc::now().timestamp();
    validate(&c, &iss, auth.origin(), now)?;
    // Connect clinic UUIDs and self-hosted EHR tenant UUIDs are independent
    // namespaces. The exchange endpoint has already bound this grant to this
    // installation audience; resolve the single verified local installation
    // tenant and retain the Connect tenant separately for introspection.
    let local_tenant = connected_local_tenant(&auth.db).await?;
    let token = secret();
    let mut tx = auth.db.begin().await?;
    let body = if c.kind == "staff" {
        let (id, role): (Uuid, String) = sqlx::query_as(
            "SELECT id,role FROM browser_users WHERE tenant_id=$1 AND email=$2 AND NOT disabled",
        )
        .bind(local_tenant)
        .bind(c.email.as_deref())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::Unauthorized)?;
        sqlx::query("INSERT INTO connect_identity_sessions(token_hash,tenant_id,issuer_tenant_id,user_id,grant_id,issuer,audience,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8))")
            .bind(crate::browser::hash(&token)).bind(local_tenant).bind(c.tenant_id).bind(id).bind(c.jti).bind(&iss)
            .bind(auth.origin()).bind(c.exp as f64).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,'connect_identity.staff_login',$3)")
            .bind(local_tenant).bind(c.jti).bind(id).execute(&mut *tx).await?;
        json!({"authenticated":true,"kind":"staff","role":role})
    } else {
        let patient = Uuid::parse_str(c.patient_ehr_puuid.as_deref().ok_or(Error::Unauthorized)?)
            .map_err(|_| Error::Unauthorized)?;
        let (account, version): (Uuid, i64) = sqlx::query_as(
            "WITH updated AS (
               UPDATE patient_portal_accounts SET status='active',identity_mode='connect',password_hash=NULL,version=version+1
                WHERE tenant_id=$1 AND patient_id=$2 AND status IN('invited','active')
                  AND NOT (identity_mode='connect' AND status='active') RETURNING id,version
             ) SELECT id,version FROM updated
             UNION ALL SELECT id,version FROM patient_portal_accounts
              WHERE tenant_id=$1 AND patient_id=$2 AND status='active' AND identity_mode='connect'
             LIMIT 1")
            .bind(local_tenant).bind(patient).fetch_optional(&mut *tx).await?.ok_or(Error::Unauthorized)?;
        sqlx::query("INSERT INTO patient_connect_sessions(token_hash,tenant_id,issuer_tenant_id,account_id,account_version,grant_id,issuer,audience,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9))")
            .bind(crate::browser::hash(&token)).bind(local_tenant).bind(c.tenant_id).bind(account).bind(version).bind(c.jti)
            .bind(&iss).bind(auth.origin()).bind(c.exp as f64).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO patient_portal_events(tenant_id,patient_id,actor_id,actor_kind,action,resource_id,version,details) VALUES($1,$2,$3,'patient','connect_identity_login',$4,$5,$6)")
            .bind(local_tenant).bind(patient).bind(account).bind(account).bind(version)
            .bind(json!({"grant_id":c.jti})).execute(&mut *tx).await?;
        json!({"authenticated":true,"kind":"patient","account_id":account})
    };
    tx.commit().await?;
    let seconds = (c.exp - now).clamp(1, MAX_SESSION_SECONDS) as u64;
    let cookie = if c.kind == "staff" {
        auth.session_cookie(&token, seconds)
    } else {
        format!("sce_portal={token}; HttpOnly; SameSite=Strict; Path=/api/v1/patient-portal; Max-Age={seconds}{}",
            if auth.origin().starts_with("https:") { "; Secure" } else { "" })
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        cookie.parse().map_err(|_| Error::Unauthorized)?,
    );
    Ok((headers, Json(body)))
}

async fn introspect(iss: &str, grant: Uuid, audience: &str) -> Result<Introspection> {
    let r = http()?
        .post(format!("{iss}/api/v1/managed-ehr/identity/introspect"))
        .json(&IntrospectRequest {
            jti: grant,
            audience,
        })
        .send()
        .await
        .map_err(|_| Error::Unauthorized)?;
    if !r.status().is_success() {
        return Err(Error::Unauthorized);
    }
    r.json().await.map_err(|_| Error::Unauthorized)
}

#[derive(sqlx::FromRow)]
struct StaffSession {
    tenant_id: Uuid,
    issuer_tenant_id: Uuid,
    user_id: Uuid,
    grant_id: Uuid,
    issuer: String,
    audience: String,
    expires_at: DateTime<Utc>,
    role: String,
    email: String,
}
pub(crate) async fn authenticate_staff_hash(
    auth: &BrowserAuth,
    token_hash: &str,
) -> Result<Option<Actor>> {
    let s: Option<StaffSession> = sqlx::query_as("SELECT s.tenant_id,s.issuer_tenant_id,s.user_id,s.grant_id,s.issuer,s.audience,s.expires_at,u.role,u.email FROM connect_identity_sessions s JOIN browser_users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL AND NOT u.disabled")
        .bind(token_hash).fetch_optional(&auth.db).await?;
    let Some(s) = s else {
        log_refused(0, "session not found");
        return Ok(None);
    };
    let i = match introspect(&s.issuer, s.grant_id, &s.audience).await {
        Ok(i) => i,
        Err(error) => {
            log_refused(1, "connect check unreachable");
            return Err(error);
        }
    };
    let now = Utc::now().timestamp();
    let failed = staff_mismatch(&i, &s, auth.origin(), now);
    if let Some(field) = failed {
        if field == "active" {
            log_refused(2, "connect check said inactive");
        } else {
            log_refused(
                3 + mismatch_slot(field),
                &format!("connect check mismatch {field}"),
            );
        }
    }
    if failed.is_some() {
        sqlx::query("UPDATE connect_identity_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1")
            .bind(token_hash).execute(&auth.db).await?;
        return Err(Error::Unauthorized);
    }
    sqlx::query(
        "UPDATE connect_identity_sessions SET last_introspected_at=now() WHERE token_hash=$1",
    )
    .bind(token_hash)
    .execute(&auth.db)
    .await?;
    let role: Role = serde_json::from_value(json!(s.role)).map_err(|_| Error::Unauthorized)?;
    Ok(Some(Actor {
        sub: s.user_id,
        tenant_id: s.tenant_id,
        role,
        patient_id: None,
        iss: s.issuer,
        aud: s.audience,
        iat: now,
        exp: s.expires_at.timestamp(),
    }))
}

/// Which check on a Connect answer failed, by field name only; None when the session is good.
fn staff_mismatch(
    i: &Introspection,
    s: &StaffSession,
    origin: &str,
    now: i64,
) -> Option<&'static str> {
    if !i.active {
        Some("active")
    } else if i.jti != Some(s.grant_id) {
        Some("jti")
    } else if i.aud.as_deref() != Some(origin) {
        Some("aud")
    } else if i.kind.as_deref() != Some("staff") {
        Some("kind")
    } else if i.tenant_id != Some(s.issuer_tenant_id) {
        Some("tenant")
    } else if i.email.as_deref() != Some(&s.email) {
        Some("email")
    } else if !i
        .exp
        .is_some_and(|v| v > now && v <= s.expires_at.timestamp())
    {
        Some("exp")
    } else {
        None
    }
}
fn mismatch_slot(field: &str) -> usize {
    ["jti", "aud", "kind", "tenant", "email", "exp"]
        .iter()
        .position(|f| *f == field)
        .unwrap_or(0)
}

static REFUSED: [std::sync::atomic::AtomicU64; 16] =
    [const { std::sync::atomic::AtomicU64::new(0) }; 16];
/// One log line per refusal reason, at most one per ten seconds each: a fixed reason word and
/// nothing about who asked.
pub(crate) fn log_refused(slot: usize, reason: &str) {
    let now = Utc::now().timestamp().max(1) as u64;
    if refusal_gate(&REFUSED[slot.min(15)], now) {
        eprintln!("staff sign-in refused: {reason}");
    }
}
pub(crate) fn refusal_gate(last: &std::sync::atomic::AtomicU64, now: u64) -> bool {
    use std::sync::atomic::Ordering::Relaxed;
    let before = last.load(Relaxed);
    (before == 0 || now.saturating_sub(before) >= 10)
        && last.compare_exchange(before, now, Relaxed, Relaxed).is_ok()
}

pub(crate) async fn patient_session(
    db: &sqlx::PgPool,
    token: &str,
) -> Result<Option<(Uuid, Uuid, Uuid)>> {
    let row: Option<PatientSession> = sqlx::query_as("SELECT s.tenant_id,s.issuer_tenant_id,s.account_id,s.grant_id,s.issuer,s.audience,s.expires_at,a.patient_id FROM patient_connect_sessions s JOIN patient_portal_accounts a ON a.tenant_id=s.tenant_id AND a.id=s.account_id AND a.version=s.account_version WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL AND a.status='active'")
        .bind(crate::browser::hash(token)).fetch_optional(db).await?;
    let Some(session) = row else {
        return Ok(None);
    };
    let i = introspect(&session.issuer, session.grant_id, &session.audience).await?;
    let now = Utc::now().timestamp();
    let valid = i.active
        && i.jti == Some(session.grant_id)
        && i.kind.as_deref() == Some("patient")
        && i.tenant_id == Some(session.issuer_tenant_id)
        && i.patient_ehr_puuid.as_deref() == Some(&session.patient_id.to_string())
        && i.exp
            .is_some_and(|v| v > now && v <= session.expires_at.timestamp());
    if !valid {
        sqlx::query("UPDATE patient_connect_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1")
            .bind(crate::browser::hash(token)).execute(db).await?;
        return Err(Error::Unauthorized);
    }
    sqlx::query(
        "UPDATE patient_connect_sessions SET last_introspected_at=now() WHERE token_hash=$1",
    )
    .bind(crate::browser::hash(token))
    .execute(db)
    .await?;
    Ok(Some((
        session.tenant_id,
        session.patient_id,
        session.account_id,
    )))
}

#[derive(sqlx::FromRow)]
struct PatientSession {
    tenant_id: Uuid,
    issuer_tenant_id: Uuid,
    account_id: Uuid,
    grant_id: Uuid,
    issuer: String,
    audience: String,
    expires_at: DateTime<Utc>,
    patient_id: Uuid,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_cross_kind_claims() {
        let now = Utc::now().timestamp();
        let c = Claims {
            iss: "https://connect.example".into(),
            aud: "https://ehr.example".into(),
            sub: "x".into(),
            jti: Uuid::new_v4(),
            kind: "staff".into(),
            email: None,
            tenant_id: Uuid::new_v4(),
            patient_ehr_puuid: Some(Uuid::new_v4().to_string()),
            iat: now,
            exp: now + 60,
        };
        assert!(validate(&c, &c.iss, &c.aud, now).is_err());
    }

    #[test]
    fn names_the_failed_check_and_rate_limits_each_reason() {
        let now = 1_000_000;
        let grant = Uuid::new_v4();
        let tenant = Uuid::new_v4();
        let session = StaffSession {
            tenant_id: Uuid::new_v4(),
            issuer_tenant_id: tenant,
            user_id: Uuid::new_v4(),
            grant_id: grant,
            issuer: "https://connect.example".into(),
            audience: "https://ehr.example".into(),
            expires_at: DateTime::from_timestamp(now + 600, 0).unwrap(),
            role: "owner".into(),
            email: "staff@example.test".into(),
        };
        let good = || Introspection {
            active: true,
            jti: Some(grant),
            aud: Some("https://ehr.example".into()),
            kind: Some("staff".into()),
            tenant_id: Some(tenant),
            email: Some("staff@example.test".into()),
            patient_ehr_puuid: None,
            exp: Some(now + 300),
        };
        let check = |i: &Introspection| staff_mismatch(i, &session, "https://ehr.example", now);
        assert_eq!(check(&good()), None);
        let mut i = good();
        i.active = false;
        assert_eq!(check(&i), Some("active"));
        let mut i = good();
        i.kind = Some("patient".into());
        assert_eq!(check(&i), Some("kind"));
        let mut i = good();
        i.email = Some("other@example.test".into());
        assert_eq!(check(&i), Some("email"));
        let mut i = good();
        i.exp = Some(now - 1);
        assert_eq!(check(&i), Some("exp"));

        let last = std::sync::atomic::AtomicU64::new(0);
        assert!(refusal_gate(&last, now as u64));
        assert!(!refusal_gate(&last, now as u64 + 9));
        assert!(refusal_gate(&last, now as u64 + 10));
    }
}
