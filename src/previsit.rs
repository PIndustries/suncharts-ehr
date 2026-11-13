// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Public booking, patient-controlled intake packets and staff readiness review.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
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
        .route("/api/public/v1/intake/save", post(public_save))
        .route("/api/public/v1/intake/lookup", post(public_lookup))
        .route("/api/public/v1/intake/submit", post(public_submit))
        .route(
            "/api/v1/previsit/settings",
            get(settings).put(save_settings),
        )
        .route("/api/v1/previsit/templates", post(save_template))
        .route("/api/v1/previsit/readiness", get(readiness))
        .route(
            "/api/v1/patients/{patient}/intake-packets",
            get(patient_packets),
        )
        .route(
            "/api/v1/patients/{patient}/intake-forms",
            post(send_patient_form),
        )
        .route(
            "/api/v1/appointments/{id}/intake-packet",
            post(issue_packet),
        )
        .route("/api/v1/previsit/packets/{id}/cancel", post(cancel_packet))
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
    let mode = match &template {
        Some(saved) if !crate::previsit_standard::uses_standard(&saved["schema"]) => "own",
        _ => "standard",
    };
    Ok(Json(
        json!({"profile":profile,"template":template,"intake_mode":mode,"standard":crate::previsit_standard::preview()}),
    ))
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
const AUTOCOMPLETE: &[&str] = &[
    "name",
    "given-name",
    "additional-name",
    "family-name",
    "honorific-suffix",
    "bday",
    "tel",
    "email",
    "address-line1",
    "address-line2",
    "address-level2",
    "address-level1",
    "postal-code",
    "off",
];
const INPUT_MODES: &[&str] = &["text", "tel", "email", "numeric", "decimal"];
const FORMATS: &[&str] = &["phone", "email", "zip", "past_date"];
/// Lists a patient can pick from instead of typing: the practice's insurance
/// companies and pharmacies.
const LOOKUPS: &[&str] = &["insurer", "pharmacy"];

