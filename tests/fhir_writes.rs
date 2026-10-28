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
    let schema = format!("fhir_write_test_{}", Uuid::new_v4().simple());
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
fn patient(mrn: &str) -> Value {
    json!({"resourceType":"Patient","identifier":[{"system":"http://127.0.0.1:8099/identifier/mrn","value":mrn}],"name":[{"use":"official","family":"Synthetic","given":["Avery"]}],"birthDate":"1990-01-02"})
}
#[tokio::test]
async fn creates_and_corrects_patient_identity_with_fhir_headers_and_native_history() {
    let (db, r, a) = setup().await;
    let (status, h, created) =
        call(&r, &a, "POST", "/fhir/Patient", patient("SYN-001"), None).await;
    assert_eq!(status, 201, "{created}");
    assert_eq!(h["etag"], "W/\"1\"");
    assert!(h["location"].to_str().unwrap().contains("/fhir/Patient/"));
    let id = created["id"].as_str().unwrap();
    let path = format!("/fhir/Patient/{id}");
    let mut corrected = created.clone();
    corrected["name"][0]["family"] = json!("Corrected");
    let (status, h, updated) = call(&r, &a, "PUT", &path, corrected.clone(), Some(1)).await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(h["etag"], "W/\"2\"");
    assert_eq!(updated["name"][0]["family"], "Corrected");
    assert_eq!(updated["meta"]["versionId"], "2");
    let (status, h, read) = call(&r, &a, "GET", &path, Value::Null, None).await;
    assert_eq!(status, 200);
    assert_eq!(h["etag"], "W/\"2\"");
    assert_eq!(read, updated);
    assert_eq!(call(&r, &a, "PUT", &path, corrected, Some(1)).await.0, 412);
    let native = format!("/api/v1/patients/{id}/identity");
    let (_, _, data) = call(&r, &a, "GET", &native, Value::Null, None).await;
    assert_eq!(data["version"], 2);
    assert_eq!(data["history"].as_array().unwrap().len(), 2);
    assert_eq!(data["history"][0]["actor_id"], a.sub.to_string());
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='patient.identity_save'",
    )
    .bind(a.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(count, 1);
    assert!(sqlx::query("DELETE FROM patient_identity_revisions")
        .execute(&db)
        .await
        .is_err());
}
#[tokio::test]
async fn rejects_unsupported_payloads_missing_versions_and_identity_collisions() {
    let (_db, r, a) = setup().await;
    let mut bad = patient("SYN-001");
    bad["telecom"] = json!([{"system":"phone","value":"5550100"}]);
    let (status, _, out) = call(&r, &a, "POST", "/fhir/Patient", bad, None).await;
    assert_eq!(status, 400);
    assert_eq!(out["resourceType"], "OperationOutcome");
    let (_, _, created) = call(&r, &a, "POST", "/fhir/Patient", patient("SYN-001"), None).await;
    let path = format!("/fhir/Patient/{}", created["id"].as_str().unwrap());
    assert_eq!(
        call(&r, &a, "PUT", &path, created.clone(), None).await.0,
        428
    );
    assert_eq!(
        call(&r, &a, "POST", "/fhir/Patient", patient("SYN-001"), None)
            .await
            .0,
        409
    );
    let (_, _, other) = call(&r, &a, "POST", "/fhir/Patient", patient("SYN-002"), None).await;
    let mut collision = created.clone();
    collision["identifier"][0]["value"] = json!("SYN-002");
    let (status, _, error) = call(&r, &a, "PUT", &path, collision, Some(1)).await;
    assert_eq!(status, 409);
    assert_eq!(error["resourceType"], "OperationOutcome");
    let mut wrong = created.clone();
    wrong["id"] = other["id"].clone();
    assert_eq!(call(&r, &a, "PUT", &path, wrong, Some(1)).await.0, 400);
    let mut invalid = created.clone();
    invalid["name"][0]["given"] = json!(["Avery", "Middle"]);
    assert_eq!(call(&r, &a, "PUT", &path, invalid, Some(1)).await.0, 400);
    let mut patient_role = a.clone();
    patient_role.role = Role::Patient;
    patient_role.patient_id = Some(Uuid::parse_str(created["id"].as_str().unwrap()).unwrap());
    assert_eq!(
        call(
            &r,
            &patient_role,
            "POST",
            "/fhir/Patient",
            patient("SYN-PATIENT"),
            None
        )
        .await
        .0,
        403
    );
    let mut nurse = a.clone();
    nurse.role = Role::Nurse;
    assert_eq!(
        call(&r, &nurse, "PUT", &path, created.clone(), Some(1))
            .await
            .0,
        403
    );
    let mut foreign = a.clone();
    foreign.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(&r, &foreign, "PUT", &path, created, Some(1)).await.0,
        404
    );
}
#[tokio::test]
async fn correction_is_serialized_and_audit_failure_rolls_back_identity_and_history() {
    let (db, r, a) = setup().await;
    let (_, _, created) = call(&r, &a, "POST", "/fhir/Patient", patient("SYN-RACE"), None).await;
    let path = format!("/fhir/Patient/{}", created["id"].as_str().unwrap());
    let mut c1 = created.clone();
    c1["name"][0]["given"] = json!(["First"]);
    let mut c2 = created.clone();
    c2["name"][0]["given"] = json!(["Second"]);
    let (x, y) = tokio::join!(
        call(&r, &a, "PUT", &path, c1, Some(1)),
        call(&r, &a, "PUT", &path, c2, Some(1))
    );
    let mut statuses = [x.0.as_u16(), y.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 412]);
    let (_, _, current) = call(&r, &a, "GET", &path, Value::Null, None).await;
    sqlx::query("CREATE FUNCTION fail_identity_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('patient.identity_save','patient.create') THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_identity_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_identity_audit()").execute(&db).await.unwrap();
    let mut change = current.clone();
    change["name"][0]["given"] = json!(["Must roll back"]);
    assert_eq!(call(&r, &a, "PUT", &path, change, Some(2)).await.0, 500);
    assert_eq!(
        call(&r, &a, "GET", &path, Value::Null, None).await.2,
        current
    );
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            "/fhir/Patient",
            patient("SYN-ROLLBACK"),
            None
        )
        .await
        .0,
        500
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM patients WHERE mrn='SYN-ROLLBACK'")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(n, 0);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM patient_identity_revisions")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(n, 2);
}
#[tokio::test]
async fn oauth_patient_writes_require_clinical_write_scope() {
    use sha2::{Digest, Sha256};
    let (db, r, a) = setup().await;
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
            "/fhir/Patient",
            patient("SYN-OAUTH"),
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
    assert_eq!(
        request(
            &r,
            &token,
            "POST",
            "/fhir/Patient",
            patient("SYN-OAUTH"),
            None
        )
        .await
        .0,
        201
    );
}

