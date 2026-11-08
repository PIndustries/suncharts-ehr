// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Public booking, patient-controlled intake packets and staff readiness review.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::{header, HeaderMap, Method, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration, NaiveDate, NaiveTime, Utc};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashSet;
use uuid::Uuid;

fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn clean(value: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "required text is missing or exceeds its limit",
        ));
    }
    Ok(value.to_owned())
}
fn version(headers: &HeaderMap) -> Result<i64> {
    headers
        .get(header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix('"'))
        .and_then(|v| v.strip_suffix('"'))
        .and_then(|v| v.parse().ok())
        .filter(|v| *v >= 0)
        .ok_or(Error::VersionRequired)
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn digest(value: &impl serde::Serialize) -> String {
    hash(&serde_json::to_string(value).expect("serializable public request"))
}
fn staff_write(actor: &Actor) -> Result<()> {
    if matches!(actor.role, Role::Owner | Role::Clinician | Role::FrontDesk) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
fn owner(actor: &Actor) -> Result<()> {
    if matches!(actor.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

pub fn router() -> Router<State> {
    Router::new()
        .route("/book/{slug}", get(public_booking_page))
        .route("/intake", get(public_intake_page))
        .route("/previsit-public.js", get(public_script))
        .route("/previsit.css", get(public_style))
        .route("/previsit.js", get(staff_script))
        .route(
            "/api/public/v1/booking/{slug}",
            get(public_profile).post(public_book),
        )
        .route("/api/public/v1/intake/read", post(public_packet))
        .route("/api/public/v1/intake/submit", post(public_submit))
        .route(
            "/api/v1/previsit/settings",
            get(settings).put(save_settings),
        )
        .route("/api/v1/previsit/templates", post(save_template))
        .route("/api/v1/previsit/readiness", get(readiness))
        .route(
            "/api/v1/appointments/{id}/intake-packet",
            post(issue_packet),
        )
        .route("/api/v1/previsit/packets/{id}/review", post(review_packet))
        .route("/api/v1/previsit/packets/{id}", get(packet_detail))
        .route(
            "/api/v1/previsit/packets/{id}/demographics",
            post(promote_demographics),
        )
        .route(
            "/api/v1/care-pathways/instances/{id}/steps/{step}/intake-packet",
            post(issue_workflow_packet),
        )
}
async fn public_booking_page() -> Html<String> {
    Html(crate::web_content(
        "previsit-booking.html",
        include_str!("../web/previsit-booking.html"),
    ))
}
async fn public_intake_page() -> Html<String> {
    Html(crate::web_content(
        "previsit-intake.html",
        include_str!("../web/previsit-intake.html"),
    ))
}
async fn public_script() -> impl IntoResponse {
    crate::web_asset(
        "previsit-public.js",
        "text/javascript; charset=utf-8",
        include_str!("../web/previsit-public.js"),
    )
}
async fn public_style() -> impl IntoResponse {
    crate::web_asset(
        "previsit.css",
        "text/css; charset=utf-8",
        include_str!("../web/previsit.css"),
    )
}
async fn staff_script() -> impl IntoResponse {
    crate::web_asset(
        "previsit.js",
        "text/javascript; charset=utf-8",
        include_str!("../web/previsit.js"),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsInput {
    public_slug: String,
    enabled: bool,
    default_clinician_id: Uuid,
    appointment_title: String,
    appointment_category: String,
    duration_minutes: i32,
    booking_horizon_days: i32,
    booking_timezone: String,
    available_weekdays: Vec<i16>,
    day_start: NaiveTime,
    day_end: NaiveTime,
    slot_minutes: i32,
    welcome_text: String,
    reason: String,
}
async fn settings(actor: Actor, ExtractState(state): ExtractState<State>) -> Result<Json<Value>> {
    actor.staff()?;
    let profile:Option<Value>=sqlx::query_scalar("SELECT to_jsonb(p)-'tenant_id'-'updated_by' FROM previsit_booking_profiles p WHERE tenant_id=$1")
        .bind(actor.tenant_id).fetch_optional(db(&state)?).await?;
    let template:Option<Value>=sqlx::query_scalar("SELECT (to_jsonb(t)-'tenant_id'-'updated_by') FROM previsit_intake_templates t WHERE tenant_id=$1 AND active")
        .bind(actor.tenant_id).fetch_optional(db(&state)?).await?;
    Ok(Json(json!({"profile":profile,"template":template})))
}
async fn save_settings(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    headers: HeaderMap,
    Json(mut input): Json<SettingsInput>,
) -> Result<Response> {
    owner(&actor)?;
    let expected = version(&headers)?;
    input.public_slug = input.public_slug.trim().to_ascii_lowercase();
    input.appointment_title = clean(&input.appointment_title, 200)?;
    input.appointment_category = clean(&input.appointment_category, 100)?;
    input.reason = clean(&input.reason, 1000)?;
    input.booking_timezone = clean(&input.booking_timezone, 100)?;
    input.welcome_text = input.welcome_text.trim().to_owned();
    if input.welcome_text.chars().count() > 1000
        || input.duration_minutes < 5
        || input.duration_minutes > 480
        || input.booking_horizon_days < 1
        || input.booking_horizon_days > 365
        || input.available_weekdays.is_empty()
        || input.available_weekdays.len() > 7
        || input
            .available_weekdays
            .iter()
            .any(|day| !(1..=7).contains(day))
        || input.day_end <= input.day_start
        || !(5..=240).contains(&input.slot_minutes)
    {
        return Err(Error::Invalid("invalid public booking settings"));
    }
    let mut tx = db(&state)?.begin().await?;
    let current: Option<i64> = sqlx::query_scalar(
        "SELECT version FROM previsit_booking_profiles WHERE tenant_id=$1 FOR UPDATE",
    )
    .bind(actor.tenant_id)
    .fetch_optional(&mut *tx)
    .await?;
    if current.unwrap_or(0) != expected {
        return Err(Error::Conflict(
            "booking settings changed; reload before saving",
        ));
    }
    let eligible:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM browser_users u LEFT JOIN practice_providers p ON p.tenant_id=u.tenant_id AND p.id=u.id WHERE u.tenant_id=$1 AND u.id=$2 AND NOT u.disabled AND u.role IN('owner','clinician') AND coalesce(p.active,true))")
        .bind(actor.tenant_id).bind(input.default_clinician_id).fetch_one(&mut *tx).await?;
    if !eligible {
        return Err(Error::Invalid("choose an active clinician"));
    }
    let valid_timezone: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1)")
            .bind(&input.booking_timezone)
            .fetch_one(&mut *tx)
            .await?;
    if !valid_timezone {
        return Err(Error::Invalid("choose a supported IANA timezone or UTC"));
    }
    let next = expected + 1;
    let row:Value=sqlx::query_scalar("INSERT INTO previsit_booking_profiles(tenant_id,public_slug,enabled,default_clinician_id,appointment_title,appointment_category,duration_minutes,booking_horizon_days,booking_timezone,available_weekdays,day_start,day_end,slot_minutes,welcome_text,version,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(tenant_id) DO UPDATE SET public_slug=EXCLUDED.public_slug,enabled=EXCLUDED.enabled,default_clinician_id=EXCLUDED.default_clinician_id,appointment_title=EXCLUDED.appointment_title,appointment_category=EXCLUDED.appointment_category,duration_minutes=EXCLUDED.duration_minutes,booking_horizon_days=EXCLUDED.booking_horizon_days,booking_timezone=EXCLUDED.booking_timezone,available_weekdays=EXCLUDED.available_weekdays,day_start=EXCLUDED.day_start,day_end=EXCLUDED.day_end,slot_minutes=EXCLUDED.slot_minutes,welcome_text=EXCLUDED.welcome_text,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING to_jsonb(previsit_booking_profiles)-'tenant_id'-'updated_by'")
        .bind(actor.tenant_id).bind(&input.public_slug).bind(input.enabled).bind(input.default_clinician_id).bind(&input.appointment_title).bind(&input.appointment_category).bind(input.duration_minutes).bind(input.booking_horizon_days).bind(&input.booking_timezone).bind(&input.available_weekdays).bind(input.day_start).bind(input.day_end).bind(input.slot_minutes).bind(&input.welcome_text).bind(next).bind(actor.sub).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO previsit_booking_profile_revisions(tenant_id,version,snapshot,actor_id,reason) VALUES($1,$2,$3,$4,$5)").bind(actor.tenant_id).bind(next).bind(&row).bind(actor.sub).bind(&input.reason).execute(&mut *tx).await?;
    crate::postgres::audit(
        &mut tx,
        &actor,
        "previsit.booking_settings_update",
        actor.tenant_id,
    )
    .await?;
    tx.commit().await?;
    Ok(([(header::ETAG, format!("\"{next}\""))], Json(row)).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TemplateInput {
    id: Option<Uuid>,
    name: String,
    schema: Value,
    active: bool,
    reason: String,
}
fn validate_schema(schema: &Value) -> Result<()> {
    let sections = schema
        .get("sections")
        .and_then(Value::as_array)
        .ok_or(Error::Invalid("intake template requires sections"))?;
    if sections.is_empty() || sections.len() > 20 {
        return Err(Error::Invalid("intake template must contain 1-20 sections"));
    }
    let mut keys = HashSet::new();
    let mut fields = 0;
    for section in sections {
        clean(
            section.get("label").and_then(Value::as_str).unwrap_or(""),
            120,
        )?;
        let list = section
            .get("fields")
            .and_then(Value::as_array)
            .ok_or(Error::Invalid("each intake section requires fields"))?;
        for field in list {
            fields += 1;
            let key = clean(field.get("key").and_then(Value::as_str).unwrap_or(""), 80)?;
            if !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                || ["attested", "attested_name", "submit"].contains(&key.as_str())
                || !keys.insert(key)
            {
                return Err(Error::Invalid(
                    "intake field keys must be unique identifiers",
                ));
            }
            clean(
                field.get("label").and_then(Value::as_str).unwrap_or(""),
                160,
            )?;
            let kind = field.get("type").and_then(Value::as_str).unwrap_or("");
            if ![
                "text", "textarea", "date", "phone", "email", "select", "checkbox", "number",
            ]
            .contains(&kind)
            {
                return Err(Error::Invalid("unsupported intake field type"));
            }
            if kind == "select"
                && field
                    .get("options")
                    .and_then(Value::as_array)
                    .is_none_or(|v| v.is_empty() || v.len() > 100)
            {
                return Err(Error::Invalid("select fields require bounded options"));
            }
            if let Some(options) = field.get("options").and_then(Value::as_array) {
                for option in options {
                    clean(option.as_str().unwrap_or(""), 160)?;
                }
            }
        }
    }
    if fields == 0 || fields > 100 {
        return Err(Error::Invalid("intake template must contain 1-100 fields"));
    }
    clean(
        schema
            .get("attestation")
            .and_then(Value::as_str)
            .unwrap_or(""),
        1000,
    )?;
    Ok(())
}
async fn save_template(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    headers: HeaderMap,
    Json(mut input): Json<TemplateInput>,
) -> Result<Response> {
    owner(&actor)?;
    validate_schema(&input.schema)?;
    input.name = clean(&input.name, 200)?;
    input.reason = clean(&input.reason, 1000)?;
    let expected = version(&headers)?;
    let mut tx = db(&state)?.begin().await?;
    let id = input.id.unwrap_or_else(Uuid::new_v4);
    let current: Option<i64> = sqlx::query_scalar(
        "SELECT version FROM previsit_intake_templates WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(actor.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    if current.unwrap_or(0) != expected {
        return Err(Error::Conflict(
            "intake template changed; reload before saving",
        ));
    }
    if input.active {
        let another:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM previsit_intake_templates WHERE tenant_id=$1 AND active AND id<>$2)").bind(actor.tenant_id).bind(id).fetch_one(&mut *tx).await?;
        if another {
            return Err(Error::Conflict(
                "deactivate the current intake template before replacing it",
            ));
        }
    }
    let next = expected + 1;
    let row:Value=sqlx::query_scalar("INSERT INTO previsit_intake_templates(tenant_id,id,name,version,active,schema,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,id) DO UPDATE SET name=EXCLUDED.name,version=EXCLUDED.version,active=EXCLUDED.active,schema=EXCLUDED.schema,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING to_jsonb(previsit_intake_templates)-'tenant_id'-'updated_by'")
        .bind(actor.tenant_id).bind(id).bind(&input.name).bind(next).bind(input.active).bind(&input.schema).bind(actor.sub).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO previsit_intake_template_revisions(tenant_id,template_id,version,name,schema,active,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(actor.tenant_id).bind(id).bind(next).bind(&input.name).bind(&input.schema).bind(input.active).bind(actor.sub).bind(&input.reason).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "previsit.template_update", id).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        [(header::ETAG, format!("\"{next}\""))],
        Json(row),
    )
        .into_response())
}

async fn public_profile(
    ExtractState(state): ExtractState<State>,
    Path(slug): Path<String>,
) -> Result<Json<Value>> {
    let row:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('slug',public_slug,'welcome_text',welcome_text,'duration_minutes',duration_minutes,'booking_horizon_days',booking_horizon_days,'booking_timezone',booking_timezone,'practice_name',$2,'provider_name',coalesce(nullif(p.display_name,''),u.display_name,u.email),'available_slots',(SELECT coalesce(jsonb_agg(slot ORDER BY slot),'[]'::jsonb) FROM (SELECT (local_slot AT TIME ZONE b.booking_timezone) AS slot FROM generate_series(date_trunc('day',now() AT TIME ZONE b.booking_timezone),date_trunc('day',now() AT TIME ZONE b.booking_timezone)+make_interval(days=>b.booking_horizon_days),interval '1 day') day CROSS JOIN LATERAL generate_series(day+b.day_start,day+b.day_end-make_interval(mins=>b.duration_minutes),make_interval(mins=>b.slot_minutes)) local_slot WHERE extract(isodow FROM local_slot)=ANY(b.available_weekdays) AND (local_slot AT TIME ZONE b.booking_timezone)>now()+interval '15 minutes' AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a.tenant_id=b.tenant_id AND a.clinician_id=b.default_clinician_id AND a.status NOT IN('cancelled','no_show') AND a.starts_at<(local_slot AT TIME ZONE b.booking_timezone)+make_interval(mins=>b.duration_minutes) AND a.ends_at>(local_slot AT TIME ZONE b.booking_timezone)) AND NOT EXISTS(SELECT 1 FROM schedule_blocks sb WHERE sb.tenant_id=b.tenant_id AND sb.clinician_id=b.default_clinician_id AND sb.active AND sb.starts_at<(local_slot AT TIME ZONE b.booking_timezone)+make_interval(mins=>b.duration_minutes) AND sb.ends_at>(local_slot AT TIME ZONE b.booking_timezone)) ORDER BY local_slot LIMIT 200) offered)) FROM previsit_booking_profiles b JOIN browser_users u ON u.tenant_id=b.tenant_id AND u.id=b.default_clinician_id LEFT JOIN practice_providers p ON p.tenant_id=u.tenant_id AND p.id=u.id WHERE b.public_slug=$1 AND b.enabled AND NOT u.disabled")
        .bind(slug.to_ascii_lowercase()).bind(crate::branding::InstanceBranding::from_env().display_name).fetch_optional(db(&state)?).await?;
    Ok(Json(row.ok_or(Error::NotFound)?))
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct BookingInput {
    request_id: Uuid,
    given_name: String,
    family_name: String,
    birth_date: NaiveDate,
    email: String,
    phone: String,
    starts_at: DateTime<Utc>,
}
#[derive(sqlx::FromRow)]
struct BookingProfile {
    tenant_id: Uuid,
    default_clinician_id: Uuid,
    appointment_title: String,
    appointment_category: String,
    duration_minutes: i32,
    booking_horizon_days: i32,
    booking_timezone: String,
    available_weekdays: Vec<i16>,
    day_start: NaiveTime,
    day_end: NaiveTime,
    slot_minutes: i32,
}
async fn public_book(
    ExtractState(state): ExtractState<State>,
    Path(slug): Path<String>,
    Json(mut input): Json<BookingInput>,
) -> Result<impl IntoResponse> {
    input.given_name = clean(&input.given_name, 100)?;
    input.family_name = clean(&input.family_name, 100)?;
    input.email = clean(&input.email, 254)?.to_ascii_lowercase();
    input.phone = clean(&input.phone, 40)?;
    if !input.email.contains('@') || !input.phone.chars().any(|c| c.is_ascii_digit()) {
        return Err(Error::Invalid("valid contact information is required"));
    }
    let today = Utc::now().date_naive();
    if input.birth_date > today
        || input.birth_date < NaiveDate::from_ymd_opt(1900, 1, 1).expect("valid lower bound")
    {
        return Err(Error::Invalid("birth date is outside the supported range"));
    }
    let request_digest = digest(&input);
    let contact_hash = hash(&format!("{}:{}", input.email, input.phone));
    let mut tx = db(&state)?.begin().await?;
    let profile:Option<BookingProfile>=sqlx::query_as("SELECT b.tenant_id,b.default_clinician_id,b.appointment_title,b.appointment_category,b.duration_minutes,b.booking_horizon_days,b.booking_timezone,b.available_weekdays,b.day_start,b.day_end,b.slot_minutes FROM previsit_booking_profiles b JOIN browser_users u ON u.tenant_id=b.tenant_id AND u.id=b.default_clinician_id LEFT JOIN practice_providers p ON p.tenant_id=u.tenant_id AND p.id=u.id WHERE b.public_slug=$1 AND b.enabled AND NOT u.disabled AND coalesce(p.active,true) FOR SHARE OF b")
        .bind(slug.to_ascii_lowercase()).fetch_optional(&mut *tx).await?;
    let profile = profile.ok_or(Error::NotFound)?;
    let tenant = profile.tenant_id;
    let clinician = profile.default_clinician_id;
    let title = profile.appointment_title;
    let category = profile.appointment_category;
    let duration = profile.duration_minutes;
    let horizon = profile.booking_horizon_days;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("schedule:{tenant}"))
        .execute(&mut *tx)
        .await?;
    if let Some((saved,_patient,appointment))=sqlx::query_as::<_,(String,Uuid,Uuid)>("SELECT digest,patient_id,appointment_id FROM previsit_public_requests WHERE tenant_id=$1 AND request_id=$2").bind(tenant).bind(input.request_id).fetch_optional(&mut *tx).await? {
        if saved!=request_digest { return Err(Error::Conflict("booking request identifier was already used")); }
        tx.commit().await?;return Ok((StatusCode::OK,Json(json!({"appointment_id":appointment,"already_recorded":true}))));
    }
    let recent:i64=sqlx::query_scalar("SELECT count(*) FROM previsit_public_requests WHERE tenant_id=$1 AND contact_hash=$2 AND created_at>now()-interval '24 hours'").bind(tenant).bind(&contact_hash).fetch_one(&mut *tx).await?;
    if recent >= 5 {
        return Err(Error::Conflict(
            "too many recent appointment requests; contact the practice",
        ));
    }
    let now = Utc::now();
    if input.starts_at < now + Duration::minutes(15)
        || input.starts_at > now + Duration::days(horizon.into())
    {
        return Err(Error::Invalid(
            "appointment time is outside the public booking window",
        ));
    }
    let ends = input.starts_at + Duration::minutes(duration.into());
    let offered:bool=sqlx::query_scalar("SELECT extract(isodow FROM ($1::timestamptz AT TIME ZONE $2))::smallint=ANY($3::smallint[]) AND ($1::timestamptz AT TIME ZONE $2)::time >= $4::time AND ($5::timestamptz AT TIME ZONE $2)::time <= $6::time AND mod((extract(epoch FROM ((($1::timestamptz AT TIME ZONE $2)::time)-$4::time))/60)::integer,$7)=0").bind(input.starts_at).bind(&profile.booking_timezone).bind(&profile.available_weekdays).bind(profile.day_start).bind(ends).bind(profile.day_end).bind(profile.slot_minutes).fetch_one(&mut *tx).await?;
    if !offered {
        return Err(Error::Conflict(
            "choose one of the practice's available appointment times",
        ));
    }
    let conflict:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM appointments WHERE tenant_id=$1 AND clinician_id=$2 AND status NOT IN('cancelled','no_show') AND starts_at<$4 AND ends_at>$3) OR EXISTS(SELECT 1 FROM schedule_blocks WHERE tenant_id=$1 AND clinician_id=$2 AND active AND starts_at<$4 AND ends_at>$3)")
        .bind(tenant).bind(clinician).bind(input.starts_at).bind(ends).fetch_one(&mut *tx).await?;
    if conflict {
        return Err(Error::Conflict(
            "that appointment time is no longer available",
        ));
    }
    let patient = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    let mrn = format!(
        "SC-{}-{}",
        now.format("%Y%m%d"),
        patient.simple().to_string()[..8].to_ascii_uppercase()
    );
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,$4,$5,$6)").bind(tenant).bind(patient).bind(&mrn).bind(&input.given_name).bind(&input.family_name).bind(input.birth_date).execute(&mut *tx).await?;
    let contact = json!({"email":input.email,"phone":input.phone});
    sqlx::query(
        "INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,$3)",
    )
    .bind(tenant)
    .bind(patient)
    .bind(&contact)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO patient_demographics_history(tenant_id,patient_id,version,content,author_id,reason) VALUES($1,$2,1,$3,$2,'Patient supplied contact during public booking; staff verification required')").bind(tenant).bind(patient).bind(&contact).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status,title,category,notes,request_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,'booked',$7,$8,'Public booking; identity and contact require staff verification',$9,$10)")
        .bind(tenant).bind(appointment).bind(patient).bind(clinician).bind(input.starts_at).bind(ends).bind(&title).bind(&category).bind(input.request_id).bind(&request_digest).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO appointment_revisions(tenant_id,appointment_id,version,snapshot,actor_id,reason) SELECT tenant_id,id,version,to_jsonb(a)-'tenant_id'-'request_digest'-'request_id',$3,'Patient requested appointment through public booking' FROM appointments a WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(appointment).bind(patient).execute(&mut *tx).await?;
    let booked: crate::model::Appointment =
        sqlx::query_as("SELECT * FROM appointments WHERE tenant_id=$1 AND id=$2")
            .bind(tenant)
            .bind(appointment)
            .fetch_one(&mut *tx)
            .await?;
    // This actor records the public patient's provenance only. Enqueuing work
    // grants no staff authority and does not execute any pathway actions.
    let patient_actor = Actor {
        sub: patient,
        tenant_id: tenant,
        role: Role::Patient,
        patient_id: Some(patient),
        iss: "suncharts-public-booking".into(),
        aud: "suncharts-engine".into(),
        iat: now.timestamp(),
        exp: now.timestamp() + 60,
    };
    crate::scheduling::emit_appointment_event(
        &mut tx,
        &patient_actor,
        &booked,
        "suncharts.appointment.created",
    )
    .await?;
    sqlx::query("INSERT INTO previsit_public_requests(tenant_id,request_id,digest,contact_hash,appointment_id,patient_id) VALUES($1,$2,$3,$4,$5,$6)").bind(tenant).bind(input.request_id).bind(&request_digest).bind(contact_hash).bind(appointment).bind(patient).execute(&mut *tx).await?;
    let intake = issue_for_appointment(
        &mut tx,
        tenant,
        appointment,
        patient,
        patient,
        input.starts_at,
    )
    .await?;
    sqlx::query("INSERT INTO previsit_events(tenant_id,packet_id,appointment_id,patient_id,actor_id,actor_kind,action,details) VALUES($1,$2,$3,$4,$4,'patient_guest','public_booking_created',$5)")
        .bind(tenant).bind(intake.as_ref().map(|v|v.0)).bind(appointment).bind(patient).bind(json!({"source":"public_booking"})).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,'appointment.public_booked',$3)").bind(tenant).bind(patient).bind(appointment).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(
            json!({"appointment_id":appointment,"starts_at":input.starts_at,"intake_url":intake.map(|(_,token)|format!("/intake#token={token}")),"identity_review_required":true}),
        ),
    ))
}

