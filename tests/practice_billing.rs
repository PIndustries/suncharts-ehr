// SPDX-License-Identifier: AGPL-3.0-only
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
    let schema = format!("practice_billing_{}", Uuid::new_v4().simple());
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
        secret: "synthetic-practice-admin-test-secret".into(),
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
#[tokio::test]
async fn review_queue_filters_remittances_before_paging_and_scopes_the_clinic() {
    let f = setup().await;
    for tenant in [f.tenant, Uuid::new_v4()] {
        let payer = Uuid::new_v4();
        sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,'{}',$2,'fixture')")
            .bind(tenant).bind(payer).execute(&f.db).await.unwrap();
        sqlx::query("INSERT INTO era_remittances(tenant_id,id,payer_id,trace,document,document_hash,status,request_id,creation_hash) SELECT $1,md5(i::text)::uuid,$2,i::text,'{\"claims\":[]}','fixture',CASE WHEN i<=100 THEN 'posted' WHEN i=201 THEN 'reconciled' ELSE 'staged' END,md5(i::text)::uuid,'fixture' FROM generate_series(1,201) i")
            .bind(tenant).bind(payer).execute(&f.db).await.unwrap();
    }
    let path = "/api/v1/billing/remittances?needs_review=true";
    let (status, first) = call(&f.app, &f.cookie, "GET", path, Value::Null, None).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["items"].as_array().unwrap().len(), 100);
    let cursor = first["next_cursor"].as_str().unwrap();
    let (status, last) = call(
        &f.app,
        &f.cookie,
        "GET",
        &format!("{path}&after={cursor}"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{last}");
    assert_eq!(last["items"].as_array().unwrap().len(), 1);
    assert!(last["next_cursor"].is_null());
    let rows: Vec<_> = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(last["items"].as_array().unwrap())
        .collect();
    assert_eq!(rows.iter().filter(|r| r["status"] == "staged").count(), 100);
    assert_eq!(
        rows.iter().filter(|r| r["status"] == "reconciled").count(),
        1
    );
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        101
    );
    cleanup(f).await;
}
#[tokio::test]
async fn billing_identity_is_encrypted_versioned_scoped_and_resolved_before_eligibility() {
    let f = setup().await;
    let key_dir = std::env::temp_dir().join(format!("billing-identity-{}", Uuid::new_v4()));
    std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", key_dir.join("key"));
    let id = Uuid::new_v4();
    let tax = "000000017";
    let body = json!({"request_id":id,"name":"Synthetic Billing Organization","tax_id":tax,"tax_id_type":"E","active":true,"reason":"Synthetic reviewed tax identity"});
    let path = "/api/v1/practice/billing-organizations";
    let (status, created) = call(&f.app, &f.cookie, "POST", path, body.clone(), None).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["tax_id_last4"], "0017");
    assert_eq!(
        created["npi"], "",
        "an omitted NPI key keeps the organization blank"
    );
    assert!(!created.to_string().contains(tax));
    let encrypted: Vec<u8> = sqlx::query_scalar(
        "SELECT encrypted_tax_id FROM practice_billing_organizations WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.tenant)
    .bind(id)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert!(!encrypted.windows(tax.len()).any(|v| v == tax.as_bytes()));
    assert_eq!(
        call(&f.app, &f.cookie, "POST", path, body.clone(), None)
            .await
            .1,
        created,
        "same request replays without duplicating identity"
    );
    let mut changed = body.clone();
    changed["tax_id"] = json!("000000018");
    assert_eq!(
        call(&f.app, &f.cookie, "POST", path, changed, None).await.0,
        StatusCode::CONFLICT
    );
    let key_path = key_dir.join("key");
    let held_key = key_dir.join("held-key");
    std::fs::rename(&key_path, &held_key).unwrap();
    let mut replacement = body.clone();
    replacement["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        call(&f.app, &f.cookie, "POST", path, replacement, None)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert!(
        !key_path.exists(),
        "saved billing identity must prevent silent master-key replacement"
    );
    std::fs::rename(&held_key, &key_path).unwrap();
    let history_path = format!("{path}/{id}/history");
    let (_, history) = call(&f.app, &f.cookie, "GET", &history_path, Value::Null, None).await;
    assert_eq!(history["items"].as_array().unwrap().len(), 1);
    assert!(!history.to_string().contains(tax));
    assert!(
        sqlx::query("DELETE FROM practice_billing_organization_history WHERE tenant_id=$1")
            .bind(f.tenant)
            .execute(&f.db)
            .await
            .is_err()
    );
    let user = Uuid::new_v4();
    let cookie = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'front@example.test','synthetic','front_desk')").bind(f.tenant).bind(user).execute(&f.db).await.unwrap();
    session(&f.db, f.tenant, user, &cookie).await;
    assert_eq!(
        call(&f.app, &cookie, "POST", path, body.clone(), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let provider = json!({"staff_id":f.owner,"display_name":"Synthetic Provider","npi":"1234567893","specialty":"Synthetic","active":true,"reason":"Synthetic directory review"});
    let (status, profile) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/providers",
        provider,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{profile}");
    let (_, defaults) = call(
        &f.app,
        &cookie,
        "GET",
        "/api/v1/billing/claimmd/provider-defaults",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(defaults["providers"][0]["id"], json!(f.owner));
    assert_eq!(defaults["providers"][0]["version"], 1);
    assert_eq!(defaults["billing_organizations"][0]["id"], json!(id));
    assert!(!defaults.to_string().contains(tax));
    let p = Uuid::new_v4();
    let coverage = Uuid::new_v4();
    let ep = format!("/api/v1/patients/{p}/coverages/{coverage}/claimmd-eligibility");
    let request = json!({"request_id":Uuid::new_v4(),"service_date":"2026-11-11","service_codes":["30"],"insured_given_name":"Synthetic","insured_family_name":"Patient","provider_id":f.owner,"provider_version":2,"billing_organization_id":id,"billing_organization_version":1});
    let (status, error) = call(&f.app, &cookie, "POST", &ep, request.clone(), None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert!(error["message"]
        .as_str()
        .unwrap()
        .contains("provider changed"));
    let mut request = request;
    request["provider_version"] = json!(1);
    request["billing_organization_version"] = json!(2);
    let (status, error) = call(&f.app, &cookie, "POST", &ep, request.clone(), None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert!(error["message"]
        .as_str()
        .unwrap()
        .contains("organization changed"));
    request["billing_organization_id"] = json!(Uuid::new_v4());
    request["billing_organization_version"] = json!(1);
    assert_eq!(
        call(&f.app, &cookie, "POST", &ep, request, None).await.0,
        StatusCode::BAD_REQUEST
    );
    let edit = json!({"name":"Synthetic Revised Organization","tax_id_type":"E","active":false,"reason":"Synthetic disable preserves prior requests"});
    let edit_path = format!("{path}/{id}");
    assert_eq!(
        call(&f.app, &f.cookie, "PUT", &edit_path, edit.clone(), None)
            .await
            .0,
        StatusCode::PRECONDITION_REQUIRED
    );
    let (status, updated) = call(&f.app, &f.cookie, "PUT", &edit_path, edit.clone(), Some(1)).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["version"], 2);
    assert_eq!(updated["tax_id_last4"], "0017");
    assert_eq!(
        updated["npi"], "",
        "an omitted NPI key on update keeps the blank"
    );
    assert_eq!(
        call(&f.app, &f.cookie, "PUT", &edit_path, edit, Some(1))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (_, defaults) = call(
        &f.app,
        &cookie,
        "GET",
        "/api/v1/billing/claimmd/provider-defaults",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(defaults["billing_organizations"], json!([]));
    let other = Uuid::new_v4();
    let other_owner = Uuid::new_v4();
    let other_cookie = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'other@example.test','synthetic','owner')").bind(other).bind(other_owner).execute(&f.db).await.unwrap();
    session(&f.db, other, other_owner, &other_cookie).await;
    assert_eq!(
        call(
            &f.app,
            &other_cookie,
            "GET",
            &history_path,
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&f.app, &other_cookie, "GET", path, Value::Null, None)
            .await
            .1["items"],
        json!([])
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM claimmd_eligibility_checks")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "stale or foreign identities never create an external request"
    );
    cleanup(f).await;
    std::env::remove_var("ENGINE_CREDENTIAL_KEY_FILE");
    std::fs::remove_dir_all(key_dir).unwrap();
}

#[tokio::test]
async fn organization_npi_is_saved_returned_and_shown_in_history_and_choices() {
    let _key_file = suncharts_engine::test_db::credential_key_lock()
        .lock()
        .await;
    let f = setup().await;
    let key_dir = std::env::temp_dir().join(format!("billing-npi-{}", Uuid::new_v4()));
    std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", key_dir.join("key"));
    let path = "/api/v1/practice/billing-organizations";
    let org_npi = "1234567893";
    let id = Uuid::new_v4();
    let body = json!({"request_id":id,"name":"Synthetic Group Practice","npi":org_npi,"tax_id":"000000017","tax_id_type":"E","active":true,"reason":"Synthetic reviewed group NPI"});
    let (status, created) = call(&f.app, &f.cookie, "POST", path, body.clone(), None).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["npi"], org_npi, "the saved NPI is returned");
    let stored: String = sqlx::query_scalar(
        "SELECT npi FROM practice_billing_organizations WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.tenant)
    .bind(id)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(stored, org_npi);
    let (_, listed) = call(&f.app, &f.cookie, "GET", path, Value::Null, None).await;
    assert_eq!(listed["items"][0]["npi"], org_npi);
    let (_, history) = call(
        &f.app,
        &f.cookie,
        "GET",
        &format!("{path}/{id}/history"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(
        history["items"][0]["content"]["npi"], org_npi,
        "history content carries the NPI the way name and tax ID type do"
    );
    // choices() feeds other modules; it must expose the NPI too.
    let (_, defaults) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/billing/claimmd/provider-defaults",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(defaults["billing_organizations"][0]["npi"], org_npi);
    // A checksum-invalid or malformed NPI is rejected with the owner-facing text.
    for bad in ["1234567890", "1234", "123456789x", "0234567893"] {
        let mut rejected = body.clone();
        rejected["request_id"] = json!(Uuid::new_v4());
        rejected["npi"] = json!(bad);
        let (status, out) = call(&f.app, &f.cookie, "POST", path, rejected, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {out}");
        assert_eq!(
            out["message"],
            "Enter a valid 10-digit NPI or leave it blank."
        );
    }
    // Surrounding space is trimmed before the check and the save.
    let spaced = json!({"request_id":Uuid::new_v4(),"name":"Synthetic Spaced NPI","npi":"  1234567893  ","tax_id":"000000017","tax_id_type":"E","active":true,"reason":"Synthetic trimmed NPI"});
    let (status, spaced) = call(&f.app, &f.cookie, "POST", path, spaced, None).await;
    assert_eq!(status, StatusCode::OK, "{spaced}");
    assert_eq!(spaced["npi"], org_npi);
    // An update sets, then clears, the organization NPI.
    let edit_path = format!("{path}/{id}");
    let edit = json!({"name":"Synthetic Billing Organization","npi":"","tax_id_type":"E","active":true,"reason":"Synthetic NPI cleared"});
    let (status, cleared) = call(&f.app, &f.cookie, "PUT", &edit_path, edit.clone(), Some(1)).await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(
        cleared["npi"], "",
        "an update may clear the organization NPI"
    );
    let (_, history) = call(
        &f.app,
        &f.cookie,
        "GET",
        &format!("{path}/{id}/history"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(history["items"][0]["content"]["npi"], "");
    assert_eq!(history["items"][1]["content"]["npi"], org_npi);
    cleanup(f).await;
    std::env::remove_var("ENGINE_CREDENTIAL_KEY_FILE");
    std::fs::remove_dir_all(key_dir).unwrap();
}
