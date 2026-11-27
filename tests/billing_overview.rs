// SPDX-License-Identifier: AGPL-3.0-only
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::Arc;
use suncharts_engine::{
    auth::{Actor, Role},
    browser::BrowserAuth,
    postgres::PostgresBackend,
    State,
};
use tower::ServiceExt;
use uuid::Uuid;
const SECRET: &str = "synthetic-copay-test-secret";
fn app(db: PgPool) -> Router {
    suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db, "http://127.0.0.1:8099".into()).unwrap()),
    })
}
async fn setup() -> (PgPool, Actor, Uuid, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("billing_overview_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(6)
        .after_connect(move |c, _| {
            let q = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(&q).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let now = Utc::now().timestamp();
    let a = Actor {
        sub: Uuid::new_v4(),
        tenant_id: Uuid::new_v4(),
        role: Role::Owner,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    };
    user(&db, &a, a.sub, "owner", false).await;
    let p = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-CHECKOUT','Avery','Synthetic','1990-01-01')").bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')").bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(&db).await.unwrap();
    (db, a, p, appointment)
}
async fn user(db: &PgPool, a: &Actor, id: Uuid, role: &str, disabled: bool) {
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login',$4,$5)").bind(id).bind(a.tenant_id).bind(format!("{}@example.test",id.simple())).bind(role).bind(disabled).execute(db).await.unwrap();
}
async fn call(
    r: &Router,
    a: &Actor,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        a,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        request = request.header("If-Match", format!("\"{v}\""));
    }
    let response = r
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&body)
            .unwrap_or_else(|_| json!({"message":String::from_utf8_lossy(&body)})),
    )
}