pub(crate) async fn issue_for_appointment(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    appointment: Uuid,
    patient: Uuid,
    issuer: Uuid,
    due: DateTime<Utc>,
) -> Result<Option<(Uuid, String)>> {
    let template:Option<(Uuid,i64,Value)>=sqlx::query_as("SELECT id,version,schema FROM previsit_intake_templates WHERE tenant_id=$1 AND active FOR SHARE").bind(tenant).fetch_optional(&mut **tx).await?;
    let Some((template_id, template_version, schema)) = template else {
        return Ok(None);
    };
    let packet = Uuid::new_v4();
    let plain = token();
    let token_hash = hash(&plain);
    sqlx::query("INSERT INTO previsit_intake_packets(tenant_id,id,appointment_id,patient_id,template_id,template_version,template_snapshot,access_token_hash,due_at,issued_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(tenant).bind(packet).bind(appointment).bind(patient).bind(template_id).bind(template_version).bind(schema).bind(token_hash).bind(due).bind(issuer).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO previsit_events(tenant_id,packet_id,appointment_id,patient_id,actor_id,actor_kind,action) VALUES($1,$2,$3,$4,$5,$6,'intake_packet_issued')")
        .bind(tenant).bind(packet).bind(appointment).bind(patient).bind(issuer).bind(if issuer==patient{"patient_guest"}else{"staff"}).execute(&mut **tx).await?;
    Ok(Some((packet, plain)))
}

