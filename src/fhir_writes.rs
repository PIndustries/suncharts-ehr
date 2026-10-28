// SPDX-License-Identifier: AGPL-3.0-only
//! Deliberately narrow FHIR Patient identity create/update contract.
use super::{origin, resource, Failure, Fhir};
use crate::{
    auth::Actor,
    error::Error,
    model::NewPatient,
    patient_identity::{self, Change, Identity},
    State,
};
use axum::{
    extract::{rejection::JsonRejection, Path, State as ExtractState},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PatientInput {
    resource_type: String,
    id: Option<Uuid>,
    meta: Option<Meta>,
    identifier: Vec<Identifier>,
    name: Vec<Name>,
    birth_date: chrono::NaiveDate,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Meta {
    version_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identifier {
    system: Option<String>,
    value: String,
    #[serde(rename = "use")]
    use_: Option<String>,
    #[serde(rename = "type")]
    type_: Option<IdentifierType>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentifierType {
    coding: Vec<Coding>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Coding {
    system: String,
    code: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Name {
    family: String,
    given: Vec<String>,
    #[serde(rename = "use")]
    use_: Option<String>,
}
impl PatientInput {
    fn change(self, base: &str, reason: String) -> Result<Change, Error> {
        if self.resource_type != "Patient" || self.identifier.len() != 1 || self.name.len() != 1 {
            return Err(Error::Invalid(
                "Patient requires exactly one MRN identifier and one official name",
            ));
        }
        let i = self.identifier.into_iter().next().unwrap();
        let n = self.name.into_iter().next().unwrap();
        if i.system
            .as_ref()
            .is_some_and(|s| s != &format!("{base}/identifier/mrn"))
            || i.use_
                .as_ref()
                .is_some_and(|s| !matches!(s.as_str(), "usual" | "official"))
            || n.use_.as_ref().is_some_and(|s| s != "official")
            || n.given.len() != 1
        {
            return Err(Error::Invalid(
                "unsupported identifier system or name representation",
            ));
        }
        if let Some(t) = i.type_ {
            if t.coding.len() != 1
                || t.coding[0].system != "http://terminology.hl7.org/CodeSystem/v2-0203"
                || t.coding[0].code != "MR"
            {
                return Err(Error::Invalid("identifier type must be MR"));
            }
        }
        let c = Change {
            mrn: i.value,
            given_name: n.given.into_iter().next().unwrap(),
            family_name: n.family,
            birth_date: self.birth_date,
            reason,
        };
        c.validate()?;
        Ok(c)
    }
}
fn input(body: Result<Json<serde_json::Value>, JsonRejection>) -> Result<PatientInput, Failure> {
    let Json(v) = body.map_err(|_| Error::Invalid("invalid FHIR JSON body"))?;
    serde_json::from_value(v).map_err(|_| {
        Error::Invalid(
            "unsupported or invalid Patient fields; only registration identity is writable",
        )
        .into()
    })
}
pub(super) fn version(h: &HeaderMap) -> Result<i64, Failure> {
    let raw = h
        .get(header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .ok_or(Error::VersionRequired)?;
    let raw = raw.strip_prefix("W/").unwrap_or(raw);
    let n = raw
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v > 0)
        .ok_or(Error::VersionRequired)?;
    Ok(n)
}
fn response(p: Identity, base: &str, status: StatusCode) -> Response {
    let mut r = (
        status,
        Fhir(resource(
            p.id,
            p.mrn,
            p.given_name,
            p.family_name,
            p.birth_date,
            p.version,
            base,
        )),
    )
        .into_response();
    r.headers_mut().insert(
        header::ETAG,
        format!("W/\"{}\"", p.version).parse().unwrap(),
    );
    r.headers_mut().insert(
        header::LOCATION,
        format!("{base}/fhir/Patient/{}", p.id).parse().unwrap(),
    );
    r.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    r
}
pub(super) async fn create(
    ExtractState(s): ExtractState<State>,
    actor: Result<Actor, Error>,
    h: HeaderMap,
    body: Result<Json<serde_json::Value>, JsonRejection>,
) -> Result<Response, Failure> {
    let a = actor?;
    a.clinical()?;
    if h.contains_key("If-None-Exist")
        || h.contains_key(header::IF_NONE_MATCH)
        || h.contains_key(header::IF_MATCH)
    {
        return Err(Error::Invalid("conditional Patient creation is not supported").into());
    }
    let i = input(body)?;
    if i.id.is_some()
        || i.meta
            .as_ref()
            .and_then(|m| m.version_id.as_ref())
            .is_some()
    {
        return Err(Error::Invalid("Patient creation assigns its own ID and version").into());
    }
    let base = origin(&s)?;
    let c = i.change(base, "FHIR Patient registered".into())?;
    let p = s
        .backend
        .create_patient(
            &a,
            NewPatient {
                mrn: c.mrn,
                given_name: c.given_name,
                family_name: c.family_name,
                birth_date: c.birth_date,
            },
        )
        .await?;
    Ok(response(
        Identity {
            id: p.id,
            mrn: p.mrn,
            given_name: p.given_name,
            family_name: p.family_name,
            birth_date: p.birth_date,
            version: 1,
        },
        base,
        StatusCode::CREATED,
    ))
}
pub(super) async fn update(
    ExtractState(s): ExtractState<State>,
    actor: Result<Actor, Error>,
    Path(raw): Path<String>,
    h: HeaderMap,
    body: Result<Json<serde_json::Value>, JsonRejection>,
) -> Result<Response, Failure> {
    let a = actor?;
    a.clinical()?;
    if h.contains_key("If-None-Exist")
        || h.contains_key(header::IF_NONE_MATCH)
        || h.contains_key(header::IF_MODIFIED_SINCE)
        || h.contains_key(header::IF_UNMODIFIED_SINCE)
    {
        return Err(Error::Invalid(
            "conditional Patient updates beyond If-Match are not supported",
        )
        .into());
    }
    let id = Uuid::parse_str(&raw).map_err(|_| Error::NotFound)?;
    let expected = version(&h)?;
    let i = input(body)?;
    if i.id != Some(id) {
        return Err(Error::Invalid("Patient.id must match the update URL").into());
    }
    if i.meta
        .as_ref()
        .and_then(|m| m.version_id.as_ref())
        .is_some_and(|v| v != &expected.to_string())
    {
        return Err(Error::Invalid("Patient meta.versionId must match If-Match").into());
    }
    let reason = h
        .get("X-Change-Reason")
        .and_then(|v| v.to_str().ok())
        .ok_or(Error::Invalid(
            "X-Change-Reason is required for Patient identity corrections",
        ))?
        .to_owned();
    let base = origin(&s)?;
    let c = i.change(base, reason)?;
    let p = patient_identity::update(&s, &a, id, expected, &c).await?;
    Ok(response(p, base, StatusCode::OK))
}

// These adapters call the native revision/audit boundary. Ordinary POST is not
// replay-safe; conditional/idempotency headers fail explicitly rather than imply it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ClinicalInput {
    resource_type: String,
    id: Option<Uuid>,
    meta: Option<Meta>,
    subject: Option<Reference>,
    patient: Option<Reference>,
    code: Option<Concept>,
    medication_codeable_concept: Option<Concept>,
    clinical_status: Option<Concept>,
    verification_status: Option<Concept>,
    status: Option<String>,
    category: Option<Vec<serde_json::Value>>,
    criticality: Option<String>,
    reaction: Option<Vec<Reaction>>,
    onset_date_time: Option<chrono::NaiveDate>,
    abatement_date_time: Option<chrono::NaiveDate>,
    effective_period: Option<Period>,
    note: Option<Vec<Text>>,
    dosage: Option<Vec<Text>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reference {
    reference: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Concept {
    #[serde(default)]
    coding: Vec<ClinicalCoding>,
    text: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClinicalCoding {
    system: String,
    code: String,
    display: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Text {
    text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reaction {
    manifestation: Vec<Text>,
    severity: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Period {
    start: Option<chrono::NaiveDate>,
    end: Option<chrono::NaiveDate>,
}
fn coded(input: Option<Concept>, system: &str, required: bool) -> Result<Option<String>, Error> {
    let Some(c) = input else {
        return if required {
            Err(Error::Invalid("required clinical status missing"))
        } else {
            Ok(None)
        };
    };
    if c.text.is_some()
        || c.coding.len() != 1
        || c.coding[0].system != system
        || c.coding[0].display.is_some()
    {
        return Err(Error::Invalid(
            "status requires one exact coding with its supported system",
        ));
    }
    Ok(Some(c.coding[0].code.replace('-', "_")))
}
fn singleton(v: Option<Vec<Text>>) -> Result<String, Error> {
    match v {
        None => Ok(String::new()),
        Some(mut v) if v.len() == 1 => Ok(v.remove(0).text),
        _ => Err(Error::Invalid("exactly one text annotation is supported")),
    }
}
impl ClinicalInput {
    fn patient(&self) -> Result<Uuid, Error> {
        let r = if self.resource_type == "AllergyIntolerance" {
            if self.subject.is_some() {
                return Err(Error::Invalid("AllergyIntolerance uses patient"));
            }
            self.patient.as_ref()
        } else {
            if self.patient.is_some() {
                return Err(Error::Invalid("resource uses subject"));
            }
            self.subject.as_ref()
        }
        .ok_or(Error::Invalid("patient reference required"))?;
        r.reference
            .strip_prefix("Patient/")
            .ok_or(Error::Invalid("relative Patient/UUID reference required"))?
            .parse()
            .map_err(|_| Error::Invalid("invalid patient reference"))
    }
    fn content(
        self,
        prior: Option<crate::clinical::Content>,
    ) -> Result<crate::clinical::Content, Error> {
        use crate::clinical::{Content, Detail};
        let medication = self.resource_type == "MedicationStatement";
        let allergy = self.resource_type == "AllergyIntolerance";
        if !["Condition", "AllergyIntolerance", "MedicationStatement"]
            .contains(&self.resource_type.as_str())
        {
            return Err(Error::Invalid("unsupported clinical resource"));
        }
        if medication
            && (self.code.is_some()
                || self.clinical_status.is_some()
                || self.verification_status.is_some()
                || self.category.is_some()
                || self.criticality.is_some()
                || self.reaction.is_some()
                || self.onset_date_time.is_some()
                || self.abatement_date_time.is_some())
            || !medication
                && (self.medication_codeable_concept.is_some()
                    || self.status.is_some()
                    || self.effective_period.is_some()
                    || self.dosage.is_some())
            || !allergy && (self.criticality.is_some() || self.reaction.is_some())
            || allergy && self.abatement_date_time.is_some()
        {
            return Err(Error::Invalid(
                "field is unsupported for this resource type",
            ));
        }
        let code = if medication {
            self.medication_codeable_concept
        } else {
            self.code
        }
        .ok_or(Error::Invalid("a code with nonempty text is required"))?;
        let title = code
            .text
            .filter(|s| !s.trim().is_empty())
            .ok_or(Error::Invalid("a code with nonempty text is required"))?;
        let codes = code
            .coding
            .into_iter()
            .map(|c| crate::clinical::Coding {
                system: c.system,
                code: c.code,
                display: c.display.unwrap_or_default(),
            })
            .collect();
        let mut verification = if medication {
            prior
                .as_ref()
                .map_or("unconfirmed", |v| v.verification.as_str())
                .to_string()
        } else {
            coded(
                self.verification_status,
                if allergy {
                    "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification"
                } else {
                    "http://terminology.hl7.org/CodeSystem/condition-ver-status"
                },
                true,
            )?
            .unwrap()
        };
        let status = if medication {
            self.status
                .ok_or(Error::Invalid("MedicationStatement status required"))?
                .replace('-', "_")
        } else {
            let status = coded(
                self.clinical_status,
                if allergy {
                    "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical"
                } else {
                    "http://terminology.hl7.org/CodeSystem/condition-clinical"
                },
                verification != "entered_in_error",
            )?;
            if verification == "entered_in_error" {
                if status.is_some() {
                    return Err(Error::Invalid("entered-in-error omits clinicalStatus"));
                }
                "entered_in_error".into()
            } else {
                status.unwrap()
            }
        };
        if medication && status == "entered_in_error" {
            verification = "entered_in_error".into();
        }
        let (onset_date, end_date) = if medication {
            self.effective_period
                .map_or((None, None), |p| (p.start, p.end))
        } else {
            (
                self.onset_date_time,
                if allergy {
                    prior.as_ref().and_then(|v| v.end_date)
                } else {
                    self.abatement_date_time
                },
            )
        };
        let detail = if allergy {
            let category = match self.category {
                None => "other".to_string(),
                Some(v) if v.len() == 1 => v[0]
                    .as_str()
                    .filter(|v| ["food", "medication", "environment", "biologic"].contains(v))
                    .ok_or(Error::Invalid("one supported allergy category required"))?
                    .into(),
                _ => return Err(Error::Invalid("one allergy category supported")),
            };
            let (reaction, severity) = match self.reaction {
                None => (String::new(), "unknown".into()),
                Some(mut v) if v.len() == 1 => {
                    let r = v.remove(0);
                    if r.manifestation.len() != 1 {
                        return Err(Error::Invalid("one text reaction manifestation supported"));
                    }
                    (
                        r.manifestation.into_iter().next().unwrap().text,
                        r.severity.unwrap_or("unknown".into()),
                    )
                }
                _ => return Err(Error::Invalid("one allergy reaction supported")),
            };
            Detail::Allergy {
                category,
                reaction,
                severity,
                criticality: self.criticality.map_or("unknown".into(), |v| {
                    if v == "unable-to-assess" {
                        "unknown".into()
                    } else {
                        v
                    }
                }),
            }
        } else if medication {
            let mut detail =
                prior
                    .as_ref()
                    .map(|v| v.detail.clone())
                    .unwrap_or(Detail::Medication {
                        dose: String::new(),
                        route: String::new(),
                        frequency: String::new(),
                        indication: String::new(),
                    });
            if let Some(dosage) = self.dosage {
                let text = singleton(Some(dosage))?;
                if let Detail::Medication {
                    dose,
                    route,
                    frequency,
                    ..
                } = &mut detail
                {
                    let existing = [dose.as_str(), route.as_str(), frequency.as_str()]
                        .into_iter()
                        .filter(|v| !v.is_empty())
                        .collect::<Vec<_>>()
                        .join("; ");
                    if text != existing {
                        if !route.is_empty() || !frequency.is_empty() {
                            return Err(Error::Invalid("structured native dose must be edited through the native medication workflow"));
                        }
                        *dose = text;
                    }
                }
            }
            detail
        } else {
            let mut problem_type = prior
                .as_ref()
                .and_then(|v| match &v.detail {
                    Detail::Problem { problem_type } => Some(problem_type.clone()),
                    _ => None,
                })
                .unwrap_or("problem".into());
            if let Some(mut category) = self.category {
                if category.len() != 1 {
                    return Err(Error::Invalid("one Condition category supported"));
                }
                let c: Concept = serde_json::from_value(category.remove(0))
                    .map_err(|_| Error::Invalid("invalid Condition category"))?;
                problem_type = match coded(
                    Some(c),
                    "http://terminology.hl7.org/CodeSystem/condition-category",
                    true,
                )?
                .unwrap()
                .as_str()
                {
                    "problem_list_item" => "problem",
                    "encounter_diagnosis" => "diagnosis",
                    _ => return Err(Error::Invalid("unsupported Condition category")),
                }
                .into();
            }
            Detail::Problem { problem_type }
        };
        let c = Content {
            title,
            status,
            verification,
            onset_date,
            end_date,
            codes,
            notes: singleton(self.note)?,
            detail,
        };
        c.validate()?;
        Ok(c)
    }
}
pub(super) fn reject_conditions(h: &HeaderMap) -> Result<(), Failure> {
    if [
        "if-none-exist",
        "if-none-match",
        "if-modified-since",
        "if-unmodified-since",
        "idempotency-key",
        "x-idempotency-key",
    ]
    .iter()
    .any(|k| h.contains_key(*k))
    {
        return Err(Error::Invalid("conditional and idempotency headers are unsupported; POST creates a new entry, PUT requires If-Match").into());
    }
    Ok(())
}
fn clinical_input(
    body: Result<Json<serde_json::Value>, JsonRejection>,
) -> Result<ClinicalInput, Failure> {
    let Json(v) = body.map_err(|_| Error::Invalid("invalid FHIR JSON body"))?;
    serde_json::from_value(v)
        .map_err(|_| Error::Invalid("unsupported clinical resource field or representation").into())
}
async fn clinical_response(
    r: Response,
    kind: &str,
    base: &str,
    status: StatusCode,
) -> Result<Response, Failure> {
    let bytes = axum::body::to_bytes(r.into_body(), 128 * 1024)
        .await
        .map_err(|_| Error::Invalid("native clinical response unavailable"))?;
    let row: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| Error::Invalid("native clinical response unavailable"))?;
    let mut r = (status, Fhir(super::clinical_resource(kind, &row))).into_response();
    r.headers_mut().insert(
        header::ETAG,
        format!("W/\"{}\"", row["version"]).parse().unwrap(),
    );
    r.headers_mut().insert(
        header::LOCATION,
        format!("{base}/fhir/{kind}/{}", row["id"].as_str().unwrap())
            .parse()
            .unwrap(),
    );
    r.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok(r)
}
pub(super) async fn clinical_create(
    ExtractState(s): ExtractState<State>,
    actor: Result<Actor, Error>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
    h: HeaderMap,
    body: Result<Json<serde_json::Value>, JsonRejection>,
) -> Result<Response, Failure> {
    let a = actor?;
    a.clinical()?;
    reject_conditions(&h)?;
    if h.contains_key(header::IF_MATCH) {
        return Err(Error::Invalid("If-Match is unsupported for creation").into());
    }
    let i = clinical_input(body)?;
    let kind = uri
        .path()
        .split('/')
        .nth(2)
        .ok_or(Error::NotFound)?
        .to_string();
    if i.resource_type != kind || i.id.is_some() || i.meta.is_some() {
        return Err(
            Error::Invalid("resource type must match URL; create assigns ID/version").into(),
        );
    }
    let patient = i.patient()?;
    let content = i.content(None)?;
    let base = origin(&s)?.to_string();
    let r = crate::clinical::create(
        a,
        ExtractState(s),
        Path(patient),
        Json(crate::clinical::Change {
            content,
            reason: "FHIR clinical entry created".into(),
            source_history_id: None,
        }),
    )
    .await?;
    clinical_response(r, &kind, &base, StatusCode::CREATED).await
}
pub(super) async fn clinical_update(
    ExtractState(s): ExtractState<State>,
    actor: Result<Actor, Error>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
    Path(raw): Path<String>,
    h: HeaderMap,
    body: Result<Json<serde_json::Value>, JsonRejection>,
) -> Result<Response, Failure> {
    let a = actor?;
    a.clinical()?;
    reject_conditions(&h)?;
    let expected = version(&h)?;
    let id: Uuid = raw.parse().map_err(|_| Error::NotFound)?;
    let i = clinical_input(body)?;
    let kind = uri
        .path()
        .split('/')
        .nth(2)
        .ok_or(Error::NotFound)?
        .to_string();
    if i.resource_type != kind
        || i.id != Some(id)
        || i.meta
            .as_ref()
            .and_then(|m| m.version_id.as_ref())
            .is_some_and(|v| v != &expected.to_string())
    {
        return Err(Error::Invalid("resource ID/type/version must match URL and If-Match").into());
    }
    let patient = i.patient()?;
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let prior:Option<(serde_json::Value,Option<Uuid>)>=sqlx::query_as("SELECT content,source_history_id FROM clinical_entries WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 AND kind=$4").bind(a.tenant_id).bind(patient).bind(id).bind(match kind.as_str(){"Condition"=>"problem","AllergyIntolerance"=>"allergy","MedicationStatement"=>"medication",_=>return Err(Error::NotFound.into())}).fetch_optional(db).await.map_err(Error::from)?;
    let (prior, source_history_id) = prior.ok_or(Error::NotFound)?;
    let prior = serde_json::from_value(prior)
        .map_err(|_| Error::Invalid("native clinical content unavailable"))?;
    let content = i.content(Some(prior))?;
    let reason = h
        .get("x-change-reason")
        .and_then(|v| v.to_str().ok())
        .ok_or(Error::Invalid(
            "X-Change-Reason required for clinical updates",
        ))?
        .to_string();
    let mut native_headers = HeaderMap::new();
    native_headers.insert(header::IF_MATCH, format!("\"{expected}\"").parse().unwrap());
    let base = origin(&s)?.to_string();
    let r = crate::clinical::update(
        a,
        ExtractState(s),
        Path((patient, id)),
        native_headers,
        Json(crate::clinical::Change {
            content,
            reason,
            source_history_id,
        }),
    )
    .await?;
    clinical_response(r, &kind, &base, StatusCode::OK).await
}
