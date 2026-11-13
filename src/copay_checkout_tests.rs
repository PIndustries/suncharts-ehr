// SPDX-License-Identifier: AGPL-3.0-only
use super::*;
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
        reader_id: None,
        saved_card_setup_id: None,
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

// Keep this full-cycle fixture on authenticated application routes. Only the
// outbound provider boundaries are replaced with synthetic test implementations.
async fn rcm_request(
    state: &State,
    a: &Actor,
    method: &str,
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
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");
    if let Some(version) = version {
        request = request.header("If-Match", format!("\"{version}\""));
    }
    let response = crate::app(state.clone())
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!(String::from_utf8(bytes.to_vec()).unwrap()));
    (status, value)
}

async fn rcm_ok(
    state: &State,
    a: &Actor,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> Value {
    let (status, value) = rcm_request(state, a, method, path, body, version).await;
    assert!(
        (200..300).contains(&status),
        "{method} {path}: {status} {value}"
    );
    value
}

#[tokio::test]
async fn checkout_return_resolves_only_authorized_operation_without_financial_writes() {
    let (pool, a, patient, appointment, state) = setup().await;
    let broker = FakeBroker::new(false);
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
    let before = row(&pool, &a, op.id).await.public(policy(false));
    let path = format!("/api/v1/billing/copay-checkouts/{}", op.id);
    let returned = rcm_ok(&state, &a, "GET", &path, Value::Null, None).await;
    assert_eq!(returned["operation"], before);
    assert_eq!(returned["operation"]["patient_id"], json!(patient));
    assert_eq!(returned["operation"]["appointment_id"], json!(appointment));
    assert_eq!(returned["operation"]["status"], "open");
    assert!(returned["operation"]["receipt_id"].is_null());
    assert_eq!(row(&pool, &a, op.id).await.public(policy(false)), before);
    assert_eq!(count(&pool, "billing_copay_receipts").await, 0);
    assert_eq!(count(&pool, "billing_entries").await, 0);
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    for method in ["GET", "POST"] {
        let route = if method == "POST" {
            format!("{path}/refresh")
        } else {
            path.clone()
        };
        assert_eq!(
            rcm_request(&state, &other, method, &route, Value::Null, None)
                .await
                .0,
            404
        );
    }
    other = a.clone();
    other.role = crate::auth::Role::Patient;
    other.patient_id = Some(patient);
    assert_eq!(
        rcm_request(&state, &other, "GET", &path, Value::Null, None)
            .await
            .0,
        403
    );
    other.role = crate::auth::Role::ReadOnly;
    other.patient_id = None;
    assert_eq!(
        rcm_request(
            &state,
            &other,
            "POST",
            &format!("{path}/refresh"),
            Value::Null,
            None
        )
        .await
        .0,
        403
    );

    // A clinical staff identity with a billing-denied custom role cannot use
    // the return resolver to discover patient or appointment IDs.
    other.sub = Uuid::new_v4();
    other.role = crate::auth::Role::Clinician;
    let access = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,'return-synthetic@example.test','synthetic','clinician')").bind(other.sub).bind(a.tenant_id).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Synthetic no billing','clinician',$3,$4)").bind(a.tenant_id).bind(access).bind(json!({"clinical":{"view":true},"billing":{"view":false}})).bind(a.sub).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)").bind(a.tenant_id).bind(other.sub).bind(access).bind(a.sub).execute(&pool).await.unwrap();
    assert_eq!(
        rcm_request(&state, &other, "GET", &path, Value::Null, None)
            .await
            .0,
        403
    );
    assert_eq!(broker.state.lock().unwrap().posts, 1);
    assert_eq!(row(&pool, &a, op.id).await.public(policy(false)), before);
}

