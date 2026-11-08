// SPDX-License-Identifier: AGPL-3.0-only
//! Instance-local third-party integration registry.
//!
//! Secrets and OAuth callback material stay in this EHR installation. Provider
//! adapters must validate their real contracts before claiming authentication.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration, Utc};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
use zeroize::Zeroizing;

const PROVIDERS: &[&str] = &["ringcentral", "gmail", "claude", "erebine", "healthclinics"];

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
fn clean(value: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        Err(Error::Invalid(
            "required text is missing or exceeds its limit",
        ))
    } else {
        Ok(value.to_owned())
    }
}
fn auth_type(provider: &str) -> Option<&'static str> {
    match provider {
        "ringcentral" | "gmail" => Some("oauth2"),
        "claude" | "erebine" => Some("api_key"),
        "healthclinics" => Some("oauth2_client"),
        _ => None,
    }
}
fn allowed(provider: &str) -> &'static [&'static str] {
    match provider {
        "ringcentral" => &["voice", "sms", "fax", "voicemail", "call_events"],
        "gmail" => &["referral_email", "attachments", "threaded_reply"],
        "claude" | "erebine" => &[
            "document_classification",
            "structured_extraction",
            "draft_summary",
            "draft_response",
            "workflow_design",
        ],
        "healthclinics" => &[
            "scheduling_availability_read",
            "scheduling_appointments_read",
            "scheduling_appointments_write",
            "scheduling_webhooks",
        ],
        _ => &[],
    }
}

