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
    let schema = format!("fhir_documents_test_{}", Uuid::new_v4().simple());
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

async fn raw(
    r: &Router,
    a: Option<&Actor>,
    method: &str,
    path: &str,
    body: Value,
    accept: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(a) = a {
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            a,
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();
        req = req.header("authorization", format!("Bearer {token}"));
    }
    if let Some(accept) = accept {
        req = req.header("accept", accept);
    }
    if method == "PUT" {
        req = req.header("if-match", "\"1\"");
    }
    let response = r
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, headers, bytes)
}
async fn upload(r: &Router, a: &Actor, p: Uuid, title: &str) -> Uuid {
    let body = json!({"request_id":Uuid::new_v4(),"filename":"synthetic.pdf","content_type":"application/pdf","content_base64":"JVBERi0xLjQKU3ludGhldGljCiUlRU9GCg==","content":{"title":title,"category":"consult","document_date":null,"visit_id":null,"notes":"Synthetic note","status":"active"},"reason":"Synthetic upload"});
    let (status, _, bytes) = raw(
        r,
        Some(a),
        "POST",
        &format!("/api/v1/patients/{p}/documents"),
        body,
        None,
    )
    .await;
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, 200, "{v}");
    v["id"].as_str().unwrap().parse().unwrap()
}
#[tokio::test]
async fn documents_search_links_to_exact_immutable_binary_with_tenant_auth() {
    let (db, r, a, p, _) = setup().await;
    let id = upload(&r, &a, p, "Synthetic consult").await;
    let (status, reference) = call(&r, Some(&a), &format!("/fhir/DocumentReference/{id}")).await;
    assert_eq!(status, 200, "{reference}");
    assert_eq!(reference["subject"]["reference"], format!("Patient/{p}"));
    assert_eq!(
        reference["content"][0]["attachment"]["url"],
        format!("http://127.0.0.1:8099/fhir/Binary/{id}")
    );
    assert!(reference.get("bytes").is_none());
    let (status, h, bytes) = raw(
        &r,
        Some(&a),
        "GET",
        &format!("/fhir/Binary/{id}"),
        Value::Null,
        Some("application/pdf"),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(h["content-type"], "application/pdf");
    assert_eq!(h["cache-control"], "no-store");
    assert_eq!(bytes, b"%PDF-1.4\nSynthetic\n%%EOF\n");
    let (status, h, bytes) = raw(
        &r,
        Some(&a),
        "GET",
        &format!("/fhir/Binary/{id}"),
        Value::Null,
        Some("application/fhir+json"),
    )
    .await;
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, 200);
    assert_eq!(h["content-type"], "application/fhir+json");
    assert_eq!(
        v["securityContext"]["reference"],
        format!("DocumentReference/{id}")
    );
    assert_eq!(v["data"], "JVBERi0xLjQKU3ludGhldGljCiUlRU9GCg==");
    let metadata = json!({"content":{"title":"Corrected synthetic title","category":"consult","document_date":null,"visit_id":null,"notes":"Metadata correction","status":"archived"},"reason":"Synthetic metadata correction"});
    assert_eq!(
        raw(
            &r,
            Some(&a),
            "PUT",
            &format!("/api/v1/patients/{p}/documents/{id}"),
            metadata,
            None
        )
        .await
        .0,
        200
    );
    let (_, corrected) = call(&r, Some(&a), &format!("/fhir/DocumentReference/{id}")).await;
    assert_eq!(corrected["meta"]["versionId"], "2");
    assert_eq!(corrected["description"], "Corrected synthetic title");
    assert_eq!(
        corrected["content"][0]["attachment"]["url"],
        reference["content"][0]["attachment"]["url"]
    );
    let (status, _, original) = raw(
        &r,
        Some(&a),
        "GET",
        &format!("/fhir/Binary/{id}"),
        Value::Null,
        Some("application/fhir+json;q=0, application/pdf;q=1"),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(original, b"%PDF-1.4\nSynthetic\n%%EOF\n");
    assert_eq!(
        raw(
            &r,
            Some(&a),
            "GET",
            &format!("/fhir/Binary/{id}"),
            Value::Null,
            Some("application/fhir+json;q=0")
        )
        .await
        .0,
        406
    );
    let (status, h, _) = raw(
        &r,
        Some(&a),
        "GET",
        &format!("/fhir/Binary/{id}"),
        Value::Null,
        Some("application/fhir+json;q=0, */*;q=1"),
    )
    .await;
    assert_eq!(status, 200);
    assert_ne!(h["content-type"], "application/fhir+json");
    let (status, h, _) = raw(
        &r,
        Some(&a),
        "GET",
        &format!("/fhir/Binary/{id}"),
        Value::Null,
        Some("application/fhir+json;q=0, application/json;q=0, application/pdf;q=0, */*;q=1"),
    )
    .await;
    assert_eq!(status, 406);
    assert_eq!(h["content-type"], "application/fhir+json");
    let (status, h, original) = raw(
        &r,
        Some(&a),
        "GET",
        &format!("/fhir/Binary/{id}"),
        Value::Null,
        Some("application/fhir+json;q=0, application/json;q=0, application/*;q=1"),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(h["content-type"], "application/pdf");
    assert_eq!(original, b"%PDF-1.4\nSynthetic\n%%EOF\n");
    let mut foreign = a.clone();
    foreign.tenant_id = Uuid::new_v4();
    for path in [
        format!("/fhir/DocumentReference/{id}"),
        format!("/fhir/Binary/{id}"),
    ] {
        assert_eq!(call(&r, Some(&foreign), &path).await.0, 404);
        assert_eq!(call(&r, None, &path).await.0, 401);
        let mut patient = a.clone();
        patient.role = Role::Patient;
        patient.patient_id = Some(p);
        assert_eq!(call(&r, Some(&patient), &path).await.0, 403);
    }
    assert_eq!(
        raw(
            &r,
            Some(&a),
            "GET",
            &format!("/fhir/Binary/{id}"),
            Value::Null,
            Some("text/html")
        )
        .await
        .0,
        406
    );
    db.close().await;
}
#[tokio::test]
async fn document_pagination_filters_and_audit_fail_closed() {
    let (db, r, a, p, _) = setup().await;
    let a_id = upload(&r, &a, p, "Synthetic one").await;
    let b_id = upload(&r, &a, p, "Synthetic two").await;
    let (status, first) = call(
        &r,
        Some(&a),
        &format!("/fhir/DocumentReference?patient=Patient/{p}&_count=1"),
    )
    .await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["entry"].as_array().unwrap().len(), 1);
    let next = first["link"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["relation"] == "next")
        .unwrap()["url"]
        .as_str()
        .unwrap();
    let next = next.strip_prefix("http://127.0.0.1:8099").unwrap();
    let (status, last) = call(&r, Some(&a), next).await;
    assert_eq!(status, 200);
    assert_ne!(
        first["entry"][0]["resource"]["id"],
        last["entry"][0]["resource"]["id"]
    );
    let (_, single) = call(&r, Some(&a), &format!("/fhir/DocumentReference?_id={a_id}")).await;
    assert_eq!(single["entry"][0]["resource"]["id"], a_id.to_string());
    for query in [
        "foo=bar",
        "_count=101",
        "patient=Patient/not-a-uuid",
        "_id=x",
        "_count=1&_count=2",
    ] {
        assert_eq!(
            call(&r, Some(&a), &format!("/fhir/DocumentReference?{query}"))
                .await
                .0,
            400
        );
    }
    sqlx::query("CREATE FUNCTION deny_fhir_document_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.fhir_binary.read' THEN RAISE EXCEPTION 'synthetic audit failure';END IF;RETURN NEW;END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER deny_fhir_document_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_fhir_document_audit()").execute(&db).await.unwrap();
    let (status, _, body) = raw(
        &r,
        Some(&a),
        "GET",
        &format!("/fhir/Binary/{b_id}"),
        Value::Null,
        Some("application/pdf"),
    )
    .await;
    assert_eq!(status, 500);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["resourceType"],
        "OperationOutcome"
    );
    db.close().await;
}
#[tokio::test]
async fn medication_requests_only_project_native_prescriptions() {
    let (db, r, a, p, _) = setup().await;
    let (_, empty) = call(
        &r,
        Some(&a),
        &format!("/fhir/MedicationRequest?patient={p}"),
    )
    .await;
    assert!(empty.get("entry").is_none(), "{empty}");
    let id = Uuid::new_v4();
    let content = json!({"medication_name":"Synthetic drug","rxnorm_code":"12345","dose":"1 tablet","route":"oral","frequency":"daily","instructions":"Synthetic directions","indication":"Synthetic indication","substitution_allowed":true,"quantity":"0030.500","quantity_unit":"tablets","refills":0,"days_supply":30});
    sqlx::query("INSERT INTO native_prescriptions(tenant_id,id,patient_id,content,authored_by,updated_by) VALUES($1,$2,$3,$4,$5,$5)").bind(a.tenant_id).bind(id).bind(p).bind(content).bind(a.sub).execute(&db).await.unwrap();
    let (status, v) = call(&r, Some(&a), &format!("/fhir/MedicationRequest/{id}")).await;
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["status"], "draft");
    assert_eq!(v["dispenseRequest"]["quantity"]["value"], json!(30.5));
    assert_eq!(v["intent"], "order");
    assert_eq!(v["medicationCodeableConcept"]["coding"][0]["code"], "12345");
    assert_eq!(
        v["requester"]["reference"],
        format!("Practitioner/{}", a.sub)
    );
    assert!(v.get("signed_snapshot").is_none());
    let mut foreign = a.clone();
    foreign.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(&r, Some(&foreign), &format!("/fhir/MedicationRequest/{id}"))
            .await
            .0,
        404
    );
    let (_, list) = call(
        &r,
        Some(&a),
        &format!("/fhir/MedicationRequest?_id={id}&patient=Patient/{p}"),
    )
    .await;
    assert_eq!(list["entry"].as_array().unwrap().len(), 1);
    db.close().await;
}
