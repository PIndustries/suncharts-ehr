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
    let schema = format!("fhir_test_{}", Uuid::new_v4().simple());
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
async fn entry(db: &PgPool, a: &Actor, p: Uuid, kind: &str, status: &str) -> Uuid {
    let detail = match kind {
        "problem" => json!({"kind":"problem","problem_type":"problem"}),
        "allergy" => {
            json!({"kind":"allergy","category":"other","reaction":"Rash","severity":"unknown","criticality":"unknown"})
        }
        _ => {
            json!({"kind":"medication","dose":"10 mg","route":"oral","frequency":"daily","indication":"Synthetic indication"})
        }
    };
    let id = Uuid::new_v4();
    let c = json!({"title":"Synthetic clinical entry","status":status,"verification":if status=="entered_in_error" {"entered_in_error"}else{"unconfirmed"},"onset_date":"2020-01-01","end_date":null,"codes":[],"notes":"Synthetic note","detail":detail});
    sqlx::query("INSERT INTO clinical_entries(tenant_id,id,patient_id,kind,content,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)").bind(a.tenant_id).bind(id).bind(p).bind(kind).bind(c).bind(a.sub).execute(db).await.unwrap();
    id
}
#[tokio::test]
async fn native_clinical_fhir_is_scoped_paged_read_only_and_semantically_honest() {
    let (db, r, a, p, v) = setup().await;
    let condition = entry(&db, &a, p, "problem", "entered_in_error").await;
    entry(&db, &a, p, "problem", "active").await;
    let allergy = entry(&db, &a, p, "allergy", "active").await;
    let med = entry(&db, &a, p, "medication", "on_hold").await;
    for (kind, id) in [
        ("Encounter", v),
        ("Observation", v),
        ("Condition", condition),
        ("AllergyIntolerance", allergy),
        ("MedicationStatement", med),
    ] {
        let path = format!("/fhir/{kind}/{id}");
        let (status, resource) = call(&r, Some(&a), &path).await;
        assert_eq!(status, 200, "{resource}");
        assert_eq!(resource["resourceType"], kind);
        let (s, unauth) = call(&r, None, &path).await;
        assert_eq!(s, 401);
        assert_eq!(unauth["resourceType"], "OperationOutcome");
        let mut other = a.clone();
        other.tenant_id = Uuid::new_v4();
        assert_eq!(call(&r, Some(&other), &path).await.0, 404);
        assert!(call(&r, Some(&other), &format!("/fhir/{kind}?patient={p}"))
            .await
            .1
            .get("entry")
            .is_none());
        let mut reader = a.clone();
        reader.role = Role::ReadOnly;
        assert_eq!(call(&r, Some(&reader), &path).await.0, 200);
        reader.role = Role::Patient;
        reader.patient_id = Some(p);
        assert_eq!(call(&r, Some(&reader), &path).await.0, 403);
        assert_eq!(
            request(&r, None, &path, "PUT").await.0,
            if matches!(
                kind,
                "Condition" | "AllergyIntolerance" | "MedicationStatement"
            ) {
                403
            } else {
                405
            }
        );
        assert_eq!(
            call(&r, Some(&a), &format!("/fhir/{kind}/not-uuid"))
                .await
                .0,
            404
        );
    }
    let c = call(&r, Some(&a), &format!("/fhir/Condition/{condition}"))
        .await
        .1;
    assert!(c.get("clinicalStatus").is_none());
    assert_eq!(
        c["verificationStatus"]["coding"][0]["code"],
        "entered-in-error"
    );
    let allergy = call(&r, Some(&a), &format!("/fhir/AllergyIntolerance/{allergy}"))
        .await
        .1;
    assert!(allergy.get("subject").is_none());
    assert!(allergy.get("category").is_none());
    assert!(allergy["reaction"][0].get("severity").is_none());
    assert_eq!(allergy["criticality"], "unable-to-assess");
    let med = call(&r, Some(&a), &format!("/fhir/MedicationStatement/{med}"))
        .await
        .1;
    assert_eq!(med["status"], "on-hold");
    assert_eq!(med["dosage"][0]["text"], "10 mg; oral; daily");
    assert!(med.get("intent").is_none());
    let obs = call(&r, Some(&a), &format!("/fhir/Observation/{v}"))
        .await
        .1;
    assert_eq!(obs["component"].as_array().unwrap().len(), 7);
    assert_eq!(obs["component"][0]["valueQuantity"]["code"], "mm[Hg]");
    assert_eq!(obs["status"], "preliminary");
    assert!(obs.get("effectiveDateTime").is_none());
    let first = call(
        &r,
        Some(&a),
        &format!("/fhir/Condition?patient=Patient/{p}&_count=1"),
    )
    .await
    .1;
    assert_eq!(first["entry"].as_array().unwrap().len(), 1);
    let next = first["link"][1]["url"].as_str().unwrap();
    let parsed = url::Url::parse(next).unwrap();
    let second = call(
        &r,
        Some(&a),
        &format!("{}?{}", parsed.path(), parsed.query().unwrap()),
    )
    .await
    .1;
    assert_ne!(
        first["entry"][0]["resource"]["id"],
        second["entry"][0]["resource"]["id"]
    );
    assert_eq!(second["link"].as_array().unwrap().len(), 1);
    for query in [
        "_count=0",
        "_count=101",
        "_count=-1",
        "patient=garbage",
        "patient=https://example.test/Patient/123",
        "_after=bad",
        "_id=bad",
        "status=active",
        "patient=one&patient=two",
        "date=2020-01-01",
    ] {
        let (s, b) = call(&r, Some(&a), &format!("/fhir/Condition?{query}")).await;
        assert_eq!(s, 400, "{query}: {b}");
        assert_eq!(b["resourceType"], "OperationOutcome");
    }
    let metadata = call(&r, None, "/fhir/metadata").await.1;
    assert_eq!(
        metadata["rest"][0]["resource"].as_array().unwrap().len(),
        17
    );
    let audits:i64=sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action LIKE 'patient.fhir_clinical%'").bind(a.tenant_id).fetch_one(&db).await.unwrap();
    assert!(audits > 10);
}
#[tokio::test]
async fn fhir_oauth_requires_clinical_read_and_revocation_is_enforced() {
    use sha2::{Digest, Sha256};
    let (db, r, a, _, v) = setup().await;
    let client = Uuid::new_v4();
    let grant = Uuid::new_v4();
    let token = format!("sce_at_{}", Uuid::new_v4());
    let hash = Sha256::digest(token.as_bytes())
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect::<String>();
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,'unused','read_only')").bind(a.sub).bind(a.tenant_id).bind(format!("{}@example.test",a.sub)).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO oauth_clients(id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES($1,$2,'Synthetic','unused','https://example.test/return','clinical.read billing.read')").bind(client).bind(a.tenant_id).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,'billing.read')").bind(grant).bind(client).bind(a.tenant_id).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '5 minutes')").bind(hash).bind(grant).execute(&db).await.unwrap();
    let path = format!("/fhir/Encounter/{v}");
    assert_eq!(request(&r, Some(&token), &path, "GET").await.0, 403);
    assert_eq!(
        request(&r, Some(&token), "/fhir/Coverage", "GET").await.0,
        200
    );
    assert_eq!(
        request(
            &r,
            Some(&token),
            &format!("/fhir/Coverage/{}", Uuid::new_v4()),
            "GET"
        )
        .await
        .0,
        404
    );
    sqlx::query("UPDATE oauth_grants SET scope='clinical.read' WHERE id=$1")
        .bind(grant)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(request(&r, Some(&token), &path, "GET").await.0, 200);
    assert_eq!(
        request(&r, Some(&token), "/fhir/Coverage", "GET").await.0,
        403
    );
    assert_eq!(
        request(
            &r,
            Some(&token),
            &format!("/fhir/Coverage/{}", Uuid::new_v4()),
            "GET"
        )
        .await
        .0,
        403
    );
    sqlx::query("UPDATE oauth_grants SET revoked_at=now() WHERE id=$1")
        .bind(grant)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(request(&r, Some(&token), &path, "GET").await.0, 401);
}

