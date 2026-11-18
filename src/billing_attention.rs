// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! One read-only look at the billing work that is waiting for someone.
//!
//! Nothing here writes: every item is derived from records the practice already made
//! (posted charges, claims, imported insurance payments, patient statements), so no new
//! table or migration is needed. Staff whose access policy hides claims or patient
//! billing are shown an empty queue rather than an error, so the page they open never
//! fails on them. Money owed by an insurer is also aged from the service date, which is
//! what a practice watches month to month.
use crate::{
    auth::Actor,
    error::{Error, Result},
    visit_billing, State,
};
use axum::{extract::State as ExtractState, routing::get, Json, Router};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashMap;
use uuid::Uuid;

/// A claim sent this long ago with no answer from the payer is worth a look.
pub(crate) const WAITING_DAYS: i64 = 21;
/// Items past this count are cut off; the queue is a working list, not a report.
const LIMIT: usize = 200;
/// Ages stay inside the unsigned range the published contract allows.
const MAX_AGE_DAYS: i64 = 1_000_000;
/// Insurance money outstanding, grouped by days since the service date.
const BUCKETS: [(&str, i64); 4] = [
    ("0-30", 30),
    ("31-60", 60),
    ("61-90", 90),
    ("over 90", 3650),
];
/// Kinds in the order staff are asked to work them. An unexplained refusal or a
/// denial costs the practice the whole visit, so it comes before routine follow-up.
const KIND_ORDER: [&str; 6] = [
    "rejected",
    "denied",
    "era_needs_review",
    "ready_to_send",
    "waiting_on_payer",
    "patient_balance",
];

pub fn router() -> Router<State> {
    Router::new().route("/api/v1/billing/attention", get(attention))
}

fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}

fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_owned()
}

fn uuid(v: &Value, key: &str) -> Option<Uuid> {
    v[key].as_str().and_then(|s| Uuid::parse_str(s).ok())
}

fn cents(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}

/// A name for a sentence, with a plain subject when the record has none.
fn named(value: &Value, fall_back: &str) -> String {
    match value.as_str().map(str::trim).filter(|v| !v.is_empty()) {
        Some(value) => value.to_owned(),
        None => fall_back.to_owned(),
    }
}

/// Days between a `YYYY-MM-DD` date and today, kept in the range the contract
/// publishes. Charges dated in the future read as zero days old.
fn days_before(date: &str, today: chrono::NaiveDate) -> Option<i64> {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .map(|date| (today - date).num_days().clamp(0, MAX_AGE_DAYS))
}

/// Money in the plain words staff read on a screen.
fn dollars(cents: i64) -> String {
    let value = cents.abs();
    format!(
        "{}${}.{:02}",
        if cents < 0 { "-" } else { "" },
        value / 100,
        value % 100
    )
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_owned();
    }
    let keep: String = value.chars().take(max - 1).collect();
    format!("{}…", keep.trim_end())
}

/// A message for staff has to be a sentence they can act on, so the contract
/// requires at least one word in it.
fn sentence(value: String) -> String {
    if value.chars().any(char::is_alphabetic) {
        truncate(&value, 400)
    } else {
        "This visit needs someone to check its billing.".to_owned()
    }
}

/// The payer's own words for a refused claim, taken from the event that recorded it.
/// Recorded reasons are staff or clearinghouse free text, so anything unusable falls
/// back to the plain sentence rather than showing a code.
fn rejection_reason(evidence: &Value) -> Option<String> {
    ["message", "reason", "detail", "description"]
        .iter()
        .filter_map(|key| evidence[*key].as_str())
        .map(str::trim)
        .find(|value| value.chars().count() > 3 && value.chars().any(char::is_alphabetic))
        .map(|value| truncate(value, 260))
}

/// The answer for one charge account, as the queue states it.
#[derive(Clone, Copy)]
struct Work {
    kind: &'static str,
    amount: i64,
    label: &'static str,
    target: &'static str,
    /// Which half of the queue may show this.
    half: Half,
    age_days: i64,
    pending_cents: i64,
}

/// Which half of the practice's policy opens an item: claim work by the claims area, a
/// patient's own bill by patient billing. Preparing charges that have never reached a
/// payer is neither yet — no claim exists or nothing was received — so either staff
/// member reading billing at all is asked to prepare them or chase the signature.
#[derive(Clone, Copy)]
enum Half {
    Claims,
    Billing,
    Signature,
}

