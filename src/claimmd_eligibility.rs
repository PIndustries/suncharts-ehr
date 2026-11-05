// SPDX-License-Identifier: AGPL-3.0-only
//! Native Claim.MD payer search and structured eligibility evidence.
use crate::{
    auth::Actor,
    delivery::{Adapter, Route},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::header,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

const MAX_RESPONSE: usize = 1_048_576;
const BENEFIT_TYPES: &str = "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 30 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91 92 93 94 95 96 97 98 99 A0 A1 A3 A4 A5 A6 A7 A8 A9 AA AB AC AD AE AF AG AH AI AJ AK AL AM AN AO AP AQ AR B1 B2 B3 BA BB BC BD BE BF BG BH BI BJ BK BL BM BN BP BQ BR BS BT BU BV BW BX BY BZ C1 CA CB CC CD CE CF CG CH CI CJ CK CL CM CN CO CP CQ DG DM DS GF GN GY IC MH NI ON PT PU RN RT TC TN UC E0 E1 E2 E3 E4 E5 E6 E7 E8 E9 E10 E11 E12 E13 E14 E15 E16 E17 E18 E19 E20 E21 E22 E23 E24 E25 E26 E27 E28 E29 E30 E31 E32 E33 E34 E35 E36 EA EB EC ED EE EF PE SMH";

fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}

fn reply(value: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

fn bounded(value: &str, max: usize) -> Result<()> {
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        Err(Error::Invalid("invalid Claim.MD eligibility field"))
    } else {
        Ok(())
    }
}

fn identifier(value: &str, max: usize) -> Result<()> {
    bounded(value, max)?;
    if value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b' '))
    {
        Ok(())
    } else {
        Err(Error::Invalid("invalid Claim.MD identifier"))
    }
}

fn valid_npi(value: &str) -> bool {
    if value.len() != 10
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || !matches!(value.as_bytes()[0], b'1' | b'2')
    {
        return false;
    }
    let sum: u32 = format!("80840{value}")
        .bytes()
        .rev()
        .enumerate()
        .map(|(index, byte)| {
            let digit = u32::from(byte - b'0');
            if index % 2 == 1 {
                let doubled = digit * 2;
                doubled / 10 + doubled % 10
            } else {
                digit
            }
        })
        .sum();
    sum.is_multiple_of(10)
}

async fn route(pool: &PgPool, tenant: Uuid) -> Result<Route> {
    crate::provider_settings::load_for_tenant(pool, tenant)
        .await?
        .routes
        .into_iter()
        .find(|route| route.adapter == Adapter::ClaimMd)
        .ok_or(Error::Conflict(
            "enable and verify a Claim.MD connection before using eligibility",
        ))
}

fn endpoint(route: &Route, service: &str) -> Result<String> {
    if route.loopback_test {
        let origin = url::Url::parse(&route.endpoint)
            .map_err(|_| Error::Invalid("invalid Claim.MD endpoint"))?
            .origin()
            .ascii_serialization();
        Ok(format!("{origin}/services/{service}/"))
    } else {
        Ok(format!("https://svc.claim.md/services/{service}/"))
    }
}

fn key(route: &Route) -> Result<&str> {
    route
        .credential_value
        .as_ref()
        .map(|secret| secret.expose())
        .ok_or(Error::Conflict("Claim.MD credential unavailable"))
}

fn rows(value: &Value, field: &str) -> Result<Vec<Value>> {
    match value.get(field) {
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(item @ Value::Object(_)) => Ok(vec![item.clone()]),
        _ => Err(Error::Invalid("Claim.MD response is incomplete")),
    }
}

pub(crate) async fn acquire_rate_limit(pool: &PgPool, route: &Route) -> Result<()> {
    acquire_rate_limit_key(pool, key(route)?).await
}

