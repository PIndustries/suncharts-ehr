// SPDX-License-Identifier: AGPL-3.0-only
//! Configurable, versioned care pathways. Definitions are tenant configuration;
//! instances and events are durable clinical operations with attributed history.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    model::text,
    postgres::audit,
    State,
};
use axum::{
    extract::{Path, RawQuery, State as ExtractState},
    http::{header, HeaderMap},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const TRIGGERS: [&str; 8] = [
    "inquiry_received",
    "referral_received",
    "appointment_created",
    "appointment_rescheduled",
    "eligibility_returned",
    "patient_checked_in",
    "visit_signed",
    "order_placed",
];
const KINDS: [&str; 10] = [
    "patient_form",
    "staff_task",
    "eligibility_query",
    "payment_request",
    "document_signature",
    "notification",
    "clinical_template",
    "order",
    "referral",
    "human_approval",
];
const PHASES: [&str; 4] = ["intake", "pre_visit", "visit", "follow_up"];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FormField {
    pub key: String,
    pub label: String,
    pub field_type: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    pub field: String,
    pub operator: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StepDefinition {
    pub key: String,
    pub title: String,
    pub kind: String,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub manual_approval: bool,
    #[serde(default)]
    pub assigned_role: Option<String>,
    #[serde(default)]
    pub escalation_role: Option<String>,
    #[serde(default)]
    pub due_after_minutes: Option<i64>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub condition: Option<Condition>,
    #[serde(default)]
    pub form_fields: Vec<FormField>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub steps: Vec<StepDefinition>,
}

impl Definition {
    fn validate(&self) -> Result<()> {
        if self.steps.is_empty() || self.steps.len() > 100 {
            return Err(Error::Invalid("a pathway requires 1 to 100 steps"));
        }
        let keys: BTreeSet<&str> = self.steps.iter().map(|s| s.key.as_str()).collect();
        if keys.len() != self.steps.len() {
            return Err(Error::Invalid("pathway step keys must be unique"));
        }
        for step in &self.steps {
            if !valid_key(&step.key) || !KINDS.contains(&step.kind.as_str()) {
                return Err(Error::Invalid("invalid pathway step key or kind"));
            }
            text(&step.title, 200)?;
            if step
                .phase
                .as_deref()
                .is_some_and(|phase| !PHASES.contains(&phase))
            {
                return Err(Error::Invalid("invalid pathway phase"));
            }
            if step.form_fields.len() > 30
                || (step.kind != "patient_form" && !step.form_fields.is_empty())
            {
                return Err(Error::Invalid("invalid pathway form fields"));
            }
            let mut form_keys = BTreeSet::new();
            for field in &step.form_fields {
                if !valid_key(&field.key)
                    || !form_keys.insert(field.key.as_str())
                    || ![
                        "short_text",
                        "long_text",
                        "date",
                        "choice",
                        "checkbox",
                        "number",
                    ]
                    .contains(&field.field_type.as_str())
                    || field.options.len() > 20
                    || (field.field_type != "choice" && !field.options.is_empty())
                {
                    return Err(Error::Invalid("invalid pathway form field"));
                }
                text(&field.label, 120)?;
                for option in &field.options {
                    text(option, 120)?;
                }
            }
            if step.depends_on.len() > 20
                || step.depends_on.iter().collect::<BTreeSet<_>>().len() != step.depends_on.len()
                || step
                    .depends_on
                    .iter()
                    .any(|key| key == &step.key || !keys.contains(key.as_str()))
            {
                return Err(Error::Invalid("invalid pathway step dependencies"));
            }
            for role in [&step.assigned_role, &step.escalation_role]
                .into_iter()
                .flatten()
            {
                if ![
                    "owner",
                    "clinician",
                    "nurse",
                    "medical_assistant",
                    "front_desk",
                ]
                .contains(&role.as_str())
                {
                    return Err(Error::Invalid("invalid pathway assigned role"));
                }
            }
            if step
                .due_after_minutes
                .is_some_and(|minutes| !(1..=525_600).contains(&minutes))
            {
                return Err(Error::Invalid("invalid pathway step due interval"));
            }
            if let Some(condition) = &step.condition {
                if !condition.field.starts_with('/')
                    || condition.field.len() > 200
                    || !["equals", "not_equals", "present", "absent"]
                        .contains(&condition.operator.as_str())
                {
                    return Err(Error::Invalid("invalid pathway condition"));
                }
            }
        }
        let dependencies: BTreeMap<&str, &Vec<String>> = self
            .steps
            .iter()
            .map(|step| (step.key.as_str(), &step.depends_on))
            .collect();
        for key in &keys {
            let mut visiting = BTreeSet::new();
            let mut visited = BTreeSet::new();
            visit_dependencies(key, &dependencies, &mut visiting, &mut visited)?;
        }
        Ok(())
    }
}

fn visit_dependencies<'a>(
    key: &'a str,
    dependencies: &BTreeMap<&'a str, &'a Vec<String>>,
    visiting: &mut BTreeSet<&'a str>,
    visited: &mut BTreeSet<&'a str>,
) -> Result<()> {
    if visited.contains(key) {
        return Ok(());
    }
    if !visiting.insert(key) {
        return Err(Error::Invalid("pathway dependencies must be acyclic"));
    }
    for dependency in dependencies.get(key).into_iter().flat_map(|values| *values) {
        visit_dependencies(dependency, dependencies, visiting, visited)?;
    }
    visiting.remove(key);
    visited.insert(key);
    Ok(())
}

fn valid_key(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && value.len() <= 63
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn condition_matches(condition: Option<&Condition>, context: &Value) -> bool {
    let Some(condition) = condition else {
        return true;
    };
    let found = context.pointer(&condition.field);
    match condition.operator.as_str() {
        "equals" => found == Some(&condition.value),
        "not_equals" => found != Some(&condition.value),
        "present" => found.is_some_and(|value| !value.is_null()),
        "absent" => found.is_none_or(Value::is_null),
        _ => false,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateDefinition {
    request_id: Uuid,
    slug: String,
    name: String,
    #[serde(default)]
    description: String,
    trigger_type: String,
    definition: Definition,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangeDefinition {
    name: String,
    #[serde(default)]
    description: String,
    trigger_type: String,
    definition: Definition,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DefinitionAction {
    action: String,
    reason: String,
    #[serde(default)]
    revision_version: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Trigger {
    request_id: Uuid,
    trigger_type: String,
    trigger_key: String,
    definition_id: Option<Uuid>,
    patient_id: Option<Uuid>,
    appointment_id: Option<Uuid>,
    visit_id: Option<Uuid>,
    #[serde(default)]
    context: Value,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StepAction {
    action: String,
    reason: String,
    #[serde(default)]
    evidence: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstanceAction {
    action: String,
    reason: String,
}

#[derive(sqlx::FromRow)]
struct ExistingInstance {
    id: Uuid,
    patient_id: Option<Uuid>,
    appointment_id: Option<Uuid>,
    visit_id: Option<Uuid>,
    trigger_type: String,
    context: Value,
}

pub fn routes() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/care-pathways/definitions",
            get(list_definitions).post(create_definition),
        )
        .route(
            "/api/v1/care-pathways/definitions/{id}",
            get(read_definition).put(update_definition),
        )
        .route(
            "/api/v1/care-pathways/definitions/{id}/actions",
            axum::routing::post(definition_action),
        )
        .route(
            "/api/v1/care-pathways/definitions/{id}/revisions",
            get(definition_revisions),
        )
        .route(
            "/api/v1/care-pathways/trigger",
            axum::routing::post(trigger),
        )
        .route("/api/v1/care-pathways/instances", get(list_instances))
        .route("/api/v1/care-pathways/instances/{id}", get(read_instance))
        .route(
            "/api/v1/care-pathways/instances/{id}/actions",
            axum::routing::post(instance_action),
        )
        .route(
            "/api/v1/care-pathways/instances/{id}/steps/{step}/actions",
            axum::routing::post(step_action),
        )
        .route(
            "/api/v1/care-pathways/instances/{id}/events",
            get(instance_events),
        )
}

fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}

fn definition_editor(actor: &Actor) -> Result<()> {
    if matches!(actor.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
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

fn expected(headers: &HeaderMap) -> Result<i64> {
    headers
        .get(header::IF_MATCH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim_matches('"').parse().ok())
        .ok_or(Error::VersionRequired)
}

fn definition_response(value: Value) -> Json<Value> {
    Json(value)
}

fn validate_definition_input(
    name: &str,
    description: &str,
    trigger_type: &str,
    definition: &Definition,
    reason: &str,
) -> Result<()> {
    text(name, 200)?;
    if description.chars().count() > 2000 || !TRIGGERS.contains(&trigger_type) {
        return Err(Error::Invalid(
            "invalid pathway name, description or trigger",
        ));
    }
    definition.validate()?;
    text(reason, 1000)
}

async fn definition_row(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
    lock: bool,
) -> Result<Value> {
    let query = format!(
        "SELECT to_jsonb(d)-'tenant_id'-'request_id'-'create_request' FROM care_pathway_definitions d WHERE tenant_id=$1 AND id=$2{}",
        if lock { " FOR UPDATE" } else { "" }
    );
    sqlx::query_scalar(&query)
        .bind(actor.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}

async fn save_definition_revision(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    row: &Value,
    reason: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO care_pathway_definition_revisions(tenant_id,definition_id,version,status,name,description,trigger_type,definition,author_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(actor.tenant_id)
        .bind(uuid_value(row, "id")?)
        .bind(i64_value(row, "version")?)
        .bind(string_value(row, "status")?)
        .bind(string_value(row, "name")?)
        .bind(string_value(row, "description")?)
        .bind(string_value(row, "trigger_type")?)
        .bind(&row["definition"])
        .bind(actor.sub)
        .bind(reason.trim())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn string_value<'a>(row: &'a Value, key: &str) -> Result<&'a str> {
    row[key]
        .as_str()
        .ok_or(Error::Conflict("saved pathway data is invalid"))
}

fn i64_value(row: &Value, key: &str) -> Result<i64> {
    row[key]
        .as_i64()
        .ok_or(Error::Conflict("saved pathway data is invalid"))
}

fn uuid_value(row: &Value, key: &str) -> Result<Uuid> {
    Uuid::parse_str(string_value(row, key)?)
        .map_err(|_| Error::Conflict("saved pathway data is invalid"))
}

async fn list_definitions(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
) -> Result<Json<Value>> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    let mut items: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(d)-'tenant_id'-'request_id'-'create_request' FROM care_pathway_definitions d WHERE tenant_id=$1 ORDER BY name,id LIMIT 201")
        .bind(actor.tenant_id)
        .fetch_all(&mut *tx)
        .await?;
    let truncated = items.len() > 200;
    items.truncate(200);
    audit(
        &mut tx,
        &actor,
        "practice.care_pathways.read",
        actor.tenant_id,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"truncated":truncated})))
}

async fn create_definition(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Json(input): Json<CreateDefinition>,
) -> Result<Json<Value>> {
    definition_editor(&actor)?;
    if !valid_key(&input.slug) {
        return Err(Error::Invalid("invalid pathway slug"));
    }
    validate_definition_input(
        &input.name,
        &input.description,
        &input.trigger_type,
        &input.definition,
        &input.reason,
    )?;
    let mut tx = db(&state)?.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "{}:care-pathway-definition:{}",
            actor.tenant_id, input.request_id
        ))
        .execute(&mut *tx)
        .await?;
    let request = json!({"slug":&input.slug,"name":&input.name,"description":&input.description,"trigger_type":&input.trigger_type,"definition":&input.definition,"reason":&input.reason});
    let prior: Option<(Uuid, Value)> = sqlx::query_as("SELECT id,create_request FROM care_pathway_definitions WHERE tenant_id=$1 AND request_id=$2")
        .bind(actor.tenant_id).bind(input.request_id).fetch_optional(&mut *tx).await?;
    if let Some((id, saved)) = prior {
        if saved != request {
            return Err(Error::Conflict(
                "pathway definition request identity was reused",
            ));
        }
        let row = definition_row(&mut tx, &actor, id, false).await?;
        audit(&mut tx, &actor, "practice.care_pathways.replay", id).await?;
        tx.commit().await?;
        return Ok(definition_response(row));
    }
    let id = Uuid::new_v4();
    let row: Value = sqlx::query_scalar("INSERT INTO care_pathway_definitions(tenant_id,id,slug,name,description,trigger_type,definition,request_id,create_request,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING to_jsonb(care_pathway_definitions)-'tenant_id'-'request_id'-'create_request'")
        .bind(actor.tenant_id)
        .bind(id)
        .bind(&input.slug)
        .bind(input.name.trim())
        .bind(input.description.trim())
        .bind(&input.trigger_type)
        .bind(json!(input.definition)).bind(input.request_id).bind(request).bind(actor.sub)
        .fetch_one(&mut *tx)
        .await?;
    save_definition_revision(&mut tx, &actor, &row, &input.reason).await?;
    audit(&mut tx, &actor, "practice.care_pathways.create", id).await?;
    tx.commit().await?;
    Ok(definition_response(row))
}

async fn read_definition(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    let row = definition_row(&mut tx, &actor, id, false).await?;
    audit(&mut tx, &actor, "practice.care_pathways.read", id).await?;
    tx.commit().await?;
    Ok(definition_response(row))
}

async fn update_definition(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<ChangeDefinition>,
) -> Result<Json<Value>> {
    definition_editor(&actor)?;
    validate_definition_input(
        &input.name,
        &input.description,
        &input.trigger_type,
        &input.definition,
        &input.reason,
    )?;
    let version = expected(&headers)?;
    let mut tx = db(&state)?.begin().await?;
    let previous = definition_row(&mut tx, &actor, id, true).await?;
    if i64_value(&previous, "version")? != version {
        return Err(Error::Conflict("pathway definition changed"));
    }
    if string_value(&previous, "status")? == "archived" {
        return Err(Error::Conflict(
            "archived pathway definitions cannot be changed",
        ));
    }
    let row: Value = sqlx::query_scalar("UPDATE care_pathway_definitions SET name=$3,description=$4,trigger_type=$5,definition=$6,version=version+1,status='draft',updated_by=$7,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING to_jsonb(care_pathway_definitions)-'tenant_id'")
        .bind(actor.tenant_id)
        .bind(id)
        .bind(input.name.trim())
        .bind(input.description.trim())
        .bind(&input.trigger_type)
        .bind(json!(input.definition))
        .bind(actor.sub)
        .fetch_one(&mut *tx)
        .await?;
    save_definition_revision(&mut tx, &actor, &row, &input.reason).await?;
    audit(&mut tx, &actor, "practice.care_pathways.update", id).await?;
    tx.commit().await?;
    Ok(definition_response(row))
}

async fn definition_action(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<DefinitionAction>,
) -> Result<Json<Value>> {
    definition_editor(&actor)?;
    text(&input.reason, 1000)?;
    let version = expected(&headers)?;
    let mut tx = db(&state)?.begin().await?;
    let previous = definition_row(&mut tx, &actor, id, true).await?;
    if i64_value(&previous, "version")? != version {
        return Err(Error::Conflict("pathway definition changed"));
    }
    if string_value(&previous, "status")? == "archived" && input.action != "rollback" {
        return Err(Error::Conflict(
            "archived pathway definitions cannot be changed",
        ));
    }
    let row: Value = if input.action == "rollback" {
        let revision_version = input
            .revision_version
            .filter(|candidate| *candidate > 0 && *candidate < version)
            .ok_or(Error::Invalid("invalid pathway revision"))?;
        let revision: (String, String, String, Value) = sqlx::query_as(
            "SELECT name,description,trigger_type,definition FROM care_pathway_definition_revisions
             WHERE tenant_id=$1 AND definition_id=$2 AND version=$3",
        )
        .bind(actor.tenant_id)
        .bind(id)
        .bind(revision_version)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
        sqlx::query_scalar("UPDATE care_pathway_definitions SET name=$3,description=$4,trigger_type=$5,definition=$6,status='draft',version=version+1,updated_by=$7,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING to_jsonb(care_pathway_definitions)-'tenant_id'")
            .bind(actor.tenant_id)
            .bind(id)
            .bind(revision.0)
            .bind(revision.1)
            .bind(revision.2)
            .bind(revision.3)
            .bind(actor.sub)
            .fetch_one(&mut *tx)
            .await?
    } else {
        let target = match input.action.as_str() {
            "activate" => "active",
            "archive" => "archived",
            _ => return Err(Error::Invalid("invalid pathway definition action")),
        };
        sqlx::query_scalar("UPDATE care_pathway_definitions SET status=$3,version=version+1,updated_by=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING to_jsonb(care_pathway_definitions)-'tenant_id'")
            .bind(actor.tenant_id)
            .bind(id)
            .bind(target)
            .bind(actor.sub)
            .fetch_one(&mut *tx)
            .await?
    };
    save_definition_revision(&mut tx, &actor, &row, &input.reason).await?;
    audit(&mut tx, &actor, "practice.care_pathways.action", id).await?;
    tx.commit().await?;
    Ok(definition_response(row))
}

async fn definition_revisions(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    definition_row(&mut tx, &actor, id, false).await?;
    let mut items: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id' FROM care_pathway_definition_revisions r WHERE tenant_id=$1 AND definition_id=$2 ORDER BY version DESC LIMIT 101")
        .bind(actor.tenant_id)
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    let truncated = items.len() > 100;
    items.truncate(100);
    audit(&mut tx, &actor, "practice.care_pathways.history.read", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"truncated":truncated})))
}

