// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! OAuth2 authorization-code + S256 PKCE, confidential clients, scoped opaque
//! tokens, refresh rotation/replay revocation, and local consent/revocation.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::{header, HeaderMap, Method, StatusCode},
    response::Redirect,
    routing::{get, post},
    Form, Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use subtle::ConstantTimeEq;
use uuid::Uuid;

type CodeRow = (Uuid, String, String, DateTime<Utc>, Option<DateTime<Utc>>);
type GrantListRow = (Uuid, String, Uuid, String, Option<DateTime<Utc>>);

pub const SCOPES: &[&str] = &[
    "clinical.read",
    "clinical.write",
    "billing.read",
    "billing.write",
    "events.read",
    "migration.manage",
    "offline_access",
];
pub fn random(prefix: &str) -> String {
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode(raw))
}
pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn scopes(value: &str) -> Result<String> {
    let set: std::collections::BTreeSet<_> = value.split_whitespace().collect();
    if set.is_empty() || set.iter().any(|v| !SCOPES.contains(v)) {
        return Err(Error::OAuth("invalid_scope"));
    }
    Ok(set.into_iter().collect::<Vec<_>>().join(" "))
}
fn subset(requested: &str, allowed: &str) -> bool {
    requested
        .split_whitespace()
        .all(|s| allowed.split_whitespace().any(|v| v == s))
}
fn owner(a: &Actor) -> Result<()> {
    if matches!(a.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
fn browser(s: &State) -> Result<&crate::browser::BrowserAuth> {
    s.browser.as_deref().ok_or(Error::NotFound)
}
fn valid_redirect(value: &str) -> bool {
    let Ok(u) = url::Url::parse(value) else {
        return false;
    };
    let local = matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    (u.scheme() == "https" || (u.scheme() == "http" && local))
        && u.host_str().is_some()
        && u.username().is_empty()
        && u.password().is_none()
        && u.fragment().is_none()
        && u.query().is_none()
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/.well-known/oauth-authorization-server", get(metadata))
        .route("/oauth/authorize", get(authorize))
        .route("/oauth/token", post(token))
        .route("/oauth/revoke", post(revoke_token))
        .route("/oauth/requests/{id}", get(consent))
        .route("/oauth/requests/{id}/decision", post(decide))
        .route("/api/v1/oauth/clients", get(clients).post(register))
        .route("/api/v1/oauth/clients/{id}/disable", post(disable_client))
        .route("/api/v1/oauth/grants", get(grants))
        .route("/api/v1/oauth/grants/{id}/revoke", post(revoke_grant))
        .route("/api/v1/connection", get(connection))
}

async fn metadata(ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    let origin = browser(&s)?.origin();
    Ok(Json(
        json!({"issuer":origin,"authorization_endpoint":format!("{origin}/oauth/authorize"),"token_endpoint":format!("{origin}/oauth/token"),
        "revocation_endpoint":format!("{origin}/oauth/revoke"),"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],
        "token_endpoint_auth_methods_supported":["client_secret_basic"],"revocation_endpoint_auth_methods_supported":["client_secret_basic"],
        "code_challenge_methods_supported":["S256"],"authorization_response_iss_parameter_supported":true,"scopes_supported":SCOPES}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewClient {
    name: String,
    redirect_uri: String,
    scope: String,
}
async fn register(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(input): Json<NewClient>,
) -> Result<Json<Value>> {
    owner(&a)?;
    crate::model::text(&input.name, 120)?;
    if !valid_redirect(&input.redirect_uri) {
        return Err(Error::Invalid(
            "an exact HTTPS callback (or loopback development callback) is required",
        ));
    }
    let scope = scopes(&input.scope)?;
    let id = Uuid::new_v4();
    let secret = random("sce_cs_");
    let mut tx = browser(&s)?.db.begin().await?;
    sqlx::query("INSERT INTO oauth_clients (id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES ($1,$2,$3,$4,$5,$6)")
        .bind(id).bind(a.tenant_id).bind(input.name.trim()).bind(hash(&secret)).bind(&input.redirect_uri).bind(&scope).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "oauth.client_register", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"client_id":id,"client_secret":secret,"redirect_uri":input.redirect_uri,"scope":scope,"issuer":browser(&s)?.origin()}),
    ))
}
async fn clients(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    owner(&a)?;
    let rows:Vec<(Uuid,String,String,String,bool)>=sqlx::query_as("SELECT id,name,redirect_uri,allowed_scopes,disabled FROM oauth_clients WHERE tenant_id=$1 ORDER BY created_at")
        .bind(a.tenant_id).fetch_all(&browser(&s)?.db).await?;
    Ok(Json(
        json!({"items":rows.into_iter().map(|(id,name,uri,scope,disabled)|json!({"id":id,"name":name,"redirect_uri":uri,"scope":scope,"disabled":disabled})).collect::<Vec<_>>()}),
    ))
}
async fn disable_client(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    owner(&a)?;
    let mut tx = browser(&s)?.db.begin().await?;
    let found: Option<Uuid> = sqlx::query_scalar(
        "UPDATE oauth_clients SET disabled=true WHERE id=$1 AND tenant_id=$2 RETURNING id",
    )
    .bind(id)
    .bind(a.tenant_id)
    .fetch_optional(&mut *tx)
    .await?;
    if found.is_none() {
        return Err(Error::NotFound);
    }
    sqlx::query("UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE client_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    crate::postgres::audit(&mut tx, &a, "oauth.client_disable", id).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct Authorize {
    response_type: String,
    client_id: Uuid,
    redirect_uri: String,
    state: String,
    scope: String,
    code_challenge: String,
    code_challenge_method: String,
}
async fn authorize(
    ExtractState(s): ExtractState<State>,
    Query(q): Query<Authorize>,
) -> Result<Redirect> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT redirect_uri,allowed_scopes FROM oauth_clients WHERE id=$1 AND NOT disabled",
    )
    .bind(q.client_id)
    .fetch_optional(&browser(&s)?.db)
    .await?;
    let (redirect, allowed) = row.ok_or(Error::OAuth("invalid_request"))?;
    // Never redirect an error to an unvalidated caller-provided URI.
    if q.redirect_uri != redirect
        || q.response_type != "code"
        || q.code_challenge_method != "S256"
        || q.code_challenge.len() != 43
        || URL_SAFE_NO_PAD.decode(&q.code_challenge).is_err()
        || q.state.len() < 16
        || q.state.len() > 512
    {
        return Err(Error::OAuth("invalid_request"));
    }
    let scope = scopes(&q.scope)?;
    if !subset(&scope, &allowed) {
        return Err(Error::OAuth("invalid_scope"));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO oauth_requests (id,client_id,redirect_uri,state,challenge,scope,expires_at) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')")
        .bind(id).bind(q.client_id).bind(redirect).bind(q.state).bind(q.code_challenge).bind(scope).execute(&browser(&s)?.db).await?;
    Ok(Redirect::to(&format!("/?oauth_request={id}")))
}

#[derive(sqlx::FromRow)]
struct RequestRow {
    client_id: Uuid,
    redirect_uri: String,
    state: String,
    challenge: String,
    scope: String,
    tenant_id: Uuid,
    name: String,
}
async fn request(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<RequestRow> {
    sqlx::query_as("SELECT r.client_id,r.redirect_uri,r.state,r.challenge,r.scope,c.tenant_id,c.name FROM oauth_requests r JOIN oauth_clients c ON c.id=r.client_id WHERE r.id=$1 AND r.expires_at>now() AND r.decided_at IS NULL AND NOT c.disabled FOR UPDATE OF r")
        .bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::OAuth("invalid_request"))
}
async fn consent(
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    let a = browser(&s)?.authenticate(&h, false).await?;
    let mut tx = browser(&s)?.db.begin().await?;
    let row = request(&mut tx, id).await?;
    if a.tenant_id != row.tenant_id {
        return Err(Error::Forbidden);
    }
    if row
        .scope
        .split_whitespace()
        .any(|x| x == "migration.manage")
    {
        owner(&a)?;
    }
    Ok(Json(
        json!({"id":id,"name":row.name,"scope":row.scope,"redirect_uri":row.redirect_uri,"tenant_id":a.tenant_id}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    approved: bool,
}
async fn decide(
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(input): Json<Decision>,
) -> Result<Json<Value>> {
    let a = browser(&s)?.authenticate(&h, true).await?;
    let mut tx = browser(&s)?.db.begin().await?;
    let row = request(&mut tx, id).await?;
    if a.tenant_id != row.tenant_id {
        return Err(Error::Forbidden);
    }
    if row
        .scope
        .split_whitespace()
        .any(|x| x == "migration.manage")
    {
        owner(&a)?;
    }
    let mut redirect =
        url::Url::parse(&row.redirect_uri).map_err(|_| Error::OAuth("invalid_request"))?;
    if input.approved {
        let grant = Uuid::new_v4();
        let code = random("sce_code_");
        sqlx::query("INSERT INTO oauth_grants (id,client_id,tenant_id,user_id,scope) VALUES ($1,$2,$3,$4,$5)").bind(grant).bind(row.client_id).bind(a.tenant_id).bind(a.sub).bind(&row.scope).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO oauth_codes (hash,grant_id,redirect_uri,challenge,expires_at) VALUES ($1,$2,$3,$4,now()+interval '60 seconds')")
            .bind(hash(&code)).bind(grant).bind(&row.redirect_uri).bind(row.challenge).execute(&mut *tx).await?;
        redirect.query_pairs_mut().append_pair("code", &code);
        crate::postgres::audit(&mut tx, &a, "oauth.consent", grant).await?;
    } else {
        redirect
            .query_pairs_mut()
            .append_pair("error", "access_denied");
    }
    sqlx::query("UPDATE oauth_requests SET decided_at=now() WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    redirect
        .query_pairs_mut()
        .append_pair("state", &row.state)
        .append_pair("iss", browser(&s)?.origin());
    tx.commit().await?;
    Ok(Json(json!({"redirect_uri":redirect.as_str()})))
}

async fn client(s: &State, h: &HeaderMap) -> Result<Uuid> {
    let raw = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Basic "))
        .ok_or(Error::OAuth("invalid_client"))?;
    if raw.len() > 1024 {
        return Err(Error::OAuth("invalid_client"));
    }
    let bytes = STANDARD
        .decode(raw)
        .map_err(|_| Error::OAuth("invalid_client"))?;
    let text = String::from_utf8(bytes).map_err(|_| Error::OAuth("invalid_client"))?;
    let (id, secret) = text.split_once(':').ok_or(Error::OAuth("invalid_client"))?;
    let id: Uuid = id.parse().map_err(|_| Error::OAuth("invalid_client"))?;
    let stored: Option<String> =
        sqlx::query_scalar("SELECT secret_hash FROM oauth_clients WHERE id=$1 AND NOT disabled")
            .bind(id)
            .fetch_optional(&browser(s)?.db)
            .await?;
    let expected = stored.ok_or(Error::OAuth("invalid_client"))?;
    if !bool::from(hash(secret).as_bytes().ct_eq(expected.as_bytes())) {
        return Err(Error::OAuth("invalid_client"));
    }
    Ok(id)
}

#[derive(Deserialize)]
pub struct TokenRequest {
    grant_type: String,
    code: Option<String>,
    redirect_uri: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
    scope: Option<String>,
}
#[derive(sqlx::FromRow)]
struct Grant {
    id: Uuid,
    user_id: Uuid,
    tenant_id: Uuid,
    scope: String,
    role: String,
}
async fn live_grant(tx: &mut Transaction<'_, Postgres>, id: Uuid, client: Uuid) -> Result<Grant> {
    sqlx::query_as("SELECT g.id,g.user_id,g.tenant_id,g.scope,u.role FROM oauth_grants g JOIN browser_users u ON u.id=g.user_id AND u.tenant_id=g.tenant_id WHERE g.id=$1 AND g.client_id=$2 AND g.revoked_at IS NULL AND NOT u.disabled FOR UPDATE OF g")
        .bind(id).bind(client).fetch_optional(&mut **tx).await?.ok_or(Error::OAuth("invalid_grant"))
}
async fn revoke(tx: &mut Transaction<'_, Postgres>, grant: Uuid) -> Result<()> {
    sqlx::query("UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1")
        .bind(grant)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn token(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Form(q): Form<TokenRequest>,
) -> Result<Json<Value>> {
    let cid = client(&s, &h).await?;
    let mut tx = browser(&s)?.db.begin().await?;
    let grant = match q.grant_type.as_str() {
        "authorization_code" => {
            let code = q.code.ok_or(Error::OAuth("invalid_grant"))?;
            let row:Option<CodeRow>=sqlx::query_as("SELECT c.grant_id,c.redirect_uri,c.challenge,c.expires_at,c.used_at FROM oauth_codes c JOIN oauth_grants g ON g.id=c.grant_id WHERE c.hash=$1 AND g.client_id=$2 FOR UPDATE OF c")
                .bind(hash(&code)).bind(cid).fetch_optional(&mut *tx).await?;
            let (id, redirect, pkce, expires, used) = row.ok_or(Error::OAuth("invalid_grant"))?;
            let verifier = q.code_verifier.ok_or(Error::OAuth("invalid_grant"))?;
            if !(43..=128).contains(&verifier.len())
                || !verifier
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-._~".contains(&c))
                || q.redirect_uri.as_deref() != Some(redirect.as_str())
                || !bool::from(challenge(&verifier).as_bytes().ct_eq(pkce.as_bytes()))
            {
                return Err(Error::OAuth("invalid_grant"));
            }
            if used.is_some() {
                revoke(&mut tx, id).await?;
                tx.commit().await?;
                return Err(Error::OAuth("invalid_grant"));
            }
            if expires <= Utc::now() {
                return Err(Error::OAuth("invalid_grant"));
            }
            let grant = live_grant(&mut tx, id, cid).await?;
            sqlx::query("UPDATE oauth_codes SET used_at=now() WHERE hash=$1")
                .bind(hash(&code))
                .execute(&mut *tx)
                .await?;
            grant
        }
        "refresh_token" => {
            let raw = q.refresh_token.ok_or(Error::OAuth("invalid_grant"))?;
            let row:Option<(Uuid,DateTime<Utc>,Option<DateTime<Utc>>)>=sqlx::query_as("SELECT t.grant_id,t.expires_at,t.used_at FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.hash=$1 AND t.kind='refresh' AND g.client_id=$2 FOR UPDATE OF t")
                .bind(hash(&raw)).bind(cid).fetch_optional(&mut *tx).await?;
            let (id, expiry, used) = row.ok_or(Error::OAuth("invalid_grant"))?;
            if used.is_some() {
                revoke(&mut tx, id).await?;
                tx.commit().await?;
                return Err(Error::OAuth("invalid_grant"));
            }
            if expiry <= Utc::now() {
                return Err(Error::OAuth("invalid_grant"));
            }
            let mut g = live_grant(&mut tx, id, cid).await?;
            if let Some(scope) = q.scope {
                let narrowed = scopes(&scope)?;
                if !subset(&narrowed, &g.scope) {
                    return Err(Error::OAuth("invalid_scope"));
                }
                g.scope = narrowed;
                sqlx::query("UPDATE oauth_grants SET scope=$2 WHERE id=$1")
                    .bind(id)
                    .bind(&g.scope)
                    .execute(&mut *tx)
                    .await?;
            }
            sqlx::query("UPDATE oauth_tokens SET used_at=now() WHERE hash=$1")
                .bind(hash(&raw))
                .execute(&mut *tx)
                .await?;
            g
        }
        _ => return Err(Error::OAuth("unsupported_grant_type")),
    };
    let access = random("sce_at_");
    let refresh = random("sce_rt_");
    sqlx::query("INSERT INTO oauth_tokens (hash,grant_id,kind,expires_at) VALUES ($1,$2,'access',now()+interval '5 minutes')").bind(hash(&access)).bind(grant.id).execute(&mut *tx).await?;
    let offline = grant
        .scope
        .split_whitespace()
        .any(|v| v == "offline_access");
    if offline {
        sqlx::query("INSERT INTO oauth_tokens (hash,grant_id,kind,expires_at) VALUES ($1,$2,'refresh',now()+interval '30 days')").bind(hash(&refresh)).bind(grant.id).execute(&mut *tx).await?;
    }
    let a = grant_actor(&grant)?;
    crate::postgres::audit(&mut tx, &a, "oauth.token_issue", grant.id).await?;
    tx.commit().await?;
    let mut response =
        json!({"access_token":access,"token_type":"Bearer","expires_in":300,"scope":grant.scope});
    if offline {
        response["refresh_token"] = json!(refresh);
    }
    Ok(Json(response))
}
fn grant_actor(g: &Grant) -> Result<Actor> {
    let now = Utc::now().timestamp();
    Ok(Actor {
        sub: g.user_id,
        tenant_id: g.tenant_id,
        role: serde_json::from_value(json!(g.role)).map_err(|_| Error::Unauthorized)?,
        patient_id: None,
        iss: "suncharts-ehr-oauth".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 300,
    })
}

pub async fn authenticate(s: &State, raw: &str, method: &Method, path: &str) -> Result<Actor> {
    let g:Option<Grant>=sqlx::query_as("SELECT g.id,g.user_id,g.tenant_id,g.scope,u.role FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id JOIN oauth_clients c ON c.id=g.client_id JOIN browser_users u ON u.id=g.user_id AND u.tenant_id=g.tenant_id WHERE t.hash=$1 AND t.kind='access' AND t.expires_at>now() AND g.revoked_at IS NULL AND NOT c.disabled AND NOT u.disabled")
        .bind(hash(raw)).fetch_optional(&browser(s)?.db).await?;
    let g = g.ok_or(Error::Unauthorized)?;
    let read = matches!(*method, Method::GET | Method::HEAD);
    let needed = if path.starts_with("/api/v1/migrations") {
        "migration.manage"
    } else if path.starts_with("/api/v1/events") {
        "events.read"
    } else if path == "/fhir/Coverage" || path.starts_with("/fhir/Coverage/") {
        "billing.read"
    } else if path.split('/').any(|segment| {
        ["billing", "coverages", "billing-mapping", "claim-mapping"].contains(&segment)
    }) {
        if read {
            "billing.read"
        } else {
            "billing.write"
        }
    } else if read {
        "clinical.read"
    } else {
        "clinical.write"
    };
    if path.starts_with("/api/v1/oauth") || !g.scope.split_whitespace().any(|v| v == needed) {
        return Err(Error::Forbidden);
    }
    grant_actor(&g)
}
#[derive(Deserialize)]
pub struct Revoke {
    token: String,
    #[serde(rename = "token_type_hint")]
    _hint: Option<String>,
}
async fn revoke_token(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Form(q): Form<Revoke>,
) -> Result<StatusCode> {
    let cid = client(&s, &h).await?;
    let mut tx = browser(&s)?.db.begin().await?;
    let grant:Option<Uuid>=sqlx::query_scalar("SELECT g.id FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.hash=$1 AND g.client_id=$2").bind(hash(&q.token)).bind(cid).fetch_optional(&mut *tx).await?;
    if let Some(id) = grant {
        let g = live_grant(&mut tx, id, cid).await;
        if let Ok(g) = g {
            revoke(&mut tx, id).await?;
            crate::postgres::audit(&mut tx, &grant_actor(&g)?, "oauth.revoke", id).await?;
        }
    }
    tx.commit().await?;
    Ok(StatusCode::OK)
}
async fn grants(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let rows:Vec<GrantListRow>=sqlx::query_as("SELECT g.id,c.name,g.user_id,g.scope,g.revoked_at FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE g.tenant_id=$1 AND (g.user_id=$2 OR $3) ORDER BY g.created_at DESC LIMIT 100")
        .bind(a.tenant_id).bind(a.sub).bind(matches!(a.role,Role::Owner)).fetch_all(&browser(&s)?.db).await?;
    Ok(Json(
        json!({"items":rows.into_iter().map(|(id,name,user,scope,revoked)|json!({"id":id,"name":name,"user_id":user,"scope":scope,"revoked_at":revoked})).collect::<Vec<_>>()}),
    ))
}
async fn revoke_grant(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    a.staff()?;
    let mut tx = browser(&s)?.db.begin().await?;
    let found:Option<Uuid>=sqlx::query_scalar("SELECT id FROM oauth_grants WHERE id=$1 AND tenant_id=$2 AND (user_id=$3 OR $4) FOR UPDATE")
        .bind(id).bind(a.tenant_id).bind(a.sub).bind(matches!(a.role,Role::Owner)).fetch_optional(&mut *tx).await?;
    if found.is_none() {
        return Err(Error::NotFound);
    }
    revoke(&mut tx, id).await?;
    crate::postgres::audit(&mut tx, &a, "oauth.revoke", id).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn connection(a: Actor) -> Result<Json<Value>> {
    a.staff()?;
    Ok(Json(
        json!({"engine":"suncharts_ehr","tenant_id":a.tenant_id,"user_id":a.sub,"role":a.role,"api_version":"1"}),
    ))
}
