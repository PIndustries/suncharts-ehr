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
        .route("/api/v1/events", get(events))
        .route("/api/v1/events/stream", get(stream))
}
async fn page(s: &State, a: &Actor, after: i64) -> Result<Page> {
    a.staff()?;
    if after < 0 {
        return Err(Error::Invalid("invalid event cursor"));
    }
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let rows:Vec<Change>=sqlx::query_as("SELECT id,action,resource_id,created_at FROM audit_events WHERE tenant_id=$1 AND id>$2 AND (action LIKE 'patient.%' OR action LIKE 'appointment.%' OR action LIKE 'visit.%' OR action LIKE 'migration.%') AND action NOT LIKE '%.read' AND action NOT LIKE '%.list' AND action NOT LIKE '%.fhir_search' ORDER BY id LIMIT 100")
        .bind(a.tenant_id).bind(after).fetch_all(db).await?;
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
            match page(&s,&actor,after).await {
                Ok(p)=>{
                    for change in p.items {
                        after=change.id;
                        let Ok(event)=Event::default().event("clinical.change").id(change.id.to_string()).json_data(&change) else {break};
                        yield Ok::<Event,std::convert::Infallible>(event);
                    }
                },
                Err(_)=>{yield Ok(Event::default().event("unavailable").data("reconnect_from_last_cursor"));break;}
            }
        }
    };
    Ok(Sse::new(feed).keep_alive(KeepAlive::default()))
}