async fn validate_context(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    patient: Option<Uuid>,
    appointment: Option<Uuid>,
    visit: Option<Uuid>,
) -> Result<()> {
    if let Some(patient) = patient {
        let found: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)",
        )
        .bind(actor.tenant_id)
        .bind(patient)
        .fetch_one(&mut **tx)
        .await?;
        if !found {
            return Err(Error::NotFound);
        }
    }
    if let Some(appointment) = appointment {
        let found: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM appointments WHERE tenant_id=$1 AND id=$2 AND ($3::uuid IS NULL OR patient_id=$3))")
            .bind(actor.tenant_id).bind(appointment).bind(patient).fetch_one(&mut **tx).await?;
        if !found {
            return Err(Error::NotFound);
        }
    }
    if let Some(visit) = visit {
        let found: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM visits WHERE tenant_id=$1 AND id=$2 AND ($3::uuid IS NULL OR patient_id=$3))")
            .bind(actor.tenant_id).bind(visit).bind(patient).fetch_one(&mut **tx).await?;
        if !found {
            return Err(Error::NotFound);
        }
    }
    Ok(())
}

async fn trigger(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Json(input): Json<Trigger>,
) -> Result<Json<Value>> {
    actor.staff()?;
    if !TRIGGERS.contains(&input.trigger_type.as_str())
        || input.trigger_key.trim().is_empty()
        || input.trigger_key.chars().count() > 300
        || !input.context.is_object()
    {
        return Err(Error::Invalid("invalid care pathway trigger"));
    }
    text(&input.reason, 1000)?;
    let mut tx = db(&state)?.begin().await?;
    validate_context(
        &mut tx,
        &actor,
        input.patient_id,
        input.appointment_id,
        input.visit_id,
    )
    .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "{}:care-pathway-trigger:{}",
            actor.tenant_id, input.request_id
        ))
        .execute(&mut *tx)
        .await?;
    let definitions: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(d)-'tenant_id'-'request_id'-'create_request' FROM care_pathway_definitions d WHERE tenant_id=$1 AND status='active' AND trigger_type=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY id")
        .bind(actor.tenant_id).bind(&input.trigger_type).bind(input.definition_id)
        .fetch_all(&mut *tx).await?;
    if input.definition_id.is_some() && definitions.is_empty() {
        return Err(Error::NotFound);
    }
    let mut instances = Vec::new();
    for definition_row in definitions {
        let definition: Definition =
            serde_json::from_value(definition_row["definition"].clone())
                .map_err(|_| Error::Conflict("saved pathway definition is invalid"))?;
        definition.validate()?;
        let definition_id = uuid_value(&definition_row, "id")?;
        let definition_version = i64_value(&definition_row, "version")?;
        let existing: Option<ExistingInstance> = sqlx::query_as("SELECT id,patient_id,appointment_id,visit_id,trigger_type,context FROM care_pathway_instances WHERE tenant_id=$1 AND definition_id=$2 AND definition_version=$3 AND trigger_key=$4")
            .bind(actor.tenant_id).bind(definition_id).bind(definition_version).bind(input.trigger_key.trim())
            .fetch_optional(&mut *tx).await?;
        let instance_id = if let Some(existing) = existing {
            if existing.patient_id != input.patient_id
                || existing.appointment_id != input.appointment_id
                || existing.visit_id != input.visit_id
                || existing.trigger_type != input.trigger_type
                || existing.context != input.context
            {
                return Err(Error::Conflict(
                    "pathway trigger identity was reused with different context",
                ));
            }
            existing.id
        } else {
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO care_pathway_instances(tenant_id,id,definition_id,definition_version,patient_id,appointment_id,visit_id,trigger_type,trigger_key,context,started_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
                .bind(actor.tenant_id).bind(id).bind(definition_id).bind(definition_version)
                .bind(input.patient_id).bind(input.appointment_id).bind(input.visit_id)
                .bind(&input.trigger_type).bind(input.trigger_key.trim()).bind(&input.context).bind(actor.sub)
                .execute(&mut *tx).await?;
            for (position, step) in definition.steps.iter().enumerate() {
                let matches = condition_matches(step.condition.as_ref(), &input.context);
                let state = if !matches {
                    "skipped"
                } else if step.depends_on.is_empty() {
                    "ready"
                } else {
                    "blocked"
                };
                sqlx::query("INSERT INTO care_pathway_steps(tenant_id,instance_id,step_key,position,title,kind,required,manual_approval,state,assigned_role,escalation_role,due_at,evidence,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $12::bigint IS NULL THEN NULL ELSE now()+make_interval(mins=>$12::int) END,$13,$14)")
                    .bind(actor.tenant_id).bind(id).bind(&step.key).bind(position as i32).bind(&step.title).bind(&step.kind)
                    .bind(step.required).bind(step.manual_approval).bind(state).bind(&step.assigned_role).bind(&step.escalation_role).bind(step.due_after_minutes)
                    .bind(if matches { json!({}) } else { json!({"condition": "not_matched"}) }).bind(actor.sub)
                    .execute(&mut *tx).await?;
                if !matches {
                    insert_event(
                        &mut tx,
                        &actor,
                        id,
                        Some(&step.key),
                        "step.condition_skipped",
                        &input.reason,
                        json!({}),
                    )
                    .await?;
                }
            }
            insert_event(
                &mut tx,
                &actor,
                id,
                None,
                "pathway.started",
                &input.reason,
                json!({"request_id":input.request_id}),
            )
            .await?;
            refresh_ready_steps(&mut tx, &actor, id).await?;
            id
        };
        instances.push(instance_snapshot(&mut tx, &actor, instance_id).await?);
    }
    audit(
        &mut tx,
        &actor,
        "practice.care_pathways.trigger",
        actor.tenant_id,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"items":instances})))
}

