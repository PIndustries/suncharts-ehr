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
    model::{SoapNote, StartVisit, Vitals},
    postgres::PostgresBackend,
    State,
};
use tower::ServiceExt;
use uuid::Uuid;
const SECRET: &str = "synthetic-rooming-test-secret";
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
    let schema = format!("rooming_test_{}", Uuid::new_v4().simple());
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
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-ROOMING','Avery','Synthetic','1990-01-01')").bind(doc.tenant_id).bind(patient).execute(&db).await.unwrap();
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
fn vitals() -> Vitals {
    Vitals {
        systolic_mm_hg: 120,
        diastolic_mm_hg: 80,
        heart_rate_bpm: 70,
        temperature_c: 36.7,
        weight_kg: 70.,
        height_cm: 170.,
        oxygen_saturation_pct: 98.,
    }
}
fn note() -> SoapNote {
    SoapNote {
        subjective: "Synthetic history".into(),
        objective: "Synthetic examination".into(),
        assessment: "Synthetic assessment".into(),
        plan: "Synthetic plan".into(),
    }
}
fn intake() -> Value {
    json!({"status":"ready","chief_complaint":"Synthetic follow-up","intake_notes":"Reviewed with patient","medications_reviewed":true,"allergies_reviewed":true})
}
#[tokio::test]
async fn delegated_intake_preserves_clinician_authority_and_attribution() {
    let (db, doc, nurse, appointment) = setup().await;
    let b = PostgresBackend(db.clone());
    let v = b
        .start_visit(
            &nurse,
            StartVisit {
                appointment_id: appointment,
            },
        )
        .await
        .unwrap();
    assert_eq!(v.clinician_id, doc.sub);
    let v = b
        .save_vitals(&nurse, v.id, v.version, vitals())
        .await
        .unwrap();
    assert!(b.save_note(&nurse, v.id, v.version, note()).await.is_err());
    assert!(b.sign(&nurse, v.id, v.version).await.is_err());
    let r = app(db.clone());
    let path = format!("/api/v1/visits/{}/rooming", v.id);
    let (status, data) = call(&r, &nurse, "PUT", &path, intake(), Some(v.version)).await;
    assert_eq!(status, 200, "{data}");
    assert_eq!(data["status"], "ready");
    assert_eq!(data["updated_by"], nurse.sub.to_string());
    assert_eq!(data["history"].as_array().unwrap().len(), 2);
    assert_eq!(data["visit"]["clinician_id"], doc.sub.to_string());
    let version = data["version"].as_i64().unwrap();
    let v = b.save_note(&doc, v.id, version, note()).await.unwrap();
    let signed = b.sign(&doc, v.id, v.version).await.unwrap();
    assert_eq!(signed.signed_by, Some(doc.sub));
    assert!(b
        .save_vitals(&nurse, v.id, signed.version, vitals())
        .await
        .is_err());
    let (status, _) = call(&r, &nurse, "PUT", &path, intake(), Some(signed.version)).await;
    assert_eq!(status, 409);
    let (status, data) = call(&r, &nurse, "GET", &path, Value::Null, None).await;
    assert_eq!(status, 200);
    assert_eq!(data["can_edit"], false);
    assert!(sqlx::query(
        "UPDATE visit_rooming SET chief_complaint='altered' WHERE tenant_id=$1 AND visit_id=$2"
    )
    .bind(doc.tenant_id)
    .bind(v.id)
    .execute(&db)
    .await
    .is_err());
    assert!(
        sqlx::query("DELETE FROM visit_rooming_revisions WHERE tenant_id=$1 AND visit_id=$2")
            .bind(doc.tenant_id)
            .bind(v.id)
            .execute(&db)
            .await
            .is_err()
    );
    let attributed:i64=sqlx::query_scalar("SELECT count(*) FROM visit_rooming_revisions WHERE tenant_id=$1 AND visit_id=$2 AND actor_id=$3").bind(doc.tenant_id).bind(v.id).bind(nurse.sub).fetch_one(&db).await.unwrap();
    assert_eq!(attributed, 2);
}
#[tokio::test]
async fn stale_versions_tenant_bounds_and_disabled_staff_are_enforced() {
    let (db, doc, mut nurse, appointment) = setup().await;
    let b = PostgresBackend(db.clone());
    let v = b
        .start_visit(
            &nurse,
            StartVisit {
                appointment_id: appointment,
            },
        )
        .await
        .unwrap();
    let r = app(db.clone());
    let path = format!("/api/v1/visits/{}/rooming", v.id);
    let (status, _) = call(&r, &nurse, "PUT", &path, intake(), None).await;
    assert_eq!(status, 428);
    let (status, _) = call(&r, &nurse, "PUT", &path, intake(), Some(v.version)).await;
    assert_eq!(status, 200);
    let (status, _) = call(&r, &nurse, "PUT", &path, intake(), Some(v.version)).await;
    assert_eq!(status, 409);
    let foreign = actor(Uuid::new_v4(), Role::Nurse);
    let (status, _) = call(&r, &foreign, "GET", &path, Value::Null, None).await;
    assert_eq!(status, 404);
    let (status, _) = call(&r, &foreign, "PUT", &path, intake(), Some(v.version + 1)).await;
    assert_eq!(status, 404);
    let desk = actor(doc.tenant_id, Role::FrontDesk);
    let (status, _) = call(&r, &desk, "PUT", &path, intake(), Some(v.version + 1)).await;
    assert_eq!(status, 403);
    sqlx::query("UPDATE browser_users SET disabled=true WHERE tenant_id=$1 AND id=$2")
        .bind(nurse.tenant_id)
        .bind(nurse.sub)
        .execute(&db)
        .await
        .unwrap();
    assert!(b
        .save_vitals(&nurse, v.id, v.version + 1, vitals())
        .await
        .is_err());
    let (status, _) = call(&r, &nurse, "PUT", &path, intake(), Some(v.version + 1)).await;
    assert_eq!(status, 403);
    sqlx::query("UPDATE browser_users SET disabled=false,role='medical_assistant' WHERE tenant_id=$1 AND id=$2").bind(nurse.tenant_id).bind(nurse.sub).execute(&db).await.unwrap();
    let (status, _) = call(&r, &nurse, "PUT", &path, intake(), Some(v.version + 1)).await;
    assert_eq!(status, 403);
    nurse.role = Role::MedicalAssistant;
    let (status, _) = call(&r, &nurse, "PUT", &path, intake(), Some(v.version + 1)).await;
    assert_eq!(status, 200);
    let peer = actor(doc.tenant_id, Role::Clinician);
    assert!(b
        .save_vitals(&peer, v.id, v.version + 2, vitals())
        .await
        .is_err());
}
#[tokio::test]
async fn intake_and_vitals_rollback_if_audit_cannot_commit() {
    let (db, _doc, nurse, appointment) = setup().await;
    let b = PostgresBackend(db.clone());
    let v = b
        .start_visit(
            &nurse,
            StartVisit {
                appointment_id: appointment,
            },
        )
        .await
        .unwrap();
    sqlx::query("CREATE FUNCTION reject_rooming_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('visit.rooming_save','visit.vitals_save') THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER rooming_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_rooming_audit()").execute(&db).await.unwrap();
    let r = app(db.clone());
    let path = format!("/api/v1/visits/{}/rooming", v.id);
    let (status, _) = call(&r, &nurse, "PUT", &path, intake(), Some(v.version)).await;
    assert_eq!(status, 500);
    assert!(b
        .save_vitals(&nurse, v.id, v.version, vitals())
        .await
        .is_err());
    let (version, stored): (i64, Option<Value>) =
        sqlx::query_as("SELECT version,vitals FROM visits WHERE tenant_id=$1 AND id=$2")
            .bind(nurse.tenant_id)
            .bind(v.id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(version, v.version);
    assert!(stored.is_none());
    for table in ["visit_rooming", "visit_rooming_revisions"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}
