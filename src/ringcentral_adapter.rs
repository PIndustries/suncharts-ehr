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
            "/api/v1/integrations/ringcentral/{id}/outbound",
            get(list_outbound).post(create_outbound),
        )
        .route(
            "/api/v1/integrations/ringcentral/{id}/outbound/{draft_id}",
            get(outbound_detail),
        )
        .route(
            "/api/v1/integrations/ringcentral/{id}/outbound/{draft_id}/approve",
            post(approve_outbound),
        )
        .route(
            "/api/v1/integrations/ringcentral/{id}/outbound/{draft_id}/send",
            post(send_outbound),
        )
        .route(
            "/api/v1/integrations/ringcentral/{id}/outbound/{draft_id}/refresh",
            post(refresh_outbound),
        )
        .route(
            "/api/v1/integrations/ringcentral/webhooks/{hook_key}",
            post(webhook),
        )
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OutboundDraftInput {
    pub kind: String,
    pub recipient: String,
    #[serde(default)]
    pub sender: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub cover_page_text: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub document_base64: Option<String>,
    #[serde(default)]
    pub play_prompt: Option<bool>,
}

fn e164(value: &str) -> bool {
    let bytes = value.as_bytes();
    (9..=16).contains(&bytes.len())
        && bytes.first() == Some(&b'+')
        && bytes[1..].iter().all(u8::is_ascii_digit)
}

