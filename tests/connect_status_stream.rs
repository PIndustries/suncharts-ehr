// SPDX-License-Identifier: AGPL-3.0-only
//! The browser health feed is session-bound and stops when that session is revoked.
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{sync::Arc, time::Duration};
use suncharts_engine::{browser::BrowserAuth, postgres::PostgresBackend, State};
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn browser_health_stream_reauthenticates_and_does_not_accept_gateway_tokens() {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("connect_stream_{}", Uuid::new_v4().simple());
    let initial = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&initial)
        .await
        .unwrap();
    initial.close().await;
    let db = PgPoolOptions::new()
        .max_connections(6)
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
    let tenant = Uuid::new_v4();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,'stream@example.test','synthetic-not-a-login','owner')")
        .bind(user).bind(tenant).execute(&db).await.unwrap();
    let token = format!("synthetic-session-{}", Uuid::new_v4());
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')")
        .bind(suncharts_engine::oauth::hash(&token)).bind(tenant).bind(user).execute(&db).await.unwrap();
    let state = State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: "synthetic-unused-secret".into(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), "http://127.0.0.1:8099".into()).unwrap()),
    };
    let app = suncharts_engine::app(state);
    let path = "/api/v1/connect/status/events";
    let missing = app
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(missing.status(), 401);
    let mut response = app
        .oneshot(
            Request::builder()
                .uri(path)
                .header("cookie", format!("sce_session={token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    assert_eq!(response.headers()["cache-control"], "no-store");
    let frame = tokio::time::timeout(Duration::from_secs(3), response.body_mut().frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    let data = std::str::from_utf8(&frame).unwrap();
    assert!(data.contains("event: connection"), "{data}");
    assert!(data.contains("not_connected"), "{data}");
    assert!(!data.contains(&token));
    sqlx::query("DELETE FROM browser_sessions WHERE user_id=$1")
        .bind(user)
        .execute(&db)
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(3), response.body_mut().frame())
            .await
            .unwrap()
            .is_none(),
        "revoked browser session must terminate the feed"
    );
    db.close().await;
}
