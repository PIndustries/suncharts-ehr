// SPDX-License-Identifier: AGPL-3.0-only
//! Card readers for the practice, and card payments taken on one.
//!
//! A reader payment is an ordinary copay or invoice card attempt with `channel = 'reader'`: it
//! lives in the same tables as hosted checkout and is posted by the same code, under the same
//! rule for "paid". This module only adds what a reader needs: sending the payment to the
//! reader, reading it back every couple of seconds, and closing it.
//!
//! A reader payment always ends by itself. It is paid, or it is closed (`expired`) because the
//! card was declined, staff or the patient cancelled, the reader could not be used, or nobody
//! presented a card within five minutes. It is closed only after SunCharts Connect confirms
//! the payment was cancelled at Stripe or never existed there, so a card that was approved at
//! the last moment is recorded as paid rather than lost.
//!
//! Nothing about the patient is sent to SunCharts Connect or Stripe: only the amount, the
//! reader and this attempt's own identifier.
use crate::{
    auth::{Actor, Role},
    copay_checkout::{self as hosted, Binding, Broker, EvidenceBinding, HttpBroker, Policy, Reply},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::Method,
    routing::{get, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

/// How long a reader waits for a card before the payment is cancelled.
const WAIT_SECONDS: i64 = 300;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Copay,
    Invoice,
}
impl Kind {
    pub(crate) fn table(self) -> &'static str {
        match self {
            Kind::Copay => "copay_checkout_attempts",
            Kind::Invoice => "invoice_checkout_attempts",
        }
    }
    pub(crate) async fn event(
        self,
        tx: &mut Transaction<'_, Postgres>,
        a: &Actor,
        id: Uuid,
        action: &str,
    ) -> Result<()> {
        match self {
            Kind::Copay => hosted::reader_event(tx, a, id, action).await,
            Kind::Invoice => crate::installments::reader_event(tx, a, id, action).await,
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn apply(
        self,
        pool: &PgPool,
        a: &Actor,
        id: Uuid,
        lease: Uuid,
        value: &Value,
        policy: Policy,
        note: &'static str,
    ) -> Result<()> {
        match self {
            Kind::Copay => hosted::apply_noted(pool, a, id, lease, value, policy, Some(note)).await,
            Kind::Invoice => {
                crate::installments::apply_noted(pool, a, id, lease, value, policy, Some(note))
                    .await
            }
        }
    }
    /// Whether the payment may still be sent to a reader.
    async fn may_start(self, pool: &PgPool, a: &Actor, id: Uuid) -> Result<bool> {
        match self {
            Kind::Copay => Ok(true),
            Kind::Invoice => crate::installments::reader_may_start(pool, a, id).await,
        }
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    tenant_id: Uuid,
    id: Uuid,
    setting_id: Uuid,
    credential_revision: i64,
    installation_id: Uuid,
    provider_account_id: String,
    livemode: bool,
    amount_cents: i64,
    currency: String,
    status: String,
    provider_payment_intent: Option<String>,
    provider_charge_id: Option<String>,
    provider_captured_at: Option<DateTime<Utc>>,
    reader_id: Option<String>,
    reader_cancel_requested_at: Option<DateTime<Utc>>,
    last_result: Option<String>,
    created_at: DateTime<Utc>,
}
impl Row {
    fn binding(&self) -> Binding {
        Binding {
            tenant: self.tenant_id,
            setting: self.setting_id,
            revision: self.credential_revision,
            installation: self.installation_id,
        }
    }
    fn evidence(&self) -> EvidenceBinding {
        EvidenceBinding {
            tenant_id: self.tenant_id,
            id: self.id,
            installation_id: self.installation_id,
            provider_account_id: self.provider_account_id.clone(),
            livemode: self.livemode,
            amount_cents: self.amount_cents,
            currency: self.currency.clone(),
            provider_session_id: None,
            provider_payment_intent: self.provider_payment_intent.clone(),
            provider_charge_id: self.provider_charge_id.clone(),
            provider_captured_at: self.provider_captured_at,
            reader: true,
        }
    }
    /// The account binding SunCharts Connect checks on every reader call.
    fn account(&self) -> Value {
        json!({"account_id":self.provider_account_id,"livemode":self.livemode,"remote_tenant_id":self.tenant_id})
    }
}
async fn load(
    tx: &mut Transaction<'_, Postgres>,
    kind: Kind,
    tenant: Uuid,
    id: Uuid,
) -> Result<Option<Row>> {
    Ok(sqlx::query_as(&format!("SELECT tenant_id,id,setting_id,credential_revision,installation_id,provider_account_id,livemode,amount_cents,currency,status,provider_payment_intent,provider_charge_id,provider_captured_at,reader_id,reader_cancel_requested_at,last_result,created_at FROM {} WHERE tenant_id=$1 AND id=$2 AND channel='reader' FOR UPDATE", kind.table()))
        .bind(tenant)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?)
}

/// One step for a leased reader payment.
struct Step<'a> {
    pool: &'a PgPool,
    a: &'a Actor,
    kind: Kind,
    row: Row,
    lease: Uuid,
    broker: &'a dyn Broker,
    policy: Policy,
}
impl Step<'_> {
    async fn ask(&self, method: Method, path: &str, body: Option<Value>) -> Result<Reply> {
        self.broker
            .reply(self.pool, &self.row.binding(), method, path, body)
            .await
    }
    /// Try again in a moment; what staff see does not change.
    async fn retry(&self) -> Result<()> {
        sqlx::query(&format!("UPDATE {} SET lease_id=NULL,lease_until=NULL,next_poll_at=now()+interval '2 seconds',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3", self.kind.table()))
            .bind(self.a.tenant_id).bind(self.row.id).bind(self.lease).execute(self.pool).await?;
        Ok(())
    }
    /// The payment stays open with a new line for staff, such as a card being approved.
    async fn wait(&self, note: &'static str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let changed = sqlx::query(&format!("UPDATE {} SET last_result=$4,lease_id=NULL,lease_until=NULL,next_poll_at=now()+interval '2 seconds',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3", self.kind.table()))
            .bind(self.a.tenant_id).bind(self.row.id).bind(self.lease).bind(note).execute(&mut *tx).await?.rows_affected();
        if changed == 1 && self.row.last_result.as_deref() != Some(note) {
            self.kind.event(&mut tx, self.a, self.row.id, note).await?;
        }
        tx.commit().await?;
        Ok(())
    }
    /// Evidence that does not fit this payment: a person has to look at it.
    async fn review(&self) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let changed = sqlx::query(&format!("UPDATE {} SET status='needs_review',last_result='provider_evidence_needs_review',lease_id=NULL,lease_until=NULL,next_poll_at=now()+interval '15 minutes',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3", self.kind.table()))
            .bind(self.a.tenant_id).bind(self.row.id).bind(self.lease).execute(&mut *tx).await?.rows_affected();
        if changed == 1 {
            self.kind
                .event(&mut tx, self.a, self.row.id, "evidence_needs_review")
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
    /// SunCharts Connect has no record of this payment, so nothing exists at Stripe.
    async fn close(&self, note: &'static str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let changed = sqlx::query(&format!("UPDATE {} SET status='expired',last_result=$4,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND provider_payment_intent IS NULL AND provider_captured_at IS NULL", self.kind.table()))
            .bind(self.a.tenant_id).bind(self.row.id).bind(self.lease).bind(note).execute(&mut *tx).await?.rows_affected();
        if changed == 1 {
            self.kind.event(&mut tx, self.a, self.row.id, note).await?;
        }
        tx.commit().await?;
        if changed == 1 {
            Ok(())
        } else {
            self.review().await
        }
    }
    /// Post what the processor reports. A mismatch goes to review, exactly as hosted checkout.
    async fn settle(&self, value: &Value, note: &'static str) -> Result<()> {
        if self
            .kind
            .apply(
                self.pool,
                self.a,
                self.row.id,
                self.lease,
                value,
                self.policy,
                note,
            )
            .await
            .is_err()
        {
            self.review().await?;
        }
        Ok(())
    }
    async fn start(&self) -> Result<()> {
        if !self
            .kind
            .may_start(self.pool, self.a, self.row.id)
            .await
            .unwrap_or(false)
        {
            return self.stop("reader_unavailable").await;
        }
        let mut body = self.row.account();
        body["request_id"] = json!(self.row.id);
        body["operation"] = json!(self.row.id);
        body["amount_cents"] = json!(self.row.amount_cents);
        body["currency"] = json!(self.row.currency);
        body["reader_id"] = json!(self.row.reader_id);
        let reply = match self
            .ask(Method::POST, "/terminal/payments", Some(body))
            .await
        {
            Ok(reply) => reply,
            Err(_) => return self.retry().await,
        };
        match (reply.status, reply.code()) {
            (200..=299, _) => self.settle(&reply.body, "reader_waiting").await,
            // The reader never acknowledged; the same request is safe to send again.
            (409, "reader_timeout") => self.retry().await,
            (409, "reader_offline") => self.stop("reader_offline").await,
            (409, "reader_busy") => self.stop("reader_in_use").await,
            (409, "payment_cancelled") => self.stop("reader_cancelled").await,
            (400..=499, _) => self.stop("reader_unavailable").await,
            _ => self.retry().await,
        }
    }
    /// Cancel at the processor, then record whatever really happened.
    async fn stop(&self, note: &'static str) -> Result<()> {
        let reply = match self
            .ask(
                Method::POST,
                &format!("/terminal/payments/{}/cancel", self.row.id),
                Some(self.row.account()),
            )
            .await
        {
            Ok(reply) => reply,
            Err(_) => return self.retry().await,
        };
        match (reply.status, reply.code()) {
            (200..=299, _) => {
                match hosted::verify_reader_bound(&self.row.evidence(), &reply.body) {
                    Ok(v) if v.paid || v.expired => self.settle(&reply.body, note).await,
                    Ok(_) => self.wait("reader_finishing").await,
                    Err(_) => self.review().await,
                }
            }
            (404, _) => self.close(note).await,
            // A presented card is being approved: the outcome is read on the next pass.
            (409, "reader_busy") => self.wait("reader_finishing").await,
            _ => self.retry().await,
        }
    }
    async fn step(&self) -> Result<()> {
        let path = format!("/terminal/payments/{}", self.row.id);
        let reply = match self.ask(Method::GET, &path, None).await {
            Ok(reply) => reply,
            Err(_) => return self.retry().await,
        };
        // A captured payment is only watched for refunds from here on.
        if self.row.provider_captured_at.is_some() {
            return match reply.status {
                200..=299 => self.settle(&reply.body, "provider_verified").await,
                _ => self.retry().await,
            };
        }
        let stop = if self.row.reader_cancel_requested_at.is_some() {
            Some("reader_cancelled")
        } else if Utc::now() > self.row.created_at + chrono::Duration::seconds(WAIT_SECONDS) {
            Some("reader_timed_out")
        } else {
            None
        };
        let fresh = self.row.status == "creating";
        if reply.status == 404 {
            return match stop {
                Some(note) => self.stop(note).await,
                None if fresh => self.start().await,
                None => self.review().await,
            };
        }
        if !(200..=299).contains(&reply.status) {
            // Reading can be refused while cancelling still works, so a payment that has to
            // end is never held open by a failed read.
            return match stop {
                Some(note) => self.stop(note).await,
                None => self.retry().await,
            };
        }
        let value = &reply.body;
        let Ok(seen) = hosted::verify_reader_bound(&self.row.evidence(), value) else {
            return self.review().await;
        };
        let action = &value["reader_action"];
        if seen.paid || seen.expired {
            let note = match (stop, action["failure_code"].as_str()) {
                (Some(note), _) => note,
                (None, Some("customer_canceled")) | (None, None) => "reader_cancelled",
                (None, Some(_)) => "reader_declined",
            };
            return self.settle(value, note).await;
        }
        if let Some(note) = stop {
            return self.stop(note).await;
        }
        if value["payment_intent"].is_null() {
            return if fresh {
                self.start().await
            } else {
                self.review().await
            };
        }
        match action["status"].as_str() {
            Some("failed") => {
                self.stop(match action["failure_code"].as_str() {
                    Some("customer_canceled") => "reader_cancelled",
                    Some("connection_error") => "reader_failed",
                    _ => "reader_declined",
                })
                .await
            }
            Some("in_progress") if value["reader"]["status"] == "offline" => {
                self.settle(value, "reader_offline").await
            }
            Some("in_progress") => self.settle(value, "reader_waiting").await,
            Some("succeeded") => self.settle(value, "reader_finishing").await,
            // The reader could not be read just now; the payment itself is unchanged.
            _ if value["reader"].is_null() => self.settle(value, "reader_waiting").await,
            // The reader is not showing this payment. Send it if that never happened;
            // otherwise the reader was reset and the payment is closed.
            _ if fresh => self.start().await,
            _ => self.stop("reader_cancelled").await,
        }
    }
}

/// Advance one reader payment. Safe to call from any number of places at once: only the caller
/// holding the short lease does anything.
pub(crate) async fn drive(
    pool: &PgPool,
    a: &Actor,
    kind: Kind,
    id: Uuid,
    broker: &dyn Broker,
    policy: Policy,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let Some(row) = load(&mut tx, kind, a.tenant_id, id).await? else {
        return Ok(());
    };
    if !policy.permits(row.livemode) || ["expired", "refunded"].contains(&row.status.as_str()) {
        return Ok(());
    }
    let lease = Uuid::new_v4();
    let leased = sqlx::query(&format!("UPDATE {} SET lease_id=$3,lease_until=now()+interval '20 seconds',attempts=attempts+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND (lease_until IS NULL OR lease_until<now())", kind.table()))
        .bind(a.tenant_id).bind(id).bind(lease).execute(&mut *tx).await?.rows_affected();
    if leased == 0 {
        return Ok(());
    }
    tx.commit().await?;
    Step {
        pool,
        a,
        kind,
        row,
        lease,
        broker,
        policy,
    }
    .step()
    .await
}

/// Staff asked to cancel. The request is recorded first, so the payment is cancelled on the
/// next pass even if this call cannot reach the reader right now.
pub(crate) async fn cancel(
    pool: &PgPool,
    a: &Actor,
    kind: Kind,
    id: Uuid,
    broker: &dyn Broker,
    policy: Policy,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let row = load(&mut tx, kind, a.tenant_id, id)
        .await?
        .ok_or(Error::NotFound)?;
    if ["creating", "open"].contains(&row.status.as_str())
        && row.reader_cancel_requested_at.is_none()
    {
        sqlx::query(&format!("UPDATE {} SET reader_cancel_requested_at=now(),next_poll_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2", kind.table()))
            .bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
        kind.event(&mut tx, a, id, "reader_cancel_requested")
            .await?;
    }
    tx.commit().await?;
    drive(pool, a, kind, id, broker, policy).await
}

async fn poll(pool: &PgPool, broker: &dyn Broker, policy: Policy) -> Result<()> {
    for kind in [Kind::Copay, Kind::Invoice] {
        let due: Vec<(Uuid, Uuid)> = sqlx::query_as(&format!("SELECT tenant_id,id FROM {} WHERE channel='reader' AND status IN ('creating','open') AND ((livemode AND $1) OR (NOT livemode AND $2)) AND next_poll_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_poll_at LIMIT 20", kind.table()))
            .bind(policy.live_enabled).bind(!policy.production).fetch_all(pool).await?;
        for (tenant, id) in due {
            // One unreachable payment must not hold up the others.
            let _ = drive(
                pool,
                &crate::delivery::worker(tenant),
                kind,
                id,
                broker,
                policy,
            )
            .await;
        }
    }
    Ok(())
}
/// Open reader payments are read every two seconds. Paid ones are watched for refunds by the
/// existing copay and invoice workers.
pub async fn run(pool: PgPool) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let _ = poll(&pool, &HttpBroker, Policy::current()).await;
    }
}

