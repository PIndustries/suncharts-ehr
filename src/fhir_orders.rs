// SPDX-License-Identifier: AGPL-3.0-only
//! Read-only native orders/results. Result IDs name an immutable report revision slot.
use super::{clinical_resource, origin, search_bundle, Failure, Fhir};
use crate::{auth::Actor, error::Error, State};
use axum::{
    extract::{OriginalUri, Path, RawQuery, State as ExtractState},
    http::header,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;
pub(super) const RESOURCES: [&str; 3] = ["ServiceRequest", "Specimen", "DiagnosticReport"];
pub(super) fn routes() -> Router<State> {
    let mut r = Router::new();
    for kind in RESOURCES.into_iter().chain(["Observation"]) {
        let collection = if kind == "ServiceRequest" {
            get(search).post(super::service_writes::create)
        } else {
            get(search)
        };
        let item = if kind == "ServiceRequest" {
            get(read).put(super::service_writes::update)
        } else {
            get(read)
        };
        r = r
            .route(&format!("/fhir/{kind}"), collection)
            .route(&format!("/fhir/{kind}/{{id}}"), item);
    }
    r
}
pub(super) fn capability(kind: &str) -> Value {
    if kind == "ServiceRequest" {
        return json!({"type":kind,"versioning":"versioned-update","updateCreate":false,"interaction":[{"code":"read"},{"code":"search-type"},{"code":"create"},{"code":"update"}],"documentation":"Only single-test native draft orders are writable (status draft, intent order). PUT requires If-Match and X-Change-Reason. Placement, multi-test editing and external execution use native workflows; ordinary POST is not replay-safe and unsupported conditional/idempotency headers fail.","searchParam":[{"name":"_id","type":"token"},{"name":"patient","type":"reference"}]});
    }
    json!({"type":kind,"documentation":"Staff-only native read/search. Lab Observation IDs identify an immutable report version and result slot; no clinical-analyte identity is inferred.","versioning":"no-version","interaction":[{"code":"read"},{"code":"search-type"}],"searchParam":[{"name":"_id","type":"token"},{"name":"patient","type":"reference"}]})
}
fn observation_id(report: &Value, index: usize) -> String {
    format!(
        "lab-{}-{}-{index}",
        report["id"].as_str().unwrap_or_default(),
        report["version"].as_i64().unwrap_or(1)
    )
}
fn canonical_id(kind: &str, raw: &str) -> Result<String, Failure> {
    if kind == "Observation" && raw.starts_with("lab-") {
        if !raw.is_ascii() || raw.len() > 64 {
            return Err(Error::Invalid("invalid result observation identifier").into());
        }
        let tail = &raw[4..];
        if tail.len() < 40 {
            return Err(Error::Invalid("invalid result observation identifier").into());
        }
        let (report, rest) = tail.split_at(36);
        let rest = rest
            .strip_prefix('-')
            .ok_or(Error::Invalid("invalid result observation identifier"))?;
        let (version, index) = rest
            .split_once('-')
            .ok_or(Error::Invalid("invalid result observation identifier"))?;
        let report =
            Uuid::parse_str(report).map_err(|_| Error::Invalid("invalid report identifier"))?;
        let version = version
            .parse::<i64>()
            .map_err(|_| Error::Invalid("invalid report version"))?;
        let index = index
            .parse::<u8>()
            .map_err(|_| Error::Invalid("invalid result ordinal"))?;
        if version < 1 || index > 99 {
            return Err(Error::Invalid("invalid result version or ordinal").into());
        }
        Ok(format!("lab-{report}-{version}-{index}"))
    } else {
        Ok(Uuid::parse_str(raw)
            .map_err(|_| Error::Invalid("expected UUID identifier"))?
            .to_string())
    }
}
#[derive(Default)]
struct Query {
    params: BTreeMap<String, String>,
    id: Option<String>,
    patient: Option<Uuid>,
    after: Option<String>,
    count: i64,
}
impl Query {
    fn parse(kind: &str, raw: Option<&str>) -> Result<Self, Failure> {
        let mut q = Self {
            count: 50,
            ..Default::default()
        };
        for (k, v) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
            if !["_id", "patient", "_after", "_count"].contains(&k.as_ref())
                || q.params.insert(k.into_owned(), v.into_owned()).is_some()
            {
                return Err(Error::Invalid("unsupported or repeated search parameter").into());
            }
        }
        if let Some(v) = q.params.get("_id") {
            q.id = Some(canonical_id(kind, v)?);
        }
        if let Some(v) = q.params.get("_after") {
            q.after = Some(canonical_id(kind, v)?);
        }
        if let Some(v) = q.params.get("patient") {
            q.patient = Some(
                v.strip_prefix("Patient/")
                    .unwrap_or(v)
                    .parse()
                    .map_err(|_| Error::Invalid("expected UUID or relative Patient reference"))?,
            );
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
fn report_locator(id: &str) -> Option<(Uuid, i64)> {
    let raw = id.strip_prefix("lab-")?;
    let (report_and_version, _) = raw.rsplit_once('-')?;
    let (report, version) = report_and_version.rsplit_once('-')?;
    Some((report.parse().ok()?, version.parse().ok()?))
}
async fn rows(
    s: &State,
    a: &Actor,
    kind: &str,
    q: &Query,
    read: bool,
) -> Result<Vec<Value>, Failure> {
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let mut tx = db.begin().await.map_err(Error::from)?;
    let historical =
        q.id.as_deref()
            .and_then(report_locator)
            .filter(|_| kind == "Observation");
    let source=match kind {
  "ServiceRequest"=>"SELECT o.id::text AS id,o.patient_id,to_jsonb(o)-'tenant_id' AS data FROM lab_orders o WHERE o.tenant_id=$1".to_string(),
  "Specimen"=>"SELECT t.id::text AS id,o.patient_id,(to_jsonb(t)-'tenant_id') || jsonb_build_object('patient_id',o.patient_id,'visit_id',o.visit_id) AS data FROM lab_specimens t JOIN lab_orders o ON o.tenant_id=t.tenant_id AND o.id=t.order_id WHERE t.tenant_id=$1".to_string(),
  "DiagnosticReport"=>"SELECT r.id::text AS id,o.patient_id,(to_jsonb(r)-'tenant_id') || jsonb_build_object('patient_id',o.patient_id,'visit_id',o.visit_id,'order_content',o.content) AS data FROM lab_reports r JOIN lab_orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id WHERE r.tenant_id=$1".to_string(),
  "Observation"=>{
   // Searches see current results; reads (including _id search) resolve immutable
   // report snapshots, preserving every previously published result reference.
   let report_source=if historical.is_some() {
    "SELECT h.tenant_id,h.report_id AS id,h.version,h.snapshot->'content' AS content,h.snapshot->>'status' AS status,h.snapshot AS report FROM lab_report_revisions h WHERE h.tenant_id=$1 AND h.report_id=$6 AND h.version=$7"
   } else {
    "SELECT r.tenant_id,r.id,r.version,r.content,r.status,to_jsonb(r)-'tenant_id' AS report FROM lab_reports r"
   };
   format!("SELECT v.id::text AS id,v.patient_id,jsonb_build_object('kind','vitals','row',to_jsonb(v)-'tenant_id','id',v.id::text) AS data FROM visits v WHERE v.tenant_id=$1 AND v.vitals IS NOT NULL UNION ALL SELECT 'lab-'||r.id::text||'-'||r.version::text||'-'||(result.ordinal-1)::text AS id,o.patient_id,jsonb_build_object('kind','lab','id','lab-'||r.id::text||'-'||r.version::text||'-'||(result.ordinal-1)::text,'report',r.report,'order',to_jsonb(o)-'tenant_id','observation',result.value) AS data FROM ({report_source}) r JOIN lab_orders o ON o.tenant_id=r.tenant_id AND o.id=(r.report->>'order_id')::uuid CROSS JOIN LATERAL jsonb_array_elements(r.content->'observations') WITH ORDINALITY AS result(value,ordinal) WHERE r.tenant_id=$1")
  },
  _=>return Err(Error::NotFound.into())
 };
    let sql=format!("SELECT data FROM ({source}) r WHERE ($2::text IS NULL OR id=$2) AND ($3::uuid IS NULL OR patient_id=$3) AND ($4::text IS NULL OR id COLLATE \"C\">$4 COLLATE \"C\") ORDER BY id COLLATE \"C\" LIMIT $5");
    let mut query = sqlx::query_scalar::<_, Value>(&sql)
        .bind(a.tenant_id)
        .bind(&q.id)
        .bind(q.patient)
        .bind(&q.after)
        .bind(q.count + 1);
    if let Some((report, version)) = historical {
        query = query.bind(report).bind(version);
    }
    let result = query.fetch_all(&mut *tx).await.map_err(Error::from)?;
    crate::postgres::audit(
        &mut tx,
        a,
        if read {
            "patient.fhir_orders.read"
        } else {
            "patient.fhir_orders.search"
        },
        q.id.as_deref()
            .and_then(|id| id.parse().ok())
            .or(historical.map(|(id, _)| id))
            .or(q.patient)
            .unwrap_or(a.tenant_id),
    )
    .await?;
    tx.commit().await.map_err(Error::from)?;
    Ok(result)
}
fn reference(kind: &str, id: &Value) -> Value {
    json!({"reference":format!("{kind}/{}",id.as_str().unwrap_or_default())})
}
fn nonempty(v: &Value) -> Option<&str> {
    v.as_str().filter(|v| !v.is_empty())
}
fn coding(c: &Value) -> Value {
    let mut result = json!({"system":c["system"],"code":c["code"]});
    if let Some(display) = nonempty(&c["display"]) {
        result["display"] = json!(display);
    }
    result
}
fn concept(text: &Value, code: &Value) -> Value {
    let mut c = json!({"text":text});
    if code.is_object() {
        c["coding"] = json!([coding(code)]);
    }
    c
}
fn report_status(status: &Value) -> Value {
    json!(status.as_str().unwrap_or("unknown").replace('_', "-"))
}
fn meta(out: &mut Value, row: &Value) {
    out["meta"] = json!({"versionId":row["version"].as_i64().unwrap_or(1).to_string()});
    if !row["updated_at"].is_null() {
        out["meta"]["lastUpdated"] = row["updated_at"].clone();
    }
}
pub(super) fn resource(kind: &str, row: &Value) -> Value {
    if kind == "Observation" && row["kind"] == "vitals" {
        return clinical_resource("Observation", &row["row"]);
    }
    let mut out = json!({"resourceType":kind,"id":row["id"],"subject":reference("Patient",&row["patient_id"])});
    let c = &row["content"];
    match kind {
        "ServiceRequest" => {
            meta(&mut out, row);
            out["status"] = json!(match row["status"].as_str().unwrap_or("") {
                "draft" => "draft",
                "ordered" | "in_progress" => "active",
                "completed" => "completed",
                "cancelled" => "revoked",
                "entered_in_error" => "entered-in-error",
                _ => "unknown",
            });
            out["intent"] = json!("order");
            out["priority"] = c["priority"].clone();
            out["code"] = json!({"text":c["title"]});
            out["category"] = json!([{"text":c["category"]}]);
            out["authoredOn"] = row["created_at"].clone();
            out["requester"] = reference("Practitioner", &row["created_by"]);
            if !row["visit_id"].is_null() {
                out["encounter"] = reference("Encounter", &row["visit_id"]);
            }
            if let Some(tests) = c["tests"].as_array().filter(|tests| tests.len() == 1) {
                out["code"] = concept(&tests[0]["label"], &tests[0]["code"]);
            }
            out["orderDetail"] = json!(c["tests"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|t| concept(&t["label"], &t["code"]))
                .collect::<Vec<_>>());
            let mut reasons = vec![json!({"text":c["clinical_reason"]})];
            for diagnosis in row["diagnosis_snapshot"]["diagnoses"]
                .as_array()
                .into_iter()
                .flatten()
            {
                reasons.push(json!({"text":diagnosis["display"],"coding":[{"system":row["diagnosis_snapshot"]["code_system"],"code":diagnosis["code"]}]}));
            }
            out["reasonCode"] = json!(reasons);
            if let Some(destination) = nonempty(&c["destination"]) {
                out["performer"] = json!([{"display":destination}]);
            }
            if let Some(instructions) = nonempty(&c["instructions"]) {
                out["note"] = json!([{"text":instructions}]);
            }
        }
        "Specimen" => {
            out["identifier"] = json!([{"value":c["accession"]}]);
            out["accessionIdentifier"] = json!({"value":c["accession"]});
            out["status"] = json!(if c["status"] == "rejected" {
                "unsatisfactory"
            } else {
                "available"
            });
            out["type"] = json!({"text":c["specimen_type"]});
            out["receivedTime"] = c["received_at"].clone();
            out["collection"] = json!({"collectedDateTime":c["collected_at"]});
            if let Some(site) = nonempty(&c["body_site"]) {
                out["collection"]["bodySite"] = json!({"text":site});
            }
            out["request"] = json!([reference("ServiceRequest", &row["order_id"])]);
            if let Some(notes) = nonempty(&c["notes"]) {
                out["note"] = json!([{"text":notes}]);
            }
        }
        "DiagnosticReport" => {
            meta(&mut out, row);
            out["status"] = report_status(&row["status"]);
            out["code"] = json!({"text":row["order_content"]["title"]});
            if let Some(keys) = c["test_keys"].as_array().filter(|keys| keys.len() == 1) {
                if let Some(test) = row["order_content"]["tests"]
                    .as_array()
                    .and_then(|tests| tests.iter().find(|test| test["key"] == keys[0]))
                {
                    out["code"] = concept(&test["label"], &test["code"]);
                }
            }
            out["identifier"] = json!([{"value":c["accession"]}]);
            out["issued"] = c["reported_at"].clone();
            out["basedOn"] = json!([reference("ServiceRequest", &row["order_id"])]);
            if !row["visit_id"].is_null() {
                out["encounter"] = reference("Encounter", &row["visit_id"]);
            }
            if !c["specimen_id"].is_null() {
                out["specimen"] = json!([reference("Specimen", &c["specimen_id"])]);
            }
            out["performer"] = json!([{"display":c["performing_lab"]}]);
            out["result"] = json!(c["observations"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(i, _)| json!({"reference":format!("Observation/{}",observation_id(row,i))}))
                .collect::<Vec<_>>());
        }
        "Observation" => {
            let report = &row["report"];
            let order = &row["order"];
            let o = &row["observation"];
            out["subject"] = reference("Patient", &order["patient_id"]);
            meta(&mut out, report);
            out["status"] = report_status(&report["status"]);
            out["category"] = json!([{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/observation-category","code":match order["content"]["category"].as_str(){Some("imaging")=>"imaging",Some("procedure")=>"procedure",_=>"laboratory"}}]}]);
            out["code"] = concept(&o["label"], &o["code"]);
            out["issued"] = report["content"]["reported_at"].clone();
            out["basedOn"] = json!([reference("ServiceRequest", &order["id"])]);
            if !order["visit_id"].is_null() {
                out["encounter"] = reference("Encounter", &order["visit_id"]);
            }
            if !report["content"]["specimen_id"].is_null() {
                out["specimen"] = reference("Specimen", &report["content"]["specimen_id"]);
            }
            match o["value_type"].as_str().unwrap_or("") {
                "numeric" => {
                    out["valueQuantity"] = json!({"value":o["number"],"unit":o["units"]});
                    if let Some(c) = nonempty(&o["comparator"]) {
                        out["valueQuantity"]["comparator"] = json!(c);
                    }
                }
                "text" => out["valueString"] = o["text"].clone(),
                "coded" => out["valueCodeableConcept"] = json!({"coding":[coding(&o["coded"])]}),
                "absent" => out["dataAbsentReason"] = json!({"text":o["absent_reason"]}),
                _ => {}
            }
            if let Some(range) = nonempty(&o["reference_range"]) {
                out["referenceRange"] = json!([{"text":range}]);
            }
            let flag = match o["flag"].as_str().unwrap_or("") {
                "normal" => Some("N"),
                "abnormal" => Some("A"),
                "high" => Some("H"),
                "low" => Some("L"),
                "critical_high" => Some("HH"),
                "critical_low" => Some("LL"),
                "critical" => Some("AA"),
                _ => None,
            };
            if let Some(flag) = flag {
                out["interpretation"] = json!([{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation","code":flag}]}]);
            }
            if let Some(notes) = nonempty(&o["notes"]) {
                out["note"] = json!([{"text":notes}]);
            }
        }
        _ => {}
    }
    out
}
async fn read(
    actor: Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<String>,
    OriginalUri(uri): OriginalUri,
) -> Result<Response, Failure> {
    let a = actor?;
    a.staff()?;
    let kind = uri.path().split('/').nth(2).ok_or(Error::NotFound)?;
    let id = canonical_id(kind, &id).map_err(|_| Failure(Error::NotFound))?;
    let q = Query {
        id: Some(id),
        count: 1,
        ..Default::default()
    };
    let result = rows(&s, &a, kind, &q, true).await?;
    let row = result.first().ok_or(Error::NotFound)?;
    let mut response = Fhir(resource(kind, row)).into_response();
    if kind == "ServiceRequest" {
        response.headers_mut().insert(
            header::ETAG,
            format!("W/\"{}\"", row["version"]).parse().unwrap(),
        );
    }
    Ok(response)
}
async fn search(
    actor: Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    RawQuery(raw): RawQuery,
    OriginalUri(uri): OriginalUri,
) -> Result<Fhir, Failure> {
    let a = actor?;
    a.staff()?;
    let kind = uri.path().split('/').nth(2).ok_or(Error::NotFound)?;
    let q = Query::parse(kind, raw.as_deref())?;
    let mut result = rows(&s, &a, kind, &q, false).await?;
    let more = result.len() > q.count as usize;
    if more {
        result.pop();
    }
    let base = origin(&s)?;
    let mut links = vec![
        json!({"relation":"self","url":format!("{base}/fhir/{kind}{}",raw.as_ref().map(|v|format!("?{v}")).unwrap_or_default())}),
    ];
    if more {
        if let Some(last) = result.last() {
            let mut next = url::Url::parse(&format!("{base}/fhir/{kind}"))
                .map_err(|_| Error::Invalid("invalid installation URL"))?;
            for (k, v) in &q.params {
                if k != "_after" {
                    next.query_pairs_mut().append_pair(k, v);
                }
            }
            next.query_pairs_mut()
                .append_pair("_after", last["id"].as_str().ok_or(Error::NotFound)?);
            links.push(json!({"relation":"next","url":next.as_str()}));
        }
    }
    Ok(search_bundle(links,result.iter().map(|r|{let resource=resource(kind,r);json!({"fullUrl":format!("{base}/fhir/{kind}/{}",resource["id"].as_str().unwrap_or_default()),"resource":resource,"search":{"mode":"match"}})}).collect()))
}
