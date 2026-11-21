// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! A private calendar link for each staff member. Google Calendar and Microsoft 365 subscribe to
//! it and show the person's busy times from the practice schedule. The feed carries times only:
//! no patient, no appointment title, no reason, no room, and no block label.
use crate::{
    auth::Actor,
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use serde_json::{json, Value};
use uuid::Uuid;

fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/schedule/calendar-link",
            get(status).post(create).delete(remove),
        )
        .route("/calendar/{file}", get(feed))
}
async fn status(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let row: Option<(DateTime<Utc>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT created_at,last_read_at FROM calendar_feeds WHERE tenant_id=$1 AND user_id=$2",
    )
    .bind(a.tenant_id)
    .bind(a.sub)
    .fetch_optional(db(&s)?)
    .await?;
    Ok(Json(match row {
        Some((created, read)) => json!({"active":true,"created_at":created,"last_read_at":read}),
        None => json!({"active":false}),
    }))
}
/// Makes the person's link, replacing any earlier one. The secret is shown once, here.
async fn create(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let token = URL_SAFE_NO_PAD.encode(raw);
    let mut tx = db(&s)?.begin().await?;
    sqlx::query("INSERT INTO calendar_feeds(tenant_id,user_id,token_hash) VALUES($1,$2,$3) ON CONFLICT(tenant_id,user_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=now(),last_read_at=NULL")
        .bind(a.tenant_id)
        .bind(a.sub)
        .bind(crate::oauth::hash(&token))
        .execute(&mut *tx)
        .await?;
    crate::postgres::audit(&mut tx, &a, "schedule.calendar_link.created", a.sub).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"active":true,"path":format!("/calendar/{token}.ics")}),
    ))
}
async fn remove(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    sqlx::query("DELETE FROM calendar_feeds WHERE tenant_id=$1 AND user_id=$2")
        .bind(a.tenant_id)
        .bind(a.sub)
        .execute(&mut *tx)
        .await?;
    crate::postgres::audit(&mut tx, &a, "schedule.calendar_link.removed", a.sub).await?;
    tx.commit().await?;
    Ok(Json(json!({"active":false})))
}
fn stamp(t: DateTime<Utc>) -> String {
    t.format("%Y%m%dT%H%M%SZ").to_string()
}
fn event(
    out: &mut String,
    id: Uuid,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    summary: &str,
    now: &str,
) {
    out.push_str(&format!(
        "BEGIN:VEVENT\r\nUID:{id}@suncharts\r\nDTSTAMP:{now}\r\nDTSTART:{}\r\nDTEND:{}\r\nSUMMARY:{summary}\r\nTRANSP:OPAQUE\r\nCLASS:PRIVATE\r\nEND:VEVENT\r\n",
        stamp(start),
        stamp(end)
    ));
}
/// The feed itself. Whoever holds the link reads it, so it says nothing but when the person is
/// busy: appointments that still stand, and blocked time.
async fn feed(ExtractState(s): ExtractState<State>, Path(file): Path<String>) -> Result<Response> {
    let token = file.strip_suffix(".ics").ok_or(Error::NotFound)?;
    if token.len() != 43
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(Error::NotFound);
    }
    let db = db(&s)?;
    let owner: Option<(Uuid, Uuid)> = sqlx::query_as("UPDATE calendar_feeds f SET last_read_at=now() FROM browser_users u WHERE f.token_hash=$1 AND u.tenant_id=f.tenant_id AND u.id=f.user_id AND NOT u.disabled RETURNING f.tenant_id,f.user_id")
        .bind(crate::oauth::hash(token))
        .fetch_optional(db)
        .await?;
    let (tenant, user) = owner.ok_or(Error::NotFound)?;
    let now = Utc::now();
    let (from, to) = (now - Duration::days(30), now + Duration::days(365));
    let appointments: Vec<(Uuid, DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as("SELECT id,starts_at,ends_at FROM appointments WHERE tenant_id=$1 AND clinician_id=$2 AND status NOT IN ('cancelled','no_show') AND starts_at<$4 AND ends_at>$3 ORDER BY starts_at,id LIMIT 5000")
        .bind(tenant).bind(user).bind(from).bind(to).fetch_all(db).await?;
    let blocks: Vec<(Uuid, DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as("SELECT id,starts_at,ends_at FROM schedule_blocks WHERE tenant_id=$1 AND clinician_id=$2 AND active AND starts_at<$4 AND ends_at>$3 ORDER BY starts_at,id LIMIT 5000")
        .bind(tenant).bind(user).bind(from).bind(to).fetch_all(db).await?;
    let stamp_now = stamp(now);
    let mut out = String::from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SunCharts//Schedule busy times//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:SunCharts schedule\r\nX-WR-CALDESC:Busy times from the practice schedule. No patient details.\r\nREFRESH-INTERVAL;VALUE=DURATION:PT15M\r\nX-PUBLISHED-TTL:PT15M\r\n");
    for (id, start, end) in appointments {
        event(&mut out, id, start, end, "Busy: appointment", &stamp_now);
    }
    for (id, start, end) in blocks {
        event(&mut out, id, start, end, "Busy: blocked time", &stamp_now);
    }
    out.push_str("END:VCALENDAR\r\n");
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/calendar; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        out,
    )
        .into_response())
}
