// SPDX-License-Identifier: AGPL-3.0-only
//! Real PostgreSQL/session boundaries with a synthetic cloud. No outbound requests.
use axum::http::{HeaderMap, HeaderValue};
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use suncharts_engine::{
    browser::BrowserAuth,
    connect_onboarding::{self, Callback, OnboardingCloud},
    error::{Error, Result},
    postgres::PostgresBackend,
    State,
};
use uuid::Uuid;

const ORIGIN: &str = "https://clinic.example";
static KEY_PATH: OnceLock<PathBuf> = OnceLock::new();
struct Fixture {
    db: PgPool,
    state: State,
    headers: HeaderMap,
    tenant: Uuid,
    user: Uuid,
}
impl Fixture {
    async fn new() -> Self {
        KEY_PATH.get_or_init(|| {
            let path = std::env::temp_dir()
                .join(format!("synthetic-onboarding-{}", Uuid::new_v4()))
                .join("master.key");
            std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", &path);
            path
        });
        let url =
            std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
        let schema = format!("connect_onboarding_{}", Uuid::new_v4().simple());
        let initial = PgPool::connect(&url).await.unwrap();
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&initial)
            .await
            .unwrap();
        initial.close().await;
        let db = PgPoolOptions::new()
            .max_connections(8)
            .after_connect(move |c, _| {
                let query = format!("SET search_path TO {schema}");
                Box::pin(async move {
                    sqlx::query(&query).execute(c).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        suncharts_engine::MIGRATOR.run(&db).await.unwrap();
        let (tenant, user) = (Uuid::new_v4(), Uuid::new_v4());
        sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-a-login','owner')")
            .bind(user).bind(tenant).bind(format!("{}@example.test", user.simple())).execute(&db).await.unwrap();
        let headers = session(&db, tenant, user).await;
        let state = State {
            backend: Arc::new(PostgresBackend(db.clone())),
            secret: "synthetic-unused-gateway-secret".into(),
            allow_legacy_gateway: false,
            issuer: "suncharts".into(),
            audience: "suncharts-engine".into(),
            browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
        };
        Self {
            db,
            state,
            headers,
            tenant,
            user,
        }
    }
    async fn grant(&self, id: Uuid) {
        let client: Uuid = sqlx::query_scalar(
            "SELECT client_id FROM connect_onboarding_intents WHERE tenant_id=$1 AND id=$2",
        )
        .bind(self.tenant)
        .bind(id)
        .fetch_one(&self.db)
        .await
        .unwrap();
        let grant = Uuid::new_v4();
        sqlx::query("INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,'clinical.read clinical.write billing.read billing.write events.read migration.manage offline_access')")
            .bind(grant).bind(client).bind(self.tenant).bind(self.user).execute(&self.db).await.unwrap();
        sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'refresh',now()+interval '1 hour')")
            .bind(suncharts_engine::oauth::hash(&Uuid::new_v4().to_string())).bind(grant).execute(&self.db).await.unwrap();
    }
}
async fn session(db: &PgPool, tenant: Uuid, user: Uuid) -> HeaderMap {
    let token = format!("synthetic-session-{}", Uuid::new_v4());
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')")
        .bind(suncharts_engine::oauth::hash(&token)).bind(tenant).bind(user).execute(db).await.unwrap();
    let mut h = HeaderMap::new();
    h.insert("origin", HeaderValue::from_static(ORIGIN));
    h.insert(
        "cookie",
        HeaderValue::from_str(&format!("sce_session={token}")).unwrap(),
    );
    h
}
#[derive(Default)]
struct Cloud {
    calls: Mutex<Vec<(String, Value, Option<String>)>>,
    invalid_url: bool,
    fail_token: AtomicBool,
    fail_complete: AtomicBool,
    fail_cancel: AtomicBool,
}
impl Cloud {
    fn start(&self) -> Value {
        self.calls.lock().unwrap()[0].1.clone()
    }
    fn callback(&self) -> Callback {
        Callback {
            code: Some("synthetic-one-use-code".into()),
            state: self.start()["state"].as_str().unwrap().into(),
            iss: "https://my.suncharts.app".into(),
            error: None,
        }
    }
}
#[async_trait::async_trait]
impl OnboardingCloud for Cloud {
    async fn post(&self, path: &str, body: &Value, bearer: Option<&str>) -> Result<Value> {
        self.calls
            .lock()
            .unwrap()
            .push((path.into(), body.clone(), bearer.map(str::to_owned)));
        if path == "/api/v1/ehr-pairing/requests" {
            assert!(bearer.is_none());
            return Ok(
                json!({"request_uri":"epr_synthetic_request", "authorization_url":if self.invalid_url {"https://evil.example/connect/ehr?request=epr_synthetic_request"} else {"https://my.suncharts.app/connect/ehr?request=epr_synthetic_request"}}),
            );
        }
        let start = self.start();
        let installation = Uuid::from_u128(0x53c40000000040008000000000000032);
        let token = "scs_inst_synthetic_onboarding_credential_1234567890";
        if path == "/api/v1/ehr-pairing/token" {
            assert!(bearer.is_none());
            assert_eq!(body["request_uri"], "epr_synthetic_request");
            assert_eq!(
                suncharts_engine::oauth::challenge(body["code_verifier"].as_str().unwrap()),
                start["code_challenge"]
            );
            if self.fail_token.swap(false, Ordering::SeqCst) {
                return Err(Error::Invalid("synthetic token response lost"));
            }
            return Ok(
                json!({"installation_id":installation,"installation_token":token,"remote_tenant_id":start["remote_tenant_id"],"remote_user_id":start["remote_user_id"],"connection_id":Uuid::from_u128(0x1234),"platform_tenant_id":Uuid::from_u128(0x5678),"activation_required":true}),
            );
        }
        if path == "/api/v1/ehr-pairing/complete" {
            assert_eq!(bearer, Some(token));
            assert_eq!(body["installation_id"], installation.to_string());
            if self.fail_complete.swap(false, Ordering::SeqCst) {
                return Err(Error::Invalid("synthetic activation response lost"));
            }
            return Ok(
                json!({"installation_id":installation,"remote_tenant_id":start["remote_tenant_id"],"remote_user_id":start["remote_user_id"],"active":true,"managed_email_ready":true,"support_ready":true,"entitled":true,"services":{"reminders":{"from_email":"SunCharts <appointments@suncharts.app>"}}}),
            );
        }
        if path == "/api/v1/ehr-pairing/cancel" {
            if self.fail_cancel.swap(false, Ordering::SeqCst) {
                return Err(Error::Invalid("synthetic cancellation response lost"));
            }
            return Ok(json!({"cancelled":true}));
        }
        Err(Error::Invalid("synthetic cloud operation not implemented"))
    }
}

async fn callback_ready(f: &Fixture, cloud: &Cloud) -> (Uuid, i64) {
    let started = connect_onboarding::begin_with_cloud(&f.state, &f.headers, cloud)
        .await
        .unwrap();
    let id = Uuid::parse_str(started["id"].as_str().unwrap()).unwrap();
    connect_onboarding::stage_callback(&f.state, cloud.callback())
        .await
        .unwrap();
    f.grant(id).await;
    (id, intent_version(f, id).await)
}
async fn intent_version(f: &Fixture, id: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT version FROM connect_onboarding_intents WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.tenant)
    .bind(id)
    .fetch_one(&f.db)
    .await
    .unwrap()
}
async fn expire_lease(f: &Fixture, id: Uuid) {
    sqlx::query("UPDATE connect_onboarding_intents SET lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2").bind(f.tenant).bind(id).execute(&f.db).await.unwrap();
}

#[tokio::test]
async fn begin_requires_real_owner_session_same_origin_and_supports_private_outbound_issuer() {
    let f = Fixture::new().await;
    let cloud = Cloud::default();
    assert!(
        connect_onboarding::begin_with_cloud(&f.state, &HeaderMap::new(), &cloud)
            .await
            .is_err()
    );
    let mut foreign = f.headers.clone();
    foreign.insert(
        "origin",
        HeaderValue::from_static("https://untrusted.example"),
    );
    assert!(
        connect_onboarding::begin_with_cloud(&f.state, &foreign, &cloud)
            .await
            .is_err()
    );
    let local = State {
        browser: Some(BrowserAuth::new(f.db.clone(), "http://127.0.0.1:8090".into()).unwrap()),
        ..f.state.clone()
    };
    let mut local_headers = f.headers.clone();
    local_headers.insert("origin", HeaderValue::from_static("http://127.0.0.1:8090"));
    assert!(cloud.calls.lock().unwrap().is_empty());
    let local_started = connect_onboarding::begin_with_cloud(&local, &local_headers, &cloud)
        .await
        .unwrap();
    assert_eq!(local_started["transport"], "outbound_websocket");
    assert_eq!(cloud.start()["ehr_origin"], "http://127.0.0.1:8090");
    assert!(cloud.start()["relay_token"]
        .as_str()
        .unwrap()
        .starts_with("sce_relay_"));
    assert!(!local_started.to_string().contains("sce_relay_"));
    sqlx::query("UPDATE browser_users SET role='clinician' WHERE id=$1")
        .bind(f.user)
        .execute(&f.db)
        .await
        .unwrap();
    assert!(
        connect_onboarding::begin_with_cloud(&f.state, &f.headers, &cloud)
            .await
            .is_err()
    );
    f.db.close().await;
}

#[tokio::test]
async fn begin_and_callback_pin_original_session_and_hide_secrets() {
    let f = Fixture::new().await;
    let cloud = Cloud::default();
    let started = connect_onboarding::begin_with_cloud(&f.state, &f.headers, &cloud)
        .await
        .unwrap();
    let id = Uuid::parse_str(started["id"].as_str().unwrap()).unwrap();
    assert_eq!(started["status"], "awaiting_approval");
    let staged = cloud.start();
    let visible = started.to_string();
    for field in ["client_secret", "state"] {
        assert!(
            !visible.contains(staged[field].as_str().unwrap()),
            "secret exposed in public intent"
        );
    }
    assert_eq!(staged["remote_tenant_id"], f.tenant.to_string());
    assert_eq!(staged["remote_user_id"], f.user.to_string());
    let other = session(&f.db, f.tenant, f.user).await;
    assert!(
        connect_onboarding::begin_with_cloud(&f.state, &other, &cloud)
            .await
            .is_err()
    );
    let mut forged = cloud.callback();
    forged.iss = "https://evil.example".into();
    assert!(connect_onboarding::stage_callback(&f.state, forged)
        .await
        .is_err());
    let mut forged = cloud.callback();
    forged.state = "unrecognized-state".into();
    assert!(connect_onboarding::stage_callback(&f.state, forged)
        .await
        .is_err());
    assert_eq!(
        connect_onboarding::stage_callback(&f.state, cloud.callback())
            .await
            .unwrap(),
        id
    );
    assert_eq!(
        connect_onboarding::stage_callback(&f.state, cloud.callback())
            .await
            .unwrap(),
        id
    );
    let mut changed = cloud.callback();
    changed.code = Some("different-code".into());
    assert!(connect_onboarding::stage_callback(&f.state, changed)
        .await
        .is_err());
    let status: String = sqlx::query_scalar(
        "SELECT status FROM connect_onboarding_intents WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.tenant)
    .bind(id)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(status, "callback_received");
    f.db.close().await;
}

#[tokio::test]
async fn malicious_cloud_destination_is_rejected_without_changing_settings() {
    let f = Fixture::new().await;
    let cloud = Cloud {
        invalid_url: true,
        ..Cloud::default()
    };
    assert!(
        connect_onboarding::begin_with_cloud(&f.state, &f.headers, &cloud)
            .await
            .is_err()
    );
    let settings: i64 = sqlx::query_scalar("SELECT count(*) FROM connect_service_settings")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(settings, 0);
    f.db.close().await;
}

#[tokio::test]
async fn completion_requires_original_session_and_installs_once_without_public_tokens() {
    let f = Fixture::new().await;
    let cloud = Cloud::default();
    let (id, version) = callback_ready(&f, &cloud).await;
    let (foreign_tenant, foreign_user) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-a-login','owner')")
        .bind(foreign_user).bind(foreign_tenant).bind(format!("{}@example.test",foreign_user.simple())).execute(&f.db).await.unwrap();
    let foreign = session(&f.db, foreign_tenant, foreign_user).await;
    assert!(
        connect_onboarding::complete_with_cloud(&f.state, &foreign, id, version, &cloud)
            .await
            .is_err()
    );
    let second = session(&f.db, f.tenant, f.user).await;
    assert!(
        connect_onboarding::complete_with_cloud(&f.state, &second, id, version, &cloud)
            .await
            .is_err()
    );
    let completed =
        connect_onboarding::complete_with_cloud(&f.state, &f.headers, id, version, &cloud)
            .await
            .unwrap();
    assert_eq!(completed["status"], "completed");
    assert!(!completed.to_string().contains("scs_inst_"));
    let replay = connect_onboarding::complete_with_cloud(&f.state, &f.headers, id, version, &cloud)
        .await
        .unwrap();
    assert_eq!(replay["status"], "completed");
    let row:(bool,bool,String,i64,i64)=sqlx::query_as("SELECT s.enabled,s.verified,r.delivery_mode,(SELECT count(*) FROM connect_service_credentials),(SELECT count(*) FROM reminder_credentials) FROM connect_service_settings s JOIN reminder_sender_settings r USING(tenant_id) WHERE s.tenant_id=$1").bind(f.tenant).fetch_one(&f.db).await.unwrap();
    assert_eq!(row, (true, true, "suncharts_connect".into(), 1, 1));
    let encrypted: Vec<u8> = sqlx::query_scalar(
        "SELECT encrypted_token FROM connect_service_credentials WHERE tenant_id=$1",
    )
    .bind(f.tenant)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert!(!String::from_utf8_lossy(&encrypted).contains("scs_inst_"));
    assert_eq!(
        cloud
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(p, _, _)| p == "/api/v1/ehr-pairing/complete")
            .count(),
        1
    );
    f.db.close().await;
}

#[tokio::test]
async fn lost_token_and_activation_responses_resume_same_intent_without_duplicate_credentials() {
    let f = Fixture::new().await;
    let cloud = Cloud::default();
    let (id, version) = callback_ready(&f, &cloud).await;
    cloud.fail_token.store(true, Ordering::SeqCst);
    assert!(
        connect_onboarding::complete_with_cloud(&f.state, &f.headers, id, version, &cloud)
            .await
            .is_err()
    );
    let version = intent_version(&f, id).await;
    assert!(
        connect_onboarding::complete_with_cloud(&f.state, &f.headers, id, version, &cloud)
            .await
            .is_err()
    );
    expire_lease(&f, id).await;
    cloud.fail_complete.store(true, Ordering::SeqCst);
    assert!(
        connect_onboarding::complete_with_cloud(&f.state, &f.headers, id, version, &cloud)
            .await
            .is_err()
    );
    let settings: i64 = sqlx::query_scalar("SELECT count(*) FROM connect_service_settings")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(settings, 0);
    expire_lease(&f, id).await;
    let version = intent_version(&f, id).await;
    let done = connect_onboarding::complete_with_cloud(&f.state, &f.headers, id, version, &cloud)
        .await
        .unwrap();
    assert_eq!(done["status"], "completed");
    let calls = cloud.calls.lock().unwrap().clone();
    let tokens: Vec<_> = calls
        .iter()
        .filter(|(p, _, _)| p == "/api/v1/ehr-pairing/token")
        .collect();
    assert_eq!(tokens.len(), 2);
    assert!(
        tokens[0].1 == tokens[1].1,
        "token retry changed original code or PKCE verifier"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(p, _, _)| p == "/api/v1/ehr-pairing/complete")
            .count(),
        2
    );
    drop(calls);
    f.db.close().await;
}

