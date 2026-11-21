// SPDX-License-Identifier: AGPL-3.0-only
//! A staff member's private calendar link: busy times only, one link per person, and an old link
//! stops working the moment a new one is made or it is turned off. Synthetic data only.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::Arc;
use suncharts_engine::{browser::BrowserAuth, postgres::PostgresBackend, State};
use tower::ServiceExt;
use uuid::Uuid;
const ORIGIN: &str = "http://127.0.0.1:8099";
#[allow(dead_code)]
struct Fixture {
    db: PgPool,
    app: Router,
    tenant: Uuid,
    owner: Uuid,
    cookie: String,
    schema: String,
    url: String,
}
async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("calendar_feed_{}", Uuid::new_v4().simple());
    let schema_clone = schema.clone();
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |c, _| {
            let query = format!("SET search_path TO {schema_clone}");
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
    let owner = Uuid::new_v4();
    let cookie = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'owner@example.test','synthetic-not-a-login-hash','owner')").bind(tenant).bind(owner).execute(&db).await.unwrap();
    session(&db, tenant, owner, &cookie).await;
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: "synthetic-calendar-feed-test-secret".into(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
    });
    Fixture {
        db,
        app,
        tenant,
        owner,
        cookie,
        schema,
        url,
    }
}
async fn session(db: &PgPool, tenant: Uuid, user: Uuid, cookie: &str) {
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(format!("{:x}",Sha256::digest(cookie.as_bytes()))).bind(tenant).bind(user).execute(db).await.unwrap();
}
async fn cleanup(f: Fixture) {
    f.db.close().await;
    let base = PgPool::connect(&f.url).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", f.schema))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
}
async fn call(
    app: &Router,
    cookie: &str,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let mut q = Request::builder()
        .method(method)
        .uri(path)
        .header("Cookie", format!("sce_session={cookie}"))
        .header("Origin", ORIGIN)
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        q = q.header("If-Match", format!("\"{v}\""));
    }
    let response = app
        .clone()
        .oneshot(q.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let data = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&data).unwrap_or(Value::Null))
}
async fn user(f: &Fixture, role: &str) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let cookie = format!("synthetic-{role}-{}", Uuid::new_v4().simple());
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-a-login-hash',$4)")
        .bind(f.tenant)
        .bind(id)
        .bind(format!("{id}@example.test"))
        .bind(role)
        .execute(&f.db)
        .await
        .unwrap();
    session(&f.db, f.tenant, id, &cookie).await;
    (id, cookie)
}

