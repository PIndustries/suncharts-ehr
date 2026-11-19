// SPDX-License-Identifier: AGPL-3.0-only
//! Practice-owned billing partners. The catalog and every enrollment live in
//! SunCharts Connect; this module forwards the practice owner's request with the
//! installation credential already used for Connect services and keeps no local
//! copy of an agreement. Partner content and the accepting owner's email address
//! are passed through for one call and never stored or logged here.
use crate::{
    auth::Actor,
    error::{Error, Result},
    practice_admin::{locked, owner},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

/// The agreement version this EHR presents. Connect records it with the enrollment.
pub const AGREEMENT_VERSION: &str = "partner-enrollment-v1";
const NOT_PAIRED: &str = "Connect this EHR to SunCharts first.";
const UNREACHABLE: &str = "SunCharts Connect could not be reached. Try again.";
const REFUSED: &str = "SunCharts Connect did not accept that. Try again, or contact support.";
const SERVICE_DOWN: &str = "SunCharts Connect is unavailable right now. Try again.";
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/practice/partners", get(list))
        .route("/api/v1/practice/partners/{slug}/enroll", post(enroll))
        .route("/api/v1/practice/partners/{slug}/leave", post(leave))
}

pub(crate) enum Gateway {
    NotPaired,
    Unreachable,
    /// Connect answered and refused. The sentence is Connect's reason for the
    /// owner, already bounded and sanitized by [`refusal`].
    Refused(&'static str),
    /// Connect has no such partner. The practice's own screen already has the
    /// right wording for a thing that is not there.
    Missing,
}

impl Gateway {
    fn error(self) -> Error {
        match self {
            Self::NotPaired => Error::Conflict(NOT_PAIRED),
            Self::Unreachable => Error::Unavailable(UNREACHABLE),
            Self::Refused(message) => Error::Conflict(message),
            Self::Missing => Error::NotFound,
        }
    }
}

fn db(s: &State) -> Result<PgPool> {
    Ok(s.browser.as_ref().ok_or(Error::NotFound)?.db.clone())
}

fn client() -> std::result::Result<reqwest::Client, Gateway> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| Gateway::Unreachable)
}

fn clean(value: &str, max: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}

/// Only a single plain sentence may reach a clinic screen: a body that is empty,
/// over one sentence long or carries control characters is Connect's transport
/// detail, not the owner's wording.
fn refusal(value: &Value) -> Option<&str> {
    let message = value["message"].as_str()?.trim();
    let single = message.chars().count() <= 300
        && !message.contains('\n')
        && !message.contains("<")
        && clean(message, 300);
    single.then_some(message)
}

// A passed-through sentence cannot be a `&'static str`. The number of distinct
// sentences is bounded by Connect's own catalog, so this does not grow without end.
fn held(message: &str) -> &'static str {
    Box::leak(message.to_owned().into_boxed_str())
}

/// One authenticated call as this installation, on the base URL and credential
/// the reminder and support routes already use.
async fn call(
    pool: &PgPool,
    tenant: uuid::Uuid,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> std::result::Result<Value, Gateway> {
    let mut tx = pool.begin().await.map_err(|_| Gateway::Unreachable)?;
    let setting = crate::connect_services::setting(&mut tx, tenant)
        .await
        .map_err(|_| Gateway::Unreachable)?
        .filter(|setting| setting.enabled && setting.verified && !setting.revoked)
        .ok_or(Gateway::NotPaired)?;
    let (_, key) =
        crate::connect_services::pinned(&mut tx, tenant, setting.id, setting.credential_revision)
            .await
            .map_err(|_| Gateway::NotPaired)?;
    tx.commit().await.map_err(|_| Gateway::Unreachable)?;
    let base = crate::connect_onboarding::cloud_origin().map_err(|_| Gateway::NotPaired)?;
    let mut request = client()?.request(
        method,
        format!(
            "{base}/api/v1/ehr-services/installations/{}/partners{path}",
            setting.installation_id
        ),
    );
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .bearer_auth(key.expose())
        .send()
        .await
        .map_err(|_| Gateway::Unreachable)?;
    let status = response.status();
    let bytes = crate::stedi::bytes(response, 262_144)
        .await
        .map_err(|_| Gateway::Unreachable)?;
    if status.is_success() {
        return serde_json::from_slice(&bytes).map_err(|_| Gateway::Unreachable);
    }
    // An unknown partner is a wrong address, not a practice state. The browser
    // gets 404, the wording it already uses for a route that is not there.
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(Gateway::Missing);
    }
    if status.is_server_error() {
        return Err(Gateway::Refused(held(SERVICE_DOWN)));
    }
    let refused: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    // Connect's own reason is what the owner can act on: which partner the
    // practice already works with, or that this practice came from another one.
    match refusal(&refused) {
        Some(message) => Err(Gateway::Refused(held(message))),
        None if status == reqwest::StatusCode::CONFLICT => Err(Gateway::Refused(held(REFUSED))),
        None => Err(Gateway::Unreachable),
    }
}

