// SPDX-License-Identifier: AGPL-3.0-only
//! Outbound, installation-bound Connect transport. The channel never supplies
//! clinical authority: each request traverses the ordinary OAuth router.
use crate::{
    error::{Error, Result},
    State,
};
use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, Uri},
    response::IntoResponse,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::{
    collections::{BTreeMap, HashSet},
    time::Duration,
};
use tokio::sync::watch;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
};
use tower::ServiceExt;
use uuid::Uuid;
use zeroize::Zeroize;
const BODY_LIMIT: usize = 2 * 1024 * 1024;
const FRAME_LIMIT: usize = 3 * 1024 * 1024;
#[derive(sqlx::FromRow)]
struct Binding {
    tenant_id: Uuid,
    id: Uuid,
    client_id: Uuid,
    status: String,
    encrypted_pending: Vec<u8>,
    connect_installation_id: Option<Uuid>,
}
#[derive(Deserialize)]
struct Pending {
    #[serde(default)]
    relay_token: String,
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.relay_token.zeroize();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub version: u8,
    pub r#type: String,
    pub id: Uuid,
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body_base64: String,
    pub expires_at: DateTime<Utc>,
}
#[derive(Serialize)]
pub struct Reply {
    pub version: u8,
    pub r#type: &'static str,
    pub id: Uuid,
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body_base64: String,
}
impl Reply {
    fn failure(id: Uuid, status: u16) -> Self {
        Self {
            version: 1,
            r#type: "response",
            id,
            status,
            headers: BTreeMap::new(),
            body_base64: String::new(),
        }
    }
}
/// No browser/session, arbitrary URL, streaming endpoint or administration route
/// can be entered from the channel. Authorization headers are never synthesized.
fn permitted(method: &Method, path: &str) -> bool {
    if path == "/.well-known/oauth-authorization-server" {
        return *method == Method::GET;
    }
    if ["/oauth/token", "/oauth/revoke"].contains(&path) {
        return *method == Method::POST;
    }
    if ![
        Method::GET,
        Method::POST,
        Method::PUT,
        Method::PATCH,
        Method::DELETE,
        Method::HEAD,
    ]
    .contains(method)
    {
        return false;
    }
    if path.starts_with("/fhir/") {
        return true;
    }
    if !path.starts_with("/api/v1/") {
        return false;
    }
    if path == "/api/v1/events/stream" {
        return false;
    }
    let rest = path.trim_start_matches("/api/v1/");
    if rest.starts_with("schedule/reminder-settings")
        || rest.starts_with("billing/payment-settings")
        || rest.starts_with("billing/providers")
    {
        return false;
    }
    [
        "patients",
        "visits",
        "appointments",
        "schedule",
        "labs",
        "referrals",
        "follow-up",
        "billing",
        "migrations",
        "events",
        "connection",
    ]
    .iter()
    .any(|p| rest == *p || rest.starts_with(&format!("{p}/")))
}
async fn bound(db: &PgPool, b: &Binding) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_onboarding_intents i JOIN oauth_clients c ON c.id=i.client_id AND c.tenant_id=i.tenant_id JOIN browser_users u ON u.id=i.actor_id AND u.tenant_id=i.tenant_id WHERE i.id=$1 AND i.tenant_id=$2 AND NOT c.disabled AND NOT u.disabled AND u.role='owner' AND i.transport='outbound_websocket' AND ((i.status IN ('preparing','awaiting_approval','callback_received','exchanged','completing') AND i.expires_at>clock_timestamp()) OR (i.status='completed' AND EXISTS(SELECT 1 FROM connect_service_settings s WHERE s.tenant_id=i.tenant_id AND s.installation_id=i.connect_installation_id AND s.enabled AND s.verified AND NOT s.revoked))))")
      .bind(b.id).bind(b.tenant_id).fetch_one(db).await?)
}
/// Execute a bounded command only for the channel's tenant and OAuth client.
/// Exposed for protocol conformance tests; callers cannot select a different actor.
pub async fn execute(state: &State, tenant: Uuid, intent: Uuid, command: Command) -> Reply {
    let id = command.id;
    match execute_inner(state, tenant, intent, command).await {
        Ok(r) => r,
        Err(e) => {
            let status = e.into_response().status().as_u16();
            Reply::failure(id, status)
        }
    }
}
async fn execute_inner(state: &State, tenant: Uuid, intent: Uuid, c: Command) -> Result<Reply> {
    let db = &state.browser.as_ref().ok_or(Error::NotFound)?.db;
    let b:Binding=sqlx::query_as("SELECT tenant_id,id,client_id,status,encrypted_pending,connect_installation_id FROM connect_onboarding_intents WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(intent).fetch_optional(db).await?.ok_or(Error::Unauthorized)?;
    if !bound(db, &b).await? {
        return Err(Error::Unauthorized);
    }
    if c.version != 1
        || c.r#type != "request"
        || c.expires_at <= Utc::now()
        || c.expires_at > Utc::now() + chrono::Duration::seconds(60)
        || c.path.len() > 4096
        || c.body_base64.len() > BODY_LIMIT.div_ceil(3) * 4
    {
        return Err(Error::Invalid("invalid Connect request"));
    }
    let method: Method = c
        .method
        .parse()
        .map_err(|_| Error::Invalid("invalid Connect method"))?;
    let uri: Uri = c
        .path
        .parse()
        .map_err(|_| Error::Invalid("invalid Connect path"))?;
    if uri.scheme().is_some()
        || uri.authority().is_some()
        || !c.path.starts_with('/')
        || uri.path().contains('%')
        || uri.path().contains("..")
        || uri.path().contains("//")
        || !permitted(&method, uri.path())
    {
        return Err(Error::Forbidden);
    }
    if c.headers.len() > 6
        || c.headers.iter().any(|(k, v)| {
            ![
                "authorization",
                "accept",
                "content-type",
                "if-match",
                "x-change-reason",
                "if-none-match",
            ]
            .contains(&k.as_str())
                || v.len() > 8192
                || v.chars().any(|x| x == '\r' || x == '\n' || x == '\0')
        })
    {
        return Err(Error::Forbidden);
    }
    let authorization = c.headers.get("authorization");
    if ["/oauth/token", "/oauth/revoke"].contains(&uri.path()) {
        let encoded = authorization
            .and_then(|s| s.strip_prefix("Basic "))
            .ok_or(Error::Unauthorized)?;
        let decoded = STANDARD.decode(encoded).map_err(|_| Error::Unauthorized)?;
        let decoded =
            zeroize::Zeroizing::new(String::from_utf8(decoded).map_err(|_| Error::Unauthorized)?);
        if decoded
            .split_once(':')
            .and_then(|(cid, _)| Uuid::parse_str(cid).ok())
            != Some(b.client_id)
        {
            return Err(Error::Forbidden);
        }
    } else if uri.path() != "/.well-known/oauth-authorization-server" {
        let token = authorization
            .and_then(|s| s.strip_prefix("Bearer sce_at_"))
            .map(|s| format!("sce_at_{s}"))
            .ok_or(Error::Unauthorized)?;
        let scoped:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.hash=$1 AND g.tenant_id=$2 AND g.client_id=$3)").bind(crate::oauth::hash(&token)).bind(tenant).bind(b.client_id).fetch_one(db).await?;
        if !scoped {
            return Err(Error::Forbidden);
        }
        crate::oauth::authenticate(state, &token, &method, uri.path()).await?;
    }
    let bytes = STANDARD
        .decode(&c.body_base64)
        .map_err(|_| Error::Invalid("invalid Connect payload"))?;
    if bytes.len() > BODY_LIMIT {
        return Err(Error::Invalid("Connect payload too large"));
    }
    let mut request = Request::builder().method(method).uri(uri);
    for (k, v) in c.headers {
        request = request.header(k, v);
    }
    let request = request
        .body(Body::from(bytes))
        .map_err(|_| Error::Invalid("invalid Connect headers"))?;
    let response = match tokio::time::timeout(
        Duration::from_secs(20),
        crate::app(state.clone()).oneshot(request),
    ).await {
        Ok(Ok(response))=>response,
        _=>return Ok(Reply { version:1,r#type:"response",id:c.id,status:504,headers:BTreeMap::from([("content-type".into(),"application/json".into())]),body_base64:STANDARD.encode(br#"{"error":"outcome_unknown","message":"The request outcome is unknown. Reconcile the record before retrying a write."}"#) })
    };
    let status = response.status().as_u16();
    let mut headers = BTreeMap::new();
    for name in ["content-type", "etag", "location", "www-authenticate"] {
        if let Some(value) = response.headers().get(name).and_then(|v| v.to_str().ok()) {
            headers.insert(name.into(), value.to_owned());
        }
    }
    let body = to_bytes(response.into_body(), BODY_LIMIT)
        .await
        .map_err(|_| Error::Invalid("Connect response too large"))?;
    Ok(Reply {
        version: 1,
        r#type: "response",
        id: c.id,
        status,
        headers,
        body_base64: STANDARD.encode(body),
    })
}
async fn credential(db: &PgPool, b: &Binding) -> Result<crate::provider_settings::Secret> {
    if b.status == "completed" {
        let (setting,encrypted):(Uuid,Vec<u8>)=sqlx::query_as("SELECT s.id,c.encrypted_token FROM connect_service_settings s JOIN connect_service_credentials c ON c.tenant_id=s.tenant_id AND c.setting_id=s.id AND c.revision=s.credential_revision WHERE s.tenant_id=$1 AND s.enabled AND s.verified AND NOT s.revoked").bind(b.tenant_id).fetch_optional(db).await?.ok_or(Error::Unauthorized)?;
        return crate::provider_settings::open_secret(
            b.tenant_id,
            setting,
            "connect-service",
            &encrypted,
        );
    }
    // Parse into a zeroizing type; never expose the channel credential publicly.
    crate::provider_settings::open_secret(
        b.tenant_id,
        b.id,
        "connect-onboarding",
        &b.encrypted_pending,
    )
}
fn socket_url() -> Result<String> {
    let origin = crate::connect_onboarding::cloud_origin()?;
    let mut url =
        url::Url::parse(&origin).map_err(|_| Error::Invalid("invalid Connect cloud URL"))?;
    url.set_scheme(if origin.starts_with("https:") {
        "wss"
    } else {
        "ws"
    })
    .map_err(|_| Error::Invalid("invalid Connect scheme"))?;
    url.set_path("/api/v1/ehr-pairing/channel");
    Ok(url.to_string())
}
async fn health(db: &PgPool, b: &Binding, session: Uuid, state: &str, seen: bool) -> Result<()> {
    sqlx::query("UPDATE connect_transport_health SET state=$4,last_seen_at=CASE WHEN $5 THEN clock_timestamp() ELSE last_seen_at END,updated_at=clock_timestamp() WHERE tenant_id=$1 AND intent_id=$2 AND session_id=$3 AND EXISTS(SELECT 1 FROM connect_onboarding_intents i WHERE i.tenant_id=$1 AND i.id=$2 AND i.status=$6)").bind(b.tenant_id).bind(b.id).bind(session).bind(state).bind(seen).bind(&b.status).execute(db).await?;
    Ok(())
}
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
async fn send(socket: &mut Socket, message: Message) -> Result<()> {
    // A stalled peer must not retain a worker forever. In particular, failure to
    // deliver a mutation response never retries the already-dispatched request.
    tokio::time::timeout(Duration::from_secs(10), socket.send(message))
        .await
        .map_err(|_| Error::Invalid("Connect channel write timed out"))?
        .map_err(|_| Error::Invalid("Connect channel closed"))
}
async fn close(socket: &mut Socket) {
    let _ = tokio::time::timeout(Duration::from_secs(2), socket.close(None)).await;
}
async fn connection(
    state: &State,
    b: &Binding,
    session: Uuid,
    stop: &mut watch::Receiver<bool>,
) -> Result<()> {
    let db = &state.browser.as_ref().ok_or(Error::NotFound)?.db;
    if !bound(db, b).await? {
        return Err(Error::Unauthorized);
    }
    let secret = credential(db, b).await?;
    let pending = if b.status != "completed" {
        Some(serde_json::from_str::<Pending>(secret.expose()).map_err(|_| Error::Unauthorized)?)
    } else {
        None
    };
    let token = pending
        .as_ref()
        .map_or(secret.expose(), |p| p.relay_token.as_str());
    if token.len() < 32 {
        return Err(Error::Unauthorized);
    }
    let mut request = socket_url()?
        .into_client_request()
        .map_err(|_| Error::Invalid("Connect channel unavailable"))?;
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {token}")
            .parse()
            .map_err(|_| Error::Unauthorized)?,
    );
    request.headers_mut().insert(
        "x-suncharts-service-events",
        axum::http::HeaderValue::from_static("1"),
    );
    request.headers_mut().insert(
        "x-suncharts-request-id",
        b.id.to_string().parse().map_err(|_| Error::Unauthorized)?,
    );
    let config = WebSocketConfig::default()
        .max_message_size(Some(FRAME_LIMIT))
        .max_frame_size(Some(FRAME_LIMIT));
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        connect_async_with_config(request, Some(config), false),
    )
    .await
    .map_err(|_| Error::Invalid("Connect channel unavailable"))?
    .map_err(|_| Error::Invalid("Connect channel unavailable"))?;
    let mut last = std::time::Instant::now();
    let mut check = tokio::time::interval(Duration::from_secs(3));
    let mut seen_ids = HashSet::new();
    loop {
        tokio::select! {
            _=stop.changed()=>{if *stop.borrow(){close(&mut socket).await;return Ok(());}},
            _=check.tick()=>{
                if last.elapsed()>Duration::from_secs(45)||!bound(db,b).await?{return Err(Error::Unauthorized);}
                let current:String=sqlx::query_scalar("SELECT status FROM connect_onboarding_intents WHERE tenant_id=$1 AND id=$2").bind(b.tenant_id).bind(b.id).fetch_one(db).await?;
                if current!=b.status{return Ok(());}
                sqlx::query("UPDATE connect_transport_health SET updated_at=clock_timestamp() WHERE tenant_id=$1 AND intent_id=$2 AND session_id=$3").bind(b.tenant_id).bind(b.id).bind(session).execute(db).await?;
            },
            message=socket.next()=>{
                match message {
                    Some(Ok(Message::Text(text)))=>{
                        let value:Value=serde_json::from_str(&text).map_err(|_|Error::Invalid("invalid Connect frame"))?;
                        if value["version"]!=1{return Err(Error::Invalid("unsupported Connect protocol"));}
                        match value["type"].as_str(){
                            Some("heartbeat")=>{
                                let id=value["id"].as_str().and_then(|v|Uuid::parse_str(v).ok()).ok_or(Error::Invalid("invalid Connect heartbeat"))?;
                                send(&mut socket,Message::Text(json!({"version":1,"type":"heartbeat_ack","id":id}).to_string().into())).await?;
                            },
                            Some("connected")=>{if b.status=="completed" && value["installation_id"]!=json!(b.connect_installation_id){return Err(Error::Unauthorized);}last=std::time::Instant::now();health(db,b,session,"connected",true).await?;},
                            Some("service_events_available")=>{
                                let installation=value["installation_id"].as_str().and_then(|v|Uuid::parse_str(v).ok()).ok_or(Error::Invalid("invalid Connect service installation"))?;
                                let cursor=value["cursor"].as_i64().filter(|v|*v>=0).ok_or(Error::Invalid("invalid Connect service cursor"))?;
                                if b.status!="completed" || Some(installation)!=b.connect_installation_id{return Err(Error::Unauthorized);}
                                crate::connect_updates::wake(db,b.tenant_id,installation,cursor).await?;
                            },
                            Some("request")=>{
                                let c:Command=serde_json::from_value(value).map_err(|_|Error::Invalid("invalid Connect command"))?;
                                if seen_ids.len()>=1024{return Err(Error::Invalid("Connect session renewal required"));}
                                let reply=if seen_ids.insert(c.id){execute(state,b.tenant_id,b.id,c).await}else{Reply::failure(c.id,409)};
                                send(&mut socket,Message::Text(serde_json::to_string(&reply).map_err(|_|Error::Invalid("Connect response unavailable"))?.into())).await?;
                            },
                            _=>return Err(Error::Invalid("invalid Connect frame type"))
                        }
                    },
                    Some(Ok(Message::Ping(bytes)))=>{send(&mut socket,Message::Pong(bytes)).await?;},
                    Some(Ok(Message::Pong(_)))=>{},
                    _=>return Err(Error::Invalid("Connect channel closed"))
                }
            }
        }
    }
}
async fn worker(
    state: State,
    tenant: Uuid,
    id: Uuid,
    session: Uuid,
    mut stop: watch::Receiver<bool>,
) {
    let Some(browser) = state.browser.as_ref() else {
        return;
    };
    let db = &browser.db;
    let mut backoff = 1;
    loop {
        if *stop.borrow() {
            break;
        }
        let b:Option<Binding>=sqlx::query_as("SELECT tenant_id,id,client_id,status,encrypted_pending,connect_installation_id FROM connect_onboarding_intents WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).fetch_optional(db).await.ok().flatten();
        let Some(b) = b else { break };
        if !bound(db, &b).await.unwrap_or(false) {
            let _ = health(db, &b, session, "offline", false).await;
            break;
        }
        // A different process owns a newer session: never compete with it.
        let owned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_transport_health WHERE tenant_id=$1 AND intent_id=$2 AND session_id=$3)").bind(tenant).bind(id).bind(session).fetch_one(db).await.unwrap_or(false);
        if !owned {
            break;
        }
        let _ = health(db, &b, session, "connecting", false).await;
        let _ = connection(&state, &b, session, &mut stop).await;
        let _ = health(db, &b, session, "offline", false).await;
        if *stop.borrow() {
            break;
        }
        tokio::select! {_=tokio::time::sleep(Duration::from_secs(backoff))=>{},_=stop.changed()=>{}}
        backoff = (backoff * 2).min(15);
    }
}
/// Runs until explicitly stopped; child connection tasks cannot outlive shutdown.
pub async fn run_with_shutdown(state: State, mut stop: watch::Receiver<bool>) {
    let Some(browser) = state.browser.as_ref() else {
        return;
    };
    let db = browser.db.clone();
    let mut workers = tokio::task::JoinSet::new();
    let mut sessions = Vec::new();
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
          _=stop.changed()=>{if *stop.borrow(){break;}},
          _=workers.join_next(),if !workers.is_empty()=>{},
          _=tick.tick()=>{
            let rows:Vec<Binding>=sqlx::query_as("SELECT tenant_id,id,client_id,status,encrypted_pending,connect_installation_id FROM connect_onboarding_intents WHERE transport='outbound_websocket' AND ((status IN ('preparing','awaiting_approval','callback_received','exchanged','completing') AND expires_at>clock_timestamp()) OR status='completed') ORDER BY created_at DESC LIMIT 100").fetch_all(&db).await.unwrap_or_default();
            for b in rows{
                if !bound(&db,&b).await.unwrap_or(false){continue;}
                let session=Uuid::new_v4();
                let claimed=sqlx::query("INSERT INTO connect_transport_health(tenant_id,intent_id,session_id,state) VALUES($1,$2,$3,'connecting') ON CONFLICT(tenant_id,intent_id) DO UPDATE SET session_id=$3,state='connecting',last_seen_at=NULL,updated_at=clock_timestamp() WHERE connect_transport_health.updated_at<clock_timestamp()-interval '45 seconds'").bind(b.tenant_id).bind(b.id).bind(session).execute(&db).await;
                if claimed.is_ok_and(|r|r.rows_affected()==1){sessions.push(session);workers.spawn(worker(state.clone(),b.tenant_id,b.id,session,stop.clone()));}
            }
          }
        }
    }
    // Give workers the chance to mark themselves offline before stopping them.
    while workers.join_next().await.is_some() {}
    sqlx::query("UPDATE connect_transport_health SET updated_at=clock_timestamp()-interval '46 seconds' WHERE state='offline' AND session_id=ANY($1)").bind(&sessions).execute(&db).await.ok();
}
pub async fn run(state: State) {
    let (_sender, receiver) = watch::channel(false);
    run_with_shutdown(state, receiver).await;
}
type HealthRow = (String, Option<DateTime<Utc>>, String, bool, Uuid);
pub async fn status(db: &PgPool, tenant: Uuid) -> Result<Value> {
    let row:Option<HealthRow>=sqlx::query_as("SELECT coalesce(h.state,'offline'),h.last_seen_at,i.status,coalesce(h.updated_at>clock_timestamp()-interval '45 seconds',false),i.id FROM connect_onboarding_intents i LEFT JOIN connect_transport_health h ON h.tenant_id=i.tenant_id AND h.intent_id=i.id WHERE i.tenant_id=$1 AND i.transport='outbound_websocket' AND i.status NOT IN ('cancelled','denied','failed','cancelling') AND (i.status='completed' OR i.expires_at>clock_timestamp()) ORDER BY i.created_at DESC LIMIT 1").bind(tenant).fetch_optional(db).await?;
    let Some((state, last_seen, pairing, fresh, intent)) = row else {
        return Ok(
            json!({"configured":false,"authorized":false,"state":"not_configured","transport":"outbound_websocket","last_seen_at":null}),
        );
    };
    let binding:Binding=sqlx::query_as("SELECT tenant_id,id,client_id,status,encrypted_pending,connect_installation_id FROM connect_onboarding_intents WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(intent).fetch_one(db).await?;
    let live = bound(db, &binding).await?;
    let authorized:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_onboarding_intents i JOIN oauth_grants g ON g.client_id=i.client_id AND g.tenant_id=i.tenant_id AND g.user_id=i.actor_id WHERE i.tenant_id=$1 AND i.id=$2 AND g.revoked_at IS NULL AND string_to_array(g.scope,' ') @> string_to_array('clinical.read clinical.write billing.read billing.write events.read migration.manage offline_access',' ') AND EXISTS(SELECT 1 FROM oauth_tokens t WHERE t.grant_id=g.id AND t.expires_at>clock_timestamp() AND t.used_at IS NULL))").bind(tenant).bind(intent).fetch_one(db).await?;
    let authorized = live && pairing == "completed" && authorized;
    let connected = live
        && pairing == "completed"
        && state == "connected"
        && fresh
        && last_seen.is_some_and(|t| t > Utc::now() - chrono::Duration::seconds(45));
    Ok(
        json!({"configured":true,"authorized":authorized,"state":if connected{"connected"}else if live && fresh && state!="offline"{"reconnecting"}else{"offline"},"transport":"outbound_websocket","last_seen_at":last_seen,"pairing_status":pairing}),
    )
}