/// The balance rows the queue reads, so a test can check the queue against the same
/// figures the visit's billing card and the patient's bill read.
#[doc(hidden)]
pub async fn balances_for_tests(
    pool: &PgPool,
    tenant: Uuid,
    accounts: &[Uuid],
) -> Result<Vec<Value>> {
    let mut tx = pool.begin().await?;
    let rows = visit_billing::balances(&mut tx, tenant, None, Some(accounts), None).await?;
    tx.commit().await?;
    Ok(rows)
}

/// The claim context the queue reads for the given accounts, so a test can check what
/// it says against the records the practice made.
#[doc(hidden)]
pub async fn claim_context_for_tests(
    pool: &PgPool,
    tenant: Uuid,
    accounts: &[Uuid],
) -> Result<Vec<Value>> {
    let mut tx = pool.begin().await?;
    let rows = claim_context(&mut tx, tenant, accounts).await?;
    tx.commit().await?;
    Ok(rows)
}

/// What a charge account is waiting on. The balance row is the same one the visit's
/// billing card and the patient's bill read, so the queue cannot disagree with them.
fn work_for(row: &Value, claim: &Value, today: chrono::NaiveDate) -> Option<(Work, String)> {
    let age_days = days_before(&text(claim, "service_date"), today).unwrap_or(0);
    let pending = cents(&row["pending_cents"]);
    let balance = cents(&row["balance_cents"]);
    let owes = cents(&row["owes_now_cents"]);
    let posted = row["posted"] == true;
    let insured = row["insured"] == true;
    let status = text(row, "claim_status");
    let payer = named(&claim["payer_name"], "the payer");
    // A claim the queue can actually speak of: the context excludes a voided claim, a
    // crossover record and a synthetic lifecycle test, exactly as the claim screens do.
    let has_claim = claim["claim_id"] != Value::Null;
    // Whether any event says the payer ever received this claim. A crossover record is
    // itself payer-side evidence that the primary claim went out, so the money waits on
    // the payer even though the queue names no claim of its own.
    let sent = claim["sent_on"] != Value::Null || claim["crossover"] == true;
    // The day the claim reached the payer, when the queue knows it: the submission
    // event's day; a crossover row's own day is when the primary's payment landed, not
    // when anything was sent, so that wait is not counted from it.
    let sent_days = days_before(&text(claim, "sent_on"), today);
    // The payer's posted row status on the current answer, when there is one.
    let head_status = text(claim, "head_status");
    // The engine raises its denial flag when a posted answer's row refused the claim.
    let denied = row["denied"] == true;
    let work = |kind: &'static str,
                amount: i64,
                label: &'static str,
                target: &'static str,
                half: Half,
                age_days: i64,
                pending_cents: i64,
                message: String| {
        Some((
            Work {
                kind,
                amount,
                label,
                target,
                half,
                age_days,
                pending_cents,
            },
            message,
        ))
    };

    if !posted {
        // Charges are only ready to send once the clinician has signed the visit.
        if has_claim {
            return None;
        }
        let signed = text(row, "visit_status") == "signed";
        let total = cents(&row["total_cents"]);
        return work(
            "ready_to_send",
            total,
            if signed {
                "Prepare the claim"
            } else {
                "Ask for the visit signature"
            },
            "visit_review",
            Half::Signature,
            age_days,
            pending,
            if signed {
                format!(
                    "Charges of {} are posted for a signed visit and no claim has been prepared.",
                    dollars(total)
                )
            } else {
                format!(
                    "These charges of {} are waiting for the clinician to sign the visit.",
                    dollars(total)
                )
            },
        );
    }
    // A visit the insurer was never asked about is the patient's own bill.
    if owes > 0 {
        return work(
            "patient_balance",
            owes,
            "Collect from the patient",
            "patient_billing",
            Half::Billing,
            age_days,
            pending,
            format!(
                "{} still owes {} for this visit.",
                named(&claim["patient_name"], "The patient"),
                dollars(owes)
            ),
        );
    }
    // The payer's posted answer refused the claim and paid nothing: the whole visit is
    // at risk, so it comes before routine follow-up and is worked as a review.
    if insured && denied && head_status == "4" {
        return work(
            "denied",
            balance,
            "Review the answer",
            "claim",
            Half::Claims,
            age_days,
            pending,
            format!(
                "The payer answered {} and paid nothing on this claim.",
                status.as_str()
            ),
        );
    }
    // A refusal the payer's own posted row does not stand behind: the practice can fix
    // it and send it again. Once a posted status-4 answer sits behind the refusal it is
    // the denial kind above, worked as a review of the payer's decision, not a fix.
    if insured && status == "rejected" && head_status != "4" {
        return work(
            "rejected",
            balance,
            "Fix the claim",
            "claim",
            Half::Claims,
            age_days,
            pending,
            match rejection_reason(&claim["rejection"]) {
                Some(reason) => format!("{} refused this claim: {reason}", payer),
                None => format!("{payer} refused this claim. Fix it and send it again."),
            },
        );
    }
    if insured && !has_claim {
        // Posted insured charges with no claim of their own are waiting to be sent.
        return work(
            "ready_to_send",
            balance,
            "Prepare the claim",
            "visit_review",
            Half::Signature,
            age_days,
            pending,
            format!(
                "Charges of {} are posted for a signed visit and no claim has been prepared.",
                dollars(balance)
            ),
        );
    }
    // A claim only waits on the payer once there is a submission behind it. Without
    // one it is still the practice's own work, and aging it as insurance money would
    // be wrong. A claim already being prepared is not work to prepare twice.
    if !sent {
        if matches!(status.as_str(), "draft" | "ready") {
            return None;
        }
        return work(
            "ready_to_send",
            balance,
            "Prepare the claim",
            "visit_review",
            Half::Signature,
            age_days,
            pending,
            format!(
                "The claim for these charges of {} has not reached the payer.",
                dollars(balance)
            ),
        );
    }
    if insured && matches!(status.as_str(), "submitted" | "accepted") {
        // The payer's payment has arrived but nobody has posted it yet.
        let waiting = cents(&claim["waiting_cents"]).min(pending.max(balance));
        if waiting > 0 {
            return work(
                "era_needs_review",
                waiting.max(balance),
                "Post the payment",
                "era",
                Half::Claims,
                age_days,
                pending,
                format!(
                    "An insurance payment of {} for this claim is imported and waiting to be posted.",
                    dollars(waiting)
                ),
            );
        }
        // Sent and still unanswered for long enough to chase. Insurance money owed is
        // what `pending` is while no answer has been posted, so an account that has
        // already been fully paid or fully moved to the patient is not waiting.
        // Without a submission event the day it went out is unknown, so nothing is
        // claimed to be overdue.
        let owed_by_insurer = pending > 0 || (balance > 0 && owes == 0);
        if owed_by_insurer && sent_days.is_some_and(|days| days >= WAITING_DAYS) {
            let days = sent_days.unwrap_or_default();
            return work(
                "waiting_on_payer",
                pending,
                "Follow up with the payer",
                "claim",
                Half::Claims,
                days,
                pending,
                format!(
                    "Insurance money on this visit has waited {days} days since the claim went out and {} is still owed.",
                    dollars(pending)
                ),
            );
        }
    }
    None
}

