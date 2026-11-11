// SPDX-License-Identifier: AGPL-3.0-only
//! Account-wide financial summary; it is not evidence for the patient ledger.
use super::*;
use async_trait::async_trait;
use axum::{
    extract::FromRequestParts,
    response::{IntoResponse, Response},
};

#[async_trait]
trait Source: Sync {
    async fn config(&self, pool: &PgPool, tenant: Uuid, setting: &Settings) -> Result<Credentials>;
    async fn get(&self, config: &Credentials, path: &str) -> Result<Value>;
}
struct HttpSource;
#[async_trait]
impl Source for HttpSource {
    async fn config(&self, pool: &PgPool, tenant: Uuid, setting: &Settings) -> Result<Credentials> {
        credentials(pool, tenant, setting.id, setting.credential_revision).await
    }
    async fn get(&self, config: &Credentials, path: &str) -> Result<Value> {
        request(config, Method::GET, path, None, None).await
    }
}
#[derive(Deserialize, Serialize)]
struct Amount {
    amount: i64,
    currency: String,
}
#[derive(Deserialize, Serialize)]
struct Balance {
    available: Vec<Amount>,
    pending: Vec<Amount>,
}
#[derive(Deserialize, Serialize)]
struct Activity {
    items: Vec<ActivityRow>,
    has_more: bool,
}
#[derive(Deserialize, Serialize)]
struct ActivityRow {
    id: String,
    status: String,
    amount: i64,
    currency: String,
    created: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    amount_received: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    arrival_date: Option<i64>,
}
#[derive(Deserialize, Serialize)]
struct Section<T> {
    status: String,
    data: Option<T>,
}
#[derive(Deserialize, Serialize)]
struct Account {
    charges_enabled: bool,
    card_payments_active: bool,
    payouts_enabled: bool,
    details_submitted: bool,
}
#[derive(Deserialize, Serialize)]
struct Snapshot {
    contract_version: u8,
    installation_id: Uuid,
    remote_tenant_id: Uuid,
    account_id: String,
    livemode: bool,
    checked_at: DateTime<Utc>,
    limit: u8,
    account: Account,
    balance: Section<Balance>,
    payments: Section<Activity>,
    payouts: Section<Activity>,
}
fn invalid() -> Error {
    Error::Invalid(
        "Payment account activity could not be verified. Refresh the connection and retry.",
    )
}
fn identifier(s: &str, prefix: &str) -> bool {
    s.len() > prefix.len() && ident(s, prefix)
}
fn money(n: i64, c: &str, negative: bool) -> bool {
    (negative || n >= 0)
        && n.unsigned_abs() <= 9_007_199_254_740_991
        && c.len() == 3
        && c.bytes().all(|b| b.is_ascii_lowercase())
}
fn valid_section<T>(v: &Section<T>) -> bool {
    matches!(
        (v.status.as_str(), v.data.is_some()),
        ("available", true) | ("unavailable", false)
    )
}
fn validate(
    v: Value,
    installation: Uuid,
    tenant: Uuid,
    account: &str,
    live: bool,
) -> Result<Snapshot> {
    let s: Snapshot = serde_json::from_value(v).map_err(|_| invalid())?;
    if s.contract_version != 1
        || s.installation_id != installation
        || s.remote_tenant_id != tenant
        || s.account_id != account
        || s.livemode != live
        || s.limit != 10
        || (Utc::now() - s.checked_at).num_seconds().unsigned_abs() > 300
        || !valid_section(&s.balance)
        || !valid_section(&s.payments)
        || !valid_section(&s.payouts)
    {
        return Err(invalid());
    }
    if let Some(b) = &s.balance.data {
        if b.available.len() > 100
            || b.pending.len() > 100
            || b.available
                .iter()
                .chain(&b.pending)
                .any(|r| !money(r.amount, &r.currency, true))
        {
            return Err(invalid());
        }
    }
    for (section, payout) in [(&s.payments, false), (&s.payouts, true)] {
        if let Some(list) = &section.data {
            if list.items.len() > 10 {
                return Err(invalid());
            }
            for r in &list.items {
                let statuses: &[&str] = if payout {
                    &["pending", "in_transit", "paid", "failed", "canceled"]
                } else {
                    &[
                        "requires_payment_method",
                        "requires_confirmation",
                        "requires_action",
                        "processing",
                        "requires_capture",
                        "canceled",
                        "succeeded",
                    ]
                };
                if !identifier(&r.id, if payout { "po_" } else { "pi_" })
                    || !statuses.contains(&r.status.as_str())
                    || !money(r.amount, &r.currency, false)
                    || r.created < 1_262_304_000
                    || r.created > Utc::now().timestamp() + 300
                {
                    return Err(invalid());
                }
                if payout {
                    if r.amount_received.is_some()
                        || r.arrival_date.is_none_or(|t| {
                            t < 1_262_304_000 || t > Utc::now().timestamp() + 366 * 86_400
                        })
                    {
                        return Err(invalid());
                    }
                } else if r.arrival_date.is_some()
                    || r.amount_received
                        .is_none_or(|n| !money(n, &r.currency, false))
                {
                    return Err(invalid());
                }
            }
        }
    }
    Ok(s)
}
async fn load(a: &Actor, s: &State, source: &dyn Source) -> Result<Value> {
    owner(a)?;
    crate::access_policies::require_native(s, a, "billing", "view").await?;
    let pool = db(s)?;
    let mut tx = pool.begin().await?;
    let prior = setting(&mut tx, a.tenant_id).await?;
    tx.commit().await?;
    if prior.mode != "suncharts_connect" {
        return Err(Error::Conflict(
            "Connect this practice to SunCharts Payments before reviewing account activity",
        ));
    }
    let config = source.config(pool, a.tenant_id, &prior).await?;
    if config.mode != "suncharts_connect" {
        return Err(invalid());
    }
    let installation = config.installation_id.ok_or_else(invalid)?;
    let status = source.get(&config, "/status").await?;
    let status = bound_connect_status(&config, a.tenant_id, &status).ok_or_else(invalid)?;
    let account = status["account_id"]
        .as_str()
        .filter(|id| identifier(id, "acct_"))
        .ok_or(Error::Conflict(
            "Complete Stripe account setup before reviewing account activity",
        ))?;
    let live = status["livemode"].as_bool().ok_or_else(invalid)?;
    if prior
        .provider_account_id
        .as_deref()
        .is_some_and(|id| id != account)
    {
        return Err(invalid());
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("account_id", account)
        .append_pair("livemode", if live { "true" } else { "false" })
        .append_pair("remote_tenant_id", &a.tenant_id.to_string())
        .finish();
    let value = source.get(&config, &format!("/operations?{query}")).await?;
    let result = validate(value, installation, a.tenant_id, account, live)?;
    let mut tx = pool.begin().await?;
    let current = setting(&mut tx, a.tenant_id).await?;
    if current.id != prior.id
        || current.version != prior.version
        || current.credential_revision != prior.credential_revision
        || current.mode != prior.mode
        || current.provider_account_id != prior.provider_account_id
    {
        return Err(Error::Conflict(
            "Payment account changed during refresh. Load the current account again.",
        ));
    }
    crate::postgres::audit(&mut tx, a, "payment.operations_read", prior.id).await?;
    tx.commit().await?;
    // Typed serialization discards unrecognized broker fields, including any accidental secrets.
    let mut value = serde_json::to_value(result).map_err(|_| invalid())?;
    value["setting_version"] = json!(prior.version);
    Ok(value)
}
pub(super) async fn read(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
) -> Result<Response> {
    read_with(a, s, h, &HttpSource).await
}
async fn read_with(a: Actor, s: State, h: HeaderMap, source: &dyn Source) -> Result<Response> {
    let result = load(&a, &s, source).await?;
    let mut parts = axum::http::Request::builder()
        .uri("/api/v1/billing/payments/operations")
        .body(())
        .map_err(|_| invalid())?
        .into_parts()
        .0;
    parts.headers = h;
    let current = Actor::from_request_parts(&mut parts, &s).await?;
    owner(&current)?;
    crate::access_policies::require_native(&s, &current, "billing", "view").await?;
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
#[path = "payment_operations_tests.rs"]
mod tests;