#[derive(sqlx::FromRow)]
struct WorkflowForm {
    definition_version: i64,
    patient_id: Option<Uuid>,
    appointment_id: Option<Uuid>,
    status: String,
    kind: String,
    state: String,
    version: i64,
    assigned_role: Option<String>,
    definition: Value,
}

fn workflow_schema(definition: &Value, step: &str) -> Result<Value> {
    let node = definition["steps"]
        .as_array()
        .and_then(|steps| steps.iter().find(|node| node["key"] == step))
        .filter(|node| node["kind"] == "patient_form")
        .ok_or(Error::Invalid(
            "choose a patient form from this workflow revision",
        ))?;
    let fields = node["form_fields"]
        .as_array()
        .filter(|fields| !fields.is_empty() && fields.len() <= 30)
        .ok_or(Error::Invalid("this workflow patient form has no fields"))?;
    let fields = fields.iter().map(|field| {
        let kind = match field["field_type"].as_str().unwrap_or("") {
            "short_text" => "text", "long_text" => "textarea", "choice" => "select",
            "date" => "date", "checkbox" => "checkbox", "number" => "number",
            _ => return Err(Error::Invalid("unsupported workflow form field")),
        };
        Ok(json!({"key":field["key"],"label":field["label"],"type":kind,"required":field["required"],"options":field["options"],"chart_target":field["chart_target"]}))
    }).collect::<Result<Vec<_>>>()?;
    let schema = json!({"attestation":"I confirm these answers are accurate to the best of my knowledge. I understand the practice will review them before adding selected information to my chart.","sections":[{"label":node["title"],"fields":fields}]});
    validate_schema(&schema)?;
    Ok(schema)
}