#[tokio::test]
async fn activation_audit_failure_rolls_back_local_settings_then_recovers() {
    let f = Fixture::new().await;
    let cloud = Cloud::default();
    let (id, version) = callback_ready(&f, &cloud).await;
    sqlx::raw_sql("CREATE FUNCTION fail_onboarding_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='connect.onboarding_completed' THEN RAISE EXCEPTION 'synthetic final audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_onboarding_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_onboarding_audit();").execute(&f.db).await.unwrap();
    assert!(
        connect_onboarding::complete_with_cloud(&f.state, &f.headers, id, version, &cloud)
            .await
            .is_err()
    );
    let counts:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM connect_service_settings),(SELECT count(*) FROM reminder_sender_settings)").fetch_one(&f.db).await.unwrap();
    assert_eq!(counts, (0, 0));
    let staged:bool=sqlx::query_scalar("SELECT encrypted_exchange IS NOT NULL FROM connect_onboarding_intents WHERE tenant_id=$1 AND id=$2").bind(f.tenant).bind(id).fetch_one(&f.db).await.unwrap();
    assert!(
        staged,
        "remote receipt must remain encrypted and recoverable"
    );
    sqlx::query("DROP TRIGGER fail_onboarding_audit ON audit_events")
        .execute(&f.db)
        .await
        .unwrap();
    expire_lease(&f, id).await;
    let version = intent_version(&f, id).await;
    assert_eq!(
        connect_onboarding::complete_with_cloud(&f.state, &f.headers, id, version, &cloud)
            .await
            .unwrap()["status"],
        "completed"
    );
    let events:i64=sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='connect.onboarding_completed'").bind(f.tenant).fetch_one(&f.db).await.unwrap();
    assert_eq!(events, 1);
    f.db.close().await;
}

