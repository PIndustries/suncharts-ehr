// SPDX-License-Identifier: AGPL-3.0-only
//! Reconcile a locally verified patient balance with a tracked Connect invoice draft.
use crate::{
    auth::Actor,
    billing::{self, Account},
    copay_checkout::{self as connect, Binding, Broker, Policy},
    error::{Error, Result},
    visit_billing::{self, Options, STATEMENT_REASON},
};
use axum::http::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::time::Duration;
use uuid::Uuid;

const REVIEW_AFTER_FAILURES: i32 = 3;
const ENABLED_ENV: &str = "ENGINE_AUTOMATIC_PATIENT_INVOICES_ENABLED";

fn enabled() -> bool {
    configured(std::env::var(ENABLED_ENV).ok().as_deref())
}

fn configured(value: Option<&str>) -> bool {
    value == Some("true")
}

pub(crate) async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    account: &Account,
) -> Result<()> {
    enqueue_if_enabled(tx, a, account, enabled()).await
}

async fn enqueue_if_enabled(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    account: &Account,
    enabled: bool,
) -> Result<()> {
    if !enabled || account.status != "posted" || account.source_history_id.is_some() {
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO automatic_patient_invoice_jobs (tenant_id,account_id,patient_id)
         SELECT $1,$2,$3 WHERE EXISTS (
             SELECT 1 FROM payment_settings WHERE tenant_id=$1 AND mode='suncharts_connect'
         ) OR EXISTS (
             SELECT 1 FROM automatic_patient_invoice_operations
             WHERE tenant_id=$1 AND account_id=$2 AND closed_at IS NULL
         )
         ON CONFLICT (tenant_id,account_id) DO UPDATE
         SET generation=automatic_patient_invoice_jobs.generation+1,next_attempt_at=now()",
    )
    .bind(a.tenant_id)
    .bind(account.id)
    .bind(account.patient_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Job {
    tenant_id: Uuid,
    account_id: Uuid,
    patient_id: Uuid,
    generation: i64,
}

#[derive(sqlx::FromRow)]
struct Operation {
    tenant_id: Uuid,
    account_id: Uuid,
    patient_id: Uuid,
    native_invoice_id: Uuid,
    account_version: i64,
    request_id: Uuid,
    amount_cents: i64,
    patient_payment_cents: i64,
    setting_id: Uuid,
    credential_revision: i64,
    installation_id: Uuid,
    stripe_account_id: String,
    livemode: bool,
    stripe_invoice_id: Option<String>,
    creation_attempted: bool,
}

impl Operation {
    fn binding(&self) -> Binding {
        Binding {
            tenant: self.tenant_id,
            setting: self.setting_id,
            revision: self.credential_revision,
            installation: self.installation_id,
        }
    }
    fn path(&self) -> String {
        format!("/patient-billing/{}/invoices", self.patient_id)
    }
    fn status_path(&self) -> String {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query.append_pair("remote_tenant_id", &self.tenant_id.to_string());
        query.append_pair("account_id", &self.stripe_account_id);
        query.append_pair("livemode", if self.livemode { "true" } else { "false" });
        format!("{}/{}?{}", self.path(), self.request_id, query.finish())
    }
}

#[derive(Clone, Copy)]
struct Due {
    cents: i64,
    patient_payment_cents: i64,
}

fn due(summary: &Value) -> Option<Due> {
    if summary["account"]["status"] != "posted" {
        return None;
    }
    let patient = &summary["patient"];
    if patient["receipt_needs_review"] == true {
        return None;
    }
    if summary["insurance"]["insured"].as_bool()?
        && (summary["insurance"]["status"] != "answered"
            || summary["claim"]["status"] != "adjudicated"
            || summary["claim"]["answer"]["denied"] != false
            || matches!(
                summary["state"].as_str(),
                Some("correct_claim" | "post_response" | "denied")
            )
            || !matches!(
                patient["responsibility_source"].as_str(),
                Some("insurer_response" | "reviewed_statement")
            ))
    {
        return None;
    }
    // A write-off or responsibility correction can close an obsolete invoice, but it isn't a
    // payment. Count only recorded patient collections when deciding whether to mark it paid.
    let payment =
        patient["other_payments_cents"].as_i64()? + patient["receipts_applied_cents"].as_i64()?;
    Some(Due {
        cents: patient["owes_now_cents"].as_i64()?,
        patient_payment_cents: payment,
    })
}

pub(crate) async fn current_status(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    account: &Account,
    summary: &Value,
) -> Result<Option<Value>> {
    let status = sqlx::query_scalar(
        "SELECT CASE WHEN EXISTS (
             SELECT 1 FROM automatic_patient_invoice_jobs WHERE tenant_id=$1 AND account_id=$2
             AND patient_id=$3 AND consecutive_failures >= $6
         ) OR EXISTS (
             SELECT 1 FROM automatic_patient_invoice_operations WHERE tenant_id=$1 AND account_id=$2
             AND patient_id=$3 AND closed_at IS NULL AND status='needs_review'
         ) THEN jsonb_build_object('status','needs_review') ELSE (
         SELECT jsonb_build_object('invoice_id',native_invoice_id,'status',status,
            'amount_cents',amount_cents,'livemode',livemode)
         FROM automatic_patient_invoice_operations i WHERE tenant_id=$1 AND account_id=$2
         AND patient_id=$3 AND (account_version=$4 AND amount_cents=$5 AND EXISTS (
            SELECT 1 FROM payment_settings s WHERE s.tenant_id=i.tenant_id
             AND s.id=i.setting_id AND s.credential_revision=i.credential_revision
             AND s.mode='suncharts_connect'
         ) OR ($5=0 AND status='paid'))
         ORDER BY created_at DESC,request_id LIMIT 1) END",
    )
    .bind(a.tenant_id)
    .bind(account.id)
    .bind(account.patient_id)
    .bind(account.version)
    .bind(due(summary).map(|due| due.cents))
    .bind(REVIEW_AFTER_FAILURES)
    .fetch_one(&mut **tx)
    .await?;
    Ok(status)
}

async fn current(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    job: &Job,
) -> Result<(Account, Option<Due>)> {
    let account = billing::account_row(tx, a, job.patient_id, job.account_id).await?;
    if account.source_history_id.is_some() || account.status != "posted" {
        return Ok((account, None));
    }
    let summary = visit_billing::summarize(
        tx,
        a,
        job.patient_id,
        None,
        Some(job.account_id),
        Options {
            claims: true,
            ..Options::default()
        },
    )
    .await?;
    Ok((account, due(&summary)))
}

#[derive(Deserialize)]
struct Evidence {
    installation_id: Uuid,
    remote_tenant_id: Uuid,
    external_patient_ref: Uuid,
    stripe_account_id: String,
    livemode: bool,
    request_id: Uuid,
    native_account_id: Uuid,
    native_invoice_id: Uuid,
    stripe_invoice_id: String,
    status: String,
    amount_due: i64,
    amount_paid: i64,
    amount_remaining: i64,
    currency: String,
}

fn evidence(op: &Operation, response: Value) -> Result<Evidence> {
    let evidence: Evidence = serde_json::from_value(response)
        .map_err(|_| Error::Invalid("Connect invoice evidence is incomplete"))?;
    let obsolete = matches!(evidence.status.as_str(), "void" | "uncollectible");
    let amount_matches =
        evidence.amount_due == op.amount_cents || (obsolete && evidence.amount_due == 0);
    if evidence.installation_id != op.installation_id
        || evidence.remote_tenant_id != op.tenant_id
        || evidence.external_patient_ref != op.patient_id
        || evidence.stripe_account_id != op.stripe_account_id
        || evidence.livemode != op.livemode
        || evidence.request_id != op.request_id
        || evidence.native_account_id != op.account_id
        || evidence.native_invoice_id != op.native_invoice_id
        || !connect::identifier(&evidence.stripe_invoice_id, "in_")
        || op
            .stripe_invoice_id
            .as_ref()
            .is_some_and(|id| id != &evidence.stripe_invoice_id)
        || evidence.currency != "usd"
        || !amount_matches
        || !(0..=op.amount_cents).contains(&evidence.amount_paid)
        || !(0..=op.amount_cents).contains(&evidence.amount_remaining)
        || (!obsolete && evidence.amount_paid + evidence.amount_remaining != op.amount_cents)
        || !matches!(
            evidence.status.as_str(),
            "draft" | "open" | "paid" | "void" | "uncollectible"
        )
    {
        return Err(Error::Conflict(
            "Connect invoice evidence does not match this account",
        ));
    }
    Ok(evidence)
}

async fn reserve(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    account: &Account,
    due: Due,
    binding: Binding,
    stripe_account_id: String,
    livemode: bool,
) -> Result<Option<Operation>> {
    let eligible: bool = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM payment_settings WHERE tenant_id=$1 AND id=$2
             AND credential_revision=$3 AND mode='suncharts_connect'
         ) AND NOT EXISTS(
             SELECT 1 FROM automatic_patient_invoice_operations WHERE tenant_id=$1
             AND account_id=$4 AND account_version=$5 AND amount_cents=$6
             AND setting_id=$2 AND credential_revision=$3 AND livemode=$7 AND stripe_account_id=$8
         ) AND NOT ($7 AND EXISTS(
             SELECT 1 FROM billing_entries WHERE tenant_id=$1 AND account_id=$4
             AND content->>'test_mode'='true'
         ))",
    )
    .bind(a.tenant_id)
    .bind(binding.setting)
    .bind(binding.revision)
    .bind(account.id)
    .bind(account.version)
    .bind(due.cents)
    .bind(livemode)
    .bind(&stripe_account_id)
    .fetch_one(&mut **tx)
    .await?;
    if !eligible {
        return Ok(None);
    }
    let invoice: Option<Uuid> = sqlx::query_scalar(
        "SELECT i.id FROM patient_invoice_snapshots i WHERE i.tenant_id=$1 AND i.patient_id=$2
         AND i.account_id=$3 AND i.account_version=$4 AND i.snapshot->'amount_due_cents'=to_jsonb($5::bigint)
         AND NOT EXISTS (SELECT 1 FROM automatic_patient_invoice_operations op
             WHERE op.tenant_id=i.tenant_id AND op.native_invoice_id=i.id)
         ORDER BY i.created_at DESC,i.id LIMIT 1",
    )
    .bind(a.tenant_id)
    .bind(account.patient_id)
    .bind(account.id)
    .bind(account.version)
    .bind(due.cents)
    .fetch_optional(&mut **tx)
    .await?;
    let invoice = if let Some(invoice) = invoice {
        invoice
    } else {
        let (credit, _) = billing::patient_ledger_totals(tx, a.tenant_id, account.id).await?;
        let responsibility = due.cents + credit;
        let request = Uuid::new_v4();
        let hash = billing::digest(&(account.id, account.version, request, due.cents))?;
        let row = billing::issue_patient_invoice(
            tx,
            a,
            account.patient_id,
            account,
            (request, &hash),
            responsibility,
            STATEMENT_REASON,
        )
        .await?;
        if row["snapshot"]["amount_due_cents"] != due.cents {
            return Err(Error::Conflict(
                "patient invoice amount changed before reservation",
            ));
        }
        serde_json::from_value(row["id"].clone())
            .map_err(|_| Error::Invalid("stored patient invoice identity is unavailable"))?
    };
    let op: Operation = sqlx::query_as(
        "INSERT INTO automatic_patient_invoice_operations
         (tenant_id,account_id,patient_id,native_invoice_id,account_version,request_id,amount_cents,patient_payment_cents,
          setting_id,credential_revision,installation_id,stripe_account_id,livemode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
    )
    .bind(a.tenant_id).bind(account.id).bind(account.patient_id).bind(invoice)
    .bind(account.version).bind(Uuid::new_v4()).bind(due.cents).bind(due.patient_payment_cents).bind(binding.setting)
    .bind(binding.revision).bind(binding.installation).bind(stripe_account_id).bind(livemode)
    .fetch_one(&mut **tx).await?;
    crate::postgres::audit(tx, a, "billing.automatic_invoice_reserved", invoice).await?;
    Ok(Some(op))
}

