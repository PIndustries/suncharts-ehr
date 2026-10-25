// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    OAuth(&'static str),
    #[error("authentication required")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    Invalid(&'static str),
    #[error("{0}")]
    Conflict(&'static str),
    #[error("If-Match with the current record version is required")]
    VersionRequired,
    #[error("database operation failed")]
    Database(#[from] sqlx::Error),
}
pub type Result<T> = std::result::Result<T, Error>;

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::OAuth(code) => (
                if code == "invalid_client" {
                    StatusCode::UNAUTHORIZED
                } else {
                    StatusCode::BAD_REQUEST
                },
                code,
                code,
            ),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "authentication required",
            ),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden", "forbidden"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found", "not found"),
            Self::Invalid(m) => (StatusCode::BAD_REQUEST, "invalid", m),
            Self::Conflict(m) => (StatusCode::CONFLICT, "conflict", m),
            Self::VersionRequired => (
                StatusCode::PRECONDITION_REQUIRED,
                "version_required",
                "If-Match with the current record version is required",
            ),
            Self::Database(e)
                if e.as_database_error()
                    .is_some_and(|d| d.code().as_deref() == Some("23505")) =>
            {
                (StatusCode::CONFLICT, "conflict", "resource already exists")
            }
            Self::Database(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "database operation failed",
            ),
        };
        let mut response =
            (status, Json(json!({"error": code, "message": message}))).into_response();
        if status == StatusCode::UNAUTHORIZED {
            response.headers_mut().insert(
                axum::http::header::WWW_AUTHENTICATE,
                axum::http::HeaderValue::from_static(if code == "invalid_client" {
                    "Basic realm=\"suncharts-ehr\""
                } else {
                    "Bearer realm=\"suncharts-ehr\""
                }),
            );
        }
        response
    }
}
