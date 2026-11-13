// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
use crate::error::{Error, Result};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewPatient {
    // Accepted by the reviewed source-migration model; routine registration rejects it.
    #[serde(default)]
    pub mrn: Option<String>,
    pub given_name: String,
    pub family_name: String,
    pub birth_date: NaiveDate,
}

pub fn text(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.chars().count() > max {
        Err(Error::Invalid("text is empty or too long"))
    } else {
        Ok(())
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Patient {
    /// Derived from append-only lifecycle events; existing identity rows remain intact.
    #[sqlx(default)]
    pub archived: bool,
    pub id: Uuid,
    pub mrn: String,
    pub given_name: String,
    pub family_name: String,
    pub birth_date: NaiveDate,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NewAppointment {
    pub request_id: Option<Uuid>,
    pub source_history_id: Option<Uuid>,
    #[serde(default = "office_visit")]
    pub title: String,
    #[serde(default = "office_visit")]
    pub category: String,
    #[serde(default)]
    pub facility: String,
    #[serde(default)]
    pub room: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "booking_reason")]
    pub reason: String,
    pub patient_id: Uuid,
    pub clinician_id: Uuid,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
}

fn office_visit() -> String {
    "Office visit".into()
}
fn booking_reason() -> String {
    "Appointment booked".into()
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Appointment {
    pub version: i64,
    pub title: String,
    pub category: String,
    pub facility: String,
    pub room: String,
    pub notes: String,
    pub source_history_id: Option<Uuid>,
    pub id: Uuid,
    pub patient_id: Uuid,
    pub clinician_id: Uuid,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartVisit {
    pub appointment_id: Uuid,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Visit {
    pub id: Uuid,
    pub patient_id: Uuid,
    pub appointment_id: Uuid,
    pub clinician_id: Uuid,
    pub status: String,
    pub version: i64,
    pub note: Option<Value>,
    pub vitals: Option<Value>,
    pub signed_by: Option<Uuid>,
    pub signed_at: Option<DateTime<Utc>>,
}

/// The free-text sections of a visit note, in the order they are shown.
pub const NOTE_SECTIONS: [&str; 5] = ["subjective", "objective", "assessment", "plan", "procedure"];

/// Where an in-progress note's starting text came from. The earlier signed note is
/// only read; this record stays with the new note so a reviewer can see its origin.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NoteSource {
    pub visit_id: Uuid,
    /// Version of the earlier visit when its text was brought in.
    pub version: i64,
    /// Sections whose text was brought in, in note order.
    pub sections: Vec<String>,
    /// Service date of the earlier visit. Set by the server; client values are ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visit_date: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SoapNote {
    pub subjective: String,
    pub objective: String,
    pub assessment: String,
    pub plan: String,
    /// Optional fifth section. Absent from stored JSON when empty, so notes written
    /// before it existed and notes that do not use it have the same shape.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub procedure: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_from: Option<NoteSource>,
}
impl SoapNote {
    pub fn validate(&self) -> Result<()> {
        for v in [
            &self.subjective,
            &self.objective,
            &self.assessment,
            &self.plan,
        ] {
            text(v, 10000)?;
        }
        if self.procedure.chars().count() > 10000 {
            return Err(Error::Invalid("text is empty or too long"));
        }
        if let Some(source) = &self.started_from {
            let known = source
                .sections
                .iter()
                .all(|section| NOTE_SECTIONS.contains(&section.as_str()));
            let unique = source
                .sections
                .iter()
                .enumerate()
                .all(|(i, section)| !source.sections[..i].contains(section));
            if source.version < 1 || source.sections.is_empty() || !known || !unique {
                return Err(Error::Invalid("invalid earlier-note reference"));
            }
        }
        Ok(())
    }
}

/// Text of the most recent earlier signed note, offered for "Same as last visit".
#[derive(Debug, Serialize)]
pub struct PreviousNote {
    pub source: Option<PreviousNoteSource>,
}

#[derive(Debug, Serialize)]
pub struct PreviousNoteSource {
    pub visit_id: Uuid,
    pub version: i64,
    pub visit_date: DateTime<Utc>,
    pub signed_at: Option<DateTime<Utc>>,
    pub clinician_id: Uuid,
    pub clinician_name: String,
    pub same_clinician: bool,
    pub note: PreviousNoteText,
}

#[derive(Debug, Default, Serialize)]
pub struct PreviousNoteText {
    pub subjective: String,
    pub objective: String,
    pub assessment: String,
    pub plan: String,
    pub procedure: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Vitals {
    pub systolic_mm_hg: u16,
    pub diastolic_mm_hg: u16,
    pub heart_rate_bpm: u16,
    pub temperature_c: f64,
    pub weight_kg: f64,
    pub height_cm: f64,
    pub oxygen_saturation_pct: f64,
}
impl Vitals {
    pub fn validate(&self) -> Result<()> {
        if !(30..=350).contains(&self.systolic_mm_hg)
            || !(10..=250).contains(&self.diastolic_mm_hg)
            || self.systolic_mm_hg <= self.diastolic_mm_hg
            || !(10..=350).contains(&self.heart_rate_bpm)
            || !(20.0..=50.0).contains(&self.temperature_c)
            || !(0.1..=700.0).contains(&self.weight_kg)
            || !(10.0..=300.0).contains(&self.height_cm)
            || !(0.0..=100.0).contains(&self.oxygen_saturation_pct)
        {
            return Err(Error::Invalid("vitals outside supported recording ranges"));
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewAmendment {
    pub reason: String,
    pub text: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Amendment {
    pub id: Uuid,
    pub visit_id: Uuid,
    pub author_id: Uuid,
    pub reason: String,
    pub text: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct Record {
    pub patient: Patient,
    pub visits: Vec<Visit>,
    pub amendments: Vec<Amendment>,
}

#[derive(Debug, Serialize)]
pub struct PatientPage {
    pub items: Vec<Patient>,
    pub next_cursor: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct Workspace {
    pub patient: Patient,
    pub appointments: Vec<Appointment>,
    pub visits: Vec<Visit>,
    pub amendments: Vec<Amendment>,
}
