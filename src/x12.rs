// SPDX-License-Identifier: AGPL-3.0-only
//! Independently implemented, bounded 5010 professional-claim profile.
//! Partner/TR3 validation and production trading-partner acceptance are separate gates.
use crate::{
    claims::{Claim, ClaimContent},
    error::{Error, Result},
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartnerContent {
    pub name: String,
    pub active: bool,
    pub sender_qualifier: String,
    pub sender_id: String,
    pub receiver_qualifier: String,
    pub receiver_id: String,
    pub application_sender: String,
    pub application_receiver: String,
    pub submitter_name: String,
    pub submitter_id: String,
    pub receiver_name: String,
    pub receiver_identifier: String,
    pub contact_name: String,
    pub contact_phone: String,
    pub usage: String,
    pub guide_reference: String,
}
pub fn element(s: &str, min: usize, max: usize) -> Result<String> {
    if s.len() < min
        || s.len() > max
        || !s
            .bytes()
            .all(|b| (32..=126).contains(&b) && !b"*~:^".contains(&b))
        || s.trim() != s
    {
        return Err(Error::Invalid(
            "EDI field requires bounded printable ASCII without X12 delimiters or outer whitespace",
        ));
    }
    Ok(s.to_string())
}
impl PartnerContent {
    pub fn validate(&self) -> Result<()> {
        for (v, min, max) in [
            (&self.name, 1, 100),
            (&self.sender_id, 1, 15),
            (&self.receiver_id, 1, 15),
            (&self.application_sender, 2, 15),
            (&self.application_receiver, 2, 15),
            (&self.submitter_name, 1, 60),
            (&self.submitter_id, 2, 80),
            (&self.receiver_name, 1, 60),
            (&self.receiver_identifier, 2, 80),
            (&self.contact_name, 1, 60),
            (&self.guide_reference, 1, 200),
        ] {
            element(v, min, max)?;
        }
        for q in [&self.sender_qualifier, &self.receiver_qualifier] {
            if !["ZZ", "01", "14", "30"].contains(&q.as_str()) {
                return Err(Error::Invalid(
                    "unsupported interchange identifier qualifier",
                ));
            }
        }
        if !["T", "P"].contains(&self.usage.as_str())
            || self.contact_phone.len() != 10
            || !self.contact_phone.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(Error::Invalid(
                "choose test/production usage and a ten-digit contact phone",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Address {
    pub line1: String,
    pub line2: String,
    pub city: String,
    pub state: String,
    pub postal_code: String,
}
impl Address {
    fn validate(&self) -> Result<()> {
        element(&self.line1, 1, 55)?;
        element(&self.line2, 0, 55)?;
        element(&self.city, 1, 30)?;
        if !"AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI".split(' ').any(|s|s==self.state)||![5,9].contains(&self.postal_code.len())||!self.postal_code.bytes().all(|b|b.is_ascii_digit()){return Err(Error::Invalid("supply a US state/territory and five/nine-digit ZIP"));}
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Details {
    pub billing_address: Address,
    pub subscriber_address: Address,
    pub patient_address: Address,
    pub payer_address: Address,
    pub subscriber_given_name: String,
    pub subscriber_family_name: String,
    pub patient_sex: String,
    pub subscriber_sex: String,
    pub rendering_given_name: String,
    pub rendering_family_name: String,
    pub billing_taxonomy: String,
    pub filing_indicator: String,
    pub signature_on_file: bool,
    pub benefits_assigned: bool,
    pub release_authorized: bool,
    pub routine_professional_reviewed: bool,
}
fn field<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str()
        .ok_or(Error::Invalid("frozen claim evidence is incomplete"))
}
fn decimal(n: i64) -> String {
    format!("{}.{:02}", n / 100, n % 100)
}
fn seg(parts: &[&str]) -> String {
    format!("{}~", parts.join("*").trim_end_matches('*'))
}
fn address(out: &mut Vec<String>, a: &Address) {
    out.push(seg(&[
        "N3",
        &a.line1.to_ascii_uppercase(),
        &a.line2.to_ascii_uppercase(),
    ]));
    out.push(seg(&[
        "N4",
        &a.city.to_ascii_uppercase(),
        &a.state,
        &a.postal_code,
    ]));
}
fn nm(
    out: &mut Vec<String>,
    entity: &str,
    kind: &str,
    last: &str,
    first: &str,
    qual: &str,
    id: &str,
) {
    out.push(seg(&[
        "NM1",
        entity,
        kind,
        &last.to_ascii_uppercase(),
        &first.to_ascii_uppercase(),
        "",
        "",
        "",
        qual,
        id,
    ]));
}
#[derive(Serialize)]
pub struct Generated {
    pub payload: String,
    pub interchange_control: String,
    pub group_control: String,
    pub transaction_control: String,
}
pub(crate) fn generate(
    c: &Claim,
    p: &PartnerContent,
    d: &Details,
    parent_control: Option<&str>,
    control: i64,
    now: DateTime<Utc>,
) -> Result<Generated> {
    p.validate()?;
    if !(1..=999999999).contains(&control) || !crate::claims::preflight(c)?.is_empty() {
        return Err(Error::Invalid(
            "claim preflight failed or interchange sequence exhausted",
        ));
    }
    for a in [
        &d.billing_address,
        &d.subscriber_address,
        &d.patient_address,
        &d.payer_address,
    ] {
        a.validate()?;
    }
    for s in [
        &d.subscriber_given_name,
        &d.subscriber_family_name,
        &d.rendering_given_name,
        &d.rendering_family_name,
    ] {
        element(s, 1, 35)?;
    }
    if !["M", "F", "U"].contains(&d.patient_sex.as_str())
        || !["M", "F", "U"].contains(&d.subscriber_sex.as_str())
        || !["CI", "MB", "MC", "MA", "CH", "VA", "TV", "WC", "ZZ"]
            .contains(&d.filing_indicator.as_str())
        || !d.signature_on_file
        || !d.benefits_assigned
        || !d.release_authorized
        || !d.routine_professional_reviewed
    {
        return Err(Error::Invalid("review demographics, filing indicator, consent/assignment and supported routine professional profile"));
    }
    if d.billing_taxonomy.len() != 10
        || !d
            .billing_taxonomy
            .bytes()
            .all(|b| b.is_ascii_alphanumeric())
    {
        return Err(Error::Invalid(
            "review ten-character billing provider taxonomy",
        ));
    }
    let content: ClaimContent = serde_json::from_value(c.content.clone())
        .map_err(|_| Error::Invalid("invalid claim packet"))?;
    if content.place_of_service != "11" {
        return Err(Error::Invalid("initial 837P profile supports routine office POS 11; facility cases need a broader profile"));
    }
    let account = &c.snapshot["account"];
    let patient = &c.snapshot["patient"];
    let cov = &account["coverage_snapshot"]["coverage"]["content"];
    let payer = &account["coverage_snapshot"]["payer"]["content"];
    if field(cov, "priority")? != "primary" || field(&account["content"], "currency")? != "USD" {
        return Err(Error::Invalid(
            "initial 837P profile supports primary USD coverage only",
        ));
    }
    let relationship = field(cov, "relationship")?;
    let self_patient = relationship == "self";
    if !["self", "spouse", "child"].contains(&relationship) {
        return Err(Error::Invalid("unsupported subscriber relationship"));
    }
    let first = element(field(patient, "given_name")?, 1, 35)?.to_ascii_uppercase();
    let last = element(field(patient, "family_name")?, 1, 60)?.to_ascii_uppercase();
    let dob = NaiveDate::parse_from_str(field(patient, "birth_date")?, "%Y-%m-%d")
        .map_err(|_| Error::Invalid("patient date of birth required"))?;
    let service =
        NaiveDate::parse_from_str(field(&account["content"], "service_date")?, "%Y-%m-%d")
            .map_err(|_| Error::Invalid("service date required"))?;
    if dob > service || service > now.date_naive() {
        return Err(Error::Invalid("invalid patient/service dates"));
    }
    if self_patient
        && (d.subscriber_given_name.to_ascii_uppercase() != first
            || d.subscriber_family_name.to_ascii_uppercase() != last
            || content.subscriber_birth_date != Some(dob)
            || d.subscriber_sex != d.patient_sex)
    {
        return Err(Error::Invalid(
            "self subscriber must match patient name, birth date and sex",
        ));
    }
    for (v, min, max) in [
        (&content.billing_provider_name, 1, 60),
        (&content.billing_npi, 10, 10),
        (&content.rendering_npi, 10, 10),
        (&content.tax_id, 9, 9),
        (&c.control_number, 1, 38),
    ] {
        element(v, min, max)?;
    }
    let member = element(field(cov, "member_id")?, 2, 80)?;
    let group = element(field(cov, "group_number")?, 0, 50)?;
    let plan = element(field(cov, "plan_name")?, 0, 50)?;
    let payer_name = element(field(payer, "name")?, 1, 60)?;
    let payer_code = element(field(payer, "payer_code")?, 2, 80)?;
    let lines = account["content"]["lines"]
        .as_array()
        .ok_or(Error::Invalid("claim charges missing"))?;
    let frequency = match c.frequency.as_str() {
        "original" => "1",
        "replacement" => "7",
        "void_request" => "8",
        _ => return Err(Error::Invalid("invalid claim frequency")),
    };
    if frequency != "1" {
        element(parent_control.unwrap_or(""), 1, 50)?;
    }
    let ic = format!("{control:09}");
    let gc = control.to_string();
    let tc = "0001".to_string();
    let isa = seg(&[
        "ISA",
        "00",
        "          ",
        "00",
        "          ",
        &p.sender_qualifier,
        &format!("{:<15}", p.sender_id),
        &p.receiver_qualifier,
        &format!("{:<15}", p.receiver_id),
        &now.format("%y%m%d").to_string(),
        &now.format("%H%M").to_string(),
        "^",
        "00501",
        &ic,
        "0",
        &p.usage,
        ":",
    ]);
    let mut out = vec![
        isa,
        seg(&[
            "GS",
            "HC",
            &p.application_sender,
            &p.application_receiver,
            &now.format("%Y%m%d").to_string(),
            &now.format("%H%M").to_string(),
            &gc,
            "X",
            "005010X222A1",
        ]),
    ];
    let mut st = vec![
        seg(&["ST", "837", &tc, "005010X222A1"]),
        seg(&[
            "BHT",
            "0019",
            "00",
            &c.control_number,
            &now.format("%Y%m%d").to_string(),
            &now.format("%H%M").to_string(),
            "CH",
        ]),
    ];
    nm(
        &mut st,
        "41",
        "2",
        &p.submitter_name,
        "",
        "46",
        &p.submitter_id,
    );
    st.push(seg(&[
        "PER",
        "IC",
        &p.contact_name.to_ascii_uppercase(),
        "TE",
        &p.contact_phone,
    ]));
    nm(
        &mut st,
        "40",
        "2",
        &p.receiver_name,
        "",
        "46",
        &p.receiver_identifier,
    );
    st.push(seg(&["HL", "1", "", "20", "1"]));
    st.push(seg(&[
        "PRV",
        "BI",
        "PXC",
        &d.billing_taxonomy.to_ascii_uppercase(),
    ]));
    nm(
        &mut st,
        "85",
        "2",
        &content.billing_provider_name,
        "",
        "XX",
        &content.billing_npi,
    );
    address(&mut st, &d.billing_address);
    st.push(seg(&["REF", "EI", &content.tax_id]));
    st.push(seg(&[
        "HL",
        "2",
        "1",
        "22",
        if self_patient { "0" } else { "1" },
    ]));
    st.push(seg(&[
        "SBR",
        "P",
        if self_patient { "18" } else { "" },
        &group,
        &plan,
        "",
        "",
        "",
        "",
        &d.filing_indicator,
    ]));
    nm(
        &mut st,
        "IL",
        "1",
        &d.subscriber_family_name,
        &d.subscriber_given_name,
        "MI",
        &member,
    );
    address(&mut st, &d.subscriber_address);
    if self_patient {
        st.push(seg(&[
            "DMG",
            "D8",
            &dob.format("%Y%m%d").to_string(),
            &d.patient_sex,
        ]));
    }
    nm(&mut st, "PR", "2", &payer_name, "", "PI", &payer_code);
    address(&mut st, &d.payer_address);
    if !self_patient {
        st.push(seg(&["HL", "3", "2", "23", "0"]));
        st.push(seg(&[
            "PAT",
            if relationship == "spouse" { "01" } else { "19" },
        ]));
        nm(&mut st, "QC", "1", &last, &first, "", "");
        address(&mut st, &d.patient_address);
        st.push(seg(&[
            "DMG",
            "D8",
            &dob.format("%Y%m%d").to_string(),
            &d.patient_sex,
        ]));
    }
    let total = account["total_cents"]
        .as_i64()
        .ok_or(Error::Invalid("missing charge total"))?;
    st.push(seg(&[
        "CLM",
        &c.control_number,
        &decimal(total),
        "",
        "",
        &format!("{}:B:{frequency}", content.place_of_service),
        "Y",
        "A",
        "Y",
        "Y",
    ]));
    if frequency != "1" {
        st.push(seg(&[
            "REF",
            "F8",
            &element(parent_control.unwrap_or(""), 1, 50)?,
        ]));
    }
    let mut diagnoses = vec!["HI".to_string()];
    for (i, dx) in content.diagnosis_codes.iter().enumerate() {
        let code = dx.replace('.', "").to_ascii_uppercase();
        if !(3..=7).contains(&code.len()) || !code.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(Error::Invalid("invalid ICD-10-CM diagnosis syntax"));
        }
        diagnoses.push(format!("{}:{code}", if i == 0 { "ABK" } else { "ABF" }));
    }
    st.push(format!("{}~", diagnoses.join("*")));
    nm(
        &mut st,
        "82",
        "1",
        &d.rendering_family_name,
        &d.rendering_given_name,
        "XX",
        &content.rendering_npi,
    );
    let mut sum = 0i64;
    for (i, l) in lines.iter().enumerate() {
        let system = field(l, "code_system")?;
        let code = element(field(l, "code")?, 5, 5)?.to_ascii_uppercase();
        if !((system == "CPT" && code.bytes().all(|b| b.is_ascii_digit()))
            || (system == "HCPCS"
                && code.as_bytes()[0].is_ascii_alphabetic()
                && code.as_bytes()[1..].iter().all(u8::is_ascii_digit)))
        {
            return Err(Error::Invalid("837P requires reviewed five-character CPT/HCPCS service codes; LOCAL is not exportable"));
        }
        let mut procedure = format!("HC:{code}");
        let modifiers: Vec<_> = field(l, "modifiers")?
            .split([',', ' '])
            .filter(|s| !s.is_empty())
            .collect();
        if modifiers.len() > 4 {
            return Err(Error::Invalid("at most four procedure modifiers supported"));
        }
        for m in modifiers {
            if m.len() != 2 || !m.bytes().all(|b| b.is_ascii_alphanumeric()) {
                return Err(Error::Invalid("invalid procedure modifier"));
            }
            procedure.push(':');
            procedure.push_str(&m.to_ascii_uppercase());
        }
        let amount = l["amount_cents"]
            .as_i64()
            .ok_or(Error::Invalid("invalid service amount"))?;
        let units = l["units"]
            .as_i64()
            .ok_or(Error::Invalid("invalid service units"))?;
        if !(1..=1000000000).contains(&amount) || !(1..=1000).contains(&units) {
            return Err(Error::Invalid("invalid service amount/units"));
        }
        sum += amount;
        let pointers = content.line_diagnosis_pointers[i]
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(":");
        st.push(seg(&["LX", &(i + 1).to_string()]));
        st.push(seg(&[
            "SV1",
            &procedure,
            &decimal(amount),
            "UN",
            &units.to_string(),
            &content.place_of_service,
            "",
            &pointers,
        ]));
        st.push(seg(&[
            "DTP",
            "472",
            "D8",
            &service.format("%Y%m%d").to_string(),
        ]));
        st.push(seg(&["REF", "6R", &(i + 1).to_string()]));
    }
    if sum != total {
        return Err(Error::Invalid("service charges differ from claim total"));
    }
    st.push(seg(&["SE", &(st.len() + 1).to_string(), &tc]));
    out.extend(st);
    out.push(seg(&["GE", "1", &gc]));
    out.push(seg(&["IEA", "1", &ic]));
    let payload = out.concat();
    if payload.len() > 48000 {
        return Err(Error::Invalid("837P artifact exceeds supported size"));
    }
    Ok(Generated {
        payload,
        interchange_control: ic,
        group_control: gc,
        transaction_control: tc,
    })
}

/// Narrow 999 transaction-level review; 277CA is retained for explicit per-claim review.
pub fn acknowledgment(raw: &str, format: &str, ic: &str, gc: &str, tc: &str) -> Result<Value> {
    if raw.is_empty() || raw.len() > 48000 || !raw.is_ascii() {
        return Err(Error::Invalid(
            "acknowledgment requires ASCII up to 48000 bytes",
        ));
    }
    let raw = raw.trim();
    let (e, t) = if raw.starts_with("ISA") {
        if raw.len() < 106 {
            return Err(Error::Invalid("incomplete acknowledgment ISA"));
        }
        (raw.as_bytes()[3] as char, raw.as_bytes()[105] as char)
    } else {
        ('*', '~')
    };
    if e == t || e.is_ascii_alphanumeric() || t.is_ascii_alphanumeric() {
        return Err(Error::Invalid("invalid acknowledgment delimiters"));
    }
    let rows: Vec<Vec<&str>> = raw
        .split(t)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.split(e).collect())
        .collect();
    if rows.len() > 1500 {
        return Err(Error::Invalid("acknowledgment segment limit exceeded"));
    }
    let find = |tag: &str| rows.iter().filter(|s| s[0] == tag).collect::<Vec<_>>();
    let at = |r: &Vec<&str>, i: usize| r.get(i).copied().unwrap_or("").to_string();
    let mut issues = vec![];
    if raw.starts_with("ISA") && format == "x12_ta1" {
        if rows.len() != 3
            || rows[0].len() != 17
            || rows[1][0] != "TA1"
            || rows[2][0] != "IEA"
            || at(&rows[0], 13) != at(&rows[2], 2)
            || at(&rows[2], 1) != "0"
        {
            return Err(Error::Invalid(
                "TA1 requires one interchange acknowledgment without a functional group",
            ));
        }
    } else if raw.starts_with("ISA") {
        if rows.len() < 6
            || rows[0].len() != 17
            || rows[1][0] != "GS"
            || rows[rows.len() - 2][0] != "GE"
            || rows[rows.len() - 1][0] != "IEA"
        {
            return Err(Error::Invalid(
                "acknowledgment requires one complete interchange/group",
            ));
        }
        for tag in ["ISA", "GS", "GE", "IEA"] {
            if find(tag).len() != 1 {
                return Err(Error::Invalid(
                    "multiple acknowledgment groups are unsupported",
                ));
            }
        }
        let isa = &rows[0];
        let gs = &rows[1];
        let ge = &rows[rows.len() - 2];
        let iea = &rows[rows.len() - 1];
        if at(isa, 13) != at(iea, 2)
            || at(gs, 6) != at(ge, 2)
            || at(ge, 1) != "1"
            || at(iea, 1) != "1"
        {
            return Err(Error::Invalid(
                "acknowledgment envelope controls/counts differ",
            ));
        }
    } else if rows
        .iter()
        .any(|r| ["ISA", "GS", "GE", "IEA"].contains(&r[0]))
    {
        return Err(Error::Invalid("incomplete acknowledgment envelope"));
    }
    if format == "x12_999"
        && rows.iter().any(|r| {
            ![
                "ISA", "GS", "ST", "AK1", "AK2", "IK3", "IK4", "CTX", "IK5", "AK9", "SE", "GE",
                "IEA",
            ]
            .contains(&r[0])
        })
    {
        issues.push("Unsupported 999 segment requires independent review".into());
    }
    let mut outcome = "needs_review";
    if format == "x12_ta1" {
        let ta = find("TA1");
        if ta.len() != 1 || at(ta[0], 1) != ic {
            issues.push("TA1 does not uniquely reference this interchange".to_string());
        } else {
            issues.push(format!("TA1 envelope result {} / {}; transaction and payer acceptance still require separate evidence",at(ta[0],4),at(ta[0],5)));
        }
    } else if ["x12_999", "x12_277ca"].contains(&format) {
        let st = find("ST");
        let se = find("SE");
        let expected = if format == "x12_999" { "999" } else { "277" };
        if st.len() != 1
            || se.len() != 1
            || at(st[0], 1) != expected
            || at(st[0], 2) != at(se[0], 2)
        {
            return Err(Error::Invalid(
                "import one matching acknowledgment ST/SE transaction",
            ));
        }
        let start = rows.iter().position(|r| r[0] == "ST").unwrap();
        let end = rows.iter().position(|r| r[0] == "SE").unwrap();
        if end < start || at(se[0], 1).parse::<usize>().ok() != Some(end - start + 1) {
            return Err(Error::Invalid("acknowledgment SE count mismatch"));
        }
        let expected_start = if raw.starts_with("ISA") { 2 } else { 0 };
        let expected_end = if raw.starts_with("ISA") {
            rows.len() - 3
        } else {
            rows.len() - 1
        };
        if start != expected_start || end != expected_end {
            issues.push("acknowledgment has content outside its transaction set".into());
        }
        if format == "x12_999"
            && ((!at(st[0], 3).is_empty() && at(st[0], 3) != "005010X231A1")
                || rows
                    .iter()
                    .position(|r| r[0] == "AK1")
                    .is_none_or(|i| i != start + 1))
        {
            issues.push("unsupported 999 version or control segment ordering".into());
        }
        if format == "x12_999" {
            let ak2pos = rows.iter().position(|r| r[0] == "AK2");
            let ik5pos = rows.iter().position(|r| r[0] == "IK5");
            let ak9pos = rows.iter().position(|r| r[0] == "AK9");
            if !matches!((ak2pos,ik5pos,ak9pos),(Some(a),Some(i),Some(g)) if a==start+2 && a<i && i<g && g==end-1 && rows.iter().enumerate().all(|(n,r)| !["IK3","IK4","CTX"].contains(&r[0]) || n>a&&n<i))
            {
                issues.push("999 acknowledgment segment ordering requires review".into());
            }
            for tag in ["AK1", "AK2"] {
                for row in find(tag) {
                    if !at(row, 3).is_empty() && at(row, 3) != "005010X222A1" {
                        issues.push("unsupported referenced 837 implementation version".into());
                    }
                }
            }
        }
        if format == "x12_277ca" {
            issues.push("277CA retained for manual claim-control, category/status and payer control review; no automated payer acceptance".into());
        } else {
            let ak1 = find("AK1");
            let ak2 = find("AK2");
            let ik5 = find("IK5");
            let ak9 = find("AK9");
            if ak1.len() != 1
                || ak2.len() != 1
                || ik5.len() != 1
                || ak9.len() != 1
                || at(ak1[0], 1) != "HC"
                || at(ak1[0], 2) != gc
                || at(ak2[0], 1) != "837"
                || at(ak2[0], 2) != tc
            {
                issues
                    .push("999 must uniquely match this 837 group and transaction control".into());
            } else if at(ik5[0], 1) != at(ak9[0], 1) {
                issues.push("999 transaction and group outcomes disagree".into());
            } else if !["A", "R"].contains(&at(ik5[0], 1).as_str())
                || !["A", "R"].contains(&at(ak9[0], 1).as_str())
            {
                issues.push(
                    "999 partial/accepted-with-errors result requires independent review".into(),
                );
            } else {
                let accepted = at(ik5[0], 1) == "A" && at(ak9[0], 1) == "A";
                if at(ak9[0], 2) != "1"
                    || at(ak9[0], 3) != "1"
                    || at(ak9[0], 4) != if accepted { "1" } else { "0" }
                {
                    issues.push(
                        "999 included/received/accepted counts do not match one transaction".into(),
                    );
                } else if accepted && ["IK3", "IK4", "CTX"].iter().any(|s| !find(s).is_empty()) {
                    issues.push(
                        "999 contains error detail despite acceptance; review required".into(),
                    );
                } else {
                    outcome = if accepted { "accepted" } else { "rejected" };
                }
            }
        }
    } else {
        return Err(Error::Invalid("choose x12_999, x12_ta1 or x12_277ca"));
    }
    if !issues.is_empty() {
        outcome = "needs_review";
    }
    Ok(json!({"outcome":outcome,"issues":issues,"format":format,"claim_acceptance":false}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn partner() -> PartnerContent {
        serde_json::from_value(json!({"name":"Synthetic","active":true,"sender_qualifier":"ZZ","sender_id":"SYN-SENDER","receiver_qualifier":"ZZ","receiver_id":"SYN-RECV","application_sender":"SYN-SENDER","application_receiver":"SYN-RECV","submitter_name":"Synthetic Clinic","submitter_id":"SUBMIT1","receiver_name":"Synthetic Partner","receiver_identifier":"RECV1","contact_name":"Test Operator","contact_phone":"2025550100","usage":"T","guide_reference":"Synthetic companion guide"})).unwrap()
    }
    fn claim() -> Claim {
        serde_json::from_value(json!({"id":UuidForTest::id(),"patient_id":UuidForTest::id(),"account_id":UuidForTest::id(),"payer_id":UuidForTest::id(),"control_number":"SYN-CONTROL","frequency":"original","parent_id":null,"status":"ready","version":2,"payer_control_number":"","source_history_id":null,"content":{"billing_provider_name":"Synthetic Clinic","billing_npi":"1234567893","rendering_npi":"1234567893","tax_id":"000000001","billing_address":"Synthetic original free text","patient_address":"Synthetic original free text","subscriber_address":"Synthetic original free text","subscriber_birth_date":"1988-04-03","place_of_service":"11","diagnosis_codes":["Z00.00","Z01.00"],"line_diagnosis_pointers":[[1,2]],"external_control_number":"","notes":""},"snapshot":{"patient":{"given_name":"Quinn","family_name":"Synthetic","birth_date":"1988-04-03"},"account":{"total_cents":12550,"content":{"currency":"USD","service_date":"2026-10-01","lines":[{"code_system":"CPT","code":"99213","modifiers":"25,95","units":2,"amount_cents":12550}]},"coverage_snapshot":{"coverage":{"content":{"priority":"primary","relationship":"self","member_id":"SYN-member","group_number":"SYN-group","plan_name":"Synthetic Plan"}},"payer":{"content":{"name":"Synthetic Payer","payer_code":"SYN-payer"}}}}}})).unwrap()
    }
    struct UuidForTest;
    impl UuidForTest {
        fn id() -> uuid::Uuid {
            uuid::Uuid::new_v4()
        }
    }
    fn details() -> Details {
        let a = json!({"line1":"1 Test Way","line2":"","city":"Chicago","state":"IL","postal_code":"60601"});
        serde_json::from_value(json!({"billing_address":a,"subscriber_address":a,"patient_address":a,"payer_address":a,"subscriber_given_name":"Quinn","subscriber_family_name":"Synthetic","patient_sex":"U","subscriber_sex":"U","rendering_given_name":"Test","rendering_family_name":"Clinician","billing_taxonomy":"207Q00000X","filing_indicator":"CI","signature_on_file":true,"benefits_assigned":true,"release_authorized":true,"routine_professional_reviewed":true})).unwrap()
    }
    fn ack(group: &str) -> String {
        format!("ST*999*ACK1*005010X231A1~AK1*HC*{group}*005010X222A1~AK2*837*0001*005010X222A1~IK5*A~AK9*A*1*1*1~SE*6*ACK1~")
    }
    #[test]
    fn professional_envelope_identity_precision_and_dependent_loops() {
        let mut c = claim();
        let mut p = partner();
        p.sender_id = "SYN-lower".into();
        let now = "2026-10-23T12:34:00Z".parse().unwrap();
        let d = details();
        let g = generate(&c, &p, &d, None, 42, now).unwrap();
        assert_eq!(g.payload.as_bytes()[105], b'~');
        assert!(g.payload.contains("SYN-lower      "));
        assert!(g
            .payload
            .contains("NM1*IL*1*SYNTHETIC*QUINN****MI*SYN-member~"));
        assert!(g
            .payload
            .contains("NM1*PR*2*SYNTHETIC PAYER*****PI*SYN-payer~"));
        assert!(g
            .payload
            .contains("SV1*HC:99213:25:95*125.50*UN*2*11**1:2~"));
        assert!(g.payload.contains("HI*ABK:Z0000*ABF:Z0100~"));
        assert!(g.payload.ends_with("GE*1*42~IEA*1*000000042~"));
        c.snapshot["account"]["coverage_snapshot"]["coverage"]["content"]["relationship"] =
            json!("child");
        let g = generate(&c, &p, &d, None, 43, now).unwrap();
        assert!(g
            .payload
            .contains("HL*3*2*23*0~PAT*19~NM1*QC*1*SYNTHETIC*QUINN~"));
    }
    #[test]
    fn unsupported_codes_delimiters_consents_and_replacement_controls_are_guarded() {
        let mut c = claim();
        let p = partner();
        let mut d = details();
        let now = Utc::now();
        c.snapshot["account"]["content"]["lines"][0]["code_system"] = json!("LOCAL");
        assert!(generate(&c, &p, &d, None, 1, now).is_err());
        c = claim();
        d.billing_address.line1 = "Injected~CLM*BAD".into();
        assert!(generate(&c, &p, &d, None, 1, now).is_err());
        d = details();
        d.signature_on_file = false;
        assert!(generate(&c, &p, &d, None, 1, now).is_err());
        d = details();
        c.frequency = "replacement".into();
        assert!(generate(&c, &p, &d, None, 1, now).is_err());
        let g = generate(&c, &p, &d, Some("SYN-ORIGINAL-PCN"), 1, now).unwrap();
        assert!(!g.payload.contains("11:B:7~"));
        assert!(g
            .payload
            .contains("11:B:7*Y*A*Y*Y~REF*F8*SYN-ORIGINAL-PCN~"));
    }
    #[test]
    fn technical_acknowledgment_controls_errors_and_versions_are_separate_from_payer_acceptance() {
        let good = ack("42");
        let r = acknowledgment(&good, "x12_999", "000000042", "42", "0001").unwrap();
        assert_eq!(r["outcome"], "accepted");
        assert_eq!(r["claim_acceptance"], false);
        assert_eq!(
            acknowledgment(&ack("WRONG"), "x12_999", "000000042", "42", "0001").unwrap()["outcome"],
            "needs_review"
        );
        assert!(acknowledgment(
            &good.replace("SE*6", "SE*5"),
            "x12_999",
            "000000042",
            "42",
            "0001"
        )
        .is_err());
        for bad in [
            good.replace("IK5*A", "IK5*E"),
            good.replace("AK9*A*1*1*1", "AK9*R*1*1*0"),
            good.replace("SE*6", "PLB*BAD~SE*7"),
        ] {
            assert_eq!(
                acknowledgment(&bad, "x12_999", "000000042", "42", "0001").unwrap()["outcome"],
                "needs_review"
            );
        }
    }
    #[test]
    fn ta1_interchange_only_and_out_of_order_999_are_reviewable() {
        let isa="ISA*00*          *00*          *ZZ*SYNTHETIC      *ZZ*RECEIVER       *261023*1200*^*00501*000000009*0*T*:~";
        assert_eq!(isa.len(), 106);
        let raw = format!("{isa}TA1*000000042*261023*1200*A*000~IEA*0*000000009~");
        let parsed = acknowledgment(&raw, "x12_ta1", "000000042", "42", "0001").unwrap();
        assert_eq!(parsed["outcome"], "needs_review");
        assert_eq!(parsed["claim_acceptance"], false);
        let full = format!(
            "{isa}GS*FA*RECEIVER*SENDER*20261023*1200*9*X*005010X231A1~{}GE*1*9~IEA*1*000000009~",
            ack("42")
        );
        assert_eq!(
            acknowledgment(&full, "x12_999", "000000042", "42", "0001").unwrap()["outcome"],
            "accepted"
        );
        assert!(acknowledgment(
            &full.replace("IEA*1*000000009", "IEA*1*000000010"),
            "x12_999",
            "000000042",
            "42",
            "0001"
        )
        .is_err());
        let bad = ack("42").replace(
            "AK2*837*0001*005010X222A1~IK5*A~",
            "IK5*A~AK2*837*0001*005010X222A1~",
        );
        assert_eq!(
            acknowledgment(&bad, "x12_999", "000000042", "42", "0001").unwrap()["outcome"],
            "needs_review"
        );
    }
}
