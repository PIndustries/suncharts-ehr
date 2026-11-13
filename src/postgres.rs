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
    sqlx::query_as("SELECT p.id,p.mrn,p.given_name,p.family_name,p.birth_date,coalesce((SELECT archived FROM patient_lifecycle_events e WHERE e.tenant_id=p.tenant_id AND e.patient_id=p.id ORDER BY version DESC LIMIT 1),false) AS archived FROM patients p WHERE p.tenant_id=$1 AND p.id=$2")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}

#[derive(Clone, Copy)]
enum NoteAction {
    Draft,
    Sign,
    Amend,
}

/// Locks the visit for one note action. The visit does not have to be assigned to the
/// actor: clinical staff share drafting, and any clinician or the owner may sign or
/// correct. The version check keeps two writers from overwriting each other.
async fn lock_visit(
    tx: &mut Tx<'_>,
    actor: &Actor,
    id: Uuid,
    version: i64,
    action: NoteAction,
) -> Result<Visit> {
    actor.rooming()?;
    let v: Visit = sqlx::query_as("SELECT * FROM visits WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(actor.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)?;
    match action {
        NoteAction::Draft => crate::note_access::require_draft(tx, actor).await?,
        NoteAction::Sign => crate::note_access::require_sign(tx, actor).await?,
        NoteAction::Amend => crate::note_access::require_amend(tx, actor).await?,
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

/// Intake and vitals on a started visit: rooming staff, the assigned clinician, and a
/// clinician or the owner covering the visit. Starting a visit keeps `rooming_authorized`.
/// A delegated support session is not a clinician of the practice.
pub(crate) async fn intake_authorized(
    tx: &mut Tx<'_>,
    a: &Actor,
    clinician_id: Uuid,
) -> Result<()> {
    if matches!(a.role, Role::Owner | Role::Clinician) && a.sub != clinician_id {
        return if crate::note_access::delegated(tx, a).await? {
            Err(Error::Forbidden)
        } else {
            Ok(())
        };
    }
    rooming_authorized(tx, a, clinician_id).await
}

type PreviousNoteRow = (
    Uuid,
    i64,
    Option<serde_json::Value>,
    Uuid,
    Option<chrono::DateTime<Utc>>,
    chrono::DateTime<Utc>,
    String,
);

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
    async fn patients(
        &self,
        a: &Actor,
        after: Option<Uuid>,
        status: crate::patient_lifecycle::PatientStatus,
    ) -> Result<PatientPage> {
        a.staff()?;
        let mut tx = self.0.begin().await?;
        let mut items:Vec<Patient>=sqlx::query_as("SELECT p.id,p.mrn,p.given_name,p.family_name,p.birth_date,coalesce(e.archived,false) AS archived FROM patients p LEFT JOIN LATERAL (SELECT archived FROM patient_lifecycle_events WHERE tenant_id=p.tenant_id AND patient_id=p.id ORDER BY version DESC LIMIT 1) e ON true WHERE p.tenant_id=$1 AND ($2::uuid IS NULL OR p.id>$2) AND ($3::boolean IS NULL OR coalesce(e.archived,false)=$3) ORDER BY p.id LIMIT 51")
            .bind(a.tenant_id).bind(after).bind(status.archived()).fetch_all(&mut *tx).await?;
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
        if p.mrn.is_some() {
            return Err(Error::Invalid(
                "MRN is assigned by the system; omit it when registering a patient",
            ));
        }
        text(&p.given_name, 100)?;
        text(&p.family_name, 100)?;
        if p.birth_date > Utc::now().date_naive() || p.birth_date.year() < 1800 {
            return Err(Error::Invalid("invalid birth date"));
        }
        let mut tx = self.0.begin().await?;
        let id = Uuid::new_v4();
        // Routine registration assigns a stable identifier. Source migrations
        // preserve established identifiers through their reviewed import path.
        let mrn = format!("SC-{}", id.simple().to_string()[..12].to_ascii_uppercase());
        let p = sqlx::query_as("INSERT INTO patients (tenant_id,id,mrn,given_name,family_name,birth_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,mrn,given_name,family_name,birth_date")
            .bind(a.tenant_id).bind(id).bind(mrn).bind(p.given_name.trim()).bind(p.family_name.trim()).bind(p.birth_date)
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
        crate::patient_lifecycle::require_active(&mut tx, a, p.patient_id).await?;
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
        crate::scheduling::emit_appointment_event(
            &mut tx,
            a,
            &result,
            "suncharts.appointment.created",
        )
        .await?;
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
        crate::scheduling::emit_appointment_event(
            &mut tx,
            a,
            &row,
            "suncharts.appointment.checked_in",
        )
        .await?;
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
        crate::patient_lifecycle::require_active(&mut tx, a, row.patient_id).await?;
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

    async fn save_note(
        &self,
        a: &Actor,
        id: Uuid,
        version: i64,
        mut note: SoapNote,
    ) -> Result<Visit> {
        note.validate()?;
        if note.procedure.trim().is_empty() {
            note.procedure.clear();
        }
        let mut tx = self.0.begin().await?;
        let v = lock_visit(&mut tx, a, id, version, NoteAction::Draft).await?;
        editable(&v)?;
        // Every save names its writer. A support session is named as such, never as staff.
        let support = crate::note_access::delegated(&mut tx, a).await?;
        note.saved_by = Some(NoteSaved {
            id: a.sub,
            name: if support {
                crate::note_access::SUPPORT_NAME.into()
            } else {
                crate::note_access::person_name(&mut tx, a.tenant_id, a.sub).await?
            },
            at: Utc::now(),
            support,
        });
        let recorded = v
            .note
            .as_ref()
            .and_then(|saved| saved.get("started_from"))
            .cloned();
        if let Some(source) = note.started_from.as_mut() {
            // Only a signed note of this same patient in this practice can be named.
            let earlier: Option<(i64, chrono::DateTime<Utc>)> = sqlx::query_as("SELECT s.version,ap.starts_at FROM visits s JOIN appointments ap ON ap.tenant_id=s.tenant_id AND ap.id=s.appointment_id WHERE s.tenant_id=$1 AND s.id=$2 AND s.patient_id=$3 AND s.id<>$4 AND s.status='signed'")
                .bind(a.tenant_id)
                .bind(source.visit_id)
                .bind(v.patient_id)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
            let (current, visit_date) = earlier.ok_or(Error::Invalid(
                "the earlier note must be a signed note for this patient",
            ))?;
            if source.version > current {
                return Err(Error::Invalid("invalid earlier-note reference"));
            }
            source.visit_date = Some(visit_date);
            source.sections = NOTE_SECTIONS
                .iter()
                .filter(|section| source.sections.iter().any(|s| s == *section))
                .map(|section| section.to_string())
                .collect();
        }
        let started_from = note
            .started_from
            .as_ref()
            .map(|source| serde_json::to_value(source).expect("serializable note source"));
        sqlx::query("UPDATE visits SET note=$3, version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .bind(serde_json::to_value(note).expect("serializable SOAP"))
            .execute(&mut *tx)
            .await?;
        let v = visit_row(&mut tx, a, id).await?;
        audit(&mut tx, a, "visit.note_save", id).await?;
        if a.sub != v.clinician_id {
            audit(&mut tx, a, "visit.note_save_for_assigned", id).await?;
        }
        if started_from.is_some() && started_from != recorded {
            audit(&mut tx, a, "visit.note_started_from_earlier", id).await?;
        }
        tx.commit().await?;
        Ok(v)
    }

    async fn previous_note(&self, a: &Actor, id: Uuid) -> Result<PreviousNote> {
        a.rooming()?;
        let mut tx = self.0.begin().await?;
        let v = visit_row(&mut tx, a, id).await?;
        // The same rule as writing the note: anyone who may draft may read the earlier one.
        crate::note_access::require_draft(&mut tx, a).await?;
        // Signed notes only, same patient and practice, not later than this visit. The
        // assigned clinician's own notes come first; otherwise the newest by anyone.
        let rows: Vec<PreviousNoteRow> = sqlx::query_as("SELECT s.id,s.version,s.note,s.clinician_id,s.signed_at,ap.starts_at,COALESCE(NULLIF(pp.display_name,''),NULLIF(u.display_name,''),'') FROM visits s JOIN appointments ap ON ap.tenant_id=s.tenant_id AND ap.id=s.appointment_id JOIN appointments cur ON cur.tenant_id=s.tenant_id AND cur.id=$4 LEFT JOIN practice_providers pp ON pp.tenant_id=s.tenant_id AND pp.id=s.clinician_id LEFT JOIN browser_users u ON u.tenant_id=s.tenant_id AND u.id=s.clinician_id WHERE s.tenant_id=$1 AND s.patient_id=$2 AND s.id<>$3 AND s.status='signed' AND ap.starts_at<=cur.starts_at ORDER BY (s.clinician_id=$5) DESC,ap.starts_at DESC,s.signed_at DESC,s.id LIMIT 20")
            .bind(a.tenant_id)
            .bind(v.patient_id)
            .bind(id)
            .bind(v.appointment_id)
            .bind(v.clinician_id)
            .fetch_all(&mut *tx)
            .await?;
        let source = rows.into_iter().find_map(
            |(visit_id, version, note, clinician_id, signed_at, visit_date, clinician_name)| {
                // Only the note text is offered. Vitals, diagnoses, orders and charges
                // live outside the note and are never part of this response.
                let section = |key: &str| {
                    note.as_ref()
                        .and_then(|n| n.get(key))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_owned()
                };
                let text = PreviousNoteText {
                    subjective: section("subjective"),
                    objective: section("objective"),
                    assessment: section("assessment"),
                    plan: section("plan"),
                    procedure: section("procedure"),
                };
                let blank = [
                    &text.subjective,
                    &text.objective,
                    &text.assessment,
                    &text.plan,
                    &text.procedure,
                ]
                .iter()
                .all(|value| value.trim().is_empty());
                (!blank).then_some(PreviousNoteSource {
                    visit_id,
                    version,
                    visit_date,
                    signed_at,
                    clinician_id,
                    clinician_name,
                    same_clinician: clinician_id == v.clinician_id,
                    own: clinician_id == a.sub,
                    note: text,
                })
            },
        );
        audit(
            &mut tx,
            a,
            "visit.previous_note.read",
            source.as_ref().map_or(id, |found| found.visit_id),
        )
        .await?;
        tx.commit().await?;
        Ok(PreviousNote { source })
    }

    async fn note_authorship(&self, a: &Actor, id: Uuid) -> Result<serde_json::Value> {
        a.staff()?;
        let mut tx = self.0.begin().await?;
        let v = visit_row(&mut tx, a, id).await?;
        let access = crate::note_access::note_access(&mut tx, a).await?;
        // A custom access policy can only take these away, never add to them.
        let edit = crate::access_policies::allows(&mut tx, a, "clinical", "edit").await?;
        let create = crate::access_policies::allows(&mut tx, a, "clinical", "create").await?;
        let signed = v.status == "signed";
        let assigned =
            crate::note_access::person_name(&mut tx, a.tenant_id, v.clinician_id).await?;
        let signer = match v.signed_by {
            Some(by) => {
                serde_json::json!({"id":by,"name":crate::note_access::person_name(&mut tx, a.tenant_id, by).await?,"at":v.signed_at})
            }
            None => serde_json::Value::Null,
        };
        let authors: Vec<(Uuid, Uuid, chrono::DateTime<Utc>)> = sqlx::query_as("SELECT id,author_id,created_at FROM amendments WHERE tenant_id=$1 AND visit_id=$2 ORDER BY created_at,id")
            .bind(a.tenant_id)
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
        let mut amendments = Vec::with_capacity(authors.len());
        for (amendment, author, created_at) in authors {
            amendments.push(serde_json::json!({"id":amendment,"author_id":author,"author_name":crate::note_access::person_name(&mut tx, a.tenant_id, author).await?,"created_at":created_at}));
        }
        audit(&mut tx, a, "visit.note_authorship.read", id).await?;
        tx.commit().await?;
        Ok(serde_json::json!({
            "visit_id":v.id,
            "version":v.version,
            "status":v.status,
            "assigned":{"id":v.clinician_id,"name":assigned},
            "is_assigned":v.clinician_id == a.sub,
            "last_saved":v.note.as_ref().and_then(|note| note.get("saved_by")).cloned(),
            "signed":signer,
            "amendments":amendments,
            "delegated":access.delegated,
            "can_draft":!signed && access.draft && edit,
            "can_sign":!signed && access.sign && edit,
            "can_amend":signed && access.amend && create,
        }))
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
        intake_authorized(&mut tx, a, v.clinician_id).await?;
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
        let v = lock_visit(&mut tx, a, id, version, NoteAction::Sign).await?;
        editable(&v)?;
        let assigned = v.clinician_id;
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
        crate::automation_event_runtime::emit_in_tx(&mut tx, a,
            crate::automation_event_runtime::NewAutomationEvent {
                event_type: "suncharts.visit.signed".into(),
                source: "suncharts.visits".into(),
                source_event_id: format!("{}:{}", v.id, v.version),
                payload: serde_json::json!({"patient_id":v.patient_id,"appointment_id":v.appointment_id,"visit_id":v.id,"version":v.version}),
                classification: "phi".into(), occurred_at: chrono::Utc::now(), retention_days: 30,
            }).await?;
        audit(&mut tx, a, "visit.sign", id).await?;
        if a.sub != assigned {
            // The signer is recorded as themselves. The visit stays assigned as it was.
            audit(&mut tx, a, "visit.sign_for_assigned", id).await?;
        }
        tx.commit().await?;
        Ok(v)
    }

    async fn amend(&self, a: &Actor, id: Uuid, version: i64, input: NewAmendment) -> Result<Visit> {
        text(&input.reason, 1000)?;
        text(&input.text, 10000)?;
        let mut tx = self.0.begin().await?;
        let v = lock_visit(&mut tx, a, id, version, NoteAction::Amend).await?;
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
        let mut visits: Vec<Visit> = sqlx::query_as("SELECT * FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND status='signed' ORDER BY signed_at,id")
            .bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
        if matches!(a.role, Role::Patient) {
            // Who typed the draft is the practice's own working record. The patient's
            // copy carries the note as signed, its signer and its amendments.
            for visit in &mut visits {
                if let Some(note) = visit.note.as_mut().and_then(|note| note.as_object_mut()) {
                    note.remove("saved_by");
                }
            }
        }
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
