// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! UTC appointment intervals, provider blocks and explicit source reconciliation.
use crate::{
    auth::Actor,
    error::{Error, Result},
    model::{text, Appointment, NewAppointment},
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
pub async fn provider(db: &sqlx::PgPool, a: &Actor, id: Uuid) -> Result<()> {
    a.scheduling()?;
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM browser_users WHERE tenant_id=$1 AND id=$2 AND NOT disabled AND role IN ('owner','clinician'))").bind(a.tenant_id).bind(id).fetch_one(db).await?;
    if exists {
        Ok(())
    } else {
        Err(Error::Invalid(
            "choose an active clinician in this practice",
        ))
    }
}
fn interval(start: DateTime<Utc>, end: DateTime<Utc>) -> Result<()> {
    if end <= start || end - start > Duration::hours(24) {
        return Err(Error::Invalid(
            "appointment duration must be positive and at most 24 hours",
        ));
    }
    Ok(())
}
pub fn validate_booking(p: &NewAppointment) -> Result<()> {
    interval(p.starts_at, p.ends_at)?;
    text(&p.title, 200)?;
    text(&p.category, 100)?;
    text(&p.reason, 1000)?;
    for (v, n) in [(&p.facility, 200), (&p.room, 100), (&p.notes, 2000)] {
        if v.chars().count() > n || v.trim() != v {
            return Err(Error::Invalid(
                "appointment text is too long or has surrounding whitespace",
            ));
        }
    }
    if !p.room.is_empty() && p.facility.is_empty() {
        return Err(Error::Invalid("a room requires a facility"));
    }
    Ok(())
}
pub async fn tenant_lock(tx: &mut Transaction<'_, Postgres>, a: &Actor) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("schedule:{}", a.tenant_id))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
#[allow(clippy::too_many_arguments)]
pub async fn available(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    clinician: Uuid,
    patient: Uuid,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    facility: &str,
    room: &str,
    except: Option<Uuid>,
) -> Result<()> {
    let conflict:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM appointments WHERE tenant_id=$1 AND (clinician_id=$2 OR patient_id=$3 OR ($7<>'' AND facility=$6 AND room=$7)) AND status NOT IN ('cancelled','no_show') AND starts_at<$5 AND ends_at>$4 AND ($8::uuid IS NULL OR id<>$8)) OR EXISTS(SELECT 1 FROM schedule_blocks WHERE tenant_id=$1 AND clinician_id=$2 AND active AND starts_at<$5 AND ends_at>$4)")
 .bind(a.tenant_id).bind(clinician).bind(patient).bind(start).bind(end).bind(facility).bind(room).bind(except).fetch_one(&mut **tx).await?;
    if conflict {
        Err(Error::Conflict(
            "provider, patient or room is unavailable during that time",
        ))
    } else {
        Ok(())
    }
}
pub async fn source(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    patient: Uuid,
    id: Uuid,
) -> Result<()> {
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM historical_records WHERE tenant_id=$1 AND id=$2 AND patient_id=$3 AND kind='appointment')").bind(a.tenant_id).bind(id).bind(patient).fetch_one(&mut **tx).await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let used: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM appointments WHERE tenant_id=$1 AND source_history_id=$2)",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_one(&mut **tx)
    .await?;
    if used {
        Err(Error::Conflict(
            "source appointment already reconciled; open its native appointment",
        ))
    } else {
        Ok(())
    }
}
pub async fn revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    reason: &str,
) -> Result<()> {
    text(reason, 1000)?;
    sqlx::query("INSERT INTO appointment_revisions (tenant_id,appointment_id,version,snapshot,actor_id,reason) SELECT tenant_id,id,version,to_jsonb(a)-'tenant_id'-'request_digest'-'request_id',$3,$4 FROM appointments a WHERE tenant_id=$1 AND id=$2")
 .bind(a.tenant_id).bind(id).bind(a.sub).bind(reason).execute(&mut **tx).await?;
    Ok(())
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/schedule", get(schedule))
        .route("/api/v1/schedule/providers", get(providers))
        .route("/api/v1/schedule/blocks", post(block))
        .route("/api/v1/schedule/blocks/{id}/cancel", post(cancel_block))
        .route("/api/v1/appointments/{id}", get(detail).put(edit))
        .route("/api/v1/appointments/{id}/actions", post(action))
        .route("/api/v1/appointments/{id}/history", get(history))
        .route(
            "/api/v1/patients/{id}/history/{source}/appointment-mapping",
            get(mapping),
        )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Range {
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    clinician_id: Option<Uuid>,
}
async fn providers(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'label',email) FROM browser_users WHERE tenant_id=$1 AND NOT disabled AND role IN ('owner','clinician') ORDER BY email").bind(a.tenant_id).fetch_all(db(&s)?).await?;
    Ok(Json(json!({"items":items})))
}
async fn schedule(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<Range>,
) -> Result<Json<Value>> {
    a.staff()?;
    if q.end <= q.start || q.end - q.start > Duration::days(31) {
        return Err(Error::Invalid(
            "schedule range must be positive and at most 31 days",
        ));
    }
    let mut tx = db(&s)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT (to_jsonb(ap)-'tenant_id'-'request_digest'-'request_id') || jsonb_build_object('patient_name',p.family_name||', '||p.given_name,'mrn',p.mrn,'provider_label',coalesce(u.email,'Unmapped provider')) FROM appointments ap JOIN patients p ON p.tenant_id=ap.tenant_id AND p.id=ap.patient_id LEFT JOIN browser_users u ON u.tenant_id=ap.tenant_id AND u.id=ap.clinician_id WHERE ap.tenant_id=$1 AND ap.starts_at<$3 AND ap.ends_at>$2 AND ($4::uuid IS NULL OR ap.clinician_id=$4) ORDER BY ap.starts_at,ap.id LIMIT 1001").bind(a.tenant_id).bind(q.start).bind(q.end).bind(q.clinician_id).fetch_all(&mut *tx).await?;
    let blocks:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(b)-'tenant_id'-'request_digest'-'request_id' FROM schedule_blocks b WHERE tenant_id=$1 AND active AND starts_at<$3 AND ends_at>$2 AND ($4::uuid IS NULL OR clinician_id=$4) ORDER BY starts_at,id LIMIT 1001").bind(a.tenant_id).bind(q.start).bind(q.end).bind(q.clinician_id).fetch_all(&mut *tx).await?;
    if items.len() > 1000 || blocks.len() > 1000 {
        return Err(Error::Invalid(
            "too many schedule entries; narrow the date or provider filter",
        ));
    }
    crate::postgres::audit(&mut tx, &a, "schedule.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"appointments":items,"blocks":blocks})))
}
async fn row(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Appointment> {
    sqlx::query_as("SELECT * FROM appointments WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Appointment>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let r = row(&mut tx, &a, id).await?;
    crate::postgres::audit(&mut tx, &a, "appointment.read", id).await?;
    tx.commit().await?;
    Ok(Json(r))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Edit {
    clinician_id: Uuid,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    title: String,
    category: String,
    facility: String,
    room: String,
    notes: String,
    reason: String,
}
async fn edit(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(p): Json<Edit>,
) -> Result<Json<Appointment>> {
    provider(db(&s)?, &a, p.clinician_id).await?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let old = row(&mut tx, &a, id).await?;
    if old.version != version {
        return Err(Error::Conflict(
            "appointment changed; reload before editing",
        ));
    }
    if old.status != "booked" {
        return Err(Error::Conflict(
            "only booked appointments can be edited or rescheduled",
        ));
    }
    validate_booking(&NewAppointment {
        patient_id: old.patient_id,
        clinician_id: p.clinician_id,
        starts_at: p.starts_at,
        ends_at: p.ends_at,
        title: p.title.clone(),
        category: p.category.clone(),
        facility: p.facility.clone(),
        room: p.room.clone(),
        notes: p.notes.clone(),
        reason: p.reason.clone(),
        request_id: None,
        source_history_id: None,
    })?;
    available(
        &mut tx,
        &a,
        p.clinician_id,
        old.patient_id,
        p.starts_at,
        p.ends_at,
        &p.facility,
        &p.room,
        Some(id),
    )
    .await?;
    sqlx::query("UPDATE appointments SET clinician_id=$3,starts_at=$4,ends_at=$5,title=$6,category=$7,facility=$8,room=$9,notes=$10,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(p.clinician_id).bind(p.starts_at).bind(p.ends_at).bind(p.title).bind(p.category).bind(p.facility).bind(p.room).bind(p.notes).execute(&mut *tx).await?;
    revision(&mut tx, &a, id, &p.reason).await?;
    crate::postgres::audit(&mut tx, &a, "appointment.edit", id).await?;
    let r = row(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(Json(r))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    action: String,
    reason: String,
}
async fn action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(p): Json<Action>,
) -> Result<Json<Appointment>> {
    a.scheduling()?;
    text(&p.reason, 1000)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let old = row(&mut tx, &a, id).await?;
    if old.version != version {
        return Err(Error::Conflict(
            "appointment changed; reload before recording action",
        ));
    }
    let status = match (p.action.as_str(), old.status.as_str()) {
        ("cancel", "booked" | "checked_in") => "cancelled",
        ("no_show", "booked") if old.starts_at <= Utc::now() => "no_show",
        ("check_in", "booked") => "checked_in",
        _ => {
            return Err(Error::Conflict(
                "action is not allowed in the current appointment state",
            ))
        }
    };
    sqlx::query("UPDATE appointments SET status=$3,version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .bind(status)
        .execute(&mut *tx)
        .await?;
    revision(&mut tx, &a, id, &p.reason).await?;
    crate::postgres::audit(&mut tx, &a, "appointment.action", id).await?;
    let r = row(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(Json(r))
}
async fn history(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    row(&mut tx, &a, id).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('version',version,'snapshot',snapshot,'actor_id',actor_id,'reason',reason,'created_at',created_at) FROM appointment_revisions WHERE tenant_id=$1 AND appointment_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "appointment.history", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Block {
    request_id: Uuid,
    clinician_id: Uuid,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    label: String,
}
async fn block(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(p): Json<Block>,
) -> Result<Json<Value>> {
    provider(db(&s)?, &a, p.clinician_id).await?;
    interval(p.starts_at, p.ends_at)?;
    text(&p.label, 200)?;
    let digest = crate::oauth::hash(
        &serde_json::to_string(&p).map_err(|_| Error::Invalid("invalid block"))?,
    );
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let old: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,request_digest FROM schedule_blocks WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(p.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    let id = if let Some((id, old)) = old {
        if old != digest {
            return Err(Error::Conflict(
                "request ID reused for a different availability block",
            ));
        }
        id
    } else {
        let conflict:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM appointments WHERE tenant_id=$1 AND clinician_id=$2 AND status NOT IN ('cancelled','no_show') AND starts_at<$4 AND ends_at>$3) OR EXISTS(SELECT 1 FROM schedule_blocks WHERE tenant_id=$1 AND clinician_id=$2 AND active AND starts_at<$4 AND ends_at>$3)").bind(a.tenant_id).bind(p.clinician_id).bind(p.starts_at).bind(p.ends_at).fetch_one(&mut *tx).await?;
        if conflict {
            return Err(Error::Conflict(
                "block overlaps an appointment or another block",
            ));
        }
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO schedule_blocks (tenant_id,id,clinician_id,starts_at,ends_at,label,request_id,request_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)").bind(a.tenant_id).bind(id).bind(p.clinician_id).bind(p.starts_at).bind(p.ends_at).bind(p.label).bind(p.request_id).bind(digest).execute(&mut *tx).await?;
        crate::postgres::audit(&mut tx, &a, "schedule.block", id).await?;
        id
    };
    let v:Value=sqlx::query_scalar("SELECT to_jsonb(b)-'tenant_id'-'request_digest'-'request_id' FROM schedule_blocks b WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(v))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reason {
    reason: String,
}
async fn cancel_block(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(p): Json<Reason>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    text(&p.reason, 1000)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let changed=sqlx::query("UPDATE schedule_blocks SET active=false,version=version+1 WHERE tenant_id=$1 AND id=$2 AND active AND version=$3").bind(a.tenant_id).bind(id).bind(version).execute(&mut *tx).await?.rows_affected();
    if changed == 0 {
        return Err(Error::Conflict(
            "block changed or unavailable; reload schedule",
        ));
    }
    // A separate immutable event retains the operator's cancellation reason.
    sqlx::query("INSERT INTO schedule_block_cancellations (tenant_id,block_id,actor_id,reason) VALUES ($1,$2,$3,$4)").bind(a.tenant_id).bind(id).bind(a.sub).bind(p.reason).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "schedule.block_cancel", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"cancelled":true})))
}
async fn mapping(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((patient, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    let mut tx = db(&s)?.begin().await?;
    let source:Value=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'data',data,'source_data',source_data,'source_instance',source_instance,'source_id',source_id) FROM historical_records WHERE tenant_id=$1 AND id=$2 AND patient_id=$3 AND kind='appointment'").bind(a.tenant_id).bind(id).bind(patient).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let native: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM appointments WHERE tenant_id=$1 AND source_history_id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    crate::postgres::audit(&mut tx, &a, "appointment.mapping_read", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"source":source,"native_appointment_id":native,"policy":"Staff must verify patient, provider identity, occurrence, timezone and source status. Reconciliation creates a new booked appointment only; source status and recurrence are never executed automatically."}),
    ))
}