async fn downstream_scope(
    state: &State,
    actor: &Actor,
    headers: &HeaderMap,
    route: &str,
) -> Result<()> {
    if let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.starts_with("sce_at_"))
    {
        let checked = crate::oauth::authenticate(state, token, &Method::POST, route).await?;
        if checked.tenant_id != actor.tenant_id || checked.sub != actor.sub {
            return Err(Error::Forbidden);
        }
    }
    Ok(())
}

pub(crate) async fn issue_for_workflow(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    instance: Uuid,
    step: &str,
    expected: Option<i64>,
    requested_appointment: Option<Uuid>,
    reason: &str,
) -> Result<(Uuid, Option<String>)> {
    staff_write(actor)?;
    let row: WorkflowForm = sqlx::query_as(
        "SELECT i.definition_version,i.patient_id,i.appointment_id,i.status,s.kind,s.state,s.version,s.assigned_role,r.definition
         FROM care_pathway_instances i JOIN care_pathway_steps s ON s.tenant_id=i.tenant_id AND s.instance_id=i.id
         JOIN care_pathway_definition_revisions r ON r.tenant_id=i.tenant_id AND r.definition_id=i.definition_id AND r.version=i.definition_version
         WHERE i.tenant_id=$1 AND i.id=$2 AND s.step_key=$3 FOR UPDATE OF i,s",
    ).bind(actor.tenant_id).bind(instance).bind(step).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
    if row.status != "active" || row.kind != "patient_form" {
        return Err(Error::Conflict("the workflow patient form is not active"));
    }
    let actor_role = serde_json::to_value(&actor.role).map_err(|_| Error::Forbidden)?;
    if !matches!(actor.role, Role::Owner)
        && row
            .assigned_role
            .as_deref()
            .is_some_and(|role| Some(role) != actor_role.as_str())
    {
        return Err(Error::Forbidden);
    }
    let appointment = if let Some(appointment) = row.appointment_id {
        appointment
    } else {
        let booked: Vec<Uuid> = sqlx::query_scalar("SELECT a.id FROM workflow_dispatches d JOIN appointments a ON a.tenant_id=d.tenant_id AND a.id::text=d.result->>'appointment_id' WHERE d.tenant_id=$1 AND d.pathway_instance_id=$2 AND d.kind='appointment_booking' AND d.status='completed' AND a.patient_id=$3 ORDER BY d.created_at LIMIT 2 FOR SHARE OF a")
            .bind(actor.tenant_id).bind(instance).bind(row.patient_id).fetch_all(&mut **tx).await?;
        if booked.len() != 1 {
            return Err(Error::Invalid("link an appointment or complete one unambiguous booking in this workflow before issuing forms"));
        }
        booked[0]
    };
    if requested_appointment.is_some_and(|id| id != appointment) {
        return Err(Error::Invalid(
            "the appointment does not match this workflow",
        ));
    }
    let patient = row.patient_id.ok_or(Error::Invalid(
        "link a patient to the workflow before issuing forms",
    ))?;
    let due: Option<DateTime<Utc>> = sqlx::query_scalar("SELECT starts_at FROM appointments WHERE tenant_id=$1 AND id=$2 AND patient_id=$3 AND status IN('booked','checked_in') FOR SHARE")
        .bind(actor.tenant_id).bind(appointment).bind(patient).fetch_optional(&mut **tx).await?;
    let due = due.ok_or(Error::Conflict(
        "the workflow appointment is unavailable or belongs to another patient",
    ))?;
    // An issued link is shown once. A retry returns the same bound packet, never
    // a second packet or a recoverable copy of its bearer secret.
    let existing: Option<Uuid> = sqlx::query_scalar("SELECT id FROM previsit_intake_packets WHERE tenant_id=$1 AND workflow_instance_id=$2 AND workflow_step_key=$3")
        .bind(actor.tenant_id).bind(instance).bind(step).fetch_optional(&mut **tx).await?;
    if let Some(packet) = existing {
        return Ok((packet, None));
    }
    if expected.is_some_and(|version| version != row.version)
        || !["ready", "in_progress"].contains(&row.state.as_str())
    {
        return Err(Error::Conflict("the workflow form changed or is not ready"));
    }
    let schema = workflow_schema(&row.definition, step)?;
    let packet = Uuid::new_v4();
    let plain = token();
    sqlx::query("INSERT INTO previsit_intake_packets(tenant_id,id,appointment_id,patient_id,template_id,template_version,template_snapshot,access_token_hash,due_at,issued_by,workflow_instance_id,workflow_step_key,workflow_definition_version) VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11,$5)")
        .bind(actor.tenant_id).bind(packet).bind(appointment).bind(patient).bind(row.definition_version).bind(schema).bind(hash(&plain)).bind(due).bind(actor.sub).bind(instance).bind(step).execute(&mut **tx).await?;
    sqlx::query("UPDATE care_pathway_steps SET state='in_progress',version=version+1,updated_at=now(),updated_by=$4 WHERE tenant_id=$1 AND instance_id=$2 AND step_key=$3")
        .bind(actor.tenant_id).bind(instance).bind(step).bind(actor.sub).execute(&mut **tx).await?;
    workflow_packet_evidence(tx, actor.tenant_id, packet, actor.sub, "sent", 1, reason).await?;
    sqlx::query("INSERT INTO previsit_events(tenant_id,packet_id,appointment_id,patient_id,actor_id,actor_kind,action,details) VALUES($1,$2,$3,$4,$5,'staff','workflow_intake_packet_issued',$6)")
        .bind(actor.tenant_id).bind(packet).bind(appointment).bind(patient).bind(actor.sub).bind(json!({"workflow_instance_id":instance,"workflow_step_key":step,"workflow_definition_version":row.definition_version})).execute(&mut **tx).await?;
    crate::postgres::audit(tx, actor, "previsit.workflow_packet_issue", packet).await?;
    Ok((packet, Some(plain)))
}

