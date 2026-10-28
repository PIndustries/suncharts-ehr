// SPDX-License-Identifier: AGPL-3.0-only
//! Bounded vaccine-event projection and writes through the native record service.
use super::{origin, search_bundle, Failure, Fhir};
use crate::{
    auth::Actor,
    error::Error,
    immunizations::{self, Content},
    State,
};
use axum::{
    extract::{rejection::JsonRejection, Path, RawQuery, State as ExtractState},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;
pub(super) fn routes() -> Router<State> {
    Router::new()
        .route("/fhir/Immunization", get(search).post(create))
        .route("/fhir/Immunization/{id}", get(read).put(update))
}
pub(super) fn capability() -> Value {
    json!({"type":"Immunization","versioning":"versioned-update","updateCreate":false,"interaction":[{"code":"read"},{"code":"search-type"},{"code":"create"},{"code":"update"}],"documentation":"Native recorded vaccine events only. Owner/clinician/nurse clinical.write. Strict bounded writes require explicit native record-type extension, source and occurrence. PUT requires If-Match and X-Change-Reason. Entered-in-error uses native reviewed workflow. No vaccine catalog validation, registry exchange or forecasting.","searchParam":[{"name":"_id","type":"token"},{"name":"patient","type":"reference"},{"name":"status","type":"token"},{"name":"date","type":"date","documentation":"Exact YYYY-MM-DD only; historical occurrence strings do not match a date."}]})
}
fn ref_value(kind: &str, id: &Value) -> Value {
    json!({"reference":format!("{kind}/{}",id.as_str().unwrap_or_default())})
}
fn decimal(value: &str) -> Value {
    let (i, f) = value
        .split_once('.')
        .map_or((value, None), |(i, f)| (i, Some(f)));
    let i = i.trim_start_matches('0');
    let i = if i.is_empty() { "0" } else { i };
    let n = f.map_or_else(|| i.to_string(), |f| format!("{i}.{f}"));
    json!(n
        .parse::<serde_json::Number>()
        .expect("native validated decimal"))
}
fn resource(r: &Value, base: &str) -> Value {
    let c = &r["content"];
    let mut v = json!({"resourceType":"Immunization","id":r["id"],"meta":{"versionId":r["version"].as_i64().unwrap().to_string(),"lastUpdated":r["updated_at"]},"status":c["status"].as_str().unwrap().replace('_',"-"),"vaccineCode":{"text":c["vaccine_name"]},"patient":ref_value("Patient",&r["patient_id"]),"recorded":r["created_at"],"primarySource":c["primary_source"],"extension":[{"url":format!("{base}/StructureDefinition/immunization-record-type"),"valueCode":c["record_type"]}]});
    if c["vaccine_code"].is_object() {
        let mut code = c["vaccine_code"].clone();
        if code["display"] == "" {
            code.as_object_mut().unwrap().remove("display");
        }
        v["vaccineCode"]["coding"] = json!([code]);
    }
    if !c["occurred_at"].is_null() {
        v["occurrenceDateTime"] = c["occurred_at"].clone();
    } else if !c["occurred_on"].is_null() {
        v["occurrenceDateTime"] = c["occurred_on"].clone();
    } else {
        v["occurrenceString"] = c["occurrence_text"].clone();
    }
    if c["primary_source"] == false {
        v["reportOrigin"] = json!({"text":c["report_origin"]});
    }
    if !c["visit_id"].is_null() {
        v["encounter"] = ref_value("Encounter", &c["visit_id"]);
    }
    if let Some(id) = c["performer_id"].as_str() {
        v["performer"] = json!([{"actor":{"identifier":{"system":format!("{base}/identifier/staff"),"value":id},"display":r["performer_snapshot"]["display"]}}]);
    }
    for (native, fhir) in [
        ("manufacturer", "manufacturer"),
        ("route", "route"),
        ("site", "site"),
        ("not_done_reason", "statusReason"),
    ] {
        if let Some(text) = c[native].as_str().filter(|v| !v.is_empty()) {
            v[fhir] = if native == "manufacturer" {
                json!({"display":text})
            } else {
                json!({"text":text})
            };
        }
    }
    for (native, fhir) in [
        ("lot_number", "lotNumber"),
        ("expiration_date", "expirationDate"),
    ] {
        if !c[native].is_null() && c[native] != "" {
            v[fhir] = c[native].clone();
        }
    }
    if let Some(d) = c["dose"].as_object() {
        v["doseQuantity"] = json!({"value":decimal(d["value"].as_str().unwrap()),"unit":d["unit"]});
    }
    if let Some(note) = c["notes"].as_str().filter(|v| !v.is_empty()) {
        v["note"] = json!([{"text":note}]);
    }
    v
}
fn response(r: &Value, base: &str, status: StatusCode) -> Response {
    let mut out = (status, Fhir(resource(r, base))).into_response();
    out.headers_mut().insert(
        header::ETAG,
        format!("W/\"{}\"", r["version"]).parse().unwrap(),
    );
    out.headers_mut().insert(
        header::LOCATION,
        format!("{base}/fhir/Immunization/{}", r["id"].as_str().unwrap())
            .parse()
            .unwrap(),
    );
    out
}
async fn read(
    a: Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    Path(raw): Path<String>,
) -> Result<Response, Failure> {
    let a = a?;
    a.staff()?;
    let id = raw.parse().map_err(|_| Error::NotFound)?;
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let mut tx = db.begin().await.map_err(Error::from)?;
    let r = immunizations::row(&mut tx, &a, None, id).await?;
    crate::postgres::audit(&mut tx, &a, "patient.fhir_immunization.read", id).await?;
    tx.commit().await.map_err(Error::from)?;
    Ok(response(&r, origin(&s)?, StatusCode::OK))
}
async fn search(
    a: Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    RawQuery(raw): RawQuery,
) -> Result<Fhir, Failure> {
    let a = a?;
    a.staff()?;
    let mut params = BTreeMap::new();
    for (k, v) in url::form_urlencoded::parse(raw.as_deref().unwrap_or("").as_bytes()) {
        if !["_id", "patient", "status", "date", "_after", "_count"].contains(&k.as_ref())
            || params.insert(k.into_owned(), v.into_owned()).is_some()
        {
            return Err(
                Error::Invalid("unsupported or repeated Immunization search parameter").into(),
            );
        }
    }
    let parse_id = |key: &str| -> Result<Option<Uuid>, Failure> {
        params
            .get(key)
            .map(|v| {
                v.strip_prefix(if key == "patient" { "Patient/" } else { "" })
                    .unwrap_or(v)
                    .parse()
                    .map_err(|_| Error::Invalid("invalid Immunization UUID filter").into())
            })
            .transpose()
    };
    let id = parse_id("_id")?;
    let patient = parse_id("patient")?;
    let after = parse_id("_after")?;
    let count = params
        .get("_count")
        .map(|v| v.parse::<i64>())
        .transpose()
        .map_err(|_| Error::Invalid("invalid count"))?
        .unwrap_or(50);
    if !(1..=100).contains(&count) {
        return Err(Error::Invalid("count must be 1 to 100").into());
    }
    let date = params
        .get("date")
        .map(|v| v.parse::<chrono::NaiveDate>())
        .transpose()
        .map_err(|_| Error::Invalid("date requires exact YYYY-MM-DD"))?;
    if params
        .get("status")
        .is_some_and(|v| !["completed", "not-done", "entered-in-error"].contains(&v.as_str()))
    {
        return Err(Error::Invalid("status requires a FHIR Immunization status code").into());
    }
    let status = params.get("status").map(|v| v.replace('-', "_"));
    if status
        .as_ref()
        .is_some_and(|v| !["completed", "not_done", "entered_in_error"].contains(&v.as_str()))
    {
        return Err(Error::Invalid("invalid Immunization status").into());
    }
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let mut tx = db.begin().await.map_err(Error::from)?;
    let mut rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(i)-'tenant_id' FROM immunizations i WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::uuid IS NULL OR patient_id=$3) AND ($4::uuid IS NULL OR id>$4) AND ($5::text IS NULL OR content->>'status'=$5) AND ($6::date IS NULL OR coalesce((content->>'occurred_on')::date,((content->>'occurred_at')::timestamptz AT TIME ZONE 'UTC')::date)=$6) ORDER BY id LIMIT $7").bind(a.tenant_id).bind(id).bind(patient).bind(after).bind(status).bind(date).bind(count+1).fetch_all(&mut *tx).await.map_err(Error::from)?;
    crate::postgres::audit(
        &mut tx,
        &a,
        "patient.fhir_immunization.search",
        patient.unwrap_or(a.tenant_id),
    )
    .await?;
    tx.commit().await.map_err(Error::from)?;
    let more = rows.len() > count as usize;
    rows.truncate(count as usize);
    let base = origin(&s)?;
    let url = |p: &BTreeMap<String, String>| {
        let mut u = url::Url::parse(&format!("{base}/fhir/Immunization")).unwrap();
        for (k, v) in p {
            u.query_pairs_mut().append_pair(k, v);
        }
        u.to_string()
    };
    let mut links = vec![json!({"relation":"self","url":url(&params)})];
    if more {
        params.insert(
            "_after".into(),
            rows.last().unwrap()["id"].as_str().unwrap().into(),
        );
        links.push(json!({"relation":"next","url":url(&params)}));
    }
    Ok(search_bundle(links,rows.iter().map(|r|json!({"fullUrl":format!("{base}/fhir/Immunization/{}",r["id"].as_str().unwrap()),"resource":resource(r,base),"search":{"mode":"match"}})).collect()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Input {
    resource_type: String,
    id: Option<Uuid>,
    meta: Option<Meta>,
    status: String,
    vaccine_code: Code,
    patient: Reference,
    encounter: Option<Reference>,
    occurrence_date_time: Option<String>,
    occurrence_string: Option<String>,
    primary_source: bool,
    report_origin: Option<Text>,
    extension: Vec<Extension>,
    performer: Option<Vec<Performer>>,
    manufacturer: Option<Display>,
    lot_number: Option<String>,
    expiration_date: Option<chrono::NaiveDate>,
    route: Option<Text>,
    site: Option<Text>,
    dose_quantity: Option<Quantity>,
    status_reason: Option<Text>,
    note: Option<Vec<Text>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Meta {
    version_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reference {
    reference: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Code {
    text: String,
    #[serde(default)]
    coding: Vec<crate::clinical::Coding>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Text {
    text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Display {
    display: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Extension {
    url: String,
    value_code: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Performer {
    actor: Identified,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identified {
    identifier: Identifier,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identifier {
    system: String,
    value: Uuid,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Quantity {
    value: serde_json::Number,
    unit: String,
}
fn input(body: Result<Json<Value>, JsonRejection>) -> Result<Input, Failure> {
    let Json(v) = body.map_err(|_| Error::Invalid("invalid FHIR JSON body"))?;
    serde_json::from_value(v).map_err(|_| {
        Error::Invalid("unsupported Immunization fields; send the bounded writable subset").into()
    })
}
impl Input {
    fn patient(&self) -> Result<Uuid, Error> {
        self.patient
            .reference
            .strip_prefix("Patient/")
            .ok_or(Error::Invalid("relative Patient reference required"))?
            .parse()
            .map_err(|_| Error::Invalid("invalid Patient reference"))
    }
    fn content(self, base: &str) -> Result<Content, Error> {
        if self.resource_type != "Immunization"
            || self.extension.len() != 1
            || self.extension[0].url
                != format!("{base}/StructureDefinition/immunization-record-type")
            || self.vaccine_code.coding.len() > 1
            || self.note.as_ref().is_some_and(|v| v.len() != 1)
            || self.performer.as_ref().is_some_and(|v| v.len() != 1)
        {
            return Err(Error::Invalid("one native record-type extension, vaccine coding, performer and note are supported"));
        }
        if !["completed", "not-done"].contains(&self.status.as_str()) {
            return Err(Error::Invalid("FHIR writes support completed/not-done records; mark errors using the native reviewed workflow"));
        }
        let occurred_at = self
            .occurrence_date_time
            .as_ref()
            .filter(|v| v.len() != 10)
            .map(|v| v.parse::<DateTimeUtc>())
            .transpose()
            .map_err(|_| {
                Error::Invalid("occurrenceDateTime requires exact date or timestamp with offset")
            })?;
        let occurred_on = self
            .occurrence_date_time
            .as_ref()
            .filter(|v| v.len() == 10)
            .map(|v| v.parse())
            .transpose()
            .map_err(|_| Error::Invalid("invalid occurrence date"))?;
        let performer_id = if let Some(mut v) = self.performer {
            let p = v.remove(0);
            if p.actor.identifier.system != format!("{base}/identifier/staff") {
                return Err(Error::Invalid(
                    "performer identifier must use this installation's staff system",
                ));
            }
            Some(p.actor.identifier.value)
        } else {
            None
        };
        let visit_id = self
            .encounter
            .map(|v| {
                v.reference
                    .strip_prefix("Encounter/")
                    .ok_or(Error::Invalid("relative Encounter reference required"))?
                    .parse()
                    .map_err(|_| Error::Invalid("invalid Encounter reference"))
            })
            .transpose()?;
        let c = Content {
            record_type: self.extension.into_iter().next().unwrap().value_code,
            status: self.status.replace('-', "_"),
            vaccine_name: self.vaccine_code.text,
            vaccine_code: self.vaccine_code.coding.into_iter().next(),
            occurred_at,
            occurred_on,
            occurrence_text: self.occurrence_string,
            primary_source: self.primary_source,
            report_origin: self.report_origin.map_or(String::new(), |v| v.text),
            visit_id,
            performer_id,
            manufacturer: self.manufacturer.map_or(String::new(), |v| v.display),
            lot_number: self.lot_number.unwrap_or_default(),
            expiration_date: self.expiration_date,
            route: self.route.map_or(String::new(), |v| v.text),
            site: self.site.map_or(String::new(), |v| v.text),
            dose: self.dose_quantity.map(|q| immunizations::Dose {
                value: q.value.to_string(),
                unit: q.unit,
            }),
            not_done_reason: self.status_reason.map_or(String::new(), |v| v.text),
            notes: self
                .note
                .and_then(|mut v| v.pop())
                .map_or(String::new(), |v| v.text),
        };
        c.validate()?;
        Ok(c)
    }
}
type DateTimeUtc = chrono::DateTime<chrono::Utc>;
async fn create(
    a: Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Result<Response, Failure> {
    let a = a?;
    immunizations::writer(&a)?;
    super::writes::reject_conditions(&h)?;
    if h.contains_key(header::IF_MATCH) {
        return Err(Error::Invalid("If-Match is not supported for creation").into());
    }
    let i = input(body)?;
    if i.id.is_some() || i.meta.is_some() {
        return Err(Error::Invalid("creation assigns ID and version").into());
    }
    let p = i.patient()?;
    let base = origin(&s)?.to_string();
    let c = i.content(&base)?;
    let out = immunizations::create_record(
        &s,
        &a,
        p,
        immunizations::Create {
            request_id: Uuid::new_v4(),
            content: c,
            reason: "FHIR vaccine event recorded".into(),
        },
    )
    .await?;
    Ok(response(&out, &base, StatusCode::CREATED))
}
async fn update(
    a: Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    Path(raw): Path<String>,
    h: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Result<Response, Failure> {
    let a = a?;
    immunizations::writer(&a)?;
    super::writes::reject_conditions(&h)?;
    let expected = super::writes::version(&h)?;
    let id: Uuid = raw.parse().map_err(|_| Error::NotFound)?;
    let i = input(body)?;
    if i.id != Some(id)
        || i.meta
            .as_ref()
            .and_then(|m| m.version_id.as_ref())
            .is_some_and(|v| v != &expected.to_string())
    {
        return Err(Error::Invalid("Immunization ID/version must match URL and If-Match").into());
    }
    let p = i.patient()?;
    let base = origin(&s)?.to_string();
    let content = i.content(&base)?;
    let reason = h
        .get("x-change-reason")
        .and_then(|v| v.to_str().ok())
        .ok_or(Error::Invalid("X-Change-Reason required"))?
        .into();
    let out = immunizations::update_record(
        &s,
        &a,
        p,
        id,
        expected,
        immunizations::Change {
            request_id: Uuid::new_v4(),
            content,
            reason,
        },
    )
    .await?;
    Ok(response(&out, &base, StatusCode::OK))
}
