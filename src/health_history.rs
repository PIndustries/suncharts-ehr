// SPDX-License-Identifier: AGPL-3.0-only
//! Attributed surgical and dental history, separate from encounter diagnoses.
use crate::{
    auth::Actor,
    clinical::Coding,
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
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Content {
    pub kind: String,
    pub title: String,
    pub status: String,
    pub verification: String,
    pub onset_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub code: Option<Coding>,
    #[serde(default)]
    pub notes: String,
}
impl Content {
    fn validate(&self) -> Result<()> {
        if !["surgery", "dental"].contains(&self.kind.as_str())
            || !["active", "resolved", "completed", "entered_in_error"]
                .contains(&self.status.as_str())
            || !["unconfirmed", "confirmed", "refuted", "entered_in_error"]
                .contains(&self.verification.as_str())
        {
            return Err(Error::Invalid("unsupported health history classification"));
        }
        text(&self.title, 200)?;
        if self.notes.chars().count() > 10000 {
            return Err(Error::Invalid("health history notes too long"));
        }
        if let (Some(start), Some(end)) = (self.onset_date, self.end_date) {
            if end < start {
                return Err(Error::Invalid("end date precedes onset date"));
            }
        }
        if let Some(c) = &self.code {
            text(&c.system, 200)?;
            text(&c.code, 120)?;
            if c.display.chars().count() > 200 {
                return Err(Error::Invalid("code display too long"));
            }
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    request_id: Uuid,
    content: Content,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    content: Content,
    reason: String,
}
#[derive(Serialize, sqlx::FromRow)]
struct Entry {
    id: Uuid,
    patient_id: Uuid,
    version: i64,
    content: Value,
    created_by: Uuid,
    updated_by: Uuid,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
const FIELDS: &str = "id,patient_id,version,content,created_by,updated_by,created_at,updated_at";
pub fn routes() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/patients/{patient}/health-history",
            get(list).post(create),
        )
        .route(
            "/api/v1/patients/{patient}/health-history/{id}",
            get(read).put(update),
        )
        .route(
            "/api/v1/patients/{patient}/health-history/{id}/revisions",
            get(revisions),
        )
}
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
async fn patient(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: Uuid) -> Result<()> {
    if sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)",
    )
    .bind(a.tenant_id)
    .bind(p)
    .fetch_one(&mut **tx)
    .await?
    {
        Ok(())
    } else {
        Err(Error::NotFound)
    }
}
async fn entry(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    id: Uuid,
    lock: bool,
) -> Result<Entry> {
    let q=format!("SELECT {FIELDS} FROM health_history_entries WHERE tenant_id=$1 AND patient_id=$2 AND id=$3{}",if lock{" FOR UPDATE"}else{""});
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
async fn list(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut filters = BTreeMap::new();
    for (k, v) in url::form_urlencoded::parse(raw.as_deref().unwrap_or("").as_bytes()) {
        if !["kind", "status", "_count", "_after"].contains(&k.as_ref())
            || filters.insert(k.to_string(), v.to_string()).is_some()
        {
            return Err(Error::Invalid("unsupported or repeated history filter"));
        }
    }
    let kind = filters.get("kind");
    let status = filters.get("status");
    if kind.is_some_and(|k| !["surgery", "dental"].contains(&k.as_str()))
        || status.is_some_and(|k| {
            !["active", "resolved", "completed", "entered_in_error"].contains(&k.as_str())
        })
    {
        return Err(Error::Invalid("unsupported history filter"));
    }
    let count = filters
        .get("_count")
        .map(|s| s.parse::<i64>())
        .transpose()
        .map_err(|_| Error::Invalid("invalid page size"))?
        .unwrap_or(50);
    if !(1..=100).contains(&count) {
        return Err(Error::Invalid("page size must be 1 to 100"));
    }
    let after = filters
        .get("_after")
        .map(|s| Uuid::parse_str(s))
        .transpose()
        .map_err(|_| Error::Invalid("invalid history cursor"))?;
    let mut tx = db(&s)?.begin().await?;
    patient(&mut tx, &a, p).await?;
    let q=format!("SELECT {FIELDS} FROM health_history_entries WHERE tenant_id=$1 AND patient_id=$2 AND ($3::text IS NULL OR content->>'kind'=$3) AND ($4::text IS NULL OR content->>'status'=$4) AND ($5::uuid IS NULL OR id>$5) ORDER BY id LIMIT $6");
    let mut items: Vec<Entry> = sqlx::query_as(&q)
        .bind(a.tenant_id)
        .bind(p)
        .bind(kind)
        .bind(status)
        .bind(after)
        .bind(count + 1)
        .fetch_all(&mut *tx)
        .await?;
    let more = items.len() > count as usize;
    items.truncate(count as usize);
    let cursor = if more {
        items.last().map(|e| e.id)
    } else {
        None
    };
    audit(&mut tx, &a, "patient.health_history.read", p).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next_cursor":cursor})))
}
async fn read(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let e = entry(&mut tx, &a, p, id, false).await?;
    audit(&mut tx, &a, "patient.health_history.read", p).await?;
    tx.commit().await?;
    Ok(response(e))
}
async fn revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    e: &Entry,
    reason: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO health_history_revisions(tenant_id,entry_id,version,content,author_id,reason) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(e.id).bind(e.version).bind(&e.content).bind(a.sub).bind(reason.trim()).execute(&mut **tx).await?;
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
    patient(&mut tx, &a, p).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("{}:health-history:{}", a.tenant_id, v.request_id))
        .execute(&mut *tx)
        .await?;
    let request = json!({"patient_id":p,"content":v.content,"reason":v.reason});
    let previous:Option<(Uuid,Uuid,Value)>=sqlx::query_as("SELECT id,patient_id,create_request FROM health_history_entries WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(v.request_id).fetch_optional(&mut *tx).await?;
    if let Some((id, patient_id, old)) = previous {
        if patient_id != p || old != request {
            return Err(Error::Conflict(
                "request identity was used for different health history",
            ));
        }
        let e = entry(&mut tx, &a, p, id, false).await?;
        audit(&mut tx, &a, "patient.health_history.replay", p).await?;
        tx.commit().await?;
        return Ok(response(e));
    }
    let q=format!("INSERT INTO health_history_entries(tenant_id,id,patient_id,request_id,create_request,content,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING {FIELDS}");
    let e = sqlx::query_as(&q)
        .bind(a.tenant_id)
        .bind(Uuid::new_v4())
        .bind(p)
        .bind(v.request_id)
        .bind(request)
        .bind(json!(v.content))
        .bind(a.sub)
        .fetch_one(&mut *tx)
        .await?;
    revision(&mut tx, &a, &e, &v.reason).await?;
    audit(&mut tx, &a, "patient.health_history.create", p).await?;
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
    if old.version != version {
        return Err(Error::Conflict(
            "health history changed; compare current version before saving",
        ));
    }
    if old.content["kind"] != v.content.kind {
        return Err(Error::Invalid("history kind cannot change"));
    }
    let q=format!("UPDATE health_history_entries SET content=$4,version=version+1,updated_by=$5,updated_at=now() WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 RETURNING {FIELDS}");
    let e = sqlx::query_as(&q)
        .bind(a.tenant_id)
        .bind(p)
        .bind(id)
        .bind(json!(v.content))
        .bind(a.sub)
        .fetch_one(&mut *tx)
        .await?;
    revision(&mut tx, &a, &e, &v.reason).await?;
    audit(&mut tx, &a, "patient.health_history.update", p).await?;
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
    let mut items=sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('version',version,'content',content,'author_id',author_id,'actor_label',(SELECT coalesce(nullif(u.display_name,''),u.email) FROM browser_users u WHERE u.tenant_id=r.tenant_id AND u.id=r.author_id),'reason',reason,'created_at',created_at) FROM health_history_revisions r WHERE tenant_id=$1 AND entry_id=$2 ORDER BY version DESC LIMIT 101").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let truncated = items.len() > 100;
    items.truncate(100);
    audit(&mut tx, &a, "patient.health_history.revisions", p).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"truncated":truncated})))
}
