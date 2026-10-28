// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Versioned longitudinal lists. Source preservation and clinical reconciliation
//! are separate actions; medications here are statements, never prescriptions.
use crate::{
    auth::Actor,
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
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Coding {
    pub system: String,
    pub code: String,
    #[serde(default)]
    pub display: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Detail {
    Problem {
        problem_type: String,
    },
    Allergy {
        category: String,
        reaction: String,
        severity: String,
        criticality: String,
    },
    Medication {
        dose: String,
        route: String,
        frequency: String,
        indication: String,
    },
}
impl Detail {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Problem { .. } => "problem",
            Self::Allergy { .. } => "allergy",
            Self::Medication { .. } => "medication",
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Content {
    pub title: String,
    pub status: String,
    pub verification: String,
    pub onset_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    #[serde(default)]
    pub codes: Vec<Coding>,
    #[serde(default)]
    pub notes: String,
    pub detail: Detail,
}
fn choice(v: &str, choices: &[&str]) -> Result<()> {
    if choices.contains(&v) {
        Ok(())
    } else {
        Err(Error::Invalid(
            "unsupported clinical status or classification",
        ))
    }
}
impl Content {
    pub fn validate(&self) -> Result<()> {
        text(&self.title, 200)?;
        if self.notes.chars().count() > 10000 || self.codes.len() > 20 {
            return Err(Error::Invalid("clinical content exceeds supported limits"));
        }
        for c in &self.codes {
            text(&c.system, 200)?;
            text(&c.code, 120)?;
            if c.display.chars().count() > 200 {
                return Err(Error::Invalid("code display too long"));
            }
        }
        choice(
            &self.verification,
            &["unconfirmed", "confirmed", "refuted", "entered_in_error"],
        )?;
        let statuses = match self.detail {
            Detail::Problem { .. } => &[
                "active",
                "inactive",
                "resolved",
                "recurrence",
                "remission",
                "entered_in_error",
            ][..],
            Detail::Allergy { .. } => &["active", "inactive", "resolved", "entered_in_error"][..],
            Detail::Medication { .. } => &[
                "active",
                "on_hold",
                "stopped",
                "completed",
                "not_taken",
                "intended",
                "entered_in_error",
            ][..],
        };
        choice(&self.status, statuses)?;
        if (self.status == "entered_in_error") != (self.verification == "entered_in_error") {
            return Err(Error::Invalid(
                "entered-in-error requires matching status and verification",
            ));
        }
        if self.onset_date.is_some_and(|d| d > Utc::now().date_naive())
            || self.end_date.is_some_and(|d| d > Utc::now().date_naive())
            || matches!((self.onset_date,self.end_date),(Some(a),Some(b)) if b<a)
        {
            return Err(Error::Invalid("invalid clinical date sequence"));
        }
        if self.end_date.is_some()
            && matches!(
                self.status.as_str(),
                "active" | "recurrence" | "on_hold" | "intended"
            )
        {
            return Err(Error::Invalid("current entries cannot have an end date"));
        }
        match &self.detail {
            Detail::Problem { problem_type } => {
                choice(problem_type, &["problem", "diagnosis", "health_concern"])?
            }
            Detail::Allergy {
                category,
                reaction,
                severity,
                criticality,
            } => {
                choice(
                    category,
                    &["medication", "food", "environment", "biologic", "other"],
                )?;
                choice(severity, &["unknown", "mild", "moderate", "severe"])?;
                choice(criticality, &["unknown", "low", "high"])?;
                if reaction.chars().count() > 2000 {
                    return Err(Error::Invalid("reaction too long"));
                }
            }
            Detail::Medication {
                dose,
                route,
                frequency,
                indication,
            } => {
                for v in [dose, route, frequency, indication] {
                    if v.chars().count() > 500 {
                        return Err(Error::Invalid("medication instruction too long"));
                    }
                }
            }
        };
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub content: Content,
    pub reason: String,
    #[serde(default)]
    pub source_history_id: Option<Uuid>,
}
#[derive(Serialize, sqlx::FromRow)]
struct Entry {
    id: Uuid,
    patient_id: Uuid,
    kind: String,
    version: i64,
    content: Value,
    source_history_id: Option<Uuid>,
    created_by: Uuid,
    updated_by: Uuid,
    created_at: chrono::DateTime<Utc>,
    updated_at: chrono::DateTime<Utc>,
}
#[derive(Serialize, sqlx::FromRow)]
pub(crate) struct ListState {
    kind: String,
    version: i64,
    review_state: String,
    reviewed_by: Option<Uuid>,
    reviewed_at: Option<chrono::DateTime<Utc>>,
}
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn kind(k: &str) -> Result<()> {
    choice(k, &["problem", "allergy", "medication"])
}
async fn patient(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: Uuid) -> Result<()> {
    let found: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(p)
            .fetch_one(&mut **tx)
            .await?;
    if found {
        Ok(())
    } else {
        Err(Error::NotFound)
    }
}
pub(crate) async fn list_lock(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    k: &str,
) -> Result<ListState> {
    patient(tx, a, p).await?;
    sqlx::query("INSERT INTO clinical_list_state(tenant_id,patient_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(a.tenant_id).bind(p).bind(k).execute(&mut **tx).await?;
    Ok(sqlx::query_as("SELECT kind,version,review_state,reviewed_by,reviewed_at FROM clinical_list_state WHERE tenant_id=$1 AND patient_id=$2 AND kind=$3 FOR UPDATE").bind(a.tenant_id).bind(p).bind(k).fetch_one(&mut **tx).await?)
}
async fn revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    e: &Entry,
    reason: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO clinical_revisions(tenant_id,entry_id,version,content,author_id,reason) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(e.id).bind(e.version).bind(&e.content).bind(a.sub).bind(reason).execute(&mut **tx).await?;
    Ok(())
}
pub(crate) async fn invalidate(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    k: &str,
) -> Result<()> {
    sqlx::query("UPDATE clinical_list_state SET version=version+1,review_state='needs_review',reviewed_by=NULL,reviewed_at=NULL WHERE tenant_id=$1 AND patient_id=$2 AND kind=$3").bind(a.tenant_id).bind(p).bind(k).execute(&mut **tx).await?;
    Ok(())
}
fn response(e: Entry) -> Response {
    ([(header::ETAG, format!("\"{}\"", e.version))], Json(e)).into_response()
}
pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/patients/{patient}/clinical",
            get(lists).post(create),
        )
        .route("/api/v1/patients/{patient}/clinical/{id}", put(update))
        .route(
            "/api/v1/patients/{patient}/clinical/{id}/revisions",
            get(revisions),
        )
        .route(
            "/api/v1/patients/{patient}/clinical-review/{kind}",
            post(review),
        )
        .route(
            "/api/v1/patients/{patient}/history/{id}/mapping",
            get(mapping),
        )
}
async fn lists(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    patient(&mut tx, &a, p).await?;
    // One statement snapshot keeps list versions and entries consistent for reconciliation.
    let data:Value=sqlx::query_scalar("SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(e)-'tenant_id' ORDER BY e.kind,e.created_at,e.id) FROM clinical_entries e WHERE e.tenant_id=$1 AND e.patient_id=$2),'[]'::jsonb),'reviews',COALESCE((SELECT jsonb_agg(to_jsonb(l)-'tenant_id'-'patient_id') FROM clinical_list_state l WHERE l.tenant_id=$1 AND l.patient_id=$2),'[]'::jsonb),'review_history',COALESCE((SELECT jsonb_agg(to_jsonb(r)-'tenant_id'-'patient_id' ORDER BY r.created_at DESC) FROM clinical_reviews r WHERE r.tenant_id=$1 AND r.patient_id=$2),'[]'::jsonb))").bind(a.tenant_id).bind(p).fetch_one(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "patient.clinical.read", p).await?;
    tx.commit().await?;
    Ok(Json(data))
}
pub(crate) async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Json(input): Json<Change>,
) -> Result<Response> {
    a.clinical()?;
    input.content.validate()?;
    text(&input.reason, 1000)?;
    let k = input.content.detail.kind();
    let mut tx = db(&s)?.begin().await?;
    list_lock(&mut tx, &a, p, k).await?;
    if let Some(h) = input.source_history_id {
        let source: Option<String> = sqlx::query_scalar(
            "SELECT kind FROM historical_records WHERE tenant_id=$1 AND patient_id=$2 AND id=$3",
        )
        .bind(a.tenant_id)
        .bind(p)
        .bind(h)
        .fetch_optional(&mut *tx)
        .await?;
        let expected = if k == "problem" { "medical_problem" } else { k };
        if source.as_deref() != Some(expected) {
            return Err(Error::Invalid(
                "source history kind or patient does not match",
            ));
        }
    }
    let id = Uuid::new_v4();
    let e:Entry=sqlx::query_as("INSERT INTO clinical_entries(tenant_id,id,patient_id,kind,content,source_history_id,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id,patient_id,kind,version,content,source_history_id,created_by,updated_by,created_at,updated_at").bind(a.tenant_id).bind(id).bind(p).bind(k).bind(json!(input.content)).bind(input.source_history_id).bind(a.sub).fetch_one(&mut *tx).await?;
    revision(&mut tx, &a, &e, &input.reason).await?;
    invalidate(&mut tx, &a, p, k).await?;
    crate::postgres::audit(&mut tx, &a, "patient.clinical.create", p).await?;
    tx.commit().await?;
    Ok(response(e))
}
pub(crate) async fn update(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(input): Json<Change>,
) -> Result<Response> {
    a.clinical()?;
    input.content.validate()?;
    text(&input.reason, 1000)?;
    let v = crate::expected(&h)?;
    let k = input.content.detail.kind();
    let mut tx = db(&s)?.begin().await?;
    list_lock(&mut tx, &a, p, k).await?;
    let old:Entry=sqlx::query_as("SELECT id,patient_id,kind,version,content,source_history_id,created_by,updated_by,created_at,updated_at FROM clinical_entries WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR UPDATE").bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    if old.version != v {
        return Err(Error::Conflict(
            "clinical entry changed; reload before saving",
        ));
    }
    if old.kind != k || old.source_history_id != input.source_history_id {
        return Err(Error::Invalid(
            "clinical kind and source provenance cannot change",
        ));
    }
    let e:Entry=sqlx::query_as("UPDATE clinical_entries SET content=$4,version=version+1,updated_by=$5,updated_at=now() WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 RETURNING id,patient_id,kind,version,content,source_history_id,created_by,updated_by,created_at,updated_at").bind(a.tenant_id).bind(p).bind(id).bind(json!(input.content)).bind(a.sub).fetch_one(&mut *tx).await?;
    revision(&mut tx, &a, &e, &input.reason).await?;
    invalidate(&mut tx, &a, p, k).await?;
    crate::postgres::audit(&mut tx, &a, "patient.clinical.update", p).await?;
    tx.commit().await?;
    Ok(response(e))
}
async fn revisions(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let found:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM clinical_entries WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)").bind(a.tenant_id).bind(p).bind(id).fetch_one(&mut *tx).await?;
    if !found {
        return Err(Error::NotFound);
    }
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id' FROM clinical_revisions r WHERE tenant_id=$1 AND entry_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "patient.clinical_history.read", p).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Review {
    review_state: String,
    note: String,
}
async fn review(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, k)): Path<(Uuid, String)>,
    h: HeaderMap,
    Json(input): Json<Review>,
) -> Result<Json<Value>> {
    a.clinical()?;
    kind(&k)?;
    choice(&input.review_state, &["unknown", "reviewed", "no_known"])?;
    text(&input.note, 2000)?;
    let expected = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    let state = list_lock(&mut tx, &a, p, &k).await?;
    if state.version != expected {
        return Err(Error::Conflict("list changed; reload before reviewing"));
    }
    if input.review_state != "unknown" {
        let source_kind = if k == "problem" {
            "medical_problem"
        } else {
            &k
        };
        let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM historical_records h WHERE h.tenant_id=$1 AND h.patient_id=$2 AND h.kind=$3 AND NOT EXISTS(SELECT 1 FROM clinical_entries e WHERE e.tenant_id=h.tenant_id AND e.source_history_id=h.id))").bind(a.tenant_id).bind(p).bind(source_kind).fetch_one(&mut *tx).await?;
        if pending {
            return Err(Error::Conflict(
                "source list entries require clinical reconciliation before review",
            ));
        }
    }
    if input.review_state == "no_known" {
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM clinical_entries WHERE tenant_id=$1 AND patient_id=$2 AND kind=$3 AND content->>'status' IN ('active','recurrence','on_hold','intended') AND content->>'verification' NOT IN ('refuted','entered_in_error'))").bind(a.tenant_id).bind(p).bind(&k).fetch_one(&mut *tx).await?;
        if exists {
            return Err(Error::Conflict(
                "current entries conflict with no-known assertion",
            ));
        }
    }
    let l:ListState=sqlx::query_as("UPDATE clinical_list_state SET version=version+1,review_state=$4,reviewed_by=$5,reviewed_at=now() WHERE tenant_id=$1 AND patient_id=$2 AND kind=$3 RETURNING kind,version,review_state,reviewed_by,reviewed_at").bind(a.tenant_id).bind(p).bind(&k).bind(&input.review_state).bind(a.sub).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO clinical_reviews(tenant_id,patient_id,kind,version,review_state,author_id,note) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(a.tenant_id).bind(p).bind(&k).bind(l.version).bind(&input.review_state).bind(a.sub).bind(input.note).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "patient.clinical.review", p).await?;
    tx.commit().await?;
    Ok(Json(json!(l)))
}
fn source_text(row: &Value, key: &str) -> String {
    row.get(key)
        .and_then(|v| {
            v.as_str()
                .map(str::to_owned)
                .or_else(|| v.as_i64().map(|v| v.to_string()))
        })
        .unwrap_or_default()
}
fn source_date(row: &Value, key: &str, issues: &mut Vec<String>) -> Option<NaiveDate> {
    let v = source_text(row, key);
    if v.is_empty() || v.starts_with("0000-00-00") {
        return None;
    }
    match v.get(..10).and_then(|v| v.parse::<NaiveDate>().ok()) {
        Some(d) => Some(d),
        None => {
            issues.push(format!("{key}: date requires review"));
            None
        }
    }
}
pub fn map_source(k: &str, row: &Value) -> Result<Value> {
    let mut issues=vec!["Review every suggested value before creating a native entry. Terminology codes are preserved as source text until explicitly mapped.".to_string()];
    let onset_date = source_date(row, "begdate", &mut issues);
    let end_date = source_date(row, "enddate", &mut issues);
    let closed = end_date.is_some() || source_text(row, "activity") == "0";
    let (status, detail) = match k {
        "medical_problem" => (
            if closed { "inactive" } else { "active" },
            Detail::Problem {
                problem_type: "problem".into(),
            },
        ),
        "allergy" => (
            if closed { "inactive" } else { "active" },
            Detail::Allergy {
                category: "other".into(),
                reaction: source_text(row, "reaction"),
                severity: "unknown".into(),
                criticality: "unknown".into(),
            },
        ),
        "medication" => (
            if closed { "stopped" } else { "active" },
            Detail::Medication {
                dose: source_text(row, "dosage"),
                route: source_text(row, "route"),
                frequency: source_text(row, "frequency"),
                indication: String::new(),
            },
        ),
        _ => return Err(Error::Invalid("source kind has no native clinical mapping")),
    };
    if k == "allergy" {
        issues.push("Source category, severity, criticality and verification use installation-specific values; confirm them explicitly.".into());
    }
    if k == "medication" {
        issues.push("Confirm strength/dose/route/frequency; this is a medication statement, not a prescription or eRx transmission.".into());
    }
    let title = source_text(row, "title");
    if title.is_empty() {
        issues.push("Source title is missing; enter a clinically meaningful name.".into());
    }
    let notes = format!(
        "{}{}Source diagnosis/code text (unmapped): {}",
        source_text(row, "comments"),
        if source_text(row, "comments").is_empty() {
            ""
        } else {
            "\n"
        },
        source_text(row, "diagnosis")
    );
    let suggested = Content {
        title,
        status: status.into(),
        verification: "unconfirmed".into(),
        onset_date,
        end_date,
        codes: vec![],
        notes,
        detail,
    };
    Ok(
        json!({"content":suggested,"issues":issues,"mapping_version":"legacy-lists-v1","requires_clinician_review":true}),
    )
}
async fn mapping(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.clinical()?;
    let mut tx = db(&s)?.begin().await?;
    let row:Option<(String,Value)>=sqlx::query_as("SELECT kind,source_data FROM historical_records WHERE tenant_id=$1 AND patient_id=$2 AND id=$3").bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut *tx).await?;
    let (k, raw) = row.ok_or(Error::NotFound)?;
    let mut v = map_source(&k, &raw)?;
    let linked: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM clinical_entries WHERE tenant_id=$1 AND source_history_id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    v["source_history_id"] = json!(id);
    v["native_entry_id"] = json!(linked);
    v["source_data"] = raw;
    crate::postgres::audit(&mut tx, &a, "patient.clinical_mapping.read", p).await?;
    tx.commit().await?;
    Ok(Json(v))
}
