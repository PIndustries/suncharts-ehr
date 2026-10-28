// SPDX-License-Identifier: AGPL-3.0-only
//! Browser-session-bound, server-to-server SunCharts onboarding. No client secret enters browser state.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
const CLOUD: &str = "https://my.suncharts.app";
pub fn cloud_origin() -> Result<String> {
    let origin = std::env::var("ENGINE_CONNECT_CLOUD_URL").unwrap_or_else(|_| CLOUD.into());
    if origin == CLOUD {
        return Ok(origin);
    }
    let u = url::Url::parse(&origin).map_err(|_| Error::Invalid("invalid Connect cloud URL"))?;
    let loopback = matches!(u.host(),Some(url::Host::Ipv4(ip)) if ip.is_loopback())
        || matches!(u.host(),Some(url::Host::Ipv6(ip)) if ip.is_loopback());
    if std::env::var("ENGINE_CONNECT_ALLOW_LOOPBACK").as_deref() != Ok("true")
        || !loopback
        || u.scheme() != "http"
        || u.path() != "/"
        || u.query().is_some()
        || u.fragment().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err(Error::Invalid("Connect cloud must be SunCharts HTTPS; loopback requires explicit development configuration"));
    }
    Ok(origin.trim_end_matches('/').to_owned())
}

