// SPDX-License-Identifier: AGPL-3.0-only
//! Separate native patient identity, explicitly published AVS versions and secure messages.
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
    extract::{Path, State as ExtractState},
    http::{header, HeaderMap},
    routing::{get, post},
    Json, Router,
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use std::sync::OnceLock;
use uuid::Uuid;
type Tx<'a> = Transaction<'a, Postgres>;
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn hash(v: &str) -> String {
    format!("{:x}", Sha256::digest(v.as_bytes()))
}
fn secret() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|v| format!("{v:02x}")).collect()
}
fn token(h: &HeaderMap) -> Result<String> {
    let t = h
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.split(';')
                .find_map(|p| p.trim().strip_prefix("sce_portal=").map(str::to_owned))
        })
        .ok_or(Error::Unauthorized)?;
    if t.len() != 64 || !t.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Unauthorized);
    }
    Ok(t)
}
fn origin(s: &State, h: &HeaderMap) -> Result<()> {
    s.browser.as_ref().ok_or(Error::NotFound)?.check_origin(h)
}
fn cookies(s: &State, t: &str, seconds: u32) -> Result<HeaderMap> {
    let mut h = HeaderMap::new();
    let secure = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .origin()
        .starts_with("https:");
    h.insert(header::SET_COOKIE,format!("sce_portal={t}; HttpOnly; SameSite=Strict; Path=/api/v1/patient-portal; Max-Age={seconds}{}",if secure{"; Secure"}else{""}).parse().map_err(|_|Error::Unauthorized)?);
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok(h)
}
fn text(v: &mut String, max: usize) -> Result<()> {
    *v = v.trim().to_string();
    if v.is_empty()
        || v.chars().count() > max
        || v.chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(Error::Invalid("invalid text length or control characters"));
    }
    Ok(())
}
fn expected(h: &HeaderMap) -> Result<i64> {
    h.get(header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix('"'))
        .and_then(|v| v.strip_suffix('"'))
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 0)
        .ok_or(Error::VersionRequired)
}
#[allow(clippy::too_many_arguments)]
async fn audit(
    tx: &mut Tx<'_>,
    tenant: Uuid,
    patient: Uuid,
    actor: Uuid,
    kind: &str,
    action: &str,
    resource: Uuid,
    version: Option<i64>,
    details: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO patient_portal_events(tenant_id,patient_id,actor_id,actor_kind,action,resource_id,version,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(tenant).bind(patient).bind(actor).bind(kind).bind(action).bind(resource).bind(version).bind(details).execute(&mut **tx).await?;
    Ok(())
}
#[derive(Clone)]
struct Patient {
    tenant: Uuid,
    id: Uuid,
    account: Uuid,
}
const ACCOUNT_CHANGED: &str = "Patient account changed; reload this portal before continuing";
async fn patient<'a>(s: &'a State, h: &HeaderMap, write: bool) -> Result<(Tx<'a>, Patient)> {
    patient_identity(s, h, write, true).await
}
async fn patient_identity<'a>(
    s: &'a State,
    h: &HeaderMap,
    write: bool,
    bound: bool,
) -> Result<(Tx<'a>, Patient)> {
    if write {
        origin(s, h)?;
    }
    let t = token(h)?;
    let mut tx = db(s)?.begin().await?;
    let row:Option<(Uuid,Uuid,Uuid)>=sqlx::query_as("SELECT a.tenant_id,a.patient_id,a.id FROM patient_portal_sessions s JOIN patient_portal_accounts a ON a.tenant_id=s.tenant_id AND a.id=s.account_id AND a.version=s.account_version WHERE s.token_hash=$1 AND s.expires_at>now() AND s.last_seen_at>now()-interval '20 minutes' AND a.status='active' FOR SHARE OF a FOR UPDATE OF s").bind(hash(&t)).fetch_optional(&mut *tx).await?;
    let (tenant, id, account) = row.ok_or(Error::Unauthorized)?;
    if bound {
        let expected = h
            .get("X-SunCharts-Portal-Account")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| Uuid::parse_str(v).ok());
        if expected != Some(account) {
            return Err(Error::Conflict(ACCOUNT_CHANGED));
        }
    }
    // Account/session locks serialize revocation with every authenticated operation.
    Ok((
        tx,
        Patient {
            tenant,
            id,
            account,
        },
    ))
}
async fn touch(tx: &mut Tx<'_>, h: &HeaderMap) -> Result<()> {
    sqlx::query("UPDATE patient_portal_sessions SET last_seen_at=now() WHERE token_hash=$1")
        .bind(hash(&token(h)?))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn rate(s: &State, key: String, limit: i32) -> Result<()> {
    {
        sqlx::query(
            "DELETE FROM patient_portal_rate_limits WHERE window_started<now()-interval '1 day'",
        )
        .execute(db(s)?)
        .await?;
    }
    let attempts:i32=sqlx::query_scalar("INSERT INTO patient_portal_rate_limits(key) VALUES($1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN patient_portal_rate_limits.window_started<now()-interval '15 minutes' THEN 1 ELSE patient_portal_rate_limits.attempts+1 END,window_started=CASE WHEN patient_portal_rate_limits.window_started<now()-interval '15 minutes' THEN now() ELSE patient_portal_rate_limits.window_started END RETURNING attempts").bind(key).fetch_one(db(s)?).await?;
    if attempts > limit {
        return Err(Error::Unauthorized);
    }
    Ok(())
}
async fn password_hash(password: String) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|v| v.to_string())
    })
    .await
    .map_err(|_| Error::Unauthorized)?
    .map_err(|_| Error::Unauthorized)
}
fn password(v: &str) -> Result<()> {
    if v.chars().count() < 15 || v.len() > 1024 {
        return Err(Error::Invalid(
            "use a password of at least 15 characters and at most 1024 bytes",
        ));
    }
    Ok(())
}
async fn staff_patient(tx: &mut Tx<'_>, a: &Actor, p: Uuid) -> Result<()> {
    a.scheduling()?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(p)
            .fetch_one(&mut **tx)
            .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    Ok(())
}
// Short-lived concurrency budget bounds expensive password work without a shared
// attacker-fillable time window that locks every patient out for fifteen minutes.
static AUTH_WORK: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);
async fn session(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let (tx, p) = patient_identity(&s, &h, false, false).await?;
    tx.commit().await?;
    Ok(Json(json!({"account_id":p.account})))
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/patient-portal/session", get(session))
        .route("/api/v1/patient-portal/activate", post(activate))
        .route("/api/v1/patient-portal/login", post(login))
        .route("/api/v1/patient-portal/logout", post(logout))
        .route("/api/v1/patient-portal/dashboard", get(dashboard))
        .route("/api/v1/patient-portal/avs/{visit}", get(avs))
        .route(
            "/api/v1/patient-portal/threads",
            get(patient_threads).post(patient_create),
        )
        .route(
            "/api/v1/patient-portal/threads/{thread}",
            get(patient_thread).post(patient_reply),
        )
        .route("/api/v1/patients/{patient}/portal", get(staff_access))
        .route("/api/v1/patients/{patient}/portal/invite", post(invite))
        .route("/api/v1/patients/{patient}/portal/revoke", post(revoke))
        .route(
            "/api/v1/patients/{patient}/portal/avs/{visit}",
            post(publish),
        )
        .route("/api/v1/portal-inbox", get(staff_inbox))
        .route(
            "/api/v1/portal-inbox/{thread}",
            get(staff_thread).post(staff_reply),
        )
        .route("/api/v1/portal-inbox/{thread}/status", post(staff_status))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Invite {
    email: String,
    reason: String,
}
async fn invite(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    h: HeaderMap,
    Json(mut input): Json<Invite>,
) -> Result<Json<Value>> {
    origin(&s, &h)?;
    let version = expected(&h)?;
    input.email = input.email.trim().to_lowercase();
    text(&mut input.email, 254)?;
    text(&mut input.reason, 1000)?;
    if !input.email.contains('@') || input.email.chars().any(char::is_whitespace) {
        return Err(Error::Invalid("invalid email"));
    }
    let mut tx = db(&s)?.begin().await?;
    staff_patient(&mut tx, &a, p).await?;
    // Stable per-patient lock also serializes first invitations before an account exists.
    sqlx::query("SELECT id FROM patients WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(a.tenant_id)
        .bind(p)
        .execute(&mut *tx)
        .await?;
    let row:Option<(Uuid,i64,String)>=sqlx::query_as("SELECT id,version,status FROM patient_portal_accounts WHERE tenant_id=$1 AND patient_id=$2 FOR UPDATE").bind(a.tenant_id).bind(p).fetch_optional(&mut *tx).await?;
    let (id, current, status) = row.unwrap_or((Uuid::new_v4(), 0, "new".into()));
    if current != version {
        return Err(Error::Conflict(
            "portal access changed; reload before inviting",
        ));
    }
    if status == "active" {
        return Err(Error::Conflict(
            "revoke active access before issuing a replacement invitation",
        ));
    }
    sqlx::query("INSERT INTO patient_portal_accounts(tenant_id,id,patient_id,email,status,version) VALUES($1,$2,$3,$4,'invited',1) ON CONFLICT(tenant_id,patient_id) DO UPDATE SET email=$4,status='invited',password_hash=NULL,version=patient_portal_accounts.version+1").bind(a.tenant_id).bind(id).bind(p).bind(&input.email).execute(&mut *tx).await?;
    sqlx::query("UPDATE patient_portal_invites SET revoked_at=now() WHERE tenant_id=$1 AND account_id=$2 AND used_at IS NULL AND revoked_at IS NULL").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
    let token = secret();
    sqlx::query("INSERT INTO patient_portal_invites(token_hash,tenant_id,account_id,account_version,expires_at,created_by) VALUES($1,$2,$3,$4,now()+interval '24 hours',$5)").bind(hash(&token)).bind(a.tenant_id).bind(id).bind(current+1).bind(a.sub).execute(&mut *tx).await?;
    audit(
        &mut tx,
        a.tenant_id,
        p,
        a.sub,
        "staff",
        "invite",
        id,
        Some(current + 1),
        json!({"reason":input.reason}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"version":current+1,"practice_id":a.tenant_id,"invitation_url":format!("{}/patient-portal#invite={token}",s.browser.as_ref().unwrap().origin()),"expires_in_seconds":86400,"delivery":"manual_secure_handoff","email_sent":false}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Activation {
    token: String,
    password: String,
}
async fn activate(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(input): Json<Activation>,
) -> Result<Json<Value>> {
    origin(&s, &h)?;
    let _permit = AUTH_WORK
        .try_acquire()
        .map_err(|_| Error::Conflict("Portal sign-in is busy; try again shortly"))?;
    password(&input.password)?;
    if input.token.len() != 64 {
        return Err(Error::Unauthorized);
    }
    let found: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT tenant_id,account_id FROM patient_portal_invites WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now()",
    )
    .bind(hash(&input.token))
    .fetch_optional(db(&s)?)
    .await?;
    let (tenant, account) = found.ok_or(Error::Unauthorized)?;
    rate(&s, format!("activate:{}", hash(&input.token)), 10).await?;
    let hashed = password_hash(input.password).await?;
    let mut tx = db(&s)?.begin().await?;
    let row:Option<(Uuid,i64,String,String)>=sqlx::query_as("SELECT patient_id,version,status,email FROM patient_portal_accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE").bind(tenant).bind(account).fetch_optional(&mut *tx).await?;
    let (p, v, status, email) = row.ok_or(Error::Unauthorized)?;
    if status != "invited" {
        return Err(Error::Unauthorized);
    }
    let valid:Option<String>=sqlx::query_scalar("UPDATE patient_portal_invites SET used_at=now() WHERE token_hash=$1 AND tenant_id=$2 AND account_id=$3 AND account_version=$4 AND expires_at>now() AND used_at IS NULL AND revoked_at IS NULL RETURNING token_hash").bind(hash(&input.token)).bind(tenant).bind(account).bind(v).fetch_optional(&mut *tx).await?;
    if valid.is_none() {
        return Err(Error::Unauthorized);
    }
    sqlx::query("UPDATE patient_portal_accounts SET status='active',password_hash=$3,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(account).bind(hashed).execute(&mut *tx).await?;
    audit(
        &mut tx,
        tenant,
        p,
        account,
        "patient",
        "activate",
        account,
        Some(v + 1),
        json!({}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"activated":true,"practice_id":tenant,"email":email,"message":"Account activated. Sign in with your practice code, email and password."}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Login {
    practice_id: Uuid,
    email: String,
    password: String,
}
async fn login(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(mut input): Json<Login>,
) -> Result<(HeaderMap, Json<Value>)> {
    origin(&s, &h)?;
    let _permit = AUTH_WORK
        .try_acquire()
        .map_err(|_| Error::Conflict("Portal sign-in is busy; try again shortly"))?;
    if input.email.len() > 254 || input.password.len() > 1024 {
        return Err(Error::Unauthorized);
    }
    input.email = input.email.trim().to_lowercase();
    rate(
        &s,
        hash(&format!("{}:{}", input.practice_id, input.email)),
        10,
    )
    .await?;
    let row:Option<(Uuid,Uuid,i64,String)>=sqlx::query_as("SELECT id,patient_id,version,password_hash FROM patient_portal_accounts WHERE tenant_id=$1 AND email=$2 AND status='active'").bind(input.practice_id).bind(&input.email).fetch_optional(db(&s)?).await?;
    // Initialize the dummy verifier for every login path, then perform one verification
    // whether or not an active account exists. No account-existence response is returned.
    static DUMMY: OnceLock<String> = OnceLock::new();
    let dummy = tokio::task::spawn_blocking(|| {
        DUMMY
            .get_or_init(|| {
                Argon2::default()
                    .hash_password(
                        b"dummy patient portal password",
                        &SaltString::generate(&mut OsRng),
                    )
                    .expect("fixed valid Argon2 parameters")
                    .to_string()
            })
            .clone()
    })
    .await
    .map_err(|_| Error::Unauthorized)?;
    let hashed = row.as_ref().map(|v| v.3.clone()).unwrap_or(dummy);
    let old_hash = hashed.clone();
    let good = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hashed).is_ok_and(|h| {
            Argon2::default()
                .verify_password(input.password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .map_err(|_| Error::Unauthorized)?;
    let (account, p, version, _) = row.filter(|_| good).ok_or(Error::Unauthorized)?;
    let mut tx = db(&s)?.begin().await?;
    let current:Option<String>=sqlx::query_scalar("SELECT password_hash FROM patient_portal_accounts WHERE tenant_id=$1 AND id=$2 AND status='active' AND version=$3 FOR SHARE").bind(input.practice_id).bind(account).bind(version).fetch_optional(&mut *tx).await?;
    if current.as_deref() != Some(&old_hash) {
        return Err(Error::Unauthorized);
    }
    let token = secret();
    sqlx::query("INSERT INTO patient_portal_sessions(token_hash,tenant_id,account_id,account_version,expires_at) VALUES($1,$2,$3,$4,now()+interval '2 hours')").bind(hash(&token)).bind(input.practice_id).bind(account).bind(version).execute(&mut *tx).await?;
    audit(
        &mut tx,
        input.practice_id,
        p,
        account,
        "patient",
        "login",
        account,
        None,
        json!({}),
    )
    .await?;
    tx.commit().await?;
    Ok((
        cookies(&s, &token, 7200)?,
        Json(json!({"authenticated":true})),
    ))
}
async fn logout(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
) -> Result<(HeaderMap, Json<Value>)> {
    let (mut tx, p) = patient(&s, &h, true).await?;
    sqlx::query("DELETE FROM patient_portal_sessions WHERE token_hash=$1")
        .bind(hash(&token(&h)?))
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        p.tenant,
        p.id,
        p.account,
        "patient",
        "logout",
        p.account,
        None,
        json!({}),
    )
    .await?;
    tx.commit().await?;
    Ok((cookies(&s, "", 0)?, Json(json!({"authenticated":false}))))
}
async fn dashboard(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let (mut tx, p) = patient(&s, &h, false).await?;
    let person:Value=sqlx::query_scalar("SELECT jsonb_build_object('given_name',given_name,'family_name',family_name) FROM patients WHERE tenant_id=$1 AND id=$2").bind(p.tenant).bind(p.id).fetch_one(&mut *tx).await?;
    let appointments:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'starts_at',starts_at,'ends_at',ends_at,'status',status,'facility',facility,'room',room) FROM appointments WHERE tenant_id=$1 AND patient_id=$2 ORDER BY starts_at DESC,id LIMIT 101").bind(p.tenant).bind(p.id).fetch_all(&mut *tx).await?;
    let releases:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('visit_id',r.visit_id,'avs_version',r.avs_version,'published_at',r.updated_at) FROM patient_portal_publications r JOIN visits v ON v.tenant_id=r.tenant_id AND v.id=r.visit_id AND v.patient_id=r.patient_id AND v.status='signed' WHERE r.tenant_id=$1 AND r.patient_id=$2 AND r.visible ORDER BY r.updated_at DESC LIMIT 101").bind(p.tenant).bind(p.id).fetch_all(&mut *tx).await?;
    touch(&mut tx, &h).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"patient":person,"account_id":p.account,"appointments":appointments.iter().take(100).collect::<Vec<_>>(),"appointments_has_more":appointments.len()>100,"releases":releases.iter().take(100).collect::<Vec<_>>(),"releases_has_more":releases.len()>100}),
    ))
}
fn public_fields(value: &Value, keys: &[&str]) -> Value {
    let mut result = serde_json::Map::new();
    for key in keys {
        if let Some(value) = value.get(*key) {
            if value.is_string() || value.is_number() || value.is_boolean() || value.is_null() {
                result.insert((*key).to_string(), value.clone());
            }
        }
    }
    Value::Object(result)
}
fn public_snapshot(snapshot: &Value) -> Value {
    let mut result = json!({"visit":public_fields(&snapshot["visit"],&["starts_at","signed_at","facility","room","clinician_label"])});
    for (kind, keys) in [
        (
            "medications",
            &["title", "status", "dose", "route", "frequency"][..],
        ),
        (
            "allergies",
            &["title", "status", "reaction", "severity", "criticality"][..],
        ),
        (
            "problems",
            &["title", "status", "onset_date", "problem_type"][..],
        ),
        (
            "orders",
            &["title", "status", "category", "priority", "destination"][..],
        ),
    ] {
        result[kind] = json!(snapshot[kind]
            .as_array()
            .map(|rows| rows
                .iter()
                .take(100)
                .map(|row| public_fields(row, keys))
                .collect::<Vec<_>>())
            .unwrap_or_default());
    }
    result["vitals"] = if snapshot["vitals"].is_object() {
        public_fields(
            &snapshot["vitals"],
            &[
                "systolic_mm_hg",
                "diastolic_mm_hg",
                "heart_rate_bpm",
                "temperature_c",
                "oxygen_saturation_pct",
                "weight_kg",
                "height_cm",
            ],
        )
    } else {
        Value::Null
    };
    result
}
async fn avs(
    ExtractState(s): ExtractState<State>,
    Path(v): Path<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    let (mut tx, p) = patient(&s, &h, false).await?;
    // Whitelist only patient-facing AVS instructions and selected immutable snapshot fields.
    let mut value:Value=sqlx::query_scalar("SELECT jsonb_build_object('visit_id',r.visit_id,'version',r.version,'released_at',r.released_at,'instructions',r.content->'instructions','follow_up_instructions',r.content->'follow_up_instructions','snapshot',jsonb_build_object('visit',r.snapshot->'visit','medications',r.snapshot->'medications','allergies',r.snapshot->'allergies','problems',r.snapshot->'problems','vitals',r.snapshot->'vitals','orders',r.snapshot->'orders')) FROM patient_portal_publications p JOIN avs_releases r ON r.tenant_id=p.tenant_id AND r.visit_id=p.visit_id AND r.version=p.avs_version JOIN visits v ON v.tenant_id=p.tenant_id AND v.id=p.visit_id AND v.patient_id=p.patient_id AND v.status='signed' WHERE p.tenant_id=$1 AND p.patient_id=$2 AND p.visit_id=$3 AND p.visible FOR SHARE OF p").bind(p.tenant).bind(p.id).bind(v).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    value["snapshot"] = public_snapshot(&value["snapshot"]);
    audit(
        &mut tx,
        p.tenant,
        p.id,
        p.account,
        "patient",
        "avs_read",
        v,
        value["version"].as_i64(),
        json!({}),
    )
    .await?;
    touch(&mut tx, &h).await?;
    tx.commit().await?;
    Ok(Json(value))
}
async fn staff_access(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
) -> Result<Json<Value>> {
    let mut tx = db(&s)?.begin().await?;
    staff_patient(&mut tx, &a, p).await?;
    let account:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'email',email,'status',status,'version',version) FROM patient_portal_accounts WHERE tenant_id=$1 AND patient_id=$2").bind(a.tenant_id).bind(p).fetch_optional(&mut *tx).await?;
    let releases:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('visit_id',r.visit_id,'avs_version',r.version,'released_at',r.released_at,'instructions',r.content->'instructions','publication_version',COALESCE(p.version,0),'visible',COALESCE(p.visible AND p.avs_version=r.version,false),'pinned_avs_version',p.avs_version,'can_publish',v.clinician_id=$3) FROM avs_releases r JOIN visits v ON v.tenant_id=r.tenant_id AND v.id=r.visit_id LEFT JOIN patient_portal_publications p ON p.tenant_id=r.tenant_id AND p.visit_id=r.visit_id WHERE v.tenant_id=$1 AND v.patient_id=$2 AND v.status='signed' ORDER BY r.released_at DESC LIMIT 101").bind(a.tenant_id).bind(p).bind(a.sub).fetch_all(&mut *tx).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('action',action,'actor_kind',actor_kind,'actor_id',actor_id,'version',version,'created_at',created_at) FROM patient_portal_events WHERE tenant_id=$1 AND patient_id=$2 ORDER BY id DESC LIMIT 51").bind(a.tenant_id).bind(p).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"patient_id":p,"practice_id":a.tenant_id,"account":account,"version":account.as_ref().and_then(|v|v["version"].as_i64()).unwrap_or(0),"releases":releases.iter().take(100).collect::<Vec<_>>(),"releases_has_more":releases.len()>100,"events":events.iter().take(50).collect::<Vec<_>>(),"events_has_more":events.len()>50}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reason {
    reason: String,
}
async fn revoke(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    h: HeaderMap,
    Json(mut input): Json<Reason>,
) -> Result<Json<Value>> {
    origin(&s, &h)?;
    let version = expected(&h)?;
    text(&mut input.reason, 1000)?;
    let mut tx = db(&s)?.begin().await?;
    staff_patient(&mut tx, &a, p).await?;
    let row:Option<(Uuid,i64)>=sqlx::query_as("SELECT id,version FROM patient_portal_accounts WHERE tenant_id=$1 AND patient_id=$2 FOR UPDATE").bind(a.tenant_id).bind(p).fetch_optional(&mut *tx).await?;
    let (id, v) = row.ok_or(Error::NotFound)?;
    if v != version {
        return Err(Error::Conflict(
            "portal access changed; reload before revoking",
        ));
    }
    sqlx::query("UPDATE patient_portal_accounts SET status='revoked',version=version+1,password_hash=NULL WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM patient_portal_sessions WHERE tenant_id=$1 AND account_id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE patient_portal_invites SET revoked_at=now() WHERE tenant_id=$1 AND account_id=$2 AND used_at IS NULL AND revoked_at IS NULL").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
    audit(
        &mut tx,
        a.tenant_id,
        p,
        a.sub,
        "staff",
        "revoke",
        id,
        Some(v + 1),
        json!({"reason":input.reason}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"status":"revoked","version":v+1})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Publication {
    avs_version: i64,
    visible: bool,
    reason: String,
}
async fn publish(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, v)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(mut input): Json<Publication>,
) -> Result<Json<Value>> {
    a.clinical()?;
    origin(&s, &h)?;
    let expected = expected(&h)?;
    text(&mut input.reason, 1000)?;
    let mut tx = db(&s)?.begin().await?;
    let clinician:Uuid=sqlx::query_scalar("SELECT clinician_id FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 AND status='signed' FOR UPDATE").bind(a.tenant_id).bind(p).bind(v).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    if clinician != a.sub {
        return Err(Error::Forbidden);
    }
    let current:Option<i64>=sqlx::query_scalar("SELECT version FROM patient_portal_publications WHERE tenant_id=$1 AND visit_id=$2 FOR UPDATE").bind(a.tenant_id).bind(v).fetch_optional(&mut *tx).await?;
    if current.unwrap_or(0) != expected {
        return Err(Error::Conflict(
            "portal release changed; reload before publishing",
        ));
    }
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM avs_releases WHERE tenant_id=$1 AND visit_id=$2 AND version=$3)").bind(a.tenant_id).bind(v).bind(input.avs_version).fetch_one(&mut *tx).await?;
    if !exists {
        return Err(Error::NotFound);
    }
    sqlx::query("INSERT INTO patient_portal_publications(tenant_id,patient_id,visit_id,avs_version,version,visible,released_by) VALUES($1,$2,$3,$4,1,$5,$6) ON CONFLICT(tenant_id,visit_id) DO UPDATE SET avs_version=$4,visible=$5,released_by=$6,version=patient_portal_publications.version+1,updated_at=now()").bind(a.tenant_id).bind(p).bind(v).bind(input.avs_version).bind(input.visible).bind(a.sub).execute(&mut *tx).await?;
    audit(
        &mut tx,
        a.tenant_id,
        p,
        a.sub,
        "staff",
        if input.visible {
            "publish_avs"
        } else {
            "withdraw_avs"
        },
        v,
        Some(expected + 1),
        json!({"avs_version":input.avs_version,"reason":input.reason}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"version":expected+1,"avs_version":input.avs_version,"visible":input.visible}),
    ))
}
async fn threads(tx: &mut Tx<'_>, tenant: Uuid, patient: Option<Uuid>) -> Result<Value> {
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',t.id,'patient_id',t.patient_id,'patient_name',p.family_name||', '||p.given_name,'subject',t.subject,'kind',t.kind,'appointment_id',t.appointment_id,'status',t.status,'version',t.version,'updated_at',t.updated_at) FROM patient_portal_threads t JOIN patients p ON p.tenant_id=t.tenant_id AND p.id=t.patient_id WHERE t.tenant_id=$1 AND ($2::uuid IS NULL OR t.patient_id=$2) ORDER BY t.updated_at DESC,t.id LIMIT 101").bind(tenant).bind(patient).fetch_all(&mut **tx).await?;
    Ok(json!({"items":rows.iter().take(100).collect::<Vec<_>>(),"has_more":rows.len()>100}))
}
async fn thread(
    tx: &mut Tx<'_>,
    tenant: Uuid,
    id: Uuid,
    patient: Option<Uuid>,
    lock: bool,
) -> Result<Value> {
    let sql = if lock {
        "SELECT to_jsonb(t)-'tenant_id'-'request_id'-'request_hash'-'account_id' FROM patient_portal_threads t WHERE tenant_id=$1 AND id=$2 AND ($3::uuid IS NULL OR patient_id=$3) FOR UPDATE"
    } else {
        "SELECT to_jsonb(t)-'tenant_id'-'request_id'-'request_hash'-'account_id' FROM patient_portal_threads t WHERE tenant_id=$1 AND id=$2 AND ($3::uuid IS NULL OR patient_id=$3) FOR SHARE"
    };
    sqlx::query_scalar(sql)
        .bind(tenant)
        .bind(id)
        .bind(patient)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn messages(tx: &mut Tx<'_>, tenant: Uuid, id: Uuid, t: Value) -> Result<Value> {
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'version',thread_version,'author',author_kind,'body',body,'created_at',created_at) FROM (SELECT * FROM patient_portal_messages WHERE tenant_id=$1 AND thread_id=$2 ORDER BY thread_version DESC LIMIT 201) m ORDER BY thread_version").bind(tenant).bind(id).fetch_all(&mut **tx).await?;
    Ok(
        json!({"thread":t,"messages":rows.iter().skip(if rows.len()>200{1}else{0}).collect::<Vec<_>>(),"messages_has_more":rows.len()>200}),
    )
}
async fn patient_threads(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    let (mut tx, p) = patient(&s, &h, false).await?;
    let value = threads(&mut tx, p.tenant, Some(p.id)).await?;
    touch(&mut tx, &h).await?;
    tx.commit().await?;
    Ok(Json(value))
}
async fn staff_inbox(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.scheduling()?;
    let mut tx = db(&s)?.begin().await?;
    let value = threads(&mut tx, a.tenant_id, None).await?;
    tx.commit().await?;
    Ok(Json(value))
}
async fn patient_thread(
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    let (mut tx, p) = patient(&s, &h, false).await?;
    let t = thread(&mut tx, p.tenant, id, Some(p.id), false).await?;
    let value = messages(&mut tx, p.tenant, id, t).await?;
    audit(
        &mut tx,
        p.tenant,
        p.id,
        p.account,
        "patient",
        "thread_read",
        id,
        None,
        json!({}),
    )
    .await?;
    touch(&mut tx, &h).await?;
    tx.commit().await?;
    Ok(Json(value))
}
async fn staff_thread(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    let mut tx = db(&s)?.begin().await?;
    let t = thread(&mut tx, a.tenant_id, id, None, false).await?;
    let p = Uuid::parse_str(t["patient_id"].as_str().ok_or(Error::NotFound)?)
        .map_err(|_| Error::NotFound)?;
    let value = messages(&mut tx, a.tenant_id, id, t).await?;
    audit(
        &mut tx,
        a.tenant_id,
        p,
        a.sub,
        "staff",
        "thread_read",
        id,
        None,
        json!({}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(value))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewThread {
    request_id: Uuid,
    kind: String,
    appointment_id: Option<Uuid>,
    subject: String,
    body: String,
}
async fn patient_create(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(mut input): Json<NewThread>,
) -> Result<Json<Value>> {
    text(&mut input.subject, 160)?;
    text(&mut input.body, 4000)?;
    if !matches!(input.kind.as_str(), "message" | "appointment_change")
        || (input.kind == "appointment_change") != input.appointment_id.is_some()
    {
        return Err(Error::Invalid("invalid message type or appointment"));
    }
    let (mut tx, p) = patient(&s, &h, true).await?;
    let digest =
        hash(&json!([input.kind, input.appointment_id, input.subject, input.body]).to_string());
    // Account lock serializes create retries across sessions without taking a lock upgrade.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,45))")
        .bind(format!("{}:{}", p.tenant, p.account))
        .execute(&mut *tx)
        .await?;
    let prior:Option<(Uuid,String)>=sqlx::query_as("SELECT id,request_hash FROM patient_portal_threads WHERE tenant_id=$1 AND account_id=$2 AND request_id=$3").bind(p.tenant).bind(p.account).bind(input.request_id).fetch_optional(&mut *tx).await?;
    if let Some((id, old)) = prior {
        if old != digest {
            return Err(Error::Conflict(
                "request ID already used with different content",
            ));
        }
        let t = thread(&mut tx, p.tenant, id, Some(p.id), false).await?;
        tx.commit().await?;
        return Ok(Json(t));
    }
    if let Some(appointment) = input.appointment_id {
        let status: String = sqlx::query_scalar("SELECT status FROM appointments WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR SHARE")
            .bind(p.tenant).bind(p.id).bind(appointment).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        // Booking changes remain staff-reviewed. Checked-in visits can still be
        // cancelled by scheduling; in-progress and terminal visits cannot change.
        if !matches!(status.as_str(), "booked" | "checked_in") {
            return Err(Error::Conflict(
                "this appointment no longer accepts change requests; contact your practice",
            ));
        }
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO patient_portal_threads(tenant_id,id,patient_id,account_id,kind,appointment_id,subject,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(p.tenant).bind(id).bind(p.id).bind(p.account).bind(&input.kind).bind(input.appointment_id).bind(&input.subject).bind(input.request_id).bind(digest).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO patient_portal_messages(tenant_id,id,thread_id,thread_version,author_kind,author_id,body,request_id) VALUES($1,$2,$3,1,'patient',$4,$5,$6)").bind(p.tenant).bind(Uuid::new_v4()).bind(id).bind(p.account).bind(input.body).bind(input.request_id).execute(&mut *tx).await?;
    audit(
        &mut tx,
        p.tenant,
        p.id,
        p.account,
        "patient",
        "thread_create",
        id,
        Some(1),
        json!({"kind":input.kind}),
    )
    .await?;
    touch(&mut tx, &h).await?;
    let t = thread(&mut tx, p.tenant, id, Some(p.id), false).await?;
    tx.commit().await?;
    Ok(Json(t))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    request_id: Uuid,
    body: String,
}
#[allow(clippy::too_many_arguments)]
async fn reply(
    tx: &mut Tx<'_>,
    tenant: Uuid,
    id: Uuid,
    patient: Option<Uuid>,
    actor: Uuid,
    kind: &str,
    v: i64,
    mut input: Reply,
) -> Result<Value> {
    text(&mut input.body, 4000)?;
    let mut t = thread(tx, tenant, id, patient, true).await?;
    let prior:Option<(String,String,Uuid)>=sqlx::query_as("SELECT body,author_kind,author_id FROM patient_portal_messages WHERE tenant_id=$1 AND thread_id=$2 AND request_id=$3").bind(tenant).bind(id).bind(input.request_id).fetch_optional(&mut **tx).await?;
    if let Some((body, old_kind, old_actor)) = prior {
        if body != input.body || old_kind != kind || old_actor != actor {
            return Err(Error::Conflict(
                "request ID already used with different content",
            ));
        }
        return Ok(t);
    }
    if t["version"].as_i64() != Some(v) {
        return Err(Error::Conflict(
            "conversation changed; reload before replying",
        ));
    }
    if t["status"] != "open" {
        return Err(Error::Conflict(
            "conversation is closed; retain your draft and start a new message",
        ));
    }
    sqlx::query("INSERT INTO patient_portal_messages(tenant_id,id,thread_id,thread_version,author_kind,author_id,body,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(tenant).bind(Uuid::new_v4()).bind(id).bind(v+1).bind(kind).bind(actor).bind(input.body).bind(input.request_id).execute(&mut **tx).await?;
    sqlx::query("UPDATE patient_portal_threads SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).execute(&mut **tx).await?;
    let p = Uuid::parse_str(t["patient_id"].as_str().ok_or(Error::NotFound)?)
        .map_err(|_| Error::NotFound)?;
    audit(
        tx,
        tenant,
        p,
        actor,
        kind,
        "reply",
        id,
        Some(v + 1),
        json!({}),
    )
    .await?;
    t["version"] = json!(v + 1);
    Ok(t)
}
async fn patient_reply(
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(input): Json<Reply>,
) -> Result<Json<Value>> {
    let v = expected(&h)?;
    let (mut tx, p) = patient(&s, &h, true).await?;
    let value = reply(
        &mut tx,
        p.tenant,
        id,
        Some(p.id),
        p.account,
        "patient",
        v,
        input,
    )
    .await?;
    touch(&mut tx, &h).await?;
    tx.commit().await?;
    Ok(Json(value))
}
async fn staff_reply(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(input): Json<Reply>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    origin(&s, &h)?;
    let v = expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    let value = reply(&mut tx, a.tenant_id, id, None, a.sub, "staff", v, input).await?;
    tx.commit().await?;
    Ok(Json(value))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ThreadStatus {
    status: String,
    reason: String,
}
async fn staff_status(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(mut input): Json<ThreadStatus>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    origin(&s, &h)?;
    let v = expected(&h)?;
    text(&mut input.reason, 1000)?;
    if !matches!(input.status.as_str(), "open" | "closed") {
        return Err(Error::Invalid("invalid conversation status"));
    }
    let mut tx = db(&s)?.begin().await?;
    let t = thread(&mut tx, a.tenant_id, id, None, true).await?;
    if t["version"].as_i64() != Some(v) {
        return Err(Error::Conflict(
            "conversation changed; reload before updating",
        ));
    }
    sqlx::query("UPDATE patient_portal_threads SET status=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(&input.status).execute(&mut *tx).await?;
    let p = Uuid::parse_str(t["patient_id"].as_str().ok_or(Error::NotFound)?)
        .map_err(|_| Error::NotFound)?;
    audit(
        &mut tx,
        a.tenant_id,
        p,
        a.sub,
        "staff",
        "thread_status",
        id,
        Some(v + 1),
        json!({"status":input.status,"reason":input.reason}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id,"status":input.status,"version":v+1})))
}
