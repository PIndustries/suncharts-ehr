// SPDX-License-Identifier: AGPL-3.0-only
//! Resume one expressly requested encounter claim from its recorded billing and delivery state.
use crate::{
    access_policies,
    auth::Actor,
    billing, claims, clearinghouse, delivery,
    error::{Error, Result},
    visit_billing,
    x12::{Details, PartnerContent},
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Prepare,
    Queue,
}

#[derive(Deserialize, Serialize, Default)]
#[serde(default, deny_unknown_fields)]
struct Confirmations {
    signature_on_file: bool,
    benefits_assigned: bool,
    release_authorized: bool,
    routine_professional_reviewed: bool,
    synthetic_test_reviewed: bool,
}
impl Confirmations {
    fn complete(&self) -> bool {
        self.signature_on_file
            && self.benefits_assigned
            && self.release_authorized
            && self.routine_professional_reviewed
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewedClaim {
    id: Uuid,
    version: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    account_id: Option<Uuid>,
    account_version: Option<i64>,
    sign_version: Option<i64>,
    reviewed_claim: Option<ReviewedClaim>,
    mode: Mode,
    #[serde(default)]
    confirmations: Confirmations,
}
fn review(message: &str) -> Value {
    json!({"outcome":"needs_review","issues":[message]})
}

fn stage(artifact: &str, job: Option<&str>) -> &'static str {
    match (artifact, job) {
        (_, Some("delivered")) => "delivered",
        ("delivered", _) => "recorded_externally",
        (_, Some("queued" | "leased" | "retry")) => "queued",
        (_, Some("unknown")) => "waiting",
        ("cancelled", _) | (_, Some("blocked" | "cancelled")) => "blocked",
        ("prepared", None) => "prepared",
        _ => "waiting",
    }
}
#[derive(sqlx::FromRow)]
struct DeliveryEvidence {
    claim_id: Uuid,
    manual_external_submission: bool,
    submission_id: Option<Uuid>,
    artifact_status: Option<String>,
    submission_version: Option<i64>,
    claim_version: Option<i64>,
    partner_id: Option<Uuid>,
    partner_version: Option<i64>,
    job_id: Option<Uuid>,
    delivery_status: Option<String>,
    route_key: Option<String>,
}

pub(crate) async fn evidence_for_claims(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    claims: &[Uuid],
) -> Result<HashMap<Uuid, Value>> {
    if claims.is_empty() {
        return Ok(HashMap::new());
    }
    // A receipt or ambiguous in-flight attempt on an older file takes precedence over a later
    // prepared file. Staff can also record an outside submission without making a file here.
    let rows: Vec<DeliveryEvidence> = sqlx::query_as(
        "SELECT c.id AS claim_id,
         EXISTS(SELECT 1 FROM claim_revisions r WHERE r.tenant_id=c.tenant_id AND r.claim_id=c.id
                AND r.evidence->>'action'='record_submission') AS manual_external_submission,
         e.*
         FROM ehr_claims c
         LEFT JOIN LATERAL (
           SELECT s.id AS submission_id,s.status AS artifact_status,s.version AS submission_version,
                  s.claim_version,s.partner_id,s.partner_version,j.id AS job_id,
                  j.status AS delivery_status,j.route_key
           FROM edi_submissions s
           LEFT JOIN edi_delivery_jobs j ON j.tenant_id=s.tenant_id AND j.submission_id=s.id
           WHERE s.tenant_id=c.tenant_id AND s.claim_id=c.id
           ORDER BY (s.status='delivered' OR COALESCE(j.status='delivered',false)) DESC,
                    COALESCE(j.status IN ('unknown','leased','queued','retry','blocked'),false) DESC,
                    s.created_at DESC,j.created_at DESC NULLS LAST,s.id DESC
           LIMIT 1
         ) e ON true
         WHERE c.tenant_id=$1 AND c.id=ANY($2)",
    )
    .bind(tenant)
    .bind(claims)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let delivery_status = row.delivery_status.as_deref();
            let outcome = if row.manual_external_submission && delivery_status != Some("delivered") {
                "recorded_externally"
            } else {
                stage(row.artifact_status.as_deref()?, delivery_status)
            };
            Some((row.claim_id, json!({
                "outcome":outcome,
                "claim_id":row.claim_id, "submission_id":row.submission_id, "submission_version":row.submission_version,
                "claim_version":row.claim_version, "partner_id":row.partner_id, "partner_version":row.partner_version,
                "job_id":row.job_id, "delivery_status":row.delivery_status, "route_key":row.route_key
            })))
        })
        .collect())
}

