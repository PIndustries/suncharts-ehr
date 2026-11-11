// SPDX-License-Identifier: AGPL-3.0-only
//! Owner-reviewed billing identity; tax IDs are encrypted and never returned.
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
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
use zeroize::Zeroizing;
const PURPOSE: &str = "billing-organization-tax";
const VIEW: &str = "jsonb_build_object('id',id,'name',name,'tax_id_type',tax_id_type,'tax_id_last4',tax_id_last4,'active',active,'version',version)";
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::Unauthorized)?.db)
}
fn reply(v: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response()
}
fn bounded(v: &str, max: usize) -> bool {
    !v.trim().is_empty() && v.chars().count() <= max && !v.chars().any(char::is_control)
}
pub(crate) fn valid_tax_id(v: &str) -> bool {
    v.len() == 9 && v.bytes().all(|b| b.is_ascii_digit())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    request_id: Option<Uuid>,
    name: String,
    tax_id: Option<String>,
    tax_id_type: String,
    active: bool,
    reason: String,
}
async fn snapshot(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Value> {
    sqlx::query_scalar(&format!(
        "SELECT {VIEW} FROM practice_billing_organizations WHERE tenant_id=$1 AND id=$2"
    ))
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::NotFound)
}
pub(crate) async fn choices(pool: &PgPool, tenant: Uuid) -> Result<Vec<Value>> {
    Ok(sqlx::query_scalar(&format!("SELECT {VIEW} FROM practice_billing_organizations WHERE tenant_id=$1 AND active ORDER BY name,id LIMIT 100"))
 .bind(tenant).fetch_all(pool).await?)
}
async fn list(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Response> {
    let a = crate::practice_admin::owner(&s, &h, false).await?;
    let mut tx = crate::practice_admin::locked(&s, &a, &h).await?;
    let items:Vec<Value>=sqlx::query_scalar(&format!("SELECT {VIEW} FROM practice_billing_organizations WHERE tenant_id=$1 ORDER BY name,id LIMIT 100"))
 .bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(
        &mut tx,
        &a,
        "practice.billing_organizations.read",
        a.tenant_id,
    )
    .await?;
    tx.commit().await?;
    Ok(reply(json!({"items":items})))
}
async fn history(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let a = crate::practice_admin::owner(&s, &h, false).await?;
    let mut tx = crate::practice_admin::locked(&s, &a, &h).await?;
    snapshot(&mut tx, &a, id).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('version',version,'actor_id',actor_id,'reason',reason,'content',content,'created_at',created_at) FROM practice_billing_organization_history WHERE tenant_id=$1 AND organization_id=$2 ORDER BY version DESC LIMIT 100")
 .bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(
        &mut tx,
        &a,
        "practice.billing_organization.history_read",
        id,
    )
    .await?;
    tx.commit().await?;
    Ok(reply(json!({"items":items})))
}
async fn create(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<Save>,
) -> Result<Response> {
    save(&s, &h, None, v).await
}
async fn update(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(v): Json<Save>,
) -> Result<Response> {
    save(&s, &h, Some(id), v).await
}
async fn save(s: &State, h: &HeaderMap, id: Option<Uuid>, mut v: Save) -> Result<Response> {
    let a = crate::practice_admin::owner(s, h, true).await?;
    if !bounded(&v.name, 200)
        || !bounded(&v.reason, 1000)
        || !["E", "S"].contains(&v.tax_id_type.as_str())
    {
        return Err(Error::Invalid(
            "billing organization name, tax ID type and change reason are required",
        ));
    }
    let tax = v.tax_id.take().map(Zeroizing::new);
    if tax.as_ref().is_some_and(|t| !valid_tax_id(t)) {
        return Err(Error::Invalid("tax ID must contain exactly nine digits"));
    }
    let creating = id.is_none();
    let id = id
        .or(v.request_id)
        .ok_or(Error::Invalid("request ID is required"))?;
    if !creating && v.request_id.is_some() {
        return Err(Error::Invalid("request ID is only used for creation"));
    }
    if creating && tax.is_none() {
        return Err(Error::Invalid("actual billing tax ID is required"));
    }
    let expected = if creating {
        None
    } else {
        Some(crate::practice_admin::version(h)?)
    };
    let encrypted = if let Some(t) = &tax {
        Some(crate::provider_settings::seal_secret(db(s)?, a.tenant_id, id, PURPOSE, t).await?)
    } else {
        None
    };
    let mut tx = crate::practice_admin::locked(s, &a, h).await?;
    let old:Option<(String,String,Vec<u8>,bool,i64)>=sqlx::query_as("SELECT name,tax_id_type,encrypted_tax_id,active,version FROM practice_billing_organizations WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
 .bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
    if creating {
        if let Some((name, kind, cipher, active, version)) = old {
            let existing =
                crate::provider_settings::open_secret(a.tenant_id, id, PURPOSE, &cipher)?;
            if version != 1
                || name != v.name.trim()
                || kind != v.tax_id_type
                || active != v.active
                || tax.as_ref().is_none_or(|t| existing.expose() != t.as_str())
            {
                return Err(Error::Conflict(
                    "billing organization request ID was already used",
                ));
            }
            let result = snapshot(&mut tx, &a, id).await?;
            tx.commit().await?;
            return Ok(reply(result));
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM practice_billing_organizations WHERE tenant_id=$1",
        )
        .bind(a.tenant_id)
        .fetch_one(&mut *tx)
        .await?;
        if count >= 100 {
            return Err(Error::Invalid(
                "billing organization directory limit reached",
            ));
        }
        let t = tax.as_ref().ok_or(Error::Invalid("tax ID is required"))?;
        sqlx::query("INSERT INTO practice_billing_organizations(tenant_id,id,name,tax_id_type,encrypted_tax_id,tax_id_last4,active) VALUES($1,$2,$3,$4,$5,$6,$7)")
  .bind(a.tenant_id).bind(id).bind(v.name.trim()).bind(&v.tax_id_type).bind(encrypted).bind(&t[5..]).bind(v.active).execute(&mut *tx).await?;
    } else {
        let (_, old_type, _, _, version) = old.ok_or(Error::NotFound)?;
        if Some(version) != expected {
            return Err(Error::Conflict(
                "billing organization changed; reload before saving",
            ));
        }
        if old_type != v.tax_id_type && tax.is_none() {
            return Err(Error::Invalid(
                "enter the actual tax ID when changing its type",
            ));
        }
        sqlx::query("UPDATE practice_billing_organizations SET name=$3,tax_id_type=$4,active=$5,encrypted_tax_id=COALESCE($6,encrypted_tax_id),tax_id_last4=COALESCE($7,tax_id_last4),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2")
  .bind(a.tenant_id).bind(id).bind(v.name.trim()).bind(&v.tax_id_type).bind(v.active).bind(encrypted).bind(tax.as_ref().map(|t|&t[5..])).execute(&mut *tx).await?;
    }
    let result = snapshot(&mut tx, &a, id).await?;
    sqlx::query("INSERT INTO practice_billing_organization_history(tenant_id,organization_id,version,actor_id,reason,content) VALUES($1,$2,$3,$4,$5,$6)")
 .bind(a.tenant_id).bind(id).bind(result["version"].as_i64().unwrap_or(0)).bind(a.sub).bind(v.reason.trim()).bind(&result).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "practice.billing_organization.write", id).await?;
    tx.commit().await?;
    Ok(reply(result))
}
pub(crate) async fn resolve(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    id: Uuid,
    version: i64,
) -> Result<(String, String, crate::provider_settings::Secret)> {
    let row:Option<(String,String,Vec<u8>,i64)>=sqlx::query_as("SELECT name,tax_id_type,encrypted_tax_id,version FROM practice_billing_organizations WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE")
 .bind(tenant).bind(id).fetch_optional(&mut **tx).await?;
    let (name, kind, cipher, current) = row.ok_or(Error::Invalid(
        "select an active billing organization from Practice administration",
    ))?;
    if current != version {
        return Err(Error::Conflict(
            "billing organization changed; reload and review the selection",
        ));
    }
    Ok((
        name,
        kind,
        crate::provider_settings::open_secret(tenant, id, PURPOSE, &cipher)?,
    ))
}
pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/practice/billing-organizations",
            get(list).post(create),
        )
        .route(
            "/api/v1/practice/billing-organizations/{id}",
            axum::routing::put(update),
        )
        .route(
            "/api/v1/practice/billing-organizations/{id}/history",
            get(history),
        )
}
