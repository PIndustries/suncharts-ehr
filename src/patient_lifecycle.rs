// SPDX-License-Identifier: AGPL-3.0-only
//! Recoverable patient archive/restore; existing records are never deleted.
use crate::{
    auth::Actor,
    error::{Error, Result},
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
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatientStatus {
    #[default]
    Active,
    Archived,
    All,
}
impl PatientStatus {
    pub(crate) fn archived(self) -> Option<bool> {
        match self {
            Self::Active => Some(false),
            Self::Archived => Some(true),
            Self::All => None,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    archived: bool,
    reason: String,
}
pub fn routes() -> Router<State> {
    Router::new().route("/api/v1/patients/{id}/lifecycle", get(read).put(save))
}
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
async fn current(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<(i64, bool)> {
    Ok(sqlx::query_as("SELECT version,archived FROM patient_lifecycle_events WHERE tenant_id=$1 AND patient_id=$2 ORDER BY version DESC LIMIT 1")
        .bind(a.tenant_id).bind(id).fetch_optional(&mut **tx).await?.unwrap_or((1,false)))
}
async fn patient_lock(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    exclusive: bool,
) -> Result<()> {
    let sql = if exclusive {
        "SELECT id FROM patients WHERE tenant_id=$1 AND id=$2 FOR UPDATE"
    } else {
        "SELECT id FROM patients WHERE tenant_id=$1 AND id=$2 FOR SHARE"
    };
    sqlx::query_scalar::<_, Uuid>(sql)
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)?;
    Ok(())
}
/// Hold the patient lock until new work commits so it cannot race an archive.
/// Existing records and successful idempotent retries remain readable.
pub(crate) async fn require_active(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
) -> Result<()> {
    patient_lock(tx, a, id, false).await?;
    if current(tx, a, id).await?.1 {
        return Err(Error::Conflict(
            "patient is archived; restore the chart before starting new appointments or encounters",
        ));
    }
    Ok(())
}
async fn can_manage(s: &State, a: &Actor) -> Result<bool> {
    if a.scheduling().is_err() {
        return Ok(false);
    }
    match crate::access_policies::require_native(s, a, "clinical", "edit").await {
        Ok(()) => Ok(true),
        Err(Error::Forbidden) => Ok(false),
        Err(e) => Err(e),
    }
}
async fn payload(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    can_manage: bool,
) -> Result<Value> {
    let (version, archived) = current(tx, a, id).await?;
    let mut history=sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('version',version,'archived',archived,'reason',reason,'actor_id',actor_id,'actor_label',(SELECT coalesce(nullif(u.display_name,''),u.email) FROM browser_users u WHERE u.tenant_id=e.tenant_id AND u.id=e.actor_id),'created_at',created_at) FROM patient_lifecycle_events e WHERE tenant_id=$1 AND patient_id=$2 ORDER BY version DESC LIMIT 101").bind(a.tenant_id).bind(id).fetch_all(&mut **tx).await?;
    let truncated = history.len() > 100;
    history.truncate(100);
    Ok(
        json!({"patient_id":id,"version":version,"archived":archived,"can_manage":can_manage,"history":history,"history_truncated":truncated}),
    )
}
fn reply(data: Value) -> Response {
    (
        [
            (header::ETAG, format!("\"{}\"", data["version"])),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
        Json(data),
    )
        .into_response()
}
async fn read(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    a.staff()?;
    let allowed = can_manage(&s, &a).await?;
    let mut tx = db(&s)?.begin().await?;
    patient_lock(&mut tx, &a, id, false).await?;
    let data = payload(&mut tx, &a, id, allowed).await?;
    audit(&mut tx, &a, "patient.lifecycle_read", id).await?;
    tx.commit().await?;
    Ok(reply(data))
}
async fn save(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<Change>,
) -> Result<Response> {
    a.scheduling()?;
    crate::access_policies::require_native(&s, &a, "clinical", "edit").await?;
    let expected = crate::expected(&headers)?;
    crate::model::text(&input.reason, 1000)?;
    if input.reason.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "archive or restore reason contains control characters",
        ));
    }
    let mut tx = db(&s)?.begin().await?;
    patient_lock(&mut tx, &a, id, true).await?;
    let (version, archived) = current(&mut tx, &a, id).await?;
    if version != expected {
        return Err(Error::Conflict(
            "patient archive status changed; reload before continuing",
        ));
    }
    if archived == input.archived {
        return Err(Error::Conflict("patient already has this archive status"));
    }
    sqlx::query("INSERT INTO patient_lifecycle_events(tenant_id,patient_id,version,archived,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(version+1).bind(input.archived).bind(input.reason.trim()).bind(a.sub).execute(&mut *tx).await?;
    audit(
        &mut tx,
        &a,
        if input.archived {
            "patient.archived"
        } else {
            "patient.restored"
        },
        id,
    )
    .await?;
    let data = payload(&mut tx, &a, id, true).await?;
    tx.commit().await?;
    Ok(reply(data))
}
