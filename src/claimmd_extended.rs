// SPDX-License-Identifier: AGPL-3.0-only
//! Native Claim.MD ERA documents, enrollment, appeals, and signed event intake.
use crate::{
    auth::{Actor, Role},
    delivery::Route,
    error::{Error, Result},
    State,
};
use aws_lc_rs::hmac;
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State as ExtractState},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use uuid::Uuid;

const MAX_PROVIDER_RESPONSE: usize = 16 * 1024 * 1024;

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/billing/claimmd/operations", get(list_operations))
        .route(
            "/api/v1/billing/claimmd/enrollments",
            post(start_enrollment),
        )
        .route("/api/v1/billing/claimmd/appeals", post(start_appeal))
        .route(
            "/api/v1/billing/claimmd/eras/{eraid}/pdf",
            post(fetch_era_pdf),
        )
        .route(
            "/api/v1/billing/claimmd/eras/{eraid}/structured",
            post(fetch_era_structured),
        )
        .route(
            "/api/v1/billing/claimmd/era-documents/{id}",
            get(download_era_document),
        )
        .route(
            "/api/v1/billing/claimmd/webhook/{setting_id}",
            post(webhook),
        )
        .layer(DefaultBodyLimit::max(1024 * 1024))
}

fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}

fn owner(actor: &Actor) -> Result<()> {
    if matches!(actor.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

fn clean(value: &str, max: usize, required: bool) -> Result<String> {
    let value = value.trim();
    if value.len() > max || (required && value.is_empty()) || value.contains('\0') {
        return Err(Error::Invalid("invalid Claim.MD field"));
    }
    Ok(value.to_owned())
}

async fn route(pool: &PgPool, tenant: Uuid, requested: Option<Uuid>) -> Result<(Uuid, Route)> {
    let routes = crate::provider_settings::active_claimmd_routes(pool, tenant).await?;
    match requested {
        Some(id) => routes
            .into_iter()
            .find(|(candidate, _)| *candidate == id)
            .ok_or(Error::NotFound),
        None if routes.len() == 1 => Ok(routes.into_iter().next().unwrap()),
        None if routes.is_empty() => Err(Error::Conflict(
            "a verified active Claim.MD connection is required",
        )),
        None => Err(Error::Conflict(
            "choose the Claim.MD connection for this operation",
        )),
    }
}

fn service_url(route: &Route, service: &str) -> Result<String> {
    if route.loopback_test {
        let url = url::Url::parse(&route.endpoint).map_err(|_| Error::Invalid("invalid route"))?;
        Ok(format!(
            "{}/services/{service}/",
            url.origin().ascii_serialization()
        ))
    } else {
        Ok(format!("https://svc.claim.md/services/{service}/"))
    }
}

async fn form(
    pool: &PgPool,
    route: &Route,
    service: &str,
    mut fields: Vec<(String, String)>,
) -> Result<Value> {
    crate::claimmd_eligibility::acquire_rate_limit(pool, route).await?;
    fields.push(("AccountKey".into(), crate::claimmd::token(route)?));
    let response = crate::stedi::client()?
        .post(service_url(route, service)?)
        .header(header::ACCEPT, "application/json")
        .form(&fields)
        .send()
        .await
        .map_err(|_| Error::Invalid("Claim.MD request failed"))?;
    if response.status() != StatusCode::OK {
        return Err(Error::Invalid("Claim.MD request returned HTTP failure"));
    }
    let value: Value =
        serde_json::from_slice(&crate::stedi::bytes(response, MAX_PROVIDER_RESPONSE).await?)
            .map_err(|_| Error::Invalid("invalid Claim.MD response"))?;
    if value.get("error").is_some() {
        return Err(Error::Invalid("Claim.MD rejected the request"));
    }
    Ok(value)
}

fn provider_link(value: &Value) -> Result<String> {
    let raw = value
        .pointer("/link/url")
        .or_else(|| value.pointer("/result/link/url"))
        .and_then(Value::as_str)
        .ok_or(Error::Invalid("Claim.MD response link missing"))?;
    let url = url::Url::parse(raw).map_err(|_| Error::Invalid("invalid Claim.MD response link"))?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("www.claim.md" | "claim.md"))
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::Invalid("invalid Claim.MD response link"));
    }
    Ok(url.to_string())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnrollmentRequest {
    setting_id: Option<Uuid>,
    payerid: String,
    enroll_type: String,
    prov_taxid: String,
    prov_npi: Option<String>,
    prov_name_l: Option<String>,
    prov_name_f: Option<String>,
    prov_name_m: Option<String>,
    contact: Option<String>,
    contact_title: Option<String>,
    contact_email: Option<String>,
    contact_phone: Option<String>,
    contact_fax: Option<String>,
    prov_id: Option<String>,
    prov_addr_1: Option<String>,
    prov_addr_2: Option<String>,
    prov_city: Option<String>,
    prov_state: Option<String>,
    prov_zip: Option<String>,
    reason: String,
}

