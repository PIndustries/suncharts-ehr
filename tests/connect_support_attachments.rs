// SPDX-License-Identifier: AGPL-3.0-only
//! Support requests with attached records and files. The SunCharts service is a
//! local stand-in on a loopback port; nothing here contacts a real service.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::{Arc, Mutex};
use suncharts_engine::{
    auth::{Actor, Role},
    browser::BrowserAuth,
    postgres::PostgresBackend,
    State,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &str = "synthetic-support-test-secret";

/// One recorded request: request line, lower-cased headers and body bytes.
type Seen = Arc<Mutex<Vec<(String, String, Vec<u8>)>>>;

/// Stand-in for the SunCharts service. `old` behaves like a release without
/// links and files: unknown ticket fields are refused and the file routes do not exist.
async fn service(old: bool) -> (String, Seen) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen: Seen = Arc::default();
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let log = log.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let (head, body) = loop {
                    let mut part = [0; 8192];
                    let n = stream.read(&mut part).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&part[..n]);
                    if let Some(index) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&bytes[..index]).to_string();
                        let length = head
                            .lines()
                            .find_map(|v| {
                                v.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|x| x.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= index + 4 + length {
                            break (head, bytes[index + 4..].to_vec());
                        }
                    }
                };
                let line = head.lines().next().unwrap_or_default().to_owned();
                log.lock()
                    .unwrap()
                    .push((line.clone(), head.to_ascii_lowercase(), body.clone()));
                let json = |status: u16, value: Value| {
                    let text = value.to_string();
                    format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len()).into_bytes()
                };
                let response = if line.starts_with("POST") && line.contains("/support-files?") {
                    if old {
                        json(404, json!({"error":"not_found"}))
                    } else {
                        json(
                            200,
                            json!({"id":Uuid::new_v4(),"filename":"scan 1.png","content_type":"image/png","size":body.len()}),
                        )
                    }
                } else if line.starts_with("GET") && line.contains("/support-files/") {
                    let mut out = b"HTTP/1.1 200 Test\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=\"scan 1.png\"\r\nContent-Length: 9\r\nConnection: close\r\n\r\n".to_vec();
                    out.extend_from_slice(b"synthetic");
                    out
                } else if line.starts_with("POST") {
                    let sent: Value = serde_json::from_slice(&body).unwrap_or_default();
                    // An earlier release refuses any field it does not know.
                    if old
                        && (sent.get("links").is_some()
                            || sent.get("attachments").is_some()
                            || sent.get("author_email").is_some())
                    {
                        json(422, json!({}))
                    } else {
                        json(
                            200,
                            json!({"id":Uuid::new_v4(),"status":"open","messages":[]}),
                        )
                    }
                } else {
                    json(200, json!({"items":[]}))
                };
                stream.write_all(&response).await.unwrap();
            });
        }
    });
    (base, seen)
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
async fn send(
    r: &Router,
    a: &Actor,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Vec<u8>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        a,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = r
        .clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    (
        parts.status,
        parts.headers,
        body.collect().await.unwrap().to_bytes().to_vec(),
    )
}
async fn call(
    r: &Router,
    a: &Actor,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let version = version.map(|v| format!("\"{v}\""));
    let mut headers = vec![("Content-Type", "application/json")];
    if let Some(v) = &version {
        headers.push(("If-Match", v));
    }
    let (status, _, bytes) =
        send(r, a, method, path, &headers, body.to_string().into_bytes()).await;
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"message":String::from_utf8_lossy(&bytes)})),
    )
}
async fn tenant(db: &PgPool) -> Actor {
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
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login','owner',false)").bind(a.sub).bind(a.tenant_id).bind(format!("{}@example.test",a.sub.simple())).execute(db).await.unwrap();
    a
}
/// A patient with one visit and one claim; returns (patient, visit, claim).
async fn records(db: &PgPool, a: &Actor, mrn: &str, control: &str) -> (Uuid, Uuid, Uuid) {
    let (p, appointment, visit, payer, account, claim) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Avery','Synthetic','1990-01-01')").bind(a.tenant_id).bind(p).bind(mrn).execute(db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-11-01T15:00:00Z','2026-11-01T15:30:00Z','in_progress')").bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id) VALUES($1,$2,$3,$4,$5)").bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub).execute(db).await.unwrap();
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,'{}',$3,'synthetic')").bind(a.tenant_id).bind(payer).bind(Uuid::new_v4()).execute(db).await.unwrap();
    sqlx::query("INSERT INTO billing_accounts(tenant_id,id,patient_id,visit_id,content,total_cents,status,request_id,creation_hash) VALUES($1,$2,$3,$4,'{}',10000,'posted',$5,'synthetic')").bind(a.tenant_id).bind(account).bind(p).bind(visit).bind(Uuid::new_v4()).execute(db).await.unwrap();
    sqlx::query("INSERT INTO ehr_claims(tenant_id,id,patient_id,account_id,payer_id,control_number,frequency,content,snapshot,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,$6,'original','{}','{}',$7,'synthetic')").bind(a.tenant_id).bind(claim).bind(p).bind(account).bind(payer).bind(control).bind(Uuid::new_v4()).execute(db).await.unwrap();
    (p, visit, claim)
}
async fn enable_support(db: &PgPool, r: &Router, a: &Actor) {
    let services = "/api/v1/connect/services/settings";
    let (status, saved) = call(
        r,
        a,
        "PUT",
        services,
        json!({"installation_id":Uuid::new_v4(),"installation_token":"scs_inst_synthetic_private_token_12345"}),
        Some(0),
    )
    .await;
    assert_eq!(status, 200, "{saved}");
    // Verification fixture only; the real check calls the service.
    sqlx::query("UPDATE connect_service_settings SET verified=true,support_available=true WHERE tenant_id=$1").bind(a.tenant_id).execute(db).await.unwrap();
    let (status, enabled) = call(
        r,
        a,
        "POST",
        &format!("{services}/activation"),
        json!({"enabled":true}),
        Some(1),
    )
    .await;
    assert_eq!(status, 200, "{enabled}");
}
async fn database() -> PgPool {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("connect_support_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(6)
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
    db
}

// One test: the service address is process-wide configuration.
#[tokio::test]
async fn support_messages_carry_checked_links_and_files() {
    let keydir = std::env::temp_dir().join(format!("connect-support-key-{}", Uuid::new_v4()));
    std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", keydir.join("master.key"));
    std::env::set_var("ENGINE_CONNECT_ALLOW_LOOPBACK", "true");
    let (base, seen) = service(false).await;
    std::env::set_var("ENGINE_CONNECT_CLOUD_URL", &base);
    let db = database().await;
    let r = app(db.clone());
    let a = tenant(&db).await;
    let other = tenant(&db).await;
    let (p, visit, claim) = records(&db, &a, "SYN-LINK", "SC-SYN-0001").await;
    let (foreign, foreign_visit, foreign_claim) =
        records(&db, &other, "SYN-OTHER", "SC-SYN-0002").await;
    enable_support(&db, &r, &a).await;
    let tickets = "/api/v1/connect/services/tickets";
    let files = "/api/v1/connect/services/support-files";
    let sent = || seen.lock().unwrap().len();

    // Links are checked against this practice and labelled by the server.
    let file = Uuid::new_v4();
    let request = Uuid::new_v4();
    let body = json!({"request_id":request,"subject":"Synthetic claim question","message":"Operational only","links":[{"kind":"patient","id":p},{"kind":"visit","id":visit},{"kind":"claim","id":claim},{"kind":"patient","id":p}],"attachments":[file]});
    let (status, created) = call(&r, &a, "POST", tickets, body.clone(), None).await;
    assert_eq!(status, 200, "{created}");
    let (line, head, forwarded) = seen.lock().unwrap().last().unwrap().clone();
    assert!(
        line.starts_with("POST /api/v1/ehr-services/installations/") && line.contains("/tickets ")
    );
    assert!(head.contains("authorization: bearer scs_inst_synthetic_private_token_12345"));
    let forwarded: Value = serde_json::from_slice(&forwarded).unwrap();
    assert_eq!(
        forwarded,
        json!({"request_id":request,"subject":"Synthetic claim question","message":"Operational only","links":[{"kind":"patient","id":p,"label":"MRN SYN-LINK"},{"kind":"visit","id":visit,"label":"Visit 2026-11-01 · MRN SYN-LINK"},{"kind":"claim","id":claim,"label":"Claim SC-SYN-0001 · MRN SYN-LINK"}],"attachments":[file],"author_email":format!("{}@example.test", a.sub.simple())}),
        "the ticket names the staff member who opened it"
    );
    // A session that is not one of the clinic's staff accounts names nobody, and a
    // reply never does: Connect already knows the conversation.
    let mut delegated = a.clone();
    delegated.sub = Uuid::new_v4();
    let unnamed =
        json!({"request_id":Uuid::new_v4(),"subject":"Synthetic","message":"Operational only"});
    assert_eq!(
        call(&r, &delegated, "POST", tickets, unnamed.clone(), None)
            .await
            .0,
        200
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&seen.lock().unwrap().last().unwrap().2).unwrap(),
        unnamed
    );
    let answer = json!({"request_id":Uuid::new_v4(),"message":"Operational only"});
    let replies = format!("{tickets}/{}/replies", Uuid::new_v4());
    assert_eq!(
        call(&r, &a, "POST", &replies, answer.clone(), None).await.0,
        200
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&seen.lock().unwrap().last().unwrap().2).unwrap(),
        answer
    );
    assert!(
        !forwarded.to_string().contains("Avery") && !forwarded.to_string().contains("Synthetic\"")
    );
    let linked: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='connect.support_record_linked' AND resource_id=ANY($2)").bind(a.tenant_id).bind(vec![p, visit, claim]).fetch_one(&db).await.unwrap();
    assert_eq!(linked, 3);
    // The same request again is the same request; changed content under that ID is refused locally.
    let before = sent();
    assert_eq!(
        call(&r, &a, "POST", tickets, body.clone(), None).await.0,
        200
    );
    assert_eq!(sent(), before + 1);
    let mut changed = body.clone();
    changed["links"] = json!([{"kind":"patient","id":p}]);
    assert_eq!(call(&r, &a, "POST", tickets, changed, None).await.0, 409);
    assert_eq!(sent(), before + 1);

    // Another practice's records, unknown records, client labels and oversize lists never leave.
    let before = sent();
    for (kind, id) in [
        ("patient", foreign),
        ("visit", foreign_visit),
        ("claim", foreign_claim),
        ("patient", Uuid::new_v4()),
        ("visit", p),
        ("claim", visit),
    ] {
        let (status, refused) = call(&r,&a,"POST",tickets,json!({"request_id":Uuid::new_v4(),"subject":"Synthetic","message":"Operational only","links":[{"kind":kind,"id":id}]}),None).await;
        assert_eq!(status, 400, "{kind} {refused}");
        assert_eq!(
            refused["message"],
            "An attached patient, visit or claim could not be found."
        );
    }
    let reply = format!("{tickets}/{}/replies", Uuid::new_v4());
    assert_eq!(call(&r,&a,"POST",&reply,json!({"request_id":Uuid::new_v4(),"message":"Operational only","links":[{"kind":"claim","id":foreign_claim}]}),None).await.0,400);
    assert_eq!(call(&r,&a,"POST",tickets,json!({"request_id":Uuid::new_v4(),"subject":"Synthetic","message":"Operational only","links":[{"kind":"patient","id":p,"label":"Synthetic, Avery"}]}),None).await.0,422);
    assert_eq!(call(&r,&a,"POST",tickets,json!({"request_id":Uuid::new_v4(),"subject":"Synthetic","message":"Operational only","links":[{"kind":"chart","id":p}]}),None).await.0,422);
    let many: Vec<Value> = (0..11)
        .map(|_| json!({"kind":"patient","id":Uuid::new_v4()}))
        .collect();
    assert_eq!(call(&r,&a,"POST",tickets,json!({"request_id":Uuid::new_v4(),"subject":"Synthetic","message":"Operational only","links":many}),None).await.0,400);
    let six: Vec<Uuid> = (0..6).map(|_| Uuid::new_v4()).collect();
    let (status, refused) = call(&r,&a,"POST",tickets,json!({"request_id":Uuid::new_v4(),"subject":"Synthetic","message":"Operational only","attachments":six}),None).await;
    assert_eq!(
        (status, refused["message"].as_str()),
        (StatusCode::BAD_REQUEST, Some("Up to 5 files per message."))
    );
    assert_eq!(sent(), before, "refused messages are not forwarded");
    // A reply carries links the same way; a plain reply is forwarded exactly as before.
    let reply_request = Uuid::new_v4();
    assert_eq!(call(&r,&a,"POST",&reply,json!({"request_id":reply_request,"message":"Operational only","links":[{"kind":"visit","id":visit}]}),None).await.0,200);
    assert_eq!(
        serde_json::from_slice::<Value>(&seen.lock().unwrap().last().unwrap().2).unwrap(),
        json!({"request_id":reply_request,"message":"Operational only","links":[{"kind":"visit","id":visit,"label":"Visit 2026-11-01 · MRN SYN-LINK"}]})
    );
    let plain = Uuid::new_v4();
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &reply,
            json!({"request_id":plain,"message":"Operational only"}),
            None
        )
        .await
        .0,
        200
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&seen.lock().unwrap().last().unwrap().2).unwrap(),
        json!({"request_id":plain,"message":"Operational only"})
    );

    // Files: bytes, type and name are forwarded; limits and types are enforced before anything is sent.
    let upload = Uuid::new_v4();
    let path = format!("{files}?request_id={upload}");
    let png = [
        ("Content-Type", "image/png"),
        ("X-Filename", "scan%201.png"),
    ];
    let (status, _, bytes) = send(&r, &a, "POST", &path, &png, b"synthetic".to_vec()).await;
    let stored: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, 200, "{stored}");
    assert_eq!(
        (
            stored["filename"].as_str(),
            stored["content_type"].as_str(),
            stored["size"].as_u64()
        ),
        (Some("scan 1.png"), Some("image/png"), Some(9))
    );
    assert!(Uuid::parse_str(stored["id"].as_str().unwrap()).is_ok());
    let (line, head, forwarded) = seen.lock().unwrap().last().unwrap().clone();
    assert!(line.contains(&format!("/support-files?request_id={upload} ")));
    assert!(head.contains("content-type: image/png") && head.contains("x-filename: scan%201.png"));
    assert_eq!(forwarded, b"synthetic");
    let before = sent();
    assert_eq!(
        send(&r, &a, "POST", &path, &png, b"synthetic".to_vec())
            .await
            .0,
        200
    );
    assert_eq!(
        sent(),
        before + 1,
        "an unchanged retry is forwarded under the same request ID"
    );
    assert_eq!(
        send(&r, &a, "POST", &path, &png, b"different".to_vec())
            .await
            .0,
        409
    );
    assert_eq!(
        send(
            &r,
            &a,
            "POST",
            &path,
            &[("Content-Type", "image/png"), ("X-Filename", "renamed.png")],
            b"synthetic".to_vec()
        )
        .await
        .0,
        409
    );
    let fresh = || format!("{files}?request_id={}", Uuid::new_v4());
    assert_eq!(send(&r, &a, "POST", &fresh(), &png, vec![]).await.0, 400);
    assert_eq!(
        send(
            &r,
            &a,
            "POST",
            &fresh(),
            &[("Content-Type", "text/html"), ("X-Filename", "page.html")],
            b"x".to_vec()
        )
        .await
        .0,
        400
    );
    assert_eq!(
        send(
            &r,
            &a,
            "POST",
            &fresh(),
            &[("Content-Type", "image/png")],
            b"x".to_vec()
        )
        .await
        .0,
        400
    );
    assert_eq!(
        send(&r, &a, "POST", files, &png, b"x".to_vec()).await.0,
        400
    );
    assert_eq!(
        send(
            &r,
            &a,
            "POST",
            &fresh(),
            &png,
            vec![0; 10 * 1024 * 1024 + 1]
        )
        .await
        .0,
        413
    );
    assert_eq!(sent(), before + 1, "refused files are not forwarded");
    assert_eq!(
        send(
            &r,
            &a,
            "POST",
            &fresh(),
            &[
                ("Content-Type", "application/pdf"),
                ("X-Filename", "limit.pdf")
            ],
            vec![7; 10 * 1024 * 1024]
        )
        .await
        .0,
        200
    );
    assert_eq!(
        seen.lock().unwrap().last().unwrap().2.len(),
        10 * 1024 * 1024
    );

    // Reading a file returns the bytes uncached; an image may be shown in place.
    let read = format!("{files}/{}", stored["id"].as_str().unwrap());
    let (status, headers, bytes) = send(&r, &a, "GET", &read, &[], vec![]).await;
    assert_eq!(
        (status, bytes.as_slice()),
        (StatusCode::OK, &b"synthetic"[..])
    );
    assert_eq!(headers["content-type"], "image/png");
    assert_eq!(
        headers["content-disposition"],
        "inline; filename=\"scan 1.png\""
    );
    assert_eq!(headers["cache-control"], "no-store");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert!(seen
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .0
        .starts_with("GET /api/v1/ehr-services/installations/"));
    assert_eq!(
        send(&r, &a, "GET", &format!("{files}/not-a-file"), &[], vec![])
            .await
            .0,
        400
    );

    // Roles: the same staff who may use support tickets, nobody else.
    let before = sent();
    for role in [Role::ReadOnly, Role::Patient] {
        let mut limited = a.clone();
        limited.role = role;
        if matches!(limited.role, Role::Patient) {
            limited.patient_id = Some(p);
        }
        assert_eq!(
            send(&r, &limited, "POST", &fresh(), &png, b"x".to_vec())
                .await
                .0,
            403
        );
        assert_eq!(send(&r, &limited, "GET", &read, &[], vec![]).await.0, 403);
        assert_eq!(call(&r,&limited,"POST",tickets,json!({"request_id":Uuid::new_v4(),"subject":"Synthetic","message":"Operational only","links":[{"kind":"patient","id":p}]}),None).await.0,403);
    }
    let mut front_desk = a.clone();
    front_desk.role = Role::FrontDesk;
    assert_eq!(
        send(&r, &front_desk, "POST", &fresh(), &png, b"x".to_vec())
            .await
            .0,
        200
    );
    assert_eq!(sent(), before + 1);
    // A practice without the service configured reaches nothing.
    assert_eq!(
        send(&r, &other, "POST", &fresh(), &png, b"x".to_vec())
            .await
            .0,
        404
    );
    assert_eq!(send(&r, &other, "GET", &read, &[], vec![]).await.0, 404);
    assert_eq!(sent(), before + 1);

    // A service release without links and files: say so, and let the plain message through.
    let (old, old_seen) = service(true).await;
    std::env::set_var("ENGINE_CONNECT_CLOUD_URL", &old);
    let (status, _, bytes) = send(&r, &a, "POST", &fresh(), &png, b"x".to_vec()).await;
    let refused: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        (status, refused["error"].as_str()),
        (
            StatusCode::CONFLICT,
            Some("support_attachments_unavailable")
        )
    );
    let (status, refused) = call(&r,&a,"POST",tickets,json!({"request_id":Uuid::new_v4(),"subject":"Synthetic","message":"Operational only","links":[{"kind":"patient","id":p}]}),None).await;
    assert_eq!(
        (status, refused["error"].as_str()),
        (
            StatusCode::CONFLICT,
            Some("support_attachments_unavailable")
        )
    );
    assert_eq!(
        refused["message"],
        "Support cannot receive attached records or files yet."
    );
    let plain = Uuid::new_v4();
    let earlier = old_seen.lock().unwrap().len();
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            tickets,
            json!({"request_id":plain,"subject":"Synthetic","message":"Operational only"}),
            None
        )
        .await
        .0,
        200
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&old_seen.lock().unwrap().last().unwrap().2).unwrap(),
        json!({"request_id":plain,"subject":"Synthetic","message":"Operational only"})
    );
    // That earlier release was asked once with the author and once without, no more.
    let attempts: Vec<Value> = old_seen.lock().unwrap()[earlier..]
        .iter()
        .map(|(_, _, body)| serde_json::from_slice(body).unwrap())
        .collect();
    assert_eq!(attempts.len(), 2);
    assert_eq!(
        attempts[0]["author_email"],
        format!("{}@example.test", a.sub.simple())
    );
    assert_eq!(attempts[0]["request_id"], attempts[1]["request_id"]);
    db.close().await;
}
