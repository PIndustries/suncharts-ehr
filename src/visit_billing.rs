// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! One read-only billing summary per visit, and the two records the visit prepares by
//! itself: the insurance claim draft and the patient statement. Nothing here sends a claim,
//! charges a card, or changes a posted charge, receipt, payment or ledger entry.
//!
//! Money rules (all integer cents, all from stored records):
//! - `balance` is posted charges plus every ledger entry, as everywhere else.
//! - Patient payments and credits come from `billing::patient_ledger_totals`.
//! - Before the insurer answers, the patient's share is the plan copay recorded on the
//!   coverage the charges were posted with; the rest of the balance is insurance pending.
//! - While no copay is recorded at all, the visit card may name the office-visit copay from
//!   the coverage's newest completed eligibility answer within `COPAY_CHECK_DAYS` days as the
//!   expected copay (`insurer_check_copay`). It is presentational only: it is never written to
//!   the coverage and never changes the ledger's patient share or what the patient owes now.
//! - After the insurer answers (a posted remittance is the active one for the latest
//!   claim and no other claim is still open), the patient's share is the patient
//!   responsibility the insurer reported on that remittance.
//! - Without insurance the patient's share is the whole charge.
//! - A statement staff reviewed by hand (the invoice form) sets the patient's share until an
//!   insurer's answer posted after it replaces it; payments, refunds and adjustments only
//!   change what is left of it. A statement saved automatically from this summary never
//!   sets the share: it is a copy of the figure, not a source for it.
//! - The insurer's answer is the latest adjudicated, not denied, claim; a later rejected
//!   replacement or secondary claim does not erase it. While any claim is still open the
//!   answer is not final and the plan copay applies.
//! - "Patient owes now" is that share less patient payments, credits and usable unapplied
//!   receipts, never below zero and never above the balance.
use crate::{
    auth::{Actor, Role},
    billing,
    claims::{self, ClaimContent},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    routing::{get, post},
    Json, Router,
};
use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

const AUTO_REASON: &str = "Prepared automatically from the visit's posted charges";
pub(crate) const STATEMENT_REASON: &str = "Statement prepared from the visit's billing summary";

fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn cents(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}
pub(crate) fn derived_id(parts: &impl serde::Serialize) -> Result<Uuid> {
    let hex = billing::digest(parts)?;
    u128::from_str_radix(hex.get(..32).unwrap_or(""), 16)
        .map(Uuid::from_u128)
        .map_err(|_| Error::Invalid("invalid derived request"))
}

#[derive(Clone, Copy, Default)]
pub(crate) struct Options {
    /// The reader may see insurance claims.
    pub(crate) claims: bool,
    /// Include the visit timeline and statements.
    pub(crate) history: bool,
    /// Include technical identifiers (owner only).
    pub(crate) technical: bool,
}

/// What the patient has paid at the front desk for one appointment.
#[derive(Default)]
struct Receipts {
    net_received: i64,
    usable_unapplied: i64,
    needs_review: bool,
    items: Vec<Value>,
}
fn receipts(rows: Vec<Value>, appointment: Option<Uuid>, production: bool) -> Receipts {
    let mut out = Receipts::default();
    let Some(appointment) = appointment else {
        return out;
    };
    let wanted = appointment.to_string();
    for mut row in rows {
        // The credit still unused on the whole payment, before it is narrowed to one part.
        let whole_unapplied = (cents(&row["amount_cents"])
            - cents(&row["allocated_cents"])
            - cents(&row["hosted_checkout"]["refunded_unapplied_cents"])
            - cents(&row["cash_refunded_cents"]))
        .max(0);
        let mut part_unapplied = whole_unapplied;
        if let Some(parts) = row["hosted_checkout"]["splits"].as_array() {
            // One card charge divided between encounters: this encounter sees only its part.
            let Some(part) = parts
                .iter()
                .find(|part| part["appointment_id"].as_str() == Some(wanted.as_str()))
                .cloned()
            else {
                continue;
            };
            part_unapplied = whole_unapplied
                .min((cents(&part["amount_cents"]) - cents(&part["allocated_cents"])).max(0));
            row["payment_cents"] = row["amount_cents"].clone();
            row["appointment_id"] = json!(wanted);
            row["amount_cents"] = part["amount_cents"].clone();
            row["allocated_cents"] = part["allocated_cents"].clone();
            row["hosted_checkout"]["refunded_cents"] = part["refunded_cents"].clone();
        } else if row["appointment_id"].as_str() != Some(wanted.as_str()) {
            continue;
        }
        let hosted = &row["hosted_checkout"];
        let voided = row["voided"] == true;
        let reversed = cents(&row["reversed_cents"]) > 0;
        let held = hosted["status"] == "needs_review";
        let amount = cents(&row["amount_cents"]) - cents(&row["cash_refunded_cents"]);
        if !voided {
            out.net_received += (amount - cents(&hosted["refunded_cents"])).max(0);
            out.needs_review |= reversed || held;
        }
        let test_only = production && hosted["livemode"] == false;
        if !voided && !reversed && !held && !test_only {
            out.usable_unapplied += part_unapplied;
        }
        out.items.push(row);
    }
    out
}

/// A posted remittance that is the active answer for a claim.
struct Answer {
    patient_responsibility: i64,
    paid: i64,
    denied: bool,
    payment_date: Value,
    remittance_id: Value,
}

struct ClaimView {
    row: Value,
    answer: Option<Answer>,
}
impl ClaimView {
    fn status(&self) -> &str {
        self.row["status"].as_str().unwrap_or("")
    }
    fn open(&self) -> bool {
        matches!(self.status(), "draft" | "ready" | "submitted" | "accepted")
    }
}

async fn claim_views(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    account: Uuid,
) -> Result<Vec<ClaimView>> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id',c.id,'status',c.status,'frequency',c.frequency,'parent_id',c.parent_id,'control_number',c.control_number,'version',c.version,'payer_control_number',c.payer_control_number,'created_at',c.created_at,\
         'payer_name',c.snapshot->'account'->'coverage_snapshot'->'payer'->'content'->>'name',\
         'coverage_priority',c.snapshot->'account'->'coverage_snapshot'->'coverage'->'content'->>'priority',\
         'crossover',coalesce(jsonb_typeof(c.snapshot->'coordination_of_benefits'->'crossover')='object',false),\
         'secondary',coalesce(jsonb_typeof(c.snapshot->'coordination_of_benefits')='object',false),\
         'automatic',EXISTS(SELECT 1 FROM claim_revisions v WHERE v.tenant_id=c.tenant_id AND v.claim_id=c.id AND v.version=1 AND v.evidence->>'prepared'='automatic'),\
         'sent_on',(SELECT coalesce(v.evidence->>'event_date',to_char(v.created_at,'YYYY-MM-DD')) FROM claim_revisions v WHERE v.tenant_id=c.tenant_id AND v.claim_id=c.id AND v.snapshot->>'status'='submitted' ORDER BY v.version LIMIT 1),\
         'file_prepared',EXISTS(SELECT 1 FROM edi_submissions s WHERE s.tenant_id=c.tenant_id AND s.claim_id=c.id AND s.status<>'cancelled'),\
         'snapshot_total_cents',c.snapshot->'account'->'total_cents','snapshot_lines',c.snapshot->'account'->'content'->'lines',\
         'content',c.content,'snapshot',jsonb_build_object('patient',c.snapshot->'patient','account',c.snapshot->'account'),\
         'response_to_review',(SELECT r.id FROM era_remittances r WHERE r.tenant_id=c.tenant_id AND r.status IN ('staged','reconciled') AND (r.matches @> jsonb_build_array(jsonb_build_object('claim_id',c.id)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.document->'claims')='array' THEN r.document->'claims' ELSE '[]'::jsonb END) x WHERE x->>'control_number'=c.control_number)) ORDER BY r.created_at LIMIT 1),\
         'head',(SELECT jsonb_build_object('remittance_id',h.remittance_id,'row_index',h.row_index,'patient_responsibility_cents',p.patient_responsibility_cents,'writeoff_cents',p.writeoff_cents,'payment_date',r.document->>'payment_date','trace',r.trace,'row',r.document->'claims'->h.row_index) FROM era_claim_heads h JOIN era_remittances r ON r.tenant_id=h.tenant_id AND r.id=h.remittance_id LEFT JOIN era_postings p ON p.tenant_id=h.tenant_id AND p.remittance_id=h.remittance_id AND p.row_index=h.row_index WHERE h.tenant_id=c.tenant_id AND h.claim_id=c.id)) \
         FROM ehr_claims c WHERE c.tenant_id=$1 AND c.account_id=$2 ORDER BY c.created_at DESC,c.id DESC LIMIT 200",
    )
    .bind(a.tenant_id)
    .bind(account)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .rev()
        .map(|row| {
            let head = &row["head"];
            let answer = head.is_object().then(|| {
                let line = &head["row"];
                let paid = cents(&line["paid_cents"]);
                Answer {
                    patient_responsibility: head["patient_responsibility_cents"]
                        .as_i64()
                        .unwrap_or_else(|| cents(&line["patient_responsibility_cents"])),
                    paid,
                    denied: line["status"] == "4",
                    payment_date: head["payment_date"].clone(),
                    remittance_id: head["remittance_id"].clone(),
                }
            });
            ClaimView { row, answer }
        })
        .collect())
}

