// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Durable, tenant-scoped change notices. Payloads carry resource references,
//! not copies of the clinical record. Consumers fetch permitted data separately.
use crate::{
    auth::Actor,
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Query, State as ExtractState},
    http::{header, HeaderMap, Method},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Sse,
    },
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct Cursor {
    #[serde(default)]
    after: i64,
    /// Establish a baseline without replaying the installation's full history.
    #[serde(default)]
    latest: bool,
}

// Mutations whose authorized detail/list routes are available to staff. These
// notices contain references only; reading the referenced record remains a
// separate authorization decision. Reads and idempotency replays are excluded.
const WORKFLOW_AI_ACTIONS: &[&str] = &[
    "ai.draft.requested",
    "ai.draft.received",
    "ai.draft.failed",
    "ai.draft.reviewed",
    "practice.care_pathways.create",
    "practice.care_pathways.update",
    "practice.care_pathways.action",
    "practice.care_pathways.trigger",
    "practice.care_pathways.instance.action",
    "practice.care_pathways.step.action",
    "practice.workflow_dispatch.created",
    "practice.workflow_dispatch.approved",
    "practice.workflow_dispatch.rejected",
    "practice.workflow_dispatch.confirmed",
    "practice.workflow_dispatch.finished",
];

fn event_name(action: &str) -> &'static str {
    if action.starts_with("ai.draft.") {
        "ai.change"
    } else if action.starts_with("practice.care_pathways.")
        || action.starts_with("practice.workflow_dispatch.")
    {
        "workflow.change"
    } else {
        "clinical.change"
    }
}
#[derive(Serialize, sqlx::FromRow)]
pub struct Change {
    pub id: i64,
    pub action: String,
    pub resource_id: Uuid,
    pub created_at: DateTime<Utc>,
}
#[derive(Serialize)]
pub struct Page {
    pub items: Vec<Change>,
    pub next_cursor: i64,
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/browser/events", get(browser_stream))
        .route("/api/v1/events", get(events))
        .route("/api/v1/events/stream", get(stream))
}
async fn page(s: &State, a: &Actor, after: i64) -> Result<Page> {
    a.staff()?;
    if after < 0 {
        return Err(Error::Invalid("invalid event cursor"));
    }
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let rows:Vec<Change>=sqlx::query_as("SELECT id,action,resource_id,created_at FROM audit_events WHERE tenant_id=$1 AND id>$2 AND (action LIKE 'patient.%' OR action LIKE 'appointment.%' OR action LIKE 'visit.%' OR action LIKE 'migration.%' OR action=ANY($3)) AND action NOT LIKE '%.read' AND action NOT LIKE '%.list' AND action NOT LIKE '%.fhir_search' ORDER BY id LIMIT 100")
        .bind(a.tenant_id).bind(after).bind(WORKFLOW_AI_ACTIONS).fetch_all(db).await?;
    let next_cursor = rows.last().map_or(after, |r| r.id);
    Ok(Page {
        items: rows,
        next_cursor,
    })
}
async fn events(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(c): Query<Cursor>,
) -> Result<Json<Page>> {
    if c.latest {
        a.staff()?;
        if c.after < 0 {
            return Err(Error::Invalid("invalid event cursor"));
        }
        let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
        let next_cursor = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(id),0) FROM audit_events WHERE tenant_id=$1",
        )
        .bind(a.tenant_id)
        .fetch_one(db)
        .await?;
        return Ok(Json(Page {
            items: Vec::new(),
            next_cursor,
        }));
    }
    Ok(Json(page(&s, &a, c.after).await?))
}
async fn stream(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(c): Query<Cursor>,
    h: HeaderMap,
) -> Result<impl IntoResponse> {
    a.staff()?;
    if c.after < 0 {
        return Err(Error::Invalid("invalid event cursor"));
    }
    let last = h
        .get("last-event-id")
        .map(|v| {
            v.to_str()
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .filter(|n| *n >= 0)
                .ok_or(Error::Invalid("invalid event cursor"))
        })
        .transpose()?;
    let initial = c.after.max(last.unwrap_or(0));
    let oauth = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer sce_at_"));
    if h.contains_key(header::AUTHORIZATION) && oauth.is_none() {
        return Err(Error::Forbidden);
    }
    let raw = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned);
    let feed = async_stream::stream! {
        let mut after=initial;
        let mut tick=tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tick.tick().await;
            // A revoked grant, disabled account, expired token or logged-out browser
            // terminates the live connection; access is not frozen at stream start.
            let auth=if let Some(ref token)=raw {crate::oauth::authenticate(&s,token,&Method::GET,"/api/v1/events/stream").await}
                else if let Some(ref b)=s.browser {b.authenticate(&h,false).await} else {Err(Error::Unauthorized)};
            let Ok(actor)=auth else {break};
            if actor.tenant_id != a.tenant_id || actor.sub != a.sub {break;}
            match page(&s,&actor,after).await {
                Ok(p)=>{
                    for change in p.items {
                        after=change.id;
                        let Ok(event)=Event::default().event(event_name(&change.action)).id(change.id.to_string()).json_data(&change) else {break};
                        yield Ok::<Event,std::convert::Infallible>(event);
                    }
                },
                Err(_)=>{yield Ok(Event::default().event("unavailable").data("reconnect_from_last_cursor"));break;}
            }
        }
    };
    Ok(Sse::new(feed).keep_alive(KeepAlive::default()))
}

