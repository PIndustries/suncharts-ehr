// SPDX-License-Identifier: AGPL-3.0-only
//! RingCentral adapter. Provider credentials and tokens never leave this EHR instance.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    State,
};
use axum::{
    body::Bytes,
    extract::{Path, Query, State as ExtractState},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::{DateTime, Duration, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use std::{collections::HashSet, time::Duration as StdDuration};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
};
use uuid::Uuid;
use zeroize::Zeroizing;

const PROD: &str = "https://platform.ringcentral.com";
const SANDBOX: &str = "https://platform.devtest.ringcentral.com";

fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn owner(actor: &Actor) -> Result<()> {
    if matches!(actor.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
fn no_store(value: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}
fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(StdDuration::from_secs(5))
        .timeout(StdDuration::from_secs(15))
        .build()
        .map_err(|_| Error::Invalid("RingCentral HTTP client unavailable"))
}
fn platform(config: &Value) -> Result<&'static str> {
    match config
        .get("environment")
        .and_then(Value::as_str)
        .unwrap_or("production")
    {
        "production" => Ok(PROD),
        "sandbox" => Ok(SANDBOX),
        _ => Err(Error::Invalid(
            "RingCentral environment must be production or sandbox",
        )),
    }
}
fn client_id(config: &Value) -> Result<&str> {
    let id = config
        .get("client_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
        Err(Error::Invalid(
            "RingCentral client ID is missing or invalid",
        ))
    } else {
        Ok(id)
    }
}
fn redirect_uri(value: &str) -> Result<url::Url> {
    let url = url::Url::parse(value).map_err(|_| Error::Invalid("invalid OAuth redirect URI"))?;
    if url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
        || (url.scheme() != "https"
            && !(url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))))
    {
        Err(Error::Invalid("OAuth redirect URI must use HTTPS"))
    } else {
        Ok(url)
    }
}
fn public_base(value: &str) -> Result<url::Url> {
    let mut url = url::Url::parse(value).map_err(|_| Error::Invalid("invalid public EHR URL"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::Invalid(
            "public EHR URL must be a clean HTTPS origin",
        ));
    }
    url.set_path("/");
    Ok(url)
}
fn pkce(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn random(prefix: &str) -> String {
    crate::oauth::random(prefix)
}
fn bounded_provider_error(status: reqwest::StatusCode) -> &'static str {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        "ringcentral_unauthorized"
    } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        "ringcentral_rate_limited"
    } else if status.is_client_error() {
        "ringcentral_request_rejected"
    } else {
        "ringcentral_unavailable"
    }
}

fn oauth_rejection_reason(value: Option<&str>) -> &'static str {
    match value {
        Some("access_denied") => "access_denied",
        Some("unauthorized_client") => "unauthorized_client",
        Some("invalid_request") => "invalid_request",
        Some("temporarily_unavailable") => "temporarily_unavailable",
        _ => "provider_error",
    }
}

#[derive(sqlx::FromRow)]
struct Integration {
    tenant_id: Uuid,
    id: Uuid,
    config: Value,
    credential_revision: i64,
    status: String,
}

