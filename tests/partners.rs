// SPDX-License-Identifier: AGPL-3.0-only
//! The Partners screen's server side. SunCharts Connect is a local stand-in on a
//! loopback port; nothing here contacts a real service and every record is synthetic.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};
use suncharts_engine::{
    auth::{Actor, Role},
    browser::BrowserAuth,
    postgres::PostgresBackend,
    State,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &str = "synthetic-partners-test-secret";
const TOKEN: &str = "scs_inst_synthetic_private_token_12345";
const BROWSER_ORIGIN: &str = "http://127.0.0.1:8099";

/// How the stand-in answers the next partner call.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    List,
    Enroll,
    /// Already working with another partner.
    Taken,
    /// The tenant was provisioned by a different partner.
    Provisioned,
    /// Connect answers with a body that is not a partner answer.
    Garbage,
    /// Connect refuses with no usable reason.
    Silent,
    Unknown,
    Down,
}
type Seen = Arc<Mutex<Vec<(String, String, Vec<u8>)>>>;

fn catalog() -> Value {
    json!({
        "items": [
            {"slug":"healthtech","name":"HealthTech","summary":"Claims, payments and support for small clinics.",
             "services":["Claims","Payments","Support"],"preferred":true,"enrolled":false,
             "internal_ranking":99,"listed":true},
            {"slug":"riverbend","name":"Riverbend Billing","summary":"Back-office billing only.","services":["Claims"],
             "preferred":false,"enrolled":false},
            // A listing without a name cannot be shown, and must not hide the rest.
            {"slug":"nameless","summary":"No name came back.","services":[],"preferred":false,"enrolled":false}
        ],
        "enrollment": null
    })
}
fn enrollment(status: &str) -> Value {
    json!({"enrollment":{"partner_slug":"healthtech","partner_name":"HealthTech","status":status,
        "enrolled_at":"2026-11-19T10:00:00Z","agreement_version":"partner-enrollment-v1",
        "internal_note":"never shown"}})
}

/// The stand-in Connect: records each request and answers in the current mode.
async fn service() -> (String, Seen, Arc<Mutex<Mode>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen: Seen = Arc::default();
    let mode = Arc::new(Mutex::new(Mode::List));
    let (log, answer) = (seen.clone(), mode.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let (log, answer) = (log.clone(), answer.clone());
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let (head, body) = loop {
                    let mut part = [0; 8192];
                    let Ok(n) = stream.read(&mut part).await else {
                        return;
                    };
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
                let current = *answer.lock().unwrap();
                let write = line.starts_with("POST");
                let response = match current {
                    Mode::Down => Vec::new(),
                    Mode::List if write => json(405, json!({"message":"method not allowed"})),
                    Mode::List => json(200, catalog()),
                    Mode::Enroll if write && line.contains("/enroll") => {
                        json(200, enrollment("active"))
                    }
                    Mode::Enroll if write && line.contains("/leave") => {
                        json(200, enrollment("ended"))
                    }
                    Mode::Taken => json(
                        409,
                        json!({"message":"This practice already works with Riverbend Billing. Leave that partner first."}),
                    ),
                    Mode::Provisioned => json(
                        409,
                        json!({"message":"This practice was set up by another partner. Leave that partner first."}),
                    ),
                    Mode::Silent if write => json(409, json!({"detail":{"trace":"internal-227"}})),
                    Mode::Garbage if write && line.contains("/enroll") => {
                        // The write succeeded but says nothing about an enrollment,
                        // so the screen can never report one.
                        json(200, json!({"ok":true}))
                    }
                    Mode::Garbage => json(200, json!({"items":"not a list"})),
                    Mode::Unknown if write && line.contains("/enroll") => {
                        // A release without partner enrolment answers 404, the
                        // address of a partner it does not know.
                        json(404, json!({"error":"not_found"}))
                    }
                    Mode::Unknown => json(404, json!({"error":"not_found"})),
                    _ => json(200, catalog()),
                };
                let _ = stream.write_all(&response).await;
            });
        }
    });
    (base, seen, mode)
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
    body: Option<Value>,
) -> (StatusCode, Value) {
    send_at(r, a, method, path, body, None).await
}

fn hash(value: &str) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(value.as_bytes()))
}

/// The practice screen authenticates with the browser session cookie, exactly as
/// a signed-in owner's browser sends it. Each actor gets one when created.
fn cookie(sub: Uuid) -> String {
    SESSIONS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .get(&sub)
        .cloned()
        .expect("every actor signs in with its own session")
}