/// Insurance money outstanding, by days since the service date. Every bucket is
/// always present so the page can lay the four columns out without guessing.
fn aging(money: &[(i64, i64)]) -> Value {
    let buckets: Vec<Value> = BUCKETS
        .iter()
        .map(|(label, upper)| {
            let in_bucket: Vec<(i64, i64)> = money
                .iter()
                .copied()
                .filter(|(days, cents)| *cents > 0 && *days <= *upper)
                .collect();
            json!({
                "label": label,
                "count": in_bucket.len(),
                "cents": in_bucket.iter().map(|row| row.1).sum::<i64>(),
            })
        })
        .collect();
    json!({
        "buckets": buckets,
        "total_cents": money.iter().map(|row| row.1).sum::<i64>(),
    })
}

/// The whole queue: derived rows sorted by kind, then oldest first.
pub(crate) async fn collect(
    pool: &PgPool,
    a: &Actor,
    claims_visible: bool,
    billing_visible: bool,
    today: chrono::NaiveDate,
) -> Result<Value> {
    let empty = || {
        json!({
            "items": [], "aging": aging(&[]), "currency": "USD", "waiting_days": WAITING_DAYS,
        })
    };
    if !claims_visible && !billing_visible {
        return Ok(empty());
    }
    let mut tx = pool.begin().await?;
    // Every item and the aging total describe the same moment, even while another
    // staff member posts a payment. The only write here is the read audit.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    // Recorded activity only: test-processor money is never queue work.
    let rows = visit_billing::balances(&mut tx, a.tenant_id, None, None, Some(false)).await?;
    let accounts: Vec<Uuid> = rows
        .iter()
        .filter(|row| cents(&row["balance_cents"]) > 0)
        .filter(|row| {
            // With patient billing only, the queue can still hold a patient's own
            // balance and charges whose claim nobody has prepared or sent yet — the
            // claim-side answers are not read for an account it cannot show.
            claims_visible || cents(&row["owes_now_cents"]) > 0 || row["posted"] != true
        })
        .filter_map(|row| uuid(row, "id"))
        .collect();
    let claims = claim_context(&mut tx, a.tenant_id, &accounts)
        .await?
        .into_iter()
        .filter_map(|row| Some((uuid(&row, "account_id")?, row)))
        .collect::<HashMap<Uuid, Value>>();
    let mut items: Vec<(usize, i64, Value)> = vec![];
    let mut money: Vec<(i64, i64)> = vec![];
    for row in rows.iter().filter(|row| cents(&row["balance_cents"]) > 0) {
        let Some(account) = uuid(row, "id") else {
            continue;
        };
        let Some(claim) = claims.get(&account) else {
            continue;
        };
        let Some((item, message)) = work_for(row, claim, today) else {
            continue;
        };
        // Each item belongs to exactly one half of the queue and is shown by the area
        // that owns it: claim work by the claims area, a patient's bill by patient
        // billing, and preparing an unseen claim or chasing a signature by either.
        let visible = match item.half {
            Half::Claims => claims_visible,
            Half::Billing => billing_visible,
            Half::Signature => claims_visible || billing_visible,
        };
        if !visible {
            continue;
        }
        // Aging counts insurance money the practice has already asked a payer for and
        // not yet received: an unprepared claim or a patient's own balance is not it.
        if matches!(item.kind, "waiting_on_payer" | "denied" | "rejected")
            && item.pending_cents.max(item.amount) > 0
        {
            money.push((item.age_days, item.pending_cents.max(item.amount)));
        }
        let rank = KIND_ORDER
            .iter()
            .position(|kind| *kind == item.kind)
            .unwrap_or(KIND_ORDER.len());
        items.push((
            rank,
            item.age_days,
            json!({
                "kind": item.kind,
                "patient_id": row["patient_id"],
                "patient_name": claim["patient_name"],
                "visit_id": claim["visit_id"],
                "claim_id": claim["claim_id"],
                "amount_cents": item.amount.max(1),
                "age_days": item.age_days,
                "message": sentence(message),
                "action": {"label": item.label, "target": item.target},
            }),
        ));
    }
    items.sort_by(|a, b| {
        (a.0, -a.1, a.2["patient_name"].as_str().unwrap_or_default()).cmp(&(
            b.0,
            -b.1,
            b.2["patient_name"].as_str().unwrap_or_default(),
        ))
    });
    let items: Vec<Value> = items
        .into_iter()
        .take(LIMIT)
        .map(|(_, _, item)| item)
        .collect();
    crate::postgres::audit(&mut tx, a, "billing.attention_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(json!({
        "items": items,
        "aging": aging(&money),
        "currency": "USD",
        "waiting_days": WAITING_DAYS,
    }))
}

