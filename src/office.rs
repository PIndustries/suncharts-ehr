// SPDX-License-Identifier: AGPL-3.0-only
//! Optional self-hosted Office editing. Only an explicit, operation-bound save appends a file.
use crate::{
    auth::Actor,
    documents::files,
    error::{Error, Result},
    postgres::audit,
    State,
};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State as ExtractState},
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{collections::HashSet, time::Duration};
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_FILE: usize = 10 * 1024 * 1024;
const TTL: i64 = 2 * 60 * 60;
struct Config {
    origin: String,
    callback_origin: String,
    secret: Zeroizing<String>,
}
fn origin(value: &str, local: bool, callback: bool) -> Result<String> {
    let u = url::Url::parse(value).map_err(|_| Error::Invalid("invalid Office origin"))?;
    let loopback = matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || callback && u.host_str() == Some("host.docker.internal");
    if !(u.scheme() == "https" || local && u.scheme() == "http" && loopback)
        || u.host_str().is_none()
        || u.path() != "/"
        || u.query().is_some()
        || u.fragment().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err(Error::Invalid(
            "Office requires an exact HTTPS origin or explicitly enabled local development origin",
        ));
    }
    Ok(u.origin().ascii_serialization())
}
impl Config {
    fn load(s: &State) -> Result<Option<Self>> {
        let Some(value) = std::env::var("ENGINE_OFFICE_ORIGIN")
            .ok()
            .filter(|v| !v.trim().is_empty())
        else {
            return Ok(None);
        };
        let local = std::env::var("ENGINE_OFFICE_ALLOW_LOCAL_TEST").as_deref() == Ok("true")
            && std::env::var("ENGINE_ENVIRONMENT").as_deref() != Ok("production");
        let origin = origin(&value, local, false)?;
        let browser = s.browser.as_ref().ok_or(Error::NotFound)?;
        let callback_origin = origin_value(
            &std::env::var("ENGINE_OFFICE_CALLBACK_ORIGIN")
                .unwrap_or_else(|_| browser.origin().into()),
            local,
            true,
        )?;
        if callback_origin != browser.origin()
            && !(local
                && url::Url::parse(&callback_origin).ok().is_some_and(|u| {
                    u.host_str() == Some("host.docker.internal")
                        && u.port_or_known_default()
                            == url::Url::parse(browser.origin())
                                .ok()
                                .and_then(|b| b.port_or_known_default())
                }))
        {
            return Err(Error::Invalid("Office callback must use the EHR origin"));
        }
        let path = std::env::var("ENGINE_OFFICE_JWT_SECRET_FILE")
            .map_err(|_| Error::Invalid("Office JWT secret file is required"))?;
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| Error::Invalid("Office JWT secret file unavailable"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(Error::Invalid("Office JWT secret file must be private"));
            }
        }
        if !metadata.is_file() || metadata.len() > 4096 {
            return Err(Error::Invalid("invalid Office JWT secret file"));
        }
        let secret = Zeroizing::new(
            std::fs::read_to_string(path)
                .map_err(|_| Error::Invalid("Office JWT secret file unavailable"))?
                .trim()
                .to_owned(),
        );
        if secret.len() < 32 {
            return Err(Error::Invalid(
                "Office JWT secret must contain at least 32 characters",
            ));
        }
        Ok(Some(Self {
            origin,
            callback_origin,
            secret,
        }))
    }
    fn fingerprint(&self) -> String {
        crate::oauth::hash(&format!(
            "{}|{}|{}",
            self.origin,
            self.callback_origin,
            crate::oauth::hash(&self.secret)
        ))
    }
    fn sign(&self, value: &Value) -> Result<String> {
        jsonwebtoken::encode(
            &Header::new(Algorithm::HS256),
            value,
            &EncodingKey::from_secret(self.secret.as_bytes()),
        )
        .map_err(|_| Error::Invalid("Office token could not be signed"))
    }
    fn decode(&self, token: &str) -> Result<Value> {
        if token.len() > 65536 {
            return Err(Error::Unauthorized);
        }
        let mut validation = Validation::new(Algorithm::HS256);
        validation.required_spec_claims = HashSet::new();
        validation.leeway = 0;
        validation.validate_nbf = true;
        jsonwebtoken::decode::<Value>(
            token,
            &DecodingKey::from_secret(self.secret.as_bytes()),
            &validation,
        )
        .map(|v| v.claims)
        .map_err(|_| Error::Unauthorized)
    }
    fn capability(&self, id: Uuid, purpose: &str, exp: i64) -> Result<String> {
        self.sign(&json!({"session_id":id,"purpose":purpose,"exp":exp}))
    }
    fn check_capability(&self, token: &str, id: Uuid, purpose: &str) -> Result<()> {
        let v = self.decode(token)?;
        if v["session_id"] != id.to_string()
            || v["purpose"] != purpose
            || v["exp"]
                .as_i64()
                .is_none_or(|x| x <= Utc::now().timestamp())
        {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }
}
// Separate alias avoids shadowing the validated origin in configuration assembly.
fn origin_value(value: &str, local: bool, callback: bool) -> Result<String> {
    origin(value, local, callback)
}
fn config(s: &State) -> Result<Config> {
    Config::load(s)?.ok_or(Error::Invalid("Office editing is not configured"))
}
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
pub(crate) fn configured_origin(s: &State) -> Option<String> {
    Config::load(s).ok().flatten().map(|v| v.origin)
}
#[derive(sqlx::FromRow)]
struct Session {
    id: Uuid,
    tenant_id: Uuid,
    patient_id: Uuid,
    document_id: Uuid,
    actor_id: Uuid,
    auth_session_hash: String,
    base_version: i64,
    metadata_version: Option<i64>,
    current_version: i64,
    mode: String,
    config_hash: String,
    status: String,
    save_request_id: Option<Uuid>,
    last_error: Option<String>,
    expires_at: DateTime<Utc>,
}
const SESSION:&str="SELECT id,tenant_id,patient_id,document_id,actor_id,auth_session_hash,base_version,metadata_version,current_version,mode,config_hash,status,save_request_id,last_error,expires_at FROM office_editor_sessions WHERE id=$1";
async fn session(pool: &PgPool, id: Uuid, c: &Config) -> Result<Session> {
    let v: Session = sqlx::query_as(SESSION)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(Error::NotFound)?;
    if v.expires_at <= Utc::now() || v.config_hash != c.fingerprint() {
        return Err(Error::Unauthorized);
    }
    Ok(v)
}
async fn current_actor(s: &State, session: &Session, edit: bool) -> Result<Actor> {
    let a = s
        .browser
        .as_ref()
        .ok_or(Error::Unauthorized)?
        .authenticate_hash(&session.auth_session_hash)
        .await?;
    if a.sub != session.actor_id
        || a.tenant_id != session.tenant_id
        || edit && session.mode != "edit"
    {
        return Err(Error::Forbidden);
    }
    a.staff()?;
    let current: i64 = sqlx::query_scalar(
        "SELECT version FROM patient_documents WHERE tenant_id=$1 AND patient_id=$2 AND id=$3",
    )
    .bind(session.tenant_id)
    .bind(session.patient_id)
    .bind(session.document_id)
    .fetch_optional(db(s)?)
    .await?
    .ok_or(Error::NotFound)?;
    if session.metadata_version != Some(current) {
        return Err(Error::Conflict(
            "Document details or encounter link changed; reopen the Office editor",
        ));
    }
    crate::access_policies::require_native(s, &a, "clinical", if edit { "edit" } else { "view" })
        .await?;
    Ok(a)
}
fn public(session: &Session) -> Value {
    json!({"session_id":session.id,"status":session.status,"current_version":session.current_version,"last_error":session.last_error,"save_request_id":session.save_request_id,"expires_at":session.expires_at})
}
fn staff_binding(a: &Actor, p: Uuid, id: Uuid, v: &Session) -> Result<()> {
    if a.tenant_id != v.tenant_id || a.sub != v.actor_id || p != v.patient_id || id != v.document_id
    {
        return Err(Error::NotFound);
    }
    Ok(())
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/documents/office-availability", get(availability))
        .route(
            "/api/v1/patients/{patient}/documents/{id}/office-sessions",
            post(create),
        )
        .route(
            "/api/v1/patients/{patient}/documents/{id}/office-sessions/{session}",
            get(status),
        )
        .route(
            "/api/v1/patients/{patient}/documents/{id}/office-sessions/{session}/save",
            post(save),
        )
        .route("/api/v1/office/source/{session}", get(source))
        .route(
            "/api/v1/office/callback/{session}",
            post(callback).layer(DefaultBodyLimit::max(65536)),
        )
}
async fn availability(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    Ok(Json(match Config::load(&s) {
        Ok(Some(c)) => json!({"available":true,"editor_origin":c.origin,"reason":null}),
        Ok(None) => {
            json!({"available":false,"editor_origin":null,"reason":"Office editor is not configured for this practice."})
        }
        Err(_) => {
            json!({"available":false,"editor_origin":null,"reason":"Office editor configuration needs administrator attention."})
        }
    }))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    request_id: Uuid,
    base_version: i64,
    mode: String,
}
async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<Create>,
) -> Result<Json<Value>> {
    let c = config(&s)?;
    a.staff()?;
    if !["view", "edit"].contains(&v.mode.as_str()) || v.base_version < 1 {
        return Err(Error::Invalid("invalid Office mode or base version"));
    }
    crate::access_policies::require_native(
        &s,
        &a,
        "clinical",
        if v.mode == "edit" { "edit" } else { "view" },
    )
    .await?;
    // Only current browser sessions can authorize a continuing provider session.
    let token = crate::browser::cookie(&h).ok_or(Error::Unauthorized)?;
    let auth_hash = crate::browser::hash(&token);
    let current = s
        .browser
        .as_ref()
        .unwrap()
        .authenticate_hash(&auth_hash)
        .await?;
    if current.sub != a.sub || current.tenant_id != a.tenant_id {
        return Err(Error::Unauthorized);
    }
    let mut tx = db(&s)?.begin().await?;
    let file = files::office_source(
        &mut tx,
        crate::documents::store(&s)?,
        &current,
        p,
        id,
        v.base_version,
    )
    .await?;
    let (category,metadata_version):(Value,i64)=sqlx::query_as("SELECT content,version FROM patient_documents WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR SHARE").bind(a.tenant_id).bind(p).bind(id).fetch_one(&mut *tx).await?;
    if v.mode == "edit" {
        crate::documents::write_document(&current, category["category"].as_str().unwrap_or(""))?;
        if category["status"] != "active" {
            return Err(Error::Conflict("only active documents can be edited"));
        }
    }
    let session_id = Uuid::new_v4();
    let expires = Utc::now() + chrono::Duration::seconds(TTL);
    sqlx::query("INSERT INTO office_editor_sessions(id,tenant_id,patient_id,document_id,actor_id,auth_session_hash,request_id,base_version,current_version,mode,config_hash,expires_at,metadata_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12) ON CONFLICT(tenant_id,request_id) DO NOTHING")
 .bind(session_id).bind(a.tenant_id).bind(p).bind(id).bind(a.sub).bind(&auth_hash).bind(v.request_id).bind(v.base_version).bind(&v.mode).bind(c.fingerprint()).bind(expires).bind(metadata_version).execute(&mut *tx).await?;
    let saved: Session = sqlx::query_as(&format!(
        "{} AND tenant_id=$2",
        SESSION.replace("WHERE id=$1", "WHERE request_id=$1")
    ))
    .bind(v.request_id)
    .bind(a.tenant_id)
    .fetch_one(&mut *tx)
    .await?;
    staff_binding(&a, p, id, &saved)?;
    if saved.base_version != v.base_version
        || saved.metadata_version != Some(metadata_version)
        || saved.mode != v.mode
        || saved.auth_session_hash != auth_hash
        || saved.config_hash != c.fingerprint()
        || saved.expires_at <= Utc::now()
        || saved.status == "closed"
    {
        return Err(Error::Conflict("Office request already used or expired"));
    }
    audit(&mut tx, &a, "patient.document.office_opened", id).await?;
    tx.commit().await?;
    if file.version != saved.base_version {
        return Err(Error::Conflict("Office source version mismatch"));
    }
    let filetype = if file.content_type.ends_with("wordprocessingml.document") {
        "docx"
    } else {
        "xlsx"
    };
    let cap = c.capability(saved.id, "office_source", saved.expires_at.timestamp())?;
    let callback = c.capability(saved.id, "office_callback", saved.expires_at.timestamp())?;
    let mut editor = json!({"document":{"fileType":filetype,"key":format!("sce_{}",saved.id.simple()),"title":file.filename,"url":format!("{}/api/v1/office/source/{}?token={}",c.callback_origin,saved.id,cap),"permissions":{"edit":v.mode=="edit","download":false,"print":false,"review":false,"comment":false}},"documentType":if filetype=="docx"{"word"}else{"cell"},"editorConfig":{"mode":v.mode,"callbackUrl":format!("{}/api/v1/office/callback/{}?token={}",c.callback_origin,saved.id,callback),"user":{"id":a.sub.to_string(),"name":"Practice staff"},"coEditing":{"mode":"fast","change":false},"customization":{"forcesave":false,"autosave":true,"plugins":false,"macros":false,"macrosMode":"disable","ai":{"disabled":true}}},"width":"100%","height":"100%"});
    editor["token"] = json!(c.sign(&editor)?);
    let mut response = public(&saved);
    response["editor_origin"] = json!(c.origin);
    response["config"] = editor;
    Ok(Json(response))
}
async fn status(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id, sid)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let c = config(&s)?;
    let v = session(db(&s)?, sid, &c).await?;
    staff_binding(&a, p, id, &v)?;
    current_actor(&s, &v, false).await?;
    let mut tx = db(&s)?.begin().await?;
    audit(&mut tx, &a, "patient.document.office_status", id).await?;
    tx.commit().await?;
    Ok(Json(public(&v)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Capability {
    token: String,
}
async fn source(
    ExtractState(s): ExtractState<State>,
    Path(sid): Path<Uuid>,
    Query(q): Query<Capability>,
) -> Result<Response> {
    let c = config(&s)?;
    c.check_capability(&q.token, sid, "office_source")?;
    let v = session(db(&s)?, sid, &c).await?;
    let a = current_actor(&s, &v, false).await?;
    let mut tx = db(&s)?.begin().await?;
    let file = files::office_source(
        &mut tx,
        crate::documents::store(&s)?,
        &a,
        v.patient_id,
        v.document_id,
        v.base_version,
    )
    .await?;
    tx.commit().await?;
    let mut r = (
        [
            (header::CONTENT_TYPE, file.content_type),
            (header::CONTENT_DISPOSITION, "attachment".into()),
        ],
        file.bytes,
    )
        .into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(r)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    request_id: Uuid,
    expected_version: i64,
}
fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| Error::Invalid("Office client unavailable"))
}
async fn verify_editable(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    a: &Actor,
    v: &Session,
) -> Result<()> {
    let (content,metadata_version):(Value,i64)=sqlx::query_as("SELECT content,version FROM patient_documents WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE").bind(a.tenant_id).bind(v.patient_id).bind(v.document_id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
    crate::documents::write_document(a, content["category"].as_str().unwrap_or(""))?;
    let latest:i64=sqlx::query_scalar("SELECT coalesce(max(version),1) FROM patient_document_file_versions WHERE tenant_id=$1 AND document_id=$2").bind(a.tenant_id).bind(v.document_id).fetch_one(&mut **tx).await?;
    if v.metadata_version != Some(metadata_version) {
        return Err(Error::Conflict(
            "Document details or encounter link changed; reopen the Office editor",
        ));
    }
    if content["status"] != "active" || latest != v.current_version {
        return Err(Error::Conflict(
            "Office file changed or is no longer active; review the latest version",
        ));
    }
    Ok(())
}
async fn save(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id, sid)): Path<(Uuid, Uuid, Uuid)>,
    Json(v): Json<Save>,
) -> Result<Json<Value>> {
    let c = config(&s)?;
    save_with_config(a, s, p, id, sid, v, c).await
}
async fn save_with_config(
    a: Actor,
    s: State,
    p: Uuid,
    id: Uuid,
    sid: Uuid,
    v: Save,
    c: Config,
) -> Result<Json<Value>> {
    let bound = session(db(&s)?, sid, &c).await?;
    staff_binding(&a, p, id, &bound)?;
    let a = current_actor(&s, &bound, true).await?;
    let mut tx = db(&s)?.begin().await?;
    let locked: Session = sqlx::query_as(&format!("{SESSION} FOR UPDATE"))
        .bind(sid)
        .fetch_one(&mut *tx)
        .await?;
    let previous:Option<(Uuid,i64,String,i32)>=sqlx::query_as("SELECT session_id,expected_version,status,command_attempts FROM office_editor_saves WHERE id=$1").bind(v.request_id).fetch_optional(&mut *tx).await?;
    if let Some((old_session, expected, ref status, _)) = previous {
        if old_session != sid || expected != v.expected_version {
            return Err(Error::Conflict("Office save request reused"));
        }
        if status == "complete" {
            return Ok(Json(public(&locked)));
        }
        if status != "pending" {
            return Err(Error::Conflict("Office save requires review"));
        }
    }
    if locked.current_version != v.expected_version || locked.status == "closed" {
        return Err(Error::Conflict(
            "Office file version changed; review before saving",
        ));
    }
    verify_editable(&mut tx, &a, &locked).await?;
    let attempts = if let Some((_, _, _, attempts)) = previous {
        if attempts >= 10 {
            return Err(Error::Conflict(
                "Office save retries exhausted; keep editor open for administrator review",
            ));
        }
        sqlx::query(
            "UPDATE office_editor_saves SET command_attempts=command_attempts+1 WHERE id=$1",
        )
        .bind(v.request_id)
        .execute(&mut *tx)
        .await?;
        attempts + 1
    } else {
        let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM office_editor_saves WHERE session_id=$1 AND status='pending')").bind(sid).fetch_one(&mut *tx).await?;
        if pending {
            return Err(Error::Conflict(
                "Office save is awaiting confirmation; retry the same request",
            ));
        }
        sqlx::query("INSERT INTO office_editor_saves(id,session_id,expected_version,status) VALUES($1,$2,$3,'pending')").bind(v.request_id).bind(sid).bind(v.expected_version).execute(&mut *tx).await?;
        1
    };
    sqlx::query("UPDATE office_editor_sessions SET status='saving',last_error=NULL,save_request_id=$2 WHERE id=$1").bind(sid).bind(v.request_id).execute(&mut *tx).await?;
    audit(&mut tx, &a, "patient.document.office_save_requested", id).await?;
    tx.commit().await?;
    let command = json!({"c":"forcesave","key":format!("sce_{}",sid.simple()),"userdata":v.request_id.to_string(),"operation":"command"});
    let result = async {
        let response = client()?
            .post(format!("{}/command", c.origin))
            .json(&json!({"token":c.sign(&command)?}))
            .send()
            .await
            .map_err(|_| Error::Invalid("Office save request could not be confirmed"))?;
        if response.status() != 200 {
            return Err(Error::Invalid("Office save service returned an error"));
        }
        let raw = crate::stedi::bytes(response, 65536).await?;
        let body: Value = serde_json::from_slice(&raw)
            .map_err(|_| Error::Invalid("invalid Office command response"))?;
        if body["key"] != command["key"] {
            return Err(Error::Invalid("Office save response key mismatch"));
        }
        match body["error"].as_i64() {
            Some(0) => Ok(false),
            Some(4) if attempts == 1 => Ok(true),
            _ => Err(Error::Invalid(
                "Office editor could not save; keep the editor open",
            )),
        }
    }
    .await;
    match result {
        Ok(true) => {
            let mut tx = db(&s)?.begin().await?;
            let locked: Session = sqlx::query_as(&format!("{SESSION} FOR UPDATE"))
                .bind(sid)
                .fetch_one(&mut *tx)
                .await?;
            let actor = current_actor(&s, &locked, true).await?;
            verify_editable(&mut tx, &actor, &locked).await?;
            let count=sqlx::query("UPDATE office_editor_saves SET status='complete',saved_version=expected_version WHERE id=$1 AND session_id=$2 AND status='pending' AND command_attempts=1").bind(v.request_id).bind(sid).execute(&mut *tx).await?.rows_affected();
            if count == 1 {
                sqlx::query(
                    "UPDATE office_editor_sessions SET status='saved',last_error=NULL WHERE id=$1",
                )
                .bind(sid)
                .execute(&mut *tx)
                .await?;
                audit(&mut tx, &a, "patient.document.office_no_changes", id).await?;
            }
            tx.commit().await?;
        }
        Ok(false) => {}
        Err(_) => {
            mark_error(
                &s,
                &a,
                sid,
                id,
                "Save confirmation unavailable. Keep the editor open and refresh status.",
            )
            .await?;
        }
    }
    Ok(Json(public(&session(db(&s)?, sid, &c).await?)))
}
async fn mark_error(s: &State, a: &Actor, sid: Uuid, id: Uuid, message: &str) -> Result<()> {
    let mut tx = db(s)?.begin().await?;
    sqlx::query("UPDATE office_editor_sessions SET status='needs_review',last_error=$2 WHERE id=$1 AND status<>'saved'").bind(sid).bind(message).execute(&mut *tx).await?;
    audit(&mut tx, a, "patient.document.office_error", id).await?;
    tx.commit().await?;
    Ok(())
}
fn signed_callback(c: &Config, h: &HeaderMap, body: &Value) -> Result<Value> {
    let token = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .or_else(|| body["token"].as_str())
        .ok_or(Error::Unauthorized)?;
    let decoded = c.decode(token)?;
    let payload = decoded.get("payload").unwrap_or(&decoded).clone();
    let mut unsigned = body.clone();
    if let Some(map) = unsigned.as_object_mut() {
        map.remove("token");
    }
    // Header JWTs authenticate exactly the callback fields. Body-token mode may send just the token.
    if unsigned.as_object().is_none_or(|map| !map.is_empty()) && unsigned != payload {
        return Err(Error::Unauthorized);
    }
    Ok(payload)
}
async fn fetch_saved(c: &Config, url: &str) -> Result<Vec<u8>> {
    let u = url::Url::parse(url).map_err(|_| Error::Invalid("invalid Office save URL"))?;
    if u.origin().ascii_serialization() != c.origin
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err(Error::Forbidden);
    }
    let mut response = client()?
        .get(u)
        .send()
        .await
        .map_err(|_| Error::Invalid("Office edited file unavailable"))?;
    if response.status() != 200
        || response
            .content_length()
            .is_some_and(|v| v > MAX_FILE as u64)
    {
        return Err(Error::Invalid(
            "Office edited file unavailable or oversized",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Error::Invalid("Office edited file incomplete"))?
    {
        if bytes.len() + chunk.len() > MAX_FILE {
            return Err(Error::Invalid("Office file exceeds 10 MiB"));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(Error::Invalid("Office returned an empty file"));
    }
    Ok(bytes)
}
async fn callback(
    ExtractState(s): ExtractState<State>,
    Path(sid): Path<Uuid>,
    Query(q): Query<Capability>,
    h: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let c = config(&s)?;
    c.check_capability(&q.token, sid, "office_callback")?;
    callback_with_config(s, sid, c, h, body).await
}
async fn callback_with_config(
    s: State,
    sid: Uuid,
    c: Config,
    h: HeaderMap,
    body: Value,
) -> Result<Json<Value>> {
    let body = signed_callback(&c, &h, &body)?;
    let v = session(db(&s)?, sid, &c).await?;
    if body["key"] != format!("sce_{}", sid.simple()) {
        return Err(Error::Forbidden);
    }
    let status = body["status"]
        .as_i64()
        .ok_or(Error::Invalid("Office callback status missing"))?;
    if matches!(status, 1 | 4) {
        current_actor(&s, &v, false).await?;
        return Ok(Json(json!({"error":0})));
    }
    if status == 2 {
        // Closing/discarding never imports an unbound file. Keep a pending explicit
        // save alive until its operation-bound callback has been confirmed.
        let actor = current_actor(&s, &v, false).await?;
        let mut tx = db(&s)?.begin().await?;
        sqlx::query("SELECT id FROM office_editor_sessions WHERE id=$1 FOR UPDATE")
            .bind(sid)
            .execute(&mut *tx)
            .await?;
        let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM office_editor_saves WHERE session_id=$1 AND status='pending')").bind(sid).fetch_one(&mut *tx).await?;
        if pending {
            return Ok(Json(json!({"error":1})));
        }
        sqlx::query("UPDATE office_editor_sessions SET status='closed' WHERE id=$1")
            .bind(sid)
            .execute(&mut *tx)
            .await?;
        audit(
            &mut tx,
            &actor,
            "patient.document.office_closed",
            v.document_id,
        )
        .await?;
        tx.commit().await?;
        return Ok(Json(json!({"error":0})));
    }
    let a = current_actor(&s, &v, true).await?;
    if status != 6 || body["forcesavetype"] != 0 || body["users"] != json!([v.actor_id.to_string()])
    {
        return Ok(Json(json!({"error":1})));
    }
    let operation = body["userdata"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or(Error::Invalid(
            "Office callback does not identify a requested save",
        ))?;
    let digest = crate::oauth::hash(&body.to_string());
    let old: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT status,callback_hash FROM office_editor_saves WHERE id=$1 AND session_id=$2",
    )
    .bind(operation)
    .bind(sid)
    .fetch_optional(db(&s)?)
    .await?;
    match old {
        Some((status, hash)) if status == "complete" => {
            return if hash.as_deref() == Some(&digest) {
                Ok(Json(json!({"error":0})))
            } else {
                Err(Error::Conflict(
                    "Office callback differs from completed save",
                ))
            }
        }
        Some((status, _)) if status == "pending" => {}
        _ => return Err(Error::Conflict("Office save was not requested")),
    }
    let result=async{
  let bytes=fetch_saved(&c,body["url"].as_str().ok_or(Error::Invalid("Office save URL missing"))?).await?;
  let actor=current_actor(&s,&v,true).await?;
  let mut tx=db(&s)?.begin().await?;
  let locked:Session=sqlx::query_as(&format!("{SESSION} FOR UPDATE")).bind(sid).fetch_one(&mut *tx).await?;
  let (state,expected,hash):(String,i64,Option<String>)=sqlx::query_as("SELECT status,expected_version,callback_hash FROM office_editor_saves WHERE id=$1 AND session_id=$2 FOR UPDATE").bind(operation).bind(sid).fetch_one(&mut *tx).await?;
  if state=="complete"&&hash.as_deref()==Some(&digest){return Ok(());}
  if state!="pending"||expected!=locked.current_version||locked.expires_at<=Utc::now(){return Err(Error::Conflict("Office save version changed"));}
  verify_editable(&mut tx,&actor,&locked).await?;
  let original=files::office_source(&mut tx,crate::documents::store(&s)?,&actor,v.patient_id,v.document_id,expected).await?;
  let filetype=if original.content_type.ends_with("wordprocessingml.document"){"docx"}else{"xlsx"};
  if body["filetype"]!=filetype{return Err(Error::Invalid("Office returned a different file format"));}
  let saved_version=if original.sha256==format!("{:x}",Sha256::digest(&bytes)){expected}else{files::append_office_file(&mut tx,crate::documents::store(&s)?,&actor,v.patient_id,v.document_id,expected,operation,bytes).await?["version"].as_i64().ok_or(Error::Invalid("Office version missing"))?};
  sqlx::query("UPDATE office_editor_saves SET status='complete',callback_hash=$2,saved_version=$3 WHERE id=$1").bind(operation).bind(&digest).bind(saved_version).execute(&mut *tx).await?;
  sqlx::query("UPDATE office_editor_sessions SET status='saved',current_version=$2,last_error=NULL WHERE id=$1").bind(sid).bind(saved_version).execute(&mut *tx).await?;
  audit(&mut tx,&actor,"patient.document.office_saved",v.document_id).await?;tx.commit().await?;Ok(())
 }.await;
    if result.is_err() {
        mark_error(
            &s,
            &a,
            sid,
            v.document_id,
            "The edited file was not saved. Keep the editor open and review the latest version.",
        )
        .await?;
    }
    Ok(Json(json!({"error":if result.is_ok(){0}else{1}})))
}

#[cfg(test)]
#[path = "office_tests.rs"]
mod tests;
