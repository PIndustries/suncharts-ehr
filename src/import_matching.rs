// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Finds charts that may already belong to a patient in an import, so the owner can
//! attach the imported records to that chart instead of creating a second one.
//! Matching only proposes; nothing is attached without a stored decision.
use crate::{auth::Actor, error::Result, model::NewPatient};
use chrono::NaiveDate;
use serde_json::{json, Map, Value};
use sqlx::{Postgres, Transaction};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

// Same folding table as scripts/import_ccda.py, so the offline overlap check and
// the server agree on what "the same name" means.
const FOLD_FROM: &str = "ÁÀÂÄÃÅáàâäãåÇçÉÈÊËéèêëÍÌÎÏíìîïÑñÓÒÔÖÕØóòôöõøÚÙÛÜúùûüÝýÿ";
const FOLD_TO: &str = "aaaaaaaaaaaacceeeeeeeeiiiiiiiinnoooooooooooouuuuuuuuyyy";

/// Accents folded, ASCII letters lower-cased, everything else removed. Names with
/// no Latin letters fall back to their lower-cased letters and digits.
pub(crate) fn normalize(value: &str) -> String {
    let folded: String = value
        .chars()
        .filter_map(|c| {
            let c = FOLD_FROM
                .chars()
                .position(|f| f == c)
                .and_then(|i| FOLD_TO.chars().nth(i))
                .unwrap_or(c)
                .to_ascii_lowercase();
            c.is_ascii_lowercase().then_some(c)
        })
        .collect();
    if folded.is_empty() {
        value
            .to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric())
            .collect()
    } else {
        folded
    }
}
fn first_given(value: &str) -> &str {
    value.trim_matches(' ').split(' ').next().unwrap_or("")
}

#[derive(sqlx::FromRow)]
struct Chart {
    id: Uuid,
    mrn: String,
    given_name: String,
    family_name: String,
    birth_date: NaiveDate,
    archived: bool,
}
impl Chart {
    fn view(&self, strength: Option<&str>) -> Value {
        let mut v = json!({"patient_id":self.id,"mrn":self.mrn,"given_name":self.given_name,"family_name":self.family_name,"birth_date":self.birth_date,"archived":self.archived});
        if let Some(strength) = strength {
            v["match"] = json!(strength);
        }
        v
    }
}

/// "exact": family name, first given name and birth date agree. "similar": family
/// name with the same first initial, or the same first given name, on that birth date.
fn strength(family: &str, given: &str, birth: NaiveDate, chart: &Chart) -> Option<&'static str> {
    if birth != chart.birth_date {
        return None;
    }
    let (fam, first) = (normalize(family), normalize(first_given(given)));
    let (chart_fam, chart_first) = (
        normalize(&chart.family_name),
        normalize(first_given(&chart.given_name)),
    );
    if fam.is_empty() || first.is_empty() {
        return None;
    }
    if fam == chart_fam && first == chart_first {
        Some("exact")
    } else if (fam == chart_fam && first.chars().next() == chart_first.chars().next())
        || first == chart_first
    {
        Some("similar")
    } else {
        None
    }
}

/// One entry per staged patient, in the order given: whether it is new, already
/// linked by an earlier import, matches one chart exactly, or needs a decision,
/// with the candidate charts and the stored decision when it is still valid.
pub(crate) async fn patients(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    source_instance: &str,
    staged: &[(&str, &NewPatient)],
    decisions: &Value,
) -> Result<Vec<Value>> {
    let links: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT source_id,target_id FROM source_identifiers WHERE tenant_id=$1 AND source_instance=$2 AND kind='patient'",
    )
    .bind(a.tenant_id)
    .bind(source_instance)
    .fetch_all(&mut **tx)
    .await?;
    let linked: HashMap<&str, Uuid> = links.iter().map(|(s, t)| (s.as_str(), *t)).collect();
    let taken: HashSet<Uuid> = links.iter().map(|(_, t)| *t).collect();
    let dates: Vec<NaiveDate> = staged
        .iter()
        .filter(|(source, _)| !linked.contains_key(source))
        .map(|(_, p)| p.birth_date)
        .collect();
    let targets: Vec<Uuid> = staged
        .iter()
        .filter_map(|(source, _)| linked.get(source).copied())
        .collect();
    let charts: Vec<Chart> = sqlx::query_as("SELECT p.id,p.mrn,p.given_name,p.family_name,p.birth_date,coalesce((SELECT archived FROM patient_lifecycle_events e WHERE e.tenant_id=p.tenant_id AND e.patient_id=p.id ORDER BY version DESC LIMIT 1),false) AS archived FROM patients p WHERE p.tenant_id=$1 AND (p.birth_date=ANY($2) OR p.id=ANY($3)) ORDER BY p.family_name,p.given_name,p.mrn,p.id")
        .bind(a.tenant_id)
        .bind(&dates)
        .bind(&targets)
        .fetch_all(&mut **tx)
        .await?;
    let mut used = HashSet::new();
    let mut out = Vec::with_capacity(staged.len());
    for (source, p) in staged {
        let mut entry = json!({"source_id":source,"given_name":p.given_name,"family_name":p.family_name,"birth_date":p.birth_date,"candidates":[],"decision":null});
        if let Some(target) = linked.get(source) {
            entry["status"] = json!("linked");
            entry["chart"] = charts
                .iter()
                .find(|c| c.id == *target)
                .map_or(Value::Null, |c| c.view(None));
            out.push(entry);
            continue;
        }
        let found: Vec<(&Chart, &str)> = charts
            .iter()
            .filter(|c| !taken.contains(&c.id))
            .filter_map(|c| {
                strength(&p.family_name, &p.given_name, p.birth_date, c).map(|s| (c, s))
            })
            .collect();
        entry["status"] = json!(match found.as_slice() {
            [] => "new",
            [(_, "exact")] => "match",
            _ => "possible",
        });
        entry["candidates"] = found.iter().map(|(c, s)| c.view(Some(s))).collect();
        if !found.is_empty() {
            let stored = &decisions[*source];
            let target = stored["patient_id"]
                .as_str()
                .and_then(|v| v.parse::<Uuid>().ok());
            let valid = match stored["action"].as_str() {
                Some("create") => true,
                // A chart takes the records of one imported patient only.
                Some("attach") => {
                    target.is_some_and(|t| found.iter().any(|(c, _)| c.id == t) && used.insert(t))
                }
                _ => false,
            };
            if valid {
                entry["decision"] = stored.clone();
            }
        }
        out.push(entry);
    }
    Ok(out)
}