const SCOPE:&str="clinical.read clinical.write billing.read billing.write events.read migration.manage offline_access";
#[async_trait::async_trait]
pub trait OnboardingCloud: Send + Sync {
    async fn post(&self, path: &str, body: &Value, bearer: Option<&str>) -> Result<Value>;
}
struct Cloud;
#[async_trait::async_trait]
impl OnboardingCloud for Cloud {
    async fn post(&self, path: &str, body: &Value, bearer: Option<&str>) -> Result<Value> {
        let mut q = crate::stedi::client()?
            .post(format!("{}{path}", cloud_origin()?))
            .json(body);
        if let Some(token) = bearer {
            q = q.bearer_auth(token);
        }
        let r = q.send().await.map_err(|_| {
            Error::Invalid("SunCharts connection is temporarily unavailable; resume this attempt")
        })?;
        if !r.status().is_success() {
            return Err(Error::Invalid(
                "SunCharts did not complete this connection; resume or cancel the attempt",
            ));
        }
        let bytes = crate::stedi::bytes(r, 65536).await?;
        serde_json::from_slice(&bytes)
            .map_err(|_| Error::Invalid("invalid SunCharts onboarding response"))
    }
}
#[derive(sqlx::FromRow)]
struct Intent {
    tenant_id: Uuid,
    id: Uuid,
    actor_id: Uuid,
    session_hash: String,
    issuer: String,
    client_id: Uuid,
    encrypted_pending: Vec<u8>,
    expected_service_version: i64,
    expected_reminder_version: i64,
    request_uri: Option<String>,
    authorization_url: Option<String>,
    encrypted_callback: Option<Vec<u8>>,
    callback_hash: Option<String>,
    encrypted_exchange: Option<Vec<u8>>,
    status: String,
    transport: String,
    version: i64,
    expires_at: DateTime<Utc>,
    lease_until: Option<DateTime<Utc>>,
}
impl Intent {
    fn public(&self) -> Value {
        let status = if self.expires_at < Utc::now()
            && !["completed", "cancelled", "denied", "failed"].contains(&self.status.as_str())
        {
            "expired"
        } else {
            self.status.as_str()
        };
        json!({"id":self.id,"status":status,"version":self.version,"expires_at":self.expires_at,"authorization_url":self.authorization_url,"transport":self.transport,"cloud_origin":cloud_origin().ok()})
    }
}
#[derive(Deserialize, Serialize)]
struct Pending {
    state: String,
    verifier: String,
    client_secret: String,
    #[serde(default)]
    relay_token: String,
}
impl Drop for Pending {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.state.zeroize();
        self.verifier.zeroize();
        self.client_secret.zeroize();
        self.relay_token.zeroize();
    }
}
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
async fn owner(s: &State, h: &HeaderMap, write: bool) -> Result<(Actor, String)> {
    let b = s.browser.as_ref().ok_or(Error::NotFound)?;
    let a = b.authenticate(h, write).await?;
    if !matches!(a.role, Role::Owner) {
        return Err(Error::Forbidden);
    }
    let token = h
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.split(';')
                .find_map(|s| s.trim().strip_prefix("sce_session="))
        })
        .ok_or(Error::Unauthorized)?;
    Ok((a, crate::oauth::hash(token)))
}
async fn lock(tx: &mut Transaction<'_, Postgres>, a: &Actor) -> Result<()> {
    crate::scheduling::tenant_lock(tx, a).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))")
        .bind(a.tenant_id.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn row(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Intent> {
    sqlx::query_as("SELECT * FROM connect_onboarding_intents WHERE tenant_id=$1 AND actor_id=$2 AND id=$3 FOR UPDATE").bind(a.tenant_id).bind(a.sub).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    action: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO connect_onboarding_events(tenant_id,intent_id,version,actor_id,action) SELECT tenant_id,id,version,$3,$4 FROM connect_onboarding_intents WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(a.sub).bind(action).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, action, id).await
}
async fn versions(tx: &mut Transaction<'_, Postgres>, tenant: Uuid) -> Result<(i64, i64)> {
    Ok(sqlx::query_as("SELECT coalesce((SELECT version FROM connect_service_settings WHERE tenant_id=$1),0),coalesce((SELECT version FROM reminder_sender_settings WHERE tenant_id=$1),0)").bind(tenant).fetch_one(&mut **tx).await?)
}
fn pending(r: &Intent) -> Result<Pending> {
    let secret = crate::provider_settings::open_secret(
        r.tenant_id,
        r.id,
        "connect-onboarding",
        &r.encrypted_pending,
    )?;
    serde_json::from_str(secret.expose())
        .map_err(|_| Error::Invalid("pending connection cannot be restored"))
}
fn bound(r: &Intent, a: &Actor, session: &str) -> Result<()> {
    if r.actor_id != a.sub || r.tenant_id != a.tenant_id || r.session_hash != session {
        return Err(Error::Forbidden);
    }
    if r.expires_at < Utc::now() {
        return Err(Error::Conflict(
            "connection attempt expired; cancel it and start again",
        ));
    }
    Ok(())
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/connect/onboarding", get(status).post(begin))
        .route("/api/v1/connect/onboarding/{id}/complete", post(complete))
        .route("/api/v1/connect/onboarding/{id}/cancel", post(cancel))
        .route(
            "/connect/onboarding/callback",
            get(callback).layer(axum::middleware::map_response(callback_privacy)),
        )
}
async fn status(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let (a, _) = owner(&s, &h, false).await?;
    let mut tx = db(&s)?.begin().await?;
    let pending:Option<Intent>=sqlx::query_as("SELECT * FROM connect_onboarding_intents WHERE tenant_id=$1 AND actor_id=$2 ORDER BY created_at DESC LIMIT 1").bind(a.tenant_id).bind(a.sub).fetch_optional(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "connect.onboarding_read", a.tenant_id).await?;
    tx.commit().await?;
    let origin = s.browser.as_ref().ok_or(Error::NotFound)?.origin();
    let ready = crate::provider_settings::credential_storage_ready(db(&s)?).await?;
    let available = ready && cloud_origin().is_ok();
    Ok(Json(
        json!({"available":available,"reason":if !ready {Some("Restore the credential encryption key before connecting.")}else if cloud_origin().is_err(){Some("The SunCharts connection service is not configured correctly.")}else{None},"public_origin":origin,"cloud_origin":cloud_origin().ok(),"transport":"outbound_websocket","pending":pending.map(|r|r.public())}),
    ))
}
async fn begin(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    begin_with_cloud(&s, &h, &Cloud).await.map(Json)
}
#[doc(hidden)]
pub async fn begin_with_cloud(
    s: &State,
    h: &HeaderMap,
    cloud: &dyn OnboardingCloud,
) -> Result<Value> {
    let (a, session) = owner(s, h, true).await?;
    let issuer = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .origin()
        .to_owned();
    let cloud_origin = cloud_origin()?;
    let redirect = format!("{cloud_origin}/oauth/ehr/callback");
    let mut tx = db(s)?.begin().await?;
    lock(&mut tx, &a).await?;
    let existing:Option<Intent>=sqlx::query_as("SELECT * FROM connect_onboarding_intents WHERE tenant_id=$1 AND actor_id=$2 AND status IN ('preparing','awaiting_approval','callback_received','exchanged','completing','cancelling') FOR UPDATE").bind(a.tenant_id).bind(a.sub).fetch_optional(&mut *tx).await?;
    let r = if let Some(r) = existing {
        bound(&r, &a, &session)?;
        if r.status != "preparing" {
            tx.commit().await?;
            return Ok(r.public());
        }
        r
    } else {
        let id = Uuid::new_v4();
        let client = Uuid::new_v4();
        let secret = Pending {
            state: crate::oauth::random("sce_pair_"),
            verifier: crate::oauth::random(""),
            client_secret: crate::oauth::random("sce_cs_"),
            relay_token: crate::oauth::random("sce_relay_"),
        };
        let encrypted = crate::provider_settings::seal_secret(
            db(s)?,
            a.tenant_id,
            id,
            "connect-onboarding",
            &serde_json::to_string(&secret)
                .map_err(|_| Error::Invalid("cannot prepare connection"))?,
        )
        .await?;
        let (v1, v2) = versions(&mut tx, a.tenant_id).await?;
        sqlx::query("INSERT INTO oauth_clients(id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES($1,$2,'SunCharts automatic connection',$3,$4,$5)").bind(client).bind(a.tenant_id).bind(crate::oauth::hash(&secret.client_secret)).bind(&redirect).bind(SCOPE).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO connect_onboarding_intents(tenant_id,id,actor_id,session_hash,state_hash,issuer,client_id,encrypted_pending,expected_service_version,expected_reminder_version,status,expires_at,transport) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'preparing',now()+interval '10 minutes','outbound_websocket')").bind(a.tenant_id).bind(id).bind(a.sub).bind(&session).bind(crate::oauth::hash(&secret.state)).bind(&issuer).bind(client).bind(encrypted).bind(v1).bind(v2).execute(&mut *tx).await?;
        event(&mut tx, &a, id, "connect.onboarding_started").await?;
        row(&mut tx, &a, id).await?
    };
    tx.commit().await?;
    let secret = pending(&r)?;
    let response=cloud.post("/api/v1/ehr-pairing/requests",&json!({"request_id":r.id,"ehr_origin":r.issuer,"remote_tenant_id":a.tenant_id,"remote_user_id":a.sub,"client_id":r.client_id,"client_secret":secret.client_secret,"code_challenge":crate::oauth::challenge(&secret.verifier),"code_challenge_method":"S256","state":secret.state,"transport":r.transport,"relay_token":secret.relay_token}),None).await?;
    let uri = response["request_uri"]
        .as_str()
        .filter(|v| {
            v.starts_with("epr_")
                && v.len() < 256
                && v.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        })
        .ok_or(Error::Invalid("invalid SunCharts approval reference"))?;
    let mut expected = url::Url::parse(&format!("{cloud_origin}/connect/ehr"))
        .map_err(|_| Error::Invalid("invalid approval destination"))?;
    expected.query_pairs_mut().append_pair("request", uri);
    if response["authorization_url"] != expected.as_str() {
        return Err(Error::Invalid("unexpected SunCharts approval destination"));
    }
    let mut tx = db(s)?.begin().await?;
    lock(&mut tx, &a).await?;
    let current = row(&mut tx, &a, r.id).await?;
    bound(&current, &a, &session)?;
    if current.status == "preparing" {
        sqlx::query("UPDATE connect_onboarding_intents SET request_uri=$3,authorization_url=$4,status='awaiting_approval',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(r.id).bind(uri).bind(expected.as_str()).execute(&mut *tx).await?;
        event(&mut tx, &a, r.id, "connect.onboarding_approval_staged").await?;
    }
    let out = row(&mut tx, &a, r.id).await?;
    tx.commit().await?;
    Ok(out.public())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Callback {
    pub code: Option<String>,
    pub state: String,
    pub iss: String,
    pub error: Option<String>,
}
async fn callback_privacy(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}
async fn callback(
    ExtractState(s): ExtractState<State>,
    Query(q): Query<Callback>,
) -> Result<Response> {
    let id = stage_callback(&s, q).await?;
    let location = format!(
        "{}/?connect_onboarding={id}",
        s.browser.as_ref().ok_or(Error::NotFound)?.origin()
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        header::LOCATION,
        HeaderValue::from_str(&location)
            .map_err(|_| Error::Invalid("invalid callback destination"))?,
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    Ok((axum::http::StatusCode::SEE_OTHER, headers).into_response())
}
#[doc(hidden)]
pub async fn stage_callback(s: &State, q: Callback) -> Result<Uuid> {
    if q.iss != cloud_origin()?
        || q.state.len() > 128
        || q.code.as_ref().is_some_and(|c| c.len() > 512)
        || q.error.as_deref().is_some_and(|e| e != "access_denied")
        || q.code.is_some() == q.error.is_some()
    {
        return Err(Error::Unauthorized);
    }
    let mut tx = db(s)?.begin().await?;
    let tenant: Uuid =
        sqlx::query_scalar("SELECT tenant_id FROM connect_onboarding_intents WHERE state_hash=$1")
            .bind(crate::oauth::hash(&q.state))
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::Unauthorized)?;
    let mut system = crate::delivery::worker(tenant);
    system.sub = Uuid::from_u128(0x53c40000000040008000000000000031);
    lock(&mut tx, &system).await?;
    let r: Intent =
        sqlx::query_as("SELECT * FROM connect_onboarding_intents WHERE state_hash=$1 FOR UPDATE")
            .bind(crate::oauth::hash(&q.state))
            .fetch_one(&mut *tx)
            .await?;
    if r.expires_at < Utc::now() {
        return Err(Error::Conflict("connection attempt expired"));
    }
    let callback_hash = crate::oauth::hash(q.code.as_deref().unwrap_or("access_denied"));
    if r.status != "awaiting_approval" {
        if r.callback_hash.as_deref() == Some(&callback_hash) {
            tx.commit().await?;
            return Ok(r.id);
        }
        return Err(Error::Conflict(
            "callback already received or attempt no longer active",
        ));
    }
    if q.error.is_some() {
        sqlx::query("UPDATE oauth_clients SET disabled=true WHERE id=$1 AND tenant_id=$2")
            .bind(r.client_id)
            .bind(tenant)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE oauth_grants SET revoked_at=coalesce(revoked_at,now()) WHERE client_id=$1 AND tenant_id=$2").bind(r.client_id).bind(tenant).execute(&mut *tx).await?;
    }
    let encrypted = if let Some(code) = q.code {
        Some(
            crate::provider_settings::seal_secret(
                db(s)?,
                tenant,
                r.id,
                "connect-onboarding-code",
                &code,
            )
            .await?,
        )
    } else {
        None
    };
    sqlx::query("UPDATE connect_onboarding_intents SET encrypted_callback=$3,callback_hash=$4,status=$5,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(r.id).bind(encrypted).bind(callback_hash).bind(if q.error.is_some(){"denied"}else{"callback_received"}).execute(&mut *tx).await?;
    event(
        &mut tx,
        &system,
        r.id,
        "connect.onboarding_callback_received",
    )
    .await?;
    tx.commit().await?;
    Ok(r.id)
}
#[derive(Deserialize, Serialize)]
struct Exchange {
    installation_id: Uuid,
    installation_token: String,
    remote_tenant_id: Uuid,
    remote_user_id: Uuid,
    connection_id: Uuid,
    platform_tenant_id: Uuid,
}
impl Drop for Exchange {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.installation_token.zeroize();
    }
}
fn exchange(value: &Value, a: &Actor) -> Result<Exchange> {
    let x: Exchange = serde_json::from_value(value.clone())
        .map_err(|_| Error::Invalid("incomplete SunCharts installation identity"))?;
    if x.remote_tenant_id != a.tenant_id
        || x.remote_user_id != a.sub
        || !x.installation_token.starts_with("scs_inst_")
        || !(24..=512).contains(&x.installation_token.len())
        || !x
            .installation_token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err(Error::Forbidden);
    }
    Ok(x)
}
async fn consented(tx: &mut Transaction<'_, Postgres>, a: &Actor, client: Uuid) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id AND c.tenant_id=g.tenant_id JOIN browser_users u ON u.id=g.user_id AND u.tenant_id=g.tenant_id WHERE g.client_id=$1 AND g.tenant_id=$2 AND g.user_id=$3 AND g.revoked_at IS NULL AND NOT c.disabled AND NOT u.disabled AND u.role='owner' AND string_to_array(g.scope,' ') @> string_to_array($4,' ') AND EXISTS(SELECT 1 FROM oauth_tokens t WHERE t.grant_id=g.id AND t.expires_at>now() AND t.used_at IS NULL))").bind(client).bind(a.tenant_id).bind(a.sub).bind(SCOPE).fetch_one(&mut **tx).await?)
}
async fn complete(
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    let version = crate::expected(&h)?;
    complete_with_cloud(&s, &h, id, version, &Cloud)
        .await
        .map(Json)
}
#[doc(hidden)]
pub async fn complete_with_cloud(
    s: &State,
    h: &HeaderMap,
    id: Uuid,
    expected: i64,
    cloud: &dyn OnboardingCloud,
) -> Result<Value> {
    let (a, session) = owner(s, h, true).await?;
    let mut tx = db(s)?.begin().await?;
    lock(&mut tx, &a).await?;
    let mut r = row(&mut tx, &a, id).await?;
    if r.status == "completed" {
        if r.session_hash != session {
            return Err(Error::Forbidden);
        }
        tx.commit().await?;
        return Ok(r.public());
    }
    bound(&r, &a, &session)?;
    if r.version != expected {
        return Err(Error::Conflict(
            "connection attempt changed; reload before continuing",
        ));
    }
    if !["callback_received", "exchanged", "completing"].contains(&r.status.as_str())
        || r.lease_until.is_some_and(|t| t > Utc::now())
    {
        return Err(Error::Conflict(
            "connection attempt is not ready or is already completing",
        ));
    }
    if versions(&mut tx, a.tenant_id).await?
        != (r.expected_service_version, r.expected_reminder_version)
    {
        return Err(Error::Conflict("connection settings changed during approval; cancel this attempt before starting again"));
    }
    if !consented(&mut tx, &a, r.client_id).await? {
        return Err(Error::Conflict(
            "the original EHR owner must approve the clinical OAuth connection before installation",
        ));
    }
    sqlx::query("UPDATE connect_onboarding_intents SET status='completing',confirmed_at=coalesce(confirmed_at,now()),lease_until=now()+interval '60 seconds',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
    event(&mut tx, &a, id, "connect.onboarding_owner_confirmed").await?;
    r = row(&mut tx, &a, id).await?;
    tx.commit().await?;
    let secret = pending(&r)?;
    let request_uri = r
        .request_uri
        .as_deref()
        .ok_or(Error::Invalid("missing approval reference"))?;
    let x = if let Some(encrypted) = &r.encrypted_exchange {
        let value = crate::provider_settings::open_secret(
            a.tenant_id,
            id,
            "connect-onboarding-result",
            encrypted,
        )?;
        exchange(
            &serde_json::from_str::<Value>(value.expose())
                .map_err(|_| Error::Invalid("saved installation response unavailable"))?,
            &a,
        )?
    } else {
        let code = crate::provider_settings::open_secret(
            a.tenant_id,
            id,
            "connect-onboarding-code",
            r.encrypted_callback
                .as_ref()
                .ok_or(Error::Invalid("approval callback missing"))?,
        )?;
        let value=cloud.post("/api/v1/ehr-pairing/token",&json!({"request_uri":request_uri,"code":code.expose(),"code_verifier":secret.verifier}),None).await?;
        let x = exchange(&value, &a)?;
        if value["activation_required"] != true {
            return Err(Error::Invalid(
                "SunCharts installation must remain inactive until owner confirmation",
            ));
        }
        let encrypted = crate::provider_settings::seal_secret(
            db(s)?,
            a.tenant_id,
            id,
            "connect-onboarding-result",
            &serde_json::to_string(&x)
                .map_err(|_| Error::Invalid("cannot preserve installation response"))?,
        )
        .await?;
        let mut tx = db(s)?.begin().await?;
        lock(&mut tx, &a).await?;
        let current = row(&mut tx, &a, id).await?;
        bound(&current, &a, &session)?;
        if current.status != "completing" || current.encrypted_exchange.is_some() {
            return Err(Error::Conflict(
                "connection completion changed; reload to resume",
            ));
        }
        sqlx::query("UPDATE connect_onboarding_intents SET encrypted_exchange=$3,status='exchanged',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(encrypted).execute(&mut *tx).await?;
        event(&mut tx, &a, id, "connect.onboarding_credentials_staged").await?;
        tx.commit().await?;
        x
    };
    // The owner confirmation and the encrypted response are durable BEFORE remote activation.
    let active=cloud.post("/api/v1/ehr-pairing/complete",&json!({"request_uri":request_uri,"code_verifier":secret.verifier,"installation_id":x.installation_id}),Some(&x.installation_token)).await?;
    if active["installation_id"] != x.installation_id.to_string()
        || active["remote_tenant_id"] != a.tenant_id.to_string()
        || active["remote_user_id"] != a.sub.to_string()
        || active["active"] != true
    {
        return Err(Error::Invalid(
            "SunCharts did not verify this owner's installation activation",
        ));
    }
    let from = active["services"]["reminders"]["from_email"]
        .as_str()
        .or_else(|| active["from_email"].as_str())
        .filter(|v| v.len() <= 254 && v.bytes().all(|c| c.is_ascii_graphic() || c == b' '))
        .map(str::to_owned);
    let reminders = active["managed_email_ready"] == true && from.is_some();
    let support = active["support_ready"] == true && active["entitled"] == true;
    let mut tx = db(s)?.begin().await?;
    lock(&mut tx, &a).await?;
    let current = row(&mut tx, &a, id).await?;
    bound(&current, &a, &session)?;
    if !["exchanged", "completing"].contains(&current.status.as_str())
        || versions(&mut tx, a.tenant_id).await?
            != (
                current.expected_service_version,
                current.expected_reminder_version,
            )
        || !consented(&mut tx, &a, current.client_id).await?
    {
        return Err(Error::Conflict("local approval or settings changed; cancel this attempt to revoke its staged connection"));
    }
    let old_service: Option<(Uuid, i64)> = sqlx::query_as(
        "SELECT id,credential_revision FROM connect_service_settings WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (service_id, service_revision) = old_service
        .map(|(id, rev)| (id, rev + 1))
        .unwrap_or((Uuid::new_v4(), 1));
    let encrypted = crate::provider_settings::seal_secret(
        db(s)?,
        a.tenant_id,
        service_id,
        "connect-service",
        &x.installation_token,
    )
    .await?;
    sqlx::query("INSERT INTO connect_service_settings(tenant_id,id,installation_id,enabled,verified,reminders_available,support_available,from_email,last_test_at,last_test_result) VALUES($1,$2,$3,true,true,$4,$5,$6,now(),'owner_pairing_verified') ON CONFLICT(tenant_id) DO UPDATE SET installation_id=$3,credential_revision=connect_service_settings.credential_revision+1,enabled=true,verified=true,revoked=false,reminders_available=$4,support_available=$5,from_email=$6,last_test_at=now(),last_test_result='owner_pairing_verified',version=connect_service_settings.version+1").bind(a.tenant_id).bind(service_id).bind(x.installation_id).bind(reminders).bind(support).bind(&from).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO connect_service_credentials(tenant_id,setting_id,revision,installation_id,encrypted_token) VALUES($1,$2,$3,$4,$5)").bind(a.tenant_id).bind(service_id).bind(service_revision).bind(x.installation_id).bind(encrypted).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO connect_service_events(tenant_id,setting_id,version,actor_id,action) SELECT tenant_id,id,version,$2,'connect.automatically_paired' FROM connect_service_settings WHERE tenant_id=$1").bind(a.tenant_id).bind(a.sub).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "connect.automatically_paired", service_id).await?;
    // Pairing enables managed services without changing an owner's existing
    // white-label email delivery choice or immutable sender credentials.
    let preserve_own_sender: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM reminder_sender_settings WHERE tenant_id=$1 AND delivery_mode='own_resend')")
        .bind(a.tenant_id).fetch_one(&mut *tx).await?;
    if let Some(from) = from.filter(|_| reminders && !preserve_own_sender) {
        let old: Option<(Uuid, i64)> = sqlx::query_as(
            "SELECT id,credential_revision FROM reminder_sender_settings WHERE tenant_id=$1",
        )
        .bind(a.tenant_id)
        .fetch_optional(&mut *tx)
        .await?;
        let (sender, sender_revision) = old
            .map(|(id, rev)| (id, rev + 1))
            .unwrap_or((Uuid::new_v4(), 1));
        sqlx::query("INSERT INTO reminder_sender_settings(tenant_id,id,from_email,delivery_mode,enabled,verified,last_test_at,last_test_result) VALUES($1,$2,$3,'suncharts_connect',true,true,now(),'owner_pairing_verified') ON CONFLICT(tenant_id) DO UPDATE SET from_email=$3,delivery_mode='suncharts_connect',credential_revision=reminder_sender_settings.credential_revision+1,enabled=true,verified=true,last_test_at=now(),last_test_result='owner_pairing_verified',version=reminder_sender_settings.version+1").bind(a.tenant_id).bind(sender).bind(&from).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO reminder_credentials(tenant_id,setting_id,revision,encrypted_key,from_email,delivery_mode,connect_setting_id,connect_revision) VALUES($1,$2,$3,NULL,$4,'suncharts_connect',$5,$6)").bind(a.tenant_id).bind(sender).bind(sender_revision).bind(from).bind(service_id).bind(service_revision).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO reminder_sender_events(tenant_id,setting_id,version,actor_id,action) SELECT tenant_id,id,version,$2,'connect.automatically_paired' FROM reminder_sender_settings WHERE tenant_id=$1").bind(a.tenant_id).bind(a.sub).execute(&mut *tx).await?;
        crate::postgres::audit(
            &mut tx,
            &a,
            "appointment.managed_sender_automatically_paired",
            sender,
        )
        .await?;
    }
    sqlx::query("INSERT INTO connect_service_health(tenant_id,setting_id,credential_revision,installation_id,availability,checked_at,verified_at,result,reminders_available,support_available) VALUES($1,$2,$3,$4,'available',clock_timestamp(),clock_timestamp(),'owner_pairing_verified',$5,$6) ON CONFLICT(tenant_id) DO UPDATE SET setting_id=$2,credential_revision=$3,installation_id=$4,availability='available',checked_at=clock_timestamp(),verified_at=clock_timestamp(),result='owner_pairing_verified',reminders_available=$5,support_available=$6").bind(a.tenant_id).bind(service_id).bind(service_revision).bind(x.installation_id).bind(reminders).bind(support).execute(&mut *tx).await?;
    sqlx::query("UPDATE connect_onboarding_intents SET status='completed',connect_installation_id=$3,completed_at=now(),lease_until=NULL,version=version+1,last_result='owner_pairing_completed' WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(x.installation_id).execute(&mut *tx).await?;
    // The pending enrollment heartbeat cannot certify the activated installation.
    sqlx::query("UPDATE connect_transport_health SET state='connecting',last_seen_at=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND intent_id=$2").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
    event(&mut tx, &a, id, "connect.onboarding_completed").await?;
    let result = row(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(result.public())
}
async fn cancel(
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    let version = crate::expected(&h)?;
    cancel_with_cloud(&s, &h, id, version, &Cloud)
        .await
        .map(Json)
}
#[doc(hidden)]
pub async fn cancel_with_cloud(
    s: &State,
    h: &HeaderMap,
    id: Uuid,
    expected: i64,
    cloud: &dyn OnboardingCloud,
) -> Result<Value> {
    let (a, _) = owner(s, h, true).await?;
    let mut tx = db(s)?.begin().await?;
    lock(&mut tx, &a).await?;
    let r = row(&mut tx, &a, id).await?;
    if r.status == "cancelled" {
        tx.commit().await?;
        return Ok(r.public());
    }
    if r.version != expected {
        return Err(Error::Conflict(
            "connection attempt changed; reload before cancelling",
        ));
    }
    if r.status == "completed" {
        return Err(Error::Conflict(
            "this connection was completed; disconnect it through connection settings",
        ));
    }
    sqlx::query("UPDATE oauth_clients SET disabled=true WHERE id=$1 AND tenant_id=$2")
        .bind(r.client_id)
        .bind(a.tenant_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE oauth_grants SET revoked_at=coalesce(revoked_at,now()) WHERE client_id=$1 AND tenant_id=$2").bind(r.client_id).bind(a.tenant_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE connect_onboarding_intents SET status='cancelling',lease_until=NULL,version=version+1,last_result='owner_requested_cloud_cleanup' WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
    event(&mut tx, &a, id, "connect.onboarding_cancellation_requested").await?;
    tx.commit().await?;
    if let Some(uri) = r.request_uri.as_deref() {
        let secret = pending(&r)?;
        let response = cloud
            .post(
                "/api/v1/ehr-pairing/cancel",
                &json!({"request_uri":uri,"code_verifier":secret.verifier}),
                None,
            )
            .await?;
        if response["cancelled"] != true {
            return Err(Error::Conflict(
                "SunCharts cleanup is not confirmed; retry cancelling this same attempt",
            ));
        }
    }
    let mut tx = db(s)?.begin().await?;
    lock(&mut tx, &a).await?;
    let current = row(&mut tx, &a, id).await?;
    if current.status == "completed" {
        return Err(Error::Conflict(
            "connection completed while cancellation was pending",
        ));
    }
    sqlx::query("UPDATE connect_onboarding_intents SET status='cancelled',lease_until=NULL,version=version+1,last_result='owner_cancelled' WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
    event(&mut tx, &a, id, "connect.onboarding_cancelled").await?;
    let out = row(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(out.public())
}