fn optional(
    fields: &mut Vec<(String, String)>,
    key: &str,
    value: &Option<String>,
    max: usize,
) -> Result<()> {
    if let Some(value) = value {
        let value = clean(value, max, false)?;
        if !value.is_empty() {
            fields.push((key.into(), value));
        }
    }
    Ok(())
}

async fn start_enrollment(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Json(input): Json<EnrollmentRequest>,
) -> Result<Json<Value>> {
    owner(&actor)?;
    let reason = clean(&input.reason, 1000, true)?;
    if !["era", "1500", "500", "ub", "elig", "attach"].contains(&input.enroll_type.as_str()) {
        return Err(Error::Invalid("unsupported Claim.MD enrollment type"));
    }
    if input.prov_npi.as_deref().unwrap_or("").trim().is_empty()
        && input.prov_name_l.as_deref().unwrap_or("").trim().is_empty()
    {
        return Err(Error::Invalid("provider NPI or provider name is required"));
    }
    let (setting, route) = route(db(&state)?, actor.tenant_id, input.setting_id).await?;
    let mut fields = vec![
        ("payerid".into(), clean(&input.payerid, 20, true)?),
        ("enroll_type".into(), input.enroll_type.clone()),
        ("prov_taxid".into(), clean(&input.prov_taxid, 20, true)?),
    ];
    for (key, value, max) in [
        ("prov_npi", &input.prov_npi, 10),
        ("prov_name_l", &input.prov_name_l, 120),
        ("prov_name_f", &input.prov_name_f, 80),
        ("prov_name_m", &input.prov_name_m, 80),
        ("contact", &input.contact, 120),
        ("contact_title", &input.contact_title, 120),
        ("contact_email", &input.contact_email, 320),
        ("contact_phone", &input.contact_phone, 30),
        ("contact_fax", &input.contact_fax, 30),
        ("prov_id", &input.prov_id, 80),
        ("prov_addr_1", &input.prov_addr_1, 120),
        ("prov_addr_2", &input.prov_addr_2, 120),
        ("prov_city", &input.prov_city, 80),
        ("prov_state", &input.prov_state, 2),
        ("prov_zip", &input.prov_zip, 12),
    ] {
        optional(&mut fields, key, value, max)?;
    }
    let response = form(db(&state)?, &route, "enroll", fields).await?;
    let link = provider_link(&response)?;
    let id = Uuid::new_v4();
    let request = json!({
        "payerid": input.payerid.trim(), "enroll_type": input.enroll_type,
        "prov_taxid": input.prov_taxid.trim(), "prov_npi": input.prov_npi,
        "prov_name_l": input.prov_name_l, "prov_name_f": input.prov_name_f,
        "reason": reason
    });
    let mut tx = db(&state)?.begin().await?;
    sqlx::query("INSERT INTO claimmd_operations(tenant_id,id,setting_id,kind,request,external_url,created_by) VALUES($1,$2,$3,'enrollment',$4,$5,$6)")
        .bind(actor.tenant_id).bind(id).bind(setting).bind(&request).bind(&link).bind(actor.sub).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO claimmd_operation_events(tenant_id,operation_id,version,actor_id,action,evidence) VALUES($1,$2,1,$3,'started',$4)")
        .bind(actor.tenant_id).bind(id).bind(actor.sub).bind(json!({"reason":reason})).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "claimmd.enrollment_started", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"kind":"enrollment","status":"started","external_url":link,"version":1}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AppealRequest {
    setting_id: Option<Uuid>,
    native_claim_id: Option<Uuid>,
    claimid: Option<String>,
    remote_claimid: Option<String>,
    contact_name: Option<String>,
    contact_title: Option<String>,
    contact_email: Option<String>,
    contact_phone: Option<String>,
    contact_fax: Option<String>,
    contact_addr_1: Option<String>,
    contact_addr_2: Option<String>,
    contact_city: Option<String>,
    contact_state: Option<String>,
    contact_zip: Option<String>,
    reason: String,
}

