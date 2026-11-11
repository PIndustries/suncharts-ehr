// SPDX-License-Identifier: AGPL-3.0-only
//! Versioned corrections to registration identity; no patient merge or proxy changes.
use crate::{
    auth::Actor,
    error::{Error, Result},
    model::{text, Patient},
    postgres::audit,
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{Datelike, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
#[derive(Serialize, sqlx::FromRow)]
pub struct Identity {
    pub id: Uuid,
    pub mrn: String,
    pub given_name: String,
    pub family_name: String,
    pub birth_date: NaiveDate,
    pub version: i64,
}
impl Identity {
    pub fn patient(&self) -> Value {
        json!({"id":self.id,"mrn":self.mrn,"given_name":self.given_name,"family_name":self.family_name,"birth_date":self.birth_date})
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    #[serde(default)]
    pub mrn: Option<String>,
    pub given_name: String,
    pub family_name: String,
    pub birth_date: NaiveDate,
    pub reason: String,
}
impl Change {
    pub fn validate(&self, reason_required: bool) -> Result<()> {
        for (v, max) in [(&self.given_name, 100), (&self.family_name, 100)] {
            text(v, max)?;
            if v.chars().any(char::is_control) {
                return Err(Error::Invalid("identity fields contain control characters"));
            }
        }
        if reason_required || !self.reason.trim().is_empty() {
            text(&self.reason, 1000)?;
        }
        if self.reason.chars().any(char::is_control) {
            return Err(Error::Invalid("identity fields contain control characters"));
        }
        if self.birth_date > Utc::now().date_naive() || self.birth_date.year() < 1800 {
            return Err(Error::Invalid("invalid birth date"));
        }
        Ok(())
    }
}

async fn reason_required(tx: &mut Transaction<'_, Postgres>, a: &Actor) -> Result<bool> {
    let content = sqlx::query_scalar::<_, Value>(
        "SELECT content FROM practice_workspace_settings WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(content
        .as_ref()
        .and_then(|value| value.get("require_identity_correction_reason"))
        .and_then(Value::as_bool)
        .unwrap_or(true))
}
pub fn routes() -> Router<State> {
    Router::new()
        .route("/api/v1/patients/{id}/identity", get(read).put(save))
        .route("/api/v1/patients/{id}/identity/revisions", get(revisions))
}
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
pub(crate) async fn row(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    lock: bool,
) -> Result<Identity> {
    let q = if lock {
        "SELECT id,mrn,given_name,family_name,birth_date,identity_version AS version FROM patients WHERE tenant_id=$1 AND id=$2 FOR UPDATE"
    } else {
        "SELECT id,mrn,given_name,family_name,birth_date,identity_version AS version FROM patients WHERE tenant_id=$1 AND id=$2"
    };
    sqlx::query_as(q)
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
pub(crate) async fn record_initial(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: &Patient,
    reason: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO patient_identity_revisions(tenant_id,patient_id,version,snapshot,actor_id,reason) VALUES($1,$2,1,$3,$4,$5) ON CONFLICT DO NOTHING").bind(a.tenant_id).bind(p.id).bind(json!(p)).bind(a.sub).bind(reason).execute(&mut **tx).await?;
    Ok(())
}
async fn history(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
) -> Result<(Vec<Value>, bool)> {
    let mut h=sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('version',version,'snapshot',snapshot,'actor_id',actor_id,'actor_label',(SELECT coalesce(nullif(u.display_name,''),u.email) FROM browser_users u WHERE u.tenant_id=r.tenant_id AND u.id=r.actor_id),'reason',reason,'created_at',created_at) FROM patient_identity_revisions r WHERE tenant_id=$1 AND patient_id=$2 ORDER BY version DESC LIMIT 101").bind(a.tenant_id).bind(id).fetch_all(&mut **tx).await?;
    let truncated = h.len() > 100;
    h.truncate(100);
    Ok((h, truncated))
}
async fn payload(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: &Identity) -> Result<Value> {
    let (h, truncated) = history(tx, a, p.id).await?;
    let reason_required = reason_required(tx, a).await?;
    Ok(
        json!({"patient":p.patient(),"version":p.version,"can_edit":a.clinical().is_ok(),"reason_required":reason_required,"history":h,"history_truncated":truncated}),
    )
}
pub(crate) async fn read_identity(s: &State, a: &Actor, id: Uuid) -> Result<Identity> {
    a.staff()?;
    let mut tx = db(s)?.begin().await?;
    let p = row(&mut tx, a, id, false).await?;
    audit(&mut tx, a, "patient.identity_read", id).await?;
    tx.commit().await?;
    Ok(p)
}
pub(crate) async fn update(
    s: &State,
    a: &Actor,
    id: Uuid,
    expected: i64,
    input: &Change,
) -> Result<Identity> {
    a.clinical()?;
    let mut tx = db(s)?.begin().await?;
    let require_reason = reason_required(&mut tx, a).await?;
    input.validate(require_reason)?;
    let old = row(&mut tx, a, id, true).await?;
    if old.version != expected {
        return Err(Error::Conflict(
            "patient identity changed; reload before saving",
        ));
    }
    if input.mrn.as_ref().is_some_and(|mrn| mrn != &old.mrn) {
        return Err(Error::Invalid(
            "MRN is system-assigned and cannot be changed",
        ));
    }
    sqlx::query("INSERT INTO patient_identity_revisions(tenant_id,patient_id,version,snapshot,reason) VALUES($1,$2,$3,$4,'Registration identity before first correction') ON CONFLICT DO NOTHING").bind(a.tenant_id).bind(id).bind(old.version).bind(old.patient()).execute(&mut *tx).await?;
    sqlx::query("UPDATE patients SET given_name=$3,family_name=$4,birth_date=$5,identity_version=identity_version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(input.given_name.trim()).bind(input.family_name.trim()).bind(input.birth_date).execute(&mut *tx).await?;
    let p = row(&mut tx, a, id, false).await?;
    let reason = if input.reason.trim().is_empty() {
        "Identity corrected; clinic reason prompt disabled"
    } else {
        input.reason.trim()
    };
    sqlx::query("INSERT INTO patient_identity_revisions(tenant_id,patient_id,version,snapshot,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(p.version).bind(p.patient()).bind(a.sub).bind(reason).execute(&mut *tx).await?;
    audit(&mut tx, a, "patient.identity_save", id).await?;
    tx.commit().await?;
    Ok(p)
}
async fn read(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let p = row(&mut tx, &a, id, false).await?;
    let data = payload(&mut tx, &a, &p).await?;
    audit(&mut tx, &a, "patient.identity_read", id).await?;
    tx.commit().await?;
    Ok(([(header::ETAG, format!("\"{}\"", p.version))], Json(data)).into_response())
}
async fn save(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(input): Json<Change>,
) -> Result<Response> {
    let expected = crate::expected(&h)?;
    update(&s, &a, id, expected, &input).await?;
    read(ExtractState(s), a, Path(id)).await
}
async fn revisions(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    row(&mut tx, &a, id, false).await?;
    let (items, truncated) = history(&mut tx, &a, id).await?;
    audit(&mut tx, &a, "patient.identity_history", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"truncated":truncated})))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(reason: &str) -> Change {
        Change {
            mrn: None,
            given_name: "Ada".into(),
            family_name: "Lovelace".into(),
            birth_date: NaiveDate::from_ymd_opt(1980, 1, 1).unwrap(),
            reason: reason.into(),
        }
    }

    #[test]
    fn reason_policy_requires_reason_by_default() {
        assert!(change("").validate(true).is_err());
        assert!(change("Corrected family name").validate(true).is_ok());
    }

    #[test]
    fn reason_policy_allows_blank_but_not_control_characters_when_disabled() {
        assert!(change("").validate(false).is_ok());
        assert!(change("invalid\nreason").validate(false).is_err());
    }
}
