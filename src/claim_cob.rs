// SPDX-License-Identifier: AGPL-3.0-only
//! Secondary professional claims reuse one account and its posted primary ERA.
use crate::{
    auth::Actor,
    billing::Account,
    claims::{self, Claim},
    era835::{Adjustment, Document, RemitClaim},
    error::{Error, Result},
    model::text,
    x12::Details,
};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub coverage_id: Uuid,
    pub coverage_version: i64,
    pub primary_claim_version: i64,
    pub remittance_id: Uuid,
    pub remittance_version: i64,
    pub row_index: usize,
    pub not_forwarded_confirmed: bool,
    pub payer_timing_reviewed: bool,
    pub crossover_reference: String,
    pub paid_units: Vec<i64>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Evidence {
    pub primary_claim_id: Uuid,
    pub primary_claim_version: i64,
    pub remittance_id: Uuid,
    pub remittance_version: i64,
    pub row_index: usize,
    pub payment_date: NaiveDate,
    pub trace: String,
    pub primary_coverage: Value,
    pub primary_details: Details,
    pub adjudication: RemitClaim,
    pub paid_units: Vec<i64>,
    pub primary_credits: Vec<Adjustment>,
    pub crossover_reference: String,
    pub not_forwarded_confirmed: bool,
    pub payer_timing_reviewed: bool,
}

pub(crate) fn evidence(c: &Claim) -> Result<Option<Evidence>> {
    c.snapshot
        .get("coordination_of_benefits")
        .filter(|v| !v.is_null())
        .map(|v| {
            serde_json::from_value(v.clone())
                .map_err(|_| Error::Invalid("invalid frozen coordination evidence"))
        })
        .transpose()
}

fn validate_primary(primary: &Claim, account: &Account) -> Result<()> {
    if primary.patient_id != account.patient_id
        || primary.account_id != account.id
        || primary.status != "adjudicated"
        || primary.snapshot["account"]["coverage_snapshot"]["coverage"]["content"]["priority"]
            != "primary"
        || primary
            .snapshot
            .get("coordination_of_benefits")
            .is_some_and(|v| !v.is_null())
        || primary.snapshot["account"]["content"]["lines"] != account.content["lines"]
        || account.status != "posted"
    {
        return Err(Error::Conflict("secondary billing requires this account's adjudicated primary claim and unchanged services"));
    }
    Ok(())
}

pub(crate) fn validate_adjudication(
    row: &RemitClaim,
    total_cents: i64,
    content: &Value,
    paid_units: &[i64],
) -> Result<()> {
    let lines = content["lines"]
        .as_array()
        .ok_or(Error::Invalid("missing account services"))?;
    // CLP19 explicitly reports a forwarded primary claim. No override can turn it
    // into a new outbound secondary submission.
    if row.status != "1" {
        return Err(Error::Conflict("primary ERA must be processed as primary and not forwarded; review crossover or denial before secondary billing"));
    }
    if row.charged_cents != total_cents
        || row.paid_cents < 0
        || row.payer_control_number.is_empty()
        || row.services.len() != lines.len()
        || paid_units.len() != lines.len()
        || paid_units.iter().any(|n| !(1..=1000).contains(n))
    {
        return Err(Error::Invalid("review every primary service payment and paid unit count against the unchanged charges"));
    }
    let mut paid = 0i64;
    for (i, (line, service)) in lines.iter().zip(&row.services).enumerate() {
        if service.line_control != (i + 1).to_string()
            || Some(service.charged_cents) != line["amount_cents"].as_i64()
            || service.paid_cents < 0
            || service.paid_cents
                + row
                    .adjustments
                    .iter()
                    .filter(|a| a.service_index == Some(i))
                    .map(|a| a.amount_cents)
                    .sum::<i64>()
                != service.charged_cents
        {
            return Err(Error::Invalid(
                "primary ERA services require exact ordered original line controls and charges",
            ));
        }
        let mut code = service.code.split(':');
        let qualifier = code.next().unwrap_or_default();
        let procedure = code.next().unwrap_or_default();
        let modifiers = code.collect::<Vec<_>>();
        if qualifier != "HC"
            || procedure.len() != 5
            || !procedure.bytes().all(|c| c.is_ascii_alphanumeric())
            || modifiers.len() > 4
            || modifiers
                .iter()
                .any(|v| v.len() != 2 || !v.bytes().all(|c| c.is_ascii_alphanumeric()))
        {
            return Err(Error::Invalid("primary ERA adjudicated procedures require reviewed HC procedure/modifier evidence"));
        }
        paid += service.paid_cents;
    }
    if paid != row.paid_cents
        || row
            .adjustments
            .iter()
            .filter(|a| a.group == "PR")
            .map(|a| a.amount_cents)
            .sum::<i64>()
            != row.patient_responsibility_cents
        || row.adjustments.iter().any(|a| {
            a.amount_cents < 0
                || !["CO", "PR", "OA", "PI"].contains(&a.group.as_str())
                || a.reason_code.is_empty()
                || a.reason_code.len() > 5
                || !a.reason_code.bytes().all(|c| c.is_ascii_alphanumeric())
                || a.service_index.is_some_and(|i| i >= lines.len())
        })
        || row.paid_cents + row.adjustments.iter().map(|a| a.amount_cents).sum::<i64>()
            != row.charged_cents
    {
        return Err(Error::Invalid("primary COB payment and adjustment evidence must balance without duplicate adjustments"));
    }
    Ok(())
}

