// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Bounded FHIR R4 projections and registration identity writes. This does not claim US Core,
//! SMART App Launch, Bulk Data, or ONC conformance.
use crate::{
    auth::Actor,
    error::Error,
    patient_identity::{self, Identity},
    State,
};
use axum::{
    extract::{OriginalUri, Path, RawQuery, State as ExtractState},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

#[path = "fhir_documents.rs"]
mod documents;
#[path = "fhir_immunizations.rs"]
mod immunizations;
#[path = "fhir_orders.rs"]
mod orders;
#[path = "fhir_practice.rs"]
mod practice;
#[path = "fhir_service_writes.rs"]
mod service_writes;
#[path = "fhir_writes.rs"]
mod writes;

pub fn router() -> Router<State> {
    let mut router = Router::new()
        .route("/fhir/metadata", get(metadata))
        .route("/fhir/Patient", get(search).post(writes::create))
        .route("/fhir/Patient/{id}", get(read).put(writes::update));
    for kind in CLINICAL_RESOURCES
        .into_iter()
        .filter(|kind| *kind != "Observation")
    {
        let writable = matches!(
            kind,
            "Condition" | "AllergyIntolerance" | "MedicationStatement"
        );
        let collection = if writable {
            get(clinical_search).post(writes::clinical_create)
        } else {
            get(clinical_search)
        };
        let item = if writable {
            get(clinical_read).put(writes::clinical_update)
        } else {
            get(clinical_read)
        };
        router = router
            .route(&format!("/fhir/{kind}"), collection)
            .route(&format!("/fhir/{kind}/{{id}}"), item);
    }
    router
        .merge(practice::routes())
        .merge(orders::routes())
        .merge(documents::routes())
        .merge(immunizations::routes())
}
pub struct Fhir(pub Value);
fn search_bundle(links: Vec<Value>, entries: Vec<Value>) -> Fhir {
    let mut bundle = json!({"resourceType":"Bundle","type":"searchset","link":links});
    // FHIR JSON omits empty arrays; native API list contracts are unchanged.
    if !entries.is_empty() {
        bundle["entry"] = json!(entries);
    }
    Fhir(bundle)
}
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
            Error::NotFound => (StatusCode::NOT_FOUND, "not-found", "Resource not found"),
            Error::Unauthorized => (StatusCode::UNAUTHORIZED, "login", "Authentication required"),
            Error::Forbidden => (
                StatusCode::FORBIDDEN,
                "forbidden",
                "Required staff resource access is missing",
            ),
            Error::Invalid(m) => (StatusCode::BAD_REQUEST, "invalid", m),
            Error::VersionRequired => (
                StatusCode::PRECONDITION_REQUIRED,
                "required",
                "Current If-Match version required",
            ),
            Error::Conflict("patient identity changed; reload before saving") => (
                StatusCode::PRECONDITION_FAILED,
                "conflict",
                "Patient identity changed; reload before saving",
            ),
            Error::Conflict("immunization changed; reload before saving") => (
                StatusCode::PRECONDITION_FAILED,
                "conflict",
                "Immunization changed; reload before saving",
            ),
            Error::Conflict("clinical entry changed; reload before saving") => (
                StatusCode::PRECONDITION_FAILED,
                "conflict",
                "Clinical entry changed; reload before saving",
            ),
            Error::Conflict("order or report changed; reload before saving") => (
                StatusCode::PRECONDITION_FAILED,
                "conflict",
                "Order or report changed; reload before saving",
            ),
            Error::Conflict(m) => (StatusCode::CONFLICT, "conflict", m),
            Error::Database(ref e)
                if e.as_database_error()
                    .is_some_and(|d| d.code().as_deref() == Some("23505")) =>
            {
                (
                    StatusCode::CONFLICT,
                    "conflict",
                    "Resource identity already exists",
                )
            }
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
fn resource(
    id: Uuid,
    mrn: String,
    given_name: String,
    family_name: String,
    birth_date: chrono::NaiveDate,
    version: i64,
    base: &str,
) -> Value {
    json!({"resourceType":"Patient","id":id,"meta":{"versionId":version.to_string()},"identifier":[{"use":"usual","type":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v2-0203","code":"MR"}]},"system":format!("{base}/identifier/mrn"),"value":mrn}],"name":[{"use":"official","family":family_name,"given":[given_name]}],"birthDate":birth_date})
}
async fn metadata(ExtractState(s): ExtractState<State>) -> std::result::Result<Fhir, Failure> {
    let base = origin(&s)?;
    let mut resources = vec![
        json!({"type":"Patient","versioning":"versioned-update","updateCreate":false,"interaction":[{"code":"read"},{"code":"search-type"},{"code":"create"},{"code":"update"}],"documentation":"Only registration identity is writable. PUT requires If-Match and X-Change-Reason; unsupported fields fail instead of being discarded.","searchParam":[{"name":"_id","type":"token"},{"name":"name","type":"string","documentation":"Case-insensitive prefix of given or family name"},{"name":"identifier","type":"token","documentation":"MRN, with optional installation MRN system"},{"name":"birthdate","type":"date","documentation":"Exact ISO date only"}]}),
    ];
    for kind in CLINICAL_RESOURCES {
        let mut entry = json!({"type":kind,"versioning":"no-version","interaction":[{"code":"read"},{"code":"search-type"}],"searchParam":[{"name":"_id","type":"token"},{"name":"patient","type":"reference","documentation":"Patient UUID or relative Patient/UUID reference; exact match only"}]});
        if matches!(
            kind,
            "Condition" | "AllergyIntolerance" | "MedicationStatement"
        ) {
            entry["versioning"] = json!("versioned-update");
            entry["updateCreate"] = json!(false);
            entry["interaction"] =
                json!([{"code":"read"},{"code":"search-type"},{"code":"create"},{"code":"update"}]);
            entry["documentation"]=json!("Bounded native clinical-list writes. PUT requires If-Match and X-Change-Reason. Unsupported fields and conditional creation are rejected.");
        }
        resources.push(entry);
    }
    for kind in orders::RESOURCES {
        resources.push(orders::capability(kind));
    }
    for kind in practice::RESOURCES {
        resources.push(practice::capability(kind));
    }
    resources.push(immunizations::capability());
    for kind in ["DocumentReference", "Binary", "MedicationRequest"] {
        resources.push(documents::capability(kind));
    }
    Ok(Fhir(
        json!({"resourceType":"CapabilityStatement","status":"draft","date":"2026-10-28","kind":"instance","software":{"name":"SunCharts EHR","version":env!("CARGO_PKG_VERSION")},"implementation":{"description":"Development preview: native document/prescription projections and bounded identity, clinical-list and local draft-order writes","url":format!("{base}/fhir")},"fhirVersion":"4.0.1","format":["json"],"rest":[{"mode":"server","security":{"service":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/restful-security-service","code":"OAuth"}]}],"description":"Staff OAuth2 clinical.read for clinical projections, billing.read for Coverage, clinical.write for bounded owner/clinician writes (also nurse for Immunization); standalone staff sessions retain role checks. Patient-role credentials cannot use this boundary. SMART, US Core and Bulk Data conformance are not claimed."},"resource":resources}]}),
    ))
}
async fn read(
    actor: std::result::Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<String>,
) -> std::result::Result<Response, Failure> {
    let a = actor?;
    a.staff()?;
    let id = id.parse::<Uuid>().map_err(|_| Failure(Error::NotFound))?;
    let p = patient_identity::read_identity(&s, &a, id).await?;
    let version = p.version;
    let mut r = Fhir(resource(
        p.id,
        p.mrn,
        p.given_name,
        p.family_name,
        p.birth_date,
        p.version,
        origin(&s)?,
    ))
    .into_response();
    r.headers_mut()
        .insert(header::ETAG, format!("W/\"{version}\"").parse().unwrap());
    Ok(r)
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
    let mut rows:Vec<Identity>=sqlx::query_as("SELECT id,mrn,given_name,family_name,birth_date,identity_version AS version FROM patients WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::uuid IS NULL OR id>$3) AND ($4::text IS NULL OR starts_with(lower(given_name),lower($4)) OR starts_with(lower(family_name),lower($4))) AND ($5::date IS NULL OR birth_date=$5) AND ($6::text IS NULL OR mrn=$6) AND NOT $7 ORDER BY id LIMIT $8")
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
    Ok(search_bundle(links, rows.into_iter().map(|p|json!({"fullUrl":format!("{base}/fhir/Patient/{}",p.id),"resource":resource(p.id,p.mrn,p.given_name,p.family_name,p.birth_date,p.version,base),"search":{"mode":"match"}})).collect()))
}

const CLINICAL_RESOURCES: [&str; 5] = [
    "Encounter",
    "Condition",
    "AllergyIntolerance",
    "MedicationStatement",
    "Observation",
];

fn reference(kind: &str, id: &Value) -> Value {
    json!({"reference":format!("{kind}/{}",id.as_str().unwrap_or_default())})
}
fn concept(system: &str, code: &str) -> Value {
    json!({"coding":[{"system":system,"code":code}]})
}
fn optional(out: &mut Value, name: &str, value: &Value) {
    if !value.is_null() && value.as_str() != Some("") {
        out[name] = value.clone();
    }
}
fn clinical_resource(kind: &str, row: &Value) -> Value {
    let c = &row["content"];
    let mut out = json!({"resourceType":kind,"id":row["id"],"subject":reference("Patient",&row["patient_id"])});
    if kind == "Encounter" {
        out["status"] = json!(if row["status"] == "signed" {
            "finished"
        } else {
            "in-progress"
        });
        out["class"] =
            json!({"system":"http://terminology.hl7.org/CodeSystem/v3-ActCode","code":"AMB"});
        out["period"] = json!({"start":row["created_at"]});
        optional(&mut out["period"], "end", &row["signed_at"]);
        return out;
    }
    if kind == "Observation" {
        out["status"] = json!(if row["status"] == "signed" {
            "final"
        } else {
            "preliminary"
        });
        out["encounter"] = reference("Encounter", &row["id"]);
        out["category"] = json!([concept(
            "http://terminology.hl7.org/CodeSystem/observation-category",
            "vital-signs"
        )]);
        out["code"] = json!({"text":"Recorded vital signs"});
        let specs = [
            ("systolic_mm_hg", "8480-6", "mm[Hg]"),
            ("diastolic_mm_hg", "8462-4", "mm[Hg]"),
            ("heart_rate_bpm", "8867-4", "/min"),
            ("temperature_c", "8310-5", "Cel"),
            ("weight_kg", "29463-7", "kg"),
            ("height_cm", "8302-2", "cm"),
            ("oxygen_saturation_pct", "2708-6", "%"),
        ];
        out["component"] = json!(specs.iter().filter_map(|(key,code,unit)|row["vitals"].get(key).filter(|v|v.is_number()).map(|v|json!({"code":concept("http://loinc.org",code),"valueQuantity":{"value":v,"unit":unit,"system":"http://unitsofmeasure.org","code":unit}}))).collect::<Vec<_>>());
        return out;
    }
    out["meta"] = json!({"versionId":row["version"].as_i64().unwrap_or(1).to_string(),"lastUpdated":row["updated_at"]});
    let mut code = json!({"text":c["title"]});
    let codes: Vec<Value> = c["codes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|source| {
            let mut coding = json!({"system":source["system"],"code":source["code"]});
            optional(&mut coding, "display", &source["display"]);
            coding
        })
        .collect();
    if !codes.is_empty() {
        code["coding"] = json!(codes);
    }
    let status = c["status"].as_str().unwrap_or("").replace('_', "-");
    let verification = c["verification"].as_str().unwrap_or("").replace('_', "-");
    if let Some(note) = c["notes"].as_str().filter(|v| !v.is_empty()) {
        out["note"] = json!([{"text":note}]);
    }
    match kind {
        "Condition" => {
            out["code"] = code;
            out["verificationStatus"] = concept(
                "http://terminology.hl7.org/CodeSystem/condition-ver-status",
                &verification,
            );
            if status != "entered-in-error" {
                out["clinicalStatus"] = concept(
                    "http://terminology.hl7.org/CodeSystem/condition-clinical",
                    &status,
                );
            }
            optional(&mut out, "onsetDateTime", &c["onset_date"]);
            // R4 con-4 requires an abated Condition to carry an inactive,
            // resolved or remission clinicalStatus. Entered-in-error records
            // omit clinicalStatus under con-5, so do not assert abatement.
            if status != "entered-in-error" {
                optional(&mut out, "abatementDateTime", &c["end_date"]);
            }
        }
        "AllergyIntolerance" => {
            out.as_object_mut().unwrap().remove("subject");
            out["patient"] = reference("Patient", &row["patient_id"]);
            out["code"] = code;
            out["verificationStatus"] = concept(
                "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
                &verification,
            );
            if status != "entered-in-error" {
                out["clinicalStatus"] = concept(
                    "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
                    &status,
                );
            }
            let d = &c["detail"];
            if let Some(cat) = d["category"]
                .as_str()
                .filter(|v| ["food", "medication", "environment", "biologic"].contains(v))
            {
                out["category"] = json!([cat]);
            }
            out["criticality"] = json!(if d["criticality"] == "unknown" {
                "unable-to-assess"
            } else {
                d["criticality"].as_str().unwrap_or("unable-to-assess")
            });
            if let Some(reaction) = d["reaction"].as_str().filter(|v| !v.is_empty()) {
                let mut r = json!({"manifestation":[{"text":reaction}]});
                if let Some(severity) = d["severity"]
                    .as_str()
                    .filter(|v| ["mild", "moderate", "severe"].contains(v))
                {
                    r["severity"] = json!(severity);
                }
                out["reaction"] = json!([r]);
            }
            optional(&mut out, "onsetDateTime", &c["onset_date"]);
        }
        "MedicationStatement" => {
            // A refuted native assertion must not become an unqualified claim
            // of active medication use. R4 has no verificationStatus field for
            // MedicationStatement; unknown avoids inventing non-use or error.
            out["status"] = json!(if verification == "refuted" {
                "unknown"
            } else {
                &status
            });
            if verification == "refuted" {
                out["statusReason"] = json!([{"text":format!("Native medication assertion is refuted; recorded native use status: {status}. Current medication use is not asserted by this projection.")}]);
            }
            let annotation = json!({"text":format!("Native medication statement verification: {verification}.")});
            if let Some(notes) = out["note"].as_array_mut() {
                notes.push(annotation);
            } else {
                out["note"] = json!([annotation]);
            }
            out["medicationCodeableConcept"] = code;
            if !c["onset_date"].is_null() || !c["end_date"].is_null() {
                let mut period = json!({});
                optional(&mut period, "start", &c["onset_date"]);
                optional(&mut period, "end", &c["end_date"]);
                out["effectivePeriod"] = period;
            }
            let d = &c["detail"];
            let text = ["dose", "route", "frequency"]
                .iter()
                .filter_map(|k| d[k].as_str().filter(|v| !v.is_empty()))
                .collect::<Vec<_>>()
                .join("; ");
            if !text.is_empty() {
                out["dosage"] = json!([{"text":text}]);
            }
            if let Some(v) = d["indication"].as_str().filter(|v| !v.is_empty()) {
                out["reasonCode"] = json!([{"text":v}]);
            }
        }
        _ => {}
    }
    out
}

#[derive(Default)]
struct ClinicalQuery {
    parameters: BTreeMap<String, String>,
    id: Option<Uuid>,
    patient: Option<Uuid>,
    after: Option<Uuid>,
    count: i64,
}
impl ClinicalQuery {
    fn parse(raw: Option<&str>) -> Result<Self, Failure> {
        let mut q = Self {
            count: 50,
            ..Self::default()
        };
        for (k, v) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
            if !["_id", "patient", "_after", "_count"].contains(&k.as_ref())
                || q.parameters
                    .insert(k.into_owned(), v.into_owned())
                    .is_some()
            {
                return Err(Error::Invalid("unsupported or repeated search parameter").into());
            }
        }
        for (k, dest) in [
            ("_id", &mut q.id),
            ("patient", &mut q.patient),
            ("_after", &mut q.after),
        ] {
            if let Some(v) = q.parameters.get(k) {
                let value = if k == "patient" {
                    v.strip_prefix("Patient/").unwrap_or(v)
                } else {
                    v
                };
                *dest =
                    Some(value.parse().map_err(|_| {
                        Error::Invalid("expected UUID or relative Patient reference")
                    })?);
            }
        }
        if let Some(v) = q.parameters.get("_count") {
            q.count = v.parse().map_err(|_| Error::Invalid("invalid count"))?;
        }
        if !(1..=100).contains(&q.count) {
            return Err(Error::Invalid("count must be between 1 and 100").into());
        }
        Ok(q)
    }
}
async fn clinical_rows(
    s: &State,
    a: &Actor,
    kind: &str,
    q: &ClinicalQuery,
    read: bool,
) -> Result<Vec<Value>, Failure> {
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let mut tx = db.begin().await.map_err(Error::from)?;
    let (table, filter) = match kind {
        "Encounter" => ("visits", "TRUE"),
        "Observation" => ("visits", "vitals IS NOT NULL"),
        "Condition" => ("clinical_entries", "kind='problem'"),
        "AllergyIntolerance" => ("clinical_entries", "kind='allergy'"),
        "MedicationStatement" => ("clinical_entries", "kind='medication'"),
        _ => return Err(Error::NotFound.into()),
    };
    // Both SQL fragments are selected exclusively from the fixed match above.
    let sql=format!("SELECT to_jsonb(r)-'tenant_id' FROM {table} r WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::uuid IS NULL OR patient_id=$3) AND ($4::uuid IS NULL OR id>$4) AND {filter} ORDER BY id LIMIT $5");
    let rows = sqlx::query_scalar(&sql)
        .bind(a.tenant_id)
        .bind(q.id)
        .bind(q.patient)
        .bind(q.after)
        .bind(q.count + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(Error::from)?;
    crate::postgres::audit(
        &mut tx,
        a,
        if read {
            "patient.fhir_clinical.read"
        } else {
            "patient.fhir_clinical.fhir_search"
        },
        q.id.or(q.patient).unwrap_or(a.tenant_id),
    )
    .await?;
    tx.commit().await.map_err(Error::from)?;
    Ok(rows)
}
async fn clinical_read(
    actor: Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<String>,
    OriginalUri(uri): OriginalUri,
) -> Result<Response, Failure> {
    let a = actor?;
    a.staff()?;
    let kind = uri.path().split('/').nth(2).ok_or(Error::NotFound)?;
    let q = ClinicalQuery {
        id: Some(id.parse().map_err(|_| Error::NotFound)?),
        count: 1,
        ..Default::default()
    };
    let rows = clinical_rows(&s, &a, kind, &q, true).await?;
    let resource = clinical_resource(kind, rows.first().ok_or(Error::NotFound)?);
    let version = resource["meta"]["versionId"]
        .as_str()
        .unwrap_or("1")
        .to_owned();
    let mut response = Fhir(resource).into_response();
    if matches!(
        kind,
        "Condition" | "AllergyIntolerance" | "MedicationStatement"
    ) {
        response
            .headers_mut()
            .insert(header::ETAG, format!("W/\"{version}\"").parse().unwrap());
    }
    Ok(response)
}
async fn clinical_search(
    actor: Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    RawQuery(raw): RawQuery,
    OriginalUri(uri): OriginalUri,
) -> Result<Fhir, Failure> {
    let a = actor?;
    a.staff()?;
    let kind = uri.path().split('/').nth(2).ok_or(Error::NotFound)?;
    let q = ClinicalQuery::parse(raw.as_deref())?;
    let mut rows = clinical_rows(&s, &a, kind, &q, false).await?;
    let more = rows.len() > q.count as usize;
    if more {
        rows.pop();
    }
    let base = origin(&s)?;
    let mut links = vec![
        json!({"relation":"self","url":format!("{base}/fhir/{kind}{}",raw.as_ref().map(|v|format!("?{v}")).unwrap_or_default())}),
    ];
    if more {
        if let Some(last) = rows.last() {
            let mut next = url::Url::parse(&format!("{base}/fhir/{kind}"))
                .map_err(|_| Error::Invalid("invalid installation URL"))?;
            for (k, v) in &q.parameters {
                if k != "_after" {
                    next.query_pairs_mut().append_pair(k, v);
                }
            }
            next.query_pairs_mut()
                .append_pair("_after", last["id"].as_str().ok_or(Error::NotFound)?);
            links.push(json!({"relation":"next","url":next.as_str()}));
        }
    }
    Ok(search_bundle(links, rows.iter().map(|row|json!({"fullUrl":format!("{base}/fhir/{kind}/{}",row["id"].as_str().unwrap_or_default()),"resource":clinical_resource(kind,row),"search":{"mode":"match"}})).collect()))
}
