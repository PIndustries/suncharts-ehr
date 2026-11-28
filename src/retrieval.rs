// SPDX-License-Identifier: AGPL-3.0-only
//! Durable provider inbox: persist discoveries before advancing cursors; stage evidence, never infer clinical acceptance.
use crate::{
    auth::Actor,
    billing,
    delivery::{Adapter, Config, Route},
    error::{Error, Result},
    model::text,
    stedi, State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashMap;
use uuid::Uuid;
fn core() -> String {
    stedi::CORE.into()
}
fn interval() -> i64 {
    60
}
fn hosts() -> Vec<String> {
    vec!["stedi-default-core-artifacts.s3.us-east-1.amazonaws.com".into()]
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub start_at: DateTime<Utc>,
    #[serde(default = "core")]
    pub core_base: String,
    #[serde(default = "interval")]
    pub interval_seconds: i64,
    #[serde(default = "hosts")]
    pub download_hosts: Vec<String>,
    #[serde(default)]
    pub claimmd_response_id: Option<String>,
}
impl Settings {
    pub fn validate(&self, r: &Route) -> Result<()> {
        if self.start_at > Utc::now() - chrono::Duration::minutes(1)
            || !(30..=86400).contains(&self.interval_seconds)
            || self.download_hosts.len() > 10
        {
            return Err(Error::Invalid("invalid retrieval start or interval"));
        }
        if r.adapter == Adapter::Stedi {
            let u = url::Url::parse(&self.core_base)
                .map_err(|_| Error::Invalid("invalid Stedi core base"))?;
            let local = r.loopback_test
                && u.origin()
                    == url::Url::parse(&r.endpoint)
                        .map_err(|_| Error::Invalid("invalid submit URL"))?
                        .origin()
                && u.query().is_none()
                && u.fragment().is_none()
                && u.username().is_empty()
                && u.password().is_none();
            if !local && self.core_base != stedi::CORE {
                return Err(Error::Invalid(
                    "Stedi core base must use the documented endpoint",
                ));
            }
            if self.download_hosts.iter().any(|h| {
                h.is_empty()
                    || !h.bytes().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-'
                    })
                    || !h.ends_with(".amazonaws.com")
            }) {
                return Err(Error::Invalid(
                    "Stedi download hosts must be explicit AWS artifact hosts",
                ));
            }
        }
        if self.claimmd_response_id.as_ref().is_some_and(|v| {
            v.is_empty()
                || v.len() > 20
                || !v.bytes().all(|c| c.is_ascii_digit())
                || v.parse::<u64>().is_err()
        }) {
            return Err(Error::Invalid("Claim.MD response cursor must be numeric"));
        }
        Ok(())
    }
}
pub(crate) struct Observation {
    pub remote_id: String,
    pub format: String,
    pub metadata: Value,
    pub status: String,
    pub inline: Option<String>,
}
pub(crate) struct Page {
    pub items: Vec<Observation>,
    pub next: Option<String>,
}
pub(crate) fn binding(r: &Route) -> String {
    let mut value = json!({"partner":r.partner_id,"usage":r.usage,"adapter":r.adapter,"endpoint":r.endpoint,"credential_ref":r.credential_env,"sftp":r.sftp,"core_base":r.retrieval.as_ref().map(|s|s.core_base.as_str()).unwrap_or(stedi::CORE)});
    if let Some(secret) = &r.credential_value {
        value["native_credential"] = json!(crate::oauth::hash(secret.expose()));
    }
    crate::oauth::hash(&value.to_string())
}

fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
pub(crate) async fn connection_event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    key: &str,
    reason: &str,
    evidence: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO edi_connection_events (tenant_id,route_key,version,actor_id,reason,evidence) SELECT tenant_id,route_key,version,$3,$4,$5 FROM edi_connections WHERE tenant_id=$1 AND route_key=$2").bind(a.tenant_id).bind(key).bind(a.sub).bind(reason).bind(evidence).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "edi.connection_change", a.tenant_id).await
}
async fn report_event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    reason: &str,
    evidence: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO edi_remote_report_events (tenant_id,report_id,version,actor_id,reason,evidence) SELECT tenant_id,id,version,$3,$4,$5 FROM edi_remote_reports WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(a.sub).bind(reason).bind(evidence).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "edi.remote_report_change", id).await
}
pub(crate) async fn connection_paused(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    key: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT coalesce((SELECT paused FROM edi_connections WHERE tenant_id=$1 AND route_key=$2),false)").bind(a.tenant_id).bind(key).fetch_one(&mut **tx).await?)
}
pub(crate) async fn delivery_binding(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Route,
) -> Result<bool> {
    if r.adapter == Adapter::Gateway {
        return Ok(true);
    }
    ensure_connection(tx, a, r).await?;
    Ok(sqlx::query_scalar("SELECT binding_hash=$3 AND NOT paused FROM edi_connections WHERE tenant_id=$1 AND route_key=$2").bind(a.tenant_id).bind(&r.key).bind(binding(r)).fetch_one(&mut **tx).await?)
}
async fn ensure_connection(tx: &mut Transaction<'_, Postgres>, a: &Actor, r: &Route) -> Result<()> {
    let start = r
        .retrieval
        .as_ref()
        .map(|v| v.start_at)
        .unwrap_or_else(|| Utc::now() - chrono::Duration::days(1));
    let count=sqlx::query("INSERT INTO edi_connections (tenant_id,route_key,partner_id,usage,adapter,binding_hash,start_at,paused,page_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING").bind(a.tenant_id).bind(&r.key).bind(r.partner_id).bind(&r.usage).bind(serde_json::to_value(r.adapter).unwrap().as_str().unwrap()).bind(binding(r)).bind(start).bind(false).bind(if r.adapter==Adapter::ClaimMd {Some(r.retrieval.as_ref().and_then(|s|s.claimmd_response_id.clone()).unwrap_or_else(||"0".into()))}else{None}).execute(&mut **tx).await?.rows_affected();
    if count > 0 {
        connection_event(tx,a,&r.key,"Operator provisioned provider connection",json!({"adapter":r.adapter,"usage":r.usage,"retrieval_configured":r.retrieval.is_some()})).await?;
    }
    Ok(())
}
pub async fn sync(pool: &PgPool, c: &Config) -> Result<()> {
    c.validate()?;
    for r in c.routes.iter().filter(|r| r.adapter != Adapter::Gateway) {
        let a = crate::delivery::worker(r.tenant_id);
        let mut tx = pool.begin().await?;
        billing::tenant_lock(&mut tx, &a).await?;
        // A route with a missing partner stays inactive without inventing a partner.
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM edi_partners WHERE tenant_id=$1 AND id=$2)",
        )
        .bind(a.tenant_id)
        .bind(r.partner_id)
        .fetch_one(&mut *tx)
        .await?;
        if exists {
            ensure_connection(&mut tx, &a, r).await?;
        }
        tx.commit().await?;
    }
    Ok(())
}
pub(crate) async fn insert_observation(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    key: &str,
    item: &Observation,
) -> Result<()> {
    let prior:Option<(String,Value,Option<String>)>=sqlx::query_as("SELECT format,metadata,original_hash FROM edi_remote_reports WHERE tenant_id=$1 AND route_key=$2 AND remote_id=$3").bind(a.tenant_id).bind(key).bind(&item.remote_id).fetch_optional(&mut **tx).await?;
    if let Some((format, metadata, original_hash)) = prior {
        if format != item.format
            || metadata != item.metadata
            || item.inline.as_ref().is_some_and(|raw| {
                original_hash.as_deref() != Some(crate::oauth::hash(raw).as_str())
            })
        {
            return Err(Error::Conflict(
                "provider reused a report identity with changed evidence",
            ));
        }
        return Ok(());
    }
    if item.remote_id.is_empty() || item.remote_id.len() > 200 {
        return Err(Error::Invalid("invalid provider report identity"));
    }
    let id = Uuid::new_v4();
    let (mut status, parsed) = if let Some(raw) = &item.inline {
        classify(raw, &item.format)
    } else {
        (item.status.clone(), json!({}))
    };
    if item.status == "quarantined" {
        status = "quarantined".into();
    }
    sqlx::query("INSERT INTO edi_remote_reports (tenant_id,id,route_key,remote_id,format,metadata,status,original_text,original_hash,parse_summary,last_result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(a.tenant_id).bind(id).bind(key).bind(&item.remote_id).bind(&item.format).bind(&item.metadata).bind(&status).bind(&item.inline).bind(item.inline.as_ref().map(|v|crate::oauth::hash(v))).bind(parsed).bind(if item.inline.is_some(){"original_received"}else{item.status.as_str()}).execute(&mut **tx).await?;
    report_event(
        tx,
        a,
        id,
        "Provider report discovered; no clinical status applied",
        json!({"route_key":key,"format":item.format,"status":status}),
    )
    .await
}
pub(crate) async fn initial_ack(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Route,
    v: &crate::stedi::Confirmation,
    submission: Uuid,
) -> Result<()> {
    ensure_connection(tx, a, r).await?;
    if let Some(raw) = &v.acknowledgment {
        insert_observation(tx,a,&r.key,&Observation{remote_id:format!("submission:{submission}"),format:"x12_277ca".into(),metadata:json!({"source":"stedi_submission_response","correlation_id":v.correlation,"submission_id":submission,"declared_origin":"clearinghouse"}),status:if raw.starts_with("ISA") && raw.as_bytes().get(102).is_some_and(|b|*b!=r.usage.as_bytes()[0]) {"quarantined"}else{"retrieved"}.into(),inline:Some(raw.clone())}).await?;
    }
    Ok(())
}
fn detect(raw: &str) -> &'static str {
    let (element, terminator) = if raw.starts_with("ISA") && raw.len() >= 106 {
        (raw.as_bytes()[3] as char, raw.as_bytes()[105] as char)
    } else {
        ('*', '~')
    };
    let transaction = raw.split(terminator).find_map(|segment| {
        let mut fields = segment.trim().split(element);
        if fields.next() == Some("ST") {
            fields.next()
        } else {
            None
        }
    });
    match transaction {
        Some("835") => "x12_835",
        Some("999") => "x12_999",
        Some("277") if raw.contains("005010X214") => "x12_277ca",
        _ if raw
            .split(terminator)
            .any(|s| s.trim().starts_with(&format!("TA1{element}"))) =>
        {
            "x12_ta1"
        }
        _ => "unsupported",
    }
}