pub(crate) async fn acquire_rate_limit_key(pool: &PgPool, account_key: &str) -> Result<()> {
    let account_hash = crate::oauth::hash(account_key);
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM claimmd_api_rate_windows WHERE window_start<date_trunc('minute',clock_timestamp())-interval '1 day'")
        .execute(&mut *tx)
        .await?;
    let acquired: Option<i32> = sqlx::query_scalar(
        "INSERT INTO claimmd_api_rate_windows(account_hash,window_start,request_count)
         VALUES($1,date_trunc('minute',clock_timestamp()),1)
         ON CONFLICT(account_hash,window_start) DO UPDATE
           SET request_count=claimmd_api_rate_windows.request_count+1,updated_at=clock_timestamp()
           WHERE claimmd_api_rate_windows.request_count<100
         RETURNING request_count",
    )
    .bind(account_hash)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    if acquired.is_none() {
        return Err(Error::Invalid(
            "Claim.MD account request limit reached; retry after one minute",
        ));
    }
    Ok(())
}

async fn post(route: &Route, service: &str, mut fields: Vec<(String, String)>) -> Result<Value> {
    fields.push(("AccountKey".into(), key(route)?.into()));
    let response = crate::stedi::client()?
        .post(endpoint(route, service)?)
        .header("Accept", "application/json")
        .form(&fields)
        .send()
        .await
        .map_err(|_| Error::Invalid("Claim.MD request unavailable"))?;
    if response.status() != 200 {
        return Err(Error::Invalid("Claim.MD request failed"));
    }
    let raw = crate::stedi::bytes(response, MAX_RESPONSE).await?;
    let value: Value = serde_json::from_slice(&raw)
        .map_err(|_| Error::Invalid("Claim.MD returned unsupported JSON"))?;
    if value.get("error").is_some() {
        return Err(Error::Invalid("Claim.MD rejected the request"));
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PayerQuery {
    payerid: Option<String>,
    name: Option<String>,
}

fn validate_payer_query(query: &PayerQuery) -> Result<()> {
    if query.payerid.is_none() && query.name.is_none() {
        return Err(Error::Invalid("enter a payer ID or payer name"));
    }
    if let Some(value) = &query.payerid {
        identifier(value, 40)?;
    }
    if let Some(value) = &query.name {
        if value.chars().count() < 2 {
            return Err(Error::Invalid(
                "payer name search must contain at least two characters",
            ));
        }
        bounded(value, 120)?;
    }
    Ok(())
}

async fn payer_search(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Query(query): Query<PayerQuery>,
) -> Result<Response> {
    actor.staff()?;
    validate_payer_query(&query)?;
    let pool = db(&state)?;
    let route = route(pool, actor.tenant_id).await?;
    acquire_rate_limit(pool, &route).await?;
    let mut fields = Vec::new();
    if let Some(value) = &query.payerid {
        fields.push(("payerid".into(), value.clone()));
    }
    if let Some(value) = &query.name {
        fields.push(("payer_name".into(), value.clone()));
    }
    let response = post(&route, "payerlist", fields).await?;
    let payers = rows(&response, "payer")?;
    if payers.len() > 1000 {
        return Err(Error::Invalid(
            "Claim.MD payer response exceeds supported size",
        ));
    }
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO claimmd_payer_directory_snapshots(tenant_id,id,route_key,query,response,actor_id) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(actor.tenant_id).bind(id).bind(&route.key).bind(json!({"payerid":query.payerid,"name":query.name})).bind(&response).bind(actor.sub).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "claimmd.payer_directory_read", id).await?;
    tx.commit().await?;
    Ok(reply(
        json!({"snapshot_id":id,"items":payers,"source":"claim_md"}),
    ))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct EligibilityRequest {
    request_id: Uuid,
    service_date: NaiveDate,
    #[serde(default)]
    service_codes: Vec<String>,
    procedure_code: Option<String>,
    insured_given_name: String,
    insured_middle_name: Option<String>,
    insured_family_name: String,
    insured_birth_date: Option<NaiveDate>,
    insured_sex: Option<String>,
    patient_sex: Option<String>,
    provider_npi: String,
    provider_taxid: String,
    provider_taxid_type: String,
    provider_name: Option<String>,
    provider_taxonomy: Option<String>,
}

fn validate_request(request: &EligibilityRequest) -> Result<()> {
    bounded(&request.insured_given_name, 100)?;
    bounded(&request.insured_family_name, 100)?;
    identifier(&request.provider_npi, 10)?;
    identifier(&request.provider_taxid, 20)?;
    if !valid_npi(&request.provider_npi)
        || !["E", "S"].contains(&request.provider_taxid_type.as_str())
        || request
            .insured_sex
            .as_ref()
            .is_some_and(|v| !["M", "F"].contains(&v.as_str()))
        || request
            .patient_sex
            .as_ref()
            .is_some_and(|v| !["M", "F"].contains(&v.as_str()))
        || (request.procedure_code.is_some() && !request.service_codes.is_empty())
        || request.service_codes.len() > 20
    {
        return Err(Error::Invalid("invalid Claim.MD eligibility request"));
    }
    for code in &request.service_codes {
        if !BENEFIT_TYPES
            .split_whitespace()
            .any(|allowed| allowed == code)
        {
            return Err(Error::Invalid("unsupported Claim.MD benefit type code"));
        }
    }
    if let Some(code) = &request.procedure_code {
        if code.len() > 10 || !code.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
            return Err(Error::Invalid("invalid Claim.MD procedure code"));
        }
    }
    if let Some(value) = &request.insured_middle_name {
        bounded(value, 100)?;
    }
    if let Some(value) = &request.provider_name {
        bounded(value, 200)?;
    }
    if let Some(value) = &request.provider_taxonomy {
        identifier(value, 10)?;
    }
    Ok(())
}

#[derive(sqlx::FromRow, Serialize)]
struct Check {
    id: Uuid,
    patient_id: Uuid,
    coverage_id: Uuid,
    request_snapshot: Value,
    response_snapshot: Option<Value>,
    status: String,
    actor_id: Uuid,
    created_at: chrono::DateTime<chrono::Utc>,
    completed_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(sqlx::FromRow)]
struct ExistingCheck {
    id: Uuid,
    patient_id: Uuid,
    coverage_id: Uuid,
    request_snapshot: Value,
    response_snapshot: Option<Value>,
    status: String,
    actor_id: Uuid,
    created_at: chrono::DateTime<chrono::Utc>,
    completed_at: Option<chrono::DateTime<chrono::Utc>>,
    creation_hash: String,
}

impl ExistingCheck {
    fn into_check(self) -> Check {
        Check {
            id: self.id,
            patient_id: self.patient_id,
            coverage_id: self.coverage_id,
            request_snapshot: self.request_snapshot,
            response_snapshot: self.response_snapshot,
            status: self.status,
            actor_id: self.actor_id,
            created_at: self.created_at,
            completed_at: self.completed_at,
        }
    }
}

async fn existing(pool: &PgPool, actor: &Actor, request: Uuid) -> Result<Option<ExistingCheck>> {
    sqlx::query_as("SELECT id,patient_id,coverage_id,request_snapshot,response_snapshot,status,actor_id,created_at,completed_at,creation_hash FROM claimmd_eligibility_checks WHERE tenant_id=$1 AND request_id=$2")
        .bind(actor.tenant_id).bind(request).fetch_optional(pool).await.map_err(Into::into)
}

async fn mark(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
    status: &str,
    response: Option<&Value>,
) -> Result<()> {
    let result = sqlx::query("UPDATE claimmd_eligibility_checks SET status=$3,response_snapshot=$4,completed_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='pending'")
        .bind(actor.tenant_id).bind(id).bind(status).bind(response).execute(&mut **tx).await?;
    if result.rows_affected() != 1 {
        return Err(Error::Conflict("eligibility request is already finalized"));
    }
    sqlx::query("INSERT INTO claimmd_eligibility_events(tenant_id,check_id,status,actor_id) VALUES($1,$2,$3,$4)")
        .bind(actor.tenant_id).bind(id).bind(status).bind(actor.sub).execute(&mut **tx).await?;
    crate::postgres::audit(tx, actor, "claimmd.eligibility_result", id).await
}

async fn create_eligibility(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path((patient_id, coverage_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<EligibilityRequest>,
) -> Result<Response> {
    actor.scheduling()?;
    validate_request(&request)?;
    let pool = db(&state)?;
    let digest = crate::oauth::hash(
        &serde_json::to_string(&(patient_id, coverage_id, &request))
            .map_err(|_| Error::Invalid("invalid eligibility request"))?,
    );
    if let Some(existing) = existing(pool, &actor, request.request_id).await? {
        if existing.creation_hash != digest {
            return Err(Error::Conflict("eligibility request ID was already used"));
        }
        let check = existing.into_check();
        return if check.status == "completed" {
            Ok(reply(json!(check)))
        } else {
            Err(Error::Conflict("eligibility request is not complete"))
        };
    }
    let route = route(pool, actor.tenant_id).await?;
    acquire_rate_limit(pool, &route).await?;
    let row: Option<(String, String, NaiveDate, Value, Value)> = sqlx::query_as(
        "SELECT p.given_name,p.family_name,p.birth_date,c.content,py.content
           FROM patients p
           JOIN insurance_coverages c ON c.tenant_id=p.tenant_id AND c.patient_id=p.id
           JOIN ehr_payers py ON py.tenant_id=c.tenant_id AND py.id=c.payer_id
          WHERE p.tenant_id=$1 AND p.id=$2 AND c.id=$3",
    )
    .bind(actor.tenant_id)
    .bind(patient_id)
    .bind(coverage_id)
    .fetch_optional(pool)
    .await?;
    let (patient_given, patient_family, patient_birth, coverage, payer) =
        row.ok_or(Error::NotFound)?;
    let relationship = coverage["relationship"].as_str().unwrap_or("");
    let pat_rel = if relationship == "self" { "18" } else { "G8" };
    let payerid = payer["payer_code"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or(Error::Invalid("local payer requires a Claim.MD payer ID"))?
        .to_owned();
    let member = coverage["member_id"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or(Error::Invalid("coverage member ID is required"))?
        .to_owned();
    let snapshot = json!({"request":&request,"patient":{"id":patient_id,"given_name":patient_given,"family_name":patient_family,"birth_date":patient_birth},"coverage_id":coverage_id,"payerid":payerid,"member_id":member,"pat_rel":pat_rel});
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO claimmd_eligibility_checks(tenant_id,id,patient_id,coverage_id,request_id,creation_hash,route_key,request_snapshot,status,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)")
        .bind(actor.tenant_id).bind(id).bind(patient_id).bind(coverage_id).bind(request.request_id).bind(&digest).bind(&route.key).bind(&snapshot).bind(actor.sub).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO claimmd_eligibility_events(tenant_id,check_id,status,actor_id) VALUES($1,$2,'pending',$3)")
        .bind(actor.tenant_id).bind(id).bind(actor.sub).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &actor, "claimmd.eligibility_requested", id).await?;
    tx.commit().await?;

    let date = |value: NaiveDate| value.format("%Y%m%d").to_string();
    let mut fields = vec![
        ("ins_name_l".into(), request.insured_family_name.clone()),
        ("ins_name_f".into(), request.insured_given_name.clone()),
        ("payerid".into(), payerid),
        ("pat_rel".into(), pat_rel.into()),
        ("fdos".into(), date(request.service_date)),
        ("prov_npi".into(), request.provider_npi.clone()),
        ("prov_taxid".into(), request.provider_taxid.clone()),
        (
            "prov_taxid_type".into(),
            request.provider_taxid_type.clone(),
        ),
        ("ins_number".into(), member),
    ];
    if !request.service_codes.is_empty() {
        fields.push(("service_code".into(), request.service_codes.join(",")));
    }
    if let Some(value) = &request.procedure_code {
        fields.push(("proc_code".into(), value.clone()));
    }
    if let Some(value) = &request.insured_middle_name {
        fields.push(("ins_name_m".into(), value.clone()));
    }
    if let Some(value) = request.insured_birth_date {
        fields.push(("ins_dob".into(), date(value)));
    }
    if let Some(value) = &request.insured_sex {
        fields.push(("ins_sex".into(), value.clone()));
    }
    if let Some(value) = &request.provider_name {
        fields.push(("prov_name_l".into(), value.clone()));
    }
    if let Some(value) = &request.provider_taxonomy {
        fields.push(("prov_taxonomy".into(), value.clone()));
    }
    if pat_rel == "G8" {
        fields.push(("pat_name_f".into(), patient_given));
        fields.push(("pat_name_l".into(), patient_family));
        fields.push(("pat_dob".into(), date(patient_birth)));
        if let Some(value) = &request.patient_sex {
            fields.push(("pat_sex".into(), value.clone()));
        }
    }
    let result = post(&route, "eligdata", fields).await.and_then(|response| {
        let rows = rows(&response, "elig")?;
        if rows.is_empty() || rows.len() > 10 {
            return Err(Error::Invalid(
                "Claim.MD eligibility response count is invalid",
            ));
        }
        let mut normalized = response;
        normalized["elig"] = Value::Array(rows);
        Ok(normalized)
    });
    match result {
        Ok(response) => {
            let mut tx = pool.begin().await?;
            mark(&mut tx, &actor, id, "completed", Some(&response)).await?;
            tx.commit().await?;
            let check: Check = sqlx::query_as("SELECT id,patient_id,coverage_id,request_snapshot,response_snapshot,status,actor_id,created_at,completed_at FROM claimmd_eligibility_checks WHERE tenant_id=$1 AND id=$2")
                .bind(actor.tenant_id).bind(id).fetch_one(pool).await?;
            Ok(reply(json!(check)))
        }
        Err(error) => {
            let mut tx = pool.begin().await?;
            mark(&mut tx, &actor, id, "failed", None).await?;
            tx.commit().await?;
            Err(error)
        }
    }
}

async fn list_eligibility(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path((patient_id, coverage_id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    let rows: Vec<Check> = sqlx::query_as("SELECT id,patient_id,coverage_id,request_snapshot,response_snapshot,status,actor_id,created_at,completed_at FROM claimmd_eligibility_checks WHERE tenant_id=$1 AND patient_id=$2 AND coverage_id=$3 ORDER BY created_at DESC,id DESC LIMIT 100")
        .bind(actor.tenant_id).bind(patient_id).bind(coverage_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(
        &mut tx,
        &actor,
        "claimmd.eligibility_history_read",
        coverage_id,
    )
    .await?;
    tx.commit().await?;
    Ok(reply(json!({"items":rows})))
}

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/billing/claimmd/payers", get(payer_search))
        .route(
            "/api/v1/patients/{patient}/coverages/{coverage}/claimmd-eligibility",
            get(list_eligibility).post(create_eligibility),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> EligibilityRequest {
        EligibilityRequest {
            request_id: Uuid::new_v4(),
            service_date: NaiveDate::from_ymd_opt(2026, 11, 5).unwrap(),
            service_codes: vec!["30".into()],
            procedure_code: None,
            insured_given_name: "Synthetic".into(),
            insured_middle_name: None,
            insured_family_name: "Patient".into(),
            insured_birth_date: Some(NaiveDate::from_ymd_opt(1980, 1, 1).unwrap()),
            insured_sex: Some("F".into()),
            patient_sex: Some("F".into()),
            provider_npi: "1234567893".into(),
            provider_taxid: "000000001".into(),
            provider_taxid_type: "E".into(),
            provider_name: Some("Synthetic Clinic".into()),
            provider_taxonomy: Some("207Q00000X".into()),
        }
    }

    #[test]
    fn validates_official_structured_eligibility_shape() {
        assert!(validate_request(&request()).is_ok());
        let mut invalid = request();
        invalid.procedure_code = Some("99213".into());
        assert!(validate_request(&invalid).is_err());
        let mut unsupported = request();
        unsupported.service_codes = vec!["ZZZ".into()];
        assert!(validate_request(&unsupported).is_err());
        let mut npi = request();
        npi.provider_npi = "1234567890".into();
        assert!(validate_request(&npi).is_err());
    }

    #[test]
    fn payer_search_requires_a_bounded_filter() {
        assert!(validate_payer_query(&PayerQuery {
            payerid: None,
            name: None
        })
        .is_err());
        assert!(validate_payer_query(&PayerQuery {
            payerid: Some("60054".into()),
            name: None
        })
        .is_ok());
    }

    #[test]
    fn normalizes_single_and_multiple_official_response_rows() {
        assert_eq!(
            rows(&json!({"payer":{"payerid":"60054"}}), "payer")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            rows(&json!({"elig":[{"eligid":"one"},{"eligid":"two"}]}), "elig")
                .unwrap()
                .len(),
            2
        );
        assert!(rows(&json!({"result":"missing"}), "elig").is_err());
    }
}
