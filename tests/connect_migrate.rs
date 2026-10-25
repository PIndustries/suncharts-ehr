// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
use argon2::{
    password_hash::{rand_core::OsRng, SaltString},
    Argon2, PasswordHasher,
};
use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
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
const SECRET: &str = "synthetic-connect-test-key-not-production";
const ORIGIN: &str = "http://127.0.0.1:8099";

async fn setup() -> (Router, PgPool, Actor, String) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("connect_test_{}", Uuid::new_v4().simple());
    let pool = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let db = PgPoolOptions::new()
        .max_connections(8)
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
    let password = Argon2::default()
        .hash_password(
            b"synthetic-test-owner-password",
            &SaltString::generate(&mut OsRng),
        )
        .unwrap()
        .to_string();
    sqlx::query("INSERT INTO browser_users (id,tenant_id,email,password_hash,role) VALUES ($1,$2,'owner@example.test',$3,'owner')").bind(a.sub).bind(a.tenant_id).bind(password).execute(&db).await.unwrap();
    let router = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
    });
    let (_, h, _) = json_call(
        &router,
        "POST",
        "/auth/login",
        None,
        None,
        json!({"email":"owner@example.test","password":"synthetic-test-owner-password"}),
    )
    .await;
    let cookie = h["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    (router, db, a, cookie)
}
fn bearer(a: &Actor) -> String {
    format!(
        "Bearer {}",
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            a,
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes())
        )
        .unwrap()
    )
}
async fn json_call(
    r: &Router,
    method: &str,
    path: &str,
    auth: Option<&str>,
    cookie: Option<&str>,
    body: Value,
) -> (StatusCode, HeaderMap, Value) {
    let mut q = Request::builder()
        .uri(path)
        .method(method)
        .header("origin", ORIGIN);
    if let Some(a) = auth {
        q = q.header("authorization", a);
    }
    if let Some(c) = cookie {
        q = q.header("cookie", c);
    }
    let q = if body.is_null() {
        q.body(Body::empty()).unwrap()
    } else {
        q.header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let response = r.clone().oneshot(q).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let raw = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        headers,
        serde_json::from_slice(&raw).unwrap_or(Value::Null),
    )
}
async fn form(r: &Router, path: &str, basic: &str, pairs: &[(&str, &str)]) -> (StatusCode, Value) {
    let mut encode = url::form_urlencoded::Serializer::new(String::new());
    encode.extend_pairs(pairs.iter().copied());
    let q = Request::builder()
        .uri(path)
        .method("POST")
        .header("authorization", basic)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(Body::from(encode.finish()))
        .unwrap();
    let response = r.clone().oneshot(q).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn grant(r: &Router, cookie: &str, client: &Value, scope: &str) -> (String, String, String) {
    let verifier = suncharts_engine::oauth::random("");
    let challenge = suncharts_engine::oauth::challenge(&verifier);
    let mut uri = url::Url::parse(&format!("{ORIGIN}/oauth/authorize")).unwrap();
    uri.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client["client_id"].as_str().unwrap())
        .append_pair(
            "redirect_uri",
            "https://my.suncharts.app/oauth/ehr/callback",
        )
        .append_pair("state", "synthetic-state-with-enough-entropy")
        .append_pair("scope", scope)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    let (status, h, _) = json_call(
        r,
        "GET",
        &format!("{}?{}", uri.path(), uri.query().unwrap()),
        None,
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, 303);
    let request = url::Url::parse(&format!("{ORIGIN}{}", h["location"].to_str().unwrap()))
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "oauth_request")
        .unwrap()
        .1
        .to_string();
    let (status, _, view) = json_call(
        r,
        "GET",
        &format!("/oauth/requests/{request}"),
        None,
        Some(cookie),
        Value::Null,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(view["name"], "SunCharts test client");
    let (status, _, decision) = json_call(
        r,
        "POST",
        &format!("/oauth/requests/{request}/decision"),
        None,
        Some(cookie),
        json!({"approved":true}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        json_call(
            r,
            "POST",
            &format!("/oauth/requests/{request}/decision"),
            None,
            Some(cookie),
            json!({"approved":true})
        )
        .await
        .0,
        400
    );
    let redirect = url::Url::parse(decision["redirect_uri"].as_str().unwrap()).unwrap();
    let code = redirect
        .query_pairs()
        .find(|(k, _)| k == "code")
        .unwrap()
        .1
        .to_string();
    assert!(redirect
        .query_pairs()
        .any(|(k, v)| k == "iss" && v == ORIGIN));
    let basic = format!(
        "Basic {}",
        STANDARD.encode(format!(
            "{}:{}",
            client["client_id"].as_str().unwrap(),
            client["client_secret"].as_str().unwrap()
        ))
    );
    (code, verifier, basic)
}

#[tokio::test]
async fn oauth_pkce_scopes_refresh_replay_revocation_and_live_events() {
    let (r, db, a, cookie) = setup().await;
    let (status, _, meta) = json_call(
        &r,
        "GET",
        "/.well-known/oauth-authorization-server",
        None,
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(meta["issuer"], ORIGIN);
    let new = json!({"name":"SunCharts test client","redirect_uri":"https://my.suncharts.app/oauth/ehr/callback","scope":"clinical.read clinical.write events.read offline_access migration.manage"});
    let (status, _, client) = json_call(
        &r,
        "POST",
        "/api/v1/oauth/clients",
        None,
        Some(&cookie),
        new,
    )
    .await;
    assert_eq!(status, 200);
    let (code, verifier, basic) = grant(
        &r,
        &cookie,
        &client,
        "clinical.read clinical.write events.read offline_access",
    )
    .await;
    let (status, error) = form(
        &r,
        "/oauth/token",
        &basic,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            (
                "redirect_uri",
                "https://my.suncharts.app/oauth/ehr/callback",
            ),
            (
                "code_verifier",
                "wrong-verifier-that-is-long-enough-but-is-not-right",
            ),
        ],
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(error["error"], "invalid_grant");
    let (status, tokens) = form(
        &r,
        "/oauth/token",
        &basic,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            (
                "redirect_uri",
                "https://my.suncharts.app/oauth/ehr/callback",
            ),
            ("code_verifier", &verifier),
        ],
    )
    .await;
    assert_eq!(status, 200);
    let auth = format!("Bearer {}", tokens["access_token"].as_str().unwrap());
    let (status, _, who) = json_call(
        &r,
        "GET",
        "/api/v1/connection",
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(who["tenant_id"], json!(a.tenant_id));
    let (status,_,patient)=json_call(&r,"POST","/api/v1/patients",Some(&auth),None,json!({"mrn":"CONNECT-001","given_name":"Synthetic","family_name":"Connection","birth_date":"1990-01-01"})).await;
    assert_eq!(status, 201);
    let (status, _, events) = json_call(
        &r,
        "GET",
        "/api/v1/events?after=0",
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(events["items"][0]["action"], "patient.create");
    assert_eq!(events["items"][0]["resource_id"], patient["id"]);
    assert!(events["items"][0].get("data").is_none());
    // Live stream emits references, then terminates when its grant is revoked.
    let request = Request::builder()
        .uri("/api/v1/events/stream?after=0")
        .header("authorization", &auth)
        .body(Body::empty())
        .unwrap();
    let response = r.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), 200);
    let mut feed = response.into_body();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(3), feed.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(String::from_utf8_lossy(frame.data_ref().unwrap()).contains("clinical.change"));
    assert_eq!(
        form(
            &r,
            "/oauth/revoke",
            &basic,
            &[("token", tokens["access_token"].as_str().unwrap())]
        )
        .await
        .0,
        200
    );
    assert_eq!(
        json_call(
            &r,
            "GET",
            "/api/v1/connection",
            Some(&auth),
            None,
            Value::Null
        )
        .await
        .0,
        401
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(3), feed.frame())
            .await
            .unwrap()
            .is_none()
    );
    // Refresh rotates exactly once; replay invalidates the whole grant, including its new token.
    let (code, verifier, basic) = grant(&r, &cookie, &client, "clinical.read offline_access").await;
    let (_, t) = form(
        &r,
        "/oauth/token",
        &basic,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            (
                "redirect_uri",
                "https://my.suncharts.app/oauth/ehr/callback",
            ),
            ("code_verifier", &verifier),
        ],
    )
    .await;
    let read = format!("Bearer {}", t["access_token"].as_str().unwrap());
    assert_eq!(json_call(&r,"POST","/api/v1/patients",Some(&read),None,json!({"mrn":"NO-WRITE","given_name":"Denied","family_name":"Synthetic","birth_date":"1990-01-01"})).await.0,403);
    let refresh = t["refresh_token"].as_str().unwrap();
    let (status, rotated) = form(
        &r,
        "/oauth/token",
        &basic,
        &[("grant_type", "refresh_token"), ("refresh_token", refresh)],
    )
    .await;
    assert_eq!(status, 200);
    assert_ne!(rotated["refresh_token"], t["refresh_token"]);
    assert_eq!(
        form(
            &r,
            "/oauth/token",
            &basic,
            &[("grant_type", "refresh_token"), ("refresh_token", refresh)]
        )
        .await
        .0,
        400
    );
    let current = format!("Bearer {}", rotated["access_token"].as_str().unwrap());
    assert_eq!(
        json_call(
            &r,
            "GET",
            "/api/v1/patients",
            Some(&current),
            None,
            Value::Null
        )
        .await
        .0,
        401
    );
    let stored: Vec<String> = sqlx::query_scalar("SELECT hash FROM oauth_tokens")
        .fetch_all(&db)
        .await
        .unwrap();
    assert!(!stored
        .iter()
        .any(|v| v == t["access_token"].as_str().unwrap()));
    db.close().await;
}

