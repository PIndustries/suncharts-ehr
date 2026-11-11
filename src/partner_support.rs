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
use sqlx::{Postgres, Transaction};
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
    purpose: String,
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
    #[serde(default)]
    sub: Option<String>,
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
    actor_subject: String,
    delegated_role: String,
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

fn handoff_request_allowed(origin_valid: bool, headers: &HeaderMap) -> bool {
    origin_valid
        || headers
            .get("x-suncharts-identity-handoff")
            .and_then(|value| value.to_str().ok())
            == Some("1")
}

fn validate_claims(claims: &Claims, issuer: &str, audience: &str, now: i64) -> Result<()> {
    if claims.iss != issuer
        || claims.aud != audience
        || !matches!(
            claims.role.as_str(),
            "partner_support" | "partner_admin" | "workflow_manager"
        )
        || !matches!(
            (claims.role.as_str(), claims.purpose.as_str()),
            ("partner_support" | "partner_admin", "support")
                | ("workflow_manager", "workflow_management")
        )
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
    // Safari and embedded user agents may omit Origin on a same-origin POST.
    // Match the normal Connect identity handoff: the custom header is an
    // equivalent CSRF boundary because a cross-origin form cannot set it and a
    // cross-origin script cannot pass the CORS preflight.
    if !handoff_request_allowed(auth.check_origin(&headers).is_ok(), &headers) {
        return Err(Error::Forbidden);
    }
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
         (token_hash,tenant_id,grant_id,partner_id,customer_id,order_id,issuer,audience,expires_at,actor_subject,delegated_role)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9),$10,$11)",
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
    .bind(&claims.sub)
    .bind(&claims.role)
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
        Json(json!({
            "authenticated":true,
            "role":"owner",
            "delegated_role":if claims.role == "workflow_manager" { "workflow_manager" } else { "partner_admin" },
            "expires_at":claims.exp
        })),
    ))
}

/// Revalidate every delegated request. Connect unavailability fails closed; an explicit inactive
/// response permanently revokes the local session and records that revocation atomically.
pub(crate) async fn authenticate_hash(
    auth: &BrowserAuth,
    token_hash: &str,
) -> Result<Option<Actor>> {
    let session: Option<Session> = sqlx::query_as(
        "SELECT tenant_id,grant_id,partner_id,customer_id,order_id,issuer,audience,expires_at,actor_subject,delegated_role FROM partner_support_sessions
          WHERE token_hash=$1 AND expires_at>now() AND revoked_at IS NULL",
    )
    .bind(token_hash)
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
        && introspection.role.as_deref() == Some(session.delegated_role.as_str())
        && introspection.tenant_id == Some(session.tenant_id)
        && introspection.partner_id == Some(session.partner_id)
        && introspection.customer_id == Some(session.customer_id)
        && introspection.order_id == Some(session.order_id)
        && introspection.sub.as_deref() == Some(session.actor_subject.as_str())
        && introspection
            .exp
            .is_some_and(|exp| exp > now && exp <= session.expires_at.timestamp());
    if !valid {
        let mut tx = auth.db.begin().await?;
        let revoked = sqlx::query(
            "UPDATE partner_support_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp())
              WHERE token_hash=$1 AND revoked_at IS NULL",
        )
        .bind(token_hash)
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
        .bind(token_hash).execute(&auth.db).await?;
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

/// Recheck an owner authenticated by BrowserAuth after taking the tenant admin
/// lock. Delegated owners retain their grant attribution rather than becoming
/// local staff; their exact browser session must still be current and must have
/// passed live Connect introspection for this authenticated request.
pub(crate) async fn verify_owner_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    headers: &HeaderMap,
) -> Result<()> {
    if !matches!(actor.role, Role::Owner) {
        return Err(Error::Forbidden);
    }
    let local: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM browser_users WHERE tenant_id=$1 AND id=$2 AND role='owner' AND NOT disabled)",
    )
    .bind(actor.tenant_id)
    .bind(actor.sub)
    .fetch_one(&mut **tx)
    .await?;
    if local {
        return Ok(());
    }
    let token = crate::browser::cookie(headers).ok_or(Error::Unauthorized)?;
    let delegated: Option<Uuid> = sqlx::query_scalar(
        "SELECT grant_id FROM partner_support_sessions
         WHERE token_hash=$1 AND tenant_id=$2 AND grant_id=$3 AND issuer=$4 AND audience=$5
           AND expires_at>clock_timestamp() AND revoked_at IS NULL
           AND last_introspected_at>=to_timestamp($6)
           AND delegated_role IN ('partner_support','partner_admin','workflow_manager')
         FOR SHARE",
    )
    .bind(crate::browser::hash(&token))
    .bind(actor.tenant_id)
    .bind(actor.sub)
    .bind(&actor.iss)
    .bind(&actor.aud)
    .bind(actor.iat as f64)
    .fetch_optional(&mut **tx)
    .await?;
    delegated.map(|_| ()).ok_or(Error::Forbidden)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delegated_handoff_accepts_protected_header_when_origin_is_omitted() {
        let mut headers = HeaderMap::new();
        assert!(!handoff_request_allowed(false, &headers));
        headers.insert("x-suncharts-identity-handoff", "1".parse().unwrap());
        assert!(handoff_request_allowed(false, &headers));
        assert!(handoff_request_allowed(true, &HeaderMap::new()));
    }

    #[test]
    fn claims_are_exactly_bounded_to_support_audience_and_time() {
        let now = Utc::now().timestamp();
        let mut claims = Claims {
            iss: "https://connect.example.test".into(),
            aud: "https://ehr.example.test".into(),
            sub: "partner:synthetic".into(),
            jti: Uuid::new_v4(),
            role: "partner_admin".into(),
            purpose: "support".into(),
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
        claims.purpose = "workflow_management".into();
        assert!(validate_claims(
            &claims,
            "https://connect.example.test",
            "https://ehr.example.test",
            now
        )
        .is_err());
        claims.purpose = "support".into();
        claims.exp = now + 901;
        assert!(validate_claims(
            &claims,
            "https://connect.example.test",
            "https://ehr.example.test",
            now
        )
        .is_err());
    }

    #[test]
    fn workflow_manager_claim_is_accepted_for_a_tenant_scoped_owner_session() {
        let now = Utc::now().timestamp();
        let claims = Claims {
            iss: "https://connect.example.test".into(),
            aud: "https://ehr.example.test".into(),
            sub: "partner:workflow-manager".into(),
            jti: Uuid::new_v4(),
            role: "workflow_manager".into(),
            purpose: "workflow_management".into(),
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
    }
}