fn optional_text(value: Option<&Value>, max: usize) -> Result<()> {
    match value {
        None | Some(Value::Null) => Ok(()),
        Some(value) => clean(value.as_str().unwrap_or(""), max).map(|_| ()),
    }
}
fn optional_choice(value: Option<&Value>, allowed: &[&str]) -> Result<()> {
    match value {
        None | Some(Value::Null) => Ok(()),
        Some(value) if value.as_str().is_some_and(|v| allowed.contains(&v)) => Ok(()),
        Some(_) => Err(Error::Invalid("unsupported intake field setting")),
    }
}
/// A "show only when" rule may point only at a question asked earlier, so
/// rules can never form a loop.
fn validate_condition(rule: Option<&Value>, earlier: &HashSet<String>) -> Result<()> {
    let rule = match rule {
        None | Some(Value::Null) => return Ok(()),
        Some(rule) => rule,
    };
    let invalid = Error::Invalid(
        "a show-only-when rule must name an earlier question and the answer that shows it",
    );
    let Some(object) = rule.as_object() else {
        return Err(invalid);
    };
    if !object
        .get("key")
        .and_then(Value::as_str)
        .is_some_and(|key| earlier.contains(key))
    {
        return Err(invalid);
    }
    let text = |value: &Value| {
        value
            .as_str()
            .is_some_and(|v| !v.is_empty() && v.chars().count() <= 160)
    };
    let valid = match (object.get("equals"), object.get("any_of")) {
        (Some(expected), None) => expected.is_boolean() || text(expected),
        (None, Some(list)) => list
            .as_array()
            .is_some_and(|list| !list.is_empty() && list.len() <= 20 && list.iter().all(text)),
        _ => false,
    };
    if !valid || object.len() != 2 {
        return Err(invalid);
    }
    Ok(())
}
fn validate_schema(schema: &Value) -> Result<()> {
    let sections = schema
        .get("sections")
        .and_then(Value::as_array)
        .ok_or(Error::Invalid("intake template requires sections"))?;
    if sections.is_empty() || sections.len() > 20 {
        return Err(Error::Invalid("intake template must contain 1-20 sections"));
    }
    let mut keys: HashSet<String> = HashSet::new();
    let mut fields = 0;
    for section in sections {
        clean(
            section.get("label").and_then(Value::as_str).unwrap_or(""),
            120,
        )?;
        optional_text(section.get("intro"), 500)?;
        optional_text(section.get("skip_label"), 80)?;
        if section
            .get("skippable")
            .is_some_and(|value| !value.is_boolean())
        {
            return Err(Error::Invalid("unsupported intake section setting"));
        }
        validate_condition(section.get("show_if"), &keys)?;
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
                || keys.contains(&key)
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
            let options = field.get("options").and_then(Value::as_array);
            if let Some(options) = options {
                for option in options {
                    clean(option.as_str().unwrap_or(""), 160)?;
                }
            }
            if let Some(labels) = field.get("option_labels").filter(|v| !v.is_null()) {
                let labels = labels
                    .as_array()
                    .filter(|labels| options.is_some_and(|options| options.len() == labels.len()));
                for label in labels.ok_or(Error::Invalid(
                    "choice labels must match the choices one for one",
                ))? {
                    clean(label.as_str().unwrap_or(""), 160)?;
                }
            }
            optional_text(field.get("help"), 300)?;
            optional_choice(field.get("autocomplete"), AUTOCOMPLETE)?;
            optional_choice(field.get("inputmode"), INPUT_MODES)?;
            optional_choice(field.get("format"), FORMATS)?;
            optional_choice(field.get("lookup"), LOOKUPS)?;
            optional_text(field.get("id_key"), 80)?;
            optional_text(field.get("other_key"), 80)?;
            if field.get("hidden").is_some_and(|value| !value.is_boolean()) {
                return Err(Error::Invalid("unsupported intake field setting"));
            }
            if field
                .get("max_length")
                .filter(|v| !v.is_null())
                .is_some_and(|v| !v.as_u64().is_some_and(|n| (1..=1000).contains(&n)))
            {
                return Err(Error::Invalid("unsupported intake field setting"));
            }
            // The rule is checked before the field's own key is known, so a
            // question can depend only on one asked before it.
            validate_condition(field.get("show_if"), &keys)?;
            keys.insert(key);
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
/// A saved practice form either stands alone or adds the practice's own
/// sections after the standard steps. Both are checked as the patient would
/// receive them.
fn validate_template(schema: &Value) -> Result<()> {
    match schema.get("base") {
        None | Some(Value::Null) => validate_schema(schema),
        Some(base) if base == "standard" => {
            if !schema.get("sections").is_some_and(Value::is_array) {
                return Err(Error::Invalid("intake template requires sections"));
            }
            validate_schema(&crate::previsit_standard::resolve(schema))
        }
        Some(_) => Err(Error::Invalid("unsupported intake form type")),
    }
}
async fn save_template(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    headers: HeaderMap,
    Json(mut input): Json<TemplateInput>,
) -> Result<Response> {
    owner(&actor)?;
    validate_template(&input.schema)?;
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

/// How long a new intake link works when it is not tied to a later visit.
const LINK_DAYS: i64 = 30;

/// The complete default form for this practice as a patient would receive it.
/// A practice that has saved nothing gets the standard form; when
/// `create_standard` is set that choice is recorded as the practice's form so
/// every issued form still points at a saved, versioned form.
async fn default_form(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    issuer: Uuid,
    create_standard: bool,
) -> Result<Option<(Uuid, i64, Value)>> {
    const ACTIVE: &str = "SELECT id,version,schema FROM previsit_intake_templates WHERE tenant_id=$1 AND active FOR SHARE";
    let resolved = |(id, version, schema): (Uuid, i64, Value)| {
        (id, version, crate::previsit_standard::resolve(&schema))
    };
    let saved: Option<(Uuid, i64, Value)> = sqlx::query_as(ACTIVE)
        .bind(tenant)
        .fetch_optional(&mut **tx)
        .await?;
    if saved.is_some() || !create_standard {
        return Ok(saved.map(resolved));
    }
    let schema = crate::previsit_standard::unsaved_template();
    let id = Uuid::new_v4();
    // The usual name can already belong to a form the practice switched off.
    let fallback = format!(
        "{} {}",
        crate::previsit_standard::TEMPLATE_NAME,
        &id.simple().to_string()[..8]
    );
    for name in [crate::previsit_standard::TEMPLATE_NAME, fallback.as_str()] {
        let created = sqlx::query("INSERT INTO previsit_intake_templates(tenant_id,id,name,version,active,schema,updated_by) VALUES($1,$2,$3,1,true,$4,$5) ON CONFLICT DO NOTHING")
            .bind(tenant).bind(id).bind(name).bind(&schema).bind(issuer).execute(&mut **tx).await?.rows_affected();
        if created == 1 {
            sqlx::query("INSERT INTO previsit_intake_template_revisions(tenant_id,template_id,version,name,schema,active,actor_id,reason) VALUES($1,$2,1,$3,$4,true,$5,'The practice had not saved an intake form, so the standard form is used')")
                .bind(tenant).bind(id).bind(name).bind(&schema).bind(issuer).execute(&mut **tx).await?;
        }
        // Another request may have saved the practice's form in the meantime.
        let saved: Option<(Uuid, i64, Value)> = sqlx::query_as(ACTIVE)
            .bind(tenant)
            .fetch_optional(&mut **tx)
            .await?;
        if saved.is_some() {
            return Ok(saved.map(resolved));
        }
    }
    Err(Error::Conflict(
        "the intake form could not be prepared; try again",
    ))
}

async fn issue_default(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    appointment: Option<Uuid>,
    patient: Uuid,
    issuer: Uuid,
    visit: Option<DateTime<Utc>>,
    create_standard: bool,
) -> Result<Option<(Uuid, String, DateTime<Utc>)>> {
    let Some((template_id, template_version, schema)) =
        default_form(tx, tenant, issuer, create_standard).await?
    else {
        return Ok(None);
    };
    let packet = Uuid::new_v4();
    let plain = token();
    let token_hash = hash(&plain);
    // A link for a visit further out than the usual window stays usable
    // through the day of that visit.
    let mut expires = Utc::now() + Duration::days(LINK_DAYS);
    if let Some(visit) = visit {
        expires = expires.max(visit + Duration::days(1));
    }
    let due = visit.unwrap_or(expires);
    sqlx::query("INSERT INTO previsit_intake_packets(tenant_id,id,appointment_id,patient_id,template_id,template_version,template_snapshot,access_token_hash,due_at,issued_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
        .bind(tenant).bind(packet).bind(appointment).bind(patient).bind(template_id).bind(template_version).bind(schema).bind(token_hash).bind(due).bind(issuer).bind(expires).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO previsit_events(tenant_id,packet_id,appointment_id,patient_id,actor_id,actor_kind,action) VALUES($1,$2,$3,$4,$5,$6,'intake_packet_issued')")
        .bind(tenant).bind(packet).bind(appointment).bind(patient).bind(issuer).bind(if issuer==patient{"patient_guest"}else{"staff"}).execute(&mut **tx).await?;
    Ok(Some((packet, plain, expires)))
}

/// Issues the practice's saved default form when an appointment is booked.
/// Booking never starts sending forms on its own for a practice that has not
/// saved one; staff send the standard form from the chart or the worklist.
pub(crate) async fn issue_for_appointment(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    appointment: Uuid,
    patient: Uuid,
    issuer: Uuid,
    due: DateTime<Utc>,
) -> Result<Option<(Uuid, String)>> {
    Ok(issue_default(
        tx,
        tenant,
        Some(appointment),
        patient,
        issuer,
        Some(due),
        false,
    )
    .await?
    .map(|(packet, plain, _)| (packet, plain)))
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

const LINK_CLOSED: &str =
    "This link has expired or is no longer active. Please ask the practice for a new one.";
const TOO_MANY: &str = "Too many tries in a short time. Please wait a few minutes and try again.";
/// Requests from one client, wrong or closed links from one client, and
/// requests against one link, each per 15 minutes.
const CLIENT_LIMIT: i32 = 600;
const LOOKUP_LIMIT: i32 = 240;
const MISS_LIMIT: i32 = 30;
const LINK_LIMIT: i32 = 120;

/// Patient-facing failures. An unknown, expired, cancelled or finished link
/// always gets the same answer so a link cannot be probed.
enum PublicError {
    Closed,
    Busy,
    Other(Error),
}
impl From<Error> for PublicError {
    fn from(error: Error) -> Self {
        Self::Other(error)
    }
}
impl From<sqlx::Error> for PublicError {
    fn from(error: sqlx::Error) -> Self {
        Self::Other(error.into())
    }
}
impl IntoResponse for PublicError {
    fn into_response(self) -> Response {
        match self {
            Self::Closed => (
                StatusCode::NOT_FOUND,
                [(header::CACHE_CONTROL, "no-store")],
                Json(json!({"error":"not_found","message":LINK_CLOSED})),
            )
                .into_response(),
            Self::Busy => (
                StatusCode::TOO_MANY_REQUESTS,
                [
                    (header::CACHE_CONTROL, "no-store"),
                    (header::RETRY_AFTER, "900"),
                ],
                Json(json!({"error":"too_many_requests","message":TOO_MANY})),
            )
                .into_response(),
            Self::Other(error) => error.into_response(),
        }
    }
}
type PublicResult<T> = std::result::Result<T, PublicError>;

/// Counts one more try against `key` in the shared 15-minute window table the
/// patient portal uses, and returns the tries so far in this window.
async fn count_try(pool: &PgPool, key: &str) -> Result<i32> {
    Ok(sqlx::query_scalar("INSERT INTO patient_portal_rate_limits(key) VALUES($1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN patient_portal_rate_limits.window_started<now()-interval '15 minutes' THEN 1 ELSE patient_portal_rate_limits.attempts+1 END,window_started=CASE WHEN patient_portal_rate_limits.window_started<now()-interval '15 minutes' THEN now() ELSE patient_portal_rate_limits.window_started END RETURNING attempts").bind(key).fetch_one(pool).await?)
}
fn client_key(headers: &HeaderMap) -> String {
    let address = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("direct");
    hash(address)[..32].to_owned()
}
/// Refuses a client that is sending too much or has tried too many links that
/// do not work. Returns the client's key for later counting.
async fn admit_client(pool: &PgPool, headers: &HeaderMap) -> PublicResult<String> {
    let client = client_key(headers);
    sqlx::query("DELETE FROM patient_portal_rate_limits WHERE key LIKE 'intake:%' AND window_started<now()-interval '1 day'")
        .execute(pool)
        .await?;
    let misses: Option<i32> = sqlx::query_scalar("SELECT attempts FROM patient_portal_rate_limits WHERE key=$1 AND window_started>=now()-interval '15 minutes'")
        .bind(format!("intake:miss:{client}"))
        .fetch_optional(pool)
        .await?;
    if misses.unwrap_or(0) >= MISS_LIMIT
        || count_try(pool, &format!("intake:client:{client}")).await? > CLIENT_LIMIT
    {
        return Err(PublicError::Busy);
    }
    Ok(client)
}
async fn link_closed(pool: &PgPool, client: &str) -> PublicError {
    match count_try(pool, &format!("intake:miss:{client}")).await {
        Ok(_) => PublicError::Closed,
        Err(error) => PublicError::Other(error),
    }
}
async fn admit_link(pool: &PgPool, packet: Uuid) -> PublicResult<()> {
    if count_try(pool, &format!("intake:link:{packet}")).await? > LINK_LIMIT {
        return Err(PublicError::Busy);
    }
    Ok(())
}

/// The name patients know the practice by: the managed clinic name, or the
/// practice's single location or billing name when self-hosted.
async fn practice_name(tx: &mut Transaction<'_, Postgres>, tenant: Uuid) -> Result<String> {
    let brand = crate::branding::InstanceBranding::from_env();
    if brand.managed {
        return Ok(brand.display_name);
    }
    let mut names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM practice_facilities WHERE tenant_id=$1 AND active ORDER BY name LIMIT 2",
    )
    .bind(tenant)
    .fetch_all(&mut **tx)
    .await?;
    if names.len() != 1 {
        names = sqlx::query_scalar("SELECT name FROM practice_billing_organizations WHERE tenant_id=$1 AND active ORDER BY name LIMIT 2")
            .bind(tenant)
            .fetch_all(&mut **tx)
            .await?;
    }
    Ok(if names.len() == 1 {
        names.remove(0)
    } else {
        "Your practice".to_owned()
    })
}

#[derive(sqlx::FromRow)]
struct LinkedPacket {
    tenant_id: Uuid,
    id: Uuid,
    appointment_id: Option<Uuid>,
    patient_id: Uuid,
    status: String,
    version: i64,
    template_snapshot: Value,
    expired: bool,
}
impl LinkedPacket {
    /// The link still works: not expired and not cancelled.
    fn open(&self) -> bool {
        !self.expired && self.status != "void"
    }
    /// Once the practice has reviewed the answers there is nothing left to show.
    fn readable(&self) -> bool {
        self.open() && self.status != "reviewed"
    }
}
async fn linked_packet(
    tx: &mut Transaction<'_, Postgres>,
    token: &str,
    lock: bool,
) -> Result<Option<LinkedPacket>> {
    let sql = format!("SELECT tenant_id,id,appointment_id,patient_id,status,version,template_snapshot,(expires_at IS NOT NULL AND expires_at<=now()) AS expired FROM previsit_intake_packets WHERE access_token_hash=$1{}", if lock { " FOR UPDATE" } else { "" });
    Ok(sqlx::query_as(&sql)
        .bind(hash(token))
        .fetch_optional(&mut **tx)
        .await?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IntakeToken {
    token: String,
}
async fn public_packet(
    ExtractState(state): ExtractState<State>,
    headers: HeaderMap,
    Json(input): Json<IntakeToken>,
) -> PublicResult<Response> {
    let pool = db(&state)?;
    let client = admit_client(pool, &headers).await?;
    let token = clean(&input.token, 100)?;
    let mut tx = pool.begin().await?;
    let Some(packet) = linked_packet(&mut tx, &token, false)
        .await?
        .filter(LinkedPacket::readable)
    else {
        return Err(link_closed(pool, &client).await);
    };
    admit_link(pool, packet.id).await?;
    lock_packet_workflow(&mut tx, packet.tenant_id, packet.id).await?;
    let practice = practice_name(&mut tx, packet.tenant_id).await?;
    let payload: Value = sqlx::query_scalar("SELECT jsonb_build_object('packet_id',p.id,'status',p.status,'due_at',p.due_at,'expires_at',p.expires_at,'template',p.template_snapshot,'draft',p.draft,'draft_saved_at',p.draft_saved_at,'practice_name',$3::text,'patient',jsonb_build_object('given_name',pt.given_name),'appointment',CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('starts_at',a.starts_at,'title',a.title) END) FROM previsit_intake_packets p JOIN patients pt ON pt.tenant_id=p.tenant_id AND pt.id=p.patient_id LEFT JOIN appointments a ON a.tenant_id=p.tenant_id AND a.id=p.appointment_id WHERE p.tenant_id=$1 AND p.id=$2")
        .bind(packet.tenant_id).bind(packet.id).bind(practice).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO previsit_events(tenant_id,packet_id,appointment_id,patient_id,actor_id,actor_kind,action) VALUES($1,$2,$3,$4,$4,'patient_guest','intake_opened')").bind(packet.tenant_id).bind(packet.id).bind(packet.appointment_id).bind(packet.patient_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(payload)).into_response())
}

fn empty_answer(value: Option<&Value>) -> bool {
    value.is_none_or(|value| {
        value.is_null()
            || value.as_str().is_some_and(|text| text.trim().is_empty())
            || value.as_bool() == Some(false)
    })
}
/// Whether a "show only when" rule is satisfied by the answers so far. A rule
/// that points at a question the patient was not shown is never satisfied.
fn condition_met(
    rule: Option<&Value>,
    answers: &serde_json::Map<String, Value>,
    shown: &HashSet<&str>,
) -> bool {
    let Some(rule) = rule.filter(|rule| !rule.is_null()) else {
        return true;
    };
    let Some(key) = rule.get("key").and_then(Value::as_str) else {
        return true;
    };
    if !shown.contains(key) {
        return false;
    }
    let answer = answers.get(key);
    if let Some(expected) = rule.get("equals") {
        return answer == Some(expected);
    }
    rule.get("any_of")
        .and_then(Value::as_array)
        .is_some_and(|list| answer.is_some_and(|answer| list.contains(answer)))
}
fn format_ok(format: &str, text: &str) -> bool {
    match format {
        "phone" => {
            text.chars().count() <= 40
                && text.chars().filter(char::is_ascii_digit).count() >= 7
                && text
                    .chars()
                    .all(|c| c.is_ascii_digit() || "+()- .xX#".contains(c))
        }
        "email" => {
            let mut parts = text.split('@');
            let local = parts.next().unwrap_or("");
            let domain = parts.next().unwrap_or("");
            text.chars().count() <= 254
                && !local.is_empty()
                && parts.next().is_none()
                && !text.chars().any(char::is_whitespace)
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        }
        "zip" => {
            let bytes = text.as_bytes();
            [5, 10].contains(&bytes.len())
                && bytes.iter().enumerate().all(|(index, byte)| {
                    if index == 5 {
                        *byte == b'-'
                    } else {
                        byte.is_ascii_digit()
                    }
                })
        }
        "past_date" => NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok_and(|date| {
            date <= Utc::now().date_naive() + Duration::days(1)
                && date >= NaiveDate::from_ymd_opt(1900, 1, 1).expect("valid lower bound")
        }),
        _ => true,
    }
}
/// Checks answers against the issued form and returns what is kept.
///
/// Every answer must belong to the form and match its question's type and
/// size. When `complete`, a question is required only if it and its section
/// were shown to the patient, a skippable section left blank asks for nothing,
/// and answers to questions the patient was not shown are dropped. A draft
/// (`complete` false) is kept as sent so the patient can pick it up later.
fn validate_response(schema: &Value, response: &Value, complete: bool) -> Result<Value> {
    let object = response
        .as_object()
        .ok_or(Error::Invalid("intake answers must be an object"))?;
    let mut allowed = HashSet::new();
    let mut shown: HashSet<&str> = HashSet::new();
    let mut kept = serde_json::Map::new();
    for section in schema
        .get("sections")
        .and_then(Value::as_array)
        .ok_or(Error::Invalid("invalid intake template"))?
    {
        let section_shown = condition_met(section.get("show_if"), object, &shown);
        let skippable = section.get("skippable").and_then(Value::as_bool) == Some(true);
        let mut missing = false;
        let mut answered = false;
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
            let visible = section_shown && condition_met(field.get("show_if"), object, &shown);
            if visible {
                shown.insert(key);
            }
            let value = object.get(key);
            if let Some(value) = value.filter(|value| !value.is_null()) {
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
                    let limit = if kind == "textarea" { 10_000 } else { 1000 };
                    let max = field
                        .get("max_length")
                        .and_then(Value::as_u64)
                        .map_or(limit, |own| limit.min(own as usize));
                    if text.chars().count() > max
                        || text.chars().any(|c| {
                            c.is_control()
                                && !(kind == "textarea" && ['\n', '\r', '\t'].contains(&c))
                        })
                    {
                        return Err(Error::Invalid("One of your answers is too long."));
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
                                "One of your answers is not valid. Please check it and try again.",
                            ));
                        }
                        if complete
                            && visible
                            && !text.trim().is_empty()
                            && field
                                .get("format")
                                .and_then(Value::as_str)
                                .is_some_and(|format| !format_ok(format, text.trim()))
                        {
                            return Err(Error::Invalid(
                                "Please check your phone numbers, email addresses, ZIP code and dates.",
                            ));
                        }
                    }
                }
            }
            if visible {
                if !empty_answer(value) {
                    answered = true;
                } else if field.get("required").and_then(Value::as_bool) == Some(true) {
                    missing = true;
                }
                if let Some(value) = value {
                    kept.insert(key.to_owned(), value.clone());
                }
            }
        }
        if complete && missing && (answered || !skippable) {
            return Err(Error::Invalid("Please answer every required question."));
        }
    }
    if object.len() > 100 || object.keys().any(|k| !allowed.contains(k.as_str())) {
        return Err(Error::Invalid(
            "These answers do not match this form. Please reload the page and try again.",
        ));
    }
    if serde_json::to_vec(response)
        .map_err(|_| Error::Invalid("invalid intake answers"))?
        .len()
        > 48 * 1024
    {
        return Err(Error::Invalid(
            "Your answers are too long to send. Please shorten them and try again.",
        ));
    }
    Ok(if complete {
        Value::Object(kept)
    } else {
        response.clone()
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DraftSave {
    token: String,
    answers: Value,
}
/// Keeps what the patient has entered so far so they can finish later, on any
/// device, with the same link. Nothing reaches the chart or the review list.
async fn public_save(
    ExtractState(state): ExtractState<State>,
    headers: HeaderMap,
    Json(input): Json<DraftSave>,
) -> PublicResult<Response> {
    let pool = db(&state)?;
    let client = admit_client(pool, &headers).await?;
    let token = clean(&input.token, 100)?;
    let mut tx = pool.begin().await?;
    let Some(found) = linked_packet(&mut tx, &token, false).await? else {
        return Err(link_closed(pool, &client).await);
    };
    admit_link(pool, found.id).await?;
    lock_packet_workflow(&mut tx, found.tenant_id, found.id).await?;
    let Some(packet) = linked_packet(&mut tx, &token, true)
        .await?
        .filter(LinkedPacket::open)
    else {
        return Err(link_closed(pool, &client).await);
    };
    if !["sent", "in_progress"].contains(&packet.status.as_str()) {
        return Err(Error::Conflict("This form was already sent to the practice.").into());
    }
    let draft = validate_response(&packet.template_snapshot, &input.answers, false)?;
    let saved_at: DateTime<Utc> = sqlx::query_scalar("UPDATE previsit_intake_packets SET status='in_progress',draft=$3,draft_saved_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING draft_saved_at")
        .bind(packet.tenant_id).bind(packet.id).bind(&draft).fetch_one(&mut *tx).await?;
    // Saving happens on every step; the history records it at most once every few minutes.
    sqlx::query("INSERT INTO previsit_events(tenant_id,packet_id,appointment_id,patient_id,actor_id,actor_kind,action) SELECT $1,$2,$3,$4,$4,'patient_guest','intake_saved' WHERE NOT EXISTS(SELECT 1 FROM previsit_events WHERE tenant_id=$1 AND packet_id=$2 AND action='intake_saved' AND created_at>now()-interval '5 minutes')")
        .bind(packet.tenant_id).bind(packet.id).bind(packet.appointment_id).bind(packet.patient_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"packet_id":packet.id,"status":"in_progress","saved_at":saved_at})),
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Lookup {
    token: String,
    kind: String,
    query: String,
}
/// Names a patient can pick from while filling in a form: the practice's own
/// insurance companies, insurers the practice has already looked up in its
/// clearinghouse directory, and the practice's pharmacies. Only a working link
/// can ask, only a name and a reference come back, and no outside service is
/// called.
async fn public_lookup(
    ExtractState(state): ExtractState<State>,
    headers: HeaderMap,
    Json(input): Json<Lookup>,
) -> PublicResult<Response> {
    let pool = db(&state)?;
    let client = admit_client(pool, &headers).await?;
    let token = clean(&input.token, 100)?;
    if !LOOKUPS.contains(&input.kind.as_str()) {
        return Err(Error::Invalid("unsupported list").into());
    }
    let mut tx = pool.begin().await?;
    let Some(packet) = linked_packet(&mut tx, &token, false)
        .await?
        .filter(LinkedPacket::readable)
    else {
        return Err(link_closed(pool, &client).await);
    };
    if count_try(pool, &format!("intake:lookup:{}", packet.id)).await? > LOOKUP_LIMIT {
        return Err(PublicError::Busy);
    }
    let query = input.query.trim();
    let length = query.chars().count();
    if length > 80 || query.chars().any(char::is_control) {
        return Err(Error::Invalid("Please type a shorter name.").into());
    }
    let tenant = packet.tenant_id;
    let mut items: Vec<(String, String)> = Vec::new();
    if length >= 2 && input.kind == "insurer" {
        items = sqlx::query_as("SELECT id::text,btrim(content->>'name') FROM ehr_payers WHERE tenant_id=$1 AND coalesce(content->>'active','true')='true' AND position(lower($2) in lower(content->>'name'))>0 ORDER BY position(lower($2) in lower(content->>'name')),lower(content->>'name'),id LIMIT 10")
            .bind(tenant).bind(query).fetch_all(&mut *tx).await?;
        // Insurers the practice has already found in its clearinghouse directory.
        let known: Vec<(String, String)> = sqlx::query_as("SELECT DISTINCT ON (lower(name)) 'claimmd:'||code,name FROM (SELECT btrim(p->>'payer_name') AS name,btrim(p->>'payerid') AS code FROM (SELECT response FROM claimmd_payer_directory_snapshots WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50) s CROSS JOIN LATERAL jsonb_array_elements(CASE jsonb_typeof(s.response->'payer') WHEN 'array' THEN s.response->'payer' WHEN 'object' THEN jsonb_build_array(s.response->'payer') ELSE '[]'::jsonb END) p) d WHERE code ~ '^[A-Za-z0-9_-]{1,40}$' AND length(name) BETWEEN 1 AND 200 AND position(lower($2) in lower(name))>0 ORDER BY lower(name),code LIMIT 10")
            .bind(tenant).bind(query).fetch_all(&mut *tx).await?;
        for (id, name) in known {
            if items.len() < 10
                && !items
                    .iter()
                    .any(|(_, have)| have.eq_ignore_ascii_case(&name))
            {
                items.push((id, name));
            }
        }
    } else if length >= 2 {
        items = sqlx::query_as("SELECT id::text,left(concat_ws(', ',btrim(content->>'name'),nullif(btrim(regexp_replace(content->>'address','[[:space:]]+',' ','g')),'')),300) FROM prescribing_pharmacies WHERE tenant_id=$1 AND active AND position(lower($2) in lower(concat_ws(' ',content->>'name',content->>'address')))>0 ORDER BY lower(content->>'name'),id LIMIT 10")
            .bind(tenant).bind(query).fetch_all(&mut *tx).await?;
    }
    tx.commit().await?;
    let items: Vec<Value> = items
        .into_iter()
        .map(|(id, name)| json!({"id":id,"name":name}))
        .collect();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"items":items})),
    )
        .into_response())
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
    headers: HeaderMap,
    Json(mut input): Json<Submission>,
) -> PublicResult<Response> {
    let pool = db(&state)?;
    let client = admit_client(pool, &headers).await?;
    input.token = clean(&input.token, 100)?;
    input.attested_name = clean(&input.attested_name, 200)?;
    if !input.attested {
        return Err(
            Error::Invalid("Please tick the box to confirm your answers before sending.").into(),
        );
    }
    let mut tx = pool.begin().await?;
    let Some(found) = linked_packet(&mut tx, &input.token, false).await? else {
        return Err(link_closed(pool, &client).await);
    };
    admit_link(pool, found.id).await?;
    lock_packet_workflow(&mut tx, found.tenant_id, found.id).await?;
    let Some(packet) = linked_packet(&mut tx, &input.token, true)
        .await?
        .filter(LinkedPacket::open)
    else {
        return Err(link_closed(pool, &client).await);
    };
    if packet.status == "reviewed" {
        return Err(Error::Conflict("The practice has already reviewed this form.").into());
    }
    let response = validate_response(&packet.template_snapshot, &input.response, true)?;
    let (tenant, id, next) = (packet.tenant_id, packet.id, packet.version + 1);
    sqlx::query("INSERT INTO previsit_intake_responses(tenant_id,packet_id,version,response,attested_name,attested) VALUES($1,$2,$3,$4,$5,true)").bind(tenant).bind(id).bind(next).bind(&response).bind(&input.attested_name).execute(&mut *tx).await?;
    sqlx::query("UPDATE previsit_intake_packets SET status='submitted',submitted_at=now(),draft=NULL,draft_saved_at=NULL,version=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(next).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO previsit_events(tenant_id,packet_id,appointment_id,patient_id,actor_id,actor_kind,action,details) VALUES($1,$2,$3,$4,$4,'patient_guest','intake_submitted',$5)").bind(tenant).bind(id).bind(packet.appointment_id).bind(packet.patient_id).bind(json!({"response_version":next,"attested":true})).execute(&mut *tx).await?;
    workflow_packet_evidence(
        &mut tx,
        tenant,
        id,
        packet.patient_id,
        "submitted",
        next,
        "Patient submitted the version-pinned intake packet",
    )
    .await?;
    tx.commit().await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"packet_id":id,"status":"submitted","version":next,"message":"Your information was received and is awaiting practice review."})),
    )
        .into_response())
}