#[tokio::test]
async fn migration_reconciles_imports_idempotently_preserves_source_and_blocks_false_cutover() {
    let (r, db, a, _) = setup().await;
    let auth = bearer(&a);
    let manifest = json!({"source_instance":"legacy-synthetic-instance","source_revision":"snapshot-001","expected_counts":{"patient":1,"soap_note":1,"allergy":1},"consistency":"read_only_export","limitations":["Document bytes require a separate verified export"]});
    let (_, _, job) = json_call(
        &r,
        "POST",
        "/api/v1/migrations",
        Some(&auth),
        None,
        manifest.clone(),
    )
    .await;
    let id = job["id"].as_str().unwrap();
    let batch = json!({"items":[
        {"kind":"patient","source_id":"oe-patient-1","patient_source_id":null,"data":{"mrn":"MIG-001","given_name":"Imported","family_name":"Synthetic","birth_date":"1980-01-01"},"source_data":{"uuid":"oe-patient-1","fname":"Imported","lname":"Synthetic","DOB":"1980-01-01","phone_home":"synthetic"}},
        {"kind":"soap_note","source_id":"soap-1","patient_source_id":"oe-patient-1","data":{"subjective":"Historical synthetic note","plan":"Original follow-up"},"source_data":{"id":"soap-1","user":"original-clinician","date":"2020-01-01"}},
        {"kind":"allergy","source_id":"allergy-1","patient_source_id":"oe-patient-1","data":{"title":"Synthetic allergy","reaction":"Synthetic reaction"},"source_data":{"id":"allergy-1","type":"allergy"}}
    ]});
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("/api/v1/migrations/{id}/reconcile"),
            Some(&auth),
            None,
            Value::Null
        )
        .await
        .2["ready_to_import"],
        false
    );
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("/api/v1/migrations/{id}/items"),
            Some(&auth),
            None,
            batch.clone()
        )
        .await
        .0,
        200
    );
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("/api/v1/migrations/{id}/items"),
            Some(&auth),
            None,
            batch.clone()
        )
        .await
        .0,
        200,
        "identical staging retry is safe"
    );
    let (_, _, report) = json_call(
        &r,
        "POST",
        &format!("/api/v1/migrations/{id}/reconcile"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(report["ready_to_import"], true);
    assert_eq!(report["counts"]["soap_note"], 1);
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM patients")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(before, 0, "staging must not expose patients");
    let commit = json!({"digest":report["digest"]});
    // Fail the final audit: no patient, mapping or historical record may leak out.
    sqlx::raw_sql("CREATE FUNCTION reject_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='migration.import' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_import BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_import();").execute(&db).await.unwrap();
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("/api/v1/migrations/{id}/commit"),
            Some(&auth),
            None,
            commit.clone()
        )
        .await
        .0,
        500
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM patients")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    sqlx::query("DROP TRIGGER reject_import ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    let (status, _, imported) = json_call(
        &r,
        "POST",
        &format!("/api/v1/migrations/{id}/commit"),
        Some(&auth),
        None,
        commit.clone(),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(imported["status"], "imported");
    assert_eq!(imported["cutover"]["allowed"], false);
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("/api/v1/migrations/{id}/commit"),
            Some(&auth),
            None,
            commit
        )
        .await
        .0,
        200
    );
    let (_, _, patients) = json_call(
        &r,
        "GET",
        "/api/v1/patients",
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(patients["items"].as_array().unwrap().len(), 1);
    let patient = patients["items"][0]["id"].as_str().unwrap();
    let (_, _, history) = json_call(
        &r,
        "GET",
        &format!("/api/v1/patients/{patient}/history"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(history["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        history["items"][0]["signature_origin"],
        "external_unverified"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM visits")
            .fetch_one(&db)
            .await
            .unwrap(),
        0,
        "historical notes are not fabricated native signatures"
    );
    // Another snapshot preserves stable identifiers and does not duplicate imported records.
    let (_, _, second) = json_call(
        &r,
        "POST",
        "/api/v1/migrations",
        Some(&auth),
        None,
        manifest,
    )
    .await;
    let second = second["id"].as_str().unwrap();
    json_call(
        &r,
        "POST",
        &format!("/api/v1/migrations/{second}/items"),
        Some(&auth),
        None,
        batch,
    )
    .await;
    let (_, _, report) = json_call(
        &r,
        "POST",
        &format!("/api/v1/migrations/{second}/reconcile"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(report["ready_to_import"], true);
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("/api/v1/migrations/{second}/commit"),
            Some(&auth),
            None,
            json!({"digest":report["digest"]})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM historical_records")
            .fetch_one(&db)
            .await
            .unwrap(),
        2
    );
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        json_call(
            &r,
            "GET",
            &format!("/api/v1/migrations/{id}"),
            Some(&bearer(&other)),
            None,
            Value::Null
        )
        .await
        .0,
        404
    );
    let mut staff = a;
    staff.role = Role::Clinician;
    assert_eq!(
        json_call(
            &r,
            "GET",
            "/api/v1/migrations",
            Some(&bearer(&staff)),
            None,
            Value::Null
        )
        .await
        .0,
        403
    );
    db.close().await;
}

#[tokio::test]
async fn fhir_patient_boundary_is_scoped_and_honest() {
    let (r, db, a, _) = setup().await;
    let auth = bearer(&a);
    let mut ids = Vec::new();
    for n in 0..2 {
        let (status, _, p) = json_call(&r, "POST", "/api/v1/patients", Some(&auth), None,
            json!({"mrn":format!("FHIR-{n}"),"given_name":"Avery","family_name":"Synthetic","birth_date":"1990-01-02"})).await;
        assert_eq!(status, StatusCode::CREATED);
        ids.push(p["id"].as_str().unwrap().to_string());
    }
    let (status, _, cap) = json_call(&r, "GET", "/fhir/metadata", None, None, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cap["fhirVersion"], "4.0.1");
    assert_eq!(cap["rest"][0]["resource"].as_array().unwrap().len(), 1);
    let (status, h, bundle) = json_call(
        &r,
        "GET",
        "/fhir/Patient?name=ave&_count=1",
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(h["content-type"], "application/fhir+json");
    assert_eq!(bundle["entry"].as_array().unwrap().len(), 1);
    let next = url::Url::parse(bundle["link"][1]["url"].as_str().unwrap()).unwrap();
    let (_, _, second) = json_call(
        &r,
        "GET",
        &format!("{}?{}", next.path(), next.query().unwrap()),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_ne!(
        bundle["entry"][0]["resource"]["id"],
        second["entry"][0]["resource"]["id"]
    );
    let (status, _, p) = json_call(
        &r,
        "GET",
        &format!("/fhir/Patient/{}", ids[0]),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(p["identifier"][0]["value"], "FHIR-0");
    assert_eq!(p["birthDate"], "1990-01-02");
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    let (status, _, out) = json_call(
        &r,
        "GET",
        &format!("/fhir/Patient/{}", ids[0]),
        Some(&bearer(&other)),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(out["resourceType"], "OperationOutcome");
    let (status, _, _) = json_call(
        &r,
        "GET",
        "/fhir/Patient?gender=female",
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, out) = json_call(&r, "GET", "/fhir/Patient", None, None, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(out["resourceType"], "OperationOutcome");
    let (_, _, notices) =
        json_call(&r, "GET", "/api/v1/events", Some(&auth), None, Value::Null).await;
    assert!(notices["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["action"] != "patient.fhir_search"));
    db.close().await;
}

fn clinical_content(kind: &str) -> Value {
    let detail = match kind {
        "problem" => json!({"kind":"problem","problem_type":"problem"}),
        "allergy" => {
            json!({"kind":"allergy","category":"medication","reaction":"Hives","severity":"moderate","criticality":"high"})
        }
        _ => {
            json!({"kind":"medication","dose":"10 mg","route":"oral","frequency":"daily","indication":"Synthetic example"})
        }
    };
    json!({"title":format!("Synthetic {kind}"),"status":"active","verification":"confirmed","onset_date":"2026-01-01","end_date":null,"codes":[{"system":"urn:synthetic:terminology","code":"TEST","display":"Synthetic only"}],"notes":"Synthetic documentation","detail":detail})
}
async fn version_call(
    r: &Router,
    path: &str,
    auth: &str,
    version: i64,
    method: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = r
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", auth)
                .header("content-type", "application/json")
                .header("if-match", format!("\"{version}\""))
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn longitudinal_lists_are_versioned_reviewed_and_tenant_scoped() {
    let (r, db, a, _) = setup().await;
    let auth = bearer(&a);
    let (_,_,p)=json_call(&r,"POST","/api/v1/patients",Some(&auth),None,json!({"mrn":"CLINICAL-1","given_name":"Avery","family_name":"Synthetic","birth_date":"1990-01-01"})).await;
    let p = p["id"].as_str().unwrap();
    let path = format!("/api/v1/patients/{p}/clinical");
    let (status, _) = version_call(
        &r,
        &format!("/api/v1/patients/{p}/clinical-review/allergy"),
        &auth,
        1,
        "POST",
        json!({"review_state":"no_known","note":"Synthetic initial review"}),
    )
    .await;
    assert_eq!(status, 200);
    for kind in ["problem", "allergy", "medication"] {
        let body = json!({"content":clinical_content(kind),"reason":"Initial synthetic clinical documentation"});
        let (status, h, e) = json_call(&r, "POST", &path, Some(&auth), None, body.clone()).await;
        assert_eq!(status, 200);
        assert_eq!(h["etag"], "\"1\"");
        let id = e["id"].as_str().unwrap();
        let edit = format!("{path}/{id}");
        let mut changed = body.clone();
        changed["content"]["status"] = json!(if kind == "medication" {
            "stopped"
        } else {
            "resolved"
        });
        changed["content"]["end_date"] = json!("2026-02-01");
        changed["reason"] = json!("Reconciled with synthetic patient");
        let (x, y) = tokio::join!(
            version_call(&r, &edit, &auth, 1, "PUT", changed.clone()),
            version_call(&r, &edit, &auth, 1, "PUT", changed.clone())
        );
        let mut statuses = [x.0.as_u16(), y.0.as_u16()];
        statuses.sort();
        assert_eq!(statuses, [200, 409]);
        let (_, _, history) = json_call(
            &r,
            "GET",
            &format!("{edit}/revisions"),
            Some(&auth),
            None,
            Value::Null,
        )
        .await;
        assert_eq!(history["items"].as_array().unwrap().len(), 2);
        assert_eq!(history["items"][1]["content"]["status"], "active");
        assert_eq!(history["items"][0]["author_id"], a.sub.to_string());
        let mut reader = a.clone();
        reader.role = Role::ReadOnly;
        assert_eq!(
            json_call(
                &r,
                "POST",
                &path,
                Some(&bearer(&reader)),
                None,
                body.clone()
            )
            .await
            .0,
            403
        );
        reader.role = Role::FrontDesk;
        assert_eq!(
            version_call(&r, &edit, &bearer(&reader), 2, "PUT", changed.clone())
                .await
                .0,
            403
        );
        let mut other = a.clone();
        other.tenant_id = Uuid::new_v4();
        assert_eq!(
            json_call(&r, "GET", &path, Some(&bearer(&other)), None, Value::Null)
                .await
                .0,
            404
        );
        let mut bad = changed.clone();
        bad["content"]["end_date"] = json!("2025-01-01");
        assert_eq!(version_call(&r, &edit, &auth, 2, "PUT", bad).await.0, 400);
        // A clinical write and its revision/list invalidation must roll back if audit fails.
        sqlx::raw_sql("CREATE FUNCTION reject_clinical() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.clinical.update' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_clinical BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_clinical();").execute(&db).await.unwrap();
        assert_eq!(
            version_call(&r, &edit, &auth, 2, "PUT", changed).await.0,
            500
        );
        sqlx::raw_sql(
            "DROP TRIGGER reject_clinical ON audit_events; DROP FUNCTION reject_clinical();",
        )
        .execute(&db)
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT version FROM clinical_entries WHERE tenant_id=$1 AND id=$2"
            )
            .bind(a.tenant_id)
            .bind(id.parse::<Uuid>().unwrap())
            .fetch_one(&db)
            .await
            .unwrap(),
            2
        );
    }
    let (_, _, lists) = json_call(&r, "GET", &path, Some(&auth), None, Value::Null).await;
    let allergy = lists["reviews"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["kind"] == "allergy")
        .unwrap();
    assert_eq!(allergy["review_state"], "needs_review");
    let review_path = format!("/api/v1/patients/{p}/clinical-review/allergy");
    let version = allergy["version"].as_i64().unwrap();
    assert_eq!(
        version_call(
            &r,
            &review_path,
            &auth,
            version - 1,
            "POST",
            json!({"review_state":"no_known","note":"Stale review"})
        )
        .await
        .0,
        409
    );
    assert_eq!(
        version_call(
            &r,
            &review_path,
            &auth,
            version,
            "POST",
            json!({"review_state":"no_known","note":"Resolved synthetic allergy reviewed"})
        )
        .await
        .0,
        200
    );
    assert!(
        sqlx::query("UPDATE clinical_revisions SET reason='changed'")
            .execute(&db)
            .await
            .is_err()
    );
    assert!(sqlx::query("DELETE FROM clinical_reviews")
        .execute(&db)
        .await
        .is_err());
    let body =
        json!({"content":clinical_content("allergy"),"reason":"New synthetic active allergy"});
    assert_eq!(
        json_call(&r, "POST", &path, Some(&auth), None, body)
            .await
            .0,
        200
    );
    assert_eq!(
        version_call(
            &r,
            &review_path,
            &auth,
            version + 2,
            "POST",
            json!({"review_state":"no_known","note":"Contradictory review"})
        )
        .await
        .0,
        409
    );
    let (_, _, events) =
        json_call(&r, "GET", "/api/v1/events", Some(&auth), None, Value::Null).await;
    assert!(events["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["action"] == "patient.clinical.create"));
    db.close().await;
}

#[tokio::test]
async fn imported_lists_require_explicit_clinician_mapping_and_keep_original_history() {
    let (r, db, a, _) = setup().await;
    let auth = bearer(&a);
    let (_,_,job)=json_call(&r,"POST","/api/v1/migrations",Some(&auth),None,json!({"source_instance":"Synthetic lists","source_revision":"1","expected_counts":{"patient":1,"allergy":1,"medical_problem":1,"medication":1},"consistency":"read_only_export"})).await;
    let id = job["id"].as_str().unwrap();
    let mut items = vec![
        json!({"kind":"patient","source_id":"p1","data":{"mrn":"SOURCE-LISTS","given_name":"Morgan","family_name":"Synthetic","birth_date":"1988-03-12"},"source_data":{}}),
    ];
    for kind in ["allergy", "medical_problem", "medication"] {
        items.push(json!({"kind":kind,"source_id":kind,"patient_source_id":"p1","data":{"title":format!("Synthetic {kind}")},"source_data":{"title":format!("Synthetic {kind}"),"begdate":"2020-01-01 12:00:00","enddate":"0000-00-00","activity":"1","comments":"Original source note","diagnosis":"ICD10:TEST","reaction":"Hives","severity_al":"source-local-code","dosage":"10 mg","route":"oral","frequency":"daily"}}));
    }
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("/api/v1/migrations/{id}/items"),
            Some(&auth),
            None,
            json!({"items":items})
        )
        .await
        .0,
        200
    );
    let (_, _, report) = json_call(
        &r,
        "POST",
        &format!("/api/v1/migrations/{id}/reconcile"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(report["ready_to_import"], true);
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("/api/v1/migrations/{id}/commit"),
            Some(&auth),
            None,
            json!({"digest":report["digest"]})
        )
        .await
        .0,
        200
    );
    let p: Uuid =
        sqlx::query_scalar("SELECT id FROM patients WHERE tenant_id=$1 AND mrn='SOURCE-LISTS'")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    let base = format!("/api/v1/patients/{p}");
    let (status, _) = version_call(
        &r,
        &format!("{base}/clinical-review/allergy"),
        &auth,
        2,
        "POST",
        json!({"review_state":"reviewed","note":"Unmapped source"}),
    )
    .await;
    assert_eq!(status, 409);
    let (_, _, history) = json_call(
        &r,
        "GET",
        &format!("{base}/history"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    for source in history["items"].as_array().unwrap() {
        let hid = source["id"].as_str().unwrap();
        let (_, _, mapping) = json_call(
            &r,
            "GET",
            &format!("{base}/history/{hid}/mapping"),
            Some(&auth),
            None,
            Value::Null,
        )
        .await;
        assert_eq!(mapping["requires_clinician_review"], true);
        assert_eq!(mapping["content"]["verification"], "unconfirmed");
        assert_eq!(mapping["content"]["onset_date"], "2020-01-01");
        let body = json!({"content":mapping["content"],"source_history_id":hid,"reason":"Reviewed against preserved synthetic source"});
        assert_eq!(
            json_call(
                &r,
                "POST",
                &format!("{base}/clinical"),
                Some(&auth),
                None,
                body.clone()
            )
            .await
            .0,
            200
        );
        assert_eq!(
            json_call(
                &r,
                "POST",
                &format!("{base}/clinical"),
                Some(&auth),
                None,
                body
            )
            .await
            .0,
            409
        );
        let (_, _, mapped) = json_call(
            &r,
            "GET",
            &format!("{base}/history/{hid}/mapping"),
            Some(&auth),
            None,
            Value::Null,
        )
        .await;
        assert!(mapped["native_entry_id"].is_string());
    }
    assert_eq!(
        version_call(
            &r,
            &format!("{base}/clinical-review/allergy"),
            &auth,
            3,
            "POST",
            json!({"review_state":"reviewed","note":"All source entries reconciled"})
        )
        .await
        .0,
        200
    );
    let preserved: Value = sqlx::query_scalar(
        "SELECT source_data FROM historical_records WHERE tenant_id=$1 AND kind='allergy'",
    )
    .bind(a.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(preserved["severity_al"], "source-local-code");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM clinical_entries WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap(),
        3
    );
    let (_,_,next)=json_call(&r,"POST","/api/v1/migrations",Some(&auth),None,json!({"source_instance":"Synthetic lists","source_revision":"2","expected_counts":{"allergy":1},"consistency":"read_only_export"})).await;
    let next = next["id"].as_str().unwrap();
    assert_eq!(json_call(&r,"POST",&format!("/api/v1/migrations/{next}/items"),Some(&auth),None,json!({"items":[{"kind":"allergy","source_id":"new-allergy","patient_source_id":"p1","data":{"title":"New synthetic source allergy"},"source_data":{"title":"New synthetic source allergy"}}]})).await.0,200);
    let (_, _, check) = json_call(
        &r,
        "POST",
        &format!("/api/v1/migrations/{next}/reconcile"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("/api/v1/migrations/{next}/commit"),
            Some(&auth),
            None,
            json!({"digest":check["digest"]})
        )
        .await
        .0,
        200
    );
    let (_, _, lists) = json_call(
        &r,
        "GET",
        &format!("{base}/clinical"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(
        lists["reviews"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["kind"] == "allergy")
            .unwrap()["review_state"],
        "needs_review"
    );
    db.close().await;
}

fn laboratory_order() -> Value {
    json!({"request_id":Uuid::new_v4(),"visit_id":null,"source_history_id":null,"reason":"Synthetic test order","content":{"title":"Synthetic electrolyte panel","category":"laboratory","priority":"routine","clinical_reason":"Synthetic monitoring","destination":"Synthetic laboratory","instructions":"Synthetic specimen only","tests":[{"key":"panel1","label":"Synthetic panel","code":null}]}})
}
fn laboratory_report(specimen: Option<&str>) -> Value {
    json!({"request_id":Uuid::new_v4(),"source_history_id":null,"status":"preliminary","reason":"Synthetic manual result entry","content":{"test_keys":["panel1"],"specimen_id":specimen,"specimen_not_recorded":false,"accession":"SYN-REPORT-1","performing_lab":"Synthetic laboratory","reported_at":"2026-10-23T12:00:00Z","observations":[{"label":"Synthetic potassium","code":null,"value_type":"numeric","number":6.2,"comparator":"","text":"","coded":null,"units":"mmol/L","reference_range":"3.5–5.1","flag":"critical_high","absent_reason":"","notes":"Synthetic result only"}],"notes":"Synthetic panel"}})
}
#[tokio::test]
async fn orders_specimens_panels_corrections_and_acknowledgment_are_atomic() {
    let (r, db, a, _) = setup().await;
    let auth = bearer(&a);
    let (_,_,p)=json_call(&r,"POST","/api/v1/patients",Some(&auth),None,json!({"mrn":"LAB-NATIVE","given_name":"Avery","family_name":"Synthetic","birth_date":"1990-01-01"})).await;
    let p = p["id"].as_str().unwrap();
    let base = format!("/api/v1/patients/{p}/orders");
    let input = laboratory_order();
    let (status, _, order) = json_call(&r, "POST", &base, Some(&auth), None, input.clone()).await;
    assert_eq!(status, 200);
    let oid = order["id"].as_str().unwrap();
    let orderpath = format!("{base}/{oid}");
    let (_, _, retry) = json_call(&r, "POST", &base, Some(&auth), None, input.clone()).await;
    assert_eq!(retry["id"], oid);
    let mut changed = input.clone();
    changed["content"]["title"] = json!("Changed retry");
    assert_eq!(
        json_call(&r, "POST", &base, Some(&auth), None, changed)
            .await
            .0,
        409
    );
    let mut reader = a.clone();
    reader.role = Role::ReadOnly;
    assert_eq!(
        json_call(
            &r,
            "POST",
            &base,
            Some(&bearer(&reader)),
            None,
            laboratory_order()
        )
        .await
        .0,
        403
    );
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        json_call(&r, "GET", &base, Some(&bearer(&other)), None, Value::Null)
            .await
            .0,
        404
    );
    let actions = format!("{orderpath}/actions");
    assert_eq!(
        version_call(
            &r,
            &actions,
            &auth,
            1,
            "POST",
            json!({"action":"place","reason":"Synthetic authorized local order"})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        version_call(
            &r,
            &orderpath,
            &auth,
            2,
            "PUT",
            json!({"content":input["content"],"reason":"Attempt to rewrite placed order"})
        )
        .await
        .0,
        409
    );
    let specimen_body = json!({"request_id":Uuid::new_v4(),"reason":"Synthetic intake","content":{"accession":"SYN-SPEC-1","specimen_type":"Serum","body_site":"Peripheral blood","collected_at":"2026-10-23T10:00:00Z","received_at":"2026-10-23T11:00:00Z","status":"received","notes":"Synthetic tube"}});
    let (status, specimen) = version_call(
        &r,
        &format!("{orderpath}/specimens"),
        &auth,
        2,
        "POST",
        specimen_body.clone(),
    )
    .await;
    assert_eq!(status, 200);
    let sid = specimen["id"].as_str().unwrap();
    assert_eq!(
        version_call(
            &r,
            &format!("{orderpath}/specimens"),
            &auth,
            2,
            "POST",
            specimen_body
        )
        .await
        .1["id"],
        sid
    );
    let reports = format!("{orderpath}/reports");
    let body = laboratory_report(Some(sid));
    let (status, report) = version_call(&r, &reports, &auth, 3, "POST", body.clone()).await;
    assert_eq!(status, 200);
    let rid = report["id"].as_str().unwrap();
    assert_eq!(
        version_call(&r, &reports, &auth, 3, "POST", body.clone())
            .await
            .1["id"],
        rid
    );
    let reportpath = format!("{reports}/{rid}");
    let ackpath = format!("{reportpath}/acknowledge");
    assert_eq!(
        version_call(
            &r,
            &ackpath,
            &auth,
            1,
            "POST",
            json!({"note":"Synthetic preliminary critical result reviewed"})
        )
        .await
        .0,
        200
    );
    let final_body =
        json!({"content":body["content"],"status":"final","reason":"Synthetic panel finalized"});
    let (x, y) = tokio::join!(
        version_call(&r, &reportpath, &auth, 1, "PUT", final_body.clone()),
        version_call(&r, &reportpath, &auth, 1, "PUT", final_body)
    );
    let mut statuses = [x.0.as_u16(), y.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    let (_, _, inbox) = json_call(
        &r,
        "GET",
        "/api/v1/labs/inbox",
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(inbox["items"][0]["critical"], true);
    assert_eq!(
        version_call(
            &r,
            &actions,
            &auth,
            5,
            "POST",
            json!({"action":"complete","reason":"Attempt before review"})
        )
        .await
        .0,
        409
    );
    assert_eq!(
        version_call(
            &r,
            &ackpath,
            &auth,
            2,
            "POST",
            json!({"note":"Synthetic critical result reviewed; simulated follow-up documented"})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        version_call(
            &r,
            &actions,
            &auth,
            5,
            "POST",
            json!({"action":"complete","reason":"All requested tests final and acknowledged"})
        )
        .await
        .0,
        200
    );
    let correction = json!({"content":body["content"],"status":"corrected","reason":"Synthetic laboratory issued a corrected value"});
    sqlx::raw_sql("CREATE FUNCTION reject_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.report.revise' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_report BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_report();").execute(&db).await.unwrap();
    assert_eq!(
        version_call(&r, &reportpath, &auth, 2, "PUT", correction.clone())
            .await
            .0,
        500
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT version FROM lab_reports WHERE tenant_id=$1 AND id=$2"
        )
        .bind(a.tenant_id)
        .bind(rid.parse::<Uuid>().unwrap())
        .fetch_one(&db)
        .await
        .unwrap(),
        2
    );
    sqlx::raw_sql("DROP TRIGGER reject_report ON audit_events; DROP FUNCTION reject_report();")
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        version_call(&r, &reportpath, &auth, 2, "PUT", correction)
            .await
            .0,
        200
    );
    let (_, _, current) = json_call(&r, "GET", &base, Some(&auth), None, Value::Null).await;
    assert_eq!(current["orders"][0]["status"], "in_progress");
    assert_eq!(current["reports"][0]["version"], 3);
    assert!(current["acknowledgments"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["version"] == 2));
    assert_eq!(
        version_call(
            &r,
            &ackpath,
            &auth,
            2,
            "POST",
            json!({"note":"Stale acknowledgment"})
        )
        .await
        .0,
        409
    );
    let (_, _, history) = json_call(
        &r,
        "GET",
        &format!("{reportpath}/history"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(history["items"].as_array().unwrap().len(), 3);
    assert_eq!(history["items"][1]["snapshot"]["status"], "final");
    for table in [
        "lab_report_revisions",
        "lab_order_revisions",
        "lab_specimens",
        "lab_acknowledgments",
    ] {
        assert!(sqlx::query(&format!("DELETE FROM {table}"))
            .execute(&db)
            .await
            .is_err());
    }
    let mut invalid = body;
    invalid["request_id"] = json!(Uuid::new_v4());
    invalid["status"] = json!("final");
    invalid["content"]["specimen_id"] = Value::Null;
    assert_eq!(
        version_call(&r, &reports, &auth, 7, "POST", invalid)
            .await
            .0,
        400
    );
    db.close().await;
}

#[tokio::test]
async fn source_laboratory_orders_and_reports_preserve_linkage_and_unverified_signatures() {
    let (r, db, a, _) = setup().await;
    let auth = bearer(&a);
    let (_,_,job)=json_call(&r,"POST","/api/v1/migrations",Some(&auth),None,json!({"source_instance":"Synthetic laboratory source","source_revision":"1","expected_counts":{"patient":1,"lab_order":1,"lab_result":1},"consistency":"read_only_export"})).await;
    let id = job["id"].as_str().unwrap();
    let m = format!("/api/v1/migrations/{id}");
    let items = json!({"items":[{"kind":"patient","source_id":"p1","data":{"mrn":"LAB-SOURCE","given_name":"Jordan","family_name":"Synthetic","birth_date":"1987-05-12"},"source_data":{}},{"kind":"lab_order","source_id":"procedure_order/10","patient_source_id":"p1","data":{"title":"Source panel"},"source_data":{"order":{"procedure_order_id":"10","order_title":"Synthetic source panel","clinical_hx":"Synthetic source reason","patient_instructions":"Synthetic preparation instructions","order_abn":"signed"},"tests":[{"procedure_order_seq":"1","procedure_name":"Synthetic panel","procedure_code":"TEST"}]}},{"kind":"lab_result","source_id":"procedure_report/20","patient_source_id":"p1","data":{"title":"Source report"},"source_data":{"source_order_id":"procedure_order/10","report":{"procedure_order_seq":"1","specimen_num":"SYN-EXT","report_status":"final","date_report":"2026-10-01 10:00:00","date_report_tz":"-0500"},"results":[{"result_text":"Synthetic sodium","result_data_type":"N","result":"140","units":"mmol/L","range":"135-145","abnormal":"N","original_author":"source-lab"}]}}]});
    assert_eq!(
        json_call(&r, "POST", &format!("{m}/items"), Some(&auth), None, items)
            .await
            .0,
        200
    );
    let (_, _, check) = json_call(
        &r,
        "POST",
        &format!("{m}/reconcile"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(check["ready_to_import"], true);
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("{m}/commit"),
            Some(&auth),
            None,
            json!({"digest":check["digest"]})
        )
        .await
        .0,
        200
    );
    let p: Uuid =
        sqlx::query_scalar("SELECT id FROM patients WHERE tenant_id=$1 AND mrn='LAB-SOURCE'")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    let base = format!("/api/v1/patients/{p}");
    let oh: Uuid = sqlx::query_scalar(
        "SELECT id FROM historical_records WHERE tenant_id=$1 AND kind='lab_order'",
    )
    .bind(a.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    let rh: Uuid = sqlx::query_scalar(
        "SELECT id FROM historical_records WHERE tenant_id=$1 AND kind='lab_result'",
    )
    .bind(a.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        json_call(
            &r,
            "GET",
            &format!("{base}/history/{rh}/lab-mapping"),
            Some(&auth),
            None,
            Value::Null
        )
        .await
        .0,
        409
    );
    let (_, _, mapping) = json_call(
        &r,
        "GET",
        &format!("{base}/history/{oh}/lab-mapping"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(
        mapping["content"]["instructions"],
        "Synthetic preparation instructions"
    );
    let mut content = mapping["content"].clone();
    content["destination"] = json!("Synthetic source lab, identity reviewed");
    let (_,_,o)=json_call(&r,"POST",&format!("{base}/orders"),Some(&auth),None,json!({"request_id":Uuid::new_v4(),"source_history_id":oh,"content":content,"reason":"Clinician reconciled preserved source order"})).await;
    let oid = o["id"].as_str().unwrap();
    let op = format!("{base}/orders/{oid}");
    assert_eq!(version_call(&r,&format!("{op}/actions"),&auth,1,"POST",json!({"action":"place","reason":"Record reconciled order locally; no external dispatch"})).await.0,200);
    let (_, _, mapping) = json_call(
        &r,
        "GET",
        &format!("{base}/history/{rh}/lab-mapping"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(mapping["native_order_id"], oid);
    assert_eq!(mapping["content"]["reported_at"], "2026-10-01T15:00:00Z");
    assert_eq!(mapping["content"]["observations"][0]["number"], 140.0);
    let mut content = mapping["content"].clone();
    content["performing_lab"] = json!("Synthetic source laboratory");
    let (status,report)=version_call(&r,&format!("{op}/reports"),&auth,2,"POST",json!({"request_id":Uuid::new_v4(),"source_history_id":rh,"content":content,"status":"final","reason":"Reviewed source result values, units, time and missing native specimen"})).await;
    assert_eq!(status, 200);
    let (_, _, orders) = json_call(
        &r,
        "GET",
        &format!("{base}/orders"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(
        orders["reports"][0]["signature_origin"],
        "external_unverified"
    );
    assert_eq!(orders["reports"][0]["id"], report["id"]);
    assert_eq!(
        orders["specimens"].as_array().unwrap().len(),
        0,
        "source reconciliation must not fabricate a collection"
    );
    let raw: Value = sqlx::query_scalar(
        "SELECT source_data FROM historical_records WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(rh)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(raw["results"][0]["original_author"], "source-lab");
    db.close().await;
}

#[tokio::test]
async fn panel_coverage_and_typed_values_are_enforced() {
    let (r, db, a, _) = setup().await;
    let auth = bearer(&a);
    let (_,_,p)=json_call(&r,"POST","/api/v1/patients",Some(&auth),None,json!({"mrn":"LAB-COVERAGE","given_name":"Avery","family_name":"Synthetic","birth_date":"1990-01-01"})).await;
    let p = p["id"].as_str().unwrap();
    let base = format!("/api/v1/patients/{p}/orders");
    let mut input = laboratory_order();
    input["content"]["category"] = json!("procedure");
    input["content"]["tests"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key":"panel2","label":"Second synthetic test","code":null}));
    let (_, _, o) = json_call(&r, "POST", &base, Some(&auth), None, input.clone()).await;
    let oid = o["id"].as_str().unwrap();
    let path = format!("{base}/{oid}");
    assert_eq!(version_call(&r,&path,&auth,1,"PUT",json!({"content":input["content"],"reason":"Updated draft instructions","visit_id":null})).await.0,200);
    assert_eq!(
        version_call(
            &r,
            &format!("{path}/actions"),
            &auth,
            2,
            "POST",
            json!({"action":"place","reason":"Synthetic authorized procedure"})
        )
        .await
        .0,
        200
    );
    let mut report = laboratory_report(None);
    report["status"] = json!("final");
    report["content"]["observations"] = json!([
 {"label":"Synthetic text","value_type":"text","text":"No synthetic finding","flag":"normal"},
 {"label":"Synthetic coded","value_type":"coded","coded":{"system":"urn:synthetic","code":"TEST","display":"Synthetic result"},"flag":"unknown"},
 {"label":"Unavailable synthetic component","value_type":"absent","absent_reason":"not_performed","flag":"unknown"}]);
    let (status, r1) = version_call(
        &r,
        &format!("{path}/reports"),
        &auth,
        3,
        "POST",
        report.clone(),
    )
    .await;
    assert_eq!(status, 200);
    let rid = r1["id"].as_str().unwrap();
    assert_eq!(
        version_call(
            &r,
            &format!("{path}/reports/{rid}/acknowledge"),
            &auth,
            1,
            "POST",
            json!({"note":"Synthetic panel one reviewed"})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        version_call(
            &r,
            &format!("{path}/actions"),
            &auth,
            4,
            "POST",
            json!({"action":"complete","reason":"Missing second requested test"})
        )
        .await
        .0,
        409
    );
    report["request_id"] = json!(Uuid::new_v4());
    report["content"]["test_keys"] = json!(["panel2"]);
    report["content"]["observations"][0]["number"] = json!(1);
    assert_eq!(
        version_call(
            &r,
            &format!("{path}/reports"),
            &auth,
            4,
            "POST",
            report.clone()
        )
        .await
        .0,
        400,
        "conflicting typed values must fail"
    );
    report["content"]["observations"][0]
        .as_object_mut()
        .unwrap()
        .remove("number");
    let (status, r2) = version_call(&r, &format!("{path}/reports"), &auth, 4, "POST", report).await;
    assert_eq!(status, 200);
    let rid = r2["id"].as_str().unwrap();
    assert_eq!(
        version_call(
            &r,
            &format!("{path}/reports/{rid}/acknowledge"),
            &auth,
            1,
            "POST",
            json!({"note":"Synthetic panel two reviewed"})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        version_call(
            &r,
            &format!("{path}/reports/{rid}/acknowledge"),
            &auth,
            1,
            "POST",
            json!({"note":"Rewrite original acknowledgment"})
        )
        .await
        .0,
        409
    );
    assert_eq!(
        version_call(
            &r,
            &format!("{path}/actions"),
            &auth,
            5,
            "POST",
            json!({"action":"complete","reason":"All requested test coverage reviewed"})
        )
        .await
        .0,
        200
    );
    db.close().await;
}

async fn schedule_call(
    r: &Router,
    a: &Actor,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", bearer(a));
    if let Some(v) = version {
        req = req.header("if-match", format!("\"{v}\""));
    }
    let response = r
        .clone()
        .oneshot(
            req.header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let raw = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&raw).unwrap_or(Value::Null))
}

#[tokio::test]
async fn native_scheduling_conflicts_versions_roles_and_visit_handoff() {
    let (r, db, a, _) = setup().await;
    let (_,_,p)=json_call(&r,"POST","/api/v1/patients",Some(&bearer(&a)),None,json!({"mrn":"SCHEDULE-1","given_name":"Morgan","family_name":"Example","birth_date":"1990-01-01"})).await;
    let (_,_,p2)=json_call(&r,"POST","/api/v1/patients",Some(&bearer(&a)),None,json!({"mrn":"SCHEDULE-2","given_name":"Sam","family_name":"Example","birth_date":"1991-01-01"})).await;
    let mut desk = a.clone();
    desk.role = Role::FrontDesk;
    let mut read = a.clone();
    read.role = Role::ReadOnly;
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users (id,tenant_id,email,password_hash,role) VALUES ($1,$2,'provider2@example.test','synthetic-no-login','clinician')").bind(other).bind(a.tenant_id).execute(&db).await.unwrap();
    let booking = json!({"request_id":Uuid::new_v4(),"patient_id":p["id"],"clinician_id":a.sub,"starts_at":"2026-11-02T15:00:00Z","ends_at":"2026-11-02T15:30:00Z","title":"Annual review","category":"Office visit","facility":"Example clinic","room":"1","notes":"Synthetic","reason":"Patient requested"});
    assert_eq!(
        schedule_call(
            &r,
            &read,
            "POST",
            "/api/v1/appointments",
            booking.clone(),
            None
        )
        .await
        .0,
        403
    );
    let (code, appt) = schedule_call(
        &r,
        &desk,
        "POST",
        "/api/v1/appointments",
        booking.clone(),
        None,
    )
    .await;
    assert_eq!(code, 201, "{appt}");
    let (_, retry) = schedule_call(
        &r,
        &desk,
        "POST",
        "/api/v1/appointments",
        booking.clone(),
        None,
    )
    .await;
    assert_eq!(retry["id"], appt["id"]);
    let id = appt["id"].as_str().unwrap();
    let path = format!("/api/v1/appointments/{id}");
    let mut conflicting = booking.clone();
    conflicting["request_id"] = json!(Uuid::new_v4());
    conflicting["patient_id"] = p2["id"].clone();
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            "/api/v1/appointments",
            conflicting.clone(),
            None
        )
        .await
        .0,
        409
    ); // provider
    conflicting["clinician_id"] = json!(other);
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            "/api/v1/appointments",
            conflicting.clone(),
            None
        )
        .await
        .0,
        409
    ); // room
    conflicting["room"] = json!("2");
    conflicting["patient_id"] = p["id"].clone();
    assert_eq!(
        schedule_call(&r, &desk, "POST", "/api/v1/appointments", conflicting, None)
            .await
            .0,
        409
    ); // patient
    let edit = json!({"clinician_id":a.sub,"starts_at":"2026-11-02T16:00:00Z","ends_at":"2026-11-02T16:45:00Z","title":"Rescheduled review","category":"Follow-up","facility":"Example clinic","room":"1","notes":"New time","reason":"Patient preference"});
    assert_eq!(
        schedule_call(&r, &desk, "PUT", &path, edit.clone(), None)
            .await
            .0,
        428
    );
    assert_eq!(
        schedule_call(&r, &desk, "PUT", &path, edit.clone(), Some(1))
            .await
            .0,
        200
    );
    assert_eq!(
        schedule_call(&r, &desk, "PUT", &path, edit, Some(1))
            .await
            .0,
        409
    );
    let mut foreign = a.clone();
    foreign.tenant_id = Uuid::new_v4();
    assert_eq!(
        schedule_call(&r, &foreign, "GET", &path, Value::Null, None)
            .await
            .0,
        404
    );
    let (_, list) = schedule_call(
        &r,
        &read,
        "GET",
        "/api/v1/schedule?start=2026-11-02T00:00:00Z&end=2026-11-03T00:00:00Z",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(list["appointments"].as_array().unwrap().len(), 1);
    assert!(list["appointments"][0].get("request_digest").is_none());
    let b = json!({"request_id":Uuid::new_v4(),"clinician_id":a.sub,"starts_at":"2026-11-02T18:00:00Z","ends_at":"2026-11-02T19:00:00Z","label":"Administrative time"});
    let (code, block) = schedule_call(
        &r,
        &desk,
        "POST",
        "/api/v1/schedule/blocks",
        b.clone(),
        None,
    )
    .await;
    assert_eq!(code, 200, "{block}");
    let (_, retry) = schedule_call(&r, &desk, "POST", "/api/v1/schedule/blocks", b, None).await;
    assert_eq!(retry["id"], block["id"]);
    let mut blocked = booking.clone();
    blocked["request_id"] = json!(Uuid::new_v4());
    blocked["starts_at"] = json!("2026-11-02T18:00:00Z");
    blocked["ends_at"] = json!("2026-11-02T18:30:00Z");
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            "/api/v1/appointments",
            blocked.clone(),
            None
        )
        .await
        .0,
        409
    );
    let cancel = format!(
        "/api/v1/schedule/blocks/{}/cancel",
        block["id"].as_str().unwrap()
    );
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            &cancel,
            json!({"reason":"Time released"}),
            Some(1)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            &cancel,
            json!({"reason":"Retry"}),
            Some(1)
        )
        .await
        .0,
        409
    );
    assert_eq!(
        schedule_call(&r, &desk, "POST", "/api/v1/appointments", blocked, None)
            .await
            .0,
        201
    );
    let actions = format!("{path}/actions");
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            &actions,
            json!({"action":"no_show","reason":"Not arrived"}),
            Some(2)
        )
        .await
        .0,
        409
    ); // future
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            &actions,
            json!({"action":"check_in","reason":"Arrived"}),
            Some(2)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            "/api/v1/visits",
            json!({"appointment_id":id}),
            None
        )
        .await
        .0,
        403
    );
    let (code, v) = schedule_call(
        &r,
        &a,
        "POST",
        "/api/v1/visits",
        json!({"appointment_id":id}),
        None,
    )
    .await;
    assert_eq!(code, 201, "{v}");
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            &actions,
            json!({"action":"cancel","reason":"Too late"}),
            Some(4)
        )
        .await
        .0,
        409
    );
    let vid = v["id"].as_str().unwrap();
    assert_eq!(schedule_call(&r,&a,"PUT",&format!("/api/v1/visits/{vid}/note"),json!({"subjective":"Well","objective":"Exam","assessment":"Review","plan":"Follow-up"}),Some(1)).await.0,200);
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("/api/v1/visits/{vid}/sign"),
            Value::Null,
            Some(2)
        )
        .await
        .0,
        200
    );
    let (_, hist) = schedule_call(
        &r,
        &read,
        "GET",
        &format!("{path}/history"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(hist["items"].as_array().unwrap().len(), 5);
    assert_eq!(hist["items"][0]["snapshot"]["status"], "completed");
    // Two different requests race for one provider slot: exactly one can win.
    let mut one = booking.clone();
    one["request_id"] = json!(Uuid::new_v4());
    one["starts_at"] = json!("2026-11-04T15:00:00Z");
    one["ends_at"] = json!("2026-11-04T15:30:00Z");
    let mut two = one.clone();
    two["request_id"] = json!(Uuid::new_v4());
    two["patient_id"] = p2["id"].clone();
    let (x, y) = tokio::join!(
        schedule_call(&r, &desk, "POST", "/api/v1/appointments", one, None),
        schedule_call(&r, &desk, "POST", "/api/v1/appointments", two, None)
    );
    assert!((x.0 == 201 && y.0 == 409) || (x.0 == 409 && y.0 == 201));
    // Past no-shows and cancellations release capacity while keeping history.
    let mut past = booking.clone();
    past["request_id"] = json!(Uuid::new_v4());
    past["starts_at"] = json!("2026-01-05T15:00:00Z");
    past["ends_at"] = json!("2026-01-05T15:30:00Z");
    let (_, past_appt) = schedule_call(
        &r,
        &desk,
        "POST",
        "/api/v1/appointments",
        past.clone(),
        None,
    )
    .await;
    let past_actions = format!(
        "/api/v1/appointments/{}/actions",
        past_appt["id"].as_str().unwrap()
    );
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            &past_actions,
            json!({"action":"no_show","reason":"Did not arrive"}),
            Some(1)
        )
        .await
        .0,
        200
    );
    past["request_id"] = json!(Uuid::new_v4());
    let (_, replacement) = schedule_call(
        &r,
        &desk,
        "POST",
        "/api/v1/appointments",
        past.clone(),
        None,
    )
    .await;
    let replacement_actions = format!(
        "/api/v1/appointments/{}/actions",
        replacement["id"].as_str().unwrap()
    );
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            &replacement_actions,
            json!({"action":"cancel","reason":"Entered on wrong date"}),
            Some(1)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            &replacement_actions,
            json!({"action":"check_in","reason":"Cannot reopen"}),
            Some(2)
        )
        .await
        .0,
        409
    );
    let mut patient_actor = a.clone();
    patient_actor.role = Role::Patient;
    patient_actor.patient_id = Some(Uuid::parse_str(p["id"].as_str().unwrap()).unwrap());
    assert_eq!(
        schedule_call(
            &r,
            &patient_actor,
            "GET",
            "/api/v1/schedule?start=2026-11-02T00:00:00Z&end=2026-11-03T00:00:00Z",
            Value::Null,
            None
        )
        .await
        .0,
        403
    );
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "GET",
            "/api/v1/schedule?start=2026-01-01T00:00:00Z&end=2026-12-31T00:00:00Z",
            Value::Null,
            None
        )
        .await
        .0,
        400
    );
    past["request_id"] = json!(Uuid::new_v4());
    past["clinician_id"] = json!(Uuid::new_v4());
    assert_eq!(
        schedule_call(&r, &desk, "POST", "/api/v1/appointments", past, None)
            .await
            .0,
        400
    );
    // Cancellation atomically rolls back if its audit write fails.
    sqlx::query("CREATE FUNCTION fail_schedule_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='appointment.action' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_schedule_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_schedule_audit()").execute(&db).await.unwrap();
    let won = if x.0 == 201 { x.1 } else { y.1 };
    let wonpath = format!("/api/v1/appointments/{}", won["id"].as_str().unwrap());
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            &format!("{wonpath}/actions"),
            json!({"action":"cancel","reason":"Test rollback"}),
            Some(1)
        )
        .await
        .0,
        500
    );
    let (_, same) = schedule_call(&r, &a, "GET", &wonpath, Value::Null, None).await;
    assert_eq!(same["status"], "booked");
    assert_eq!(same["version"], 1);
}

#[tokio::test]
async fn appointment_migration_preserves_source_and_reconciles_explicitly() {
    let (r, db, a, _) = setup().await;
    let auth = bearer(&a);
    let (_,_,j)=json_call(&r,"POST","/api/v1/migrations",Some(&auth),None,json!({"source_instance":"synthetic-legacy","source_revision":"read-only-scheduling-fixture","consistency":"read_only_export","expected_counts":{"patient":1,"appointment":1},"limitations":["Custom status and recurrence require review"]})).await;
    let path = format!("/api/v1/migrations/{}", j["id"].as_str().unwrap());
    let raw = json!({"pc_eid":"94","pc_pid":"5","pc_aid":"7","pc_title":"Follow-up","pc_eventDate":"2026-11-06","pc_startTime":"09:00:00","pc_duration":"1800","pc_apptstatus":"custom","pc_recurrtype":"0","pc_room":"4"});
    let items = json!({"items":[{"kind":"patient","source_id":"source-patient","patient_source_id":null,"data":{"mrn":"SOURCE-SCHED","given_name":"Taylor","family_name":"Synthetic","birth_date":"1992-04-03"},"source_data":{"pid":"5"}},{"kind":"appointment","source_id":"source-patient/94","patient_source_id":"source-patient","data":raw,"source_data":raw}]});
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("{path}/items"),
            Some(&auth),
            None,
            items
        )
        .await
        .0,
        200
    );
    let (_, _, report) = json_call(
        &r,
        "POST",
        &format!("{path}/reconcile"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(report["ready_to_import"], true);
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("{path}/commit"),
            Some(&auth),
            None,
            json!({"digest":report["digest"]})
        )
        .await
        .0,
        200
    );
    let p: Uuid =
        sqlx::query_scalar("SELECT id FROM patients WHERE tenant_id=$1 AND mrn='SOURCE-SCHED'")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    let source: Uuid = sqlx::query_scalar(
        "SELECT id FROM historical_records WHERE tenant_id=$1 AND kind='appointment'",
    )
    .bind(a.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM appointments WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 0); // import never books automatically
    let mapping = format!("/api/v1/patients/{p}/history/{source}/appointment-mapping");
    let (_, m) = schedule_call(&r, &a, "GET", &mapping, Value::Null, None).await;
    assert_eq!(m["source"]["source_data"], raw);
    assert!(m["native_appointment_id"].is_null());
    let mut booking = json!({"request_id":Uuid::new_v4(),"source_history_id":source,"patient_id":p,"clinician_id":a.sub,"starts_at":"2026-11-06T15:00:00Z","ends_at":"2026-11-06T15:30:00Z","title":"Follow-up","category":"Office visit","facility":"Example clinic","room":"4","reason":"Staff verified status, timezone and provider"});
    let (status, b) = schedule_call(
        &r,
        &a,
        "POST",
        "/api/v1/appointments",
        booking.clone(),
        None,
    )
    .await;
    assert_eq!(status, 201, "{b}");
    assert_eq!(b["status"], "booked");
    assert_eq!(b["source_history_id"], json!(source));
    booking["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        schedule_call(&r, &a, "POST", "/api/v1/appointments", booking, None)
            .await
            .0,
        409
    );
    let (_, m) = schedule_call(&r, &a, "GET", &mapping, Value::Null, None).await;
    assert_eq!(m["native_appointment_id"], b["id"]);
    let mut foreign = a.clone();
    foreign.tenant_id = Uuid::new_v4();
    assert_eq!(
        schedule_call(&r, &foreign, "GET", &mapping, Value::Null, None)
            .await
            .0,
        404
    );
}

async fn billing_patient_visit(r: &Router, a: &Actor) -> (Value, Value) {
    let (_,p)=schedule_call(r,a,"POST","/api/v1/patients",json!({"mrn":format!("BILL-{}",Uuid::new_v4()),"given_name":"Quinn","family_name":"Synthetic","birth_date":"1988-04-03"}),None).await;
    let (_,appt)=schedule_call(r,a,"POST","/api/v1/appointments",json!({"patient_id":p["id"],"clinician_id":a.sub,"starts_at":"2026-10-01T15:00:00Z","ends_at":"2026-10-01T15:30:00Z"}),None).await;
    assert_eq!(
        schedule_call(
            r,
            a,
            "POST",
            &format!(
                "/api/v1/appointments/{}/check-in",
                appt["id"].as_str().unwrap()
            ),
            Value::Null,
            None
        )
        .await
        .0,
        200
    );
    let (status, v) = schedule_call(
        r,
        a,
        "POST",
        "/api/v1/visits",
        json!({"appointment_id":appt["id"]}),
        None,
    )
    .await;
    assert_eq!(status, 201, "{v}");
    (p, v)
}
fn coverage_content(payer: &Value) -> Value {
    json!({"payer_id":payer["id"],"priority":"primary","status":"active","member_id":"SYNTHETIC-POLICY-01","group_number":"SYN-GROUP","plan_name":"Synthetic plan","subscriber_name":"Quinn Synthetic","subscriber_birth_date":"1988-04-03","relationship":"self","effective_date":"2026-01-01","end_date":"2026-12-31","copay_cents":2500,"verification":"unverified","notes":"Synthetic fixture only"})
}
fn charge_content(visit: &Value, coverage: Option<&Value>) -> Value {
    json!({"visit_id":visit["id"],"coverage_id":coverage.map(|c|c["id"].clone()),"service_date":"2026-10-01","currency":"USD","lines":[{"code_system":"LOCAL","code":"SYN-VISIT","description":"Synthetic visit charge","modifiers":"","units":2,"amount_cents":12550,"diagnosis_codes":["SYN-DX"]}],"notes":"Synthetic billing test"})
}
async fn billing_payer(r: &Router, a: &Actor) -> Value {
    let (status,payer)=schedule_call(r,a,"POST","/api/v1/billing/payers",json!({"request_id":Uuid::new_v4(),"source_history_id":null,"content":{"name":"Synthetic Insurance","payer_code":"SYN-ONLY","phone":"","address":"Synthetic address","active":true},"reason":"Synthetic directory setup"}),None).await;
    assert_eq!(status, 200, "{payer}");
    payer
}

#[tokio::test]
async fn insurance_billing_ledger_is_exact_versioned_scoped_and_immutable() {
    let (r, db, a, _) = setup().await;
    let (patient, visit) = billing_patient_visit(&r, &a).await;
    let p = patient["id"].as_str().unwrap();
    let payer = billing_payer(&r, &a).await;
    let mut desk = a.clone();
    desk.role = Role::FrontDesk;
    let mut read = a.clone();
    read.role = Role::ReadOnly;
    let coverage = json!({"request_id":Uuid::new_v4(),"source_history_id":null,"content":coverage_content(&payer),"reason":"Reviewed policy document"});
    let coveragepath = format!("/api/v1/patients/{p}/coverages");
    assert_eq!(
        schedule_call(&r, &read, "POST", &coveragepath, coverage.clone(), None)
            .await
            .0,
        403
    );
    let (status, c) = schedule_call(&r, &desk, "POST", &coveragepath, coverage.clone(), None).await;
    assert_eq!(status, 200, "{c}");
    let (_, same) = schedule_call(&r, &desk, "POST", &coveragepath, coverage.clone(), None).await;
    assert_eq!(same["id"], c["id"]);
    let mut overlap = coverage.clone();
    overlap["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        schedule_call(&r, &desk, "POST", &coveragepath, overlap, None)
            .await
            .0,
        409
    );
    let path = format!("/api/v1/patients/{p}/billing/accounts");
    let new = json!({"request_id":Uuid::new_v4(),"source_history_id":null,"content":charge_content(&visit,Some(&c)),"reason":"Review native encounter charges"});
    let (status, b) = schedule_call(&r, &desk, "POST", &path, new.clone(), None).await;
    assert_eq!(status, 200, "{b}");
    assert_eq!(b["total_cents"], 12550); // already a line total; units are not multiplied again
    let (_, same) = schedule_call(&r, &desk, "POST", &path, new.clone(), None).await;
    assert_eq!(same["id"], b["id"]);
    let account = format!("{path}/{}", b["id"].as_str().unwrap());
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            &format!("{account}/actions"),
            json!({"action":"post","reason":"Ready"}),
            Some(1)
        )
        .await
        .0,
        409
    ); // visit still unsigned
    let vpath = format!("/api/v1/visits/{}", visit["id"].as_str().unwrap());
    assert_eq!(schedule_call(&r,&a,"PUT",&format!("{vpath}/note"),json!({"subjective":"Well","objective":"Exam","assessment":"Review","plan":"Follow up"}),Some(1)).await.0,200);
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{vpath}/sign"),
            Value::Null,
            Some(2)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "POST",
            &format!("{account}/actions"),
            json!({"action":"post","reason":"Signed visit and charges reviewed"}),
            None
        )
        .await
        .0,
        428
    );
    let (status, posted) = schedule_call(
        &r,
        &desk,
        "POST",
        &format!("{account}/actions"),
        json!({"action":"post","reason":"Signed visit and charges reviewed"}),
        Some(1),
    )
    .await;
    assert_eq!(status, 200, "{posted}");
    assert_eq!(
        posted["coverage_snapshot"]["coverage"]["content"]["member_id"],
        "SYNTHETIC-POLICY-01"
    );
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "PUT",
            &account,
            json!({"content":charge_content(&visit,Some(&c)),"reason":"Try editing posted"}),
            Some(2)
        )
        .await
        .0,
        409
    );
    let mut updated = c["content"].clone();
    updated["member_id"] = json!("NEW-SYNTHETIC-ID");
    assert_eq!(
        schedule_call(
            &r,
            &desk,
            "PUT",
            &format!("{coveragepath}/{}", c["id"].as_str().unwrap()),
            json!({"content":updated,"reason":"Replacement policy card"}),
            Some(1)
        )
        .await
        .0,
        200
    );
    let entrypath = format!("{account}/entries");
    let payment = json!({"request_id":Uuid::new_v4(),"kind":"payment","amount_cents":5000,"reverses_id":null,"party":"insurer","method":"external","reference":"SYN-EOB-1","occurred_on":"2026-10-02","reason":"Manually recorded synthetic remittance"});
    assert_eq!(
        schedule_call(&r, &read, "POST", &entrypath, payment.clone(), Some(2))
            .await
            .0,
        403
    );
    let (status, pay) =
        schedule_call(&r, &desk, "POST", &entrypath, payment.clone(), Some(2)).await;
    assert_eq!(status, 200, "{pay}");
    assert_eq!(
        pay["account"]["coverage_snapshot"]["coverage"]["content"]["member_id"],
        "SYNTHETIC-POLICY-01"
    ); // snapshot did not change
    let (_, same) = schedule_call(&r, &desk, "POST", &entrypath, payment.clone(), Some(2)).await;
    assert_eq!(same["id"], pay["id"]); // exact retry even with original version
    let mut changed = payment.clone();
    changed["amount_cents"] = json!(1);
    assert_eq!(
        schedule_call(&r, &desk, "POST", &entrypath, changed, Some(3))
            .await
            .0,
        409
    );
    let mut too_much = payment.clone();
    too_much["request_id"] = json!(Uuid::new_v4());
    too_much["amount_cents"] = json!(7551);
    assert_eq!(
        schedule_call(&r, &desk, "POST", &entrypath, too_much, Some(3))
            .await
            .0,
        409
    );
    let credit = json!({"request_id":Uuid::new_v4(),"kind":"adjustment_credit","amount_cents":2550,"reverses_id":null,"party":"insurer","method":"none","reference":"SYN-ADJ","occurred_on":"2026-10-02","reason":"Synthetic contractual adjustment"});
    assert_eq!(
        schedule_call(&r, &desk, "POST", &entrypath, credit.clone(), Some(2))
            .await
            .0,
        409
    );
    assert_eq!(
        schedule_call(&r, &desk, "POST", &entrypath, credit, Some(3))
            .await
            .0,
        200
    );
    let reversal = json!({"request_id":Uuid::new_v4(),"kind":"reversal","amount_cents":null,"reverses_id":pay["id"],"party":"other","method":"none","reference":"","occurred_on":"2026-10-03","reason":"Correct recorded payment"});
    assert_eq!(
        schedule_call(&r, &desk, "POST", &entrypath, reversal.clone(), Some(4))
            .await
            .0,
        200
    );
    let mut twice = reversal;
    twice["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        schedule_call(&r, &desk, "POST", &entrypath, twice, Some(5))
            .await
            .0,
        409
    );
    let (_, ws) = schedule_call(
        &r,
        &read,
        "GET",
        &format!("/api/v1/patients/{p}/billing"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(ws["entries"].as_array().unwrap().len(), 3);
    let sum: i64 = ws["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["effect_cents"].as_i64().unwrap())
        .sum();
    assert_eq!(sum, -2550);
    let (_, queue) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/worklist?status=posted",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(queue["items"][0]["balance_cents"], 10000);
    let mut foreign = a.clone();
    foreign.tenant_id = Uuid::new_v4();
    assert_eq!(
        schedule_call(
            &r,
            &foreign,
            "GET",
            &format!("/api/v1/patients/{p}/billing"),
            Value::Null,
            None
        )
        .await
        .0,
        404
    );
    let mut patient_actor = a.clone();
    patient_actor.role = Role::Patient;
    patient_actor.patient_id = Some(Uuid::parse_str(p).unwrap());
    assert_eq!(
        schedule_call(
            &r,
            &patient_actor,
            "GET",
            "/api/v1/billing/worklist",
            Value::Null,
            None
        )
        .await
        .0,
        403
    );
    assert!(
        sqlx::query("UPDATE billing_entries SET effect_cents=1 WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .execute(&db)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE billing_accounts SET total_cents=1 WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .execute(&db)
            .await
            .is_err()
    );
    // Audit failure must roll back the ledger entry, account version and revision together.
    sqlx::query("CREATE FUNCTION reject_billing_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='billing.account_change' THEN RAISE EXCEPTION 'synthetic test failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_billing_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_billing_audit()").execute(&db).await.unwrap();
    let mut after = payment.clone();
    after["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        schedule_call(&r, &desk, "POST", &entrypath, after, Some(5))
            .await
            .0,
        500
    );
    let (_, ws) = schedule_call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/patients/{p}/billing"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(ws["entries"].as_array().unwrap().len(), 3);
    assert_eq!(ws["accounts"][0]["version"], 5);
}

#[tokio::test]
async fn financial_source_history_requires_review_before_native_activation() {
    let (r, db, a, cookie) = setup().await;
    let auth = bearer(&a);
    let (_,_,job)=json_call(&r,"POST","/api/v1/migrations",Some(&auth),None,json!({"source_instance":"synthetic-legacy-finance","source_revision":"frozen-fixture","consistency":"read_only_export","expected_counts":{"patient":1,"insurance_company":1,"insurance":1,"billing":1,"transaction":1,"claim":1,"remittance":1,"x12_partner":1,"edi_acknowledgment":1},"limitations":["Synthetic source evidence only"]})).await;
    let path = format!("/api/v1/migrations/{}", job["id"].as_str().unwrap());
    let policy = json!({"id":"14","pid":"1","provider":"7","type":"primary","policy_number":"SYN-POL","subscriber_fname":"Quinn","subscriber_lname":"Synthetic","date":"2026-01-01"});
    let charges = json!({"source_encounter_id":"55","charge_lines":[{"id":"90","pid":"1","encounter":"55","fee":"125.50","units":"2","code_type":"LOCAL","code":"SYN","code_text":"Synthetic visit"}]});
    let (denied,_,_)=json_call(&r,"POST",&format!("{path}/items"),Some(&auth),None,json!({"items":[{"kind":"x12_partner","source_id":"unsafe-partner","patient_source_id":null,"data":{},"source_data":{"partner":{"id":"unsafe","x12_sftp_pass":"synthetic-must-not-import"}}}]})).await;
    assert_eq!(denied, 400);
    let (status,_,staged)=json_call(&r,"POST",&format!("{path}/items"),Some(&auth),None,json!({"items":[
 {"kind":"patient","source_id":"p1","patient_source_id":null,"data":{"mrn":"SYN-FIN-001","given_name":"Quinn","family_name":"Synthetic","birth_date":"1988-04-03"},"source_data":{"pid":"1"}},
 {"kind":"insurance_company","source_id":"payer/7","patient_source_id":null,"data":{"name":"Source payer"},"source_data":{"id":"7","name":"Source payer"}},
 {"kind":"insurance","source_id":"coverage/14","patient_source_id":"p1","data":policy,"source_data":policy},
 {"kind":"billing","source_id":"billing/55","patient_source_id":"p1","data":{"title":"Source charge account"},"source_data":charges},
 {"kind":"transaction","source_id":"ar_activity/9","patient_source_id":"p1","data":{"title":"Source payment evidence"},"source_data":{"pid":"1","encounter":"55","pay_amount":"25.00","session_id":"4"}},
 {"kind":"claim","source_id":"claims/1/55/2","patient_source_id":"p1","data":{"title":"Historical submitted claim"},"source_data":{"claim":{"patient_id":"1","encounter_id":"55","version":"2","status":"2","bill_process":"2","submitted_claim":"Synthetic original packet"}}},
 {"kind":"remittance","source_id":"era/SYN-OLD","patient_source_id":null,"data":{"title":"Historical ERA"},"source_data":{"format":"x12_835","original_text":"ST*835*SYN~SE*2*SYN~"}},
 {"kind":"x12_partner","source_id":"x12_partners/7","patient_source_id":null,"data":{"title":"Source partner"},"source_data":{"partner":{"id":"7","name":"Synthetic Historical Partner","x12_sender_id":"SOURCE-SENDER","x12_receiver_id":"SOURCE-RECEIVER","x12_isa15":"P"}}},
 {"kind":"edi_acknowledgment","source_id":"ack/SYN","patient_source_id":null,"data":{"title":"Historical 999"},"source_data":{"format":"x12_999","original_text":ack999("1",true)}}
 ]})).await;
    assert_eq!(status, 200, "{staged}");
    let (_, _, report) = json_call(
        &r,
        "POST",
        &format!("{path}/reconcile"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(report["ready_to_import"], true, "{report}");
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("{path}/commit"),
            Some(&auth),
            None,
            json!({"digest":report["digest"]})
        )
        .await
        .0,
        200
    );
    let p: Uuid =
        sqlx::query_scalar("SELECT id FROM patients WHERE tenant_id=$1 AND mrn='SYN-FIN-001'")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM billing_accounts WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let sources: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id,kind FROM historical_records WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_all(&db)
            .await
            .unwrap();
    let get = |kind: &str| sources.iter().find(|s| s.1 == kind).unwrap().0;
    let mut payer_request = json!({"request_id":Uuid::new_v4(),"source_history_id":get("insurance_company"),"content":{"name":"Source payer","payer_code":"SOURCE-7","phone":"","address":"","active":true},"reason":"Source payer identity reviewed"});
    let (status, payer) = schedule_call(
        &r,
        &a,
        "POST",
        "/api/v1/billing/payers",
        payer_request.clone(),
        None,
    )
    .await;
    assert_eq!(status, 200, "{payer}");
    payer_request["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            "/api/v1/billing/payers",
            payer_request,
            None
        )
        .await
        .0,
        409
    );
    let cov = json!({"request_id":Uuid::new_v4(),"source_history_id":get("insurance"),"content":coverage_content(&payer),"reason":"Source subscriber, date and priority verified"});
    let (status, c) = schedule_call(
        &r,
        &a,
        "POST",
        &format!("/api/v1/patients/{p}/coverages"),
        cov,
        None,
    )
    .await;
    assert_eq!(status, 200, "{c}");
    let mut content = charge_content(&json!({"id":null}), Some(&c));
    content["lines"][0]["amount_cents"] = json!(12550);
    content["lines"][0]["code_system"] = json!("CPT");
    content["lines"][0]["code"] = json!("99213");
    let create = json!({"request_id":Uuid::new_v4(),"source_history_id":get("billing"),"content":content,"reason":"Staff verified source charge total, prior ledger and source encounter"});
    let (status, b) = schedule_call(
        &r,
        &a,
        "POST",
        &format!("/api/v1/patients/{p}/billing/accounts"),
        create.clone(),
        None,
    )
    .await;
    assert_eq!(status, 200, "{b}");
    assert_eq!(b["status"], "draft");
    let (_, mapping) = schedule_call(
        &r,
        &a,
        "GET",
        &format!(
            "/api/v1/patients/{p}/history/{}/billing-mapping",
            get("billing")
        ),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(mapping["source_data"], charges);
    assert_eq!(mapping["native_id"], b["id"]);
    let (_, ws) = schedule_call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/patients/{p}/billing"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(ws["entries"].as_array().unwrap().len(), 0);
    // Billing is an explicit OAuth permission, independent of existing clinical grants.
    let (_,_,client)=json_call(&r,"POST","/api/v1/oauth/clients",Some(&auth),None,json!({"name":"SunCharts test client","redirect_uri":"https://my.suncharts.app/oauth/ehr/callback","scope":"clinical.read billing.read billing.write"})).await;
    let (code, verifier, basic) = grant(&r, &cookie, &client, "clinical.read").await;
    let (status, tokens) = form(
        &r,
        "/oauth/token",
        &basic,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("code_verifier", &verifier),
            (
                "redirect_uri",
                "https://my.suncharts.app/oauth/ehr/callback",
            ),
        ],
    )
    .await;
    assert_eq!(status, 200);
    let clinical = tokens["access_token"].as_str().unwrap();
    assert_eq!(
        json_call(
            &r,
            "GET",
            "/api/v1/billing/worklist",
            Some(&format!("Bearer {clinical}")),
            None,
            Value::Null
        )
        .await
        .0,
        403
    );
    let (code, verifier, basic) = grant(&r, &cookie, &client, "billing.read").await;
    let (status, tokens) = form(
        &r,
        "/oauth/token",
        &basic,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("code_verifier", &verifier),
            (
                "redirect_uri",
                "https://my.suncharts.app/oauth/ehr/callback",
            ),
        ],
    )
    .await;
    assert_eq!(status, 200);
    let finance = tokens["access_token"].as_str().unwrap();
    let (code, verifier, basic) = grant(&r, &cookie, &client, "billing.write").await;
    let (status, write_tokens) = form(
        &r,
        "/oauth/token",
        &basic,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("code_verifier", &verifier),
            (
                "redirect_uri",
                "https://my.suncharts.app/oauth/ehr/callback",
            ),
        ],
    )
    .await;
    assert_eq!(status, 200);
    let financial_write = format!("Bearer {}", write_tokens["access_token"].as_str().unwrap());
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("/api/v1/patients/{p}/billing/accounts"),
            Some(&financial_write),
            None,
            create.clone()
        )
        .await
        .0,
        200
    );
    assert_eq!(
        json_call(
            &r,
            "GET",
            "/api/v1/billing/worklist",
            Some(&financial_write),
            None,
            Value::Null
        )
        .await
        .0,
        403
    );
    let (_, sources) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/payer-sources",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(sources["items"].as_array().unwrap().len(), 1);
    assert_eq!(sources["items"][0]["native_id"], payer["id"]);

    assert_eq!(
        json_call(
            &r,
            "GET",
            "/api/v1/billing/worklist",
            Some(&format!("Bearer {finance}")),
            None,
            Value::Null
        )
        .await
        .0,
        200
    );
    assert_eq!(
        json_call(
            &r,
            "POST",
            &format!("/api/v1/patients/{p}/billing/accounts"),
            Some(&format!("Bearer {finance}")),
            None,
            create
        )
        .await
        .0,
        403
    );

    // Source claim and global ERA stay historical until explicitly reconciled.
    for endpoint in ["/api/v1/billing/claims", "/api/v1/billing/remittances"] {
        assert_eq!(
            json_call(
                &r,
                "GET",
                endpoint,
                Some(&format!("Bearer {clinical}")),
                None,
                Value::Null
            )
            .await
            .0,
            403
        );
        assert_eq!(
            json_call(
                &r,
                "GET",
                endpoint,
                Some(&format!("Bearer {finance}")),
                None,
                Value::Null
            )
            .await
            .0,
            200
        );
    }
    let mapping_path = format!(
        "/api/v1/patients/{p}/history/{}/claim-mapping",
        get("claim")
    );
    assert_eq!(
        json_call(
            &r,
            "GET",
            &mapping_path,
            Some(&format!("Bearer {clinical}")),
            None,
            Value::Null
        )
        .await
        .0,
        403
    );
    let (_, mapping) = schedule_call(&r, &a, "GET", &mapping_path, Value::Null, None).await;
    assert_eq!(mapping["source_data"]["claim"]["status"], "2");
    assert!(mapping["native_id"].is_null());
    let bp = format!(
        "/api/v1/patients/{p}/billing/accounts/{}",
        b["id"].as_str().unwrap()
    );
    let (s, posted) = schedule_call(
        &r,
        &a,
        "POST",
        &format!("{bp}/actions"),
        json!({"action":"post","reason":"Reviewed source ledger before activation"}),
        Some(1),
    )
    .await;
    assert_eq!(s, 200, "{posted}");
    let(s,claim)=schedule_call(&r,&a,"POST",&format!("{bp}/claims"),json!({"request_id":Uuid::new_v4(),"source_history_id":get("claim"),"frequency":"original","content":claim_content(),"reason":"Reviewed source claim control and account"}),Some(2)).await;
    assert_eq!(s, 200, "{claim}");
    assert_eq!(claim["status"], "draft");
    let (_, mapping) = schedule_call(&r, &a, "GET", &mapping_path, Value::Null, None).await;
    assert_eq!(mapping["native_id"], claim["id"]);
    let (_, source) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/remittance-sources",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(source["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        source["items"][0]["source_data"]["original_text"],
        "ST*835*SYN~SE*2*SYN~"
    );
    let(s,era)=schedule_call(&r,&a,"POST","/api/v1/billing/remittances",json!({"request_id":Uuid::new_v4(),"payer_id":payer["id"],"format":"normalized","document":era_document(&claim),"source_history_id":get("remittance"),"reason":"Normalized source requires independent identity and balance review"}),None).await;
    assert_eq!(s, 200, "{era}");
    assert_eq!(era["status"], "staged");
    let (_, source) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/remittance-sources",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(source["items"][0]["native_id"], era["id"]);

    let (_, sources) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/clearinghouse-sources",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(sources["items"].as_array().unwrap().len(), 2);
    let (status, partners) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/clearinghouses",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(partners["items"], json!([]));
    let(s,partner)=schedule_call(&r,&a,"POST","/api/v1/billing/clearinghouses",json!({"request_id":Uuid::new_v4(),"source_history_id":get("x12_partner"),"content":edi_partner_content(),"reason":"Independently reviewed source IDs; retained test usage"}),None).await;
    assert_eq!(s, 200, "{partner}");
    assert_eq!(partner["content"]["usage"], "T");
    let cp = format!("/api/v1/billing/claims/{}", claim["id"].as_str().unwrap());
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{cp}/actions"),
            json!({"action":"ready","reason":"Reviewed source-derived native packet"}),
            Some(1)
        )
        .await
        .0,
        200
    );
    let(s,submission)=schedule_call(&r,&a,"POST",&format!("{cp}/837p"),json!({"request_id":Uuid::new_v4(),"partner_id":partner["id"],"partner_version":1,"details":edi_details(),"reason":"Reconciled source claim to native test file"}),Some(2)).await;
    assert_eq!(s, 200, "{submission}");
    let sp = format!(
        "/api/v1/billing/submissions/{}",
        submission["id"].as_str().unwrap()
    );
    assert_eq!(schedule_call(&r,&a,"POST",&format!("{sp}/actions"),json!({"action":"record_delivery","reference":"SYN-PORTAL","event_date":"2026-10-01","claim_version":2,"reason":"Verified synthetic test upload evidence"}),Some(1)).await.0,200);
    let(s,ack)=schedule_call(&r,&a,"POST",&format!("{sp}/acknowledgments"),json!({"format":"x12_999","original_text":ack999("1",true),"source_history_id":get("edi_acknowledgment"),"reason":"Reviewed exact source group and transaction identity"}),Some(2)).await;
    assert_eq!(s, 200, "{ack}");
    assert_eq!(ack["submission"]["technical_status"], "accepted");
    assert_eq!(ack["submission"]["payer_outcome"], "pending");
    let (_, sources) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/clearinghouse-sources",
        Value::Null,
        None,
    )
    .await;
    assert!(sources["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|i| !i["native_id"].is_null()));
}

#[tokio::test]
async fn concurrent_billing_payments_cannot_overpay() {
    let (r, db, a, _) = setup().await;
    let (patient, visit) = billing_patient_visit(&r, &a).await;
    let p = patient["id"].as_str().unwrap();
    let vpath = format!("/api/v1/visits/{}", visit["id"].as_str().unwrap());
    schedule_call(
        &r,
        &a,
        "PUT",
        &format!("{vpath}/note"),
        json!({"subjective":"Well","objective":"Exam","assessment":"Review","plan":"Follow up"}),
        Some(1),
    )
    .await;
    schedule_call(
        &r,
        &a,
        "POST",
        &format!("{vpath}/sign"),
        Value::Null,
        Some(2),
    )
    .await;
    let (_,b)=schedule_call(&r,&a,"POST",&format!("/api/v1/patients/{p}/billing/accounts"),json!({"request_id":Uuid::new_v4(),"source_history_id":null,"content":charge_content(&visit,None),"reason":"Synthetic concurrent test"}),None).await;
    let path = format!(
        "/api/v1/patients/{p}/billing/accounts/{}",
        b["id"].as_str().unwrap()
    );
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{path}/actions"),
            json!({"action":"post","reason":"Reviewed"}),
            Some(1)
        )
        .await
        .0,
        200
    );
    let one = json!({"request_id":Uuid::new_v4(),"kind":"payment","amount_cents":10000,"reverses_id":null,"party":"patient","method":"external","reference":"SYN-RECEIPT","occurred_on":"2026-10-02","reason":"Concurrent record"});
    let mut two = one.clone();
    two["request_id"] = json!(Uuid::new_v4());
    let entries = format!("{path}/entries");
    let (x, y) = tokio::join!(
        schedule_call(&r, &a, "POST", &entries, one, Some(2)),
        schedule_call(&r, &a, "POST", &entries, two, Some(2))
    );
    assert!((x.0 == 200 && y.0 == 409) || (x.0 == 409 && y.0 == 200));
    let balance:i64=sqlx::query_scalar("SELECT b.total_cents+coalesce(sum(e.effect_cents),0)::bigint FROM billing_accounts b LEFT JOIN billing_entries e ON e.tenant_id=b.tenant_id AND e.account_id=b.id WHERE b.tenant_id=$1 GROUP BY b.total_cents").bind(a.tenant_id).fetch_one(&db).await.unwrap();
    assert_eq!(balance, 2550);
}

