// SPDX-License-Identifier: AGPL-3.0-only
//! Repeating block time: every date becomes an ordinary block of one series; a taken date is
//! reported before anything is written, or skipped on request; one block, the rest of the series
//! or the whole series can be removed. Synthetic data only.
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
    let schema = format!("block_series_{}", Uuid::new_v4().simple());
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
        secret: "synthetic-block-series-test-secret".into(),
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

fn at(day: i64, hour: i64) -> String {
    let base = chrono::Utc::now().date_naive() + chrono::Duration::days(30 + day);
    format!("{base}T{hour:02}:00:00Z")
}
fn spans(days: &[i64]) -> Value {
    Value::Array(
        days.iter()
            .map(|d| json!({"starts_at":at(*d,17),"ends_at":at(*d,18)}))
            .collect(),
    )
}
async fn blocks(f: &Fixture, who: Uuid) -> Vec<Value> {
    let (status, value) = call(
        &f.app,
        &f.cookie,
        "GET",
        &format!(
            "/api/v1/schedule?start={}&end={}&clinician_id={who}",
            at(-1, 0),
            at(20, 0)
        ),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value["blocks"].as_array().unwrap().clone()
}
#[tokio::test]
async fn a_repeating_block_makes_ordinary_blocks_and_reports_taken_dates() {
    let f = setup().await;
    let (clinician, _) = user(&f, "clinician").await;
    let (_, front) = user(&f, "front_desk").await;
    let (_, viewer) = user(&f, "read_only").await;
    let url = "/api/v1/schedule/block-series";
    let body = |days: &[i64], skip: bool| json!({"request_id":Uuid::new_v4(),"clinician_id":clinician,"label":"Synthetic lunch","repeat":"Every day until a synthetic date","occurrences":spans(days),"skip_conflicts":skip});

    // Who may: scheduling staff. A single date is not a repeat; dates must be in order.
    assert_eq!(
        call(&f.app, &viewer, "POST", url, body(&[0, 1], false), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&f.app, &front, "POST", url, body(&[0], false), None)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(&f.app, &front, "POST", url, body(&[1, 0], false), None)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );

    // Three dates become three ordinary blocks of one series; the same request again adds nothing.
    let first = body(&[0, 1, 2], false);
    let (status, made) = call(&f.app, &front, "POST", url, first.clone(), None).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    assert_eq!(
        (&made["created"], &made["blocks"]),
        (&json!(true), &json!(3))
    );
    let series = made["series_id"].as_str().unwrap().to_string();
    let (_, again) = call(&f.app, &front, "POST", url, first, None).await;
    assert_eq!(again["series_id"], made["series_id"]);
    let list = blocks(&f, clinician).await;
    assert_eq!(list.len(), 3);
    assert!(list
        .iter()
        .all(|b| b["series_id"] == json!(series) && b["label"] == json!("Synthetic lunch")));

    // A date that is taken: nothing is written and the taken dates come back.
    let (status, clash) = call(&f.app, &front, "POST", url, body(&[2, 3, 4], false), None).await;
    assert_eq!(status, StatusCode::OK, "{clash}");
    assert_eq!(clash["created"], json!(false));
    assert_eq!(clash["conflicts"].as_array().unwrap().len(), 1);
    assert_eq!(blocks(&f, clinician).await.len(), 3);
    // Asked to skip it, the free dates are blocked and the taken one is reported.
    let (_, partial) = call(&f.app, &front, "POST", url, body(&[2, 3, 4], true), None).await;
    assert_eq!(
        (&partial["created"], &partial["blocks"]),
        (&json!(true), &json!(2))
    );
    assert_eq!(partial["skipped"].as_array().unwrap().len(), 1);
    assert_eq!(blocks(&f, clinician).await.len(), 5);
    // When every date is taken there is nothing to make.
    assert_eq!(
        call(&f.app, &front, "POST", url, body(&[0, 1], true), None)
            .await
            .0,
        StatusCode::CONFLICT
    );

    // One block of the series is removed alone, as any block is.
    let one = list[0].clone();
    let (status, _) = call(
        &f.app,
        &front,
        "POST",
        &format!(
            "/api/v1/schedule/blocks/{}/cancel",
            one["id"].as_str().unwrap()
        ),
        json!({"reason":"Synthetic one-off"}),
        one["version"].as_i64(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        blocks(&f, clinician)
            .await
            .iter()
            .filter(|b| b["series_id"] == json!(series))
            .count(),
        2
    );
    // This and following: only blocks from that time on go.
    let cancel = format!("{url}/{series}/cancel");
    assert_eq!(
        call(
            &f.app,
            &viewer,
            "POST",
            &cancel,
            json!({"reason":"x","from":null}),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, gone) = call(
        &f.app,
        &front,
        "POST",
        &cancel,
        json!({"reason":"Synthetic change of plan","from":at(2,0)}),
        None,
    )
    .await;
    assert_eq!(
        (status, &gone["cancelled"]),
        (StatusCode::OK, &json!(1)),
        "{gone}"
    );
    // The whole series: whatever is left.
    let (_, gone) = call(
        &f.app,
        &front,
        "POST",
        &cancel,
        json!({"reason":"Synthetic change of plan","from":null}),
        None,
    )
    .await;
    assert_eq!(gone["cancelled"], json!(1));
    assert_eq!(
        call(
            &f.app,
            &front,
            "POST",
            &cancel,
            json!({"reason":"again","from":null}),
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let left = blocks(&f, clinician).await;
    assert_eq!(left.len(), 2, "the other series is untouched");
    let reasons: i64 =
        sqlx::query_scalar("SELECT count(*) FROM schedule_block_cancellations WHERE tenant_id=$1")
            .bind(f.tenant)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(reasons, 3, "every removed block keeps its reason");
    cleanup(f).await;
}