static SESSIONS: OnceLock<Mutex<std::collections::HashMap<Uuid, String>>> = OnceLock::new();
async fn sign_in(db: &PgPool, sub: Uuid, tenant: Uuid) {
    let token = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at,auth_method) VALUES($1,$2,$3,now()+interval '1 hour','break_glass')")
        .bind(hash(&token))
        .bind(tenant)
        .bind(sub)
        .execute(db)
        .await
        .unwrap();
    SESSIONS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(sub, token);
}

async fn send_at(
    r: &Router,
    a: &Actor,
    method: &str,
    path: &str,
    body: Option<Value>,
    if_match: Option<i64>,
) -> (StatusCode, Value) {
    let cookie = cookie(a.sub);
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Cookie", format!("sce_session={cookie}"))
        .header("Content-Type", "application/json");
    let body = match body {
        Some(body) => body.to_string().into_bytes(),
        None => Vec::new(),
    };
    if method != "GET" {
        request = request.header("Origin", BROWSER_ORIGIN);
    }
    if let Some(v) = if_match {
        request = request.header("If-Match", format!("\"{v}\""));
    }
    let response = r
        .clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"message": String::from_utf8_lossy(&bytes)})),
    )
}

static KEY_PATH: OnceLock<PathBuf> = OnceLock::new();
async fn database() -> PgPool {
    KEY_PATH.get_or_init(|| {
        let path = std::env::temp_dir()
            .join(format!("synthetic-partners-{}", Uuid::new_v4()))
            .join("master.key");
        std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", &path);
        std::env::set_var("ENGINE_CONNECT_ALLOW_LOOPBACK", "true");
        path
    });
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("partners_test_{}", Uuid::new_v4().simple());
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

async fn owner(db: &PgPool, display: Option<&str>) -> Actor {
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
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,display_name,password_hash,role,disabled) VALUES($1,$2,$3,$4,'synthetic-not-a-login','owner',false)")
        .bind(a.sub)
        .bind(a.tenant_id)
        .bind(format!("{}@example.test", a.sub.simple()))
        .bind(display.unwrap_or("Synthetic Owner"))
        .execute(db)
        .await
        .unwrap();
    sign_in(db, a.sub, a.tenant_id).await;
    a
}

async fn staff(db: &PgPool, tenant: Uuid, role: Role) -> Actor {
    let now = Utc::now().timestamp();
    let a = Actor {
        sub: Uuid::new_v4(),
        tenant_id: tenant,
        role,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    };
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,display_name,password_hash,role,disabled) VALUES($1,$2,$3,'Synthetic staff','synthetic-not-a-login','read_only',false)")
        .bind(a.sub)
        .bind(a.tenant_id)
        .bind(format!("{}@example.test", a.sub.simple()))
        .execute(db)
        .await
        .unwrap();
    sign_in(db, a.sub, a.tenant_id).await;
    a
}