fn claim_content() -> Value {
    json!({"billing_provider_name":"Synthetic Clinic","billing_npi":"1234567893","tax_id":"000000001","billing_address":"1 Synthetic Way","rendering_npi":"1234567893","patient_address":"2 Synthetic Way","subscriber_address":"2 Synthetic Way","subscriber_birth_date":"1988-04-03","place_of_service":"11","diagnosis_codes":["Z00.00"],"line_diagnosis_pointers":[[1]],"external_control_number":"","notes":"Synthetic test only"})
}
async fn claim_fixture(r: &Router, a: &Actor) -> (Value, Value, Value, Value) {
    claim_fixture_kind(r, a, false).await
}
async fn claim_fixture_kind(
    r: &Router,
    a: &Actor,
    professional: bool,
) -> (Value, Value, Value, Value) {
    let (p, v) = billing_patient_visit(r, a).await;
    let payer = billing_payer(r, a).await;
    let base = format!("/api/v1/patients/{}", p["id"].as_str().unwrap());
    let (s,c)=schedule_call(r,a,"POST",&format!("{base}/coverages"),json!({"request_id":Uuid::new_v4(),"content":coverage_content(&payer),"reason":"Synthetic coverage"}),None).await;
    assert_eq!(s, 200, "{c}");
    let mut charges = charge_content(&v, Some(&c));
    if professional {
        charges["lines"][0]["code_system"] = json!("CPT");
        charges["lines"][0]["code"] = json!("99213");
    }
    let (s, b) = schedule_call(
        r,
        a,
        "POST",
        &format!("{base}/billing/accounts"),
        json!({"request_id":Uuid::new_v4(),"content":charges,"reason":"Synthetic charges"}),
        None,
    )
    .await;
    assert_eq!(s, 200, "{b}");
    let vp = format!("/api/v1/visits/{}", v["id"].as_str().unwrap());
    assert_eq!(schedule_call(r,a,"PUT",&format!("{vp}/note"),json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"}),Some(1)).await.0,200);
    assert_eq!(
        schedule_call(r, a, "POST", &format!("{vp}/sign"), Value::Null, Some(2))
            .await
            .0,
        200
    );
    let bp = format!("{base}/billing/accounts/{}", b["id"].as_str().unwrap());
    let (s, b) = schedule_call(
        r,
        a,
        "POST",
        &format!("{bp}/actions"),
        json!({"action":"post","reason":"Reviewed"}),
        Some(1),
    )
    .await;
    assert_eq!(s, 200, "{b}");
    let (s,c)=schedule_call(r,a,"POST",&format!("{bp}/claims"),json!({"request_id":Uuid::new_v4(),"frequency":"original","content":claim_content(),"reason":"Reviewed packet"}),Some(2)).await;
    assert_eq!(s, 200, "{c}");
    (p, payer, b, c)
}
fn era_document(c: &Value) -> Value {
    json!({"payer_code":"SYN-ONLY","trace":"SYN-TRACE-ERA-01","payment_date":"2026-10-01","total_paid_cents":8000,"currency":"USD","claims":[{"control_number":c["control_number"],"payer_control_number":"SYN-PCN","status":"1","patient_name":"Quinn Synthetic","charged_cents":12550,"paid_cents":8000,"patient_responsibility_cents":2000,"adjustments":[{"group":"CO","reason_code":"45","amount_cents":2550,"service_index":null},{"group":"PR","reason_code":"1","amount_cents":2000,"service_index":null}],"services":[]}]})
}
#[tokio::test]
async fn claims_era_posting_and_reversal_are_scoped_atomic_and_exact() {
    let (r, db, a, _) = setup().await;
    let (p, payer, b, c) = claim_fixture(&r, &a).await;
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    let (_, detail) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(detail["preflight_issues"], json!([]), "{detail}");
    assert_eq!(
        schedule_call(&r, &a, "GET", &format!("{cp}/packet"), Value::Null, None)
            .await
            .0,
        409
    );
    for (version, action) in [
        (1, "ready"),
        (2, "record_submission"),
        (3, "record_acceptance"),
    ] {
        let body = json!({"action":action,"reason":"Verified synthetic external evidence","reference":"SYN-ACK-01","event_date":"2026-10-01","payer_control_number":"SYN-PCN"});
        let (s, v) = schedule_call(
            &r,
            &a,
            "POST",
            &format!("{cp}/actions"),
            body,
            Some(version),
        )
        .await;
        assert_eq!(s, 200, "{v}");
        if version == 1 {
            let (s, packet) =
                schedule_call(&r, &a, "GET", &format!("{cp}/packet"), Value::Null, None).await;
            assert_eq!(s, 200, "{packet}");
            assert_eq!(packet["not_x12_837"], true);
            let (_, d) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
            assert_eq!(d["claim"]["status"], "ready");
        }
    }
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "PUT",
            &cp,
            json!({"content":claim_content(),"reason":"Try changing frozen packet"}),
            Some(4)
        )
        .await
        .0,
        409
    );
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        schedule_call(&r, &other, "GET", &cp, Value::Null, None)
            .await
            .0,
        404
    );
    let mut read = a.clone();
    read.role = Role::ReadOnly;
    assert_eq!(
        schedule_call(
            &r,
            &read,
            "POST",
            &format!("{cp}/actions"),
            json!({"action":"record_rejection","reason":"Try unauthorized"}),
            Some(4)
        )
        .await
        .0,
        403
    );
    let input = json!({"request_id":Uuid::new_v4(),"payer_id":payer["id"],"format":"normalized","document":era_document(&c),"reason":"Synthetic payer evidence"});
    let (s, era) = schedule_call(
        &r,
        &a,
        "POST",
        "/api/v1/billing/remittances",
        input.clone(),
        None,
    )
    .await;
    assert_eq!(s, 200, "{era}");
    let (_, same) = schedule_call(
        &r,
        &a,
        "POST",
        "/api/v1/billing/remittances",
        input.clone(),
        None,
    )
    .await;
    assert_eq!(same["id"], era["id"]);
    let mut duplicate = input.clone();
    duplicate["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            "/api/v1/billing/remittances",
            duplicate,
            None
        )
        .await
        .0,
        409
    );
    let ep = format!(
        "/api/v1/billing/remittances/{}",
        era["id"].as_str().unwrap()
    );
    let action = json!({"action":"post","reason":"Reviewed matches and contractual adjustment"});
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{ep}/actions"),
            action.clone(),
            Some(1)
        )
        .await
        .0,
        409
    );
    let mut matches = json!({"matches":[{"row_index":0,"claim_id":c["id"],"claim_version":4,"account_version":2,"writeoff_adjustments":[1]}],"reason":"Review"});
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "PUT",
            &format!("{ep}/matches"),
            matches.clone(),
            Some(1)
        )
        .await
        .0,
        400
    ); // PR cannot be a write-off
    matches["matches"][0]["writeoff_adjustments"] = json!([0]);
    let (s, review) = schedule_call(
        &r,
        &a,
        "PUT",
        &format!("{ep}/matches"),
        matches.clone(),
        Some(1),
    )
    .await;
    assert_eq!(s, 200, "{review}");
    assert_eq!(review["issues"], json!([]));
    sqlx::raw_sql("CREATE FUNCTION reject_era_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='remittance.change' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_era_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_era_audit();").execute(&db).await.unwrap();
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{ep}/actions"),
            action.clone(),
            Some(2)
        )
        .await
        .0,
        500
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM billing_entries")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let (_, d) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(d["claim"]["status"], "accepted");
    sqlx::query("DROP TRIGGER reject_era_audit ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    let concurrent_path = format!("{ep}/actions");
    let (one, two) = tokio::join!(
        schedule_call(&r, &a, "POST", &concurrent_path, action.clone(), Some(2)),
        schedule_call(&r, &a, "POST", &concurrent_path, action, Some(2))
    );
    assert!(
        (one.0 == 200 && two.0 == 409) || (one.0 == 409 && two.0 == 200),
        "{one:?} {two:?}"
    );
    let bp = format!("/api/v1/patients/{}/billing", p["id"].as_str().unwrap());
    let (_, w) = schedule_call(&r, &a, "GET", &bp, Value::Null, None).await;
    assert_eq!(w["entries"].as_array().unwrap().len(), 2);
    let effect: i64 = w["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["effect_cents"].as_i64().unwrap())
        .sum();
    assert_eq!(12550 + effect, 2000);
    let entry = &w["entries"][0];
    let manual = json!({"request_id":Uuid::new_v4(),"kind":"reversal","amount_cents":null,"reverses_id":entry["id"],"party":"other","method":"none","reference":"","occurred_on":"2026-10-01","reason":"Try individual ERA reversal"});
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{bp}/accounts/{}/entries", b["id"].as_str().unwrap()),
            manual,
            Some(3)
        )
        .await
        .0,
        409
    );
    let (_, d) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(d["claim"]["status"], "adjudicated");
    let child_path = format!(
        "/api/v1/patients/{}/billing/accounts/{}/claims",
        p["id"].as_str().unwrap(),
        b["id"].as_str().unwrap()
    );
    let(s,child)=schedule_call(&r,&a,"POST",&child_path,json!({"request_id":Uuid::new_v4(),"frequency":"replacement","parent_id":c["id"],"content":claim_content(),"reason":"Synthetic downstream replacement"}),Some(3)).await;
    assert_eq!(s, 200, "{child}");
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{ep}/actions"),
            json!({"action":"reverse","reason":"Must resolve downstream claim first"}),
            Some(3)
        )
        .await
        .0,
        409
    );
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!(
                "/api/v1/billing/claims/{}/actions",
                child["id"].as_str().unwrap()
            ),
            json!({"action":"void_draft","reason":"Discard synthetic downstream draft"}),
            Some(1)
        )
        .await
        .0,
        200
    );
    let (s, rev) = schedule_call(
        &r,
        &a,
        "POST",
        &format!("{ep}/actions"),
        json!({"action":"reverse","reason":"Correct synthetic posting"}),
        Some(3),
    )
    .await;
    assert_eq!(s, 200, "{rev}");
    assert_eq!(rev["status"], "reversed");
    let (_, w) = schedule_call(&r, &a, "GET", &bp, Value::Null, None).await;
    assert_eq!(w["entries"].as_array().unwrap().len(), 4);
    assert_eq!(
        w["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["effect_cents"].as_i64().unwrap())
            .sum::<i64>(),
        0
    );
    let (_, d) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(d["claim"]["status"], "accepted");
    assert_eq!(d["claim"]["version"], 6);
    assert!(
        sqlx::query("UPDATE era_remittances SET document='{}'::jsonb")
            .execute(&db)
            .await
            .is_err()
    );
    assert!(sqlx::query("DELETE FROM era_postings")
        .execute(&db)
        .await
        .is_err());
}