pub(crate) async fn evidence(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    claim: Uuid,
) -> Result<Option<Value>> {
    Ok(evidence_for_claims(tx, a.tenant_id, &[claim])
        .await?
        .remove(&claim))
}

pub(crate) async fn handoff(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((patient, visit_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<Request>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    for (resource, operation) in [
        ("claims", "view"),
        ("claims", "create"),
        ("claims", "edit"),
        ("billing", "view"),
        ("billing", "edit"),
    ] {
        access_policies::require_native(&s, &a, resource, operation).await?;
    }
    if request.sign_version.is_some() {
        access_policies::require_native(&s, &a, "clinical", "edit").await?;
    }
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let account = match (request.account_id, request.account_version) {
        (Some(id), Some(version)) if version > 0 => {
            let mut tx = db.begin().await?;
            let account = billing::account_row(&mut tx, &a, patient, id).await?;
            if account.content["visit_id"] != json!(visit_id) {
                return Err(Error::NotFound);
            }
            tx.commit().await?;
            Some(account)
        }
        (None, None) => None,
        _ => {
            return Err(Error::Invalid(
                "Supply the reviewed account ID and version together.",
            ))
        }
    };
    let mut visit = s.backend.visit(&a, visit_id).await?;
    if visit.patient_id != patient {
        return Err(Error::NotFound);
    }
    if let Some(version) = request.sign_version {
        if visit.status != "signed" {
            visit = match s.backend.sign(&a, visit_id, version).await {
                Ok(signed) => signed,
                Err(Error::Conflict(reason)) => {
                    let current = s.backend.visit(&a, visit_id).await?;
                    if current.status == "signed"
                        && current.signed_by == Some(a.sub)
                        && Some(current.version) == version.checked_add(1)
                    {
                        current
                    } else {
                        return Err(Error::Conflict(reason));
                    }
                }
                Err(error) => return Err(error),
            };
        } else if visit.signed_by != Some(a.sub) || Some(visit.version) != version.checked_add(1) {
            return Err(Error::Conflict(
                "The signed encounter changed. Reopen it before continuing claim submission.",
            ));
        }
    }
    let mut result = if visit.status != "signed" {
        review("Sign the encounter note before submitting this claim.")
    } else if let Some(account) = &account {
        match advance(&s, db, &a, patient, account, &request).await {
            Ok(value) => value,
            Err(Error::Invalid(msg) | Error::Conflict(msg) | Error::Unavailable(msg)) => {
                review(msg)
            }
            Err(err) => return Err(err),
        }
    } else {
        review("Add charges to this encounter before submitting a claim.")
    };
    result["signed"] = json!(visit.status == "signed");
    result["visit_version"] = json!(visit.version);
    result["visit_id"] = json!(visit.id);
    result["account_id"] = json!(request.account_id);
    Ok(Json(result))
}
async fn advance(
    s: &State,
    db: &PgPool,
    a: &Actor,
    patient: Uuid,
    account: &billing::Account,
    request: &Request,
) -> Result<Value> {
    let posted_on_this_request = account.status=="posted"
        && request.account_version.and_then(|v|v.checked_add(1))==Some(account.version)
        && sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM billing_account_revisions current JOIN billing_account_revisions prior ON prior.tenant_id=current.tenant_id AND prior.account_id=current.account_id AND prior.version=current.version-1 WHERE current.tenant_id=$1 AND current.account_id=$2 AND current.version=$3 AND current.actor_id=$4 AND current.reason=$5 AND current.snapshot->>'status'='posted' AND prior.snapshot->>'status'='draft' AND current.snapshot->'content'=prior.snapshot->'content')").bind(a.tenant_id).bind(account.id).bind(account.version).bind(a.sub).bind(billing::CLAIM_HANDOFF_POST_REASON).fetch_one(db).await?;
    if Some(account.version) != request.account_version && !posted_on_this_request {
        return Ok(review(
            "The charges changed. Refresh this encounter and review the current amount.",
        ));
    }
    if request.reviewed_claim.is_some() && account.status != "posted" {
        return Ok(review(
            "The charges changed. Reopen Claim details to review the current claim.",
        ));
    }
    if account.content["coverage_id"].is_null() {
        return Ok(json!({"outcome":"self_pay"}));
    }
    let details = &account.content["claim_details"];
    if details["paper_only"] == true {
        return Ok(
            json!({"outcome":"held","reason":"This encounter is marked for paper billing."}),
        );
    }
    if details["review_requested"] == true {
        return Ok(
            json!({"outcome":"held","reason":"The charges are held for review. Approve them before submission."}),
        );
    }
    if account.status == "draft" {
        if !visit_billing::before_posting(true, &account.content["lines"], 0).is_empty() {
            return Ok(review("Complete the procedure codes, amounts and diagnosis links before posting the charges."));
        }
        match billing::post_handoff_account(s, a, patient, account.id, account.version).await {
            Ok(_) => {}
            Err(Error::Conflict(message)) => {
                let mut tx = db.begin().await?;
                let current = billing::account_row(&mut tx, a, patient, account.id).await?;
                if current.status != "posted"
                    || Some(current.version) != account.version.checked_add(1)
                    || current.content != account.content
                {
                    return Err(Error::Conflict(message));
                }
                tx.commit().await?;
            }
            Err(error) => return Err(error),
        }
    } else if account.status != "posted" {
        return Ok(review("These charges cannot be submitted."));
    }
    let id = if let Some(reviewed) = &request.reviewed_claim {
        reviewed.id
    } else {
        let draft = visit_billing::prepare_claim(db, a, patient, account.id, false).await?;
        let Some(id) = draft["claim_id"]
            .as_str()
            .and_then(|v| Uuid::parse_str(v).ok())
        else {
            return Ok(review(match draft["outcome"].as_str() {
                Some("cancelled") => {
                    "The claim was cancelled. Review it before preparing a replacement."
                }
                _ => "Review the encounter's payer and posted charges before submitting.",
            }));
        };
        id
    };
    let mut tx = db.begin().await?;
    let current = billing::account_row(&mut tx, a, patient, account.id).await?;
    if current.status != "posted" || current.content != account.content {
        return Ok(review("Charges changed while preparing the claim. Review the current encounter before submitting."));
    }
    let loaded = claims::claim_row(&mut tx, a, id).await?;
    let claim = if let Some(reviewed) = &request.reviewed_claim {
        let latest: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM ehr_claims WHERE tenant_id=$1 AND account_id=$2 AND status<>'void' ORDER BY created_at DESC,id DESC LIMIT 1",
        )
        .bind(a.tenant_id)
        .bind(account.id)
        .fetch_optional(&mut *tx)
        .await?;
        if loaded.patient_id != patient
            || loaded.account_id != account.id
            || loaded.version != reviewed.version
            || latest != Some(reviewed.id)
        {
            return Ok(review(
                "The claim changed. Reopen Claim details to review the current claim.",
            ));
        }
        loaded
    } else {
        claims::refill_draft(db, &mut tx, a, &loaded, false).await?
    };
    let prior = evidence(&mut tx, a, id).await?;
    tx.commit().await?;
    if let Some(row) = &prior {
        if row["outcome"] != "prepared" || request.mode == Mode::Prepare {
            return Ok(row.clone());
        }
    }
    if !["ready", "draft"].contains(&claim.status.as_str())
        || claim.frequency != "original"
        || claim.parent_id.is_some()
    {
        return Ok(
            json!({"outcome":"blocked","claim_id":id,"reason":"Review the existing claim and its recorded submission history before taking further action."}),
        );
    }
    let issues = claims::preflight(&claim)?;
    if !issues.is_empty() {
        return Ok(json!({"outcome":"needs_review","claim_id":id,"issues":issues}));
    }
    if request.mode == Mode::Prepare {
        return Ok(json!({"outcome":"prepared","claim_id":id}));
    }
    if prior.is_none() && !request.confirmations.complete() {
        return Ok(
            json!({"outcome":"needs_review","claim_id":id,"issues":["Confirm the provider signature on file, benefit assignment, authorization to release and reviewed professional claim."]}),
        );
    }
    let routes = crate::provider_settings::load_for_tenant(db, a.tenant_id).await?;
    let usable: Vec<_> = routes
        .routes
        .iter()
        .filter(|r| r.tenant_id == a.tenant_id && r.adapter == delivery::Adapter::ClaimMd)
        .collect();
    let [route] = usable.as_slice() else {
        return Ok(
            json!({"outcome":"blocked","claim_id":id,"reason":"Choose one verified Claim.MD connection for this practice before sending."}),
        );
    };
    let mut tx = db.begin().await?;
    let partner = clearinghouse::partner(&mut tx, a, route.partner_id).await?;
    let current_partner: PartnerContent = serde_json::from_value(partner.content.clone())
        .map_err(|_| Error::Invalid("Review the active trading partner."))?;
    if !current_partner.active || current_partner.usage != route.usage {
        return Ok(review(
            "Review the active trading partner and its Claim.MD environment.",
        ));
    }
    let prepared = if let Some(row) = prior {
        tx.commit().await?;
        if row["claim_version"] != claim.version
            || row["partner_id"] != json!(partner.id)
            || row["partner_version"] != partner.version
        {
            return Ok(
                json!({"outcome":"blocked","claim_id":id,"reason":"A prepared file exists for another revision or connection. Review it before sending."}),
            );
        }
        let submission_id = serde_json::from_value(row["submission_id"].clone())
            .map_err(|_| Error::Integrity("invalid submission ID"))?;
        (
            submission_id,
            row["submission_version"]
                .as_i64()
                .ok_or(Error::Integrity("invalid submission version"))?,
        )
    } else {
        let mut mapped = claims::claim_submission_defaults(&mut tx, a, &claim).await?;
        tx.commit().await?;
        let object = mapped
            .as_object_mut()
            .ok_or(Error::Integrity("invalid submission defaults"))?;
        object.remove("source_references");
        object.remove("billing_taxonomy_source");
        object.extend(
            serde_json::to_value(&request.confirmations)
                .map_err(|_| Error::Invalid("invalid confirmations"))?
                .as_object()
                .ok_or(Error::Invalid("invalid confirmations"))?
                .clone(),
        );
        let details: Details = serde_json::from_value(mapped)
            .map_err(|_| Error::Invalid("Review the structured claim submission fields."))?;
        if !clearinghouse::development_live_claim_allowed(
            std::env::var("ENGINE_ENVIRONMENT").ok().as_deref(),
            &current_partner.usage,
            claim.content["synthetic_test"].as_bool().unwrap_or(false),
            &claim.control_number,
            details.synthetic_test_reviewed,
        ) {
            return Ok(review("A development instance may submit to a live clearinghouse only for an explicitly reviewed synthetic test claim."));
        }
        // Verify the complete packet before promoting a draft. No control number is consumed here.
        crate::x12::generate(
            &claim,
            &current_partner,
            &details,
            None,
            1,
            chrono::Utc::now(),
        )?;
        let ready = if claim.status == "draft" {
            match claims::release_handoff_claim(s, a, id, claim.version).await {
                Ok(ready) => ready,
                Err(Error::Conflict(message)) => {
                    let mut tx = db.begin().await?;
                    let current = claims::claim_row(&mut tx, a, id).await?;
                    if current.status != "ready"
                        || Some(current.version) != claim.version.checked_add(1)
                        || current.content != claim.content
                    {
                        return Err(Error::Conflict(message));
                    }
                    tx.commit().await?;
                    current
                }
                Err(error) => return Err(error),
            }
        } else {
            claim
        };
        let request_id = visit_billing::derived_id(&(
            "encounter-837p",
            a.tenant_id,
            id,
            ready.version,
            partner.id,
            partner.version,
        ))?;
        let submission = clearinghouse::generate_handoff_file(
            s,
            a,
            id,
            ready.version,
            request_id,
            &partner,
            details,
        )
        .await?;
        (submission.id, submission.version)
    };
    let request_id =
        visit_billing::derived_id(&("encounter-claimmd-delivery", a.tenant_id, prepared.0))?;
    let job =
        delivery::queue_handoff_file(s, a, prepared.0, prepared.1, request_id, &route.key).await?;
    Ok(
        json!({"outcome":stage("prepared",job["status"].as_str()),"claim_id":id,"submission_id":prepared.0,"job_id":job["id"],"delivery_status":job["status"]}),
    )
}

#[cfg(test)]
mod tests {
    use super::stage;

    #[test]
    fn claim_handoff_reports_recorded_delivery_evidence() {
        for state in ["queued", "leased", "retry"] {
            assert_eq!(stage("prepared", Some(state)), "queued");
        }
        assert_eq!(stage("prepared", None), "prepared");
        assert_eq!(stage("prepared", Some("unknown")), "waiting");
        assert_eq!(stage("delivered", None), "recorded_externally");
        assert_eq!(stage("delivered", Some("delivered")), "delivered");
        for state in ["blocked", "cancelled"] {
            assert_eq!(stage("prepared", Some(state)), "blocked");
        }
        assert_eq!(stage("cancelled", None), "blocked");
    }
}
