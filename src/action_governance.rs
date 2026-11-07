// SPDX-License-Identifier: AGPL-3.0-only
//! Stable governance boundary for native connector actions.
//!
//! This module records intent, review, execution and reconciliation. It deliberately does not
//! load scripts or execute arbitrary HTTP. Native adapters implement [`ConnectorActionExecutor`].
use crate::{
    auth::{Actor, Role},
    connector_catalog::{
        ActionDefinition as CatalogAction, ActionEffect as CatalogEffect,
        ApprovalPolicy as CatalogApproval, IdempotencyClass as CatalogIdempotency,
        RetryClass as CatalogRetry,
    },
    error::{Error, Result},
    postgres::audit,
    State,
};
use async_trait::async_trait;
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

const MAX_INPUT_BYTES: usize = 262_144;
const MAX_RESULT_BYTES: usize = 262_144;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationClass {
    Read,
    IdempotentUpdate,
    ClinicalWrite,
    Communication,
    Charge,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionAuthority {
    Staff,
    Scheduling,
    Rooming,
    Clinical,
    Owner,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    None,
    Owner,
    Clinician,
    OwnerOrClinician,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetryClass {
    Never,
    BoundedSafe,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedActionSpec {
    pub connector_key: String,
    pub action_key: String,
    pub action_version: String,
    pub operation_class: OperationClass,
    pub authority: ActionAuthority,
    pub approval_policy: ApprovalPolicy,
    pub retry_class: RetryClass,
    pub separation_of_duties: bool,
    pub max_attempts: u8,
}

fn manifest_authority(roles: &[String]) -> Result<ActionAuthority> {
    if roles.is_empty() || roles.iter().any(|role| role == "read_only") {
        return Ok(ActionAuthority::Owner);
    }
    if roles.iter().all(|role| matches!(role.as_str(), "owner")) {
        Ok(ActionAuthority::Owner)
    } else if roles
        .iter()
        .all(|role| matches!(role.as_str(), "owner" | "clinician"))
    {
        Ok(ActionAuthority::Clinical)
    } else if roles.iter().all(|role| {
        matches!(
            role.as_str(),
            "owner" | "clinician" | "nurse" | "medical_assistant"
        )
    }) {
        Ok(ActionAuthority::Rooming)
    } else if roles
        .iter()
        .all(|role| matches!(role.as_str(), "owner" | "clinician" | "front_desk"))
    {
        Ok(ActionAuthority::Scheduling)
    } else if roles.iter().all(|role| {
        matches!(
            role.as_str(),
            "owner" | "clinician" | "nurse" | "medical_assistant" | "front_desk"
        )
    }) {
        Ok(ActionAuthority::Staff)
    } else {
        Err(Error::Invalid("connector action roles cannot be governed"))
    }
}

async fn enabled_manifest_spec(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    connector_key: &str,
    action_key: &str,
) -> Result<GovernedActionSpec> {
    let row: Option<(String, Value)> = sqlx::query_as(
        "SELECT r.manifest->>'version',a FROM connector_installations i \
         JOIN connector_installation_revisions r ON r.tenant_id=i.tenant_id \
           AND r.installation_id=i.id AND r.revision=i.current_revision \
         CROSS JOIN LATERAL jsonb_array_elements(r.manifest->'actions') a \
         WHERE i.tenant_id=$1 AND i.connector_id=$2 AND i.status='enabled' \
           AND a->>'id'=$3",
    )
    .bind(tenant)
    .bind(connector_key)
    .bind(action_key)
    .fetch_optional(&mut **tx)
    .await?;
    let (version, action) = row.ok_or(Error::Conflict("enabled connector action was not found"))?;
    let action: CatalogAction = serde_json::from_value(action)
        .map_err(|_| Error::Invalid("enabled connector action is invalid"))?;
    let operation_class = match action.effect {
        CatalogEffect::Read => OperationClass::Read,
        CatalogEffect::ExternalSend => OperationClass::Communication,
        CatalogEffect::ClinicalWrite => OperationClass::ClinicalWrite,
        CatalogEffect::BillingWrite => OperationClass::Charge,
        CatalogEffect::Write => {
            if action.idempotency == CatalogIdempotency::None {
                return Err(Error::Invalid(
                    "generic connector writes require declared idempotency",
                ));
            }
            OperationClass::IdempotentUpdate
        }
    };
    let approval_policy = match action.approval {
        CatalogApproval::None => ApprovalPolicy::None,
        CatalogApproval::Owner => ApprovalPolicy::Owner,
        CatalogApproval::Clinical => ApprovalPolicy::Clinician,
        CatalogApproval::Staff => ApprovalPolicy::OwnerOrClinician,
    };
    if operation_class == OperationClass::Charge && approval_policy != ApprovalPolicy::Owner {
        return Err(Error::Invalid(
            "billing connector actions require owner approval",
        ));
    }
    let retry_class = match action.retry {
        CatalogRetry::Never => RetryClass::Never,
        CatalogRetry::ReadOnly | CatalogRetry::SafeIdempotent => RetryClass::BoundedSafe,
    };
    let spec = GovernedActionSpec {
        connector_key: connector_key.to_owned(),
        action_key: action_key.to_owned(),
        action_version: version,
        operation_class,
        authority: manifest_authority(&action.required_roles)?,
        approval_policy,
        retry_class,
        separation_of_duties: matches!(
            operation_class,
            OperationClass::ClinicalWrite | OperationClass::Communication | OperationClass::Charge
        ),
        max_attempts: if retry_class == RetryClass::Never {
            1
        } else {
            3
        },
    };
    spec.validate()?;
    Ok(spec)
}

/// Resolves the current enabled manifest policy for an instance-local dispatcher.
/// `create_invocation` resolves it again inside its write transaction so a concurrent
/// connector revision cannot silently change policy between resolution and staging.
pub(crate) async fn resolve_enabled_manifest_spec(
    pool: &PgPool,
    tenant: Uuid,
    connector_key: &str,
    action_key: &str,
) -> Result<GovernedActionSpec> {
    let mut tx = pool.begin().await?;
    let spec = enabled_manifest_spec(&mut tx, tenant, connector_key, action_key).await?;
    tx.commit().await?;
    Ok(spec)
}

impl GovernedActionSpec {
    pub fn validate(&self) -> Result<()> {
        identifier(&self.connector_key)?;
        identifier(&self.action_key)?;
        if self.action_version.is_empty() || self.action_version.len() > 64 {
            return Err(Error::Invalid("invalid connector action version"));
        }
        if self.max_attempts == 0 || self.max_attempts > 5 {
            return Err(Error::Invalid("invalid connector action attempt limit"));
        }
        let side_effect = matches!(
            self.operation_class,
            OperationClass::ClinicalWrite | OperationClass::Communication | OperationClass::Charge
        );
        if side_effect && self.retry_class != RetryClass::Never {
            return Err(Error::Invalid("side-effecting actions cannot auto-retry"));
        }
        if self.retry_class == RetryClass::Never && self.max_attempts != 1 {
            return Err(Error::Invalid("non-retryable actions allow one attempt"));
        }
        if self.operation_class == OperationClass::Charge
            && self.approval_policy != ApprovalPolicy::Owner
        {
            return Err(Error::Invalid("charges require owner approval"));
        }
        if matches!(
            self.operation_class,
            OperationClass::ClinicalWrite | OperationClass::Communication
        ) && self.approval_policy == ApprovalPolicy::None
        {
            return Err(Error::Invalid("sensitive actions require human approval"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct ActionContext {
    pub tenant_id: Uuid,
    pub invocation_id: Uuid,
    pub actor_id: Uuid,
    pub attempt: u8,
}

#[derive(Clone, Debug)]
pub enum ExecutionOutcome {
    Succeeded { evidence: Value },
    RetryableFailure { code: String },
    PermanentFailure { code: String },
    Ambiguous { code: String },
}

#[async_trait]
pub trait ConnectorActionExecutor: Send + Sync {
    fn spec(&self) -> GovernedActionSpec;
    async fn execute(&self, context: &ActionContext, input: Value) -> Result<ExecutionOutcome>;
    async fn reconcile(
        &self,
        _context: &ActionContext,
        _provider_evidence: Value,
    ) -> Result<Value> {
        Err(Error::Conflict(
            "connector action does not support reconciliation",
        ))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInvocation {
    pub request_id: Uuid,
    pub input: Value,
    #[serde(default)]
    pub sandbox_sample_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InvocationAction {
    action: String,
    reason: String,
}

#[derive(Deserialize)]
struct InvocationQuery {
    status: Option<String>,
}

fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}

fn reply(value: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

fn identifier(value: &str) -> Result<()> {
    if value.len() < 2
        || value.len() > 128
        || !value.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' => true,
            b'0'..=b'9' | b'_' | b'.' | b'-' => index > 0,
            _ => false,
        })
    {
        return Err(Error::Invalid("invalid connector action identifier"));
    }
    Ok(())
}

fn bounded_object(value: &Value, limit: usize, message: &'static str) -> Result<()> {
    if !value.is_object() || serde_json::to_vec(value).map_or(true, |bytes| bytes.len() > limit) {
        return Err(Error::Invalid(message));
    }
    Ok(())
}

fn authorize(actor: &Actor, authority: ActionAuthority) -> Result<()> {
    let allowed = match authority {
        ActionAuthority::Staff => !matches!(
            actor.role,
            Role::ReadOnly | Role::Patient | Role::PartnerSupport
        ),
        ActionAuthority::Scheduling => {
            matches!(actor.role, Role::Owner | Role::Clinician | Role::FrontDesk)
        }
        ActionAuthority::Rooming => matches!(
            actor.role,
            Role::Owner | Role::Clinician | Role::Nurse | Role::MedicalAssistant
        ),
        ActionAuthority::Clinical => matches!(actor.role, Role::Owner | Role::Clinician),
        ActionAuthority::Owner => matches!(actor.role, Role::Owner),
    };
    if allowed {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

fn review_authorized(actor: &Actor, policy: ApprovalPolicy) -> Result<()> {
    let allowed = match policy {
        ApprovalPolicy::None => false,
        ApprovalPolicy::Owner => matches!(actor.role, Role::Owner),
        ApprovalPolicy::Clinician => matches!(actor.role, Role::Clinician),
        ApprovalPolicy::OwnerOrClinician => matches!(actor.role, Role::Owner | Role::Clinician),
    };
    if allowed {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

fn enum_json<T: Serialize>(value: T) -> Result<String> {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .ok_or(Error::Invalid("invalid connector action policy"))
}

async fn event(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    invocation: Uuid,
    action: &str,
    evidence: Value,
) -> Result<()> {
    bounded_object(&evidence, MAX_RESULT_BYTES, "action evidence is too large")?;
    sqlx::query("INSERT INTO connector_action_events(tenant_id,invocation_id,actor_id,action,evidence) VALUES($1,$2,$3,$4,$5)")
        .bind(actor.tenant_id).bind(invocation).bind(actor.sub).bind(action).bind(evidence)
        .execute(&mut **tx).await?;
    Ok(())
}

async fn snapshot(tx: &mut Transaction<'_, Postgres>, actor: &Actor, id: Uuid) -> Result<Value> {
    sqlx::query_scalar("SELECT to_jsonb(i)-'tenant_id'-'input_digest'-'input' FROM connector_action_invocations i WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}

/// Creates an invocation from a trusted native adapter or validated connector manifest.
/// The caller supplies policy through `spec`; it is never accepted from an HTTP request.
pub async fn create_invocation(
    pool: &PgPool,
    actor: &Actor,
    spec: &GovernedActionSpec,
    request: CreateInvocation,
) -> Result<Value> {
    spec.validate()?;
    let mut tx = pool.begin().await?;
    let resolved = enabled_manifest_spec(
        &mut tx,
        actor.tenant_id,
        &spec.connector_key,
        &spec.action_key,
    )
    .await?;
    if spec != &resolved {
        return Err(Error::Conflict(
            "connector action policy differs from its enabled manifest",
        ));
    }
    let spec = &resolved;
    authorize(actor, spec.authority)?;
    bounded_object(
        &request.input,
        MAX_INPUT_BYTES,
        "action input must be a bounded object",
    )?;
    let sample_id = request.sandbox_sample_id.as_deref().map(str::trim);
    if sample_id.is_some_and(|value| value.is_empty() || value.len() > 120) {
        return Err(Error::Invalid("invalid synthetic sample identifier"));
    }
    let digest = crate::oauth::hash(
        &serde_json::to_string(&json!({
            "connector":spec.connector_key,
            "action":spec.action_key,
            "version":spec.action_version,
            "input":request.input,
            "sample_id":sample_id,
        }))
        .map_err(|_| Error::Invalid("invalid connector action input"))?,
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "{}:connector-action:{}",
            actor.tenant_id, request.request_id
        ))
        .execute(&mut *tx)
        .await?;
    if let Some((id, prior_digest)) = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id,input_digest FROM connector_action_invocations WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(actor.tenant_id).bind(request.request_id).fetch_optional(&mut *tx).await?
    {
        if prior_digest != digest {
            return Err(Error::Conflict("request ID was reused for different action input"));
        }
        let value = snapshot(&mut tx, actor, id).await?;
        tx.commit().await?;
        return Ok(value);
    }
    let sandbox = sample_id.is_some();
    let status = if sandbox {
        "sandboxed"
    } else if spec.approval_policy == ApprovalPolicy::None {
        "ready"
    } else {
        "pending_review"
    };
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO connector_action_invocations(tenant_id,id,request_id,connector_key,action_key,action_version,operation_class,authority,approval_policy,retry_class,separation_of_duties,sandbox,sample_id,input,input_digest,status,created_by,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)")
        .bind(actor.tenant_id).bind(id).bind(request.request_id).bind(&spec.connector_key).bind(&spec.action_key).bind(&spec.action_version)
        .bind(enum_json(spec.operation_class)?).bind(enum_json(spec.authority)?).bind(enum_json(spec.approval_policy)?).bind(enum_json(spec.retry_class)?)
        .bind(spec.separation_of_duties).bind(sandbox).bind(sample_id).bind(&request.input).bind(&digest).bind(status).bind(actor.sub).bind(i16::from(spec.max_attempts))
        .execute(&mut *tx).await?;
    event(
        &mut tx,
        actor,
        id,
        if sandbox {
            "sandbox_sample_validated"
        } else {
            "invocation_created"
        },
        json!({"connector_key":spec.connector_key,"action_key":spec.action_key,"status":status}),
    )
    .await?;
    audit(&mut tx, actor, "automation.connector_action.created", id).await?;
    let value = snapshot(&mut tx, actor, id).await?;
    tx.commit().await?;
    Ok(value)
}

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/automation/action-invocations", get(list))
        .route("/api/v1/automation/action-invocations/{id}", get(detail))
        .route(
            "/api/v1/automation/action-invocations/{id}/actions",
            post(review_action),
        )
}

async fn list(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Query(query): Query<InvocationQuery>,
) -> Result<Response> {
    actor.staff()?;
    if query.status.as_deref().is_some_and(|value| {
        !matches!(
            value,
            "pending_review"
                | "ready"
                | "executing"
                | "retry_wait"
                | "succeeded"
                | "failed"
                | "needs_reconciliation"
                | "rejected"
                | "cancelled"
                | "sandboxed"
        )
    }) {
        return Err(Error::Invalid("invalid action invocation status"));
    }
    let mut tx = db(&state)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(i)-'tenant_id'-'input_digest'-'input' FROM connector_action_invocations i WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC,id DESC LIMIT 100")
        .bind(actor.tenant_id).bind(query.status).fetch_all(&mut *tx).await?;
    audit(
        &mut tx,
        &actor,
        "automation.connector_action.list",
        actor.tenant_id,
    )
    .await?;
    tx.commit().await?;
    Ok(reply(json!({"items":items})))
}

async fn detail(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    let invocation = snapshot(&mut tx, &actor, id).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id'-'invocation_id' FROM connector_action_events e WHERE tenant_id=$1 AND invocation_id=$2 ORDER BY sequence")
        .bind(actor.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    audit(&mut tx, &actor, "automation.connector_action.read", id).await?;
    tx.commit().await?;
    Ok(reply(json!({"invocation":invocation,"events":events})))
}

async fn review_action(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<InvocationAction>,
) -> Result<Response> {
    if input.reason.trim().is_empty() || input.reason.len() > 1000 {
        return Err(Error::Invalid("review reason is required"));
    }
    let expected = crate::expected(&headers)?;
    let mut tx = db(&state)?.begin().await?;
    let row:Option<(String,String,bool,Uuid,i64)>=sqlx::query_as("SELECT status,approval_policy,separation_of_duties,created_by,version FROM connector_action_invocations WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
    let (status, policy, separation, created_by, version) = row.ok_or(Error::NotFound)?;
    if version != expected {
        return Err(Error::Conflict("action invocation changed; reload"));
    }
    let policy: ApprovalPolicy = serde_json::from_value(Value::String(policy))
        .map_err(|_| Error::Invalid("saved approval policy is invalid"))?;
    if input.action == "approve" {
        if status != "pending_review" {
            return Err(Error::Conflict(
                "action invocation is not awaiting approval",
            ));
        }
        review_authorized(&actor, policy)?;
        if separation && created_by == actor.sub {
            return Err(Error::Forbidden);
        }
        sqlx::query("UPDATE connector_action_invocations SET status='ready',reviewed_by=$3,review_reason=$4,reviewed_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2")
            .bind(actor.tenant_id).bind(id).bind(actor.sub).bind(input.reason.trim()).execute(&mut *tx).await?;
        event(&mut tx, &actor, id, "approved", json!({})).await?;
    } else if input.action == "reject" {
        if status != "pending_review" {
            return Err(Error::Conflict(
                "action invocation is not awaiting approval",
            ));
        }
        review_authorized(&actor, policy)?;
        sqlx::query("UPDATE connector_action_invocations SET status='rejected',reviewed_by=$3,review_reason=$4,reviewed_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2")
            .bind(actor.tenant_id).bind(id).bind(actor.sub).bind(input.reason.trim()).execute(&mut *tx).await?;
        event(&mut tx, &actor, id, "rejected", json!({})).await?;
    } else if input.action == "cancel" {
        authorize(&actor, ActionAuthority::Owner)?;
        if !matches!(status.as_str(), "pending_review" | "ready" | "retry_wait") {
            return Err(Error::Conflict("action invocation cannot be cancelled"));
        }
        sqlx::query("UPDATE connector_action_invocations SET status='cancelled',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2")
            .bind(actor.tenant_id).bind(id).execute(&mut *tx).await?;
        event(
            &mut tx,
            &actor,
            id,
            "cancelled",
            json!({"reason":input.reason.trim()}),
        )
        .await?;
    } else {
        return Err(Error::Invalid("invalid action invocation action"));
    }
    audit(&mut tx, &actor, "automation.connector_action.reviewed", id).await?;
    let value = snapshot(&mut tx, &actor, id).await?;
    tx.commit().await?;
    Ok(reply(value))
}

#[derive(sqlx::FromRow)]
pub struct LeasedInvocation {
    pub id: Uuid,
    pub connector_key: String,
    pub action_key: String,
    pub action_version: String,
    pub input: Value,
    pub attempt_count: i32,
    pub max_attempts: i32,
    pub retry_class: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExpiredLeaseDisposition {
    Retry,
    Failed,
    Reconcile,
}

fn expired_lease_disposition(
    operation_class: &str,
    retry_class: &str,
    attempt_count: i32,
    max_attempts: i32,
) -> ExpiredLeaseDisposition {
    if matches!(
        operation_class,
        "clinical_write" | "communication" | "charge"
    ) {
        ExpiredLeaseDisposition::Reconcile
    } else if retry_class == "bounded_safe" && attempt_count < max_attempts {
        ExpiredLeaseDisposition::Retry
    } else {
        ExpiredLeaseDisposition::Failed
    }
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

/// Claims one ready action for a trusted instance-local worker.
pub async fn lease_ready(
    pool: &PgPool,
    tenant: Uuid,
    worker: Uuid,
) -> Result<Option<LeasedInvocation>> {
    lease_ready_filtered(pool, tenant, worker, None, None).await
}

/// Claims work only for one reviewed, compiled action executor. This prevents an
/// instance-local worker from consuming invocations owned by a different adapter.
pub(crate) async fn lease_ready_for(
    pool: &PgPool,
    tenant: Uuid,
    worker: Uuid,
    connector_key: &str,
    action_key: &str,
) -> Result<Option<LeasedInvocation>> {
    identifier(connector_key)?;
    identifier(action_key)?;
    lease_ready_filtered(pool, tenant, worker, Some(connector_key), Some(action_key)).await
}

async fn lease_ready_filtered(
    pool: &PgPool,
    tenant: Uuid,
    worker: Uuid,
    connector_key: Option<&str>,
    action_key: Option<&str>,
) -> Result<Option<LeasedInvocation>> {
    let mut tx = pool.begin().await?;
    type ExpiredLease = (Uuid, String, String, i32, i32);
    let expired: Vec<ExpiredLease> = sqlx::query_as(
        "SELECT id,operation_class,retry_class,attempt_count,max_attempts \
         FROM connector_action_invocations \
         WHERE tenant_id=$1 AND status='executing' AND lease_expires_at<=now() \
           AND ($2::text IS NULL OR connector_key=$2) \
           AND ($3::text IS NULL OR action_key=$3) \
         ORDER BY lease_expires_at,id FOR UPDATE SKIP LOCKED LIMIT 100",
    )
    .bind(tenant)
    .bind(connector_key)
    .bind(action_key)
    .fetch_all(&mut *tx)
    .await?;
    for (id, operation_class, retry_class, attempt_count, max_attempts) in expired {
        let disposition =
            expired_lease_disposition(&operation_class, &retry_class, attempt_count, max_attempts);
        let (status, action, failure_code, retry_at) = match disposition {
            ExpiredLeaseDisposition::Retry => (
                "retry_wait",
                "expired_lease_retry_scheduled",
                "worker_lease_expired",
                Some(Utc::now()),
            ),
            ExpiredLeaseDisposition::Failed => (
                "failed",
                "expired_lease_failed",
                "worker_lease_expired",
                None,
            ),
            ExpiredLeaseDisposition::Reconcile => (
                "needs_reconciliation",
                "expired_lease_requires_reconciliation",
                "ambiguous_worker_lease_expiry",
                None,
            ),
        };
        sqlx::query(
            "UPDATE connector_action_invocations \
             SET status=$3,failure_code=$4,next_attempt_at=$5,lease_owner=NULL,lease_expires_at=NULL,\
                 version=version+1,updated_at=now() \
             WHERE tenant_id=$1 AND id=$2 AND status='executing'",
        )
        .bind(tenant)
        .bind(id)
        .bind(status)
        .bind(failure_code)
        .bind(retry_at)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO connector_action_events(tenant_id,invocation_id,actor_id,action,evidence) VALUES($1,$2,$3,$4,jsonb_build_object('attempt',$5,'status',$6))")
            .bind(tenant).bind(id).bind(worker).bind(action).bind(attempt_count).bind(status).execute(&mut *tx).await?;
        worker_audit(
            &mut tx,
            tenant,
            worker,
            "automation.connector_action.lease_expired",
            id,
        )
        .await?;
    }
    let row:Option<LeasedInvocation>=sqlx::query_as("WITH candidate AS (SELECT id FROM connector_action_invocations WHERE tenant_id=$1 AND sandbox=false AND ($3::text IS NULL OR connector_key=$3) AND ($4::text IS NULL OR action_key=$4) AND (status='ready' OR (status='retry_wait' AND next_attempt_at<=now())) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE connector_action_invocations i SET status='executing',attempt_count=attempt_count+1,lease_owner=$2,lease_expires_at=now()+interval '2 minutes',next_attempt_at=NULL,version=version+1,updated_at=now() FROM candidate WHERE i.tenant_id=$1 AND i.id=candidate.id RETURNING i.id,i.connector_key,i.action_key,i.action_version,i.input,i.attempt_count,i.max_attempts,i.retry_class")
        .bind(tenant).bind(worker).bind(connector_key).bind(action_key).fetch_optional(&mut *tx).await?;
    if let Some(ref item) = row {
        sqlx::query("INSERT INTO connector_action_events(tenant_id,invocation_id,actor_id,action,evidence) VALUES($1,$2,$3,'execution_leased',jsonb_build_object('attempt',$4))")
            .bind(tenant).bind(item.id).bind(worker).bind(item.attempt_count).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(row)
}

fn failure_code(code: &str) -> Result<&str> {
    if code.is_empty()
        || code.len() > 100
        || !code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        Err(Error::Invalid("invalid connector failure code"))
    } else {
        Ok(code)
    }
}

/// Applies a native adapter outcome. Ambiguous side effects always stop for reconciliation.
pub async fn record_outcome(
    pool: &PgPool,
    actor: &Actor,
    worker: Uuid,
    id: Uuid,
    outcome: ExecutionOutcome,
) -> Result<Value> {
    let mut tx = pool.begin().await?;
    let row:Option<(String,String,i32,i32,i64)>=sqlx::query_as("SELECT status,retry_class,attempt_count,max_attempts,version FROM connector_action_invocations WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3 FOR UPDATE")
        .bind(actor.tenant_id).bind(id).bind(worker).fetch_optional(&mut *tx).await?;
    let (status, retry, attempt, max_attempts, _) = row.ok_or(Error::NotFound)?;
    if status != "executing" {
        return Err(Error::Conflict("connector action is not executing"));
    }
    let (next, evidence, code, next_attempt) = match outcome {
        ExecutionOutcome::Succeeded { evidence } => {
            bounded_object(&evidence, MAX_RESULT_BYTES, "action result is too large")?;
            ("succeeded", evidence, None, None)
        }
        ExecutionOutcome::PermanentFailure { code } => (
            "failed",
            json!({}),
            Some(failure_code(&code)?.to_owned()),
            None,
        ),
        ExecutionOutcome::Ambiguous { code } => (
            "needs_reconciliation",
            json!({}),
            Some(failure_code(&code)?.to_owned()),
            None,
        ),
        ExecutionOutcome::RetryableFailure { code } => {
            let code = failure_code(&code)?.to_owned();
            if retry == "bounded_safe" && attempt < max_attempts {
                (
                    "retry_wait",
                    json!({}),
                    Some(code),
                    Some(Utc::now() + Duration::seconds(i64::from(1_i32 << attempt.min(5)))),
                )
            } else {
                ("failed", json!({}), Some(code), None)
            }
        }
    };
    sqlx::query("UPDATE connector_action_invocations SET status=$4,result_evidence=$5,failure_code=$6,next_attempt_at=$7,lease_owner=NULL,lease_expires_at=NULL,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3")
        .bind(actor.tenant_id).bind(id).bind(worker).bind(next).bind(&evidence).bind(code).bind(next_attempt).execute(&mut *tx).await?;
    event(
        &mut tx,
        actor,
        id,
        "execution_recorded",
        json!({"status":next,"attempt":attempt}),
    )
    .await?;
    audit(&mut tx, actor, "automation.connector_action.outcome", id).await?;
    let value = snapshot(&mut tx, actor, id).await?;
    tx.commit().await?;
    Ok(value)
}

/// Records provider-verified reconciliation. The executor must verify evidence first.
pub async fn record_reconciled(
    pool: &PgPool,
    actor: &Actor,
    id: Uuid,
    verified_evidence: Value,
) -> Result<Value> {
    bounded_object(
        &verified_evidence,
        MAX_RESULT_BYTES,
        "reconciliation evidence is too large",
    )?;
    let mut tx = pool.begin().await?;
    let authority: Option<String> = sqlx::query_scalar(
        "SELECT authority FROM connector_action_invocations \
         WHERE tenant_id=$1 AND id=$2 AND status='needs_reconciliation' FOR UPDATE",
    )
    .bind(actor.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let authority = authority.ok_or(Error::Conflict("action does not require reconciliation"))?;
    let authority: ActionAuthority = serde_json::from_value(Value::String(authority))
        .map_err(|_| Error::Invalid("saved action authority is invalid"))?;
    authorize(actor, authority)?;
    let changed=sqlx::query("UPDATE connector_action_invocations SET status='succeeded',result_evidence=$3,failure_code=NULL,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='needs_reconciliation'")
        .bind(actor.tenant_id).bind(id).bind(&verified_evidence).execute(&mut *tx).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::Conflict("action does not require reconciliation"));
    }
    event(
        &mut tx,
        actor,
        id,
        "provider_evidence_reconciled",
        json!({}),
    )
    .await?;
    audit(&mut tx, actor, "automation.connector_action.reconciled", id).await?;
    let value = snapshot(&mut tx, actor, id).await?;
    tx.commit().await?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(
        class: OperationClass,
        retry: RetryClass,
        approval: ApprovalPolicy,
    ) -> GovernedActionSpec {
        GovernedActionSpec {
            connector_key: "synthetic.connector".into(),
            action_key: "send_message".into(),
            action_version: "1.0.0".into(),
            operation_class: class,
            authority: ActionAuthority::Clinical,
            approval_policy: approval,
            retry_class: retry,
            separation_of_duties: true,
            max_attempts: if retry == RetryClass::Never { 1 } else { 3 },
        }
    }

    #[test]
    fn side_effects_never_auto_retry() {
        for class in [
            OperationClass::ClinicalWrite,
            OperationClass::Communication,
            OperationClass::Charge,
        ] {
            let approval = if class == OperationClass::Charge {
                ApprovalPolicy::Owner
            } else {
                ApprovalPolicy::OwnerOrClinician
            };
            assert!(spec(class, RetryClass::BoundedSafe, approval)
                .validate()
                .is_err());
            assert!(spec(class, RetryClass::Never, approval).validate().is_ok());
        }
    }

    #[test]
    fn charges_require_owner_approval() {
        assert!(spec(
            OperationClass::Charge,
            RetryClass::Never,
            ApprovalPolicy::OwnerOrClinician
        )
        .validate()
        .is_err());
    }

    #[test]
    fn identifiers_and_payloads_are_bounded() {
        assert!(identifier("gmail.send").is_ok());
        assert!(identifier("Bad Connector").is_err());
        assert!(bounded_object(&json!({"synthetic":true}), MAX_INPUT_BYTES, "invalid").is_ok());
        assert!(bounded_object(&json!([1, 2, 3]), MAX_INPUT_BYTES, "invalid").is_err());
    }

    #[test]
    fn read_and_idempotent_updates_may_use_bounded_retry() {
        assert!(spec(
            OperationClass::Read,
            RetryClass::BoundedSafe,
            ApprovalPolicy::None
        )
        .validate()
        .is_ok());
        assert!(spec(
            OperationClass::IdempotentUpdate,
            RetryClass::BoundedSafe,
            ApprovalPolicy::None
        )
        .validate()
        .is_ok());
    }

    #[test]
    fn expired_side_effects_require_manual_reconciliation() {
        for class in ["clinical_write", "communication", "charge"] {
            assert_eq!(
                expired_lease_disposition(class, "never", 1, 1),
                ExpiredLeaseDisposition::Reconcile
            );
        }
    }

    #[test]
    fn expired_safe_actions_retry_only_with_attempts_remaining() {
        assert_eq!(
            expired_lease_disposition("read", "bounded_safe", 1, 3),
            ExpiredLeaseDisposition::Retry
        );
        assert_eq!(
            expired_lease_disposition("idempotent_update", "bounded_safe", 3, 3),
            ExpiredLeaseDisposition::Failed
        );
        assert_eq!(
            expired_lease_disposition("read", "never", 1, 1),
            ExpiredLeaseDisposition::Failed
        );
    }
}
