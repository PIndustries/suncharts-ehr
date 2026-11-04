// SPDX-License-Identifier: AGPL-3.0-only
//! One-time outbound bootstrap for platform-managed hosted EHR instances.
//! Self-hosted installations continue to use the owner-approved OAuth flow.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    oauth, provider_settings,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::{env, time::Duration};
use url::Url;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const BOOTSTRAP_PATH: &str = "/api/internal/v1/hosted-ehr/bootstrap/complete";
const OWNER_SCOPE: &str = "clinical.read clinical.write billing.read billing.write events.read migration.manage offline_access";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub capability: String,
    pub provisioning_request_id: Uuid,
    pub order_id: Uuid,
    pub tenant_id: Uuid,
    pub owner_user_id: Uuid,
    pub owner_email: String,
    pub instance_origin: String,
    pub expected_version: String,
    pub expected_image_reference: String,
}

#[derive(Serialize, Deserialize)]
struct Pending {
    state: String,
    verifier: String,
    client_secret: String,
    relay_token: String,
    access_token: String,
    refresh_token: String,
    access_expires_at: String,
    grant_id: Uuid,
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.state.zeroize();
        self.verifier.zeroize();
        self.client_secret.zeroize();
        self.relay_token.zeroize();
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

impl Drop for Envelope {
    fn drop(&mut self) {
        self.capability.zeroize();
    }
}

#[derive(Serialize)]
struct BootstrapRequest<'a> {
    contract_version: u8,
    provisioning_request_id: Uuid,
    order_id: Uuid,
    tenant_id: Uuid,
    instance_origin: &'a str,
    expected_version: &'a str,
    expected_image_reference: &'a str,
    remote_tenant_id: Uuid,
    owner_user_id: Uuid,
    owner_email: &'a str,
    client_id: Uuid,
    client_secret: &'a str,
    code_challenge: String,
    code_challenge_method: &'static str,
    state: &'a str,
    relay_token: &'a str,
    oauth_access_token: &'a str,
    oauth_refresh_token: &'a str,
    oauth_expires_at: String,
    granted_scope: &'static str,
    transport: &'static str,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BootstrapResponse {
    contract_version: u8,
    provisioning_request_id: Uuid,
    order_id: Uuid,
    tenant_id: Uuid,
    connection_id: Uuid,
    installation_id: Uuid,
    installation_token: String,
    authorization_source: String,
    authorization_reference: String,
    terms_version: String,
    granted_scope: String,
    authorization_actor: String,
    authorized_at: String,
    connected: bool,
    connection_status: String,
    transport: String,
    infrastructure_ready: bool,
    managed_email_ready: bool,
    managed_email_from: Option<String>,
    support_ready: bool,
    ready: bool,
    expected_version: String,
    expected_image_reference: String,
}
impl Drop for BootstrapResponse {
    fn drop(&mut self) {
        self.installation_token.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
struct SavedResult {
    response: BootstrapResponse,
}

fn file_env(name: &str) -> Result<Option<String>> {
    let direct = env::var(name).ok();
    let file = env::var(format!("{name}_FILE")).ok();
    match (direct, file) {
        (Some(_), Some(_)) => Err(Error::Invalid(
            "managed Connect bootstrap has duplicate secret sources",
        )),
        (Some(value), None) if !value.trim().is_empty() => Ok(Some(value)),
        (None, Some(path)) => {
            let value = match std::fs::read_to_string(path) {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => {
                    return Err(Error::Invalid(
                        "managed Connect bootstrap secret could not be read",
                    ))
                }
            };
            if value.trim().is_empty() {
                Err(Error::Invalid("managed Connect bootstrap secret is empty"))
            } else {
                Ok(Some(value.trim_end_matches(['\r', '\n']).to_owned()))
            }
        }
        (Some(_), None) => Err(Error::Invalid("managed Connect bootstrap secret is empty")),
        (None, None) => Ok(None),
    }
}

fn config() -> Result<Option<Envelope>> {
    let raw = file_env("ENGINE_MANAGED_CONNECT_BOOTSTRAP")?;
    let Some(raw) = raw else { return Ok(None) };
    let mut raw = Zeroizing::new(raw);
    let envelope: Envelope = serde_json::from_str(&raw)
        .map_err(|_| Error::Invalid("managed Connect bootstrap envelope is invalid"))?;
    raw.zeroize();
    validate_envelope(&envelope)?;
    Ok(Some(envelope))
}

fn validate_envelope(e: &Envelope) -> Result<()> {
    let origin = Url::parse(&e.instance_origin)
        .map_err(|_| Error::Invalid("managed EHR origin is invalid"))?;
    let expected_host = origin
        .host_str()
        .ok_or(Error::Invalid("managed EHR origin has no hostname"))?;
    let public_url = Url::parse(
        &env::var("ENGINE_PUBLIC_URL")
            .map_err(|_| Error::Invalid("managed EHR public origin is missing"))?,
    )
    .map_err(|_| Error::Invalid("managed EHR public origin is invalid"))?;
    let public_host = public_url
        .host_str()
        .ok_or(Error::Invalid("managed EHR public origin has no hostname"))?;
    if e.capability.len() != 47
        || !e.capability.starts_with("scb_")
        || !e
            .capability
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        || origin.scheme() != "https"
        || origin.username() != ""
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.port().is_some()
        || expected_host != public_host
        || public_url.scheme() != "https"
        || public_url.origin() != origin.origin()
        || public_url.path() != "/"
        || public_url.query().is_some()
        || public_url.fragment().is_some()
        || !expected_host
            .to_ascii_lowercase()
            .ends_with(".suncharts.app")
        || e.owner_email.trim().is_empty()
        || e.owner_email.len() > 254
        || !e.owner_email.contains('@')
        || !valid_image_reference(&e.expected_image_reference)
        || e.expected_version.trim().is_empty()
        || e.expected_version.len() > 80
        || env::var("ENGINE_DEPLOYED_VERSION").is_ok_and(|v| v != e.expected_version)
        || env::var("ENGINE_DEPLOYED_IMAGE_REFERENCE")
            .is_ok_and(|v| v != e.expected_image_reference)
    {
        return Err(Error::Invalid(
            "managed Connect bootstrap envelope does not match this HTTPS instance",
        ));
    }
    let tenant = env::var("ENGINE_BOOTSTRAP_TENANT_ID")
        .map_err(|_| Error::Invalid("managed tenant identity is missing"))?;
    let owner = env::var("ENGINE_BOOTSTRAP_CLINICIAN_ID")
        .map_err(|_| Error::Invalid("managed owner identity is missing"))?;
    if Uuid::parse_str(&tenant).ok() != Some(e.tenant_id)
        || Uuid::parse_str(&owner).ok() != Some(e.owner_user_id)
        || env::var("ENGINE_BOOTSTRAP_ROLE").is_ok_and(|role| role != "owner")
    {
        return Err(Error::Invalid(
            "managed Connect bootstrap identity does not match the pre-seeded owner",
        ));
    }
    Ok(())
}

fn valid_image_reference(value: &str) -> bool {
    value
        .strip_prefix("ghcr.io/pindustries/suncharts-ehr@sha256:")
        .is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
}

#[derive(Serialize)]
struct DigestInput<'a> {
    request_id: Uuid,
    order_id: Uuid,
    tenant_id: Uuid,
    owner_user_id: Uuid,
    owner_email: &'a str,
    instance_origin: &'a str,
    expected_version: &'a str,
    image_reference: &'a str,
    client_id: Uuid,
    client_secret_hash: String,
    state_hash: String,
    verifier_hash: String,
    relay_hash: String,
    access_token_hash: String,
    refresh_token_hash: String,
    access_expires_at: &'a str,
    grant_id: Uuid,
}

async fn ensure_state(pool: &PgPool, e: &Envelope) -> Result<(Uuid, Pending, bool)> {
    let origin = e.instance_origin.trim_end_matches('/');
    let redirect = format!(
        "{}/oauth/ehr/callback",
        crate::connect_onboarding::cloud_origin()?
    );
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))")
        .bind(format!("managed-connect:{}", e.tenant_id))
        .execute(&mut *tx)
        .await?;
    let owner: Option<(String, String, bool)> = sqlx::query_as(
        "SELECT email,role,disabled FROM browser_users WHERE tenant_id=$1 AND id=$2",
    )
    .bind(e.tenant_id)
    .bind(e.owner_user_id)
    .fetch_optional(&mut *tx)
    .await?;
    if owner.as_ref().is_none_or(|(email, role, disabled)| {
        email != &e.owner_email.to_ascii_lowercase() || role != "owner" || *disabled
    }) {
        return Err(Error::Invalid(
            "managed order owner does not match the pre-seeded owner",
        ));
    }
    if let Some((client_id, encrypted_pending, payload_hash, capability_hash, completed)) = sqlx::query_as::<_, (Uuid, Vec<u8>, String, String, bool)>("SELECT client_id,encrypted_pending,payload_hash,capability_hash,completed_at IS NOT NULL FROM managed_connect_bootstrap WHERE provisioning_request_id=$1 FOR UPDATE")
        .bind(e.provisioning_request_id).fetch_optional(&mut *tx).await? {
        let secret = provider_settings::open_secret(e.tenant_id, e.provisioning_request_id, "managed-connect-bootstrap", &encrypted_pending)?;
        let pending: Pending = serde_json::from_str(secret.expose()).map_err(|_| Error::Invalid("managed bootstrap credentials cannot be restored"))?;
        let input = DigestInput { request_id:e.provisioning_request_id, order_id:e.order_id, tenant_id:e.tenant_id, owner_user_id:e.owner_user_id, owner_email:&e.owner_email, instance_origin:origin, expected_version:&e.expected_version, image_reference:&e.expected_image_reference, client_id, client_secret_hash:oauth::hash(&pending.client_secret), state_hash:oauth::hash(&pending.state), verifier_hash:oauth::hash(&pending.verifier), relay_hash:oauth::hash(&pending.relay_token), access_token_hash:oauth::hash(&pending.access_token), refresh_token_hash:oauth::hash(&pending.refresh_token), access_expires_at:&pending.access_expires_at, grant_id:pending.grant_id };
        let digest = oauth::hash(&serde_json::to_string(&input).map_err(|_| Error::Invalid("managed bootstrap digest failed"))?);
        if payload_hash != digest { return Err(Error::Invalid("managed provisioning request changed after bootstrap began")); }
        let current_capability_hash = oauth::hash(&e.capability);
        if capability_hash != current_capability_hash {
            sqlx::query("UPDATE managed_connect_bootstrap SET capability_hash=$2,updated_at=clock_timestamp() WHERE provisioning_request_id=$1")
                .bind(e.provisioning_request_id).bind(current_capability_hash).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        return Ok((client_id, pending, completed));
    }
    let client_id = Uuid::new_v4();
    let grant_id = Uuid::new_v4();
    let access_expires_at = chrono::Utc::now() + chrono::Duration::minutes(5);
    let mut raw = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let pending = Pending {
        state: oauth::random("sce_managed_"),
        verifier: URL_SAFE_NO_PAD.encode(raw),
        client_secret: oauth::random("sce_cs_"),
        relay_token: oauth::random("sce_relay_"),
        access_token: oauth::random("sce_at_"),
        refresh_token: oauth::random("sce_rt_"),
        access_expires_at: access_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        grant_id,
    };
    raw.zeroize();
    let input = DigestInput {
        request_id: e.provisioning_request_id,
        order_id: e.order_id,
        tenant_id: e.tenant_id,
        owner_user_id: e.owner_user_id,
        owner_email: &e.owner_email,
        instance_origin: origin,
        expected_version: &e.expected_version,
        image_reference: &e.expected_image_reference,
        client_id,
        client_secret_hash: oauth::hash(&pending.client_secret),
        state_hash: oauth::hash(&pending.state),
        verifier_hash: oauth::hash(&pending.verifier),
        relay_hash: oauth::hash(&pending.relay_token),
        access_token_hash: oauth::hash(&pending.access_token),
        refresh_token_hash: oauth::hash(&pending.refresh_token),
        access_expires_at: &pending.access_expires_at,
        grant_id,
    };
    let digest = oauth::hash(
        &serde_json::to_string(&input)
            .map_err(|_| Error::Invalid("managed bootstrap digest failed"))?,
    );
    let pending_json = Zeroizing::new(
        serde_json::to_string(&pending)
            .map_err(|_| Error::Invalid("managed bootstrap credentials cannot be saved"))?,
    );
    let encrypted = provider_settings::seal_secret(
        pool,
        e.tenant_id,
        e.provisioning_request_id,
        "managed-connect-bootstrap",
        &pending_json,
    )
    .await?;
    sqlx::query("INSERT INTO oauth_clients(id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES($1,$2,'SunCharts managed hosted connection',$3,$4,$5)")
        .bind(client_id).bind(e.tenant_id).bind(oauth::hash(&pending.client_secret)).bind(&redirect).bind(OWNER_SCOPE).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope,authorization_source,authorization_order_id) VALUES($1,$2,$3,$4,$5,'managed_hosted_order',$6)")
        .bind(grant_id).bind(client_id).bind(e.tenant_id).bind(e.owner_user_id).bind(OWNER_SCOPE).bind(e.order_id).execute(&mut *tx).await?;
    let access_expiry = chrono::DateTime::parse_from_rfc3339(&pending.access_expires_at)
        .map_err(|_| Error::Invalid("managed OAuth access expiry is invalid"))?
        .with_timezone(&chrono::Utc);
    sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$3,'access',$4),($2,$3,'refresh',$5)")
        .bind(oauth::hash(&pending.access_token)).bind(oauth::hash(&pending.refresh_token)).bind(grant_id).bind(access_expiry).bind(chrono::Utc::now()+chrono::Duration::days(30)).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO managed_connect_bootstrap(provisioning_request_id,order_id,tenant_id,owner_user_id,expected_hostname,expected_version,expected_image_reference,capability_hash,payload_hash,client_id,oauth_grant_id,encrypted_pending) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)")
        .bind(e.provisioning_request_id).bind(e.order_id).bind(e.tenant_id).bind(e.owner_user_id).bind(origin).bind(&e.expected_version).bind(&e.expected_image_reference).bind(oauth::hash(&e.capability)).bind(digest).bind(client_id).bind(grant_id).bind(encrypted).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((client_id, pending, false))
}

