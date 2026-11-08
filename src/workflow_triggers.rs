// SPDX-License-Identifier: AGPL-3.0-only
//! Durable native event to published pathway handoff. This starts work only;
//! clinical, communication and financial actions retain their native gates.
use crate::{
    auth::{Actor, Role},
    care_pathways::NativeTriggerInput,
    error::{Error, Result},
};
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub(crate) fn trigger_type(event: &str) -> Option<&'static str> {
    Some(match event {
        "suncharts.appointment.created" => "appointment_created",
        "suncharts.appointment.rescheduled" => "appointment_rescheduled",
        "suncharts.appointment.cancelled" => "appointment_cancelled",
        "suncharts.appointment.checked_in" => "patient_checked_in",
        "suncharts.visit.signed" => "visit_signed",
        "suncharts.referral.created" => "referral_received",
        "suncharts.referral.status_changed" => "referral_status_changed",
        "suncharts.intake.email_linked" => "email_received",
        "suncharts.intake.call_linked" => "call_received",
        "suncharts.intake.sms_linked" => "sms_received",
        "suncharts.intake.fax_linked" => "fax_received",
        "suncharts.intake.inquiry_linked" => "inquiry_received",
        "suncharts.eligibility.returned" => "eligibility_returned",
        _ => return None,
    })
}

pub(crate) async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    event: Uuid,
    name: &str,
) -> Result<()> {
    let Some(kind) = trigger_type(name) else {
        return Ok(());
    };
    let rows:Vec<(Uuid,i64)>=sqlx::query_as("SELECT id,version FROM care_pathway_definitions WHERE tenant_id=$1 AND status='active' AND trigger_type=$2 ORDER BY id FOR SHARE")
        .bind(actor.tenant_id).bind(kind).fetch_all(&mut **tx).await?;
    for (definition, version) in rows {
        sqlx::query("INSERT INTO workflow_native_starts(tenant_id,id,event_id,definition_id,definition_version,trigger_type) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,event_id,definition_id) DO NOTHING")
            .bind(actor.tenant_id).bind(Uuid::new_v4()).bind(event).bind(definition).bind(version).bind(kind).execute(&mut **tx).await?;
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Pending {
    tenant_id: Uuid,
    id: Uuid,
    event_id: Uuid,
    definition_id: Uuid,
    definition_version: i64,
    trigger_type: String,
    attempts: i32,
}
fn identifier(payload: &Value, key: &str) -> Option<Uuid> {
    payload[key].as_str().and_then(|v| Uuid::parse_str(v).ok())
}
fn worker_actor(tenant_id: Uuid) -> Actor {
    let now = Utc::now().timestamp();
    Actor {
        sub: Uuid::from_u128(0x53c40000000040008000000000000034),
        tenant_id,
        role: Role::Owner,
        patient_id: None,
        iss: "suncharts-native-workflow".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    }
}

/// Bounded one-batch operation also used by the synthetic workflow fixture.
pub async fn tick(pool: &PgPool) -> Result<usize> {
    let mut tx = pool.begin().await?;
    let exhausted:Vec<(Uuid,Uuid)>=sqlx::query_as("UPDATE workflow_native_starts SET status='failed',last_error='Retry limit reached after worker interruption',lease_until=NULL,lease_token=NULL,completed_at=now() WHERE status='processing' AND lease_until<now() AND attempts>=5 RETURNING tenant_id,id").fetch_all(&mut *tx).await?;
    for (tenant, id) in exhausted {
        crate::postgres::audit(
            &mut tx,
            &worker_actor(tenant),
            "workflow.native_event_failed",
            id,
        )
        .await?;
    }
    tx.commit().await?;
    let lease = Uuid::new_v4();
    let rows:Vec<Pending>=sqlx::query_as("WITH candidates AS (SELECT tenant_id,id FROM workflow_native_starts WHERE (status='pending' OR (status='processing' AND lease_until<now())) AND attempts<5 ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED) UPDATE workflow_native_starts s SET status='processing',attempts=s.attempts+1,lease_until=now()+interval '90 seconds',lease_token=$1 FROM candidates c WHERE s.tenant_id=c.tenant_id AND s.id=c.id RETURNING s.tenant_id,s.id,s.event_id,s.definition_id,s.definition_version,s.trigger_type,s.attempts")
        .bind(lease).fetch_all(pool).await?;
    let count = rows.len();
    for row in rows {
        let actor = worker_actor(row.tenant_id);
        let payload:Option<Value>=sqlx::query_scalar("SELECT payload FROM automation_events WHERE tenant_id=$1 AND id=$2 AND payload_erased_at IS NULL")
            .bind(row.tenant_id).bind(row.event_id).fetch_optional(pool).await?;
        let outcome = if let Some(payload) = payload {
            if identifier(&payload, "patient_id").is_none() {
                Ok(json!({"items":[]}))
            } else {
                crate::care_pathways::trigger_native(
                    pool,
                    &actor,
                    NativeTriggerInput {
                        request_id: row.id,
                        trigger_type: row.trigger_type,
                        trigger_key: format!("automation-event:{}", row.event_id),
                        definition_id: Some(row.definition_id),
                        expected_definition_version: Some(row.definition_version),
                        patient_id: identifier(&payload, "patient_id"),
                        appointment_id: identifier(&payload, "appointment_id"),
                        visit_id: identifier(&payload, "visit_id"),
                        context: payload,
                        reason: "Started from a native event using the published workflow revision"
                            .into(),
                    },
                )
                .await
            }
        } else {
            Ok(json!({"items":[]}))
        };
        let (status, error) = match outcome {
            Ok(value) if value["items"].as_array().is_some_and(|v| !v.is_empty()) => {
                ("completed", None)
            }
            Ok(_) => ("superseded", Some("event_context_unavailable")),
            Err(Error::NotFound) => ("superseded", Some("published_definition_changed")),
            Err(_) => (
                if row.attempts >= 5 {
                    "failed"
                } else {
                    "pending"
                },
                Some("workflow_start_failed"),
            ),
        };
        let mut tx = pool.begin().await?;
        let changed=sqlx::query("UPDATE workflow_native_starts SET status=$4,last_error=$5,lease_until=NULL,lease_token=NULL,completed_at=CASE WHEN $4 IN ('completed','superseded','failed') THEN now() ELSE NULL END WHERE tenant_id=$1 AND id=$2 AND lease_token=$3")
            .bind(row.tenant_id).bind(row.id).bind(lease).bind(status).bind(error).execute(&mut *tx).await?;
        if changed.rows_affected() == 1 {
            crate::postgres::audit(&mut tx, &actor, "workflow.native_event_processed", row.id)
                .await?;
        }
        tx.commit().await?;
    }
    Ok(count)
}
pub async fn run(pool: PgPool) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
    loop {
        interval.tick().await;
        let _ = tick(&pool).await;
    }
}