#[tokio::test]
async fn checkout_return_reconciliation_never_creates_and_records_verified_capture_once() {
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
    assert!(op.provider_session_id.is_none());
    let calls = broker.state.lock().unwrap().calls;
    process_id_mode(&pool, &a, op.id, &broker, policy(false), false)
        .await
        .unwrap();
    assert_eq!(
        broker.state.lock().unwrap().calls,
        calls,
        "return must not recover an unbound create"
    );
    assert_eq!(count(&pool, "billing_copay_receipts").await, 0);
    // The normal durable worker can independently recover the original binding.
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert!(row(&pool, &a, op.id).await.provider_session_id.is_some());
    process_id_mode(&pool, &a, op.id, &broker, policy(false), false)
        .await
        .unwrap();
    assert_eq!(
        count(&pool, "billing_copay_receipts").await,
        0,
        "an unpaid/cancelled browser return is not capture evidence"
    );
    broker.state.lock().unwrap().paid = true;
    process_id_mode(&pool, &a, op.id, &broker, policy(false), false)
        .await
        .unwrap();
    let captured = row(&pool, &a, op.id).await;
    assert_eq!(captured.status, "paid");
    assert!(captured.receipt_id.is_some());
    process_id_mode(&pool, &a, op.id, &broker, policy(false), false)
        .await
        .unwrap();
    assert_eq!(row(&pool, &a, op.id).await.receipt_id, captured.receipt_id);
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
    assert_eq!(count(&pool, "billing_entries").await, 0);
    // Even contradictory null-session evidence with a valid retry window must
    // not fall through to the worker's POST-create recovery branch.
    broker.state.lock().unwrap().null_bound_session = true;
    process_id_mode(&pool, &a, op.id, &broker, policy(false), false)
        .await
        .unwrap();
    assert_eq!(row(&pool, &a, op.id).await.status, "needs_review");
    assert_eq!(broker.state.lock().unwrap().posts, 1);
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
}