fn classify(raw: &str, format: &str) -> (String, Value) {
    let result = match format {
        "x12_277ca" => crate::ca277::parse(raw).map(|d| json!(d)),
        "x12_unknown" => {
            let detected = detect(raw);
            let (status, parsed) = classify(raw, detected);
            return (status, json!({"detected_format":detected,"parsed":parsed}));
        }
        "claimmd_status" => serde_json::from_str::<Value>(raw)
            .map_err(|_| Error::Invalid("invalid Claim.MD evidence")),
        "x12_835"=>crate::era_file::parse(raw).map(|parts|json!({"requires_native_review":true,"transaction_count":parts.len(),"requires_batch":parts.len()>1,"claim_count":parts.iter().map(|p|p.document.claims.len()).sum::<usize>()})),
        "x12_999" | "x12_ta1" => {
            let expected = match format {
                "x12_999" => "ST*999*",
                _ => "TA1*",
            };
            if raw.contains(expected) {
                Ok(json!({"requires_native_review":true}))
            } else {
                Err(Error::Invalid(
                    "unexpected transaction type or delimiters; review original",
                ))
            }
        }
        _ => Err(Error::Invalid("unsupported provider document format")),
    };
    match result {
        Ok(v) => ("retrieved".into(), v),
        Err(_) => (
            "quarantined".into(),
            json!({"issue":"Original retained; unsupported or malformed document requires review"}),
        ),
    }
}
fn stedi_page(v: Value, usage: &str) -> Result<Page> {
    let next = v["nextPageToken"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 1024)
        .ok_or(Error::Invalid("provider cursor missing or oversized"))?
        .to_owned();
    let rows = v["items"]
        .as_array()
        .filter(|v| v.len() <= 500)
        .ok_or(Error::Invalid("invalid provider transaction page"))?;
    let mut items = vec![];
    for v in rows {
        let id = Uuid::parse_str(v["transactionId"].as_str().unwrap_or(""))
            .map_err(|_| Error::Invalid("invalid provider transaction ID"))?;
        let kind = v["x12"]["metadata"]["transaction"]["transactionSetIdentifier"]
            .as_str()
            .or(v["x12"]["transactionSetIdentifier"].as_str())
            .unwrap_or("");
        let format = match kind {
            "277" => "x12_277ca",
            "999" => "x12_999",
            "TA1" => "x12_ta1",
            "835" => "x12_835",
            _ => "unsupported",
        };
        let mode = v["mode"].as_str().unwrap_or("");
        let direction = v["direction"].as_str().unwrap_or("");
        let supported = v["status"] == "succeeded"
            && direction == "INBOUND"
            && mode == if usage == "T" { "test" } else { "production" }
            && format != "unsupported";
        // Do not retain artifact URLs or arbitrary response properties; discovery cannot choose a download destination.
        items.push(Observation{remote_id:id.to_string(),format:format.into(),metadata:json!({"transaction_id":id,"mode":mode,"direction":direction,"provider_status":v["status"],"transaction_type":kind}),status:if supported{"pending"}else{"ignored"}.into(),inline:None});
    }
    Ok(Page {
        items,
        next: Some(next),
    })
}
// A clearinghouse acknowledgement is receipt evidence; a payer sender's acceptance or
// any rejection on a matched response sets the claim's status. Nothing posts payment.
fn claimmd_identity_matches(evidence: &Value, frozen: &Value) -> bool {
    let account = &frozen["snapshot"]["account"];
    let content = &frozen["content"];
    // Outer whitespace never decides identity: a value saved with a stray space comes back
    // from the clearinghouse trimmed. An empty value (after trimming) never matches.
    let nonempty_equal = |left: &Value, right: &Value| {
        left.as_str()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty() && right.as_str().map(str::trim) == Some(value))
    };
    let control = &evidence["pcn"];
    let Some(cents) = account["total_cents"].as_i64().filter(|v| *v > 0) else {
        return false;
    };
    (nonempty_equal(control, &frozen["control_number"])
        || nonempty_equal(control, &content["external_control_number"]))
        && nonempty_equal(&evidence["bill_npi"], &content["billing_npi"])
        && nonempty_equal(&evidence["bill_taxid"], &content["tax_id"])
        && nonempty_equal(
            &evidence["ins_number"],
            &account["coverage_snapshot"]["coverage"]["content"]["member_id"],
        )
        && nonempty_equal(
            &evidence["payerid"],
            &account["coverage_snapshot"]["payer"]["content"]["payer_code"],
        )
        && evidence["total_charge"].as_str().map(str::trim)
            == Some(format!("{}.{:02}", cents / 100, cents % 100).as_str())
        && nonempty_equal(&evidence["fdos"], &account["content"]["service_date"])
}