#[derive(sqlx::FromRow)]
struct OAuthFlow {
    tenant_id: Uuid,
    id: Uuid,
    integration_id: Uuid,
    encrypted_verifier: Vec<u8>,
    redirect_uri: String,
    expires_at: DateTime<Utc>,
    used_at: Option<DateTime<Utc>>,
    created_by: Uuid,
    config: Value,
    credential_revision: i64,
}
async fn integration(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    id: Uuid,
) -> Result<Integration> {
    sqlx::query_as("SELECT tenant_id,id,config,credential_revision,status FROM instance_integrations WHERE tenant_id=$1 AND id=$2 AND provider='ringcentral' FOR UPDATE")
        .bind(tenant).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn client_secret(pool: &PgPool, row: &Integration) -> Result<Zeroizing<String>> {
    if row.credential_revision < 1 {
        return Err(Error::Invalid("save the RingCentral client secret first"));
    }
    let encrypted:Vec<u8>=sqlx::query_scalar("SELECT encrypted_secret FROM instance_integration_credentials WHERE tenant_id=$1 AND integration_id=$2 AND revision=$3")
        .bind(row.tenant_id).bind(row.id).bind(row.credential_revision).fetch_one(pool).await?;
    let secret = crate::provider_settings::open_secret(
        row.tenant_id,
        row.id,
        "instance-integration",
        &encrypted,
    )?;
    Ok(Zeroizing::new(secret.expose().to_owned()))
}
async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    actor: Uuid,
    integration: Uuid,
    action: &str,
    evidence: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO instance_integration_events(tenant_id,integration_id,version,actor_id,action,evidence) SELECT tenant_id,id,version,$3,$4,$5 FROM instance_integrations WHERE tenant_id=$1 AND id=$2")
        .bind(tenant).bind(integration).bind(actor).bind(action).bind(evidence).execute(&mut **tx).await?;
    sqlx::query(
        "INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,$3,$4)",
    )
    .bind(tenant)
    .bind(actor)
    .bind(format!("integration.{action}"))
    .bind(integration)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/integrations/ringcentral/{id}/oauth/start",
            post(start),
        )
        .route(
            "/api/v1/integrations/ringcentral/oauth/callback",
            get(callback),
        )
        .route(
            "/api/v1/integrations/ringcentral/{id}/test",
            post(test_connection),
        )
        .route(
            "/api/v1/integrations/ringcentral/{id}/subscription",
            post(create_subscription),
        )
        .route("/api/v1/integrations/ringcentral/{id}/inbox", get(inbox))
        .route(
            "/api/v1/integrations/ringcentral/{id}/inbox/{event_id}",
            get(event_detail).post(review),
        )
        .route(
            "/api/v1/integrations/ringcentral/webhooks/{hook_key}",
            post(webhook),
        )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    redirect_uri: String,
}
async fn start(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    Json(input): Json<Start>,
) -> Result<Response> {
    owner(&a)?;
    let redirect = redirect_uri(input.redirect_uri.trim())?;
    let mut tx = db(&s)?.begin().await?;
    let row = integration(&mut tx, a.tenant_id, id).await?;
    if row.status == "revoked" {
        return Err(Error::Conflict("revoked integration cannot authorize"));
    }
    let client = client_id(&row.config)?.to_owned();
    client_secret(db(&s)?, &row).await?;
    let flow = Uuid::new_v4();
    let state = Zeroizing::new(random("sce_rc_state_"));
    let verifier = Zeroizing::new(random("sce_rc_pkce_"));
    let encrypted = crate::provider_settings::seal_secret(
        db(&s)?,
        a.tenant_id,
        flow,
        "ringcentral-pkce",
        &verifier,
    )
    .await?;
    let expires = Utc::now() + Duration::minutes(10);
    sqlx::query("INSERT INTO ringcentral_oauth_flows(tenant_id,id,integration_id,state_hash,encrypted_verifier,redirect_uri,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
      .bind(a.tenant_id).bind(flow).bind(id).bind(crate::oauth::hash(&state)).bind(encrypted).bind(redirect.as_str()).bind(expires).bind(a.sub).execute(&mut *tx).await?;
    sqlx::query("UPDATE instance_integrations SET status='pending',enabled=false,version=version+1,updated_by=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2")
      .bind(a.tenant_id).bind(id).bind(a.sub).execute(&mut *tx).await?;
    audit(
        &mut tx,
        a.tenant_id,
        a.sub,
        id,
        "ringcentral_oauth_started",
        json!({"flow_id":flow,"expires_at":expires}),
    )
    .await?;
    tx.commit().await?;
    let mut authorization = url::Url::parse(&format!(
        "{}/restapi/oauth/authorize",
        platform(&row.config)?
    ))
    .map_err(|_| Error::Invalid("RingCentral authorization endpoint invalid"))?;
    authorization
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client)
        .append_pair("redirect_uri", redirect.as_str())
        .append_pair("state", &state)
        .append_pair("code_challenge", &pkce(&verifier))
        .append_pair("code_challenge_method", "S256");
    Ok(no_store(
        json!({"authorization_url":authorization.as_str(),"expires_at":expires}),
    ))
}

