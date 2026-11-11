// SPDX-License-Identifier: AGPL-3.0-only
use super::*;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

#[derive(Default)]
struct FakeState {
    requests: BTreeMap<Uuid, (i64, String)>,
    created_times: BTreeMap<Uuid, i64>,
    posts: usize,
    posted_bodies: Vec<Value>,
    paid: bool,
    refunded: i64,
    lose_create: bool,
    wrong_account: bool,
    post_only_paid: bool,
    unbound: bool,
    recovery_required: bool,
    retry_expired: bool,
    calls: usize,
    recovery_value: Option<Value>,
    omit_recovery: bool,
    omit_session: bool,
    card_capability_override: Option<Value>,
}
struct FakeBroker {
    installation: Uuid,
    live: bool,
    state: Mutex<FakeState>,
}
impl FakeBroker {
    fn new(live: bool) -> Self {
        Self {
            installation: Uuid::new_v4(),
            live,
            state: Mutex::new(FakeState::default()),
        }
    }
    fn envelope(
        &self,
        binding: &Binding,
        id: Uuid,
        amount: i64,
        session: &str,
        state: &FakeState,
        post: bool,
    ) -> Value {
        let paid = state.paid || (post && state.post_only_paid);
        let pi = format!("pi_{}", id.simple());
        let ch = format!("ch_{}", id.simple());
        json!({"contract_version":1,"installation_id":self.installation,"remote_tenant_id":binding.tenant,"account_id":if state.wrong_account{"acct_wrong"}else{"acct_synthetic"},"livemode":self.live,"request_id":id,"session":{"id":session,"mode":"payment","livemode":self.live,"amount_total":amount,"currency":"usd","client_reference_id":id,"metadata":{"native_payment_id":id},"status":if paid{"complete"}else{"open"},"payment_status":if paid{"paid"}else{"unpaid"},"url":if paid{Value::Null}else{json!(format!("https://checkout.stripe.com/c/pay/{session}"))},"payment_intent":if paid{json!({"id":pi,"livemode":self.live,"status":"succeeded","amount":amount,"amount_received":amount,"currency":"usd","latest_charge":{"id":ch,"livemode":self.live,"amount":amount,"amount_refunded":state.refunded,"paid":true,"captured":true,"disputed":false,"created":state.created_times[&id],"currency":"usd","payment_intent":pi}})}else{Value::Null}}})
    }
}
#[async_trait]
impl Broker for FakeBroker {
    async fn installation(&self, _: &PgPool, _: Uuid, _: Uuid, _: i64) -> Result<Uuid> {
        Ok(self.installation)
    }
    async fn call(
        &self,
        _: &PgPool,
        binding: &Binding,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        state.calls += 1;
        if path == "/status" {
            return Ok(
                json!({"installation_id":self.installation,"remote_tenant_id":binding.tenant,"account_id":"acct_synthetic","livemode":self.live,"checkout_contract_version":1,"hosted_checkout_enabled":true,"charges_enabled":true,"card_payments_active":state.card_capability_override.clone().unwrap_or(json!(true)),"details_submitted":true}),
            );
        }
        if method == Method::POST {
            let body = body.unwrap();
            assert_eq!(path, "/hosted-checkouts");
            state.posted_bodies.push(body.clone());
            assert_eq!(body["livemode"], self.live);
            assert_eq!(body["account_id"], "acct_synthetic");
            assert_eq!(body["currency"], "usd");
            let id: Uuid = serde_json::from_value(body["request_id"].clone()).unwrap();
            let amount = body["amount_cents"].as_i64().unwrap();
            let session = format!(
                "cs_{}_{}",
                if self.live { "live" } else { "test" },
                id.simple()
            );
            state.posts += 1;
            state
                .created_times
                .entry(id)
                .or_insert(Utc::now().timestamp());
            state
                .requests
                .entry(id)
                .or_insert((amount, session.clone()));
            if state.lose_create {
                state.lose_create = false;
                return Err(Error::Invalid("synthetic lost response"));
            }
            state.unbound = false;
            return Ok(self.envelope(binding, id, amount, &session, &state, true));
        }
        if let Some(id) = path.strip_prefix("/hosted-checkout-requests/") {
            let id = Uuid::parse_str(id).unwrap();
            let (amount, session) = state.requests.get(&id).ok_or(Error::NotFound)?;
            let mut envelope = self.envelope(binding, id, *amount, session, &state, false);
            if state.unbound {
                envelope["session"] = Value::Null;
                if !state.omit_recovery {
                    envelope["recovery_required"] = state
                        .recovery_value
                        .clone()
                        .unwrap_or_else(|| json!(state.recovery_required));
                }
                if state.omit_session {
                    envelope.as_object_mut().unwrap().remove("session");
                }
                envelope["retry_safe_until"] = json!((Utc::now()
                    + chrono::Duration::hours(if state.retry_expired { -1 } else { 1 }))
                .to_rfc3339());
            }
            return Ok(envelope);
        }
        let session = path.strip_prefix("/hosted-checkouts/").unwrap();
        let (id, (amount, session)) = state
            .requests
            .iter()
            .find(|(_, (_, value))| value == session)
            .ok_or(Error::NotFound)?;
        Ok(self.envelope(binding, *id, *amount, session, &state, false))
    }
}
async fn setup() -> (PgPool, Actor, Uuid, Uuid, State) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable database required");
    let schema = format!("hosted_copay_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    crate::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |conn, _| {
            let q = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(&q).execute(conn).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    crate::MIGRATOR.run(&pool).await.unwrap();
    let tenant = Uuid::new_v4();
    let mut a = crate::delivery::worker(tenant);
    a.role = crate::auth::Role::Owner;
    a.iss = "suncharts".into();
    a.aud = "suncharts-engine".into();
    a.iat = Utc::now().timestamp();
    a.exp = a.iat + 120;
    let patient = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    let setting = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-HOSTED','Avery','Synthetic','1990-01-01')").bind(tenant).bind(patient).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')").bind(tenant).bind(appointment).bind(patient).bind(a.sub).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO payment_settings(tenant_id,id,mode) VALUES($1,$2,'suncharts_connect')",
    )
    .bind(tenant)
    .bind(setting)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO payment_credentials(tenant_id,setting_id,revision,encrypted_config) VALUES($1,$2,1,''::bytea)").bind(tenant).bind(setting).execute(&pool).await.unwrap();
    let state = State {
        backend: Arc::new(crate::postgres::PostgresBackend(pool.clone())),
        browser: Some(
            crate::browser::BrowserAuth::new(pool.clone(), "http://127.0.0.1:8099".into()).unwrap(),
        ),
        secret: "synthetic-hosted-only".into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
    };
    (pool, a, patient, appointment, state)
}
fn input(live: bool) -> Create {
    Create {
        request_id: Uuid::new_v4(),
        amount_cents: 2500,
        coverage_id: None,
        livemode: live,
        reason: "Reviewed synthetic copay".into(),
    }
}
fn policy(live: bool) -> Policy {
    Policy {
        production: false,
        live_enabled: live,
    }
}
async fn due(pool: &PgPool) {
    sqlx::query("UPDATE copay_checkout_attempts SET next_poll_at=now()-interval '1 minute'")
        .execute(pool)
        .await
        .unwrap();
}
async fn row(pool: &PgPool, a: &Actor, id: Uuid) -> Attempt {
    let mut tx = pool.begin().await.unwrap();
    load(&mut tx, a.tenant_id, id).await.unwrap()
}
async fn count(pool: &PgPool, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(pool)
        .await
        .unwrap()
}
async fn call(
    state: &State,
    a: &Actor,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (u16, Value) {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        a,
        &jsonwebtoken::EncodingKey::from_secret(state.secret.as_bytes()),
    )
    .unwrap();
    let mut req = Request::builder()
        .method("POST")
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        req = req.header("If-Match", format!("\"{v}\""));
    }
    let response = crate::app(state.clone())
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn posted_account(
    pool: &PgPool,
    a: &Actor,
    patient: Uuid,
    appointment: Uuid,
    state: &State,
) -> Uuid {
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,version,note,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',3,'{}',$5,now())").bind(a.tenant_id).bind(visit).bind(patient).bind(appointment).bind(a.sub).execute(pool).await.unwrap();
    let content = json!({"visit_id":visit,"coverage_id":null,"service_date":"2026-10-25","currency":"USD","lines":[{"code_system":"local","code":"SYN","description":"Synthetic office service","units":1,"amount_cents":10000,"modifiers":"","diagnosis_codes":["Z00.00"]}],"notes":"Synthetic"});
    let (status, account) = call(
        state,
        a,
        &format!("/api/v1/patients/{patient}/billing/accounts"),
        json!({"request_id":Uuid::new_v4(),"content":content,"reason":"Synthetic charges"}),
        None,
    )
    .await;
    assert_eq!(status, 200, "{account}");
    let id = serde_json::from_value(account["id"].clone()).unwrap();
    let (status, posted) = call(
        state,
        a,
        &format!("/api/v1/patients/{patient}/billing/accounts/{id}/actions"),
        json!({"action":"post","reason":"Reviewed synthetic charges"}),
        Some(1),
    )
    .await;
    assert_eq!(status, 200, "{posted}");
    id
}
#[tokio::test]
async fn durable_checkout_recovers_lost_response_captures_once_and_reconciles_refunds() {
    let (pool, a, patient, appointment, state) = setup().await;
    let broker = FakeBroker::new(false);
    broker.state.lock().unwrap().lose_create = true;
    let request = input(false);
    let request_id = request.request_id;
    let op = create_with(
        &pool,
        &a,
        patient,
        appointment,
        request,
        "http://127.0.0.1:8099",
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    assert_eq!(op.status, "creating");
    assert_eq!(count(&pool, "billing_copay_receipts").await, 0);
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(row(&pool, &a, op.id).await.status, "open");
    assert_eq!(
        broker.state.lock().unwrap().posts,
        1,
        "lost create response must retrieve the stable request, never charge twice"
    );
    let mut replay = input(false);
    replay.request_id = request_id;
    let same = create_with(
        &pool,
        &a,
        patient,
        appointment,
        replay,
        "http://127.0.0.1:8099",
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    assert_eq!(same.id, op.id);
    let mut wrong = input(false);
    wrong.request_id = request_id;
    wrong.amount_cents = 2600;
    assert!(create_with(
        &pool,
        &a,
        patient,
        appointment,
        wrong,
        "http://127.0.0.1:8099",
        &broker,
        policy(false)
    )
    .await
    .is_err());
    broker.state.lock().unwrap().paid = true;
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    let paid = row(&pool, &a, op.id).await;
    assert_eq!(paid.status, "paid");
    assert!(paid.receipt_id.is_some());
    let receipt_date: chrono::NaiveDate =
        sqlx::query_scalar("SELECT occurred_on FROM billing_copay_receipts WHERE id=$1")
            .bind(paid.receipt_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        receipt_date,
        paid.provider_captured_at.unwrap().date_naive()
    );
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
    assert_eq!(
        count(&pool, "billing_entries").await,
        0,
        "capture must work before charges"
    );
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
    broker.state.lock().unwrap().refunded = 500;
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(row(&pool, &a, op.id).await.refunded_cents, 500);
    assert_eq!(
        count(&pool, "billing_entries").await,
        0,
        "unapplied refund creates no account debit"
    );
    let account = posted_account(&pool, &a, patient, appointment, &state).await;
    let entries: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(e) FROM billing_entries e WHERE account_id=$1")
            .bind(account)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["effect_cents"], -2000);
    assert_eq!(entries[0]["content"]["test_mode"], true);
    assert_eq!(
        entries[0]["content"]["hosted_copay_operation_id"],
        op.id.to_string()
    );
    let (status, _) = call(
        &state,
        &a,
        &format!(
            "/api/v1/patients/{patient}/billing/copays/{}/void",
            paid.receipt_id.unwrap()
        ),
        json!({"reason":"Synthetic forbidden manual void"}),
        None,
    )
    .await;
    assert_eq!(status, 409);
    broker.state.lock().unwrap().refunded = 1500;
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    let total: i64 = sqlx::query_scalar(
        "SELECT sum(effect_cents)::bigint FROM billing_entries WHERE account_id=$1",
    )
    .bind(account)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(total, -1000);
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    let count_before = count(&pool, "billing_entries").await;
    assert_eq!(count_before, 2);
    broker.state.lock().unwrap().refunded = 1000;
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(row(&pool, &a, op.id).await.status, "needs_review");
    assert_eq!(
        count(&pool, "billing_entries").await,
        count_before,
        "out-of-order refund cannot undo confirmed evidence"
    );
    broker.state.lock().unwrap().refunded = 2500;
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(row(&pool, &a, op.id).await.status, "refunded");
    let total: i64 = sqlx::query_scalar(
        "SELECT sum(effect_cents)::bigint FROM billing_entries WHERE account_id=$1",
    )
    .bind(account)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(total, 0);
    assert!(
        sqlx::query("UPDATE copay_checkout_attempts SET amount_cents=1 WHERE id=$1")
            .bind(op.id)
            .execute(&pool)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn fake_live_capture_requires_matching_mode_authoritative_get_and_atomic_audit() {
    let (pool, a, patient, appointment, state) = setup().await;
    let broker = FakeBroker::new(true);
    broker.state.lock().unwrap().post_only_paid = true;
    assert!(create_with(
        &pool,
        &a,
        patient,
        appointment,
        input(true),
        "http://127.0.0.1:8099",
        &broker,
        policy(false)
    )
    .await
    .is_err());
    assert!(create_with(
        &pool,
        &a,
        patient,
        appointment,
        input(true),
        "http://127.0.0.1:8099",
        &broker,
        Policy {
            production: true,
            live_enabled: false
        }
    )
    .await
    .is_err());
    assert_eq!(
        broker.state.lock().unwrap().calls,
        0,
        "disabled mode must not contact the payment provider"
    );
    assert!(create_with(
        &pool,
        &a,
        patient,
        appointment,
        input(false),
        "http://127.0.0.1:8099",
        &broker,
        policy(true)
    )
    .await
    .is_err());
    assert_eq!(broker.state.lock().unwrap().posts, 0);
    let op = create_with(
        &pool,
        &a,
        patient,
        appointment,
        input(true),
        "http://127.0.0.1:8099",
        &broker,
        policy(true),
    )
    .await
    .unwrap();
    assert_eq!(op.status, "open");
    assert_eq!(
        count(&pool, "billing_copay_receipts").await,
        0,
        "a forged paid create response is not a receipt"
    );
    let account = posted_account(&pool, &a, patient, appointment, &state).await;
    {
        let mut fake = broker.state.lock().unwrap();
        fake.paid = true;
        fake.wrong_account = true;
    }
    due(&pool).await;
    poll(&pool, &broker, policy(true)).await.unwrap();
    assert_eq!(row(&pool, &a, op.id).await.status, "needs_review");
    assert_eq!(count(&pool, "billing_copay_receipts").await, 0);
    broker.state.lock().unwrap().wrong_account = false;
    sqlx::query("CREATE FUNCTION reject_hosted_receipt_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='billing.hosted_copay_recorded' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$").execute(&pool).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_hosted_receipt_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_hosted_receipt_audit()").execute(&pool).await.unwrap();
    due(&pool).await;
    poll(&pool, &broker, policy(true)).await.unwrap();
    assert_eq!(count(&pool, "billing_copay_receipts").await, 0);
    assert_eq!(
        count(&pool, "billing_entries").await,
        0,
        "receipt, allocation and audit must roll back together"
    );
    sqlx::query("DROP TRIGGER reject_hosted_receipt_audit ON audit_events")
        .execute(&pool)
        .await
        .unwrap();
    due(&pool).await;
    poll(&pool, &broker, policy(true)).await.unwrap();
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
    assert_eq!(count(&pool, "billing_entries").await, 1);
    let effect: Value = sqlx::query_scalar("SELECT content FROM billing_entries")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(effect["test_mode"], false);
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert!(scoped(&pool, &other, patient, appointment, op.id)
        .await
        .is_err());
    assert!(scoped(&pool, &a, Uuid::new_v4(), appointment, op.id)
        .await
        .is_err());
    let loaded = row(&pool, &a, op.id).await;
    let binding = loaded.binding();
    let snapshot = broker
        .call(
            &pool,
            &binding,
            Method::GET,
            &format!(
                "/hosted-checkouts/{}",
                loaded.provider_session_id.as_ref().unwrap()
            ),
            None,
        )
        .await
        .unwrap();
    for pointer in [
        "/livemode",
        "/session/livemode",
        "/session/payment_intent/livemode",
        "/session/payment_intent/latest_charge/livemode",
    ] {
        let mut invalid = snapshot.clone();
        *invalid.pointer_mut(pointer).unwrap() = json!(false);
        assert!(verify(&loaded, &invalid).is_err(), "{pointer}");
    }
    for pointer in [
        "/session/amount_total",
        "/session/payment_intent/amount_received",
        "/session/payment_intent/latest_charge/amount",
    ] {
        let mut invalid = snapshot.clone();
        *invalid.pointer_mut(pointer).unwrap() = json!(1);
        assert!(verify(&loaded, &invalid).is_err(), "{pointer}");
    }
    let mut invalid = snapshot.clone();
    invalid["session"]["payment_intent"]["latest_charge"]["captured"] = json!(false);
    assert!(verify(&loaded, &invalid).is_err());
    let mut disputed = snapshot.clone();
    disputed["session"]["payment_intent"]["latest_charge"]["disputed"] = json!(true);
    assert!(verify(&loaded, &disputed).is_err());
    for pointer in [
        "/installation_id",
        "/remote_tenant_id",
        "/request_id",
        "/session/client_reference_id",
        "/session/metadata/native_payment_id",
    ] {
        let mut invalid = snapshot.clone();
        *invalid.pointer_mut(pointer).unwrap() = json!(Uuid::new_v4());
        assert!(verify(&loaded, &invalid).is_err(), "{pointer}");
    }
    for pointer in [
        "/session/currency",
        "/session/payment_intent/currency",
        "/session/payment_intent/latest_charge/currency",
    ] {
        let mut invalid = snapshot.clone();
        *invalid.pointer_mut(pointer).unwrap() = json!("eur");
        assert!(verify(&loaded, &invalid).is_err(), "{pointer}");
    }

    for timestamp in [
        Value::Null,
        json!(0),
        json!(-1),
        json!(Utc::now().timestamp() + 1000),
        json!(1.5),
    ] {
        let mut invalid = snapshot.clone();
        invalid["session"]["payment_intent"]["latest_charge"]["created"] = timestamp;
        assert!(verify(&loaded, &invalid).is_err());
    }
    let mut delayed = loaded.clone();
    delayed.provider_captured_at = None;
    let captured = Utc::now() - chrono::Duration::days(2);
    let mut old = snapshot.clone();
    old["session"]["payment_intent"]["latest_charge"]["created"] = json!(captured.timestamp());
    assert_eq!(
        verify(&delayed, &old)
            .unwrap()
            .captured_at
            .unwrap()
            .date_naive(),
        captured.date_naive()
    );
    let entry: Uuid =
        sqlx::query_scalar("SELECT id FROM billing_entries WHERE account_id=$1 AND kind='payment'")
            .bind(account)
            .fetch_one(&pool)
            .await
            .unwrap();
    let version: i64 = sqlx::query_scalar("SELECT version FROM billing_accounts WHERE id=$1")
        .bind(account)
        .fetch_one(&pool)
        .await
        .unwrap();
    let (status,_)=call(&state,&a,&format!("/api/v1/patients/{patient}/billing/accounts/{account}/entries"),json!({"request_id":Uuid::new_v4(),"kind":"reversal","amount_cents":null,"reverses_id":entry,"party":"other","method":"none","reference":"","occurred_on":"2026-10-25","reason":"Manual hosted reversal forbidden"}),Some(version)).await;
    assert_eq!(status, 409);
    // Model an already-corrected historical allocation; a later refund must not debit it again.
    sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,reverses_id,actor_id) VALUES($1,$2,$3,'reversal',2500,'{\"party\":\"other\",\"reason\":\"Synthetic prior correction\"}',$2,'synthetic',$4,$5)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(account).bind(entry).bind(a.sub).execute(&pool).await.unwrap();
    broker.state.lock().unwrap().refunded = 2500;
    due(&pool).await;
    poll(&pool, &broker, policy(true)).await.unwrap();
    assert_eq!(row(&pool, &a, op.id).await.status, "refunded");
    assert_eq!(count(&pool, "billing_entries").await, 2);
    let debited: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM copay_checkout_refund_allocations WHERE entry_id IS NOT NULL)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!debited);
}

