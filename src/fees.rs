// SPDX-License-Identifier: AGPL-3.0-only
//! Explicitly approved practice fees. Proposals never price charges automatically.
use crate::{
    auth::{Actor, Role},
    billing::{AccountContent, ChargeLine},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use std::collections::HashSet;
use uuid::Uuid;

pub fn routes() -> Router<State> {
    Router::new()
        .route("/api/v1/practice/fee-schedules", get(list).post(create))
        .route("/api/v1/practice/fee-schedules/{id}", get(detail))
        .route("/api/v1/practice/fee-schedules/{id}/actions", post(action))
        .route("/api/v1/practice/fee-schedules/{id}/history", get(history))
        .route("/api/v1/patients/{p}/fee-context", get(context))
        .route("/api/v1/patients/{p}/fee-quote", get(quote))
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FeeContext {
    pub facility_id: Uuid,
    pub setting: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Source {
    id: String,
    url: String,
    sha256: String,
    published_on: NaiveDate,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    code_system: String,
    code: String,
    modifiers: String,
    reference_unit_cents: i64,
    source_id: String,
    source_row: i64,
    qualification: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Proposal {
    name: String,
    provider_id: Uuid,
    facility_id: Uuid,
    setting: String,
    qp_basis: String,
    locality: String,
    reference_from: NaiveDate,
    reference_to: NaiveDate,
    effective_from: NaiveDate,
    effective_to: NaiveDate,
    multiplier_basis_points: i64,
    default_for_scope: bool,
    sources: Vec<Source>,
    entries: Vec<Entry>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct New {
    request_id: Uuid,
    content: Proposal,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    action: String,
    reason: String,
    #[serde(default)]
    reviewed_scope_and_sources: bool,
}
fn text(s: &str, max: usize) -> Result<()> {
    if s.trim().is_empty() || s.len() > max || s.chars().any(char::is_control) {
        Err(Error::Invalid("fee text is missing or invalid"))
    } else {
        Ok(())
    }
}
fn setting(s: &str) -> Result<()> {
    if matches!(s, "facility" | "nonfacility") {
        Ok(())
    } else {
        Err(Error::Invalid(
            "select facility or nonfacility pricing explicitly",
        ))
    }
}
fn modifiers(s: &str) -> Result<String> {
    let parts: Vec<String> = s
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|x| !x.is_empty())
        .map(str::to_ascii_uppercase)
        .collect();
    if parts.len() > 4
        || parts
            .iter()
            .any(|x| x.len() != 2 || !x.bytes().all(|b| b.is_ascii_alphanumeric()))
    {
        return Err(Error::Invalid("invalid exact fee modifiers"));
    }
    Ok(parts.join(","))
}
fn key(system: &str, code: &str, mods: &str) -> Result<String> {
    if !matches!(system, "CPT" | "HCPCS")
        || code.len() != 5
        || !code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return Err(Error::Invalid(
            "fee entries require an exact CPT or HCPCS code",
        ));
    }
    Ok(format!("{system}:{code}:{}", modifiers(mods)?))
}
fn unit_amount(reference: i64, multiplier: i64) -> Result<i64> {
    if !(1..=100000000).contains(&reference) || !(1..=100000).contains(&multiplier) {
        return Err(Error::Invalid(
            "fee amount or explicit multiplier is invalid",
        ));
    }
    let amount = (reference
        .checked_mul(multiplier)
        .ok_or(Error::Invalid("fee overflow"))?
        + 5000)
        / 10000;
    if !(1..=100000000).contains(&amount) {
        return Err(Error::Invalid(
            "calculated fee is outside the supported range",
        ));
    }
    Ok(amount)
}
impl Proposal {
    fn validate(&self) -> Result<()> {
        text(&self.name, 200)?;
        text(&self.locality, 200)?;
        setting(&self.setting)?;
        if !matches!(self.qp_basis.as_str(), "qp" | "non_qp" | "not_applicable")
            || self.reference_to < self.reference_from
            || self.effective_from < self.reference_from
            || self.effective_to > self.reference_to
            || self.effective_to < self.effective_from
            || self.entries.is_empty()
            || self.entries.len() > 20000
            || self.sources.is_empty()
            || self.sources.len() > 100
        {
            return Err(Error::Invalid(
                "invalid fee scope, source dates or entry count",
            ));
        }
        let mut ids = HashSet::new();
        for s in &self.sources {
            text(&s.id, 100)?;
            let u = url::Url::parse(&s.url)
                .map_err(|_| Error::Invalid("fee source must be an HTTPS URL"))?;
            if u.scheme() != "https"
                || u.host_str().is_none()
                || !u.username().is_empty()
                || u.password().is_some()
                || s.url.len() > 2000
                || s.sha256.len() != 64
                || !s.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                || s.published_on > self.reference_to
                || !ids.insert(&s.id)
            {
                return Err(Error::Invalid("invalid or duplicate fee source"));
            }
        }
        let mut keys = HashSet::new();
        for e in &self.entries {
            if !keys.insert(key(&e.code_system, &e.code, &e.modifiers)?)
                || !ids.contains(&e.source_id)
                || e.source_row < 1
            {
                return Err(Error::Invalid("duplicate fee key or missing source row"));
            }
            text(&e.qualification, 2000)?;
            unit_amount(e.reference_unit_cents, self.multiplier_basis_points)?;
        }
        Ok(())
    }
}
async fn owner(s: &State, h: &HeaderMap, write: bool) -> Result<Actor> {
    let a = s
        .browser
        .as_ref()
        .ok_or(Error::Unauthorized)?
        .authenticate(h, write)
        .await?;
    if !matches!(a.role, Role::Owner) {
        return Err(Error::Forbidden);
    }
    Ok(a)
}
async fn tx<'a>(s: &'a State, a: &Actor) -> Result<Transaction<'a, Postgres>> {
    let mut tx = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .db
        .begin()
        .await?;
    crate::billing::tenant_lock(&mut tx, a).await?;
    Ok(tx)
}
async fn scope(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: &Proposal) -> Result<Value> {
    let provider:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',p.id,'name',p.display_name,'npi',p.npi,'version',p.version) FROM practice_providers p JOIN browser_users u ON u.tenant_id=p.tenant_id AND u.id=p.id WHERE p.tenant_id=$1 AND p.id=$2 AND p.active AND NOT u.disabled AND u.role IN ('owner','clinician') FOR SHARE OF p,u").bind(a.tenant_id).bind(p.provider_id).fetch_optional(&mut **tx).await?;
    let facility:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name,'address',address,'version',version) FROM practice_facilities WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE").bind(a.tenant_id).bind(p.facility_id).fetch_optional(&mut **tx).await?;
    Ok(
        json!({"provider":provider.ok_or(Error::Invalid("fee provider must be active in this practice"))?,"facility":facility.ok_or(Error::Invalid("fee facility must be active in this practice"))?}),
    )
}
async fn row(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Value> {
    sqlx::query_scalar("SELECT jsonb_build_object('id',id,'status',status,'version',version,'content',content,'created_at',created_at,'approved_at',approved_at) FROM practice_fee_schedules WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn record(tx: &mut Transaction<'_, Postgres>, a: &Actor, r: &Value, why: &str) -> Result<()> {
    let id = Uuid::parse_str(r["id"].as_str().ok_or(Error::Invalid("fee id missing"))?)
        .map_err(|_| Error::Invalid("fee id invalid"))?;
    sqlx::query("INSERT INTO practice_fee_history(tenant_id,schedule_id,version,actor_id,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(r["version"].as_i64()).bind(a.sub).bind(why.trim()).bind(r).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "practice.fees.write", id).await
}
async fn list(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let a = owner(&s, &h, false).await?;
    let mut tx = tx(&s, &a).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'status',status,'version',version,'content',content-'entries','entry_count',jsonb_array_length(content->'entries'),'created_at',created_at,'approved_at',approved_at) FROM practice_fee_schedules WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 100").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    Ok(Json(json!({"items":items,"limit":100})))
}
async fn detail(
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    let a = owner(&s, &h, false).await?;
    let mut tx = tx(&s, &a).await?;
    Ok(Json(row(&mut tx, &a, id).await?))
}
async fn history(
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    let a = owner(&s, &h, false).await?;
    let mut tx = tx(&s, &a).await?;
    row(&mut tx, &a, id).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('version',version,'actor_id',actor_id,'reason',reason,'created_at',created_at,'snapshot',snapshot) FROM practice_fee_history WHERE tenant_id=$1 AND schedule_id=$2 ORDER BY version").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    Ok(Json(json!({"items":items})))
}
async fn create(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<New>,
) -> Result<Json<Value>> {
    let a = owner(&s, &h, true).await?;
    v.content.validate()?;
    text(&v.reason, 1000)?;
    let hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&v).map_err(|_| Error::Invalid("fee content invalid"))?)
    );
    let mut tx = tx(&s, &a).await?;
    crate::partner_support::verify_owner_in_tx(&mut tx, &a, &h).await?;
    if let Some((id, old)) = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id,creation_hash FROM practice_fee_schedules WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        if old != hash {
            return Err(Error::Conflict(
                "fee request was already used with different content",
            ));
        }
        return Ok(Json(row(&mut tx, &a, id).await?));
    }
    let scope = scope(&mut tx, &a, &v.content).await?;
    let mut content = json!(&v.content);
    content["directory_snapshot"] = scope;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_fee_schedules(tenant_id,id,request_id,creation_hash,content) VALUES($1,$2,$3,$4,$5)").bind(a.tenant_id).bind(id).bind(v.request_id).bind(hash).bind(&content).execute(&mut *tx).await?;
    for chunk in v.content.entries.chunks(500) {
        let mut q=sqlx::QueryBuilder::<Postgres>::new("INSERT INTO practice_fee_entries(tenant_id,schedule_id,entry_key,code_system,code,modifiers,unit_amount_cents,content) ");
        q.push_values(chunk, |mut b, e| {
            b.push_bind(a.tenant_id)
                .push_bind(id)
                .push_bind(key(&e.code_system, &e.code, &e.modifiers).expect("validated key"))
                .push_bind(&e.code_system)
                .push_bind(&e.code)
                .push_bind(modifiers(&e.modifiers).expect("validated modifiers"))
                .push_bind(
                    unit_amount(e.reference_unit_cents, v.content.multiplier_basis_points)
                        .expect("validated fee"),
                )
                .push_bind(json!(e));
        });
        q.build().execute(&mut *tx).await?;
    }
    let r = row(&mut tx, &a, id).await?;
    record(&mut tx, &a, &r, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(r))
}
async fn action(
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Action>,
) -> Result<Json<Value>> {
    let a = owner(&s, &h, true).await?;
    text(&v.reason, 1000)?;
    let expected = crate::expected(&h)?;
    let mut tx = tx(&s, &a).await?;
    crate::partner_support::verify_owner_in_tx(&mut tx, &a, &h).await?;
    let old = row(&mut tx, &a, id).await?;
    if old["version"].as_i64() != Some(expected) {
        return Err(Error::Conflict(
            "fee schedule changed; reload before acting",
        ));
    }
    let mut source = old["content"].clone();
    source
        .as_object_mut()
        .ok_or(Error::Invalid("fee content invalid"))?
        .remove("directory_snapshot");
    let p: Proposal =
        serde_json::from_value(source).map_err(|_| Error::Invalid("fee content invalid"))?;
    let status = match v.action.as_str() {
        "approve" if old["status"] == "draft" => {
            if !v.reviewed_scope_and_sources {
                return Err(Error::Invalid("review the provider, locality, QP status, setting, dates, sources and charge policy before approval"));
            }
            if scope(&mut tx, &a, &p).await? != old["content"]["directory_snapshot"] {
                return Err(Error::Conflict("provider or facility changed after proposal; prepare a replacement with reviewed source scope"));
            }
            let overlaps:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM practice_fee_schedules WHERE tenant_id=$1 AND status='approved' AND content->>'provider_id'=$2 AND content->>'facility_id'=$3 AND content->>'setting'=$4 AND (content->>'effective_from')::date<=$6 AND (content->>'effective_to')::date>=$5)").bind(a.tenant_id).bind(p.provider_id.to_string()).bind(p.facility_id.to_string()).bind(&p.setting).bind(p.effective_from).bind(p.effective_to).fetch_one(&mut *tx).await?;
            if overlaps {
                return Err(Error::Conflict("an approved fee schedule already covers this provider, facility, setting and service period"));
            }
            "approved"
        }
        "retire" if old["status"] == "draft" || old["status"] == "approved" => "retired",
        _ => {
            return Err(Error::Conflict(
                "fee action does not apply to the current state",
            ))
        }
    };
    sqlx::query("UPDATE practice_fee_schedules SET status=$3,version=version+1,approved_at=CASE WHEN $3='approved' THEN now() ELSE approved_at END WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(status).execute(&mut *tx).await?;
    let r = row(&mut tx, &a, id).await?;
    record(&mut tx, &a, &r, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(r))
}
#[derive(Deserialize)]
struct ContextQuery {
    visit_id: Uuid,
    service_date: NaiveDate,
}
async fn visit(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    id: Uuid,
) -> Result<(Uuid, String)> {
    sqlx::query_as("SELECT v.clinician_id,coalesce(ap.facility,'') FROM visits v JOIN appointments ap ON ap.tenant_id=v.tenant_id AND ap.id=v.appointment_id WHERE v.tenant_id=$1 AND v.patient_id=$2 AND v.id=$3 FOR SHARE OF v,ap").bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn context(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Query(q): Query<ContextQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    crate::access_policies::require_native(&s, &a, "billing", "view").await?;
    let mut tx = tx(&s, &a).await?;
    let (provider, location) = visit(&mut tx, &a, p, q.visit_id).await?;
    let facilities:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name) FROM practice_facilities WHERE tenant_id=$1 AND active ORDER BY name,id").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    let exact: Vec<&Value> = facilities
        .iter()
        .filter(|f| f["name"].as_str() == Some(location.as_str()))
        .collect();
    let facility = if exact.len() == 1 {
        exact[0]["id"].clone()
    } else {
        Value::Null
    };
    let defaults:Vec<String>=sqlx::query_scalar("SELECT s.content->>'setting' FROM practice_fee_schedules s JOIN practice_facilities f ON f.tenant_id=s.tenant_id AND f.id=(s.content->>'facility_id')::uuid AND f.active JOIN practice_providers p ON p.tenant_id=s.tenant_id AND p.id=(s.content->>'provider_id')::uuid AND p.active WHERE s.tenant_id=$1 AND s.status='approved' AND s.content->>'provider_id'=$2 AND s.content->>'facility_id'=$3 AND s.content->>'default_for_scope'='true' AND (s.content->>'effective_from')::date<=$4 AND (s.content->>'effective_to')::date>=$4 AND s.content->'directory_snapshot'->'provider'->>'version'=p.version::text AND s.content->'directory_snapshot'->'facility'->>'version'=f.version::text").bind(a.tenant_id).bind(provider.to_string()).bind(facility.as_str().unwrap_or("")).bind(q.service_date).fetch_all(&mut *tx).await?;
    Ok(Json(
        json!({"provider_id":provider,"facilities":facilities,"facility_id":facility,"setting":if defaults.len()==1{Some(&defaults[0])}else{None},"reason":"Fees require an approved schedule and an exact service context. Manual amounts remain available."}),
    ))
}
#[derive(Deserialize)]
struct QuoteQuery {
    visit_id: Uuid,
    service_date: NaiveDate,
    facility_id: Uuid,
    setting: String,
    code_system: String,
    code: String,
    modifiers: String,
    units: i64,
}
async fn lookup(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    provider: Uuid,
    date: NaiveDate,
    ctx: &FeeContext,
    line: &ChargeLine,
) -> Result<Option<Value>> {
    setting(&ctx.setting)?;
    let k = key(&line.code_system, &line.code, &line.modifiers)?;
    let rows:Vec<(Uuid,i64,Value,Value)>=sqlx::query_as("SELECT s.id,e.unit_amount_cents,s.content-'entries',e.content FROM practice_fee_schedules s JOIN practice_fee_entries e ON e.tenant_id=s.tenant_id AND e.schedule_id=s.id JOIN practice_facilities f ON f.tenant_id=s.tenant_id AND f.id=(s.content->>'facility_id')::uuid AND f.active JOIN practice_providers pr ON pr.tenant_id=s.tenant_id AND pr.id=(s.content->>'provider_id')::uuid AND pr.active AND s.content->'directory_snapshot'->'provider'->>'version'=pr.version::text AND s.content->'directory_snapshot'->'facility'->>'version'=f.version::text JOIN browser_users u ON u.tenant_id=pr.tenant_id AND u.id=pr.id AND NOT u.disabled AND u.role IN ('owner','clinician') WHERE s.tenant_id=$1 AND s.status='approved' AND s.content->>'provider_id'=$2 AND s.content->>'facility_id'=$3 AND s.content->>'setting'=$4 AND (s.content->>'effective_from')::date<=$5 AND (s.content->>'effective_to')::date>=$5 AND e.entry_key=$6 FOR SHARE OF s,e,f,pr,u").bind(a.tenant_id).bind(provider.to_string()).bind(ctx.facility_id.to_string()).bind(&ctx.setting).bind(date).bind(&k).fetch_all(&mut **tx).await?;
    if rows.len() > 1 {
        return Err(Error::Conflict(
            "multiple approved fee schedules match; owner review is required",
        ));
    }
    let Some((id, unit, schedule, entry)) = rows.into_iter().next() else {
        return Ok(None);
    };
    let total = unit
        .checked_mul(line.units)
        .filter(|v| (1..=100000000).contains(v) && (1..=1000).contains(&line.units))
        .ok_or(Error::Invalid("fee line total exceeds supported range"))?;
    Ok(Some(
        json!({"schedule_id":id,"entry_key":k,"unit_amount_cents":unit,"expected_line_amount_cents":total,"units":line.units,"service_date":date,"context":ctx,"schedule":schedule,"entry":entry}),
    ))
}
async fn quote(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Query(q): Query<QuoteQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    crate::access_policies::require_native(&s, &a, "billing", "view").await?;
    let mut tx = tx(&s, &a).await?;
    let (provider, _) = visit(&mut tx, &a, p, q.visit_id).await?;
    let ctx = FeeContext {
        facility_id: q.facility_id,
        setting: q.setting,
    };
    let line = ChargeLine {
        code_system: q.code_system,
        code: q.code,
        description: String::new(),
        modifiers: q.modifiers,
        units: q.units,
        amount_cents: 1,
        diagnosis_codes: vec![],
        catalog_release_id: None,
        catalog_snapshot: None,
        fee_schedule_id: None,
        fee_entry_key: None,
        fee_snapshot: None,
        fee_override_reason: None,
    };
    let quote = lookup(&mut tx, &a, provider, q.service_date, &ctx, &line).await?;
    Ok(Json(
        json!({"quote":quote,"reason":if quote.is_none(){Some("No approved exact fee matches this code, modifiers, date and service context; enter a reviewed manual amount.")}else{None}}),
    ))
}
// The caller holds the shared billing tenant lock. Snapshot payloads from clients
// are never trusted; unchanged saved evidence survives schedule retirement.
pub(crate) async fn resolve(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    content: &mut AccountContent,
    old: Option<&Value>,
) -> Result<()> {
    let old_context = old.and_then(|v| v.get("fee_context"));
    let same_context = old.is_some_and(|v| {
        v["visit_id"] == json!(content.visit_id) && v["service_date"] == json!(content.service_date)
    }) && old_context.unwrap_or(&Value::Null) == &json!(content.fee_context);
    if let Some(ctx) = &content.fee_context {
        setting(&ctx.setting)?;
        if !same_context {
            let active: Option<Uuid> = sqlx::query_scalar("SELECT id FROM practice_facilities WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE").bind(a.tenant_id).bind(ctx.facility_id).fetch_optional(&mut **tx).await?;
            if active.is_none() {
                return Err(Error::Invalid(
                    "fee context requires an active facility in this practice",
                ));
            }
            visit(
                tx,
                a,
                p,
                content
                    .visit_id
                    .ok_or(Error::Invalid("fee context requires a linked encounter"))?,
            )
            .await?;
        }
    }
    let mut used = HashSet::new();
    for line in &mut content.lines {
        line.fee_snapshot = None;
        let Some(id) = line.fee_schedule_id else {
            if line.fee_entry_key.is_some() || line.fee_override_reason.is_some() {
                return Err(Error::Invalid("fee provenance requires a schedule"));
            }
            continue;
        };
        let k = key(&line.code_system, &line.code, &line.modifiers)?;
        if line.fee_entry_key.as_deref() != Some(&k) {
            return Err(Error::Invalid(
                "fee key does not match the charge code and modifiers",
            ));
        }
        if same_context {
            if let Some(lines) = old.and_then(|v| v["lines"].as_array()) {
                if let Some((index, saved)) = lines.iter().enumerate().find(|(i, v)| {
                    !used.contains(i)
                        && v["fee_schedule_id"] == json!(id)
                        && v["fee_entry_key"] == json!(k)
                        && v["units"] == json!(line.units)
                        && v["amount_cents"] == json!(line.amount_cents)
                        && v.get("fee_override_reason").unwrap_or(&Value::Null)
                            == &json!(line.fee_override_reason)
                        && v["fee_snapshot"].is_object()
                }) {
                    used.insert(index);
                    line.fee_snapshot = Some(saved["fee_snapshot"].clone());
                    continue;
                }
            }
        }
        let ctx = content.fee_context.as_ref().ok_or(Error::Invalid(
            "choose the service facility and setting for fee pricing",
        ))?;
        let (provider, _) = visit(
            tx,
            a,
            p,
            content
                .visit_id
                .ok_or(Error::Invalid("fee pricing requires a linked encounter"))?,
        )
        .await?;
        let mut value = lookup(tx, a, provider, content.service_date, ctx, line)
            .await?
            .ok_or(Error::Conflict(
                "fee schedule is no longer approved for this exact charge; review the amount",
            ))?;
        if value["schedule_id"] != json!(id) {
            return Err(Error::Conflict(
                "approved fee schedule changed; review the amount",
            ));
        }
        if value["expected_line_amount_cents"] != json!(line.amount_cents) {
            text(line.fee_override_reason.as_deref().unwrap_or(""), 1000)?;
        } else if let Some(reason) = &line.fee_override_reason {
            text(reason, 1000)?;
        }
        value["actual_line_amount_cents"] = json!(line.amount_cents);
        value["override_reason"] = json!(line.fee_override_reason);
        value["recorded_by"] = json!(a.sub);
        line.fee_snapshot = Some(value);
    }
    Ok(())
}
