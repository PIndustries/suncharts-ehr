// SPDX-License-Identifier: AGPL-3.0-only
//! Owner-managed provider credentials. Secrets never enter responses or audit evidence.
use crate::{
    auth::{Actor, Role},
    delivery::{Adapter, Config, Route},
    error::{Error, Result},
    State,
};
use aws_lc_rs::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use axum::{
    extract::{Path, State as ExtractState},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::{
    fs,
    io::Write,
    path::{Path as FilePath, PathBuf},
    sync::Arc,
};
use uuid::Uuid;
use zeroize::Zeroizing;
pub struct Secret(Zeroizing<String>);
impl Secret {
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}
fn owner(a: &Actor) -> Result<()> {
    if matches!(a.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn key_path() -> PathBuf {
    std::env::var_os("ENGINE_CREDENTIAL_KEY_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".suncharts/provider-master.key"))
}
fn master_key() -> Result<Zeroizing<Vec<u8>>> {
    let path = key_path();
    if !path.exists() {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(FilePath::new("."));
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(parent)
            .map_err(|_| Error::Invalid("credential key directory unavailable"))?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut f) => {
                let mut bytes = Zeroizing::new(vec![0u8; 32]);
                rand::rngs::OsRng.fill_bytes(&mut bytes);
                f.write_all(&bytes)
                    .and_then(|_| f.sync_all())
                    .map_err(|_| Error::Invalid("credential key could not be saved"))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(Error::Invalid("credential key unavailable")),
        }
    }
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| Error::Invalid("credential key unavailable"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(Error::Invalid(
            "credential key must be a regular private file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(Error::Invalid(
                "credential key permissions must be owner-only",
            ));
        }
    }
    let bytes =
        Zeroizing::new(fs::read(path).map_err(|_| Error::Invalid("credential key unavailable"))?);
    if bytes.len() != 32 {
        return Err(Error::Invalid("credential key must contain 32 bytes"));
    }
    Ok(bytes)
}
fn existing_key() -> Result<Zeroizing<Vec<u8>>> {
    if !key_path().exists() {
        return Err(Error::Invalid(
            "credential key missing; restore the private server key from backup",
        ));
    }
    master_key()
}
fn aad(tenant: Uuid, id: Uuid) -> String {
    format!("suncharts:claimmd:{tenant}:{id}:v1")
}
fn encrypt(key: &[u8], tenant: Uuid, id: Uuid, secret: &str) -> Result<Vec<u8>> {
    encrypt_aad(key, &aad(tenant, id), secret)
}
fn encrypt_aad(key: &[u8], context: &str, secret: &str) -> Result<Vec<u8>> {
    let key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, key)
            .map_err(|_| Error::Invalid("credential encryption unavailable"))?,
    );
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let mut bytes = secret.as_bytes().to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(context),
        &mut bytes,
    )
    .map_err(|_| Error::Invalid("credential encryption failed"))?;
    let mut out = vec![1u8];
    out.extend(nonce);
    out.extend(bytes);
    Ok(out)
}
fn decrypt(key: &[u8], tenant: Uuid, id: Uuid, encrypted: &[u8]) -> Result<Secret> {
    decrypt_aad(key, &aad(tenant, id), encrypted)
}
fn decrypt_aad(key: &[u8], context: &str, encrypted: &[u8]) -> Result<Secret> {
    if encrypted.len() < 30 || encrypted[0] != 1 {
        return Err(Error::Invalid("saved credential cannot be decrypted"));
    }
    let key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, key)
            .map_err(|_| Error::Invalid("credential encryption unavailable"))?,
    );
    let nonce: [u8; 12] = encrypted[1..13]
        .try_into()
        .map_err(|_| Error::Invalid("saved credential cannot be decrypted"))?;
    let mut bytes = Zeroizing::new(encrypted[13..].to_vec());
    let plain = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(context),
            &mut bytes,
        )
        .map_err(|_| Error::Invalid("saved credential cannot be decrypted"))?;
    let value = String::from_utf8(plain.to_vec())
        .map_err(|_| Error::Invalid("saved credential cannot be decrypted"))?;
    Ok(Secret(Zeroizing::new(value)))
}
pub(crate) async fn credential_storage_ready(pool: &PgPool) -> Result<bool> {
    let saved:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edi_provider_settings) OR EXISTS(SELECT 1 FROM payment_credentials) OR EXISTS(SELECT 1 FROM reminder_credentials) OR EXISTS(SELECT 1 FROM connect_service_credentials) OR EXISTS(SELECT 1 FROM connect_onboarding_intents) OR EXISTS(SELECT 1 FROM referral_delivery_destinations WHERE encrypted_credential IS NOT NULL) OR EXISTS(SELECT 1 FROM erx_setup_requests) OR EXISTS(SELECT 1 FROM erx_connections WHERE encrypted_credentials IS NOT NULL) OR EXISTS(SELECT 1 FROM erx_prescribers WHERE encrypted_credentials IS NOT NULL) OR EXISTS(SELECT 1 FROM erx_setup_history WHERE encrypted_credentials IS NOT NULL)").fetch_one(pool).await?;
    Ok(!saved || existing_key().is_ok())
}
pub(crate) async fn seal_secret(
    pool: &PgPool,
    tenant: Uuid,
    id: Uuid,
    purpose: &str,
    secret: &str,
) -> Result<Vec<u8>> {
    let saved:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edi_provider_settings) OR EXISTS(SELECT 1 FROM payment_credentials) OR EXISTS(SELECT 1 FROM reminder_credentials) OR EXISTS(SELECT 1 FROM connect_service_credentials) OR EXISTS(SELECT 1 FROM connect_onboarding_intents) OR EXISTS(SELECT 1 FROM referral_delivery_destinations WHERE encrypted_credential IS NOT NULL) OR EXISTS(SELECT 1 FROM erx_setup_requests) OR EXISTS(SELECT 1 FROM erx_connections WHERE encrypted_credentials IS NOT NULL) OR EXISTS(SELECT 1 FROM erx_prescribers WHERE encrypted_credentials IS NOT NULL) OR EXISTS(SELECT 1 FROM erx_setup_history WHERE encrypted_credentials IS NOT NULL)").fetch_one(pool).await?;
    let key = if saved {
        existing_key()?
    } else {
        master_key()?
    };
    encrypt_aad(
        &key,
        &format!("suncharts:{purpose}:{tenant}:{id}:v1"),
        secret,
    )
}
pub(crate) fn open_secret(
    tenant: Uuid,
    id: Uuid,
    purpose: &str,
    encrypted: &[u8],
) -> Result<Secret> {
    decrypt_aad(
        &existing_key()?,
        &format!("suncharts:{purpose}:{tenant}:{id}:v1"),
        encrypted,
    )
}
#[derive(sqlx::FromRow)]
struct Setting {
    tenant_id: Uuid,
    id: Uuid,
    partner_id: Uuid,
    usage: String,
    label: String,
    encrypted_key: Vec<u8>,
    credential_revision: i64,
    start_at: DateTime<Utc>,
    response_id: String,
    interval_seconds: i64,
    enabled: bool,
    verified: bool,
    last_test_at: Option<DateTime<Utc>>,
    last_test_result: Option<String>,
    version: i64,
}
impl Setting {
    fn route_key(&self) -> String {
        format!(
            "native_claimmd_{}_{}",
            self.id.simple(),
            self.credential_revision
        )
    }
    fn public(&self) -> Value {
        json!({"id":self.id,"partner_id":self.partner_id,"provider":"claim_md","usage":self.usage,"label":self.label,"route_key":self.route_key(),"start_at":self.start_at,"response_id":self.response_id,"interval_seconds":self.interval_seconds,"enabled":self.enabled,"verified":self.verified,"last_test_at":self.last_test_at,"last_test_result":self.last_test_result,"version":self.version,"credential_configured":true})
    }
    fn route(&self, key: &[u8]) -> Result<Route> {
        Ok(Route {
            key: self.route_key(),
            tenant_id: self.tenant_id,
            partner_id: self.partner_id,
            endpoint: crate::claimmd::UPLOAD.into(),
            usage: self.usage.clone(),
            credential_env: Some(
                format!("ENGINE_CLEARINGHOUSE_TOKEN_NATIVE_{}", self.id.simple()).to_uppercase(),
            ),
            credential_value: Some(Arc::new(decrypt(
                key,
                self.tenant_id,
                self.id,
                &self.encrypted_key,
            )?)),
            loopback_test: false,
            adapter: Adapter::ClaimMd,
            retrieval: Some(crate::retrieval::Settings {
                start_at: self.start_at,
                core_base: crate::stedi::CORE.into(),
                interval_seconds: self.interval_seconds,
                download_hosts: vec![],
                claimmd_response_id: Some(self.response_id.clone()),
            }),
            sftp: None,
        })
    }
}
pub async fn load(pool: &PgPool) -> Result<Config> {
    load_scope(pool, None).await
}
pub(crate) async fn load_for_tenant(pool: &PgPool, tenant: Uuid) -> Result<Config> {
    load_scope(pool, Some(tenant)).await
}
async fn load_scope(pool: &PgPool, tenant: Option<Uuid>) -> Result<Config> {
    let mut config = Config::from_env()?;
    if let Some(tenant) = tenant {
        config.routes.retain(|r| r.tenant_id == tenant);
    }

    let rows:Vec<Setting>=sqlx::query_as("SELECT * FROM edi_provider_settings WHERE enabled AND verified AND ($1::uuid IS NULL OR tenant_id=$1) ORDER BY tenant_id,id LIMIT 51").bind(tenant).fetch_all(pool).await?;
    if !rows.is_empty() {
        let key = existing_key()?;
        for r in rows {
            config.routes.push(r.route(&key)?);
        }
    }
    config.validate()?;
    Ok(config)
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/billing/provider-settings", get(list).post(create))
        .route(
            "/api/v1/billing/provider-settings/{id}",
            get(detail).put(update),
        )
        .route("/api/v1/billing/provider-settings/{id}/test", post(test))
        .route(
            "/api/v1/billing/provider-settings/{id}/activation",
            post(activate),
        )
}
fn reply(value: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}
async fn row(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Setting> {
    sqlx::query_as("SELECT * FROM edi_provider_settings WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    action: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO edi_provider_setting_events(tenant_id,setting_id,version,actor_id,action) SELECT tenant_id,id,version,$3,$4 FROM edi_provider_settings WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(a.sub).bind(action).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "edi.provider_setting_change", id).await
}
async fn list(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Response> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    let rows: Vec<Setting> = sqlx::query_as(
        "SELECT * FROM edi_provider_settings WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 100",
    )
    .bind(a.tenant_id)
    .fetch_all(&mut *tx)
    .await?;
    crate::postgres::audit(&mut tx, &a, "edi.provider_settings_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(reply(
        json!({"items":rows.iter().map(Setting::public).collect::<Vec<_>>(),"provider":"claim_md","key_storage":"server_private_file","key_configured":key_path().exists(),"credential_storage_ready":rows.is_empty()||existing_key().is_ok_and(|key|rows.iter().all(|r|decrypt(&key,r.tenant_id,r.id,&r.encrypted_key).is_ok()))}),
    ))
}
async fn detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    let r = row(&mut tx, &a, id).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id'-'setting_id' FROM edi_provider_setting_events e WHERE tenant_id=$1 AND setting_id=$2 ORDER BY version DESC LIMIT 100").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.provider_setting_read", id).await?;
    tx.commit().await?;
    Ok(reply(json!({"setting":r.public(),"events":events})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    label: String,
    partner_id: Uuid,
    usage: String,
    account_key: Option<String>,
    start_at: DateTime<Utc>,
    #[serde(default = "zero")]
    response_id: String,
    #[serde(default = "interval")]
    interval_seconds: i64,
}
fn zero() -> String {
    "0".into()
}
fn interval() -> i64 {
    60
}
fn validate(v: &Save) -> Result<()> {
    crate::model::text(&v.label, 120)?;
    if !["T", "P"].contains(&v.usage.as_str())
        || v.start_at > Utc::now() - chrono::Duration::minutes(1)
        || !(30..=86400).contains(&v.interval_seconds)
        || v.response_id.is_empty()
        || v.response_id.len() > 20
        || !v.response_id.bytes().all(|b| b.is_ascii_digit())
        || v.response_id.parse::<u64>().is_err()
    {
        return Err(Error::Invalid(
            "invalid provider mode, discovery start or cursor",
        ));
    }
    if let Some(key) = &v.account_key {
        if !(8..=512).contains(&key.len())
            || key.trim() != key
            || !key.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err(Error::Invalid("enter a valid AccountKey without spaces"));
        }
    }
    Ok(())
}
async fn validate_partner(tx: &mut Transaction<'_, Postgres>, a: &Actor, v: &Save) -> Result<()> {
    let p = crate::clearinghouse::partner(tx, a, v.partner_id).await?;
    if p.content["usage"] != v.usage || p.content["active"] != true {
        return Err(Error::Invalid(
            "choose an active trading partner with the same test or production mode",
        ));
    }
    Ok(())
}
async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(mut v): Json<Save>,
) -> Result<Response> {
    owner(&a)?;
    validate(&v)?;
    let key = Zeroizing::new(
        v.account_key
            .take()
            .ok_or(Error::Invalid("Claim.MD AccountKey required"))?,
    );
    let id = Uuid::new_v4();

    let mut tx = db(&s)?.begin().await?;
    crate::billing::tenant_lock(&mut tx, &a).await?;
    validate_partner(&mut tx, &a, &v).await?;
    let any_saved: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edi_provider_settings) OR EXISTS(SELECT 1 FROM payment_credentials) OR EXISTS(SELECT 1 FROM reminder_credentials) OR EXISTS(SELECT 1 FROM connect_service_credentials) OR EXISTS(SELECT 1 FROM connect_onboarding_intents) OR EXISTS(SELECT 1 FROM referral_delivery_destinations WHERE encrypted_credential IS NOT NULL) OR EXISTS(SELECT 1 FROM erx_setup_requests) OR EXISTS(SELECT 1 FROM erx_connections WHERE encrypted_credentials IS NOT NULL) OR EXISTS(SELECT 1 FROM erx_prescribers WHERE encrypted_credentials IS NOT NULL) OR EXISTS(SELECT 1 FROM erx_setup_history WHERE encrypted_credentials IS NOT NULL)")
        .fetch_one(&mut *tx)
        .await?;
    let master = if any_saved {
        existing_key()?
    } else {
        master_key()?
    };
    let encrypted = encrypt(&master, a.tenant_id, id, &key)?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM edi_provider_settings WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&mut *tx)
            .await?;
    if count >= 10 {
        return Err(Error::Invalid("provider settings limit reached"));
    }
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM edi_provider_settings WHERE credential_fingerprint=$1)",
    )
    .bind(crate::oauth::hash(&key))
    .fetch_one(&mut *tx)
    .await?;
    if exists {
        return Err(Error::Conflict(
            "AccountKey is already assigned to a connection",
        ));
    }
    sqlx::query("INSERT INTO edi_provider_settings(tenant_id,id,partner_id,provider,usage,label,encrypted_key,credential_fingerprint,start_at,response_id,interval_seconds) VALUES($1,$2,$3,'claim_md',$4,$5,$6,$7,$8,$9,$10)").bind(a.tenant_id).bind(id).bind(v.partner_id).bind(v.usage).bind(v.label).bind(encrypted).bind(crate::oauth::hash(&key)).bind(v.start_at).bind(v.response_id).bind(v.interval_seconds).execute(&mut *tx).await?;
    event(&mut tx, &a, id, "credentials_saved_disabled").await?;
    let r = row(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(reply(r.public()))
}
async fn pause(tx: &mut Transaction<'_, Postgres>, a: &Actor, key: &str) -> Result<()> {
    let changed=sqlx::query("UPDATE edi_connections SET paused=true,version=version+1,last_result='native_settings_disabled' WHERE tenant_id=$1 AND route_key=$2 AND NOT paused").bind(a.tenant_id).bind(key).execute(&mut **tx).await?.rows_affected();
    if changed > 0 {
        crate::retrieval::connection_event(
            tx,
            a,
            key,
            "Native provider settings paused the connection",
            json!({"paused":true}),
        )
        .await?;
    }
    Ok(())
}
async fn update(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(mut v): Json<Save>,
) -> Result<Response> {
    owner(&a)?;
    validate(&v)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    crate::billing::tenant_lock(&mut tx, &a).await?;
    let old = row(&mut tx, &a, id).await?;
    if old.version != version {
        return Err(Error::Conflict(
            "provider settings changed; reload before saving",
        ));
    }
    if old.partner_id != v.partner_id || old.usage != v.usage {
        return Err(Error::Invalid(
            "create a separate connection for a different trading partner or mode",
        ));
    }
    validate_partner(&mut tx, &a, &v).await?;
    let secret = v.account_key.take().map(Zeroizing::new);
    let changed_discovery =
        old.start_at != v.start_at || old.response_id != v.response_id || secret.is_some();
    let encrypted = if let Some(key) = &secret {
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edi_provider_settings WHERE credential_fingerprint=$1 AND NOT (tenant_id=$2 AND id=$3))").bind(crate::oauth::hash(key)).bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
        if exists {
            return Err(Error::Conflict(
                "AccountKey is already assigned to a connection",
            ));
        }
        encrypt(&existing_key()?, a.tenant_id, id, key)?
    } else {
        old.encrypted_key.clone()
    };
    pause(&mut tx, &a, &old.route_key()).await?;
    sqlx::query("UPDATE edi_provider_settings SET label=$3,encrypted_key=$4,credential_fingerprint=coalesce($5,credential_fingerprint),credential_revision=credential_revision+$6,start_at=$7,response_id=$8,interval_seconds=$9,enabled=false,verified=CASE WHEN $10 THEN false ELSE verified END,last_test_result=CASE WHEN $10 THEN NULL ELSE last_test_result END,last_test_at=CASE WHEN $10 THEN NULL ELSE last_test_at END,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(v.label).bind(encrypted).bind(secret.as_ref().map(|s|crate::oauth::hash(s))).bind(if changed_discovery{1i64}else{0}).bind(v.start_at).bind(v.response_id).bind(v.interval_seconds).bind(secret.is_some()).execute(&mut *tx).await?;
    event(&mut tx, &a, id, "settings_saved_disabled").await?;
    let r = row(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(reply(r.public()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Activation {
    enabled: bool,
}
async fn activate(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Activation>,
) -> Result<Response> {
    owner(&a)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    crate::billing::tenant_lock(&mut tx, &a).await?;
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended('native-provider-configuration',0))",
    )
    .execute(&mut *tx)
    .await?;
    let r = row(&mut tx, &a, id).await?;
    if r.version != version {
        return Err(Error::Conflict(
            "provider settings changed; reload before activation",
        ));
    }
    if v.enabled && !r.verified {
        return Err(Error::Invalid(
            "test the saved AccountKey successfully before enabling",
        ));
    }
    if v.enabled {
        let route = r.route(&existing_key()?)?;
        let mut candidate = load(db(&s)?).await?;
        candidate
            .routes
            .retain(|v| v.key != r.route_key() || v.tenant_id != a.tenant_id);
        candidate.routes.push(route.clone());
        candidate.validate()?;
        let p = crate::clearinghouse::partner(&mut tx, &a, r.partner_id).await?;
        if p.content["active"] != true || p.content["usage"] != r.usage {
            return Err(Error::Invalid(
                "trading partner is inactive or mode changed",
            ));
        }
        let changed=sqlx::query("UPDATE edi_connections SET paused=false,version=version+1,last_result='native_settings_enabled' WHERE tenant_id=$1 AND route_key=$2 AND binding_hash=$3 AND paused").bind(a.tenant_id).bind(r.route_key()).bind(crate::retrieval::binding(&route)).execute(&mut *tx).await?.rows_affected();
        if changed > 0 {
            crate::retrieval::connection_event(
                &mut tx,
                &a,
                &r.route_key(),
                "Native provider settings enabled the connection",
                json!({"paused":false}),
            )
            .await?;
        }
    } else {
        pause(&mut tx, &a, &r.route_key()).await?;
    }
    sqlx::query("UPDATE edi_provider_settings SET enabled=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(v.enabled).execute(&mut *tx).await?;
    event(
        &mut tx,
        &a,
        id,
        if v.enabled {
            "connection_enabled"
        } else {
            "connection_disabled"
        },
    )
    .await?;
    let r = row(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(reply(r.public()))
}
async fn probe(secret: &str) -> Result<bool> {
    probe_endpoint(secret, "https://svc.claim.md/services/payerlist/").await
}
async fn probe_endpoint(secret: &str, endpoint: &str) -> Result<bool> {
    let response = crate::stedi::client()?
        .post(endpoint)
        .header("Accept", "application/json")
        .form(&[("AccountKey", secret), ("payerid", "60054")])
        .send()
        .await
        .map_err(|_| Error::Invalid("Claim.MD connection test unavailable"))?;
    if response.status() != 200 {
        return Ok(false);
    }
    let raw = crate::stedi::bytes(response, 65536).await?;
    let value: Value = serde_json::from_slice(&raw)
        .map_err(|_| Error::Invalid("Claim.MD connection test returned unsupported data"))?;
    Ok(value.get("error").is_none() && value.get("payer").is_some_and(Value::is_array))
}
async fn test(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Response> {
    owner(&a)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    crate::billing::tenant_lock(&mut tx, &a).await?;
    let r = row(&mut tx, &a, id).await?;
    if r.version != version {
        return Err(Error::Conflict(
            "provider settings changed; reload before testing",
        ));
    }
    if r.last_test_at
        .is_some_and(|t| t > Utc::now() - chrono::Duration::seconds(30))
    {
        return Err(Error::Invalid(
            "wait 30 seconds before another connection test",
        ));
    }
    let route = r.route(&existing_key()?)?;
    let ok = probe(
        route
            .credential_value
            .as_ref()
            .ok_or(Error::Invalid("saved credential unavailable"))?
            .expose(),
    )
    .await
    .unwrap_or(false);
    let now = row(&mut tx, &a, id).await?;
    if !ok {
        pause(&mut tx, &a, &now.route_key()).await?;
    }
    sqlx::query("UPDATE edi_provider_settings SET verified=$3,enabled=enabled AND $3,last_test_at=now(),last_test_result=$4,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(ok).bind(if ok{"authenticated_payer_directory"}else{"connection_not_verified"}).execute(&mut *tx).await?;
    event(
        &mut tx,
        &a,
        id,
        if ok {
            "connection_test_verified"
        } else {
            "connection_test_failed"
        },
    )
    .await?;
    let r = row(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(reply(
        json!({"setting":r.public(),"authenticated":ok,"claim_submitted":false,"discovery_cursor_changed":false}),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_ciphertext_is_random_bound_and_authenticated() {
        let key = [3u8; 32];
        let tenant = Uuid::new_v4();
        let id = Uuid::new_v4();
        let secret = "synthetic-account-key-very-private";
        let a = encrypt(&key, tenant, id, secret).unwrap();
        let b = encrypt(&key, tenant, id, secret).unwrap();
        assert_ne!(a, b);
        assert!(!a.windows(secret.len()).any(|p| p == secret.as_bytes()));
        assert_eq!(decrypt(&key, tenant, id, &a).unwrap().expose(), secret);
        assert!(decrypt(&key, Uuid::new_v4(), id, &a).is_err());
        assert!(decrypt(&key, tenant, Uuid::new_v4(), &a).is_err());
        assert!(decrypt(&[4u8; 32], tenant, id, &a).is_err());
        let mut corrupt = a;
        corrupt[20] ^= 1;
        assert!(decrypt(&key, tenant, id, &corrupt).is_err());
    }
    #[tokio::test]
    async fn connection_probe_uses_accountkey_and_rejects_provider_error_bodies() {
        let app = Router::new().route(
            "/payerlist",
            post(|body: axum::body::Bytes| async move {
                let raw = String::from_utf8(body.to_vec()).unwrap();
                assert!(raw.contains("payerid=60054"));
                let value = if raw.contains("AccountKey=synthetic-good-key") {
                    json!({"payer":[{"payerid":"60054"}]})
                } else {
                    json!({"error":{"message":"Invalid AccountKey"}})
                };
                Json(value)
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/payerlist", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        assert!(probe_endpoint("synthetic-good-key", &endpoint)
            .await
            .unwrap());
        assert!(!probe_endpoint("synthetic-bad-key", &endpoint)
            .await
            .unwrap());
        server.abort();
    }
    #[test]
    fn legacy_environment_routes_retain_original_binding_hash() {
        let r:Route=serde_json::from_value(json!({"key":"legacy","tenant_id":Uuid::new_v4(),"partner_id":Uuid::new_v4(),"endpoint":crate::claimmd::UPLOAD,"usage":"T","credential_env":"ENGINE_CLEARINGHOUSE_TOKEN_LEGACY","adapter":"claim_md","retrieval":null,"sftp":null})).unwrap();
        let old = json!({"partner":r.partner_id,"usage":r.usage,"adapter":r.adapter,"endpoint":r.endpoint,"credential_ref":r.credential_env,"sftp":r.sftp,"core_base":crate::stedi::CORE});
        assert_eq!(
            crate::retrieval::binding(&r),
            crate::oauth::hash(&old.to_string())
        );
    }
}
