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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crossover: Option<CrossoverEvidence>,
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
            if row.status == "19" {
                out["crossover_candidates"] =
                    json!(crossover_candidates(tx, a, primary, account, &coverages).await?);
            }
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
        crossover: None,
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

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CrossoverRequest {
    pub coverage_id: Uuid,
    pub coverage_version: i64,
    pub primary_claim_version: i64,
    pub primary_remittance_id: Uuid,
    pub primary_remittance_version: i64,
    pub primary_row_index: usize,
    pub secondary_remittance_id: Uuid,
    pub secondary_remittance_version: i64,
    pub secondary_row_index: usize,
    pub linkage_confirmed: bool,
    pub linkage_reference: String,
}
#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct CrossoverEvidence {
    pub remittance_id: Uuid,
    pub remittance_version: i64,
    pub row_index: usize,
    pub document_hash: String,
    pub payment_date: NaiveDate,
    pub trace: String,
    pub payee_npi: String,
    pub claim: RemitClaim,
    pub linkage_reference: String,
}
pub(crate) fn tracking_only(c: &Claim) -> bool {
    c.snapshot["coordination_of_benefits"]["crossover"].is_object()
}
pub(crate) fn require_outbound(c: &Claim) -> Result<()> {
    if tracking_only(c) {
        return Err(Error::Conflict("crossover tracking records cannot be exported or submitted; review the received secondary remittance"));
    }
    Ok(())
}
fn received_crossover(
    r: &claims::Remittance,
    primary: &Claim,
    account: &Account,
    index: usize,
) -> Result<(Document, String)> {
    if !["staged", "reconciled"].contains(&r.status.as_str()) {
        return Err(Error::Conflict(
            "use an unposted received secondary remittance",
        ));
    }
    let raw = r.original_text.as_deref().ok_or(Error::Invalid(
        "crossover linkage requires retained original secondary835 with payee identity",
    ))?;
    let doc = crate::era835::parse(raw)?;
    if !doc.validate()?.is_empty()
        || claims::hash(&doc)? != r.document_hash
        || serde_json::to_value(&doc).map_err(|_| Error::Invalid("invalid secondary835"))?
            != r.document
    {
        return Err(Error::Conflict(
            "received secondary835 source does not match its validated retained document",
        ));
    }
    // The complete transaction has already passed the bounded parser above. Do
    // not infer a payee from other names or from the primary forwarding status.
    let raw = raw.trim();
    let (element, term) = if raw.starts_with("ISA") {
        (raw.as_bytes()[3] as char, raw.as_bytes()[105] as char)
    } else {
        ('*', '~')
    };
    let payees: Vec<_> = raw
        .split(term)
        .map(str::trim)
        .map(|s| s.split(element).collect::<Vec<_>>())
        .filter(|s| s.first() == Some(&"N1") && s.get(1) == Some(&"PE"))
        .collect();
    if payees.len() != 1
        || payees[0].get(3) != Some(&"XX")
        || payees[0].get(4).copied() != primary.content["billing_npi"].as_str()
    {
        return Err(Error::Conflict(
            "secondary835 payee NPI must match the frozen primary billing provider",
        ));
    }
    let npi = payees[0][4].to_owned();
    let service_date = account.content["service_date"]
        .as_str()
        .and_then(|date| date.parse::<NaiveDate>().ok())
        .ok_or(Error::Invalid("invalid original service date"))?
        .format("%Y%m%d")
        .to_string();
    let mut claim_index = None;
    let mut dates = vec![];
    for segment in raw.split(term).map(str::trim) {
        let fields = segment.split(element).collect::<Vec<_>>();
        if fields.first() == Some(&"CLP") {
            claim_index = Some(claim_index.map_or(0, |n: usize| n + 1));
        }
        if claim_index == Some(index)
            && fields.first() == Some(&"DTM")
            && fields.get(1) == Some(&"472")
        {
            dates.push(fields.get(2).copied().unwrap_or(""));
        }
    }
    if dates.is_empty() || dates.iter().any(|date| *date != service_date) {
        return Err(Error::Conflict(
            "secondary835 requires the exact original service date in DTM472 evidence",
        ));
    }
    let row = doc
        .claims
        .get(index)
        .ok_or(Error::Invalid("secondary remittance row is missing"))?;
    if !["2", "20", "4"].contains(&row.status.as_str())
        || row.control_number != primary.control_number
        || row.payer_control_number.is_empty()
    {
        return Err(Error::Conflict("secondary835 must report secondary adjudication or denial with the exact original patient control and payer claim identity"));
    }
    let mut comparison = row.clone();
    comparison.status = "1".into();
    validate_adjudication(
        &comparison,
        account.total_cents,
        &account.content,
        &vec![1; row.services.len()],
    )?;
    let lines = account.content["lines"]
        .as_array()
        .ok_or(Error::Invalid("missing account services"))?;
    for (service, line) in row.services.iter().zip(lines) {
        let mut expected = format!("HC:{}", line["code"].as_str().unwrap_or(""));
        for modifier in line["modifiers"]
            .as_str()
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            expected.push(':');
            expected.push_str(modifier);
        }
        if service.code != expected {
            return Err(Error::Conflict(
                "secondary835 procedure and modifiers must exactly match the original service",
            ));
        }
    }
    let matches: Vec<claims::Match> = serde_json::from_value(r.matches.clone())
        .map_err(|_| Error::Invalid("invalid secondary remittance matches"))?;
    if matches.iter().any(|m| m.row_index == index) {
        return Err(Error::Conflict(
            "secondary remittance row already has a native claim match",
        ));
    }
    Ok((doc, npi))
}
async fn crossover_used(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    index: usize,
) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ehr_claims WHERE tenant_id=$1 AND status<>'void' AND snapshot->'coordination_of_benefits'->'crossover'->>'remittance_id'=$2 AND snapshot->'coordination_of_benefits'->'crossover'->>'row_index'=$3)").bind(a.tenant_id).bind(id.to_string()).bind(index.to_string()).fetch_one(&mut **tx).await?)
}
async fn crossover_candidates(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    primary: &Claim,
    account: &Account,
    coverages: &[Value],
) -> Result<Vec<Value>> {
    let rows:Vec<claims::Remittance>=sqlx::query_as("SELECT * FROM era_remittances WHERE tenant_id=$1 AND status IN ('staged','reconciled') AND EXISTS(SELECT 1 FROM jsonb_array_elements(document->'claims') r WHERE r->>'control_number'=$2) ORDER BY created_at DESC,id LIMIT 101").bind(a.tenant_id).bind(&primary.control_number).fetch_all(&mut **tx).await?;
    if rows.len() > 100 {
        return Err(Error::Conflict(
            "received crossover search exceeds review limit",
        ));
    }
    let mut result = vec![];
    for remit in rows {
        for coverage in coverages {
            if coverage["payer"]["id"] != json!(remit.payer_id)
                || coverage["payer"]["content"]["active"] != true
            {
                continue;
            }
            let doc: Document = serde_json::from_value(remit.document.clone())
                .map_err(|_| Error::Invalid("invalid received remittance"))?;
            for (index, row) in doc.claims.iter().enumerate() {
                if row.control_number != primary.control_number
                    || crossover_used(tx, a, remit.id, index).await?
                {
                    continue;
                }
                if let Ok((validated, npi)) = received_crossover(&remit, primary, account, index) {
                    if validated.payer_code
                        == coverage["payer"]["content"]["payer_code"]
                            .as_str()
                            .unwrap_or("")
                    {
                        result.push(json!({"remittance_id":remit.id,"remittance_version":remit.version,"row_index":index,"coverage_id":coverage["coverage"]["id"],"coverage_version":coverage["coverage"]["version"],"payer_name":coverage["payer"]["content"]["name"],"trace":validated.trace,"payment_date":validated.payment_date,"payee_npi":npi,"claim":row}));
                    }
                }
            }
        }
    }
    Ok(result)
}
pub(crate) async fn prepare_crossover(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    primary: &Claim,
    account: &mut Account,
    input: &CrossoverRequest,
) -> Result<Evidence> {
    text(&input.linkage_reference, 1000)?;
    if !input.linkage_confirmed {
        return Err(Error::Invalid(
            "explicitly review the primary crossover and received secondary835 linkage",
        ));
    }
    let (head, r, doc, details) = primary_source(tx, a, primary, account).await?;
    let row = doc
        .claims
        .get(input.primary_row_index)
        .ok_or(Error::Invalid("primary remittance row missing"))?;
    if primary.version != input.primary_claim_version
        || r.id != input.primary_remittance_id
        || r.version != input.primary_remittance_version
        || head["row_index"] != json!(input.primary_row_index)
        || row.status != "19"
    {
        return Err(Error::Conflict("review the current posted primaryCLP19 crossover before linking a received secondary835"));
    }
    let mut primary_comparison = row.clone();
    primary_comparison.status = "1".into();
    validate_adjudication(
        &primary_comparison,
        account.total_cents,
        &account.content,
        &vec![1; row.services.len()],
    )?;
    let coverage:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('coverage',to_jsonb(c)-'tenant_id'-'creation_hash'-'request_id','payer',to_jsonb(p)-'tenant_id') FROM insurance_coverages c JOIN ehr_payers p ON p.tenant_id=c.tenant_id AND p.id=c.payer_id WHERE c.tenant_id=$1 AND c.patient_id=$2 AND c.id=$3 AND c.version=$4 AND c.content->>'priority'='secondary' AND c.content->>'status'='active' AND p.content->>'active'='true' AND c.payer_id<>$5 AND (c.content->>'effective_date')::date<=$6 AND (nullif(c.content->>'end_date','') IS NULL OR (c.content->>'end_date')::date>=$6)").bind(a.tenant_id).bind(account.patient_id).bind(input.coverage_id).bind(input.coverage_version).bind(primary.payer_id).bind(account.content["service_date"].as_str().and_then(|s|s.parse::<NaiveDate>().ok()).ok_or(Error::Invalid("invalid service date"))?).fetch_optional(&mut **tx).await?;
    let coverage = coverage.ok_or(Error::Conflict(
        "review current effective secondary payer coverage",
    ))?;
    let secondary = claims::remit_row(tx, a, input.secondary_remittance_id).await?;
    if secondary.version != input.secondary_remittance_version
        || coverage["payer"]["id"] != json!(secondary.payer_id)
        || crossover_used(tx, a, secondary.id, input.secondary_row_index).await?
    {
        return Err(Error::Conflict(
            "secondary835 version, payer or existing source binding changed",
        ));
    }
    let (received, npi) =
        received_crossover(&secondary, primary, account, input.secondary_row_index)?;
    if received.payer_code
        != coverage["payer"]["content"]["payer_code"]
            .as_str()
            .unwrap_or("")
    {
        return Err(Error::Conflict(
            "secondary835 payer identifier differs from the reviewed policy",
        ));
    }
    let crossover = CrossoverEvidence {
        remittance_id: secondary.id,
        remittance_version: secondary.version,
        row_index: input.secondary_row_index,
        document_hash: secondary.document_hash,
        payment_date: received.payment_date,
        trace: received.trace.clone(),
        payee_npi: npi,
        claim: received.claims[input.secondary_row_index].clone(),
        linkage_reference: input.linkage_reference.clone(),
    };
    account.coverage_snapshot = Some(coverage);
    account.content["coverage_id"] = json!(input.coverage_id);
    Ok(Evidence {
        primary_claim_id: primary.id,
        primary_claim_version: primary.version,
        remittance_id: r.id,
        remittance_version: r.version,
        row_index: input.primary_row_index,
        payment_date: doc.payment_date,
        trace: doc.trace.clone(),
        primary_coverage: primary.snapshot["account"]["coverage_snapshot"].clone(),
        primary_details: details,
        adjudication: row.clone(),
        paid_units: vec![],
        primary_credits: primary_credits(&r, primary.id, input.primary_row_index, row)?,
        crossover_reference: input.linkage_reference.clone(),
        not_forwarded_confirmed: false,
        payer_timing_reviewed: false,
        crossover: Some(crossover),
    })
}
