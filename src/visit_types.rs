// SPDX-License-Identifier: AGPL-3.0-only
//! Practice visit types. A booking records the full version selected by staff.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    model::VisitTypeSelection,
    practice_codes, scheduling, State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::HeaderMap,
    routing::{get, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use std::collections::HashSet;
use uuid::Uuid;

fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn owner(a: &Actor) -> Result<()> {
    if matches!(a.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct ListQuery {
    include_disabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Diagnosis {
    code: String,
    description: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    name: String,
    category: Option<String>,
    duration_minutes: i32,
    #[serde(default = "enabled")]
    enabled: bool,
    #[serde(default)]
    diagnoses: Vec<Diagnosis>,
    #[serde(default)]
    procedures: Vec<practice_codes::BundleLine>,
}
fn enabled() -> bool {
    true
}
fn label(value: &str, max: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}
impl Definition {
    fn normalize(&self) -> Result<Value> {
        let name = self.name.trim();
        let category = self.category.as_deref().unwrap_or(name).trim();
        if !label(name, 80) || !label(category, 100) {
            return Err(Error::Invalid(
                "Give the visit type a name and category within the allowed length.",
            ));
        }
        if !(5..=480).contains(&self.duration_minutes) {
            return Err(Error::Invalid(
                "Choose a visit duration between 5 and 480 minutes.",
            ));
        }
        if self.diagnoses.len() > 12 || self.procedures.len() > 20 {
            return Err(Error::Invalid(
                "A visit type supports up to 12 diagnoses and 20 procedure lines.",
            ));
        }
        let mut unique = HashSet::new();
        let mut diagnoses = Vec::with_capacity(self.diagnoses.len());
        for d in &self.diagnoses {
            let code = crate::terminology::canonical_code("ICD-10-CM", &d.code)?;
            if !unique.insert(code.clone()) {
                return Err(Error::Invalid(
                    "Include a diagnosis only once per visit type.",
                ));
            }
            if !label(d.description.trim(), 1000) {
                return Err(Error::Invalid("Give each diagnosis a description."));
            }
            diagnoses.push(json!({"code":code,"description":d.description.trim()}));
        }
        let procedures = practice_codes::bundle_lines(&self.procedures)?;
        Ok(
            json!({"name":name,"category":category,"duration_minutes":self.duration_minutes,
            "enabled":self.enabled,"diagnoses":diagnoses,"procedures":procedures}),
        )
    }
}

// A practice sees the original scheduling choices until it edits or retires them.
// Reading the defaults never writes records. A practice-saved row overrides only its own default.
const CATALOG:&str="WITH defaults(id,name,minutes) AS (VALUES
    ('7bd107bb-cc52-4370-82b0-f29a28fdc101'::uuid,'Office encounter',30),
    ('7bd107bb-cc52-4370-82b0-f29a28fdc102'::uuid,'New patient',60),
    ('7bd107bb-cc52-4370-82b0-f29a28fdc103'::uuid,'Follow-up',30),
    ('7bd107bb-cc52-4370-82b0-f29a28fdc104'::uuid,'Telehealth',30),
    ('7bd107bb-cc52-4370-82b0-f29a28fdc105'::uuid,'Procedure',30)),
    catalog AS (SELECT id,version,definition FROM practice_visit_types WHERE tenant_id=$1 UNION ALL
    SELECT d.id,1::bigint,jsonb_build_object('name',d.name,'category',d.name,'duration_minutes',d.minutes,
    'enabled',true,'diagnoses','[]'::jsonb,'procedures','[]'::jsonb) FROM defaults d
    WHERE NOT EXISTS(SELECT 1 FROM practice_visit_types t WHERE t.tenant_id=$1 AND t.id=d.id))";
const VIEW: &str = "definition || jsonb_build_object('id',id,'version',version)";
async fn item(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Value> {
    sqlx::query_scalar(&format!("{CATALOG} SELECT {VIEW} FROM catalog WHERE id=$2"))
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
/// Resolve only an explicitly selected active version, under the same scheduling lock as booking.
pub(crate) async fn snapshot(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    selected: Option<&VisitTypeSelection>,
) -> Result<Option<Value>> {
    let Some(selected) = selected else {
        return Ok(None);
    };
    let item = item(tx, a, selected.id).await?;
    if item["enabled"] != true || item["version"] != selected.version {
        return Err(Error::Conflict(
            "The visit type changed or was retired. Refresh and choose its current version.",
        ));
    }
    Ok(Some(item))
}
async fn list(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    if q.include_disabled {
        owner(&a)?;
    }
    let rows:Vec<Value>=sqlx::query_scalar(&format!("{CATALOG} SELECT {VIEW} FROM catalog WHERE $2 OR definition->'enabled'='true'::jsonb ORDER BY lower(definition->>'name'),id"))
        .bind(a.tenant_id).bind(q.include_disabled).fetch_all(db(&s)?).await?;
    Ok(Json(json!({"items":rows})))
}
async fn save(
    s: &State,
    a: &Actor,
    id: Uuid,
    expected: Option<i64>,
    input: Definition,
) -> Result<Json<Value>> {
    owner(a)?;
    let content = input.normalize()?;
    let mut tx = db(s)?.begin().await?;
    scheduling::tenant_lock(&mut tx, a).await?;
    if let Some(version) = expected {
        if item(&mut tx, a, id).await?["version"] != version {
            return Err(Error::Conflict(
                "The visit type changed. Refresh before saving.",
            ));
        }
    }
    if input.enabled {
        let duplicate:bool=sqlx::query_scalar(&format!("{CATALOG} SELECT EXISTS(SELECT 1 FROM catalog WHERE id<>$2 AND definition->'enabled'='true'::jsonb AND lower(definition->>'name')=lower($3))"))
            .bind(a.tenant_id).bind(id).bind(content["name"].as_str()).fetch_one(&mut *tx).await?;
        if duplicate {
            return Err(Error::Conflict(
                "An active visit type already uses that name.",
            ));
        }
    }
    let version = expected
        .unwrap_or(0)
        .checked_add(1)
        .ok_or(Error::Conflict("Visit type version exhausted."))?;
    sqlx::query("INSERT INTO practice_visit_types(tenant_id,id,definition,version,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,id) DO UPDATE SET definition=excluded.definition,version=excluded.version,updated_by=excluded.updated_by,updated_at=now()")
        .bind(a.tenant_id).bind(id).bind(&content).bind(version).bind(a.sub).execute(&mut *tx).await?;
    crate::postgres::audit(
        &mut tx,
        a,
        if expected.is_some() {
            "practice.visit_type.updated"
        } else {
            "practice.visit_type.created"
        },
        id,
    )
    .await?;
    let result = item(&mut tx, a, id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(input): Json<Definition>,
) -> Result<Json<Value>> {
    save(&s, &a, Uuid::new_v4(), None, input).await
}
async fn update(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<Definition>,
) -> Result<Json<Value>> {
    save(&s, &a, id, Some(crate::expected(&headers)?), input).await
}
pub(crate) fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/practice/visit-types", get(list).post(create))
        .route("/api/v1/practice/visit-types/{id}", put(update))
}
