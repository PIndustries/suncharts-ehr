// SPDX-License-Identifier: AGPL-3.0-only
//! Instance-local scheduling API for tenant-authorized partner applications.
use crate::{
    auth::Actor,
    error::{Error, Result},
    model::text,
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use std::net::IpAddr;
use uuid::Uuid;

fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn clean(v: &str, n: usize) -> Result<String> {
    let v = v.trim();
    if v.is_empty() || v.chars().count() > n || v.chars().any(char::is_control) {
        Err(Error::Invalid(
            "required text is missing or exceeds its limit",
        ))
    } else {
        Ok(v.to_owned())
    }
}
fn digest<T: Serialize>(v: &T) -> Result<String> {
    Ok(crate::oauth::hash(&serde_json::to_string(v).map_err(
        |_| Error::Invalid("invalid scheduling request"),
    )?))
}
fn version(h: &HeaderMap) -> Result<i64> {
    h.get(header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix('"'))
        .and_then(|v| v.strip_suffix('"'))
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0)
        .ok_or(Error::VersionRequired)
}

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/scheduling/locations", get(locations))
        .route("/api/v1/scheduling/providers", get(providers))
        .route("/api/v1/scheduling/services", get(services))
        .route("/api/v1/scheduling/availability", get(availability))
        .route("/api/v1/scheduling/holds", post(create_hold))
        .route(
            "/api/v1/scheduling/holds/{id}",
            axum::routing::delete(release_hold),
        )
        .route("/api/v1/scheduling/appointments", post(create_appointment))
        .route(
            "/api/v1/scheduling/appointments/by-external-reference",
            get(appointment_by_external_reference),
        )
        .route("/api/v1/scheduling/appointments/{id}", get(appointment))
        .route(
            "/api/v1/scheduling/appointments/{id}/reschedule",
            post(reschedule),
        )
        .route("/api/v1/scheduling/appointments/{id}/cancel", post(cancel))
        .route(
            "/api/v1/scheduling/webhooks",
            get(webhooks).post(create_webhook),
        )
        .route(
            "/api/v1/scheduling/webhooks/{id}/disable",
            post(disable_webhook),
        )
}

