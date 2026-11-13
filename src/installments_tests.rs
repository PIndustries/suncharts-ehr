// SPDX-License-Identifier: AGPL-3.0-only
use super::*;
use async_trait::async_trait;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use std::{
    collections::{BTreeMap, BTreeSet},
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
    paid_requests: BTreeSet<Uuid>,
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
    null_bound_session: bool,
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
        let paid =
            state.paid || state.paid_requests.contains(&id) || (post && state.post_only_paid);
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
        let mut value = self.envelope(binding, *id, *amount, session, &state, false);
        if state.null_bound_session {
            value["session"] = Value::Null;
            value["recovery_required"] = json!(false);
            value["retry_safe_until"] =
                json!((Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
        }
        Ok(value)
    }
}
async fn setup() -> (PgPool, Actor, Uuid, Uuid, State) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable database required");
    let schema = format!("invoice_installments_{}", Uuid::new_v4().simple());
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

async fn payment_history(state: &State, a: &Actor, patient: Uuid) -> Value {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        a,
        &jsonwebtoken::EncodingKey::from_secret(state.secret.as_bytes()),
    )
    .unwrap();
    let req = Request::builder()
        .uri(format!(
            "/api/v1/billing/patients/{patient}/payment-history?mode=test"
        ))
        .header("Authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = crate::app(state.clone()).oneshot(req).await.unwrap();
    assert_eq!(response.status(), 200);
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
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

fn policy(live: bool) -> Policy {
    Policy {
        production: false,
        live_enabled: live,
    }
}
async fn fixture() -> (PgPool, Actor, Uuid, Uuid, Uuid, State) {
    let (pool, a, p, appointment, s) = setup().await;
    let account = posted_account(&pool, &a, p, appointment, &s).await;
    let(code,i)=call(&s,&a,&format!("/api/v1/patients/{p}/billing/accounts/{account}/invoices"),json!({"request_id":Uuid::new_v4(),"responsibility_cents":3000,"reason":"Reviewed synthetic patient share"}),Some(2)).await;
    assert_eq!(code, 200, "{i}");
    (
        pool,
        a,
        p,
        account,
        serde_json::from_value(i["id"].clone()).unwrap(),
        s,
    )
}
fn plan_input(invoice_id: Uuid, live: bool) -> Create {
    Create {
        invoice_id,
        livemode: live,
        installments: vec![
            Installment {
                due_on: Utc::now().date_naive(),
                amount_cents: 1500,
            },
            Installment {
                due_on: Utc::now().date_naive() + chrono::Duration::days(30),
                amount_cents: 1500,
            },
        ],
        request_id: Uuid::new_v4(),
        reason: "Agreed synthetic finite plan".into(),
        consent: true,
    }
}
fn checkout_input() -> Checkout {
    Checkout {
        amount_cents: 1500,
        request_id: Uuid::new_v4(),
        reason: "Patient present for scheduled payment".into(),
        patient_present: true,
        reader_id: None,
    }
}
async fn read_plan(pool: &PgPool, a: &Actor, patient: Uuid, id: Uuid) -> Value {
    let mut tx = pool.begin().await.unwrap();
    let p = plan(&mut tx, a, patient, id).await.unwrap();
    plan_value(&mut tx, a, &p, policy(false)).await.unwrap()
}
async fn row(pool: &PgPool, a: &Actor, id: Uuid) -> Attempt {
    let mut tx = pool.begin().await.unwrap();
    attempt(&mut tx, a, id).await.unwrap()
}
async fn count(pool: &PgPool, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(pool)
        .await
        .unwrap()
}
async fn financial(pool: &PgPool, a: &Actor, account: Uuid) -> (i64, i64) {
    let mut tx = pool.begin().await.unwrap();
    billing::patient_ledger_totals(&mut tx, a.tenant_id, account)
        .await
        .unwrap()
}

#[tokio::test]
async fn finite_invoice_collections_recover_once_and_append_refunds_without_rewriting_invoice() {
    let (pool, a, patient, account, invoice, s) = fixture().await;
    let broker = FakeBroker::new(false);
    let input = plan_input(invoice, false);
    let key = input.request_id;
    let saved: Value =
        sqlx::query_scalar("SELECT to_jsonb(i) FROM patient_invoice_snapshots i WHERE id=$1")
            .bind(invoice)
            .fetch_one(&pool)
            .await
            .unwrap();
    let p = create_with(&pool, &a, patient, input, 2, policy(false))
        .await
        .unwrap();
    let pid = serde_json::from_value(p["id"].clone()).unwrap();
    assert_eq!(p["remaining_cents"], 3000);
    assert_eq!(p["autopay"], false);
    assert_eq!(count(&pool, "billing_entries").await, 0);
    let mut replay = plan_input(invoice, false);
    replay.request_id = key;
    assert_eq!(
        create_with(&pool, &a, patient, replay, 2, policy(false))
            .await
            .unwrap()["id"],
        p["id"]
    );
    broker.state.lock().unwrap().lose_create = true;
    let input = checkout_input();
    let retry = Checkout {
        amount_cents: input.amount_cents,
        request_id: input.request_id,
        reason: input.reason.clone(),
        patient_present: true,
        reader_id: None,
    };
    let first = checkout_with(
        &pool,
        &a,
        patient,
        pid,
        1,
        input,
        1,
        "https://synthetic.example",
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    let op: Uuid = serde_json::from_value(first["operation"]["id"].clone()).unwrap();
    assert_eq!(first["operation"]["status"], "creating");
    let blocked_legacy = crate::payments::create_native(
        &s,
        &a,
        account,
        2,
        crate::payments::NewPayment {
            request_id: Uuid::new_v4(),
            amount_cents: 1500,
        },
    )
    .await;
    assert!(matches!(
        blocked_legacy,
        Err(Error::Conflict(
            "reconcile the existing invoice collection before starting another payment"
        ))
    ));
    assert_eq!(count(&pool, "payment_attempts").await, 0);

    assert_eq!(financial(&pool, &a, account).await, (0, 0));
    assert_eq!(broker.state.lock().unwrap().posts, 1);
    let restored = checkout_with(
        &pool,
        &a,
        patient,
        pid,
        1,
        retry,
        1,
        "https://synthetic.example",
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    assert_eq!(restored["operation"]["status"], "open");
    assert_eq!(broker.state.lock().unwrap().posts, 1);
    assert!(checkout_with(
        &pool,
        &a,
        patient,
        pid,
        2,
        checkout_input(),
        restored["plan"]["version"].as_i64().unwrap(),
        "https://synthetic.example",
        &broker,
        policy(false)
    )
    .await
    .is_err());
    broker.state.lock().unwrap().paid = true;
    process(&pool, &a, op, &broker, policy(false), false)
        .await
        .unwrap();
    process(&pool, &a, op, &broker, policy(false), false)
        .await
        .unwrap();
    assert_eq!(financial(&pool, &a, account).await, (1500, 1500));
    assert_eq!(count(&pool, "billing_entries").await, 1);
    assert_eq!(
        read_plan(&pool, &a, patient, pid).await["remaining_cents"],
        1500
    );
    let receipt = row(&pool, &a, op).await;
    assert!(receipt.paid_entry_id.is_some());
    let before = receipt.provider_captured_at;
    let version: i64 = sqlx::query_scalar("SELECT version FROM billing_accounts WHERE id=$1")
        .bind(account)
        .fetch_one(&pool)
        .await
        .unwrap();
    let (status,_)=call(&s,&a,&format!("/api/v1/patients/{patient}/billing/accounts/{account}/entries"),json!({"request_id":Uuid::new_v4(),"kind":"reversal","amount_cents":null,"reverses_id":receipt.paid_entry_id,"party":"other","method":"none","reference":"","occurred_on":Utc::now().date_naive(),"reason":"Manual processor reversal forbidden"}),Some(version)).await;
    assert_eq!(status, 409);
    broker.state.lock().unwrap().refunded = 500;
    process(&pool, &a, op, &broker, policy(false), false)
        .await
        .unwrap();
    process(&pool, &a, op, &broker, policy(false), false)
        .await
        .unwrap();
    assert_eq!(financial(&pool, &a, account).await, (1000, 1000));
    assert_eq!(count(&pool, "billing_entries").await, 2);
    assert_eq!(count(&pool, "invoice_checkout_refunds").await, 1);
    let history = payment_history(&s, &a, patient).await;
    assert_eq!(history["items"].as_array().unwrap().len(), 1);
    assert_eq!(history["items"][0]["refunded_cents"], 500);
    assert_eq!(history["items"][0]["unapplied_cents"], 0);
    assert_eq!(history["items"][0]["ledger_recorded"], true);
    assert_eq!(row(&pool, &a, op).await.provider_captured_at, before);
    assert_eq!(
        read_plan(&pool, &a, patient, pid).await["remaining_cents"],
        2000
    );
    broker.state.lock().unwrap().refunded = 0;
    process(&pool, &a, op, &broker, policy(false), false)
        .await
        .unwrap();
    assert_eq!(row(&pool, &a, op).await.status, "needs_review");
    assert_eq!(financial(&pool, &a, account).await, (1000, 1000));
    let after: Value =
        sqlx::query_scalar("SELECT to_jsonb(i) FROM patient_invoice_snapshots i WHERE id=$1")
            .bind(invoice)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(saved, after);
    let body = &broker.state.lock().unwrap().posted_bodies[0];
    assert_eq!(
        body["return_url"],
        format!("https://synthetic.example/?invoice_checkout={op}")
    );
    assert_eq!(body["amount_cents"], 1500);
    assert_eq!(body["livemode"], false);
}

#[tokio::test]
async fn invoice_collection_pauses_changed_responsibility_and_retains_late_capture_unapplied() {
    let (pool, a, patient, account, invoice, state) = fixture().await;
    let broker = FakeBroker::new(false);
    let p = create_with(
        &pool,
        &a,
        patient,
        plan_input(invoice, false),
        2,
        policy(false),
    )
    .await
    .unwrap();
    let pid = serde_json::from_value(p["id"].clone()).unwrap();
    let out = checkout_with(
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
    let op = serde_json::from_value(out["operation"]["id"].clone()).unwrap();
    // A simulated posted payer remittance is appended, never a provider call.
    let mut tx = pool.begin().await.unwrap();
    billing::tenant_lock(&mut tx, &a).await.unwrap();
    let entry = Uuid::new_v4();
    sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id) VALUES($1,$2,$3,'payment',-7000,'{\"party\":\"insurer\",\"method\":\"eft\"}',$2,'synthetic',$4)").bind(a.tenant_id).bind(entry).bind(account).bind(a.sub).execute(&mut *tx).await.unwrap();
    sqlx::query("UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(account)
        .execute(&mut *tx)
        .await
        .unwrap();
    billing::account_revision(&mut tx, &a, patient, account, "Synthetic payer remittance")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    broker.state.lock().unwrap().paid = true;
    process(&pool, &a, op, &broker, policy(false), false)
        .await
        .unwrap();
    let r = row(&pool, &a, op).await;
    assert_eq!(r.status, "needs_review");
    assert!(r.provider_captured_at.is_some());
    assert!(r.paid_entry_id.is_none());
    assert_eq!(r.public(policy(false))["unapplied_cents"], 1500);
    let history = payment_history(&state, &a, patient).await;
    let items = history["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["kind"], "invoice_checkout");
    assert_eq!(items[0]["received_cents"], 1500);
    assert_eq!(items[0]["unapplied_cents"], 1500);
    assert_eq!(items[0]["ledger_recorded"], false);
    assert_eq!(items[0]["status"], "needs_review");
    assert_eq!(financial(&pool, &a, account).await, (0, 0));
    assert_eq!(count(&pool, "billing_entries").await, 1);
    let current = read_plan(&pool, &a, patient, pid).await;
    assert_eq!(current["status"], "needs_review");
    assert!(checkout_with(
        &pool,
        &a,
        patient,
        pid,
        2,
        checkout_input(),
        current["version"].as_i64().unwrap(),
        "https://synthetic.example",
        &broker,
        policy(false)
    )
    .await
    .is_err());
    broker.state.lock().unwrap().refunded = 1500;
    process(&pool, &a, op, &broker, policy(false), false)
        .await
        .unwrap();
    assert_eq!(row(&pool, &a, op).await.status, "refunded");
    assert_eq!(financial(&pool, &a, account).await, (0, 0));
    assert_eq!(count(&pool, "invoice_checkout_refunds").await, 1);
    let history = payment_history(&state, &a, patient).await;
    assert_eq!(history["items"].as_array().unwrap().len(), 1);
    assert_eq!(history["items"][0]["refunded_cents"], 1500);
    assert_eq!(history["items"][0]["unapplied_cents"], 0);
}

#[tokio::test]
async fn invoice_return_never_creates_and_rejects_wrong_provider_identity() {
    let (pool, a, patient, account, invoice, _) = fixture().await;
    let broker = FakeBroker::new(false);
    let p = create_with(
        &pool,
        &a,
        patient,
        plan_input(invoice, false),
        2,
        policy(false),
    )
    .await
    .unwrap();
    let pid = serde_json::from_value(p["id"].clone()).unwrap();
    broker.state.lock().unwrap().lose_create = true;
    let out = checkout_with(
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
    let id = serde_json::from_value(out["operation"]["id"].clone()).unwrap();
    let calls = broker.state.lock().unwrap().calls;
    process(&pool, &a, id, &broker, policy(false), false)
        .await
        .unwrap();
    assert_eq!(broker.state.lock().unwrap().calls, calls);
    process(&pool, &a, id, &broker, policy(false), true)
        .await
        .unwrap();
    broker.state.lock().unwrap().null_bound_session = true;
    process(&pool, &a, id, &broker, policy(false), false)
        .await
        .unwrap();
    assert_eq!(broker.state.lock().unwrap().posts, 1);
    assert_eq!(row(&pool, &a, id).await.status, "needs_review");
    {
        let mut state = broker.state.lock().unwrap();
        state.null_bound_session = false;
        state.paid = true;
        state.wrong_account = true;
    }
    process(&pool, &a, id, &broker, policy(false), false)
        .await
        .unwrap();
    assert_eq!(financial(&pool, &a, account).await, (0, 0));
    assert!(row(&pool, &a, id).await.provider_captured_at.is_none());
    {
        let mut state = broker.state.lock().unwrap();
        state.wrong_account = false;
        state
            .created_times
            .insert(id, Utc::now().timestamp() + 3600);
    }
    process(&pool, &a, id, &broker, policy(false), false)
        .await
        .unwrap();
    assert_eq!(financial(&pool, &a, account).await, (0, 0));
}

#[tokio::test]
async fn plans_enforce_schedule_tenant_permissions_live_gate_and_atomic_audit() {
    let (pool, a, patient, account, invoice, s) = fixture().await;
    let mut bad = plan_input(invoice, false);
    bad.installments[1].amount_cents = 1499;
    assert!(create_with(&pool, &a, patient, bad, 2, policy(false))
        .await
        .is_err());
    assert_eq!(count(&pool, "patient_installment_plans").await, 0);
    let p = create_with(
        &pool,
        &a,
        patient,
        plan_input(invoice, true),
        2,
        policy(true),
    )
    .await
    .unwrap();
    let pid = serde_json::from_value(p["id"].clone()).unwrap();
    let broker = FakeBroker::new(true);
    assert!(checkout_with(
        &pool,
        &a,
        patient,
        pid,
        1,
        checkout_input(),
        1,
        "https://synthetic.example",
        &broker,
        Policy {
            production: true,
            live_enabled: false
        }
    )
    .await
    .is_err());
    assert_eq!(broker.state.lock().unwrap().calls, 0);
    assert_eq!(count(&pool, "invoice_checkout_attempts").await, 0);
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert!(read_plan_result(&pool, &other, patient, pid).await.is_err());
    let mut role = a.clone();
    role.role = crate::auth::Role::ReadOnly;
    let (path, body) = (
        format!(
            "/api/v1/billing/patients/{patient}/installment-plans/{pid}/installments/1/checkout"
        ),
        json!({"request_id":Uuid::new_v4(),"reason":"Patient present","patient_present":true,"amount_cents":1500}),
    );
    assert_eq!(call(&s, &role, &path, body, Some(1)).await.0, 403);
    let out = checkout_with(
        &pool,
        &a,
        patient,
        pid,
        1,
        checkout_input(),
        1,
        "https://synthetic.example",
        &broker,
        policy(true),
    )
    .await
    .unwrap();
    let id = serde_json::from_value(out["operation"]["id"].clone()).unwrap();
    broker.state.lock().unwrap().paid = true;
    sqlx::raw_sql("CREATE FUNCTION fail_invoice_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='billing.account_change' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_invoice_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_invoice_audit()").execute(&pool).await.unwrap();
    process(&pool, &a, id, &broker, policy(true), false)
        .await
        .unwrap();
    assert_eq!(financial(&pool, &a, account).await, (0, 0));
    assert_eq!(count(&pool, "billing_entries").await, 0);
    assert!(row(&pool, &a, id).await.paid_entry_id.is_none());
    sqlx::query("DROP TRIGGER fail_invoice_audit ON audit_events")
        .execute(&pool)
        .await
        .unwrap();
    process(&pool, &a, id, &broker, policy(true), false)
        .await
        .unwrap();
    assert_eq!(financial(&pool, &a, account).await, (1500, 1500));
    assert!(
        sqlx::query("UPDATE patient_installment_plans SET total_cents=2000 WHERE id=$1")
            .bind(pid)
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM patient_installment_plans WHERE id=$1")
            .bind(pid)
            .execute(&pool)
            .await
            .is_err()
    );
}
async fn read_plan_result(pool: &PgPool, a: &Actor, p: Uuid, id: Uuid) -> Result<Plan> {
    let mut tx = pool.begin().await?;
    plan(&mut tx, a, p, id).await
}
#[tokio::test]
async fn later_verified_patient_payments_reduce_each_installment_without_using_gross_balance() {
    let (pool, a, patient, account, invoice, s) = fixture().await;
    async fn cash(s: &State, a: &Actor, p: Uuid, account: Uuid, amount: i64, version: i64) {
        let(code,v)=call(s,a,&format!("/api/v1/patients/{p}/billing/accounts/{account}/entries"),json!({"request_id":Uuid::new_v4(),"kind":"payment","amount_cents":amount,"reverses_id":null,"party":"patient","method":"cash","reference":"Synthetic received cash","occurred_on":Utc::now().date_naive(),"reason":"Confirmed synthetic cash payment"}),Some(version)).await;
        assert_eq!(code, 200, "{v}");
    }
    cash(&s, &a, patient, account, 1000, 2).await;
    let mut input = plan_input(invoice, true);
    input
        .installments
        .iter_mut()
        .for_each(|v| v.amount_cents = 1000);
    let p = create_with(&pool, &a, patient, input, 3, policy(true))
        .await
        .unwrap();
    assert_eq!(p["total_cents"], 2000);
    let pid = serde_json::from_value(p["id"].clone()).unwrap();
    let broker = FakeBroker::new(true);
    let out = checkout_with(
        &pool,
        &a,
        patient,
        pid,
        1,
        Checkout {
            amount_cents: 1000,
            ..checkout_input()
        },
        1,
        "https://synthetic.example",
        &broker,
        policy(true),
    )
    .await
    .unwrap();
    let id = serde_json::from_value(out["operation"]["id"].clone()).unwrap();
    cash(&s, &a, patient, account, 500, 3).await;
    broker.state.lock().unwrap().paid = true;
    process(&pool, &a, id, &broker, policy(true), false)
        .await
        .unwrap();
    let p = read_plan(&pool, &a, patient, pid).await;
    assert_eq!(p["remaining_cents"], 500);
    let out = checkout_with(
        &pool,
        &a,
        patient,
        pid,
        2,
        Checkout {
            amount_cents: 500,
            ..checkout_input()
        },
        p["version"].as_i64().unwrap(),
        "https://synthetic.example",
        &broker,
        policy(true),
    )
    .await
    .unwrap();
    assert_eq!(out["operation"]["amount_cents"], 500);
    assert_eq!(out["plan"]["status"], "complete");
    assert_eq!(out["plan"]["remaining_cents"], 0);
    assert_eq!(financial(&pool, &a, account).await, (3000, 3000));
    assert_eq!(count(&pool, "billing_entries").await, 4);
    assert_eq!(broker.state.lock().unwrap().posts, 2);
    assert_eq!(
        broker.state.lock().unwrap().posted_bodies[1]["amount_cents"],
        500
    );
}
#[tokio::test]
async fn billing_only_policy_is_intersected_and_uncertain_creates_are_not_replayed_by_returns() {
    let (pool, a, patient, _, invoice, s) = fixture().await;
    let mut staff = a.clone();
    staff.sub = Uuid::new_v4();
    staff.role = crate::auth::Role::FrontDesk;
    let policy_id = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'installment-billing@example.test','not-a-login-hash','front_desk')").bind(a.tenant_id).bind(staff.sub).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Synthetic billing only','front_desk',$3,$4)").bind(a.tenant_id).bind(policy_id).bind(json!({"billing":{"view":true,"create":true,"edit":false,"delete":false},"clinical":{"view":false}})).bind(a.sub).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)").bind(a.tenant_id).bind(staff.sub).bind(policy_id).bind(a.sub).execute(&pool).await.unwrap();
    assert!(authorize(&s, &staff, "view").await.is_ok());
    assert!(authorize(&s, &staff, "create").await.is_ok());
    assert!(authorize(&s, &staff, "edit").await.is_err());
    let p = create_with(
        &pool,
        &a,
        patient,
        plan_input(invoice, false),
        2,
        policy(false),
    )
    .await
    .unwrap();
    let pid = serde_json::from_value(p["id"].clone()).unwrap();
    let broker = FakeBroker::new(false);
    broker.state.lock().unwrap().lose_create = true;
    let input = checkout_input();
    let out = checkout_with(
        &pool,
        &a,
        patient,
        pid,
        1,
        input,
        1,
        "https://synthetic.example",
        &broker,
        policy(false),
    )
    .await
    .unwrap();
    let id: Uuid = serde_json::from_value(out["operation"]["id"].clone()).unwrap();
    // An explicitly recovered reservation can be older than the safety window;
    // the immutable trigger is disabled ONLY in this disposable fixture to model it.
    sqlx::query("ALTER TABLE invoice_checkout_attempts DISABLE TRIGGER invoice_checkout_protected")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE invoice_checkout_attempts SET created_at=now()-interval '24 hours' WHERE id=$1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("ALTER TABLE invoice_checkout_attempts ENABLE TRIGGER invoice_checkout_protected")
        .execute(&pool)
        .await
        .unwrap();
    {
        let mut b = broker.state.lock().unwrap();
        b.unbound = true;
        b.retry_expired = true;
    }
    process(&pool, &a, id, &broker, policy(false), true)
        .await
        .unwrap();
    assert_eq!(broker.state.lock().unwrap().posts, 1);
    assert_eq!(row(&pool, &a, id).await.status, "needs_review");
    let calls = broker.state.lock().unwrap().calls;
    process(&pool, &a, id, &broker, policy(false), false)
        .await
        .unwrap();
    assert_eq!(broker.state.lock().unwrap().calls, calls);
    assert_eq!(unavailable().status(), StatusCode::SERVICE_UNAVAILABLE);
}

include!("installments_reader_tests.rs");