async fn issue_packet(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(appointment): Path<Uuid>,
) -> Result<impl IntoResponse> {
    staff_write(&actor)?;
    let mut tx = db(&state)?.begin().await?;
    let found: Option<(Uuid, DateTime<Utc>)> = sqlx::query_as(
        "SELECT patient_id,starts_at FROM appointments WHERE tenant_id=$1 AND id=$2 FOR SHARE",
    )
    .bind(actor.tenant_id)
    .bind(appointment)
    .fetch_optional(&mut *tx)
    .await?;
    let (patient, due) = found.ok_or(Error::NotFound)?;
    if sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM previsit_intake_packets WHERE tenant_id=$1 AND appointment_id=$2 AND workflow_instance_id IS NULL AND status<>'void')").bind(actor.tenant_id).bind(appointment).fetch_one(&mut *tx).await?{return Err(Error::Conflict("an intake packet already exists for this appointment"));}
    let (packet, plain, expires) = issue_default(
        &mut tx,
        actor.tenant_id,
        Some(appointment),
        patient,
        actor.sub,
        Some(due),
        true,
    )
    .await?
    .ok_or(Error::Conflict(
        "the intake form could not be prepared; try again",
    ))?;
    crate::postgres::audit(&mut tx, &actor, "previsit.packet_issue", packet).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(
            json!({"packet_id":packet,"intake_url":format!("/intake#token={plain}"),"secret_shown_once":true,"expires_at":expires}),
        ),
    ))
}