/// Pre-selects "attach" for a single exact match that has no decision yet (when
/// `preselect` is set) and returns the decisions to store with how many patients
/// still need one.
pub(crate) fn settle(patients: &mut [Value], preselect: bool) -> (Value, u64) {
    let mut used: HashSet<String> = patients
        .iter()
        .filter(|p| p["decision"]["action"] == "attach")
        .filter_map(|p| p["decision"]["patient_id"].as_str().map(str::to_owned))
        .collect();
    let (mut stored, mut undecided) = (Map::new(), 0);
    for p in patients.iter_mut() {
        if !matches!(p["status"].as_str(), Some("match" | "possible")) {
            continue;
        }
        if p["decision"].is_null() && preselect && p["status"] == "match" {
            let target = p["candidates"][0]["patient_id"].clone();
            if used.insert(target.as_str().unwrap_or_default().to_owned()) {
                p["decision"] = json!({"action":"attach","patient_id":target,"preselected":true});
            }
        }
        if p["decision"].is_null() {
            undecided += 1;
        } else if let Some(source) = p["source_id"].as_str() {
            stored.insert(source.to_owned(), p["decision"].clone());
        }
    }
    (Value::Object(stored), undecided)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chart(given: &str, family: &str, birth: &str) -> Chart {
        Chart {
            id: Uuid::new_v4(),
            mrn: "SYN-1".into(),
            given_name: given.into(),
            family_name: family.into(),
            birth_date: birth.parse().unwrap(),
            archived: false,
        }
    }

    #[test]
    fn folding_table_is_aligned_and_names_normalize_like_the_offline_check() {
        assert_eq!(FOLD_FROM.chars().count(), FOLD_TO.chars().count());
        assert_eq!(normalize(" O'Brien-Núñez "), "obriennunez");
        assert_eq!(normalize("Åsa"), "asa");
        assert_eq!(first_given(" Avery  Q "), "Avery");
    }

    #[test]
    fn exact_and_similar_tiers_need_the_same_birth_date() {
        let born = "1990-01-01".parse().unwrap();
        let c = chart("avery quinn", "SYNTHETIC", "1990-01-01");
        assert_eq!(strength("Synthetic", "Avery", born, &c), Some("exact"));
        assert_eq!(strength("Synthetic", "Alex", born, &c), Some("similar"));
        assert_eq!(strength("Renamed", "Avery", born, &c), Some("similar"));
        assert_eq!(strength("Synthetic", "Blake", born, &c), None);
        assert_eq!(
            strength("Synthetic", "Avery", "1990-01-02".parse().unwrap(), &c),
            None
        );
    }

    #[test]
    fn settle_preselects_only_single_exact_matches() {
        let id = Uuid::new_v4();
        let mut list = vec![
            json!({"source_id":"1","status":"match","candidates":[{"patient_id":id}],"decision":null}),
            json!({"source_id":"2","status":"possible","candidates":[{"patient_id":Uuid::new_v4()}],"decision":null}),
            json!({"source_id":"3","status":"new","candidates":[],"decision":null}),
        ];
        let (stored, undecided) = settle(&mut list, false);
        assert_eq!((stored, undecided), (json!({}), 2));
        let (stored, undecided) = settle(&mut list, true);
        assert_eq!(undecided, 1);
        assert_eq!(
            stored,
            json!({"1":{"action":"attach","patient_id":id,"preselected":true}})
        );
    }
}
