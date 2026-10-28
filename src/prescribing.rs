// SPDX-License-Identifier: AGPL-3.0-only
//! Local medication orders. Authorization, handoff, dispensing and network acceptance are distinct.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    postgres::audit,
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::{header, HeaderMap},
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Content {
    pub medication_name: String,
    #[serde(default)]
    pub rxnorm_code: String,
    #[serde(default)]
    pub strength: String,
    #[serde(default)]
    pub dosage_form: String,
    pub dose: String,
    pub route: String,
    pub frequency: String,
    pub instructions: String,
    pub indication: String,
    pub quantity: String,
    pub quantity_unit: String,
    pub refills: i32,
    pub days_supply: Option<i32>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub substitution_allowed: bool,
    pub controlled_substance: bool,
    pub pharmacy_id: Option<Uuid>,
}
fn text(v: &str, max: usize, required: bool) -> Result<()> {
    if (required && v.trim().is_empty())
        || v.chars().count() > max
        || v.chars().any(|c| c.is_control() && c != '\n')
    {
        Err(Error::Invalid(
            "prescribing text is missing, too long or contains invalid characters",
        ))
    } else {
        Ok(())
    }
}
fn decimal(v: &str) -> bool {
    let p: Vec<_> = v.split('.').collect();
    p.len() <= 2
        && p.iter()
            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        && p[0].len() <= 7
        && p.get(1).is_none_or(|s| s.len() <= 3)
        && v.bytes().any(|b| b.is_ascii_digit() && b != b'0')
}
impl Content {
    fn validate(&self) -> Result<()> {
        for (s, n, required) in [
            (&self.medication_name, 200, true),
            (&self.rxnorm_code, 20, false),
            (&self.strength, 120, false),
            (&self.dosage_form, 120, false),
            (&self.dose, 200, true),
            (&self.route, 100, true),
            (&self.frequency, 200, true),
            (&self.instructions, 4000, true),
            (&self.indication, 1000, true),
            (&self.quantity_unit, 100, true),
        ] {
            text(s, n, required)?;
        }
        if (!self.rxnorm_code.is_empty() && !self.rxnorm_code.bytes().all(|b| b.is_ascii_digit()))
            || !decimal(&self.quantity)
            || !(0..=99).contains(&self.refills)
            || self.days_supply.is_some_and(|n| !(1..=3660).contains(&n))
            || matches!((self.start_date,self.end_date),(Some(a),Some(b))if b<a)
        {
            return Err(Error::Invalid(
                "invalid medication code, quantity, refills, days supply or date range",
            ));
        }
        Ok(())
    }
}
fn pool(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn prepare(a: &Actor) -> Result<()> {
    a.rooming()
}
fn directory_write(a: &Actor) -> Result<()> {
    if matches!(
        a.role,
        Role::Owner | Role::Clinician | Role::Nurse | Role::MedicalAssistant | Role::FrontDesk
    ) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
async fn patient(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: Uuid) -> Result<()> {
    if !sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)",
    )
    .bind(a.tenant_id)
    .bind(p)
    .fetch_one(&mut **tx)
    .await?
    {
        return Err(Error::NotFound);
    }
    Ok(())
}
async fn lock<'a>(s: &'a State, a: &Actor) -> Result<Transaction<'a, Postgres>> {
    let mut tx = pool(s)?.begin().await?;
    crate::scheduling::tenant_lock(&mut tx, a).await?;
    Ok(tx)
}
async fn replay(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    request: Uuid,
    op: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let old:Option<(Uuid,String,Value,Value)>=sqlx::query_as("SELECT actor_id,operation,request,response FROM prescribing_requests WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(request).fetch_optional(&mut **tx).await?;
    match old {
        Some((actor, operation, body, out))
            if actor == a.sub && operation == op && body == *input =>
        {
            Ok(Some(out))
        }
        Some(_) => Err(Error::Conflict(
            "request identifier was already used for different prescribing content",
        )),
        None => Ok(None),
    }
}
async fn remember(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    request: Uuid,
    op: &str,
    input: &Value,
    out: &Value,
) -> Result<()> {
    sqlx::query("INSERT INTO prescribing_requests(tenant_id,request_id,actor_id,operation,request,response) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(request).bind(a.sub).bind(op).bind(input).bind(out).execute(&mut **tx).await?;
    Ok(())
}
async fn history(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    kind: &str,
    action: &str,
    reason: &str,
    out: &Value,
) -> Result<()> {
    text(reason, 1000, true)?;
    sqlx::query("INSERT INTO prescribing_history(tenant_id,id,resource_id,kind,version,action,actor_id,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(id).bind(kind).bind(out["version"].as_i64().ok_or(Error::Invalid("prescribing version missing"))?).bind(action).bind(a.sub).bind(reason.trim()).bind(out).execute(&mut **tx).await?;
    audit(tx, a, action, id).await
}
async fn rx(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: Uuid, id: Uuid) -> Result<Value> {
    sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id' FROM native_prescriptions r WHERE tenant_id=$1 AND patient_id=$2 AND id=$3").bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
fn response(out: Value) -> Response {
    (
        [(header::ETAG, format!("\"{}\"", out["version"]))],
        Json(out),
    )
        .into_response()
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/prescribing/capabilities", get(capabilities))
        .route(
            "/api/v1/prescribing/pharmacies",
            get(pharmacies).post(create_pharmacy),
        )
        .route(
            "/api/v1/prescribing/pharmacies/{id}",
            get(read_pharmacy).put(update_pharmacy),
        )
        .route(
            "/api/v1/patients/{patient}/pharmacy",
            get(preference).put(save_preference),
        )
        .route(
            "/api/v1/patients/{patient}/prescriptions",
            get(list).post(create),
        )
        .route("/api/v1/patients/{patient}/prescribing-review", get(review))
        .route(
            "/api/v1/patients/{patient}/prescriptions/{id}",
            get(read).put(update),
        )
        .route(
            "/api/v1/patients/{patient}/prescriptions/{id}/actions/{action}",
            axum::routing::post(action),
        )
        .route(
            "/api/v1/patients/{patient}/prescriptions/{id}/history",
            get(revisions),
        )
        .route(
            "/api/v1/patients/{patient}/prescriptions/{id}/print",
            get(print),
        )
}
async fn capabilities(a: Actor) -> Result<Json<Value>> {
    a.staff()?;
    Ok(Json(
        json!({"local_authorization":true,"external_erx_configured":false,"controlled_substance_authorization":false,"drug_interaction_checking":false,"terminology_lookup":false,"message":"Local orders only. External e-prescribing and EPCS require a separately enrolled, validated vendor integration. No pharmacy transmission or dispensing confirmation is performed."}),
    ))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PharmacyContent {
    name: String,
    address: String,
    phone: String,
    #[serde(default)]
    ncpdp_id: String,
    #[serde(default)]
    npi: String,
}
impl PharmacyContent {
    fn validate(&self) -> Result<()> {
        text(&self.name, 200, true)?;
        text(&self.address, 1000, true)?;
        text(&self.phone, 40, true)?;
        if (!self.ncpdp_id.is_empty()
            && (self.ncpdp_id.len() != 7 || !self.ncpdp_id.bytes().all(|b| b.is_ascii_digit())))
            || (!self.npi.is_empty()
                && (self.npi.len() != 10 || !self.npi.bytes().all(|b| b.is_ascii_digit())))
        {
            return Err(Error::Invalid(
                "pharmacy identifiers must be 7-digit NCPDP or 10-digit NPI values when recorded",
            ));
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PharmacyChange {
    request_id: Uuid,
    content: PharmacyContent,
    active: bool,
    reason: String,
}
async fn pharmacy(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    active: bool,
) -> Result<Value> {
    sqlx::query_scalar("SELECT to_jsonb(p)-'tenant_id' FROM prescribing_pharmacies p WHERE tenant_id=$1 AND id=$2 AND (NOT $3 OR active) FOR SHARE").bind(a.tenant_id).bind(id).bind(active).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn pharmacies(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = pool(&s)?.begin().await?;
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(p)-'tenant_id' FROM prescribing_pharmacies p WHERE tenant_id=$1 ORDER BY active DESC,lower(content->>'name'),id LIMIT 201").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    let truncated = items.len() > 200;
    items.truncate(200);
    audit(&mut tx, &a, "prescribing.pharmacies_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"truncated":truncated})))
}
async fn create_pharmacy(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(v): Json<PharmacyChange>,
) -> Result<Response> {
    directory_write(&a)?;
    v.content.validate()?;
    text(&v.reason, 1000, true)?;
    let input = json!(v);
    let mut tx = lock(&s, &a).await?;
    if let Some(out) = replay(&mut tx, &a, v.request_id, "pharmacy.create", &input).await? {
        tx.commit().await?;
        return Ok(response(out));
    }
    let id = Uuid::new_v4();
    let out:Value=sqlx::query_scalar("INSERT INTO prescribing_pharmacies(tenant_id,id,content,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING to_jsonb(prescribing_pharmacies)-'tenant_id'").bind(a.tenant_id).bind(id).bind(json!(v.content)).bind(v.active).bind(a.sub).fetch_one(&mut *tx).await?;
    history(
        &mut tx,
        &a,
        id,
        "pharmacy",
        "prescribing.pharmacy_created",
        &v.reason,
        &out,
    )
    .await?;
    remember(&mut tx, &a, v.request_id, "pharmacy.create", &input, &out).await?;
    tx.commit().await?;
    Ok(response(out))
}

async fn read_pharmacy(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    a.staff()?;
    let mut tx = pool(&s)?.begin().await?;
    let out = pharmacy(&mut tx, &a, id, false).await?;
    audit(&mut tx, &a, "prescribing.pharmacy_read", id).await?;
    tx.commit().await?;
    Ok(response(out))
}
async fn update_pharmacy(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<PharmacyChange>,
) -> Result<Response> {
    directory_write(&a)?;
    v.content.validate()?;
    text(&v.reason, 1000, true)?;
    let version = crate::expected(&h)?;
    let input = json!({"id":id,"version":version,"body":v});
    let mut tx = lock(&s, &a).await?;
    if let Some(out) = replay(&mut tx, &a, v.request_id, "pharmacy.update", &input).await? {
        tx.commit().await?;
        return Ok(response(out));
    }
    let old = pharmacy(&mut tx, &a, id, false).await?;
    if old["version"] != version {
        return Err(Error::Conflict(
            "pharmacy changed; compare the saved record before retrying",
        ));
    }
    let out:Value=sqlx::query_scalar("UPDATE prescribing_pharmacies SET content=$3,active=$4,version=version+1,updated_by=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING to_jsonb(prescribing_pharmacies)-'tenant_id'").bind(a.tenant_id).bind(id).bind(json!(v.content)).bind(v.active).bind(a.sub).fetch_one(&mut *tx).await?;
    history(
        &mut tx,
        &a,
        id,
        "pharmacy",
        "prescribing.pharmacy_updated",
        &v.reason,
        &out,
    )
    .await?;
    remember(&mut tx, &a, v.request_id, "pharmacy.update", &input, &out).await?;
    tx.commit().await?;
    Ok(response(out))
}
async fn preference_value(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: Uuid) -> Result<Value> {
    Ok(sqlx::query_scalar("SELECT to_jsonb(p)-'tenant_id' FROM patient_pharmacy_preferences p WHERE tenant_id=$1 AND patient_id=$2").bind(a.tenant_id).bind(p).fetch_optional(&mut **tx).await?.unwrap_or(json!({"patient_id":p,"pharmacy_id":null,"version":0})))
}
async fn preference(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = pool(&s)?.begin().await?;
    patient(&mut tx, &a, p).await?;
    let out = preference_value(&mut tx, &a, p).await?;
    audit(&mut tx, &a, "prescribing.preference_read", p).await?;
    tx.commit().await?;
    Ok(Json(out))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreferenceChange {
    request_id: Uuid,
    pharmacy_id: Option<Uuid>,
    version: i64,
    reason: String,
}
async fn save_preference(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Json(v): Json<PreferenceChange>,
) -> Result<Response> {
    directory_write(&a)?;
    text(&v.reason, 1000, true)?;
    let input = json!({"patient":p,"body":v});
    let mut tx = lock(&s, &a).await?;
    patient(&mut tx, &a, p).await?;
    if let Some(out) = replay(&mut tx, &a, v.request_id, "preference.update", &input).await? {
        tx.commit().await?;
        return Ok(response(out));
    }
    let old = preference_value(&mut tx, &a, p).await?;
    if old["version"] != v.version {
        return Err(Error::Conflict(
            "preferred pharmacy changed; reload before choosing again",
        ));
    }
    if let Some(id) = v.pharmacy_id {
        pharmacy(&mut tx, &a, id, true).await?;
    }
    let out:Value=sqlx::query_scalar("INSERT INTO patient_pharmacy_preferences(tenant_id,patient_id,pharmacy_id,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,patient_id) DO UPDATE SET pharmacy_id=excluded.pharmacy_id,version=patient_pharmacy_preferences.version+1,updated_by=excluded.updated_by,updated_at=clock_timestamp() RETURNING to_jsonb(patient_pharmacy_preferences)-'tenant_id'").bind(a.tenant_id).bind(p).bind(v.pharmacy_id).bind(a.sub).fetch_one(&mut *tx).await?;
    history(
        &mut tx,
        &a,
        p,
        "preference",
        "prescribing.preference_updated",
        &v.reason,
        &out,
    )
    .await?;
    remember(&mut tx, &a, v.request_id, "preference.update", &input, &out).await?;
    tx.commit().await?;
    Ok(response(out))
}
#[derive(Deserialize)]
struct Page {
    _after: Option<Uuid>,
}
async fn list(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Query(q): Query<Page>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = pool(&s)?.begin().await?;
    patient(&mut tx, &a, p).await?;
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id' FROM native_prescriptions r WHERE tenant_id=$1 AND patient_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 101").bind(a.tenant_id).bind(p).bind(q._after).fetch_all(&mut *tx).await?;
    let more = items.len() > 100;
    items.truncate(100);
    let next = if more {
        items.last().map(|x| x["id"].clone())
    } else {
        None
    };
    audit(&mut tx, &a, "prescribing.orders_read", p).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next_cursor":next})))
}
async fn read(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    a.staff()?;
    let mut tx = pool(&s)?.begin().await?;
    let out = rx(&mut tx, &a, p, id).await?;
    audit(&mut tx, &a, "prescribing.order_read", id).await?;
    tx.commit().await?;
    Ok(response(out))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Draft {
    request_id: Uuid,
    content: Content,
    visit_id: Option<Uuid>,
    prior_prescription_id: Option<Uuid>,
    relationship: Option<String>,
    reason: String,
}
async fn links(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: Uuid, v: &Draft) -> Result<()> {
    if let Some(visit) = v.visit_id {
        let found: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)",
        )
        .bind(a.tenant_id)
        .bind(p)
        .bind(visit)
        .fetch_one(&mut **tx)
        .await?;
        if !found {
            return Err(Error::NotFound);
        }
    }
    if let Some(id) = v.content.pharmacy_id {
        pharmacy(tx, a, id, true).await?;
    }
    match(v.prior_prescription_id,v.relationship.as_deref()){(None,None)=>{},(Some(id),Some("renewal"|"replacement"))=>{let prior=rx(tx,a,p,id).await?;if prior["signed_at"].is_null(){return Err(Error::Invalid("renewal or replacement must link an authorized prescription for this patient"));}},_=>return Err(Error::Invalid("a prior prescription and renewal or replacement relationship must be supplied together"))}
    Ok(())
}
async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Json(v): Json<Draft>,
) -> Result<Response> {
    prepare(&a)?;
    v.content.validate()?;
    text(&v.reason, 1000, true)?;
    let input = json!({"patient":p,"body":v});
    let mut tx = lock(&s, &a).await?;
    patient(&mut tx, &a, p).await?;
    if let Some(out) = replay(&mut tx, &a, v.request_id, "order.create", &input).await? {
        tx.commit().await?;
        return Ok(response(out));
    }
    links(&mut tx, &a, p, &v).await?;
    let id = Uuid::new_v4();
    let out:Value=sqlx::query_scalar("INSERT INTO native_prescriptions(tenant_id,id,patient_id,visit_id,content,authored_by,updated_by,prior_prescription_id,relationship) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8) RETURNING to_jsonb(native_prescriptions)-'tenant_id'").bind(a.tenant_id).bind(id).bind(p).bind(v.visit_id).bind(json!(v.content)).bind(a.sub).bind(v.prior_prescription_id).bind(&v.relationship).fetch_one(&mut *tx).await?;
    history(
        &mut tx,
        &a,
        id,
        "prescription",
        "prescribing.draft_created",
        &v.reason,
        &out,
    )
    .await?;
    remember(&mut tx, &a, v.request_id, "order.create", &input, &out).await?;
    tx.commit().await?;
    Ok(response(out))
}
async fn update(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<Draft>,
) -> Result<Response> {
    prepare(&a)?;
    v.content.validate()?;
    text(&v.reason, 1000, true)?;
    let version = crate::expected(&h)?;
    let input = json!({"patient":p,"id":id,"version":version,"body":v});
    let mut tx = lock(&s, &a).await?;
    if let Some(out) = replay(&mut tx, &a, v.request_id, "order.update", &input).await? {
        tx.commit().await?;
        return Ok(response(out));
    }
    let old = rx(&mut tx, &a, p, id).await?;
    if old["version"] != version {
        return Err(Error::Conflict(
            "prescription changed; compare the saved record before retrying",
        ));
    }
    if old["status"] != "draft" {
        return Err(Error::Conflict(
            "authorized content is immutable; create a linked replacement",
        ));
    }
    if old["prior_prescription_id"] != json!(v.prior_prescription_id)
        || old["relationship"] != json!(v.relationship)
    {
        return Err(Error::Invalid("prescription lineage cannot be changed"));
    }
    links(&mut tx, &a, p, &v).await?;
    let out:Value=sqlx::query_scalar("UPDATE native_prescriptions SET content=$4,visit_id=$5,version=version+1,updated_by=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 RETURNING to_jsonb(native_prescriptions)-'tenant_id'").bind(a.tenant_id).bind(p).bind(id).bind(json!(v.content)).bind(v.visit_id).bind(a.sub).fetch_one(&mut *tx).await?;
    history(
        &mut tx,
        &a,
        id,
        "prescription",
        "prescribing.draft_updated",
        &v.reason,
        &out,
    )
    .await?;
    remember(&mut tx, &a, v.request_id, "order.update", &input, &out).await?;
    tx.commit().await?;
    Ok(response(out))
}
async fn safety(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: Uuid) -> Result<Value> {
    crate::clinical::list_lock(tx, a, p, "allergy").await?;
    crate::clinical::list_lock(tx, a, p, "medication").await?;
    let mut lists = serde_json::Map::new();
    let mut ready = true;
    for kind in ["allergy", "medication"] {
        let state:Value=sqlx::query_scalar("SELECT to_jsonb(l)-'tenant_id'-'patient_id' FROM clinical_list_state l WHERE tenant_id=$1 AND patient_id=$2 AND kind=$3").bind(a.tenant_id).bind(p).bind(kind).fetch_one(&mut **tx).await?;
        let mut entries:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'version',version,'content',content) FROM clinical_entries WHERE tenant_id=$1 AND patient_id=$2 AND kind=$3 ORDER BY id LIMIT 501").bind(a.tenant_id).bind(p).bind(kind).fetch_all(&mut **tx).await?;
        let truncated = entries.len() > 500;
        entries.truncate(500);
        let reviewed = matches!(
            state["review_state"].as_str(),
            Some("reviewed" | "no_known")
        );
        ready &= reviewed && !truncated;
        lists.insert(
            kind.into(),
            json!({"state":state,"items":entries,"truncated":truncated}),
        );
    }
    let mut active:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'version',version,'content',content) FROM native_prescriptions WHERE tenant_id=$1 AND patient_id=$2 AND status='active' ORDER BY id LIMIT 501").bind(a.tenant_id).bind(p).fetch_all(&mut **tx).await?;
    let active_truncated = active.len() > 500;
    active.truncate(500);
    ready &= !active_truncated;
    let snapshot = json!({"patient_id":p,"lists":lists,"active_prescriptions":active,"active_prescriptions_truncated":active_truncated});
    let digest = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&snapshot)
                .map_err(|_| Error::Invalid("review serialization failed"))?
        )
    );
    Ok(
        json!({"review_token":digest,"patient_id":p,"lists":lists,"active_prescriptions":active,"active_prescriptions_truncated":active_truncated,"can_authorize":ready,"limitations":"Manual clinical review is required. No drug interaction, dose, formulary or contraindication checking is performed. No known allergies is a recorded review state, not a safety guarantee."}),
    )
}
async fn review(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = lock(&s, &a).await?;
    patient(&mut tx, &a, p).await?;
    let out = safety(&mut tx, &a, p).await?;
    audit(&mut tx, &a, "prescribing.review_read", p).await?;
    tx.commit().await?;
    Ok(Json(out))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    request_id: Uuid,
    reason: String,
    #[serde(default)]
    review_token: Option<String>,
    #[serde(default)]
    attest: bool,
}
async fn action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id, action)): Path<(Uuid, Uuid, String)>,
    h: HeaderMap,
    Json(v): Json<Action>,
) -> Result<Response> {
    if matches!(action.as_str(), "record_print" | "fulfill_local") {
        prepare(&a)?;
    } else {
        a.clinical()?;
    }
    text(&v.reason, 1000, true)?;
    if ![
        "authorize",
        "cancel",
        "stop",
        "complete",
        "record_print",
        "fulfill_local",
    ]
    .contains(&action.as_str())
    {
        return Err(Error::NotFound);
    }
    let version = crate::expected(&h)?;
    let input = json!({"patient":p,"id":id,"action":action,"version":version,"body":v});
    let mut tx = lock(&s, &a).await?;
    if let Some(out) = replay(&mut tx, &a, v.request_id, "order.action", &input).await? {
        tx.commit().await?;
        return Ok(response(out));
    }
    let old = rx(&mut tx, &a, p, id).await?;
    if old["version"] != version {
        return Err(Error::Conflict(
            "prescription changed; review the current order before acting",
        ));
    }
    let mut status = old["status"].as_str().unwrap_or("draft").to_owned();
    let mut fulfillment = old["fulfillment_status"]
        .as_str()
        .unwrap_or("not_authorized")
        .to_owned();
    let mut signed = old["signed_snapshot"].clone();
    let mut signer = old["signed_by"]
        .as_str()
        .and_then(|s| Uuid::parse_str(s).ok());
    let mut signed_at = old["signed_at"].as_str().map(str::to_owned);
    match action.as_str() {
        "authorize" => {
            if status != "draft" {
                return Err(Error::Conflict("only a draft can be authorized"));
            }
            let c: Content = serde_json::from_value(old["content"].clone())
                .map_err(|_| Error::Invalid("invalid saved prescription"))?;
            c.validate()?;
            if c.controlled_substance {
                return Err(Error::Conflict("controlled-substance authorization requires an enrolled EPCS integration; this local workflow does not provide it"));
            }
            let provider:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',p.id,'display_name',p.display_name,'npi',p.npi,'version',p.version) FROM practice_providers p JOIN browser_users u ON u.tenant_id=p.tenant_id AND u.id=p.id WHERE p.tenant_id=$1 AND p.id=$2 AND p.active AND NOT u.disabled AND u.role IN('owner','clinician') AND p.npi<>'' FOR SHARE OF p,u").bind(a.tenant_id).bind(a.sub).fetch_optional(&mut *tx).await?;
            let provider=provider.ok_or(Error::Conflict("authorization requires your active local clinician provider profile with recorded NPI"))?;
            let clinical = safety(&mut tx, &a, p).await?;
            if clinical["can_authorize"] != true {
                return Err(Error::Conflict("reconcile allergy and medication lists before authorizing; unknown or incomplete data is not a safe review"));
            }
            if !v.attest || v.review_token.as_deref() != clinical["review_token"].as_str() {
                return Err(Error::Conflict(
                    "reload and explicitly attest the current allergy and medication review",
                ));
            }
            let pharmacy = if let Some(id) = c.pharmacy_id {
                pharmacy(&mut tx, &a, id, true).await?
            } else {
                return Err(Error::Invalid(
                    "select the intended pharmacy before authorization",
                ));
            };
            let patient:Value=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'mrn',mrn,'given_name',given_name,'family_name',family_name,'birth_date',birth_date) FROM patients WHERE tenant_id=$1 AND id=$2 FOR SHARE").bind(a.tenant_id).bind(p).fetch_one(&mut *tx).await?;
            signed = json!({"content":c,"patient":patient,"provider":provider,"pharmacy":pharmacy,"review":clinical,"attestation":v.reason,"external_transmission":"unconfigured"});
            signer = Some(a.sub);
            signed_at = Some(Utc::now().to_rfc3339());
            status = "active".into();
            fulfillment = "local_ready".into();
            if old["relationship"] == "replacement" {
                let prior = old["prior_prescription_id"]
                    .as_str()
                    .and_then(|s| Uuid::parse_str(s).ok())
                    .ok_or(Error::Invalid("replacement predecessor missing"))?;
                let predecessor = rx(&mut tx, &a, p, prior).await?;
                if predecessor["status"] == "active" {
                    let replaced:Value=sqlx::query_scalar("UPDATE native_prescriptions SET status='stopped',version=version+1,updated_by=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING to_jsonb(native_prescriptions)-'tenant_id'").bind(a.tenant_id).bind(prior).bind(a.sub).fetch_one(&mut *tx).await?;
                    history(
                        &mut tx,
                        &a,
                        prior,
                        "prescription",
                        "prescribing.replaced",
                        &v.reason,
                        &replaced,
                    )
                    .await?;
                }
            }
        }
        "cancel" => {
            if !["draft", "active"].contains(&status.as_str()) {
                return Err(Error::Conflict(
                    "only a draft or active order can be cancelled",
                ));
            }
            status = "cancelled".into();
        }
        "stop" | "complete" => {
            if status != "active" {
                return Err(Error::Conflict(
                    "only an active order can be stopped or completed",
                ));
            }
            status = if action == "stop" {
                "stopped"
            } else {
                "completed"
            }
            .into();
        }
        "record_print" | "fulfill_local" => {
            if status != "active" || signer.is_none() {
                return Err(Error::Conflict(
                    "only an active authorized order supports local print or handoff",
                ));
            }
            if action == "record_print" {
                if fulfillment == "recorded_local" {
                    return Err(Error::Conflict(
                        "local handoff is already recorded; printing a copy does not reopen it",
                    ));
                }
                fulfillment = "printed".into();
            } else {
                fulfillment = "recorded_local".into();
            }
        }
        _ => unreachable!(),
    }
    let timestamp = signed_at
        .as_deref()
        .map(|s| s.parse::<chrono::DateTime<Utc>>())
        .transpose()
        .map_err(|_| Error::Invalid("invalid authorization time"))?;
    let out:Value=sqlx::query_scalar("UPDATE native_prescriptions SET status=$4,fulfillment_status=$5,signed_by=$6,signed_at=$7,signed_snapshot=$8,version=version+1,updated_by=$9,updated_at=clock_timestamp() WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 RETURNING to_jsonb(native_prescriptions)-'tenant_id'").bind(a.tenant_id).bind(p).bind(id).bind(status).bind(fulfillment).bind(signer).bind(timestamp).bind(if signed.is_null(){None}else{Some(signed)}).bind(a.sub).fetch_one(&mut *tx).await?;
    history(
        &mut tx,
        &a,
        id,
        "prescription",
        &format!("prescribing.{action}"),
        &v.reason,
        &out,
    )
    .await?;
    remember(&mut tx, &a, v.request_id, "order.action", &input, &out).await?;
    tx.commit().await?;
    Ok(response(out))
}
async fn revisions(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = pool(&s)?.begin().await?;
    rx(&mut tx, &a, p, id).await?;
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(h)-'tenant_id' FROM prescribing_history h WHERE tenant_id=$1 AND resource_id=$2 AND kind='prescription' ORDER BY version DESC LIMIT 101").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let truncated = items.len() > 100;
    items.truncate(100);
    audit(&mut tx, &a, "prescribing.history_read", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"truncated":truncated})))
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
async fn print(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    a.staff()?;
    let mut tx = pool(&s)?.begin().await?;
    let r = rx(&mut tx, &a, p, id).await?;
    if r["signed_at"].is_null() {
        return Err(Error::Conflict("a draft has no authorized printable order"));
    }
    let snap = &r["signed_snapshot"];
    let c = &snap["content"];
    let patient = &snap["patient"];
    let provider = &snap["provider"];
    let pharmacy = &snap["pharmacy"]["content"];
    let field = |v: &Value| escape(v.as_str().unwrap_or(""));
    let body=format!("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>SunCharts medication order</title><body><h1>Medication order — local record</h1><p>Current status: <strong>{}</strong> · Order {} · version {}</p><p>Patient: {} {} · DOB {} · MRN {}</p><h2>{}</h2><p>{} · {}</p><p>Dose: {} · Route: {} · Frequency: {}</p><p>Directions: {}</p><p>Indication: {}</p><p>Quantity: {} {} · Refills: {} · Days supply: {}</p><p>Start: {} · End: {} · Substitution allowed: {}</p><p>Intended pharmacy: {} · {} · {}</p><p>Locally authorized by {} · NPI {} · {}</p><p>No electronic pharmacy transmission, pharmacy acceptance or dispensing is recorded by this document. Use your jurisdiction’s required prescribing process. Local handoff status: {}.</p><p>Use your browser’s Print command. A printed copy does not confirm fulfillment.</p></body></html>",field(&r["status"]),id,r["version"],field(&patient["given_name"]),field(&patient["family_name"]),field(&patient["birth_date"]),field(&patient["mrn"]),field(&c["medication_name"]),field(&c["strength"]),field(&c["dosage_form"]),field(&c["dose"]),field(&c["route"]),field(&c["frequency"]),field(&c["instructions"]),field(&c["indication"]),field(&c["quantity"]),field(&c["quantity_unit"]),c["refills"],c["days_supply"].as_i64().map(|n|n.to_string()).unwrap_or_else(||"Not recorded".into()),field(&c["start_date"]),field(&c["end_date"]),c["substitution_allowed"],field(&pharmacy["name"]),field(&pharmacy["address"]),field(&pharmacy["phone"]),field(&provider["display_name"]),field(&provider["npi"]),field(&r["signed_at"]),field(&r["fulfillment_status"]));
    audit(&mut tx, &a, "prescribing.print_viewed", id).await?;
    tx.commit().await?;
    Ok((
        [
            (header::CACHE_CONTROL, "no-store"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
            ),
        ],
        Html(body),
    )
        .into_response())
}