#[tokio::test]
async fn worker_failure_does_not_starve_other_appointments() {
    let (pool, a, patient, appointment, _) = setup().await;
    let broker = FakeBroker::new(false);
    let first = create_with(
        &pool,
        &a,
        patient,
        appointment,
        input(false),
        "http://127.0.0.1:8099",
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    let second_appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-26T14:00:00Z','2026-10-26T14:30:00Z','checked_in')").bind(a.tenant_id).bind(second_appointment).bind(patient).bind(a.sub).execute(&pool).await.unwrap();
    let second = create_with(
        &pool,
        &a,
        patient,
        second_appointment,
        input(false),
        "http://127.0.0.1:8099",
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    sqlx::query(&format!("CREATE FUNCTION reject_one_hosted_poll() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_id='{}'::uuid AND NEW.action='billing.hosted_copay_changed' THEN RAISE EXCEPTION 'synthetic operation unavailable'; END IF; RETURN NEW; END $$",first.id)).execute(&pool).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_one_hosted_poll BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_one_hosted_poll()").execute(&pool).await.unwrap();
    broker.state.lock().unwrap().paid = true;
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(row(&pool, &a, first.id).await.status, "open");
    assert_eq!(row(&pool, &a, second.id).await.status, "paid");
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
}
#[test]
fn production_hosted_policy_requires_explicit_live_gate_and_never_allows_test_evidence() {
    let off = Policy {
        production: true,
        live_enabled: false,
    };
    assert!(!off.permits(true));
    assert!(!off.permits(false));
    let on = Policy {
        production: true,
        live_enabled: true,
    };
    assert!(on.permits(true));
    assert!(!on.permits(false));
    let development = Policy {
        production: false,
        live_enabled: false,
    };
    assert!(development.permits(false));
    assert!(!development.permits(true));
}

#[tokio::test]
async fn unbound_provider_requests_retry_only_within_the_same_safe_contract() {
    let (pool, a, patient, appointment, _) = setup().await;
    let broker = FakeBroker::new(false);
    broker.state.lock().unwrap().lose_create = true;
    let op = create_with(
        &pool,
        &a,
        patient,
        appointment,
        input(false),
        "http://127.0.0.1:8099",
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    {
        let mut fake = broker.state.lock().unwrap();
        fake.unbound = true;
        fake.recovery_required = true;
    }
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(broker.state.lock().unwrap().posts, 1);
    assert_eq!(row(&pool, &a, op.id).await.status, "needs_review");
    for malformed in [Value::Null, json!("false"), json!(0)] {
        broker.state.lock().unwrap().recovery_value = Some(malformed);
        due(&pool).await;
        poll(&pool, &broker, policy(false)).await.unwrap();
        assert_eq!(broker.state.lock().unwrap().posts, 1);
    }
    {
        let mut fake = broker.state.lock().unwrap();
        fake.recovery_value = None;
        fake.omit_recovery = true;
        fake.recovery_required = false;
    }
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(broker.state.lock().unwrap().posts, 1);
    {
        let mut fake = broker.state.lock().unwrap();
        fake.omit_recovery = false;
        fake.omit_session = true;
    }
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(broker.state.lock().unwrap().posts, 1);
    broker.state.lock().unwrap().omit_session = false;
    {
        let mut fake = broker.state.lock().unwrap();
        fake.recovery_required = false;
        fake.retry_expired = true;
    }
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(broker.state.lock().unwrap().posts, 1);
    broker.state.lock().unwrap().retry_expired = false;
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(broker.state.lock().unwrap().posts, 2);
    assert_eq!(broker.state.lock().unwrap().requests.len(), 1);
    assert_eq!(row(&pool, &a, op.id).await.status, "open");
    assert_eq!(count(&pool, "billing_copay_receipts").await, 0);
}

#[tokio::test]
async fn shared_broker_fixture_matches_the_emitted_request_and_verified_capture() {
    let fixture: Value =
        serde_json::from_str(include_str!("../api/fixtures/hosted-copay-v1.json")).unwrap();
    let (pool, a, patient, appointment, _) = setup().await;
    let broker = FakeBroker::new(false);
    let mut op = create_with(
        &pool,
        &a,
        patient,
        appointment,
        input(false),
        fixture["origin"].as_str().unwrap(),
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    let mut expected = fixture["request"].clone();
    expected["request_id"] = json!(op.id);
    expected["return_url"] = json!(fixture["request"]["return_url"].as_str().unwrap().replace(
        fixture["request"]["request_id"].as_str().unwrap(),
        &op.id.to_string()
    ));
    assert_eq!(broker.state.lock().unwrap().posted_bodies, vec![expected]);

    // Validate the exact cross-repository fixture with the production verifier;
    // the stored account/session fields must match the fixture's binding.
    let response = &fixture["response"];
    op.id = serde_json::from_value(fixture["request"]["request_id"].clone()).unwrap();
    op.tenant_id = serde_json::from_value(response["remote_tenant_id"].clone()).unwrap();
    op.installation_id = serde_json::from_value(response["installation_id"].clone()).unwrap();
    op.provider_account_id = fixture["request"]["account_id"].as_str().unwrap().into();
    op.amount_cents = fixture["request"]["amount_cents"].as_i64().unwrap();
    op.livemode = fixture["request"]["livemode"].as_bool().unwrap();
    op.currency = fixture["request"]["currency"].as_str().unwrap().into();
    op.provider_session_id = None;
    let capture = verify(&op, response).unwrap();
    assert!(capture.paid);
    assert_eq!(capture.charge.as_deref(), Some("ch_contract"));
    assert_eq!(capture.captured_at.unwrap().timestamp(), 1_735_689_600);
    assert!(!identifier("acct_", "acct_"));
}

#[tokio::test]
async fn transfers_only_or_unknown_card_capability_cannot_reserve_a_copay() {
    let (pool, a, patient, appointment, _) = setup().await;
    let broker = FakeBroker::new(false);
    for proof in [Value::Null, json!(false), json!("active")] {
        broker.state.lock().unwrap().card_capability_override = Some(proof);
        let error = create_with(
            &pool,
            &a,
            patient,
            appointment,
            input(false),
            "http://127.0.0.1:8099",
            &broker,
            policy(false),
        )
        .await
        .err()
        .unwrap();
        assert!(error.to_string().contains("not enabled"));
        assert_eq!(count(&pool, "copay_checkout_attempts").await, 0);
        assert_eq!(count(&pool, "billing_copay_receipts").await, 0);
        assert_eq!(broker.state.lock().unwrap().posts, 0);
    }
    broker.state.lock().unwrap().card_capability_override = Some(json!(true));
    let attempt = create_with(
        &pool,
        &a,
        patient,
        appointment,
        input(false),
        "http://127.0.0.1:8099",
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    assert_eq!(attempt.status, "open");
    assert_eq!(broker.state.lock().unwrap().posts, 1);
    pool.close().await;
}
