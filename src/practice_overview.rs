// SPDX-License-Identifier: AGPL-3.0-only
//! The practice overview's numbers: claims by where they stand, money recorded, patients and the
//! gaps in their records, and a 30-day trend. Read only, derived from saved records; each money or
//! claim figure is returned only when the person may see billing.
use crate::{
    auth::Actor,
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Query, State as ExtractState},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn router() -> Router<State> {
    Router::new().route("/api/v1/practice/overview", get(overview))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OverviewQuery {
    /// The viewer's time zone, so "today" and "this month" are the clinic's own days.
    tz: Option<String>,
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
    let tz: String = match q
        .tz
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 64)
    {
        Some(zone) => sqlx::query_scalar("SELECT name FROM pg_timezone_names WHERE name=$1")
            .bind(zone)
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or_else(|| "UTC".into()),
        None => "UTC".into(),
    };
    // Patients: active (not archived), insured (an active coverage) and gaps in what a claim or a
    // statement needs. Date of birth is required on every patient, so it is never a gap.
    let patients: Value = sqlx::query_scalar(
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
           'missing_address',count(*) FILTER (WHERE coalesce(btrim(d.content->'address'->>'line1'),'')=''),
           'missing_phone',count(*) FILTER (WHERE coalesce(btrim(d.content->>'phone'),'')=''),
           'missing_member_id',count(*) FILTER (WHERE cov.no_member))
         FROM live l JOIN cov ON cov.id=l.id
         LEFT JOIN patient_demographics d ON d.tenant_id=$1 AND d.patient_id=l.id",
    )
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
            "WITH paid AS (
               SELECT (e.created_at AT TIME ZONE $2)::date AS day, abs(e.effect_cents) AS cents
                 FROM billing_entries e WHERE e.tenant_id=$1 AND e.kind='payment'
               UNION ALL
               SELECT r.occurred_on, r.amount_cents FROM billing_copay_receipts r WHERE r.tenant_id=$1
               UNION ALL
               SELECT (k.updated_at AT TIME ZONE $2)::date, k.amount_cents-k.refunded_cents
                 FROM copay_checkout_attempts k WHERE k.tenant_id=$1 AND k.status='paid'
             ), today AS (SELECT (now() AT TIME ZONE $2)::date AS d)
             SELECT jsonb_build_object(
               'collected_today_cents',coalesce(sum(cents) FILTER (WHERE day=(SELECT d FROM today)),0),
               'collected_month_cents',coalesce(sum(cents) FILTER (WHERE day>=date_trunc('month',(SELECT d FROM today))::date),0),
               'charges_month_cents',(SELECT coalesce(sum(b.total_cents),0) FROM billing_accounts b WHERE b.tenant_id=$1 AND b.status='posted'
                  AND (b.content->>'service_date')::date>=date_trunc('month',(SELECT d FROM today))::date),
               'waiting_on_insurers_cents',(SELECT coalesce(sum(b.total_cents),0) FROM ehr_claims c JOIN billing_accounts b ON b.tenant_id=c.tenant_id AND b.id=c.account_id
                  WHERE c.tenant_id=$1 AND c.status IN ('submitted','accepted')),
               'payment_account_balance',NULL)
             FROM paid",
        )
        .bind(a.tenant_id)
        .bind(&tz)
        .fetch_one(&mut *tx)
        .await?;
        // The last 30 days, one row a day: charges by service date and money recorded.
        out["trend"] = sqlx::query_scalar(
            "WITH days AS (SELECT generate_series((now() AT TIME ZONE $2)::date-29,(now() AT TIME ZONE $2)::date,'1 day')::date AS day),
             charges AS (SELECT (b.content->>'service_date')::date AS day,sum(b.total_cents) cents FROM billing_accounts b
                         WHERE b.tenant_id=$1 AND b.status='posted' GROUP BY 1),
             paid AS (SELECT (e.created_at AT TIME ZONE $2)::date AS day,sum(abs(e.effect_cents)) cents FROM billing_entries e
                      WHERE e.tenant_id=$1 AND e.kind='payment' GROUP BY 1)
             SELECT jsonb_agg(jsonb_build_object('day',d.day,'charges_cents',coalesce(c.cents,0),'collected_cents',coalesce(p.cents,0)) ORDER BY d.day)
             FROM days d LEFT JOIN charges c ON c.day=d.day LEFT JOIN paid p ON p.day=d.day",
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
