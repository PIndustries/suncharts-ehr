// SPDX-License-Identifier: AGPL-3.0-only
//! Delegated intake, separate from assigned-clinician documentation and signatures.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    model::Visit,
    postgres::{audit, rooming_authorized},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub fn routes() -> Router<State> {
    Router::new().route("/api/v1/visits/{id}/rooming", get(read).put(save))
}
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Intake {
    pub status: String,
    pub chief_complaint: String,
    pub intake_notes: String,
    pub medications_reviewed: bool,
    pub allergies_reviewed: bool,
}
impl Intake {
    fn validate(&self) -> Result<()> {
        if !matches!(self.status.as_str(), "in_progress" | "ready")
            || self.chief_complaint.chars().count() > 2000
            || self.intake_notes.chars().count() > 10000
        {
            return Err(Error::Invalid("invalid rooming status or intake length"));
        }
        if self.status == "ready"
            && (self.chief_complaint.trim().is_empty()
                || !self.medications_reviewed
                || !self.allergies_reviewed)
        {
            return Err(Error::Invalid(
                "ready for clinician requires chief complaint and medication/allergy review",
            ));
        }
        Ok(())
    }
}
async fn visit(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    lock: bool,
) -> Result<Visit> {
    let query = if lock {
        "SELECT * FROM visits WHERE tenant_id=$1 AND id=$2 FOR UPDATE"
    } else {
        "SELECT * FROM visits WHERE tenant_id=$1 AND id=$2"
    };
    sqlx::query_as(query)
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn payload(tx: &mut Transaction<'_, Postgres>, a: &Actor, v: &Visit) -> Result<Value> {
    let mut data: Value = sqlx::query_scalar("SELECT jsonb_build_object('status',status,'chief_complaint',chief_complaint,'intake_notes',intake_notes,'medications_reviewed',medications_reviewed,'allergies_reviewed',allergies_reviewed,'updated_by',updated_by,'updated_at',updated_at) FROM visit_rooming WHERE tenant_id=$1 AND visit_id=$2")
        .bind(a.tenant_id).bind(v.id).fetch_optional(&mut **tx).await?.unwrap_or_else(||json!({"status":"not_started","chief_complaint":"","intake_notes":"","medications_reviewed":false,"allergies_reviewed":false,"updated_by":null,"updated_at":null}));
    let assistant = if matches!(a.role, Role::Nurse | Role::MedicalAssistant) {
        let expected = if matches!(a.role, Role::Nurse) {
            "nurse"
        } else {
            "medical_assistant"
        };
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM browser_users WHERE tenant_id=$1 AND id=$2 AND role=$3 AND NOT disabled)").bind(a.tenant_id).bind(a.sub).bind(expected).fetch_one(&mut **tx).await?
    } else {
        false
    };
    data["can_edit"] = json!(
        v.status == "in_progress"
            && (assistant
                || (matches!(a.role, Role::Owner | Role::Clinician) && a.sub == v.clinician_id))
    );
    data["visit_id"] = json!(v.id);
    data["version"] = json!(v.version);
    data["visit"] = json!(v);
    if let Some(id) = data["updated_by"]
        .as_str()
        .and_then(|raw| Uuid::parse_str(raw).ok())
    {
        data["updated_by_label"] = json!(sqlx::query_scalar::<_, String>("SELECT coalesce(nullif(display_name,''),email) FROM browser_users WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).fetch_optional(&mut **tx).await?);
    }
    data["history"] = json!(sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('id',id,'visit_version',visit_version,'kind',kind,'actor_id',actor_id,'actor_label',(SELECT coalesce(nullif(u.display_name,''),u.email) FROM browser_users u WHERE u.tenant_id=visit_rooming_revisions.tenant_id AND u.id=visit_rooming_revisions.actor_id),'snapshot',snapshot,'created_at',created_at) FROM visit_rooming_revisions WHERE tenant_id=$1 AND visit_id=$2 ORDER BY visit_version DESC LIMIT 100").bind(a.tenant_id).bind(v.id).fetch_all(&mut **tx).await?);
    Ok(data)
}
async fn read(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let v = visit(&mut tx, &a, id, false).await?;
    let data = payload(&mut tx, &a, &v).await?;
    audit(&mut tx, &a, "visit.rooming_read", id).await?;
    tx.commit().await?;
    Ok(Json(data))
}
async fn save(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(input): Json<Intake>,
) -> Result<Json<Value>> {
    a.rooming()?;
    input.validate()?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    let v = visit(&mut tx, &a, id, true).await?;
    rooming_authorized(&mut tx, &a, v.clinician_id).await?;
    if v.version != version {
        return Err(Error::Conflict("visit changed; reload before saving"));
    }
    if v.status != "in_progress" {
        return Err(Error::Conflict("signed intake is immutable"));
    }
    sqlx::query("INSERT INTO visit_rooming(tenant_id,visit_id,status,chief_complaint,intake_notes,medications_reviewed,allergies_reviewed,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,visit_id) DO UPDATE SET status=excluded.status,chief_complaint=excluded.chief_complaint,intake_notes=excluded.intake_notes,medications_reviewed=excluded.medications_reviewed,allergies_reviewed=excluded.allergies_reviewed,updated_by=excluded.updated_by,updated_at=now()")
        .bind(a.tenant_id).bind(id).bind(input.status).bind(input.chief_complaint.trim()).bind(input.intake_notes.trim()).bind(input.medications_reviewed).bind(input.allergies_reviewed).bind(a.sub).execute(&mut *tx).await?;
    sqlx::query("UPDATE visits SET version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let v = visit(&mut tx, &a, id, false).await?;
    let data = payload(&mut tx, &a, &v).await?;
    let snapshot = json!({"status":data["status"],"chief_complaint":data["chief_complaint"],"intake_notes":data["intake_notes"],"medications_reviewed":data["medications_reviewed"],"allergies_reviewed":data["allergies_reviewed"]});
    revision(&mut tx, &a, &v, "intake", snapshot).await?;
    audit(&mut tx, &a, "visit.rooming_save", id).await?;
    let data = payload(&mut tx, &a, &v).await?;
    tx.commit().await?;
    Ok(Json(data))
}
async fn revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    v: &Visit,
    kind: &str,
    snapshot: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO visit_rooming_revisions(tenant_id,id,visit_id,visit_version,kind,actor_id,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(v.id).bind(v.version).bind(kind).bind(a.sub).bind(snapshot).execute(&mut **tx).await?;
    Ok(())
}
pub(crate) async fn record_vitals_revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    v: &Visit,
) -> Result<()> {
    revision(tx, a, v, "vitals", json!({"vitals":v.vitals})).await
}