async fn record(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    op: &Operation,
    evidence: Option<&Evidence>,
    status: &str,
    closed: bool,
) -> Result<()> {
    let changed = sqlx::query(
        "UPDATE automatic_patient_invoice_operations
         SET stripe_invoice_id=coalesce(stripe_invoice_id,$3), status=$4,
             closed_at=CASE WHEN $5 THEN now() END
         WHERE tenant_id=$1 AND request_id=$2 AND closed_at IS NULL
         AND (status<>$4 OR stripe_invoice_id IS DISTINCT FROM coalesce(stripe_invoice_id,$3) OR $5)",
    )
    .bind(a.tenant_id).bind(op.request_id).bind(evidence.map(|row| &row.stripe_invoice_id))
    .bind(status).bind(closed).execute(&mut **tx).await?.rows_affected();
    if changed > 0 {
        crate::postgres::audit(
            tx,
            a,
            "billing.automatic_invoice_changed",
            op.native_invoice_id,
        )
        .await?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Next {
    Done,
    Soon,
    Poll,
}

fn matching(account: &Account, amount: Option<Due>, op: &Operation) -> bool {
    account.version == op.account_version && amount.is_some_and(|due| due.cents == op.amount_cents)
}

async fn binding_current(tx: &mut Transaction<'_, Postgres>, binding: Binding) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM payment_settings WHERE tenant_id=$1
        AND id=$2 AND credential_revision=$3 AND mode='suncharts_connect')",
    )
    .bind(binding.tenant)
    .bind(binding.setting)
    .bind(binding.revision)
    .fetch_one(&mut **tx)
    .await?)
}

