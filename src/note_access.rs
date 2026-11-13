// SPDX-License-Identifier: AGPL-3.0-only
//! Who may write, sign and correct a visit note.
//!
//! Drafting is shared by the practice's clinical staff. Signing and corrections are a
//! clinician's own act. A delegated support session may help draft but never signs.
//! Custom access policies are applied separately, to every request, by the route
//! middleware; these rules are the native limit they intersect with.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

type Tx<'a> = Transaction<'a, Postgres>;

/// Shown wherever a delegated support session is named in a note's history.
pub(crate) const SUPPORT_NAME: &str = "Support staff";

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct NoteAccess {
    /// Save the unsigned note and its diagnoses, and read the earlier signed note.
    pub draft: bool,
    /// Sign the note, and release or publish its patient summary.
    pub sign: bool,
    /// Append a signed correction.
    pub amend: bool,
    /// The session acts under a support grant rather than a staff account.
    pub delegated: bool,
}

/// A support session carries the Owner role with its grant as the actor. The grant is
/// never a staff account, so a matching session row identifies it whatever credential
/// presented it.
pub(crate) async fn delegated(tx: &mut Tx<'_>, a: &Actor) -> Result<bool> {
    if matches!(a.role, Role::PartnerSupport) {
        return Ok(true);
    }
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM partner_support_sessions WHERE tenant_id=$1 AND grant_id=$2)",
    )
    .bind(a.tenant_id)
    .bind(a.sub)
    .fetch_one(&mut **tx)
    .await?)
}

pub(crate) async fn note_access(tx: &mut Tx<'_>, a: &Actor) -> Result<NoteAccess> {
    let delegated = delegated(tx, a).await?;
    let clinician = matches!(a.role, Role::Owner | Role::Clinician);
    let support_role = match a.role {
        Role::Nurse => Some("nurse"),
        Role::MedicalAssistant => Some("medical_assistant"),
        _ => None,
    };
    // Recheck the live account, as rooming does: a stale credential never lets a
    // disabled or reassigned nurse or medical assistant keep writing.
    let assistant = match support_role {
        Some(role) => sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM browser_users WHERE tenant_id=$1 AND id=$2 AND role=$3 AND NOT disabled)",
        )
        .bind(a.tenant_id)
        .bind(a.sub)
        .bind(role)
        .fetch_one(&mut **tx)
        .await?,
        None => false,
    };
    Ok(NoteAccess {
        draft: clinician || assistant,
        sign: clinician && !delegated,
        amend: clinician && !delegated,
        delegated,
    })
}

pub(crate) async fn require_draft(tx: &mut Tx<'_>, a: &Actor) -> Result<()> {
    allow(note_access(tx, a).await?.draft)
}

/// Also gates the patient summary: only someone who may sign releases or publishes it.
pub(crate) async fn require_sign(tx: &mut Tx<'_>, a: &Actor) -> Result<()> {
    allow(note_access(tx, a).await?.sign)
}

pub(crate) async fn require_amend(tx: &mut Tx<'_>, a: &Actor) -> Result<()> {
    allow(note_access(tx, a).await?.amend)
}

fn allow(permitted: bool) -> Result<()> {
    if permitted {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

/// The name shown for whoever wrote, signed or corrected a note. Empty when the
/// practice has no record of the person.
pub(crate) async fn person_name(tx: &mut Tx<'_>, tenant: Uuid, id: Uuid) -> Result<String> {
    let known: Option<String> = sqlx::query_scalar(
        "SELECT COALESCE(NULLIF((SELECT pp.display_name FROM practice_providers pp WHERE pp.tenant_id=u.tenant_id AND pp.id=u.id),''),NULLIF(u.display_name,''),u.email) FROM browser_users u WHERE u.tenant_id=$1 AND u.id=$2",
    )
    .bind(tenant)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(name) = known {
        return Ok(name);
    }
    // A support session is named only while it lasts; a saved note keeps its own stamp.
    let support: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM partner_support_sessions WHERE tenant_id=$1 AND grant_id=$2)",
    )
    .bind(tenant)
    .bind(id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(if support {
        SUPPORT_NAME.into()
    } else {
        String::new()
    })
}