/// One display field, or nothing when Connect sends something this screen cannot
/// show. Only the fields the screen uses are kept, so a field from another
/// Connect release never reaches a browser.
fn field<'a>(value: &'a Value, key: &str, max: usize) -> Option<&'a str> {
    let text = value[key].as_str()?;
    clean(text, max).then_some(text)
}

fn catalog(value: &Value) -> std::result::Result<Value, Gateway> {
    let items = value["items"].as_array().ok_or(Gateway::Unreachable)?;
    let partners = items
        .iter()
        .filter_map(|item| {
            let slug = field(item, "slug", 64)?;
            let name = field(item, "name", 200)?;
            let services = item["services"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|v| v.as_str())
                        .filter(|v| clean(v, 80))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(json!({
                "slug": slug,
                "name": name,
                "summary": field(item, "summary", 600).unwrap_or_default(),
                "services": services,
                "preferred": item["preferred"].as_bool().unwrap_or(false),
                "enrolled": item["enrolled"].as_bool().unwrap_or(false),
            }))
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "items": partners,
        "enrollment": enrollment(&value["enrollment"]),
        "incomplete": items.len() > partners.len(),
    }))
}

/// An enrollment this screen can show, or `null`. An answer that names no partner
/// or no date is not reportable, and is left to [`unknown_enrollment`].
fn enrollment(value: &Value) -> Value {
    let status = match value["status"].as_str() {
        Some("active") => "active",
        Some("ended") => "ended",
        _ => return Value::Null,
    };
    let (Some(slug), Some(name), Some(enrolled_at)) = (
        field(value, "partner_slug", 64),
        field(value, "partner_name", 200),
        field(value, "enrolled_at", 40),
    ) else {
        return Value::Null;
    };
    json!({
        "partner_slug": slug,
        "partner_name": name,
        "status": status,
        "enrolled_at": enrolled_at,
        "agreement_version": field(value, "agreement_version", 60).unwrap_or(AGREEMENT_VERSION),
    })
}

/// A write Connect confirmed but this screen cannot describe. Reported separately
/// so the answer is never shown as a failure the owner would act on twice.
fn unknown_enrollment(value: &Value) -> bool {
    value["enrollment"].is_object() && enrollment(&value["enrollment"]).is_null()
}

/// Step 1 of the same screen, from the endpoint the Payments screen already uses.
/// Anything that stops it answering is reported as unknown rather than as
/// "payments not set up", so a temporary fault never looks like a missing setup.
async fn payment_account(s: &State, a: &Actor) -> Value {
    let mut out = json!({"state": "unknown"});
    match crate::payments::account_state(s, a).await {
        Ok(data) => {
            let setting = &data["setting"];
            out["state"] = json!(match setting["mode"].as_str() {
                Some("suncharts_connect")
                    if setting["charges_enabled"] == true && setting["payouts_enabled"] == true =>
                    "ready",
                Some("suncharts_connect") => "started",
                _ => "none",
            });
            for key in ["native_setup_url", "connect_portal_url"] {
                if let Some(url) = data[key].as_str().filter(|v| clean(v, 500)) {
                    out[key] = json!(url);
                }
            }
        }
        Err(error) => out["reason"] = json!(error.to_string()),
    }
    out
}

async fn list(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let a = owner(&s, &h, false).await?;
    // Connect is asked before this transaction opens: no database connection is
    // held across a network round trip.
    let remote = call(&db(&s)?, a.tenant_id, reqwest::Method::GET, "", None).await;
    let unpaired = matches!(remote, Err(Gateway::NotPaired));
    let payments = payment_account(&s, &a).await;
    let mut partners = match remote {
        Ok(value) => catalog(&value).map_err(Gateway::error)?,
        Err(gateway @ (Gateway::NotPaired | Gateway::Unreachable)) => {
            let error = gateway.error();
            json!({"items": [], "enrollment": Value::Null, "incomplete": false, "connect_error": error.to_string()})
        }
        Err(gateway) => return Err(gateway.error()),
    };
    // Without a connection the whole screen is one action: pair this EHR. The
    // payment state cannot be acted on separately, so it is shown as blocked.
    partners["payments"] = if unpaired {
        json!({"state": "unavailable"})
    } else {
        payments
    };
    let mut tx = locked(&s, &a, &h).await?;
    crate::postgres::audit(&mut tx, &a, "practice.partners_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"partners": partners})))
}

/// The screen's request is parsed by hand: axum's own 422 for a broken body is a
/// transport message, and the owner's answer here is a plain "that request is not
/// complete" they can act on.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Accepted {
    name: String,
    email: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnrollInput {
    request_id: Uuid,
    agreement_version: String,
    accepted_by: Accepted,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaveInput {
    request_id: Uuid,
}
const BAD_REQUEST: &str = "That request is not complete. Refresh the screen and try again.";
fn input<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| Error::Invalid(BAD_REQUEST))
}

