use super::*;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

const SECRET: &str = "accs_secret__synthetic_never_stored";

#[derive(Clone, Copy, PartialEq)]
enum Answer {
    Session,
    NotReady,
    NotConfigured,
    WrongMode,
    SecretKey,
}
struct Fake {
    installation: Uuid,
    tenant: Uuid,
    calls: Mutex<Vec<String>>,
    bindings: Mutex<Vec<Value>>,
    answer: Answer,
    account: Option<&'static str>,
    charges_enabled: bool,
    changed: bool,
    disable_user: Option<Uuid>,
}
impl Fake {
    fn new(installation: Uuid, tenant: Uuid) -> Self {
        Self {
            installation,
            tenant,
            calls: Mutex::new(vec![]),
            bindings: Mutex::new(vec![]),
            answer: Answer::Session,
            account: Some("acct_synthetic"),
            charges_enabled: true,
            changed: false,
            disable_user: None,
        }
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}
#[async_trait]
impl Source for Fake {
    async fn config(&self, pool: &PgPool, tenant: Uuid, setting: &Settings) -> Result<Credentials> {
        assert_eq!(tenant, self.tenant);
        if let Some(user) = self.disable_user {
            sqlx::query("UPDATE browser_users SET disabled=true WHERE tenant_id=$1 AND id=$2")
                .bind(tenant)
                .bind(user)
                .execute(pool)
                .await?;
        }
        if self.changed {
            sqlx::query("UPDATE payment_settings SET credential_revision=credential_revision+1,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(setting.id).execute(pool).await?;
        }
        Ok(Credentials {
            mode: "suncharts_connect".into(),
            api_key: None,
            webhook_secret: None,
            installation_id: Some(self.installation),
            broker_token: Some("scp_inst_synthetic_private_token".into()),
        })
    }
    async fn status(&self, _: &Credentials) -> Result<Value> {
        self.calls.lock().unwrap().push("status".into());
        Ok(
            json!({"installation_id":self.installation,"remote_tenant_id":self.tenant,"account_id":self.account,
            "livemode":false,"charges_enabled":self.charges_enabled,"details_submitted":true}),
        )
    }
    async fn session(&self, _: &Credentials, binding: &Value) -> Result<Reply> {
        self.calls.lock().unwrap().push("session".into());
        self.bindings.lock().unwrap().push(binding.clone());
        let session = json!({"client_secret":SECRET,"publishable_key":"pk_test_synthetic","livemode":false,
            "account":"must-not-leak","secret_key":"must-not-leak"});
        Ok(match self.answer {
            Answer::Session => Reply::Session(session),
            Answer::NotReady => Reply::NotReady,
            Answer::NotConfigured => Reply::NotConfigured,
            Answer::WrongMode => {
                let mut session = session;
                session["livemode"] = json!(true);
                Reply::Session(session)
            }
            Answer::SecretKey => {
                let mut session = session;
                session["publishable_key"] = json!("sk_test_must_never_reach_a_browser");
                Reply::Session(session)
            }
        })
    }
}

#[test]
fn session_contract_accepts_only_a_browser_safe_key_in_the_account_mode() {
    let good =
        json!({"client_secret":SECRET,"publishable_key":"pk_test_synthetic","livemode":false});
    let session = validate(good.clone(), false).unwrap();
    assert_eq!(session.client_secret, SECRET);
    assert_eq!(session.publishable_key, "pk_test_synthetic");
    assert!(validate(good.clone(), true).is_err(), "mode must match");
    let live =
        json!({"client_secret":SECRET,"publishable_key":"pk_live_synthetic","livemode":true});
    assert!(validate(live.clone(), true).is_ok());
    assert!(validate(live, false).is_err());
    for (key, value) in [
        ("publishable_key", json!("sk_test_synthetic")),
        ("publishable_key", json!("rk_test_synthetic")),
        ("publishable_key", json!("pk_live_synthetic")),
        ("publishable_key", json!("pk_test_")),
        ("publishable_key", json!("pk_test_\"><script>")),
        ("publishable_key", Value::Null),
        ("client_secret", json!("")),
        ("client_secret", json!("has spaces")),
        ("client_secret", json!("x".repeat(1025))),
        ("client_secret", Value::Null),
        ("livemode", json!("false")),
    ] {
        let mut v = good.clone();
        v[key] = value;
        assert!(validate(v, false).is_err(), "{key}");
    }
}

#[tokio::test]
async fn reader_ordering_is_owner_only_bound_to_the_account_and_stores_no_secret() {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL");
    let schema = format!("reader_orders_{}", Uuid::new_v4().simple());
    let admin = PgPool::connect(&url).await.unwrap();
    crate::test_db::create_schema(&admin, &schema).await;
    admin.close().await;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
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
    crate::MIGRATOR.run(&pool).await.unwrap();
    let tenant = Uuid::new_v4();
    let origin = "http://127.0.0.1:8099";
    let state = State {
        backend: Arc::new(crate::postgres::PostgresBackend(pool.clone())),
        browser: Some(crate::browser::BrowserAuth::new(pool.clone(), origin.into()).unwrap()),
        secret: "synthetic-reader-orders-jwt-secret-32-chars".into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
    };
    let installation = Uuid::new_v4();
    let make_app = |source: Arc<Fake>| {
        Router::new()
            .route(
                ROUTE,
                post(
                    move |a: Actor, ExtractState(s): ExtractState<State>, h: HeaderMap| {
                        let source = source.clone();
                        async move { create_with(a, s, h, source.as_ref()).await }
                    },
                ),
            )
            .with_state(state.clone())
    };
    let bearer = |role: Role| {
        let actor = Actor {
            sub: Uuid::new_v4(),
            tenant_id: tenant,
            role,
            patient_id: None,
            iss: state.issuer.clone(),
            aud: state.audience.clone(),
            iat: Utc::now().timestamp(),
            exp: Utc::now().timestamp() + 60,
        };
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &actor,
            &jsonwebtoken::EncodingKey::from_secret(state.secret.as_bytes()),
        )
        .unwrap();
        format!("Bearer {token}")
    };
    let post_as = |source: Arc<Fake>, authorization: String| {
        let app = make_app(source);
        async move {
            let response = app
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri(ROUTE)
                        .header("authorization", authorization)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status().as_u16();
            let headers = response.headers().clone();
            let bytes = axum::body::to_bytes(response.into_body(), 131072)
                .await
                .unwrap();
            let text = String::from_utf8(bytes.to_vec()).unwrap();
            (
                status,
                headers,
                serde_json::from_str::<Value>(&text).unwrap_or(Value::Null),
                text,
            )
        }
    };