#[tokio::test]
async fn concurrent_settings_edit_blocks_install_and_expired_attempt_can_be_cancelled_then_restarted(
) {
    let f = Fixture::new().await;
    let cloud = Cloud::default();
    let (id, version) = callback_ready(&f, &cloud).await;
    sqlx::query("INSERT INTO reminder_sender_settings(tenant_id,id,from_email) VALUES($1,$2,'own@example.test')").bind(f.tenant).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    assert!(
        connect_onboarding::complete_with_cloud(&f.state, &f.headers, id, version, &cloud)
            .await
            .is_err()
    );
    assert_eq!(
        cloud.calls.lock().unwrap().len(),
        1,
        "CAS rejection contacted cloud activation"
    );
    sqlx::query("UPDATE connect_onboarding_intents SET expires_at=now()-interval '1 minute' WHERE tenant_id=$1 AND id=$2").bind(f.tenant).bind(id).execute(&f.db).await.unwrap();
    // Cancellation remains available after the original login is replaced or expires.
    let new_session = session(&f.db, f.tenant, f.user).await;
    let cancelled =
        connect_onboarding::cancel_with_cloud(&f.state, &new_session, id, version, &cloud)
            .await
            .unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    let disabled:bool=sqlx::query_scalar("SELECT c.disabled FROM oauth_clients c JOIN connect_onboarding_intents i ON i.client_id=c.id WHERE i.tenant_id=$1 AND i.id=$2").bind(f.tenant).bind(id).fetch_one(&f.db).await.unwrap();
    assert!(disabled);
    let next = connect_onboarding::begin_with_cloud(&f.state, &new_session, &cloud)
        .await
        .unwrap();
    assert_ne!(next["id"], id.to_string());
    f.db.close().await;
}

