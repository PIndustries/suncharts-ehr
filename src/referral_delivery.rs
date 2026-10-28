// SPDX-License-Identifier: AGPL-3.0-only
//! Reviewed HTTP referral packages. Transport acceptance never means clinical acceptance.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    postgres::audit,
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::HeaderMap,
    routing::{get, post, put},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use uuid::Uuid;
const PURPOSE: &str = "referral-delivery";
const MAX_PACKAGE: usize = 20 * 1024 * 1024;
pub fn routes() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/referral-delivery/destinations",
            get(destinations).post(create_destination),
        )
        .route(
            "/api/v1/referral-delivery/destinations/{id}",
            put(update_destination),
        )
        .route(
            "/api/v1/patients/{patient}/referrals/{id}/delivery/preview",
            post(preview),
        )
        .route(
            "/api/v1/patients/{patient}/referrals/{id}/delivery",
            post(queue),
        )
        .route(
            "/api/v1/patients/{patient}/referrals/{id}/deliveries",
            get(jobs),
        )
        .route("/api/v1/referral-delivery/jobs/{id}", get(read_job))
        .route("/api/v1/referral-delivery/jobs/{id}/actions", post(action))
}
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
async fn owner(s: &State, h: &HeaderMap) -> Result<Actor> {
    let a = s
        .browser
        .as_ref()
        .ok_or(Error::Unauthorized)?
        .authenticate(h, true)
        .await?;
    if !matches!(a.role, Role::Owner) {
        return Err(Error::Forbidden);
    }
    Ok(a)
}
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(v).unwrap()))
}
#[derive(Clone, sqlx::FromRow)]
struct Destination {
    id: Uuid,
    name: String,
    endpoint: String,
    enabled: bool,
    loopback_test: bool,
    version: i64,
    encrypted_credential: Vec<u8>,
    creation_hash: String,
}
impl Destination {
    fn public(&self) -> Value {
        json!({"id":self.id,"name":self.name,"endpoint":self.endpoint,"enabled":self.enabled,"loopback_test":self.loopback_test,"version":self.version,"credential_configured":!self.encrypted_credential.is_empty()})
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DestinationInput {
    request_id: Option<Uuid>,
    name: String,
    endpoint: String,
    enabled: bool,
    #[serde(default)]
    loopback_test: bool,
    bearer_token: Option<String>,
    reason: String,
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let b = v.octets();
            !v.is_private()
                && !v.is_loopback()
                && !v.is_link_local()
                && !v.is_unspecified()
                && !v.is_multicast()
                && !v.is_broadcast()
                && !v.is_documentation()
                && b[0] != 0
                && b[0] < 224
                && !(b[0] == 100 && (64..=127).contains(&b[1]))
                && !(b[0] == 198 && (b[1] == 18 || b[1] == 19))
        }
        IpAddr::V6(v) => {
            let b = v.segments();
            !v.is_loopback()
                && !v.is_unspecified()
                && !v.is_unique_local()
                && !v.is_unicast_link_local()
                && !v.is_multicast()
                && v.to_ipv4_mapped().is_none()
                && b[0] & 0xe000 == 0x2000
                && !(b[0] == 0x2001 && b[1] == 0x0db8)
        }
    }
}
fn target(url: &str, test: bool) -> Result<url::Url> {
    let u = url::Url::parse(url).map_err(|_| Error::Invalid("invalid referral destination"))?;
    if u.as_str().len() > 2000
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || u.query().is_some()
    {
        return Err(Error::Invalid("invalid referral destination"));
    }
    let host = u
        .host_str()
        .ok_or(Error::Invalid("missing referral destination host"))?;
    if test {
        if std::env::var("ENGINE_REFERRAL_ALLOW_LOOPBACK").as_deref() != Ok("true")
            || u.scheme() != "http"
            || !matches!(host, "127.0.0.1" | "[::1]")
        {
            return Err(Error::Invalid(
                "loopback referral delivery requires explicit synthetic-test configuration",
            ));
        }
    } else {
        if u.scheme() != "https"
            || u.port_or_known_default() != Some(443)
            || host.parse::<IpAddr>().is_ok()
        {
            return Err(Error::Invalid(
                "referral delivery requires an approved HTTPS hostname on port443",
            ));
        }
        let allowed = std::env::var("ENGINE_REFERRAL_ALLOWED_HOSTS").unwrap_or_default();
        if !allowed
            .split(',')
            .any(|x| x.trim().eq_ignore_ascii_case(host))
        {
            return Err(Error::Invalid(
                "referral destination hostname is not operator-approved",
            ));
        }
    }
    Ok(u)
}
async fn client(url: &str, test: bool) -> Result<reqwest::Client> {
    let u = target(url, test)?;
    let host = u
        .host_str()
        .ok_or(Error::Invalid("missing host"))?
        .trim_matches(['[', ']']);
    let port = u
        .port_or_known_default()
        .ok_or(Error::Invalid("missing port"))?;
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| Error::Invalid("referral destination resolution failed"))?
        .collect();
    if addresses.is_empty()
        || addresses.iter().any(|a| {
            if test {
                !a.ip().is_loopback()
            } else {
                !public_ip(a.ip())
            }
        })
    {
        return Err(Error::Invalid(
            "referral destination resolved to a disallowed address",
        ));
    }
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| Error::Invalid("referral HTTP client unavailable"))
}
async fn destination(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    id: Uuid,
    lock: bool,
) -> Result<Destination> {
    let q=format!("SELECT tenant_id,id,name,endpoint,enabled,loopback_test,version,encrypted_credential,creation_hash FROM referral_delivery_destinations WHERE tenant_id=$1 AND id=$2{}",if lock{" FOR SHARE"}else{""});
    sqlx::query_as(&q)
        .bind(tenant)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn destinations(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let rows:Vec<Destination>=sqlx::query_as("SELECT tenant_id,id,name,endpoint,enabled,loopback_test,version,encrypted_credential,creation_hash FROM referral_delivery_destinations WHERE tenant_id=$1 ORDER BY name,id LIMIT 101").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    if rows.len() > 100 {
        return Err(Error::Invalid("referral destination directory exceeds100"));
    }
    audit(&mut tx, &a, "referral.destination.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":rows.iter().map(Destination::public).collect::<Vec<_>>()}),
    ))
}
fn validate_input(v: &DestinationInput) -> Result<()> {
    crate::model::text(&v.name, 200)?;
    crate::model::text(&v.reason, 1000)?;
    target(&v.endpoint, v.loopback_test)?;
    if v.bearer_token.as_ref().is_some_and(|v| {
        v.len() < 16 || v.len() > 4096 || !v.is_ascii() || v.chars().any(char::is_control)
    }) {
        return Err(Error::Invalid("invalid referral bearer credential"));
    }
    Ok(())
}
async fn destination_revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    d: &Destination,
    reason: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO referral_delivery_destination_revisions(tenant_id,destination_id,version,snapshot,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(d.id).bind(d.version).bind(d.public()).bind(a.sub).bind(reason).execute(&mut **tx).await?;
    audit(tx, a, "referral.destination.save", d.id).await
}
async fn create_destination(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<DestinationInput>,
) -> Result<Json<Value>> {
    let a = owner(&s, &h).await?;
    validate_input(&v)?;
    if v.loopback_test
        && !s
            .browser
            .as_ref()
            .unwrap()
            .origin()
            .starts_with("http://127.0.0.1")
    {
        return Err(Error::Forbidden);
    }
    let id = v
        .request_id
        .ok_or(Error::Invalid("request identity required"))?;
    let token = v
        .bearer_token
        .as_ref()
        .ok_or(Error::Invalid("bearer credential required"))?;
    let fingerprint = hash(&json!(v));
    let encrypted =
        crate::provider_settings::seal_secret(db(&s)?, a.tenant_id, id, PURPOSE, token).await?;
    let mut tx = db(&s)?.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,42))")
        .bind(format!("{}:{id}", a.tenant_id))
        .execute(&mut *tx)
        .await?;
    if let Ok(old) = destination(&mut tx, a.tenant_id, id, false).await {
        if old.creation_hash != fingerprint {
            return Err(Error::Conflict("destination request identity reused"));
        }
        audit(&mut tx, &a, "referral.destination.replay", id).await?;
        tx.commit().await?;
        return Ok(Json(old.public()));
    }
    sqlx::query("INSERT INTO referral_delivery_destinations(tenant_id,id,name,endpoint,enabled,loopback_test,encrypted_credential,creation_hash,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(a.tenant_id).bind(id).bind(v.name.trim()).bind(&v.endpoint).bind(v.enabled).bind(v.loopback_test).bind(encrypted).bind(fingerprint).bind(a.sub).execute(&mut *tx).await?;
    let d = destination(&mut tx, a.tenant_id, id, false).await?;
    destination_revision(&mut tx, &a, &d, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(d.public()))
}
async fn update_destination(
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<DestinationInput>,
) -> Result<Json<Value>> {
    let a = owner(&s, &h).await?;
    validate_input(&v)?;
    if v.request_id.is_some() {
        return Err(Error::Invalid("request_id is creation-only"));
    }
    if v.loopback_test
        && !s
            .browser
            .as_ref()
            .unwrap()
            .origin()
            .starts_with("http://127.0.0.1")
    {
        return Err(Error::Forbidden);
    }
    let expected = crate::expected(&h)?;
    let encrypted = if let Some(token) = &v.bearer_token {
        Some(crate::provider_settings::seal_secret(db(&s)?, a.tenant_id, id, PURPOSE, token).await?)
    } else {
        None
    };
    let mut tx = db(&s)?.begin().await?;
    let old:Destination=sqlx::query_as("SELECT tenant_id,id,name,endpoint,enabled,loopback_test,version,encrypted_credential,creation_hash FROM referral_delivery_destinations WHERE tenant_id=$1 AND id=$2 FOR UPDATE").bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    if old.version != expected {
        return Err(Error::Conflict("destination changed"));
    }
    sqlx::query("UPDATE referral_delivery_destinations SET name=$3,endpoint=$4,enabled=$5,loopback_test=$6,encrypted_credential=$7,version=version+1,updated_by=$8,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(v.name.trim()).bind(v.endpoint).bind(v.enabled).bind(v.loopback_test).bind(encrypted.unwrap_or(old.encrypted_credential)).bind(a.sub).execute(&mut *tx).await?;
    let d = destination(&mut tx, a.tenant_id, id, false).await?;
    destination_revision(&mut tx, &a, &d, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(d.public()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewInput {
    destination_id: Uuid,
}
async fn package(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    id: Uuid,
) -> Result<(i64, Value, Value)> {
    let (version,status,content,snapshot,visit):(i64,String,Value,Option<Value>,Option<Uuid>)=sqlx::query_as("SELECT version,status,content,attachment_snapshot,visit_id FROM referrals WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE").bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
    if status != "ready" {
        return Err(Error::Conflict(
            "review and mark the referral ready before external delivery",
        ));
    }
    let patient:Value=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'mrn',mrn,'given_name',given_name,'family_name',family_name,'birth_date',birth_date) FROM patients WHERE tenant_id=$1 AND id=$2 FOR SHARE").bind(a.tenant_id).bind(p).fetch_one(&mut **tx).await?;
    let mut ids: Vec<Uuid> = serde_json::from_value(content["document_ids"].clone())
        .map_err(|_| Error::Invalid("invalid referral documents"))?;
    ids.sort();
    let mut manifest_docs = vec![];
    let mut docs = vec![];
    let mut total = 0usize;
    for id in ids {
        let metadata = crate::documents::validate_link(tx, a.tenant_id, p, id).await?;
        let bytes: Vec<u8> = sqlx::query_scalar(
            "SELECT bytes FROM patient_documents WHERE tenant_id=$1 AND patient_id=$2 AND id=$3",
        )
        .bind(a.tenant_id)
        .bind(p)
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
        total += bytes.len();
        if total > MAX_PACKAGE {
            return Err(Error::Invalid("referral package attachments exceed20MiB"));
        }
        manifest_docs.push(metadata.clone());
        docs.push(json!({"metadata":metadata,"content_base64":STANDARD.encode(bytes)}));
    }
    if snapshot.as_ref() != Some(&json!(manifest_docs)) {
        return Err(Error::Conflict(
            "referral attachments changed; return to draft and review readiness",
        ));
    }
    let manifest = json!({"recipient":content["recipient"],"requested_service":content["requested_service"],"patient":patient,"documents":manifest_docs,"document_count":docs.len(),"total_bytes":total});
    Ok((
        version,
        json!({"schema":"suncharts-referral-v1","referral_id":id,"referral_version":version,"patient":patient,"visit_id":visit,"referral":content,"documents":docs}),
        manifest,
    ))
}
async fn preview(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    Json(v): Json<PreviewInput>,
) -> Result<Json<Value>> {
    a.clinical()?;
    let mut tx = db(&s)?.begin().await?;
    let (version, payload, manifest) = package(&mut tx, &a, p, id).await?;
    let d = destination(&mut tx, a.tenant_id, v.destination_id, true).await?;
    if !d.enabled {
        return Err(Error::Conflict("referral destination is disabled"));
    }
    target(&d.endpoint, d.loopback_test)?;
    let expires = Utc::now() + chrono::Duration::minutes(10);
    let digest = hash(
        &json!({"payload":payload,"destination_id":d.id,"destination_version":d.version,"endpoint":d.endpoint,"expires_at":expires}),
    );
    sqlx::query("INSERT INTO referral_delivery_previews(tenant_id,digest,referral_id,patient_id,referral_version,destination_id,destination_version,payload,manifest,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(a.tenant_id).bind(&digest).bind(id).bind(p).bind(version).bind(d.id).bind(d.version).bind(payload).bind(&manifest).bind(expires).execute(&mut *tx).await?;
    audit(&mut tx, &a, "referral.delivery.preview", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"referral_id":id,"referral_version":version,"destination":d.public(),"review_digest":digest,"manifest":manifest,"expires_at":expires}),
    ))
}
#[derive(Clone, sqlx::FromRow)]
struct Job {
    tenant_id: Uuid,
    id: Uuid,
    patient_id: Uuid,
    referral_id: Uuid,
    referral_version: i64,
    destination_id: Uuid,
    destination_version: i64,
    destination_name: String,
    endpoint: String,
    loopback_test: bool,
    encrypted_credential: Vec<u8>,
    payload: Value,
    manifest: Value,
    review_digest: String,
    status: String,
    version: i64,
    actor_id: Uuid,
    actor_role: String,
    reason: String,
    receipt: Option<String>,
    outcome_reason: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
const JOB_FIELDS:&str="tenant_id,id,patient_id,referral_id,referral_version,destination_id,destination_version,destination_name,endpoint,loopback_test,encrypted_credential,payload,manifest,review_digest,status,version,actor_id,actor_role,reason,receipt,outcome_reason,created_at,updated_at";
impl Job {
    fn public(&self) -> Value {
        json!({"id":self.id,"patient_id":self.patient_id,"version":self.version,"status":self.status,"referral_id":self.referral_id,"referral_version":self.referral_version,"destination_id":self.destination_id,"destination_version":self.destination_version,"destination_name":self.destination_name,"endpoint":self.endpoint,"manifest":self.manifest,"receipt":self.receipt,"outcome_reason":self.outcome_reason,"created_at":self.created_at,"updated_at":self.updated_at})
    }
    fn actor(&self) -> Result<Actor> {
        let now = Utc::now().timestamp();
        Ok(Actor {
            sub: self.actor_id,
            tenant_id: self.tenant_id,
            role: serde_json::from_value(json!(self.actor_role)).map_err(|_| Error::Forbidden)?,
            patient_id: None,
            iss: "suncharts-referral-worker".into(),
            aud: "suncharts-engine".into(),
            iat: now,
            exp: now + 120,
        })
    }
}
async fn job(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    id: Uuid,
    lock: bool,
) -> Result<Job> {
    let q = format!(
        "SELECT {JOB_FIELDS} FROM referral_delivery_jobs WHERE tenant_id=$1 AND id=$2{}",
        if lock { " FOR UPDATE" } else { "" }
    );
    sqlx::query_as(&q)
        .bind(tenant)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn event(tx: &mut Transaction<'_, Postgres>, a: &Actor, j: &Job, reason: &str) -> Result<()> {
    sqlx::query("INSERT INTO referral_delivery_events(tenant_id,job_id,version,status,actor_id,reason,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(a.tenant_id).bind(j.id).bind(j.version).bind(&j.status).bind(a.sub).bind(reason).bind(&j.receipt).execute(&mut **tx).await?;
    audit(tx, a, "referral.delivery.change", j.id).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueueInput {
    destination_id: Uuid,
    destination_version: i64,
    request_id: Uuid,
    review_digest: String,
    reason: String,
}
async fn queue(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<QueueInput>,
) -> Result<Json<Value>> {
    a.clinical()?;
    crate::model::text(&v.reason, 1000)?;
    let expected = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,43))")
        .bind(format!("{}:{}", a.tenant_id, v.request_id))
        .execute(&mut *tx)
        .await?;
    if let Ok(old) = job(&mut tx, a.tenant_id, v.request_id, false).await {
        if old.patient_id != p
            || old.referral_id != id
            || old.destination_id != v.destination_id
            || old.destination_version != v.destination_version
            || old.referral_version != expected
            || old.review_digest != v.review_digest
            || old.reason != v.reason.trim()
        {
            return Err(Error::Conflict("delivery request identity reused"));
        }
        audit(&mut tx, &a, "referral.delivery.replay", old.id).await?;
        tx.commit().await?;
        return Ok(Json(old.public()));
    }
    let (version, payload, manifest) = package(&mut tx, &a, p, id).await?;
    if version != expected {
        return Err(Error::Conflict("referral changed; review delivery again"));
    }
    let d = destination(&mut tx, a.tenant_id, v.destination_id, true).await?;
    if !d.enabled || d.version != v.destination_version {
        return Err(Error::Conflict(
            "destination changed or disabled; review delivery again",
        ));
    }
    target(&d.endpoint, d.loopback_test)?;
    let reviewed:Option<(Value,Value)>=sqlx::query_as("SELECT payload,manifest FROM referral_delivery_previews WHERE tenant_id=$1 AND digest=$2 AND referral_id=$3 AND patient_id=$4 AND referral_version=$5 AND destination_id=$6 AND destination_version=$7 AND expires_at>now()").bind(a.tenant_id).bind(&v.review_digest).bind(id).bind(p).bind(version).bind(d.id).bind(d.version).fetch_optional(&mut *tx).await?;
    if reviewed.as_ref() != Some(&(payload.clone(), manifest.clone())) {
        return Err(Error::Conflict(
            "review expired or package changed; review delivery again",
        ));
    }
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM referral_delivery_jobs WHERE tenant_id=$1 AND referral_id=$2 AND status IN ('queued','sending','uncertain'))").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
    if active {
        return Err(Error::Conflict(
            "referral already has an active delivery; reconcile it first",
        ));
    }
    sqlx::query("INSERT INTO referral_delivery_jobs(tenant_id,id,patient_id,referral_id,referral_version,destination_id,destination_version,destination_name,endpoint,loopback_test,encrypted_credential,payload,manifest,review_digest,status,actor_id,actor_role,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued',$15,$16,$17)")
 .bind(a.tenant_id).bind(v.request_id).bind(p).bind(id).bind(version).bind(d.id).bind(d.version).bind(d.name).bind(d.endpoint).bind(d.loopback_test).bind(d.encrypted_credential).bind(payload).bind(manifest).bind(v.review_digest).bind(a.sub).bind(serde_json::to_value(&a.role).unwrap().as_str().unwrap()).bind(v.reason.trim()).execute(&mut *tx).await?;
    let j = job(&mut tx, a.tenant_id, v.request_id, false).await?;
    event(&mut tx, &a, &j, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(j.public()))
}
async fn jobs(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM referrals WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)",
    )
    .bind(a.tenant_id)
    .bind(p)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let q=format!("SELECT {JOB_FIELDS} FROM referral_delivery_jobs WHERE tenant_id=$1 AND patient_id=$2 AND referral_id=$3 ORDER BY created_at DESC,id DESC LIMIT 101");
    let mut rows: Vec<Job> = sqlx::query_as(&q)
        .bind(a.tenant_id)
        .bind(p)
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    let truncated = rows.len() > 100;
    rows.truncate(100);
    audit(&mut tx, &a, "referral.delivery.read", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":rows.iter().map(Job::public).collect::<Vec<_>>(),"truncated":truncated}),
    ))
}
async fn read_job(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let j = job(&mut tx, a.tenant_id, id, false).await?;
    let mut history:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('version',version,'status',status,'actor_id',actor_id,'reason',reason,'receipt',receipt,'created_at',created_at) FROM referral_delivery_events WHERE tenant_id=$1 AND job_id=$2 ORDER BY version DESC LIMIT 101").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    audit(&mut tx, &a, "referral.delivery.read", id).await?;
    tx.commit().await?;
    let mut out = j.public();
    out["history_truncated"] = json!(history.len() > 100);
    history.truncate(100);
    out["history"] = json!(history);
    Ok(Json(out))
}
async fn mark_sent(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    j: &Job,
    receipt: &str,
) -> Result<()> {
    let row:Option<(i64,String)>=sqlx::query_as("SELECT version,status FROM referrals WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE").bind(j.tenant_id).bind(j.patient_id).bind(j.referral_id).fetch_optional(&mut **tx).await?;
    if row != Some((j.referral_version, "ready".into())) {
        return Err(Error::Conflict(
            "referral context changed; reconcile delivery evidence",
        ));
    }
    sqlx::query("UPDATE referrals SET status='sent',version=version+1,updated_by=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(j.tenant_id).bind(j.referral_id).bind(a.sub).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO referral_revisions(tenant_id,referral_id,version,status,visit_id,content,attachment_snapshot,author_id,reason,evidence) SELECT tenant_id,id,version,status,visit_id,content,attachment_snapshot,$3,'External gateway transport acceptance',$4 FROM referrals WHERE tenant_id=$1 AND id=$2").bind(j.tenant_id).bind(j.referral_id).bind(a.sub).bind(receipt).execute(&mut **tx).await?;
    audit(tx, a, "patient.referrals.external_sent", j.referral_id).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JobAction {
    action: String,
    #[serde(default)]
    receipt: String,
    reason: String,
}
async fn action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<JobAction>,
) -> Result<Json<Value>> {
    a.clinical()?;
    crate::model::text(&v.reason, 1000)?;
    let expected = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    let j = job(&mut tx, a.tenant_id, id, true).await?;
    if j.version != expected {
        return Err(Error::Conflict("delivery job changed"));
    }
    let status = match (v.action.as_str(), j.status.as_str()) {
        ("cancel", "queued") => "cancelled",
        ("reconcile_sent", "uncertain") => {
            valid_receipt(&v.receipt)?;
            "sent"
        }
        ("reconcile_not_sent", "uncertain") => {
            crate::model::text(&v.receipt, 200)?;
            "not_sent"
        }
        _ => return Err(Error::Conflict("delivery action is not allowed")),
    };
    sqlx::query("UPDATE referral_delivery_jobs SET status=$3,receipt=$4,outcome_reason=$5,version=version+1,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(status).bind(if v.receipt.is_empty(){None}else{Some(v.receipt.clone())}).bind(v.reason.trim()).execute(&mut *tx).await?;
    if status == "sent" {
        mark_sent(&mut tx, &a, &j, &v.receipt).await?
    }
    let j = job(&mut tx, a.tenant_id, id, false).await?;
    event(&mut tx, &a, &j, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(j.public()))
}
fn valid_receipt(s: &str) -> Result<()> {
    if s.is_empty()
        || s.len() > 200
        || !s
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
    {
        return Err(Error::Invalid(
            "receipt must be a bounded opaque identifier",
        ));
    }
    Ok(())
}
/// One durable attempt. A lease abandoned during transport becomes uncertain, never blindly retried.
pub async fn process_one(pool: &PgPool) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let recover:Option<(Uuid,Uuid)>=sqlx::query_as("SELECT tenant_id,id FROM referral_delivery_jobs WHERE status='sending' AND lease_until<now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1").fetch_optional(&mut *tx).await?;
    if let Some((tenant, id)) = recover {
        let q=format!("SELECT {JOB_FIELDS} FROM referral_delivery_jobs WHERE tenant_id=$1 AND id=$2 AND status='sending' AND lease_until<now()");
        let j: Job = sqlx::query_as(&q)
            .bind(tenant)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let a = j.actor()?;
        sqlx::query("UPDATE referral_delivery_jobs SET status='uncertain',version=version+1,outcome_reason='Transport lease expired; reconcile with receiver',lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(j.tenant_id).bind(j.id).execute(&mut *tx).await?;
        let j = job(&mut tx, j.tenant_id, j.id, false).await?;
        event(
            &mut tx,
            &a,
            &j,
            "Transport lease expired; receiver reconciliation required",
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    let q=format!("SELECT {JOB_FIELDS} FROM referral_delivery_jobs WHERE status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1");
    let Some(j): Option<Job> = sqlx::query_as(&q).fetch_optional(&mut *tx).await? else {
        tx.commit().await?;
        return Ok(false);
    };
    let a = j.actor()?;
    let d = destination(&mut tx, j.tenant_id, j.destination_id, true).await?;
    let authorized:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM browser_users WHERE tenant_id=$1 AND id=$2 AND NOT disabled AND role IN ('owner','clinician'))").bind(j.tenant_id).bind(j.actor_id).fetch_one(&mut *tx).await?;
    let package_current = match package(&mut tx, &a, j.patient_id, j.referral_id).await {
        Ok((version, payload, manifest)) => {
            version == j.referral_version && payload == j.payload && manifest == j.manifest
        }
        Err(Error::Conflict(_) | Error::Invalid(_) | Error::NotFound) => false,
        Err(e) => return Err(e),
    };
    if !authorized || !package_current || !d.enabled || d.version != j.destination_version {
        sqlx::query("UPDATE referral_delivery_jobs SET status='not_sent',version=version+1,outcome_reason='Destination, actor or reviewed package changed before dispatch',updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(j.tenant_id).bind(j.id).execute(&mut *tx).await?;
        let j = job(&mut tx, j.tenant_id, j.id, false).await?;
        event(
            &mut tx,
            &a,
            &j,
            "Destination, actor or reviewed package changed; no request sent",
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    sqlx::query("UPDATE referral_delivery_jobs SET status='sending',version=version+1,lease_until=now()+interval '90 seconds',updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(j.tenant_id).bind(j.id).execute(&mut *tx).await?;
    let sending = job(&mut tx, j.tenant_id, j.id, false).await?;
    event(&mut tx, &a, &sending, "Reviewed package dispatch started").await?;
    tx.commit().await?;
    let transport = send(&j).await;
    let mut tx = pool.begin().await?;
    let current = job(&mut tx, j.tenant_id, j.id, true).await?;
    // A delayed, verified receipt may resolve a lease-recovered job while its
    // original referral remains reserved. Never overwrite operator reconciliation.
    let late_acceptance =
        current.status == "uncertain" && matches!(&transport, Transport::Accepted(_));
    if current.status != "sending" && !late_acceptance {
        tx.commit().await?;
        return Ok(true);
    }
    let (status, receipt, reason) = match transport {
        Transport::Accepted(r) => (
            "sent",
            Some(r),
            "Receiver accepted the package; clinical acceptance remains unrecorded",
        ),
        Transport::NotSent => (
            "not_sent",
            None,
            "Pre-dispatch endpoint or credential validation failed; no request sent",
        ),
        Transport::Uncertain => (
            "uncertain",
            None,
            "No verified receiver acceptance; reconcile before another attempt",
        ),
    };
    sqlx::query("UPDATE referral_delivery_jobs SET status=$3,receipt=$4,outcome_reason=$5,version=version+1,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(j.tenant_id).bind(j.id).bind(status).bind(&receipt).bind(reason).execute(&mut *tx).await?;
    if let Some(receipt) = &receipt {
        mark_sent(&mut tx, &a, &j, receipt).await?
    }
    let updated = job(&mut tx, j.tenant_id, j.id, false).await?;
    event(&mut tx, &a, &updated, reason).await?;
    tx.commit().await?;
    Ok(true)
}
enum Transport {
    Accepted(String),
    NotSent,
    Uncertain,
}
async fn send(j: &Job) -> Transport {
    let Ok(client) = client(&j.endpoint, j.loopback_test).await else {
        return Transport::NotSent;
    };
    let Ok(secret) = crate::provider_settings::open_secret(
        j.tenant_id,
        j.destination_id,
        PURPOSE,
        &j.encrypted_credential,
    ) else {
        return Transport::NotSent;
    };
    let mut payload = j.payload.clone();
    payload["delivery_id"] = json!(j.id);
    let Ok(response) = client
        .post(&j.endpoint)
        .bearer_auth(secret.expose())
        .header(
            "Idempotency-Key",
            hash(&json!({"tenant":j.tenant_id,"delivery":j.id})),
        )
        .json(&payload)
        .send()
        .await
    else {
        return Transport::Uncertain;
    };
    let status = response.status();
    let Ok(bytes) = crate::stedi::bytes(response, 65536).await else {
        return Transport::Uncertain;
    };
    let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
        return Transport::Uncertain;
    };
    if status.is_success() && v["accepted"] == true && v["delivery_id"] == j.id.to_string() {
        if let Some(receipt) = v["receipt"].as_str().filter(|r| valid_receipt(r).is_ok()) {
            return Transport::Accepted(receipt.into());
        }
    }
    Transport::Uncertain
}
pub async fn run(pool: PgPool) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        if process_one(&pool).await.is_err() {
            eprintln!("Referral delivery unavailable; durable request retained")
        }
    }
}
pub(crate) async fn ensure_unreserved(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    id: Uuid,
) -> Result<()> {
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM referral_delivery_jobs WHERE tenant_id=$1 AND referral_id=$2 AND status IN ('queued','sending','uncertain'))").bind(tenant).bind(id).fetch_one(&mut **tx).await?;
    if active {
        return Err(Error::Conflict(
            "referral is reserved for external delivery; cancel or reconcile its job first",
        ));
    }
    Ok(())
}