async fn void_packet(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    packet: Uuid,
    appointment: Option<Uuid>,
    patient: Uuid,
    details: Value,
) -> Result<i64> {
    let next: i64 = sqlx::query_scalar("UPDATE previsit_intake_packets SET status='void',draft=NULL,draft_saved_at=NULL,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING version")
        .bind(actor.tenant_id).bind(packet).fetch_one(&mut **tx).await?;
    sqlx::query("INSERT INTO previsit_events(tenant_id,packet_id,appointment_id,patient_id,actor_id,actor_kind,action,details) VALUES($1,$2,$3,$4,$5,'staff','intake_packet_cancelled',$6)")
        .bind(actor.tenant_id).bind(packet).bind(appointment).bind(patient).bind(actor.sub).bind(details).execute(&mut **tx).await?;
    crate::postgres::audit(tx, actor, "previsit.packet_cancel", packet).await?;
    Ok(next)
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct SendForm {
    #[serde(default)]
    appointment_id: Option<Uuid>,
}
/// Sends the practice's intake form to a patient from the chart, with or
/// without an appointment. A form the patient has not sent in yet is cancelled
/// and replaced, so only the newest link works.
async fn send_patient_form(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(patient): Path<Uuid>,
    Json(input): Json<SendForm>,
) -> Result<Response> {
    staff_write(&actor)?;
    crate::access_policies::require_native(&state, &actor, "clinical", "view").await?;
    let mut tx = db(&state)?.begin().await?;
    // Holding the patient row keeps two staff from sending at the same moment.
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM patients WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(actor.tenant_id)
    .bind(patient)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    let visit: Option<DateTime<Utc>> = match input.appointment_id {
        None => None,
        Some(appointment) => Some(
            sqlx::query_scalar("SELECT starts_at FROM appointments WHERE tenant_id=$1 AND id=$2 AND patient_id=$3 FOR SHARE")
                .bind(actor.tenant_id).bind(appointment).bind(patient).fetch_optional(&mut *tx).await?
                .ok_or(Error::Invalid("That appointment does not belong to this patient."))?,
        ),
    };
    let open: Vec<(Uuid, Option<Uuid>)> = sqlx::query_as("SELECT id,appointment_id FROM previsit_intake_packets WHERE tenant_id=$1 AND patient_id=$2 AND workflow_instance_id IS NULL AND status IN('sent','in_progress') ORDER BY created_at FOR UPDATE")
        .bind(actor.tenant_id).bind(patient).fetch_all(&mut *tx).await?;
    for (old, old_appointment) in &open {
        void_packet(
            &mut tx,
            &actor,
            *old,
            *old_appointment,
            patient,
            json!({"reason":"Replaced by a new link","replaced":true}),
        )
        .await?;
    }
    if let Some(appointment) = input.appointment_id {
        if sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM previsit_intake_packets WHERE tenant_id=$1 AND appointment_id=$2 AND workflow_instance_id IS NULL AND status<>'void')").bind(actor.tenant_id).bind(appointment).fetch_one(&mut *tx).await? {
            return Err(Error::Conflict("This appointment already has a filled-in intake form."));
        }
    }
    let (packet, plain, expires) = issue_default(
        &mut tx,
        actor.tenant_id,
        input.appointment_id,
        patient,
        actor.sub,
        visit,
        true,
    )
    .await?
    .ok_or(Error::Conflict(
        "the intake form could not be prepared; try again",
    ))?;
    crate::postgres::audit(&mut tx, &actor, "previsit.packet_issue", packet).await?;
    // The same name the patient sees on the form, for the staff member's own email.
    let practice = practice_name(&mut tx, actor.tenant_id).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"packet_id":packet,"patient_id":patient,"intake_url":format!("/intake#token={plain}"),"secret_shown_once":true,"expires_at":expires,"replaced":open.len(),"practice_name":practice})),
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelForm {
    reason: String,
}
async fn cancel_packet(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(packet): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<CancelForm>,
) -> Result<Json<Value>> {
    staff_write(&actor)?;
    let expected = version(&headers)?;
    let reason = clean(&input.reason, 500)?;
    let mut tx = db(&state)?.begin().await?;
    type Row = (Option<Uuid>, Uuid, String, i64, Option<Uuid>);
    let row: Option<Row> = sqlx::query_as("SELECT appointment_id,patient_id,status,version,workflow_instance_id FROM previsit_intake_packets WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(actor.tenant_id).bind(packet).fetch_optional(&mut *tx).await?;
    let (appointment, patient, status, current, workflow) = row.ok_or(Error::NotFound)?;
    if workflow.is_some() {
        return Err(Error::Conflict(
            "This form belongs to a patient journey. Manage it from the journey.",
        ));
    }
    if current != expected {
        return Err(Error::Conflict("This form changed. Reload and try again."));
    }
    if !["sent", "in_progress"].contains(&status.as_str()) {
        return Err(Error::Conflict(
            "Only a form the patient has not sent in yet can be cancelled.",
        ));
    }
    let next = void_packet(
        &mut tx,
        &actor,
        packet,
        appointment,
        patient,
        json!({"reason":reason}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"packet_id":packet,"status":"void","version":next}),
    ))
}