async fn feed(app: &Router, path: &str) -> (StatusCode, String, String) {
    let response = app
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let kind = response
        .headers()
        .get("content-type")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    let data = response.into_body().collect().await.unwrap().to_bytes();
    (status, kind, String::from_utf8_lossy(&data).into_owned())
}
#[tokio::test]
async fn the_calendar_link_shows_busy_times_only_and_an_old_link_stops() {
    let f = setup().await;
    let (clinician, cookie) = user(&f, "clinician").await;
    let (other, other_cookie) = user(&f, "clinician").await;
    let patient = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-1','Synthetic','Zzpatient','1980-01-01')").bind(f.tenant).bind(patient).execute(&f.db).await.unwrap();
    // One standing appointment, one cancelled, one for somebody else.
    for (who, status, hour) in [
        (clinician, "booked", 15),
        (clinician, "cancelled", 17),
        (other, "booked", 19),
    ] {
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,date_trunc('day',now())+interval '1 day'+make_interval(hours=>$5),date_trunc('day',now())+interval '1 day'+make_interval(hours=>$5,mins=>30),$6)")
            .bind(f.tenant).bind(Uuid::new_v4()).bind(patient).bind(who).bind(hour).bind(status).execute(&f.db).await.unwrap();
    }
    sqlx::query("INSERT INTO schedule_blocks(tenant_id,id,clinician_id,starts_at,ends_at,label,request_id,request_digest) VALUES($1,$2,$3,date_trunc('day',now())+interval '2 days',date_trunc('day',now())+interval '2 days 1 hour','Synthetic private label',$4,'synthetic')")
        .bind(f.tenant).bind(Uuid::new_v4()).bind(clinician).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();

    let link = "/api/v1/schedule/calendar-link";
    let (status, value) = call(&f.app, &cookie, "GET", link, Value::Null, None).await;
    assert_eq!((status, &value["active"]), (StatusCode::OK, &json!(false)));
    let (status, made) = call(&f.app, &cookie, "POST", link, Value::Null, None).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let path = made["path"].as_str().unwrap().to_string();
    assert!(path.starts_with("/calendar/") && path.ends_with(".ics"));

    // Anyone holding the link reads it without signing in, so it carries times and nothing else.
    let (status, kind, text) = feed(&f.app, &path).await;
    assert_eq!(status, StatusCode::OK);
    assert!(kind.starts_with("text/calendar"));
    assert_eq!(text.matches("BEGIN:VEVENT").count(), 2, "{text}");
    assert_eq!(text.matches("SUMMARY:Busy: appointment").count(), 1);
    assert_eq!(text.matches("SUMMARY:Busy: blocked time").count(), 1);
    for private in ["Zzpatient", "Synthetic", "SYN-1", "private label"] {
        assert!(!text.contains(private), "the feed must not carry {private}");
    }
    assert!(text.starts_with("BEGIN:VCALENDAR\r\n") && text.ends_with("END:VCALENDAR\r\n"));
    let (_, value) = call(&f.app, &cookie, "GET", link, Value::Null, None).await;
    assert_eq!(value["active"], json!(true));
    assert!(value["last_read_at"].is_string(), "a read is remembered");

    // Each person has their own link and sees only their own time.
    let (_, theirs) = call(&f.app, &other_cookie, "POST", link, Value::Null, None).await;
    let (_, _, text) = feed(&f.app, theirs["path"].as_str().unwrap()).await;
    assert_eq!(text.matches("BEGIN:VEVENT").count(), 1);

    // A new link replaces the old one; turning it off stops it; a guess finds nothing.
    let (_, again) = call(&f.app, &cookie, "POST", link, Value::Null, None).await;
    assert_ne!(again["path"], made["path"]);
    assert_eq!(feed(&f.app, &path).await.0, StatusCode::NOT_FOUND);
    let fresh = again["path"].as_str().unwrap().to_string();
    assert_eq!(feed(&f.app, &fresh).await.0, StatusCode::OK);
    let (status, value) = call(&f.app, &cookie, "DELETE", link, Value::Null, None).await;
    assert_eq!((status, &value["active"]), (StatusCode::OK, &json!(false)));
    assert_eq!(feed(&f.app, &fresh).await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        feed(&f.app, "/calendar/not-a-link.ics").await.0,
        StatusCode::NOT_FOUND
    );

    // The owner sees who has a link on, never the link, and can turn one off.
    let admin = "/api/v1/practice/calendar-links";
    let (_, mine) = call(&f.app, &cookie, "POST", link, Value::Null, None).await;
    let mine = mine["path"].as_str().unwrap().to_string();
    assert_eq!(
        call(&f.app, &cookie, "GET", admin, Value::Null, None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, list) = call(&f.app, &f.cookie, "GET", admin, Value::Null, None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["enabled"], json!(true));
    assert_eq!(list["items"].as_array().unwrap().len(), 2);
    assert!(!list.to_string().contains(".ics") && !list.to_string().contains("token"));
    let (status, _) = call(
        &f.app,
        &f.cookie,
        "DELETE",
        &format!("{admin}/{clinician}"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(feed(&f.app, &mine).await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "DELETE",
            &format!("{admin}/{clinician}"),
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &f.app,
            &cookie,
            "DELETE",
            &format!("{admin}/{other}"),
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    // The practice switch: off stops every link and refuses new ones; on brings them back.
    let theirs = theirs["path"].as_str().unwrap().to_string();
    assert_eq!(feed(&f.app, &theirs).await.0, StatusCode::OK);
    assert_eq!(
        call(
            &f.app,
            &cookie,
            "PUT",
            admin,
            json!({"enabled":false}),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, value) = call(
        &f.app,
        &f.cookie,
        "PUT",
        admin,
        json!({"enabled":false}),
        None,
    )
    .await;
    assert_eq!((status, &value["enabled"]), (StatusCode::OK, &json!(false)));
    assert_eq!(feed(&f.app, &theirs).await.0, StatusCode::NOT_FOUND);
    let (status, refused) = call(&f.app, &cookie, "POST", link, Value::Null, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    let (_, value) = call(&f.app, &cookie, "GET", link, Value::Null, None).await;
    assert_eq!(value["allowed"], json!(false));
    call(
        &f.app,
        &f.cookie,
        "PUT",
        admin,
        json!({"enabled":true}),
        None,
    )
    .await;
    assert_eq!(feed(&f.app, &theirs).await.0, StatusCode::OK);

    // A person who can no longer sign in has no calendar either.
    let (_, live) = call(&f.app, &other_cookie, "POST", link, Value::Null, None).await;
    sqlx::query("UPDATE browser_users SET disabled=true WHERE id=$1")
        .bind(other)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        feed(&f.app, live["path"].as_str().unwrap()).await.0,
        StatusCode::NOT_FOUND
    );
    cleanup(f).await;
}