async fn refresh(
    pool: &PgPool,
    broker: &dyn Broker,
    a: &Actor,
    job: &Job,
    op: &Operation,
) -> Result<Next> {
    let binding = op.binding();
    let read = broker
        .reply(pool, &binding, Method::GET, &op.status_path(), None)
        .await?;
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let (account, amount) = current(&mut tx, a, job).await?;
    let same = matching(&account, amount, op) && binding_current(&mut tx, binding).await?;
    let incomplete = read.status == 409 && read.code() == "invoice_creation_incomplete";
    let response = match read.status {
        200..=299 => read.body,
        404 if op.stripe_invoice_id.is_none() && !same && !op.creation_attempted => {
            record(&mut tx, a, op, None, "void", true).await?;
            tx.commit().await?;
            return Ok(Next::Soon);
        }
        _ if op.stripe_invoice_id.is_none() && (read.status == 404 || incomplete) => {
            // A lost reply may have left a draft in Connect. Commit our intent before the
            // first try, and always recover that request before retiring or replacing it.
            if !op.creation_attempted {
                sqlx::query(
                    "UPDATE automatic_patient_invoice_operations SET creation_attempted=true
                    WHERE tenant_id=$1 AND request_id=$2 AND closed_at IS NULL",
                )
                .bind(op.tenant_id)
                .bind(op.request_id)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
            let response = broker.call(pool, &binding, Method::POST, &op.path(), Some(json!({
                "remote_tenant_id":op.tenant_id,"account_id":op.stripe_account_id,"livemode":op.livemode,
                "request_id":op.request_id,"native_account_id":op.account_id,
                "native_invoice_id":op.native_invoice_id,"amount_cents":op.amount_cents,"currency":"usd"
            }))).await?;
            let evidence = evidence(op, response)?;
            let mut tx = pool.begin().await?;
            billing::tenant_lock(&mut tx, a).await?;
            let (account, amount) = current(&mut tx, a, job).await?;
            let valid = evidence.status == "draft"
                && evidence.amount_paid == 0
                && evidence.amount_remaining == op.amount_cents;
            record(
                &mut tx,
                a,
                op,
                Some(&evidence),
                if valid { "draft" } else { "needs_review" },
                false,
            )
            .await?;
            let same = matching(&account, amount, op) && binding_current(&mut tx, binding).await?;
            tx.commit().await?;
            return Ok(if valid && !same {
                Next::Soon
            } else {
                Next::Poll
            });
        }
        _ => return Err(Error::Invalid("Connect invoice status is not confirmed")),
    };
    let observed = evidence(op, response)?;
    let paid = amount.is_some_and(|due| {
        due.cents == 0
            && due
                .patient_payment_cents
                .saturating_sub(op.patient_payment_cents)
                >= op.amount_cents
    });
    let obsolete = matches!(observed.status.as_str(), "void" | "uncollectible");
    let settled = observed.status == "paid" && observed.amount_paid == op.amount_cents;
    let terminal = (obsolete && observed.amount_paid == 0 && observed.amount_remaining == 0)
        || (settled && paid && observed.amount_remaining == 0);
    let manual_review =
        !terminal && (obsolete || observed.amount_paid > 0 || observed.status == "paid");
    if terminal || same || manual_review {
        let status = if manual_review {
            "needs_review"
        } else {
            &observed.status
        };
        record(&mut tx, a, op, Some(&observed), status, terminal).await?;
        tx.commit().await?;
        return Ok(if terminal && !same {
            Next::Soon
        } else if terminal {
            Next::Done
        } else {
            Next::Poll
        });
    }
    tx.commit().await?;
    let close = if paid { "paid" } else { "void" };
    let response = broker.call(pool, &binding, Method::POST, &format!("{}/{}/close", op.path(), op.request_id), Some(json!({
        "remote_tenant_id":op.tenant_id,"account_id":op.stripe_account_id,"livemode":op.livemode,
        "action":close
    }))).await?;
    let closed = evidence(op, response)?;
    let expected_paid = if paid { op.amount_cents } else { 0 };
    if closed.status != close
        || observed.stripe_invoice_id != closed.stripe_invoice_id
        || closed.amount_paid != expected_paid
        || closed.amount_remaining != 0
    {
        return Err(Error::Conflict(
            "Connect has not confirmed closure of this invoice",
        ));
    }
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    record(&mut tx, a, op, Some(&closed), close, true).await?;
    tx.commit().await?;
    Ok(Next::Soon)
}

async fn process(pool: &PgPool, job: &Job, broker: &dyn Broker, policy: Policy) -> Result<Next> {
    let a = crate::delivery::worker(job.tenant_id);
    let op: Option<Operation> = sqlx::query_as(
        "SELECT * FROM automatic_patient_invoice_operations WHERE tenant_id=$1
         AND account_id=$2 AND patient_id=$3 AND closed_at IS NULL",
    )
    .bind(job.tenant_id)
    .bind(job.account_id)
    .bind(job.patient_id)
    .fetch_optional(pool)
    .await?;
    if let Some(op) = op {
        return if policy.permits(op.livemode) {
            refresh(pool, broker, &a, job, &op).await
        } else {
            Ok(Next::Poll)
        };
    }
    let mut tx = pool.begin().await?;
    let (_, amount) = current(&mut tx, &a, job).await?;
    tx.commit().await?;
    if !amount.is_some_and(|due| due.cents > 0) {
        return Ok(Next::Done);
    }
    let binding = connect::current_binding(pool, a.tenant_id, broker).await?;
    let status = broker
        .call(pool, &binding, Method::GET, "/status", None)
        .await?;
    let (stripe_account, live) = connect::status_account(&binding, &status, policy)?;
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let (account, amount) = current(&mut tx, &a, job).await?;
    let Some(amount) = amount.filter(|due| due.cents > 0) else {
        return Ok(Next::Done);
    };
    let op = reserve(&mut tx, &a, &account, amount, binding, stripe_account, live).await?;
    tx.commit().await?;
    if let Some(op) = op {
        refresh(pool, broker, &a, job, &op).await
    } else {
        Ok(Next::Done)
    }
}

async fn poll(pool: &PgPool, broker: &dyn Broker, policy: Policy) -> Result<()> {
    if policy.production && !policy.live_enabled {
        return Ok(());
    }
    for _ in 0..12 {
        let lease = Uuid::new_v4();
        let job: Option<Job> = sqlx::query_as(
            "WITH due AS (
                SELECT tenant_id,account_id FROM automatic_patient_invoice_jobs
                WHERE next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<=now())
                ORDER BY next_attempt_at,tenant_id,account_id LIMIT 1 FOR UPDATE SKIP LOCKED
             )
             UPDATE automatic_patient_invoice_jobs j SET lease_id=$1,lease_until=now()+interval '5 minutes'
             FROM due WHERE j.tenant_id=due.tenant_id AND j.account_id=due.account_id
             RETURNING j.tenant_id,j.account_id,j.patient_id,j.generation",
        ).bind(lease).fetch_optional(pool).await?;
        let Some(job) = job else { break };
        let outcome = process(pool, &job, broker, policy).await;
        let failed = outcome.is_err();
        let retry = match outcome {
            Ok(Next::Done) => {
                let deleted = sqlx::query(
                    "DELETE FROM automatic_patient_invoice_jobs WHERE tenant_id=$1
                    AND account_id=$2 AND generation=$3 AND lease_id=$4",
                )
                .bind(job.tenant_id)
                .bind(job.account_id)
                .bind(job.generation)
                .bind(lease)
                .execute(pool)
                .await?
                .rows_affected();
                if deleted > 0 {
                    continue;
                }
                0_i32
            }
            Ok(Next::Soon) => 1,
            Ok(Next::Poll) => 300,
            Err(_) => 60,
        };
        sqlx::query("UPDATE automatic_patient_invoice_jobs SET lease_id=NULL,lease_until=NULL,
            next_attempt_at=CASE WHEN generation=$3 THEN now()+make_interval(secs=>$5::double precision) ELSE now() END,
            consecutive_failures=CASE WHEN generation<>$3 THEN consecutive_failures
                WHEN $6 THEN least(consecutive_failures+1,$7) ELSE 0 END
            WHERE tenant_id=$1 AND account_id=$2 AND lease_id=$4")
            .bind(job.tenant_id).bind(job.account_id).bind(job.generation).bind(lease).bind(f64::from(retry))
            .bind(failed).bind(REVIEW_AFTER_FAILURES)
            .execute(pool).await?;
    }
    Ok(())
}

pub async fn run(pool: PgPool) {
    if !enabled() {
        return;
    }
    let mut interval = tokio::time::interval(Duration::from_secs(15));
    loop {
        interval.tick().await;
        let _ = poll(&pool, &connect::HttpBroker, Policy::current()).await;
    }
}

#[cfg(test)]
#[path = "automatic_invoices_tests.rs"]
mod tests;