async fn insert_event(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    instance: Uuid,
    step: Option<&str>,
    event: &str,
    reason: &str,
    evidence: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO care_pathway_events(tenant_id,instance_id,step_key,event_type,actor_id,reason,evidence) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(actor.tenant_id).bind(instance).bind(step).bind(event).bind(actor.sub).bind(reason.trim()).bind(evidence)
        .execute(&mut **tx).await?;
    Ok(())
}

async fn instance_snapshot(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
) -> Result<Value> {
    let mut value: Value = sqlx::query_scalar("SELECT (to_jsonb(i)-'tenant_id') || jsonb_build_object('definition_name',d.name,'definition_slug',d.slug) FROM care_pathway_instances i JOIN care_pathway_definitions d ON d.tenant_id=i.tenant_id AND d.id=i.definition_id WHERE i.tenant_id=$1 AND i.id=$2")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
    let steps: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(s)-'tenant_id'-'instance_id' FROM care_pathway_steps s WHERE tenant_id=$1 AND instance_id=$2 ORDER BY position,step_key")
        .bind(actor.tenant_id).bind(id).fetch_all(&mut **tx).await?;
    value["steps"] = json!(steps);
    Ok(value)
}

fn query_params(raw: Option<&str>) -> Result<(Option<Uuid>, Option<String>)> {
    let values: BTreeMap<String, String> =
        url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes())
            .into_owned()
            .collect();
    let patient = values
        .get("patient_id")
        .map(|value| Uuid::parse_str(value))
        .transpose()
        .map_err(|_| Error::Invalid("invalid patient filter"))?;
    let status = values.get("status").cloned();
    if status
        .as_deref()
        .is_some_and(|value| !["active", "completed", "cancelled"].contains(&value))
    {
        return Err(Error::Invalid("invalid pathway status filter"));
    }
    Ok((patient, status))
}

