// SPDX-License-Identifier: AGPL-3.0-only
//! Charging a card the patient saved earlier, without the patient being here.
//!
//! A saved-card charge is an ordinary copay or invoice card attempt with
//! `channel = 'saved_card'`: it lives in the same tables as hosted checkout and reader payments
//! and is posted by the same code, under the same rule for "paid". This module only adds what a
//! saved card needs: the rule for which cards may be charged later, sending the charge, and
//! recording how it ended.
//!
//! Only a card saved with the patient's agreement to later charges can be charged. Cards saved
//! before that agreement existed were saved for use with the patient present and are refused
//! here; SunCharts Connect refuses them again from its own record.
//!
//! A charge always ends by itself: it is paid, or it is closed (`expired`) because the bank
//! declined it, the bank wants the patient to confirm it, or the card could not be used. It is
//! closed only after SunCharts Connect reports the payment as cancelled at Stripe or as never
//! created, so an approved charge is recorded as paid rather than lost.
//!
//! Nothing about the patient is sent to SunCharts Connect or Stripe: only the amount, the
//! patient's opaque identifier, the card setup's identifier and this attempt's own identifier.
use crate::{
    auth::Actor,
    copay_checkout::{self as hosted, Binding, Broker, EvidenceBinding, Policy, Reply},
    error::{Error, Result},
    reader_payments::Kind,
};
use axum::http::Method;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

/// What a patient agrees to when saving a card from now on.
pub(crate) const CONSENT_SCOPE: &str = "later_charges";
/// The version of the wording shown on the card page. SunCharts Connect holds the same text
/// under the same version and shows it above the Save button.
pub(crate) const CONSENT_VERSION: &str = "card_on_file_2026_11";
pub(crate) const CONSENT_WORDING: &str = "By saving your card, you agree that this practice may charge it later for amounts you owe, such as copays, visit balances and payment plan payments, without asking you to enter your card again. You can ask the practice to remove your card at any time.";

pub(crate) const NOT_ELIGIBLE: &str =
    "This card was saved for in-person use. Ask the patient to save it again to charge it later.";
const OTHER_ACCOUNT: &str =
    "This card cannot be charged with the current payment account. Ask the patient to save it again.";

/// A charge is only sent in the first minutes after staff ask for it. After that the attempt is
/// read back, never sent again, so an old request cannot charge a card long after the fact.
const SEND_WINDOW_SECONDS: i64 = 600;

/// The one rule for charging a card later: the card setup belongs to this patient and payment
/// account, the processor confirmed the saved card, and the patient agreed to later charges.
pub(crate) async fn eligible_setup(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    patient: Uuid,
    setup: Uuid,
    binding: &Binding,
    account: &str,
    live: bool,
) -> Result<()> {
    #[derive(sqlx::FromRow)]
    struct Saved {
        consent_scope: String,
        status: String,
        setting_id: Uuid,
        installation_id: Uuid,
        provider_account_id: String,
        livemode: bool,
        payment_method: Option<String>,
    }
    let saved: Saved = sqlx::query_as("SELECT consent_scope,status,setting_id,installation_id,provider_account_id,livemode,provider_evidence->'session'->>'payment_method_id' AS payment_method FROM patient_payment_setups WHERE tenant_id=$1 AND patient_id=$2 AND request_id=$3")
        .bind(tenant)
        .bind(patient)
        .bind(setup)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)?;
    if saved.consent_scope != CONSENT_SCOPE {
        return Err(Error::Conflict(NOT_ELIGIBLE));
    }
    if saved.status != "succeeded"
        || saved.payment_method.is_none()
        || saved.setting_id != binding.setting
        || saved.installation_id != binding.installation
        || saved.provider_account_id != account
        || saved.livemode != live
    {
        return Err(Error::Conflict(OTHER_ACCOUNT));
    }
    Ok(())
}

/// For each card that may be charged later: the saved payment method and the card setup that
/// carries the patient's agreement. A card missing here was saved for in-person use.
pub(crate) async fn chargeable_cards(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    patient: Uuid,
    setting: Uuid,
    installation: Uuid,
    account: &str,
    live: bool,
) -> Result<Vec<(String, Uuid)>> {
    Ok(sqlx::query_as("SELECT provider_evidence->'session'->>'payment_method_id',request_id FROM patient_payment_setups WHERE tenant_id=$1 AND patient_id=$2 AND setting_id=$3 AND installation_id=$4 AND provider_account_id=$5 AND livemode=$6 AND status='succeeded' AND consent_scope='later_charges' AND provider_evidence->'session'->>'payment_method_id' IS NOT NULL ORDER BY created_at DESC LIMIT 200")
        .bind(tenant)
        .bind(patient)
        .bind(setting)
        .bind(installation)
        .bind(account)
        .bind(live)
        .fetch_all(&mut **tx)
        .await?)
}

