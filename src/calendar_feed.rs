// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! A private calendar link for each staff member. Google Calendar and Microsoft 365 subscribe to
//! it and show the person's busy times from the practice schedule. The feed carries times only:
//! no patient, no appointment title, no reason, no room, and no block label.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use serde::Deserialize;
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
        .route(
            "/api/v1/practice/calendar-links",
            get(practice_links).put(practice_switch),
        )
        .route(
            "/api/v1/practice/calendar-links/{user}",
            delete(practice_remove),
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
    let allowed = allowed(db(&s)?, a.tenant_id).await?;
    Ok(Json(match row {
        Some((created, read)) => {
            json!({"active":true,"allowed":allowed,"created_at":created,"last_read_at":read})
        }
        None => json!({"active":false,"allowed":allowed}),
    }))
}
/// Makes the person's link, replacing any earlier one. The secret is shown once, here.
async fn create(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    if !allowed(db(&s)?, a.tenant_id).await? {
        return Err(Error::Invalid(
            "Calendar links are turned off for this practice.",
        ));
    }
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
/// A practice allows calendar links until its owner turns them off.
async fn allowed(db: &sqlx::PgPool, tenant: Uuid) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT links_enabled FROM practice_calendar_settings WHERE tenant_id=$1",
    )
    .bind(tenant)
    .fetch_optional(db)
    .await?
    .unwrap_or(true))
}
fn owner(a: &Actor) -> Result<()> {
    if matches!(a.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
/// The owner's view: whether links are allowed, and who has one on. Never the link itself.
async fn practice_links(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    owner(&a)?;
    let items: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('user_id',f.user_id,'name',coalesce(nullif(p.display_name,''),nullif(u.display_name,''),u.email),'role',u.role,'created_at',f.created_at,'last_read_at',f.last_read_at) FROM calendar_feeds f JOIN browser_users u ON u.tenant_id=f.tenant_id AND u.id=f.user_id LEFT JOIN practice_providers p ON p.tenant_id=u.tenant_id AND p.id=u.id WHERE f.tenant_id=$1 AND NOT u.disabled ORDER BY 1")
        .bind(a.tenant_id)
        .fetch_all(db(&s)?)
        .await?;
    Ok(Json(
        json!({"enabled":allowed(db(&s)?, a.tenant_id).await?,"items":items}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Switch {
    enabled: bool,
}
async fn practice_switch(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(p): Json<Switch>,
) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    sqlx::query("INSERT INTO practice_calendar_settings(tenant_id,links_enabled,updated_by) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET links_enabled=excluded.links_enabled,updated_by=excluded.updated_by,updated_at=now()")
        .bind(a.tenant_id)
        .bind(p.enabled)
        .bind(a.sub)
        .execute(&mut *tx)
        .await?;
    let action = if p.enabled {
        "practice.calendar_links.allowed"
    } else {
        "practice.calendar_links.stopped"
    };
    crate::postgres::audit(&mut tx, &a, action, a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"enabled":p.enabled})))
}
/// The owner turns off one person's link. That person can make a new one if links are allowed.
async fn practice_remove(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(user): Path<Uuid>,
) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    let gone = sqlx::query("DELETE FROM calendar_feeds WHERE tenant_id=$1 AND user_id=$2")
        .bind(a.tenant_id)
        .bind(user)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if gone == 0 {
        return Err(Error::NotFound);
    }
    crate::postgres::audit(&mut tx, &a, "schedule.calendar_link.removed", user).await?;
    tx.commit().await?;
    Ok(Json(json!({"removed":true})))
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
    let owner: Option<(Uuid, Uuid)> = sqlx::query_as("UPDATE calendar_feeds f SET last_read_at=now() FROM browser_users u WHERE f.token_hash=$1 AND u.tenant_id=f.tenant_id AND u.id=f.user_id AND NOT u.disabled AND NOT EXISTS(SELECT 1 FROM practice_calendar_settings c WHERE c.tenant_id=f.tenant_id AND NOT c.links_enabled) RETURNING f.tenant_id,f.user_id")
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
