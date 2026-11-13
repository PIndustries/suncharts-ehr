// SPDX-License-Identifier: AGPL-3.0-only
// Copays taken on a card reader. They use the hosted copay fixture and tables; only the
// outbound SunCharts Connect boundary is replaced with a synthetic reader.
use crate::reader_payments::tests::FakeReaders;

fn reader_input(live: bool) -> Create {
    Create {
        reader_id: Some("tmr_frontdesk".into()),
        ..input(live)
    }
}
/// What the production upgrade tooling counts before it agrees to upgrade.
async fn unresolved(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM copay_checkout_attempts WHERE status IN ('creating','open','needs_review')")
        .fetch_one(pool)
        .await
        .unwrap()
}
async fn start_reader_copay(
    pool: &PgPool,
    a: &Actor,
    patient: Uuid,
    appointment: Uuid,
    broker: &FakeReaders,
) -> Attempt {
    create_with(
        pool,
        a,
        patient,
        appointment,
        reader_input(false),
        "http://127.0.0.1:8099",
        broker,
        policy(false),
    )
    .await
    .unwrap()
}
async fn advance(pool: &PgPool, a: &Actor, id: Uuid, broker: &FakeReaders) -> Attempt {
    process_id(pool, a, id, broker, policy(false)).await.unwrap();
    row(pool, a, id).await
}

