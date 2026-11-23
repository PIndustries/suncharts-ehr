// SPDX-License-Identifier: AGPL-3.0-only
//! Appointment reminders by text message or automated call through the practice's own Twilio
//! account. The practice saves its account, a sending number and its credential; the reminder
//! says the practice name and the appointment time, nothing clinical.
//!
//! Twilio gives no way to ask "did my earlier request arrive?", so a send whose outcome is not
//! known is never repeated by itself: it is held for a person to look at.
use super::*;
const TWILIO: &str = "https://api.twilio.com";
#[derive(sqlx::FromRow)]
struct PhoneSetting {
    id: Uuid,
    account_sid: String,
    from_number: String,
    credential_revision: i64,
    enabled: bool,
    verified: bool,
    last_test_at: Option<DateTime<Utc>>,
    last_test_result: Option<String>,
    version: i64,
}
impl PhoneSetting {
    fn public(&self) -> Value {
        json!({"id":self.id,"account_sid":self.account_sid,"from_number":self.from_number,"enabled":self.enabled,"verified":self.verified,"last_test_at":self.last_test_at,"last_test_result":self.last_test_result,"version":self.version})
    }
}
/// A phone number the way Twilio wants it. Ten digits are taken as a US number.
pub(super) fn e164(v: &str) -> Option<String> {
    let plus = v.trim().starts_with('+');
    if v.chars()
        .any(|c| !(c.is_ascii_digit() || " +-().".contains(c)))
    {
        return None;
    }
    let digits: String = v.chars().filter(char::is_ascii_digit).collect();
    match (plus, digits.len()) {
        (true, 8..=15) if !digits.starts_with('0') => Some(format!("+{digits}")),
        (false, 10) if !digits.starts_with(['0', '1']) => Some(format!("+1{digits}")),
        (false, 11) if digits.starts_with('1') => Some(format!("+{digits}")),
        _ => None,
    }
}
async fn setting(tx: &mut Transaction<'_, Postgres>, tenant: Uuid) -> Result<Option<PhoneSetting>> {
    Ok(
        sqlx::query_as("SELECT * FROM reminder_phone_settings WHERE tenant_id=$1 FOR UPDATE")
            .bind(tenant)
            .fetch_optional(&mut **tx)
            .await?,
    )
}
/// The saved credential at one revision, with the account and number it was saved with.
async fn token(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    id: Uuid,
    revision: i64,
) -> Result<(crate::provider_settings::Secret, String, String)> {
    let (encrypted, sid, from): (Vec<u8>, String, String) = sqlx::query_as("SELECT encrypted_key,account_sid,from_number FROM reminder_phone_credentials WHERE tenant_id=$1 AND setting_id=$2 AND revision=$3").bind(tenant).bind(id).bind(revision).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
    Ok((
        crate::provider_settings::open_secret(tenant, id, "reminder-twilio", &encrypted)?,
        sid,
        from,
    ))
}
async fn setting_event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    action: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO reminder_phone_events(tenant_id,setting_id,version,actor_id,action) SELECT tenant_id,id,version,$3,$4 FROM reminder_phone_settings WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(a.sub).bind(action).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "appointment.reminder_phone_change", id).await
}
pub(super) fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/schedule/reminder-phone-settings",
            get(read).put(save),
        )
        .route("/api/v1/schedule/reminder-phone-settings/test", post(test))
        .route(
            "/api/v1/schedule/reminder-phone-settings/activation",
            post(activate),
        )
}
async fn read(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    let r = setting(&mut tx, a.tenant_id).await?;
    let ready = if let Some(r) = &r {
        token(&mut tx, a.tenant_id, r.id, r.credential_revision)
            .await
            .is_ok()
    } else {
        true
    };
    crate::postgres::audit(&mut tx, &a, "appointment.reminder_phone_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"setting":r.map(|r|r.public()),"credential_storage_ready":ready}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PhoneSave {
    account_sid: String,
    from_number: String,
    auth_token: Option<String>,
}
async fn save(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<PhoneSave>,
) -> Result<Json<Value>> {
    owner(&a)?;
    let sid = v.account_sid.trim();
    if sid.len() != 34
        || !sid.starts_with("AC")
        || !sid[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::Invalid(
            "Enter the Account SID from your Twilio console. It starts with AC.",
        ));
    }
    let from = e164(&v.from_number).ok_or(Error::Invalid(
        "Enter your Twilio phone number with its area code.",
    ))?;
    let mut tx = db(&s)?.begin().await?;
    reminder_lock(&mut tx, &a).await?;
    let old = setting(&mut tx, a.tenant_id).await?;
    if expected(&h)? != old.as_ref().map(|r| r.version).unwrap_or(0) {
        return Err(Error::Conflict("reminder phone settings changed"));
    }
    let id = old.as_ref().map(|r| r.id).unwrap_or_else(Uuid::new_v4);
    let revision = old.as_ref().map(|r| r.credential_revision + 1).unwrap_or(1);
    let key = if let Some(key) = v.auth_token.filter(|v| !v.trim().is_empty()) {
        Zeroizing::new(key.trim().to_owned())
    } else {
        let old = old
            .as_ref()
            .ok_or(Error::Invalid("Enter your Twilio Auth Token."))?;
        Zeroizing::new(
            token(&mut tx, a.tenant_id, id, old.credential_revision)
                .await?
                .0
                .expose()
                .to_owned(),
        )
    };
    if !(16..=128).contains(&key.len()) || !key.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(Error::Invalid(
            "That does not look like a Twilio Auth Token. Copy it again from your Twilio console.",
        ));
    }
    let encrypted =
        crate::provider_settings::seal_secret(db(&s)?, a.tenant_id, id, "reminder-twilio", &key)
            .await?;
    sqlx::query("INSERT INTO reminder_phone_settings(tenant_id,id,account_sid,from_number) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id) DO UPDATE SET account_sid=$3,from_number=$4,credential_revision=reminder_phone_settings.credential_revision+1,enabled=false,verified=false,last_test_at=NULL,last_test_result=NULL,version=reminder_phone_settings.version+1").bind(a.tenant_id).bind(id).bind(sid).bind(&from).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO reminder_phone_credentials(tenant_id,setting_id,revision,encrypted_key,account_sid,from_number) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(revision).bind(encrypted).bind(sid).bind(&from).execute(&mut *tx).await?;
    setting_event(&mut tx, &a, id, "phone_saved_off").await?;
    let r = setting(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(Json(r.public()))
}
/// Checks the saved account with Twilio: the credential signs in, the account is active and the
/// sending number belongs to it. Nothing is sent to anyone.
async fn test(a: Actor, ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    reminder_lock(&mut tx, &a).await?;
    let r = setting(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::NotFound)?;
    if crate::expected(&h)? != r.version {
        return Err(Error::Conflict("reminder phone settings changed"));
    }
    if r.last_test_at
        .is_some_and(|t| t > Utc::now() - chrono::Duration::seconds(30))
    {
        return Err(Error::Invalid("Wait 30 seconds before checking again."));
    }
    let (key, sid, from) = token(&mut tx, a.tenant_id, r.id, r.credential_revision).await?;
    let found = verify_at(TWILIO, &sid, key.expose(), &from).await;
    let (verified, note) = match found {
        Ok(Check::Ready) => (true, "account_and_number_confirmed"),
        Ok(Check::NotSignedIn) => (false, "account_or_token_not_accepted"),
        Ok(Check::NumberNotOnAccount) => (false, "number_not_on_this_account"),
        Err(_) => (false, "twilio_could_not_be_reached"),
    };
    sqlx::query("UPDATE reminder_phone_settings SET enabled=false,verified=$2,last_test_at=now(),last_test_result=$3,version=version+1 WHERE tenant_id=$1").bind(a.tenant_id).bind(verified).bind(note).execute(&mut *tx).await?;
    setting_event(&mut tx, &a, r.id, "phone_connection_checked").await?;
    let out = setting(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(Json(json!({"setting":out.public(),"verified":verified})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PhoneActivation {
    enabled: bool,
}
async fn activate(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<PhoneActivation>,
) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    reminder_lock(&mut tx, &a).await?;
    let r = setting(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::NotFound)?;
    if crate::expected(&h)? != r.version {
        return Err(Error::Conflict("reminder phone settings changed"));
    }
    if v.enabled && !r.verified {
        return Err(Error::Invalid("Check the connection first."));
    }
    if v.enabled {
        token(&mut tx, a.tenant_id, r.id, r.credential_revision).await?;
    }
    sqlx::query(
        "UPDATE reminder_phone_settings SET enabled=$2,version=version+1 WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .bind(v.enabled)
    .execute(&mut *tx)
    .await?;
    setting_event(
        &mut tx,
        &a,
        r.id,
        if v.enabled {
            "phone_reminders_on"
        } else {
            "phone_reminders_off"
        },
    )
    .await?;
    let r = setting(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(Json(r.public()))
}
#[derive(Debug, PartialEq)]
enum Check {
    Ready,
    NotSignedIn,
    NumberNotOnAccount,
}
async fn twilio_get(base: &str, sid: &str, key: &str, path: &str) -> Result<(u16, Value)> {
    let response = crate::stedi::client()?
        .get(format!("{base}/2010-04-01/Accounts/{sid}{path}"))
        .basic_auth(sid, Some(key))
        .send()
        .await
        .map_err(|_| Error::Invalid("Twilio could not be reached"))?;
    let status = response.status().as_u16();
    let bytes = crate::stedi::bytes(response, 262_144).await?;
    Ok((
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    ))
}
async fn verify_at(base: &str, sid: &str, key: &str, from: &str) -> Result<Check> {
    let (status, account) = twilio_get(base, sid, key, ".json").await?;
    if status != 200 || account["sid"] != sid || account["status"] != "active" {
        return Ok(Check::NotSignedIn);
    }
    let (status, numbers) = twilio_get(
        base,
        sid,
        key,
        &format!(
            "/IncomingPhoneNumbers.json?PhoneNumber=%2B{}",
            from.trim_start_matches('+')
        ),
    )
    .await?;
    let owned = status == 200
        && numbers["incoming_phone_numbers"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|n| n["phone_number"] == from));
    Ok(if owned {
        Check::Ready
    } else {
        Check::NumberNotOnAccount
    })
}
pub enum PhoneSend {
    /// Twilio took the request; this is its own reference for the message or call.
    Accepted(String),
    /// Twilio refused it, with its error number when it gave one.
    Rejected(u16, Option<i64>),
    Uncertain,
}
#[async_trait::async_trait]
pub trait PhoneTransport: Send + Sync {
    async fn send(
        &self,
        sid: &str,
        key: &str,
        kind: &str,
        to: &str,
        from: &str,
        words: &str,
    ) -> PhoneSend;
    async fn status(
        &self,
        sid: &str,
        key: &str,
        kind: &str,
        reference: &str,
    ) -> Result<DeliveryResult>;
}
pub struct Twilio;
fn xml(v: &str) -> String {
    v.replace('&', "and").replace(['<', '>', '"', '\''], " ")
}
async fn send_at(
    base: &str,
    sid: &str,
    key: &str,
    kind: &str,
    to: &str,
    from: &str,
    words: &str,
) -> PhoneSend {
    let Ok(client) = crate::stedi::client() else {
        return PhoneSend::Uncertain;
    };
    // A call reads the reminder twice, so a patient who picks up mid-sentence still hears it.
    let spoken = format!(
        "<Response><Pause length=\"1\"/><Say>{0}</Say><Pause length=\"1\"/><Say>{0}</Say></Response>",
        xml(words)
    );
    let (path, body) = if kind == "call" {
        ("Calls.json", ("Twiml", spoken.as_str()))
    } else {
        ("Messages.json", ("Body", words))
    };
    let response = client
        .post(format!("{base}/2010-04-01/Accounts/{sid}/{path}"))
        .basic_auth(sid, Some(key))
        .form(&[("To", to), ("From", from), body])
        .send()
        .await;
    let Ok(response) = response else {
        return PhoneSend::Uncertain;
    };
    let status = response.status();
    let Ok(bytes) = crate::stedi::bytes(response, 65536).await else {
        return PhoneSend::Uncertain;
    };
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status.is_client_error() {
        return PhoneSend::Rejected(status.as_u16(), v["code"].as_i64());
    }
    if !status.is_success() {
        return PhoneSend::Uncertain;
    }
    let wanted = if kind == "call" { "CA" } else { "SM" };
    match v["sid"].as_str() {
        Some(reference)
            if reference.len() == 34
                && (reference.starts_with(wanted) || reference.starts_with("MM"))
                && reference.bytes().all(|b| b.is_ascii_alphanumeric()) =>
        {
            PhoneSend::Accepted(reference.to_owned())
        }
        _ => PhoneSend::Uncertain,
    }
}
async fn status_at(
    base: &str,
    sid: &str,
    key: &str,
    kind: &str,
    reference: &str,
) -> Result<DeliveryResult> {
    let folder = if kind == "call" { "Calls" } else { "Messages" };
    let (status, v) = twilio_get(base, sid, key, &format!("/{folder}/{reference}.json")).await?;
    if status != 200 || v["sid"] != reference {
        return Err(Error::Invalid("Twilio did not return this reminder"));
    }
    Ok(match (kind, v["status"].as_str()) {
        ("call", Some("completed")) | (_, Some("delivered" | "read")) => DeliveryResult::Delivered,
        ("call", Some("busy" | "no-answer" | "failed" | "canceled"))
        | (_, Some("undelivered" | "failed" | "canceled")) => DeliveryResult::Failed,
        _ => DeliveryResult::Pending,
    })
}
#[async_trait::async_trait]
impl PhoneTransport for Twilio {
    async fn send(
        &self,
        sid: &str,
        key: &str,
        kind: &str,
        to: &str,
        from: &str,
        words: &str,
    ) -> PhoneSend {
        send_at(TWILIO, sid, key, kind, to, from, words).await
    }
    async fn status(
        &self,
        sid: &str,
        key: &str,
        kind: &str,
        reference: &str,
    ) -> Result<DeliveryResult> {
        status_at(TWILIO, sid, key, kind, reference).await
    }
}
/// What the patient reads or hears: the practice and the appointment time, in the practice's own
/// time zone when it has set one. Nothing about why they are coming.
async fn words(tx: &mut Transaction<'_, Postgres>, tenant: Uuid, r: &Reminder) -> Result<String> {
    let clinic = crate::previsit::practice_name(tx, tenant).await?;
    let (when, zoned): (String, bool) = sqlx::query_as("SELECT trim(to_char($2::timestamptz AT TIME ZONE coalesce(z.zone,'UTC'),'FMDay, FMMonth FMDD \"at\" FMHH12:MI AM')),z.zone IS NOT NULL FROM (SELECT (SELECT booking_timezone FROM previsit_booking_profiles WHERE tenant_id=$1 LIMIT 1) AS zone) z").bind(tenant).bind(r.starts_at).fetch_one(&mut **tx).await?;
    let when = if zoned { when } else { format!("{when} UTC") };
    Ok(if r.automatic_phone.as_deref() == Some("call") {
        format!("This is a reminder from {clinic}. You have an appointment on {when}. If your plans have changed, please call the office. Thank you.")
    } else {
        format!("{clinic}: reminder of your appointment on {when}. If your plans have changed, please call the office. Reply STOP to stop these texts.")
    })
}
async fn permitted(tx: &mut Transaction<'_, Postgres>, tenant: Uuid, r: &Reminder) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM appointments a JOIN patient_reminder_preferences p ON p.tenant_id=a.tenant_id AND p.patient_id=a.patient_id JOIN patient_demographics d ON d.tenant_id=p.tenant_id AND d.patient_id=p.patient_id WHERE a.tenant_id=$1 AND a.id=$2 AND a.status='booked' AND a.starts_at=$3 AND a.starts_at>now() AND p.version=$4 AND p.channel='phone' AND p.destination=$5 AND p.consented AND p.verified AND p.automatic_phone=$6 AND d.content->>'phone'=p.destination)").bind(tenant).bind(r.appointment_id).bind(r.starts_at).bind(r.preference_version).bind(&r.destination).bind(&r.automatic_phone).fetch_one(&mut **tx).await?)
}
async fn hold(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    status: &str,
    note: &str,
    action: &str,
    why: &str,
) -> Result<()> {
    sqlx::query("UPDATE appointment_reminders SET status=$3,last_result=$4,lease_id=NULL,lease_until=NULL WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(status).bind(note).execute(&mut **tx).await?;
    event(tx, a, id, action, why).await
}
pub async fn process_one(pool: &PgPool) -> Result<bool> {
    process_one_with_transport(pool, &Twilio).await
}
pub async fn process_one_with_transport(
    pool: &PgPool,
    transport: &dyn PhoneTransport,
) -> Result<bool> {
    let candidate:Option<(Uuid,Uuid)>=sqlx::query_as("SELECT r.tenant_id,r.id FROM appointment_reminders r JOIN reminder_phone_settings s ON s.tenant_id=r.tenant_id WHERE r.automatic_phone IS NOT NULL AND ((s.enabled AND s.verified AND ((r.status='scheduled' AND NOT r.invalidated AND r.due_at<=now() AND r.next_attempt_at<=now()) OR (r.status='sending' AND r.lease_until<now()))) OR (r.provider_ref IS NOT NULL AND r.status='accepted' AND r.first_attempt_at>now()-interval '2 days' AND (r.last_poll_at IS NULL OR r.last_poll_at<now()-interval '60 seconds'))) ORDER BY CASE WHEN r.provider_ref IS NULL THEN 0 ELSE 1 END,r.last_poll_at NULLS FIRST,r.due_at,r.id LIMIT 1").fetch_optional(pool).await?;
    let Some((tenant, id)) = candidate else {
        return Ok(false);
    };
    let a = worker(tenant);
    let mut tx = pool.begin().await?;
    reminder_lock(&mut tx, &a).await?;
    let mut r = row(&mut tx, tenant, id).await?;
    let settings = setting(&mut tx, tenant).await?.ok_or(Error::NotFound)?;
    let kind = r.automatic_phone.clone().ok_or(Error::NotFound)?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    if let Some(reference) = r.provider_ref.clone() {
        if r.status != "accepted" {
            return Ok(false);
        }
        let (key, sid, _) = token(
            &mut tx,
            tenant,
            r.phone_setting_id
                .ok_or(Error::Invalid("sender evidence missing"))?,
            r.phone_revision
                .ok_or(Error::Invalid("sender evidence missing"))?,
        )
        .await?;
        let (status, note) = match transport
            .status(&sid, key.expose(), &kind, &reference)
            .await
        {
            Ok(DeliveryResult::Delivered) => ("delivered", "provider_confirmed_delivery"),
            Ok(DeliveryResult::Failed) => ("failed", "provider_confirmed_failure"),
            _ => ("accepted", "provider_delivery_not_yet_confirmed"),
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
    if r.status == "sending" {
        if r.lease_until.is_some_and(|t| t > now) {
            return Ok(false);
        }
        hold(&mut tx, &a, id, "needs_review", "send_outcome_unknown", "dispatch_held", "The send was interrupted and Twilio cannot be asked whether it arrived; check before contacting the patient again").await?;
        tx.commit().await?;
        return Ok(true);
    }
    if r.status != "scheduled"
        || r.invalidated
        || !settings.enabled
        || !settings.verified
        || r.due_at > now
        || r.next_attempt_at > now
    {
        return Ok(false);
    }
    if !permitted(&mut tx, tenant, &r).await? {
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
    let Some(to) = r.destination.as_deref().and_then(e164) else {
        hold(
            &mut tx,
            &a,
            id,
            "failed",
            "phone_number_not_valid",
            "dispatch_held",
            "The phone number on file cannot be texted or called as written",
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    };
    let lease = Uuid::new_v4();
    sqlx::query("UPDATE appointment_reminders SET status='sending',lease_id=$3,lease_until=now()+interval '60 seconds',first_attempt_at=coalesce(first_attempt_at,now()),phone_setting_id=$4,phone_revision=$5,attempts=attempts+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(lease).bind(settings.id).bind(settings.credential_revision).execute(&mut *tx).await?;
    event(
        &mut tx,
        &a,
        id,
        "dispatch_claimed",
        "Send reserved before the request to Twilio",
    )
    .await?;
    tx.commit().await?;
    // The schedule lock serializes preference and appointment changes with the bounded send.
    let mut tx = pool.begin().await?;
    reminder_lock(&mut tx, &a).await?;
    r = row(&mut tx, tenant, id).await?;
    let s = setting(&mut tx, tenant).await?.ok_or(Error::NotFound)?;
    if r.lease_id != Some(lease) || r.status != "sending" {
        return Ok(false);
    }
    if r.invalidated
        || !s.enabled
        || !s.verified
        || Some(s.credential_revision) != r.phone_revision
        || !permitted(&mut tx, tenant, &r).await?
    {
        sqlx::query("UPDATE appointment_reminders SET status=CASE WHEN attempts<=1 THEN 'cancelled' ELSE 'needs_review' END,invalidated=true,last_result='dispatch_invalidated_before_send',lease_id=NULL,lease_until=NULL WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).execute(&mut *tx).await?;
        event(
            &mut tx,
            &a,
            id,
            "dispatch_suppressed",
            "Permission or appointment changed before the request to Twilio",
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    let text = words(&mut tx, tenant, &r).await?;
    let (key, sid, from) = token(&mut tx, tenant, s.id, s.credential_revision).await?;
    let result = transport
        .send(&sid, key.expose(), &kind, &to, &from, &text)
        .await;
    let (status, note, reference) = match result {
        PhoneSend::Accepted(reference) => (
            "accepted",
            "provider_accepted_not_delivered",
            Some(reference),
        ),
        PhoneSend::Rejected(429, _) if r.attempts < 5 => {
            ("scheduled", "rate_limited_retry_pending", None)
        }
        // 21610: the patient texted STOP to this number. Twilio will not deliver to them.
        PhoneSend::Rejected(_, Some(21610)) => ("failed", "patient_stopped_texts", None),
        PhoneSend::Rejected(_, Some(21211 | 21214 | 21614)) => {
            ("failed", "phone_number_cannot_receive_this", None)
        }
        PhoneSend::Rejected(..) => ("failed", "provider_rejected_request", None),
        PhoneSend::Uncertain => ("needs_review", "send_outcome_unknown", None),
    };
    sqlx::query("UPDATE appointment_reminders SET status=$3,last_result=$4,provider_ref=$5,next_attempt_at=now()+make_interval(secs=>$6),lease_id=NULL,lease_until=NULL WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(status).bind(note).bind(reference).bind((60i64*2i64.pow(r.attempts.min(6)as u32))as f64).execute(&mut *tx).await?;
    event(
        &mut tx,
        &a,
        id,
        "provider_send_result",
        "Twilio taking the request is separate from confirmed delivery",
    )
    .await?;
    tx.commit().await?;
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const SID: &str = "AC00000000000000000000000000000000";
    const KEY: &str = "0123456789abcdef0123456789abcdef";
    const FROM: &str = "+14155550100";
    const TO: &str = "+14155550123";
    const MESSAGE: &str = "SM0123456789abcdef0123456789abcdef";
    const CALL: &str = "CA0123456789abcdef0123456789abcdef";
    /// A local endpoint that answers one request per canned response, in order, and hands back
    /// each raw request it saw.
    async fn endpoint(
        responses: Vec<(u16, Value)>,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut seen = Vec::new();
            for (status, response) in responses {
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
                seen.push(String::from_utf8(bytes).unwrap());
            }
            seen
        });
        (base, task)
    }
    fn has_basic_auth(request: &str) -> bool {
        use base64::Engine;
        let want = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{SID}:{KEY}"))
        );
        request.lines().any(|l| {
            l.split_once(':')
                .is_some_and(|(k, v)| k.eq_ignore_ascii_case("authorization") && v.trim() == want)
        })
    }
    #[test]
    fn phone_numbers_are_put_in_international_form() {
        for (given, want) in [
            ("4155550100", "+14155550100"),
            ("14155550100", "+14155550100"),
            ("+14155550100", "+14155550100"),
            ("+442071838750", "+442071838750"),
            ("(415) 555-0100", "+14155550100"),
            (" 415.555.0100 ", "+14155550100"),
            ("1-415-555-0100", "+14155550100"),
        ] {
            assert_eq!(e164(given).as_deref(), Some(want), "{given}");
        }
        for bad in [
            "",
            "   ",
            "555-0100",
            "415555010a",
            "call me",
            "0155550100",
            "1155550100",
            "+0442071838750",
            "+1234567",
            "415555010012345",
        ] {
            assert_eq!(e164(bad), None, "{bad}");
        }
    }
    #[tokio::test]
    async fn text_send_contract_and_outcomes() {
        let (base, task) = endpoint(vec![(201, json!({"sid":MESSAGE}))]).await;
        let sent = send_at(&base, SID, KEY, "text", TO, FROM, "Clinic: reminder").await;
        assert!(matches!(sent, PhoneSend::Accepted(ref v) if v == MESSAGE));
        let request = task.await.unwrap().remove(0);
        assert!(request.starts_with(&format!("POST /2010-04-01/Accounts/{SID}/Messages.json ")));
        assert!(has_basic_auth(&request));
        assert!(request.contains("To=%2B14155550123"));
        assert!(request.contains("From=%2B14155550100"));
        assert!(request.contains("Body=Clinic%3A+reminder"));
        assert!(!request.contains("Twiml"));
        for (status, body, rejected) in [
            (
                400,
                json!({"code":21610,"message":"synthetic"}),
                Some((400, Some(21610))),
            ),
            (400, json!({"message":"no code"}), Some((400, None))),
            (500, json!({"message":"synthetic"}), None),
            (201, json!({"sid":"SMshort"}), None),
            (
                201,
                json!({"sid":"SM0123456789abcdef0123456789abcde!"}),
                None,
            ),
            (201, json!({"status":"queued"}), None),
        ] {
            let (base, task) = endpoint(vec![(status, body)]).await;
            let sent = send_at(&base, SID, KEY, "text", TO, FROM, "words").await;
            task.await.unwrap();
            match rejected {
                Some((code, number)) => {
                    assert!(matches!(sent, PhoneSend::Rejected(c, n) if c == code && n == number))
                }
                None => assert!(matches!(sent, PhoneSend::Uncertain)),
            }
        }
    }
    #[tokio::test]
    async fn call_send_speaks_the_words_without_raw_markup() {
        let (base, task) = endpoint(vec![(201, json!({"sid":CALL}))]).await;
        let sent = send_at(
            &base,
            SID,
            KEY,
            "call",
            TO,
            FROM,
            "Fish & <b>Chips</b> clinic",
        )
        .await;
        assert!(matches!(sent, PhoneSend::Accepted(ref v) if v == CALL));
        let request = task.await.unwrap().remove(0);
        assert!(request.starts_with(&format!("POST /2010-04-01/Accounts/{SID}/Calls.json ")));
        assert!(has_basic_auth(&request));
        let body = request.split("\r\n\r\n").nth(1).unwrap();
        let twiml: String = url::form_urlencoded::parse(body.as_bytes())
            .find(|(k, _)| k == "Twiml")
            .map(|(_, v)| v.into_owned())
            .expect("Twiml field");
        assert!(twiml.contains("<Say>"));
        assert!(twiml.contains("Fish and  b Chips /b  clinic"));
        let inside: String = twiml
            .split("<Say>")
            .skip(1)
            .map(|s| s.split("</Say>").next().unwrap())
            .collect();
        assert!(!inside.contains(['&', '<', '>']));
        assert!(!body.contains("Body="));
        // A call reference must start with CA or MM; a message reference is not enough.
        let (base, task) = endpoint(vec![(201, json!({"sid":MESSAGE}))]).await;
        let sent = send_at(&base, SID, KEY, "call", TO, FROM, "words").await;
        task.await.unwrap();
        assert!(matches!(sent, PhoneSend::Uncertain));
    }
    #[tokio::test]
    async fn delivery_status_is_read_from_twilio() {
        for (kind, reference, state, want) in [
            ("text", MESSAGE, "delivered", DeliveryResult::Delivered),
            ("text", MESSAGE, "undelivered", DeliveryResult::Failed),
            ("text", MESSAGE, "sent", DeliveryResult::Pending),
            ("call", CALL, "completed", DeliveryResult::Delivered),
            ("call", CALL, "no-answer", DeliveryResult::Failed),
            ("call", CALL, "ringing", DeliveryResult::Pending),
        ] {
            let (base, task) = endpoint(vec![(200, json!({"sid":reference,"status":state}))]).await;
            let got = status_at(&base, SID, KEY, kind, reference).await.unwrap();
            let request = task.await.unwrap().remove(0);
            let folder = if kind == "call" { "Calls" } else { "Messages" };
            assert!(request.starts_with(&format!(
                "GET /2010-04-01/Accounts/{SID}/{folder}/{reference}.json "
            )));
            assert!(has_basic_auth(&request));
            assert!(
                matches!(
                    (&got, &want),
                    (DeliveryResult::Delivered, DeliveryResult::Delivered)
                        | (DeliveryResult::Failed, DeliveryResult::Failed)
                        | (DeliveryResult::Pending, DeliveryResult::Pending)
                ),
                "{kind} {state}"
            );
        }
        let (base, task) = endpoint(vec![(
            200,
            json!({"sid":"SMffffffffffffffffffffffffffffffff","status":"delivered"}),
        )])
        .await;
        assert!(status_at(&base, SID, KEY, "text", MESSAGE).await.is_err());
        task.await.unwrap();
    }
    #[tokio::test]
    async fn account_check_needs_active_account_and_the_number() {
        let account = json!({"sid":SID,"status":"active"});
        let (base, task) = endpoint(vec![
            (200, account.clone()),
            (
                200,
                json!({"incoming_phone_numbers":[{"phone_number":FROM}]}),
            ),
        ])
        .await;
        assert_eq!(
            verify_at(&base, SID, KEY, FROM).await.unwrap(),
            Check::Ready
        );
        let seen = task.await.unwrap();
        assert!(seen[0].starts_with(&format!("GET /2010-04-01/Accounts/{SID}.json ")));
        assert!(seen[1].contains("IncomingPhoneNumbers.json?PhoneNumber=%2B14155550100"));
        assert!(seen.iter().all(|r| has_basic_auth(r)));
        let (base, task) = endpoint(vec![(401, json!({"code":20003}))]).await;
        assert_eq!(
            verify_at(&base, SID, KEY, FROM).await.unwrap(),
            Check::NotSignedIn
        );
        assert_eq!(task.await.unwrap().len(), 1);
        let (base, task) = endpoint(vec![(200, json!({"sid":SID,"status":"suspended"}))]).await;
        assert_eq!(
            verify_at(&base, SID, KEY, FROM).await.unwrap(),
            Check::NotSignedIn
        );
        task.await.unwrap();
        let (base, task) = endpoint(vec![
            (200, account.clone()),
            (200, json!({"incoming_phone_numbers":[]})),
        ])
        .await;
        assert_eq!(
            verify_at(&base, SID, KEY, FROM).await.unwrap(),
            Check::NumberNotOnAccount
        );
        task.await.unwrap();
    }
}
