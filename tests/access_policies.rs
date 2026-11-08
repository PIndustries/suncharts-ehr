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
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
async fn user(db: &PgPool, tenant: Uuid, role: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,display_name,role) VALUES($1,$2,$3,'synthetic-no-login-hash','Synthetic staff',$4)").bind(tenant).bind(id).bind(format!("{id}@example.test")).bind(role).execute(db).await.unwrap();
    id
}
async fn session(db: &PgPool, tenant: Uuid, user: Uuid) -> String {
    let token = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at,auth_method) VALUES($1,$2,$3,now()+interval '1 hour','break_glass')").bind(hash(&token)).bind(tenant).bind(user).execute(db).await.unwrap();
    token
}
async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("access_policies_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
    let search = schema.clone();
    let db = PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |connection, _| {
            let query = format!("SET search_path TO {search}");
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
    let owner = user(&db, tenant, "owner").await;
    let cookie = session(&db, tenant, owner).await;
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: "synthetic-policy-test-secret".into(),
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
async fn cleanup(f: Fixture) {
    f.db.close().await;
    let db = PgPool::connect(&f.url).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", f.schema))
        .execute(&db)
        .await
        .unwrap();
    db.close().await;
}
async fn call(
    app: &Router,
    credential: &str,
    bearer: bool,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("Origin", ORIGIN)
        .header("Content-Type", "application/json");
    builder = if bearer {
        builder.header("Authorization", format!("Bearer {credential}"))
    } else {
        builder.header("Cookie", format!("sce_session={credential}"))
    };
    if let Some(version) = version {
        builder = builder.header("If-Match", format!("\"{version}\""));
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn oauth(db: &PgPool, tenant: Uuid, user: Uuid) -> (String, Uuid) {
    let client = Uuid::new_v4();
    let grant = Uuid::new_v4();
    let token = format!("sce_at_{}", Uuid::new_v4().simple());
    sqlx::query("INSERT INTO oauth_clients(id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES($1,$2,'Synthetic client','synthetic','https://example.test/callback','clinical.read clinical.write scheduling.read billing.read events.read')").bind(client).bind(tenant).execute(db).await.unwrap();
    sqlx::query("INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,'clinical.read clinical.write scheduling.read billing.read events.read')").bind(grant).bind(client).bind(tenant).bind(user).execute(db).await.unwrap();
    sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '1 hour')").bind(hash(&token)).bind(grant).execute(db).await.unwrap();
    (token, grant)
}
fn change(name: &str, base_role: &str, permissions: Value) -> Value {
    json!({"name":name,"base_role":base_role,"permissions":permissions,"reason":"Synthetic policy review"})
}
async fn assign(f: &Fixture, user: Uuid, policy: Value, version: i64) -> (StatusCode, Value) {
    call(
        &f.app,
        &f.cookie,
        false,
        "PUT",
        &format!("/api/v1/practice/staff/{user}/access-policy"),
        json!({"policy_id":policy,"reason":"Synthetic assignment review"}),
        Some(version),
    )
    .await
}

#[tokio::test]
async fn custom_policies_are_tenant_scoped_and_intersect_native_roles_for_browser_and_oauth() {
    let f = setup().await;
    let (status, catalog) = call(
        &f.app,
        &f.cookie,
        false,
        "GET",
        "/api/v1/practice/access-policies",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{catalog}");
    assert!(catalog["workspace_defaults"]["module_order"].is_array());
    let mut flags = catalog["defaults"].clone();
    flags["clinical"]["create"] = json!(false);
    let (status, policy) = call(
        &f.app,
        &f.cookie,
        false,
        "POST",
        "/api/v1/practice/access-policies",
        change("Scoped front desk", "front_desk", flags.clone()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{policy}");
    let id = policy["id"].as_str().unwrap();
    let staff = user(&f.db, f.tenant, "front_desk").await;
    let old_session = session(&f.db, f.tenant, staff).await;
    assert_eq!(
        assign(&f, staff, policy["id"].clone(), 0).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &f.app,
            &old_session,
            false,
            "GET",
            "/api/v1/patients",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED,
        "assignment invalidates old browser sessions"
    );
    let active = session(&f.db, f.tenant, staff).await;
    assert_eq!(
        call(
            &f.app,
            &active,
            false,
            "GET",
            "/api/v1/patients",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &f.app,
            &active,
            false,
            "POST",
            "/api/v1/patients",
            json!({}),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &f.app,
            &active,
            false,
            "GET",
            "/api/v1/unmapped-native-resource",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &f.app,
            &active,
            false,
            "GET",
            "/api/v1/practice/access-policies",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN,
        "custom permissions do not confer owner administration"
    );
    let (status, current) = call(
        &f.app,
        &active,
        false,
        "GET",
        "/api/v1/practice/access-policy/current",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(current["restricted"], true);
    assert_eq!(current["permissions"]["clinical"]["create"], false);
    assert_eq!(current["module_permissions"]["clinical"]["view"], true);
    let (token, grant) = oauth(&f.db, f.tenant, staff).await;
    assert_eq!(
        call(
            &f.app,
            &token,
            true,
            "GET",
            "/api/v1/patients",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &f.app,
            &token,
            true,
            "POST",
            "/api/v1/patients",
            json!({}),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN,
        "OAuth scopes cannot bypass custom restrictions"
    );
    let nurse = user(&f.db, f.tenant, "nurse").await;
    assert_eq!(
        assign(&f, nurse, policy["id"].clone(), 0).await.0,
        StatusCode::BAD_REQUEST
    );
    let (_, nurse_policy) = call(
        &f.app,
        &f.cookie,
        false,
        "POST",
        "/api/v1/practice/access-policies",
        change("Native nurse ceiling", "nurse", catalog["defaults"].clone()),
        None,
    )
    .await;
    assert_eq!(
        assign(&f, nurse, nurse_policy["id"].clone(), 0).await.0,
        StatusCode::OK
    );
    let nurse_session = session(&f.db, f.tenant, nurse).await;
    assert_eq!(
        call(
            &f.app,
            &nurse_session,
            false,
            "POST",
            "/api/v1/patients",
            json!({"given_name":"Synthetic","family_name":"Patient","birth_date":"1990-01-01"}),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN,
        "an all-true custom policy cannot grant nurse registration authority"
    );
    assert_eq!(
        assign(&f, f.owner, policy["id"].clone(), 0).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            false,
            "POST",
            "/api/v1/practice/access-policies",
            change("No owner policy", "owner", flags.clone()),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let tenant_b = Uuid::new_v4();
    let owner_b = user(&f.db, tenant_b, "owner").await;
    let cookie_b = session(&f.db, tenant_b, owner_b).await;
    let (_, other) = call(
        &f.app,
        &cookie_b,
        false,
        "POST",
        "/api/v1/practice/access-policies",
        change("Other tenant", "front_desk", catalog["defaults"].clone()),
        None,
    )
    .await;
    assert_eq!(
        assign(&f, staff, other["id"].clone(), 1).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &f.app,
            &cookie_b,
            false,
            "PUT",
            &format!("/api/v1/practice/access-policies/{id}"),
            change("Cross tenant", "front_desk", flags.clone()),
            Some(1)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (_, other_catalog) = call(
        &f.app,
        &cookie_b,
        false,
        "GET",
        "/api/v1/practice/access-policies",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(other_catalog["items"].as_array().unwrap().len(), 1);
    assert!(!other_catalog.to_string().contains(id));
    flags["clinical"] = json!({"view":false,"create":false,"edit":false,"delete":false});
    flags["integrations"] = json!({"view":false,"create":false,"edit":false,"delete":false});
    flags["practice"] = json!({"view":false,"create":false,"edit":false,"delete":false});
    let (status, updated) = call(
        &f.app,
        &f.cookie,
        false,
        "PUT",
        &format!("/api/v1/practice/access-policies/{id}"),
        change("Restricted front desk", "front_desk", flags.clone()),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["version"], 2);
    assert_eq!(
        call(
            &f.app,
            &token,
            true,
            "GET",
            "/api/v1/patients",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED,
        "policy changes revoke existing OAuth grants"
    );
    let revoked: bool =
        sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM oauth_grants WHERE id=$1")
            .bind(grant)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert!(revoked);
    let active = session(&f.db, f.tenant, staff).await;
    for path in [
        "/api/v1/patients",
        "/api/v1/sun/context",
        "/api/v1/practice/worklist",
        "/api/v1/connect/status",
        "/api/v1/browser/events",
    ] {
        assert_eq!(
            call(&f.app, &active, false, "GET", path, Value::Null, None)
                .await
                .0,
            StatusCode::FORBIDDEN,
            "{path}"
        );
    }
    for path in [
        "/api/v1/practice/access-policy/current",
        "/api/v1/practice/workspace-settings",
    ] {
        assert_eq!(
            call(&f.app, &active, false, "GET", path, Value::Null, None)
                .await
                .0,
            StatusCode::OK,
            "bootstrap {path}"
        );
    }
    let (new_token, _) = oauth(&f.db, f.tenant, staff).await;
    assert_eq!(
        call(
            &f.app,
            &new_token,
            true,
            "GET",
            "/api/v1/patients",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN,
        "new OAuth sessions load current custom policy"
    );
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            false,
            "PUT",
            &format!("/api/v1/practice/access-policies/{id}"),
            change("Stale", "front_desk", flags),
            Some(1)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            false,
            "GET",
            "/api/v1/patients",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::OK,
        "owner cannot be locked out"
    );
    cleanup(f).await;
}

#[tokio::test]
async fn policy_changes_terminate_streams_and_audit_failure_rolls_back_permissions_and_revocation()
{
    let f = setup().await;
    let (_, catalog) = call(
        &f.app,
        &f.cookie,
        false,
        "GET",
        "/api/v1/practice/access-policies",
        Value::Null,
        None,
    )
    .await;
    let (_, policy) = call(
        &f.app,
        &f.cookie,
        false,
        "POST",
        "/api/v1/practice/access-policies",
        change("Live staff", "front_desk", catalog["defaults"].clone()),
        None,
    )
    .await;
    let id = policy["id"].as_str().unwrap();
    let staff = user(&f.db, f.tenant, "front_desk").await;
    assert_eq!(
        assign(&f, staff, policy["id"].clone(), 0).await.0,
        StatusCode::OK
    );
    let cookie = session(&f.db, f.tenant, staff).await;
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/browser/events")
                .header("Cookie", format!("sce_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.into_body();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(3), stream.frame())
            .await
            .unwrap()
            .is_some()
    );
    let connect_token = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO connect_identity_sessions(token_hash,tenant_id,user_id,grant_id,issuer,audience,expires_at) VALUES($1,$2,$3,$4,'https://connect.example.test',$5,now()+interval '1 hour')").bind(hash(&connect_token)).bind(f.tenant).bind(staff).bind(Uuid::new_v4()).bind(ORIGIN).execute(&f.db).await.unwrap();
    let mut flags = catalog["defaults"].clone();
    flags["billing"] = json!({"view":false,"create":false,"edit":false,"delete":false});
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            false,
            "PUT",
            &format!("/api/v1/practice/access-policies/{id}"),
            change("Limited live staff", "front_desk", flags.clone()),
            Some(1)
        )
        .await
        .0,
        StatusCode::OK
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), stream.collect())
        .await
        .expect("stream must terminate after policy session revocation")
        .unwrap();
    let revoked: bool = sqlx::query_scalar(
        "SELECT revoked_at IS NOT NULL FROM connect_identity_sessions WHERE token_hash=$1",
    )
    .bind(hash(&connect_token))
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert!(revoked);
    let cookie = session(&f.db, f.tenant, staff).await;
    sqlx::query("CREATE FUNCTION reject_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='practice.access_policy.changed' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&f.db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_policy_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_policy_audit()").execute(&f.db).await.unwrap();
    let (status, _) = call(
        &f.app,
        &f.cookie,
        false,
        "PUT",
        &format!("/api/v1/practice/access-policies/{id}"),
        change(
            "Should roll back",
            "front_desk",
            catalog["defaults"].clone(),
        ),
        Some(2),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let (version, name): (i64, String) = sqlx::query_as(
        "SELECT version,name FROM practice_access_policies WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.tenant)
    .bind(Uuid::parse_str(id).unwrap())
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(version, 2);
    assert_eq!(name, "Limited live staff");
    assert_eq!(
        call(
            &f.app,
            &cookie,
            false,
            "GET",
            "/api/v1/patients",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::OK,
        "failed audit must not revoke a valid session"
    );
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM practice_access_revisions WHERE tenant_id=$1 AND resource_id=$2 AND resource_kind='policy'").bind(f.tenant).bind(Uuid::parse_str(id).unwrap()).fetch_one(&f.db).await.unwrap();
    assert_eq!(count, 2);
    cleanup(f).await;
}
