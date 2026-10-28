// SPDX-License-Identifier: AGPL-3.0-only
//! Encounter-specific coding; separate from the longitudinal problem list.
use crate::{
    auth::Actor,
    error::{Error, Result},
    model::Visit,
    postgres::audit,
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
use std::collections::HashSet;
use uuid::Uuid;

pub fn routes() -> Router<State> {
    Router::new().route("/api/v1/visits/{id}/diagnoses", get(read).put(save))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Diagnosis {
    code: String,
    display: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    diagnoses: Vec<Diagnosis>,
    reason: String,
}
impl Input {
    fn validate(&mut self) -> Result<()> {
        crate::model::text(&self.reason, 2000)?;
        if self.diagnoses.len() > 20 {
            return Err(Error::Invalid(
                "at most 20 encounter diagnoses are supported",
            ));
        }
        let mut seen = HashSet::new();
        for d in &mut self.diagnoses {
            d.code = d.code.trim().to_ascii_uppercase();
            d.display = d.display.trim().to_string();
            crate::model::text(&d.display, 500)?;
            let b = d.code.as_bytes();
            // Format checking only; this does not validate a code against an edition.
            if !(3..=8).contains(&b.len())
                || !b[0].is_ascii_uppercase()
                || !b[1].is_ascii_digit()
                || !b[2].is_ascii_alphanumeric()
                || (b.len() > 3
                    && (b[3] != b'.'
                        || b.len() == 4
                        || !b[4..].iter().all(u8::is_ascii_alphanumeric)))
            {
                return Err(Error::Invalid(
                    "use an ICD-10-CM code with a decimal after the third character when needed",
                ));
            }
            if !seen.insert(d.code.clone()) {
                return Err(Error::Invalid("duplicate encounter diagnosis code"));
            }
        }
        Ok(())
    }
}
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
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
async fn diagnoses(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Value> {
    Ok(sqlx::query_scalar::<_, Value>(
        "SELECT diagnoses FROM visit_diagnoses WHERE tenant_id=$1 AND visit_id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .unwrap_or_else(|| json!([])))
}
async fn payload(tx: &mut Transaction<'_, Postgres>, a: &Actor, v: &Visit) -> Result<Value> {
    let items = diagnoses(tx, a, v.id).await?;
    let mut history = sqlx::query_scalar::<_, Value>("SELECT jsonb_build_object('id',id,'visit_version',visit_version,'actor_id',actor_id,'actor_label',(SELECT coalesce(nullif(u.display_name,''),u.email) FROM browser_users u WHERE u.tenant_id=visit_diagnosis_revisions.tenant_id AND u.id=visit_diagnosis_revisions.actor_id),'reason',reason,'snapshot',snapshot,'created_at',created_at) FROM visit_diagnosis_revisions WHERE tenant_id=$1 AND visit_id=$2 ORDER BY visit_version DESC LIMIT 101").bind(a.tenant_id).bind(v.id).fetch_all(&mut **tx).await?;
    let truncated = history.len() > 100;
    history.truncate(100);
    Ok(
        json!({"visit":v,"version":v.version,"can_edit":v.status=="in_progress" && a.clinical().is_ok() && a.sub==v.clinician_id,"diagnoses":items,"history":history,"history_truncated":truncated,"code_system":"http://hl7.org/fhir/sid/icd-10-cm"}),
    )
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
    audit(&mut tx, &a, "visit.diagnoses_read", id).await?;
    tx.commit().await?;
    Ok(Json(data))
}
async fn save(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(mut input): Json<Input>,
) -> Result<Json<Value>> {
    a.clinical()?;
    input.validate()?;
    let expected = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    let v = visit(&mut tx, &a, id, true).await?;
    if a.sub != v.clinician_id {
        return Err(Error::Forbidden);
    }
    if expected != v.version {
        return Err(Error::Conflict("visit changed; reload before saving"));
    }
    if v.status != "in_progress" {
        return Err(Error::Conflict(
            "signed encounter diagnoses are immutable; use an attributed amendment",
        ));
    }
    let old = diagnoses(&mut tx, &a, id).await?;
    let items: Vec<Value> = input
        .diagnoses
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let existing = old
                .as_array()
                .and_then(|items| items.iter().find(|item| item["code"] == d.code))
                .and_then(|item| item["id"].as_str())
                .and_then(|id| Uuid::parse_str(id).ok())
                .unwrap_or_else(Uuid::new_v4);
            json!({"id":existing,"code":d.code,"display":d.display,"rank":i+1})
        })
        .collect();
    let items = json!(items);
    sqlx::query("INSERT INTO visit_diagnoses(tenant_id,visit_id,diagnoses,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,visit_id) DO UPDATE SET diagnoses=excluded.diagnoses,updated_by=excluded.updated_by,updated_at=now()")
        .bind(a.tenant_id).bind(id).bind(&items).bind(a.sub).execute(&mut *tx).await?;
    sqlx::query("UPDATE visits SET version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let v = visit(&mut tx, &a, id, false).await?;
    sqlx::query("INSERT INTO visit_diagnosis_revisions(tenant_id,id,visit_id,visit_version,actor_id,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(a.tenant_id).bind(Uuid::new_v4()).bind(id).bind(v.version).bind(a.sub).bind(input.reason.trim()).bind(items).execute(&mut *tx).await?;
    audit(&mut tx, &a, "visit.diagnoses_save", id).await?;
    let data = payload(&mut tx, &a, &v).await?;
    tx.commit().await?;
    Ok(Json(data))
}
