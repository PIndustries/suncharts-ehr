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
    let schema = format!("referral_delivery_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
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
    let doc = actor(Uuid::new_v4(), Role::Owner);
    let nurse = actor(doc.tenant_id, Role::Nurse);
    for (a, role) in [(&doc, "owner"), (&nurse, "nurse")] {
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
async fn owner_call(
    r: &Router,
    db: &PgPool,
    a: &Actor,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    use sha2::{Digest, Sha256};
    let token = format!("synthetic-session-{}", Uuid::new_v4());
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(&hash).bind(a.tenant_id).bind(a.sub).execute(db).await.unwrap();
    let mut q = Request::builder()
        .method(method)
        .uri(path)
        .header("Cookie", format!("sce_session={token}"))
        .header("Origin", "http://127.0.0.1:8099")
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
    let raw = res.into_body().collect().await.unwrap().to_bytes();
    sqlx::query("DELETE FROM browser_sessions WHERE token_hash=$1")
        .bind(hash)
        .execute(db)
        .await
        .unwrap();
    (status, serde_json::from_slice(&raw).unwrap_or(Value::Null))
}
async fn receiver(accept: bool) -> (String, tokio::task::JoinHandle<(Value, String)>) {
    receiver_mode(accept, None).await
}
async fn receiver_mode(
    accept: bool,
    gate: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
) -> (String, tokio::task::JoinHandle<(Value, String)>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/referrals", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut stream, _) =
            tokio::time::timeout(std::time::Duration::from_secs(10), listener.accept())
                .await
                .unwrap()
                .unwrap();
        let mut data = Vec::new();
        let (head, body) = loop {
            let mut b = [0u8; 4096];
            let n = stream.read(&mut b).await.unwrap();
            assert!(n > 0);
            data.extend_from_slice(&b[..n]);
            if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                let head = String::from_utf8(data[..end].to_vec()).unwrap();
                let len: usize = head
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse().unwrap())
                    })
                    .unwrap();
                if data.len() >= end + 4 + len {
                    break (head, data[end + 4..end + 4 + len].to_vec());
                }
            }
        };
        let payload: Value = serde_json::from_slice(&body).unwrap();
        if let Some((arrived, release)) = gate {
            arrived.notify_one();
            release.notified().await;
        }
        let reply = if accept {
            json!({"accepted":true,"delivery_id":payload["delivery_id"],"receipt":"synthetic-receipt-1"})
        } else {
            json!({"error":"synthetic-receiver-failure"})
        };
        let body = reply.to_string();
        let code = if accept {
            "200 OK"
        } else {
            "500 Internal Server Error"
        };
        let response=format!("HTTP/1.1 {code}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
        stream.write_all(response.as_bytes()).await.unwrap();
        (payload, head)
    });
    (url, task)
}
async fn ready(r: &Router, a: &Actor, p: Uuid) -> Value {
    ready_documents(r, a, p, vec![]).await
}
async fn ready_documents(r: &Router, a: &Actor, p: Uuid, documents: Vec<Uuid>) -> Value {
    let path = format!("/api/v1/patients/{p}/referrals");
    let input = json!({"request_id":Uuid::new_v4(),"visit_id":null,"content":{"requested_service":"Synthetic consultation","recipient":"Synthetic receiving practice","specialty":"General","priority":"routine","clinical_reason":"Synthetic local receiver test","clinical_summary":"No real clinical care","follow_up_due":null,"document_ids":documents},"reason":"Synthetic draft"});
    let (status, entry) = call(r, a, "POST", &path, input, None).await;
    assert_eq!(status, 200, "{entry}");
    let (status, entry) = call(
        r,
        a,
        "POST",
        &format!("{path}/{}/actions", entry["id"].as_str().unwrap()),
        json!({"action":"ready","reason":"Synthetic readiness review","evidence":""}),
        Some(1),
    )
    .await;
    assert_eq!(status, 200, "{entry}");
    entry
}
async fn configured(db: &PgPool, r: &Router, a: &Actor, url: &str) -> Value {
    std::env::set_var("ENGINE_REFERRAL_ALLOW_LOOPBACK", "true");
    let (status,d)=owner_call(r,db,a,"POST","/api/v1/referral-delivery/destinations",json!({"request_id":Uuid::new_v4(),"name":"Synthetic local receiver","endpoint":url,"enabled":true,"loopback_test":true,"bearer_token":"synthetic-local-referral-token","reason":"Synthetic acceptance receiver"}),None).await;
    assert_eq!(status, 200, "{d}");
    assert!(d.get("bearer_token").is_none());
    d
}
async fn reviewed(r: &Router, a: &Actor, p: Uuid, entry: &Value, d: &Value) -> Value {
    let path = format!(
        "/api/v1/patients/{p}/referrals/{}/delivery/preview",
        entry["id"].as_str().unwrap()
    );
    let (status, v) = call(r, a, "POST", &path, json!({"destination_id":d["id"]}), None).await;
    assert_eq!(status, 200, "{v}");
    assert!(v.get("payload").is_none());
    v
}
async fn queued(
    r: &Router,
    a: &Actor,
    p: Uuid,
    entry: &Value,
    d: &Value,
    preview: &Value,
) -> (Value, Value) {
    let input = json!({"request_id":Uuid::new_v4(),"destination_id":d["id"],"destination_version":d["version"],"review_digest":preview["review_digest"],"reason":"Explicit synthetic reviewed delivery"});
    let path = format!(
        "/api/v1/patients/{p}/referrals/{}/delivery",
        entry["id"].as_str().unwrap()
    );
    let (status, v) = call(
        r,
        a,
        "POST",
        &path,
        input.clone(),
        entry["version"].as_i64(),
    )
    .await;
    assert_eq!(status, 200, "{v}");
    (v, input)
}
#[tokio::test]
async fn reviewed_package_is_sent_once_with_receipt_and_referral_history() {
    let (db, a, _, p) = setup().await;
    let r = app(db.clone());
    let (url, server) = receiver(true).await;
    let d = configured(&db, &r, &a, &url).await;
    let entry = ready(&r, &a, p).await;
    let preview = reviewed(&r, &a, p, &entry, &d).await;
    let (j, input) = queued(&r, &a, p, &entry, &d, &preview).await;
    let path = format!(
        "/api/v1/patients/{p}/referrals/{}/delivery",
        entry["id"].as_str().unwrap()
    );
    let (_, again) = call(&r, &a, "POST", &path, input, entry["version"].as_i64()).await;
    assert_eq!(j["id"], again["id"]);
    let protected = format!(
        "/api/v1/patients/{p}/referrals/{}/actions",
        entry["id"].as_str().unwrap()
    );
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &protected,
            json!({"action":"draft","reason":"Synthetic change","evidence":""}),
            Some(2)
        )
        .await
        .0,
        409
    );
    let (first, second) = tokio::join!(
        suncharts_engine::referral_delivery::process_one(&db),
        suncharts_engine::referral_delivery::process_one(&db)
    );
    assert_ne!(first.unwrap(), second.unwrap());
    let (payload, headers) = server.await.unwrap();
    assert_eq!(
        payload["referral"]["recipient"],
        "Synthetic receiving practice"
    );
    use sha2::{Digest, Sha256};
    let identity = json!({"tenant":a.tenant_id,"delivery":j["id"]});
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&identity).unwrap())
    );
    assert!(headers
        .to_lowercase()
        .contains(&format!("idempotency-key: {key}")));
    let path = format!(
        "/api/v1/referral-delivery/jobs/{}",
        j["id"].as_str().unwrap()
    );
    let (_, out) = call(&r, &a, "GET", &path, Value::Null, None).await;
    assert_eq!(out["status"], "sent");
    assert_eq!(out["receipt"], "synthetic-receipt-1");
    assert!(out.get("payload").is_none());
    assert!(out.get("encrypted_credential").is_none());
    assert_eq!(out["history"].as_array().unwrap().len(), 3);
    let state: String =
        sqlx::query_scalar("SELECT status FROM referrals WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(Uuid::parse_str(entry["id"].as_str().unwrap()).unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(state, "sent");
    assert!(!suncharts_engine::referral_delivery::process_one(&db)
        .await
        .unwrap());
}
#[tokio::test]
async fn uncertain_outcomes_reserve_context_until_explicit_reconciliation() {
    let (db, a, _, p) = setup().await;
    let r = app(db.clone());
    let (url, server) = receiver(false).await;
    let d = configured(&db, &r, &a, &url).await;
    let e = ready(&r, &a, p).await;
    let v = reviewed(&r, &a, p, &e, &d).await;
    let (j, _) = queued(&r, &a, p, &e, &d, &v).await;
    suncharts_engine::referral_delivery::process_one(&db)
        .await
        .unwrap();
    server.await.unwrap();
    let path = format!(
        "/api/v1/referral-delivery/jobs/{}",
        j["id"].as_str().unwrap()
    );
    let (_, out) = call(&r, &a, "GET", &path, Value::Null, None).await;
    assert_eq!(out["status"], "uncertain");
    assert!(!suncharts_engine::referral_delivery::process_one(&db)
        .await
        .unwrap());
    let(status,reconciled)=call(&r,&a,"POST",&(path+"/actions"),json!({"action":"reconcile_not_sent","receipt":"Synthetic receiver confirms not processed","reason":"Explicit receiver reconciliation"}),out["version"].as_i64()).await;
    assert_eq!(status, 200, "{reconciled}");
    assert_eq!(reconciled["status"], "not_sent");
    let status: String =
        sqlx::query_scalar("SELECT status FROM referrals WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(Uuid::parse_str(e["id"].as_str().unwrap()).unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(status, "ready");
}
#[tokio::test]
async fn actor_revocation_and_destination_changes_stop_dispatch_without_network() {
    for revoke in [true, false] {
        let (db, a, _, p) = setup().await;
        let r = app(db.clone());
        let (url, server) = receiver(true).await;
        let d = configured(&db, &r, &a, &url).await;
        let e = ready(&r, &a, p).await;
        let v = reviewed(&r, &a, p, &e, &d).await;
        let (j, _) = queued(&r, &a, p, &e, &d, &v).await;
        if revoke {
            sqlx::query("UPDATE browser_users SET disabled=true WHERE tenant_id=$1 AND id=$2")
                .bind(a.tenant_id)
                .bind(a.sub)
                .execute(&db)
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE referral_delivery_destinations SET enabled=false,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(Uuid::parse_str(d["id"].as_str().unwrap()).unwrap()).execute(&db).await.unwrap();
        }
        suncharts_engine::referral_delivery::process_one(&db)
            .await
            .unwrap();
        let status: String = sqlx::query_scalar(
            "SELECT status FROM referral_delivery_jobs WHERE tenant_id=$1 AND id=$2",
        )
        .bind(a.tenant_id)
        .bind(Uuid::parse_str(j["id"].as_str().unwrap()).unwrap())
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(status, "not_sent");
        server.abort();
    }
}
#[tokio::test]
async fn destination_configuration_tenant_bounds_versions_and_audit_rollback() {
    let (db, a, nurse, p) = setup().await;
    let r = app(db.clone());
    let (url, server) = receiver(true).await;
    let input = json!({"request_id":Uuid::new_v4(),"name":"Synthetic","endpoint":url,"enabled":true,"loopback_test":true,"bearer_token":"synthetic-local-referral-token","reason":"Synthetic"});
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            "/api/v1/referral-delivery/destinations",
            input.clone(),
            None
        )
        .await
        .0,
        403
    );
    assert_eq!(
        owner_call(
            &r,
            &db,
            &nurse,
            "POST",
            "/api/v1/referral-delivery/destinations",
            input.clone(),
            None
        )
        .await
        .0,
        403
    );
    let mut unsafe_input = input;
    unsafe_input["endpoint"] = json!("http://169.254.169.254/latest/meta-data");
    assert_eq!(
        owner_call(
            &r,
            &db,
            &a,
            "POST",
            "/api/v1/referral-delivery/destinations",
            unsafe_input,
            None
        )
        .await
        .0,
        400
    );
    let d = configured(&db, &r, &a, &url).await;
    let e = ready(&r, &a, p).await;
    let preview = reviewed(&r, &a, p, &e, &d).await;
    let (j, _) = queued(&r, &a, p, &e, &d, &preview).await;
    let path = format!(
        "/api/v1/referral-delivery/jobs/{}",
        j["id"].as_str().unwrap()
    );
    let other = actor(Uuid::new_v4(), Role::Owner);
    assert_eq!(
        call(&r, &other, "GET", &path, Value::Null, None).await.0,
        404
    );
    assert_eq!(
        call(
            &r,
            &nurse,
            "POST",
            &(path.clone() + "/actions"),
            json!({"action":"cancel","reason":"Synthetic","receipt":""}),
            Some(1)
        )
        .await
        .0,
        403
    );
    sqlx::query("CREATE FUNCTION reject_delivery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='referral.delivery.change' THEN RAISE EXCEPTION 'synthetic audit rejection'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER delivery_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_delivery_audit()").execute(&db).await.unwrap();
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &(path + "/actions"),
            json!({"action":"cancel","reason":"Synthetic","receipt":""}),
            Some(1)
        )
        .await
        .0,
        500
    );
    let status: String = sqlx::query_scalar(
        "SELECT status FROM referral_delivery_jobs WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(Uuid::parse_str(j["id"].as_str().unwrap()).unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(status, "queued");
    assert!(sqlx::query(
        "UPDATE referral_delivery_jobs SET payload='{}' WHERE tenant_id=$1 AND id=$2"
    )
    .bind(a.tenant_id)
    .bind(Uuid::parse_str(j["id"].as_str().unwrap()).unwrap())
    .execute(&db)
    .await
    .is_err());
    server.abort();
}
#[tokio::test]
async fn abandoned_dispatch_becomes_uncertain_without_resending() {
    let (db, a, _, p) = setup().await;
    let r = app(db.clone());
    let (url, server) = receiver(true).await;
    let d = configured(&db, &r, &a, &url).await;
    let e = ready(&r, &a, p).await;
    let v = reviewed(&r, &a, p, &e, &d).await;
    let (j, _) = queued(&r, &a, p, &e, &d, &v).await;
    sqlx::query("UPDATE referral_delivery_jobs SET status='sending',lease_until=now()-interval '1 minute' WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(Uuid::parse_str(j["id"].as_str().unwrap()).unwrap()).execute(&db).await.unwrap();
    suncharts_engine::referral_delivery::process_one(&db)
        .await
        .unwrap();
    let status: String = sqlx::query_scalar(
        "SELECT status FROM referral_delivery_jobs WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(Uuid::parse_str(j["id"].as_str().unwrap()).unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(status, "uncertain");
    server.abort();
}
#[tokio::test]
async fn in_flight_referral_mutations_are_blocked_until_verified_receipt_is_saved() {
    let (db, a, _, p) = setup().await;
    let r = app(db.clone());
    let arrived = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let (url, server) = receiver_mode(true, Some((arrived.clone(), release.clone()))).await;
    let d = configured(&db, &r, &a, &url).await;
    let e = ready(&r, &a, p).await;
    let v = reviewed(&r, &a, p, &e, &d).await;
    let (j, _) = queued(&r, &a, p, &e, &d, &v).await;
    let pool = db.clone();
    let worker =
        tokio::spawn(async move { suncharts_engine::referral_delivery::process_one(&pool).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), arrived.notified())
        .await
        .unwrap();
    let path = format!(
        "/api/v1/patients/{p}/referrals/{}/actions",
        e["id"].as_str().unwrap()
    );
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &path,
            json!({"action":"cancelled","reason":"Synthetic cancellation race","evidence":""}),
            Some(2)
        )
        .await
        .0,
        409
    );
    assert!(
        sqlx::query("UPDATE referrals SET status='cancelled' WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(Uuid::parse_str(e["id"].as_str().unwrap()).unwrap())
            .execute(&db)
            .await
            .is_err()
    );
    release.notify_one();
    assert!(worker.await.unwrap().unwrap());
    server.await.unwrap();
    let (_, out) = call(
        &r,
        &a,
        "GET",
        &format!(
            "/api/v1/referral-delivery/jobs/{}",
            j["id"].as_str().unwrap()
        ),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(out["status"], "sent");
    assert_eq!(out["receipt"], "synthetic-receipt-1");
}
#[tokio::test]
async fn legacy_original_packets_stay_frozen_after_file_edits_and_expired_reviews_cannot_queue() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let (db, a, _, p) = setup().await;
    let r = app(db.clone());
    let (url, server) = receiver(true).await;
    let d = configured(&db, &r, &a, &url).await;
    let bytes = b"Synthetic original referral text";
    let(status,doc)=call(&r,&a,"POST",&format!("/api/v1/patients/{p}/documents"),json!({"request_id":Uuid::new_v4(),"filename":"synthetic-referral.txt","content_type":"text/plain","content_base64":STANDARD.encode(bytes),"content":{"title":"Synthetic referral summary","category":"referral","document_date":null,"visit_id":null,"notes":"","status":"active"},"reason":"Synthetic package fixture"}),None).await;
    assert_eq!(status, 200, "{doc}");
    let e = ready_documents(
        &r,
        &a,
        p,
        vec![Uuid::parse_str(doc["id"].as_str().unwrap()).unwrap()],
    )
    .await;
    // Model an already-reviewed pre-file-version packet without rewriting a
    // historical revision or any queued delivery payload.
    let mut legacy = e["attachment_snapshot"].clone();
    legacy[0].as_object_mut().unwrap().remove("file_version");
    legacy[0].as_object_mut().unwrap().remove("annotations");
    sqlx::query("UPDATE referrals SET attachment_snapshot=$1 WHERE id=$2")
        .bind(&legacy)
        .bind(Uuid::parse_str(e["id"].as_str().unwrap()).unwrap())
        .execute(&db)
        .await
        .unwrap();
    let preview = reviewed(&r, &a, p, &e, &d).await;
    assert_eq!(preview["manifest"]["total_bytes"], bytes.len());
    assert!(!preview.to_string().contains("content_base64"));
    sqlx::query("UPDATE referral_delivery_previews SET expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND digest=$2").bind(a.tenant_id).bind(preview["review_digest"].as_str().unwrap()).execute(&db).await.unwrap();
    let path = format!(
        "/api/v1/patients/{p}/referrals/{}/delivery",
        e["id"].as_str().unwrap()
    );
    let input = json!({"request_id":Uuid::new_v4(),"destination_id":d["id"],"destination_version":d["version"],"review_digest":preview["review_digest"],"reason":"Synthetic expired review"});
    assert_eq!(call(&r, &a, "POST", &path, input, Some(2)).await.0, 409);
    let preview = reviewed(&r, &a, p, &e, &d).await;
    let (job, _) = queued(&r, &a, p, &e, &d, &preview).await;
    let job_id = Uuid::parse_str(job["id"].as_str().unwrap()).unwrap();
    let frozen: Value =
        sqlx::query_scalar("SELECT payload FROM referral_delivery_jobs WHERE id=$1")
            .bind(job_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(frozen["documents"][0]["metadata"]
        .get("file_version")
        .is_none());
    let (status, changed) = call(&r,&a,"POST",&format!("/api/v1/patients/{p}/documents/{}/files",doc["id"].as_str().unwrap()),json!({"request_id":Uuid::new_v4(),"text_content":"Synthetic newer text, never substitute into historical packet","annotations":[],"reason":"Synthetic edit after old packet queued"}),Some(1)).await;
    assert_eq!(status, 200, "{changed}");
    suncharts_engine::referral_delivery::process_one(&db)
        .await
        .unwrap();
    let (payload, _) = server.await.unwrap();
    assert_eq!(
        STANDARD
            .decode(payload["documents"][0]["content_base64"].as_str().unwrap())
            .unwrap(),
        bytes
    );
    assert_eq!(payload["documents"][0]["metadata"]["sha256"], doc["sha256"]);
    let after: Value = sqlx::query_scalar("SELECT payload FROM referral_delivery_jobs WHERE id=$1")
        .bind(job_id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(after, frozen);
    assert_eq!(after["documents"][0]["metadata"], legacy[0]);
}

#[tokio::test]
async fn new_referral_review_binds_current_file_and_rejects_edits_until_reviewed_again() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let (db, a, _, p) = setup().await;
    let r = app(db.clone());
    let (url, server) = receiver(true).await;
    let destination = configured(&db, &r, &a, &url).await;
    let (status, doc) = call(&r,&a,"POST",&format!("/api/v1/patients/{p}/documents"),json!({"request_id":Uuid::new_v4(),"filename":"synthetic-referral.txt","content_type":"text/plain","content_base64":STANDARD.encode("Synthetic original"),"content":{"title":"Synthetic working letter","category":"referral","document_date":null,"visit_id":null,"notes":"","status":"active"},"reason":"Synthetic initial upload"}),None).await;
    assert_eq!(status, 200, "{doc}");
    let file_path = format!(
        "/api/v1/patients/{p}/documents/{}/files",
        doc["id"].as_str().unwrap()
    );
    let (status, v2) = call(&r,&a,"POST",&file_path,json!({"request_id":Uuid::new_v4(),"text_content":"Synthetic reviewed version two","annotations":[],"reason":"Synthetic edit"}),Some(1)).await;
    assert_eq!(status, 200, "{v2}");
    let entry = ready_documents(
        &r,
        &a,
        p,
        vec![Uuid::parse_str(doc["id"].as_str().unwrap()).unwrap()],
    )
    .await;
    assert_eq!(entry["attachment_snapshot"][0]["file_version"], 2);
    assert_eq!(entry["attachment_snapshot"][0]["version"], 1);
    assert_eq!(entry["attachment_snapshot"][0]["sha256"], v2["sha256"]);
    let review = reviewed(&r, &a, p, &entry, &destination).await;
    assert_eq!(review["manifest"]["documents"][0]["file_version"], 2);
    let frozen_review: Value =
        sqlx::query_scalar("SELECT payload FROM referral_delivery_previews WHERE digest=$1")
            .bind(review["review_digest"].as_str().unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(
        STANDARD
            .decode(
                frozen_review["documents"][0]["content_base64"]
                    .as_str()
                    .unwrap()
            )
            .unwrap(),
        b"Synthetic reviewed version two"
    );
    let (status, v3) = call(&r,&a,"POST",&file_path,json!({"request_id":Uuid::new_v4(),"text_content":"Synthetic version three needs review","annotations":[],"reason":"Synthetic later edit"}),Some(2)).await;
    assert_eq!(status, 200, "{v3}");
    let delivery = format!(
        "/api/v1/patients/{p}/referrals/{}/delivery",
        entry["id"].as_str().unwrap()
    );
    assert_eq!(call(&r,&a,"POST",&delivery,json!({"request_id":Uuid::new_v4(),"destination_id":destination["id"],"destination_version":destination["version"],"review_digest":review["review_digest"],"reason":"Synthetic stale packet"}),Some(2)).await.0,409);
    let actions = format!(
        "/api/v1/patients/{p}/referrals/{}/actions",
        entry["id"].as_str().unwrap()
    );
    assert_eq!(call(&r,&a,"POST",&actions,json!({"action":"sent","reason":"Synthetic stale manual review","evidence":"Synthetic"}),Some(2)).await.0,409);
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &actions,
            json!({"action":"draft","reason":"Review updated letter","evidence":""}),
            Some(2)
        )
        .await
        .0,
        200
    );
    let (status, current) = call(
        &r,
        &a,
        "POST",
        &actions,
        json!({"action":"ready","reason":"Reviewed version three","evidence":""}),
        Some(3),
    )
    .await;
    assert_eq!(status, 200, "{current}");
    assert_eq!(current["attachment_snapshot"][0]["file_version"], 3);
    let current_review = reviewed(&r, &a, p, &current, &destination).await;
    queued(&r, &a, p, &current, &destination, &current_review).await;
    assert!(suncharts_engine::referral_delivery::process_one(&db)
        .await
        .unwrap());
    let (payload, _) = server.await.unwrap();
    assert_eq!(payload["documents"][0]["metadata"]["file_version"], 3);
    assert_eq!(payload["documents"][0]["metadata"]["sha256"], v3["sha256"]);
    assert_eq!(
        STANDARD
            .decode(payload["documents"][0]["content_base64"].as_str().unwrap())
            .unwrap(),
        b"Synthetic version three needs review"
    );
    let preserved: Value =
        sqlx::query_scalar("SELECT payload FROM referral_delivery_previews WHERE digest=$1")
            .bind(review["review_digest"].as_str().unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(preserved, frozen_review);
}
#[tokio::test]
async fn delayed_receipt_resolves_recovered_lease_without_overwriting_operator_reconciliation() {
    for reconcile in [false, true] {
        let (db, a, _, p) = setup().await;
        let r = app(db.clone());
        let arrived = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let (url, server) = receiver_mode(true, Some((arrived.clone(), release.clone()))).await;
        let d = configured(&db, &r, &a, &url).await;
        let e = ready(&r, &a, p).await;
        let v = reviewed(&r, &a, p, &e, &d).await;
        let (j, _) = queued(&r, &a, p, &e, &d, &v).await;
        let id = Uuid::parse_str(j["id"].as_str().unwrap()).unwrap();
        let pool = db.clone();
        let worker =
            tokio::spawn(
                async move { suncharts_engine::referral_delivery::process_one(&pool).await },
            );
        tokio::time::timeout(std::time::Duration::from_secs(5), arrived.notified())
            .await
            .unwrap();
        sqlx::query("UPDATE referral_delivery_jobs SET lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).execute(&db).await.unwrap();
        assert!(suncharts_engine::referral_delivery::process_one(&db)
            .await
            .unwrap());
        let path = format!("/api/v1/referral-delivery/jobs/{id}");
        let (_, recovered) = call(&r, &a, "GET", &path, Value::Null, None).await;
        assert_eq!(recovered["status"], "uncertain");
        assert_eq!(recovered["version"], 3);
        if reconcile {
            let(status,out)=call(&r,&a,"POST",&(path.clone()+"/actions"),json!({"action":"reconcile_not_sent","receipt":"Synthetic independent receiver evidence","reason":"Explicit operator reconciliation before delayed response"}),Some(3)).await;
            assert_eq!(status, 200, "{out}");
        }
        release.notify_one();
        assert!(worker.await.unwrap().unwrap());
        server.await.unwrap();
        let (_, out) = call(&r, &a, "GET", &path, Value::Null, None).await;
        if reconcile {
            assert_eq!(out["status"], "not_sent");
            assert_eq!(out["receipt"], "Synthetic independent receiver evidence");
        } else {
            assert_eq!(out["status"], "sent");
            assert_eq!(out["receipt"], "synthetic-receipt-1");
            assert_eq!(out["history"].as_array().unwrap().len(), 4);
        }
        let referral_status: String =
            sqlx::query_scalar("SELECT status FROM referrals WHERE tenant_id=$1 AND id=$2")
                .bind(a.tenant_id)
                .bind(Uuid::parse_str(e["id"].as_str().unwrap()).unwrap())
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(referral_status, if reconcile { "ready" } else { "sent" });
        assert!(!suncharts_engine::referral_delivery::process_one(&db)
            .await
            .unwrap());
    }
}
