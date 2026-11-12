// SPDX-License-Identifier: AGPL-3.0-only
//! Finite patient-present checkout against immutable, reviewed native invoices.
use crate::{
    auth::Actor,
    billing,
    copay_checkout::{self as hosted, Binding, Broker, EvidenceBinding, HttpBroker, Policy},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Installment {
    due_on: NaiveDate,
    amount_cents: i64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Preview {
    invoice_id: Uuid,
    livemode: bool,
    installments: Vec<Installment>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Create {
    invoice_id: Uuid,
    livemode: bool,
    installments: Vec<Installment>,
    request_id: Uuid,
    reason: String,
    consent: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Checkout {
    request_id: Uuid,
    amount_cents: i64,
    reason: String,
    patient_present: bool,
}
#[derive(sqlx::FromRow)]
struct Invoice {
    id: Uuid,
    patient_id: Uuid,
    account_id: Uuid,
    account_version: i64,
    snapshot: Value,
    created_at: DateTime<Utc>,
}
#[derive(sqlx::FromRow)]
struct Plan {
    id: Uuid,
    patient_id: Uuid,
    account_id: Uuid,
    invoice_id: Uuid,
    request_id: Uuid,
    creation_hash: String,
    reason: String,
    livemode: bool,
    total_cents: i64,
    responsibility_cents: i64,
    baseline_version: i64,
    account_snapshot: Value,
    ledger_ids: Value,
    schedule: Value,
    version: i64,
    created_at: DateTime<Utc>,
}
#[derive(Clone, sqlx::FromRow)]
struct Attempt {
    tenant_id: Uuid,
    id: Uuid,
    patient_id: Uuid,
    account_id: Uuid,
    plan_id: Uuid,
    installment_number: i32,
    setting_id: Uuid,
    credential_revision: i64,
    installation_id: Uuid,
    provider_account_id: String,
    livemode: bool,
    amount_cents: i64,
    currency: String,
    request_id: Uuid,
    creation_hash: String,
    reason: String,
    return_url: String,
    status: String,
    provider_session_id: Option<String>,
    provider_payment_intent: Option<String>,
    provider_charge_id: Option<String>,
    provider_captured_at: Option<DateTime<Utc>>,
    checkout_url: Option<String>,
    paid_entry_id: Option<Uuid>,
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
    fn evidence(&self) -> EvidenceBinding {
        EvidenceBinding {
            tenant_id: self.tenant_id,
            id: self.id,
            installation_id: self.installation_id,
            provider_account_id: self.provider_account_id.clone(),
            livemode: self.livemode,
            amount_cents: self.amount_cents,
            currency: self.currency.clone(),
            provider_session_id: self.provider_session_id.clone(),
            provider_payment_intent: self.provider_payment_intent.clone(),
            provider_charge_id: self.provider_charge_id.clone(),
            provider_captured_at: self.provider_captured_at,
        }
    }
    fn public(&self, policy: Policy) -> Value {
        json!({"id":self.id,"request_id":self.request_id,"reason":self.reason,"patient_id":self.patient_id,"account_id":self.account_id,"plan_id":self.plan_id,"installment_number":self.installment_number,"amount_cents":self.amount_cents,"currency":self.currency,"livemode":self.livemode,"status":self.status,"checkout_url":if self.status=="open"&&policy.permits(self.livemode){self.checkout_url.as_deref()}else{None},"paid_entry_id":self.paid_entry_id,"captured_at":self.provider_captured_at,"refunded_cents":self.refunded_cents,"unapplied_cents":if self.provider_captured_at.is_some()&&self.paid_entry_id.is_none(){self.amount_cents-self.refunded_cents}else{0},"last_result":self.last_result,"version":self.version,"created_at":self.created_at})
    }
}
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn digest(v: &impl Serialize) -> Result<String> {
    Ok(crate::oauth::hash(&serde_json::to_string(v).map_err(
        |_| Error::Invalid("invalid installment request"),
    )?))
}
fn reason(v: &str) -> Result<()> {
    crate::model::text(v, 1000)
}
fn cents(v: &Value, key: &str) -> Result<i64> {
    v[key]
        .as_i64()
        .filter(|n| (0..=100000000).contains(n))
        .ok_or(Error::Invalid(
            "invoice responsibility evidence is unavailable",
        ))
}
async fn invoice(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    id: Uuid,
) -> Result<Invoice> {
    sqlx::query_as(
        "SELECT * FROM patient_invoice_snapshots WHERE tenant_id=$1 AND patient_id=$2 AND id=$3",
    )
    .bind(a.tenant_id)
    .bind(p)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::NotFound)
}
async fn plan(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: Uuid, id: Uuid) -> Result<Plan> {
    sqlx::query_as("SELECT * FROM patient_installment_plans WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE").bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn attempt(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Attempt> {
    sqlx::query_as(
        "SELECT * FROM invoice_checkout_attempts WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::NotFound)
}
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    plan: Uuid,
    operation: Option<Uuid>,
    action: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO patient_installment_events(tenant_id,id,plan_id,operation_id,actor_id,action) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(plan).bind(operation).bind(a.sub).bind(action).execute(&mut **tx).await?;
    crate::postgres::audit(
        tx,
        a,
        "billing.installment_changed",
        operation.unwrap_or(plan),
    )
    .await
}
// Account revisions retain the structure actually reviewed with the invoice.
fn account_shape(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(o) = v.as_object_mut() {
        o.remove("version");
    }
    v
}
#[derive(sqlx::FromRow)]
struct Entry {
    id: Uuid,
    kind: String,
    content: Value,
    original_kind: Option<String>,
    original_party: Option<String>,
    created_at: DateTime<Utc>,
}
impl Entry {
    fn patient_payment(&self) -> bool {
        let party = if self.kind == "reversal" {
            self.original_party.as_deref()
        } else {
            self.content["party"].as_str()
        };
        party == Some("patient")
            && (self.kind == "payment"
                || (self.kind == "reversal" && self.original_kind.as_deref() == Some("payment"))
                || (self.kind == "adjustment_debit"
                    && [
                        "managed_payment_id",
                        "hosted_copay_operation_id",
                        "invoice_checkout_operation_id",
                    ]
                    .iter()
                    .any(|k| self.content.get(k).is_some_and(|v| !v.is_null()))))
    }
}
async fn entries(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    account: Uuid,
) -> Result<Vec<Entry>> {
    let rows=sqlx::query_as::<_,Entry>("SELECT e.id,e.kind,e.content,e.created_at,o.kind AS original_kind,o.content->>'party' AS original_party FROM billing_entries e LEFT JOIN billing_entries o ON o.tenant_id=e.tenant_id AND o.account_id=e.account_id AND o.id=e.reverses_id WHERE e.tenant_id=$1 AND e.account_id=$2 ORDER BY e.created_at,e.id LIMIT 10001").bind(a.tenant_id).bind(account).fetch_all(&mut **tx).await?;
    if rows.len() > 10000 {
        return Err(Error::Conflict(
            "account history requires a separate review",
        ));
    }
    Ok(rows)
}
struct Balance {
    account: billing::Account,
    credit: i64,
    remaining: i64,
    blocked: Option<&'static str>,
    ledger_ids: Value,
}
async fn balance(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    i: &Invoice,
    p: Option<&Plan>,
    live: bool,
) -> Result<Balance> {
    let account = billing::account_row(tx, a, i.patient_id, i.account_id).await?;
    let responsibility = cents(&i.snapshot, "responsibility_cents")?;
    if i.snapshot["currency"] != "USD" || responsibility > account.total_cents {
        return Err(Error::Conflict(
            "invoice currency or reviewed responsibility requires review",
        ));
    }
    let (credit, _) = billing::patient_ledger_totals(tx, a.tenant_id, i.account_id).await?;
    let rows = entries(tx, a, i.account_id).await?;
    let latest:Uuid=sqlx::query_scalar("SELECT id FROM patient_invoice_snapshots WHERE tenant_id=$1 AND account_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1").bind(a.tenant_id).bind(i.account_id).fetch_one(&mut **tx).await?;
    let baseline = if let Some(p) = p {
        Some(p.account_snapshot.clone())
    } else {
        sqlx::query_scalar::<_,Value>("SELECT snapshot FROM billing_account_revisions WHERE tenant_id=$1 AND account_id=$2 AND version=$3").bind(a.tenant_id).bind(i.account_id).bind(i.account_version).fetch_optional(&mut **tx).await?
    };
    let baseversion = p.map_or(i.account_version, |p| p.baseline_version);
    let account_balance:i64=sqlx::query_scalar("SELECT $3::bigint+coalesce(sum(effect_cents),0)::bigint FROM billing_entries WHERE tenant_id=$1 AND account_id=$2").bind(a.tenant_id).bind(i.account_id).bind(account.total_cents).fetch_one(&mut **tx).await?;
    let additions: Vec<&Entry> = rows
        .iter()
        .filter(|e| {
            if let Some(p) = p {
                !p.ledger_ids
                    .as_array()
                    .is_some_and(|ids| ids.contains(&json!(e.id)))
            } else {
                e.created_at >= i.created_at
                    && !i.snapshot["patient_activity"]
                        .as_array()
                        .is_some_and(|ids| ids.iter().any(|v| v["id"] == e.id.to_string()))
            }
        })
        .collect();
    // Every allowed appended payment increments the account revision once. A
    // structural edit, insurer entry, unexplained revision, or ambiguous legacy
    // timestamp requires a fresh invoice review instead of inferred debt.
    let blocked = if account.status != "posted" {
        Some("Post and review this account before collection.")
    } else if (responsibility - credit).max(0) > account_balance {
        Some("Reviewed patient balance exceeds the posted account balance; review responsibility before collection.")
    } else if latest != i.id {
        Some("A newer patient invoice requires a new reviewed plan.")
    } else if baseline
        .as_ref()
        .is_none_or(|v| account_shape(v) != account_shape(&json!(account)))
        || account.version - baseversion != additions.len() as i64
        || additions.iter().any(|e| !e.patient_payment())
    {
        Some("Account or payer activity changed; review patient responsibility and issue a new invoice.")
    } else if (live && i.snapshot["test_activity"] == true)
        || rows
            .iter()
            .filter(|e| e.patient_payment() && e.kind == "payment")
            .any(|e| e.content["test_mode"].as_bool().unwrap_or(false) == live)
    {
        Some("Test and clinic payment activity cannot be mixed on this invoice.")
    } else {
        None
    };
    Ok(Balance {
        account,
        credit,
        remaining: (responsibility - credit).max(0),
        blocked,
        ledger_ids: json!(rows.iter().map(|r| r.id).collect::<Vec<_>>()),
    })
}
fn validate_schedule(schedule: &[Installment], remaining: i64) -> Result<()> {
    if schedule.is_empty() || schedule.len() > 60 {
        return Err(Error::Invalid("use one to sixty installments"));
    }
    let today = Utc::now().date_naive();
    let mut total = 0i64;
    let mut prior = None;
    for s in schedule {
        if !(50..=100000000).contains(&s.amount_cents)
            || s.due_on < today
            || s.due_on > today + chrono::Duration::days(1826)
            || prior.is_some_and(|p| s.due_on <= p)
        {
            return Err(Error::Invalid("installments require increasing due dates within five years and amounts of at least 50 cents"));
        }
        total = total
            .checked_add(s.amount_cents)
            .ok_or(Error::Invalid("installment amount is too large"))?;
        prior = Some(s.due_on);
    }
    if total != remaining || remaining > 100000000 {
        return Err(Error::Conflict(
            "installments must exactly total the current reviewed patient balance",
        ));
    }
    Ok(())
}
fn preview_value(i: &Invoice, b: &Balance, live: bool, schedule: &[Installment]) -> Value {
    json!({"invoice_id":i.id,"invoice_created_at":i.created_at,"account_id":i.account_id,"account_version":b.account.version,"responsibility_cents":i.snapshot["responsibility_cents"],"patient_credit_cents":b.credit,"remaining_cents":b.remaining,"currency":"usd","livemode":live,"eligible":b.blocked.is_none()&&b.remaining>=50,"blocked_reason":b.blocked.or(if b.remaining<50{Some("No collectible patient balance of at least 50 cents remains.")}else{None}),"installments":schedule.iter().enumerate().map(|(n,s)|json!({"number":n+1,"due_on":s.due_on,"amount_cents":s.amount_cents})).collect::<Vec<_>>(),"autopay":false})
}
async fn preview_with(pool: &PgPool, a: &Actor, p: Uuid, input: &Preview) -> Result<Value> {
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let i = invoice(&mut tx, a, p, input.invoice_id).await?;
    let b = balance(&mut tx, a, &i, None, input.livemode).await?;
    if b.blocked.is_none() {
        validate_schedule(&input.installments, b.remaining)?;
    }
    let out = preview_value(&i, &b, input.livemode, &input.installments);
    crate::postgres::audit(&mut tx, a, "billing.installment_preview", i.id).await?;
    tx.commit().await?;
    Ok(out)
}
async fn create_with(
    pool: &PgPool,
    a: &Actor,
    p: Uuid,
    mut input: Create,
    version: i64,
    policy: Policy,
) -> Result<Value> {
    a.scheduling()?;
    reason(&input.reason)?;
    input.reason = input.reason.trim().to_owned();
    if !input.consent || input.request_id.is_nil() {
        return Err(Error::Invalid(
            "explicit agreement to the finite patient-present schedule is required",
        ));
    }
    let hash = digest(&(p, &input))?;
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    if let Some(prior) = sqlx::query_as::<_, Plan>(
        "SELECT * FROM patient_installment_plans WHERE tenant_id=$1 AND request_id=$2 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(input.request_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        if prior.creation_hash != hash || prior.patient_id != p {
            return Err(Error::Conflict(
                "plan request ID already used with different content",
            ));
        }
        let out = plan_value(&mut tx, a, &prior, policy).await?;
        crate::postgres::audit(&mut tx, a, "billing.installment_replayed", prior.id).await?;
        tx.commit().await?;
        return Ok(out);
    }
    let i = invoice(&mut tx, a, p, input.invoice_id).await?;
    let b = balance(&mut tx, a, &i, None, input.livemode).await?;
    if b.account.version != version {
        return Err(Error::Conflict("account changed; preview the plan again"));
    }
    if let Some(block) = b.blocked {
        return Err(Error::Conflict(block));
    }
    validate_schedule(&input.installments, b.remaining)?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO patient_installment_plans(tenant_id,id,patient_id,account_id,invoice_id,request_id,creation_hash,requested_by,reason,livemode,total_cents,responsibility_cents,baseline_version,account_snapshot,ledger_ids,schedule) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)").bind(a.tenant_id).bind(id).bind(p).bind(i.account_id).bind(i.id).bind(input.request_id).bind(hash).bind(a.sub).bind(input.reason.trim()).bind(input.livemode).bind(b.remaining).bind(cents(&i.snapshot,"responsibility_cents")?).bind(b.account.version).bind(json!(b.account)).bind(b.ledger_ids).bind(json!(input.installments)).execute(&mut *tx).await?;
    event(&mut tx, a, id, None, "plan_agreed").await?;
    let row = plan(&mut tx, a, p, id).await?;
    let out = plan_value(&mut tx, a, &row, policy).await?;
    tx.commit().await?;
    Ok(out)
}
async fn plan_value(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: &Plan,
    policy: Policy,
) -> Result<Value> {
    let i = invoice(tx, a, p.patient_id, p.invoice_id).await?;
    let b = balance(tx, a, &i, Some(p), p.livemode).await?;
    let attempts:Vec<Attempt>=sqlx::query_as("SELECT * FROM invoice_checkout_attempts WHERE tenant_id=$1 AND plan_id=$2 ORDER BY created_at,id LIMIT 1001").bind(a.tenant_id).bind(p.id).fetch_all(&mut **tx).await?;
    if attempts.len() > 1000 {
        return Err(Error::Conflict(
            "installment collection history requires review",
        ));
    }
    let schedule: Vec<Installment> = serde_json::from_value(p.schedule.clone())
        .map_err(|_| Error::Invalid("stored schedule unavailable"))?;
    let review = b.blocked.or(if (1..50).contains(&b.remaining) {
        Some("Remaining patient balance is below the card minimum; review another payment method.")
    } else if attempts.iter().any(|r| r.status == "needs_review") {
        Some("A collection needs review before further payment.")
    } else {
        None
    });
    let installments:Vec<Value>=schedule.iter().enumerate().map(|(n,s)|{let collected=attempts.iter().filter(|r|r.installment_number==n as i32+1&&r.provider_captured_at.is_some()).map(|r|r.amount_cents-r.refunded_cents).sum::<i64>();let collectible=(s.amount_cents-collected).max(0).min(b.remaining);json!({"number":n+1,"due_on":s.due_on,"amount_cents":s.amount_cents,"collected_cents":collected,"collectible_cents":collectible,"status":if collectible==0{"complete"}else{"pending"}})}).collect();
    Ok(
        json!({"id":p.id,"request_id":p.request_id,"reason":p.reason,"patient_id":p.patient_id,"account_id":p.account_id,"invoice_id":p.invoice_id,"version":p.version,"status":if review.is_some(){"needs_review"}else if b.remaining==0{"complete"}else{"active"},"livemode":p.livemode,"total_cents":p.total_cents,"responsibility_cents":p.responsibility_cents,"patient_credit_cents":b.credit,"remaining_cents":b.remaining,"blocked_reason":review,"installments":installments,"attempts":attempts.iter().map(|v|v.public(policy)).collect::<Vec<_>>(),"created_at":p.created_at,"autopay":false}),
    )
}
#[allow(clippy::too_many_arguments)]
async fn checkout_with(
    pool: &PgPool,
    a: &Actor,
    patient: Uuid,
    plan_id: Uuid,
    number: i32,
    mut input: Checkout,
    version: i64,
    origin: &str,
    broker: &dyn Broker,
    policy: Policy,
) -> Result<Value> {
    a.scheduling()?;
    reason(&input.reason)?;
    input.reason = input.reason.trim().to_owned();
    if !input.patient_present || input.request_id.is_nil() {
        return Err(Error::Invalid(
            "the patient must be present and agree to this payment",
        ));
    }
    let hash = digest(&(patient, plan_id, number, &input))?;
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let p = plan(&mut tx, a, patient, plan_id).await?;
    if !policy.permits(p.livemode) {
        return Err(Error::Conflict("invoice collection is unavailable for this payment mode; support activation is required for live collection"));
    }
    if let Some(prior) = sqlx::query_as::<_, Attempt>(
        "SELECT * FROM invoice_checkout_attempts WHERE tenant_id=$1 AND request_id=$2 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(input.request_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        if prior.creation_hash != hash {
            return Err(Error::Conflict(
                "checkout request ID already used with different content",
            ));
        }
        tx.commit().await?;
        process(pool, a, prior.id, broker, policy, true).await?;
        return checkout_result(pool, a, patient, plan_id, prior.id, policy).await;
    }
    tx.commit().await?;
    // Provider readiness is read outside the financial transaction. The local
    // settings revision is checked again before reserving this exact attempt.
    let binding = hosted::current_binding(pool, a.tenant_id, broker).await?;
    let status = broker
        .call(pool, &binding, Method::GET, "/status", None)
        .await?;
    let (provider_account,mode)=hosted::status_account(&binding,&status,policy).map_err(|_|Error::Conflict("invoice card collection is unavailable; review the connected account and payment mode"))?;
    if mode != p.livemode {
        return Err(Error::Conflict(
            "connected payment account mode does not match this plan",
        ));
    }
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let p = plan(&mut tx, a, patient, plan_id).await?;
    let unchanged:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM payment_settings WHERE tenant_id=$1 AND id=$2 AND credential_revision=$3 AND mode='suncharts_connect')").bind(a.tenant_id).bind(binding.setting).bind(binding.revision).fetch_one(&mut *tx).await?;
    if !unchanged {
        return Err(Error::Conflict(
            "payment binding changed; reload before collection",
        ));
    }
    if let Some(prior) = sqlx::query_as::<_, Attempt>(
        "SELECT * FROM invoice_checkout_attempts WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(input.request_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        if prior.creation_hash != hash {
            return Err(Error::Conflict("checkout request ID already used"));
        }
        tx.commit().await?;
        return checkout_result(pool, a, patient, plan_id, prior.id, policy).await;
    }
    if p.version != version {
        return Err(Error::Conflict("plan changed; reload before collection"));
    }
    let i = invoice(&mut tx, a, patient, p.invoice_id).await?;
    let b = balance(&mut tx, a, &i, Some(&p), p.livemode).await?;
    if let Some(block) = b.blocked {
        return Err(Error::Conflict(block));
    }
    let schedule: Vec<Installment> = serde_json::from_value(p.schedule.clone())
        .map_err(|_| Error::Invalid("stored schedule unavailable"))?;
    let step = number
        .checked_sub(1)
        .and_then(|n| schedule.get(n as usize))
        .ok_or(Error::NotFound)?;
    let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM invoice_checkout_attempts WHERE tenant_id=$1 AND account_id=$2 AND status IN ('creating','open','needs_review')) OR EXISTS(SELECT 1 FROM payment_attempts WHERE tenant_id=$1 AND account_id=$2 AND (status IN ('creating','open') AND paid_entry_id IS NULL OR status='needs_review')) OR EXISTS(SELECT 1 FROM copay_checkout_attempts c JOIN visits v ON v.tenant_id=c.tenant_id AND v.appointment_id=c.appointment_id JOIN billing_accounts b ON b.tenant_id=v.tenant_id AND b.visit_id=v.id WHERE b.tenant_id=$1 AND b.id=$2 AND (c.status IN ('creating','open') AND c.receipt_id IS NULL OR c.status='needs_review'))").bind(a.tenant_id).bind(p.account_id).fetch_one(&mut *tx).await?;
    if pending {
        return Err(Error::Conflict(
            "reconcile the existing collection before starting another",
        ));
    }
    let collected:i64=sqlx::query_scalar("SELECT coalesce(sum(amount_cents-refunded_cents),0)::bigint FROM invoice_checkout_attempts WHERE tenant_id=$1 AND plan_id=$2 AND installment_number=$3 AND provider_captured_at IS NOT NULL").bind(a.tenant_id).bind(plan_id).bind(number).fetch_one(&mut *tx).await?;
    let amount = (step.amount_cents - collected).max(0).min(b.remaining);
    if input.amount_cents != amount {
        return Err(Error::Conflict(
            "collectible amount changed; reload and confirm the exact payment amount",
        ));
    }
    if amount < 50 {
        return Err(Error::Conflict(
            "no collectible installment balance of at least 50 cents remains",
        ));
    }
    let id = Uuid::new_v4();
    let return_url = format!("{}/?invoice_checkout={id}", origin.trim_end_matches('/'));
    sqlx::query("INSERT INTO invoice_checkout_attempts(tenant_id,id,patient_id,account_id,plan_id,installment_number,setting_id,credential_revision,installation_id,provider_account_id,livemode,amount_cents,request_id,creation_hash,requested_by,reason,return_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)").bind(a.tenant_id).bind(id).bind(patient).bind(p.account_id).bind(p.id).bind(number).bind(binding.setting).bind(binding.revision).bind(binding.installation).bind(provider_account).bind(mode).bind(amount).bind(input.request_id).bind(hash).bind(a.sub).bind(input.reason.trim()).bind(return_url).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE patient_installment_plans SET version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(p.id)
    .execute(&mut *tx)
    .await?;
    event(
        &mut tx,
        a,
        p.id,
        Some(id),
        "collection_reserved_patient_present",
    )
    .await?;
    tx.commit().await?;
    process(pool, a, id, broker, policy, true).await?;
    checkout_result(pool, a, patient, plan_id, id, policy).await
}
async fn checkout_result(
    pool: &PgPool,
    a: &Actor,
    patient: Uuid,
    pid: Uuid,
    id: Uuid,
    policy: Policy,
) -> Result<Value> {
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let p = plan(&mut tx, a, patient, pid).await?;
    let r = attempt(&mut tx, a, id).await?;
    let out = json!({"plan":plan_value(&mut tx,a,&p,policy).await?,"operation":r.public(policy)});
    crate::postgres::audit(&mut tx, a, "billing.installment_read", pid).await?;
    tx.commit().await?;
    Ok(out)
}
async fn ledger(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Attempt,
    effect: i64,
    refund: bool,
    when: NaiveDate,
) -> Result<Uuid> {
    let id = Uuid::new_v4();
    let content = json!({"party":"patient","method":"card","reference":r.provider_charge_id,"occurred_on":when,"invoice_checkout_operation_id":r.id,"plan_id":r.plan_id,"test_mode":!r.livemode,"reason":if refund{"Verified invoice payment refund"}else{"Verified patient-present installment"}});
    sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6,$2,$7,$8)").bind(a.tenant_id).bind(id).bind(r.account_id).bind(if refund{"adjustment_debit"}else{"payment"}).bind(effect).bind(&content).bind(digest(&content)?).bind(a.sub).execute(&mut **tx).await?;
    sqlx::query("UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(r.account_id)
        .execute(&mut **tx)
        .await?;
    billing::account_revision(
        tx,
        a,
        r.patient_id,
        r.account_id,
        if refund {
            "Verified invoice refund"
        } else {
            "Verified installment payment"
        },
    )
    .await?;
    Ok(id)
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
    let mut r = attempt(&mut tx, a, id).await?;
    if r.lease_id != Some(lease) {
        return Ok(());
    }
    if !policy.permits(r.livemode) {
        return Err(Error::Conflict(
            "invoice reconciliation is unavailable for this payment mode",
        ));
    }
    let v = hosted::verify_bound(&r.evidence(), value)?;
    if (r.provider_captured_at.is_some() && !v.paid)
        || (r.status == "expired" && !v.expired)
        || v.refunded < r.refunded_cents
    {
        return Err(Error::Conflict(
            "payment evidence would reverse a confirmed state",
        ));
    }
    let p = plan(&mut tx, a, r.patient_id, r.plan_id).await?;
    let mut held = false;
    let mut paid_entry = r.paid_entry_id;
    if v.paid && r.provider_captured_at.is_none() {
        let duplicate:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM copay_checkout_attempts WHERE tenant_id=$1 AND provider_account_id=$2 AND livemode=$3 AND (provider_charge_id=$4 OR provider_payment_intent=$5)) OR EXISTS(SELECT 1 FROM payment_attempts WHERE tenant_id=$1 AND provider_account_id=$2 AND (provider_charge_id=$4 OR provider_payment_intent=$5))").bind(a.tenant_id).bind(&r.provider_account_id).bind(r.livemode).bind(&v.charge).bind(&v.intent).fetch_one(&mut *tx).await?;
        if duplicate {
            return Err(Error::Conflict(
                "processor payment already belongs to another collection",
            ));
        }
        let i = invoice(&mut tx, a, r.patient_id, p.invoice_id).await?;
        let b = balance(&mut tx, a, &i, Some(&p), r.livemode).await?;
        let account_balance:i64=sqlx::query_scalar("SELECT $3::bigint+coalesce(sum(effect_cents),0)::bigint FROM billing_entries WHERE tenant_id=$1 AND account_id=$2").bind(a.tenant_id).bind(r.account_id).bind(b.account.total_cents).fetch_one(&mut *tx).await?;
        held =
            b.blocked.is_some() || b.remaining < r.amount_cents || account_balance < r.amount_cents;
        r.provider_charge_id = v.charge.clone();
        if !held {
            paid_entry = Some(
                ledger(
                    &mut tx,
                    a,
                    &r,
                    -r.amount_cents,
                    false,
                    v.captured_at
                        .ok_or(Error::Invalid("capture time missing"))?
                        .date_naive(),
                )
                .await?,
            );
        }
    }
    if v.paid && v.refunded > r.refunded_cents {
        let delta = v.refunded - r.refunded_cents;
        let entry = if paid_entry.is_some() {
            Some(ledger(&mut tx, a, &r, delta, true, Utc::now().date_naive()).await?)
        } else {
            None
        };
        sqlx::query("INSERT INTO invoice_checkout_refunds(tenant_id,operation_id,cumulative_cents,delta_cents,entry_id,actor_id) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(v.refunded).bind(delta).bind(entry).bind(a.sub).execute(&mut *tx).await?;
    }
    // An already held capture stays held even if a later edit makes room. Applying
    // it needs an explicit reviewed allocation workflow, not a polling side effect.
    held |= v.paid && paid_entry.is_none() && v.refunded < r.amount_cents;
    let status = if v.paid && v.refunded == r.amount_cents {
        "refunded"
    } else if held {
        "needs_review"
    } else if v.paid {
        "paid"
    } else if v.expired {
        "expired"
    } else {
        "open"
    };
    sqlx::query("UPDATE invoice_checkout_attempts SET status=$3,provider_session_id=$4,provider_payment_intent=coalesce(provider_payment_intent,$5),provider_charge_id=coalesce(provider_charge_id,$6),provider_captured_at=coalesce(provider_captured_at,$7),checkout_url=$8,paid_entry_id=$9,refunded_cents=$10,version=version+1,updated_at=now(),lease_id=NULL,lease_until=NULL,last_result=$11,next_poll_at=now()+CASE WHEN $3 IN ('paid','needs_review') THEN interval '1 hour' ELSE interval '30 seconds' END WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(status).bind(v.session).bind(v.intent).bind(v.charge).bind(v.captured_at).bind(if status=="open"{v.url}else{None}).bind(paid_entry).bind(v.refunded).bind(if held{"captured_unapplied_review_required"}else{"provider_verified"}).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE patient_installment_plans SET version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(p.id)
    .execute(&mut *tx)
    .await?;
    event(&mut tx, a, p.id, Some(id), "provider_evidence_verified").await?;
    tx.commit().await?;
    Ok(())
}
async fn fail(pool: &PgPool, a: &Actor, id: Uuid, lease: Uuid, review: bool) -> Result<()> {
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let r = attempt(&mut tx, a, id).await?;
    if r.lease_id != Some(lease) {
        return Ok(());
    }
    sqlx::query("UPDATE invoice_checkout_attempts SET status=CASE WHEN $4 THEN 'needs_review' ELSE status END,last_result=CASE WHEN $4 THEN 'provider_evidence_needs_review' ELSE 'provider_retry_pending' END,lease_id=NULL,lease_until=NULL,version=version+1,updated_at=now(),next_poll_at=now()+CASE WHEN $4 THEN interval '15 minutes' ELSE interval '1 minute' END WHERE tenant_id=$1 AND id=$2 AND lease_id=$3").bind(a.tenant_id).bind(id).bind(lease).bind(review).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE patient_installment_plans SET version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(r.plan_id)
    .execute(&mut *tx)
    .await?;
    event(
        &mut tx,
        a,
        r.plan_id,
        Some(id),
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
async fn process(
    pool: &PgPool,
    a: &Actor,
    id: Uuid,
    broker: &dyn Broker,
    policy: Policy,
    allow_create: bool,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let r = attempt(&mut tx, a, id).await?;
    if !policy.permits(r.livemode)
        || ["expired", "refunded"].contains(&r.status.as_str())
        || (!allow_create && r.provider_session_id.is_none())
    {
        return Ok(());
    }
    let lease = Uuid::new_v4();
    let changed=sqlx::query("UPDATE invoice_checkout_attempts SET lease_id=$3,lease_until=now()+interval '2 minutes',attempts=attempts+1,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND (lease_until IS NULL OR lease_until<now())").bind(a.tenant_id).bind(id).bind(lease).execute(&mut *tx).await?.rows_affected();
    if changed == 0 {
        return Ok(());
    }
    event(&mut tx, a, r.plan_id, Some(id), "provider_poll_started").await?;
    tx.commit().await?;
    let binding = r.binding();
    let fetched = broker
        .call(
            pool,
            &binding,
            Method::GET,
            &r.provider_session_id
                .as_ref()
                .map(|s| format!("/hosted-checkouts/{s}"))
                .unwrap_or(format!("/hosted-checkout-requests/{}", r.id)),
            None,
        )
        .await;
    let can_create = allow_create && r.created_at > Utc::now() - chrono::Duration::hours(23);
    let value = match fetched {
        Ok(v) if v.get("session") == Some(&Value::Null) => {
            let safe = v["retry_safe_until"]
                .as_str()
                .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
                .is_some_and(|v| v > Utc::now());
            if hosted::envelope_bound(&r.evidence(), &v).is_err()
                || !can_create
                || r.provider_session_id.is_some()
                || !safe
                || v["recovery_required"] != false
            {
                fail(pool, a, id, lease, true).await?;
                return Ok(());
            }
            None
        }
        Ok(v) => Some(v),
        Err(Error::NotFound) if r.provider_session_id.is_none() && can_create => None,
        Err(Error::NotFound) => {
            fail(pool, a, id, lease, true).await?;
            return Ok(());
        }
        Err(_) => {
            fail(pool, a, id, lease, false).await?;
            return Ok(());
        }
    };
    let value = if let Some(v) = value {
        v
    } else {
        // A lost response may be recovered by GET even if responsibility changed;
        // only a new/retried provider creation requires the current financial guard.
        let mut tx = pool.begin().await?;
        billing::tenant_lock(&mut tx, a).await?;
        let p = plan(&mut tx, a, r.patient_id, r.plan_id).await?;
        let i = invoice(&mut tx, a, r.patient_id, p.invoice_id).await?;
        let b = balance(&mut tx, a, &i, Some(&p), r.livemode).await?;
        let safe = b.blocked.is_none() && b.remaining >= r.amount_cents;
        tx.commit().await?;
        if !safe {
            fail(pool, a, id, lease, true).await?;
            return Ok(());
        }
        match broker.call(pool,&binding,Method::POST,"/hosted-checkouts",Some(json!({"request_id":r.id,"amount_cents":r.amount_cents,"currency":r.currency,"return_url":r.return_url,"account_id":r.provider_account_id,"livemode":r.livemode}))).await{Ok(v)=>v,Err(_)=>{fail(pool,a,id,lease,false).await?;return Ok(())}}
    };
    let evidence_binding = r.evidence();
    let session = match hosted::envelope_bound(&evidence_binding, &value)
        .ok()
        .and_then(|s| s["id"].as_str())
        .filter(|s| hosted::identifier(s, if r.livemode { "cs_live_" } else { "cs_test_" }))
    {
        Some(s) => s,
        None => {
            fail(pool, a, id, lease, true).await?;
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
            fail(pool, a, id, lease, false).await?;
            return Ok(());
        }
    };
    if apply(pool, a, id, lease, &evidence, policy).await.is_err() {
        fail(pool, a, id, lease, true).await?
    }
    Ok(())
}
async fn authorize(s: &State, a: &Actor, action: &str) -> Result<()> {
    if action != "view" {
        a.scheduling()?
    } else {
        a.staff()?
    }
    crate::access_policies::require_native(s, a, "billing", action).await
}
async fn detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((patient, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    authorize(&s, &a, "view").await?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let p = plan(&mut tx, &a, patient, id).await?;
    let out = plan_value(&mut tx, &a, &p, Policy::current()).await?;
    crate::postgres::audit(&mut tx, &a, "billing.installment_read", id).await?;
    tx.commit().await?;
    Ok(Json(out))
}
async fn list(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(patient): Path<Uuid>,
) -> Result<Json<Value>> {
    authorize(&s, &a, "view").await?;
    let pool = db(&s)?;
    let policy = Policy::current();
    let availability = if policy.production && !policy.live_enabled {
        json!({"available":false,"livemode":null,"reason":"Live invoice collection requires support activation. The plan does not enable automatic payments."})
    } else {
        let ready = async {
            let b = hosted::current_binding(pool, a.tenant_id, &HttpBroker).await?;
            let v = HttpBroker
                .call(pool, &b, Method::GET, "/status", None)
                .await?;
            hosted::status_account(&b, &v, policy)
        }
        .await;
        match ready {
            Ok((_, live)) => json!({"available":true,"livemode":live,"reason":null}),
            Err(_) => {
                json!({"available":false,"livemode":null,"reason":"Review connected card account readiness and payment mode before collection."})
            }
        }
    };
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(patient)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let rows:Vec<Plan>=sqlx::query_as("SELECT * FROM patient_installment_plans WHERE tenant_id=$1 AND patient_id=$2 ORDER BY created_at DESC,id LIMIT 101").bind(a.tenant_id).bind(patient).fetch_all(&mut *tx).await?;
    if rows.len() > 100 {
        return Err(Error::Conflict(
            "plan history exceeds the supported preview; contact support",
        ));
    }
    let mut items = Vec::new();
    for p in rows {
        items.push(plan_value(&mut tx, &a, &p, policy).await?);
    }
    let invoices:Vec<Invoice>=sqlx::query_as("SELECT DISTINCT ON(account_id) * FROM patient_invoice_snapshots WHERE tenant_id=$1 AND patient_id=$2 ORDER BY account_id,created_at DESC,id DESC LIMIT 101").bind(a.tenant_id).bind(patient).fetch_all(&mut *tx).await?;
    if invoices.len() > 100 {
        return Err(Error::Conflict(
            "invoice history exceeds the supported preview",
        ));
    }
    let mut eligible = Vec::new();
    for i in invoices {
        let live = availability["livemode"]
            .as_bool()
            .unwrap_or(i.snapshot["test_activity"] != true);
        let b = balance(&mut tx, &a, &i, None, live).await?;
        let mut v = preview_value(&i, &b, live, &[]);
        if let Some(existing) = items.iter().find(|p| p["invoice_id"] == i.id.to_string()) {
            v["existing_plan_id"] = existing["id"].clone();
            v["eligible"] = json!(false);
            v["blocked_reason"] = json!("This invoice already has an immutable installment plan.");
        }
        eligible.push(v);
    }
    crate::postgres::audit(&mut tx, &a, "billing.installment_read", patient).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":items,"eligible_invoices":eligible,"availability":availability}),
    ))
}
async fn preview(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(patient): Path<Uuid>,
    Json(input): Json<Preview>,
) -> Result<Json<Value>> {
    authorize(&s, &a, "edit").await?;
    Ok(Json(preview_with(db(&s)?, &a, patient, &input).await?))
}
async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(patient): Path<Uuid>,
    h: HeaderMap,
    Json(input): Json<Create>,
) -> Result<Json<Value>> {
    authorize(&s, &a, "create").await?;
    Ok(Json(
        create_with(
            db(&s)?,
            &a,
            patient,
            input,
            crate::expected(&h)?,
            Policy::current(),
        )
        .await?,
    ))
}
fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE,Json(json!({"error":"collection_unavailable","message":"Invoice card collection is unavailable in this payment mode. Live collection requires support activation; no payment has been created."}))).into_response()
}
async fn checkout(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((patient, pid, number)): Path<(Uuid, Uuid, i32)>,
    h: HeaderMap,
    Json(input): Json<Checkout>,
) -> Result<Response> {
    authorize(&s, &a, "create").await?;
    let policy = Policy::current();
    let mut tx = db(&s)?.begin().await?;
    let p = plan(&mut tx, &a, patient, pid).await?;
    tx.commit().await?;
    if !policy.permits(p.livemode) {
        return Ok(unavailable());
    }
    Ok(Json(
        checkout_with(
            db(&s)?,
            &a,
            patient,
            pid,
            number,
            input,
            crate::expected(&h)?,
            s.browser.as_ref().ok_or(Error::NotFound)?.origin(),
            &HttpBroker,
            policy,
        )
        .await?,
    )
    .into_response())
}
async fn operation_with(s: &State, a: &Actor, id: Uuid) -> Result<Value> {
    authorize(s, a, "view").await?;
    let mut tx = db(s)?.begin().await?;
    let r = attempt(&mut tx, a, id).await?;
    crate::postgres::audit(&mut tx, a, "billing.invoice_checkout_read", id).await?;
    tx.commit().await?;
    Ok(json!({"operation":r.public(Policy::current())}))
}
async fn operation(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    Ok(Json(operation_with(&s, &a, id).await?))
}
async fn refresh(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    authorize(&s, &a, "edit").await?;
    let value = operation_with(&s, &a, id).await?;
    let mode = value["operation"]["livemode"]
        .as_bool()
        .ok_or(Error::NotFound)?;
    if !Policy::current().permits(mode) {
        return Ok(unavailable());
    }
    process(db(&s)?, &a, id, &HttpBroker, Policy::current(), false).await?;
    Ok(Json(operation_with(&s, &a, id).await?).into_response())
}
pub fn router() -> Router<State> {
    Router::new()
 .route("/api/v1/billing/patients/{patient}/installment-plans",get(list).post(create))
 .route("/api/v1/billing/patients/{patient}/installment-plans/preview",post(preview))
 .route("/api/v1/billing/patients/{patient}/installment-plans/{plan}",get(detail))
 .route("/api/v1/billing/patients/{patient}/installment-plans/{plan}/installments/{number}/checkout",post(checkout))
 .route("/api/v1/billing/invoice-checkouts/{id}",get(operation))
 .route("/api/v1/billing/invoice-checkouts/{id}/refresh",post(refresh))
}
async fn poll(pool: &PgPool, broker: &dyn Broker, policy: Policy) -> Result<()> {
    let due:Vec<(Uuid,Uuid)>=sqlx::query_as("SELECT tenant_id,id FROM invoice_checkout_attempts WHERE status NOT IN ('expired','refunded') AND ((livemode AND $1) OR (NOT livemode AND $2)) AND next_poll_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_poll_at LIMIT 20").bind(policy.live_enabled).bind(!policy.production).fetch_all(pool).await?;
    for (tenant, id) in due {
        let _ = process(
            pool,
            &crate::delivery::worker(tenant),
            id,
            broker,
            policy,
            true,
        )
        .await;
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
#[path = "installments_tests.rs"]
mod tests;
