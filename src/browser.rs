// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Standalone clinical browser identity. Separate from SunCharts SaaS authentication.
use crate::{
    auth::Actor,
    error::{Error, Result},
    State,
};
use argon2::{
    password_hash::{rand_core::OsRng, SaltString},
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
};
use axum::{
    extract::State as ExtractState,
    http::{header, HeaderMap},
    Json,
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub struct BrowserAuth {
    pub db: PgPool,
    origin: String,
    secure: bool,
    attempts: Mutex<(Instant, u32)>,
}

impl BrowserAuth {
    pub fn origin(&self) -> &str {
        &self.origin
    }
    pub fn new(db: PgPool, origin: String) -> std::result::Result<Arc<Self>, &'static str> {
        let url = url::Url::parse(&origin).map_err(|_| "invalid browser origin")?;
        let secure = url.scheme() == "https";
        let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        if !(secure || (url.scheme() == "http" && local))
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err("browser origin must be an HTTPS origin or loopback HTTP");
        }
        Ok(Arc::new(Self {
            db,
            origin: url.origin().ascii_serialization(),
            secure,
            attempts: Mutex::new((Instant::now(), 0)),
        }))
    }
    pub fn check_origin(&self, h: &HeaderMap) -> Result<()> {
        if h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(self.origin.as_str()) {
            return Err(Error::Forbidden);
        }
        Ok(())
    }
    fn cookie(&self, token: &str, seconds: u64) -> String {
        format!(
            "sce_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={seconds}{}",
            if self.secure { "; Secure" } else { "" }
        )
    }
    pub async fn authenticate(&self, h: &HeaderMap, write: bool) -> Result<Actor> {
        if write {
            self.check_origin(h)?;
        }
        let token = cookie(h).ok_or(Error::Unauthorized)?;
        let row:Option<(Uuid,Uuid,String)>=sqlx::query_as("SELECT u.id,u.tenant_id,u.role FROM browser_sessions s JOIN browser_users u ON u.id=s.user_id AND u.tenant_id=s.tenant_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled")
            .bind(hash(&token)).fetch_optional(&self.db).await?;
        let (sub, tenant_id, role) = row.ok_or(Error::Unauthorized)?;
        let role = serde_json::from_value(json!(role)).map_err(|_| Error::Unauthorized)?;
        let now = chrono::Utc::now().timestamp();
        Ok(Actor {
            sub,
            tenant_id,
            role,
            patient_id: None,
            iss: "suncharts-ehr-browser".into(),
            aud: "suncharts-engine".into(),
            iat: now,
            exp: now + 60,
        })
    }
}

fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn cookie(h: &HeaderMap) -> Option<String> {
    h.get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("sce_session=").map(str::to_owned))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Login {
    email: String,
    password: String,
}

