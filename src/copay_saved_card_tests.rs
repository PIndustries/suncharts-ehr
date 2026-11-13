// SPDX-License-Identifier: AGPL-3.0-only
// Copays charged to a saved card, and card links cancelled by staff. They use the hosted copay
// fixture and tables; only the outbound SunCharts Connect boundary is synthetic.
use crate::saved_card_payments::{
    tests::{saved_card, FakeCards},
    CONSENT_SCOPE, NOT_ELIGIBLE,
};

fn card_input(setup: Uuid) -> Create {
    Create {
        saved_card_setup_id: Some(setup),
        reason: "Copay charged to card on file".into(),
        ..input(false)
    }
}
async fn charge(
    pool: &PgPool,
    a: &Actor,
    patient: Uuid,
    appointment: Uuid,
    input: Create,
    broker: &FakeCards,
) -> Result<Attempt> {
    create_with(
        pool,
        a,
        patient,
        appointment,
        input,
        "http://127.0.0.1:8099",
        broker,
        policy(false),
    )
    .await
}

#[tokio::test]
async fn saved_card_copay_is_posted_by_the_same_rule_and_never_charged_twice() {
    let (pool, a, patient, appointment, _state) = setup().await;
    let broker = FakeCards::new(false);
    let setup_id = saved_card(&pool, &a, patient, &broker, CONSENT_SCOPE).await;
    let request = card_input(setup_id);
    let again = Create {
        request_id: request.request_id,
        ..card_input(setup_id)
    };
    let op = charge(&pool, &a, patient, appointment, request, &broker)
        .await
        .unwrap();
    assert_eq!(op.channel, "saved_card");
    assert_eq!(op.status, "paid");
    assert_eq!(op.last_result.as_deref(), Some("provider_verified"));
    assert!(op.receipt_id.is_some() && op.provider_captured_at.is_some());
    assert!(op.provider_session_id.is_none() && op.checkout_url.is_none());
    assert_eq!(op.public(policy(false))["channel"], "saved_card");
    assert_eq!(
        broker.sent("/saved-card-payments"),
        vec![json!({"account_id":"acct_synthetic","livemode":false,"remote_tenant_id":a.tenant_id,
            "request_id":op.id,"amount_cents":2500,"currency":"usd","setup_request_id":setup_id})],
        "only the amount and opaque identifiers leave the EHR"
    );
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
    // The same request again, and the worker reading it back, post nothing new.
    let replay = charge(&pool, &a, patient, appointment, again, &broker)
        .await
        .unwrap();
    assert_eq!(replay.id, op.id);
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(broker.charges(), 1);
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
    assert_eq!(row(&pool, &a, op.id).await.status, "paid");
}

#[tokio::test]
async fn declined_and_bank_confirmation_close_the_charge_so_another_payment_can_start() {
    let (pool, a, patient, appointment, _state) = setup().await;
    let broker = FakeCards::new(false);
    let setup_id = saved_card(&pool, &a, patient, &broker, CONSENT_SCOPE).await;
    broker.answer("card_declined");
    let declined = charge(&pool, &a, patient, appointment, card_input(setup_id), &broker)
        .await
        .unwrap();
    assert_eq!(declined.status, "expired");
    assert_eq!(declined.last_result.as_deref(), Some("saved_card_declined"));
    assert!(declined.receipt_id.is_none() && declined.provider_captured_at.is_none());
    broker.answer("authentication_required");
    let needs = charge(&pool, &a, patient, appointment, card_input(setup_id), &broker)
        .await
        .unwrap();
    assert_eq!(needs.status, "expired");
    assert_eq!(
        needs.last_result.as_deref(),
        Some("saved_card_needs_patient")
    );
    assert_eq!(count(&pool, "billing_copay_receipts").await, 0);
    // The card link staff send instead starts straight away.
    let link = charge(&pool, &a, patient, appointment, input(false), &broker)
        .await
        .unwrap();
    assert_eq!(link.channel, "hosted");
    assert_eq!(link.status, "open");
    assert!(link.checkout_url.is_some());
}

