// SPDX-License-Identifier: AGPL-3.0-only
//! Connect-delegated, tenant-admin partner support sessions.
//!
//! The browser supplies a short code from a URL fragment. This server exchanges and introspects
//! it over outbound HTTPS; no Connect token or EHR bootstrap credential is stored in the browser.

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

const MAX_SESSION_SECONDS: i64 = 15 * 60;

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
    role: String,
    partner_id: Uuid,
    customer_id: Uuid,
    order_id: Uuid,
    tenant_id: Uuid,
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
    role: Option<String>,
    #[serde(default)]
    tenant_id: Option<Uuid>,
    #[serde(default)]
    partner_id: Option<Uuid>,
    #[serde(default)]
    customer_id: Option<Uuid>,
    #[serde(default)]
    order_id: Option<Uuid>,
    #[serde(default)]
    exp: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct Session {
    tenant_id: Uuid,
    grant_id: Uuid,
    partner_id: Uuid,
    customer_id: Uuid,
    order_id: Uuid,
    issuer: String,
    audience: String,
    expires_at: DateTime<Utc>,
}

fn http() -> std::result::Result<reqwest::Client, Error> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("suncharts-ehr/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| Error::Unauthorized)
}

fn configured_issuer() -> Result<String> {
    crate::connect_onboarding::cloud_origin()
}

fn validate_claims(claims: &Claims, issuer: &str, audience: &str, now: i64) -> Result<()> {
    if claims.iss != issuer
        || claims.aud != audience
        || !matches!(claims.role.as_str(), "partner_support" | "partner_admin")
        || claims.sub.is_empty()
        || claims.sub.len() > 500
        || claims.iat > now + 5
        || claims.exp <= now
        || claims.exp <= claims.iat
        || claims.exp - claims.iat > MAX_SESSION_SECONDS
    {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

pub async fn accept(
    ExtractState(state): ExtractState<State>,
    headers: HeaderMap,
    Json(input): Json<AcceptRequest>,
) -> Result<(HeaderMap, Json<Value>)> {
    let auth = state.browser.as_ref().ok_or(Error::NotFound)?;
    auth.check_origin(&headers)?;
    let issuer = configured_issuer()?;
    if input.issuer != issuer || input.code.len() < 32 || input.code.len() > 256 {
        return Err(Error::Unauthorized);
    }
    let response = http()?
        .post(format!("{issuer}/api/v1/managed-ehr/support/exchange"))
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
    let claims: Claims = response.json().await.map_err(|_| Error::Unauthorized)?;
    let now = Utc::now().timestamp();
    validate_claims(&claims, &issuer, auth.origin(), now)?;
    let tenant_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM browser_users WHERE tenant_id=$1 AND NOT disabled)",
    )
    .bind(claims.tenant_id)
    .fetch_one(&auth.db)
    .await?;
    if !tenant_exists {
        return Err(Error::Unauthorized);
    }

    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let token = raw
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut tx = auth.db.begin().await?;
    sqlx::query("DELETE FROM partner_support_sessions WHERE expires_at<=now()")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO partner_support_sessions
         (token_hash,tenant_id,grant_id,partner_id,customer_id,order_id,issuer,audience,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9))",
    )
    .bind(crate::browser::hash(&token))
    .bind(claims.tenant_id)
    .bind(claims.jti)
    .bind(claims.partner_id)
    .bind(claims.customer_id)
    .bind(claims.order_id)
    .bind(&issuer)
    .bind(auth.origin())
    .bind(claims.exp as f64)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,'partner_admin.session_created',$2)")
        .bind(claims.tenant_id).bind(claims.jti).execute(&mut *tx).await?;
    tx.commit().await?;

    let seconds = (claims.exp - now).clamp(1, MAX_SESSION_SECONDS) as u64;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::SET_COOKIE,
        auth.session_cookie(&token, seconds)
            .parse()
            .map_err(|_| Error::Unauthorized)?,
    );
    Ok((
        response_headers,
        Json(
            json!({"authenticated":true,"role":"owner","delegated_role":"partner_admin","expires_at":claims.exp}),
        ),
    ))
}

