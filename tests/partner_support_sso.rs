// SPDX-License-Identifier: AGPL-3.0-only
//! Delegated partner support is read-only, revalidated and audited without staff credentials.

use axum::{
    body::Body,
    extract::State as ExtractState,
    http::{header, Request, StatusCode},
    routing::post,
    Json, Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use suncharts_engine::{app, browser::BrowserAuth, postgres::PostgresBackend, State, MIGRATOR};
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Clone)]
struct Cloud {
    active: Arc<AtomicBool>,
    issuer: String,
    audience: String,
    tenant: Uuid,
    partner: Uuid,
    customer: Uuid,
    order: Uuid,
}

async fn exchange(
    ExtractState(cloud): ExtractState<Cloud>,
    Json(body): Json<Value>,
) -> Json<Value> {
    let grant = if body["code"].as_str().unwrap_or_default().contains("logout") {
        Uuid::from_u128(1)
    } else {
        Uuid::from_u128(2)
    };
    let now = chrono::Utc::now().timestamp();
    Json(json!({
        "iss":cloud.issuer,"aud":cloud.audience,"sub":"partner:synthetic",
        "jti":grant,"role":"partner_support","partner_id":cloud.partner,
        "customer_id":cloud.customer,"order_id":cloud.order,"tenant_id":cloud.tenant,
        "iat":now,"exp":now+600
    }))
}

async fn introspect(
    ExtractState(cloud): ExtractState<Cloud>,
    Json(body): Json<Value>,
) -> Json<Value> {
    if !cloud.active.load(Ordering::SeqCst) {
        return Json(json!({"active":false}));
    }
    Json(json!({
        "active":true,"jti":body["jti"],"aud":cloud.audience,"role":"partner_support",
        "partner_id":cloud.partner,"customer_id":cloud.customer,"order_id":cloud.order,
        "tenant_id":cloud.tenant,"exp":chrono::Utc::now().timestamp()+590
    }))
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    origin: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value, Option<String>) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    if let Some(origin) = origin {
        request = request.header(header::ORIGIN, origin);
    }
    let request = match body {
        Some(body) => request
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => request.body(Body::empty()).unwrap(),
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap().to_string());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()));
    (status, value, cookie)
}

#[tokio::test]
async fn delegated_support_is_read_only_revalidated_and_audited() {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("skip: TEST_DATABASE_URL is unset");
        return;
    };
    let db = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .unwrap();
    sqlx::query("DROP SCHEMA public CASCADE")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("CREATE SCHEMA public")
        .execute(&db)
        .await
        .unwrap();
    MIGRATOR.run(&db).await.unwrap();
    let tenant = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,'owner@example.test','synthetic-not-a-login','owner')")
        .bind(Uuid::new_v4()).bind(tenant).execute(&db).await.unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let audience = "http://127.0.0.1:8090".to_string();
    let active = Arc::new(AtomicBool::new(true));
    let cloud = Cloud {
        active: active.clone(),
        issuer: issuer.clone(),
        audience: audience.clone(),
        tenant,
        partner: Uuid::new_v4(),
        customer: Uuid::new_v4(),
        order: Uuid::new_v4(),
    };
    let cloud_app = Router::new()
        .route("/api/v1/managed-ehr/support/exchange", post(exchange))
        .route("/api/v1/managed-ehr/support/introspect", post(introspect))
        .with_state(cloud);
    let cloud_task = tokio::spawn(async move { axum::serve(listener, cloud_app).await.unwrap() });
    std::env::set_var("ENGINE_CONNECT_CLOUD_URL", &issuer);
    std::env::set_var("ENGINE_CONNECT_ALLOW_LOOPBACK", "true");

    let app = app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: String::new(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), audience.clone()).unwrap()),
    });
    let accept = |code: &str| {
        call(
            &app,
            "POST",
            "/api/v1/connect/support/accept",
            None,
            Some(&audience),
            Some(json!({"code":code,"issuer":issuer})),
        )
    };
    let (status, _, cookie) = accept("synthetic-logout-code-abcdefghijklmnopqrstuvwxyz").await;
    assert_eq!(status, StatusCode::OK);
    let cookie = cookie.unwrap();
    let (status, me, _) = call(&app, "GET", "/auth/me", Some(&cookie), None, None).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["role"], "partner_support");
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/patients",
            Some(&cookie),
            Some(&audience),
            Some(json!({})),
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/auth/logout",
            Some(&cookie),
            Some(&audience),
            None,
        )
        .await
        .0,
        StatusCode::OK
    );

    let (_, _, revoked_cookie) = accept("synthetic-revoked-code-abcdefghijklmnopqrstuvwxyz").await;
    let revoked_cookie = revoked_cookie.unwrap();
    active.store(false, Ordering::SeqCst);
    assert_eq!(
        call(
            &app,
            "GET",
            "/auth/me",
            Some(&revoked_cookie),
            None,
            None,
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let actions: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_events WHERE action LIKE 'partner_support.%' ORDER BY id",
    )
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(
        actions,
        vec![
            "partner_support.session_created",
            "partner_support.logout",
            "partner_support.session_created",
            "partner_support.revoked"
        ]
    );

    cloud_task.abort();
    std::env::remove_var("ENGINE_CONNECT_CLOUD_URL");
    std::env::remove_var("ENGINE_CONNECT_ALLOW_LOOPBACK");
}