#[derive(Deserialize)]
struct Callback {
    state: String,
    code: Option<String>,
    error: Option<String>,
}
#[derive(Deserialize, Serialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    token_type: String,
    expires_in: i64,
    refresh_token_expires_in: Option<i64>,
    scope: Option<String>,
    owner_id: Option<String>,
}
async fn callback(
    ExtractState(s): ExtractState<State>,
    Query(input): Query<Callback>,
) -> Result<Response> {
    if input.state.len() < 32
        || input.state.len() > 512
        || input.code.as_ref().is_some_and(|v| v.len() > 8192)
        || input.error.as_ref().is_some_and(|v| v.len() > 240)
        || input.code.is_some() == input.error.is_some()
    {
        return Err(Error::Invalid("invalid RingCentral OAuth callback"));
    }
    let mut tx = db(&s)?.begin().await?;
    let flow: Option<OAuthFlow> = sqlx::query_as(
      "SELECT f.tenant_id,f.id,f.integration_id,f.encrypted_verifier,f.redirect_uri,f.expires_at,f.used_at,f.created_by,i.config,i.credential_revision FROM ringcentral_oauth_flows f JOIN instance_integrations i ON i.tenant_id=f.tenant_id AND i.id=f.integration_id WHERE f.state_hash=$1 FOR UPDATE OF f")
      .bind(crate::oauth::hash(&input.state)).fetch_optional(&mut *tx).await?;
    let flow = flow.ok_or(Error::NotFound)?;
    if flow.used_at.is_some() || flow.expires_at <= Utc::now() {
        return Err(Error::Conflict(
            "RingCentral OAuth callback expired or was already used",
        ));
    }
    sqlx::query("UPDATE ringcentral_oauth_flows SET used_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(flow.tenant_id)
        .bind(flow.id)
        .execute(&mut *tx)
        .await?;
    if input.error.is_some() {
        let reason = oauth_rejection_reason(input.error.as_deref());
        sqlx::query("UPDATE instance_integrations SET status='needs_attention',last_error='ringcentral_authorization_rejected',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(flow.tenant_id).bind(flow.integration_id).execute(&mut *tx).await?;
        audit(
            &mut tx,
            flow.tenant_id,
            flow.created_by,
            flow.integration_id,
            "ringcentral_oauth_rejected",
            json!({"result":"provider_rejected_authorization","reason":reason}),
        )
        .await?;
        tx.commit().await?;
        return Ok(no_store(
            json!({"connected":false,"status":"needs_attention"}),
        ));
    }
    let row = Integration {
        tenant_id: flow.tenant_id,
        id: flow.integration_id,
        config: flow.config.clone(),
        credential_revision: flow.credential_revision,
        status: "pending".into(),
    };
    let secret = client_secret(db(&s)?, &row).await?;
    let verifier = crate::provider_settings::open_secret(
        flow.tenant_id,
        flow.id,
        "ringcentral-pkce",
        &flow.encrypted_verifier,
    )?;
    tx.commit().await?;
    let credentials = STANDARD.encode(format!("{}:{}", client_id(&flow.config)?, secret.as_str()));
    let response = http()?
        .post(format!("{}/restapi/oauth/token", platform(&flow.config)?))
        .header(header::AUTHORIZATION, format!("Basic {credentials}"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", input.code.as_deref().unwrap_or("")),
            ("redirect_uri", flow.redirect_uri.as_str()),
            ("code_verifier", verifier.expose()),
        ])
        .send()
        .await
        .map_err(|_| Error::Invalid("RingCentral token exchange unavailable"))?;
    if !response.status().is_success() {
        return Err(Error::Invalid(bounded_provider_error(response.status())));
    }
    let tokens: Tokens = response
        .json()
        .await
        .map_err(|_| Error::Invalid("RingCentral token response invalid"))?;
    save_tokens(
        db(&s)?,
        flow.tenant_id,
        flow.integration_id,
        flow.created_by,
        &tokens,
    )
    .await?;
    Ok(no_store(json!({"connected":true,"status":"connected"})))
}

async fn save_tokens(
    pool: &PgPool,
    tenant: Uuid,
    integration_id: Uuid,
    actor: Uuid,
    tokens: &Tokens,
) -> Result<()> {
    if tokens.access_token.len() < 8
        || tokens.access_token.len() > 16384
        || tokens
            .refresh_token
            .as_ref()
            .is_some_and(|v| v.len() > 16384)
        || !tokens.token_type.eq_ignore_ascii_case("bearer")
        || !(60..=86400).contains(&tokens.expires_in)
    {
        return Err(Error::Invalid("RingCentral token response invalid"));
    }
    let payload = Zeroizing::new(
        serde_json::to_string(tokens)
            .map_err(|_| Error::Invalid("RingCentral token response invalid"))?,
    );
    let encrypted = crate::provider_settings::seal_secret(
        pool,
        tenant,
        integration_id,
        "ringcentral-oauth-tokens",
        &payload,
    )
    .await?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM instance_integrations WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(tenant)
        .bind(integration_id)
        .fetch_one(&mut *tx)
        .await?;
    let revision:i64=sqlx::query_scalar("SELECT coalesce(max(revision),0)+1 FROM ringcentral_oauth_tokens WHERE tenant_id=$1 AND integration_id=$2").bind(tenant).bind(integration_id).fetch_one(&mut *tx).await?;
    let access_exp = Utc::now() + Duration::seconds(tokens.expires_in);
    let refresh_exp = tokens
        .refresh_token_expires_in
        .map(|v| Utc::now() + Duration::seconds(v));
    sqlx::query("INSERT INTO ringcentral_oauth_tokens(tenant_id,integration_id,revision,encrypted_tokens,access_expires_at,refresh_expires_at,granted_scope,owner_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
      .bind(tenant).bind(integration_id).bind(revision).bind(encrypted).bind(access_exp).bind(refresh_exp).bind(tokens.scope.as_deref().unwrap_or("")).bind(tokens.owner_id.as_deref()).bind(actor).execute(&mut *tx).await?;
    sqlx::query("UPDATE instance_integrations SET status='connected',enabled=true,last_error=NULL,last_test_at=now(),last_test_result='ringcentral_oauth_connected',version=version+1,updated_by=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2")
      .bind(tenant).bind(integration_id).bind(actor).execute(&mut *tx).await?;
    audit(
        &mut tx,
        tenant,
        actor,
        integration_id,
        "ringcentral_tokens_rotated",
        json!({"revision":revision,"scope":tokens.scope,"access_expires_at":access_exp}),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn current_access(
    pool: &PgPool,
    tenant: Uuid,
    id: Uuid,
    actor: Uuid,
) -> Result<Zeroizing<String>> {
    let mut tx = pool.begin().await?;
    let row = integration(&mut tx, tenant, id).await?;
    let token:Option<(Vec<u8>,DateTime<Utc>)>=sqlx::query_as("SELECT encrypted_tokens,access_expires_at FROM ringcentral_oauth_tokens WHERE tenant_id=$1 AND integration_id=$2 ORDER BY revision DESC LIMIT 1")
      .bind(tenant).bind(id).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    let (encrypted, expires) =
        token.ok_or(Error::Invalid("RingCentral authorization is required"))?;
    let value =
        crate::provider_settings::open_secret(tenant, id, "ringcentral-oauth-tokens", &encrypted)?;
    let tokens: Tokens = serde_json::from_str(value.expose())
        .map_err(|_| Error::Invalid("saved RingCentral tokens are invalid"))?;
    if expires > Utc::now() + Duration::seconds(60) {
        return Ok(Zeroizing::new(tokens.access_token));
    }
    let refresh = Zeroizing::new(
        tokens
            .refresh_token
            .ok_or(Error::Invalid("RingCentral reauthorization is required"))?,
    );
    let secret = client_secret(pool, &row).await?;
    let credentials = STANDARD.encode(format!("{}:{}", client_id(&row.config)?, secret.as_str()));
    let response = http()?
        .post(format!("{}/restapi/oauth/token", platform(&row.config)?))
        .header(header::AUTHORIZATION, format!("Basic {credentials}"))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
        ])
        .send()
        .await
        .map_err(|_| Error::Invalid("RingCentral token refresh unavailable"))?;
    if !response.status().is_success() {
        return Err(Error::Invalid(bounded_provider_error(response.status())));
    }
    let next: Tokens = response
        .json()
        .await
        .map_err(|_| Error::Invalid("RingCentral token response invalid"))?;
    let access = Zeroizing::new(next.access_token.clone());
    save_tokens(pool, tenant, id, actor, &next).await?;
    Ok(access)
}

async fn test_connection(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    owner(&a)?;
    let token = current_access(db(&s)?, a.tenant_id, id, a.sub).await?;
    let config:Value=sqlx::query_scalar("SELECT config FROM instance_integrations WHERE tenant_id=$1 AND id=$2 AND provider='ringcentral'").bind(a.tenant_id).bind(id).fetch_optional(db(&s)?).await?.ok_or(Error::NotFound)?;
    let response = http()?
        .get(format!(
            "{}/restapi/v1.0/account/~/extension/~",
            platform(&config)?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|_| Error::Invalid("RingCentral connection test unavailable"))?;
    if !response.status().is_success() {
        return Err(Error::Invalid(bounded_provider_error(response.status())));
    }
    let mut tx = db(&s)?.begin().await?;
    integration(&mut tx, a.tenant_id, id).await?;
    sqlx::query("UPDATE instance_integrations SET status='connected',enabled=true,last_test_at=now(),last_test_result='ringcentral_account_verified',last_error=NULL,version=version+1,updated_by=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(a.sub).execute(&mut *tx).await?;
    audit(
        &mut tx,
        a.tenant_id,
        a.sub,
        id,
        "ringcentral_connection_tested",
        json!({"result":"accepted"}),
    )
    .await?;
    tx.commit().await?;
    Ok(no_store(json!({"connected":true,"result":"accepted"})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SubscriptionInput {
    #[serde(default)]
    transport: Option<String>,
    #[serde(default)]
    public_base_url: Option<String>,
}
#[derive(Deserialize)]
struct SubscriptionResponse {
    id: String,
    #[serde(rename = "expirationTime")]
    expiration_time: Option<DateTime<Utc>>,
}
async fn create_subscription(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    Json(input): Json<SubscriptionInput>,
) -> Result<Response> {
    owner(&a)?;
    let transport = input.transport.as_deref().unwrap_or("websocket");
    if transport == "websocket" {
        if input.public_base_url.is_some() {
            return Err(Error::Invalid(
                "public EHR URL is not used for WebSocket delivery",
            ));
        }
        let mut tx = db(&s)?.begin().await?;
        integration(&mut tx, a.tenant_id, id).await?;
        sqlx::query("INSERT INTO ringcentral_stream_health(tenant_id,integration_id,state,session_id,updated_at) VALUES($1,$2,'connecting',NULL,now()) ON CONFLICT(tenant_id,integration_id) DO UPDATE SET state='connecting',last_error=NULL,session_id=NULL,updated_at=now()")
            .bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
        audit(
            &mut tx,
            a.tenant_id,
            a.sub,
            id,
            "ringcentral_websocket_enabled",
            json!({"transport":"outbound_websocket"}),
        )
        .await?;
        tx.commit().await?;
        return Ok(no_store(json!({
            "active": true,
            "transport": "outbound_websocket",
            "public_url_required": false,
            "state": "connecting"
        })));
    }
    if transport != "webhook" {
        return Err(Error::Invalid("unsupported RingCentral transport"));
    }
    let base = public_base(
        input
            .public_base_url
            .as_deref()
            .ok_or(Error::Invalid(
                "public EHR URL is required for webhook delivery",
            ))?
            .trim(),
    )?;
    let hook_key = Zeroizing::new(random("sce_rc_hook_"));
    let verification = Zeroizing::new(random("sce_rc_verify_"));
    let endpoint = base
        .join(&format!(
            "api/v1/integrations/ringcentral/webhooks/{}",
            hook_key.as_str()
        ))
        .map_err(|_| Error::Invalid("public EHR URL is invalid"))?;
    let encrypted = crate::provider_settings::seal_secret(
        db(&s)?,
        a.tenant_id,
        id,
        "ringcentral-webhook-verification",
        &verification,
    )
    .await?;
    let mut tx = db(&s)?.begin().await?;
    integration(&mut tx, a.tenant_id, id).await?;
    sqlx::query("INSERT INTO ringcentral_webhooks(tenant_id,integration_id,hook_key_hash,encrypted_verification_token,enabled,created_by) VALUES($1,$2,$3,$4,false,$5) ON CONFLICT(tenant_id,integration_id) DO UPDATE SET hook_key_hash=excluded.hook_key_hash,encrypted_verification_token=excluded.encrypted_verification_token,provider_subscription_id=NULL,expires_at=NULL,enabled=false,version=ringcentral_webhooks.version+1,updated_at=now()")
      .bind(a.tenant_id).bind(id).bind(crate::oauth::hash(&hook_key)).bind(encrypted).bind(a.sub).execute(&mut *tx).await?;
    audit(
        &mut tx,
        a.tenant_id,
        a.sub,
        id,
        "ringcentral_webhook_prepared",
        json!({"result":"awaiting_provider_validation"}),
    )
    .await?;
    tx.commit().await?;
    let token = current_access(db(&s)?, a.tenant_id, id, a.sub).await?;
    let config: Value =
        sqlx::query_scalar("SELECT config FROM instance_integrations WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .fetch_one(db(&s)?)
            .await?;
    let payload = json!({"eventFilters":["/restapi/v1.0/account/~/extension/~/message-store","/restapi/v1.0/account/~/extension/~/telephony/sessions"],"deliveryMode":{"transportType":"WebHook","address":endpoint.as_str(),"verificationToken":verification.as_str()}});
    let response = http()?
        .post(format!("{}/restapi/v1.0/subscription", platform(&config)?))
        .bearer_auth(token.as_str())
        .json(&payload)
        .send()
        .await
        .map_err(|_| Error::Invalid("RingCentral subscription unavailable"))?;
    if !response.status().is_success() {
        return Err(Error::Invalid(bounded_provider_error(response.status())));
    }
    let provider: SubscriptionResponse = response
        .json()
        .await
        .map_err(|_| Error::Invalid("RingCentral subscription response invalid"))?;
    if provider.id.is_empty() || provider.id.len() > 200 {
        return Err(Error::Invalid("RingCentral subscription response invalid"));
    }
    let mut tx = db(&s)?.begin().await?;
    sqlx::query("UPDATE ringcentral_webhooks SET provider_subscription_id=$3,expires_at=$4,enabled=true,version=version+1,updated_at=now() WHERE tenant_id=$1 AND integration_id=$2").bind(a.tenant_id).bind(id).bind(&provider.id).bind(provider.expiration_time).execute(&mut *tx).await?;
    audit(
        &mut tx,
        a.tenant_id,
        a.sub,
        id,
        "ringcentral_webhook_subscribed",
        json!({"provider_subscription_id":provider.id,"expires_at":provider.expiration_time}),
    )
    .await?;
    tx.commit().await?;
    Ok(no_store(
        json!({"active":true,"expires_at":provider.expiration_time,"webhook_url":endpoint.as_str()}),
    ))
}

fn event_kind(uri: &str, payload: &Value) -> &'static str {
    let uri = uri.to_ascii_lowercase();
    if uri.contains("telephony/sessions") {
        "call"
    } else if uri.contains("type=sms") || uri.contains("message-store/instant") {
        "sms"
    } else if uri.contains("fax") {
        "fax"
    } else if uri.contains("voicemail") {
        "voicemail"
    } else if uri.contains("message-store") {
        let changes = payload.pointer("/body/changes").and_then(Value::as_array);
        let includes = |expected: &str| {
            changes.is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|value| value.eq_ignore_ascii_case(expected))
                })
            })
        };
        if includes("SMS") {
            "sms"
        } else if includes("Fax") {
            "fax"
        } else if includes("Voicemail") || includes("VoiceMail") {
            "voicemail"
        } else {
            "message"
        }
    } else {
        "unknown"
    }
}

async fn stage_payload(
    pool: &PgPool,
    tenant: Uuid,
    integration_id: Uuid,
    payload: &Value,
) -> Result<bool> {
    let event_id = payload
        .get("uuid")
        .and_then(Value::as_str)
        .ok_or(Error::Invalid("RingCentral event ID missing"))?;
    let event_uri = payload
        .get("event")
        .and_then(Value::as_str)
        .ok_or(Error::Invalid("RingCentral event URI missing"))?;
    if event_id.is_empty() || event_id.len() > 240 || event_uri.is_empty() || event_uri.len() > 2000
    {
        return Err(Error::Invalid("invalid RingCentral event"));
    }
    let serialized = Zeroizing::new(
        serde_json::to_string(payload).map_err(|_| Error::Invalid("invalid RingCentral event"))?,
    );
    if serialized.len() > 262_144 {
        return Err(Error::Invalid("invalid RingCentral event"));
    }
    let timestamp = payload
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.with_timezone(&Utc));
    let local_id = Uuid::new_v4();
    let encrypted = crate::provider_settings::seal_secret(
        pool,
        tenant,
        local_id,
        "ringcentral-event",
        &serialized,
    )
    .await?;
    let kind = event_kind(event_uri, payload);
    let mut tx = pool.begin().await?;
    let inserted=sqlx::query("INSERT INTO ringcentral_inbound_events(tenant_id,integration_id,id,provider_event_id,event_uri,event_kind,occurred_at,encrypted_payload,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,integration_id,provider_event_id) DO NOTHING")
      .bind(tenant).bind(integration_id).bind(local_id).bind(event_id).bind(event_uri).bind(kind).bind(timestamp).bind(encrypted).bind(crate::oauth::hash(&serialized)).execute(&mut *tx).await?.rows_affected();
    if inserted == 1 {
        audit(
            &mut tx,
            tenant,
            integration_id,
            integration_id,
            "ringcentral_event_staged",
            json!({"event_id":local_id,"event_kind":kind}),
        )
        .await?;
    }
    sqlx::query("UPDATE ringcentral_stream_health SET last_event_at=now(),updated_at=now() WHERE tenant_id=$1 AND integration_id=$2")
        .bind(tenant).bind(integration_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(inserted == 0)
}

async fn webhook(
    ExtractState(s): ExtractState<State>,
    Path(hook_key): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response> {
    if hook_key.len() < 32 || hook_key.len() > 512 {
        return Err(Error::NotFound);
    }
    let validation = headers
        .get("validation-token")
        .and_then(|v| v.to_str().ok());
    let row:Option<(Uuid,Uuid,Vec<u8>,bool)>=sqlx::query_as("SELECT tenant_id,integration_id,encrypted_verification_token,enabled FROM ringcentral_webhooks WHERE hook_key_hash=$1")
      .bind(crate::oauth::hash(&hook_key)).fetch_optional(db(&s)?).await?;
    let (tenant, integration_id, encrypted_verification, enabled) = row.ok_or(Error::NotFound)?;
    let expected = crate::provider_settings::open_secret(
        tenant,
        integration_id,
        "ringcentral-webhook-verification",
        &encrypted_verification,
    )?;
    let provided = headers
        .get("verification-token")
        .and_then(|v| v.to_str().ok())
        .ok_or(Error::Unauthorized)?;
    aws_lc_rs::constant_time::verify_slices_are_equal(
        expected.expose().as_bytes(),
        provided.as_bytes(),
    )
    .map_err(|_| Error::Unauthorized)?;
    if let Some(value) = validation {
        let mut response = StatusCode::OK.into_response();
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        response.headers_mut().insert(
            "validation-token",
            HeaderValue::from_str(value)
                .map_err(|_| Error::Invalid("invalid RingCentral validation token"))?,
        );
        return Ok(response);
    }
    if !enabled || body.is_empty() || body.len() > 262_144 {
        return Err(Error::Invalid("invalid RingCentral webhook"));
    }
    let payload: Value =
        serde_json::from_slice(&body).map_err(|_| Error::Invalid("invalid RingCentral webhook"))?;
    let duplicate = stage_payload(db(&s)?, tenant, integration_id, &payload).await?;
    Ok((
        StatusCode::OK,
        Json(json!({"accepted":true,"duplicate":duplicate})),
    )
        .into_response())
}

async fn inbox(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'provider_event_id',provider_event_id,'event_uri',event_uri,'event_kind',event_kind,'occurred_at',occurred_at,'status',status,'linked_patient_id',linked_patient_id,'reviewed_at',reviewed_at,'created_at',created_at) FROM ringcentral_inbound_events WHERE tenant_id=$1 AND integration_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100")
      .bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    sqlx::query("INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,'integration.ringcentral_inbox_read',$3)")
        .bind(a.tenant_id).bind(a.sub).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(no_store(json!({"items":items})))
}
async fn event_detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((id, event_id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    let row:Option<(Vec<u8>,Value)>=sqlx::query_as("SELECT encrypted_payload,jsonb_build_object('id',id,'provider_event_id',provider_event_id,'event_uri',event_uri,'event_kind',event_kind,'occurred_at',occurred_at,'status',status,'linked_patient_id',linked_patient_id,'reviewed_at',reviewed_at,'created_at',created_at) FROM ringcentral_inbound_events WHERE tenant_id=$1 AND integration_id=$2 AND id=$3")
      .bind(a.tenant_id).bind(id).bind(event_id).fetch_optional(&mut *tx).await?;
    let (encrypted, metadata) = row.ok_or(Error::NotFound)?;
    let payload = crate::provider_settings::open_secret(
        a.tenant_id,
        event_id,
        "ringcentral-event",
        &encrypted,
    )?;
    let payload: Value = serde_json::from_str(payload.expose())
        .map_err(|_| Error::Invalid("saved RingCentral event is invalid"))?;
    sqlx::query("INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,'integration.ringcentral_event_read',$3)")
        .bind(a.tenant_id).bind(a.sub).bind(event_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(no_store(json!({"event":metadata,"payload":payload})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Review {
    action: String,
    patient_id: Option<Uuid>,
    reason: String,
}
async fn review(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((id, event_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<Review>,
) -> Result<Response> {
    owner(&a)?;
    let status = match input.action.as_str() {
        "review" => "reviewed",
        "ignore" => "ignored",
        _ => return Err(Error::Invalid("unsupported review action")),
    };
    let reason = input.reason.trim();
    if reason.is_empty() || reason.len() > 500 {
        return Err(Error::Invalid("review reason is required"));
    }
    let mut tx = db(&s)?.begin().await?;
    integration(&mut tx, a.tenant_id, id).await?;
    if let Some(patient) = input.patient_id {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)",
        )
        .bind(a.tenant_id)
        .bind(patient)
        .fetch_one(&mut *tx)
        .await?;
        if !exists {
            return Err(Error::NotFound);
        }
    }
    let changed=sqlx::query("UPDATE ringcentral_inbound_events SET status=$4,linked_patient_id=$5,reviewed_by=$6,reviewed_at=now(),review_reason=$7 WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND status='pending_review'")
      .bind(a.tenant_id).bind(id).bind(event_id).bind(status).bind(input.patient_id).bind(a.sub).bind(reason).execute(&mut *tx).await?.rows_affected();
    if changed != 1 {
        return Err(Error::Conflict("RingCentral event was already reviewed"));
    }
    audit(
        &mut tx,
        a.tenant_id,
        a.sub,
        id,
        "ringcentral_event_reviewed",
        json!({"event_id":event_id,"status":status,"linked_patient_id":input.patient_id}),
    )
    .await?;
    tx.commit().await?;
    Ok(no_store(
        json!({"id":event_id,"status":status,"linked_patient_id":input.patient_id}),
    ))
}

#[derive(Deserialize)]
struct WebSocketToken {
    ws_access_token: String,
    uri: String,
    expires_in: i64,
}

fn websocket_url(token: &WebSocketToken) -> Result<Zeroizing<String>> {
    if token.ws_access_token.len() < 8
        || token.ws_access_token.len() > 16_384
        || !(1..=300).contains(&token.expires_in)
    {
        return Err(Error::Invalid("RingCentral WebSocket token invalid"));
    }
    let mut url = url::Url::parse(&token.uri)
        .map_err(|_| Error::Invalid("RingCentral WebSocket endpoint invalid"))?;
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if url.scheme() != "wss"
        || !(host == "ringcentral.com" || host.ends_with(".ringcentral.com"))
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::Invalid("RingCentral WebSocket endpoint invalid"));
    }
    url.query_pairs_mut()
        .append_pair("access_token", &token.ws_access_token);
    Ok(Zeroizing::new(url.into()))
}

async fn set_stream_health(
    pool: &PgPool,
    tenant: Uuid,
    integration: Uuid,
    session: Uuid,
    state: &str,
    connected: bool,
) {
    let _ = sqlx::query("INSERT INTO ringcentral_stream_health(tenant_id,integration_id,state,last_connected_at,last_error,session_id,updated_at) VALUES($1,$2,$3,CASE WHEN $4 THEN now() END,NULL,$5,now()) ON CONFLICT(tenant_id,integration_id) DO UPDATE SET state=$3,last_connected_at=CASE WHEN $4 THEN now() ELSE ringcentral_stream_health.last_connected_at END,last_error=NULL,session_id=$5,updated_at=now()")
        .bind(tenant).bind(integration).bind(state).bind(connected).bind(session).execute(pool).await;
}

async fn stream_enabled(pool: &PgPool, tenant: Uuid, integration: Uuid) -> bool {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM instance_integrations WHERE tenant_id=$1 AND id=$2 AND provider='ringcentral' AND enabled AND status='connected')")
        .bind(tenant).bind(integration).fetch_one(pool).await.unwrap_or(false)
}

async fn websocket_session(
    pool: &PgPool,
    tenant: Uuid,
    integration: Uuid,
    actor: Uuid,
    session: Uuid,
) -> Result<()> {
    let access = current_access(pool, tenant, integration, actor).await?;
    let config: Value = sqlx::query_scalar(
        "SELECT config FROM instance_integrations WHERE tenant_id=$1 AND id=$2 AND provider='ringcentral'",
    )
    .bind(tenant)
    .bind(integration)
    .fetch_one(pool)
    .await?;
    let response = http()?
        .post(format!("{}/restapi/oauth/wstoken", platform(&config)?))
        .bearer_auth(access.as_str())
        .send()
        .await
        .map_err(|_| Error::Invalid("RingCentral WebSocket token unavailable"))?;
    if !response.status().is_success() {
        return Err(Error::Invalid(bounded_provider_error(response.status())));
    }
    let ws_token: WebSocketToken = response
        .json()
        .await
        .map_err(|_| Error::Invalid("RingCentral WebSocket token invalid"))?;
    let socket_url = websocket_url(&ws_token)?;
    let request = socket_url
        .as_str()
        .into_client_request()
        .map_err(|_| Error::Invalid("RingCentral WebSocket unavailable"))?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(524_288))
        .max_frame_size(Some(524_288));
    let (mut socket, _) = tokio::time::timeout(
        StdDuration::from_secs(10),
        connect_async_with_config(request, Some(config), false),
    )
    .await
    .map_err(|_| Error::Invalid("RingCentral WebSocket unavailable"))?
    .map_err(|_| Error::Invalid("RingCentral WebSocket unavailable"))?;
    let first = tokio::time::timeout(StdDuration::from_secs(10), socket.next())
        .await
        .map_err(|_| Error::Invalid("RingCentral WebSocket handshake unavailable"))?
        .ok_or(Error::Invalid(
            "RingCentral WebSocket handshake unavailable",
        ))?
        .map_err(|_| Error::Invalid("RingCentral WebSocket handshake unavailable"))?;
    let Message::Text(first) = first else {
        return Err(Error::Invalid("RingCentral WebSocket handshake invalid"));
    };
    let details: Value = serde_json::from_str(&first)
        .map_err(|_| Error::Invalid("RingCentral WebSocket handshake invalid"))?;
    if details.pointer("/0/type").and_then(Value::as_str) != Some("ConnectionDetails")
        || details.pointer("/0/status").and_then(Value::as_i64) != Some(200)
    {
        return Err(Error::Invalid("RingCentral WebSocket handshake rejected"));
    }
    let request_id = Uuid::new_v4();
    let request_id_string = request_id.to_string();
    let subscribe = json!([
        {"type":"ClientRequest","messageId":request_id,"method":"POST","path":"/restapi/v1.0/subscription/"},
        {"eventFilters":["/restapi/v1.0/account/~/extension/~/message-store","/restapi/v1.0/account/~/extension/~/telephony/sessions"],"deliveryMode":{"transportType":"WebSocket"}}
    ]);
    socket
        .send(Message::Text(subscribe.to_string().into()))
        .await
        .map_err(|_| Error::Invalid("RingCentral WebSocket subscription unavailable"))?;
    let subscribed = tokio::time::timeout(StdDuration::from_secs(10), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = serde_json::from_str(&text)
                        .map_err(|_| Error::Invalid("RingCentral subscription response invalid"))?;
                    if value.pointer("/0/type").and_then(Value::as_str) == Some("ClientResponse")
                        && value.pointer("/0/messageId").and_then(Value::as_str)
                            == Some(request_id_string.as_str())
                    {
                        return Ok(value.pointer("/0/status").and_then(Value::as_i64) == Some(200));
                    }
                }
                Some(Ok(Message::Ping(value))) => {
                    socket
                        .send(Message::Pong(value))
                        .await
                        .map_err(|_| Error::Invalid("RingCentral WebSocket unavailable"))?;
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                    return Err(Error::Invalid("RingCentral subscription unavailable"));
                }
                Some(Ok(_)) => {}
            }
        }
    })
    .await
    .map_err(|_| Error::Invalid("RingCentral subscription unavailable"))??;
    if !subscribed {
        return Err(Error::Invalid("RingCentral subscription rejected"));
    }
    set_stream_health(pool, tenant, integration, session, "connected", true).await;
    let mut check = tokio::time::interval(StdDuration::from_secs(60));
    loop {
        tokio::select! {
            _ = check.tick() => {
                if !stream_enabled(pool, tenant, integration).await { return Ok(()); }
                let heartbeat = json!([{"type":"Heartbeat","messageId":Uuid::new_v4()}]);
                socket.send(Message::Text(heartbeat.to_string().into())).await.map_err(|_|Error::Invalid("RingCentral WebSocket unavailable"))?;
            }
            frame = socket.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = serde_json::from_str(&text).map_err(|_|Error::Invalid("RingCentral WebSocket frame invalid"))?;
                    if value.pointer("/0/type").and_then(Value::as_str) == Some("ServerNotification") {
                        let payload = value.get(1).ok_or(Error::Invalid("RingCentral WebSocket event invalid"))?;
                        stage_payload(pool, tenant, integration, payload).await?;
                    }
                }
                Some(Ok(Message::Ping(value))) => {
                    socket.send(Message::Pong(value)).await.map_err(|_|Error::Invalid("RingCentral WebSocket unavailable"))?;
                }
                Some(Ok(Message::Close(_))) | None => return Err(Error::Invalid("RingCentral WebSocket disconnected")),
                Some(Ok(_)) => {},
                Some(Err(_)) => return Err(Error::Invalid("RingCentral WebSocket unavailable")),
            }
        }
    }
}

