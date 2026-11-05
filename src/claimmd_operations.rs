// SPDX-License-Identifier: AGPL-3.0-only
//! Claim.MD account operations backed by the official API 1.19 contracts.
use crate::{
    auth::{Actor, Role},
    delivery::Route,
    error::{Error, Result},
    State,
};
use axum::{
    body::Body,
    extract::{Path, State as ExtractState},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

const MAX_JSON: usize = 4 * 1024 * 1024;
const MAX_X12: usize = 16 * 1024 * 1024;

fn owner(actor: &Actor) -> Result<()> {
    if matches!(actor.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn token(route: &Route) -> Result<&str> {
    route
        .credential_value
        .as_ref()
        .map(|value| value.expose())
        .ok_or(Error::Invalid("Claim.MD AccountKey unavailable"))
}
fn base(route: &Route) -> Result<String> {
    if route.loopback_test {
        Ok(url::Url::parse(&route.endpoint)
            .map_err(|_| Error::Invalid("invalid Claim.MD endpoint"))?
            .origin()
            .ascii_serialization())
    } else {
        Ok("https://svc.claim.md".into())
    }
}
fn numeric(value: &Value, field: &'static str) -> Result<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_u64().map(|v| v.to_string()))
        .filter(|v| !v.is_empty() && v.len() <= 24 && v.bytes().all(|b| b.is_ascii_digit()))
        .ok_or(Error::Invalid(field))
}
fn identifier(value: &Value, field: &'static str) -> Result<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_u64().map(|v| v.to_string()))
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 80
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .ok_or(Error::Invalid(field))
}
fn bounded(value: &Value) -> Result<()> {
    if serde_json::to_vec(value)
        .map_err(|_| Error::Invalid("invalid Claim.MD response"))?
        .len()
        > 16_384
    {
        return Err(Error::Invalid("Claim.MD record exceeds supported limit"));
    }
    Ok(())
}
fn rows(value: &Value, key: &'static str) -> Result<Vec<Value>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(values)) => Ok(values.clone()),
        Some(Value::Object(_)) => Ok(vec![value[key].clone()]),
        _ => Err(Error::Invalid("invalid Claim.MD response collection")),
    }
}
async fn form(
    pool: &PgPool,
    route: &Route,
    service: &str,
    mut fields: Vec<(String, String)>,
) -> Result<Value> {
    crate::claimmd_eligibility::acquire_rate_limit(pool, route).await?;
    fields.push(("AccountKey".into(), token(route)?.into()));
    let response = crate::stedi::client()?
        .post(format!("{}/services/{service}/", base(route)?))
        .header(header::ACCEPT, "application/json")
        .form(&fields)
        .send()
        .await
        .map_err(|_| Error::Invalid("Claim.MD request outcome is uncertain"))?;
    if response.status() != StatusCode::OK {
        return Err(Error::Invalid("Claim.MD request failed"));
    }
    let value: Value = serde_json::from_slice(&crate::stedi::bytes(response, MAX_JSON).await?)
        .map_err(|_| Error::Invalid("invalid Claim.MD JSON response"))?;
    if value.get("error").is_some() {
        return Err(Error::Invalid(
            "Claim.MD returned an account or request error",
        ));
    }
    Ok(value)
}
async fn route(state: &State, actor: &Actor, setting: Uuid) -> Result<Route> {
    crate::provider_settings::claimmd_route(db(state)?, actor.tenant_id, setting).await
}
async fn load_cursor(
    pool: &PgPool,
    tenant: Uuid,
    setting: Uuid,
    modification: bool,
) -> Result<String> {
    sqlx::query("INSERT INTO claimmd_operation_cursors(tenant_id,setting_id) VALUES($1,$2) ON CONFLICT DO NOTHING")
        .bind(tenant)
        .bind(setting)
        .execute(pool)
        .await?;
    let query = if modification {
        "SELECT modification_id FROM claimmd_operation_cursors WHERE tenant_id=$1 AND setting_id=$2"
    } else {
        "SELECT note_id FROM claimmd_operation_cursors WHERE tenant_id=$1 AND setting_id=$2"
    };
    Ok(sqlx::query_scalar(query)
        .bind(tenant)
        .bind(setting)
        .fetch_one(pool)
        .await?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UploadedRequest {
    #[serde(default = "one")]
    page: u16,
    upload_date: Option<NaiveDate>,
}
fn one() -> u16 {
    1
}
async fn sync_uploaded(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(setting): Path<Uuid>,
    Json(input): Json<UploadedRequest>,
) -> Result<Json<Value>> {
    owner(&actor)?;
    if !(1..=10_000).contains(&input.page) {
        return Err(Error::Invalid("Claim.MD upload page is invalid"));
    }
    let route = route(&state, &actor, setting).await?;
    let mut fields = vec![("Page".into(), input.page.to_string())];
    if let Some(date) = input.upload_date {
        fields.push(("UploadDate".into(), date.to_string()));
    }
    let response = form(db(&state)?, &route, "uploadlist", fields).await?;
    let files = rows(&response, "file")?;
    if files.len() > 500 {
        return Err(Error::Invalid(
            "Claim.MD upload page exceeds documented limit",
        ));
    }
    let mut tx = db(&state)?.begin().await?;
    let mut inserted = 0u64;
    for file in &files {
        bounded(file)?;
        let remote = numeric(&file["inboundid"], "Claim.MD uploaded file ID is invalid")?;
        inserted += sqlx::query("INSERT INTO claimmd_operation_records(tenant_id,setting_id,kind,remote_id,content) VALUES($1,$2,'uploaded_file',$3,$4) ON CONFLICT DO NOTHING")
            .bind(actor.tenant_id).bind(setting).bind(remote).bind(file).execute(&mut *tx).await?.rows_affected();
    }
    crate::postgres::audit(&mut tx, &actor, "claimmd.uploaded_files_sync", setting).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"received":files.len(),"inserted":inserted,"page":input.page}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorRequest {
    claimmd_id: Option<String>,
}
fn valid_claimmd_id(value: Option<String>) -> Result<Option<String>> {
    value
        .map(|v| {
            if v.is_empty() || v.len() > 80 || !v.bytes().all(|b| b.is_ascii_alphanumeric()) {
                Err(Error::Invalid("Claim.MD claim ID is invalid"))
            } else {
                Ok(v)
            }
        })
        .transpose()
}
async fn sync_modifications(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(setting): Path<Uuid>,
    Json(input): Json<CursorRequest>,
) -> Result<Json<Value>> {
    owner(&actor)?;
    let claimmd_id = valid_claimmd_id(input.claimmd_id)?;
    let cursor = load_cursor(db(&state)?, actor.tenant_id, setting, true).await?;
    let route = route(&state, &actor, setting).await?;
    let mut fields = vec![(
        "ModID".into(),
        if claimmd_id.is_some() {
            "0".into()
        } else {
            cursor.clone()
        },
    )];
    if let Some(value) = &claimmd_id {
        fields.push(("ClaimMD_ID".into(), value.clone()));
    }
    let response = form(db(&state)?, &route, "modify", fields).await?;
    let last = numeric(
        &response["LastModid"],
        "Claim.MD modification cursor is invalid",
    )?;
    if claimmd_id.is_none() && last.parse::<u128>().ok() < cursor.parse::<u128>().ok() {
        return Err(Error::Invalid("Claim.MD modification cursor regressed"));
    }
    let claims = rows(&response, "claim")?;
    let mut tx = db(&state)?.begin().await?;
    let locked:String=sqlx::query_scalar("SELECT modification_id FROM claimmd_operation_cursors WHERE tenant_id=$1 AND setting_id=$2 FOR UPDATE").bind(actor.tenant_id).bind(setting).fetch_one(&mut *tx).await?;
    if claimmd_id.is_none() && locked != cursor {
        return Err(Error::Conflict(
            "Claim.MD modifications were synchronized by another session",
        ));
    }
    let mut inserted = 0u64;
    for claim in claims {
        let remote_claimmd = numeric(&claim["claimmd_id"], "Claim.MD claim ID is invalid")?;
        let claim_id = claim["claimid"]
            .as_str()
            .filter(|v| v.len() <= 200)
            .map(str::to_owned);
        let pcn = claim["pcn"]
            .as_str()
            .filter(|v| v.len() <= 200)
            .map(str::to_owned);
        for modification in rows(&claim, "modification")? {
            bounded(&modification)?;
            let remote = numeric(
                &modification["modid"],
                "Claim.MD modification ID is invalid",
            )?;
            inserted+=sqlx::query("INSERT INTO claimmd_operation_records(tenant_id,setting_id,kind,remote_id,claimmd_id,claim_id,patient_control_number,content) VALUES($1,$2,'modification',$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING")
                .bind(actor.tenant_id).bind(setting).bind(remote).bind(&remote_claimmd).bind(&claim_id).bind(&pcn).bind(&modification).execute(&mut *tx).await?.rows_affected();
        }
    }
    if claimmd_id.is_none() {
        sqlx::query("UPDATE claimmd_operation_cursors SET modification_id=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND setting_id=$2").bind(actor.tenant_id).bind(setting).bind(&last).execute(&mut *tx).await?;
    }
    crate::postgres::audit(&mut tx, &actor, "claimmd.modifications_sync", setting).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"inserted":inserted,"last_modification_id":last,"cursor_advanced":claimmd_id.is_none()}),
    ))
}

