// SPDX-License-Identifier: AGPL-3.0-only
//! Claim.MD's published multipart upload and ResponseID status feed. Native JSON stays JSON.
use crate::{
    clearinghouse::Submission,
    delivery::Route,
    error::{Error, Result},
    retrieval::{Observation, Page},
    stedi,
};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::future::Future;
pub const UPLOAD: &str = "https://svc.claim.md/services/upload/";
fn retry_after_seconds(value: Option<&str>, now: chrono::DateTime<chrono::Utc>) -> u32 {
    value
        .and_then(|value| {
            value.trim().parse::<u32>().ok().or_else(|| {
                let date = chrono::DateTime::parse_from_rfc2822(value.trim()).ok()?;
                Some((date.timestamp() - now.timestamp()).clamp(1, i64::from(u32::MAX)) as u32)
            })
        })
        .unwrap_or(60)
        .max(1)
}
fn poll_http_status(response: &reqwest::Response, failure: &'static str) -> Result<()> {
    match response.status() {
        reqwest::StatusCode::OK => Ok(()),
        reqwest::StatusCode::TOO_MANY_REQUESTS => {
            Err(Error::ClaimMdRateLimited(retry_after_seconds(
                response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok()),
                chrono::Utc::now(),
            )))
        }
        _ => Err(Error::Invalid(failure)),
    }
}
pub(crate) enum ApiBudget {
    Background,
    Foreground,
}

