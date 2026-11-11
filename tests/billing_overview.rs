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
    for (path, expected) in [
        ("/api/v1/billing/overview", StatusCode::OK),
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
    assert_eq!(url.path(), "/claim_tracking_test");
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
    sqlx::query("INSERT INTO copay_checkout_attempts(tenant_id,id,patient_id,appointment_id,setting_id,credential_revision,installation_id,provider_account_id,livemode,amount_cents,request_id,creation_hash,requested_by,reason,return_url,status,receipt_id) VALUES($1,$2,$3,$4,$5,1,$6,'acct_local_synthetic',false,2500,$7,'synthetic',$8,'Local browser evidence only','http://127.0.0.1:55618/','paid',$9)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(test_patient).bind(test_appointment).bind(setting).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(a.sub).bind(Uuid::parse_str(test_receipt["id"].as_str().unwrap()).unwrap()).execute(&db).await.unwrap();
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
        browser: Some(BrowserAuth::new(db, "http://127.0.0.1:55618".into()).unwrap()),
    });
    let directory = std::path::Path::new("/private/tmp/suncharts-billing-overview-browser");
    std::fs::create_dir_all(directory).unwrap();
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join("browser-auth.json"))
        .unwrap();
    use std::io::Write;
    file.write_all(json!({"origin":"http://127.0.0.1:55618","email":email,"password":password,"role":"billing-view only; clinical and claims denied","first_receipt":first["id"],"synthetic_only":true,"provider_calls":0}).to_string().as_bytes()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:55618")
        .await
        .unwrap();
    println!(
        "Synthetic billing overview ready at http://127.0.0.1:55618; protected login file written."
    );
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            tokio::time::sleep(std::time::Duration::from_secs(1800)).await
        })
        .await
        .unwrap();
}