async fn sync_notes(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(setting): Path<Uuid>,
    Json(input): Json<CursorRequest>,
) -> Result<Json<Value>> {
    owner(&actor)?;
    let claimmd_id = valid_claimmd_id(input.claimmd_id)?;
    let cursor = load_cursor(db(&state)?, actor.tenant_id, setting, false).await?;
    let route = route(&state, &actor, setting).await?;
    let mut fields = vec![(
        "NoteID".into(),
        if claimmd_id.is_some() {
            "0".into()
        } else {
            cursor.clone()
        },
    )];
    if let Some(value) = &claimmd_id {
        fields.push(("ClaimMD_ID".into(), value.clone()));
    }
    let response = form(db(&state)?, &route, "notes", fields).await?;
    let last = numeric(&response["LastNoteID"], "Claim.MD note cursor is invalid")?;
    if claimmd_id.is_none() && last.parse::<u128>().ok() < cursor.parse::<u128>().ok() {
        return Err(Error::Invalid("Claim.MD note cursor regressed"));
    }
    let notes = rows(&response, "notes")?;
    let mut tx = db(&state)?.begin().await?;
    let locked:String=sqlx::query_scalar("SELECT note_id FROM claimmd_operation_cursors WHERE tenant_id=$1 AND setting_id=$2 FOR UPDATE").bind(actor.tenant_id).bind(setting).fetch_one(&mut *tx).await?;
    if claimmd_id.is_none() && locked != cursor {
        return Err(Error::Conflict(
            "Claim.MD notes were synchronized by another session",
        ));
    }
    let mut inserted = 0u64;
    for note in notes {
        bounded(&note)?;
        let remote = numeric(&note["noteid"], "Claim.MD note ID is invalid")?;
        let remote_claimmd = numeric(&note["claimmd_id"], "Claim.MD claim ID is invalid")?;
        inserted+=sqlx::query("INSERT INTO claimmd_operation_records(tenant_id,setting_id,kind,remote_id,claimmd_id,claim_id,patient_control_number,content) VALUES($1,$2,'note',$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING").bind(actor.tenant_id).bind(setting).bind(remote).bind(remote_claimmd).bind(note["claimid"].as_str()).bind(note["pcn"].as_str()).bind(&note).execute(&mut *tx).await?.rows_affected();
    }
    if claimmd_id.is_none() {
        sqlx::query("UPDATE claimmd_operation_cursors SET note_id=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND setting_id=$2").bind(actor.tenant_id).bind(setting).bind(&last).execute(&mut *tx).await?;
    }
    crate::postgres::audit(&mut tx, &actor, "claimmd.notes_sync", setting).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"inserted":inserted,"last_note_id":last,"cursor_advanced":claimmd_id.is_none()}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClaimDataRequest {
    request_id: Uuid,
    transmit_date: NaiveDate,
    claim_form: String,
    #[serde(default)]
    page: u16,
    bill_npi: Option<String>,
    bill_taxid: Option<String>,
    payerid: Option<String>,
    reason: String,
}
fn simple_filter(value: Option<String>, max: usize) -> Result<Option<String>> {
    value
        .map(|v| {
            if v.is_empty()
                || v.len() > max
                || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                Err(Error::Invalid("Claim.MD claim filter is invalid"))
            } else {
                Ok(v)
            }
        })
        .transpose()
}
async fn claim_data(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(setting): Path<Uuid>,
    Json(input): Json<ClaimDataRequest>,
) -> Result<Json<Value>> {
    owner(&actor)?;
    if !["1500", "ub", "dental"].contains(&input.claim_form.as_str())
        || input.page > 10_000
        || input.reason.trim().is_empty()
        || input.reason.len() > 1000
    {
        return Err(Error::Invalid(
            "Claim.MD transmitted-claim request is invalid",
        ));
    }
    let npi = simple_filter(input.bill_npi, 10)?;
    let tax = simple_filter(input.bill_taxid, 20)?;
    let payer = simple_filter(input.payerid, 20)?;
    if let Some((id,date,form,page,filters))=sqlx::query_as::<_,(Uuid,NaiveDate,String,i32,Value)>("SELECT id,transmit_date,claim_form,page,filters FROM claimmd_transmitted_claim_files WHERE tenant_id=$1 AND request_id=$2").bind(actor.tenant_id).bind(input.request_id).fetch_optional(db(&state)?).await?{let expected=json!({"bill_npi":npi,"bill_taxid":tax,"payerid":payer});if date!=input.transmit_date||form!=input.claim_form||page!=i32::from(input.page)||filters!=expected{return Err(Error::Conflict("request ID was already used for different Claim.MD filters"));}return Ok(Json(json!({"id":id,"replayed":true})));}
    let route = route(&state, &actor, setting).await?;
    crate::claimmd_eligibility::acquire_rate_limit(db(&state)?, &route).await?;
    let mut fields: Vec<(String, String)> = vec![
        ("AccountKey".into(), token(&route)?.into()),
        ("transmit_date".into(), input.transmit_date.to_string()),
        ("claim_form".into(), input.claim_form.clone()),
        ("pg".into(), input.page.to_string()),
    ];
    for (k, v) in [
        ("bill_npi", &npi),
        ("bill_taxid", &tax),
        ("payerid", &payer),
    ] {
        if let Some(v) = v {
            fields.push((k.into(), v.clone()));
        }
    }
    let response = crate::stedi::client()?
        .post(format!("{}/services/claimdata/", base(&route)?))
        .header(header::ACCEPT, "application/json")
        .form(&fields)
        .send()
        .await
        .map_err(|_| Error::Invalid("Claim.MD transmitted-claim request failed"))?;
    if response.status() != StatusCode::OK {
        return Err(Error::Invalid("Claim.MD transmitted-claim request failed"));
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = crate::stedi::bytes(response, MAX_X12).await?;
    if !content_type.starts_with("application/edi-x12") {
        return Err(Error::Invalid(
            "Claim.MD returned no transmitted claims for this page",
        ));
    }
    let x12 =
        String::from_utf8(bytes).map_err(|_| Error::Invalid("Claim.MD returned invalid X12"))?;
    if !x12.is_ascii() || !x12.contains("ST*837") {
        return Err(Error::Invalid("Claim.MD returned unsupported X12"));
    }
    let id = Uuid::new_v4();
    let hash = format!("{:x}", Sha256::digest(x12.as_bytes()));
    let filters = json!({"bill_npi":npi,"bill_taxid":tax,"payerid":payer});
    let mut tx = db(&state)?.begin().await?;
    sqlx::query("INSERT INTO claimmd_transmitted_claim_files(tenant_id,id,setting_id,request_id,actor_id,transmit_date,claim_form,page,filters,original_x12,payload_hash,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)").bind(actor.tenant_id).bind(id).bind(setting).bind(input.request_id).bind(actor.sub).bind(input.transmit_date).bind(&input.claim_form).bind(i32::from(input.page)).bind(filters).bind(x12).bind(hash).bind(input.reason.trim()).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "claimmd.transmitted_claims_downloaded", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id,"replayed":false})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveRequest {
    request_id: Uuid,
    claim_ids: Vec<String>,
    reason: String,
    reviewed: bool,
}
async fn archive(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(setting): Path<Uuid>,
    Json(mut input): Json<ArchiveRequest>,
) -> Result<Json<Value>> {
    owner(&actor)?;
    if !input.reviewed
        || input.claim_ids.is_empty()
        || input.claim_ids.len() > 100
        || input.reason.trim().is_empty()
        || input.reason.len() > 1000
    {
        return Err(Error::Invalid("Claim.MD archive review is incomplete"));
    }
    for id in &input.claim_ids {
        if id.is_empty() || id.len() > 80 || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(Error::Invalid("Claim.MD archive claim ID is invalid"));
        }
    }
    input.claim_ids.sort();
    input.claim_ids.dedup();
    let route = route(&state, &actor, setting).await?;
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&input.claim_ids).unwrap())
    );
    let inserted=sqlx::query("INSERT INTO claimmd_external_requests(tenant_id,request_id,setting_id,operation,request_hash,actor_id,reason,status) VALUES($1,$2,$3,'archive',$4,$5,$6,'pending') ON CONFLICT DO NOTHING").bind(actor.tenant_id).bind(input.request_id).bind(setting).bind(&digest).bind(actor.sub).bind(input.reason.trim()).execute(db(&state)?).await?.rows_affected();
    if inserted == 0 {
        let(status,hash,response):(String,String,Option<Value>)=sqlx::query_as("SELECT status,request_hash,response FROM claimmd_external_requests WHERE tenant_id=$1 AND request_id=$2").bind(actor.tenant_id).bind(input.request_id).fetch_one(db(&state)?).await?;
        if hash != digest {
            return Err(Error::Conflict(
                "request ID was already used for different claims",
            ));
        }
        return match status.as_str() {
            "completed" => Ok(Json(
                json!({"status":"completed","response":response,"replayed":true}),
            )),
            _ => Err(Error::Conflict(
                "prior Claim.MD archive outcome requires review before retry",
            )),
        };
    }
    let fields = input
        .claim_ids
        .iter()
        .map(|id| ("claimid".into(), id.clone()))
        .collect();
    let outcome = form(db(&state)?, &route, "archive", fields).await;
    let response = match outcome {
        Ok(v) => v,
        Err(e) => {
            sqlx::query("UPDATE claimmd_external_requests SET status='uncertain',updated_at=clock_timestamp() WHERE tenant_id=$1 AND request_id=$2 AND status='pending'").bind(actor.tenant_id).bind(input.request_id).execute(db(&state)?).await?;
            return Err(e);
        }
    };
    let results = rows(&response, "result")?;
    if results.is_empty() {
        sqlx::query("UPDATE claimmd_external_requests SET status='uncertain',response=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND request_id=$2 AND status='pending'")
            .bind(actor.tenant_id).bind(input.request_id).bind(&response).execute(db(&state)?).await?;
        return Err(Error::Invalid("Claim.MD archive response is empty"));
    }
    let mut tx = db(&state)?.begin().await?;
    for row in &results {
        bounded(row)?;
        let remote = identifier(&row["claimid"], "Claim.MD archive claim ID is invalid")?;
        sqlx::query("INSERT INTO claimmd_operation_records(tenant_id,setting_id,kind,remote_id,claimmd_id,content,actor_id,reason) VALUES($1,$2,'archive',$3,$3,$4,$5,$6) ON CONFLICT DO NOTHING").bind(actor.tenant_id).bind(setting).bind(remote).bind(row).bind(actor.sub).bind(input.reason.trim()).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE claimmd_external_requests SET status='completed',response=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND request_id=$2 AND status='pending'").bind(actor.tenant_id).bind(input.request_id).bind(&response).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "claimmd.claims_archived", input.request_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"status":"completed","response":response,"replayed":false}),
    ))
}

