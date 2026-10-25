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
    pub mrn: String,
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SoapNote {
    pub subjective: String,
    pub objective: String,
    pub assessment: String,
    pub plan: String,
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
        Ok(())
    }
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
