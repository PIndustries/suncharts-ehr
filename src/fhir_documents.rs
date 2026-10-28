// SPDX-License-Identifier: AGPL-3.0-only
//! Staff-only FHIR references to native document originals and prescriptions.
use super::{origin, search_bundle, Failure, Fhir};
use crate::{auth::Actor, error::Error, State};
use axum::{
    extract::{OriginalUri, Path, RawQuery, State as ExtractState},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;
pub(super) fn routes() -> Router<State> {
    Router::new()
        .route("/fhir/DocumentReference", get(search))
        .route("/fhir/DocumentReference/{id}", get(read))
        .route("/fhir/Binary/{id}", get(binary))
        .route("/fhir/MedicationRequest", get(search))
        .route("/fhir/MedicationRequest/{id}", get(read))
}
pub(super) fn capability(kind: &str) -> Value {
    let mut v = json!({"type":kind,"versioning":"no-version","interaction":[{"code":"read"}],"documentation":"Staff-only native projection. Document originals are immutable. Prescriptions describe local authorization and never assert external delivery."});
    if kind != "Binary" {
        v["interaction"] = json!([{"code":"read"},{"code":"search-type"}]);
        v["searchParam"] =
            json!([{"name":"_id","type":"token"},{"name":"patient","type":"reference"}]);
    }
    v
}
#[derive(Default)]
struct Query {
    params: BTreeMap<String, String>,
    id: Option<Uuid>,
    patient: Option<Uuid>,
    after: Option<Uuid>,
    count: i64,
}
impl Query {
    fn parse(raw: Option<&str>) -> Result<Self, Failure> {
        let mut q = Self {
            count: 50,
            ..Default::default()
        };
        for (k, v) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
            if !["_id", "patient", "_after", "_count"].contains(&k.as_ref())
                || q.params.insert(k.into_owned(), v.into_owned()).is_some()
            {
                return Err(
                    Error::Invalid("unsupported or repeated document search parameter").into(),
                );
            }
        }
        for (key, slot) in [
            ("_id", &mut q.id),
            ("patient", &mut q.patient),
            ("_after", &mut q.after),
        ] {
            if let Some(v) = q.params.get(key) {
                let v = if key == "patient" {
                    v.strip_prefix("Patient/").unwrap_or(v)
                } else {
                    v
                };
                *slot =
                    Some(v.parse().map_err(|_| {
                        Error::Invalid("expected UUID or relative Patient reference")
                    })?);
            }
        }
        if let Some(v) = q.params.get("_count") {
            q.count = v.parse().map_err(|_| Error::Invalid("invalid count"))?;
        }
        if !(1..=100).contains(&q.count) {
            return Err(Error::Invalid("count must be between 1 and 100").into());
        }
        Ok(q)
    }
}
async fn rows(
    s: &State,
    a: &Actor,
    kind: &str,
    q: &Query,
    read: bool,
) -> Result<Vec<Value>, Failure> {
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let table = match kind {
        "DocumentReference" => "patient_documents",
        "MedicationRequest" => "native_prescriptions",
        _ => return Err(Error::NotFound.into()),
    };
    let projection = if kind == "DocumentReference" {
        "jsonb_build_object('id',id,'patient_id',patient_id,'version',version,'content',content,'filename',filename,'content_type',content_type,'size_bytes',size_bytes,'uploaded_at',uploaded_at,'updated_at',updated_at)"
    } else {
        "to_jsonb(r)-'tenant_id'-'signed_snapshot'"
    };
    let sql=format!("SELECT {projection} FROM {table} r WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::uuid IS NULL OR patient_id=$3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5");
    let mut tx = db.begin().await.map_err(Error::from)?;
    let found = sqlx::query_scalar(&sql)
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
            "patient.fhir_document.read"
        } else {
            "patient.fhir_document.search"
        },
        q.id.or(q.patient).unwrap_or(a.tenant_id),
    )
    .await?;
    tx.commit().await.map_err(Error::from)?;
    Ok(found)
}
fn reference(kind: &str, id: &Value) -> Value {
    json!({"reference":format!("{kind}/{}",id.as_str().unwrap_or_default())})
}
fn quantity_number(value: &str) -> Option<serde_json::Number> {
    // Native positive decimals permit leading zeros; JSON numbers do not.
    // Normalize the integer spelling without changing units, scale or quantity.
    let (integer, fraction) = value
        .split_once('.')
        .map_or((value, None), |(i, f)| (i, Some(f)));
    let integer = integer.trim_start_matches('0');
    let integer = if integer.is_empty() { "0" } else { integer };
    let normalized = match fraction {
        Some(f) => format!("{integer}.{f}"),
        None => integer.to_string(),
    };
    normalized.parse().ok()
}
fn resource(kind: &str, r: &Value, base: &str) -> Value {
    let c = &r["content"];
    let mut v = json!({"resourceType":kind,"id":r["id"],"meta":{"versionId":r["version"].as_i64().unwrap_or(1).to_string(),"lastUpdated":r["updated_at"]},"subject":reference("Patient",&r["patient_id"])});
    if kind == "DocumentReference" {
        v["status"] = json!(if c["status"] == "entered_in_error" {
            "entered-in-error"
        } else {
            "current"
        });
        v["date"] = r["uploaded_at"].clone();
        v["description"] = c["title"].clone();
        v["category"] = json!([{"coding":[{"system":format!("{base}/CodeSystem/document-category"),"code":c["category"]}]}]);
        v["content"] = json!([{"attachment":{"contentType":r["content_type"],"url":format!("{base}/fhir/Binary/{}",r["id"].as_str().unwrap_or_default()),"size":r["size_bytes"],"title":r["filename"],"creation":r["uploaded_at"]}}]);
        if !c["visit_id"].is_null() {
            v["context"] = json!({"encounter":[reference("Encounter",&c["visit_id"])]});
        }
    } else {
        v["status"] = r["status"].clone();
        v["intent"] = json!("order");
        v["authoredOn"] = r["created_at"].clone();
        let medication_text = ["medication_name", "strength", "dosage_form"]
            .into_iter()
            .filter_map(|k| c[k].as_str().filter(|v| !v.is_empty()))
            .collect::<Vec<_>>()
            .join(" ");
        v["medicationCodeableConcept"] = json!({"text":medication_text});
        if let Some(code) = c["rxnorm_code"].as_str().filter(|v| !v.is_empty()) {
            v["medicationCodeableConcept"]["coding"] =
                json!([{"system":"http://www.nlm.nih.gov/research/umls/rxnorm","code":code}]);
        }
        if !r["visit_id"].is_null() {
            v["encounter"] = reference("Encounter", &r["visit_id"]);
        }
        v["requester"] = reference(
            "Practitioner",
            if r["signed_by"].is_null() {
                &r["authored_by"]
            } else {
                &r["signed_by"]
            },
        );
        if !r["prior_prescription_id"].is_null() {
            v["priorPrescription"] = reference("MedicationRequest", &r["prior_prescription_id"]);
        }
        let text = ["dose", "route", "frequency", "instructions"]
            .into_iter()
            .filter_map(|k| c[k].as_str().filter(|v| !v.is_empty()))
            .collect::<Vec<_>>()
            .join("; ");
        if !text.is_empty() {
            v["dosageInstruction"] = json!([{"text":text}]);
        }
        if let Some(reason) = c["indication"].as_str().filter(|v| !v.is_empty()) {
            v["reasonCode"] = json!([{"text":reason}]);
        }
        if c["substitution_allowed"].is_boolean() {
            v["substitution"] = json!({"allowedBoolean":c["substitution_allowed"]});
        }
        let mut dispense = json!({});
        if let Some(quantity) = c["quantity"].as_str().and_then(quantity_number) {
            dispense["quantity"] = json!({"value":quantity});
            if let Some(unit) = c["quantity_unit"].as_str().filter(|v| !v.is_empty()) {
                dispense["quantity"]["unit"] = json!(unit);
            }
        }
        if let Some(refills) = c["refills"].as_u64() {
            dispense["numberOfRepeatsAllowed"] = json!(refills);
        }
        if let Some(days) = c["days_supply"].as_u64() {
            dispense["expectedSupplyDuration"] =
                json!({"value":days,"unit":"days","system":"http://unitsofmeasure.org","code":"d"});
        }
        if !dispense.as_object().unwrap().is_empty() {
            v["dispenseRequest"] = dispense;
        }
    }
    v
}
async fn read(
    actor: Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    OriginalUri(uri): OriginalUri,
    Path(raw): Path<String>,
) -> Result<Fhir, Failure> {
    let a = actor?;
    a.staff()?;
    let kind = uri.path().split('/').nth(2).ok_or(Error::NotFound)?;
    let id = raw.parse().map_err(|_| Error::NotFound)?;
    let row = rows(
        &s,
        &a,
        kind,
        &Query {
            id: Some(id),
            count: 1,
            ..Default::default()
        },
        true,
    )
    .await?
    .into_iter()
    .next()
    .ok_or(Error::NotFound)?;
    Ok(Fhir(resource(kind, &row, origin(&s)?)))
}
async fn search(
    actor: Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    OriginalUri(uri): OriginalUri,
    RawQuery(raw): RawQuery,
) -> Result<Fhir, Failure> {
    let a = actor?;
    a.staff()?;
    let kind = uri.path().split('/').nth(2).ok_or(Error::NotFound)?;
    let q = Query::parse(raw.as_deref())?;
    let mut found = rows(&s, &a, kind, &q, false).await?;
    let more = found.len() > q.count as usize;
    found.truncate(q.count as usize);
    let base = origin(&s)?;
    let mut self_url =
        url::Url::parse(&format!("{base}/fhir/{kind}")).map_err(|_| Error::NotFound)?;
    for (k, v) in &q.params {
        self_url.query_pairs_mut().append_pair(k, v);
    }
    let mut links = vec![json!({"relation":"self","url":self_url.as_str()})];
    if more {
        if let Some(last) = found.last() {
            let mut params = q.params;
            params.insert("_after".into(), last["id"].as_str().unwrap().into());
            let mut next = url::Url::parse(&format!("{base}/fhir/{kind}")).unwrap();
            for (k, v) in params {
                next.query_pairs_mut().append_pair(&k, &v);
            }
            links.push(json!({"relation":"next","url":next.as_str()}));
        }
    }
    Ok(search_bundle(links,found.iter().map(|r|json!({"fullUrl":format!("{base}/fhir/{kind}/{}",r["id"].as_str().unwrap()),"resource":resource(kind,r,base),"search":{"mode":"match"}})).collect()))
}
async fn binary(
    actor: Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    Path(raw): Path<String>,
    h: HeaderMap,
) -> Result<Response, Failure> {
    let a = actor?;
    a.staff()?;
    let id: Uuid = raw.parse().map_err(|_| Error::NotFound)?;
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let mut tx = db.begin().await.map_err(Error::from)?;
    let (mime, bytes): (String, Vec<u8>) = sqlx::query_as(
        "SELECT content_type,bytes FROM patient_documents WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Error::from)?
    .ok_or(Error::NotFound)?;
    let accept = h
        .get(header::ACCEPT)
        .map(|v| {
            v.to_str()
                .map_err(|_| Error::Invalid("invalid Accept header"))
        })
        .transpose()?
        .unwrap_or("application/fhir+json");
    // The most specific media range determines each representation's quality;
    // a wildcard must never override an explicit q=0 exclusion.
    let mut selected: Option<(&str, f64, u8)> = None;
    for representation in ["application/fhir+json", "application/json", mime.as_str()] {
        let mut matched: Option<(u8, f64)> = None;
        for item in accept.split(',') {
            let mut parts = item.trim().split(';');
            let media = parts.next().unwrap_or("").trim();
            let specificity = if media.eq_ignore_ascii_case(representation) {
                Some(2)
            } else if media == "*/*" {
                Some(0)
            } else if media.strip_suffix("/*").is_some_and(|prefix| {
                representation
                    .split('/')
                    .next()
                    .is_some_and(|kind| kind.eq_ignore_ascii_case(prefix))
            }) {
                Some(1)
            } else {
                None
            };
            let mut quality = 1.0_f64;
            for parameter in parts {
                if let Some(q) = parameter.trim().strip_prefix("q=") {
                    quality = q
                        .parse::<f64>()
                        .ok()
                        .filter(|q| q.is_finite() && (0.0..=1.0).contains(q))
                        .ok_or(Error::Invalid("invalid Accept quality"))?;
                }
            }
            if let Some(specificity) = specificity {
                if matched
                    .is_none_or(|(old, q)| specificity > old || (specificity == old && quality > q))
                {
                    matched = Some((specificity, quality));
                }
            }
        }
        if let Some((specificity, quality)) = matched.filter(|(_, q)| *q > 0.0) {
            if selected.is_none_or(|(_, q, old)| quality > q || (quality == q && specificity > old))
            {
                selected = Some((representation, quality, specificity));
            }
        }
    }
    let Some((representation, _, _)) = selected else {
        return Ok((StatusCode::NOT_ACCEPTABLE,Fhir(json!({"resourceType":"OperationOutcome","issue":[{"severity":"error","code":"not-supported","details":{"text":"Request application/fhir+json, application/json or the original document content type"}}]}))).into_response());
    };
    let json = representation != mime;
    crate::postgres::audit(&mut tx, &a, "patient.fhir_binary.read", id).await?;
    tx.commit().await.map_err(Error::from)?;
    let mut out = if json {
        Fhir(json!({"resourceType":"Binary","id":id,"contentType":mime,"securityContext":{"reference":format!("DocumentReference/{id}")},"data":STANDARD.encode(bytes)})).into_response()
    } else {
        ([(header::CONTENT_TYPE, mime.clone())], bytes).into_response()
    };
    if representation == "application/json" {
        out.headers_mut()
            .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    }
    out.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    out.headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    out.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{id}\"").parse().unwrap(),
    );
    Ok(out)
}
