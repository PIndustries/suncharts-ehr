// SPDX-License-Identifier: AGPL-3.0-only
//! The practice overview's numbers: claims by where they stand, money recorded, patients and the
//! gaps in their records, and a 30-day trend. Read only, derived from saved records; each money or
//! claim figure is returned only when the person may see billing.
use crate::{
    auth::Actor,
    error::{Error, Result},
    patient_lifecycle::{MISSING_ADDRESS, MISSING_PHONE},
    State,
};
use axum::{
    extract::{Query, State as ExtractState},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// Money received, one row per payment, for the Home figures and the 30-day line. Each payment is
/// counted once: a desk or card receipt on the day it was taken, net of refunds; and a payment
/// posted straight to an encounter (an insurance payment, an invoice paid by card) on the day it
/// was posted. A ledger line that only applies a receipt is not a second payment. Voided
/// receipts, reversed postings and test-mode card payments are not money received.
const PAID: &str = "
               SELECT r.occurred_on AS day, greatest(0, r.amount_cents - coalesce(o.refunded_cents,0)) AS cents,
                      r.id, r.created_at, 'copay'::text AS source, r.patient_id, NULL::uuid AS account_id,
                      r.method, NULL::text AS party
                 FROM billing_copay_receipts r
                 LEFT JOIN copay_checkout_attempts o ON o.tenant_id=r.tenant_id AND o.receipt_id=r.id
                WHERE r.tenant_id=$1 AND coalesce(o.livemode,true)
                  AND NOT EXISTS(SELECT 1 FROM billing_copay_voids v WHERE v.tenant_id=r.tenant_id AND v.receipt_id=r.id)
               UNION ALL
               SELECT (e.created_at AT TIME ZONE $2)::date, abs(e.effect_cents),
                      e.id, e.created_at, 'ledger', NULL::uuid, e.account_id,
                      e.content->>'method', e.content->>'party'
                 FROM billing_entries e
                WHERE e.tenant_id=$1 AND e.kind='payment' AND NOT (e.content ? 'copay_receipt_id')
                  AND coalesce(e.content->>'test_mode','false')<>'true'
                  AND NOT EXISTS(SELECT 1 FROM billing_entries x WHERE x.tenant_id=e.tenant_id AND x.reverses_id=e.id)";

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/practice/overview", get(overview))
        .route("/api/v1/billing/collections/today", get(collections_today))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OverviewQuery {
    /// The viewer's time zone, so "today" and "this month" are the clinic's own days.
    tz: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CollectionsQuery {
    tz: Option<String>,
    after: Option<String>,
}

async fn time_zone(tx: &mut Transaction<'_, Postgres>, requested: Option<&str>) -> Result<String> {
    let Some(zone) = requested
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 64)
    else {
        return Ok("UTC".into());
    };
    Ok(
        sqlx::query_scalar("SELECT name FROM pg_timezone_names WHERE name=$1")
            .bind(zone)
            .fetch_optional(&mut **tx)
            .await?
            .unwrap_or_else(|| "UTC".into()),
    )
}

async fn collections_today(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Query(q): Query<CollectionsQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    crate::access_policies::require_native(&s, &a, "billing", "view").await?;
    let (after_time, after_source, after_id) = match q.after.as_deref() {
        Some(cursor) => {
            let bad = Error::Invalid("invalid collections cursor");
            let mut parts = cursor.split('|');
            let time = parts.next().and_then(|p| p.parse::<DateTime<Utc>>().ok());
            let source = parts.next().filter(|p| matches!(*p, "copay" | "ledger"));
            let id = parts.next().and_then(|p| Uuid::parse_str(p).ok());
            let (Some(time), Some(source), Some(id), None) = (time, source, id, parts.next())
            else {
                return Err(bad);
            };
            (Some(time), Some(source), Some(id))
        }
        None => (None, None, None),
    };
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let mut tx = db.begin().await?;
    let tz = time_zone(&mut tx, q.tz.as_deref()).await?;
    const PAGE_SIZE: usize = 50;
    let mut out: Value = sqlx::query_scalar(&format!(
        "WITH today AS (SELECT (now() AT TIME ZONE $2)::date AS day),
         paid AS ({PAID}),
         daily AS (SELECT * FROM paid WHERE day=(SELECT day FROM today)),
         page AS (
           SELECT * FROM daily WHERE $3::timestamptz IS NULL OR (created_at,source,id)<($3,$4,$5)
           ORDER BY created_at DESC,source DESC,id DESC LIMIT $6
         ), details AS (
           SELECT page.*,p.id AS display_patient_id,p.family_name||', '||p.given_name AS patient_name,p.mrn,
                  plan.invoice_id
           FROM page
           LEFT JOIN billing_accounts b ON b.tenant_id=$1 AND b.id=page.account_id
           JOIN patients p ON p.tenant_id=$1 AND p.id=coalesce(page.patient_id,b.patient_id)
           LEFT JOIN invoice_checkout_attempts checkout ON checkout.tenant_id=$1 AND checkout.paid_entry_id=page.id
               AND checkout.account_id=page.account_id AND checkout.patient_id=p.id
           LEFT JOIN patient_installment_plans plan ON plan.tenant_id=$1 AND plan.id=checkout.plan_id
               AND plan.account_id=b.id AND plan.patient_id=p.id
         )
         SELECT jsonb_build_object(
           'day',(SELECT day FROM today),'time_zone',$2::text,
           'total_cents',(SELECT coalesce(sum(cents),0) FROM daily),
           'items',coalesce((SELECT jsonb_agg(jsonb_build_object(
             'id',id,'created_at',created_at,'source',source,'amount_cents',cents,'method',method,'party',party,
             'patient_id',display_patient_id,'patient_name',patient_name,'mrn',mrn,
             'account_id',account_id,'invoice_id',invoice_id
           ) ORDER BY created_at DESC,source DESC,id DESC) FROM details),'[]'::jsonb))"
    ))
    .bind(a.tenant_id)
    .bind(&tz)
    .bind(after_time)
    .bind(after_source)
    .bind(after_id)
    .bind(PAGE_SIZE as i64 + 1)
    .fetch_one(&mut *tx)
    .await?;
    let next = out["items"].as_array_mut().and_then(|items| {
        if items.len() <= PAGE_SIZE {
            return None;
        }
        items.truncate(PAGE_SIZE);
        let last = items.last()?;
        Some(format!(
            "{}|{}|{}",
            last["created_at"].as_str()?,
            last["source"].as_str()?,
            last["id"].as_str()?
        ))
    });
    out["next_cursor"] = json!(next);
    crate::postgres::audit(&mut tx, &a, "billing.collections_today_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(out))
}

async fn overview(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Query(q): Query<OverviewQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let billing = crate::access_policies::require_native(&s, &a, "billing", "view")
        .await
        .is_ok();
    let mut tx = db.begin().await?;
    let tz = time_zone(&mut tx, q.tz.as_deref()).await?;
    // Patients: active (not archived), insured (an active coverage) and gaps in what a claim or a
    // statement needs. Date of birth is required on every patient, so it is never a gap.
    let patients: Value = sqlx::query_scalar(&format!(
        "WITH live AS (
           SELECT p.id FROM patients p
           WHERE p.tenant_id=$1 AND NOT coalesce((SELECT e.archived FROM patient_lifecycle_events e
             WHERE e.tenant_id=p.tenant_id AND e.patient_id=p.id ORDER BY e.version DESC LIMIT 1),false)
         ), cov AS (
           SELECT l.id,
             bool_or(c.content->>'status'='active') AS insured,
             bool_or(c.content->>'status'='active' AND coalesce(btrim(c.content->>'member_id'),'')='') AS no_member
           FROM live l LEFT JOIN insurance_coverages c ON c.tenant_id=$1 AND c.patient_id=l.id GROUP BY l.id
         )
         SELECT jsonb_build_object(
           'active',count(*),
           'insured',count(*) FILTER (WHERE cov.insured),
           'self_pay',count(*) FILTER (WHERE NOT coalesce(cov.insured,false)),
           'missing_address',count(*) FILTER (WHERE {MISSING_ADDRESS}),
           'missing_phone',count(*) FILTER (WHERE {MISSING_PHONE}),
           'missing_member_id',count(*) FILTER (WHERE cov.no_member))
         FROM live l JOIN cov ON cov.id=l.id
         LEFT JOIN patient_demographics d ON d.tenant_id=$1 AND d.patient_id=l.id"
    ))
    .bind(a.tenant_id)
    .fetch_one(&mut *tx)
    .await?;
    let mut out = json!({"time_zone": tz, "patients": patients, "claims": null, "money": null, "trend": null});
    if billing {
        // Claims by status, with the billed amount behind each; "needs correcting" is Claim.MD's
        // warning or rejection on a claim it holds (claims::claim_md_positions).
        let claims: Value = sqlx::query_scalar(
            "SELECT coalesce(jsonb_object_agg(status,jsonb_build_object('count',n,'billed_cents',billed)),'{}'::jsonb)
             FROM (SELECT c.status,count(*) n,coalesce(sum(b.total_cents),0)::bigint billed
                   FROM ehr_claims c JOIN billing_accounts b ON b.tenant_id=c.tenant_id AND b.id=c.account_id
                   WHERE c.tenant_id=$1 GROUP BY c.status) x",
        )
        .bind(a.tenant_id)
        .fetch_one(&mut *tx)
        .await?;
        let held: Vec<uuid::Uuid> = sqlx::query_scalar(
            "SELECT id FROM ehr_claims WHERE tenant_id=$1 AND status IN ('submitted','accepted') ORDER BY created_at DESC LIMIT 500",
        )
        .bind(a.tenant_id)
        .fetch_all(&mut *tx)
        .await?;
        let positions = crate::claims::claim_md_positions(&mut tx, a.tenant_id, &held).await?;
        let needs_correction = positions
            .values()
            .filter(|p| p["needs_correction"] == true)
            .count();
        let received_only = positions
            .values()
            .filter(|p| p["acknowledged"] == true)
            .count();
        out["claims"] = json!({"by_status": claims, "needs_correction": needs_correction, "received_by_clearinghouse": received_only});
        // Money the practice recorded: patient payments on visit invoices (cards included, they
        // land in the ledger), cash or check copays, and paid online copay checkouts.
        out["money"] = sqlx::query_scalar(
            &format!("WITH paid AS ({PAID}
             ), today AS (SELECT (now() AT TIME ZONE $2)::date AS d)
             SELECT jsonb_build_object(
               'collected_today_cents',coalesce(sum(cents) FILTER (WHERE day=(SELECT d FROM today)),0),
               'collected_month_cents',coalesce(sum(cents) FILTER (WHERE day>=date_trunc('month',(SELECT d FROM today))::date),0),
               'charges_month_cents',(SELECT coalesce(sum(b.total_cents),0) FROM billing_accounts b WHERE b.tenant_id=$1 AND b.status='posted'
                  AND (b.content->>'service_date')::date>=date_trunc('month',(SELECT d FROM today))::date),
               'waiting_on_insurers_cents',(SELECT coalesce(sum(b.total_cents),0) FROM ehr_claims c JOIN billing_accounts b ON b.tenant_id=c.tenant_id AND b.id=c.account_id
                  WHERE c.tenant_id=$1 AND c.status IN ('submitted','accepted')),
               'payment_account_balance',NULL)
             FROM paid"),
        )
        .bind(a.tenant_id)
        .bind(&tz)
        .fetch_one(&mut *tx)
        .await?;
        // The last 30 days, one row a day: charges by service date and money recorded.
        out["trend"] = sqlx::query_scalar(
            &format!("WITH days AS (SELECT generate_series((now() AT TIME ZONE $2)::date-29,(now() AT TIME ZONE $2)::date,'1 day')::date AS day),
             charges AS (SELECT (b.content->>'service_date')::date AS day,sum(b.total_cents) cents FROM billing_accounts b
                         WHERE b.tenant_id=$1 AND b.status='posted' GROUP BY 1),
             received AS ({PAID}),
             paid AS (SELECT day,sum(cents) cents FROM received GROUP BY 1)
             SELECT jsonb_agg(jsonb_build_object('day',d.day,'charges_cents',coalesce(c.cents,0),'collected_cents',coalesce(p.cents,0)) ORDER BY d.day)
             FROM days d LEFT JOIN charges c ON c.day=d.day LEFT JOIN paid p ON p.day=d.day"),
        )
        .bind(a.tenant_id)
        .bind(&tz)
        .fetch_one(&mut *tx)
        .await?;
    }
    crate::postgres::audit(&mut tx, &a, "practice.overview.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(out))
}