#[derive(sqlx::FromRow)]
struct Row {
    tenant_id: Uuid,
    id: Uuid,
    patient_id: Uuid,
    setting_id: Uuid,
    credential_revision: i64,
    installation_id: Uuid,
    provider_account_id: String,
    livemode: bool,
    amount_cents: i64,
    currency: String,
    status: String,
    provider_payment_intent: Option<String>,
    provider_charge_id: Option<String>,
    provider_captured_at: Option<DateTime<Utc>>,
    saved_card_setup_id: Option<Uuid>,
    created_at: DateTime<Utc>,
}
impl Row {
    fn binding(&self) -> Binding {
        Binding {
            tenant: self.tenant_id,
            setting: self.setting_id,
            revision: self.credential_revision,
            installation: self.installation_id,
        }
    }
    fn evidence(&self) -> EvidenceBinding {
        EvidenceBinding {
            tenant_id: self.tenant_id,
            id: self.id,
            installation_id: self.installation_id,
            provider_account_id: self.provider_account_id.clone(),
            livemode: self.livemode,
            amount_cents: self.amount_cents,
            currency: self.currency.clone(),
            provider_session_id: None,
            provider_payment_intent: self.provider_payment_intent.clone(),
            provider_charge_id: self.provider_charge_id.clone(),
            provider_captured_at: self.provider_captured_at,
            reader: true,
        }
    }
    fn path(&self) -> String {
        format!("/patient-billing/{}/saved-card-payments", self.patient_id)
    }
}

