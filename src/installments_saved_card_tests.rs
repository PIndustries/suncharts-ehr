// SPDX-License-Identifier: AGPL-3.0-only
// Invoice balances charged to a saved card, and invoice card links cancelled by staff, on the
// invoice collection fixture and tables.
use crate::saved_card_payments::{
    tests::{saved_card, FakeCards},
    CONSENT_SCOPE, NOT_ELIGIBLE,
};

fn card_checkout(setup: Uuid) -> Checkout {
    Checkout {
        patient_present: false,
        reason: "Installment charged to card on file".into(),
        saved_card_setup_id: Some(setup),
        ..checkout_input()
    }
}
async fn plan_version(pool: &PgPool, a: &Actor, patient: Uuid, plan: Uuid) -> i64 {
    read_plan(pool, a, patient, plan).await["version"]
        .as_i64()
        .unwrap()
}

#[tokio::test]
async fn installment_charged_to_a_saved_card_needs_no_patient_and_falls_back_to_a_card_link() {
    let (pool, a, patient, _account, invoice, s) = fixture().await;
    let broker = FakeCards::new(false);
    let p = create_with(&pool, &a, patient, plan_input(invoice, false), 2, policy(false))
        .await
        .unwrap();
    let pid: Uuid = serde_json::from_value(p["id"].clone()).unwrap();
    let start = |input: Checkout, version: i64| {
        checkout_with(
            &pool,
            &a,
            patient,
            pid,
            1,
            input,
            version,
            "https://synthetic.example",
            &broker,
            policy(false),
        )
    };
    // Without a present patient or a card saved for later charges, nothing starts.
    let absent = Checkout {
        patient_present: false,
        ..checkout_input()
    };
    assert!(start(absent, 1).await.is_err());
    let old = saved_card(&pool, &a, patient, &broker, "patient_present").await;
    assert!(matches!(
        start(card_checkout(old), 1).await,
        Err(Error::Conflict(message)) if message == NOT_ELIGIBLE
    ));
    assert_eq!(count(&pool, "invoice_checkout_attempts").await, 0);
    assert_eq!(broker.charges(), 0);

    // The bank asks the patient to confirm: the charge is closed and nothing is posted.
    let setup_id = saved_card(&pool, &a, patient, &broker, CONSENT_SCOPE).await;
    broker.answer("authentication_required");
    let first = start(card_checkout(setup_id), 1).await.unwrap();
    let asked: Uuid = serde_json::from_value(first["operation"]["id"].clone()).unwrap();
    assert_eq!(first["operation"]["channel"], "saved_card");
    assert_eq!(first["operation"]["status"], "expired");
    assert_eq!(
        first["operation"]["last_result"],
        "saved_card_needs_patient"
    );
    assert_eq!(first["operation"]["paid_entry_id"], Value::Null);
    assert_eq!(
        broker.sent("/saved-card-payments"),
        vec![json!({"account_id":"acct_synthetic","livemode":false,"remote_tenant_id":a.tenant_id,
            "request_id":asked,"amount_cents":1500,"currency":"usd","setup_request_id":setup_id})],
        "no patient, invoice or plan detail leaves the EHR"
    );
    // The card link sent instead needs no present patient, but only after such a charge.
    let version = plan_version(&pool, &a, patient, pid).await;
    let stray = Checkout {
        patient_present: false,
        after_saved_card: Some(Uuid::new_v4()),
        ..checkout_input()
    };
    assert!(start(stray, version).await.is_err());
    let link = Checkout {
        patient_present: false,
        after_saved_card: Some(asked),
        ..checkout_input()
    };
    let linked = start(link, version).await.unwrap();
    let link_id: Uuid = serde_json::from_value(linked["operation"]["id"].clone()).unwrap();
    assert_eq!(linked["operation"]["channel"], "hosted");
    assert_eq!(linked["operation"]["status"], "open");
    assert!(linked["operation"]["checkout_url"].is_string());

    // Staff cancel that link and can charge the card again at once.
    let version = plan_version(&pool, &a, patient, pid).await;
    assert!(start(card_checkout(setup_id), version).await.is_err());
    let cancelled = link_cancel_with(&s, &a, link_id, &broker, policy(false))
        .await
        .unwrap();
    assert_eq!(cancelled["operation"]["status"], "expired");
    assert_eq!(cancelled["operation"]["last_result"], "link_cancelled");
    assert_eq!(cancelled["operation"]["checkout_url"], Value::Null);
    assert_eq!(broker.state.lock().unwrap().expires, 1);
    link_cancel_with(&s, &a, link_id, &broker, policy(false))
        .await
        .unwrap();
    assert_eq!(broker.state.lock().unwrap().expires, 1);

    broker.answer("succeeded");
    let version = plan_version(&pool, &a, patient, pid).await;
    let paid = start(card_checkout(setup_id), version).await.unwrap();
    assert_eq!(paid["operation"]["status"], "paid");
    assert!(paid["operation"]["paid_entry_id"].is_string());
    assert_eq!(paid["plan"]["remaining_cents"], 1500);
    assert_eq!(paid["plan"]["installments"][0]["status"], "complete");
    let entries: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM billing_entries WHERE content->>'invoice_checkout_operation_id' IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(entries, 1, "one ledger payment for one approved charge");
}