#[tokio::test]
async fn card_saved_for_in_person_use_is_refused_before_anything_is_sent() {
    let (pool, a, patient, appointment, _state) = setup().await;
    let broker = FakeCards::new(false);
    let old = saved_card(&pool, &a, patient, &broker, "patient_present").await;
    let refused = charge(&pool, &a, patient, appointment, card_input(old), &broker).await;
    assert!(matches!(refused, Err(Error::Conflict(message)) if message == NOT_ELIGIBLE));
    // A card saved for another patient, or on another payment account, is refused too.
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-OTHER','Blair','Synthetic','1991-01-01')").bind(a.tenant_id).bind(other).execute(&pool).await.unwrap();
    let theirs = saved_card(&pool, &a, other, &broker, CONSENT_SCOPE).await;
    assert!(matches!(
        charge(&pool, &a, patient, appointment, card_input(theirs), &broker).await,
        Err(Error::NotFound)
    ));
    let elsewhere = saved_card(&pool, &a, patient, &FakeCards::new(false), CONSENT_SCOPE).await;
    assert!(matches!(
        charge(&pool, &a, patient, appointment, card_input(elsewhere), &broker).await,
        Err(Error::Conflict(_))
    ));
    let both = Create {
        reader_id: Some("tmr_frontdesk".into()),
        ..card_input(old)
    };
    assert!(charge(&pool, &a, patient, appointment, both, &broker)
        .await
        .is_err());
    assert_eq!(count(&pool, "copay_checkout_attempts").await, 0);
    assert_eq!(broker.charges(), 0);
    assert!(broker.sent("/saved-card-payments").is_empty());
    // The payment service refuses from its own record as well: nothing was charged.
    let good = saved_card(&pool, &a, patient, &broker, CONSENT_SCOPE).await;
    broker.state.lock().unwrap().refusal = Some((409, "card_not_eligible"));
    let closed = charge(&pool, &a, patient, appointment, card_input(good), &broker)
        .await
        .unwrap();
    assert_eq!(closed.status, "expired");
    assert_eq!(
        closed.last_result.as_deref(),
        Some("saved_card_not_eligible")
    );
    assert_eq!(broker.charges(), 0);
}

#[tokio::test]
async fn processing_and_lost_answers_settle_from_the_same_request() {
    let (pool, a, patient, appointment, _state) = setup().await;
    let broker = FakeCards::new(false);
    let setup_id = saved_card(&pool, &a, patient, &broker, CONSENT_SCOPE).await;
    broker.answer("processing");
    let op = charge(&pool, &a, patient, appointment, card_input(setup_id), &broker)
        .await
        .unwrap();
    assert_eq!(op.status, "open");
    assert_eq!(op.last_result.as_deref(), Some("saved_card_processing"));
    assert!(op.receipt_id.is_none());
    // While it is open nothing else can be collected for the appointment.
    assert!(charge(&pool, &a, patient, appointment, input(false), &broker)
        .await
        .is_err());
    broker
        .state
        .lock()
        .unwrap()
        .charges
        .get_mut(&op.id)
        .unwrap()
        .outcome = "succeeded";
    process_id(&pool, &a, op.id, &broker, policy(false))
        .await
        .unwrap();
    let paid = row(&pool, &a, op.id).await;
    assert_eq!(paid.status, "paid");
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);

    // A charge whose answer was lost is asked for again with the same request: one charge.
    let (pool, a, patient, appointment, _state) = setup().await;
    let broker = FakeCards::new(false);
    let setup_id = saved_card(&pool, &a, patient, &broker, CONSENT_SCOPE).await;
    broker.state.lock().unwrap().lose_answer = true;
    let lost = charge(&pool, &a, patient, appointment, card_input(setup_id), &broker)
        .await
        .unwrap();
    assert_eq!(lost.status, "creating");
    assert!(lost.receipt_id.is_none());
    process_id(&pool, &a, lost.id, &broker, policy(false))
        .await
        .unwrap();
    let settled = row(&pool, &a, lost.id).await;
    assert_eq!(settled.status, "paid");
    assert_eq!(broker.charges(), 1);
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
    // A refund seen later is recorded through the usual path.
    broker
        .state
        .lock()
        .unwrap()
        .charges
        .get_mut(&lost.id)
        .unwrap()
        .refunded = 2500;
    process_id(&pool, &a, lost.id, &broker, policy(false))
        .await
        .unwrap();
    assert_eq!(row(&pool, &a, lost.id).await.status, "refunded");
}

