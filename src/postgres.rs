// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
use crate::{
    auth::{Actor, Role},
    backend::ClinicalBackend,
    error::{Error, Result},
    model::*,
};
use async_trait::async_trait;
use chrono::Utc;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub struct PostgresBackend(pub PgPool);
type Tx<'a> = Transaction<'a, Postgres>;

pub(crate) async fn audit(tx: &mut Tx<'_>, actor: &Actor, action: &str, id: Uuid) -> Result<()> {
    // Serialize each tenant's event IDs through commit so durable stream cursors cannot
    // skip an earlier transaction that happens to commit after a later sequence ID.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))")
        .bind(actor.tenant_id.to_string())
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "INSERT INTO audit_events (tenant_id,actor_id,action,resource_id) VALUES ($1,$2,$3,$4)",
    )
    .bind(actor.tenant_id)
    .bind(actor.sub)
    .bind(action)
    .bind(id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn patient_row(tx: &mut Tx<'_>, actor: &Actor, id: Uuid) -> Result<Patient> {
    sqlx::query_as("SELECT id,mrn,given_name,family_name,birth_date FROM patients WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}

async fn lock_visit(tx: &mut Tx<'_>, actor: &Actor, id: Uuid, version: i64) -> Result<Visit> {
    actor.clinical()?;
    let v: Visit = sqlx::query_as("SELECT * FROM visits WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(actor.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)?;
    // Being a clinic owner does not grant a right to sign another clinician's documentation.
    if v.clinician_id != actor.sub {
        return Err(Error::Forbidden);
    }
    if v.version != version {
        return Err(Error::Conflict("visit changed; reload before saving"));
    }
    Ok(v)
}

pub(crate) async fn rooming_authorized(
    tx: &mut Tx<'_>,
    a: &Actor,
    clinician_id: Uuid,
) -> Result<()> {
    a.rooming()?;
    if matches!(a.role, Role::Nurse | Role::MedicalAssistant) {
        // Recheck the live account under a shared lock: stale gateway claims never
        // authorize a disabled or demoted assistant to write clinical intake.
        let expected = if matches!(a.role, Role::Nurse) {
            "nurse"
        } else {
            "medical_assistant"
        };
        let exists: Option<Uuid> = sqlx::query_scalar("SELECT id FROM browser_users WHERE tenant_id=$1 AND id=$2 AND role=$3 AND NOT disabled FOR SHARE")
            .bind(a.tenant_id).bind(a.sub).bind(expected).fetch_optional(&mut **tx).await?;
        if exists.is_none() {
            return Err(Error::Forbidden);
        }
    } else if clinician_id != a.sub {
        return Err(Error::Forbidden);
    }
    Ok(())
}

fn editable(v: &Visit) -> Result<()> {
    if v.status != "in_progress" {
        Err(Error::Conflict(
            "signed content is immutable; append an amendment",
        ))
    } else {
        Ok(())
    }
}

async fn visit_row(tx: &mut Tx<'_>, actor: &Actor, id: Uuid) -> Result<Visit> {
    sqlx::query_as("SELECT * FROM visits WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}

#[async_trait]
impl ClinicalBackend for PostgresBackend {
    async fn patients(&self, a: &Actor, after: Option<Uuid>) -> Result<PatientPage> {
        a.staff()?;
        let mut tx = self.0.begin().await?;
        let mut items:Vec<Patient>=sqlx::query_as("SELECT id,mrn,given_name,family_name,birth_date FROM patients WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 51")
            .bind(a.tenant_id).bind(after).fetch_all(&mut *tx).await?;
        let next_cursor = if items.len() > 50 {
            items.pop();
            items.last().map(|p| p.id)
        } else {
            None
        };
        audit(&mut tx, a, "patient.list", a.tenant_id).await?;
        tx.commit().await?;
        Ok(PatientPage { items, next_cursor })
    }

    async fn workspace(&self, a: &Actor, id: Uuid) -> Result<Workspace> {
        a.staff()?;
        let mut tx = self.0.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *tx)
            .await?;
        let patient = patient_row(&mut tx, a, id).await?;
        let appointments=sqlx::query_as("SELECT * FROM appointments WHERE tenant_id=$1 AND patient_id=$2 ORDER BY starts_at DESC LIMIT 100")
            .bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
        let visits=sqlx::query_as("SELECT * FROM visits WHERE tenant_id=$1 AND patient_id=$2 ORDER BY created_at DESC LIMIT 100")
            .bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
        let amendments=sqlx::query_as("SELECT a.* FROM amendments a JOIN visits v ON v.tenant_id=a.tenant_id AND v.id=a.visit_id WHERE v.tenant_id=$1 AND v.patient_id=$2 ORDER BY a.created_at,a.id")
            .bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
        audit(&mut tx, a, "workspace.read", id).await?;
        tx.commit().await?;
        Ok(Workspace {
            patient,
            appointments,
            visits,
            amendments,
        })
    }
    async fn create_patient(&self, a: &Actor, p: NewPatient) -> Result<Patient> {
        a.scheduling()?;
        text(&p.mrn, 64)?;
        text(&p.given_name, 100)?;
        text(&p.family_name, 100)?;
        if p.birth_date > Utc::now().date_naive() || p.birth_date.year() < 1800 {
            return Err(Error::Invalid("invalid birth date"));
        }
        let mut tx = self.0.begin().await?;
        let id = Uuid::new_v4();
        let p = sqlx::query_as("INSERT INTO patients (tenant_id,id,mrn,given_name,family_name,birth_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,mrn,given_name,family_name,birth_date")
            .bind(a.tenant_id).bind(id).bind(p.mrn.trim()).bind(p.given_name.trim()).bind(p.family_name.trim()).bind(p.birth_date)
            .fetch_one(&mut *tx).await?;
        crate::patient_identity::record_initial(&mut tx, a, &p, "Patient registered").await?;
        audit(&mut tx, a, "patient.create", id).await?;
        tx.commit().await?;
        Ok(p)
    }

    async fn patient(&self, a: &Actor, id: Uuid) -> Result<Patient> {
        a.staff()?;
        let mut tx = self.0.begin().await?;
        let p = patient_row(&mut tx, a, id).await?;
        audit(&mut tx, a, "patient.read", id).await?;
        tx.commit().await?;
        Ok(p)
    }

    async fn book(&self, a: &Actor, p: NewAppointment) -> Result<Appointment> {
        a.scheduling()?;
        crate::scheduling::validate_booking(&p)?;
        let mut tx = self.0.begin().await?;
        patient_row(&mut tx, a, p.patient_id).await?;
        // Serialize idempotent retries, then clinician/room availability checks.
        crate::scheduling::tenant_lock(&mut tx, a).await?;
        let digest = crate::oauth::hash(
            &serde_json::to_string(&p).map_err(|_| Error::Invalid("invalid appointment"))?,
        );
        if let Some(request) = p.request_id {
            let old: Option<(Uuid, String)> = sqlx::query_as(
                "SELECT id,request_digest FROM appointments WHERE tenant_id=$1 AND request_id=$2",
            )
            .bind(a.tenant_id)
            .bind(request)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some((id, old)) = old {
                if old != digest {
                    return Err(Error::Conflict(
                        "request ID reused with different appointment",
                    ));
                }
                return sqlx::query_as("SELECT * FROM appointments WHERE tenant_id=$1 AND id=$2")
                    .bind(a.tenant_id)
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(Into::into);
            }
        }
        if let Some(source) = p.source_history_id {
            crate::scheduling::source(&mut tx, a, p.patient_id, source).await?;
        }
        crate::scheduling::provider_locked(&mut tx, a, p.clinician_id, true).await?;
        crate::scheduling::available(
            &mut tx,
            a,
            p.clinician_id,
            p.patient_id,
            p.starts_at,
            p.ends_at,
            &p.facility,
            &p.room,
            None,
        )
        .await?;
        let id = Uuid::new_v4();
        let result = sqlx::query_as("INSERT INTO appointments (tenant_id,id,patient_id,clinician_id,starts_at,ends_at,title,category,facility,room,notes,source_history_id,request_id,request_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *")
            .bind(a.tenant_id).bind(id).bind(p.patient_id).bind(p.clinician_id).bind(p.starts_at).bind(p.ends_at).bind(p.title).bind(p.category).bind(p.facility).bind(p.room).bind(p.notes).bind(p.source_history_id).bind(p.request_id).bind(digest).fetch_one(&mut *tx).await?;
        crate::scheduling::revision(&mut tx, a, id, &p.reason).await?;
        audit(&mut tx, a, "appointment.book", id).await?;
        tx.commit().await?;
        Ok(result)
    }

    async fn check_in(&self, a: &Actor, id: Uuid) -> Result<Appointment> {
        a.scheduling()?;
        let mut tx = self.0.begin().await?;
        let row: Appointment =
            sqlx::query_as("SELECT * FROM appointments WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
                .bind(a.tenant_id)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
        if row.status != "booked" {
            return Err(Error::Conflict("only booked appointments can check in"));
        }
        let row = sqlx::query_as(
            "UPDATE appointments SET status='checked_in',version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *",
        )
        .bind(a.tenant_id)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        crate::scheduling::revision(&mut tx, a, id, "Patient checked in").await?;
        audit(&mut tx, a, "appointment.check_in", id).await?;
        tx.commit().await?;
        Ok(row)
    }

    async fn start_visit(&self, a: &Actor, input: StartVisit) -> Result<Visit> {
        a.rooming()?;
        let mut tx = self.0.begin().await?;
        let row: Appointment =
            sqlx::query_as("SELECT * FROM appointments WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
                .bind(a.tenant_id)
                .bind(input.appointment_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
        rooming_authorized(&mut tx, a, row.clinician_id).await?;
        if row.status != "checked_in" {
            return Err(Error::Conflict(
                "appointment must be checked in before starting a visit",
            ));
        }
        let id = Uuid::new_v4();
        let v = sqlx::query_as("INSERT INTO visits (tenant_id,id,patient_id,appointment_id,clinician_id) VALUES ($1,$2,$3,$4,$5) RETURNING *")
            .bind(a.tenant_id).bind(id).bind(row.patient_id).bind(row.id).bind(row.clinician_id).fetch_one(&mut *tx).await?;
        sqlx::query("UPDATE appointments SET status='in_progress',version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(row.id)
            .execute(&mut *tx)
            .await?;
        crate::scheduling::revision(&mut tx, a, row.id, "Visit started").await?;
        audit(&mut tx, a, "visit.start", id).await?;
        tx.commit().await?;
        Ok(v)
    }

    async fn visit(&self, a: &Actor, id: Uuid) -> Result<Visit> {
        a.staff()?;
        let mut tx = self.0.begin().await?;
        let v = visit_row(&mut tx, a, id).await?;
        audit(&mut tx, a, "visit.read", id).await?;
        tx.commit().await?;
        Ok(v)
    }

    async fn save_note(&self, a: &Actor, id: Uuid, version: i64, note: SoapNote) -> Result<Visit> {
        note.validate()?;
        let mut tx = self.0.begin().await?;
        let v = lock_visit(&mut tx, a, id, version).await?;
        editable(&v)?;
        sqlx::query("UPDATE visits SET note=$3, version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .bind(serde_json::to_value(note).expect("serializable SOAP"))
            .execute(&mut *tx)
            .await?;
        let v = visit_row(&mut tx, a, id).await?;
        audit(&mut tx, a, "visit.note_save", id).await?;
        tx.commit().await?;
        Ok(v)
    }

    async fn save_vitals(
        &self,
        a: &Actor,
        id: Uuid,
        version: i64,
        vitals: Vitals,
    ) -> Result<Visit> {
        a.rooming()?;
        vitals.validate()?;
        let mut tx = self.0.begin().await?;
        let v: Visit =
            sqlx::query_as("SELECT * FROM visits WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
                .bind(a.tenant_id)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
        rooming_authorized(&mut tx, a, v.clinician_id).await?;
        if v.version != version {
            return Err(Error::Conflict("visit changed; reload before saving"));
        }
        editable(&v)?;
        sqlx::query("UPDATE visits SET vitals=$3, version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .bind(serde_json::to_value(vitals).expect("serializable vitals"))
            .execute(&mut *tx)
            .await?;
        let v = visit_row(&mut tx, a, id).await?;
        crate::rooming::record_vitals_revision(&mut tx, a, &v).await?;
        audit(&mut tx, a, "visit.vitals_save", id).await?;
        tx.commit().await?;
        Ok(v)
    }

    async fn sign(&self, a: &Actor, id: Uuid, version: i64) -> Result<Visit> {
        let mut tx = self.0.begin().await?;
        let v = lock_visit(&mut tx, a, id, version).await?;
        editable(&v)?;
        let note: SoapNote = serde_json::from_value(v.note.ok_or(Error::Conflict(
            "a complete SOAP note is required before signing",
        ))?)
        .map_err(|_| Error::Conflict("invalid SOAP note"))?;
        note.validate()?;
        sqlx::query("UPDATE visits SET status='signed',signed_by=$3,signed_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id).bind(id).bind(a.sub).execute(&mut *tx).await?;
        sqlx::query("UPDATE appointments SET status='completed',version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(v.appointment_id)
            .execute(&mut *tx)
            .await?;
        let v = visit_row(&mut tx, a, id).await?;
        crate::scheduling::revision(&mut tx, a, v.appointment_id, "Visit signed and completed")
            .await?;
        audit(&mut tx, a, "visit.sign", id).await?;
        tx.commit().await?;
        Ok(v)
    }

    async fn amend(&self, a: &Actor, id: Uuid, version: i64, input: NewAmendment) -> Result<Visit> {
        text(&input.reason, 1000)?;
        text(&input.text, 10000)?;
        let mut tx = self.0.begin().await?;
        let v = lock_visit(&mut tx, a, id, version).await?;
        if v.status != "signed" {
            return Err(Error::Conflict("only signed visits can be amended"));
        }
        sqlx::query("INSERT INTO amendments (tenant_id,id,visit_id,author_id,reason,text) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(a.tenant_id).bind(Uuid::new_v4()).bind(id).bind(a.sub).bind(input.reason.trim()).bind(input.text.trim()).execute(&mut *tx).await?;
        sqlx::query("UPDATE visits SET version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let v = visit_row(&mut tx, a, id).await?;
        audit(&mut tx, a, "visit.amend", id).await?;
        tx.commit().await?;
        Ok(v)
    }

    async fn record(&self, a: &Actor, id: Uuid) -> Result<Record> {
        if matches!(a.role, Role::Patient) && a.patient_id != Some(id) {
            return Err(Error::NotFound);
        }
        let mut tx = self.0.begin().await?;
        // One consistent snapshot across patient, signed visits and their amendments.
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *tx)
            .await?;
        let patient = patient_row(&mut tx, a, id).await?;
        let visits = sqlx::query_as("SELECT * FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND status='signed' ORDER BY signed_at,id")
            .bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
        let amendments = sqlx::query_as("SELECT a.* FROM amendments a JOIN visits v ON v.tenant_id=a.tenant_id AND v.id=a.visit_id WHERE v.tenant_id=$1 AND v.patient_id=$2 AND v.status='signed' ORDER BY a.created_at,a.id")
            .bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
        audit(&mut tx, a, "record.read", id).await?;
        tx.commit().await?;
        Ok(Record {
            patient,
            visits,
            amendments,
        })
    }
}

use chrono::Datelike;
