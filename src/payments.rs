// SPDX-License-Identifier: AGPL-3.0-only
//! Test-mode hosted checkout. Processor evidence, never a browser return, controls the ledger.
use crate::{
    auth::{Actor, Role},
    billing,
    error::{Error, Result},
    State,
};
use aws_lc_rs::hmac;
use axum::{
    body::Bytes,
    extract::{Path, State as ExtractState},
    http::{HeaderMap, Method},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
use zeroize::Zeroizing;
const STRIPE: &str = "https://api.stripe.com/v1";
const BROKER_ENV: &str = "ENGINE_PAYMENT_BROKER_URL";
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn owner(a: &Actor) -> Result<()> {
    if matches!(a.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
fn origin(s: &State) -> Result<&str> {
    Ok(s.browser.as_ref().ok_or(Error::NotFound)?.origin())
}
fn ident(s: &str, prefix: &str) -> bool {
    s.starts_with(prefix)
        && s.len() <= 255
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
fn valid_broker_token(v: &str) -> bool {
    v.starts_with("scp_inst_")
        && (20..=512).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn broker_base() -> Result<String> {
    let v = std::env::var(BROKER_ENV).map_err(|_| {
        Error::Invalid("SunCharts Payments is not enabled for this installation; contact your SunCharts administrator or use your own Stripe account")
    })?;
    let u = url::Url::parse(&v)
        .map_err(|_| Error::Invalid("invalid SunCharts Payments service configuration"))?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
    {
        return Err(Error::Invalid(
            "SunCharts Payments service must be a fixed HTTPS origin",
        ));
    }
    Ok(u.origin().ascii_serialization())
}
fn safe_onboarding_url(value: &str) -> Option<String> {
    let base = url::Url::parse(&broker_base().ok()?).ok()?;
    let u = url::Url::parse(value).ok()?;
    let pairs = u.query_pairs().collect::<Vec<_>>();
    if u.origin() != base.origin()
        || u.path() != "/clinic/native-ehr/payments"
        || u.fragment().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
        || pairs.len() != 1
        || pairs[0].0 != "connection"
        || Uuid::parse_str(&pairs[0].1).is_err()
    {
        return None;
    }
    Some(u.to_string())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    mode: String,
    api_key: Option<String>,
    webhook_secret: Option<String>,
    installation_id: Option<Uuid>,
    broker_token: Option<String>,
}
impl Drop for Credentials {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.api_key.zeroize();
        self.webhook_secret.zeroize();
        self.broker_token.zeroize();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    mode: String,
    api_key: Option<String>,
    webhook_secret: Option<String>,
    installation_id: Option<Uuid>,
    broker_token: Option<String>,
}
#[derive(sqlx::FromRow)]
struct Settings {
    id: Uuid,
    mode: String,
    credential_revision: i64,
    enabled: bool,
    verified: bool,
    provider_account_id: Option<String>,
    last_test_at: Option<DateTime<Utc>>,
    last_test_result: Option<String>,
    onboarding_url: Option<String>,
    version: i64,
}
impl Settings {
    fn public(&self) -> Value {
        json!({"id":self.id,"mode":self.mode,"enabled":self.enabled,"verified":self.verified,"provider_account_id":self.provider_account_id,"last_test_at":self.last_test_at,"last_test_result":self.last_test_result,"version":self.version,"test_mode":true,"credentials_configured":true,"onboarding_url":self.onboarding_url.as_deref().and_then(safe_onboarding_url)})
    }
}
#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct Payment {
    tenant_id: Uuid,
    pub id: Uuid,
    pub account_id: Uuid,
    setting_id: Uuid,
    credential_revision: i64,
    request_id: Uuid,
    creation_hash: String,
    requested_by: Uuid,
    pub amount_cents: i64,
    currency: String,
    pub status: String,
    provider_mode: String,
    provider_session_id: Option<String>,
    provider_payment_intent: Option<String>,
    provider_charge_id: Option<String>,
    provider_account_id: String,
    pub checkout_url: Option<String>,
    paid_entry_id: Option<Uuid>,
    refunded_cents: i64,
    version: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
impl Payment {
    fn public(&self) -> Value {
        json!({"id":self.id,"account_id":self.account_id,"amount_cents":self.amount_cents,"currency":self.currency,"status":self.status,"checkout_url":if self.status=="open"{self.checkout_url.clone()}else{None},"refunded_cents":self.refunded_cents,"ledger_recorded":self.paid_entry_id.is_some(),"version":self.version,"created_at":self.created_at,"updated_at":self.updated_at,"test_mode":true,"provider_mode":self.provider_mode,"refund_available":self.provider_mode=="own_stripe","expiry_available":self.provider_mode=="own_stripe","needs_review":self.status=="needs_review"})
    }
}
async fn setting(tx: &mut Transaction<'_, Postgres>, tenant: Uuid) -> Result<Settings> {
    sqlx::query_as("SELECT * FROM payment_settings WHERE tenant_id=$1 FOR UPDATE")
        .bind(tenant)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn payment(tx: &mut Transaction<'_, Postgres>, tenant: Uuid, id: Uuid) -> Result<Payment> {
    sqlx::query_as("SELECT * FROM payment_attempts WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(tenant)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn credentials(pool: &PgPool, tenant: Uuid, id: Uuid, revision: i64) -> Result<Credentials> {
    let encrypted:Vec<u8>=sqlx::query_scalar("SELECT encrypted_config FROM payment_credentials WHERE tenant_id=$1 AND setting_id=$2 AND revision=$3").bind(tenant).bind(id).bind(revision).fetch_optional(pool).await?.ok_or(Error::NotFound)?;
    let secret = crate::provider_settings::open_secret(tenant, id, "payments", &encrypted)?;
    serde_json::from_str(secret.expose())
        .map_err(|_| Error::Invalid("saved payment credentials cannot be read"))
}
async fn setting_event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    action: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO payment_setting_events(tenant_id,setting_id,version,actor_id,action) SELECT tenant_id,id,version,$3,$4 FROM payment_settings WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(a.sub).bind(action).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "payment.settings_change", id).await
}
async fn payment_event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    action: &str,
) -> Result<()> {
    sqlx::query("UPDATE payment_attempts SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO payment_events(tenant_id,payment_id,version,actor_id,action) SELECT tenant_id,id,version,$3,$4 FROM payment_attempts WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(a.sub).bind(action).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "payment.change", id).await
}
async fn balance(tx: &mut Transaction<'_, Postgres>, tenant: Uuid, id: Uuid) -> Result<i64> {
    sqlx::query_scalar("SELECT b.total_cents+coalesce((SELECT sum(effect_cents) FROM billing_entries e WHERE e.tenant_id=b.tenant_id AND e.account_id=b.id),0)::bigint FROM billing_accounts b WHERE b.tenant_id=$1 AND b.id=$2 AND b.status='posted' FOR UPDATE").bind(tenant).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::Conflict("hosted payment requires a posted account"))
}
pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/billing/payments/settings",
            get(read_settings).put(save_settings),
        )
        .route(
            "/api/v1/billing/payments/settings/test",
            post(test_settings),
        )
        .route(
            "/api/v1/billing/payments/settings/activation",
            post(activate),
        )
        .route(
            "/api/v1/billing/accounts/{id}/payments",
            get(list).post(create),
        )
        .route("/api/v1/billing/payments/{id}", get(detail))
        .route("/api/v1/billing/payments/{id}/refresh", post(refresh))
        .route("/api/v1/billing/payments/{id}/expire", post(expire))
        .route("/api/v1/billing/payments/{id}/refunds", post(refund))
        .route("/api/v1/payments/webhooks/{id}", post(webhook))
}
async fn read_settings(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    let row: Option<Settings> = sqlx::query_as("SELECT * FROM payment_settings WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .fetch_optional(&mut *tx)
        .await?;
    crate::postgres::audit(&mut tx, &a, "payment.settings_read", a.tenant_id).await?;
    tx.commit().await?;
    let storage_ready = if let Some(r) = &row {
        credentials(db(&s)?, a.tenant_id, r.id, r.credential_revision)
            .await
            .is_ok()
    } else {
        true
    };
    Ok(Json(
        json!({"setting":row.map(|r|r.public()),"test_mode_only":true,"connect_available":broker_base().is_ok(),"credential_storage_ready":storage_ready,"webhook_base":format!("{}/api/v1/payments/webhooks/",origin(&s)?)}),
    ))
}
async fn save_settings(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<Save>,
) -> Result<Json<Value>> {
    owner(&a)?;
    if !["own_stripe", "suncharts_connect"].contains(&v.mode.as_str()) {
        return Err(Error::Invalid(
            "choose your own Stripe account or SunCharts Payments",
        ));
    }
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let prior: Option<Settings> =
        sqlx::query_as("SELECT * FROM payment_settings WHERE tenant_id=$1 FOR UPDATE")
            .bind(a.tenant_id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(r) = &prior {
        if crate::expected(&h)? != r.version {
            return Err(Error::Conflict(
                "payment settings changed; reload before saving",
            ));
        }
    } else if h.get("if-match").is_some_and(|v| v != "\"0\"") {
        return Err(Error::Conflict("payment settings have not been created"));
    }
    let prior_credentials = if let Some(r) = &prior {
        Some(credentials(db(&s)?, a.tenant_id, r.id, r.credential_revision).await?)
    } else {
        None
    };
    let previous = prior_credentials.as_ref().filter(|p| p.mode == v.mode);
    let config = Credentials {
        mode: v.mode.clone(),
        api_key: v
            .api_key
            .filter(|v| !v.is_empty())
            .or_else(|| previous.and_then(|p| p.api_key.clone())),
        webhook_secret: v
            .webhook_secret
            .filter(|v| !v.is_empty())
            .or_else(|| previous.and_then(|p| p.webhook_secret.clone())),
        installation_id: v
            .installation_id
            .or_else(|| previous.and_then(|p| p.installation_id)),
        broker_token: v
            .broker_token
            .filter(|v| !v.is_empty())
            .or_else(|| previous.and_then(|p| p.broker_token.clone())),
    };
    if config.mode == "own_stripe" {
        let key = config
            .api_key
            .as_deref()
            .ok_or(Error::Invalid("enter your Stripe test secret API key"))?;
        if !(ident(key, "sk_test_") || ident(key, "rk_test_")) || key.len() < 16 {
            return Err(Error::Invalid(
                "only Stripe test secret or restricted API keys are supported",
            ));
        }
        if config
            .webhook_secret
            .as_ref()
            .is_some_and(|v| !ident(v, "whsec_") || v.len() < 12)
        {
            return Err(Error::Invalid("invalid Stripe webhook signing secret"));
        }
    } else {
        broker_base()?;
        if config.installation_id.is_none()
            || config
                .broker_token
                .as_ref()
                .is_none_or(|v| !valid_broker_token(v))
        {
            return Err(Error::Invalid(
                "enter the installation ID and token provisioned by SunCharts Payments",
            ));
        }
    }
    let id = prior.as_ref().map(|r| r.id).unwrap_or_else(Uuid::new_v4);
    let revision = prior
        .as_ref()
        .map(|r| r.credential_revision + 1)
        .unwrap_or(1);
    let raw = Zeroizing::new(
        serde_json::to_string(&config).map_err(|_| Error::Invalid("invalid payment settings"))?,
    );
    let encrypted =
        crate::provider_settings::seal_secret(db(&s)?, a.tenant_id, id, "payments", &raw).await?;
    sqlx::query("INSERT INTO payment_settings(tenant_id,id,mode) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET mode=$3,credential_revision=payment_settings.credential_revision+1,enabled=false,verified=false,provider_account_id=NULL,last_test_at=NULL,last_test_result=NULL,onboarding_url=NULL,version=payment_settings.version+1,updated_at=now()").bind(a.tenant_id).bind(id).bind(v.mode).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO payment_credentials(tenant_id,setting_id,revision,encrypted_config) VALUES($1,$2,$3,$4)").bind(a.tenant_id).bind(id).bind(revision).bind(encrypted).execute(&mut *tx).await?;
    setting_event(&mut tx, &a, id, "credentials_saved_disabled").await?;
    let result = setting(&mut tx, a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(result.public()))
}
async fn request(
    config: &Credentials,
    method: Method,
    path: &str,
    fields: Option<&[(String, String)]>,
    idempotency: Option<&str>,
) -> Result<Value> {
    let (url, token) = if config.mode == "own_stripe" {
        (
            format!("{STRIPE}{path}"),
            config
                .api_key
                .as_deref()
                .ok_or(Error::Invalid("payment credentials unavailable"))?,
        )
    } else {
        (
            format!(
                "{}/api/v1/payments/connect/installations/{}{}",
                broker_base()?,
                config
                    .installation_id
                    .ok_or(Error::Invalid("installation ID missing"))?,
                path
            ),
            config
                .broker_token
                .as_deref()
                .ok_or(Error::Invalid("installation token unavailable"))?,
        )
    };
    let mut call = crate::stedi::client()?
        .request(method, url)
        .bearer_auth(token);
    if config.mode == "own_stripe" {
        call = call.header("Stripe-Version", "2025-06-30.basil");
    }
    if let Some(k) = idempotency {
        call = call.header("Idempotency-Key", k);
    }
    if let Some(fields) = fields {
        if config.mode == "own_stripe" {
            call = call.form(fields);
        } else {
            let value: Value = fields
                .iter()
                .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                .collect();
            call = call.json(&value);
        }
    }
    let response = call.send().await.map_err(|_| {
        Error::Invalid(
            "payment provider request uncertain; retain the existing payment request and refresh",
        )
    })?;
    let status = response.status();
    let bytes = crate::stedi::bytes(response, 131072).await?;
    if !status.is_success() {
        return Err(Error::Invalid(
            "payment provider rejected the request; no ledger change was made",
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| Error::Invalid("unsupported payment provider response"))
}
async fn test_settings(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    owner(&a)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let current = setting(&mut tx, a.tenant_id).await?;
    if current.version != version {
        return Err(Error::Conflict("payment settings changed"));
    }
    if current
        .last_test_at
        .is_some_and(|t| t > Utc::now() - chrono::Duration::seconds(30))
    {
        return Err(Error::Invalid(
            "wait 30 seconds before another connection test",
        ));
    }
    let config = credentials(
        db(&s)?,
        a.tenant_id,
        current.id,
        current.credential_revision,
    )
    .await?;
    let result = request(
        &config,
        Method::GET,
        if config.mode == "own_stripe" {
            "/account"
        } else {
            "/status"
        },
        None,
        None,
    )
    .await;
    let verified = result.as_ref().ok().and_then(|v| {
        if config.mode == "own_stripe" {
            v["id"]
                .as_str()
                .filter(|id| ident(id, "acct_"))
                .map(str::to_owned)
        } else {
            if v["installation_id"]
                != config
                    .installation_id
                    .map(|v| v.to_string())
                    .unwrap_or_default()
                || v["remote_tenant_id"] != a.tenant_id.to_string()
                || v["livemode"] != false
                || v["charges_enabled"] != true
                || v["details_submitted"] != true
            {
                return None;
            }
            v["account_id"]
                .as_str()
                .filter(|id| ident(id, "acct_"))
                .map(str::to_owned)
        }
    });
    let bound_installation = result.as_ref().ok().is_some_and(|v| {
        config.mode == "suncharts_connect"
            && v["installation_id"]
                == config
                    .installation_id
                    .map(|id| id.to_string())
                    .unwrap_or_default()
            && v["remote_tenant_id"] == a.tenant_id.to_string()
            && v["livemode"] == false
    });
    let onboarding = if bound_installation {
        result
            .as_ref()
            .ok()
            .and_then(|v| v["onboarding_url"].as_str())
            .and_then(safe_onboarding_url)
    } else {
        None
    };
    sqlx::query("UPDATE payment_settings SET verified=$2,enabled=false,provider_account_id=$3,last_test_at=now(),last_test_result=$4,onboarding_url=$5,version=version+1,updated_at=now() WHERE tenant_id=$1").bind(a.tenant_id).bind(verified.is_some()).bind(&verified).bind(if verified.is_some(){"test_account_verified"}else if onboarding.is_some(){"owner_setup_required"}else{"connection_not_verified"}).bind(&onboarding).execute(&mut *tx).await?;
    setting_event(
        &mut tx,
        &a,
        current.id,
        if verified.is_some() {
            "connection_verified"
        } else {
            "connection_test_failed"
        },
    )
    .await?;
    let out = setting(&mut tx, a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"setting":out.public(),"authenticated":verified.is_some()||bound_installation,"ready":verified.is_some(),"live_payment_enabled":false}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Activation {
    enabled: bool,
}
async fn activate(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<Activation>,
) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let row = setting(&mut tx, a.tenant_id).await?;
    if row.version != crate::expected(&h)? {
        return Err(Error::Conflict("payment settings changed"));
    }
    if v.enabled && (!row.verified || row.provider_account_id.is_none()) {
        return Err(Error::Invalid(
            "test the saved payment connection before enabling",
        ));
    }
    if v.enabled {
        credentials(db(&s)?, a.tenant_id, row.id, row.credential_revision).await?;
    }
    sqlx::query("UPDATE payment_settings SET enabled=$2,version=version+1,updated_at=now() WHERE tenant_id=$1").bind(a.tenant_id).bind(v.enabled).execute(&mut *tx).await?;
    setting_event(
        &mut tx,
        &a,
        row.id,
        if v.enabled {
            "test_payments_enabled"
        } else {
            "new_payments_disabled"
        },
    )
    .await?;
    let out = setting(&mut tx, a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(out.public()))
}
async fn list(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let current = balance(&mut tx, a.tenant_id, id).await?;
    let items:Vec<Payment>=sqlx::query_as("SELECT * FROM payment_attempts WHERE tenant_id=$1 AND account_id=$2 ORDER BY created_at DESC,id LIMIT 100").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let reserved:i64=sqlx::query_scalar("SELECT coalesce(sum(amount_cents),0)::bigint FROM payment_attempts WHERE tenant_id=$1 AND account_id=$2 AND status IN ('creating','open','needs_review') AND paid_entry_id IS NULL").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
    let settings: Option<(bool, bool, String)> =
        sqlx::query_as("SELECT enabled,verified,mode FROM payment_settings WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_optional(&mut *tx)
            .await?;
    crate::postgres::audit(&mut tx, &a, "payment.account_read", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":items.iter().map(Payment::public).collect::<Vec<_>>(),"balance_cents":current,"reserved_cents":reserved,"available_cents":(current-reserved).max(0),"payments_enabled":settings.as_ref().is_some_and(|(e,v,_)|*e&&*v),"mode":settings.map(|(_,_,m)|m),"test_mode":true}),
    ))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NewPayment {
    request_id: Uuid,
    amount_cents: i64,
}
async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<NewPayment>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    if !(50..=100000000).contains(&v.amount_cents) {
        return Err(Error::Invalid(
            "enter an amount from 50 cents through the supported test-payment limit",
        ));
    }
    let version = crate::expected(&h)?;
    let hash = crate::oauth::hash(&json!({"account":id,"amount":v.amount_cents}).to_string());
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let prior: Option<Payment> = sqlx::query_as(
        "SELECT * FROM payment_attempts WHERE tenant_id=$1 AND request_id=$2 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    let row = if let Some(p) = prior {
        if p.creation_hash != hash {
            return Err(Error::Conflict(
                "payment request ID reused with different content",
            ));
        }
        p
    } else {
        let account: Option<(i64, String)> = sqlx::query_as(
            "SELECT version,status FROM billing_accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        )
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        let (account_version, status) = account.ok_or(Error::NotFound)?;
        if status != "posted" || account_version != version {
            return Err(Error::Conflict(
                "payment requires the current posted account version",
            ));
        }
        let current = balance(&mut tx, a.tenant_id, id).await?;
        let reserved:i64=sqlx::query_scalar("SELECT coalesce(sum(amount_cents),0)::bigint FROM payment_attempts WHERE tenant_id=$1 AND account_id=$2 AND status IN ('creating','open','needs_review') AND paid_entry_id IS NULL").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
        if v.amount_cents > current - reserved {
            return Err(Error::Conflict(
                "amount exceeds the unreserved account balance",
            ));
        }
        let settings = setting(&mut tx, a.tenant_id).await?;
        if !settings.enabled || !settings.verified {
            return Err(Error::Invalid(
                "payment collection is not enabled; an owner must configure and test it",
            ));
        }
        let provider_account = settings
            .provider_account_id
            .ok_or(Error::Invalid("payment account has not been verified"))?;
        let payment_id = Uuid::new_v4();
        sqlx::query("INSERT INTO payment_attempts(tenant_id,id,account_id,setting_id,credential_revision,request_id,creation_hash,requested_by,amount_cents,status,provider_account_id,provider_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'creating',$10,$11)").bind(a.tenant_id).bind(payment_id).bind(id).bind(settings.id).bind(settings.credential_revision).bind(v.request_id).bind(hash).bind(a.sub).bind(v.amount_cents).bind(provider_account).bind(settings.mode).execute(&mut *tx).await?;
        payment_event(&mut tx, &a, payment_id, "checkout_request_reserved").await?;
        payment(&mut tx, a.tenant_id, payment_id).await?
    };
    tx.commit().await?;
    if row.provider_session_id.is_some() || row.status != "creating" {
        return Ok(Json(json!({"payment":row.public()})));
    }
    if row.created_at < Utc::now() - chrono::Duration::hours(23) {
        return Err(Error::Conflict("uncertain checkout request is too old to retry safely; provider reconciliation is required"));
    }
    let config = credentials(
        db(&s)?,
        a.tenant_id,
        row.setting_id,
        row.credential_revision,
    )
    .await?;
    let session = create_session(&config, &row, origin(&s)?).await?;
    let out = apply_session(db(&s)?, &a, row.id, &session).await?;
    Ok(Json(json!({"payment":out.public()})))
}
fn session_fields(p: &Payment, base: &str) -> Vec<(String, String)> {
    vec![
        ("mode".into(), "payment".into()),
        ("payment_method_types[0]".into(), "card".into()),
        ("line_items[0][price_data][currency]".into(), "usd".into()),
        (
            "line_items[0][price_data][product_data][name]".into(),
            "Account payment".into(),
        ),
        (
            "line_items[0][price_data][unit_amount]".into(),
            p.amount_cents.to_string(),
        ),
        ("line_items[0][quantity]".into(), "1".into()),
        ("client_reference_id".into(), p.id.to_string()),
        ("metadata[native_payment_id]".into(), p.id.to_string()),
        (
            "payment_intent_data[metadata][native_payment_id]".into(),
            p.id.to_string(),
        ),
        (
            "success_url".into(),
            format!("{base}/?payment_checkout={}", p.id),
        ),
        (
            "cancel_url".into(),
            format!("{base}/?payment_checkout={}&cancelled=1", p.id),
        ),
    ]
}
async fn create_session(c: &Credentials, p: &Payment, base: &str) -> Result<Value> {
    let fields = if c.mode == "own_stripe" {
        session_fields(p, base)
    } else {
        vec![
            ("request_id".into(), p.id.to_string()),
            ("amount_cents".into(), p.amount_cents.to_string()),
            ("currency".into(), "usd".into()),
            (
                "return_url".into(),
                format!("{base}/?payment_checkout={}", p.id),
            ),
        ]
    };
    if c.mode == "suncharts_connect" {
        return broker_create(c, p, &fields).await;
    }
    request(
        c,
        Method::POST,
        "/checkout/sessions",
        Some(&fields),
        Some(&format!("suncharts_checkout_{}", p.id)),
    )
    .await
}
async fn broker_create(c: &Credentials, p: &Payment, fields: &[(String, String)]) -> Result<Value> {
    let mut value: Value = fields
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    value["amount_cents"] = json!(p.amount_cents);
    let response = crate::stedi::client()?
        .post(format!(
            "{}/api/v1/payments/connect/installations/{}/checkout-sessions",
            broker_base()?,
            c.installation_id
                .ok_or(Error::Invalid("installation ID missing"))?
        ))
        .bearer_auth(
            c.broker_token
                .as_deref()
                .ok_or(Error::Invalid("installation token unavailable"))?,
        )
        .json(&value)
        .send()
        .await
        .map_err(|_| {
            Error::Invalid("SunCharts Payments request uncertain; retain this payment request")
        })?;
    let status = response.status();
    let raw = crate::stedi::bytes(response, 131072).await?;
    if !status.is_success() {
        return Err(Error::Invalid(
            "SunCharts Payments rejected checkout creation",
        ));
    }
    serde_json::from_slice(&raw)
        .map_err(|_| Error::Invalid("unsupported SunCharts Payments response"))
}
async fn retrieve(c: &Credentials, p: &Payment) -> Result<Value> {
    let id = p.provider_session_id.as_deref().ok_or(Error::Conflict(
        "provider session is not yet confirmed; retry the original payment request",
    ))?;
    if !ident(id, "cs_test_") {
        return Err(Error::Invalid("invalid saved checkout identifier"));
    }
    let path = if c.mode == "own_stripe" {
        format!("/checkout/sessions/{id}?expand[]=payment_intent.latest_charge")
    } else {
        format!("/checkout-sessions/{id}")
    };
    request(c, Method::GET, &path, None, None).await
}
struct Verified {
    session: String,
    url: Option<String>,
    paid: bool,
    expired: bool,
    payment_intent: Option<String>,
    charge: Option<String>,
    refunded: i64,
}
fn verify_session(p: &Payment, v: &Value) -> Result<Verified> {
    let id = v["id"]
        .as_str()
        .filter(|id| ident(id, "cs_test_"))
        .ok_or(Error::Invalid("invalid test Checkout Session"))?;
    if p.provider_session_id.as_ref().is_some_and(|s| s != id)
        || v["livemode"] != false
        || v["mode"] != "payment"
        || v["currency"] != "usd"
        || v["amount_total"] != p.amount_cents
        || v["client_reference_id"] != p.id.to_string()
        || v["metadata"]["native_payment_id"] != p.id.to_string()
    {
        return Err(Error::Invalid(
            "payment provider evidence does not match this test payment",
        ));
    }
    let url = v["url"].as_str().map(str::to_owned);
    if let Some(value) = &url {
        let u =
            url::Url::parse(value).map_err(|_| Error::Invalid("invalid hosted checkout URL"))?;
        if u.scheme() != "https"
            || u.host_str() != Some("checkout.stripe.com")
            || !u.username().is_empty()
            || u.password().is_some()
        {
            return Err(Error::Invalid(
                "hosted checkout URL must be Stripe Checkout",
            ));
        }
    }
    let paid = v["payment_status"] == "paid" && v["status"] == "complete";
    let mut pi = None;
    let mut charge = None;
    let mut refunded = 0;
    if paid {
        let intent = &v["payment_intent"];
        let pi_id = intent["id"]
            .as_str()
            .filter(|id| ident(id, "pi_"))
            .ok_or(Error::Invalid(
                "paid session requires expanded payment evidence",
            ))?;
        let c = &intent["latest_charge"];
        let charge_id = c["id"]
            .as_str()
            .filter(|id| ident(id, "ch_"))
            .ok_or(Error::Invalid(
                "paid session requires expanded charge evidence",
            ))?;
        refunded = c["amount_refunded"]
            .as_i64()
            .filter(|n| (0..=p.amount_cents).contains(n))
            .ok_or(Error::Invalid("invalid confirmed refund amount"))?;
        if intent["status"] != "succeeded"
            || intent["amount_received"] != p.amount_cents
            || intent["currency"] != "usd"
            || c["paid"] != true
            || c["amount"] != p.amount_cents
            || c["currency"] != "usd"
            || c["payment_intent"] != pi_id
        {
            return Err(Error::Invalid(
                "incomplete or mismatched payment confirmation",
            ));
        }
        pi = Some(pi_id.to_owned());
        charge = Some(charge_id.to_owned());
    }
    Ok(Verified {
        session: id.into(),
        url,
        paid,
        expired: v["status"] == "expired",
        payment_intent: pi,
        charge,
        refunded,
    })
}
async fn ledger(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: &Payment,
    refund: bool,
    amount: i64,
    total: i64,
) -> Result<Uuid> {
    let patient: Uuid = sqlx::query_scalar(
        "SELECT patient_id FROM billing_accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(p.account_id)
    .fetch_one(&mut **tx)
    .await?;
    let entry = Uuid::new_v4();
    let reason = if refund {
        "Confirmed test payment refund"
    } else {
        "Confirmed test hosted payment"
    };
    let kind = if refund {
        "adjustment_debit"
    } else {
        "payment"
    };
    let content = json!({"request_id":entry,"kind":kind,"amount_cents":amount,"party":"patient","method":"external","reference":p.id.to_string(),"occurred_on":Utc::now().date_naive(),"reason":reason,"managed_payment_id":p.id,"test_mode":true});
    sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6,$2,$7,$8)").bind(a.tenant_id).bind(entry).bind(p.account_id).bind(kind).bind(if refund{amount}else{-amount}).bind(content).bind(crate::oauth::hash(&format!("{}:{kind}:{total}",p.id))).bind(a.sub).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO payment_ledger_links(tenant_id,payment_id,entry_id,kind,confirmed_cents) VALUES($1,$2,$3,$4,$5)").bind(a.tenant_id).bind(p.id).bind(entry).bind(if refund{"refund"}else{"payment"}).bind(total).execute(&mut **tx).await?;
    sqlx::query("UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(p.account_id)
        .execute(&mut **tx)
        .await?;
    billing::account_revision(tx, a, patient, p.account_id, reason).await?;
    Ok(entry)
}
async fn apply_session(pool: &PgPool, a: &Actor, id: Uuid, v: &Value) -> Result<Payment> {
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let p = payment(&mut tx, a.tenant_id, id).await?;
    let verified = verify_session(&p, v)?;
    if p.status == "expired" && !verified.expired && !verified.paid {
        return Err(Error::Conflict(
            "expired checkout cannot return to open from stale evidence",
        ));
    }
    let mut status = if verified.expired { "expired" } else { "open" };
    let mut paid_entry = p.paid_entry_id;
    if verified.paid {
        if p.paid_entry_id.is_none() {
            let available = balance(&mut tx, a.tenant_id, p.account_id).await?;
            if available < p.amount_cents - verified.refunded {
                sqlx::query("UPDATE payment_attempts SET status='needs_review',provider_session_id=$3,provider_payment_intent=$4,provider_charge_id=$5 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(&verified.session).bind(&verified.payment_intent).bind(&verified.charge).execute(&mut *tx).await?;
                payment_event(
                    &mut tx,
                    a,
                    id,
                    "funds_confirmed_balance_conflict_requires_review",
                )
                .await?;
                let out = payment(&mut tx, a.tenant_id, id).await?;
                tx.commit().await?;
                return Ok(out);
            }
            paid_entry = Some(ledger(&mut tx, a, &p, false, p.amount_cents, p.amount_cents).await?);
        }
        if verified.refunded < p.refunded_cents {
            return Err(Error::Conflict(
                "provider refund total regressed; previous ledger retained",
            ));
        }
        if verified.refunded > p.refunded_cents {
            ledger(
                &mut tx,
                a,
                &p,
                true,
                verified.refunded - p.refunded_cents,
                verified.refunded,
            )
            .await?;
        }
        status = if verified.refunded == p.amount_cents {
            "refunded"
        } else {
            "paid"
        };
    } else if p.paid_entry_id.is_some() {
        return Err(Error::Conflict(
            "confirmed payment cannot become unpaid without refund evidence",
        ));
    }
    sqlx::query("UPDATE payment_attempts SET status=$3,provider_session_id=$4,checkout_url=$5,provider_payment_intent=coalesce($6,provider_payment_intent),provider_charge_id=coalesce($7,provider_charge_id),paid_entry_id=$8,refunded_cents=$9 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(status).bind(verified.session).bind(verified.url).bind(verified.payment_intent).bind(verified.charge).bind(paid_entry).bind(if verified.paid{verified.refunded}else{p.refunded_cents}).execute(&mut *tx).await?;
    payment_event(&mut tx, a, id, "provider_evidence_reconciled").await?;
    let out = payment(&mut tx, a.tenant_id, id).await?;
    tx.commit().await?;
    Ok(out)
}
async fn detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let p = payment(&mut tx, a.tenant_id, id).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id'-'payment_id' FROM payment_events e WHERE tenant_id=$1 AND payment_id=$2 ORDER BY version DESC LIMIT 100").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let refunds:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('request_id',request_id,'amount_cents',amount_cents,'status',status,'created_at',created_at) FROM payment_refund_requests WHERE tenant_id=$1 AND payment_id=$2 ORDER BY created_at DESC LIMIT 100").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "payment.read", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"payment":p.public(),"events":events,"refund_requests":refunds}),
    ))
}
async fn refresh(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    let mut tx = db(&s)?.begin().await?;
    let p = payment(&mut tx, a.tenant_id, id).await?;
    tx.commit().await?;
    let c = credentials(db(&s)?, a.tenant_id, p.setting_id, p.credential_revision).await?;
    let v = if p.provider_session_id.is_none() && p.status == "creating" {
        if p.created_at < Utc::now() - chrono::Duration::hours(23) {
            return Err(Error::Conflict(
                "uncertain checkout is too old to retry safely; reconcile it with the provider",
            ));
        }
        create_session(&c, &p, origin(&s)?).await?
    } else {
        retrieve(&c, &p).await?
    };
    let out = apply_session(db(&s)?, &a, id, &v).await?;
    Ok(Json(json!({"payment":out.public()})))
}
async fn expire(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    let mut tx = db(&s)?.begin().await?;
    let p = payment(&mut tx, a.tenant_id, id).await?;
    tx.commit().await?;
    if p.paid_entry_id.is_some() || p.status != "open" {
        return Err(Error::Conflict(
            "only a confirmed open checkout can be expired",
        ));
    }
    let c = credentials(db(&s)?, a.tenant_id, p.setting_id, p.credential_revision).await?;
    if c.mode != "own_stripe" {
        return Err(Error::Invalid(
            "SunCharts Payments session expiry is not available through this broker contract",
        ));
    }
    let session = p
        .provider_session_id
        .as_deref()
        .ok_or(Error::Conflict("provider session unavailable"))?;
    let v = request(
        &c,
        Method::POST,
        &format!("/checkout/sessions/{session}/expire"),
        None,
        Some(&format!("suncharts_expire_{}", p.id)),
    )
    .await?;
    let out = apply_session(db(&s)?, &a, id, &v).await?;
    Ok(Json(json!({"payment":out.public()})))
}
async fn refund(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    Json(v): Json<NewPayment>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let p = payment(&mut tx, a.tenant_id, id).await?;
    if p.paid_entry_id.is_none() || v.amount_cents < 1 {
        return Err(Error::Invalid(
            "refund must fit the confirmed unrefunded payment",
        ));
    }
    let config = credentials(db(&s)?, a.tenant_id, p.setting_id, p.credential_revision).await?;
    if config.mode != "own_stripe" {
        return Err(Error::Invalid(
            "issue refunds in the connected Stripe account; refresh to reconcile them",
        ));
    }
    let prior:Option<(Uuid,Uuid,i64,DateTime<Utc>,String)>=sqlx::query_as("SELECT id,payment_id,amount_cents,created_at,status FROM payment_refund_requests WHERE tenant_id=$1 AND request_id=$2 FOR UPDATE").bind(a.tenant_id).bind(v.request_id).fetch_optional(&mut *tx).await?;
    let refund_id = if let Some((fid, pid, amount, created, status)) = prior {
        if pid != id || amount != v.amount_cents {
            return Err(Error::Conflict(
                "refund request ID reused with different content",
            ));
        }
        if status == "confirmed" {
            tx.commit().await?;
            let snapshot = retrieve(&config, &p).await?;
            let out = apply_session(db(&s)?, &a, id, &snapshot).await?;
            return Ok(Json(
                json!({"payment":out.public(),"refund_confirmed":true}),
            ));
        }
        if created < Utc::now() - chrono::Duration::hours(23) {
            return Err(Error::Conflict(
                "uncertain refund is too old to retry safely; reconcile it in Stripe",
            ));
        }
        fid
    } else {
        let pending:i64=sqlx::query_scalar("SELECT coalesce(sum(amount_cents),0)::bigint FROM payment_refund_requests WHERE tenant_id=$1 AND payment_id=$2 AND status='pending'").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
        let confirmed:i64=sqlx::query_scalar("SELECT coalesce(sum(amount_cents),0)::bigint FROM payment_refund_requests WHERE tenant_id=$1 AND payment_id=$2 AND status='confirmed'").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
        if confirmed > p.refunded_cents {
            return Err(Error::Conflict("a confirmed refund has not been reconciled; refresh provider status before another refund"));
        }
        if v.amount_cents > p.amount_cents - p.refunded_cents - pending {
            return Err(Error::Conflict(
                "another refund is pending; refresh before requesting more",
            ));
        }
        let fid = Uuid::new_v4();
        sqlx::query("INSERT INTO payment_refund_requests(tenant_id,id,payment_id,request_id,amount_cents) VALUES($1,$2,$3,$4,$5)").bind(a.tenant_id).bind(fid).bind(id).bind(v.request_id).bind(v.amount_cents).execute(&mut *tx).await?;
        payment_event(&mut tx, &a, id, "refund_requested").await?;
        fid
    };
    tx.commit().await?;
    let fields = vec![
        (
            "payment_intent".into(),
            p.provider_payment_intent
                .clone()
                .ok_or(Error::Invalid("confirmed payment intent unavailable"))?,
        ),
        ("amount".into(), v.amount_cents.to_string()),
        ("metadata[native_refund_id]".into(), refund_id.to_string()),
    ];
    let result = request(
        &config,
        Method::POST,
        "/refunds",
        Some(&fields),
        Some(&format!("suncharts_refund_{refund_id}")),
    )
    .await?;
    let rid = result["id"]
        .as_str()
        .filter(|s| ident(s, "re_"))
        .ok_or(Error::Invalid("invalid refund receipt"))?;
    if result["amount"] != v.amount_cents
        || result["payment_intent"].as_str() != p.provider_payment_intent.as_deref()
    {
        return Err(Error::Invalid("refund receipt does not match request"));
    }
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    sqlx::query("UPDATE payment_refund_requests SET provider_refund_id=$3,status=$4 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(refund_id).bind(rid).bind(match result["status"].as_str(){Some("succeeded")=>"confirmed",Some("failed")=>"failed",Some("canceled")=>"canceled",_=>"pending"}).execute(&mut *tx).await?;
    payment_event(&mut tx, &a, id, "refund_provider_receipt_recorded").await?;
    tx.commit().await?;
    let snapshot = retrieve(&config, &p).await?;
    let out = apply_session(db(&s)?, &a, id, &snapshot).await?;
    Ok(Json(
        json!({"payment":out.public(),"refund_confirmed":result["status"]=="succeeded"}),
    ))
}
fn verify_signature(secret: &str, header: &str, raw: &[u8], now: i64) -> Result<()> {
    if raw.len() > 64000 || header.len() > 4096 {
        return Err(Error::Invalid("webhook exceeds supported size"));
    }
    let mut timestamp = None;
    let mut signatures = vec![];
    for value in header.split(',').map(str::trim) {
        if let Some(t) = value.strip_prefix("t=") {
            if timestamp.is_some() {
                return Err(Error::Invalid("invalid webhook signature timestamp"));
            }
            timestamp = t.parse::<i64>().ok();
        } else if let Some(v) = value.strip_prefix("v1=") {
            if v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()) {
                let bytes = (0..64)
                    .step_by(2)
                    .map(|i| u8::from_str_radix(&v[i..i + 2], 16))
                    .collect::<std::result::Result<Vec<_>, _>>();
                if let Ok(bytes) = bytes {
                    signatures.push(bytes);
                }
            }
        }
    }
    let timestamp = timestamp
        .filter(|t| now.abs_diff(*t) <= 300)
        .ok_or(Error::Invalid("webhook signature timestamp expired"))?;
    let mut data = format!("{timestamp}.").into_bytes();
    data.extend(raw);
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    if !signatures
        .iter()
        .take(20)
        .any(|sig| hmac::verify(&key, &data, sig).is_ok())
    {
        return Err(Error::Invalid("webhook signature invalid"));
    }
    Ok(())
}
async fn webhook(
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    raw: Bytes,
) -> Result<Json<Value>> {
    let signature = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or(Error::Invalid("webhook signature required"))?;
    let event: Value =
        serde_json::from_slice(&raw).map_err(|_| Error::Invalid("invalid webhook JSON"))?;
    let event_id = event["id"]
        .as_str()
        .filter(|s| ident(s, "evt_"))
        .ok_or(Error::Invalid("invalid webhook event ID"))?;
    if event["livemode"] != false {
        return Err(Error::Invalid("live payment webhooks are not enabled"));
    }
    let tenant: Uuid = sqlx::query_scalar("SELECT tenant_id FROM payment_settings WHERE id=$1")
        .bind(id)
        .fetch_optional(db(&s)?)
        .await?
        .ok_or(Error::NotFound)?;
    let revisions:Vec<i64>=sqlx::query_scalar("SELECT revision FROM payment_credentials WHERE tenant_id=$1 AND setting_id=$2 ORDER BY revision DESC LIMIT 20").bind(tenant).bind(id).fetch_all(db(&s)?).await?;
    let mut verified = false;
    for revision in revisions {
        let c = credentials(db(&s)?, tenant, id, revision).await?;
        if let Some(secret) = c.webhook_secret.as_deref() {
            if verify_signature(secret, signature, &raw, Utc::now().timestamp()).is_ok() {
                verified = true;
                break;
            }
        }
    }
    if !verified {
        return Err(Error::Invalid(
            "webhook signature invalid or signing secret unavailable",
        ));
    }
    let hash = crate::oauth::hash(
        std::str::from_utf8(&raw).map_err(|_| Error::Invalid("webhook JSON must be UTF-8"))?,
    );
    let mut receipt_tx = db(&s)?.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("payment-webhook:{id}:{event_id}"))
        .execute(&mut *receipt_tx)
        .await?;
    let prior: Option<String> = sqlx::query_scalar(
        "SELECT payload_hash FROM payment_webhook_receipts WHERE setting_id=$1 AND event_id=$2",
    )
    .bind(id)
    .bind(event_id)
    .fetch_optional(&mut *receipt_tx)
    .await?;
    if let Some(prior) = prior {
        if prior != hash {
            return Err(Error::Conflict(
                "webhook event ID reused with changed content",
            ));
        }
        return Ok(Json(json!({"received":true,"duplicate":true})));
    }
    let obj = &event["data"]["object"];
    let explicit = obj["metadata"]["native_payment_id"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok());
    let payment_id: Option<Uuid> = if let Some(payment) = explicit {
        Some(payment)
    } else {
        sqlx::query_scalar("SELECT id FROM payment_attempts WHERE tenant_id=$1 AND setting_id=$2 AND provider_payment_intent=$3").bind(tenant).bind(id).bind(obj["payment_intent"].as_str().unwrap_or("")).fetch_optional(db(&s)?).await?
    };
    if let Some(payment_id) = payment_id {
        let mut tx = db(&s)?.begin().await?;
        let mut p = payment(&mut tx, tenant, payment_id).await?;
        if p.setting_id != id {
            return Err(Error::Invalid("webhook installation mismatch"));
        }
        if p.provider_session_id.is_none() {
            if let Some(session) = obj["id"].as_str().filter(|s| ident(s, "cs_test_")) {
                p.provider_session_id = Some(session.into());
            }
        }
        tx.commit().await?;
        let c = credentials(db(&s)?, tenant, id, p.credential_revision).await?;
        let snapshot = retrieve(&c, &p).await?;
        let actor = crate::delivery::worker(tenant);
        apply_session(db(&s)?, &actor, p.id, &snapshot).await?;
    }
    sqlx::query("INSERT INTO payment_webhook_receipts(setting_id,event_id,payload_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(id).bind(event_id).bind(hash).execute(&mut *receipt_tx).await?;
    crate::postgres::audit(
        &mut receipt_tx,
        &crate::delivery::worker(tenant),
        "payment.webhook_verified",
        id,
    )
    .await?;
    receipt_tx.commit().await?;
    Ok(Json(
        json!({"received":true,"ledger_uses_retrieved_evidence":true}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn example() -> Payment {
        Payment {
            tenant_id: Uuid::new_v4(),
            id: Uuid::new_v4(),
            account_id: Uuid::new_v4(),
            setting_id: Uuid::new_v4(),
            credential_revision: 1,
            request_id: Uuid::new_v4(),
            creation_hash: String::new(),
            requested_by: Uuid::new_v4(),
            amount_cents: 2500,
            currency: "usd".into(),
            status: "creating".into(),
            provider_mode: "own_stripe".into(),
            provider_session_id: None,
            provider_payment_intent: None,
            provider_charge_id: None,
            provider_account_id: "acct_synthetic".into(),
            checkout_url: None,
            paid_entry_id: None,
            refunded_cents: 0,
            version: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }
    fn snapshot(p: &Payment, paid: bool, refunded: i64) -> Value {
        json!({"id":"cs_test_synthetic","mode":"payment","livemode":false,"amount_total":p.amount_cents,"currency":"usd","client_reference_id":p.id.to_string(),"metadata":{"native_payment_id":p.id.to_string()},"url":if paid{Value::Null}else{json!("https://checkout.stripe.com/c/pay/cs_test_synthetic")},"status":if paid{"complete"}else{"open"},"payment_status":if paid{"paid"}else{"unpaid"},"payment_intent":if paid{json!({"id":"pi_synthetic","status":"succeeded","amount_received":p.amount_cents,"currency":"usd","latest_charge":{"id":"ch_synthetic","paid":true,"amount":p.amount_cents,"currency":"usd","amount_refunded":refunded,"payment_intent":"pi_synthetic"}})}else{Value::Null}})
    }
    #[test]
    fn stripe_evidence_binds_exact_test_payment_and_contains_no_clinical_fields() {
        let p = example();
        let open = snapshot(&p, false, 0);
        assert!(!verify_session(&p, &open).unwrap().paid);
        assert!(verify_session(&p, &snapshot(&p, true, 500)).unwrap().paid);
        let fields = session_fields(&p, "https://ehr.example.test");
        let names = fields.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>();
        assert!(!names
            .iter()
            .any(|k| k.contains("customer") || k.contains("patient") || k.contains("email")));
        assert_eq!(
            fields
                .iter()
                .find(|(k, _)| k.ends_with("[name]"))
                .unwrap()
                .1,
            "Account payment"
        );
        let mut bad = snapshot(&p, true, 0);
        bad["amount_total"] = json!(2499);
        assert!(verify_session(&p, &bad).is_err());
        bad = snapshot(&p, true, 0);
        bad["livemode"] = json!(true);
        assert!(verify_session(&p, &bad).is_err());
        bad = snapshot(&p, true, 0);
        bad["metadata"]["native_payment_id"] = json!(Uuid::new_v4());
        assert!(verify_session(&p, &bad).is_err());
        bad = snapshot(&p, true, 0);
        bad["payment_intent"] = json!("pi_unexpanded");
        assert!(verify_session(&p, &bad).is_err());
        assert!(valid_broker_token("scp_inst_with-URL_safe-token_material"));
        assert!(!valid_broker_token("scp_inst_bad token material"));
    }
    #[test]
    fn stripe_signatures_bind_raw_bytes_and_enforce_timestamp_tolerance() {
        let secret = "whsec_synthetic_private";
        let raw = br#"{"id":"evt_synthetic","livemode":false}"#;
        let now = Utc::now().timestamp();
        let mut bytes = format!("{now}.").into_bytes();
        bytes.extend(raw);
        let signed = hmac::sign(
            &hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()),
            &bytes,
        );
        let hex = signed
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let header = format!("t={now},v1={hex}");
        assert!(verify_signature(secret, &header, raw, now).is_ok());
        assert!(verify_signature(secret, &header, b"changed", now).is_err());
        assert!(verify_signature(secret, &header, raw, now + 301).is_err());
        assert!(verify_signature(secret, &header, raw, now - 301).is_err());
        assert!(
            verify_signature(secret, &format!("t={now},v1={}", "é".repeat(32)), raw, now).is_err()
        );
    }
    #[tokio::test]
    async fn payments_post_once_refund_deltas_are_exact_and_reservations_cover_all_ledger_writers()
    {
        let url =
            std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
        let schema = format!("payments_test_{}", Uuid::new_v4().simple());
        let admin = PgPool::connect(&url).await.unwrap();
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        admin.close().await;
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(8)
            .after_connect(move |c, _| {
                let q = format!("SET search_path TO {schema}");
                Box::pin(async move {
                    sqlx::query(&q).execute(c).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        crate::MIGRATOR.run(&pool).await.unwrap();
        let key_dir =
            std::env::temp_dir().join(format!("suncharts-payment-test-{}", Uuid::new_v4()));
        std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", key_dir.join("master.key"));
        let mut p = example();
        let a = crate::delivery::worker(p.tenant_id);
        p.requested_by = a.sub;
        let state = State {
            backend: std::sync::Arc::new(crate::postgres::PostgresBackend(pool.clone())),
            browser: Some(
                crate::browser::BrowserAuth::new(pool.clone(), "http://127.0.0.1:8099".into())
                    .unwrap(),
            ),
            secret: String::new(),
            allow_legacy_gateway: false,
            issuer: "suncharts".into(),
            audience: "suncharts-engine".into(),
        };
        let mut reader = a.clone();
        reader.role = Role::Clinician;
        assert!(matches!(
            read_settings(reader, ExtractState(state.clone())).await,
            Err(Error::Forbidden)
        ));
        let saved = save_settings(
            a.clone(),
            ExtractState(state.clone()),
            HeaderMap::new(),
            Json(Save {
                mode: "own_stripe".into(),
                api_key: Some("sk_test_synthetic_key_never_real".into()),
                webhook_secret: Some("whsec_synthetic_key_never_real".into()),
                installation_id: None,
                broker_token: None,
            }),
        )
        .await
        .unwrap()
        .0;
        assert!(!saved.to_string().contains("sk_test_"));
        assert_eq!(saved["enabled"], false);
        assert_eq!(saved["verified"], false);
        p.setting_id = Uuid::parse_str(saved["id"].as_str().unwrap()).unwrap();
        let encrypted: Vec<u8> = sqlx::query_scalar(
            "SELECT encrypted_config FROM payment_credentials WHERE tenant_id=$1",
        )
        .bind(a.tenant_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(!encrypted.windows(8).any(|s| s == b"sk_test_"));
        let mut headers = HeaderMap::new();
        headers.insert("if-match", "\"1\"".parse().unwrap());
        assert!(activate(
            a.clone(),
            ExtractState(state.clone()),
            headers.clone(),
            Json(Activation { enabled: true })
        )
        .await
        .is_err());
        let patient = Uuid::new_v4();
        let appointment = Uuid::new_v4();
        let visit = Uuid::new_v4();
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-PAY','Synthetic','Payment','2000-01-01')").bind(a.tenant_id).bind(patient).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,now()-interval '1 hour',now(),'completed')").bind(a.tenant_id).bind(appointment).bind(patient).bind(a.sub).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,$5,now())").bind(a.tenant_id).bind(visit).bind(patient).bind(appointment).bind(a.sub).bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"})).execute(&pool).await.unwrap();
        let content = json!({"visit_id":visit,"coverage_id":null,"service_date":Utc::now().date_naive(),"currency":"USD","lines":[{"code_system":"CPT","code":"99213","description":"Synthetic","modifiers":"","units":1,"amount_cents":10000,"diagnosis_codes":[]}],"notes":"Synthetic test only"});
        sqlx::query("INSERT INTO billing_accounts(tenant_id,id,patient_id,visit_id,content,total_cents,status,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,10000,'posted',$6,'synthetic')").bind(a.tenant_id).bind(p.account_id).bind(patient).bind(visit).bind(content).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
        assert!(create(
            a.clone(),
            ExtractState(state.clone()),
            Path(p.account_id),
            headers.clone(),
            Json(NewPayment {
                request_id: Uuid::new_v4(),
                amount_cents: 100
            })
        )
        .await
        .is_err());
        p.creation_hash = crate::oauth::hash(
            &json!({"account":p.account_id,"amount":p.amount_cents}).to_string(),
        );
        sqlx::query("INSERT INTO payment_attempts(tenant_id,id,account_id,setting_id,credential_revision,request_id,creation_hash,requested_by,amount_cents,status,provider_account_id,provider_mode) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'creating','acct_synthetic','own_stripe')").bind(a.tenant_id).bind(p.id).bind(p.account_id).bind(p.setting_id).bind(p.request_id).bind(&p.creation_hash).bind(a.sub).bind(p.amount_cents).execute(&pool).await.unwrap();
        let open = apply_session(&pool, &a, p.id, &snapshot(&p, false, 0))
            .await
            .unwrap();
        assert_eq!(open.status, "open");
        let listed = list(a.clone(), ExtractState(state.clone()), Path(p.account_id))
            .await
            .unwrap()
            .0;
        assert_eq!(listed["reserved_cents"], 2500);
        assert_eq!(listed["available_cents"], 7500);
        let duplicate = create(
            a.clone(),
            ExtractState(state.clone()),
            Path(p.account_id),
            headers.clone(),
            Json(NewPayment {
                request_id: p.request_id,
                amount_cents: p.amount_cents,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(duplicate["payment"]["id"], p.id.to_string());
        let manual=sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id) VALUES($1,$2,$3,'payment',-8000,'{}',$2,'synthetic',$4)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(p.account_id).bind(a.sub).execute(&pool).await;
        assert!(manual.is_err());
        sqlx::query("CREATE FUNCTION reject_payment_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='payment.change' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&pool).await.unwrap();
        sqlx::query("CREATE TRIGGER reject_payment_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_payment_audit()").execute(&pool).await.unwrap();
        assert!(apply_session(&pool, &a, p.id, &snapshot(&p, true, 0))
            .await
            .is_err());
        let rolled_back: i64 =
            sqlx::query_scalar("SELECT count(*) FROM billing_entries WHERE tenant_id=$1")
                .bind(a.tenant_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(rolled_back, 0);
        sqlx::query("DROP TRIGGER reject_payment_audit ON audit_events")
            .execute(&pool)
            .await
            .unwrap();
        let paid = snapshot(&p, true, 0);
        let (first, second) = tokio::join!(
            apply_session(&pool, &a, p.id, &paid),
            apply_session(&pool, &a, p.id, &paid)
        );
        assert_eq!(first.unwrap().status, "paid");
        assert_eq!(second.unwrap().status, "paid");
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM billing_entries WHERE tenant_id=$1")
                .bind(a.tenant_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
        let (_, _, v) = sqlx::query_as::<_, (Uuid, String, i64)>(
            "SELECT id,status,version FROM billing_accounts WHERE tenant_id=$1 AND id=$2",
        )
        .bind(a.tenant_id)
        .bind(p.account_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(v, 2);
        let partial = apply_session(&pool, &a, p.id, &snapshot(&p, true, 750))
            .await
            .unwrap();
        assert_eq!(partial.refunded_cents, 750);
        apply_session(&pool, &a, p.id, &snapshot(&p, true, 750))
            .await
            .unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM billing_entries WHERE tenant_id=$1")
                .bind(a.tenant_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 2);
        sqlx::query("INSERT INTO payment_refund_requests(tenant_id,id,payment_id,request_id,amount_cents,status) VALUES($1,$2,$3,$4,1000,'confirmed')").bind(a.tenant_id).bind(Uuid::new_v4()).bind(p.id).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
        assert!(matches!(
            refund(
                a.clone(),
                ExtractState(state.clone()),
                Path(p.id),
                Json(NewPayment {
                    request_id: Uuid::new_v4(),
                    amount_cents: 100
                })
            )
            .await,
            Err(Error::Conflict(_))
        ));
        sqlx::query("DELETE FROM payment_refund_requests WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO payment_refund_requests(tenant_id,id,payment_id,request_id,amount_cents,status) VALUES($1,$2,$3,$4,1000,'pending')").bind(a.tenant_id).bind(Uuid::new_v4()).bind(p.id).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
        assert!(matches!(
            refund(
                a.clone(),
                ExtractState(state.clone()),
                Path(p.id),
                Json(NewPayment {
                    request_id: Uuid::new_v4(),
                    amount_cents: 800
                })
            )
            .await,
            Err(Error::Conflict(_))
        ));
        sqlx::query("DELETE FROM payment_refund_requests WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(apply_session(&pool, &a, p.id, &snapshot(&p, true, 500))
            .await
            .is_err());
        let full = apply_session(&pool, &a, p.id, &snapshot(&p, true, 2500))
            .await
            .unwrap();
        assert_eq!(full.status, "refunded");
        let mut tx = pool.begin().await.unwrap();
        assert_eq!(
            balance(&mut tx, a.tenant_id, p.account_id).await.unwrap(),
            10000
        );
        tx.commit().await.unwrap();
        let mut outsider = a.clone();
        outsider.tenant_id = Uuid::new_v4();
        assert!(matches!(
            detail(outsider, ExtractState(state.clone()), Path(p.id)).await,
            Err(Error::NotFound)
        ));
        let mut invalid = snapshot(&p, true, 2500);
        invalid["amount_total"] = json!(1);
        assert!(apply_session(&pool, &a, p.id, &invalid).await.is_err());
        // Provider receipts remain bound to old encrypted credentials after settings change.
        headers.insert("if-match", "\"1\"".parse().unwrap());
        let rotated = save_settings(
            a.clone(),
            ExtractState(state.clone()),
            headers,
            Json(Save {
                mode: "own_stripe".into(),
                api_key: Some("sk_test_rotated_synthetic_key".into()),
                webhook_secret: None,
                installation_id: None,
                broker_token: None,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(rotated["verified"], false);
        assert!(credentials(&pool, a.tenant_id, p.setting_id, 1)
            .await
            .unwrap()
            .api_key
            .as_deref()
            .unwrap()
            .contains("synthetic_key_never_real"));
        let event_body=serde_json::to_vec(&json!({"id":"evt_synthetic_receipt","livemode":false,"type":"test.receipt","data":{"object":{}}})).unwrap();
        let sign = |raw: &[u8]| {
            let now = Utc::now().timestamp();
            let mut message = format!("{now}.").into_bytes();
            message.extend(raw);
            let h = hmac::sign(
                &hmac::Key::new(hmac::HMAC_SHA256, b"whsec_synthetic_key_never_real"),
                &message,
            );
            let mut headers = HeaderMap::new();
            let value = format!(
                "t={now},v1={}",
                h.as_ref()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            );
            headers.insert("stripe-signature", value.parse().unwrap());
            headers
        };
        let body = Bytes::from(event_body.clone());
        let signed = sign(&event_body);
        let (one, two) = tokio::join!(
            webhook(
                ExtractState(state.clone()),
                Path(p.setting_id),
                signed.clone(),
                body.clone()
            ),
            webhook(
                ExtractState(state.clone()),
                Path(p.setting_id),
                signed,
                body
            )
        );
        assert!(one.is_ok());
        assert!(two.is_ok());
        let receipts: i64 =
            sqlx::query_scalar("SELECT count(*) FROM payment_webhook_receipts WHERE setting_id=$1")
                .bind(p.setting_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(receipts, 1);
        let changed=serde_json::to_vec(&json!({"id":"evt_synthetic_receipt","livemode":false,"type":"different.receipt","data":{"object":{}}})).unwrap();
        assert!(matches!(
            webhook(
                ExtractState(state.clone()),
                Path(p.setting_id),
                sign(&changed),
                Bytes::from(changed)
            )
            .await,
            Err(Error::Conflict(_))
        ));
        std::env::remove_var("ENGINE_CREDENTIAL_KEY_FILE");
        std::fs::remove_dir_all(key_dir).unwrap();
        pool.close().await;
    }
}