#[tokio::test]
async fn hosted_copay_through_claimmd_835_and_invoice_preserves_full_revenue_cycle() {
    let (pool, a, patient, appointment, state) = setup().await;
    let billing_path = format!("/api/v1/patients/{patient}/billing");
    let payer = rcm_ok(
        &state,
        &a,
        "POST",
        "/api/v1/billing/payers",
        json!({
        "request_id":Uuid::new_v4(),"content":{"name":"Synthetic Insurance",
        "payer_code":"SYN-ONLY","phone":"","address":"Synthetic address","active":true},
        "reason":"Synthetic revenue cycle directory"}),
        None,
    )
    .await;
    let coverage = rcm_ok(
        &state,
        &a,
        "POST",
        &format!("/api/v1/patients/{patient}/coverages"),
        json!({
        "request_id":Uuid::new_v4(),"content":{"payer_id":payer["id"],"priority":"primary",
        "status":"active","member_id":"SYNTHETIC-POLICY-01","group_number":"SYN-GROUP",
        "plan_name":"Synthetic plan","subscriber_name":"Avery Synthetic",
        "subscriber_birth_date":"1990-01-01","relationship":"self","effective_date":"2026-01-01",
        "end_date":"2026-12-31","copay_cents":2500,"verification":"unverified","notes":""},
        "reason":"Reviewed synthetic policy and copay"}),
        None,
    )
    .await;

    // The real durable orchestration reserves the checkout before fake provider
    // I/O. Neither a checkout return nor the POST response records a payment.
    let broker = FakeBroker::new(false);
    let mut request = input(false);
    request.coverage_id = serde_json::from_value(coverage["id"].clone()).unwrap();
    let operation = create_with(
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
    assert_eq!(operation.status, "open");
    assert_eq!(count(&pool, "billing_copay_receipts").await, 0);
    assert_eq!(count(&pool, "billing_entries").await, 0);
    broker.state.lock().unwrap().paid = true;
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    let operation_path = format!(
        "/api/v1/patients/{patient}/appointments/{appointment}/copay-checkouts/{}",
        operation.id
    );
    let captured = rcm_ok(&state, &a, "GET", &operation_path, Value::Null, None).await;
    assert_eq!(captured["operation"]["status"], "paid");
    assert_eq!(captured["operation"]["livemode"], false);
    assert!(captured["operation"]["receipt_id"].is_string());
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
    assert_eq!(count(&pool, "billing_entries").await, 0);
    assert_eq!(broker.state.lock().unwrap().posts, 1);

    // Clinician work is saved and signed through the same versioned APIs as the
    // encounter UI, with two diagnoses and separately linked procedure lines.
    let visit = rcm_ok(
        &state,
        &a,
        "POST",
        "/api/v1/visits",
        json!({"appointment_id":appointment}),
        None,
    )
    .await;
    let visit_path = format!("/api/v1/visits/{}", visit["id"].as_str().unwrap());
    let diagnoses = rcm_ok(
        &state,
        &a,
        "PUT",
        &format!("{visit_path}/diagnoses"),
        json!({
        "diagnoses":[{"code":"Z00.00","display":"Synthetic examination"},
        {"code":"M62.81","display":"Synthetic weakness assessment"}],
        "reason":"Synthetic encounter diagnoses"}),
        Some(1),
    )
    .await;
    let account = rcm_ok(
        &state,
        &a,
        "POST",
        &format!("{billing_path}/accounts"),
        json!({
        "request_id":Uuid::new_v4(),"content":{"visit_id":visit["id"],"coverage_id":coverage["id"],
        "service_date":"2026-10-25","currency":"USD","lines":[
        {"code_system":"CPT","code":"99213","description":"Synthetic office service",
        "modifiers":"25","units":1,"amount_cents":15000,"diagnosis_codes":[]},
        {"code_system":"CPT","code":"97110","description":"Synthetic therapy service",
        "modifiers":"","units":2,"amount_cents":5000,"diagnosis_codes":[]}],"notes":""},
        "reason":"Reviewed synthetic procedures and charges"}),
        None,
    )
    .await;
    let account_path = format!(
        "{billing_path}/accounts/{}",
        account["id"].as_str().unwrap()
    );
    let linked = rcm_ok(
        &state,
        &a,
        "PUT",
        &format!("{account_path}/diagnoses"),
        json!({
        "visit_version":diagnoses["version"],"lines":[
        {"line_index":0,"diagnosis_ids":[diagnoses["diagnoses"][0]["id"]]},
        {"line_index":1,"diagnosis_ids":[diagnoses["diagnoses"][1]["id"]]}],
        "reason":"Reviewed per-line diagnosis links"}),
        Some(1),
    )
    .await;
    let saved_lines = linked["content"]["lines"].clone();
    assert_eq!(saved_lines[0]["diagnosis_codes"], json!(["Z00.00"]));
    assert_eq!(saved_lines[1]["diagnosis_codes"], json!(["M62.81"]));
    let note = json!({"subjective":"Synthetic visit only","objective":"Synthetic findings",
        "assessment":"Synthetic examination and weakness","plan":"Synthetic follow-up"});
    let noted = rcm_ok(
        &state,
        &a,
        "PUT",
        &format!("{visit_path}/note"),
        note.clone(),
        diagnoses["version"].as_i64(),
    )
    .await;
    let signed = rcm_ok(
        &state,
        &a,
        "POST",
        &format!("{visit_path}/sign"),
        Value::Null,
        noted["version"].as_i64(),
    )
    .await;
    assert_eq!(signed["status"], "signed");
    assert_eq!(
        rcm_request(
            &state,
            &a,
            "PUT",
            &format!("{visit_path}/note"),
            note,
            signed["version"].as_i64()
        )
        .await
        .0,
        409
    );

    let posted = rcm_ok(
        &state,
        &a,
        "POST",
        &format!("{account_path}/actions"),
        json!({"action":"post","reason":"Signed encounter and reviewed charges"}),
        linked["version"].as_i64(),
    )
    .await;
    assert_eq!(posted["total_cents"], 20000);
    let allocated = rcm_ok(&state, &a, "GET", &billing_path, Value::Null, None).await;
    assert_eq!(allocated["entries"].as_array().unwrap().len(), 1);
    assert_eq!(allocated["entries"][0]["effect_cents"], -2500);
    assert_eq!(allocated["entries"][0]["content"]["test_mode"], true);
    assert_eq!(
        allocated["copays"][0]["id"],
        captured["operation"]["receipt_id"]
    );
    assert_eq!(allocated["copays"][0]["allocated_cents"], 2500);
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    assert_eq!(count(&pool, "billing_copay_allocations").await, 1);
    assert_eq!(count(&pool, "billing_entries").await, 1);
    let applied_again = rcm_ok(
        &state,
        &a,
        "POST",
        &format!("{account_path}/copays/apply"),
        Value::Null,
        posted["version"].as_i64(),
    )
    .await;
    assert_eq!(applied_again["applied_cents"], 0);

    let claim = rcm_ok(
        &state,
        &a,
        "POST",
        &format!("{account_path}/claims"),
        json!({
        "request_id":Uuid::new_v4(),"frequency":"original","content":{
        "billing_provider_name":"Synthetic Clinic","billing_npi":"1234567893","tax_id":"000000001",
        "billing_address":"1 Synthetic Way","rendering_npi":"1234567893",
        "patient_address":"2 Synthetic Way","subscriber_address":"2 Synthetic Way",
        "subscriber_birth_date":"1990-01-01","place_of_service":"11",
        "diagnosis_codes":["Z00.00","M62.81"],"line_diagnosis_pointers":[[1],[2]],
        "external_control_number":"","notes":"Synthetic test only","synthetic_test":true},
        "reason":"Reviewed synthetic primary claim"}),
        posted["version"].as_i64(),
    )
    .await;
    let claim_path = format!("/api/v1/billing/claims/{}", claim["id"].as_str().unwrap());
    let before_delivery = rcm_ok(&state, &a, "GET", &claim_path, Value::Null, None).await;
    assert_eq!(before_delivery["preflight_issues"], json!([]));
    assert_eq!(
        before_delivery["claim"]["snapshot"]["financial_summary"]["claim_charge_cents"],
        20000
    );
    assert_eq!(
        before_delivery["claim"]["snapshot"]["financial_summary"]["patient_payments_cents"],
        2500
    );
    let review = rcm_ok(
        &state,
        &a,
        "GET",
        &format!("{claim_path}/cms1500"),
        Value::Null,
        None,
    )
    .await;
    let html = review.as_str().unwrap();
    assert!(html.contains("99213 · 25") && html.contains("97110"));
    assert!(html.contains("A: Z00.00") && html.contains("B: M62.81"));
    assert!(html.contains("$200.00") && html.contains("$25.00"));
    assert!(
        html.contains("CMS-1500 service lines"),
        "the existing claim review must render its frozen service lines"
    );
    let ready = rcm_ok(
        &state,
        &a,
        "POST",
        &format!("{claim_path}/actions"),
        json!({"action":"ready","reason":"Synthetic claim packet reviewed"}),
        Some(1),
    )
    .await;
    let partner = rcm_ok(&state, &a, "POST", "/api/v1/billing/clearinghouses", json!({
        "request_id":Uuid::new_v4(),"content":{"name":"Synthetic Claim.MD loopback","active":true,
        "sender_qualifier":"ZZ","sender_id":"SYN-SENDER","receiver_qualifier":"ZZ",
        "receiver_id":"SYN-RECEIVER","application_sender":"SYN-SENDER","application_receiver":"SYN-RECEIVER",
        "submitter_name":"Synthetic Clinic","submitter_id":"SYN-SUBMIT","receiver_name":"Synthetic Clearinghouse",
        "receiver_identifier":"SYN-RECEIVER","contact_name":"Synthetic Operator","contact_phone":"2025550100",
        "usage":"T","guide_reference":"Synthetic test enrollment"},"reason":"Synthetic route"}), None).await;
    let address = json!({"line1":"1 Synthetic Way","line2":"","city":"Chicago","state":"IL","postal_code":"60601"});
    let artifact = rcm_ok(&state, &a, "POST", &format!("{claim_path}/837p"), json!({
        "request_id":Uuid::new_v4(),"partner_id":partner["id"],"partner_version":partner["version"],
        "details":{"billing_address":address,"subscriber_address":address,"patient_address":address,"payer_address":address,
        "subscriber_given_name":"Avery","subscriber_family_name":"Synthetic","patient_sex":"U","subscriber_sex":"U",
        "rendering_given_name":"Test","rendering_family_name":"Clinician","billing_taxonomy":"207Q00000X",
        "filing_indicator":"CI","signature_on_file":true,"benefits_assigned":true,"release_authorized":true,
        "routine_professional_reviewed":true},"reason":"Synthetic test transmission only"}), ready["version"].as_i64()).await;
    let x12 = artifact["payload"].as_str().unwrap();
    assert!(x12.contains("*200.00***") && x12.contains("*0*T*:~"));
    assert!(x12.contains("SV1*HC:99213:25*150.00*UN*1*11**1~"));
    assert!(x12.contains("SV1*HC:97110*50.00*UN*2*11**2~"));

    // Exercise the actual Claim.MD multipart adapter against a local fake. An
    // upload receipt changes transport state, never payer payment or the ledger.
    let delivered = Arc::new(Mutex::new(Vec::<Value>::new()));
    let observed = delivered.clone();
    let control = claim["control_number"].clone();
    let gateway = axum::Router::new().route("/services/upload/", axum::routing::post(
        move |headers: axum::http::HeaderMap, body: axum::body::Bytes| {
            let observed = observed.clone();
            let control = control.clone();
            async move {
                assert_eq!(headers["accept"], "application/json");
                assert!(!headers.contains_key("authorization"));
                let multipart = String::from_utf8(body.to_vec()).unwrap();
                assert!(multipart.contains("synthetic-loopback-key"));
                let raw = multipart.split("\r\n\r\n").find(|part| part.starts_with('{')).unwrap();
                let payload: Value = serde_json::from_str(raw.split("\r\n--").next().unwrap()).unwrap();
                observed.lock().unwrap().push(payload);
                axum::Json(json!({"claim":[{"pcn":control,"bill_npi":"1234567893","fileid":"837000001","status":"A"}]}))
            }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/services/upload/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
    let config: crate::delivery::Config = serde_json::from_value(json!({"routes":[{
        "key":"synthetic-rcm","tenant_id":a.tenant_id,"partner_id":partner["id"],"adapter":"claim_md",
        "endpoint":endpoint,"usage":"T","loopback_test":true}]})).unwrap();
    let delivery_path = format!(
        "/api/v1/billing/submissions/{}/delivery",
        artifact["id"].as_str().unwrap()
    );
    let delivery_request = json!({"request_id":Uuid::new_v4(),"route_key":"synthetic-rcm","reason":"Synthetic loopback only"});
    rcm_ok(
        &state,
        &a,
        "POST",
        &delivery_path,
        delivery_request.clone(),
        Some(1),
    )
    .await;
    assert!(crate::delivery::process_one(&pool, &config).await.unwrap());
    assert!(!crate::delivery::process_one(&pool, &config).await.unwrap());
    rcm_ok(
        &state,
        &a,
        "POST",
        &delivery_path,
        delivery_request,
        Some(1),
    )
    .await;
    assert_eq!(delivered.lock().unwrap().len(), 1);
    let native = delivered.lock().unwrap()[0]["claim"][0].clone();
    assert_eq!(native["pcn"], claim["control_number"]);
    assert_eq!(native["total_charge"], "200.00");
    assert_eq!(native["charge"][0]["charge"], "150.00");
    assert_eq!(native["charge"][0]["mod1"], "25");
    assert_eq!(native["charge"][0]["diag_ref"], "A");
    assert_eq!(native["charge"][1]["units"], "2");
    assert_eq!(native["charge"][1]["diag_ref"], "B");
    let submitted = rcm_ok(&state, &a, "GET", &claim_path, Value::Null, None).await;
    assert_eq!(submitted["claim"]["status"], "submitted");
    assert_eq!(count(&pool, "billing_entries").await, 1);
    server.abort();

    // Receive a separate synthetic payer 835. CO reduces charges; PR establishes
    // responsibility within the existing balance and must never create a charge.
    let segments = [
        "ST*835*0001".to_string(),
        "BPR*I*120*C*CHK************20261026".into(),
        "TRN*1*SYN-RCM-ERA".into(),
        "N1*PR*Synthetic Payer*PI*SYN-ONLY".into(),
        format!(
            "CLP*{}*1*200*120*30*CI*SYN-PCN",
            claim["control_number"].as_str().unwrap()
        ),
        "SVC*HC:99213:25*150*90**1".into(),
        "DTM*472*20261025".into(),
        "CAS*CO*45*40".into(),
        "CAS*PR*3*20".into(),
        "SVC*HC:97110*50*30**2".into(),
        "DTM*472*20261025".into(),
        "CAS*CO*45*10".into(),
        "CAS*PR*3*10".into(),
    ];
    let raw = format!("{}~SE*{}*0001~", segments.join("~"), segments.len() + 1);
    let remit_request = json!({"request_id":Uuid::new_v4(),"payer_id":payer["id"],
        "format":"x12_835","original_text":raw,"reason":"Synthetic payer adjudication evidence"});
    let remit = rcm_ok(
        &state,
        &a,
        "POST",
        "/api/v1/billing/remittances",
        remit_request.clone(),
        None,
    )
    .await;
    let remit_replay = rcm_ok(
        &state,
        &a,
        "POST",
        "/api/v1/billing/remittances",
        remit_request,
        None,
    )
    .await;
    assert_eq!(remit_replay["id"], remit["id"]);
    let remit_path = format!(
        "/api/v1/billing/remittances/{}",
        remit["id"].as_str().unwrap()
    );
    let matched = rcm_ok(&state, &a, "PUT", &format!("{remit_path}/matches"), json!({
        "matches":[{"row_index":0,"claim_id":claim["id"],"claim_version":submitted["claim"]["version"],
        "account_version":posted["version"],"writeoff_adjustments":[0,2]}],
        "reason":"Reviewed same account, exact service amounts and CO adjustments"}), Some(1)).await;
    assert_eq!(matched["issues"], json!([]));
    let post_request = json!({"action":"post","reason":"Reviewed synthetic payer payment and contractual adjustments"});
    let posted_era = rcm_ok(
        &state,
        &a,
        "POST",
        &format!("{remit_path}/actions"),
        post_request.clone(),
        matched["remittance"]["version"].as_i64(),
    )
    .await;
    assert_eq!(posted_era["status"], "posted");
    assert_eq!(
        rcm_request(
            &state,
            &a,
            "POST",
            &format!("{remit_path}/actions"),
            post_request,
            matched["remittance"]["version"].as_i64()
        )
        .await
        .0,
        409
    );
    let after_era = rcm_ok(&state, &a, "GET", &billing_path, Value::Null, None).await;
    let entries = after_era["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 3);
    assert!(entries.iter().any(|entry| entry["kind"] == "payment"
        && entry["content"]["party"] == "insurer"
        && entry["effect_cents"] == -12000));
    assert!(entries
        .iter()
        .any(|entry| entry["kind"] == "adjustment_credit" && entry["effect_cents"] == -5000));
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry["effect_cents"].as_i64().unwrap())
            .sum::<i64>(),
        -19500
    );
    assert!(
        entries
            .iter()
            .all(|entry| entry["effect_cents"].as_i64().unwrap() < 0),
        "PR must not add a second charge"
    );
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry["content"]["party"] == "patient")
            .count(),
        1
    );
    let settlement = rcm_ok(&state, &a, "GET", &remit_path, Value::Null, None).await;
    assert_eq!(settlement["postings"][0]["account_id"], account["id"]);
    assert_eq!(
        settlement["postings"][0]["current_account_balance_cents"],
        500
    );
    assert_eq!(
        settlement["postings"][0]["patient_responsibility_cents"],
        3000
    );
    assert_eq!(settlement["postings"][0]["writeoff_cents"], 5000);
    assert_eq!(after_era["accounts"][0]["content"]["lines"], saved_lines);
    assert_eq!(after_era["accounts"][0]["total_cents"], 20000);
    let final_claim = rcm_ok(&state, &a, "GET", &claim_path, Value::Null, None).await;
    assert_eq!(final_claim["claim"]["status"], "adjudicated");
    assert_eq!(final_claim["claim"]["snapshot"], claim["snapshot"]);

    let invoice_request = json!({"request_id":Uuid::new_v4(),"responsibility_cents":3000,
        "reason":"Reviewed $30 payer responsibility less the verified $25 copay"});
    let invoice = rcm_ok(
        &state,
        &a,
        "POST",
        &format!("{account_path}/invoices"),
        invoice_request.clone(),
        after_era["accounts"][0]["version"].as_i64(),
    )
    .await;
    assert_eq!(invoice["snapshot"]["gross_charges_cents"], 20000);
    assert_eq!(invoice["snapshot"]["responsibility_cents"], 3000);
    assert_eq!(invoice["snapshot"]["patient_payment_cents"], 2500);
    assert_eq!(invoice["snapshot"]["amount_due_cents"], 500);
    assert_eq!(invoice["snapshot"]["test_activity"], true);
    assert_eq!(invoice["snapshot"]["services"][1]["units"], 2);
    assert_eq!(invoice["snapshot"]["services"][1]["line_total_cents"], 5000);
    let same_invoice = rcm_ok(
        &state,
        &a,
        "POST",
        &format!("{account_path}/invoices"),
        invoice_request,
        Some(1),
    )
    .await;
    assert_eq!(same_invoice, invoice);
    due(&pool).await;
    poll(&pool, &broker, policy(false)).await.unwrap();
    let replayed = rcm_ok(&state, &a, "GET", &billing_path, Value::Null, None).await;
    assert_eq!(replayed["entries"], after_era["entries"]);
    assert_eq!(replayed["accounts"], after_era["accounts"]);
    assert_eq!(count(&pool, "billing_copay_receipts").await, 1);
    assert_eq!(count(&pool, "billing_copay_allocations").await, 1);
    assert_eq!(count(&pool, "patient_invoice_snapshots").await, 1);
    let mut outsider = a.clone();
    outsider.tenant_id = Uuid::new_v4();
    assert_eq!(
        rcm_request(&state, &outsider, "GET", &operation_path, Value::Null, None)
            .await
            .0,
        404
    );
    assert_eq!(
        rcm_request(&state, &outsider, "GET", &claim_path, Value::Null, None)
            .await
            .0,
        404
    );
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

#[path = "copay_checkout_browser_fixture.rs"]
mod browser_fixture;

include!("copay_reader_tests.rs");
include!("copay_saved_card_tests.rs");