#[tokio::test]
async fn era_unbalanced_wrong_identity_and_stale_reviews_cannot_post() {
    let (r, _, a, _) = setup().await;
    let (_, payer, _, c) = claim_fixture(&r, &a).await;
    let cp = format!(
        "/api/v1/billing/claims/{}/actions",
        c["id"].as_str().unwrap()
    );
    for (v, action) in [(1, "ready"), (2, "record_submission")] {
        let(s,d)=schedule_call(&r,&a,"POST",&cp,json!({"action":action,"reason":"Reviewed","reference":"SYN-REF","event_date":"2026-10-01"}),Some(v)).await;
        assert_eq!(s, 200, "{d}");
    }
    let mut doc = era_document(&c);
    doc["claims"][0]["paid_cents"] = json!(7999);
    doc["claims"][0]["control_number"] = json!("WRONG-CONTROL");
    doc["payer_code"] = json!("WRONG-PAYER");
    let(s,era)=schedule_call(&r,&a,"POST","/api/v1/billing/remittances",json!({"request_id":Uuid::new_v4(),"payer_id":payer["id"],"format":"normalized","document":doc,"reason":"Source evidence to review"}),None).await;
    assert_eq!(s, 200, "{era}");
    let ep = format!(
        "/api/v1/billing/remittances/{}",
        era["id"].as_str().unwrap()
    );
    let(s,d)=schedule_call(&r,&a,"PUT",&format!("{ep}/matches"),json!({"matches":[{"row_index":0,"claim_id":c["id"],"claim_version":2,"account_version":1,"writeoff_adjustments":[]}],"reason":"Review problematic evidence"}),Some(1)).await;
    assert_eq!(s, 200, "{d}");
    assert!(d["issues"].as_array().unwrap().len() >= 4);
    assert_eq!(d["remittance"]["status"], "staged");
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{ep}/actions"),
            json!({"action":"post","reason":"Must reject"}),
            Some(2)
        )
        .await
        .0,
        409
    );
    let mut valid = era_document(&c);
    valid["trace"] = json!("SYN-STALE-REVIEW");
    let(s,era)=schedule_call(&r,&a,"POST","/api/v1/billing/remittances",json!({"request_id":Uuid::new_v4(),"payer_id":payer["id"],"format":"normalized","document":valid,"reason":"Synthetic balanced document"}),None).await;
    assert_eq!(s, 200, "{era}");
    let ep = format!(
        "/api/v1/billing/remittances/{}",
        era["id"].as_str().unwrap()
    );
    let(s,d)=schedule_call(&r,&a,"PUT",&format!("{ep}/matches"),json!({"matches":[{"row_index":0,"claim_id":c["id"],"claim_version":3,"account_version":2,"writeoff_adjustments":[0]}],"reason":"Valid current review"}),Some(1)).await;
    assert_eq!(s, 200, "{d}");
    assert_eq!(d["issues"], json!([]));
    let entry_path = format!(
        "/api/v1/patients/{}/billing/accounts/{}/entries",
        c["patient_id"].as_str().unwrap(),
        c["account_id"].as_str().unwrap()
    );
    let(s,d)=schedule_call(&r,&a,"POST",&entry_path,json!({"request_id":Uuid::new_v4(),"kind":"payment","amount_cents":100,"party":"patient","method":"external","reference":"SYN-RECEIPT","occurred_on":"2026-10-01","reason":"Independent ledger activity after ERA review"}),Some(2)).await;
    assert_eq!(s, 200, "{d}");
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{ep}/actions"),
            json!({"action":"post","reason":"Stale review must not post"}),
            Some(2)
        )
        .await
        .0,
        409
    );
}

#[tokio::test]
async fn rejected_claim_can_be_corrected_without_fabricating_a_payer_control() {
    let (r, _, a, _) = setup().await;
    let (p, _, b, c) = claim_fixture(&r, &a).await;
    let cp = format!(
        "/api/v1/billing/claims/{}/actions",
        c["id"].as_str().unwrap()
    );
    for (v, action) in [
        (1, "ready"),
        (2, "record_submission"),
        (3, "record_rejection"),
    ] {
        let(s,d)=schedule_call(&r,&a,"POST",&cp,json!({"action":action,"reason":"Synthetic pre-adjudication rejection evidence","reference":"SYN-REJECT","event_date":"2026-10-01"}),Some(v)).await;
        assert_eq!(s, 200, "{d}");
    }
    let bp = format!(
        "/api/v1/patients/{}/billing/accounts/{}/claims",
        p["id"].as_str().unwrap(),
        b["id"].as_str().unwrap()
    );
    let mut request = json!({"request_id":Uuid::new_v4(),"parent_id":c["id"],"frequency":"replacement","content":claim_content(),"reason":"Correct rejected source packet"});
    assert_eq!(
        schedule_call(&r, &a, "POST", &bp, request.clone(), Some(2))
            .await
            .0,
        409
    );
    request["frequency"] = json!("original");
    let (s, corrected) = schedule_call(&r, &a, "POST", &bp, request.clone(), Some(2)).await;
    assert_eq!(s, 200, "{corrected}");
    assert_eq!(corrected["parent_id"], c["id"]);
    assert_eq!(corrected["status"], "draft");
    assert_eq!(corrected["payer_control_number"], "");
    assert_ne!(corrected["control_number"], c["control_number"]);
    request["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        schedule_call(&r, &a, "POST", &bp, request, Some(2)).await.0,
        409
    );
}

fn edi_partner_content() -> Value {
    json!({"name":"Synthetic Clearinghouse","active":true,"sender_qualifier":"ZZ","sender_id":"SYN-SENDER","receiver_qualifier":"ZZ","receiver_id":"SYN-RECEIVER","application_sender":"SYN-SENDER","application_receiver":"SYN-RECEIVER","submitter_name":"Synthetic Clinic","submitter_id":"SYN-SUBMIT","receiver_name":"Synthetic Clearinghouse","receiver_identifier":"SYN-RECEIVER","contact_name":"Synthetic Operator","contact_phone":"2025550100","usage":"T","guide_reference":"Synthetic test enrollment and companion guide review"})
}
fn edi_details() -> Value {
    let address = json!({"line1":"1 Synthetic Way","line2":"","city":"Chicago","state":"IL","postal_code":"60601"});
    json!({"billing_address":address,"subscriber_address":address,"patient_address":address,"payer_address":address,"subscriber_given_name":"Quinn","subscriber_family_name":"Synthetic","patient_sex":"U","subscriber_sex":"U","rendering_given_name":"Test","rendering_family_name":"Clinician","billing_taxonomy":"207Q00000X","filing_indicator":"CI","signature_on_file":true,"benefits_assigned":true,"release_authorized":true,"routine_professional_reviewed":true})
}
fn ack999(group: &str, accepted: bool) -> String {
    format!("ST*999*ACK1*005010X231A1~AK1*HC*{group}*005010X222A1~AK2*837*0001*005010X222A1~IK5*{}~AK9*{}*1*1*{}~SE*6*ACK1~",if accepted{"A"}else{"R"},if accepted{"A"}else{"R"},if accepted{"1"}else{"0"})
}
#[tokio::test]
async fn x12_generation_handoff_acknowledgments_and_payer_evidence_are_independent() {
    let (r, db, a, _) = setup().await;
    let (_, _, _, c) = claim_fixture_kind(&r, &a, true).await;
    let pp = "/api/v1/billing/clearinghouses";
    let input = json!({"request_id":Uuid::new_v4(),"content":edi_partner_content(),"reason":"Synthetic partner enrollment review"});
    let mut desk = a.clone();
    desk.role = Role::FrontDesk;
    assert_eq!(
        schedule_call(&r, &desk, "POST", pp, input.clone(), None)
            .await
            .0,
        403
    );
    let (s, p) = schedule_call(&r, &a, "POST", pp, input.clone(), None).await;
    assert_eq!(s, 200, "{p}");
    let (_, same) = schedule_call(&r, &a, "POST", pp, input, None).await;
    assert_eq!(p["id"], same["id"]);
    let gp = format!("/api/v1/billing/claims/{}/837p", c["id"].as_str().unwrap());
    let input = json!({"request_id":Uuid::new_v4(),"partner_id":p["id"],"partner_version":1,"details":edi_details(),"reason":"Reviewed synthetic primary professional claim"});
    assert_eq!(
        schedule_call(&r, &a, "POST", &gp, input.clone(), Some(1))
            .await
            .0,
        409
    );
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{cp}/actions"),
            json!({"action":"ready","reason":"Packet preflight reviewed"}),
            Some(1)
        )
        .await
        .0,
        200
    );
    let (s, out) = schedule_call(&r, &desk, "POST", &gp, input.clone(), Some(2)).await;
    assert_eq!(s, 200, "{out}");
    let (_, same) = schedule_call(&r, &desk, "POST", &gp, input.clone(), Some(2)).await;
    assert_eq!(same["id"], out["id"]);
    let text = out["payload"].as_str().unwrap();
    assert_eq!(text.as_bytes()[105], b'~');
    assert_eq!(out["interchange_control"], "000000001");
    assert!(text.contains("ST*837*0001*005010X222A1~"));
    assert!(text.contains("SV1*HC:99213*125.50*UN*2*11**1~"));
    assert!(text.contains("HI*ABK:Z0000~"));
    assert!(text.contains("DMG*D8*19880403*U~"));
    assert!(text.ends_with("GE*1*1~IEA*1*000000001~"));
    let segments: Vec<_> = text.split('~').filter(|s| !s.is_empty()).collect();
    let st = segments.iter().position(|s| s.starts_with("ST*")).unwrap();
    let se = segments.iter().position(|s| s.starts_with("SE*")).unwrap();
    assert_eq!(
        segments[se]
            .split('*')
            .nth(1)
            .unwrap()
            .parse::<usize>()
            .unwrap(),
        se - st + 1
    );
    let sp = format!(
        "/api/v1/billing/submissions/{}",
        out["id"].as_str().unwrap()
    );
    let (_, d) = schedule_call(&r, &a, "GET", &sp, Value::Null, None).await;
    assert_eq!(d["claim"]["status"], "ready");
    assert_eq!(d["network_sender_configured"], false);
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        schedule_call(&r, &other, "GET", &sp, Value::Null, None)
            .await
            .0,
        404
    );
    let mut read = a.clone();
    read.role = Role::ReadOnly;
    assert_eq!(
        schedule_call(
            &r,
            &read,
            "POST",
            &format!("{sp}/actions"),
            json!({"action":"cancel","reason":"Try readonly"}),
            Some(1)
        )
        .await
        .0,
        403
    );
    let delivery = json!({"action":"record_delivery","reason":"Verified external portal upload","reference":"SYN-PORTAL-RECEIPT","event_date":"2026-10-01","claim_version":2});
    sqlx::raw_sql("CREATE FUNCTION fail_edi_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='edi.submission_change' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_edi_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_edi_audit();").execute(&db).await.unwrap();
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{sp}/actions"),
            delivery.clone(),
            Some(1)
        )
        .await
        .0,
        500
    );
    let (_, d) = schedule_call(&r, &a, "GET", &sp, Value::Null, None).await;
    assert_eq!(d["submission"]["status"], "prepared");
    assert_eq!(d["claim"]["status"], "ready");
    sqlx::query("DROP TRIGGER fail_edi_audit ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    let path = format!("{sp}/actions");
    let (one, two) = tokio::join!(
        schedule_call(&r, &a, "POST", &path, delivery.clone(), Some(1)),
        schedule_call(&r, &a, "POST", &path, delivery, Some(1))
    );
    assert!(
        (one.0 == 200 && two.0 == 409) || (one.0 == 409 && two.0 == 200),
        "{one:?} {two:?}"
    );
    let ackpath = format!("{sp}/acknowledgments");
    let(s,wrong)=schedule_call(&r,&a,"POST",&ackpath,json!({"format":"x12_999","original_text":ack999("WRONG",true),"reason":"Preserve mismatched acknowledgment for review"}),Some(2)).await;
    assert_eq!(s, 200, "{wrong}");
    assert_eq!(wrong["submission"]["technical_status"], "needs_review");
    let(s,ack)=schedule_call(&r,&a,"POST",&ackpath,json!({"format":"x12_999","original_text":ack999("1",true),"reason":"Reviewed matching synthetic 999"}),Some(3)).await;
    assert_eq!(s, 200, "{ack}");
    assert_eq!(ack["submission"]["technical_status"], "accepted");
    assert_eq!(ack["submission"]["payer_outcome"], "pending");
    let (_, d) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(d["claim"]["status"], "submitted");
    let(s,payer)=schedule_call(&r,&a,"POST",&path,json!({"action":"record_payer_acceptance","reference":"SYN-PAYER-RESPONSE","event_date":"2026-10-01","payer_control_number":"SYN-PCN","claim_version":3,"reason":"Reviewed independent payer claim acceptance"}),Some(4)).await;
    assert_eq!(s, 200, "{payer}");
    assert_eq!(payer["payer_outcome"], "accepted");
    let(s,late)=schedule_call(&r,&a,"POST",&ackpath,json!({"format":"x12_999","original_text":ack999("1",false),"reason":"Contradictory late evidence remains reviewable"}),Some(5)).await;
    assert_eq!(s, 200, "{late}");
    let (_, d) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(d["claim"]["status"], "accepted");
    assert!(sqlx::query("UPDATE edi_submissions SET payload='tamper'")
        .execute(&db)
        .await
        .is_err());
    assert!(sqlx::query("DELETE FROM edi_acknowledgments")
        .execute(&db)
        .await
        .is_err());
}