pub(crate) async fn paced<T>(
    pool: &PgPool,
    route: &Route,
    budget: ApiBudget,
    request: impl Future<Output = Result<T>>,
) -> Result<T> {
    let hash = crate::oauth::hash(&token(route)?);
    crate::claimmd_eligibility::take_api_budget(pool, &hash, budget).await?;
    let result = request.await;
    if let Err(Error::ClaimMdRateLimited(seconds)) = &result {
        crate::claimmd_eligibility::pause_api_budget(pool, &hash, *seconds).await?;
    }
    result
}
pub(crate) fn validate(r: &Route) -> Result<()> {
    if !r.loopback_test && r.endpoint != UPLOAD {
        return Err(Error::Invalid(
            "Claim.MD must use the documented upload endpoint",
        ));
    }
    if r.sftp.is_some() {
        return Err(Error::Invalid(
            "Claim.MD API route cannot carry SFTP settings",
        ));
    }
    if let Some(s) = &r.retrieval {
        s.validate(r)?;
    }
    Ok(())
}
pub(crate) fn token(r: &Route) -> Result<String> {
    if let Some(v) = &r.credential_value {
        return Ok(v.expose().to_owned());
    }
    match &r.credential_env {
        Some(k) => std::env::var(k)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .ok_or(Error::Invalid("Claim.MD credential unavailable")),
        None if r.loopback_test => Ok("synthetic-loopback-key".into()),
        _ => Err(Error::Invalid("Claim.MD credential unavailable")),
    }
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    // A stray leading/trailing space saved on a frozen coverage or payer must not
    // block the send and must not reach Claim.MD, so the value is trimmed before
    // it is used.
    value[key]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or(Error::Invalid("Claim.MD professional claim field missing"))
}
fn money(cents: i64) -> Result<String> {
    if !(1..=100000000000).contains(&cents) {
        return Err(Error::Invalid("Claim.MD claim amount is invalid"));
    }
    Ok(format!("{}.{:02}", cents / 100, cents % 100))
}
fn address(
    target: &mut serde_json::Map<String, Value>,
    prefix: &str,
    value: &Value,
    optional_when_blank: bool,
) -> Result<()> {
    // Claim.MD marks the payer street, city, state and ZIP as not required. A
    // payer address with nothing recorded writes no fields at all. A partly
    // filled one is still an incomplete address. Every other party (bill, pat,
    // ins) stays strictly required.
    if optional_when_blank
        && [
            value["line1"].as_str(),
            value["line2"].as_str(),
            value["city"].as_str(),
            value["state"].as_str(),
            value["postal_code"].as_str(),
        ]
        .into_iter()
        .all(|part| part.unwrap_or_default().trim().is_empty())
    {
        return Ok(());
    }
    for (source, suffix) in [
        ("line1", "addr_1"),
        ("line2", "addr_2"),
        ("city", "city"),
        ("state", "state"),
        ("postal_code", "zip"),
    ] {
        if let Some(text) = value[source]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            target.insert(format!("{prefix}_{suffix}"), json!(text));
        } else if source != "line2" {
            return Err(Error::Invalid("Claim.MD claim address is incomplete"));
        }
    }
    Ok(())
}
fn professional_json(out: &Submission) -> Result<Value> {
    let claim = &out.claim_snapshot;
    if required(claim, "frequency")? != "original" {
        return Err(Error::Invalid(
            "Claim.MD native submission supports original claims only; replacement (7) and void (8) claims require a separately reviewed submission route",
        ));
    }
    let content = &claim["content"];
    let snapshot = &claim["snapshot"];
    let patient = &snapshot["patient"];
    let account = &snapshot["account"];
    let coverage = &account["coverage_snapshot"]["coverage"]["content"];
    let payer = &account["coverage_snapshot"]["payer"]["content"];
    let details = &out.details;
    let total = account["total_cents"]
        .as_i64()
        .ok_or(Error::Invalid("Claim.MD claim total missing"))?;
    let relationship = required(coverage, "relationship")?;
    let relationship_code = match relationship {
        "self" => "18",
        "spouse" => "01",
        "child" => "19",
        _ => return Err(Error::Invalid("Claim.MD patient relationship unsupported")),
    };
    let mut native = serde_json::Map::new();
    // A practice billing under a Social Security number is sent as one; every
    // other claim, including one frozen before the type was recorded, is an EIN.
    let bill_taxid_type = match content["tax_id_type"].as_str() {
        Some("S") => "S",
        _ => "E",
    };
    for (key, value) in [
        ("accept_assign", "Y"),
        ("auto_accident", "N"),
        ("employment_related", "N"),
        ("claim_form", "1500"),
        ("bill_name", required(content, "billing_provider_name")?),
        ("bill_npi", required(content, "billing_npi")?),
        ("bill_taxid", required(content, "tax_id")?),
        ("bill_taxid_type", bill_taxid_type),
        ("payerid", required(payer, "payer_code")?),
        ("pcn", required(claim, "control_number")?),
        ("remote_claimid", required(claim, "control_number")?),
        ("pat_name_f", required(patient, "given_name")?),
        ("pat_name_l", required(patient, "family_name")?),
        ("pat_dob", required(patient, "birth_date")?),
        ("pat_rel", relationship_code),
        ("ins_name_f", required(details, "subscriber_given_name")?),
        ("ins_name_l", required(details, "subscriber_family_name")?),
        ("ins_number", required(coverage, "member_id")?),
        ("prov_name_f", required(details, "rendering_given_name")?),
        ("prov_name_l", required(details, "rendering_family_name")?),
        ("prov_npi", required(content, "rendering_npi")?),
        ("prov_taxonomy", required(details, "billing_taxonomy")?),
    ] {
        native.insert(key.into(), json!(value));
    }
    // Claim.MD's professional field contract uses amount_paid for primary
    // patient payments. Gross service charges must not be reduced by the copay.
    // Older frozen claims without financial evidence do not assert a zero payment.
    if let Some(financial) = snapshot.get("financial_summary").filter(|v| !v.is_null()) {
        let paid = financial["patient_payments_cents"]
            .as_i64()
            .filter(|n| (0..=100000000000).contains(n))
            .ok_or(Error::Invalid(
                "Claim.MD patient payment evidence is invalid",
            ))?;
        native.insert(
            "amount_paid".into(),
            json!(format!("{}.{:02}", paid / 100, paid % 100)),
        );
    }
    native.insert("total_charge".into(), json!(money(total)?));
    native.insert("payer_order".into(), json!("Primary"));
    if let Some(date) = content["subscriber_birth_date"]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        native.insert("ins_dob".into(), json!(date));
    }
    if let Some(group) = coverage["group_number"]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        native.insert("ins_group".into(), json!(group));
    }
    for (source, target) in [("patient_sex", "pat_sex"), ("subscriber_sex", "ins_sex")] {
        if let Some(sex @ ("M" | "F" | "U")) = details[source].as_str() {
            native.insert(target.into(), json!(sex));
        }
    }
    address(&mut native, "bill", &details["billing_address"], false)?;
    address(&mut native, "pat", &details["patient_address"], false)?;
    address(&mut native, "ins", &details["subscriber_address"], false)?;
    address(&mut native, "payer", &details["payer_address"], true)?;
    if let Some(name) = payer["name"]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        native.insert("payer_name".into(), json!(name));
    }
    let diagnoses = content["diagnosis_codes"]
        .as_array()
        .ok_or(Error::Invalid("Claim.MD diagnoses missing"))?;
    for (index, diagnosis) in diagnoses.iter().enumerate() {
        if index >= 12 {
            return Err(Error::Invalid("Claim.MD diagnosis limit exceeded"));
        }
        native.insert(
            format!("diag_{}", index + 1),
            json!(diagnosis
                .as_str()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .ok_or(Error::Invalid("Claim.MD diagnosis is invalid"))?
                .replace('.', "")),
        );
    }
    let lines = account["content"]["lines"]
        .as_array()
        .ok_or(Error::Invalid("Claim.MD charges missing"))?;
    let pointers = content["line_diagnosis_pointers"]
        .as_array()
        .ok_or(Error::Invalid("Claim.MD diagnosis pointers missing"))?;
    let service_date = required(&account["content"], "service_date")?;
    // Claim details from the encounter form, each only when filled in, under the field names
    // Claim.MD documents for its professional claim form (docs.claim.md, Professional Claim Form
    // Overview). Box 19 has no claim-level field there; it travels in the 837P and on paper.
    let enc = &content["encounter"];
    let enc_text = |key: &str| enc[key].as_str().map(str::trim).filter(|v| !v.is_empty());
    for (source, target) in [
        ("prior_authorization_number", "prior_auth"),
        ("current_illness_date", "cond_date"),
        ("hospitalization_from", "hosp_from_date"),
        ("hospitalization_to", "hosp_thru_date"),
        ("referring_npi", "ref_npi"),
    ] {
        if let Some(value) = enc_text(source) {
            native.insert(target.into(), json!(value));
        }
    }
    if enc_text("referring_npi").is_some() {
        let (last, first) =
            crate::encounter_claim::name_parts(enc_text("referring_provider_name").unwrap_or(""));
        native.insert("ref_name_l".into(), json!(last));
        native.insert("ref_name_f".into(), json!(first));
    }
    if let Some(codes) = enc_text("claim_codes") {
        for (index, code) in codes
            .split([',', ' '])
            .filter(|v| !v.is_empty())
            .take(3)
            .enumerate()
        {
            native.insert(format!("cond_code_{}", index + 1), json!(code));
        }
    }
    let supervising = enc_text("supervising_npi").map(|npi| {
        let (last, first) =
            crate::encounter_claim::name_parts(enc_text("supervising_provider_name").unwrap_or(""));
        (last, first, npi.to_string())
    });
    let through_date = enc_text("through_date");
    let mut charges = Vec::with_capacity(lines.len());
    for (index, line) in lines.iter().enumerate() {
        let amount = line["amount_cents"]
            .as_i64()
            .ok_or(Error::Invalid("Claim.MD charge amount missing"))?;
        let refs = pointers
            .get(index)
            .and_then(Value::as_array)
            .ok_or(Error::Invalid("Claim.MD diagnosis pointers missing"))?;
        let mut diag_ref = String::new();
        for pointer in refs {
            let n = pointer
                .as_u64()
                .filter(|n| (1..=12).contains(n))
                .ok_or(Error::Invalid("Claim.MD diagnosis pointer invalid"))?;
            diag_ref.push((b'A' + (n as u8 - 1)) as char);
        }
        // A line's own dates, or the encounter's through date, make the service a range.
        let line_from = line["service_from"]
            .as_str()
            .filter(|v| !v.is_empty())
            .unwrap_or(service_date);
        let line_thru = line["service_to"]
            .as_str()
            .filter(|v| !v.is_empty())
            .or(through_date)
            .filter(|v| *v > line_from)
            .unwrap_or(line_from);
        let mut charge = json!({
            "charge":money(amount)?,
            "charge_record_type":"UN",
            "diag_ref":diag_ref,
            "from_date":line_from,
            "thru_date":line_thru,
            "place_of_service":required(content,"place_of_service")?,
            "proc_code":required(line,"code")?,
            "remote_chgid":format!("{}-{}", required(claim,"control_number")?, index+1),
            "units":line["units"].as_i64().ok_or(Error::Invalid("Claim.MD charge units missing"))?.to_string()
        });
        for (position, modifier) in line["modifiers"]
            .as_str()
            .unwrap_or("")
            .split([',', ' '])
            .filter(|v| !v.is_empty())
            .enumerate()
        {
            if position >= 4 {
                return Err(Error::Invalid("Claim.MD modifier limit exceeded"));
            }
            charge[format!("mod{}", position + 1)] = json!(modifier);
        }
        // A charge carrying an injected drug's NDC sends it in Claim.MD's
        // published drug fields. A line without an NDC writes none of them.
        let ndc = [
            line["ndc_code"].as_str().unwrap_or("").trim(),
            line["ndc_quantity"].as_str().unwrap_or("").trim(),
            line["ndc_unit"].as_str().unwrap_or("").trim(),
        ];
        if ndc.iter().any(|v| !v.is_empty()) {
            for v in ndc {
                if v.is_empty()
                    || v.len() > 13
                    || !v.bytes().all(|b| b == b'.' || b.is_ascii_alphanumeric())
                {
                    return Err(Error::Invalid("Claim.MD drug field is invalid"));
                }
            }
            charge["ndc_code"] = json!(ndc[0]);
            charge["ndc_dosage"] = json!(ndc[1]);
            charge["ndc_measure"] = json!(ndc[2]);
        }
        if let Some((last, first, npi)) = &supervising {
            charge["chg_supv_prov_name_l"] = json!(last);
            charge["chg_supv_prov_name_f"] = json!(first);
            charge["chg_supv_prov_npi"] = json!(npi);
        }
        charges.push(charge);
    }
    native.insert("charge".into(), Value::Array(charges));
    Ok(json!({"fileid":out.id.to_string(),"claim":[Value::Object(native)]}))
}

