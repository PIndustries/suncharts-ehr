// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Local claim packets and reviewed ERA posting. No clearinghouse or payment transport.
use crate::{
    auth::Actor,
    billing,
    era835::{self, Document},
    error::{Error, Result},
    model::text,
    State,
};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State as ExtractState},
    http::{header, HeaderMap},
    response::Html,
    routing::{get, post, put},
    Json, Router,
};
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Acquire, PgPool, Postgres, Transaction};
use uuid::Uuid;
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
pub(crate) fn hash<T: Serialize>(v: &T) -> Result<String> {
    Ok(crate::oauth::hash(
        &serde_json::to_string(v).map_err(|_| Error::Invalid("invalid claim request"))?,
    ))
}
fn bounded(v: &str, n: usize) -> Result<()> {
    if v.chars().count() > n {
        Err(Error::Invalid("claim text too long"))
    } else {
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimContent {
    pub billing_provider_name: String,
    pub billing_npi: String,
    pub tax_id: String,
    pub billing_address: String,
    pub rendering_npi: String,
    pub patient_address: String,
    pub subscriber_address: String,
    pub subscriber_birth_date: Option<NaiveDate>,
    pub place_of_service: String,
    pub diagnosis_codes: Vec<String>,
    pub line_diagnosis_pointers: Vec<Vec<usize>>,
    pub external_control_number: String,
    pub notes: String,
    /// Marks a deliberately synthetic claim used to validate an external
    /// clearinghouse lifecycle. This never makes real patient data synthetic;
    /// callers must use a synthetic patient and reviewed test evidence.
    #[serde(default)]
    pub synthetic_test: bool,
}
impl ClaimContent {
    fn validate(&self) -> Result<()> {
        for (s, n) in [
            (&self.billing_provider_name, 200),
            (&self.billing_npi, 10),
            (&self.tax_id, 9),
            (&self.billing_address, 1000),
            (&self.rendering_npi, 10),
            (&self.patient_address, 1000),
            (&self.subscriber_address, 1000),
            (&self.place_of_service, 2),
            (&self.external_control_number, 100),
            (&self.notes, 2000),
        ] {
            bounded(s, n)?;
        }
        if self.diagnosis_codes.len() > 12
            || self.diagnosis_codes.iter().any(|c| c.len() > 20)
            || self.line_diagnosis_pointers.len() > 100
            || self.line_diagnosis_pointers.iter().any(|p| p.len() > 4)
            || self
                .subscriber_birth_date
                .is_some_and(|d| d > Utc::now().date_naive())
        {
            return Err(Error::Invalid(
                "invalid claim diagnoses, pointers or subscriber date",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize, sqlx::FromRow)]
pub(crate) struct Claim {
    pub(crate) id: Uuid,
    pub(crate) patient_id: Uuid,
    pub(crate) account_id: Uuid,
    pub(crate) payer_id: Uuid,
    pub(crate) control_number: String,
    pub(crate) frequency: String,
    pub(crate) parent_id: Option<Uuid>,
    pub(crate) content: Value,
    pub(crate) snapshot: Value,
    pub(crate) status: String,
    pub(crate) version: i64,
    pub(crate) payer_control_number: String,
    pub(crate) source_history_id: Option<Uuid>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NewClaim {
    request_id: Uuid,
    source_history_id: Option<Uuid>,
    parent_id: Option<Uuid>,
    frequency: String,
    content: ClaimContent,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditClaim {
    content: ClaimContent,
    reason: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Action {
    action: String,
    reason: String,
    #[serde(default)]
    reference: String,
    event_date: Option<NaiveDate>,
    #[serde(default)]
    payer_control_number: String,
}
#[derive(Clone, Serialize, sqlx::FromRow)]
pub(crate) struct Remittance {
    pub(crate) id: Uuid,
    pub(crate) payer_id: Uuid,
    pub(crate) trace: String,
    pub(crate) document: Value,
    pub(crate) original_text: Option<String>,
    pub(crate) document_hash: String,
    pub(crate) status: String,
    pub(crate) version: i64,
    pub(crate) matches: Value,
    pub(crate) source_history_id: Option<Uuid>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Match {
    pub(crate) row_index: usize,
    pub(crate) claim_id: Uuid,
    pub(crate) claim_version: i64,
    pub(crate) account_version: i64,
    pub(crate) writeoff_adjustments: Vec<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reverses_remittance_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reverses_row_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) correction_of_remittance_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) correction_of_row_index: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Matches {
    matches: Vec<Match>,
    reason: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Import {
    request_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_report_id: Option<Uuid>,
    payer_id: Uuid,
    format: String,
    document: Option<Document>,
    original_text: Option<String>,
    source_history_id: Option<Uuid>,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    after: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClaimListQuery {
    after: Option<Uuid>,
    patient_id: Option<Uuid>,
    account_id: Option<Uuid>,
}
pub(crate) async fn claim_row(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
) -> Result<Claim> {
    sqlx::query_as("SELECT * FROM ehr_claims WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
pub(crate) async fn remit_row(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
) -> Result<Remittance> {
    sqlx::query_as("SELECT * FROM era_remittances WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
pub(crate) async fn account(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    p: Option<Uuid>,
) -> Result<billing::Account> {
    sqlx::query_as("SELECT * FROM billing_accounts WHERE tenant_id=$1 AND id=$2 AND ($3::uuid IS NULL OR patient_id=$3)").bind(a.tenant_id).bind(id).bind(p).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn source(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    p: Option<Uuid>,
    kind: &str,
) -> Result<()> {
    let yes:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM historical_records WHERE tenant_id=$1 AND id=$2 AND kind=$3 AND patient_id IS NOT DISTINCT FROM $4)").bind(a.tenant_id).bind(id).bind(kind).bind(p).fetch_one(&mut **tx).await?;
    if yes {
        Ok(())
    } else {
        Err(Error::NotFound)
    }
}
pub(crate) async fn revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    reason: &str,
    evidence: Value,
) -> Result<Claim> {
    let c = claim_row(tx, a, id).await?;
    sqlx::query("INSERT INTO claim_revisions (tenant_id,claim_id,version,snapshot,actor_id,reason,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7)").bind(a.tenant_id).bind(id).bind(c.version).bind(json!(c)).bind(a.sub).bind(reason).bind(evidence).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "claim.change", id).await?;
    Ok(c)
}
pub(crate) async fn remit_revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    reason: &str,
) -> Result<Remittance> {
    let r = remit_row(tx, a, id).await?;
    sqlx::query("INSERT INTO era_revisions (tenant_id,remittance_id,version,snapshot,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(r.version).bind(json!({"status":r.status,"matches":r.matches,"document_hash":r.document_hash})).bind(a.sub).bind(reason).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "remittance.change", id).await?;
    Ok(r)
}
fn npi(s: &str) -> bool {
    if s.len() != 10 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let digits = format!("80840{s}");
    digits
        .bytes()
        .rev()
        .enumerate()
        .map(|(i, b)| {
            let mut n = (b - b'0') as u32;
            if i % 2 == 1 {
                n *= 2;
                if n > 9 {
                    n -= 9;
                }
            }
            n
        })
        .sum::<u32>()
        % 10
        == 0
}
fn new_control_number(id: Uuid, synthetic: bool) -> String {
    // Preserve the synthetic marker while keeping every new PCN within the
    // 17-character payer interoperability limit. Existing PCNs are immutable.
    let prefix = if synthetic { "SCTEST" } else { "SC" };
    let mut value = id.as_u128();
    let mut suffix = vec![b'0'; 17 - prefix.len()];
    for byte in suffix.iter_mut().rev() {
        *byte = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[(value % 36) as usize];
        value /= 36;
    }
    format!("{prefix}{}", String::from_utf8(suffix).expect("ASCII PCN"))
}

pub(crate) fn preflight(c: &Claim) -> Result<Vec<String>> {
    let p: ClaimContent = serde_json::from_value(c.content.clone())
        .map_err(|_| Error::Invalid("invalid stored claim content"))?;
    let mut issues = vec![];
    for (v, label) in [
        (&p.billing_provider_name, "Billing provider name"),
        (&p.tax_id, "Tax ID"),
        (&p.billing_address, "Billing address"),
        (&p.patient_address, "Patient address"),
        (&p.subscriber_address, "Subscriber address"),
    ] {
        if v.trim().is_empty() {
            issues.push(format!("{label} is required"));
        }
    }
    if !npi(&p.billing_npi) || !npi(&p.rendering_npi) {
        issues.push("Billing and rendering NPIs require valid check digits".into());
    }
    if p.tax_id.len() != 9 || !p.tax_id.bytes().all(|b| b.is_ascii_digit()) {
        issues.push("Tax ID must contain nine digits".into());
    }
    if p.place_of_service.len() != 2 || !p.place_of_service.bytes().all(|b| b.is_ascii_digit()) {
        issues.push("Two-digit place of service is required".into());
    }
    if p.subscriber_birth_date.is_none() {
        issues.push("Subscriber date of birth is required".into());
    }
    if p.diagnosis_codes.is_empty()
        || p.diagnosis_codes
            .iter()
            .any(|c| c.is_empty() || !c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.'))
    {
        issues.push("Supply 1 to 12 reviewed ICD-10-CM diagnosis codes".into());
    }
    let lines = c.snapshot["account"]["content"]["lines"]
        .as_array()
        .ok_or(Error::Invalid("claim snapshot lacks charges"))?;
    if p.line_diagnosis_pointers.len() != lines.len()
        || p.line_diagnosis_pointers.iter().any(|pointers| {
            let unique: std::collections::HashSet<_> = pointers.iter().collect();
            pointers.is_empty()
                || unique.len() != pointers.len()
                || pointers
                    .iter()
                    .any(|i| *i == 0 || *i > p.diagnosis_codes.len())
        })
    {
        issues.push("Every charge line requires 1 to 4 valid diagnosis pointers".into());
    }
    let payer = &c.snapshot["account"]["coverage_snapshot"]["payer"]["content"];
    if payer["payer_code"].as_str().unwrap_or("").trim().is_empty() {
        issues.push("Claim.MD payer ID is missing from the frozen payer mapping. Open the charge account and payer mapping, add the correct Claim.MD payer ID, then post a new insured account before preparing the electronic claim".into());
    }
    if payer["name"].as_str().unwrap_or("").trim().is_empty() {
        issues.push("Payer name is required".into());
    }
    Ok(issues)
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/billing/claims", get(claims))
        .route(
            "/api/v1/patients/{p}/billing/accounts/{account}/claims",
            post(create_claim),
        )
        .route(
            "/api/v1/billing/claims/{id}",
            get(claim_detail).put(edit_claim),
        )
        .route("/api/v1/billing/claims/{id}/actions", post(claim_action))
        .route("/api/v1/billing/claims/{id}/packet", get(packet))
        .route("/api/v1/billing/claims/{id}/cms1500", get(cms1500))
        .route("/api/v1/billing/claims/{id}/history", get(claim_history))
        .route(
            "/api/v1/billing/remittances",
            get(remittances)
                .post(import_remittance)
                .layer(DefaultBodyLimit::max(4 * era835::MAX_FILE_BYTES)),
        )
        .route("/api/v1/billing/remittances/{id}", get(remit_detail))
        .route(
            "/api/v1/billing/remittances/{id}/matches",
            put(match_remittance).layer(DefaultBodyLimit::max(era835::MAX_FILE_BYTES)),
        )
        .route(
            "/api/v1/billing/remittances/{id}/actions",
            post(remit_action),
        )
        .route(
            "/api/v1/billing/remittances/{id}/history",
            get(remit_history),
        )
        .route(
            "/api/v1/patients/{p}/history/{id}/claim-mapping",
            get(claim_mapping),
        )
        .route("/api/v1/billing/remittance-sources", get(remit_sources))
}
async fn claims(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<ClaimListQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let mut rows:Vec<Value>=sqlx::query_scalar("SELECT (to_jsonb(c)-'tenant_id'-'creation_hash'-'request_id'-'content'-'snapshot')||jsonb_build_object('patient_name',p.family_name||', '||p.given_name,'total_cents',c.snapshot->'account'->'total_cents','payer_name',c.snapshot->'account'->'coverage_snapshot'->'payer'->'content'->>'name','synthetic_test',coalesce((c.content->>'synthetic_test')::boolean,false)) FROM ehr_claims c JOIN patients p ON p.tenant_id=c.tenant_id AND p.id=c.patient_id WHERE c.tenant_id=$1 AND ($2::uuid IS NULL OR c.id>$2) AND ($3::uuid IS NULL OR c.patient_id=$3) AND ($4::uuid IS NULL OR c.account_id=$4) ORDER BY c.id LIMIT 101").bind(a.tenant_id).bind(q.after).bind(q.patient_id).bind(q.account_id).fetch_all(&mut *tx).await?;
    let next = if rows.len() > 100 {
        rows.truncate(100);
        rows.last().map(|r| r["id"].clone())
    } else {
        None
    };
    crate::postgres::audit(&mut tx, &a, "claim.worklist", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":rows,"next_cursor":next})))
}
async fn create_claim(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<NewClaim>,
) -> Result<Json<Claim>> {
    a.scheduling()?;
    v.content.validate()?;
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    let digest = hash(&(p, id, &v))?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let old: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,creation_hash FROM ehr_claims WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((id, prior)) = old {
        if prior != digest {
            return Err(Error::Conflict(
                "claim request ID reused with changed content",
            ));
        }
        return Ok(Json(claim_row(&mut tx, &a, id).await?));
    }
    let b = account(&mut tx, &a, id, Some(p)).await?;
    if b.status != "posted" || b.version != version {
        return Err(Error::Conflict(
            "create a claim from the current posted billing account",
        ));
    }
    let payer_id: Uuid = serde_json::from_value(
        b.coverage_snapshot
            .as_ref()
            .ok_or(Error::Invalid("insurance coverage is required for a claim"))?["payer"]["id"]
            .clone(),
    )
    .map_err(|_| Error::Invalid("invalid payer snapshot"))?;
    match (v.frequency.as_str(), v.parent_id) {
        ("original", None) => {}
        ("original", Some(parent)) => {
            let prior = claim_row(&mut tx, &a, parent).await?;
            if prior.account_id != id
                || prior.payer_id != payer_id
                || prior.status != "rejected"
                || !prior.payer_control_number.is_empty()
            {
                return Err(Error::Conflict("original resubmission requires a linked rejected claim without a payer control number"));
            }
        }
        ("replacement" | "void_request", Some(parent)) => {
            let prior = claim_row(&mut tx, &a, parent).await?;
            if prior.account_id != id
                || prior.payer_id != payer_id
                || !["rejected", "adjudicated"].contains(&prior.status.as_str())
                || prior.payer_control_number.is_empty()
            {
                return Err(Error::Conflict("replacement/void request requires a rejected or adjudicated claim on this account with a payer control number"));
            }
        }
        _ => {
            return Err(Error::Invalid(
                "choose original, or a linked replacement/void request",
            ))
        }
    }
    let prior_original:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ehr_claims WHERE tenant_id=$1 AND account_id=$2 AND frequency='original' AND status<>'void')").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
    if v.frequency == "original" && v.parent_id.is_none() && prior_original {
        return Err(Error::Conflict(
            "create a linked replacement rather than another original claim",
        ));
    }
    if let Some(source_id) = v.source_history_id {
        source(&mut tx, &a, source_id, Some(p), "claim").await?;
    }
    let patient: Value = sqlx::query_scalar(
        "SELECT to_jsonb(p)-'tenant_id' FROM patients p WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(p)
    .fetch_one(&mut *tx)
    .await?;
    let mut ledger: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object(\
            'patient_payments_cents',coalesce(-sum(effect_cents) FILTER (WHERE kind='payment' AND content->>'party'='patient'),0),\
            'insurer_payments_cents',coalesce(-sum(effect_cents) FILTER (WHERE kind='payment' AND content->>'party'='insurer'),0),\
            'other_payments_cents',coalesce(-sum(effect_cents) FILTER (WHERE kind='payment' AND content->>'party'='other'),0),\
            'credits_cents',coalesce(-sum(effect_cents) FILTER (WHERE kind='adjustment_credit'),0),\
            'debits_cents',coalesce(sum(effect_cents) FILTER (WHERE kind='adjustment_debit'),0),\
            'net_ledger_effect_cents',coalesce(sum(effect_cents),0),\
            'open_balance_cents',$3+coalesce(sum(effect_cents),0),\
            'claim_charge_cents',$3,\
            'scope','frozen_at_claim_creation'\
         ) FROM billing_entries WHERE tenant_id=$1 AND account_id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .bind(b.total_cents)
    .fetch_one(&mut *tx)
    .await?;
    ledger["patient_payments_cents"] = json!(
        crate::billing::patient_ledger_totals(&mut tx, a.tenant_id, id)
            .await?
            .1
    );
    let claim = Uuid::new_v4();
    let control_number = new_control_number(claim, v.content.synthetic_test);
    sqlx::query("INSERT INTO ehr_claims (tenant_id,id,patient_id,account_id,payer_id,control_number,frequency,parent_id,content,snapshot,request_id,creation_hash,source_history_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)").bind(a.tenant_id).bind(claim).bind(p).bind(id).bind(payer_id).bind(control_number).bind(v.frequency).bind(v.parent_id).bind(json!(v.content)).bind(json!({"account":b,"patient":patient,"financial_summary":ledger})).bind(v.request_id).bind(digest).bind(v.source_history_id).execute(&mut *tx).await?;
    let c = revision(&mut tx, &a, claim, &v.reason, json!({"transport":"none"})).await?;
    tx.commit().await?;
    Ok(Json(c))
}
async fn claim_detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let c = claim_row(&mut tx, &a, id).await?;
    let issues = preflight(&c)?;
    let submission_defaults = claim_submission_defaults(&mut tx, &a, &c).await?;
    let tracking = crate::retrieval::claim_tracking(&mut tx, &a, &c).await?;
    let artifact_generated: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM edi_submissions WHERE tenant_id=$1 AND claim_id=$2)",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    crate::postgres::audit(&mut tx, &a, "claim.read", id).await?;
    tx.commit().await?;
    let transport = clearinghouse_transport(db(&s)?, a.tenant_id, artifact_generated).await?;
    Ok(Json(
        json!({"claim":c,"preflight_issues":issues,"transport":transport,"submission_defaults":submission_defaults,"tracking":tracking}),
    ))
}

fn x12_sex(value: Option<&str>) -> &'static str {
    match value
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "female" | "f" => "F",
        "male" | "m" => "M",
        _ => "U",
    }
}

fn split_person_name(value: &str) -> (String, String) {
    let value = value.trim();
    if let Some((family, given)) = value.split_once(',') {
        return (given.trim().to_string(), family.trim().to_string());
    }
    let mut parts = value.split_whitespace().collect::<Vec<_>>();
    if parts.len() < 2 {
        return (value.to_string(), String::new());
    }
    let family = parts.pop().unwrap_or_default().to_string();
    (parts.join(" "), family)
}

fn structured_x12_address(content: Option<&Value>) -> Value {
    let address = content
        .and_then(|value| value.get("address"))
        .unwrap_or(&Value::Null);
    json!({
        "line1": address.get("line1").and_then(Value::as_str).unwrap_or_default(),
        "line2": address.get("line2").and_then(Value::as_str).unwrap_or_default(),
        "city": address.get("city").and_then(Value::as_str).unwrap_or_default(),
        "state": address.get("region").or_else(|| address.get("state")).and_then(Value::as_str).unwrap_or_default(),
        "postal_code": address.get("postal_code").and_then(Value::as_str).unwrap_or_default(),
    })
}

async fn claim_submission_defaults(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    claim: &Claim,
) -> Result<Value> {
    let demographics: Option<Value> = sqlx::query_scalar(
        "SELECT content FROM patient_demographics WHERE tenant_id=$1 AND patient_id=$2",
    )
    .bind(a.tenant_id)
    .bind(claim.patient_id)
    .fetch_optional(&mut **tx)
    .await?;
    let rendering_npi = claim.content["rendering_npi"].as_str().unwrap_or_default();
    let provider_name: Option<String> = if rendering_npi.is_empty() {
        None
    } else {
        sqlx::query_scalar("SELECT display_name FROM practice_providers WHERE tenant_id=$1 AND active AND npi=$2 ORDER BY id LIMIT 1")
            .bind(a.tenant_id)
            .bind(rendering_npi)
            .fetch_optional(&mut **tx)
            .await?
    };
    let patient = &claim.snapshot["patient"];
    let coverage = &claim.snapshot["account"]["coverage_snapshot"]["coverage"]["content"];
    let payer = &claim.snapshot["account"]["coverage_snapshot"]["payer"]["content"];
    let relationship = coverage["relationship"].as_str().unwrap_or_default();
    let patient_given = patient["given_name"].as_str().unwrap_or_default();
    let patient_family = patient["family_name"].as_str().unwrap_or_default();
    let (subscriber_given, subscriber_family) = if relationship == "self" {
        (patient_given.to_string(), patient_family.to_string())
    } else {
        split_person_name(coverage["subscriber_name"].as_str().unwrap_or_default())
    };
    let (rendering_given, rendering_family) = provider_name
        .as_deref()
        .map(split_person_name)
        .unwrap_or_default();
    let patient_sex = x12_sex(
        demographics
            .as_ref()
            .and_then(|value| value["administrative_gender"].as_str()),
    );
    let patient_address = structured_x12_address(demographics.as_ref());
    let subscriber_address = if relationship == "self" {
        patient_address.clone()
    } else {
        json!({"line1":"","line2":"","city":"","state":"","postal_code":""})
    };
    Ok(json!({
        "subscriber_given_name": subscriber_given,
        "subscriber_family_name": subscriber_family,
        "patient_sex": patient_sex,
        "subscriber_sex": if relationship == "self" { patient_sex } else { "U" },
        "rendering_given_name": rendering_given,
        "rendering_family_name": rendering_family,
        "billing_taxonomy": "",
        "filing_indicator": "CI",
        "billing_address": {"line1":"","line2":"","city":"","state":"","postal_code":""},
        "subscriber_address": subscriber_address,
        "patient_address": patient_address,
        "payer_address": {"line1":"","line2":"","city":"","state":"","postal_code":""},
        "source_references": {
            "billing_address": claim.content["billing_address"].as_str().unwrap_or_default(),
            "payer_address": payer["address"].as_str().unwrap_or_default(),
            "provider_name": provider_name.unwrap_or_default(),
        }
    }))
}

async fn clearinghouse_transport(
    pool: &PgPool,
    tenant: Uuid,
    artifact_generated: bool,
) -> Result<Value> {
    let config = crate::provider_settings::load_for_tenant(pool, tenant).await?;
    let routes = config
        .routes
        .iter()
        .filter(|route| route.tenant_id == tenant)
        .map(|route| {
            json!({
                "route_key": route.key,
                "provider": route.adapter,
                "usage": route.usage,
                "delivery_configured": route.credential_value.is_some()
                    || route.credential_env.as_ref().is_none_or(|name| {
                        std::env::var(name).is_ok_and(|value| !value.trim().is_empty())
                    }),
                "retrieval_configured": route.retrieval.is_some(),
            })
        })
        .collect::<Vec<_>>();
    let retrieval_health: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('route_key',route_key,'paused',paused,'last_result',last_result,'last_poll_at',last_poll_at,'last_success_at',last_success_at) FROM edi_connections WHERE tenant_id=$1 ORDER BY route_key",
    )
    .bind(tenant)
    .fetch_all(pool)
    .await?;
    let claimmd_connected = routes
        .iter()
        .any(|route| route["provider"] == "claim_md" && route["delivery_configured"] == true);
    Ok(json!({
        "scope": "clearinghouse",
        "configured": !routes.is_empty(),
        "claimmd_connected": claimmd_connected,
        "routes": routes,
        "artifact": if artifact_generated { "generated" } else { "not_generated" },
        "retrieval_health": retrieval_health,
        "connect_wss_related": false,
    }))
}
async fn edit_claim(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<EditClaim>,
) -> Result<Json<Claim>> {
    a.scheduling()?;
    v.content.validate()?;
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let c = claim_row(&mut tx, &a, id).await?;
    if c.status != "draft" || c.version != version {
        return Err(Error::Conflict(
            "only the current draft claim can be edited",
        ));
    }
    sqlx::query("UPDATE ehr_claims SET content=$3,version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .bind(json!(v.content))
        .execute(&mut *tx)
        .await?;
    let c = revision(&mut tx, &a, id, &v.reason, json!({})).await?;
    tx.commit().await?;
    Ok(Json(c))
}
async fn claim_action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Action>,
) -> Result<Json<Claim>> {
    a.scheduling()?;
    text(&v.reason, 1000)?;
    bounded(&v.reference, 200)?;
    bounded(&v.payer_control_number, 150)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let c = claim_row(&mut tx, &a, id).await?;
    if c.version != version {
        return Err(Error::Conflict(
            "claim changed; reload before recording event",
        ));
    }
    crate::delivery::ensure_claim_unreserved(&mut tx, &a, id).await?;
    let status = match (v.action.as_str(), c.status.as_str()) {
        ("ready", "draft") => {
            if !preflight(&c)?.is_empty() {
                return Err(Error::Conflict(
                    "resolve claim preflight issues before releasing the packet",
                ));
            }
            "ready"
        }
        ("record_submission", "ready") => "submitted",
        ("record_acceptance", "submitted") => {
            text(&v.payer_control_number, 150)?;
            "accepted"
        }
        ("record_rejection", "submitted" | "accepted") => "rejected",
        ("void_draft", "draft" | "ready") => "void",
        _ => return Err(Error::Conflict("claim event is not allowed in this state")),
    };
    if v.action.starts_with("record_") {
        text(&v.reference, 200)?;
        if v.event_date.is_none_or(|d| d > Utc::now().date_naive()) {
            return Err(Error::Invalid(
                "record an external evidence reference and nonfuture event date",
            ));
        }
    }
    let payer_control = if v.action.starts_with("record_") {
        v.payer_control_number.as_str()
    } else {
        ""
    };
    sqlx::query("UPDATE ehr_claims SET status=$3,version=version+1,payer_control_number=CASE WHEN $4='' THEN payer_control_number ELSE $4 END WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(status).bind(payer_control).execute(&mut *tx).await?;
    let c=revision(&mut tx,&a,id,&v.reason,json!({"action":v.action,"reference":v.reference,"event_date":v.event_date,"payer_control_number":v.payer_control_number,"evidence_origin":"staff_recorded_external"})).await?;
    tx.commit().await?;
    Ok(Json(c))
}
async fn packet(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<impl axum::response::IntoResponse> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let c = claim_row(&mut tx, &a, id).await?;
    if ["draft", "void"].contains(&c.status.as_str()) {
        return Err(Error::Conflict(
            "release a reviewed claim before exporting a packet",
        ));
    }
    let parent = if let Some(id) = c.parent_id {
        Some(claim_row(&mut tx, &a, id).await?.payer_control_number)
    } else {
        None
    };
    crate::postgres::audit(&mut tx, &a, "claim.packet_export", id).await?;
    tx.commit().await?;
    Ok((
        [(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=claim-{}.json", c.control_number),
        )],
        Json(
            json!({"format":"suncharts-professional-claim-preview-v1","not_x12_837":true,"claim":c,"original_payer_control_number":parent,"delivery":"not_transmitted"}),
        ),
    ))
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn json_text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
async fn cms1500(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Html<String>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let c = claim_row(&mut tx, &a, id).await?;
    let content: ClaimContent = serde_json::from_value(c.content.clone())
        .map_err(|_| Error::Invalid("invalid claim content"))?;
    let account = &c.snapshot["account"];
    let patient = &c.snapshot["patient"];
    let coverage = &account["coverage_snapshot"];
    let payer = &coverage["payer"]["content"];
    let policy = &coverage["coverage"]["content"];
    let mut line_rows = account["content"]["lines"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let pointers = content
                .line_diagnosis_pointers
                .get(index)
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            let cents = line.get("amount_cents").and_then(Value::as_i64).unwrap_or(0);
            format!("<tr><td>{0}</td><td>{0}</td><td>{1}</td><td></td><td class=procedure>{2}<small>{3}</small></td><td>{4}</td><td class=charge>${5}.{6:02}</td><td>1</td><td></td><td>{7}</td></tr>",
                html_escape(json_text(&account["content"], "service_date")), html_escape(&content.place_of_service),
                html_escape(json_text(line, "code")), html_escape(json_text(line, "description")), html_escape(&pointers),
                cents / 100, cents.abs() % 100, html_escape(&content.rendering_npi))
        }).collect::<String>();
    for _ in account["content"]["lines"].as_array().map_or(0, Vec::len)..6 {
        line_rows.push_str("<tr><td>&nbsp;</td><td></td><td></td><td></td><td><small></small></td><td></td><td></td><td></td><td></td><td></td></tr>");
    }
    let diagnoses = content
        .diagnosis_codes
        .iter()
        .enumerate()
        .map(|(i, value)| {
            format!(
                "<span>{}: {}</span>",
                (b'A' + i as u8) as char,
                html_escape(value)
            )
        })
        .collect::<Vec<_>>()
        .join("");
    let patient_name = format!(
        "{} {}",
        html_escape(json_text(patient, "given_name")),
        html_escape(json_text(patient, "family_name"))
    );
    let total_cents = account["total_cents"].as_i64().unwrap_or(0);
    let paid_cents = c.snapshot["financial_summary"]["patient_payments_cents"]
        .as_i64()
        .unwrap_or(0)
        + c.snapshot["financial_summary"]["insurer_payments_cents"]
            .as_i64()
            .unwrap_or(0)
        + c.snapshot["financial_summary"]["other_payments_cents"]
            .as_i64()
            .unwrap_or(0);
    let open_balance_cents = c.snapshot["financial_summary"]["open_balance_cents"]
        .as_i64()
        .unwrap_or(total_cents);
    let document = format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CMS-1500 {control}</title><style>
@page{{size:letter landscape;margin:.18in}}*{{box-sizing:border-box}}:root{{--red:#c52e52;--ink:#15232d;--rule:1.15px solid var(--red)}}body{{margin:0;background:#e8edf0;color:var(--ink);font:9px Arial,sans-serif}}.toolbar{{width:10.6in;margin:14px auto 9px;padding:11px 15px;border-radius:8px;background:#123038;color:#fff;display:flex;justify-content:space-between;align-items:center;box-shadow:0 4px 18px #0002}}.toolbar strong{{font-size:14px;display:block}}.toolbar span{{color:#cfe0e3}}button{{border:0;border-radius:5px;padding:9px 13px;background:#7bd9d3;font-weight:700;cursor:pointer}}.sheet{{position:relative;width:10.6in;min-height:8.05in;margin:0 auto 22px;padding:.1in .15in;background:#fffdfd;box-shadow:0 5px 24px #25374655;overflow:hidden}}.watermark{{position:absolute;left:1.45in;top:3.45in;transform:rotate(-20deg);font:bold 38px Arial;color:#d3264518;letter-spacing:.09em;pointer-events:none}}.form{{position:relative;color:var(--red)}}.mast{{height:.55in;display:grid;grid-template-columns:2.7in 1fr 2.25in;align-items:end;gap:8px}}.mast .title{{text-align:center;font:bold 18px Arial}}.mast .approval{{text-align:right;font-weight:700;font-size:8px}}.payer{{height:.5in;border:var(--rule);display:grid;grid-template-columns:7.25in 1fr}}.programs{{display:grid;grid-template-columns:repeat(5,1fr);gap:5px;padding:5px 7px;align-items:center}}.box{{display:inline-block;width:11px;height:11px;border:1px solid var(--red);margin-right:3px;vertical-align:-2px;line-height:9px;text-align:center;color:var(--ink)}}.payername{{border-left:var(--rule);padding:4px 7px;color:var(--ink)}}.rows{{border-left:var(--rule);border-top:var(--rule)}}.row{{display:grid}}.cell{{position:relative;min-height:.37in;padding:14px 5px 3px;border-right:var(--rule);border-bottom:var(--rule);color:var(--ink);font-weight:600;line-height:1.15}}.cell label{{position:absolute;left:4px;right:3px;top:2px;color:var(--red);font-size:7px;font-weight:700;line-height:1.03}}.r1{{grid-template-columns:2.15in 2.4in 1.55in 2.2in 1.97in}}.r2{{grid-template-columns:3.05in 1.5in 2.45in 1.3in 1.97in}}.r3{{grid-template-columns:4.55in 2.45in 3.27in}}.r4{{grid-template-columns:2.35in 2.2in 2.1in 1.65in 1.97in}}.r5{{grid-template-columns:4.55in 3.75in 1.97in}}.choices{{font-weight:400;color:var(--red);word-spacing:6px}}.sig{{font-family:"Segoe Script","Bradley Hand",cursive;color:#46515a;font-size:10px}}.diagnosis{{min-height:.55in}}.codes{{display:grid;grid-template-columns:repeat(4,1fr);gap:2px}}.codes span{{border-bottom:1px dotted #d18494;padding:2px}}table{{width:100%;border-collapse:collapse;table-layout:fixed;border-left:var(--rule);color:var(--ink)}}th,td{{border-right:var(--rule);border-bottom:var(--rule);padding:2px;text-align:center;vertical-align:top}}thead th{{border-top:var(--rule);height:.3in;color:var(--red);font-size:6.5px;line-height:1.05}}tbody td{{height:.29in;font-size:8px}}th:nth-child(1),th:nth-child(2){{width:.8in}}th:nth-child(3){{width:.35in}}th:nth-child(4){{width:.25in}}th:nth-child(5){{width:2.2in}}th:nth-child(6){{width:.5in}}th:nth-child(7){{width:.7in}}th:nth-child(8){{width:.35in}}th:nth-child(9){{width:.4in}}th:nth-child(10){{width:1.65in}}.procedure{{font-weight:700}}.procedure small{{display:block;font-weight:400;font-size:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}.charge{{font-weight:700}}.bottom{{display:grid;grid-template-columns:1.45in 2.1in 1.1in 1.2in 2.3in 2.12in;border-left:var(--rule)}}.bottom .cell{{min-height:.45in}}.footer{{display:flex;justify-content:space-between;align-items:end;padding-top:4px;color:var(--red);font-size:7px;font-weight:700}}.version{{border:1px solid var(--red);padding:3px 6px}}@media print{{body{{background:#fff}}.toolbar{{display:none}}.sheet{{margin:0;box-shadow:none}}}}@media(max-width:900px){{.toolbar{{margin:8px}}}}
</style><link rel="stylesheet" href="/cms1500.css"><script src="/cms1500.js" defer></script></head><body>
<div class=toolbar><div><strong>CMS-1500 claim review · {control}</strong><span>Synthetic review copy. Printing does not submit this claim.</span></div><div class=preview-actions aria-label="Form preview controls"><button type=button id=cms-zoom-out aria-label="Zoom out">−</button><output id=cms-zoom-label aria-live=polite>125%</output><button type=button id=cms-zoom-in aria-label="Zoom in">+</button><button type=button id=cms-fit-page>Fit page</button><button type=button id=cms-print>Print / Save PDF</button></div></div>
<main class=sheet aria-label="CMS-1500 health insurance claim form review"><div class=watermark>SYNTHETIC TEST · NOT FOR SUBMISSION</div><div class=form>
<div class=mast><div><b>1500&nbsp;&nbsp; HEALTH INSURANCE CLAIM FORM</b><br><small>APPROVED BY NATIONAL UNIFORM CLAIM COMMITTEE (NUCC) 02/12</small></div><div class=title>HEALTH INSURANCE CLAIM FORM</div><div class=approval>CARRIER<br>APPROVED OMB-0938-1197<br>FORM CMS-1500 (02/12)</div></div>
<section class=payer><div class=programs><span><i class=box></i>MEDICARE</span><span><i class=box></i>MEDICAID</span><span><i class=box></i>TRICARE</span><span><i class=box></i>CHAMPVA</span><span><i class=box>×</i>OTHER</span></div><div class=payername><b>{payer}</b><br><small>INSURANCE PLAN NAME OR PROGRAM NAME</small></div></section>
<section class=rows>
<div class="row r1"><div class=cell><label>1. TYPE OF HEALTH INSURANCE</label>OTHER</div><div class=cell><label>1a. INSURED'S I.D. NUMBER</label>{member}</div><div class=cell><label>2. PATIENT'S NAME (Last, First, Middle)</label>{patient_name}</div><div class=cell><label>3. PATIENT'S BIRTH DATE &nbsp; SEX</label>{patient_dob} &nbsp; <span class=choices>☐M ☐F</span></div><div class=cell><label>4. INSURED'S NAME</label>{patient_name}</div></div>
<div class="row r2"><div class=cell><label>5. PATIENT'S ADDRESS (No., Street)</label>{patient_address}</div><div class=cell><label>6. PATIENT RELATIONSHIP TO INSURED</label><span class=choices>☒Self ☐Spouse ☐Child</span></div><div class=cell><label>7. INSURED'S ADDRESS (No., Street)</label>{subscriber_address}</div><div class=cell><label>8. RESERVED FOR NUCC USE</label></div><div class=cell><label>9. OTHER INSURED'S NAME</label></div></div>
<div class="row r3"><div class=cell><label>9a. OTHER INSURED'S POLICY OR GROUP NUMBER</label></div><div class=cell><label>9b–9c. RESERVED FOR NUCC USE</label></div><div class=cell><label>9d. INSURANCE PLAN NAME OR PROGRAM NAME</label></div></div>
<div class="row r4"><div class=cell><label>10a. CONDITION RELATED TO EMPLOYMENT?</label><span class=choices>☐YES ☒NO</span></div><div class=cell><label>10b. AUTO ACCIDENT? &nbsp; PLACE</label><span class=choices>☐YES ☒NO</span></div><div class=cell><label>10c. OTHER ACCIDENT?</label><span class=choices>☐YES ☒NO</span></div><div class=cell><label>10d. CLAIM CODES</label></div><div class=cell><label>11. INSURED'S POLICY GROUP OR FECA NUMBER</label></div></div>
<div class="row r2"><div class=cell><label>11a. INSURED'S DATE OF BIRTH &nbsp; SEX</label>{patient_dob}</div><div class=cell><label>11b. OTHER CLAIM ID</label>{payer_control}</div><div class=cell><label>11c. INSURANCE PLAN NAME</label>{payer}</div><div class=cell><label>11d. ANOTHER HEALTH BENEFIT PLAN?</label><span class=choices>☐YES ☒NO</span></div><div class=cell><label>CLAIM FREQUENCY</label>{frequency}</div></div>
<div class="row r5"><div class=cell><label>12. PATIENT'S OR AUTHORIZED PERSON'S SIGNATURE</label><span class=sig>Signature on file</span></div><div class=cell><label>13. INSURED'S OR AUTHORIZED PERSON'S SIGNATURE</label><span class=sig>Signature on file</span></div><div class=cell><label>PATIENT ACCOUNT NO.</label>{control}</div></div>
<div class="row r3"><div class=cell><label>14. DATE OF CURRENT ILLNESS, INJURY, OR PREGNANCY</label></div><div class=cell><label>15. OTHER DATE</label></div><div class=cell><label>16. DATES PATIENT UNABLE TO WORK</label></div></div>
<div class="row r5"><div class=cell><label>17. NAME OF REFERRING PROVIDER OR OTHER SOURCE</label></div><div class=cell><label>17b. NPI</label></div><div class=cell><label>18. HOSPITALIZATION DATES</label></div></div>
<div class="row r3"><div class=cell><label>19. ADDITIONAL CLAIM INFORMATION</label>{notes}</div><div class=cell><label>20. OUTSIDE LAB? &nbsp; $ CHARGES</label><span class=choices>☐YES ☒NO</span></div><div class="cell diagnosis"><label>21. DIAGNOSIS OR NATURE OF ILLNESS OR INJURY</label><div class=codes>{diagnoses}</div></div></div>
<div class="row r5"><div class=cell><label>22. RESUBMISSION CODE &nbsp; ORIGINAL REF. NO.</label>{frequency}</div><div class=cell><label>23. PRIOR AUTHORIZATION NUMBER</label></div><div class=cell><label>INTERNAL MRN — REVIEW ONLY</label>{mrn}</div></div>
</section>
<table aria-label="CMS-1500 service lines"><thead><tr><th>24A. DATE(S) OF SERVICE<br>FROM</th><th>TO</th><th>24B.<br>POS</th><th>24C.<br>EMG</th><th>24D. PROCEDURES, SERVICES, OR SUPPLIES<br>CPT/HCPCS · MODIFIER</th><th>24E.<br>DIAGNOSIS POINTER</th><th>24F.<br>$ CHARGES</th><th>24G.<br>DAYS/UNITS</th><th>24H.<br>EPSDT</th><th>24J. RENDERING<br>PROVIDER ID. #</th></tr></thead><tbody>{line_rows}</tbody></table>
<section class=bottom><div class=cell><label>25. FEDERAL TAX I.D. NUMBER</label>{tax_id}</div><div class=cell><label>26. PATIENT'S ACCOUNT NO.</label>{control}</div><div class=cell><label>27. ACCEPT ASSIGNMENT?</label><span class=choices>☒YES</span></div><div class=cell><label>28. TOTAL CHARGE</label>${total_dollars}.{total_pennies:02}</div><div class=cell><label>29. AMOUNT PAID</label>${paid_dollars}.{paid_pennies:02}</div><div class=cell><label>30. RESERVED FOR NUCC USE</label></div><div class="cell sig" style="grid-column:span 4"><label>31. SIGNATURE OF PHYSICIAN OR SUPPLIER</label>{provider} · Signature on file</div><div class=cell><label>32. SERVICE FACILITY LOCATION</label>{billing_address}</div><div class=cell><label>32a. NPI</label>{rendering_npi}</div><div class=cell style="grid-column:span 4"><label>33. BILLING PROVIDER INFO &amp; PH #</label>{provider}<br>{billing_address}</div><div class=cell><label>33a. NPI</label>{billing_npi}</div><div class=cell><label>33b. OTHER ID #</label></div></section>
<div class=footer><span>Generated from frozen SunCharts claim version {version}. Gross claim ${total_dollars}.{total_pennies:02}; recorded paid ${paid_dollars}.{paid_pennies:02}; local open balance ${open_dollars}.{open_pennies:02}. Viewing or printing does not submit or alter the claim.</span><span class=version>NUCC 02/12 REVIEW LAYOUT · SYNTHETIC DATA</span></div>
</div></main></body></html>"#,
        control = html_escape(&c.control_number),
        member = html_escape(json_text(policy, "member_id")),
        payer = html_escape(json_text(payer, "name")),
        frequency = html_escape(&c.frequency),
        patient_name = patient_name,
        patient_dob = html_escape(json_text(patient, "birth_date")),
        mrn = html_escape(json_text(patient, "mrn")),
        patient_address = html_escape(&content.patient_address),
        subscriber_address = html_escape(&content.subscriber_address),
        provider = html_escape(&content.billing_provider_name),
        billing_address = html_escape(&content.billing_address),
        billing_npi = html_escape(&content.billing_npi),
        tax_id = html_escape(&content.tax_id),
        rendering_npi = html_escape(&content.rendering_npi),
        diagnoses = diagnoses,
        line_rows = line_rows,
        notes = html_escape(&content.notes),
        total_dollars = total_cents / 100,
        total_pennies = total_cents.abs() % 100,
        paid_dollars = paid_cents / 100,
        paid_pennies = paid_cents.abs() % 100,
        open_dollars = open_balance_cents / 100,
        open_pennies = open_balance_cents.abs() % 100,
        payer_control = html_escape(&c.payer_control_number),
        version = c.version
    );
    crate::postgres::audit(&mut tx, &a, "claim.cms1500_view", id).await?;
    tx.commit().await?;
    Ok(Html(document))
}
async fn claim_history(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    claim_row(&mut tx, &a, id).await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('version',version,'snapshot',snapshot,'actor_id',actor_id,'reason',reason,'evidence',evidence,'created_at',created_at) FROM claim_revisions WHERE tenant_id=$1 AND claim_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "claim.history", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":rows})))
}
async fn remittances(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let mut rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',r.id,'payer_id',r.payer_id,'payer_name',p.content->>'name','trace',r.trace,'status',r.status,'version',r.version,'payment_date',r.document->>'payment_date','total_paid_cents',r.document->'total_paid_cents','claim_count',jsonb_array_length(r.document->'claims')) FROM era_remittances r JOIN ehr_payers p ON p.tenant_id=r.tenant_id AND p.id=r.payer_id WHERE r.tenant_id=$1 AND ($2::uuid IS NULL OR r.id>$2) ORDER BY r.id LIMIT 101").bind(a.tenant_id).bind(q.after).fetch_all(&mut *tx).await?;
    let next = if rows.len() > 100 {
        rows.truncate(100);
        rows.last().map(|r| r["id"].clone())
    } else {
        None
    };
    crate::postgres::audit(&mut tx, &a, "remittance.worklist", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":rows,"next_cursor":next})))
}
async fn import_remittance(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(v): Json<Import>,
) -> Result<Json<Remittance>> {
    a.scheduling()?;
    text(&v.reason, 1000)?;
    let digest = hash(&v)?;
    let document = match (v.format.as_str(), &v.document, &v.original_text) {
        ("normalized", Some(d), None) => d.clone(),
        ("x12_835", None, Some(raw)) => era835::parse(raw)?,
        _ => {
            return Err(Error::Invalid(
                "provide normalized document or bounded x12_835 text, not both",
            ))
        }
    };
    document.validate()?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let old: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,creation_hash FROM era_remittances WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((id, prior)) = old {
        if prior != digest {
            return Err(Error::Conflict(
                "remittance request ID reused with changed evidence",
            ));
        }
        return Ok(Json(remit_row(&mut tx, &a, id).await?));
    }
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ehr_payers WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(v.payer_id)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    if let Some(id) = v.source_history_id {
        source(&mut tx, &a, id, None, "remittance").await?;
        let mapped: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM era_batches WHERE tenant_id=$1 AND source_history_id=$2)",
        )
        .bind(a.tenant_id)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if mapped {
            return Err(Error::Conflict("Source already mapped to an ERA file"));
        }
    }
    if let Some(report) = v.remote_report_id {
        crate::retrieval::verify(
            &mut tx,
            &a,
            report,
            "x12_835",
            v.original_text.as_deref().unwrap_or(""),
            None,
        )
        .await?;
    }
    crate::era_batches::check_receipt(&mut tx, &a, v.payer_id, &document.trace).await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO era_remittances (tenant_id,id,payer_id,trace,document,original_text,document_hash,request_id,creation_hash,source_history_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(a.tenant_id).bind(id).bind(v.payer_id).bind(&document.trace).bind(json!(document)).bind(&v.original_text).bind(hash(&document)?).bind(v.request_id).bind(digest).bind(v.source_history_id).execute(&mut *tx).await?;
    let r = remit_revision(&mut tx, &a, id, &v.reason).await?;
    if let Some(report) = v.remote_report_id {
        crate::retrieval::link(&mut tx, &a, report, "remittance", id, &v.reason).await?;
    }
    tx.commit().await?;
    Ok(Json(r))
}
async fn review(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Remittance,
    matches: &[Match],
) -> Result<Vec<String>> {
    let mut shadow = tx.begin().await?;
    let result = crate::era_chains::plan(
        &mut shadow,
        a,
        r,
        matches,
        &mut Default::default(),
        "Rollback-only remittance preview",
    )
    .await;
    shadow.rollback().await?;
    result
}
pub(crate) async fn review_row(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Remittance,
    matches: &[Match],
) -> Result<Vec<String>> {
    let doc: Document = serde_json::from_value(r.document.clone())
        .map_err(|_| Error::Invalid("invalid stored remittance"))?;
    let mut issues = doc.validate()?;
    let code: String = sqlx::query_scalar(
        "SELECT content->>'payer_code' FROM ehr_payers WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(r.payer_id)
    .fetch_one(&mut **tx)
    .await?;
    if code.trim().is_empty() || code != doc.payer_code {
        issues.push("Remittance payer identifier differs from the selected native payer".into());
    }

    issues.extend(crate::settlements::review_issues(tx, a, r, &doc).await?);
    let mut seen = std::collections::HashSet::new();
    let mut seen_claims = std::collections::HashSet::new();
    let mut seen_accounts = std::collections::HashSet::new();
    for m in matches {
        let row = doc
            .claims
            .get(m.row_index)
            .ok_or(Error::Invalid("remittance row index out of range"))?;
        if !seen.insert(m.row_index) || !seen_claims.insert(m.claim_id) {
            return Err(Error::Invalid(
                "duplicate remittance row or native claim match",
            ));
        }
        let c = claim_row(tx, a, m.claim_id).await?;
        let b = account(tx, a, c.account_id, Some(c.patient_id)).await?;
        if !seen_accounts.insert(b.id) {
            issues.push("Match one claim per billing account in a remittance".into());
        }
        if row.status == "22" {
            if m.reverses_remittance_id.is_none()
                || m.reverses_row_index.is_none()
                || !m.writeoff_adjustments.is_empty()
            {
                issues.push(format!(
                    "Row {}: reversal needs exact original remittance/row and no new credits",
                    m.row_index + 1
                ));
            } else {
                issues.extend(recovery_issues(tx, a, r, m, &c, &b, &doc).await?);
            }
            continue;
        }
        if m.reverses_remittance_id.is_some() || m.reverses_row_index.is_some() {
            issues.push("Only CLP22 rows may reference a reversed posting".into());
        }
        if c.payer_id != r.payer_id
            || !["submitted", "accepted"].contains(&c.status.as_str())
            || c.frequency == "void_request"
            || c.version != m.claim_version
            || b.version != m.account_version
            || b.status != "posted"
        {
            issues.push(format!(
                "Row {}: payer, lifecycle or record versions changed",
                m.row_index + 1
            ));
        }
        let content: ClaimContent = serde_json::from_value(c.content.clone())
            .map_err(|_| Error::Invalid("invalid stored claim"))?;
        if row.control_number != c.control_number
            && (content.external_control_number.is_empty()
                || row.control_number != content.external_control_number)
        {
            issues.push(format!("Row {}: patient control number does not match the native claim or reviewed external alias",m.row_index+1));
        }
        if row.payer_control_number.is_empty()
            || (m.correction_of_remittance_id.is_none()
                && !c.payer_control_number.is_empty()
                && c.payer_control_number != row.payer_control_number)
        {
            issues.push(format!(
                "Row {}: payer claim control number mismatch",
                m.row_index + 1
            ));
        }
        if row.charged_cents != b.total_cents {
            issues.push(format!(
                "Row {}: source charges differ from the frozen billing account",
                m.row_index + 1
            ));
        }
        let mut sum = 0i64;
        let mut selected = std::collections::HashSet::new();
        for index in &m.writeoff_adjustments {
            let adjustment = row
                .adjustments
                .get(*index)
                .ok_or(Error::Invalid("CAS adjustment index out of range"))?;
            if adjustment.group != "CO" || !selected.insert(*index) {
                return Err(Error::Invalid(
                    "only distinct, reviewed CO adjustments can become credits",
                ));
            }
            sum += adjustment.amount_cents;
        }
        let prior:i64=sqlx::query_scalar("SELECT coalesce(sum(effect_cents),0)::bigint FROM billing_entries WHERE tenant_id=$1 AND account_id=$2").bind(a.tenant_id).bind(b.id).fetch_one(&mut **tx).await?;
        // A settled patient overpayment is a credit, not a second PR charge.
        // Only existing net patient payments/credits may explain a negative
        // balance; insurer overpayment still blocks the complete settlement.
        let (patient_credit, _) = billing::patient_ledger_totals(tx, a.tenant_id, b.id).await?;
        let balance = b.total_cents + prior - row.paid_cents - sum;
        if !(-patient_credit.max(0)..=1000000000).contains(&balance) {
            issues.push(format!(
                "Row {}: posting exceeds the balance after accounting for existing patient credits",
                m.row_index + 1
            ));
        }
    }
    Ok(issues)
}
async fn remit_detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let r = remit_row(&mut tx, &a, id).await?;
    let matches: Vec<Match> = serde_json::from_value(r.matches.clone())
        .map_err(|_| Error::Invalid("invalid stored matches"))?;
    let issues = if ["posted", "reversed", "rejected"].contains(&r.status.as_str()) {
        vec![]
    } else {
        review(&mut tx, &a, &r, &matches).await?
    };
    let postings:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(p)-'tenant_id' || jsonb_build_object('current_account_balance_cents',b.total_cents+coalesce(e.total,0)) FROM era_postings p JOIN billing_accounts b ON b.tenant_id=p.tenant_id AND b.id=p.account_id LEFT JOIN LATERAL (SELECT sum(effect_cents)::bigint AS total FROM billing_entries WHERE tenant_id=p.tenant_id AND account_id=p.account_id) e ON true WHERE p.tenant_id=$1 AND p.remittance_id=$2 ORDER BY p.row_index").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let batch_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT batch_id FROM era_batch_items WHERE tenant_id=$1 AND remittance_id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let automation:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('report_id',report_id,'issues',issues,'created_at',created_at) FROM edi_era_automation WHERE tenant_id=$1 AND remittance_id=$2").bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "remittance.read", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"remittance":r,"batch_id":batch_id,"automation":automation,"issues":issues,"postings":postings,"ready_to_post":batch_id.is_none()&&r.status=="reconciled"&&issues.is_empty()}),
    ))
}
async fn match_remittance(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Matches>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    if v.matches.len() > era835::MAX_CLAIMS {
        return Err(Error::Invalid("too many remittance matches"));
    }
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let r = remit_row(&mut tx, &a, id).await?;
    if !["staged", "reconciled"].contains(&r.status.as_str()) || r.version != version {
        return Err(Error::Conflict(
            "only the current staged remittance can be matched",
        ));
    }
    let issues = review(&mut tx, &a, &r, &v.matches).await?;
    sqlx::query("UPDATE era_remittances SET matches=$3,status=$4,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(json!(v.matches)).bind(if issues.is_empty(){"reconciled"}else{"staged"}).execute(&mut *tx).await?;
    let r = remit_revision(&mut tx, &a, id, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(json!({"remittance":r,"issues":issues})))
}
pub(crate) async fn era_entry(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Remittance,
    account: (Uuid, usize),
    entry: (&str, i64),
    reason: &str,
    reverse: Option<Uuid>,
) -> Result<Uuid> {
    let (account_id, row_index) = account;
    let (kind, effect) = entry;
    let id = Uuid::new_v4();
    let document: Document = serde_json::from_value(r.document.clone())
        .map_err(|_| Error::Invalid("invalid remittance"))?;
    sqlx::query("INSERT INTO billing_entries (tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,reverses_id,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$2,$7,$8,$9)").bind(a.tenant_id).bind(id).bind(account_id).bind(kind).bind(effect).bind(json!({"request_id":id,"kind":kind,"amount_cents":effect.abs(),"reverses_id":reverse,"party":"insurer","method":"external","reference":r.trace,"occurred_on":document.payment_date,"reason":reason,"remittance_id":r.id})).bind(crate::oauth::hash(&format!("era:{}:{id}",r.id))).bind(reverse).bind(a.sub).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO era_posting_entries (tenant_id,remittance_id,entry_id,account_id) VALUES ($1,$2,$3,$4)").bind(a.tenant_id).bind(r.id).bind(id).bind(account_id).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO era_row_entries (tenant_id,remittance_id,row_index,entry_id) VALUES ($1,$2,$3,$4)").bind(a.tenant_id).bind(r.id).bind(row_index as i32).bind(id).execute(&mut **tx).await?;
    Ok(id)
}
async fn remit_action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Action>,
) -> Result<Json<Remittance>> {
    a.scheduling()?;
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let r = remit_row(&mut tx, &a, id).await?;
    if r.version != version {
        return Err(Error::Conflict(
            "remittance changed; reload before recording action",
        ));
    }
    crate::era_batches::independent(&mut tx, &a, id).await?;
    let status = match (v.action.as_str(), r.status.as_str()) {
        ("reject", "staged" | "reconciled") => "rejected",
        ("post", "reconciled") => {
            let matches: Vec<Match> = serde_json::from_value(r.matches.clone())
                .map_err(|_| Error::Invalid("invalid stored matches"))?;
            if !review(&mut tx, &a, &r, &matches).await?.is_empty() {
                return Err(Error::Conflict(
                    "remittance no longer reconciles; review current matches and balances",
                ));
            }
            let doc: Document = serde_json::from_value(r.document.clone())
                .map_err(|_| Error::Invalid("invalid remittance"))?;
            if !crate::era_chains::plan(
                &mut tx,
                &a,
                &r,
                &matches,
                &mut Default::default(),
                &v.reason,
            )
            .await?
            .is_empty()
            {
                return Err(Error::Conflict("Remittance plan changed"));
            }
            crate::settlements::post_entries(&mut tx, &a, &r, &doc, &v.reason).await?;
            "posted"
        }
        ("reverse", "posted") => {
            crate::era_chains::reverse(&mut tx, &a, &r, &v.reason).await?;
            "reversed"
        }
        _ => {
            return Err(Error::Conflict(
                "remittance action is not allowed in this state",
            ))
        }
    };
    sqlx::query(
        "UPDATE era_remittances SET status=$3,version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .bind(status)
    .execute(&mut *tx)
    .await?;
    let r = remit_revision(&mut tx, &a, id, &v.reason).await?;
    tx.commit().await?;
    Ok(Json(r))
}
async fn remit_history(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    remit_row(&mut tx, &a, id).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('version',version,'snapshot',snapshot,'actor_id',actor_id,'reason',reason,'created_at',created_at) FROM era_revisions WHERE tenant_id=$1 AND remittance_id=$2 ORDER BY version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "remittance.history", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
async fn claim_mapping(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    let mut tx = db(&s)?.begin().await?;
    source(&mut tx, &a, id, Some(p), "claim").await?;
    let raw: Value = sqlx::query_scalar(
        "SELECT source_data FROM historical_records WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    let native: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM ehr_claims WHERE tenant_id=$1 AND source_history_id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    crate::postgres::audit(&mut tx, &a, "claim.mapping", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"source_history_id":id,"source_data":raw,"native_id":native,"policy":"Select the reviewed posted account and verify source patient/control numbers. Historical submission states are never activated automatically; reconciliation creates a draft."}),
    ))
}
async fn remit_sources(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.scheduling()?;
    let mut tx = db(&s)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('source_history_id',h.id,'source_instance',h.source_instance,'source_id',h.source_id,'source_data',h.source_data,'native_id',r.id,'batch_id',b.id) FROM historical_records h LEFT JOIN era_remittances r ON r.tenant_id=h.tenant_id AND r.source_history_id=h.id LEFT JOIN era_batches b ON b.tenant_id=h.tenant_id AND b.source_history_id=h.id WHERE h.tenant_id=$1 AND h.kind='remittance' ORDER BY h.id LIMIT 101").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    if items.len() > 100 {
        return Err(Error::Invalid(
            "source remittance list exceeds preview limit",
        ));
    }
    crate::postgres::audit(&mut tx, &a, "remittance.sources", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}

/// Called under the tenant lock. Suggestions use exact frozen identities only;
/// ledger posting and selection of CO credits remain the existing reviewed action.
pub(crate) async fn stage_provider_era(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    report: Uuid,
    raw: &str,
    metadata: &Value,
) -> Result<(Uuid, Vec<String>)> {
    let doc = era835::parse(raw)?;
    doc.validate()?;
    for (key, expected) in [
        ("payerid", doc.payer_code.clone()),
        ("check_number", doc.trace.clone()),
        ("paid_date", doc.payment_date.to_string()),
    ] {
        if metadata[key].as_str() != Some(expected.as_str()) {
            return Err(Error::Invalid(
                "ERA metadata differs from original payer, trace or date",
            ));
        }
    }
    let paid = metadata["paid_amount"]
        .as_str()
        .ok_or(Error::Invalid("ERA payment amount missing"))?;
    if era835::money(paid)? != doc.total_paid_cents {
        return Err(Error::Invalid("ERA metadata amount differs from original"));
    }
    let payers:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM ehr_payers WHERE tenant_id=$1 AND content->>'payer_code'=$2 ORDER BY id LIMIT 2").bind(a.tenant_id).bind(&doc.payer_code).fetch_all(&mut **tx).await?;
    if payers.len() != 1 {
        return Err(Error::Invalid(
            "ERA requires one exact native payer; reconcile payer mapping",
        ));
    }
    let payer = payers[0];
    let duplicate:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM era_remittances WHERE tenant_id=$1 AND payer_id=$2 AND trace=$3)").bind(a.tenant_id).bind(payer).bind(&doc.trace).fetch_one(&mut **tx).await?;
    if duplicate {
        return Err(Error::Conflict(
            "ERA payer and trace already staged; review duplicate original",
        ));
    }
    crate::retrieval::verify(tx, a, report, "x12_835", raw, None).await?;
    let mut matches = vec![];
    let mut identity_issues = vec![];
    for (index, row) in doc.claims.iter().enumerate() {
        let candidates:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM ehr_claims WHERE tenant_id=$1 AND payer_id=$2 AND (control_number=$3 OR (content->>'external_control_number'=$3 AND content->>'external_control_number'<>'')) ORDER BY id LIMIT 2").bind(a.tenant_id).bind(payer).bind(&row.control_number).fetch_all(&mut **tx).await?;
        if candidates.len() != 1 {
            identity_issues.push(format!(
                "Row {}: exact claim identity missing or ambiguous",
                index + 1
            ));
            continue;
        }
        let c = claim_row(tx, a, candidates[0]).await?;
        let npi = metadata["prov_npi"].as_str().filter(|s| !s.is_empty());
        let tax = metadata["prov_taxid"].as_str().filter(|s| !s.is_empty());
        if npi != c.content["billing_npi"].as_str()
            || tax != c.content["tax_id"].as_str()
            || npi.is_none()
            || tax.is_none()
        {
            identity_issues.push(format!(
                "Row {}: provider NPI or tax identity needs review",
                index + 1
            ));
            continue;
        }
        let b = account(tx, a, c.account_id, Some(c.patient_id)).await?;
        matches.push(Match {
            row_index: index,
            claim_id: c.id,
            claim_version: c.version,
            account_version: b.version,
            writeoff_adjustments: vec![],
            reverses_remittance_id: None,
            reverses_row_index: None,
            correction_of_remittance_id: None,
            correction_of_row_index: None,
        });
    }
    let id = Uuid::new_v4();
    let reason =
        "Automated Claim.MD ERA staging; staff must review matches, CO credits and posting";
    sqlx::query("INSERT INTO era_remittances (tenant_id,id,payer_id,trace,document,original_text,document_hash,request_id,creation_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(a.tenant_id).bind(id).bind(payer).bind(&doc.trace).bind(json!(doc)).bind(raw).bind(hash(&doc)?).bind(report).bind(crate::oauth::hash(&format!("provider-era:{report}"))).execute(&mut **tx).await?;
    let r = remit_revision(tx, a, id, reason).await?;
    let mut issues = review(tx, a, &r, &matches).await?;
    issues.extend(identity_issues);
    // Suggestions stay staged even if balanced. A human reviews the current
    // claim/account versions and contractual credits before reconciliation.
    sqlx::query(
        "UPDATE era_remittances SET matches=$3,version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .bind(json!(matches))
    .execute(&mut **tx)
    .await?;
    remit_revision(tx, a, id, reason).await?;
    crate::retrieval::link_evidence(tx, a, report, "remittance", id, reason, false).await?;
    Ok((id, issues))
}

pub(crate) async fn recovery_issues(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Remittance,
    m: &Match,
    c: &Claim,
    b: &billing::Account,
    doc: &Document,
) -> Result<Vec<String>> {
    let source_id = m
        .reverses_remittance_id
        .ok_or(Error::Invalid("original remittance required"))?;
    let index = m
        .reverses_row_index
        .ok_or(Error::Invalid("original row required"))?;
    let source = remit_row(tx, a, source_id).await?;
    let original: Document = serde_json::from_value(source.document)
        .map_err(|_| Error::Invalid("invalid original remittance"))?;
    let row = &doc.claims[m.row_index];
    let prior = original
        .claims
        .get(index)
        .ok_or(Error::Invalid("original row out of range"))?;
    let posting:Option<(Uuid,Uuid,i64)>=sqlx::query_as("SELECT claim_id,account_id,posted_claim_version FROM era_postings WHERE tenant_id=$1 AND remittance_id=$2 AND row_index=$3").bind(a.tenant_id).bind(source_id).bind(index as i32).fetch_optional(&mut **tx).await?;
    let mut mirrored = prior.clone();
    mirrored.status = "22".into();
    mirrored.patient_name = row.patient_name.clone();
    mirrored.charged_cents = -mirrored.charged_cents;
    mirrored.paid_cents = -mirrored.paid_cents;
    mirrored.patient_responsibility_cents = -mirrored.patient_responsibility_cents;
    for adj in &mut mirrored.adjustments {
        adj.amount_cents = -adj.amount_cents;
    }
    for line in &mut mirrored.services {
        line.charged_cents = -line.charged_cents;
        line.paid_cents = -line.paid_cents;
    }
    let active_head = crate::era_chains::head(tx, a, c.id).await?;
    let downstream:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ehr_claims WHERE tenant_id=$1 AND parent_id=$2 AND status<>'void')").bind(a.tenant_id).bind(c.id).fetch_one(&mut **tx).await?;
    let mut issues = vec![];
    if (source_id == r.id && index >= m.row_index)
        || (source_id != r.id && source.status != "posted")
        || source.payer_id != r.payer_id
        || posting.as_ref().map(|p| (p.0, p.1)) != Some((c.id, b.id))
        || active_head.as_ref().is_none_or(|h| {
            h["remittance_id"] != json!(source_id)
                || h["row_index"] != json!(index)
                || h["claim_version"] != json!(c.version)
        })
        || c.status != "adjudicated"
        || c.payer_id != r.payer_id
        || c.version != m.claim_version
        || b.version != m.account_version
        || b.status != "posted"
        || downstream
        || prior.status == "22"
        || json!(mirrored) != json!(row)
    {
        issues.push(format!("Row {}: reversal must mirror one unchanged posted original claim, CAS and services; source already recovered or downstream activity requires reconciliation",m.row_index+1));
    }
    let effects: i64 = crate::era_chains::leaves(tx, a, source_id, index)
        .await?
        .iter()
        .map(|e| e.1)
        .sum();
    let balance:i64=sqlx::query_scalar("SELECT coalesce(sum(effect_cents),0)::bigint FROM billing_entries WHERE tenant_id=$1 AND account_id=$2").bind(a.tenant_id).bind(b.id).fetch_one(&mut **tx).await?;
    if !(0..=1000000000).contains(&(b.total_cents + balance - effects)) {
        issues.push("Claim reversal exceeds supported account balance".into());
    }
    Ok(issues)
}
pub(crate) async fn post_recovery(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Remittance,
    m: &Match,
    c: &Claim,
    reason: &str,
) -> Result<()> {
    let source = m
        .reverses_remittance_id
        .ok_or(Error::Invalid("original remittance required"))?;
    let index = m
        .reverses_row_index
        .ok_or(Error::Invalid("original row required"))?;
    let (status,control):(String,String)=sqlx::query_as("SELECT claim_status_before,claim_control_before FROM era_postings WHERE tenant_id=$1 AND remittance_id=$2 AND row_index=$3").bind(a.tenant_id).bind(source).bind(index as i32).fetch_one(&mut **tx).await?;
    let entries = crate::era_chains::leaves(tx, a, source, index).await?;
    for (id, effect) in entries {
        era_entry(
            tx,
            a,
            r,
            (c.account_id, m.row_index),
            ("reversal", -effect),
            reason,
            Some(id),
        )
        .await?;
    }
    sqlx::query("UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(c.account_id)
        .execute(&mut **tx)
        .await?;
    billing::account_revision(tx, a, c.patient_id, c.account_id, reason).await?;
    sqlx::query("INSERT INTO era_postings (tenant_id,remittance_id,row_index,claim_id,account_id,claim_status_before,claim_control_before,posted_claim_version,patient_responsibility_cents,writeoff_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0)").bind(a.tenant_id).bind(r.id).bind(m.row_index as i32).bind(c.id).bind(c.account_id).bind(&c.status).bind(&c.payer_control_number).bind(c.version+1).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO era_claim_recoveries (tenant_id,remittance_id,row_index,original_remittance_id,original_row_index) VALUES ($1,$2,$3,$4,$5)").bind(a.tenant_id).bind(r.id).bind(m.row_index as i32).bind(source).bind(index as i32).execute(&mut **tx).await?;
    sqlx::query("UPDATE ehr_claims SET status=$3,payer_control_number=$4,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(c.id).bind(status).bind(control).execute(&mut **tx).await?;
    revision(
        tx,
        a,
        c.id,
        reason,
        json!({"claim_reversal":r.id,"original_remittance":source,"original_row":index}),
    )
    .await?;
    Ok(())
}

pub(crate) async fn post_rows(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Remittance,
    matches: &[Match],
    reason: &str,
) -> Result<()> {
    let doc: Document = serde_json::from_value(r.document.clone())
        .map_err(|_| Error::Invalid("invalid stored remittance"))?;
    for m in matches {
        let c = claim_row(tx, a, m.claim_id).await?;
        let row = &doc.claims[m.row_index];
        let prior_head = crate::era_chains::head(tx, a, c.id).await?;
        if row.status == "22" {
            post_recovery(tx, a, r, m, &c, reason).await?;
            crate::era_chains::advance(tx, a, r, m, &c, prior_head).await?;
            continue;
        }
        let writeoff: i64 = m
            .writeoff_adjustments
            .iter()
            .map(|i| row.adjustments[*i].amount_cents)
            .sum();
        if row.paid_cents > 0 {
            era_entry(
                tx,
                a,
                r,
                (c.account_id, m.row_index),
                ("payment", -row.paid_cents),
                reason,
                None,
            )
            .await?;
        }
        if writeoff > 0 {
            era_entry(
                tx,
                a,
                r,
                (c.account_id, m.row_index),
                ("adjustment_credit", -writeoff),
                reason,
                None,
            )
            .await?;
        }
        sqlx::query("UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(c.account_id)
            .execute(&mut **tx)
            .await?;
        billing::account_revision(tx, a, c.patient_id, c.account_id, reason).await?;
        sqlx::query("INSERT INTO era_postings (tenant_id,remittance_id,row_index,claim_id,account_id,claim_status_before,claim_control_before,posted_claim_version,patient_responsibility_cents,writeoff_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(a.tenant_id).bind(r.id).bind(m.row_index as i32).bind(c.id).bind(c.account_id).bind(&c.status).bind(&c.payer_control_number).bind(c.version+1).bind(row.patient_responsibility_cents).bind(writeoff).execute(&mut **tx).await?;
        sqlx::query("UPDATE ehr_claims SET status='adjudicated',payer_control_number=$3,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(c.id).bind(&row.payer_control_number).execute(&mut **tx).await?;
        revision(tx,a,c.id,reason,json!({"remittance_id":r.id,"row_index":m.row_index,"payer_status":row.status,"patient_responsibility_cents":row.patient_responsibility_cents,"selected_co_writeoff_cents":writeoff})).await?;
        crate::era_chains::advance(tx, a, r, m, &c, prior_head).await?;
    }
    Ok(())
}

#[cfg(test)]
mod submission_default_tests {
    use super::{new_control_number, split_person_name, structured_x12_address, x12_sex};
    use serde_json::json;

    #[test]
    fn new_claim_control_numbers_fit_payer_limits_without_losing_test_marker() {
        let mut seen = std::collections::HashSet::new();
        for synthetic in [false, true] {
            for _ in 0..1000 {
                let number = new_control_number(uuid::Uuid::new_v4(), synthetic);
                assert_eq!(number.len(), 17);
                assert!(number.bytes().all(|v| v.is_ascii_alphanumeric()));
                if synthetic {
                    assert!(number.starts_with("SCTEST"));
                }
                assert!(seen.insert(number));
            }
        }
    }

    #[test]
    fn normalizes_claim_sex_without_guessing() {
        assert_eq!(x12_sex(Some("female")), "F");
        assert_eq!(x12_sex(Some("M")), "M");
        assert_eq!(x12_sex(Some("nonbinary")), "U");
        assert_eq!(x12_sex(None), "U");
    }

    #[test]
    fn splits_display_and_claim_names() {
        assert_eq!(
            split_person_name("Park, David"),
            ("David".to_string(), "Park".to_string())
        );
        assert_eq!(
            split_person_name("David J Park"),
            ("David J".to_string(), "Park".to_string())
        );
    }

    #[test]
    fn maps_structured_chart_address_to_x12_fields() {
        let demographics = json!({
            "address": {
                "line1": "100 Main St",
                "line2": "Suite 2",
                "city": "Rockford",
                "region": "IL",
                "postal_code": "61114"
            }
        });
        assert_eq!(
            structured_x12_address(Some(&demographics)),
            json!({
                "line1": "100 Main St",
                "line2": "Suite 2",
                "city": "Rockford",
                "state": "IL",
                "postal_code": "61114"
            })
        );
    }
}
