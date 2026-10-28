// SPDX-License-Identifier: AGPL-3.0-only
//! Vaccine event documentation, not vaccine forecasting or registry exchange.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    model::text,
    State,
};
use axum::{
    extract::{Path, RawQuery, State as ExtractState},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::BTreeMap;
use uuid::Uuid;
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Dose {
    pub value: String,
    pub unit: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Content {
    pub record_type: String,
    pub status: String,
    pub vaccine_name: String,
    pub vaccine_code: Option<crate::clinical::Coding>,
    pub occurred_at: Option<DateTime<Utc>>,
    pub occurred_on: Option<NaiveDate>,
    pub occurrence_text: Option<String>,
    pub primary_source: bool,
    #[serde(default)]
    pub report_origin: String,
    pub visit_id: Option<Uuid>,
    pub performer_id: Option<Uuid>,
    #[serde(default)]
    pub manufacturer: String,
    #[serde(default)]
    pub lot_number: String,
    pub expiration_date: Option<NaiveDate>,
    #[serde(default)]
    pub route: String,
    #[serde(default)]
    pub site: String,
    pub dose: Option<Dose>,
    #[serde(default)]
    pub not_done_reason: String,
    #[serde(default)]
    pub notes: String,
}
impl Content {
    pub(crate) fn validate(&self) -> Result<()> {
        if !["administered", "historical", "not_given"].contains(&self.record_type.as_str())
            || !["completed", "not_done", "entered_in_error"].contains(&self.status.as_str())
        {
            return Err(Error::Invalid(
                "unsupported immunization record type or status",
            ));
        }
        if self.status != "entered_in_error"
            && ((self.record_type == "not_given") != (self.status == "not_done"))
        {
            return Err(Error::Invalid("not-given records require not_done; administered/history records require completed"));
        }
        text(&self.vaccine_name, 200)?;
        if let Some(c) = &self.vaccine_code {
            text(&c.system, 200)?;
            text(&c.code, 120)?;
            if c.display.chars().count() > 200 {
                return Err(Error::Invalid("vaccine code display too long"));
            }
        }
        if [
            self.occurred_at.is_some(),
            self.occurred_on.is_some(),
            self.occurrence_text.is_some(),
        ]
        .into_iter()
        .filter(|v| *v)
        .count()
            != 1
        {
            return Err(Error::Invalid(
                "provide exactly one occurrence timestamp, date or historical description",
            ));
        }
        if let Some(v) = &self.occurrence_text {
            if self.record_type != "historical" {
                return Err(Error::Invalid(
                    "unknown occurrence is only supported for historical reports",
                ));
            }
            text(v, 200)?;
        }
        if self.record_type == "administered"
            && (self.occurred_at.is_none()
                || self.performer_id.is_none()
                || self.dose.is_none()
                || self.route.trim().is_empty()
                || self.site.trim().is_empty())
        {
            return Err(Error::Invalid("administered vaccine requires actual time, administering staff, dose, route and site"));
        }
        if self.occurred_at.is_some_and(|v| v > Utc::now())
            || self
                .occurred_on
                .is_some_and(|v| v > Utc::now().date_naive())
        {
            return Err(Error::Invalid(
                "immunization occurrence cannot be in the future",
            ));
        }
        if self.primary_source && !self.report_origin.is_empty()
            || !self.primary_source && self.report_origin.trim().is_empty()
        {
            return Err(Error::Invalid(
                "secondary reports require a source; primary-source records omit report_origin",
            ));
        }
        if self.record_type == "not_given"
            && (self.not_done_reason.trim().is_empty()
                || self.dose.is_some()
                || self.performer_id.is_some()
                || !self.lot_number.is_empty())
        {
            return Err(Error::Invalid("not-given record requires reason and cannot assert an administered dose, lot or performer"));
        }
        if self.record_type != "not_given" && !self.not_done_reason.is_empty() {
            return Err(Error::Invalid(
                "not_done_reason applies only to not-given events",
            ));
        }
        for (v, max) in [
            (&self.report_origin, 200),
            (&self.manufacturer, 200),
            (&self.lot_number, 100),
            (&self.route, 100),
            (&self.site, 100),
            (&self.not_done_reason, 1000),
            (&self.notes, 10000),
        ] {
            if v.chars().count() > max
                || v.chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            {
                return Err(Error::Invalid(
                    "immunization text exceeds limits or contains invalid characters",
                ));
            }
        }
        if let Some(d) = &self.dose {
            let parts: Vec<_> = d.value.split('.').collect();
            if parts.is_empty()
                || parts.len() > 2
                || parts[0].len() > 7
                || parts
                    .iter()
                    .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
                || parts.get(1).is_some_and(|p| p.len() > 3)
                || !d.value.bytes().any(|b| b.is_ascii_digit() && b != b'0')
            {
                return Err(Error::Invalid("dose must be a positive decimal with at most seven integer and three fractional digits"));
            }
            text(&d.unit, 80)?;
        }
        Ok(())
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub request_id: Uuid,
    pub content: Content,
    pub reason: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub request_id: Uuid,
    pub content: Content,
    pub reason: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ErrorAction {
    request_id: Uuid,
    reason: String,
}
pub(crate) fn writer(a: &Actor) -> Result<()> {
    if matches!(a.role, Role::Owner | Role::Clinician | Role::Nurse) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
async fn patient(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: Uuid) -> Result<NaiveDate> {
    sqlx::query_scalar("SELECT birth_date FROM patients WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(p)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn lock<'a>(s: &'a State, a: &Actor) -> Result<Transaction<'a, Postgres>> {
    let mut tx = db(s)?.begin().await?;
    crate::scheduling::tenant_lock(&mut tx, a).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,47))")
        .bind(a.tenant_id.to_string())
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}
async fn context(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    c: &Content,
) -> Result<Option<Value>> {
    let birth = patient(tx, a, p).await?;
    let occurred = c.occurred_on.or(c.occurred_at.map(|v| v.date_naive()));
    if occurred.is_some_and(|d| d < birth) {
        return Err(Error::Invalid("occurrence precedes patient birth date"));
    }
    if let Some(v) = c.visit_id {
        let ok: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)",
        )
        .bind(a.tenant_id)
        .bind(p)
        .bind(v)
        .fetch_one(&mut **tx)
        .await?;
        if !ok {
            return Err(Error::Invalid("encounter must belong to patient"));
        }
    }
    if let Some(id) = c.performer_id {
        let v:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'display',coalesce(nullif(display_name,''),email)) FROM browser_users WHERE tenant_id=$1 AND id=$2 AND NOT disabled AND role IN('owner','clinician','nurse') FOR SHARE").bind(a.tenant_id).bind(id).fetch_optional(&mut **tx).await?;
        Ok(Some(v.ok_or(Error::Invalid(
            "performer must be active immunization-authorized staff in this practice",
        ))?))
    } else {
        Ok(None)
    }
}
pub(crate) async fn row(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Option<Uuid>,
    id: Uuid,
) -> Result<Value> {
    sqlx::query_scalar("SELECT to_jsonb(i)-'tenant_id' FROM immunizations i WHERE tenant_id=$1 AND id=$2 AND ($3::uuid IS NULL OR patient_id=$3) FOR UPDATE").bind(a.tenant_id).bind(id).bind(p).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn replay(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    op: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let old:Option<(Uuid,String,Value,Value)>=sqlx::query_as("SELECT actor_id,operation,request,response FROM immunization_requests WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(id).fetch_optional(&mut **tx).await?;
    match old {
        Some((actor, operation, request, response))
            if actor == a.sub && operation == op && request == *input =>
        {
            Ok(Some(response))
        }
        Some(_) => Err(Error::Conflict(
            "immunization request identity was reused with another actor or content",
        )),
        None => Ok(None),
    }
}
async fn save(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    op: &str,
    input: &Value,
    out: &Value,
    reason: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO immunization_revisions(tenant_id,immunization_id,version,actor_id,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(out["id"].as_str().unwrap().parse::<Uuid>().unwrap()).bind(out["version"].as_i64().unwrap()).bind(a.sub).bind(reason).bind(out).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO immunization_requests(tenant_id,request_id,actor_id,operation,request,response) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(a.sub).bind(op).bind(input).bind(out).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, op, out["id"].as_str().unwrap().parse().unwrap()).await
}
pub(crate) async fn create_record(s: &State, a: &Actor, p: Uuid, v: Create) -> Result<Value> {
    writer(a)?;
    v.content.validate()?;
    if v.content.status == "entered_in_error" {
        return Err(Error::Invalid(
            "new immunizations cannot start entered-in-error",
        ));
    }
    text(&v.reason, 1000)?;
    let input = json!({"patient":p,"body":v});
    let mut tx = lock(s, a).await?;
    if let Some(out) = replay(
        &mut tx,
        a,
        v.request_id,
        "patient.immunization.create",
        &input,
    )
    .await?
    {
        tx.commit().await?;
        return Ok(out);
    }
    let performer = context(&mut tx, a, p, &v.content).await?;
    let out:Value=sqlx::query_scalar("INSERT INTO immunizations(tenant_id,id,patient_id,content,performer_snapshot,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING to_jsonb(immunizations)-'tenant_id'").bind(a.tenant_id).bind(Uuid::new_v4()).bind(p).bind(json!(v.content)).bind(performer).bind(a.sub).fetch_one(&mut *tx).await?;
    save(
        &mut tx,
        a,
        v.request_id,
        "patient.immunization.create",
        &input,
        &out,
        &v.reason,
    )
    .await?;
    tx.commit().await?;
    Ok(out)
}
pub(crate) async fn update_record(
    s: &State,
    a: &Actor,
    p: Uuid,
    id: Uuid,
    expected: i64,
    v: Change,
) -> Result<Value> {
    writer(a)?;
    v.content.validate()?;
    text(&v.reason, 1000)?;
    let input = json!({"patient":p,"id":id,"version":expected,"body":v});
    let mut tx = lock(s, a).await?;
    if let Some(out) = replay(
        &mut tx,
        a,
        v.request_id,
        "patient.immunization.correct",
        &input,
    )
    .await?
    {
        tx.commit().await?;
        return Ok(out);
    }
    let old = row(&mut tx, a, Some(p), id).await?;
    if old["version"] != expected {
        return Err(Error::Conflict(
            "immunization changed; reload before saving",
        ));
    }
    if old["content"]["status"] == "entered_in_error"
        || old["content"]["status"] != v.content.status
        || old["content"]["record_type"] != v.content.record_type
    {
        return Err(Error::Conflict("record type/status cannot change through correction; mark an incorrect event entered-in-error and record its replacement"));
    }
    let performer = if old["content"]["performer_id"] == json!(v.content.performer_id) {
        context_without_performer(&mut tx, a, p, &v.content).await?;
        old["performer_snapshot"].clone()
    } else {
        context(&mut tx, a, p, &v.content)
            .await?
            .unwrap_or(Value::Null)
    };
    let out:Value=sqlx::query_scalar("UPDATE immunizations SET content=$3,performer_snapshot=$4,updated_by=$5,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING to_jsonb(immunizations)-'tenant_id'").bind(a.tenant_id).bind(id).bind(json!(v.content)).bind(performer).bind(a.sub).fetch_one(&mut *tx).await?;
    save(
        &mut tx,
        a,
        v.request_id,
        "patient.immunization.correct",
        &input,
        &out,
        &v.reason,
    )
    .await?;
    tx.commit().await?;
    Ok(out)
}
async fn context_without_performer(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    c: &Content,
) -> Result<()> {
    let mut c = c.clone();
    c.performer_id = None;
    context(tx, a, p, &c).await?;
    Ok(())
}
fn response(v: Value) -> Response {
    ([(header::ETAG, format!("\"{}\"", v["version"]))], Json(v)).into_response()
}
pub fn routes() -> Router<State> {
    Router::new()
        .route("/api/v1/immunizations/performers", get(performers))
        .route(
            "/api/v1/patients/{patient}/immunizations",
            get(list).post(create),
        )
        .route(
            "/api/v1/patients/{patient}/immunizations/{id}",
            get(read).put(update),
        )
        .route(
            "/api/v1/patients/{patient}/immunizations/{id}/revisions",
            get(revisions),
        )
        .route(
            "/api/v1/patients/{patient}/immunizations/{id}/entered-in-error",
            post(enter_error),
        )
}
async fn performers(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'display',coalesce(nullif(display_name,''),email)) FROM browser_users WHERE tenant_id=$1 AND NOT disabled AND role IN('owner','clinician','nurse') ORDER BY id LIMIT 501").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    let truncated = items.len() > 500;
    items.truncate(500);
    crate::postgres::audit(
        &mut tx,
        &a,
        "patient.immunization.performers_read",
        a.tenant_id,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"truncated":truncated})))
}
async fn list(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut params = BTreeMap::new();
    for (k, v) in url::form_urlencoded::parse(raw.as_deref().unwrap_or("").as_bytes()) {
        if !["_after", "_count", "status"].contains(&k.as_ref())
            || params.insert(k.into_owned(), v.into_owned()).is_some()
        {
            return Err(Error::Invalid(
                "unsupported or repeated immunization filter",
            ));
        }
    }
    let after = params
        .get("_after")
        .map(|v| v.parse::<Uuid>())
        .transpose()
        .map_err(|_| Error::Invalid("invalid immunization cursor"))?;
    let count = params
        .get("_count")
        .map(|v| v.parse::<i64>())
        .transpose()
        .map_err(|_| Error::Invalid("invalid count"))?
        .unwrap_or(50);
    if !(1..=100).contains(&count) {
        return Err(Error::Invalid("count must be 1 to 100"));
    }
    let status = params.get("status");
    if status.is_some_and(|v| !["completed", "not_done", "entered_in_error"].contains(&v.as_str()))
    {
        return Err(Error::Invalid("invalid immunization status filter"));
    }
    let mut tx = db(&s)?.begin().await?;
    patient(&mut tx, &a, p).await?;
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(i)-'tenant_id' FROM immunizations i WHERE tenant_id=$1 AND patient_id=$2 AND ($3::uuid IS NULL OR id>$3) AND ($4::text IS NULL OR content->>'status'=$4) ORDER BY id LIMIT $5").bind(a.tenant_id).bind(p).bind(after).bind(status).bind(count+1).fetch_all(&mut *tx).await?;
    let more = items.len() > count as usize;
    items.truncate(count as usize);
    let next = if more {
        items.last().map(|v| v["id"].clone())
    } else {
        None
    };
    crate::postgres::audit(&mut tx, &a, "patient.immunization.read", p).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next_cursor":next})))
}
async fn read(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let out = row(&mut tx, &a, Some(p), id).await?;
    crate::postgres::audit(&mut tx, &a, "patient.immunization.read", id).await?;
    tx.commit().await?;
    Ok(response(out))
}
async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Json(v): Json<Create>,
) -> Result<Response> {
    Ok(response(create_record(&s, &a, p, v).await?))
}
async fn update(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<Change>,
) -> Result<Response> {
    Ok(response(
        update_record(&s, &a, p, id, crate::expected(&h)?, v).await?,
    ))
}
async fn revisions(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    row(&mut tx, &a, Some(p), id).await?;
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT (to_jsonb(r)-'tenant_id')||jsonb_build_object('author_label',(SELECT coalesce(nullif(u.display_name,''),u.email) FROM browser_users u WHERE u.tenant_id=r.tenant_id AND u.id=r.actor_id)) FROM immunization_revisions r WHERE tenant_id=$1 AND immunization_id=$2 ORDER BY version DESC LIMIT 101").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let truncated = items.len() > 100;
    items.truncate(100);
    crate::postgres::audit(&mut tx, &a, "patient.immunization.revisions_read", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"truncated":truncated})))
}
async fn enter_error(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<ErrorAction>,
) -> Result<Response> {
    writer(&a)?;
    text(&v.reason, 1000)?;
    let expected = crate::expected(&h)?;
    let input = json!({"patient":p,"id":id,"version":expected,"body":v});
    let mut tx = lock(&s, &a).await?;
    if let Some(out) = replay(
        &mut tx,
        &a,
        v.request_id,
        "patient.immunization.entered_error",
        &input,
    )
    .await?
    {
        tx.commit().await?;
        return Ok(response(out));
    }
    let old = row(&mut tx, &a, Some(p), id).await?;
    if old["version"] != expected {
        return Err(Error::Conflict(
            "immunization changed; reload before saving",
        ));
    }
    if old["content"]["status"] == "entered_in_error" {
        return Err(Error::Conflict("immunization is already entered-in-error"));
    }
    let out:Value=sqlx::query_scalar("UPDATE immunizations SET content=jsonb_set(content,'{status}','\"entered_in_error\"'),version=version+1,updated_by=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING to_jsonb(immunizations)-'tenant_id'").bind(a.tenant_id).bind(id).bind(a.sub).fetch_one(&mut *tx).await?;
    save(
        &mut tx,
        &a,
        v.request_id,
        "patient.immunization.entered_error",
        &input,
        &out,
        &v.reason,
    )
    .await?;
    tx.commit().await?;
    Ok(response(out))
}