fn capabilities(provider: &str, requested: Option<Vec<String>>) -> Result<Vec<String>> {
    let allowed = allowed(provider);
    let values = requested.unwrap_or_else(|| allowed.iter().map(|v| (*v).to_owned()).collect());
    if values.len() > allowed.len()
        || values.iter().any(|v| !allowed.contains(&v.as_str()))
        || values
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != values.len()
    {
        Err(Error::Invalid(
            "unsupported or duplicate integration capability",
        ))
    } else {
        Ok(values)
    }
}
fn validate_config(config: &Value) -> Result<()> {
    let object = config
        .as_object()
        .ok_or(Error::Invalid("integration config must be an object"))?;
    if object.len() > 40 || serde_json::to_vec(config).map_or(true, |v| v.len() > 32_768) {
        return Err(Error::Invalid("integration config exceeds its limit"));
    }
    fn contains_credential_key(value: &Value) -> bool {
        const FORBIDDEN: &[&str] = &[
            "secret",
            "api_key",
            "access_token",
            "refresh_token",
            "client_secret",
            "password",
            "token",
            "credential",
            "credentials",
            "authorization",
            "private_key",
        ];
        match value {
            Value::Object(object) => object.iter().any(|(key, value)| {
                FORBIDDEN.contains(&key.to_ascii_lowercase().as_str())
                    || contains_credential_key(value)
            }),
            Value::Array(values) => values.iter().any(contains_credential_key),
            _ => false,
        }
    }
    if contains_credential_key(config) {
        return Err(Error::Invalid(
            "credentials must use the protected credential field",
        ));
    }
    Ok(())
}
fn validate_provider_config(provider: &str, config: &Value) -> Result<()> {
    if provider == "erebine" {
        crate::erebine_adapter::validate_config(config)?;
    }
    Ok(())
}
fn hint(secret: &str) -> String {
    let suffix: String = secret
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("••••{suffix}")
}
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(sqlx::FromRow)]
struct Integration {
    id: Uuid,
    provider: String,
    label: String,
    auth_type: String,
    status: String,
    enabled: bool,
    capabilities: Value,
    config: Value,
    credential_revision: i64,
    credential_hint: Option<String>,
    last_test_at: Option<DateTime<Utc>>,
    last_test_result: Option<String>,
    last_error: Option<String>,
    version: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
impl Integration {
    fn public(&self) -> Value {
        json!({"id":self.id,"provider":self.provider,"label":self.label,
            "auth_type":self.auth_type,"status":self.status,"enabled":self.enabled,
            "capabilities":self.capabilities,"config":self.config,
            "credential_stored":self.credential_revision>0,"credential_hint":self.credential_hint,
            "credential_revision":self.credential_revision,
            "oauth_supported":matches!(self.auth_type.as_str(),"oauth2"|"oauth2_client"),
            "last_test_at":self.last_test_at,"last_test_result":self.last_test_result,
            "last_error":self.last_error,"version":self.version,
            "created_at":self.created_at,"updated_at":self.updated_at})
    }
}

async fn locked(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
) -> Result<Integration> {
    sqlx::query_as("SELECT id,provider,label,auth_type,status,enabled,capabilities,config,credential_revision,credential_hint,last_test_at,last_test_result,last_error,version,created_at,updated_at FROM instance_integrations WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
    action: &str,
    evidence: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO instance_integration_events(tenant_id,integration_id,version,actor_id,action,evidence) SELECT tenant_id,id,version,$3,$4,$5 FROM instance_integrations WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).bind(actor.sub).bind(action).bind(evidence).execute(&mut **tx).await?;
    crate::postgres::audit(tx, actor, "integration.settings_change", id).await
}
async fn credential_ready(pool: &PgPool, tenant: Uuid, row: &Integration) -> bool {
    if row.credential_revision == 0 {
        return true;
    }
    let encrypted: Option<Vec<u8>> = sqlx::query_scalar("SELECT encrypted_secret FROM instance_integration_credentials WHERE tenant_id=$1 AND integration_id=$2 AND revision=$3")
        .bind(tenant).bind(row.id).bind(row.credential_revision).fetch_optional(pool).await.ok().flatten();
    encrypted.is_some_and(|encrypted| {
        crate::provider_settings::open_secret(tenant, row.id, "instance-integration", &encrypted)
            .is_ok()
    })
}

fn healthclinics_client_id(row: &Integration) -> Result<Uuid> {
    let value = row
        .config
        .get("oauth_client_id")
        .and_then(Value::as_str)
        .ok_or(Error::Invalid(
            "HealthClinics requires a tenant EHR OAuth client ID",
        ))?;
    let client_id = Uuid::parse_str(value)
        .map_err(|_| Error::Invalid("HealthClinics OAuth client ID is invalid"))?;
    Ok(client_id)
}

async fn healthclinics_oauth_client(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    row: &Integration,
) -> Result<(Uuid, bool)> {
    let client_id = healthclinics_client_id(row)?;
    let client_active: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM oauth_clients WHERE tenant_id=$1 AND id=$2 AND NOT disabled)",
    )
    .bind(actor.tenant_id)
    .bind(client_id)
    .fetch_one(&mut **tx)
    .await?;
    if !client_active {
        return Err(Error::Invalid(
            "HealthClinics OAuth client is missing, disabled, or belongs to another tenant",
        ));
    }
    let grant_active: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM oauth_grants g JOIN browser_users u ON u.id=g.user_id AND u.tenant_id=g.tenant_id WHERE g.tenant_id=$1 AND g.client_id=$2 AND g.revoked_at IS NULL AND NOT u.disabled)",
    )
    .bind(actor.tenant_id)
    .bind(client_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok((client_id, grant_active))
}

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/integrations/providers", get(provider_catalog))
        .route("/api/v1/integrations", get(list).post(create))
        .route(
            "/api/v1/integrations/erebine/models",
            post(erebine_models_preview),
        )
        .route(
            "/api/v1/integrations/{id}/erebine/models",
            get(erebine_models),
        )
        .route("/api/v1/integrations/{id}", get(detail).put(update))
        .route("/api/v1/integrations/{id}/actions", post(action))
        .route(
            "/api/v1/integrations/{id}/oauth/intents",
            post(oauth_intent),
        )
        .route("/api/v1/integrations/oauth/callback", get(oauth_callback))
}
async fn provider_catalog(actor: Actor) -> Result<Response> {
    owner(&actor)?;
    Ok(reply(
        json!({"providers":PROVIDERS.iter().map(|provider|json!({
        "provider":provider,"auth_type":auth_type(provider),
        "oauth_supported":matches!(auth_type(provider),Some("oauth2"|"oauth2_client")),
        "capabilities":allowed(provider),
        "boundary":match *provider {
            "claude" | "erebine" => "clinic_byok_direct",
            "healthclinics" => "ehr_oauth_api_consumer",
            _ => "instance_local",
        },
        "authorization_intent_supported":matches!(*provider,"ringcentral"|"gmail")
    })).collect::<Vec<_>>() }),
    ))
}
async fn list(actor: Actor, ExtractState(state): ExtractState<State>) -> Result<Response> {
    owner(&actor)?;
    let mut tx = db(&state)?.begin().await?;
    let rows:Vec<Integration>=sqlx::query_as("SELECT id,provider,label,auth_type,status,enabled,capabilities,config,credential_revision,credential_hint,last_test_at,last_test_result,last_error,version,created_at,updated_at FROM instance_integrations WHERE tenant_id=$1 ORDER BY provider,created_at,id LIMIT 100")
        .bind(actor.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(
        &mut tx,
        &actor,
        "integration.settings_read",
        actor.tenant_id,
    )
    .await?;
    tx.commit().await?;
    let mut storage_ready = true;
    for row in &rows {
        storage_ready &= credential_ready(db(&state)?, actor.tenant_id, row).await;
    }
    Ok(reply(
        json!({"items":rows.iter().map(Integration::public).collect::<Vec<_>>(),"credential_storage_ready":storage_ready}),
    ))
}
async fn detail(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    owner(&actor)?;
    let mut tx = db(&state)?.begin().await?;
    let row = locked(&mut tx, &actor, id).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id'-'integration_id' FROM instance_integration_events e WHERE tenant_id=$1 AND integration_id=$2 ORDER BY sequence DESC LIMIT 100")
        .bind(actor.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "integration.setting_read", id).await?;
    tx.commit().await?;
    Ok(reply(json!({"integration":row.public(),"events":events})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ErebineModelDiscovery {
    config: Value,
    credential: String,
}

fn model_discovery_response(
    result: std::result::Result<Vec<String>, crate::claude_adapter::ProviderFailure>,
) -> Result<Response> {
    let models = result.map_err(|failure| Error::Conflict(failure.code()))?;
    Ok(reply(
        json!({"models":models.into_iter().map(|id|json!({"id":id})).collect::<Vec<_>>()}),
    ))
}

/// Discover the account's native model IDs before persisting a new connection.
/// Only protected request input goes to the SDK; no credential is stored here.
async fn erebine_models_preview(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Json(input): Json<ErebineModelDiscovery>,
) -> Result<Response> {
    owner(&actor)?;
    validate_config(&input.config)?;
    let credential = Zeroizing::new(input.credential);
    validate_credential(&credential)?;
    let result = crate::erebine_adapter::discover_models(&input.config, &credential).await;
    let mut tx = db(&state)?.begin().await?;
    crate::postgres::audit(
        &mut tx,
        &actor,
        "integration.models_discovery",
        actor.tenant_id,
    )
    .await?;
    tx.commit().await?;
    model_discovery_response(result)
}

async fn erebine_models(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    owner(&actor)?;
    let row: Option<(Value, Vec<u8>)> = sqlx::query_as(
        "SELECT i.config,c.encrypted_secret FROM instance_integrations i
         JOIN instance_integration_credentials c ON c.tenant_id=i.tenant_id
          AND c.integration_id=i.id AND c.revision=i.credential_revision
         WHERE i.tenant_id=$1 AND i.id=$2 AND i.provider='erebine' AND i.status<>'revoked'",
    )
    .bind(actor.tenant_id)
    .bind(id)
    .fetch_optional(db(&state)?)
    .await?;
    let (config, encrypted) = row.ok_or(Error::NotFound)?;
    let credential = crate::provider_settings::open_secret(
        actor.tenant_id,
        id,
        "instance-integration",
        &encrypted,
    )?;
    let result = crate::erebine_adapter::discover_models(&config, credential.expose()).await;
    let mut tx = db(&state)?.begin().await?;
    crate::postgres::audit(&mut tx, &actor, "integration.models_discovery", id).await?;
    tx.commit().await?;
    model_discovery_response(result)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    provider: String,
    label: String,
    capabilities: Option<Vec<String>>,
    #[serde(default = "empty_object")]
    config: Value,
    credential: Option<String>,
}
fn empty_object() -> Value {
    json!({})
}
fn validate_credential(secret: &str) -> Result<()> {
    if secret.len() < 8 || secret.len() > 16_384 || secret.chars().any(char::is_control) {
        return Err(Error::Invalid("credential is missing or exceeds its limit"));
    }
    Ok(())
}
async fn save_credential(
    tx: &mut Transaction<'_, Postgres>,
    pool: &PgPool,
    actor: &Actor,
    id: Uuid,
    revision: i64,
    secret: &str,
) -> Result<()> {
    validate_credential(secret)?;
    let encrypted = crate::provider_settings::seal_secret(
        pool,
        actor.tenant_id,
        id,
        "instance-integration",
        secret,
    )
    .await?;
    sqlx::query("INSERT INTO instance_integration_credentials(tenant_id,integration_id,revision,encrypted_secret,fingerprint,created_by) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(actor.tenant_id).bind(id).bind(revision).bind(encrypted)
        .bind(crate::oauth::hash(secret)).bind(actor.sub).execute(&mut **tx).await?;
    Ok(())
}
async fn create(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Json(mut input): Json<Create>,
) -> Result<Response> {
    owner(&actor)?;
    input.provider = input.provider.trim().to_ascii_lowercase();
    let auth =
        auth_type(&input.provider).ok_or(Error::Invalid("unsupported integration provider"))?;
    input.label = clean(&input.label, 120)?;
    let caps = capabilities(&input.provider, input.capabilities.take())?;
    validate_config(&input.config)?;
    validate_provider_config(&input.provider, &input.config)?;
    let secret = input.credential.take().map(Zeroizing::new);
    if input.provider == "healthclinics" && secret.is_some() {
        return Err(Error::Invalid(
            "HealthClinics uses an EHR OAuth client and does not store a vendor credential",
        ));
    }
    let id = Uuid::new_v4();
    let mut tx = db(&state)?.begin().await?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM instance_integrations WHERE tenant_id=$1")
            .bind(actor.tenant_id)
            .fetch_one(&mut *tx)
            .await?;
    if count >= 50 {
        return Err(Error::Invalid("integration limit reached"));
    }
    let revision = if secret.is_some() { 1i64 } else { 0 };
    sqlx::query("INSERT INTO instance_integrations(tenant_id,id,provider,label,auth_type,capabilities,config,credential_revision,credential_hint,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)")
        .bind(actor.tenant_id).bind(id).bind(&input.provider).bind(&input.label).bind(auth)
        .bind(json!(caps)).bind(&input.config).bind(revision)
        .bind(secret.as_ref().map(|value|hint(value))).bind(actor.sub).execute(&mut *tx).await?;
    if let Some(secret) = &secret {
        save_credential(&mut tx, db(&state)?, &actor, id, 1, secret).await?;
    }
    event(
        &mut tx,
        &actor,
        id,
        "integration_created",
        json!({"provider":input.provider,"credential_stored":secret.is_some(),"capabilities":caps}),
    )
    .await?;
    let row = locked(&mut tx, &actor, id).await?;
    tx.commit().await?;
    Ok(reply(row.public()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Update {
    label: String,
    capabilities: Option<Vec<String>>,
    #[serde(default = "empty_object")]
    config: Value,
    credential: Option<String>,
}
async fn update(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(mut input): Json<Update>,
) -> Result<Response> {
    owner(&actor)?;
    let expected = crate::expected(&headers)?;
    input.label = clean(&input.label, 120)?;
    validate_config(&input.config)?;
    let mut tx = db(&state)?.begin().await?;
    let current = locked(&mut tx, &actor, id).await?;
    if current.version != expected {
        return Err(Error::Conflict("integration changed; reload before saving"));
    }
    if current.status == "revoked" {
        return Err(Error::Conflict("revoked integration cannot be changed"));
    }
    validate_provider_config(&current.provider, &input.config)?;
    let caps = capabilities(&current.provider, input.capabilities.take())?;
    let secret = input.credential.take().map(Zeroizing::new);
    if current.provider == "healthclinics" && secret.is_some() {
        return Err(Error::Invalid(
            "HealthClinics uses an EHR OAuth client and does not store a vendor credential",
        ));
    }
    let revision = current.credential_revision + i64::from(secret.is_some());
    if let Some(secret) = &secret {
        save_credential(&mut tx, db(&state)?, &actor, id, revision, secret).await?;
    }
    sqlx::query("UPDATE instance_integrations SET label=$3,capabilities=$4,config=$5,credential_revision=$6,credential_hint=coalesce($7,credential_hint),status='disconnected',enabled=false,last_test_at=NULL,last_test_result=NULL,last_error=NULL,version=version+1,updated_by=$8,updated_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).bind(&input.label).bind(json!(caps)).bind(&input.config)
        .bind(revision).bind(secret.as_ref().map(|value|hint(value))).bind(actor.sub).execute(&mut *tx).await?;
    event(
        &mut tx,
        &actor,
        id,
        if secret.is_some() {
            "credential_rotated"
        } else {
            "settings_updated"
        },
        json!({"credential_rotated":secret.is_some(),"capabilities":caps}),
    )
    .await?;
    let row = locked(&mut tx, &actor, id).await?;
    tx.commit().await?;
    Ok(reply(row.public()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    action: String,
}
async fn action(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<Action>,
) -> Result<Response> {
    owner(&actor)?;
    let expected = crate::expected(&headers)?;
    let mut tx = db(&state)?.begin().await?;
    let current = locked(&mut tx, &actor, id).await?;
    if current.version != expected {
        return Err(Error::Conflict(
            "integration changed; reload before applying action",
        ));
    }
    let action = input.action.trim();
    let healthclinics = current.provider == "healthclinics";
    let revoke_healthclinics_client = action == "revoke" && healthclinics;
    let (status, enabled, result): (&str, bool, Option<&str>) = match action {
        "test" => {
            if healthclinics {
                healthclinics_oauth_client(&mut tx, &actor, &current).await?;
                (
                    &current.status,
                    current.enabled,
                    Some("ehr_oauth_client_verified"),
                )
            } else {
                if current.credential_revision == 0 {
                    return Err(Error::Invalid("save a credential before testing storage"));
                }
                let encrypted:Vec<u8>=sqlx::query_scalar("SELECT encrypted_secret FROM instance_integration_credentials WHERE tenant_id=$1 AND integration_id=$2 AND revision=$3")
                    .bind(actor.tenant_id).bind(id).bind(current.credential_revision).fetch_one(&mut *tx).await?;
                crate::provider_settings::open_secret(
                    actor.tenant_id,
                    id,
                    "instance-integration",
                    &encrypted,
                )?;
                (
                    &current.status,
                    current.enabled,
                    Some("credential_storage_verified"),
                )
            }
        }
        "enable" => {
            if current.status == "revoked" {
                return Err(Error::Conflict("revoked integration cannot be enabled"));
            }
            if healthclinics {
                let (_, grant_active) =
                    healthclinics_oauth_client(&mut tx, &actor, &current).await?;
                (
                    if grant_active { "connected" } else { "pending" },
                    true,
                    None,
                )
            } else {
                if current.credential_revision == 0 {
                    return Err(Error::Invalid("save a credential before enabling"));
                }
                ("pending", true, None)
            }
        }
        "disable" => (
            if current.status == "revoked" {
                "revoked"
            } else {
                "disconnected"
            },
            false,
            None,
        ),
        "revoke" => ("revoked", false, None),
        _ => return Err(Error::Invalid("unsupported integration action")),
    };
    if revoke_healthclinics_client {
        let client_id = healthclinics_client_id(&current)?;
        sqlx::query(
            "UPDATE oauth_grants SET revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=$1 AND client_id=$2",
        )
        .bind(actor.tenant_id)
        .bind(client_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE oauth_clients SET disabled=true WHERE tenant_id=$1 AND id=$2")
            .bind(actor.tenant_id)
            .bind(client_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE instance_integrations SET status=$3,enabled=$4,last_test_at=CASE WHEN $5::text IS NULL THEN last_test_at ELSE now() END,last_test_result=coalesce($5,last_test_result),last_error=NULL,version=version+1,updated_by=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).bind(status).bind(enabled).bind(result).bind(actor.sub).execute(&mut *tx).await?;
    event(
        &mut tx,
        &actor,
        id,
        &format!("integration_{action}"),
        json!({"enabled":enabled,"status":status,"result":result,
            "local_oauth_client_disabled":revoke_healthclinics_client}),
    )
    .await?;
    let row = locked(&mut tx, &actor, id).await?;
    tx.commit().await?;
    Ok(reply(row.public()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OAuthIntent {
    redirect_uri: String,
    #[serde(default)]
    scopes: Vec<String>,
}
async fn oauth_intent(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    Json(mut input): Json<OAuthIntent>,
) -> Result<Response> {
    owner(&actor)?;
    input.redirect_uri = clean(&input.redirect_uri, 2000)?;
    let parsed = url::Url::parse(&input.redirect_uri)
        .map_err(|_| Error::Invalid("invalid OAuth redirect URI"))?;
    if parsed.scheme() != "https"
        && !(parsed.scheme() == "http"
            && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost")))
    {
        return Err(Error::Invalid("OAuth redirect URI must use HTTPS"));
    }
    if input.scopes.len() > 50 || input.scopes.iter().any(|s| clean(s, 200).is_err()) {
        return Err(Error::Invalid("invalid OAuth scopes"));
    }
    let mut tx = db(&state)?.begin().await?;
    let current = locked(&mut tx, &actor, id).await?;
    if !matches!(current.auth_type.as_str(), "oauth2" | "oauth2_client") {
        return Err(Error::Invalid("integration does not use OAuth"));
    }
    if current.provider == "healthclinics" {
        return Err(Error::Invalid(
            "HealthClinics authorizes as a registered EHR OAuth client; use the OAuth client and grant APIs",
        ));
    }
    if current.status == "revoked" {
        return Err(Error::Conflict("revoked integration cannot start OAuth"));
    }
    let intent = Uuid::new_v4();
    let state_token = Zeroizing::new(random_token());
    let encrypted = crate::provider_settings::seal_secret(
        db(&state)?,
        actor.tenant_id,
        intent,
        "instance-oauth-state",
        &state_token,
    )
    .await?;
    let expires = Utc::now() + Duration::minutes(10);
    sqlx::query("INSERT INTO instance_integration_oauth_intents(tenant_id,id,integration_id,state_hash,encrypted_state,redirect_uri,requested_scopes,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
        .bind(actor.tenant_id).bind(intent).bind(id).bind(crate::oauth::hash(&state_token)).bind(encrypted)
        .bind(&input.redirect_uri).bind(json!(input.scopes)).bind(expires).bind(actor.sub).execute(&mut *tx).await?;
    sqlx::query("UPDATE instance_integrations SET status='pending',enabled=false,version=version+1,updated_by=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).bind(actor.sub).execute(&mut *tx).await?;
    event(
        &mut tx,
        &actor,
        id,
        "oauth_intent_created",
        json!({"intent_id":intent,"expires_at":expires,"scopes":input.scopes}),
    )
    .await?;
    tx.commit().await?;
    Ok(reply(
        json!({"intent_id":intent,"state":state_token.as_str(),"callback_path":"/api/v1/integrations/oauth/callback","redirect_uri":input.redirect_uri,"requested_scopes":input.scopes,"expires_at":expires,"authorization_url":Value::Null,"message":"Provider adapter must construct the official authorization URL; no vendor endpoint is assumed."}),
    ))
}

#[derive(Deserialize)]
struct OAuthCallback {
    state: String,
    code: Option<String>,
    error: Option<String>,
}

#[derive(sqlx::FromRow)]
struct OAuthIntentRow {
    tenant_id: Uuid,
    id: Uuid,
    integration_id: Uuid,
    expires_at: DateTime<Utc>,
    used_at: Option<DateTime<Utc>>,
    created_by: Uuid,
}

async fn oauth_callback(
    ExtractState(state): ExtractState<State>,
    Query(input): Query<OAuthCallback>,
) -> Result<Response> {
    if input.state.len() < 32
        || input.state.len() > 512
        || input.code.as_ref().is_some_and(|v| v.len() > 8192)
        || input.error.as_ref().is_some_and(|v| v.len() > 240)
    {
        return Err(Error::Invalid("invalid OAuth callback"));
    }
    if input.code.is_some() == input.error.is_some() {
        return Err(Error::Invalid(
            "OAuth callback requires either code or error",
        ));
    }
    let mut tx = db(&state)?.begin().await?;
    let row:Option<OAuthIntentRow>=sqlx::query_as("SELECT tenant_id,id,integration_id,expires_at,used_at,created_by FROM instance_integration_oauth_intents WHERE state_hash=$1 FOR UPDATE")
        .bind(crate::oauth::hash(&input.state)).fetch_optional(&mut *tx).await?;
    let row = row.ok_or(Error::NotFound)?;
    if row.used_at.is_some() || row.expires_at <= Utc::now() {
        return Err(Error::Conflict(
            "OAuth callback expired or was already used",
        ));
    }
    let payload = json!({"code":input.code,"error":input.error});
    let encrypted = crate::provider_settings::seal_secret(
        db(&state)?,
        row.tenant_id,
        row.id,
        "instance-oauth-callback",
        &payload.to_string(),
    )
    .await?;
    sqlx::query("UPDATE instance_integration_oauth_intents SET encrypted_callback=$2,used_at=now() WHERE tenant_id=$1 AND id=$3")
        .bind(row.tenant_id).bind(encrypted).bind(row.id).execute(&mut *tx).await?;
    let callback_error = input.error.as_deref().unwrap_or("");
    sqlx::query("UPDATE instance_integrations SET status=$3,last_error=$4,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(row.tenant_id).bind(row.integration_id).bind(if input.error.is_some(){"needs_attention"}else{"pending"})
        .bind(if callback_error.is_empty(){None}else{Some(callback_error)}).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO instance_integration_events(tenant_id,integration_id,version,actor_id,action,evidence) SELECT tenant_id,id,version,$3,'oauth_callback_received',$4 FROM instance_integrations WHERE tenant_id=$1 AND id=$2")
        .bind(row.tenant_id).bind(row.integration_id).bind(row.created_by).bind(json!({"intent_id":row.id,"result":if input.error.is_some(){"provider_error"}else{"authorization_code_received"}})).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,'integration.oauth_callback_received',$3)")
        .bind(row.tenant_id).bind(row.created_by).bind(row.integration_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(reply(
        json!({"received":true,"status":if input.error.is_some(){"needs_attention"}else{"pending_exchange"},"message":"Authorization response saved securely. A provider adapter must perform the token exchange."}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_contract_is_bounded() {
        assert_eq!(auth_type("claude"), Some("api_key"));
        assert_eq!(auth_type("ringcentral"), Some("oauth2"));
        assert!(capabilities("gmail", Some(vec!["attachments".into()])).is_ok());
        assert!(capabilities("gmail", Some(vec!["clinical_write".into()])).is_err());
        assert!(capabilities("erebine", Some(vec!["workflow_design".into()])).is_ok());
        assert!(capabilities("claude", Some(vec!["workflow_design".into()])).is_ok());
        assert!(capabilities("gmail", Some(vec!["workflow_design".into()])).is_err());
        assert!(validate_config(&json!({"mailbox_label":"Referrals"})).is_ok());
        assert!(validate_config(&json!({"api_key":"must-not-be-here"})).is_err());
        assert!(validate_config(&json!({"nested":{"client_secret":"must-not-be-here"}})).is_err());
    }
    #[test]
    fn hint_reveals_only_suffix() {
        assert_eq!(hint("synthetic-secret-1234"), "••••1234");
    }
}