// Always lock the run and step before the packet so review and completion use
// the same lock order. Cancelled or completed workflow forms cannot be changed.
async fn lock_packet_workflow(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    packet: Uuid,
) -> Result<()> {
    let binding: Option<(Uuid, String, i64)> = sqlx::query_as("SELECT workflow_instance_id,workflow_step_key,workflow_definition_version FROM previsit_intake_packets WHERE tenant_id=$1 AND id=$2 AND workflow_instance_id IS NOT NULL")
        .bind(tenant).bind(packet).fetch_optional(&mut **tx).await?;
    if let Some((instance, step, revision)) = binding {
        let valid: Option<(String,String)> = sqlx::query_as("SELECT i.status,s.state FROM care_pathway_instances i JOIN care_pathway_steps s ON s.tenant_id=i.tenant_id AND s.instance_id=i.id JOIN previsit_intake_packets p ON p.tenant_id=i.tenant_id AND p.workflow_instance_id=i.id AND p.workflow_step_key=s.step_key WHERE i.tenant_id=$1 AND i.id=$2 AND s.step_key=$3 AND p.id=$4 AND i.definition_version=$5 AND i.patient_id=p.patient_id AND (i.appointment_id=p.appointment_id OR (i.appointment_id IS NULL AND EXISTS(SELECT 1 FROM workflow_dispatches d WHERE d.tenant_id=i.tenant_id AND d.pathway_instance_id=i.id AND d.kind='appointment_booking' AND d.status='completed' AND d.result->>'appointment_id'=p.appointment_id::text))) FOR UPDATE OF i,s")
            .bind(tenant).bind(instance).bind(step).bind(packet).bind(revision).fetch_optional(&mut **tx).await?;
        if !valid.is_some_and(|(status, state)| {
            status == "active"
                && ["ready", "in_progress", "awaiting_approval"].contains(&state.as_str())
        }) {
            return Err(Error::Conflict("this workflow form is no longer active"));
        }
    }
    Ok(())
}

