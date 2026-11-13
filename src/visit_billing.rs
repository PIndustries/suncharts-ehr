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
//! - After the insurer answers (a posted remittance is the active one for the latest
//!   claim and no other claim is still open), the patient's share is the patient
//!   responsibility the insurer reported on that remittance.
//! - Without insurance the patient's share is the whole charge.
//! - Once a statement has been saved for the visit, the patient's share is the
//!   responsibility on the latest one, so the figure never disagrees with the statement the
//!   patient holds. An insurer's answer that arrives after that statement replaces it.
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
const STATEMENT_REASON: &str = "Statement prepared from the visit's billing summary";

fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn cents(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}
fn derived_id(parts: &impl serde::Serialize) -> Result<Uuid> {
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
fn receipts(rows: Vec<Value>, appointment: Option<Uuid>) -> Receipts {
    let mut out = Receipts::default();
    let Some(appointment) = appointment else {
        return out;
    };
    for row in rows {
        if row["appointment_id"].as_str() != Some(appointment.to_string().as_str()) {
            continue;
        }
        let hosted = &row["hosted_checkout"];
        let voided = row["voided"] == true;
        let reversed = cents(&row["reversed_cents"]) > 0;
        let held = hosted["status"] == "needs_review";
        let amount = cents(&row["amount_cents"]);
        if !voided {
            out.net_received += (amount - cents(&hosted["refunded_cents"])).max(0);
            out.needs_review |= reversed || held;
        }
        if !voided && !reversed && !held {
            out.usable_unapplied += (amount
                - cents(&row["allocated_cents"])
                - cents(&hosted["refunded_unapplied_cents"]))
            .max(0);
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
         'response_to_review',(SELECT r.id FROM era_remittances r WHERE r.tenant_id=c.tenant_id AND r.status IN ('staged','reconciled') AND (r.matches @> jsonb_build_array(jsonb_build_object('claim_id',c.id)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.document->'claims')='array' THEN r.document->'claims' ELSE '[]'::jsonb END) x WHERE x->>'control_number'=c.control_number)) ORDER BY r.created_at LIMIT 1),\
         'head',(SELECT jsonb_build_object('remittance_id',h.remittance_id,'row_index',h.row_index,'patient_responsibility_cents',p.patient_responsibility_cents,'writeoff_cents',p.writeoff_cents,'payment_date',r.document->>'payment_date','trace',r.trace,'row',r.document->'claims'->h.row_index) FROM era_claim_heads h JOIN era_remittances r ON r.tenant_id=h.tenant_id AND r.id=h.remittance_id LEFT JOIN era_postings p ON p.tenant_id=h.tenant_id AND p.remittance_id=h.remittance_id AND p.row_index=h.row_index WHERE h.tenant_id=c.tenant_id AND h.claim_id=c.id)) \
         FROM ehr_claims c WHERE c.tenant_id=$1 AND c.account_id=$2 ORDER BY c.created_at,c.id LIMIT 200",
    )
    .bind(a.tenant_id)
    .bind(account)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
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
 SELECT b.tenant_id,b.id,b.patient_id,b.status,b.version,b.total_cents,v.status AS visit_status,v.appointment_id,
  b.status='posted' AS posted,
  b.coverage_snapshot IS NOT NULL AS insured,
  btrim(coalesce(b.coverage_snapshot->'payer'->'content'->>'payer_code',''))<>'' AS electronic,
  CASE WHEN jsonb_typeof(b.coverage_snapshot->'coverage'->'content'->'copay_cents')='number' THEN (b.coverage_snapshot->'coverage'->'content'->>'copay_cents')::bigint END AS copay
 FROM billing_accounts b LEFT JOIN visits v ON v.tenant_id=b.tenant_id AND v.id=b.visit_id AND v.patient_id=b.patient_id
 WHERE b.tenant_id=$1 AND b.status<>'void' AND ($2::uuid[] IS NULL OR b.patient_id=ANY($2)) AND ($3::uuid[] IS NULL OR b.id=ANY($3))
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
 SELECT r.appointment_id,
  sum(CASE WHEN y.voided OR y.reversed>0 OR coalesce(o.status='needs_review',false) THEN 0 ELSE greatest(0,r.amount_cents-y.allocated-y.refunded_unapplied) END)::bigint AS unapplied
 FROM billing_copay_receipts r LEFT JOIN copay_checkout_attempts o ON o.tenant_id=r.tenant_id AND o.receipt_id=r.id
 CROSS JOIN LATERAL (SELECT
   coalesce((SELECT sum(a.amount_cents) FROM billing_copay_allocations a WHERE a.tenant_id=r.tenant_id AND a.receipt_id=r.id),0)::bigint AS allocated,
   coalesce((SELECT sum(a.amount_cents) FROM billing_copay_allocations a JOIN billing_entries e ON e.tenant_id=a.tenant_id AND e.reverses_id=a.entry_id WHERE a.tenant_id=r.tenant_id AND a.receipt_id=r.id),0)::bigint AS reversed,
   coalesce((SELECT sum(f.unapplied_cents) FROM copay_checkout_refund_events f WHERE f.tenant_id=o.tenant_id AND f.operation_id=o.id),0)::bigint AS refunded_unapplied,
   EXISTS(SELECT 1 FROM billing_copay_voids d WHERE d.tenant_id=r.tenant_id AND d.receipt_id=r.id) AS voided) y
 WHERE r.tenant_id=$1 AND r.appointment_id IN (SELECT appointment_id FROM acct WHERE appointment_id IS NOT NULL) GROUP BY r.appointment_id
), facts AS (
 SELECT a.*,a.total_cents+coalesce(l.net,0) AS balance,coalesce(l.patient_credit,0) AS patient_credit,coalesce(l.patient_payments,0) AS patient_payments,
  coalesce(l.insurer_paid,0) AS insurer_paid,coalesce(l.receipts_applied,0) AS receipts_applied,coalesce(d.unapplied,0) AS unapplied,
  coalesce(l.test_activity,false) OR coalesce((i.snapshot->>'test_activity')::boolean,false) AS test_activity,
  c.id AS claim_id,c.status AS claim_status,c.response_to_review,c.answer_paid,c.answer_responsibility,
  coalesce(c.status='adjudicated' AND c.answered AND NOT c.denied,false) AS answered,
  coalesce(c.status='rejected' OR (c.status='adjudicated' AND c.answered AND c.denied),false) AS denied,
  EXISTS(SELECT 1 FROM ehr_claims z WHERE z.tenant_id=a.tenant_id AND z.account_id=a.id AND z.status='void') AS any_void,
  i.id IS NOT NULL AND i.account_version=a.version AND (l.last_entry_at IS NULL OR l.last_entry_at<=i.created_at) AS statement_current,
  CASE WHEN jsonb_typeof(i.snapshot->'responsibility_cents')='number' THEN (i.snapshot->>'responsibility_cents')::bigint END AS statement_responsibility
 FROM acct a LEFT JOIN ledger l ON l.account_id=a.id LEFT JOIN desk d ON d.appointment_id=a.appointment_id
 LEFT JOIN LATERAL (SELECT i.id,i.account_version,i.created_at,i.snapshot FROM patient_invoice_snapshots i WHERE i.tenant_id=a.tenant_id AND i.account_id=a.id ORDER BY i.created_at DESC,i.id DESC LIMIT 1) i ON true
 LEFT JOIN LATERAL (SELECT c.id,c.status,h.remittance_id IS NOT NULL AS answered,coalesce(r.document->'claims'->h.row_index->>'status'='4',false) AS denied,
   coalesce(p.patient_responsibility_cents,CASE WHEN jsonb_typeof(r.document->'claims'->h.row_index->'patient_responsibility_cents')='number' THEN (r.document->'claims'->h.row_index->>'patient_responsibility_cents')::bigint END,0) AS answer_responsibility,
   CASE WHEN jsonb_typeof(r.document->'claims'->h.row_index->'paid_cents')='number' THEN (r.document->'claims'->h.row_index->>'paid_cents')::bigint ELSE 0 END AS answer_paid,
   (SELECT s.id FROM era_remittances s WHERE s.tenant_id=c.tenant_id AND s.status IN ('staged','reconciled') AND (s.matches @> jsonb_build_array(jsonb_build_object('claim_id',c.id)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.document->'claims')='array' THEN s.document->'claims' ELSE '[]'::jsonb END) q WHERE q->>'control_number'=c.control_number)) ORDER BY s.created_at LIMIT 1) AS response_to_review
  FROM ehr_claims c LEFT JOIN era_claim_heads h ON h.tenant_id=c.tenant_id AND h.claim_id=c.id
  LEFT JOIN era_remittances r ON r.tenant_id=h.tenant_id AND r.id=h.remittance_id
  LEFT JOIN era_postings p ON p.tenant_id=h.tenant_id AND p.remittance_id=h.remittance_id AND p.row_index=h.row_index
  WHERE c.tenant_id=a.tenant_id AND c.account_id=a.id AND c.status<>'void' AND a.posted AND a.insured
  ORDER BY (c.status IN ('draft','ready','submitted','accepted')) DESC,c.created_at DESC,c.id DESC LIMIT 1) c ON true
), shares AS (
 SELECT f.*,
  CASE WHEN NOT f.posted THEN 0
   WHEN f.statement_responsibility IS NOT NULL AND (f.statement_current OR NOT f.answered) THEN least(greatest(f.statement_responsibility,0),f.total_cents)
   WHEN NOT f.insured THEN f.total_cents
   WHEN f.answered THEN least(greatest(f.answer_responsibility,0),f.total_cents)
   WHEN f.copay IS NOT NULL THEN least(greatest(f.copay,0),f.total_cents) ELSE 0 END AS responsibility,
  CASE WHEN NOT f.posted THEN 'not_final'
   WHEN f.statement_responsibility IS NOT NULL AND (f.statement_current OR NOT f.answered) AND NOT f.insured AND f.statement_responsibility>=f.total_cents THEN 'self_pay'
   WHEN f.statement_responsibility IS NOT NULL AND (f.statement_current OR NOT f.answered) AND f.answered AND f.statement_responsibility=least(greatest(f.answer_responsibility,0),f.total_cents) THEN 'insurer_response'
   WHEN f.statement_responsibility IS NOT NULL AND (f.statement_current OR NOT f.answered) THEN 'reviewed_statement'
   WHEN NOT f.insured THEN 'self_pay' WHEN f.answered THEN 'insurer_response'
   WHEN f.copay IS NOT NULL THEN 'plan_copay' ELSE 'copay_not_recorded' END AS responsibility_source
 FROM facts f
), owed AS (
 SELECT s.*,CASE WHEN s.posted THEN least(greatest(s.responsibility-s.patient_credit-s.unapplied,0),greatest(s.balance,0)) ELSE 0 END AS owes_now FROM shares s
)
SELECT jsonb_build_object('id',o.id,'patient_id',o.patient_id,'status',o.status,'visit_status',o.visit_status,'posted',o.posted,'insured',o.insured,'electronic',o.electronic,
 'total_cents',o.total_cents,'balance_cents',o.balance,'patient_credit_cents',o.patient_credit,'patient_payments_cents',o.patient_payments,'insurer_paid_cents',o.insurer_paid,
 'receipts_applied_cents',o.receipts_applied,'unapplied_cents',CASE WHEN o.posted THEN o.unapplied ELSE 0 END,'responsibility_cents',o.responsibility,'responsibility_source',o.responsibility_source,
 'owes_now_cents',o.owes_now,
 'pending_cents',CASE WHEN o.posted AND o.insured AND NOT o.answered THEN greatest(o.balance-o.owes_now,0) ELSE 0 END,
 'unassigned_cents',CASE WHEN o.posted AND ((o.insured AND o.answered) OR (NOT o.insured AND o.responsibility_source='reviewed_statement')) THEN greatest(o.balance-o.owes_now,0) ELSE 0 END,
 'overpaid_cents',CASE WHEN o.posted THEN greatest(CASE WHEN o.answered OR NOT o.insured THEN greatest(o.patient_credit-o.responsibility,0) ELSE 0 END,-o.balance) ELSE 0 END,
 'answered',o.answered,'denied',o.denied,'any_void',o.any_void,'claim_id',o.claim_id,'claim_status',o.claim_status,'response_to_review',o.response_to_review,'test_activity',o.test_activity)
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
/// The state name of a visit's billing, from its balance row. `draft_needs_details` says
/// whether the open draft claim fails the readiness checks.
pub(crate) fn state_of(
    row: &Value,
    draft_needs_details: bool,
    claims_visible: bool,
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
        Some("draft") if draft_needs_details => ("fix_claim", "staff"),
        Some("draft" | "ready") => ("send_claim", "staff"),
        Some("submitted" | "accepted") if row["response_to_review"].is_string() => {
            ("post_response", "staff")
        }
        Some("submitted" | "accepted") => ("waiting_insurer", "insurer"),
        _ if row["denied"] == true => ("denied", "staff"),
        _ if owes > 0 => ("patient_owes", "patient"),
        _ if cents(&row["unassigned_cents"]) > 0 => ("review_response", "staff"),
        _ => settled(),
    }
}
/// State names for a page of balance rows: one extra query for the open drafts.
pub(crate) async fn states(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    rows: &[Value],
    claims_visible: bool,
) -> Result<std::collections::HashMap<Uuid, &'static str>> {
    let drafts: Vec<Uuid> = rows
        .iter()
        .filter(|row| row["claim_status"] == "draft")
        .filter_map(|row| {
            row["claim_id"]
                .as_str()
                .and_then(|v| Uuid::parse_str(v).ok())
        })
        .collect();
    let mut needs = std::collections::HashSet::new();
    if claims_visible && !drafts.is_empty() {
        #[cfg(test)]
        query_log::count(a.tenant_id);
        let claims: Vec<claims::Claim> =
            sqlx::query_as("SELECT * FROM ehr_claims WHERE tenant_id=$1 AND id=ANY($2)")
                .bind(a.tenant_id)
                .bind(&drafts)
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
            let draft = row["claim_id"]
                .as_str()
                .and_then(|v| Uuid::parse_str(v).ok())
                .is_some_and(|claim| needs.contains(&claim));
            Some((id, state_of(row, draft, claims_visible).0))
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
    let visit_row: Option<(Uuid, String, Uuid, chrono::DateTime<chrono::Utc>)> = match visit_id {
        Some(v) => sqlx::query_as("SELECT v.id,v.status,v.appointment_id,ap.starts_at FROM visits v JOIN appointments ap ON ap.tenant_id=v.tenant_id AND ap.id=v.appointment_id WHERE v.tenant_id=$1 AND v.patient_id=$2 AND v.id=$3")
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
    // can still change, otherwise the primary coverage in force on the visit date.
    let coverage: Option<(Value, Value)> = match &account {
        Some(b) if b.status != "draft" => b
            .coverage_snapshot
            .as_ref()
            .map(|s| (s["coverage"]["content"].clone(), s["payer"]["content"].clone())),
        Some(b) => match b.content["coverage_id"].as_str().and_then(|v| Uuid::parse_str(v).ok()) {
            Some(id) => sqlx::query_as("SELECT c.content,py.content FROM insurance_coverages c JOIN ehr_payers py ON py.tenant_id=c.tenant_id AND py.id=(c.content->>'payer_id')::uuid WHERE c.tenant_id=$1 AND c.patient_id=$2 AND c.id=$3")
                .bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut **tx).await?,
            None => None,
        },
        None => match &visit_row {
            Some(row) => sqlx::query_as("SELECT c.content,py.content FROM insurance_coverages c JOIN ehr_payers py ON py.tenant_id=c.tenant_id AND py.id=(c.content->>'payer_id')::uuid WHERE c.tenant_id=$1 AND c.patient_id=$2 AND c.content->>'status'='active' AND c.content->>'priority'='primary' AND c.content->>'effective_date'<=$3 AND (c.content->>'end_date' IS NULL OR c.content->>'end_date'>=$3) ORDER BY c.id LIMIT 1")
                .bind(a.tenant_id).bind(p).bind(row.3.date_naive().to_string()).fetch_optional(&mut **tx).await?,
            None => None,
        },
    };
    let insured = coverage.is_some();
    let insurer = coverage
        .as_ref()
        .and_then(|(_, payer)| payer["name"].as_str())
        .unwrap_or("")
        .to_owned();
    let electronic = coverage
        .as_ref()
        .is_some_and(|(_, payer)| !payer["payer_code"].as_str().unwrap_or("").trim().is_empty());
    let plan_copay = coverage
        .as_ref()
        .and_then(|(content, _)| content["copay_cents"].as_i64());

    let paid_at_desk = receipts(billing::copay_rows(tx, a, p, None).await?, appointment);

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
    let source = money["responsibility_source"]
        .as_str()
        .unwrap_or("not_final")
        .to_owned();
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
    let open = live.iter().copied().find(|c| c.open());
    let latest = open.or_else(|| live.last().copied());

    // The current draft's readiness, with the same checks the manual flow runs.
    let mut issues: Vec<Value> = vec![];
    if let Some(c) = open.filter(|c| c.status() == "draft") {
        let id = Uuid::parse_str(c.row["id"].as_str().unwrap_or(""))
            .map_err(|_| Error::Invalid("invalid claim"))?;
        let claim = claims::claim_row(tx, a, id).await?;
        issues = claims::preflight(&claim)?
            .iter()
            .map(|issue| plain_issue(issue))
            .collect();
    }

    let restricted = posted && insured && !opt.claims;
    let (state, waiting_on) = match &account {
        None => ("add_charges", "staff"),
        Some(_) if void => ("add_charges", "staff"),
        Some(_) => state_of(&money, !issues.is_empty(), opt.claims),
    };

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
                "submitted" | "accepted" => "waiting",
                _ if denied => "denied",
                _ => "answered",
            },
        }
    };

    let claim_json = latest.map(|c| {
        let mut row = c.row.clone();
        if let Some(object) = row.as_object_mut() {
            object.remove("head");
            if !opt.technical {
                object.remove("control_number");
                object.remove("version");
                object.remove("payer_control_number");
            }
        }
        row["issues"] = json!(issues);
        if let Some(answer) = &c.answer {
            row["answer"] = json!({"paid_cents":answer.paid,"patient_responsibility_cents":answer.patient_responsibility,"denied":answer.denied,"payment_date":answer.payment_date,"remittance_id":answer.remittance_id});
        }
        row
    });

    let mut out = json!({
        "patient_id": p,
        "visit": visit_row.as_ref().map(|row| json!({"id":row.0,"status":row.1,"appointment_id":row.2,"starts_at":row.3})),
        "account": account.as_ref().map(|b| json!({"id":b.id,"status":b.status,"version":b.version,"total_cents":b.total_cents,"service_date":b.content["service_date"],"has_visit":b.content["visit_id"].is_string()})),
        "state": state,
        "waiting_on": waiting_on,
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
        },
        "patient": {
            "copay_cents": plan_copay.filter(|_| insured),
            "copay_paid_cents": plan_copay.filter(|_| insured).map(|copay| copay.min(paid_at_desk.net_received)),
            "copay_due_cents": plan_copay.filter(|_| insured).map(|copay| (copay - paid_at_desk.net_received).max(0)),
            "paid_above_copay_cents": plan_copay.filter(|_| insured).map(|copay| (paid_at_desk.net_received - copay).max(0)),
            "received_cents": paid_at_desk.net_received,
            "receipts_applied_cents": receipts_applied,
            "other_payments_cents": patient_payments - receipts_applied,
            // Everything the patient paid that is not the copay itself: money taken at the
            // desk beyond the copay, plus payments recorded straight on the visit.
            "other_patient_payments_cents": match plan_copay.filter(|_| insured) {
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
        },
        "charges_cents": account.as_ref().filter(|_| !void).map(|b| b.total_cents),
        "balance_cents": posted.then_some(balance),
        "claim": claim_json,
        "claim_count": live.len(),
        "receipts": paid_at_desk.items.iter().map(|row| json!({"id":row["id"],"appointment_id":row["appointment_id"],"amount_cents":row["amount_cents"],"method":if row["hosted_checkout"].is_object() { json!("card") } else { row["method"].clone() },"occurred_on":row["occurred_on"],"voided":row["voided"],"refunded_cents":row["hosted_checkout"]["refunded_cents"],"needs_review":row["hosted_checkout"]["status"]=="needs_review" || cents(&row["reversed_cents"])>0,"test":row["hosted_checkout"]["livemode"]==false})).collect::<Vec<_>>(),
    });

    if let Some(b) = account.as_ref().filter(|_| opt.history) {
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
            "coverage_verification": coverage.as_ref().map(|(content, _)| content["verification"].clone()),
            "member_id": coverage.as_ref().map(|(content, _)| content["member_id"].clone()),
            "payer_code": coverage.as_ref().map(|(_, payer)| payer["payer_code"].clone()),
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
    for row in receipts {
        events.push(json!({"at":row["created_at"],"group":"payments","code":if row["voided"]==true {"receipt_voided"} else {"payment_received"},"amount_cents":row["amount_cents"],"method":if row["hosted_checkout"].is_object() { json!("card") } else { row["method"].clone() },"occurred_on":row["occurred_on"],"receipt_id":row["id"],"appointment_id":row["appointment_id"],"refunded_cents":row["hosted_checkout"]["refunded_cents"]}));
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
fn luhn_npi(s: &str) -> bool {
    s.len() == 10
        && s.bytes().all(|b| b.is_ascii_digit())
        && format!("80840{s}")
            .bytes()
            .rev()
            .enumerate()
            .map(|(i, b)| {
                let n = (b - b'0') as u32;
                if i % 2 == 1 {
                    if n * 2 > 9 {
                        n * 2 - 9
                    } else {
                        n * 2
                    }
                } else {
                    n
                }
            })
            .sum::<u32>()
            % 10
            == 0
}

/// The claim details a person would otherwise type: provider and place from the practice
/// directory, tax ID from the practice's billing organization, addresses and policy holder
/// from the chart and coverage, diagnoses from the charge lines.
async fn claim_defaults(
    pool: &PgPool,
    a: &Actor,
    p: Uuid,
    b: &billing::Account,
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
    let providers: Vec<(Uuid, String, String)> = sqlx::query_as("SELECT p.id,p.display_name,p.npi FROM practice_providers p JOIN browser_users u ON u.tenant_id=p.tenant_id AND u.id=p.id WHERE p.tenant_id=$1 AND p.active AND NOT u.disabled AND u.role IN ('owner','clinician') ORDER BY p.display_name,p.id LIMIT 100")
        .bind(a.tenant_id).fetch_all(pool).await?;
    let providers: Vec<_> = providers
        .into_iter()
        .filter(|row| luhn_npi(&row.2))
        .collect();
    let provider = providers
        .iter()
        .find(|row| Some(row.0) == clinician)
        .or_else(|| (providers.len() == 1).then(|| &providers[0]));
    let facilities: Vec<(String, String)> = sqlx::query_as("SELECT name,address FROM practice_facilities WHERE tenant_id=$1 AND active ORDER BY name,id LIMIT 2")
        .bind(a.tenant_id).fetch_all(pool).await?;
    let facility = (facilities.len() == 1).then(|| &facilities[0]);
    // The tax ID is used only when the practice has exactly one active billing organization.
    let organizations = crate::practice_billing::choices(pool, a.tenant_id).await?;
    let mut tax_id = String::new();
    let mut organization_name = String::new();
    if let [organization] = organizations.as_slice() {
        if let Some(id) = organization["id"]
            .as_str()
            .and_then(|v| Uuid::parse_str(v).ok())
        {
            if let Some((_, secret)) =
                crate::practice_billing::tax_identity(pool, a.tenant_id, id).await?
            {
                tax_id = secret.expose().to_owned();
                organization_name = organization["name"].as_str().unwrap_or("").to_owned();
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
    Ok(ClaimContent {
        billing_provider_name: facility
            .map(|row| row.0.clone())
            .filter(|name| !name.trim().is_empty())
            .or_else(|| Some(organization_name).filter(|name| !name.is_empty()))
            .or_else(|| provider.map(|row| row.1.clone()))
            .unwrap_or_default(),
        billing_npi: provider.map(|row| row.2.clone()).unwrap_or_default(),
        tax_id,
        billing_address: facility.map(|row| row.1.clone()).unwrap_or_default(),
        rendering_npi: provider.map(|row| row.2.clone()).unwrap_or_default(),
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
        place_of_service: place.unwrap_or_else(|| "11".into()),
        diagnosis_codes,
        line_diagnosis_pointers,
        external_control_number: String::new(),
        notes: String::new(),
        synthetic_test: false,
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
    a.scheduling()?;
    let mut tx = pool.begin().await?;
    let account = claims::account(&mut tx, a, account_id, Some(p)).await?;
    let support = delegated(&mut tx, a).await?;
    tx.commit().await?;
    // A delegated support session acts with the owner's authority, but a claim is prepared
    // by the practice: nothing is written for it, whether asked for or not.
    if support {
        return Ok(json!({"outcome":"delegated"}));
    }
    let skipped = |reason: &str| Ok(json!({"outcome":"not_needed","reason":reason}));
    if account.status != "posted" {
        return skipped("charges_not_posted");
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
    let mut content = claim_defaults(pool, a, p, &account).await?;
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let b = claims::account(&mut tx, a, account_id, Some(p)).await?;
    if b.status != "posted" || b.coverage_snapshot != account.coverage_snapshot {
        return Err(Error::Conflict("the charges changed; open the visit again"));
    }
    let existing: Vec<(Uuid, String, Value)> = sqlx::query_as("SELECT id,status,content FROM ehr_claims WHERE tenant_id=$1 AND account_id=$2 ORDER BY created_at,id")
        .bind(a.tenant_id).bind(account_id).fetch_all(&mut *tx).await?;
    if let Some((id, _, _)) = existing.iter().rev().find(|row| row.1 != "void") {
        return Ok(json!({"outcome":"exists","claim_id":id}));
    }
    if let Some((_, _, cancelled)) = existing.last() {
        if !again {
            return Ok(json!({"outcome":"cancelled"}));
        }
        // Keep what a person had corrected on the cancelled claim.
        if let Ok(previous) = serde_json::from_value::<ClaimContent>(cancelled.clone()) {
            content = ClaimContent {
                external_control_number: String::new(),
                ..previous
            };
        }
    }
    content.validate()?;
    let payer_id: Uuid = serde_json::from_value(snapshot["payer"]["id"].clone())
        .map_err(|_| Error::Invalid("invalid payer snapshot"))?;
    let request_id = derived_id(&("visit-claim", a.tenant_id, account_id, existing.len()))?;
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
            reason: AUTO_REASON,
            automatic: true,
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
}
async fn prepare(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    body: Option<Json<Prepare>>,
) -> Result<Json<Value>> {
    let again = body.map(|Json(v)| v.again).unwrap_or(false);
    Ok(Json(prepare_claim(db(&s)?, &a, p, id, again).await?))
}
async fn make_statement(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    Ok(Json(statement(db(&s)?, &a, p, id).await?))
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/patients/{p}/billing/visit-summary", get(read))
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
        let out = receipts(rows, Some(appointment));
        assert_eq!(out.net_received, 3000);
        assert_eq!(out.usable_unapplied, 2000);
        assert_eq!(out.items.len(), 3);
        assert!(!out.needs_review);
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
}
