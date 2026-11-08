// SPDX-License-Identifier: AGPL-3.0-only
//! Synthetic, database-only coverage for the multiplexed browser event stream.
use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{sync::Arc, time::Duration};
use suncharts_engine::{browser::BrowserAuth, postgres::PostgresBackend, State};
use tower::ServiceExt;
use uuid::Uuid;

async fn frame(body: &mut Body) -> Option<String> {
    tokio::time::timeout(Duration::from_secs(5), body.frame())
        .await
        .expect("browser feed should yield or terminate within one poll cycle")
        .map(|value| String::from_utf8(value.unwrap().into_data().unwrap().to_vec()).unwrap())
}

async fn open(app: &Router, cookie: &str, after: &str, last: Option<&str>) -> Body {
    let mut request = Request::builder()
        .uri(format!("/api/v1/browser/events?after={after}"))
        .header("cookie", cookie);
    if let Some(last) = last {
        request = request.header("last-event-id", last);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["x-accel-buffering"], "no");
    response.into_body()
}

async fn audit(db: &PgPool, tenant: Uuid, user: Uuid, action: &str, resource: Uuid) {
    sqlx::query(
        "INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,$3,$4)",
    )
    .bind(tenant)
    .bind(user)
    .bind(action)
    .bind(resource)
    .execute(db)
    .await
    .unwrap();
}

