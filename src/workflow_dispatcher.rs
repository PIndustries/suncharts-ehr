// SPDX-License-Identifier: AGPL-3.0-only
//! Reviewed, instance-local execution boundary for Workflow Studio nodes.
//! External communication and model work always stop at a downstream draft.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    model::{text, Appointment, NewAppointment},
    postgres::audit,
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::{header, HeaderMap, Method},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

const KINDS: &[&str] = &[
    "eligibility_query",
    "payment_request",
    "availability_query",
    "slot_hold",
    "appointment_booking",
    "appointment_reschedule",
    "appointment_cancel",
    "intake_request",
    "communication_send",
    "ai_extract_draft",
    "ai_response_draft",
];

fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn reply(value: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}
fn role_key(role: &Role) -> &'static str {
    match role {
        Role::Owner => "owner",
        Role::Clinician => "clinician",
        Role::Nurse => "nurse",
        Role::MedicalAssistant => "medical_assistant",
        Role::FrontDesk => "front_desk",
        Role::ReadOnly => "read_only",
        Role::PartnerSupport => "partner_support",
        Role::Patient => "patient",
    }
}
fn reviewer(actor: &Actor) -> Result<()> {
    if matches!(
        actor.role,
        Role::Owner | Role::Clinician | Role::PartnerSupport
    ) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateDispatch {
    request_id: Uuid,
    input: Value,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DispatchAction {
    action: String,
    reason: String,
    #[serde(default)]
    privacy_preview_id: Option<Uuid>,
    #[serde(default)]
    privacy_approved: bool,
}
#[derive(Deserialize)]
struct DispatchQuery {
    status: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AvailabilityInput {
    clinician_id: Uuid,
    #[serde(default)]
    patient_id: Option<Uuid>,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    #[serde(default)]
    facility: String,
    #[serde(default)]
    room: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HoldInput {
    service_id: Uuid,
    #[serde(default)]
    patient_id: Option<Uuid>,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RescheduleInput {
    appointment_id: Uuid,
    expected_version: i64,
    clinician_id: Uuid,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    title: String,
    category: String,
    #[serde(default)]
    facility: String,
    #[serde(default)]
    room: String,
    #[serde(default)]
    notes: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AppointmentActionInput {
    appointment_id: Uuid,
    expected_version: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IntakeInput {
    #[serde(default)]
    appointment_id: Option<Uuid>,
    #[serde(default)]
    form_step_key: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EligibilityInput {
    coverage_id: Uuid,
    request: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PaymentInput {
    account_id: Uuid,
    expected_version: i64,
    amount_cents: i64,
}
fn eligibility_request(
    input: &Value,
    request_id: Uuid,
) -> Result<crate::claimmd_eligibility::EligibilityRequest> {
    let mut value = input.clone();
    let object = value
        .as_object_mut()
        .ok_or(Error::Invalid("eligibility request must be an object"))?;
    object.insert("request_id".into(), json!(request_id));
    serde_json::from_value(value)
        .map_err(|_| Error::Invalid("invalid structured eligibility request"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AiDraftInput {
    #[serde(default)]
    integration_id: Option<Uuid>,
    instruction: String,
    source_text: String,
}
impl AiDraftInput {
    fn validate(&self) -> Result<()> {
        if self.instruction.trim().is_empty()
            || self.instruction.len() > 4000
            || self.instruction.contains('\0')
        {
            return Err(Error::Invalid(
                "Sun instruction is missing or exceeds 4000 UTF-8 bytes",
            ));
        }
        if self.source_text.trim().is_empty()
            || self.source_text.len() > 65_536
            || self.source_text.contains('\0')
        {
            return Err(Error::Invalid(
                "Sun source must be nonempty text of at most 65536 UTF-8 bytes",
            ));
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommunicationInput {
    provider: String,
    integration_id: Uuid,
    #[serde(default)]
    inbox_id: Option<Uuid>,
    #[serde(default)]
    to: Vec<String>,
    #[serde(default)]
    cc: Vec<String>,
    #[serde(default)]
    subject: String,
    #[serde(default)]
    body_text: String,
    #[serde(default)]
    attachments: Vec<CommunicationAttachment>,
    #[serde(default)]
    ringcentral: Option<crate::ringcentral_adapter::OutboundDraftInput>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommunicationAttachment {
    filename: String,
    mime_type: String,
    content_base64: String,
}

struct DispatchRow {
    id: Uuid,
    instance: Uuid,
    step: String,
    kind: String,
    status: String,
    input: Value,
    version: i64,
    downstream_kind: Option<String>,
    downstream_id: Option<Uuid>,
}
#[derive(sqlx::FromRow)]
struct StoredDispatch {
    id: Uuid,
    pathway_instance_id: Uuid,
    step_key: String,
    kind: String,
    status: String,
    input: Value,
    version: i64,
    downstream_kind: Option<String>,
    downstream_id: Option<Uuid>,
}

#[derive(sqlx::FromRow)]
struct DispatchStep {
    instance_status: String,
    kind: String,
    manual_approval: bool,
    assigned_role: Option<String>,
    state: String,
    context: Value,
    definition: Value,
}

#[derive(sqlx::FromRow)]
struct ReviewBinding {
    instance_status: String,
    patient_id: Option<Uuid>,
    definition_version: i64,
    kind: String,
    manual_approval: bool,
    step_state: String,
    dispatch_id: Option<String>,
}

struct AiPrivacyApproval {
    preview_id: Uuid,
    patient_id: Option<Uuid>,
    revision: Value,
}

fn is_ai(kind: &str) -> bool {
    matches!(kind, "ai_extract_draft" | "ai_response_draft")
}

fn ai_purpose(kind: &str) -> Result<&'static str> {
    match kind {
        "ai_extract_draft" => Ok("structured_extraction"),
        "ai_response_draft" => Ok("draft_response"),
        _ => Err(Error::Invalid("privacy preview requires a Sun draft node")),
    }
}

enum Outcome {
    Completed {
        result: Value,
        one_time: Option<Value>,
    },
    Downstream {
        kind: &'static str,
        id: Uuid,
        result: Value,
    },
}

async fn event(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
    action: &str,
    evidence: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO workflow_dispatch_events(tenant_id,dispatch_id,actor_id,action,evidence) VALUES($1,$2,$3,$4,$5)")
        .bind(actor.tenant_id).bind(id).bind(actor.sub).bind(action).bind(evidence)
        .execute(&mut **tx).await?;
    Ok(())
}

async fn snapshot(tx: &mut Transaction<'_, Postgres>, actor: &Actor, id: Uuid) -> Result<Value> {
    let value = sqlx::query_scalar("SELECT to_jsonb(d)-'tenant_id'-'input_digest' FROM workflow_dispatches d WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
    Ok(public_dispatch(value))
}

fn public_dispatch(mut value: Value) -> Value {
    if value["kind"].as_str().is_some_and(is_ai) {
        // Original source remains local clinical data. Reviewers obtain the
        // exact sanitized request through the actor-bound privacy preview route.
        if let Some(object) = value.as_object_mut() {
            object.remove("input");
            object.insert("privacy_review_required".into(), json!(true));
        }
    }
    value
}

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/workflow-dispatches", get(list))
        .route("/api/v1/workflow-dispatches/{id}", get(detail))
        .route(
            "/api/v1/workflow-dispatches/{id}/privacy-preview",
            post(privacy_preview),
        )
        .route("/api/v1/workflow-dispatches/{id}/actions", post(action))
        .route(
            "/api/v1/care-pathways/instances/{instance}/steps/{step}/dispatch",
            post(create),
        )
}

async fn create(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path((instance, step)): Path<(Uuid, String)>,
    Json(input): Json<CreateDispatch>,
) -> Result<Response> {
    actor.staff()?;
    if matches!(actor.role, Role::ReadOnly) {
        return Err(Error::Forbidden);
    }
    text(&input.reason, 1000)?;
    if !input.input.is_object()
        || serde_json::to_vec(&input.input).map_or(true, |value| value.len() > 262_144)
    {
        return Err(Error::Invalid(
            "workflow dispatch input must be a bounded object",
        ));
    }
    let digest = crate::oauth::hash(
        &serde_json::to_string(&(instance, &step, &input.input))
            .map_err(|_| Error::Invalid("invalid workflow dispatch input"))?,
    );
    let mut tx = db(&state)?.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "{}:workflow-dispatch:{}",
            actor.tenant_id, input.request_id
        ))
        .execute(&mut *tx)
        .await?;
    if let Some((id, old_digest)) = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id,input_digest FROM workflow_dispatches WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(actor.tenant_id)
    .bind(input.request_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        if old_digest != digest {
            return Err(Error::Conflict(
                "request ID was reused for different dispatch input",
            ));
        }
        let value = snapshot(&mut tx, &actor, id).await?;
        tx.commit().await?;
        return Ok(reply(value));
    }
    let row: Option<DispatchStep> = sqlx::query_as(
        "SELECT i.status AS instance_status,s.kind,s.manual_approval,s.assigned_role,s.state,i.context,r.definition
         FROM care_pathway_instances i JOIN care_pathway_steps s ON s.tenant_id=i.tenant_id AND s.instance_id=i.id
         JOIN care_pathway_definition_revisions r ON r.tenant_id=i.tenant_id AND r.definition_id=i.definition_id AND r.version=i.definition_version
         WHERE i.tenant_id=$1 AND i.id=$2 AND s.step_key=$3 FOR UPDATE OF s",
    )
    .bind(actor.tenant_id)
    .bind(instance)
    .bind(&step)
    .fetch_optional(&mut *tx)
    .await?;
    let row = row.ok_or(Error::NotFound)?;
    let kind = &row.kind;
    if row.instance_status != "active"
        || !KINDS.contains(&kind.as_str())
        || !row.manual_approval
        || !["ready", "in_progress"].contains(&row.state.as_str())
    {
        return Err(Error::Conflict(
            "workflow step is not ready for reviewed dispatch",
        ));
    }
    if !matches!(actor.role, Role::Owner | Role::PartnerSupport)
        && row
            .assigned_role
            .as_deref()
            .is_some_and(|value| value != role_key(&actor.role))
    {
        return Err(Error::Forbidden);
    }
    let prepared_input = if matches!(kind.as_str(), "ai_extract_draft" | "ai_response_draft")
        && input
            .input
            .as_object()
            .is_some_and(|object| object.is_empty())
    {
        prepare_ai_input(kind, &step, &row.definition, &row.context)?
    } else {
        input.input
    };
    validate_input(kind, &prepared_input)?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workflow_dispatches(tenant_id,id,request_id,pathway_instance_id,step_key,kind,input,input_digest,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
        .bind(actor.tenant_id).bind(id).bind(input.request_id).bind(instance).bind(&step).bind(kind)
        .bind(&prepared_input).bind(&digest).bind(actor.sub).execute(&mut *tx).await?;
    sqlx::query("UPDATE care_pathway_steps SET state='awaiting_approval',version=version+1,evidence=jsonb_build_object('workflow_dispatch_id',$4::uuid,'status','pending_review','human_review_required',true),updated_by=$5,updated_at=now() WHERE tenant_id=$1 AND instance_id=$2 AND step_key=$3")
        .bind(actor.tenant_id).bind(instance).bind(&step).bind(id).bind(actor.sub).execute(&mut *tx).await?;
    event(
        &mut tx,
        &actor,
        id,
        "dispatch_created",
        json!({"kind":kind}),
    )
    .await?;
    sqlx::query("INSERT INTO care_pathway_events(tenant_id,instance_id,step_key,event_type,actor_id,reason,evidence) VALUES($1,$2,$3,'step.dispatch_submitted',$4,$5,$6)")
        .bind(actor.tenant_id).bind(instance).bind(&step).bind(actor.sub).bind(input.reason.trim())
        .bind(json!({"workflow_dispatch_id":id,"kind":kind})).execute(&mut *tx).await?;
    audit(&mut tx, &actor, "practice.workflow_dispatch.created", id).await?;
    let value = snapshot(&mut tx, &actor, id).await?;
    tx.commit().await?;
    Ok(reply(value))
}

fn prepare_ai_input(
    kind: &str,
    step_key: &str,
    definition: &Value,
    context: &Value,
) -> Result<Value> {
    let step = definition
        .get("steps")
        .and_then(Value::as_array)
        .and_then(|steps| {
            steps
                .iter()
                .find(|step| step.get("key").and_then(Value::as_str) == Some(step_key))
        })
        .ok_or(Error::Conflict(
            "Sun step is absent from the instance definition revision",
        ))?;
    let step: crate::care_pathways::StepDefinition = serde_json::from_value(step.clone())
        .map_err(|_| Error::Conflict("saved Sun step configuration is invalid"))?;
    if step.kind != kind || !step.manual_approval {
        return Err(Error::Conflict(
            "saved Sun step must match the reviewed instance step",
        ));
    }
    let config = step.ai.ok_or(Error::Invalid(
        "configure the Sun connection, instruction and source field before preparing this node",
    ))?;
    config.validate()?;
    let source = context
        .pointer(&config.source_field)
        .ok_or(Error::Invalid(
            "configured Sun source field is absent from this workflow instance context",
        ))?
        .as_str()
        .ok_or(Error::Invalid(
            "configured Sun source field must contain text, not an object, list or other value",
        ))?;
    let prepared = AiDraftInput {
        integration_id: Some(config.integration_id),
        instruction: config.instruction.trim().to_owned(),
        source_text: source.to_owned(),
    };
    prepared.validate()?;
    Ok(
        json!({"integration_id":prepared.integration_id,"instruction":prepared.instruction,"source_text":prepared.source_text}),
    )
}

fn validate_input(kind: &str, input: &Value) -> Result<()> {
    match kind {
        "eligibility_query" => {
            let value: EligibilityInput = serde_json::from_value(input.clone())
                .map_err(|_| Error::Invalid("invalid eligibility input"))?;
            eligibility_request(&value.request, Uuid::nil())?;
            return Ok(());
        }
        "payment_request" => {
            let value: PaymentInput = serde_json::from_value(input.clone())
                .map_err(|_| Error::Invalid("invalid payment input"))?;
            if value.expected_version < 1 || !(50..=100000000).contains(&value.amount_cents) {
                return Err(Error::Invalid(
                    "payment amount or account version is invalid",
                ));
            }
            return Ok(());
        }
        "availability_query" => {
            serde_json::from_value::<AvailabilityInput>(input.clone()).map(|_| ())
        }
        "slot_hold" => serde_json::from_value::<HoldInput>(input.clone()).map(|_| ()),
        "appointment_booking" => {
            serde_json::from_value::<NewAppointment>(input.clone()).map(|_| ())
        }
        "appointment_reschedule" => {
            serde_json::from_value::<RescheduleInput>(input.clone()).map(|_| ())
        }
        "appointment_cancel" => {
            serde_json::from_value::<AppointmentActionInput>(input.clone()).map(|_| ())
        }
        "intake_request" => serde_json::from_value::<IntakeInput>(input.clone()).map(|_| ()),
        "communication_send" => {
            let value: CommunicationInput = serde_json::from_value(input.clone())
                .map_err(|_| Error::Invalid("invalid communication draft input"))?;
            if !matches!(value.provider.as_str(), "gmail" | "ringcentral") {
                return Err(Error::Invalid(
                    "communication provider must be gmail or ringcentral",
                ));
            }
            if value.provider == "ringcentral" && value.ringcentral.is_none() {
                return Err(Error::Invalid("RingCentral draft payload is required"));
            }
            Ok(())
        }
        "ai_extract_draft" | "ai_response_draft" => {
            let input: AiDraftInput = serde_json::from_value(input.clone())
                .map_err(|_| Error::Invalid("invalid Sun draft input"))?;
            return input.validate();
        }
        _ => return Err(Error::Invalid("unsupported workflow dispatch kind")),
    }
    .map_err(|_| Error::Invalid("invalid input for workflow dispatch kind"))
}

async fn list(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Query(query): Query<DispatchQuery>,
) -> Result<Response> {
    actor.staff()?;
    if query.status.as_deref().is_some_and(|value| {
        ![
            "pending_review",
            "executing",
            "downstream_review",
            "completed",
            "rejected",
            "failed",
        ]
        .contains(&value)
    }) {
        return Err(Error::Invalid("invalid workflow dispatch status"));
    }
    let mut tx = db(&state)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(d)-'tenant_id'-'input_digest'-'input' FROM workflow_dispatches d WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC,id DESC LIMIT 100")
        .bind(actor.tenant_id).bind(&query.status).fetch_all(&mut *tx).await?;
    audit(
        &mut tx,
        &actor,
        "practice.workflow_dispatch.list",
        actor.tenant_id,
    )
    .await?;
    tx.commit().await?;
    Ok(reply(
        json!({"items":items.into_iter().map(public_dispatch).collect::<Vec<_>>()}),
    ))
}

async fn detail(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    let value = snapshot(&mut tx, &actor, id).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id'-'dispatch_id' FROM workflow_dispatch_events e WHERE tenant_id=$1 AND dispatch_id=$2 ORDER BY sequence")
        .bind(actor.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    audit(&mut tx, &actor, "practice.workflow_dispatch.read", id).await?;
    tx.commit().await?;
    Ok(reply(json!({"dispatch":value,"events":events})))
}

async fn locked(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
) -> Result<DispatchRow> {
    let row:Option<StoredDispatch>=sqlx::query_as("SELECT id,pathway_instance_id,step_key,kind,status,input,version,downstream_kind,downstream_id FROM workflow_dispatches WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut **tx).await?;
    row.map(|r| DispatchRow {
        id: r.id,
        instance: r.pathway_instance_id,
        step: r.step_key,
        kind: r.kind,
        status: r.status,
        input: r.input,
        version: r.version,
        downstream_kind: r.downstream_kind,
        downstream_id: r.downstream_id,
    })
    .ok_or(Error::NotFound)
}

fn bound_revision(row: &DispatchRow, binding: &ReviewBinding) -> Result<Value> {
    let dispatch_id = row.id.to_string();
    if binding.instance_status != "active"
        || binding.kind != row.kind
        || !binding.manual_approval
        || binding.step_state != "awaiting_approval"
        || binding.dispatch_id.as_deref() != Some(dispatch_id.as_str())
    {
        return Err(Error::Conflict(
            "workflow run or reviewed step changed; prepare the current step again",
        ));
    }
    Ok(json!({
        "dispatch_id":row.id,
        "dispatch_version":row.version,
        "pathway_instance_id":row.instance,
        "definition_version":binding.definition_version,
        "step_key":row.step,
        "kind":row.kind,
    }))
}

async fn review_binding(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    row: &DispatchRow,
) -> Result<ReviewBinding> {
    let binding: Option<ReviewBinding> = sqlx::query_as(
        "SELECT i.status AS instance_status,i.patient_id,i.definition_version,s.kind,s.manual_approval,
         s.state AS step_state,s.evidence->>'workflow_dispatch_id' AS dispatch_id
         FROM care_pathway_instances i JOIN care_pathway_steps s ON s.tenant_id=i.tenant_id AND s.instance_id=i.id
         WHERE i.tenant_id=$1 AND i.id=$2 AND s.step_key=$3 FOR SHARE OF i,s",
    )
    .bind(actor.tenant_id)
    .bind(row.instance)
    .bind(&row.step)
    .fetch_optional(&mut **tx)
    .await?;
    let binding = binding.ok_or(Error::NotFound)?;
    bound_revision(row, &binding)?;
    Ok(binding)
}

fn approved_privacy_id(input: &DispatchAction) -> Result<Uuid> {
    input
        .privacy_preview_id
        .filter(|id| !id.is_nil() && input.privacy_approved)
        .ok_or(Error::Invalid(
            "review and approve the exact Sun privacy preview before execution",
        ))
}

async fn privacy_preview(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response> {
    reviewer(&actor)?;
    let expected = crate::expected(&headers)?;
    let mut tx = db(&state)?.begin().await?;
    let row = locked(&mut tx, &actor, id).await?;
    if row.status != "pending_review" || row.version != expected {
        return Err(Error::Conflict(
            "workflow dispatch changed or is no longer awaiting review",
        ));
    }
    dispatch_permission(&state, &actor, &row.kind).await?;
    dispatch_oauth_scope(&state, &actor, &headers, &row).await?;
    let purpose = ai_purpose(&row.kind)?;
    let binding = review_binding(&mut tx, &actor, &row).await?;
    let revision = bound_revision(&row, &binding)?;
    let value: AiDraftInput = serde_json::from_value(row.input.clone())
        .map_err(|_| Error::Invalid("invalid Sun draft input"))?;
    value.validate()?;
    let preview = crate::claude_adapter::preview_for_workflow(
        &state,
        &actor,
        row.id,
        value.integration_id,
        purpose,
        value.instruction,
        value.source_text,
        binding.patient_id,
        revision,
    )
    .await?;
    // Only references enter events: source, sanitized text and local replacement
    // mappings are never event evidence or audit payloads.
    event(
        &mut tx,
        &actor,
        id,
        "privacy_preview_prepared",
        json!({"privacy_preview_id":preview["id"]}),
    )
    .await?;
    audit(
        &mut tx,
        &actor,
        "practice.workflow_dispatch.privacy_preview",
        id,
    )
    .await?;
    tx.commit().await?;
    Ok(reply(preview))
}

async fn action(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<DispatchAction>,
) -> Result<Response> {
    reviewer(&actor)?;
    text(&input.reason, 1000)?;
    let expected = crate::expected(&headers)?;
    let mut tx = db(&state)?.begin().await?;
    let row = locked(&mut tx, &actor, id).await?;
    if row.version != expected {
        return Err(Error::Conflict("workflow dispatch changed; reload"));
    }
    if input.action == "approve" {
        dispatch_permission(&state, &actor, &row.kind).await?;
        dispatch_oauth_scope(&state, &actor, &headers, &row).await?;
        review_binding(&mut tx, &actor, &row).await?;
    }
    if input.action == "confirm" && row.status == "downstream_review" {
        dispatch_permission(&state, &actor, &row.kind).await?;
        dispatch_oauth_scope(&state, &actor, &headers, &row).await?;
        review_binding(&mut tx, &actor, &row).await?;
        let kind = row
            .downstream_kind
            .as_deref()
            .ok_or(Error::Conflict("downstream draft is missing"))?;
        let downstream = row
            .downstream_id
            .ok_or(Error::Conflict("downstream draft is missing"))?;
        verify_downstream(&mut tx, &actor, kind, downstream).await?;
        let result =
            json!({"downstream_kind":kind,"downstream_id":downstream,"review_confirmed":true});
        sqlx::query("UPDATE workflow_dispatches SET status='completed',result=result||$3::jsonb,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2")
            .bind(actor.tenant_id).bind(id).bind(&result).execute(&mut *tx).await?;
        complete_step(&mut tx, &actor, &row, result).await?;
        event(
            &mut tx,
            &actor,
            id,
            "downstream_review_confirmed",
            json!({"downstream_kind":kind,"downstream_id":downstream}),
        )
        .await?;
        audit(&mut tx, &actor, "practice.workflow_dispatch.confirmed", id).await?;
        let value = snapshot(&mut tx, &actor, id).await?;
        tx.commit().await?;
        return Ok(reply(value));
    }
    if input.action == "reject" && row.status == "pending_review" {
        sqlx::query("UPDATE workflow_dispatches SET status='rejected',reviewed_by=$3,review_reason=$4,reviewed_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2")
            .bind(actor.tenant_id).bind(id).bind(actor.sub).bind(input.reason.trim()).execute(&mut *tx).await?;
        sqlx::query("UPDATE care_pathway_steps SET state='in_progress',version=version+1,evidence=evidence||jsonb_build_object('status','rejected','review_reason',$4::text),updated_by=$5,updated_at=now() WHERE tenant_id=$1 AND instance_id=$2 AND step_key=$3 AND evidence->>'workflow_dispatch_id'=$6")
            .bind(actor.tenant_id).bind(row.instance).bind(&row.step).bind(input.reason.trim()).bind(actor.sub).bind(id.to_string()).execute(&mut *tx).await?;
        event(
            &mut tx,
            &actor,
            id,
            "dispatch_rejected",
            json!({"reason":input.reason}),
        )
        .await?;
        audit(&mut tx, &actor, "practice.workflow_dispatch.rejected", id).await?;
        let value = snapshot(&mut tx, &actor, id).await?;
        tx.commit().await?;
        return Ok(reply(value));
    }
    if input.action != "approve" || row.status != "pending_review" {
        return Err(Error::Conflict("invalid workflow dispatch action"));
    }
    let privacy = if is_ai(&row.kind) {
        let preview_id = approved_privacy_id(&input)?;
        let binding = review_binding(&mut tx, &actor, &row).await?;
        let revision = bound_revision(&row, &binding)?;
        let value: AiDraftInput = serde_json::from_value(row.input.clone())
            .map_err(|_| Error::Invalid("invalid Sun draft input"))?;
        crate::claude_adapter::validate_workflow_preview(
            &state,
            &actor,
            row.id,
            preview_id,
            value.integration_id,
            ai_purpose(&row.kind)?,
            &value.instruction,
            &value.source_text,
            binding.patient_id,
            &revision,
        )
        .await?;
        Some(AiPrivacyApproval {
            preview_id,
            patient_id: binding.patient_id,
            revision,
        })
    } else {
        None
    };
    sqlx::query("UPDATE workflow_dispatches SET status='executing',reviewed_by=$3,review_reason=$4,reviewed_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).bind(actor.sub).bind(input.reason.trim()).execute(&mut *tx).await?;
    event(
        &mut tx,
        &actor,
        id,
        "dispatch_approved",
        json!({"kind":row.kind}),
    )
    .await?;
    audit(&mut tx, &actor, "practice.workflow_dispatch.approved", id).await?;
    tx.commit().await?;

    let outcome = execute(state.clone(), &actor, &row, privacy).await;
    finish(state, &actor, row, outcome).await
}

async fn verify_downstream(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    kind: &str,
    id: Uuid,
) -> Result<()> {
    let accepted=match kind {
        "payment"=>sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM payment_attempts WHERE tenant_id=$1 AND id=$2 AND status='paid' AND paid_entry_id IS NOT NULL AND refunded_cents=0)").bind(actor.tenant_id).bind(id).fetch_one(&mut **tx).await?,
        "ai_draft" | "claude_draft"=>sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM claude_drafts WHERE tenant_id=$1 AND id=$2 AND status='approved')").bind(actor.tenant_id).bind(id).fetch_one(&mut **tx).await?,
        "gmail_draft"=>sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM gmail_outbound_drafts WHERE tenant_id=$1 AND id=$2 AND status='sent')").bind(actor.tenant_id).bind(id).fetch_one(&mut **tx).await?,
        "ringcentral_draft"=>sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM ringcentral_outbound_drafts WHERE tenant_id=$1 AND id=$2 AND status='accepted')").bind(actor.tenant_id).bind(id).fetch_one(&mut **tx).await?,
        _=>false,
    };
    if accepted {
        Ok(())
    } else {
        Err(Error::Conflict(
            "downstream draft has not completed its explicit review/send gate",
        ))
    }
}

async fn dispatch_permission(state: &State, actor: &Actor, kind: &str) -> Result<()> {
    let (resource, operation) = match kind {
        "eligibility_query" | "payment_request" => ("billing", "create"),
        "availability_query" => ("scheduling", "view"),
        "slot_hold" | "appointment_booking" | "intake_request" => ("scheduling", "create"),
        "appointment_reschedule" => ("scheduling", "edit"),
        "appointment_cancel" => ("scheduling", "delete"),
        "communication_send" => ("communications", "create"),
        "ai_extract_draft" | "ai_response_draft" => ("ai", "create"),
        _ => return Err(Error::Invalid("unsupported workflow dispatch kind")),
    };
    crate::access_policies::require_native(state, actor, resource, operation).await
}

async fn dispatch_oauth_scope(
    state: &State,
    actor: &Actor,
    headers: &HeaderMap,
    row: &DispatchRow,
) -> Result<()> {
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| value.starts_with("sce_at_"))
    else {
        return Ok(());
    };
    // Internal native helpers do not pass through HTTP authentication again.
    // Check the downstream scope before approving or creating a privacy row;
    // permission to edit a workflow alone never grants scheduling access.
    let (method, route) = match row.kind.as_str() {
        "eligibility_query" => (
            Method::POST,
            "/api/v1/patients/{patient}/coverages/{coverage}/claimmd-eligibility",
        ),
        "payment_request" => (Method::POST, "/api/v1/billing/accounts/{id}/payments"),
        "availability_query" => (Method::GET, "/api/v1/scheduling/availability"),
        "slot_hold" => (Method::POST, "/api/v1/scheduling/holds"),
        // Intake is a new appointment-linked scheduling artifact, so it shares
        // the scheduling write boundary even though its UI route is nested.
        "appointment_booking" | "intake_request" => {
            (Method::POST, "/api/v1/scheduling/appointments")
        }
        "appointment_reschedule" => (
            Method::POST,
            "/api/v1/scheduling/appointments/{id}/reschedule",
        ),
        "appointment_cancel" => (Method::POST, "/api/v1/scheduling/appointments/{id}/cancel"),
        "communication_send" if row.input["provider"] == "ringcentral" => (
            Method::POST,
            "/api/v1/integrations/ringcentral/{id}/outbound",
        ),
        "communication_send" => (
            Method::POST,
            "/api/v1/integrations/{id}/gmail/outbound-drafts",
        ),
        "ai_extract_draft" | "ai_response_draft" => (Method::POST, "/api/v1/ai/drafts"),
        _ => return Err(Error::Invalid("unsupported workflow dispatch kind")),
    };
    let checked = crate::oauth::authenticate(state, token, &method, route).await?;
    if checked.tenant_id != actor.tenant_id
        || checked.sub != actor.sub
        || role_key(&checked.role) != role_key(&actor.role)
    {
        return Err(Error::Forbidden);
    }
    Ok(())
}

async fn execute(
    state: State,
    actor: &Actor,
    row: &DispatchRow,
    privacy: Option<AiPrivacyApproval>,
) -> Result<Outcome> {
    dispatch_permission(&state, actor, &row.kind).await?;
    execution_binding(&state, actor, row).await?;
    match row.kind.as_str() {
        "eligibility_query" => eligibility(&state, actor, row).await,
        "payment_request" => payment_request(&state, actor, row).await,
        "availability_query" => availability(&state, actor, row.instance, &row.input).await,
        "slot_hold" => hold(&state, actor, row.id, row.instance, &row.input).await,
        "appointment_booking" => book(&state, actor, row.id, row.instance, &row.input).await,
        "appointment_reschedule" => reschedule(&state, actor, row.instance, &row.input).await,
        "appointment_cancel" => cancel(&state, actor, row.instance, &row.input).await,
        "intake_request" => intake(&state, actor, row.instance, &row.input).await,
        "communication_send" => communication_draft(&state, actor, row).await,
        "ai_extract_draft" | "ai_response_draft" => {
            let privacy = privacy.ok_or(Error::Invalid("Sun privacy approval is required"))?;
            ai_draft(&state, actor, row, privacy).await
        }
        _ => Err(Error::Invalid("unsupported workflow dispatch kind")),
    }
}

async fn execution_binding(state: &State, actor: &Actor, row: &DispatchRow) -> Result<()> {
    let mut tx = db(state)?.begin().await?;
    let current: Option<(String, i64)> = sqlx::query_as(
        "SELECT status,version FROM workflow_dispatches WHERE tenant_id=$1 AND id=$2 FOR SHARE",
    )
    .bind(actor.tenant_id)
    .bind(row.id)
    .fetch_optional(&mut *tx)
    .await?;
    if !current.is_some_and(|(status, version)| {
        status == "executing" && row.version.checked_add(1) == Some(version)
    }) {
        return Err(Error::Conflict(
            "workflow dispatch is no longer executing this approval",
        ));
    }
    review_binding(&mut tx, actor, row).await?;
    // Native operations retain their own record/version checks. Do not hold a
    // database transaction across an external provider request.
    tx.commit().await?;
    Ok(())
}

async fn finish(
    state: State,
    actor: &Actor,
    row: DispatchRow,
    outcome: Result<Outcome>,
) -> Result<Response> {
    let mut tx = db(&state)?.begin().await?;
    match outcome {
        Ok(Outcome::Completed { result, one_time }) => {
            sqlx::query("UPDATE workflow_dispatches SET status='completed',result=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='executing'")
                .bind(actor.tenant_id).bind(row.id).bind(&result).execute(&mut *tx).await?;
            complete_step(&mut tx, actor, &row, result).await?;
            event(
                &mut tx,
                actor,
                row.id,
                "dispatch_completed",
                json!({"kind":row.kind}),
            )
            .await?;
            audit(
                &mut tx,
                actor,
                "practice.workflow_dispatch.finished",
                row.id,
            )
            .await?;
            let value = snapshot(&mut tx, actor, row.id).await?;
            tx.commit().await?;
            return Ok(reply(if let Some(secret) = one_time {
                json!({"dispatch":value,"one_time":secret})
            } else {
                value
            }));
        }
        Ok(Outcome::Downstream { kind, id, result }) => {
            sqlx::query("UPDATE workflow_dispatches SET status='downstream_review',downstream_kind=$3,downstream_id=$4,result=$5,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='executing'")
                .bind(actor.tenant_id).bind(row.id).bind(kind).bind(id).bind(&result).execute(&mut *tx).await?;
            sqlx::query("UPDATE care_pathway_steps SET evidence=evidence||jsonb_build_object('status','downstream_review','downstream_kind',$4::text,'downstream_id',$5::uuid),version=version+1,updated_by=$6,updated_at=now() WHERE tenant_id=$1 AND instance_id=$2 AND step_key=$3 AND state='awaiting_approval' AND evidence->>'workflow_dispatch_id'=$7 AND EXISTS(SELECT 1 FROM care_pathway_instances i WHERE i.tenant_id=$1 AND i.id=$2 AND i.status='active')")
                .bind(actor.tenant_id).bind(row.instance).bind(&row.step).bind(kind).bind(id).bind(actor.sub).bind(row.id.to_string()).execute(&mut *tx).await?;
            event(
                &mut tx,
                actor,
                row.id,
                "downstream_draft_created",
                json!({"downstream_kind":kind,"downstream_id":id}),
            )
            .await?;
        }
        Err(_) => {
            sqlx::query("UPDATE workflow_dispatches SET status='failed',failure_code='native_operation_failed',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='executing'")
                .bind(actor.tenant_id).bind(row.id).execute(&mut *tx).await?;
            sqlx::query("UPDATE care_pathway_steps SET state='in_progress',evidence=evidence||jsonb_build_object('status','failed','failure_code','native_operation_failed'),version=version+1,updated_by=$4,updated_at=now() WHERE tenant_id=$1 AND instance_id=$2 AND step_key=$3 AND state='awaiting_approval' AND evidence->>'workflow_dispatch_id'=$5 AND EXISTS(SELECT 1 FROM care_pathway_instances i WHERE i.tenant_id=$1 AND i.id=$2 AND i.status='active')")
                .bind(actor.tenant_id).bind(row.instance).bind(&row.step).bind(actor.sub).bind(row.id.to_string()).execute(&mut *tx).await?;
            event(
                &mut tx,
                actor,
                row.id,
                "dispatch_failed",
                json!({"failure_code":"native_operation_failed"}),
            )
            .await?;
        }
    }
    audit(
        &mut tx,
        actor,
        "practice.workflow_dispatch.finished",
        row.id,
    )
    .await?;
    let value = snapshot(&mut tx, actor, row.id).await?;
    tx.commit().await?;
    Ok(reply(value))
}

async fn complete_step(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    row: &DispatchRow,
    result: Value,
) -> Result<()> {
    let changed=sqlx::query("UPDATE care_pathway_steps SET state='completed',evidence=evidence||jsonb_build_object('status','completed','result',$4::jsonb),version=version+1,updated_by=$5,updated_at=now() WHERE tenant_id=$1 AND instance_id=$2 AND step_key=$3 AND state='awaiting_approval' AND evidence->>'workflow_dispatch_id'=$6 AND EXISTS(SELECT 1 FROM care_pathway_instances i WHERE i.tenant_id=$1 AND i.id=$2 AND i.status='active')")
        .bind(actor.tenant_id).bind(row.instance).bind(&row.step).bind(result).bind(actor.sub).bind(row.id.to_string()).execute(&mut **tx).await?;
    if changed.rows_affected() == 1 {
        sqlx::query("INSERT INTO care_pathway_events(tenant_id,instance_id,step_key,event_type,actor_id,reason,evidence) VALUES($1,$2,$3,'step.dispatch_completed',$4,'Reviewed native workflow operation completed',$5)")
            .bind(actor.tenant_id).bind(row.instance).bind(&row.step).bind(actor.sub).bind(json!({"workflow_dispatch_id":row.id})).execute(&mut **tx).await?;
        crate::care_pathways::refresh_ready_steps(tx, actor, row.instance).await?;
    } else {
        event(
            tx,
            actor,
            row.id,
            "pathway_link_changed",
            json!({"pathway_instance_id":row.instance,"step_key":row.step}),
        )
        .await?;
    }
    Ok(())
}

async fn pathway_patient(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    instance: Uuid,
    provided: Option<Uuid>,
) -> Result<Uuid> {
    let patient: Option<Uuid> = sqlx::query_scalar(
        "SELECT patient_id FROM care_pathway_instances WHERE tenant_id=$1 AND id=$2",
    )
    .bind(actor.tenant_id)
    .bind(instance)
    .fetch_one(&mut **tx)
    .await?;
    match (patient, provided) {
        (Some(expected), Some(provided)) if expected != provided => Err(Error::Conflict(
            "workflow patient does not match the requested clinical operation",
        )),
        (Some(expected), _) => Ok(expected),
        (None, Some(provided)) => Ok(provided),
        (None, None) => Err(Error::Invalid("workflow requires a patient")),
    }
}

async fn eligibility(state: &State, actor: &Actor, row: &DispatchRow) -> Result<Outcome> {
    let value: EligibilityInput = serde_json::from_value(row.input.clone())
        .map_err(|_| Error::Invalid("invalid eligibility input"))?;
    let mut tx = db(state)?.begin().await?;
    let patient = pathway_patient(&mut tx, actor, row.instance, None).await?;
    tx.commit().await?;
    let request = eligibility_request(&value.request, row.id)?;
    execution_binding(state, actor, row).await?;
    let result = crate::claimmd_eligibility::run_eligibility(
        state,
        actor,
        patient,
        value.coverage_id,
        request,
    )
    .await?;
    // A returned response is evidence for staff review, never a coverage or
    // provider-participation approval. Keep benefit contents in their native record.
    Ok(Outcome::Completed {
        result: json!({"eligibility_id":result["id"],"status":result["status"],"coverage_id":value.coverage_id,"requires_benefit_review":true}),
        one_time: None,
    })
}

async fn payment_request(state: &State, actor: &Actor, row: &DispatchRow) -> Result<Outcome> {
    let value: PaymentInput = serde_json::from_value(row.input.clone())
        .map_err(|_| Error::Invalid("invalid payment input"))?;
    let mut tx = db(state)?.begin().await?;
    let (patient,visit,appointment): (Uuid,Option<Uuid>,Option<Uuid>) = sqlx::query_as(
        "SELECT b.patient_id,b.visit_id,v.appointment_id FROM billing_accounts b LEFT JOIN visits v ON v.tenant_id=b.tenant_id AND v.id=b.visit_id AND v.patient_id=b.patient_id WHERE b.tenant_id=$1 AND b.id=$2 FOR SHARE OF b",
    )
    .bind(actor.tenant_id)
    .bind(value.account_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    let (run_patient,run_visit,run_appointment): (Option<Uuid>,Option<Uuid>,Option<Uuid>) = sqlx::query_as(
        "SELECT patient_id,visit_id,appointment_id FROM care_pathway_instances WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",
    ).bind(actor.tenant_id).bind(row.instance).fetch_optional(&mut *tx).await?.ok_or(Error::Conflict("workflow run is no longer active"))?;
    payment_context(
        run_patient,
        run_visit,
        run_appointment,
        patient,
        visit,
        appointment,
    )?;
    tx.commit().await?;
    execution_binding(state, actor, row).await?;
    let result = crate::payments::create_native(
        state,
        actor,
        value.account_id,
        value.expected_version,
        crate::payments::NewPayment {
            request_id: row.id,
            amount_cents: value.amount_cents,
        },
    )
    .await?;
    let payment = &result["payment"];
    let id = payment["id"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or(Error::Invalid("native payment response missing identifier"))?;
    Ok(Outcome::Downstream {
        kind: "payment",
        id,
        result: json!({"payment_id":id,"account_id":value.account_id,"status":payment["status"],"checkout_url":payment["checkout_url"],"test_mode":payment["test_mode"]}),
    })
}

fn payment_context(
    run_patient: Option<Uuid>,
    run_visit: Option<Uuid>,
    run_appointment: Option<Uuid>,
    account_patient: Uuid,
    account_visit: Option<Uuid>,
    account_appointment: Option<Uuid>,
) -> Result<()> {
    if run_patient != Some(account_patient)
        || run_visit.is_some_and(|visit| account_visit != Some(visit))
        || run_appointment.is_some_and(|appointment| account_appointment != Some(appointment))
    {
        return Err(Error::Conflict(
            "payment account does not match the workflow patient and linked encounter",
        ));
    }
    Ok(())
}

async fn availability(
    state: &State,
    actor: &Actor,
    instance: Uuid,
    input: &Value,
) -> Result<Outcome> {
    let value: AvailabilityInput = serde_json::from_value(input.clone())
        .map_err(|_| Error::Invalid("invalid availability input"))?;
    let mut tx = db(state)?.begin().await?;
    crate::scheduling::tenant_lock(&mut tx, actor).await?;
    let patient = pathway_patient(&mut tx, actor, instance, value.patient_id).await?;
    crate::scheduling::provider_locked(&mut tx, actor, value.clinician_id, false).await?;
    crate::scheduling::available(
        &mut tx,
        actor,
        value.clinician_id,
        patient,
        value.starts_at,
        value.ends_at,
        &value.facility,
        &value.room,
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(Outcome::Completed {
        result: json!({"available":true,"starts_at":value.starts_at,"ends_at":value.ends_at,"clinician_id":value.clinician_id}),
        one_time: None,
    })
}

async fn hold(
    state: &State,
    actor: &Actor,
    request: Uuid,
    instance: Uuid,
    input: &Value,
) -> Result<Outcome> {
    let value: HoldInput =
        serde_json::from_value(input.clone()).map_err(|_| Error::Invalid("invalid hold input"))?;
    let mut tx = db(state)?.begin().await?;
    crate::scheduling::tenant_lock(&mut tx, actor).await?;
    let patient = pathway_patient(&mut tx, actor, instance, value.patient_id).await?;
    let service:Option<(Uuid,i32,String,String)>=sqlx::query_as("SELECT clinician_id,duration_minutes,facility,room FROM scheduling_services WHERE tenant_id=$1 AND id=$2 AND enabled FOR SHARE")
        .bind(actor.tenant_id).bind(value.service_id).fetch_optional(&mut *tx).await?;
    let (clinician, duration, facility, room) = service.ok_or(Error::NotFound)?;
    if value.ends_at - value.starts_at != Duration::minutes(i64::from(duration)) {
        return Err(Error::Invalid("hold duration does not match service"));
    }
    crate::scheduling::provider_locked(&mut tx, actor, clinician, false).await?;
    crate::scheduling::available(
        &mut tx,
        actor,
        clinician,
        patient,
        value.starts_at,
        value.ends_at,
        &facility,
        &room,
        None,
    )
    .await?;
    let id = Uuid::new_v4();
    let expires = Utc::now() + Duration::minutes(10);
    let digest = crate::oauth::hash(&input.to_string());
    sqlx::query("INSERT INTO scheduling_holds(tenant_id,id,service_id,actor_id,starts_at,ends_at,expires_at,request_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
        .bind(actor.tenant_id).bind(id).bind(value.service_id).bind(actor.sub).bind(value.starts_at).bind(value.ends_at).bind(expires).bind(request).bind(digest).execute(&mut *tx).await?;
    audit(&mut tx, actor, "schedule.workflow_hold", id).await?;
    tx.commit().await?;
    Ok(Outcome::Completed {
        result: json!({"hold_id":id,"expires_at":expires}),
        one_time: None,
    })
}

async fn book(
    state: &State,
    actor: &Actor,
    request: Uuid,
    instance: Uuid,
    input: &Value,
) -> Result<Outcome> {
    let mut value: NewAppointment = serde_json::from_value(input.clone())
        .map_err(|_| Error::Invalid("invalid appointment booking input"))?;
    let mut tx = db(state)?.begin().await?;
    pathway_patient(&mut tx, actor, instance, Some(value.patient_id)).await?;
    tx.commit().await?;
    value.request_id = Some(request);
    value.source_history_id = None;
    let appointment = state.backend.book(actor, value).await?;
    Ok(Outcome::Completed {
        result: json!({"appointment_id":appointment.id,"version":appointment.version,"status":appointment.status}),
        one_time: None,
    })
}

async fn reschedule(
    state: &State,
    actor: &Actor,
    instance: Uuid,
    input: &Value,
) -> Result<Outcome> {
    let value: RescheduleInput = serde_json::from_value(input.clone())
        .map_err(|_| Error::Invalid("invalid reschedule input"))?;
    text(&value.title, 200)?;
    text(&value.category, 100)?;
    let mut tx = db(state)?.begin().await?;
    crate::scheduling::tenant_lock(&mut tx, actor).await?;
    let old: Appointment =
        sqlx::query_as("SELECT * FROM appointments WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
            .bind(actor.tenant_id)
            .bind(value.appointment_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
    if old.version != value.expected_version || old.status != "booked" {
        return Err(Error::Conflict(
            "appointment changed or cannot be rescheduled",
        ));
    }
    pathway_patient(&mut tx, actor, instance, Some(old.patient_id)).await?;
    let booking = NewAppointment {
        request_id: None,
        source_history_id: None,
        title: value.title,
        category: value.category,
        facility: value.facility,
        room: value.room,
        notes: value.notes,
        reason: "Reviewed workflow reschedule".into(),
        patient_id: old.patient_id,
        clinician_id: value.clinician_id,
        starts_at: value.starts_at,
        ends_at: value.ends_at,
    };
    crate::scheduling::validate_booking(&booking)?;
    crate::scheduling::provider_locked(&mut tx, actor, booking.clinician_id, false).await?;
    crate::scheduling::available(
        &mut tx,
        actor,
        booking.clinician_id,
        booking.patient_id,
        booking.starts_at,
        booking.ends_at,
        &booking.facility,
        &booking.room,
        Some(value.appointment_id),
    )
    .await?;
    sqlx::query("UPDATE appointments SET clinician_id=$3,starts_at=$4,ends_at=$5,title=$6,category=$7,facility=$8,room=$9,notes=$10,version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(value.appointment_id).bind(booking.clinician_id).bind(booking.starts_at).bind(booking.ends_at).bind(&booking.title).bind(&booking.category).bind(&booking.facility).bind(&booking.room).bind(&booking.notes).execute(&mut *tx).await?;
    crate::scheduling::revision(&mut tx, actor, value.appointment_id, &booking.reason).await?;
    audit(
        &mut tx,
        actor,
        "appointment.workflow_reschedule",
        value.appointment_id,
    )
    .await?;
    let version: i64 =
        sqlx::query_scalar("SELECT version FROM appointments WHERE tenant_id=$1 AND id=$2")
            .bind(actor.tenant_id)
            .bind(value.appointment_id)
            .fetch_one(&mut *tx)
            .await?;
    let appointment: Appointment =
        sqlx::query_as("SELECT * FROM appointments WHERE tenant_id=$1 AND id=$2")
            .bind(actor.tenant_id)
            .bind(value.appointment_id)
            .fetch_one(&mut *tx)
            .await?;
    crate::scheduling::emit_appointment_event(
        &mut tx,
        actor,
        &appointment,
        "suncharts.appointment.rescheduled",
    )
    .await?;
    tx.commit().await?;
    Ok(Outcome::Completed {
        result: json!({"appointment_id":value.appointment_id,"version":version,"status":"booked"}),
        one_time: None,
    })
}

async fn cancel(state: &State, actor: &Actor, instance: Uuid, input: &Value) -> Result<Outcome> {
    let value: AppointmentActionInput = serde_json::from_value(input.clone())
        .map_err(|_| Error::Invalid("invalid cancellation input"))?;
    let mut tx = db(state)?.begin().await?;
    crate::scheduling::tenant_lock(&mut tx, actor).await?;
    let old: Appointment =
        sqlx::query_as("SELECT * FROM appointments WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
            .bind(actor.tenant_id)
            .bind(value.appointment_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
    if old.version != value.expected_version
        || !["booked", "checked_in"].contains(&old.status.as_str())
    {
        return Err(Error::Conflict(
            "appointment changed or cannot be cancelled",
        ));
    }
    pathway_patient(&mut tx, actor, instance, Some(old.patient_id)).await?;
    sqlx::query(
        "UPDATE appointments SET status='cancelled',version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(actor.tenant_id)
    .bind(value.appointment_id)
    .execute(&mut *tx)
    .await?;
    crate::scheduling::revision(
        &mut tx,
        actor,
        value.appointment_id,
        "Reviewed workflow cancellation",
    )
    .await?;
    audit(
        &mut tx,
        actor,
        "appointment.workflow_cancel",
        value.appointment_id,
    )
    .await?;
    let appointment: Appointment =
        sqlx::query_as("SELECT * FROM appointments WHERE tenant_id=$1 AND id=$2")
            .bind(actor.tenant_id)
            .bind(value.appointment_id)
            .fetch_one(&mut *tx)
            .await?;
    crate::scheduling::emit_appointment_event(
        &mut tx,
        actor,
        &appointment,
        "suncharts.appointment.cancelled",
    )
    .await?;
    tx.commit().await?;
    Ok(Outcome::Completed {
        result: json!({"appointment_id":value.appointment_id,"version":old.version+1,"status":"cancelled"}),
        one_time: None,
    })
}

async fn intake(state: &State, actor: &Actor, instance: Uuid, input: &Value) -> Result<Outcome> {
    let value: IntakeInput = serde_json::from_value(input.clone())
        .map_err(|_| Error::Invalid("invalid intake input"))?;
    let mut tx = db(state)?.begin().await?;
    if let Some(step) = value.form_step_key.as_deref() {
        crate::access_policies::require_native(state, actor, "workflows", "edit").await?;
        let (packet, plain) = crate::previsit::issue_for_workflow(
            &mut tx,
            actor,
            instance,
            step,
            None,
            value.appointment_id,
            "Approved workflow intake request",
        )
        .await?;
        tx.commit().await?;
        return Ok(Outcome::Completed {
            result: json!({"packet_id":packet,"form_step_key":step,"awaiting_patient_submission_and_review":true,"secret_shown_once":plain.is_some()}),
            one_time: plain.map(|token| json!({"intake_url":format!("/intake#token={token}")})),
        });
    }
    let appointment: Option<Uuid> = if value.appointment_id.is_some() {
        value.appointment_id
    } else {
        sqlx::query_scalar(
            "SELECT appointment_id FROM care_pathway_instances WHERE tenant_id=$1 AND id=$2",
        )
        .bind(actor.tenant_id)
        .bind(instance)
        .fetch_one(&mut *tx)
        .await?
    };
    let appointment =
        appointment.ok_or(Error::Invalid("intake request requires an appointment"))?;
    let row: Option<(Uuid, DateTime<Utc>)> = sqlx::query_as(
        "SELECT patient_id,starts_at FROM appointments WHERE tenant_id=$1 AND id=$2 FOR SHARE",
    )
    .bind(actor.tenant_id)
    .bind(appointment)
    .fetch_optional(&mut *tx)
    .await?;
    let (patient, due) = row.ok_or(Error::NotFound)?;
    pathway_patient(&mut tx, actor, instance, Some(patient)).await?;
    if sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM previsit_intake_packets WHERE tenant_id=$1 AND appointment_id=$2 AND workflow_instance_id IS NULL AND status<>'void')").bind(actor.tenant_id).bind(appointment).fetch_one(&mut *tx).await?{return Err(Error::Conflict("an intake packet already exists"));}
    let (packet, token) = crate::previsit::issue_for_appointment(
        &mut tx,
        actor.tenant_id,
        appointment,
        patient,
        actor.sub,
        due,
    )
    .await?
    .ok_or(Error::Conflict("configure an active intake template first"))?;
    audit(&mut tx, actor, "previsit.workflow_packet_issue", packet).await?;
    tx.commit().await?;
    Ok(Outcome::Completed {
        result: json!({"packet_id":packet,"secret_shown_once":true}),
        one_time: Some(json!({"intake_url":format!("/intake#token={token}")})),
    })
}

async fn communication_draft(state: &State, actor: &Actor, row: &DispatchRow) -> Result<Outcome> {
    let value: CommunicationInput = serde_json::from_value(row.input.clone())
        .map_err(|_| Error::Invalid("invalid communication draft input"))?;
    if value.provider == "ringcentral" {
        let input = value
            .ringcentral
            .ok_or(Error::Invalid("RingCentral draft payload is required"))?;
        let result = crate::ringcentral_adapter::create_outbound_draft(
            db(state)?,
            actor,
            value.integration_id,
            row.id,
            "workflow",
            input,
        )
        .await?;
        let id = result
            .get("id")
            .and_then(Value::as_str)
            .and_then(|v| Uuid::parse_str(v).ok())
            .ok_or(Error::Conflict("RingCentral draft response is invalid"))?;
        return Ok(Outcome::Downstream {
            kind: "ringcentral_draft",
            id,
            result: json!({"human_review_required":true}),
        });
    }
    let attachments = value
        .attachments
        .into_iter()
        .map(|item| {
            let content = BASE64
                .decode(item.content_base64.as_bytes())
                .map_err(|_| Error::Invalid("invalid Gmail attachment encoding"))?;
            Ok(
                crate::gmail_referral_adapter::GmailOutboundAttachmentInput {
                    filename: item.filename,
                    mime_type: item.mime_type,
                    content,
                },
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let input = crate::gmail_referral_adapter::GmailOutboundDraftInput {
        idempotency_key: format!("workflow-dispatch-{}", row.id),
        inbox_id: value.inbox_id,
        to: value.to,
        cc: value.cc,
        subject: value.subject,
        body_text: value.body_text,
        attachments,
    };
    let mut tx = db(state)?.begin().await?;
    let (id, _) = crate::gmail_referral_adapter::create_outbound_draft_in_tx(
        &mut tx,
        actor,
        value.integration_id,
        input,
    )
    .await?;
    tx.commit().await?;
    Ok(Outcome::Downstream {
        kind: "gmail_draft",
        id,
        result: json!({"human_review_required":true}),
    })
}

async fn ai_draft(
    state: &State,
    actor: &Actor,
    row: &DispatchRow,
    privacy: AiPrivacyApproval,
) -> Result<Outcome> {
    let value: AiDraftInput = serde_json::from_value(row.input.clone())
        .map_err(|_| Error::Invalid("invalid AI draft input"))?;
    let purpose = ai_purpose(&row.kind)?;
    let id = crate::claude_adapter::generate_for_workflow(
        state,
        actor,
        row.id,
        value.integration_id,
        purpose,
        value.instruction,
        value.source_text,
        privacy.preview_id,
        true,
        privacy.patient_id,
        privacy.revision,
    )
    .await?;
    Ok(Outcome::Downstream {
        kind: "ai_draft",
        id,
        result: json!({"human_review_required":true}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn payment_account_must_match_the_run_patient_and_any_linked_encounter() {
        let (patient, visit, appointment) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        assert!(payment_context(
            Some(patient),
            Some(visit),
            Some(appointment),
            patient,
            Some(visit),
            Some(appointment)
        )
        .is_ok());
        // A patient-level run may intentionally collect an account without a
        // linked visit, but an unbound run cannot choose an arbitrary patient.
        assert!(payment_context(Some(patient), None, None, patient, None, None).is_ok());
        assert!(
            payment_context(None, None, None, patient, Some(visit), Some(appointment)).is_err()
        );
        assert!(payment_context(
            Some(Uuid::new_v4()),
            None,
            None,
            patient,
            Some(visit),
            Some(appointment)
        )
        .is_err());
        assert!(payment_context(
            Some(patient),
            Some(Uuid::new_v4()),
            None,
            patient,
            Some(visit),
            Some(appointment)
        )
        .is_err());
        assert!(payment_context(
            Some(patient),
            None,
            Some(Uuid::new_v4()),
            patient,
            Some(visit),
            Some(appointment)
        )
        .is_err());
        assert!(payment_context(Some(patient), Some(visit), None, patient, None, None).is_err());
        assert!(payment_context(
            Some(patient),
            None,
            Some(appointment),
            patient,
            Some(visit),
            None
        )
        .is_err());
    }
    #[test]
    fn dispatch_kinds_are_bounded() {
        assert!(KINDS.contains(&"appointment_booking"));
        assert!(!KINDS.contains(&"arbitrary_sql"));
    }
    #[test]
    fn public_ai_dispatch_omits_original_source_but_native_input_remains_reviewable() {
        let original = json!({"id":Uuid::new_v4(),"kind":"ai_extract_draft","input":{"instruction":"For Taylor Synthetic","source_text":"Synthetic MRN SYN-123"},"status":"pending_review"});
        let public = public_dispatch(original.clone());
        assert!(public.get("input").is_none());
        assert_eq!(public["privacy_review_required"], true);
        assert!(!public.to_string().contains("Taylor Synthetic"));
        assert!(!public.to_string().contains("SYN-123"));
        let mut scheduling = original;
        scheduling["kind"] = json!("appointment_booking");
        assert_eq!(public_dispatch(scheduling.clone()), scheduling);
    }

    #[test]
    fn ai_execution_requires_an_explicit_non_nil_preview_approval() {
        for value in [
            json!({"action":"approve","reason":"Reviewed"}),
            json!({"action":"approve","reason":"Reviewed","privacy_preview_id":Uuid::new_v4()}),
            json!({"action":"approve","reason":"Reviewed","privacy_approved":true}),
            json!({"action":"approve","reason":"Reviewed","privacy_preview_id":Uuid::nil(),"privacy_approved":true}),
        ] {
            let action: DispatchAction = serde_json::from_value(value).unwrap();
            assert!(approved_privacy_id(&action).is_err());
        }
        let id = Uuid::new_v4();
        let action: DispatchAction = serde_json::from_value(json!({"action":"approve","reason":"Reviewed","privacy_preview_id":id,"privacy_approved":true})).unwrap();
        assert_eq!(approved_privacy_id(&action).unwrap(), id);
    }

    #[test]
    fn preview_revision_binds_the_active_run_and_exact_awaiting_dispatch() {
        let row = DispatchRow {
            id: Uuid::new_v4(),
            instance: Uuid::new_v4(),
            step: "extract".into(),
            kind: "ai_extract_draft".into(),
            status: "pending_review".into(),
            input: json!({}),
            version: 3,
            downstream_kind: None,
            downstream_id: None,
        };
        let mut binding = ReviewBinding {
            instance_status: "active".into(),
            patient_id: Some(Uuid::new_v4()),
            definition_version: 7,
            kind: row.kind.clone(),
            manual_approval: true,
            step_state: "awaiting_approval".into(),
            dispatch_id: Some(row.id.to_string()),
        };
        let revision = bound_revision(&row, &binding).unwrap();
        assert_eq!(revision["dispatch_version"], 3);
        assert_eq!(revision["definition_version"], 7);
        assert_eq!(revision["pathway_instance_id"], row.instance.to_string());
        assert!(revision.get("patient_id").is_none());
        binding.instance_status = "cancelled".into();
        assert!(bound_revision(&row, &binding).is_err());
        binding.instance_status = "active".into();
        for state in ["completed", "skipped", "ready", "in_progress"] {
            binding.step_state = state.into();
            assert!(bound_revision(&row, &binding).is_err());
        }
        binding.step_state = "awaiting_approval".into();
        binding.dispatch_id = Some(Uuid::new_v4().to_string());
        assert!(bound_revision(&row, &binding).is_err());
        binding.dispatch_id = Some(row.id.to_string());
        binding.kind = "ai_response_draft".into();
        assert!(bound_revision(&row, &binding).is_err());
        binding.kind = row.kind.clone();
        binding.manual_approval = false;
        assert!(bound_revision(&row, &binding).is_err());
    }
    #[test]
    fn sun_prepares_only_the_explicit_text_field_from_the_instance_revision() {
        let integration = Uuid::new_v4();
        let definition = json!({"steps":[{
            "key":"extract", "title":"Extract", "kind":"ai_extract_draft", "manual_approval":true,
            "ai":{"integration_id":integration,"instruction":"Extract the explicit appointment day.","source_field":"/referral/body"}
        }]});
        let context = json!({"referral":{"body":"Synthetic appointment Monday."},"unrelated":"Must stay local"});
        let input = prepare_ai_input("ai_extract_draft", "extract", &definition, &context).unwrap();
        assert_eq!(
            input,
            json!({"integration_id":integration,"instruction":"Extract the explicit appointment day.","source_text":"Synthetic appointment Monday."})
        );
        assert!(prepare_ai_input("ai_response_draft", "extract", &definition, &context).is_err());
        for context in [
            json!({}),
            json!({"referral":{"body":{"nested":"not text"}}}),
            json!({"referral":{"body":""}}),
            json!({"referral":{"body":"x".repeat(65_537)}}),
        ] {
            assert!(
                prepare_ai_input("ai_extract_draft", "extract", &definition, &context).is_err()
            );
        }
        let mut escaped = definition;
        escaped["steps"][0]["ai"]["source_field"] = json!("/referral~1message/body~0text");
        assert_eq!(
            prepare_ai_input(
                "ai_extract_draft",
                "extract",
                &escaped,
                &json!({"referral/message":{"body~text":"Explicit source"}})
            )
            .unwrap()["source_text"],
            "Explicit source"
        );
    }
    #[test]
    fn communication_requires_supported_provider() {
        assert!(validate_input("communication_send",&json!({"provider":"gmail","integration_id":Uuid::nil(),"to":["a@example.test"],"subject":"Referral","body_text":"Review"})).is_ok());
        assert!(validate_input(
            "communication_send",
            &json!({"provider":"unknown","integration_id":Uuid::nil()})
        )
        .is_err());
    }
    #[test]
    fn scheduling_payloads_reject_unknown_fields() {
        assert!(validate_input(
            "appointment_cancel",
            &json!({"appointment_id":Uuid::nil(),"expected_version":1,"extra":true})
        )
        .is_err());
    }
}