async fn list(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(setting): Path<Uuid>,
) -> Result<Json<Value>> {
    owner(&actor)?;
    route(&state, &actor, setting).await?;
    let records:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id'-'setting_id' FROM claimmd_operation_records r WHERE tenant_id=$1 AND setting_id=$2 ORDER BY recorded_at DESC LIMIT 500").bind(actor.tenant_id).bind(setting).fetch_all(db(&state)?).await?;
    let files:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(f)-'tenant_id'-'original_x12' FROM claimmd_transmitted_claim_files f WHERE tenant_id=$1 AND setting_id=$2 ORDER BY created_at DESC LIMIT 100").bind(actor.tenant_id).bind(setting).fetch_all(db(&state)?).await?;
    Ok(Json(json!({"records":records,"transmitted_files":files})))
}
async fn file(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    owner(&actor)?;
    let(payload,hash):(String,String)=sqlx::query_as("SELECT original_x12,payload_hash FROM claimmd_transmitted_claim_files WHERE tenant_id=$1 AND id=$2").bind(actor.tenant_id).bind(id).fetch_optional(db(&state)?).await?.ok_or(Error::NotFound)?;
    let mut response = (StatusCode::OK, Body::from(payload)).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/edi-x12"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=claimmd-transmitted-{}.x12",
            id.simple()
        ))
        .map_err(|_| Error::Invalid("invalid artifact filename"))?,
    );
    response.headers_mut().insert(
        "x-content-sha256",
        HeaderValue::from_str(&hash).map_err(|_| Error::Invalid("invalid artifact hash"))?,
    );
    Ok(response)
}

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/billing/claimmd/{setting}/operations", get(list))
        .route(
            "/api/v1/billing/claimmd/{setting}/uploaded-files/sync",
            post(sync_uploaded),
        )
        .route(
            "/api/v1/billing/claimmd/{setting}/modifications/sync",
            post(sync_modifications),
        )
        .route(
            "/api/v1/billing/claimmd/{setting}/notes/sync",
            post(sync_notes),
        )
        .route(
            "/api/v1/billing/claimmd/{setting}/transmitted-claims",
            post(claim_data),
        )
        .route("/api/v1/billing/claimmd/{setting}/archive", post(archive))
        .route(
            "/api/v1/billing/claimmd/transmitted-claims/{id}/file",
            get(file),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn collections_accept_documented_single_or_array_shapes() {
        assert_eq!(
            rows(&json!({"file":{"inboundid":"1"}}), "file")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            rows(
                &json!({"file":[{"inboundid":"1"},{"inboundid":"2"}]}),
                "file"
            )
            .unwrap()
            .len(),
            2
        );
    }
    #[test]
    fn claim_ids_and_filters_are_bounded() {
        assert!(valid_claimmd_id(Some("135961467".into())).is_ok());
        assert!(valid_claimmd_id(Some("bad/id".into())).is_err());
        assert!(simple_filter(Some("1234567893".into()), 10).is_ok());
        assert!(simple_filter(Some("12345678901".into()), 10).is_err());
    }
}
