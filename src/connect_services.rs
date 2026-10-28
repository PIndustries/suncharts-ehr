// SPDX-License-Identifier: AGPL-3.0-only
//! Installation-scoped SunCharts services. OAuth authorization alone grants no service entitlement.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::HeaderMap,
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn owner(a: &Actor) -> Result<()> {
    if matches!(a.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
fn staff(a: &Actor) -> Result<()> {
    a.scheduling()
}
fn expected(h: &HeaderMap) -> Result<i64> {
    if h.get("if-match").is_some_and(|v| v == "\"0\"") {
        Ok(0)
    } else {
        crate::expected(h)
    }
}
#[derive(sqlx::FromRow)]
pub(crate) struct Setting {
    pub id: Uuid,
    pub installation_id: Uuid,
    pub credential_revision: i64,
    pub enabled: bool,
    pub verified: bool,
    pub revoked: bool,
    pub reminders_available: bool,
    pub support_available: bool,
    pub from_email: Option<String>,
    pub version: i64,
    pub last_test_result: Option<String>,
    pub last_test_at: Option<chrono::DateTime<chrono::Utc>>,
}
impl Setting {
    fn public(&self) -> Value {
        json!({"id":self.id,"installation_id":self.installation_id,"version":self.version,"enabled":self.enabled,"verified":self.verified,"revoked":self.revoked,"last_test_result":self.last_test_result,"last_verified_at":if self.verified {self.last_test_at} else {None},"services":{"reminders":{"available":self.reminders_available,"from_email":self.from_email},"support":{"available":self.support_available}}})
    }
}
pub(crate) async fn setting(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
) -> Result<Option<Setting>> {
    Ok(
        sqlx::query_as("SELECT * FROM connect_service_settings WHERE tenant_id=$1 FOR UPDATE")
            .bind(tenant)
            .fetch_optional(&mut **tx)
            .await?,
    )
}
async fn lock(tx: &mut Transaction<'_, Postgres>, a: &Actor) -> Result<()> {
    crate::scheduling::tenant_lock(tx, a).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))")
        .bind(a.tenant_id.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    action: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO connect_service_events(tenant_id,setting_id,version,actor_id,action) SELECT tenant_id,id,version,$3,$4 FROM connect_service_settings WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(a.sub).bind(action).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, action, id).await
}
pub(crate) async fn pinned(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    id: Uuid,
    revision: i64,
) -> Result<(Uuid, crate::provider_settings::Secret)> {
    let(installation,encrypted):(Uuid,Vec<u8>)=sqlx::query_as("SELECT installation_id,encrypted_token FROM connect_service_credentials WHERE tenant_id=$1 AND setting_id=$2 AND revision=$3").bind(tenant).bind(id).bind(revision).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
    Ok((
        installation,
        crate::provider_settings::open_secret(tenant, id, "connect-service", &encrypted)?,
    ))
}
pub(crate) async fn ready(tx: &mut Transaction<'_, Postgres>, tenant: Uuid) -> Result<Setting> {
    let s = setting(tx, tenant)
        .await?
        .ok_or(Error::Conflict("Connect services are not configured"))?;
    if !s.enabled || !s.verified || s.revoked || !s.reminders_available || s.from_email.is_none() {
        return Err(Error::Conflict(
            "Connect appointment email is not enabled and ready",
        ));
    }
    Ok(s)
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/connect/status", get(connection_status))
        .route("/api/v1/connect/status/events", get(connection_events))
        .route(
            "/api/v1/connect/status/refresh",
            post(refresh_connection_status),
        )
        .route(
            "/api/v1/connect/services/settings",
            get(read).put(save).delete(revoke),
        )
        .route("/api/v1/connect/services/settings/test", post(test))
        .route(
            "/api/v1/connect/services/settings/activation",
            post(activate),
        )
        .route(
            "/api/v1/connect/services/tickets",
            get(tickets).post(create_ticket),
        )
        .route("/api/v1/connect/services/tickets/{id}", get(ticket))
        .route("/api/v1/connect/services/tickets/{id}/replies", post(reply))
}
#[derive(sqlx::FromRow)]
struct Health {
    setting_id: Uuid,
    credential_revision: i64,
    installation_id: Uuid,
    availability: String,
    checked_at: chrono::DateTime<chrono::Utc>,
    verified_at: Option<chrono::DateTime<chrono::Utc>>,
    result: String,
    reminders_available: bool,
    support_available: bool,
}
async fn status_snapshot(tx: &mut Transaction<'_, Postgres>, a: &Actor) -> Result<Value> {
    let cloud = crate::connect_onboarding::cloud_origin()?;
    let redirects = if crate::connect_onboarding::official_cloud(&cloud) {
        vec![
            format!("{}/oauth/ehr/callback", crate::connect_onboarding::CLOUD),
            format!(
                "{}/oauth/ehr/callback",
                crate::connect_onboarding::LEGACY_CLOUD
            ),
        ]
    } else {
        vec![format!("{cloud}/oauth/ehr/callback")]
    };
    let (active_grants,your_account_authorized):(i64,bool)=sqlx::query_as("SELECT count(*),coalesce(bool_or(g.user_id=$2),false) FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id AND c.tenant_id=g.tenant_id JOIN browser_users u ON u.id=g.user_id AND u.tenant_id=g.tenant_id WHERE g.tenant_id=$1 AND c.redirect_uri=ANY($3) AND NOT c.disabled AND g.revoked_at IS NULL AND NOT u.disabled AND u.role IN ('owner','clinician','front_desk','read_only') AND EXISTS(SELECT 1 FROM oauth_tokens t WHERE t.grant_id=g.id AND t.expires_at>now() AND t.used_at IS NULL AND t.kind IN ('access','refresh'))").bind(a.tenant_id).bind(a.sub).bind(&redirects).fetch_one(&mut **tx).await?;
    let setting: Option<Setting> =
        sqlx::query_as("SELECT * FROM connect_service_settings WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_optional(&mut **tx)
            .await?;
    let health: Option<Health> =
        sqlx::query_as("SELECT * FROM connect_service_health WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_optional(&mut **tx)
            .await?;
    let now: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?;
    let mut services = json!({"configured":false,"enabled":false,"verified":false,"revoked":false,"availability":"unknown","fresh":false,"last_checked_at":null,"last_verified_at":null,"reminders_available":false,"support_available":false});
    let mut overall = if active_grants > 0 {
        "authorized"
    } else {
        "not_connected"
    };
    if let Some(s) = setting {
        let health = health.filter(|h| {
            h.setting_id == s.id
                && h.credential_revision == s.credential_revision
                && h.installation_id == s.installation_id
        });
        let fresh = health
            .as_ref()
            .is_some_and(|h| h.checked_at > now - chrono::Duration::minutes(5));
        let available = health
            .as_ref()
            .is_some_and(|h| h.availability == "available");
        let last_verified = health
            .as_ref()
            .and_then(|h| h.verified_at)
            .or(if s.verified { s.last_test_at } else { None });
        services = json!({"configured":true,"enabled":s.enabled,"verified":s.verified,"revoked":s.revoked,"availability":health.as_ref().map(|h|h.availability.as_str()).unwrap_or("unknown"),"fresh":fresh,"last_checked_at":health.as_ref().map(|h|h.checked_at),"last_verified_at":last_verified,"last_result":health.as_ref().map(|h|h.result.as_str()),"reminders_available":health.as_ref().map(|h|h.reminders_available).unwrap_or(s.reminders_available),"support_available":health.as_ref().map(|h|h.support_available).unwrap_or(s.support_available)});
        overall = if s.revoked {
            if active_grants > 0 {
                "authorized"
            } else {
                "not_connected"
            }
        } else if s.enabled && s.verified && fresh && available {
            "connected"
        } else {
            "needs_attention"
        };
    }
    Ok(
        json!({"origin":cloud,"status":overall,"practice_authorized":active_grants>0,"your_account_authorized":your_account_authorized,"authorization":{"status":if active_grants>0{"authorized"}else{"not_authorized"},"active_grants":active_grants},"services":services}),
    )
}
async fn connection_status(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let value = status_snapshot(&mut tx, &a).await?;
    crate::postgres::audit(&mut tx, &a, "connect.status_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(with_transport(value, db(&s)?, a.tenant_id).await?))
}

async fn with_transport(mut value: Value, db: &PgPool, tenant: Uuid) -> Result<Value> {
    let transport = crate::connect_transport::status(db, tenant).await?;
    if transport["configured"] == true {
        value["status"] = json!(match transport["state"].as_str() {
            Some("connected")
                if transport["pairing_status"] == "completed"
                    && transport["authorized"] == true =>
            {
                "connected"
            }
            Some("connected") => "needs_attention",
            Some("reconnecting") => "reconnecting",
            _ => "offline",
        });
    }
    value["transport"] = transport;
    Ok(value)
}

// The browser sees only sanitized connection health. Reauthenticate on each tick
// so a logged-out, expired or disabled session cannot retain a live feed.
async fn connection_events(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
) -> Result<impl IntoResponse> {
    let auth = s.browser.as_ref().ok_or(Error::NotFound)?.clone();
    let actor = auth.authenticate(&h, false).await?;
    actor.staff()?;
    let mut tx = auth.db.begin().await?;
    crate::postgres::audit(
        &mut tx,
        &actor,
        "connect.status_stream_opened",
        actor.tenant_id,
    )
    .await?;
    tx.commit().await?;
    let feed = async_stream::stream! {
        let mut previous = String::new();
        loop {
            let Ok(current) = auth.authenticate(&h, false).await else { break };
            if current.sub != actor.sub || current.tenant_id != actor.tenant_id || current.staff().is_err() { break; }
            let result: Result<Value> = async {
                let mut tx = auth.db.begin().await?;
                let value = status_snapshot(&mut tx, &current).await?;
                tx.commit().await?;
                with_transport(value, &auth.db, current.tenant_id).await
            }.await;
            let Ok(value) = result else { break };
            let Ok(serialized) = serde_json::to_string(&value) else { break };
            if serialized != previous {
                previous = serialized.clone();
                yield Ok::<_, std::convert::Infallible>(Event::default().event("connection").data(serialized));
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
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
async fn refresh_connection_status(
    a: Actor,
    ExtractState(s): ExtractState<State>,
) -> Result<Json<Value>> {
    a.staff()?;
    refresh_status_inner(&a, db(&s)?, None).await.map(Json)
}
#[async_trait::async_trait]
pub trait StatusProbe: Send + Sync {
    async fn status(&self, installation: Uuid, key: &str) -> Result<Value>;
}
/// Integration-test seam; production HTTP routes always use the fixed official origin.
#[doc(hidden)]
pub async fn refresh_status_with_probe(
    a: &Actor,
    pool: &PgPool,
    probe: &dyn StatusProbe,
) -> Result<Value> {
    a.staff()?;
    refresh_status_inner(a, pool, Some(probe)).await
}
async fn refresh_status_inner(
    a: &Actor,
    pool: &PgPool,
    probe: Option<&dyn StatusProbe>,
) -> Result<Value> {
    let mut tx = pool.begin().await?;
    lock(&mut tx, a).await?;
    if let Some(r) = setting(&mut tx, a.tenant_id).await? {
        let recent:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_service_health WHERE tenant_id=$1 AND setting_id=$2 AND credential_revision=$3 AND installation_id=$4 AND checked_at>clock_timestamp()-interval '30 seconds')").bind(a.tenant_id).bind(r.id).bind(r.credential_revision).bind(r.installation_id).fetch_one(&mut *tx).await?;
        if !recent {
            let evidence = if r.revoked {
                None
            } else {
                match pinned(&mut tx, a.tenant_id, r.id, r.credential_revision).await {
                    Ok((installation, key)) => match probe {
                        Some(probe) => probe.status(installation, key.expose()).await,
                        None => {
                            request_at(
                                &crate::connect_onboarding::cloud_origin()?,
                                installation,
                                key.expose(),
                                reqwest::Method::GET,
                                "/status",
                                None,
                            )
                            .await
                        }
                    }
                    .ok()
                    .and_then(|v| status_evidence(&v, a.tenant_id, r.installation_id).ok()),
                    Err(_) => None,
                }
            };
            let valid = evidence.is_some();
            let (reminders, support, _) = evidence.unwrap_or((false, false, None));
            sqlx::query("INSERT INTO connect_service_health(tenant_id,setting_id,credential_revision,installation_id,availability,checked_at,verified_at,result,reminders_available,support_available) VALUES($1,$2,$3,$4,$5,clock_timestamp(),CASE WHEN $6 THEN clock_timestamp() ELSE NULL END,$7,$8,$9) ON CONFLICT(tenant_id) DO UPDATE SET setting_id=$2,credential_revision=$3,installation_id=$4,availability=$5,checked_at=clock_timestamp(),verified_at=CASE WHEN $6 THEN clock_timestamp() WHEN connect_service_health.setting_id=$2 AND connect_service_health.credential_revision=$3 AND connect_service_health.installation_id=$4 THEN connect_service_health.verified_at ELSE NULL END,result=$7,reminders_available=$8,support_available=$9").bind(a.tenant_id).bind(r.id).bind(r.credential_revision).bind(r.installation_id).bind(if valid{"available"}else{"unavailable"}).bind(valid).bind(if valid{"installation_roundtrip_verified"}else if r.revoked{"locally_revoked"}else{"installation_roundtrip_not_verified"}).bind(reminders).bind(support).execute(&mut *tx).await?;
            crate::postgres::audit(&mut tx, a, "connect.status_refreshed", r.id).await?;
        }
    }
    let value = status_snapshot(&mut tx, a).await?;
    tx.commit().await?;
    with_transport(value, pool, a.tenant_id).await
}
async fn read(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    staff(&a)?;
    let mut tx = db(&s)?.begin().await?;
    let value = setting(&mut tx, a.tenant_id).await?;
    let healthy = if let Some(r) = &value {
        pinned(&mut tx, a.tenant_id, r.id, r.credential_revision)
            .await
            .is_ok()
    } else {
        true
    };
    crate::postgres::audit(&mut tx, &a, "connect.services_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"setting":value.map(|r|r.public()),"credential_storage_ready":healthy}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    installation_id: Uuid,
    installation_token: Option<String>,
}
async fn save(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<Save>,
) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    lock(&mut tx, &a).await?;
    let old = setting(&mut tx, a.tenant_id).await?;
    if expected(&h)? != old.as_ref().map(|s| s.version).unwrap_or(0) {
        return Err(Error::Conflict("Connect settings changed"));
    }
    let id = old.as_ref().map(|s| s.id).unwrap_or_else(Uuid::new_v4);
    let rev = old.as_ref().map(|s| s.credential_revision + 1).unwrap_or(1);
    let token = if let Some(token) = v.installation_token.filter(|s| !s.is_empty()) {
        zeroize::Zeroizing::new(token)
    } else {
        let old = old
            .as_ref()
            .ok_or(Error::Invalid("enter installation token"))?;
        if old.installation_id != v.installation_id {
            return Err(Error::Invalid("new installation requires its own token"));
        }
        zeroize::Zeroizing::new(
            pinned(&mut tx, a.tenant_id, id, old.credential_revision)
                .await?
                .1
                .expose()
                .to_owned(),
        )
    };
    if !token.starts_with("scs_inst_")
        || !(24..=512).contains(&token.len())
        || !token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err(Error::Invalid("invalid service installation token"));
    }
    let encrypted =
        crate::provider_settings::seal_secret(db(&s)?, a.tenant_id, id, "connect-service", &token)
            .await?;
    sqlx::query("INSERT INTO connect_service_settings(tenant_id,id,installation_id) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET installation_id=$3,credential_revision=connect_service_settings.credential_revision+1,enabled=false,verified=false,revoked=false,reminders_available=false,support_available=false,from_email=NULL,last_test_result=NULL,last_test_at=NULL,version=connect_service_settings.version+1").bind(a.tenant_id).bind(id).bind(v.installation_id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO connect_service_credentials(tenant_id,setting_id,revision,installation_id,encrypted_token) VALUES($1,$2,$3,$4,$5)").bind(a.tenant_id).bind(id).bind(rev).bind(v.installation_id).bind(encrypted).execute(&mut *tx).await?;
    event(&mut tx, &a, id, "connect.services_saved_disabled").await?;
    let out = setting(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(Json(out.public()))
}
async fn request_at(
    base: &str,
    installation: Uuid,
    key: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    let mut req = crate::stedi::client()?
        .request(
            method,
            format!("{base}/api/v1/ehr-services/installations/{installation}{path}"),
        )
        .bearer_auth(key);
    if let Some(body) = body {
        req = req.json(body);
    }
    let response = req
        .send()
        .await
        .map_err(|_| Error::Invalid("SunCharts service is unavailable"))?;
    if !response.status().is_success() {
        return Err(Error::Invalid(
            "SunCharts service rejected this request; verify installation access and readiness",
        ));
    }
    let bytes = crate::stedi::bytes(response, 262144).await?;
    serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("invalid SunCharts service response"))
}
fn status_evidence(
    v: &Value,
    tenant: Uuid,
    installation: Uuid,
) -> Result<(bool, bool, Option<String>)> {
    if v["installation_id"] != installation.to_string()
        || v["remote_tenant_id"] != tenant.to_string()
        || v["active"] != true
    {
        return Err(Error::Invalid(
            "service installation is not active for this clinic",
        ));
    }
    let email = v["services"]["reminders"]["from_email"]
        .as_str()
        .filter(|e| {
            e.len() <= 254
                && e.bytes().all(|c| c.is_ascii_graphic() || c == b' ')
                && e.contains('@')
        })
        .map(str::to_owned);
    let reminders = v["managed_email_ready"] == true && email.is_some();
    Ok((
        reminders,
        v["support_ready"] == true && v["entitled"] == true,
        email,
    ))
}
async fn test(a: Actor, ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    lock(&mut tx, &a).await?;
    let r = setting(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::NotFound)?;
    if crate::expected(&h)? != r.version {
        return Err(Error::Conflict("Connect settings changed"));
    }
    if r.revoked {
        return Err(Error::Conflict("save a valid installation before testing"));
    }
    let (_, key) = pinned(&mut tx, a.tenant_id, r.id, r.credential_revision).await?;
    let response = request_at(
        &crate::connect_onboarding::cloud_origin()?,
        r.installation_id,
        key.expose(),
        reqwest::Method::GET,
        "/status",
        None,
    )
    .await;
    let evidence = response
        .as_ref()
        .ok()
        .and_then(|v| status_evidence(v, a.tenant_id, r.installation_id).ok());
    let verified = evidence.is_some();
    let (reminders, support, from) = evidence.unwrap_or((false, false, None));
    sqlx::query("UPDATE connect_service_settings SET enabled=false,verified=$2,reminders_available=$3,support_available=$4,from_email=$5,last_test_at=now(),last_test_result=$6,version=version+1 WHERE tenant_id=$1").bind(a.tenant_id).bind(verified).bind(reminders).bind(support).bind(from).bind(if verified{"installation_verified"}else{"installation_not_verified"}).execute(&mut *tx).await?;
    event(&mut tx, &a, r.id, "connect.services_tested").await?;
    let out = setting(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(Json(
        json!({"setting":out.public(),"authenticated":verified}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Activation {
    enabled: bool,
}
async fn activate(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<Activation>,
) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    lock(&mut tx, &a).await?;
    let r = setting(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::NotFound)?;
    if crate::expected(&h)? != r.version {
        return Err(Error::Conflict("Connect settings changed"));
    }
    if v.enabled && (!r.verified || r.revoked) {
        return Err(Error::Conflict(
            "test the current installation before enabling services",
        ));
    }
    if v.enabled {
        pinned(&mut tx, a.tenant_id, r.id, r.credential_revision).await?;
    }
    sqlx::query(
        "UPDATE connect_service_settings SET enabled=$2,version=version+1 WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .bind(v.enabled)
    .execute(&mut *tx)
    .await?;
    event(&mut tx, &a, r.id, "connect.services_activation_changed").await?;
    let out = setting(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(Json(out.public()))
}
async fn revoke(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    lock(&mut tx, &a).await?;
    let r = setting(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::NotFound)?;
    if crate::expected(&h)? != r.version {
        return Err(Error::Conflict("Connect settings changed"));
    }
    sqlx::query("UPDATE connect_service_settings SET enabled=false,verified=false,revoked=true,reminders_available=false,support_available=false,version=version+1 WHERE tenant_id=$1").bind(a.tenant_id).execute(&mut *tx).await?;
    event(&mut tx, &a, r.id, "connect.services_locally_revoked").await?;
    tx.commit().await?;
    Ok(Json(
        json!({"revoked":true,"remote_revocation_required":true}),
    ))
}
async fn support(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    write: bool,
) -> Result<(Setting, crate::provider_settings::Secret)> {
    let r = setting(tx, a.tenant_id).await?.ok_or(Error::NotFound)?;
    if !r.enabled || !r.verified || r.revoked || (write && !r.support_available) {
        return Err(Error::Conflict(
            "Connect support is not enabled for this clinic",
        ));
    }
    let (_, key) = pinned(tx, a.tenant_id, r.id, r.credential_revision).await?;
    Ok((r, key))
}
async fn support_call(
    a: &Actor,
    s: &State,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
    action: &str,
) -> Result<Value> {
    staff(a)?;
    let mut tx = db(s)?.begin().await?;
    lock(&mut tx, a).await?;
    let (r, key) = support(&mut tx, a, method == reqwest::Method::POST).await?;
    if method == reqwest::Method::POST {
        let body = body.ok_or(Error::Invalid("missing support request"))?;
        let request = body["request_id"]
            .as_str()
            .and_then(|v| Uuid::parse_str(v).ok())
            .ok_or(Error::Invalid("missing support request identity"))?;
        let digest = crate::oauth::hash(&body.to_string());
        let previous:Option<(Uuid,i64,String,String)>=sqlx::query_as("SELECT setting_id,credential_revision,path,body_hash FROM connect_support_requests WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(request).fetch_optional(&mut *tx).await?;
        if let Some(previous) = previous {
            if previous != (r.id, r.credential_revision, path.to_owned(), digest.clone()) {
                return Err(Error::Conflict(
                    "support request ID or installation binding changed",
                ));
            }
        } else {
            sqlx::query("INSERT INTO connect_support_requests(tenant_id,request_id,setting_id,credential_revision,path,body_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(a.tenant_id).bind(request).bind(r.id).bind(r.credential_revision).bind(path).bind(digest).bind(a.sub).execute(&mut *tx).await?;
            crate::postgres::audit(&mut tx, a, "connect.support_request_reserved", request).await?;
        }
        tx.commit().await?;
        tx = db(s)?.begin().await?;
        lock(&mut tx, a).await?;
        let (current, _) = support(&mut tx, a, method == reqwest::Method::POST).await?;
        if current.id != r.id || current.credential_revision != r.credential_revision {
            return Err(Error::Conflict(
                "service installation changed before request delivery",
            ));
        }
    }
    let value = request_at(
        &crate::connect_onboarding::cloud_origin()?,
        r.installation_id,
        key.expose(),
        method,
        path,
        body,
    )
    .await?;
    crate::postgres::audit(&mut tx, a, action, r.id).await?;
    tx.commit().await?;
    Ok(value)
}
async fn tickets(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    Ok(Json(
        support_call(
            &a,
            &s,
            reqwest::Method::GET,
            "/tickets",
            None,
            "connect.support_listed",
        )
        .await?,
    ))
}
async fn ticket(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    Ok(Json(
        support_call(
            &a,
            &s,
            reqwest::Method::GET,
            &format!("/tickets/{id}"),
            None,
            "connect.support_read",
        )
        .await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TicketCreate {
    request_id: Uuid,
    subject: String,
    message: String,
}
async fn create_ticket(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(v): Json<TicketCreate>,
) -> Result<Json<Value>> {
    crate::model::text(&v.subject, 160)?;
    crate::model::text(&v.message, 4000)?;
    Ok(Json(
        support_call(
            &a,
            &s,
            reqwest::Method::POST,
            "/tickets",
            Some(&json!({"request_id":v.request_id,"subject":v.subject,"message":v.message})),
            "connect.support_created",
        )
        .await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    request_id: Uuid,
    message: String,
}
async fn reply(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    Json(v): Json<Reply>,
) -> Result<Json<Value>> {
    crate::model::text(&v.message, 4000)?;
    Ok(Json(
        support_call(
            &a,
            &s,
            reqwest::Method::POST,
            &format!("/tickets/{id}/replies"),
            Some(&json!({"request_id":v.request_id,"message":v.message})),
            "connect.support_replied",
        )
        .await?,
    ))
}
pub(crate) async fn managed_send(
    installation: Uuid,
    key: &str,
    message: &Value,
    idempotency: &str,
) -> crate::reminders::SendResult {
    let Ok(origin) = crate::connect_onboarding::cloud_origin() else {
        return crate::reminders::SendResult::Rejected(503);
    };
    managed_send_at(&origin, installation, key, message, idempotency).await
}
async fn managed_send_at(
    base: &str,
    installation: Uuid,
    key: &str,
    message: &Value,
    idempotency: &str,
) -> crate::reminders::SendResult {
    use crate::reminders::SendResult;
    let Some(id) = idempotency
        .strip_prefix("suncharts-reminder-")
        .and_then(|s| Uuid::parse_str(s).ok())
    else {
        return SendResult::Uncertain;
    };
    let body = json!({"request_id":id,"recipient_email":message["to"][0],"starts_at":message["starts_at"],"timezone":"UTC","clinic_name":"Your clinic"});
    match request_at(
        base,
        installation,
        key,
        reqwest::Method::POST,
        "/reminders",
        Some(&body),
    )
    .await
    {
        Ok(v) if v["request_id"] == id.to_string() => match v["status"].as_str() {
            Some("accepted" | "delivered" | "bounced") => SendResult::Accepted(id),
            Some("failed") => SendResult::Rejected(400),
            _ => SendResult::Uncertain,
        },
        _ => SendResult::Uncertain,
    }
}
pub(crate) async fn managed_delivery(
    installation: Uuid,
    key: &str,
    id: Uuid,
) -> Result<crate::reminders::DeliveryResult> {
    managed_delivery_at(
        &crate::connect_onboarding::cloud_origin()?,
        installation,
        key,
        id,
    )
    .await
}
async fn managed_delivery_at(
    base: &str,
    installation: Uuid,
    key: &str,
    id: Uuid,
) -> Result<crate::reminders::DeliveryResult> {
    use crate::reminders::DeliveryResult;
    let v = request_at(
        base,
        installation,
        key,
        reqwest::Method::GET,
        &format!("/reminders/{id}"),
        None,
    )
    .await?;
    if v["request_id"] != id.to_string() {
        return Err(Error::Invalid("managed delivery identity mismatch"));
    }
    Ok(match v["status"].as_str() {
        Some("delivered") => DeliveryResult::Delivered,
        Some("bounced" | "failed") => DeliveryResult::Failed,
        _ => DeliveryResult::Pending,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn endpoint(status: u16, response: Value) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
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
            String::from_utf8(bytes).unwrap()
        });
        (base, task)
    }
    #[tokio::test]
    async fn authenticated_status_and_managed_http_contract() {
        let tenant = Uuid::new_v4();
        let installation = Uuid::new_v4();
        let request = Uuid::new_v4();
        let status = json!({"installation_id":installation,"remote_tenant_id":tenant,"active":true,"managed_email_ready":true,"support_ready":true,"entitled":true,"services":{"reminders":{"from_email":"SunCharts <appointments@suncharts.app>"}}});
        assert_eq!(
            status_evidence(&status, tenant, installation).unwrap(),
            (
                true,
                true,
                Some("SunCharts <appointments@suncharts.app>".into())
            )
        );
        let mut suspended = status.clone();
        suspended["entitled"] = json!(false);
        assert!(
            !status_evidence(&suspended, tenant, installation).unwrap().1,
            "support actions require service entitlement even when ticket reads remain available"
        );
        assert!(status_evidence(&status, Uuid::new_v4(), installation).is_err());
        assert!(status_evidence(&status, tenant, Uuid::new_v4()).is_err());
        let mut inactive = status.clone();
        inactive["active"] = json!(false);
        assert!(status_evidence(&inactive, tenant, installation).is_err());
        let (base, task) = endpoint(200, status).await;
        let v = request_at(
            &base,
            installation,
            "scs_inst_fixture",
            reqwest::Method::GET,
            "/status",
            None,
        )
        .await
        .unwrap();
        assert!(status_evidence(&v, tenant, installation).is_ok());
        let http = task.await.unwrap();
        assert!(http.starts_with(&format!(
            "GET /api/v1/ehr-services/installations/{installation}/status "
        )));
        assert!(http
            .to_ascii_lowercase()
            .contains("authorization: bearer scs_inst_fixture"));
        let message = json!({"from":"SunCharts <appointments@suncharts.app>","to":["synthetic@example.test"],"starts_at":"2026-11-01T14:00:00Z","subject":"Appointment reminder","text":"Generic synthetic reminder"});
        let(base,task)=endpoint(200,json!({"request_id":request,"status":"accepted","provider_message_id":"opaque-provider-id"})).await;
        assert!(
            matches!(managed_send_at(&base,installation,"scs_inst_fixture",&message,&format!("suncharts-reminder-{request}")).await,crate::reminders::SendResult::Accepted(id) if id==request)
        );
        let http = task.await.unwrap();
        let body: Value = serde_json::from_str(http.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"request_id":request,"recipient_email":"synthetic@example.test","starts_at":"2026-11-01T14:00:00Z","timezone":"UTC","clinic_name":"Your clinic"})
        );
        assert!(!http.contains("Generic synthetic reminder"));
        for (state, expected) in [
            ("accepted", "pending"),
            ("delivery_unknown", "pending"),
            ("delivered", "delivered"),
            ("bounced", "failed"),
        ] {
            let (base, task) = endpoint(200, json!({"request_id":request,"status":state})).await;
            let result = managed_delivery_at(&base, installation, "scs_inst_fixture", request)
                .await
                .unwrap();
            assert!(matches!(
                (result, expected),
                (crate::reminders::DeliveryResult::Pending, "pending")
                    | (crate::reminders::DeliveryResult::Delivered, "delivered")
                    | (crate::reminders::DeliveryResult::Failed, "failed")
            ));
            assert!(task.await.unwrap().starts_with(&format!(
                "GET /api/v1/ehr-services/installations/{installation}/reminders/{request} "
            )));
        }
        let (base, task) = endpoint(503, json!({"message":"synthetic unavailable"})).await;
        assert!(matches!(
            managed_send_at(
                &base,
                installation,
                "scs_inst_fixture",
                &message,
                &format!("suncharts-reminder-{request}")
            )
            .await,
            crate::reminders::SendResult::Uncertain
        ));
        task.await.unwrap();
        let (base, task) = endpoint(
            200,
            json!({"request_id":Uuid::new_v4(),"status":"delivered"}),
        )
        .await;
        assert!(
            managed_delivery_at(&base, installation, "scs_inst_fixture", request)
                .await
                .is_err()
        );
        task.await.unwrap();
    }
}
