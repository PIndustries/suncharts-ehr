// SPDX-License-Identifier: AGPL-3.0-only
//! Consent-gated appointment reminders, attributed manual contact and fixed Resend delivery.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
use zeroize::Zeroizing;
const RESEND: &str = "https://api.resend.com";
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn owner(a: &Actor) -> Result<()> {
    if matches!(a.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
fn expected(h: &HeaderMap) -> Result<i64> {
    if h.get("if-match").is_some_and(|v| v == "\"0\"") {
        Ok(0)
    } else {
        crate::expected(h)
    }
}
fn email(v: &str) -> bool {
    v.len() <= 254
        && v.len() > 3
        && v.bytes()
            .all(|b| b.is_ascii_graphic() && !b"<>(),;:\\[]\"".contains(&b))
        && v.matches('@').count() == 1
        && v.rsplit_once('@').is_some_and(|(a, b)| {
            !a.is_empty() && b.contains('.') && !b.starts_with('.') && !b.ends_with('.')
        })
}
#[derive(sqlx::FromRow)]
struct Sender {
    id: Uuid,
    from_email: String,
    delivery_mode: String,
    credential_revision: i64,
    enabled: bool,
    verified: bool,
    last_test_at: Option<DateTime<Utc>>,
    last_test_result: Option<String>,
    version: i64,
}
impl Sender {
    fn public(&self) -> Value {
        json!({"id":self.id,"from_email":self.from_email,"enabled":self.enabled,"verified":self.verified,"last_test_at":self.last_test_at,"last_test_result":self.last_test_result,"version":self.version,"provider":self.delivery_mode,"delivery_mode":self.delivery_mode})
    }
}
#[derive(sqlx::FromRow)]
struct Preference {
    patient_id: Uuid,
    channel: String,
    destination: String,
    consented: bool,
    verified: bool,
    automatic_email: bool,
    version: i64,
}
impl Preference {
    fn content(&self) -> Value {
        json!({"channel":self.channel,"destination":self.destination,"consented":self.consented,"verified":self.verified,"automatic_email":self.automatic_email})
    }
}
#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct Reminder {
    pub id: Uuid,
    pub appointment_id: Uuid,
    pub patient_id: Uuid,
    request_id: Uuid,
    creation_hash: String,
    pub before_minutes: i32,
    pub due_at: DateTime<Utc>,
    pub starts_at: DateTime<Utc>,
    appointment_version: i64,
    preference_version: Option<i64>,
    pub channel: String,
    pub destination: Option<String>,
    pub automatic_email: bool,
    pub status: String,
    pub invalidated: bool,
    pub version: i64,
    pub attempts: i32,
    first_attempt_at: Option<DateTime<Utc>>,
    next_attempt_at: DateTime<Utc>,
    lease_id: Option<Uuid>,
    lease_until: Option<DateTime<Utc>>,
    sender_setting_id: Option<Uuid>,
    sender_revision: Option<i64>,
    from_email: Option<String>,
    pub provider_id: Option<Uuid>,
    pub last_result: Option<String>,
    last_poll_at: Option<DateTime<Utc>>,
}
impl Reminder {
    fn public(&self) -> Value {
        let actions = if self.status == "sending" {
            vec![]
        } else if self.provider_id.is_some() {
            vec!["refresh_delivery"]
        } else if self.first_attempt_at.is_some()
            && ["scheduled", "needs_review"].contains(&self.status.as_str())
        {
            if !self.invalidated
                && self
                    .first_attempt_at
                    .is_some_and(|t| t > Utc::now() - chrono::Duration::hours(23))
            {
                vec!["retry"]
            } else {
                vec![]
            }
        } else if ["scheduled", "needs_contact", "failed", "needs_review"]
            .contains(&self.status.as_str())
            && !self.invalidated
        {
            let mut a = vec![
                "cancel",
                "manual_contacted",
                "manual_no_answer",
                "manual_failed",
            ];
            if self.status == "failed" || self.status == "needs_review" {
                a.push("retry");
            }
            a
        } else {
            vec![]
        };
        json!({"id":self.id,"appointment_id":self.appointment_id,"patient_id":self.patient_id,"before_minutes":self.before_minutes,"due_at":self.due_at,"starts_at":self.starts_at,"channel":self.channel,"destination":self.destination,"automatic_email":self.automatic_email,"status":self.status,"invalidated":self.invalidated,"version":self.version,"attempts":self.attempts,"provider_id":self.provider_id,"last_result":self.last_result,"actions":actions})
    }
}
async fn reminder_lock(tx: &mut Transaction<'_, Postgres>, a: &Actor) -> Result<()> {
    crate::scheduling::tenant_lock(tx, a).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))")
        .bind(a.tenant_id.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn sender(tx: &mut Transaction<'_, Postgres>, tenant: Uuid) -> Result<Option<Sender>> {
    Ok(
        sqlx::query_as("SELECT * FROM reminder_sender_settings WHERE tenant_id=$1 FOR UPDATE")
            .bind(tenant)
            .fetch_optional(&mut **tx)
            .await?,
    )
}
async fn row(tx: &mut Transaction<'_, Postgres>, tenant: Uuid, id: Uuid) -> Result<Reminder> {
    sqlx::query_as("SELECT * FROM appointment_reminders WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(tenant)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn secret(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    id: Uuid,
    revision: i64,
) -> Result<crate::provider_settings::Secret> {
    Ok(credential(tx, tenant, id, revision).await?.0)
}
async fn credential(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    id: Uuid,
    revision: i64,
) -> Result<(crate::provider_settings::Secret, String, Option<Uuid>)> {
    let(mode,encrypted,connect_id,connect_revision):(String,Option<Vec<u8>>,Option<Uuid>,Option<i64>)=sqlx::query_as("SELECT delivery_mode,encrypted_key,connect_setting_id,connect_revision FROM reminder_credentials WHERE tenant_id=$1 AND setting_id=$2 AND revision=$3").bind(tenant).bind(id).bind(revision).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
    if mode == "suncharts_connect" {
        let (installation, key) = crate::connect_services::pinned(
            tx,
            tenant,
            connect_id.ok_or(Error::Invalid("missing service credential"))?,
            connect_revision.ok_or(Error::Invalid("missing service revision"))?,
        )
        .await?;
        Ok((key, mode, Some(installation)))
    } else {
        Ok((
            crate::provider_settings::open_secret(
                tenant,
                id,
                "reminder-resend",
                &encrypted.ok_or(Error::Invalid("missing sender credential"))?,
            )?,
            mode,
            None,
        ))
    }
}

async fn event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    action: &str,
    reason: &str,
) -> Result<()> {
    sqlx::query("UPDATE appointment_reminders SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).execute(&mut **tx).await?;
    sqlx::query("SELECT reminder_record_event($1,$2,$3,$4,$5)")
        .bind(a.tenant_id)
        .bind(id)
        .bind(a.sub)
        .bind(action)
        .bind(reason)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn sender_event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    action: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO reminder_sender_events(tenant_id,setting_id,version,actor_id,action) SELECT tenant_id,id,version,$3,$4 FROM reminder_sender_settings WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(a.sub).bind(action).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "appointment.reminder_sender_change", id).await
}
pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/schedule/reminder-settings",
            get(read_settings).put(save_settings),
        )
        .route(
            "/api/v1/schedule/reminder-settings/test",
            post(test_settings),
        )
        .route(
            "/api/v1/schedule/reminder-settings/activation",
            post(activate),
        )
        .route(
            "/api/v1/patients/{id}/reminder-preferences",
            get(read_preference).put(save_preference),
        )
        .route(
            "/api/v1/appointments/{id}/reminders",
            get(for_appointment).post(create),
        )
        .route("/api/v1/schedule/reminders", get(worklist))
        .route("/api/v1/schedule/reminders/{id}", get(detail))
        .route("/api/v1/schedule/reminders/{id}/actions", post(action))
}
async fn read_settings(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    let r = sender(&mut tx, a.tenant_id).await?;
    let ready = if let Some(r) = &r {
        secret(&mut tx, a.tenant_id, r.id, r.credential_revision)
            .await
            .is_ok()
    } else {
        true
    };
    crate::postgres::audit(&mut tx, &a, "appointment.reminder_sender_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"setting":r.map(|r|r.public()),"credential_storage_ready":ready,"automatic_email_provider":"suncharts_connect","sms_delivery_available":false}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SenderSave {
    api_key: Option<String>,
    from_email: Option<String>,
    delivery_mode: Option<String>,
}
async fn save_settings(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<SenderSave>,
) -> Result<Json<Value>> {
    owner(&a)?;
    let mode = v.delivery_mode.as_deref().unwrap_or("own_resend");
    if !["own_resend", "suncharts_connect"].contains(&mode) {
        return Err(Error::Invalid("invalid delivery mode"));
    }
    let mut tx = db(&s)?.begin().await?;
    reminder_lock(&mut tx, &a).await?;
    let old = sender(&mut tx, a.tenant_id).await?;
    if expected(&h)? != old.as_ref().map(|r| r.version).unwrap_or(0) {
        return Err(Error::Conflict("reminder sender settings changed"));
    }
    let id = old.as_ref().map(|r| r.id).unwrap_or_else(Uuid::new_v4);
    let revision = old.as_ref().map(|r| r.credential_revision + 1).unwrap_or(1);
    let (from, encrypted, connect_id, connect_revision) = if mode == "suncharts_connect" {
        let service = crate::connect_services::ready(&mut tx, a.tenant_id).await?;
        (
            service
                .from_email
                .ok_or(Error::Conflict("managed sender is not ready"))?,
            None,
            Some(service.id),
            Some(service.credential_revision),
        )
    } else {
        let from = v
            .from_email
            .as_deref()
            .ok_or(Error::Invalid("enter sender address"))?;
        if !email(from) {
            return Err(Error::Invalid(
                "enter a plain sender email address on a verified domain",
            ));
        }
        let key = if let Some(key) = v.api_key.filter(|v| !v.is_empty()) {
            Zeroizing::new(key)
        } else {
            let old = old
                .as_ref()
                .filter(|r| r.delivery_mode == "own_resend")
                .ok_or(Error::Invalid("enter your Resend API key"))?;
            Zeroizing::new(
                secret(&mut tx, a.tenant_id, id, old.credential_revision)
                    .await?
                    .expose()
                    .to_owned(),
            )
        };
        if !key.starts_with("re_")
            || !(12..=512).contains(&key.len())
            || !key.bytes().all(|v| v.is_ascii_graphic())
        {
            return Err(Error::Invalid("enter a valid Resend API key"));
        }
        (
            from.to_owned(),
            Some(
                crate::provider_settings::seal_secret(
                    db(&s)?,
                    a.tenant_id,
                    id,
                    "reminder-resend",
                    &key,
                )
                .await?,
            ),
            None,
            None,
        )
    };
    sqlx::query("INSERT INTO reminder_sender_settings(tenant_id,id,from_email,delivery_mode) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id) DO UPDATE SET from_email=$3,delivery_mode=$4,credential_revision=reminder_sender_settings.credential_revision+1,enabled=false,verified=false,last_test_at=NULL,last_test_result=NULL,version=reminder_sender_settings.version+1").bind(a.tenant_id).bind(id).bind(&from).bind(mode).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO reminder_credentials(tenant_id,setting_id,revision,encrypted_key,from_email,delivery_mode,connect_setting_id,connect_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(a.tenant_id).bind(id).bind(revision).bind(encrypted).bind(from).bind(mode).bind(connect_id).bind(connect_revision).execute(&mut *tx).await?;
    sender_event(&mut tx, &a, id, "sender_saved_disabled").await?;
    let r = sender(&mut tx, a.tenant_id).await?.ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(Json(r.public()))
}
async fn test_settings(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    reminder_lock(&mut tx, &a).await?;
    let r = sender(&mut tx, a.tenant_id).await?.ok_or(Error::NotFound)?;
    if crate::expected(&h)? != r.version {
        return Err(Error::Conflict("reminder sender settings changed"));
    }
    if r.last_test_at
        .is_some_and(|t| t > Utc::now() - chrono::Duration::seconds(30))
    {
        return Err(Error::Invalid("wait 30 seconds before another sender test"));
    }
    let key = secret(&mut tx, a.tenant_id, r.id, r.credential_revision).await?;
    let verified = if r.delivery_mode == "suncharts_connect" {
        crate::connect_services::ready(&mut tx, a.tenant_id)
            .await
            .is_ok()
    } else {
        verify_sender(key.expose(), &r.from_email)
            .await
            .unwrap_or(false)
    };
    sqlx::query("UPDATE reminder_sender_settings SET enabled=false,verified=$2,last_test_at=now(),last_test_result=$3,version=version+1 WHERE tenant_id=$1").bind(a.tenant_id).bind(verified).bind(if verified{"sender_domain_verified"}else{"sender_not_verified"}).execute(&mut *tx).await?;
    sender_event(&mut tx, &a, r.id, "sender_connection_tested").await?;
    let out = sender(&mut tx, a.tenant_id).await?.ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(Json(
        json!({"setting":out.public(),"authenticated":verified,"email_sent":false}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Activation {
    enabled: bool,
}
async fn activate(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<Activation>,
) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    reminder_lock(&mut tx, &a).await?;
    let r = sender(&mut tx, a.tenant_id).await?.ok_or(Error::NotFound)?;
    if crate::expected(&h)? != r.version {
        return Err(Error::Conflict("reminder sender settings changed"));
    }
    if v.enabled && !r.verified {
        return Err(Error::Invalid(
            "test the saved sender and verified domain first",
        ));
    }
    if v.enabled {
        secret(&mut tx, a.tenant_id, r.id, r.credential_revision).await?;
    }
    sqlx::query(
        "UPDATE reminder_sender_settings SET enabled=$2,version=version+1 WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .bind(v.enabled)
    .execute(&mut *tx)
    .await?;
    sender_event(
        &mut tx,
        &a,
        r.id,
        if v.enabled {
            "automatic_email_enabled"
        } else {
            "automatic_email_disabled"
        },
    )
    .await?;
    let r = sender(&mut tx, a.tenant_id).await?.ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(Json(r.public()))
}
async fn preference(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    id: Uuid,
) -> Result<Option<Preference>> {
    Ok(sqlx::query_as(
        "SELECT * FROM patient_reminder_preferences WHERE tenant_id=$1 AND patient_id=$2",
    )
    .bind(tenant)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?)
}
async fn read_preference(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let p = preference(&mut tx, a.tenant_id, id).await?;
    let history:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(h)-'tenant_id'-'patient_id' FROM patient_reminder_preference_history h WHERE tenant_id=$1 AND patient_id=$2 ORDER BY version DESC LIMIT 100").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "appointment.reminder_preference_read", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"patient_id":id,"version":p.as_ref().map(|r|r.version).unwrap_or(0),"content":p.map(|p|p.content()),"history":history}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreferenceSave {
    channel: String,
    destination: String,
    consented: bool,
    verified: bool,
    automatic_email: bool,
    reason: String,
}
async fn save_preference(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(mut v): Json<PreferenceSave>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    crate::model::text(&v.reason, 1000)?;
    if !["email", "phone"].contains(&v.channel.as_str())
        || v.destination.len() > 254
        || v.automatic_email && (v.channel != "email" || !v.consented || !v.verified)
    {
        return Err(Error::Invalid(
            "automatic email requires explicit verified email permission",
        ));
    }
    let mut tx = db(&s)?.begin().await?;
    reminder_lock(&mut tx, &a).await?;
    let current = preference(&mut tx, a.tenant_id, id).await?;
    if expected(&h)? != current.as_ref().map(|r| r.version).unwrap_or(0) {
        return Err(Error::Conflict("reminder preferences changed"));
    }
    let contact:Option<Value>=sqlx::query_scalar("SELECT coalesce(d.content,'{}'::jsonb) FROM patients p LEFT JOIN patient_demographics d ON d.tenant_id=p.tenant_id AND d.patient_id=p.id WHERE p.tenant_id=$1 AND p.id=$2").bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
    let contact = contact.ok_or(Error::NotFound)?;
    if v.consented || v.verified {
        let native = contact[&v.channel].as_str().ok_or(Error::Invalid(
            "save the patient's current native contact details first",
        ))?;
        if v.destination.trim() != native {
            return Err(Error::Invalid(
                "verified destination must exactly match the current native contact profile",
            ));
        }
        if v.channel == "email" && !email(native) {
            return Err(Error::Invalid("invalid native email destination"));
        }
        v.destination = native.to_owned();
    }
    sqlx::query("SELECT set_config('suncharts.reminder_actor',$1,true)")
        .bind(a.sub.to_string())
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO patient_reminder_preferences(tenant_id,patient_id,channel,destination,consented,verified,automatic_email,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,patient_id) DO UPDATE SET channel=$3,destination=$4,consented=$5,verified=$6,automatic_email=$7,reason=$8,version=patient_reminder_preferences.version+1").bind(a.tenant_id).bind(id).bind(v.channel).bind(v.destination).bind(v.consented).bind(v.verified).bind(v.automatic_email).bind(v.reason).execute(&mut *tx).await?;
    let p = preference(&mut tx, a.tenant_id, id)
        .await?
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(Json(
        json!({"patient_id":p.patient_id,"version":p.version,"content":p.content()}),
    ))
}
async fn appointment(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    id: Uuid,
) -> Result<(Uuid, i64, DateTime<Utc>, String)> {
    sqlx::query_as("SELECT patient_id,version,starts_at,status FROM appointments WHERE tenant_id=$1 AND id=$2 FOR UPDATE").bind(tenant).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn for_appointment(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let (p, version, _, _) = appointment(&mut tx, a.tenant_id, id).await?;
    let pref = preference(&mut tx, a.tenant_id, p).await?;
    let rows:Vec<Reminder>=sqlx::query_as("SELECT * FROM appointment_reminders WHERE tenant_id=$1 AND appointment_id=$2 ORDER BY created_at,id LIMIT 100").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "appointment.reminders_read", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":rows.iter().map(Reminder::public).collect::<Vec<_>>(),"preference":pref.map(|p|p.content()),"appointment_version":version}),
    ))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Create {
    request_id: Uuid,
    before_minutes: i32,
    reason: String,
}
async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Create>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    crate::model::text(&v.reason, 1000)?;
    if !(1..=525600).contains(&v.before_minutes) {
        return Err(Error::Invalid(
            "reminder offset must be between one minute and one year",
        ));
    }
    let hash = crate::oauth::hash(
        &json!({"appointment":id,"offset":v.before_minutes,"reason":v.reason}).to_string(),
    );
    let mut tx = db(&s)?.begin().await?;
    reminder_lock(&mut tx, &a).await?;
    let prior: Option<Reminder> =
        sqlx::query_as("SELECT * FROM appointment_reminders WHERE tenant_id=$1 AND request_id=$2")
            .bind(a.tenant_id)
            .bind(v.request_id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(r) = prior {
        if r.creation_hash != hash {
            return Err(Error::Conflict(
                "reminder request ID reused with changed content",
            ));
        }
        crate::postgres::audit(&mut tx, &a, "appointment.reminder_request_replayed", r.id).await?;
        tx.commit().await?;
        return Ok(Json(r.public()));
    }
    let (p, version, starts, status) = appointment(&mut tx, a.tenant_id, id).await?;
    if version != crate::expected(&h)? || status != "booked" || starts <= Utc::now() {
        return Err(Error::Conflict(
            "schedule reminders only for the current future booked appointment",
        ));
    }
    let pref = preference(&mut tx, a.tenant_id, p).await?;
    let valid = pref.as_ref().is_some_and(|p| p.consented && p.verified);
    let reminder = Uuid::new_v4();
    sqlx::query("INSERT INTO appointment_reminders(tenant_id,id,appointment_id,patient_id,request_id,creation_hash,definition_key,before_minutes,due_at,starts_at,appointment_version,preference_version,channel,destination,automatic_email,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)").bind(a.tenant_id).bind(reminder).bind(id).bind(p).bind(v.request_id).bind(hash).bind(format!("custom:{}",v.request_id)).bind(v.before_minutes).bind(starts-chrono::Duration::minutes(v.before_minutes.into())).bind(starts).bind(version).bind(pref.as_ref().map(|p|p.version)).bind(pref.as_ref().map(|p|p.channel.as_str()).unwrap_or("phone")).bind(pref.as_ref().filter(|_|valid).map(|p|p.destination.as_str())).bind(valid&&pref.as_ref().is_some_and(|p|p.automatic_email)).bind(if valid{"scheduled"}else{"needs_contact"}).execute(&mut *tx).await?;
    event(&mut tx, &a, reminder, "custom_scheduled", &v.reason).await?;
    let r = row(&mut tx, a.tenant_id, reminder).await?;
    tx.commit().await?;
    Ok(Json(r.public()))
}
#[derive(Deserialize)]
struct Worklist {
    state: Option<String>,
    after: Option<Uuid>,
}
async fn worklist(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<Worklist>,
) -> Result<Json<Value>> {
    a.staff()?;
    let state = q.state.unwrap_or_else(|| "due".into());
    let mut tx = db(&s)?.begin().await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT (to_jsonb(r)-'tenant_id'-'creation_hash'-'request_id'-'lease_id'-'lease_until'-'sender_revision')||jsonb_build_object('patient_name',p.family_name||', '||p.given_name,'mrn',p.mrn,'appointment_title',ap.title) FROM appointment_reminders r JOIN patients p ON p.tenant_id=r.tenant_id AND p.id=r.patient_id JOIN appointments ap ON ap.tenant_id=r.tenant_id AND ap.id=r.appointment_id WHERE r.tenant_id=$1 AND ($2='all' OR ($2='due' AND r.due_at<=now() AND r.starts_at>now() AND ap.status='booked' AND NOT r.invalidated AND r.status IN ('scheduled','needs_contact','failed','needs_review')) OR r.status=$2) AND ($3::uuid IS NULL OR (r.due_at,r.id)>(SELECT prior.due_at,prior.id FROM appointment_reminders prior WHERE prior.tenant_id=$1 AND prior.id=$3)) ORDER BY r.due_at,r.id LIMIT 101").bind(a.tenant_id).bind(state).bind(q.after).fetch_all(&mut *tx).await?;
    let mut rows = rows;
    for value in &mut rows {
        let reminder_id = serde_json::from_value::<Uuid>(value["id"].clone())
            .map_err(|_| Error::Invalid("invalid reminder identity"))?;
        let r: Reminder =
            sqlx::query_as("SELECT * FROM appointment_reminders WHERE tenant_id=$1 AND id=$2")
                .bind(a.tenant_id)
                .bind(reminder_id)
                .fetch_one(&mut *tx)
                .await?;
        value["actions"] = r.public()["actions"].clone();
    }
    let next = if rows.len() > 100 {
        rows.truncate(100);
        rows.last()
            .and_then(|r| r["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    crate::postgres::audit(&mut tx, &a, "appointment.reminder_worklist", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":rows,"next_cursor":next,"server_now":Utc::now()}),
    ))
}
async fn detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let r = row(&mut tx, a.tenant_id, id).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id'-'reminder_id' FROM appointment_reminder_events e WHERE tenant_id=$1 AND reminder_id=$2 ORDER BY version DESC LIMIT 100").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "appointment.reminder_read", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"reminder":r.public(),"events":events})))
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
    Json(v): Json<Action>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    crate::model::text(&v.reason, 1000)?;
    let mut tx = db(&s)?.begin().await?;
    reminder_lock(&mut tx, &a).await?;
    let r = row(&mut tx, a.tenant_id, id).await?;
    if crate::expected(&h)? != r.version {
        return Err(Error::Conflict(
            "reminder changed; reload before recording an outcome",
        ));
    }
    let allowed = r.public()["actions"]
        .as_array()
        .is_some_and(|items| items.iter().any(|s| s == &v.action));
    if !allowed {
        return Err(Error::Conflict("this reminder no longer allows that action; an accepted email cannot be cancelled or claimed as manual contact"));
    }
    if v.action == "retry" {
        if r.first_attempt_at
            .is_some_and(|t| t < Utc::now() - chrono::Duration::hours(23))
        {
            return Err(Error::Conflict("uncertain send is too old to retry safely; reconcile the original provider request"));
        }
        sqlx::query("UPDATE appointment_reminders SET status='scheduled',next_attempt_at=now(),last_result='staff_requested_retry' WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
    } else if v.action == "refresh_delivery" {
        sqlx::query(
            "UPDATE appointment_reminders SET last_poll_at=NULL WHERE tenant_id=$1 AND id=$2",
        )
        .bind(a.tenant_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    } else {
        let status = if v.action == "cancel" {
            "cancelled"
        } else {
            v.action.as_str()
        };
        sqlx::query("UPDATE appointment_reminders SET status=$3,last_result='attributed_staff_outcome' WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(status).execute(&mut *tx).await?;
    }
    event(&mut tx, &a, id, &v.action, &v.reason).await?;
    let out = row(&mut tx, a.tenant_id, id).await?;
    tx.commit().await?;
    Ok(Json(out.public()))
}

pub enum SendResult {
    Accepted(Uuid),
    Rejected(u16),
    Uncertain,
}
pub enum DeliveryResult {
    Delivered,
    Failed,
    Pending,
}
#[async_trait::async_trait]
pub trait EmailTransport: Send + Sync {
    async fn send(&self, key: &str, message: &Value, idempotency: &str) -> SendResult;
    async fn delivery(&self, key: &str, id: Uuid, to: &str, from: &str) -> Result<DeliveryResult>;
}
pub struct Resend;
async fn send_at(base: &str, key: &str, message: &Value, idempotency: &str) -> SendResult {
    let Ok(client) = crate::stedi::client() else {
        return SendResult::Uncertain;
    };
    let response = client
        .post(format!("{base}/emails"))
        .bearer_auth(key)
        .header("Idempotency-Key", idempotency)
        .json(message)
        .send()
        .await;
    let Ok(response) = response else {
        return SendResult::Uncertain;
    };
    let status = response.status();
    if !status.is_success() {
        return if status.is_client_error() {
            SendResult::Rejected(status.as_u16())
        } else {
            SendResult::Uncertain
        };
    }
    let Ok(bytes) = crate::stedi::bytes(response, 65536).await else {
        return SendResult::Uncertain;
    };
    let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
        return SendResult::Uncertain;
    };
    match v["id"].as_str().and_then(|id| Uuid::parse_str(id).ok()) {
        Some(id) => SendResult::Accepted(id),
        None => SendResult::Uncertain,
    }
}
#[async_trait::async_trait]
impl EmailTransport for Resend {
    async fn send(&self, key: &str, message: &Value, idempotency: &str) -> SendResult {
        send_at(RESEND, key, message, idempotency).await
    }
    async fn delivery(&self, key: &str, id: Uuid, to: &str, from: &str) -> Result<DeliveryResult> {
        delivery_at(RESEND, key, id, to, from).await
    }
}
async fn delivery_at(
    base: &str,
    key: &str,
    id: Uuid,
    to: &str,
    from: &str,
) -> Result<DeliveryResult> {
    let response = crate::stedi::client()?
        .get(format!("{base}/emails/{id}"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| Error::Invalid("email delivery lookup unavailable"))?;
    if !response.status().is_success() {
        return Err(Error::Invalid("email delivery lookup unavailable"));
    }
    let bytes = crate::stedi::bytes(response, 65536).await?;
    let v: Value =
        serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("invalid delivery evidence"))?;
    if v["id"] != id.to_string()
        || v["object"] != "email"
        || v["to"] != json!([to])
        || v["from"] != from
    {
        return Err(Error::Invalid(
            "email delivery evidence does not match the saved recipient and sender",
        ));
    }
    Ok(match v["last_event"].as_str() {
        Some("delivered" | "opened" | "clicked") => DeliveryResult::Delivered,
        Some("bounced" | "failed" | "complained" | "suppressed") => DeliveryResult::Failed,
        _ => DeliveryResult::Pending,
    })
}
struct ModeTransport {
    mode: String,
    installation: Option<Uuid>,
}
#[async_trait::async_trait]
impl EmailTransport for ModeTransport {
    async fn send(&self, key: &str, message: &Value, idempotency: &str) -> SendResult {
        if self.mode == "suncharts_connect" {
            if let Some(installation) = self.installation {
                crate::connect_services::managed_send(installation, key, message, idempotency).await
            } else {
                SendResult::Uncertain
            }
        } else {
            Resend.send(key, message, idempotency).await
        }
    }
    async fn delivery(&self, key: &str, id: Uuid, to: &str, from: &str) -> Result<DeliveryResult> {
        if self.mode == "suncharts_connect" {
            crate::connect_services::managed_delivery(
                self.installation
                    .ok_or(Error::Invalid("installation evidence missing"))?,
                key,
                id,
            )
            .await
        } else {
            Resend.delivery(key, id, to, from).await
        }
    }
}
async fn verify_sender(key: &str, from: &str) -> Result<bool> {
    verify_sender_at(RESEND, key, from).await
}
async fn verify_sender_at(base: &str, key: &str, from: &str) -> Result<bool> {
    let response = crate::stedi::client()?
        .get(format!("{base}/domains"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| Error::Invalid("sender verification unavailable"))?;
    if !response.status().is_success() {
        return Ok(false);
    }
    let bytes = crate::stedi::bytes(response, 65536).await?;
    let v: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Error::Invalid("unsupported sender verification response"))?;
    let domain = from.rsplit('@').next().unwrap_or("");
    Ok(v["data"].as_array().is_some_and(|rows| {
        rows.iter().any(|v| {
            v["name"]
                .as_str()
                .is_some_and(|v| v.eq_ignore_ascii_case(domain))
                && v["status"] == "verified"
        })
    }))
}
fn worker(tenant: Uuid) -> Actor {
    let mut a = crate::delivery::worker(tenant);
    a.sub = Uuid::from_u128(0x53c40000000040008000000000000017);
    a.iss = "suncharts-reminder-worker".into();
    a
}
fn message(r: &Reminder) -> Value {
    json!({"from":r.from_email,"to":[r.destination],"subject":"Appointment reminder","text":format!("You have an upcoming appointment on {} UTC. Please contact your clinic if your plans have changed.",r.starts_at.format("%A, %B %d, %Y at %H:%M"))})
}
async fn current_permission(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    r: &Reminder,
) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM appointments a JOIN patient_reminder_preferences p ON p.tenant_id=a.tenant_id AND p.patient_id=a.patient_id JOIN patient_demographics d ON d.tenant_id=p.tenant_id AND d.patient_id=p.patient_id WHERE a.tenant_id=$1 AND a.id=$2 AND a.status='booked' AND a.starts_at=$3 AND a.starts_at>now() AND p.version=$4 AND p.channel='email' AND p.destination=$5 AND p.consented AND p.verified AND p.automatic_email AND d.content->>'email'=p.destination)").bind(tenant).bind(r.appointment_id).bind(r.starts_at).bind(r.preference_version).bind(&r.destination).fetch_one(&mut **tx).await?)
}
pub async fn process_one(pool: &PgPool) -> Result<bool> {
    process_one_inner(pool, None).await
}
pub async fn process_one_with_transport(
    pool: &PgPool,
    transport: &dyn EmailTransport,
) -> Result<bool> {
    process_one_inner(pool, Some(transport)).await
}
async fn process_one_inner(
    pool: &PgPool,
    override_transport: Option<&dyn EmailTransport>,
) -> Result<bool> {
    let candidate:Option<(Uuid,Uuid)>=sqlx::query_as("SELECT r.tenant_id,r.id FROM appointment_reminders r JOIN reminder_sender_settings s ON s.tenant_id=r.tenant_id WHERE ((s.enabled AND s.verified AND ((r.status='scheduled' AND r.automatic_email AND NOT r.invalidated AND r.due_at<=now() AND r.next_attempt_at<=now()) OR (r.status='sending' AND r.lease_until<now()))) OR (r.provider_id IS NOT NULL AND r.status IN ('accepted','needs_review') AND (r.last_poll_at IS NULL OR r.last_poll_at<now()-interval '60 seconds'))) ORDER BY CASE WHEN r.provider_id IS NULL THEN 0 ELSE 1 END,r.last_poll_at NULLS FIRST,r.due_at,r.id LIMIT 1").fetch_optional(pool).await?;
    let Some((tenant, id)) = candidate else {
        return Ok(false);
    };
    let a = worker(tenant);
    let mut tx = pool.begin().await?;
    reminder_lock(&mut tx, &a).await?;
    let mut r = row(&mut tx, tenant, id).await?;
    let settings = sender(&mut tx, tenant).await?.ok_or(Error::NotFound)?;
    // Eligibility and the durable lease timestamps share the database clock;
    // application/DB clock skew must not reject a row SQL just selected as due.
    let database_now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    if let Some(provider_id) = r.provider_id {
        if !["accepted", "needs_review"].contains(&r.status.as_str())
            || r.last_poll_at
                .is_some_and(|p| p > database_now - chrono::Duration::seconds(60))
        {
            return Ok(false);
        }
        let (key, mode, installation) = credential(
            &mut tx,
            tenant,
            r.sender_setting_id
                .ok_or(Error::Invalid("sender evidence missing"))?,
            r.sender_revision
                .ok_or(Error::Invalid("sender evidence missing"))?,
        )
        .await?;
        let native = ModeTransport { mode, installation };
        let transport = override_transport.unwrap_or(&native);
        let result = transport
            .delivery(
                key.expose(),
                provider_id,
                r.destination.as_deref().unwrap_or(""),
                r.from_email.as_deref().unwrap_or(""),
            )
            .await;
        let (status, note) = match result {
            Ok(DeliveryResult::Delivered) => ("delivered", "provider_confirmed_delivery"),
            Ok(DeliveryResult::Failed) => ("failed", "provider_confirmed_failure"),
            _ => (r.status.as_str(), "provider_delivery_not_yet_confirmed"),
        };
        sqlx::query("UPDATE appointment_reminders SET status=$3,last_result=$4,last_poll_at=now() WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(status).bind(note).execute(&mut *tx).await?;
        event(
            &mut tx,
            &a,
            id,
            "provider_delivery_checked",
            "Provider delivery evidence inspected without resending",
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    if r.status == "sending" && r.lease_until.is_some_and(|t| t > database_now) {
        return Ok(false);
    }
    if r.status == "sending" && r.invalidated {
        sqlx::query("UPDATE appointment_reminders SET status='needs_review',last_result='invalidated_send_receipt_unknown',lease_id=NULL,lease_until=NULL WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).execute(&mut *tx).await?;
        event(&mut tx,&a,id,"dispatch_held","Expired send lease was invalidated; reconcile possible provider acceptance before further contact").await?;
        tx.commit().await?;
        return Ok(true);
    }
    if !["scheduled", "sending"].contains(&r.status.as_str())
        || r.invalidated
        || !settings.enabled
        || !settings.verified
    {
        return Ok(false);
    }
    if r.status == "scheduled" && (r.due_at > database_now || r.next_attempt_at > database_now) {
        return Ok(false);
    }
    if !current_permission(&mut tx, tenant, &r).await? {
        sqlx::query("UPDATE appointment_reminders SET status=CASE WHEN first_attempt_at IS NULL THEN 'cancelled' ELSE 'needs_review' END,invalidated=true,last_result='permission_or_appointment_changed' WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).execute(&mut *tx).await?;
        event(
            &mut tx,
            &a,
            id,
            "dispatch_suppressed",
            "Current permission, native destination or appointment no longer matches",
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    if r.first_attempt_at
        .is_some_and(|t| t < database_now - chrono::Duration::hours(23))
    {
        sqlx::query("UPDATE appointment_reminders SET status='needs_review',last_result='idempotency_window_expired' WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).execute(&mut *tx).await?;
        event(
            &mut tx,
            &a,
            id,
            "dispatch_held",
            "Original uncertain request is too old for a safe retry",
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    if settings.delivery_mode == "suncharts_connect" {
        let service = crate::connect_services::ready(&mut tx, tenant).await;
        let binding:Option<(Uuid,i64)>=sqlx::query_as("SELECT connect_setting_id,connect_revision FROM reminder_credentials WHERE tenant_id=$1 AND setting_id=$2 AND revision=$3").bind(tenant).bind(settings.id).bind(settings.credential_revision).fetch_optional(&mut *tx).await?;
        if !service.is_ok_and(|service| binding == Some((service.id, service.credential_revision)))
        {
            sqlx::query("UPDATE appointment_reminders SET status='needs_review',last_result='managed_service_unavailable_or_changed' WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).execute(&mut *tx).await?;
            event(
                &mut tx,
                &a,
                id,
                "dispatch_held",
                "Managed service is unavailable or its installation credentials changed",
            )
            .await?;
            tx.commit().await?;
            return Ok(true);
        }
    }
    if r.sender_setting_id.is_some()
        && (r.sender_setting_id != Some(settings.id)
            || r.sender_revision != Some(settings.credential_revision))
    {
        sqlx::query("UPDATE appointment_reminders SET status='needs_review',last_result='sender_configuration_changed' WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).execute(&mut *tx).await?;
        event(
            &mut tx,
            &a,
            id,
            "dispatch_held",
            "Sender changed after the durable request was prepared",
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    let lease = Uuid::new_v4();
    sqlx::query("UPDATE appointment_reminders SET status='sending',lease_id=$3,lease_until=now()+interval '60 seconds',first_attempt_at=coalesce(first_attempt_at,now()),sender_setting_id=coalesce(sender_setting_id,$4),sender_revision=coalesce(sender_revision,$5),from_email=coalesce(from_email,$6),attempts=attempts+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(lease).bind(settings.id).bind(settings.credential_revision).bind(&settings.from_email).execute(&mut *tx).await?;
    event(
        &mut tx,
        &a,
        id,
        "dispatch_claimed",
        "Durable idempotent send reserved before provider I/O",
    )
    .await?;
    tx.commit().await?;
    // The schedule lock serializes preference/appointment changes with the actual bounded send.
    let mut tx = pool.begin().await?;
    reminder_lock(&mut tx, &a).await?;
    r = row(&mut tx, tenant, id).await?;
    let s = sender(&mut tx, tenant).await?.ok_or(Error::NotFound)?;
    if r.lease_id != Some(lease) || r.status != "sending" {
        return Ok(false);
    }
    let service_ready = if s.delivery_mode == "suncharts_connect" {
        let service = crate::connect_services::ready(&mut tx, tenant).await;
        let binding:Option<(Uuid,i64)>=sqlx::query_as("SELECT connect_setting_id,connect_revision FROM reminder_credentials WHERE tenant_id=$1 AND setting_id=$2 AND revision=$3").bind(tenant).bind(s.id).bind(s.credential_revision).fetch_optional(&mut *tx).await?;
        service.is_ok_and(|service| binding == Some((service.id, service.credential_revision)))
    } else {
        true
    };
    if r.invalidated
        || !service_ready
        || !s.enabled
        || !s.verified
        || s.credential_revision != r.sender_revision.unwrap_or(0)
        || !current_permission(&mut tx, tenant, &r).await?
    {
        sqlx::query("UPDATE appointment_reminders SET status=CASE WHEN attempts<=1 THEN 'cancelled' ELSE 'needs_review' END,invalidated=true,last_result='dispatch_invalidated_before_send',lease_id=NULL,lease_until=NULL WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).execute(&mut *tx).await?;
        event(
            &mut tx,
            &a,
            id,
            "dispatch_suppressed",
            "Permission or appointment changed before provider request",
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    let (key, mode, installation) =
        credential(&mut tx, tenant, settings.id, settings.credential_revision).await?;
    let native = ModeTransport {
        mode: mode.clone(),
        installation,
    };
    let transport = override_transport.unwrap_or(&native);
    let mut payload = message(&r);
    if mode == "suncharts_connect" {
        payload["starts_at"] = json!(r.starts_at);
    }
    let result = transport
        .send(
            key.expose(),
            &payload,
            &format!("suncharts-reminder-{}", r.id),
        )
        .await;
    let (status, note, provider) = match result {
        SendResult::Accepted(id) => ("accepted", "provider_accepted_not_delivered", Some(id)),
        SendResult::Rejected(429) if r.attempts < 5 => {
            ("scheduled", "rate_limited_retry_pending", None)
        }
        // A rejection of a retry does not prove an earlier uncertain request
        // was rejected. Preserve that unresolved acceptance history.
        SendResult::Rejected(_) if r.attempts > 1 => (
            "needs_review",
            "retry_rejected_prior_acceptance_unknown",
            None,
        ),
        SendResult::Rejected(_) => ("failed", "provider_rejected_request", None),
        SendResult::Uncertain if r.attempts < 5 => {
            ("scheduled", "uncertain_idempotent_retry_pending", None)
        }
        SendResult::Uncertain => ("needs_review", "uncertain_send_held", None),
    };
    sqlx::query("UPDATE appointment_reminders SET status=$3,last_result=$4,provider_id=$5,next_attempt_at=now()+make_interval(secs=>$6),lease_id=NULL,lease_until=NULL WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(status).bind(note).bind(provider).bind((60i64*2i64.pow(r.attempts.min(6)as u32))as f64).execute(&mut *tx).await?;
    event(
        &mut tx,
        &a,
        id,
        "provider_send_result",
        "Provider acceptance is separate from confirmed delivery",
    )
    .await?;
    tx.commit().await?;
    Ok(true)
}
pub async fn run(pool: PgPool) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(2));
    loop {
        tick.tick().await;
        if process_one(&pool).await.is_err() {
            eprintln!("Appointment reminder processing unavailable; durable request retained");
        }
    }
}
#[cfg(test)]
mod adapter_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn endpoint(status: u16, response: Value) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut part = [0; 4096];
                let n = stream.read(&mut part).await.unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&part[..n]);
                if let Some(index) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..index]);
                    let length = header
                        .lines()
                        .find_map(|v| {
                            v.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|x| x.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= index + 4 + length {
                        break;
                    }
                }
            }
            let body = response.to_string();
            stream.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            String::from_utf8(bytes).unwrap()
        });
        (base, task)
    }
    #[tokio::test]
    async fn sender_verification_requires_authenticated_matching_verified_domain() {
        for (status, payload, expected) in [
            (
                200,
                json!({"data":[{"name":"example.test","status":"verified"}]}),
                true,
            ),
            (
                200,
                json!({"data":[{"name":"example.test","status":"pending"}]}),
                false,
            ),
            (
                200,
                json!({"data":[{"name":"other.test","status":"verified"}]}),
                false,
            ),
            (401, json!({"message":"synthetic invalid key"}), false),
        ] {
            let (base, task) = endpoint(status, payload).await;
            assert_eq!(
                verify_sender_at(&base, "re_synthetic", "reminders@example.test")
                    .await
                    .unwrap(),
                expected
            );
            let request = task.await.unwrap();
            assert!(request.starts_with("GET /domains "));
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer re_synthetic"));
        }
    }
    #[tokio::test]
    async fn fixed_adapter_http_contract_and_evidence_validation() {
        let id = Uuid::new_v4();
        let payload = json!({"from":"reminders@example.test","to":["synthetic@example.test"],"subject":"Appointment reminder","text":"Synthetic appointment time"});
        let (base, task) = endpoint(200, json!({"id":id})).await;
        assert!(
            matches!(send_at(&base,"re_synthetic",&payload,"stable-reminder-request").await,SendResult::Accepted(v) if v==id)
        );
        let request = task.await.unwrap();
        let lower = request.to_ascii_lowercase();
        assert!(request.starts_with("POST /emails "));
        assert!(lower.contains("authorization: bearer re_synthetic"));
        assert!(lower.contains("idempotency-key: stable-reminder-request"));
        assert!(request.contains("Synthetic appointment time"));
        for (code, result) in [(429, "rejected"), (503, "unknown"), (200, "unknown")] {
            let (base, task) = endpoint(code, json!({"message":"synthetic response"})).await;
            let actual = send_at(&base, "re_synthetic", &payload, "same-request").await;
            assert!(matches!(
                (&actual, result),
                (SendResult::Rejected(429), "rejected") | (SendResult::Uncertain, "unknown")
            ));
            task.await.unwrap();
        }
        for (event, expected) in [
            ("sent", "pending"),
            ("delivered", "delivered"),
            ("bounced", "failed"),
        ] {
            let(base,task)=endpoint(200,json!({"id":id,"object":"email","to":["synthetic@example.test"],"from":"reminders@example.test","last_event":event})).await;
            let result = delivery_at(
                &base,
                "re_synthetic",
                id,
                "synthetic@example.test",
                "reminders@example.test",
            )
            .await
            .unwrap();
            assert!(matches!(
                (result, expected),
                (DeliveryResult::Pending, "pending")
                    | (DeliveryResult::Delivered, "delivered")
                    | (DeliveryResult::Failed, "failed")
            ));
            assert!(task
                .await
                .unwrap()
                .starts_with(&format!("GET /emails/{id} ")));
        }
        let(base,task)=endpoint(200,json!({"id":id,"object":"email","to":["other@example.test"],"from":"reminders@example.test","last_event":"delivered"})).await;
        assert!(delivery_at(
            &base,
            "re_synthetic",
            id,
            "synthetic@example.test",
            "reminders@example.test"
        )
        .await
        .is_err());
        task.await.unwrap();
    }
}
