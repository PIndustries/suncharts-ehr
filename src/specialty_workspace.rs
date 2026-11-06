// SPDX-License-Identifier: AGPL-3.0-only
//! Practice-controlled workspace presentation and specialty clinical records.
//! Presentation settings never disable the underlying APIs or erase clinical data.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    model::text,
    postgres::audit,
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{Datelike, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use std::collections::HashSet;
use uuid::Uuid;

const MODULES: [&str; 14] = [
    "practice",
    "clinical",
    "schedule",
    "labs",
    "referrals",
    "followup",
    "portal",
    "specialty",
    "billing",
    "claims",
    "edi",
    "apps",
    "migration",
    "admin",
];
const CHART_TABS: [&str; 15] = [
    "overview",
    "profile",
    "clinical",
    "prescribing",
    "immunizations",
    "functional_status",
    "specialty_care",
    "history",
    "documents",
    "referrals",
    "orders",
    "visits",
    "checkout",
    "billing",
    "source",
];
const SPECIALTY_WORKSPACES: [&str; 1] = ["spasticity_movement"];

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceContent {
    pub module_order: Vec<String>,
    #[serde(default)]
    pub hidden_modules: Vec<String>,
    #[serde(default)]
    pub specialty_workspaces: Vec<String>,
    pub chart_tabs: Vec<String>,
}

impl Default for WorkspaceContent {
    fn default() -> Self {
        Self {
            module_order: MODULES.iter().map(|s| (*s).to_owned()).collect(),
            hidden_modules: vec![],
            specialty_workspaces: vec![],
            chart_tabs: CHART_TABS
                .iter()
                .filter(|s| !matches!(**s, "functional_status" | "specialty_care"))
                .map(|s| (*s).to_owned())
                .collect(),
        }
    }
}

fn unique_allowed(values: &[String], allowed: &[&str], field: &'static str) -> Result<()> {
    let mut seen = HashSet::new();
    if values
        .iter()
        .any(|v| !allowed.contains(&v.as_str()) || !seen.insert(v))
    {
        return Err(Error::Invalid(field));
    }
    Ok(())
}

impl WorkspaceContent {
    fn validate(&self) -> Result<()> {
        unique_allowed(
            &self.module_order,
            &MODULES,
            "invalid or repeated workspace module",
        )?;
        unique_allowed(
            &self.hidden_modules,
            &MODULES,
            "invalid or repeated hidden module",
        )?;
        unique_allowed(
            &self.specialty_workspaces,
            &SPECIALTY_WORKSPACES,
            "invalid or repeated specialty workspace",
        )?;
        unique_allowed(
            &self.chart_tabs,
            &CHART_TABS,
            "invalid or repeated chart tab",
        )?;
        if self.module_order.len() != MODULES.len()
            || MODULES
                .iter()
                .any(|m| !self.module_order.iter().any(|v| v == m))
            || !self.chart_tabs.iter().any(|v| v == "overview")
        {
            return Err(Error::Invalid(
                "module order must include every module once and chart tabs must include overview",
            ));
        }
        if self.specialty_workspaces.is_empty()
            && self
                .chart_tabs
                .iter()
                .any(|v| matches!(v.as_str(), "functional_status" | "specialty_care"))
        {
            return Err(Error::Invalid(
                "specialty chart tabs require an enabled specialty workspace",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceChange {
    content: WorkspaceContent,
    reason: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct FunctionalStatusContent {
    mobility: String,
    transfers: String,
    self_care: String,
    communication: String,
    falls_last_90_days: u16,
    #[serde(default)]
    assistive_devices: Vec<String>,
    patient_goal: String,
    #[serde(default)]
    scale_name: String,
    #[serde(default)]
    scale_score: String,
    #[serde(default)]
    notes: String,
}

impl FunctionalStatusContent {
    fn validate(&self) -> Result<()> {
        let levels = [
            "independent",
            "modified_independent",
            "supervision",
            "assistance",
            "dependent",
            "not_assessed",
        ];
        if !levels.contains(&self.mobility.as_str())
            || !levels.contains(&self.transfers.as_str())
            || !levels.contains(&self.self_care.as_str())
            || !levels.contains(&self.communication.as_str())
            || self.falls_last_90_days > 999
            || self.assistive_devices.len() > 20
            || self.assistive_devices.iter().collect::<HashSet<_>>().len()
                != self.assistive_devices.len()
        {
            return Err(Error::Invalid("invalid functional status assessment"));
        }
        text(&self.patient_goal, 2000)?;
        for (value, max) in [
            (&self.scale_name, 120),
            (&self.scale_score, 120),
            (&self.notes, 10000),
        ] {
            if value.chars().count() > max {
                return Err(Error::Invalid("functional status text is too long"));
            }
        }
        for value in &self.assistive_devices {
            text(value, 120)?;
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FunctionalStatusCreate {
    request_id: Uuid,
    visit_id: Option<Uuid>,
    supersedes_id: Option<Uuid>,
    content: FunctionalStatusContent,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CareCreate {
    request_id: Uuid,
    visit_id: Option<Uuid>,
    kind: String,
    content: Value,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CareChange {
    visit_id: Option<Uuid>,
    content: Value,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CareAction {
    action: String,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NeurotoxinContent {
    medication: String,
    fulfillment: String,
    #[serde(default)]
    specialty_pharmacy: String,
    prior_authorization: String,
    #[serde(default)]
    authorization_reference: String,
    next_task: String,
    task_due: Option<NaiveDate>,
    #[serde(default)]
    ndc: String,
    #[serde(default)]
    hcpcs_j_code: String,
    planned_units: u32,
    administered_units: u32,
    wasted_units: u32,
    #[serde(default)]
    lot_number: String,
    expiration_date: Option<NaiveDate>,
    follow_up_due: Option<NaiveDate>,
    #[serde(default)]
    notes: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PumpContent {
    pump_model: String,
    medication: String,
    concentration: String,
    refill_due: NaiveDate,
    reservoir_volume_ml: String,
    #[serde(default)]
    notes: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StretchingContent {
    program_name: String,
    frequency: String,
    assigned_to: String,
    follow_up_due: Option<NaiveDate>,
    #[serde(default)]
    notes: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CoordinationContent {
    focus: String,
    responsible_staff_id: Uuid,
    next_step: String,
    due_date: NaiveDate,
    #[serde(default)]
    notes: String,
}

fn optional_text(value: &str, max: usize) -> Result<()> {
    if value.chars().count() > max {
        Err(Error::Invalid("specialty content is too long"))
    } else {
        Ok(())
    }
}

fn validate_care(kind: &str, value: &Value) -> Result<()> {
    match kind {
        "neurotoxin" => {
            let c: NeurotoxinContent = serde_json::from_value(value.clone())
                .map_err(|_| Error::Invalid("invalid neurotoxin workflow content"))?;
            if !["specialty_pharmacy", "buy_and_bill"].contains(&c.fulfillment.as_str())
                || ![
                    "not_started",
                    "submitted",
                    "approved",
                    "denied",
                    "not_required",
                ]
                .contains(&c.prior_authorization.as_str())
                || c.planned_units == 0
                || c.administered_units + c.wasted_units > c.planned_units
                || (c.fulfillment == "specialty_pharmacy" && c.specialty_pharmacy.trim().is_empty())
                || c.task_due.is_some_and(|d| d.year() < 1900)
                || c.follow_up_due.is_some_and(|d| d.year() < 1900)
            {
                return Err(Error::Invalid("invalid neurotoxin workflow values"));
            }
            text(&c.medication, 200)?;
            for (v, max) in [
                (&c.specialty_pharmacy, 200),
                (&c.authorization_reference, 120),
                (&c.next_task, 500),
                (&c.ndc, 30),
                (&c.hcpcs_j_code, 20),
                (&c.lot_number, 100),
                (&c.notes, 10000),
            ] {
                optional_text(v, max)?;
            }
            text(&c.next_task, 500)?;
            if c.expiration_date
                .is_some_and(|d| d < Utc::now().date_naive())
                && c.administered_units == 0
            {
                return Err(Error::Invalid(
                    "an expired lot cannot be planned for administration",
                ));
            }
        }
        "baclofen_pump_refill" => {
            let c: PumpContent = serde_json::from_value(value.clone())
                .map_err(|_| Error::Invalid("invalid pump refill workflow content"))?;
            text(&c.pump_model, 200)?;
            text(&c.medication, 200)?;
            text(&c.concentration, 120)?;
            text(&c.reservoir_volume_ml, 40)?;
            optional_text(&c.notes, 10000)?;
            if c.refill_due.year() < 1900 {
                return Err(Error::Invalid("invalid pump refill due date"));
            }
        }
        "stretching_program" => {
            let c: StretchingContent = serde_json::from_value(value.clone())
                .map_err(|_| Error::Invalid("invalid stretching workflow content"))?;
            text(&c.program_name, 200)?;
            text(&c.frequency, 200)?;
            text(&c.assigned_to, 200)?;
            optional_text(&c.notes, 10000)?;
            if c.follow_up_due.is_some_and(|d| d.year() < 1900) {
                return Err(Error::Invalid("invalid stretching follow-up date"));
            }
        }
        "care_coordination" => {
            let c: CoordinationContent = serde_json::from_value(value.clone())
                .map_err(|_| Error::Invalid("invalid care coordination content"))?;
            text(&c.focus, 200)?;
            text(&c.next_step, 2000)?;
            optional_text(&c.notes, 10000)?;
            if c.responsible_staff_id.is_nil() || c.due_date.year() < 1900 {
                return Err(Error::Invalid("invalid care coordination assignment"));
            }
        }
        _ => return Err(Error::Invalid("unsupported specialty care item kind")),
    }
    Ok(())
}

pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/practice/workspace-settings",
            get(settings).put(save_settings),
        )
        .route(
            "/api/v1/patients/{patient}/functional-status",
            get(functional_status).post(create_functional_status),
        )
        .route(
            "/api/v1/patients/{patient}/specialty-care",
            get(care_items).post(create_care_item),
        )
        .route(
            "/api/v1/patients/{patient}/specialty-care/{id}",
            axum::routing::put(update_care_item),
        )
        .route(
            "/api/v1/patients/{patient}/specialty-care/{id}/actions",
            axum::routing::post(care_action),
        )
        .route(
            "/api/v1/patients/{patient}/specialty-care/{id}/revisions",
            get(care_revisions),
        )
        .route("/api/v1/specialty-care/worklist", get(care_worklist))
}

fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}

fn writer(a: &Actor, clinical_only: bool) -> Result<()> {
    let allowed = if clinical_only {
        matches!(a.role, Role::Owner | Role::Clinician | Role::Nurse)
    } else {
        matches!(
            a.role,
            Role::Owner | Role::Clinician | Role::Nurse | Role::MedicalAssistant
        )
    };
    if allowed {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

fn expected(h: &HeaderMap, allow_zero: bool) -> Result<i64> {
    let raw = h
        .get(header::IF_MATCH)
        .ok_or(Error::VersionRequired)?
        .to_str()
        .map_err(|_| Error::Invalid("invalid If-Match"))?;
    let v = raw
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .ok_or(Error::Invalid("If-Match must quote the version"))?
        .parse::<i64>()
        .map_err(|_| Error::Invalid("invalid record version"))?;
    if v < if allow_zero { 0 } else { 1 } {
        return Err(Error::Invalid("invalid record version"));
    }
    Ok(v)
}

async fn context(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    patient: Uuid,
    visit: Option<Uuid>,
) -> Result<()> {
    let found: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(patient)
            .fetch_one(&mut **tx)
            .await?;
    if !found {
        return Err(Error::NotFound);
    }
    if let Some(visit) = visit {
        let found: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)",
        )
        .bind(a.tenant_id)
        .bind(patient)
        .bind(visit)
        .fetch_one(&mut **tx)
        .await?;
        if !found {
            return Err(Error::Invalid("encounter must belong to patient"));
        }
    }
    Ok(())
}

async fn settings(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let saved: Option<(i64, Value, Uuid, chrono::DateTime<Utc>)> = sqlx::query_as("SELECT version,content,updated_by,updated_at FROM practice_workspace_settings WHERE tenant_id=$1").bind(a.tenant_id).fetch_optional(&mut *tx).await?;
    audit(&mut tx, &a, "practice.workspace_settings.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(match saved {
        Some((version, content, updated_by, updated_at)) => {
            json!({"version":version,"content":content,"updated_by":updated_by,"updated_at":updated_at})
        }
        None => {
            json!({"version":0,"content":WorkspaceContent::default(),"updated_by":Value::Null,"updated_at":Value::Null})
        }
    }))
}

async fn save_settings(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<WorkspaceChange>,
) -> Result<Response> {
    if !matches!(a.role, Role::Owner) {
        return Err(Error::Forbidden);
    }
    v.content.validate()?;
    text(&v.reason, 1000)?;
    let version = expected(&h, true)?;
    let mut tx = db(&s)?.begin().await?;
    crate::scheduling::tenant_lock(&mut tx, &a).await?;
    let current: Option<i64> = sqlx::query_scalar(
        "SELECT version FROM practice_workspace_settings WHERE tenant_id=$1 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .fetch_optional(&mut *tx)
    .await?;
    if current.unwrap_or(0) != version {
        return Err(Error::Conflict(
            "workspace settings changed; reload before saving",
        ));
    }
    let content = json!(v.content);
    let next = version + 1;
    sqlx::query("INSERT INTO practice_workspace_settings(tenant_id,version,content,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id) DO UPDATE SET version=$2,content=$3,updated_by=$4,updated_at=now()")
        .bind(a.tenant_id).bind(next).bind(&content).bind(a.sub).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO practice_workspace_setting_revisions(tenant_id,version,content,actor_id,reason) VALUES($1,$2,$3,$4,$5)")
        .bind(a.tenant_id).bind(next).bind(&content).bind(a.sub).bind(v.reason.trim()).execute(&mut *tx).await?;
    audit(
        &mut tx,
        &a,
        "practice.workspace_settings.write",
        a.tenant_id,
    )
    .await?;
    tx.commit().await?;
    Ok((
        [(header::ETAG, format!("\"{next}\""))],
        Json(json!({"version":next,"content":content,"updated_by":a.sub,"updated_at":Utc::now()})),
    )
        .into_response())
}

async fn functional_status(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(patient): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    context(&mut tx, &a, patient, None).await?;
    let items: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'patient_id',patient_id,'visit_id',visit_id,'supersedes_id',supersedes_id,'content',content,'recorded_by',recorded_by,'reason',reason,'recorded_at',recorded_at) FROM functional_status_assessments WHERE tenant_id=$1 AND patient_id=$2 ORDER BY recorded_at DESC,id DESC LIMIT 100")
        .bind(a.tenant_id).bind(patient).fetch_all(&mut *tx).await?;
    audit(&mut tx, &a, "patient.functional_status.read", patient).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}

async fn create_functional_status(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(patient): Path<Uuid>,
    Json(v): Json<FunctionalStatusCreate>,
) -> Result<Json<Value>> {
    writer(&a, false)?;
    v.content.validate()?;
    text(&v.reason, 1000)?;
    let request = json!({"patient_id":patient,"visit_id":v.visit_id,"supersedes_id":v.supersedes_id,"content":v.content,"reason":v.reason});
    let mut tx = db(&s)?.begin().await?;
    context(&mut tx, &a, patient, v.visit_id).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,57))")
        .bind(format!("{}:functional:{}", a.tenant_id, v.request_id))
        .execute(&mut *tx)
        .await?;
    if let Some((id,old))=sqlx::query_as::<_,(Uuid,Value)>("SELECT id,create_request FROM functional_status_assessments WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(v.request_id).fetch_optional(&mut *tx).await? {
        if old!=request{return Err(Error::Conflict("functional status request identity was reused"));}
        let row:Value=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'patient_id',patient_id,'visit_id',visit_id,'supersedes_id',supersedes_id,'content',content,'recorded_by',recorded_by,'reason',reason,'recorded_at',recorded_at) FROM functional_status_assessments WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
        audit(&mut tx,&a,"patient.functional_status.replay",patient).await?;tx.commit().await?;return Ok(Json(row));
    }
    if let Some(old) = v.supersedes_id {
        let found:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM functional_status_assessments WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)").bind(a.tenant_id).bind(patient).bind(old).fetch_one(&mut *tx).await?;
        if !found {
            return Err(Error::Invalid(
                "superseded assessment must belong to patient",
            ));
        }
    }
    let id = Uuid::new_v4();
    let row:Value=sqlx::query_scalar("INSERT INTO functional_status_assessments(tenant_id,patient_id,id,request_id,create_request,visit_id,supersedes_id,content,recorded_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING jsonb_build_object('id',id,'patient_id',patient_id,'visit_id',visit_id,'supersedes_id',supersedes_id,'content',content,'recorded_by',recorded_by,'reason',reason,'recorded_at',recorded_at)")
        .bind(a.tenant_id).bind(patient).bind(id).bind(v.request_id).bind(request).bind(v.visit_id).bind(v.supersedes_id).bind(json!(v.content)).bind(a.sub).bind(v.reason.trim()).fetch_one(&mut *tx).await?;
    audit(&mut tx, &a, "patient.functional_status.create", patient).await?;
    tx.commit().await?;
    Ok(Json(row))
}

const CARE_ROW:&str="jsonb_build_object('id',id,'patient_id',patient_id,'visit_id',visit_id,'kind',kind,'status',status,'content',content,'version',version,'created_by',created_by,'updated_by',updated_by,'created_at',created_at,'updated_at',updated_at)";
async fn care_items(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(patient): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    context(&mut tx, &a, patient, None).await?;
    let q=format!("SELECT {CARE_ROW} FROM specialty_care_items WHERE tenant_id=$1 AND patient_id=$2 ORDER BY updated_at DESC,id DESC LIMIT 100");
    let items: Vec<Value> = sqlx::query_scalar(&q)
        .bind(a.tenant_id)
        .bind(patient)
        .fetch_all(&mut *tx)
        .await?;
    audit(&mut tx, &a, "patient.specialty_care.read", patient).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
async fn create_care_item(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(patient): Path<Uuid>,
    Json(v): Json<CareCreate>,
) -> Result<Response> {
    writer(&a, true)?;
    validate_care(&v.kind, &v.content)?;
    text(&v.reason, 1000)?;
    let request = json!({"patient_id":patient,"visit_id":v.visit_id,"kind":v.kind,"content":v.content,"reason":v.reason});
    let mut tx = db(&s)?.begin().await?;
    context(&mut tx, &a, patient, v.visit_id).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,58))")
        .bind(format!("{}:specialty:{}", a.tenant_id, v.request_id))
        .execute(&mut *tx)
        .await?;
    if let Some((id, old)) = sqlx::query_as::<_, (Uuid, Value)>(
        "SELECT id,create_request FROM specialty_care_items WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        if old != request {
            return Err(Error::Conflict("specialty request identity was reused"));
        }
        let q = format!("SELECT {CARE_ROW} FROM specialty_care_items WHERE tenant_id=$1 AND id=$2");
        let row: Value = sqlx::query_scalar(&q)
            .bind(a.tenant_id)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        audit(&mut tx, &a, "patient.specialty_care.replay", patient).await?;
        tx.commit().await?;
        return Ok(([(header::ETAG, "\"1\"")], Json(row)).into_response());
    }
    let id = Uuid::new_v4();
    let q=format!("INSERT INTO specialty_care_items(tenant_id,patient_id,id,request_id,create_request,visit_id,kind,content,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING {CARE_ROW}");
    let row: Value = sqlx::query_scalar(&q)
        .bind(a.tenant_id)
        .bind(patient)
        .bind(id)
        .bind(v.request_id)
        .bind(request)
        .bind(v.visit_id)
        .bind(&v.kind)
        .bind(&v.content)
        .bind(a.sub)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO specialty_care_item_revisions(tenant_id,item_id,version,status,content,actor_id,reason) VALUES($1,$2,1,'planned',$3,$4,$5)").bind(a.tenant_id).bind(id).bind(&v.content).bind(a.sub).bind(v.reason.trim()).execute(&mut *tx).await?;
    audit(&mut tx, &a, "patient.specialty_care.create", patient).await?;
    tx.commit().await?;
    Ok(([(header::ETAG, "\"1\"")], Json(row)).into_response())
}
async fn update_care_item(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((patient, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<CareChange>,
) -> Result<Response> {
    writer(&a, true)?;
    text(&v.reason, 1000)?;
    let expected = expected(&h, false)?;
    let mut tx = db(&s)?.begin().await?;
    context(&mut tx, &a, patient, v.visit_id).await?;
    let old:Option<(String,String,i64)>=sqlx::query_as("SELECT kind,status,version FROM specialty_care_items WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE").bind(a.tenant_id).bind(patient).bind(id).fetch_optional(&mut *tx).await?;
    let (kind, status, version) = old.ok_or(Error::NotFound)?;
    if version != expected || !["planned", "in_progress", "on_hold"].contains(&status.as_str()) {
        return Err(Error::Conflict(
            "only the current open specialty record can be edited",
        ));
    }
    validate_care(&kind, &v.content)?;
    let q=format!("UPDATE specialty_care_items SET visit_id=$4,content=$5,version=version+1,updated_by=$6,updated_at=now() WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 RETURNING {CARE_ROW}");
    let row: Value = sqlx::query_scalar(&q)
        .bind(a.tenant_id)
        .bind(patient)
        .bind(id)
        .bind(v.visit_id)
        .bind(&v.content)
        .bind(a.sub)
        .fetch_one(&mut *tx)
        .await?;
    let next = version + 1;
    sqlx::query("INSERT INTO specialty_care_item_revisions(tenant_id,item_id,version,status,content,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(a.tenant_id).bind(id).bind(next).bind(status).bind(&v.content).bind(a.sub).bind(v.reason.trim()).execute(&mut *tx).await?;
    audit(&mut tx, &a, "patient.specialty_care.update", patient).await?;
    tx.commit().await?;
    Ok(([(header::ETAG, format!("\"{next}\""))], Json(row)).into_response())
}
fn next_status(current: &str, action: &str) -> Option<&'static str> {
    match (current, action) {
        ("planned", "start") => Some("in_progress"),
        ("planned" | "in_progress" | "on_hold", "cancel") => Some("cancelled"),
        ("in_progress", "hold") => Some("on_hold"),
        ("on_hold", "resume") => Some("in_progress"),
        ("in_progress", "complete") => Some("completed"),
        ("completed", "entered_in_error") => Some("entered_in_error"),
        _ => None,
    }
}
async fn care_action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((patient, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<CareAction>,
) -> Result<Response> {
    writer(&a, true)?;
    text(&v.reason, 1000)?;
    let expected = expected(&h, false)?;
    let mut tx = db(&s)?.begin().await?;
    let old:Option<(String,Value,i64)>=sqlx::query_as("SELECT status,content,version FROM specialty_care_items WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE").bind(a.tenant_id).bind(patient).bind(id).fetch_optional(&mut *tx).await?;
    let (status, content, version) = old.ok_or(Error::NotFound)?;
    if version != expected {
        return Err(Error::Conflict(
            "specialty record changed; reload before updating status",
        ));
    }
    let next_status = next_status(&status, &v.action).ok_or(Error::Conflict(
        "status action is not allowed from the current state",
    ))?;
    let next = version + 1;
    let q=format!("UPDATE specialty_care_items SET status=$4,version=version+1,updated_by=$5,updated_at=now() WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 RETURNING {CARE_ROW}");
    let row: Value = sqlx::query_scalar(&q)
        .bind(a.tenant_id)
        .bind(patient)
        .bind(id)
        .bind(next_status)
        .bind(a.sub)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO specialty_care_item_revisions(tenant_id,item_id,version,status,content,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(a.tenant_id).bind(id).bind(next).bind(next_status).bind(content).bind(a.sub).bind(v.reason.trim()).execute(&mut *tx).await?;
    audit(&mut tx, &a, "patient.specialty_care.action", patient).await?;
    tx.commit().await?;
    Ok(([(header::ETAG, format!("\"{next}\""))], Json(row)).into_response())
}
async fn care_revisions(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((patient, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let found:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM specialty_care_items WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)").bind(a.tenant_id).bind(patient).bind(id).fetch_one(&mut *tx).await?;
    if !found {
        return Err(Error::NotFound);
    }
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('version',version,'status',status,'content',content,'actor_id',actor_id,'reason',reason,'created_at',created_at) FROM specialty_care_item_revisions WHERE tenant_id=$1 AND item_id=$2 ORDER BY version DESC LIMIT 100").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    audit(&mut tx, &a, "patient.specialty_care.history", patient).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
async fn care_worklist(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let q="SELECT (to_jsonb(s)-'tenant_id'-'request_id'-'create_request') || jsonb_build_object('patient_label',p.family_name || ', ' || p.given_name,'mrn',p.mrn) FROM specialty_care_items s JOIN patients p ON p.tenant_id=s.tenant_id AND p.id=s.patient_id WHERE s.tenant_id=$1 AND s.status NOT IN ('completed','cancelled','entered_in_error') ORDER BY s.updated_at DESC,s.id DESC LIMIT 200";
    let items: Vec<Value> = sqlx::query_scalar(q)
        .bind(a.tenant_id)
        .fetch_all(&mut *tx)
        .await?;
    audit(&mut tx, &a, "practice.specialty_care.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