#[tokio::test]
async fn cancellation_audit_and_lost_cloud_response_preserve_recoverable_cleanup() {
    let f = Fixture::new().await;
    let cloud = Cloud::default();
    let (id, version) = callback_ready(&f, &cloud).await;
    sqlx::raw_sql("CREATE FUNCTION fail_cancel_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='connect.onboarding_cancellation_requested' THEN RAISE EXCEPTION 'synthetic cancellation audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_cancel_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_cancel_audit();").execute(&f.db).await.unwrap();
    assert!(
        connect_onboarding::cancel_with_cloud(&f.state, &f.headers, id, version, &cloud)
            .await
            .is_err()
    );
    let unchanged:(bool,bool)=sqlx::query_as("SELECT c.disabled,g.revoked_at IS NOT NULL FROM oauth_clients c JOIN oauth_grants g ON g.client_id=c.id JOIN connect_onboarding_intents i ON i.client_id=c.id WHERE i.tenant_id=$1 AND i.id=$2").bind(f.tenant).bind(id).fetch_one(&f.db).await.unwrap();
    assert_eq!(unchanged, (false, false));
    assert_eq!(
        cloud.calls.lock().unwrap().len(),
        1,
        "cloud cleanup preceded durable cancellation audit"
    );
    sqlx::query("DROP TRIGGER fail_cancel_audit ON audit_events")
        .execute(&f.db)
        .await
        .unwrap();
    cloud.fail_cancel.store(true, Ordering::SeqCst);
    assert!(
        connect_onboarding::cancel_with_cloud(&f.state, &f.headers, id, version, &cloud)
            .await
            .is_err()
    );
    let status: String = sqlx::query_scalar(
        "SELECT status FROM connect_onboarding_intents WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.tenant)
    .bind(id)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(status, "cancelling");
    let version = intent_version(&f, id).await;
    assert!(
        connect_onboarding::complete_with_cloud(&f.state, &f.headers, id, version, &cloud)
            .await
            .is_err()
    );
    let cancelled =
        connect_onboarding::cancel_with_cloud(&f.state, &f.headers, id, version, &cloud)
            .await
            .unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    let calls = cloud.calls.lock().unwrap().clone();
    let cancellations: Vec<_> = calls
        .iter()
        .filter(|(p, _, _)| p == "/api/v1/ehr-pairing/cancel")
        .collect();
    assert_eq!(cancellations.len(), 2);
    assert!(
        cancellations[0].1 == cancellations[1].1,
        "cleanup retry changed installation proof"
    );
    drop(calls);
    f.db.close().await;
}

#[tokio::test]
async fn completion_preserves_existing_own_resend_sender_exactly() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    let f = Fixture::new().await;
    let app = suncharts_engine::app(f.state.clone());
    let mut save=Request::builder().method("PUT").uri("/api/v1/schedule/reminder-settings").header("content-type","application/json").header("if-match","\"0\"").body(Body::from(json!({"delivery_mode":"own_resend","from_email":"clinic-brand@example.test","api_key":"re_synthetic_white_label_fixture_key"}).to_string())).unwrap();
    save.headers_mut().extend(f.headers.clone());
    let response = app.clone().oneshot(save).await.unwrap();
    assert_eq!(response.status(), 200);
    // Fixture-only provider verification; no test sends or provider calls occur.
    sqlx::query("UPDATE reminder_sender_settings SET verified=true,last_test_result='fixture_domain_verified',last_test_at=now() WHERE tenant_id=$1").bind(f.tenant).execute(&f.db).await.unwrap();
    let mut activate = Request::builder()
        .method("POST")
        .uri("/api/v1/schedule/reminder-settings/activation")
        .header("content-type", "application/json")
        .header("if-match", "\"1\"")
        .body(Body::from(json!({"enabled":true}).to_string()))
        .unwrap();
    activate.headers_mut().extend(f.headers.clone());
    assert_eq!(app.oneshot(activate).await.unwrap().status(), 200);
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM reminder_sender_settings r WHERE tenant_id=$1")
            .bind(f.tenant)
            .fetch_one(&f.db)
            .await
            .unwrap();
    let credentials_before: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(c) FROM reminder_credentials c WHERE tenant_id=$1 ORDER BY revision",
    )
    .bind(f.tenant)
    .fetch_all(&f.db)
    .await
    .unwrap();
    let events_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM reminder_sender_events WHERE tenant_id=$1")
            .bind(f.tenant)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(before["delivery_mode"], "own_resend");
    assert_eq!(before["enabled"], true);
    assert_eq!(before["verified"], true);
    let cloud = Cloud::default();
    let (id, version) = callback_ready(&f, &cloud).await;
    let completed =
        connect_onboarding::complete_with_cloud(&f.state, &f.headers, id, version, &cloud)
            .await
            .unwrap();
    assert_eq!(completed["status"], "completed");
    let after: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM reminder_sender_settings r WHERE tenant_id=$1")
            .bind(f.tenant)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(
        before, after,
        "pairing must preserve every own-Resend sender field and version"
    );
    let credentials_after: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(c) FROM reminder_credentials c WHERE tenant_id=$1 ORDER BY revision",
    )
    .bind(f.tenant)
    .fetch_all(&f.db)
    .await
    .unwrap();
    assert_eq!(credentials_before, credentials_after);
    let events_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM reminder_sender_events WHERE tenant_id=$1")
            .bind(f.tenant)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(events_before, events_after);
    let service: (bool, bool) =
        sqlx::query_as("SELECT enabled,verified FROM connect_service_settings WHERE tenant_id=$1")
            .bind(f.tenant)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(service, (true, true));
    f.db.close().await;
}

