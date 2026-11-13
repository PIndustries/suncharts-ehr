// SPDX-License-Identifier: AGPL-3.0-only
//! Read-only facts for the patient banner that the chart does not load when it opens:
//! the next and last visit, what the patient owes, the latest eligibility answer for each
//! coverage and a few status flags. Nothing here is stored; every value is read from the
//! records that own it, in one snapshot.
use crate::{
    auth::Actor,
    error::{Error, Result},
    postgres::audit,
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::header,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub fn routes() -> Router<State> {
    Router::new().route("/api/v1/patients/{id}/banner", get(read))
}
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
async fn allowed(s: &State, a: &Actor, resource: &str) -> Result<bool> {
    match crate::access_policies::require_native(s, a, resource, "view").await {
        Ok(()) => Ok(true),
        Err(Error::Forbidden) => Ok(false),
        Err(e) => Err(e),
    }
}
/// The appointment the banner calls "next": one already under way (checked in or in
/// progress within the last day), otherwise the earliest booked one that has not ended.
const NEXT_APPOINTMENT: &str = "SELECT jsonb_build_object('id',a.id,'starts_at',a.starts_at,'ends_at',a.ends_at,'status',a.status,'title',a.title,'category',a.category) FROM appointments a WHERE a.tenant_id=$1 AND a.patient_id=$2 AND ((a.status IN ('checked_in','in_progress') AND a.starts_at>=now()-interval '1 day') OR (a.status='booked' AND a.ends_at>=now())) ORDER BY (a.status='booked'),a.starts_at,a.id LIMIT 1";
/// The most recent visit that is finished: its note is signed or its appointment completed.
const LAST_VISIT: &str = "SELECT jsonb_build_object('appointment_id',a.id,'starts_at',a.starts_at,'title',a.title) FROM appointments a WHERE a.tenant_id=$1 AND a.patient_id=$2 AND a.starts_at<=now() AND (a.status='completed' OR EXISTS(SELECT 1 FROM visits v WHERE v.tenant_id=a.tenant_id AND v.appointment_id=a.id AND v.status='signed')) ORDER BY a.starts_at DESC,a.id LIMIT 1";
const FLAGS: &str = "SELECT jsonb_build_object(
 'archived',coalesce((SELECT e.archived FROM patient_lifecycle_events e WHERE e.tenant_id=p.tenant_id AND e.patient_id=p.id ORDER BY e.version DESC LIMIT 1),false),
 'intake_to_review',(SELECT count(*) FROM previsit_intake_packets k WHERE k.tenant_id=p.tenant_id AND k.patient_id=p.id AND k.status='submitted'),
 'intake_sent',(SELECT count(*) FROM previsit_intake_packets k WHERE k.tenant_id=p.tenant_id AND k.patient_id=p.id AND k.status IN ('sent','in_progress') AND (k.expires_at IS NULL OR k.expires_at>now())),
 'portal_status',(SELECT c.status FROM patient_portal_accounts c WHERE c.tenant_id=p.tenant_id AND c.patient_id=p.id),
 'unsigned_notes',(SELECT count(*) FROM visits v WHERE v.tenant_id=p.tenant_id AND v.patient_id=p.id AND v.status='in_progress'))
 FROM patients p WHERE p.tenant_id=$1 AND p.id=$2";
/// Changes whenever a record the open chart drew from is saved again, so a chart left open
/// can say that it is out of date. It carries no record content.
const REVISION: &str = "SELECT md5(concat_ws('|',
 (SELECT coalesce(sum(version),0)::text||':'||count(*) FROM clinical_entries WHERE tenant_id=$1 AND patient_id=$2),
 (SELECT coalesce(sum(version),0)::text FROM clinical_list_state WHERE tenant_id=$1 AND patient_id=$2),
 (SELECT coalesce(sum(version),0)::text||':'||count(*) FROM insurance_coverages WHERE tenant_id=$1 AND patient_id=$2),
 (SELECT coalesce(max(version),0)::text FROM patient_demographics WHERE tenant_id=$1 AND patient_id=$2),
 (SELECT coalesce(sum(version),0)::text||':'||count(*) FROM visits WHERE tenant_id=$1 AND patient_id=$2),
 (SELECT coalesce(sum(version),0)::text||':'||count(*) FROM appointments WHERE tenant_id=$1 AND patient_id=$2)))";

async fn scalar(
    tx: &mut Transaction<'_, Postgres>,
    sql: &str,
    a: &Actor,
    id: Uuid,
) -> Result<Option<Value>> {
    Ok(sqlx::query_scalar(sql)
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?)
}
async fn payload(s: &State, a: &Actor, id: Uuid) -> Result<Value> {
    a.staff()?;
    let billing = allowed(s, a, "billing").await?;
    let claims = billing && allowed(s, a, "claims").await?;
    let mut tx = db(s)?.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    // Tenant and patient are checked first; an unknown or foreign patient is simply not found.
    let flags = scalar(&mut tx, FLAGS, a, id)
        .await?
        .ok_or(Error::NotFound)?;
    let mut out = json!({
        "patient_id": id,
        "flags": flags,
        "next_appointment": scalar(&mut tx, NEXT_APPOINTMENT, a, id).await?,
        "last_visit": scalar(&mut tx, LAST_VISIT, a, id).await?,
    });
    let revision: String = sqlx::query_scalar(REVISION)
        .bind(a.tenant_id)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    out["revision"] = json!(revision);
    // Money and insurance answers go only to people who may open Billing. They are left out,
    // not zeroed, so the banner cannot mistake "not allowed" for "nothing owed".
    if billing {
        let summary = crate::billing::patient_account_summary(&mut tx, a.tenant_id, id).await?;
        let card: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patient_payment_setups u JOIN payment_settings g ON g.tenant_id=u.tenant_id AND g.id=u.setting_id WHERE u.tenant_id=$1 AND u.patient_id=$2 AND u.status='succeeded' AND (g.provider_account_id IS NULL OR u.provider_account_id=g.provider_account_id))")
            .bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
        out["billing"] = json!({
            "patient_due_cents": summary["reviewed_patient_due_cents"],
            "open_invoice_count": summary["open_invoice_count"],
            "invoice_review_count": summary["invoice_review_count"],
            "card_on_file": card,
        });
    }
    if claims {
        out["eligibility"] =
            json!(crate::claimmd_eligibility::latest_checks(&mut tx, a.tenant_id, id).await?);
    }
    audit(&mut tx, a, "patient.banner_read", id).await?;
    tx.commit().await?;
    Ok(out)
}
async fn read(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(payload(&s, &a, id).await?),
    )
        .into_response())
}