fn validate_response(v: &Value, e: &Envelope) -> Result<BootstrapResponse> {
    let r: BootstrapResponse = serde_json::from_value(v.clone())
        .map_err(|_| Error::Invalid("Connect managed bootstrap response is incomplete"))?;
    let token_ok = r.installation_token.starts_with("scs_inst_")
        && (24..=512).contains(&r.installation_token.len())
        && r.installation_token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c));
    let authorization_time = chrono::DateTime::parse_from_rfc3339(&r.authorized_at).ok();
    let reference_ok = r.authorization_reference
        == format!(
            "managed-order:{}:job:{}",
            e.order_id, e.provisioning_request_id
        )
        && r.authorization_reference.len() <= 256
        && r.authorization_reference
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b":_-".contains(&c));
    let status_consistent = matches!(r.connection_status.as_str(), "pending" | "connected")
        && r.connected == (r.connection_status == "connected");
    let ready_consistent = r.ready == (r.connected && r.managed_email_ready && r.support_ready);
    if r.contract_version != 1
        || r.provisioning_request_id != e.provisioning_request_id
        || r.order_id != e.order_id
        || r.tenant_id != e.tenant_id
        || r.connection_id.is_nil()
        || r.installation_id.is_nil()
        || !token_ok
        || r.authorization_source != "managed_hosted_order"
        || !reference_ok
        || r.terms_version != "managed-hosted-terms-v1"
        || r.granted_scope != OWNER_SCOPE
        || r.authorization_actor != "system:managed_provisioning"
        || authorization_time.is_none_or(|t| t > chrono::Utc::now() + chrono::Duration::minutes(5))
        || r.expected_image_reference != e.expected_image_reference
        || r.expected_version != e.expected_version
        || !status_consistent
        || r.transport != "outbound_websocket"
        || !r.infrastructure_ready
        || !ready_consistent
        || (r.managed_email_ready
            && r.managed_email_from
                .as_deref()
                .is_none_or(|from| from.len() > 254 || !from.contains('@')))
    {
        return Err(Error::Invalid(
            "Connect did not verify the managed hosted connection",
        ));
    }
    Ok(r)
}

