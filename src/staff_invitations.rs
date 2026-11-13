// SPDX-License-Identifier: AGPL-3.0-only
//! Sign-in links for staff of a practice whose sign-in is handled by
//! SunCharts Connect. Staff have no password: Connect emails each new person
//! a link that signs them in. The practice owner is authorized here; Connect
//! only sees the installation credential. No link or token passes through
//! this service, and nothing here logs an email address.
use crate::{
    auth::Actor,
    error::{Error, Result},
    practice_admin::{locked, owner},
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/practice/staff/invitations", get(list))
        .route("/api/v1/practice/staff/{id}/invitation", post(send))
}

/// Connect allows an installation 60 invitation calls an hour, reads included.
/// Status is therefore read at most once in this window per practice, and each
/// link sent from here updates the remembered copy instead of rereading.
const STATUS_TTL: Duration = Duration::from_secs(120);
/// Right after a link is sent the owner is watching for that person to sign
/// in, so for a short while the remembered copy is only trusted this long.
const WATCH_TTL: Duration = Duration::from_secs(20);
/// How long after a link was sent the shorter window applies.
const WATCH_SECONDS: i64 = 600;
/// Reads allowed in any hour before the shorter window is given up, which
/// leaves the rest of Connect's hourly allowance for sending links.
const WATCH_READS: usize = 40;
#[derive(Default)]
struct Remembered {
    copies: HashMap<Uuid, (Instant, Vec<Value>)>,
    /// When Connect was read for each practice during the last hour.
    reads: HashMap<Uuid, Vec<Instant>>,
}
static STATUS: Mutex<Option<Remembered>> = Mutex::new(None);

/// True while a link sent in the last few minutes has not been used yet.
fn watching(items: &[Value], now: chrono::DateTime<chrono::Utc>) -> bool {
    items.iter().any(|v| {
        v["state"] == "pending"
            && v["created_at"]
                .as_str()
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                .is_some_and(|at| {
                    let age = (now - at.with_timezone(&chrono::Utc)).num_seconds();
                    (0..=WATCH_SECONDS).contains(&age)
                })
    })
}
/// How long a remembered copy is trusted, given how often Connect was read.
fn trusted_for(items: &[Value], reads_this_hour: usize) -> Duration {
    if reads_this_hour < WATCH_READS && watching(items, chrono::Utc::now()) {
        WATCH_TTL
    } else {
        STATUS_TTL
    }
}
fn remembered(tenant: Uuid) -> Option<Vec<Value>> {
    let guard = STATUS.lock().ok()?;
    let kept = guard.as_ref()?;
    let (at, items) = kept.copies.get(&tenant)?;
    let reads = kept.reads.get(&tenant).map_or(0, |r| {
        r.iter()
            .filter(|t| t.elapsed() < Duration::from_secs(3600))
            .count()
    });
    (at.elapsed() < trusted_for(items, reads)).then(|| items.clone())
}
/// The last copy however old, for when Connect says it has been asked too often.
fn last_known(tenant: Uuid) -> Option<Vec<Value>> {
    let guard = STATUS.lock().ok()?;
    Some(guard.as_ref()?.copies.get(&tenant)?.1.clone())
}
fn remember(tenant: Uuid, items: Vec<Value>) {
    if let Ok(mut guard) = STATUS.lock() {
        guard
            .get_or_insert_with(Remembered::default)
            .copies
            .insert(tenant, (Instant::now(), items));
    }
}
fn count_read(tenant: Uuid) {
    if let Ok(mut guard) = STATUS.lock() {
        let reads = guard
            .get_or_insert_with(Remembered::default)
            .reads
            .entry(tenant)
            .or_default();
        reads.retain(|t| t.elapsed() < Duration::from_secs(3600));
        reads.push(Instant::now());
    }
}
/// Adds a fresh result to a remembered list without extending its lifetime.
fn remember_latest(tenant: Uuid, item: &Value) {
    if let Ok(mut guard) = STATUS.lock() {
        if let Some((_, items)) = guard.as_mut().and_then(|m| m.copies.get_mut(&tenant)) {
            items.insert(0, item.clone());
        }
    }
}
fn forget(tenant: Uuid) {
    if let Ok(mut guard) = STATUS.lock() {
        if let Some(kept) = guard.as_mut() {
            kept.copies.remove(&tenant);
        }
    }
}