/// Money and claim position of charge accounts, for any number of them in a fixed number
/// of queries. Every screen that shows what a patient owes reads it from here: the visit
/// card, the patient banner, the schedule and the patient billing page.
const BALANCES: &str = r#"WITH acct AS (
 SELECT b.tenant_id,b.id,b.patient_id,b.status,b.version,b.total_cents,v.status AS visit_status,v.appointment_id,b.visit_id,
  b.status='posted' AS posted,
  b.coverage_snapshot IS NOT NULL AS insured,
  btrim(coalesce(b.coverage_snapshot->'payer'->'content'->>'payer_code',''))<>'' AS electronic,
  CASE WHEN jsonb_typeof(b.coverage_snapshot->'coverage'->'content'->'copay_cents')='number' THEN (b.coverage_snapshot->'coverage'->'content'->>'copay_cents')::bigint END AS copay
 FROM billing_accounts b LEFT JOIN visits v ON v.tenant_id=b.tenant_id AND v.id=b.visit_id AND v.patient_id=b.patient_id
 WHERE b.tenant_id=$1 AND b.status<>'void' AND (NOT $6 OR b.status='posted') AND ($2::uuid[] IS NULL OR b.patient_id=ANY($2)) AND ($3::uuid[] IS NULL OR b.id=ANY($3))
), ledger AS (
 SELECT x.account_id,sum(x.effect_cents)::bigint AS net,
  coalesce(-sum(x.effect_cents) FILTER (WHERE x.party='patient'),0)::bigint AS patient_credit,
  coalesce(-sum(x.effect_cents) FILTER (WHERE x.party='patient' AND (x.kind='payment' OR (x.kind='reversal' AND x.original_kind='payment') OR (x.kind='adjustment_debit' AND (x.content->>'managed_payment_id' IS NOT NULL OR x.content->>'hosted_copay_operation_id' IS NOT NULL OR x.content->>'invoice_checkout_operation_id' IS NOT NULL)))),0)::bigint AS patient_payments,
  coalesce(-sum(x.effect_cents) FILTER (WHERE x.party='insurer' AND (x.kind='payment' OR (x.kind='reversal' AND x.original_kind='payment'))),0)::bigint AS insurer_paid,
  coalesce(-sum(x.effect_cents) FILTER (WHERE x.source ? 'copay_receipt_id'),0)::bigint AS receipts_applied,
  coalesce(bool_or(x.content->>'test_mode'='true'),false) AS test_activity,
  max(x.created_at) AS last_entry_at
 FROM (SELECT e.account_id,e.effect_cents,e.kind,e.content,e.created_at,o.kind AS original_kind,coalesce(o.content,e.content) AS source,
   CASE WHEN e.kind='reversal' THEN o.content->>'party' ELSE e.content->>'party' END AS party
  FROM billing_entries e LEFT JOIN billing_entries o ON o.tenant_id=e.tenant_id AND o.account_id=e.account_id AND o.id=e.reverses_id
  WHERE e.tenant_id=$1 AND e.account_id IN (SELECT id FROM acct)) x GROUP BY x.account_id
), desk AS (
 SELECT z.appointment_id,
  sum(CASE WHEN y.voided OR y.reversed>0 OR coalesce(o.status='needs_review',false) OR ($5 AND coalesce(o.livemode=false,false)) THEN 0 ELSE greatest(0,least(r.amount_cents-y.allocated-y.refunded_unapplied,z.part_left)) END)::bigint AS unapplied
 FROM billing_copay_receipts r LEFT JOIN copay_checkout_attempts o ON o.tenant_id=r.tenant_id AND o.receipt_id=r.id
 CROSS JOIN LATERAL (SELECT
   coalesce((SELECT sum(a.amount_cents) FROM billing_copay_allocations a WHERE a.tenant_id=r.tenant_id AND a.receipt_id=r.id),0)::bigint AS allocated,
   coalesce((SELECT sum(a.amount_cents) FROM billing_copay_allocations a JOIN billing_entries e ON e.tenant_id=a.tenant_id AND e.reverses_id=a.entry_id WHERE a.tenant_id=r.tenant_id AND a.receipt_id=r.id),0)::bigint AS reversed,
   coalesce((SELECT sum(f.unapplied_cents) FROM copay_checkout_refund_events f WHERE f.tenant_id=o.tenant_id AND f.operation_id=o.id),0)::bigint+coalesce((SELECT f.amount_cents FROM billing_receipt_cash_refunds f WHERE f.tenant_id=r.tenant_id AND f.receipt_id=r.id),0) AS refunded_unapplied,
   EXISTS(SELECT 1 FROM billing_copay_voids d WHERE d.tenant_id=r.tenant_id AND d.receipt_id=r.id) AS voided) y
 CROSS JOIN LATERAL (
  SELECT r.appointment_id,r.amount_cents AS part_left WHERE NOT EXISTS(SELECT 1 FROM copay_checkout_splits s WHERE s.tenant_id=o.tenant_id AND s.operation_id=o.id)
  UNION ALL
  SELECT s.appointment_id,s.amount_cents-coalesce((SELECT sum(a.amount_cents) FROM billing_copay_allocations a JOIN billing_accounts b ON b.tenant_id=a.tenant_id AND b.id=a.account_id JOIN visits v ON v.tenant_id=b.tenant_id AND v.id=b.visit_id WHERE a.tenant_id=r.tenant_id AND a.receipt_id=r.id AND v.appointment_id=s.appointment_id),0)::bigint
  FROM copay_checkout_splits s WHERE s.tenant_id=o.tenant_id AND s.operation_id=o.id) z
 WHERE r.tenant_id=$1 AND (r.appointment_id IN (SELECT appointment_id FROM acct WHERE appointment_id IS NOT NULL)
   OR r.id IN (SELECT o2.receipt_id FROM copay_checkout_splits s2 JOIN copay_checkout_attempts o2 ON o2.tenant_id=s2.tenant_id AND o2.id=s2.operation_id WHERE s2.tenant_id=$1 AND s2.appointment_id IN (SELECT appointment_id FROM acct WHERE appointment_id IS NOT NULL)))
  AND z.appointment_id IN (SELECT appointment_id FROM acct WHERE appointment_id IS NOT NULL) GROUP BY z.appointment_id
), facts AS (
 SELECT a.*,a.total_cents+coalesce(l.net,0) AS balance,coalesce(l.patient_credit,0) AS patient_credit,coalesce(l.patient_payments,0) AS patient_payments,
  coalesce(l.insurer_paid,0) AS insurer_paid,coalesce(l.receipts_applied,0) AS receipts_applied,coalesce(d.unapplied,0) AS unapplied,
  coalesce(l.test_activity,false) OR coalesce((i.snapshot->>'test_activity')::boolean,false) AS test_activity,
  c.id AS claim_id,c.status AS claim_status,c.response_to_review,
  n.claim_id IS NOT NULL AND coalesce(c.status NOT IN ('draft','ready','submitted','accepted'),false) AS answered,n.responsibility AS settled_responsibility,n.answered_at,
  coalesce(c.status='adjudicated' AND c.answered AND c.denied,false) AND NOT EXISTS(SELECT 1 FROM billing_denial_resolutions dr WHERE dr.tenant_id=a.tenant_id AND dr.claim_id=c.id) AS denied,
  EXISTS(SELECT 1 FROM ehr_claims z WHERE z.tenant_id=a.tenant_id AND z.account_id=a.id AND z.status='void') AS any_void,
  m.id IS NOT NULL AND m.account_version=a.version AND (l.last_entry_at IS NULL OR l.last_entry_at<=m.created_at) AS statement_current,m.created_at AS statement_at,
  CASE WHEN jsonb_typeof(m.snapshot->'responsibility_cents')='number' THEN (m.snapshot->>'responsibility_cents')::bigint END AS statement_responsibility
 FROM acct a LEFT JOIN ledger l ON l.account_id=a.id LEFT JOIN desk d ON d.appointment_id=a.appointment_id
 LEFT JOIN LATERAL (SELECT i.id,i.snapshot FROM patient_invoice_snapshots i WHERE i.tenant_id=a.tenant_id AND i.account_id=a.id ORDER BY i.created_at DESC,i.id DESC LIMIT 1) i ON true
 LEFT JOIN LATERAL (SELECT i.id,i.account_version,i.created_at,i.snapshot FROM patient_invoice_snapshots i WHERE i.tenant_id=a.tenant_id AND i.account_id=a.id AND a.posted AND i.snapshot->>'reason' IS DISTINCT FROM $7
   AND NOT EXISTS(SELECT 1 FROM billing_account_coverage_applications c WHERE c.tenant_id=a.tenant_id AND c.account_id=a.id AND i.account_version<c.account_version)
   ORDER BY i.created_at DESC,i.id DESC LIMIT 1) m ON true
 LEFT JOIN LATERAL (SELECT c.id,c.status,h.remittance_id IS NOT NULL AS answered,coalesce(r.document->'claims'->h.row_index->>'status'='4',false) AS denied,
   CASE WHEN $6 THEN NULL ELSE (SELECT s.id FROM era_remittances s WHERE s.tenant_id=c.tenant_id AND s.status IN ('staged','reconciled') AND (s.matches @> jsonb_build_array(jsonb_build_object('claim_id',c.id)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.document->'claims')='array' THEN s.document->'claims' ELSE '[]'::jsonb END) q WHERE q->>'control_number'=c.control_number)) ORDER BY s.created_at LIMIT 1) END AS response_to_review
  FROM ehr_claims c LEFT JOIN era_claim_heads h ON h.tenant_id=c.tenant_id AND h.claim_id=c.id
  LEFT JOIN era_remittances r ON r.tenant_id=h.tenant_id AND r.id=h.remittance_id
  WHERE c.tenant_id=a.tenant_id AND c.account_id=a.id AND c.status<>'void' AND a.posted AND a.insured
  ORDER BY (c.status IN ('draft','ready','submitted','accepted')) DESC,c.created_at DESC,c.id DESC LIMIT 1) c ON true
 LEFT JOIN LATERAL (SELECT c.id AS claim_id,
   coalesce(p.patient_responsibility_cents,CASE WHEN jsonb_typeof(r.document->'claims'->h.row_index->'patient_responsibility_cents')='number' THEN (r.document->'claims'->h.row_index->>'patient_responsibility_cents')::bigint END,0) AS responsibility,
   (SELECT max(v.created_at) FROM claim_revisions v WHERE v.tenant_id=c.tenant_id AND v.claim_id=c.id AND v.evidence->>'remittance_id'=h.remittance_id::text) AS answered_at
  FROM ehr_claims c JOIN era_claim_heads h ON h.tenant_id=c.tenant_id AND h.claim_id=c.id
  JOIN era_remittances r ON r.tenant_id=h.tenant_id AND r.id=h.remittance_id
  LEFT JOIN era_postings p ON p.tenant_id=h.tenant_id AND p.remittance_id=h.remittance_id AND p.row_index=h.row_index
  WHERE c.tenant_id=a.tenant_id AND c.account_id=a.id AND c.status='adjudicated' AND a.posted AND a.insured
   AND coalesce(r.document->'claims'->h.row_index->>'status','')<>'4'
  ORDER BY c.created_at DESC,c.id DESC LIMIT 1) n ON true
), shares AS (
 SELECT f.*,
  CASE WHEN NOT f.posted THEN 0
   WHEN f.reviewed THEN least(greatest(f.statement_responsibility,0),f.total_cents)
   WHEN NOT f.insured THEN f.total_cents
   WHEN f.answered THEN least(greatest(f.settled_responsibility,0),f.total_cents)
   WHEN f.copay IS NOT NULL THEN least(greatest(f.copay,0),f.total_cents) ELSE 0 END AS responsibility,
  CASE WHEN NOT f.posted THEN 'not_final' WHEN f.reviewed THEN 'reviewed_statement'
   WHEN NOT f.insured THEN 'self_pay' WHEN f.answered THEN 'insurer_response'
   WHEN f.copay IS NOT NULL THEN 'plan_copay' ELSE 'copay_not_recorded' END AS responsibility_source
 FROM (SELECT g.*,g.statement_responsibility IS NOT NULL AND (NOT g.answered OR g.statement_at>=g.answered_at OR (g.answered_at IS NULL AND g.statement_current)) AS reviewed FROM facts g) f
), owed AS (
 SELECT s.*,CASE WHEN s.posted THEN least(greatest(s.responsibility-s.patient_credit-s.unapplied,0),greatest(s.balance,0)) ELSE 0 END AS owes_now FROM shares s
)
SELECT jsonb_build_object('id',o.id,'patient_id',o.patient_id,'status',o.status,'visit_status',o.visit_status,'posted',o.posted,'insured',o.insured,'electronic',o.electronic,
 'total_cents',o.total_cents,'balance_cents',o.balance,'patient_credit_cents',o.patient_credit,'patient_payments_cents',o.patient_payments,'insurer_paid_cents',o.insurer_paid,
 'receipts_applied_cents',o.receipts_applied,'unapplied_cents',CASE WHEN o.posted THEN o.unapplied ELSE 0 END,'responsibility_cents',o.responsibility,'responsibility_source',o.responsibility_source,
 'owes_now_cents',o.owes_now,
 'pending_cents',CASE WHEN o.posted AND o.insured AND NOT o.answered THEN greatest(o.balance+greatest(o.patient_credit-o.responsibility,0)-o.owes_now,0) ELSE 0 END,
 'unassigned_cents',CASE WHEN o.posted AND ((o.insured AND o.answered) OR (NOT o.insured AND o.responsibility_source='reviewed_statement')) THEN greatest(o.balance-o.owes_now,0) ELSE 0 END,
 'overpaid_cents',CASE WHEN o.posted THEN greatest(greatest(o.patient_credit-o.responsibility,0),-o.balance) ELSE 0 END,
 'answered',o.answered,'denied',o.denied,'any_void',o.any_void,'claim_id',o.claim_id,'claim_status',o.claim_status,'response_to_review',o.response_to_review,'test_activity',o.test_activity,'appointment_id',o.appointment_id,'visit_id',o.visit_id)
FROM owed o WHERE $4::boolean IS NULL OR o.test_activity=$4"#;

