// SPDX-License-Identifier: AGPL-3.0-only
//! Independent Claim.MD ERA discovery and opt-in staging. No automatic ledger posting.
use crate::{
    auth::Actor,
    billing,
    delivery::{Adapter, Config},
    error::{Error, Result},
    retrieval, State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Acquire, PgPool, Postgres, Transaction};
use uuid::Uuid;
fn routes(c: &Config) -> Value {
    json!(c.routes.iter().filter(|r|r.adapter==Adapter::ClaimMd && r.retrieval.is_some()).map(|r|json!({"tenant_id":r.tenant_id,"route_key":r.key,"binding_hash":retrieval::binding(r)})).collect::<Vec<_>>())
}
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    key: &str,
    reason: &str,
    evidence: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO edi_era_feed_events (tenant_id,route_key,version,actor_id,reason,evidence) SELECT tenant_id,route_key,version,$3,$4,$5 FROM edi_era_feeds WHERE tenant_id=$1 AND route_key=$2").bind(a.tenant_id).bind(key).bind(a.sub).bind(reason).bind(evidence).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "edi.era_feed_change", a.tenant_id).await
}
async fn sync(pool: &PgPool, c: &Config) -> Result<()> {
    retrieval::sync(pool, c).await?;
    for r in c
        .routes
        .iter()
        .filter(|r| r.adapter == Adapter::ClaimMd && r.retrieval.is_some())
    {
        let a = crate::delivery::worker(r.tenant_id);
        let mut tx = pool.begin().await?;
        billing::tenant_lock(&mut tx, &a).await?;
        let n=sqlx::query("INSERT INTO edi_era_feeds (tenant_id,route_key) SELECT tenant_id,route_key FROM edi_connections WHERE tenant_id=$1 AND route_key=$2 ON CONFLICT DO NOTHING").bind(a.tenant_id).bind(&r.key).execute(&mut *tx).await?.rows_affected();
        if n > 0 {
            event(
                &mut tx,
                &a,
                &r.key,
                "Independent ERA cursor initialized; automatic staging disabled",
                json!({"ledger_posting":false}),
            )
            .await?;
        }
        tx.commit().await?;
    }
    Ok(())
}
pub async fn poll_one(pool: &PgPool, c: &Config) -> Result<bool> {
    sync(pool, c).await?;
    let candidate:Option<(Uuid,String)>=sqlx::query_as("SELECT f.tenant_id,f.route_key FROM edi_era_feeds f JOIN edi_connections conn USING(tenant_id,route_key) JOIN jsonb_to_recordset($1) cfg(tenant_id uuid,route_key text,binding_hash text) ON cfg.tenant_id=conn.tenant_id AND cfg.route_key=conn.route_key AND cfg.binding_hash=conn.binding_hash WHERE NOT conn.paused AND f.next_poll_at<=now() AND (f.lease_until IS NULL OR f.lease_until<now()) ORDER BY f.next_poll_at,f.route_key LIMIT 1").bind(routes(c)).fetch_optional(pool).await?;
    let Some((tenant, key)) = candidate else {
        return Ok(false);
    };
    let a = crate::delivery::worker(tenant);
    let r = c.route(tenant, &key).ok_or(Error::NotFound)?;
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let cursor:Option<String>=sqlx::query_scalar("SELECT f.cursor_id FROM edi_era_feeds f JOIN edi_connections conn USING(tenant_id,route_key) WHERE f.tenant_id=$1 AND f.route_key=$2 AND NOT conn.paused AND conn.binding_hash=$3 AND f.next_poll_at<=now() AND (f.lease_until IS NULL OR f.lease_until<now())").bind(tenant).bind(&key).bind(retrieval::binding(r)).fetch_optional(&mut *tx).await?;
    let Some(cursor) = cursor else {
        return Ok(false);
    };
    let lease = Uuid::new_v4();
    sqlx::query("UPDATE edi_era_feeds SET lease_id=$3,lease_until=now()+interval '60 seconds',version=version+1 WHERE tenant_id=$1 AND route_key=$2").bind(tenant).bind(&key).bind(lease).execute(&mut *tx).await?;
    event(
        &mut tx,
        &a,
        &key,
        "ERA discovery leased",
        json!({"cursor_advanced":false}),
    )
    .await?;
    tx.commit().await?;
    let result = crate::claimmd::era_page(r, &cursor).await;
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let current:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edi_era_feeds WHERE tenant_id=$1 AND route_key=$2 AND lease_id=$3)").bind(tenant).bind(&key).bind(lease).fetch_one(&mut *tx).await?;
    if !current {
        return Ok(true);
    }
    let ok = result.is_ok();
    if let Ok(page) = result {
        for item in &page.items {
            retrieval::insert_observation(&mut tx, &a, &key, item).await?;
        }
        sqlx::query("UPDATE edi_era_feeds SET cursor_id=$3,pages=pages+1,last_success_at=now() WHERE tenant_id=$1 AND route_key=$2").bind(tenant).bind(&key).bind(page.next).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE edi_era_feeds SET lease_id=NULL,lease_until=NULL,next_poll_at=now()+make_interval(secs=>$3),last_result=$4,version=version+1 WHERE tenant_id=$1 AND route_key=$2").bind(tenant).bind(&key).bind(r.retrieval.as_ref().unwrap().interval_seconds as f64).bind(if ok{"era_page_persisted"}else{"era_poll_failed_cursor_retained"}).execute(&mut *tx).await?;
    event(
        &mut tx,
        &a,
        &key,
        "ERA discovery completed",
        json!({"cursor_advanced":ok}),
    )
    .await?;
    tx.commit().await?;
    Ok(true)
}
pub async fn stage_one(pool: &PgPool, c: &Config) -> Result<bool> {
    let candidate:Option<(Uuid,Uuid)>=sqlx::query_as("SELECT r.tenant_id,r.id FROM edi_remote_reports r JOIN edi_connections conn USING(tenant_id,route_key) JOIN edi_era_feeds f USING(tenant_id,route_key) JOIN jsonb_to_recordset($1) cfg(tenant_id uuid,route_key text,binding_hash text) ON cfg.tenant_id=conn.tenant_id AND cfg.route_key=conn.route_key AND cfg.binding_hash=conn.binding_hash WHERE NOT conn.paused AND f.auto_stage AND r.status='retrieved' AND r.format='x12_835' AND r.metadata->>'source'='claimmd_era_api' AND r.native_id IS NULL AND NOT EXISTS(SELECT 1 FROM edi_era_automation j WHERE j.tenant_id=r.tenant_id AND j.report_id=r.id) ORDER BY r.received_at,r.id LIMIT 1").bind(routes(c)).fetch_optional(pool).await?;
    let Some((tenant, id)) = candidate else {
        return Ok(false);
    };
    let a = crate::delivery::worker(tenant);
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let row:Option<(String,Value)>=sqlx::query_as("SELECT r.original_text,r.metadata FROM edi_remote_reports r JOIN edi_connections conn USING(tenant_id,route_key) JOIN edi_era_feeds f USING(tenant_id,route_key) WHERE r.tenant_id=$1 AND r.id=$2 AND NOT conn.paused AND f.auto_stage AND r.native_id IS NULL AND r.status='retrieved' AND NOT EXISTS(SELECT 1 FROM edi_era_automation j WHERE j.tenant_id=r.tenant_id AND j.report_id=r.id)").bind(tenant).bind(id).fetch_optional(&mut *tx).await?;
    let Some((raw, metadata)) = row else {
        return Ok(false);
    };
    let mut stage = tx.begin().await?;
    let (native, issues) =
        match crate::claims::stage_provider_era(&mut stage, &a, id, &raw, &metadata).await {
            Ok((native, issues)) => {
                stage.commit().await?;
                (Some(native), issues)
            }
            Err(Error::Invalid(m) | Error::Conflict(m)) => {
                stage.rollback().await?;
                (None, vec![m.into()])
            }
            Err(e) => return Err(e),
        };
    sqlx::query("INSERT INTO edi_era_automation (tenant_id,report_id,status,remittance_id,issues) VALUES ($1,$2,$3,$4,$5)").bind(tenant).bind(id).bind(if native.is_some(){"staged"}else{"held"}).bind(native).bind(json!(issues)).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.era_automated_stage", id).await?;
    tx.commit().await?;
    Ok(true)
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/billing/era-automation", get(worklist))
        .route("/api/v1/billing/era-automation/{key}/actions", post(action))
}
async fn worklist(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .db
        .begin()
        .await?;
    let feeds:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(f)-'tenant_id'-'cursor_id'-'lease_id' || jsonb_build_object('paused',c.paused,'cursor_saved',f.pages>0) FROM edi_era_feeds f JOIN edi_connections c USING(tenant_id,route_key) WHERE f.tenant_id=$1 ORDER BY route_key LIMIT 100").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(j)-'tenant_id' || jsonb_build_object('route_key',r.route_key,'remote_id',r.remote_id,'remittance_status',e.status,'remittance_version',e.version) FROM edi_era_automation j JOIN edi_remote_reports r ON r.tenant_id=j.tenant_id AND r.id=j.report_id LEFT JOIN era_remittances e ON e.tenant_id=j.tenant_id AND e.id=j.remittance_id WHERE j.tenant_id=$1 ORDER BY j.created_at DESC,j.report_id LIMIT 100").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id' FROM edi_era_feed_events e WHERE tenant_id=$1 ORDER BY created_at DESC,route_key,version DESC LIMIT 100").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.era_automation_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"feeds":feeds,"items":items,"events":events,"ledger_posting":"staff_review_required"}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    action: String,
    reason: String,
}
async fn action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(key): Path<String>,
    h: HeaderMap,
    Json(v): Json<Decision>,
) -> Result<Json<Value>> {
    if !matches!(a.role, crate::auth::Role::Owner) {
        return Err(Error::Forbidden);
    }
    crate::model::text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    let mut tx = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .db
        .begin()
        .await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let old: Option<i64> =
        sqlx::query_scalar("SELECT version FROM edi_era_feeds WHERE tenant_id=$1 AND route_key=$2")
            .bind(a.tenant_id)
            .bind(&key)
            .fetch_optional(&mut *tx)
            .await?;
    if old != Some(version) {
        return Err(Error::Conflict("ERA feed changed; reload before action"));
    }
    match v.action.as_str() {
        "enable_staging" | "disable_staging" => {
            sqlx::query("UPDATE edi_era_feeds SET auto_stage=$3,version=version+1 WHERE tenant_id=$1 AND route_key=$2").bind(a.tenant_id).bind(&key).bind(v.action=="enable_staging").execute(&mut *tx).await?;
        }
        "poll_now" => {
            sqlx::query("UPDATE edi_era_feeds SET next_poll_at=now(),version=version+1 WHERE tenant_id=$1 AND route_key=$2").bind(a.tenant_id).bind(&key).execute(&mut *tx).await?;
        }
        _ => return Err(Error::Invalid("unsupported ERA automation action")),
    }
    event(
        &mut tx,
        &a,
        &key,
        &v.reason,
        json!({"action":v.action,"ledger_posting":false}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"recorded":true})))
}