async fn workflow_packet_evidence(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    packet: Uuid,
    actor: Uuid,
    status: &str,
    response_version: i64,
    reason: &str,
) -> Result<()> {
    let binding: Option<(Uuid,String,i64)> = sqlx::query_as("SELECT workflow_instance_id,workflow_step_key,workflow_definition_version FROM previsit_intake_packets WHERE tenant_id=$1 AND id=$2 AND workflow_instance_id IS NOT NULL")
        .bind(tenant).bind(packet).fetch_optional(&mut **tx).await?;
    if let Some((instance, step, revision)) = binding {
        let evidence = json!({"packet_id":packet,"packet_status":status,"response_version":response_version,"workflow_definition_version":revision});
        sqlx::query("UPDATE care_pathway_steps SET evidence=evidence||$4::jsonb,version=version+1,updated_by=$5,updated_at=now() WHERE tenant_id=$1 AND instance_id=$2 AND step_key=$3")
            .bind(tenant).bind(instance).bind(&step).bind(&evidence).bind(actor).execute(&mut **tx).await?;
        sqlx::query("INSERT INTO care_pathway_events(tenant_id,instance_id,step_key,event_type,actor_id,reason,evidence) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(tenant).bind(instance).bind(step).bind(format!("intake.{status}")).bind(actor).bind(reason).bind(evidence).execute(&mut **tx).await?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkflowIssue {
    reason: String,
}
async fn issue_workflow_packet(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path((instance, step)): Path<(Uuid, String)>,
    headers: HeaderMap,
    Json(input): Json<WorkflowIssue>,
) -> Result<Response> {
    staff_write(&actor)?;
    let reason = clean(&input.reason, 1000)?;
    let expected = version(&headers)?;
    crate::access_policies::require_native(&state, &actor, "workflows", "edit").await?;
    crate::access_policies::require_native(&state, &actor, "scheduling", "create").await?;
    downstream_scope(&state, &actor, &headers, "/api/v1/scheduling/appointments").await?;
    let mut tx = db(&state)?.begin().await?;
    let (packet, plain) = issue_for_workflow(
        &mut tx,
        &actor,
        instance,
        &step,
        Some(expected),
        None,
        &reason,
    )
    .await?;
    let binding: i64 = sqlx::query_scalar("SELECT workflow_definition_version FROM previsit_intake_packets WHERE tenant_id=$1 AND id=$2").bind(actor.tenant_id).bind(packet).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok((if plain.is_some(){StatusCode::CREATED}else{StatusCode::OK},[(header::CACHE_CONTROL,"no-store")],Json(json!({"packet_id":packet,"intake_url":plain.as_ref().map(|plain|format!("/intake#token={plain}")),"secret_shown_once":plain.is_some(),"workflow_instance_id":instance,"workflow_step_key":step,"workflow_definition_version":binding}))).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IntakeToken {
    token: String,
}
async fn public_packet(
    ExtractState(state): ExtractState<State>,
    Json(input): Json<IntakeToken>,
) -> Result<Json<Value>> {
    let token = clean(&input.token, 100)?;
    let mut tx = db(&state)?.begin().await?;
    let row:Option<(Uuid,Uuid,Uuid,Uuid,Value)>=sqlx::query_as("SELECT p.tenant_id,p.id,p.appointment_id,p.patient_id,jsonb_build_object('packet_id',p.id,'status',p.status,'due_at',p.due_at,'template',p.template_snapshot,'patient',jsonb_build_object('given_name',pt.given_name),'appointment',jsonb_build_object('starts_at',a.starts_at,'title',a.title)) FROM previsit_intake_packets p JOIN patients pt ON pt.tenant_id=p.tenant_id AND pt.id=p.patient_id JOIN appointments a ON a.tenant_id=p.tenant_id AND a.id=p.appointment_id WHERE p.access_token_hash=$1 AND p.status NOT IN('void','reviewed')")
        .bind(hash(&token)).fetch_optional(&mut *tx).await?;
    let (tenant, packet, appointment, patient, payload) = row.ok_or(Error::NotFound)?;
    lock_packet_workflow(&mut tx, tenant, packet).await?;
    sqlx::query("INSERT INTO previsit_events(tenant_id,packet_id,appointment_id,patient_id,actor_id,actor_kind,action) VALUES($1,$2,$3,$4,$4,'patient_guest','intake_opened')").bind(tenant).bind(packet).bind(appointment).bind(patient).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(payload))
}
fn validate_response(schema: &Value, response: &Value) -> Result<()> {
    let object = response
        .as_object()
        .ok_or(Error::Invalid("intake answers must be an object"))?;
    let mut allowed = HashSet::new();
    let mut required = HashSet::new();
    for section in schema
        .get("sections")
        .and_then(Value::as_array)
        .ok_or(Error::Invalid("invalid intake template"))?
    {
        for field in section
            .get("fields")
            .and_then(Value::as_array)
            .ok_or(Error::Invalid("invalid intake template"))?
        {
            let key = field
                .get("key")
                .and_then(Value::as_str)
                .ok_or(Error::Invalid("invalid intake template"))?;
            allowed.insert(key);
            if field.get("required").and_then(Value::as_bool) == Some(true) {
                required.insert(key);
            }
            if let Some(value) = object.get(key).filter(|value| !value.is_null()) {
                let kind = field["type"]
                    .as_str()
                    .ok_or(Error::Invalid("invalid intake field type"))?;
                if kind == "checkbox" {
                    if !value.is_boolean() {
                        return Err(Error::Invalid("checkbox answers must be true or false"));
                    }
                } else {
                    let text = value.as_str().ok_or(Error::Invalid(
                        "intake answers must match their field types",
                    ))?;
                    let max = if kind == "textarea" { 10_000 } else { 1000 };
                    if text.chars().count() > max
                        || text.chars().any(|c| {
                            c.is_control()
                                && !(kind == "textarea" && ['\n', '\r', '\t'].contains(&c))
                        })
                    {
                        return Err(Error::Invalid("intake answer exceeds its field limit"));
                    }
                    if !text.is_empty() {
                        let valid = match kind {
                            "date" => NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok(),
                            "number" => text.parse::<f64>().is_ok_and(f64::is_finite),
                            "select" => field["options"].as_array().is_some_and(|options| {
                                options.iter().any(|option| option.as_str() == Some(text))
                            }),
                            "text" | "textarea" | "phone" | "email" => true,
                            _ => false,
                        };
                        if !valid {
                            return Err(Error::Invalid(
                                "intake answer is not valid for this field",
                            ));
                        }
                    }
                }
            }
        }
    }
    if object.len() > 100 || object.keys().any(|k| !allowed.contains(k.as_str())) {
        return Err(Error::Invalid("intake answers do not match this packet"));
    }
    for key in required {
        if object
            .get(key)
            .is_none_or(|v| v.is_null() || v.as_str() == Some("") || v.as_bool() == Some(false))
        {
            return Err(Error::Invalid("complete every required intake field"));
        }
    }
    if serde_json::to_vec(response)
        .map_err(|_| Error::Invalid("invalid intake answers"))?
        .len()
        > 48 * 1024
    {
        return Err(Error::Invalid("intake answers exceed the size limit"));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Submission {
    token: String,
    response: Value,
    attested_name: String,
    attested: bool,
}
async fn public_submit(
    ExtractState(state): ExtractState<State>,
    Json(mut input): Json<Submission>,
) -> Result<Json<Value>> {
    input.token = clean(&input.token, 100)?;
    input.attested_name = clean(&input.attested_name, 200)?;
    if !input.attested {
        return Err(Error::Invalid("the patient attestation is required"));
    }
    let mut tx = db(&state)?.begin().await?;
    let identity: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT tenant_id,id FROM previsit_intake_packets WHERE access_token_hash=$1",
    )
    .bind(hash(&input.token))
    .fetch_optional(&mut *tx)
    .await?;
    let (tenant_id, packet_id) = identity.ok_or(Error::NotFound)?;
    lock_packet_workflow(&mut tx, tenant_id, packet_id).await?;
    let row:Option<(Uuid,Uuid,Uuid,Uuid,String,i64,Value)>=sqlx::query_as("SELECT tenant_id,id,appointment_id,patient_id,status,version,template_snapshot FROM previsit_intake_packets WHERE access_token_hash=$1 FOR UPDATE").bind(hash(&input.token)).fetch_optional(&mut *tx).await?;
    let (tenant, packet, appointment, patient, status, current, schema) =
        row.ok_or(Error::NotFound)?;
    if !["sent", "in_progress", "submitted"].contains(&status.as_str()) {
        return Err(Error::Conflict("this intake packet is closed"));
    }
    validate_response(&schema, &input.response)?;
    let next = current + 1;
    sqlx::query("INSERT INTO previsit_intake_responses(tenant_id,packet_id,version,response,attested_name,attested) VALUES($1,$2,$3,$4,$5,true)").bind(tenant).bind(packet).bind(next).bind(&input.response).bind(&input.attested_name).execute(&mut *tx).await?;
    sqlx::query("UPDATE previsit_intake_packets SET status='submitted',submitted_at=now(),version=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(packet).bind(next).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO previsit_events(tenant_id,packet_id,appointment_id,patient_id,actor_id,actor_kind,action,details) VALUES($1,$2,$3,$4,$4,'patient_guest','intake_submitted',$5)").bind(tenant).bind(packet).bind(appointment).bind(patient).bind(json!({"response_version":next,"attested":true})).execute(&mut *tx).await?;
    workflow_packet_evidence(
        &mut tx,
        tenant,
        packet,
        patient,
        "submitted",
        next,
        "Patient submitted the version-pinned intake packet",
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"packet_id":packet,"status":"submitted","version":next,"message":"Your information was received and is awaiting practice review."}),
    ))
}

async fn issue_packet(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(appointment): Path<Uuid>,
) -> Result<impl IntoResponse> {
    staff_write(&actor)?;
    let mut tx = db(&state)?.begin().await?;
    let patient: Option<Uuid> = sqlx::query_scalar(
        "SELECT patient_id FROM appointments WHERE tenant_id=$1 AND id=$2 FOR SHARE",
    )
    .bind(actor.tenant_id)
    .bind(appointment)
    .fetch_optional(&mut *tx)
    .await?;
    let patient = patient.ok_or(Error::NotFound)?;
    if sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM previsit_intake_packets WHERE tenant_id=$1 AND appointment_id=$2 AND workflow_instance_id IS NULL)").bind(actor.tenant_id).bind(appointment).fetch_one(&mut *tx).await?{return Err(Error::Conflict("an intake packet already exists for this appointment"));}
    let due: DateTime<Utc> =
        sqlx::query_scalar("SELECT starts_at FROM appointments WHERE tenant_id=$1 AND id=$2")
            .bind(actor.tenant_id)
            .bind(appointment)
            .fetch_one(&mut *tx)
            .await?;
    let (packet, plain) = issue_for_appointment(
        &mut tx,
        actor.tenant_id,
        appointment,
        patient,
        actor.sub,
        due,
    )
    .await?
    .ok_or(Error::Conflict("configure an active intake template first"))?;
    crate::postgres::audit(&mut tx, &actor, "previsit.packet_issue", packet).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(
            json!({"packet_id":packet,"intake_url":format!("/intake#token={plain}"),"secret_shown_once":true}),
        ),
    ))
}
async fn readiness(actor: Actor, ExtractState(state): ExtractState<State>) -> Result<Json<Value>> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('packet_id',p.id,'packet_version',p.version,'status',coalesce(p.status,'not_issued'),'due_at',coalesce(p.due_at,a.starts_at),'submitted_at',p.submitted_at,'reviewed_at',p.reviewed_at,'appointment_id',a.id,'starts_at',a.starts_at,'patient_id',pt.id,'patient_name',pt.family_name||', '||pt.given_name,'mrn',pt.mrn,'template_snapshot',p.template_snapshot,'workflow_instance_id',p.workflow_instance_id,'workflow_step_key',p.workflow_step_key,'workflow_definition_version',p.workflow_definition_version,'response',(SELECT response FROM previsit_intake_responses r WHERE r.tenant_id=p.tenant_id AND r.packet_id=p.id ORDER BY version DESC LIMIT 1),'attested_name',(SELECT attested_name FROM previsit_intake_responses r WHERE r.tenant_id=p.tenant_id AND r.packet_id=p.id ORDER BY version DESC LIMIT 1)) FROM appointments a JOIN patients pt ON pt.tenant_id=a.tenant_id AND pt.id=a.patient_id LEFT JOIN previsit_intake_packets p ON p.tenant_id=a.tenant_id AND p.appointment_id=a.id WHERE a.tenant_id=$1 AND a.status='booked' AND a.starts_at>now()-interval '1 day' ORDER BY a.starts_at LIMIT 200").bind(actor.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "previsit.readiness_read", actor.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":rows})))
}

