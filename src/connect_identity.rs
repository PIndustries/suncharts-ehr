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

const MAX_SESSION_SECONDS: i64 = 8 * 60 * 60;

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
    auth.check_origin(&h)?;
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
    let token = secret();
    let mut tx = auth.db.begin().await?;
    let body = if c.kind == "staff" {
        let (id, role): (Uuid, String) = sqlx::query_as(
            "SELECT id,role FROM browser_users WHERE tenant_id=$1 AND email=$2 AND NOT disabled",
        )
        .bind(c.tenant_id)
        .bind(c.email.as_deref())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::Unauthorized)?;
        sqlx::query("INSERT INTO connect_identity_sessions(token_hash,tenant_id,user_id,grant_id,issuer,audience,expires_at) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7))")
            .bind(crate::browser::hash(&token)).bind(c.tenant_id).bind(id).bind(c.jti).bind(&iss)
            .bind(auth.origin()).bind(c.exp as f64).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,'connect_identity.staff_login',$3)")
            .bind(c.tenant_id).bind(c.jti).bind(id).execute(&mut *tx).await?;
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
            .bind(c.tenant_id).bind(patient).fetch_optional(&mut *tx).await?.ok_or(Error::Unauthorized)?;
        sqlx::query("INSERT INTO patient_connect_sessions(token_hash,tenant_id,account_id,account_version,grant_id,issuer,audience,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8))")
            .bind(crate::browser::hash(&token)).bind(c.tenant_id).bind(account).bind(version).bind(c.jti)
            .bind(&iss).bind(auth.origin()).bind(c.exp as f64).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO patient_portal_events(tenant_id,patient_id,actor_id,actor_kind,action,resource_id,version,details) VALUES($1,$2,$3,'patient','connect_identity_login',$4,$5,$6)")
            .bind(c.tenant_id).bind(patient).bind(account).bind(account).bind(version)
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
    user_id: Uuid,
    grant_id: Uuid,
    issuer: String,
    audience: String,
    expires_at: DateTime<Utc>,
    role: String,
    email: String,
}
pub(crate) async fn authenticate_staff(auth: &BrowserAuth, token: &str) -> Result<Option<Actor>> {
    let s: Option<StaffSession> = sqlx::query_as("SELECT s.tenant_id,s.user_id,s.grant_id,s.issuer,s.audience,s.expires_at,u.role,u.email FROM connect_identity_sessions s JOIN browser_users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL AND NOT u.disabled")
        .bind(crate::browser::hash(token)).fetch_optional(&auth.db).await?;
    let Some(s) = s else {
        return Ok(None);
    };
    let i = introspect(&s.issuer, s.grant_id, &s.audience).await?;
    let now = Utc::now().timestamp();
    let valid = i.active
        && i.jti == Some(s.grant_id)
        && i.aud.as_deref() == Some(auth.origin())
        && i.kind.as_deref() == Some("staff")
        && i.tenant_id == Some(s.tenant_id)
        && i.email.as_deref() == Some(&s.email)
        && i.exp
            .is_some_and(|v| v > now && v <= s.expires_at.timestamp());
    if !valid {
        sqlx::query("UPDATE connect_identity_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1")
            .bind(crate::browser::hash(token)).execute(&auth.db).await?;
        return Err(Error::Unauthorized);
    }
    sqlx::query(
        "UPDATE connect_identity_sessions SET last_introspected_at=now() WHERE token_hash=$1",
    )
    .bind(crate::browser::hash(token))
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

pub(crate) async fn patient_session(
    db: &sqlx::PgPool,
    token: &str,
) -> Result<Option<(Uuid, Uuid, Uuid)>> {
    let row: Option<PatientSession> = sqlx::query_as("SELECT s.tenant_id,s.account_id,s.grant_id,s.issuer,s.audience,s.expires_at,a.patient_id FROM patient_connect_sessions s JOIN patient_portal_accounts a ON a.tenant_id=s.tenant_id AND a.id=s.account_id AND a.version=s.account_version WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL AND a.status='active'")
        .bind(crate::browser::hash(token)).fetch_optional(db).await?;
    let Some(session) = row else {
        return Ok(None);
    };
    let i = introspect(&session.issuer, session.grant_id, &session.audience).await?;
    let now = Utc::now().timestamp();
    let valid = i.active
        && i.jti == Some(session.grant_id)
        && i.kind.as_deref() == Some("patient")
        && i.tenant_id == Some(session.tenant_id)
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
}
