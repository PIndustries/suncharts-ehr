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
    let schema = format!("fhir_orders_test_{}", Uuid::new_v4().simple());
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

fn observation(kind: &str) -> Value {
    let mut o = json!({"label":format!("Synthetic {kind}"),"code":{"system":"http://loinc.org","code":"2345-7","display":""},"value_type":kind,"number":null,"comparator":"","text":"","coded":null,"units":"","reference_range":"","flag":"unknown","absent_reason":"","notes":""});
    match kind {
        "numeric" => {
            o["number"] = json!(6.2);
            o["units"] = json!("mmol/L");
            o["comparator"] = json!(">");
            o["reference_range"] = json!("Recorded source range");
            o["flag"] = json!("high");
        }
        "text" => o["text"] = json!("Synthetic narrative result"),
        "coded" => {
            o["coded"] =
                json!({"system":"http://snomed.info/sct","code":"260385009","display":"Negative"})
        }
        "absent" => o["absent_reason"] = json!("Not performed: synthetic example"),
        _ => {}
    }
    o
}
async fn seed(db: &PgPool, a: &Actor, p: Uuid, v: Uuid) -> (Uuid, Uuid, Uuid) {
    let order = Uuid::new_v4();
    let specimen = Uuid::new_v4();
    let report = Uuid::new_v4();
    let c = json!({"title":"Synthetic lab panel","category":"laboratory","priority":"routine","clinical_reason":"Synthetic diagnostic workup","destination":"Synthetic local lab","instructions":"No actual testing","tests":[{"key":"panel","label":"Synthetic panel","code":{"system":"http://loinc.org","code":"24323-8","display":"Synthetic panel"}}]});
    sqlx::query("INSERT INTO lab_orders(tenant_id,id,patient_id,visit_id,request_id,creation_hash,content,status,created_by) VALUES($1,$2,$3,$4,$5,'synthetic',$6,'ordered',$7)").bind(a.tenant_id).bind(order).bind(p).bind(v).bind(Uuid::new_v4()).bind(c).bind(a.sub).execute(db).await.unwrap();
    let c = json!({"accession":"SYN-SPEC","specimen_type":"Synthetic plasma","body_site":"Synthetic arm","collected_at":"2026-10-25T14:00:00Z","received_at":"2026-10-25T14:20:00Z","status":"received","notes":"Synthetic sample only"});
    sqlx::query("INSERT INTO lab_specimens(tenant_id,id,order_id,request_id,creation_hash,content,author_id) VALUES($1,$2,$3,$4,'synthetic',$5,$6)").bind(a.tenant_id).bind(specimen).bind(order).bind(Uuid::new_v4()).bind(c).bind(a.sub).execute(db).await.unwrap();
    let c = json!({"test_keys":["panel"],"specimen_id":specimen,"specimen_not_recorded":false,"accession":"SYN-REPORT","performing_lab":"Synthetic lab","reported_at":"2026-10-25T15:00:00Z","observations":[observation("numeric"),observation("text"),observation("coded"),observation("absent")],"notes":"Synthetic report notes"});
    sqlx::query("INSERT INTO lab_reports(tenant_id,id,order_id,request_id,creation_hash,content,status,author_id) VALUES($1,$2,$3,$4,'synthetic',$5,'final',$6)").bind(a.tenant_id).bind(report).bind(order).bind(Uuid::new_v4()).bind(c).bind(a.sub).execute(db).await.unwrap();
    revision(db, a, report).await;
    (order, specimen, report)
}
async fn revision(db: &PgPool, a: &Actor, report: Uuid) {
    sqlx::query("INSERT INTO lab_report_revisions(tenant_id,report_id,version,snapshot,author_id,reason) SELECT tenant_id,id,version,to_jsonb(r)-'tenant_id',$3,'Synthetic revision' FROM lab_reports r WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(report).bind(a.sub).execute(db).await.unwrap();
}
#[tokio::test]
async fn orders_specimens_reports_and_typed_results_have_linked_native_meaning() {
    let (db, r, a, p, v) = setup().await;
    let (o, sp, rp) = seed(&db, &a, p, v).await;
    let (status, sr) = call(&r, Some(&a), &format!("/fhir/ServiceRequest/{o}")).await;
    assert_eq!(status, 200, "{sr}");
    assert_eq!(sr["status"], "active");
    assert_eq!(sr["intent"], "order");
    assert_eq!(sr["code"]["coding"][0]["code"], "24323-8");
    assert_eq!(sr["subject"]["reference"], format!("Patient/{p}"));
    assert_eq!(sr["encounter"]["reference"], format!("Encounter/{v}"));
    let (status, spec) = call(&r, Some(&a), &format!("/fhir/Specimen/{sp}")).await;
    assert_eq!(status, 200, "{spec}");
    assert_eq!(spec["status"], "available");
    assert_eq!(
        spec["request"][0]["reference"],
        format!("ServiceRequest/{o}")
    );
    assert_eq!(
        spec["collection"]["collectedDateTime"],
        "2026-10-25T14:00:00Z"
    );
    let (status, report) = call(&r, Some(&a), &format!("/fhir/DiagnosticReport/{rp}")).await;
    assert_eq!(status, 200, "{report}");
    assert_eq!(report["status"], "final");
    assert_eq!(report["code"]["coding"][0]["code"], "24323-8");
    assert_eq!(
        report["basedOn"][0]["reference"],
        format!("ServiceRequest/{o}")
    );
    assert_eq!(report["specimen"][0]["reference"], format!("Specimen/{sp}"));
    assert_eq!(report["result"].as_array().unwrap().len(), 4);
    assert!(report.get("effectiveDateTime").is_none());
    let mut results = vec![];
    for item in report["result"].as_array().unwrap() {
        let path = format!("/fhir/{}", item["reference"].as_str().unwrap());
        let (status, obs) = call(&r, Some(&a), &path).await;
        assert_eq!(status, 200, "{obs}");
        assert_eq!(obs["status"], "final");
        assert_eq!(obs["specimen"]["reference"], format!("Specimen/{sp}"));
        assert_eq!(obs["meta"]["versionId"], "1");
        assert!(obs.get("effectiveDateTime").is_none());
        results.push(obs);
    }
    assert_eq!(results[0]["valueQuantity"]["value"], 6.2);
    assert_eq!(results[0]["valueQuantity"]["comparator"], ">");
    assert!(
        results[0]["valueQuantity"].get("system").is_none(),
        "source units are not UCUM-validated"
    );
    assert_eq!(results[0]["interpretation"][0]["coding"][0]["code"], "H");
    assert_eq!(results[1]["valueString"], "Synthetic narrative result");
    assert_eq!(
        results[2]["valueCodeableConcept"]["coding"][0]["code"],
        "260385009"
    );
    assert_eq!(
        results[3]["dataAbsentReason"]["text"],
        "Not performed: synthetic example"
    );
}
#[tokio::test]
async fn corrected_report_reordering_never_retargets_published_observation_ids() {
    let (db, r, a, p, v) = setup().await;
    let (_, _, rp) = seed(&db, &a, p, v).await;
    let old_id = format!("lab-{rp}-1-0");
    let (_, old) = call(&r, Some(&a), &format!("/fhir/Observation/{old_id}")).await;
    sqlx::query("UPDATE lab_reports SET content=jsonb_set(content,'{observations}',$3),version=2,status='corrected',updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(rp).bind(json!([observation("text"),observation("numeric")])).execute(&db).await.unwrap();
    revision(&db, &a, rp).await;
    let (status, unchanged) = call(&r, Some(&a), &format!("/fhir/Observation/{old_id}")).await;
    assert_eq!(status, 200);
    assert_eq!(unchanged, old);
    let (_, report) = call(&r, Some(&a), &format!("/fhir/DiagnosticReport/{rp}")).await;
    assert_eq!(report["status"], "corrected");
    assert_eq!(
        report["result"][0]["reference"],
        format!("Observation/lab-{rp}-2-0")
    );
    let (_, current) = call(&r, Some(&a), &format!("/fhir/Observation?patient={p}")).await;
    let entries = current["entry"].as_array().unwrap();
    assert_eq!(entries.len(), 3);
    assert!(entries.iter().all(|e| e["resource"]["id"] != old_id));
    let (status, historical) = call(&r, Some(&a), &format!("/fhir/Observation?_id={old_id}")).await;
    assert_eq!(status, 200);
    assert_eq!(historical["entry"][0]["resource"], old);
}
#[tokio::test]
async fn mixed_vitals_and_laboratory_pages_are_scoped_strict_and_complete() {
    let (db, r, a, p, v) = setup().await;
    let (o, sp, rp) = seed(&db, &a, p, v).await;
    for invalid in [
        format!("lab-{rp}-0-0"),
        format!("lab-{rp}-1-100"),
        format!("lab-{rp}-9223372036854775808-0"),
    ] {
        assert_eq!(
            call(&r, Some(&a), &format!("/fhir/Observation?_id={invalid}"))
                .await
                .0,
            400
        );
        assert_eq!(
            call(&r, Some(&a), &format!("/fhir/Observation/{invalid}"))
                .await
                .0,
            404
        );
    }
    let hostile = format!("lab-{}é-1-0", "a".repeat(35));
    let hostile: String = url::form_urlencoded::byte_serialize(hostile.as_bytes()).collect();
    assert_eq!(
        call(&r, Some(&a), &format!("/fhir/Observation/{hostile}"))
            .await
            .0,
        404
    );
    for filter in ["_id", "_after"] {
        assert_eq!(
            call(
                &r,
                Some(&a),
                &format!("/fhir/Observation?{filter}={hostile}")
            )
            .await
            .0,
            400
        );
    }
    let mut path = format!("/fhir/Observation?patient=Patient/{p}&_count=1");
    let mut ids = vec![];
    loop {
        let (status, page) = call(&r, Some(&a), &path).await;
        assert_eq!(status, 200, "{page}");
        ids.push(
            page["entry"][0]["resource"]["id"]
                .as_str()
                .unwrap()
                .to_string(),
        );
        let next = page["link"]
            .as_array()
            .unwrap()
            .iter()
            .find(|link| link["relation"] == "next");
        if let Some(next) = next {
            let url = url::Url::parse(next["url"].as_str().unwrap()).unwrap();
            path = format!("{}?{}", url.path(), url.query().unwrap());
        } else {
            break;
        }
    }
    assert_eq!(ids.len(), 5);
    let unique: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(unique.len(), 5);
    assert!(ids.contains(&v.to_string()));
    for kind in [
        "ServiceRequest",
        "Specimen",
        "DiagnosticReport",
        "Observation",
    ] {
        for suffix in [
            "?bogus=x",
            "?_count=101",
            "?patient=not-uuid",
            "?_count=1&_count=2",
            "?_after=bad",
            "?_id=lab-bad",
        ] {
            let (status, body) = call(&r, Some(&a), &format!("/fhir/{kind}{suffix}")).await;
            assert_eq!(status, 400, "{kind}{suffix}: {body}");
            assert_eq!(body["resourceType"], "OperationOutcome");
        }
        assert_eq!(
            call(&r, Some(&a), &format!("/fhir/{kind}/invalid")).await.0,
            404
        );
        let mut foreign = a.clone();
        foreign.tenant_id = Uuid::new_v4();
        assert!(call(&r, Some(&foreign), &format!("/fhir/{kind}"))
            .await
            .1
            .get("entry")
            .is_none());
        let mut patient = a.clone();
        patient.role = Role::Patient;
        patient.patient_id = Some(p);
        assert_eq!(
            call(&r, Some(&patient), &format!("/fhir/{kind}")).await.0,
            403
        );
        assert_eq!(call(&r, None, &format!("/fhir/{kind}")).await.0, 401);
    }
    let mut foreign = a.clone();
    foreign.tenant_id = Uuid::new_v4();
    for (kind, id) in [
        ("ServiceRequest", o.to_string()),
        ("Specimen", sp.to_string()),
        ("DiagnosticReport", rp.to_string()),
        ("Observation", format!("lab-{rp}-1-0")),
    ] {
        assert_eq!(
            call(&r, Some(&foreign), &format!("/fhir/{kind}/{id}"))
                .await
                .0,
            404
        );
    }
}
#[tokio::test]
async fn orders_results_are_read_only_and_fail_closed_if_audit_fails() {
    let (db, r, a, p, v) = setup().await;
    let (o, sp, rp) = seed(&db, &a, p, v).await;
    for (kind, id) in [
        ("ServiceRequest", o),
        ("Specimen", sp),
        ("DiagnosticReport", rp),
    ] {
        assert_eq!(
            request(&r, None, &format!("/fhir/{kind}/{id}"), "PUT")
                .await
                .0,
            if kind == "ServiceRequest" { 403 } else { 405 }
        );
    }
    sqlx::query("CREATE FUNCTION reject_fhir_order_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'patient.fhir_orders.%' THEN RAISE EXCEPTION 'synthetic audit rejection'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_fhir_order_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_fhir_order_audit()").execute(&db).await.unwrap();
    for path in [
        format!("/fhir/ServiceRequest/{o}"),
        format!("/fhir/Specimen/{sp}"),
        format!("/fhir/DiagnosticReport/{rp}"),
        format!("/fhir/Observation/lab-{rp}-1-0"),
    ] {
        let (status, body) = call(&r, Some(&a), &path).await;
        assert_eq!(status, 500);
        assert_eq!(body["resourceType"], "OperationOutcome");
        assert!(!body.to_string().contains("Synthetic lab panel"));
    }
}