    // No payment account yet: a plain "not connected" answer and no call to Connect.
    let source = Arc::new(Fake::new(installation, tenant));
    let (status, headers, value, _) = post_as(source.clone(), bearer(Role::Owner)).await;
    assert_eq!(status, 200);
    assert_eq!(headers["cache-control"], "no-store");
    assert_eq!(value, json!({"status":"not_connected"}));
    assert!(source.calls().is_empty());

    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO payment_settings(tenant_id,id,mode,provider_account_id) VALUES($1,$2,'suncharts_connect','acct_synthetic')").bind(tenant).bind(id).execute(&pool).await.unwrap();
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(s) FROM payment_settings s WHERE tenant_id=$1")
            .bind(tenant)
            .fetch_one(&pool)
            .await
            .unwrap();

    let source = Arc::new(Fake::new(installation, tenant));
    for (role, wanted) in [
        (Role::Owner, 200),
        (Role::Clinician, 403),
        (Role::FrontDesk, 403),
        (Role::ReadOnly, 403),
        (Role::PartnerSupport, 401), // Legacy tokens cannot impersonate a delegated session.
    ] {
        let (status, headers, value, text) = post_as(source.clone(), bearer(role)).await;
        assert_eq!(status, wanted);
        if wanted == 200 {
            assert_eq!(headers["cache-control"], "no-store");
            assert_eq!(
                value,
                json!({"status":"ready","client_secret":SECRET,"publishable_key":"pk_test_synthetic","livemode":false})
            );
            assert!(!text.contains("must-not-leak"));
            assert!(!text.contains("scp_inst_"));
        } else {
            assert!(!text.contains("accs_secret"));
        }
    }
    assert_eq!(
        source.calls(),
        ["status", "session"],
        "only the owner reaches Connect"
    );
    assert_eq!(
        source.bindings.lock().unwrap()[0],
        json!({"account_id":"acct_synthetic","livemode":false,"remote_tenant_id":tenant})
    );
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='payment.reader_order_session_opened' AND resource_id=$2",
    )
    .bind(tenant)
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, 1);
    let after: Value =
        sqlx::query_scalar("SELECT to_jsonb(s) FROM payment_settings s WHERE tenant_id=$1")
            .bind(tenant)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        before, after,
        "ordering a reader changes no payment setting"
    );
    let stored: String = sqlx::query_scalar(
        "SELECT coalesce(jsonb_agg(to_jsonb(e))::text,'') FROM audit_events e WHERE tenant_id=$1",
    )
    .bind(tenant)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!stored.contains("accs_secret"));
    for table in [
        "billing_entries",
        "payment_attempts",
        "billing_copay_receipts",
        "copay_checkout_attempts",
    ] {
        let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table}");
    }

    // Connect's own answers map to the two plain states the page shows.
    for (answer, wanted) in [
        (Answer::NotConfigured, json!({"status":"unavailable"})),
        (Answer::NotReady, json!({"status":"not_connected"})),
    ] {
        let mut fake = Fake::new(installation, tenant);
        fake.answer = answer;
        let (status, _, value, _) = post_as(Arc::new(fake), bearer(Role::Owner)).await;
        assert_eq!(status, 200);
        assert_eq!(value, wanted);
    }
    // Stripe setup not finished, or no Stripe account: not connected, and no session is requested.
    for (account, charges_enabled) in [(Some("acct_synthetic"), false), (None, true)] {
        let mut fake = Fake::new(installation, tenant);
        fake.account = account;
        fake.charges_enabled = charges_enabled;
        let fake = Arc::new(fake);
        let (status, _, value, _) = post_as(fake.clone(), bearer(Role::Owner)).await;
        assert_eq!(status, 200);
        assert_eq!(value, json!({"status":"not_connected"}));
        assert_eq!(fake.calls(), ["status"]);
    }
    // A session for another mode, a non-publishable key, or another account never reaches a browser.
    for answer in [Answer::WrongMode, Answer::SecretKey] {
        let mut fake = Fake::new(installation, tenant);
        fake.answer = answer;
        let (status, _, _, text) = post_as(Arc::new(fake), bearer(Role::Owner)).await;
        assert_eq!(status, 400);
        assert!(!text.contains("accs_secret") && !text.contains("sk_test_"));
    }
    let mut fake = Fake::new(installation, tenant);
    fake.account = Some("acct_other");
    let fake = Arc::new(fake);
    let (status, _, _, _) = post_as(fake.clone(), bearer(Role::Owner)).await;
    assert_eq!(status, 400);
    assert_eq!(fake.calls(), ["status"]);

    let mut actor = crate::delivery::worker(tenant);
    actor.role = Role::Owner;
    actor.tenant_id = Uuid::new_v4();
    let other_tenant = Fake::new(installation, tenant);
    assert_eq!(
        load(&actor, &state, &other_tenant).await.unwrap(),
        json!({"status":"not_connected"}),
        "another practice has no payment account here"
    );
    assert!(other_tenant.calls().is_empty());
    actor.tenant_id = tenant;
    let mut changed = Fake::new(installation, tenant);
    changed.changed = true;
    assert!(matches!(
        load(&actor, &state, &changed).await,
        Err(Error::Conflict(_))
    ));

    // A browser session that ends while Connect is answering receives nothing.
    let user = Uuid::new_v4();
    let cookie = "synthetic_reader_orders_cookie";
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,'synthetic-readers@example.test','unused','owner')").bind(user).bind(tenant).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')").bind(crate::browser::hash(cookie)).bind(tenant).bind(user).execute(&pool).await.unwrap();
    let cookie_post = |source: Arc<Fake>, origin: Option<&'static str>| {
        let app = make_app(source);
        async move {
            let mut request = axum::http::Request::builder()
                .method("POST")
                .uri(ROUTE)
                .header("cookie", format!("sce_session={cookie}"));
            if let Some(origin) = origin {
                request = request.header("origin", origin);
            }
            let response = app
                .oneshot(request.body(axum::body::Body::empty()).unwrap())
                .await
                .unwrap();
            let status = response.status().as_u16();
            let bytes = axum::body::to_bytes(response.into_body(), 131072)
                .await
                .unwrap();
            (status, String::from_utf8(bytes.to_vec()).unwrap())
        }
    };
    let cross_site = Arc::new(Fake::new(installation, tenant));
    let (status, text) = cookie_post(cross_site.clone(), Some("https://evil.example")).await;
    assert_ne!(status, 200, "another site cannot open reader ordering");
    assert!(!text.contains("accs_secret"));
    assert!(cross_site.calls().is_empty());
    let signed_in = Arc::new(Fake::new(installation, tenant));
    let (status, text) = cookie_post(signed_in.clone(), Some(origin)).await;
    assert_eq!(status, 200);
    assert!(text.contains(SECRET));
    let mut fake = Fake::new(installation, tenant);
    fake.disable_user = Some(user);
    let revoked = Arc::new(fake);
    let (status, text) = cookie_post(revoked.clone(), Some(origin)).await;
    assert_eq!(status, 401);
    assert!(!text.contains("accs_secret"));
    assert_eq!(
        revoked.calls(),
        ["status", "session"],
        "sign-in is checked again after the slow Connect call"
    );
    pool.close().await;
}