pub(crate) fn preflight(out: &Submission) -> Result<()> {
    professional_json(out).map(|_| ())
}

pub(crate) async fn upload(r: &Route, out: &Submission) -> Result<Option<String>> {
    let payload = serde_json::to_string(&professional_json(out)?)
        .map_err(|_| Error::Invalid("Claim.MD professional claim serialization failed"))?;
    let part = reqwest::multipart::Part::text(payload).file_name(format!("claim_{}.json", out.id));
    let form = reqwest::multipart::Form::new()
        .text("AccountKey", token(r)?)
        .part("File", part);
    let response = stedi::client()?
        .post(&r.endpoint)
        .header("Accept", "application/json")
        .multipart(form)
        .send()
        .await
        .map_err(|_| Error::Invalid("Claim.MD upload uncertain"))?;
    if response.status() != 200 {
        return Ok(None);
    }
    let v: Value = serde_json::from_slice(&stedi::bytes(response, 65536).await?)
        .map_err(|_| Error::Invalid("invalid Claim.MD upload response"))?;
    upload_receipt(&v, out)
}

fn file_receipt_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| {
        !value.is_empty()
            && value.len() <= 40
            && value.bytes().all(|c| c.is_ascii_digit())
            && value.bytes().any(|c| c != b'0')
    })
}

pub(crate) fn claim_receipt_id(value: &Value) -> Option<String> {
    id(value).filter(|value| value.parse::<u64>().is_ok_and(|value| value > 0))
}