async fn list_instances(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>> {
    actor.staff()?;
    let (patient, status) = query_params(raw.as_deref())?;
    let mut tx = db(&state)?.begin().await?;
    let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM care_pathway_instances WHERE tenant_id=$1 AND ($2::uuid IS NULL OR patient_id=$2) AND ($3::text IS NULL OR status=$3) ORDER BY updated_at DESC,id LIMIT 101")
        .bind(actor.tenant_id).bind(patient).bind(status).fetch_all(&mut *tx).await?;
    let mut items = Vec::new();
    for id in ids.iter().take(100) {
        items.push(instance_snapshot(&mut tx, &actor, *id).await?);
    }
    audit(
        &mut tx,
        &actor,
        "practice.care_pathways.instances.read",
        actor.tenant_id,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"truncated":ids.len()>100})))
}

async fn read_instance(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    let value = instance_snapshot(&mut tx, &actor, id).await?;
    audit(&mut tx, &actor, "practice.care_pathways.instance.read", id).await?;
    tx.commit().await?;
    Ok(Json(value))
}

async fn instance_action(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<InstanceAction>,
) -> Result<Json<Value>> {
    actor.clinical()?;
    text(&input.reason, 1000)?;
    let expected = expected(&headers)?;
    let mut tx = db(&state)?.begin().await?;
    let current: (i64, String) = sqlx::query_as(
        "SELECT version,status FROM care_pathway_instances WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(actor.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    if current.0 != expected {
        return Err(Error::Conflict("pathway instance changed"));
    }
    let (status, event) = match (input.action.as_str(), current.1.as_str()) {
        ("cancel", "active") | ("cancel", "completed") => ("cancelled", "pathway.cancelled"),
        ("resume", "cancelled") if matches!(actor.role, Role::Owner) => {
            ("active", "pathway.resumed")
        }
        _ => return Err(Error::Conflict("invalid pathway instance transition")),
    };
    sqlx::query("UPDATE care_pathway_instances SET status=$3,version=version+1,completed_at=CASE WHEN $3='active' THEN NULL ELSE completed_at END,updated_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).bind(status).execute(&mut *tx).await?;
    insert_event(&mut tx, &actor, id, None, event, &input.reason, json!({})).await?;
    audit(
        &mut tx,
        &actor,
        "practice.care_pathways.instance.action",
        id,
    )
    .await?;
    let value = instance_snapshot(&mut tx, &actor, id).await?;
    tx.commit().await?;
    Ok(Json(value))
}

async fn refresh_ready_steps(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
) -> Result<()> {
    let definition:Value=sqlx::query_scalar("SELECT d.definition FROM care_pathway_instances i JOIN care_pathway_definition_revisions d ON d.tenant_id=i.tenant_id AND d.definition_id=i.definition_id AND d.version=i.definition_version WHERE i.tenant_id=$1 AND i.id=$2")
        .bind(actor.tenant_id).bind(id).fetch_one(&mut **tx).await?;
    let definition: Definition = serde_json::from_value(definition)
        .map_err(|_| Error::Conflict("saved pathway definition is invalid"))?;
    for step in definition.steps {
        let state:Option<String>=sqlx::query_scalar("SELECT state FROM care_pathway_steps WHERE tenant_id=$1 AND instance_id=$2 AND step_key=$3")
            .bind(actor.tenant_id).bind(id).bind(&step.key).fetch_optional(&mut **tx).await?;
        if state.as_deref() != Some("blocked") {
            continue;
        }
        let ready:bool=sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM care_pathway_steps WHERE tenant_id=$1 AND instance_id=$2 AND step_key=ANY($3) AND state NOT IN('completed','skipped'))")
            .bind(actor.tenant_id).bind(id).bind(&step.depends_on).fetch_one(&mut **tx).await?;
        if ready {
            sqlx::query("UPDATE care_pathway_steps SET state='ready',version=version+1,updated_by=$4,updated_at=now() WHERE tenant_id=$1 AND instance_id=$2 AND step_key=$3")
            .bind(actor.tenant_id).bind(id).bind(&step.key).bind(actor.sub).execute(&mut **tx).await?;
        }
    }
    let done:bool=sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM care_pathway_steps WHERE tenant_id=$1 AND instance_id=$2 AND state NOT IN('completed','skipped'))")
        .bind(actor.tenant_id).bind(id).fetch_one(&mut **tx).await?;
    if done {
        sqlx::query("UPDATE care_pathway_instances SET status='completed',version=version+1,completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='active'")
        .bind(actor.tenant_id).bind(id).execute(&mut **tx).await?;
    }
    Ok(())
}

