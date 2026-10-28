// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Local clinical orders, specimen intake, versioned panels and acknowledgment.
//! Placing an order never claims external delivery. Imported lab signatures stay unverified.
use crate::{
    auth::Actor,
    clinical::Coding,
    error::{Error, Result},
    model::text,
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use std::collections::HashSet;
use uuid::Uuid;
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestedTest {
    pub key: String,
    pub label: String,
    pub code: Option<Coding>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OrderContent {
    pub title: String,
    pub category: String,
    pub priority: String,
    pub clinical_reason: String,
    pub destination: String,
    #[serde(default)]
    pub instructions: String,
    pub tests: Vec<RequestedTest>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NewOrder {
    pub request_id: Uuid,
    pub visit_id: Option<Uuid>,
    pub source_history_id: Option<Uuid>,
    pub content: OrderContent,
    pub reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditOrder {
    pub(crate) visit_id: Option<Uuid>,
    pub(crate) content: OrderContent,
    pub(crate) reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    action: String,
    reason: String,
}
#[derive(Serialize, sqlx::FromRow)]
struct Order {
    diagnosis_snapshot: Option<Value>,
    id: Uuid,
    patient_id: Uuid,
    visit_id: Option<Uuid>,
    content: Value,
    status: String,
    version: i64,
    source_history_id: Option<Uuid>,
    created_by: Uuid,
    placed_by: Option<Uuid>,
    placed_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpecimenContent {
    pub accession: String,
    pub specimen_type: String,
    pub body_site: String,
    pub collected_at: DateTime<Utc>,
    pub received_at: DateTime<Utc>,
    pub status: String,
    pub notes: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NewSpecimen {
    request_id: Uuid,
    content: SpecimenContent,
    reason: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub label: String,
    pub code: Option<Coding>,
    pub value_type: String,
    pub number: Option<f64>,
    #[serde(default)]
    pub comparator: String,
    #[serde(default)]
    pub text: String,
    pub coded: Option<Coding>,
    #[serde(default)]
    pub units: String,
    #[serde(default)]
    pub reference_range: String,
    pub flag: String,
    #[serde(default)]
    pub absent_reason: String,
    #[serde(default)]
    pub notes: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReportContent {
    pub test_keys: Vec<String>,
    pub specimen_id: Option<Uuid>,
    #[serde(default)]
    pub specimen_not_recorded: bool,
    pub accession: String,
    pub performing_lab: String,
    pub reported_at: DateTime<Utc>,
    pub observations: Vec<Observation>,
    #[serde(default)]
    pub notes: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NewReport {
    request_id: Uuid,
    source_history_id: Option<Uuid>,
    content: ReportContent,
    status: String,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditReport {
    content: ReportContent,
    status: String,
    reason: String,
}
#[derive(Serialize, sqlx::FromRow)]
struct Report {
    id: Uuid,
    order_id: Uuid,
    content: Value,
    status: String,
    version: i64,
    source_history_id: Option<Uuid>,
    author_id: Uuid,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ack {
    note: String,
}
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn choice(v: &str, allowed: &[&str]) -> Result<()> {
    if allowed.contains(&v) {
        Ok(())
    } else {
        Err(Error::Invalid("unsupported order/result classification"))
    }
}
fn bounded(v: &str, n: usize) -> Result<()> {
    if v.chars().count() > n {
        Err(Error::Invalid("order/result text too long"))
    } else {
        Ok(())
    }
}
fn coding(c: &Coding) -> Result<()> {
    text(&c.system, 200)?;
    text(&c.code, 120)?;
    bounded(&c.display, 200)
}
fn hash<T: Serialize>(v: &T) -> Result<String> {
    Ok(crate::oauth::hash(
        &serde_json::to_string(v).map_err(|_| Error::Invalid("invalid request"))?,
    ))
}
impl OrderContent {
    fn validate(&self) -> Result<()> {
        text(&self.title, 200)?;
        text(&self.clinical_reason, 2000)?;
        text(&self.destination, 200)?;
        bounded(&self.instructions, 4000)?;
        choice(&self.category, &["laboratory", "imaging", "procedure"])?;
        choice(&self.priority, &["routine", "urgent", "stat"])?;
        if self.tests.is_empty() || self.tests.len() > 30 {
            return Err(Error::Invalid("order requires 1 to 30 requested tests"));
        }
        let mut keys = HashSet::new();
        for t in &self.tests {
            text(&t.key, 80)?;
            text(&t.label, 200)?;
            if !keys.insert(&t.key) {
                return Err(Error::Invalid("duplicate requested test key"));
            }
            if let Some(c) = &t.code {
                coding(c)?;
            }
        }
        Ok(())
    }
}
impl ReportContent {
    fn validate(&self) -> Result<()> {
        text(&self.accession, 120)?;
        text(&self.performing_lab, 200)?;
        bounded(&self.notes, 10000)?;
        if self.reported_at > Utc::now() + chrono::Duration::minutes(5)
            || self.observations.is_empty()
            || self.observations.len() > 100
            || self.test_keys.is_empty()
            || self.test_keys.len() > 30
        {
            return Err(Error::Invalid(
                "report requires a valid time, requested tests and 1 to 100 observations",
            ));
        }
        let mut keys = HashSet::new();
        for k in &self.test_keys {
            if !keys.insert(k) {
                return Err(Error::Invalid("duplicate report test key"));
            }
        }
        for o in &self.observations {
            text(&o.label, 200)?;
            bounded(&o.text, 4000)?;
            bounded(&o.units, 100)?;
            bounded(&o.reference_range, 500)?;
            bounded(&o.notes, 4000)?;
            if let Some(c) = &o.code {
                coding(c)?;
            }
            if let Some(c) = &o.coded {
                coding(c)?;
            }
            choice(
                &o.flag,
                &[
                    "unknown",
                    "normal",
                    "abnormal",
                    "high",
                    "low",
                    "critical_high",
                    "critical_low",
                    "critical",
                ],
            )?;
            match o.value_type.as_str() {
                "numeric" => {
                    if !o.number.is_some_and(f64::is_finite)
                        || !o.text.is_empty()
                        || o.coded.is_some()
                        || !o.absent_reason.is_empty()
                    {
                        return Err(Error::Invalid(
                            "numeric observation requires only a finite numeric value",
                        ));
                    }
                    text(&o.units, 100)?;
                    choice(&o.comparator, &["", "<", "<=", ">", ">="])?;
                }
                "text" => {
                    text(&o.text, 4000)?;
                    if o.number.is_some()
                        || o.coded.is_some()
                        || !o.absent_reason.is_empty()
                        || !o.comparator.is_empty()
                    {
                        return Err(Error::Invalid("text observation has conflicting values"));
                    }
                }
                "coded" => {
                    if o.coded.is_none()
                        || o.number.is_some()
                        || !o.text.is_empty()
                        || !o.absent_reason.is_empty()
                        || !o.comparator.is_empty()
                    {
                        return Err(Error::Invalid("coded observation requires only a coding"));
                    }
                }
                "absent" => {
                    text(&o.absent_reason, 200)?;
                    if o.number.is_some()
                        || !o.text.is_empty()
                        || o.coded.is_some()
                        || !o.comparator.is_empty()
                    {
                        return Err(Error::Invalid("absent observation cannot include a value"));
                    }
                    if o.flag != "unknown" {
                        return Err(Error::Invalid(
                            "absent observations must have unknown interpretation",
                        ));
                    }
                }
                _ => return Err(Error::Invalid("unsupported result value type")),
            }
        }
        Ok(())
    }
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
async fn order(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: Uuid, id: Uuid) -> Result<Order> {
    sqlx::query_as("SELECT id,patient_id,visit_id,content,status,version,source_history_id,created_by,placed_by,placed_at,created_at,diagnosis_snapshot FROM lab_orders WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE").bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn report(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    oid: Uuid,
) -> Result<Report> {
    sqlx::query_as("SELECT id,order_id,content,status,version,source_history_id,author_id,created_at,updated_at FROM lab_reports WHERE tenant_id=$1 AND order_id=$2 AND id=$3 FOR UPDATE").bind(a.tenant_id).bind(oid).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn order_revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    o: &Order,
    reason: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO lab_order_revisions(tenant_id,order_id,version,snapshot,author_id,reason) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(o.id).bind(o.version).bind(json!(o)).bind(a.sub).bind(reason).execute(&mut **tx).await?;
    Ok(())
}
async fn report_revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Report,
    reason: &str,
) -> Result<()> {
    let mut snapshot = json!(r);
    snapshot["signature_origin"] = json!(if r.source_history_id.is_some() {
        "external_unverified"
    } else {
        "manual_clinical_entry"
    });
    sqlx::query("INSERT INTO lab_report_revisions(tenant_id,report_id,version,snapshot,author_id,reason) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(r.id).bind(r.version).bind(snapshot).bind(a.sub).bind(reason).execute(&mut **tx).await?;
    Ok(())
}
async fn bump(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    o: &Order,
    status: &str,
    reason: &str,
) -> Result<Order> {
    sqlx::query("UPDATE lab_orders SET version=version+1,status=$3 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(o.id)
        .bind(status)
        .execute(&mut **tx)
        .await?;
    let o = order(tx, a, o.patient_id, o.id).await?;
    order_revision(tx, a, &o, reason).await?;
    Ok(o)
}
fn version(actual: i64, h: &HeaderMap) -> Result<()> {
    if actual != crate::expected(h)? {
        return Err(Error::Conflict(
            "order or report changed; reload before saving",
        ));
    }
    Ok(())
}
fn writable(o: &Order) -> Result<()> {
    if matches!(o.status.as_str(), "ordered" | "in_progress") {
        Ok(())
    } else {
        Err(Error::Conflict("order must be placed and open"))
    }
}
fn response<T: Serialize>(data: T, v: i64) -> Response {
    ([(header::ETAG, format!("\"{v}\""))], Json(data)).into_response()
}
async fn source(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    id: Option<Uuid>,
    k: &str,
) -> Result<()> {
    if let Some(id) = id {
        let found:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM historical_records WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 AND kind=$4)").bind(a.tenant_id).bind(p).bind(id).bind(k).fetch_one(&mut **tx).await?;
        if !found {
            return Err(Error::Invalid(
                "source history kind or patient does not match",
            ));
        }
    }
    Ok(())
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/patients/{patient}/orders", get(list).post(create))
        .route("/api/v1/patients/{patient}/orders/{order}", put(edit))
        .route(
            "/api/v1/patients/{patient}/orders/{order}/actions",
            post(action),
        )
        .route(
            "/api/v1/patients/{patient}/orders/{order}/history",
            get(history),
        )
        .route(
            "/api/v1/patients/{patient}/orders/{order}/diagnoses",
            put(link_diagnoses),
        )
        .route(
            "/api/v1/patients/{patient}/orders/{order}/specimens",
            post(specimen),
        )
        .route(
            "/api/v1/patients/{patient}/orders/{order}/reports",
            post(create_report),
        )
        .route(
            "/api/v1/patients/{patient}/orders/{order}/reports/{report}",
            put(edit_report),
        )
        .route(
            "/api/v1/patients/{patient}/orders/{order}/reports/{report}/history",
            get(report_history),
        )
        .route(
            "/api/v1/patients/{patient}/orders/{order}/reports/{report}/acknowledge",
            post(acknowledge),
        )
        .route(
            "/api/v1/patients/{patient}/history/{id}/lab-mapping",
            get(mapping),
        )
        .route("/api/v1/labs/inbox", get(inbox))
}
async fn list(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    patient(&mut tx, &a, p).await?;
    let data:Value=sqlx::query_scalar("SELECT jsonb_build_object('orders',COALESCE((SELECT jsonb_agg(to_jsonb(o)-'tenant_id'-'creation_hash'-'request_id' ORDER BY o.created_at DESC,o.id) FROM lab_orders o WHERE tenant_id=$1 AND patient_id=$2),'[]'::jsonb),'specimens',COALESCE((SELECT jsonb_agg(to_jsonb(s)-'tenant_id'-'creation_hash'-'request_id') FROM lab_specimens s JOIN lab_orders o ON o.id=s.order_id AND o.tenant_id=s.tenant_id WHERE o.tenant_id=$1 AND o.patient_id=$2),'[]'::jsonb),'reports',COALESCE((SELECT jsonb_agg((to_jsonb(r)-'tenant_id'-'creation_hash'-'request_id')||jsonb_build_object('signature_origin',CASE WHEN r.source_history_id IS NULL THEN 'manual_clinical_entry' ELSE 'external_unverified' END)) FROM lab_reports r JOIN lab_orders o ON o.id=r.order_id AND o.tenant_id=r.tenant_id WHERE o.tenant_id=$1 AND o.patient_id=$2),'[]'::jsonb),'acknowledgments',COALESCE((SELECT jsonb_agg(to_jsonb(a)-'tenant_id') FROM lab_acknowledgments a JOIN lab_reports r ON r.tenant_id=a.tenant_id AND r.id=a.report_id JOIN lab_orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id WHERE o.tenant_id=$1 AND o.patient_id=$2),'[]'::jsonb))").bind(a.tenant_id).bind(p).fetch_one(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "patient.orders.read", p).await?;
    tx.commit().await?;
    Ok(Json(data))
}
pub(crate) async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Json(input): Json<NewOrder>,
) -> Result<Response> {
    a.clinical()?;
    input.content.validate()?;
    text(&input.reason, 1000)?;
    let fingerprint = hash(&input)?;
    let mut tx = db(&s)?.begin().await?;
    patient(&mut tx, &a, p).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,3))")
        .bind(a.tenant_id.to_string())
        .execute(&mut *tx)
        .await?;
    let prior: Option<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT id,patient_id,creation_hash FROM lab_orders WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(input.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((id, patient, prior)) = prior {
        if patient != p || prior != fingerprint {
            return Err(Error::Conflict(
                "request ID reused with different order content",
            ));
        }
        let o = order(&mut tx, &a, p, id).await?;
        crate::postgres::audit(&mut tx, &a, "patient.order_retry.read", p).await?;
        tx.commit().await?;
        let v = o.version;
        return Ok(response(o, v));
    }
    source(&mut tx, &a, p, input.source_history_id, "lab_order").await?;
    if let Some(v) = input.visit_id {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)",
        )
        .bind(a.tenant_id)
        .bind(p)
        .bind(v)
        .fetch_one(&mut *tx)
        .await?;
        if !exists {
            return Err(Error::Invalid("visit does not belong to patient"));
        }
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO lab_orders(tenant_id,id,patient_id,visit_id,request_id,creation_hash,content,status,source_history_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9)").bind(a.tenant_id).bind(id).bind(p).bind(input.visit_id).bind(input.request_id).bind(fingerprint).bind(json!(input.content)).bind(input.source_history_id).bind(a.sub).execute(&mut *tx).await?;
    let o = order(&mut tx, &a, p, id).await?;
    order_revision(&mut tx, &a, &o, &input.reason).await?;
    crate::postgres::audit(&mut tx, &a, "patient.order.create", p).await?;
    tx.commit().await?;
    Ok(response(o, 1))
}
pub(crate) async fn edit(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(input): Json<EditOrder>,
) -> Result<Response> {
    a.clinical()?;
    input.content.validate()?;
    text(&input.reason, 1000)?;
    let mut tx = db(&s)?.begin().await?;
    let o = order(&mut tx, &a, p, id).await?;
    version(o.version, &h)?;
    if o.status != "draft" {
        return Err(Error::Conflict(
            "placed orders are immutable; cancel or create a replacement",
        ));
    }
    if o.diagnosis_snapshot.is_some() && input.visit_id != o.visit_id {
        return Err(Error::Conflict(
            "clear draft diagnosis links before changing the linked visit",
        ));
    }
    if let Some(v) = input.visit_id {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)",
        )
        .bind(a.tenant_id)
        .bind(p)
        .bind(v)
        .fetch_one(&mut *tx)
        .await?;
        if !exists {
            return Err(Error::Invalid("visit does not belong to patient"));
        }
    }
    sqlx::query("UPDATE lab_orders SET content=$3,visit_id=$4 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .bind(json!(input.content))
        .bind(input.visit_id)
        .execute(&mut *tx)
        .await?;
    let o = bump(&mut tx, &a, &o, "draft", &input.reason).await?;
    crate::postgres::audit(&mut tx, &a, "patient.order.edit", p).await?;
    tx.commit().await?;
    let v = o.version;
    Ok(response(o, v))
}
async fn action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(input): Json<Action>,
) -> Result<Response> {
    a.clinical()?;
    text(&input.reason, 1000)?;
    let mut tx = db(&s)?.begin().await?;
    let o = order(&mut tx, &a, p, id).await?;
    version(o.version, &h)?;
    let status = match input.action.as_str() {
        "place" if o.status == "draft" => {
            sqlx::query(
                "UPDATE lab_orders SET placed_by=$3,placed_at=now() WHERE tenant_id=$1 AND id=$2",
            )
            .bind(a.tenant_id)
            .bind(id)
            .bind(a.sub)
            .execute(&mut *tx)
            .await?;
            "ordered"
        }
        "cancel" | "entered_in_error"
            if matches!(o.status.as_str(), "draft" | "ordered" | "in_progress") =>
        {
            let any:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM lab_reports WHERE tenant_id=$1 AND order_id=$2 AND status IN ('final','corrected'))").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
            if any {
                return Err(Error::Conflict("final results must be corrected or entered in error before cancelling the order"));
            }
            if input.action == "cancel" {
                "cancelled"
            } else {
                "entered_in_error"
            }
        }
        "complete" if matches!(o.status.as_str(), "ordered" | "in_progress") => {
            let reports:Vec<(Uuid,i64,Value,String)>=sqlx::query_as("SELECT id,version,content,status FROM lab_reports WHERE tenant_id=$1 AND order_id=$2").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
            let mut covered = HashSet::new();
            for (rid, v, content, status) in reports {
                if status == "entered_in_error" {
                    continue;
                }
                if status != "final" && status != "corrected" {
                    return Err(Error::Conflict("preliminary reports remain"));
                }
                let acknowledged:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM lab_acknowledgments WHERE tenant_id=$1 AND report_id=$2 AND version=$3)").bind(a.tenant_id).bind(rid).bind(v).fetch_one(&mut *tx).await?;
                if !acknowledged {
                    return Err(Error::Conflict(
                        "current report revisions require acknowledgment",
                    ));
                }
                let c: ReportContent = serde_json::from_value(content)
                    .map_err(|_| Error::Invalid("invalid stored report"))?;
                covered.extend(c.test_keys);
            }
            let c: OrderContent = serde_json::from_value(o.content.clone())
                .map_err(|_| Error::Invalid("invalid stored order"))?;
            if c.tests.iter().any(|t| !covered.contains(&t.key)) {
                return Err(Error::Conflict(
                    "final result coverage missing for requested tests",
                ));
            }
            "completed"
        }
        _ => return Err(Error::Conflict("invalid order transition")),
    };
    let o = bump(&mut tx, &a, &o, status, &input.reason).await?;
    crate::postgres::audit(&mut tx, &a, "patient.order.transition", p).await?;
    tx.commit().await?;
    let v = o.version;
    Ok(response(o, v))
}
async fn specimen(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(input): Json<NewSpecimen>,
) -> Result<Json<Value>> {
    a.clinical()?;
    text(&input.reason, 1000)?;
    let c = &input.content;
    text(&c.accession, 120)?;
    text(&c.specimen_type, 200)?;
    bounded(&c.body_site, 200)?;
    bounded(&c.notes, 4000)?;
    choice(&c.status, &["received", "rejected"])?;
    if c.collected_at > c.received_at
        || c.received_at > Utc::now() + chrono::Duration::minutes(5)
        || (c.status == "rejected" && c.notes.trim().is_empty())
    {
        return Err(Error::Invalid(
            "invalid specimen timeline or missing rejection reason",
        ));
    }
    let fingerprint = hash(&input)?;
    let mut tx = db(&s)?.begin().await?;
    let o = order(&mut tx, &a, p, id).await?;
    let old: Option<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT id,order_id,creation_hash FROM lab_specimens WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(input.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((sid, oid, prior)) = old {
        if oid != id || prior != fingerprint {
            return Err(Error::Conflict("specimen request ID reused"));
        }
        crate::postgres::audit(&mut tx, &a, "patient.specimen_retry.read", p).await?;
        tx.commit().await?;
        return Ok(Json(json!({"id":sid})));
    }
    version(o.version, &h)?;
    writable(&o)?;
    if o.content["category"] != "laboratory" {
        return Err(Error::Invalid(
            "specimen intake requires a laboratory order",
        ));
    }
    let sid = Uuid::new_v4();
    sqlx::query("INSERT INTO lab_specimens(tenant_id,id,order_id,request_id,creation_hash,content,author_id) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(a.tenant_id).bind(sid).bind(id).bind(input.request_id).bind(fingerprint).bind(json!(c)).bind(a.sub).execute(&mut *tx).await?;
    bump(&mut tx, &a, &o, "in_progress", &input.reason).await?;
    crate::postgres::audit(&mut tx, &a, "patient.specimen.receive", p).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":sid})))
}
async fn report_valid(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    o: &Order,
    c: &ReportContent,
    status: &str,
    src: Option<Uuid>,
) -> Result<()> {
    c.validate()?;
    choice(
        status,
        &["preliminary", "final", "corrected", "entered_in_error"],
    )?;
    let requested: OrderContent = serde_json::from_value(o.content.clone())
        .map_err(|_| Error::Invalid("invalid stored order"))?;
    if c.test_keys
        .iter()
        .any(|k| !requested.tests.iter().any(|t| &t.key == k))
    {
        return Err(Error::Invalid("report references a test outside its order"));
    }
    if c.specimen_not_recorded && (src.is_none() || c.specimen_id.is_some()) {
        return Err(Error::Invalid(
            "missing specimen exception is only for imported source reports",
        ));
    }
    if let Some(id) = c.specimen_id {
        let row: Option<Value> = sqlx::query_scalar(
            "SELECT content FROM lab_specimens WHERE tenant_id=$1 AND order_id=$2 AND id=$3",
        )
        .bind(a.tenant_id)
        .bind(o.id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
        let row = row.ok_or(Error::Invalid("specimen does not belong to order"))?;
        if row["status"] != "received" {
            return Err(Error::Invalid("rejected specimen cannot support a result"));
        }
        let received: DateTime<Utc> = serde_json::from_value(row["received_at"].clone())
            .map_err(|_| Error::Invalid("invalid specimen time"))?;
        if c.reported_at < received {
            return Err(Error::Invalid("report cannot predate specimen receipt"));
        }
    } else if requested.category == "laboratory"
        && matches!(status, "final" | "corrected")
        && !c.specimen_not_recorded
    {
        return Err(Error::Invalid("final laboratory result requires received specimen or explicit imported-source exception"));
    }
    Ok(())
}
async fn create_report(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(input): Json<NewReport>,
) -> Result<Response> {
    a.clinical()?;
    text(&input.reason, 1000)?;
    choice(&input.status, &["preliminary", "final"])?;
    let fingerprint = hash(&input)?;
    let mut tx = db(&s)?.begin().await?;
    let o = order(&mut tx, &a, p, id).await?;
    let prior: Option<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT id,order_id,creation_hash FROM lab_reports WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(input.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((rid, oid, old)) = prior {
        if oid != id || old != fingerprint {
            return Err(Error::Conflict("report request ID reused"));
        }
        let r = report(&mut tx, &a, rid, id).await?;
        crate::postgres::audit(&mut tx, &a, "patient.report_retry.read", p).await?;
        tx.commit().await?;
        let v = r.version;
        return Ok(response(r, v));
    }
    version(o.version, &h)?;
    writable(&o)?;
    source(&mut tx, &a, p, input.source_history_id, "lab_result").await?;
    if let Some(h) = input.source_history_id {
        let source = source_order(&mut tx, &a, p, h).await?;
        if o.source_history_id != Some(source) {
            return Err(Error::Conflict(
                "source report belongs to a different source order",
            ));
        }
    }
    report_valid(
        &mut tx,
        &a,
        &o,
        &input.content,
        &input.status,
        input.source_history_id,
    )
    .await?;
    let rid = Uuid::new_v4();
    sqlx::query("INSERT INTO lab_reports(tenant_id,id,order_id,request_id,creation_hash,content,status,source_history_id,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(a.tenant_id).bind(rid).bind(id).bind(input.request_id).bind(fingerprint).bind(json!(input.content)).bind(input.status).bind(input.source_history_id).bind(a.sub).execute(&mut *tx).await?;
    let r = report(&mut tx, &a, rid, id).await?;
    report_revision(&mut tx, &a, &r, &input.reason).await?;
    bump(&mut tx, &a, &o, "in_progress", &input.reason).await?;
    crate::postgres::audit(&mut tx, &a, "patient.report.create", p).await?;
    tx.commit().await?;
    Ok(response(r, 1))
}
async fn edit_report(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, oid, rid)): Path<(Uuid, Uuid, Uuid)>,
    h: HeaderMap,
    Json(input): Json<EditReport>,
) -> Result<Response> {
    a.clinical()?;
    text(&input.reason, 1000)?;
    let mut tx = db(&s)?.begin().await?;
    let o = order(&mut tx, &a, p, oid).await?;
    if !matches!(o.status.as_str(), "ordered" | "in_progress" | "completed") {
        return Err(Error::Conflict("order is not open for result correction"));
    }
    let r = report(&mut tx, &a, rid, oid).await?;
    version(r.version, &h)?;
    let allowed = match r.status.as_str() {
        "preliminary" => matches!(
            input.status.as_str(),
            "preliminary" | "final" | "entered_in_error"
        ),
        "final" | "corrected" => matches!(input.status.as_str(), "corrected" | "entered_in_error"),
        _ => false,
    };
    if !allowed {
        return Err(Error::Conflict(
            "final results require an attributed correction; error reports cannot be rewritten",
        ));
    }
    report_valid(
        &mut tx,
        &a,
        &o,
        &input.content,
        &input.status,
        r.source_history_id,
    )
    .await?;
    sqlx::query("UPDATE lab_reports SET content=$3,status=$4,version=version+1,author_id=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(rid).bind(json!(input.content)).bind(input.status).bind(a.sub).execute(&mut *tx).await?;
    let r = report(&mut tx, &a, rid, oid).await?;
    report_revision(&mut tx, &a, &r, &input.reason).await?;
    bump(&mut tx, &a, &o, "in_progress", &input.reason).await?;
    crate::postgres::audit(&mut tx, &a, "patient.report.revise", p).await?;
    tx.commit().await?;
    let v = r.version;
    Ok(response(r, v))
}
async fn acknowledge(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, oid, rid)): Path<(Uuid, Uuid, Uuid)>,
    h: HeaderMap,
    Json(input): Json<Ack>,
) -> Result<Json<Value>> {
    a.clinical()?;
    text(&input.note, 2000)?;
    let mut tx = db(&s)?.begin().await?;
    let _o = order(&mut tx, &a, p, oid).await?;
    let r = report(&mut tx, &a, rid, oid).await?;
    version(r.version, &h)?;
    if !matches!(r.status.as_str(), "preliminary" | "final" | "corrected") {
        return Err(Error::Conflict(
            "acknowledge a current report that is not entered in error",
        ));
    }
    let previous:Option<String>=sqlx::query_scalar("SELECT note FROM lab_acknowledgments WHERE tenant_id=$1 AND report_id=$2 AND version=$3 AND author_id=$4").bind(a.tenant_id).bind(rid).bind(r.version).bind(a.sub).fetch_optional(&mut *tx).await?;
    if previous.is_some_and(|note| note != input.note) {
        return Err(Error::Conflict(
            "acknowledgment already exists; its original note is immutable",
        ));
    }
    sqlx::query("INSERT INTO lab_acknowledgments(tenant_id,report_id,version,author_id,note) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING").bind(a.tenant_id).bind(rid).bind(r.version).bind(a.sub).bind(input.note).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "patient.report.acknowledge", p).await?;
    tx.commit().await?;
    Ok(Json(json!({"acknowledged_version":r.version})))
}
async fn history(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    order(&mut tx, &a, p, id).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id' FROM lab_order_revisions r WHERE tenant_id=$1 AND order_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "patient.order_history.read", p).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
async fn report_history(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, oid, id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    order(&mut tx, &a, p, oid).await?;
    report(&mut tx, &a, id, oid).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id' FROM lab_report_revisions r WHERE tenant_id=$1 AND report_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "patient.report_history.read", p).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
async fn inbox(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('report_id',r.id,'version',r.version,'status',r.status,'order_id',o.id,'patient_id',p.id,'mrn',p.mrn,'patient_name',p.given_name||' '||p.family_name,'title',o.content->>'title','reported_at',r.content->'reported_at','critical',EXISTS(SELECT 1 FROM jsonb_array_elements(r.content->'observations') x WHERE x->>'flag' IN ('critical','critical_high','critical_low'))) FROM lab_reports r JOIN lab_orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id JOIN patients p ON p.tenant_id=o.tenant_id AND p.id=o.patient_id WHERE r.tenant_id=$1 AND r.status IN ('preliminary','final','corrected') AND NOT EXISTS(SELECT 1 FROM lab_acknowledgments a WHERE a.tenant_id=r.tenant_id AND a.report_id=r.id AND a.version=r.version) ORDER BY r.updated_at,r.id LIMIT 100").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "patient.result_inbox.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"limit":100})))
}
fn field(row: &Value, key: &str) -> String {
    row.get(key)
        .and_then(|v| {
            v.as_str()
                .map(str::to_owned)
                .or_else(|| v.as_i64().map(|n| n.to_string()))
        })
        .unwrap_or_default()
}
fn source_time(row: &Value, key: &str, tz: &str) -> Option<DateTime<Utc>> {
    let raw = field(row, key);
    DateTime::parse_from_rfc3339(&raw)
        .ok()
        .or_else(|| {
            DateTime::parse_from_str(&format!("{}{}", raw, field(row, tz)), "%Y-%m-%d %H:%M:%S%z")
                .ok()
        })
        .map(|d| d.with_timezone(&Utc))
}
async fn source_order(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    h: Uuid,
) -> Result<Uuid> {
    let row:Option<(String,Value)>=sqlx::query_as("SELECT source_instance,source_data FROM historical_records WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 AND kind='lab_result'").bind(a.tenant_id).bind(p).bind(h).fetch_optional(&mut **tx).await?;
    let (instance, data) = row.ok_or(Error::NotFound)?;
    let source = data["source_order_id"].as_str().ok_or(Error::Invalid(
        "source report requires explicit source_order_id mapping",
    ))?;
    sqlx::query_scalar("SELECT h.id FROM historical_records h JOIN source_identifiers i ON i.tenant_id=h.tenant_id AND i.target_id=h.id AND i.kind='lab_order' WHERE h.tenant_id=$1 AND h.patient_id=$2 AND i.source_instance=$3 AND i.source_id=$4").bind(a.tenant_id).bind(p).bind(instance).bind(source).fetch_optional(&mut **tx).await?.ok_or(Error::Conflict("import and reconcile the source order before its report"))
}
async fn mapping(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.clinical()?;
    let mut tx = db(&s)?.begin().await?;
    let row:Option<(String,Value)>=sqlx::query_as("SELECT kind,source_data FROM historical_records WHERE tenant_id=$1 AND patient_id=$2 AND id=$3").bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut *tx).await?;
    let (kind, raw) = row.ok_or(Error::NotFound)?;
    let issues=vec!["Clinician review required. Original source fields and signatures remain unverified; no external delivery occurs.","Confirm patient, category, priority, source order linkage, test coverage, laboratory identity, units, flags and timestamps. Unmapped fields stay in source history."];
    let mut data = match kind.as_str() {
        "lab_order" => {
            let row = raw.get("order").unwrap_or(&raw);
            let tests = raw["tests"].as_array().ok_or(Error::Invalid(
                "source order requires ordered test rows from the EHI lab converter",
            ))?;
            let tests:Vec<Value>=tests.iter().enumerate().map(|(i,r)|json!({"key":if field(r,"procedure_order_seq").is_empty(){format!("source-test-{}",i+1)}else{field(r,"procedure_order_seq")},"label":field(r,"procedure_name"),"code":null})).collect();
            let linked:Option<Uuid>=sqlx::query_scalar("SELECT id FROM lab_orders WHERE tenant_id=$1 AND patient_id=$2 AND source_history_id=$3").bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut *tx).await?;
            json!({"kind":"order","native_order_id":linked,"content":{"title":field(row,"order_title"),"category":"laboratory","priority":"routine","clinical_reason":field(row,"clinical_hx"),"destination":"","instructions":field(row,"patient_instructions"),"tests":tests}})
        }
        "lab_result" => {
            let source = source_order(&mut tx, &a, p, id).await?;
            let linked:Option<(Uuid,Value)>=sqlx::query_as("SELECT id,content FROM lab_orders WHERE tenant_id=$1 AND patient_id=$2 AND source_history_id=$3").bind(a.tenant_id).bind(p).bind(source).fetch_optional(&mut *tx).await?;
            let (oid, order_content) = linked.ok_or(Error::Conflict(
                "reconcile the source order before its report",
            ))?;
            let row = raw
                .get("report")
                .ok_or(Error::Invalid("source report container missing"))?;
            let results = raw["results"]
                .as_array()
                .ok_or(Error::Invalid("source result components missing"))?;
            let observations:Vec<Value>=results.iter().map(|r|{
 let rawvalue=field(r,"result");let numeric=if field(r,"result_data_type")=="N" {rawvalue.parse::<f64>().ok().filter(|n|n.is_finite())}else{None};
 let flag=match field(r,"abnormal").to_lowercase().as_str(){"h"|"high"=>"high","l"|"low"=>"low","hh"=>"critical_high","ll"=>"critical_low","yes"|"a"=>"abnormal","no"|"n"|"normal"=>"normal",_=>"unknown"};
 json!({"label":field(r,"result_text"),"code":null,"value_type":if numeric.is_some(){"numeric"}else if rawvalue.is_empty(){"absent"}else{"text"},"number":numeric,"text":if numeric.is_none(){rawvalue.clone()}else{String::new()},"coded":null,"units":field(r,"units"),"reference_range":field(r,"range"),"flag":if rawvalue.is_empty(){"unknown"}else{flag},"absent_reason":if rawvalue.is_empty(){"unknown"}else{""},"notes":field(r,"comments")})
 }).collect();
            let key = field(row, "procedure_order_seq");
            let keys: Vec<Value> = order_content["tests"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|t| t["key"] == key)
                .map(|t| t["key"].clone())
                .collect();
            let native: Option<Uuid> = sqlx::query_scalar(
                "SELECT id FROM lab_reports WHERE tenant_id=$1 AND source_history_id=$2",
            )
            .bind(a.tenant_id)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
            json!({"kind":"report","native_order_id":oid,"native_report_id":native,"content":{"test_keys":keys,"specimen_id":null,"specimen_not_recorded":true,"accession":field(row,"specimen_num"),"performing_lab":"","reported_at":source_time(row,"date_report","date_report_tz"),"observations":observations,"notes":field(row,"report_notes")},"suggested_status":"preliminary","source_report_status":field(row,"report_status")})
        }
        _ => {
            return Err(Error::Invalid(
                "source history has no supported lab mapping",
            ))
        }
    };
    data["source_history_id"] = json!(id);
    data["source_data"] = raw;
    data["issues"] = json!(issues);
    data["mapping_version"] = json!("legacy-ehi-labs-v1");
    data["requires_clinician_review"] = json!(true);
    crate::postgres::audit(&mut tx, &a, "patient.lab_mapping.read", p).await?;
    tx.commit().await?;
    Ok(Json(data))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LinkDiagnoses {
    visit_version: i64,
    diagnosis_ids: Vec<Uuid>,
    reason: String,
}
/// Resolve the explicit selection under the same visit lock used by signing and
/// diagnosis edits. Consumers persist this value, never a live lookup.
pub(crate) async fn diagnosis_snapshot(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    patient: Uuid,
    visit: Uuid,
    expected: i64,
    ids: &[Uuid],
) -> Result<Value> {
    if ids.len() > 20 || ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err(Error::Invalid(
            "select at most 20 distinct encounter diagnoses",
        ));
    }
    let version: i64 = sqlx::query_scalar(
        "SELECT version FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR SHARE",
    )
    .bind(a.tenant_id)
    .bind(patient)
    .bind(visit)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::NotFound)?;
    if version != expected {
        return Err(Error::Conflict(
            "encounter changed; review its current diagnoses",
        ));
    }
    let stored: Value = sqlx::query_scalar(
        "SELECT diagnoses FROM visit_diagnoses WHERE tenant_id=$1 AND visit_id=$2",
    )
    .bind(a.tenant_id)
    .bind(visit)
    .fetch_optional(&mut **tx)
    .await?
    .unwrap_or_else(|| json!([]));
    let mut selected = Vec::new();
    for id in ids {
        let item = stored
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["id"].as_str() == Some(id.to_string().as_str()))
            })
            .ok_or(Error::Invalid(
                "selected diagnosis is not part of this encounter",
            ))?;
        selected.push(item.clone());
    }
    Ok(
        json!({"visit_id":visit,"visit_version":version,"code_system":"http://hl7.org/fhir/sid/icd-10-cm","diagnoses":selected}),
    )
}
async fn link_diagnoses(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(input): Json<LinkDiagnoses>,
) -> Result<Response> {
    a.clinical()?;
    text(&input.reason, 1000)?;
    let mut tx = db(&s)?.begin().await?;
    let old = order(&mut tx, &a, p, id).await?;
    version(old.version, &h)?;
    if old.status != "draft" {
        return Err(Error::Conflict(
            "only draft orders can change diagnosis links",
        ));
    }
    let visit = old
        .visit_id
        .ok_or(Error::Invalid("link the order to a native visit first"))?;
    let snapshot = diagnosis_snapshot(
        &mut tx,
        &a,
        p,
        visit,
        input.visit_version,
        &input.diagnosis_ids,
    )
    .await?;
    let snapshot = if input.diagnosis_ids.is_empty() {
        None
    } else {
        Some(snapshot)
    };
    sqlx::query("UPDATE lab_orders SET diagnosis_snapshot=$3 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .bind(snapshot)
        .execute(&mut *tx)
        .await?;
    let o = bump(&mut tx, &a, &old, "draft", &input.reason).await?;
    crate::postgres::audit(&mut tx, &a, "patient.order.diagnoses", p).await?;
    tx.commit().await?;
    let v = o.version;
    Ok(response(o, v))
}
