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
    let schema = format!("copay_receipts_test_{}", Uuid::new_v4().simple());
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
#[tokio::test]
async fn checkin_copays_allocate_once_and_reversals_do_not_reapply_receipts() {
    let (db, a, p, appointment) = setup().await;
    let r = app(db.clone());
    let path = format!("/api/v1/patients/{p}/billing/copays");
    let input = receipt(appointment, 2500);
    let ((status, first), (retry_status, replay)) = tokio::join!(
        call(&r, &a, "POST", &path, input.clone(), None),
        call(&r, &a, "POST", &path, input.clone(), None)
    );
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(retry_status, StatusCode::OK, "{replay}");
    assert_eq!(first["id"], replay["id"]);
    assert_eq!(first["allocated_cents"], 0);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM visits")
            .fetch_one(&db)
            .await
            .unwrap(),
        0,
        "copay receipt must work before the encounter exists"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    let mut changed = input.clone();
    changed["amount_cents"] = json!(3000);
    assert_eq!(
        call(&r, &a, "POST", &path, changed, None).await.0,
        StatusCode::CONFLICT
    );
    let mut unconfirmed = receipt(appointment, 2500);
    unconfirmed["received_confirmed"] = json!(false);
    assert_eq!(
        call(&r, &a, "POST", &path, unconfirmed, None).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut nurse = a.clone();
    nurse.role = Role::Nurse;
    assert_eq!(
        call(&r, &nurse, "POST", &path, input.clone(), None).await.0,
        StatusCode::FORBIDDEN
    );
    let mut foreign = a.clone();
    foreign.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(&r, &foreign, "POST", &path, input.clone(), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &format!("/api/v1/patients/{}/billing/copays", Uuid::new_v4()),
            receipt(appointment, 2500),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,'{}'::jsonb,$5,now())").bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub).bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"})).execute(&db).await.unwrap();
    let accounts = format!("/api/v1/patients/{p}/billing/accounts");
    let (status,account)=call(&r,&a,"POST",&accounts,json!({"request_id":Uuid::new_v4(),"source_history_id":null,"reason":"Reviewed synthetic visit charges","content":{"visit_id":visit,"coverage_id":null,"service_date":"2026-10-25","currency":"USD","notes":"Synthetic only","lines":[{"code_system":"CPT","code":"99213","description":"Synthetic office visit","modifiers":"","units":1,"amount_cents":10000,"diagnosis_codes":["Z00.00"]}]}}),None).await;
    assert_eq!(status, StatusCode::OK, "{account}");
    let account_path = format!("{accounts}/{}", account["id"].as_str().unwrap());
    let (status, posted) = call(
        &r,
        &a,
        "POST",
        &format!("{account_path}/actions"),
        json!({"action":"post","reason":"Reviewed charges"}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{posted}");
    assert_eq!(posted["version"], 2);
    let (_, billing) = call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/patients/{p}/billing"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(billing["copays"][0]["allocated_cents"], 2500);
    assert_eq!(billing["copays"][0]["reversed_cents"], 0);
    assert_eq!(billing["entries"][0]["effect_cents"], -2500);
    let (status, invoice) = call(
        &r,
        &a,
        "POST",
        &format!("{account_path}/invoices"),
        json!({"request_id":Uuid::new_v4(),"responsibility_cents":2500,"reason":"Reviewed copay"}),
        Some(2),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{invoice}");
    assert_eq!(invoice["snapshot"]["amount_due_cents"], 0);
    let (status, no_duplicate) = call(
        &r,
        &a,
        "POST",
        &format!("{account_path}/copays/apply"),
        json!({}),
        Some(2),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{no_duplicate}");
    assert_eq!(no_duplicate["applied_cents"], 0);
    let (status, _) = call(
        &r,
        &a,
        "POST",
        &format!("{path}/{}/void", first["id"].as_str().unwrap()),
        json!({"reason":"Cannot void after allocation"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status,reversed)=call(&r,&a,"POST",&format!("{account_path}/entries"),json!({"request_id":Uuid::new_v4(),"kind":"reversal","amount_cents":null,"reverses_id":billing["entries"][0]["id"],"party":"other","method":"none","reference":"","occurred_on":"2026-10-25","reason":"Correct recorded copay receipt"}),Some(2)).await;
    assert_eq!(status, StatusCode::OK, "{reversed}");
    let (status, not_reapplied) = call(
        &r,
        &a,
        "POST",
        &format!("{account_path}/copays/apply"),
        json!({}),
        Some(3),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{not_reapplied}");
    assert_eq!(not_reapplied["applied_cents"], 0);
    let (_, billing) = call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/patients/{p}/billing"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(billing["copays"][0]["allocated_cents"], 2500);
    assert_eq!(billing["copays"][0]["reversed_cents"], 2500);
    let (status, large) = call(&r, &a, "POST", &path, receipt(appointment, 15000), None).await;
    assert_eq!(status, StatusCode::OK, "{large}");
    assert_eq!(
        large["allocated_cents"], 10000,
        "a larger receipt must leave excess credit unapplied instead of overpaying charges"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT coalesce(sum(effect_cents),0)::bigint FROM billing_entries"
        )
        .fetch_one(&db)
        .await
        .unwrap(),
        -10000
    );
    let void_appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-26T14:00:00Z','2026-10-26T14:30:00Z','booked')").bind(a.tenant_id).bind(void_appointment).bind(p).bind(a.sub).execute(&db).await.unwrap();
    let (_, unapplied) = call(&r, &a, "POST", &path, receipt(void_appointment, 1000), None).await;
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &format!("{path}/{}/void", unapplied["id"].as_str().unwrap()),
            json!({"reason":"Receipt entered for wrong appointment"}),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, billing) = call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/patients/{p}/billing"),
        Value::Null,
        None,
    )
    .await;
    assert!(billing["copays"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == unapplied["id"] && row["voided"] == true));
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM billing_copay_receipts")
        .fetch_one(&db)
        .await
        .unwrap();
    sqlx::query("CREATE FUNCTION reject_copay_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='billing.copay_recorded' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_copay_test_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_copay_test_audit()").execute(&db).await.unwrap();
    assert_eq!(
        call(&r, &a, "POST", &path, receipt(appointment, 500), None)
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_copay_receipts")
            .fetch_one(&db)
            .await
            .unwrap(),
        before,
        "receipt and audit must commit together"
    );
    assert!(
        sqlx::query("UPDATE billing_copay_allocations SET amount_cents=1")
            .execute(&db)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn receipt_write_and_replay_do_not_depend_on_workspace_preview_limit() {
    let (db, a, patient, appointment) = setup().await;
    let r = app(db.clone());
    sqlx::query("INSERT INTO billing_copay_receipts(tenant_id,id,patient_id,appointment_id,amount_cents,method,reference,occurred_on,reason,request_id,creation_hash,actor_id,created_at) SELECT $1,md5('receipt-'||n)::uuid,$2,$3,1,'cash','SYNTHETIC','2020-01-01','Synthetic prior receipt',md5('request-'||n)::uuid,'synthetic',$4,'2020-01-01' FROM generate_series(1,1001) AS n")
        .bind(a.tenant_id).bind(patient).bind(appointment).bind(a.sub).execute(&db).await.unwrap();
    let path = format!("/api/v1/patients/{patient}/billing/copays");
    let input = receipt(appointment, 2500);
    let (status, saved) = call(&r, &a, "POST", &path, input.clone(), None).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["amount_cents"], 2500);
    let (status, replayed) = call(&r, &a, "POST", &path, input, None).await;
    assert_eq!(status, StatusCode::OK, "{replayed}");
    assert_eq!(replayed["id"], saved["id"]);
    let (status, workspace) = call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/patients/{patient}/billing"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "history must not be silently truncated: {workspace}"
    );
}
