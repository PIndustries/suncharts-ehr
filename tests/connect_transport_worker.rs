// SPDX-License-Identifier: AGPL-3.0-only
//! Actual EHR worker + local WebSocket + PostgreSQL OAuth round trip. Synthetic only.
use axum::http::{HeaderMap, HeaderValue};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use suncharts_engine::{
    browser::BrowserAuth,
    connect_onboarding::{self, Callback, OnboardingCloud},
    error::{Error, Result},
    postgres::PostgresBackend,
    State,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::watch,
};
use tokio_tungstenite::{
    tungstenite::{
        handshake::server::{Request, Response},
        Message,
    },
    WebSocketStream,
};
use uuid::Uuid;

const ORIGIN: &str = "https://synthetic-clinic.example";
const SCOPE: &str = "clinical.read clinical.write billing.read billing.write events.read migration.manage offline_access";
const SERVICE_TOKEN: &str = "scs_inst_synthetic_worker_credential_not_a_real_token_1234567890";
type Socket = WebSocketStream<TcpStream>;

struct Cloud {
    start: Mutex<Option<Value>>,
    installation: Uuid,
}
#[async_trait::async_trait]
impl OnboardingCloud for Cloud {
    async fn post(&self, path: &str, body: &Value, bearer: Option<&str>) -> Result<Value> {
        if path == "/api/v1/ehr-pairing/requests" {
            *self.start.lock().unwrap() = Some(body.clone());
            return Ok(
                json!({"request_uri":"epr_synthetic_worker", "authorization_url":"https://connect.suncharts.app/connect/ehr?request=epr_synthetic_worker"}),
            );
        }
        let start = self.start.lock().unwrap().clone().unwrap();
        match path {
            "/api/v1/ehr-pairing/token" => Ok(
                json!({"installation_id":self.installation,"installation_token":SERVICE_TOKEN,"remote_tenant_id":start["remote_tenant_id"],"remote_user_id":start["remote_user_id"],"connection_id":Uuid::new_v4(),"platform_tenant_id":Uuid::new_v4(),"activation_required":true}),
            ),
            "/api/v1/ehr-pairing/complete" => {
                assert!(bearer == Some(SERVICE_TOKEN));
                Ok(
                    json!({"installation_id":self.installation,"remote_tenant_id":start["remote_tenant_id"],"remote_user_id":start["remote_user_id"],"active":true,"managed_email_ready":true,"support_ready":true,"entitled":true,"services":{"reminders":{"from_email":"SunCharts <appointments@example.test>"}}}),
                )
            }
            _ => Err(Error::Invalid("unexpected synthetic cloud operation")),
        }
    }
}

async fn database() -> PgPool {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("transport_worker_{}", Uuid::new_v4().simple());
    let initial = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&initial, &schema).await;
    initial.close().await;
    let db = PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |connection, _| {
            let query = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(&query).execute(connection).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    db
}