async fn readiness(actor: Actor, ExtractState(state): ExtractState<State>) -> Result<Json<Value>> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    // The worklist is per appointment; a cancelled form leaves it ready for a new one.
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('packet_id',p.id,'packet_version',p.version,'status',coalesce(p.status,'not_issued'),'due_at',coalesce(p.due_at,a.starts_at),'submitted_at',p.submitted_at,'reviewed_at',p.reviewed_at,'appointment_id',a.id,'starts_at',a.starts_at,'patient_id',pt.id,'patient_name',pt.family_name||', '||pt.given_name,'mrn',pt.mrn,'template_snapshot',p.template_snapshot,'workflow_instance_id',p.workflow_instance_id,'workflow_step_key',p.workflow_step_key,'workflow_definition_version',p.workflow_definition_version,'response',(SELECT response FROM previsit_intake_responses r WHERE r.tenant_id=p.tenant_id AND r.packet_id=p.id ORDER BY version DESC LIMIT 1),'attested_name',(SELECT attested_name FROM previsit_intake_responses r WHERE r.tenant_id=p.tenant_id AND r.packet_id=p.id ORDER BY version DESC LIMIT 1)) FROM appointments a JOIN patients pt ON pt.tenant_id=a.tenant_id AND pt.id=a.patient_id LEFT JOIN previsit_intake_packets p ON p.tenant_id=a.tenant_id AND p.appointment_id=a.id AND p.status<>'void' WHERE a.tenant_id=$1 AND a.status='booked' AND a.starts_at>now()-interval '1 day' ORDER BY a.starts_at LIMIT 200").bind(actor.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "previsit.readiness_read", actor.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":rows})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PatientIntakePage {
    after: Option<Uuid>,
    limit: Option<i64>,
}
async fn patient_packets(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(patient): Path<Uuid>,
    Query(page): Query<PatientIntakePage>,
) -> Result<Response> {
    actor.staff()?;
    crate::access_policies::require_native(&state, &actor, "clinical", "view").await?;
    let limit = page.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(Error::Invalid(
            "intake page limit must be between 1 and 100",
        ));
    }
    let mut tx = db(&state)?.begin().await?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(actor.tenant_id)
            .bind(patient)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let cursor: Option<(DateTime<Utc>, Uuid)> = if let Some(after) = page.after {
        Some(sqlx::query_as("SELECT created_at,id FROM previsit_intake_packets WHERE tenant_id=$1 AND patient_id=$2 AND id=$3")
            .bind(actor.tenant_id).bind(patient).bind(after).fetch_optional(&mut *tx).await?.ok_or(Error::Invalid("intake page cursor does not belong to this patient"))?)
    } else {
        None
    };
    let counts: (i64,i64,i64) = sqlx::query_as("SELECT count(*),count(*) FILTER(WHERE status='submitted'),count(*) FILTER(WHERE status='reviewed') FROM previsit_intake_packets WHERE tenant_id=$1 AND patient_id=$2")
        .bind(actor.tenant_id).bind(patient).fetch_one(&mut *tx).await?;
    // A form sent from the chart may have no appointment.
    let mut rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('packet_id',p.id,'packet_version',p.version,'status',p.status,'created_at',p.created_at,'submitted_at',p.submitted_at,'reviewed_at',p.reviewed_at,'expires_at',p.expires_at,'expired',(p.expires_at IS NOT NULL AND p.expires_at<=now()),'started_at',p.draft_saved_at,'default_form',p.workflow_instance_id IS NULL,'appointment_id',p.appointment_id,'appointment_title',a.title,'appointment_status',a.status,'starts_at',a.starts_at,'workflow_step_key',p.workflow_step_key,'workflow_definition_version',p.workflow_definition_version,'template_name',coalesce(r.name,'Workflow intake form'),'has_response',EXISTS(SELECT 1 FROM previsit_intake_responses x WHERE x.tenant_id=p.tenant_id AND x.packet_id=p.id)) FROM previsit_intake_packets p LEFT JOIN appointments a ON a.tenant_id=p.tenant_id AND a.id=p.appointment_id AND a.patient_id=p.patient_id LEFT JOIN previsit_intake_template_revisions r ON r.tenant_id=p.tenant_id AND r.template_id=p.template_id AND r.version=p.template_version WHERE p.tenant_id=$1 AND p.patient_id=$2 AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3,$4)) ORDER BY p.created_at DESC,p.id DESC LIMIT $5")
        .bind(actor.tenant_id).bind(patient).bind(cursor.map(|c|c.0)).bind(cursor.map(|c|c.1)).bind(limit+1).fetch_all(&mut *tx).await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = if has_more {
        rows.last().map(|r| r["packet_id"].clone())
    } else {
        None
    };
    crate::postgres::audit(&mut tx, &actor, "previsit.patient_packets_read", patient).await?;
    tx.commit().await?;
    Ok(([(header::CACHE_CONTROL,"no-store")],Json(json!({"patient_id":patient,"items":rows,"next_cursor":next_cursor,"summary":{"total":counts.0,"submitted":counts.1,"reviewed":counts.2}}))).into_response())
}