async fn complete(
    pool: &PgPool,
    e: &Envelope,
    client_id: Uuid,
    pending: &Pending,
) -> Result<BootstrapResponse> {
    let origin = crate::connect_onboarding::cloud_origin()?;
    let endpoint = format!("{origin}{BOOTSTRAP_PATH}");
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::Invalid("managed Connect client could not be created"))?;
    let body = BootstrapRequest {
        contract_version: 1,
        provisioning_request_id: e.provisioning_request_id,
        order_id: e.order_id,
        tenant_id: e.tenant_id,
        instance_origin: e.instance_origin.trim_end_matches('/'),
        expected_version: &e.expected_version,
        expected_image_reference: &e.expected_image_reference,
        remote_tenant_id: e.tenant_id,
        owner_user_id: e.owner_user_id,
        owner_email: &e.owner_email,
        client_id,
        client_secret: &pending.client_secret,
        code_challenge: oauth::challenge(&pending.verifier),
        code_challenge_method: "S256",
        state: &pending.state,
        relay_token: &pending.relay_token,
        oauth_access_token: &pending.access_token,
        oauth_refresh_token: &pending.refresh_token,
        oauth_expires_at: pending.access_expires_at.clone(),
        granted_scope: OWNER_SCOPE,
        transport: "outbound_websocket",
    };
    sqlx::query("UPDATE managed_connect_bootstrap SET connection_status='connecting',attempts=attempts+1,updated_at=clock_timestamp(),last_error=NULL WHERE provisioning_request_id=$1 AND completed_at IS NULL")
        .bind(e.provisioning_request_id).execute(pool).await?;
    let response = http
        .post(endpoint)
        .bearer_auth(&e.capability)
        .json(&body)
        .send()
        .await
        .map_err(|_| Error::Invalid("managed Connect service is temporarily unavailable"))?;
    if !response.status().is_success() {
        return Err(Error::Invalid("managed Connect bootstrap was rejected"));
    }
    let bytes = crate::stedi::bytes(response, 65536).await?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Error::Invalid("managed Connect response is invalid"))?;
    validate_response(&value, e)
}