// tungstenite's handshake callback requires its unboxed HTTP error-response type.
#[allow(clippy::result_large_err)]
async fn accept(listener: &TcpListener, intent: Uuid) -> Socket {
    let (stream, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
        .await
        .unwrap()
        .unwrap();
    tokio_tungstenite::accept_hdr_async(stream, move |request: &Request, response: Response| {
        assert!(request.uri().path() == "/api/v1/ehr-pairing/channel");
        assert!(
            request
                .headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                == Some(format!("Bearer {SERVICE_TOKEN}").as_str())
        );
        assert_eq!(
            request.headers()["x-suncharts-request-id"],
            intent.to_string()
        );
        assert_eq!(request.headers()["x-suncharts-service-events"], "1");
        assert!(!request.headers().contains_key("origin"));
        assert!(!request.headers().contains_key("cookie"));
        Ok(response)
    })
    .await
    .unwrap()
}
async fn frame(socket: &mut Socket) -> Value {
    let message = tokio::time::timeout(Duration::from_secs(8), socket.next())
        .await
        .expect("worker did not return a frame")
        .unwrap()
        .unwrap();
    let Message::Text(text) = message else {
        panic!("expected a protocol text frame")
    };
    serde_json::from_str(&text).unwrap()
}
async fn send(socket: &mut Socket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
async fn connected(socket: &mut Socket, installation: Uuid) {
    send(socket, json!({"version":1,"type":"connected","installation_id":installation,"connection_id":Uuid::nil()})).await;
}
async fn heartbeat(socket: &mut Socket, installation: Uuid) {
    let nonce = Uuid::new_v4();
    send(socket, json!({"version":1,"type":"heartbeat","id":nonce})).await;
    let ack = frame(socket).await;
    assert_eq!(ack["type"], "heartbeat_ack");
    assert_eq!(ack["id"], nonce.to_string());
    // This is what Connect sends after a valid acknowledgement. It refreshes the
    // EHR's last-contact deadline; merely sending heartbeat messages is not enough.
    connected(socket, installation).await;
}
fn command(id: Uuid, method: &str, path: &str, authorization: &str, body: &[u8]) -> Value {
    json!({"version":1,"type":"request","id":id,"method":method,"path":path,"headers":{"authorization":authorization,"content-type":"application/x-www-form-urlencoded"},"body_base64":STANDARD.encode(body),"expires_at":chrono::Utc::now()+chrono::Duration::seconds(25)})
}
fn body(response: &Value) -> Value {
    serde_json::from_slice(
        &STANDARD
            .decode(response["body_base64"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap()
}
async fn health_session(db: &PgPool, tenant: Uuid, intent: Uuid) -> Uuid {
    sqlx::query_scalar(
        "SELECT session_id FROM connect_transport_health WHERE tenant_id=$1 AND intent_id=$2",
    )
    .bind(tenant)
    .bind(intent)
    .fetch_one(db)
    .await
    .unwrap()
}

#[tokio::test]
async fn actual_worker_refreshes_oauth_delivers_settings_and_keeps_one_session_across_heartbeats() {
    // This integration-test binary contains one test, so its explicit local-only
    // environment cannot race another test's cloud configuration.
    let key_dir = std::env::temp_dir().join(format!("synthetic-worker-key-{}", Uuid::new_v4()));
    std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", key_dir.join("master.key"));
    std::env::remove_var("ENGINE_CONNECT_CLOUD_URL");
    let db = database().await;
    let (tenant, user) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-a-login','owner')").bind(user).bind(tenant).bind(format!("{user}@example.test")).execute(&db).await.unwrap();
    let session_token = format!("synthetic-browser-{}", Uuid::new_v4());
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(suncharts_engine::oauth::hash(&session_token)).bind(tenant).bind(user).execute(&db).await.unwrap();
    let headers = HeaderMap::from_iter([
        (axum::http::header::ORIGIN, HeaderValue::from_static(ORIGIN)),
        (
            axum::http::header::COOKIE,
            HeaderValue::from_str(&format!("sce_session={session_token}")).unwrap(),
        ),
    ]);
    let state = State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: "synthetic-unused-gateway".into(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
    };
    let cloud = Cloud {
        start: Mutex::new(None),
        installation: Uuid::new_v4(),
    };
    let started = connect_onboarding::begin_with_cloud(&state, &headers, &cloud)
        .await
        .unwrap();
    let intent = Uuid::parse_str(started["id"].as_str().unwrap()).unwrap();
    let start = cloud.start.lock().unwrap().clone().unwrap();
    let client = Uuid::parse_str(start["client_id"].as_str().unwrap()).unwrap();
    let grant = Uuid::new_v4();
    let refresh = suncharts_engine::oauth::random("sce_rt_");
    sqlx::query(
        "INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(grant)
    .bind(client)
    .bind(tenant)
    .bind(user)
    .bind(SCOPE)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'refresh',now()+interval '1 day')").bind(suncharts_engine::oauth::hash(&refresh)).bind(grant).execute(&db).await.unwrap();
    connect_onboarding::stage_callback(
        &state,
        Callback {
            code: Some("synthetic-code".into()),
            state: start["state"].as_str().unwrap().into(),
            iss: connect_onboarding::CLOUD.into(),
            error: None,
        },
    )
    .await
    .unwrap();
    let version: i64 = sqlx::query_scalar(
        "SELECT version FROM connect_onboarding_intents WHERE tenant_id=$1 AND id=$2",
    )
    .bind(tenant)
    .bind(intent)
    .fetch_one(&db)
    .await
    .unwrap();
    let completed =
        connect_onboarding::complete_with_cloud(&state, &headers, intent, version, &cloud)
            .await
            .unwrap();
    assert_eq!(completed["status"], "completed");

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    std::env::set_var(
        "ENGINE_CONNECT_CLOUD_URL",
        format!("http://{}", listener.local_addr().unwrap()),
    );
    std::env::set_var("ENGINE_CONNECT_ALLOW_LOOPBACK", "true");
    let (stop, receiver) = watch::channel(false);
    let worker = tokio::spawn(suncharts_engine::connect_transport::run_with_shutdown(
        state, receiver,
    ));
    let mut socket = accept(&listener, intent).await;
    connected(&mut socket, cloud.installation).await;
    heartbeat(&mut socket, cloud.installation).await;
    let session = health_session(&db, tenant, intent).await;
    let request_id = Uuid::new_v4();
    let basic = format!(
        "Basic {}",
        STANDARD.encode(format!(
            "{client}:{}",
            start["client_secret"].as_str().unwrap()
        ))
    );
    let form = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "refresh_token")
        .append_pair("refresh_token", &refresh)
        .finish();
    let request = command(request_id, "POST", "/oauth/token", &basic, form.as_bytes());
    send(&mut socket, request.clone()).await;
    let response = frame(&mut socket).await;
    assert_eq!(response["id"], request_id.to_string());
    assert_eq!(response["status"], 200);
    let tokens = body(&response);
    assert!(tokens["access_token"]
        .as_str()
        .unwrap()
        .starts_with("sce_at_"));
    assert!(tokens["refresh_token"]
        .as_str()
        .unwrap()
        .starts_with("sce_rt_"));
    let authorization = format!("Bearer {}", tokens["access_token"].as_str().unwrap());

    // Repeating the same wire command must not execute refresh rotation twice,
    // which would otherwise revoke the grant as a refresh-token replay.
    send(&mut socket, request).await;
    let duplicate = frame(&mut socket).await;
    assert_eq!(duplicate["status"], 409);
    let settings_id = Uuid::new_v4();
    send(
        &mut socket,
        command(
            settings_id,
            "GET",
            "/api/v1/billing/payments/settings",
            &authorization,
            b"",
        ),
    )
    .await;
    let settings = frame(&mut socket).await;
    assert_eq!(settings["id"], settings_id.to_string());
    assert_eq!(settings["status"], 200);
    assert!(body(&settings).is_object());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='oauth.token_issue'"
        )
        .bind(tenant)
        .fetch_one(&db)
        .await
        .unwrap(),
        1
    );
    assert!(!sqlx::query_scalar::<_, bool>(
        "SELECT revoked_at IS NOT NULL FROM oauth_grants WHERE id=$1"
    )
    .bind(grant)
    .fetch_one(&db)
    .await
    .unwrap());

    // Span the real 45-second worker-claim/last-contact deadline rather than
    // testing only initial connection. There must be no competing worker/socket.
    for _ in 0..4 {
        heartbeat(&mut socket, cloud.installation).await;
        tokio::time::sleep(Duration::from_secs(12)).await;
    }
    heartbeat(&mut socket, cloud.installation).await;
    assert_eq!(health_session(&db, tenant, intent).await, session);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    let live: bool = sqlx::query_scalar("SELECT state='connected' AND last_seen_at>clock_timestamp()-interval '5 seconds' AND updated_at>clock_timestamp()-interval '5 seconds' FROM connect_transport_health WHERE tenant_id=$1 AND intent_id=$2").bind(tenant).bind(intent).fetch_one(&db).await.unwrap();
    assert!(live);

    // An abruptly closed peer exercises the real reconnect path. The worker
    // reconnects under its existing claim and does not replay the prior write.
    drop(socket);
    let mut reconnected = accept(&listener, intent).await;
    connected(&mut reconnected, cloud.installation).await;
    heartbeat(&mut reconnected, cloud.installation).await;
    assert_eq!(health_session(&db, tenant, intent).await, session);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='oauth.token_issue'"
        )
        .bind(tenant)
        .fetch_one(&db)
        .await
        .unwrap(),
        1
    );
    let read_id = Uuid::new_v4();
    send(
        &mut reconnected,
        command(
            read_id,
            "GET",
            "/api/v1/billing/payments/settings",
            &authorization,
            b"",
        ),
    )
    .await;
    assert_eq!(frame(&mut reconnected).await["status"], 200);
    stop.send(true).unwrap();
    let close = tokio::time::timeout(Duration::from_secs(5), reconnected.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(close, Message::Close(_)));
    let _ = reconnected.close(None).await;
    tokio::time::timeout(Duration::from_secs(5), worker)
        .await
        .unwrap()
        .unwrap();
    db.close().await;
    std::fs::remove_dir_all(key_dir).unwrap();
}
