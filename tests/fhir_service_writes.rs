// SPDX-License-Identifier: AGPL-3.0-only
use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
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
const SECRET: &str = "synthetic-fhir-write-test-secret";
async fn setup() -> (PgPool, Router, Actor) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable database required");
    let schema = format!("fhir_service_write_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(5)
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
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'synthetic@example.test','unused','owner')").bind(a.tenant_id).bind(a.sub).execute(&db).await.unwrap();
    let r = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        browser: Some(BrowserAuth::new(db.clone(), "http://127.0.0.1:8099".into()).unwrap()),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
    });
    (db, r, a)
}
async fn call(
    r: &Router,
    a: &Actor,
    m: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, HeaderMap, Value) {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        a,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    request(r, &token, m, path, body, version).await
}
async fn request(
    r: &Router,
    token: &str,
    m: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, HeaderMap, Value) {
    let mut q = Request::builder()
        .method(m)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/fhir+json")
        .header("X-Change-Reason", "Synthetic identity correction");
    if let Some(v) = version {
        q = q.header("If-Match", format!("W/\"{v}\""));
    }
    let res = r
        .clone()
        .oneshot(q.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let h = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        h,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn patient_id(db: &PgPool, a: &Actor) -> Uuid {
    let p = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-FHIR-WRITE','Avery','Synthetic','1990-01-01')").bind(a.tenant_id).bind(p).execute(db).await.unwrap();
    p
}
fn order(patient: Uuid) -> Value {
    json!({"resourceType":"ServiceRequest","status":"draft","intent":"order","subject":{"reference":format!("Patient/{patient}")},"code":{"text":"Synthetic glucose","coding":[{"system":"http://loinc.org","code":"2345-7"}]},"category":[{"text":"laboratory"}],"priority":"routine","reasonCode":[{"text":"Synthetic reason"}],"performer":[{"display":"Synthetic destination"}],"note":[{"text":"Synthetic instructions"}]})
}
#[tokio::test]
async fn local_draft_order_create_update_reuses_native_history_and_etags() {
    let (db, r, a) = setup().await;
    let p = patient_id(&db, &a).await;
    let input = order(p);
    let (status, h, v) = call(&r, &a, "POST", "/fhir/ServiceRequest", input.clone(), None).await;
    assert_eq!(status, 201, "{v}");
    assert_eq!(v["status"], "draft");
    assert_eq!(h["etag"], "W/\"1\"");
    let id = v["id"].as_str().unwrap();
    let path = format!("/fhir/ServiceRequest/{id}");
    let (status, h, _) = call(&r, &a, "GET", &path, Value::Null, None).await;
    assert_eq!(status, 200);
    assert_eq!(h["etag"], "W/\"1\"");
    let mut input = input;
    input["id"] = json!(id);
    input["note"] = json!([{"text":"Updated synthetic instructions"}]);
    let (status, h, v) = call(&r, &a, "PUT", &path, input.clone(), Some(1)).await;
    assert_eq!(status, 200, "{v}");
    assert_eq!(h["etag"], "W/\"2\"");
    assert_eq!(
        call(&r, &a, "PUT", &path, input.clone(), Some(1)).await.0,
        412
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM lab_order_revisions WHERE tenant_id=$1 AND order_id=$2",
    )
    .bind(a.tenant_id)
    .bind(id.parse::<Uuid>().unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(count, 2);
    sqlx::query("UPDATE lab_orders SET status='ordered' WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id.parse::<Uuid>().unwrap())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(call(&r, &a, "PUT", &path, input, Some(2)).await.0, 409);
    db.close().await;
}
#[tokio::test]
async fn service_writes_reject_execution_unsupported_fields_other_tenants_and_audit_failures() {
    let (db, r, a) = setup().await;
    let p = patient_id(&db, &a).await;
    for field in ["status", "intent", "doNotPerform", "orderDetail"] {
        let mut v = order(p);
        v[field] = match field {
            "status" => json!("active"),
            "intent" => json!("plan"),
            "doNotPerform" => json!(true),
            _ => json!([{"text":"Undiscardable second test"}]),
        };
        assert_eq!(
            call(&r, &a, "POST", "/fhir/ServiceRequest", v, None)
                .await
                .0,
            400
        );
    }
    let mut foreign = a.clone();
    foreign.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(&r, &foreign, "POST", "/fhir/ServiceRequest", order(p), None)
            .await
            .0,
        404
    );
    let mut reader = a.clone();
    reader.role = Role::ReadOnly;
    assert_eq!(
        call(&r, &reader, "POST", "/fhir/ServiceRequest", order(p), None)
            .await
            .0,
        403
    );
    sqlx::query("CREATE FUNCTION deny_fhir_order_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.order.create' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER deny_fhir_order_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_fhir_order_audit()").execute(&db).await.unwrap();
    assert_eq!(
        call(&r, &a, "POST", "/fhir/ServiceRequest", order(p), None)
            .await
            .0,
        500
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM lab_orders")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM lab_order_revisions")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    db.close().await;
}