async fn start_appeal(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Json(input): Json<AppealRequest>,
) -> Result<Json<Value>> {
    owner(&actor)?;
    let reason = clean(&input.reason, 1000, true)?;
    let claimid = input.claimid.as_deref().unwrap_or("").trim();
    let mut remote = input
        .remote_claimid
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_owned();
    if let Some(native_claim_id) = input.native_claim_id {
        let control_number: String = sqlx::query_scalar(
            "SELECT control_number FROM ehr_claims WHERE tenant_id=$1 AND id=$2",
        )
        .bind(actor.tenant_id)
        .bind(native_claim_id)
        .fetch_optional(db(&state)?)
        .await?
        .ok_or(Error::NotFound)?;
        if !remote.is_empty() && remote != control_number {
            return Err(Error::Conflict(
                "remote claim ID does not match the selected SunCharts claim",
            ));
        }
        remote = control_number;
    }
    if (claimid.is_empty() && remote.is_empty()) || (!claimid.is_empty() && !remote.is_empty()) {
        return Err(Error::Invalid(
            "choose exactly one Claim.MD claim identifier",
        ));
    }
    let (setting, route) = route(db(&state)?, actor.tenant_id, input.setting_id).await?;
    let mut fields = Vec::new();
    if !claimid.is_empty() {
        fields.push(("claimid".into(), clean(claimid, 80, true)?));
    } else {
        fields.push(("remote_claimid".into(), clean(&remote, 150, true)?));
    }
    for (key, value, max) in [
        ("contact_name", &input.contact_name, 120),
        ("contact_title", &input.contact_title, 120),
        ("contact_email", &input.contact_email, 320),
        ("contact_phone", &input.contact_phone, 30),
        ("contact_fax", &input.contact_fax, 30),
        ("contact_addr_1", &input.contact_addr_1, 120),
        ("contact_addr_2", &input.contact_addr_2, 120),
        ("contact_city", &input.contact_city, 80),
        ("contact_state", &input.contact_state, 2),
        ("contact_zip", &input.contact_zip, 12),
    ] {
        optional(&mut fields, key, value, max)?;
    }
    let response = form(db(&state)?, &route, "appeal", fields).await?;
    let link = provider_link(&response)?;
    let id = Uuid::new_v4();
    let request = json!({"native_claim_id":input.native_claim_id,"claimid":input.claimid,"remote_claimid":remote,"reason":reason});
    let mut tx = db(&state)?.begin().await?;
    sqlx::query("INSERT INTO claimmd_operations(tenant_id,id,setting_id,claim_id,kind,request,external_url,created_by) VALUES($1,$2,$3,$4,'appeal',$5,$6,$7)")
        .bind(actor.tenant_id).bind(id).bind(setting).bind(input.native_claim_id).bind(&request).bind(&link).bind(actor.sub).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO claimmd_operation_events(tenant_id,operation_id,version,actor_id,action,evidence) VALUES($1,$2,1,$3,'started',$4)")
        .bind(actor.tenant_id).bind(id).bind(actor.sub).bind(json!({"reason":reason})).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "claimmd.appeal_started", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"kind":"appeal","status":"started","external_url":link,"version":1}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EraRequest {
    setting_id: Option<Uuid>,
    pcn: Option<String>,
    reason: String,
}

fn response_data(value: &mut Value) -> Result<Value> {
    let data = value
        .get_mut("data")
        .map(Value::take)
        .ok_or(Error::Invalid("Claim.MD ERA document missing"))?;
    Ok(match data {
        Value::Array(mut values) if values.len() == 1 => values.remove(0),
        value => value,
    })
}

