// SPDX-License-Identifier: AGPL-3.0-only
//! Durable Connect change references and session-bound browser notifications.
use crate::{
    auth::Actor,
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Query, State as ExtractState},
    http::HeaderMap,
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::{sync::OnceLock, time::Duration};
use tokio::sync::Notify;
use uuid::Uuid;
static WAKE: OnceLock<Notify> = OnceLock::new();
fn notify() -> &'static Notify {
    WAKE.get_or_init(Notify::new)
}
#[derive(Clone, Debug, PartialEq, Eq, sqlx::FromRow)]
struct Binding {
    id: Uuid,
    installation_id: Uuid,
    credential_revision: i64,
}
async fn binding(tx: &mut Transaction<'_, Postgres>, tenant: Uuid) -> Result<Option<Binding>> {
    Ok(sqlx::query_as("SELECT id,installation_id,credential_revision FROM connect_service_settings WHERE tenant_id=$1 AND enabled AND verified AND NOT revoked").bind(tenant).fetch_optional(&mut **tx).await?)
}
fn pool(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
async fn browser(s: &State, h: &HeaderMap, write: bool) -> Result<Actor> {
    let actor = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .authenticate(h, write)
        .await?;
    actor.scheduling()?;
    Ok(actor)
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/connect/services/events", get(events))
        .route("/api/v1/connect/services/notifications", get(notifications))
        .route(
            "/api/v1/connect/services/notifications/read",
            post(mark_read),
        )
}
#[derive(Serialize, sqlx::FromRow)]
struct Notification {
    id: i64,
    ticket_id: Uuid,
    message_id: Uuid,
    created_at: DateTime<Utc>,
}
async fn notification_snapshot(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    b: Option<&Binding>,
) -> Result<Value> {
    let Some(b) = b else {
        return Ok(json!({"items":[],"unread_count":0,"has_more":false}));
    };
    let mut rows:Vec<Notification>=sqlx::query_as("SELECT e.id,e.resource_id ticket_id,e.message_id,e.created_at FROM connect_update_events e WHERE e.tenant_id=$1 AND e.installation_id=$2 AND e.kind='support.reply' AND NOT EXISTS(SELECT 1 FROM connect_notification_reads r WHERE r.tenant_id=e.tenant_id AND r.event_id=e.id AND r.user_id=$3) ORDER BY e.id DESC LIMIT 101").bind(a.tenant_id).bind(b.installation_id).bind(a.sub).fetch_all(&mut **tx).await?;
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM connect_update_events e WHERE e.tenant_id=$1 AND e.installation_id=$2 AND e.kind='support.reply' AND NOT EXISTS(SELECT 1 FROM connect_notification_reads r WHERE r.tenant_id=e.tenant_id AND r.event_id=e.id AND r.user_id=$3)").bind(a.tenant_id).bind(b.installation_id).bind(a.sub).fetch_one(&mut **tx).await?;
    let more = rows.len() > 100;
    rows.truncate(100);
    Ok(json!({"items":rows,"unread_count":count,"has_more":more}))
}
async fn notifications(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let a = browser(&s, &h, false).await?;
    let mut tx = pool(&s)?.begin().await?;
    let b = binding(&mut tx, a.tenant_id).await?;
    let out = notification_snapshot(&mut tx, &a, b.as_ref()).await?;
    crate::postgres::audit(&mut tx, &a, "connect.notifications_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(out))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    event_ids: Vec<i64>,
}
async fn mark_read(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(input): Json<Read>,
) -> Result<Json<Value>> {
    let a = browser(&s, &h, true).await?;
    if input.event_ids.is_empty()
        || input.event_ids.len() > 100
        || input.event_ids.iter().any(|i| *i <= 0)
    {
        return Err(Error::Invalid("choose 1–100 notification identifiers"));
    }
    let mut ids = input.event_ids;
    ids.sort_unstable();
    ids.dedup();
    let mut tx = pool(&s)?.begin().await?;
    crate::scheduling::tenant_lock(&mut tx, &a).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))")
        .bind(a.tenant_id.to_string())
        .execute(&mut *tx)
        .await?;
    let b = binding(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::NotFound)?;
    let found:i64=sqlx::query_scalar("SELECT count(*) FROM connect_update_events WHERE tenant_id=$1 AND installation_id=$2 AND kind='support.reply' AND id=ANY($3)").bind(a.tenant_id).bind(b.installation_id).bind(&ids).fetch_one(&mut *tx).await?;
    if found != ids.len() as i64 {
        return Err(Error::NotFound);
    }
    for id in ids {
        let wrote=sqlx::query("INSERT INTO connect_notification_reads(tenant_id,user_id,event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(a.tenant_id).bind(a.sub).bind(id).execute(&mut *tx).await?;
        if wrote.rows_affected() > 0 {
            crate::postgres::audit(
                &mut tx,
                &a,
                "connect.notification_acknowledged",
                b.installation_id,
            )
            .await?;
        }
    }
    let out = notification_snapshot(&mut tx, &a, Some(&b)).await?;
    tx.commit().await?;
    Ok(Json(out))
}
#[derive(Deserialize)]
struct Cursor {
    after: Option<i64>,
}
#[derive(Serialize, sqlx::FromRow)]
struct Change {
    id: i64,
    kind: String,
    resource_id: Uuid,
    appointment_id: Option<Uuid>,
    message_id: Option<Uuid>,
    created_at: DateTime<Utc>,
}
async fn max_cursor(tx: &mut Transaction<'_, Postgres>, tenant: Uuid) -> Result<i64> {
    Ok(sqlx::query_scalar(
        "SELECT coalesce(max(id),0) FROM connect_update_events WHERE tenant_id=$1",
    )
    .bind(tenant)
    .fetch_one(&mut **tx)
    .await?)
}
async fn events(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Query(q): Query<Cursor>,
) -> Result<impl IntoResponse> {
    let a = browser(&s, &h, false).await?;
    let auth = s.browser.as_ref().ok_or(Error::NotFound)?.clone();
    let last = h
        .get("last-event-id")
        .map(|v| {
            v.to_str()
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .filter(|v| *v >= 0)
                .ok_or(Error::Invalid("invalid service event cursor"))
        })
        .transpose()?;
    if q.after.is_some_and(|n| n < 0) {
        return Err(Error::Invalid("invalid service event cursor"));
    }
    let mut tx = auth.db.begin().await?;
    let initial_binding = binding(&mut tx, a.tenant_id).await?;
    let max = max_cursor(&mut tx, a.tenant_id).await?;
    let initial = last.or(q.after).unwrap_or(max).min(max);
    let initial_notifications =
        notification_snapshot(&mut tx, &a, initial_binding.as_ref()).await?;
    crate::postgres::audit(&mut tx, &a, "connect.service_stream_opened", a.tenant_id).await?;
    tx.commit().await?;
    let feed = async_stream::stream! {
     let mut after=initial;let mut current_binding=initial_binding;let mut previous=initial_notifications.to_string();
     yield Ok::<_,std::convert::Infallible>(Event::default().event("ready").id(after.to_string()).json_data(json!({"cursor":after,"notifications":initial_notifications})).unwrap());
     loop{
      tokio::time::sleep(Duration::from_secs(2)).await;
      let Ok(actor)=auth.authenticate(&h,false).await else{break};
      if actor.sub!=a.sub||actor.tenant_id!=a.tenant_id||actor.scheduling().is_err(){break;}
      let result:Result<_>=async{
       let mut tx=auth.db.begin().await?;let b=binding(&mut tx,a.tenant_id).await?;
       let changed=b!=current_binding;
       let cursor=if changed{max_cursor(&mut tx,a.tenant_id).await?}else{after};
       let rows:Vec<Change>=sqlx::query_as("SELECT id,kind,resource_id,appointment_id,message_id,created_at FROM connect_update_events WHERE tenant_id=$1 AND id>$2 AND (installation_id IS NULL OR installation_id=$3) ORDER BY id LIMIT 100").bind(a.tenant_id).bind(cursor).bind(b.as_ref().map(|v|v.installation_id)).fetch_all(&mut *tx).await?;
       let snapshot=notification_snapshot(&mut tx,&actor,b.as_ref()).await?;tx.commit().await?;Ok((b,changed,cursor,rows,snapshot))
      }.await;
      let Ok((b,changed,cursor,rows,snapshot))=result else{break};
      if changed{current_binding=b;after=cursor;previous=snapshot.to_string();yield Ok(Event::default().event("reset").id(after.to_string()).json_data(json!({"cursor":after,"notifications":snapshot})).unwrap());}
      for row in rows{after=row.id;yield Ok(Event::default().event("service.change").id(row.id.to_string()).json_data(row).unwrap());}
      let text=snapshot.to_string();if text!=previous{previous=text.clone();yield Ok(Event::default().event("notifications").data(text));}
     }
    };
    Ok((
        [
            (axum::http::header::CACHE_CONTROL, "no-store"),
            (
                axum::http::header::HeaderName::from_static("x-accel-buffering"),
                "no",
            ),
        ],
        Sse::new(feed).keep_alive(KeepAlive::default()),
    ))
}
#[derive(sqlx::FromRow)]
struct Claim {
    tenant_id: Uuid,
    installation_id: Uuid,
    setting_id: Uuid,
    credential_revision: i64,
    cloud_cursor: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteEvent {
    id: i64,
    kind: String,
    resource_id: Uuid,
    #[serde(default)]
    message_id: Option<Uuid>,
    created_at: DateTime<Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    installation_id: Uuid,
    items: Vec<RemoteEvent>,
    next_cursor: i64,
    has_more: bool,
}
#[async_trait::async_trait]
pub trait EventTransport: Send + Sync {
    async fn fetch(&self, installation: Uuid, key: &str, after: i64) -> Result<Value>;
}
struct Cloud;
#[async_trait::async_trait]
impl EventTransport for Cloud {
    async fn fetch(&self, installation: Uuid, key: &str, after: i64) -> Result<Value> {
        let origin = crate::connect_onboarding::cloud_origin()?;
        let response = crate::stedi::client()?
            .get(format!(
                "{origin}/api/v1/ehr-services/installations/{installation}/events?after={after}"
            ))
            .bearer_auth(key)
            .send()
            .await
            .map_err(|_| Error::Invalid("Connect updates unavailable"))?;
        if !response.status().is_success() {
            return Err(Error::Invalid("Connect updates unavailable"));
        }
        serde_json::from_slice(&crate::stedi::bytes(response, 65536).await?)
            .map_err(|_| Error::Invalid("invalid Connect updates"))
    }
}
/// Advisory WSS notice. Cursor is never trusted to advance persisted progress.
pub async fn wake(db: &PgPool, tenant: Uuid, installation: Uuid, cursor: i64) -> Result<()> {
    if cursor < 0 {
        return Err(Error::Invalid("invalid Connect event cursor"));
    }
    sqlx::query("UPDATE connect_update_sync u SET next_attempt_at=clock_timestamp(),wake_cursor=greatest(u.wake_cursor,$3) WHERE u.tenant_id=$1 AND u.installation_id=$2 AND u.cloud_cursor<$3 AND EXISTS(SELECT 1 FROM connect_service_settings s WHERE s.tenant_id=u.tenant_id AND s.installation_id=u.installation_id AND s.id=u.setting_id AND s.credential_revision=u.credential_revision AND s.enabled AND s.verified AND NOT s.revoked)").bind(tenant).bind(installation).bind(cursor).execute(db).await?;
    notify().notify_one();
    Ok(())
}
async fn claim(db: &PgPool) -> Result<Option<(Claim, Uuid, crate::provider_settings::Secret)>> {
    let mut tx = db.begin().await?;
    sqlx::query("INSERT INTO connect_update_sync(tenant_id,installation_id,setting_id,credential_revision) SELECT tenant_id,installation_id,id,credential_revision FROM connect_service_settings WHERE enabled AND verified AND NOT revoked ON CONFLICT(tenant_id,installation_id) DO UPDATE SET setting_id=excluded.setting_id,credential_revision=excluded.credential_revision,lease_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp() WHERE connect_update_sync.credential_revision<>excluded.credential_revision OR connect_update_sync.setting_id<>excluded.setting_id").execute(&mut *tx).await?;
    let r:Option<Claim>=sqlx::query_as("SELECT u.tenant_id,u.installation_id,u.setting_id,u.credential_revision,u.cloud_cursor FROM connect_update_sync u JOIN connect_service_settings s ON s.tenant_id=u.tenant_id AND s.installation_id=u.installation_id AND s.id=u.setting_id AND s.credential_revision=u.credential_revision WHERE s.enabled AND s.verified AND NOT s.revoked AND u.next_attempt_at<=clock_timestamp() AND (u.lease_until IS NULL OR u.lease_until<clock_timestamp()) ORDER BY u.next_attempt_at LIMIT 1 FOR UPDATE OF u SKIP LOCKED").fetch_optional(&mut *tx).await?;
    let Some(r) = r else {
        tx.commit().await?;
        return Ok(None);
    };
    let lease = Uuid::new_v4();
    let (_, key) =
        crate::connect_services::pinned(&mut tx, r.tenant_id, r.setting_id, r.credential_revision)
            .await?;
    sqlx::query("UPDATE connect_update_sync SET lease_id=$3,lease_until=clock_timestamp()+interval '45 seconds' WHERE tenant_id=$1 AND installation_id=$2").bind(r.tenant_id).bind(r.installation_id).bind(lease).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some((r, lease, key)))
}
#[doc(hidden)]
pub async fn process_one_with_transport(
    db: &PgPool,
    transport: &dyn EventTransport,
) -> Result<bool> {
    let Some((claim, lease, key)) = claim(db).await? else {
        return Ok(false);
    };
    let result = match transport
        .fetch(claim.installation_id, key.expose(), claim.cloud_cursor)
        .await
    {
        Ok(value) => apply_page(db, &claim, lease, value).await,
        Err(error) => Err(error),
    };
    if result.is_err() {
        sqlx::query("UPDATE connect_update_sync SET lease_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+interval '30 seconds',last_result='unavailable' WHERE tenant_id=$1 AND installation_id=$2 AND lease_id=$3").bind(claim.tenant_id).bind(claim.installation_id).bind(lease).execute(db).await?;
    }
    result
}
async fn apply_page(db: &PgPool, claim: &Claim, lease: Uuid, value: Value) -> Result<bool> {
    let page: Page =
        serde_json::from_value(value).map_err(|_| Error::Invalid("invalid Connect event page"))?;
    if page.installation_id != claim.installation_id
        || page.items.len() > 100
        || page.next_cursor < claim.cloud_cursor
        || page
            .items
            .last()
            .map_or(page.next_cursor != claim.cloud_cursor, |last| {
                last.id != page.next_cursor
            })
        || page.has_more && page.items.is_empty()
    {
        return Err(Error::Invalid("invalid Connect event page"));
    }
    let mut previous = claim.cloud_cursor;
    for event in &page.items {
        if event.id <= previous
            || !["support.reply", "support.updated", "reminder.delivery"]
                .contains(&event.kind.as_str())
            || event.kind == "support.reply" && event.message_id.is_none()
        {
            return Err(Error::Invalid("invalid Connect event order"));
        }
        previous = event.id;
    }
    let mut tx = db.begin().await?;
    let mut actor = crate::delivery::worker(claim.tenant_id);
    actor.sub = Uuid::from_u128(0x53c40000000040008000000000000044);
    crate::scheduling::tenant_lock(&mut tx, &actor).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))")
        .bind(claim.tenant_id.to_string())
        .execute(&mut *tx)
        .await?;
    let current = binding(&mut tx, claim.tenant_id).await?;
    if current.as_ref()
        != Some(&Binding {
            id: claim.setting_id,
            installation_id: claim.installation_id,
            credential_revision: claim.credential_revision,
        })
    {
        return Err(Error::Conflict("Connect installation changed"));
    }
    let owned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_update_sync WHERE tenant_id=$1 AND installation_id=$2 AND lease_id=$3 AND cloud_cursor=$4 AND credential_revision=$5 FOR UPDATE)").bind(claim.tenant_id).bind(claim.installation_id).bind(lease).bind(claim.cloud_cursor).bind(claim.credential_revision).fetch_one(&mut *tx).await?;
    if !owned {
        return Err(Error::Conflict("Connect update lease changed"));
    }
    for event in page.items {
        let wrote=sqlx::query("INSERT INTO connect_remote_events(tenant_id,installation_id,cloud_id,kind,resource_id,message_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING").bind(claim.tenant_id).bind(claim.installation_id).bind(event.id).bind(&event.kind).bind(event.resource_id).bind(event.message_id).bind(event.created_at).execute(&mut *tx).await?;
        if wrote.rows_affected() == 0 {
            continue;
        }
        if event.kind == "reminder.delivery" {
            sqlx::query("UPDATE appointment_reminders r SET last_poll_at=NULL WHERE r.tenant_id=$1 AND r.id=$2 AND r.provider_id=$2 AND r.status IN('accepted','needs_review') AND EXISTS(SELECT 1 FROM reminder_credentials rc JOIN connect_service_credentials cc ON cc.tenant_id=rc.tenant_id AND cc.setting_id=rc.connect_setting_id AND cc.revision=rc.connect_revision WHERE rc.tenant_id=r.tenant_id AND rc.setting_id=r.sender_setting_id AND rc.revision=r.sender_revision AND rc.delivery_mode='suncharts_connect' AND cc.installation_id=$3)").bind(claim.tenant_id).bind(event.resource_id).bind(claim.installation_id).execute(&mut *tx).await?;
        } else {
            sqlx::query("INSERT INTO connect_update_events(tenant_id,installation_id,cloud_id,kind,resource_id,message_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(claim.tenant_id).bind(claim.installation_id).bind(event.id).bind(&event.kind).bind(event.resource_id).bind(event.message_id).bind(event.created_at).execute(&mut *tx).await?;
        }
        crate::postgres::audit(
            &mut tx,
            &actor,
            "connect.service_change_received",
            event.resource_id,
        )
        .await?;
    }
    sqlx::query("UPDATE connect_update_sync SET cloud_cursor=$4,lease_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+CASE WHEN $5 OR wake_cursor>$4 THEN interval '0 seconds' ELSE interval '15 seconds' END,last_result='verified' WHERE tenant_id=$1 AND installation_id=$2 AND lease_id=$3").bind(claim.tenant_id).bind(claim.installation_id).bind(lease).bind(page.next_cursor).bind(page.has_more).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}

pub async fn run(db: PgPool) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {_=tick.tick()=>{},_=notify().notified()=>{}}
        for _ in 0..100 {
            match process_one_with_transport(&db, &Cloud).await {
                Ok(true) => {}
                _ => break,
            }
        }
    }
}
