// SPDX-License-Identifier: AGPL-3.0-only
//! Durable appointment copays. Only retrieved, account-bound processor evidence creates receipts.
use crate::{
    auth::Actor,
    billing,
    error::{Error, Result},
    State,
};
use async_trait::async_trait;
use axum::{
    extract::{Path, State as ExtractState},
    http::Method,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Copy)]
struct Policy {
    production: bool,
    live_enabled: bool,
}
impl Policy {
    fn current() -> Self {
        Self {
            production: matches!(
                crate::DeploymentEnvironment::from_env(),
                crate::DeploymentEnvironment::Production
            ),
            live_enabled: std::env::var("ENGINE_HOSTED_COPAY_LIVE_ENABLED").as_deref()
                == Ok("true"),
        }
    }
    fn permits(self, live: bool) -> bool {
        if live {
            self.live_enabled
        } else {
            !self.production
        }
    }
}
pub(crate) fn live_collection_enabled() -> bool {
    Policy::current().live_enabled
}
fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn identifier(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix)
        && value.len() > prefix.len()
        && value.len() <= 255
        && value
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'_')
}
#[derive(Deserialize)]
struct Credentials {
    mode: String,
    installation_id: Option<Uuid>,
    broker_token: Option<String>,
}
impl Drop for Credentials {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.broker_token.zeroize();
    }
}
async fn credentials(
    pool: &PgPool,
    tenant: Uuid,
    setting: Uuid,
    revision: i64,
) -> Result<Credentials> {
    let raw:Vec<u8>=sqlx::query_scalar("SELECT encrypted_config FROM payment_credentials WHERE tenant_id=$1 AND setting_id=$2 AND revision=$3").bind(tenant).bind(setting).bind(revision).fetch_optional(pool).await?.ok_or(Error::NotFound)?;
    let opened = crate::provider_settings::open_secret(tenant, setting, "payments", &raw)?;
    let config: Credentials = serde_json::from_str(opened.expose())
        .map_err(|_| Error::Invalid("payment binding cannot be read"))?;
    if config.mode != "suncharts_connect"
        || config.installation_id.is_none()
        || config.broker_token.is_none()
    {
        return Err(Error::Invalid(
            "hosted copay requires a SunCharts Connect payment binding",
        ));
    }
    Ok(config)
}
#[async_trait]
trait Broker: Send + Sync {
    async fn installation(
        &self,
        pool: &PgPool,
        tenant: Uuid,
        setting: Uuid,
        revision: i64,
    ) -> Result<Uuid>;
    async fn call(
        &self,
        pool: &PgPool,
        binding: &Binding,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value>;
}
struct HttpBroker;
#[derive(Clone, Copy)]
struct Binding {
    tenant: Uuid,
    setting: Uuid,
    revision: i64,
    installation: Uuid,
}
#[async_trait]
impl Broker for HttpBroker {
    async fn installation(
        &self,
        pool: &PgPool,
        tenant: Uuid,
        setting: Uuid,
        revision: i64,
    ) -> Result<Uuid> {
        credentials(pool, tenant, setting, revision)
            .await?
            .installation_id
            .ok_or(Error::NotFound)
    }
    async fn call(
        &self,
        pool: &PgPool,
        binding: &Binding,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let config = credentials(pool, binding.tenant, binding.setting, binding.revision).await?;
        if config.installation_id != Some(binding.installation) {
            return Err(Error::Invalid("stored payment installation changed"));
        }
        let mut call = crate::stedi::client()?
            .request(
                method,
                format!(
                    "{}/api/v1/payments/connect/installations/{}{}",
                    crate::payments::broker_base()?,
                    binding.installation,
                    path
                ),
            )
            .bearer_auth(config.broker_token.as_deref().ok_or(Error::NotFound)?);
        if let Some(body) = body {
            call = call.json(&body);
        }
        let response = call
            .send()
            .await
            .map_err(|_| Error::Invalid("payment provider response unavailable"))?;
        let status = response.status();
        let bytes = crate::stedi::bytes(response, 131072).await?;
        if status == axum::http::StatusCode::NOT_FOUND {
            return Err(Error::NotFound);
        }
        if !status.is_success() {
            return Err(Error::Invalid("payment provider request not confirmed"));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| Error::Invalid("payment provider response unsupported"))
    }
}
#[derive(Clone, sqlx::FromRow)]
struct Attempt {
    tenant_id: Uuid,
    id: Uuid,
    patient_id: Uuid,
    appointment_id: Uuid,
    coverage_id: Option<Uuid>,
    setting_id: Uuid,
    credential_revision: i64,
    installation_id: Uuid,
    provider_account_id: String,
    livemode: bool,
    amount_cents: i64,
    currency: String,
    request_id: Uuid,
    creation_hash: String,
    return_url: String,
    status: String,
    provider_session_id: Option<String>,
    provider_payment_intent: Option<String>,
    provider_charge_id: Option<String>,
    provider_captured_at: Option<DateTime<Utc>>,
    checkout_url: Option<String>,
    receipt_id: Option<Uuid>,
    refunded_cents: i64,
    last_result: Option<String>,
    version: i64,
    created_at: DateTime<Utc>,
    lease_id: Option<Uuid>,
}
impl Attempt {
    fn binding(&self) -> Binding {
        Binding {
            tenant: self.tenant_id,
            setting: self.setting_id,
            revision: self.credential_revision,
            installation: self.installation_id,
        }
    }
    fn public(&self, policy: Policy) -> Value {
        json!({"id":self.id,"patient_id":self.patient_id,"appointment_id":self.appointment_id,"amount_cents":self.amount_cents,"currency":self.currency,"livemode":self.livemode,"status":self.status,"checkout_url":if policy.permits(self.livemode)&&self.status=="open"{self.checkout_url.as_deref()}else{None},"receipt_id":self.receipt_id,"refunded_cents":self.refunded_cents,"version":self.version,"created_at":self.created_at,"request_id":self.request_id,"last_result":self.last_result,"captured_at":self.provider_captured_at})
    }
}
async fn load(tx: &mut Transaction<'_, Postgres>, tenant: Uuid, id: Uuid) -> Result<Attempt> {
    sqlx::query_as("SELECT * FROM copay_checkout_attempts WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(tenant)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    action: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO copay_checkout_events(tenant_id,operation_id,version,actor_id,action) SELECT tenant_id,id,version,$3,$4 FROM copay_checkout_attempts WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(a.sub).bind(action).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "billing.hosted_copay_changed", id).await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Create {
    request_id: Uuid,
    amount_cents: i64,
    coverage_id: Option<Uuid>,
    livemode: bool,
    reason: String,
}
async fn current_binding(pool: &PgPool, tenant: Uuid, broker: &dyn Broker) -> Result<Binding> {
    let (setting,revision):(Uuid,i64)=sqlx::query_as("SELECT id,credential_revision FROM payment_settings WHERE tenant_id=$1 AND mode='suncharts_connect'").bind(tenant).fetch_optional(pool).await?.ok_or(Error::Invalid("connect a payment account first"))?;
    Ok(Binding {
        tenant,
        setting,
        revision,
        installation: broker.installation(pool, tenant, setting, revision).await?,
    })
}
fn status_account(binding: &Binding, value: &Value, policy: Policy) -> Result<(String, bool)> {
    let mode = value["livemode"]
        .as_bool()
        .ok_or(Error::Invalid("payment account mode is unknown"))?;
    if value["installation_id"] != binding.installation.to_string()
        || value["remote_tenant_id"] != binding.tenant.to_string()
        || value["checkout_contract_version"] != 1
        || value["hosted_checkout_enabled"] != true
        || value["charges_enabled"] != true
        || value["card_payments_active"] != true
        || value["details_submitted"] != true
        || !policy.permits(mode)
    {
        return Err(Error::Invalid(
            "hosted copay collection is not enabled for this account and environment",
        ));
    }
    let account = value["account_id"]
        .as_str()
        .filter(|v| identifier(v, "acct_"))
        .ok_or(Error::Invalid("payment account is not bound"))?;
    Ok((account.into(), mode))
}
#[allow(clippy::too_many_arguments)]
async fn create_with(
    pool: &PgPool,
    a: &Actor,
    patient: Uuid,
    appointment: Uuid,
    input: Create,
    origin: &str,
    broker: &dyn Broker,
    policy: Policy,
) -> Result<Attempt> {
    a.scheduling()?;
    if !policy.permits(input.livemode) {
        return Err(Error::Invalid(
            "hosted copay collection is disabled for this environment and payment mode",
        ));
    }
    if !(50..=100000000).contains(&input.amount_cents)
        || input.reason.trim().is_empty()
        || input.reason.len() > 1000
    {
        return Err(Error::Invalid("review copay amount and reason"));
    }
    let hash = crate::oauth::hash(
        &serde_json::to_string(&(patient, appointment, &input))
            .map_err(|_| Error::Invalid("invalid copay request"))?,
    );
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    if let Some(prior) = sqlx::query_as::<_, Attempt>(
        "SELECT * FROM copay_checkout_attempts WHERE tenant_id=$1 AND request_id=$2 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(input.request_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        if prior.creation_hash != hash {
            return Err(Error::Conflict(
                "copay request ID was already used with different content",
            ));
        }
        tx.commit().await?;
        process_id(pool, a, prior.id, broker, policy).await?;
        let mut tx = pool.begin().await?;
        return load(&mut tx, a.tenant_id, prior.id).await;
    }
    let state: Option<String> = sqlx::query_scalar(
        "SELECT status FROM appointments WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(patient)
    .bind(appointment)
    .fetch_optional(&mut *tx)
    .await?;
    if state
        .as_deref()
        .is_none_or(|s| ["cancelled", "canceled", "no_show"].contains(&s))
    {
        return Err(Error::Invalid(
            "select an active appointment for this patient",
        ));
    }
    let coverage: Option<Value> = if let Some(id) = input.coverage_id {
        Some(sqlx::query_scalar("SELECT to_jsonb(c)-'tenant_id' FROM insurance_coverages c WHERE tenant_id=$1 AND patient_id=$2 AND id=$3").bind(a.tenant_id).bind(patient).bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?)
    } else {
        None
    };
    let unresolved:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM copay_checkout_attempts WHERE tenant_id=$1 AND appointment_id=$2 AND status IN ('creating','open','needs_review') AND receipt_id IS NULL)").bind(a.tenant_id).bind(appointment).fetch_one(&mut *tx).await?;
    if unresolved {
        return Err(Error::Conflict(
            "review the existing copay checkout before starting another",
        ));
    }
    let binding = current_binding(pool, a.tenant_id, broker).await?;
    let status = broker
        .call(pool, &binding, Method::GET, "/status", None)
        .await?;
    let (account, mode) = status_account(&binding, &status, policy)?;
    if mode != input.livemode {
        return Err(Error::Conflict(
            "payment account mode changed; review before continuing",
        ));
    }
    let id = Uuid::new_v4();
    let return_url = format!("{}/?copay_checkout={id}", origin.trim_end_matches('/'));
    sqlx::query("INSERT INTO copay_checkout_attempts(tenant_id,id,patient_id,appointment_id,coverage_id,coverage_snapshot,setting_id,credential_revision,installation_id,provider_account_id,livemode,amount_cents,request_id,creation_hash,requested_by,reason,return_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)").bind(a.tenant_id).bind(id).bind(patient).bind(appointment).bind(input.coverage_id).bind(coverage).bind(binding.setting).bind(binding.revision).bind(binding.installation).bind(account).bind(mode).bind(input.amount_cents).bind(input.request_id).bind(hash).bind(a.sub).bind(input.reason.trim()).bind(return_url).execute(&mut *tx).await?;
    event(&mut tx, a, id, "checkout_reserved").await?;
    tx.commit().await?;
    process_id(pool, a, id, broker, policy).await?;
    let mut tx = pool.begin().await?;
    load(&mut tx, a.tenant_id, id).await
}
struct Verified {
    session: String,
    url: Option<String>,
    paid: bool,
    expired: bool,
    intent: Option<String>,
    charge: Option<String>,
    refunded: i64,
    captured_at: Option<DateTime<Utc>>,
}
fn envelope<'a>(attempt: &Attempt, value: &'a Value) -> Result<&'a Value> {
    if value["contract_version"] != 1
        || value["installation_id"] != attempt.installation_id.to_string()
        || value["remote_tenant_id"] != attempt.tenant_id.to_string()
        || value["account_id"] != attempt.provider_account_id
        || value["livemode"] != attempt.livemode
        || value["request_id"] != attempt.id.to_string()
    {
        return Err(Error::Invalid(
            "payment evidence does not match the reserved account, mode and request",
        ));
    }
    value
        .get("session")
        .ok_or(Error::Invalid("payment session field is missing"))
}
fn verify(attempt: &Attempt, value: &Value) -> Result<Verified> {
    let v = envelope(attempt, value)?;
    let session = v["id"]
        .as_str()
        .filter(|s| {
            identifier(
                s,
                if attempt.livemode {
                    "cs_live_"
                } else {
                    "cs_test_"
                },
            )
        })
        .ok_or(Error::Invalid("payment session identity is invalid"))?;
    if attempt
        .provider_session_id
        .as_ref()
        .is_some_and(|s| s != session)
        || v["mode"] != "payment"
        || v["livemode"] != attempt.livemode
        || v["amount_total"] != attempt.amount_cents
        || v["currency"] != attempt.currency
        || v["client_reference_id"] != attempt.id.to_string()
        || v["metadata"]["native_payment_id"] != attempt.id.to_string()
    {
        return Err(Error::Invalid(
            "payment session does not match the reserved copay",
        ));
    }
    let url = v["url"].as_str().map(str::to_owned);
    if let Some(url) = &url {
        let u = url::Url::parse(url).map_err(|_| Error::Invalid("invalid checkout URL"))?;
        if u.scheme() != "https"
            || u.host_str() != Some("checkout.stripe.com")
            || !u.username().is_empty()
            || u.password().is_some()
        {
            return Err(Error::Invalid("checkout URL is not Stripe hosted"));
        }
    }
    let paid = v["status"] == "complete" && v["payment_status"] == "paid";
    let expired = v["status"] == "expired";
    if !paid && !expired && !(v["status"] == "open" && v["payment_status"] == "unpaid") {
        return Err(Error::Invalid(
            "payment has not reached a supported confirmed state",
        ));
    }
    let mut out = Verified {
        session: session.into(),
        url,
        paid,
        expired,
        intent: None,
        charge: None,
        refunded: 0,
        captured_at: None,
    };
    if paid {
        let intent = &v["payment_intent"];
        let charge = &intent["latest_charge"];
        let pi = intent["id"]
            .as_str()
            .filter(|v| identifier(v, "pi_"))
            .ok_or(Error::Invalid("expanded payment intent required"))?;
        let ch = charge["id"]
            .as_str()
            .filter(|v| identifier(v, "ch_"))
            .ok_or(Error::Invalid("expanded captured charge required"))?;
        let captured_at = charge["created"]
            .as_i64()
            .filter(|timestamp| (1_262_304_000..=Utc::now().timestamp() + 300).contains(timestamp))
            .and_then(|timestamp| DateTime::<Utc>::from_timestamp(timestamp, 0))
            .ok_or(Error::Invalid(
                "provider capture timestamp is missing or invalid",
            ))?;
        if attempt
            .provider_captured_at
            .is_some_and(|prior| prior != captured_at)
        {
            return Err(Error::Invalid("provider capture timestamp changed"));
        }
        out.captured_at = Some(captured_at);
        let refunded = charge["amount_refunded"]
            .as_i64()
            .ok_or(Error::Invalid("refund evidence missing"))?;
        if intent["livemode"] != attempt.livemode
            || charge["livemode"] != attempt.livemode
            || intent["status"] != "succeeded"
            || intent["amount"] != attempt.amount_cents
            || intent["amount_received"] != attempt.amount_cents
            || intent["currency"] != attempt.currency
            || charge["paid"] != true
            || charge["captured"] != true
            || charge["disputed"] != false
            || charge["amount"] != attempt.amount_cents
            || charge["currency"] != attempt.currency
            || charge["payment_intent"] != pi
            || !(0..=attempt.amount_cents).contains(&refunded)
            || attempt
                .provider_payment_intent
                .as_ref()
                .is_some_and(|v| v != pi)
            || attempt.provider_charge_id.as_ref().is_some_and(|v| v != ch)
        {
            return Err(Error::Invalid("captured payment evidence is inconsistent"));
        }
        out.intent = Some(pi.into());
        out.charge = Some(ch.into());
        out.refunded = refunded;
    }
    Ok(out)
}
async fn apply(
    pool: &PgPool,
    a: &Actor,
    id: Uuid,
    lease: Uuid,
    value: &Value,
    policy: Policy,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let attempt = load(&mut tx, a.tenant_id, id).await?;
    if attempt.lease_id != Some(lease) {
        return Ok(());
    }
    if !policy.permits(attempt.livemode) {
        return Err(Error::Invalid(
            "hosted copay reconciliation is disabled in this environment",
        ));
    }
    let v = verify(&attempt, value)?;
    if (attempt.receipt_id.is_some() && !v.paid)
        || (attempt.status == "expired" && !v.expired)
        || (attempt.status == "refunded" && (!v.paid || v.refunded != attempt.amount_cents))
        || v.refunded < attempt.refunded_cents
    {
        return Err(Error::Invalid(
            "payment evidence would reverse a confirmed state",
        ));
    }
    let receipt = if v.paid && attempt.receipt_id.is_none() {
        Some(
            billing::record_verified_hosted_copay(
                &mut tx,
                a,
                attempt.patient_id,
                attempt.appointment_id,
                attempt.coverage_id,
                attempt.amount_cents,
                attempt.id,
                v.charge
                    .as_deref()
                    .ok_or(Error::Invalid("captured charge missing"))?,
                attempt.livemode,
                v.captured_at
                    .ok_or(Error::Invalid("provider capture timestamp missing"))?
                    .date_naive(),
            )
            .await?,
        )
    } else {
        attempt.receipt_id
    };
    if v.refunded > attempt.refunded_cents {
        billing::apply_verified_hosted_copay_refund(&mut tx, a, attempt.id, v.refunded).await?;
    }
    let status = if v.paid && v.refunded == attempt.amount_cents {
        "refunded"
    } else if v.paid {
        "paid"
    } else if v.expired {
        "expired"
    } else {
        "open"
    };
    sqlx::query("UPDATE copay_checkout_attempts SET status=$3,provider_session_id=$4,provider_payment_intent=coalesce(provider_payment_intent,$5),provider_charge_id=coalesce(provider_charge_id,$6),checkout_url=$7,receipt_id=$8,refunded_cents=$9,provider_captured_at=coalesce(provider_captured_at,$10),version=version+1,updated_at=now(),lease_id=NULL,lease_until=NULL,last_result='provider_verified',next_poll_at=now()+CASE WHEN $3='paid' THEN interval '1 hour' ELSE interval '30 seconds' END WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(status).bind(v.session).bind(v.intent).bind(v.charge).bind(if status=="open"{v.url}else{None}).bind(receipt).bind(v.refunded).bind(v.captured_at).execute(&mut *tx).await?;
    if status == "paid" {
        billing::allocate_verified_hosted_copay_credit(&mut tx, a, id).await?;
    }
    event(&mut tx, a, id, "provider_evidence_verified").await?;
    tx.commit().await?;
    Ok(())
}
async fn fail_attempt(pool: &PgPool, a: &Actor, id: Uuid, lease: Uuid, review: bool) -> Result<()> {
    let mut tx = pool.begin().await?;
    let attempt = load(&mut tx, a.tenant_id, id).await?;
    if attempt.lease_id != Some(lease) {
        return Ok(());
    }
    sqlx::query("UPDATE copay_checkout_attempts SET status=CASE WHEN $4 THEN 'needs_review' ELSE status END,last_result=CASE WHEN $4 THEN 'provider_evidence_needs_review' ELSE 'provider_retry_pending' END,lease_id=NULL,lease_until=NULL,next_poll_at=now()+CASE WHEN $4 THEN interval '15 minutes' ELSE interval '1 minute' END,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3").bind(a.tenant_id).bind(id).bind(lease).bind(review).execute(&mut *tx).await?;
    event(
        &mut tx,
        a,
        id,
        if review {
            "evidence_needs_review"
        } else {
            "provider_retry_pending"
        },
    )
    .await?;
    tx.commit().await?;
    Ok(())
}
async fn process_id(
    pool: &PgPool,
    a: &Actor,
    id: Uuid,
    broker: &dyn Broker,
    policy: Policy,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let attempt = load(&mut tx, a.tenant_id, id).await?;
    if !policy.permits(attempt.livemode)
        || ["expired", "refunded"].contains(&attempt.status.as_str())
    {
        return Ok(());
    }
    let lease = Uuid::new_v4();
    let changed=sqlx::query("UPDATE copay_checkout_attempts SET lease_id=$3,lease_until=now()+interval '2 minutes',attempts=attempts+1,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND (lease_until IS NULL OR lease_until<now())").bind(a.tenant_id).bind(id).bind(lease).execute(&mut *tx).await?.rows_affected();
    if changed == 0 {
        return Ok(());
    }
    event(&mut tx, a, id, "provider_poll_started").await?;
    tx.commit().await?;
    let binding = attempt.binding();
    let fetched = if let Some(session) = &attempt.provider_session_id {
        broker
            .call(
                pool,
                &binding,
                Method::GET,
                &format!("/hosted-checkouts/{session}"),
                None,
            )
            .await
    } else {
        broker
            .call(
                pool,
                &binding,
                Method::GET,
                &format!("/hosted-checkout-requests/{}", attempt.id),
                None,
            )
            .await
    };
    let can_create = attempt.created_at > Utc::now() - chrono::Duration::hours(23);
    let value = match fetched {
        Ok(v) if v.get("session") == Some(&Value::Null) => {
            if envelope(&attempt, &v).is_err() {
                fail_attempt(pool, a, id, lease, true).await?;
                return Ok(());
            }
            let safe = v["retry_safe_until"]
                .as_str()
                .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
                .is_some_and(|v| v > Utc::now());
            if !can_create || !safe || v["recovery_required"] != false {
                fail_attempt(pool, a, id, lease, true).await?;
                return Ok(());
            }
            None
        }
        Ok(v) => Some(v),
        Err(Error::NotFound) if attempt.provider_session_id.is_none() && can_create => None,
        Err(Error::NotFound) if attempt.provider_session_id.is_none() => {
            fail_attempt(pool, a, id, lease, true).await?;
            return Ok(());
        }
        Err(_) => {
            fail_attempt(pool, a, id, lease, false).await?;
            return Ok(());
        }
    };
    let value = if let Some(v) = value {
        v
    } else {
        let body = json!({"request_id":attempt.id,"amount_cents":attempt.amount_cents,"currency":attempt.currency,"return_url":attempt.return_url,"account_id":attempt.provider_account_id,"livemode":attempt.livemode});
        match broker
            .call(
                pool,
                &binding,
                Method::POST,
                "/hosted-checkouts",
                Some(body),
            )
            .await
        {
            Ok(v) => v,
            Err(_) => {
                fail_attempt(pool, a, id, lease, false).await?;
                return Ok(());
            }
        }
    };
    // Even a successful creation response is only a locator. Retrieve authoritative state.
    let session = match envelope(&attempt, &value)
        .ok()
        .and_then(|v| v["id"].as_str())
        .filter(|v| {
            identifier(
                v,
                if attempt.livemode {
                    "cs_live_"
                } else {
                    "cs_test_"
                },
            )
        }) {
        Some(id) => id,
        None => {
            fail_attempt(pool, a, id, lease, true).await?;
            return Ok(());
        }
    };
    let evidence = match broker
        .call(
            pool,
            &binding,
            Method::GET,
            &format!("/hosted-checkouts/{session}"),
            None,
        )
        .await
    {
        Ok(v) => v,
        Err(_) => {
            fail_attempt(pool, a, id, lease, false).await?;
            return Ok(());
        }
    };
    if apply(pool, a, id, lease, &evidence, policy).await.is_err() {
        fail_attempt(pool, a, id, lease, true).await?;
    }
    Ok(())
}
pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/patients/{p}/appointments/{a}/copay-checkouts",
            get(list).post(create),
        )
        .route(
            "/api/v1/patients/{p}/appointments/{a}/copay-checkouts/{id}",
            get(detail),
        )
        .route(
            "/api/v1/patients/{p}/appointments/{a}/copay-checkouts/{id}/refresh",
            post(refresh),
        )
}
async fn create(
    a: Actor,
    ExtractState(state): ExtractState<State>,
    Path((patient, appointment)): Path<(Uuid, Uuid)>,
    Json(input): Json<Create>,
) -> Result<Json<Value>> {
    let policy = Policy::current();
    let result = create_with(
        db(&state)?,
        &a,
        patient,
        appointment,
        input,
        state.browser.as_ref().ok_or(Error::NotFound)?.origin(),
        &HttpBroker,
        policy,
    )
    .await?;
    Ok(Json(json!({"operation":result.public(policy)})))
}
async fn check_appointment(
    pool: &PgPool,
    a: &Actor,
    patient: Uuid,
    appointment: Uuid,
) -> Result<()> {
    a.staff()?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM appointments WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)",
    )
    .bind(a.tenant_id)
    .bind(patient)
    .bind(appointment)
    .fetch_one(pool)
    .await?;
    if exists {
        Ok(())
    } else {
        Err(Error::NotFound)
    }
}
async fn list(
    a: Actor,
    ExtractState(state): ExtractState<State>,
    Path((patient, appointment)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let pool = db(&state)?;
    check_appointment(pool, &a, patient, appointment).await?;
    let policy = Policy::current();
    let rows:Vec<Attempt>=sqlx::query_as("SELECT * FROM copay_checkout_attempts WHERE tenant_id=$1 AND patient_id=$2 AND appointment_id=$3 ORDER BY created_at DESC LIMIT 101").bind(a.tenant_id).bind(patient).bind(appointment).fetch_all(pool).await?;
    if rows.len() > 100 {
        return Err(Error::Invalid(
            "copay checkout history exceeds preview limit",
        ));
    }
    let availability = if policy.production && !policy.live_enabled {
        json!({"available":false,"livemode":null,"reason":"Hosted copay checkout requires an explicitly enabled live payment mode in production."})
    } else {
        let result = async {
            let binding = current_binding(pool, a.tenant_id, &HttpBroker).await?;
            let status = HttpBroker
                .call(pool, &binding, Method::GET, "/status", None)
                .await?;
            status_account(&binding, &status, policy)
        }
        .await;
        match result {
            Ok((_, live)) => json!({"available":true,"livemode":live,"reason":null}),
            Err(_) => {
                json!({"available":false,"livemode":null,"reason":"Connect account readiness or this payment mode is not enabled for hosted copays."})
            }
        }
    };
    let mut tx = pool.begin().await?;
    crate::postgres::audit(&mut tx, &a, "billing.hosted_copay_read", appointment).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":rows.iter().map(|v|v.public(policy)).collect::<Vec<_>>(),"availability":availability}),
    ))
}
async fn scoped(
    pool: &PgPool,
    a: &Actor,
    patient: Uuid,
    appointment: Uuid,
    id: Uuid,
) -> Result<Attempt> {
    check_appointment(pool, a, patient, appointment).await?;
    let mut tx = pool.begin().await?;
    let row = load(&mut tx, a.tenant_id, id).await?;
    if row.patient_id != patient || row.appointment_id != appointment {
        return Err(Error::NotFound);
    }
    crate::postgres::audit(&mut tx, a, "billing.hosted_copay_read", id).await?;
    tx.commit().await?;
    Ok(row)
}
async fn detail(
    a: Actor,
    ExtractState(state): ExtractState<State>,
    Path((patient, appointment, id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let row = scoped(db(&state)?, &a, patient, appointment, id).await?;
    Ok(Json(json!({"operation":row.public(Policy::current())})))
}
async fn refresh(
    a: Actor,
    ExtractState(state): ExtractState<State>,
    Path((patient, appointment, id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    let pool = db(&state)?;
    scoped(pool, &a, patient, appointment, id).await?;
    process_id(pool, &a, id, &HttpBroker, Policy::current()).await?;
    let row = scoped(pool, &a, patient, appointment, id).await?;
    Ok(Json(json!({"operation":row.public(Policy::current())})))
}
async fn poll(pool: &PgPool, broker: &dyn Broker, policy: Policy) -> Result<()> {
    if policy.production && !policy.live_enabled {
        return Ok(());
    }
    let due:Vec<(Uuid,Uuid)>=sqlx::query_as("SELECT tenant_id,id FROM copay_checkout_attempts WHERE status NOT IN ('expired','refunded') AND ((livemode AND $1) OR (NOT livemode AND $2)) AND next_poll_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_poll_at LIMIT 20").bind(policy.live_enabled).bind(!policy.production).fetch_all(pool).await?;
    for (tenant, id) in due {
        // A single corrupt or unavailable attempt must not starve other appointments.
        let _ = process_id(pool, &crate::delivery::worker(tenant), id, broker, policy).await;
    }
    Ok(())
}
pub async fn run(pool: PgPool) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
    loop {
        interval.tick().await;
        let _ = poll(&pool, &HttpBroker, Policy::current()).await;
    }
}

#[cfg(test)]
#[path = "copay_checkout_tests.rs"]
mod tests;
