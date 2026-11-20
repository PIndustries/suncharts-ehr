// SPDX-License-Identifier: AGPL-3.0-only
//! The claim details a front desk fills in on an encounter form beside the charges, as on a
//! paper encounter form: prior authorization, dates, who rendered, referred and supervised,
//! where it took place, the few claim boxes a payer sometimes asks for, and staff notes.
//!
//! They are saved on the encounter's charge account and copied onto the claim prepared from it.
//! Every field is optional and skipped when empty, so accounts and claims saved before these
//! details existed read and serialize exactly as before.
use crate::error::{Error, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EncounterClaimDetails {
    /// Box 23 / 2300 REF*G1.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub prior_authorization_number: String,
    /// Box 14 / 2300 DTP*431.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_illness_date: Option<NaiveDate>,
    /// The last day of service when the encounter covers more than one day.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub through_date: Option<NaiveDate>,
    /// Do not send this claim electronically; it is printed instead.
    #[serde(default, skip_serializing_if = "is_false")]
    pub paper_only: bool,
    /// The secondary policy to bill after the primary, when the patient has more than one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary_coverage_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub rendering_provider_name: String,
    /// Overrides the practice's rendering NPI for this encounter (box 24J).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub rendering_npi: String,
    /// Overrides the practice's place of service for this encounter (box 24B).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub place_of_service: String,
    /// "" (in office) or "telehealth".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub encounter_mode: String,
    /// Where the service took place, when it is not the billing address (box 32).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub service_location_name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub service_location_address: String,
    /// Box 17 / 17b, 2310A NM1*DN.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub referring_provider_name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub referring_npi: String,
    /// 2310D NM1*DQ.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub supervising_provider_name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub supervising_npi: String,
    /// Box 18 / 2300 DTP*435 and DTP*096.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hospitalization_from: Option<NaiveDate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hospitalization_to: Option<NaiveDate>,
    /// Box 10d.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub claim_codes: String,
    /// Box 19 / 2300 NTE*ADD.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub additional_claim_info: String,
    /// For the practice's own reports: a batch the charges were entered in.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub batch_number: String,
    /// Staff only; never on the claim.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub business_office_note: String,
    /// Saved for someone to review before the charges are posted.
    #[serde(default, skip_serializing_if = "is_false")]
    pub review_requested: bool,
}

pub(crate) fn valid_npi(n: &str) -> bool {
    n.len() == 10
        && n.bytes().all(|b| b.is_ascii_digit())
        && format!("80840{n}")
            .bytes()
            .rev()
            .enumerate()
            .map(|(i, b)| {
                let d = u32::from(b - b'0');
                if i % 2 == 1 {
                    let x = d * 2;
                    if x > 9 {
                        x - 9
                    } else {
                        x
                    }
                } else {
                    d
                }
            })
            .sum::<u32>()
            % 10
            == 0
}

fn plain(value: &str, max: usize, what: &'static str) -> Result<()> {
    if value.chars().count() > max || value.chars().any(|c| c.is_control() && c != '\n') {
        return Err(Error::Invalid(what));
    }
    Ok(())
}

/// Claim text that goes into a claim file: printable ASCII only, so it cannot break a segment.
fn claim_text(value: &str, max: usize, what: &'static str) -> Result<()> {
    if value.len() > max
        || !value
            .bytes()
            .all(|b| (0x20..0x7f).contains(&b) && !matches!(b, b'~' | b'*' | b':' | b'^'))
    {
        return Err(Error::Invalid(what));
    }
    Ok(())
}

fn npi(value: &str, what: &'static str) -> Result<()> {
    if !value.is_empty() && !valid_npi(value) {
        return Err(Error::Invalid(what));
    }
    Ok(())
}

impl EncounterClaimDetails {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }

    /// The claim's copy: everything but the staff-only note and the review flag.
    pub fn for_claim(&self) -> Self {
        Self {
            business_office_note: String::new(),
            review_requested: false,
            batch_number: String::new(),
            ..self.clone()
        }
    }

    /// Trims every text field so stored values never carry stray spaces.
    pub fn normalize(&mut self) {
        for field in [
            &mut self.prior_authorization_number,
            &mut self.rendering_provider_name,
            &mut self.rendering_npi,
            &mut self.place_of_service,
            &mut self.encounter_mode,
            &mut self.service_location_name,
            &mut self.service_location_address,
            &mut self.referring_provider_name,
            &mut self.referring_npi,
            &mut self.supervising_provider_name,
            &mut self.supervising_npi,
            &mut self.claim_codes,
            &mut self.additional_claim_info,
            &mut self.batch_number,
            &mut self.business_office_note,
        ] {
            *field = field.trim().to_string();
        }
    }

    pub fn validate(&self, service_date: Option<NaiveDate>) -> Result<()> {
        claim_text(
            &self.prior_authorization_number,
            50,
            "The prior authorization number can use letters, numbers and dashes, up to 50 characters",
        )?;
        if let (Some(from), Some(through)) = (service_date, self.through_date) {
            if through < from {
                return Err(Error::Invalid(
                    "The through date cannot be before the date of service",
                ));
            }
        }
        if let (Some(from), Some(to)) = (self.hospitalization_from, self.hospitalization_to) {
            if to < from {
                return Err(Error::Invalid(
                    "The hospital discharge date cannot be before the admission date",
                ));
            }
        }
        if self.hospitalization_to.is_some() && self.hospitalization_from.is_none() {
            return Err(Error::Invalid(
                "Enter the hospital admission date with the discharge date",
            ));
        }
        npi(
            &self.rendering_npi,
            "The rendering provider NPI is not a valid NPI",
        )?;
        npi(
            &self.referring_npi,
            "The referring provider NPI is not a valid NPI",
        )?;
        npi(
            &self.supervising_npi,
            "The supervising provider NPI is not a valid NPI",
        )?;
        if !self.referring_npi.is_empty() && self.referring_provider_name.is_empty() {
            return Err(Error::Invalid(
                "Enter the referring provider's name with the NPI",
            ));
        }
        if !self.supervising_npi.is_empty() && self.supervising_provider_name.is_empty() {
            return Err(Error::Invalid(
                "Enter the supervising provider's name with the NPI",
            ));
        }
        if !self.place_of_service.is_empty()
            && !(self.place_of_service.len() == 2
                && self.place_of_service.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(Error::Invalid("The place of service is a two-digit code"));
        }
        if !matches!(
            self.encounter_mode.as_str(),
            "" | "in_office" | "telehealth"
        ) {
            return Err(Error::Invalid("The encounter is in office or telehealth"));
        }
        for (value, max, what) in [
            (
                &self.rendering_provider_name,
                120,
                "The rendering provider name is too long or has unusual characters",
            ),
            (
                &self.referring_provider_name,
                120,
                "The referring provider name is too long or has unusual characters",
            ),
            (
                &self.supervising_provider_name,
                120,
                "The supervising provider name is too long or has unusual characters",
            ),
            (
                &self.service_location_name,
                120,
                "The service location name is too long or has unusual characters",
            ),
            (
                &self.service_location_address,
                300,
                "The service location address is too long or has unusual characters",
            ),
            (
                &self.claim_codes,
                19,
                "Box 10d claim codes are up to 19 plain characters",
            ),
            (
                &self.additional_claim_info,
                71,
                "Box 19 is up to 71 plain characters",
            ),
            (
                &self.batch_number,
                30,
                "The batch number is up to 30 plain characters",
            ),
        ] {
            claim_text(value, max, what)?;
        }
        plain(
            &self.business_office_note,
            2000,
            "Business office notes are up to 2,000 characters",
        )?;
        Ok(())
    }

    /// The place of service the claim uses: this encounter's own, telehealth from home when
    /// the encounter is telehealth and none was chosen, otherwise the practice default.
    pub fn place_of_service_or(&self, practice_default: &str) -> String {
        if !self.place_of_service.is_empty() {
            self.place_of_service.clone()
        } else if self.encounter_mode == "telehealth" {
            "10".into()
        } else {
            practice_default.to_string()
        }
    }
}

