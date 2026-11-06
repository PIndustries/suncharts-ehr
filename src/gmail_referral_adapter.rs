// SPDX-License-Identifier: AGPL-3.0-only
//! Instance-local Gmail referral intake. Mail never links to a chart without review.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::{DateTime, Duration, TimeZone, Utc};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use std::{collections::HashSet, time::Duration as StdDuration};
use subtle::ConstantTimeEq;
use uuid::Uuid;
use zeroize::Zeroizing;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const GMAIL_API: &str = "https://gmail.googleapis.com/gmail/v1";
const GMAIL_SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";
const MAX_MESSAGES_PER_SYNC: usize = 500;
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const MAX_MESSAGE_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTACHMENT_RESPONSE_BYTES: usize = 14 * 1024 * 1024;

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
fn reply(value: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}
fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(StdDuration::from_secs(5))
        .timeout(StdDuration::from_secs(20))
        .build()
        .map_err(|_| Error::Invalid("Gmail HTTP client unavailable"))
}
fn clean(value: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        Err(Error::Invalid(
            "required Gmail setting is missing or invalid",
        ))
    } else {
        Ok(value.to_owned())
    }
}
fn https_url(raw: &str) -> Result<url::Url> {
    let url = url::Url::parse(raw).map_err(|_| Error::Invalid("invalid HTTPS URL"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
    {
        Err(Error::Invalid("invalid HTTPS URL"))
    } else {
        Ok(url)
    }
}
fn hash(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn decode_websafe(value: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| URL_SAFE.decode(value))
        .map_err(|_| Error::Invalid("invalid Gmail base64 payload"))
}
fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
async fn bounded_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    limit: usize,
) -> Result<T> {
    let mut response = response
        .error_for_status()
        .map_err(|_| Error::Invalid("Google API request rejected"))?;
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(Error::Invalid("Google API response exceeds limit"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Error::Invalid("Google API response unavailable"))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(Error::Invalid("Google API response exceeds limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("invalid Google API response"))
}

#[derive(Clone, Deserialize, Serialize)]
struct CredentialBundle {
    client_secret: String,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    scope: Option<String>,
}
fn credential_bundle(secret: &str) -> CredentialBundle {
    serde_json::from_str(secret).unwrap_or_else(|_| CredentialBundle {
        client_secret: secret.to_owned(),
        access_token: None,
        refresh_token: None,
        expires_at: None,
        scope: None,
    })
}

#[derive(sqlx::FromRow)]
struct GmailIntegration {
    tenant_id: Uuid,
    id: Uuid,
    config: Value,
    credential_revision: i64,
    created_by: Uuid,
    status: String,
}
async fn integration(pool: &PgPool, tenant: Uuid, id: Uuid) -> Result<GmailIntegration> {
    sqlx::query_as("SELECT tenant_id,id,config,credential_revision,created_by,status FROM instance_integrations WHERE tenant_id=$1 AND id=$2 AND provider='gmail'")
        .bind(tenant).bind(id).fetch_optional(pool).await?.ok_or(Error::NotFound)
}
async fn load_bundle(pool: &PgPool, row: &GmailIntegration) -> Result<CredentialBundle> {
    if row.credential_revision < 1 {
        return Err(Error::Invalid("save the Google OAuth client secret first"));
    }
    let encrypted:Vec<u8>=sqlx::query_scalar("SELECT encrypted_secret FROM instance_integration_credentials WHERE tenant_id=$1 AND integration_id=$2 AND revision=$3")
        .bind(row.tenant_id).bind(row.id).bind(row.credential_revision).fetch_one(pool).await?;
    let secret = crate::provider_settings::open_secret(
        row.tenant_id,
        row.id,
        "instance-integration",
        &encrypted,
    )?;
    Ok(credential_bundle(secret.expose()))
}
fn client_id(row: &GmailIntegration) -> Result<String> {
    row.config
        .get("client_id")
        .and_then(Value::as_str)
        .map(|v| clean(v, 512))
        .transpose()?
        .ok_or(Error::Invalid("save the Google OAuth client ID first"))
}
async fn adapter_event(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    integration: Uuid,
    actor: Uuid,
    action: &str,
    evidence: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO gmail_adapter_events(tenant_id,integration_id,action,evidence,actor_id) VALUES($1,$2,$3,$4,$5)")
        .bind(tenant).bind(integration).bind(action).bind(evidence).bind(actor).execute(&mut **tx).await?;
    sqlx::query(
        "INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,$3,$4)",
    )
    .bind(tenant)
    .bind(actor)
    .bind(format!("integration.gmail.{action}"))
    .bind(integration)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
async fn save_bundle(
    pool: &PgPool,
    row: &GmailIntegration,
    bundle: &CredentialBundle,
    actor: Uuid,
    result: &str,
) -> Result<()> {
    let serialized = Zeroizing::new(
        serde_json::to_string(bundle)
            .map_err(|_| Error::Invalid("Gmail credential serialization failed"))?,
    );
    let mut tx = pool.begin().await?;
    let current:i64=sqlx::query_scalar("SELECT credential_revision FROM instance_integrations WHERE tenant_id=$1 AND id=$2 AND provider='gmail' FOR UPDATE")
        .bind(row.tenant_id).bind(row.id).fetch_one(&mut *tx).await?;
    let next = current + 1;
    let encrypted = crate::provider_settings::seal_secret(
        pool,
        row.tenant_id,
        row.id,
        "instance-integration",
        &serialized,
    )
    .await?;
    sqlx::query("INSERT INTO instance_integration_credentials(tenant_id,integration_id,revision,encrypted_secret,fingerprint,created_by) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(row.tenant_id).bind(row.id).bind(next).bind(encrypted).bind(hash(serialized.as_bytes())).bind(actor).execute(&mut *tx).await?;
    sqlx::query("UPDATE instance_integrations SET credential_revision=$3,status='connected',enabled=true,last_test_at=now(),last_test_result=$4,last_error=NULL,version=version+1,updated_by=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(row.tenant_id).bind(row.id).bind(next).bind(result).bind(actor).execute(&mut *tx).await?;
    adapter_event(
        &mut tx,
        row.tenant_id,
        row.id,
        actor,
        "credential_rotated",
        json!({"result":result,"credential_revision":next}),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/integrations/{id}/gmail/oauth/start",
            post(oauth_start),
        )
        .route(
            "/api/v1/integrations/gmail/oauth/callback",
            get(oauth_callback),
        )
        .route(
            "/api/v1/integrations/{id}/gmail/watch",
            get(watch_status).post(configure_watch),
        )
        .route("/api/v1/integrations/{id}/gmail/pubsub", post(pubsub_push))
        .route("/api/v1/integrations/{id}/gmail/sync", post(sync_now))
        .route("/api/v1/integrations/{id}/gmail/referrals", get(inbox))
        .route(
            "/api/v1/integrations/{id}/gmail/referrals/{entry}",
            get(inbox_detail),
        )
        .route(
            "/api/v1/integrations/{id}/gmail/referrals/{entry}/actions",
            post(inbox_action),
        )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OAuthStart {
    redirect_uri: String,
}
async fn oauth_start(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    Json(input): Json<OAuthStart>,
) -> Result<Response> {
    owner(&actor)?;
    let redirect = https_url(&input.redirect_uri)?;
    let row = integration(db(&state)?, actor.tenant_id, id).await?;
    if row.status == "revoked" {
        return Err(Error::Conflict(
            "revoked Gmail integration cannot authorize",
        ));
    }
    let client_id = client_id(&row)?;
    let bundle = load_bundle(db(&state)?, &row).await?;
    if bundle.client_secret.len() < 8 {
        return Err(Error::Invalid("Google OAuth client secret is invalid"));
    }
    let state_token = Zeroizing::new(crate::oauth::random("gmail_state_"));
    let verifier = Zeroizing::new(crate::oauth::random("gmail_pkce_"));
    let encrypted = crate::provider_settings::seal_secret(
        db(&state)?,
        actor.tenant_id,
        id,
        "gmail-oauth-session",
        &serde_json::to_string(&json!({"state":state_token.as_str(),"verifier":verifier.as_str()}))
            .map_err(|_| Error::Invalid("OAuth session unavailable"))?,
    )
    .await?;
    let session = Uuid::new_v4();
    let expires = Utc::now() + Duration::minutes(10);
    let mut tx = db(&state)?.begin().await?;
    sqlx::query("INSERT INTO gmail_oauth_sessions(tenant_id,id,integration_id,state_hash,encrypted_session,redirect_uri,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
      .bind(actor.tenant_id).bind(session).bind(id).bind(hash(state_token.as_bytes())).bind(encrypted).bind(redirect.as_str()).bind(expires).bind(actor.sub).execute(&mut *tx).await?;
    adapter_event(
        &mut tx,
        actor.tenant_id,
        id,
        actor.sub,
        "oauth_started",
        json!({"session_id":session,"expires_at":expires,"scope":GMAIL_SCOPE}),
    )
    .await?;
    tx.commit().await?;
    let mut authorization = url::Url::parse(AUTH_URL)
        .map_err(|_| Error::Invalid("Google authorization URL unavailable"))?;
    authorization
        .query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", redirect.as_str())
        .append_pair("response_type", "code")
        .append_pair("scope", GMAIL_SCOPE)
        .append_pair("access_type", "offline")
        .append_pair("include_granted_scopes", "true")
        .append_pair("prompt", "consent")
        .append_pair("state", &state_token)
        .append_pair("code_challenge", &pkce_challenge(&verifier))
        .append_pair("code_challenge_method", "S256");
    Ok(reply(
        json!({"authorization_url":authorization.as_str(),"expires_at":expires,"scope":GMAIL_SCOPE,
      "restricted_scope_notice":"Google classifies mailbox read access as restricted; production use may require OAuth verification and a security assessment."}),
    ))
}

#[derive(Deserialize)]
struct OAuthCallback {
    state: String,
    code: Option<String>,
    error: Option<String>,
}
#[derive(sqlx::FromRow)]
struct SessionRow {
    tenant_id: Uuid,
    id: Uuid,
    integration_id: Uuid,
    encrypted_session: Vec<u8>,
    redirect_uri: String,
    expires_at: DateTime<Utc>,
    claimed_at: Option<DateTime<Utc>>,
    created_by: Uuid,
}
#[derive(Deserialize)]
struct SessionSecret {
    state: String,
    verifier: String,
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}
async fn oauth_callback(
    ExtractState(state): ExtractState<State>,
    Query(input): Query<OAuthCallback>,
) -> Result<Response> {
    if input.state.len() < 32
        || input.state.len() > 512
        || input.code.as_ref().is_some_and(|v| v.len() > 8192)
        || input.error.as_ref().is_some_and(|v| v.len() > 240)
        || input.code.is_some() == input.error.is_some()
    {
        return Err(Error::Invalid("invalid Gmail OAuth callback"));
    }
    let pool = db(&state)?;
    let mut tx = pool.begin().await?;
    let session:SessionRow=sqlx::query_as("SELECT tenant_id,id,integration_id,encrypted_session,redirect_uri,expires_at,claimed_at,created_by FROM gmail_oauth_sessions WHERE state_hash=$1 FOR UPDATE")
      .bind(hash(input.state.as_bytes())).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    if session.claimed_at.is_some() || session.expires_at <= Utc::now() {
        return Err(Error::Conflict(
            "Gmail OAuth callback expired or was already used",
        ));
    }
    let secret = crate::provider_settings::open_secret(
        session.tenant_id,
        session.integration_id,
        "gmail-oauth-session",
        &session.encrypted_session,
    )?;
    let session_secret: SessionSecret = serde_json::from_str(secret.expose())
        .map_err(|_| Error::Invalid("Gmail OAuth session cannot be decrypted"))?;
    if session_secret
        .state
        .as_bytes()
        .ct_eq(input.state.as_bytes())
        .unwrap_u8()
        != 1
    {
        return Err(Error::Unauthorized);
    }
    sqlx::query("UPDATE gmail_oauth_sessions SET claimed_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(session.tenant_id)
        .bind(session.id)
        .execute(&mut *tx)
        .await?;
    adapter_event(&mut tx,session.tenant_id,session.integration_id,session.created_by,"oauth_callback_received",json!({"session_id":session.id,"result":if input.error.is_some(){"provider_error"}else{"code_received"}})).await?;
    tx.commit().await?;
    if input.error.is_some() {
        mark_attention(
            pool,
            session.tenant_id,
            session.integration_id,
            session.created_by,
            "oauth_provider_error",
        )
        .await?;
        return Ok(reply(json!({"connected":false,"status":"needs_attention"})));
    }
    let row = integration(pool, session.tenant_id, session.integration_id).await?;
    let existing = load_bundle(pool, &row).await?;
    let client_id = client_id(&row)?;
    let response = client()?
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", existing.client_secret.as_str()),
            ("code", input.code.as_deref().unwrap_or_default()),
            ("code_verifier", session_secret.verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", session.redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|_| Error::Invalid("Google token exchange unavailable"))?;
    if !response.status().is_success() {
        mark_attention(
            pool,
            row.tenant_id,
            row.id,
            session.created_by,
            "oauth_token_exchange_rejected",
        )
        .await?;
        return Err(Error::Invalid("Google token exchange rejected"));
    }
    let tokens: TokenResponse = bounded_json(response, 64 * 1024).await?;
    let bundle = CredentialBundle {
        client_secret: existing.client_secret,
        access_token: Some(tokens.access_token),
        refresh_token: tokens.refresh_token.or(existing.refresh_token),
        expires_at: Some(Utc::now() + Duration::seconds(tokens.expires_in.clamp(60, 86400))),
        scope: tokens.scope,
    };
    save_bundle(
        pool,
        &row,
        &bundle,
        session.created_by,
        "gmail_oauth_connected",
    )
    .await?;
    Ok(reply(
        json!({"connected":true,"status":"connected","message":"Gmail authorization completed. Configure outbound polling or optional Pub/Sub next."}),
    ))
}
async fn mark_attention(
    pool: &PgPool,
    tenant: Uuid,
    id: Uuid,
    actor: Uuid,
    error: &str,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE instance_integrations SET status='needs_attention',enabled=false,last_error=$3,version=version+1,updated_by=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2")
  .bind(tenant).bind(id).bind(error).bind(actor).execute(&mut *tx).await?;
    adapter_event(
        &mut tx,
        tenant,
        id,
        actor,
        "needs_attention",
        json!({"error":error}),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn access_token(pool: &PgPool, row: &GmailIntegration) -> Result<Zeroizing<String>> {
    let mut bundle = load_bundle(pool, row).await?;
    if bundle
        .expires_at
        .is_some_and(|v| v > Utc::now() + Duration::seconds(60))
    {
        return bundle
            .access_token
            .map(Zeroizing::new)
            .ok_or(Error::Invalid("Gmail authorization is incomplete"));
    }
    let refresh = bundle.refresh_token.clone().ok_or(Error::Invalid(
        "Gmail refresh token is unavailable; authorize again",
    ))?;
    let client_id = client_id(row)?;
    let response = client()?
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", bundle.client_secret.as_str()),
            ("refresh_token", refresh.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|_| Error::Invalid("Google token refresh unavailable"))?;
    if !response.status().is_success() {
        return Err(Error::Invalid("Google token refresh rejected"));
    }
    let tokens: TokenResponse = bounded_json(response, 64 * 1024).await?;
    bundle.access_token = Some(tokens.access_token.clone());
    bundle.expires_at = Some(Utc::now() + Duration::seconds(tokens.expires_in.clamp(60, 86400)));
    if tokens.scope.is_some() {
        bundle.scope = tokens.scope;
    }
    save_bundle(pool, row, &bundle, row.created_by, "gmail_token_refreshed").await?;
    Ok(Zeroizing::new(tokens.access_token))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WatchInput {
    #[serde(default = "default_delivery_mode")]
    delivery_mode: String,
    #[serde(default)]
    topic_name: Option<String>,
    #[serde(default)]
    label_ids: Vec<String>,
    #[serde(default)]
    public_base_url: Option<String>,
    #[serde(default)]
    oidc_audience: Option<String>,
    #[serde(default)]
    oidc_service_account: Option<String>,
    #[serde(default = "default_poll_seconds")]
    poll_seconds: i32,
}
fn default_delivery_mode() -> String {
    "poll".to_owned()
}
fn default_poll_seconds() -> i32 {
    300
}
#[derive(Deserialize)]
struct Profile {
    #[serde(rename = "emailAddress")]
    email_address: String,
    #[serde(rename = "historyId")]
    history_id: String,
}
#[derive(Deserialize)]
struct WatchResponse {
    #[serde(rename = "historyId")]
    history_id: String,
    expiration: String,
}
async fn configure_watch(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    Json(mut input): Json<WatchInput>,
) -> Result<Response> {
    owner(&actor)?;
    if !matches!(input.delivery_mode.as_str(), "poll" | "pubsub")
        || !(60..=3600).contains(&input.poll_seconds)
    {
        return Err(Error::Invalid("invalid Gmail delivery mode"));
    }
    input.label_ids.sort();
    input.label_ids.dedup();
    if input.label_ids.len() > 20 || input.label_ids.iter().any(|v| clean(v, 200).is_err()) {
        return Err(Error::Invalid("invalid Gmail label filter"));
    }
    let pool = db(&state)?;
    let row = integration(pool, actor.tenant_id, id).await?;
    let token = access_token(pool, &row).await?;
    let http = client()?;
    let profile_response = http
        .get(format!("{GMAIL_API}/users/me/profile"))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|_| Error::Invalid("Gmail profile request unavailable"))?;
    let profile: Profile = bounded_json(profile_response, 64 * 1024).await?;
    if !profile.history_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(Error::Invalid("invalid Gmail profile history identifier"));
    }

    let (topic, verification, audience, service_account, history_id, expires) = if input
        .delivery_mode
        == "pubsub"
    {
        let topic = clean(input.topic_name.as_deref().unwrap_or_default(), 500)?;
        let service_account = clean(
            input.oidc_service_account.as_deref().unwrap_or_default(),
            320,
        )?;
        if !topic.starts_with("projects/")
            || !topic.contains("/topics/")
            || !service_account.ends_with(".gserviceaccount.com")
        {
            return Err(Error::Invalid("invalid Google Pub/Sub configuration"));
        }
        let base = https_url(input.public_base_url.as_deref().unwrap_or_default())?;
        let audience = https_url(input.oidc_audience.as_deref().unwrap_or_default())?;
        let watch_response = http
                .post(format!("{GMAIL_API}/users/me/watch"))
                .bearer_auth(token.as_str())
                .json(&json!({"topicName":topic,"labelIds":input.label_ids,"labelFilterAction":"include"}))
                .send()
                .await
                .map_err(|_| Error::Invalid("Gmail watch request unavailable"))?;
        let watched: WatchResponse = bounded_json(watch_response, 64 * 1024).await?;
        if !watched.history_id.chars().all(|c| c.is_ascii_digit()) {
            return Err(Error::Invalid("invalid Gmail watch history identifier"));
        }
        let expiration_ms: i64 = watched
            .expiration
            .parse()
            .map_err(|_| Error::Invalid("invalid Gmail watch expiration"))?;
        let expires = Utc
            .timestamp_millis_opt(expiration_ms)
            .single()
            .ok_or(Error::Invalid("invalid Gmail watch expiration"))?;
        let verification = Zeroizing::new(crate::oauth::random("sce_gmail_push_"));
        let endpoint = format!(
            "{}/api/v1/integrations/{id}/gmail/pubsub?token={}",
            base.as_str().trim_end_matches('/'),
            verification.as_str()
        );
        (
            Some(topic),
            Some((verification, endpoint)),
            Some(audience.to_string()),
            Some(service_account),
            watched.history_id,
            expires,
        )
    } else {
        if input.topic_name.is_some()
            || input.public_base_url.is_some()
            || input.oidc_audience.is_some()
            || input.oidc_service_account.is_some()
        {
            return Err(Error::Invalid(
                "Pub/Sub settings are not accepted in outbound polling mode",
            ));
        }
        (
            None,
            None,
            None,
            None,
            profile.history_id.clone(),
            Utc::now() + Duration::days(30),
        )
    };
    let mut tx = pool.begin().await?;
    let verification_hash = verification
        .as_ref()
        .map(|(secret, _)| hash(secret.as_bytes()));
    sqlx::query("INSERT INTO gmail_watches(tenant_id,integration_id,mailbox,delivery_mode,topic_name,label_ids,history_id,expires_at,verification_hash,oidc_audience,oidc_service_account,poll_seconds,next_poll_at,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13,$13) ON CONFLICT(tenant_id,integration_id) DO UPDATE SET mailbox=excluded.mailbox,delivery_mode=excluded.delivery_mode,topic_name=excluded.topic_name,label_ids=excluded.label_ids,history_id=excluded.history_id,expires_at=excluded.expires_at,verification_hash=excluded.verification_hash,oidc_audience=excluded.oidc_audience,oidc_service_account=excluded.oidc_service_account,poll_seconds=excluded.poll_seconds,next_poll_at=now(),poll_lease_id=NULL,poll_lease_until=NULL,enabled=true,status='active',last_error=NULL,version=gmail_watches.version+1,updated_by=excluded.updated_by,updated_at=now()")
  .bind(actor.tenant_id).bind(id).bind(&profile.email_address).bind(&input.delivery_mode).bind(&topic).bind(json!(input.label_ids)).bind(&history_id).bind(expires).bind(verification_hash).bind(&audience).bind(&service_account).bind(input.poll_seconds).bind(actor.sub).execute(&mut *tx).await?;
    adapter_event(
        &mut tx,
        actor.tenant_id,
        id,
        actor.sub,
        "watch_configured",
        json!({"mailbox":profile.email_address,"delivery_mode":input.delivery_mode,"topic_name":topic,"expires_at":expires}),
    )
    .await?;
    tx.commit().await?;
    let push_endpoint = verification.map(|(_, endpoint)| endpoint);
    Ok(reply(json!({
        "mailbox":profile.email_address,"delivery_mode":input.delivery_mode,
        "history_id":history_id,"expires_at":expires,"poll_seconds":input.poll_seconds,
        "push_endpoint":push_endpoint,"oidc_audience":audience,"oidc_service_account":service_account,
        "setup_requirements":if input.delivery_mode=="pubsub" {json!([
          "Grant gmail-api-push@system.gserviceaccount.com publish access to the topic.",
          "Configure an authenticated Pub/Sub push subscription with the exact audience and service account shown.",
          "Renew users.watch before expiration."
        ])} else {json!(["The EHR polls Gmail outbound; no public EHR URL or inbound firewall rule is required."])}
    })))
}
async fn watch_status(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    actor.staff()?;
    let value:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('mailbox',mailbox,'delivery_mode',delivery_mode,'topic_name',topic_name,'label_ids',label_ids,'history_id',history_id,'expires_at',expires_at,'oidc_audience',oidc_audience,'oidc_service_account',oidc_service_account,'poll_seconds',poll_seconds,'next_poll_at',next_poll_at,'enabled',enabled,'status',status,'last_error',last_error,'version',version) FROM gmail_watches WHERE tenant_id=$1 AND integration_id=$2").bind(actor.tenant_id).bind(id).fetch_optional(db(&state)?).await?;
    Ok(reply(json!({"watch":value})))
}

#[derive(Deserialize)]
struct PushQuery {
    token: String,
}
#[derive(Deserialize)]
struct PushEnvelope {
    message: PushMessage,
    subscription: String,
}
#[derive(Deserialize)]
struct PushMessage {
    data: String,
    #[serde(rename = "messageId")]
    message_id: String,
    #[serde(rename = "publishTime")]
    _publish_time: Option<String>,
}
#[derive(Deserialize)]
struct GmailNotice {
    #[serde(rename = "emailAddress")]
    email_address: String,
    #[serde(rename = "historyId")]
    history_id: String,
}
#[derive(Clone, Deserialize)]
struct PubSubClaims {
    aud: String,
    email: String,
    email_verified: bool,
    exp: i64,
    iss: String,
}
#[derive(Deserialize)]
struct GoogleJwks {
    keys: Vec<GoogleJwk>,
}
#[derive(Deserialize)]
struct GoogleJwk {
    kid: String,
    n: String,
    e: String,
    alg: String,
    kty: String,
}
async fn verify_pubsub_jwt(token: &str, audience: &str, service_account: &str) -> Result<()> {
    let header = decode_header(token).map_err(|_| Error::Unauthorized)?;
    if header.alg != Algorithm::RS256 {
        return Err(Error::Unauthorized);
    }
    let kid = header.kid.ok_or(Error::Unauthorized)?;
    let jwks_response = client()?
        .get(GOOGLE_JWKS_URL)
        .send()
        .await
        .map_err(|_| Error::Unauthorized)?;
    let jwks: GoogleJwks = bounded_json(jwks_response, 256 * 1024)
        .await
        .map_err(|_| Error::Unauthorized)?;
    let key = jwks
        .keys
        .iter()
        .find(|key| key.kid == kid && key.alg == "RS256" && key.kty == "RSA")
        .ok_or(Error::Unauthorized)?;
    let decoding =
        DecodingKey::from_rsa_components(&key.n, &key.e).map_err(|_| Error::Unauthorized)?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[audience]);
    validation.set_issuer(&["accounts.google.com", "https://accounts.google.com"]);
    validation.leeway = 30;
    let claims = decode::<PubSubClaims>(token, &decoding, &validation)
        .map_err(|_| Error::Unauthorized)?
        .claims;
    if claims.aud != audience
        || claims.email != service_account
        || !claims.email_verified
        || claims.exp <= Utc::now().timestamp()
        || !matches!(
            claims.iss.as_str(),
            "accounts.google.com" | "https://accounts.google.com"
        )
    {
        return Err(Error::Unauthorized);
    }
    Ok(())
}
async fn pubsub_push(
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    Query(query): Query<PushQuery>,
    headers: HeaderMap,
    Json(envelope): Json<PushEnvelope>,
) -> Result<StatusCode> {
    if query.token.len() < 32
        || query.token.len() > 256
        || envelope.message.message_id.is_empty()
        || envelope.message.message_id.len() > 200
        || envelope.message.data.len() > 8192
        || envelope.subscription.len() > 500
    {
        return Err(Error::Invalid("invalid Pub/Sub notification"));
    }
    let pool = db(&state)?;
    let supplied_hash = hash(query.token.as_bytes());
    let watch:Option<(Uuid,String,String,String,bool,DateTime<Utc>)>=sqlx::query_as("SELECT tenant_id,mailbox,verification_hash,oidc_audience,enabled,expires_at FROM gmail_watches WHERE integration_id=$1 AND verification_hash=$2").bind(id).bind(&supplied_hash).fetch_optional(pool).await?;
    let (tenant, mailbox, verification_hash, audience, enabled, expires) =
        watch.ok_or(Error::Unauthorized)?;
    if !enabled
        || expires <= Utc::now()
        || verification_hash
            .as_bytes()
            .ct_eq(supplied_hash.as_bytes())
            .unwrap_u8()
            != 1
    {
        return Err(Error::Unauthorized);
    }
    let service_account: String = sqlx::query_scalar(
        "SELECT oidc_service_account FROM gmail_watches WHERE tenant_id=$1 AND integration_id=$2",
    )
    .bind(tenant)
    .bind(id)
    .fetch_one(pool)
    .await?;
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.len() < 8192)
        .ok_or(Error::Unauthorized)?;
    verify_pubsub_jwt(bearer, &audience, &service_account).await?;
    let decoded = decode_websafe(&envelope.message.data)?;
    let notice: GmailNotice = serde_json::from_slice(&decoded)
        .map_err(|_| Error::Invalid("invalid Gmail notification payload"))?;
    if notice.email_address != mailbox || !notice.history_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(Error::Invalid("Gmail notification mailbox does not match"));
    }
    let inserted=sqlx::query("INSERT INTO gmail_pubsub_notifications(tenant_id,integration_id,pubsub_message_id,mailbox,history_id,payload_digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING")
  .bind(tenant).bind(id).bind(&envelope.message.message_id).bind(&notice.email_address).bind(&notice.history_id).bind(hash(&decoded)).execute(pool).await?.rows_affected()==1;
    if inserted {
        let pool = pool.clone();
        tokio::spawn(async move {
            let _ = process_one(&pool, tenant, id).await;
        });
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn sync_now(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    owner(&actor)?;
    let processed_notification = process_one(db(&state)?, actor.tenant_id, id).await?;
    let polled = if processed_notification {
        false
    } else {
        poll_integration(db(&state)?, actor.tenant_id, id).await?
    };
    Ok(reply(
        json!({"processed_notification":processed_notification,"polled":polled}),
    ))
}

async fn process_one(pool: &PgPool, tenant: Uuid, id: Uuid) -> Result<bool> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE gmail_pubsub_notifications SET status=CASE WHEN attempt_count>=8 THEN 'needs_attention' ELSE 'queued' END,lease_id=NULL,lease_until=NULL,last_error=CASE WHEN attempt_count>=8 THEN 'processing_lease_exhausted' ELSE last_error END WHERE tenant_id=$1 AND integration_id=$2 AND status='processing' AND lease_until<now()")
        .bind(tenant).bind(id).execute(&mut *tx).await?;
    let lease = Uuid::new_v4();
    let row:Option<(String,String)>=sqlx::query_as("SELECT pubsub_message_id,history_id FROM gmail_pubsub_notifications WHERE tenant_id=$1 AND integration_id=$2 AND status='queued' ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1").bind(tenant).bind(id).fetch_optional(&mut *tx).await?;
    let Some((message_id, history_id)) = row else {
        tx.rollback().await?;
        return Ok(false);
    };
    sqlx::query("UPDATE gmail_pubsub_notifications SET status='processing',attempt_count=attempt_count+1,lease_id=$4,lease_until=now()+interval '90 seconds' WHERE tenant_id=$1 AND integration_id=$2 AND pubsub_message_id=$3").bind(tenant).bind(id).bind(&message_id).bind(lease).execute(&mut *tx).await?;
    tx.commit().await?;
    let result = sync_history(pool, tenant, id, &history_id).await;
    let mut tx = pool.begin().await?;
    match result {
        Ok(count) => {
            sqlx::query("UPDATE gmail_pubsub_notifications SET status='processed',processed_at=now(),lease_id=NULL,lease_until=NULL,last_error=NULL WHERE tenant_id=$1 AND integration_id=$2 AND pubsub_message_id=$3 AND lease_id=$4").bind(tenant).bind(id).bind(&message_id).bind(lease).execute(&mut *tx).await?;
            let actor: Uuid = sqlx::query_scalar(
                "SELECT created_by FROM instance_integrations WHERE tenant_id=$1 AND id=$2",
            )
            .bind(tenant)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            adapter_event(
                &mut tx,
                tenant,
                id,
                actor,
                "notification_processed",
                json!({"pubsub_message_id":message_id,"messages_staged":count}),
            )
            .await?;
            tx.commit().await?;
            Ok(true)
        }
        Err(_) => {
            sqlx::query("UPDATE gmail_pubsub_notifications SET status='needs_attention',last_error='gmail_sync_failed',lease_id=NULL,lease_until=NULL WHERE tenant_id=$1 AND integration_id=$2 AND pubsub_message_id=$3 AND lease_id=$4").bind(tenant).bind(id).bind(&message_id).bind(lease).execute(&mut *tx).await?;
            sqlx::query("UPDATE gmail_watches SET status='needs_attention',last_error='gmail_sync_failed',updated_at=now() WHERE tenant_id=$1 AND integration_id=$2").bind(tenant).bind(id).execute(&mut *tx).await?;
            tx.commit().await?;
            Err(Error::Invalid("Gmail history synchronization failed"))
        }
    }
}

async fn poll_integration(pool: &PgPool, tenant: Uuid, id: Uuid) -> Result<bool> {
    let lease = Uuid::new_v4();
    let mut tx = pool.begin().await?;
    let history:Option<String>=sqlx::query_scalar("SELECT history_id FROM gmail_watches WHERE tenant_id=$1 AND integration_id=$2 AND enabled AND status='active' AND (poll_lease_until IS NULL OR poll_lease_until<now()) FOR UPDATE SKIP LOCKED")
        .bind(tenant).bind(id).fetch_optional(&mut *tx).await?;
    let Some(history) = history else {
        tx.rollback().await?;
        return Ok(false);
    };
    sqlx::query("UPDATE gmail_watches SET poll_lease_id=$3,poll_lease_until=now()+interval '90 seconds' WHERE tenant_id=$1 AND integration_id=$2")
        .bind(tenant).bind(id).bind(lease).execute(&mut *tx).await?;
    tx.commit().await?;
    let result = sync_history(pool, tenant, id, &history).await;
    let mut tx = pool.begin().await?;
    match result {
        Ok(_) => {
            sqlx::query("UPDATE gmail_watches SET next_poll_at=now()+make_interval(secs=>poll_seconds),poll_lease_id=NULL,poll_lease_until=NULL,status='active',last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND integration_id=$2 AND poll_lease_id=$3")
                .bind(tenant).bind(id).bind(lease).execute(&mut *tx).await?;
            tx.commit().await?;
            Ok(true)
        }
        Err(_) => {
            sqlx::query("UPDATE gmail_watches SET next_poll_at=now()+make_interval(secs=>poll_seconds),poll_lease_id=NULL,poll_lease_until=NULL,status='needs_attention',last_error='gmail_poll_failed',updated_at=now() WHERE tenant_id=$1 AND integration_id=$2 AND poll_lease_id=$3")
                .bind(tenant).bind(id).bind(lease).execute(&mut *tx).await?;
            tx.commit().await?;
            Err(Error::Invalid("Gmail polling failed"))
        }
    }
}

async fn poll_due(pool: &PgPool) -> Result<bool> {
    let due:Option<(Uuid,Uuid)>=sqlx::query_as("SELECT tenant_id,integration_id FROM gmail_watches WHERE enabled AND delivery_mode='poll' AND status='active' AND next_poll_at<=now() AND (poll_lease_until IS NULL OR poll_lease_until<now()) ORDER BY next_poll_at FOR UPDATE SKIP LOCKED LIMIT 1")
        .fetch_optional(pool).await?;
    let Some((tenant, id)) = due else {
        return Ok(false);
    };
    poll_integration(pool, tenant, id).await
}

/// Runs inside the independently operated EHR. It only makes outbound Gmail calls.
pub async fn run(pool: PgPool) {
    let mut tick = tokio::time::interval(StdDuration::from_secs(30));
    loop {
        tick.tick().await;
        for _ in 0..10 {
            match poll_due(&pool).await {
                Ok(true) => {}
                Ok(false) | Err(_) => break,
            }
        }
    }
}

async fn sync_history(
    pool: &PgPool,
    tenant: Uuid,
    id: Uuid,
    notice_history: &str,
) -> Result<usize> {
    let row = integration(pool, tenant, id).await?;
    let token = access_token(pool, &row).await?;
    let (mailbox,start):(String,String)=sqlx::query_as("SELECT mailbox,history_id FROM gmail_watches WHERE tenant_id=$1 AND integration_id=$2 AND enabled AND status IN ('active','needs_attention')").bind(tenant).bind(id).fetch_one(pool).await?;
    let http = client()?;
    let mut page: Option<String> = None;
    let mut ids = HashSet::new();
    let mut latest = notice_history.to_owned();
    for _ in 0..10 {
        let mut request = http
            .get(format!("{GMAIL_API}/users/me/history"))
            .bearer_auth(token.as_str())
            .query(&[
                ("startHistoryId", start.as_str()),
                ("historyTypes", "messageAdded"),
            ]);
        if let Some(ref page) = page {
            request = request.query(&[("pageToken", page)]);
        }
        let response = request
            .send()
            .await
            .map_err(|_| Error::Invalid("Gmail history request unavailable"))?;
        if !response.status().is_success() {
            return Err(Error::Invalid("Gmail history request rejected"));
        }
        let value: Value = bounded_json(response, MAX_MESSAGE_RESPONSE_BYTES).await?;
        if let Some(v) = value.get("historyId").and_then(Value::as_str) {
            latest = v.to_owned();
        }
        if let Some(history) = value.get("history").and_then(Value::as_array) {
            for item in history {
                if let Some(added) = item.get("messagesAdded").and_then(Value::as_array) {
                    for message in added {
                        if let Some(mid) = message.pointer("/message/id").and_then(Value::as_str) {
                            ids.insert(mid.to_owned());
                            if ids.len() > MAX_MESSAGES_PER_SYNC {
                                return Err(Error::Invalid("Gmail sync message limit exceeded"));
                            }
                        }
                    }
                }
            }
        }
        page = value
            .get("nextPageToken")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if page.is_none() {
            break;
        }
    }
    let mut staged = 0;
    for message in ids {
        if stage_message(pool, &http, &token, tenant, id, &message).await? {
            staged += 1;
        }
    }
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE gmail_watches SET history_id=$3,status='active',last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND integration_id=$2 AND mailbox=$4").bind(tenant).bind(id).bind(latest).bind(mailbox).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(staged)
}

#[derive(Clone)]
struct AttachmentPart {
    part_id: String,
    attachment_id: String,
    filename: String,
    mime_type: String,
    size: usize,
}
fn collect_parts(
    part: &Value,
    body: &mut String,
    attachments: &mut Vec<AttachmentPart>,
) -> Result<()> {
    let mut visited = 0usize;
    collect_parts_inner(part, body, attachments, 0, &mut visited)
}
fn collect_parts_inner(
    part: &Value,
    body: &mut String,
    attachments: &mut Vec<AttachmentPart>,
    depth: usize,
    visited: &mut usize,
) -> Result<()> {
    *visited += 1;
    if depth > 32 || *visited > 1_000 || attachments.len() > 100 {
        return Err(Error::Invalid("Gmail MIME structure exceeds limit"));
    }
    let part_id = part.get("partId").and_then(Value::as_str).unwrap_or("root");
    let mime = part
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");
    let filename = part.get("filename").and_then(Value::as_str).unwrap_or("");
    if let Some(data) = part.pointer("/body/data").and_then(Value::as_str) {
        let decoded = decode_websafe(data)?;
        if mime.starts_with("text/")
            && filename.is_empty()
            && body.len() + decoded.len() <= 1_048_576
        {
            body.push_str(&String::from_utf8_lossy(&decoded));
            body.push('\n');
        }
    }
    if !filename.is_empty() {
        if let Some(attachment_id) = part.pointer("/body/attachmentId").and_then(Value::as_str) {
            if attachments.len() >= 100 {
                return Err(Error::Invalid("Gmail attachment count exceeds limit"));
            }
            let size = part
                .pointer("/body/size")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            if size > MAX_ATTACHMENT_BYTES {
                return Err(Error::Invalid("Gmail attachment exceeds limit"));
            }
            attachments.push(AttachmentPart {
                part_id: part_id.to_owned(),
                attachment_id: attachment_id.to_owned(),
                filename: filename.chars().take(500).collect(),
                mime_type: mime.chars().take(200).collect(),
                size,
            });
        }
    }
    if let Some(parts) = part.get("parts").and_then(Value::as_array) {
        for child in parts {
            collect_parts_inner(child, body, attachments, depth + 1, visited)?;
        }
    }
    Ok(())
}
fn header_value(payload: &Value, name: &str) -> Option<String> {
    payload
        .get("headers")?
        .as_array()?
        .iter()
        .find(|v| {
            v.get("name")
                .and_then(Value::as_str)
                .is_some_and(|v| v.eq_ignore_ascii_case(name))
        })?
        .get("value")?
        .as_str()
        .map(|v| v.chars().take(2000).collect())
}
async fn stage_message(
    pool: &PgPool,
    http: &reqwest::Client,
    token: &str,
    tenant: Uuid,
    id: Uuid,
    message_id: &str,
) -> Result<bool> {
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM gmail_referral_inbox WHERE tenant_id=$1 AND integration_id=$2 AND gmail_message_id=$3)").bind(tenant).bind(id).bind(message_id).fetch_one(pool).await?;
    if exists {
        return Ok(false);
    }
    let message_response = http
        .get(format!("{GMAIL_API}/users/me/messages/{message_id}"))
        .bearer_auth(token)
        .query(&[("format", "full")])
        .send()
        .await
        .map_err(|_| Error::Invalid("Gmail message request unavailable"))?;
    let message: Value = bounded_json(message_response, MAX_MESSAGE_RESPONSE_BYTES).await?;
    let payload = message
        .get("payload")
        .ok_or(Error::Invalid("Gmail message payload missing"))?;
    let mut body = String::new();
    let mut parts = Vec::new();
    collect_parts(payload, &mut body, &mut parts)?;
    let mut fetched = Vec::new();
    let mut total = 0usize;
    for part in parts {
        let attachment_response = http
            .get(format!(
                "{GMAIL_API}/users/me/messages/{message_id}/attachments/{}",
                part.attachment_id
            ))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| Error::Invalid("Gmail attachment request unavailable"))?;
        let value: Value = bounded_json(attachment_response, MAX_ATTACHMENT_RESPONSE_BYTES).await?;
        let bytes = decode_websafe(
            value
                .get("data")
                .and_then(Value::as_str)
                .ok_or(Error::Invalid("Gmail attachment data missing"))?,
        )?;
        if bytes.len() > MAX_ATTACHMENT_BYTES || total + bytes.len() > MAX_TOTAL_ATTACHMENT_BYTES {
            return Err(Error::Invalid("Gmail attachments exceed limit"));
        }
        if part.size > 0 && bytes.len() != part.size {
            return Err(Error::Invalid(
                "Gmail attachment size does not match metadata",
            ));
        }
        total += bytes.len();
        fetched.push((part, bytes));
    }
    let inbox_id = Uuid::new_v4();
    let internal = message
        .get("internalDate")
        .and_then(Value::as_str)
        .and_then(|v| v.parse::<i64>().ok())
        .and_then(|v| Utc.timestamp_millis_opt(v).single());
    let labels = message
        .get("labelIds")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let recipients = [header_value(payload, "To"), header_value(payload, "Cc")]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let mut tx = pool.begin().await?;
    let inserted=sqlx::query("INSERT INTO gmail_referral_inbox(tenant_id,id,integration_id,gmail_message_id,thread_id,internal_date,sender,recipients,subject,snippet,body_text,labels) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING")
  .bind(tenant).bind(inbox_id).bind(id).bind(message_id).bind(message.get("threadId").and_then(Value::as_str)).bind(internal).bind(header_value(payload,"From")).bind(json!(recipients)).bind(header_value(payload,"Subject")).bind(message.get("snippet").and_then(Value::as_str).map(|v|v.chars().take(5000).collect::<String>())).bind(if body.is_empty(){None}else{Some(body)}).bind(labels).execute(&mut *tx).await?.rows_affected()==1;
    if inserted {
        let attachment_count = fetched.len();
        for (part, bytes) in fetched {
            sqlx::query("INSERT INTO gmail_referral_attachments(tenant_id,inbox_id,part_id,filename,mime_type,size_bytes,digest,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(tenant).bind(inbox_id).bind(part.part_id).bind(part.filename).bind(part.mime_type).bind(bytes.len() as i64).bind(hash(&bytes)).bind(bytes).execute(&mut *tx).await?;
        }
        let actor: Uuid = sqlx::query_scalar(
            "SELECT created_by FROM instance_integrations WHERE tenant_id=$1 AND id=$2",
        )
        .bind(tenant)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        adapter_event(&mut tx,tenant,id,actor,"referral_staged",json!({"inbox_id":inbox_id,"gmail_message_id":message_id,"attachment_count":attachment_count})).await?;
    }
    tx.commit().await?;
    Ok(inserted)
}

async fn inbox(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    actor.staff()?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'gmail_message_id',gmail_message_id,'internal_date',internal_date,'sender',sender,'subject',subject,'snippet',snippet,'status',status,'patient_id',patient_id,'version',version,'created_at',created_at,'attachment_count',(SELECT count(*) FROM gmail_referral_attachments a WHERE a.tenant_id=i.tenant_id AND a.inbox_id=i.id)) FROM gmail_referral_inbox i WHERE tenant_id=$1 AND integration_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100").bind(actor.tenant_id).bind(id).fetch_all(db(&state)?).await?;
    Ok(reply(json!({"items":items})))
}
async fn inbox_detail(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path((id, entry)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    actor.staff()?;
    let item:Value=sqlx::query_scalar("SELECT (to_jsonb(i)-'tenant_id'-'integration_id') || jsonb_build_object('attachments',(SELECT coalesce(jsonb_agg(jsonb_build_object('part_id',part_id,'filename',filename,'mime_type',mime_type,'size_bytes',size_bytes,'digest',digest) ORDER BY part_id),'[]'::jsonb) FROM gmail_referral_attachments a WHERE a.tenant_id=i.tenant_id AND a.inbox_id=i.id)) FROM gmail_referral_inbox i WHERE tenant_id=$1 AND integration_id=$2 AND id=$3").bind(actor.tenant_id).bind(id).bind(entry).fetch_optional(db(&state)?).await?.ok_or(Error::NotFound)?;
    Ok(reply(item))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InboxAction {
    action: String,
    patient_id: Option<Uuid>,
    reason: String,
}
async fn inbox_action(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path((id, entry)): Path<(Uuid, Uuid)>,
    Json(input): Json<InboxAction>,
) -> Result<Response> {
    actor.staff()?;
    let reason = clean(&input.reason, 500)?;
    let mut tx = db(&state)?.begin().await?;
    let current:(String,i64)=sqlx::query_as("SELECT status,version FROM gmail_referral_inbox WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 FOR UPDATE").bind(actor.tenant_id).bind(id).bind(entry).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let patient = match input.action.as_str() {
        "link" => {
            actor.clinical()?;
            let patient = input
                .patient_id
                .ok_or(Error::Invalid("choose a patient before linking"))?;
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)",
            )
            .bind(actor.tenant_id)
            .bind(patient)
            .fetch_one(&mut *tx)
            .await?;
            if !exists {
                return Err(Error::NotFound);
            }
            Some(patient)
        }
        "dismiss" => None,
        _ => return Err(Error::Invalid("unsupported Gmail referral action")),
    };
    let status = if input.action == "link" {
        "linked"
    } else {
        "dismissed"
    };
    sqlx::query("UPDATE gmail_referral_inbox SET status=$4,patient_id=$5,version=version+1,reviewed_by=$6,reviewed_at=now(),updated_at=now() WHERE tenant_id=$1 AND integration_id=$2 AND id=$3").bind(actor.tenant_id).bind(id).bind(entry).bind(status).bind(patient).bind(actor.sub).execute(&mut *tx).await?;
    adapter_event(&mut tx,actor.tenant_id,id,actor.sub,"referral_reviewed",json!({"inbox_id":entry,"from_status":current.0,"to_status":status,"patient_id":patient,"reason":reason})).await?;
    tx.commit().await?;
    Ok(reply(
        json!({"id":entry,"status":status,"patient_id":patient,"version":current.1+1}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pkce_uses_s256_without_padding() {
        let challenge =
            pkce_challenge("gmail_pkce_synthetic-verifier-abcdefghijklmnopqrstuvwxyz0123456789");
        assert!(!challenge.contains('='));
        assert_eq!(challenge.len(), 43);
    }
    #[test]
    fn credentials_upgrade_from_client_secret_to_bundle() {
        let old = credential_bundle("synthetic-client-secret");
        assert_eq!(old.client_secret, "synthetic-client-secret");
        assert!(old.access_token.is_none());
        let encoded = serde_json::to_string(&CredentialBundle {
            client_secret: "secret".into(),
            access_token: Some("access".into()),
            refresh_token: Some("refresh".into()),
            expires_at: Some(Utc::now()),
            scope: Some(GMAIL_SCOPE.into()),
        })
        .unwrap();
        assert_eq!(
            credential_bundle(&encoded).refresh_token.as_deref(),
            Some("refresh")
        );
    }
    #[test]
    fn attachment_limits_are_bounded() {
        assert_eq!(MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024);
        assert_eq!(MAX_TOTAL_ATTACHMENT_BYTES, 20 * 1024 * 1024);
        assert_eq!(MAX_MESSAGE_RESPONSE_BYTES, 2 * 1024 * 1024);
        assert_eq!(MAX_ATTACHMENT_RESPONSE_BYTES, 14 * 1024 * 1024);
    }
    #[test]
    fn callback_and_push_urls_require_plain_https() {
        assert!(https_url("https://ehr.example.test/callback").is_ok());
        assert!(https_url("http://ehr.example.test/callback").is_err());
        assert!(https_url("https://user@ehr.example.test/callback").is_err());
        assert!(https_url("https://ehr.example.test/callback#fragment").is_err());
    }
    #[test]
    fn mime_parser_stages_body_and_attachment_metadata_only() {
        let body_data = URL_SAFE_NO_PAD.encode(b"synthetic referral body");
        let payload = json!({
          "mimeType":"multipart/mixed",
          "parts":[
            {"partId":"0","mimeType":"text/plain","filename":"","body":{"data":body_data}},
            {"partId":"1","mimeType":"application/pdf","filename":"referral.pdf","body":{"attachmentId":"attachment-1","size":42}}
          ]
        });
        let mut body = String::new();
        let mut attachments = Vec::new();
        collect_parts(&payload, &mut body, &mut attachments).unwrap();
        assert!(body.contains("synthetic referral body"));
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].attachment_id, "attachment-1");
    }
}