async fn apply_claimmd_status(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    report: Uuid,
    submission: Uuid,
    evidence: &Value,
) -> Result<&'static str> {
    let out = crate::clearinghouse::submission(tx, a, submission).await?;
    let claim = crate::claims::claim_row(tx, a, out.claim_id).await?;
    let sender_id = evidence["senderid"].as_str().unwrap_or("");
    let sender_name = evidence["sender_name"].as_str().unwrap_or("");
    let sender_icn = evidence["sender_icn"].as_str().unwrap_or("");
    let message = evidence["message"]["message"].as_str().unwrap_or("");
    let rejected = evidence["status"] == "R" || evidence["message"]["status"] == "R";
    // Claim.MD answering the claim with anything that is not a rejection or a correction — the
    // claim acknowledged, forwarded, or the payer's answer carried through — closes an open
    // correction. It is checked on this transaction, so one poll carrying a warning and the
    // answer that settles it can never close the answer.
    let clears_correction = !rejected
        && evidence["message"]["status"].as_str() != Some("W")
        && evidence["message"].is_object();
    if out.status != "delivered"
        || crate::claim_cob::tracking_only(&claim)
        || crate::delivery::ensure_claim_unreserved(tx, a, claim.id)
            .await
            .is_err()
    {
        return Ok("none");
    }
    if rejected {
        if !["submitted", "accepted"].contains(&claim.status.as_str()) {
            return Ok("none");
        }
        sqlx::query("UPDATE ehr_claims SET status='rejected',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(claim.id).execute(&mut **tx).await?;
        crate::claims::revision(tx,a,claim.id,"Claim.MD reported that this claim was rejected",json!({"event":"claimmd_rejection","submission_id":submission,"retrieved_report_id":report,"sender_id":sender_id,"sender_name":sender_name,"message":message,"evidence_origin":"claimmd_status_feed"})).await?;
        sqlx::query("UPDATE edi_submissions SET technical_status=CASE WHEN $3='CLMMD' THEN 'rejected' ELSE technical_status END,payer_outcome=CASE WHEN $3='CLMMD' THEN payer_outcome ELSE 'rejected' END,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(submission).bind(sender_id).execute(&mut **tx).await?;
        return Ok("rejected");
    }
    // Claim.MD's own status letters, never a payer's: "W" names a problem on the claim that
    // keeps it with the clearinghouse ("Rejected Claims need correcting" on the Claim.MD
    // screen), and an acknowledged upload only proves Claim.MD received the claim. Neither
    // touches the claim's status or the ledger; both are recorded so the claim page can say
    // what the clearinghouse said. Every branch here is idempotent on the report's own ID,
    // because the response feed is replayed after a cursor reset or a source import.
    let from_claim_md = sender_id.is_empty() || sender_id == "CLMMD";
    if from_claim_md && evidence["message"]["status"].as_str() == Some("W") {
        if crate::claims::claimmd_warning_applied(tx, a.tenant_id, claim.id, report).await? {
            return Ok("none");
        }
        // 'needs_review' is the submission outcome that means staff must act; the claim row
        // itself has no such status and stays exactly as the transport left it. The bump
        // happens first so the revision below freezes the claim's real next version.
        sqlx::query("UPDATE ehr_claims SET version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(claim.id)
            .execute(&mut **tx)
            .await?;
        crate::claims::revision(tx,a,claim.id,crate::claims::CLAIMMD_WARNING_REASON,json!({"event":"claimmd_warning","submission_id":submission,"retrieved_report_id":report,"sender_id":sender_id,"sender_name":sender_name,"message":message,"evidence_origin":"claimmd_status_feed"})).await?;
        sqlx::query("UPDATE edi_submissions SET technical_status='needs_review',version=version+1 WHERE tenant_id=$1 AND id=$2 AND technical_status='pending'")
            .bind(a.tenant_id)
            .bind(submission)
            .execute(&mut **tx)
            .await?;
        return Ok("needs_correction");
    }
    if from_claim_md
        && evidence["message"]["status"].as_str() == Some("A")
        && message.trim().eq_ignore_ascii_case("acknowledged")
    {
        if crate::claims::claimmd_received_applied(tx, a.tenant_id, claim.id, report).await? {
            return Ok("none");
        }
        sqlx::query("UPDATE ehr_claims SET version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(claim.id)
            .execute(&mut **tx)
            .await?;
        crate::claims::revision(tx,a,claim.id,"Claim.MD received the claim",json!({"event":"claimmd_received","submission_id":submission,"retrieved_report_id":report,"sender_id":sender_id,"sender_name":sender_name,"message":message,"evidence_origin":"claimmd_status_feed"})).await?;
        return Ok("received");
    }
    // A later answer closes an open correction first; when that answer is the payer's
    // acceptance it is then applied below as usual.
    let mut technical_status = out.technical_status.clone();
    if clears_correction
        && crate::claims::claimmd_settle_correction(tx, a, claim.id, report).await?
    {
        sqlx::query("UPDATE edi_submissions SET technical_status='pending',version=version+1 WHERE tenant_id=$1 AND id=$2 AND technical_status='needs_review'")
            .bind(a.tenant_id)
            .bind(submission)
            .execute(&mut **tx)
            .await?;
        technical_status = "pending".into();
        if evidence["status"] != "A" || from_claim_md || sender_icn.is_empty() {
            return Ok("settled");
        }
    }
    if evidence["status"] != "A"
        || sender_id.is_empty()
        || sender_id == "CLMMD"
        || sender_icn.is_empty()
        || sender_icn.len() > 150
        || claim.status != "submitted"
        || out.payer_outcome != "pending"
        || ["rejected", "needs_review"].contains(&technical_status.as_str())
    {
        return Ok("none");
    }
    sqlx::query("UPDATE ehr_claims SET status=$3,payer_control_number=CASE WHEN $4='' THEN payer_control_number ELSE $4 END,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(claim.id).bind("accepted").bind(sender_icn).execute(&mut **tx).await?;
    crate::claims::revision(tx,a,claim.id,"The payer accepted this claim",json!({"event":"claimmd_payer_acceptance","submission_id":submission,"retrieved_report_id":report,"sender_id":sender_id,"sender_name":sender_name,"message":message,"payer_control_number":sender_icn,"evidence_origin":"claimmd_status_feed"})).await?;
    sqlx::query("UPDATE edi_submissions SET payer_outcome=$3,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(submission).bind("accepted").execute(&mut **tx).await?;
    Ok("accepted")
}

async fn attach_claimmd_status(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    key: &str,
) -> Result<()> {
    // Receipt binding narrows the candidates before inspecting patient identifiers.
    // Imported records are not eligible, and no match/ambiguous matches stay in the review inbox.
    // A report already matched by the claim's own control number is retried here too: the
    // delivery it belongs to can be confirmed after the response arrived, and the provider
    // feed is replayed after a cursor reset. `status='retrieved'` and `native_id IS NULL` keep
    // an attached or quarantined report out of the loop, so an applied report stays applied.
    let reports: Vec<(Uuid, Value, Option<String>)> = sqlx::query_as("SELECT r.id,r.parse_summary,r.last_result FROM edi_remote_reports r WHERE r.tenant_id=$1 AND r.route_key=$2 AND r.format='claimmd_status' AND r.status='retrieved' AND r.native_id IS NULL AND r.metadata->>'source'='claimmd_response_api' AND r.last_result IS DISTINCT FROM 'control_number_needs_review' AND (EXISTS (SELECT 1 FROM edi_delivery_jobs j WHERE j.tenant_id=r.tenant_id AND j.route_key=r.route_key AND j.status='delivered' AND (j.receipt_reference='claimmd-file:'||(r.parse_summary->>'fileid') OR j.receipt_reference='claimmd-claim:'||(r.parse_summary->>'claimmd_id'))) OR (coalesce(r.parse_summary->>'fileid','')='' AND coalesce(r.parse_summary->>'claimmd_id','')='')) ORDER BY coalesce(r.last_result='identity_match_needs_review',false),r.received_at,CASE WHEN r.metadata->>'response_id' ~ '^[0-9]{1,20}$' THEN (r.metadata->>'response_id')::numeric END,r.id LIMIT 200")
        .bind(a.tenant_id).bind(key).fetch_all(&mut **tx).await?;
    for (report, evidence, prior_result) in reports {
        let references = crate::claimmd::receipt_references(&evidence);
        let candidates: Vec<(Uuid, Value)> = if references.is_empty() {
            // Claim.MD answered without ever reporting a file or claim ID, so nothing ties the
            // response to a delivery by receipt. The claim's own patient control number does:
            // it is what SunCharts sent in `pcn`, and Claim.MD echoes it back. Only a delivered
            // submission on this route and tenant is a candidate, the frozen snapshot is the
            // only identity read, and an exact duplicate claim of the same control number is
            // still resolved by the identity rule below rather than guessed at.
            control_number_candidates(tx, a, key, &evidence).await?
        } else {
            sqlx::query_as("SELECT DISTINCT s.id,s.claim_snapshot FROM edi_submissions s JOIN edi_delivery_jobs j ON j.tenant_id=s.tenant_id AND j.submission_id=s.id JOIN edi_connections c ON c.tenant_id=j.tenant_id AND c.route_key=j.route_key AND c.partner_id=s.partner_id WHERE j.tenant_id=$1 AND j.route_key=$2 AND j.status='delivered' AND s.status='delivered' AND j.receipt_reference=ANY($3)")
                .bind(a.tenant_id).bind(key).bind(&references).fetch_all(&mut **tx).await?
        };
        let matches: Vec<_> = candidates
            .iter()
            .filter(|(_, frozen)| claimmd_identity_matches(&evidence, frozen))
            .collect();
        if matches.len() != 1 {
            let result = if references.is_empty() {
                "control_number_needs_review"
            } else {
                "identity_match_needs_review"
            };
            // A report still waiting for review is retried every poll; it is written (and an
            // event recorded) only when its result actually changes.
            if prior_result.as_deref() == Some(result) {
                continue;
            }
            sqlx::query("UPDATE edi_remote_reports SET last_result=$3,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(report).bind(result).execute(&mut **tx).await?;
            report_event(
                tx,
                a,
                report,
                if references.is_empty() {
                    "No delivered submission carries this provider control number uniquely; operator review required"
                } else {
                    "No unique exact claim match; operator review required"
                },
                json!({"clinical_status_changed":false,"match_count":matches.len()}),
            )
            .await?;
            continue;
        }
        let submission = matches[0].0;
        link_evidence(
            tx,
            a,
            report,
            "submission",
            submission,
            if references.is_empty() {
                "Exact Claim.MD patient control number and frozen claim identities matched"
            } else {
                "Exact Claim.MD receipt and frozen claim identities matched"
            },
            false,
        )
        .await?;
        let applied = apply_claimmd_status(tx, a, report, submission, &evidence).await?;
        sqlx::query("UPDATE edi_submissions SET version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(submission)
            .execute(&mut **tx)
            .await?;
        crate::clearinghouse::event(tx,a,submission,"Claim.MD status evidence attached automatically",json!({"retrieved_report_id":report,"provider":"claim_md","clinical_status_changed":applied!="none","claim_status":applied,"status_evidence":evidence,"origin":if references.is_empty() {"exact_control_number_and_identity_match"} else {"exact_receipt_and_identity_match"}})).await?;
        // A report whose message changes nothing for the claim (a Claim.MD acknowledgement of
        // a claim already accepted, an unrelated status letter) is attached and stays out of
        // the next pass; one whose message still has to be applied is retried on the next
        // retrieval pass instead of waiting for a provider resend that will never come.
        if applied == "none" {
            sqlx::query("UPDATE edi_remote_reports SET last_result='status_applied',version=version+1 WHERE tenant_id=$1 AND id=$2")
                .bind(a.tenant_id)
                .bind(report)
                .execute(&mut **tx)
                .await?;
        }
    }
    Ok(())
}

/// Reports attached before their message was understood (Claim.MD's "W" and "Acknowledged"
/// letters) were linked to their submission but never applied. Each such report is applied
/// once more, only while its submission is still the claim's latest delivered one and no later
/// report on that submission has already been settled, and is then marked `status_applied` so
/// it is never looked at again. Applying is idempotent per report, and the rejection and
/// acceptance branches stay guarded by the claim's own status.
async fn reapply_claimmd_status(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    key: &str,
) -> Result<()> {
    let reports: Vec<(Uuid, Uuid, Value)> = sqlx::query_as("SELECT r.id,r.native_id,r.parse_summary FROM edi_remote_reports r JOIN edi_submissions s ON s.tenant_id=r.tenant_id AND s.id=r.native_id WHERE r.tenant_id=$1 AND r.route_key=$2 AND r.format='claimmd_status' AND r.status='retrieved' AND r.native_kind='submission' AND r.metadata->>'source'='claimmd_response_api' AND r.last_result IS DISTINCT FROM 'status_applied' AND s.status='delivered' AND NOT EXISTS (SELECT 1 FROM edi_submissions n WHERE n.tenant_id=s.tenant_id AND n.claim_id=s.claim_id AND n.status='delivered' AND n.created_at>s.created_at) AND NOT EXISTS (SELECT 1 FROM edi_remote_reports l WHERE l.tenant_id=r.tenant_id AND l.format='claimmd_status' AND l.native_id=r.native_id AND l.last_result='status_applied' AND l.received_at>r.received_at) ORDER BY r.received_at,CASE WHEN r.metadata->>'response_id' ~ '^[0-9]{1,20}$' THEN (r.metadata->>'response_id')::numeric END,r.id LIMIT 200")
        .bind(a.tenant_id).bind(key).fetch_all(&mut **tx).await?;
    for (report, submission, evidence) in reports {
        let applied = apply_claimmd_status(tx, a, report, submission, &evidence).await?;
        sqlx::query("UPDATE edi_remote_reports SET last_result='status_applied',version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(report)
            .execute(&mut **tx)
            .await?;
        report_event(
            tx,
            a,
            report,
            "Claim.MD status message applied on a later pass",
            json!({"clinical_status_changed":applied!="none","claim_status":applied}),
        )
        .await?;
    }
    Ok(())
}

/// Delivered submissions on this route whose frozen claim carries the control number the
/// provider echoed back. Claim.MD answers some responses with no file ID at all, and both
/// `pcn` and `claimid` hold the submitter's own claim number; either one is accepted only
/// when it names one claim, and the frozen identity check still decides.
async fn control_number_candidates(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    key: &str,
    evidence: &Value,
) -> Result<Vec<(Uuid, Value)>> {
    let controls: Vec<&str> = ["pcn", "claimid"]
        .iter()
        .filter_map(|field| evidence[*field].as_str())
        .map(str::trim)
        .filter(|control| !control.is_empty() && control.len() <= 100)
        .fold(Vec::new(), |mut seen: Vec<&str>, control| {
            if !seen.contains(&control) {
                seen.push(control);
            }
            seen
        });
    if controls.is_empty() {
        return Ok(vec![]);
    }
    Ok(sqlx::query_as("SELECT DISTINCT s.id,s.claim_snapshot FROM edi_submissions s JOIN edi_delivery_jobs j ON j.tenant_id=s.tenant_id AND j.submission_id=s.id WHERE j.tenant_id=$1 AND j.route_key=$2 AND j.status='delivered' AND s.status='delivered' AND s.claim_snapshot->>'control_number'=ANY($3)")
        .bind(a.tenant_id).bind(key).bind(controls).fetch_all(&mut **tx).await?)
}

pub(crate) struct ClaimRemittanceDisposition {
    pub payer_denied: Option<bool>,
    pub paid_cents: Option<i64>,
    pub denial_codes: Vec<String>,
}

pub(crate) async fn claim_remittance_dispositions(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    claims: &[Uuid],
) -> Result<HashMap<Uuid, ClaimRemittanceDisposition>> {
    if claims.is_empty() {
        return Ok(HashMap::new());
    }
    #[derive(sqlx::FromRow)]
    struct PostedClaimRemittance {
        claim_id: Uuid,
        status: Option<String>,
        paid_cents: Option<Value>,
        denial_codes: Vec<String>,
    }
    // Only the current posted row for each claim speaks for its payer disposition.
    let rows = sqlx::query_as::<_, PostedClaimRemittance>(
        "SELECT h.claim_id,response.record->>'status' AS status,response.record->'paid_cents' AS paid_cents,
                CASE WHEN response.record->>'status'='4' THEN ARRAY(
                  SELECT DISTINCT (a->>'group')||'-'||(a->>'reason_code') AS code
                  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(response.record->'adjustments')='array'
                    THEN response.record->'adjustments' ELSE '[]'::jsonb END) a
                  WHERE a->>'service_index' IS NULL AND a->>'group' IN ('CO','OA','PI')
                    AND a->>'reason_code' ~ '^[A-Z0-9]{1,5}$'
                  ORDER BY code LIMIT 3
                ) ELSE ARRAY[]::text[] END AS denial_codes
         FROM era_claim_heads h
         JOIN era_remittances r ON r.tenant_id=h.tenant_id AND r.id=h.remittance_id
         CROSS JOIN LATERAL (SELECT r.document->'claims'->h.row_index AS record) response
         WHERE h.tenant_id=$1 AND h.claim_id=ANY($2) AND r.status='posted'",
    )
    .bind(tenant)
    .bind(claims)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.claim_id,
                ClaimRemittanceDisposition {
                    payer_denied: row.status.map(|status| status == "4"),
                    paid_cents: row.paid_cents.and_then(|amount| amount.as_i64()),
                    denial_codes: row.denial_codes,
                },
            )
        })
        .collect())
}

pub(crate) async fn claim_tracking(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    claim: &crate::claims::Claim,
) -> Result<Value> {
    let submissions: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id',s.id,'status',s.status,'technical_status',s.technical_status,
          'payer_outcome',s.payer_outcome,'created_at',s.created_at,'delivery_job',j.details)
         FROM edi_submissions s
         LEFT JOIN LATERAL (
            SELECT jsonb_strip_nulls(jsonb_build_object(
                'id',d.id,'submission_id',d.submission_id,'status',d.status,'route_key',d.route_key,
                'created_at',d.created_at,'receipt_reference',d.receipt_reference,
                'claim_md',coalesce(c.adapter='claim_md',d.receipt_reference LIKE 'claimmd-%',false),
                'confirmed_at',CASE WHEN d.status='delivered' THEN e.created_at END)) AS details
            FROM edi_delivery_jobs d
            LEFT JOIN edi_connections c ON c.tenant_id=d.tenant_id AND c.route_key=d.route_key
            LEFT JOIN edi_delivery_events e ON e.tenant_id=d.tenant_id AND e.job_id=d.id AND e.version=d.version
            WHERE d.tenant_id=s.tenant_id AND d.submission_id=s.id
            ORDER BY (d.status<>'cancelled') DESC,d.created_at DESC,d.id DESC LIMIT 1
         ) j ON true
         WHERE s.tenant_id=$1 AND s.claim_id=$2 ORDER BY s.created_at,s.id")
        .bind(a.tenant_id).bind(claim.id).fetch_all(&mut **tx).await?;
    let mut reports: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',r.id,'submission_id',r.native_id,'received_at',r.received_at,'sent',coalesce(r.original_text,r.parse_summary::text),'evidence',r.parse_summary) FROM edi_remote_reports r JOIN edi_submissions s ON s.tenant_id=r.tenant_id AND s.id=r.native_id WHERE r.tenant_id=$1 AND s.claim_id=$2 AND r.native_kind='submission' AND r.format='claimmd_status' ORDER BY r.received_at DESC,CASE WHEN r.metadata->>'response_id' ~ '^[0-9]{1,20}$' THEN (r.metadata->>'response_id')::numeric END DESC,r.id DESC LIMIT 200")
        .bind(a.tenant_id).bind(claim.id).fetch_all(&mut **tx).await?;
    reports.reverse();
    let connections: Vec<Value> = sqlx::query_scalar("SELECT DISTINCT jsonb_build_object('route_key',c.route_key,'paused',c.paused,'last_poll_at',c.last_poll_at,'last_success_at',c.last_success_at,'next_poll_at',c.next_poll_at,'last_result',c.last_result) FROM edi_connections c JOIN edi_delivery_jobs j ON j.tenant_id=c.tenant_id AND j.route_key=c.route_key JOIN edi_submissions s ON s.tenant_id=j.tenant_id AND s.id=j.submission_id WHERE s.tenant_id=$1 AND s.claim_id=$2 AND c.adapter='claim_md'")
        .bind(a.tenant_id).bind(claim.id).fetch_all(&mut **tx).await?;
    let eligibility: Option<Value> = sqlx::query_scalar("SELECT jsonb_build_object('status',status,'created_at',created_at,'completed_at',completed_at,'service_date',request_snapshot->'request'->>'service_date') FROM claimmd_eligibility_checks WHERE tenant_id=$1 AND patient_id=$2 AND coverage_id::text=$3 AND request_snapshot->'request'->>'service_date'=$4 AND request_snapshot->>'member_id'=$5 AND request_snapshot->>'payerid'=$6 ORDER BY created_at DESC,id DESC LIMIT 1")
        .bind(a.tenant_id).bind(claim.patient_id).bind(claim.snapshot["account"]["coverage_snapshot"]["coverage"]["id"].as_str()).bind(claim.snapshot["account"]["content"]["service_date"].as_str()).bind(claim.snapshot["account"]["coverage_snapshot"]["coverage"]["content"]["member_id"].as_str()).bind(claim.snapshot["account"]["coverage_snapshot"]["payer"]["content"]["payer_code"].as_str()).fetch_optional(&mut **tx).await?;
    let external_submission: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM claim_revisions WHERE tenant_id=$1 AND claim_id=$2 AND evidence->>'action'='record_submission')").bind(a.tenant_id).bind(claim.id).fetch_one(&mut **tx).await?;
    let remittance = claim_remittance_dispositions(tx, a.tenant_id, &[claim.id])
        .await?
        .remove(&claim.id);
    Ok(
        json!({"submissions":submissions,"reports":reports,"connections":connections,
        "eligibility":eligibility,"remittance_posted":remittance.is_some(),
        "payer_denied":remittance.as_ref().and_then(|row| row.payer_denied),
        "paid_cents":remittance.as_ref().and_then(|row| row.paid_cents),
        "external_submission_recorded":external_submission}),
    )
}

pub(crate) fn claimmd_poll_delay(
    interval: i64,
    failures: i32,
    ok: bool,
    retry_after: Option<u32>,
) -> (i64, i32) {
    if ok {
        return (interval, 0);
    }
    if let Some(retry) = retry_after {
        return (interval.max(i64::from(retry)), failures);
    }
    let failures = (failures + 1).min(6);
    (
        (interval * (1 << failures)).min(interval.max(1800)),
        failures,
    )
}

pub async fn poll_one(pool: &PgPool, c: &Config) -> Result<bool> {
    sync(pool, c).await?;
    let candidate:Option<(Uuid,String)>=sqlx::query_as("SELECT c.tenant_id,c.route_key FROM edi_connections c JOIN jsonb_to_recordset($1) cfg(tenant_id uuid,route_key text) ON cfg.tenant_id=c.tenant_id AND cfg.route_key=c.route_key WHERE NOT paused AND next_poll_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_poll_at,route_key LIMIT 1").bind(json!(c.routes.iter().filter(|r|r.retrieval.is_some()).map(|r|json!({"tenant_id":r.tenant_id,"route_key":r.key})).collect::<Vec<_>>())).fetch_optional(pool).await?;
    let Some((tenant, key)) = candidate else {
        return Ok(false);
    };
    let a = crate::delivery::worker(tenant);
    let Some(r) = c.route(tenant, &key).filter(|r| r.retrieval.is_some()) else {
        return Ok(false);
    };
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let row:Option<(String,Option<String>,DateTime<Utc>,i32)>=sqlx::query_as("SELECT binding_hash,page_token,start_at,poll_failures FROM edi_connections WHERE tenant_id=$1 AND route_key=$2 AND NOT paused AND next_poll_at<=now() AND (lease_until IS NULL OR lease_until<now())").bind(tenant).bind(&key).fetch_optional(&mut *tx).await?;
    let Some((hash, token, start, failures)) = row else {
        return Ok(false);
    };
    if hash != binding(r) {
        sqlx::query("UPDATE edi_connections SET paused=true,version=version+1,last_result='configuration_changed_use_new_route_key' WHERE tenant_id=$1 AND route_key=$2").bind(tenant).bind(&key).execute(&mut *tx).await?;
        connection_event(
            &mut tx,
            &a,
            &key,
            "Configuration changed; operator review required",
            json!({"cursor_advanced":false}),
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    let lease = Uuid::new_v4();
    sqlx::query("UPDATE edi_connections SET lease_id=$3,lease_until=now()+interval '60 seconds',last_poll_at=now(),version=version+1 WHERE tenant_id=$1 AND route_key=$2").bind(tenant).bind(&key).bind(lease).execute(&mut *tx).await?;
    connection_event(
        &mut tx,
        &a,
        &key,
        "Provider polling leased",
        json!({"cursor_advanced":false}),
    )
    .await?;
    tx.commit().await?;
    let result = match r.adapter {
        Adapter::Stedi => stedi::page(r, token.as_deref(), start)
            .await
            .and_then(|v| stedi_page(v, &r.usage)),
        Adapter::ClaimMd => {
            crate::claimmd::paced(
                pool,
                r,
                crate::claimmd::ApiBudget::Background,
                crate::claimmd::page(r, token.as_deref().unwrap_or("0")),
            )
            .await
        }
        Adapter::OfficeAllySftp | Adapter::AvailitySftp => crate::sftp_transport::page(r).await,
        _ => Err(Error::Invalid("unsupported retrieval adapter")),
    };
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let current:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edi_connections WHERE tenant_id=$1 AND route_key=$2 AND lease_id=$3)").bind(tenant).bind(&key).bind(lease).fetch_one(&mut *tx).await?;
    if !current {
        return Ok(true);
    }
    let mut ok = result.is_ok();
    let retry_after = match &result {
        Err(Error::ClaimMdRateLimited(seconds)) => Some(*seconds),
        _ => None,
    };
    let mut persistence_error = None;
    if let Ok(page) = result {
        sqlx::query("SAVEPOINT provider_page")
            .execute(&mut *tx)
            .await?;
        let persisted: Result<()> = async {
            for item in &page.items {
                insert_observation(&mut tx, &a, &key, item).await?;
            }
            if r.adapter == Adapter::ClaimMd {
                attach_claimmd_status(&mut tx, &a, &key).await?;
                reapply_claimmd_status(&mut tx, &a, &key).await?;
            }
            sqlx::query("UPDATE edi_connections SET page_token=$3,pages=pages+1,last_success_at=now() WHERE tenant_id=$1 AND route_key=$2").bind(tenant).bind(&key).bind(page.next).execute(&mut *tx).await?;
            Ok(())
        }.await;
        if let Err(error) = persisted {
            sqlx::query("ROLLBACK TO SAVEPOINT provider_page")
                .execute(&mut *tx)
                .await?;
            ok = false;
            persistence_error = Some(error);
        }
        sqlx::query("RELEASE SAVEPOINT provider_page")
            .execute(&mut *tx)
            .await?;
    }
    let interval = r.retrieval.as_ref().unwrap().interval_seconds;
    let (delay, failures) = if r.adapter == Adapter::ClaimMd {
        claimmd_poll_delay(interval, failures, ok, retry_after)
    } else {
        (interval, 0)
    };
    let state = if ok {
        "page_persisted"
    } else if retry_after.is_some() {
        "claimmd_rate_limited_cursor_retained"
    } else {
        "poll_failed_cursor_retained"
    };
    sqlx::query("UPDATE edi_connections SET lease_id=NULL,lease_until=NULL,next_poll_at=now()+make_interval(secs=>$3),last_result=$4,poll_failures=$5,version=version+1 WHERE tenant_id=$1 AND route_key=$2").bind(tenant).bind(&key).bind(delay as f64).bind(state).bind(failures).execute(&mut *tx).await?;
    connection_event(
        &mut tx,
        &a,
        &key,
        "Provider polling completed",
        json!({"cursor_advanced":ok}),
    )
    .await?;
    tx.commit().await?;
    if let Some(error) = persistence_error {
        return Err(error);
    }
    Ok(true)
}
pub async fn fetch_one(pool: &PgPool, c: &Config) -> Result<bool> {
    let candidate:Option<(Uuid,Uuid)>=sqlx::query_as("SELECT r.tenant_id,r.id FROM edi_remote_reports r JOIN edi_connections conn ON conn.tenant_id=r.tenant_id AND conn.route_key=r.route_key JOIN jsonb_to_recordset($1) cfg(tenant_id uuid,route_key text,binding_hash text) ON cfg.tenant_id=conn.tenant_id AND cfg.route_key=conn.route_key AND cfg.binding_hash=conn.binding_hash WHERE NOT conn.paused AND ((r.status='pending' AND r.next_attempt_at<=now()) OR (r.status='leased' AND r.lease_until<now())) ORDER BY received_at,id LIMIT 1").bind(json!(c.routes.iter().filter(|r|r.retrieval.is_some()).map(|r|json!({"tenant_id":r.tenant_id,"route_key":r.key,"binding_hash":binding(r)})).collect::<Vec<_>>())).fetch_optional(pool).await?;
    let Some((tenant, id)) = candidate else {
        return Ok(false);
    };
    let a = crate::delivery::worker(tenant);
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let row:Option<(String,String,String)>=sqlx::query_as("SELECT route_key,remote_id,format FROM edi_remote_reports WHERE tenant_id=$1 AND id=$2 AND ((status='pending' AND next_attempt_at<=now()) OR (status='leased' AND lease_until<now()))").bind(tenant).bind(id).fetch_optional(&mut *tx).await?;
    let Some((key, remote, format)) = row else {
        return Ok(false);
    };
    let Some(r) = c.route(tenant, &key) else {
        return Ok(false);
    };
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edi_connections WHERE tenant_id=$1 AND route_key=$2 AND NOT paused AND binding_hash=$3)").bind(tenant).bind(&key).bind(binding(r)).fetch_one(&mut *tx).await?;
    if !valid {
        return Ok(false);
    }
    let lease = Uuid::new_v4();
    sqlx::query("UPDATE edi_remote_reports SET status='leased',lease_id=$3,lease_until=now()+interval '60 seconds',attempts=attempts+1,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(lease).execute(&mut *tx).await?;
    report_event(
        &mut tx,
        &a,
        id,
        "Read-only provider download leased",
        json!({"clinical_mutation":false}),
    )
    .await?;
    tx.commit().await?;
    let result = if r.adapter == Adapter::Stedi {
        match Uuid::parse_str(&remote) {
            Ok(id) => stedi::input(r, id).await,
            Err(_) => Err(Error::Invalid("invalid Stedi transaction ID")),
        }
    } else if r.adapter == Adapter::ClaimMd {
        crate::claimmd::paced(
            pool,
            r,
            crate::claimmd::ApiBudget::Background,
            crate::claimmd::era_input(r, &remote),
        )
        .await
    } else {
        crate::sftp_transport::input(r, &remote).await
    };
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let attempts:Option<i32>=sqlx::query_scalar("SELECT attempts FROM edi_remote_reports WHERE tenant_id=$1 AND id=$2 AND status='leased' AND lease_id=$3").bind(tenant).bind(id).bind(lease).fetch_optional(&mut *tx).await?;
    let Some(attempts) = attempts else {
        return Ok(true);
    };
    match result {
        Ok(raw) => {
            let (mut status, summary) = classify(&raw, &format);
            // Full envelopes carry mode; ST-only documents rely on the dedicated enrolled account/route.
            if raw.starts_with("ISA")
                && raw
                    .as_bytes()
                    .get(102)
                    .is_some_and(|v| *v != r.usage.as_bytes()[0])
            {
                status = "quarantined".into();
            }
            sqlx::query("UPDATE edi_remote_reports SET status=$3,original_text=$4,original_hash=$5,parse_summary=$6,last_result='original_downloaded',lease_id=NULL,lease_until=NULL,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(status).bind(&raw).bind(crate::oauth::hash(&raw)).bind(summary).execute(&mut *tx).await?;
        }
        Err(Error::ClaimMdRateLimited(seconds)) => {
            sqlx::query("UPDATE edi_remote_reports SET status='pending',attempts=greatest(attempts-1,0),last_result='claimmd_rate_limited',next_attempt_at=now()+make_interval(secs=>$3),lease_id=NULL,lease_until=NULL,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(f64::from(seconds)).execute(&mut *tx).await?;
        }
        Err(_) => {
            sqlx::query("UPDATE edi_remote_reports SET status=$3,last_result='download_failed',next_attempt_at=now()+interval '60 seconds',lease_id=NULL,lease_until=NULL,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(if attempts>=3{"quarantined"}else{"pending"}).execute(&mut *tx).await?;
        }
    }
    report_event(
        &mut tx,
        &a,
        id,
        "Provider download completed; native review required",
        json!({"clinical_mutation":false}),
    )
    .await?;
    tx.commit().await?;
    Ok(true)
}
pub async fn run(pool: PgPool, _c: Config) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
    loop {
        tick.tick().await;
        let c = match crate::provider_settings::load(&pool).await {
            Ok(c) => c,
            Err(_) => {
                eprintln!("Clearinghouse configuration unavailable; retrieval held");
                continue;
            }
        };
        if poll_one(&pool, &c).await.is_err() {
            eprintln!("Provider polling failed; durable cursor retained");
        }
        if crate::remittance_automation::poll_one(&pool, &c)
            .await
            .is_err()
        {
            eprintln!("ERA discovery failed; durable cursor retained");
        }
        if fetch_one(&pool, &c).await.is_err() {
            eprintln!("Provider retrieval failed; durable inbox requires inspection");
        }
        if crate::remittance_automation::stage_one(&pool, &c)
            .await
            .is_err()
        {
            eprintln!("ERA staging failed; original retained for review");
        }
    }
}
pub(crate) async fn verify(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    format: &str,
    raw: &str,
    partner: Option<Uuid>,
) -> Result<()> {
    let row:Option<(String,String,Option<Uuid>,Uuid)>=sqlx::query_as("SELECT coalesce(r.parse_summary->>'detected_format',r.format),r.status,r.native_id,c.partner_id FROM edi_remote_reports r JOIN edi_connections c ON c.tenant_id=r.tenant_id AND c.route_key=r.route_key WHERE r.tenant_id=$1 AND r.id=$2 AND r.original_text=$3").bind(a.tenant_id).bind(id).bind(raw).fetch_optional(&mut **tx).await?;
    let Some((f, status, native, p)) = row else {
        return Err(Error::NotFound);
    };
    if f != format || status != "retrieved" || native.is_some() || partner.is_some_and(|id| id != p)
    {
        return Err(Error::Conflict(
            "provider report requires unchanged original, correct partner and independent review",
        ));
    }
    Ok(())
}
pub(crate) async fn link(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    kind: &str,
    native: Uuid,
    reason: &str,
) -> Result<()> {
    link_evidence(tx, a, id, kind, native, reason, true).await
}
pub(crate) async fn link_evidence(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    kind: &str,
    native: Uuid,
    reason: &str,
    reviewed: bool,
) -> Result<()> {
    sqlx::query("UPDATE edi_remote_reports SET native_kind=$3,native_id=$4,version=version+1 WHERE tenant_id=$1 AND id=$2 AND native_id IS NULL").bind(a.tenant_id).bind(id).bind(kind).bind(native).execute(&mut **tx).await?;
    report_event(
        tx,
        a,
        id,
        reason,
        json!({"native_kind":kind,"native_id":native,"explicit_review":reviewed}),
    )
    .await
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/billing/connections", get(connections))
        .route("/api/v1/billing/connections/{key}", get(connection_detail))
        .route(
            "/api/v1/billing/connections/{key}/actions",
            post(connection_action),
        )
        .route(
            "/api/v1/billing/claims/{id}/claimmd-status/check",
            post(claimmd_check),
        )
        .route("/api/v1/billing/retrieved-reports", get(reports))
        .route(
            "/api/v1/billing/retrieved-reports/from-source",
            post(from_source),
        )
        .route("/api/v1/billing/retrieved-reports/{id}", get(report_detail))
        .route(
            "/api/v1/billing/retrieved-reports/{id}/actions",
            post(report_action),
        )
}
async fn claimmd_check(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let pool = db(&s)?;
    let config = crate::provider_settings::load_for_tenant(pool, a.tenant_id).await?;
    Ok(Json(check_claimmd_status(pool, &a, id, &config).await?))
}
/// Asks Claim.MD for every message it holds on one claim. The polling cursor is never touched.
pub async fn check_claimmd_status(
    pool: &PgPool,
    a: &Actor,
    id: Uuid,
    config: &Config,
) -> Result<Value> {
    a.staff()?;
    let mut tx = pool.begin().await?;
    crate::claims::claim_row(&mut tx, a, id).await?;
    let job: Option<(String, String)> = sqlx::query_as("SELECT j.route_key,j.receipt_reference FROM edi_delivery_jobs j JOIN edi_submissions s ON s.tenant_id=j.tenant_id AND s.id=j.submission_id WHERE j.tenant_id=$1 AND s.claim_id=$2 AND j.status='delivered' AND j.receipt_reference LIKE 'claimmd-%' ORDER BY j.created_at DESC,j.id DESC LIMIT 1")
        .bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
    // A file receipt wins at delivery time; the claim ID then comes from the first message Claim.MD sent back.
    let claimmd_id: Option<String> = match &job {
        Some((_, reference)) if reference.starts_with("claimmd-claim:") => {
            Some(reference.trim_start_matches("claimmd-claim:").to_string())
        }
        Some(_) => sqlx::query_scalar("SELECT r.parse_summary->>'claimmd_id' FROM edi_remote_reports r JOIN edi_submissions s ON s.tenant_id=r.tenant_id AND s.id=r.native_id WHERE r.tenant_id=$1 AND s.claim_id=$2 AND r.native_kind='submission' AND r.format='claimmd_status' AND coalesce(r.parse_summary->>'claimmd_id','')<>'' ORDER BY r.received_at DESC,r.id DESC LIMIT 1")
            .bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?,
        None => None,
    };
    tx.rollback().await?;
    let (Some((key, _)), Some(claimmd_id)) = (job, claimmd_id) else {
        return Err(Error::Invalid(
            "This claim has not been given a Claim.MD claim ID yet.",
        ));
    };
    let Some(r) = config
        .route(a.tenant_id, &key)
        .filter(|r| r.adapter == Adapter::ClaimMd)
    else {
        return Err(Error::Conflict(
            "enable and verify a Claim.MD connection before checking",
        ));
    };
    let lease = Uuid::new_v4();
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let leased = sqlx::query("UPDATE edi_connections SET lease_id=$3,lease_until=now()+interval '60 seconds' WHERE tenant_id=$1 AND route_key=$2 AND (lease_until IS NULL OR lease_until<now())").bind(a.tenant_id).bind(&key).bind(lease).execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    if leased == 0 {
        return Err(Error::Conflict(
            "Claim.MD is being checked right now. Try again in a minute.",
        ));
    }
    let result = crate::claimmd::paced(
        pool,
        r,
        crate::claimmd::ApiBudget::Foreground,
        crate::claimmd::claim_page(r, &claimmd_id),
    )
    .await;
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, a).await?;
    let released = sqlx::query("UPDATE edi_connections SET lease_id=NULL,lease_until=NULL WHERE tenant_id=$1 AND route_key=$2 AND lease_id=$3").bind(a.tenant_id).bind(&key).bind(lease).execute(&mut *tx).await?.rows_affected();
    let page = match result {
        Ok(page) if released > 0 => page,
        other => {
            tx.commit().await?;
            return Err(other.err().unwrap_or(Error::Conflict(
                "Claim.MD is being checked right now. Try again in a minute.",
            )));
        }
    };
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM edi_remote_reports WHERE tenant_id=$1 AND route_key=$2 AND format='claimmd_status'").bind(a.tenant_id).bind(&key).fetch_one(&mut *tx).await?;
    for item in &page.items {
        insert_observation(&mut tx, a, &key, item).await?;
    }
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM edi_remote_reports WHERE tenant_id=$1 AND route_key=$2 AND format='claimmd_status'").bind(a.tenant_id).bind(&key).fetch_one(&mut *tx).await?;
    attach_claimmd_status(&mut tx, a, &key).await?;
    reapply_claimmd_status(&mut tx, a, &key).await?;
    crate::postgres::audit(&mut tx, a, "claim.claimmd_status_check", id).await?;
    tx.commit().await?;
    Ok(json!({"checked":true,"new_messages":after-before}))
}
async fn connections(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(c)-'tenant_id'-'binding_hash'-'page_token'-'lease_id' || jsonb_build_object('cursor_saved',page_token IS NOT NULL) FROM edi_connections c WHERE tenant_id=$1 ORDER BY route_key LIMIT 100").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.connections_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
async fn connection_detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let item:Value=sqlx::query_scalar("SELECT to_jsonb(c)-'tenant_id'-'binding_hash'-'page_token'-'lease_id' FROM edi_connections c WHERE tenant_id=$1 AND route_key=$2").bind(a.tenant_id).bind(&key).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id' FROM edi_connection_events e WHERE tenant_id=$1 AND route_key=$2 ORDER BY version DESC LIMIT 100").bind(a.tenant_id).bind(&key).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.connection_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"connection":item,"events":events})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    action: String,
    reason: String,
    submission_id: Option<Uuid>,
    submission_version: Option<i64>,
    claim_version: Option<i64>,
}
async fn connection_action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(key): Path<String>,
    h: HeaderMap,
    Json(v): Json<Decision>,
) -> Result<Json<Value>> {
    if !matches!(a.role, crate::auth::Role::Owner) {
        return Err(Error::Forbidden);
    }
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    if !["pause", "resume", "poll_now"].contains(&v.action.as_str()) {
        return Err(Error::Invalid("unsupported connection action"));
    }
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let current: i64 = sqlx::query_scalar(
        "SELECT version FROM edi_connections WHERE tenant_id=$1 AND route_key=$2",
    )
    .bind(a.tenant_id)
    .bind(&key)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    if current != version {
        return Err(Error::Conflict("connection changed; reload"));
    }
    let historical:bool=sqlx::query_scalar("SELECT adapter='historical_import' FROM edi_connections WHERE tenant_id=$1 AND route_key=$2").bind(a.tenant_id).bind(&key).fetch_one(&mut *tx).await?;
    if historical {
        return Err(Error::Conflict(
            "historical evidence cannot activate transport; provision a new enrolled route",
        ));
    }
    sqlx::query("UPDATE edi_connections SET paused=CASE WHEN $3='pause' THEN true WHEN $3='resume' THEN false ELSE paused END,next_poll_at=now(),version=version+1 WHERE tenant_id=$1 AND route_key=$2").bind(a.tenant_id).bind(&key).bind(&v.action).execute(&mut *tx).await?;
    connection_event(&mut tx, &a, &key, &v.reason, json!({"action":v.action})).await?;
    tx.commit().await?;
    Ok(Json(json!({"key":key,"version":version+1})))
}
async fn reports(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id'-'original_text'-'metadata'-'parse_summary'-'lease_id' FROM edi_remote_reports r WHERE tenant_id=$1 ORDER BY received_at DESC,id LIMIT 100").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.remote_reports_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"limit":100})))
}
async fn report_detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let item:Value=sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id'-'lease_id' FROM edi_remote_reports r WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id' FROM edi_remote_report_events e WHERE tenant_id=$1 AND report_id=$2 ORDER BY version DESC LIMIT 100").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.remote_report_read", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"report":item,"events":events})))
}
async fn report_action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Decision>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    if v.action == "link_status_evidence" {
        return link_status(a, s, id, version, v).await;
    }
    if v.action != "retry_download" {
        return Err(Error::Invalid("unsupported report action"));
    }
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let count=sqlx::query("UPDATE edi_remote_reports SET status='pending',next_attempt_at=now(),attempts=0,version=version+1 WHERE tenant_id=$1 AND id=$2 AND version=$3 AND status='quarantined' AND original_text IS NULL").bind(a.tenant_id).bind(id).bind(version).execute(&mut *tx).await?.rows_affected();
    if count == 0 {
        return Err(Error::Conflict(
            "reload; only failed downloads without original evidence can retry",
        ));
    }
    report_event(&mut tx, &a, id, &v.reason, json!({"action":v.action})).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id,"version":version+1})))
}