/// Password sign-in is refused for every account while Connect handles
/// sign-in, so staff need an invitation rather than a password.
pub(crate) async fn managed(db: &PgPool) -> Result<bool> {
    crate::connect_identity::connected(db).await
}

/// Why Connect did not take a request. Each one has plain wording in the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Refusal {
    Unreachable,
    AccessOff,
    Email,
    Plan,
    Busy,
    NotAllowed,
    Refused,
}
impl Refusal {
    fn code(self) -> &'static str {
        match self {
            Self::Unreachable => "unreachable",
            Self::AccessOff => "access_off",
            Self::Email => "email_refused",
            Self::Plan => "plan",
            Self::Busy => "busy",
            Self::NotAllowed => "not_allowed",
            Self::Refused => "refused",
        }
    }
    fn history(self) -> &'static str {
        match self {
            Self::Unreachable => "Sign-in link not sent: SunCharts could not be reached",
            Self::AccessOff => {
                "Sign-in link not sent: this person's SunCharts access is turned off"
            }
            Self::Email => "Sign-in link not sent: the email address was not accepted",
            Self::Plan => "Sign-in link not sent: the SunCharts plan needs attention",
            Self::Busy => "Sign-in link not sent: too many links sent in the last hour",
            Self::NotAllowed => "Sign-in link not sent: the SunCharts connection needs attention",
            Self::Refused => "Sign-in link not sent: SunCharts did not accept the request",
        }
    }
}
fn refusal(status: StatusCode, message: &str) -> Refusal {
    match status.as_u16() {
        409 if message.contains("inactive") => Refusal::AccessOff,
        400 if message.contains("email") => Refusal::Email,
        402 => Refusal::Plan,
        429 => Refusal::Busy,
        401 | 403 => Refusal::NotAllowed,
        500..=599 => Refusal::Unreachable,
        _ => Refusal::Refused,
    }
}
fn client() -> std::result::Result<reqwest::Client, Refusal> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .user_agent(concat!("suncharts-ehr/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| Refusal::Unreachable)
}
/// One authenticated call as this installation. A connection failure or a
/// server error is tried once more with the identical body: Connect treats a
/// repeated `request_id` with the same content as the same invitation.
async fn call_at(
    base: &str,
    installation: Uuid,
    key: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> std::result::Result<Value, Refusal> {
    let client = client()?;
    let url = format!("{base}/api/v1/ehr-services/installations/{installation}{path}");
    let mut last = Refusal::Unreachable;
    for _ in 0..2 {
        let mut request = client.request(method.clone(), &url).bearer_auth(key);
        if let Some(body) = body {
            request = request.json(body);
        }
        let Ok(response) = request.send().await else {
            last = Refusal::Unreachable;
            continue;
        };
        let status = response.status();
        let Ok(bytes) = crate::stedi::bytes(response, 262_144).await else {
            last = Refusal::Unreachable;
            continue;
        };
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(value);
        }
        last = refusal(status, value["message"].as_str().unwrap_or_default());
        if !status.is_server_error() {
            break;
        }
    }
    Err(last)
}

struct Installation {
    base: String,
    id: Uuid,
    key: crate::provider_settings::Secret,
}
/// The installation credential already used for reminders and support.
async fn installation(db: &PgPool, tenant: Uuid) -> std::result::Result<Installation, Refusal> {
    let base = crate::connect_onboarding::cloud_origin().map_err(|_| Refusal::NotAllowed)?;
    let mut tx = db.begin().await.map_err(|_| Refusal::Unreachable)?;
    let setting = crate::connect_services::setting(&mut tx, tenant)
        .await
        .map_err(|_| Refusal::Unreachable)?
        .filter(|s| s.enabled && s.verified && !s.revoked)
        .ok_or(Refusal::NotAllowed)?;
    let (id, key) =
        crate::connect_services::pinned(&mut tx, tenant, setting.id, setting.credential_revision)
            .await
            .map_err(|_| Refusal::NotAllowed)?;
    tx.commit().await.map_err(|_| Refusal::Unreachable)?;
    Ok(Installation { base, id, key })
}
async fn connect_list(db: &PgPool, tenant: Uuid) -> std::result::Result<Vec<Value>, Refusal> {
    if let Some(items) = remembered(tenant) {
        return Ok(items);
    }
    let i = installation(db, tenant).await?;
    count_read(tenant);
    let value = match call_at(
        &i.base,
        i.id,
        i.key.expose(),
        reqwest::Method::GET,
        "/staff-invites",
        None,
    )
    .await
    {
        Ok(value) => value,
        // Asked too often: what was last read is still the best answer.
        Err(Refusal::Busy) => return last_known(tenant).ok_or(Refusal::Busy),
        Err(refused) => return Err(refused),
    };
    let items = value["items"].as_array().cloned().ok_or(Refusal::Refused)?;
    remember(tenant, items.clone());
    Ok(items)
}

#[derive(sqlx::FromRow)]
struct Staff {
    id: Uuid,
    email: String,
    display_name: String,
    role: String,
    disabled: bool,
    signed_in: bool,
    last_active: Option<chrono::DateTime<chrono::Utc>>,
    last_status: Option<String>,
    last_reason: Option<String>,
}
impl Staff {
    /// The name Connect puts in the invitation. Accounts made before display
    /// names existed have none; the part of the email before the @ stands in.
    fn name(&self) -> String {
        let name = self.display_name.trim();
        if name.is_empty() {
            self.email.split('@').next().unwrap_or("Staff").to_owned()
        } else {
            name.to_owned()
        }
    }
    fn payload(&self, request: Uuid) -> Value {
        json!({"request_id":request,"remote_user_id":self.id,"email":self.email,"display_name":self.name(),"role":self.role})
    }
}
/// `signed_in` only counts Connect sign-ins made since the account last had a
/// different email, because Connect matches staff by email; `last_active` is
/// when one of those sign-ins was last used here. `last_*` is the most recent
/// attempt to send a link recorded here for the current email.
const STAFF: &str = "SELECT u.id,u.email,u.display_name,u.role,u.disabled,
 a.sessions>0 AS signed_in,a.last_active,
 l.content->>'invitation_status' AS last_status,l.content->>'invitation_reason' AS last_reason
 FROM browser_users u LEFT JOIN LATERAL (SELECT count(*) AS sessions,
   max(greatest(s.created_at,coalesce(s.last_introspected_at,s.created_at))) AS last_active
  FROM connect_identity_sessions s WHERE s.tenant_id=u.tenant_id AND s.user_id=u.id
  AND s.created_at>=coalesce((SELECT min(n.created_at) FROM practice_admin_history n
    WHERE n.tenant_id=u.tenant_id AND n.kind='staff' AND n.resource_id=u.id AND n.version>
     (SELECT max(o.version) FROM practice_admin_history o WHERE o.tenant_id=u.tenant_id AND o.kind='staff'
       AND o.resource_id=u.id AND o.content->>'email'<>u.email)),'-infinity'::timestamptz)) a ON true
 LEFT JOIN LATERAL (SELECT h.content FROM practice_admin_history h
   WHERE h.tenant_id=u.tenant_id AND h.kind='staff' AND h.resource_id=u.id AND h.content ? 'invitation_status'
     AND h.content->>'email'=u.email ORDER BY h.version DESC LIMIT 1) l ON true
 WHERE u.tenant_id=$1";

fn state(status: &str) -> Value {
    json!({ "status": status })
}
fn not_sent(reason: &str) -> Value {
    json!({"status":"not_sent","reason":reason})
}
/// What one Connect invitation record means for the person it was sent to.
fn from_connect(v: &Value) -> Value {
    let delivery = &v["delivery"];
    match v["state"].as_str() {
        Some("accepted") => state("can_sign_in"),
        Some("inactive") => state("access_off"),
        Some("expired") => json!({"status":"expired","expires_at":v["expires_at"]}),
        Some("revoked") => state("cancelled"),
        Some("pending") => {
            if delivery["transport"] == "partner" {
                json!({"status":"waiting","reason":"partner_delivery","sent_at":v["created_at"],"expires_at":v["expires_at"]})
            } else if delivery["accepted"] == true {
                json!({"status":"waiting","sent_at":v["created_at"],"expires_at":v["expires_at"]})
            } else if delivery["accepted"].is_null() {
                not_sent("delivery_unknown")
            } else {
                not_sent("email_not_delivered")
            }
        }
        _ => state("not_invited"),
    }
}
fn matching<'a>(staff: &Staff, items: &'a [Value]) -> Option<&'a Value> {
    // Newest first. An invitation to an earlier email no longer matches.
    items
        .iter()
        .find(|v| v["remote_user_id"] == staff.id.to_string() && v["email"] == staff.email)
}
fn status(staff: &Staff, items: Option<&[Value]>) -> Value {
    if staff.disabled {
        return state("disabled");
    }
    let found = items
        .and_then(|items| matching(staff, items))
        .map(from_connect);
    let mut out = match found {
        Some(v) if v["status"] == "access_off" => v,
        _ if staff.signed_in => state("can_sign_in"),
        Some(v) => v,
        // Without Connect's record, the last attempt made from here still
        // says whether an invitation went out. While Connect cannot be read,
        // anything else is unknown rather than "not invited".
        None => match (staff.last_status.as_deref(), staff.last_reason.as_deref()) {
            (Some("access_off"), _) => state("access_off"),
            (Some("not_sent"), Some(reason)) => not_sent(reason),
            (Some("can_sign_in"), _) if items.is_none() => state("can_sign_in"),
            _ if items.is_none() => state("unknown"),
            _ => state("not_invited"),
        },
    };
    // Only what is actually known is added: when they last used this EHR,
    // and a passkey only when Connect itself reports one for this person.
    if out["status"] == "can_sign_in" {
        if let Some(at) = staff.last_active.filter(|_| staff.signed_in) {
            out["last_active_at"] = json!(at);
        }
        let passkey = items
            .and_then(|items| matching(staff, items))
            .is_some_and(|v| v["passkey_added"] == true);
        if passkey {
            out["passkey_added"] = json!(true);
        }
    }
    out
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    /// Set by the owner's Refresh button: read Connect again now.
    #[serde(default)]
    fresh: bool,
}
async fn list(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let a = owner(&s, &h, false).await?;
    let db = &s.browser.as_ref().ok_or(Error::Unauthorized)?.db;
    let mut tx = locked(&s, &a, &h).await?;
    crate::postgres::audit(&mut tx, &a, "practice.staff.invitations_read", a.tenant_id).await?;
    tx.commit().await?;
    if !managed(db).await? {
        return Ok(Json(
            json!({"sign_in":"password","available":true,"items":[]}),
        ));
    }
    let staff: Vec<Staff> = sqlx::query_as(&format!(
        "{STAFF} ORDER BY lower(u.display_name),u.email LIMIT 1000"
    ))
    .bind(a.tenant_id)
    .fetch_all(db)
    .await?;
    if q.fresh {
        forget(a.tenant_id);
    }
    let items = connect_list(db, a.tenant_id).await.ok();
    let rows: Vec<Value> = staff
        .iter()
        .map(|person| {
            let mut v = status(person, items.as_deref());
            v["staff_id"] = json!(person.id);
            v
        })
        .collect();
    Ok(Json(
        json!({"sign_in":"connect","available":items.is_some(),"items":rows}),
    ))
}