fn command(path: &str, token: Option<&str>) -> suncharts_engine::connect_transport::Command {
    use std::collections::BTreeMap;
    suncharts_engine::connect_transport::Command {
        version: 1,
        r#type: "request".into(),
        id: Uuid::new_v4(),
        method: "GET".into(),
        path: path.into(),
        headers: token
            .map(|t| {
                BTreeMap::from([
                    ("authorization".into(), format!("Bearer {t}")),
                    ("accept".into(), "application/json".into()),
                ])
            })
            .unwrap_or_default(),
        body_base64: String::new(),
        expires_at: chrono::Utc::now() + chrono::Duration::seconds(30),
    }
}
async fn access(f: &Fixture, id: Uuid, scope: &str) -> String {
    let client: Uuid = sqlx::query_scalar(
        "SELECT client_id FROM connect_onboarding_intents WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.tenant)
    .bind(id)
    .fetch_one(&f.db)
    .await
    .unwrap();
    let grant = Uuid::new_v4();
    let token = suncharts_engine::oauth::random("sce_at_");
    sqlx::query(
        "INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(grant)
    .bind(client)
    .bind(f.tenant)
    .bind(f.user)
    .bind(scope)
    .execute(&f.db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '1 hour')").bind(suncharts_engine::oauth::hash(&token)).bind(grant).execute(&f.db).await.unwrap();
    token
}
#[tokio::test]
async fn outbound_commands_retain_oauth_scope_tenant_and_grant_checks() {
    use suncharts_engine::connect_transport::execute;
    let f = Fixture::new().await;
    let cloud = Cloud::default();
    let started = connect_onboarding::begin_with_cloud(&f.state, &f.headers, &cloud)
        .await
        .unwrap();
    let id = Uuid::parse_str(started["id"].as_str().unwrap()).unwrap();
    let denied = execute(&f.state, f.tenant, id, command("/api/v1/connection", None)).await;
    assert_eq!(denied.status, 401);
    let token = access(&f, id, "clinical.read").await;
    let own = execute(
        &f.state,
        f.tenant,
        id,
        command("/api/v1/connection", Some(&token)),
    )
    .await;
    assert_eq!(own.status, 200);
    use base64::Engine;
    let data: Value = serde_json::from_slice(
        &base64::engine::general_purpose::STANDARD
            .decode(own.body_base64)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(data["tenant_id"], f.tenant.to_string());
    assert_eq!(data["user_id"], f.user.to_string());
    let denied = execute(
        &f.state,
        f.tenant,
        id,
        command("/api/v1/events", Some(&token)),
    )
    .await;
    assert_eq!(denied.status, 403);
    let foreign = Fixture::new().await;
    let fc = Cloud::default();
    let fs = connect_onboarding::begin_with_cloud(&foreign.state, &foreign.headers, &fc)
        .await
        .unwrap();
    let fid = Uuid::parse_str(fs["id"].as_str().unwrap()).unwrap();
    let ft = access(&foreign, fid, "clinical.read").await;
    let denied = execute(
        &f.state,
        f.tenant,
        id,
        command("/api/v1/connection", Some(&ft)),
    )
    .await;
    assert_eq!(denied.status, 403);
    sqlx::query("UPDATE oauth_grants SET revoked_at=now() WHERE tenant_id=$1")
        .bind(f.tenant)
        .execute(&f.db)
        .await
        .unwrap();
    let denied = execute(
        &f.state,
        f.tenant,
        id,
        command("/api/v1/connection", Some(&token)),
    )
    .await;
    assert_eq!(denied.status, 401);
    f.db.close().await;
    foreign.db.close().await;
}
#[tokio::test]
async fn outbound_channel_cannot_enter_browser_admin_or_arbitrary_urls() {
    use suncharts_engine::connect_transport::execute;
    let f = Fixture::new().await;
    let cloud = Cloud::default();
    let started = connect_onboarding::begin_with_cloud(&f.state, &f.headers, &cloud)
        .await
        .unwrap();
    let id = Uuid::parse_str(started["id"].as_str().unwrap()).unwrap();
    let token = access(&f, id, "clinical.read clinical.write events.read").await;
    for path in [
        "https://evil.example/api/v1/connection",
        "//evil.example/api/v1/connection",
        "/auth/me",
        "/api/v1/connect/services",
        "/api/v1/oauth/clients",
        "/api/v1/events/stream",
        "/api/v1/patients/../connection",
        "/api/v1/%63onnection",
    ] {
        assert_eq!(
            execute(&f.state, f.tenant, id, command(path, Some(&token)))
                .await
                .status,
            403,
            "{path}"
        );
    }
    let mut cookie = command("/api/v1/connection", Some(&token));
    cookie
        .headers
        .insert("cookie".into(), "sce_session=forged".into());
    assert_eq!(execute(&f.state, f.tenant, id, cookie).await.status, 403);
    let mut expired = command("/api/v1/connection", Some(&token));
    expired.expires_at = chrono::Utc::now() - chrono::Duration::seconds(1);
    assert_eq!(execute(&f.state, f.tenant, id, expired).await.status, 400);
    let mut basic = command("/oauth/token", None);
    basic.method = "POST".into();
    use base64::Engine;
    basic.headers.insert(
        "authorization".into(),
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD
                .encode(format!("{}:synthetic", Uuid::new_v4()))
        ),
    );
    assert_eq!(execute(&f.state, f.tenant, id, basic).await.status, 403);
    f.db.close().await;
}
#[tokio::test]
async fn outbound_badge_requires_fresh_live_channel_and_enabled_local_owner() {
    use suncharts_engine::connect_transport::status;
    let f = Fixture::new().await;
    assert_eq!(
        status(&f.db, f.tenant).await.unwrap()["state"],
        "not_configured"
    );
    let cloud = Cloud::default();
    let started = connect_onboarding::begin_with_cloud(&f.state, &f.headers, &cloud)
        .await
        .unwrap();
    let id = Uuid::parse_str(started["id"].as_str().unwrap()).unwrap();
    assert_eq!(status(&f.db, f.tenant).await.unwrap()["state"], "offline");
    sqlx::query("INSERT INTO connect_transport_health(tenant_id,intent_id,session_id,state,last_seen_at) VALUES($1,$2,$3,'connected',clock_timestamp())").bind(f.tenant).bind(id).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    // An enrollment heartbeat cannot certify an activated OAuth installation.
    assert_eq!(
        status(&f.db, f.tenant).await.unwrap()["state"],
        "reconnecting"
    );
    assert_eq!(status(&f.db, f.tenant).await.unwrap()["authorized"], false);
    let (_, version) = callback_ready(&f, &cloud).await;
    connect_onboarding::complete_with_cloud(&f.state, &f.headers, id, version, &cloud)
        .await
        .unwrap();
    assert_ne!(status(&f.db, f.tenant).await.unwrap()["state"], "connected");
    sqlx::query("UPDATE connect_transport_health SET state='connected',last_seen_at=clock_timestamp() WHERE tenant_id=$1 AND intent_id=$2").bind(f.tenant).bind(id).execute(&f.db).await.unwrap();
    assert_eq!(status(&f.db, f.tenant).await.unwrap()["state"], "connected");
    assert_eq!(status(&f.db, f.tenant).await.unwrap()["authorized"], true);
    sqlx::query("UPDATE connect_transport_health SET last_seen_at=clock_timestamp()-interval '46 seconds' WHERE tenant_id=$1").bind(f.tenant).execute(&f.db).await.unwrap();
    assert_ne!(status(&f.db, f.tenant).await.unwrap()["state"], "connected");
    sqlx::query(
        "UPDATE connect_transport_health SET last_seen_at=clock_timestamp() WHERE tenant_id=$1",
    )
    .bind(f.tenant)
    .execute(&f.db)
    .await
    .unwrap();
    sqlx::query("UPDATE browser_users SET disabled=true WHERE tenant_id=$1")
        .bind(f.tenant)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(status(&f.db, f.tenant).await.unwrap()["state"], "offline");
    f.db.close().await;
}