/// One step for a leased saved-card charge.
struct Step<'a> {
    pool: &'a PgPool,
    a: &'a Actor,
    kind: Kind,
    row: Row,
    lease: Uuid,
    broker: &'a dyn Broker,
    policy: Policy,
}
impl Step<'_> {
    async fn ask(&self, method: Method, path: &str, body: Option<Value>) -> Result<Reply> {
        self.broker
            .reply(self.pool, &self.row.binding(), method, path, body)
            .await
    }
    /// Try again in a moment; what staff see does not change.
    async fn retry(&self) -> Result<()> {
        sqlx::query(&format!("UPDATE {} SET lease_id=NULL,lease_until=NULL,next_poll_at=now()+interval '5 seconds',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3", self.kind.table()))
            .bind(self.a.tenant_id).bind(self.row.id).bind(self.lease).execute(self.pool).await?;
        Ok(())
    }
    /// Evidence that does not fit this charge: a person has to look at it.
    async fn review(&self) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let changed = sqlx::query(&format!("UPDATE {} SET status='needs_review',last_result='provider_evidence_needs_review',lease_id=NULL,lease_until=NULL,next_poll_at=now()+interval '15 minutes',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3", self.kind.table()))
            .bind(self.a.tenant_id).bind(self.row.id).bind(self.lease).execute(&mut *tx).await?.rows_affected();
        if changed == 1 {
            self.kind
                .event(&mut tx, self.a, self.row.id, "evidence_needs_review")
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
    /// SunCharts Connect refused before creating anything, so nothing exists at Stripe.
    async fn close(&self, note: &'static str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let changed = sqlx::query(&format!("UPDATE {} SET status='expired',last_result=$4,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND provider_payment_intent IS NULL AND provider_captured_at IS NULL", self.kind.table()))
            .bind(self.a.tenant_id).bind(self.row.id).bind(self.lease).bind(note).execute(&mut *tx).await?.rows_affected();
        if changed == 1 {
            self.kind.event(&mut tx, self.a, self.row.id, note).await?;
        }
        tx.commit().await?;
        if changed == 1 {
            Ok(())
        } else {
            self.review().await
        }
    }
    /// Post what the processor reports, through the code hosted and reader payments use.
    async fn settle(&self, value: &Value, note: &'static str) -> Result<()> {
        if self
            .kind
            .apply(
                self.pool,
                self.a,
                self.row.id,
                self.lease,
                value,
                self.policy,
                note,
            )
            .await
            .is_err()
        {
            self.review().await?;
        }
        Ok(())
    }
    async fn seen(&self, value: &Value) -> Result<()> {
        let Ok(seen) = hosted::verify_reader_bound(&self.row.evidence(), value) else {
            return self.review().await;
        };
        if seen.paid {
            self.settle(value, "provider_verified").await
        } else if seen.expired {
            // The payment was cancelled at Stripe: no money moved.
            let note = if value["outcome"] == "authentication_required" {
                "saved_card_needs_patient"
            } else {
                "saved_card_declined"
            };
            self.settle(value, note).await
        } else {
            self.settle(value, "saved_card_processing").await
        }
    }
    async fn step(&self) -> Result<()> {
        let path = self.row.path();
        let captured = self.row.provider_captured_at.is_some();
        let sendable =
            Utc::now() <= self.row.created_at + chrono::Duration::seconds(SEND_WINDOW_SECONDS);
        if captured || !sendable {
            // A captured charge is only watched for refunds; an old one is never sent again.
            let query = format!(
                "account_id={}&livemode={}&remote_tenant_id={}",
                self.row.provider_account_id, self.row.livemode, self.row.tenant_id
            );
            let reply = match self
                .ask(
                    Method::GET,
                    &format!("{path}/{}?{query}", self.row.id),
                    None,
                )
                .await
            {
                Ok(reply) => reply,
                Err(_) => return self.retry().await,
            };
            return match reply.status {
                200..=299 if !captured && reply.body["payment_intent"].is_null() => {
                    self.review().await
                }
                200..=299 => self.seen(&reply.body).await,
                404 if !captured => self.close("saved_card_not_sent").await,
                // The payment service answered but cannot say what happened: a person looks.
                400..=423 | 425..=499 if !captured => self.review().await,
                _ => self.retry().await,
            };
        }
        let body = json!({"account_id":self.row.provider_account_id,"livemode":self.row.livemode,
            "remote_tenant_id":self.row.tenant_id,"request_id":self.row.id,
            "amount_cents":self.row.amount_cents,"currency":self.row.currency,
            "setup_request_id":self.row.saved_card_setup_id});
        // The same request is safe to send again: SunCharts Connect creates and confirms one
        // payment per request and answers a repeat with what already happened.
        let reply = match self.ask(Method::POST, &path, Some(body)).await {
            Ok(reply) => reply,
            Err(_) => return self.retry().await,
        };
        // Only an answer that says nothing was created closes the attempt. Any other refusal
        // may have come after the bank was asked (SunCharts Connect reports a Stripe failure
        // as 424), so the same request is sent again and answered with what really happened.
        match (reply.status, reply.code()) {
            (200..=299, _) => self.seen(&reply.body).await,
            (409, "card_not_eligible") => self.close("saved_card_not_eligible").await,
            (409, "card_unavailable") | (400 | 404, _) => {
                self.close("saved_card_unavailable").await
            }
            _ => self.retry().await,
        }
    }
}

/// Advance one saved-card charge. Safe to call from any number of places at once: only the
/// caller holding the short lease does anything.
pub(crate) async fn drive(
    pool: &PgPool,
    a: &Actor,
    kind: Kind,
    id: Uuid,
    broker: &dyn Broker,
    policy: Policy,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let row: Option<Row> = sqlx::query_as(&format!("SELECT tenant_id,id,patient_id,setting_id,credential_revision,installation_id,provider_account_id,livemode,amount_cents,currency,status,provider_payment_intent,provider_charge_id,provider_captured_at,saved_card_setup_id,created_at FROM {} WHERE tenant_id=$1 AND id=$2 AND channel='saved_card' FOR UPDATE", kind.table()))
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(row) = row else {
        return Ok(());
    };
    if !policy.permits(row.livemode) || ["expired", "refunded"].contains(&row.status.as_str()) {
        return Ok(());
    }
    let lease = Uuid::new_v4();
    let leased = sqlx::query(&format!("UPDATE {} SET lease_id=$3,lease_until=now()+interval '45 seconds',attempts=attempts+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND (lease_until IS NULL OR lease_until<now())", kind.table()))
        .bind(a.tenant_id).bind(id).bind(lease).execute(&mut *tx).await?.rows_affected();
    if leased == 0 {
        return Ok(());
    }
    tx.commit().await?;
    Step {
        pool,
        a,
        kind,
        row,
        lease,
        broker,
        policy,
    }
    .step()
    .await
}

#[cfg(test)]
#[path = "saved_card_payments_tests.rs"]
pub(crate) mod tests;