async fn fetch_era_pdf(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(eraid): Path<String>,
    Json(input): Json<EraRequest>,
) -> Result<Json<Value>> {
    owner(&actor)?;
    let eraid = clean(&eraid, 20, true)?;
    if !eraid.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::Invalid("invalid Claim.MD ERA ID"));
    }
    let reason = clean(&input.reason, 1000, true)?;
    let (setting, route) = route(db(&state)?, actor.tenant_id, input.setting_id).await?;
    let mut fields = vec![("eraid".into(), eraid.clone())];
    optional(&mut fields, "pcn", &input.pcn, 150)?;
    let mut response = form(db(&state)?, &route, "erapdf", fields).await?;
    let encoded = response_data(&mut response)?
        .as_str()
        .ok_or(Error::Invalid("Claim.MD ERA PDF encoding invalid"))?
        .to_owned();
    let content = STANDARD
        .decode(encoded.as_bytes())
        .map_err(|_| Error::Invalid("Claim.MD ERA PDF encoding invalid"))?;
    if content.len() > MAX_PROVIDER_RESPONSE || !content.starts_with(b"%PDF-") {
        return Err(Error::Invalid("Claim.MD ERA PDF invalid"));
    }
    let id = Uuid::new_v4();
    let pcn = input
        .pcn
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("");
    let mut tx = db(&state)?.begin().await?;
    let stored:Uuid=sqlx::query_scalar("INSERT INTO claimmd_era_documents(tenant_id,id,setting_id,eraid,pcn,kind,content,content_hash,metadata,fetched_by) VALUES($1,$2,$3,$4,$5,'pdf',$6,$7,$8,$9) ON CONFLICT(tenant_id,setting_id,eraid,kind,pcn) DO UPDATE SET content=excluded.content,content_hash=excluded.content_hash,metadata=excluded.metadata,fetched_by=excluded.fetched_by,fetched_at=now() RETURNING id")
        .bind(actor.tenant_id).bind(id).bind(setting).bind(&eraid).bind(pcn).bind(&content).bind(crate::oauth::hash(&encoded)).bind(&response).bind(actor.sub).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO claimmd_era_document_events(tenant_id,id,document_id,actor_id,action,reason) VALUES($1,$2,$3,$4,'retrieved',$5)")
        .bind(actor.tenant_id).bind(Uuid::new_v4()).bind(stored).bind(actor.sub).bind(&reason).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "claimmd.era_pdf_fetched", stored).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":stored,"eraid":eraid,"kind":"pdf","reason":reason}),
    ))
}

async fn fetch_era_structured(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(eraid): Path<String>,
    Json(input): Json<EraRequest>,
) -> Result<Json<Value>> {
    owner(&actor)?;
    let eraid = clean(&eraid, 20, true)?;
    if !eraid.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::Invalid("invalid Claim.MD ERA ID"));
    }
    let reason = clean(&input.reason, 1000, true)?;
    let (setting, route) = route(db(&state)?, actor.tenant_id, input.setting_id).await?;
    let response = form(
        db(&state)?,
        &route,
        "eradata",
        vec![("eraid".into(), eraid.clone())],
    )
    .await?;
    if !response.is_object() {
        return Err(Error::Invalid("Claim.MD structured ERA invalid"));
    }
    let structured = response.clone();
    let raw = serde_json::to_string(&structured)
        .map_err(|_| Error::Invalid("Claim.MD structured ERA invalid"))?;
    if raw.len() > MAX_PROVIDER_RESPONSE {
        return Err(Error::Invalid("Claim.MD structured ERA too large"));
    }
    let mut metadata = response;
    if let Some(object) = metadata.as_object_mut() {
        object.remove("claim");
        object.remove("data");
    }
    let id = Uuid::new_v4();
    let mut tx = db(&state)?.begin().await?;
    let stored:Uuid=sqlx::query_scalar("INSERT INTO claimmd_era_documents(tenant_id,id,setting_id,eraid,pcn,kind,structured,content_hash,metadata,fetched_by) VALUES($1,$2,$3,$4,'','structured',$5,$6,$7,$8) ON CONFLICT(tenant_id,setting_id,eraid,kind,pcn) DO UPDATE SET structured=excluded.structured,content_hash=excluded.content_hash,metadata=excluded.metadata,fetched_by=excluded.fetched_by,fetched_at=now() RETURNING id")
        .bind(actor.tenant_id).bind(id).bind(setting).bind(&eraid).bind(&structured).bind(crate::oauth::hash(&raw)).bind(&metadata).bind(actor.sub).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO claimmd_era_document_events(tenant_id,id,document_id,actor_id,action,reason) VALUES($1,$2,$3,$4,'retrieved',$5)")
        .bind(actor.tenant_id).bind(Uuid::new_v4()).bind(stored).bind(actor.sub).bind(&reason).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "claimmd.era_structured_fetched", stored).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":stored,"eraid":eraid,"kind":"structured","reason":reason,"structured":structured}),
    ))
}

