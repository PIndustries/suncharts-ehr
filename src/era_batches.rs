// SPDX-License-Identifier: AGPL-3.0-only
//! Original-file provenance and atomic, source-ordered ERA batch execution.
use crate::{
    auth::Actor,
    billing,
    claims::{self, Match, Remittance},
    era_chains, era_file,
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Acquire, Postgres, Transaction};
use uuid::Uuid;
pub(crate) async fn check_receipt(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    payer: Uuid,
    trace: &str,
) -> Result<()> {
    if sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM era_remittances WHERE tenant_id=$1 AND payer_id=$2 AND trace=$3)").bind(a.tenant_id).bind(payer).bind(trace).fetch_one(&mut **tx).await?{return Err(Error::Conflict("Payer/trace receipt already imported"));}
    Ok(())
}
pub(crate) async fn independent(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
) -> Result<()> {
    if sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM era_batch_items WHERE tenant_id=$1 AND remittance_id=$2)",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_one(&mut **tx)
    .await?
    {
        return Err(Error::Conflict(
            "Use ordered batch actions for this remittance",
        ));
    }
    Ok(())
}
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    reason: &str,
    evidence: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO era_batch_events (tenant_id,batch_id,version,actor_id,reason,evidence) SELECT tenant_id,id,version,$3,$4,$5 FROM era_batches WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(a.sub).bind(reason).bind(evidence).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "remittance.batch_change", id).await
}
async fn items(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Vec<Remittance>> {
    let ids:Vec<Uuid>=sqlx::query_scalar("SELECT remittance_id FROM era_batch_items WHERE tenant_id=$1 AND batch_id=$2 ORDER BY position").bind(a.tenant_id).bind(id).fetch_all(&mut **tx).await?;
    let mut rows = vec![];
    for id in ids {
        rows.push(claims::remit_row(tx, a, id).await?);
    }
    Ok(rows)
}
#[derive(Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Version {
    id: Uuid,
    version: i64,
}
fn versions(rows: &[Remittance]) -> Vec<Version> {
    rows.iter()
        .map(|r| Version {
            id: r.id,
            version: r.version,
        })
        .collect()
}
pub fn router() -> axum::Router<State> {
    axum::Router::new()
        .route("/api/v1/billing/era-batches", get(list).post(import))
        .route("/api/v1/billing/era-batches/preview", post(preview))
        .route("/api/v1/billing/era-batches/{id}", get(detail))
        .route("/api/v1/billing/era-batches/{id}/actions", post(action))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Preview {
    original_text: String,
}
async fn preview(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(v): Json<Preview>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    let parts = era_file::parse(&v.original_text)?;
    let mut tx = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .db
        .begin()
        .await?;
    let payers:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',content->>'name','payer_code',content->>'payer_code') FROM ehr_payers WHERE tenant_id=$1 ORDER BY id LIMIT 500").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "remittance.batch_preview", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"parts":parts,"payers":payers,"original_hash":crate::oauth::hash(&v.original_text)}),
    ))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Import {
    request_id: Uuid,
    original_text: String,
    payer_ids: Vec<Uuid>,
    source_history_id: Option<Uuid>,
    remote_report_id: Option<Uuid>,
    reason: String,
}
async fn import(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(v): Json<Import>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    crate::model::text(&v.reason, 1000)?;
    let parts = era_file::parse(&v.original_text)?;
    if v.payer_ids.len() != parts.len() {
        return Err(Error::Invalid(
            "Select one native payer per transaction in file order",
        ));
    }
    let digest = claims::hash(&v)?;
    let mut tx = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .db
        .begin()
        .await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let old: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,creation_hash FROM era_batches WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((id, hash)) = old {
        if hash != digest {
            return Err(Error::Conflict("Batch request changed"));
        }
        return Ok(Json(json!({"id":id})));
    }
    let mut receipts = std::collections::HashSet::new();
    for (part, payer) in parts.iter().zip(&v.payer_ids) {
        let code: Option<String> = sqlx::query_scalar(
            "SELECT content->>'payer_code' FROM ehr_payers WHERE tenant_id=$1 AND id=$2",
        )
        .bind(a.tenant_id)
        .bind(payer)
        .fetch_optional(&mut *tx)
        .await?;
        if code.as_deref() != Some(part.document.payer_code.as_str()) {
            return Err(Error::Invalid(
                "Native payer must exactly match each transaction payer code",
            ));
        }
        if receipts.insert((*payer, part.document.trace.clone())) {
            check_receipt(&mut tx, &a, *payer, &part.document.trace).await?;
        }
    }
    if let Some(source) = v.source_history_id {
        let mapped:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM era_remittances WHERE tenant_id=$1 AND source_history_id=$2)").bind(a.tenant_id).bind(source).fetch_one(&mut *tx).await?;
        if mapped {
            return Err(Error::Conflict(
                "Source already mapped to an individual remittance",
            ));
        }

        let original:Option<String>=sqlx::query_scalar("SELECT source_data->>'original_text' FROM historical_records WHERE tenant_id=$1 AND id=$2 AND kind='remittance'").bind(a.tenant_id).bind(source).fetch_optional(&mut *tx).await?;
        if original.as_deref() != Some(&v.original_text) {
            return Err(Error::Conflict(
                "Historical batch must retain its exact original file",
            ));
        }
    }
    if let Some(remote) = v.remote_report_id {
        crate::retrieval::verify(&mut tx, &a, remote, "x12_835", &v.original_text, None).await?;
        let usage:String=sqlx::query_scalar("SELECT c.usage FROM edi_remote_reports r JOIN edi_connections c USING(tenant_id,route_key) WHERE r.tenant_id=$1 AND r.id=$2").bind(a.tenant_id).bind(remote).fetch_one(&mut *tx).await?;
        if parts
            .iter()
            .any(|p| p.usage.as_ref().is_some_and(|m| m != &usage))
        {
            return Err(Error::Conflict(
                "Every interchange must match the enrolled route mode",
            ));
        }
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO era_batches (tenant_id,id,request_id,creation_hash,original_text,original_hash,source_history_id) VALUES ($1,$2,$3,$4,$5,$6,$7)").bind(a.tenant_id).bind(id).bind(v.request_id).bind(digest).bind(&v.original_text).bind(crate::oauth::hash(&v.original_text)).bind(v.source_history_id).execute(&mut *tx).await?;
    for (part, payer) in parts.iter().zip(&v.payer_ids) {
        let child = Uuid::new_v4();
        sqlx::query("INSERT INTO era_remittances (tenant_id,id,payer_id,trace,document,original_text,document_hash,request_id,creation_hash,receipt_part) VALUES ($1,$2,$3,$4,$5,$6,$7,$2,$8,$9)").bind(a.tenant_id).bind(child).bind(payer).bind(&part.document.trace).bind(json!(part.document)).bind(&part.original_text).bind(claims::hash(&part.document)?).bind(crate::oauth::hash(&format!("batch:{id}:{}",part.position))).bind(part.position as i32+1).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO era_batch_items (tenant_id,batch_id,position,remittance_id,controls) VALUES ($1,$2,$3,$4,$5)").bind(a.tenant_id).bind(id).bind(part.position as i32).bind(child).bind(json!({"start":part.start,"end":part.end,"interchange_control":part.interchange_control,"group_control":part.group_control,"transaction_control":part.transaction_control,"usage":part.usage})).execute(&mut *tx).await?;
        claims::remit_revision(&mut tx, &a, child, &v.reason).await?;
    }
    if let Some(remote) = v.remote_report_id {
        crate::retrieval::link(&mut tx, &a, remote, "remittance_batch", id, &v.reason).await?;
    }
    event(
        &mut tx,
        &a,
        id,
        &v.reason,
        json!({"action":"import","transaction_count":parts.len(),"ledger_posting":false}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id})))
}
async fn list(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .db
        .begin()
        .await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(b)-'tenant_id'-'original_text'-'creation_hash'-'reviewed_versions' || jsonb_build_object('transaction_count',(SELECT count(*) FROM era_batch_items i WHERE i.tenant_id=b.tenant_id AND i.batch_id=b.id)) FROM era_batches b WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 100").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "remittance.batches_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":rows})))
}
async fn detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .db
        .begin()
        .await?;
    let batch:Value=sqlx::query_scalar("SELECT to_jsonb(b)-'tenant_id'-'creation_hash' FROM era_batches b WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let controls:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('position',position,'remittance_id',remittance_id,'controls',controls) FROM era_batch_items WHERE tenant_id=$1 AND batch_id=$2 ORDER BY position").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let rows = items(&mut tx, &a, id).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id' FROM era_batch_events e WHERE tenant_id=$1 AND batch_id=$2 ORDER BY version DESC LIMIT 100").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "remittance.batch_read", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"batch":batch,"items":rows,"controls":controls,"versions":versions(&rows),"events":events}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    action: String,
    reason: String,
    versions: Vec<Version>,
}
async fn execute(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    rows: &[Remittance],
    reason: &str,
) -> Result<Vec<Value>> {
    let mut base = Default::default();
    for r in rows {
        if !["staged", "reconciled"].contains(&r.status.as_str()) {
            return Err(Error::Conflict("Batch children changed lifecycle"));
        }
        let matches: Vec<Match> = serde_json::from_value(r.matches.clone())
            .map_err(|_| Error::Invalid("invalid stored matches"))?;
        let issues = era_chains::plan(tx, a, r, &matches, &mut base, reason).await?;
        if !issues.is_empty() {
            return Ok(vec![json!({"remittance_id":r.id,"issues":issues})]);
        }
        let doc = serde_json::from_value(r.document.clone())
            .map_err(|_| Error::Invalid("invalid stored document"))?;
        crate::settlements::post_entries(tx, a, r, &doc, reason).await?;
        sqlx::query("UPDATE era_remittances SET status='posted',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(r.id).execute(&mut **tx).await?;
        claims::remit_revision(tx, a, r.id, reason).await?;
    }
    Ok(vec![])
}
async fn action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Action>,
) -> Result<Json<Value>> {
    a.scheduling()?;
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
    let old: Option<(String, i64, Option<Value>)> = sqlx::query_as(
        "SELECT status,version,reviewed_versions FROM era_batches WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (status, current, reviewed) = old.ok_or(Error::NotFound)?;
    let rows = items(&mut tx, &a, id).await?;
    if version != current || v.versions != versions(&rows) {
        return Err(Error::Conflict(
            "Batch or child versions changed; reload all transactions",
        ));
    }
    let mut issues = vec![];
    let next = match v.action.as_str() {
        "reconcile" if ["staged", "reviewed"].contains(&status.as_str()) => {
            let mut shadow = tx.begin().await?;
            let result = execute(&mut shadow, &a, &rows, &v.reason).await;
            shadow.rollback().await?;
            issues = result?;
            if issues.is_empty() {
                for r in &rows {
                    sqlx::query("UPDATE era_remittances SET status='reconciled',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(r.id).execute(&mut *tx).await?;
                    claims::remit_revision(&mut tx, &a, r.id, &v.reason).await?;
                }
                let reviewed = versions(&items(&mut tx, &a, id).await?);
                sqlx::query(
                    "UPDATE era_batches SET reviewed_versions=$3 WHERE tenant_id=$1 AND id=$2",
                )
                .bind(a.tenant_id)
                .bind(id)
                .bind(json!(reviewed))
                .execute(&mut *tx)
                .await?;
                "reviewed"
            } else {
                "staged"
            }
        }
        "post" if status == "reviewed" => {
            if reviewed != Some(json!(v.versions)) || rows.iter().any(|r| r.status != "reconciled")
            {
                return Err(Error::Conflict(
                    "Reconcile the entire current batch before posting",
                ));
            }
            issues = execute(&mut tx, &a, &rows, &v.reason).await?;
            if !issues.is_empty() {
                return Err(Error::Conflict("Ordered batch no longer reconciles"));
            }
            "posted"
        }
        "reverse" if status == "posted" => {
            for r in rows.iter().rev() {
                if r.status != "posted" {
                    return Err(Error::Conflict("Batch child lifecycle changed"));
                }
                era_chains::reverse(&mut tx, &a, r, &v.reason).await?;
                sqlx::query("UPDATE era_remittances SET status='reversed',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(r.id).execute(&mut *tx).await?;
                claims::remit_revision(&mut tx, &a, r.id, &v.reason).await?;
            }
            "reversed"
        }
        _ => return Err(Error::Conflict("Unsupported batch lifecycle action")),
    };
    sqlx::query("UPDATE era_batches SET status=$3,version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .bind(next)
        .execute(&mut *tx)
        .await?;
    event(
        &mut tx,
        &a,
        id,
        &v.reason,
        json!({"action":v.action,"status":next,"issues":issues}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"status":next,"version":version+1,"issues":issues}),
    ))
}