async fn packet_detail(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(packet): Path<Uuid>,
) -> Result<Response> {
    actor.staff()?;
    crate::access_policies::require_native(&state, &actor, "clinical", "view").await?;
    let mut tx = db(&state)?.begin().await?;
    let value: Value = sqlx::query_scalar("SELECT jsonb_build_object('packet_id',p.id,'packet_version',p.version,'status',p.status,'due_at',p.due_at,'created_at',p.created_at,'expires_at',p.expires_at,'expired',(p.expires_at IS NOT NULL AND p.expires_at<=now()),'submitted_at',p.submitted_at,'reviewed_at',p.reviewed_at,'appointment_id',p.appointment_id,'starts_at',a.starts_at,'patient_id',p.patient_id,'patient_name',pt.family_name||', '||pt.given_name,'patient_identity',jsonb_build_object('given_name',pt.given_name,'family_name',pt.family_name,'birth_date',pt.birth_date),'mrn',pt.mrn,'template_snapshot',p.template_snapshot,'workflow_instance_id',p.workflow_instance_id,'workflow_step_key',p.workflow_step_key,'workflow_definition_version',p.workflow_definition_version,'response',(SELECT response FROM previsit_intake_responses r WHERE r.tenant_id=p.tenant_id AND r.packet_id=p.id ORDER BY version DESC LIMIT 1),'attested_name',(SELECT attested_name FROM previsit_intake_responses r WHERE r.tenant_id=p.tenant_id AND r.packet_id=p.id ORDER BY version DESC LIMIT 1)) FROM previsit_intake_packets p LEFT JOIN appointments a ON a.tenant_id=p.tenant_id AND a.id=p.appointment_id JOIN patients pt ON pt.tenant_id=p.tenant_id AND pt.id=p.patient_id WHERE p.tenant_id=$1 AND p.id=$2")
        .bind(actor.tenant_id).bind(packet).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    crate::postgres::audit(&mut tx, &actor, "previsit.packet_read", packet).await?;
    tx.commit().await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response())
}