pub async fn login(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(input): Json<Login>,
) -> Result<(HeaderMap, Json<Value>)> {
    let auth = s.browser.as_ref().ok_or(Error::NotFound)?;
    auth.check_origin(&h)?;
    if input.email.len() > 254 || input.password.len() > 1024 {
        return Err(Error::Unauthorized);
    }
    {
        let mut window = auth.attempts.lock().map_err(|_| Error::Unauthorized)?;
        if window.0.elapsed() > Duration::from_secs(60) {
            *window = (Instant::now(), 0);
        }
        window.1 += 1;
        if window.1 > 20 {
            return Err(Error::Unauthorized);
        }
    }
    let row: Option<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT id,tenant_id,password_hash FROM browser_users WHERE email=$1 AND NOT disabled",
    )
    .bind(input.email.trim().to_lowercase())
    .fetch_optional(&auth.db)
    .await?;
    let dummy = tokio::task::spawn_blocking(|| {
        Argon2::default()
            .hash_password(b"dummy-password", &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
    })
    .await
    .map_err(|_| Error::Unauthorized)?
    .map_err(|_| Error::Unauthorized)?;
    let hashed = row.as_ref().map(|r| r.2.clone()).unwrap_or(dummy);
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hashed).is_ok_and(|h| {
            Argon2::default()
                .verify_password(input.password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .map_err(|_| Error::Unauthorized)?;
    let (id, tenant, _) = row.filter(|_| valid).ok_or(Error::Unauthorized)?;
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let token = raw.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let mut tx = auth.db.begin().await?;
    sqlx::query("DELETE FROM browser_sessions WHERE expires_at<=now()")
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO browser_sessions (token_hash,tenant_id,user_id,expires_at) VALUES ($1,$2,$3,now()+interval '8 hours')")
        .bind(hash(&token)).bind(tenant).bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO audit_events (tenant_id,actor_id,action,resource_id) VALUES ($1,$2,'auth.login',$2)").bind(tenant).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        auth.cookie(&token, 8 * 3600)
            .parse()
            .map_err(|_| Error::Unauthorized)?,
    );
    Ok((headers, Json(json!({"authenticated":true}))))
}

pub async fn logout(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
) -> Result<(HeaderMap, Json<Value>)> {
    let auth = s.browser.as_ref().ok_or(Error::NotFound)?;
    auth.check_origin(&h)?;
    let mut tx = auth.db.begin().await?;
    if let Some(token) = cookie(&h) {
        sqlx::query("DELETE FROM browser_sessions WHERE token_hash=$1")
            .bind(hash(&token))
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO audit_events (tenant_id,actor_id,action,resource_id) VALUES ($1,$2,'auth.logout',$2)").bind(a.tenant_id).bind(a.sub).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        auth.cookie("", 0)
            .parse()
            .map_err(|_| Error::Unauthorized)?,
    );
    Ok((headers, Json(json!({"authenticated":false}))))
}

pub async fn me(a: Actor) -> Json<Value> {
    Json(json!({"user_id":a.sub,"tenant_id":a.tenant_id,"role":a.role}))
}

pub async fn bootstrap(db: &PgPool) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let email = std::env::var("ENGINE_BOOTSTRAP_EMAIL").ok();
    let password = std::env::var("ENGINE_BOOTSTRAP_PASSWORD").ok();
    if email.is_none() && password.is_none() {
        return Ok(());
    }
    let email = email
        .ok_or("ENGINE_BOOTSTRAP_EMAIL is required")?
        .trim()
        .to_lowercase();
    let password = password.ok_or("ENGINE_BOOTSTRAP_PASSWORD is required")?;
    if password.len() < 14 || password.len() > 1024 || email.is_empty() || !email.contains('@') {
        return Err("bootstrap requires valid email and a password of 14 to 1024 bytes".into());
    }
    let tenant: Uuid = std::env::var("ENGINE_BOOTSTRAP_TENANT_ID")
        .map_err(|_| "ENGINE_BOOTSTRAP_TENANT_ID is required")?
        .parse()?;
    let clinician: Uuid = std::env::var("ENGINE_BOOTSTRAP_CLINICIAN_ID")
        .map_err(|_| "ENGINE_BOOTSTRAP_CLINICIAN_ID is required")?
        .parse()?;
    let role = std::env::var("ENGINE_BOOTSTRAP_ROLE").unwrap_or_else(|_| "owner".into());
    if !matches!(role.as_str(), "owner" | "clinician") {
        return Err("ENGINE_BOOTSTRAP_ROLE must be owner or clinician".into());
    }
    let existing: Option<(Uuid, Uuid)> =
        sqlx::query_as("SELECT id,tenant_id FROM browser_users WHERE email=$1")
            .bind(&email)
            .fetch_optional(db)
            .await?;
    if let Some((id, tid)) = existing {
        if id != clinician || tid != tenant {
            return Err("bootstrap identity differs from stored user".into());
        }
        return Ok(());
    }
    let hash = tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
    })
    .await?
    .map_err(|_| "password hashing failed")?;
    sqlx::query(
        "INSERT INTO browser_users (id,tenant_id,email,password_hash,role) VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(clinician)
    .bind(tenant)
    .bind(email)
    .bind(hash)
    .bind(role)
    .execute(db)
    .await?;
    Ok(())
}
