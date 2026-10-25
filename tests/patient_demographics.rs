// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
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
const SECRET: &str = "synthetic-demographics-test-secret";
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
async fn setup() -> (PgPool, Actor, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("demographics_test_{}", Uuid::new_v4().simple());
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
    let p = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-CONTACT','Avery','Synthetic','1990-01-01')").bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    (db, a, p)
}
async fn call(
    r: &Router,
    a: &Actor,
    method: &str,
    p: Uuid,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        a,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let mut q = Request::builder()
        .method(method)
        .uri(format!("/api/v1/patients/{p}/demographics"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        q = q.header("If-Match", format!("\"{v}\""));
    }
    let response = r
        .clone()
        .oneshot(q.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn change() -> Value {
    json!({"content":{"preferred_name":"  Avery  ","pronouns":"they/them","language":"English","administrative_gender":"unknown","phone":"+1 (555) 010-0101","email":"avery@example.test","address":{"line1":"10 Synthetic Lane","city":"Austin","region":"TX","postal_code":"78701","country":"us"},"emergency_contact":{"name":"Taylor Synthetic","relationship":"Sibling","phone":"555-0102"}},"reason":"Patient supplied contact details"})
}
#[tokio::test]
async fn contact_profile_is_scoped_versioned_attributed_and_durable() {
    let (db, a, p) = setup().await;
    let r = app(db.clone());
    let (status, empty) = call(&r, &a, "GET", p, Value::Null, None).await;
    assert_eq!(status, 200);
    assert_eq!(empty["version"], 0);
    assert!(empty["content"]["phone"].is_null());
    assert_eq!(empty["history"], json!([]));
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(call(&r, &other, "GET", p, Value::Null, None).await.0, 404);
    assert_eq!(call(&r, &other, "PUT", p, change(), Some(0)).await.0, 404);
    for role in [Role::ReadOnly, Role::Patient] {
        let mut denied = a.clone();
        denied.role = role;
        denied.patient_id = Some(p);
        assert_eq!(call(&r, &denied, "PUT", p, change(), Some(0)).await.0, 403);
        if matches!(denied.role, Role::Patient) {
            assert_eq!(call(&r, &denied, "GET", p, Value::Null, None).await.0, 403);
        } else {
            assert_eq!(call(&r, &denied, "GET", p, Value::Null, None).await.0, 200);
        }
    }
    assert_eq!(call(&r, &a, "PUT", p, change(), None).await.0, 428);
    let mut desk = a.clone();
    desk.role = Role::FrontDesk;
    desk.sub = Uuid::new_v4();
    let (status, saved) = call(&r, &desk, "PUT", p, change(), Some(0)).await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["content"]["preferred_name"], "Avery");
    assert_eq!(saved["content"]["address"]["country"], "US");
    assert_eq!(saved["history"][0]["author_id"], desk.sub.to_string());
    assert_eq!(call(&r, &a, "PUT", p, change(), Some(0)).await.0, 409);
    // Reconstruct the service on the same durable store: no in-memory profile state.
    let restarted = app(db.clone());
    let (status, read) = call(&restarted, &a, "GET", p, Value::Null, None).await;
    assert_eq!(status, 200);
    assert_eq!(read, saved);
    let mut clinician = a.clone();
    clinician.role = Role::Clinician;
    let mut update = change();
    update["content"]["phone"] = json!("  ");
    let (status, updated) = call(&r, &clinician, "PUT", p, update, Some(1)).await;
    assert_eq!(status, 200, "{updated}");
    assert!(updated["content"]["phone"].is_null());
    assert_eq!(updated["history"].as_array().unwrap().len(), 2);
    assert_eq!(
        updated["history"][1]["content"]["phone"],
        "+1 (555) 010-0101"
    );
    let identity: (String, String, String) = sqlx::query_as(
        "SELECT mrn,given_name,birth_date::text FROM patients WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(p)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        identity,
        ("SYN-CONTACT".into(), "Avery".into(), "1990-01-01".into())
    );
    assert!(
        sqlx::query("UPDATE patient_demographics_history SET reason='rewrite'")
            .execute(&db)
            .await
            .is_err()
    );
    assert!(sqlx::query("DELETE FROM patient_demographics")
        .execute(&db)
        .await
        .is_err());
    let events:i64=sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='patient.demographics_update'").bind(a.tenant_id).fetch_one(&db).await.unwrap();
    assert_eq!(events, 2);
}
#[tokio::test]
async fn contact_concurrency_audit_failure_and_invalid_input_never_overwrite() {
    let (db, a, p) = setup().await;
    let r = app(db.clone());
    for content in [
        json!({"email":"bad-email"}),
        json!({"administrative_gender":"guess"}),
        json!({"address":{"country":"USA"}}),
        json!({"phone":"call-me"}),
        json!({"emergency_contact":{"phone":"555-0101"}}),
        json!({"preferred_name":"bad\nname"}),
        json!({"mrn":"rewrite"}),
    ] {
        let status = call(
            &r,
            &a,
            "PUT",
            p,
            json!({"content":content,"reason":"Validation test"}),
            Some(0),
        )
        .await
        .0;
        assert!([StatusCode::BAD_REQUEST, StatusCode::UNPROCESSABLE_ENTITY].contains(&status));
    }
    let (first, second) = tokio::join!(
        call(&r, &a, "PUT", p, change(), Some(0)),
        call(&r, &a, "PUT", p, change(), Some(0))
    );
    let mut statuses = [first.0.as_u16(), second.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    sqlx::query("CREATE FUNCTION fail_contact_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.demographics_update' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_contact_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_contact_audit()").execute(&db).await.unwrap();
    let mut changed = change();
    changed["content"]["preferred_name"] = json!("Attempted change");
    assert_eq!(call(&r, &a, "PUT", p, changed, Some(1)).await.0, 500);
    let (_, current) = call(&r, &a, "GET", p, Value::Null, None).await;
    assert_eq!(current["version"], 1);
    assert_eq!(current["content"]["preferred_name"], "Avery");
    assert_eq!(current["history"].as_array().unwrap().len(), 1);
    // DB CHECK constraints also reject invalid direct SQL updates, independent of Rust validation.
    assert!(sqlx::query("UPDATE patient_demographics SET version=2,content=jsonb_build_object('email','not-an-email')").execute(&db).await.is_err());
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action='patient.demographics_update'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(audit_count, 1);
}
