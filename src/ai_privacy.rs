// SPDX-License-Identifier: AGPL-3.0-only
//! Local identifier substitution, encrypted preview storage and exact approval.
//! This reduces disclosure; pattern recognition cannot guarantee deidentification.
use crate::{
    auth::Actor,
    error::{Error, Result},
    postgres::audit,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::{BTreeSet, HashMap};
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_REPLACEMENTS: usize = 512;
pub(crate) const WARNING:&str="Local identifier substitution reduces disclosure but does not guarantee deidentification. Review both provider-bound fields for remaining names, addresses, rare details and other identifying information before approving.";
#[derive(Serialize, Deserialize)]
struct Replacement {
    token: String,
    original: String,
    kind: String,
}
#[derive(Serialize, Deserialize)]
struct Payload {
    instruction: String,
    source_text: String,
    sanitized_instruction: String,
    sanitized_source_text: String,
    replacements: Vec<Replacement>,
}
pub(crate) struct Approved {
    pub(crate) instruction: String,
    pub(crate) source_text: String,
    pub(crate) metadata: Value,
    payload: Payload,
}
struct Span {
    start: usize,
    end: usize,
    kind: String,
}
fn pattern(expression: &str) -> Regex {
    Regex::new(expression).expect("static privacy expression")
}
fn push_span(spans: &mut Vec<Span>, span: Span) -> Result<()> {
    if spans.len() >= 4096 {
        return Err(Error::Invalid(
            "too many identifiers; reduce the text before previewing",
        ));
    }
    spans.push(span);
    Ok(())
}
fn boundary(text: &str, start: usize, end: usize, value: &str) -> bool {
    (!value.chars().next().is_some_and(char::is_alphanumeric)
        || !text[..start]
            .chars()
            .next_back()
            .is_some_and(char::is_alphanumeric))
        && (!value.chars().next_back().is_some_and(char::is_alphanumeric)
            || !text[end..]
                .chars()
                .next()
                .is_some_and(char::is_alphanumeric))
}
fn spans(text: &str, known: &[(String, String)]) -> Result<Vec<Span>> {
    let mut spans = Vec::new();
    for (value, kind) in known {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let escaped = regex::escape(value);
        let expression = Regex::new(&format!("(?i){}", escaped))
            .map_err(|_| Error::Invalid("invalid local identifier"))?;
        for found in expression.find_iter(text) {
            if boundary(text, found.start(), found.end(), value) {
                push_span(
                    &mut spans,
                    Span {
                        start: found.start(),
                        end: found.end(),
                        kind: kind.clone(),
                    },
                )?;
            }
        }
    }
    for (kind, expression, capture) in [
        (
            "email",
            r"(?i)[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9][a-z0-9.-]*\.[a-z]{2,63}",
            0,
        ),
        (
            "phone",
            r"(?i)(?:\+?1[ .-]?)?(?:\([0-9]{3}\)|[0-9]{3})[ .-]?[0-9]{3}[ .-]?[0-9]{4}(?:[ ]?(?:x|ext\.?)[ ]?[0-9]{1,6})?",
            0,
        ),
        (
            "date",
            r"\b(?:[12][0-9]{3}[-/][01]?[0-9][-/][0-3]?[0-9]|[01]?[0-9][/-][0-3]?[0-9][/-](?:[12][0-9]{3}|[0-9]{2}))\b",
            0,
        ),
        (
            "identifier",
            r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
            0,
        ),
        ("identifier", r"\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b", 0),
        (
            "identifier",
            r"(?i)\b(?:mrn|medical record(?: number| no\.?)?|patient[_ -]?id|member[_ -]?(?:id|number)|account[_ -]?(?:number|no\.?))\s*[:=#]?\s*([a-z0-9][a-z0-9._/-]{1,63})",
            1,
        ),
        (
            "name",
            r"(?im)(?:^|[;,]\s*)(?:patient(?: name)?|name)\s*[:=]\s*([^\r\n;,:]{1,100})",
            1,
        ),
        (
            "birth_date",
            r"(?i)\b(?:dob|date of birth|birth[_ -]?date)\s*[:=]?\s*((?:[a-z]{3,9}\s+[0-9]{1,2},?\s+[12][0-9]{3})|[0-9]{6,8})\b",
            1,
        ),
        (
            "address",
            r"(?i)\b[0-9]{1,6}\s+(?:[a-z0-9.'-]+\s+){1,6}(?:street|st\.?|avenue|ave\.?|road|rd\.?|lane|ln\.?|drive|dr\.?|court|ct\.?|boulevard|blvd\.?|way|place|pl\.?|parkway|pkwy\.?)(?:\s+(?:apt\.?|suite|ste\.?|unit|#)\s*[a-z0-9-]+)?\b",
            0,
        ),
        (
            "address",
            r"(?im)\b(?:address|street address)\s*[:=]\s*([^\r\n;]{1,250})",
            1,
        ),
    ] {
        for found in pattern(expression).captures_iter(text) {
            if let Some(found) = found.get(capture) {
                push_span(
                    &mut spans,
                    Span {
                        start: found.start(),
                        end: found.end(),
                        kind: kind.into(),
                    },
                )?;
            }
        }
    }
    spans.sort_by_key(|v| (v.start, std::cmp::Reverse(v.end)));
    let mut merged: Vec<Span> = Vec::new();
    for span in spans {
        if let Some(last) = merged.last_mut() {
            if span.start < last.end {
                last.end = last.end.max(span.end);
                if last.kind != span.kind {
                    last.kind = "identifier".into();
                }
                continue;
            }
        }
        merged.push(span);
    }
    Ok(merged)
}
fn substitute(
    text: &str,
    known: &[(String, String)],
    nonce: &str,
    replacements: &mut Vec<Replacement>,
    count: &mut usize,
) -> Result<String> {
    let mut out = String::new();
    let mut offset = 0;
    for span in spans(text, known)? {
        out.push_str(&text[offset..span.start]);
        let original = &text[span.start..span.end];
        let token = if let Some(existing) = replacements.iter().find(|r| r.original == original) {
            existing.token.clone()
        } else {
            if replacements.len() >= MAX_REPLACEMENTS {
                return Err(Error::Invalid(
                    "too many identifiers; reduce the text before previewing",
                ));
            }
            let token = format!("[[SUN_PRIVATE_{nonce}_{}]]", replacements.len());
            replacements.push(Replacement {
                token: token.clone(),
                original: original.into(),
                kind: span.kind,
            });
            token
        };
        out.push_str(&token);
        offset = span.end;
        *count += 1;
    }
    out.push_str(&text[offset..]);
    Ok(out)
}
fn redact(
    instruction: &str,
    source_text: &str,
    known: &[(String, String)],
) -> Result<(Payload, Value)> {
    if instruction.to_ascii_uppercase().contains("SUN_PRIVATE_")
        || source_text.to_ascii_uppercase().contains("SUN_PRIVATE_")
    {
        return Err(Error::Invalid(
            "source contains reserved privacy placeholders; remove them before previewing",
        ));
    }
    let nonce = Uuid::new_v4().simple().to_string();
    let mut replacements = Vec::new();
    let mut count = 0;
    let sanitized_instruction =
        substitute(instruction, known, &nonce, &mut replacements, &mut count)?;
    let sanitized_source_text =
        substitute(source_text, known, &nonce, &mut replacements, &mut count)?;
    let kinds: BTreeSet<_> = replacements.iter().map(|r| r.kind.clone()).collect();
    let metadata = json!({"status":"previewed","redaction_count":count,"identifier_types":kinds,"method":"local_identifier_substitution_v1","limitations":WARNING});
    Ok((
        Payload {
            instruction: instruction.into(),
            source_text: source_text.into(),
            sanitized_instruction,
            sanitized_source_text,
            replacements,
        },
        metadata,
    ))
}
async fn patient_context(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    patient_id: Option<Uuid>,
) -> Result<(Vec<(String, String)>, Value)> {
    let Some(id) = patient_id else {
        return Ok((vec![], Value::Null));
    };
    let row:Option<(String,String,String,NaiveDate,i64)>=sqlx::query_as("SELECT given_name,family_name,mrn,birth_date,identity_version FROM patients WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut **tx).await?;
    let (given, family, mrn, dob, version) = row.ok_or(Error::NotFound)?;
    let contact: Option<(i64, Value)> = sqlx::query_as(
        "SELECT version,content FROM patient_demographics WHERE tenant_id=$1 AND patient_id=$2",
    )
    .bind(actor.tenant_id)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    let mut known = vec![
        (format!("{given} {family}"), "name".into()),
        (format!("{family}, {given}"), "name".into()),
        (given.clone(), "name".into()),
        (family.clone(), "name".into()),
        (mrn.clone(), "mrn".into()),
        (id.to_string(), "identifier".into()),
    ];
    for format in [
        "%Y-%m-%d",
        "%m/%d/%Y",
        "%-m/%-d/%Y",
        "%m/%d/%y",
        "%B %-d, %Y",
        "%b %-d, %Y",
        "%B %-d %Y",
    ] {
        known.push((dob.format(format).to_string(), "birth_date".into()));
    }
    if let Some((_, content)) = &contact {
        for (pointer, kind) in [
            ("/preferred_name", "name"),
            ("/phone", "phone"),
            ("/email", "email"),
            ("/address/line1", "address"),
            ("/address/line2", "address"),
            ("/address/city", "address"),
            ("/address/postal_code", "address"),
            ("/emergency_contact/name", "name"),
            ("/emergency_contact/phone", "phone"),
        ] {
            if let Some(value) = content.pointer(pointer).and_then(Value::as_str) {
                known.push((value.into(), kind.into()));
                if kind == "phone" {
                    known.push((
                        value.chars().filter(char::is_ascii_digit).collect(),
                        kind.into(),
                    ));
                }
                if pointer == "/emergency_contact/name" {
                    for part in value.split_whitespace() {
                        known.push((part.into(), "name".into()));
                    }
                }
            }
        }
    }
    let revision = json!({"patient_id":id,"identity_version":version,"identity_digest":crate::oauth::hash(&json!([given,family,mrn,dob]).to_string()),"contact":contact});
    Ok((known, revision))
}
fn binding_digest(
    binding: &Value,
    patient_revision: &Value,
    instruction: &str,
    source: &str,
) -> String {
    crate::oauth::hash(&json!({"binding":binding,"patient_revision":patient_revision,"instruction":instruction,"source_text":source}).to_string())
}
pub(crate) async fn preview(
    pool: &PgPool,
    actor: &Actor,
    binding: Value,
    patient_id: Option<Uuid>,
    instruction: &str,
    source: &str,
) -> Result<Value> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let (known, revision) = patient_context(&mut tx, actor, patient_id).await?;
    let (payload, metadata) = redact(instruction, source, &known)?;
    let digest = binding_digest(&binding, &revision, instruction, source);
    let id = Uuid::new_v4();
    let expires = Utc::now() + Duration::minutes(15);
    let plaintext = Zeroizing::new(
        serde_json::to_string(&payload)
            .map_err(|_| Error::Invalid("privacy preview cannot be encoded"))?,
    );
    if plaintext.len() > 500_000 {
        return Err(Error::Invalid("privacy preview exceeds its limit"));
    }
    let encrypted = crate::provider_settings::seal_secret(
        pool,
        actor.tenant_id,
        id,
        "ai-privacy-preview",
        &plaintext,
    )
    .await?;
    sqlx::query("INSERT INTO ai_privacy_previews(tenant_id,id,created_by,binding_digest,encrypted_payload,metadata,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(actor.tenant_id).bind(id).bind(actor.sub).bind(digest).bind(encrypted).bind(&metadata).bind(expires).execute(&mut *tx).await?;
    audit(&mut tx, actor, "ai.privacy.previewed", id).await?;
    tx.commit().await?;
    Ok(
        json!({"id":id,"expires_at":expires,"integration_id":binding["integration_id"],"provider":binding["provider"],"model":binding["model"],"purpose":binding["purpose"],"patient_id":patient_id,"instruction":payload.sanitized_instruction,"source_text":payload.sanitized_source_text,"redaction_count":metadata["redaction_count"],"identifier_types":metadata["identifier_types"],"warnings":[WARNING,if patient_id.is_none(){"No patient context selected; review names and identifiers that do not match recognizable patterns."}else{"Patient identity and contact identifiers were matched locally; review other people and identifying clinical context."}],"requires_approval":true}),
    )
}
#[allow(clippy::too_many_arguments)]
pub(crate) async fn approve(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
    draft_id: Uuid,
    binding: &Value,
    patient_id: Option<Uuid>,
    instruction: &str,
    source: &str,
) -> Result<Approved> {
    let (payload, mut metadata) =
        verified(tx, actor, id, binding, patient_id, instruction, source).await?;
    let inserted=sqlx::query("INSERT INTO ai_privacy_approvals(tenant_id,preview_id,draft_id,approved_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
        .bind(actor.tenant_id).bind(id).bind(draft_id).bind(actor.sub).execute(&mut **tx).await?;
    if inserted.rows_affected() != 1 {
        return Err(Error::Conflict(
            "privacy preview was already used; create a new preview",
        ));
    }
    metadata["status"] = json!("approved");
    metadata["preview_id"] = json!(id);
    metadata["approved_by"] = json!(actor.sub);
    metadata["approved_at"] = json!(Utc::now());
    metadata["patient_context_used"] = json!(patient_id.is_some());
    audit(tx, actor, "ai.privacy.approved", id).await?;
    Ok(Approved {
        instruction: payload.sanitized_instruction.clone(),
        source_text: payload.sanitized_source_text.clone(),
        metadata,
        payload,
    })
}
#[allow(clippy::too_many_arguments)]
async fn verified(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
    binding: &Value,
    patient_id: Option<Uuid>,
    instruction: &str,
    source: &str,
) -> Result<(Payload, Value)> {
    type PreviewRow = (Uuid, String, Vec<u8>, Value, DateTime<Utc>);
    let row:Option<PreviewRow>=sqlx::query_as("SELECT created_by,binding_digest,encrypted_payload,metadata,expires_at FROM ai_privacy_previews WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut **tx).await?;
    let (creator, digest, encrypted, metadata, expires) = row.ok_or(Error::NotFound)?;
    if creator != actor.sub {
        return Err(Error::Forbidden);
    }
    if expires <= Utc::now() {
        return Err(Error::Conflict(
            "privacy preview expired; preview and approve again",
        ));
    }
    let (_, revision) = patient_context(tx, actor, patient_id).await?;
    if digest != binding_digest(binding, &revision, instruction, source) {
        return Err(Error::Conflict(
            "draft input, patient or provider changed; preview and approve again",
        ));
    }
    let payload = crate::provider_settings::open_secret(
        actor.tenant_id,
        id,
        "ai-privacy-preview",
        &encrypted,
    )?;
    let payload: Payload = serde_json::from_str(payload.expose())
        .map_err(|_| Error::Conflict("privacy preview cannot be restored"))?;
    let used: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM ai_privacy_approvals WHERE tenant_id=$1 AND preview_id=$2)",
    )
    .bind(actor.tenant_id)
    .bind(id)
    .fetch_one(&mut **tx)
    .await?;
    if used {
        return Err(Error::Conflict(
            "privacy preview was already used; create a new preview",
        ));
    }
    Ok((payload, metadata))
}
#[allow(clippy::too_many_arguments)]
pub(crate) async fn validate(
    pool: &PgPool,
    actor: &Actor,
    id: Uuid,
    binding: &Value,
    patient_id: Option<Uuid>,
    instruction: &str,
    source: &str,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    verified(&mut tx, actor, id, binding, patient_id, instruction, source).await?;
    tx.commit().await?;
    Ok(())
}
impl Approved {
    pub(crate) fn restore(&self, text: &str, purpose: &str) -> Result<String> {
        let mapping: HashMap<_, _> = self
            .payload
            .replacements
            .iter()
            .map(|r| (r.token.as_str(), r.original.as_str()))
            .collect();
        fn string(text: &str, mapping: &HashMap<&str, &str>) -> Result<String> {
            let expression = pattern(r"\[\[SUN_PRIVATE_[0-9a-f]{32}_[0-9]{1,4}\]\]");
            let remainder = expression.replace_all(text, "");
            if remainder.to_ascii_uppercase().contains("SUN_PRIVATE") {
                return Err(Error::Invalid(
                    "provider returned an invalid privacy placeholder",
                ));
            }
            let mut output = String::new();
            let mut start = 0;
            for token in expression.find_iter(text) {
                output.push_str(&text[start..token.start()]);
                output.push_str(mapping.get(token.as_str()).ok_or(Error::Invalid(
                    "provider returned an unknown privacy placeholder",
                ))?);
                start = token.end();
            }
            output.push_str(&text[start..]);
            Ok(output)
        }
        fn value(node: Value, mapping: &HashMap<&str, &str>, depth: usize) -> Result<Value> {
            if depth > 64 {
                return Err(Error::Invalid(
                    "provider response nesting exceeds privacy limit",
                ));
            }
            Ok(match node {
                Value::String(v) => Value::String(string(&v, mapping)?),
                Value::Array(v) => Value::Array(
                    v.into_iter()
                        .map(|v| value(v, mapping, depth + 1))
                        .collect::<Result<Vec<_>>>()?,
                ),
                Value::Object(v) => {
                    let mut out = serde_json::Map::new();
                    for (k, v) in v {
                        let k = string(&k, mapping)?;
                        if out.insert(k, value(v, mapping, depth + 1)?).is_some() {
                            return Err(Error::Invalid(
                                "provider response has conflicting restored keys",
                            ));
                        }
                    }
                    Value::Object(out)
                }
                other => other,
            })
        }
        let restored = if crate::claude_adapter::structured_purpose(purpose) {
            let parsed = serde_json::from_str(text)
                .map_err(|_| Error::Invalid("provider returned invalid structured data"))?;
            serde_json::to_string(&value(parsed, &mapping, 0)?)
                .map_err(|_| Error::Invalid("provider response cannot be restored"))?
        } else {
            string(text, &mapping)?
        };
        if !crate::claude_adapter::valid_output(purpose, &restored) {
            return Err(Error::Invalid(
                "restored provider response exceeds its limit",
            ));
        }
        Ok(restored)
    }
}
pub(crate) async fn local_input(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
) -> Result<Value> {
    let encrypted: Vec<u8> = sqlx::query_scalar(
        "SELECT encrypted_payload FROM ai_privacy_previews WHERE tenant_id=$1 AND id=$2",
    )
    .bind(actor.tenant_id)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::NotFound)?;
    let payload = crate::provider_settings::open_secret(
        actor.tenant_id,
        id,
        "ai-privacy-preview",
        &encrypted,
    )?;
    let payload: Payload = serde_json::from_str(payload.expose())
        .map_err(|_| Error::Conflict("privacy preview cannot be restored"))?;
    Ok(json!({"instruction":payload.instruction,"source_text":payload.source_text}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_both_fields_and_restores_only_its_own_tokens() {
        let known = vec![
            ("Avery".into(), "name".into()),
            ("Synthetic".into(), "name".into()),
            ("SYN-123".into(), "mrn".into()),
        ];
        let(p,m)=redact("Reply to Avery at avery@example.test", "Patient: Avery Synthetic; MRN: SYN-123; DOB 1990-01-01; phone (312) 555-0100; address: 123 Main Street; ICD-10-CM Z00.00 and CPT 99213.",&known).unwrap();
        for field in [&p.sanitized_instruction, &p.sanitized_source_text] {
            assert!(!field.contains("Avery"));
            assert!(!field.contains("SYN-123"));
            assert!(!field.contains("avery@example.test"));
        }
        assert!(p.sanitized_source_text.contains("Z00.00"));
        assert!(p.sanitized_source_text.contains("99213"));
        let token = p.replacements[0].token.clone();
        let original = p.replacements[0].original.clone();
        let approved = Approved {
            instruction: p.sanitized_instruction.clone(),
            source_text: p.sanitized_source_text.clone(),
            metadata: m,
            payload: p,
        };
        assert_eq!(
            approved.restore(&token, "draft_response").unwrap(),
            original
        );
        let json = approved
            .restore(&json!({"name":token}).to_string(), "structured_extraction")
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&json).unwrap()["name"],
            original
        );
        assert!(approved
            .restore(
                &format!("[[SUN_PRIVATE_{}_0]]", Uuid::new_v4().simple()),
                "draft_response"
            )
            .is_err());
        assert!(approved
            .restore("[[SUN_PRIVATE_broken]]", "draft_response")
            .is_err());
        assert!(redact("Use [[SUN_PRIVATE_injected]]", "source", &[]).is_err());
    }
    #[test]
    fn known_identifier_boundaries_and_json_escaping_are_preserved() {
        let (p, m) = redact(
            "Ann",
            "Annual visit, Ann at 42 Oak Road.",
            &[("Ann".into(), "name".into())],
        )
        .unwrap();
        assert!(p.sanitized_source_text.starts_with("Annual visit"));
        let token = p.replacements[0].token.clone();
        let approved = Approved {
            instruction: p.sanitized_instruction.clone(),
            source_text: p.sanitized_source_text.clone(),
            metadata: m,
            payload: p,
        };
        assert_eq!(
            approved
                .restore(&json!({"value":token}).to_string(), "structured_extraction")
                .unwrap(),
            r#"{"value":"Ann"}"#
        );
        assert_eq!(
            approved
                .restore(&json!({"name":token}).to_string(), "workflow_design")
                .unwrap(),
            r#"{"name":"Ann"}"#
        );
        assert!(approved
            .restore(
                &json!({"value":"[[SUN_PRIVATE_other_1]]"}).to_string(),
                "structured_extraction"
            )
            .is_err());
    }
    #[test]
    fn labeled_dates_and_match_collection_fail_closed() {
        let (payload, _) = redact("DOB: 01021990", "Code 99213", &[]).unwrap();
        assert!(!payload.sanitized_instruction.contains("01021990"));
        assert!(payload.sanitized_source_text.contains("99213"));
        assert!(redact("Review", &"A ".repeat(5000), &[("A".into(), "name".into())]).is_err());
    }
}
