// SPDX-License-Identifier: AGPL-3.0-only
//! A stray space saved on an insurance member ID or a payer name must never
//! freeze into a claim snapshot. Coverage and payer save handlers trim outer
//! whitespace before validating and storing, so the record the API returns — and
//! later snapshots into a claim — carries the trimmed value.
use axum::{
    body::Body,
    http::{Request, StatusCode},
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

const SECRET: &str = "synthetic-claim-send-whitespace-secret";

fn app(db: PgPool) -> axum::Router {
    suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db, "http://127.0.0.1:8099".into()).unwrap()),
    })
}

async fn setup() -> (PgPool, Actor, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    std::env::set_var("ENGINE_NPI_REGISTRY_URL", "");
    let schema = format!("claim_ws_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
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
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login',$4,false)")
        .bind(a.sub)
        .bind(a.tenant_id)
        .bind(format!("{}@example.test", a.sub))
        .bind("owner")
        .execute(&db)
        .await
        .unwrap();
    let p = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-WS','Avery','Synthetic','1990-01-01')")
        .bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    (db, a, p)
}

async fn ok(r: &axum::Router, a: &Actor, path: &str, body: Value) -> Value {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        a,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let response = r
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"message": String::from_utf8_lossy(&bytes)}));
    assert_eq!(status, StatusCode::OK, "{path}: {value}");
    value
}

fn id(v: &Value) -> Uuid {
    Uuid::parse_str(
        v["id"]
            .as_str()
            .unwrap_or_else(|| panic!("missing id: {v}")),
    )
    .unwrap()
}

#[tokio::test]
async fn saving_coverage_and_payer_trims_outer_whitespace() {
    let (_db, a, p) = setup().await;
    let r = app(_db.clone());

    // A payer saved with a padded name and payer_code stores the trimmed values.
    let payer = ok(
        &r,
        &a,
        "/api/v1/billing/payers",
        json!({"request_id":Uuid::new_v4(),"content":{"name":"  Synthetic Payer  ","payer_code":" SYN-PAYER\t","address":"Synthetic address","phone":"","active":true},"reason":"Synthetic payer"}),
    )
    .await;
    assert_eq!(payer["content"]["name"], "Synthetic Payer");
    assert_eq!(payer["content"]["payer_code"], "SYN-PAYER");

    // A coverage saved with a padded member ID stores and returns the trimmed ID.
    let coverage = ok(
        &r,
        &a,
        &format!("/api/v1/patients/{p}/coverages"),
        json!({"request_id":Uuid::new_v4(),"content":{"payer_id":id(&payer),"priority":"primary","status":"active","member_id":" ABC123 ","group_number":"  SYN-GROUP ","plan_name":"Synthetic plan\t","subscriber_name":"  Avery Synthetic ","subscriber_birth_date":"1990-01-01","relationship":"self","effective_date":"2026-01-01","end_date":null,"copay_cents":null,"verification":"manually_verified","notes":"Synthetic"},"reason":"Synthetic coverage"}),
    )
    .await;
    assert_eq!(coverage["content"]["member_id"], "ABC123");
    assert_eq!(coverage["content"]["group_number"], "SYN-GROUP");
    assert_eq!(coverage["content"]["plan_name"], "Synthetic plan");
    assert_eq!(coverage["content"]["subscriber_name"], "Avery Synthetic");

    // The stored row itself carries no outer whitespace.
    let stored: String = sqlx::query_scalar(
        "SELECT content->>'member_id' FROM insurance_coverages WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id(&coverage))
    .fetch_one(&_db)
    .await
    .unwrap();
    assert_eq!(stored, "ABC123");
}