/// One row per charge account that is not void. `patients` and `accounts` narrow the set;
/// `test` keeps only accounts with (or without) test processor activity.
pub(crate) fn balances_query<'q>(
    tenant: Uuid,
    patients: Option<&'q [Uuid]>,
    accounts: Option<&'q [Uuid]>,
    test: Option<bool>,
) -> sqlx::query::QueryScalar<'q, Postgres, Value, sqlx::postgres::PgArguments> {
    #[cfg(test)]
    query_log::count(tenant);
    sqlx::query_scalar(BALANCES)
        .bind(tenant)
        .bind(patients)
        .bind(accounts)
        .bind(test)
        .bind(production())
        .bind(accounts.is_none())
        .bind(STATEMENT_REASON)
}
/// Test-mode card receipts are never applied to charges on production, so they must not
/// reduce what a patient owes there either.
fn production() -> bool {
    std::env::var("ENGINE_ENVIRONMENT").as_deref() == Ok("production")
}
pub(crate) async fn balances(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    patients: Option<&[Uuid]>,
    accounts: Option<&[Uuid]>,
    test: Option<bool>,
) -> Result<Vec<Value>> {
    Ok(balances_query(tenant, patients, accounts, test)
        .fetch_all(&mut **tx)
        .await?)
}
/// Adds up what each patient owes now from balance rows.
pub(crate) fn owed_by_patient(rows: &[Value]) -> std::collections::HashMap<Uuid, i64> {
    let mut out = std::collections::HashMap::new();
    for row in rows {
        if let Some(patient) = row["patient_id"]
            .as_str()
            .and_then(|v| Uuid::parse_str(v).ok())
        {
            *out.entry(patient).or_insert(0) += cents(&row["owes_now_cents"]);
        }
    }
    out
}
/// What each patient owes now across their visits, in one query. Insurance-pending money
/// is never part of it.
pub(crate) async fn patients_owe(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    patients: Option<&[Uuid]>,
    test: Option<bool>,
) -> Result<std::collections::HashMap<Uuid, i64>> {
    Ok(owed_by_patient(
        &balances(tx, tenant, patients, None, test).await?,
    ))
}
/// The state name of a visit's billing, from its balance row. `claim_needs_details` says
/// whether the open draft claim fails the readiness checks.
/// What an insurance claim cannot go without, read from the draft charges: a diagnosis on the
/// encounter, and one linked to every charge line. A self-pay encounter needs neither, and an
/// empty draft has nothing to check yet.
pub(crate) fn before_posting(insured: bool, lines: &Value, on_encounter: usize) -> Vec<Value> {
    let lines = lines.as_array().map(Vec::as_slice).unwrap_or(&[]);
    if !insured || lines.is_empty() {
        return vec![];
    }
    let unlinked = lines
        .iter()
        .filter(|l| l["diagnosis_codes"].as_array().is_none_or(Vec::is_empty))
        .count();
    if unlinked == 0 {
        vec![]
    } else if on_encounter == 0 && unlinked == lines.len() {
        vec![json!({"code":"diagnoses","missing":"a diagnosis"})]
    } else {
        vec![
            json!({"code":"line_diagnoses","missing":"a diagnosis for every charge","lines":unlinked}),
        ]
    }
}
pub(crate) fn state_of(
    row: &Value,
    claim_needs_details: bool,
    claims_visible: bool,
) -> (&'static str, &'static str) {
    state_of_with_claimmd(row, claim_needs_details, claims_visible, &Value::Null)
}
/// The same, with the claim's Claim.MD position. A correction the clearinghouse holds waits on
/// the practice, not the other way round, so the card stops saying "nothing to do until they
/// answer"; a claim Claim.MD has only received is named as received, because the payer has not
/// been given the claim yet and staff may have to release it in Claim.MD themselves.
pub(crate) fn state_of_with_claimmd(
    row: &Value,
    claim_needs_details: bool,
    claims_visible: bool,
    claimmd: &Value,
) -> (&'static str, &'static str) {
    let posted = row["posted"] == true;
    let insured = row["insured"] == true;
    let owes = cents(&row["owes_now_cents"]);
    let credit = cents(&row["unapplied_cents"]) + cents(&row["overpaid_cents"]);
    if !posted {
        return if row["visit_status"].is_null() || row["visit_status"] == "signed" {
            ("post_charges", "staff")
        } else {
            ("sign_visit", "clinician")
        };
    }
    let settled = || {
        if credit > 0 {
            ("patient_credit", "staff")
        } else {
            ("paid_in_full", "nobody")
        }
    };
    if !insured {
        return if owes > 0 {
            ("self_pay_collect", "patient")
        } else if cents(&row["unassigned_cents"]) > 0 {
            ("review_balance", "staff")
        } else {
            settled()
        };
    }
    if !claims_visible {
        return ("claim_restricted", "staff");
    }
    match row["claim_status"].as_str() {
        None if row["electronic"] != true => ("insurance_outside", "staff"),
        None if row["any_void"] == true => ("claim_cancelled", "staff"),
        None => ("prepare_claim", "staff"),
        Some("draft" | "ready") if claim_needs_details => ("fix_claim", "staff"),
        Some("draft" | "ready") => ("send_claim", "staff"),
        Some("submitted" | "accepted") if row["response_to_review"].is_string() => {
            ("post_response", "staff")
        }
        Some("submitted" | "accepted") if claimmd["needs_correction"] == true => {
            ("claimmd_correction", "staff")
        }
        Some("submitted" | "accepted") if claimmd["acknowledged"] == true => {
            ("claimmd_received", "nobody")
        }
        Some("submitted" | "accepted") => ("waiting_insurer", "insurer"),
        Some("rejected") => ("claim_rejected", "staff"),
        Some("adjudicated") if row["denied"] == true => ("denied", "staff"),
        _ if owes > 0 => ("patient_owes", "patient"),
        _ if cents(&row["unassigned_cents"]) > 0 => ("review_response", "staff"),
        _ => settled(),
    }
}
/// State names for a page of balance rows: one extra query for open unsent claims.
pub(crate) async fn states(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    rows: &[Value],
    claims_visible: bool,
) -> Result<std::collections::HashMap<Uuid, &'static str>> {
    let open_claims: Vec<Uuid> = rows
        .iter()
        .filter(|row| matches!(row["claim_status"].as_str(), Some("draft" | "ready")))
        .filter_map(|row| {
            row["claim_id"]
                .as_str()
                .and_then(|v| Uuid::parse_str(v).ok())
        })
        .collect();
    let mut needs = std::collections::HashSet::new();
    if claims_visible && !open_claims.is_empty() {
        #[cfg(test)]
        query_log::count(a.tenant_id);
        let claims: Vec<claims::Claim> =
            sqlx::query_as("SELECT * FROM ehr_claims WHERE tenant_id=$1 AND id=ANY($2)")
                .bind(a.tenant_id)
                .bind(&open_claims)
                .fetch_all(&mut **tx)
                .await?;
        for claim in claims {
            if !claims::preflight(&claim)?.is_empty() {
                needs.insert(claim.id);
            }
        }
    }
    Ok(rows
        .iter()
        .filter_map(|row| {
            let id = Uuid::parse_str(row["id"].as_str()?).ok()?;
            let needs_details = row["claim_id"]
                .as_str()
                .and_then(|v| Uuid::parse_str(v).ok())
                .is_some_and(|claim| needs.contains(&claim));
            Some((id, state_of(row, needs_details, claims_visible).0))
        })
        .collect())
}
fn plain_issue(issue: &str) -> Value {
    let (code, text) = if issue.starts_with("Tax ID") {
        ("tax_id", "billing organization tax ID")
    } else if issue.starts_with("Billing provider name") {
        ("billing_provider_name", "billing provider name")
    } else if issue.starts_with("Billing address") {
        ("billing_address", "billing address")
    } else if issue.starts_with("Patient address") {
        ("patient_address", "patient address")
    } else if issue.starts_with("Subscriber address") {
        ("subscriber_address", "policy holder's address")
    } else if issue.starts_with("Subscriber date of birth") {
        ("subscriber_birth_date", "policy holder's date of birth")
    } else if issue.starts_with("Billing and rendering NPIs") {
        ("npi", "provider NPI")
    } else if issue.starts_with("Two-digit place of service") {
        ("place_of_service", "place of service")
    } else if issue.starts_with("Supply 1 to 12") {
        ("diagnosis_codes", "diagnosis codes")
    } else if issue.starts_with("Every charge line") {
        ("line_diagnosis_pointers", "a diagnosis for every charge")
    } else if issue.starts_with("Claim.MD payer ID") {
        ("payer_code", "insurer's payer ID")
    } else if issue.starts_with("Payer name") {
        ("payer_name", "insurer name")
    } else if issue.starts_with("Secondary billing") {
        (
            "secondary",
            "the primary insurer's answer (bill the secondary from the primary claim)",
        )
    } else if issue.starts_with("Tertiary") {
        (
            "tertiary",
            "a third insurer cannot be billed electronically",
        )
    } else {
        ("other", issue)
    };
    json!({"code":code,"missing":text,"detail":issue})
}

/// How long an insurer's eligibility answer may stand in for a copay the plan never
/// recorded. Beyond this the practice is asked to check again rather than shown an
/// amount the insurer may have changed.
const COPAY_CHECK_DAYS: i64 = 45;
/// The office-visit service types an eligibility answer is read for: 98 is an office
/// visit and 30 the general health-plan benefit the one-click check asks for. The
/// response carries no separate "professional visit" field, so a benefit written as a
/// professional visit under any other service type is recognised by its description --
/// the wording Claim.MD returns, matched the same way the eligibility screen names it.
const VISIT_SERVICE_TYPES: &[&str] = &["98", "30"];
const PROFESSIONAL_VISIT: &str = "professional";