/// Chart contact fields a reviewed answer may be copied into. Name and date of
/// birth are deliberately absent: identity is corrected only where identity is edited.
const DEMOGRAPHIC_TARGETS: &[&str] = &[
    "preferred_name",
    "pronouns",
    "language",
    "administrative_gender",
    "phone",
    "email",
    "address.line1",
    "address.line2",
    "address.city",
    "address.region",
    "address.postal_code",
    "emergency_contact.name",
    "emergency_contact.relationship",
    "emergency_contact.phone",
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
    type Row = (Uuid, Option<Uuid>, String, i64, Value, Option<Value>);
    let row: Option<Row> = sqlx::query_as("SELECT patient_id,appointment_id,status,version,template_snapshot,(SELECT response FROM previsit_intake_responses r WHERE r.tenant_id=p.tenant_id AND r.packet_id=p.id ORDER BY version DESC LIMIT 1) FROM previsit_intake_packets p WHERE tenant_id=$1 AND id=$2 FOR SHARE")
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
    if !content.is_object() {
        content = json!({});
    }
    let fields = schema["sections"]
        .as_array()
        .ok_or(Error::Invalid("invalid intake template"))?
        .iter()
        .flat_map(|section| section["fields"].as_array().into_iter().flatten())
        .collect::<Vec<_>>();
    let mut targets = HashSet::new();
    // Only the answers staff selected are copied; every other chart field,
    // including the rest of an address or emergency contact, is left as it is.
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
            .map(str::trim)
            .filter(|answer| !answer.is_empty())
            .ok_or(Error::Invalid(
                "select a nonempty text answer for this chart field",
            ))?;
        // "Other" stands for what the patient wrote in the box beside it.
        let written = field["other_key"]
            .as_str()
            .filter(|_| answer == "Other")
            .and_then(|other| response[other].as_str())
            .map(str::trim)
            .filter(|written| !written.is_empty());
        let answer = written.unwrap_or(answer);
        let answer = if target == "administrative_gender" {
            json!(answer.to_ascii_lowercase())
        } else {
            json!(answer)
        };
        match target.split_once('.') {
            None => content[target] = answer,
            Some((group, part)) => {
                if !content[group].is_object() {
                    content[group] = json!({});
                }
                content[group][part] = answer;
            }
        }
    }
    // The standard form asks for a United States address.
    if crate::previsit_standard::uses_standard(&schema)
        && targets.iter().any(|target| target.starts_with("address."))
        && content["address"]["country"]
            .as_str()
            .is_none_or(|country| country.trim().is_empty())
    {
        content["address"]["country"] = json!("US");
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
    let row:Option<(Option<Uuid>,Uuid,String,i64)>=sqlx::query_as("SELECT appointment_id,patient_id,status,version FROM previsit_intake_packets WHERE tenant_id=$1 AND id=$2 FOR UPDATE").bind(actor.tenant_id).bind(packet).fetch_optional(&mut *tx).await?;
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

#[cfg(test)]
mod standard_form_tests {
    use super::*;

    #[test]
    fn the_standard_form_is_a_valid_form_with_nine_steps_and_no_identity_numbers() {
        let form = crate::previsit_standard::preview();
        validate_schema(&form).expect("the standard form passes the rules for any intake form");
        let sections = form["sections"].as_array().unwrap();
        assert_eq!(sections.len(), 9);
        assert_eq!(form["standard_steps"], 9);
        let text = form.to_string().to_lowercase();
        for banned in ["social security", "ssn", "driver", "licence", "license"] {
            assert!(!text.contains(banned), "{banned}");
        }
        // Every chart mapping is either comparison-only identity or a supported contact field.
        for field in sections
            .iter()
            .flat_map(|section| section["fields"].as_array().unwrap())
        {
            if let Some(target) = field["chart_target"].as_str() {
                let supported = target
                    .strip_prefix("demographics.")
                    .is_some_and(|target| DEMOGRAPHIC_TARGETS.contains(&target));
                assert!(supported || target.starts_with("identity."), "{target}");
            }
        }
    }

    #[test]
    fn a_practice_without_insurance_answers_needs_no_insurance_steps() {
        let form = crate::previsit_standard::preview();
        let answers = json!({"first_name":"Synthetic","last_name":"Sample","date_of_birth":"1990-01-01","phone":"555-010-2026","address_line1":"1 Example Street","city":"Sampleville","state":"TX","zip":"75001","emergency_name":"Example Contact","emergency_relationship":"Friend","emergency_phone":"555-010-3030","responsible_party":"Myself","payment_method":"Self-pay","insurance_company":"Left over"});
        let kept = validate_response(&form, &answers, true).unwrap();
        assert!(kept.get("insurance_company").is_none());
        let mut insured = answers.clone();
        insured["payment_method"] = json!("Insurance");
        assert!(validate_response(&form, &insured, true).is_err());
        // A draft is kept exactly as typed and asks for nothing yet.
        let draft = json!({"first_name":"Synthetic","zip":"7"});
        assert_eq!(validate_response(&form, &draft, false).unwrap(), draft);
    }
}