#[tokio::test]
async fn refuted_medication_and_error_condition_do_not_assert_active_use_or_abatement() {
    let (db, r, a, p, _) = setup().await;
    let med = entry(&db, &a, p, "medication", "active").await;
    let condition = entry(&db, &a, p, "problem", "entered_in_error").await;
    for (id, verification, end_date) in [
        (med, "refuted", Value::Null),
        (condition, "entered_in_error", json!("2021-01-01")),
    ] {
        let mut content: Value =
            sqlx::query_scalar("SELECT content FROM clinical_entries WHERE tenant_id=$1 AND id=$2")
                .bind(a.tenant_id)
                .bind(id)
                .fetch_one(&db)
                .await
                .unwrap();
        content["verification"] = json!(verification);
        content["end_date"] = end_date;
        // These combinations are accepted by the native API's actual validator;
        // the projection must not assume verification is always confirmed.
        serde_json::from_value::<suncharts_engine::clinical::Content>(content.clone())
            .unwrap()
            .validate()
            .unwrap();
        sqlx::query("UPDATE clinical_entries SET content=$3 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .bind(content)
            .execute(&db)
            .await
            .unwrap();
    }
    for path in [
        format!("/fhir/MedicationStatement/{med}"),
        format!("/fhir/MedicationStatement?_id={med}&patient={p}"),
    ] {
        let (status, response) = call(&r, Some(&a), &path).await;
        assert_eq!(status, StatusCode::OK);
        let medication = if response["resourceType"] == "Bundle" {
            &response["entry"][0]["resource"]
        } else {
            &response
        };
        assert_eq!(medication["status"], "unknown");
        let reason = medication["statusReason"][0]["text"].as_str().unwrap();
        assert!(reason.contains("refuted"));
        assert!(reason.contains("native use status: active"));
        assert!(reason.contains("Current medication use is not asserted"));
        assert_eq!(medication["note"][0]["text"], "Synthetic note");
        assert!(medication["note"][1]["text"]
            .as_str()
            .unwrap()
            .contains("verification: refuted"));
    }
    for path in [
        format!("/fhir/Condition/{condition}"),
        format!("/fhir/Condition?_id={condition}&patient={p}"),
    ] {
        let (status, response) = call(&r, Some(&a), &path).await;
        assert_eq!(status, StatusCode::OK);
        let condition = if response["resourceType"] == "Bundle" {
            &response["entry"][0]["resource"]
        } else {
            &response
        };
        assert_eq!(
            condition["verificationStatus"]["coding"][0]["code"],
            "entered-in-error"
        );
        assert!(condition.get("clinicalStatus").is_none());
        assert!(condition.get("abatementDateTime").is_none());
    }
    let unconfirmed = entry(&db, &a, p, "medication", "active").await;
    let response = call(
        &r,
        Some(&a),
        &format!("/fhir/MedicationStatement/{unconfirmed}"),
    )
    .await
    .1;
    assert_eq!(response["status"], "active");
    assert_eq!(response["note"][0]["text"], "Synthetic note");
    assert!(response["note"][1]["text"]
        .as_str()
        .unwrap()
        .contains("verification: unconfirmed"));
}

fn assert_fhir_json_has_no_empty_properties(value: &Value) {
    match value {
        Value::Object(properties) => {
            assert!(!properties.is_empty(), "empty FHIR object");
            for child in properties.values() {
                assert_fhir_json_has_no_empty_properties(child);
            }
        }
        Value::Array(items) => {
            assert!(!items.is_empty(), "empty FHIR array");
            for child in items {
                assert_fhir_json_has_no_empty_properties(child);
            }
        }
        Value::String(text) => assert!(!text.is_empty(), "empty FHIR string"),
        Value::Null => panic!("unexpected null FHIR property"),
        _ => {}
    }
}
#[tokio::test]
async fn fhir_omits_default_empty_coding_displays_and_empty_search_entries() {
    let (db, r, a, p, _) = setup().await;
    let absent = Uuid::new_v4();
    for kind in [
        "Patient",
        "Encounter",
        "Condition",
        "AllergyIntolerance",
        "MedicationStatement",
        "Observation",
    ] {
        let (status, bundle) = call(&r, Some(&a), &format!("/fhir/{kind}?_id={absent}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bundle["resourceType"], "Bundle");
        assert!(bundle.get("entry").is_none());
        assert_fhir_json_has_no_empty_properties(&bundle);
    }
    for (native, fhir) in [
        ("problem", "Condition"),
        ("allergy", "AllergyIntolerance"),
        ("medication", "MedicationStatement"),
    ] {
        let id = entry(&db, &a, p, native, "active").await;
        let mut content: Value =
            sqlx::query_scalar("SELECT content FROM clinical_entries WHERE tenant_id=$1 AND id=$2")
                .bind(a.tenant_id)
                .bind(id)
                .fetch_one(&db)
                .await
                .unwrap();
        content["codes"] = json!([{"system":"urn:synthetic:terminology","code":"ONE"},{"system":"urn:synthetic:terminology","code":"TWO","display":"Recorded display"}]);
        let native_content: suncharts_engine::clinical::Content =
            serde_json::from_value(content).unwrap();
        native_content.validate().unwrap();
        assert_eq!(native_content.codes[0].display, "");
        sqlx::query("UPDATE clinical_entries SET content=$3 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .bind(serde_json::to_value(native_content).unwrap())
            .execute(&db)
            .await
            .unwrap();
        for path in [
            format!("/fhir/{fhir}/{id}"),
            format!("/fhir/{fhir}?_id={id}"),
        ] {
            let (status, response) = call(&r, Some(&a), &path).await;
            assert_eq!(status, StatusCode::OK);
            let resource = if response["resourceType"] == "Bundle" {
                &response["entry"][0]["resource"]
            } else {
                &response
            };
            let code = if fhir == "MedicationStatement" {
                &resource["medicationCodeableConcept"]
            } else {
                &resource["code"]
            };
            assert_eq!(code["coding"][0]["code"], "ONE");
            assert!(code["coding"][0].get("display").is_none());
            assert_eq!(code["coding"][1]["display"], "Recorded display");
            assert_fhir_json_has_no_empty_properties(&response);
        }
    }
}
