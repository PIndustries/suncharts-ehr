// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Local USD billing records only. Posting does not submit a claim or move money.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    model::text,
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
#[path = "billing/overview.rs"]
mod overview;
#[path = "billing/payment_history.rs"]
mod payment_history;

fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn write(a: &Actor) -> Result<()> {
    a.scheduling()
}
fn owner(a: &Actor) -> Result<()> {
    if matches!(a.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
fn bounded(s: &str, n: usize) -> Result<()> {
    if s.chars().count() > n {
        Err(Error::Invalid("billing text too long"))
    } else {
        Ok(())
    }
}
fn choice(s: &str, values: &[&str]) -> Result<()> {
    if values.contains(&s) {
        Ok(())
    } else {
        Err(Error::Invalid("unsupported billing classification"))
    }
}
fn digest<T: Serialize>(p: &T) -> Result<String> {
    Ok(crate::oauth::hash(
        &serde_json::to_string(p).map_err(|_| Error::Invalid("invalid billing request"))?,
    ))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PayerContent {
    pub name: String,
    pub payer_code: String,
    pub phone: String,
    pub address: String,
    pub active: bool,
}
impl PayerContent {
    fn validate(&self) -> Result<()> {
        text(&self.name, 200)?;
        bounded(&self.payer_code, 100)?;
        bounded(&self.phone, 50)?;
        bounded(&self.address, 1000)
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CoverageContent {
    pub payer_id: Uuid,
    pub priority: String,
    pub status: String,
    pub member_id: String,
    pub group_number: String,
    pub plan_name: String,
    pub subscriber_name: String,
    pub subscriber_birth_date: Option<NaiveDate>,
    pub relationship: String,
    pub effective_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    pub copay_cents: Option<i64>,
    pub verification: String,
    pub notes: String,
}
impl CoverageContent {
    fn validate(&self) -> Result<()> {
        text(&self.member_id, 150)?;
        text(&self.subscriber_name, 200)?;
        choice(&self.priority, &["primary", "secondary", "tertiary"])?;
        choice(&self.status, &["active", "inactive", "entered_in_error"])?;
        choice(&self.relationship, &["self", "spouse", "child", "other"])?;
        choice(&self.verification, &["unverified", "manually_verified"])?;
        bounded(&self.group_number, 150)?;
        bounded(&self.plan_name, 200)?;
        bounded(&self.notes, 2000)?;
        if self.end_date.is_some_and(|d| d < self.effective_date)
            || self
                .subscriber_birth_date
                .is_some_and(|d| d > Utc::now().date_naive())
            || self
                .copay_cents
                .is_some_and(|c| !(0..=100000000).contains(&c))
        {
            return Err(Error::Invalid("invalid coverage dates or copay"));
        }
        Ok(())
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChargeLine {
    pub code_system: String,
    pub code: String,
    pub description: String,
    pub modifiers: String,
    pub units: i64,
    pub amount_cents: i64,
    pub diagnosis_codes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_release_id: Option<Uuid>,
    // Accepted on stored rows for revision preservation, but always replaced
    // from the trusted catalog on create/edit, never trusted from the caller.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_snapshot: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fee_schedule_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fee_entry_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fee_snapshot: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fee_override_reason: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AccountContent {
    pub visit_id: Option<Uuid>,
    pub coverage_id: Option<Uuid>,
    pub service_date: NaiveDate,
    pub currency: String,
    pub lines: Vec<ChargeLine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fee_context: Option<crate::fees::FeeContext>,
    pub notes: String,
}
impl AccountContent {
    fn total(&self) -> Result<i64> {
        if self.currency != "USD"
            || self.lines.is_empty()
            || self.lines.len() > 100
            || self.service_date > Utc::now().date_naive()
        {
            return Err(Error::Invalid(
                "USD billing requires 1 to 100 charge lines and a nonfuture service date",
            ));
        }
        bounded(&self.notes, 2000)?;
        let mut total = 0i64;
        for l in &self.lines {
            text(&l.code_system, 100)?;
            text(&l.code, 100)?;
            text(&l.description, 10000)?;
            bounded(&l.modifiers, 100)?;
            if !(1..=1000).contains(&l.units)
                || !(1..=100000000).contains(&l.amount_cents)
                || l.diagnosis_codes.len() > 12
            {
                return Err(Error::Invalid(
                    "invalid charge units, line total or diagnosis count",
                ));
            }
            for d in &l.diagnosis_codes {
                text(d, 100)?;
            }
            total = total
                .checked_add(l.amount_cents)
                .ok_or(Error::Invalid("billing total overflow"))?;
        }
        if total > 1000000000 {
            return Err(Error::Invalid("billing total exceeds preview limit"));
        }
        Ok(total)
    }
}
async fn resolve_charge_catalogs(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    content: &mut AccountContent,
) -> Result<()> {
    for line in &mut content.lines {
        line.catalog_snapshot = None;
        if let Some(id) = line.catalog_release_id {
            let snapshot =
                crate::terminology::resolve_code(tx, a, id, &line.code, content.service_date, true)
                    .await?;
            if !matches!(snapshot["system"].as_str(), Some("CPT" | "HCPCS"))
                || snapshot["system"].as_str() != Some(line.code_system.as_str())
            {
                return Err(Error::Invalid(
                    "charge code must match its selected CPT or HCPCS catalog",
                ));
            }
            line.code = snapshot["code"]
                .as_str()
                .ok_or(Error::Invalid("catalog code is missing"))?
                .to_string();
            line.description = snapshot["display"]
                .as_str()
                .ok_or(Error::Invalid("catalog description is missing"))?
                .to_string();
            line.catalog_snapshot = Some(snapshot);
        }
    }
    Ok(())
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct New<T> {
    request_id: Uuid,
    source_history_id: Option<Uuid>,
    content: T,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Edit<T> {
    content: T,
    reason: String,
}
#[derive(Serialize, sqlx::FromRow)]
struct Entity {
    id: Uuid,
    content: Value,
    version: i64,
    source_history_id: Option<Uuid>,
}
#[derive(Serialize, sqlx::FromRow)]
pub(crate) struct Account {
    pub(crate) diagnosis_snapshot: Option<Value>,
    pub(crate) id: Uuid,
    pub(crate) patient_id: Uuid,
    pub(crate) content: Value,
    pub(crate) status: String,
    pub(crate) version: i64,
    pub(crate) total_cents: i64,
    pub(crate) coverage_snapshot: Option<Value>,
    pub(crate) source_history_id: Option<Uuid>,
}
async fn patient(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: Uuid) -> Result<()> {
    let yes: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(p)
            .fetch_one(&mut **tx)
            .await?;
    if yes {
        Ok(())
    } else {
        Err(Error::NotFound)
    }
}
async fn source(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Option<Uuid>,
    id: Uuid,
    kind: &str,
) -> Result<()> {
    let yes:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM historical_records WHERE tenant_id=$1 AND id=$2 AND patient_id IS NOT DISTINCT FROM $3 AND kind=$4)").bind(a.tenant_id).bind(id).bind(p).bind(kind).fetch_one(&mut **tx).await?;
    if yes {
        Ok(())
    } else {
        Err(Error::NotFound)
    }
}
pub(crate) async fn tenant_lock(tx: &mut Transaction<'_, Postgres>, a: &Actor) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("billing:{}", a.tenant_id))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
pub(crate) async fn account_row(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    id: Uuid,
) -> Result<Account> {
    sqlx::query_as(
        "SELECT * FROM billing_accounts WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(p)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::NotFound)
}
pub(crate) async fn account_revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    id: Uuid,
    reason: &str,
) -> Result<Account> {
    let row = account_row(tx, a, p, id).await?;
    sqlx::query("INSERT INTO billing_account_revisions (tenant_id,account_id,version,snapshot,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(row.version).bind(json!(row)).bind(a.sub).bind(reason).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "billing.account_change", id).await?;
    Ok(row)
}
async fn payer_row(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Entity> {
    sqlx::query_as("SELECT * FROM ehr_payers WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn coverage_row(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    id: Uuid,
) -> Result<Entity> {
    sqlx::query_as("SELECT * FROM insurance_coverages WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE").bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn entity_revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    row: &Entity,
    reason: &str,
    payer: bool,
) -> Result<()> {
    let q = if payer {
        "INSERT INTO payer_revisions (tenant_id,payer_id,version,snapshot,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6)"
    } else {
        "INSERT INTO coverage_revisions (tenant_id,coverage_id,version,snapshot,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6)"
    };
    sqlx::query(q)
        .bind(a.tenant_id)
        .bind(row.id)
        .bind(row.version)
        .bind(json!(row))
        .bind(a.sub)
        .bind(reason)
        .execute(&mut **tx)
        .await?;
    crate::postgres::audit(
        tx,
        a,
        if payer {
            "billing.payer_change"
        } else {
            "insurance.coverage_change"
        },
        row.id,
    )
    .await
}
async fn retry(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    request: Uuid,
    hash: &str,
    kind: &str,
) -> Result<Option<Uuid>> {
    let q = match kind {
        "payer" => "SELECT id,creation_hash FROM ehr_payers WHERE tenant_id=$1 AND request_id=$2",
        "coverage" => {
            "SELECT id,creation_hash FROM insurance_coverages WHERE tenant_id=$1 AND request_id=$2"
        }
        _ => "SELECT id,creation_hash FROM billing_accounts WHERE tenant_id=$1 AND request_id=$2",
    };
    let old: Option<(Uuid, String)> = sqlx::query_as(q)
        .bind(a.tenant_id)
        .bind(request)
        .fetch_optional(&mut **tx)
        .await?;
    if let Some((id, prior)) = old {
        if prior != hash {
            return Err(Error::Conflict(
                "request ID reused with different billing data",
            ));
        }
        Ok(Some(id))
    } else {
        Ok(None)
    }
}
async fn coverage_valid(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    c: &CoverageContent,
    except: Option<Uuid>,
) -> Result<()> {
    let payer = payer_row(tx, a, c.payer_id).await?;
    if c.status == "active" && payer.content["active"] != true {
        return Err(Error::Conflict("active coverage requires an active payer"));
    }
    if c.status == "active" {
        let overlap:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM insurance_coverages WHERE tenant_id=$1 AND patient_id=$2 AND content->>'status'='active' AND content->>'priority'=$3 AND (content->>'effective_date')::date<=coalesce($5::date,'infinity'::date) AND coalesce((content->>'end_date')::date,'infinity'::date)>=$4 AND ($6::uuid IS NULL OR id<>$6))").bind(a.tenant_id).bind(p).bind(&c.priority).bind(c.effective_date).bind(c.end_date).bind(except).fetch_one(&mut **tx).await?;
        if overlap {
            return Err(Error::Conflict("active coverage at this priority overlaps; end or reprioritize the existing policy"));
        }
    }
    Ok(())
}
async fn account_links(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    c: &AccountContent,
    history: Option<Uuid>,
    posting: bool,
) -> Result<Option<Value>> {
    if let Some(v) = c.visit_id {
        let status: Option<String> = sqlx::query_scalar(
            "SELECT status FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND id=$3",
        )
        .bind(a.tenant_id)
        .bind(p)
        .bind(v)
        .fetch_optional(&mut **tx)
        .await?;
        match status {
            None => return Err(Error::NotFound),
            Some(s) if posting && s != "signed" => {
                return Err(Error::Conflict(
                    "sign the linked visit before posting billing",
                ))
            }
            _ => {}
        }
    } else if history.is_none() {
        return Err(Error::Invalid(
            "link a native visit or a reviewed billing source record",
        ));
    }
    if let Some(id) = history {
        source(tx, a, Some(p), id, "billing").await?;
    }
    if let Some(id) = c.coverage_id {
        let coverage = coverage_row(tx, a, p, id).await?;
        let cv: CoverageContent = serde_json::from_value(coverage.content.clone())
            .map_err(|_| Error::Invalid("invalid stored coverage"))?;
        if cv.status != "active"
            || cv.effective_date > c.service_date
            || cv.end_date.is_some_and(|d| d < c.service_date)
        {
            return Err(Error::Conflict(
                "choose coverage effective on the service date",
            ));
        }
        let payer = payer_row(tx, a, cv.payer_id).await?;
        if payer.content["active"] != true {
            return Err(Error::Conflict("payer is inactive"));
        }
        return Ok(Some(
            json!({"coverage":coverage,"payer":payer,"verification_policy":"Manual record only; no electronic eligibility check"}),
        ));
    }
    Ok(None)
}
pub fn router() -> Router<State> {
    Router::new()
        .merge(overview::router())
        .merge(payment_history::router())
        .route("/api/v1/billing/payers", get(payers).post(new_payer))
        .route(
            "/api/v1/patients/{p}/billing/accounts/{id}/invoices",
            get(patient_invoices).post(new_patient_invoice),
        )
        .route(
            "/api/v1/billing/payers/{id}",
            axum::routing::put(edit_payer),
        )
        .route("/api/v1/billing/payers/{id}/history", get(payer_history))
        .route("/api/v1/billing/worklist", get(worklist))
        .route("/api/v1/billing/payer-sources", get(payer_sources))
        .route("/api/v1/patients/{p}/billing", get(workspace))
        .route("/api/v1/patients/{p}/coverages", post(new_coverage))
        .route(
            "/api/v1/patients/{p}/coverages/{id}",
            axum::routing::put(edit_coverage),
        )
        .route(
            "/api/v1/patients/{p}/coverages/{id}/history",
            get(coverage_history),
        )
        .route("/api/v1/patients/{p}/billing/copays", post(record_copay))
        .route(
            "/api/v1/patients/{p}/billing/copays/{id}/void",
            post(void_copay),
        )
        .route(
            "/api/v1/patients/{p}/billing/accounts/{id}/copays/apply",
            post(apply_recorded_copays),
        )
        .route("/api/v1/patients/{p}/billing/accounts", post(new_account))
        .route(
            "/api/v1/patients/{p}/billing/accounts/{id}",
            axum::routing::put(edit_account),
        )
        .route(
            "/api/v1/patients/{p}/billing/accounts/{id}/diagnoses",
            axum::routing::put(link_account_diagnoses),
        )
        .route(
            "/api/v1/patients/{p}/billing/accounts/{id}/actions",
            post(account_action),
        )
        .route(
            "/api/v1/patients/{p}/billing/accounts/{id}/history",
            get(account_history),
        )
        .route(
            "/api/v1/patients/{p}/billing/accounts/{id}/entries",
            post(new_entry),
        )
        .route(
            "/api/v1/patients/{p}/history/{id}/billing-mapping",
            get(mapping),
        )
}
async fn payers(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let items: Vec<Entity> = sqlx::query_as(
        "SELECT * FROM ehr_payers WHERE tenant_id=$1 ORDER BY content->>'name',id LIMIT 1001",
    )
    .bind(a.tenant_id)
    .fetch_all(db(&s)?)
    .await?;
    if items.len() > 1000 {
        return Err(Error::Invalid("payer directory exceeds preview limit"));
    }
    Ok(Json(json!({"items":items})))
}
async fn new_payer(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(p): Json<New<PayerContent>>,
) -> Result<Json<Entity>> {
    owner(&a)?;
    p.content.validate()?;
    text(&p.reason, 1000)?;
    let hash = digest(&p)?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    if let Some(id) = retry(&mut tx, &a, p.request_id, &hash, "payer").await? {
        return Ok(Json(payer_row(&mut tx, &a, id).await?));
    }
    if let Some(id) = p.source_history_id {
        source(&mut tx, &a, None, id, "insurance_company").await?;
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO ehr_payers (tenant_id,id,content,request_id,creation_hash,source_history_id) VALUES ($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(json!(p.content)).bind(p.request_id).bind(hash).bind(p.source_history_id).execute(&mut *tx).await?;
    let r = payer_row(&mut tx, &a, id).await?;
    entity_revision(&mut tx, &a, &r, &p.reason, true).await?;
    tx.commit().await?;
    Ok(Json(r))
}
async fn edit_payer(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(p): Json<Edit<PayerContent>>,
) -> Result<Json<Entity>> {
    owner(&a)?;
    p.content.validate()?;
    text(&p.reason, 1000)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let old = payer_row(&mut tx, &a, id).await?;
    if old.version != version {
        return Err(Error::Conflict("payer changed; reload before saving"));
    }
    sqlx::query("UPDATE ehr_payers SET content=$3,version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .bind(json!(p.content))
        .execute(&mut *tx)
        .await?;
    let r = payer_row(&mut tx, &a, id).await?;
    entity_revision(&mut tx, &a, &r, &p.reason, true).await?;
    tx.commit().await?;
    Ok(Json(r))
}
async fn new_coverage(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(patient_id): Path<Uuid>,
    Json(p): Json<New<CoverageContent>>,
) -> Result<Json<Entity>> {
    write(&a)?;
    p.content.validate()?;
    text(&p.reason, 1000)?;
    let hash = digest(&(patient_id, &p))?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    patient(&mut tx, &a, patient_id).await?;
    if let Some(id) = retry(&mut tx, &a, p.request_id, &hash, "coverage").await? {
        return Ok(Json(coverage_row(&mut tx, &a, patient_id, id).await?));
    }
    if let Some(id) = p.source_history_id {
        source(&mut tx, &a, Some(patient_id), id, "insurance").await?;
    }
    coverage_valid(&mut tx, &a, patient_id, &p.content, None).await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO insurance_coverages (tenant_id,id,patient_id,payer_id,content,request_id,creation_hash,source_history_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)").bind(a.tenant_id).bind(id).bind(patient_id).bind(p.content.payer_id).bind(json!(p.content)).bind(p.request_id).bind(hash).bind(p.source_history_id).execute(&mut *tx).await?;
    let r = coverage_row(&mut tx, &a, patient_id, id).await?;
    entity_revision(&mut tx, &a, &r, &p.reason, false).await?;
    tx.commit().await?;
    Ok(Json(r))
}
async fn edit_coverage(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<Edit<CoverageContent>>,
) -> Result<Json<Entity>> {
    write(&a)?;
    v.content.validate()?;
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let old = coverage_row(&mut tx, &a, p, id).await?;
    if old.version != version {
        return Err(Error::Conflict("coverage changed; reload before saving"));
    }
    coverage_valid(&mut tx, &a, p, &v.content, Some(id)).await?;
    sqlx::query("UPDATE insurance_coverages SET payer_id=$3,content=$4,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(v.content.payer_id).bind(json!(v.content)).execute(&mut *tx).await?;
    let r = coverage_row(&mut tx, &a, p, id).await?;
    entity_revision(&mut tx, &a, &r, &v.reason, false).await?;
    tx.commit().await?;
    Ok(Json(r))
}
async fn new_account(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Json(mut v): Json<New<AccountContent>>,
) -> Result<Json<Account>> {
    write(&a)?;
    text(&v.reason, 1000)?;
    let total = v.content.total()?;
    let hash = digest(&(p, &v))?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    patient(&mut tx, &a, p).await?;
    if let Some(id) = retry(&mut tx, &a, v.request_id, &hash, "account").await? {
        return Ok(Json(account_row(&mut tx, &a, p, id).await?));
    }
    account_links(&mut tx, &a, p, &v.content, v.source_history_id, false).await?;
    resolve_charge_catalogs(&mut tx, &a, &mut v.content).await?;
    crate::fees::resolve(&mut tx, &a, p, &mut v.content, None).await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO billing_accounts (tenant_id,id,patient_id,visit_id,coverage_id,content,total_cents,request_id,creation_hash,source_history_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(a.tenant_id).bind(id).bind(p).bind(v.content.visit_id).bind(v.content.coverage_id).bind(json!(v.content)).bind(total).bind(v.request_id).bind(hash).bind(v.source_history_id).execute(&mut *tx).await?;
    let row = account_revision(&mut tx, &a, p, id, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(row))
}
async fn edit_account(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(mut v): Json<Edit<AccountContent>>,
) -> Result<Json<Account>> {
    write(&a)?;
    text(&v.reason, 1000)?;
    let total = v.content.total()?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let old = account_row(&mut tx, &a, p, id).await?;
    if old.version != version || old.status != "draft" {
        return Err(Error::Conflict(
            "only the current draft billing account can be edited",
        ));
    }
    resolve_charge_catalogs(&mut tx, &a, &mut v.content).await?;
    crate::fees::resolve(&mut tx, &a, p, &mut v.content, Some(&old.content)).await?;
    if old.diagnosis_snapshot.is_some()
        && (old.content["visit_id"] != json!(v.content.visit_id)
            || old.content["lines"] != json!(v.content.lines))
    {
        return Err(Error::Conflict("clear draft diagnosis links before changing the visit or charge lines; existing diagnosis codes are retained"));
    }
    account_links(&mut tx, &a, p, &v.content, old.source_history_id, false).await?;
    sqlx::query("UPDATE billing_accounts SET visit_id=$3,coverage_id=$4,content=$5,total_cents=$6,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(v.content.visit_id).bind(v.content.coverage_id).bind(json!(v.content)).bind(total).execute(&mut *tx).await?;
    let row = account_revision(&mut tx, &a, p, id, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(row))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    action: String,
    reason: String,
    #[serde(default)]
    local_only: bool,
}
async fn account_action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<Action>,
) -> Result<Json<Account>> {
    write(&a)?;
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let old = account_row(&mut tx, &a, p, id).await?;
    if old.version != version || old.status != "draft" {
        return Err(Error::Conflict(
            "posting or voiding requires the current draft version",
        ));
    }
    let content: AccountContent = serde_json::from_value(old.content)
        .map_err(|_| Error::Invalid("invalid stored billing account"))?;
    let (status, snapshot) = match v.action.as_str() {
        "post" => {
            let snapshot =
                account_links(&mut tx, &a, p, &content, old.source_history_id, true).await?;
            let missing_electronic_payer = snapshot.as_ref().is_some_and(|snapshot| {
                snapshot["payer"]["content"]["payer_code"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
            });
            if missing_electronic_payer && !v.local_only {
                return Err(Error::Invalid(
                    "add the correct Claim.MD payer ID in the payer mapping before posting, or explicitly choose local-only insurance activity",
                ));
            }
            ("posted", snapshot)
        }
        "void" => ("void", None),
        _ => return Err(Error::Invalid("choose post or void")),
    };
    sqlx::query("UPDATE billing_accounts SET status=$3,coverage_snapshot=$4,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(status).bind(snapshot).execute(&mut *tx).await?;
    if status == "posted" {
        allocate_copays(&mut tx, &a, p, id).await?;
    }
    let row = account_revision(&mut tx, &a, p, id, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(row))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    request_id: Uuid,
    kind: String,
    amount_cents: Option<i64>,
    reverses_id: Option<Uuid>,
    party: String,
    method: String,
    reference: String,
    occurred_on: NaiveDate,
    reason: String,
}
async fn new_entry(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<Entry>,
) -> Result<Json<Value>> {
    write(&a)?;
    text(&v.reason, 1000)?;
    bounded(&v.reference, 200)?;
    choice(&v.party, &["patient", "insurer", "other"])?;
    choice(&v.method, &["cash", "check", "external", "other", "none"])?;
    if v.occurred_on > Utc::now().date_naive() {
        return Err(Error::Invalid("ledger entry date cannot be in the future"));
    }
    let hash = digest(&(p, id, &v))?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let old = account_row(&mut tx, &a, p, id).await?;
    let prior: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,creation_hash FROM billing_entries WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((entry, prior)) = prior {
        if prior != hash {
            return Err(Error::Conflict(
                "request ID reused for different ledger entry",
            ));
        }
        return Ok(Json(json!({"id":entry,"account":old})));
    }
    if old.status != "posted" || old.version != version {
        return Err(Error::Conflict(
            "ledger entry requires the current posted account version",
        ));
    }
    let effect = if v.kind == "reversal" {
        if v.amount_cents.is_some() {
            return Err(Error::Invalid(
                "reversal amount is derived from the original entry",
            ));
        }
        let original = v
            .reverses_id
            .ok_or(Error::Invalid("select the entry to reverse"))?;
        let managed: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM era_posting_entries WHERE tenant_id=$1 AND entry_id=$2) OR EXISTS(SELECT 1 FROM payment_ledger_links WHERE tenant_id=$1 AND entry_id=$2) OR EXISTS(SELECT 1 FROM billing_copay_allocations x JOIN copay_checkout_attempts o ON o.tenant_id=x.tenant_id AND o.receipt_id=x.receipt_id WHERE x.tenant_id=$1 AND x.entry_id=$2) OR EXISTS(SELECT 1 FROM copay_checkout_refund_allocations WHERE tenant_id=$1 AND entry_id=$2)",
        )
        .bind(a.tenant_id)
        .bind(original)
        .fetch_one(&mut *tx)
        .await?;
        if managed {
            return Err(Error::Conflict(
                "reverse managed entries through their remittance or payment workflow",
            ));
        }
        let row:Option<(String,i64)>=sqlx::query_as("SELECT kind,effect_cents FROM billing_entries WHERE tenant_id=$1 AND account_id=$2 AND id=$3").bind(a.tenant_id).bind(id).bind(original).fetch_optional(&mut *tx).await?;
        match row {
            Some((kind, effect)) if kind != "reversal" => -effect,
            _ => {
                return Err(Error::Invalid(
                    "select an original entry on this billing account",
                ))
            }
        }
    } else {
        if v.reverses_id.is_some() {
            return Err(Error::Invalid(
                "only reversals can reference an original entry",
            ));
        }
        let amount = v
            .amount_cents
            .filter(|c| (1..=1000000000).contains(c))
            .ok_or(Error::Invalid("enter a positive integer amount in cents"))?;
        match v.kind.as_str() {
            "payment" | "adjustment_credit" => -amount,
            "adjustment_debit" => amount,
            _ => return Err(Error::Invalid("unsupported ledger entry kind")),
        }
    };
    if v.kind == "payment"
        && (v.reference.trim().is_empty()
            || v.method == "none"
            || (v.party == "insurer" && old.coverage_snapshot.is_none()))
    {
        return Err(Error::Invalid(
            "record payment evidence/method and linked coverage for insurer payments",
        ));
    }
    let prior:i64=sqlx::query_scalar("SELECT coalesce(sum(effect_cents),0)::bigint FROM billing_entries WHERE tenant_id=$1 AND account_id=$2").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
    let balance = old.total_cents + prior + effect;
    if !(0..=1000000000).contains(&balance) {
        return Err(Error::Conflict("entry would overpay the account or exceed its supported balance; reverse dependent entries first"));
    }
    if effect < 0 {
        let reserved:i64=sqlx::query_scalar("SELECT coalesce(sum(amount_cents),0)::bigint FROM payment_attempts WHERE tenant_id=$1 AND account_id=$2 AND status IN ('creating','open','needs_review') AND paid_entry_id IS NULL").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
        if balance < reserved {
            return Err(Error::Conflict("account balance is reserved by hosted checkout; expire or reconcile it before reducing the balance"));
        }
    }
    let entry = Uuid::new_v4();
    sqlx::query("INSERT INTO billing_entries (tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,reverses_id,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(a.tenant_id).bind(entry).bind(id).bind(&v.kind).bind(effect).bind(json!(v)).bind(v.request_id).bind(hash).bind(v.reverses_id).bind(a.sub).execute(&mut *tx).await?;
    sqlx::query("UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let account = account_revision(&mut tx, &a, p, id, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":entry,"account":account})))
}
async fn workspace(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    patient(&mut tx, &a, p).await?;
    let coverages:Vec<Entity>=sqlx::query_as("SELECT * FROM insurance_coverages WHERE tenant_id=$1 AND patient_id=$2 ORDER BY content->>'priority',id LIMIT 1001").bind(a.tenant_id).bind(p).fetch_all(&mut *tx).await?;
    let accounts:Vec<Account>=sqlx::query_as("SELECT * FROM billing_accounts WHERE tenant_id=$1 AND patient_id=$2 ORDER BY created_at DESC,id LIMIT 1001").bind(a.tenant_id).bind(p).fetch_all(&mut *tx).await?;
    let entries:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id'-'creation_hash'-'request_id' FROM billing_entries e JOIN billing_accounts b ON b.tenant_id=e.tenant_id AND b.id=e.account_id WHERE b.tenant_id=$1 AND b.patient_id=$2 ORDER BY e.created_at,e.id LIMIT 10001").bind(a.tenant_id).bind(p).fetch_all(&mut *tx).await?;
    if coverages.len() > 1000 || accounts.len() > 1000 || entries.len() > 10000 {
        return Err(Error::Invalid(
            "patient billing workspace exceeds preview limit; use an archival review workflow",
        ));
    }
    let copays = copay_rows(&mut tx, &a, p, None).await?;
    if copays.len() > 1000 {
        return Err(Error::Invalid(
            "patient copay history exceeds preview limit; use an archival review workflow",
        ));
    }
    crate::postgres::audit(&mut tx, &a, "billing.workspace_read", p).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"coverages":coverages,"accounts":accounts,"entries":entries,"copays":copays,"currency":"USD","payment_policy":"Recorded payments only; no funds transferred","claims_policy":"Local accounts only; no claim submitted"}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Queue {
    status: Option<String>,
    after: Option<Uuid>,
}
async fn worklist(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<Queue>,
) -> Result<Json<Value>> {
    a.staff()?;
    if let Some(status) = &q.status {
        choice(status, &["draft", "posted", "void"])?;
    }
    let mut tx = db(&s)?.begin().await?;
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',b.id,'patient_id',b.patient_id,'patient_name',p.family_name||', '||p.given_name,'mrn',p.mrn,'service_date',b.content->>'service_date','status',b.status,'version',b.version,'total_cents',b.total_cents,'balance_cents',CASE WHEN b.status='posted' THEN b.total_cents+coalesce((SELECT sum(effect_cents) FROM billing_entries e WHERE e.tenant_id=b.tenant_id AND e.account_id=b.id),0) ELSE NULL END,'payer_name',b.coverage_snapshot->'payer'->'content'->>'name','source_history_id',b.source_history_id) FROM billing_accounts b JOIN patients p ON p.tenant_id=b.tenant_id AND p.id=b.patient_id WHERE b.tenant_id=$1 AND ($2::text IS NULL OR b.status=$2) AND ($3::uuid IS NULL OR b.id>$3) ORDER BY b.id LIMIT 101").bind(a.tenant_id).bind(q.status).bind(q.after).fetch_all(&mut *tx).await?;
    let next = if items.len() > 100 {
        items.truncate(100);
        items.last().map(|i| i["id"].clone())
    } else {
        None
    };
    crate::postgres::audit(&mut tx, &a, "billing.worklist_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":items,"next_cursor":next,"currency":"USD","claims_policy":"No claims submitted by this local ledger"}),
    ))
}
async fn payer_history(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    payer_row(&mut tx, &a, id).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('version',version,'snapshot',snapshot,'actor_id',actor_id,'reason',reason,'created_at',created_at) FROM payer_revisions WHERE tenant_id=$1 AND payer_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "billing.payer_history", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
async fn coverage_history(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    coverage_row(&mut tx, &a, p, id).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('version',version,'snapshot',snapshot,'actor_id',actor_id,'reason',reason,'created_at',created_at) FROM coverage_revisions WHERE tenant_id=$1 AND coverage_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "insurance.history", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
async fn account_history(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    account_row(&mut tx, &a, p, id).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('version',version,'snapshot',snapshot,'actor_id',actor_id,'reason',reason,'created_at',created_at) FROM billing_account_revisions WHERE tenant_id=$1 AND account_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "billing.history", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
async fn mapping(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    write(&a)?;
    let mut tx = db(&s)?.begin().await?;
    let row:Option<(String,Value,Value)>=sqlx::query_as("SELECT kind,data,source_data FROM historical_records WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 AND kind IN ('insurance','billing','transaction')").bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut *tx).await?;
    let (kind, data, raw) = row.ok_or(Error::NotFound)?;
    let native: Option<Uuid> = if kind == "insurance" {
        sqlx::query_scalar(
            "SELECT id FROM insurance_coverages WHERE tenant_id=$1 AND source_history_id=$2",
        )
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
    } else {
        sqlx::query_scalar(
            "SELECT id FROM billing_accounts WHERE tenant_id=$1 AND source_history_id=$2",
        )
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
    };
    crate::postgres::audit(&mut tx, &a, "billing.mapping_read", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"source_history_id":id,"kind":kind,"data":data,"source_data":raw,"native_id":native,"policy":"Manual review required. Insurance is not eligibility verification; billing becomes a draft only. Transaction history never automatically moves money or posts ledger entries."}),
    ))
}

async fn payer_sources(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    owner(&a)?;
    let mut tx = db(&s)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('source_history_id',h.id,'source_instance',h.source_instance,'source_id',h.source_id,'source_data',h.source_data,'native_id',p.id) FROM historical_records h LEFT JOIN ehr_payers p ON p.tenant_id=h.tenant_id AND p.source_history_id=h.id WHERE h.tenant_id=$1 AND h.kind='insurance_company' ORDER BY h.imported_at,h.id LIMIT 1001").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    if items.len() > 1000 {
        return Err(Error::Invalid(
            "source payer directory exceeds preview limit",
        ));
    }
    crate::postgres::audit(&mut tx, &a, "billing.payer_sources", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiagnosisLineSelection {
    line_index: usize,
    diagnosis_ids: Vec<Uuid>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AccountDiagnosisSelection {
    visit_version: i64,
    lines: Vec<DiagnosisLineSelection>,
    reason: String,
}
async fn link_account_diagnoses(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(input): Json<AccountDiagnosisSelection>,
) -> Result<Json<Account>> {
    write(&a)?;
    text(&input.reason, 1000)?;
    if input.lines.len() > 100 {
        return Err(Error::Invalid(
            "at most 100 charge line selections are supported",
        ));
    }
    let expected = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let old = account_row(&mut tx, &a, p, id).await?;
    if old.version != expected || old.status != "draft" {
        return Err(Error::Conflict(
            "only the current draft account can change diagnosis links",
        ));
    }
    let mut content: AccountContent = serde_json::from_value(old.content.clone())
        .map_err(|_| Error::Invalid("invalid stored billing account"))?;
    let visit = content
        .visit_id
        .ok_or(Error::Invalid("link the account to a native visit first"))?;
    // Even clearing validates encounter context; there is no silent rebase.
    crate::labs::diagnosis_snapshot(&mut tx, &a, p, visit, input.visit_version, &[]).await?;
    let mut seen = std::collections::HashSet::new();
    let mut snapshots = Vec::new();
    for selection in &input.lines {
        if !seen.insert(selection.line_index)
            || selection.line_index >= content.lines.len()
            || selection.diagnosis_ids.len() > 12
        {
            return Err(Error::Invalid(
                "choose distinct existing charge lines and at most 12 diagnoses per line",
            ));
        }
        let snapshot = crate::labs::diagnosis_snapshot(
            &mut tx,
            &a,
            p,
            visit,
            input.visit_version,
            &selection.diagnosis_ids,
        )
        .await?;
        let line = &mut content.lines[selection.line_index];
        for d in snapshot["diagnoses"]
            .as_array()
            .ok_or(Error::Invalid("invalid encounter diagnoses"))?
        {
            let code = d["code"]
                .as_str()
                .ok_or(Error::Invalid("invalid encounter diagnosis code"))?;
            if !line
                .diagnosis_codes
                .iter()
                .any(|old| old.eq_ignore_ascii_case(code))
            {
                line.diagnosis_codes.push(code.into());
            }
        }
        if !selection.diagnosis_ids.is_empty() {
            snapshots
                .push(json!({"line_index":selection.line_index,"diagnoses":snapshot["diagnoses"]}));
        }
    }
    content.total()?;
    let snapshot = if snapshots.is_empty() {
        None
    } else {
        Some(
            json!({"visit_id":visit,"visit_version":input.visit_version,"code_system":"http://hl7.org/fhir/sid/icd-10-cm","lines":snapshots}),
        )
    };
    sqlx::query("UPDATE billing_accounts SET content=$3,diagnosis_snapshot=$4,version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id).bind(id).bind(json!(content)).bind(snapshot).execute(&mut *tx).await?;
    let row = account_revision(&mut tx, &a, p, id, &input.reason).await?;
    tx.commit().await?;
    Ok(Json(row))
}

// Credits include all patient ledger activity; payments exclude nonpayment adjustments.
pub(crate) async fn patient_ledger_totals(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    account: Uuid,
) -> Result<(i64, i64)> {
    Ok(sqlx::query_as("SELECT coalesce(-sum(e.effect_cents),0)::bigint,coalesce(-sum(e.effect_cents) FILTER (WHERE e.kind='payment' OR (e.kind='reversal' AND original.kind='payment') OR (e.kind='adjustment_debit' AND (e.content->>'managed_payment_id' IS NOT NULL OR e.content->>'hosted_copay_operation_id' IS NOT NULL))),0)::bigint FROM billing_entries e LEFT JOIN billing_entries original ON original.tenant_id=e.tenant_id AND original.account_id=e.account_id AND original.id=e.reverses_id WHERE e.tenant_id=$1 AND e.account_id=$2 AND CASE WHEN e.kind='reversal' THEN original.content->>'party' ELSE e.content->>'party' END='patient'")
        .bind(tenant).bind(account).fetch_one(&mut **tx).await?)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PatientInvoiceInput {
    request_id: Uuid,
    responsibility_cents: i64,
    reason: String,
}
async fn patient_invoices(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    account_row(&mut tx, &a, p, id).await?;
    let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(i)-'tenant_id'-'creation_hash'-'request_id' FROM patient_invoice_snapshots i WHERE tenant_id=$1 AND patient_id=$2 AND account_id=$3 ORDER BY created_at DESC,id LIMIT 100")
        .bind(a.tenant_id).bind(p).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "billing.invoices_read", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":rows})))
}
async fn new_patient_invoice(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(input): Json<PatientInvoiceInput>,
) -> Result<Json<Value>> {
    write(&a)?;
    text(&input.reason, 1000)?;
    let hash = digest(&(p, id, &input))?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let account = account_row(&mut tx, &a, p, id).await?;
    let prior: Option<(String, Value)> = sqlx::query_as("SELECT creation_hash,to_jsonb(i)-'tenant_id'-'creation_hash'-'request_id' FROM patient_invoice_snapshots i WHERE tenant_id=$1 AND request_id=$2")
        .bind(a.tenant_id).bind(input.request_id).fetch_optional(&mut *tx).await?;
    if let Some((prior_hash, row)) = prior {
        if prior_hash != hash {
            return Err(Error::Conflict(
                "invoice request ID already used with different content",
            ));
        }
        crate::postgres::audit(&mut tx, &a, "billing.invoice_replayed", id).await?;
        tx.commit().await?;
        return Ok(Json(row));
    }
    if account.version != crate::expected(&h)? {
        return Err(Error::Conflict(
            "account changed; reload before building the invoice",
        ));
    }
    if account.status != "posted" {
        return Err(Error::Conflict(
            "post the reviewed charge account before building an invoice",
        ));
    }
    if !(0..=account.total_cents).contains(&input.responsibility_cents) {
        return Err(Error::Invalid(
            "reviewed patient responsibility must be between zero and total charges",
        ));
    }
    // Sum patient payments and credits, their reversals, and confirmed refunds.
    // Unconfirmed processor attempts have no ledger entry and cannot reduce an invoice.
    let (credit, payments) = patient_ledger_totals(&mut tx, a.tenant_id, id).await?;
    let patient: Value = sqlx::query_scalar("SELECT jsonb_build_object('given_name',given_name,'family_name',family_name,'mrn',mrn) FROM patients WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id).bind(p).fetch_one(&mut *tx).await?;
    // Copy only patient-facing fields. A saved invoice must never re-read current
    // charges or ledger activity, and staff notes are not part of its receipt.
    let services: Vec<Value> = account.content["lines"]
        .as_array()
        .ok_or(Error::Invalid("stored charge lines are unavailable"))?
        .iter()
        .map(|line| {
            json!({"code_system":line["code_system"],"code":line["code"],"description":line["description"],"modifiers":line["modifiers"],"units":line["units"],"line_total_cents":line["amount_cents"]})
        })
        .collect();
    let patient_activity: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',e.id,'kind',e.kind,'occurred_on',e.content->'occurred_on','method',e.content->'method','reference',e.content->'reference','effect_cents',e.effect_cents,'reverses_id',e.reverses_id) FROM billing_entries e LEFT JOIN billing_entries original ON original.tenant_id=e.tenant_id AND original.account_id=e.account_id AND original.id=e.reverses_id WHERE e.tenant_id=$1 AND e.account_id=$2 AND CASE WHEN e.kind='reversal' THEN original.content->>'party' ELSE e.content->>'party' END='patient' ORDER BY e.created_at,e.id")
        .bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let test_activity: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM billing_entries WHERE tenant_id=$1 AND account_id=$2 AND content->>'test_mode'='true')")
        .bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
    let invoice = Uuid::new_v4();
    let net = input.responsibility_cents - credit;
    let snapshot = json!({"format_version":2,"practice_name":crate::branding::InstanceBranding::from_env().display_name,"patient":patient,"service_date":account.content["service_date"],"services":services,"patient_activity":patient_activity,"gross_charges_cents":account.total_cents,"responsibility_cents":input.responsibility_cents,"patient_credit_cents":credit,"patient_payment_cents":payments,"patient_adjustment_credit_cents":credit-payments,"amount_due_cents":net.max(0),"credit_balance_cents":(-net).max(0),"currency":"USD","reason":input.reason,"test_activity":test_activity,"scope":"at_issuance"});
    let row: Value = sqlx::query_scalar("INSERT INTO patient_invoice_snapshots(tenant_id,id,patient_id,account_id,request_id,creation_hash,account_version,snapshot,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING to_jsonb(patient_invoice_snapshots)-'tenant_id'-'creation_hash'-'request_id'")
        .bind(a.tenant_id).bind(invoice).bind(p).bind(id).bind(input.request_id).bind(hash).bind(account.version).bind(snapshot).bind(a.sub).fetch_one(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "billing.invoice_created", invoice).await?;
    tx.commit().await?;
    Ok(Json(row))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CopayInput {
    request_id: Uuid,
    appointment_id: Uuid,
    coverage_id: Option<Uuid>,
    amount_cents: i64,
    method: String,
    reference: String,
    occurred_on: NaiveDate,
    reason: String,
    received_confirmed: bool,
}
async fn copay_rows(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    receipt: Option<Uuid>,
) -> Result<Vec<Value>> {
    Ok(sqlx::query_scalar("SELECT (to_jsonb(r)-'tenant_id'-'creation_hash'-'request_id') || jsonb_build_object('hosted_checkout',(SELECT jsonb_build_object('id',o.id,'livemode',o.livemode,'status',o.status,'refunded_cents',o.refunded_cents,'refunded_unapplied_cents',coalesce((SELECT sum(f.unapplied_cents) FROM copay_checkout_refund_events f WHERE f.tenant_id=o.tenant_id AND f.operation_id=o.id),0)) FROM copay_checkout_attempts o WHERE o.tenant_id=r.tenant_id AND o.receipt_id=r.id),'allocated_cents',coalesce((SELECT sum(x.amount_cents) FROM billing_copay_allocations x WHERE x.tenant_id=r.tenant_id AND x.receipt_id=r.id),0),'reversed_cents',coalesce((SELECT sum(x.amount_cents) FROM billing_copay_allocations x JOIN billing_entries e ON e.tenant_id=x.tenant_id AND e.reverses_id=x.entry_id WHERE x.tenant_id=r.tenant_id AND x.receipt_id=r.id),0),'voided',EXISTS(SELECT 1 FROM billing_copay_voids v WHERE v.tenant_id=r.tenant_id AND v.receipt_id=r.id),'account_ids',coalesce((SELECT jsonb_agg(DISTINCT x.account_id) FROM billing_copay_allocations x WHERE x.tenant_id=r.tenant_id AND x.receipt_id=r.id),'[]'::jsonb)) FROM billing_copay_receipts r WHERE tenant_id=$1 AND patient_id=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at,id LIMIT 1001")
        .bind(a.tenant_id).bind(p).bind(receipt).fetch_all(&mut **tx).await?)
}
#[derive(sqlx::FromRow)]
struct CopayAllocationCandidate {
    id: Uuid,
    remaining: i64,
    method: String,
    reference: String,
    occurred_on: NaiveDate,
    hosted_operation: Option<Uuid>,
    livemode: Option<bool>,
}
// Call under the tenant billing lock. Immutable allocations remain consumed after
// a ledger reversal, so a corrected receipt can never be silently posted again.
async fn allocate_copays(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    account: Uuid,
) -> Result<i64> {
    let linked: Option<(Uuid,i64)> = sqlx::query_as("SELECT v.appointment_id,b.total_cents FROM billing_accounts b JOIN visits v ON v.tenant_id=b.tenant_id AND v.id=b.visit_id AND v.patient_id=b.patient_id WHERE b.tenant_id=$1 AND b.patient_id=$2 AND b.id=$3 AND b.status='posted' FOR UPDATE OF b")
        .bind(a.tenant_id).bind(p).bind(account).fetch_optional(&mut **tx).await?;
    let Some((appointment, total)) = linked else {
        return Ok(0);
    };
    let effect:i64=sqlx::query_scalar("SELECT coalesce(sum(effect_cents),0)::bigint FROM billing_entries WHERE tenant_id=$1 AND account_id=$2").bind(a.tenant_id).bind(account).fetch_one(&mut **tx).await?;
    let reserved:i64=sqlx::query_scalar("SELECT coalesce(sum(amount_cents),0)::bigint FROM payment_attempts WHERE tenant_id=$1 AND account_id=$2 AND status IN ('creating','open','needs_review') AND paid_entry_id IS NULL").bind(a.tenant_id).bind(account).fetch_one(&mut **tx).await?;
    let mut available = (total + effect - reserved).max(0);
    let receipts:Vec<CopayAllocationCandidate>=sqlx::query_as("SELECT r.id,r.amount_cents-coalesce((SELECT sum(x.amount_cents) FROM billing_copay_allocations x WHERE x.tenant_id=r.tenant_id AND x.receipt_id=r.id),0)::bigint-coalesce((SELECT sum(f.unapplied_cents) FROM copay_checkout_refund_events f WHERE f.tenant_id=o.tenant_id AND f.operation_id=o.id),0)::bigint AS remaining,r.method,r.reference,r.occurred_on,o.id AS hosted_operation,o.livemode FROM billing_copay_receipts r LEFT JOIN copay_checkout_attempts o ON o.tenant_id=r.tenant_id AND o.receipt_id=r.id WHERE r.tenant_id=$1 AND r.patient_id=$2 AND r.appointment_id=$3 AND (o.id IS NULL OR o.status<>'needs_review') AND NOT EXISTS(SELECT 1 FROM billing_copay_voids v WHERE v.tenant_id=r.tenant_id AND v.receipt_id=r.id) AND NOT EXISTS(SELECT 1 FROM billing_copay_allocations x JOIN billing_entries reversal ON reversal.tenant_id=x.tenant_id AND reversal.reverses_id=x.entry_id WHERE x.tenant_id=r.tenant_id AND x.receipt_id=r.id) ORDER BY r.created_at,r.id")
        .bind(a.tenant_id).bind(p).bind(appointment).fetch_all(&mut **tx).await?;
    let mut applied = 0;
    for row in receipts {
        let CopayAllocationCandidate {
            id: receipt,
            remaining,
            method,
            reference,
            occurred_on,
            hosted_operation,
            livemode,
        } = row;
        if livemode == Some(false)
            && std::env::var("ENGINE_ENVIRONMENT").as_deref() == Ok("production")
        {
            continue;
        }
        let amount = available.min(remaining);
        if amount <= 0 {
            continue;
        }
        let entry = Uuid::new_v4();
        let mut content = json!({"kind":"payment","amount_cents":amount,"party":"patient","method":method,"reference":reference,"occurred_on":occurred_on,"reason":"Applied recorded appointment copay","copay_receipt_id":receipt});
        if let Some(operation) = hosted_operation {
            content["hosted_copay_operation_id"] = json!(operation);
            content["method"] = json!("card");
            content["test_mode"] = json!(livemode == Some(false));
        }
        sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id) VALUES($1,$2,$3,'payment',$4,$5,$2,$6,$7)")
            .bind(a.tenant_id).bind(entry).bind(account).bind(-amount).bind(&content).bind(digest(&(receipt,entry,amount))?).bind(a.sub).execute(&mut **tx).await?;
        sqlx::query("INSERT INTO billing_copay_allocations(tenant_id,receipt_id,patient_id,account_id,entry_id,amount_cents,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(a.tenant_id).bind(receipt).bind(p).bind(account).bind(entry).bind(amount).bind(a.sub).execute(&mut **tx).await?;
        crate::postgres::audit(tx, a, "billing.copay_applied", receipt).await?;
        available -= amount;
        applied += amount;
    }
    Ok(applied)
}
// Only the server-side checkout reconciler may call this after matching captured
// provider evidence. The caller holds the tenant billing lock and operation row.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn record_verified_hosted_copay(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    appointment: Uuid,
    coverage: Option<Uuid>,
    amount: i64,
    operation: Uuid,
    provider_charge: &str,
    livemode: bool,
    occurred_on: NaiveDate,
) -> Result<Uuid> {
    if !(1..=100000000).contains(&amount)
        || provider_charge.trim().is_empty()
        || provider_charge.len() > 200
        || occurred_on < NaiveDate::from_ymd_opt(2010, 1, 1).unwrap()
        || occurred_on > (Utc::now() + chrono::Duration::minutes(5)).date_naive()
        || (!livemode && std::env::var("ENGINE_ENVIRONMENT").as_deref() == Ok("production"))
    {
        return Err(Error::Invalid("invalid verified hosted copay evidence"));
    }
    let bound: Option<(Option<Value>,)> = sqlx::query_as(
        "SELECT coverage_snapshot FROM copay_checkout_attempts WHERE tenant_id=$1 AND id=$2
         AND patient_id=$3 AND appointment_id=$4 AND coverage_id IS NOT DISTINCT FROM $5
         AND amount_cents=$6 AND livemode=$7 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(operation)
    .bind(p)
    .bind(appointment)
    .bind(coverage)
    .bind(amount)
    .bind(livemode)
    .fetch_optional(&mut **tx)
    .await?;
    let (coverage_snapshot,) = bound.ok_or(Error::Conflict(
        "hosted copay operation does not match captured evidence",
    ))?;
    let hash = digest(&(
        "verified_hosted_copay",
        p,
        appointment,
        coverage,
        amount,
        operation,
        provider_charge,
        livemode,
        occurred_on,
    ))?;
    let prior: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,creation_hash FROM billing_copay_receipts WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(operation)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some((id, prior_hash)) = prior {
        if prior_hash != hash {
            return Err(Error::Conflict(
                "hosted copay receipt binding conflicts with prior evidence",
            ));
        }
        return Ok(id);
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO billing_copay_receipts(tenant_id,id,patient_id,appointment_id,coverage_id,amount_cents,method,reference,occurred_on,reason,coverage_snapshot,request_id,creation_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6,'external',$7,$8,'Verified hosted card copay',$9,$10,$11,$12)")
        .bind(a.tenant_id).bind(id).bind(p).bind(appointment).bind(coverage).bind(amount)
        .bind(provider_charge).bind(occurred_on).bind(coverage_snapshot)
        .bind(operation).bind(hash).bind(a.sub).execute(&mut **tx).await?;
    // Link before allocation so both immediate and later allocations carry the
    // same immutable operation identity and explicit test/live provenance.
    let linked = sqlx::query("UPDATE copay_checkout_attempts SET receipt_id=$3,status='paid' WHERE tenant_id=$1 AND id=$2 AND receipt_id IS NULL")
        .bind(a.tenant_id).bind(operation).bind(id).execute(&mut **tx).await?;
    if linked.rows_affected() != 1 {
        return Err(Error::Conflict(
            "hosted copay already has a different receipt",
        ));
    }
    crate::postgres::audit(tx, a, "billing.hosted_copay_recorded", id).await?;
    allocate_verified_hosted_copay_credit(tx, a, operation).await?;
    Ok(id)
}
pub(crate) async fn allocate_verified_hosted_copay_credit(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    operation: Uuid,
) -> Result<()> {
    let scope: Option<(Uuid, Uuid)> = sqlx::query_as("SELECT patient_id,appointment_id FROM copay_checkout_attempts WHERE tenant_id=$1 AND id=$2 AND receipt_id IS NOT NULL AND status='paid'")
        .bind(a.tenant_id).bind(operation).fetch_optional(&mut **tx).await?;
    let Some((patient, appointment)) = scope else {
        return Ok(());
    };
    let accounts: Vec<Uuid> = sqlx::query_scalar("SELECT b.id FROM billing_accounts b JOIN visits v ON v.tenant_id=b.tenant_id AND v.id=b.visit_id AND v.patient_id=b.patient_id WHERE b.tenant_id=$1 AND b.patient_id=$2 AND v.appointment_id=$3 AND b.status='posted' ORDER BY b.created_at,b.id")
        .bind(a.tenant_id).bind(patient).bind(appointment).fetch_all(&mut **tx).await?;
    for account in accounts {
        if allocate_copays(tx, a, patient, account).await? > 0 {
            sqlx::query(
                "UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2",
            )
            .bind(a.tenant_id)
            .bind(account)
            .execute(&mut **tx)
            .await?;
            account_revision(tx, a, patient, account, "Applied verified hosted copay").await?;
        }
    }
    Ok(())
}
// The caller has verified the same provider charge and holds the tenant/operation
// locks. Cumulative observations are monotonic and every consumed cent is bound
// to either unapplied receipt credit or a specific original allocation.
pub(crate) async fn apply_verified_hosted_copay_refund(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    operation: Uuid,
    refunded: i64,
) -> Result<()> {
    let (receipt, patient, amount, prior, livemode): (Uuid, Uuid, i64, i64, bool) =
        sqlx::query_as("SELECT receipt_id,patient_id,amount_cents,refunded_cents,livemode FROM copay_checkout_attempts WHERE tenant_id=$1 AND id=$2 AND receipt_id IS NOT NULL FOR UPDATE")
            .bind(a.tenant_id).bind(operation).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
    if !livemode && std::env::var("ENGINE_ENVIRONMENT").as_deref() == Ok("production") {
        return Err(Error::Invalid(
            "test copay refunds cannot change production balances",
        ));
    }
    if refunded < prior || refunded > amount {
        return Err(Error::Conflict(
            "hosted refund evidence is out of order or exceeds the capture",
        ));
    }
    let (observed, prior_unapplied): (i64, i64) = sqlx::query_as("SELECT coalesce(sum(delta_cents),0)::bigint,coalesce(sum(unapplied_cents),0)::bigint FROM copay_checkout_refund_events WHERE tenant_id=$1 AND operation_id=$2")
        .bind(a.tenant_id).bind(operation).fetch_one(&mut **tx).await?;
    if observed != prior {
        return Err(Error::Conflict(
            "hosted refund accounting requires reconciliation",
        ));
    }
    if refunded == prior {
        return Ok(());
    }
    let allocated: i64 = sqlx::query_scalar("SELECT coalesce(sum(amount_cents),0)::bigint FROM billing_copay_allocations WHERE tenant_id=$1 AND receipt_id=$2")
        .bind(a.tenant_id).bind(receipt).fetch_one(&mut **tx).await?;
    let delta = refunded - prior;
    let unapplied = delta.min((amount - allocated - prior_unapplied).max(0));
    sqlx::query("INSERT INTO copay_checkout_refund_events(tenant_id,operation_id,cumulative_cents,delta_cents,unapplied_cents,actor_id) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(a.tenant_id).bind(operation).bind(refunded).bind(delta).bind(unapplied).bind(a.sub).execute(&mut **tx).await?;
    let allocations: Vec<(Uuid, Uuid, i64, bool)> = sqlx::query_as("SELECT x.account_id,x.entry_id,x.amount_cents-coalesce((SELECT sum(f.amount_cents) FROM copay_checkout_refund_allocations f WHERE f.tenant_id=x.tenant_id AND f.allocation_entry_id=x.entry_id),0)::bigint,EXISTS(SELECT 1 FROM billing_entries r WHERE r.tenant_id=x.tenant_id AND r.reverses_id=x.entry_id) FROM billing_copay_allocations x JOIN billing_entries e ON e.tenant_id=x.tenant_id AND e.id=x.entry_id WHERE x.tenant_id=$1 AND x.receipt_id=$2 ORDER BY e.created_at DESC,e.id DESC")
        .bind(a.tenant_id).bind(receipt).fetch_all(&mut **tx).await?;
    let mut remaining = delta - unapplied;
    let mut changed_accounts = std::collections::BTreeSet::new();
    for (account, allocation, available, corrected) in allocations {
        let take = remaining.min(available.max(0));
        if take == 0 {
            continue;
        }
        let entry = if corrected {
            None
        } else {
            // A refund increases the patient balance. It does not erase or
            // modify the original payment, its receipt, or a prior invoice.
            account_row(tx, a, patient, account).await?;
            let id = Uuid::new_v4();
            let content = json!({"kind":"adjustment_debit","amount_cents":take,"party":"patient","method":"card","reference":operation,"occurred_on":Utc::now().date_naive(),"reason":"Verified hosted card refund","hosted_copay_operation_id":operation,"copay_receipt_id":receipt,"refund_cumulative_cents":refunded,"test_mode":!livemode});
            sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id) VALUES($1,$2,$3,'adjustment_debit',$4,$5,$2,$6,$7)")
                .bind(a.tenant_id).bind(id).bind(account).bind(take).bind(content)
                .bind(digest(&(operation, refunded, allocation, take))?).bind(a.sub).execute(&mut **tx).await?;
            changed_accounts.insert(account);
            Some(id)
        };
        sqlx::query("INSERT INTO copay_checkout_refund_allocations(tenant_id,operation_id,cumulative_cents,account_id,allocation_entry_id,entry_id,amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(a.tenant_id).bind(operation).bind(refunded).bind(account).bind(allocation).bind(entry).bind(take).execute(&mut **tx).await?;
        remaining -= take;
    }
    if remaining != 0 {
        return Err(Error::Conflict(
            "hosted refund cannot be matched to original receipt credit",
        ));
    }
    for account in changed_accounts {
        sqlx::query("UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(account)
            .execute(&mut **tx)
            .await?;
        account_revision(tx, a, patient, account, "Verified hosted card refund").await?;
    }
    crate::postgres::audit(tx, a, "billing.hosted_copay_refund_recorded", receipt).await?;
    Ok(())
}
async fn record_copay(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Json(v): Json<CopayInput>,
) -> Result<Json<Value>> {
    write(&a)?;
    text(&v.reason, 1000)?;
    bounded(&v.reference, 200)?;
    choice(&v.method, &["cash", "check", "external"])?;
    if !v.received_confirmed
        || !(1..=100000000).contains(&v.amount_cents)
        || v.occurred_on > Utc::now().date_naive()
        || (v.method != "cash" && v.reference.trim().is_empty())
    {
        return Err(Error::Invalid(
            "confirm receipt, amount, date and payment reference before recording the copay",
        ));
    }
    let hash = digest(&(p, &v))?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    patient(&mut tx, &a, p).await?;
    let prior: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,creation_hash FROM billing_copay_receipts WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((id, prior_hash)) = prior {
        if hash != prior_hash {
            return Err(Error::Conflict(
                "copay request ID already used with different content",
            ));
        }
        let rows = copay_rows(&mut tx, &a, p, Some(id)).await?;
        let row = rows
            .into_iter()
            .find(|r| r["id"] == id.to_string())
            .ok_or(Error::NotFound)?;
        tx.commit().await?;
        return Ok(Json(row));
    }
    let appointment: Option<String> = sqlx::query_scalar(
        "SELECT status FROM appointments WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(p)
    .bind(v.appointment_id)
    .fetch_optional(&mut *tx)
    .await?;
    let status = appointment.ok_or(Error::NotFound)?;
    if ["cancelled", "canceled", "no_show"].contains(&status.as_str()) {
        return Err(Error::Conflict(
            "select an active appointment before recording its copay",
        ));
    }
    let coverage = if let Some(id) = v.coverage_id {
        Some(json!(coverage_row(&mut tx, &a, p, id).await?))
    } else {
        None
    };
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO billing_copay_receipts(tenant_id,id,patient_id,appointment_id,coverage_id,amount_cents,method,reference,occurred_on,reason,coverage_snapshot,request_id,creation_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)")
        .bind(a.tenant_id).bind(id).bind(p).bind(v.appointment_id).bind(v.coverage_id).bind(v.amount_cents).bind(v.method).bind(v.reference.trim()).bind(v.occurred_on).bind(v.reason.trim()).bind(coverage).bind(v.request_id).bind(hash).bind(a.sub).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "billing.copay_recorded", id).await?;
    let account:Option<Uuid>=sqlx::query_scalar("SELECT b.id FROM billing_accounts b JOIN visits v ON v.tenant_id=b.tenant_id AND v.id=b.visit_id WHERE b.tenant_id=$1 AND b.patient_id=$2 AND v.appointment_id=$3 AND b.status='posted'").bind(a.tenant_id).bind(p).bind(v.appointment_id).fetch_optional(&mut *tx).await?;
    if let Some(account) = account {
        if allocate_copays(&mut tx, &a, p, account).await? > 0 {
            sqlx::query(
                "UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2",
            )
            .bind(a.tenant_id)
            .bind(account)
            .execute(&mut *tx)
            .await?;
            account_revision(
                &mut tx,
                &a,
                p,
                account,
                "Applied recorded appointment copay",
            )
            .await?;
        }
    }
    let row = copay_rows(&mut tx, &a, p, Some(id))
        .await?
        .into_iter()
        .find(|r| r["id"] == id.to_string())
        .ok_or(Error::NotFound)?;
    tx.commit().await?;
    Ok(Json(row))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CopayVoid {
    reason: String,
}
async fn void_copay(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    Json(v): Json<CopayVoid>,
) -> Result<Json<Value>> {
    write(&a)?;
    text(&v.reason, 1000)?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM billing_copay_receipts WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)").bind(a.tenant_id).bind(p).bind(id).fetch_one(&mut *tx).await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let hosted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM copay_checkout_attempts WHERE tenant_id=$1 AND receipt_id=$2)",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if hosted {
        return Err(Error::Conflict("hosted card receipts require verified processor refund evidence and cannot be manually voided"));
    }
    let allocated:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM billing_copay_allocations WHERE tenant_id=$1 AND receipt_id=$2)").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
    if allocated {
        return Err(Error::Conflict(
            "this copay is already on the ledger; correct its original ledger entry instead",
        ));
    }
    sqlx::query("INSERT INTO billing_copay_voids(tenant_id,receipt_id,reason,actor_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING").bind(a.tenant_id).bind(id).bind(v.reason.trim()).bind(a.sub).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "billing.copay_voided", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"voided":true})))
}
async fn apply_recorded_copays(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    write(&a)?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let account = account_row(&mut tx, &a, p, id).await?;
    if account.version != crate::expected(&h)? || account.status != "posted" {
        return Err(Error::Conflict(
            "reload the posted account before applying recorded copays",
        ));
    }
    let amount = allocate_copays(&mut tx, &a, p, id).await?;
    if amount > 0 {
        sqlx::query("UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        account_revision(
            &mut tx,
            &a,
            p,
            id,
            "Applied available recorded copay credit",
        )
        .await?;
    }
    crate::postgres::audit(&mut tx, &a, "billing.copay_application_review", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"applied_cents":amount})))
}