/// `claimid` may echo the submitter's control. Only `claimmd_id` identifies the
/// provider claim when a processed/rejected upload has no assigned file ID.
pub(crate) fn receipt_references(evidence: &Value) -> Vec<String> {
    let mut references = Vec::new();
    if let Some(id) = file_receipt_id(&evidence["fileid"]) {
        references.push(format!("claimmd-file:{id}"));
    }
    if let Some(id) = claim_receipt_id(&evidence["claimmd_id"]) {
        references.push(format!("claimmd-claim:{id}"));
    }
    references
}

fn upload_receipt(v: &Value, out: &Submission) -> Result<Option<String>> {
    if v.get("error").is_some() {
        return Ok(None);
    }
    let claims = v["claim"]
        .as_array()
        .filter(|c| c.len() == 1)
        .ok_or(Error::Invalid(
            "Claim.MD receipt must identify exactly the submitted claim",
        ))?;
    let c = &claims[0];
    if c["pcn"] != out.claim_snapshot["control_number"]
        || c["bill_npi"] != out.claim_snapshot["content"]["billing_npi"]
    {
        return Ok(None);
    }
    let reference = receipt_references(c)
        .into_iter()
        .next()
        .ok_or(Error::Invalid("Claim.MD file or claim receipt missing"))?;
    // Processing rejection is still confirmed delivery. Neither receipt kind
    // means payer acceptance, adjudication or payment.
    Ok(Some(reference))
}
fn id(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::to_owned)
        .or_else(|| v.as_u64().map(|v| v.to_string()))
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 20
                && s.bytes().all(|c| c.is_ascii_digit())
                && s.parse::<u64>().is_ok()
        })
}
pub(crate) async fn page(r: &Route, cursor: &str) -> Result<Page> {
    page_request(r, cursor, None).await
}
/// Every response Claim.MD holds for one claim. Not for periodic polling and it never moves the cursor.
pub(crate) async fn claim_page(r: &Route, claimmd_id: &str) -> Result<Page> {
    if claimmd_id.is_empty() || claimmd_id.len() > 64 {
        return Err(Error::Invalid("invalid Claim.MD claim ID"));
    }
    page_request(r, "0", Some(claimmd_id)).await
}
async fn page_request(r: &Route, cursor: &str, claim_id: Option<&str>) -> Result<Page> {
    let endpoint = if r.loopback_test {
        let u = url::Url::parse(&r.endpoint).unwrap();
        format!("{}/services/response/", u.origin().ascii_serialization())
    } else {
        "https://svc.claim.md/services/response/".into()
    };
    let mut fields = vec![
        ("AccountKey", token(r)?),
        ("ResponseID", cursor.to_string()),
    ];
    if let Some(claim_id) = claim_id {
        fields.push(("ClaimID", claim_id.to_string()));
    }
    let response = stedi::client()?
        .post(endpoint)
        .header("Accept", "application/json")
        .form(&fields)
        .send()
        .await
        .map_err(|_| Error::Invalid("Claim.MD response request failed"))?;
    poll_http_status(&response, "Claim.MD response HTTP failure")?;
    let raw = stedi::bytes(response, 4194304).await?;
    let v: Value =
        serde_json::from_slice(&raw).map_err(|_| Error::Invalid("invalid Claim.MD response"))?;
    if v.get("error").is_some() {
        return Err(Error::Invalid(
            "Claim.MD returned account error; cursor retained",
        ));
    }
    // Claim.MD returns exactly {} when no newer responses are available.
    // A missing cursor on any nonempty payload remains a protocol failure.
    if v.as_object().is_some_and(|object| object.is_empty()) {
        return Ok(Page {
            items: vec![],
            next: Some(id(&json!(cursor)).ok_or(Error::Invalid("invalid Claim.MD cursor"))?),
        });
    }
    let next =
        id(&v["last_responseid"]).ok_or(Error::Invalid("Claim.MD response cursor missing"))?;
    if next.parse::<u64>().ok() < cursor.parse::<u64>().ok() {
        return Err(Error::Invalid("Claim.MD cursor regressed"));
    }
    let claims = v
        .get("claim")
        .map(|v| {
            v.as_array()
                .ok_or(Error::Invalid("invalid Claim.MD claims"))
        })
        .transpose()?
        .cloned()
        .unwrap_or_default();
    let mut items = vec![];
    for claim in claims {
        let messages = claim["messages"]
            .as_array()
            .ok_or(Error::Invalid("Claim.MD response messages missing"))?;
        for message in messages {
            let response_id = id(&message["responseid"])
                .ok_or(Error::Invalid("Claim.MD message response ID missing"))?;
            if response_id.parse::<u64>().unwrap()
                > next
                    .parse::<u64>()
                    .map_err(|_| Error::Invalid("Claim.MD cursor exceeds range"))?
            {
                return Err(Error::Invalid("Claim.MD message exceeds response cursor"));
            }
            let mut evidence = serde_json::Map::new();
            for key in [
                "claimid",
                "claimmd_id",
                "pcn",
                "bill_npi",
                "bill_taxid",
                "ins_number",
                "payerid",
                "senderid",
                "sender_name",
                "sender_icn",
                "status",
                "total_charge",
                "fdos",
                "fileid",
                "response_time",
            ] {
                if let Some(value) = claim.get(key) {
                    if !value.is_string() {
                        return Err(Error::Invalid("unsupported Claim.MD identity field type"));
                    }
                    evidence.insert(key.into(), value.clone());
                }
            }
            let mut msg = serde_json::Map::new();
            for key in ["responseid", "fields", "status", "mesgid", "message"] {
                if let Some(v) = message.get(key) {
                    if key != "responseid" && !v.is_string() {
                        return Err(Error::Invalid("unsupported Claim.MD message field type"));
                    }
                    msg.insert(key.into(), v.clone());
                }
            }
            evidence.insert("message".into(), Value::Object(msg));
            let original = serde_json::to_string(&evidence)
                .map_err(|_| Error::Invalid("invalid Claim.MD evidence"))?;
            if original.len() > 48000 || items.len() >= 20000 {
                return Err(Error::Invalid(
                    "Claim.MD page exceeds supported evidence limit",
                ));
            }
            items.push(Observation {
                remote_id: format!("response:{response_id}"),
                format: "claimmd_status".into(),
                metadata: json!({"source":"claimmd_response_api","response_id":response_id}),
                status: "retrieved".into(),
                inline: Some(original),
            });
        }
    }
    Ok(Page {
        items,
        next: Some(next),
    })
}

