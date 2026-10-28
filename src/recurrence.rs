// SPDX-License-Identifier: AGPL-3.0-only
//! Bounded, timezone-validated appointment plans; every occurrence is an ordinary appointment.
use crate::{
    auth::Actor,
    error::{Error, Result},
    model::NewAppointment,
    scheduling, State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Duration, Months, NaiveDateTime, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
type Tx<'a> = Transaction<'a, Postgres>;
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Occurrence {
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    local_start: NaiveDateTime,
    local_end: NaiveDateTime,
    utc_offset_minutes: i32,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SeriesPlan {
    request_id: Uuid,
    patient_id: Uuid,
    clinician_id: Uuid,
    title: String,
    category: String,
    facility: String,
    room: String,
    notes: String,
    reason: String,
    frequency: String,
    interval: u32,
    timezone: String,
    occurrences: Vec<Occurrence>,
}
impl SeriesPlan {
    fn booking(&self, o: &Occurrence) -> NewAppointment {
        NewAppointment {
            request_id: None,
            source_history_id: None,
            patient_id: self.patient_id,
            clinician_id: self.clinician_id,
            starts_at: o.starts_at,
            ends_at: o.ends_at,
            title: self.title.clone(),
            category: self.category.clone(),
            facility: self.facility.clone(),
            room: self.room.clone(),
            notes: self.notes.clone(),
            reason: self.reason.clone(),
        }
    }
    fn validate(&self) -> Result<()> {
        if !(2..=52).contains(&self.occurrences.len())
            || !(1..=12).contains(&self.interval)
            || !["daily", "weekly", "monthly"].contains(&self.frequency.as_str())
        {
            return Err(Error::Invalid(
                "choose 2 to 52 daily, weekly or monthly occurrences and an interval from 1 to 12",
            ));
        }
        if self.timezone.len() > 100
            || self.timezone.trim() != self.timezone
            || (!self.timezone.contains('/') && self.timezone != "UTC")
            || self.timezone.chars().any(char::is_control)
        {
            return Err(Error::Invalid("choose a supported IANA timezone or UTC"));
        }
        for value in [
            &self.title,
            &self.category,
            &self.facility,
            &self.room,
            &self.reason,
        ] {
            if value.chars().any(char::is_control) {
                return Err(Error::Invalid(
                    "appointment metadata contains control characters",
                ));
            }
        }
        let first = &self.occurrences[0];
        let final_date = first
            .local_start
            .date()
            .checked_add_months(Months::new(12))
            .ok_or(Error::Invalid("unsupported recurrence date"))?;
        for (index, o) in self.occurrences.iter().enumerate() {
            scheduling::validate_booking(&self.booking(o))?;
            if [
                o.starts_at.time(),
                o.ends_at.time(),
                o.local_start.time(),
                o.local_end.time(),
            ]
            .iter()
            .any(|t| t.second() != 0 || t.nanosecond() != 0)
            {
                return Err(Error::Invalid(
                    "recurring appointments use whole-minute times",
                ));
            }
            let steps = self.interval * index as u32;
            let expected = match self.frequency.as_str() {
                "daily" => first
                    .local_start
                    .date()
                    .checked_add_signed(Duration::days(steps.into())),
                "weekly" => first
                    .local_start
                    .date()
                    .checked_add_signed(Duration::weeks(steps.into())),
                _ => first
                    .local_start
                    .date()
                    .checked_add_months(Months::new(steps)),
            }
            .ok_or(Error::Invalid("unsupported recurrence date"))?;
            if o.local_start.date() != expected
                || o.local_start.time() != first.local_start.time()
                || o.local_start.date() > final_date
                || o.ends_at - o.starts_at != first.ends_at - first.starts_at
                || !(-840..=840).contains(&o.utc_offset_minutes)
            {
                return Err(Error::Invalid("occurrences must follow the selected local cadence, fixed elapsed duration and one-year bound"));
            }
            if index > 0 && o.starts_at <= self.occurrences[index - 1].starts_at {
                return Err(Error::Invalid(
                    "occurrences must be ordered by increasing start time",
                ));
            }
        }
        Ok(())
    }
    fn digest(&self) -> Result<String> {
        Ok(crate::oauth::hash(&serde_json::to_string(self).map_err(
            |_| Error::Invalid("invalid recurring appointment plan"),
        )?))
    }
}
async fn authorize_plan(tx: &mut Tx<'_>, a: &Actor, plan: &SeriesPlan) -> Result<()> {
    let p: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM patients WHERE tenant_id=$1 AND id=$2 FOR KEY SHARE")
            .bind(a.tenant_id)
            .bind(plan.patient_id)
            .fetch_optional(&mut **tx)
            .await?;
    p.ok_or(Error::NotFound)?;
    scheduling::provider_locked(tx, a, plan.clinician_id, false).await?;
    let zone: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1)")
            .bind(&plan.timezone)
            .fetch_one(&mut **tx)
            .await?;
    if !zone {
        return Err(Error::Invalid(
            "timezone is not available in the server timezone database",
        ));
    }
    for o in &plan.occurrences {
        let consistent:bool=sqlx::query_scalar("SELECT ($1::timestamptz AT TIME ZONE $5)=$3::timestamp AND ($2::timestamptz AT TIME ZONE $5)=$4::timestamp AND (extract(epoch FROM (($1::timestamptz AT TIME ZONE $5)-($1::timestamptz AT TIME ZONE 'UTC')))/60)::integer=$6").bind(o.starts_at).bind(o.ends_at).bind(o.local_start).bind(o.local_end).bind(&plan.timezone).bind(o.utc_offset_minutes).fetch_one(&mut **tx).await?;
        if !consistent {
            return Err(Error::Invalid(
                "UTC times, local times or offset disagree with the selected timezone",
            ));
        }
    }
    Ok(())
}
async fn existing(
    tx: &mut Tx<'_>,
    a: &Actor,
    p: &SeriesPlan,
    digest: &str,
) -> Result<Option<Uuid>> {
    let prior: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,request_digest FROM appointment_series WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(p.request_id)
    .fetch_optional(&mut **tx)
    .await?;
    match prior {
        Some((id, old)) if old == digest => Ok(Some(id)),
        Some(_) => Err(Error::Conflict(
            "series request ID reused with different content",
        )),
        None => Ok(None),
    }
}
async fn preview_rows(tx: &mut Tx<'_>, a: &Actor, p: &SeriesPlan) -> Result<Vec<Value>> {
    let mut rows = Vec::with_capacity(p.occurrences.len());
    for (index, o) in p.occurrences.iter().enumerate() {
        let overlaps =
            p.occurrences.iter().enumerate().any(|(other, x)| {
                other != index && o.starts_at < x.ends_at && o.ends_at > x.starts_at
            });
        let conflict = if overlaps {
            Some("overlaps another proposed occurrence".to_string())
        } else {
            match scheduling::available(
                tx,
                a,
                p.clinician_id,
                p.patient_id,
                o.starts_at,
                o.ends_at,
                &p.facility,
                &p.room,
                None,
            )
            .await
            {
                Ok(()) => None,
                Err(Error::Conflict(message)) => Some(message.to_string()),
                Err(error) => return Err(error),
            }
        };
        rows.push(json!({"position":index+1,"starts_at":o.starts_at,"ends_at":o.ends_at,"local_start":o.local_start,"local_end":o.local_end,"utc_offset_minutes":o.utc_offset_minutes,"available":conflict.is_none(),"conflict":conflict}));
    }
    Ok(rows)
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/schedule/series", get(list).post(create))
        .route("/api/v1/schedule/series/preview", post(preview))
        .route("/api/v1/schedule/series/{id}", get(detail))
        .route("/api/v1/schedule/series/{id}/actions", post(cancel))
        .route("/api/v1/appointments/{id}/series", get(membership))
}
async fn preview(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Json(plan): Json<SeriesPlan>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    plan.validate()?;
    let digest = plan.digest()?;
    let mut tx = db(&s)?.begin().await?;
    scheduling::tenant_lock(&mut tx, &a).await?;
    let prior = existing(&mut tx, &a, &plan, &digest).await?;
    let rows = if prior.is_some() {
        Vec::new()
    } else {
        authorize_plan(&mut tx, &a, &plan).await?;
        preview_rows(&mut tx, &a, &plan).await?
    };
    let ready = rows.iter().all(|o| o["available"] == true);
    crate::postgres::audit(&mut tx, &a, "schedule.series_preview", plan.patient_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"ready_to_create":ready,"existing_series_id":prior,"occurrences":rows,"timezone":plan.timezone,"frequency":plan.frequency,"interval":plan.interval,"count":plan.occurrences.len(),"preview_only":true}),
    ))
}
async fn series_detail(tx: &mut Tx<'_>, a: &Actor, id: Uuid) -> Result<Value> {
    let mut series:Value=sqlx::query_scalar("SELECT (to_jsonb(s)-'tenant_id'-'request_id'-'request_digest'-'plan'-'repeat_interval')||jsonb_build_object('interval',s.repeat_interval,'title',s.plan->'title','category',s.plan->'category','facility',s.plan->'facility','room',s.plan->'room','notes',s.plan->'notes','patient_name',p.family_name||', '||p.given_name,'mrn',p.mrn,'provider_label',u.email) FROM appointment_series s JOIN patients p ON p.tenant_id=s.tenant_id AND p.id=s.patient_id JOIN browser_users u ON u.tenant_id=s.tenant_id AND u.id=s.clinician_id WHERE s.tenant_id=$1 AND s.id=$2").bind(a.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
    let occurrences:Vec<Value>=sqlx::query_scalar("SELECT (to_jsonb(ap)-'tenant_id'-'request_id'-'request_digest'-'source_history_id')||jsonb_build_object('position',o.position,'appointment_id',ap.id,'planned',o.planned,'changed_from_plan',ap.starts_at IS DISTINCT FROM (o.planned->>'starts_at')::timestamptz OR ap.ends_at IS DISTINCT FROM (o.planned->>'ends_at')::timestamptz OR ap.clinician_id<>s.clinician_id OR ap.title IS DISTINCT FROM (s.plan->>'title') OR ap.category IS DISTINCT FROM (s.plan->>'category') OR ap.facility IS DISTINCT FROM (s.plan->>'facility') OR ap.room IS DISTINCT FROM (s.plan->>'room') OR ap.notes IS DISTINCT FROM (s.plan->>'notes')) FROM appointment_series_occurrences o JOIN appointments ap ON ap.tenant_id=o.tenant_id AND ap.id=o.appointment_id JOIN appointment_series s ON s.tenant_id=o.tenant_id AND s.id=o.series_id WHERE o.tenant_id=$1 AND o.series_id=$2 ORDER BY o.position").bind(a.tenant_id).bind(id).fetch_all(&mut **tx).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id'-'series_id' FROM appointment_series_events e WHERE tenant_id=$1 AND series_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut **tx).await?;
    series["cancellable_count"] = json!(occurrences
        .iter()
        .filter(|o| o["status"] == "booked"
            && o["starts_at"]
                .as_str()
                .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
                .is_some_and(|v| v > Utc::now()))
        .count());
    series["occurrences"] = json!(occurrences);
    series["events"] = json!(events);
    Ok(series)
}
async fn create(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Json(plan): Json<SeriesPlan>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    plan.validate()?;
    let digest = plan.digest()?;
    let mut tx = db(&s)?.begin().await?;
    scheduling::tenant_lock(&mut tx, &a).await?;
    if let Some(id) = existing(&mut tx, &a, &plan, &digest).await? {
        let data = series_detail(&mut tx, &a, id).await?;
        crate::postgres::audit(&mut tx, &a, "schedule.series_retry_read", id).await?;
        tx.commit().await?;
        return Ok(Json(data));
    }
    authorize_plan(&mut tx, &a, &plan).await?;
    let rows = preview_rows(&mut tx, &a, &plan).await?;
    if rows.iter().any(|o| o["available"] != true) {
        return Err(Error::Conflict(
            "recurring appointment plan has conflicts; preview and resolve before booking",
        ));
    }
    let id = Uuid::new_v4();
    let json_plan = serde_json::to_value(&plan)
        .map_err(|_| Error::Invalid("invalid recurring appointment plan"))?;
    sqlx::query("INSERT INTO appointment_series(tenant_id,id,patient_id,clinician_id,request_id,request_digest,frequency,repeat_interval,timezone,plan,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(a.tenant_id).bind(id).bind(plan.patient_id).bind(plan.clinician_id).bind(plan.request_id).bind(digest).bind(&plan.frequency).bind(plan.interval as i32).bind(&plan.timezone).bind(json_plan).bind(a.sub).execute(&mut *tx).await?;
    for (index, o) in plan.occurrences.iter().enumerate() {
        let appointment = Uuid::new_v4();
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,title,category,facility,room,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(a.tenant_id).bind(appointment).bind(plan.patient_id).bind(plan.clinician_id).bind(o.starts_at).bind(o.ends_at).bind(&plan.title).bind(&plan.category).bind(&plan.facility).bind(&plan.room).bind(&plan.notes).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO appointment_series_occurrences(tenant_id,series_id,position,appointment_id,planned) VALUES($1,$2,$3,$4,$5)").bind(a.tenant_id).bind(id).bind((index+1)as i32).bind(appointment).bind(serde_json::to_value(o).map_err(|_|Error::Invalid("invalid occurrence metadata"))?).execute(&mut *tx).await?;
        scheduling::revision(&mut tx, &a, appointment, &plan.reason).await?;
        crate::postgres::audit(&mut tx, &a, "appointment.book", appointment).await?;
    }
    sqlx::query("INSERT INTO appointment_series_events(tenant_id,series_id,version,action,actor_id,reason,details) VALUES($1,$2,1,'create',$3,$4,$5)").bind(a.tenant_id).bind(id).bind(a.sub).bind(&plan.reason).bind(json!({"count":plan.occurrences.len()})).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "schedule.series_create", id).await?;
    let data = series_detail(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(Json(data))
}
async fn detail(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    scheduling::tenant_lock(&mut tx, &a).await?;
    let data = series_detail(&mut tx, &a, id).await?;
    crate::postgres::audit(&mut tx, &a, "schedule.series_read", id).await?;
    tx.commit().await?;
    Ok(Json(data))
}
async fn membership(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    scheduling::tenant_lock(&mut tx, &a).await?;
    let found: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM appointments WHERE tenant_id=$1 AND id=$2)",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if !found {
        return Err(Error::NotFound);
    }
    let series:Option<Uuid>=sqlx::query_scalar("SELECT series_id FROM appointment_series_occurrences WHERE tenant_id=$1 AND appointment_id=$2").bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
    let data = if let Some(series) = series {
        Some(series_detail(&mut tx, &a, series).await?)
    } else {
        None
    };
    crate::postgres::audit(&mut tx, &a, "schedule.series_membership_read", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"series":data})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    patient_id: Option<Uuid>,
}
async fn list(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',s.id,'patient_id',s.patient_id,'patient_name',p.family_name||', '||p.given_name,'mrn',p.mrn,'clinician_id',s.clinician_id,'title',s.plan->'title','frequency',s.frequency,'interval',s.repeat_interval,'timezone',s.timezone,'status',s.status,'version',s.version,'created_at',s.created_at,'occurrence_count',jsonb_array_length(s.plan->'occurrences')) FROM appointment_series s JOIN patients p ON p.tenant_id=s.tenant_id AND p.id=s.patient_id WHERE s.tenant_id=$1 AND ($2::uuid IS NULL OR s.patient_id=$2) ORDER BY s.created_at DESC,s.id LIMIT 101").bind(a.tenant_id).bind(q.patient_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "schedule.series_list", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":items.iter().take(100).collect::<Vec<_>>(),"has_more":items.len()>100}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OccurrenceVersion {
    appointment_id: Uuid,
    version: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelSeries {
    action: String,
    reason: String,
    occurrence_versions: Vec<OccurrenceVersion>,
}
async fn cancel(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<CancelSeries>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    crate::model::text(&input.reason, 1000)?;
    if input.action != "cancel_upcoming" || input.reason.chars().any(char::is_control) {
        return Err(Error::Invalid("choose cancel_upcoming with a valid reason"));
    }
    let expected = crate::expected(&headers)?;
    let mut tx = db(&s)?.begin().await?;
    scheduling::tenant_lock(&mut tx, &a).await?;
    let series: Value = sqlx::query_scalar(
        "SELECT to_jsonb(s) FROM appointment_series s WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    if series["version"] != expected || series["status"] != "active" {
        return Err(Error::Conflict(
            "series changed or its future cancellation was already recorded",
        ));
    }
    let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(ap) FROM appointment_series_occurrences o JOIN appointments ap ON ap.tenant_id=o.tenant_id AND ap.id=o.appointment_id WHERE o.tenant_id=$1 AND o.series_id=$2 ORDER BY o.position FOR UPDATE OF ap").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    if rows.len() != input.occurrence_versions.len()
        || rows
            .iter()
            .zip(&input.occurrence_versions)
            .any(|(row, version)| {
                row["id"] != json!(version.appointment_id) || row["version"] != version.version
            })
    {
        return Err(Error::Conflict(
            "an occurrence changed; reload the full series before cancellation",
        ));
    }
    let now = Utc::now();
    let mut cancelled = Vec::new();
    let mut preserved = Vec::new();
    for row in rows {
        let appointment: Uuid = serde_json::from_value(row["id"].clone())
            .map_err(|_| Error::Conflict("invalid series occurrence"))?;
        let upcoming = row["starts_at"]
            .as_str()
            .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
            .is_some_and(|start| start > now);
        if row["status"] == "booked" && upcoming {
            sqlx::query("UPDATE appointments SET status='cancelled',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(appointment).execute(&mut *tx).await?;
            scheduling::revision(&mut tx, &a, appointment, &input.reason).await?;
            crate::postgres::audit(&mut tx, &a, "appointment.action", appointment).await?;
            cancelled.push(appointment);
        } else {
            preserved.push(json!({"appointment_id":appointment,"status":row["status"],"starts_at":row["starts_at"]}));
        }
    }
    if cancelled.is_empty() {
        return Err(Error::Conflict(
            "there are no upcoming booked occurrences to cancel",
        ));
    }
    sqlx::query("UPDATE appointment_series SET status='cancelled',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO appointment_series_events(tenant_id,series_id,version,action,actor_id,reason,details) VALUES($1,$2,$3,'cancel_upcoming',$4,$5,$6)").bind(a.tenant_id).bind(id).bind(expected+1).bind(a.sub).bind(&input.reason).bind(json!({"cancelled":cancelled,"preserved":preserved})).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "schedule.series_cancel", id).await?;
    let data = series_detail(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(Json(data))
}
