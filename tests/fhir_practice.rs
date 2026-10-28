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
const SECRET: &str = "synthetic-fhir-test-secret";
async fn setup() -> (PgPool, Router, Actor, Uuid, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("fhir_practice_test_{}", Uuid::new_v4().simple());
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
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role,display_name) VALUES($1,$2,'synthetic-provider@example.test','synthetic','owner','Synthetic clinician')").bind(a.tenant_id).bind(a.sub).execute(&db).await.unwrap();
    let p = Uuid::new_v4();
    let v = Uuid::new_v4();
    let ap = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-FHIR','Avery','Synthetic','1990-01-01')").bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at) VALUES($1,$2,$3,$4,now(),now()+interval '30 minutes')").bind(a.tenant_id).bind(ap).bind(p).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,vitals) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(v).bind(p).bind(ap).bind(a.sub).bind(json!({"systolic_mm_hg":120,"diastolic_mm_hg":80,"heart_rate_bpm":70,"temperature_c":37.0,"weight_kg":75.0,"height_cm":175.0,"oxygen_saturation_pct":98.0})).execute(&db).await.unwrap();
    let r = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), "http://127.0.0.1:8099".into()).unwrap()),
    });
    (db, r, a, p, v)
}
async fn call(r: &Router, a: Option<&Actor>, path: &str) -> (StatusCode, Value) {
    let token = a.map(|a| {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            a,
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap()
    });
    request(r, token.as_deref(), path, "GET").await
}
async fn request(r: &Router, token: Option<&str>, path: &str, method: &str) -> (StatusCode, Value) {
    let mut q = Request::builder().method(method).uri(path);
    if let Some(t) = token {
        q = q.header("Authorization", format!("Bearer {t}"));
    }
    let response = r
        .clone()
        .oneshot(q.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn facility(db: &PgPool, a: &Actor) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_facilities(tenant_id,id,name,address,phone) VALUES($1,$2,'Synthetic Main Clinic','123 Example St','555-0100')").bind(a.tenant_id).bind(id).execute(db).await.unwrap();
    id
}
async fn coverage(db: &PgPool, a: &Actor, p: Uuid, status: &str) -> Uuid {
    let payer = Uuid::new_v4();
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,'synthetic')").bind(a.tenant_id).bind(payer).bind(json!({"name":"Synthetic payer"})).bind(Uuid::new_v4()).execute(db).await.unwrap();
    let c = json!({"status":status,"member_id":"SYN-MEMBER","relationship":"child","subscriber_name":"Synthetic subscriber","priority":"secondary","effective_date":"2026-01-01","end_date":"2026-12-31","group_number":"SYN-GROUP","plan_name":"Synthetic plan"});
    sqlx::query("INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,$6,'synthetic')").bind(a.tenant_id).bind(id).bind(p).bind(payer).bind(c).bind(Uuid::new_v4()).execute(db).await.unwrap();
    id
}
#[tokio::test]
async fn native_practice_resources_are_scoped_strict_and_attributed() {
    let (db, r, a, p, _) = setup().await;
    let loc = facility(&db, &a).await;
    let cov = coverage(&db, &a, p, "active").await;
    let ap: Uuid = sqlx::query_scalar("SELECT id FROM appointments WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .fetch_one(&db)
        .await
        .unwrap();
    for (kind, id) in [
        ("Appointment", ap),
        ("Practitioner", a.sub),
        ("Location", loc),
        ("Coverage", cov),
    ] {
        let path = format!("/fhir/{kind}/{id}");
        let (status, data) = call(&r, Some(&a), &path).await;
        assert_eq!(status, 200, "{data}");
        assert_eq!(data["resourceType"], kind);
        let mut other = a.clone();
        other.tenant_id = Uuid::new_v4();
        assert_eq!(call(&r, Some(&other), &path).await.0, 404);
        assert_eq!(call(&r, None, &path).await.0, 401);
        let mut patient = a.clone();
        patient.role = Role::Patient;
        patient.patient_id = Some(p);
        assert_eq!(call(&r, Some(&patient), &path).await.0, 403);
        for bad in [
            "_count=0",
            "_count=101",
            "_id=bad",
            "_count=1&_count=2",
            "unknown=value",
            "name=",
        ] {
            assert_eq!(
                call(&r, Some(&a), &format!("/fhir/{kind}?{bad}")).await.0,
                400,
                "{kind} {bad}"
            );
        }
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='practice.fhir_read'",
    )
    .bind(a.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(count, 4);
}
#[tokio::test]
async fn appointment_lifecycle_and_patient_search_preserve_booking_semantics() {
    let (db, r, a, p, _) = setup().await;
    let ap: Uuid = sqlx::query_scalar("SELECT id FROM appointments WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .fetch_one(&db)
        .await
        .unwrap();
    for (native, fhir) in [
        ("booked", "booked"),
        ("checked_in", "checked-in"),
        ("in_progress", "fulfilled"),
        ("completed", "fulfilled"),
        ("cancelled", "cancelled"),
        ("no_show", "noshow"),
    ] {
        sqlx::query("UPDATE appointments SET status=$3 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(ap)
            .bind(native)
            .execute(&db)
            .await
            .unwrap();
        let (status, data) = call(&r, Some(&a), &format!("/fhir/Appointment/{ap}")).await;
        assert_eq!(status, 200);
        assert_eq!(data["status"], fhir);
        assert_eq!(
            data["participant"][0]["actor"]["reference"],
            format!("Patient/{p}")
        );
        assert_eq!(
            data["participant"][1]["actor"]["reference"],
            format!("Practitioner/{}", a.sub)
        );
        assert_eq!(data["participant"][0]["status"], "needs-action");
    }
    let (status, bundle) = call(
        &r,
        Some(&a),
        &format!("/fhir/Appointment?patient=Patient/{p}"),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(bundle["entry"].as_array().unwrap().len(), 1);
    let (_, empty) = call(
        &r,
        Some(&a),
        &format!("/fhir/Appointment?patient={}", Uuid::new_v4()),
    )
    .await;
    assert!(empty.get("entry").is_none());
}
#[tokio::test]
async fn provider_location_search_and_pagination_use_real_records() {
    let (db, r, a, _, _) = setup().await;
    let loc = facility(&db, &a).await;
    sqlx::query("INSERT INTO practice_providers(tenant_id,id,display_name,npi,specialty) VALUES($1,$2,'Synthetic specialist','1234567890','Synthetic specialty')").bind(a.tenant_id).bind(a.sub).execute(&db).await.unwrap();
    let (_, provider) = call(&r, Some(&a), &format!("/fhir/Practitioner/{}", a.sub)).await;
    assert_eq!(provider["name"][0]["text"], "Synthetic specialist");
    assert_eq!(provider["identifier"][0]["value"], "1234567890");
    assert_eq!(provider["active"], true);
    sqlx::query("UPDATE browser_users SET disabled=true WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(a.sub)
        .execute(&db)
        .await
        .unwrap();
    let (_, inactive) = call(
        &r,
        Some(&a),
        "/fhir/Practitioner?active=false&name=Synthetic",
    )
    .await;
    assert_eq!(inactive["entry"][0]["resource"]["active"], false);
    let (_, location) = call(&r, Some(&a), &format!("/fhir/Location/{loc}")).await;
    assert_eq!(location["address"]["text"], "123 Example St");
    assert_eq!(location["telecom"][0]["system"], "phone");
    sqlx::query(
        "INSERT INTO practice_facilities(tenant_id,id,name) VALUES($1,$2,'Synthetic Annex')",
    )
    .bind(a.tenant_id)
    .bind(Uuid::new_v4())
    .execute(&db)
    .await
    .unwrap();
    let (_, page) = call(
        &r,
        Some(&a),
        "/fhir/Location?name=Synthetic&status=active&_count=1",
    )
    .await;
    let next = page["link"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["relation"] == "next")
        .unwrap()["url"]
        .as_str()
        .unwrap();
    assert!(next.contains("name=Synthetic"));
    assert!(next.contains("status=active"));
    let path = next.strip_prefix("http://127.0.0.1:8099").unwrap();
    let (status, page2) = call(&r, Some(&a), path).await;
    assert_eq!(status, 200);
    assert_ne!(
        page["entry"][0]["resource"]["id"],
        page2["entry"][0]["resource"]["id"]
    );
    assert_eq!(
        call(&r, Some(&a), "/fhir/Location?active=true").await.0,
        400
    );
    assert_eq!(
        call(&r, Some(&a), "/fhir/Practitioner?patient=bad").await.0,
        400
    );
}
#[tokio::test]
async fn coverage_preserves_beneficiary_payor_and_ambiguous_inactive_status() {
    let (db, r, a, p, _) = setup().await;
    for native in ["active", "inactive", "entered_in_error"] {
        let id = coverage(&db, &a, p, native).await;
        let (status, c) = call(&r, Some(&a), &format!("/fhir/Coverage/{id}")).await;
        assert_eq!(status, 200, "{c}");
        assert_eq!(c["beneficiary"]["reference"], format!("Patient/{p}"));
        assert_eq!(c["identifier"][0]["value"], "SYN-MEMBER");
        assert!(c.get("subscriberId").is_none());
        assert_eq!(c["subscriber"]["display"], "Synthetic subscriber");
        assert_eq!(c["payor"][0]["display"], "Synthetic payer");
        assert_eq!(c["order"], 2);
        assert_eq!(c["period"]["end"], "2026-12-31");
        if native == "inactive" {
            assert!(c.get("status").is_none());
            assert_eq!(c["_status"]["extension"][0]["valueCode"], "unknown");
            assert_eq!(c["extension"][0]["valueCode"], "inactive");
        } else {
            assert_eq!(c["status"], native.replace('_', "-"));
        }
    }
    let (status, all) = call(&r, Some(&a), &format!("/fhir/Coverage?patient={p}")).await;
    assert_eq!(status, 200);
    assert_eq!(all["entry"].as_array().unwrap().len(), 3);
    let (_, meta) = call(&r, None, "/fhir/metadata").await;
    let coverage = meta["rest"][0]["resource"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["type"] == "Coverage")
        .unwrap();
    assert!(coverage["documentation"]
        .as_str()
        .unwrap()
        .contains("billing.read"));
}
