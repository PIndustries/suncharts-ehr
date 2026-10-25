// SPDX-License-Identifier: AGPL-3.0-only
//! Bounded, envelope-aware 835 file parsing with exact byte slices.
use crate::{
    era835::{self, Document},
    error::{Error, Result},
};
use serde::Serialize;
use std::collections::HashSet;
#[derive(Serialize)]
pub struct Part {
    pub position: usize,
    pub start: usize,
    pub end: usize,
    pub interchange_control: Option<String>,
    pub group_control: Option<String>,
    pub transaction_control: String,
    pub usage: Option<String>,
    pub original_text: String,
    pub document: Document,
}
struct Group {
    control: String,
    count: usize,
    transactions: HashSet<String>,
}
struct Envelope {
    control: String,
    usage: String,
    groups: usize,
    seen: HashSet<String>,
    group: Option<Group>,
}
pub fn parse(raw: &str) -> Result<Vec<Part>> {
    if !raw.is_ascii() || raw.len() > 48000 || raw.trim().is_empty() {
        return Err(Error::Invalid("ERA file requires ASCII up to 48000 bytes"));
    }
    let mut parts = vec![];
    let mut cursor = 0;
    let mut delimiters = ('*', '~', ':');
    let mut envelope: Option<Envelope> = None;
    let mut start: Option<usize> = None;
    let mut bare_controls = HashSet::new();
    let mut interchanges = HashSet::new();
    let mut segments = 0;
    while cursor < raw.len() {
        while cursor < raw.len() && raw.as_bytes()[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor == raw.len() {
            break;
        }
        if raw[cursor..].starts_with("ISA") {
            if start.is_some() || envelope.is_some() || raw.len() - cursor < 106 {
                return Err(Error::Invalid("Invalid nested or incomplete ISA"));
            }
            delimiters = (
                raw.as_bytes()[cursor + 3] as char,
                raw.as_bytes()[cursor + 105] as char,
                raw.as_bytes()[cursor + 104] as char,
            );
            if [delimiters.0, delimiters.1, delimiters.2]
                .iter()
                .any(|c| c.is_ascii_alphanumeric() || c.is_ascii_whitespace())
                || delimiters.0 == delimiters.1
                || delimiters.0 == delimiters.2
                || delimiters.1 == delimiters.2
            {
                return Err(Error::Invalid("Invalid ISA delimiters"));
            }
        }
        let offset = raw[cursor..]
            .find(delimiters.1)
            .ok_or(Error::Invalid("Unterminated ERA segment"))?;
        let end = cursor + offset + 1;
        let fields: Vec<&str> = raw[cursor..end - 1].split(delimiters.0).collect();
        let f = |i: usize| fields.get(i).copied().unwrap_or("");
        segments += 1;
        if segments > 4000 {
            return Err(Error::Invalid("ERA file segment limit exceeded"));
        }
        match f(0) {
            "ISA" => {
                if fields.len() != 17
                    || f(12) != "00501"
                    || !["T", "P"].contains(&f(15))
                    || f(13).is_empty()
                    || !interchanges.insert((f(6).to_owned(), f(8).to_owned(), f(13).to_owned()))
                {
                    return Err(Error::Invalid("Invalid or duplicated interchange control"));
                }
                envelope = Some(Envelope {
                    control: f(13).into(),
                    usage: f(15).into(),
                    groups: 0,
                    seen: HashSet::new(),
                    group: None,
                });
            }
            "GS" => {
                let e = envelope.as_mut().ok_or(Error::Invalid("GS without ISA"))?;
                if start.is_some()
                    || e.group.is_some()
                    || f(1) != "HP"
                    || !f(8).starts_with("005010X221")
                    || f(6).is_empty()
                    || !e.seen.insert(f(6).to_owned())
                {
                    return Err(Error::Invalid("Invalid or duplicate 835 functional group"));
                }
                e.group = Some(Group {
                    control: f(6).into(),
                    count: 0,
                    transactions: HashSet::new(),
                });
            }
            "ST" => {
                if start.is_some() || f(1) != "835" || f(2).is_empty() {
                    return Err(Error::Invalid("Invalid 835 transaction start"));
                }
                let fresh = if let Some(e) = envelope.as_mut() {
                    e.group
                        .as_mut()
                        .ok_or(Error::Invalid("ST outside functional group"))?
                        .transactions
                        .insert(f(2).to_owned())
                } else {
                    bare_controls.insert(f(2).to_owned())
                };
                if !fresh {
                    return Err(Error::Invalid("Duplicate transaction control"));
                }
                start = Some(cursor);
            }
            "SE" => {
                let begin = start.take().ok_or(Error::Invalid("SE without ST"))?;
                if parts.len() >= 20 {
                    return Err(Error::Invalid("ERA file supports up to 20 transactions"));
                }
                let original_text = raw[begin..end].to_owned();
                let document = era835::parse_transaction(&original_text, Some(delimiters))?;
                parts.push(Part {
                    position: parts.len(),
                    start: begin,
                    end,
                    interchange_control: envelope.as_ref().map(|e| e.control.clone()),
                    group_control: envelope
                        .as_ref()
                        .and_then(|e| e.group.as_ref().map(|g| g.control.clone())),
                    transaction_control: f(2).into(),
                    usage: envelope.as_ref().map(|e| e.usage.clone()),
                    original_text,
                    document,
                });
                if let Some(e) = envelope.as_mut() {
                    e.group
                        .as_mut()
                        .ok_or(Error::Invalid("Missing group"))?
                        .count += 1;
                }
            }
            "GE" => {
                if start.is_some() {
                    return Err(Error::Invalid("GE inside ST"));
                }
                let e = envelope.as_mut().ok_or(Error::Invalid("GE without ISA"))?;
                let g = e.group.take().ok_or(Error::Invalid("GE without GS"))?;
                if f(1).parse::<usize>().ok() != Some(g.count) || f(2) != g.control || g.count == 0
                {
                    return Err(Error::Invalid("GE count/control mismatch"));
                }
                e.groups += 1;
            }
            "IEA" => {
                if start.is_some() {
                    return Err(Error::Invalid("IEA inside ST"));
                }
                let e = envelope.take().ok_or(Error::Invalid("IEA without ISA"))?;
                if e.group.is_some()
                    || e.groups == 0
                    || f(1).parse::<usize>().ok() != Some(e.groups)
                    || f(2) != e.control
                {
                    return Err(Error::Invalid("IEA count/control mismatch"));
                }
                delimiters = ('*', '~', ':');
            }
            _ if start.is_none() => return Err(Error::Invalid("Content outside 835 transaction")),
            _ => {}
        }
        cursor = end;
    }
    if envelope.is_some() || start.is_some() || parts.is_empty() {
        return Err(Error::Invalid(
            "Incomplete ERA file envelope or transactions",
        ));
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tx(control: &str) -> String {
        format!("ST*835*{control}~BPR*I*0*C*CHK************20261001~TRN*1*SYN-TRACE~N1*PR*Synthetic*PI*SYN-PAYER~PLB*1234567893*20261231*FB:SYN*-1*WO:SYN*1~SE*6*{control}~")
    }
    fn envelope(body: &str, control: &str, count: usize) -> String {
        format!("ISA*00*          *00*          *ZZ*SYNTHETIC      *ZZ*RECEIVER       *261024*1200*^*00501*{control}*0*T*:~GS*HP*SYNTHETIC*RECEIVER*20261024*1200*1*X*005010X221A1~{body}GE*{count}*1~IEA*1*{control}~")
    }
    #[test]
    fn multiple_interchanges_and_delimiters_preserve_exact_slices() {
        let first = envelope(&(tx("1") + "\r\n" + &tx("2")), "000000001", 2);
        let second = envelope(&tx("1"), "000000002", 1)
            .replace('*', "|")
            .replace('~', "!")
            .replace(':', ">");
        let raw = first + "\r\n" + &second;
        let parts = parse(&raw).unwrap();
        assert_eq!(parts.len(), 3);
        for p in &parts {
            assert_eq!(&raw[p.start..p.end], p.original_text);
            assert_eq!(p.usage.as_deref(), Some("T"));
            assert!(p.document.validate().unwrap().is_empty());
        }
        assert_eq!(parts[2].document.provider_adjustments[0].reference, "SYN");
    }
    #[test]
    fn framing_controls_counts_nesting_and_limits_are_enforced() {
        let file = envelope(&(tx("1") + &tx("2")), "000000001", 2);
        for bad in [
            file.replace("GE*2*1", "GE*1*1"),
            file.replace("IEA*1*000000001", "IEA*1*000000009"),
            file.replace("SE*6*1", "SE*5*1"),
            file.replace("ST*835*2", "ST*835*1"),
        ] {
            assert!(parse(&bad).is_err());
        }
        assert!(parse(&(tx("1") + &tx("1"))).is_err());
        assert!(parse(&(tx("1") + "garbage")).is_err());
        assert!(parse(&(0..21).map(|n| tx(&n.to_string())).collect::<String>()).is_err());
    }
}
