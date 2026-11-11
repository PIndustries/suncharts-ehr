use super::*;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;
struct Fake {
    installation: Uuid,
    tenant: Uuid,
    calls: Mutex<Vec<String>>,
    changed: bool,
    disable_user: Option<Uuid>,
}
fn snapshot(installation: Uuid, tenant: Uuid) -> Value {
    json!({"contract_version":1,"installation_id":installation,"remote_tenant_id":tenant,"account_id":"acct_synthetic","livemode":false,"checked_at":Utc::now(),"limit":10,"account":{"charges_enabled":true,"card_payments_active":true,"payouts_enabled":true,"details_submitted":true},"balance":{"status":"available","data":{"available":[{"amount":-150,"currency":"usd"}],"pending":[{"amount":2500,"currency":"usd"}]}},"payments":{"status":"available","data":{"items":[{"id":"pi_synthetic","status":"succeeded","amount":2500,"amount_received":2500,"currency":"usd","created":Utc::now().timestamp(),"client_secret":"must-not-leak","metadata":{"patient":"must-not-leak"}}],"has_more":false}},"payouts":{"status":"unavailable","data":null},"raw_secret":"must-not-leak"})
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
    async fn get(&self, _: &Credentials, path: &str) -> Result<Value> {
        self.calls.lock().unwrap().push(path.to_owned());
        if path == "/status" {
            return Ok(
                json!({"installation_id":self.installation,"remote_tenant_id":self.tenant,"account_id":"acct_synthetic","livemode":false}),
            );
        }
        assert!(path
            .starts_with("/operations?account_id=acct_synthetic&livemode=false&remote_tenant_id="));
        Ok(snapshot(self.installation, self.tenant))
    }
}
#[test]
fn operations_contract_rejects_misbinding_and_never_serializes_unlisted_fields() {
    let installation = Uuid::new_v4();
    let tenant = Uuid::new_v4();
    let base = snapshot(installation, tenant);
    let parsed = validate(base.clone(), installation, tenant, "acct_synthetic", false).unwrap();
    let serialized = serde_json::to_string(&parsed).unwrap();
    assert!(!serialized.contains("must-not-leak"));
    assert!(serialized.contains("unavailable"));
    for (key, value) in [
        ("installation_id", json!(Uuid::new_v4())),
        ("remote_tenant_id", json!(Uuid::new_v4())),
        ("account_id", json!("acct_other")),
        ("livemode", json!(true)),
        ("contract_version", json!(2)),
        (
            "checked_at",
            json!(Utc::now() - chrono::Duration::minutes(6)),
        ),
    ] {
        let mut v = base.clone();
        v[key] = value;
        assert!(
            validate(v, installation, tenant, "acct_synthetic", false).is_err(),
            "{key}"
        );
    }
    for path in ["balance", "payments", "payouts"] {
        let mut v = base.clone();
        v[path]["status"] = json!("available");
        v[path]["data"] = Value::Null;
        assert!(validate(v, installation, tenant, "acct_synthetic", false).is_err());
    }
    let mut v = base;
    v["payments"]["data"]["items"][0]["amount_received"] = json!(-1);
    assert!(validate(v, installation, tenant, "acct_synthetic", false).is_err());
}
#[tokio::test]
async fn operations_http_owner_scope_and_revision_are_enforced_without_financial_writes() {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL");
    let schema = format!("operations_{}", Uuid::new_v4().simple());
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
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO payment_settings(tenant_id,id,mode,provider_account_id) VALUES($1,$2,'suncharts_connect','acct_synthetic')").bind(tenant).bind(id).execute(&pool).await.unwrap();
    let state = State {
        backend: Arc::new(crate::postgres::PostgresBackend(pool.clone())),
        browser: Some(
            crate::browser::BrowserAuth::new(pool.clone(), "http://127.0.0.1:8099".into()).unwrap(),
        ),
        secret: "synthetic-operations-jwt-secret-32-characters".into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
    };
    let source = Arc::new(Fake {
        installation: Uuid::new_v4(),
        tenant,
        calls: Mutex::new(vec![]),
        changed: false,
        disable_user: None,
    });
    let make_app = |source: Arc<Fake>| {
        Router::new()
            .route(
                "/api/v1/billing/payments/operations",
                get(
                    move |a: Actor, ExtractState(s): ExtractState<State>, h: HeaderMap| {
                        let source = source.clone();
                        async move { read_with(a, s, h, source.as_ref()).await }
                    },
                ),
            )
            .with_state(state.clone())
    };
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(s) FROM payment_settings s WHERE tenant_id=$1")
            .bind(tenant)
            .fetch_one(&pool)
            .await
            .unwrap();
    for (role, wanted) in [
        (Role::Owner, 200),
        (Role::Clinician, 403),
        (Role::ReadOnly, 403),
        (Role::PartnerSupport, 401), // Legacy tokens cannot impersonate a delegated session.
    ] {
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
        let response = make_app(source.clone())
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/billing/payments/operations")
                    .header("authorization", format!("Bearer {token}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), wanted);
        if wanted == 200 {
            assert_eq!(response.headers()["cache-control"], "no-store");
            let bytes = axum::body::to_bytes(response.into_body(), 131072)
                .await
                .unwrap();
            let text = String::from_utf8(bytes.to_vec()).unwrap();
            assert!(!text.contains("must-not-leak"));
            assert!(!text.contains("scp_inst_"));
        }
    }
    assert_eq!(source.calls.lock().unwrap().len(), 2);
    let after: Value =
        sqlx::query_scalar("SELECT to_jsonb(s) FROM payment_settings s WHERE tenant_id=$1")
            .bind(tenant)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(before, after);
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
        assert_eq!(n, 0);
    }
    let mut actor = crate::delivery::worker(tenant);
    actor.role = Role::Owner;
    actor.tenant_id = Uuid::new_v4();
    assert!(load(&actor, &state, source.as_ref()).await.is_err());
    assert_eq!(source.calls.lock().unwrap().len(), 2);
    actor.tenant_id = tenant;
    let changed = Fake {
        installation: source.installation,
        tenant,
        calls: Mutex::new(vec![]),
        changed: true,
        disable_user: None,
    };
    assert!(matches!(
        load(&actor, &state, &changed).await,
        Err(Error::Conflict(_))
    ));
    let user = Uuid::new_v4();
    let cookie = "synthetic_operations_cookie";
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,'synthetic-operations@example.test','unused','owner')").bind(user).bind(tenant).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')").bind(crate::browser::hash(cookie)).bind(tenant).bind(user).execute(&pool).await.unwrap();
    let revoked = Arc::new(Fake {
        installation: source.installation,
        tenant,
        calls: Mutex::new(vec![]),
        changed: false,
        disable_user: Some(user),
    });
    let response = make_app(revoked.clone())
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/v1/billing/payments/operations")
                .header("cookie", format!("sce_session={cookie}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        axum::http::StatusCode::UNAUTHORIZED,
        "session disabled during broker read cannot receive financial data"
    );
    assert_eq!(
        revoked.calls.lock().unwrap().len(),
        2,
        "revocation is checked after slow provider I/O"
    );
    pool.close().await;
}