async fn primary_source(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    primary: &Claim,
    account: &Account,
) -> Result<(Value, claims::Remittance, Document, Details)> {
    validate_primary(primary, account)?;
    let head = crate::era_chains::head(tx, a, primary.id)
        .await?
        .ok_or(Error::Conflict(
            "post and review the primary remittance before secondary billing",
        ))?;
    if head["claim_version"] != json!(primary.version) {
        return Err(Error::Conflict(
            "primary remittance head changed; review current evidence",
        ));
    }
    let rid: Uuid = serde_json::from_value(head["remittance_id"].clone())
        .map_err(|_| Error::Invalid("invalid primary remittance identity"))?;
    let r = claims::remit_row(tx, a, rid).await?;
    if r.status != "posted" || r.payer_id != primary.payer_id {
        return Err(Error::Conflict(
            "primary remittance is no longer an active posted source",
        ));
    }
    let doc: Document = serde_json::from_value(r.document.clone())
        .map_err(|_| Error::Invalid("invalid primary remittance"))?;
    if !doc.validate()?.is_empty() {
        return Err(Error::Conflict(
            "resolve primary remittance validation issues",
        ));
    }
    let details:Option<Value>=sqlx::query_scalar("SELECT details FROM edi_submissions WHERE tenant_id=$1 AND claim_id=$2 AND status='delivered' ORDER BY created_at DESC,id DESC LIMIT 1").bind(a.tenant_id).bind(primary.id).fetch_optional(&mut **tx).await?;
    let details:Details=serde_json::from_value(details.ok_or(Error::Conflict("secondary billing requires the primary claim's delivered electronic subscriber and payer details"))?).map_err(|_|Error::Invalid("invalid primary electronic details"))?;
    Ok((head, r, doc, details))
}

pub(crate) async fn review(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    primary: &Claim,
    account: &Account,
) -> Result<Value> {
    let coverages:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('coverage',to_jsonb(c)-'tenant_id'-'creation_hash'-'request_id','payer',to_jsonb(p)-'tenant_id') FROM insurance_coverages c JOIN ehr_payers p ON p.tenant_id=c.tenant_id AND p.id=c.payer_id WHERE c.tenant_id=$1 AND c.patient_id=$2 AND c.content->>'priority'='secondary' AND c.content->>'status'='active' AND (c.content->>'effective_date')::date<=$3 AND (nullif(c.content->>'end_date','') IS NULL OR (c.content->>'end_date')::date>=$3) ORDER BY c.id").bind(a.tenant_id).bind(account.patient_id).bind(account.content["service_date"].as_str().and_then(|s|s.parse::<NaiveDate>().ok()).ok_or(Error::Invalid("invalid service date"))?).fetch_all(&mut **tx).await?;
    let existing:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'payer_id',payer_id,'status',status,'control_number',control_number) FROM ehr_claims WHERE tenant_id=$1 AND account_id=$2 AND status<>'void' AND jsonb_typeof(snapshot->'coordination_of_benefits')='object' ORDER BY created_at").bind(a.tenant_id).bind(account.id).fetch_all(&mut **tx).await?;
    let mut out = json!({"primary_claim":primary,"account":account,"coverages":coverages,"existing_secondary_claims":existing});
    match primary_source(tx, a, primary, account).await {
        Ok((head, r, doc, _)) => {
            let index = head["row_index"]
                .as_u64()
                .ok_or(Error::Invalid("invalid primary remittance row"))?
                as usize;
            let row = doc
                .claims
                .get(index)
                .ok_or(Error::Invalid("primary remittance row missing"))?;
            let credits = primary_credits(&r, primary.id, index, row)?;
            out["primary_adjudication"] = json!({"primary_credits":credits,"remittance_id":r.id,"remittance_version":r.version,"row_index":index,"payment_date":doc.payment_date,"trace":doc.trace,"claim":row});
            out["blockers"] = json!(if row.status == "19" {
                vec!["Primary payer reports forwarding this claim. Review the crossover instead of sending a duplicate."]
            } else if row.status != "1" {
                vec!["Primary remittance must report processed as primary before this secondary workflow."]
            } else {
                vec![]
            });
        }
        Err(error) => out["blockers"] = json!([error.to_string()]),
    }
    Ok(out)
}

