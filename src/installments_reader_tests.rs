// SPDX-License-Identifier: AGPL-3.0-only
// Invoice balances taken on a card reader, on the invoice collection fixture and tables.
use crate::reader_payments::tests::FakeReaders;

fn reader_checkout() -> Checkout {
    Checkout {
        reader_id: Some("tmr_frontdesk".into()),
        ..checkout_input()
    }
}

#[tokio::test]
async fn invoice_balance_taken_on_a_reader_posts_to_the_ledger_like_a_hosted_payment() {
    let (pool, a, patient, account, invoice, s) = fixture().await;
    let broker = FakeReaders::with_reader(false);
    let p = create_with(&pool, &a, patient, plan_input(invoice, false), 2, policy(false))
        .await
        .unwrap();
    let pid: Uuid = serde_json::from_value(p["id"].clone()).unwrap();
    let start = |version: i64| {
        checkout_with(
            &pool,
            &a,
            patient,
            pid,
            1,
            reader_checkout(),
            version,
            "https://synthetic.example",
            &broker,
            policy(false),
        )
    };
    // Declined first: nothing is posted and the same installment can be taken again.
    let first = start(1).await.unwrap();
    let declined: Uuid = serde_json::from_value(first["operation"]["id"].clone()).unwrap();
    assert_eq!(first["operation"]["status"], "open");
    assert_eq!(first["operation"]["channel"], "reader");
    assert_eq!(first["operation"]["reader_id"], "tmr_frontdesk");
    assert_eq!(first["operation"]["last_result"], "reader_waiting");
    assert_eq!(first["operation"]["checkout_url"], Value::Null);
    assert_eq!(
        broker.state.lock().unwrap().posted[0],
        json!({"account_id":"acct_synthetic","livemode":false,"remote_tenant_id":a.tenant_id,
            "request_id":declined,"operation":declined,"amount_cents":1500,"currency":"usd","reader_id":"tmr_frontdesk"}),
        "no patient, invoice or plan detail leaves the EHR"
    );
    // Waiting for a card does not move the plan version or its history.
    let version = read_plan(&pool, &a, patient, pid).await["version"]
        .as_i64()
        .unwrap();
    let events = count(&pool, "patient_installment_events").await;
    for _ in 0..3 {
        process(&pool, &a, declined, &broker, policy(false), true)
            .await
            .unwrap();
    }
    assert_eq!(
        read_plan(&pool, &a, patient, pid).await["version"],
        version
    );
    assert_eq!(count(&pool, "patient_installment_events").await, events);
    assert!(start(version).await.is_err(), "one collection at a time");
    broker.decline(declined);
    process(&pool, &a, declined, &broker, policy(false), true)
        .await
        .unwrap();
    let closed = row(&pool, &a, declined).await;
    assert_eq!(closed.status, "expired");
    assert_eq!(closed.last_result.as_deref(), Some("reader_declined"));
    assert_eq!(financial(&pool, &a, account).await, (0, 0));
    assert_eq!(count(&pool, "billing_entries").await, 0);

    let version = read_plan(&pool, &a, patient, pid).await["version"]
        .as_i64()
        .unwrap();
    let second = start(version).await.unwrap();
    let op: Uuid = serde_json::from_value(second["operation"]["id"].clone()).unwrap();
    assert_ne!(op, declined);
    broker.approve(op);
    process(&pool, &a, op, &broker, policy(false), true)
        .await
        .unwrap();
    process(&pool, &a, op, &broker, policy(false), true)
        .await
        .unwrap();
    let paid = row(&pool, &a, op).await;
    assert_eq!(paid.status, "paid");
    assert!(paid.paid_entry_id.is_some() && paid.provider_session_id.is_none());
    assert_eq!(financial(&pool, &a, account).await, (1500, 1500));
    assert_eq!(count(&pool, "billing_entries").await, 1);
    let unresolved: i64 = sqlx::query_scalar("SELECT count(*) FROM invoice_checkout_attempts WHERE status IN ('creating','open','needs_review')")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(unresolved, 0);

    // Staff cancel the second installment while the reader waits.
    let version = read_plan(&pool, &a, patient, pid).await["version"]
        .as_i64()
        .unwrap();
    let third = checkout_with(
        &pool,
        &a,
        patient,
        pid,
        2,
        reader_checkout(),
        version,
        "https://synthetic.example",
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    let waiting: Uuid = serde_json::from_value(third["operation"]["id"].clone()).unwrap();
    let value = reader_cancel_with(&s, &a, waiting, &broker, policy(false))
        .await
        .unwrap();
    assert_eq!(value["operation"]["status"], "expired");
    assert_eq!(value["operation"]["last_result"], "reader_cancelled");
    assert_eq!(financial(&pool, &a, account).await, (1500, 1500));
    assert_eq!(count(&pool, "billing_entries").await, 1);
}