/// Sends (or sends again) the invitation for one staff account and records the
/// outcome in that account's history. Problems reaching Connect are an outcome,
/// not an error: the staff account itself is already saved.
pub(crate) async fn invite(s: &State, a: &Actor, h: &HeaderMap, id: Uuid) -> Result<Value> {
    let db = &s.browser.as_ref().ok_or(Error::Unauthorized)?.db;
    let staff: Staff = sqlx::query_as(&format!("{STAFF} AND u.id=$2"))
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or(Error::NotFound)?;
    let request = Uuid::new_v4();
    let result = deliver(db, a.tenant_id, &staff, request).await;
    let (outcome, reason) = match &result {
        Ok(v) => {
            remember_latest(a.tenant_id, v);
            let outcome = from_connect(v);
            let reason = match outcome["status"].as_str() {
                Some("can_sign_in") => "No sign-in link needed: already has a SunCharts account",
                Some("waiting") => "Sign-in link emailed",
                Some("access_off") => Refusal::AccessOff.history(),
                _ => "Sign-in link not sent: the email could not be delivered",
            };
            (outcome, reason)
        }
        Err(Refusal::AccessOff) => (state("access_off"), Refusal::AccessOff.history()),
        Err(refused) => {
            // The outcome is unknown after a failure; read it again next time.
            forget(a.tenant_id);
            (not_sent(refused.code()), refused.history())
        }
    };
    let mut tx = locked(s, a, h).await?;
    let version: Option<i64> = sqlx::query_scalar(
        "UPDATE browser_users SET version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING version",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let version = version.ok_or(Error::NotFound)?;
    let mut content: Value = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'email',email,'display_name',display_name,'role',role,'disabled',disabled,'version',version) FROM browser_users WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
    content["invitation_status"] = outcome["status"].clone();
    if let Some(reason) = outcome.get("reason") {
        content["invitation_reason"] = reason.clone();
    }
    content["invitation_request"] = json!(request);
    sqlx::query("INSERT INTO practice_admin_history(tenant_id,id,resource_id,kind,version,actor_id,reason,content) VALUES($1,$2,$3,'staff',$4,$5,$6,$7)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(id).bind(version).bind(a.sub).bind(reason).bind(&content).execute(&mut *tx).await?;
    crate::postgres::audit(
        &mut tx,
        a,
        if result.is_ok() {
            "practice.staff.invitation_requested"
        } else {
            "practice.staff.invitation_failed"
        },
        id,
    )
    .await?;
    tx.commit().await?;
    let mut out = outcome;
    out["staff_id"] = json!(id);
    out["version"] = json!(version);
    Ok(out)
}
async fn deliver(
    db: &PgPool,
    tenant: Uuid,
    staff: &Staff,
    request: Uuid,
) -> std::result::Result<Value, Refusal> {
    let i = installation(db, tenant).await?;
    // "Send again" repeats an earlier request unchanged. If the name or role
    // was edited since, a new invitation carries the current details instead.
    let earlier = remembered(tenant).and_then(|items| {
        matching(staff, &items)
            .filter(|v| v["display_name"] == staff.name() && v["role"] == staff.role)
            .and_then(|v| v["request_id"].as_str().map(str::to_owned))
    });
    let (path, body) = match earlier {
        Some(previous) => (
            format!("/staff-invites/{previous}/resend"),
            json!({ "request_id": request }),
        ),
        None => ("/staff-invites".to_owned(), staff.payload(request)),
    };
    let v = call_at(
        &i.base,
        i.id,
        i.key.expose(),
        reqwest::Method::POST,
        &path,
        Some(&body),
    )
    .await?;
    if v["request_id"] != request.to_string()
        || v["remote_user_id"] != staff.id.to_string()
        || v["email"] != staff.email
    {
        return Err(Refusal::Refused);
    }
    Ok(v)
}

async fn send(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let a = owner(&s, &h, true).await?;
    let db = &s.browser.as_ref().ok_or(Error::Unauthorized)?.db;
    if !managed(db).await? {
        return Err(Error::Conflict(
            "This practice signs in with passwords, so there is no sign-in link to send.",
        ));
    }
    let disabled: Option<bool> =
        sqlx::query_scalar("SELECT disabled FROM browser_users WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .fetch_optional(db)
            .await?;
    if disabled.ok_or(Error::NotFound)? {
        return Err(Error::Conflict(
            "Turn this person's access back on before sending a sign-in link.",
        ));
    }
    Ok(Json(invite(&s, &a, &h, id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn person(signed_in: bool) -> Staff {
        Staff {
            id: Uuid::from_u128(7),
            email: "desk@example.test".into(),
            display_name: "Synthetic Desk".into(),
            role: "front_desk".into(),
            disabled: false,
            signed_in,
            last_active: signed_in.then(|| {
                chrono::DateTime::parse_from_rfc3339("2026-11-13T21:04:00Z")
                    .unwrap()
                    .with_timezone(&chrono::Utc)
            }),
            last_status: None,
            last_reason: None,
        }
    }
    fn record(state: &str, delivery: Value) -> Value {
        json!({"request_id":Uuid::from_u128(1),"remote_user_id":Uuid::from_u128(7),"email":"desk@example.test","display_name":"Synthetic Desk","role":"front_desk","state":state,"delivery":delivery,"created_at":"2026-11-13T10:00:00Z","expires_at":"2026-11-20T10:00:00Z"})
    }
    #[test]
    fn every_connect_state_has_one_plain_status() {
        let sent = json!({"transport":"email","accepted":true,"detail":"provider_accepted"});
        let p = person(false);
        for (connect, delivery, expected, reason) in [
            ("accepted", sent.clone(), "can_sign_in", None),
            ("inactive", sent.clone(), "access_off", None),
            ("expired", sent.clone(), "expired", None),
            ("revoked", sent.clone(), "cancelled", None),
            ("unavailable", sent.clone(), "not_invited", None),
            ("pending", sent.clone(), "waiting", None),
            (
                "pending",
                json!({"transport":"partner","accepted":false,"detail":"partner_delivery_required"}),
                "waiting",
                Some("partner_delivery"),
            ),
            (
                "pending",
                json!({"transport":"email","accepted":false,"detail":"email_not_sent"}),
                "not_sent",
                Some("email_not_delivered"),
            ),
            (
                "pending",
                json!({"transport":"unknown","accepted":null,"detail":"delivery_status_unknown_use_resend"}),
                "not_sent",
                Some("delivery_unknown"),
            ),
        ] {
            let v = status(&p, Some(&[record(connect, delivery)]));
            assert_eq!(v["status"], expected, "{connect}");
            assert_eq!(v["reason"].as_str(), reason, "{connect}");
        }
        let waiting = status(&p, Some(&[record("pending", sent.clone())]));
        assert_eq!(waiting["sent_at"], "2026-11-13T10:00:00Z");
        assert_eq!(waiting["expires_at"], "2026-11-20T10:00:00Z");
    }
    #[test]
    fn local_facts_fill_in_when_connect_has_no_record() {
        let mut p = person(false);
        assert_eq!(status(&p, Some(&[]))["status"], "not_invited");
        assert_eq!(status(&p, None)["status"], "unknown");
        p.last_status = Some("not_sent".into());
        p.last_reason = Some("unreachable".into());
        let v = status(&p, Some(&[]));
        assert_eq!(
            (v["status"].as_str(), v["reason"].as_str()),
            (Some("not_sent"), Some("unreachable"))
        );
        // A person who has signed in through Connect needs no invitation.
        assert_eq!(status(&person(true), Some(&[]))["status"], "can_sign_in");
        assert_eq!(status(&person(true), None)["status"], "can_sign_in");
        // While Connect cannot be read, a failed attempt made here is still shown as not sent.
        assert_eq!(status(&p, None)["status"], "not_sent");
        // An invitation to an earlier email, or for someone else, does not count.
        let mut other = record("accepted", json!({}));
        other["email"] = json!("old@example.test");
        assert_eq!(status(&p, Some(&[other]))["status"], "not_sent");
        // Access turned off in Connect wins over an earlier sign-in.
        let off = record("inactive", json!({}));
        assert_eq!(status(&person(true), Some(&[off]))["status"], "access_off");
        p.disabled = true;
        assert_eq!(status(&p, Some(&[]))["status"], "disabled");
    }
    #[test]
    fn signed_in_staff_show_when_they_were_last_active_and_a_passkey_only_if_reported() {
        let sent = json!({"transport":"email","accepted":true,"detail":"provider_accepted"});
        // Connect as it is today sends no passkey fact: nothing is claimed.
        let v = status(&person(true), Some(&[record("accepted", sent.clone())]));
        assert_eq!(v["status"], "can_sign_in");
        assert_eq!(v["last_active_at"], "2026-11-13T21:04:00Z");
        assert!(v.get("passkey_added").is_none());
        for (reported, shown) in [
            (json!(true), true),
            (json!(false), false),
            (json!("yes"), false),
        ] {
            let mut r = record("accepted", sent.clone());
            r["passkey_added"] = reported;
            let v = status(&person(true), Some(&[r]));
            assert_eq!(v.get("passkey_added").is_some(), shown);
        }
        // Used the link at Connect but has not opened this EHR yet: no sign-in time is invented.
        let v = status(&person(false), Some(&[record("accepted", sent.clone())]));
        assert_eq!(v["status"], "can_sign_in");
        assert!(v.get("last_active_at").is_none());
        // Someone still waiting never shows a sign-in time or passkey.
        let mut r = record("pending", sent);
        r["passkey_added"] = json!(true);
        let v = status(&person(false), Some(&[r]));
        assert_eq!(v["status"], "waiting");
        assert!(v.get("last_active_at").is_none() && v.get("passkey_added").is_none());
    }
    #[test]
    fn a_link_just_sent_is_checked_more_often_within_the_hourly_allowance() {
        let now = chrono::Utc::now();
        let at = |seconds: i64| (now - chrono::Duration::seconds(seconds)).to_rfc3339();
        let sent = json!({"transport":"email","accepted":true});
        let mut fresh = record("pending", sent.clone());
        fresh["created_at"] = json!(at(30));
        assert!(watching(&[fresh.clone()], now));
        assert_eq!(trusted_for(&[fresh.clone()], 0), WATCH_TTL);
        // Ten minutes after sending, ordinary reads resume.
        let mut old = record("pending", sent.clone());
        old["created_at"] = json!(at(WATCH_SECONDS + 1));
        assert!(!watching(&[old.clone()], now));
        assert_eq!(trusted_for(&[old], 0), STATUS_TTL);
        // Once the link is used, expired or replaced there is nothing to watch.
        for done in ["accepted", "expired", "revoked", "inactive"] {
            let mut r = record(done, sent.clone());
            r["created_at"] = json!(at(30));
            assert!(!watching(&[r], now), "{done}");
        }
        // A date that cannot be read, or one in the future, never shortens the window.
        let mut odd = record("pending", sent.clone());
        odd["created_at"] = json!("soon");
        assert!(!watching(&[odd.clone()], now));
        odd["created_at"] = json!(at(-120));
        assert!(!watching(&[odd], now));
        // The shorter window stops before Connect's 60-an-hour allowance is at risk.
        assert_eq!(trusted_for(&[fresh.clone()], WATCH_READS - 1), WATCH_TTL);
        assert_eq!(trusted_for(&[fresh], WATCH_READS), STATUS_TTL);
        assert!(WATCH_READS < 60);
        assert!(WATCH_SECONDS as u64 / WATCH_TTL.as_secs() <= WATCH_READS as u64);
    }
    #[test]
    fn refusals_map_to_reasons_without_echoing_connect_text() {
        let c = |code: u16, m: &str| refusal(StatusCode::from_u16(code).unwrap(), m);
        assert_eq!(
            c(409, "this staff member has an inactive Connect membership; review it in Connect before inviting"),
            Refusal::AccessOff
        );
        assert_eq!(
            c(409, "request_id is already bound to another invitation"),
            Refusal::Refused
        );
        assert_eq!(c(400, "valid email is required"), Refusal::Email);
        assert_eq!(c(400, "unsupported staff role"), Refusal::Refused);
        assert_eq!(c(402, ""), Refusal::Plan);
        assert_eq!(c(429, ""), Refusal::Busy);
        assert_eq!(c(401, ""), Refusal::NotAllowed);
        assert_eq!(c(403, ""), Refusal::NotAllowed);
        assert_eq!(c(503, ""), Refusal::Unreachable);
        for r in [
            Refusal::Unreachable,
            Refusal::AccessOff,
            Refusal::Email,
            Refusal::Plan,
            Refusal::Busy,
            Refusal::NotAllowed,
            Refusal::Refused,
        ] {
            assert!(r.history().starts_with("Sign-in link not sent: "));
            assert!(!r.history().contains('@'));
        }
    }
    #[test]
    fn invitation_names_the_person_and_carries_no_secret() {
        let mut p = person(false);
        let request = Uuid::from_u128(9);
        assert_eq!(
            p.payload(request),
            json!({"request_id":request,"remote_user_id":p.id,"email":"desk@example.test","display_name":"Synthetic Desk","role":"front_desk"})
        );
        p.display_name = "  ".into();
        assert_eq!(p.payload(request)["display_name"], "desk");
    }
}
