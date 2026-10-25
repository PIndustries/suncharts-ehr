// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
pub mod auth;
pub mod backend;
pub mod billing;
pub mod browser;
pub mod ca277;
pub mod claimmd;
pub mod claims;
pub mod clearinghouse;
pub mod clinical;
pub mod delivery;
pub mod demographics;
pub mod era835;
pub mod era_batches;
pub mod era_chains;
pub mod era_file;
pub mod error;
pub mod events;
pub mod fhir;
pub mod labs;
pub mod migration;
pub mod model;
pub mod oauth;
pub mod postgres;
pub mod practice;
pub mod remittance_automation;
pub mod retrieval;
pub mod scheduling;
pub mod settlements;
pub mod sftp_transport;
pub mod stedi;
pub mod x12;

use auth::Actor;
use axum::{
    extract::{DefaultBodyLimit, Path, State as ExtractState},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use backend::ClinicalBackend;
use error::{Error, Result};
use model::*;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub struct State {
    pub backend: Arc<dyn ClinicalBackend>,
    pub secret: String,
    pub allow_legacy_gateway: bool,
    pub issuer: String,
    pub audience: String,
    pub browser: Option<Arc<browser::BrowserAuth>>,
}
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub fn app(state: State) -> Router {
    Router::new()
        .merge(oauth::router())
        .merge(clinical::router())
        .merge(labs::router())
        .merge(scheduling::router())
        .merge(practice::router())
        .merge(demographics::router())
        .merge(billing::router())
        .merge(claims::router())
        .merge(era_batches::router())
        .merge(era_chains::router())
        .merge(settlements::router())
        .merge(clearinghouse::router())
        .merge(delivery::router())
        .merge(retrieval::router())
        .merge(remittance_automation::router())
        .merge(ca277::router())
        .merge(events::router())
        .merge(migration::router())
        .merge(fhir::router())
        .route(
            "/",
            get(|| async { axum::response::Html(include_str!("../web/index.html")) }),
        )
        .route(
            "/app.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/app.js"),
                )
            }),
        )
        .route(
            "/shell.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/shell.js"),
                )
            }),
        )
        .route(
            "/demographics.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/demographics.js"),
                )
            }),
        )
        .route(
            "/practice.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/practice.js"),
                )
            }),
        )
        .route(
            "/style.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css")],
                    include_str!("../web/style.css"),
                )
            }),
        )
        .route(
            "/clinical.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/clinical.js"),
                )
            }),
        )
        .route(
            "/labs.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/labs.js"),
                )
            }),
        )
        .route(
            "/scheduling.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/scheduling.js"),
                )
            }),
        )
        .route(
            "/billing.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/billing.js"),
                )
            }),
        )
        .route(
            "/era-batches.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/era-batches.js"),
                )
            }),
        )
        .route(
            "/settlements.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/settlements.js"),
                )
            }),
        )
        .route(
            "/retrieval.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/retrieval.js"),
                )
            }),
        )
        .route(
            "/delivery.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/delivery.js"),
                )
            }),
        )
        .route(
            "/clearinghouse.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/clearinghouse.js"),
                )
            }),
        )
        .route(
            "/claims.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    include_str!("../web/claims.js"),
                )
            }),
        )
        .route("/auth/login", post(browser::login))
        .route("/auth/logout", post(browser::logout))
        .route("/auth/me", get(browser::me))
        .route("/health", get(|| async { "ok" }))
        .route(
            "/source",
            get(|| async {
                (
                    [
                        (header::CONTENT_TYPE, "application/gzip"),
                        (
                            header::CONTENT_DISPOSITION,
                            "attachment; filename=suncharts-ehr-source.tar.gz",
                        ),
                    ],
                    include_bytes!(concat!(env!("OUT_DIR"), "/source.tar.gz")).as_slice(),
                )
            }),
        )
        .route(
            "/openapi.json",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    include_str!("../api/openapi.json"),
                )
            }),
        )
        .route("/api/v1/patients", post(create_patient).get(patients))
        .route("/api/v1/patients/{id}/workspace", get(workspace))
        .route("/api/v1/patients/{id}", get(patient))
        .route("/api/v1/patients/{id}/record", get(record))
        .route("/api/v1/appointments", post(book))
        .route("/api/v1/appointments/{id}/check-in", post(check_in))
        .route("/api/v1/visits", post(start_visit))
        .route("/api/v1/visits/{id}", get(visit))
        .route("/api/v1/visits/{id}/note", put(note))
        .route("/api/v1/visits/{id}/vitals", put(vitals))
        .route("/api/v1/visits/{id}/sign", post(sign))
        .route("/api/v1/visits/{id}/amendments", post(amend))
        .route("/api/v1/portal/record", get(portal))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn(headers))
        .with_state(state)
}

