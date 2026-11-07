// SPDX-License-Identifier: AGPL-3.0-only
//! Durable, instance-local event delivery for exact automation triggers.
//!
//! This module does not execute provider actions. It records an immutable event once,
//! fans it out to exact active subscriptions, and leases delivery work to a bounded
//! internal dispatcher. External communication continues through reviewed adapters.
//!
//! Delivery is deliberately at-least-once: an expired lease is reclaimed on the same
//! delivery row with a new lease token. The stable `idempotency_key` never changes.
//! Dispatchers must not perform clinical writes, communications, or charges directly;
//! they submit any effectful action to `action_governance` using that key. This keeps a
//! worker crash after submission from silently duplicating the effect on lease recovery.

use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    model::text,
    postgres::audit,
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

#[expect(
    dead_code,
    reason = "used by native event producers as they are integrated"
)]
const MAX_EVENT_BYTES: usize = 262_144;
const MAX_EVIDENCE_BYTES: usize = 32_768;

fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}

fn no_store(value: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

fn owner(actor: &Actor) -> Result<()> {
    if matches!(actor.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

fn component_key(value: &str) -> bool {
    let mut segments = value.split('.');
    let Some(first) = segments.next() else {
        return false;
    };
    let valid_segment = |segment: &str, first_segment: bool| {
        !segment.is_empty()
            && segment.len() <= 80
            && segment.chars().enumerate().all(|(index, character)| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || (!first_segment && index > 0 && matches!(character, '_' | '-'))
            })
            && (!first_segment
                || first
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_lowercase()))
    };
    if !valid_segment(first, true) {
        return false;
    }
    let rest: Vec<_> = segments.collect();
    !rest.is_empty()
        && rest
            .into_iter()
            .all(|segment| valid_segment(segment, false))
}

fn catalog_key(value: &str) -> bool {
    value.len() >= 2
        && value.len() <= 160
        && value.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' | b'0'..=b'9' => true,
            b'.' | b'_' | b'-' => index > 0,
            _ => false,
        })
        && !value.ends_with(['.', '_', '-'])
}

fn event_type(value: &str) -> bool {
    if value.len() > 180 || !component_key(value) || value.split('.').count() < 3 {
        return false;
    }
    !value.split('.').any(|segment| {
        matches!(
            segment,
            "all" | "any" | "generic" | "everything" | "wildcard" | "*"
        )
    })
}

fn bounded_object(value: &Value, limit: usize, message: &'static str) -> Result<()> {
    if !value.is_object() || serde_json::to_vec(value).map_or(true, |encoded| encoded.len() > limit)
    {
        return Err(Error::Invalid(message));
    }
    Ok(())
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "used by the isolated delivery worker API")
)]
fn error_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateSubscription {
    connector_key: String,
    trigger_key: String,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SubscriptionAction {
    action: String,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeliveryAction {
    action: String,
    reason: String,
}

#[derive(Deserialize)]
struct PageQuery {
    status: Option<String>,
}

/// Input used by native EHR modules while their own mutation transaction is open.
#[expect(dead_code, reason = "native event producers integrate incrementally")]
pub(crate) struct NewAutomationEvent {
    pub event_type: String,
    pub source: String,
    pub source_event_id: String,
    pub payload: Value,
    pub classification: String,
    pub occurred_at: DateTime<Utc>,
    pub retention_days: i64,
}

#[derive(Debug, Serialize)]
#[expect(dead_code, reason = "native event producers integrate incrementally")]
pub(crate) struct EmitResult {
    pub id: Uuid,
    pub created: bool,
    pub deliveries: usize,
}

#[derive(Debug, Serialize)]
#[expect(dead_code, reason = "delivery worker integration is a separate lane")]
pub(crate) struct LeasedDelivery {
    pub tenant_id: Uuid,
    pub delivery_id: Uuid,
    pub event_id: Uuid,
    pub subscription_id: Uuid,
    pub event_type: String,
    pub payload: Value,
    pub classification: String,
    pub attempt: i32,
    pub lease_token: Uuid,
    /// Stable across lease expiry and retry. Never substitute the rotating lease token.
    pub idempotency_key: String,
}

fn delivery_idempotency_key(tenant: Uuid, event: Uuid, subscription: Uuid) -> String {
    crate::oauth::hash(&format!(
        "automation-delivery\n{tenant}\n{event}\n{subscription}"
    ))
}

pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/automation/subscriptions",
            get(list_subscriptions).post(create_subscription),
        )
        .route(
            "/api/v1/automation/subscriptions/{id}/actions",
            post(subscription_action),
        )
        .route("/api/v1/automation/events", get(list_events))
        .route("/api/v1/automation/events/{id}", get(event_detail))
        .route("/api/v1/automation/deliveries", get(list_deliveries))
        .route(
            "/api/v1/automation/deliveries/{id}/actions",
            post(delivery_action),
        )
}