fn draft_role(actor: &Actor) -> Result<()> {
    if matches!(
        actor.role,
        Role::Owner | Role::Clinician | Role::FrontDesk | Role::PartnerSupport
    ) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

fn send_role(actor: &Actor, kind: &str) -> Result<()> {
    if matches!(actor.role, Role::Owner | Role::Clinician)
        || (matches!(actor.role, Role::FrontDesk) && matches!(kind, "sms" | "ringout"))
    {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

fn validate_outbound(input: &OutboundDraftInput) -> Result<()> {
    if !e164(input.recipient.trim()) {
        return Err(Error::Invalid("recipient must be an E.164 phone number"));
    }
    match input.kind.as_str() {
        "sms" => {
            let sender = input.sender.as_deref().unwrap_or("").trim();
            let text = input.text.as_deref().unwrap_or("");
            if !e164(sender) || text.is_empty() || text.encode_utf16().count() > 1000 {
                return Err(Error::Invalid("invalid RingCentral SMS draft"));
            }
            if input.document_base64.is_some()
                || input.cover_page_text.is_some()
                || input.filename.is_some()
                || input.content_type.is_some()
                || input.play_prompt.is_some()
            {
                return Err(Error::Invalid("invalid RingCentral SMS draft"));
            }
        }
        "fax" => {
            let filename = input.filename.as_deref().unwrap_or("");
            let content_type = input.content_type.as_deref().unwrap_or("");
            let encoded = input.document_base64.as_deref().unwrap_or("");
            let cover = input.cover_page_text.as_deref().unwrap_or("");
            if input.sender.is_some()
                || input.text.is_some()
                || input.play_prompt.is_some()
                || content_type != "application/pdf"
                || filename.len() > 200
                || !filename.ends_with(".pdf")
                || !filename
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
                || cover.chars().count() > 1024
            {
                return Err(Error::Invalid("invalid RingCentral fax draft"));
            }
            let document = STANDARD
                .decode(encoded)
                .map_err(|_| Error::Invalid("invalid RingCentral fax document"))?;
            if document.is_empty() || document.len() > 10 * 1024 * 1024 {
                return Err(Error::Invalid("invalid RingCentral fax document"));
            }
        }
        "ringout" => {
            if input.sender.as_deref().is_some_and(|v| !e164(v.trim()))
                || input.text.is_some()
                || input.document_base64.is_some()
                || input.cover_page_text.is_some()
                || input.filename.is_some()
                || input.content_type.is_some()
            {
                return Err(Error::Invalid("invalid RingCentral RingOut draft"));
            }
        }
        _ => return Err(Error::Invalid("unsupported RingCentral outbound kind")),
    }
    Ok(())
}

async fn outbound_event(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    draft: Uuid,
    actor: Uuid,
    action: &str,
    evidence: Value,
) -> Result<()> {
    let sequence: i64 = sqlx::query_scalar("SELECT coalesce(max(sequence),0)+1 FROM ringcentral_outbound_events WHERE tenant_id=$1 AND draft_id=$2")
        .bind(tenant).bind(draft).fetch_one(&mut **tx).await?;
    sqlx::query("INSERT INTO ringcentral_outbound_events(tenant_id,draft_id,sequence,actor_id,action,evidence) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(tenant).bind(draft).bind(sequence).bind(actor).bind(action).bind(evidence).execute(&mut **tx).await?;
    sqlx::query(
        "INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,$3,$4)",
    )
    .bind(tenant)
    .bind(actor)
    .bind(format!("integration.ringcentral_outbound_{action}"))
    .bind(draft)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(crate) async fn create_outbound_draft(
    pool: &PgPool,
    actor: &Actor,
    integration_id: Uuid,
    request_id: Uuid,
    source: &str,
    input: OutboundDraftInput,
) -> Result<Value> {
    draft_role(actor)?;
    validate_outbound(&input)?;
    if !matches!(source, "staff" | "workflow" | "ai_draft") {
        return Err(Error::Invalid("invalid RingCentral draft source"));
    }
    let serialized = Zeroizing::new(
        serde_json::to_string(&input)
            .map_err(|_| Error::Invalid("invalid RingCentral outbound draft"))?,
    );
    let payload_hash = crate::oauth::hash(&serialized);
    let id = Uuid::new_v4();
    let encrypted = crate::provider_settings::seal_secret(
        pool,
        actor.tenant_id,
        id,
        "ringcentral-outbound",
        &serialized,
    )
    .await?;
    let mut tx = pool.begin().await?;
    integration(&mut tx, actor.tenant_id, integration_id).await?;
    if let Some((existing_hash, existing)) = sqlx::query_as::<_, (String, Value)>("SELECT payload_hash,jsonb_build_object('id',id,'kind',kind,'status',status,'source',source,'created_at',created_at) FROM ringcentral_outbound_drafts WHERE tenant_id=$1 AND integration_id=$2 AND request_id=$3")
        .bind(actor.tenant_id).bind(integration_id).bind(request_id).fetch_optional(&mut *tx).await? {
        if existing_hash != payload_hash {
            return Err(Error::Conflict(
                "RingCentral request ID was already used for a different draft",
            ));
        }
        tx.commit().await?;
        return Ok(existing);
    }
    sqlx::query("INSERT INTO ringcentral_outbound_drafts(tenant_id,id,integration_id,kind,request_id,source,encrypted_payload,payload_hash,recipient_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(actor.tenant_id).bind(id).bind(integration_id).bind(&input.kind).bind(request_id).bind(source).bind(encrypted).bind(payload_hash).bind(crate::oauth::hash(input.recipient.trim())).bind(actor.sub).execute(&mut *tx).await?;
    outbound_event(
        &mut tx,
        actor.tenant_id,
        id,
        actor.sub,
        "drafted",
        json!({"kind":input.kind,"source":source}),
    )
    .await?;
    tx.commit().await?;
    Ok(json!({"id":id,"kind":input.kind,"status":"draft","source":source}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateOutbound {
    request_id: Uuid,
    #[serde(flatten)]
    draft: OutboundDraftInput,
}

async fn create_outbound(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    Json(input): Json<CreateOutbound>,
) -> Result<Response> {
    let value =
        create_outbound_draft(db(&s)?, &a, id, input.request_id, "staff", input.draft).await?;
    Ok(no_store(value))
}

async fn list_outbound(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    draft_role(&a)?;
    let mut tx = db(&s)?.begin().await?;
    integration(&mut tx, a.tenant_id, id).await?;
    let items: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'kind',kind,'source',source,'status',status,'created_by',created_by,'approved_by',approved_by,'sent_by',sent_by,'provider_status',provider_status,'last_error',last_error,'created_at',created_at,'updated_at',updated_at) FROM ringcentral_outbound_drafts WHERE tenant_id=$1 AND integration_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100")
        .bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    sqlx::query("INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,'integration.ringcentral_outbound_list_read',$3)")
        .bind(a.tenant_id).bind(a.sub).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(no_store(json!({"items":items})))
}

async fn outbound_detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((id, draft_id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    draft_role(&a)?;
    let mut tx = db(&s)?.begin().await?;
    let row: Option<(Vec<u8>, Value)> = sqlx::query_as("SELECT encrypted_payload,jsonb_build_object('id',id,'kind',kind,'source',source,'status',status,'created_by',created_by,'approved_by',approved_by,'approval_reason',approval_reason,'approved_at',approved_at,'sent_by',sent_by,'sent_at',sent_at,'provider_id',provider_id,'provider_uri',provider_uri,'provider_status',provider_status,'last_error',last_error,'created_at',created_at,'updated_at',updated_at) FROM ringcentral_outbound_drafts WHERE tenant_id=$1 AND integration_id=$2 AND id=$3")
        .bind(a.tenant_id).bind(id).bind(draft_id).fetch_optional(&mut *tx).await?;
    let (encrypted, metadata) = row.ok_or(Error::NotFound)?;
    let payload = crate::provider_settings::open_secret(
        a.tenant_id,
        draft_id,
        "ringcentral-outbound",
        &encrypted,
    )?;
    let payload: Value = serde_json::from_str(payload.expose())
        .map_err(|_| Error::Invalid("saved RingCentral outbound draft invalid"))?;
    let events: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('sequence',sequence,'actor_id',actor_id,'action',action,'evidence',evidence,'created_at',created_at) FROM ringcentral_outbound_events WHERE tenant_id=$1 AND draft_id=$2 ORDER BY sequence")
        .bind(a.tenant_id).bind(draft_id).fetch_all(&mut *tx).await?;
    sqlx::query("INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,'integration.ringcentral_outbound_read',$3)")
        .bind(a.tenant_id).bind(a.sub).bind(draft_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(no_store(
        json!({"draft":metadata,"payload":payload,"events":events}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApproveOutbound {
    request_id: Uuid,
    confirmed_recipient: String,
    reason: String,
}

async fn approve_outbound(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((id, draft_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<ApproveOutbound>,
) -> Result<Response> {
    let reason = input.reason.trim();
    if reason.is_empty() || reason.len() > 500 || !e164(input.confirmed_recipient.trim()) {
        return Err(Error::Invalid(
            "recipient confirmation and reason are required",
        ));
    }
    let mut tx = db(&s)?.begin().await?;
    let row: Option<(String, String, String, Option<Uuid>)> = sqlx::query_as("SELECT kind,status,recipient_hash,approval_request_id FROM ringcentral_outbound_drafts WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 FOR UPDATE")
        .bind(a.tenant_id).bind(id).bind(draft_id).fetch_optional(&mut *tx).await?;
    let (kind, status, recipient_hash, existing_request) = row.ok_or(Error::NotFound)?;
    send_role(&a, &kind)?;
    if existing_request == Some(input.request_id)
        && matches!(
            status.as_str(),
            "approved" | "sending" | "accepted" | "failed" | "needs_review"
        )
    {
        tx.commit().await?;
        return Ok(no_store(
            json!({"id":draft_id,"status":status,"idempotent":true}),
        ));
    }
    if status != "draft" || existing_request.is_some() {
        return Err(Error::Conflict("RingCentral draft cannot be approved"));
    }
    aws_lc_rs::constant_time::verify_slices_are_equal(
        recipient_hash.as_bytes(),
        crate::oauth::hash(input.confirmed_recipient.trim()).as_bytes(),
    )
    .map_err(|_| Error::Invalid("confirmed recipient does not match the draft"))?;
    sqlx::query("UPDATE ringcentral_outbound_drafts SET status='approved',approved_by=$4,approval_request_id=$5,approval_reason=$6,approved_at=now(),updated_at=now() WHERE tenant_id=$1 AND integration_id=$2 AND id=$3")
        .bind(a.tenant_id).bind(id).bind(draft_id).bind(a.sub).bind(input.request_id).bind(reason).execute(&mut *tx).await?;
    outbound_event(
        &mut tx,
        a.tenant_id,
        draft_id,
        a.sub,
        "approved",
        json!({"kind":kind,"recipient_confirmed":true}),
    )
    .await?;
    tx.commit().await?;
    Ok(no_store(json!({"id":draft_id,"status":"approved"})))
}

#[derive(sqlx::FromRow)]
struct OutboundRow {
    kind: String,
    status: String,
    encrypted_payload: Vec<u8>,
    send_request_id: Option<Uuid>,
    provider_id: Option<String>,
    provider_status: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SendOutbound {
    request_id: Uuid,
}

struct ProviderReceipt {
    id: String,
    uri: Option<String>,
    status: String,
    raw: Value,
}

fn provider_id(value: &Value) -> Option<String> {
    value
        .get("id")
        .and_then(|id| {
            id.as_str()
                .map(ToOwned::to_owned)
                .or_else(|| id.as_i64().map(|v| v.to_string()))
                .or_else(|| id.as_u64().map(|v| v.to_string()))
        })
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 240
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
}

async fn parse_provider_receipt(
    response: reqwest::Response,
    kind: &str,
) -> Result<ProviderReceipt> {
    if !response.status().is_success() {
        return Err(Error::Invalid(bounded_provider_error(response.status())));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| Error::Invalid("RingCentral response unavailable"))?;
    if bytes.len() > 262_144 {
        return Err(Error::Invalid("RingCentral response invalid"));
    }
    let raw: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Error::Invalid("RingCentral response invalid"))?;
    let id = provider_id(&raw).ok_or(Error::Invalid("RingCentral response invalid"))?;
    let uri = raw
        .get("uri")
        .and_then(Value::as_str)
        .filter(|v| v.len() <= 2000)
        .map(ToOwned::to_owned);
    let status = if kind == "ringout" {
        raw.pointer("/status/callStatus").and_then(Value::as_str)
    } else {
        raw.get("messageStatus").and_then(Value::as_str)
    }
    .unwrap_or("Accepted");
    if status.is_empty()
        || status.len() > 120
        || !status
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(Error::Invalid("RingCentral response invalid"));
    }
    Ok(ProviderReceipt {
        id,
        uri,
        status: status.to_owned(),
        raw,
    })
}

async fn send_to_provider(
    pool: &PgPool,
    tenant: Uuid,
    integration_id: Uuid,
    actor: Uuid,
    input: &OutboundDraftInput,
) -> Result<ProviderReceipt> {
    validate_outbound(input)?;
    let config: Value = sqlx::query_scalar("SELECT config FROM instance_integrations WHERE tenant_id=$1 AND id=$2 AND provider='ringcentral' AND enabled AND status='connected'")
        .bind(tenant).bind(integration_id).fetch_optional(pool).await?.ok_or(Error::Conflict("RingCentral integration is not enabled and connected"))?;
    let token = current_access(pool, tenant, integration_id, actor).await?;
    let base = platform(&config)?;
    let client = http()?;
    let response = match input.kind.as_str() {
        "sms" => client.post(format!("{base}/restapi/v1.0/account/~/extension/~/sms"))
            .bearer_auth(token.as_str())
            .json(&json!({"from":{"phoneNumber":input.sender.as_deref().unwrap_or("")},"to":[{"phoneNumber":input.recipient}],"text":input.text.as_deref().unwrap_or("")}))
            .send().await,
        "fax" => {
            let document = STANDARD.decode(input.document_base64.as_deref().unwrap_or("")).map_err(|_|Error::Invalid("invalid RingCentral fax document"))?;
            let metadata = json!({"to":[{"phoneNumber":input.recipient}],"faxResolution":"High","coverPageText":input.cover_page_text.as_deref().unwrap_or("")});
            let json_part = reqwest::multipart::Part::text(metadata.to_string()).file_name("request.json").mime_str("application/json").map_err(|_|Error::Invalid("RingCentral fax unavailable"))?;
            let attachment = reqwest::multipart::Part::bytes(document).file_name(input.filename.clone().unwrap_or_else(||"document.pdf".into())).mime_str("application/pdf").map_err(|_|Error::Invalid("RingCentral fax unavailable"))?;
            client.post(format!("{base}/restapi/v1.0/account/~/extension/~/fax"))
                .bearer_auth(token.as_str()).multipart(reqwest::multipart::Form::new().part("json",json_part).part("attachment",attachment)).send().await
        }
        "ringout" => {
            let mut body = json!({"to":{"phoneNumber":input.recipient},"playPrompt":input.play_prompt.unwrap_or(true)});
            if let Some(sender) = input.sender.as_ref() { body["from"] = json!({"phoneNumber":sender}); }
            client.post(format!("{base}/restapi/v1.0/account/~/extension/~/ring-out"))
                .bearer_auth(token.as_str()).json(&body).send().await
        }
        _ => return Err(Error::Invalid("unsupported RingCentral outbound kind")),
    }.map_err(|_|Error::Invalid("ringcentral_outbound_unknown"))?;
    parse_provider_receipt(response, &input.kind).await
}

async fn refresh_provider_status(
    pool: &PgPool,
    tenant: Uuid,
    integration_id: Uuid,
    actor: Uuid,
    kind: &str,
    provider_id: &str,
) -> Result<ProviderReceipt> {
    if provider_id.is_empty() || provider_id.len() > 240 {
        return Err(Error::Invalid("RingCentral provider receipt invalid"));
    }
    let config: Value = sqlx::query_scalar("SELECT config FROM instance_integrations WHERE tenant_id=$1 AND id=$2 AND provider='ringcentral' AND enabled AND status='connected'")
        .bind(tenant).bind(integration_id).fetch_optional(pool).await?.ok_or(Error::Conflict("RingCentral integration is not enabled and connected"))?;
    let token = current_access(pool, tenant, integration_id, actor).await?;
    let base = platform(&config)?;
    let path = if kind == "ringout" {
        format!("/restapi/v1.0/account/~/extension/~/ring-out/{provider_id}")
    } else {
        format!("/restapi/v1.0/account/~/extension/~/message-store/{provider_id}")
    };
    let response = http()?
        .get(format!("{base}{path}"))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|_| Error::Invalid("RingCentral status request unavailable"))?;
    parse_provider_receipt(response, kind).await
}

async fn record_send_failure(
    pool: &PgPool,
    tenant: Uuid,
    integration: Uuid,
    draft: Uuid,
    actor: Uuid,
    code: &'static str,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let status = if matches!(
        code,
        "ringcentral_outbound_unknown" | "ringcentral_rate_limited" | "ringcentral_unavailable"
    ) {
        "needs_review"
    } else {
        "failed"
    };
    sqlx::query("UPDATE ringcentral_outbound_drafts SET status=$4,last_error=$5,updated_at=now() WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND status='sending'")
        .bind(tenant).bind(integration).bind(draft).bind(status).bind(code).execute(&mut *tx).await?;
    let action = if status == "needs_review" {
        "provider_unknown"
    } else {
        "provider_rejected"
    };
    outbound_event(
        &mut tx,
        tenant,
        draft,
        actor,
        action,
        json!({"result":code,"status":status}),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn send_outbound(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((id, draft_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<SendOutbound>,
) -> Result<Response> {
    let mut tx = db(&s)?.begin().await?;
    let row: Option<OutboundRow> = sqlx::query_as("SELECT kind,status,encrypted_payload,send_request_id,provider_id,provider_status FROM ringcentral_outbound_drafts WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 FOR UPDATE")
        .bind(a.tenant_id).bind(id).bind(draft_id).fetch_optional(&mut *tx).await?;
    let row = row.ok_or(Error::NotFound)?;
    send_role(&a, &row.kind)?;
    if row.send_request_id == Some(input.request_id)
        && matches!(
            row.status.as_str(),
            "sending" | "accepted" | "failed" | "needs_review"
        )
    {
        tx.commit().await?;
        return Ok(no_store(
            json!({"id":draft_id,"status":row.status,"provider_id":row.provider_id,"provider_status":row.provider_status,"idempotent":true}),
        ));
    }
    if row.status != "approved" || row.send_request_id.is_some() {
        return Err(Error::Conflict(
            "RingCentral draft is not approved for sending",
        ));
    }
    sqlx::query("UPDATE ringcentral_outbound_drafts SET status='sending',send_request_id=$4,sent_by=$5,sent_at=now(),updated_at=now() WHERE tenant_id=$1 AND integration_id=$2 AND id=$3")
        .bind(a.tenant_id).bind(id).bind(draft_id).bind(input.request_id).bind(a.sub).execute(&mut *tx).await?;
    outbound_event(
        &mut tx,
        a.tenant_id,
        draft_id,
        a.sub,
        "send_started",
        json!({"kind":row.kind}),
    )
    .await?;
    tx.commit().await?;
    let payload = crate::provider_settings::open_secret(
        a.tenant_id,
        draft_id,
        "ringcentral-outbound",
        &row.encrypted_payload,
    )?;
    let payload: OutboundDraftInput = serde_json::from_str(payload.expose())
        .map_err(|_| Error::Invalid("saved RingCentral outbound draft invalid"))?;
    let receipt = match send_to_provider(db(&s)?, a.tenant_id, id, a.sub, &payload).await {
        Ok(receipt) => receipt,
        Err(error) => {
            let code = match error {
                Error::Invalid(code) if code.starts_with("ringcentral_") => code,
                _ => "ringcentral_outbound_failed",
            };
            record_send_failure(db(&s)?, a.tenant_id, id, draft_id, a.sub, code).await?;
            return Err(Error::Invalid(code));
        }
    };
    let serialized = Zeroizing::new(
        serde_json::to_string(&receipt.raw)
            .map_err(|_| Error::Invalid("RingCentral response invalid"))?,
    );
    let encrypted = crate::provider_settings::seal_secret(
        db(&s)?,
        a.tenant_id,
        draft_id,
        "ringcentral-outbound-receipt",
        &serialized,
    )
    .await?;
    let mut tx = db(&s)?.begin().await?;
    let changed = sqlx::query("UPDATE ringcentral_outbound_drafts SET status='accepted',provider_id=$4,provider_uri=$5,provider_status=$6,encrypted_provider_receipt=$7,last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND status='sending'")
        .bind(a.tenant_id).bind(id).bind(draft_id).bind(&receipt.id).bind(&receipt.uri).bind(&receipt.status).bind(encrypted).execute(&mut *tx).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::Conflict("RingCentral outbound state changed"));
    }
    outbound_event(
        &mut tx,
        a.tenant_id,
        draft_id,
        a.sub,
        "provider_accepted",
        json!({"provider_id":receipt.id,"provider_status":receipt.status}),
    )
    .await?;
    tx.commit().await?;
    Ok(no_store(
        json!({"id":draft_id,"status":"accepted","provider_id":receipt.id,"provider_status":receipt.status,"delivery_confirmed":false}),
    ))
}

async fn refresh_outbound(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((id, draft_id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let row: Option<(String, String, Option<String>)> = sqlx::query_as("SELECT kind,status,provider_id FROM ringcentral_outbound_drafts WHERE tenant_id=$1 AND integration_id=$2 AND id=$3")
        .bind(a.tenant_id).bind(id).bind(draft_id).fetch_optional(db(&s)?).await?;
    let (kind, status, provider_id) = row.ok_or(Error::NotFound)?;
    send_role(&a, &kind)?;
    if status != "accepted" {
        return Err(Error::Conflict(
            "RingCentral status is available only after provider acceptance",
        ));
    }
    let provider_id = provider_id.ok_or(Error::Invalid("RingCentral provider receipt invalid"))?;
    let receipt =
        refresh_provider_status(db(&s)?, a.tenant_id, id, a.sub, &kind, &provider_id).await?;
    let serialized = Zeroizing::new(
        serde_json::to_string(&receipt.raw)
            .map_err(|_| Error::Invalid("RingCentral response invalid"))?,
    );
    let encrypted = crate::provider_settings::seal_secret(
        db(&s)?,
        a.tenant_id,
        draft_id,
        "ringcentral-outbound-receipt",
        &serialized,
    )
    .await?;
    let mut tx = db(&s)?.begin().await?;
    let changed = sqlx::query("UPDATE ringcentral_outbound_drafts SET provider_uri=$4,provider_status=$5,encrypted_provider_receipt=$6,updated_at=now() WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND status='accepted'")
        .bind(a.tenant_id).bind(id).bind(draft_id).bind(&receipt.uri).bind(&receipt.status).bind(encrypted).execute(&mut *tx).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::Conflict("RingCentral outbound state changed"));
    }
    outbound_event(
        &mut tx,
        a.tenant_id,
        draft_id,
        a.sub,
        "status_refreshed",
        json!({"provider_id":receipt.id,"provider_status":receipt.status}),
    )
    .await?;
    tx.commit().await?;
    let delivered = matches!(
        receipt.status.as_str(),
        "Delivered" | "CallConnected" | "Success"
    );
    Ok(no_store(
        json!({"id":draft_id,"status":"accepted","provider_id":receipt.id,"provider_status":receipt.status,"delivery_confirmed":delivered}),
    ))
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
    fn actor(role: Role) -> Actor {
        Actor {
            sub: Uuid::nil(),
            tenant_id: Uuid::nil(),
            role,
            patient_id: None,
            iss: "test".into(),
            aud: "test".into(),
            iat: 1,
            exp: 2,
        }
    }
    fn sms() -> OutboundDraftInput {
        OutboundDraftInput {
            kind: "sms".into(),
            recipient: "+18155550100".into(),
            sender: Some("+18155550101".into()),
            text: Some("Synthetic appointment message".into()),
            cover_page_text: None,
            filename: None,
            content_type: None,
            document_base64: None,
            play_prompt: None,
        }
    }
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
    #[test]
    fn outbound_drafts_are_bounded() {
        assert!(validate_outbound(&sms()).is_ok());
        let mut invalid = sms();
        invalid.recipient = "815-555-0100".into();
        assert!(validate_outbound(&invalid).is_err());
        let mut oversized = sms();
        oversized.text = Some("x".repeat(1001));
        assert!(validate_outbound(&oversized).is_err());
        let mut hidden_attachment = sms();
        hidden_attachment.filename = Some("ignored.pdf".into());
        assert!(validate_outbound(&hidden_attachment).is_err());
    }
    #[test]
    fn outbound_authorization_is_action_specific() {
        assert!(draft_role(&actor(Role::FrontDesk)).is_ok());
        assert!(draft_role(&actor(Role::PartnerSupport)).is_ok());
        assert!(send_role(&actor(Role::FrontDesk), "sms").is_ok());
        assert!(send_role(&actor(Role::FrontDesk), "ringout").is_ok());
        assert!(send_role(&actor(Role::FrontDesk), "fax").is_err());
        assert!(send_role(&actor(Role::Clinician), "fax").is_ok());
        assert!(send_role(&actor(Role::PartnerSupport), "sms").is_err());
        assert!(draft_role(&actor(Role::ReadOnly)).is_err());
    }
    #[test]
    fn provider_receipt_ids_are_bounded_values() {
        assert_eq!(provider_id(&json!({"id":1234})).as_deref(), Some("1234"));
        assert_eq!(provider_id(&json!({"id":"abc"})).as_deref(), Some("abc"));
        assert!(provider_id(&json!({"id":null})).is_none());
    }
}