// ---- The practice's readers ---------------------------------------------------------------

fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn unconfirmed() -> Error {
    Error::Invalid("Card readers could not be reached. Try again in a few minutes.")
}
/// Adding, renaming and removing readers is for the practice owner, like reader ordering.
async fn manager(state: &State, a: &Actor) -> Result<()> {
    if !matches!(a.role, Role::Owner) {
        return Err(Error::Forbidden);
    }
    crate::access_policies::require_native(state, a, "billing", "edit").await
}
enum Account {
    /// The binding, what SunCharts Connect checks on each call, the account mode, and
    /// whether a payment can be taken on a reader right now.
    Ready(Binding, Value, bool, bool),
    NotConnected,
    Unavailable,
}
/// The connected payment account readers belong to. Readers can be set up as soon as the
/// account can take card payments; taking a payment has its own, stricter check.
async fn account(
    pool: &PgPool,
    tenant: Uuid,
    broker: &dyn Broker,
    policy: Policy,
) -> Result<Account> {
    let Ok(binding) = hosted::current_binding(pool, tenant, broker).await else {
        return Ok(Account::NotConnected);
    };
    let status = broker
        .call(pool, &binding, Method::GET, "/status", None)
        .await
        .map_err(|_| unconfirmed())?;
    if status["installation_id"] != binding.installation.to_string()
        || status["remote_tenant_id"] != tenant.to_string()
    {
        return Err(unconfirmed());
    }
    let (Some(id), Some(live)) = (
        status["account_id"]
            .as_str()
            .filter(|id| hosted::identifier(id, "acct_")),
        status["livemode"].as_bool(),
    ) else {
        return Ok(Account::NotConnected);
    };
    if status["charges_enabled"] != true || status["details_submitted"] != true {
        return Ok(Account::NotConnected);
    }
    // A production practice never uses a test account's readers.
    if !live && policy.production {
        return Ok(Account::Unavailable);
    }
    let payments = hosted::status_account(&binding, &status, policy).is_ok();
    Ok(Account::Ready(
        binding,
        json!({"account_id":id,"livemode":live,"remote_tenant_id":tenant}),
        live,
        payments,
    ))
}
fn query(account: &Value) -> String {
    format!(
        "account_id={}&livemode={}&remote_tenant_id={}",
        account["account_id"].as_str().unwrap_or_default(),
        account["livemode"],
        account["remote_tenant_id"].as_str().unwrap_or_default()
    )
}
/// Only what the screens show: a name, a model and whether the reader is switched on.
fn reader(value: &Value) -> Option<Value> {
    let id = value["id"]
        .as_str()
        .filter(|id| hosted::identifier(id, "tmr_"))?;
    let name = value["label"]
        .as_str()
        .map(|label| {
            label
                .chars()
                .filter(|c| !c.is_control())
                .take(60)
                .collect::<String>()
        })
        .filter(|label| !label.trim().is_empty())
        .unwrap_or_else(|| "Card reader".into());
    Some(json!({
        "id":id,
        "name":name,
        "model":model(value["device_type"].as_str().unwrap_or_default()),
        "online":value["status"]=="online",
        "busy":value["action"]["status"]=="in_progress"
    }))
}
fn model(device: &str) -> &'static str {
    match device.trim_start_matches("simulated_") {
        "bbpos_wisepos_e" | "wisepos_e" => "BBPOS WisePOS E",
        "stripe_s700" => "Stripe Reader S700",
        "stripe_s710" => "Stripe Reader S710",
        "stripe_t600" => "Stripe Reader T600",
        "verifone_P400" => "Verifone P400",
        "bbpos_wisepad3" => "BBPOS WisePad 3",
        "bbpos_chipper2x" => "BBPOS Chipper 2X BT",
        "stripe_m2" => "Stripe Reader M2",
        _ => "Card reader",
    }
}
async fn list_with(state: &State, a: &Actor, broker: &dyn Broker, policy: Policy) -> Result<Value> {
    a.scheduling()?;
    let pool = db(state)?;
    let can_manage = manager(state, a).await.is_ok();
    let (binding, account, live, payments) =
        match account(pool, a.tenant_id, broker, policy).await? {
            Account::Ready(binding, account, live, payments) => (binding, account, live, payments),
            Account::NotConnected => {
                return Ok(json!({"status":"not_connected","readers":[],"can_manage":can_manage}))
            }
            Account::Unavailable => {
                return Ok(json!({"status":"unavailable","readers":[],"can_manage":can_manage}))
            }
        };
    let listed = broker
        .call(
            pool,
            &binding,
            Method::GET,
            &format!("/terminal/readers?{}", query(&account)),
            None,
        )
        .await
        .map_err(|_| unconfirmed())?;
    let readers: Vec<Value> = listed["readers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(reader)
        .collect();
    let mut out = json!({"status":"ready","readers":readers,"can_manage":can_manage,
        "payments_available":payments});
    // Stripe's practice reader exists only in test mode, and is offered only outside production.
    if !live && !policy.production {
        out["practice_code"] = json!("simulated-wpe");
    }
    Ok(out)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Add {
    request_id: Uuid,
    code: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rename {
    name: String,
}
fn name(value: &str) -> Result<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 60 || name.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "Give the reader a name of up to 60 characters.",
        ));
    }
    Ok(name.to_owned())
}
async fn ready(
    state: &State,
    a: &Actor,
    broker: &dyn Broker,
    policy: Policy,
) -> Result<(Binding, Value, bool)> {
    manager(state, a).await?;
    match account(db(state)?, a.tenant_id, broker, policy).await? {
        Account::Ready(binding, account, live, _) => Ok((binding, account, live)),
        _ => Err(Error::Conflict(
            "Finish payment setup before adding a card reader.",
        )),
    }
}
async fn add_with(
    state: &State,
    a: &Actor,
    input: Add,
    broker: &dyn Broker,
    policy: Policy,
) -> Result<Value> {
    let (binding, mut body, live) = ready(state, a, broker, policy).await?;
    let pool = db(state)?;
    let code = input.code.trim().to_ascii_lowercase();
    if code.is_empty()
        || code.len() > 64
        || !code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b' ')
        || input.request_id.is_nil()
        // The practice reader is for test accounts outside production only.
        || (code.starts_with("simulated") && (live || policy.production))
    {
        return Err(Error::Invalid("Enter the code shown on the reader."));
    }
    body["request_id"] = json!(input.request_id);
    body["registration_code"] = json!(code);
    body["label"] = json!(name(&input.name)?);
    let reply = broker
        .reply(
            pool,
            &binding,
            Method::POST,
            "/terminal/readers",
            Some(body),
        )
        .await
        .map_err(|_| unconfirmed())?;
    let added = match (reply.status, reply.code()) {
        (200..=299, _) => reader(&reply.body["reader"]).ok_or_else(unconfirmed)?,
        (400, "registration_code_not_accepted" | "simulated_reader_not_allowed") => {
            return Err(Error::Invalid(
                "That code was not accepted. Check the code on the reader and try again.",
            ))
        }
        (409, "business_address_missing") => {
            return Err(Error::Conflict(
                "Add the practice address to the payment account, then add the reader.",
            ))
        }
        _ => return Err(unconfirmed()),
    };
    let mut tx = pool.begin().await?;
    crate::postgres::audit(&mut tx, a, "payment.reader_added", binding.setting).await?;
    tx.commit().await?;
    Ok(json!({"reader":added}))
}
async fn rename_with(
    state: &State,
    a: &Actor,
    id: &str,
    input: Rename,
    broker: &dyn Broker,
    policy: Policy,
) -> Result<Value> {
    let (binding, mut body, _) = ready(state, a, broker, policy).await?;
    if !hosted::identifier(id, "tmr_") {
        return Err(Error::NotFound);
    }
    let pool = db(state)?;
    body["label"] = json!(name(&input.name)?);
    let reply = broker
        .reply(
            pool,
            &binding,
            Method::POST,
            &format!("/terminal/readers/{id}"),
            Some(body),
        )
        .await
        .map_err(|_| unconfirmed())?;
    let renamed = match reply.status {
        200..=299 => reader(&reply.body["reader"]).ok_or_else(unconfirmed)?,
        404 => return Err(Error::NotFound),
        _ => return Err(unconfirmed()),
    };
    let mut tx = pool.begin().await?;
    crate::postgres::audit(&mut tx, a, "payment.reader_renamed", binding.setting).await?;
    tx.commit().await?;
    Ok(json!({"reader":renamed}))
}
async fn remove_with(
    state: &State,
    a: &Actor,
    id: &str,
    broker: &dyn Broker,
    policy: Policy,
) -> Result<Value> {
    let (binding, account, _) = ready(state, a, broker, policy).await?;
    if !hosted::identifier(id, "tmr_") {
        return Err(Error::NotFound);
    }
    let pool = db(state)?;
    let reply = broker
        .reply(
            pool,
            &binding,
            Method::DELETE,
            &format!("/terminal/readers/{id}?{}", query(&account)),
            None,
        )
        .await
        .map_err(|_| unconfirmed())?;
    match (reply.status, reply.code()) {
        (200..=299, _) => {}
        (404, _) => return Err(Error::NotFound),
        (409, "reader_busy") => {
            return Err(Error::Conflict(
                "This reader is taking a payment. Wait for it to finish, then remove it.",
            ))
        }
        _ => return Err(unconfirmed()),
    }
    let mut tx = pool.begin().await?;
    crate::postgres::audit(&mut tx, a, "payment.reader_removed", binding.setting).await?;
    tx.commit().await?;
    Ok(json!({"removed":true}))
}
fn no_store(value: Value) -> impl axum::response::IntoResponse {
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(value),
    )
}
async fn list(
    a: Actor,
    ExtractState(state): ExtractState<State>,
) -> Result<impl axum::response::IntoResponse> {
    Ok(no_store(
        list_with(&state, &a, &HttpBroker, Policy::current()).await?,
    ))
}
async fn add(
    a: Actor,
    ExtractState(state): ExtractState<State>,
    Json(input): Json<Add>,
) -> Result<impl axum::response::IntoResponse> {
    Ok(no_store(
        add_with(&state, &a, input, &HttpBroker, Policy::current()).await?,
    ))
}
async fn rename(
    a: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<String>,
    Json(input): Json<Rename>,
) -> Result<impl axum::response::IntoResponse> {
    Ok(no_store(
        rename_with(&state, &a, &id, input, &HttpBroker, Policy::current()).await?,
    ))
}
async fn remove(
    a: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<String>,
) -> Result<impl axum::response::IntoResponse> {
    Ok(no_store(
        remove_with(&state, &a, &id, &HttpBroker, Policy::current()).await?,
    ))
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/billing/payments/readers", get(list).post(add))
        .route(
            "/api/v1/billing/payments/readers/{reader}",
            put(rename).delete(remove),
        )
}

#[cfg(test)]
pub(crate) async fn poll_once(pool: &PgPool, broker: &dyn Broker, policy: Policy) -> Result<()> {
    poll(pool, broker, policy).await
}
#[cfg(test)]
#[path = "reader_payments_tests.rs"]
pub(crate) mod tests;
