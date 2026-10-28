// SPDX-License-Identifier: AGPL-3.0-only
//! Narrow local draft-order writes; placement and external delivery remain native workflows.
use super::{origin, Failure, Fhir};
use crate::{auth::Actor, error::Error, State};
use axum::{
    extract::{rejection::JsonRejection, Path, State as ExtractState},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Input {
    resource_type: String,
    id: Option<Uuid>,
    meta: Option<Meta>,
    status: String,
    intent: String,
    subject: Reference,
    encounter: Option<Reference>,
    code: Code,
    category: Vec<Text>,
    priority: String,
    reason_code: Vec<Text>,
    performer: Vec<Display>,
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
fn reference(r: &Reference, kind: &str) -> Result<Uuid, Error> {
    r.reference
        .strip_prefix(&format!("{kind}/"))
        .ok_or(Error::Invalid("relative resource reference required"))?
        .parse()
        .map_err(|_| Error::Invalid("invalid resource reference"))
}
fn input(body: Result<Json<Value>, JsonRejection>) -> Result<Input, Failure> {
    let Json(v) = body.map_err(|_| Error::Invalid("invalid FHIR JSON body"))?;
    serde_json::from_value(v).map_err(|_| {
        Error::Invalid(
            "unsupported ServiceRequest field; only single-test local drafts are writable",
        )
        .into()
    })
}
impl Input {
    fn content(self) -> Result<crate::labs::OrderContent, Error> {
        if self.resource_type != "ServiceRequest"
            || self.status != "draft"
            || self.intent != "order"
        {
            return Err(Error::Invalid("only draft ServiceRequest with intent order is supported; placement and external delivery use native workflows"));
        }
        if self.code.coding.len() > 1
            || self.category.len() != 1
            || self.reason_code.len() != 1
            || self.performer.len() != 1
            || self.note.as_ref().is_some_and(|n| n.len() != 1)
        {
            return Err(Error::Invalid(
                "one requested test/category/reason/destination and at most one note are supported",
            ));
        }
        let mut codes = self.code.coding;
        let code = codes.pop();
        Ok(crate::labs::OrderContent {
            title: self.code.text.clone(),
            category: self.category.into_iter().next().unwrap().text,
            priority: self.priority,
            clinical_reason: self.reason_code.into_iter().next().unwrap().text,
            destination: self.performer.into_iter().next().unwrap().display,
            instructions: self
                .note
                .and_then(|mut n| n.pop())
                .map_or(String::new(), |n| n.text),
            tests: vec![crate::labs::RequestedTest {
                key: "fhir-test".into(),
                label: self.code.text,
                code,
            }],
        })
    }
}
async fn response(native: Response, base: &str, status: StatusCode) -> Result<Response, Failure> {
    let bytes = axum::body::to_bytes(native.into_body(), 256 * 1024)
        .await
        .map_err(|_| Error::Invalid("native order response unavailable"))?;
    let row: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Error::Invalid("native order response unavailable"))?;
    let mut r = (
        status,
        Fhir(super::orders::resource("ServiceRequest", &row)),
    )
        .into_response();
    r.headers_mut().insert(
        header::ETAG,
        format!("W/\"{}\"", row["version"]).parse().unwrap(),
    );
    r.headers_mut().insert(
        header::LOCATION,
        format!("{base}/fhir/ServiceRequest/{}", row["id"].as_str().unwrap())
            .parse()
            .unwrap(),
    );
    r.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok(r)
}
pub(super) async fn create(
    ExtractState(s): ExtractState<State>,
    actor: Result<Actor, Error>,
    h: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Result<Response, Failure> {
    let a = actor?;
    a.clinical()?;
    super::writes::reject_conditions(&h)?;
    if h.contains_key(header::IF_MATCH) {
        return Err(Error::Invalid("If-Match unsupported for create").into());
    }
    let i = input(body)?;
    if i.id.is_some() || i.meta.is_some() {
        return Err(Error::Invalid("creation assigns ID/version").into());
    }
    let patient = reference(&i.subject, "Patient")?;
    let visit_id = i
        .encounter
        .as_ref()
        .map(|r| reference(r, "Encounter"))
        .transpose()?;
    let content = i.content()?;
    let base = origin(&s)?.to_string();
    let native = crate::labs::create(
        a,
        ExtractState(s),
        Path(patient),
        Json(crate::labs::NewOrder {
            request_id: Uuid::new_v4(),
            visit_id,
            source_history_id: None,
            content,
            reason: "FHIR local order draft created".into(),
        }),
    )
    .await?;
    response(native, &base, StatusCode::CREATED).await
}
pub(super) async fn update(
    ExtractState(s): ExtractState<State>,
    actor: Result<Actor, Error>,
    Path(raw): Path<String>,
    h: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Result<Response, Failure> {
    let a = actor?;
    a.clinical()?;
    super::writes::reject_conditions(&h)?;
    let version = super::writes::version(&h)?;
    let id: Uuid = raw.parse().map_err(|_| Error::NotFound)?;
    let i = input(body)?;
    if i.id != Some(id)
        || i.meta
            .as_ref()
            .and_then(|m| m.version_id.as_ref())
            .is_some_and(|v| v != &version.to_string())
    {
        return Err(Error::Invalid("ServiceRequest ID/version must match URL and If-Match").into());
    }
    let patient = reference(&i.subject, "Patient")?;
    let visit_id = i
        .encounter
        .as_ref()
        .map(|r| reference(r, "Encounter"))
        .transpose()?;
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let old: Option<Value> = sqlx::query_scalar(
        "SELECT content FROM lab_orders WHERE tenant_id=$1 AND patient_id=$2 AND id=$3",
    )
    .bind(a.tenant_id)
    .bind(patient)
    .bind(id)
    .fetch_optional(db)
    .await
    .map_err(Error::from)?;
    let old = old.ok_or(Error::NotFound)?;
    if old["tests"].as_array().is_none_or(|v| v.len() != 1) {
        return Err(Error::Invalid("multi-test drafts must use the native order workflow").into());
    }
    let mut content = i.content()?;
    // Preserve immutable test identity used by native downstream report mappings.
    content.tests[0].key = old["tests"][0]["key"]
        .as_str()
        .ok_or(Error::Invalid("native test identity unavailable"))?
        .to_string();
    let reason = h
        .get("x-change-reason")
        .and_then(|v| v.to_str().ok())
        .ok_or(Error::Invalid(
            "X-Change-Reason required for draft corrections",
        ))?
        .to_owned();
    let base = origin(&s)?.to_string();
    let mut native_headers = HeaderMap::new();
    native_headers.insert(header::IF_MATCH, format!("\"{version}\"").parse().unwrap());
    let native = crate::labs::edit(
        a,
        ExtractState(s),
        Path((patient, id)),
        native_headers,
        Json(crate::labs::EditOrder {
            visit_id,
            content,
            reason,
        }),
    )
    .await?;
    response(native, &base, StatusCode::OK).await
}