async fn persist(
    pool: &PgPool,
    e: &Envelope,
    client_id: Uuid,
    pending: &Pending,
    result: BootstrapResponse,
) -> Result<()> {
    let installation_id = result.installation_id;
    let installation_token = Zeroizing::new(result.installation_token.clone());
    let saved = SavedResult { response: result };
    let result_json = Zeroizing::new(
        serde_json::to_string(&saved)
            .map_err(|_| Error::Invalid("managed Connect result cannot be saved"))?,
    );
    let encrypted_result = provider_settings::seal_secret(
        pool,
        e.tenant_id,
        e.provisioning_request_id,
        "managed-connect-result",
        &result_json,
    )
    .await?;
    let transport_json = Zeroizing::new(
        serde_json::to_string(pending)
            .map_err(|_| Error::Invalid("managed Connect transport state cannot be saved"))?,
    );
    let encrypted_transport = provider_settings::seal_secret(
        pool,
        e.tenant_id,
        e.provisioning_request_id,
        "connect-onboarding",
        &transport_json,
    )
    .await?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))")
        .bind(format!("managed-connect:{}", e.tenant_id))
        .execute(&mut *tx)
        .await?;
    let old_service: Option<(Uuid, i64)> = sqlx::query_as(
        "SELECT id,credential_revision FROM connect_service_settings WHERE tenant_id=$1 FOR UPDATE",
    )
    .bind(e.tenant_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (service_id, revision) = old_service
        .map(|(id, revision)| (id, revision + 1))
        .unwrap_or((Uuid::new_v4(), 1));
    let encrypted_token = provider_settings::seal_secret(
        pool,
        e.tenant_id,
        service_id,
        "connect-service",
        &installation_token,
    )
    .await?;
    let actor = Actor {
        sub: e.owner_user_id,
        tenant_id: e.tenant_id,
        role: Role::Owner,
        patient_id: None,
        iss: "suncharts-ehr-managed-hosted".into(),
        aud: "suncharts-engine".into(),
        iat: chrono::Utc::now().timestamp(),
        exp: chrono::Utc::now().timestamp() + 60,
    };
    sqlx::query("INSERT INTO connect_service_settings(tenant_id,id,installation_id,credential_revision,enabled,verified,reminders_available,support_available,from_email,last_test_at,last_test_result) VALUES($1,$2,$3,$4,true,true,$5,$6,$7,now(),'managed_hosted_order') ON CONFLICT(tenant_id) DO UPDATE SET installation_id=$3,credential_revision=$4,enabled=true,verified=true,revoked=false,reminders_available=$5,support_available=$6,from_email=$7,last_test_at=now(),last_test_result='managed_hosted_order',version=connect_service_settings.version+1")
        .bind(e.tenant_id).bind(service_id).bind(installation_id).bind(revision).bind(saved.response.managed_email_ready).bind(saved.response.support_ready).bind(&saved.response.managed_email_from).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO connect_service_credentials(tenant_id,setting_id,revision,installation_id,encrypted_token) VALUES($1,$2,$3,$4,$5)")
        .bind(e.tenant_id).bind(service_id).bind(revision).bind(installation_id).bind(encrypted_token.as_slice()).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO connect_service_events(tenant_id,setting_id,version,actor_id,action) SELECT tenant_id,id,version,$2,'connect.managed_hosted_order_activated' FROM connect_service_settings WHERE tenant_id=$1")
        .bind(e.tenant_id).bind(e.owner_user_id).execute(&mut *tx).await?;
    let own_sender: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM reminder_sender_settings WHERE tenant_id=$1 AND delivery_mode='own_resend')")
        .bind(e.tenant_id).fetch_one(&mut *tx).await?;
    if saved.response.managed_email_ready && !own_sender {
        let from = saved
            .response
            .managed_email_from
            .as_deref()
            .ok_or(Error::Invalid("managed sender is not present"))?;
        let old_sender: Option<(Uuid, i64)> = sqlx::query_as("SELECT id,credential_revision FROM reminder_sender_settings WHERE tenant_id=$1 FOR UPDATE")
            .bind(e.tenant_id).fetch_optional(&mut *tx).await?;
        let (sender, sender_revision) = old_sender
            .map(|(id, revision)| (id, revision + 1))
            .unwrap_or((Uuid::new_v4(), 1));
        sqlx::query("INSERT INTO reminder_sender_settings(tenant_id,id,from_email,delivery_mode,credential_revision,enabled,verified,last_test_at,last_test_result) VALUES($1,$2,$3,'suncharts_connect',$4,true,true,now(),'managed_hosted_order') ON CONFLICT(tenant_id) DO UPDATE SET from_email=$3,delivery_mode='suncharts_connect',credential_revision=$4,enabled=true,verified=true,last_test_at=now(),last_test_result='managed_hosted_order',version=reminder_sender_settings.version+1")
            .bind(e.tenant_id).bind(sender).bind(from).bind(sender_revision).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO reminder_credentials(tenant_id,setting_id,revision,encrypted_key,from_email,delivery_mode,connect_setting_id,connect_revision) VALUES($1,$2,$3,NULL,$4,'suncharts_connect',$5,$6)")
            .bind(e.tenant_id).bind(sender).bind(sender_revision).bind(from).bind(service_id).bind(revision).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO reminder_sender_events(tenant_id,setting_id,version,actor_id,action) SELECT tenant_id,id,version,$2,'appointment.managed_sender_activated' FROM reminder_sender_settings WHERE tenant_id=$1")
            .bind(e.tenant_id).bind(e.owner_user_id).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO connect_service_health(tenant_id,setting_id,credential_revision,installation_id,availability,checked_at,verified_at,result,reminders_available,support_available) VALUES($1,$2,$3,$4,'available',clock_timestamp(),clock_timestamp(),'managed_hosted_order',$5,$6) ON CONFLICT(tenant_id) DO UPDATE SET setting_id=$2,credential_revision=$3,installation_id=$4,availability='available',checked_at=clock_timestamp(),verified_at=clock_timestamp(),result='managed_hosted_order',reminders_available=$5,support_available=$6")
        .bind(e.tenant_id).bind(service_id).bind(revision).bind(installation_id).bind(saved.response.managed_email_ready).bind(saved.response.support_ready).execute(&mut *tx).await?;
    let issuer = env::var("ENGINE_PUBLIC_URL")
        .map_err(|_| Error::Invalid("managed EHR public origin is missing"))?;
    sqlx::query("INSERT INTO connect_onboarding_intents(tenant_id,id,actor_id,session_hash,state_hash,issuer,client_id,encrypted_pending,expected_service_version,expected_reminder_version,status,expires_at,transport,connect_installation_id,completed_at,last_result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,0,'completed',now()+interval '10 years','outbound_websocket',$9,now(),'managed_hosted_order') ON CONFLICT(tenant_id,id) DO NOTHING")
        .bind(e.tenant_id).bind(e.provisioning_request_id).bind(e.owner_user_id).bind(oauth::hash(&format!("managed-hosted-order:{}",e.order_id))).bind(oauth::hash(&pending.state)).bind(issuer).bind(client_id).bind(encrypted_transport).bind(installation_id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO connect_onboarding_events(tenant_id,intent_id,version,actor_id,action) VALUES($1,$2,1,$3,'connect.managed_hosted_order_activated') ON CONFLICT DO NOTHING")
        .bind(e.tenant_id).bind(e.provisioning_request_id).bind(e.owner_user_id).execute(&mut *tx).await?;
    crate::postgres::audit(
        &mut tx,
        &actor,
        "connect.managed_hosted_order_activated",
        e.provisioning_request_id,
    )
    .await?;
    let authorized_at = chrono::DateTime::parse_from_rfc3339(&saved.response.authorized_at)
        .map_err(|_| Error::Invalid("managed authorization timestamp is invalid"))?
        .with_timezone(&chrono::Utc);
    sqlx::query("UPDATE managed_connect_bootstrap SET encrypted_result=$2,connection_id=$3,installation_id=$4,authorization_source='managed_hosted_order',authorization_reference=$5,terms_version=$6,authorization_actor=$7,authorized_at=$8,granted_scope=$9,connection_status='connecting',managed_email_ready=$10,managed_email_from=$11,support_ready=$12,last_error=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE provisioning_request_id=$1 AND client_id=$13 AND payload_hash IS NOT NULL AND completed_at IS NULL")
        .bind(e.provisioning_request_id).bind(encrypted_result).bind(saved.response.connection_id).bind(installation_id).bind(&saved.response.authorization_reference).bind(&saved.response.terms_version).bind(&saved.response.authorization_actor).bind(authorized_at).bind(&saved.response.granted_scope).bind(saved.response.managed_email_ready).bind(&saved.response.managed_email_from).bind(saved.response.support_ready).bind(client_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

async fn attempt(pool: &PgPool, e: &Envelope) -> Result<()> {
    let (client_id, pending, completed) = ensure_state(pool, e).await?;
    if completed {
        return Ok(());
    }
    let response = complete(pool, e, client_id, &pending).await?;
    persist(pool, e, client_id, &pending, response).await
}

pub async fn run(pool: PgPool) {
    let mut wait = Duration::from_secs(3);
    loop {
        let result = match config() {
            Ok(Some(e)) => attempt(&pool, &e).await,
            Ok(None) => return,
            Err(_error) => {
                eprintln!("managed Connect bootstrap configuration is invalid");
                return;
            }
        };
        match result {
            Ok(()) => {
                println!("managed Connect bootstrap verified");
                return;
            }
            Err(_error) => {
                eprintln!("managed Connect bootstrap will retry");
                if let Ok(Some(e)) = config() {
                    let _ = sqlx::query("UPDATE managed_connect_bootstrap SET connection_status='failed',last_error='bootstrap_pending_retry',updated_at=clock_timestamp() WHERE provisioning_request_id=$1 AND completed_at IS NULL")
                        .bind(e.provisioning_request_id).execute(&pool).await;
                }
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(Duration::from_secs(300));
            }
        }
    }
}

pub async fn readiness(pool: &PgPool) -> Value {
    let selected = env::var("ENGINE_DEPLOYED_IMAGE_REFERENCE").ok();
    let result: Option<(String,bool,bool,Option<String>,String,String,Uuid)> = sqlx::query_as("SELECT connection_status,managed_email_ready,support_ready,authorization_source,expected_version,expected_image_reference,tenant_id FROM managed_connect_bootstrap ORDER BY created_at DESC LIMIT 1").fetch_optional(pool).await.ok().flatten();
    let (
        stored_status,
        managed_email_ready,
        support_ready,
        authorization_source,
        expected_version,
        expected_image_reference,
        tenant_id,
    ) = result
        .map(|(s, m, sup, a, version, image, t)| {
            (s, m, sup, a, Some(version), Some(image), Some(t))
        })
        .unwrap_or_else(|| ("not_managed".into(), false, false, None, None, None, None));
    let connected = if let Some(tenant) = tenant_id {
        sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM managed_connect_bootstrap b JOIN connect_onboarding_intents i ON i.tenant_id=b.tenant_id AND i.id=b.provisioning_request_id AND i.connect_installation_id=b.installation_id JOIN connect_transport_health h ON h.tenant_id=i.tenant_id AND h.intent_id=i.id WHERE b.tenant_id=$1 AND i.transport='outbound_websocket' AND i.status='completed' AND h.state='connected' AND h.last_seen_at>clock_timestamp()-interval '45 seconds' AND h.updated_at>clock_timestamp()-interval '45 seconds')").bind(tenant).fetch_one(pool).await.unwrap_or(false)
    } else {
        false
    };
    let selected_matches = match (&expected_image_reference, &selected) {
        (Some(expected), Some(actual)) => expected == actual,
        (None, _) => true,
        (Some(_), None) => false,
    };
    let observed_version =
        env::var("ENGINE_DEPLOYED_VERSION").unwrap_or_else(|_| env!("SUN_CHARTS_BUILD").to_owned());
    let version_matches = expected_version
        .as_deref()
        .is_none_or(|version| version == observed_version);
    let connection_status = if !selected_matches || !version_matches {
        "image_reference_mismatch"
    } else if connected {
        "connected"
    } else if stored_status == "not_managed" {
        "not_managed"
    } else {
        "pending"
    };
    json!({"infrastructure_ready":true,"connection_status":connection_status,"connected":connected && selected_matches && version_matches,"authorization_source":authorization_source,"managed_email_ready":managed_email_ready && selected_matches && version_matches,"support_ready":support_ready && selected_matches && version_matches,"ready":connected && managed_email_ready && support_ready && selected_matches && version_matches,"selected_version":expected_version,"observed_version":observed_version,"selected_image_reference":expected_image_reference,"observed_image_reference":selected,"image_reference":selected,"build":env!("SUN_CHARTS_BUILD"),"version":observed_version})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn response_requires_exact_paid_order_binding_and_real_services() {
        let e = Envelope { capability:format!("scb_{}", "x".repeat(43)), provisioning_request_id:Uuid::new_v4(), order_id:Uuid::new_v4(), tenant_id:Uuid::new_v4(), owner_user_id:Uuid::new_v4(), owner_email:"owner@example.test".into(), instance_origin:"https://clinic.suncharts.app".into(), expected_version:"26.11.04.1".into(), expected_image_reference:"ghcr.io/pindustries/suncharts-ehr@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into() };
        let base = json!({"contract_version":1,"provisioning_request_id":e.provisioning_request_id,"order_id":e.order_id,"tenant_id":e.tenant_id,"connection_id":Uuid::new_v4(),"installation_id":Uuid::new_v4(),"installation_token":format!("scs_inst_{}", "x".repeat(48)),"authorization_source":"managed_hosted_order","authorization_reference":format!("managed-order:{}:job:{}",e.order_id,e.provisioning_request_id),"terms_version":"managed-hosted-terms-v1","granted_scope":OWNER_SCOPE,"authorization_actor":"system:managed_provisioning","authorized_at":chrono::Utc::now().to_rfc3339(),"connected":false,"connection_status":"pending","transport":"outbound_websocket","infrastructure_ready":true,"managed_email_ready":true,"managed_email_from":"SunCharts <appointments@suncharts.app>","support_ready":true,"ready":false,"expected_version":e.expected_version,"expected_image_reference":e.expected_image_reference});
        assert!(validate_response(&base, &e).is_ok());
        let mut changed = base.clone();
        changed["tenant_id"] = json!(Uuid::new_v4());
        assert!(validate_response(&changed, &e).is_err());
        let mut changed = base.clone();
        changed["authorization_source"] = json!("owner_consent");
        assert!(validate_response(&changed, &e).is_err());
        let mut changed = base.clone();
        changed["ready"] = json!(true);
        assert!(validate_response(&changed, &e).is_err());
        let mut changed = base.clone();
        changed["managed_email_from"] = Value::Null;
        assert!(validate_response(&changed, &e).is_err());
    }
}