/// One flat copay amount in dollars, as Claim.MD writes it. A percentage, a malformed
/// amount, a negative or an absurd figure is not a copay; coinsurance is never one.
fn copay_cents(dollars: &Value) -> Option<i64> {
    let text = match dollars {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => return None,
    };
    let (whole, fraction) = match text.split_once('.') {
        Some((whole, fraction)) if fraction.len() <= 2 && !whole.is_empty() => (whole, fraction),
        // A plain whole amount; a decimal point must be followed by at most two digits,
        // which is as far as dollars are written.
        Some(_) => return None,
        None => (text.as_str(), ""),
    };
    if whole.is_empty()
        || whole.len() > 9
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let cents: i64 = whole.parse::<i64>().ok()? * 100
        + match fraction.len() {
            0 => 0,
            1 => fraction.parse::<i64>().ok()? * 10,
            2 => fraction.parse::<i64>().ok()?,
            _ => return None,
        };
    (cents <= 100_000_000).then_some(cents)
}
/// A benefit entry of an eligibility response, however the insurer grouped it.
fn benefits_of(row: &Value) -> Vec<&Value> {
    match &row["benefit"] {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => vec![&row["benefit"]],
        _ => vec![],
    }
}
fn looks_like_professional_visit(benefit: &Value) -> bool {
    ["benefit_description", "benefit_coverage_description"]
        .iter()
        .filter_map(|key| benefit[*key].as_str())
        .any(|text| text.to_ascii_lowercase().contains(PROFESSIONAL_VISIT))
}
/// The office-visit copay an eligibility answer reports, in cents, or nothing when the
/// answer cannot be trusted for it: no copay, no office-visit service, a coinsurance
/// percentage instead, or copays that disagree. One answer is taken for one visit, so a
/// family-level amount is not read as this patient's.
fn office_visit_copay(response: &Value) -> Option<i64> {
    let mut found: Vec<i64> = vec![];
    for plan in response["elig"].as_array().into_iter().flatten() {
        for benefit in benefits_of(plan) {
            if benefit["benefit_coverage_code"].as_str() != Some("B")
                || benefit["benefit_level_code"].as_str() == Some("FAM")
            {
                continue;
            }
            let service = benefit["benefit_code"].as_str().unwrap_or("");
            if !VISIT_SERVICE_TYPES.contains(&service) && !looks_like_professional_visit(benefit) {
                continue;
            }
            let cents = copay_cents(&benefit["benefit_amount"])?;
            if !found.contains(&cents) {
                found.push(cents);
            }
        }
    }
    match found.as_slice() {
        [only] => Some(*only),
        _ => None,
    }
}
/// The office-visit copay the insurer reported for a coverage, from its newest completed
/// eligibility answer no older than [`COPAY_CHECK_DAYS`]. The check's own service date is
/// the date of the answer; without one the day the insurer answered is used.
async fn insurer_check_copay(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    patient: Uuid,
    coverage: Uuid,
) -> Result<Option<(i64, chrono::NaiveDate)>> {
    let row: Option<(Value, Option<String>, Option<chrono::DateTime<chrono::Utc>>)> = sqlx::query_as(
        "SELECT response_snapshot,coalesce(request_snapshot->'request'->>'service_date',request_snapshot->>'service_date'),completed_at
           FROM claimmd_eligibility_checks
          WHERE tenant_id=$1 AND patient_id=$2 AND coverage_id=$3 AND status='completed'
            AND created_at>now()-make_interval(days:=$4)
          ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .bind(tenant)
    .bind(patient)
    .bind(coverage)
    .bind(COPAY_CHECK_DAYS as i32)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((response, service_date, completed_at)) = row else {
        return Ok(None);
    };
    let Some(copay) = office_visit_copay(&response) else {
        return Ok(None);
    };
    let day = service_date
        .as_deref()
        .and_then(|day| chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok())
        .or_else(|| completed_at.map(|at| at.date_naive()))
        // The row is only as old as the query allows, so an unreadable date is still
        // inside the window; the day the check was made is the honest fallback.
        .unwrap_or_else(|| chrono::Utc::now().date_naive());
    Ok(Some((copay, day)))
}

/// The copay the front desk is asked for: the plan's own when the coverage records one,
/// otherwise the office-visit copay the insurer reported -- and only on an insured, posted
/// visit that nothing has settled yet. `None` leaves the visit exactly as it was.
fn expected_copay(
    plan: Option<i64>,
    insured: bool,
    source: &str,
    checked: Option<(i64, chrono::NaiveDate)>,
) -> Option<i64> {
    if let Some(copay) = plan.filter(|_| insured) {
        return Some(copay);
    }
    // A check may stand in only where the ledger itself says "no copay recorded" on an
    // insured visit: posted, not settled by an insurer's answer, not reviewed by hand.
    (insured && source == "copay_not_recorded")
        .then(|| checked.map(|(copay, _)| copay))
        .flatten()
}
/// The billing summary of one visit (or one charge account without a visit).
pub(crate) async fn summarize(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    visit: Option<Uuid>,
    account: Option<Uuid>,
    opt: Options,
) -> Result<Value> {
    if visit.is_none() && account.is_none() {
        return Err(Error::Invalid("choose a visit or its charges"));
    }
    let account: Option<billing::Account> = sqlx::query_as(
        "SELECT * FROM billing_accounts WHERE tenant_id=$1 AND patient_id=$2 AND (($3::uuid IS NOT NULL AND id=$3) OR ($3::uuid IS NULL AND visit_id=$4 AND status<>'void')) ORDER BY created_at DESC,id LIMIT 1",
    )
    .bind(a.tenant_id)
    .bind(p)
    .bind(account)
    .bind(visit)
    .fetch_optional(&mut **tx)
    .await?;
    let visit_id = account
        .as_ref()
        .and_then(|b| b.content["visit_id"].as_str())
        .and_then(|v| Uuid::parse_str(v).ok())
        .or(visit);
    let visit_row: Option<(Uuid, String, Uuid, chrono::DateTime<chrono::Utc>, Uuid, String)> = match visit_id {
        Some(v) => sqlx::query_as("SELECT v.id,v.status,v.appointment_id,ap.starts_at,v.clinician_id,coalesce(nullif(pp.display_name,''),u.display_name,'') FROM visits v JOIN appointments ap ON ap.tenant_id=v.tenant_id AND ap.id=v.appointment_id LEFT JOIN practice_providers pp ON (pp.tenant_id,pp.id)=(v.tenant_id,v.clinician_id) LEFT JOIN browser_users u ON (u.tenant_id,u.id)=(v.tenant_id,v.clinician_id) WHERE v.tenant_id=$1 AND v.patient_id=$2 AND v.id=$3")
            .bind(a.tenant_id).bind(p).bind(v).fetch_optional(&mut **tx).await?,
        None => None,
    };
    if account.is_none() && visit_row.is_none() {
        return Err(Error::NotFound);
    }
    let appointment = visit_row.as_ref().map(|row| row.2);
    let posted = account.as_ref().is_some_and(|b| b.status == "posted");
    let void = account.as_ref().is_some_and(|b| b.status == "void");

    // Insurance the charges use: frozen when posted, the chosen coverage while the charges
    // can still change, otherwise the primary coverage in force on the visit date. The
    // coverage's id is kept with it so the insurer's own answers can be looked up for it.
    let coverage: Option<(Uuid, Value, Value)> = match &account {
        Some(b) if b.status != "draft" => b.coverage_snapshot.as_ref().map(|s| {
            let id = serde_json::from_value(s["coverage"]["id"].clone())
                .unwrap_or_else(|_| Uuid::nil());
            (
                id,
                s["coverage"]["content"].clone(),
                s["payer"]["content"].clone(),
            )
        }),
        Some(b) => match b.content["coverage_id"].as_str().and_then(|v| Uuid::parse_str(v).ok()) {
            Some(id) => sqlx::query_as("SELECT c.id,c.content,py.content FROM insurance_coverages c JOIN ehr_payers py ON py.tenant_id=c.tenant_id AND py.id=(c.content->>'payer_id')::uuid WHERE c.tenant_id=$1 AND c.patient_id=$2 AND c.id=$3")
                .bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut **tx).await?,
            None => None,
        },
        None => match &visit_row {
            Some(row) => sqlx::query_as("SELECT c.id,c.content,py.content FROM insurance_coverages c JOIN ehr_payers py ON py.tenant_id=c.tenant_id AND py.id=(c.content->>'payer_id')::uuid WHERE c.tenant_id=$1 AND c.patient_id=$2 AND c.content->>'status'='active' AND c.content->>'priority'='primary' AND c.content->>'effective_date'<=$3 AND (c.content->>'end_date' IS NULL OR c.content->>'end_date'>=$3) ORDER BY c.id LIMIT 1")
                .bind(a.tenant_id).bind(p).bind(row.3.date_naive().to_string()).fetch_optional(&mut **tx).await?,
            None => None,
        },
    };
    let insured = coverage.is_some();
    let insurer = coverage
        .as_ref()
        .and_then(|(_, _, payer)| payer["name"].as_str())
        .unwrap_or("")
        .to_owned();
    let electronic = coverage
        .as_ref()
        .is_some_and(|(_, _, payer)| !payer["payer_code"].as_str().unwrap_or("").trim().is_empty());
    let plan_copay = coverage
        .as_ref()
        .and_then(|(_, content, _)| content["copay_cents"].as_i64());
    // What the insurer last told us the visit costs, used only when the plan has no
    // recorded copay at all. It never touches the coverage record.
    let checked = match (insured, plan_copay, coverage.as_ref().map(|row| row.0)) {
        (true, None, Some(coverage)) if posted => {
            insurer_check_copay(tx, a.tenant_id, p, coverage).await?
        }
        _ => None,
    };

    let paid_at_desk = receipts(
        billing::copay_rows(tx, a, p, None).await?,
        appointment,
        production(),
    );

    // Money comes from the one calculation every screen shares.
    let total = account.as_ref().map(|b| b.total_cents).unwrap_or(0);
    let money = match account.as_ref().filter(|_| posted) {
        Some(b) => balances(tx, a.tenant_id, None, Some(&[b.id]), None)
            .await?
            .into_iter()
            .next()
            .ok_or(Error::NotFound)?,
        None => {
            json!({"posted":false,"insured":insured,"visit_status":visit_row.as_ref().map(|row| row.1.clone()),"responsibility_source":"not_final"})
        }
    };
    let balance = cents(&money["balance_cents"]);
    let patient_credit = cents(&money["patient_credit_cents"]);
    let patient_payments = cents(&money["patient_payments_cents"]);
    let insurer_paid = cents(&money["insurer_paid_cents"]);
    let receipts_applied = cents(&money["receipts_applied_cents"]);
    let usable_unapplied = if posted {
        cents(&money["unapplied_cents"])
    } else {
        paid_at_desk.usable_unapplied
    };
    let responsibility = cents(&money["responsibility_cents"]);
    let mut source = money["responsibility_source"]
        .as_str()
        .unwrap_or("not_final")
        .to_owned();
    // The copay the card words and totals. The ledger figure is deliberately left alone:
    // what the patient owes now stays as it was until the insurer answers the claim.
    let expected = expected_copay(plan_copay, insured, &source, checked);
    let from_check = expected.is_some() && expected != plan_copay;
    if from_check {
        source = "insurer_check_copay".to_owned();
    }
    let copay_source_date = from_check.then(|| checked.map(|(_, day)| day)).flatten();
    let owes_now = cents(&money["owes_now_cents"]);
    let pending = cents(&money["pending_cents"]);
    let unassigned = cents(&money["unassigned_cents"]);
    let overpaid = cents(&money["overpaid_cents"]);
    let credit = usable_unapplied + overpaid;
    let denied = money["denied"] == true;
    // Everything on the ledger that is neither an insurer payment nor the patient's.
    let adjusted = if posted {
        total - balance - patient_credit - insurer_paid
    } else {
        0
    };

    let views = match account.as_ref().filter(|_| posted && insured && opt.claims) {
        Some(b) => claim_views(tx, a, b.id).await?,
        None => vec![],
    };
    let live: Vec<&ClaimView> = views.iter().filter(|c| c.status() != "void").collect();
    // Keep the displayed claim aligned with the claim used to compute the account balance.
    let latest = live
        .iter()
        .copied()
        .find(|c| c.row["id"] == money["claim_id"]);
    let open = latest.filter(|c| c.open());
    // Where Claim.MD stands on the claim this card words. A correction the clearinghouse holds
    // is staff's work, not a wait on the insurer, and a claim Claim.MD has only acknowledged has
    // not reached the payer at all. Read for the one claim the card is about, never per row.
    let claimmd = match latest
        .and_then(|c| c.row["id"].as_str())
        .and_then(|id| Uuid::parse_str(id).ok())
        .filter(|_| opt.claims && posted && insured)
    {
        Some(claim) => claims::claim_md_positions(tx, a.tenant_id, &[claim])
            .await?
            .remove(&claim)
            .unwrap_or(Value::Null),
        None => Value::Null,
    };

    // Check unsent claims against the same frozen values the manual flow reviews.
    let mut issues: Vec<Value> = vec![];
    if let Some(c) = open.filter(|c| matches!(c.status(), "draft" | "ready")) {
        let id = Uuid::parse_str(c.row["id"].as_str().unwrap_or(""))
            .map_err(|_| Error::Invalid("invalid claim"))?;
        let claim = claims::claim_row(tx, a, id).await?;
        issues = claims::preflight(&claim)?
            .iter()
            .map(|issue| plain_issue(issue))
            .collect();
    }

    let restricted = posted && insured && !opt.claims;

    // Whether the account has been corrected after a claim was sent. The claim row itself is
    // frozen when it is prepared, so a sent claim's snapshot total is the charge total the
    // insurer saw; if the account now differs, the sent claim no longer says what the visit cost.
    let latest_sent_total: Option<i64> = live
        .iter()
        .filter(|c| {
            matches!(
                c.status(),
                "submitted" | "accepted" | "adjudicated" | "rejected"
            )
        })
        .filter_map(|c| c.row["snapshot_total_cents"].as_i64())
        .next_back();
    let latest_sent_lines: Option<Value> = live
        .iter()
        .filter(|c| {
            matches!(
                c.status(),
                "submitted" | "accepted" | "adjudicated" | "rejected"
            )
        })
        .map(|c| c.row["snapshot_lines"].clone())
        .next_back();
    // A sent claim no longer matches the visit when the total or any charge line changed since.
    let charges_corrected_after_send = account
        .as_ref()
        .map(|b| {
            latest_sent_total.is_some_and(|sent| b.total_cents != sent)
                || latest_sent_lines
                    .as_ref()
                    .is_some_and(|lines| !lines.is_null() && *lines != b.content["lines"])
        })
        .unwrap_or(false);

    let (state, waiting_on) = match &account {
        None => ("add_charges", "staff"),
        Some(_) if void => ("add_charges", "staff"),
        Some(_) if charges_corrected_after_send => ("correct_claim", "staff"),
        Some(_) => state_of_with_claimmd(&money, !issues.is_empty(), opt.claims, &claimmd),
    };
    // What would hold the claim up, named while the charges can still be changed in one place
    // rather than after they post.
    let before_posting = match (&account, visit_id) {
        (Some(b), Some(v)) if b.status == "draft" && insured => {
            let on_encounter = sqlx::query_scalar::<_, Value>(
                "SELECT diagnoses FROM visit_diagnoses WHERE tenant_id=$1 AND visit_id=$2",
            )
            .bind(a.tenant_id)
            .bind(v)
            .fetch_optional(&mut **tx)
            .await?
            .and_then(|d| d.as_array().map(Vec::len))
            .unwrap_or(0);
            before_posting(insured, &b.content["lines"], on_encounter)
        }
        _ => vec![],
    };
    // The day the clearinghouse said the claim needs correcting, for the sentence that names
    // where to release a claim Claim.MD is holding for approval.
    let claimmd_since = claimmd["correction"]["at"]
        .as_str()
        .or_else(|| claimmd["received_at"].as_str())
        .map(|value| value.to_owned());

    let insurance_status = if !insured {
        "none"
    } else if !posted {
        "not_billed"
    } else if restricted {
        "restricted"
    } else {
        match latest {
            None if !electronic => "outside",
            None => "not_sent",
            Some(c) => match c.status() {
                "draft" | "ready" => "not_sent",
                "submitted" | "accepted" if claimmd["needs_correction"] == true => "correction",
                "submitted" | "accepted" if claimmd["acknowledged"] == true => "received",
                "submitted" | "accepted" => "waiting",
                "rejected" => "rejected",
                "adjudicated" if denied => "denied",
                _ => "answered",
            },
        }
    };

    let claim_json = latest.map(|c| {
        let mut row = c.row.clone();
        let payer_acceptance_recorded = matches!(c.status(), "accepted" | "adjudicated")
            || row["payer_control_number"]
                .as_str()
                .is_some_and(|number| !number.trim().is_empty());
        if let Some(object) = row.as_object_mut() {
            object.remove("head");
            object.remove("snapshot_total_cents");
            object.remove("snapshot_lines");
            if !opt.technical {
                object.remove("control_number");
                object.remove("version");
                object.remove("payer_control_number");
            }
        }
        row["payer_acceptance_recorded"] = json!(payer_acceptance_recorded);
        row["issues"] = json!(issues);
        if claimmd.is_object() {
            row["claimmd_position"] = claimmd.clone();
        }
        if let Some(answer) = &c.answer {
            row["answer"] = json!({"paid_cents":answer.paid,"patient_responsibility_cents":answer.patient_responsibility,"denied":answer.denied,"payment_date":answer.payment_date,"remittance_id":answer.remittance_id});
        }
        row
    });

    let mut out = json!({
        "patient_id": p,
        "visit": visit_row.as_ref().map(|row| json!({"id":row.0,"status":row.1,"appointment_id":row.2,"starts_at":row.3,"clinician_id":row.4,"clinician_name":row.5})),
        "account": account.as_ref().map(|b| json!({"id":b.id,"status":b.status,"version":b.version,"total_cents":b.total_cents,"service_date":b.content["service_date"],"has_visit":b.content["visit_id"].is_string()})),
        "state": state,
        "waiting_on": waiting_on,
        "before_posting": before_posting,
        "insurance": {
            "insured": insured,
            "insurer": insurer,
            "electronic": electronic,
            "status": insurance_status,
            "paid_cents": insurer_paid,
            "adjusted_cents": adjusted,
            "pending_cents": pending,
            "unassigned_cents": unassigned,
            "sent_on": latest.map(|c| c.row["sent_on"].clone()),
            // Claim.MD's own words, carried to the visit card so the correction is named where
            // staff read it and not only inside the claim.
            "claimmd": claimmd.is_object().then(|| json!({
                "needs_correction": claimmd["needs_correction"] == true,
                "acknowledged": claimmd["acknowledged"] == true,
                "message": claimmd["correction"]["message"].as_str().filter(|message| !message.trim().is_empty()),
                "since": claimmd_since,
                "correction": claimmd["correction"],
            })),
        },
        "patient": {
            "copay_cents": expected,
            "copay_paid_cents": expected.map(|copay| copay.min(paid_at_desk.net_received)),
            "copay_due_cents": expected.map(|copay| (copay - paid_at_desk.net_received).max(0)),
            "paid_above_copay_cents": expected.map(|copay| (paid_at_desk.net_received - copay).max(0)),
            "received_cents": paid_at_desk.net_received,
            "receipts_applied_cents": receipts_applied,
            "other_payments_cents": patient_payments - receipts_applied,
            // Everything the patient paid that is not the copay itself: money taken at the
            // desk beyond the copay, plus payments recorded straight on the visit.
            "other_patient_payments_cents": match expected {
                Some(copay) => (paid_at_desk.net_received - copay).max(0),
                None => paid_at_desk.net_received,
            } + patient_payments
                - receipts_applied,
            "adjustment_cents": patient_credit - patient_payments,
            "unapplied_cents": usable_unapplied,
            "overpaid_cents": overpaid,
            "credit_cents": credit,
            "receipt_needs_review": paid_at_desk.needs_review,
            "responsibility_cents": responsibility,
            "responsibility_source": source,
            "owes_now_cents": owes_now,
            "copay_from_insurer_check": copay_source_date.is_some(),
            "copay_source_date": copay_source_date,
        },
        "charges_cents": account.as_ref().filter(|_| !void).map(|b| b.total_cents),
        "balance_cents": posted.then_some(balance),
        "claim": claim_json,
        "claim_count": live.len(),
        "receipts": paid_at_desk.items.iter().map(|row| json!({"id":row["id"],"appointment_id":row["appointment_id"],"amount_cents":row["amount_cents"],"method":if row["hosted_checkout"].is_object() { json!("card") } else { row["method"].clone() },"occurred_on":row["occurred_on"],"payment_group_id":row["payment_group_id"],"reference":row["reference"],"voided":row["voided"],"refunded_cents":cents(&row["hosted_checkout"]["refunded_cents"])+cents(&row["cash_refunded_cents"]),"needs_review":row["hosted_checkout"]["status"]=="needs_review" || cents(&row["reversed_cents"])>0,"test":row["hosted_checkout"]["livemode"]==false})).collect::<Vec<_>>(),
    });

    if opt.claims && state == "claim_cancelled" {
        if let (Some(account), Some(source)) = (account.as_ref(), views.last()) {
            let source_id = serde_json::from_value(source.row["id"].clone())
                .map_err(|_| Error::Invalid("invalid canceled claim"))?;
            let source = claims::claim_row(tx, a, source_id).await?;
            if let Some((reason, status_id)) =
                canceled_claim_block_reason(tx, a, account, &source).await?
            {
                out["canceled_claim_blocked"] = json!(reason);
                out["canceled_claim_status_id"] = json!(status_id);
            } else {
                out["canceled_claim"] = json!({"id":source.id,"version":source.version});
            }
        }
    }
    if let Some(id) = out["claim"]["id"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .filter(|_| opt.claims)
    {
        if let Some(evidence) = crate::visit_claim_handoff::evidence(tx, a, id).await? {
            out["claim_handoff"] = evidence;
        }
    }
    if let Some(b) = account.as_ref().filter(|_| opt.history) {
        if let Some(status) = crate::automatic_invoices::current_status(tx, a, b, &out).await? {
            out["automatic_invoice"] = status;
        }
        let statements: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',i.id,'created_at',i.created_at,'amount_due_cents',i.snapshot->'amount_due_cents','responsibility_cents',i.snapshot->'responsibility_cents','account_version',i.account_version) FROM patient_invoice_snapshots i WHERE i.tenant_id=$1 AND i.patient_id=$2 AND i.account_id=$3 ORDER BY i.created_at DESC,i.id LIMIT 100")
            .bind(a.tenant_id).bind(p).bind(b.id).fetch_all(&mut **tx).await?;
        let current = statements.first().is_some_and(|row| {
            row["account_version"].as_i64() == Some(b.version)
                && row["amount_due_cents"].as_i64() == Some(owes_now)
        });
        out["statement"] = json!({"current":current,"latest_id":statements.first().map(|row| row["id"].clone()),"count":statements.len()});
        out["timeline"] =
            json!(timeline(tx, a, b, &views, &paid_at_desk.items, &statements).await?);
    }
    if opt.technical {
        out["technical"] = json!({
            "account_id": account.as_ref().map(|b| b.id),
            "account_version": account.as_ref().map(|b| b.version),
            "source_history_id": account.as_ref().and_then(|b| b.source_history_id),
            "coverage_verification": coverage.as_ref().map(|(_, content, _)| content["verification"].clone()),
            "member_id": coverage.as_ref().map(|(_, content, _)| content["member_id"].clone()),
            "payer_code": coverage.as_ref().map(|(_, _, payer)| payer["payer_code"].clone()),
            "claims": views.iter().map(|c| json!({"id":c.row["id"],"control_number":c.row["control_number"],"version":c.row["version"],"status":c.row["status"],"payer_control_number":c.row["payer_control_number"]})).collect::<Vec<_>>(),
        });
    }
    Ok(out)
}

/// One list of what happened to the visit's billing, oldest first.
async fn timeline(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    b: &billing::Account,
    claims: &[ClaimView],
    receipts: &[Value],
    statements: &[Value],
) -> Result<Vec<Value>> {
    let mut events: Vec<Value> = vec![];
    let revisions: Vec<(i64, chrono::DateTime<chrono::Utc>, String, Value)> = sqlx::query_as("SELECT version,created_at,snapshot->>'status',snapshot->'content' FROM billing_account_revisions WHERE tenant_id=$1 AND account_id=$2 ORDER BY version LIMIT 2000")
        .bind(a.tenant_id).bind(b.id).fetch_all(&mut **tx).await?;
    let mut prior: Option<(&str, &Value)> = None;
    for (version, at, status, content) in &revisions {
        let code = match prior {
            None => Some("charges_added"),
            Some((before, _)) if before != status.as_str() && status == "posted" => {
                Some("charges_posted")
            }
            Some((before, _)) if before != status.as_str() && status == "void" => {
                Some("charges_removed")
            }
            Some((_, before)) if status == "draft" && before != content => Some("charges_changed"),
            _ => None,
        };
        if let Some(code) = code {
            events.push(json!({"at":at,"group":"charges","code":code,"amount_cents":b.total_cents,"version":version}));
        }
        prior = Some((status.as_str(), content));
    }
    let coverage_application: Option<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('at',created_at,'group','insurance','code','coverage_applied','version',account_version)
         FROM billing_account_coverage_applications WHERE tenant_id=$1 AND account_id=$2",
    )
    .bind(a.tenant_id)
    .bind(b.id)
    .fetch_optional(&mut **tx)
    .await?;
    events.extend(coverage_application);
    for row in receipts {
        events.push(json!({"at":row["created_at"],"group":"payments","code":if row["voided"]==true {"receipt_voided"} else {"payment_received"},"amount_cents":row["amount_cents"],"method":if row["hosted_checkout"].is_object() { json!("card") } else { row["method"].clone() },"occurred_on":row["occurred_on"],"receipt_id":row["id"],"appointment_id":row["appointment_id"],"refunded_cents":cents(&row["hosted_checkout"]["refunded_cents"])+cents(&row["cash_refunded_cents"])}));
    }
    let entries: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',e.id,'at',e.created_at,'kind',e.kind,'effect_cents',e.effect_cents,'party',CASE WHEN e.kind='reversal' THEN o.content->>'party' ELSE e.content->>'party' END,'method',e.content->>'method','occurred_on',e.content->>'occurred_on','reverses_id',e.reverses_id,'reversed',EXISTS(SELECT 1 FROM billing_entries r WHERE r.tenant_id=e.tenant_id AND r.reverses_id=e.id),'from_receipt',e.content ? 'copay_receipt_id','from_insurer_response',e.content ? 'remittance_id','remittance_id',e.content->>'remittance_id','card',(e.content ? 'managed_payment_id' OR e.content ? 'hosted_copay_operation_id' OR e.content ? 'invoice_checkout_operation_id'),'test',coalesce(e.content->>'test_mode','false')='true','reference',e.content->>'reference','reason',e.content->>'reason') FROM billing_entries e LEFT JOIN billing_entries o ON o.tenant_id=e.tenant_id AND o.account_id=e.account_id AND o.id=e.reverses_id WHERE e.tenant_id=$1 AND e.account_id=$2 ORDER BY e.created_at,e.id LIMIT 2000")
        .bind(a.tenant_id).bind(b.id).fetch_all(&mut **tx).await?;
    for entry in entries {
        let party = entry["party"].as_str().unwrap_or("");
        let kind = entry["kind"].as_str().unwrap_or("");
        let (group, code) = match (kind, party) {
            ("payment", "patient") if entry["from_receipt"] == true => {
                ("payments", "receipt_applied")
            }
            ("payment", "patient") => ("payments", "patient_payment"),
            ("payment", "insurer") => ("insurance", "insurer_payment"),
            ("payment", _) => ("payments", "other_payment"),
            ("adjustment_credit", "insurer") => ("insurance", "insurer_adjustment"),
            ("adjustment_credit", _) => ("payments", "adjustment_credit"),
            ("adjustment_debit", _) if entry["card"] == true => ("payments", "card_refund"),
            ("adjustment_debit", _) => ("payments", "adjustment_debit"),
            (_, "insurer") => ("insurance", "reversal"),
            _ => ("payments", "reversal"),
        };
        let mut event = entry.clone();
        event["group"] = json!(group);
        event["code"] = json!(code);
        event["entry_id"] = entry["id"].clone();
        event["amount_cents"] = json!(cents(&entry["effect_cents"]).abs());
        events.push(event);
    }
    for c in claims {
        let id = Uuid::parse_str(c.row["id"].as_str().unwrap_or(""))
            .map_err(|_| Error::Invalid("invalid claim"))?;
        let rows: Vec<(i64, chrono::DateTime<chrono::Utc>, String, Value)> = sqlx::query_as("SELECT version,created_at,snapshot->>'status',evidence FROM claim_revisions WHERE tenant_id=$1 AND claim_id=$2 ORDER BY version LIMIT 500")
            .bind(a.tenant_id).bind(id).fetch_all(&mut **tx).await?;
        let mut before: Option<String> = None;
        for (_, at, status, evidence) in rows {
            let code = match (before.as_deref(), status.as_str()) {
                (None, _) if c.row["crossover"] == true => Some("claim_crossover"),
                (None, _) if evidence["prepared"] == "automatic" => Some("claim_prepared_auto"),
                (None, _) => Some("claim_prepared"),
                (Some(old), new) if old == new && new == "draft" => Some("claim_changed"),
                (Some(old), new) if old == new => None,
                (_, "ready") => Some("claim_ready"),
                (_, "submitted") => Some("claim_sent"),
                (_, "accepted") => Some("claim_accepted"),
                (_, "rejected") => Some("claim_rejected"),
                (_, "adjudicated") => Some("claim_answered"),
                (_, "void") => Some("claim_cancelled"),
                _ => Some("claim_changed"),
            };
            if let Some(code) = code {
                events.push(json!({"at":at,"group":"insurance","code":code,"claim_id":id,"insurer":c.row["payer_name"],"frequency":c.row["frequency"],"secondary":c.row["secondary"],"event_date":evidence["event_date"],"patient_responsibility_cents":evidence["patient_responsibility_cents"],"remittance_id":evidence["remittance_id"]}));
            }
            before = Some(status);
        }
    }
    let deliveries:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('at',d.created_at,'group','statements','code','statement_sent','invoice_id',d.invoice_id,'channel',d.channel,'actor_label',coalesce(nullif(u.display_name,''),u.email)) FROM billing_statement_deliveries d JOIN patient_invoice_snapshots i ON i.tenant_id=d.tenant_id AND i.id=d.invoice_id JOIN browser_users u ON u.tenant_id=d.tenant_id AND u.id=d.actor_id WHERE d.tenant_id=$1 AND i.patient_id=$2 AND i.account_id=$3 ORDER BY d.created_at,d.id").bind(a.tenant_id).bind(b.patient_id).bind(b.id).fetch_all(&mut **tx).await?;
    events.extend(deliveries);
    for row in statements {
        events.push(json!({"at":row["created_at"],"group":"statements","code":"statement","amount_cents":row["amount_due_cents"],"invoice_id":row["id"]}));
    }
    // Timestamps arrive in two JSON spellings; order by the instant, not the text.
    // Records written in one step share an instant; keep them in the order they happen.
    events.sort_by_cached_key(|event| {
        let rank = match event["code"].as_str().unwrap_or("") {
            code if code.starts_with("charges") => 0,
            "payment_received" | "receipt_voided" => 1,
            "receipt_applied" => 2,
            "insurer_payment" => 3,
            "insurer_adjustment" => 4,
            code if code.starts_with("claim") => 5,
            _ => 6,
        };
        (
            event["at"]
                .as_str()
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                .map(|at| at.timestamp_micros())
                .unwrap_or(0),
            rank,
        )
    });
    Ok(events)
}