fn receipt(appointment: Uuid, amount: i64) -> Value {
    json!({"request_id":Uuid::new_v4(),"appointment_id":appointment,"coverage_id":null,"amount_cents":amount,"method":"cash","reference":"SYNTHETIC-RECEIPT","occurred_on":"2026-10-25","reason":"Reviewed appointment copay and confirmed received cash","received_confirmed":true})
}
async fn overview(r: &Router, a: &Actor, query: &str) -> Value {
    let (status, value) = call(
        r,
        a,
        "GET",
        &format!("/api/v1/billing/overview{query}"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}
async fn add_receipt(r: &Router, a: &Actor, p: Uuid, appointment: Uuid, amount: i64) -> Value {
    let (status, row) = call(
        r,
        a,
        "POST",
        &format!("/api/v1/patients/{p}/billing/copays"),
        receipt(appointment, amount),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{row}");
    row
}
async fn posted_account(db: &PgPool, r: &Router, a: &Actor, p: Uuid, appointment: Uuid) -> Value {
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,'{}'::jsonb,$5,now())").bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub).bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"})).execute(db).await.unwrap();
    let path = format!("/api/v1/patients/{p}/billing/accounts");
    let (status,row)=call(r,a,"POST",&path,json!({"request_id":Uuid::new_v4(),"source_history_id":null,"reason":"Synthetic reviewed charge","content":{"visit_id":visit,"coverage_id":null,"service_date":"2026-10-25","currency":"USD","notes":"","lines":[{"code_system":"CPT","code":"99213","description":"Synthetic visit","modifiers":"","units":1,"amount_cents":10000,"diagnosis_codes":["Z00.00"]}]}}),None).await;
    assert_eq!(status, StatusCode::OK, "{row}");
    let (status, posted) = call(
        r,
        a,
        "POST",
        &format!("{path}/{}/actions", row["id"].as_str().unwrap()),
        json!({"action":"post","reason":"Reviewed synthetic charges"}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{posted}");
    posted
}
#[tokio::test]
async fn overview_preserves_receipts_and_counts_only_latest_reviewed_invoice() {
    let (db, a, p, appointment) = setup().await;
    let r = app(db.clone());
    let receipt = add_receipt(&r, &a, p, appointment, 2500).await;
    let before = overview(&r, &a, "").await;
    assert_eq!(before["accounts"]["items"], json!([]));
    assert_eq!(before["summary"]["copays"]["net_received_cents"], 2500);
    assert_eq!(before["summary"]["copays"]["usable_unapplied_cents"], 2500);
    let account = posted_account(&db, &r, &a, p, appointment).await;
    let path = format!(
        "/api/v1/patients/{p}/billing/accounts/{}",
        account["id"].as_str().unwrap()
    );
    let mut invoices = Vec::new();
    for responsibility in [5000, 3000] {
        let (status,invoice)=call(&r,&a,"POST",&format!("{path}/invoices"),json!({"request_id":Uuid::new_v4(),"responsibility_cents":responsibility,"reason":"Reviewed synthetic patient responsibility"}),Some(2)).await;
        assert_eq!(status, StatusCode::OK, "{invoice}");
        invoices.push(invoice);
    }
    let data = overview(&r, &a, "").await;
    assert_eq!(data["summary"]["accounts"]["latest_invoices"], 1);
    assert_eq!(
        data["summary"]["accounts"]["reviewed_patient_due_cents"],
        500
    );
    assert_eq!(
        data["summary"]["accounts"]["posted_account_balance_cents"],
        7500
    );
    assert_eq!(
        data["summary"]["copays"]["net_received_cents"], 2500,
        "allocating receipt is not a second collection"
    );
    assert_eq!(data["summary"]["copays"]["usable_unapplied_cents"], 0);
    assert_eq!(
        data["accounts"]["items"][0]["invoice_id"],
        invoices[1]["id"]
    );
    let (status,_)=call(&r,&a,"POST",&format!("{path}/entries"),json!({"request_id":Uuid::new_v4(),"kind":"payment","amount_cents":500,"reverses_id":null,"party":"patient","method":"cash","reference":"SYNTHETIC","occurred_on":"2026-10-25","reason":"Confirmed synthetic cash"}),Some(2)).await;
    assert_eq!(status, StatusCode::OK);
    let changed = overview(&r, &a, "").await;
    assert_eq!(
        changed["accounts"]["items"][0]["invoice_needs_review"],
        true
    );
    assert_eq!(
        changed["summary"]["accounts"]["reviewed_patient_due_cents"], 0,
        "do not assert old responsibility after changes"
    );
    assert_eq!(changed["summary"]["accounts"]["invoice_review_count"], 1);
    for invoice in invoices {
        let (status, saved) = call(
            &r,
            &a,
            "GET",
            &format!(
                "/api/v1/billing/invoices/{}",
                invoice["id"].as_str().unwrap()
            ),
            Value::Null,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(saved, invoice, "history stays immutable");
    }
    sqlx::query("INSERT INTO patient_lifecycle_events(tenant_id,patient_id,version,archived,reason,actor_id) VALUES($1,$2,2,true,'Synthetic archive review',$3)").bind(a.tenant_id).bind(p).bind(a.sub).execute(&db).await.unwrap();
    assert_eq!(
        overview(&r, &a, "").await["summary"]["copays"]["receipts"],
        1
    );
    let endpoint = format!(
        "/api/v1/billing/copay-receipts/{}",
        receipt["id"].as_str().unwrap()
    );
    let (status, copy) = call(&r, &a, "GET", &endpoint, Value::Null, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(copy["receipt"]["id"], receipt["id"]);
    assert_eq!(copy["context"]["patient"]["mrn"], "SYN-CHECKOUT");
    assert!(copy["context"]["appointment"].get("title").is_none());
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(&r, &other, "GET", &endpoint, Value::Null, None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        overview(&r, &other, "").await["summary"]["copays"]["receipts"],
        0
    );
    db.close().await;
}
#[tokio::test]
async fn overview_refunds_test_mode_voids_and_pagination_are_not_patient_debt() {
    let (db, a, p, appointment) = setup().await;
    let r = app(db.clone());
    let first = add_receipt(&r, &a, p, appointment, 2500).await;
    let test = add_receipt(&r, &a, p, appointment, 2500).await;
    let void = add_receipt(&r, &a, p, appointment, 1000).await;
    let (status, _) = call(
        &r,
        &a,
        "POST",
        &format!(
            "/api/v1/patients/{p}/billing/copays/{}/void",
            void["id"].as_str().unwrap()
        ),
        json!({"reason":"Synthetic receipt correction"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let setting = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO payment_settings(tenant_id,id,mode) VALUES($1,$2,'suncharts_connect')",
    )
    .bind(a.tenant_id)
    .bind(setting)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO payment_credentials(tenant_id,setting_id,revision,encrypted_config) VALUES($1,$2,1,'synthetic'::bytea)").bind(a.tenant_id).bind(setting).execute(&db).await.unwrap();
    for (receipt, live, refund) in [(&first, true, 500), (&test, false, 0)] {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO copay_checkout_attempts(tenant_id,id,patient_id,appointment_id,setting_id,credential_revision,installation_id,provider_account_id,livemode,amount_cents,request_id,creation_hash,requested_by,reason,return_url,status,receipt_id,refunded_cents) VALUES($1,$2,$3,$4,$5,1,$6,'acct_synthetic',$7,2500,$8,'synthetic',$9,'Synthetic fixture','https://example.test/','paid',$10,$11)").bind(a.tenant_id).bind(id).bind(p).bind(appointment).bind(setting).bind(Uuid::new_v4()).bind(live).bind(Uuid::new_v4()).bind(a.sub).bind(Uuid::parse_str(receipt["id"].as_str().unwrap()).unwrap()).bind(refund as i64).execute(&db).await.unwrap();
        if refund > 0 {
            sqlx::query("INSERT INTO copay_checkout_refund_events(tenant_id,operation_id,cumulative_cents,delta_cents,unapplied_cents,actor_id) VALUES($1,$2,500,500,500,$3)").bind(a.tenant_id).bind(id).bind(a.sub).execute(&db).await.unwrap();
        }
    }
    let data = overview(&r, &a, "?limit=1").await;
    assert_eq!(data["summary"]["copays"]["receipts"], 2);
    assert_eq!(data["summary"]["copays"]["net_received_cents"], 2000);
    assert_eq!(data["summary"]["copays"]["usable_unapplied_cents"], 2000);
    assert_eq!(data["copays"]["items"].as_array().unwrap().len(), 1);
    let next = overview(
        &r,
        &a,
        &format!(
            "?limit=1&copays_after={}",
            data["copays"]["next_cursor"].as_str().unwrap()
        ),
    )
    .await;
    assert_ne!(
        data["copays"]["items"][0]["id"],
        next["copays"]["items"][0]["id"]
    );
    assert_eq!(
        next["summary"], data["summary"],
        "pagination never changes aggregate totals"
    );
    assert_eq!(
        overview(&r, &a, "?mode=test").await["summary"]["copays"]["net_received_cents"],
        2500
    );
    sqlx::query(
        "UPDATE copay_checkout_attempts SET status='needs_review' WHERE tenant_id=$1 AND livemode",
    )
    .bind(a.tenant_id)
    .execute(&db)
    .await
    .unwrap();
    let held = overview(&r, &a, "").await;
    assert_eq!(held["summary"]["copays"]["usable_unapplied_cents"], 0);
    assert_eq!(held["summary"]["copays"]["review_count"], 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        0,
        "GET never allocates or posts provider evidence"
    );
    db.close().await;
}
#[tokio::test]
async fn overview_and_document_reads_enforce_billing_policy_and_oauth_scope_without_clinical_access(
) {
    let (db, a, p, appointment) = setup().await;
    let r = app(db.clone());
    let receipt = add_receipt(&r, &a, p, appointment, 2500).await;
    let staff = Uuid::new_v4();
    user(&db, &a, staff, "front_desk", false).await;
    let policy = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Billing reads only','front_desk',$3,$4)").bind(a.tenant_id).bind(policy).bind(json!({"billing":{"view":true}})).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)").bind(a.tenant_id).bind(staff).bind(policy).bind(a.sub).execute(&db).await.unwrap();
    let client = Uuid::new_v4();
    let grant = Uuid::new_v4();
    let token = format!("sce_at_{}", Uuid::new_v4().simple());
    sqlx::query("INSERT INTO oauth_clients(id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES($1,$2,'Synthetic billing','synthetic','https://example.test/callback','billing.read clinical.read')").bind(client).bind(a.tenant_id).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,'billing.read')").bind(grant).bind(client).bind(a.tenant_id).bind(staff).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '1 hour')").bind(suncharts_engine::oauth::hash(&token)).bind(grant).execute(&db).await.unwrap();
    let endpoint = format!(
        "/api/v1/billing/copay-receipts/{}",
        receipt["id"].as_str().unwrap()
    );
    let patient_invoices = format!("/api/v1/billing/patients/{p}/invoices");
    for (path, expected) in [
        ("/api/v1/billing/overview", StatusCode::OK),
        ("/api/v1/billing/patients", StatusCode::OK),
        (patient_invoices.as_str(), StatusCode::OK),
        (endpoint.as_str(), StatusCode::OK),
        ("/api/v1/billing/claims", StatusCode::FORBIDDEN),
        ("/api/v1/patients", StatusCode::FORBIDDEN),
    ] {
        let response = r
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "{path}");
    }
    sqlx::query("UPDATE oauth_grants SET scope='clinical.read' WHERE id=$1")
        .bind(grant)
        .execute(&db)
        .await
        .unwrap();
    let response = r
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/billing/overview")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    sqlx::query("CREATE FUNCTION reject_overview_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='billing.overview_read' THEN RAISE EXCEPTION 'Synthetic read audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_overview_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_overview_audit()").execute(&db).await.unwrap();
    assert_eq!(
        call(&r, &a, "GET", "/api/v1/billing/overview", Value::Null, None)
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    db.close().await;
}

#[tokio::test]
async fn patient_billing_hub_filters_search_and_invoice_history_without_cross_patient_totals() {
    let (db, a, p, appointment) = setup().await;
    let r = app(db.clone());
    add_receipt(&r, &a, p, appointment, 2500).await;
    let account = posted_account(&db, &r, &a, p, appointment).await;
    let path = format!(
        "/api/v1/patients/{p}/billing/accounts/{}/invoices",
        account["id"].as_str().unwrap()
    );
    let mut saved = Vec::new();
    for responsibility in [5000, 3000] {
        let (status,row)=call(&r,&a,"POST",&path,json!({"request_id":Uuid::new_v4(),"responsibility_cents":responsibility,"reason":"Synthetic patient invoice review"}),Some(2)).await;
        assert_eq!(status, StatusCode::OK, "{row}");
        saved.push(row);
    }
    let other = Uuid::new_v4();
    let other_appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-OTHER','Bailey','Synthetic','1991-01-01')").bind(a.tenant_id).bind(other).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T15:00:00Z','2026-10-25T15:30:00Z','checked_in')").bind(a.tenant_id).bind(other_appointment).bind(other).bind(a.sub).execute(&db).await.unwrap();
    add_receipt(&r, &a, other, other_appointment, 7500).await;
    sqlx::query("INSERT INTO patient_lifecycle_events(tenant_id,patient_id,version,archived,reason,actor_id) VALUES($1,$2,2,true,'Synthetic archived chart retains billing',$3)").bind(a.tenant_id).bind(p).bind(a.sub).execute(&db).await.unwrap();
    let selected = overview(&r, &a, &format!("?patient_id={p}")).await;
    assert_eq!(selected["patient"]["id"], p.to_string());
    assert_eq!(selected["patient"]["archived"], true);
    assert_eq!(selected["summary"]["copays"]["net_received_cents"], 2500);
    assert_eq!(
        selected["summary"]["accounts"]["reviewed_patient_due_cents"],
        500
    );
    let other_data = overview(&r, &a, &format!("?patient_id={other}")).await;
    assert_eq!(other_data["summary"]["copays"]["net_received_cents"], 7500);
    assert_eq!(other_data["summary"]["accounts"]["latest_invoices"], 0);
    let (status, patients) = call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/patients?q=SYN-CHECKOUT",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(patients["items"].as_array().unwrap().len(), 1);
    assert_eq!(patients["items"][0]["id"], p.to_string());
    assert_eq!(patients["items"][0]["archived"], true);
    assert!(patients["items"][0].get("birth_date").is_none());
    let (_, literal) = call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/patients?q=%25",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(literal["items"], json!([]), "search wildcards are literal");
    let (_, first) = call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/patients?limit=1",
        Value::Null,
        None,
    )
    .await;
    let (_, second) = call(
        &r,
        &a,
        "GET",
        &format!(
            "/api/v1/billing/patients?limit=1&after={}",
            first["next_cursor"].as_str().unwrap()
        ),
        Value::Null,
        None,
    )
    .await;
    assert_ne!(first["items"][0]["id"], second["items"][0]["id"]);
    assert_eq!(second["next_cursor"], Value::Null);
    let history = format!("/api/v1/billing/patients/{p}/invoices");
    let (status, newest) = call(
        &r,
        &a,
        "GET",
        &format!("{history}?limit=1"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(newest["items"][0]["id"], saved[1]["id"]);
    assert_eq!(newest["items"][0]["is_latest"], true);
    let (_, older) = call(
        &r,
        &a,
        "GET",
        &format!(
            "{history}?limit=1&after={}",
            newest["next_cursor"].as_str().unwrap()
        ),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(older["items"][0]["id"], saved[0]["id"]);
    assert_eq!(older["items"][0]["snapshot"], saved[0]["snapshot"]);
    assert_eq!(older["items"][0]["is_latest"], false);
    let (_, test_mode) = call(
        &r,
        &a,
        "GET",
        &format!("{history}?mode=test"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(test_mode["items"], json!([]));
    let mut foreign = a.clone();
    foreign.tenant_id = Uuid::new_v4();
    for target in [history, format!("/api/v1/billing/overview?patient_id={p}")] {
        assert_eq!(
            call(&r, &foreign, "GET", &target, Value::Null, None)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        call(
            &r,
            &a,
            "GET",
            "/api/v1/billing/patients?limit=101",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    db.close().await;
}

// Explicit, disposable native-browser acceptance. Never built into the application.
#[tokio::test]
#[ignore = "opt-in localhost synthetic browser fixture"]
async fn native_billing_overview_browser_fixture() {
    use argon2::{
        password_hash::{rand_core::OsRng, SaltString},
        Argon2, PasswordHasher,
    };
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    assert_eq!(
        std::env::var("SUNCHARTS_BILLING_OVERVIEW_BROWSER").as_deref(),
        Ok("synthetic-local-only")
    );
    let url = url::Url::parse(&std::env::var("TEST_DATABASE_URL").unwrap()).unwrap();
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert_eq!(url.port(), Some(55589));
    assert_eq!(url.path(), "/patient_billing_gateway_261111");
    let (db, a, p, appointment) = setup().await;
    let seed = app(db.clone());
    let first = add_receipt(&seed, &a, p, appointment, 2500).await;
    let account = posted_account(&db, &seed, &a, p, appointment).await;
    let path = format!(
        "/api/v1/patients/{p}/billing/accounts/{}",
        account["id"].as_str().unwrap()
    );
    for amount in [5000, 4000] {
        let (status,_)=call(&seed,&a,"POST",&format!("{path}/invoices"),json!({"request_id":Uuid::new_v4(),"responsibility_cents":amount,"reason":"Synthetic invoice browser fixture"}),Some(2)).await;
        assert_eq!(status, StatusCode::OK);
    }
    let (status,_)=call(&seed,&a,"POST",&format!("{path}/entries"),json!({"request_id":Uuid::new_v4(),"kind":"payment","amount_cents":500,"reverses_id":null,"party":"patient","method":"cash","reference":"SYNTHETIC-LOCAL-ONLY","occurred_on":"2026-10-25","reason":"Synthetic local invoice review fixture, no provider"}),Some(2)).await;
    assert_eq!(status, StatusCode::OK);
    for (name, account_needed) in [("Open Invoice", true), ("Standalone Copay", false)] {
        let patient = Uuid::new_v4();
        let appointment = Uuid::new_v4();
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,$4,'Synthetic','1990-01-01')").bind(a.tenant_id).bind(patient).bind(format!("SYN-{}",patient.simple())).bind(name).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')").bind(a.tenant_id).bind(appointment).bind(patient).bind(a.sub).execute(&db).await.unwrap();
        add_receipt(&seed, &a, patient, appointment, 2500).await;
        if account_needed {
            let row = posted_account(&db, &seed, &a, patient, appointment).await;
            let (status,_)=call(&seed,&a,"POST",&format!("/api/v1/patients/{patient}/billing/accounts/{}/invoices",row["id"].as_str().unwrap()),json!({"request_id":Uuid::new_v4(),"responsibility_cents":3000,"reason":"Synthetic reviewed responsibility"}),Some(2)).await;
            assert_eq!(status, StatusCode::OK);
        }
    }
    // Test evidence stays on its own unposted appointment: never reclassify a
    // cash allocation after it has already entered a real-mode account ledger.
    let test_patient = Uuid::new_v4();
    let test_appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-TEST-ONLY','Test Copay','Synthetic','1990-01-01')").bind(a.tenant_id).bind(test_patient).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')").bind(a.tenant_id).bind(test_appointment).bind(test_patient).bind(a.sub).execute(&db).await.unwrap();
    let test_receipt = add_receipt(&seed, &a, test_patient, test_appointment, 2500).await;
    let setting = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO payment_settings(tenant_id,id,mode) VALUES($1,$2,'suncharts_connect')",
    )
    .bind(a.tenant_id)
    .bind(setting)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO payment_credentials(tenant_id,setting_id,revision,encrypted_config) VALUES($1,$2,1,'synthetic-not-provider-credentials'::bytea)").bind(a.tenant_id).bind(setting).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO copay_checkout_attempts(tenant_id,id,patient_id,appointment_id,setting_id,credential_revision,installation_id,provider_account_id,livemode,amount_cents,request_id,creation_hash,requested_by,reason,return_url,status,receipt_id) VALUES($1,$2,$3,$4,$5,1,$6,'acct_local_synthetic',false,2500,$7,'synthetic',$8,'Local browser evidence only','http://127.0.0.1:55628/','paid',$9)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(test_patient).bind(test_appointment).bind(setting).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(a.sub).bind(Uuid::parse_str(test_receipt["id"].as_str().unwrap()).unwrap()).execute(&db).await.unwrap();
    let recorded = overview(&seed, &a, "").await;
    assert_eq!(recorded["summary"]["copays"]["receipts"], 3);
    assert_eq!(recorded["summary"]["copays"]["net_received_cents"], 7500);
    assert_eq!(
        recorded["summary"]["copays"]["usable_unapplied_cents"],
        2500
    );
    assert_eq!(recorded["summary"]["accounts"]["open_invoice_count"], 1);
    assert_eq!(recorded["summary"]["accounts"]["invoice_review_count"], 1);
    let test = overview(&seed, &a, "?mode=test").await;
    assert_eq!(test["summary"]["copays"]["net_received_cents"], 2500);
    assert_eq!(test["summary"]["copays"]["usable_unapplied_cents"], 2500);
    let staff = Uuid::new_v4();
    let password = Uuid::new_v4().to_string();
    let email = "billing-overview@example.test";
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .unwrap()
        .to_string();
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,display_name) VALUES($1,$2,$3,$4,'front_desk','Synthetic Billing Only')").bind(staff).bind(a.tenant_id).bind(email).bind(hash).execute(&db).await.unwrap();
    let policy = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Synthetic billing only','front_desk',$3,$4)").bind(a.tenant_id).bind(policy).bind(json!({"billing":{"view":true}})).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)").bind(a.tenant_id).bind(staff).bind(policy).bind(a.sub).execute(&db).await.unwrap();
    let router = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db, "http://127.0.0.1:55628".into()).unwrap()),
    });
    let directory = std::path::Path::new("/private/tmp/suncharts-patient-billing-browser");
    std::fs::create_dir_all(directory).unwrap();
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join("browser-auth.json"))
        .unwrap();
    use std::io::Write;
    file.write_all(json!({"origin":"http://127.0.0.1:55628","email":email,"password":password,"role":"billing-view only; clinical and claims denied","first_receipt":first["id"],"synthetic_only":true,"provider_calls":0}).to_string().as_bytes()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:55628")
        .await
        .unwrap();
    println!(
        "Synthetic billing overview ready at http://127.0.0.1:55628; protected login file written."
    );
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            tokio::time::sleep(std::time::Duration::from_secs(1800)).await
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn payment_history_lists_each_receipt_once_and_keeps_direct_payment_evidence() {
    let (db, a, p, appointment) = setup().await;
    let r = app(db.clone());
    let receipt = add_receipt(&r, &a, p, appointment, 2500).await;
    let account = posted_account(&db, &r, &a, p, appointment).await;
    let path = format!(
        "/api/v1/patients/{p}/billing/accounts/{}/entries",
        account["id"].as_str().unwrap()
    );
    let(status,entry)=call(&r,&a,"POST",&path,json!({"request_id":Uuid::new_v4(),"kind":"payment","amount_cents":1000,"reverses_id":null,"party":"patient","method":"cash","reference":"SYNTHETIC-DIRECT","occurred_on":Utc::now().date_naive(),"reason":"Synthetic confirmed cash payment"}),Some(2)).await;
    assert_eq!(status, StatusCode::OK, "{entry}");
    let history = format!("/api/v1/billing/patients/{p}/payment-history");
    let (status, first) = call(
        &r,
        &a,
        "GET",
        &format!("{history}?limit=1"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    let cursor = first["next_cursor"].as_str().unwrap();
    let (status, second) = call(
        &r,
        &a,
        "GET",
        &format!("{history}?after={cursor}&limit=1"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert!(second["next_cursor"].is_null());
    let mut rows = first["items"].as_array().unwrap().clone();
    rows.extend(second["items"].as_array().unwrap().clone());
    assert_eq!(
        rows.len(),
        2,
        "allocated copay has no duplicate direct ledger payment"
    );
    let copay = rows.iter().find(|x| x["kind"] == "copay").unwrap();
    assert_eq!(copay["id"], receipt["id"]);
    assert_eq!(copay["received_cents"], 2500);
    assert_eq!(copay["unapplied_cents"], 0);
    assert_eq!(copay["ledger_recorded"], true);
    let direct = rows
        .iter()
        .find(|x| x["kind"] == "recorded_payment")
        .unwrap();
    assert_eq!(direct["id"], entry["id"]);
    assert_eq!(direct["received_cents"], 1000);
    assert_eq!(direct["status"], "recorded");
    let (status, test) = call(
        &r,
        &a,
        "GET",
        &format!("{history}?mode=test"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(test["items"], json!([]));
    let(status,reversal)=call(&r,&a,"POST",&path,json!({"request_id":Uuid::new_v4(),"kind":"reversal","amount_cents":null,"reverses_id":entry["id"],"party":"patient","method":"none","reference":"SYNTHETIC-CORRECTION","occurred_on":Utc::now().date_naive(),"reason":"Synthetic recording correction, no processor refund"}),Some(3)).await;
    assert_eq!(status, StatusCode::OK, "{reversal}");
    let (status, list) = call(&r, &a, "GET", &history, Value::Null, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["items"].as_array().unwrap().len(), 2);
    let direct = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["kind"] == "recorded_payment")
        .unwrap();
    assert_eq!(direct["status"], "reversed");
    assert_eq!(
        direct["refunded_cents"], 0,
        "a correction is not a verified card refund"
    );
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(&r, &other, "GET", &history, Value::Null, None).await.0,
        StatusCode::NOT_FOUND
    );
}

// ---- Encounter numbers on billing rows ----------------------------------------------------
// An encounter that is the practice's fifth is "ENC-0005" wherever it is listed, whichever patient's
// chart is open, so these rows carry the encounter and its number.
async fn numbered_encounter(
    db: &PgPool,
    tenant: Uuid,
    clinician: Uuid,
    patient: Uuid,
    created: &str,
) -> (Uuid, Uuid) {
    let (visit, appointment) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5::timestamptz,$5::timestamptz+interval '30 minutes','checked_in')").bind(tenant).bind(appointment).bind(patient).bind(clinician).bind(created).execute(db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,created_at) VALUES($1,$2,$3,$4,$5,$6::timestamptz)").bind(tenant).bind(visit).bind(patient).bind(appointment).bind(clinician).bind(created).execute(db).await.unwrap();
    (visit, appointment)
}
async fn account_for(db: &PgPool, tenant: Uuid, patient: Uuid, visit: Uuid, day: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO billing_accounts(tenant_id,id,patient_id,visit_id,content,total_cents,status,version,request_id,creation_hash) VALUES($1,$2,$3,$4,jsonb_build_object('service_date',$5::text,'visit_id',$4::text),10000,'posted',2,$6,'synthetic')").bind(tenant).bind(id).bind(patient).bind(visit).bind(day).bind(Uuid::new_v4()).execute(db).await.unwrap();
    id
}
fn by_id<'a>(rows: &'a Value, key: &str, id: Uuid) -> &'a Value {
    rows.as_array()
        .unwrap()
        .iter()
        .find(|row| row[key] == json!(id))
        .unwrap_or_else(|| panic!("no row for {id} in {rows}"))
}
// Another practice's encounters, started before this practice's, must not shift its numbers.
async fn other_practice_encounters(db: &PgPool) {
    let tenant = Uuid::new_v4();
    let (patient, user) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-OTHER','Other','Practice','1990-01-01')").bind(tenant).bind(patient).execute(db).await.unwrap();
    for day in ["2026-01-01T09:00:00Z", "2026-01-02T09:00:00Z"] {
        numbered_encounter(db, tenant, user, patient, day).await;
    }
}
#[tokio::test]
async fn billing_rows_name_their_encounter_and_its_practice_number() {
    let (db, a, p1, null_appointment) = setup().await;
    let r = app(db.clone());
    other_practice_encounters(&db).await;
    let p2 = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-SECOND','Blake','Synthetic','1991-02-02')").bind(a.tenant_id).bind(p2).execute(&db).await.unwrap();
    // Started in this order: patient 2, patient 1, patient 2. Patient 1's only encounter is the
    // practice's second, not its first.
    let (v1, _) = numbered_encounter(&db, a.tenant_id, a.sub, p2, "2026-03-01T09:00:00Z").await;
    let (v2, appointment2) =
        numbered_encounter(&db, a.tenant_id, a.sub, p1, "2026-03-02T09:00:00Z").await;
    let (v3, appointment3) =
        numbered_encounter(&db, a.tenant_id, a.sub, p2, "2026-03-03T09:00:00Z").await;
    let expected = [(v1, 1), (v2, 2), (v3, 3)];
    let accounts = [
        (
            account_for(&db, a.tenant_id, p2, v1, "2026-03-01").await,
            p2,
            v1,
        ),
        (
            account_for(&db, a.tenant_id, p1, v2, "2026-03-02").await,
            p1,
            v2,
        ),
        (
            account_for(&db, a.tenant_id, p2, v3, "2026-03-03").await,
            p2,
            v3,
        ),
    ];
    // The numbers the chart shows for the same encounters.
    for (patient, visit, number) in [(p2, v1, 1), (p1, v2, 2), (p2, v3, 3)] {
        let (status, chart) = call(
            &r,
            &a,
            "GET",
            &format!("/api/v1/patients/{patient}/workspace"),
            Value::Null,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{chart}");
        let chart_visit = by_id(&chart["visits"], "id", visit);
        assert_eq!(chart_visit["encounter_number"], number);
    }
    // Patient billing overview: account rows.
    let data = overview(&r, &a, "").await;
    for (account, _, visit) in accounts {
        let row = by_id(&data["accounts"]["items"], "id", account);
        let number = expected.iter().find(|e| e.0 == visit).unwrap().1;
        assert_eq!(row["visit_id"], json!(visit));
        assert_eq!(row["encounter_number"], number);
    }
    // Copay receipts: one on an encounter, one on an appointment that has no encounter yet.
    let on_encounter = add_receipt(&r, &a, p1, appointment2, 2500).await;
    let on_nothing = add_receipt(&r, &a, p1, null_appointment, 1500).await;
    let on_third = add_receipt(&r, &a, p2, appointment3, 500).await;
    let data = overview(&r, &a, "").await;
    let copays = &data["copays"]["items"];
    let row = by_id(
        copays,
        "id",
        on_encounter["id"].as_str().unwrap().parse().unwrap(),
    );
    assert_eq!(
        (row["visit_id"].clone(), row["encounter_number"].clone()),
        (json!(v2), json!(2))
    );
    let row = by_id(
        copays,
        "id",
        on_third["id"].as_str().unwrap().parse().unwrap(),
    );
    assert_eq!(
        (row["visit_id"].clone(), row["encounter_number"].clone()),
        (json!(v3), json!(3))
    );
    let row = by_id(
        copays,
        "id",
        on_nothing["id"].as_str().unwrap().parse().unwrap(),
    );
    assert!(
        row["visit_id"].is_null() && row["encounter_number"].is_null(),
        "{row}"
    );
    // One patient's own view numbers the same encounters the same way.
    let data = overview(&r, &a, &format!("?patient_id={p1}")).await;
    assert_eq!(data["accounts"]["items"][0]["encounter_number"], 2);
    // Payment history.
    let (status, history) = call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/billing/patients/{p1}/payment-history"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    let items = &history["items"];
    let row = by_id(
        items,
        "id",
        on_encounter["id"].as_str().unwrap().parse().unwrap(),
    );
    assert_eq!(
        (row["visit_id"].clone(), row["encounter_number"].clone()),
        (json!(v2.to_string()), json!(2))
    );
    let row = by_id(
        items,
        "id",
        on_nothing["id"].as_str().unwrap().parse().unwrap(),
    );
    assert!(
        row["visit_id"].is_null() && row["encounter_number"].is_null(),
        "{row}"
    );
    // A direct payment on an account made through the usual flow carries its encounter: the
    // practice's fourth, started after the others.
    let appointment4 = Uuid::new_v4();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-26T14:00:00Z','2026-10-26T14:30:00Z','checked_in')").bind(a.tenant_id).bind(appointment4).bind(p1).bind(a.sub).execute(&db).await.unwrap();
    let account = posted_account(&db, &r, &a, p1, appointment4).await;
    let visit4: Uuid =
        sqlx::query_scalar("SELECT id FROM visits WHERE tenant_id=$1 AND appointment_id=$2")
            .bind(a.tenant_id)
            .bind(appointment4)
            .fetch_one(&db)
            .await
            .unwrap();
    let path = format!(
        "/api/v1/patients/{p1}/billing/accounts/{}/entries",
        account["id"].as_str().unwrap()
    );
    let (status, entry) = call(&r, &a, "POST", &path, json!({"request_id":Uuid::new_v4(),"kind":"payment","amount_cents":1000,"reverses_id":null,"party":"patient","method":"cash","reference":"SYNTHETIC-DIRECT","occurred_on":Utc::now().date_naive(),"reason":"Synthetic confirmed cash payment"}), Some(2)).await;
    assert_eq!(status, StatusCode::OK, "{entry}");
    let (_, history) = call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/billing/patients/{p1}/payment-history"),
        Value::Null,
        None,
    )
    .await;
    let direct = history["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["kind"] == "recorded_payment")
        .unwrap();
    assert_eq!(
        (
            direct["visit_id"].clone(),
            direct["encounter_number"].clone()
        ),
        (json!(visit4.to_string()), json!(4))
    );
    // Claims list: the claim's account names the encounter and the date of service.
    let payer = Uuid::new_v4();
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,'{}',$3,'synthetic')").bind(a.tenant_id).bind(payer).bind(Uuid::new_v4()).execute(&db).await.unwrap();
    let mut claims = Vec::new();
    for (index, (account, patient, visit)) in accounts.iter().enumerate() {
        let claim = Uuid::new_v4();
        // The snapshot carries the account as it was when the claim was made.
        sqlx::query("INSERT INTO ehr_claims(tenant_id,id,patient_id,account_id,payer_id,control_number,frequency,content,snapshot,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,$6,'original','{}',jsonb_build_object('account',jsonb_build_object('total_cents',10000,'content',jsonb_build_object('visit_id',$7::text,'service_date',$8::text))),$9,'synthetic')").bind(a.tenant_id).bind(claim).bind(patient).bind(account).bind(payer).bind(format!("SYN-ENC-{index}")).bind(visit.to_string()).bind(format!("2026-03-0{}", index + 1)).bind(Uuid::new_v4()).execute(&db).await.unwrap();
        claims.push((claim, *visit, index + 1));
    }

    // The waiting period uses the first revision in the current status and the worklist
    // links only a matching payer's unposted remittance row.
    let accepted = claims[0].0;
    let payment_revealed = claims[1].0;
    sqlx::query(
        "UPDATE ehr_claims SET status='accepted',version=3 WHERE tenant_id=$1 AND id=ANY($2)",
    )
    .bind(a.tenant_id)
    .bind(vec![accepted, payment_revealed])
    .execute(&db)
    .await
    .unwrap();
    sqlx::query(r#"INSERT INTO claim_revisions(tenant_id,claim_id,version,snapshot,actor_id,reason,created_at) VALUES ($1,$2,1,'{"status":"draft"}',$3,'Fixture','2026-11-22 09:00:00Z'),($1,$2,2,'{"status":"accepted"}',$3,'Fixture','2026-11-23 08:00:00Z'),($1,$2,3,'{"status":"accepted"}',$3,'Fixture','2026-11-24 10:00:00Z')"#)
        .bind(a.tenant_id)
        .bind(accepted)
        .bind(a.sub)
        .execute(&db)
        .await
        .unwrap();
    let other_payer = Uuid::new_v4();
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,'{}',$3,'synthetic')")
        .bind(a.tenant_id)
        .bind(other_payer)
        .bind(Uuid::new_v4())
        .execute(&db)
        .await
        .unwrap();
    let remittance = Uuid::new_v4();
    for (record, remit_payer, matched_claim) in [
        (remittance, payer, payment_revealed),
        (Uuid::new_v4(), other_payer, accepted),
    ] {
        sqlx::query("INSERT INTO era_remittances(tenant_id,id,payer_id,trace,document,document_hash,status,matches,request_id,creation_hash) VALUES($1,$2,$3,$4,'{}','synthetic','reconciled',$5,$6,'synthetic')")
            .bind(a.tenant_id)
            .bind(record)
            .bind(remit_payer)
            .bind(format!("SYN-{record}"))
            .bind(json!([{"claim_id":matched_claim,"row_index":4}]))
            .bind(Uuid::new_v4())
            .execute(&db)
            .await
            .unwrap();
    }
    let (status, list) = call(&r, &a, "GET", "/api/v1/billing/claims", Value::Null, None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let accepted_row = by_id(&list["items"], "id", accepted);
    assert_eq!(
        accepted_row["status_at"]
            .as_str()
            .unwrap()
            .parse::<chrono::DateTime<Utc>>()
            .unwrap()
            .timestamp(),
        chrono::DateTime::parse_from_rfc3339("2026-11-23T08:00:00Z")
            .unwrap()
            .timestamp()
    );
    assert_eq!(accepted_row["worklist_remittance"], Value::Null);
    let payment_row = by_id(&list["items"], "id", payment_revealed);
    assert_eq!(payment_row["worklist_remittance"]["id"], json!(remittance));
    assert_eq!(payment_row["worklist_remittance"]["row_index"], 4);
    for (claim, visit, number) in claims {
        let row = by_id(&list["items"], "id", claim);
        assert_eq!(row["visit_id"], json!(visit));
        assert_eq!(row["encounter_number"], number);
        assert_eq!(row["service_date"], format!("2026-03-0{number}"));
        assert_eq!(row["total_cents"], 10000);
        assert!(row.get("content").is_none());
        assert!(row.get("snapshot").is_none());
    }
    // Another practice sees none of these and numbers its own from 1.
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    other.sub = Uuid::new_v4();
    user(&db, &other, other.sub, "owner", false).await;
    let data = overview(&r, &other, "").await;
    assert_eq!(data["accounts"]["items"], json!([]));
    assert_eq!(data["copays"]["items"], json!([]));
}