async fn headers(req: axum::extract::Request, next: Next) -> Response {
    let mut r = next.run(req).await;
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    r.headers_mut().insert(header::CONTENT_SECURITY_POLICY,HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"));
    r.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    r.headers_mut().insert(
        header::LINK,
        HeaderValue::from_static(
            "</source>; rel=\"describedby\"; title=\"Corresponding Source (AGPL-3.0-only)\"",
        ),
    );
    r
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PatientQuery {
    after: Option<Uuid>,
}
async fn patients(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    axum::extract::Query(q): axum::extract::Query<PatientQuery>,
) -> Result<Json<PatientPage>> {
    Ok(Json(s.backend.patients(&a, q.after).await?))
}
async fn workspace(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Workspace>> {
    Ok(Json(s.backend.workspace(&a, id).await?))
}

fn expected(h: &HeaderMap) -> Result<i64> {
    let raw = h
        .get(header::IF_MATCH)
        .ok_or(Error::VersionRequired)?
        .to_str()
        .map_err(|_| Error::Invalid("invalid If-Match"))?;
    let v = raw
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .ok_or(Error::Invalid("If-Match must be a quoted record version"))?
        .parse::<i64>()
        .map_err(|_| Error::Invalid("invalid record version"))?;
    if v < 1 {
        return Err(Error::Invalid("invalid record version"));
    }
    Ok(v)
}
fn visit_response(v: Visit) -> Response {
    ([(header::ETAG, format!("\"{}\"", v.version))], Json(v)).into_response()
}

async fn create_patient(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(p): Json<NewPatient>,
) -> Result<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(s.backend.create_patient(&a, p).await?),
    ))
}
async fn patient(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Patient>> {
    Ok(Json(s.backend.patient(&a, id).await?))
}
async fn book(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(p): Json<NewAppointment>,
) -> Result<impl IntoResponse> {
    if let Some(browser) = &s.browser {
        scheduling::provider(&browser.db, &a, p.clinician_id).await?;
    }
    Ok((StatusCode::CREATED, Json(s.backend.book(&a, p).await?)))
}
async fn check_in(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Appointment>> {
    Ok(Json(s.backend.check_in(&a, id).await?))
}
async fn start_visit(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(p): Json<StartVisit>,
) -> Result<Response> {
    let mut r = visit_response(s.backend.start_visit(&a, p).await?);
    *r.status_mut() = StatusCode::CREATED;
    Ok(r)
}
async fn visit(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    Ok(visit_response(s.backend.visit(&a, id).await?))
}
async fn note(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(p): Json<SoapNote>,
) -> Result<Response> {
    Ok(visit_response(
        s.backend.save_note(&a, id, expected(&h)?, p).await?,
    ))
}
async fn vitals(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(p): Json<Vitals>,
) -> Result<Response> {
    Ok(visit_response(
        s.backend.save_vitals(&a, id, expected(&h)?, p).await?,
    ))
}
async fn sign(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Response> {
    Ok(visit_response(s.backend.sign(&a, id, expected(&h)?).await?))
}
async fn amend(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(p): Json<NewAmendment>,
) -> Result<Response> {
    Ok(visit_response(
        s.backend.amend(&a, id, expected(&h)?, p).await?,
    ))
}
async fn record(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Record>> {
    a.staff()?;
    Ok(Json(s.backend.record(&a, id).await?))
}
async fn portal(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Record>> {
    if !matches!(a.role, auth::Role::Patient) {
        return Err(Error::Forbidden);
    }
    Ok(Json(
        s.backend
            .record(&a, a.patient_id.ok_or(Error::Forbidden)?)
            .await?,
    ))
}
