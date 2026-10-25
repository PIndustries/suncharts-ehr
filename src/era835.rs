// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Bounded 835 review profile, not a general X12/TR3 validator.
use crate::error::{Error, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Adjustment {
    pub group: String,
    pub reason_code: String,
    pub amount_cents: i64,
    pub service_index: Option<usize>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Service {
    pub code: String,
    pub charged_cents: i64,
    pub paid_cents: i64,
    pub line_control: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RemitClaim {
    pub control_number: String,
    pub payer_control_number: String,
    pub status: String,
    pub patient_name: String,
    pub charged_cents: i64,
    pub paid_cents: i64,
    pub patient_responsibility_cents: i64,
    pub adjustments: Vec<Adjustment>,
    pub services: Vec<Service>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderAdjustment {
    pub provider_id: String,
    pub fiscal_date: NaiveDate,
    pub reason_code: String,
    pub reference: String,
    pub amount_cents: i64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub payer_code: String,
    pub trace: String,
    pub payment_date: NaiveDate,
    pub total_paid_cents: i64,
    pub currency: String,
    pub claims: Vec<RemitClaim>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_adjustments: Vec<ProviderAdjustment>,
    #[serde(default)]
    pub issues: Vec<String>,
}
pub(crate) fn money(s: &str) -> Result<i64> {
    let (negative, s) = s.strip_prefix('-').map_or((false, s), |s| (true, s));
    let mut parts = s.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next().unwrap_or("");
    if whole.is_empty()
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || fraction.len() > 2
        || !fraction.bytes().all(|c| c.is_ascii_digit())
        || parts.next().is_some()
    {
        return Err(Error::Invalid("835 amounts require exact decimal cents"));
    }
    let n = whole
        .parse::<i64>()
        .ok()
        .and_then(|n| n.checked_mul(100))
        .and_then(|n| {
            n.checked_add(match fraction.len() {
                0 => 0,
                1 => fraction.parse::<i64>().unwrap_or(0) * 10,
                _ => fraction.parse::<i64>().unwrap_or(0),
            })
        })
        .filter(|n| *n <= 1000000000)
        .ok_or(Error::Invalid("835 amount exceeds supported range"))?;
    Ok(if negative { -n } else { n })
}
impl Document {
    pub fn validate(&self) -> Result<Vec<String>> {
        if (self.claims.is_empty() && self.provider_adjustments.is_empty())
            || self.claims.len() > 30
            || self.provider_adjustments.len() > 120
            || self.trace.trim().is_empty()
            || self.trace.len() > 150
            || self.payer_code.len() > 100
            || self.issues.len() > 100
            || self.issues.iter().any(|s| s.len() > 300)
        {
            return Err(Error::Invalid(
                "remittance requires bounded claims or provider adjustments, payer and trace evidence",
            ));
        }
        let mut issues = self.issues.clone();
        if self.currency != "USD" {
            issues.push("Only USD remittances can be posted".into());
        }
        if self.payment_date > chrono::Utc::now().date_naive() {
            issues.push("Payment date is in the future".into());
        }
        let mut total = 0i64;
        for (index, c) in self.claims.iter().enumerate() {
            if c.status.len() > 10
                || c.control_number.is_empty()
                || c.control_number.len() > 100
                || c.payer_control_number.len() > 150
                || c.patient_name.len() > 300
                || c.adjustments.len() > 100
                || c.services.len() > 100
            {
                return Err(Error::Invalid("invalid remittance claim shape"));
            }
            for amount in [
                c.charged_cents,
                c.paid_cents,
                c.patient_responsibility_cents,
            ] {
                if !(-1000000000..=1000000000).contains(&amount) {
                    return Err(Error::Invalid("remittance amount exceeds supported range"));
                }
                if (c.status == "22" && amount > 0) || (c.status != "22" && amount < 0) {
                    issues.push(format!("Row {}: negative/unsupported amount", index + 1));
                }
            }
            if !["1", "2", "3", "4", "19", "20", "21", "22"].contains(&c.status.as_str()) {
                issues.push(format!(
                    "Row {}: unsupported adjudication/reversal status",
                    index + 1
                ));
            }
            if c.status == "4" && c.paid_cents != 0 {
                issues.push(format!(
                    "Row {}: denied claim has a nonzero payment",
                    index + 1
                ));
            }
            let mut cas = 0i64;
            let mut pr = 0i64;
            for adj in &c.adjustments {
                if !(-1000000000..=1000000000).contains(&adj.amount_cents) {
                    return Err(Error::Invalid("CAS amount exceeds supported range"));
                }
                if adj.group.len() > 5 || adj.reason_code.is_empty() || adj.reason_code.len() > 20 {
                    return Err(Error::Invalid("invalid CAS code"));
                }
                if !["CO", "PR", "OA", "PI", "CR"].contains(&adj.group.as_str())
                    || (c.status == "22" && adj.amount_cents > 0)
                    || (c.status != "22" && adj.amount_cents < 0)
                {
                    issues.push(format!(
                        "Row {}: unsupported CAS group or amount; retain for manual review",
                        index + 1
                    ));
                }
                if adj.service_index.is_some_and(|i| i >= c.services.len()) {
                    return Err(Error::Invalid("CAS service reference is out of range"));
                }
                cas = cas
                    .checked_add(adj.amount_cents)
                    .ok_or(Error::Invalid("CAS total overflow"))?;
                if adj.group == "PR" {
                    pr += adj.amount_cents;
                }
            }
            if c.charged_cents != c.paid_cents + cas {
                issues.push(format!(
                    "Row {}: charges do not balance to payment plus CAS",
                    index + 1
                ));
            }
            if pr != c.patient_responsibility_cents {
                issues.push(format!(
                    "Row {}: CLP patient responsibility does not match PR CAS",
                    index + 1
                ));
            }
            if !c.services.is_empty() {
                let mut charges = 0i64;
                let mut paid = 0i64;
                for (i, line) in c.services.iter().enumerate() {
                    if line.code.len() > 200
                        || line.line_control.len() > 100
                        || !(-1000000000..=1000000000).contains(&line.charged_cents)
                        || !(-1000000000..=1000000000).contains(&line.paid_cents)
                        || (c.status == "22" && (line.charged_cents > 0 || line.paid_cents > 0))
                        || (c.status != "22" && (line.charged_cents < 0 || line.paid_cents < 0))
                    {
                        return Err(Error::Invalid("invalid remittance service line"));
                    }
                    charges += line.charged_cents;
                    paid += line.paid_cents;
                    let adj: i64 = c
                        .adjustments
                        .iter()
                        .filter(|a| a.service_index == Some(i))
                        .map(|a| a.amount_cents)
                        .sum();
                    if line.charged_cents != line.paid_cents + adj {
                        issues.push(format!(
                            "Row {} service {}: unbalanced service line",
                            index + 1,
                            i + 1
                        ));
                    }
                }
                if charges != c.charged_cents || paid != c.paid_cents {
                    issues.push(format!(
                        "Row {}: service totals differ from CLP totals",
                        index + 1
                    ));
                }
            }
            total = total
                .checked_add(c.paid_cents)
                .ok_or(Error::Invalid("payment total overflow"))?;
        }
        let mut provider_total = 0i64;
        for plb in &self.provider_adjustments {
            if plb.provider_id.trim().is_empty()
                || plb.provider_id.len() > 100
                || plb.reason_code.is_empty()
                || plb.reason_code.len() > 5
                || plb.reference.len() > 150
                || !(-1000000000..=1000000000).contains(&plb.amount_cents)
            {
                return Err(Error::Invalid(
                    "invalid provider adjustment identity or amount",
                ));
            }
            provider_total = provider_total
                .checked_add(plb.amount_cents)
                .ok_or(Error::Invalid("PLB overflow"))?;
        }
        total = total
            .checked_sub(provider_total)
            .ok_or(Error::Invalid("settlement overflow"))?;
        if total != self.total_paid_cents || !(0..=1000000000).contains(&self.total_paid_cents) {
            issues.push(
                "BPR payment total does not match claim payments minus PLB or supported range"
                    .into(),
            );
        }
        Ok(issues)
    }
}
pub fn parse(raw: &str) -> Result<Document> {
    parse_transaction(raw, None)
}
pub(crate) fn parse_transaction(
    raw: &str,
    delimiters: Option<(char, char, char)>,
) -> Result<Document> {
    if raw.len() > 48000 || !raw.is_ascii() {
        return Err(Error::Invalid(
            "835 review import requires ASCII text up to 48000 bytes",
        ));
    }
    let raw = raw.trim();
    let (element, terminator) = if raw.starts_with("ISA") {
        if raw.len() < 106 {
            return Err(Error::Invalid("incomplete ISA envelope"));
        }
        (raw.as_bytes()[3] as char, raw.as_bytes()[105] as char)
    } else {
        delimiters.map(|v| (v.0, v.1)).unwrap_or(('*', '~'))
    };
    if element == terminator || element.is_alphanumeric() || terminator.is_alphanumeric() {
        return Err(Error::Invalid("invalid 835 delimiters"));
    }
    let segments: Vec<Vec<&str>> = raw
        .split(terminator)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.split(element).collect())
        .collect();
    if segments.len() > 1500 {
        return Err(Error::Invalid("835 segment limit exceeded"));
    }
    let tags: Vec<&str> = segments.iter().map(|s| s[0]).collect();
    if raw.starts_with("ISA") {
        for tag in ["ISA", "GS", "GE", "IEA"] {
            if tags.iter().filter(|s| **s == tag).count() != 1 {
                return Err(Error::Invalid(
                    "835 requires one interchange and functional group",
                ));
            }
        }
        let isa = &segments[0];
        let gs = &segments[1];
        let ge = &segments[segments.len() - 2];
        let iea = &segments[segments.len() - 1];
        if isa.len() != 17
            || gs.first() != Some(&"GS")
            || ge.first() != Some(&"GE")
            || iea.first() != Some(&"IEA")
            || isa.get(13) != iea.get(2)
            || gs.get(6) != ge.get(2)
            || ge.get(1) != Some(&"1")
            || iea.get(1) != Some(&"1")
        {
            return Err(Error::Invalid("835 envelope count/control mismatch"));
        }
    } else if tags.iter().any(|t| ["ISA", "GS", "GE", "IEA"].contains(t)) {
        return Err(Error::Invalid("incomplete 835 envelope"));
    }
    let mut doc = Document {
        payer_code: String::new(),
        trace: String::new(),
        payment_date: chrono::Utc::now().date_naive(),
        total_paid_cents: 0,
        currency: "USD".into(),
        claims: vec![],
        issues: vec![],
        provider_adjustments: vec![],
    };
    let mut st = None;
    let mut se = false;
    let mut bpr = false;
    let mut trn = false;
    let mut payer = false;
    let mut service = None;
    let component = if raw.starts_with("ISA") {
        raw.as_bytes()[104] as char
    } else {
        delimiters.map(|v| v.2).unwrap_or(':')
    };
    let mut plb_started = false;
    for (index, seg) in segments.iter().enumerate() {
        let v = |i: usize| seg.get(i).copied().unwrap_or("");
        match v(0) {
            "ST" => {
                if st.is_some() || v(1) != "835" {
                    return Err(Error::Invalid("import exactly one 835 transaction set"));
                }
                st = Some((index, v(2).to_owned()));
            }
            "SE" => {
                let (start, control) = st.as_ref().ok_or(Error::Invalid("SE without ST"))?;
                if se || v(2) != control || v(1).parse::<usize>().ok() != Some(index - start + 1) {
                    return Err(Error::Invalid("835 SE count/control mismatch"));
                }
                se = true;
            }
            "ISA" | "IEA" => {}
            "GS" => {
                if v(1) != "HP" || !v(8).starts_with("005010X221") {
                    doc.issues
                        .push("Unsupported 835 functional group/version".into());
                }
            }
            "GE" => {
                if v(1) != "1" {
                    doc.issues
                        .push("Multiple transaction groups require separate review".into());
                }
            }
            _ if st.is_none() || se => {
                return Err(Error::Invalid("835 content is outside its transaction set"))
            }
            "BPR" => {
                if bpr {
                    return Err(Error::Invalid("duplicate BPR"));
                }
                bpr = true;
                doc.total_paid_cents = money(v(2))?;
                doc.payment_date = NaiveDate::parse_from_str(v(16), "%Y%m%d")
                    .map_err(|_| Error::Invalid("835 requires BPR payment date"))?;
                if !["C", "I", "D", "H"].contains(&v(1)) || v(3) != "C" {
                    doc.issues
                        .push("Unsupported BPR handling or credit/debit flag".into());
                }
            }
            "TRN" => {
                if trn || v(1) != "1" {
                    return Err(Error::Invalid("835 requires one reassociation TRN*1"));
                }
                trn = true;
                doc.trace = v(2).to_owned();
            }
            "N1" => {
                if v(1) == "PR" {
                    if payer {
                        return Err(Error::Invalid("duplicate payer identity"));
                    }
                    payer = true;
                    doc.payer_code = v(4).to_owned();
                }
            }
            "CLP" => {
                if plb_started {
                    return Err(Error::Invalid("CLP cannot follow PLB"));
                }
                service = None;
                doc.claims.push(RemitClaim {
                    control_number: v(1).into(),
                    status: v(2).into(),
                    charged_cents: money(v(3))?,
                    paid_cents: money(v(4))?,
                    patient_responsibility_cents: if v(5).is_empty() { 0 } else { money(v(5))? },
                    payer_control_number: v(7).into(),
                    patient_name: String::new(),
                    adjustments: vec![],
                    services: vec![],
                });
            }
            "SVC" => {
                if plb_started {
                    return Err(Error::Invalid("SVC cannot follow PLB"));
                }
                let claim = doc
                    .claims
                    .last_mut()
                    .ok_or(Error::Invalid("SVC without CLP"))?;
                claim.services.push(Service {
                    code: v(1).into(),
                    charged_cents: money(v(2))?,
                    paid_cents: money(v(3))?,
                    line_control: String::new(),
                });
                service = Some(claim.services.len() - 1);
            }
            "CAS" => {
                if plb_started {
                    return Err(Error::Invalid("CAS cannot follow PLB"));
                }
                let claim = doc
                    .claims
                    .last_mut()
                    .ok_or(Error::Invalid("CAS without CLP"))?;
                if seg.len() < 4 || (seg.len() - 2) % 3 == 1 {
                    return Err(Error::Invalid(
                        "CAS requires complete reason/amount pairs with optional quantity",
                    ));
                }
                for i in (2..seg.len()).step_by(3) {
                    claim.adjustments.push(Adjustment {
                        group: v(1).into(),
                        reason_code: v(i).into(),
                        amount_cents: money(v(i + 1))?,
                        service_index: service,
                    });
                }
            }
            "NM1" => {
                if v(1) == "QC" {
                    if let Some(c) = doc.claims.last_mut() {
                        c.patient_name = format!("{}, {}", v(3), v(4));
                    }
                }
            }
            "REF" => {
                if v(1) == "6R" {
                    if let (Some(c), Some(i)) = (doc.claims.last_mut(), service) {
                        c.services[i].line_control = v(2).into();
                    }
                }
            }
            "PLB" => {
                plb_started = true;
                service = None;
                if seg.len() < 5 || seg.len() > 15 || (seg.len() - 3) % 2 != 0 {
                    return Err(Error::Invalid("PLB requires 1 to 6 adjustment pairs"));
                }
                let fiscal_date = NaiveDate::parse_from_str(v(2), "%Y%m%d")
                    .map_err(|_| Error::Invalid("invalid PLB fiscal date"))?;
                for i in (3..seg.len()).step_by(2) {
                    let (code, reference) = v(i).split_once(component).unwrap_or((v(i), ""));
                    doc.provider_adjustments.push(ProviderAdjustment {
                        provider_id: v(1).into(),
                        fiscal_date,
                        reason_code: code.into(),
                        reference: reference.into(),
                        amount_cents: money(v(i + 1))?,
                    });
                }
            }
            "AMT" | "QTY" | "TS2" | "TS3" | "MIA" | "MOA" => doc.issues.push(format!(
                "{} supplemental data requires manual review; posting blocked",
                v(0)
            )),
            "DTM" | "N2" | "N3" | "N4" | "PER" | "LX" | "LQ" => {}
            _ => doc.issues.push(format!("Unsupported 835 segment {}", v(0))),
        }
    }
    if st.is_none() || !se || !bpr || !trn || !payer {
        return Err(Error::Invalid(
            "835 requires complete ST/SE, BPR, TRN and payer identity",
        ));
    }
    doc.validate()?;
    Ok(doc)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> String {
        "ST*835*0001~BPR*I*80*C*CHK************20261020~TRN*1*SYN-TRACE~N1*PR*Synthetic*PI*SYN-PAYER~CLP*SC-CONTROL*1*120*80*20*12*SYN-PAYER-CLAIM~CAS*CO*45*20*1~CAS*PR*1*20*1~SE*8*0001~".into()
    }
    #[test]
    fn exact_amounts_and_balancing() {
        let d = parse(&sample()).unwrap();
        assert_eq!(d.total_paid_cents, 8000);
        assert!(d.validate().unwrap().is_empty());
        assert!(parse(&sample().replace("*20*1~", "*20~"))
            .unwrap()
            .validate()
            .unwrap()
            .is_empty());
        assert_eq!(money("0.10").unwrap(), 10);
        assert!(money("1.001").is_err());
    }
    #[test]
    fn unsupported_and_unbalanced_835_never_posts() {
        let d = parse(&sample().replace("*80*20*12", "*79*20*12")).unwrap();
        assert!(!d.validate().unwrap().is_empty());
        let d = parse(&sample().replace("SE*8*", "PLB*PROV*20261020*WO:1*1~SE*9*")).unwrap();
        assert!(!d.validate().unwrap().is_empty());
        assert!(parse(&sample().replace("SE*8*", "SE*7*")).is_err());
    }
    #[test]
    fn envelope_service_balance_and_extreme_amount_guards() {
        let isa="ISA*00*          *00*          *ZZ*SYNTHETIC      *ZZ*RECEIVER       *261023*1200*^*00501*000000001*0*T*:~";
        assert_eq!(isa.len(), 106);
        let full=format!("{isa}GS*HP*SYNTHETIC*RECEIVER*20261023*1200*1*X*005010X221A1~{}GE*1*1~IEA*1*000000001~",sample());
        assert!(parse(&full).unwrap().validate().unwrap().is_empty());
        assert!(parse(&full.replace("IEA*1*000000001", "IEA*1*000000002")).is_err());
        let svc = sample()
            .replace("CAS*CO*45*20*1~", "SVC*HC:99213*120*80~CAS*CO*45*20*1~")
            .replace("SE*8*", "SE*9*");
        assert!(parse(&svc).unwrap().validate().unwrap().is_empty());
        assert!(!parse(&svc.replace("HC:99213*120*80", "HC:99213*120*79"))
            .unwrap()
            .validate()
            .unwrap()
            .is_empty());
        let mut doc = parse(&sample()).unwrap();
        doc.claims[0].adjustments[0].amount_cents = i64::MAX;
        assert!(doc.validate().is_err());
    }
    #[test]
    fn provider_pair_signs_fiscal_dates_and_reversal_balance_are_exact() {
        let raw="ST*835*1~BPR*I*0*C*CHK************20261020~TRN*1*SYN-PLB~N1*PR*Synthetic*PI*SYN-PAYER~PLB*1234567893*20261231*FB:prior*-80*WO:claim*80~SE*6*1~";
        let d = parse(raw).unwrap();
        assert!(d.claims.is_empty());
        assert_eq!(d.provider_adjustments.len(), 2);
        assert!(d.validate().unwrap().is_empty());
        assert_eq!(d.provider_adjustments[0].amount_cents, -8000);
        assert!(parse(&raw.replace("*WO:claim*80", "*WO:claim")).is_err());
        assert!(parse(&raw.replace("20261231", "20260230")).is_err());
        assert!(!parse(&raw.replace("*WO:claim*80", "*WO:claim*79"))
            .unwrap()
            .validate()
            .unwrap()
            .is_empty());
        let reversal = sample()
            .replace("BPR*I*80", "BPR*I*0")
            .replace("*1*120*80*20*12", "*22*-120*-80*-20*12")
            .replace("CO*45*20", "CO*45*-20")
            .replace("PR*1*20", "PR*1*-20")
            .replace(
                "SE*8*",
                "PLB*1234567893*20261231*WO:SYN-PAYER-CLAIM*-80~SE*9*",
            );
        assert!(parse(&reversal).unwrap().validate().unwrap().is_empty());
        let isa="ISA*00*          *00*          *ZZ*SYNTHETIC      *ZZ*RECEIVER       *261023*1200*^*00501*000000001*0*T*>~";
        let full=format!("{isa}GS*HP*SYNTHETIC*RECEIVER*20261023*1200*1*X*005010X221A1~{}GE*1*1~IEA*1*000000001~",raw.replace("FB:prior","FB>prior").replace("WO:claim","WO>claim"));
        assert_eq!(
            parse(&full).unwrap().provider_adjustments[1].reference,
            "claim"
        );
    }
}
