// SPDX-License-Identifier: AGPL-3.0-only
//! Allowlisted local read tools. No model selects SQL or supplies tenant scope.
//! Results are aggregate observations, not chart data or authority to act.
use crate::{
    auth::{Actor, Role},
    care_pathways::Definition,
    error::{Error, Result},
    postgres::audit,
    State,
};
use axum::{
    extract::{Query, State as ExtractState},
    http::{header, HeaderMap, Method},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Copy)]
enum LocalTool {
    PatientCount,
    TodayAppointments,
    WorkflowCounts,
}
struct ToolDefinition {
    id: &'static str,
    fact: &'static str,
    required_scope: &'static str,
    tool: LocalTool,
}
const TOOLS: &[ToolDefinition] = &[
    ToolDefinition {
        id: "patients.count",
        fact: "patients",
        required_scope: "clinical.read",
        tool: LocalTool::PatientCount,
    },
    ToolDefinition {
        id: "appointments.today.count",
        fact: "appointments",
        required_scope: "scheduling.read",
        tool: LocalTool::TodayAppointments,
    },
    ToolDefinition {
        id: "workflows.count",
        fact: "workflows",
        required_scope: "clinical.read",
        tool: LocalTool::WorkflowCounts,
    },
];
impl LocalTool {
    fn permitted(self, actor: &Actor) -> bool {
        // These match patients(), scheduling::schedule() and
        // care_pathways::list_instances(), all native staff read operations.
        actor.staff().is_ok()
    }
    async fn read(
        self,
        tx: &mut Transaction<'_, Postgres>,
        actor: &Actor,
        date: NaiveDate,
        timezone: &str,
    ) -> Result<Value> {
        match self {
            Self::PatientCount => {
                let total: i64 =
                    sqlx::query_scalar("SELECT count(*) FROM patients WHERE tenant_id=$1")
                        .bind(actor.tenant_id)
                        .fetch_one(&mut **tx)
                        .await?;
                Ok(
                    json!({"total":total,"scope":"all_local_patient_records","definition":"All patient records stored in this practice, including registered and imported records. This is not an active-patient or unique-person count; legacy source status flags do not exclude a record."}),
                )
            }
            Self::TodayAppointments => {
                let mut value:Value=sqlx::query_scalar("SELECT jsonb_build_object('total',count(*),'by_status',jsonb_build_object('booked',count(*) FILTER(WHERE status='booked'),'checked_in',count(*) FILTER(WHERE status='checked_in'),'in_progress',count(*) FILTER(WHERE status='in_progress'),'completed',count(*) FILTER(WHERE status='completed'),'cancelled',count(*) FILTER(WHERE status='cancelled'),'no_show',count(*) FILTER(WHERE status='no_show'),'other',count(*) FILTER(WHERE status NOT IN ('booked','checked_in','in_progress','completed','cancelled','no_show')))) FROM appointments WHERE tenant_id=$1 AND starts_at>=($2::date::timestamp AT TIME ZONE $3) AND starts_at<(($2::date+1)::timestamp AT TIME ZONE $3)")
                    .bind(actor.tenant_id).bind(date).bind(timezone).fetch_one(&mut **tx).await?;
                value["date"] = json!(date);
                value["scope"] = json!("appointments_starting_on_local_date");
                value["definition"]=json!("Native appointments whose start falls on this practice-local date. Total includes completed, cancelled and no-show appointments, including imported records converted into native appointments; historical-only records and schedule blocks are excluded.");
                Ok(value)
            }
            Self::WorkflowCounts => {
                let mut value:Value=sqlx::query_scalar("SELECT jsonb_build_object('total',count(*),'by_status',jsonb_build_object('active',count(*) FILTER(WHERE status='active'),'completed',count(*) FILTER(WHERE status='completed'),'cancelled',count(*) FILTER(WHERE status='cancelled'),'other',count(*) FILTER(WHERE status NOT IN ('active','completed','cancelled')))) FROM care_pathway_instances WHERE tenant_id=$1")
                    .bind(actor.tenant_id).fetch_one(&mut **tx).await?;
                let (ready,approval):(i64,i64)=sqlx::query_as("SELECT count(*) FILTER(WHERE s.state='ready'),count(*) FILTER(WHERE s.state='awaiting_approval') FROM care_pathway_steps s JOIN care_pathway_instances i ON i.tenant_id=s.tenant_id AND i.id=s.instance_id WHERE s.tenant_id=$1 AND i.status='active'")
                    .bind(actor.tenant_id).fetch_one(&mut **tx).await?;
                value["ready_steps"] = json!(ready);
                value["awaiting_approval_steps"] = json!(approval);
                value["scope"] = json!("all_local_workflow_instances");
                value["definition"]=json!("All saved workflow runs in this practice, including completed and cancelled runs. Ready and awaiting-approval step counts include active runs only; they are steps, not unique patients or runs.");
                Ok(value)
            }
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextQuery {}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/sun/context", get(context))
        .route(
            "/api/v1/sun/workflow-proposals/validate",
            post(validate_workflow_proposal),
        )
}

pub(crate) fn workflow_designer(actor: &Actor) -> Result<()> {
    // Same definition authoring authority as Workflow Studio. Delegated workflow
    // managers receive an Owner actor; read-only partner support stays read-only.
    if matches!(actor.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WorkflowProposal {
    name: String,
    description: String,
    trigger_type: String,
    definition: Definition,
}
impl WorkflowProposal {
    fn parse(content: &str) -> Result<Self> {
        if content.len() > 131_072 {
            return Err(Error::Invalid("workflow proposal exceeds its limit"));
        }
        let proposal: Self = serde_json::from_str(content)
            .map_err(|_| Error::Invalid("workflow proposal must contain only the supported name, description, trigger_type and definition fields"))?;
        crate::care_pathways::validate_definition_input(
            &proposal.name,
            &proposal.description,
            &proposal.trigger_type,
            &proposal.definition,
            "Validate reviewed Sun workflow proposal",
        )?;
        for step in &proposal.definition.steps {
            if !matches!(step.kind.as_str(), "staff_task" | "patient_form") && !step.manual_approval
            {
                return Err(Error::Invalid("Sun proposals require manual approval on clinical, external-action and AI nodes"));
            }
        }
        Ok(proposal)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidateWorkflowProposal {
    draft_id: Uuid,
}

async fn validate_workflow_proposal(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Json(input): Json<ValidateWorkflowProposal>,
) -> Result<Response> {
    workflow_designer(&actor)?;
    let pool = &state.browser.as_ref().ok_or(Error::NotFound)?.db;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let row:Option<(String,String,Option<String>,bool)>=sqlx::query_as(
        "SELECT d.purpose,d.status,d.content,EXISTS(SELECT 1 FROM ai_privacy_approvals a WHERE a.tenant_id=d.tenant_id AND a.preview_id=d.privacy_preview_id AND a.draft_id=d.id) FROM claude_drafts d WHERE d.tenant_id=$1 AND d.id=$2 FOR SHARE")
        .bind(actor.tenant_id).bind(input.draft_id).fetch_optional(&mut *tx).await?;
    let (purpose, status, content, privacy_approved) = row.ok_or(Error::NotFound)?;
    if purpose != "workflow_design"
        || !matches!(status.as_str(), "draft" | "approved")
        || !privacy_approved
    {
        return Err(Error::Conflict(
            "a completed, privacy-approved workflow design draft is required",
        ));
    }
    let proposal = WorkflowProposal::parse(
        content
            .as_deref()
            .ok_or(Error::Conflict("workflow proposal content is unavailable"))?,
    )?;
    let mut warnings=vec![
        "Only a local unsaved Studio draft may be updated after you review and approve these changes. Nothing has been saved, published or executed.",
        "Integration action mappings and live context fields are not created or verified by this proposal. Review configuration before separately saving and publishing.",
    ];
    for step in &proposal.definition.steps {
        if matches!(step.kind.as_str(), "ai_extract_draft" | "ai_response_draft") {
            if let Some(ai)=&step.ai {
                let capability=if step.kind=="ai_extract_draft" {"structured_extraction"} else {"draft_response"};
                let available:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM instance_integrations WHERE tenant_id=$1 AND id=$2 AND provider IN ('claude','erebine') AND enabled AND status<>'revoked' AND credential_revision>0 AND capabilities ? $3)")
                    .bind(actor.tenant_id).bind(ai.integration_id).bind(capability).fetch_one(&mut *tx).await?;
                if !available { return Err(Error::Conflict("workflow proposal references an unavailable or unauthorized AI connection")); }
            } else if !warnings.contains(&"One or more Sun nodes have no AI configuration. Choose a permitted connection and explicit source field before using them.") {
                warnings.push("One or more Sun nodes have no AI configuration. Choose a permitted connection and explicit source field before using them.");
            }
        }
    }
    audit(
        &mut tx,
        &actor,
        "sun.workflow_proposal.validated",
        input.draft_id,
    )
    .await?;
    tx.commit().await?;
    Ok(([(header::CACHE_CONTROL,"no-store")],Json(json!({"valid":true,"draft_id":input.draft_id,"proposal":proposal,"warnings":warnings,"application":"unsaved_studio_draft_only"}))).into_response())
}
async fn context(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    headers: HeaderMap,
    Query(_): Query<ContextQuery>,
) -> Result<Response> {
    actor.staff()?;
    let pool = &state.browser.as_ref().ok_or(Error::NotFound)?.db;
    // Actor extraction already enforces clinical.read for this route. Preserve
    // the separate scheduling scope when an OAuth client uses multiple tools.
    let oauth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.starts_with("sce_at_"));
    let mut unavailable = Vec::new();
    let mut allowed = Vec::new();
    for definition in TOOLS {
        if !definition.tool.permitted(&actor) {
            unavailable.push(json!({"tool":definition.id,"reason":"Your role cannot read this native resource."}));
            continue;
        }
        if definition.required_scope == "scheduling.read" {
            if let Some(token) = oauth {
                match crate::oauth::authenticate(&state, token, &Method::GET, "/api/v1/scheduling")
                    .await
                {
                    Ok(verified)
                        if verified.tenant_id == actor.tenant_id && verified.sub == actor.sub => {}
                    Ok(_) => return Err(Error::Unauthorized),
                    Err(Error::Forbidden) => {
                        unavailable.push(json!({"tool":definition.id,"reason":"This connection requires scheduling.read permission for appointment counts."}));
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        allowed.push(definition);
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let observed_at: DateTime<Utc> = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let saved_timezone: Option<String> = sqlx::query_scalar(
        "SELECT booking_timezone FROM previsit_booking_profiles WHERE tenant_id=$1",
    )
    .bind(actor.tenant_id)
    .fetch_optional(&mut *tx)
    .await?;
    let timezone_source = if saved_timezone.is_some() {
        "practice_booking_settings"
    } else {
        "UTC_default"
    };
    let timezone = saved_timezone.unwrap_or_else(|| "UTC".into());
    let date: NaiveDate = sqlx::query_scalar("SELECT ($1::timestamptz AT TIME ZONE $2)::date")
        .bind(observed_at)
        .bind(&timezone)
        .fetch_one(&mut *tx)
        .await?;
    let mut facts = Map::new();
    let mut capabilities = Vec::new();
    for definition in allowed {
        facts.insert(
            definition.fact.into(),
            definition
                .tool
                .read(&mut tx, &actor, date, &timezone)
                .await?,
        );
        capabilities.push(definition.id);
    }
    audit(&mut tx, &actor, "sun.context.read", actor.tenant_id).await?;
    tx.commit().await?;
    Ok(([(header::CACHE_CONTROL,"no-store")],Json(json!({"observed_at":observed_at,"practice_timezone":timezone,"timezone_source":timezone_source,"source":"native_local_database","facts":facts,"capabilities":capabilities,"unavailable":unavailable}))).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Role;
    use uuid::Uuid;
    #[test]
    fn catalog_is_fixed_and_matches_native_staff_read_roles() {
        let mut actor = Actor {
            sub: Uuid::new_v4(),
            tenant_id: Uuid::new_v4(),
            role: Role::Patient,
            patient_id: Some(Uuid::new_v4()),
            iss: "test".into(),
            aud: "test".into(),
            iat: 0,
            exp: 120,
        };
        assert!(TOOLS.iter().all(|v| !v.tool.permitted(&actor)));
        for role in [
            Role::Owner,
            Role::Clinician,
            Role::Nurse,
            Role::MedicalAssistant,
            Role::FrontDesk,
            Role::ReadOnly,
            Role::PartnerSupport,
        ] {
            actor.role = role;
            assert!(TOOLS.iter().all(|v| v.tool.permitted(&actor)));
        }
        assert_eq!(
            TOOLS.iter().map(|v| v.id).collect::<Vec<_>>(),
            vec![
                "patients.count",
                "appointments.today.count",
                "workflows.count"
            ]
        );
    }
    fn proposal() -> Value {
        json!({"name":"Synthetic intake","description":"Review an intake form","trigger_type":"appointment_created","definition":{"columns":[{"key":"intake","title":"Intake","description":"","hidden":false}],"steps":[{"key":"intake-form","title":"Review preferences","kind":"patient_form","phase":"intake","form_fields":[{"key":"preference","label":"Contact preference","field_type":"choice","required":true,"options":["Portal","Phone"]}]}]}})
    }
    #[test]
    fn proposals_use_native_schema_and_preserve_review_boundary() {
        let original = proposal();
        assert!(WorkflowProposal::parse(&original.to_string()).is_ok());
        for property in ["mapping", "script", "credential", "provider_url"] {
            let mut invalid = original.clone();
            invalid["definition"]["steps"][0][property] = json!("unsupported");
            assert!(WorkflowProposal::parse(&invalid.to_string()).is_err());
        }
        let mut invalid = original.clone();
        invalid["trigger_type"] = json!("arbitrary_event");
        assert!(WorkflowProposal::parse(&invalid.to_string()).is_err());
        invalid = original.clone();
        invalid["definition"]["steps"][0]["depends_on"] = json!(["missing"]);
        assert!(WorkflowProposal::parse(&invalid.to_string()).is_err());
        invalid = original.clone();
        invalid["definition"]["steps"][0]["form_fields"][0]["field_type"] = json!("execute");
        assert!(WorkflowProposal::parse(&invalid.to_string()).is_err());
        invalid = original.clone();
        invalid["definition"]["steps"][0]["form_fields"] = json!([]);
        for kind in [
            "ai_response_draft",
            "ai_extract_draft",
            "payment_request",
            "order",
            "communication_send",
            "clinical_template",
        ] {
            invalid["definition"]["steps"][0]["kind"] = json!(kind);
            invalid["definition"]["steps"][0]["manual_approval"] = json!(false);
            assert!(WorkflowProposal::parse(&invalid.to_string()).is_err());
            invalid["definition"]["steps"][0]["manual_approval"] = json!(true);
            assert!(WorkflowProposal::parse(&invalid.to_string()).is_ok());
        }
    }
    #[test]
    fn workflow_design_roles_match_saved_definition_authority() {
        let mut actor = Actor {
            sub: Uuid::new_v4(),
            tenant_id: Uuid::new_v4(),
            role: Role::Owner,
            patient_id: None,
            iss: "test".into(),
            aud: "test".into(),
            iat: 0,
            exp: 120,
        };
        assert!(workflow_designer(&actor).is_ok());
        for role in [
            Role::Clinician,
            Role::Nurse,
            Role::MedicalAssistant,
            Role::FrontDesk,
            Role::ReadOnly,
            Role::PartnerSupport,
            Role::Patient,
        ] {
            actor.role = role;
            assert!(matches!(workflow_designer(&actor), Err(Error::Forbidden)));
        }
    }
}
