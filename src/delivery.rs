// SPDX-License-Identifier: AGPL-3.0-only
//! Durable gateway delivery. Ambiguous sends are held; retries require proof of non-receipt.
use crate::{
    auth::{Actor, Role},
    billing, claims, clearinghouse,
    error::{Error, Result},
    model::text,
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::time::Duration;
use uuid::Uuid;
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Route {
    pub key: String,
    pub tenant_id: Uuid,
    pub partner_id: Uuid,
    pub endpoint: String,
    pub usage: String,
    pub credential_env: Option<String>,
    #[serde(default)]
    pub loopback_test: bool,
    #[serde(default)]
    pub adapter: Adapter,
    pub retrieval: Option<crate::retrieval::Settings>,
    pub sftp: Option<crate::sftp_transport::Settings>,
}
#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Adapter {
    #[default]
    Gateway,
    Stedi,
    ClaimMd,
    OfficeAllySftp,
    AvailitySftp,
}
#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub routes: Vec<Route>,
}
impl Config {
    pub fn from_env() -> Result<Self> {
        let Some(path) = std::env::var_os("ENGINE_CLEARINGHOUSE_CONFIG") else {
            return Ok(Self::default());
        };
        let raw = std::fs::read(path)
            .map_err(|_| Error::Invalid("clearinghouse configuration unavailable"))?;
        if raw.len() > 64000 {
            return Err(Error::Invalid("clearinghouse configuration too large"));
        }
        let c: Self = serde_json::from_slice(&raw)
            .map_err(|_| Error::Invalid("invalid clearinghouse configuration"))?;
        c.validate()?;
        Ok(c)
    }
    pub fn validate(&self) -> Result<()> {
        let mut keys = std::collections::HashSet::new();
        let mut credentials = std::collections::HashSet::new();
        if self.routes.len() > 50 {
            return Err(Error::Invalid("too many gateway routes"));
        }
        for r in &self.routes {
            crate::stedi::validate(r)?;
            if matches!(r.adapter, Adapter::Stedi | Adapter::ClaimMd) {
                if let Some(key) = &r.credential_env {
                    let identity = std::env::var(key)
                        .map(|v| crate::oauth::hash(&v))
                        .unwrap_or_else(|_| key.clone());
                    if !credentials.insert(identity) {
                        return Err(Error::Invalid(
                            "Stedi account credentials must bind to one route and tenant",
                        ));
                    }
                }
            }
            let u =
                url::Url::parse(&r.endpoint).map_err(|_| Error::Invalid("invalid gateway URL"))?;
            if r.key.is_empty()
                || r.key.len() > 80
                || !r
                    .key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                || !keys.insert((r.tenant_id, r.key.clone()))
                || !u.username().is_empty()
                || u.password().is_some()
                || u.query().is_some()
                || u.fragment().is_some()
                || !["T", "P"].contains(&r.usage.as_str())
            {
                return Err(Error::Invalid("invalid or duplicate gateway route"));
            }
            if matches!(r.adapter, Adapter::OfficeAllySftp | Adapter::AvailitySftp) {
                let user = r
                    .sftp
                    .as_ref()
                    .map(|v| {
                        std::env::var(&v.username_env).unwrap_or_else(|_| v.username_env.clone())
                    })
                    .unwrap_or_default();
                let identity = format!(
                    "sftp:{}:{}:{}",
                    u.host_str().unwrap_or(""),
                    u.port().unwrap_or(22),
                    user
                );
                if !credentials.insert(identity) {
                    return Err(Error::Invalid(
                        "an SFTP mailbox must bind to one route and tenant",
                    ));
                }
                crate::sftp_transport::validate(r)?;
                continue;
            }
            let local = r.loopback_test
                && r.usage == "T"
                && u.scheme() == "http"
                && matches!(u.host_str(), Some("127.0.0.1" | "[::1]"));
            if !local
                && (r.loopback_test
                    || u.scheme() != "https"
                    || r.credential_env.as_ref().is_none_or(|v| {
                        !v.starts_with("ENGINE_CLEARINGHOUSE_TOKEN_")
                            || !v
                                .bytes()
                                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                    }))
            {
                return Err(Error::Invalid("gateway requires HTTPS and an operator-managed credential reference; HTTP only for explicit numeric loopback test routes"));
            }
        }
        Ok(())
    }
    pub(crate) fn route(&self, t: Uuid, key: &str) -> Option<&Route> {
        self.routes
            .iter()
            .find(|r| r.tenant_id == t && r.key == key)
    }
}
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
#[derive(Clone, Serialize, sqlx::FromRow)]
struct Job {
    tenant_id: Uuid,
    id: Uuid,
    submission_id: Uuid,
    route_key: String,
    requested_by: Uuid,
    status: String,
    version: i64,
    attempts: i32,
    lease_id: Option<Uuid>,
    receipt_reference: Option<String>,
    receipt: Value,
    last_result: Option<String>,
}
async fn job(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Job> {
    sqlx::query_as("SELECT * FROM edi_delivery_jobs WHERE tenant_id=$1 AND id=$2")
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
    reason: &str,
    evidence: Value,
) -> Result<Job> {
    let j = job(tx, a, id).await?;
    sqlx::query("INSERT INTO edi_delivery_events (tenant_id,job_id,version,actor_id,reason,evidence) VALUES ($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(j.version).bind(a.sub).bind(reason).bind(evidence).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "edi.delivery_change", id).await?;
    Ok(j)
}
pub(crate) async fn ensure_unreserved(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
) -> Result<()> {
    let locked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edi_delivery_jobs WHERE tenant_id=$1 AND submission_id=$2 AND status IN ('queued','leased','retry','unknown','blocked'))").bind(a.tenant_id).bind(id).fetch_one(&mut **tx).await?;
    if locked {
        Err(Error::Conflict("submission is reserved for automated delivery; resolve or cancel its delivery job first"))
    } else {
        Ok(())
    }
}
pub(crate) async fn ensure_claim_unreserved(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
) -> Result<()> {
    let locked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edi_delivery_jobs j JOIN edi_submissions s ON s.tenant_id=j.tenant_id AND s.id=j.submission_id WHERE j.tenant_id=$1 AND s.claim_id=$2 AND j.status IN ('queued','leased','retry','unknown','blocked'))").bind(a.tenant_id).bind(id).fetch_one(&mut **tx).await?;
    if locked {
        Err(Error::Conflict(
            "claim is reserved for automated delivery; reconcile the delivery job first",
        ))
    } else {
        Ok(())
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Queue {
    request_id: Uuid,
    route_key: String,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    action: String,
    reason: String,
    #[serde(default)]
    reference: String,
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/billing/delivery/routes", get(routes))
        .route("/api/v1/billing/delivery/jobs", get(list))
        .route("/api/v1/billing/submissions/{id}/delivery", post(queue))
        .route("/api/v1/billing/delivery/jobs/{id}", get(detail))
        .route("/api/v1/billing/delivery/jobs/{id}/actions", post(action))
}
async fn routes(a: Actor) -> Result<Json<Value>> {
    a.staff()?;
    let c = Config::from_env()?;
    Ok(Json(
        json!({"items":c.routes.iter().filter(|r|r.tenant_id==a.tenant_id).map(|r|json!({"key":r.key,"partner_id":r.partner_id,"usage":r.usage,"adapter":r.adapter,"retrieval_enabled":r.retrieval.is_some(),"loopback_test":r.loopback_test,"credential_configured":if r.sftp.is_some(){crate::sftp_transport::credentials_available(r)}else{r.credential_env.as_ref().is_none_or(|k|std::env::var(k).is_ok_and(|v| !v.trim().is_empty()))}})).collect::<Vec<_>>(),"worker":"operator-configured provider adapters and HTTPS gateway"}),
    ))
}
async fn queue(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Queue>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    text(&v.reason, 1000)?;
    text(&v.route_key, 80)?;
    let version = crate::expected(&h)?;
    let hash = crate::oauth::hash(&json!({"submission":id,"request":v}).to_string());
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let prior: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,creation_hash FROM edi_delivery_jobs WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((jid, digest)) = prior {
        if digest != hash {
            return Err(Error::Conflict(
                "delivery request ID reused with changed content",
            ));
        }
        return Ok(Json(json!(job(&mut tx, &a, jid).await?)));
    }
    let out = clearinghouse::submission(&mut tx, &a, id).await?;
    let c = claims::claim_row(&mut tx, &a, out.claim_id).await?;
    if out.version != version
        || out.status != "prepared"
        || c.status != "ready"
        || c.version != out.claim_version
    {
        return Err(Error::Conflict(
            "queue only the current prepared artifact with its unchanged ready claim",
        ));
    }
    let reserved: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edi_delivery_jobs WHERE tenant_id=$1 AND submission_id=$2 AND status<>'cancelled')").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
    if reserved {
        return Err(Error::Conflict(
            "artifact already has an active or completed delivery job",
        ));
    }
    let jid = Uuid::new_v4();
    sqlx::query("INSERT INTO edi_delivery_jobs (tenant_id,id,submission_id,route_key,requested_by,request_id,creation_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)").bind(a.tenant_id).bind(jid).bind(id).bind(&v.route_key).bind(a.sub).bind(v.request_id).bind(hash).execute(&mut *tx).await?;
    let j = event(
        &mut tx,
        &a,
        jid,
        &v.reason,
        json!({"action":"queue","network_sent":false}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!(j)))
}
async fn list(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(j)-'tenant_id'-'creation_hash'-'request_id' FROM edi_delivery_jobs j WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 100").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.delivery_list", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"limit":100})))
}
async fn detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let j = job(&mut tx, &a, id).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id' FROM edi_delivery_events e WHERE tenant_id=$1 AND job_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.delivery_read", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"job":j,"events":events})))
}
async fn delivered(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    j: &Job,
    reference: &str,
    receipt: Value,
    reason: &str,
) -> Result<()> {
    let out = clearinghouse::submission(tx, a, j.submission_id).await?;
    let c = claims::claim_row(tx, a, out.claim_id).await?;
    if out.status != "prepared" || c.status != "ready" || c.version != out.claim_version {
        return Err(Error::Conflict(
            "delivery receipt retained for reconciliation because the claim/artifact changed",
        ));
    }
    sqlx::query(
        "UPDATE ehr_claims SET status='submitted',version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(c.id)
    .execute(&mut **tx)
    .await?;
    let c=claims::revision(tx,a,c.id,reason,json!({"delivery_job_id":j.id,"submission_id":out.id,"receipt_reference":reference,"adapter":receipt["adapter"],"proof":receipt["proof"],"origin":if receipt["staff_verified_receipt"]==true {"staff_receipt_reconciliation"} else {"automated_transport_delivery"}})).await?;
    sqlx::query("UPDATE edi_submissions SET status='delivered',delivered_claim_version=$3,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(out.id).bind(c.version).execute(&mut **tx).await?;
    clearinghouse::event(tx,a,out.id,reason,json!({"delivery_job_id":j.id,"receipt_reference":reference,"adapter":receipt["adapter"],"proof":receipt["proof"],"origin":if receipt["staff_verified_receipt"]==true {"staff_receipt_reconciliation"} else {"automated_transport_delivery"}})).await?;
    sqlx::query("UPDATE edi_delivery_jobs SET status='delivered',receipt_reference=$3,receipt=$4,lease_id=NULL,lease_until=NULL,last_result='receipt_confirmed',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(j.id).bind(reference).bind(receipt).execute(&mut **tx).await?;
    Ok(())
}
async fn action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Decision>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    text(&v.reason, 1000)?;
    if v.reference.len() > 200 {
        return Err(Error::Invalid("delivery reference too long"));
    }
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let j = job(&mut tx, &a, id).await?;
    if j.version != version {
        return Err(Error::Conflict("delivery job changed; reload"));
    }
    match(v.action.as_str(),j.status.as_str()){
 ("cancel","queued"|"retry"|"blocked")=>{sqlx::query("UPDATE edi_delivery_jobs SET status='cancelled',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;}
 ("confirmed_not_received","unknown"|"blocked")=>{text(&v.reference,200)?;sqlx::query("UPDATE edi_delivery_jobs SET status='retry',next_attempt_at=now(),lease_id=NULL,lease_until=NULL,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;}
 ("confirmed_received","unknown")=>{text(&v.reference,200)?;delivered(&mut tx,&a,&j,&v.reference,json!({"staff_verified_receipt":true,"reference":v.reference}),&v.reason).await?;}
 _=>return Err(Error::Conflict("delivery action is not allowed; uncertain sends require explicit receipt reconciliation"))}
    let j = event(
        &mut tx,
        &a,
        id,
        &v.reason,
        json!({"action":v.action,"reference":v.reference,"origin":"staff_reconciliation"}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!(j)))
}
pub(crate) fn worker(t: Uuid) -> Actor {
    let now = Utc::now().timestamp();
    Actor {
        sub: Uuid::from_u128(0x53c40000000040008000000000000011),
        tenant_id: t,
        role: Role::Owner,
        patient_id: None,
        iss: "suncharts-delivery-worker".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    status: String,
    submission_id: Uuid,
    payload_sha256: String,
    receipt_reference: String,
}
/// Processes at most one due job, with a committed lease before network I/O.
pub async fn process_one(pool: &PgPool, config: &Config) -> Result<bool> {
    config.validate()?;
    let candidate:Option<(Uuid,Uuid)>=sqlx::query_as("SELECT tenant_id,id FROM edi_delivery_jobs WHERE (status IN ('queued','retry') AND next_attempt_at<=now()) OR (status='leased' AND lease_until<now()) ORDER BY created_at,id LIMIT 1").fetch_optional(pool).await?;
    let Some((tenant, id)) = candidate else {
        return Ok(false);
    };
    let a = worker(tenant);
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let j = job(&mut tx, &a, id).await?;
    if j.status == "leased" {
        sqlx::query("UPDATE edi_delivery_jobs SET status='unknown',lease_id=NULL,lease_until=NULL,last_result='expired_lease_ambiguous',version=version+1 WHERE tenant_id=$1 AND id=$2 AND lease_until<now()").bind(tenant).bind(id).execute(&mut *tx).await?;
        let updated = job(&mut tx, &a, id).await?;
        if updated.version != j.version {
            event(
                &mut tx,
                &a,
                id,
                "Worker lease expired; reconcile receipt before resending",
                json!({"automatic_resend":false}),
            )
            .await?;
        }
        tx.commit().await?;
        return Ok(true);
    }
    if !["queued", "retry"].contains(&j.status.as_str()) {
        return Ok(false);
    }
    let due: bool = sqlx::query_scalar(
        "SELECT next_attempt_at<=now() FROM edi_delivery_jobs WHERE tenant_id=$1 AND id=$2",
    )
    .bind(tenant)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if !due {
        return Ok(false);
    }
    let out = clearinghouse::submission(&mut tx, &a, j.submission_id).await?;
    let c = claims::claim_row(&mut tx, &a, out.claim_id).await?;
    let p = clearinghouse::partner(&mut tx, &a, out.partner_id).await?;
    let route = config.route(tenant, &j.route_key);
    let valid = route.is_some_and(|r| {
        r.partner_id == out.partner_id && r.usage == out.partner_snapshot["content"]["usage"]
    });
    let token = route
        .and_then(|r| r.credential_env.as_ref())
        .and_then(|key| std::env::var(key).ok());
    let binding_valid = if let Some(r) = route {
        crate::retrieval::delivery_binding(&mut tx, &a, r).await?
    } else {
        false
    };
    let block = if !binding_valid {
        "provider_binding_changed_or_paused"
    } else if route.is_some_and(|r| {
        matches!(r.adapter, Adapter::OfficeAllySftp | Adapter::AvailitySftp)
            && !crate::sftp_transport::credentials_available(r)
    }) {
        "sftp_credentials_unavailable"
    } else if !valid {
        "route_not_configured_or_mismatched"
    } else if route.is_some_and(|r| r.credential_env.is_some())
        && token.as_ref().is_none_or(|v| v.trim().is_empty())
    {
        "credential_unavailable"
    } else if out.status != "prepared"
        || c.status != "ready"
        || c.version != out.claim_version
        || p.version != out.partner_version
        || p.content["active"] != true
        || crate::retrieval::connection_paused(&mut tx, &a, &j.route_key).await?
    {
        "artifact_claim_or_partner_changed"
    } else {
        ""
    };
    if !block.is_empty() {
        sqlx::query("UPDATE edi_delivery_jobs SET status='blocked',last_result=$3,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(block).execute(&mut *tx).await?;
        event(
            &mut tx,
            &a,
            id,
            "Delivery held before network I/O",
            json!({"result":block,"network_sent":false}),
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    let route = route.unwrap().clone();
    let lease = Uuid::new_v4();
    sqlx::query("UPDATE edi_delivery_jobs SET status='leased',lease_id=$3,lease_until=now()+interval '45 seconds',attempts=attempts+1,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(lease).execute(&mut *tx).await?;
    event(&mut tx,&a,id,"Automated delivery attempt leased",json!({"attempt":j.attempts+1,"submission_id":out.id,"payload_hash":out.payload_hash,"requested_by":j.requested_by})).await?;
    tx.commit().await?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| Error::Invalid("gateway HTTP client unavailable"))?;
    let mut receipt = None;
    let mut provider_ack = None;
    let mut safe_retry = false;
    let mut result = "ambiguous_network_result";
    if matches!(
        route.adapter,
        Adapter::OfficeAllySftp | Adapter::AvailitySftp
    ) {
        if let Ok(reference) = crate::sftp_transport::upload(&route, &out).await {
            result = "sftp_upload_confirmed";
            receipt = Some(Receipt {
                status: "received".into(),
                submission_id: out.id,
                payload_sha256: out.payload_hash.clone(),
                receipt_reference: reference,
            });
        }
    } else if route.adapter == Adapter::ClaimMd {
        if let Ok(Some(reference)) = crate::claimmd::upload(&route, &out).await {
            result = "claimmd_upload_confirmed";
            receipt = Some(Receipt {
                status: "received".into(),
                submission_id: out.id,
                payload_sha256: out.payload_hash.clone(),
                receipt_reference: reference,
            });
        }
    } else {
        let mut request = if route.adapter == Adapter::Stedi {
            client
                .post(&route.endpoint)
                .header("Idempotency-Key", out.id.to_string())
                .json(&json!({"x12":out.payload}))
        } else {
            client.post(&route.endpoint).header("Idempotency-Key",out.id.to_string()).json(&json!({"submission_id":out.id,"payload_sha256":out.payload_hash,"usage":route.usage,"format":"005010X222A1","x12":out.payload}))
        };
        if route.loopback_test && route.adapter == Adapter::Stedi && token.is_none() {
            request = request.header("Authorization", "synthetic-loopback-key");
        }
        if let Some(token) = token {
            request = if route.adapter == Adapter::Stedi {
                request.header("Authorization", token)
            } else {
                request.bearer_auth(token)
            };
        }

        match request.send().await {
            Err(e) => {
                if e.is_connect() {
                    safe_retry = true;
                    result = "connection_not_established";
                }
            }
            Ok(mut response) => {
                let code = response.status().as_u16();
                let mut bytes = vec![];
                let mut bounded = true;
                loop {
                    match response.chunk().await {
                        Ok(Some(chunk)) => {
                            if bytes.len() + chunk.len() > 65536 {
                                bounded = false;
                                break;
                            }
                            bytes.extend_from_slice(&chunk);
                        }
                        Ok(None) => break,
                        Err(_) => {
                            bounded = false;
                            break;
                        }
                    }
                }
                if bounded && route.adapter == Adapter::Stedi {
                    if let Some(confirmed) = crate::stedi::receipt(code, &bytes, &out) {
                        result = "stedi_receipt_confirmed";
                        receipt = Some(Receipt {
                            status: "received".into(),
                            submission_id: out.id,
                            payload_sha256: out.payload_hash.clone(),
                            receipt_reference: confirmed.correlation.clone(),
                        });
                        provider_ack = Some(confirmed);
                    } else if [400, 401, 403, 422].contains(&code) {
                        result = "gateway_rejected_before_receipt";
                    }
                } else if bounded {
                    if let Ok(r) = serde_json::from_slice::<Receipt>(&bytes) {
                        if r.submission_id == out.id
                            && r.payload_sha256 == out.payload_hash
                            && !r.receipt_reference.trim().is_empty()
                            && r.receipt_reference.len() <= 200
                        {
                            if [200, 201, 409].contains(&code) && r.status == "received" {
                                result = "receipt_confirmed";
                                receipt = Some(r);
                            } else if [429, 503].contains(&code) && r.status == "not_received" {
                                safe_retry = true;
                                result = "confirmed_not_received";
                            } else if [400, 401, 403, 422].contains(&code)
                                && r.status == "not_received"
                            {
                                result = "gateway_rejected_before_receipt";
                            }
                        }
                    }
                }
            }
        }
    }
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let now = job(&mut tx, &a, id).await?;
    if now.status != "leased" || now.lease_id != Some(lease) {
        return Ok(true);
    }
    if let Some(r) = receipt {
        delivered(&mut tx,&a,&now,&r.receipt_reference,json!({"submission_id":r.submission_id,"payload_sha256":r.payload_sha256,"receipt_reference":r.receipt_reference,"status":r.status,"adapter":route.adapter,"proof":match route.adapter {Adapter::Stedi=>"matching_patient_control_receipt",Adapter::ClaimMd=>"matching_claim_file_receipt",Adapter::OfficeAllySftp|Adapter::AvailitySftp=>"ssh_sftp_write_and_rename",Adapter::Gateway=>"matching_payload_hash_receipt"}}),"Transport confirmed artifact receipt").await?;
        if let Some(ack) = provider_ack {
            crate::retrieval::initial_ack(&mut tx, &a, &route, &ack, out.id).await?;
        }
    } else {
        let state = if safe_retry && now.attempts < 3 {
            "retry"
        } else if safe_retry || result == "gateway_rejected_before_receipt" {
            "blocked"
        } else {
            "unknown"
        };
        let delay = 2i32.pow(now.attempts.min(6) as u32) * 5;
        sqlx::query("UPDATE edi_delivery_jobs SET status=$3,last_result=$4,lease_id=NULL,lease_until=NULL,next_attempt_at=now()+make_interval(secs=>$5),version=version+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(state).bind(result).bind(delay as f64).execute(&mut *tx).await?;
    }
    event(&mut tx,&a,id,"Automated delivery result recorded",json!({"network_result":result,"safe_retry":safe_retry,"receipt_required_for_delivery":true})).await?;
    tx.commit().await?;
    Ok(true)
}
pub async fn run(pool: PgPool, config: Config) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        if process_one(&pool, &config).await.is_err() {
            eprintln!("Clearinghouse delivery processing failed; durable job requires inspection");
        }
    }
}
