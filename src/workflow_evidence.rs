// SPDX-License-Identifier: AGPL-3.0-only
//! Native record proofs for pathway completion; caller statements are never proofs.
use crate::{
    auth::Actor,
    care_pathways::{Definition, StepDefinition},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::{header, HeaderMap, Method},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeBinding {
    pub resource: String,
}

pub const RESOURCES: &[&str] = &[
    "appointment_booked",
    "check_in",
    "signed_visit",
    "functional_status",
    "neurotoxin",
    "baclofen_pump_refill",
    "stretching_program",
    "care_coordination",
    "eligibility",
    "payment",
    "order",
    "referral",
    "intake_reviewed",
    "follow_up",
    "claim_review",
    "claim_submitted",
    "claim_accepted",
];

pub fn validate_binding(kind: &str, binding: &NativeBinding) -> Result<()> {
    let resource = binding.resource.as_str();
    let allowed = match kind {
        "staff_task" | "human_approval" => RESOURCES.contains(&resource),
        "clinical_template" => matches!(
            resource,
            "signed_visit"
                | "functional_status"
                | "neurotoxin"
                | "baclofen_pump_refill"
                | "stretching_program"
                | "care_coordination"
        ),
        "order" => matches!(
            resource,
            "order"
                | "neurotoxin"
                | "baclofen_pump_refill"
                | "stretching_program"
                | "care_coordination"
        ),
        "eligibility_query" => resource == "eligibility",
        "payment_request" => resource == "payment",
        "referral" => resource == "referral",
        "patient_form" | "intake_request" => resource == "intake_reviewed",
        "appointment_booking" => resource == "appointment_booked",
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(Error::Invalid(
            "native resource is not supported for this workflow node kind",
        ))
    }
}

pub fn resource(step: &StepDefinition) -> Option<&str> {
    step.native
        .as_ref()
        .map(|value| value.resource.as_str())
        .or(match step.kind.as_str() {
            "clinical_template" => Some("unconfigured"),
            "eligibility_query" => Some("eligibility"),
            "payment_request" => Some("payment"),
            "order" => Some("order"),
            "referral" => Some("referral"),
            "patient_form" => Some("intake_reviewed"),
            "appointment_booking" => Some("appointment_booked"),
            "availability_query"
            | "slot_hold"
            | "appointment_reschedule"
            | "appointment_cancel"
            | "intake_request"
            | "communication_send"
            | "ai_extract_draft"
            | "ai_response_draft" => Some("dispatch"),
            _ => None,
        })
}

fn domain(resource: &str, kind: &str) -> (&'static str, &'static str, &'static str) {
    match resource {
        "check_in" | "appointment_booked" => {
            ("scheduling", "/api/v1/scheduling/appointments", "schedule")
        }
        "intake_reviewed" => ("scheduling", "/api/v1/scheduling/appointments", "previsit"),
        "payment" | "eligibility" => ("billing", "/api/v1/billing/accounts", "billing"),
        "claim_review" | "claim_submitted" | "claim_accepted" => {
            ("claims", "/api/v1/billing/claims", "claims")
        }
        "referral" => ("clinical", "/api/v1/referrals", "referrals"),
        "follow_up" => ("clinical", "/api/v1/follow-up", "followup"),
        "functional_status"
        | "neurotoxin"
        | "baclofen_pump_refill"
        | "stretching_program"
        | "care_coordination" => ("clinical", "/api/v1/patients", "specialty"),
        "dispatch" if matches!(kind, "ai_extract_draft" | "ai_response_draft") => {
            ("ai", "/api/v1/ai/drafts", "ai_review")
        }
        "dispatch" if kind == "communication_send" => {
            ("communications", "/api/v1/integrations", "communications")
        }
        "dispatch" => ("scheduling", "/api/v1/scheduling/appointments", "schedule"),
        _ => ("clinical", "/api/v1/patients", "clinical"),
    }
}

async fn permitted(
    state: &State,
    actor: &Actor,
    headers: &HeaderMap,
    resource: &str,
    kind: &str,
) -> Result<()> {
    actor.staff()?;
    let (domain, path, _) = domain(resource, kind);
    crate::access_policies::require_native(state, actor, domain, "view").await?;
    if let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| value.starts_with("sce_at_"))
    {
        let current = crate::oauth::authenticate(state, token, &Method::GET, path).await?;
        if current.sub != actor.sub || current.tenant_id != actor.tenant_id {
            return Err(Error::Unauthorized);
        }
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Run {
    id: Uuid,
    patient_id: Option<Uuid>,
    appointment_id: Option<Uuid>,
    visit_id: Option<Uuid>,
    definition_version: i64,
    status: String,
    definition: Value,
}

async fn run(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
    lock: bool,
) -> Result<Run> {
    let sql=format!("SELECT i.id,i.patient_id,i.appointment_id,i.visit_id,i.definition_version,i.status,r.definition FROM care_pathway_instances i JOIN care_pathway_definition_revisions r ON r.tenant_id=i.tenant_id AND r.definition_id=i.definition_id AND r.version=i.definition_version WHERE i.tenant_id=$1 AND i.id=$2 {}",if lock {"FOR UPDATE OF i"}else{"FOR SHARE OF i"});
    let mut run: Run = sqlx::query_as(&sql)
        .bind(actor.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)?;
    if run.appointment_id.is_none() {
        let appointments:Vec<Uuid>=sqlx::query_scalar("SELECT ap.id FROM workflow_dispatches d JOIN appointments ap ON ap.tenant_id=d.tenant_id AND ap.id::text=d.result->>'appointment_id' WHERE d.tenant_id=$1 AND d.pathway_instance_id=$2 AND d.kind='appointment_booking' AND d.status='completed' AND ap.patient_id=$3 ORDER BY d.created_at LIMIT 2 FOR SHARE OF ap")
            .bind(actor.tenant_id).bind(id).bind(run.patient_id).fetch_all(&mut **tx).await?;
        if appointments.len() == 1 {
            run.appointment_id = Some(appointments[0]);
        }
    }
    if run.visit_id.is_none() && run.appointment_id.is_some() {
        run.visit_id=sqlx::query_scalar("SELECT id FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND appointment_id=$3 FOR SHARE")
            .bind(actor.tenant_id).bind(run.patient_id).bind(run.appointment_id).fetch_optional(&mut **tx).await?;
    }
    if let Some(visit) = run.visit_id {
        let appointment:Uuid=sqlx::query_scalar("SELECT appointment_id FROM visits WHERE tenant_id=$1 AND id=$2 AND patient_id=$3 FOR SHARE")
            .bind(actor.tenant_id).bind(visit).bind(run.patient_id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
        if run
            .appointment_id
            .is_some_and(|expected| expected != appointment)
        {
            return Err(Error::Conflict(
                "workflow visit and appointment do not match",
            ));
        }
        run.appointment_id = Some(appointment);
    }
    if let Some(appointment) = run.appointment_id {
        sqlx::query(
            "SELECT id FROM appointments WHERE tenant_id=$1 AND id=$2 AND patient_id=$3 FOR SHARE",
        )
        .bind(actor.tenant_id)
        .bind(appointment)
        .bind(run.patient_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)?;
    }
    Ok(run)
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct Candidate {
    resource_id: Uuid,
    resource_version: i64,
    status: String,
    created_at: DateTime<Utc>,
    ready: bool,
}

async fn candidates(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    run: &Run,
    step: &StepDefinition,
    resource: &str,
    selected: Option<Uuid>,
) -> Result<Vec<Candidate>> {
    let (select,from,filter)=match resource {
        "appointment_booked"=>("x.id,x.version,x.status,x.starts_at,x.status IN ('booked','checked_in','in_progress','completed')", "appointments x CROSS JOIN binding b JOIN workflow_dispatches dispatch ON dispatch.tenant_id=b.tenant AND dispatch.result->>'appointment_id'=x.id::text", "x.patient_id=b.patient AND dispatch.pathway_instance_id=b.instance AND dispatch.step_key=b.step AND dispatch.kind='appointment_booking' AND dispatch.status='completed'"),
        "check_in"=>("x.id,x.version,x.status,x.starts_at, x.status IN ('checked_in','in_progress','completed')", "appointments x CROSS JOIN binding b", "x.patient_id=b.patient AND x.id=b.appointment"),
        "signed_visit"=>("x.id,x.version,x.status,x.created_at, x.status='signed' AND x.signed_at IS NOT NULL AND x.signed_by IS NOT NULL", "visits x CROSS JOIN binding b", "x.patient_id=b.patient AND x.id=b.visit AND (b.appointment IS NULL OR x.appointment_id=b.appointment)"),
        "functional_status"=>("x.id,1::bigint,'recorded'::text,x.recorded_at,true", "functional_status_assessments x CROSS JOIN binding b", "x.patient_id=b.patient AND x.visit_id=b.visit AND NOT EXISTS(SELECT 1 FROM functional_status_assessments newer WHERE newer.tenant_id=x.tenant_id AND newer.supersedes_id=x.id)"),
        "neurotoxin"|"baclofen_pump_refill"|"stretching_program"|"care_coordination"=>("x.id,x.version,x.status,x.created_at,x.status='completed'", "specialty_care_items x CROSS JOIN binding b", "x.patient_id=b.patient AND x.visit_id=b.visit AND x.kind=$9 AND x.status NOT IN ('cancelled','entered_in_error')"),
        "order"=>("x.id,x.version,x.status,x.created_at,x.status IN ('ordered','in_progress','completed') AND x.placed_at IS NOT NULL AND x.placed_by IS NOT NULL", "lab_orders x CROSS JOIN binding b", "x.patient_id=b.patient AND x.visit_id=b.visit AND x.status NOT IN ('cancelled','entered_in_error')"),
        "referral"=>("x.id,x.version,x.status,x.created_at,x.status IN ('sent','accepted','scheduled','completed')", "referrals x CROSS JOIN binding b", "x.patient_id=b.patient AND x.visit_id=b.visit AND x.status NOT IN ('cancelled','entered_in_error')"),
        "follow_up"=>("x.id,x.version,x.status,x.created_at,x.status='completed'", "follow_up_tasks x CROSS JOIN binding b", "x.patient_id=b.patient AND x.visit_id=b.visit AND x.status<>'cancelled'"),
        "intake_reviewed"=>("x.id,x.version,x.status,x.created_at,x.status='reviewed' AND x.reviewed_at IS NOT NULL AND x.reviewed_by IS NOT NULL", "previsit_intake_packets x CROSS JOIN binding b", "x.patient_id=b.patient AND x.appointment_id=b.appointment AND x.workflow_instance_id=b.instance AND x.workflow_step_key=b.step AND x.workflow_definition_version=b.definition_version"),
        "eligibility"=>("x.id,1::bigint,x.status,x.created_at,x.status='completed' AND x.completed_at IS NOT NULL AND x.response_snapshot IS NOT NULL", "claimmd_eligibility_checks x CROSS JOIN binding b JOIN appointments ap ON ap.tenant_id=b.tenant AND ap.id=b.appointment AND ap.patient_id=b.patient LEFT JOIN previsit_booking_profiles bp ON bp.tenant_id=b.tenant", "x.patient_id=b.patient AND x.request_snapshot#>>'{request,service_date}'=((ap.starts_at AT TIME ZONE coalesce(bp.booking_timezone,'UTC'))::date)::text"),
        "payment"=>("x.id,x.version,x.status,x.created_at,x.status='paid' AND x.refunded_cents=0 AND x.provider_payment_intent IS NOT NULL AND x.provider_charge_id IS NOT NULL AND EXISTS(SELECT 1 FROM billing_entries entry WHERE entry.tenant_id=x.tenant_id AND entry.id=x.paid_entry_id AND entry.account_id=x.account_id AND entry.content->>'managed_payment_id'=x.id::text)", "payment_attempts x CROSS JOIN binding b JOIN billing_accounts account ON account.tenant_id=b.tenant AND account.id=x.account_id", "account.patient_id=b.patient AND account.visit_id=b.visit AND account.status='posted'"),
        "claim_review"=>("x.id,x.version,x.status,x.created_at,x.status IN ('ready','submitted','accepted','adjudicated')", "ehr_claims x CROSS JOIN binding b JOIN billing_accounts account ON account.tenant_id=b.tenant AND account.id=x.account_id", "x.patient_id=b.patient AND account.patient_id=b.patient AND account.visit_id=b.visit AND x.status<>'void'"),
        "claim_submitted"=>("x.id,x.version,x.status,x.created_at,x.status IN ('submitted','accepted','adjudicated') AND EXISTS(SELECT 1 FROM edi_submissions sub WHERE sub.tenant_id=x.tenant_id AND sub.claim_id=x.id AND sub.status='delivered')", "ehr_claims x CROSS JOIN binding b JOIN billing_accounts account ON account.tenant_id=b.tenant AND account.id=x.account_id", "x.patient_id=b.patient AND account.patient_id=b.patient AND account.visit_id=b.visit AND x.status<>'void'"),
        "claim_accepted"=>("x.id,x.version,x.status,x.created_at,x.status IN ('accepted','adjudicated') AND EXISTS(SELECT 1 FROM edi_submissions sub WHERE sub.tenant_id=x.tenant_id AND sub.claim_id=x.id AND sub.status='delivered' AND sub.payer_outcome='accepted')", "ehr_claims x CROSS JOIN binding b JOIN billing_accounts account ON account.tenant_id=b.tenant AND account.id=x.account_id", "x.patient_id=b.patient AND account.patient_id=b.patient AND account.visit_id=b.visit AND x.status<>'void'"),
        "dispatch"=>("x.id,x.version,x.status,x.created_at,x.status='completed'", "workflow_dispatches x CROSS JOIN binding b", "x.pathway_instance_id=b.instance AND x.step_key=b.step AND x.kind=$9 AND x.status NOT IN ('rejected','failed')"),
        _=>return Ok(vec![]),
    };
    // All identifiers/table names above are compiled allowlists; no caller SQL or selectors.
    let sql=format!("WITH binding AS (SELECT $1::uuid tenant,$2::uuid patient,$3::uuid appointment,$4::uuid visit,$5::uuid instance,$6::text step,$7::bigint definition_version,$9::text resource_kind) SELECT candidate.id AS resource_id,candidate.version AS resource_version,candidate.status,candidate.created_at,candidate.ready FROM (SELECT {} FROM {} WHERE x.tenant_id=b.tenant AND {} AND ($8::uuid IS NULL OR x.id=$8) ORDER BY x.id LIMIT 21 FOR SHARE OF x) AS candidate(id,version,status,created_at,ready)",select,from,filter);
    sqlx::query_as(&sql)
        .bind(actor.tenant_id)
        .bind(run.patient_id)
        .bind(run.appointment_id)
        .bind(run.visit_id)
        .bind(run.id)
        .bind(&step.key)
        .bind(run.definition_version)
        .bind(selected)
        .bind(if resource == "dispatch" {
            step.kind.as_str()
        } else {
            resource
        })
        .fetch_all(&mut **tx)
        .await
        .map_err(Into::into)
}

fn selected(evidence: &Value) -> Result<Option<Uuid>> {
    evidence
        .get("native_resource_id")
        .or_else(|| evidence.pointer("/native/resource_id"))
        .filter(|v| !v.is_null())
        .map(|v| {
            v.as_str()
                .and_then(|s| s.parse().ok())
                .filter(|id: &Uuid| !id.is_nil())
                .ok_or(Error::Invalid("invalid native evidence selection"))
        })
        .transpose()
}

fn explanation(resource: &str, ready: bool) -> &'static str {
    if ready {
        match resource {"eligibility"=>"Eligibility response received for the appointment date; this does not establish active benefits or provider credentialing.","payment"=>"Processor-confirmed test payment has a ledger entry and no refund.","claim_review"=>"Native claim has passed its readiness review.","claim_submitted"=>"Native claim has a delivered submission; payer acceptance is separate.","claim_accepted"=>"Native claim has recorded payer acceptance evidence; this does not guarantee payment.",_=>"The linked native record satisfies this step."}
    } else {
        match resource {"clinical_template"|"unconfigured"=>"Choose a native resource for this clinical documentation node.","eligibility"=>"A completed eligibility response for the appointment date is required.","payment"=>"A processor-confirmed payment and ledger entry are required; opening checkout is insufficient.","signed_visit"=>"The linked encounter must be signed.","intake_reviewed"=>"This workflow step's exact versioned intake packet must be reviewed.","claim_accepted"=>"Payer acceptance evidence is required; preparing or submitting a claim is insufficient.","dispatch"=>"Complete the reviewed native dispatch and any required downstream review.",_=>"Complete the linked native operation before completing this step."}
    }
}

async fn inspect(
    state: &State,
    actor: &Actor,
    headers: &HeaderMap,
    tx: &mut Transaction<'_, Postgres>,
    run: &Run,
    step: &StepDefinition,
    evidence: &Value,
) -> Result<Value> {
    let Some(resource) = resource(step) else {
        return Ok(
            json!({"step_key":step.key,"resource":Value::Null,"ready":true,"status":"manual","reason":"Staff task; no native record binding is configured."}),
        );
    };
    let (_, _, module) = domain(resource, &step.kind);
    let action = json!({"module":module,"patient_id":run.patient_id,"appointment_id":run.appointment_id,"visit_id":run.visit_id,"chart_section":match resource {"signed_visit"=>"visits","functional_status"=>"functional_status","neurotoxin"|"baclofen_pump_refill"|"stretching_program"|"care_coordination"=>"specialty_care","order"=>"orders","referral"=>"referrals","payment"|"eligibility"=>"billing",_=>"care_pathways"}});
    if let Err(error) = permitted(state, actor, headers, resource, &step.kind).await {
        return match error {
            Error::Forbidden => Ok(
                json!({"step_key":step.key,"resource":resource,"ready":false,"status":"forbidden","reason":"Your current access does not permit reading this native evidence."}),
            ),
            other => Err(other),
        };
    }
    let mut value = json!({"step_key":step.key,"resource":resource,"ready":false,"status":"missing","reason":explanation(resource,false),"action":action});
    if resource == "unconfigured" {
        value["status"] = json!("unconfigured");
        return Ok(value);
    }
    if run.patient_id.is_none() && resource != "dispatch" {
        value["reason"] = json!("Link a patient to the workflow before verifying native evidence.");
        return Ok(value);
    }
    let choices = candidates(tx, actor, run, step, resource, selected(evidence)?).await?;
    if choices.len() > 1 {
        value["status"] = json!("ambiguous");
        value["reason"] = json!("Select the exact native record from this run's matching records.");
        value["candidates"] = json!(choices.iter().take(20).collect::<Vec<_>>());
        value["candidates_truncated"] = json!(choices.len() > 20);
        return Ok(value);
    }
    if let Some(candidate) = choices.first() {
        value["ready"] = json!(candidate.ready);
        value["status"] = json!(if candidate.ready {
            "verified"
        } else {
            "pending"
        });
        value["native_status"] = json!(candidate.status);
        value["reason"] = json!(explanation(resource, candidate.ready));
        value["resource_id"] = json!(candidate.resource_id);
        value["resource_version"] = json!(candidate.resource_version);
        value["action"]["resource_id"] = json!(candidate.resource_id);
        if resource == "payment" {
            value["test_mode"] = json!(true);
        }
    }
    Ok(value)
}

/// Runs in the same transaction as the pathway state change and audit event.
// Keep trusted auth, transaction, run identity, and both evidence versions explicit
// at this boundary so callers cannot accidentally substitute one for another.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn verify_completion(
    state: &State,
    actor: &Actor,
    headers: &HeaderMap,
    tx: &mut Transaction<'_, Postgres>,
    instance: Uuid,
    step_key: &str,
    incoming: &Value,
    stored: &Value,
) -> Result<Value> {
    let run = run(tx, actor, instance, true).await?;
    if run.status != "active" {
        return Err(Error::Conflict("workflow instance is not active"));
    }
    let definition: Definition = serde_json::from_value(run.definition.clone())
        .map_err(|_| Error::Conflict("saved pathway definition is invalid"))?;
    let step = definition
        .steps
        .iter()
        .find(|step| step.key == step_key)
        .ok_or(Error::NotFound)?;
    if resource(step).is_none() {
        return Ok(incoming.clone());
    }
    // A previously verified selection survives an approval with an empty body.
    // It is rechecked against native state; caller-supplied success flags never survive.
    let selection = if incoming.get("native_resource_id").is_some() {
        incoming
    } else {
        stored
    };
    let proof = inspect(state, actor, headers, tx, &run, step, selection).await?;
    if proof["status"] == "forbidden" {
        return Err(Error::Forbidden);
    }
    if proof["ready"] != true {
        return Err(Error::Conflict("native evidence is not ready; refresh this workflow's readiness and complete the linked native operation"));
    }
    Ok(
        json!({"native":{"resource":proof["resource"],"resource_id":proof["resource_id"],"resource_version":proof["resource_version"],"native_status":proof["native_status"],"definition_version":run.definition_version,"patient_id":run.patient_id,"appointment_id":run.appointment_id,"visit_id":run.visit_id,"verified_at":Utc::now(),"test_mode":proof.get("test_mode")}}),
    )
}

pub fn router() -> Router<State> {
    Router::new().route(
        "/api/v1/care-pathways/instances/{id}/readiness",
        get(readiness),
    )
}

async fn readiness(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response> {
    actor.staff()?;
    let mut tx = state
        .browser
        .as_ref()
        .ok_or(Error::Unauthorized)?
        .db
        .begin()
        .await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let run = run(&mut tx, &actor, id, false).await?;
    let definition: Definition = serde_json::from_value(run.definition.clone())
        .map_err(|_| Error::Conflict("saved pathway definition is invalid"))?;
    let rows:Vec<(String,String,Value)>=sqlx::query_as("SELECT step_key,state,evidence FROM care_pathway_steps WHERE tenant_id=$1 AND instance_id=$2 ORDER BY position")
        .bind(actor.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let mut steps = Vec::new();
    for step in &definition.steps {
        let stored = rows
            .iter()
            .find(|row| row.0 == step.key)
            .ok_or(Error::Conflict("workflow step is missing"))?;
        let mut proof = inspect(&state, &actor, &headers, &mut tx, &run, step, &stored.2).await?;
        proof["state"] = json!(stored.1);
        steps.push(proof);
    }
    let observed_at: DateTime<Utc> = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let progress = json!({"total":rows.len(),"completed":rows.iter().filter(|row|row.1=="completed").count(),"awaiting_approval":rows.iter().filter(|row|row.1=="awaiting_approval").count(),"ready":rows.iter().filter(|row|row.1=="ready").count(),"blocked":rows.iter().filter(|row|row.1=="blocked").count()});
    crate::postgres::audit(&mut tx, &actor, "practice.workflow_evidence.read", id).await?;
    tx.commit().await?;
    Ok(([(header::CACHE_CONTROL,"no-store")],Json(json!({"instance_id":id,"definition_version":run.definition_version,"observed_at":observed_at,"steps":steps,"progress":progress}))).into_response())
}