async fn service(
    db: &PgPool,
    tenant: Uuid,
    installation: Uuid,
    cloud_id: i64,
    resource: Uuid,
    reply: bool,
) {
    sqlx::query("INSERT INTO connect_update_events(tenant_id,installation_id,kind,resource_id,message_id,cloud_id) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(tenant).bind(installation).bind(if reply {"support.reply"} else {"support.updated"})
        .bind(resource).bind(if reply {Some(Uuid::new_v4())} else {None}).bind(cloud_id)
        .execute(db).await.unwrap();
}

#[tokio::test]
async fn multiplex_browser_stream_scopes_channels_replays_cursors_and_stops_on_revocation() {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("browser_events_test_{}", Uuid::new_v4().simple());
    let initial = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&initial)
        .await
        .unwrap();
    initial.close().await;
    let connection_schema = schema.clone();
    let db = PgPoolOptions::new()
        .max_connections(6)
        .after_connect(move |connection, _| {
            let query = format!("SET search_path TO {connection_schema}");
            Box::pin(async move {
                sqlx::query(&query).execute(connection).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let tenant = Uuid::new_v4();
    let other_tenant = Uuid::new_v4();
    let user = Uuid::new_v4();
    let other_user = Uuid::new_v4();
    let installation = Uuid::new_v4();
    let other_installation = Uuid::new_v4();
    for (tenant_id, user_id, installation_id) in [
        (tenant, user, installation),
        (other_tenant, other_user, other_installation),
    ] {
        sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-a-login','owner')")
            .bind(user_id).bind(tenant_id).bind(format!("{user_id}@example.test")).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO connect_service_settings(tenant_id,id,installation_id,enabled,verified,support_available) VALUES($1,$2,$3,true,true,true)")
            .bind(tenant_id).bind(Uuid::new_v4()).bind(installation_id).execute(&db).await.unwrap();
    }
    let token = format!("synthetic-browser-events-{}", Uuid::new_v4());
    let cookie = format!("sce_session={token}");
    // Configured Connect services intentionally disable ordinary local sessions.
    // A browser recovery session exercises the feed without remote identity IO.
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at,auth_method) VALUES($1,$2,$3,now()+interval '1 hour','break_glass')")
        .bind(suncharts_engine::oauth::hash(&token)).bind(tenant).bind(user).execute(&db).await.unwrap();
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: "synthetic-unused-secret".into(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), "http://127.0.0.1:8099".into()).unwrap()),
    });
    let path = "/api/v1/browser/events";
    let missing = app
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(missing.status(), 401);
    // Even a valid browser cookie cannot turn this route into a bearer-token stream.
    for bearer in ["Bearer sce_at_synthetic", "Bearer synthetic-gateway"] {
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("cookie", &cookie)
                    .header("authorization", bearer)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), 403);
    }
    let malformed = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/browser/events?after=-1:0")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(malformed.status(), 400);

    let draft = Uuid::new_v4();
    let workflow = Uuid::new_v4();
    let ticket = Uuid::new_v4();
    let foreign_resource = Uuid::new_v4();
    let obsolete_ticket = Uuid::new_v4();
    audit(&db, tenant, user, "ai.draft.received", draft).await;
    audit(
        &db,
        other_tenant,
        other_user,
        "ai.draft.received",
        foreign_resource,
    )
    .await;
    audit(
        &db,
        tenant,
        user,
        "practice.workflow_dispatch.finished",
        workflow,
    )
    .await;
    service(&db, tenant, installation, 1, ticket, true).await;
    service(
        &db,
        other_tenant,
        other_installation,
        1,
        foreign_resource,
        true,
    )
    .await;
    service(&db, tenant, Uuid::new_v4(), 1, obsolete_ticket, true).await;

    let mut feed = open(&app, &cookie, "0:0", None).await;
    let ready = frame(&mut feed).await.unwrap();
    assert!(ready.contains("event: ready"));
    assert!(ready.contains("id: 0:0\n"));
    assert!(ready.contains("\"unread_count\":1"));
    assert!(ready.contains(&ticket.to_string()));
    let mut frames = vec![ready];
    let mut last = String::new();
    for _ in 0..5 {
        let value = frame(&mut feed).await.unwrap();
        let finished = value.contains("event: service.change");
        if finished {
            last = value
                .lines()
                .find_map(|line| line.strip_prefix("id: "))
                .unwrap()
                .to_owned();
        }
        frames.push(value);
        if finished {
            break;
        }
    }
    let all = frames.join("");
    for channel in [
        "ai.change",
        "workflow.change",
        "connection",
        "service.change",
    ] {
        assert!(
            all.contains(&format!("event: {channel}")),
            "missing {channel}"
        );
    }
    assert!(all.contains(&draft.to_string()));
    assert!(all.contains(&workflow.to_string()));
    for excluded in [
        foreign_resource.to_string(),
        obsolete_ticket.to_string(),
        token.clone(),
    ] {
        assert!(
            !all.contains(&excluded),
            "stream disclosed unrelated or protected data"
        );
    }
    assert!(!last.is_empty());
    drop(feed);

    let next_visit = Uuid::new_v4();
    let next_ticket = Uuid::new_v4();
    audit(&db, tenant, user, "visit.updated", next_visit).await;
    service(&db, tenant, installation, 2, next_ticket, false).await;
    // Last-Event-ID wins over an old query cursor, and tracks both channels.
    let mut resumed = open(&app, &cookie, "999999999:999999999", Some(&last)).await;
    let ready = frame(&mut resumed).await.unwrap();
    assert!(ready.contains(&format!("id: {last}\n")));
    let mut replay = String::new();
    for _ in 0..4 {
        let value = frame(&mut resumed).await.unwrap();
        let finished = value.contains("event: service.change");
        replay.push_str(&value);
        if finished {
            break;
        }
    }
    assert!(replay.contains("event: clinical.change"));
    assert!(replay.contains(&next_visit.to_string()));
    assert!(replay.contains(&next_ticket.to_string()));
    assert!(!replay.contains(&draft.to_string()));
    assert!(!replay.contains(&obsolete_ticket.to_string()));

    sqlx::query("DELETE FROM browser_sessions WHERE tenant_id=$1 AND user_id=$2")
        .bind(tenant)
        .bind(user)
        .execute(&db)
        .await
        .unwrap();
    audit(&db, tenant, user, "ai.draft.received", Uuid::new_v4()).await;
    assert!(
        frame(&mut resumed).await.is_none(),
        "revoked session must stop every multiplexed channel"
    );
    drop(resumed);
    db.close().await;
    let cleanup = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&cleanup)
        .await
        .unwrap();
    cleanup.close().await;
}