async fn step_action(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path((id, step)): Path<(Uuid, String)>,
    headers: HeaderMap,
    Json(input): Json<StepAction>,
) -> Result<Json<Value>> {
    actor.staff()?;
    text(&input.reason, 1000)?;
    if !input.evidence.is_object() {
        return Err(Error::Invalid("pathway step evidence must be an object"));
    }
    let version = expected(&headers)?;
    let mut tx = db(&state)?.begin().await?;
    let instance = instance_snapshot(&mut tx, &actor, id).await?;
    if instance["status"] == "cancelled"
        || (instance["status"] == "completed" && input.action != "reopen")
    {
        return Err(Error::Conflict("pathway instance is not active"));
    }
    let row:Value=sqlx::query_scalar("SELECT to_jsonb(s)-'tenant_id'-'instance_id' FROM care_pathway_steps s WHERE tenant_id=$1 AND instance_id=$2 AND step_key=$3 FOR UPDATE")
        .bind(actor.tenant_id).bind(id).bind(&step).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    if i64_value(&row, "version")? != version {
        return Err(Error::Conflict("pathway step changed"));
    }
    let current = string_value(&row, "state")?;
    let manual = row["manual_approval"].as_bool().unwrap_or(false);
    if ["start", "complete", "skip"].contains(&input.action.as_str())
        && !matches!(actor.role, Role::Owner)
        && row["assigned_role"]
            .as_str()
            .is_some_and(|assigned| assigned != role_key(&actor.role))
    {
        return Err(Error::Forbidden);
    }
    let (next, event) = match input.action.as_str() {
        "start" if current == "ready" => ("in_progress", "step.started"),
        "complete" if ["ready", "in_progress"].contains(&current) && manual => {
            ("awaiting_approval", "step.submitted")
        }
        "complete" if ["ready", "in_progress"].contains(&current) => {
            ("completed", "step.completed")
        }
        "approve"
            if current == "awaiting_approval"
                && matches!(actor.role, Role::Owner | Role::Clinician) =>
        {
            ("completed", "step.approved")
        }
        "skip"
            if ["ready", "in_progress", "blocked"].contains(&current)
                && !row["required"].as_bool().unwrap_or(true) =>
        {
            ("skipped", "step.skipped")
        }
        "reopen"
            if ["completed", "skipped"].contains(&current)
                && matches!(actor.role, Role::Owner | Role::Clinician) =>
        {
            ("ready", "step.reopened")
        }
        _ => return Err(Error::Conflict("invalid pathway step transition")),
    };
    sqlx::query("UPDATE care_pathway_steps SET state=$4,version=version+1,evidence=$5,updated_by=$6,updated_at=now() WHERE tenant_id=$1 AND instance_id=$2 AND step_key=$3")
        .bind(actor.tenant_id).bind(id).bind(&step).bind(next).bind(&input.evidence).bind(actor.sub).execute(&mut *tx).await?;
    if input.action == "reopen" {
        sqlx::query("UPDATE care_pathway_instances SET status='active',version=version+1,completed_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2")
            .bind(actor.tenant_id).bind(id).execute(&mut *tx).await?;
    }
    insert_event(
        &mut tx,
        &actor,
        id,
        Some(&step),
        event,
        &input.reason,
        input.evidence,
    )
    .await?;
    refresh_ready_steps(&mut tx, &actor, id).await?;
    audit(&mut tx, &actor, "practice.care_pathways.step.action", id).await?;
    let value = instance_snapshot(&mut tx, &actor, id).await?;
    tx.commit().await?;
    Ok(Json(value))
}