#[tokio::test]
async fn edi_cancellation_controls_and_technical_rejection_keep_retry_history() {
    let (r, db, a, _) = setup().await;
    let (_, _, _, c) = claim_fixture_kind(&r, &a, true).await;
    let(s,p)=schedule_call(&r,&a,"POST","/api/v1/billing/clearinghouses",json!({"request_id":Uuid::new_v4(),"content":edi_partner_content(),"reason":"Synthetic partner"}),None).await;
    assert_eq!(s, 200, "{p}");
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{cp}/actions"),
            json!({"action":"ready","reason":"Reviewed"}),
            Some(1)
        )
        .await
        .0,
        200
    );
    let path = format!("{cp}/837p");
    let mut request = json!({"request_id":Uuid::new_v4(),"partner_id":p["id"],"partner_version":1,"details":edi_details(),"reason":"Synthetic file review"});
    request["details"]["billing_address"]["line1"] = json!("Injected~CLM*BAD");
    assert_eq!(
        schedule_call(&r, &a, "POST", &path, request.clone(), Some(2))
            .await
            .0,
        400
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM edi_submissions")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    request["details"] = edi_details();
    let (s, first) = schedule_call(&r, &a, "POST", &path, request.clone(), Some(2)).await;
    assert_eq!(s, 200, "{first}");
    assert_eq!(first["interchange_control"], "000000001");
    let sp = format!(
        "/api/v1/billing/submissions/{}",
        first["id"].as_str().unwrap()
    );
    let response = r
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("{sp}/file"))
                .header("authorization", bearer(&a))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "application/EDI-X12");
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        bytes.as_ref(),
        first["payload"].as_str().unwrap().as_bytes()
    );
    let mut different = request.clone();
    different["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        schedule_call(&r, &a, "POST", &path, different, None)
            .await
            .0,
        428
    );
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{sp}/actions"),
            json!({"action":"cancel","reason":"Correct profile before handoff"}),
            Some(1)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        schedule_call(&r, &a, "GET", &format!("{sp}/file"), Value::Null, None)
            .await
            .0,
        409
    );
    let mut content = edi_partner_content();
    content["name"] = json!("Updated Synthetic Partner");
    let (s, p) = schedule_call(
        &r,
        &a,
        "PUT",
        &format!(
            "/api/v1/billing/clearinghouses/{}",
            p["id"].as_str().unwrap()
        ),
        json!({"content":content,"reason":"Reviewed new partner configuration"}),
        Some(1),
    )
    .await;
    assert_eq!(s, 200, "{p}");
    request["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        schedule_call(&r, &a, "POST", &path, request.clone(), Some(2))
            .await
            .0,
        409
    );
    request["partner_version"] = json!(2);
    let (s, next) = schedule_call(&r, &a, "POST", &path, request, Some(2)).await;
    assert_eq!(s, 200, "{next}");
    assert_eq!(next["interchange_control"], "000000002");
    assert_eq!(first["partner_version"], 1);
    assert_eq!(next["partner_version"], 2);
    let sp = format!(
        "/api/v1/billing/submissions/{}",
        next["id"].as_str().unwrap()
    );
    assert_eq!(schedule_call(&r,&a,"POST",&format!("{sp}/actions"),json!({"action":"record_delivery","reference":"SYN-DELIVER","event_date":"2026-10-01","claim_version":2,"reason":"Reviewed external receipt"}),Some(1)).await.0,200);
    let(s,rejection)=schedule_call(&r,&a,"POST",&format!("{sp}/acknowledgments"),json!({"format":"x12_999","original_text":ack999("2",false),"reason":"Reviewed transaction rejection"}),Some(2)).await;
    assert_eq!(s, 200, "{rejection}");
    assert_eq!(rejection["submission"]["technical_status"], "rejected");
    let (_, claim) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(claim["claim"]["status"], "rejected");
    assert_eq!(claim["claim"]["payer_control_number"], "");
    assert_eq!(schedule_call(&r,&a,"POST",&format!("{sp}/actions"),json!({"action":"record_payer_acceptance","reference":"SYN","event_date":"2026-10-01","claim_version":4,"payer_control_number":"FAKE","reason":"Must not override technical rejection"}),Some(3)).await.0,409);
    let (s, list) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/submissions",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(s, 200, "{list}");
    assert_eq!(list["items"].as_array().unwrap().len(), 2);
}

async fn automated_fixture(r: &Router, a: &Actor) -> (Value, Value, Value) {
    let (_, _, _, c) = claim_fixture_kind(r, a, true).await;
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    let (s, _) = schedule_call(
        r,
        a,
        "POST",
        &format!("{cp}/actions"),
        json!({"action":"ready","reason":"Synthetic automation review"}),
        Some(1),
    )
    .await;
    assert_eq!(s, 200);
    let (s,p) = schedule_call(r,a,"POST","/api/v1/billing/clearinghouses",json!({"request_id":Uuid::new_v4(),"content":edi_partner_content(),"reason":"Synthetic loopback partner"}),None).await;
    assert_eq!(s, 200, "{p}");
    let (s,out) = schedule_call(r,a,"POST",&format!("{cp}/837p"),json!({"request_id":Uuid::new_v4(),"partner_id":p["id"],"partner_version":1,"details":edi_details(),"reason":"Reviewed synthetic artifact"}),Some(2)).await;
    assert_eq!(s, 200, "{out}");
    (c, p, out)
}
fn ca_fixture(control: &str, category: &str, action: &str, service: bool) -> String {
    let mut segments = vec![
        "ST*277*CA01*005010X214".to_string(),
        "BHT*0085*08*SYN*20261001*1200".into(),
        "HL*1**20*1".into(),
        "NM1*PR*2*Synthetic*****PI*SYN-ONLY".into(),
        "HL*2*1*21*1".into(),
        "NM1*41*2*Clinic*****46*SYN-SUBMIT".into(),
        "HL*3*2*19*1".into(),
        "NM1*85*2*Clinic*****XX*1234567893".into(),
        "HL*4*3*PT*0".into(),
        "NM1*QC*1*Synthetic*Quinn****MI*SYNTHETIC-POLICY-01".into(),
        format!("TRN*2*{control}"),
        format!("STC*{category}:20:PR*20261001*{action}*125.50"),
        "REF*1K*SYN-PCN-277".into(),
        "REF*D9*SYN-INTERMEDIARY".into(),
        "DTP*472*D8*20261001".into(),
    ];
    if service {
        segments.extend([
            "SVC*HC:99213*125.50".into(),
            format!("STC*{category}:20:PR*20261001*{action}"),
            "REF*FJ*1".into(),
            "DTP*472*D8*20261001".into(),
        ]);
    }
    segments.push(format!("SE*{}*CA01", segments.len() + 1));
    segments.join("~") + "~"
}

#[tokio::test]
async fn automated_delivery_real_http_receipts_retries_and_tenant_boundaries() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use suncharts_engine::delivery::{Config, Route};
    let (r, db, a, _) = setup().await;
    let (c, p, out) = automated_fixture(&r, &a).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let cc = calls.clone();
    let ss = seen.clone();
    let gateway=Router::new().route("/claims",axum::routing::post(move |headers:HeaderMap,axum::Json(v):axum::Json<Value>|{let cc=cc.clone();let ss=ss.clone();async move {
        assert_eq!(headers["idempotency-key"].to_str().unwrap(),v["submission_id"].as_str().unwrap());
        assert_eq!(v["payload_sha256"],suncharts_engine::oauth::hash(v["x12"].as_str().unwrap()));
        ss.lock().unwrap().push(v.clone());
        let first=cc.fetch_add(1,Ordering::SeqCst)==0;
        (if first {StatusCode::SERVICE_UNAVAILABLE}else{StatusCode::CREATED},axum::Json(json!({"status":if first{"not_received"}else{"received"},"submission_id":v["submission_id"],"payload_sha256":v["payload_sha256"],"receipt_reference":"SYN-RECEIPT-1"})))
    }}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/claims", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
    let config = Config {
        routes: vec![Route {
            key: "synthetic".into(),
            tenant_id: a.tenant_id,
            partner_id: Uuid::parse_str(p["id"].as_str().unwrap()).unwrap(),
            endpoint,
            usage: "T".into(),
            credential_env: None,
            loopback_test: true,
            adapter: Default::default(),
            retrieval: None,
            sftp: None,
        }],
    };
    let path = format!(
        "/api/v1/billing/submissions/{}/delivery",
        out["id"].as_str().unwrap()
    );
    let input = json!({"request_id":Uuid::new_v4(),"route_key":"synthetic","reason":"Authorized synthetic gateway send"});
    let (s, j) = schedule_call(&r, &a, "POST", &path, input.clone(), Some(1)).await;
    assert_eq!(s, 200, "{j}");
    let (_, same) = schedule_call(&r, &a, "POST", &path, input, Some(1)).await;
    assert_eq!(same["id"], j["id"]);
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{cp}/actions"),
            json!({"action":"cancel","reason":"Must not change queued artifact"}),
            Some(2)
        )
        .await
        .0,
        409
    );
    assert!(suncharts_engine::delivery::process_one(&db, &config)
        .await
        .unwrap());
    let jp = format!(
        "/api/v1/billing/delivery/jobs/{}",
        j["id"].as_str().unwrap()
    );
    let (_, state) = schedule_call(&r, &a, "GET", &jp, Value::Null, None).await;
    assert_eq!(state["job"]["status"], "retry");
    let (_, claim) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(claim["claim"]["status"], "ready");
    assert!(!suncharts_engine::delivery::process_one(&db, &config)
        .await
        .unwrap());
    sqlx::query("UPDATE edi_delivery_jobs SET next_attempt_at=now() WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .execute(&db)
        .await
        .unwrap();
    let (x, y) = tokio::join!(
        suncharts_engine::delivery::process_one(&db, &config),
        suncharts_engine::delivery::process_one(&db, &config)
    );
    x.unwrap();
    y.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let evidence = seen.lock().unwrap().clone();
    assert_eq!(evidence[0], evidence[1]);
    let (_, state) = schedule_call(&r, &a, "GET", &jp, Value::Null, None).await;
    assert_eq!(state["job"]["status"], "delivered");
    assert_eq!(state["job"]["attempts"], 2);
    let (_, claim) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(claim["claim"]["status"], "submitted");
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        schedule_call(&r, &other, "GET", &jp, Value::Null, None)
            .await
            .0,
        404
    );
    let mut reader = a.clone();
    reader.role = Role::ReadOnly;
    assert_eq!(
        schedule_call(
            &r,
            &reader,
            "POST",
            &format!("{jp}/actions"),
            json!({"action":"cancel","reason":"Forbidden"}),
            Some(5)
        )
        .await
        .0,
        403
    );
    assert_eq!(schedule_call(&r,&a,"POST",&path,json!({"request_id":Uuid::new_v4(),"route_key":"synthetic","reason":"Must not duplicate delivered file"}),Some(2)).await.0,409);
    server.abort();
}