#[tokio::test]
async fn invoice_link_paid_while_staff_cancel_is_recorded_as_paid() {
    let (pool, a, patient, _account, invoice, s) = fixture().await;
    let broker = FakeCards::new(false);
    let p = create_with(&pool, &a, patient, plan_input(invoice, false), 2, policy(false))
        .await
        .unwrap();
    let pid: Uuid = serde_json::from_value(p["id"].clone()).unwrap();
    let linked = checkout_with(
        &pool,
        &a,
        patient,
        pid,
        1,
        checkout_input(),
        1,
        "https://synthetic.example",
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    let link_id: Uuid = serde_json::from_value(linked["operation"]["id"].clone()).unwrap();
    broker.state.lock().unwrap().pay_on_expire = true;
    let paid = link_cancel_with(&s, &a, link_id, &broker, policy(false))
        .await
        .unwrap();
    assert_eq!(paid["operation"]["status"], "paid");
    assert!(paid["operation"]["paid_entry_id"].is_string());
    assert_eq!(
        read_plan(&pool, &a, patient, pid).await["remaining_cents"],
        1500
    );
}

#[tokio::test]
async fn patient_balance_is_charged_to_a_saved_card_as_a_one_payment_plan() {
    let (pool, a, patient, _account, invoice, _s) = fixture().await;
    let broker = FakeCards::new(false);
    let charge = |request_id: Uuid, amount_cents: i64, saved_card_setup_id: Uuid| {
        balance_charge_with(
            &pool,
            &a,
            patient,
            invoice,
            BalanceCharge {
                request_id,
                amount_cents,
                saved_card_setup_id,
            },
            "https://synthetic.example",
            &broker,
            policy(false),
        )
    };
    // A card saved for in-person use is refused and leaves nothing behind.
    let old = saved_card(&pool, &a, patient, &broker, "patient_present").await;
    assert!(matches!(
        charge(Uuid::new_v4(), 3000, old).await,
        Err(Error::Conflict(message)) if message == NOT_ELIGIBLE
    ));
    let setup_id = saved_card(&pool, &a, patient, &broker, CONSENT_SCOPE).await;
    assert!(charge(Uuid::new_v4(), 2000, setup_id).await.is_err());
    assert_eq!(count(&pool, "patient_installment_plans").await, 0);
    assert_eq!(count(&pool, "invoice_checkout_attempts").await, 0);

    broker.answer("card_declined");
    let declined = charge(Uuid::new_v4(), 3000, setup_id).await.unwrap();
    assert_eq!(declined["operation"]["status"], "expired");
    assert_eq!(declined["operation"]["last_result"], "saved_card_declined");
    assert_eq!(declined["plan"]["installments"].as_array().unwrap().len(), 1);
    assert_eq!(declined["plan"]["remaining_cents"], 3000);

    // The next try reuses the same one-payment plan and posts the payment once.
    broker.answer("succeeded");
    let request = Uuid::new_v4();
    let paid = charge(request, 3000, setup_id).await.unwrap();
    assert_eq!(paid["operation"]["status"], "paid");
    assert_eq!(paid["operation"]["channel"], "saved_card");
    assert!(paid["operation"]["paid_entry_id"].is_string());
    assert_eq!(paid["plan"]["remaining_cents"], 0);
    assert_eq!(paid["plan"]["status"], "complete");
    let replay = charge(request, 3000, setup_id).await.unwrap();
    assert_eq!(replay["operation"]["id"], paid["operation"]["id"]);
    assert_eq!(count(&pool, "patient_installment_plans").await, 1);
    assert_eq!(broker.charges(), 2, "one declined and one approved charge");
}