async fn link_status(
    a: Actor,
    s: State,
    id: Uuid,
    version: i64,
    v: Decision,
) -> Result<Json<Value>> {
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let row:Option<(String,i64)>=sqlx::query_as("SELECT original_text,version FROM edi_remote_reports WHERE tenant_id=$1 AND id=$2 AND format='claimmd_status' AND status='retrieved' AND native_id IS NULL").bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
    let Some((raw, current)) = row else {
        return Err(Error::Conflict(
            "select an unlinked retrieved Claim.MD response",
        ));
    };
    if current != version {
        return Err(Error::Conflict("report changed; reload"));
    }
    let out = crate::clearinghouse::submission(
        &mut tx,
        &a,
        v.submission_id
            .ok_or(Error::Invalid("submission required"))?,
    )
    .await?;
    let c = crate::claims::claim_row(&mut tx, &a, out.claim_id).await?;
    if out.status != "delivered"
        || Some(out.version) != v.submission_version
        || Some(c.version) != v.claim_version
    {
        return Err(Error::Conflict(
            "review the current delivered submission and claim versions",
        ));
    }
    verify(
        &mut tx,
        &a,
        id,
        "claimmd_status",
        &raw,
        Some(out.partner_id),
    )
    .await?;
    let evidence: Value = serde_json::from_str(&raw)
        .map_err(|_| Error::Invalid("invalid stored provider evidence"))?;
    let account = &c.snapshot["account"];
    let content: crate::claims::ClaimContent =
        serde_json::from_value(c.content.clone()).map_err(|_| Error::Invalid("invalid claim"))?;
    let control = evidence["pcn"].as_str().unwrap_or("");
    let amount = format!(
        "{}.{:02}",
        account["total_cents"].as_i64().unwrap_or(0) / 100,
        account["total_cents"].as_i64().unwrap_or(0) % 100
    );
    if (control != c.control_number
        && (content.external_control_number.is_empty()
            || control != content.external_control_number))
        || evidence["bill_npi"] != content.billing_npi
        || evidence["bill_taxid"] != content.tax_id
        || evidence["ins_number"]
            != account["coverage_snapshot"]["coverage"]["content"]["member_id"]
        || evidence["payerid"] != account["coverage_snapshot"]["payer"]["content"]["payer_code"]
        || evidence["total_charge"] != amount
        || evidence["fdos"] != account["content"]["service_date"]
    {
        return Err(Error::Conflict(
            "provider control, billing identity, member, payer, amount or service date mismatch",
        ));
    }
    link(&mut tx, &a, id, "submission", out.id, &v.reason).await?;
    let applied = apply_claimmd_status(&mut tx, &a, id, out.id, &evidence).await?;
    sqlx::query("UPDATE edi_submissions SET version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(out.id)
        .execute(&mut *tx)
        .await?;
    crate::clearinghouse::event(&mut tx,&a,out.id,&v.reason,json!({"retrieved_report_id":id,"provider":"claim_md","clinical_status_changed":applied!="none","claim_status":applied,"status_evidence":evidence})).await?;
    // An unlinked response can still carry a payer outcome; other links are evidence only.
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"native_id":out.id,"clinical_status_changed":applied!="none","claim_status":applied}),
    ))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Historical {
    request_id: Uuid,
    source_history_id: Uuid,
    partner_id: Uuid,
    reason: String,
}
async fn from_source(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(v): Json<Historical>,
) -> Result<Json<Value>> {
    if !matches!(a.role, crate::auth::Role::Owner) {
        return Err(Error::Forbidden);
    }
    text(&v.reason, 1000)?;
    let digest = crate::oauth::hash(
        &serde_json::to_string(&v).map_err(|_| Error::Invalid("invalid source mapping"))?,
    );
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let prior:Option<(Uuid,String)>=sqlx::query_as("SELECT report_id,creation_hash FROM edi_remote_source_links WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(v.request_id).fetch_optional(&mut *tx).await?;
    if let Some((id, hash)) = prior {
        if hash != digest {
            return Err(Error::Conflict("source mapping request changed"));
        }
        return Ok(Json(json!({"id":id})));
    }
    let source:Value=sqlx::query_scalar("SELECT source_data FROM historical_records WHERE tenant_id=$1 AND id=$2 AND kind='edi_acknowledgment' AND patient_id IS NULL").bind(a.tenant_id).bind(v.source_history_id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    crate::clearinghouse::partner(&mut tx, &a, v.partner_id).await?;
    let format = source["format"]
        .as_str()
        .ok_or(Error::Invalid("source format missing"))?;
    if !["claimmd_status", "x12_277ca", "x12_999", "x12_ta1"].contains(&format) {
        return Err(Error::Invalid("unsupported source report format"));
    }
    let raw = source["original_text"]
        .as_str()
        .filter(|s| {
            (format == "claimmd_status" || s.is_ascii()) && !s.is_empty() && s.len() <= 48000
        })
        .ok_or(Error::Invalid("bounded original source text required"))?;
    if format == "claimmd_status" {
        if source["provider"] != "claim_md" {
            return Err(Error::Invalid(
                "Claim.MD provider identity must be declared",
            ));
        }
        let v: Value = serde_json::from_str(raw)
            .map_err(|_| Error::Invalid("invalid Claim.MD source JSON"))?;
        if crate::migration::contains_credentials(&v) {
            return Err(Error::Invalid(
                "credentials must be excluded from provider source JSON",
            ));
        }
    }
    let key = format!("historical-{}", v.source_history_id);
    sqlx::query("INSERT INTO edi_connections (tenant_id,route_key,partner_id,usage,adapter,binding_hash,start_at,paused,last_result) VALUES ($1,$2,$3,'T','historical_import','historical_only',now(),true,'historical_evidence_no_transport')").bind(a.tenant_id).bind(&key).bind(v.partner_id).execute(&mut *tx).await?;
    connection_event(
        &mut tx,
        &a,
        &key,
        &v.reason,
        json!({"historical_only":true,"transport_activated":false}),
    )
    .await?;
    let remote = format!("source:{}", v.source_history_id);
    insert_observation(&mut tx,&a,&key,&Observation{remote_id:remote.clone(),format:format.into(),metadata:json!({"source":"legacy_migration","source_history_id":v.source_history_id,"provider":source["provider"],"provider_report_id":source["provider_report_id"],"declared_origin":source["declared_origin"]}),status:"retrieved".into(),inline:Some(raw.into())}).await?;
    let id: Uuid = sqlx::query_scalar(
        "SELECT id FROM edi_remote_reports WHERE tenant_id=$1 AND route_key=$2 AND remote_id=$3",
    )
    .bind(a.tenant_id)
    .bind(&key)
    .bind(&remote)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO edi_remote_source_links (tenant_id,source_history_id,report_id,request_id,creation_hash,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)").bind(a.tenant_id).bind(v.source_history_id).bind(id).bind(v.request_id).bind(digest).bind(a.sub).bind(&v.reason).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.provider_source_map", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id,"transport_activated":false})))
}