async fn stream_worker(pool: PgPool, tenant: Uuid, integration: Uuid, actor: Uuid) -> (Uuid, Uuid) {
    let session = Uuid::new_v4();
    let mut backoff = 1_u64;
    while stream_enabled(&pool, tenant, integration).await {
        set_stream_health(&pool, tenant, integration, session, "connecting", false).await;
        if websocket_session(&pool, tenant, integration, actor, session)
            .await
            .is_ok()
        {
            backoff = 1;
        } else {
            let _ = sqlx::query("UPDATE ringcentral_stream_health SET state='offline',last_error='ringcentral_stream_disconnected',updated_at=now() WHERE tenant_id=$1 AND integration_id=$2 AND session_id=$3")
                .bind(tenant).bind(integration).bind(session).execute(&pool).await;
        }
        if !stream_enabled(&pool, tenant, integration).await {
            break;
        }
        tokio::time::sleep(StdDuration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
    let _ = sqlx::query("UPDATE ringcentral_stream_health SET state='offline',session_id=NULL,updated_at=now() WHERE tenant_id=$1 AND integration_id=$2 AND session_id=$3")
        .bind(tenant).bind(integration).bind(session).execute(&pool).await;
    (tenant, integration)
}

/// Maintains instance-local outbound RingCentral WebSocket subscriptions.
pub async fn run(pool: PgPool) {
    let mut workers = tokio::task::JoinSet::new();
    let mut active = HashSet::new();
    let mut tick = tokio::time::interval(StdDuration::from_secs(10));
    loop {
        tokio::select! {
            result = workers.join_next(), if !workers.is_empty() => {
                if let Some(Ok(key)) = result { active.remove(&key); }
            }
            _ = tick.tick() => {
                let rows: Vec<(Uuid, Uuid, Uuid)> = sqlx::query_as("SELECT tenant_id,id,updated_by FROM instance_integrations WHERE provider='ringcentral' AND enabled AND status='connected' ORDER BY updated_at DESC LIMIT 100")
                    .fetch_all(&pool).await.unwrap_or_default();
                for (tenant, integration, actor) in rows {
                    if active.insert((tenant, integration)) {
                        workers.spawn(stream_worker(pool.clone(), tenant, integration, actor));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pkce_is_stable_and_url_safe() {
        let value = pkce("sce_rc_pkce_synthetic-verifier");
        assert_eq!(value.len(), 43);
        assert!(!value.contains('='));
        assert_eq!(value, pkce("sce_rc_pkce_synthetic-verifier"));
    }
    #[test]
    fn provider_hosts_are_fixed() {
        assert_eq!(platform(&json!({})).unwrap(), PROD);
        assert_eq!(
            platform(&json!({"environment":"sandbox"})).unwrap(),
            SANDBOX
        );
        assert!(platform(&json!({"environment":"https://evil.example"})).is_err());
        let valid = WebSocketToken {
            ws_access_token: "synthetic-ws-token".into(),
            uri: "wss://notifications.ringcentral.com/ws".into(),
            expires_in: 30,
        };
        assert!(websocket_url(&valid).is_ok());
        let invalid = WebSocketToken {
            uri: "wss://ringcentral.com.evil.example/ws".into(),
            ..valid
        };
        assert!(websocket_url(&invalid).is_err());
    }
    #[test]
    fn event_types_do_not_match_patients() {
        let message = json!({"body":{"changes":[{"type":"Fax"}]}});
        assert_eq!(event_kind("/message-store", &message), "fax");
        assert_eq!(event_kind("/telephony/sessions", &json!({})), "call");
    }
    #[test]
    fn oauth_errors_are_bounded() {
        assert_eq!(
            oauth_rejection_reason(Some("access_denied")),
            "access_denied"
        );
        assert_eq!(
            oauth_rejection_reason(Some("secret or PHI")),
            "provider_error"
        );
    }
}