fn looks_like_icd(code: &str) -> bool {
    let bytes = code.as_bytes();
    let (head, tail) = match code.split_once('.') {
        Some((head, tail)) => (head, Some(tail)),
        None => (code, None),
    };
    head.len() == 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1].is_ascii_digit()
        && bytes[2].is_ascii_alphanumeric()
        && tail.is_none_or(|tail| {
            (1..=4).contains(&tail.len()) && tail.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}
/// Diagnosis codes and per-line pointers from the charge lines, the way the claim form
/// fills them in: a pasted "G81.14 - Spastic hemiplegia" keeps only the code.
fn charge_diagnoses(lines: &[Value]) -> (Vec<String>, Vec<Vec<usize>>) {
    let mut codes: Vec<String> = vec![];
    let mut pointers = vec![];
    for line in lines {
        let mut own: Vec<String> = vec![];
        for saved in line["diagnosis_codes"].as_array().into_iter().flatten() {
            for part in saved.as_str().unwrap_or("").split(',') {
                let text = part.trim();
                if text.is_empty() {
                    continue;
                }
                let first = text.split_whitespace().next().unwrap_or("");
                let code = if looks_like_icd(first) {
                    first.to_ascii_uppercase()
                } else if !text.contains(char::is_whitespace) {
                    text.to_owned()
                } else {
                    continue;
                };
                if !own.contains(&code) {
                    own.push(code);
                }
            }
        }
        let mut line_pointers = vec![];
        for code in own {
            let index = match codes.iter().position(|known| *known == code) {
                Some(index) => index,
                None if codes.len() < 12 && code.len() <= 20 => {
                    codes.push(code);
                    codes.len() - 1
                }
                None => continue,
            };
            line_pointers.push(index + 1);
        }
        // More than four diagnoses on one charge needs a person to choose which apply.
        if line_pointers.len() > 4 {
            line_pointers.clear();
        }
        pointers.push(line_pointers);
    }
    (codes, pointers)
}
fn joined_address(demographics: Option<&Value>) -> String {
    let address = demographics.map(|v| &v["address"]).unwrap_or(&Value::Null);
    ["line1", "line2", "city", "region", "postal_code", "country"]
        .iter()
        .filter_map(|key| address[*key].as_str())
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}
fn claim_provider(
    providers: &[(Uuid, String, String)],
    clinician: Option<Uuid>,
) -> Option<&(Uuid, String, String)> {
    match clinician {
        Some(id) => providers.iter().find(|row| row.0 == id),
        None if providers.len() == 1 => providers.first(),
        None => None,
    }
}

/// The claim details a person would otherwise type: provider and place from the practice
/// directory, tax ID from the practice's billing organization, addresses and policy holder
/// from the chart and coverage, diagnoses from the charge lines.
///
/// `pub(crate)` rather than private because the refill pass in `claims::refill_draft` runs this
/// same gatherer against current records before a draft is shown, checked or released. Keeping one
/// function means the field a person is asked to type and the field a refill supplies can never
/// disagree. A refill copies only the detail fields it names — `billing_provider_name`,
/// `billing_npi`, `tax_id` with its `tax_id_type`, `billing_address`, `rendering_npi`,
/// `patient_address`, `subscriber_address` and `subscriber_birth_date` — and never takes
/// `place_of_service`, diagnoses or notes from a fresh run.
pub(crate) async fn claim_defaults(
    pool: &PgPool,
    a: &Actor,
    p: Uuid,
    b: &billing::Account,
    claim_rendering_npi: Option<&str>,
) -> Result<ClaimContent> {
    let clinician: Option<Uuid> =
        match b.content["visit_id"]
            .as_str()
            .and_then(|v| Uuid::parse_str(v).ok())
        {
            Some(v) => sqlx::query_scalar(
                "SELECT clinician_id FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND id=$3",
            )
            .bind(a.tenant_id)
            .bind(p)
            .bind(v)
            .fetch_optional(pool)
            .await?,
            None => None,
        };
    let providers: Vec<_> =
        crate::claimmd_eligibility::provider_choices(pool, a.tenant_id, clinician)
            .await?
            .into_iter()
            .map(|p| (p.id, p.display_name, p.npi))
            .collect();
    let provider = if b.content["visit_id"].as_str().is_some() && clinician.is_none() {
        None
    } else {
        claim_provider(&providers, clinician)
    };
    let facilities: Vec<(String, String)> = sqlx::query_as("SELECT name,address FROM practice_facilities WHERE tenant_id=$1 AND active ORDER BY name,id LIMIT 2")
        .bind(a.tenant_id).fetch_all(pool).await?;
    let facility = (facilities.len() == 1).then(|| &facilities[0]);
    // The tax ID is used only when the practice has exactly one active billing organization.
    let organizations = crate::practice_billing::choices(pool, a.tenant_id).await?;
    let mut tax_id = String::new();
    let mut tax_id_type = String::new();
    let mut organization_name = String::new();

    if let [organization] = organizations.as_slice() {
        organization_name = organization["name"].as_str().unwrap_or_default().to_owned();
        if let Some(id) = organization["id"]
            .as_str()
            .and_then(|v| Uuid::parse_str(v).ok())
        {
            if let Some((kind, secret)) =
                crate::practice_billing::tax_identity(pool, a.tenant_id, id).await?
            {
                tax_id = secret.expose().to_owned();
                // The claim must say how this tax ID was issued: a practice
                // billing under a Social Security number is not sent as an EIN.
                tax_id_type = match kind.as_str() {
                    "S" => "S",
                    _ => "E",
                }
                .to_owned();
            }
        }
    }
    let demographics: Option<Value> = sqlx::query_scalar(
        "SELECT content FROM patient_demographics WHERE tenant_id=$1 AND patient_id=$2",
    )
    .bind(a.tenant_id)
    .bind(p)
    .fetch_optional(pool)
    .await?;
    let birth_date: Option<NaiveDate> =
        sqlx::query_scalar("SELECT birth_date FROM patients WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(p)
            .fetch_optional(pool)
            .await?
            .flatten();
    // The place of service follows the practice's most recent claim; a first claim uses
    // 11 (office). Staff see and can change it before anything is sent.
    let place: Option<String> = sqlx::query_scalar("SELECT content->>'place_of_service' FROM ehr_claims WHERE tenant_id=$1 AND status<>'void' AND content->>'place_of_service' ~ '^[0-9]{2}$' ORDER BY created_at DESC,id DESC LIMIT 1")
        .bind(a.tenant_id).fetch_optional(pool).await?.flatten();
    let coverage = &b
        .coverage_snapshot
        .as_ref()
        .ok_or(Error::Invalid("insurance coverage is required for a claim"))?["coverage"]
        ["content"];
    let own_policy = coverage["relationship"] == "self";
    let patient_address = joined_address(demographics.as_ref());
    let (diagnosis_codes, line_diagnosis_pointers) = charge_diagnoses(
        b.content["lines"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    );
    let today = chrono::Utc::now().date_naive();
    // What the front desk filled in on the encounter form beside the charges.
    let details: crate::encounter_claim::EncounterClaimDetails =
        serde_json::from_value(b.content["claim_details"].clone()).unwrap_or_default();
    let rendering_npi = if let Some(saved) = claim_rendering_npi.filter(|npi| !npi.is_empty()) {
        saved.to_owned()
    } else if details.rendering_npi.is_empty() {
        provider.map(|row| row.2.clone()).unwrap_or_default()
    } else {
        details.rendering_npi.clone()
    };
    // A single billing entity may be configured to bill under the rendering clinician's NPI.
    // With multiple active entities the billing identity must be chosen explicitly on the claim.
    let individual_billing_npi = if crate::practice_admin::valid_npi(&rendering_npi) {
        rendering_npi.as_str()
    } else {
        ""
    };
    let billing_npi = match organizations.as_slice() {
        [] => individual_billing_npi.to_owned(),
        [organization] => organization["npi"]
            .as_str()
            .filter(|v| !v.is_empty())
            .unwrap_or(individual_billing_npi)
            .to_owned(),
        _ => String::new(),
    };
    Ok(ClaimContent {
        billing_provider_name: facility
            .map(|row| row.0.clone())
            .filter(|name| !name.trim().is_empty())
            .or_else(|| Some(organization_name).filter(|name| !name.is_empty()))
            .or_else(|| provider.map(|row| row.1.clone()))
            .unwrap_or_default(),
        billing_npi,
        tax_id,
        tax_id_type,
        billing_address: facility.map(|row| row.1.clone()).unwrap_or_default(),
        rendering_npi,
        subscriber_address: if own_policy {
            patient_address.clone()
        } else {
            String::new()
        },
        patient_address,
        subscriber_birth_date: coverage["subscriber_birth_date"]
            .as_str()
            .and_then(|v| NaiveDate::parse_from_str(v, "%Y-%m-%d").ok())
            .or(birth_date.filter(|_| own_policy))
            .filter(|date| *date <= today),
        place_of_service: details.place_of_service_or(&place.unwrap_or_else(|| "11".into())),
        diagnosis_codes,
        line_diagnosis_pointers,
        external_control_number: String::new(),
        notes: String::new(),
        synthetic_test: false,
        encounter: details.for_claim(),
    })
}

/// Whether the actor is a delegated partner or platform support session, not practice staff.
async fn delegated(tx: &mut Transaction<'_, Postgres>, a: &Actor) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM partner_support_sessions WHERE tenant_id=$1 AND grant_id=$2)",
    )
    .bind(a.tenant_id)
    .bind(a.sub)
    .fetch_one(&mut **tx)
    .await?)
}
#[derive(Clone, Copy)]
struct CanceledClaimSource {
    id: Uuid,
    version: i64,
    account_version: Option<i64>,
}

const CANCELED_CHANGED: &str =
    "The canceled claim changed. Reopen this encounter before preparing another claim.";
const CANCELED_DELIVERY: &str =
    "Prior delivery or payer activity needs review before a new claim can be prepared.";

#[derive(serde::Serialize)]
pub(crate) struct CanceledClaimRecovery {
    claim_id: Uuid,
    version: i64,
    account_id: Uuid,
    account_version: i64,
    encounter_id: Uuid,
}

/// Only the newest void on the current posted account can offer recovery in the
/// worklist. The draft creation path repeats the checks while holding the tenant lock.
pub(crate) async fn canceled_claim_recoveries(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    ids: &[Uuid],
) -> Result<std::collections::HashMap<Uuid, CanceledClaimRecovery>> {
    let mut recovery = std::collections::HashMap::new();
    if ids.is_empty()
        || a.scheduling().is_err()
        || !crate::access_policies::allows(tx, a, "billing", "create").await?
        || !crate::access_policies::allows(tx, a, "claims", "create").await?
    {
        return Ok(recovery);
    }
    let candidates: Vec<(Uuid, Uuid, Uuid, Uuid)> = sqlx::query_as(
        "SELECT c.id,b.id,b.patient_id,b.visit_id
         FROM ehr_claims c
         JOIN billing_accounts b ON b.tenant_id=c.tenant_id AND b.id=c.account_id AND b.patient_id=c.patient_id
         WHERE c.tenant_id=$1 AND c.id=ANY($2) AND c.status='void'
           AND b.status='posted' AND b.visit_id IS NOT NULL AND b.coverage_snapshot IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ehr_claims current
               WHERE current.tenant_id=c.tenant_id AND current.account_id=c.account_id
                 AND (current.status<>'void' OR (current.created_at,current.id)>(c.created_at,c.id)))",
    )
    .bind(a.tenant_id)
    .bind(ids)
    .fetch_all(&mut **tx)
    .await?;
    for (claim_id, account_id, patient_id, encounter_id) in candidates {
        let account = claims::account(tx, a, account_id, Some(patient_id)).await?;
        let claim = claims::claim_row(tx, a, claim_id).await?;
        if canceled_claim_block_reason(tx, a, &account, &claim)
            .await?
            .is_none()
        {
            recovery.insert(
                claim_id,
                CanceledClaimRecovery {
                    claim_id,
                    version: claim.version,
                    account_id,
                    account_version: account.version,
                    encounter_id,
                },
            );
        }
    }
    Ok(recovery)
}