async fn list_operations(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
) -> Result<Json<Value>> {
    owner(&actor)?;
    let mut tx = db(&state)?.begin().await?;
    let operations: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(o)-'tenant_id'-'request' FROM claimmd_operations o WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 100")
        .bind(actor.tenant_id).fetch_all(&mut *tx).await?;
    let documents: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(d)-'tenant_id'-'content'-'structured' FROM claimmd_era_documents d WHERE tenant_id=$1 ORDER BY fetched_at DESC,id LIMIT 100")
        .bind(actor.tenant_id).fetch_all(&mut *tx).await?;
    let events: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('account_number',account_number,'event_id',event_id,'batch_id',batch_id,'payload',payload,'received_at',received_at) FROM claimmd_webhook_events WHERE tenant_id=$1 ORDER BY received_at DESC,event_id LIMIT 100")
        .bind(actor.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "claimmd.operations_read", actor.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"operations":operations,"era_documents":documents,"webhook_events":events}),
    ))
}

async fn download_era_document(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    owner(&actor)?;
    let mut tx = db(&state)?.begin().await?;
    let row: (String, Option<Vec<u8>>, Option<Value>) = sqlx::query_as(
        "SELECT kind,content,structured FROM claimmd_era_documents WHERE tenant_id=$1 AND id=$2",
    )
    .bind(actor.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    crate::postgres::audit(&mut tx, &actor, "claimmd.era_document_read", id).await?;
    tx.commit().await?;
    let mut response = if row.0 == "pdf" {
        row.1.ok_or(Error::NotFound)?.into_response()
    } else {
        Json(row.2.ok_or(Error::NotFound)?).into_response()
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        if row.0 == "pdf" {
            "application/pdf"
        } else {
            "application/json"
        }
        .parse()
        .unwrap(),
    );
    Ok(response)
}

fn latin1(value: &str) -> Result<Vec<u8>> {
    value
        .chars()
        .map(|c| {
            u8::try_from(c as u32).map_err(|_| Error::Invalid("Claim.MD key encoding unsupported"))
        })
        .collect()
}

fn signature(headers: &HeaderMap) -> Result<Vec<u8>> {
    let value = headers
        .get("Auth-Signature-Base64")
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() == 44)
        .ok_or(Error::Unauthorized)?;
    let decoded = STANDARD.decode(value).map_err(|_| Error::Unauthorized)?;
    if decoded.len() != 32 {
        return Err(Error::Unauthorized);
    }
    Ok(decoded)
}

fn signature_matches(secret: &str, raw_body: &[u8], supplied: &[u8]) -> Result<bool> {
    let key = hmac::Key::new(hmac::HMAC_SHA256, &latin1(secret)?);
    Ok(hmac::verify(&key, raw_body, supplied).is_ok())
}

fn scalar(value: &Value, name: &'static str, max: usize) -> Result<String> {
    let value = match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => return Err(Error::Invalid(name)),
    };
    clean(&value, max, true).map_err(|_| Error::Invalid(name))
}