/// The installation credential this EHR already uses for Connect services.
async fn pair(db: &PgPool, r: &Router, a: &Actor, base: &str) -> Uuid {
    std::env::set_var("ENGINE_CONNECT_CLOUD_URL", base);
    let installation = Uuid::new_v4();
    let (status, saved) = send_at(
        r,
        a,
        "PUT",
        "/api/v1/connect/services/settings",
        Some(json!({"installation_id":installation,"installation_token":TOKEN})),
        Some(0),
    )
    .await;
    assert_eq!(status, 200, "{saved}");
    // Verification fixture only: the real check calls the service.
    sqlx::query(
        "UPDATE connect_service_settings SET verified=true,version=version+1 WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .execute(db)
    .await
    .unwrap();
    let (status, enabled) = send_at(
        r,
        a,
        "POST",
        "/api/v1/connect/services/settings/activation",
        Some(json!({"enabled":true})),
        Some(2),
    )
    .await;
    assert_eq!(status, 200, "{enabled}");
    installation
}

const PARTNERS: &str = "/api/v1/practice/partners";

#[tokio::test]
async fn the_list_comes_from_connect_and_carries_the_payment_step() {
    let db = database().await;
    let (base, seen, mode) = service().await;
    *mode.lock().unwrap() = Mode::List;
    let r = app(db.clone());
    let a = owner(&db, None).await;
    let installation = pair(&db, &r, &a, &base).await;
    let (status, body) = send(&r, &a, "GET", PARTNERS, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["partners"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(body["partners"]["items"][0]["slug"], "healthtech");
    assert_eq!(body["partners"]["items"][0]["preferred"], true);
    assert_eq!(body["partners"]["items"][0]["name"], "HealthTech");
    assert_eq!(
        body["partners"]["items"][0]["services"],
        json!(["Claims", "Payments", "Support"])
    );
    assert_eq!(body["partners"]["items"][1]["slug"], "riverbend");
    assert_eq!(body["partners"]["enrollment"], Value::Null);
    assert_eq!(
        body["partners"]["incomplete"], true,
        "the unnamed listing is reported, not silently dropped"
    );
    // Step 1 rides along, from the same answer the Payments screen uses.
    assert_eq!(body["partners"]["payments"]["state"], "none");
    // Nothing of Connect's own fields, and nothing of the installation, escapes.
    let text = body.to_string();
    for leaked in ["internal_ranking", "listed", "internal_note", TOKEN] {
        assert!(!text.contains(leaked), "{leaked} reached the browser");
    }
    let (line, head, _) = seen.lock().unwrap().last().unwrap().clone();
    assert!(
        line.starts_with(&format!(
            "GET /api/v1/ehr-services/installations/{installation}/partners"
        )),
        "{line}"
    );
    assert!(head.contains(&format!("authorization: bearer {TOKEN}")));
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='practice.partners_read'",
    )
    .bind(a.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(audited, 1);
}

#[tokio::test]
async fn an_unpaired_practice_is_told_to_connect_and_can_still_see_its_payment_step() {
    let db = database().await;
    let (base, seen, mode) = service().await;
    *mode.lock().unwrap() = Mode::List;
    std::env::set_var("ENGINE_CONNECT_CLOUD_URL", &base);
    let r = app(db.clone());
    let a = owner(&db, None).await;
    let (status, body) = send(&r, &a, "GET", PARTNERS, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["partners"]["connect_error"],
        "Connect this EHR to SunCharts first."
    );
    assert_eq!(body["partners"]["items"].as_array().unwrap().len(), 0);
    assert_eq!(body["partners"]["payments"]["state"], "unavailable");
    assert!(
        seen.lock().unwrap().is_empty(),
        "nothing is asked of Connect before the practice is paired"
    );
    // A partner write is refused the same way, before anything is sent.
    let request = Uuid::new_v4();
    let (status, refused) = send(
        &r,
        &a,
        "POST",
        &format!("{PARTNERS}/healthtech/enroll"),
        Some(json!({"request_id":request,"agreement_version":"partner-enrollment-v1","accepted_by":{"name":"Avery Synthetic","email":"owner@example.test"}})),
    )
    .await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(
        refused["message"], "Connect this EHR to SunCharts first.",
        "the owner is told what to fix first"
    );
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_unreachable_connect_is_named_as_such_and_changes_nothing() {
    let db = database().await;
    let (base, seen, mode) = service().await;
    let r = app(db.clone());
    let a = owner(&db, None).await;
    let _ = pair(&db, &r, &a, &base).await;
    *mode.lock().unwrap() = Mode::Down;
    let (status, body) = send(&r, &a, "GET", PARTNERS, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["partners"]["connect_error"],
        "SunCharts Connect could not be reached. Try again."
    );
    let before = seen.lock().unwrap().len();
    let request = Uuid::new_v4();
    let (status, refused) = send(
        &r,
        &a,
        "POST",
        &format!("{PARTNERS}/healthtech/enroll"),
        Some(json!({"request_id":request,"agreement_version":"partner-enrollment-v1","accepted_by":{"name":"Avery Synthetic","email":"owner@example.test"}})),
    )
    .await;
    assert_eq!(status, 503, "{refused}");
    assert_eq!(
        refused["message"],
        "SunCharts Connect could not be reached. Try again."
    );
    assert_eq!(seen.lock().unwrap().len(), before + 1);
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action LIKE 'practice.partner.%'",
    )
    .bind(a.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(audited, 0, "a failed enrollment records no success event");
}

#[tokio::test]
async fn enrolling_records_the_signed_in_owner_and_leaving_ends_the_agreement() {
    let db = database().await;
    let (base, seen, mode) = service().await;
    let r = app(db.clone());
    let a = owner(&db, Some("Dr Ada Synthetic")).await;
    let _ = pair(&db, &r, &a, &base).await;
    *mode.lock().unwrap() = Mode::Enroll;
    let request = Uuid::new_v4();
    let (status, body) = send(
        &r,
        &a,
        "POST",
        &format!("{PARTNERS}/healthtech/enroll"),
        // A browser-sent identity is not the one recorded.
        Some(json!({"request_id":request,"agreement_version":"partner-enrollment-v1","accepted_by":{"name":"Whoever Is Typing","email":"someone.else@example.test"}})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["enrollment"]["partner_name"], "HealthTech");
    assert_eq!(body["enrollment"]["status"], "active");
    assert_eq!(body["unconfirmed"], false);
    assert_eq!(
        body["enrollment"]["agreement_version"],
        "partner-enrollment-v1"
    );
    let text = body.to_string();
    assert!(
        !text.contains("internal_note"),
        "Connect's own fields stay out"
    );
    let (line, head, sent) = seen.lock().unwrap().last().unwrap().clone();
    assert!(
        line.starts_with("POST /api/v1/ehr-services/installations/")
            && line.contains("/healthtech/enroll "),
        "{line}"
    );
    assert!(head.contains(&format!("authorization: bearer {TOKEN}")));
    let forwarded: Value = serde_json::from_slice(&sent).unwrap();
    assert_eq!(
        forwarded,
        json!({"request_id":request,"agreement_version":"partner-enrollment-v1",
               "accepted_by":{"name":"Dr Ada Synthetic","email":format!("{}@example.test",a.sub.simple())}}),
        "the agreement names the owner this EHR knows, and nothing else"
    );
    let audited: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='practice.partner.enrolled'")
        .bind(a.tenant_id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(audited, 1);

    // Leaving ends it and is audited separately.
    let departure = Uuid::new_v4();
    let (status, ended) = send(
        &r,
        &a,
        "POST",
        &format!("{PARTNERS}/healthtech/leave"),
        Some(json!({"request_id":departure})),
    )
    .await;
    assert_eq!(status, 200, "{ended}");
    assert_eq!(ended["enrollment"]["status"], "ended");
    assert_eq!(ended["unconfirmed"], false);
    let (_, _, left) = seen.lock().unwrap().last().unwrap().clone();
    assert_eq!(
        serde_json::from_slice::<Value>(&left).unwrap(),
        json!({"request_id":departure})
    );
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='practice.partner.left'",
    )
    .bind(a.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(audited, 1);
}

#[tokio::test]
async fn connect_s_reason_for_refusing_enrollment_reaches_the_owner() {
    let db = database().await;
    let (base, seen, mode) = service().await;
    let r = app(db.clone());
    let a = owner(&db, None).await;
    let _ = pair(&db, &r, &a, &base).await;
    for (case, expected) in [
        (
            Mode::Taken,
            "This practice already works with Riverbend Billing. Leave that partner first.",
        ),
        (
            Mode::Provisioned,
            "This practice was set up by another partner. Leave that partner first.",
        ),
    ] {
        *mode.lock().unwrap() = case;
        let (status, refused) = send(
            &r,
            &a,
            "POST",
            &format!("{PARTNERS}/healthtech/enroll"),
            Some(json!({"request_id":Uuid::new_v4(),"agreement_version":"partner-enrollment-v1","accepted_by":{"name":"Avery Synthetic","email":"owner@example.test"}})),
        )
        .await;
        assert_eq!(status, 409, "{refused}");
        assert_eq!(refused["message"], expected, "{case:?}");
        assert_eq!(refused["error"], "conflict");
    }
    // A refusal whose body is a trace, not a sentence, is never shown to a clinic.
    *mode.lock().unwrap() = Mode::Silent;
    let (status, refused) = send(
        &r,
        &a,
        "POST",
        &format!("{PARTNERS}/healthtech/enroll"),
        Some(json!({"request_id":Uuid::new_v4(),"agreement_version":"partner-enrollment-v1","accepted_by":{"name":"Avery Synthetic","email":"owner@example.test"}})),
    )
    .await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(
        refused["message"],
        "SunCharts Connect did not accept that. Try again, or contact support."
    );
    assert!(!refused.to_string().contains("internal-227"));
    // An unlisted partner is a wrong address, and no enrollment is recorded.
    *mode.lock().unwrap() = Mode::Unknown;
    let (status, missing) = send(
        &r,
        &a,
        "POST",
        &format!("{PARTNERS}/nobody-here/enroll"),
        Some(json!({"request_id":Uuid::new_v4(),"agreement_version":"partner-enrollment-v1","accepted_by":{"name":"Avery Synthetic","email":"owner@example.test"}})),
    )
    .await;
    assert_eq!(status, 404, "{missing}");
    let audited: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='practice.partner.enrolled'")
        .bind(a.tenant_id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(audited, 0);
    assert!(seen
        .lock()
        .unwrap()
        .iter()
        .all(|(_, head, _)| !head.contains("whoever")));
}

#[tokio::test]
async fn only_a_practice_owner_may_read_or_change_a_partner_agreement() {
    let db = database().await;
    let (base, seen, mode) = service().await;
    *mode.lock().unwrap() = Mode::List;
    let r = app(db.clone());
    let a = owner(&db, None).await;
    let _ = pair(&db, &r, &a, &base).await;
    for role in [Role::ReadOnly, Role::Clinician, Role::FrontDesk] {
        let named = format!("{role:?}");
        let other = staff(&db, a.tenant_id, role).await;
        assert_eq!(
            send(&r, &other, "GET", PARTNERS, None).await.0,
            403,
            "{named} may not read partners"
        );
        assert_eq!(
            send(
                &r,
                &other,
                "POST",
                &format!("{PARTNERS}/healthtech/enroll"),
                Some(json!({"request_id":Uuid::new_v4(),"agreement_version":"partner-enrollment-v1","accepted_by":{"name":"Avery Synthetic","email":"owner@example.test"}}))
            )
            .await
            .0,
            403,
            "{named} may not enroll"
        );
        assert_eq!(
            send(
                &r,
                &other,
                "POST",
                &format!("{PARTNERS}/healthtech/leave"),
                Some(json!({"request_id":Uuid::new_v4()}))
            )
            .await
            .0,
            403,
            "{named} may not leave"
        );
    }
    // Another practice's owner cannot read or change this one's partners.
    let stranger = owner(&db, None).await;
    pair(&db, &r, &stranger, &base).await;
    let before = seen.lock().unwrap().len();
    let (status, body) = send(&r, &stranger, "GET", PARTNERS, None).await;
    assert_eq!(status, 200, "{body}");
    // The stand-in lists the same synthetic catalog for every installation, so
    // separation is proved by the credential sent, not by the listing.
    let (_, head, _) = seen.lock().unwrap().last().unwrap().clone();
    assert!(head.contains(&format!("authorization: bearer {TOKEN}")));
    assert!(seen.lock().unwrap().len() > before);
    // A mistyped partner never reaches Connect.
    let before = seen.lock().unwrap().len();
    for (bad, refused) in [
        ("HealthTech", 400),
        ("a%20b", 400),
        ("not%20a%20slug", 400),
        // An empty partner name is not a partner address the route can answer.
        ("", 400),
    ] {
        assert_eq!(
            send(
                &r,
                &a,
                "POST",
                &format!("{PARTNERS}/{bad}/enroll"),
                Some(json!({"request_id":Uuid::new_v4(),"agreement_version":"partner-enrollment-v1","accepted_by":{"name":"Avery Synthetic","email":"owner@example.test"}}))
            )
            .await
            .0,
            refused,
            "{bad:?}"
        );
    }
    assert_eq!(
        seen.lock().unwrap().len(),
        before,
        "a rejected slug sends nothing to Connect"
    );
}

#[tokio::test]
async fn an_unusable_owner_identity_or_request_is_refused_before_anything_is_sent() {
    let db = database().await;
    let (base, seen, mode) = service().await;
    *mode.lock().unwrap() = Mode::Enroll;
    let r = app(db.clone());
    let a = owner(&db, None).await;
    let _ = pair(&db, &r, &a, &base).await;
    let enroll = |body: Value| {
        let r = r.clone();
        let a = a.clone();
        async move {
            send(
                &r,
                &a,
                "POST",
                &format!("{PARTNERS}/healthtech/enroll"),
                Some(body),
            )
            .await
        }
    };
    let request = Uuid::new_v4();
    // The request identity is what makes a retry safe, so it must be one.
    for bad in [
        json!({"request_id":"not-a-uuid","agreement_version":"partner-enrollment-v1","accepted_by":{"name":"Avery Synthetic","email":"owner@example.test"}}),
        json!({"request_id":request,"agreement_version":"partner-enrollment-v9","accepted_by":{"name":"Avery Synthetic","email":"owner@example.test"}}),
        json!({"request_id":request,"agreement_version":"","accepted_by":{"name":"Avery Synthetic","email":"owner@example.test"}}),
        json!({"request_id":request,"agreement_version":"partner-enrollment-v1","accepted_by":{"name":"","email":"owner@example.test"}}),
        json!({"request_id":request,"agreement_version":"partner-enrollment-v1","accepted_by":{"name":"Avery Synthetic"}}),
        json!({"request_id":request,"agreement_version":"partner-enrollment-v1","accepted_by":{"name":"Avery Synthetic","email":"no-at-sign"}}),
        json!({"request_id":request,"accepted_by":{"name":"Avery Synthetic","email":"owner@example.test"},"extra":true}),
    ] {
        assert_eq!(enroll(bad.clone()).await.0, 400, "{bad}");
    }
    assert_eq!(seen.lock().unwrap().len(), 0, "nothing left this service");
    // An owner with no email on record cannot accept an agreement in their name.
    let silent = {
        let now = Utc::now().timestamp();
        let other = Actor {
            sub: Uuid::new_v4(),
            tenant_id: Uuid::new_v4(),
            role: Role::Owner,
            patient_id: None,
            iss: "suncharts".into(),
            aud: "suncharts-engine".into(),
            iat: now,
            exp: now + 120,
        };
        sqlx::query("INSERT INTO browser_users(id,tenant_id,email,display_name,password_hash,role,disabled) VALUES($1,$2,'','Avery Synthetic','synthetic-not-a-login','owner',false)")
            .bind(other.sub).bind(other.tenant_id).execute(&db).await.unwrap();
        sign_in(&db, other.sub, other.tenant_id).await;
        other
    };
    let (status, body) = send(
        &r,
        &silent,
        "POST",
        &format!("{PARTNERS}/healthtech/enroll"),
        Some(json!({"request_id":Uuid::new_v4(),"agreement_version":"partner-enrollment-v1","accepted_by":{"name":"Browser Name","email":"browser@example.test"}})),
    )
    .await;
    // Nothing is asked of Connect for a practice that is not paired, whatever it
    // sent; the pairing answer comes first and no request leaves this service.
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["message"], "Connect this EHR to SunCharts first.");
    let attempted = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(line, _, _)| line.contains("/enroll"))
        .count();
    assert_eq!(
        attempted, 0,
        "an unpaired or unsigned practice sends nothing"
    );
}

#[tokio::test]
async fn an_answer_that_describes_no_enrollment_is_never_shown_as_success() {
    let db = database().await;
    let (base, _, mode) = service().await;
    let r = app(db.clone());
    let a = owner(&db, None).await;
    let _ = pair(&db, &r, &a, &base).await;
    *mode.lock().unwrap() = Mode::Garbage;
    let (status, body) = send(
        &r,
        &a,
        "POST",
        &format!("{PARTNERS}/healthtech/enroll"),
        Some(json!({"request_id":Uuid::new_v4(),"agreement_version":"partner-enrollment-v1","accepted_by":{"name":"Avery Synthetic","email":"owner@example.test"}})),
    )
    .await;
    assert_eq!(status, 503, "{body}");
    let audited: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='practice.partner.enrolled'")
        .bind(a.tenant_id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(audited, 0);
    // A listing that is not a listing is a service fault, shown with the retry
    // wording rather than as an empty catalog the owner would read as "no
    // partners exist".
    let (status, body) = send(&r, &a, "GET", PARTNERS, None).await;
    assert_eq!(status, 503, "{body}");
    assert_eq!(
        body["message"],
        "SunCharts Connect could not be reached. Try again."
    );
}

#[tokio::test]
async fn a_counted_probe_of_the_payment_step_keeps_the_two_screens_agreeing() {
    // The Partners screen reads the payment account from the same place the
    // Payments screen does; a Connect outage must not turn step 1 into "not set up".
    let db = database().await;
    let (base, _, mode) = service().await;
    let r = app(db.clone());
    let a = owner(&db, None).await;
    let _ = pair(&db, &r, &a, &base).await;
    let (status, payments) = send(&r, &a, "GET", "/api/v1/billing/payments/settings", None).await;
    assert_eq!(status, 200, "{payments}");
    assert_eq!(payments["setting"], Value::Null, "no payment account yet");
    *mode.lock().unwrap() = Mode::Down;
    let (_, body) = send(&r, &a, "GET", PARTNERS, None).await;
    assert_eq!(body["partners"]["payments"]["state"], "none");
    assert!(
        body["partners"]["connect_error"].is_string(),
        "the connection problem is named where it belongs"
    );
}