async fn canceled_claim_block_reason(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    account: &billing::Account,
    claim: &claims::Claim,
) -> Result<Option<(&'static str, Uuid)>> {
    let blocked = |reason| Ok(Some((reason, claim.id)));
    let billed_account = &claim.snapshot["account"];
    let original_coverage = &billed_account["coverage_snapshot"];
    let visit = &account.content["visit_id"];
    if claim.status != "void"
        || claim.account_id != account.id
        || claim.patient_id != account.patient_id
        || claim.frequency != "original"
        || claim.parent_id.is_some()
        || claim.source_history_id.is_some()
        || claim.snapshot["coordination_of_benefits"].is_object()
    {
        return blocked("Only a locally canceled original claim can be copied here. Review the saved claim history.");
    }
    let Some(coverage) = account.coverage_snapshot.as_ref() else {
        return blocked("The posted charges do not have insurance on file.");
    };
    let payer: Option<Uuid> = serde_json::from_value(coverage["payer"]["id"].clone()).ok();
    if payer != Some(claim.payer_id)
        || coverage["payer"]["id"] != original_coverage["payer"]["id"]
        || coverage["payer"]["content"]["payer_code"]
            != original_coverage["payer"]["content"]["payer_code"]
        || coverage["payer"]["content"]["payer_code"]
            .as_str()
            .is_none_or(|code| code.trim().is_empty())
        || coverage["coverage"]["id"] != original_coverage["coverage"]["id"]
    {
        return blocked("The canceled claim and posted charges do not use the same insurance. Review the saved coverage first.");
    }
    let visit_id: Option<Uuid> = serde_json::from_value(visit.clone()).ok();
    if account.status != "posted"
        || visit_id.is_none()
        || billed_account["content"]["visit_id"] != *visit
    {
        return blocked(
            "Open the original signed encounter with posted charges before preparing a new claim.",
        );
    }
    let (signed, canceled_locally, prior_delivery): (bool, bool, Option<Uuid>) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM visits v
             WHERE v.tenant_id=$1 AND v.patient_id=$2 AND v.id=$3 AND v.status='signed'),
         EXISTS(SELECT 1 FROM claim_revisions r
             WHERE r.tenant_id=$1 AND r.claim_id=$5 AND r.version=$6 AND r.snapshot->>'status'='void'
               AND (r.evidence->>'action'='void_draft' OR r.evidence->'voided_after_charge_correction'='true'::jsonb)),
         (SELECT c.id FROM ehr_claims c
             JOIN billing_accounts b ON b.tenant_id=c.tenant_id AND b.id=c.account_id AND b.patient_id=c.patient_id
             WHERE c.tenant_id=$1 AND c.patient_id=$2
               AND (b.id=$4 OR b.visit_id=$3)
               AND (c.status IN ('submitted','accepted','rejected','adjudicated')
               OR btrim(c.payer_control_number)<>'' OR c.source_history_id IS NOT NULL
               OR EXISTS(SELECT 1 FROM claim_revisions r WHERE r.tenant_id=c.tenant_id AND r.claim_id=c.id
                   AND (r.snapshot->>'status' IN ('submitted','accepted','rejected','adjudicated')
                     OR r.evidence->>'action'='record_submission' OR btrim(coalesce(r.snapshot->>'payer_control_number',''))<>''))
               OR EXISTS(SELECT 1 FROM era_postings p WHERE p.tenant_id=c.tenant_id AND p.claim_id=c.id)
               OR EXISTS(SELECT 1 FROM edi_submissions s WHERE s.tenant_id=c.tenant_id AND s.claim_id=c.id
                   AND (s.status='delivered' OR s.delivered_claim_version IS NOT NULL
                     OR s.technical_status<>'pending' OR s.payer_outcome<>'pending'
                     OR EXISTS(SELECT 1 FROM edi_delivery_jobs j WHERE j.tenant_id=s.tenant_id AND j.submission_id=s.id
                         AND (j.status<>'cancelled' OR j.attempts>0 OR j.receipt_reference IS NOT NULL))
                     OR EXISTS(SELECT 1 FROM audit_events e WHERE e.tenant_id=s.tenant_id AND e.resource_id=s.id AND e.action='edi.file_export')
                     OR EXISTS(SELECT 1 FROM edi_acknowledgments k WHERE k.tenant_id=s.tenant_id AND k.submission_id=s.id)
                     OR EXISTS(SELECT 1 FROM edi_277ca_reviews k WHERE k.tenant_id=s.tenant_id AND k.submission_id=s.id))))
             ORDER BY (btrim(c.payer_control_number)<>'' OR c.status IN ('accepted','adjudicated')) DESC,
                      c.created_at DESC,c.id DESC LIMIT 1)",
    )
    .bind(a.tenant_id)
    .bind(account.patient_id)
    .bind(visit_id)
    .bind(account.id)
    .bind(claim.id)
    .bind(claim.version)
    .fetch_one(&mut **tx)
    .await?;
    if !signed {
        return blocked("Sign the original encounter before preparing a new claim.");
    }
    if let Some(status_id) = prior_delivery {
        return Ok(Some((CANCELED_DELIVERY, status_id)));
    }
    if !canceled_locally {
        return blocked("SunCharts could not verify that this claim was canceled locally. Review the saved claim history.");
    }
    Ok(None)
}

