// SPDX-License-Identifier: AGPL-3.0-only
//! Local referral coordination. Recorded external milestones are staff evidence, not transmission.
use crate::{
    auth::Actor,
    error::{Error, Result},
    model::text,
    postgres::audit,
    State,
};
use axum::{
    extract::{Path, RawQuery, State as ExtractState},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use std::collections::BTreeMap;
use uuid::Uuid;
const STATUSES: [&str; 8] = [
    "draft",
    "ready",
    "sent",
    "accepted",
    "scheduled",
    "completed",
    "cancelled",
    "entered_in_error",
];
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Content {
    pub requested_service: String,
    pub recipient: String,
    #[serde(default)]
    pub specialty: String,
    pub priority: String,
    pub clinical_reason: String,
    #[serde(default)]
    pub clinical_summary: String,
    pub follow_up_due: Option<NaiveDate>,
    #[serde(default)]
    pub document_ids: Vec<Uuid>,
}
impl Content {
    fn validate(&self) -> Result<()> {
        if self.document_ids.len() > 20
            || self
                .document_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != self.document_ids.len()
        {
            return Err(Error::Invalid(
                "select at most 20 distinct referral documents",
            ));
        }
        text(&self.requested_service, 200)?;
        text(&self.recipient, 300)?;
        text(&self.clinical_reason, 2000)?;
        if !["routine", "urgent"].contains(&self.priority.as_str())
            || self.specialty.chars().count() > 200
            || self.clinical_summary.chars().count() > 10000
        {
            return Err(Error::Invalid(
                "invalid referral priority or content length",
            ));
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    request_id: Uuid,
    visit_id: Option<Uuid>,
    content: Content,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    visit_id: Option<Uuid>,
    content: Content,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    action: String,
    reason: String,
    #[serde(default)]
    evidence: String,
}
#[derive(Serialize, sqlx::FromRow)]
struct Entry {
    id: Uuid,
    patient_id: Uuid,
    visit_id: Option<Uuid>,
    version: i64,
    status: String,
    content: Value,
    attachment_snapshot: Option<Value>,
    created_by: Uuid,
    updated_by: Uuid,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
const FIELDS: &str =
    "id,patient_id,visit_id,version,status,content,attachment_snapshot,created_by,updated_by,created_at,updated_at";
pub fn routes() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/patients/{patient}/referrals",
            get(list).post(create),
        )
        .route(
            "/api/v1/patients/{patient}/referrals/{id}",
            get(read).put(update),
        )
        .route(
            "/api/v1/patients/{patient}/referrals/{id}/actions",
            axum::routing::post(action),
        )
        .route(
            "/api/v1/patients/{patient}/referrals/{id}/revisions",
            get(revisions),
        )
        .route("/api/v1/referrals/worklist", get(worklist))
}
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
async fn context(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    v: Option<Uuid>,
) -> Result<()> {
    let found: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(p)
            .fetch_one(&mut **tx)
            .await?;
    if !found {
        return Err(Error::NotFound);
    }
    if let Some(id) = v {
        let found: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)",
        )
        .bind(a.tenant_id)
        .bind(p)
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
        if !found {
            return Err(Error::NotFound);
        }
    }
    Ok(())
}
async fn entry(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    id: Uuid,
    lock: bool,
) -> Result<Entry> {
    let q = format!(
        "SELECT {FIELDS} FROM referrals WHERE tenant_id=$1 AND patient_id=$2 AND id=$3{}",
        if lock { " FOR UPDATE" } else { "" }
    );
    sqlx::query_as(&q)
        .bind(a.tenant_id)
        .bind(p)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
fn response(e: Entry) -> Response {
    ([(header::ETAG, format!("\"{}\"", e.version))], Json(e)).into_response()
}
struct Filters {
    status: Option<String>,
    after: Option<Uuid>,
    count: i64,
    overdue: bool,
}
fn filters(raw: Option<&str>, worklist: bool) -> Result<Filters> {
    let mut p = BTreeMap::new();
    for (k, v) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
        if !(["status", "_after", "_count"].contains(&k.as_ref()) || worklist && k == "overdue")
            || p.insert(k.to_string(), v.to_string()).is_some()
        {
            return Err(Error::Invalid("unsupported or repeated referral filter"));
        }
    }
    let status = p.get("status").cloned();
    if status
        .as_ref()
        .is_some_and(|v| !STATUSES.contains(&v.as_str()))
    {
        return Err(Error::Invalid("invalid referral status"));
    }
    let after = p
        .get("_after")
        .map(|v| Uuid::parse_str(v))
        .transpose()
        .map_err(|_| Error::Invalid("invalid referral cursor"))?;
    let count = p
        .get("_count")
        .map(|v| v.parse::<i64>())
        .transpose()
        .map_err(|_| Error::Invalid("invalid referral page size"))?
        .unwrap_or(50);
    if !(1..=100).contains(&count) {
        return Err(Error::Invalid("referral page size must be 1 to 100"));
    }
    let overdue = match p.get("overdue").map(String::as_str) {
        None | Some("false") => false,
        Some("true") => true,
        _ => return Err(Error::Invalid("overdue must be true or false")),
    };
    Ok(Filters {
        status,
        after,
        count,
        overdue,
    })
}
async fn list(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>> {
    a.staff()?;
    let f = filters(raw.as_deref(), false)?;
    let mut tx = db(&s)?.begin().await?;
    context(&mut tx, &a, p, None).await?;
    let q=format!("SELECT {FIELDS} FROM referrals WHERE tenant_id=$1 AND patient_id=$2 AND ($3::text IS NULL OR status=$3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5");
    let mut items: Vec<Entry> = sqlx::query_as(&q)
        .bind(a.tenant_id)
        .bind(p)
        .bind(f.status)
        .bind(f.after)
        .bind(f.count + 1)
        .fetch_all(&mut *tx)
        .await?;
    let more = items.len() > f.count as usize;
    items.truncate(f.count as usize);
    let cursor = if more {
        items.last().map(|e| e.id)
    } else {
        None
    };
    audit(&mut tx, &a, "patient.referrals.read", p).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next_cursor":cursor})))
}
async fn worklist(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>> {
    a.staff()?;
    let f = filters(raw.as_deref(), true)?;
    let mut tx = db(&s)?.begin().await?;
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT (to_jsonb(r)-'tenant_id'-'request_id'-'create_request') || jsonb_build_object('patient_label',p.family_name || ', ' || p.given_name,'mrn',p.mrn) FROM referrals r JOIN patients p ON p.tenant_id=r.tenant_id AND p.id=r.patient_id WHERE r.tenant_id=$1 AND ($2::text IS NULL OR r.status=$2) AND ($3::uuid IS NULL OR r.id>$3) AND (NOT $4 OR (r.status NOT IN ('completed','cancelled','entered_in_error') AND (r.content->>'follow_up_due')::date<(now() AT TIME ZONE 'UTC')::date)) ORDER BY r.id LIMIT $5").bind(a.tenant_id).bind(f.status).bind(f.after).bind(f.overdue).bind(f.count+1).fetch_all(&mut *tx).await?;
    let more = items.len() > f.count as usize;
    items.truncate(f.count as usize);
    let cursor = if more {
        items
            .last()
            .and_then(|e| e["id"].as_str())
            .map(String::from)
    } else {
        None
    };
    audit(&mut tx, &a, "practice.referrals.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":items,"next_cursor":cursor,"overdue_as_of":Utc::now().date_naive()}),
    ))
}
async fn read(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let e = entry(&mut tx, &a, p, id, false).await?;
    audit(&mut tx, &a, "patient.referrals.read", p).await?;
    tx.commit().await?;
    Ok(response(e))
}
async fn attachment_snapshot(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    ids: &[Uuid],
) -> Result<Value> {
    let mut out = Vec::new();
    let mut sorted = ids.to_vec();
    sorted.sort();
    for id in sorted {
        out.push(crate::documents::validate_link(tx, a.tenant_id, p, id).await?);
    }
    Ok(json!(out))
}
async fn revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    e: &Entry,
    reason: &str,
    evidence: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO referral_revisions(tenant_id,referral_id,version,status,visit_id,content,attachment_snapshot,author_id,reason,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(a.tenant_id).bind(e.id).bind(e.version).bind(&e.status).bind(e.visit_id).bind(&e.content).bind(&e.attachment_snapshot).bind(a.sub).bind(reason.trim()).bind(evidence.trim()).execute(&mut **tx).await?;
    Ok(())
}
async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Json(v): Json<Create>,
) -> Result<Response> {
    a.clinical()?;
    v.content.validate()?;
    text(&v.reason, 1000)?;
    let mut tx = db(&s)?.begin().await?;
    context(&mut tx, &a, p, v.visit_id).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("{}:referral:{}", a.tenant_id, v.request_id))
        .execute(&mut *tx)
        .await?;
    let request =
        json!({"patient_id":p,"visit_id":v.visit_id,"content":v.content,"reason":v.reason});
    let previous: Option<(Uuid, Uuid, Value)> = sqlx::query_as(
        "SELECT id,patient_id,create_request FROM referrals WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((id, patient, old)) = previous {
        if patient != p || old != request {
            return Err(Error::Conflict(
                "referral request identity was used for different content",
            ));
        }
        let e = entry(&mut tx, &a, p, id, false).await?;
        audit(&mut tx, &a, "patient.referrals.replay", p).await?;
        tx.commit().await?;
        return Ok(response(e));
    }
    attachment_snapshot(&mut tx, &a, p, &v.content.document_ids).await?;
    let q=format!("INSERT INTO referrals(tenant_id,id,patient_id,visit_id,request_id,create_request,content,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING {FIELDS}");
    let e = sqlx::query_as(&q)
        .bind(a.tenant_id)
        .bind(Uuid::new_v4())
        .bind(p)
        .bind(v.visit_id)
        .bind(v.request_id)
        .bind(request)
        .bind(json!(v.content))
        .bind(a.sub)
        .fetch_one(&mut *tx)
        .await?;
    revision(&mut tx, &a, &e, &v.reason, "").await?;
    audit(&mut tx, &a, "patient.referrals.create", p).await?;
    tx.commit().await?;
    Ok(response(e))
}
async fn update(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<Change>,
) -> Result<Response> {
    a.clinical()?;
    v.content.validate()?;
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    let old = entry(&mut tx, &a, p, id, true).await?;
    if old.version != version || !["draft", "ready"].contains(&old.status.as_str()) {
        return Err(Error::Conflict(
            "only the current draft or ready referral content can be edited",
        ));
    }
    crate::referral_delivery::ensure_unreserved(&mut tx, a.tenant_id, id).await?;
    context(&mut tx, &a, p, v.visit_id).await?;
    attachment_snapshot(&mut tx, &a, p, &v.content.document_ids).await?;
    let q=format!("UPDATE referrals SET visit_id=$4,content=$5,status='draft',attachment_snapshot=NULL,version=version+1,updated_by=$6,updated_at=now() WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 RETURNING {FIELDS}");
    let e = sqlx::query_as(&q)
        .bind(a.tenant_id)
        .bind(p)
        .bind(id)
        .bind(v.visit_id)
        .bind(json!(v.content))
        .bind(a.sub)
        .fetch_one(&mut *tx)
        .await?;
    revision(&mut tx, &a, &e, &v.reason, "").await?;
    audit(&mut tx, &a, "patient.referrals.update", p).await?;
    tx.commit().await?;
    Ok(response(e))
}
fn allowed(status: &str) -> &'static [&'static str] {
    match status {
        "draft" => &["ready", "cancelled", "entered_in_error"],
        "ready" => &["draft", "sent", "cancelled", "entered_in_error"],
        "sent" => &["accepted", "cancelled", "entered_in_error"],
        "accepted" => &["scheduled", "completed", "cancelled", "entered_in_error"],
        "scheduled" => &["completed", "cancelled", "entered_in_error"],
        "completed" => &["entered_in_error"],
        _ => &[],
    }
}
async fn action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<Action>,
) -> Result<Response> {
    a.clinical()?;
    text(&v.reason, 1000)?;
    if v.evidence.chars().count() > 4000 {
        return Err(Error::Invalid("referral evidence too long"));
    }
    if ["sent", "accepted", "scheduled", "completed"].contains(&v.action.as_str()) {
        text(&v.evidence, 4000)?;
    }
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    let old = entry(&mut tx, &a, p, id, true).await?;
    if old.version != version || !allowed(&old.status).contains(&v.action.as_str()) {
        return Err(Error::Conflict(
            "referral changed or transition is not allowed",
        ));
    }
    crate::referral_delivery::ensure_unreserved(&mut tx, a.tenant_id, id).await?;
    let documents: Content = serde_json::from_value(old.content.clone())
        .map_err(|_| Error::Invalid("invalid stored referral"))?;
    let snapshot = if v.action == "ready" || v.action == "sent" {
        let current = attachment_snapshot(&mut tx, &a, p, &documents.document_ids).await?;
        if v.action == "sent" && old.attachment_snapshot.as_ref() != Some(&current) {
            return Err(Error::Conflict(
                "referral attachments changed; return to draft and review readiness again",
            ));
        }
        Some(current)
    } else if v.action == "draft" {
        None
    } else {
        old.attachment_snapshot
    };
    let q=format!("UPDATE referrals SET status=$4,version=version+1,updated_by=$5,updated_at=now(),attachment_snapshot=$6 WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 RETURNING {FIELDS}");
    let e = sqlx::query_as(&q)
        .bind(a.tenant_id)
        .bind(p)
        .bind(id)
        .bind(v.action)
        .bind(a.sub)
        .bind(snapshot)
        .fetch_one(&mut *tx)
        .await?;
    revision(&mut tx, &a, &e, &v.reason, &v.evidence).await?;
    audit(&mut tx, &a, "patient.referrals.action", p).await?;
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
    entry(&mut tx, &a, p, id, false).await?;
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('version',version,'status',status,'visit_id',visit_id,'content',content,'attachment_snapshot',attachment_snapshot,'author_id',author_id,'actor_label',(SELECT coalesce(nullif(u.display_name,''),u.email) FROM browser_users u WHERE u.tenant_id=r.tenant_id AND u.id=r.author_id),'reason',reason,'evidence',evidence,'created_at',created_at) FROM referral_revisions r WHERE tenant_id=$1 AND referral_id=$2 ORDER BY version DESC LIMIT 101").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let truncated = items.len() > 100;
    items.truncate(100);
    audit(&mut tx, &a, "patient.referrals.revisions", p).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"truncated":truncated})))
}
