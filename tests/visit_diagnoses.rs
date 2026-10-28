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
    backend::ClinicalBackend,
    browser::BrowserAuth,
    model::{SoapNote, StartVisit, Visit},
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
    let schema = format!("diagnoses_test_{}", Uuid::new_v4().simple());
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
    (db, doc, nurse, appointment)
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
fn note() -> SoapNote {
    SoapNote {
        subjective: "Synthetic history".into(),
        objective: "Synthetic exam".into(),
        assessment: "Synthetic assessment".into(),
        plan: "Synthetic plan".into(),
    }
}
async fn started(db: &PgPool, doc: &Actor, appointment_id: Uuid) -> Visit {
    PostgresBackend(db.clone())
        .start_visit(doc, StartVisit { appointment_id })
        .await
        .unwrap()
}
fn diagnoses() -> Value {
    json!({"diagnoses":[{"code":" r51.9 ","display":" Synthetic headache "},{"code":"Z00.00","display":"Synthetic examination"}],"reason":"Synthetic encounter assessment"})
}
#[tokio::test]
async fn ordered_diagnoses_preserve_identity_history_and_shared_visit_version() {
    let (db, doc, _, appointment) = setup().await;
    let v = started(&db, &doc, appointment).await;
    let r = app(db.clone());
    let path = format!("/api/v1/visits/{}/diagnoses", v.id);
    let (status, empty) = call(&r, &doc, "GET", &path, Value::Null, None).await;
    assert_eq!(status, 200, "{empty}");
    assert_eq!(empty["diagnoses"], json!([]));
    assert_eq!(empty["can_edit"], true);
    let (status, first) = call(&r, &doc, "PUT", &path, diagnoses(), Some(v.version)).await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["version"], v.version + 1);
    assert_eq!(first["diagnoses"][0]["code"], "R51.9");
    assert_eq!(first["diagnoses"][0]["display"], "Synthetic headache");
    assert_eq!(first["diagnoses"][0]["rank"], 1);
    assert_eq!(first["diagnoses"][1]["rank"], 2);
    let headache_id = first["diagnoses"][0]["id"].clone();
    let exam_id = first["diagnoses"][1]["id"].clone();
    assert!(Uuid::parse_str(headache_id.as_str().unwrap()).is_ok());
    let (status, reordered) = call(&r, &doc, "PUT", &path,
        json!({"diagnoses":[{"code":"Z00.00","display":"Synthetic exam updated"},{"code":"R51.9","display":"Synthetic headache"}],"reason":"Reordered assessment"}), Some(v.version+1)).await;
    assert_eq!(status, 200, "{reordered}");
    assert_eq!(reordered["diagnoses"][0]["id"], exam_id);
    assert_eq!(reordered["diagnoses"][1]["id"], headache_id);
    assert_eq!(reordered["history"].as_array().unwrap().len(), 2);
    assert_eq!(reordered["history"][0]["actor_id"], doc.sub.to_string());
    assert_eq!(reordered["history"][0]["reason"], "Reordered assessment");
    let backend = PostgresBackend(db.clone());
    assert!(backend
        .save_note(&doc, v.id, v.version + 1, note())
        .await
        .is_err());
    let saved = backend
        .save_note(&doc, v.id, v.version + 2, note())
        .await
        .unwrap();
    let (status, _) = call(&r, &doc, "PUT", &path, diagnoses(), Some(v.version + 2)).await;
    assert_eq!(status, 409);
    let (status, cleared) = call(
        &r,
        &doc,
        "PUT",
        &path,
        json!({"diagnoses":[],"reason":"Removed synthetic assessment"}),
        Some(saved.version),
    )
    .await;
    assert_eq!(status, 200, "{cleared}");
    assert_eq!(cleared["diagnoses"], json!([]));
    assert_eq!(cleared["history"].as_array().unwrap().len(), 3);
    assert!(sqlx::query(
        "DELETE FROM visit_diagnosis_revisions WHERE tenant_id=$1 AND visit_id=$2"
    )
    .bind(doc.tenant_id)
    .bind(v.id)
    .execute(&db)
    .await
    .is_err());
}
#[tokio::test]
async fn diagnosis_writes_require_assigned_clinician_and_tenant_scope() {
    let (db, doc, nurse, appointment) = setup().await;
    let v = started(&db, &doc, appointment).await;
    let r = app(db.clone());
    let path = format!("/api/v1/visits/{}/diagnoses", v.id);
    for other in [
        nurse,
        actor(doc.tenant_id, Role::MedicalAssistant),
        actor(doc.tenant_id, Role::FrontDesk),
        actor(doc.tenant_id, Role::ReadOnly),
        actor(doc.tenant_id, Role::Clinician),
        actor(doc.tenant_id, Role::Owner),
    ] {
        let (status, data) = call(&r, &other, "GET", &path, Value::Null, None).await;
        assert_eq!(status, 200, "{data}");
        assert_eq!(data["can_edit"], false);
        let (status, _) = call(&r, &other, "PUT", &path, diagnoses(), Some(v.version)).await;
        assert_eq!(status, 403);
    }
    let mut patient = actor(doc.tenant_id, Role::Patient);
    patient.patient_id = Some(v.patient_id);
    let (status, _) = call(&r, &patient, "GET", &path, Value::Null, None).await;
    assert_eq!(status, 403);
    let foreign = actor(Uuid::new_v4(), Role::Clinician);
    for method in ["GET", "PUT"] {
        let (status, _) = call(&r, &foreign, method, &path, diagnoses(), Some(v.version)).await;
        assert_eq!(status, 404);
    }
    let (status, _) = call(&r, &doc, "PUT", &path, diagnoses(), None).await;
    assert_eq!(status, 428);
    let (status, _) = call(&r, &doc, "PUT", &path, diagnoses(), Some(v.version + 1)).await;
    assert_eq!(status, 409);
}
#[tokio::test]
async fn invalid_or_duplicate_diagnoses_never_change_visit() {
    let (db, doc, _, appointment) = setup().await;
    let v = started(&db, &doc, appointment).await;
    let r = app(db.clone());
    let path = format!("/api/v1/visits/{}/diagnoses", v.id);
    let mut invalid = vec![
        json!({"diagnoses":[{"code":"not a code","display":"Synthetic"}],"reason":"Synthetic"}),
        json!({"diagnoses":[{"code":"R51.9","display":" "}],"reason":"Synthetic"}),
        json!({"diagnoses":[{"code":"R51.9","display":"Synthetic"}],"reason":" "}),
        json!({"diagnoses":[{"code":"R51.9","display":"Synthetic"},{"code":" r51.9 ","display":"Duplicate"}],"reason":"Synthetic"}),
        json!({"diagnoses":[],"reason":"x".repeat(2001)}),
    ];
    invalid.push(json!({"diagnoses":(0..21).map(|i|json!({"code":format!("Z00.{i:02}"),"display":"Synthetic"})).collect::<Vec<_>>(),"reason":"Synthetic"}));
    for input in invalid {
        let (status, data) = call(&r, &doc, "PUT", &path, input, Some(v.version)).await;
        assert_eq!(status, 400, "{data}");
    }
    let (status, data) = call(&r, &doc, "GET", &path, Value::Null, None).await;
    assert_eq!(status, 200);
    assert_eq!(data["version"], v.version);
    assert_eq!(data["diagnoses"], json!([]));
    assert_eq!(data["history"], json!([]));
}
#[tokio::test]
async fn signing_locks_diagnoses_in_api_and_database() {
    let (db, doc, _, appointment) = setup().await;
    let v = started(&db, &doc, appointment).await;
    let r = app(db.clone());
    let path = format!("/api/v1/visits/{}/diagnoses", v.id);
    let (status, data) = call(&r, &doc, "PUT", &path, diagnoses(), Some(v.version)).await;
    assert_eq!(status, 200, "{data}");
    let backend = PostgresBackend(db.clone());
    let noted = backend
        .save_note(&doc, v.id, v.version + 1, note())
        .await
        .unwrap();
    let signed = backend.sign(&doc, v.id, noted.version).await.unwrap();
    let (status, _) = call(&r, &doc, "PUT", &path, diagnoses(), Some(signed.version)).await;
    assert_eq!(status, 409);
    let (status, data) = call(&r, &doc, "GET", &path, Value::Null, None).await;
    assert_eq!(status, 200);
    assert_eq!(data["can_edit"], false);
    assert_eq!(data["diagnoses"][0]["code"], "R51.9");
    assert!(sqlx::query(
        "UPDATE visit_diagnoses SET diagnoses='[]' WHERE tenant_id=$1 AND visit_id=$2"
    )
    .bind(doc.tenant_id)
    .bind(v.id)
    .execute(&db)
    .await
    .is_err());
    assert!(
        sqlx::query("DELETE FROM visit_diagnoses WHERE tenant_id=$1 AND visit_id=$2")
            .bind(doc.tenant_id)
            .bind(v.id)
            .execute(&db)
            .await
            .is_err()
    );
    assert!(sqlx::query(
        "UPDATE visit_diagnosis_revisions SET reason='altered' WHERE tenant_id=$1 AND visit_id=$2"
    )
    .bind(doc.tenant_id)
    .bind(v.id)
    .execute(&db)
    .await
    .is_err());
}
#[tokio::test]
async fn diagnosis_and_history_rollback_when_audit_fails() {
    let (db, doc, _, appointment) = setup().await;
    let v = started(&db, &doc, appointment).await;
    sqlx::query("CREATE FUNCTION reject_diagnosis_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='visit.diagnoses_save' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER diagnosis_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_diagnosis_audit()").execute(&db).await.unwrap();
    let r = app(db.clone());
    let path = format!("/api/v1/visits/{}/diagnoses", v.id);
    let (status, _) = call(&r, &doc, "PUT", &path, diagnoses(), Some(v.version)).await;
    assert_eq!(status, 500);
    let version: i64 =
        sqlx::query_scalar("SELECT version FROM visits WHERE tenant_id=$1 AND id=$2")
            .bind(doc.tenant_id)
            .bind(v.id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(version, v.version);
    for table in ["visit_diagnoses", "visit_diagnosis_revisions"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}

#[tokio::test]
async fn simultaneous_diagnosis_saves_cannot_overwrite_each_other() {
    let (db, doc, _, appointment) = setup().await;
    let v = started(&db, &doc, appointment).await;
    let r = app(db.clone());
    let path = format!("/api/v1/visits/{}/diagnoses", v.id);
    let first = diagnoses();
    let second = json!({"diagnoses":[{"code":"Z00.00","display":"Competing synthetic assessment"}],"reason":"Competing synthetic change"});
    let (a, b) = tokio::join!(
        call(&r, &doc, "PUT", &path, first, Some(v.version)),
        call(&r, &doc, "PUT", &path, second, Some(v.version))
    );
    let mut statuses = vec![a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, vec![200, 409]);
    let (status, data) = call(&r, &doc, "GET", &path, Value::Null, None).await;
    assert_eq!(status, 200);
    assert_eq!(data["version"], v.version + 1);
    assert_eq!(data["history"].as_array().unwrap().len(), 1);
    let saves:i64=sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND action='visit.diagnoses_save'").bind(doc.tenant_id).bind(v.id).fetch_one(&db).await.unwrap();
    assert_eq!(saves, 1);
}