/// Prepares the visit's insurance claim draft when its charges are posted and no claim
/// exists yet. The draft is the same record the claim form saves, attributed to the person
/// whose action or page opened it; it is never marked ready or sent here. Calling it again
/// returns the claim that already exists. After a person cancelled the claim, a new one is
/// prepared only when they ask (`again`), keeping the details they had corrected.
pub(crate) async fn prepare_claim(
    pool: &PgPool,
    a: &Actor,
    p: Uuid,
    account_id: Uuid,
    again: bool,
) -> Result<Value> {
    prepare_claim_with_source(pool, a, p, account_id, again, None).await
}

async fn prepare_claim_with_source(
    pool: &PgPool,
    a: &Actor,
    p: Uuid,
    account_id: Uuid,
    again: bool,
    canceled: Option<CanceledClaimSource>,
) -> Result<Value> {
    a.scheduling()?;
    let mut tx = pool.begin().await?;
    let account = claims::account(&mut tx, a, account_id, Some(p)).await?;
    tx.commit().await?;
    // A delegated support session acts with the owner's authority and may prepare the claim when
    // it asks; the claim's revision records the session as the one who prepared it. The screen
    // never prepares automatically on a support session's behalf.
    let skipped = |reason: &str| {
        if canceled.is_some() {
            Err(Error::Conflict(CANCELED_CHANGED))
        } else {
            Ok(json!({"outcome":"not_needed","reason":reason}))
        }
    };
    if account.status != "posted" {
        return skipped("charges_not_posted");
    }
    if canceled
        .and_then(|source| source.account_version)
        .is_some_and(|version| version != account.version)
    {
        return Err(Error::Conflict(
            "The posted charges changed. Reopen this encounter before preparing a new claim.",
        ));
    }
    let Some(snapshot) = account.coverage_snapshot.as_ref() else {
        return skipped("self_pay");
    };
    if snapshot["payer"]["content"]["payer_code"]
        .as_str()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return skipped("no_payer_id");
    }
    let mut content = claim_defaults(pool, a, p, &account, None).await?;
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let b = claims::account(&mut tx, a, account_id, Some(p)).await?;
    if b.status != "posted"
        || b.version != account.version
        || b.coverage_snapshot != account.coverage_snapshot
    {
        return Err(Error::Conflict("the charges changed; open the visit again"));
    }
    let existing: Vec<(Uuid, String, Uuid)> = sqlx::query_as(
        "SELECT id,status,request_id FROM ehr_claims WHERE tenant_id=$1 AND account_id=$2 ORDER BY created_at,id",
    )
    .bind(a.tenant_id)
    .bind(account_id)
    .fetch_all(&mut *tx)
    .await?;
    let mut request_id = derived_id(&("visit-claim", a.tenant_id, account_id, existing.len()))?;
    let mut copied_source = None;
    let live = existing.iter().rev().find(|row| row.1 != "void");
    if let Some((id, _, _)) = live.filter(|_| canceled.is_none()) {
        return Ok(json!({"outcome":"exists","claim_id":id}));
    }
    if let Some((source, _, _)) = existing.iter().rev().find(|row| row.1 == "void") {
        if !again {
            return Ok(json!({"outcome":"cancelled"}));
        }
        let previous = claims::claim_row(&mut tx, a, *source).await?;
        if canceled.is_some_and(|expected| {
            expected.id != previous.id || expected.version != previous.version
        }) {
            return Err(Error::Conflict(CANCELED_CHANGED));
        }
        if let Some((reason, _)) = canceled_claim_block_reason(&mut tx, a, &b, &previous).await? {
            return if canceled.is_some() {
                Err(Error::Conflict(reason))
            } else {
                Ok(json!({"outcome":"cancelled","reason":reason}))
            };
        }
        request_id = derived_id(&(
            "copy-canceled-visit-claim",
            a.tenant_id,
            account_id,
            previous.id,
            previous.version,
        ))?;
        if let Some((id, status, existing_request)) = live {
            if *existing_request == request_id && matches!(status.as_str(), "draft" | "ready") {
                return Ok(json!({"outcome":"exists","claim_id":id}));
            }
            return Err(Error::Conflict(CANCELED_CHANGED));
        }
        let previous_content =
            serde_json::from_value::<ClaimContent>(previous.content).map_err(|_| {
                Error::Conflict(
                    "The canceled claim cannot be copied. Review the saved claim history.",
                )
            })?;
        // Keep a claim-only authorization for unchanged charges. When the posted
        // lines changed, use the current encounter's recorded authorization.
        if content.encounter.prior_authorization_number.is_empty()
            && previous.snapshot["account"]["content"]["lines"] == b.content["lines"]
        {
            content.encounter.prior_authorization_number = previous_content
                .encounter
                .prior_authorization_number
                .clone();
        }
        // A claim marked for paper should not change to electronic merely because it was copied.
        content.encounter.paper_only |= previous_content.encounter.paper_only;
        content = ClaimContent {
            external_control_number: String::new(),
            diagnosis_codes: content.diagnosis_codes,
            line_diagnosis_pointers: content.line_diagnosis_pointers,
            encounter: content.encounter,
            ..previous_content
        };
        copied_source = Some((previous.id, previous.version));
    } else if canceled.is_some() {
        return Err(Error::Conflict(CANCELED_CHANGED));
    }
    content.validate()?;
    let payer_id: Uuid = serde_json::from_value(snapshot["payer"]["id"].clone())
        .map_err(|_| Error::Invalid("invalid payer snapshot"))?;
    let digest = claims::hash(&(p, account_id, &content, "automatic"))?;
    let claim = claims::insert_claim(
        &mut tx,
        a,
        p,
        &b,
        payer_id,
        &claims::NewClaimRecord {
            request_id,
            digest: &digest,
            frequency: "original",
            parent_id: None,
            content: &content,
            source_history_id: None,
            coordination: None,
            tracking: false,
            reason: if canceled.is_some() {
                "Prepared a new draft from the locally canceled claim"
            } else {
                AUTO_REASON
            },
            automatic: canceled.is_none(),
            copied_canceled_claim: copied_source,
        },
    )
    .await?;
    let issues: Vec<Value> = claims::preflight(&claim)?
        .iter()
        .map(|issue| plain_issue(issue))
        .collect();
    tx.commit().await?;
    Ok(json!({"outcome":"prepared","claim_id":claim.id,"issues":issues}))
}

/// After a posted account's charges are corrected, a DRAFT claim built from the old charges no
/// longer says what the visit cost. Nothing about a draft has been sent, so it is voided with a
/// revision; the visit then prepares a fresh claim from the corrected charges the usual way. A
/// claim already released or sent is left untouched: the visit summary asks for a corrected claim.
pub(crate) async fn void_draft_claims_after_correction(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    account_id: Uuid,
    reason: &str,
) -> Result<usize> {
    let drafts: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM ehr_claims WHERE tenant_id=$1 AND account_id=$2 AND status='draft' ORDER BY created_at,id",
    )
    .bind(a.tenant_id)
    .bind(account_id)
    .fetch_all(&mut **tx)
    .await?;
    let voided = drafts.len();
    for claim in drafts {
        sqlx::query("UPDATE ehr_claims SET status='void',version=version+1 WHERE tenant_id=$1 AND id=$2 AND status='draft'")
            .bind(a.tenant_id)
            .bind(claim)
            .execute(&mut **tx)
            .await?;
        claims::revision(
            tx,
            a,
            claim,
            reason,
            json!({"voided_after_charge_correction":true}),
        )
        .await?;
    }
    Ok(voided)
}

