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
const SECRET: &str = "synthetic-diagnoses-test-secret";
fn actor(tenant_id: Uuid, role: Role) -> Actor {
    let now = Utc::now().timestamp();
    Actor {
        sub: Uuid::new_v4(),
        tenant_id,
        role,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    }
}
async fn setup() -> (PgPool, Actor, Actor, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("health_history_test_{}", Uuid::new_v4().simple());
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
    let doc = actor(Uuid::new_v4(), Role::Clinician);
    let nurse = actor(doc.tenant_id, Role::Nurse);
    for (a, role) in [(&doc, "clinician"), (&nurse, "nurse")] {
        sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-login',$4)").bind(a.tenant_id).bind(a.sub).bind(format!("{}@example.test",a.sub)).bind(role).execute(&db).await.unwrap();
    }
    let patient = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-DIAGNOSES','Avery','Synthetic','1990-01-01')").bind(doc.tenant_id).bind(patient).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-26T14:00:00Z','2026-10-26T14:30:00Z','checked_in')").bind(doc.tenant_id).bind(appointment).bind(patient).bind(doc.sub).execute(&db).await.unwrap();
    (db, doc, nurse, patient)
}
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
    let mut q = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        q = q.header("If-Match", format!("\"{v}\""));
    }
    let res = r
        .clone()
        .oneshot(q.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn change(kind: &str) -> Value {
    json!({"content":{"kind":kind,"title":"Synthetic history","status":"completed","verification":"unconfirmed","onset_date":"2020-01-01","end_date":null,"code":null,"notes":"Synthetic only"},"reason":"Initial history"})
}
fn create(kind: &str) -> Value {
    let mut v = change(kind);
    v["request_id"] = json!(Uuid::new_v4());
    v
}
#[tokio::test]
async fn history_roundtrip_idempotency_versions_and_revisions() {
    let (db, doc, nurse, p) = setup().await;
    let r = app(db.clone());
    let base = format!("/api/v1/patients/{p}/health-history");
    let input = create("surgery");
    let (status, first) = call(&r, &doc, "POST", &base, input.clone(), None).await;
    assert_eq!(status, 200, "{first}");
    let (_, again) = call(&r, &doc, "POST", &base, input.clone(), None).await;
    assert_eq!(first["id"], again["id"]);
    assert_eq!(again["version"], 1);
    let mut changed = input.clone();
    changed["reason"] = json!("Different request");
    assert_eq!(call(&r, &doc, "POST", &base, changed, None).await.0, 409);
    let path = format!("{base}/{}", first["id"].as_str().unwrap());
    assert_eq!(
        call(&r, &nurse, "GET", &path, Value::Null, None).await.0,
        200
    );
    assert_eq!(
        call(&r, &nurse, "PUT", &path, change("surgery"), Some(1))
            .await
            .0,
        403
    );
    assert_eq!(
        call(&r, &doc, "PUT", &path, change("surgery"), None)
            .await
            .0,
        428
    );
    let mut edit = change("surgery");
    edit["content"]["status"] = json!("entered_in_error");
    edit["reason"] = json!("Synthetic correction");
    let (status, saved) = call(&r, &doc, "PUT", &path, edit, Some(1)).await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["version"], 2);
    assert_eq!(
        call(&r, &doc, "PUT", &path, change("surgery"), Some(1))
            .await
            .0,
        409
    );
    let (_, history) = call(
        &r,
        &doc,
        "GET",
        &format!("{path}/revisions"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(history["items"].as_array().unwrap().len(), 2);
    assert_eq!(history["items"][0]["content"]["status"], "entered_in_error");
    assert_eq!(history["items"][1]["content"]["status"], "completed");
    let id = Uuid::parse_str(first["id"].as_str().unwrap()).unwrap();
    assert!(
        sqlx::query("DELETE FROM health_history_revisions WHERE tenant_id=$1 AND entry_id=$2")
            .bind(doc.tenant_id)
            .bind(id)
            .execute(&db)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM health_history_entries WHERE tenant_id=$1 AND id=$2")
            .bind(doc.tenant_id)
            .bind(id)
            .execute(&db)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn history_filters_tenant_patient_and_validation() {
    let (db, doc, _, p) = setup().await;
    let r = app(db.clone());
    let base = format!("/api/v1/patients/{p}/health-history");
    let (_, s) = call(&r, &doc, "POST", &base, create("surgery"), None).await;
    assert_eq!(
        call(&r, &doc, "POST", &base, create("dental"), None)
            .await
            .0,
        200
    );
    let path = format!("{base}/{}", s["id"].as_str().unwrap());
    let foreign = actor(Uuid::new_v4(), Role::Clinician);
    assert_eq!(
        call(&r, &foreign, "GET", &path, Value::Null, None).await.0,
        404
    );
    let mut patient = actor(doc.tenant_id, Role::Patient);
    patient.patient_id = Some(p);
    assert_eq!(
        call(&r, &patient, "GET", &base, Value::Null, None).await.0,
        403
    );
    let wrong = format!(
        "/api/v1/patients/{}/health-history/{}",
        Uuid::new_v4(),
        s["id"].as_str().unwrap()
    );
    assert_eq!(
        call(&r, &doc, "GET", &wrong, Value::Null, None).await.0,
        404
    );
    let (_, filtered) = call(
        &r,
        &doc,
        "GET",
        &format!("{base}?kind=dental"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
    let (_, page) = call(
        &r,
        &doc,
        "GET",
        &format!("{base}?_count=1"),
        Value::Null,
        None,
    )
    .await;
    assert!(page["next_cursor"].is_string());
    let (_, next) = call(
        &r,
        &doc,
        "GET",
        &format!(
            "{base}?_count=1&_after={}",
            page["next_cursor"].as_str().unwrap()
        ),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(next["items"].as_array().unwrap().len(), 1);
    assert_ne!(next["items"][0]["id"], page["items"][0]["id"]);
    for query in [
        "kind=surgery&kind=dental",
        "_count=101",
        "_after=bad",
        "status=unknown",
        "foo=bar",
    ] {
        assert_eq!(
            call(
                &r,
                &doc,
                "GET",
                &format!("{base}?{query}"),
                Value::Null,
                None
            )
            .await
            .0,
            400
        );
    }
    let mut bad = create("surgery");
    bad["content"]["end_date"] = json!("2019-01-01");
    assert_eq!(call(&r, &doc, "POST", &base, bad, None).await.0, 400);
    assert_eq!(
        call(&r, &doc, "PUT", &path, change("dental"), Some(1))
            .await
            .0,
        400
    );
}
#[tokio::test]
async fn history_mutation_rolls_back_if_audit_fails() {
    let (db, doc, _, p) = setup().await;
    let r = app(db.clone());
    let base = format!("/api/v1/patients/{p}/health-history");
    sqlx::query("CREATE FUNCTION reject_history_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.health_history.create' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_history_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_history_audit()").execute(&db).await.unwrap();
    assert_eq!(
        call(&r, &doc, "POST", &base, create("surgery"), None)
            .await
            .0,
        500
    );
    for table in ["health_history_entries", "health_history_revisions"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}
#[tokio::test]
async fn simultaneous_history_updates_keep_one_attributed_version() {
    let (db, doc, _, p) = setup().await;
    let r = app(db.clone());
    let base = format!("/api/v1/patients/{p}/health-history");
    let (_, e) = call(&r, &doc, "POST", &base, create("dental"), None).await;
    let path = format!("{base}/{}", e["id"].as_str().unwrap());
    let (a, b) = tokio::join!(
        call(&r, &doc, "PUT", &path, change("dental"), Some(1)),
        call(&r, &doc, "PUT", &path, change("dental"), Some(1))
    );
    let mut codes = vec![a.0.as_u16(), b.0.as_u16()];
    codes.sort();
    assert_eq!(codes, vec![200, 409]);
}
#[tokio::test]
async fn concurrent_retries_and_failed_update_do_not_duplicate_or_replace_history() {
    let (db, doc, _, p) = setup().await;
    let r = app(db.clone());
    let base = format!("/api/v1/patients/{p}/health-history");
    let input = create("surgery");
    let (a, b) = tokio::join!(
        call(&r, &doc, "POST", &base, input.clone(), None),
        call(&r, &doc, "POST", &base, input, None)
    );
    assert_eq!(a.0, 200);
    assert_eq!(b.0, 200);
    assert_eq!(a.1["id"], b.1["id"]);
    sqlx::query("CREATE FUNCTION reject_history_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.health_history.update' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_history_update BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_history_update()").execute(&db).await.unwrap();
    let path = format!("{base}/{}", a.1["id"].as_str().unwrap());
    let mut edited = change("surgery");
    edited["content"]["title"] = json!("Should roll back");
    assert_eq!(call(&r, &doc, "PUT", &path, edited, Some(1)).await.0, 500);
    let (_, read) = call(&r, &doc, "GET", &path, Value::Null, None).await;
    assert_eq!(read["version"], 1);
    assert_eq!(read["content"]["title"], "Synthetic history");
    let (_, history) = call(
        &r,
        &doc,
        "GET",
        &format!("{path}/revisions"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(history["items"].as_array().unwrap().len(), 1);
}
