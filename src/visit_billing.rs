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
        ("tertiary", "a third insurer cannot be billed electronically")
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
    let electronic = coverage.as_ref().is_some_and(|(_, payer)| {
        !payer["payer_code"].as_str().unwrap_or("").trim().is_empty()
    });
    let plan_copay = coverage
        .as_ref()
        .and_then(|(content, _)| content["copay_cents"].as_i64());

    let paid_at_desk = receipts(billing::copay_rows(tx, a, p, None).await?, appointment);

    // Ledger: the same sums the account balance, invoices and claims already use.
    let total = account.as_ref().map(|b| b.total_cents).unwrap_or(0);
    let (mut balance, mut patient_credit, mut patient_payments, mut insurer_paid, mut receipts_applied) =
        (0i64, 0i64, 0i64, 0i64, 0i64);
    if let Some(b) = account.as_ref().filter(|_| posted) {
        let (net, insurer, applied): (i64, i64, i64) = sqlx::query_as(
            "SELECT coalesce(sum(e.effect_cents),0)::bigint,\
             coalesce(-sum(e.effect_cents) FILTER (WHERE (CASE WHEN e.kind='reversal' THEN o.content->>'party' ELSE e.content->>'party' END)='insurer' AND (e.kind='payment' OR (e.kind='reversal' AND o.kind='payment'))),0)::bigint,\
             coalesce(-sum(e.effect_cents) FILTER (WHERE coalesce(o.content,e.content) ? 'copay_receipt_id'),0)::bigint \
             FROM billing_entries e LEFT JOIN billing_entries o ON o.tenant_id=e.tenant_id AND o.account_id=e.account_id AND o.id=e.reverses_id WHERE e.tenant_id=$1 AND e.account_id=$2",
        )
        .bind(a.tenant_id)
        .bind(b.id)
        .fetch_one(&mut **tx)
        .await?;
        balance = b.total_cents + net;
        insurer_paid = insurer;
        receipts_applied = applied;
        (patient_credit, patient_payments) =
            billing::patient_ledger_totals(tx, a.tenant_id, b.id).await?;
    }
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
    // A denial is not the insurer's final word on what the patient owes: the claim is
    // corrected and resent, so the plan copay still stands until it is answered.
    let answered = open.is_none()
        && latest.is_some_and(|c| {
            c.status() == "adjudicated" && c.answer.as_ref().is_some_and(|x| !x.denied)
        });
    let answer = latest.filter(|_| answered).and_then(|c| c.answer.as_ref());

    // The patient's share and what is still with the insurer.
    let (responsibility, source) = if !posted {
        match (insured, plan_copay) {
            (true, Some(copay)) => (copay, "plan_copay"),
            (true, None) => (0, "copay_not_recorded"),
            _ => (0, "not_final"),
        }
    } else if !insured {
        (total, "self_pay")
    } else if let Some(answer) = answer {
        (answer.patient_responsibility.clamp(0, total), "insurer_response")
    } else {
        match plan_copay {
            Some(copay) => (copay.clamp(0, total), "plan_copay"),
            None => (0, "copay_not_recorded"),
        }
    };
    let owes_now = if posted {
        (responsibility - patient_credit - paid_at_desk.usable_unapplied).clamp(0, balance.max(0))
    } else {
        (responsibility - paid_at_desk.net_received).max(0)
    };
    let remainder = if posted { (balance - owes_now).max(0) } else { 0 };
    let (pending, unassigned) = if !insured {
        (0, 0)
    } else if answered {
        (0, remainder)
    } else {
        (remainder, 0)
    };
    // Paid more than the patient's share, or (an insurer payment can do this) more than
    // the whole charge: a credit to refund or apply, never a negative amount owed.
    let overpaid = if posted && (answered || !insured) {
        (patient_credit - responsibility).max(0)
    } else {
        0
    }
    .max(-balance);
    let credit = paid_at_desk.usable_unapplied + overpaid;

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
    let any_void = views.iter().any(|c| c.status() == "void");
    let denied = open.is_none()
        && latest.is_some_and(|c| {
            c.status() == "rejected"
                || (c.status() == "adjudicated" && c.answer.as_ref().is_some_and(|x| x.denied))
        });
    let (state, waiting_on) = match &account {
        None => ("add_charges", "staff"),
        Some(_) if void => ("add_charges", "staff"),
        Some(_) if !posted => {
            if visit_row.as_ref().is_none_or(|row| row.1 == "signed") {
                ("post_charges", "staff")
            } else {
                ("sign_visit", "clinician")
            }
        }
        Some(_) if !insured => {
            if owes_now > 0 {
                ("self_pay_collect", "patient")
            } else if credit > 0 {
                ("patient_credit", "staff")
            } else {
                ("paid_in_full", "nobody")
            }
        }
        Some(_) if restricted => ("claim_restricted", "staff"),
        Some(_) => match latest {
            None if !electronic => ("insurance_outside", "staff"),
            None if any_void => ("claim_cancelled", "staff"),
            None => ("prepare_claim", "staff"),
            Some(c) => match c.status() {
                "draft" if !issues.is_empty() => ("fix_claim", "staff"),
                "draft" | "ready" => ("send_claim", "staff"),
                "submitted" | "accepted" if c.row["response_to_review"].is_string() => {
                    ("post_response", "staff")
                }
                "submitted" | "accepted" => ("waiting_insurer", "insurer"),
                _ if denied => ("denied", "staff"),
                _ if owes_now > 0 => ("patient_owes", "patient"),
                _ if unassigned > 0 => ("review_response", "staff"),
                _ if credit > 0 => ("patient_credit", "staff"),
                _ => ("paid_in_full", "nobody"),
            },
        },
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
            "received_cents": paid_at_desk.net_received,
            "receipts_applied_cents": receipts_applied,
            "other_payments_cents": patient_payments - receipts_applied,
            "adjustment_cents": patient_credit - patient_payments,
            "unapplied_cents": paid_at_desk.usable_unapplied,
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
        out["timeline"] = json!(timeline(tx, a, b, &views, &paid_at_desk.items, &statements).await?);
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
            ("payment", "patient") if entry["from_receipt"] == true => ("payments", "receipt_applied"),
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
    let clinician: Option<Uuid> = match b.content["visit_id"].as_str().and_then(|v| Uuid::parse_str(v).ok()) {
        Some(v) => sqlx::query_scalar("SELECT clinician_id FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND id=$3")
            .bind(a.tenant_id).bind(p).bind(v).fetch_optional(pool).await?,
        None => None,
    };
    let providers: Vec<(Uuid, String, String)> = sqlx::query_as("SELECT p.id,p.display_name,p.npi FROM practice_providers p JOIN browser_users u ON u.tenant_id=p.tenant_id AND u.id=p.id WHERE p.tenant_id=$1 AND p.active AND NOT u.disabled AND u.role IN ('owner','clinician') ORDER BY p.display_name,p.id LIMIT 100")
        .bind(a.tenant_id).fetch_all(pool).await?;
    let providers: Vec<_> = providers.into_iter().filter(|row| luhn_npi(&row.2)).collect();
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
        if let Some(id) = organization["id"].as_str().and_then(|v| Uuid::parse_str(v).ok()) {
            if let Some((_, secret)) =
                crate::practice_billing::tax_identity(pool, a.tenant_id, id).await?
            {
                tax_id = secret.expose().to_owned();
                organization_name = organization["name"].as_str().unwrap_or("").to_owned();
            }
        }
    }
    let demographics: Option<Value> = sqlx::query_scalar("SELECT content FROM patient_demographics WHERE tenant_id=$1 AND patient_id=$2")
        .bind(a.tenant_id).bind(p).fetch_optional(pool).await?;
    let birth_date: Option<NaiveDate> = sqlx::query_scalar("SELECT birth_date FROM patients WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id).bind(p).fetch_optional(pool).await?.flatten();
    // The place of service follows the practice's most recent claim; a first claim uses
    // 11 (office). Staff see and can change it before anything is sent.
    let place: Option<String> = sqlx::query_scalar("SELECT content->>'place_of_service' FROM ehr_claims WHERE tenant_id=$1 AND status<>'void' AND content->>'place_of_service' ~ '^[0-9]{2}$' ORDER BY created_at DESC,id DESC LIMIT 1")
        .bind(a.tenant_id).fetch_optional(pool).await?.flatten();
    let coverage = &b.coverage_snapshot.as_ref().ok_or(Error::Invalid("insurance coverage is required for a claim"))?["coverage"]["content"];
    let own_policy = coverage["relationship"] == "self";
    let patient_address = joined_address(demographics.as_ref());
    let (diagnosis_codes, line_diagnosis_pointers) =
        charge_diagnoses(b.content["lines"].as_array().map(Vec::as_slice).unwrap_or(&[]));
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
    tx.commit().await?;
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
pub(crate) async fn statement(pool: &PgPool, a: &Actor, p: Uuid, account_id: Uuid) -> Result<Value> {
    a.scheduling()?;
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let account = billing::account_row(&mut tx, a, p, account_id).await?;
    if account.status != "posted" {
        return Err(Error::Conflict("post the charges before preparing a statement"));
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
    let request_id = derived_id(&("visit-statement", a.tenant_id, account_id, account.version, responsibility))?;
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
    let known: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
        .bind(a.tenant_id).bind(p).fetch_one(&mut *tx).await?;
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
        assert_eq!(plain_issue("Tax ID is required")["missing"], "billing organization tax ID");
        assert_eq!(plain_issue("Tax ID must contain nine digits")["code"], "tax_id");
        assert_eq!(plain_issue("Something new")["missing"], "Something new");
    }

    #[test]
    fn derived_request_ids_are_stable() {
        let id = Uuid::new_v4();
        assert_eq!(derived_id(&("x", id, 1)).unwrap(), derived_id(&("x", id, 1)).unwrap());
        assert_ne!(derived_id(&("x", id, 1)).unwrap(), derived_id(&("x", id, 2)).unwrap());
    }
}