/// The one claim that decides each account's next step, with the fewest reads that
/// still explain it: when it went out, the payer's reason if it was refused, the
/// payer's status code if it answered, and any imported payment waiting to be posted.
/// Accounts with no claim still get a row so the visit can be named. A voided claim,
/// a crossover record and a claim marked as a synthetic lifecycle test all count for
/// nothing, exactly as on the claim screens.
async fn claim_context(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    tenant: Uuid,
    accounts: &[Uuid],
) -> Result<Vec<Value>> {
    if accounts.is_empty() {
        return Ok(vec![]);
    }
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "SELECT jsonb_build_object(",
        "'account_id',b.id,'visit_id',b.visit_id,",
        "'patient_name',p.family_name||', '||p.given_name,",
        "'service_date',coalesce(nullif(b.content->>'service_date',''),",
        "to_char(b.created_at,'YYYY-MM-DD')),",
        "'claim_id',k.id,'claim_status',k.status,",
        "'payer_name',k.snapshot->'account'->'coverage_snapshot'->'payer'->'content'->>'name',",
        // The day the payer received the claim: the clearinghouse event date when the
        // submission recorded one, otherwise the day the submission was made.
        "'sent_on',(SELECT coalesce(nullif(v.evidence->>'event_date',''),",
        "to_char(v.created_at,'YYYY-MM-DD')) FROM claim_revisions v",
        " WHERE v.tenant_id=k.tenant_id AND v.claim_id=k.id AND v.snapshot->>'status'='submitted'",
        " ORDER BY v.version LIMIT 1),",
        "'rejection',(SELECT v.evidence FROM claim_revisions v",
        " WHERE v.tenant_id=k.tenant_id AND v.claim_id=k.id AND v.snapshot->>'status'='rejected'",
        " ORDER BY v.version DESC LIMIT 1),",
        // The payer's own row status on the current answer, read the way the ledger
        // reads it: the posting chain's head for this claim, over a posted remittance.
        // An unposted import is not an answer, and an older posting is not the current
        // one — a claim worked twice must report the payer's latest decision.
        "'head_status',(SELECT r.document->'claims'->h.row_index->>'status'",
        " FROM era_claim_heads h",
        " JOIN era_remittances r ON r.tenant_id=h.tenant_id AND r.id=h.remittance_id",
        " AND r.status='posted'",
        " WHERE h.tenant_id=k.tenant_id AND h.claim_id=k.id LIMIT 1),",
        // An imported payment nobody has posted yet, matched on the payer's own
        // control number for this claim.
        "'waiting_cents',(SELECT coalesce(sum((x->>'paid_cents')::bigint),0)",
        " FROM era_remittances s",
        " CROSS JOIN LATERAL jsonb_array_elements(",
        " CASE WHEN jsonb_typeof(s.document->'claims')='array'",
        " THEN s.document->'claims' ELSE '[]'::jsonb END) x",
        " WHERE s.tenant_id=k.tenant_id AND s.status='staged'",
        " AND s.document->'claims' @> jsonb_build_array(",
        " jsonb_build_object('control_number',k.control_number))),",
        "'control_number',k.control_number)",
        " FROM billing_accounts b",
        " JOIN patients p ON p.tenant_id=b.tenant_id AND p.id=b.patient_id",
        // The one claim that decides the account's next step. A voided claim, a
        // crossover record and a synthetic lifecycle test count for nothing, exactly
        // as on the claim screens.
        " LEFT JOIN LATERAL (SELECT c.id,c.status,c.snapshot,c.tenant_id,c.control_number",
        " FROM ehr_claims c",
        " WHERE c.tenant_id=b.tenant_id AND c.account_id=b.id AND c.status<>'void'",
        " AND coalesce(jsonb_typeof(c.snapshot->'coordination_of_benefits'->'crossover')='object',false)=false",
        " AND coalesce((c.content->>'synthetic_test')::boolean,false)=false",
        // The payer's answer is what the queue reports, so a claim already answered
        // outranks one still being worked, and the newest answer outranks the older
        // attempts behind it.
        " ORDER BY (c.status IN ('adjudicated','rejected')) DESC,",
        " c.created_at DESC,c.id DESC LIMIT 1) k ON true",
        " WHERE b.tenant_id=$1 AND b.id=ANY($2)"
    ))
    .bind(tenant)
    .bind(accounts)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows)
}

async fn attention(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    // Insurance work is gated by the claims area and the patient's own balance by
    // patient billing, so the queue answers for whichever half this staff member can
    // see instead of failing on the half they cannot.
    let views = crate::access_policies::can_view(&s, &a, &["claims", "billing"]).await?;
    Ok(Json(
        collect(
            db(&s)?,
            &a,
            views[0],
            views[1],
            chrono::Utc::now().date_naive(),
        )
        .await?,
    ))
}

/// The day the queue ages against. Tests build their records around it so an age is
/// decided by the fixture rather than by when the test happens to run.
pub fn today_for_tests() -> chrono::NaiveDate {
    chrono::Utc::now().date_naive()
}
