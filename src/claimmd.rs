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
pub const UPLOAD: &str = "https://svc.claim.md/services/upload/";
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
fn token(r: &Route) -> Result<String> {
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
    value[key]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or(Error::Invalid("Claim.MD professional claim field missing"))
}
fn money(cents: i64) -> Result<String> {
    if !(1..=100000000000).contains(&cents) {
        return Err(Error::Invalid("Claim.MD claim amount is invalid"));
    }
    Ok(format!("{}.{:02}", cents / 100, cents % 100))
}
fn address(target: &mut serde_json::Map<String, Value>, prefix: &str, value: &Value) -> Result<()> {
    for (source, suffix) in [
        ("line1", "addr_1"),
        ("line2", "addr_2"),
        ("city", "city"),
        ("state", "state"),
        ("postal_code", "zip"),
    ] {
        if let Some(text) = value[source].as_str().filter(|v| !v.is_empty()) {
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
            "Claim.MD native JSON corrections require a separately reviewed mapping",
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
    for (key, value) in [
        ("accept_assign", "Y"),
        ("auto_accident", "N"),
        ("employment_related", "N"),
        ("claim_form", "1500"),
        ("bill_name", required(content, "billing_provider_name")?),
        ("bill_npi", required(content, "billing_npi")?),
        ("bill_taxid", required(content, "tax_id")?),
        ("bill_taxid_type", "E"),
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
    native.insert("balance_due".into(), json!(money(total)?));
    native.insert("total_charge".into(), json!(money(total)?));
    native.insert("payer_order".into(), json!("Primary"));
    if let Some(date) = content["subscriber_birth_date"]
        .as_str()
        .filter(|v| !v.is_empty())
    {
        native.insert("ins_dob".into(), json!(date));
    }
    if let Some(group) = coverage["group_number"].as_str().filter(|v| !v.is_empty()) {
        native.insert("ins_group".into(), json!(group));
    }
    for (source, target) in [("patient_sex", "pat_sex"), ("subscriber_sex", "ins_sex")] {
        if let Some(sex @ ("M" | "F")) = details[source].as_str() {
            native.insert(target.into(), json!(sex));
        }
    }
    address(&mut native, "bill", &details["billing_address"])?;
    address(&mut native, "pat", &details["patient_address"])?;
    address(&mut native, "ins", &details["subscriber_address"])?;
    address(&mut native, "payer", &details["payer_address"])?;
    if let Some(name) = payer["name"].as_str().filter(|v| !v.is_empty()) {
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
        let mut charge = json!({
            "charge":money(amount)?,
            "charge_record_type":"UN",
            "diag_ref":diag_ref,
            "from_date":service_date,
            "thru_date":service_date,
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
        charges.push(charge);
    }
    native.insert("charge".into(), Value::Array(charges));
    Ok(json!({"fileid":out.id.to_string(),"claim":[Value::Object(native)]}))
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
    let id = c["fileid"]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 40 && v.bytes().all(|c| c.is_ascii_digit()))
        .ok_or(Error::Invalid("Claim.MD file receipt missing"))?;
    // Acknowledged by Claim.MD is transport evidence, never inferred payer acceptance.
    Ok(Some(format!("claimmd-file:{id}")))
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
    let endpoint = if r.loopback_test {
        let u = url::Url::parse(&r.endpoint).unwrap();
        format!("{}/services/response/", u.origin().ascii_serialization())
    } else {
        "https://svc.claim.md/services/response/".into()
    };
    let response = stedi::client()?
        .post(endpoint)
        .header("Accept", "application/json")
        .form(&[
            ("AccountKey", token(r)?),
            ("ResponseID", cursor.to_string()),
        ])
        .send()
        .await
        .map_err(|_| Error::Invalid("Claim.MD response request failed"))?;
    if response.status() != 200 {
        return Err(Error::Invalid("Claim.MD response HTTP failure"));
    }
    let raw = stedi::bytes(response, 4194304).await?;
    let v: Value =
        serde_json::from_slice(&raw).map_err(|_| Error::Invalid("invalid Claim.MD response"))?;
    if v.get("error").is_some() {
        return Err(Error::Invalid(
            "Claim.MD returned account error; cursor retained",
        ));
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
    if response.status() != 200 {
        return Err(Error::Invalid("Claim.MD ERA HTTP failure"));
    }
    let v: Value = serde_json::from_slice(&stedi::bytes(response, 1048576).await?)
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
        .filter(|v| v.is_ascii() && !v.trim().is_empty() && v.len() <= 48000)
        .ok_or(Error::Invalid("ERA original missing or unsupported"))?;
    Ok(raw.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

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
}
