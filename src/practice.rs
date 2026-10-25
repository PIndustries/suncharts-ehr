// SPDX-License-Identifier: AGPL-3.0-only
//! Practice work is derived from saved clinical records, never a parallel task state.
use crate::{
    auth::Actor,
    error::{Error, Result},
    State,
};
use axum::{extract::State as ExtractState, routing::get, Json, Router};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Serialize, FromRow)]
struct UnfinishedVisit {
    visit_id: Uuid,
    appointment_id: Uuid,
    patient_id: Uuid,
    mrn: String,
    patient_name: String,
    clinician_id: Uuid,
    provider_label: String,
    facility: String,
    room: String,
    starts_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    version: i64,
    note_saved: bool,
    vitals_saved: bool,
    title: String,
    #[serde(skip)]
    total: i64,
}

#[derive(Serialize)]
struct Worklist {
    items: Vec<UnfinishedVisit>,
    total: i64,
    has_more: bool,
}

pub fn router() -> Router<State> {
    Router::new().route("/api/v1/practice/worklist", get(worklist))
}

async fn worklist(ExtractState(s): ExtractState<State>, a: Actor) -> Result<Json<Worklist>> {
    a.staff()?;
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let mut tx = db.begin().await?;
    // A single snapshot keeps the total aligned with the bounded list. Do not
    // limit this to today's schedule: yesterday's unsigned work still matters.
    let items = sqlx::query_as::<_, UnfinishedVisit>(
        "SELECT v.id AS visit_id,v.appointment_id,v.patient_id,p.mrn,
         p.family_name || ', ' || p.given_name AS patient_name,
         v.clinician_id,coalesce(u.email,'Unmapped provider') AS provider_label,
         a.facility,a.room,a.starts_at,v.created_at,v.version,
         v.note IS NOT NULL AS note_saved,v.vitals IS NOT NULL AS vitals_saved,
         a.title,count(*) OVER() AS total
         FROM visits v
         JOIN patients p ON p.tenant_id=v.tenant_id AND p.id=v.patient_id
         JOIN appointments a ON a.tenant_id=v.tenant_id AND a.id=v.appointment_id
         LEFT JOIN browser_users u ON u.tenant_id=v.tenant_id AND u.id=v.clinician_id
         WHERE v.tenant_id=$1 AND v.status='in_progress'
         ORDER BY a.starts_at,v.id LIMIT 100",
    )
    .bind(a.tenant_id)
    .fetch_all(&mut *tx)
    .await?;
    crate::postgres::audit(&mut tx, &a, "practice.worklist.read", a.tenant_id).await?;
    tx.commit().await?;
    let total = items.first().map_or(0, |item| item.total);
    Ok(Json(Worklist {
        has_more: total > items.len() as i64,
        items,
        total,
    }))
}
