// SPDX-License-Identifier: AGPL-3.0-only
//! 277CA hierarchy, claim/service status evidence and explicitly versioned reconciliation.
use crate::{
    auth::Actor,
    billing, claims, clearinghouse,
    error::{Error, Result},
    model::text,
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize)]
pub struct Status {
    pub category: String,
    pub code: String,
    pub entity: String,
    pub date: Option<NaiveDate>,
    pub action: String,
    pub amount_cents: Option<i64>,
    pub message: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Service {
    pub code: String,
    pub amount_cents: Option<i64>,
    pub line_control: String,
    pub statuses: Vec<Status>,
    pub dates: Vec<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ClaimRow {
    pub transaction: String,
    pub control: String,
    pub payer_id: String,
    pub receiver_id: String,
    pub provider_npi: String,
    pub patient_name: String,
    pub member_id: String,
    pub payer_control: String,
    pub intermediary_control: String,
    pub statuses: Vec<Status>,
    pub ancestor_statuses: Vec<Status>,
    pub services: Vec<Service>,
    pub references: Vec<Value>,
    pub dates: Vec<Value>,
    pub outcome: String,
    pub issues: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Document {
    pub claims: Vec<ClaimRow>,
    pub issues: Vec<String>,
    pub transactions: usize,
}
#[derive(Clone, Default)]
struct Context {
    kind: String,
    payer: String,
    receiver: String,
    provider: String,
    patient: String,
    member: String,
    statuses: Vec<Status>,
}
fn money(s: &str) -> Result<Option<i64>> {
    if s.is_empty() {
        return Ok(None);
    }
    let mut p = s.split('.');
    let w = p.next().unwrap_or("");
    let f = p.next().unwrap_or("");
    if w.is_empty()
        || !w.bytes().all(|b| b.is_ascii_digit())
        || f.len() > 2
        || !f.bytes().all(|b| b.is_ascii_digit())
        || p.next().is_some()
    {
        return Err(Error::Invalid(
            "277CA amounts require nonnegative exact decimal cents",
        ));
    }
    let cents = w
        .parse::<i64>()
        .ok()
        .and_then(|n| n.checked_mul(100))
        .and_then(|n| {
            f.parse::<i64>()
                .ok()
                .or(Some(0))
                .and_then(|v| n.checked_add(if f.len() == 1 { v * 10 } else { v }))
        })
        .filter(|v| *v <= 1000000000)
        .ok_or(Error::Invalid("277CA amount exceeds supported range"))?;
    Ok(Some(cents))
}
fn status(s: &[&str], component: char) -> Result<Vec<Status>> {
    let v = |i| s.get(i).copied().unwrap_or("");
    let date = if v(2).is_empty() {
        None
    } else {
        Some(
            NaiveDate::parse_from_str(v(2), "%Y%m%d")
                .map_err(|_| Error::Invalid("invalid 277CA status date"))?,
        )
    };
    let mut out = vec![];
    for i in [1, 10, 11] {
        if v(i).is_empty() {
            continue;
        }
        let c: Vec<_> = v(i).split(component).collect();
        if c.len() < 2
            || c.len() > 3
            || c[0].is_empty()
            || c[1].is_empty()
            || c[0].len() > 5
            || c[1].len() > 30
        {
            return Err(Error::Invalid("invalid 277CA status composite"));
        }
        out.push(Status {
            category: c[0].into(),
            code: c[1].into(),
            entity: c.get(2).copied().unwrap_or("").into(),
            date,
            action: v(3).into(),
            amount_cents: money(v(4))?,
            message: v(12).chars().take(1000).collect(),
        });
    }
    if out.is_empty() {
        return Err(Error::Invalid("277CA status composite missing"));
    }
    Ok(out)
}
fn rejection(s: &Status) -> bool {
    ["A3", "A6", "A7", "A8"].contains(&s.category.as_str())
}
pub fn parse(raw: &str) -> Result<Document> {
    if raw.is_empty() || raw.len() > 48000 || !raw.is_ascii() {
        return Err(Error::Invalid("277CA requires ASCII up to 48000 bytes"));
    }
    let raw = raw.trim();
    let wrapped = raw.starts_with("ISA");
    let (e, t, c) = if wrapped {
        if raw.len() < 106 {
            return Err(Error::Invalid("incomplete 277CA interchange"));
        }
        (
            raw.as_bytes()[3] as char,
            raw.as_bytes()[105] as char,
            raw.as_bytes()[104] as char,
        )
    } else {
        ('*', '~', ':')
    };
    if e == t
        || e == c
        || t == c
        || [e, t, c]
            .iter()
            .any(|d| d.is_ascii_alphanumeric() || d.is_ascii_control() || d.is_ascii_whitespace())
    {
        return Err(Error::Invalid("invalid 277CA delimiters"));
    }
    let rows: Vec<Vec<&str>> = raw
        .split(t)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.split(e).collect())
        .collect();
    if rows.len() > 1500 {
        return Err(Error::Invalid("277CA segment limit exceeded"));
    }
    let mut doc = Document {
        claims: vec![],
        issues: vec![],
        transactions: 0,
    };
    let mut hl: HashMap<String, Context> = HashMap::new();
    let mut current = Context::default();
    let mut claim: Option<usize> = None;
    let mut service: Option<usize> = None;
    let mut st: Option<(usize, String)> = None;
    let mut last_se = 0;
    let mut groups = 0;
    let mut completed = 0;
    let mut bht = false;
    let mut controls = HashSet::new();
    let mut tx_controls = HashSet::new();
    for (i, s) in rows.iter().enumerate() {
        let v = |n| s.get(n).copied().unwrap_or("");
        match v(0) {
            "ISA" => {
                if !wrapped || i != 0 || s.len() != 17 {
                    return Err(Error::Invalid("invalid 277CA ISA"));
                }
            }
            "GS" => {
                groups += 1;
                if !wrapped || i != 1 || v(1) != "HN" || v(8) != "005010X214" {
                    return Err(Error::Invalid("277CA requires one HN/005010X214 group"));
                }
            }
            "GE" => {
                if st.is_some()
                    || v(1).parse::<usize>().ok() != Some(completed)
                    || rows.get(1).and_then(|r| r.get(6)).copied() != Some(v(2))
                {
                    return Err(Error::Invalid("277CA GE controls/counts mismatch"));
                }
            }
            "IEA" => {
                if !wrapped
                    || i != rows.len() - 1
                    || v(1) != "1"
                    || rows[0].get(13).copied() != Some(v(2))
                {
                    return Err(Error::Invalid("277CA IEA controls/count mismatch"));
                }
            }
            "ST" => {
                if st.is_some()
                    || v(2).is_empty()
                    || v(1) != "277"
                    || v(3) != "005010X214"
                    || !tx_controls.insert(v(2).to_string())
                    || doc.transactions >= 20
                {
                    return Err(Error::Invalid(
                        "277CA requires bounded unique 005010X214 transaction sets",
                    ));
                }
                doc.transactions += 1;
                st = Some((i, v(2).into()));
                hl.clear();
                current = Context::default();
                claim = None;
                service = None;
                bht = false;
            }
            "SE" => {
                let (start, control) = st.take().ok_or(Error::Invalid("277CA SE without ST"))?;
                if control != v(2) || v(1).parse::<usize>().ok() != Some(i - start + 1) || !bht {
                    return Err(Error::Invalid("277CA ST/SE count or BHT mismatch"));
                }
                completed += 1;
                last_se = i;
            }
            _ if st.is_none() => return Err(Error::Invalid("277CA data outside transaction set")),
            "BHT" => {
                if bht || v(1) != "0085" {
                    return Err(Error::Invalid("277CA requires one 0085 BHT"));
                }
                bht = true;
            }
            "HL" => {
                if v(1).is_empty() || hl.contains_key(v(1)) {
                    return Err(Error::Invalid("duplicate/missing 277CA HL identifier"));
                }
                let mut next = if v(2).is_empty() {
                    if v(3) != "20" {
                        return Err(Error::Invalid("277CA root must be information source"));
                    }
                    Context::default()
                } else {
                    hl.get(v(2))
                        .cloned()
                        .ok_or(Error::Invalid("277CA parent hierarchy missing"))?
                };
                let valid = match v(3) {
                    "20" => v(2).is_empty(),
                    "21" => next.kind == "20",
                    "19" => next.kind == "21",
                    "PT" => next.kind == "19",
                    _ => false,
                };
                if !valid {
                    return Err(Error::Invalid("unsupported 277CA hierarchy relationship"));
                }
                next.kind = v(3).into();
                hl.insert(v(1).into(), next.clone());
                current = next;
                claim = None;
                service = None;
            }
            "NM1" => {
                let supported_qualifier = match (current.kind.as_str(), v(1)) {
                    ("20", "PR") => ["PI", "XV"].contains(&v(8)),
                    ("20", "AY") => v(8) == "46",
                    ("21", "41") => v(8) == "46",
                    ("19", "85") => v(8) == "XX",
                    ("PT", "QC") => v(8) == "MI",
                    _ => false,
                };
                if !supported_qualifier {
                    doc.issues
                        .push("Unsupported NM1 identity qualifier requires review".into());
                }
                match (current.kind.as_str(), v(1)) {
                    ("20", "PR" | "AY") => current.payer = v(9).into(),
                    ("21", "41") => current.receiver = v(9).into(),
                    ("19", "85") => current.provider = v(9).into(),
                    ("PT", "QC") => {
                        current.patient = format!("{}, {}", v(3), v(4));
                        current.member = v(9).into();
                    }
                    _ => doc
                        .issues
                        .push("Unexpected NM1 role in 277CA hierarchy".into()),
                }
                if let Some(last) = rows[..i]
                    .iter()
                    .rfind(|r| r[0] == "HL")
                    .and_then(|r| r.get(1))
                {
                    hl.insert((*last).into(), current.clone());
                }
            }
            "TRN" => {
                if current.kind == "PT" {
                    if v(1) != "2" || v(2).is_empty() || v(2).len() > 100 || doc.claims.len() >= 100
                    {
                        return Err(Error::Invalid("277CA claim requires bounded TRN2 control"));
                    }
                    let key = (
                        st.as_ref().unwrap().1.clone(),
                        current.provider.clone(),
                        v(2).to_string(),
                    );
                    if !controls.insert(key) {
                        doc.issues.push(
                            "Duplicate patient-control evidence in a transaction requires review"
                                .into(),
                        );
                    }
                    doc.claims.push(ClaimRow {
                        transaction: st.as_ref().unwrap().1.clone(),
                        control: v(2).into(),
                        payer_id: current.payer.clone(),
                        receiver_id: current.receiver.clone(),
                        provider_npi: current.provider.clone(),
                        patient_name: current.patient.clone(),
                        member_id: current.member.clone(),
                        payer_control: String::new(),
                        intermediary_control: String::new(),
                        statuses: vec![],
                        ancestor_statuses: current.statuses.clone(),
                        services: vec![],
                        references: vec![],
                        dates: vec![],
                        outcome: String::new(),
                        issues: vec![],
                    });
                    claim = Some(doc.claims.len() - 1);
                    service = None;
                }
            }
            "STC" => {
                let statuses = status(s, c)?;
                if let Some(ci) = claim {
                    if let Some(si) = service {
                        doc.claims[ci].services[si].statuses.extend(statuses);
                    } else {
                        doc.claims[ci].statuses.extend(statuses);
                    }
                } else {
                    current.statuses.extend(statuses);
                    if let Some(last) = rows[..i]
                        .iter()
                        .rfind(|r| r[0] == "HL")
                        .and_then(|r| r.get(1))
                    {
                        hl.insert((*last).into(), current.clone());
                    }
                }
            }
            "SVC" => {
                let ci = claim.ok_or(Error::Invalid("277CA service without claim"))?;
                if doc.claims[ci].services.len() >= 100 {
                    return Err(Error::Invalid("277CA service limit exceeded"));
                }
                doc.claims[ci].services.push(Service {
                    code: v(1).replace(c, ":"),
                    amount_cents: money(v(2))?,
                    line_control: String::new(),
                    statuses: vec![],
                    dates: vec![],
                });
                service = Some(doc.claims[ci].services.len() - 1);
            }
            "REF" => {
                if let Some(ci) = claim {
                    let row = &mut doc.claims[ci];
                    row.references
                        .push(json!({"qualifier":v(1),"value":v(2),"service_index":service}));
                    if let Some(si) = service {
                        if ["FJ", "6R"].contains(&v(1)) {
                            row.services[si].line_control = v(2).into();
                        }
                    } else {
                        match v(1) {
                            "1K" => {
                                if !row.payer_control.is_empty() && row.payer_control != v(2) {
                                    row.issues.push("Conflicting payer claim controls".into());
                                }
                                row.payer_control = v(2).into();
                            }
                            "D9" => row.intermediary_control = v(2).into(),
                            _ => {}
                        }
                    }
                }
            }
            "DTP" => {
                if let Some(ci) = claim {
                    let evidence = json!({"qualifier":v(1),"format":v(2),"value":v(3)});
                    if let Some(si) = service {
                        doc.claims[ci].services[si].dates.push(evidence);
                    } else {
                        doc.claims[ci].dates.push(evidence);
                    }
                }
            }
            "QTY" | "AMT" => {}
            _ => doc.issues.push(format!(
                "Unsupported 277CA segment {} retained in original text",
                v(0)
            )),
        }
    }
    if st.is_some()
        || doc.transactions == 0
        || completed != doc.transactions
        || doc.claims.is_empty()
    {
        return Err(Error::Invalid(
            "incomplete 277CA transaction/claim evidence",
        ));
    }
    if wrapped {
        if groups != 1
            || rows
                .get(rows.len().saturating_sub(2))
                .and_then(|r| r.first())
                .copied()
                != Some("GE")
            || last_se != rows.len() - 3
        {
            return Err(Error::Invalid("incomplete 277CA envelope"));
        }
    } else if last_se != rows.len() - 1 {
        return Err(Error::Invalid("277CA trailing transaction data"));
    }
    for row in &mut doc.claims {
        let mut service_controls = HashSet::new();
        if row.services.iter().any(|s| {
            !s.code.starts_with("HC:")
                || s.line_control.is_empty()
                || !service_controls.insert(s.line_control.clone())
        }) {
            row.issues.push(
                "Unsupported service coding or missing/duplicate line control requires review"
                    .into(),
            );
        }
        let reject = row.statuses.iter().any(rejection);
        let accept = row.statuses.iter().any(|s| s.category == "A2");
        if row.statuses.is_empty() {
            row.issues.push(
                "No claim-level status; service detail alone cannot decide the whole claim".into(),
            );
        }
        if reject && accept {
            row.issues
                .push("Conflicting claim acceptance/rejection categories".into());
        }
        if row
            .ancestor_statuses
            .iter()
            .any(|s| rejection(s) || !["A0", "A1", "A2"].contains(&s.category.as_str()))
        {
            row.issues
                .push("Source/receiver/provider-level status requires reconciliation".into());
        }
        for s in &row.statuses {
            if !["A0", "A1", "A2", "A3", "A6", "A7", "A8"].contains(&s.category.as_str())
                || s.date.is_none_or(|d| d > Utc::now().date_naive())
                || (rejection(s) && s.action != "U")
                || (s.category == "A2" && s.action != "WQ")
            {
                row.issues
                    .push("Unsupported category, action or event date requires review".into());
            }
        }
        if row.services.iter().flat_map(|s| &s.statuses).any(|s| {
            !["A0", "A1", "A2", "A3", "A6", "A7", "A8"].contains(&s.category.as_str())
                || s.date.is_some_and(|d| d > Utc::now().date_naive())
                || (rejection(s) && s.action != "U")
                || (s.category == "A2" && s.action != "WQ")
        }) {
            row.issues
                .push("Unsupported service status requires review".into());
        }
        if accept
            && row
                .services
                .iter()
                .any(|s| s.statuses.iter().any(rejection))
        {
            row.issues
                .push("Service rejection conflicts with accepted claim-level status".into());
        }
        row.outcome = if !row.issues.is_empty() {
            "needs_review"
        } else if reject {
            "rejected"
        } else if accept {
            "accepted"
        } else {
            "received"
        }
        .into();
    }
    if doc.issues.len() > 100 {
        return Err(Error::Invalid("277CA exceeds supported review-issue limit"));
    }
    Ok(doc)
}
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Import {
    request_id: Uuid,
    original_text: String,
    origin: String,
    source_history_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_report_id: Option<Uuid>,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Review {
    submission_id: Uuid,
    submission_version: i64,
    claim_version: i64,
    reason: String,
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/billing/277ca", get(list).post(import))
        .route("/api/v1/billing/277ca/{id}", get(detail))
        .route("/api/v1/billing/277ca/{id}/rows/{row}/apply", post(apply))
}
async fn import(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(v): Json<Import>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    text(&v.reason, 1000)?;
    if !["clearinghouse", "payer"].contains(&v.origin.as_str()) {
        return Err(Error::Invalid("declare clearinghouse or payer origin"));
    }
    let parsed = parse(&v.original_text)?;
    let hash = crate::oauth::hash(&v.original_text);
    let creation = crate::oauth::hash(
        &serde_json::to_string(&v).map_err(|_| Error::Invalid("invalid 277CA request"))?,
    );
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let prior: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,creation_hash FROM edi_277ca_documents WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((id, h)) = prior {
        if h != creation {
            return Err(Error::Conflict(
                "277CA request ID reused with changed evidence",
            ));
        }
        return Ok(Json(json!({"id":id,"parsed":parsed,"origin":v.origin})));
    }
    if let Some(source) = v.source_history_id {
        let yes:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM historical_records WHERE tenant_id=$1 AND id=$2 AND kind='edi_acknowledgment' AND patient_id IS NULL AND source_data->>'format'='x12_277ca' AND source_data->>'original_text'=$3 AND (source_data->>'declared_origin' IS NULL OR source_data->>'declared_origin'=$4))").bind(a.tenant_id).bind(source).bind(&v.original_text).bind(&v.origin).fetch_one(&mut *tx).await?;
        if !yes {
            return Err(Error::Conflict(
                "277CA source must match original immutable source text exactly",
            ));
        }
    }
    if let Some(report) = v.remote_report_id {
        crate::retrieval::verify(&mut tx, &a, report, "x12_277ca", &v.original_text, None).await?;
        let declared:Option<String>=sqlx::query_scalar("SELECT metadata->>'declared_origin' FROM edi_remote_reports WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(report).fetch_one(&mut *tx).await?;
        if declared.as_ref().is_some_and(|s| s != &v.origin) {
            return Err(Error::Conflict(
                "initial provider acknowledgment cannot become payer-origin evidence",
            ));
        }
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO edi_277ca_documents (tenant_id,id,original_text,original_hash,parsed,origin,source_history_id,request_id,creation_hash,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(a.tenant_id).bind(id).bind(v.original_text).bind(hash).bind(json!(parsed)).bind(&v.origin).bind(v.source_history_id).bind(v.request_id).bind(creation).bind(a.sub).bind(&v.reason).execute(&mut *tx).await?;
    if let Some(report) = v.remote_report_id {
        crate::retrieval::link(&mut tx, &a, report, "277ca", id, &v.reason).await?;
    }
    crate::postgres::audit(&mut tx, &a, "edi.277ca_import", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id,"parsed":parsed,"origin":v.origin})))
}
async fn list(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'origin',origin,'claim_count',jsonb_array_length(parsed->'claims'),'issue_count',jsonb_array_length(parsed->'issues'),'source_history_id',source_history_id,'created_at',created_at) FROM edi_277ca_documents WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 100").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.277ca_list", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"limit":100})))
}
async fn detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let doc:Value=sqlx::query_scalar("SELECT to_jsonb(d)-'tenant_id'-'creation_hash'-'request_id' FROM edi_277ca_documents d WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let reviews:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id' FROM edi_277ca_reviews r WHERE tenant_id=$1 AND document_id=$2 ORDER BY row_index,version DESC").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.277ca_read", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"document":doc,"reviews":reviews})))
}
async fn apply(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((id, row)): Path<(Uuid, usize)>,
    h: HeaderMap,
    Json(v): Json<Review>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let (raw, origin): (Value, String) = sqlx::query_as(
        "SELECT parsed,origin FROM edi_277ca_documents WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    let doc: Document =
        serde_json::from_value(raw).map_err(|_| Error::Invalid("invalid stored 277CA"))?;
    let r = doc
        .claims
        .get(row)
        .ok_or(Error::Invalid("277CA row index out of range"))?;
    if !doc.issues.is_empty() || !r.issues.is_empty() || r.outcome == "needs_review" {
        return Err(Error::Conflict(
            "resolve unsupported or conflicting 277CA evidence before applying",
        ));
    }
    let prior:i64=sqlx::query_scalar("SELECT count(*) FROM edi_277ca_reviews WHERE tenant_id=$1 AND document_id=$2 AND row_index=$3").bind(a.tenant_id).bind(id).bind(row as i32).fetch_one(&mut *tx).await?;
    if prior != 0 || version != 1 {
        return Err(Error::Conflict(
            "277CA row was already applied; original decision is immutable",
        ));
    }
    let out = clearinghouse::submission(&mut tx, &a, v.submission_id).await?;
    let c = claims::claim_row(&mut tx, &a, out.claim_id).await?;
    if out.status != "delivered"
        || out.version != v.submission_version
        || c.version != v.claim_version
        || c.status != "submitted"
        || out.delivered_claim_version != Some(c.version)
        || out.payer_outcome != "pending"
        || ["rejected", "needs_review"].contains(&out.technical_status.as_str())
    {
        return Err(Error::Conflict(
            "277CA requires the unchanged externally delivered, submitted native claim",
        ));
    }
    let wrong_partner:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edi_remote_reports r JOIN edi_connections c ON c.tenant_id=r.tenant_id AND c.route_key=r.route_key WHERE r.tenant_id=$1 AND r.native_id=$2 AND r.native_kind='277ca' AND c.partner_id<>$3)").bind(a.tenant_id).bind(id).bind(out.partner_id).fetch_one(&mut *tx).await?;
    if wrong_partner {
        return Err(Error::Conflict(
            "retrieved acknowledgment is bound to a different reviewed trading partner",
        ));
    }
    let claim_content: claims::ClaimContent = serde_json::from_value(c.content.clone())
        .map_err(|_| Error::Invalid("invalid frozen claim"))?;
    let b = &c.snapshot["account"];
    let cover = &b["coverage_snapshot"]["coverage"]["content"];
    let payer = &b["coverage_snapshot"]["payer"]["content"];
    if (r.control != c.control_number
        && (claim_content.external_control_number.is_empty()
            || r.control != claim_content.external_control_number))
        || r.provider_npi != claim_content.billing_npi
        || r.member_id != cover["member_id"].as_str().unwrap_or("")
        || r.receiver_id
            != out.partner_snapshot["content"]["submitter_id"]
                .as_str()
                .unwrap_or("")
    {
        return Err(Error::Conflict(
            "277CA control, billing NPI, subscriber/member or submitter identity mismatch",
        ));
    }
    if origin == "payer" && r.payer_id != payer["payer_code"].as_str().unwrap_or("") {
        return Err(Error::Conflict(
            "payer-origin 277CA issuer does not match frozen native payer",
        ));
    }
    if origin == "clearinghouse"
        && r.payer_id != payer["payer_code"].as_str().unwrap_or("")
        && r.payer_id
            != out.partner_snapshot["content"]["receiver_identifier"]
                .as_str()
                .unwrap_or("")
    {
        return Err(Error::Conflict(
            "clearinghouse 277CA issuer does not match frozen payer or receiver",
        ));
    }
    for date in r
        .dates
        .iter()
        .chain(r.services.iter().flat_map(|s| &s.dates))
    {
        if date["qualifier"] == "472" {
            let expected = b["content"]["service_date"]
                .as_str()
                .unwrap_or("")
                .replace('-', "");
            let matches = match date["format"].as_str() {
                Some("D8") => date["value"].as_str() == Some(expected.as_str()),
                Some("RD8") => {
                    date["value"].as_str() == Some(format!("{expected}-{expected}").as_str())
                }
                _ => false,
            };
            if !matches {
                return Err(Error::Conflict(
                    "277CA service date differs from frozen native service date",
                ));
            }
        }
    }
    for status in &r.statuses {
        if status
            .amount_cents
            .is_some_and(|n| Some(n) != b["total_cents"].as_i64())
        {
            return Err(Error::Conflict(
                "277CA claim amount differs from frozen charges",
            ));
        }
    }
    for svc in &r.services {
        let lines = b["content"]["lines"]
            .as_array()
            .ok_or(Error::Invalid("claim lines missing"))?;
        let index = svc
            .line_control
            .parse::<usize>()
            .ok()
            .filter(|i| *i > 0 && *i <= lines.len())
            .ok_or(Error::Conflict(
                "277CA service requires an exact generated line-control match",
            ))?;
        let line = &lines[index - 1];
        let code = svc.code.split(':').nth(1).unwrap_or("");
        if code != line["code"].as_str().unwrap_or("")
            || svc
                .amount_cents
                .is_some_and(|v| Some(v) != line["amount_cents"].as_i64())
        {
            return Err(Error::Conflict(
                "277CA service code/amount differs from native line",
            ));
        }
    }
    let outcome = r.outcome.as_str();
    if origin == "payer" && outcome == "accepted" {
        text(&r.payer_control, 150)?;
    }
    let mutating = outcome == "rejected" || origin == "payer" && outcome == "accepted";
    if mutating {
        sqlx::query("UPDATE ehr_claims SET status=$3,payer_control_number=CASE WHEN $4='' THEN payer_control_number ELSE $4 END,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(c.id).bind(if outcome=="rejected"{"rejected"}else{"accepted"}).bind(if origin=="payer"{r.payer_control.as_str()}else{""}).execute(&mut *tx).await?;
        claims::revision(&mut tx,&a,c.id,&v.reason,json!({"document_id":id,"row":row,"origin":origin,"outcome":outcome,"payer_control":r.payer_control})).await?;
    }
    sqlx::query("UPDATE edi_submissions SET payer_outcome=CASE WHEN $3='payer' AND $4 IN ('accepted','rejected') THEN $4 ELSE payer_outcome END,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(out.id).bind(&origin).bind(outcome).execute(&mut *tx).await?;
    clearinghouse::event(&mut tx,&a,out.id,&v.reason,json!({"document_id":id,"row":row,"origin":origin,"outcome":outcome,"claim_changed":mutating})).await?;
    sqlx::query("INSERT INTO edi_277ca_reviews (tenant_id,document_id,row_index,version,submission_id,claim_version,submission_version,actor_id,decision,reason,evidence) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10)").bind(a.tenant_id).bind(id).bind(row as i32).bind(out.id).bind(c.version).bind(out.version).bind(a.sub).bind(outcome).bind(&v.reason).bind(json!({"origin":origin,"row":r})).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.277ca_apply", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"document_id":id,"row":row,"outcome":outcome,"origin":origin,"claim_changed":mutating}),
    ))
}
