// SPDX-License-Identifier: AGPL-3.0-only
//! Provider-level settlement evidence. PLB never creates a patient-account charge.
use crate::{
    auth::Actor,
    billing,
    claims::{remit_revision, remit_row, Remittance},
    era835::Document,
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub index: usize,
    pub category: String,
    pub original_remittance_id: Option<Uuid>,
}
async fn decisions(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
) -> Result<Vec<Decision>> {
    let v:Option<Value>=sqlx::query_scalar("SELECT decisions FROM era_provider_reviews WHERE tenant_id=$1 AND remittance_id=$2 ORDER BY version DESC LIMIT 1").bind(a.tenant_id).bind(id).fetch_optional(&mut **tx).await?;
    v.map(|v| serde_json::from_value(v).map_err(|_| Error::Invalid("invalid provider review")))
        .transpose()
        .map(|v| v.unwrap_or_default())
}
fn classification(code: &str, amount: i64) -> &'static str {
    match code {
        "FB" => "forward_balance",
        "WO" if amount > 0 => "recoupment",
        "WO" => "overpayment_offset",
        "72" => "refund",
        "L6" => "interest",
        _ => "other",
    }
}
pub(crate) async fn review_issues(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Remittance,
    doc: &Document,
) -> Result<Vec<String>> {
    let rows = decisions(tx, a, r.id).await?;
    let mut issues = vec![];
    if rows.len() != doc.provider_adjustments.len() {
        issues.push("Every PLB pair requires explicit provider settlement review".into());
    }
    for d in rows {
        let p = doc
            .provider_adjustments
            .get(d.index)
            .ok_or(Error::Invalid("provider review index out of range"))?;
        if d.category != classification(&p.reason_code, p.amount_cents) {
            issues.push("Provider adjustment classification differs from source code/sign".into());
        }
        if let Some(id) = d.original_remittance_id {
            let source = remit_row(tx, a, id).await?;
            let source_doc: Document = serde_json::from_value(source.document)
                .map_err(|_| Error::Invalid("invalid original settlement"))?;
            let provider_matches:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM era_postings p JOIN ehr_claims c ON c.tenant_id=p.tenant_id AND c.id=p.claim_id WHERE p.tenant_id=$1 AND p.remittance_id=$2 AND (c.content->>'billing_npi'=$3 OR c.content->>'tax_id'=$3))").bind(a.tenant_id).bind(id).bind(&p.provider_id).fetch_one(&mut **tx).await?;
            let provider_matches = provider_matches
                || source_doc
                    .provider_adjustments
                    .iter()
                    .any(|v| v.provider_id == p.provider_id);
            if !provider_matches
                || source.id == r.id
                || source.payer_id != r.payer_id
                || source.status != "posted"
                || !(source.trace == p.reference
                    || source_doc.claims.iter().any(|c| {
                        !c.payer_control_number.is_empty() && c.payer_control_number == p.reference
                    }))
            {
                issues.push("Provider recoupment link must match a posted payer settlement trace or claim control reference".into());
            }
        }
    }
    Ok(issues)
}
async fn case_event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    reason: &str,
    evidence: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO era_recoupment_events (tenant_id,case_id,version,actor_id,reason,evidence) SELECT tenant_id,id,version,$3,$4,$5 FROM era_recoupment_cases WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(a.sub).bind(reason).bind(evidence).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "remittance.recoupment_change", id).await
}
pub(crate) async fn post_entries(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Remittance,
    doc: &Document,
    reason: &str,
) -> Result<()> {
    for d in decisions(tx, a, r.id).await? {
        let p = &doc.provider_adjustments[d.index];
        sqlx::query("INSERT INTO era_provider_entries (tenant_id,id,remittance_id,row_index,provider_id,payer_id,effect_cents,category,evidence,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(r.id).bind(d.index as i32).bind(&p.provider_id).bind(r.payer_id).bind(-p.amount_cents).bind(&d.category).bind(json!({"source":p,"review":d,"cash_effect":"claim_payments_minus_plb","patient_allocation":false})).bind(a.sub).bind(reason).execute(&mut **tx).await?;
        if d.category == "recoupment" {
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO era_recoupment_cases (tenant_id,id,remittance_id,row_index) VALUES ($1,$2,$3,$4)").bind(a.tenant_id).bind(id).bind(r.id).bind(d.index as i32).execute(&mut **tx).await?;
            case_event(tx,a,id,reason,json!({"action":"open","amount_cents":p.amount_cents,"patient_balance_changed":false})).await?;
        }
    }
    if !doc.provider_adjustments.is_empty() {
        crate::postgres::audit(tx, a, "remittance.provider_post", r.id).await?;
    }
    Ok(())
}
pub(crate) async fn reverse(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Remittance,
    reason: &str,
) -> Result<()> {
    let entries:Vec<(Uuid,i32,String,i64,String,Value)>=sqlx::query_as("SELECT id,row_index,provider_id,effect_cents,category,evidence FROM era_provider_entries WHERE tenant_id=$1 AND remittance_id=$2 AND reverses_id IS NULL ORDER BY row_index").bind(a.tenant_id).bind(r.id).fetch_all(&mut **tx).await?;
    for (id, index, provider, amount, category, evidence) in entries {
        sqlx::query("INSERT INTO era_provider_entries (tenant_id,id,remittance_id,row_index,provider_id,payer_id,effect_cents,category,evidence,reverses_id,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(r.id).bind(index).bind(provider).bind(r.payer_id).bind(-amount).bind(category).bind(evidence).bind(id).bind(a.sub).bind(reason).execute(&mut **tx).await?;
    }
    let cases:Vec<Uuid>=sqlx::query_scalar("UPDATE era_recoupment_cases SET status='void',version=version+1 WHERE tenant_id=$1 AND remittance_id=$2 RETURNING id").bind(a.tenant_id).bind(r.id).fetch_all(&mut **tx).await?;
    for id in cases {
        case_event(
            tx,
            a,
            id,
            reason,
            json!({"action":"void","remittance_reversal":r.id}),
        )
        .await?;
    }
    crate::postgres::audit(tx, a, "remittance.provider_reverse", r.id).await
}
pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/billing/remittances/{id}/provider-adjustments",
            get(detail).put(review),
        )
        .route("/api/v1/billing/recoupments", get(cases))
        .route(
            "/api/v1/billing/recoupments/{id}/actions",
            post(case_action),
        )
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
    let r = remit_row(&mut tx, &a, id).await?;
    let doc: Document = serde_json::from_value(r.document.clone())
        .map_err(|_| Error::Invalid("invalid remittance"))?;
    let reviews:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(v)-'tenant_id' FROM era_provider_reviews v WHERE tenant_id=$1 AND remittance_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let entries:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(v)-'tenant_id' FROM era_provider_entries v WHERE tenant_id=$1 AND remittance_id=$2 ORDER BY created_at,id").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let suggested:Vec<Value>=doc.provider_adjustments.iter().enumerate().map(|(index,p)|json!({"index":index,"category":classification(&p.reason_code,p.amount_cents),"original_remittance_id":null})).collect();
    crate::postgres::audit(&mut tx, &a, "remittance.provider_read", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"version":r.version,"status":r.status,"adjustments":doc.provider_adjustments,"reviews":reviews,"entries":entries,"suggested_classifications":suggested}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Review {
    decisions: Vec<Decision>,
    reason: String,
}
async fn review(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Review>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    crate::model::text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    if v.decisions.len() > 120 {
        return Err(Error::Invalid("too many PLB decisions"));
    }
    let mut tx = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .db
        .begin()
        .await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let r = remit_row(&mut tx, &a, id).await?;
    if r.version != version || !["staged", "reconciled"].contains(&r.status.as_str()) {
        return Err(Error::Conflict("Review only the current staged settlement"));
    }
    let doc: Document = serde_json::from_value(r.document.clone())
        .map_err(|_| Error::Invalid("invalid remittance"))?;
    let mut seen = std::collections::HashSet::new();
    if v.decisions.len() != doc.provider_adjustments.len()
        || v.decisions.iter().any(|d| {
            d.index >= doc.provider_adjustments.len()
                || !seen.insert(d.index)
                || d.category
                    != classification(
                        &doc.provider_adjustments[d.index].reason_code,
                        doc.provider_adjustments[d.index].amount_cents,
                    )
        })
    {
        return Err(Error::Invalid(
            "Explicitly classify each PLB pair using its source code and sign",
        ));
    }
    sqlx::query("INSERT INTO era_provider_reviews (tenant_id,remittance_id,version,decisions,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(version+1).bind(json!(v.decisions)).bind(a.sub).bind(&v.reason).execute(&mut *tx).await?;
    let issues = review_issues(&mut tx, &a, &r, &doc).await?;
    if !issues.is_empty() {
        return Err(Error::Conflict(
            "Provider adjustment reference requires independent reconciliation",
        ));
    }
    sqlx::query(
        "UPDATE era_remittances SET version=version+1,status='staged' WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    remit_revision(&mut tx, &a, id, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(json!({"recorded":true,"version":version+1})))
}
async fn cases(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .db
        .begin()
        .await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(c)-'tenant_id' || jsonb_build_object('trace',r.trace,'payer_id',r.payer_id,'adjustment',r.document->'provider_adjustments'->c.row_index,'events',(SELECT coalesce(jsonb_agg(to_jsonb(e)-'tenant_id' ORDER BY e.version),'[]') FROM era_recoupment_events e WHERE e.tenant_id=c.tenant_id AND e.case_id=c.id)) FROM era_recoupment_cases c JOIN era_remittances r ON r.tenant_id=c.tenant_id AND r.id=c.remittance_id WHERE c.tenant_id=$1 ORDER BY c.id DESC LIMIT 100").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "remittance.recoupments_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    action: String,
    reason: String,
}
async fn case_action(
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
    let old: Option<(String, i64)> = sqlx::query_as(
        "SELECT status,version FROM era_recoupment_cases WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (old, current) = old.ok_or(Error::NotFound)?;
    if current != version || old == "void" {
        return Err(Error::Conflict("Recoupment case changed or was voided"));
    }
    let status = match v.action.as_str() {
        "dispute" if old != "closed" => "disputed",
        "acknowledge" if old != "closed" => "acknowledged",
        "close" => "closed",
        "reopen" if old == "closed" => "open",
        _ => return Err(Error::Conflict("Unsupported recoupment case transition")),
    };
    sqlx::query(
        "UPDATE era_recoupment_cases SET status=$3,version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .bind(status)
    .execute(&mut *tx)
    .await?;
    case_event(
        &mut tx,
        &a,
        id,
        &v.reason,
        json!({"action":v.action,"status":status,"patient_balance_changed":false}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"status":status,"version":version+1})))
}