/// The accepted_by block is the browser's copy of who is clicking. It must be a
/// pair of plain strings; an empty name or an address without an @ cannot accept
/// an agreement and is refused before anything is sent.
fn sane(accepted: &Accepted) -> bool {
    clean(accepted.name.trim(), 200)
        && !accepted.name.trim().is_empty()
        && clean(accepted.email.trim(), 254)
        && accepted.email.contains('@')
}

/// The partner address is checked before anything is sent, so a mistyped slug
/// cannot reach Connect as a stray request.
fn partner_slug(value: &str) -> Result<&str> {
    let slug = value.trim();
    let valid = !slug.is_empty()
        && slug.len() <= 64
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    if valid {
        Ok(slug)
    } else {
        Err(Error::Invalid("That billing partner is not recognized."))
    }
}

/// Who accepted the agreement: the signed-in owner as this EHR knows them. The
/// browser's copy is only a fallback for an account with no recorded name, and
/// neither value is kept here.
async fn accepted_by(s: &State, a: &Actor, sent: &Accepted) -> Result<Value> {
    let pool = db(s)?;
    let recorded: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT display_name, email FROM browser_users WHERE tenant_id=$1 AND id=$2 AND NOT disabled",
    )
    .bind(a.tenant_id)
    .bind(a.sub)
    .fetch_optional(&pool)
    .await?;
    let (name, email) = recorded.unwrap_or_default();
    let name = name
        .filter(|v| clean(v, 200))
        .or_else(|| clean(&sent.name, 200).then(|| sent.name.trim().to_owned()));
    let email = email
        .filter(|v| clean(v, 254) && v.contains('@'))
        .or_else(|| clean(&sent.email, 254).then(|| sent.email.trim().to_owned()));
    let email = email.filter(|v| v.contains('@')).ok_or(Error::Invalid(
        "This owner account has no email address on record to accept the agreement with.",
    ))?;
    Ok(
        json!({"name": name.ok_or(Error::Invalid("This owner account has no name on record to accept the agreement with."))?, "email": email}),
    )
}

async fn enroll(
    ExtractState(s): ExtractState<State>,
    Path(slug): Path<String>,
    h: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    let a = owner(&s, &h, true).await?;
    let slug = partner_slug(&slug)?;
    let parsed: Value = serde_json::from_slice(&body).map_err(|_| Error::Invalid(BAD_REQUEST))?;
    let input: EnrollInput = input(parsed)?;
    if !sane(&input.accepted_by) {
        return Err(Error::Invalid(
            "A name and an email address are required to accept the agreement.",
        ));
    }
    if input.agreement_version != AGREEMENT_VERSION {
        return Err(Error::Invalid(
            "Refresh the screen to see the current agreement before enrolling.",
        ));
    }
    // The request identity comes from the screen so a retry after a lost answer
    // is the same enrollment, and Connect's idempotency can do its work.
    let body = json!({
        "request_id": input.request_id,
        "agreement_version": AGREEMENT_VERSION,
        "accepted_by": accepted_by(&s, &a, &input.accepted_by).await?,
    });
    let value = call(
        &db(&s)?,
        a.tenant_id,
        reqwest::Method::POST,
        &format!("/{slug}/enroll"),
        Some(&body),
    )
    .await
    .map_err(Gateway::error)?;
    let confirmed = enrollment(&value["enrollment"]);
    if confirmed.is_null() {
        return Err(if unknown_enrollment(&value) {
            Error::Unavailable(UNREACHABLE)
        } else {
            Error::Unavailable(SERVICE_DOWN)
        });
    }
    // The agreement is only over when Connect says it ended. An answer that
    // describes an enrollment in some other state is Connect's detail, not the
    // practice's: report it as a service fault and audit nothing.
    let mut tx = locked(&s, &a, &h).await?;
    crate::postgres::audit(&mut tx, &a, "practice.partner.enrolled", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"enrollment": confirmed, "unconfirmed": confirmed["status"] != "active"}),
    ))
}

async fn leave(
    ExtractState(s): ExtractState<State>,
    Path(slug): Path<String>,
    h: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    let a = owner(&s, &h, true).await?;
    let slug = partner_slug(&slug)?;
    let parsed: Value = serde_json::from_slice(&body).map_err(|_| Error::Invalid(BAD_REQUEST))?;
    let input: LeaveInput = input(parsed)?;
    let body = json!({"request_id": input.request_id});
    let value = call(
        &db(&s)?,
        a.tenant_id,
        reqwest::Method::POST,
        &format!("/{slug}/leave"),
        Some(&body),
    )
    .await
    .map_err(Gateway::error)?;
    let ended = enrollment(&value["enrollment"]);
    if ended.is_null() {
        return Err(if unknown_enrollment(&value) {
            Error::Unavailable(UNREACHABLE)
        } else {
            Error::Unavailable(SERVICE_DOWN)
        });
    }
    let mut tx = locked(&s, &a, &h).await?;
    crate::postgres::audit(&mut tx, &a, "practice.partner.left", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"enrollment": ended, "unconfirmed": ended["status"] != "ended"}),
    ))
}