async fn webhook(
    ExtractState(state): ExtractState<State>,
    Path(setting_id): Path<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode> {
    if body.is_empty() || body.len() > 1024 * 1024 {
        return Err(Error::Invalid("invalid Claim.MD webhook body"));
    }
    let supplied = signature(&headers)?;
    let (tenant, route) =
        crate::provider_settings::active_claimmd_route_by_id(db(&state)?, setting_id).await?;
    if !signature_matches(&crate::claimmd::token(&route)?, &body, &supplied)? {
        return Err(Error::Unauthorized);
    }
    let value: Value = serde_json::from_slice(&body)
        .map_err(|_| Error::Invalid("invalid Claim.MD webhook JSON"))?;
    let object = value
        .as_object()
        .ok_or(Error::Invalid("invalid Claim.MD webhook JSON"))?;
    let provider_time: DateTime<Utc> = object
        .get("UTCTime")
        .and_then(Value::as_str)
        .ok_or(Error::Invalid("Claim.MD webhook time missing"))?
        .parse()
        .map_err(|_| Error::Invalid("invalid Claim.MD webhook time"))?;
    let account = scalar(
        object
            .get("acct_number")
            .ok_or(Error::Invalid("Claim.MD account missing"))?,
        "invalid Claim.MD account",
        100,
    )?;
    let remote = object
        .get("remote_acct_number")
        .map(|v| scalar(v, "invalid remote account", 100))
        .transpose()?;
    let events = object
        .get("events")
        .and_then(Value::as_array)
        .filter(|events| (1..=100).contains(&events.len()))
        .ok_or(Error::Invalid("invalid Claim.MD webhook events"))?;
    let mut parsed = Vec::with_capacity(events.len());
    for event in events {
        let event_object: &Map<String, Value> = event
            .as_object()
            .ok_or(Error::Invalid("invalid Claim.MD webhook event"))?;
        let event_id = scalar(
            event_object
                .get("eventid")
                .ok_or(Error::Invalid("Claim.MD webhook event ID missing"))?,
            "invalid Claim.MD webhook event ID",
            120,
        )?;
        if serde_json::to_vec(event)
            .map_err(|_| Error::Invalid("invalid Claim.MD webhook event"))?
            .len()
            > 64 * 1024
        {
            return Err(Error::Invalid("Claim.MD webhook event too large"));
        }
        parsed.push((event_id, event.clone()));
    }
    let setting = setting_id;
    let hash = crate::oauth::hash(
        std::str::from_utf8(&body)
            .map_err(|_| Error::Invalid("invalid Claim.MD webhook encoding"))?,
    );
    let batch = Uuid::new_v4();
    let mut tx = db(&state)?.begin().await?;
    let inserted = sqlx::query("INSERT INTO claimmd_webhook_batches(tenant_id,id,setting_id,account_number,remote_account_number,provider_time,raw_hash,event_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,raw_hash) DO NOTHING")
        .bind(tenant).bind(batch).bind(setting).bind(&account).bind(remote).bind(provider_time).bind(hash).bind(parsed.len() as i32).execute(&mut *tx).await?;
    if inserted.rows_affected() == 0 {
        tx.commit().await?;
        return Ok(StatusCode::OK);
    }
    for (event_id, payload) in parsed {
        sqlx::query("INSERT INTO claimmd_webhook_events(tenant_id,account_number,event_id,batch_id,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,account_number,event_id) DO NOTHING")
            .bind(tenant).bind(&account).bind(event_id).bind(batch).bind(payload).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(StatusCode::OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_links_are_claimmd_https_only() {
        assert_eq!(
            provider_link(&json!({"link":{"url":"https://www.claim.md/enroll/synthetic/"}}))
                .unwrap(),
            "https://www.claim.md/enroll/synthetic/"
        );
        assert!(provider_link(&json!({"link":{"url":"https://evil.example/"}})).is_err());
    }

    #[test]
    fn signature_requires_exact_sha256_encoding() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "Auth-Signature-Base64",
            STANDARD.encode([7u8; 32]).parse().unwrap(),
        );
        assert_eq!(signature(&headers).unwrap(), vec![7u8; 32]);
        headers.insert("Auth-Signature-Base64", "not-base64".parse().unwrap());
        assert!(signature(&headers).is_err());
    }

    #[test]
    fn signature_is_bound_to_exact_body_and_selected_connection_secret() {
        let body = br#"{"acct_number":"synthetic","events":[{"eventid":"evt-1"}]}"#;
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"synthetic-connection-one");
        let supplied = hmac::sign(&key, body);
        assert!(signature_matches("synthetic-connection-one", body, supplied.as_ref()).unwrap());
        assert!(!signature_matches("synthetic-connection-two", body, supplied.as_ref()).unwrap());
        assert!(!signature_matches(
            "synthetic-connection-one",
            br#"{ "acct_number":"synthetic","events":[{"eventid":"evt-1"}]}"#,
            supplied.as_ref()
        )
        .unwrap());
    }

    #[test]
    fn response_data_accepts_claimmd_scalar_or_singleton_array() {
        let mut scalar = json!({"data":"one"});
        assert_eq!(response_data(&mut scalar).unwrap(), json!("one"));
        let mut array = json!({"data":[{"claim":[]}]});
        assert_eq!(response_data(&mut array).unwrap(), json!({"claim":[]}));
    }
}