// ERAID and ResponseID are separate provider namespaces. Never use NewOnly=1:
// downloading marks provider-side state and must not make crash recovery lose an ERA.
async fn era_request(r: &Route, service: &str, fields: Vec<(&str, String)>) -> Result<Value> {
    let base = if r.loopback_test {
        url::Url::parse(&r.endpoint)
            .map_err(|_| Error::Invalid("invalid route"))?
            .origin()
            .ascii_serialization()
    } else {
        "https://svc.claim.md".into()
    };
    let mut fields = fields;
    fields.push(("AccountKey", token(r)?));
    let response = stedi::client()?
        .post(format!("{base}/services/{service}/"))
        .header("Accept", "application/json")
        .form(&fields)
        .send()
        .await
        .map_err(|_| Error::Invalid("Claim.MD ERA request failed"))?;
    poll_http_status(&response, "Claim.MD ERA HTTP failure")?;
    let v: Value =
        serde_json::from_slice(&stedi::bytes(response, 4 * crate::era835::MAX_FILE_BYTES).await?)
            .map_err(|_| Error::Invalid("invalid Claim.MD ERA response"))?;
    if v.get("error").is_some() {
        return Err(Error::Invalid("Claim.MD ERA account error"));
    }
    Ok(v)
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct EraCursor {
    after: u64,
    page: u32,
    max_seen: u64,
}
pub(crate) async fn era_page(r: &Route, cursor: &str) -> Result<Page> {
    let position = if cursor.starts_with('{') {
        serde_json::from_str::<EraCursor>(cursor)
            .map_err(|_| Error::Invalid("invalid ERA page cursor"))?
    } else {
        let n = cursor
            .parse::<u64>()
            .map_err(|_| Error::Invalid("invalid ERA cursor"))?;
        EraCursor {
            after: n,
            page: 1,
            max_seen: n,
        }
    };
    if !(1..=10000).contains(&position.page) || position.max_seen < position.after {
        return Err(Error::Invalid("invalid ERA pagination state"));
    }
    let start = position.after;
    let v = era_request(
        r,
        "eralist",
        vec![
            ("ERAID", position.after.to_string()),
            ("NewOnly", "0".into()),
            ("Page", position.page.to_string()),
        ],
    )
    .await?;
    // An exact empty object is the provider's empty page. Finish a paginated
    // scan at its already-persisted high water, just like any short final page;
    // never reset to zero or advance to an ID not present in prior pages.
    if v.as_object().is_some_and(|object| object.is_empty()) {
        return Ok(Page {
            items: vec![],
            next: Some(position.max_seen.to_string()),
        });
    }
    let next = id(&v["last_eraid"]).ok_or(Error::Invalid("missing ERA cursor"))?;
    let rows = v
        .get("era")
        .map(|v| v.as_array().ok_or(Error::Invalid("invalid ERA list")))
        .transpose()?
        .cloned()
        .unwrap_or_default();
    if rows.len() > 100 || (!rows.is_empty() && next.parse::<u64>().unwrap() < start) {
        return Err(Error::Invalid("ERA cursor regressed or oversized page"));
    }
    let mut items = vec![];
    let mut seen = std::collections::HashSet::new();
    let mut max = position.max_seen;
    let count = rows.len();
    for row in rows {
        let era = id(&row["eraid"]).ok_or(Error::Invalid("invalid ERA identity"))?;
        let n = era.parse::<u64>().unwrap();
        if n <= start || !seen.insert(n) {
            return Err(Error::Invalid("duplicate or stale ERA identity"));
        }
        max = max.max(n);
        let mut metadata = json!({"source":"claimmd_era_api","eraid":era});
        // Only stable financial identity survives rediscovery; download_time is mutable.
        for key in [
            "payerid",
            "prov_npi",
            "prov_taxid",
            "check_number",
            "paid_amount",
            "paid_date",
            "check_type",
        ] {
            if let Some(v) = row.get(key) {
                if !v.is_string() || v.as_str().unwrap().len() > 150 {
                    return Err(Error::Invalid("invalid ERA metadata"));
                }
                metadata[key] = v.clone();
            }
        }
        items.push(Observation {
            remote_id: format!("era:{era}"),
            format: "x12_835".into(),
            metadata,
            status: "pending".into(),
            inline: None,
        });
    }
    // Keep ERAID fixed while walking provider pages, even if they are unsorted.
    // Advance only after the last page and after every observed ID is persisted.
    if (count > 0 && next.parse::<u64>().unwrap() < max) || (count == 100 && position.page == 10000)
    {
        return Err(Error::Invalid("ERA cursor does not cover persisted page"));
    }
    let next = if count == 100 {
        serde_json::to_string(&EraCursor {
            after: position.after,
            page: position.page + 1,
            max_seen: max,
        })
        .map_err(|_| Error::Invalid("invalid ERA page state"))?
    } else {
        max.to_string()
    };
    Ok(Page {
        items,
        next: Some(next),
    })
}

pub(crate) async fn era_input(r: &Route, remote: &str) -> Result<String> {
    let era = remote
        .strip_prefix("era:")
        .and_then(|v| id(&json!(v)))
        .ok_or(Error::Invalid("invalid ERA remote ID"))?;
    let v = era_request(r, "era835", vec![("eraid", era.clone())]).await?;
    if id(&v["eraid"]).as_ref() != Some(&era) {
        return Err(Error::Invalid("ERA response identity mismatch"));
    }
    let data = v["data"]
        .as_array()
        .filter(|v| v.len() == 1)
        .ok_or(Error::Invalid("ERA requires one original 835"))?;
    let raw = data[0]
        .as_str()
        .filter(|v| {
            v.is_ascii() && !v.trim().is_empty() && v.len() <= crate::era835::MAX_FILE_BYTES
        })
        .ok_or(Error::Invalid("ERA original missing or unsupported"))?;
    Ok(raw.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn claimmd_poll_retry_after_handles_seconds_and_http_dates() {
        let now = chrono::DateTime::parse_from_rfc3339("2015-10-21T07:26:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(retry_after_seconds(Some("240"), now), 240);
        assert_eq!(
            retry_after_seconds(Some("Wed, 21 Oct 2015 07:28:00 GMT"), now),
            120
        );
        assert_eq!(
            retry_after_seconds(Some("Wed, 21 Oct 2015 07:24:00 GMT"), now),
            1
        );
        assert_eq!(retry_after_seconds(Some("invalid"), now), 60);
    }

    fn submission() -> Submission {
        let id = Uuid::new_v4();
        let address = json!({"line1":"1 Test Way","line2":"","city":"Chicago","state":"IL","postal_code":"60601"});
        Submission {
            id,
            claim_id: Uuid::new_v4(),
            partner_id: Uuid::new_v4(),
            claim_version: 2,
            partner_version: 1,
            claim_snapshot: json!({
                "control_number":"SYN-CONTROL",
                "frequency":"original",
                "content":{"billing_provider_name":"Synthetic Clinic","billing_npi":"1234567893","tax_id":"000000001","rendering_npi":"1234567893","place_of_service":"11","diagnosis_codes":["Z00.00","Z01.00"],"line_diagnosis_pointers":[[1,2]]},
                "snapshot":{"patient":{"given_name":"Quinn","family_name":"Synthetic","birth_date":"1988-04-03"},"account":{"total_cents":12550,"content":{"service_date":"2026-10-01","lines":[{"code":"99213","modifiers":"25,95","units":2,"amount_cents":12550}]},"coverage_snapshot":{"coverage":{"content":{"relationship":"self","member_id":"SYN-member","group_number":"SYN-group"}},"payer":{"content":{"name":"Synthetic Payer","payer_code":"SYN-payer"}}}}}
            }),
            partner_snapshot: json!({}),
            details: json!({"billing_address":address,"subscriber_address":address,"patient_address":address,"payer_address":address,"subscriber_given_name":"Quinn","subscriber_family_name":"Synthetic","patient_sex":"F","subscriber_sex":"F","rendering_given_name":"Test","rendering_family_name":"Clinician","billing_taxonomy":"207Q00000X"}),
            payload: "internal artifact not uploaded".into(),
            payload_hash: "synthetic-hash".into(),
            interchange_control: "1".into(),
            group_control: "1".into(),
            transaction_control: "1".into(),
            status: "prepared".into(),
            technical_status: "pending".into(),
            payer_outcome: "pending".into(),
            version: 1,
            delivered_claim_version: None,
        }
    }

    #[test]
    fn native_professional_claim_uses_claimmd_json_contract_without_x12_identity() {
        let value = professional_json(&submission()).unwrap();
        let claim = &value["claim"][0];
        assert_eq!(claim["claim_form"], "1500");
        assert_eq!(claim["pcn"], "SYN-CONTROL");
        assert_eq!(claim["bill_npi"], "1234567893");
        assert_eq!(claim["diag_1"], "Z0000");
        assert_eq!(claim["charge"][0]["diag_ref"], "AB");
        assert_eq!(claim["charge"][0]["mod1"], "25");
        assert_eq!(claim["charge"][0]["mod2"], "95");
        assert!(value.get("AccountKey").is_none());
    }

    #[test]
    fn encounter_form_details_use_claimmd_documented_fields_and_are_absent_when_empty() {
        let plain = professional_json(&submission()).unwrap();
        let mut out = submission();
        let service = out.claim_snapshot["snapshot"]["account"]["content"]["service_date"]
            .as_str()
            .unwrap()
            .to_string();
        out.claim_snapshot["content"]["encounter"] = json!({
            "prior_authorization_number":"PA-SYN-1","current_illness_date":"2026-09-01",
            "hospitalization_from":"2026-09-02","hospitalization_to":"2026-09-04",
            "referring_provider_name":"Referrer, Synthetic","referring_npi":"1234567893",
            "supervising_provider_name":"Synthetic Supervisor","supervising_npi":"1234567893",
            "claim_codes":"AA BB","additional_claim_info":"Synthetic box 19","through_date":"2099-01-01"
        });
        out.claim_snapshot["snapshot"]["account"]["content"]["lines"][0]["service_to"] =
            json!("2099-01-02");
        let claim = &professional_json(&out).unwrap()["claim"][0];
        for (field, value) in [
            ("prior_auth", "PA-SYN-1"),
            ("cond_date", "2026-09-01"),
            ("hosp_from_date", "2026-09-02"),
            ("hosp_thru_date", "2026-09-04"),
            ("ref_npi", "1234567893"),
            ("ref_name_l", "Referrer"),
            ("ref_name_f", "Synthetic"),
            ("cond_code_1", "AA"),
            ("cond_code_2", "BB"),
        ] {
            assert_eq!(claim[field], value, "{field}");
        }
        let charge = &claim["charge"][0];
        assert_eq!(charge["from_date"], json!(service));
        assert_eq!(
            charge["thru_date"], "2099-01-02",
            "the line's own end date wins over the encounter's"
        );
        assert_eq!(charge["chg_supv_prov_npi"], "1234567893");
        assert_eq!(charge["chg_supv_prov_name_l"], "Supervisor");
        // Box 19 has no documented claim-level Claim.MD field, so nothing is invented for it.
        assert!(!claim.to_string().contains("Synthetic box 19"));
        // An empty encounter object sends exactly what a claim without one sends.
        let mut empty = submission();
        empty.claim_snapshot["content"]["encounter"] = json!({});
        assert_eq!(professional_json(&empty).unwrap()["claim"], plain["claim"]);
    }

    #[test]
    fn a_charge_with_an_ndc_sends_the_claimmd_drug_fields_and_a_line_without_one_does_not() {
        let mut out = submission();
        out.claim_snapshot["snapshot"]["account"]["content"]["lines"][0]["ndc_code"] =
            json!("00023114501");
        out.claim_snapshot["snapshot"]["account"]["content"]["lines"][0]["ndc_quantity"] =
            json!("100");
        out.claim_snapshot["snapshot"]["account"]["content"]["lines"][0]["ndc_unit"] = json!("UN");
        let charge = &professional_json(&out).unwrap()["claim"][0]["charge"][0];
        assert_eq!(charge["ndc_code"], "00023114501");
        assert_eq!(charge["ndc_dosage"], "100");
        assert_eq!(charge["ndc_measure"], "UN");
        // The record type stays as it was for every charge, drug or not.
        assert_eq!(charge["charge_record_type"], "UN");
        // Without an NDC none of the three drug fields appear at all.
        let charge = &professional_json(&submission()).unwrap()["claim"][0]["charge"][0];
        for field in ["ndc_code", "ndc_dosage", "ndc_measure"] {
            assert!(
                charge.get(field).is_none(),
                "a line without an NDC must not send {field}"
            );
        }
        // A half-recorded frozen drug set is refused, not guessed.
        out.claim_snapshot["snapshot"]["account"]["content"]["lines"][0]["ndc_quantity"] =
            json!("");
        assert!(professional_json(&out).is_err());
    }

    #[test]
    fn bill_taxid_type_follows_the_recorded_identity_and_defaults_to_ein() {
        // A practice billing under a Social Security number is sent as one.
        // A claim frozen before the type existed (no key at all, or "") is
        // sent as an EIN, exactly as before the type was recorded.
        for (stored, expected) in [
            (None, "E"),
            (Some(""), "E"),
            (Some("E"), "E"),
            (Some("S"), "S"),
        ] {
            let mut out = submission();
            match stored {
                Some(kind) => out.claim_snapshot["content"]["tax_id_type"] = json!(kind),
                None => {
                    out.claim_snapshot["content"]
                        .as_object_mut()
                        .unwrap()
                        .remove("tax_id_type");
                }
            }
            let claim = &professional_json(&out).unwrap()["claim"][0];
            assert_eq!(claim["bill_taxid_type"], expected, "stored {stored:?}");
            assert_eq!(claim["bill_taxid"], "000000001");
        }
    }

    #[test]
    fn documented_unknown_sex_is_preserved_instead_of_omitted() {
        // Claim.MD Professional Claim Form Overview accepts M, F and U for
        // patient/subscriber sex. Unknown is explicit, not a missing field.
        for sex in ["M", "F", "U"] {
            let mut out = submission();
            out.details["patient_sex"] = json!(sex);
            out.details["subscriber_sex"] = json!(sex);
            let value = professional_json(&out).unwrap();
            assert_eq!(value["claim"][0]["pat_sex"], sex);
            assert_eq!(value["claim"][0]["ins_sex"], sex);
        }
    }

    #[test]
    fn native_primary_claim_reports_copay_without_reducing_gross_charges() {
        let mut out = submission();
        out.claim_snapshot["snapshot"]["financial_summary"] =
            json!({"patient_payments_cents":2500,"open_balance_cents":10050});
        let value = professional_json(&out).unwrap();
        let claim = &value["claim"][0];
        assert_eq!(claim["total_charge"], "125.50");
        assert_eq!(claim["charge"][0]["charge"], "125.50");
        assert_eq!(claim["amount_paid"], "25.00");
        assert!(
            claim.get("balance_due").is_none(),
            "Only documented Claim.MD financial fields are emitted"
        );
        out.claim_snapshot["snapshot"]["financial_summary"]["patient_payments_cents"] = json!(0);
        assert_eq!(
            professional_json(&out).unwrap()["claim"][0]["amount_paid"],
            "0.00"
        );
        for value in [json!(-1), json!("2500"), Value::Null] {
            out.claim_snapshot["snapshot"]["financial_summary"]["patient_payments_cents"] = value;
            assert!(
                preflight(&out).is_err(),
                "Malformed frozen payment evidence must not be guessed"
            );
        }
        assert!(professional_json(&submission()).unwrap()["claim"][0]
            .get("amount_paid")
            .is_none());
    }

    #[test]
    fn processed_rejection_uses_provider_claim_id_without_inventing_file_receipt() {
        // Sanitized real response shape: claimid echoes our PCN, claimmd_id is
        // numeric, and a rejected claim may have empty fileid and batchid.
        let mut response: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/claimmd/rejected-upload.json"
        ))
        .unwrap();
        let out = submission();
        assert_eq!(
            upload_receipt(&response, &out).unwrap().as_deref(),
            Some("claimmd-claim:902000001")
        );
        assert_eq!(response["claim"][0]["status"], "R");
        response["claim"][0]["fileid"] = json!("123456");
        assert_eq!(
            upload_receipt(&response, &out).unwrap().as_deref(),
            Some("claimmd-file:123456"),
            "Existing file receipts retain their format and preference"
        );
        response["claim"][0]["fileid"] = json!("");
        for invalid in [
            Value::Null,
            json!(""),
            json!("0"),
            json!("000"),
            json!(-1),
            json!("902abc"),
            json!("18446744073709551616"),
        ] {
            response["claim"][0]["claimmd_id"] = invalid;
            assert!(upload_receipt(&response, &out).is_err());
        }
        response["claim"][0]["claimmd_id"] = json!(902000001);
        assert!(upload_receipt(&response, &out).unwrap().is_some());
        for field in ["pcn", "bill_npi"] {
            let mut wrong = response.clone();
            wrong["claim"][0][field] = json!("another-claim");
            assert!(upload_receipt(&wrong, &out).unwrap().is_none());
        }
        let mut extra = response.clone();
        extra["claim"]
            .as_array_mut()
            .unwrap()
            .push(response["claim"][0].clone());
        assert!(upload_receipt(&extra, &out).is_err());
        response["error"] = json!({"error_code":"1"});
        assert!(upload_receipt(&response, &out).unwrap().is_none());
    }

    #[test]
    fn native_preflight_rejects_corrections_without_provider_io() {
        let mut out = submission();
        assert!(preflight(&out).is_ok());
        for frequency in ["replacement", "void_request"] {
            out.claim_snapshot["frequency"] = json!(frequency);
            let error = preflight(&out).unwrap_err().to_string();
            assert!(error.contains("original claims only"), "{error}");
        }
        out.claim_snapshot["frequency"] = json!("original");
        out.details["billing_address"]["city"] = json!("");
        assert!(preflight(&out).is_err());
    }

    #[test]
    fn blank_payer_address_omits_payer_addr_fields_but_keeps_payer_identity() {
        // Claim.MD marks payer_addr_1/city/state/zip as not required. With nothing
        // recorded, none of those keys are emitted; the payer name and payerid stay.
        let mut out = submission();
        out.details["payer_address"] =
            json!({"line1":"","line2":"","city":"","state":"","postal_code":""});
        let claim = &professional_json(&out).unwrap()["claim"][0];
        for key in [
            "payer_addr_1",
            "payer_addr_2",
            "payer_city",
            "payer_state",
            "payer_zip",
        ] {
            assert!(claim.get(key).is_none(), "{key} must be absent: {claim}");
        }
        assert_eq!(claim["payer_name"], "Synthetic Payer");
        assert_eq!(claim["payerid"], "SYN-payer");
        // A fully recorded payer address still writes its keys.
        let filled = professional_json(&submission()).unwrap();
        assert_eq!(filled["claim"][0]["payer_addr_1"], "1 Test Way");
        assert_eq!(filled["claim"][0]["payer_city"], "Chicago");
    }

    #[test]
    fn partly_filled_payer_address_is_rejected() {
        // Only line1 present; city/state/ZIP are still required once anything is given.
        let mut out = submission();
        out.details["payer_address"] =
            json!({"line1":"1 Test Way","line2":"","city":"","state":"","postal_code":""});
        assert!(professional_json(&out).is_err());
        assert!(preflight(&out).is_err());
    }

    #[test]
    fn blank_address_is_still_required_for_bill_pat_and_ins() {
        let blank = json!({"line1":"","line2":"","city":"","state":"","postal_code":""});
        for party in ["billing_address", "patient_address", "subscriber_address"] {
            let mut out = submission();
            out.details[party] = blank.clone();
            assert!(
                professional_json(&out).is_err(),
                "{party} must stay strictly required"
            );
        }
    }

    #[test]
    fn outer_whitespace_is_trimmed_from_ins_number_names_and_address() {
        let mut out = submission();
        out.claim_snapshot["snapshot"]["account"]["coverage_snapshot"]["coverage"]["content"]
            ["member_id"] = json!("ABC123 ");
        out.claim_snapshot["snapshot"]["patient"]["given_name"] = json!(" Quinn");
        out.details["billing_address"]["line1"] = json!("  1 Test Way\t");
        let claim = &professional_json(&out).unwrap()["claim"][0];
        assert_eq!(claim["ins_number"], "ABC123");
        assert_eq!(claim["pat_name_f"], "Quinn");
        assert_eq!(claim["bill_addr_1"], "1 Test Way");
    }
}
