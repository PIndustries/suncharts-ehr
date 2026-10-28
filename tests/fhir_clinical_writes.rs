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
    let schema = format!("fhir_clinical_write_test_{}", Uuid::new_v4().simple());
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
fn entry(kind: &str, p: Uuid) -> Value {
    let mut v = json!({"resourceType":kind,"subject":{"reference":format!("Patient/{p}")},"code":{"text":"Synthetic entry","coding":[{"system":"http://snomed.info/sct","code":"123"}]},"clinicalStatus":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/condition-clinical","code":"active"}]},"verificationStatus":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/condition-ver-status","code":"confirmed"}]},"note":[{"text":"Synthetic note"}]});
    if kind == "AllergyIntolerance" {
        let o = v.as_object_mut().unwrap();
        o.remove("subject");
        v["patient"] = json!({"reference":format!("Patient/{p}")});
        v["clinicalStatus"]["coding"][0]["system"] =
            json!("http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical");
        v["verificationStatus"]["coding"][0]["system"] =
            json!("http://terminology.hl7.org/CodeSystem/allergyintolerance-verification");
        v["reaction"] = json!([{"manifestation":[{"text":"Synthetic rash"}],"severity":"mild"}]);
    }
    if kind == "MedicationStatement" {
        let o = v.as_object_mut().unwrap();
        let code = o.remove("code").unwrap();
        o.remove("clinicalStatus");
        o.remove("verificationStatus");
        v["medicationCodeableConcept"] = code;
        v["status"] = json!("active");
        v["dosage"] = json!([{"text":"Synthetic recorded dose"}]);
    }
    v
}
#[tokio::test]
async fn clinical_writes_use_native_history_and_stale_versions_fail() {
    let (db, r, a) = setup().await;
    let p = patient_id(&db, &a).await;
    for kind in ["Condition", "AllergyIntolerance", "MedicationStatement"] {
        let input = entry(kind, p);
        let (status, h, created) = call(
            &r,
            &a,
            "POST",
            &format!("/fhir/{kind}"),
            input.clone(),
            None,
        )
        .await;
        assert_eq!(status, 201, "{created}");
        assert_eq!(h["etag"], "W/\"1\"");
        let id = created["id"].as_str().unwrap();
        let path = format!("/fhir/{kind}/{id}");
        let mut changed = input;
        changed["id"] = json!(id);
        changed["note"] = json!([{"text":"Corrected synthetic note"}]);
        let (status, h, updated) = call(&r, &a, "PUT", &path, changed.clone(), Some(1)).await;
        assert_eq!(status, 200, "{updated}");
        assert_eq!(h["etag"], "W/\"2\"");
        assert_eq!(updated["meta"]["versionId"], "2");
        let (status, _, outcome) = call(&r, &a, "PUT", &path, changed.clone(), Some(1)).await;
        assert_eq!(status, 412, "{outcome}");
        assert_eq!(outcome["resourceType"], "OperationOutcome");
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM clinical_revisions WHERE tenant_id=$1 AND entry_id=$2",
        )
        .bind(a.tenant_id)
        .bind(id.parse::<Uuid>().unwrap())
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(count, 2);
    }
    db.close().await;
}
#[tokio::test]
async fn clinical_writes_reject_unsupported_fields_scopes_and_cross_tenant_targets() {
    let (db, r, a) = setup().await;
    let p = patient_id(&db, &a).await;
    let mut input = entry("Condition", p);
    input["severity"] = json!({"text":"Must not be discarded"});
    let (status, _, v) = call(&r, &a, "POST", "/fhir/Condition", input, None).await;
    assert_eq!(status, 400, "{v}");
    let mut foreign = a.clone();
    foreign.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(
            &r,
            &foreign,
            "POST",
            "/fhir/Condition",
            entry("Condition", p),
            None
        )
        .await
        .0,
        404
    );
    for role in [Role::Patient, Role::FrontDesk, Role::ReadOnly, Role::Nurse] {
        let mut denied = a.clone();
        denied.role = role;
        denied.patient_id = Some(p);
        assert_eq!(
            call(
                &r,
                &denied,
                "POST",
                "/fhir/Condition",
                entry("Condition", p),
                None
            )
            .await
            .0,
            403
        );
    }
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &a,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let q = Request::builder()
        .method("POST")
        .uri("/fhir/Condition")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/fhir+json")
        .header("idempotency-key", "synthetic-repeat")
        .body(Body::from(entry("Condition", p).to_string()))
        .unwrap();
    let out = r.clone().oneshot(q).await.unwrap();
    assert_eq!(out.status(), 400);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM clinical_entries")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    db.close().await;
}
#[tokio::test]
async fn clinical_write_audit_failure_rolls_back_entry_revision_and_review() {
    let (db, r, a) = setup().await;
    let p = patient_id(&db, &a).await;
    sqlx::query("CREATE FUNCTION deny_fhir_clinical_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.clinical.create' THEN RAISE EXCEPTION 'synthetic audit failure';END IF;RETURN NEW;END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER deny_fhir_clinical_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_fhir_clinical_audit()").execute(&db).await.unwrap();
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            "/fhir/Condition",
            entry("Condition", p),
            None
        )
        .await
        .0,
        500
    );
    for table in [
        "clinical_entries",
        "clinical_revisions",
        "clinical_list_state",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
    db.close().await;
}
#[tokio::test]
async fn clinical_oauth_writes_require_scope_and_revocation_applies() {
    use sha2::{Digest, Sha256};
    let (db, r, a) = setup().await;
    let p = patient_id(&db, &a).await;
    let client = Uuid::new_v4();
    let grant = Uuid::new_v4();
    let token = format!("sce_at_{}", Uuid::new_v4());
    let hash = Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    sqlx::query("INSERT INTO oauth_clients(id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES($1,$2,'Synthetic','unused','https://example.test/return','clinical.read clinical.write')").bind(client).bind(a.tenant_id).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,'clinical.read')").bind(grant).bind(client).bind(a.tenant_id).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '5 minutes')").bind(hash).bind(grant).execute(&db).await.unwrap();
    assert_eq!(
        request(
            &r,
            &token,
            "POST",
            "/fhir/Condition",
            entry("Condition", p),
            None
        )
        .await
        .0,
        403
    );
    sqlx::query("UPDATE oauth_grants SET scope='clinical.write' WHERE id=$1")
        .bind(grant)
        .execute(&db)
        .await
        .unwrap();
    let (status, _, v) = request(
        &r,
        &token,
        "POST",
        "/fhir/Condition",
        entry("Condition", p),
        None,
    )
    .await;
    assert_eq!(status, 201, "{v}");
    assert_eq!(
        request(
            &r,
            &token,
            "GET",
            &format!("/fhir/Condition/{}", v["id"].as_str().unwrap()),
            Value::Null,
            None
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
    assert_eq!(
        request(
            &r,
            &token,
            "POST",
            "/fhir/Condition",
            entry("Condition", p),
            None
        )
        .await
        .0,
        401
    );
    db.close().await;
}
