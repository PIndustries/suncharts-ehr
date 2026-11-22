// SPDX-License-Identifier: AGPL-3.0-only
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::Arc;
use suncharts_engine::{browser::BrowserAuth, postgres::PostgresBackend, State};
use tower::ServiceExt;
use uuid::Uuid;
const ORIGIN: &str = "http://127.0.0.1:8099";
#[allow(dead_code)]
struct Fixture {
    db: PgPool,
    app: Router,
    tenant: Uuid,
    owner: Uuid,
    cookie: String,
    schema: String,
    url: String,
}
async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("practice_overview_{}", Uuid::new_v4().simple());
    let schema_clone = schema.clone();
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |c, _| {
            let query = format!("SET search_path TO {schema_clone}");
            Box::pin(async move {
                sqlx::query(&query).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let tenant = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let cookie = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'owner@example.test','synthetic-not-a-login-hash','owner')").bind(tenant).bind(owner).execute(&db).await.unwrap();
    session(&db, tenant, owner, &cookie).await;
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: "synthetic-practice-admin-test-secret".into(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
    });
    Fixture {
        db,
        app,
        tenant,
        owner,
        cookie,
        schema,
        url,
    }
}
async fn session(db: &PgPool, tenant: Uuid, user: Uuid, cookie: &str) {
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(format!("{:x}",Sha256::digest(cookie.as_bytes()))).bind(tenant).bind(user).execute(db).await.unwrap();
}
async fn cleanup(f: Fixture) {
    f.db.close().await;
    let base = PgPool::connect(&f.url).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", f.schema))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
}
async fn call(
    app: &Router,
    cookie: &str,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let mut q = Request::builder()
        .method(method)
        .uri(path)
        .header("Cookie", format!("sce_session={cookie}"))
        .header("Origin", ORIGIN)
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        q = q.header("If-Match", format!("\"{v}\""));
    }
    let response = app
        .clone()
        .oneshot(q.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let data = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&data).unwrap_or(Value::Null))
}
#[tokio::test]
async fn overview_counts_patients_gaps_claims_and_money() {
    let f = setup().await;
    // Two patients: one insured with no address, one self-pay with an address and phone.
    let insured = Uuid::new_v4();
    let selfpay = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-OV-1','Synthetic','Insured','1980-01-01'),($1,$3,'SYN-OV-2','Synthetic','Selfpay','1981-02-02')").bind(f.tenant).bind(insured).bind(selfpay).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,'{\"address\":{\"line1\":\"1 Synthetic Way\",\"city\":\"Synthetic\",\"region\":\"SY\",\"postal_code\":\"00000\",\"country\":\"US\"},\"phone\":\"5555550100\"}')").bind(f.tenant).bind(selfpay).execute(&f.db).await.unwrap();
    let payer = Uuid::new_v4();
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) SELECT $1,$2,'{\"name\":\"Synthetic Plan\",\"payer_code\":\"SYN01\",\"active\":true}'::jsonb,$3,'x'").bind(f.tenant).bind(payer).bind(Uuid::new_v4()).execute(&f.db).await.ok();
    sqlx::query("INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,'{\"status\":\"active\",\"priority\":\"primary\",\"member_id\":\"\"}',$5,'x')").bind(f.tenant).bind(Uuid::new_v4()).bind(insured).bind(payer).bind(Uuid::new_v4()).execute(&f.db).await.ok();
    let (status, v) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/overview?tz=America/New_York",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["time_zone"], "America/New_York");
    assert_eq!(v["patients"]["active"], 2);
    assert_eq!(v["patients"]["missing_address"], 1);
    assert_eq!(v["patients"]["missing_phone"], 1);
    let insured_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM insurance_coverages WHERE tenant_id=$1")
            .bind(f.tenant)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(v["patients"]["insured"], insured_rows);
    assert_eq!(v["patients"]["self_pay"], 2 - insured_rows);
    // The owner may see billing, so claims, money and the 30-day trend are there.
    assert!(v["claims"]["by_status"].is_object());
    assert_eq!(v["claims"]["needs_correction"], 0);
    assert_eq!(v["money"]["collected_today_cents"], 0);
    assert!(v["money"]["payment_account_balance"].is_null());
    assert_eq!(v["trend"].as_array().unwrap().len(), 30);
    // Money received is counted once per payment: a desk receipt on its day, a voided one not at all.
    let appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,now(),now()+interval '30 minutes','checked_in')").bind(f.tenant).bind(appointment).bind(selfpay).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    let (kept, voided) = (Uuid::new_v4(), Uuid::new_v4());
    for (id, cents) in [(kept, 2500_i64), (voided, 1000)] {
        sqlx::query("INSERT INTO billing_copay_receipts(tenant_id,id,patient_id,appointment_id,amount_cents,method,reference,occurred_on,reason,request_id,creation_hash,actor_id) VALUES($1,$2,$3,$4,$5,'cash','',(now() AT TIME ZONE 'America/New_York')::date,'Synthetic cash',$6,'x',$7)").bind(f.tenant).bind(id).bind(selfpay).bind(appointment).bind(cents).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    }
    sqlx::query("INSERT INTO billing_copay_voids(tenant_id,receipt_id,reason,actor_id) VALUES($1,$2,'Synthetic void',$3)").bind(f.tenant).bind(voided).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    let (_, v) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/overview?tz=America/New_York",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(v["money"]["collected_today_cents"], 2500);
    assert_eq!(v["money"]["collected_month_cents"], 2500);
    assert_eq!(
        v["trend"].as_array().unwrap().last().unwrap()["collected_cents"],
        2500,
        "the 30-day line agrees with the tile"
    );
    // An unknown time zone falls back to UTC rather than failing.
    let (status, v) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/overview?tz=Not/AZone",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(
        (status, v["time_zone"].as_str()),
        (StatusCode::OK, Some("UTC"))
    );
    cleanup(f).await;
}
