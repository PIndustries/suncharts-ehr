// SPDX-License-Identifier: AGPL-3.0-only
//! Card reader ordering for the practice owner. SunCharts Connect creates a short-lived Stripe
//! session limited to the reader shop and the practice's reader orders; Stripe ships and bills
//! the hardware. Nothing here takes a payment or changes the patient ledger.
//!
//! The session secret passes through to the owner's browser once. It is never stored, logged or
//! audited by this server.
use super::*;
use async_trait::async_trait;
use axum::{
    extract::FromRequestParts,
    http::StatusCode,
    response::{IntoResponse, Response},
};

const ROUTE: &str = "/api/v1/billing/payments/readers/hardware-session";

/// What SunCharts Connect answered when asked for a reader ordering session.
enum Reply {
    Session(Value),
    /// The payment account is missing or Stripe has not finished enabling it.
    NotReady,
    /// Reader ordering has not been set up on SunCharts Connect.
    NotConfigured,
}

#[async_trait]
trait Source: Sync {
    async fn config(&self, pool: &PgPool, tenant: Uuid, setting: &Settings) -> Result<Credentials>;
    async fn status(&self, config: &Credentials) -> Result<Value>;
    async fn session(&self, config: &Credentials, binding: &Value) -> Result<Reply>;
}
struct HttpSource;
#[async_trait]
impl Source for HttpSource {
    async fn config(&self, pool: &PgPool, tenant: Uuid, setting: &Settings) -> Result<Credentials> {
        credentials(pool, tenant, setting.id, setting.credential_revision).await
    }
    async fn status(&self, config: &Credentials) -> Result<Value> {
        request(config, Method::GET, "/status", None, None).await
    }
    async fn session(&self, config: &Credentials, binding: &Value) -> Result<Reply> {
        let installation = config.installation_id.ok_or_else(failed)?;
        let token = config.broker_token.as_deref().ok_or_else(failed)?;
        let response = crate::stedi::client()?
            .post(format!(
                "{}/api/v1/payments/connect/installations/{installation}/terminal/hardware-session",
                broker_base()?
            ))
            .bearer_auth(token)
            .json(binding)
            .send()
            .await
            .map_err(|_| failed())?;
        let status = response.status();
        let bytes = crate::stedi::bytes(response, 16384).await?;
        // 503 is the "not configured" answer. A proxy may replace its body, so the status alone
        // decides; either way the owner is told ordering is not available and to contact support.
        if status == StatusCode::SERVICE_UNAVAILABLE {
            return Ok(Reply::NotConfigured);
        }
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if status == StatusCode::CONFLICT
            && matches!(
                value["error"].as_str(),
                Some("payment_account_not_connected" | "payment_account_not_ready")
            )
        {
            return Ok(Reply::NotReady);
        }
        if !status.is_success() {
            return Err(failed());
        }
        Ok(Reply::Session(value))
    }
}

fn failed() -> Error {
    Error::Invalid("Reader ordering could not be opened. Try again in a few minutes.")
}
fn not_connected() -> Value {
    json!({"status":"not_connected"})
}
fn unavailable() -> Value {
    json!({"status":"unavailable"})
}

#[derive(Deserialize)]
struct Session {
    client_secret: String,
    publishable_key: String,
    livemode: bool,
}
/// Typed parsing discards anything else Connect might send. The publishable key must be the
/// browser-safe kind and agree with the account's mode before it reaches a page.
fn validate(value: Value, live: bool) -> Result<Session> {
    let session: Session = serde_json::from_value(value).map_err(|_| failed())?;
    let prefix = if live { "pk_live_" } else { "pk_test_" };
    let secret = &session.client_secret;
    let key = &session.publishable_key;
    if session.livemode != live
        || secret.is_empty()
        || secret.len() > 1024
        || !secret.bytes().all(|b| b.is_ascii_graphic())
        || key.len() <= prefix.len()
        || key.len() > 255
        || !key.starts_with(prefix)
        || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(failed());
    }
    Ok(session)
}

async fn load(a: &Actor, s: &State, source: &dyn Source) -> Result<Value> {
    owner(a)?;
    crate::access_policies::require_native(s, a, "billing", "edit").await?;
    let pool = db(s)?;
    let prior: Option<Settings> =
        sqlx::query_as("SELECT * FROM payment_settings WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_optional(pool)
            .await?;
    let Some(prior) = prior.filter(|setting| setting.mode == "suncharts_connect") else {
        return Ok(not_connected());
    };
    let config = source.config(pool, a.tenant_id, &prior).await?;
    if config.mode != "suncharts_connect" || config.installation_id.is_none() {
        return Err(failed());
    }
    let status = source.status(&config).await?;
    let status = bound_connect_status(&config, a.tenant_id, &status).ok_or_else(failed)?;
    let Some(account) = status["account_id"]
        .as_str()
        .filter(|id| id.len() > "acct_".len() && ident(id, "acct_"))
    else {
        return Ok(not_connected());
    };
    if prior
        .provider_account_id
        .as_deref()
        .is_some_and(|id| id != account)
    {
        return Err(failed());
    }
    if status["charges_enabled"] != true || status["details_submitted"] != true {
        return Ok(not_connected());
    }
    let live = status["livemode"].as_bool().ok_or_else(failed)?;
    // A production practice never orders through a test-mode account.
    if !live && !test_payments_available() {
        return Ok(unavailable());
    }
    let binding = json!({"account_id":account,"livemode":live,"remote_tenant_id":a.tenant_id});
    let session = match source.session(&config, &binding).await? {
        Reply::NotConfigured => return Ok(unavailable()),
        Reply::NotReady => return Ok(not_connected()),
        Reply::Session(value) => validate(value, live)?,
    };
    let mut tx = pool.begin().await?;
    let current = setting(&mut tx, a.tenant_id).await?;
    if current.id != prior.id
        || current.version != prior.version
        || current.credential_revision != prior.credential_revision
        || current.mode != prior.mode
        || current.provider_account_id != prior.provider_account_id
    {
        return Err(Error::Conflict(
            "The payment account changed. Open Card readers again.",
        ));
    }
    crate::postgres::audit(&mut tx, a, "payment.reader_order_session_opened", prior.id).await?;
    tx.commit().await?;
    Ok(json!({
        "status":"ready",
        "client_secret":session.client_secret,
        "publishable_key":session.publishable_key,
        "livemode":session.livemode
    }))
}

pub(super) async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
) -> Result<Response> {
    create_with(a, s, h, &HttpSource).await
}
async fn create_with(a: Actor, s: State, h: HeaderMap, source: &dyn Source) -> Result<Response> {
    let result = load(&a, &s, source).await?;
    // The session must not reach a browser whose sign-in ended while Connect was answering.
    let mut parts = axum::http::Request::builder()
        .method(Method::POST)
        .uri(ROUTE)
        .body(())
        .map_err(|_| failed())?
        .into_parts()
        .0;
    parts.headers = h;
    let current = Actor::from_request_parts(&mut parts, &s).await?;
    owner(&current)?;
    crate::access_policies::require_native(&s, &current, "billing", "edit").await?;
    if current.sub != a.sub || current.tenant_id != a.tenant_id {
        return Err(Error::Unauthorized);
    }
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(result),
    )
        .into_response())
}

#[cfg(test)]
#[path = "payment_reader_orders_tests.rs"]
mod tests;