#[tokio::test]
async fn ambiguous_delivery_requires_receipt_reconciliation_and_expired_lease_never_resends() {
    use suncharts_engine::delivery::{Config, Route};
    let (r, db, a, _) = setup().await;
    let (c, p, out) = automated_fixture(&r, &a).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/claims", listener.local_addr().unwrap());
    let gateway = Router::new().route(
        "/claims",
        axum::routing::post(|| async {
            axum::Json(json!({"status":"received","wrong":"unverifiable receipt"}))
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
    let config = Config {
        routes: vec![Route {
            key: "synthetic".into(),
            tenant_id: a.tenant_id,
            partner_id: Uuid::parse_str(p["id"].as_str().unwrap()).unwrap(),
            endpoint,
            usage: "T".into(),
            credential_env: None,
            loopback_test: true,
            adapter: Default::default(),
            retrieval: None,
            sftp: None,
        }],
    };
    let path = format!(
        "/api/v1/billing/submissions/{}/delivery",
        out["id"].as_str().unwrap()
    );
    let(s,j)=schedule_call(&r,&a,"POST",&path,json!({"request_id":Uuid::new_v4(),"route_key":"synthetic","reason":"Test ambiguous receipt"}),Some(1)).await;
    assert_eq!(s, 200, "{j}");
    suncharts_engine::delivery::process_one(&db, &config)
        .await
        .unwrap();
    let jp = format!(
        "/api/v1/billing/delivery/jobs/{}",
        j["id"].as_str().unwrap()
    );
    let (_, j) = schedule_call(&r, &a, "GET", &jp, Value::Null, None).await;
    assert_eq!(j["job"]["status"], "unknown");
    assert!(!suncharts_engine::delivery::process_one(&db, &config)
        .await
        .unwrap());
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{jp}/actions"),
            json!({"action":"cancel","reason":"Must reconcile"}),
            Some(3)
        )
        .await
        .0,
        409
    );
    // Simulate process death after its durable lease; recovery must hold, not resend.
    sqlx::query("UPDATE edi_delivery_jobs SET status='leased',lease_until=now()-interval '1 second' WHERE tenant_id=$1").bind(a.tenant_id).execute(&db).await.unwrap();
    suncharts_engine::delivery::process_one(&db, &config)
        .await
        .unwrap();
    let (_, j) = schedule_call(&r, &a, "GET", &jp, Value::Null, None).await;
    assert_eq!(j["job"]["status"], "unknown");
    assert_eq!(j["job"]["attempts"], 1);
    let(s,j)=schedule_call(&r,&a,"POST",&format!("{jp}/actions"),json!({"action":"confirmed_received","reference":"SYN-VERIFIED-RECEIPT","reason":"Independently checked synthetic gateway receipt"}),Some(4)).await;
    assert_eq!(s, 200, "{j}");
    assert_eq!(j["status"], "delivered");
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    let (_, claim) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(claim["claim"]["status"], "submitted");
    server.abort();
}

#[test]
fn ca277_hierarchy_services_qualified_controls_and_unsupported_evidence() {
    use suncharts_engine::ca277::parse;
    let raw = ca_fixture("SC-SYNTHETIC", "A2", "WQ", true);
    let p = parse(&raw).unwrap();
    let c = &p.claims[0];
    assert!(p.issues.is_empty(), "{:?}", p.issues);
    assert!(c.issues.is_empty(), "{:?}", c.issues);
    assert_eq!(c.outcome, "accepted");
    assert_eq!(c.control, "SC-SYNTHETIC");
    assert_eq!(c.payer_control, "SYN-PCN-277");
    assert_eq!(c.intermediary_control, "SYN-INTERMEDIARY");
    assert_eq!(c.services[0].line_control, "1");
    assert_eq!(c.services[0].amount_cents, Some(12550));
    let rejected = parse(&ca_fixture("SC-SYNTHETIC", "A3", "U", false)).unwrap();
    assert_eq!(rejected.claims[0].outcome, "rejected");
    let conflicting = raw.replace(
        "SVC*HC:99213*125.50~STC*A2:20:PR*20261001*WQ",
        "SVC*HC:99213*125.50~STC*A3:20:PR*20261001*U",
    );
    assert_eq!(
        parse(&conflicting).unwrap().claims[0].outcome,
        "needs_review"
    );
    assert!(parse(&raw.replace("005010X214", "005010X212")).is_err());
    assert!(parse(&raw.replace("SE*20*CA01", "SE*99*CA01")).is_err());
    let summary = raw
        .replace(
            "NM1*PR*2*Synthetic*****PI*SYN-ONLY",
            "NM1*PR*2*Synthetic*****PI*SYN-ONLY~STC*A3:20:PR*20261001*U",
        )
        .replace("SE*20*CA01", "SE*21*CA01");
    assert_eq!(parse(&summary).unwrap().claims[0].outcome, "needs_review");
    let mut segments: Vec<_> = raw
        .trim_end_matches('~')
        .split('~')
        .map(str::to_owned)
        .collect();
    let n = segments.len();
    segments.insert(n - 1, "ZZZ*unhandled".into());
    let n = segments.len();
    segments[n - 1] = format!("SE*{n}*CA01");
    assert!(!parse(&(segments.join("~") + "~"))
        .unwrap()
        .issues
        .is_empty());
}

#[tokio::test]
async fn ca277_payer_review_is_scoped_exact_versioned_and_not_clearinghouse_acceptance() {
    let (r, db, a, _) = setup().await;
    let (c, _, out) = automated_fixture(&r, &a).await;
    let sp = format!(
        "/api/v1/billing/submissions/{}",
        out["id"].as_str().unwrap()
    );
    let(s,_)=schedule_call(&r,&a,"POST",&format!("{sp}/actions"),json!({"action":"record_delivery","claim_version":2,"reference":"SYN-MANUAL","event_date":"2026-10-01","reason":"Independently verified delivery"}),Some(1)).await;
    assert_eq!(s, 200);
    let raw = ca_fixture(c["control_number"].as_str().unwrap(), "A2", "WQ", true);
    let input = json!({"request_id":Uuid::new_v4(),"origin":"clearinghouse","original_text":raw,"reason":"Review source without inferring payer acceptance"});
    let (s, d) = schedule_call(&r, &a, "POST", "/api/v1/billing/277ca", input.clone(), None).await;
    assert_eq!(s, 200, "{d}");
    let (_, same) = schedule_call(&r, &a, "POST", "/api/v1/billing/277ca", input, None).await;
    assert_eq!(d["id"], same["id"]);
    let path = format!(
        "/api/v1/billing/277ca/{}/rows/0/apply",
        d["id"].as_str().unwrap()
    );
    let review = json!({"submission_id":out["id"],"submission_version":2,"claim_version":3,"reason":"Verified source, receiver, member, NPI, service and controls"});
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        schedule_call(&r, &other, "POST", &path, review.clone(), Some(1))
            .await
            .0,
        404
    );
    let mut reader = a.clone();
    reader.role = Role::ReadOnly;
    assert_eq!(
        schedule_call(&r, &reader, "POST", &path, review.clone(), Some(1))
            .await
            .0,
        403
    );
    let (s, v) = schedule_call(&r, &a, "POST", &path, review.clone(), Some(1)).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["claim_changed"], false);
    assert_eq!(
        schedule_call(&r, &a, "POST", &path, review, Some(1))
            .await
            .0,
        409
    );
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    let (_, claim) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(claim["claim"]["status"], "submitted");
    let payer_raw = raw.replace("CA01", "CA02");
    let(s,d)=schedule_call(&r,&a,"POST","/api/v1/billing/277ca",json!({"request_id":Uuid::new_v4(),"origin":"payer","original_text":payer_raw,"reason":"Synthetic payer-level evidence"}),None).await;
    assert_eq!(s, 200, "{d}");
    let path = format!(
        "/api/v1/billing/277ca/{}/rows/0/apply",
        d["id"].as_str().unwrap()
    );
    let mut review = json!({"submission_id":out["id"],"submission_version":2,"claim_version":3,"reason":"Verified payer acceptance and exact services"});
    assert_eq!(
        schedule_call(&r, &a, "POST", &path, review.clone(), Some(1))
            .await
            .0,
        409
    );
    review["submission_version"] = json!(3);
    sqlx::raw_sql("CREATE FUNCTION fail_ca_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='edi.277ca_apply' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_ca_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_ca_audit();").execute(&db).await.unwrap();
    assert_eq!(
        schedule_call(&r, &a, "POST", &path, review.clone(), Some(1))
            .await
            .0,
        500
    );
    let (_, unchanged) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(unchanged["claim"]["status"], "submitted");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM edi_277ca_reviews WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 1);
    sqlx::query("DROP TRIGGER fail_ca_audit ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    let (s, v) = schedule_call(&r, &a, "POST", &path, review, Some(1)).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["claim_changed"], true);
    let (_, claim) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(claim["claim"]["status"], "accepted");
    assert_eq!(claim["claim"]["payer_control_number"], "SYN-PCN-277");
    assert!(
        sqlx::query("DELETE FROM edi_277ca_reviews WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .execute(&db)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn imported_ca277_preserves_original_origin_and_never_queues_historical_delivery() {
    let (r, db, a, _) = setup().await;
    let raw = ca_fixture("SOURCE-CLAIM-CONTROL", "A2", "WQ", true);
    let(s,job)=schedule_call(&r,&a,"POST","/api/v1/migrations",json!({"source_instance":"synthetic-legacy-277ca","source_revision":"frozen-ca","consistency":"read_only_export","expected_counts":{"edi_acknowledgment":1},"limitations":["Synthetic historical delivery is not native authorization"]}),None).await;
    assert_eq!(s, 200, "{job}");
    let p = format!("/api/v1/migrations/{}", job["id"].as_str().unwrap());
    let(s,v)=schedule_call(&r,&a,"POST",&format!("{p}/items"),json!({"items":[{"kind":"edi_acknowledgment","source_id":"ack/source-277","patient_source_id":null,"data":{"title":"Historical multi-claim acknowledgment"},"source_data":{"format":"x12_277ca","original_text":raw,"declared_origin":"payer","source_claim_id":"claims/source-claim","source_partner_id":"x12_partners/source"}}]}),None).await;
    assert_eq!(s, 200, "{v}");
    let (s, v) = schedule_call(&r, &a, "POST", &format!("{p}/reconcile"), Value::Null, None).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["ready_to_import"], true, "{v}");
    let (s, v) = schedule_call(
        &r,
        &a,
        "POST",
        &format!("{p}/commit"),
        json!({"digest":v["digest"]}),
        None,
    )
    .await;
    assert_eq!(s, 200, "{v}");
    let id: Uuid = sqlx::query_scalar(
        "SELECT id FROM historical_records WHERE tenant_id=$1 AND source_id='ack/source-277'",
    )
    .bind(a.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    let mut input = json!({"request_id":Uuid::new_v4(),"source_history_id":id,"origin":"clearinghouse","original_text":raw,"reason":"Review imported exact original evidence"});
    assert_eq!(
        schedule_call(&r, &a, "POST", "/api/v1/billing/277ca", input.clone(), None)
            .await
            .0,
        409
    );
    input["origin"] = json!("payer");
    input["original_text"] = json!(raw.replace("CA01", "CA02"));
    assert_eq!(
        schedule_call(&r, &a, "POST", "/api/v1/billing/277ca", input.clone(), None)
            .await
            .0,
        409
    );
    input["original_text"] = json!(raw);
    let (s, doc) = schedule_call(&r, &a, "POST", "/api/v1/billing/277ca", input, None).await;
    assert_eq!(s, 200, "{doc}");
    let (_, sources) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/clearinghouse-sources",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(sources["items"][0]["document_id"], doc["id"]);
    let counts:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM edi_delivery_jobs WHERE tenant_id=$1),(SELECT count(*) FROM ehr_claims WHERE tenant_id=$1)").bind(a.tenant_id).fetch_one(&db).await.unwrap();
    assert_eq!(counts, (0, 0));
}

#[test]
fn delivery_configuration_rejects_unbound_insecure_or_secret_bearing_routes() {
    use suncharts_engine::delivery::{Config, Route};
    let mut c = Config {
        routes: vec![Route {
            key: "synthetic".into(),
            tenant_id: Uuid::new_v4(),
            partner_id: Uuid::new_v4(),
            endpoint: "http://127.0.0.1:4567/claims".into(),
            usage: "T".into(),
            credential_env: None,
            loopback_test: true,
            adapter: Default::default(),
            retrieval: None,
            sftp: None,
        }],
    };
    assert!(c.validate().is_ok());
    for endpoint in [
        "http://example.test/claims",
        "http://user:secret@127.0.0.1/claims",
        "http://127.0.0.1/claims?token=secret",
        "http://localhost/claims",
    ] {
        c.routes[0].endpoint = endpoint.into();
        assert!(c.validate().is_err());
    }
    c.routes[0].endpoint = "https://enrolled.example/claims".into();
    c.routes[0].loopback_test = false;
    assert!(c.validate().is_err());
    c.routes[0].credential_env = Some("ENGINE_CLEARINGHOUSE_TOKEN_SYNTHETIC".into());
    assert!(c.validate().is_ok());
    c.routes.push(c.routes[0].clone());
    assert!(c.validate().is_err());
}

#[tokio::test]
async fn ca277_identity_amount_dates_services_and_unresolved_statuses_cannot_change_claims() {
    let (r, _, a, _) = setup().await;
    let (c, _, out) = automated_fixture(&r, &a).await;
    let sp = format!(
        "/api/v1/billing/submissions/{}",
        out["id"].as_str().unwrap()
    );
    let(s,v)=schedule_call(&r,&a,"POST",&format!("{sp}/actions"),json!({"action":"record_delivery","claim_version":2,"reference":"SYN-GUARDS","event_date":"2026-10-01","reason":"Synthetic external delivery"}),Some(1)).await;
    assert_eq!(s, 200, "{v}");
    let raw = ca_fixture(c["control_number"].as_str().unwrap(), "A2", "WQ", true);
    for (index, (from, to)) in [
        ("SYN-ONLY", "WRONG-PAYER"),
        ("1234567893", "1999999999"),
        ("SYNTHETIC-POLICY-01", "WRONG-MEMBER"),
        ("SYN-SUBMIT", "WRONG-SUBMITTER"),
        ("*125.50", "*125.51"),
        ("D8*20261001", "D8*20261002"),
        ("REF*FJ*1", "REF*FJ*2"),
        ("HC:99213", "HC:99999"),
        ("A2:20:PR", "ZZ:20:PR"),
        ("REF*1K*SYN-PCN-277", "REF*1K*"),
    ]
    .iter()
    .enumerate()
    {
        let original = raw
            .replace(from, to)
            .replace("CA01", &format!("GUARD{index}"));
        let(s,doc)=schedule_call(&r,&a,"POST","/api/v1/billing/277ca",json!({"request_id":Uuid::new_v4(),"origin":"payer","original_text":original,"reason":"Synthetic wrong identity or evidence must be held"}),None).await;
        assert_eq!(s, 200, "{doc}");
        let(s,_)=schedule_call(&r,&a,"POST",&format!("/api/v1/billing/277ca/{}/rows/0/apply",doc["id"].as_str().unwrap()),json!({"submission_id":out["id"],"submission_version":2,"claim_version":3,"reason":"Wrong source must fail"}),Some(1)).await;
        assert!(
            [StatusCode::CONFLICT, StatusCode::BAD_REQUEST].contains(&s),
            "guard {index}: {s}"
        );
    }
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    let (_, claim) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(claim["claim"]["status"], "submitted");
    assert_eq!(claim["claim"]["version"], 3);
    let reject = ca_fixture(c["control_number"].as_str().unwrap(), "A3", "U", false)
        .replace("REF*1K*SYN-PCN-277~", "")
        .replace("SE*16*CA01", "SE*15*CA01");
    let(s,doc)=schedule_call(&r,&a,"POST","/api/v1/billing/277ca",json!({"request_id":Uuid::new_v4(),"origin":"payer","original_text":reject,"reason":"Synthetic payer rejection without fabricated PCN"}),None).await;
    assert_eq!(s, 200, "{doc}");
    let(s,v)=schedule_call(&r,&a,"POST",&format!("/api/v1/billing/277ca/{}/rows/0/apply",doc["id"].as_str().unwrap()),json!({"submission_id":out["id"],"submission_version":2,"claim_version":3,"reason":"Verified rejection controls"}),Some(1)).await;
    assert_eq!(s, 200, "{v}");
    let (_, claim) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(claim["claim"]["status"], "rejected");
    assert_eq!(claim["claim"]["payer_control_number"], "");
}

#[test]
fn ca277_multiple_transactions_and_custom_delimiters_preserve_separate_rows() {
    use suncharts_engine::ca277::parse;
    let one = ca_fixture("SYN-ONE", "A2", "WQ", true);
    let two = ca_fixture("SYN-TWO", "A3", "U", false).replace("CA01", "CA02");
    let p = parse(&(one.clone() + &two)).unwrap();
    assert_eq!(p.transactions, 2);
    assert_eq!(p.claims.len(), 2);
    assert_eq!(p.claims[0].outcome, "accepted");
    assert_eq!(p.claims[1].outcome, "rejected");
    let isa = format!(
        "ISA*00*          *00*          *ZZ*{:<15}*ZZ*{:<15}*261001*1200*^*00501*000000001*0*T*:~",
        "SYN-SENDER", "SYN-RECEIVER"
    );
    assert_eq!(isa.len(), 106);
    let wrapped=format!("{isa}GS*HN*SYN-SENDER*SYN-RECEIVER*20261001*1200*1*X*005010X214~{one}{two}GE*2*1~IEA*1*000000001~");
    assert_eq!(parse(&wrapped).unwrap().claims.len(), 2);
    let custom = wrapped.replace(':', ">");
    let p = parse(&custom).unwrap();
    assert_eq!(p.claims[0].services[0].code, "HC:99213");
    assert!(parse(&wrapped.replace("GE*2*1", "GE*1*1")).is_err());
}

#[tokio::test]
async fn delivery_receipt_audit_failure_rolls_back_result_and_holds_expired_lease() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use suncharts_engine::delivery::{Config, Route};
    let (r, db, a, _) = setup().await;
    let (c, p, out) = automated_fixture(&r, &a).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let cc = calls.clone();
    let gateway=Router::new().route("/claims",axum::routing::post(move |axum::Json(v):axum::Json<Value>|{let cc=cc.clone();async move{cc.fetch_add(1,Ordering::SeqCst);axum::Json(json!({"status":"received","submission_id":v["submission_id"],"payload_sha256":v["payload_sha256"],"receipt_reference":"SYN-ATOMIC-RECEIPT"}))}}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/claims", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
    let config = Config {
        routes: vec![Route {
            key: "synthetic".into(),
            tenant_id: a.tenant_id,
            partner_id: Uuid::parse_str(p["id"].as_str().unwrap()).unwrap(),
            endpoint,
            usage: "T".into(),
            credential_env: None,
            loopback_test: true,
            adapter: Default::default(),
            retrieval: None,
            sftp: None,
        }],
    };
    let(s,j)=schedule_call(&r,&a,"POST",&format!("/api/v1/billing/submissions/{}/delivery",out["id"].as_str().unwrap()),json!({"request_id":Uuid::new_v4(),"route_key":"synthetic","reason":"Synthetic receipt rollback test"}),Some(1)).await;
    assert_eq!(s, 200, "{j}");
    sqlx::raw_sql("CREATE FUNCTION fail_delivery_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='edi.delivery_change' AND EXISTS(SELECT 1 FROM edi_delivery_jobs WHERE id=NEW.resource_id AND status='delivered') THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_delivery_result BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_delivery_result();").execute(&db).await.unwrap();
    assert!(suncharts_engine::delivery::process_one(&db, &config)
        .await
        .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let jp = format!(
        "/api/v1/billing/delivery/jobs/{}",
        j["id"].as_str().unwrap()
    );
    let (_, job) = schedule_call(&r, &a, "GET", &jp, Value::Null, None).await;
    assert_eq!(job["job"]["status"], "leased");
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    let (_, claim) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(claim["claim"]["status"], "ready");
    sqlx::query(
        "UPDATE edi_delivery_jobs SET lease_until=now()-interval '1 second' WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .execute(&db)
    .await
    .unwrap();
    suncharts_engine::delivery::process_one(&db, &config)
        .await
        .unwrap();
    let (_, job) = schedule_call(&r, &a, "GET", &jp, Value::Null, None).await;
    assert_eq!(job["job"]["status"], "unknown");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.abort();
}

fn provider_config(
    a: &Actor,
    p: &Value,
    adapter: &str,
    endpoint: &str,
    core: &str,
) -> suncharts_engine::delivery::Config {
    serde_json::from_value(json!({"routes":[{"key":"provider-test","tenant_id":a.tenant_id,"partner_id":p["id"],"adapter":adapter,"endpoint":endpoint,"usage":"T","loopback_test":true,"retrieval":{"start_at":"2026-10-01T00:00:00Z","core_base":core,"interval_seconds":30}}]})).unwrap()
}
async fn queue_provider(r: &Router, a: &Actor, out: &Value) -> Value {
    let(s,j)=schedule_call(r,a,"POST",&format!("/api/v1/billing/submissions/{}/delivery",out["id"].as_str().unwrap()),json!({"request_id":Uuid::new_v4(),"route_key":"provider-test","reason":"Synthetic enrolled provider transport test"}),Some(1)).await;
    assert_eq!(s, 200, "{j}");
    j
}

#[tokio::test]
async fn stedi_native_submission_and_polling_preserve_cursors_download_auth_and_review_boundaries()
{
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };
    let (r, db, a, _) = setup().await;
    let (c, p, out) = automated_fixture(&r, &a).await;
    let ack = ca_fixture(c["control_number"].as_str().unwrap(), "A2", "WQ", true);
    let receipt_ack = ca_fixture(c["control_number"].as_str().unwrap(), "A1", "WQ", false)
        .replace("CA01", "INIT")
        .replace(
            "NM1*PR*2*Synthetic*****PI*SYN-ONLY",
            "NM1*AY*2*Synthetic*****46*SYN-RECEIVER",
        );
    let control = c["control_number"].clone();
    let submitted = out["id"].clone();
    let native_payload = out["payload"].clone();
    let report = Uuid::new_v4();
    let tech = Uuid::new_v4();
    let wrong = Uuid::new_v4();
    let outbound = Uuid::new_v4();
    let polls = Arc::new(Mutex::new(Vec::<String>::new()));
    let pp = polls.clone();
    let downloads = Arc::new(AtomicUsize::new(0));
    let dd = downloads.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let b = base.clone();
    let original = ack.clone();
    let gateway=Router::new().route("/submit",axum::routing::post(move |h:HeaderMap,axum::Json(v):axum::Json<Value>|{let control=control.clone();let payload=native_payload.clone();let submitted=submitted.clone();let receipt_ack=receipt_ack.clone();async move{
        assert_eq!(h["authorization"],"synthetic-loopback-key");assert_eq!(h["idempotency-key"].to_str().unwrap(),submitted.as_str().unwrap());assert_eq!(v,json!({"x12":payload}));
        axum::Json(json!({"status":"SUCCESS","claimReference":{"patientControlNumber":control,"correlationId":"SYN-STEDI-CORRELATION"},"x12":receipt_ack}))
    }})).route("/polling/transactions",axum::routing::get(move |h:HeaderMap,axum::extract::RawQuery(q):axum::extract::RawQuery|{let pp=pp.clone();async move{
        assert_eq!(h["authorization"],"synthetic-loopback-key");pp.lock().unwrap().push(q.unwrap());
        axum::Json(json!({"nextPageToken":"opaque-provider-cursor-1","items":[
            {"transactionId":report,"status":"succeeded","direction":"INBOUND","mode":"test","x12":{"metadata":{"transaction":{"transactionSetIdentifier":"277"}}}},
            {"transactionId":tech,"status":"succeeded","direction":"INBOUND","mode":"test","x12":{"metadata":{"transaction":{"transactionSetIdentifier":"999"}}}},
            {"transactionId":wrong,"status":"succeeded","direction":"INBOUND","mode":"production","x12":{"metadata":{"transaction":{"transactionSetIdentifier":"277"}}}},
            {"transactionId":outbound,"status":"succeeded","direction":"OUTBOUND","mode":"test","x12":{"metadata":{"transaction":{"transactionSetIdentifier":"837"}}}}
        ]}))
    }})).route("/transactions/{id}/input",axum::routing::get(move |h:HeaderMap,axum::extract::Path(id):axum::extract::Path<String>|{let b=b.clone();async move{assert_eq!(h["authorization"],"synthetic-loopback-key");(StatusCode::FOUND,axum::Json(json!({"documentDownloadUrl":format!("{b}/downloads/{id}?signature=must-not-persist-signed-url")})))}})).route("/downloads/{id}",axum::routing::get(move |h:HeaderMap,axum::extract::Path(id):axum::extract::Path<Uuid>|{let original=original.clone();let dd=dd.clone();async move{assert!(!h.contains_key("authorization"));dd.fetch_add(1,Ordering::SeqCst);if id==report{original}else{ack999("1",true)}}}));
    let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
    let config = provider_config(&a, &p, "stedi", &format!("{base}/submit"), &base);
    config.validate().unwrap();
    queue_provider(&r, &a, &out).await;
    suncharts_engine::delivery::process_one(&db, &config)
        .await
        .unwrap();
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    let (_, claim) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(claim["claim"]["status"], "submitted");
    assert!(suncharts_engine::retrieval::poll_one(&db, &config)
        .await
        .unwrap());
    assert!(suncharts_engine::retrieval::fetch_one(&db, &config)
        .await
        .unwrap());
    assert!(suncharts_engine::retrieval::fetch_one(&db, &config)
        .await
        .unwrap());
    assert!(!suncharts_engine::retrieval::fetch_one(&db, &config)
        .await
        .unwrap());
    assert_eq!(downloads.load(Ordering::SeqCst), 2);
    let (_, connections) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/connections",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(connections["items"][0]["cursor_saved"], true);
    assert!(!connections.to_string().contains("opaque-provider-cursor"));
    sqlx::query("UPDATE edi_connections SET next_poll_at=now() WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .execute(&db)
        .await
        .unwrap();
    suncharts_engine::retrieval::poll_one(&db, &config)
        .await
        .unwrap();
    let queries = polls.lock().unwrap().clone();
    assert!(queries[0].contains("startDateTime="));
    assert!(queries[1].contains("pageToken=opaque-provider-cursor-1"));
    let counts:(i64,i64)=sqlx::query_as("SELECT count(*),count(*) FILTER(WHERE status='ignored') FROM edi_remote_reports WHERE tenant_id=$1").bind(a.tenant_id).fetch_one(&db).await.unwrap();
    assert_eq!(counts, (5, 2));
    let values: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM edi_remote_reports r WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_all(&db)
            .await
            .unwrap();
    assert!(!json!(values)
        .to_string()
        .contains("must-not-persist-signed-url"));
    let native = values
        .iter()
        .find(|v| v["remote_id"] == report.to_string())
        .unwrap();
    let tech_native = values
        .iter()
        .find(|v| v["remote_id"] == tech.to_string())
        .unwrap();
    let initial = values
        .iter()
        .find(|v| v["remote_id"].as_str().unwrap().starts_with("submission:"))
        .unwrap();
    let(s,_)=schedule_call(&r,&a,"POST","/api/v1/billing/277ca",json!({"request_id":Uuid::new_v4(),"remote_report_id":initial["id"],"origin":"payer","original_text":receipt_ack_text(&values),"reason":"Initial Stedi acceptance must not become payer-origin"}),None).await;
    assert_eq!(s, 409);
    let sp = format!(
        "/api/v1/billing/submissions/{}",
        out["id"].as_str().unwrap()
    );
    let(s,v)=schedule_call(&r,&a,"POST",&format!("{sp}/acknowledgments"),json!({"remote_report_id":tech_native["id"],"format":"x12_999","original_text":ack999("1",true),"reason":"Verified retrieved native envelope controls"}),Some(2)).await;
    assert_eq!(s, 200, "{v}");
    let input = json!({"request_id":Uuid::new_v4(),"remote_report_id":native["id"],"origin":"payer","original_text":ack,"reason":"Retrieved issuer and native identities independently reviewed"});
    let (s, d) = schedule_call(&r, &a, "POST", "/api/v1/billing/277ca", input, None).await;
    assert_eq!(s, 200, "{d}");
    let(s,v)=schedule_call(&r,&a,"POST",&format!("/api/v1/billing/277ca/{}/rows/0/apply",d["id"].as_str().unwrap()),json!({"submission_id":out["id"],"submission_version":3,"claim_version":3,"reason":"Verified exact payer claim, provider, member and services"}),Some(1)).await;
    assert_eq!(s, 200, "{v}");
    let (_, claim) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(claim["claim"]["status"], "accepted");
    assert!(sqlx::query("UPDATE edi_remote_reports SET original_text='mutated' WHERE tenant_id=$1 AND original_text IS NOT NULL").bind(a.tenant_id).execute(&db).await.is_err());
    server.abort();
}
fn receipt_ack_text(values: &[Value]) -> String {
    values
        .iter()
        .find(|v| v["remote_id"].as_str().unwrap().starts_with("submission:"))
        .unwrap()["original_text"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn claimmd_multipart_delivery_and_responseid_feed_preserve_structured_evidence() {
    use std::sync::Mutex;
    let (r, db, a, _) = setup().await;
    let (c, p, out) = automated_fixture(&r, &a).await;
    let control = c["control_number"].clone();
    let control2 = control.clone();
    let payload = out["payload"].as_str().unwrap().to_owned();
    let cursors = Arc::new(Mutex::new(Vec::<String>::new()));
    let cc = cursors.clone();
    let gateway=Router::new().route("/services/upload/",axum::routing::post(move |h:HeaderMap,body:axum::body::Bytes|{let control=control.clone();let payload=payload.clone();async move{
        assert_eq!(h["accept"],"application/json");assert!(h["content-type"].to_str().unwrap().starts_with("multipart/form-data; boundary="));assert!(!h.contains_key("authorization"));let b=String::from_utf8(body.to_vec()).unwrap();assert!(b.contains("name=\"AccountKey\""));assert!(b.contains("synthetic-loopback-key"));assert!(b.contains(&payload));
        axum::Json(json!({"claim":[{"pcn":control,"bill_npi":"1234567893","fileid":"123456","status":"A"}]}))
    }})).route("/services/response/",axum::routing::post(move |h:HeaderMap,body:axum::body::Bytes|{let control=control2.clone();let cc=cc.clone();async move{
        assert_eq!(h["accept"],"application/json");let form:std::collections::HashMap<String,String>=url::form_urlencoded::parse(&body).into_owned().collect();assert_eq!(form["AccountKey"],"synthetic-loopback-key");cc.lock().unwrap().push(form["ResponseID"].clone());
        axum::Json(json!({"last_responseid":"9","claim":[{"pcn":control,"bill_npi":"1234567893","bill_taxid":"000000001","ins_number":"SYNTHETIC-POLICY-01","payerid":"SYN-ONLY","total_charge":"125.50","fdos":"2026-10-01","fileid":"123456","claimmd_id":"456","senderid":"CLMMD","sender_name":"CLAIM.MD","sender_icn":"","status":"A","unknown_secret":"must-not-retain-unreviewed-field","messages":[{"responseid":9,"status":"A","mesgid":"ACK","message":"Acknowledged by synthetic Claim.MD"}]}]}))
    }}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
    let config = provider_config(
        &a,
        &p,
        "claim_md",
        &format!("{base}/services/upload/"),
        &base,
    );
    queue_provider(&r, &a, &out).await;
    suncharts_engine::delivery::process_one(&db, &config)
        .await
        .unwrap();
    suncharts_engine::retrieval::poll_one(&db, &config)
        .await
        .unwrap();
    let (_, reports) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/retrieved-reports",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(reports["items"].as_array().unwrap().len(), 1);
    let id = reports["items"][0]["id"].as_str().unwrap();
    let path = format!("/api/v1/billing/retrieved-reports/{id}");
    let (_, detail) = schedule_call(&r, &a, "GET", &path, Value::Null, None).await;
    assert_eq!(detail["report"]["format"], "claimmd_status");
    assert!(!detail
        .to_string()
        .contains("must-not-retain-unreviewed-field"));
    assert!(!detail.to_string().contains("AccountKey"));
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    let (_, before) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(before["claim"]["status"], "submitted");
    let body = json!({"action":"link_status_evidence","submission_id":out["id"],"submission_version":2,"claim_version":3,"reason":"Reviewed provider, payer, member, control, amount and date"});
    let mut reader = a.clone();
    reader.role = Role::ReadOnly;
    assert_eq!(
        schedule_call(
            &r,
            &reader,
            "POST",
            &format!("{path}/actions"),
            body.clone(),
            Some(1)
        )
        .await
        .0,
        403
    );
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_ne!(
        schedule_call(
            &r,
            &other,
            "POST",
            &format!("{path}/actions"),
            body.clone(),
            Some(1)
        )
        .await
        .0,
        200
    );
    let (s, v) = schedule_call(
        &r,
        &a,
        "POST",
        &format!("{path}/actions"),
        body.clone(),
        Some(1),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["clinical_status_changed"], false);
    assert_eq!(
        schedule_call(&r, &a, "POST", &format!("{path}/actions"), body, Some(1))
            .await
            .0,
        409
    );
    let (_, after) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(before["claim"], after["claim"]);
    sqlx::query("UPDATE edi_connections SET next_poll_at=now() WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .execute(&db)
        .await
        .unwrap();
    suncharts_engine::retrieval::poll_one(&db, &config)
        .await
        .unwrap();
    assert_eq!(cursors.lock().unwrap().clone(), vec!["0", "9"]);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM edi_remote_reports WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 1);
    server.abort();
}

#[tokio::test]
async fn provider_discovery_audit_failure_retains_cursor_and_retries_without_lost_reports() {
    let (r, db, a, _) = setup().await;
    let (_, p, _) = automated_fixture(&r, &a).await;
    let id = Uuid::new_v4();
    let gateway=Router::new().route("/polling/transactions",axum::routing::get(move ||async move{axum::Json(json!({"nextPageToken":"safe-next-cursor","items":[{"transactionId":id,"status":"succeeded","direction":"INBOUND","mode":"test","x12":{"transactionSetIdentifier":"277"}}]}))}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
    let config = provider_config(&a, &p, "stedi", &format!("{base}/submit"), &base);
    sqlx::raw_sql("CREATE FUNCTION fail_discovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='edi.remote_report_change' THEN RAISE EXCEPTION 'synthetic discovery audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_discovery BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_discovery();").execute(&db).await.unwrap();
    assert!(suncharts_engine::retrieval::poll_one(&db, &config)
        .await
        .is_err());
    let cursor: Option<String> =
        sqlx::query_scalar("SELECT page_token FROM edi_connections WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(cursor.is_none());
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM edi_remote_reports WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 0);
    sqlx::query("DROP TRIGGER fail_discovery ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE edi_connections SET lease_until=now()-interval '1 second' WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .execute(&db)
    .await
    .unwrap();
    assert!(suncharts_engine::retrieval::poll_one(&db, &config)
        .await
        .unwrap());
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM edi_remote_reports WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 1);
    let cursor: Option<String> =
        sqlx::query_scalar("SELECT page_token FROM edi_connections WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(cursor.as_deref(), Some("safe-next-cursor"));
    server.abort();
}

async fn sftp_provider_journey(adapter: &str, bad_host_key: bool) {
    let fixture = std::path::PathBuf::from(
        std::env::var("SUNCHARTS_SFTP_FIXTURE")
            .expect("start a synthetic loopback SSH fixture first"),
    );
    let (r, db, a, _) = setup().await;
    let (c, p, out) = automated_fixture(&r, &a).await;
    let root = fixture.join(Uuid::new_v4().simple().to_string());
    std::fs::create_dir(&root).unwrap();
    let inbox = root.join("inbox");
    let outbox = root.join("outbox");
    std::fs::create_dir(&inbox).unwrap();
    std::fs::create_dir(&outbox).unwrap();
    let raw = ca_fixture(c["control_number"].as_str().unwrap(), "A2", "WQ", true);
    std::fs::write(inbox.join("SYN-RESPONSE.277"), &raw).unwrap();
    let config:suncharts_engine::delivery::Config=serde_json::from_value(json!({"routes":[{"key":"provider-test","tenant_id":a.tenant_id,"partner_id":p["id"],"adapter":adapter,"endpoint":format!("sftp://127.0.0.1:8098{}",outbox.display()),"usage":"T","sftp":{"username_env":"ENGINE_CLEARINGHOUSE_SFTP_TEST_USER","private_key_env":"ENGINE_CLEARINGHOUSE_SFTP_TEST_KEY","known_hosts_env":if bad_host_key{"ENGINE_CLEARINGHOUSE_SFTP_TEST_BAD_HOSTS"}else{"ENGINE_CLEARINGHOUSE_SFTP_TEST_HOSTS"},"inbox_dir":inbox},"retrieval":{"start_at":"2026-10-01T00:00:00Z","interval_seconds":30}}]})).unwrap();
    config.validate().unwrap();
    let j = queue_provider(&r, &a, &out).await;
    suncharts_engine::delivery::process_one(&db, &config)
        .await
        .unwrap();
    let (_, job) = schedule_call(
        &r,
        &a,
        "GET",
        &format!(
            "/api/v1/billing/delivery/jobs/{}",
            j["id"].as_str().unwrap()
        ),
        Value::Null,
        None,
    )
    .await;
    let destination = outbox.join(format!("837P_{}.x12", out["id"].as_str().unwrap()));
    if bad_host_key {
        assert_eq!(job["job"]["status"], "unknown");
        assert!(!destination.exists());
        assert!(!suncharts_engine::delivery::process_one(&db, &config)
            .await
            .unwrap());
        return;
    }
    assert_eq!(job["job"]["status"], "delivered", "{job}");
    assert_eq!(
        std::fs::read_to_string(destination).unwrap(),
        out["payload"].as_str().unwrap()
    );
    suncharts_engine::retrieval::poll_one(&db, &config)
        .await
        .unwrap();
    suncharts_engine::retrieval::fetch_one(&db, &config)
        .await
        .unwrap();
    let result: (String, String) =
        sqlx::query_as("SELECT status,original_text FROM edi_remote_reports WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(result, ("retrieved".into(), raw.clone()));
    assert_eq!(
        std::fs::read_to_string(inbox.join("SYN-RESPONSE.277")).unwrap(),
        raw
    );
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    let (_, claim) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(claim["claim"]["status"], "submitted");
}
#[tokio::test]
#[ignore = "requires explicitly provisioned loopback OpenSSH fixture"]
async fn office_ally_sftp_upload_and_acknowledgment_retrieval() {
    sftp_provider_journey("office_ally_sftp", false).await;
}
#[tokio::test]
#[ignore = "requires explicitly provisioned loopback OpenSSH fixture"]
async fn availity_sftp_upload_and_acknowledgment_retrieval() {
    sftp_provider_journey("availity_sftp", false).await;
}
#[tokio::test]
#[ignore = "requires explicitly provisioned loopback OpenSSH fixture"]
async fn sftp_wrong_host_key_blocks_upload_and_never_auto_resends() {
    sftp_provider_journey("office_ally_sftp", true).await;
}

#[tokio::test]
async fn provider_source_mapping_is_historical_atomic_idempotent_and_cannot_activate_mailboxes() {
    let (r, db, a, _) = setup().await;
    let(s,partner)=schedule_call(&r,&a,"POST","/api/v1/billing/clearinghouses",json!({"request_id":Uuid::new_v4(),"content":edi_partner_content(),"reason":"Synthetic source partner review"}),None).await;
    assert_eq!(s, 200, "{partner}");
    let(s,job)=schedule_call(&r,&a,"POST","/api/v1/migrations",json!({"source_instance":"synthetic-legacy-claimmd","source_revision":"frozen-provider-status","consistency":"read_only_export","expected_counts":{"edi_acknowledgment":1},"limitations":["Source credentials and cursors excluded"]}),None).await;
    assert_eq!(s, 200, "{job}");
    let mp = format!("/api/v1/migrations/{}", job["id"].as_str().unwrap());
    let bad = json!({"kind":"edi_acknowledgment","source_id":"claimmd/unsafe","patient_source_id":null,"data":{},"source_data":{"format":"claimmd_status","provider":"claim_md","original_text":"{\"pcn\":\"SOURCE-CONTROL\",\"AccountKey\":\"must-not-import\"}"}});
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{mp}/items"),
            json!({"items":[bad]}),
            None
        )
        .await
        .0,
        400
    );
    let raw="{\"pcn\":\"SOURCE-CONTROL\",\"status\":\"A\",\"senderid\":\"CLMMD\",\"message\":{\"responseid\":9,\"message\":\"Acknowledged\"}}\r\n";
    let(s,v)=schedule_call(&r,&a,"POST",&format!("{mp}/items"),json!({"items":[{"kind":"edi_acknowledgment","source_id":"claimmd/9","patient_source_id":null,"data":{"title":"Historical Claim.MD status"},"source_data":{"format":"claimmd_status","provider":"claim_md","provider_report_id":"9","original_text":raw,"source_claim_id":"claims/source","source_partner_id":"x12_partners/source"}}]}),None).await;
    assert_eq!(s, 200, "{v}");
    let (_, report) = schedule_call(
        &r,
        &a,
        "POST",
        &format!("{mp}/reconcile"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(report["ready_to_import"], true);
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{mp}/commit"),
            json!({"digest":report["digest"]}),
            None
        )
        .await
        .0,
        200
    );
    let source: Uuid = sqlx::query_scalar(
        "SELECT id FROM historical_records WHERE tenant_id=$1 AND source_id='claimmd/9'",
    )
    .bind(a.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    let input = json!({"request_id":Uuid::new_v4(),"source_history_id":source,"partner_id":partner["id"],"reason":"Source provider, claim and trading partner independently reconciled"});
    let mut clinician = a.clone();
    clinician.role = Role::Clinician;
    assert_eq!(
        schedule_call(
            &r,
            &clinician,
            "POST",
            "/api/v1/billing/retrieved-reports/from-source",
            input.clone(),
            None
        )
        .await
        .0,
        403
    );
    sqlx::raw_sql("CREATE FUNCTION fail_provider_map() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='edi.provider_source_map' THEN RAISE EXCEPTION 'synthetic source audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_provider_map BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_provider_map();").execute(&db).await.unwrap();
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            "/api/v1/billing/retrieved-reports/from-source",
            input.clone(),
            None
        )
        .await
        .0,
        500
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM edi_remote_reports WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 0);
    sqlx::query("DROP TRIGGER fail_provider_map ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    let (s, mapped) = schedule_call(
        &r,
        &a,
        "POST",
        "/api/v1/billing/retrieved-reports/from-source",
        input.clone(),
        None,
    )
    .await;
    assert_eq!(s, 200, "{mapped}");
    assert_eq!(mapped["transport_activated"], false);
    let (_, same) = schedule_call(
        &r,
        &a,
        "POST",
        "/api/v1/billing/retrieved-reports/from-source",
        input,
        None,
    )
    .await;
    assert_eq!(mapped["id"], same["id"]);
    let (_, detail) = schedule_call(
        &r,
        &a,
        "GET",
        &format!(
            "/api/v1/billing/retrieved-reports/{}",
            mapped["id"].as_str().unwrap()
        ),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(detail["report"]["original_text"], raw);
    let (_, sources) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/clearinghouse-sources",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(sources["items"][0]["retrieved_report_id"], mapped["id"]);
    let key = detail["report"]["route_key"].as_str().unwrap();
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("/api/v1/billing/connections/{key}/actions"),
            json!({"action":"resume","reason":"Historical mapping cannot activate delivery"}),
            Some(1)
        )
        .await
        .0,
        409
    );
    let counts:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM edi_delivery_jobs WHERE tenant_id=$1),(SELECT count(*) FROM ehr_claims WHERE tenant_id=$1)").bind(a.tenant_id).fetch_one(&db).await.unwrap();
    assert_eq!(counts, (0, 0));
    assert!(
        sqlx::query("DELETE FROM edi_remote_source_links WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .execute(&db)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn provider_download_rejects_untrusted_redirects_and_requires_explicit_retry_after_failures()
{
    let (r, db, a, _) = setup().await;
    let (_, p, _) = automated_fixture(&r, &a).await;
    let id = Uuid::new_v4();
    let gateway=Router::new().route("/polling/transactions",axum::routing::get(move ||async move{axum::Json(json!({"nextPageToken":"cursor-one","items":[{"transactionId":id,"status":"succeeded","direction":"INBOUND","mode":"test","x12":{"transactionSetIdentifier":"277"}}]}))})).route("/transactions/{id}/input",axum::routing::get(||async{(StatusCode::FOUND,axum::Json(json!({"documentDownloadUrl":"http://127.0.0.1:1/forbidden-destination"})))}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
    let config = provider_config(&a, &p, "stedi", &format!("{base}/submit"), &base);
    suncharts_engine::retrieval::poll_one(&db, &config)
        .await
        .unwrap();
    for _ in 0..3 {
        suncharts_engine::retrieval::fetch_one(&db, &config)
            .await
            .unwrap();
        sqlx::query("UPDATE edi_remote_reports SET next_attempt_at=now() WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .execute(&db)
            .await
            .unwrap();
    }
    let (_, reports) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/retrieved-reports",
        Value::Null,
        None,
    )
    .await;
    let report = &reports["items"][0];
    assert_eq!(report["status"], "quarantined");
    assert_eq!(report["attempts"], 3);
    assert!(!suncharts_engine::retrieval::fetch_one(&db, &config)
        .await
        .unwrap());
    let id = report["id"].as_str().unwrap();
    let(s,v)=schedule_call(&r,&a,"POST",&format!("/api/v1/billing/retrieved-reports/{id}/actions"),json!({"action":"retry_download","reason":"Operator corrected provider download host enrollment"}),Some(7)).await;
    assert_eq!(s, 200, "{v}");
    let (_, connection) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/connections/provider-test",
        Value::Null,
        None,
    )
    .await;
    let version = connection["connection"]["version"].as_i64().unwrap();
    let mut clinician = a.clone();
    clinician.role = Role::Clinician;
    assert_eq!(
        schedule_call(
            &r,
            &clinician,
            "POST",
            "/api/v1/billing/connections/provider-test/actions",
            json!({"action":"pause","reason":"Owner only"}),
            Some(version)
        )
        .await
        .0,
        403
    );
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            "/api/v1/billing/connections/provider-test/actions",
            json!({"action":"pause","reason":"Pause account while fixing transport"}),
            Some(version)
        )
        .await
        .0,
        200
    );
    assert!(!suncharts_engine::retrieval::fetch_one(&db, &config)
        .await
        .unwrap());
    assert!(!suncharts_engine::retrieval::poll_one(&db, &config)
        .await
        .unwrap());
    server.abort();
}

#[tokio::test]
async fn provider_http_200_without_matching_claim_receipt_never_confirms_delivery() {
    for adapter in ["stedi", "claim_md"] {
        let (r, db, a, _) = setup().await;
        let (c, p, out) = automated_fixture(&r, &a).await;
        let gateway=Router::new().route("/submit",axum::routing::post(||async{axum::Json(json!({"status":"SUCCESS","claimReference":{"patientControlNumber":"WRONG-CONTROL","correlationId":"SYN-WRONG"},"claim":[{"pcn":"WRONG-CONTROL","bill_npi":"1234567893","fileid":"12345"}]}))}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
        let config = provider_config(&a, &p, adapter, &format!("{base}/submit"), &base);
        let j = queue_provider(&r, &a, &out).await;
        suncharts_engine::delivery::process_one(&db, &config)
            .await
            .unwrap();
        let (_, job) = schedule_call(
            &r,
            &a,
            "GET",
            &format!(
                "/api/v1/billing/delivery/jobs/{}",
                j["id"].as_str().unwrap()
            ),
            Value::Null,
            None,
        )
        .await;
        assert_eq!(job["job"]["status"], "unknown");
        assert!(!suncharts_engine::delivery::process_one(&db, &config)
            .await
            .unwrap());
        let (_, claim) = schedule_call(
            &r,
            &a,
            "GET",
            &format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap()),
            Value::Null,
            None,
        )
        .await;
        assert_eq!(claim["claim"]["status"], "ready");
        server.abort();
    }
}

fn claimmd_835(c: &Value, trace: &str) -> String {
    let mut bpr = vec![""; 17];
    bpr[0] = "BPR";
    bpr[1] = "I";
    bpr[2] = "80";
    bpr[3] = "C";
    bpr[4] = "CHK";
    bpr[16] = "20261001";
    format!("ST*835*0001~{}~TRN*1*{trace}~N1*PR*Synthetic Payer*PI*SYN-ONLY~CLP*{}*1*125.50*80*20*CI*SYN-PCN~CAS*CO*45*25.50~CAS*PR*1*20~SE*8*0001~",bpr.join("*"),c["control_number"].as_str().unwrap())
}
#[derive(Clone)]
struct EraMock {
    list: Value,
    download: Value,
    requests: Vec<Value>,
}
async fn era_mock(
    a: &Actor,
    p: &Value,
    raw: String,
) -> (
    suncharts_engine::delivery::Config,
    Arc<std::sync::Mutex<EraMock>>,
    tokio::task::JoinHandle<()>,
) {
    let state = Arc::new(std::sync::Mutex::new(EraMock {
        list: json!({"last_eraid":"2","era":[{"eraid":"1","payerid":"SYN-ONLY","prov_npi":"1234567893","prov_taxid":"000000001","check_number":"SYN-AUTO-ERA","paid_amount":"80.00","paid_date":"2026-10-01","check_type":"eft","AccountKey":"must-not-retain"}]}),
        download: json!({"eraid":"1","data":[raw]}),
        requests: vec![],
    }));
    let m = state.clone();
    let n = state.clone();
    let router = Router::new()
        .route(
            "/services/eralist/",
            axum::routing::post(move |h: HeaderMap, body: axum::body::Bytes| {
                let m = m.clone();
                async move {
                    assert_eq!(h["accept"], "application/json");
                    let f: std::collections::HashMap<String, String> =
                        url::form_urlencoded::parse(&body).into_owned().collect();
                    assert_eq!(f["AccountKey"], "synthetic-loopback-key");
                    assert_eq!(f["NewOnly"], "0");
                    assert!(f["Page"].parse::<u32>().unwrap() > 0);
                    let mut s = m.lock().unwrap();
                    s.requests
                        .push(json!({"era_cursor":f["ERAID"],"page":f["Page"]}));
                    axum::Json(s.list.clone())
                }
            }),
        )
        .route(
            "/services/era835/",
            axum::routing::post(move |body: axum::body::Bytes| {
                let n = n.clone();
                async move {
                    let f: std::collections::HashMap<String, String> =
                        url::form_urlencoded::parse(&body).into_owned().collect();
                    assert_eq!(f["AccountKey"], "synthetic-loopback-key");
                    assert_eq!(f["eraid"], "1");
                    let mut s = n.lock().unwrap();
                    s.requests.push(json!({"download":f["eraid"]}));
                    axum::Json(s.download.clone())
                }
            }),
        )
        .route(
            "/services/response/",
            axum::routing::post(|| async { axum::Json(json!({"last_responseid":"9","claim":[]})) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (
        provider_config(
            a,
            p,
            "claim_md",
            &format!("http://{addr}/services/upload/"),
            &format!("http://{addr}"),
        ),
        state,
        task,
    )
}
async fn era_enable(r: &Router, a: &Actor) -> Value {
    let (_, v) = schedule_call(
        r,
        a,
        "GET",
        "/api/v1/billing/era-automation",
        Value::Null,
        None,
    )
    .await;
    let (s, result) = schedule_call(
        r,
        a,
        "POST",
        "/api/v1/billing/era-automation/provider-test/actions",
        json!({"action":"enable_staging","reason":"Synthetic owner authorizes staging only"}),
        v["feeds"][0]["version"].as_i64(),
    )
    .await;
    assert_eq!(s, 200, "{result}");
    v
}
#[tokio::test]
async fn claimmd_era_discovery_stages_exact_suggestions_then_review_post_reverse() {
    let (r, db, a, _) = setup().await;
    let (c, p, _) = automated_fixture(&r, &a).await;
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    let(s,v)=schedule_call(&r,&a,"POST",&format!("{cp}/actions"),json!({"action":"record_submission","reason":"Verified synthetic prior submission","reference":"SYN-SEND","event_date":"2026-10-01"}),Some(2)).await;
    assert_eq!(s, 200, "{v}");
    let raw = claimmd_835(&c, "SYN-AUTO-ERA");
    let (config, m, task) = era_mock(&a, &p, raw.clone()).await;
    assert!(
        suncharts_engine::remittance_automation::poll_one(&db, &config)
            .await
            .unwrap()
    );
    // Account-wide high water 2 cannot skip an unpersisted second page.
    let cursor: String =
        sqlx::query_scalar("SELECT cursor_id FROM edi_era_feeds WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(cursor, "1");
    suncharts_engine::retrieval::poll_one(&db, &config)
        .await
        .unwrap();
    let status_cursor: String =
        sqlx::query_scalar("SELECT page_token FROM edi_connections WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(status_cursor, "9");
    suncharts_engine::retrieval::fetch_one(&db, &config)
        .await
        .unwrap();
    assert!(
        !suncharts_engine::remittance_automation::stage_one(&db, &config)
            .await
            .unwrap()
    );
    let original: String =
        sqlx::query_scalar("SELECT original_text FROM edi_remote_reports WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(original, raw);
    let prior = era_enable(&r, &a).await;
    assert!(!prior.to_string().contains("must-not-retain"));
    assert!(prior["feeds"][0].get("cursor_id").is_none());
    let (x, y) = tokio::join!(
        suncharts_engine::remittance_automation::stage_one(&db, &config),
        suncharts_engine::remittance_automation::stage_one(&db, &config)
    );
    let (x, y) = (x.unwrap(), y.unwrap());
    assert!(x || y);
    let (_, v) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/era-automation",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(v["items"].as_array().unwrap().len(), 1);
    assert_eq!(v["items"][0]["status"], "staged");
    assert_eq!(v["items"][0]["issues"], json!([]));
    let id = v["items"][0]["remittance_id"].as_str().unwrap();
    let ep = format!("/api/v1/billing/remittances/{id}");
    let (_, v) = schedule_call(&r, &a, "GET", &ep, Value::Null, None).await;
    assert_eq!(v["remittance"]["status"], "staged");
    assert!(!v["ready_to_post"].as_bool().unwrap());
    assert_eq!(
        v["remittance"]["matches"][0]["writeoff_adjustments"],
        json!([])
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM era_posting_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    let mut matches = v["remittance"]["matches"].clone();
    matches[0]["writeoff_adjustments"] = json!([0]);
    let (s, v) = schedule_call(
        &r,
        &a,
        "PUT",
        &format!("{ep}/matches"),
        json!({"matches":matches,"reason":"Reviewed exact claim and selected CO45 credit"}),
        Some(2),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["remittance"]["status"], "reconciled");
    for (version, action) in [(3, "post"), (4, "reverse")] {
        let (s, v) = schedule_call(
            &r,
            &a,
            "POST",
            &format!("{ep}/actions"),
            json!({"action":action,"reason":"Synthetic reviewed posting and reversal"}),
            Some(version),
        )
        .await;
        assert_eq!(s, 200, "{v}");
    }
    assert!(
        !suncharts_engine::remittance_automation::stage_one(&db, &config)
            .await
            .unwrap()
    );
    // Second provider ID with the same payer/trace is retained and held, not reposted.
    let report = Uuid::new_v4();
    sqlx::query("INSERT INTO edi_remote_reports (tenant_id,id,route_key,remote_id,format,metadata,status,original_text,original_hash) SELECT tenant_id,$2,route_key,'era:2',format,metadata||'{\"eraid\":\"2\"}',status,original_text,original_hash FROM edi_remote_reports WHERE tenant_id=$1 LIMIT 1").bind(a.tenant_id).bind(report).execute(&db).await.unwrap();
    assert!(
        suncharts_engine::remittance_automation::stage_one(&db, &config)
            .await
            .unwrap()
    );
    let (_, v) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/era-automation",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(v["items"][0]["status"], "held");
    assert!(v["items"][0]["issues"]
        .to_string()
        .contains("trace already staged"));
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    let (_, v) = schedule_call(
        &r,
        &other,
        "GET",
        "/api/v1/billing/era-automation",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(v["items"], json!([]));
    assert_eq!(v["feeds"], json!([]));
    let mut readonly = a.clone();
    readonly.role = Role::ReadOnly;
    assert_eq!(
        schedule_call(
            &r,
            &readonly,
            "POST",
            "/api/v1/billing/era-automation/provider-test/actions",
            json!({"action":"enable_staging","reason":"Denied"}),
            Some(1)
        )
        .await
        .0,
        403
    );
    assert_eq!(m.lock().unwrap().requests[0]["era_cursor"], "0");
    task.abort();
}
#[tokio::test]
async fn claimmd_era_download_errors_hold_and_independent_cursor_recovers() {
    let (r, db, a, _) = setup().await;
    let (c, p, _) = automated_fixture(&r, &a).await;
    let (config, m, task) = era_mock(&a, &p, claimmd_835(&c, "SYN-AUTO-ERA")).await;
    m.lock().unwrap().list = json!({"error":[{"error_code":"SYNTHETIC"}]});
    suncharts_engine::remittance_automation::poll_one(&db, &config)
        .await
        .unwrap();
    let cursor: String = sqlx::query_scalar("SELECT cursor_id FROM edi_era_feeds")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(cursor, "0");
    suncharts_engine::retrieval::poll_one(&db, &config)
        .await
        .unwrap();
    m.lock().unwrap().list = json!({"last_eraid":"1","era":[{"eraid":"1","payerid":"WRONG"}]});
    sqlx::query("UPDATE edi_era_feeds SET next_poll_at=now()")
        .execute(&db)
        .await
        .unwrap();
    suncharts_engine::remittance_automation::poll_one(&db, &config)
        .await
        .unwrap();
    m.lock().unwrap().download = json!({"eraid":"999","data":[claimmd_835(&c,"SYN-AUTO-ERA")]});
    for _ in 0..3 {
        suncharts_engine::retrieval::fetch_one(&db, &config)
            .await
            .unwrap();
        sqlx::query("UPDATE edi_remote_reports SET next_attempt_at=now()")
            .execute(&db)
            .await
            .unwrap();
    }
    let (status, raw): (String, Option<String>) =
        sqlx::query_as("SELECT status,original_text FROM edi_remote_reports")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(status, "quarantined");
    assert!(raw.is_none());
    let cursor: String = sqlx::query_scalar("SELECT page_token FROM edi_connections")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(cursor, "9");
    let (_, reports) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/retrieved-reports",
        Value::Null,
        None,
    )
    .await;
    let report = &reports["items"][0];
    let (s, v) = schedule_call(
        &r,
        &a,
        "POST",
        &format!(
            "/api/v1/billing/retrieved-reports/{}/actions",
            report["id"].as_str().unwrap()
        ),
        json!({"action":"retry_download","reason":"Resolved synthetic provider download identity"}),
        report["version"].as_i64(),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    m.lock().unwrap().download = json!({"eraid":"1","data":[claimmd_835(&c,"SYN-AUTO-ERA")]});
    suncharts_engine::retrieval::fetch_one(&db, &config)
        .await
        .unwrap();
    era_enable(&r, &a).await;
    suncharts_engine::remittance_automation::stage_one(&db, &config)
        .await
        .unwrap();
    let (_, v) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/era-automation",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(v["items"][0]["status"], "held");
    assert!(v["items"][0]["issues"]
        .to_string()
        .contains("metadata differs"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM era_remittances")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    task.abort();
}
#[tokio::test]
async fn claimmd_era_audit_failures_replay_discovery_and_roll_back_staging() {
    let (r, db, a, _) = setup().await;
    let (c, p, _) = automated_fixture(&r, &a).await;
    let (config, _m, task) = era_mock(&a, &p, claimmd_835(&c, "SYN-AUTO-ERA")).await;
    sqlx::raw_sql("CREATE FUNCTION fail_era_discovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='edi.remote_report_change' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_era_discovery BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_era_discovery();").execute(&db).await.unwrap();
    assert!(
        suncharts_engine::remittance_automation::poll_one(&db, &config)
            .await
            .is_err()
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT cursor_id FROM edi_era_feeds")
            .fetch_one(&db)
            .await
            .unwrap(),
        "0"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM edi_remote_reports")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    sqlx::raw_sql("DROP TRIGGER fail_era_discovery ON audit_events; UPDATE edi_era_feeds SET lease_until=now()-interval '1 second';").execute(&db).await.unwrap();
    suncharts_engine::remittance_automation::poll_one(&db, &config)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE FUNCTION fail_era_download() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='edi.remote_report_change' AND EXISTS(SELECT 1 FROM edi_remote_reports WHERE id=NEW.resource_id AND original_text IS NOT NULL) THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_era_download BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_era_download();").execute(&db).await.unwrap();
    assert!(suncharts_engine::retrieval::fetch_one(&db, &config)
        .await
        .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM edi_remote_reports WHERE original_text IS NOT NULL"
        )
        .fetch_one(&db)
        .await
        .unwrap(),
        0
    );
    sqlx::raw_sql("DROP TRIGGER fail_era_download ON audit_events; UPDATE edi_remote_reports SET lease_until=now()-interval '1 second';").execute(&db).await.unwrap();
    suncharts_engine::retrieval::fetch_one(&db, &config)
        .await
        .unwrap();
    era_enable(&r, &a).await;
    sqlx::raw_sql("CREATE FUNCTION fail_era_staging() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='edi.era_automated_stage' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_era_staging BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_era_staging();").execute(&db).await.unwrap();
    assert!(
        suncharts_engine::remittance_automation::stage_one(&db, &config)
            .await
            .is_err()
    );
    for table in ["era_remittances", "edi_era_automation"] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&db)
                .await
                .unwrap(),
            0
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM edi_remote_reports WHERE native_id IS NOT NULL"
        )
        .fetch_one(&db)
        .await
        .unwrap(),
        0
    );
    sqlx::query("DROP TRIGGER fail_era_staging ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    suncharts_engine::remittance_automation::stage_one(&db, &config)
        .await
        .unwrap();
    let status: String = sqlx::query_scalar("SELECT status FROM era_remittances")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(status, "staged");
    task.abort();
}
#[tokio::test]
async fn claimmd_era_pagination_keeps_fixed_base_until_all_pages_are_durable() {
    let (r, db, a, _) = setup().await;
    let (c, p, _) = automated_fixture(&r, &a).await;
    let (config, m, task) = era_mock(&a, &p, claimmd_835(&c, "SYN-AUTO-ERA")).await;
    // Deliberately unsorted IDs. Provider high water is not a safe page cursor.
    m.lock().unwrap().list = json!({"last_eraid":"101","era":(2..=101).rev().map(|n|json!({"eraid":n.to_string()})).collect::<Vec<_>>()});
    suncharts_engine::remittance_automation::poll_one(&db, &config)
        .await
        .unwrap();
    let cursor: String = sqlx::query_scalar("SELECT cursor_id FROM edi_era_feeds")
        .fetch_one(&db)
        .await
        .unwrap();
    let position: Value = serde_json::from_str(&cursor).unwrap();
    assert_eq!(position["after"], 0);
    assert_eq!(position["page"], 2);
    assert_eq!(position["max_seen"], 101);
    m.lock().unwrap().list = json!({"last_eraid":"101","era":[{"eraid":"1"}]});
    sqlx::query("UPDATE edi_era_feeds SET next_poll_at=now()")
        .execute(&db)
        .await
        .unwrap();
    suncharts_engine::remittance_automation::poll_one(&db, &config)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT cursor_id FROM edi_era_feeds")
            .fetch_one(&db)
            .await
            .unwrap(),
        "101"
    );
    let requests = m.lock().unwrap().requests.clone();
    assert_eq!(requests[0], json!({"era_cursor":"0","page":"1"}));
    assert_eq!(requests[1], json!({"era_cursor":"0","page":"2"}));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM edi_remote_reports")
            .fetch_one(&db)
            .await
            .unwrap(),
        101
    );
    m.lock().unwrap().list = json!({"last_eraid":"0"});
    sqlx::query("UPDATE edi_era_feeds SET next_poll_at=now()")
        .execute(&db)
        .await
        .unwrap();
    suncharts_engine::remittance_automation::poll_one(&db, &config)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT cursor_id FROM edi_era_feeds")
            .fetch_one(&db)
            .await
            .unwrap(),
        "101"
    );
    // Pause affects ERA polling as well as existing status/download workers.
    sqlx::query("UPDATE edi_connections SET paused=true")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE edi_era_feeds SET next_poll_at=now()")
        .execute(&db)
        .await
        .unwrap();
    assert!(
        !suncharts_engine::remittance_automation::poll_one(&db, &config)
            .await
            .unwrap()
    );
    assert!(!suncharts_engine::retrieval::fetch_one(&db, &config)
        .await
        .unwrap());
    let body = json!({"action":"enable_staging","reason":"Synthetic owner review"});
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            "/api/v1/billing/era-automation/provider-test/actions",
            body.clone(),
            None
        )
        .await
        .0,
        428
    );
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            "/api/v1/billing/era-automation/provider-test/actions",
            body,
            Some(1)
        )
        .await
        .0,
        409
    );
    task.abort();
}

async fn posted_era_fixture(r: &Router, a: &Actor) -> (Value, Value, Value, Value) {
    let (p, payer, _b, c) = claim_fixture(r, a).await;
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    for (version, action) in [
        (1, "ready"),
        (2, "record_submission"),
        (3, "record_acceptance"),
    ] {
        let(s,v)=schedule_call(r,a,"POST",&format!("{cp}/actions"),json!({"action":action,"reason":"Synthetic reviewed payer evidence","reference":"SYN-ACK","event_date":"2026-10-01","payer_control_number":"SYN-PCN"}),Some(version)).await;
        assert_eq!(s, 200, "{v}");
    }
    let(s,e)=schedule_call(r,a,"POST","/api/v1/billing/remittances",json!({"request_id":Uuid::new_v4(),"payer_id":payer["id"],"format":"normalized","document":era_document(&c),"reason":"Synthetic original settlement"}),None).await;
    assert_eq!(s, 200, "{e}");
    let ep = format!("/api/v1/billing/remittances/{}", e["id"].as_str().unwrap());
    let (_, c) = schedule_call(r, a, "GET", &cp, Value::Null, None).await;
    let c = &c["claim"];
    let(s,v)=schedule_call(r,a,"PUT",&format!("{ep}/matches"),json!({"matches":[{"row_index":0,"claim_id":c["id"],"claim_version":c["version"],"account_version":2,"writeoff_adjustments":[0]}],"reason":"Exact synthetic posting review"}),Some(1)).await;
    assert_eq!(s, 200, "{v}");
    let (s, posted) = schedule_call(
        r,
        a,
        "POST",
        &format!("{ep}/actions"),
        json!({"action":"post","reason":"Synthetic original payment and CO credit"}),
        Some(2),
    )
    .await;
    assert_eq!(s, 200, "{posted}");
    let (_, current) = schedule_call(r, a, "GET", &cp, Value::Null, None).await;
    (p, payer, current["claim"].clone(), posted)
}
fn plb(code: &str, reference: &str, cents: i64) -> Value {
    json!({"provider_id":"1234567893","fiscal_date":"2026-12-31","reason_code":code,"reference":reference,"amount_cents":cents})
}
#[tokio::test]
async fn provider_settlements_recoupment_cases_and_reversals_never_allocate_patient_debt() {
    let (r, db, a, _) = setup().await;
    let (_p, payer, _c, original) = posted_era_fixture(&r, &a).await;
    let baseline: i64 = sqlx::query_scalar("SELECT count(*) FROM billing_entries")
        .fetch_one(&db)
        .await
        .unwrap();
    let doc = json!({"payer_code":"SYN-ONLY","trace":"SYN-PLB-COLLECTION","payment_date":"2026-10-01","total_paid_cents":0,"currency":"USD","claims":[],"provider_adjustments":[plb("FB","SYN-TRACE-ERA-01",-8000),plb("WO","SYN-TRACE-ERA-01",8000)]});
    let(s,e)=schedule_call(&r,&a,"POST","/api/v1/billing/remittances",json!({"request_id":Uuid::new_v4(),"payer_id":payer["id"],"format":"normalized","document":doc,"reason":"Review deferred forward balance and actual WO collection"}),None).await;
    assert_eq!(s, 200, "{e}");
    let ep = format!("/api/v1/billing/remittances/{}", e["id"].as_str().unwrap());
    let (s, v) = schedule_call(
        &r,
        &a,
        "PUT",
        &format!("{ep}/matches"),
        json!({"matches":[],"reason":"Cannot bypass provider review"}),
        Some(1),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["remittance"]["status"], "staged");
    assert!(!v["issues"].as_array().unwrap().is_empty());
    let body = json!({"decisions":[{"index":0,"category":"forward_balance","original_remittance_id":original["id"]},{"index":1,"category":"recoupment","original_remittance_id":original["id"]}],"reason":"Verified PLB provider, source trace and signed amounts"});
    let mut bad = body.clone();
    bad["decisions"][0]["category"] = json!("recoupment");
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "PUT",
            &format!("{ep}/provider-adjustments"),
            bad,
            Some(2)
        )
        .await
        .0,
        400
    );
    let (s, v) = schedule_call(
        &r,
        &a,
        "PUT",
        &format!("{ep}/provider-adjustments"),
        body,
        Some(2),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    let (s, v) = schedule_call(
        &r,
        &a,
        "PUT",
        &format!("{ep}/matches"),
        json!({"matches":[],"reason":"Balanced provider-only settlement"}),
        Some(3),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["remittance"]["status"], "reconciled");
    let(s,v)=schedule_call(&r,&a,"POST",&format!("{ep}/actions"),json!({"action":"post","reason":"Record reviewed provider settlement; no patient allocation"}),Some(4)).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        baseline
    );
    let (_, d) = schedule_call(
        &r,
        &a,
        "GET",
        &format!("{ep}/provider-adjustments"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(d["entries"].as_array().unwrap().len(), 2);
    assert_eq!(
        d["entries"][0]["effect_cents"].as_i64().unwrap()
            + d["entries"][1]["effect_cents"].as_i64().unwrap(),
        0
    );
    let (_, work) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/recoupments",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(work["items"].as_array().unwrap().len(), 1);
    let case = work["items"][0]["id"].as_str().unwrap();
    for (version, action) in [
        (1, "dispute"),
        (2, "acknowledge"),
        (3, "close"),
        (4, "reopen"),
    ] {
        let (s, v) = schedule_call(
            &r,
            &a,
            "POST",
            &format!("/api/v1/billing/recoupments/{case}/actions"),
            json!({"action":action,"reason":"Synthetic attributed follow-up evidence"}),
            Some(version),
        )
        .await;
        assert_eq!(s, 200, "{v}");
    }
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        schedule_call(
            &r,
            &other,
            "GET",
            &format!("{ep}/provider-adjustments"),
            Value::Null,
            None
        )
        .await
        .0,
        404
    );
    let mut reader = a.clone();
    reader.role = Role::ReadOnly;
    assert_eq!(
        schedule_call(
            &r,
            &reader,
            "POST",
            &format!("/api/v1/billing/recoupments/{case}/actions"),
            json!({"action":"close","reason":"Denied"}),
            Some(5)
        )
        .await
        .0,
        403
    );
    assert!(
        sqlx::query("UPDATE era_provider_entries SET effect_cents=0")
            .execute(&db)
            .await
            .is_err()
    );
    let (s, v) = schedule_call(
        &r,
        &a,
        "POST",
        &format!("{ep}/actions"),
        json!({"action":"reverse","reason":"Reverse synthetic provider settlement"}),
        Some(5),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT sum(effect_cents)::bigint FROM era_provider_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    let (_, work) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/recoupments",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(work["items"][0]["status"], "void");
    assert_eq!(work["items"][0]["events"].as_array().unwrap().len(), 6);
}
#[tokio::test]
async fn clp22_exact_original_recovery_posts_and_unwinds_without_double_recoupment() {
    let (r, db, a, _) = setup().await;
    let (_p, payer, c, original) = posted_era_fixture(&r, &a).await;
    let mut doc = era_document(&c);
    doc["trace"] = json!("SYN-REVERSAL-22");
    doc["total_paid_cents"] = json!(0);
    doc["claims"][0]["status"] = json!("22");
    for key in [
        "charged_cents",
        "paid_cents",
        "patient_responsibility_cents",
    ] {
        doc["claims"][0][key] = json!(-doc["claims"][0][key].as_i64().unwrap());
    }
    for adj in doc["claims"][0]["adjustments"].as_array_mut().unwrap() {
        adj["amount_cents"] = json!(-adj["amount_cents"].as_i64().unwrap());
    }
    doc["provider_adjustments"] = json!([plb("WO", "SYN-PCN", -8000)]);
    let(s,e)=schedule_call(&r,&a,"POST","/api/v1/billing/remittances",json!({"request_id":Uuid::new_v4(),"payer_id":payer["id"],"format":"normalized","document":doc,"reason":"Exact negative CLP22 with deferred-collection offset"}),None).await;
    assert_eq!(s, 200, "{e}");
    let ep = format!("/api/v1/billing/remittances/{}", e["id"].as_str().unwrap());
    let(s,v)=schedule_call(&r,&a,"PUT",&format!("{ep}/provider-adjustments"),json!({"decisions":[{"index":0,"category":"overpayment_offset","original_remittance_id":original["id"]}],"reason":"Verified negative WO offsets reversal; not a new patient recoupment"}),Some(1)).await;
    assert_eq!(s, 200, "{v}");
    let mut m = json!({"row_index":0,"claim_id":c["id"],"claim_version":c["version"],"account_version":3,"writeoff_adjustments":[],"reverses_remittance_id":original["id"],"reverses_row_index":0});
    let mut bad = m.clone();
    bad["reverses_row_index"] = json!(1);
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "PUT",
            &format!("{ep}/matches"),
            json!({"matches":[bad],"reason":"Out of range original"}),
            Some(2)
        )
        .await
        .0,
        400
    );
    m["claim_version"] = json!(1);
    let (_, v) = schedule_call(
        &r,
        &a,
        "PUT",
        &format!("{ep}/matches"),
        json!({"matches":[m.clone()],"reason":"Stale original must stay staged"}),
        Some(2),
    )
    .await;
    assert_eq!(v["remittance"]["status"], "staged");
    m["claim_version"] = c["version"].clone();
    let (s, v) = schedule_call(
        &r,
        &a,
        "PUT",
        &format!("{ep}/matches"),
        json!({"matches":[m],"reason":"Exact posted original, CAS, services and versions"}),
        Some(3),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["remittance"]["status"], "reconciled");
    sqlx::raw_sql("CREATE FUNCTION fail_claim_recovery_post() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='remittance.provider_post' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_claim_recovery_post BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_claim_recovery_post();").execute(&db).await.unwrap();
    assert_eq!(schedule_call(&r,&a,"POST",&format!("{ep}/actions"),json!({"action":"post","reason":"Claim recovery must roll back with provider posting audit"}),Some(4)).await.0,500);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT sum(effect_cents)::bigint FROM billing_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        -10550
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM era_claim_recoveries")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM era_provider_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    sqlx::query("DROP TRIGGER fail_claim_recovery_post ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    let (s, v) = schedule_call(
        &r,
        &a,
        "POST",
        &format!("{ep}/actions"),
        json!({"action":"post","reason":"Record exact original claim accounting reversal"}),
        Some(4),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT sum(effect_cents)::bigint FROM billing_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM era_recoupment_cases")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    let op = format!(
        "/api/v1/billing/remittances/{}/actions",
        original["id"].as_str().unwrap()
    );
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &op,
            json!({"action":"reverse","reason":"Dependent recovery blocks original reversal"}),
            Some(3)
        )
        .await
        .0,
        409
    );
    let (s, v) = schedule_call(
        &r,
        &a,
        "POST",
        &format!("{ep}/actions"),
        json!({"action":"reverse","reason":"Undo erroneous synthetic claim recovery"}),
        Some(5),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT sum(effect_cents)::bigint FROM billing_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        -10550
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM ehr_claims")
            .fetch_one(&db)
            .await
            .unwrap(),
        "adjudicated"
    );
}
#[tokio::test]
async fn provider_post_audit_failure_rolls_back_both_ledgers_and_case_history() {
    let (r, db, a, _) = setup().await;
    let (_p, payer, _c, _original) = posted_era_fixture(&r, &a).await;
    let doc = json!({"payer_code":"SYN-ONLY","trace":"SYN-PLB-ATOMIC","payment_date":"2026-10-01","total_paid_cents":0,"currency":"USD","claims":[],"provider_adjustments":[plb("FB","SYN-FORWARD",-100),plb("WO","SYN-RECOVERY",100)]});
    let(_,e)=schedule_call(&r,&a,"POST","/api/v1/billing/remittances",json!({"request_id":Uuid::new_v4(),"payer_id":payer["id"],"format":"normalized","document":doc,"reason":"Synthetic atomic provider posting"}),None).await;
    let ep = format!("/api/v1/billing/remittances/{}", e["id"].as_str().unwrap());
    let(_,v)=schedule_call(&r,&a,"PUT",&format!("{ep}/provider-adjustments"),json!({"decisions":[{"index":0,"category":"forward_balance","original_remittance_id":null},{"index":1,"category":"recoupment","original_remittance_id":null}],"reason":"Reviewed provider original"}),Some(1)).await;
    assert_eq!(v["version"], 2);
    schedule_call(
        &r,
        &a,
        "PUT",
        &format!("{ep}/matches"),
        json!({"matches":[],"reason":"Provider only balance"}),
        Some(2),
    )
    .await;
    sqlx::raw_sql("CREATE FUNCTION fail_provider_post() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='remittance.provider_post' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_provider_post BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_provider_post();").execute(&db).await.unwrap();
    let (s, _) = schedule_call(
        &r,
        &a,
        "POST",
        &format!("{ep}/actions"),
        json!({"action":"post","reason":"Injected audit failure must roll back"}),
        Some(3),
    )
    .await;
    assert_eq!(s, 500);
    for table in [
        "era_provider_entries",
        "era_recoupment_cases",
        "era_recoupment_events",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&db)
                .await
                .unwrap(),
            0
        );
    }
    let (_, v) = schedule_call(&r, &a, "GET", &ep, Value::Null, None).await;
    assert_eq!(v["remittance"]["status"], "reconciled");
    assert_eq!(v["remittance"]["version"], 3);
}

fn correction_document(original: &Value, trace: &str, paid: i64, pcn: &str) -> Value {
    let mut reverse = original.clone();
    reverse["status"] = json!("22");
    for key in [
        "charged_cents",
        "paid_cents",
        "patient_responsibility_cents",
    ] {
        reverse[key] = json!(-reverse[key].as_i64().unwrap());
    }
    for adj in reverse["adjustments"].as_array_mut().unwrap() {
        adj["amount_cents"] = json!(-adj["amount_cents"].as_i64().unwrap());
    }
    let mut corrected = original.clone();
    corrected["status"] = json!("1");
    corrected["paid_cents"] = json!(paid);
    corrected["payer_control_number"] = json!(pcn);
    corrected["adjustments"][0]["amount_cents"] = json!(12550 - paid - 2000);
    json!({"payer_code":"SYN-ONLY","trace":trace,"payment_date":"2026-10-01","total_paid_cents":0,"currency":"USD","claims":[reverse,corrected],"provider_adjustments":[plb("WO",original["payer_control_number"].as_str().unwrap(),paid-original["paid_cents"].as_i64().unwrap())]})
}
async fn prepare_correction(
    r: &Router,
    a: &Actor,
    payer: &Value,
    c: &Value,
    source: (&Value, usize),
    doc: Value,
    account_version: i64,
) -> Value {
    let (source, source_row) = source;
    let(s,e)=schedule_call(r,a,"POST","/api/v1/billing/remittances",json!({"request_id":Uuid::new_v4(),"payer_id":payer["id"],"format":"normalized","document":doc,"reason":"Synthetic ordered reversal and correction"}),None).await;
    assert_eq!(s, 200, "{e}");
    let ep = format!("/api/v1/billing/remittances/{}", e["id"].as_str().unwrap());
    let(s,v)=schedule_call(r,a,"PUT",&format!("{ep}/provider-adjustments"),json!({"decisions":[{"index":0,"category":"overpayment_offset","original_remittance_id":source["id"]}],"reason":"Exact source provider and negative WO review"}),Some(1)).await;
    assert_eq!(s, 200, "{v}");
    let matches = json!([{"row_index":0,"claim_id":c["id"],"claim_version":c["version"],"account_version":account_version,"writeoff_adjustments":[],"reverses_remittance_id":source["id"],"reverses_row_index":source_row},{"row_index":1,"claim_id":c["id"],"claim_version":c["version"],"account_version":account_version,"writeoff_adjustments":[0],"correction_of_remittance_id":e["id"],"correction_of_row_index":0}]);
    let(s,v)=schedule_call(r,a,"PUT",&format!("{ep}/matches"),json!({"matches":matches,"reason":"Explicit ordered source links, current versions and corrected credits"}),Some(2)).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["remittance"]["status"], "reconciled", "{v}");
    v["remittance"].clone()
}
#[tokio::test]
async fn correction_chains_repeat_and_unwind_in_reverse_order_with_exact_row_ledgers() {
    let (r, db, a, _) = setup().await;
    let (p, payer, c, original) = posted_era_fixture(&r, &a).await;
    let source_row = original["document"]["claims"][0].clone();
    let doc = correction_document(&source_row, "SYN-CORRECT-1", 7000, "SYN-PCN-2");
    let first = prepare_correction(&r, &a, &payer, &c, (&original, 0), doc, 3).await;
    let fp = format!(
        "/api/v1/billing/remittances/{}/actions",
        first["id"].as_str().unwrap()
    );
    let (s, first) = schedule_call(
        &r,
        &a,
        "POST",
        &fp,
        json!({"action":"post","reason":"Post first correction atomically"}),
        first["version"].as_i64(),
    )
    .await;
    assert_eq!(s, 200, "{first}");
    let cp = format!("/api/v1/billing/claims/{}", c["id"].as_str().unwrap());
    let (_, c) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    assert_eq!(c["claim"]["payer_control_number"], "SYN-PCN-2");
    let (_, billing) = schedule_call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/patients/{}/billing", p["id"].as_str().unwrap()),
        Value::Null,
        None,
    )
    .await;
    let account_version = billing["accounts"][0]["version"].as_i64().unwrap();
    let doc = correction_document(
        &first["document"]["claims"][1],
        "SYN-CORRECT-2",
        6000,
        "SYN-PCN-3",
    );
    let second = prepare_correction(
        &r,
        &a,
        &payer,
        &c["claim"],
        (&first, 1),
        doc,
        account_version,
    )
    .await;
    let sp = format!(
        "/api/v1/billing/remittances/{}/actions",
        second["id"].as_str().unwrap()
    );
    let (s, second) = schedule_call(
        &r,
        &a,
        "POST",
        &sp,
        json!({"action":"post","reason":"Repeat correction against exact corrected row"}),
        second["version"].as_i64(),
    )
    .await;
    assert_eq!(s, 200, "{second}");
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &fp,
            json!({"action":"reverse","reason":"Out of order unwind must fail"}),
            first["version"].as_i64()
        )
        .await
        .0,
        409
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT sum(effect_cents)::bigint FROM billing_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        -10550
    );
    for (path, record) in [(&sp, &second), (&fp, &first)] {
        let (s, v) = schedule_call(
            &r,
            &a,
            "POST",
            path,
            json!({"action":"reverse","reason":"Unwind newest correction to oldest"}),
            record["version"].as_i64(),
        )
        .await;
        assert_eq!(s, 200, "{v}");
    }
    // The restored original can be recovered again: use active ledger leaves,
    // never reuse the already-reversed original entry ID.
    let (_, restored) = schedule_call(&r, &a, "GET", &cp, Value::Null, None).await;
    let (_, billing) = schedule_call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/patients/{}/billing", p["id"].as_str().unwrap()),
        Value::Null,
        None,
    )
    .await;
    let third = prepare_correction(
        &r,
        &a,
        &payer,
        &restored["claim"],
        (&original, 0),
        correction_document(&source_row, "SYN-CORRECT-3", 6500, "SYN-PCN-4"),
        billing["accounts"][0]["version"].as_i64().unwrap(),
    )
    .await;
    let tp = format!(
        "/api/v1/billing/remittances/{}/actions",
        third["id"].as_str().unwrap()
    );
    let (s, third) = schedule_call(
        &r,
        &a,
        "POST",
        &tp,
        json!({"action":"post","reason":"Recover restored source through current leaves"}),
        third["version"].as_i64(),
    )
    .await;
    assert_eq!(s, 200, "{third}");
    let (s, v) = schedule_call(
        &r,
        &a,
        "POST",
        &tp,
        json!({"action":"reverse","reason":"Restore original a second time"}),
        third["version"].as_i64(),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    let op = format!(
        "/api/v1/billing/remittances/{}/actions",
        original["id"].as_str().unwrap()
    );
    let (s, v) = schedule_call(
        &r,
        &a,
        "POST",
        &op,
        json!({"action":"reverse","reason":"Original can unwind after dependents are undone"}),
        original["version"].as_i64(),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT sum(effect_cents)::bigint FROM billing_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
}
fn raw_document(doc: &Value, control: &str) -> String {
    fn amount(n: i64) -> String {
        format!(
            "{}{}.{:02}",
            if n < 0 { "-" } else { "" },
            n.abs() / 100,
            n.abs() % 100
        )
    }
    let mut bpr = vec![""; 17];
    bpr[0] = "BPR";
    bpr[1] = "I";
    let paid = amount(doc["total_paid_cents"].as_i64().unwrap());
    bpr[2] = &paid;
    bpr[3] = "C";
    bpr[4] = "CHK";
    bpr[16] = "20261001";
    let mut segments = vec![
        format!("ST*835*{control}"),
        bpr.join("*"),
        format!("TRN*1*{}", doc["trace"].as_str().unwrap()),
        "N1*PR*Synthetic*PI*SYN-ONLY".into(),
    ];
    for c in doc["claims"].as_array().unwrap() {
        segments.push(format!(
            "CLP*{}*{}*{}*{}*{}*CI*{}",
            c["control_number"].as_str().unwrap(),
            c["status"].as_str().unwrap(),
            amount(c["charged_cents"].as_i64().unwrap()),
            amount(c["paid_cents"].as_i64().unwrap()),
            amount(c["patient_responsibility_cents"].as_i64().unwrap()),
            c["payer_control_number"].as_str().unwrap()
        ));
        for adj in c["adjustments"].as_array().unwrap() {
            segments.push(format!(
                "CAS*{}*{}*{}",
                adj["group"].as_str().unwrap(),
                adj["reason_code"].as_str().unwrap(),
                amount(adj["amount_cents"].as_i64().unwrap())
            ));
        }
    }
    if let Some(rows) = doc.get("provider_adjustments").and_then(Value::as_array) {
        for p in rows {
            segments.push(format!(
                "PLB*{}*20261231*{}:{}*{}",
                p["provider_id"].as_str().unwrap(),
                p["reason_code"].as_str().unwrap(),
                p["reference"].as_str().unwrap(),
                amount(p["amount_cents"].as_i64().unwrap())
            ));
        }
    }
    segments.push(format!("SE*{}*{control}", segments.len() + 1));
    segments.join("~") + "~"
}
#[tokio::test]
async fn multi_transaction_batch_orders_corrections_and_is_atomic_idempotent_and_scoped() {
    let (r, db, a, _) = setup().await;
    let (_p, payer, c, original) = posted_era_fixture(&r, &a).await;
    let pair = correction_document(
        &original["document"]["claims"][0],
        "SYN-BATCH-PAIR",
        7000,
        "SYN-PCN-2",
    );
    let mut reverse = pair.clone();
    reverse["claims"] = json!([pair["claims"][0]]);
    reverse["trace"] = json!("SYN-BATCH-SHARED");
    reverse["provider_adjustments"][0]["amount_cents"] = json!(-8000);
    let mut corrected = pair.clone();
    corrected["claims"] = json!([pair["claims"][1]]);
    corrected["trace"] = json!("SYN-BATCH-SHARED");
    corrected["provider_adjustments"][0]["amount_cents"] = json!(7000);
    let raw = raw_document(&reverse, "0001") + &raw_document(&corrected, "0002");
    let input = json!({"request_id":Uuid::new_v4(),"original_text":raw,"payer_ids":[payer["id"],payer["id"]],"reason":"Two transaction correction file"});
    let (s, batch) = schedule_call(
        &r,
        &a,
        "POST",
        "/api/v1/billing/era-batches",
        input.clone(),
        None,
    )
    .await;
    assert_eq!(s, 200, "{batch}");
    let bp = format!(
        "/api/v1/billing/era-batches/{}",
        batch["id"].as_str().unwrap()
    );
    let (s, replay) = schedule_call(
        &r,
        &a,
        "POST",
        "/api/v1/billing/era-batches",
        input.clone(),
        None,
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(replay, batch);
    let mut changed = input.clone();
    changed["reason"] = json!("Changed request");
    assert_eq!(
        schedule_call(&r, &a, "POST", "/api/v1/billing/era-batches", changed, None)
            .await
            .0,
        409
    );
    let (_, d) = schedule_call(&r, &a, "GET", &bp, Value::Null, None).await;
    assert_eq!(d["items"].as_array().unwrap().len(), 2);
    assert_eq!(d["batch"]["original_text"], raw);
    let first = d["items"][0]["id"].clone();
    let second = d["items"][1]["id"].clone();
    for (index, child) in [(0, &first), (1, &second)] {
        let ep = format!("/api/v1/billing/remittances/{}", child.as_str().unwrap());
        let category = if index == 0 {
            "overpayment_offset"
        } else {
            "recoupment"
        };
        let(s,v)=schedule_call(&r,&a,"PUT",&format!("{ep}/provider-adjustments"),json!({"decisions":[{"index":0,"category":category,"original_remittance_id":original["id"]}],"reason":"Review each transaction provider offset"}),Some(1)).await;
        assert_eq!(s, 200, "{v}");
        let m = if index == 0 {
            json!({"row_index":0,"claim_id":c["id"],"claim_version":c["version"],"account_version":3,"writeoff_adjustments":[],"reverses_remittance_id":original["id"],"reverses_row_index":0})
        } else {
            json!({"row_index":0,"claim_id":c["id"],"claim_version":c["version"],"account_version":3,"writeoff_adjustments":[0],"correction_of_remittance_id":first,"correction_of_row_index":0})
        };
        let (s, v) = schedule_call(
            &r,
            &a,
            "PUT",
            &format!("{ep}/matches"),
            json!({"matches":[m],"reason":"Capture baseline and ordered source links"}),
            Some(2),
        )
        .await;
        assert_eq!(s, 200, "{v}");
    }
    let (_, d) = schedule_call(&r, &a, "GET", &bp, Value::Null, None).await;
    let(s,v)=schedule_call(&r,&a,"POST",&format!("{bp}/actions"),json!({"action":"reconcile","reason":"Reconcile ordered file in one rollback-only preview","versions":d["versions"]}),Some(1)).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["status"], "reviewed", "{v}");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM era_claim_recoveries")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    let (_, d) = schedule_call(&r, &a, "GET", &bp, Value::Null, None).await;
    let post = json!({"action":"post","reason":"Atomic batch posting","versions":d["versions"]});
    sqlx::raw_sql("CREATE FUNCTION fail_batch_post() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='remittance.batch_change' AND EXISTS(SELECT 1 FROM era_batches WHERE id=NEW.resource_id AND status='posted') THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_batch_post BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_batch_post();").execute(&db).await.unwrap();
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &format!("{bp}/actions"),
            post.clone(),
            Some(2)
        )
        .await
        .0,
        500
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM era_claim_recoveries")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    sqlx::query("DROP TRIGGER fail_batch_post ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    let path = format!("{bp}/actions");
    let (one, two) = tokio::join!(
        schedule_call(&r, &a, "POST", &path, post.clone(), Some(2)),
        schedule_call(&r, &a, "POST", &path, post, Some(2))
    );
    let mut statuses = [one.0, two.0];
    statuses.sort();
    assert_eq!(statuses, [200, 409], "{one:?} {two:?}");
    assert!(
        sqlx::query("UPDATE era_batches SET original_text='changed'")
            .execute(&db)
            .await
            .is_err()
    );
    let native = format!(
        "/api/v1/billing/remittances/{}/actions",
        first.as_str().unwrap()
    );
    assert_eq!(
        schedule_call(
            &r,
            &a,
            "POST",
            &native,
            json!({"action":"reverse","reason":"No partial batch reversal"}),
            Some(5)
        )
        .await
        .0,
        409
    );
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        schedule_call(&r, &other, "GET", &bp, Value::Null, None)
            .await
            .0,
        404
    );
    let (_, d) = schedule_call(&r, &a, "GET", &bp, Value::Null, None).await;
    let(s,v)=schedule_call(&r,&a,"POST",&format!("{bp}/actions"),json!({"action":"reverse","reason":"Atomic reverse-order batch undo","versions":d["versions"]}),Some(3)).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["status"], "reversed");
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT payer_control_number FROM ehr_claims")
            .fetch_one(&db)
            .await
            .unwrap(),
        "SYN-PCN"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT sum(effect_cents)::bigint FROM billing_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        -10550
    );
}

