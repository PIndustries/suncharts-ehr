// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Staged source system exports, count/digest reconciliation, stable external identifiers
//! and atomic import. Source clinical records remain attributed historical records;
//! importing does not fabricate a native signature or authorize clinical cutover.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    model::{text, NewPatient},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    routing::{get, post},
    Json, Router,
};
use chrono::{Datelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

pub const KINDS: &[&str] = &[
    "patient",
    "appointment",
    "encounter",
    "soap_note",
    "vital",
    "medical_problem",
    "allergy",
    "medication",
    "prescription",
    "immunization",
    "document",
    "insurance",
    "insurance_company",
    "transaction",
    "lab_order",
    "lab_result",
    "form",
    "message",
    "facility",
    "practitioner",
    "user",
    "organization",
    "clinical_reminder",
    "billing",
    "claim",
    "x12_partner",
    "edi_acknowledgment",
    "remittance",
    "referral",
    "surgery",
    "dental_issue",
    "employer",
    "drug",
    "procedure",
    "code",
    "list",
    "product",
    "version",
];
pub(crate) fn contains_credentials(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(k, v)| {
            matches!(
                k.to_ascii_lowercase().as_str(),
                "accountkey"
                    | "account_key"
                    | "apikey"
                    | "password"
                    | "password_hash"
                    | "client_secret"
                    | "access_token"
                    | "refresh_token"
                    | "api_key"
                    | "private_key"
                    | "x12_sftp_login"
                    | "x12_sftp_pass"
                    | "x12_client_id"
                    | "x12_client_secret"
                    | "x12_isa02"
                    | "x12_isa04"
            ) || contains_credentials(v)
        }),
        Value::Array(items) => items.iter().any(contains_credentials),
        _ => false,
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub source_instance: String,
    pub source_revision: String,
    pub expected_counts: BTreeMap<String, u64>,
    pub consistency: String,
    #[serde(default)]
    pub limitations: Vec<String>,
}
#[derive(Deserialize, Serialize, Clone, sqlx::FromRow)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub kind: String,
    pub source_id: String,
    pub patient_source_id: Option<String>,
    pub data: Value,
    pub source_data: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub items: Vec<Item>,
}
#[derive(sqlx::FromRow)]
struct Job {
    id: Uuid,
    source_instance: String,
    manifest: Value,
    status: String,
    version: i64,
    digest: Option<String>,
    report: Option<Value>,
}
fn owner(a: &Actor) -> Result<()> {
    if matches!(a.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
async fn lock(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Job> {
    owner(a)?;
    sqlx::query_as("SELECT id,source_instance,manifest,status,version,digest,report FROM migration_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(a.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
fn view(j: &Job) -> Value {
    json!({"id":j.id,"source_instance":j.source_instance,"manifest":j.manifest,"status":j.status,"version":j.version,"digest":j.digest,"report":j.report,
    "cutover":{"allowed":false,"reason":"Import preserves records; native clinical coverage and source freeze verification are required before cutover"}})
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/migrations", get(list).post(create))
        .route("/api/v1/migrations/{id}", get(status))
        .route("/api/v1/migrations/{id}/items", post(stage))
        .route("/api/v1/migrations/{id}/reconcile", post(reconcile))
        .route("/api/v1/migrations/{id}/commit", post(commit))
        .route("/api/v1/patients/{id}/history", get(history))
}
async fn list(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    owner(&a)?;
    let rows:Vec<Job>=sqlx::query_as("SELECT id,source_instance,manifest,status,version,digest,report FROM migration_jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100").bind(a.tenant_id).fetch_all(db(&s)?).await?;
    Ok(Json(
        json!({"items":rows.iter().map(view).collect::<Vec<_>>()}),
    ))
}
async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(m): Json<Manifest>,
) -> Result<Json<Value>> {
    owner(&a)?;
    text(&m.source_instance, 200)?;
    text(&m.source_revision, 200)?;
    if m.expected_counts
        .values()
        .try_fold(0u64, |total, n| total.checked_add(*n))
        .is_none_or(|total| total > 100000)
        || m.expected_counts.is_empty()
        || m.expected_counts.len() > KINDS.len()
        || m.expected_counts
            .iter()
            .any(|(k, n)| !KINDS.contains(&k.as_str()) || *n > 100000)
        || !matches!(
            m.consistency.as_str(),
            "read_only_export" | "transactional_export"
        )
        || m.limitations.len() > 50
        || m.limitations.iter().any(|x| x.len() > 1000)
    {
        return Err(Error::Invalid("declare bounded counts for supported source kinds and an explicit export consistency boundary"));
    }
    let id = Uuid::new_v4();
    let mut tx = db(&s)?.begin().await?;
    sqlx::query(
        "INSERT INTO migration_jobs (id,tenant_id,source_instance,manifest) VALUES ($1,$2,$3,$4)",
    )
    .bind(id)
    .bind(a.tenant_id)
    .bind(&m.source_instance)
    .bind(json!(m))
    .execute(&mut *tx)
    .await?;
    crate::postgres::audit(&mut tx, &a, "migration.create", id).await?;
    let j = lock(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(Json(view(&j)))
}
async fn status(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let mut tx = db(&s)?.begin().await?;
    let j = lock(&mut tx, &a, id).await?;
    Ok(Json(view(&j)))
}
async fn stage(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    Json(b): Json<Batch>,
) -> Result<Json<Value>> {
    if b.items.is_empty() || b.items.len() > 50 {
        return Err(Error::Invalid("stage between 1 and 50 records per request"));
    }
    let mut tx = db(&s)?.begin().await?;
    let j = lock(&mut tx, &a, id).await?;
    if j.status != "collecting" {
        return Err(Error::Conflict(
            "staging is closed; create a new snapshot job",
        ));
    }
    let manifest: Manifest = serde_json::from_value(j.manifest)
        .map_err(|_| Error::Invalid("invalid stored manifest"))?;
    for item in &b.items {
        text(&item.source_id, 200)?;
        if item.source_id.trim() != item.source_id
            || !manifest.expected_counts.contains_key(&item.kind)
            || !item.data.is_object()
            || !item.source_data.is_object()
        {
            return Err(Error::Invalid(
                "record kind must be declared and payloads must be objects",
            ));
        }
        if let Some(ref p) = item.patient_source_id {
            text(p, 200)?;
        }
        if item.kind == "edi_acknowledgment" && item.source_data["format"] == "claimmd_status" {
            let raw = item.source_data["original_text"]
                .as_str()
                .ok_or(Error::Invalid(
                    "structured provider evidence requires original JSON",
                ))?;
            let parsed: Value = serde_json::from_str(raw)
                .map_err(|_| Error::Invalid("invalid structured provider evidence"))?;
            if raw.len() > 48000
                || contains_credentials(&parsed)
                || parsed["pcn"].as_str().is_none_or(str::is_empty)
            {
                return Err(Error::Invalid(
                    "structured provider evidence must identify one claim and exclude credentials",
                ));
            }
        }
        if contains_credentials(&item.source_data) || contains_credentials(&item.data) {
            return Err(Error::Invalid(
                "exclude source authentication credentials from clinical migration packages",
            ));
        }
        let digest = crate::oauth::hash(
            &serde_json::to_string(item).map_err(|_| Error::Invalid("invalid record"))?,
        );
        let old: Option<String> = sqlx::query_scalar(
            "SELECT digest FROM migration_items WHERE job_id=$1 AND kind=$2 AND source_id=$3",
        )
        .bind(id)
        .bind(&item.kind)
        .bind(&item.source_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(old) = old {
            if old != digest {
                return Err(Error::Conflict(
                    "source record changed inside the snapshot; create a fresh export",
                ));
            }
            continue;
        }
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM migration_items WHERE job_id=$1 AND kind=$2")
                .bind(id)
                .bind(&item.kind)
                .fetch_one(&mut *tx)
                .await?;
        if count as u64 >= manifest.expected_counts[&item.kind] {
            return Err(Error::Conflict(
                "staged count exceeds the declared source count",
            ));
        }
        sqlx::query("INSERT INTO migration_items (tenant_id,job_id,kind,source_id,patient_source_id,data,source_data,digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(a.tenant_id).bind(id).bind(&item.kind).bind(&item.source_id).bind(&item.patient_source_id).bind(&item.data).bind(&item.source_data).bind(digest).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE migration_jobs SET version=version+1 WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    crate::postgres::audit(&mut tx, &a, "migration.stage", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"accepted":b.items.len()})))
}

async fn items(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<Vec<Item>> {
    Ok(sqlx::query_as("SELECT kind,source_id,patient_source_id,data,source_data FROM migration_items WHERE job_id=$1 ORDER BY kind,source_id").bind(id).fetch_all(&mut **tx).await?)
}
fn patient(item: &Item) -> Result<NewPatient> {
    let p: NewPatient = serde_json::from_value(item.data.clone()).map_err(|_| {
        Error::Invalid("patient mapping requires mrn, given_name, family_name and birth_date")
    })?;
    text(&p.mrn, 64)?;
    text(&p.given_name, 100)?;
    text(&p.family_name, 100)?;
    if p.mrn.trim() != p.mrn
        || p.given_name.trim() != p.given_name
        || p.family_name.trim() != p.family_name
        || p.birth_date > Utc::now().date_naive()
        || p.birth_date.year() < 1800
    {
        return Err(Error::Invalid("invalid patient demographics"));
    }
    Ok(p)
}
async fn inspect(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    j: &Job,
    records: &[Item],
) -> Result<Value> {
    let m: Manifest = serde_json::from_value(j.manifest.clone())
        .map_err(|_| Error::Invalid("invalid stored manifest"))?;
    let mut counts = BTreeMap::<String, u64>::new();
    let mut errors = Vec::new();
    let mut patients = HashMap::new();
    let mut mrns = HashMap::new();
    for r in records {
        if !matches!(
            r.kind.as_str(),
            "patient"
                | "insurance_company"
                | "remittance"
                | "x12_partner"
                | "edi_acknowledgment"
                | "facility"
                | "practitioner"
                | "user"
                | "organization"
                | "drug"
                | "code"
                | "list"
                | "product"
                | "version"
        ) && r.patient_source_id.is_none()
        {
            errors.push(
                json!({"kind":r.kind,"source_id":r.source_id,"error":"patient_reference_required"}),
            );
        }
        *counts.entry(r.kind.clone()).or_default() += 1;
        if r.kind == "patient" {
            match patient(r) {
            Ok(p)=>{if mrns.insert(p.mrn.clone(),r.source_id.clone()).is_some() {errors.push(json!({"kind":r.kind,"source_id":r.source_id,"error":"duplicate_mrn_in_export"}));}patients.insert(r.source_id.clone(),p);},
            Err(_)=>errors.push(json!({"kind":r.kind,"source_id":r.source_id,"error":"invalid_patient_mapping"})),
        }
        }
    }
    let source_orders: HashMap<&str, &Item> = records
        .iter()
        .filter(|r| r.kind == "lab_order")
        .map(|r| (r.source_id.as_str(), r))
        .collect();
    for r in records.iter().filter(|r| r.kind == "lab_result") {
        if let Some(order_id) = r
            .source_data
            .get("source_order_id")
            .and_then(|v| v.as_str())
        {
            if let Some(order) = source_orders.get(order_id) {
                if order.patient_source_id != r.patient_source_id {
                    errors.push(json!({"kind":r.kind,"source_id":r.source_id,"error":"lab_order_patient_mismatch"}));
                }
            } else {
                let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM historical_records h JOIN source_identifiers i ON i.tenant_id=h.tenant_id AND i.target_id=h.id JOIN source_identifiers p ON p.tenant_id=h.tenant_id AND p.target_id=h.patient_id AND p.kind='patient' WHERE h.tenant_id=$1 AND i.source_instance=$2 AND i.kind='lab_order' AND i.source_id=$3 AND p.source_instance=$2 AND p.source_id=$4)").bind(a.tenant_id).bind(&j.source_instance).bind(order_id).bind(&r.patient_source_id).fetch_one(&mut **tx).await?;
                if !valid {
                    errors.push(json!({"kind":r.kind,"source_id":r.source_id,"error":"unmapped_lab_order_reference"}));
                }
            }
        }
    }
    for (kind, expected) in &m.expected_counts {
        if counts.get(kind).copied().unwrap_or(0) != *expected {
            errors.push(json!({"kind":kind,"error":"source_count_mismatch","expected":expected,"received":counts.get(kind).copied().unwrap_or(0)}));
        }
    }
    for r in records {
        let digest = crate::oauth::hash(
            &serde_json::to_string(r).map_err(|_| Error::Invalid("invalid staged record"))?,
        );
        let mapped:Option<(Uuid,String)>=sqlx::query_as("SELECT target_id,source_digest FROM source_identifiers WHERE tenant_id=$1 AND source_instance=$2 AND kind=$3 AND source_id=$4")
            .bind(a.tenant_id).bind(&j.source_instance).bind(&r.kind).bind(&r.source_id).fetch_optional(&mut **tx).await?;
        if mapped.as_ref().is_some_and(|x| x.1 != digest) {
            errors.push(json!({"kind":r.kind,"source_id":r.source_id,"error":"source_changed_since_prior_import"}));
        }
        if r.kind == "patient" && mapped.is_none() {
            if let Some(p) = patients.get(&r.source_id) {
                let exists: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND mrn=$2)",
                )
                .bind(a.tenant_id)
                .bind(&p.mrn)
                .fetch_one(&mut **tx)
                .await?;
                if exists {
                    errors.push(json!({"kind":r.kind,"source_id":r.source_id,"error":"mrn_collision_requires_identity_review"}));
                }
            }
        }
        if let Some(ref source) = r.patient_source_id {
            if !patients.contains_key(source) {
                let found:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM source_identifiers WHERE tenant_id=$1 AND source_instance=$2 AND kind='patient' AND source_id=$3)").bind(a.tenant_id).bind(&j.source_instance).bind(source).fetch_one(&mut **tx).await?;
                if !found {
                    errors.push(json!({"kind":r.kind,"source_id":r.source_id,"error":"unmapped_patient_reference"}));
                }
            }
        }
    }
    let digest = crate::oauth::hash(
        &serde_json::to_string(&(j.manifest.clone(), records))
            .map_err(|_| Error::Invalid("invalid snapshot"))?,
    );
    Ok(
        json!({"counts":counts,"errors":errors,"digest":digest,"ready_to_import":errors.is_empty(),"native_mapped_kinds":["patient"],"clinician_reconciliation_kinds":["medical_problem","allergy","medication"],"staff_reconciliation_kinds":["appointment","insurance","billing","claim","remittance","edi_acknowledgment"],"owner_reconciliation_kinds":["insurance_company","x12_partner"],"historically_preserved_kinds":counts.keys().filter(|k|k.as_str()!="patient").collect::<Vec<_>>(),"limitations":m.limitations,"cutover_allowed":false}),
    )
}
async fn reconcile(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let mut tx = db(&s)?.begin().await?;
    let j = lock(&mut tx, &a, id).await?;
    if j.status == "imported" {
        return Err(Error::Conflict("snapshot already imported"));
    }
    let records = items(&mut tx, id).await?;
    let report = inspect(&mut tx, &a, &j, &records).await?;
    sqlx::query("UPDATE migration_jobs SET report=$2,digest=$3,status=$4 WHERE id=$1")
        .bind(id)
        .bind(&report)
        .bind(report["digest"].as_str())
        .bind(if report["ready_to_import"] == true {
            "reconciled"
        } else {
            "collecting"
        })
        .execute(&mut *tx)
        .await?;
    crate::postgres::audit(&mut tx, &a, "migration.reconcile", id).await?;
    tx.commit().await?;
    Ok(Json(report))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Commit {
    pub digest: String,
}
async fn commit(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    Json(input): Json<Commit>,
) -> Result<Json<Value>> {
    let mut tx = db(&s)?.begin().await?;
    let j = lock(&mut tx, &a, id).await?;
    if j.status == "imported" && j.digest.as_deref() == Some(input.digest.as_str()) {
        return Ok(Json(view(&j)));
    }
    if j.status != "reconciled" || j.digest.as_deref() != Some(input.digest.as_str()) {
        return Err(Error::Conflict(
            "reconcile the current complete snapshot before importing",
        ));
    }
    // Serialize imports for the tenant; recheck existing mappings/collisions at commit.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,2))")
        .bind(a.tenant_id.to_string())
        .execute(&mut *tx)
        .await?;
    let records = items(&mut tx, id).await?;
    let report = inspect(&mut tx, &a, &j, &records).await?;
    if report["ready_to_import"] != true {
        return Err(Error::Conflict(
            "source mappings changed; reconcile a fresh snapshot",
        ));
    }
    let mut ordered: Vec<_> = records.iter().collect();
    ordered.sort_by_key(|r| r.kind != "patient");
    for r in ordered {
        let mapped:Option<Uuid>=sqlx::query_scalar("SELECT target_id FROM source_identifiers WHERE tenant_id=$1 AND source_instance=$2 AND kind=$3 AND source_id=$4")
            .bind(a.tenant_id).bind(&j.source_instance).bind(&r.kind).bind(&r.source_id).fetch_optional(&mut *tx).await?;
        if mapped.is_some() {
            continue;
        }
        let target = Uuid::new_v4();
        let digest = crate::oauth::hash(
            &serde_json::to_string(r).map_err(|_| Error::Invalid("invalid snapshot"))?,
        );
        if r.kind == "patient" {
            let p = patient(r)?;
            let registered: crate::model::Patient = sqlx::query_as("INSERT INTO patients (tenant_id,id,mrn,given_name,family_name,birth_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,mrn,given_name,family_name,birth_date").bind(a.tenant_id).bind(target).bind(p.mrn).bind(p.given_name).bind(p.family_name).bind(p.birth_date).fetch_one(&mut *tx).await?;
            crate::patient_identity::record_initial(
                &mut tx,
                &a,
                &registered,
                "Patient registered from reviewed source import",
            )
            .await?;
        } else {
            let patient_id: Option<Uuid> = if let Some(ref p) = r.patient_source_id {
                sqlx::query_scalar("SELECT target_id FROM source_identifiers WHERE tenant_id=$1 AND source_instance=$2 AND kind='patient' AND source_id=$3").bind(a.tenant_id).bind(&j.source_instance).bind(p).fetch_optional(&mut *tx).await?
            } else {
                None
            };
            if r.patient_source_id.is_some() && patient_id.is_none() {
                return Err(Error::Conflict("patient reference was not imported"));
            }
            sqlx::query("INSERT INTO historical_records (id,tenant_id,patient_id,job_id,kind,source_instance,source_id,data,source_data,source_digest,imported_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
                .bind(target).bind(a.tenant_id).bind(patient_id).bind(id).bind(&r.kind).bind(&j.source_instance).bind(&r.source_id).bind(&r.data).bind(&r.source_data).bind(&digest).bind(a.sub).execute(&mut *tx).await?;
            if let Some(p) = patient_id {
                let k = match r.kind.as_str() {
                    "medical_problem" => Some("problem"),
                    "allergy" => Some("allergy"),
                    "medication" => Some("medication"),
                    _ => None,
                };
                if let Some(k) = k {
                    crate::clinical::list_lock(&mut tx, &a, p, k).await?;
                    crate::clinical::invalidate(&mut tx, &a, p, k).await?;
                }
            }
        }
        sqlx::query("INSERT INTO source_identifiers (tenant_id,source_instance,kind,source_id,target_id,source_digest) VALUES ($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(&j.source_instance).bind(&r.kind).bind(&r.source_id).bind(target).bind(digest).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE migration_jobs SET status='imported',imported_at=now() WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    crate::postgres::audit(&mut tx, &a, "migration.import", id).await?;
    let j = lock(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(Json(view(&j)))
}
async fn history(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'kind',kind,'source_instance',source_instance,'source_id',source_id,'data',data,'source_data',source_data,'source_digest',source_digest,'imported_at',imported_at,'signature_origin','external_unverified') FROM historical_records WHERE tenant_id=$1 AND patient_id=$2 ORDER BY imported_at,id LIMIT 100")
        .bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "history.read", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":rows,"release_policy":"staff_only_pending_review"}),
    ))
}