// One browser stream carries all three reference-only channels. In HTTP/1.1,
// three independent streams per tab exhaust the origin's six connections after
// two tabs and starve ordinary page requests.
#[derive(Deserialize, Default)]
struct BrowserCursor {
    after: Option<String>,
}
fn browser_cursors(value: &str) -> Result<(i64, i64)> {
    let Some((clinical, services)) = value.split_once(':') else {
        return Err(Error::Invalid("invalid browser event cursor"));
    };
    let parse = |s: &str| {
        s.parse::<i64>()
            .ok()
            .filter(|v| *v >= 0)
            .ok_or(Error::Invalid("invalid browser event cursor"))
    };
    Ok((parse(clinical)?, parse(services)?))
}
async fn browser_stream(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Query(q): Query<BrowserCursor>,
) -> Result<impl IntoResponse> {
    // Browser sessions only. OAuth clients keep their existing scoped stream.
    if h.contains_key(header::AUTHORIZATION) {
        return Err(Error::Forbidden);
    }
    let auth = s.browser.as_ref().ok_or(Error::NotFound)?.clone();
    let actor = auth.authenticate(&h, false).await?;
    actor.staff()?;
    let supplied = h
        .get("last-event-id")
        .map(|v| {
            v.to_str()
                .map_err(|_| Error::Invalid("invalid browser event cursor"))
        })
        .transpose()?
        .or(q.after.as_deref());
    let initial = supplied.map(browser_cursors).transpose()?;
    let mut tx = auth.db.begin().await?;
    let clinical_max: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(id),0) FROM audit_events WHERE tenant_id=$1")
            .bind(actor.tenant_id)
            .fetch_one(&mut *tx)
            .await?;
    let service_max = crate::connect_updates::max_cursor(&mut tx, actor.tenant_id).await?;
    let binding = crate::connect_updates::binding(&mut tx, actor.tenant_id).await?;
    let notifications = if actor.scheduling().is_ok() {
        crate::connect_updates::notification_snapshot(&mut tx, &actor, binding.as_ref()).await?
    } else {
        serde_json::json!({"items":[],"unread_count":0,"has_more":false})
    };
    crate::postgres::audit(&mut tx, &actor, "browser.events.opened", actor.tenant_id).await?;
    tx.commit().await?;
    let (clinical, service) = initial.unwrap_or((clinical_max, service_max));
    let feed = async_stream::stream! {
        let mut clinical=clinical.min(clinical_max); let mut service=service.min(service_max);
        let mut current_binding=binding; let mut previous_status=String::new();
        let mut previous_notifications=notifications.to_string();
        if actor.scheduling().is_ok() {
            yield Ok::<Event,std::convert::Infallible>(Event::default().event("ready").id(format!("{clinical}:{service}")).json_data(serde_json::json!({"cursor":service,"notifications":notifications})).unwrap());
        }
        let mut tick=tokio::time::interval(std::time::Duration::from_secs(2));
        loop {
            tick.tick().await;
            let Ok(current)=auth.authenticate(&h,false).await else { break };
            if current.tenant_id!=actor.tenant_id || current.sub!=actor.sub || current.staff().is_err() { break; }
            let Ok(changes)=page(&s,&current,clinical).await else { break };
            for change in changes.items {
                clinical=change.id;
                if let Ok(event)=Event::default().event(event_name(&change.action)).id(format!("{clinical}:{service}")).json_data(&change) {
                    yield Ok(event);
                }
            }
            if let Ok(status)=crate::connect_services::browser_status(&s,&current).await {
                let text=status.to_string();
                if text!=previous_status { previous_status=text.clone(); yield Ok(Event::default().event("connection").id(format!("{clinical}:{service}")).data(text)); }
            }
            if current.scheduling().is_ok() {
                let result=crate::connect_updates::browser_page(&s,&current,current_binding.as_ref(),service).await;
                let Ok((binding,reset,cursor,changes,notifications))=result else { break };
                if reset { current_binding=binding;service=cursor;previous_notifications=notifications.to_string();
                    yield Ok(Event::default().event("reset").id(format!("{clinical}:{service}")).json_data(serde_json::json!({"cursor":service,"notifications":notifications})).unwrap());
                }
                for change in changes {
                    service=change["id"].as_i64().unwrap_or(service);
                    yield Ok(Event::default().event("service.change").id(format!("{clinical}:{service}")).json_data(change).unwrap());
                }
                let text=notifications.to_string();
                if text!=previous_notifications { previous_notifications=text.clone();yield Ok(Event::default().event("notifications").id(format!("{clinical}:{service}")).data(text)); }
            }
        }
    };
    Ok((
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Sse::new(feed).keep_alive(KeepAlive::default()),
    ))
}

#[cfg(test)]
mod browser_stream_tests {
    use super::*;
    #[test]
    fn cursor_requires_two_nonnegative_sequences() {
        assert_eq!(browser_cursors("21:7").unwrap(), (21, 7));
        for bad in [
            "",
            "1",
            "-1:2",
            "1:-2",
            "1:2:3",
            "99999999999999999999999:0",
        ] {
            assert!(browser_cursors(bad).is_err());
        }
    }
}
