// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
use crate::{
    error::{Error, Result},
    State,
};
use axum::{
    extract::FromRequestParts,
    http::{header, request::Parts},
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Owner,
    Clinician,
    FrontDesk,
    ReadOnly,
    Patient,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Actor {
    pub sub: Uuid,
    pub tenant_id: Uuid,
    pub role: Role,
    pub patient_id: Option<Uuid>,
    pub iss: String,
    pub aud: String,
    pub iat: i64,
    pub exp: i64,
}

impl Actor {
    pub fn staff(&self) -> Result<()> {
        if matches!(self.role, Role::Patient) {
            Err(Error::Forbidden)
        } else {
            Ok(())
        }
    }
    pub fn scheduling(&self) -> Result<()> {
        if matches!(self.role, Role::Owner | Role::Clinician | Role::FrontDesk) {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }
    pub fn clinical(&self) -> Result<()> {
        if matches!(self.role, Role::Owner | Role::Clinician) {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }
}

impl FromRequestParts<State> for Actor {
    type Rejection = Error;
    async fn from_request_parts(parts: &mut Parts, state: &State) -> Result<Self> {
        if !parts.headers.contains_key(header::AUTHORIZATION) {
            let browser = state.browser.as_ref().ok_or(Error::Unauthorized)?;
            let write = !matches!(
                parts.method,
                axum::http::Method::GET | axum::http::Method::HEAD
            );
            return browser.authenticate(&parts.headers, write).await;
        }
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|s| s.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
            .ok_or(Error::Unauthorized)?;
        if token.starts_with("sce_at_") {
            return crate::oauth::authenticate(state, token, &parts.method, parts.uri.path()).await;
        }
        if !state.allow_legacy_gateway {
            return Err(Error::Unauthorized);
        }
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_issuer(&[&state.issuer]);
        validation.set_audience(&[&state.audience]);
        validation.leeway = 0;
        validation.validate_nbf = true;
        let actor = decode::<Actor>(
            token,
            &DecodingKey::from_secret(state.secret.as_bytes()),
            &validation,
        )
        .map_err(|_| Error::Unauthorized)?
        .claims;
        let now = chrono::Utc::now().timestamp();
        if actor.iat > now + 5
            || actor.exp <= actor.iat
            || actor.exp - actor.iat > 120
            || (matches!(actor.role, Role::Patient) && actor.patient_id.is_none())
        {
            return Err(Error::Unauthorized);
        }
        Ok(actor)
    }
}