/// Revalidate every delegated request. Connect unavailability fails closed; an explicit inactive
/// response permanently revokes the local session and records that revocation atomically.
pub(crate) async fn authenticate(auth: &BrowserAuth, token: &str) -> Result<Option<Actor>> {
    let session: Option<Session> = sqlx::query_as(
        "SELECT tenant_id,grant_id,partner_id,customer_id,order_id,issuer,audience,expires_at FROM partner_support_sessions
          WHERE token_hash=$1 AND expires_at>now() AND revoked_at IS NULL",
    )
    .bind(crate::browser::hash(token))
    .fetch_optional(&auth.db)
    .await?;
    let Some(session) = session else {
        return Ok(None);
    };
    if session.issuer != configured_issuer()? || session.audience != auth.origin() {
        return Err(Error::Unauthorized);
    }
    let response = http()?
        .post(format!(
            "{}/api/v1/managed-ehr/support/introspect",
            session.issuer
        ))
        .json(&IntrospectRequest {
            jti: session.grant_id,
            audience: auth.origin(),
        })
        .send()
        .await
        .map_err(|_| Error::Unauthorized)?;
    if !response.status().is_success() {
        return Err(Error::Unauthorized);
    }
    let introspection: Introspection = response.json().await.map_err(|_| Error::Unauthorized)?;
    let now = Utc::now().timestamp();
    let valid = introspection.active
        && introspection.jti == Some(session.grant_id)
        && introspection.aud.as_deref() == Some(auth.origin())
        && matches!(
            introspection.role.as_deref(),
            Some("partner_support" | "partner_admin")
        )
        && introspection.tenant_id == Some(session.tenant_id)
        && introspection.partner_id == Some(session.partner_id)
        && introspection.customer_id == Some(session.customer_id)
        && introspection.order_id == Some(session.order_id)
        && introspection
            .exp
            .is_some_and(|exp| exp > now && exp <= session.expires_at.timestamp());
    if !valid {
        let mut tx = auth.db.begin().await?;
        let revoked = sqlx::query(
            "UPDATE partner_support_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp())
              WHERE token_hash=$1 AND revoked_at IS NULL",
        )
        .bind(crate::browser::hash(token))
        .execute(&mut *tx)
        .await?;
        if revoked.rows_affected() == 1 {
            sqlx::query("INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,'partner_admin.revoked',$2)")
                .bind(session.tenant_id).bind(session.grant_id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        return Err(Error::Unauthorized);
    }
    sqlx::query("UPDATE partner_support_sessions SET last_introspected_at=clock_timestamp() WHERE token_hash=$1 AND revoked_at IS NULL")
        .bind(crate::browser::hash(token)).execute(&auth.db).await?;
    Ok(Some(Actor {
        sub: session.grant_id,
        tenant_id: session.tenant_id,
        // The grant is tenant, audience and time bounded, but within that boundary a contracted
        // support partner has the same application authority as the practice owner. The grant id
        // remains the actor id so every action is attributable to the delegated session.
        role: Role::Owner,
        patient_id: None,
        iss: session.issuer,
        aud: session.audience,
        iat: now,
        exp: session.expires_at.timestamp(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_are_exactly_bounded_to_support_audience_and_time() {
        let now = Utc::now().timestamp();
        let mut claims = Claims {
            iss: "https://connect.example.test".into(),
            aud: "https://ehr.example.test".into(),
            sub: "partner:synthetic".into(),
            jti: Uuid::new_v4(),
            role: "partner_admin".into(),
            partner_id: Uuid::new_v4(),
            customer_id: Uuid::new_v4(),
            order_id: Uuid::new_v4(),
            tenant_id: Uuid::new_v4(),
            iat: now,
            exp: now + 900,
        };
        assert!(validate_claims(
            &claims,
            "https://connect.example.test",
            "https://ehr.example.test",
            now
        )
        .is_ok());
        claims.role = "owner".into();
        assert!(validate_claims(
            &claims,
            "https://connect.example.test",
            "https://ehr.example.test",
            now
        )
        .is_err());
        claims.role = "partner_admin".into();
        claims.exp = now + 901;
        assert!(validate_claims(
            &claims,
            "https://connect.example.test",
            "https://ehr.example.test",
            now
        )
        .is_err());
    }
}