/// "Last, First" or "First Last" as the two name parts a claim file and form carry.
pub fn name_parts(name: &str) -> (String, String) {
    let name = name.trim();
    if let Some((last, first)) = name.split_once(',') {
        return (last.trim().to_string(), first.trim().to_string());
    }
    match name.rsplit_once(' ') {
        Some((first, last)) => (last.trim().to_string(), first.trim().to_string()),
        None => (name.to_string(), String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn empty_details_serialize_to_an_empty_object() {
        let details = EncounterClaimDetails::default();
        assert!(details.is_empty());
        assert_eq!(serde_json::to_string(&details).unwrap(), "{}");
    }

    #[test]
    fn every_field_round_trips_and_validates() {
        let json = serde_json::json!({
            "prior_authorization_number":"PA-SYN-123","current_illness_date":"2026-10-01",
            "through_date":"2026-11-15","paper_only":true,
            "secondary_coverage_id":"00000000-0000-0000-0000-000000000001",
            "rendering_provider_name":"Synthetic Rendering","rendering_npi":"1234567893",
            "place_of_service":"11","encounter_mode":"in_office",
            "service_location_name":"Synthetic Clinic","service_location_address":"1 Synthetic Way, Austin, TX 78701",
            "referring_provider_name":"Referrer, Synthetic","referring_npi":"1234567893",
            "supervising_provider_name":"Synthetic Supervisor","supervising_npi":"1234567893",
            "hospitalization_from":"2026-11-01","hospitalization_to":"2026-11-03",
            "claim_codes":"AA","additional_claim_info":"Synthetic box 19","batch_number":"20261114SYN",
            "business_office_note":"Synthetic staff note","review_requested":true
        });
        let details: EncounterClaimDetails = serde_json::from_value(json.clone()).unwrap();
        details.validate(Some(date("2026-11-14"))).unwrap();
        assert_eq!(serde_json::to_value(&details).unwrap(), json);
        let claim = details.for_claim();
        assert!(
            claim.business_office_note.is_empty()
                && !claim.review_requested
                && claim.batch_number.is_empty()
        );
        assert_eq!(claim.prior_authorization_number, "PA-SYN-123");
    }

    #[test]
    fn refusals() {
        let base = EncounterClaimDetails::default();
        let cases: Vec<EncounterClaimDetails> = vec![
            EncounterClaimDetails {
                through_date: Some(date("2026-11-01")),
                ..base.clone()
            },
            EncounterClaimDetails {
                hospitalization_from: Some(date("2026-11-03")),
                hospitalization_to: Some(date("2026-11-01")),
                ..base.clone()
            },
            EncounterClaimDetails {
                hospitalization_to: Some(date("2026-11-01")),
                ..base.clone()
            },
            EncounterClaimDetails {
                rendering_npi: "1234567890".into(),
                ..base.clone()
            },
            EncounterClaimDetails {
                referring_npi: "1234567893".into(),
                ..base.clone()
            },
            EncounterClaimDetails {
                place_of_service: "1".into(),
                ..base.clone()
            },
            EncounterClaimDetails {
                encounter_mode: "phone".into(),
                ..base.clone()
            },
            EncounterClaimDetails {
                additional_claim_info: "x".repeat(72),
                ..base.clone()
            },
            EncounterClaimDetails {
                prior_authorization_number: "PA*1".into(),
                ..base.clone()
            },
            EncounterClaimDetails {
                claim_codes: "AA~".into(),
                ..base.clone()
            },
        ];
        for case in cases {
            assert!(case.validate(Some(date("2026-11-14"))).is_err(), "{case:?}");
        }
        assert!(
            serde_json::from_value::<EncounterClaimDetails>(serde_json::json!({"unknown":1}))
                .is_err()
        );
    }

    #[test]
    fn telehealth_defaults_to_home_place_of_service() {
        let tele = EncounterClaimDetails {
            encounter_mode: "telehealth".into(),
            ..Default::default()
        };
        assert_eq!(tele.place_of_service_or("11"), "10");
        let chosen = EncounterClaimDetails {
            encounter_mode: "telehealth".into(),
            place_of_service: "02".into(),
            ..Default::default()
        };
        assert_eq!(chosen.place_of_service_or("11"), "02");
        assert_eq!(
            EncounterClaimDetails::default().place_of_service_or("11"),
            "11"
        );
        assert_eq!(
            name_parts("Referrer, Synthetic"),
            ("Referrer".into(), "Synthetic".into())
        );
        assert_eq!(
            name_parts("Synthetic Supervisor"),
            ("Supervisor".into(), "Synthetic".into())
        );
    }
}