#[cfg(test)]
mod claimmd_tracking_tests {
    use super::*;
    #[test]
    fn claimmd_poll_delay_backs_off_until_a_successful_page() {
        assert_eq!(claimmd_poll_delay(60, 0, false, None), (120, 1));
        assert_eq!(claimmd_poll_delay(60, 1, false, None), (240, 2));
        assert_eq!(claimmd_poll_delay(60, 6, false, None), (1800, 6));
        assert_eq!(claimmd_poll_delay(3600, 6, false, None), (3600, 6));
        assert_eq!(claimmd_poll_delay(60, 2, false, Some(2400)), (2400, 2));
        assert_eq!(claimmd_poll_delay(60, 2, true, None), (60, 0));
    }
    #[test]
    fn exact_status_link_requires_all_frozen_nonempty_identities() {
        let frozen = json!({"control_number":"SYN-CONTROL","content":{"billing_npi":"1234567893","tax_id":"000000001","external_control_number":""},"snapshot":{"account":{"total_cents":12550,"content":{"service_date":"2026-10-01"},"coverage_snapshot":{"coverage":{"content":{"member_id":"SYN-MEMBER"}},"payer":{"content":{"payer_code":"SYN-PAYER"}}}}}});
        let evidence = json!({"pcn":"SYN-CONTROL","bill_npi":"1234567893","bill_taxid":"000000001","ins_number":"SYN-MEMBER","payerid":"SYN-PAYER","total_charge":"125.50","fdos":"2026-10-01","status":"A"});
        assert!(claimmd_identity_matches(&evidence, &frozen));
        for field in [
            "pcn",
            "bill_npi",
            "bill_taxid",
            "ins_number",
            "payerid",
            "total_charge",
            "fdos",
        ] {
            for value in [json!("other"), json!(""), Value::Null, json!(123)] {
                let mut mismatch = evidence.clone();
                mismatch[field] = value;
                assert!(!claimmd_identity_matches(&mismatch, &frozen), "{field}");
            }
        }
        assert!(!claimmd_identity_matches(&json!({}), &json!({})));
        let mut spaced = frozen.clone();
        spaced["snapshot"]["account"]["coverage_snapshot"]["coverage"]["content"]["member_id"] =
            json!(" SYN-MEMBER ");
        assert!(claimmd_identity_matches(&evidence, &spaced));
        let mut echoed = evidence.clone();
        echoed["ins_number"] = json!("SYN-MEMBER  ");
        assert!(claimmd_identity_matches(&echoed, &spaced));
        spaced["snapshot"]["account"]["coverage_snapshot"]["coverage"]["content"]["member_id"] =
            json!("   ");
        echoed["ins_number"] = json!("  ");
        assert!(!claimmd_identity_matches(&echoed, &spaced));
    }
}