async fn locations(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.scheduling()?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',f.id,'name',f.name,'address',f.address,'phone',f.phone,'rooms',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name) ORDER BY lower(r.name),r.id),'[]'::jsonb) FROM practice_rooms r WHERE r.tenant_id=f.tenant_id AND r.facility_id=f.id AND r.active)) FROM practice_facilities f WHERE f.tenant_id=$1 AND f.active ORDER BY lower(f.name),f.id LIMIT 1001").bind(a.tenant_id).fetch_all(db(&s)?).await?;
    Ok(Json(json!({"items":items})))
}
async fn providers(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.scheduling()?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',u.id,'name',coalesce(nullif(p.display_name,''),nullif(u.display_name,''),u.email),'specialty',coalesce(p.specialty,'')) FROM browser_users u LEFT JOIN practice_providers p ON p.tenant_id=u.tenant_id AND p.id=u.id WHERE u.tenant_id=$1 AND NOT u.disabled AND u.role IN('owner','clinician') AND coalesce(p.active,true) ORDER BY 1 LIMIT 1001").bind(a.tenant_id).fetch_all(db(&s)?).await?;
    Ok(Json(json!({"items":items})))
}
async fn services(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.scheduling()?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',x.id,'name',x.name,'provider_id',x.clinician_id,'provider_name',coalesce(nullif(p.display_name,''),nullif(u.display_name,''),u.email),'duration_minutes',x.duration_minutes,'category',x.category,'facility',x.facility,'room',x.room,'version',x.version) FROM scheduling_services x JOIN browser_users u ON u.tenant_id=x.tenant_id AND u.id=x.clinician_id LEFT JOIN practice_providers p ON p.tenant_id=u.tenant_id AND p.id=u.id WHERE x.tenant_id=$1 AND x.enabled AND NOT u.disabled AND coalesce(p.active,true) ORDER BY lower(x.name),x.id LIMIT 1001").bind(a.tenant_id).fetch_all(db(&s)?).await?;
    Ok(Json(json!({"items":items})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AvailabilityQuery {
    service_id: Uuid,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
}
#[derive(sqlx::FromRow)]
struct Service {
    id: Uuid,
    clinician_id: Uuid,
    duration_minutes: i32,
    name: String,
    category: String,
    facility: String,
    room: String,
}
async fn service(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Service> {
    sqlx::query_as("SELECT id,clinician_id,duration_minutes,name,category,facility,room FROM scheduling_services WHERE tenant_id=$1 AND id=$2 AND enabled FOR SHARE").bind(a.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn availability(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<AvailabilityQuery>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    if q.end <= q.start || q.end - q.start > Duration::days(31) {
        return Err(Error::Invalid(
            "availability range must be positive and at most 31 days",
        ));
    }
    let mut tx = db(&s)?.begin().await?;
    let service = service(&mut tx, &a, q.service_id).await?;
    let slots:Vec<DateTime<Utc>>=sqlx::query_scalar("SELECT slot FROM previsit_booking_profiles b CROSS JOIN LATERAL generate_series(date_trunc('day',$2::timestamptz AT TIME ZONE b.booking_timezone),date_trunc('day',$3::timestamptz AT TIME ZONE b.booking_timezone),make_interval(days=>1)) d CROSS JOIN LATERAL generate_series(d+b.day_start,d+b.day_end-make_interval(mins=>$5),make_interval(mins=>b.slot_minutes)) local_slot CROSS JOIN LATERAL (SELECT local_slot AT TIME ZONE b.booking_timezone AS slot) z WHERE b.tenant_id=$1 AND b.enabled AND extract(isodow FROM local_slot)=ANY(b.available_weekdays) AND slot >= $2 AND slot < $3 AND slot>now()+interval '1 minute' AND NOT EXISTS(SELECT 1 FROM appointments ap WHERE ap.tenant_id=$1 AND ap.clinician_id=$4 AND ap.status NOT IN('cancelled','no_show') AND ap.starts_at<slot+make_interval(mins=>$5) AND ap.ends_at>slot) AND NOT EXISTS(SELECT 1 FROM schedule_blocks sb WHERE sb.tenant_id=$1 AND sb.clinician_id=$4 AND sb.active AND sb.starts_at<slot+make_interval(mins=>$5) AND sb.ends_at>slot) AND NOT EXISTS(SELECT 1 FROM scheduling_holds h WHERE h.tenant_id=$1 AND h.status='active' AND h.expires_at>now() AND h.starts_at<slot+make_interval(mins=>$5) AND h.ends_at>slot) ORDER BY slot LIMIT 501").bind(a.tenant_id).bind(q.start).bind(q.end).bind(service.clinician_id).bind(service.duration_minutes).fetch_all(&mut *tx).await?;
    if slots.len() > 500 {
        return Err(Error::Invalid("too many available slots; narrow the range"));
    }
    crate::postgres::audit(
        &mut tx,
        &a,
        "partner_schedule.availability_read",
        service.id,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"service_id":service.id,"slots":slots.into_iter().map(|starts_at|json!({"starts_at":starts_at,"ends_at":starts_at+Duration::minutes(service.duration_minutes.into())})).collect::<Vec<_>>()}),
    ))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HoldInput {
    request_id: Uuid,
    service_id: Uuid,
    starts_at: DateTime<Utc>,
    hold_seconds: Option<i64>,
}
async fn offered(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    svc: &Service,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    except_hold: Option<Uuid>,
    except_appointment: Option<Uuid>,
) -> Result<()> {
    if start <= Utc::now() + Duration::minutes(1) || end <= start {
        return Err(Error::Conflict("requested time is not available"));
    }
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM previsit_booking_profiles b WHERE b.tenant_id=$1 AND b.enabled AND extract(isodow FROM ($2 AT TIME ZONE b.booking_timezone))::smallint=ANY(b.available_weekdays) AND ($2 AT TIME ZONE b.booking_timezone)::time>=b.day_start AND ($3 AT TIME ZONE b.booking_timezone)::time<=b.day_end AND mod((extract(epoch FROM ((($2 AT TIME ZONE b.booking_timezone)::time)-b.day_start))/60)::integer,b.slot_minutes)=0)").bind(a.tenant_id).bind(start).bind(end).fetch_one(&mut **tx).await?;
    if !valid {
        return Err(Error::Conflict(
            "requested time is outside configured availability",
        ));
    }
    let conflict:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM appointments WHERE tenant_id=$1 AND clinician_id=$2 AND status NOT IN('cancelled','no_show') AND starts_at<$4 AND ends_at>$3 AND ($5::uuid IS NULL OR id<>$5)) OR EXISTS(SELECT 1 FROM schedule_blocks WHERE tenant_id=$1 AND clinician_id=$2 AND active AND starts_at<$4 AND ends_at>$3) OR EXISTS(SELECT 1 FROM scheduling_holds WHERE tenant_id=$1 AND status='active' AND expires_at>now() AND starts_at<$4 AND ends_at>$3 AND ($6::uuid IS NULL OR id<>$6))").bind(a.tenant_id).bind(svc.clinician_id).bind(start).bind(end).bind(except_appointment).bind(except_hold).fetch_one(&mut **tx).await?;
    if conflict {
        Err(Error::Conflict("requested time is no longer available"))
    } else {
        Ok(())
    }
}
async fn expire_holds(tx: &mut Transaction<'_, Postgres>, tenant: Uuid) -> Result<()> {
    sqlx::query("UPDATE scheduling_holds SET status='expired' WHERE tenant_id=$1 AND status='active' AND expires_at<=now()").bind(tenant).execute(&mut **tx).await?;
    Ok(())
}
async fn create_hold(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(v): Json<HoldInput>,
) -> Result<Response> {
    a.scheduling()?;
    let hash = digest(&v)?;
    let seconds = v.hold_seconds.unwrap_or(300);
    if !(60..=600).contains(&seconds) {
        return Err(Error::Invalid("hold_seconds must be between 60 and 600"));
    }
    let mut tx = db(&s)?.begin().await?;
    crate::scheduling::tenant_lock(&mut tx, &a).await?;
    expire_holds(&mut tx, a.tenant_id).await?;
    if let Some((id,old,expires))=sqlx::query_as::<_,(Uuid,String,DateTime<Utc>)>("SELECT id,request_digest,expires_at FROM scheduling_holds WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(v.request_id).fetch_optional(&mut *tx).await?{if old!=hash{return Err(Error::Conflict("request identifier was already used"));}tx.commit().await?;return Ok((StatusCode::OK,Json(json!({"id":id,"expires_at":expires,"already_recorded":true}))).into_response());}
    let svc = service(&mut tx, &a, v.service_id).await?;
    let end = v.starts_at + Duration::minutes(svc.duration_minutes.into());
    offered(&mut tx, &a, &svc, v.starts_at, end, None, None).await?;
    let id = Uuid::new_v4();
    let expires = Utc::now() + Duration::seconds(seconds);
    sqlx::query("INSERT INTO scheduling_holds(tenant_id,id,service_id,actor_id,starts_at,ends_at,expires_at,request_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(a.tenant_id).bind(id).bind(svc.id).bind(a.sub).bind(v.starts_at).bind(end).bind(expires).bind(v.request_id).bind(hash).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "partner_schedule.hold_create", id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED,Json(json!({"id":id,"service_id":svc.id,"starts_at":v.starts_at,"ends_at":end,"expires_at":expires}))).into_response())
}
async fn release_hold(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    a.scheduling()?;
    let mut tx = db(&s)?.begin().await?;
    let changed=sqlx::query("UPDATE scheduling_holds SET status='released' WHERE tenant_id=$1 AND id=$2 AND status='active'").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::NotFound);
    }
    crate::postgres::audit(&mut tx, &a, "partner_schedule.hold_release", id).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CreateAppointment {
    request_id: Uuid,
    source_system: String,
    external_reference: String,
    hold_id: Uuid,
    patient_id: Option<Uuid>,
    given_name: Option<String>,
    family_name: Option<String>,
    birth_date: Option<NaiveDate>,
    email: Option<String>,
    phone: Option<String>,
}
async fn emit(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    kind: &str,
    appointment: Uuid,
    payload: Value,
) -> Result<Uuid> {
    let event = Uuid::new_v4();
    sqlx::query("INSERT INTO scheduling_webhook_outbox(tenant_id,subscription_id,event_id,event_type,payload) SELECT $1,id,$2,$3,$4 FROM scheduling_webhook_subscriptions WHERE tenant_id=$1 AND enabled AND $3=ANY(events)").bind(a.tenant_id).bind(event).bind(kind).bind(payload).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, kind, appointment).await?;
    Ok(event)
}
async fn create_appointment(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(mut v): Json<CreateAppointment>,
) -> Result<Response> {
    a.scheduling()?;
    v.source_system = clean(&v.source_system, 80)?.to_ascii_lowercase();
    if v.source_system.len() < 2
        || !v
            .source_system
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_.-".contains(c))
    {
        return Err(Error::Invalid(
            "source_system must be a stable lowercase identifier",
        ));
    }
    v.external_reference = clean(&v.external_reference, 200)?;
    let hash = digest(&v)?;
    let mut tx = db(&s)?.begin().await?;
    crate::scheduling::tenant_lock(&mut tx, &a).await?;
    expire_holds(&mut tx, a.tenant_id).await?;
    if let Some((appointment, old, old_source, old_reference)) = sqlx::query_as::<
        _,
        (Uuid, String, String, String),
    >("SELECT appointment_id,request_digest,source_system,external_reference FROM scheduling_external_appointments WHERE tenant_id=$1 AND request_id=$2")
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        if old != hash || old_source != v.source_system || old_reference != v.external_reference {
            return Err(Error::Conflict("request identifier was already used"));
        }
        let row: Value = sqlx::query_scalar("SELECT to_jsonb(a)-'tenant_id'-'request_digest'-'request_id' FROM appointments a WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(appointment)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok((StatusCode::OK, Json(json!({"appointment":row,"already_recorded":true}))).into_response());
    }
    if let Some((appointment,old))=sqlx::query_as::<_,(Uuid,String)>("SELECT appointment_id,request_digest FROM scheduling_external_appointments WHERE tenant_id=$1 AND source_system=$2 AND external_reference=$3").bind(a.tenant_id).bind(&v.source_system).bind(&v.external_reference).fetch_optional(&mut *tx).await?{if old!=hash{return Err(Error::Conflict("external reference already identifies a different booking"));}let row:Value=sqlx::query_scalar("SELECT to_jsonb(a)-'tenant_id'-'request_digest'-'request_id' FROM appointments a WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(appointment).fetch_one(&mut *tx).await?;tx.commit().await?;return Ok((StatusCode::OK,Json(json!({"appointment":row,"already_recorded":true}))).into_response());}
    let hold:Option<(Uuid,Uuid,DateTime<Utc>,DateTime<Utc>)>=sqlx::query_as("SELECT id,service_id,starts_at,ends_at FROM scheduling_holds WHERE tenant_id=$1 AND id=$2 AND status='active' AND expires_at>now() FOR UPDATE").bind(a.tenant_id).bind(v.hold_id).fetch_optional(&mut *tx).await?;
    let (hold_id, service_id, start, end) =
        hold.ok_or(Error::Conflict("slot hold is missing or expired"))?;
    let svc = service(&mut tx, &a, service_id).await?;
    offered(&mut tx, &a, &svc, start, end, Some(hold_id), None).await?;
    let patient = if let Some(id) = v.patient_id {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)",
        )
        .bind(a.tenant_id)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if !exists {
            return Err(Error::NotFound);
        }
        id
    } else {
        let given = clean(v.given_name.as_deref().unwrap_or(""), 100)?;
        let family = clean(v.family_name.as_deref().unwrap_or(""), 100)?;
        let email = clean(v.email.as_deref().unwrap_or(""), 254)?.to_ascii_lowercase();
        if !email.contains('@') {
            return Err(Error::Invalid(
                "a valid email is required for a new patient",
            ));
        }
        let phone = clean(v.phone.as_deref().unwrap_or(""), 40)?;
        if phone.chars().filter(|c| c.is_ascii_digit()).count() < 7 {
            return Err(Error::Invalid(
                "a valid phone is required for a new patient",
            ));
        }
        let dob = v
            .birth_date
            .ok_or(Error::Invalid("birth_date is required for a new patient"))?;
        if dob > Utc::now().date_naive() || dob < NaiveDate::from_ymd_opt(1900, 1, 1).expect("date")
        {
            return Err(Error::Invalid("birth date is outside the supported range"));
        }
        let id = Uuid::new_v4();
        let mrn = format!(
            "SC-{}-{}",
            Utc::now().format("%Y%m%d"),
            id.simple().to_string()[..8].to_ascii_uppercase()
        );
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(mrn).bind(given).bind(family).bind(dob).execute(&mut *tx).await?;
        let contact = json!({"email":email,"phone":phone});
        sqlx::query("INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,$3)").bind(a.tenant_id).bind(id).bind(&contact).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO patient_demographics_history(tenant_id,patient_id,version,content,author_id,reason) VALUES($1,$2,1,$3,$4,'Partner booking supplied demographics; staff verification required')").bind(a.tenant_id).bind(id).bind(contact).bind(a.sub).execute(&mut *tx).await?;
        id
    };
    crate::scheduling::available(
        &mut tx,
        &a,
        svc.clinician_id,
        patient,
        start,
        end,
        &svc.facility,
        &svc.room,
        None,
    )
    .await?;
    let appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status,title,category,facility,room,notes,request_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,'booked',$7,$8,$9,$10,'Partner API booking; identity and contact require staff verification',$11,$12)").bind(a.tenant_id).bind(appointment).bind(patient).bind(svc.clinician_id).bind(start).bind(end).bind(&svc.name).bind(&svc.category).bind(&svc.facility).bind(&svc.room).bind(v.request_id).bind(&hash).execute(&mut *tx).await?;
    crate::scheduling::revision(
        &mut tx,
        &a,
        appointment,
        "Appointment created by authorized scheduling partner",
    )
    .await?;
    sqlx::query("INSERT INTO scheduling_external_appointments(tenant_id,source_system,external_reference,appointment_id,service_id,request_id,request_digest,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(a.tenant_id).bind(&v.source_system).bind(&v.external_reference).bind(appointment).bind(svc.id).bind(v.request_id).bind(&hash).bind(a.sub).execute(&mut *tx).await?;
    sqlx::query("UPDATE scheduling_holds SET status='booked' WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(hold_id)
        .execute(&mut *tx)
        .await?;
    let intake = crate::previsit::issue_for_appointment(
        &mut tx,
        a.tenant_id,
        appointment,
        patient,
        a.sub,
        start,
    )
    .await?;
    emit(&mut tx,&a,"appointment.created",appointment,json!({"appointment_id":appointment,"external_reference":v.external_reference,"source_system":v.source_system,"starts_at":start,"ends_at":end})).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED,Json(json!({"appointment_id":appointment,"patient_id":patient,"starts_at":start,"ends_at":end,"version":1,"intake_url":intake.map(|(_,token)|format!("/intake#token={token}"))}))).into_response())
}

async fn external_row(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
) -> Result<(Value, i64, Uuid, Uuid)> {
    sqlx::query_as("SELECT to_jsonb(ap)-'tenant_id'-'request_digest'-'request_id',ap.version,x.service_id,ap.patient_id FROM scheduling_external_appointments x JOIN appointments ap ON ap.tenant_id=x.tenant_id AND ap.id=x.appointment_id WHERE x.tenant_id=$1 AND x.appointment_id=$2 FOR UPDATE OF ap").bind(a.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn appointment(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    let mut tx = db(&s)?.begin().await?;
    let (row, _, _, _) = external_row(&mut tx, &a, id).await?;
    crate::postgres::audit(&mut tx, &a, "partner_schedule.appointment_read", id).await?;
    tx.commit().await?;
    Ok(Json(row))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExternalAppointmentQuery {
    source_system: String,
    external_reference: String,
}
async fn appointment_by_external_reference(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(mut q): Query<ExternalAppointmentQuery>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    q.source_system = clean(&q.source_system, 80)?.to_ascii_lowercase();
    q.external_reference = clean(&q.external_reference, 200)?;
    let mut tx = db(&s)?.begin().await?;
    let (id, row): (Uuid, Value) = sqlx::query_as("SELECT ap.id,to_jsonb(ap)-'tenant_id'-'request_digest'-'request_id' FROM scheduling_external_appointments x JOIN appointments ap ON ap.tenant_id=x.tenant_id AND ap.id=x.appointment_id WHERE x.tenant_id=$1 AND x.source_system=$2 AND x.external_reference=$3")
        .bind(a.tenant_id)
        .bind(q.source_system)
        .bind(q.external_reference)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
    crate::postgres::audit(
        &mut tx,
        &a,
        "partner_schedule.appointment_read_external",
        id,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(row))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RescheduleInput {
    request_id: Uuid,
    starts_at: DateTime<Utc>,
    reason: String,
}
async fn repeated_mutation(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    request_id: Uuid,
    appointment_id: Uuid,
    action: &str,
    request_digest: &str,
) -> Result<Option<Value>> {
    let previous: Option<(Uuid, String, String)> = sqlx::query_as(
        "SELECT appointment_id,action,request_digest FROM scheduling_partner_mutations WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(request_id)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some((old_appointment, old_action, old_digest)) = previous {
        if old_appointment != appointment_id || old_action != action || old_digest != request_digest
        {
            return Err(Error::Conflict("request identifier was already used"));
        }
        let row: Value = sqlx::query_scalar("SELECT to_jsonb(a)-'tenant_id'-'request_digest'-'request_id' FROM appointments a WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(appointment_id)
            .fetch_one(&mut **tx)
            .await?;
        return Ok(Some(row));
    }
    Ok(None)
}
async fn reschedule(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(mut v): Json<RescheduleInput>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    v.reason = clean(&v.reason, 1000)?;
    let request_digest = digest(&v)?;
    let expected = version(&h)?;
    let mut tx = db(&s)?.begin().await?;
    crate::scheduling::tenant_lock(&mut tx, &a).await?;
    expire_holds(&mut tx, a.tenant_id).await?;
    if let Some(row) =
        repeated_mutation(&mut tx, &a, v.request_id, id, "reschedule", &request_digest).await?
    {
        tx.commit().await?;
        return Ok(Json(row));
    }
    let (_, current, service_id, patient) = external_row(&mut tx, &a, id).await?;
    if current != expected {
        return Err(Error::Conflict(
            "appointment changed; reload before rescheduling",
        ));
    }
    let svc = service(&mut tx, &a, service_id).await?;
    let end = v.starts_at + Duration::minutes(svc.duration_minutes.into());
    offered(&mut tx, &a, &svc, v.starts_at, end, None, Some(id)).await?;
    crate::scheduling::available(
        &mut tx,
        &a,
        svc.clinician_id,
        patient,
        v.starts_at,
        end,
        &svc.facility,
        &svc.room,
        Some(id),
    )
    .await?;
    sqlx::query("UPDATE appointments SET clinician_id=$3,starts_at=$4,ends_at=$5,facility=$6,room=$7,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(svc.clinician_id).bind(v.starts_at).bind(end).bind(&svc.facility).bind(&svc.room).execute(&mut *tx).await?;
    crate::scheduling::revision(&mut tx, &a, id, &v.reason).await?;
    sqlx::query("INSERT INTO scheduling_partner_mutations(tenant_id,request_id,appointment_id,action,request_digest,resulting_version,actor_id) VALUES($1,$2,$3,'reschedule',$4,$5,$6)")
        .bind(a.tenant_id).bind(v.request_id).bind(id).bind(&request_digest).bind(current + 1).bind(a.sub).execute(&mut *tx).await?;
    emit(
        &mut tx,
        &a,
        "appointment.changed",
        id,
        json!({"appointment_id":id,"starts_at":v.starts_at,"ends_at":end}),
    )
    .await?;
    let row:Value=sqlx::query_scalar("SELECT to_jsonb(a)-'tenant_id'-'request_digest'-'request_id' FROM appointments a WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(row))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CancelInput {
    request_id: Uuid,
    reason: String,
}
async fn cancel(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(mut v): Json<CancelInput>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    v.reason = clean(&v.reason, 1000)?;
    let request_digest = digest(&v)?;
    let expected = version(&h)?;
    let mut tx = db(&s)?.begin().await?;
    crate::scheduling::tenant_lock(&mut tx, &a).await?;
    if let Some(row) =
        repeated_mutation(&mut tx, &a, v.request_id, id, "cancel", &request_digest).await?
    {
        tx.commit().await?;
        return Ok(Json(row));
    }
    let (_, current, _, _) = external_row(&mut tx, &a, id).await?;
    if current != expected {
        return Err(Error::Conflict(
            "appointment changed; reload before cancelling",
        ));
    }
    let status: String =
        sqlx::query_scalar("SELECT status FROM appointments WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if !matches!(status.as_str(), "booked" | "checked_in") {
        return Err(Error::Conflict(
            "appointment cannot be cancelled in its current state",
        ));
    }
    sqlx::query(
        "UPDATE appointments SET status='cancelled',version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    crate::scheduling::revision(&mut tx, &a, id, &v.reason).await?;
    sqlx::query("INSERT INTO scheduling_partner_mutations(tenant_id,request_id,appointment_id,action,request_digest,resulting_version,actor_id) VALUES($1,$2,$3,'cancel',$4,$5,$6)")
        .bind(a.tenant_id).bind(v.request_id).bind(id).bind(&request_digest).bind(current + 1).bind(a.sub).execute(&mut *tx).await?;
    emit(
        &mut tx,
        &a,
        "appointment.cancelled",
        id,
        json!({"appointment_id":id}),
    )
    .await?;
    let row:Value=sqlx::query_scalar("SELECT to_jsonb(a)-'tenant_id'-'request_digest'-'request_id' FROM appointments a WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(row))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WebhookInput {
    label: String,
    endpoint: String,
    events: Vec<String>,
}
const EVENTS: [&str; 3] = [
    "appointment.created",
    "appointment.changed",
    "appointment.cancelled",
];
fn public_webhook_host(url: &url::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return false;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified())
        }
        Ok(IpAddr::V6(ip)) => {
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local())
        }
        Err(_) => true,
    }
}
async fn webhooks(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.scheduling()?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'label',label,'endpoint',endpoint,'events',events,'enabled',enabled,'version',version,'created_at',created_at) FROM scheduling_webhook_subscriptions WHERE tenant_id=$1 ORDER BY created_at,id").bind(a.tenant_id).fetch_all(db(&s)?).await?;
    Ok(Json(json!({"items":items})))
}
async fn create_webhook(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(mut v): Json<WebhookInput>,
) -> Result<Response> {
    if !matches!(a.role, crate::auth::Role::Owner) {
        return Err(Error::Forbidden);
    }
    v.label = clean(&v.label, 120)?;
    let url = url::Url::parse(v.endpoint.trim())
        .map_err(|_| Error::Invalid("valid HTTPS webhook endpoint required"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
        || !public_webhook_host(&url)
    {
        return Err(Error::Invalid("valid HTTPS webhook endpoint required"));
    }
    v.events.sort();
    v.events.dedup();
    if v.events.is_empty() || v.events.iter().any(|e| !EVENTS.contains(&e.as_str())) {
        return Err(Error::Invalid("choose supported scheduling webhook events"));
    }
    let id = Uuid::new_v4();
    let secret = crate::oauth::random("sce_whsec_");
    let encrypted_secret = crate::provider_settings::seal_secret(
        db(&s)?,
        a.tenant_id,
        id,
        "scheduling-webhook",
        &secret,
    )
    .await?;
    let mut tx = db(&s)?.begin().await?;
    sqlx::query("INSERT INTO scheduling_webhook_subscriptions(tenant_id,id,label,endpoint,events,encrypted_signing_secret,signing_secret_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(a.tenant_id).bind(id).bind(v.label).bind(url.as_str()).bind(&v.events).bind(encrypted_secret).bind(crate::oauth::hash(&secret)).bind(a.sub).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "partner_schedule.webhook_create", id).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":id,"signing_secret":secret,"events":v.events,"endpoint":url.as_str()})),
    )
        .into_response())
}
async fn disable_webhook(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<StatusCode> {
    if !matches!(a.role, crate::auth::Role::Owner) {
        return Err(Error::Forbidden);
    }
    let expected = version(&h)?;
    let mut tx = db(&s)?.begin().await?;
    let changed=sqlx::query("UPDATE scheduling_webhook_subscriptions SET enabled=false,version=version+1 WHERE tenant_id=$1 AND id=$2 AND version=$3 AND enabled").bind(a.tenant_id).bind(id).bind(expected).execute(&mut *tx).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::Conflict("webhook changed or was not found"));
    }
    crate::postgres::audit(&mut tx, &a, "partner_schedule.webhook_disable", id).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_hosts_reject_local_network_targets() {
        for raw in [
            "https://localhost/hook",
            "https://service.local/hook",
            "https://127.0.0.1/hook",
            "https://10.1.2.3/hook",
            "https://169.254.1.2/hook",
            "https://[::1]/hook",
            "https://[fd00::1]/hook",
        ] {
            let url = url::Url::parse(raw).expect("valid test URL");
            assert!(!public_webhook_host(&url), "accepted {raw}");
        }
        assert!(public_webhook_host(
            &url::Url::parse("https://partner.example/hook").expect("valid public URL")
        ));
    }

    #[test]
    fn source_and_request_digests_are_stable() {
        let input = HoldInput {
            request_id: Uuid::nil(),
            service_id: Uuid::from_u128(1),
            starts_at: DateTime::parse_from_rfc3339("2026-11-06T18:00:00Z")
                .expect("valid date")
                .with_timezone(&Utc),
            hold_seconds: Some(300),
        };
        assert_eq!(digest(&input).expect("digest").len(), 64);
        assert_eq!(
            digest(&input).expect("digest"),
            digest(&input).expect("digest")
        );
    }
}
