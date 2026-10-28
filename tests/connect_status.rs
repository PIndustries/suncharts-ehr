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
const SECRET: &str = "synthetic-reminder-test-secret";
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
async fn setup() -> (PgPool, Actor, Uuid, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("connect_status_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&base)
        .await
        .unwrap();
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
    user(&db, &a, a.sub, "owner", false).await;
    let p = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-REMINDER','Avery','Synthetic','1990-01-01')").bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    sqlx::query(
        "INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,$3)",
    )
    .bind(a.tenant_id)
    .bind(p)
    .bind(json!({"email":"synthetic@example.test","phone":"555-0100"}))
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,now()+interval '48 hours',now()+interval '48 hours 30 minutes','booked')").bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(&db).await.unwrap();
    (db, a, p, appointment)
}
async fn user(db: &PgPool, a: &Actor, id: Uuid, role: &str, disabled: bool) {
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login',$4,$5)").bind(id).bind(a.tenant_id).bind(format!("{}@example.test",id.simple())).bind(role).bind(disabled).execute(db).await.unwrap();
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
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        request = request.header("If-Match", format!("\"{v}\""));
    }
    let response = r
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&body)
            .unwrap_or_else(|_| json!({"message":String::from_utf8_lossy(&body)})),
    )
}
async fn grant(db: &PgPool, a: &Actor, user: Uuid, redirect: &str) -> (Uuid, Uuid) {
    let client = Uuid::new_v4();
    let grant = Uuid::new_v4();
    sqlx::query("INSERT INTO oauth_clients(id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES($1,$2,'SunCharts','synthetic-unused-secret',$3,'clinical.read offline_access')").bind(client).bind(a.tenant_id).bind(redirect).execute(db).await.unwrap();
    sqlx::query("INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,'clinical.read offline_access')").bind(grant).bind(client).bind(a.tenant_id).bind(user).execute(db).await.unwrap();
    sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'refresh',now()+interval '1 day')").bind(Uuid::new_v4().to_string()).bind(grant).execute(db).await.unwrap();
    (client, grant)
}
struct Probe {
    value: Value,
    calls: std::sync::atomic::AtomicUsize,
}
#[async_trait::async_trait]
impl suncharts_engine::connect_services::StatusProbe for Probe {
    async fn status(&self, _: Uuid, key: &str) -> suncharts_engine::error::Result<Value> {
        assert_eq!(key, "scs_inst_synthetic_private_token_12345");
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(self.value.clone())
    }
}
#[tokio::test]
async fn official_authorization_and_fresh_roundtrip_are_distinct_and_tenant_scoped() {
    let keydir = std::env::temp_dir().join(format!("connect-status-key-{}", Uuid::new_v4()));
    std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", keydir.join("master.key"));
    let (db, a, p, _) = setup().await;
    let r = app(db.clone());
    let path = "/api/v1/connect/status";
    let (status, empty) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(status, 200, "{empty}");
    assert_eq!(empty["status"], "not_connected");
    let mut patient = a.clone();
    patient.role = Role::Patient;
    patient.patient_id = Some(p);
    assert_eq!(
        call(&r, &patient, "GET", path, Value::Null, None).await.0,
        403
    );
    let mut reader = a.clone();
    reader.role = Role::ReadOnly;
    assert_eq!(
        call(&r, &reader, "GET", path, Value::Null, None).await.0,
        200
    );
    assert_eq!(
        call(
            &r,
            &reader,
            "POST",
            "/api/v1/connect/status/refresh",
            json!({}),
            None
        )
        .await
        .0,
        200
    );
    let (_, _rogue) = grant(
        &db,
        &a,
        a.sub,
        "https://attacker.example/oauth/ehr/callback",
    )
    .await;
    let (_, untrusted) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(
        untrusted["practice_authorized"], false,
        "a client name is not identity"
    );
    let other = Uuid::new_v4();
    user(&db, &a, other, "clinician", false).await;
    let (_, _other_grant) = grant(
        &db,
        &a,
        other,
        "https://my.suncharts.app/oauth/ehr/callback",
    )
    .await;
    let (_, practice) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(practice["status"], "authorized");
    assert_eq!(practice["practice_authorized"], true);
    assert_eq!(practice["your_account_authorized"], false);
    let (client, own_grant) = grant(
        &db,
        &a,
        a.sub,
        "https://my.suncharts.app/oauth/ehr/callback",
    )
    .await;
    let (_, own) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(own["your_account_authorized"], true);
    assert_eq!(own["authorization"]["active_grants"], 2);
    sqlx::query("UPDATE oauth_tokens SET used_at=now() WHERE grant_id=$1")
        .bind(own_grant)
        .execute(&db)
        .await
        .unwrap();
    let (_, used) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(used["your_account_authorized"], false);
    sqlx::query("UPDATE oauth_tokens SET used_at=NULL,expires_at=now()-interval '1 second' WHERE grant_id=$1").bind(own_grant).execute(&db).await.unwrap();
    let (_, expired) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(expired["your_account_authorized"], false);
    sqlx::query("UPDATE oauth_tokens SET expires_at=now()+interval '1 day' WHERE grant_id=$1")
        .bind(own_grant)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE oauth_clients SET disabled=true WHERE id=$1")
        .bind(client)
        .execute(&db)
        .await
        .unwrap();
    let (_, disabled) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(disabled["your_account_authorized"], false);
    sqlx::query("UPDATE oauth_clients SET disabled=false WHERE id=$1")
        .bind(client)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE oauth_grants SET revoked_at=now() WHERE id=$1")
        .bind(own_grant)
        .execute(&db)
        .await
        .unwrap();
    let (_, revoked) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(revoked["your_account_authorized"], false);
    sqlx::query("UPDATE browser_users SET disabled=true WHERE id=$1")
        .bind(other)
        .execute(&db)
        .await
        .unwrap();
    let (_, inactive) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(inactive["practice_authorized"], false);
    let mut foreign = a.clone();
    foreign.tenant_id = Uuid::new_v4();
    let (_, isolated) = call(&r, &foreign, "GET", path, Value::Null, None).await;
    assert_eq!(isolated["status"], "not_connected");
    let install = Uuid::new_v4();
    let services = "/api/v1/connect/services/settings";
    let(status,saved)=call(&r,&a,"PUT",services,json!({"installation_id":install,"installation_token":"scs_inst_synthetic_private_token_12345"}),Some(0)).await;
    assert_eq!(status, 200, "{saved}");
    sqlx::query("UPDATE connect_service_settings SET enabled=true,verified=true,reminders_available=true,support_available=true,last_test_at=now() WHERE tenant_id=$1").bind(a.tenant_id).execute(&db).await.unwrap();
    let (_, unverified_online) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(unverified_online["status"], "needs_attention");
    assert_eq!(unverified_online["services"]["availability"], "unknown");
    let probe = Probe {
        value: json!({"installation_id":install,"remote_tenant_id":a.tenant_id,"active":true,"managed_email_ready":true,"support_ready":true,"entitled":true,"services":{"reminders":{"from_email":"SunCharts <appointments@suncharts.app>"}}}),
        calls: 0.into(),
    };
    let refreshed =
        suncharts_engine::connect_services::refresh_status_with_probe(&reader, &db, &probe)
            .await
            .unwrap();
    assert_eq!(refreshed["status"], "connected");
    assert_eq!(refreshed["services"]["fresh"], true);
    assert_eq!(refreshed["services"]["reminders_available"], true);
    assert!(refreshed["services"]["last_checked_at"].is_string());
    let (_, settings_after) = call(&r, &a, "GET", services, Value::Null, None).await;
    assert_eq!(settings_after["setting"]["enabled"], true);
    assert_eq!(
        settings_after["setting"]["version"], 1,
        "health must not invalidate configuration drafts"
    );
    let (_, cached) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(cached["status"], "connected");
    suncharts_engine::connect_services::refresh_status_with_probe(&a, &db, &probe)
        .await
        .unwrap();
    assert_eq!(
        probe.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "GET and a fresh refresh must not repeatedly call upstream"
    );
    sqlx::query("UPDATE connect_service_health SET checked_at=now()-interval '6 minutes' WHERE tenant_id=$1").bind(a.tenant_id).execute(&db).await.unwrap();
    let (_, stale) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(stale["status"], "needs_attention");
    assert_eq!(stale["services"]["fresh"], false);
    let bad = Probe {
        value: json!({"installation_id":install,"remote_tenant_id":Uuid::new_v4(),"active":true,"managed_email_ready":true,"support_ready":true}),
        calls: 0.into(),
    };
    let rejected = suncharts_engine::connect_services::refresh_status_with_probe(&a, &db, &bad)
        .await
        .unwrap();
    assert_eq!(rejected["status"], "needs_attention");
    assert_eq!(rejected["services"]["availability"], "unavailable");
    assert!(rejected["services"]["last_verified_at"].is_string());
    // Live capabilities can change independently of stored owner setup.
    sqlx::query(
        "UPDATE connect_service_health SET checked_at=now()-interval '1 minute' WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .execute(&db)
    .await
    .unwrap();
    let mut limited = probe.value.clone();
    limited["managed_email_ready"] = json!(false);
    let limited = Probe {
        value: limited,
        calls: 0.into(),
    };
    let snapshot = suncharts_engine::connect_services::refresh_status_with_probe(&a, &db, &limited)
        .await
        .unwrap();
    assert_eq!(snapshot["status"], "connected");
    assert_eq!(snapshot["services"]["reminders_available"], false);
    sqlx::query("UPDATE connect_service_settings SET enabled=false WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .execute(&db)
        .await
        .unwrap();
    let (_, disabled) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(disabled["status"], "needs_attention");
    // A failed health audit cannot commit new connectivity evidence.
    sqlx::query(
        "UPDATE connect_service_health SET checked_at=now()-interval '1 minute' WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("CREATE FUNCTION reject_health_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='connect.status_refreshed' THEN RAISE EXCEPTION 'synthetic health audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_health_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_health_audit()").execute(&db).await.unwrap();
    assert!(
        suncharts_engine::connect_services::refresh_status_with_probe(&a, &db, &probe)
            .await
            .is_err()
    );
    let (_, rolledback) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(rolledback["services"]["reminders_available"], false);
    sqlx::query("DROP TRIGGER reject_health_audit ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    // Rotation invalidates health binding rather than carrying a previous Connected badge.
    assert_eq!(call(&r,&a,"PUT",services,json!({"installation_id":install,"installation_token":"scs_inst_rotated_different_token_56789"}),Some(1)).await.0,200);
    let (_, rotated) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(rotated["services"]["fresh"], false);
    assert!(rotated["services"]["last_checked_at"].is_null());
    assert_eq!(
        call(&r, &a, "DELETE", services, Value::Null, Some(2))
            .await
            .0,
        200
    );
    let (_, cleanup) = call(&r, &a, "GET", path, Value::Null, None).await;
    assert_eq!(cleanup["status"], "not_connected");
    db.close().await;
    let _ = std::fs::remove_dir_all(keydir);
}