#[tokio::test]
async fn conditional_headers_are_rejected_and_signed_visit_content_is_not_rewritten() {
    let (db, r, a) = setup().await;
    let (_, _, created) = call(&r, &a, "POST", "/fhir/Patient", patient("SYN-SIGNED"), None).await;
    let id = Uuid::parse_str(created["id"].as_str().unwrap()).unwrap();
    let ap = Uuid::new_v4();
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,now(),now()+interval '30 minutes','completed')").bind(a.tenant_id).bind(ap).bind(id).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,signed_by,signed_at,note) VALUES($1,$2,$3,$4,$5,'signed',$5,now(),$6)").bind(a.tenant_id).bind(visit).bind(id).bind(ap).bind(a.sub).bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"})).execute(&db).await.unwrap();
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(v) FROM visits v WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(visit)
            .fetch_one(&db)
            .await
            .unwrap();
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &a,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let path = format!("/fhir/Patient/{id}");
    for (method, path, extra, body) in [
        (
            "POST",
            "/fhir/Patient",
            "If-None-Exist",
            patient("SYN-REJECTED"),
        ),
        ("PUT", path.as_str(), "If-None-Match", created.clone()),
    ] {
        let req = Request::builder()
            .method(method)
            .uri(path)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/fhir+json")
            .header(extra, "*")
            .header("If-Match", "W/\"1\"")
            .header("X-Change-Reason", "Synthetic correction")
            .body(Body::from(body.to_string()))
            .unwrap();
        let result = r.clone().oneshot(req).await.unwrap();
        assert_eq!(result.status(), 400);
    }
    let mut corrected = created;
    corrected["name"][0]["family"] = json!("Corrected");
    assert_eq!(call(&r, &a, "PUT", &path, corrected, Some(1)).await.0, 200);
    let after: Value =
        sqlx::query_scalar("SELECT to_jsonb(v) FROM visits v WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(visit)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(before, after);
    assert!(
        sqlx::query("UPDATE patients SET mrn='SYN-UNVERSIONED' WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .execute(&db)
            .await
            .is_err()
    );
}
