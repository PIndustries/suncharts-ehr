// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Native contact details, separate from immutable core patient identity.
use crate::{
    auth::Actor,
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Address {
    pub line1: Option<String>,
    pub line2: Option<String>,
    pub city: Option<String>,
    pub region: Option<String>,
    pub postal_code: Option<String>,
    pub country: Option<String>,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct EmergencyContact {
    pub name: Option<String>,
    pub relationship: Option<String>,
    pub phone: Option<String>,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Content {
    pub preferred_name: Option<String>,
    pub pronouns: Option<String>,
    pub language: Option<String>,
    pub administrative_gender: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub address: Option<Address>,
    pub emergency_contact: Option<EmergencyContact>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub content: Content,
    pub reason: String,
}
fn field(s: &mut Option<String>, max: usize) -> Result<()> {
    if let Some(v) = s {
        *v = v.trim().to_owned();
        if v.chars().count() > max || v.chars().any(char::is_control) {
            return Err(Error::Invalid(
                "contact field exceeds its limit or contains control characters",
            ));
        }
        if v.is_empty() {
            *s = None;
        }
    }
    Ok(())
}
fn phone(s: &mut Option<String>) -> Result<()> {
    field(s, 40)?;
    if s.as_ref().is_some_and(|v| {
        !v.chars().any(|c| c.is_ascii_digit())
            || !v
                .chars()
                .all(|c| c.is_ascii_digit() || "+()- .xX#".contains(c))
    }) {
        return Err(Error::Invalid(
            "phone must contain digits and supported dialing punctuation",
        ));
    }
    Ok(())
}
impl Content {
    fn normalize(&mut self) -> Result<()> {
        field(&mut self.preferred_name, 100)?;
        field(&mut self.pronouns, 100)?;
        field(&mut self.language, 100)?;
        field(&mut self.administrative_gender, 20)?;
        if self
            .administrative_gender
            .as_ref()
            .is_some_and(|v| !["female", "male", "other", "unknown"].contains(&v.as_str()))
        {
            return Err(Error::Invalid("unsupported administrative gender"));
        }
        phone(&mut self.phone)?;
        field(&mut self.email, 254)?;
        if let Some(email) = &self.email {
            let mut parts = email.split('@');
            let local = parts.next().unwrap_or("");
            let domain = parts.next().unwrap_or("");
            if local.is_empty()
                || domain.is_empty()
                || parts.next().is_some()
                || email.chars().any(char::is_whitespace)
                || domain.starts_with('.')
                || domain.ends_with('.')
                || !domain.contains('.')
            {
                return Err(Error::Invalid(
                    "email must have a local part and domain; delivery is not verified",
                ));
            }
        }
        if let Some(a) = &mut self.address {
            field(&mut a.line1, 200)?;
            field(&mut a.line2, 200)?;
            field(&mut a.city, 100)?;
            field(&mut a.region, 100)?;
            field(&mut a.postal_code, 32)?;
            field(&mut a.country, 2)?;
            if let Some(c) = &mut a.country {
                *c = c.to_ascii_uppercase();
                if c.len() != 2 || !c.chars().all(|v| v.is_ascii_uppercase()) {
                    return Err(Error::Invalid("country must be a two-letter code"));
                }
            }
            if [
                &a.line1,
                &a.line2,
                &a.city,
                &a.region,
                &a.postal_code,
                &a.country,
            ]
            .iter()
            .all(|v| v.is_none())
            {
                self.address = None;
            }
        }
        if let Some(e) = &mut self.emergency_contact {
            field(&mut e.name, 200)?;
            field(&mut e.relationship, 100)?;
            phone(&mut e.phone)?;
            if e.name.is_none() && e.relationship.is_none() && e.phone.is_none() {
                self.emergency_contact = None;
            } else if e.name.is_none() {
                return Err(Error::Invalid(
                    "emergency contact name is required when contact details are recorded",
                ));
            }
        }
        Ok(())
    }
}
fn database(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::Unauthorized)?.db)
}
fn version(h: &HeaderMap) -> Result<i64> {
    let raw = h
        .get(header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .ok_or(Error::VersionRequired)?;
    let value = raw
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 0)
        .ok_or(Error::VersionRequired)?;
    Ok(value)
}
pub fn router() -> Router<State> {
    Router::new().route("/api/v1/patients/{id}/demographics", get(read).put(update))
}
async fn snapshot(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    a: &Actor,
    p: Uuid,
) -> Result<(i64, Value)> {
    let row: Option<(i64, Value)> = sqlx::query_as(
        "SELECT version,content FROM patient_demographics WHERE tenant_id=$1 AND patient_id=$2",
    )
    .bind(a.tenant_id)
    .bind(p)
    .fetch_optional(&mut **tx)
    .await?;
    let (version, content) = row.unwrap_or((
        0,
        serde_json::to_value(Content::default()).expect("serializable contact details"),
    ));
    let history: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('version',version,'content',content,'author_id',author_id,'reason',reason,'created_at',created_at) FROM patient_demographics_history WHERE tenant_id=$1 AND patient_id=$2 ORDER BY version DESC LIMIT 50").bind(a.tenant_id).bind(p).fetch_all(&mut **tx).await?;
    let history_truncated = version > 50;
    Ok((
        version,
        json!({"patient_id":p,"version":version,"content":content,"history":history,"history_truncated":history_truncated}),
    ))
}
fn response(v: i64, data: Value) -> Response {
    ([(header::ETAG, format!("\"{v}\""))], Json(data)).into_response()
}
async fn read(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
) -> Result<Response> {
    a.staff()?;
    let mut tx = database(&s)?.begin().await?;
    // Hold a shared patient lock so reads and full-profile replacements have a coherent snapshot.
    let exists: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM patients WHERE tenant_id=$1 AND id=$2 FOR SHARE")
            .bind(a.tenant_id)
            .bind(p)
            .fetch_optional(&mut *tx)
            .await?;
    exists.ok_or(Error::NotFound)?;
    let (v, data) = snapshot(&mut tx, &a, p).await?;
    crate::postgres::audit(&mut tx, &a, "patient.demographics_read", p).await?;
    tx.commit().await?;
    Ok(response(v, data))
}
async fn update(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    h: HeaderMap,
    Json(mut change): Json<Change>,
) -> Result<Response> {
    a.scheduling()?;
    let expected = version(&h)?;
    change.content.normalize()?;
    change.reason = change.reason.trim().to_owned();
    if change.reason.is_empty()
        || change.reason.chars().count() > 1000
        || change.reason.chars().any(char::is_control)
    {
        return Err(Error::Invalid(
            "a contact update reason of 1–1000 characters is required",
        ));
    }
    let mut tx = database(&s)?.begin().await?;
    // Contact invalidation and appointment scheduling use the same lock order.
    crate::scheduling::tenant_lock(&mut tx, &a).await?;
    let exists: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM patients WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
            .bind(a.tenant_id)
            .bind(p)
            .fetch_optional(&mut *tx)
            .await?;
    exists.ok_or(Error::NotFound)?;
    let current: Option<i64> = sqlx::query_scalar(
        "SELECT version FROM patient_demographics WHERE tenant_id=$1 AND patient_id=$2",
    )
    .bind(a.tenant_id)
    .bind(p)
    .fetch_optional(&mut *tx)
    .await?;
    let current = current.unwrap_or(0);
    if expected != current {
        return Err(Error::Conflict(
            "contact details changed; reload before saving",
        ));
    }
    let next = current
        .checked_add(1)
        .ok_or(Error::Conflict("contact version exhausted"))?;
    let content = serde_json::to_value(change.content).expect("serializable contact details");
    sqlx::query("INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,patient_id) DO UPDATE SET version=EXCLUDED.version,content=EXCLUDED.content").bind(a.tenant_id).bind(p).bind(next).bind(&content).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO patient_demographics_history(tenant_id,patient_id,version,content,author_id,reason) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(p).bind(next).bind(content).bind(a.sub).bind(change.reason).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "patient.demographics_update", p).await?;
    let (v, data) = snapshot(&mut tx, &a, p).await?;
    tx.commit().await?;
    Ok(response(v, data))
}
