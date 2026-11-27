// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Review a modifier change against the original held Claim.MD record.
use crate::{
    auth::Actor,
    billing,
    claims::{self, CLAIMMD_SETTLED_REASON, CLAIMMD_WARNING_REASON},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::HeaderMap,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashMap;
use uuid::Uuid;

const DRAFT_EVENT: &str = "claimmd_correction_draft";
const PORTAL_URL: &str = "https://www.claim.md/login/";

#[derive(Serialize)]
pub(crate) struct Source {
    report_id: Uuid,
    submission_id: Uuid,
    external_claim_id: String,
    message: String,
    line: Line,
    related_lines: Vec<Line>,
}

#[derive(Serialize)]
struct Line {
    index: usize,
    code: String,
    modifiers: String,
    description: String,
}

impl Source {
    pub(crate) fn add_list_hint(self, correction: &mut Value) {
        correction["report_id"] = json!(self.report_id);
        correction["submission_id"] = json!(self.submission_id);
        correction["line"] = json!(self.line);
    }
}

#[derive(sqlx::FromRow)]
struct HeldRecord {
    claim_id: Uuid,
    report_id: Uuid,
    submission_id: Uuid,
    external_claim_id: Value,
    message: String,
    lines: Value,
}

/// Bind the warning to the exact delivered artifact and provider response already
/// matched by retrieval. The original packet is the source for row identity.
pub(crate) async fn sources(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    ids: &[Uuid],
) -> Result<HashMap<Uuid, Source>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let held = sqlx::query_as::<_, HeldRecord>(
        r#"
        SELECT c.id AS claim_id, r.id AS report_id, s.id AS submission_id,
               r.parse_summary->'claimmd_id' AS external_claim_id,
               r.parse_summary#>>'{message,message}' AS message,
               s.claim_snapshot#>'{snapshot,account,content,lines}' AS lines
        FROM ehr_claims c
        CROSS JOIN LATERAL (
          SELECT cr.reason, cr.evidence FROM claim_revisions cr
          WHERE cr.tenant_id = c.tenant_id AND cr.claim_id = c.id
            AND cr.evidence->>'evidence_origin' = 'claimmd_status_feed'
            AND cr.reason IN ($3, $4)
          ORDER BY cr.version DESC LIMIT 1
        ) w
        JOIN edi_remote_reports r ON r.tenant_id = c.tenant_id
          AND r.id::text = w.evidence->>'retrieved_report_id'
        JOIN edi_submissions s ON s.tenant_id = c.tenant_id
          AND s.claim_id = c.id AND s.id = r.native_id
          AND s.id::text = w.evidence->>'submission_id'
        JOIN edi_delivery_jobs j ON j.tenant_id = c.tenant_id
          AND j.submission_id = s.id AND j.route_key = r.route_key
        WHERE c.tenant_id = $1 AND c.id = ANY($2)
          AND c.status = 'submitted' AND c.frequency = 'original'
          AND c.source_history_id IS NULL AND btrim(c.payer_control_number) = ''
          AND w.reason = $3
          AND s.status = 'delivered' AND s.technical_status = 'needs_review'
          AND s.payer_outcome = 'pending' AND j.status = 'delivered'
          AND j.receipt_reference IN (
            'claimmd-claim:' || (r.parse_summary->>'claimmd_id'),
            'claimmd-file:' || (r.parse_summary->>'fileid')
          )
          AND r.status = 'retrieved' AND r.native_kind = 'submission'
          AND r.format = 'claimmd_status' AND r.metadata->>'source' = 'claimmd_response_api'
          AND r.parse_summary#>>'{message,status}' = 'W'
          AND (
            r.parse_summary->>'senderid' = 'CLMMD'
            OR (coalesce(r.parse_summary->>'senderid', '') = ''
                AND upper(btrim(r.parse_summary->>'sender_name')) = 'CLAIM.MD')
          )
          AND coalesce(r.parse_summary->>'sender_icn', '') = ''
          AND r.parse_summary->>'claimmd_id' IS NOT NULL
          AND r.parse_summary#>>'{message,message}' IS NOT NULL
          AND jsonb_typeof(s.claim_snapshot#>'{snapshot,account,content,lines}') = 'array'
          AND NOT EXISTS (
            SELECT 1 FROM claim_revisions cr
            WHERE cr.tenant_id = c.tenant_id AND cr.claim_id = c.id
              AND (cr.evidence->>'event' = 'claimmd_payer_acceptance'
                OR cr.evidence->>'action' = 'record_acceptance')
          )
          AND NOT EXISTS (
            SELECT 1 FROM era_postings e WHERE e.tenant_id = c.tenant_id AND e.claim_id = c.id
          )
        "#,
    )
    .bind(tenant)
    .bind(ids)
    .bind(CLAIMMD_WARNING_REASON)
    .bind(CLAIMMD_SETTLED_REASON)
    .fetch_all(&mut **tx)
    .await?;

    Ok(held
        .into_iter()
        .filter_map(|row| {
            let (line, related_lines) = affected_lines(&row.message, &row.lines)?;
            let source = Source {
                report_id: row.report_id,
                submission_id: row.submission_id,
                external_claim_id: crate::claimmd::claim_receipt_id(&row.external_claim_id)?,
                message: row.message,
                line,
                related_lines,
            };
            Some((row.claim_id, source))
        })
        .collect())
}

fn named_code(after: &str) -> Option<&str> {
    let (code, _) = after.split_once(']')?;
    (code.len() == 5 && code.bytes().all(|byte| byte.is_ascii_alphanumeric())).then_some(code)
}

fn affected_lines(message: &str, lines: &Value) -> Option<(Line, Vec<Line>)> {
    // The first code is the reported procedure. The companion code is context.
    // An ambiguous or unfamiliar warning stays on the general response review.
    let warning = message.to_ascii_lowercase();
    let (_, after) = warning.split_once("procedure code [")?;
    if after.contains("procedure code [") || !after.contains("requires an appropriate modifier") {
        return None;
    }
    let code = named_code(after)?;
    let related_code = after
        .split_once("when procedure [")
        .and_then(|(_, value)| named_code(value));
    let mut affected = None;
    let mut related = Vec::new();
    for (index, entry) in lines.as_array()?.iter().enumerate() {
        let saved_code = entry["code"].as_str()?;
        let target = saved_code.eq_ignore_ascii_case(code);
        if target || related_code.is_some_and(|other| saved_code.eq_ignore_ascii_case(other)) {
            let line = Line {
                index,
                code: saved_code.to_owned(),
                modifiers: entry["modifiers"].as_str().unwrap_or("").to_owned(),
                description: entry["description"].as_str().unwrap_or("").to_owned(),
            };
            if target {
                if affected.replace(line).is_some() {
                    return None;
                }
            } else {
                related.push(line);
            }
        }
    }
    Some((affected?, related))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Change {
    report_id: Uuid,
    submission_id: Uuid,
    line_index: usize,
    modifiers: Vec<String>,
    #[serde(default)]
    reviewed: bool,
}

#[derive(Serialize)]
struct Draft {
    modifiers: Vec<String>,
    reviewed_at: Option<DateTime<Utc>>,
}

fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}

async fn source(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Source> {
    sources(tx, a.tenant_id, &[id])
        .await?
        .remove(&id)
        .ok_or(Error::Conflict(
            "This Claim.MD response has no current correction for an exact procedure line.",
        ))
}

async fn draft(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    source: &Source,
) -> Result<Option<Draft>> {
    let saved: Option<(Value, DateTime<Utc>)> = sqlx::query_as(
        "SELECT evidence,created_at FROM claim_revisions WHERE tenant_id=$1 AND claim_id=$2 AND evidence->>'event'=$3 AND evidence->>'report_id'=$4 AND evidence->>'submission_id'=$5 ORDER BY version DESC LIMIT 1",
    )
    .bind(a.tenant_id)
    .bind(id)
    .bind(DRAFT_EVENT)
    .bind(source.report_id.to_string())
    .bind(source.submission_id.to_string())
    .fetch_optional(&mut **tx)
    .await?;
    saved
        .map(|(evidence, saved_at)| {
            let modifiers = serde_json::from_value(evidence["modifiers"].clone())
                .map_err(|_| Error::Integrity("Invalid stored Claim.MD correction"))?;
            Ok(Draft {
                modifiers,
                reviewed_at: (evidence["reviewed"] == true).then_some(saved_at),
            })
        })
        .transpose()
}

fn response(version: i64, source: Source, draft: Option<Draft>) -> Json<Value> {
    Json(json!({
        "claim_version":version,
        "source":source,
        "draft":draft,
        "portal_url":PORTAL_URL,
    }))
}

pub(crate) async fn read(
    a: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&state)?.begin().await?;
    // Read the version and its matched warning/draft from one snapshot while a
    // provider poll or another staff member is updating the claim.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let claim = claims::claim_row(&mut tx, &a, id).await?;
    let source = source(&mut tx, &a, id).await?;
    let draft = draft(&mut tx, &a, id, &source).await?;
    crate::postgres::audit(&mut tx, &a, "claim.read", id).await?;
    tx.commit().await?;
    Ok(response(claim.version, source, draft))
}

pub(crate) async fn save(
    a: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(change): Json<Change>,
) -> Result<Json<Value>> {
    if change.reviewed {
        return Err(Error::Invalid(
            "Use Review correction to confirm the change.",
        ));
    }
    update(a, state, id, headers, change).await
}

pub(crate) async fn review(
    a: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(change): Json<Change>,
) -> Result<Json<Value>> {
    if !change.reviewed {
        return Err(Error::Invalid("Review the correction before continuing."));
    }
    update(a, state, id, headers, change).await
}

fn validate_modifiers(modifiers: Vec<String>) -> Result<Vec<String>> {
    let normalized: Vec<_> = modifiers
        .iter()
        .map(|value| value.trim().to_ascii_uppercase())
        .collect();
    if normalized.len() > 4
        || normalized.iter().enumerate().any(|(index, value)| {
            value.len() != 2
                || !value.bytes().all(|byte| byte.is_ascii_alphanumeric())
                || normalized[..index].contains(value)
        })
    {
        return Err(Error::Invalid(
            "Enter up to four different two-character modifiers.",
        ));
    }
    Ok(normalized)
}

async fn update(
    a: Actor,
    state: State,
    id: Uuid,
    headers: HeaderMap,
    change: Change,
) -> Result<Json<Value>> {
    a.scheduling()?;
    let version = crate::expected(&headers)?;
    let modifiers = validate_modifiers(change.modifiers)?;
    let mut tx = db(&state)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let claim = claims::claim_row(&mut tx, &a, id).await?;
    let source = source(&mut tx, &a, id).await?;
    if (change.report_id, change.submission_id, change.line_index)
        != (source.report_id, source.submission_id, source.line.index)
    {
        return Err(Error::Conflict(
            "The Claim.MD response or procedure changed. Reopen the correction.",
        ));
    }
    let saved = draft(&mut tx, &a, id, &source).await?;
    let same_draft = saved
        .as_ref()
        .is_some_and(|draft| draft.modifiers == modifiers);
    let already_reviewed = saved
        .as_ref()
        .is_some_and(|draft| draft.reviewed_at.is_some());
    if same_draft && (!change.reviewed || already_reviewed) {
        tx.commit().await?;
        return Ok(response(claim.version, source, saved));
    }
    if version != claim.version {
        return Err(Error::Conflict(
            "The claim changed while you were editing. Reopen the correction.",
        ));
    }
    if change.reviewed {
        let original_modifiers: Vec<_> = source
            .line
            .modifiers
            .split([',', ' '])
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_uppercase)
            .collect();
        if !same_draft || modifiers == original_modifiers {
            return Err(Error::Conflict(
                "Save the updated modifiers before reviewing the correction.",
            ));
        }
    }
    let reason = if change.reviewed {
        "Reviewed a modifier correction to continue in Claim.MD"
    } else {
        "Saved a Claim.MD modifier correction draft"
    };
    sqlx::query("UPDATE ehr_claims SET version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let updated = claims::revision(
        &mut tx,
        &a,
        id,
        reason,
        json!({
            "event":DRAFT_EVENT,
            "report_id":source.report_id,
            "submission_id":source.submission_id,
            "external_claim_id":source.external_claim_id,
            "line_index":source.line.index,
            "procedure_code":source.line.code,
            "modifiers":modifiers,
            "reviewed":change.reviewed,
        }),
    )
    .await?;
    let saved = draft(&mut tx, &a, id, &source).await?;
    tx.commit().await?;
    Ok(response(updated.version, source, saved))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_the_named_procedure_and_preserves_the_companion_line() {
        let warning = "NCCI - Procedure Code [64405] requires an appropriate modifier when procedure [20553] present.";
        let lines = json!([{"code":"20553"},{"code":"64405","modifiers":"50"},{"code":"99214"}]);
        let (affected, related) = affected_lines(warning, &lines).unwrap();
        assert_eq!((affected.index, affected.modifiers.as_str()), (1, "50"));
        assert_eq!(related[0].index, 0);
        assert!(affected_lines(warning, &json!([{"code":"64405"},{"code":"64405"}])).is_none());
        assert!(affected_lines(warning, &json!([{"code":"20553"}])).is_none());
        assert!(affected_lines("Procedure Code [64405] has wrong diagnosis", &lines).is_none());
    }

    #[test]
    fn limits_and_normalizes_the_modifier_list() {
        assert_eq!(
            validate_modifiers(vec![" 59 ".into(), "xs".into()]).unwrap(),
            ["59", "XS"]
        );
        assert!(validate_modifiers(vec!["xs".into(), "XS".into()]).is_err());
        assert!(validate_modifiers(vec!["594".into()]).is_err());
    }
}