async fn create_subscription(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Json(input): Json<CreateSubscription>,
) -> Result<Response> {
    owner(&actor)?;
    text(&input.reason, 1_000)?;
    if !catalog_key(&input.connector_key) || !catalog_key(&input.trigger_key) {
        return Err(Error::Invalid("invalid exact trigger identity"));
    }
    let mut tx = db(&state)?.begin().await?;
    let resolved:Option<(Uuid,String,String)>=sqlx::query_as("SELECT i.id,t->>'event_type',CASE t->>'transport' WHEN 'internal_event' THEN 'internal' ELSE t->>'transport' END FROM connector_installations i JOIN connector_installation_revisions r ON r.tenant_id=i.tenant_id AND r.installation_id=i.id AND r.revision=i.current_revision CROSS JOIN LATERAL jsonb_array_elements(r.manifest->'triggers') t WHERE i.tenant_id=$1 AND i.connector_id=$2 AND i.status='enabled' AND t->>'id'=$3")
        .bind(actor.tenant_id).bind(input.connector_key.trim()).bind(input.trigger_key.trim()).fetch_optional(&mut *tx).await?;
    let (installation_id, resolved_event_type, resolved_transport) =
        resolved.ok_or(Error::Conflict("enabled connector trigger was not found"))?;
    if !event_type(&resolved_event_type)
        || !matches!(
            resolved_transport.as_str(),
            "internal" | "webhook" | "websocket" | "polling"
        )
    {
        return Err(Error::Conflict("enabled connector trigger is invalid"));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO automation_trigger_subscriptions(tenant_id,id,installation_id,connector_key,trigger_key,event_type,transport,configuration,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8)")
        .bind(actor.tenant_id).bind(id).bind(installation_id).bind(input.connector_key.trim()).bind(input.trigger_key.trim())
        .bind(resolved_event_type).bind(resolved_transport).bind(actor.sub)
        .execute(&mut *tx).await?;
    subscription_history(&mut tx, &actor, id, "configured", &input.reason).await?;
    audit(&mut tx, &actor, "automation.subscription.create", id).await?;
    let value = subscription_snapshot(&mut tx, &actor, id).await?;
    tx.commit().await?;
    Ok(no_store(value))
}

async fn list_subscriptions(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Query(query): Query<PageQuery>,
) -> Result<Response> {
    actor.staff()?;
    if query
        .status
        .as_deref()
        .is_some_and(|status| !["configured", "active", "inactive", "error"].contains(&status))
    {
        return Err(Error::Invalid("invalid subscription status"));
    }
    let mut tx = db(&state)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(s)-'tenant_id'-'configuration' FROM automation_trigger_subscriptions s WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY configured_at DESC,id DESC LIMIT 100")
        .bind(actor.tenant_id).bind(query.status).fetch_all(&mut *tx).await?;
    audit(
        &mut tx,
        &actor,
        "automation.subscription.list",
        actor.tenant_id,
    )
    .await?;
    tx.commit().await?;
    Ok(no_store(json!({"items":items})))
}

async fn subscription_snapshot(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
) -> Result<Value> {
    sqlx::query_scalar("SELECT to_jsonb(s)-'tenant_id'-'configuration' FROM automation_trigger_subscriptions s WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}

async fn subscription_action(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<SubscriptionAction>,
) -> Result<Response> {
    owner(&actor)?;
    text(&input.reason, 1_000)?;
    let expected = crate::expected(&headers)?;
    let mut tx = db(&state)?.begin().await?;
    let current:Option<(String,i64,String)>=sqlx::query_as("SELECT s.status,s.version,i.status FROM automation_trigger_subscriptions s JOIN connector_installations i ON i.tenant_id=s.tenant_id AND i.id=s.installation_id WHERE s.tenant_id=$1 AND s.id=$2 FOR UPDATE OF s")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
    let (status, version, installation_status) = current.ok_or(Error::NotFound)?;
    if version != expected {
        return Err(Error::Conflict("trigger subscription changed; reload"));
    }
    let next = match input.action.as_str() {
        "activate"
            if installation_status == "enabled"
                && matches!(status.as_str(), "configured" | "inactive" | "error") =>
        {
            "active"
        }
        "deactivate" if status == "active" => "inactive",
        _ => return Err(Error::Conflict("invalid trigger subscription action")),
    };
    sqlx::query("UPDATE automation_trigger_subscriptions SET status=$3,version=version+1,activated_at=CASE WHEN $3='active' THEN now() ELSE activated_at END,deactivated_at=CASE WHEN $3='inactive' THEN now() ELSE deactivated_at END,updated_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).bind(next).execute(&mut *tx).await?;
    subscription_history(
        &mut tx,
        &actor,
        id,
        if next == "active" {
            "activated"
        } else {
            "deactivated"
        },
        &input.reason,
    )
    .await?;
    audit(
        &mut tx,
        &actor,
        if next == "active" {
            "automation.subscription.activate"
        } else {
            "automation.subscription.deactivate"
        },
        id,
    )
    .await?;
    let value = subscription_snapshot(&mut tx, &actor, id).await?;
    tx.commit().await?;
    Ok(no_store(value))
}

/// Atomically stores one immutable event and its deliveries. Call this inside the
/// native mutation transaction that produced the event so state and event commit together.
#[expect(dead_code, reason = "native event producers integrate incrementally")]
pub(crate) async fn emit_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    input: NewAutomationEvent,
) -> Result<EmitResult> {
    if !event_type(&input.event_type)
        || !component_key(&input.source)
        || input.source_event_id.is_empty()
        || input.source_event_id.len() > 240
        || !matches!(input.classification.as_str(), "non_phi" | "phi")
        || !(1..=365).contains(&input.retention_days)
    {
        return Err(Error::Invalid("invalid automation event"));
    }
    bounded_object(
        &input.payload,
        MAX_EVENT_BYTES,
        "automation event payload must be a bounded object",
    )?;
    let payload = serde_json::to_vec(&input.payload)
        .map_err(|_| Error::Invalid("invalid automation event payload"))?;
    let payload_digest = crate::oauth::hash(&String::from_utf8_lossy(&payload));
    let dedup_key = crate::oauth::hash(&format!(
        "{}\n{}\n{}\n{}",
        actor.tenant_id, input.source, input.source_event_id, input.event_type
    ));
    if let Some((id, existing_digest)) = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id,payload_digest FROM automation_events WHERE tenant_id=$1 AND dedup_key=$2",
    )
    .bind(actor.tenant_id)
    .bind(&dedup_key)
    .fetch_optional(&mut **tx)
    .await?
    {
        if existing_digest != payload_digest {
            return Err(Error::Conflict(
                "automation source event was reused with different payload",
            ));
        }
        let count:i64=sqlx::query_scalar("SELECT count(*) FROM automation_event_deliveries WHERE tenant_id=$1 AND event_id=$2 AND replay_of IS NULL")
            .bind(actor.tenant_id).bind(id).fetch_one(&mut **tx).await?;
        return Ok(EmitResult {
            id,
            created: false,
            deliveries: usize::try_from(count).unwrap_or(usize::MAX),
        });
    }
    let id = Uuid::new_v4();
    let retained_until = Utc::now() + Duration::days(input.retention_days);
    sqlx::query("INSERT INTO automation_events(tenant_id,id,event_type,source,source_event_id,dedup_key,payload,payload_digest,classification,occurred_at,retained_until,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)")
        .bind(actor.tenant_id).bind(id).bind(&input.event_type).bind(&input.source).bind(&input.source_event_id)
        .bind(&dedup_key).bind(&input.payload).bind(&payload_digest).bind(&input.classification)
        .bind(input.occurred_at).bind(retained_until).bind(actor.sub).execute(&mut **tx).await?;
    let subscriptions:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM automation_trigger_subscriptions WHERE tenant_id=$1 AND event_type=$2 AND status='active' ORDER BY id FOR SHARE")
        .bind(actor.tenant_id).bind(&input.event_type).fetch_all(&mut **tx).await?;
    for subscription in &subscriptions {
        let delivery = Uuid::new_v4();
        sqlx::query("INSERT INTO automation_event_deliveries(tenant_id,id,event_id,subscription_id,created_by) VALUES($1,$2,$3,$4,$5)")
            .bind(actor.tenant_id).bind(delivery).bind(id).bind(subscription).bind(actor.sub).execute(&mut **tx).await?;
        delivery_history(
            tx,
            actor.tenant_id,
            delivery,
            actor.sub,
            "created",
            json!({"event_type":input.event_type}),
        )
        .await?;
    }
    audit(tx, actor, "automation.event.emit", id).await?;
    Ok(EmitResult {
        id,
        created: true,
        deliveries: subscriptions.len(),
    })
}

async fn list_events(actor: Actor, ExtractState(state): ExtractState<State>) -> Result<Response> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT (to_jsonb(e)-'tenant_id'-'payload'-'dedup_key')||jsonb_build_object('delivery_count',(SELECT count(*) FROM automation_event_deliveries d WHERE d.tenant_id=e.tenant_id AND d.event_id=e.id)) FROM automation_events e WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100")
        .bind(actor.tenant_id).fetch_all(&mut *tx).await?;
    audit(&mut tx, &actor, "automation.event.list", actor.tenant_id).await?;
    tx.commit().await?;
    Ok(no_store(json!({"items":items})))
}

async fn event_detail(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    let event:Value=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id'-'dedup_key' FROM automation_events e WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let deliveries:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(d)-'tenant_id'-'lease_token'-'lease_owner' FROM automation_event_deliveries d WHERE tenant_id=$1 AND event_id=$2 ORDER BY created_at,id")
        .bind(actor.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    audit(&mut tx, &actor, "automation.event.read", id).await?;
    tx.commit().await?;
    Ok(no_store(json!({"event":event,"deliveries":deliveries})))
}

async fn list_deliveries(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Query(query): Query<PageQuery>,
) -> Result<Response> {
    actor.staff()?;
    if query.status.as_deref().is_some_and(|status| {
        !["pending", "leased", "delivered", "dead_letter", "cancelled"].contains(&status)
    }) {
        return Err(Error::Invalid("invalid delivery status"));
    }
    let mut tx = db(&state)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT (to_jsonb(d)-'tenant_id'-'lease_token'-'lease_owner')||jsonb_build_object('event_type',e.event_type,'connector_key',s.connector_key,'trigger_key',s.trigger_key) FROM automation_event_deliveries d JOIN automation_events e ON e.tenant_id=d.tenant_id AND e.id=d.event_id JOIN automation_trigger_subscriptions s ON s.tenant_id=d.tenant_id AND s.id=d.subscription_id WHERE d.tenant_id=$1 AND ($2::text IS NULL OR d.status=$2) ORDER BY d.created_at DESC,d.id DESC LIMIT 100")
        .bind(actor.tenant_id).bind(query.status).fetch_all(&mut *tx).await?;
    audit(&mut tx, &actor, "automation.delivery.list", actor.tenant_id).await?;
    tx.commit().await?;
    Ok(no_store(json!({"items":items})))
}

async fn delivery_action(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    Json(input): Json<DeliveryAction>,
) -> Result<Response> {
    owner(&actor)?;
    text(&input.reason, 1_000)?;
    let mut tx = db(&state)?.begin().await?;
    let row:Option<(Uuid,Uuid,String,DateTime<Utc>,String,String)>=sqlx::query_as("SELECT d.event_id,d.subscription_id,d.status,e.retained_until,s.status,i.status FROM automation_event_deliveries d JOIN automation_events e ON e.tenant_id=d.tenant_id AND e.id=d.event_id JOIN automation_trigger_subscriptions s ON s.tenant_id=d.tenant_id AND s.id=d.subscription_id JOIN connector_installations i ON i.tenant_id=s.tenant_id AND i.id=s.installation_id WHERE d.tenant_id=$1 AND d.id=$2 FOR UPDATE OF d")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
    let (event, subscription, status, retained_until, subscription_status, installation_status) =
        row.ok_or(Error::NotFound)?;
    let result = match input.action.as_str() {
        "cancel" if matches!(status.as_str(), "pending" | "dead_letter") => {
            sqlx::query("UPDATE automation_event_deliveries SET status='cancelled',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2")
                .bind(actor.tenant_id).bind(id).execute(&mut *tx).await?;
            delivery_history(
                &mut tx,
                actor.tenant_id,
                id,
                actor.sub,
                "cancelled",
                json!({"reason_digest":crate::oauth::hash(&input.reason)}),
            )
            .await?;
            json!({"id":id,"status":"cancelled"})
        }
        "replay" if matches!(status.as_str(), "dead_letter" | "cancelled") => {
            if retained_until <= Utc::now()
                || subscription_status != "active"
                || installation_status != "enabled"
            {
                return Err(Error::Conflict(
                    "retained evidence or active subscription is required for replay",
                ));
            }
            let replay = Uuid::new_v4();
            sqlx::query("INSERT INTO automation_event_deliveries(tenant_id,id,event_id,subscription_id,replay_of,created_by) VALUES($1,$2,$3,$4,$5,$6)")
                .bind(actor.tenant_id).bind(replay).bind(event).bind(subscription).bind(id).bind(actor.sub).execute(&mut *tx).await?;
            delivery_history(
                &mut tx,
                actor.tenant_id,
                replay,
                actor.sub,
                "replayed",
                json!({"replay_of":id,"reason_digest":crate::oauth::hash(&input.reason)}),
            )
            .await?;
            json!({"id":replay,"status":"pending","replay_of":id})
        }
        _ => return Err(Error::Conflict("invalid automation delivery action")),
    };
    audit(&mut tx, &actor, "automation.delivery.action", id).await?;
    tx.commit().await?;
    Ok(no_store(result))
}

async fn subscription_history(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    subscription: Uuid,
    action: &str,
    reason: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO automation_trigger_subscription_history(tenant_id,subscription_id,actor_id,action,reason_digest) VALUES($1,$2,$3,$4,$5)")
        .bind(actor.tenant_id)
        .bind(subscription)
        .bind(actor.sub)
        .bind(action)
        .bind(crate::oauth::hash(reason))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn delivery_history(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    delivery: Uuid,
    actor: Uuid,
    action: &str,
    evidence: Value,
) -> Result<()> {
    bounded_object(
        &evidence,
        MAX_EVIDENCE_BYTES,
        "invalid automation delivery evidence",
    )?;
    sqlx::query("INSERT INTO automation_event_delivery_history(tenant_id,delivery_id,actor_id,action,evidence) VALUES($1,$2,$3,$4,$5)")
        .bind(tenant).bind(delivery).bind(actor).bind(action).bind(evidence).execute(&mut **tx).await?;
    Ok(())
}

async fn worker_audit(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    worker: Uuid,
    action: &str,
    resource: Uuid,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,$3,$4)",
    )
    .bind(tenant)
    .bind(worker)
    .bind(action)
    .bind(resource)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Erases expired PHI payloads while retaining their digest and immutable audit metadata.
/// Events with pending delivery work are skipped until delivery reaches a terminal state.
pub(crate) async fn erase_expired_phi_payloads(
    pool: &PgPool,
    worker_id: Uuid,
    limit: i64,
) -> Result<u64> {
    if !(1..=1_000).contains(&limit) {
        return Err(Error::Invalid("invalid automation retention batch"));
    }
    let mut tx = pool.begin().await?;
    let expired: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT e.tenant_id,e.id FROM automation_events e \
         WHERE e.classification='phi' AND e.payload_erased_at IS NULL \
           AND e.retained_until<=now() \
           AND NOT EXISTS (SELECT 1 FROM automation_event_deliveries d \
             WHERE d.tenant_id=e.tenant_id AND d.event_id=e.id \
               AND d.status IN ('pending','leased')) \
         ORDER BY e.retained_until,e.tenant_id,e.id \
         FOR UPDATE OF e SKIP LOCKED LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&mut *tx)
    .await?;
    for (tenant, event_id) in &expired {
        sqlx::query("UPDATE automation_events SET payload='{}'::jsonb,payload_erased_at=now() WHERE tenant_id=$1 AND id=$2 AND payload_erased_at IS NULL")
            .bind(tenant).bind(event_id).execute(&mut *tx).await?;
        worker_audit(
            &mut tx,
            *tenant,
            worker_id,
            "automation.event.payload_erased",
            *event_id,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(expired.len() as u64)
}

/// Runs the bounded retention pass independently from connector execution.
///
/// Failures are retried on the next interval; the worker never logs payloads or
/// other event data.
pub async fn run_retention(pool: PgPool) {
    const RETENTION_WORKER: Uuid = Uuid::from_u128(0x53c40000000040008000000000000031);
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        tick.tick().await;
        let _ = erase_expired_phi_payloads(&pool, RETENTION_WORKER, 250).await;
    }
}

/// Claims due deliveries without holding a database transaction during execution.
///
/// An expired lease is intentionally eligible again, so consumers must assume
/// at-least-once delivery. Effectful consumers must submit through `action_governance`
/// with [`LeasedDelivery::idempotency_key`]; direct provider calls are outside this
/// runtime's contract.
#[expect(dead_code, reason = "delivery worker integration is a separate lane")]
pub(crate) async fn lease_deliveries(
    pool: &PgPool,
    worker_id: Uuid,
    worker_name: &str,
    limit: i64,
    lease_seconds: i64,
) -> Result<Vec<LeasedDelivery>> {
    if worker_name.is_empty()
        || worker_name.len() > 120
        || !(1..=100).contains(&limit)
        || !(10..=300).contains(&lease_seconds)
    {
        return Err(Error::Invalid("invalid automation delivery lease"));
    }
    let mut tx = pool.begin().await?;
    let exhausted:Vec<(Uuid,Uuid)>=sqlx::query_as("SELECT tenant_id,id FROM automation_event_deliveries WHERE status='leased' AND lease_expires_at<=now() AND attempt_count>=max_attempts ORDER BY tenant_id,id FOR UPDATE SKIP LOCKED LIMIT 100")
        .fetch_all(&mut *tx).await?;
    for (tenant, delivery) in exhausted {
        sqlx::query("UPDATE automation_event_deliveries SET status='dead_letter',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_code=COALESCE(last_error_code,'attempts_exhausted'),updated_at=now() WHERE tenant_id=$1 AND id=$2")
            .bind(tenant).bind(delivery).execute(&mut *tx).await?;
        delivery_history(
            &mut tx,
            tenant,
            delivery,
            worker_id,
            "dead_lettered",
            json!({"reason_code":"attempts_exhausted"}),
        )
        .await?;
        worker_audit(
            &mut tx,
            tenant,
            worker_id,
            "automation.delivery.dead_letter",
            delivery,
        )
        .await?;
    }
    type DeliveryCandidate = (Uuid, Uuid, Uuid, Uuid, String, Value, String, i32);
    let candidates:Vec<DeliveryCandidate>=sqlx::query_as("SELECT d.tenant_id,d.id,d.event_id,d.subscription_id,e.event_type,e.payload,e.classification,d.attempt_count FROM automation_event_deliveries d JOIN automation_events e ON e.tenant_id=d.tenant_id AND e.id=d.event_id JOIN automation_trigger_subscriptions s ON s.tenant_id=d.tenant_id AND s.id=d.subscription_id JOIN connector_installations i ON i.tenant_id=s.tenant_id AND i.id=s.installation_id WHERE i.status='enabled' AND s.status='active' AND d.attempt_count<d.max_attempts AND ((d.status='pending' AND d.next_attempt_at<=now()) OR (d.status='leased' AND d.lease_expires_at<=now())) ORDER BY d.next_attempt_at,d.tenant_id,d.id FOR UPDATE OF d SKIP LOCKED LIMIT $1")
        .bind(limit).fetch_all(&mut *tx).await?;
    let mut leased = Vec::with_capacity(candidates.len());
    for (
        tenant,
        delivery,
        event,
        subscription,
        event_type,
        payload,
        classification,
        attempt_count,
    ) in candidates
    {
        let token = Uuid::new_v4();
        let attempt = attempt_count + 1;
        sqlx::query("UPDATE automation_event_deliveries SET status='leased',attempt_count=$3,lease_token=$4,lease_owner=$5,lease_expires_at=now()+make_interval(secs=>$6),updated_at=now() WHERE tenant_id=$1 AND id=$2")
            .bind(tenant).bind(delivery).bind(attempt).bind(token).bind(worker_name).bind(lease_seconds as f64).execute(&mut *tx).await?;
        delivery_history(
            &mut tx,
            tenant,
            delivery,
            worker_id,
            "leased",
            json!({"attempt":attempt}),
        )
        .await?;
        worker_audit(
            &mut tx,
            tenant,
            worker_id,
            "automation.delivery.lease",
            delivery,
        )
        .await?;
        leased.push(LeasedDelivery {
            tenant_id: tenant,
            delivery_id: delivery,
            event_id: event,
            subscription_id: subscription,
            event_type,
            payload,
            classification,
            attempt,
            lease_token: token,
            idempotency_key: delivery_idempotency_key(tenant, event, subscription),
        });
    }
    tx.commit().await?;
    Ok(leased)
}

#[expect(dead_code, reason = "delivery worker integration is a separate lane")]
pub(crate) async fn complete_delivery(
    pool: &PgPool,
    tenant: Uuid,
    delivery: Uuid,
    lease_token: Uuid,
    worker_id: Uuid,
    result_code: &str,
) -> Result<()> {
    if !error_code(result_code) {
        return Err(Error::Invalid("invalid automation delivery result"));
    }
    let mut tx = pool.begin().await?;
    let changed=sqlx::query("UPDATE automation_event_deliveries SET status='delivered',delivered_at=now(),lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_code=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='leased' AND lease_token=$3")
        .bind(tenant).bind(delivery).bind(lease_token).execute(&mut *tx).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::Conflict("automation delivery lease changed"));
    }
    delivery_history(
        &mut tx,
        tenant,
        delivery,
        worker_id,
        "delivered",
        json!({"result_code":result_code}),
    )
    .await?;
    worker_audit(
        &mut tx,
        tenant,
        worker_id,
        "automation.delivery.complete",
        delivery,
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

#[expect(dead_code, reason = "delivery worker integration is a separate lane")]
pub(crate) async fn fail_delivery(
    pool: &PgPool,
    tenant: Uuid,
    delivery: Uuid,
    lease_token: Uuid,
    worker_id: Uuid,
    failure: &str,
    retry_seconds: i64,
) -> Result<String> {
    if !error_code(failure) || !(10..=86_400).contains(&retry_seconds) {
        return Err(Error::Invalid("invalid automation delivery failure"));
    }
    let mut tx = pool.begin().await?;
    let row:Option<(i32,i32)>=sqlx::query_as("SELECT attempt_count,max_attempts FROM automation_event_deliveries WHERE tenant_id=$1 AND id=$2 AND status='leased' AND lease_token=$3 FOR UPDATE")
        .bind(tenant).bind(delivery).bind(lease_token).fetch_optional(&mut *tx).await?;
    let (attempt, max) = row.ok_or(Error::Conflict("automation delivery lease changed"))?;
    let status = if attempt >= max {
        "dead_letter"
    } else {
        "pending"
    };
    sqlx::query("UPDATE automation_event_deliveries SET status=$4,next_attempt_at=CASE WHEN $4='pending' THEN now()+make_interval(secs=>$5) ELSE next_attempt_at END,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_code=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_token=$3")
        .bind(tenant).bind(delivery).bind(lease_token).bind(status).bind(retry_seconds as f64).bind(failure).execute(&mut *tx).await?;
    delivery_history(
        &mut tx,
        tenant,
        delivery,
        worker_id,
        if status == "pending" {
            "retry_scheduled"
        } else {
            "dead_lettered"
        },
        json!({"failure_code":failure,"attempt":attempt}),
    )
    .await?;
    worker_audit(
        &mut tx,
        tenant,
        worker_id,
        if status == "pending" {
            "automation.delivery.retry"
        } else {
            "automation.delivery.dead_letter"
        },
        delivery,
    )
    .await?;
    tx.commit().await?;
    Ok(status.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_event_types_reject_generic_or_wildcard_triggers() {
        assert!(event_type("suncharts.appointment.booked"));
        assert!(event_type("ringcentral.message.received"));
        assert!(!event_type("appointment.booked"));
        assert!(!event_type("suncharts.all.events"));
        assert!(!event_type("suncharts.appointment.*"));
        assert!(!event_type("generic.webhook.received"));
    }

    #[test]
    fn catalog_keys_are_bounded_and_non_executable() {
        assert!(catalog_key("org.example.messaging"));
        assert!(catalog_key("message_received"));
        assert!(!catalog_key("https://example.test/hook"));
        assert!(!catalog_key("../script"));
    }

    #[test]
    fn runtime_bounds_worker_and_failure_inputs() {
        assert!(error_code("provider_unavailable"));
        assert!(!error_code("Provider said: patient not found"));
        assert!(!error_code(""));
        assert!(bounded_object(&json!({"status":"synthetic"}), 128, "invalid").is_ok());
        assert!(bounded_object(&json!(["not an object"]), 128, "invalid").is_err());
    }

    #[test]
    fn retry_idempotency_is_stable_for_event_subscription_pair() {
        let tenant = Uuid::from_u128(1);
        let event = Uuid::from_u128(2);
        let subscription = Uuid::from_u128(3);
        let key = delivery_idempotency_key(tenant, event, subscription);
        assert_eq!(key, delivery_idempotency_key(tenant, event, subscription));
        assert_ne!(
            key,
            delivery_idempotency_key(tenant, Uuid::from_u128(4), subscription)
        );
        assert_ne!(
            key,
            delivery_idempotency_key(tenant, event, Uuid::from_u128(5))
        );
        assert_ne!(
            key,
            delivery_idempotency_key(Uuid::from_u128(6), event, subscription)
        );
        assert_eq!(key.len(), 64);
    }
}