/// The stored statement for what the patient owes on this visit now. A matching statement
/// is returned as it is; otherwise one is saved with the existing invoice builder. Earlier
/// statements are never changed.
pub(crate) async fn statement(
    pool: &PgPool,
    a: &Actor,
    p: Uuid,
    account_id: Uuid,
) -> Result<Value> {
    a.scheduling()?;
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let account = billing::account_row(&mut tx, a, p, account_id).await?;
    if account.status != "posted" {
        return Err(Error::Conflict(
            "post the charges before preparing a statement",
        ));
    }
    let summary = summarize(
        &mut tx,
        a,
        p,
        None,
        Some(account_id),
        Options {
            claims: true,
            history: false,
            technical: false,
        },
    )
    .await?;
    let owes = cents(&summary["patient"]["owes_now_cents"]);
    let latest: Option<Value> = sqlx::query_scalar("SELECT to_jsonb(i)-'tenant_id'-'creation_hash'-'request_id' FROM patient_invoice_snapshots i WHERE tenant_id=$1 AND patient_id=$2 AND account_id=$3 ORDER BY created_at DESC,id LIMIT 1")
        .bind(a.tenant_id).bind(p).bind(account_id).fetch_optional(&mut *tx).await?;
    if let Some(row) = latest {
        if row["account_version"].as_i64() == Some(account.version)
            && row["snapshot"]["amount_due_cents"].as_i64() == Some(owes)
        {
            crate::postgres::audit(&mut tx, a, "billing.invoice_replayed", account_id).await?;
            tx.commit().await?;
            return Ok(json!({"created":false,"invoice":row}));
        }
    }
    // The invoice builder subtracts every patient payment and credit from the reviewed
    // responsibility, so the responsibility saved is what the patient owes plus those.
    let (credit, _) = billing::patient_ledger_totals(&mut tx, a.tenant_id, account_id).await?;
    let responsibility = (owes + credit).clamp(0, account.total_cents);
    let request_id = derived_id(&(
        "visit-statement",
        a.tenant_id,
        account_id,
        account.version,
        responsibility,
    ))?;
    let hash = billing::digest(&(p, account_id, request_id, responsibility, "automatic"))?;
    let row = billing::issue_patient_invoice(
        &mut tx,
        a,
        p,
        &account,
        (request_id, &hash),
        responsibility,
        STATEMENT_REASON,
    )
    .await?;
    tx.commit().await?;
    Ok(json!({"created":true,"invoice":row}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SummaryQuery {
    visit_id: Option<Uuid>,
    account_id: Option<Uuid>,
}
async fn read(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Query(q): Query<SummaryQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    let claims = crate::access_policies::require_native(&s, &a, "claims", "view")
        .await
        .is_ok();
    let mut tx = db(&s)?.begin().await?;
    let known: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(p)
            .fetch_one(&mut *tx)
            .await?;
    if !known {
        return Err(Error::NotFound);
    }
    let out = summarize(
        &mut tx,
        &a,
        p,
        q.visit_id,
        q.account_id,
        Options {
            claims,
            history: true,
            technical: matches!(a.role, Role::Owner),
        },
    )
    .await?;
    let mut out = out;
    out["viewer"] = json!({"delegated":delegated(&mut tx, &a).await?});
    crate::postgres::audit(&mut tx, &a, "billing.visit_summary_read", p).await?;
    tx.commit().await?;
    Ok(Json(out))
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Prepare {
    #[serde(default)]
    again: bool,
    canceled_claim_id: Option<Uuid>,
    canceled_claim_version: Option<i64>,
    canceled_account_version: Option<i64>,
}
async fn prepare(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    body: Option<Json<Prepare>>,
) -> Result<Json<Value>> {
    let request = body.map(|Json(v)| v).unwrap_or_default();
    let canceled = match (
        request.canceled_claim_id,
        request.canceled_claim_version,
        request.canceled_account_version,
    ) {
        (Some(id), Some(version), account_version)
            if request.again && version > 0 && account_version.is_none_or(|v| v > 0) =>
        {
            Some(CanceledClaimSource {
                id,
                version,
                account_version,
            })
        }
        (None, None, None) => None,
        _ => {
            return Err(Error::Invalid(
                "Preparing a new draft requires the canceled claim and its current version",
            ))
        }
    };
    if request.again {
        crate::access_policies::require_native(&s, &a, "claims", "view").await?;
        crate::access_policies::require_native(&s, &a, "claims", "create").await?;
    }
    if canceled.is_some() {
        crate::access_policies::require_native(&s, &a, "billing", "create").await?;
    }
    let pool = db(&s)?;
    if request.again && canceled.is_none() {
        let mut tx = pool.begin().await?;
        if delegated(&mut tx, &a).await? {
            return Err(Error::Conflict(
                "Reopen the encounter to prepare a draft from the current canceled claim.",
            ));
        }
    }
    Ok(Json(
        prepare_claim_with_source(pool, &a, p, id, request.again, canceled).await?,
    ))
}
async fn make_statement(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    Ok(Json(statement(db(&s)?, &a, p, id).await?))
}
/// One line of money and claim state per charge account for a patient, for the encounter list:
/// charges, what insurance and the patient paid, what is still pending with insurance, what the
/// patient owes now and any credit. Claim state only for staff who may view claims.
async fn encounter_balances(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let claims = crate::access_policies::require_native(&s, &a, "claims", "view")
        .await
        .is_ok();
    let mut tx = db(&s)?.begin().await?;
    let known: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(p)
            .fetch_one(&mut *tx)
            .await?;
    if !known {
        return Err(Error::NotFound);
    }
    let rows = balances(&mut tx, a.tenant_id, Some(&[p]), None, None).await?;
    let items: Vec<Value> = rows
        .iter()
        .filter(|r| r["patient_id"] == json!(p))
        .map(|r| {
            json!({
                "account_id": r["id"],
                "appointment_id": r["appointment_id"],
                "visit_id": r["visit_id"],
                "status": r["status"],
                "posted": r["posted"],
                "insured": r["insured"],
                "total_cents": r["total_cents"],
                "insurer_paid_cents": r["insurer_paid_cents"],
                "patient_payments_cents": r["patient_payments_cents"],
                "pending_cents": r["pending_cents"],
                "owes_now_cents": r["owes_now_cents"],
                "overpaid_cents": r["overpaid_cents"],
                "claim_status": if claims { r["claim_status"].clone() } else { Value::Null },
                "denied": if claims { r["denied"].clone() } else { Value::Null },
            })
        })
        .collect();
    crate::postgres::audit(&mut tx, &a, "billing.encounter_balances_read", p).await?;
    tx.commit().await?;
    Ok(Json(json!({ "items": items })))
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/patients/{p}/billing/visit-summary", get(read))
        .route(
            "/api/v1/patients/{p}/billing/visits/{visit}/claim-handoff",
            post(crate::visit_claim_handoff::handoff),
        )
        .route(
            "/api/v1/patients/{p}/billing/encounters",
            get(encounter_balances),
        )
        .route(
            "/api/v1/patients/{p}/billing/accounts/{id}/claims/prepare",
            post(prepare),
        )
        .route(
            "/api/v1/patients/{p}/billing/accounts/{id}/statement",
            post(make_statement),
        )
}

/// Counts the set-based statements run for a practice, so a test can show a page of rows
/// costs the same number of them as one row.
#[cfg(test)]
pub(crate) mod query_log {
    use std::{collections::HashMap, sync::Mutex};
    use uuid::Uuid;
    static CALLS: Mutex<Option<HashMap<Uuid, usize>>> = Mutex::new(None);
    pub(crate) fn count(tenant: Uuid) {
        *CALLS
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .entry(tenant)
            .or_insert(0) += 1;
    }
    pub(crate) fn take(tenant: Uuid) -> usize {
        CALLS
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .remove(&tenant)
            .unwrap_or(0)
    }
}

#[cfg(test)]
#[path = "visit_billing_tests.rs"]
mod db_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_released_unsent_claim_with_blocking_issues_still_needs_details() {
        let row = json!({"posted":true,"insured":true,"electronic":true,"claim_status":"ready"});
        assert_eq!(state_of(&row, true, true), ("fix_claim", "staff"));
        assert_eq!(state_of(&row, false, true), ("send_claim", "staff"));
    }

    #[test]
    fn claim_provider_preserves_the_assigned_clinician() {
        let assigned = Uuid::new_v4();
        let other = Uuid::new_v4();
        let sole = [(other, "Other clinician".to_owned(), "1234567893".to_owned())];
        assert!(claim_provider(&sole, Some(assigned)).is_none());
        assert_eq!(claim_provider(&sole, None).map(|row| row.0), Some(other));
        let both = [
            sole[0].clone(),
            (
                assigned,
                "Assigned clinician".to_owned(),
                "1245319599".to_owned(),
            ),
        ];
        assert_eq!(
            claim_provider(&both, Some(assigned)).map(|row| row.0),
            Some(assigned)
        );
        assert!(claim_provider(&both, None).is_none());
    }

    #[test]
    fn diagnoses_follow_the_charge_lines_like_the_claim_form() {
        let lines = vec![
            json!({"diagnosis_codes":["g81.14 - Spastic hemiplegia, left side","Z00.00, I10"]}),
            json!({"diagnosis_codes":["I10","CUSTOM"]}),
            json!({"diagnosis_codes":[]}),
        ];
        let (codes, pointers) = charge_diagnoses(&lines);
        assert_eq!(codes, ["G81.14", "Z00.00", "I10", "CUSTOM"]);
        assert_eq!(pointers, vec![vec![1, 2, 3], vec![3, 4], vec![]]);
    }

    #[test]
    fn a_charge_with_more_than_four_diagnoses_is_left_for_a_person() {
        let lines = vec![json!({"diagnosis_codes":["A00.0","A01.0","A02.0","A03.0","A04.0"]})];
        let (codes, pointers) = charge_diagnoses(&lines);
        assert_eq!(codes.len(), 5);
        assert_eq!(pointers, vec![Vec::<usize>::new()]);
    }

    #[test]
    fn receipts_count_only_usable_money_for_the_appointment() {
        let appointment = Uuid::new_v4();
        let rows = vec![
            json!({"appointment_id":appointment,"amount_cents":1000,"allocated_cents":1000,"reversed_cents":0,"voided":false,"hosted_checkout":null}),
            json!({"appointment_id":appointment,"amount_cents":2500,"allocated_cents":0,"reversed_cents":0,"voided":false,"hosted_checkout":{"status":"paid","refunded_cents":500,"refunded_unapplied_cents":500}}),
            json!({"appointment_id":appointment,"amount_cents":700,"allocated_cents":0,"reversed_cents":0,"voided":true,"hosted_checkout":null}),
            json!({"appointment_id":Uuid::new_v4(),"amount_cents":9900,"allocated_cents":0,"reversed_cents":0,"voided":false,"hosted_checkout":null}),
        ];
        let out = receipts(rows.clone(), Some(appointment), false);
        assert_eq!(out.net_received, 3000);
        assert_eq!(out.usable_unapplied, 2000);
        assert_eq!(out.items.len(), 3);
        assert!(!out.needs_review);
        // On production a test-mode card receipt is never applied to charges, so it is
        // not usable credit there either.
        let test_card = json!({"appointment_id":appointment,"amount_cents":4000,"allocated_cents":0,"reversed_cents":0,"voided":false,"hosted_checkout":{"status":"paid","livemode":false,"refunded_cents":0,"refunded_unapplied_cents":0}});
        assert_eq!(
            receipts(vec![test_card.clone()], Some(appointment), false).usable_unapplied,
            4000
        );
        assert_eq!(
            receipts(vec![test_card], Some(appointment), true).usable_unapplied,
            0
        );
    }

    #[test]
    fn what_a_claim_needs_is_named_before_the_charges_post() {
        let bare = json!([{"code":"99213","diagnosis_codes":[]},{"code":"64616"}]);
        let half = json!([{"code":"99213","diagnosis_codes":["I10"]},{"code":"64616","diagnosis_codes":[]}]);
        let linked = json!([{"code":"99213","diagnosis_codes":["I10"]}]);
        assert_eq!(before_posting(true, &bare, 0)[0]["code"], "diagnoses");
        // Diagnoses are on the encounter but no line points at one yet.
        assert_eq!(before_posting(true, &bare, 2)[0]["code"], "line_diagnoses");
        assert_eq!(before_posting(true, &bare, 2)[0]["lines"], 2);
        assert_eq!(before_posting(true, &half, 1)[0]["lines"], 1);
        assert!(before_posting(true, &linked, 1).is_empty());
        // Lines that carry their own codes are enough, whatever the encounter lists.
        assert!(before_posting(true, &linked, 0).is_empty());
        assert!(
            before_posting(false, &bare, 0).is_empty(),
            "self-pay needs no diagnosis"
        );
        assert!(
            before_posting(true, &json!([]), 0).is_empty(),
            "nothing to check yet"
        );
        assert!(before_posting(true, &Value::Null, 0).is_empty());
    }
    #[test]
    fn readiness_problems_are_named_in_plain_words() {
        assert_eq!(
            plain_issue("Tax ID is required")["missing"],
            "billing organization tax ID"
        );
        assert_eq!(
            plain_issue("Tax ID must contain nine digits")["code"],
            "tax_id"
        );
        assert_eq!(plain_issue("Something new")["missing"], "Something new");
    }

    #[test]
    fn derived_request_ids_are_stable() {
        let id = Uuid::new_v4();
        assert_eq!(
            derived_id(&("x", id, 1)).unwrap(),
            derived_id(&("x", id, 1)).unwrap()
        );
        assert_ne!(
            derived_id(&("x", id, 1)).unwrap(),
            derived_id(&("x", id, 2)).unwrap()
        );
    }

    #[test]
    fn only_a_plan_without_any_recorded_copay_lets_the_insurer_answer_stand_in() {
        let checked = Some((1500, chrono::NaiveDate::from_ymd_opt(2026, 11, 10).unwrap()));
        assert_eq!(
            expected_copay(None, true, "copay_not_recorded", checked),
            Some(1500)
        );
        assert_eq!(
            expected_copay(Some(4000), true, "copay_not_recorded", checked),
            Some(4000)
        );
        assert_eq!(
            expected_copay(Some(4000), true, "plan_copay", checked),
            Some(4000)
        );
        // Once the insurer or a person has settled the visit, the check is not the source.
        for settled in ["insurer_response", "reviewed_statement", "not_final"] {
            assert_eq!(
                expected_copay(None, true, settled, checked),
                None,
                "{settled}"
            );
        }
        // Without insurance there is no plan copay to stand in for.
        assert_eq!(expected_copay(None, false, "self_pay", checked), None);
        assert_eq!(
            expected_copay(None, false, "copay_not_recorded", checked),
            None,
            "an uninsured visit's figure is the whole charge"
        );
        // Nothing usable from the insurer leaves the visit as it was.
        assert_eq!(expected_copay(None, true, "copay_not_recorded", None), None);
    }

    fn eligibility(benefits: Vec<Value>) -> Value {
        json!({"elig":[{"ins_number":"SYNTHETIC-MEMBER","benefit":benefits}]})
    }
    fn benefit(service: &str, kind: &str, fields: Value) -> Value {
        let mut row = json!({"benefit_code":service,"benefit_coverage_code":kind});
        if let Some(map) = fields.as_object() {
            for (key, value) in map {
                row[key] = value.clone();
            }
        }
        row
    }

    #[test]
    fn an_office_visit_copay_is_read_from_the_insurer_answer() {
        assert_eq!(
            office_visit_copay(&eligibility(vec![
                benefit(
                    "30",
                    "1",
                    json!({"benefit_coverage_description":"Active Coverage"})
                ),
                benefit(
                    "98",
                    "B",
                    json!({"benefit_amount":"15","inplan_network":"Y"})
                ),
            ])),
            Some(1500)
        );
        // A general health-plan copay (service 30) and a professional visit named only in
        // its description are both the visit's copay.
        assert_eq!(
            office_visit_copay(&eligibility(vec![benefit(
                "30",
                "B",
                json!({"benefit_amount":25.5})
            )])),
            Some(2550)
        );
        assert_eq!(
            office_visit_copay(&eligibility(vec![benefit(
                "A0",
                "B",
                json!({"benefit_amount":"20","benefit_description":"Professional (Physician) Visit - Office"})
            )])),
            Some(2000)
        );
        // A zero copay is a real answer.
        assert_eq!(
            office_visit_copay(&eligibility(vec![benefit(
                "98",
                "B",
                json!({"benefit_amount":"0"})
            )])),
            Some(0)
        );
    }

    #[test]
    fn anything_that_is_not_an_office_visit_copay_is_left_alone() {
        // Nothing reported, no office-visit service, coinsurance, a deductible, family level.
        assert_eq!(office_visit_copay(&eligibility(vec![])), None);
        assert_eq!(
            office_visit_copay(&eligibility(vec![benefit("30", "1", json!({}))])),
            None
        );
        assert_eq!(
            office_visit_copay(&eligibility(vec![benefit(
                "30",
                "A",
                json!({"benefit_percent":"20","benefit_amount":"40"})
            )])),
            None,
            "a coinsurance percentage is never a copay"
        );
        assert_eq!(
            office_visit_copay(&eligibility(vec![benefit(
                "30",
                "C",
                json!({"benefit_amount":"3000"})
            )])),
            None
        );
        assert_eq!(
            office_visit_copay(&eligibility(vec![benefit(
                "98",
                "B",
                json!({"benefit_amount":"15","benefit_level_code":"FAM"})
            )])),
            None,
            "a family amount is not this patient's copay"
        );
        // A specialist copay or a limitation note is not an office visit copay.
        assert_eq!(
            office_visit_copay(&eligibility(vec![benefit(
                "96",
                "B",
                json!({"benefit_amount":"40"})
            )])),
            None
        );
        assert_eq!(
            office_visit_copay(&eligibility(vec![benefit(
                "98",
                "F",
                json!({"benefit_notes":"20 visits per year"})
            )])),
            None
        );
        // Malformed, negative-shaped or implausible amounts are not amounts.
        for amount in [
            json!("malformed"),
            json!("-15"),
            json!("15.000"),
            json!(""),
            json!(null),
            json!(true),
            json!("1e2"),
        ] {
            assert_eq!(
                office_visit_copay(&eligibility(vec![benefit(
                    "98",
                    "B",
                    json!({"benefit_amount":amount})
                )])),
                None,
                "{amount}"
            );
        }
        // Copays that disagree are not resolved by picking one.
        assert_eq!(
            office_visit_copay(&eligibility(vec![
                benefit(
                    "98",
                    "B",
                    json!({"benefit_amount":"15","inplan_network":"Y"})
                ),
                benefit(
                    "98",
                    "B",
                    json!({"benefit_amount":"60","inplan_network":"N"})
                ),
            ])),
            None
        );
        // The same amount twice is one answer, not a conflict.
        assert_eq!(
            office_visit_copay(&eligibility(vec![
                benefit("98", "B", json!({"benefit_amount":"15"})),
                benefit("98", "B", json!({"benefit_amount":"15.00"})),
            ])),
            Some(1500)
        );
        // A single benefit object, as Claim.MD sometimes returns it.
        assert_eq!(
            office_visit_copay(
                &json!({"elig":[{"benefit":benefit("98","B",json!({"benefit_amount":"15"}))}]})
            ),
            Some(1500)
        );
        assert_eq!(
            office_visit_copay(&json!({"failure":{"kind":"timeout"}})),
            None
        );
    }
}
