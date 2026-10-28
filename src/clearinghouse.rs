// SPDX-License-Identifier: AGPL-3.0-only
//! Durable manual-file clearinghouse boundary. No credentials or outbound network transport.
use crate::{
    auth::{Actor, Role},
    billing, claims,
    error::{Error, Result},
    model::text,
    x12::{self, Details, PartnerContent},
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::{header, HeaderMap},
    routing::{get, post},
    Json, Router,
};
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
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
fn digest<T: Serialize>(v: &T) -> Result<String> {
    Ok(crate::oauth::hash(
        &serde_json::to_string(v).map_err(|_| Error::Invalid("invalid EDI request"))?,
    ))
}
#[derive(Clone, Serialize, sqlx::FromRow)]
pub(crate) struct Partner {
    pub(crate) id: Uuid,
    pub(crate) content: Value,
    pub(crate) version: i64,
    pub(crate) source_history_id: Option<Uuid>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NewPartner {
    request_id: Uuid,
    source_history_id: Option<Uuid>,
    content: PartnerContent,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditPartner {
    content: PartnerContent,
    reason: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Generate {
    request_id: Uuid,
    partner_id: Uuid,
    partner_version: i64,
    details: Details,
    reason: String,
}
#[derive(Clone, Serialize, sqlx::FromRow)]
pub(crate) struct Submission {
    pub(crate) id: Uuid,
    pub(crate) claim_id: Uuid,
    pub(crate) partner_id: Uuid,
    pub(crate) claim_version: i64,
    pub(crate) partner_version: i64,
    pub(crate) claim_snapshot: Value,
    pub(crate) partner_snapshot: Value,
    pub(crate) details: Value,
    pub(crate) payload: String,
    pub(crate) payload_hash: String,
    pub(crate) interchange_control: String,
    pub(crate) group_control: String,
    pub(crate) transaction_control: String,
    pub(crate) status: String,
    pub(crate) technical_status: String,
    pub(crate) payer_outcome: String,
    pub(crate) version: i64,
    pub(crate) delivered_claim_version: Option<i64>,
}
#[derive(Deserialize)]
struct Page {
    after: Option<Uuid>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Action {
    action: String,
    reason: String,
    #[serde(default)]
    reference: String,
    event_date: Option<NaiveDate>,
    claim_version: Option<i64>,
    #[serde(default)]
    payer_control_number: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ack {
    remote_report_id: Option<Uuid>,
    format: String,
    original_text: String,
    source_history_id: Option<Uuid>,
    reason: String,
}
pub(crate) async fn partner(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
) -> Result<Partner> {
    sqlx::query_as("SELECT * FROM edi_partners WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
pub(crate) async fn submission(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
) -> Result<Submission> {
    sqlx::query_as("SELECT * FROM edi_submissions WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn source(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid, kind: &str) -> Result<()> {
    let ok:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM historical_records WHERE tenant_id=$1 AND id=$2 AND kind=$3 AND patient_id IS NULL)").bind(a.tenant_id).bind(id).bind(kind).fetch_one(&mut **tx).await?;
    if ok {
        Ok(())
    } else {
        Err(Error::NotFound)
    }
}
async fn partner_revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    reason: &str,
) -> Result<Partner> {
    let p = partner(tx, a, id).await?;
    sqlx::query("INSERT INTO edi_partner_revisions (tenant_id,partner_id,version,snapshot,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(p.version).bind(json!(p)).bind(a.sub).bind(reason).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "edi.partner_change", id).await?;
    Ok(p)
}
pub(crate) async fn event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    reason: &str,
    evidence: Value,
) -> Result<Submission> {
    let s = submission(tx, a, id).await?;
    sqlx::query("INSERT INTO edi_submission_events (tenant_id,submission_id,version,actor_id,reason,evidence) VALUES ($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(s.version).bind(a.sub).bind(reason).bind(evidence).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "edi.submission_change", id).await?;
    Ok(s)
}
pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/billing/clearinghouses",
            get(partners).post(new_partner),
        )
        .route(
            "/api/v1/billing/clearinghouses/{id}",
            get(read_partner).put(edit_partner),
        )
        .route("/api/v1/billing/clearinghouse-sources", get(sources))
        .route("/api/v1/billing/claims/{id}/837p", post(generate))
        .route("/api/v1/billing/submissions", get(worklist))
        .route("/api/v1/billing/submissions/{id}", get(detail))
        .route("/api/v1/billing/submissions/{id}/file", get(download))
        .route("/api/v1/billing/submissions/{id}/actions", post(action))
        .route(
            "/api/v1/billing/submissions/{id}/acknowledgments",
            post(acknowledge),
        )
}
async fn partners(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let items: Vec<Partner> =
        sqlx::query_as("SELECT * FROM edi_partners WHERE tenant_id=$1 ORDER BY id LIMIT 101")
            .bind(a.tenant_id)
            .fetch_all(&mut *tx)
            .await?;
    if items.len() > 100 {
        return Err(Error::Invalid("partner directory exceeds preview limit"));
    }
    crate::postgres::audit(&mut tx, &a, "edi.partner_directory", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":items,"transport":transport(db(&s)?, a.tenant_id).await?.0,"network_sender_configured":transport(db(&s)?, a.tenant_id).await?.1}),
    ))
}
async fn new_partner(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(v): Json<NewPartner>,
) -> Result<Json<Partner>> {
    owner(&a)?;
    v.content.validate()?;
    text(&v.reason, 1000)?;
    let hash = digest(&v)?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let old: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,creation_hash FROM edi_partners WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((id, h)) = old {
        if h != hash {
            return Err(Error::Conflict(
                "partner request ID reused with different content",
            ));
        }
        return Ok(Json(partner(&mut tx, &a, id).await?));
    }
    if let Some(id) = v.source_history_id {
        source(&mut tx, &a, id, "x12_partner").await?;
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO edi_partners (tenant_id,id,content,source_history_id,request_id,creation_hash) VALUES ($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(json!(v.content)).bind(v.source_history_id).bind(v.request_id).bind(hash).execute(&mut *tx).await?;
    let p = partner_revision(&mut tx, &a, id, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(p))
}
async fn read_partner(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let p = partner(&mut tx, &a, id).await?;
    let history:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id' FROM edi_partner_revisions r WHERE tenant_id=$1 AND partner_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.partner_read", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"partner":p,"history":history})))
}
async fn edit_partner(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<EditPartner>,
) -> Result<Json<Partner>> {
    owner(&a)?;
    v.content.validate()?;
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    if partner(&mut tx, &a, id).await?.version != version {
        return Err(Error::Conflict("partner changed; reload"));
    }
    sqlx::query(
        "UPDATE edi_partners SET content=$3,version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .bind(json!(v.content))
    .execute(&mut *tx)
    .await?;
    let p = partner_revision(&mut tx, &a, id, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(p))
}
async fn generate(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Generate>,
) -> Result<Json<Submission>> {
    a.scheduling()?;
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    let hash = digest(&(id, &v))?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let old: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,creation_hash FROM edi_submissions WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((sid, h)) = old {
        if h != hash {
            return Err(Error::Conflict(
                "837 generation request ID reused with changed evidence",
            ));
        }
        return Ok(Json(submission(&mut tx, &a, sid).await?));
    }
    let c = claims::claim_row(&mut tx, &a, id).await?;
    if c.version != version || c.status != "ready" {
        return Err(Error::Conflict(
            "generate 837P from the current ready claim",
        ));
    }
    let p = partner(&mut tx, &a, v.partner_id).await?;
    let pc: PartnerContent =
        serde_json::from_value(p.content.clone()).map_err(|_| Error::Invalid("invalid partner"))?;
    if p.version != v.partner_version || !pc.active {
        return Err(Error::Conflict("review the current active trading partner"));
    }
    let parent = if let Some(pid) = c.parent_id {
        Some(
            claims::claim_row(&mut tx, &a, pid)
                .await?
                .payer_control_number,
        )
    } else {
        None
    };
    sqlx::query("INSERT INTO edi_control_sequences (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(a.tenant_id)
        .execute(&mut *tx)
        .await?;
    let control: i64 = sqlx::query_scalar(
        "SELECT next_value FROM edi_control_sequences WHERE tenant_id=$1 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .fetch_one(&mut *tx)
    .await?;
    let g = x12::generate(&c, &pc, &v.details, parent.as_deref(), control, Utc::now())?;
    sqlx::query("UPDATE edi_control_sequences SET next_value=next_value+1 WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .execute(&mut *tx)
        .await?;
    let sid = Uuid::new_v4();
    sqlx::query("INSERT INTO edi_submissions (tenant_id,id,claim_id,partner_id,claim_version,partner_version,claim_snapshot,partner_snapshot,details,payload,payload_hash,interchange_control,group_control,transaction_control,request_id,creation_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)").bind(a.tenant_id).bind(sid).bind(id).bind(p.id).bind(c.version).bind(p.version).bind(json!(c)).bind(json!(p)).bind(json!(v.details)).bind(&g.payload).bind(crate::oauth::hash(&g.payload)).bind(g.interchange_control).bind(g.group_control).bind(g.transaction_control).bind(v.request_id).bind(hash).execute(&mut *tx).await?;
    let out = event(
        &mut tx,
        &a,
        sid,
        &v.reason,
        json!({"action":"generate_837p","format":"005010X222A1","network_transmitted":false}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(out))
}
async fn worklist(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<Page>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',s.id,'claim_id',s.claim_id,'claim_control',s.claim_snapshot->>'control_number','patient_name',s.claim_snapshot->'snapshot'->'patient'->>'family_name'||', '||(s.claim_snapshot->'snapshot'->'patient'->>'given_name'),'partner_name',s.partner_snapshot->'content'->>'name','usage',s.partner_snapshot->'content'->>'usage','status',s.status,'technical_status',s.technical_status,'payer_outcome',s.payer_outcome,'version',s.version,'interchange_control',s.interchange_control,'created_at',s.created_at) FROM edi_submissions s WHERE s.tenant_id=$1 AND ($2::uuid IS NULL OR s.id>$2) ORDER BY s.id LIMIT 101").bind(a.tenant_id).bind(q.after).fetch_all(&mut *tx).await?;
    let next = if items.len() > 100 {
        items.truncate(100);
        items.last().map(|v| v["id"].clone())
    } else {
        None
    };
    crate::postgres::audit(&mut tx, &a, "edi.worklist", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":items,"next_cursor":next,"transport":transport(db(&s)?, a.tenant_id).await?.0}),
    ))
}
async fn detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let v = submission(&mut tx, &a, id).await?;
    let c = claims::claim_row(&mut tx, &a, v.claim_id).await?;
    let history:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id' FROM edi_submission_events e WHERE tenant_id=$1 AND submission_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let acks:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id' FROM edi_acknowledgments e WHERE tenant_id=$1 AND submission_id=$2 ORDER BY created_at DESC,id").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.submission_read", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"submission":v,"claim":c,"events":history,"acknowledgments":acks,"transport":transport(db(&s)?, a.tenant_id).await?.0,"network_sender_configured":transport(db(&s)?, a.tenant_id).await?.1}),
    ))
}
async fn download(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<impl axum::response::IntoResponse> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let v = submission(&mut tx, &a, id).await?;
    if v.status == "cancelled" {
        return Err(Error::Conflict("cancelled artifact cannot be downloaded"));
    }
    if v.status == "prepared" {
        crate::delivery::ensure_unreserved(&mut tx, &a, id).await?;
        let c = claims::claim_row(&mut tx, &a, v.claim_id).await?;
        if c.status != "ready" || c.version != v.claim_version {
            return Err(Error::Conflict(
                "prepared artifact claim changed; cancel and reconcile before export",
            ));
        }
    }
    crate::postgres::audit(&mut tx, &a, "edi.file_export", id).await?;
    tx.commit().await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/EDI-X12".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=837p-{}.x12", v.interchange_control),
            ),
        ],
        v.payload,
    ))
}
async fn action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Action>,
) -> Result<Json<Submission>> {
    a.scheduling()?;
    text(&v.reason, 1000)?;
    if v.reference.len() > 200 || v.payer_control_number.len() > 150 {
        return Err(Error::Invalid("submission evidence too long"));
    }
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let out = submission(&mut tx, &a, id).await?;
    if out.version != version {
        return Err(Error::Conflict(
            "submission changed; reload before recording evidence",
        ));
    }
    crate::delivery::ensure_unreserved(&mut tx, &a, out.id).await?;
    let mut c = claims::claim_row(&mut tx, &a, out.claim_id).await?;
    match (v.action.as_str(), out.status.as_str()) {
        ("cancel", "prepared") => {
            sqlx::query("UPDATE edi_submissions SET status='cancelled',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
        }
        ("record_delivery", "prepared") => {
            text(&v.reference, 200)?;
            if v.event_date.is_none_or(|d| d > Utc::now().date_naive())
                || c.version != out.claim_version
                || c.status != "ready"
                || v.claim_version != Some(c.version)
            {
                return Err(Error::Conflict(
                    "record a nonfuture external delivery date against the unchanged ready claim",
                ));
            }
            sqlx::query("UPDATE ehr_claims SET status='submitted',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(c.id).execute(&mut *tx).await?;
            c=claims::revision(&mut tx,&a,c.id,&v.reason,json!({"submission_id":id,"external_reference":v.reference,"event_date":v.event_date,"network_transmitted_by_engine":false})).await?;
            sqlx::query("UPDATE edi_submissions SET status='delivered',delivered_claim_version=$3,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(c.version).execute(&mut *tx).await?;
        }
        ("record_payer_acceptance" | "record_payer_rejection", "delivered") => {
            text(&v.reference, 200)?;
            if v.event_date.is_none_or(|d| d > Utc::now().date_naive())
                || v.claim_version != Some(c.version)
                || out.delivered_claim_version != Some(c.version)
                || c.status != "submitted"
                || out.payer_outcome != "pending"
                || ["rejected", "needs_review"].contains(&out.technical_status.as_str())
            {
                return Err(Error::Conflict("review current submitted claim and nonfuture payer evidence; technical rejection cannot become payer acceptance"));
            }
            let accepted = v.action == "record_payer_acceptance";
            if accepted {
                text(&v.payer_control_number, 150)?;
            }
            sqlx::query("UPDATE ehr_claims SET status=$3,payer_control_number=CASE WHEN $4='' THEN payer_control_number ELSE $4 END,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(c.id).bind(if accepted{"accepted"}else{"rejected"}).bind(&v.payer_control_number).execute(&mut *tx).await?;
            claims::revision(&mut tx,&a,c.id,&v.reason,json!({"submission_id":id,"event":v.action,"external_reference":v.reference,"event_date":v.event_date,"evidence_origin":"staff_reviewed_external_payer"})).await?;
            sqlx::query("UPDATE edi_submissions SET payer_outcome=$3,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(if accepted{"accepted"}else{"rejected"}).execute(&mut *tx).await?;
        }
        _ => {
            return Err(Error::Conflict(
                "submission action is not allowed in this state",
            ))
        }
    }
    let result = event(&mut tx, &a, id, &v.reason, json!(v)).await?;
    tx.commit().await?;
    Ok(Json(result))
}
async fn acknowledge(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Ack>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let out = submission(&mut tx, &a, id).await?;
    if out.status != "delivered" || out.version != version {
        return Err(Error::Conflict(
            "acknowledgments require the current externally delivered submission",
        ));
    }
    if let Some(sid) = v.source_history_id {
        source(&mut tx, &a, sid, "edi_acknowledgment").await?;
    }
    if let Some(report) = v.remote_report_id {
        crate::retrieval::verify(
            &mut tx,
            &a,
            report,
            &v.format,
            &v.original_text,
            Some(out.partner_id),
        )
        .await?;
    }
    let parsed = x12::acknowledgment(
        &v.original_text,
        &v.format,
        &out.interchange_control,
        &out.group_control,
        &out.transaction_control,
    )?;
    let aid = Uuid::new_v4();
    sqlx::query("INSERT INTO edi_acknowledgments (tenant_id,id,submission_id,format,original_text,original_hash,parsed,source_history_id,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(a.tenant_id).bind(aid).bind(id).bind(&v.format).bind(&v.original_text).bind(crate::oauth::hash(&v.original_text)).bind(&parsed).bind(v.source_history_id).bind(a.sub).bind(&v.reason).execute(&mut *tx).await?;
    let outcome = parsed["outcome"].as_str().unwrap_or("needs_review");
    // Never let late/contradictory technical evidence rewrite an adjudicated claim or silently replace a prior result.
    let c = claims::claim_row(&mut tx, &a, out.claim_id).await?;
    let apply = ["pending", "needs_review"].contains(&out.technical_status.as_str())
        && out.payer_outcome == "pending"
        && c.status == "submitted"
        && Some(c.version) == out.delivered_claim_version;
    let status = if apply {
        outcome
    } else if out.technical_status == outcome {
        out.technical_status.as_str()
    } else {
        "needs_review"
    };
    if apply && outcome == "rejected" {
        sqlx::query("UPDATE ehr_claims SET status='rejected',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(c.id).execute(&mut *tx).await?;
        claims::revision(&mut tx,&a,c.id,&v.reason,json!({"submission_id":id,"acknowledgment_id":aid,"technical_rejection":true,"payer_acceptance":false})).await?;
    }
    sqlx::query("UPDATE edi_submissions SET technical_status=$3,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(if v.format=="x12_999"{status}else{out.technical_status.as_str()}).execute(&mut *tx).await?;
    if let Some(report) = v.remote_report_id {
        crate::retrieval::link(
            &mut tx,
            &a,
            report,
            "technical_acknowledgment",
            aid,
            &v.reason,
        )
        .await?;
    }
    let result=event(&mut tx,&a,id,&v.reason,json!({"action":"import_acknowledgment","acknowledgment_id":aid,"parsed":parsed,"technical_result_applied":apply&&v.format=="x12_999"})).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"submission":result,"parsed":parsed,"acknowledgment_id":aid}),
    ))
}
async fn sources(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.scheduling()?;
    let mut tx = db(&s)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('source_history_id',h.id,'kind',h.kind,'source_instance',h.source_instance,'source_id',h.source_id,'source_data',h.source_data,'native_id',coalesce(p.id,d.id,k.id),'submission_id',k.submission_id,'document_id',d.id,'retrieved_report_id',l.report_id) FROM historical_records h LEFT JOIN edi_remote_source_links l ON l.tenant_id=h.tenant_id AND l.source_history_id=h.id LEFT JOIN edi_partners p ON p.tenant_id=h.tenant_id AND p.source_history_id=h.id LEFT JOIN edi_acknowledgments k ON k.tenant_id=h.tenant_id AND k.source_history_id=h.id LEFT JOIN edi_277ca_documents d ON d.tenant_id=h.tenant_id AND d.source_history_id=h.id WHERE h.tenant_id=$1 AND h.kind IN ('x12_partner','edi_acknowledgment') ORDER BY h.id LIMIT 101").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    if items.len() > 100 {
        return Err(Error::Invalid("EDI source list exceeds preview limit"));
    }
    crate::postgres::audit(&mut tx, &a, "edi.sources", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}

async fn transport(pool: &PgPool, tenant: Uuid) -> Result<(&'static str, bool)> {
    let config = crate::provider_settings::load_for_tenant(pool, tenant).await?;
    let configured = config.routes.iter().any(|r| r.tenant_id == tenant);
    let providers = config
        .routes
        .iter()
        .any(|r| r.tenant_id == tenant && r.adapter != crate::delivery::Adapter::Gateway);
    Ok((
        if providers {
            "provider_adapters_and_manual_file"
        } else if configured {
            "https_gateway_and_manual_file"
        } else {
            "manual_file"
        },
        configured,
    ))
}