#[tokio::test]
async fn staff_can_cancel_an_open_card_link_and_start_another_payment_at_once() {
    let (pool, a, patient, appointment, _state) = setup().await;
    let broker = FakeCards::new(false);
    let cancel = |id: Uuid| link_cancel_with(&pool, &a, patient, appointment, id, &broker, policy(false));
    let link = charge(&pool, &a, patient, appointment, input(false), &broker)
        .await
        .unwrap();
    assert_eq!(link.status, "open");
    // Today this open link would block the next payment for the appointment.
    assert!(charge(&pool, &a, patient, appointment, input(false), &broker)
        .await
        .is_err());
    let cancelled = cancel(link.id).await.unwrap();
    assert_eq!(cancelled["operation"]["status"], "expired");
    assert_eq!(cancelled["operation"]["last_result"], "link_cancelled");
    assert_eq!(cancelled["operation"]["checkout_url"], Value::Null);
    assert_eq!(cancelled["operation"]["cancel_requested"], false);
    assert_eq!(broker.state.lock().unwrap().expires, 1);
    // Cancelling again changes nothing and asks the processor nothing.
    cancel(link.id).await.unwrap();
    assert_eq!(broker.state.lock().unwrap().expires, 1);
    let next = charge(&pool, &a, patient, appointment, input(false), &broker)
        .await
        .unwrap();
    assert_eq!(next.status, "open");

    // The patient paid in the same moment: the payment is recorded, never cancelled.
    broker.state.lock().unwrap().pay_on_expire = true;
    let paid = cancel(next.id).await.unwrap();
    assert_eq!(paid["operation"]["status"], "paid");
    assert!(paid["operation"]["receipt_id"].is_string());
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
    // A paid payment cannot be cancelled afterwards either.
    let still = cancel(next.id).await.unwrap();
    assert_eq!(still["operation"]["status"], "paid");

    // A link that never reached the processor is closed as well.
    let (pool, a, patient, appointment, _state) = setup().await;
    let broker = FakeCards::new(false);
    broker.state.lock().unwrap().lose_links = true;
    let unsent = charge(&pool, &a, patient, appointment, input(false), &broker)
        .await
        .unwrap();
    assert_eq!(unsent.status, "creating");
    let closed = link_cancel_with(&pool, &a, patient, appointment, unsent.id, &broker, policy(false))
        .await
        .unwrap();
    assert_eq!(closed["operation"]["status"], "expired");
    assert_eq!(closed["operation"]["last_result"], "link_cancelled");
    // A reader payment or a saved-card charge is not a card link.
    let setup_id = saved_card(&pool, &a, patient, &broker, CONSENT_SCOPE).await;
    let charged = charge(&pool, &a, patient, appointment, card_input(setup_id), &broker)
        .await
        .unwrap();
    assert!(link_cancel_with(&pool, &a, patient, appointment, charged.id, &broker, policy(false))
        .await
        .is_err());
}

#[tokio::test]
async fn an_unclear_refusal_never_closes_a_charge_that_may_have_gone_through() {
    let (pool, a, patient, appointment, _state) = setup().await;
    let broker = FakeCards::new(false);
    let setup_id = saved_card(&pool, &a, patient, &broker, CONSENT_SCOPE).await;
    // SunCharts Connect reports a Stripe failure as 424, and a changed binding as 409. Either
    // can arrive after the bank was asked, so the attempt stays open and is asked for again.
    for refusal in [(424, "upstream_error"), (409, "conflict"), (500, "")] {
        broker.state.lock().unwrap().refusal = Some(refusal);
        let request = card_input(setup_id);
        let op = charge(&pool, &a, patient, appointment, request, &broker)
            .await
            .unwrap();
        assert_eq!(op.status, "creating", "{refusal:?}");
        assert!(op.receipt_id.is_none());
        broker.state.lock().unwrap().refusal = None;
        process_id(&pool, &a, op.id, &broker, policy(false))
            .await
            .unwrap();
        let settled = row(&pool, &a, op.id).await;
        assert_eq!(settled.status, "paid", "{refusal:?}");
        // A paid copay does not block the next charge for the appointment.
        sqlx::query("UPDATE copay_checkout_attempts SET next_poll_at=now()+interval '1 day'")
            .execute(&pool)
            .await
            .unwrap();
    }
    assert_eq!(broker.charges(), 3);
    assert_eq!(count(&pool, "billing_copay_receipts").await, 3);
    // An old charge that was never answered is only read back, never sent again.
    broker.state.lock().unwrap().refusal = Some((424, "upstream_error"));
    let stale = charge(&pool, &a, patient, appointment, card_input(setup_id), &broker)
        .await
        .unwrap();
    assert_eq!(stale.status, "creating");
    broker.state.lock().unwrap().refusal = None;
    sqlx::query("ALTER TABLE copay_checkout_attempts DISABLE TRIGGER USER")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE copay_checkout_attempts SET created_at=now()-interval '11 minutes' WHERE id=$1")
        .bind(stale.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE copay_checkout_attempts ENABLE TRIGGER USER")
        .execute(&pool)
        .await
        .unwrap();
    let sends = broker.sent("/saved-card-payments").len();
    process_id(&pool, &a, stale.id, &broker, policy(false))
        .await
        .unwrap();
    let closed = row(&pool, &a, stale.id).await;
    assert_eq!(closed.status, "expired");
    assert_eq!(closed.last_result.as_deref(), Some("saved_card_not_sent"));
    assert_eq!(broker.sent("/saved-card-payments").len(), sends);
    assert_eq!(broker.charges(), 3);
}