async fn packet_detail(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(packet): Path<Uuid>,
) -> Result<Response> {
    actor.staff()?;
    crate::access_policies::require_native(&state, &actor, "clinical", "view").await?;
    let mut tx = db(&state)?.begin().await?;
    let value: Value = sqlx::query_scalar("SELECT jsonb_build_object('packet_id',p.id,'packet_version',p.version,'status',p.status,'due_at',p.due_at,'submitted_at',p.submitted_at,'reviewed_at',p.reviewed_at,'appointment_id',p.appointment_id,'starts_at',a.starts_at,'patient_id',p.patient_id,'patient_name',pt.family_name||', '||pt.given_name,'mrn',pt.mrn,'template_snapshot',p.template_snapshot,'workflow_instance_id',p.workflow_instance_id,'workflow_step_key',p.workflow_step_key,'workflow_definition_version',p.workflow_definition_version,'response',(SELECT response FROM previsit_intake_responses r WHERE r.tenant_id=p.tenant_id AND r.packet_id=p.id ORDER BY version DESC LIMIT 1),'attested_name',(SELECT attested_name FROM previsit_intake_responses r WHERE r.tenant_id=p.tenant_id AND r.packet_id=p.id ORDER BY version DESC LIMIT 1)) FROM previsit_intake_packets p JOIN appointments a ON a.tenant_id=p.tenant_id AND a.id=p.appointment_id JOIN patients pt ON pt.tenant_id=p.tenant_id AND pt.id=p.patient_id WHERE p.tenant_id=$1 AND p.id=$2")
        .bind(actor.tenant_id).bind(packet).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    crate::postgres::audit(&mut tx, &actor, "previsit.packet_read", packet).await?;
    tx.commit().await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response())
}

