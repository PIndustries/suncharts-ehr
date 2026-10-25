// SPDX-License-Identifier: AGPL-3.0-only
//! Row-precise, append-only ERA correction chains. Preview uses a rolled-back savepoint.
use crate::{
    auth::Actor,
    billing,
    claims::{self, Match, Remittance},
    era835::Document,
    error::{Error, Result},
};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use std::collections::BTreeMap;
use uuid::Uuid;
pub(crate) type Baselines = BTreeMap<Uuid, (i64, i64)>;
pub(crate) async fn head(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    claim: Uuid,
) -> Result<Option<Value>> {
    Ok(sqlx::query_scalar("SELECT to_jsonb(h)-'tenant_id'-'claim_id' FROM era_claim_heads h WHERE tenant_id=$1 AND claim_id=$2").bind(a.tenant_id).bind(claim).fetch_optional(&mut **tx).await?)
}
pub(crate) async fn leaves(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    remit: Uuid,
    row: usize,
) -> Result<Vec<(Uuid, i64)>> {
    let rows:Vec<(Uuid,i64)>=sqlx::query_as("WITH RECURSIVE chain AS (SELECT e.id,e.effect_cents FROM era_row_entries p JOIN billing_entries e ON e.tenant_id=p.tenant_id AND e.id=p.entry_id WHERE p.tenant_id=$1 AND p.remittance_id=$2 AND p.row_index=$3 AND NOT EXISTS(SELECT 1 FROM era_row_entries parent WHERE parent.tenant_id=p.tenant_id AND parent.remittance_id=p.remittance_id AND parent.row_index=p.row_index AND parent.entry_id=e.reverses_id) UNION ALL SELECT e.id,e.effect_cents FROM billing_entries e JOIN chain c ON e.reverses_id=c.id WHERE e.tenant_id=$1) SELECT c.id,c.effect_cents FROM chain c WHERE NOT EXISTS(SELECT 1 FROM billing_entries e WHERE e.tenant_id=$1 AND e.reverses_id=c.id) ORDER BY c.id").bind(a.tenant_id).bind(remit).bind(row as i32).fetch_all(&mut **tx).await?;
    Ok(rows)
}
pub(crate) async fn advance(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Remittance,
    m: &Match,
    c: &claims::Claim,
    prior: Option<Value>,
) -> Result<()> {
    sqlx::query("INSERT INTO era_posting_contexts (tenant_id,remittance_id,row_index,prior_head) VALUES ($1,$2,$3,$4)").bind(a.tenant_id).bind(r.id).bind(m.row_index as i32).bind(prior).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO era_claim_heads (tenant_id,claim_id,remittance_id,row_index,claim_version) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,claim_id) DO UPDATE SET remittance_id=excluded.remittance_id,row_index=excluded.row_index,claim_version=excluded.claim_version").bind(a.tenant_id).bind(c.id).bind(r.id).bind(m.row_index as i32).bind(c.version+1).execute(&mut **tx).await?;
    Ok(())
}
pub(crate) async fn plan(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Remittance,
    matches: &[Match],
    base: &mut Baselines,
    reason: &str,
) -> Result<Vec<String>> {
    let doc: Document = serde_json::from_value(r.document.clone())
        .map_err(|_| Error::Invalid("invalid ERA document"))?;
    let mut issues = claims::review_row(tx, a, r, &[]).await?;
    if matches.len() != doc.claims.len() {
        issues.push("Every remittance claim must be explicitly matched".into());
        return Ok(issues);
    }
    let mut ordered = matches.to_vec();
    ordered.sort_by_key(|m| m.row_index);
    if ordered.iter().enumerate().any(|(i, m)| m.row_index != i) {
        return Err(Error::Invalid("Every ERA row must be matched exactly once"));
    }
    if !issues.is_empty() {
        for m in &ordered {
            issues.extend(claims::review_row(tx, a, r, std::slice::from_ref(m)).await?);
        }
        issues.sort();
        issues.dedup();
        return Ok(issues);
    }
    for m in ordered {
        let c = claims::claim_row(tx, a, m.claim_id).await?;
        let b = claims::account(tx, a, c.account_id, Some(c.patient_id)).await?;
        let baseline = base.entry(c.id).or_insert((c.version, b.version));
        if *baseline != (m.claim_version, m.account_version) {
            issues.push(format!(
                "Row {}: reviewed claim or account version changed",
                m.row_index + 1
            ));
            return Ok(issues);
        }
        let row = &doc.claims[m.row_index];
        let current = head(tx, a, c.id).await?;
        if row.status != "22" {
            let previous_status = if let Some(h) = &current {
                let prior = claims::remit_row(
                    tx,
                    a,
                    Uuid::parse_str(
                        h["remittance_id"]
                            .as_str()
                            .ok_or(Error::Invalid("invalid head"))?,
                    )
                    .map_err(|_| Error::Invalid("invalid head"))?,
                )
                .await?;
                let d: Document = serde_json::from_value(prior.document)
                    .map_err(|_| Error::Invalid("invalid head document"))?;
                d.claims
                    .get(h["row_index"].as_u64().unwrap_or(u64::MAX) as usize)
                    .map(|v| v.status.clone())
            } else {
                None
            };
            if previous_status.as_deref() == Some("22")
                || m.correction_of_remittance_id.is_some()
                || m.correction_of_row_index.is_some()
            {
                let expected = json!({"remittance_id":m.correction_of_remittance_id,"row_index":m.correction_of_row_index});
                if previous_status.as_deref() != Some("22")
                    || current.as_ref().is_none_or(|h| {
                        h["remittance_id"] != expected["remittance_id"]
                            || h["row_index"] != expected["row_index"]
                            || h["claim_version"] != json!(c.version)
                    })
                {
                    issues.push(format!(
                        "Row {}: correction must explicitly follow the active exact reversal row",
                        m.row_index + 1
                    ));
                    return Ok(issues);
                }
            }
        } else if m.correction_of_remittance_id.is_some() || m.correction_of_row_index.is_some() {
            return Err(Error::Invalid(
                "CLP22 cannot be marked as a positive correction",
            ));
        }
        let mut effective = m.clone();
        effective.claim_version = c.version;
        effective.account_version = b.version;
        let checks = claims::review_row(tx, a, r, &[effective.clone()]).await?;
        if !checks.is_empty() {
            issues.extend(checks);
            return Ok(issues);
        }
        claims::post_rows(tx, a, r, &[effective], reason).await?;
    }
    Ok(issues)
}
pub(crate) async fn reverse(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Remittance,
    reason: &str,
) -> Result<()> {
    let postings:Vec<(i32,Uuid,Uuid,String,String)>=sqlx::query_as("SELECT row_index,claim_id,account_id,claim_status_before,claim_control_before FROM era_postings WHERE tenant_id=$1 AND remittance_id=$2 ORDER BY row_index DESC").bind(a.tenant_id).bind(r.id).fetch_all(&mut **tx).await?;
    for (index, claim, account, status, control) in postings {
        let c = claims::claim_row(tx, a, claim).await?;
        let b = claims::account(tx, a, account, Some(c.patient_id)).await?;
        let h = head(tx, a, claim).await?;
        let downstream:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ehr_claims WHERE tenant_id=$1 AND parent_id=$2 AND status<>'void')").bind(a.tenant_id).bind(claim).fetch_one(&mut **tx).await?;
        if downstream
            || h.as_ref().is_none_or(|h| {
                h["remittance_id"] != json!(r.id)
                    || h["row_index"] != json!(index)
                    || h["claim_version"] != json!(c.version)
            })
        {
            return Err(Error::Conflict("Later claim activity or correction depends on this row; reverse downstream postings first"));
        }
        let entries = leaves(tx, a, r.id, index as usize).await?;
        let balance:i64=sqlx::query_scalar("SELECT coalesce(sum(effect_cents),0)::bigint FROM billing_entries WHERE tenant_id=$1 AND account_id=$2").bind(a.tenant_id).bind(account).fetch_one(&mut **tx).await?;
        if !(0..=1000000000)
            .contains(&(b.total_cents + balance - entries.iter().map(|e| e.1).sum::<i64>()))
        {
            return Err(Error::Conflict("ERA reversal exceeds supported balance"));
        }
        for (id, effect) in entries {
            claims::era_entry(
                tx,
                a,
                r,
                (account, index as usize),
                ("reversal", -effect),
                reason,
                Some(id),
            )
            .await?;
        }
        sqlx::query("UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(account)
            .execute(&mut **tx)
            .await?;
        billing::account_revision(tx, a, c.patient_id, account, reason).await?;
        sqlx::query("UPDATE ehr_claims SET status=$3,payer_control_number=$4,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(claim).bind(status).bind(control).execute(&mut **tx).await?;
        let prior:Option<Value>=sqlx::query_scalar("SELECT prior_head FROM era_posting_contexts WHERE tenant_id=$1 AND remittance_id=$2 AND row_index=$3").bind(a.tenant_id).bind(r.id).bind(index).fetch_one(&mut **tx).await?;
        if let Some(p) = prior {
            sqlx::query("UPDATE era_claim_heads SET remittance_id=$3,row_index=$4,claim_version=$5 WHERE tenant_id=$1 AND claim_id=$2").bind(a.tenant_id).bind(claim).bind(Uuid::parse_str(p["remittance_id"].as_str().ok_or(Error::Invalid("invalid prior head"))?).map_err(|_|Error::Invalid("invalid prior head"))?).bind(p["row_index"].as_i64().ok_or(Error::Invalid("invalid prior head"))? as i32).bind(c.version+1).execute(&mut **tx).await?;
        } else {
            sqlx::query("DELETE FROM era_claim_heads WHERE tenant_id=$1 AND claim_id=$2")
                .bind(a.tenant_id)
                .bind(claim)
                .execute(&mut **tx)
                .await?;
        }
        claims::revision(
            tx,
            a,
            claim,
            reason,
            json!({"remittance_reversal":r.id,"row_index":index}),
        )
        .await?;
    }
    crate::settlements::reverse(tx, a, r, reason).await
}

pub fn router() -> axum::Router<crate::State> {
    axum::Router::new().route(
        "/api/v1/billing/claims/{id}/era-history",
        axum::routing::get(history),
    )
}
async fn history(
    a: Actor,
    axum::extract::State(s): axum::extract::State<crate::State>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> Result<axum::Json<Value>> {
    a.staff()?;
    let mut tx = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .db
        .begin()
        .await?;
    claims::claim_row(&mut tx, &a, id).await?;
    let current = head(&mut tx, &a, id).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('remittance_id',p.remittance_id,'row_index',p.row_index,'trace',r.trace,'status',r.status,'claim',r.document->'claims'->p.row_index) FROM era_postings p JOIN era_remittances r ON r.tenant_id=p.tenant_id AND r.id=p.remittance_id WHERE p.tenant_id=$1 AND p.claim_id=$2 ORDER BY r.created_at DESC,p.row_index DESC LIMIT 100").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "remittance.claim_chain_read", id).await?;
    tx.commit().await?;
    Ok(axum::Json(json!({"active_head":current,"items":items})))
}