async fn instance_events(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    instance_snapshot(&mut tx, &actor, id).await?;
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id'-'instance_id' FROM care_pathway_events e WHERE tenant_id=$1 AND instance_id=$2 ORDER BY sequence DESC LIMIT 501")
        .bind(actor.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let truncated = items.len() > 500;
    items.truncate(500);
    audit(&mut tx, &actor, "practice.care_pathways.events.read", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"truncated":truncated})))
}

/// A specialty template supplied as data. Installers choose whether to create it;
/// the runtime never branches on this slug or its step keys.
pub fn spasticity_movement_template() -> Value {
    json!({
        "slug":"spasticity-movement-previsit",
        "name":"Spasticity & movement pre-visit",
        "description":"Collect intake, verify benefits, prepare payment and route the specialty visit.",
        "trigger_type":"appointment_created",
        "definition":{"steps":[
            {"key":"intake-packet","title":"Complete intake packet","kind":"patient_form","required":true,"manual_approval":false,"due_after_minutes":4320,"escalation_role":"front_desk","depends_on":[]},
            {"key":"insurance-eligibility","title":"Verify insurance eligibility","kind":"eligibility_query","required":true,"manual_approval":true,"assigned_role":"front_desk","due_after_minutes":1440,"escalation_role":"owner","depends_on":[]},
            {"key":"patient-estimate","title":"Review patient responsibility","kind":"payment_request","required":false,"manual_approval":true,"assigned_role":"front_desk","due_after_minutes":2880,"escalation_role":"owner","depends_on":["insurance-eligibility"],"condition":{"field":"/insurance/present","operator":"equals","value":true}},
            {"key":"legal-consents","title":"Sign required legal documents","kind":"document_signature","required":true,"manual_approval":false,"due_after_minutes":4320,"escalation_role":"front_desk","depends_on":[]},
            {"key":"functional-status","title":"Record functional status","kind":"clinical_template","required":true,"manual_approval":true,"assigned_role":"nurse","due_after_minutes":10080,"escalation_role":"clinician","depends_on":["intake-packet"]},
            {"key":"visit-pathway","title":"Select specialty visit pathway","kind":"human_approval","required":true,"manual_approval":true,"assigned_role":"clinician","due_after_minutes":10080,"escalation_role":"owner","depends_on":["functional-status","legal-consents"]}
        ]}
    })
}