fn primary_credits(
    r: &claims::Remittance,
    claim: Uuid,
    row: usize,
    adjudication: &RemitClaim,
) -> Result<Vec<Adjustment>> {
    let matches: Vec<claims::Match> = serde_json::from_value(r.matches.clone())
        .map_err(|_| Error::Invalid("invalid primary posting evidence"))?;
    let matched = matches
        .iter()
        .find(|m| m.claim_id == claim && m.row_index == row)
        .ok_or(Error::Conflict("primary posting match is unavailable"))?;
    matched
        .writeoff_adjustments
        .iter()
        .map(|i| {
            adjudication
                .adjustments
                .get(*i)
                .filter(|a| a.group == "CO")
                .cloned()
                .ok_or(Error::Invalid("invalid primary contractual credit"))
        })
        .collect()
}

pub(crate) fn repeats_primary_credit(e: &Evidence, adjustment: &Adjustment) -> bool {
    adjustment.group == "CO"
        && e.primary_credits.iter().any(|prior| {
            prior.amount_cents > 0
                && prior.reason_code == adjustment.reason_code
                && prior.service_index == adjustment.service_index
        })
}

pub(crate) async fn prepare(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    primary: &Claim,
    account: &mut Account,
    input: &Request,
) -> Result<Evidence> {
    text(&input.crossover_reference, 1000)?;
    if !input.not_forwarded_confirmed || !input.payer_timing_reviewed {
        return Err(Error::Invalid("review primary EOB crossover status and the secondary payer's submission timing before creating a secondary claim"));
    }
    let (head, r, doc, details) = primary_source(tx, a, primary, account).await?;
    if primary.version != input.primary_claim_version
        || r.id != input.remittance_id
        || r.version != input.remittance_version
        || head["row_index"] != json!(input.row_index)
    {
        return Err(Error::Conflict(
            "primary claim or remittance changed after review",
        ));
    }
    let row = doc
        .claims
        .get(input.row_index)
        .ok_or(Error::Invalid("invalid primary service row"))?;
    validate_adjudication(
        row,
        account.total_cents,
        &account.content,
        &input.paid_units,
    )?;
    let coverage:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('coverage',to_jsonb(c)-'tenant_id'-'creation_hash'-'request_id','payer',to_jsonb(p)-'tenant_id') FROM insurance_coverages c JOIN ehr_payers p ON p.tenant_id=c.tenant_id AND p.id=c.payer_id WHERE c.tenant_id=$1 AND c.patient_id=$2 AND c.id=$3 AND c.version=$4 AND c.content->>'priority'='secondary' AND c.content->>'status'='active' AND p.content->>'active'='true' AND c.payer_id<>$5 AND (c.content->>'effective_date')::date<=$6 AND (nullif(c.content->>'end_date','') IS NULL OR (c.content->>'end_date')::date>=$6)").bind(a.tenant_id).bind(account.patient_id).bind(input.coverage_id).bind(input.coverage_version).bind(primary.payer_id).bind(account.content["service_date"].as_str().and_then(|s|s.parse::<NaiveDate>().ok()).ok_or(Error::Invalid("invalid service date"))?).fetch_optional(&mut **tx).await?;
    let coverage = coverage.ok_or(Error::Conflict(
        "review current active secondary coverage for this service date",
    ))?;
    if coverage["payer"]["content"]["payer_code"]
        .as_str()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return Err(Error::Invalid(
            "secondary coverage requires a reviewed Claim.MD payer ID",
        ));
    }
    account.coverage_snapshot = Some(coverage);
    account.content["coverage_id"] = json!(input.coverage_id);
    Ok(Evidence {
        primary_claim_id: primary.id,
        primary_claim_version: primary.version,
        remittance_id: r.id,
        remittance_version: r.version,
        row_index: input.row_index,
        payment_date: doc.payment_date,
        trace: doc.trace.clone(),
        primary_coverage: primary.snapshot["account"]["coverage_snapshot"].clone(),
        primary_details: details,
        adjudication: row.clone(),
        paid_units: input.paid_units.clone(),
        primary_credits: primary_credits(&r, primary.id, input.row_index, row)?,
        crossover_reference: input.crossover_reference.clone(),
        not_forwarded_confirmed: true,
        payer_timing_reviewed: true,
    })
}

pub(crate) async fn validate_current(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    c: &Claim,
) -> Result<()> {
    let Some(e) = evidence(c)? else { return Ok(()) };
    let primary = claims::claim_row(tx, a, e.primary_claim_id).await?;
    let b = claims::account(tx, a, c.account_id, Some(c.patient_id)).await?;
    let (head, r, _, _) = primary_source(tx, a, &primary, &b).await?;
    if primary.version != e.primary_claim_version
        || r.id != e.remittance_id
        || r.version != e.remittance_version
        || head["row_index"] != json!(e.row_index)
    {
        return Err(Error::Conflict(
            "primary adjudication changed; review the secondary claim before proceeding",
        ));
    }
    Ok(())
}
