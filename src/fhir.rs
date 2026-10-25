// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Initial read-only FHIR R4 Patient boundary. This does not claim US Core,
//! SMART App Launch, Bulk Data, or ONC conformance.
use crate::{auth::Actor, error::Error, model::Patient, State};
use axum::{
    extract::{Path, RawQuery, State as ExtractState},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

pub fn router() -> Router<State> {
    Router::new()
        .route("/fhir/metadata", get(metadata))
        .route("/fhir/Patient", get(search))
        .route("/fhir/Patient/{id}", get(read))
}
pub struct Fhir(pub Value);
impl IntoResponse for Fhir {
    fn into_response(self) -> Response {
        (
            [(header::CONTENT_TYPE, "application/fhir+json")],
            Json(self.0),
        )
            .into_response()
    }
}
pub struct Failure(pub Error);
impl From<Error> for Failure {
    fn from(e: Error) -> Self {
        Self(e)
    }
}
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        let (status, code, message) = match self.0 {
            Error::NotFound => (StatusCode::NOT_FOUND, "not-found", "Patient not found"),
            Error::Unauthorized => (StatusCode::UNAUTHORIZED, "login", "Authentication required"),
            Error::Forbidden => (
                StatusCode::FORBIDDEN,
                "forbidden",
                "Clinical read access required",
            ),
            Error::Invalid(m) => (StatusCode::BAD_REQUEST, "invalid", m),
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "exception",
                "Clinical service unavailable",
            ),
        };
        (status,Fhir(json!({"resourceType":"OperationOutcome","issue":[{"severity":"error","code":code,"details":{"text":message}}]}))).into_response()
    }
}
fn origin(s: &State) -> std::result::Result<&str, Failure> {
    Ok(s.browser.as_ref().ok_or(Error::NotFound)?.origin())
}
fn resource(p: Patient, base: &str) -> Value {
    json!({"resourceType":"Patient","id":p.id,"identifier":[{"use":"usual","type":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v2-0203","code":"MR"}]},"system":format!("{base}/identifier/mrn"),"value":p.mrn}],"name":[{"use":"official","family":p.family_name,"given":[p.given_name]}],"birthDate":p.birth_date})
}
async fn metadata(ExtractState(s): ExtractState<State>) -> std::result::Result<Fhir, Failure> {
    let base = origin(&s)?;
    Ok(Fhir(
        json!({"resourceType":"CapabilityStatement","status":"draft","date":"2026-10-23","kind":"instance","software":{"name":"SunCharts EHR","version":env!("CARGO_PKG_VERSION")},"implementation":{"description":"Development preview: read-only Patient API","url":format!("{base}/fhir")},"fhirVersion":"4.0.1","format":["json"],"rest":[{"mode":"server","security":{"service":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/restful-security-service","code":"OAuth"}]}],"description":"OAuth2 clinical.read or standalone clinician session. SMART App Launch is not implemented."},"resource":[{"type":"Patient","versioning":"no-version","interaction":[{"code":"read"},{"code":"search-type"}],"searchParam":[{"name":"_id","type":"token"},{"name":"name","type":"string","documentation":"Case-insensitive prefix of given or family name"},{"name":"identifier","type":"token","documentation":"MRN, with optional installation MRN system"},{"name":"birthdate","type":"date","documentation":"Exact ISO date only"}]}]}]}),
    ))
}
async fn read(
    actor: std::result::Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<String>,
) -> std::result::Result<Fhir, Failure> {
    let a = actor?;
    a.staff()?;
    let id = id.parse::<Uuid>().map_err(|_| Failure(Error::NotFound))?;
    let p = s.backend.patient(&a, id).await?;
    Ok(Fhir(resource(p, origin(&s)?)))
}
async fn search(
    actor: std::result::Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    RawQuery(raw): RawQuery,
) -> std::result::Result<Fhir, Failure> {
    let a = actor?;
    a.staff()?;
    let mut query = BTreeMap::new();
    for (key, value) in url::form_urlencoded::parse(raw.as_deref().unwrap_or("").as_bytes()) {
        if !["_id", "name", "identifier", "birthdate", "_count", "_after"].contains(&key.as_ref())
            || query.insert(key.to_string(), value.to_string()).is_some()
        {
            return Err(Failure(Error::Invalid(
                "unsupported or repeated search parameter",
            )));
        }
    }
    let uuid = |key: &str| -> std::result::Result<Option<Uuid>, Failure> {
        query
            .get(key)
            .map(|v| {
                v.parse::<Uuid>()
                    .map_err(|_| Failure(Error::Invalid("invalid patient identifier or cursor")))
            })
            .transpose()
    };
    let id = uuid("_id")?;
    let after = uuid("_after")?;
    let count = query
        .get("_count")
        .map(|v| {
            v.parse::<i64>()
                .map_err(|_| Failure(Error::Invalid("invalid count")))
        })
        .transpose()?
        .unwrap_or(50);
    if !(1..=100).contains(&count) {
        return Err(Failure(Error::Invalid("count must be between 1 and 100")));
    }
    let birth = query
        .get("birthdate")
        .map(|v| {
            v.parse::<chrono::NaiveDate>().map_err(|_| {
                Failure(Error::Invalid(
                    "birthdate currently requires an exact ISO date",
                ))
            })
        })
        .transpose()?;
    let base = origin(&s)?;
    let mut impossible = false;
    let mrn = query.get("identifier").map(|v| {
        if let Some((system, value)) = v.split_once('|') {
            if !system.is_empty() && system != format!("{base}/identifier/mrn") {
                impossible = true;
            }
            value.to_string()
        } else {
            v.clone()
        }
    });
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let mut tx = db.begin().await.map_err(Error::from)?;
    let mut rows:Vec<Patient>=sqlx::query_as("SELECT id,mrn,given_name,family_name,birth_date FROM patients WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::uuid IS NULL OR id>$3) AND ($4::text IS NULL OR starts_with(lower(given_name),lower($4)) OR starts_with(lower(family_name),lower($4))) AND ($5::date IS NULL OR birth_date=$5) AND ($6::text IS NULL OR mrn=$6) AND NOT $7 ORDER BY id LIMIT $8")
        .bind(a.tenant_id).bind(id).bind(after).bind(query.get("name")).bind(birth).bind(mrn).bind(impossible).bind(count+1).fetch_all(&mut *tx).await.map_err(Error::from)?;
    let more = rows.len() > count as usize;
    if more {
        rows.pop();
    }
    let mut links = vec![
        json!({"relation":"self","url":format!("{base}/fhir/Patient{}",raw.as_ref().map(|v|format!("?{v}")).unwrap_or_default())}),
    ];
    if more {
        if let Some(last) = rows.last() {
            let mut next = url::Url::parse(&format!("{base}/fhir/Patient"))
                .map_err(|_| Error::Invalid("invalid installation URL"))?;
            for (k, v) in &query {
                if k != "_after" {
                    next.query_pairs_mut().append_pair(k, v);
                }
            }
            next.query_pairs_mut()
                .append_pair("_after", &last.id.to_string());
            links.push(json!({"relation":"next","url":next.as_str()}));
        }
    }
    crate::postgres::audit(&mut tx, &a, "patient.fhir_search", a.tenant_id).await?;
    tx.commit().await.map_err(Error::from)?;
    Ok(Fhir(
        json!({"resourceType":"Bundle","type":"searchset","link":links,"entry":rows.into_iter().map(|p|json!({"fullUrl":format!("{base}/fhir/Patient/{}",p.id),"resource":resource(p,base),"search":{"mode":"match"}})).collect::<Vec<_>>()}),
    ))
}