#[tokio::test]
async fn reader_copay_is_posted_by_the_same_rule_as_a_hosted_copay() {
    let (pool, a, patient, appointment, _state) = setup().await;
    let broker = FakeReaders::with_reader(false);
    let op = start_reader_copay(&pool, &a, patient, appointment, &broker).await;
    assert_eq!(op.channel, "reader");
    assert_eq!(op.reader_id.as_deref(), Some("tmr_frontdesk"));
    assert_eq!(op.status, "open");
    assert_eq!(op.last_result.as_deref(), Some("reader_waiting"));
    assert!(op.provider_session_id.is_none() && op.checkout_url.is_none());
    assert_eq!(
        op.provider_payment_intent,
        Some(format!("pi_{}", op.id.simple()))
    );
    let public = op.public(policy(false));
    assert_eq!(public["channel"], "reader");
    assert_eq!(public["reader_id"], "tmr_frontdesk");
    assert_eq!(public["checkout_url"], Value::Null);
    {
        let world = broker.state.lock().unwrap();
        assert_eq!(world.starts, 1);
        assert_eq!(
            world.posted[0],
            json!({"account_id":"acct_synthetic","livemode":false,"remote_tenant_id":a.tenant_id,
                "request_id":op.id,"operation":op.id,"amount_cents":2500,"currency":"usd","reader_id":"tmr_frontdesk"}),
            "no patient, appointment, coverage or reason leaves the EHR"
        );
    }
    // Waiting for a card: nothing is posted and the history does not grow with every read.
    let events = count(&pool, "copay_checkout_events").await;
    for _ in 0..3 {
        let waiting = advance(&pool, &a, op.id, &broker).await;
        assert_eq!(waiting.status, "open");
        assert_eq!(waiting.last_result.as_deref(), Some("reader_waiting"));
    }
    assert_eq!(count(&pool, "copay_checkout_events").await, events);
    assert_eq!(count(&pool, "billing_copay_receipts").await, 0);
    assert_eq!(unresolved(&pool).await, 1);
    broker.state.lock().unwrap().reader_offline = true;
    assert_eq!(
        advance(&pool, &a, op.id, &broker).await.last_result.as_deref(),
        Some("reader_offline")
    );
    broker.state.lock().unwrap().reader_offline = false;
    // A second payment for the same appointment cannot start while this one is open.
    assert!(matches!(
        create_with(
            &pool,
            &a,
            patient,
            appointment,
            reader_input(false),
            "http://127.0.0.1:8099",
            &broker,
            policy(false)
        )
        .await,
        Err(Error::Conflict(_))
    ));

    broker.approve(op.id);
    let paid = advance(&pool, &a, op.id, &broker).await;
    assert_eq!(paid.status, "paid");
    assert_eq!(paid.last_result.as_deref(), Some("provider_verified"));
    assert_eq!(paid.provider_charge_id, Some(format!("ch_{}", op.id.simple())));
    assert!(paid.provider_captured_at.is_some() && paid.receipt_id.is_some());
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
    let receipt: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM billing_copay_receipts r WHERE id=$1")
            .bind(paid.receipt_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(receipt["amount_cents"], 2500);
    assert_eq!(receipt["appointment_id"], appointment.to_string());
    assert_eq!(unresolved(&pool).await, 0);
    // Reading it again changes nothing, and nothing was ever cancelled or sent twice.
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
    {
        let world = broker.state.lock().unwrap();
        assert_eq!((world.starts, world.cancels), (1, 0));
    }
    // A refund made at the processor is observed by the existing worker.
    broker
        .state
        .lock()
        .unwrap()
        .payments
        .get_mut(&op.id)
        .unwrap()
        .refunded = 2500;
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    let refunded = row(&pool, &a, op.id).await;
    assert_eq!(refunded.status, "refunded");
    assert_eq!(refunded.refunded_cents, 2500);
    assert_eq!(count(&pool, "copay_checkout_refund_events").await, 1);
}

#[tokio::test]
async fn reader_copay_closes_by_itself_when_declined_cancelled_or_never_presented() {
    let (pool, a, patient, appointment, _state) = setup().await;
    let broker = FakeReaders::with_reader(false);

    // Declined: the payment is cancelled at the processor and closed; staff start again.
    let declined = start_reader_copay(&pool, &a, patient, appointment, &broker).await;
    broker.decline(declined.id);
    let closed = advance(&pool, &a, declined.id, &broker).await;
    assert_eq!(closed.status, "expired");
    assert_eq!(closed.last_result.as_deref(), Some("reader_declined"));
    assert!(closed.receipt_id.is_none());
    assert_eq!(broker.state.lock().unwrap().cancels, 1);
    assert_eq!(unresolved(&pool).await, 0);
    // A closed payment is never read or sent again.
    let reads = broker.state.lock().unwrap().reads;
    advance(&pool, &a, declined.id, &broker).await;
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    crate::reader_payments::drive(
        &pool,
        &a,
        crate::reader_payments::Kind::Copay,
        declined.id,
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    assert_eq!(broker.state.lock().unwrap().reads, reads);

    // The patient presses cancel on the reader.
    let patient_cancelled = start_reader_copay(&pool, &a, patient, appointment, &broker).await;
    broker.patient_cancels(patient_cancelled.id);
    let closed = advance(&pool, &a, patient_cancelled.id, &broker).await;
    assert_eq!(
        (closed.status.as_str(), closed.last_result.as_deref()),
        ("expired", Some("reader_cancelled"))
    );

    // Staff press Cancel while a card is being approved: the payment is left alone, and the
    // approval that follows is posted rather than lost.
    let racing = start_reader_copay(&pool, &a, patient, appointment, &broker).await;
    broker.state.lock().unwrap().cancel_busy = true;
    let value = reader_cancel_with(
        &pool,
        &a,
        patient,
        appointment,
        racing.id,
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    assert_eq!(value["operation"]["status"], "open");
    assert_eq!(value["operation"]["last_result"], "reader_finishing");
    broker.approve(racing.id);
    broker.state.lock().unwrap().cancel_busy = false;
    let paid = advance(&pool, &a, racing.id, &broker).await;
    assert_eq!(paid.status, "paid");
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
    // Mark that receipt's appointment as settled for the next attempts.
    sqlx::query("ALTER TABLE copay_checkout_attempts DISABLE TRIGGER copay_checkout_protected")
        .execute(&pool)
        .await
        .unwrap();

    // Staff cancel while the reader is still waiting.
    let staff_cancelled = start_reader_copay(&pool, &a, patient, appointment, &broker).await;
    let mut other_patient = a.clone();
    other_patient.role = crate::auth::Role::Nurse;
    assert!(matches!(
        reader_cancel_with(
            &pool,
            &other_patient,
            patient,
            appointment,
            staff_cancelled.id,
            &broker,
            policy(false)
        )
        .await,
        Err(Error::Forbidden)
    ));
    let value = reader_cancel_with(
        &pool,
        &a,
        patient,
        appointment,
        staff_cancelled.id,
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    assert_eq!(value["operation"]["status"], "expired");
    assert_eq!(value["operation"]["last_result"], "reader_cancelled");

    // Nobody presents a card: after five minutes the worker cancels it without anyone asking.
    let abandoned = start_reader_copay(&pool, &a, patient, appointment, &broker).await;
    sqlx::query("UPDATE copay_checkout_attempts SET created_at=now()-interval '4 minutes' WHERE id=$1")
        .bind(abandoned.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(advance(&pool, &a, abandoned.id, &broker).await.status, "open");
    sqlx::query("UPDATE copay_checkout_attempts SET created_at=now()-interval '6 minutes',next_poll_at=now() WHERE id=$1")
        .bind(abandoned.id)
        .execute(&pool)
        .await
        .unwrap();
    // Unreachable for a moment: it stays open rather than being closed on a guess.
    broker.state.lock().unwrap().unreachable = true;
    assert_eq!(advance(&pool, &a, abandoned.id, &broker).await.status, "open");
    broker.state.lock().unwrap().unreachable = false;
    sqlx::query("UPDATE copay_checkout_attempts SET next_poll_at=now() WHERE id=$1")
        .bind(abandoned.id)
        .execute(&pool)
        .await
        .unwrap();
    // The two-second reader worker, acting as the system, closes it.
    crate::reader_payments::poll_once(&pool, &broker, policy(false))
        .await
        .unwrap();
    let closed = row(&pool, &a, abandoned.id).await;
    assert_eq!(
        (closed.status.as_str(), closed.last_result.as_deref()),
        ("expired", Some("reader_timed_out"))
    );
    assert_eq!(unresolved(&pool).await, 0);
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
}

#[tokio::test]
async fn reader_copay_that_cannot_reach_a_reader_is_closed_without_a_payment() {
    let (pool, a, patient, appointment, _state) = setup().await;
    let broker = FakeReaders::with_reader(false);
    for (refusal, note) in [
        ((409, "reader_offline"), "reader_offline"),
        ((409, "reader_busy"), "reader_in_use"),
        ((404, "reader_not_found"), "reader_unavailable"),
        ((409, "conflict"), "reader_unavailable"),
    ] {
        broker.state.lock().unwrap().start_refusal = Some(refusal);
        let op = start_reader_copay(&pool, &a, patient, appointment, &broker).await;
        assert_eq!(op.status, "expired", "{refusal:?}");
        assert_eq!(op.last_result.as_deref(), Some(note));
        assert!(op.provider_payment_intent.is_none());
    }
    // The reader did not answer: the same request is sent again, never a second payment.
    broker.state.lock().unwrap().start_refusal = Some((409, "reader_timeout"));
    let op = start_reader_copay(&pool, &a, patient, appointment, &broker).await;
    assert_eq!(op.status, "creating");
    broker.state.lock().unwrap().start_refusal = None;
    let before = broker.state.lock().unwrap().starts;
    let open = advance(&pool, &a, op.id, &broker).await;
    assert_eq!(open.status, "open");
    {
        let world = broker.state.lock().unwrap();
        assert_eq!(world.starts, before + 1);
        assert_eq!(world.payments.len(), 1);
    }
    // Evidence for another account is never posted or closed automatically.
    broker.state.lock().unwrap().wrong_account = true;
    broker.approve(op.id);
    let review = advance(&pool, &a, op.id, &broker).await;
    assert_eq!(review.status, "needs_review");
    assert_eq!(count(&pool, "billing_copay_receipts").await, 0);
    assert_eq!(unresolved(&pool).await, 1);
    // Once the evidence is consistent again the same payment is posted.
    broker.state.lock().unwrap().wrong_account = false;
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(row(&pool, &a, op.id).await.status, "paid");
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);

    // Hosted checkout is untouched: without a reader the same call still makes a card link.
    let (pool, a, patient, appointment, _state) = setup().await;
    let hosted_broker = FakeBroker::new(false);
    let hosted = create_with(
        &pool,
        &a,
        patient,
        appointment,
        input(false),
        "http://127.0.0.1:8099",
        &hosted_broker,
        policy(false),
    )
    .await
    .unwrap();
    assert_eq!(hosted.channel, "hosted");
    assert!(hosted.reader_id.is_none() && hosted.checkout_url.is_some());
    // The reader worker never touches a hosted attempt.
    sqlx::query("UPDATE copay_checkout_attempts SET next_poll_at=now()-interval '1 hour'")
        .execute(&pool)
        .await
        .unwrap();
    crate::reader_payments::poll_once(&pool, &broker, policy(false))
        .await
        .unwrap();
    assert_eq!(row(&pool, &a, hosted.id).await.version, hosted.version);
    let mut bad = reader_input(false);
    bad.reader_id = Some("frontdesk".into());
    assert!(matches!(
        create_with(
            &pool,
            &a,
            patient,
            appointment,
            bad,
            "http://127.0.0.1:8099",
            &broker,
            policy(false)
        )
        .await,
        Err(Error::Invalid(_))
    ));
}