#[tokio::test]
async fn historical_era_file_maps_once_without_changing_original_or_posting_balances() {
    let (r, db, a, _) = setup().await;
    let (_p, payer, _b, _c) = claim_fixture(&r, &a).await;
    let auth = bearer(&a);
    let doc = json!({"payer_code":"SYN-ONLY","trace":"SYN-SOURCE-FILE","payment_date":"2026-10-01","total_paid_cents":0,"currency":"USD","claims":[],"provider_adjustments":[plb("FB","SYN-OLD",-100),plb("WO","SYN-OLD",100)]});
    let raw = raw_document(&doc, "0001");
    let(_,_,job)=json_call(&r,"POST","/api/v1/migrations",Some(&auth),None,json!({"source_instance":"Synthetic ERA files","source_revision":"frozen-1","expected_counts":{"remittance":1},"consistency":"read_only_export"})).await;
    let mp = format!("/api/v1/migrations/{}", job["id"].as_str().unwrap());
    let(s,_,v)=json_call(&r,"POST",&format!("{mp}/items"),Some(&auth),None,json!({"items":[{"kind":"remittance","source_id":"era/file1","patient_source_id":null,"data":{"title":"Historical original file"},"source_data":{"format":"x12_835","original_text":raw,"settlement_mapping":{"transactions":[{"position":0,"transaction_control":"0001"}]}}}]})).await;
    assert_eq!(s, 200, "{v}");
    let (_, _, report) = json_call(
        &r,
        "POST",
        &format!("{mp}/reconcile"),
        Some(&auth),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(report["ready_to_import"], true, "{report}");
    let (s, _, v) = json_call(
        &r,
        "POST",
        &format!("{mp}/commit"),
        Some(&auth),
        None,
        json!({"digest":report["digest"]}),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    let source: Uuid = sqlx::query_scalar(
        "SELECT id FROM historical_records WHERE tenant_id=$1 AND kind='remittance'",
    )
    .bind(a.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    let input = json!({"request_id":Uuid::new_v4(),"original_text":raw,"payer_ids":[payer["id"]],"source_history_id":source,"reason":"Explicit historical file reconciliation only"});
    let mut changed = input.clone();
    changed["original_text"] = json!(raw.clone() + "\n");
    assert_eq!(
        schedule_call(&r, &a, "POST", "/api/v1/billing/era-batches", changed, None)
            .await
            .0,
        409
    );
    let (s, batch) = schedule_call(
        &r,
        &a,
        "POST",
        "/api/v1/billing/era-batches",
        input.clone(),
        None,
    )
    .await;
    assert_eq!(s, 200, "{batch}");
    assert_eq!(
        schedule_call(&r, &a, "POST", "/api/v1/billing/era-batches", input, None)
            .await
            .1,
        batch
    );
    let (_, sources) = schedule_call(
        &r,
        &a,
        "GET",
        "/api/v1/billing/remittance-sources",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(sources["items"][0]["batch_id"], batch["id"]);
    assert!(sources["items"][0]["native_id"].is_null());
    for table in [
        "billing_entries",
        "era_provider_entries",
        "era_recoupment_cases",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&db)
                .await
                .unwrap(),
            0
        );
    }
}

#[tokio::test]
async fn practice_worklist_follows_saved_encounters_without_cross_tenant_or_patient_access() {
    let (r, db, a, _) = setup().await;
    let path = "/api/v1/practice/worklist";
    let (_, _, empty) = json_call(&r, "GET", path, Some(&bearer(&a)), None, Value::Null).await;
    assert_eq!(empty["total"], 0);
    let (p, v) = billing_patient_visit(&r, &a).await;
    let vp = format!("/api/v1/visits/{}", v["id"].as_str().unwrap());
    let (_, work) = schedule_call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(work["total"], 1);
    assert_eq!(work["items"][0]["visit_id"], v["id"]);
    assert_eq!(work["items"][0]["patient_id"], p["id"]);
    assert_eq!(work["items"][0]["note_saved"], false);
    assert_eq!(work["items"][0]["vitals_saved"], false);
    assert!(work["items"][0].get("note").is_none());
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    let (_, work) = schedule_call(&r, &other, "GET", path, Value::Null, None).await;
    assert_eq!(work["total"], 0);
    let mut portal = a.clone();
    portal.role = Role::Patient;
    portal.patient_id = Some(Uuid::parse_str(p["id"].as_str().unwrap()).unwrap());
    assert_eq!(
        schedule_call(&r, &portal, "GET", path, Value::Null, None)
            .await
            .0,
        403
    );
    assert_eq!(
        json_call(&r, "GET", path, None, None, Value::Null).await.0,
        401
    );
    let mut desk = a.clone();
    desk.role = Role::FrontDesk;
    assert_eq!(
        schedule_call(&r, &desk, "GET", path, Value::Null, None)
            .await
            .0,
        200
    );
    let (s, _) = schedule_call(&r, &a, "PUT", &format!("{vp}/vitals"), json!({"systolic_mm_hg":120,"diastolic_mm_hg":80,"heart_rate_bpm":70,"temperature_c":37.0,"weight_kg":70.0,"height_cm":170.0,"oxygen_saturation_pct":99.0}), Some(1)).await;
    assert_eq!(s, 200);
    let (s, _) = schedule_call(&r, &a, "PUT", &format!("{vp}/note"), json!({"subjective":"Synthetic worklist","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"}), Some(2)).await;
    assert_eq!(s, 200);
    let (_, work) = schedule_call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(work["items"][0]["note_saved"], true);
    assert_eq!(work["items"][0]["vitals_saved"], true);
    assert_eq!(work["items"][0]["version"], 3);
    // The signing operation, not a dashboard-only checkbox, removes the work.
    assert_eq!(
        schedule_call(&r, &a, "POST", &format!("{vp}/sign"), Value::Null, Some(3))
            .await
            .0,
        200
    );
    let (_, work) = schedule_call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(work["total"], 0);
    assert_eq!(work["has_more"], false);
    // Bound large tenant worklists without disguising a partial list as a total.
    let patient_id = Uuid::parse_str(p["id"].as_str().unwrap()).unwrap();
    sqlx::query("INSERT INTO appointments (tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status,title) SELECT $1,gen_random_uuid(),$2,$3,'2026-01-01'::timestamptz + n * interval '1 hour','2026-01-01'::timestamptz + n * interval '1 hour' + interval '30 minutes','in_progress','Synthetic pending visit' FROM generate_series(1,101) n")
        .bind(a.tenant_id).bind(patient_id).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits (tenant_id,id,patient_id,appointment_id,clinician_id) SELECT tenant_id,gen_random_uuid(),patient_id,id,clinician_id FROM appointments WHERE tenant_id=$1 AND status='in_progress'")
        .bind(a.tenant_id).execute(&db).await.unwrap();
    let (_, work) = schedule_call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(work["total"], 101);
    assert_eq!(work["items"].as_array().unwrap().len(), 100);
    assert_eq!(work["has_more"], true);
}