const DEMOGRAPHIC_TARGETS: &[&str] = &[
    "preferred_name",
    "pronouns",
    "language",
    "administrative_gender",
    "phone",
    "email",
];
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DemographicPromotion {
    fields: Vec<String>,
    demographics_version: i64,
    reason: String,
}
async fn promote_demographics(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(packet): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<DemographicPromotion>,
) -> Result<Response> {
    actor.scheduling()?;
    let expected = version(&headers)?;
    let reason = clean(&input.reason, 800)?;
    if input.fields.is_empty()
        || input.fields.len() > DEMOGRAPHIC_TARGETS.len()
        || input.fields.iter().collect::<HashSet<_>>().len() != input.fields.len()
        || input.demographics_version < 0
    {
        return Err(Error::Invalid(
            "select distinct mapped fields and the current demographics version",
        ));
    }
    crate::access_policies::require_native(&state, &actor, "clinical", "edit").await?;
    downstream_scope(
        &state,
        &actor,
        &headers,
        "/api/v1/patients/{id}/demographics",
    )
    .await?;
    let mut tx = db(&state)?.begin().await?;
    crate::scheduling::tenant_lock(&mut tx, &actor).await?;
    let row: Option<(Uuid,Uuid,String,i64,Value,Option<Value>)> = sqlx::query_as("SELECT patient_id,appointment_id,status,version,template_snapshot,(SELECT response FROM previsit_intake_responses r WHERE r.tenant_id=p.tenant_id AND r.packet_id=p.id ORDER BY version DESC LIMIT 1) FROM previsit_intake_packets p WHERE tenant_id=$1 AND id=$2 FOR SHARE")
        .bind(actor.tenant_id).bind(packet).fetch_optional(&mut *tx).await?;
    let (patient, appointment, status, packet_version, schema, response) =
        row.ok_or(Error::NotFound)?;
    if status != "reviewed" || packet_version != expected {
        return Err(Error::Conflict(
            "review the current submitted packet before applying mapped answers",
        ));
    }
    let response = response.ok_or(Error::Conflict(
        "this intake packet has no submitted answers",
    ))?;
    sqlx::query("SELECT id FROM patients WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(actor.tenant_id)
        .bind(patient)
        .fetch_one(&mut *tx)
        .await?;
    let prior: Option<(i64, Value)> = sqlx::query_as(
        "SELECT version,content FROM patient_demographics WHERE tenant_id=$1 AND patient_id=$2",
    )
    .bind(actor.tenant_id)
    .bind(patient)
    .fetch_optional(&mut *tx)
    .await?;
    let (current, mut content) = prior.unwrap_or((0, json!({})));
    if current != input.demographics_version {
        return Err(Error::Conflict(
            "contact details changed; reload before applying intake answers",
        ));
    }
    let fields = schema["sections"]
        .as_array()
        .ok_or(Error::Invalid("invalid intake template"))?
        .iter()
        .flat_map(|section| section["fields"].as_array().into_iter().flatten())
        .collect::<Vec<_>>();
    let mut targets = HashSet::new();
    for key in &input.fields {
        let field = fields
            .iter()
            .find(|field| field["key"].as_str() == Some(key))
            .ok_or(Error::Invalid("selected field is not in this packet"))?;
        let target = field["chart_target"]
            .as_str()
            .and_then(|value| value.strip_prefix("demographics."))
            .filter(|target| DEMOGRAPHIC_TARGETS.contains(target))
            .ok_or(Error::Invalid(
                "selected field has no supported chart mapping",
            ))?;
        if !targets.insert(target) {
            return Err(Error::Invalid(
                "multiple answers cannot replace the same chart field",
            ));
        }
        let answer = response[key]
            .as_str()
            .filter(|answer| !answer.trim().is_empty())
            .ok_or(Error::Invalid(
                "select a nonempty text answer for this chart field",
            ))?;
        content[target] = json!(answer);
    }
    let mut normalized: crate::demographics::Content = serde_json::from_value(content)
        .map_err(|_| Error::Invalid("invalid chart contact fields"))?;
    normalized.normalize()?;
    let content = serde_json::to_value(normalized)
        .map_err(|_| Error::Invalid("invalid chart contact fields"))?;
    let next = current
        .checked_add(1)
        .ok_or(Error::Conflict("contact version exhausted"))?;
    sqlx::query("INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,patient_id) DO UPDATE SET version=EXCLUDED.version,content=EXCLUDED.content").bind(actor.tenant_id).bind(patient).bind(next).bind(&content).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO patient_demographics_history(tenant_id,patient_id,version,content,author_id,reason) VALUES($1,$2,$3,$4,$5,$6)").bind(actor.tenant_id).bind(patient).bind(next).bind(&content).bind(actor.sub).bind(format!("Reviewed intake packet {packet} v{packet_version}: {reason}")).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO previsit_events(tenant_id,packet_id,appointment_id,patient_id,actor_id,actor_kind,action,details) VALUES($1,$2,$3,$4,$5,'staff','intake_demographics_promoted',$6)").bind(actor.tenant_id).bind(packet).bind(appointment).bind(patient).bind(actor.sub).bind(json!({"packet_version":packet_version,"demographics_version":next,"fields":input.fields})).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "patient.demographics_update", patient).await?;
    crate::postgres::audit(&mut tx, &actor, "previsit.demographics_promoted", packet).await?;
    tx.commit().await?;
    Ok((
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::ETAG, &format!("\"{next}\"")),
        ],
        Json(json!({"packet_id":packet,"patient_id":patient,"version":next,"content":content})),
    )
        .into_response())
}
async fn review_packet(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(packet): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    staff_write(&actor)?;
    let expected = version(&headers)?;
    let mut tx = db(&state)?.begin().await?;
    lock_packet_workflow(&mut tx, actor.tenant_id, packet).await?;
    let row:Option<(Uuid,Uuid,String,i64)>=sqlx::query_as("SELECT appointment_id,patient_id,status,version FROM previsit_intake_packets WHERE tenant_id=$1 AND id=$2 FOR UPDATE").bind(actor.tenant_id).bind(packet).fetch_optional(&mut *tx).await?;
    let (appointment, patient, status, current) = row.ok_or(Error::NotFound)?;
    if current != expected {
        return Err(Error::Conflict(
            "intake packet changed; reload before reviewing",
        ));
    }
    if status != "submitted" {
        return Err(Error::Conflict("only a submitted packet can be reviewed"));
    }
    let next = current + 1;
    sqlx::query("UPDATE previsit_intake_packets SET status='reviewed',reviewed_at=now(),reviewed_by=$3,version=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(actor.tenant_id).bind(packet).bind(actor.sub).bind(next).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO previsit_events(tenant_id,packet_id,appointment_id,patient_id,actor_id,actor_kind,action) VALUES($1,$2,$3,$4,$5,'staff','intake_reviewed')").bind(actor.tenant_id).bind(packet).bind(appointment).bind(patient).bind(actor.sub).execute(&mut *tx).await?;
    workflow_packet_evidence(
        &mut tx,
        actor.tenant_id,
        packet,
        actor.sub,
        "reviewed",
        current,
        "Staff reviewed the patient-submitted intake packet",
    )
    .await?;
    crate::postgres::audit(&mut tx, &actor, "previsit.packet_review", packet).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"packet_id":packet,"status":"reviewed","version":next}),
    ))
}
