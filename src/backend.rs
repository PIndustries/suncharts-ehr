// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Clinical contract. Transport and clients do not depend on a storage schema or EHR vocabulary.
//! Existing source system operations remain behind the SunCharts connector; this native implementation
//! is opted into over HTTP, never linked into the proprietary SunCharts server.
use crate::{auth::Actor, error::Result, model::*};
use async_trait::async_trait;
use uuid::Uuid;

#[async_trait]
pub trait ClinicalBackend: Send + Sync {
    async fn patients(
        &self,
        actor: &Actor,
        after: Option<Uuid>,
        status: crate::patient_lifecycle::PatientStatus,
    ) -> Result<PatientPage>;
    async fn workspace(&self, actor: &Actor, id: Uuid) -> Result<Workspace>;
    async fn create_patient(&self, actor: &Actor, input: NewPatient) -> Result<Patient>;
    async fn patient(&self, actor: &Actor, id: Uuid) -> Result<Patient>;
    async fn book(&self, actor: &Actor, input: NewAppointment) -> Result<Appointment>;
    async fn check_in(&self, actor: &Actor, id: Uuid) -> Result<Appointment>;
    async fn start_visit(&self, actor: &Actor, input: StartVisit) -> Result<Visit>;
    async fn visit(&self, actor: &Actor, id: Uuid) -> Result<Visit>;
    async fn save_note(
        &self,
        actor: &Actor,
        id: Uuid,
        version: i64,
        input: SoapNote,
    ) -> Result<Visit>;
    /// Text of the patient's most recent earlier signed note, for anyone who may draft.
    async fn previous_note(&self, actor: &Actor, id: Uuid) -> Result<PreviousNote>;
    /// Who the visit is assigned to, who last saved, signed and corrected its note,
    /// and what the caller may do with it. No note text.
    async fn note_authorship(&self, actor: &Actor, id: Uuid) -> Result<serde_json::Value>;
    async fn save_vitals(
        &self,
        actor: &Actor,
        id: Uuid,
        version: i64,
        input: Vitals,
    ) -> Result<Visit>;
    async fn sign(&self, actor: &Actor, id: Uuid, version: i64) -> Result<Visit>;
    async fn amend(
        &self,
        actor: &Actor,
        id: Uuid,
        version: i64,
        input: NewAmendment,
    ) -> Result<Visit>;
    async fn record(&self, actor: &Actor, patient_id: Uuid) -> Result<Record>;
}
