// SPDX-License-Identifier: AGPL-3.0-only
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{migrate::Migrator, postgres::PgPoolOptions, PgPool};
use std::borrow::Cow;
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
    let schema = format!("practice_admin_{}", Uuid::new_v4().simple());
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
fn staff(email: &str, role: &str) -> Value {
    json!({"email":email,"password":"synthetic-staff-password-2026","display_name":"Synthetic Staff","role":role,"reason":"Synthetic account setup"})
}
fn staff_change(role: &str, disabled: bool) -> Value {
    json!({"display_name":"Updated Synthetic Staff","role":role,"disabled":disabled,"reason":"Synthetic access update"})
}
#[tokio::test]
async fn staff_credentials_are_hashed_and_last_owner_is_protected() {
    let f = setup().await;
    let (status, created) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/staff",
        staff(" nurse@example.test ", "nurse"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap();
    assert_eq!(created["email"], "nurse@example.test");
    assert!(created.get("password_hash").is_none());
    assert!(created.get("password").is_none());
    let hash: String =
        sqlx::query_scalar("SELECT password_hash FROM browser_users WHERE tenant_id=$1 AND id=$2")
            .bind(f.tenant)
            .bind(Uuid::parse_str(id).unwrap())
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert!(hash.starts_with("$argon2"));
    assert_ne!(hash, "synthetic-staff-password-2026");
    let path = format!("/api/v1/practice/staff/{}", f.owner);
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &path,
            staff_change("clinician", false),
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
            "PUT",
            &path,
            staff_change("owner", true),
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
            "PUT",
            &path,
            staff_change("owner", false),
            None
        )
        .await
        .0,
        StatusCode::PRECONDITION_REQUIRED
    );
    let (_, history) = call(
        &f.app,
        &f.cookie,
        "GET",
        &format!("/api/v1/practice/admin-history/staff/{id}"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(history["items"].as_array().unwrap().len(), 1);
    assert!(!history.to_string().contains("password"));
    assert!(sqlx::query(
        "UPDATE practice_admin_history SET reason='Changed' WHERE tenant_id=$1 AND resource_id=$2"
    )
    .bind(f.tenant)
    .bind(Uuid::parse_str(id).unwrap())
    .execute(&f.db)
    .await
    .is_err());
    assert!(sqlx::query(
        "DELETE FROM practice_admin_history WHERE tenant_id=$1 AND resource_id=$2"
    )
    .bind(f.tenant)
    .bind(Uuid::parse_str(id).unwrap())
    .execute(&f.db)
    .await
    .is_err());
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='practice.admin.write'",
    )
    .bind(f.tenant)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(audits, 1);
    cleanup(f).await;
}
#[tokio::test]
async fn access_changes_revoke_sessions_and_grants_and_versions_reject_stale_updates() {
    let f = setup().await;
    let (_, created) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/staff",
        staff("clinician@example.test", "clinician"),
        None,
    )
    .await;
    let id = Uuid::parse_str(created["id"].as_str().unwrap()).unwrap();
    let cookie = Uuid::new_v4().to_string();
    session(&f.db, f.tenant, id, &cookie).await;
    let client = Uuid::new_v4();
    let grant = Uuid::new_v4();
    sqlx::query("INSERT INTO oauth_clients(id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES($1,$2,'synthetic','none','https://example.test/callback','patients:read')").bind(client).bind(f.tenant).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,'patients:read')").bind(grant).bind(client).bind(f.tenant).bind(id).execute(&f.db).await.unwrap();
    let path = format!("/api/v1/practice/staff/{id}");
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &path,
            staff_change("read_only", false),
            Some(1)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&f.app, &cookie, "GET", "/auth/me", Value::Null, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let revoked: bool =
        sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM oauth_grants WHERE id=$1")
            .bind(grant)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert!(revoked);
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &path,
            staff_change("owner", false),
            Some(1)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, fresh) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/staff",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(
        fresh["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id.to_string())
            .unwrap()["role"],
        "read_only"
    );
    cleanup(f).await;
}
#[tokio::test]
async fn owner_browser_boundary_and_tenant_directory_isolation() {
    let f = setup().await;
    let (_, created) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/staff",
        staff("front@example.test", "front_desk"),
        None,
    )
    .await;
    let front = Uuid::parse_str(created["id"].as_str().unwrap()).unwrap();
    let cookie = Uuid::new_v4().to_string();
    session(&f.db, f.tenant, front, &cookie).await;
    assert_eq!(
        call(
            &f.app,
            &cookie,
            "GET",
            "/api/v1/practice/staff",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(call(&f.app,&cookie,"POST","/api/v1/practice/facilities",json!({"name":"Not permitted","address":"","phone":"","active":true,"reason":"Synthetic"}),None).await.0,StatusCode::FORBIDDEN);
    let tenant = Uuid::new_v4();
    let owner = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'other@example.test','synthetic','owner')").bind(tenant).bind(owner).execute(&f.db).await.unwrap();
    let other_cookie = Uuid::new_v4().to_string();
    session(&f.db, tenant, owner, &other_cookie).await;
    let (_,facility)=call(&f.app,&f.cookie,"POST","/api/v1/practice/facilities",json!({"name":"Synthetic Clinic","address":"10 Test St","phone":"5550100","active":true,"reason":"Synthetic setup"}),None).await;
    assert!(facility["id"].is_string());
    let (_, directory) = call(
        &f.app,
        &other_cookie,
        "GET",
        "/api/v1/practice/facilities",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(directory["items"], json!([]));
    assert_eq!(
        call(
            &f.app,
            &other_cookie,
            "PUT",
            &format!(
                "/api/v1/practice/facilities/{}",
                facility["id"].as_str().unwrap()
            ),
            json!({"name":"Cross tenant","address":"","phone":"","active":true,"reason":"Attempt"}),
            Some(1)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, choices) = call(
        &f.app,
        &cookie,
        "GET",
        "/api/v1/schedule/locations",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(choices["items"][0]["name"], "Synthetic Clinic");
    let (_, foreign) = call(
        &f.app,
        &other_cookie,
        "GET",
        "/api/v1/schedule/locations",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(foreign["items"], json!([]));
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/practice/staff")
                .header("Cookie", format!("sce_session={}", f.cookie))
                .header("Content-Type", "application/json")
                .body(Body::from(
                    staff("bad@example.test", "read_only").to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    cleanup(f).await;
}
#[tokio::test]
async fn directory_lifecycle_preserves_parent_constraints_and_provider_eligibility() {
    let f = setup().await;
    let facility_input = json!({"name":"Synthetic Clinic","address":"10 Test St","phone":"5550100","active":true,"reason":"Setup"});
    let (_, facility) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/facilities",
        facility_input.clone(),
        None,
    )
    .await;
    let fid = facility["id"].as_str().unwrap();
    let room_input = json!({"facility_id":fid,"name":"Exam 1","active":true,"reason":"Setup"});
    let (status, room) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/rooms",
        room_input.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{room}");
    let rid = room["id"].as_str().unwrap();
    let mut disable = facility_input.clone();
    disable["active"] = json!(false);
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &format!("/api/v1/practice/facilities/{fid}"),
            disable.clone(),
            Some(1)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut disable_room = room_input.clone();
    disable_room["active"] = json!(false);
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &format!("/api/v1/practice/rooms/{rid}"),
            disable_room,
            Some(1)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &format!("/api/v1/practice/facilities/{fid}"),
            disable,
            Some(1)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &format!("/api/v1/practice/rooms/{rid}"),
            room_input,
            Some(2)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_, choices) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/schedule/locations",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(choices["items"], json!([]));
    let profile = json!({"staff_id":f.owner,"display_name":"Synthetic Doctor","npi":"1234567893","specialty":"Synthetic practice","active":true,"reason":"Setup"});
    let (status, provider) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/providers",
        profile.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{provider}");
    let (_, clinician) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/staff",
        staff("second@example.test", "clinician"),
        None,
    )
    .await;
    let cid = clinician["id"].as_str().unwrap();
    let mut second = profile.clone();
    second["staff_id"] = clinician["id"].clone();
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "POST",
            "/api/v1/practice/providers",
            second,
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &format!("/api/v1/practice/staff/{cid}"),
            staff_change("medical_assistant", false),
            Some(1)
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, providers) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/providers",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(
        providers["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == cid)
            .unwrap()["active"],
        false
    );
    cleanup(f).await;
}

#[tokio::test]
async fn concurrent_owner_demotions_cannot_remove_the_last_owner() {
    let f = setup().await;
    let (_, second) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/staff",
        staff("second-owner@example.test", "owner"),
        None,
    )
    .await;
    let second_id = Uuid::parse_str(second["id"].as_str().unwrap()).unwrap();
    let second_cookie = Uuid::new_v4().to_string();
    session(&f.db, f.tenant, second_id, &second_cookie).await;
    let first_path = format!("/api/v1/practice/staff/{}", f.owner);
    let second_path = format!("/api/v1/practice/staff/{second_id}");
    let (first, last) = tokio::join!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &first_path,
            staff_change("clinician", false),
            Some(1)
        ),
        call(
            &f.app,
            &second_cookie,
            "PUT",
            &second_path,
            staff_change("clinician", false),
            Some(1)
        )
    );
    assert!(
        matches!(
            (first.0, last.0),
            (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
        ),
        "{first:?} {last:?}"
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM browser_users WHERE tenant_id=$1 AND role='owner' AND NOT disabled",
    )
    .bind(f.tenant)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(count, 1);
    cleanup(f).await;
}
#[tokio::test]
async fn password_reset_revokes_existing_session_without_leaking_passwords() {
    let f = setup().await;
    let (_, created) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/staff",
        staff("reset@example.test", "front_desk"),
        None,
    )
    .await;
    let id = Uuid::parse_str(created["id"].as_str().unwrap()).unwrap();
    let cookie = Uuid::new_v4().to_string();
    session(&f.db, f.tenant, id, &cookie).await;
    let mut update = staff_change("front_desk", false);
    update["password"] = json!("synthetic-reset-password-2026");
    let (status, saved) = call(
        &f.app,
        &f.cookie,
        "PUT",
        &format!("/api/v1/practice/staff/{id}"),
        update,
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!saved.to_string().contains("password"));
    assert_eq!(
        call(&f.app, &cookie, "GET", "/auth/me", Value::Null, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    use argon2::{Argon2, PasswordHash, PasswordVerifier};
    let hash: String =
        sqlx::query_scalar("SELECT password_hash FROM browser_users WHERE tenant_id=$1 AND id=$2")
            .bind(f.tenant)
            .bind(id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert!(Argon2::default()
        .verify_password(
            b"synthetic-reset-password-2026",
            &PasswordHash::new(&hash).unwrap()
        )
        .is_ok());
    let (_, history) = call(
        &f.app,
        &f.cookie,
        "GET",
        &format!("/api/v1/practice/admin-history/staff/{id}"),
        Value::Null,
        None,
    )
    .await;
    assert!(!history.to_string().contains("password"));
    assert_eq!(history["items"].as_array().unwrap().len(), 2);
    cleanup(f).await;
}

#[tokio::test]
async fn location_renames_and_moves_cannot_split_booked_room_identity() {
    let f = setup().await;
    let facility_input =
        json!({"name":"Original Clinic","address":"","phone":"","active":true,"reason":"Setup"});
    let (_, facility) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/facilities",
        facility_input.clone(),
        None,
    )
    .await;
    let fid = facility["id"].as_str().unwrap();
    let (_, other) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/facilities",
        json!({"name":"Other Clinic","address":"","phone":"","active":true,"reason":"Setup"}),
        None,
    )
    .await;
    let room_input =
        json!({"facility_id":fid,"name":"Original Room","active":true,"reason":"Setup"});
    let (_, room) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/rooms",
        room_input.clone(),
        None,
    )
    .await;
    let rid = room["id"].as_str().unwrap();
    let patient = Uuid::new_v4();
    let appt = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-LOC','Location','Synthetic','1990-01-01')").bind(f.tenant).bind(patient).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,facility,room) VALUES($1,$2,$3,$4,now()+interval '1 hour',now()+interval '2 hours','Original Clinic','Original Room')").bind(f.tenant).bind(appt).bind(patient).bind(f.owner).execute(&f.db).await.unwrap();
    let mut renamed = facility_input.clone();
    renamed["name"] = json!("Renamed Clinic");
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &format!("/api/v1/practice/facilities/{fid}"),
            renamed.clone(),
            Some(1)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut renamed_room = room_input.clone();
    renamed_room["name"] = json!("Renamed Room");
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &format!("/api/v1/practice/rooms/{rid}"),
            renamed_room.clone(),
            Some(1)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut moved = room_input.clone();
    moved["facility_id"] = other["id"].clone();
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &format!("/api/v1/practice/rooms/{rid}"),
            moved,
            Some(1)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE appointments SET status='cancelled' WHERE tenant_id=$1 AND id=$2")
        .bind(f.tenant)
        .bind(appt)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &format!("/api/v1/practice/facilities/{fid}"),
            renamed,
            Some(1)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &format!("/api/v1/practice/rooms/{rid}"),
            renamed_room,
            Some(1)
        )
        .await
        .0,
        StatusCode::OK
    );
    cleanup(f).await;
}
#[tokio::test]
async fn inactive_provider_profiles_are_not_schedulable_but_legacy_staff_remain_eligible() {
    let f = setup().await;
    let now = chrono::Utc::now().timestamp();
    let actor = suncharts_engine::auth::Actor {
        sub: f.owner,
        tenant_id: f.tenant,
        role: suncharts_engine::auth::Role::Owner,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    };
    assert!(
        suncharts_engine::scheduling::provider(&f.db, &actor, f.owner)
            .await
            .is_ok()
    );
    let mut profile = json!({"staff_id":f.owner,"display_name":"Synthetic Provider","npi":"","specialty":"","active":false,"reason":"Temporarily unavailable"});
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "POST",
            "/api/v1/practice/providers",
            profile.clone(),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(
        suncharts_engine::scheduling::provider(&f.db, &actor, f.owner)
            .await
            .is_err()
    );
    let (_, providers) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/schedule/providers",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(providers["items"], json!([]));
    profile["active"] = json!(true);
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &format!("/api/v1/practice/providers/{}", f.owner),
            profile,
            Some(1)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(
        suncharts_engine::scheduling::provider(&f.db, &actor, f.owner)
            .await
            .is_ok()
    );
    let (_, providers) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/schedule/providers",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(providers["items"][0]["label"], "Synthetic Provider");
    cleanup(f).await;
}

#[tokio::test]
async fn booking_rechecks_provider_after_waiting_for_the_schedule_lock() {
    use suncharts_engine::backend::ClinicalBackend;
    let f = setup().await;
    let now = chrono::Utc::now().timestamp();
    let actor = suncharts_engine::auth::Actor {
        sub: f.owner,
        tenant_id: f.tenant,
        role: suncharts_engine::auth::Role::Owner,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    };
    let profile = json!({"staff_id":f.owner,"display_name":"Synthetic Provider","npi":"","specialty":"","active":true,"reason":"Setup"});
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "POST",
            "/api/v1/practice/providers",
            profile,
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let patient = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-RACE','Race','Synthetic','1990-01-01')").bind(f.tenant).bind(patient).execute(&f.db).await.unwrap();
    let mut tx = f.db.begin().await.unwrap();
    suncharts_engine::scheduling::tenant_lock(&mut tx, &actor)
        .await
        .unwrap();
    let schema = f.schema.clone();
    let waiter = PgPoolOptions::new()
        .max_connections(1)
        .after_connect(move |c, _| {
            let query = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(&query).execute(c).await?;
                Ok(())
            })
        })
        .connect(&f.url)
        .await
        .unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&waiter)
        .await
        .unwrap();
    let pool = waiter.clone();
    let starts = chrono::Utc::now() + chrono::Duration::hours(1);
    let input:suncharts_engine::model::NewAppointment=serde_json::from_value(json!({"patient_id":patient,"clinician_id":f.owner,"starts_at":starts,"ends_at":starts+chrono::Duration::minutes(30)})).unwrap();
    let booking = tokio::spawn(async move { PostgresBackend(pool).book(&actor, input).await });
    tokio::time::timeout(std::time::Duration::from_secs(5),async{
  loop {
   let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted)").bind(pid).fetch_one(&f.db).await.unwrap();
   if waiting {break;}
   tokio::time::sleep(std::time::Duration::from_millis(10)).await;
  }
 }).await.expect("booking must reach the held scheduling lock");
    // Model the serialized admin deactivation immediately before the queued booking
    // acquires its lock. No production handler is bypassed by the application.
    sqlx::query(
        "UPDATE practice_providers SET active=false,version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.tenant)
    .bind(f.owner)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(booking.await.unwrap().is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM appointments WHERE tenant_id=$1")
        .bind(f.tenant)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    waiter.close().await;
    cleanup(f).await;
}
#[tokio::test]
async fn provider_taxonomy_is_saved_uppercase_and_returned() {
    let f = setup().await;
    let profile = json!({"staff_id":f.owner,"display_name":"Synthetic Doctor","npi":"","specialty":"","taxonomy":"  207r00000x ","active":true,"reason":"Setup"});
    let (status, created) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/providers",
        profile.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["taxonomy"], "207R00000X");
    let stored: String =
        sqlx::query_scalar("SELECT taxonomy FROM practice_providers WHERE tenant_id=$1 AND id=$2")
            .bind(f.tenant)
            .bind(f.owner)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(stored, "207R00000X");
    let (_, history) = call(
        &f.app,
        &f.cookie,
        "GET",
        &format!("/api/v1/practice/admin-history/provider/{}", f.owner),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(history["items"][0]["content"]["taxonomy"], "207R00000X");
    let mut listed = profile.clone();
    listed["taxonomy"] = json!("174F00000X");
    let (status, updated) = call(
        &f.app,
        &f.cookie,
        "PUT",
        &format!("/api/v1/practice/providers/{}", f.owner),
        listed,
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["taxonomy"], "174F00000X");
    let (_, directory) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/providers",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(
        directory["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == f.owner.to_string())
            .unwrap()["taxonomy"],
        "174F00000X"
    );
    cleanup(f).await;
}
#[tokio::test]
async fn an_invalid_provider_taxonomy_is_rejected() {
    let f = setup().await;
    for taxonomy in ["207R0000X", "207R00000XX", "207R00000-", "not-a-taxonomy"] {
        let profile = json!({"staff_id":f.owner,"display_name":"Synthetic Doctor","npi":"","specialty":"","taxonomy":taxonomy,"active":true,"reason":"Setup"});
        let (status, body) = call(
            &f.app,
            &f.cookie,
            "POST",
            "/api/v1/practice/providers",
            profile,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{taxonomy}: {body}");
        assert!(
            body.to_string()
                .contains("A taxonomy code has 10 letters and numbers."),
            "{body}"
        );
    }
    // Blank is the same as never sending the key, so it is accepted and stored
    // as no code; a half-sent code is not.
    let blank = json!({"staff_id":f.owner,"display_name":"Synthetic Doctor","npi":"","specialty":"","taxonomy":"   ","active":true,"reason":"Setup"});
    let (status, created) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/providers",
        blank,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["taxonomy"], "");
    cleanup(f).await;
}
#[tokio::test]
async fn a_provider_saved_without_the_taxonomy_key_keeps_the_code_empty() {
    let f = setup().await;
    let profile = json!({"staff_id":f.owner,"display_name":"Synthetic Doctor","npi":"","specialty":"","active":true,"reason":"Setup"});
    assert!(profile.get("taxonomy").is_none());
    let (status, created) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/providers",
        profile.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["taxonomy"], "");
    let mut cleared = profile;
    cleared["taxonomy"] = json!("207R00000X");
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            &format!("/api/v1/practice/providers/{}", f.owner),
            cleared,
            Some(1)
        )
        .await
        .0,
        StatusCode::OK
    );
    cleanup(f).await;
}
#[tokio::test]
async fn a_facility_address_saved_as_parts_returns_the_parts_and_the_joined_line() {
    let f = setup().await;
    let facility = json!({"name":"Parted Clinic","address":"whatever the screen sent","address_line1":" 10 Test Way ","address_line2":" Suite 9 ","city":" Springfield ","state":"il","postal_code":"62704-1234","phone":"5550100","active":true,"reason":"Setup"});
    let (status, created) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/facilities",
        facility.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["address_line1"], "10 Test Way");
    assert_eq!(created["address_line2"], "Suite 9");
    assert_eq!(created["city"], "Springfield");
    assert_eq!(created["state"], "IL");
    assert_eq!(created["postal_code"], "627041234");
    assert_eq!(
        created["address"],
        "10 Test Way, Suite 9, Springfield, IL 62704-1234"
    );
    let mut no_suite = facility;
    no_suite["name"] = json!("Parted Clinic Two");
    no_suite["address_line2"] = json!("");
    let (_, second) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/facilities",
        no_suite,
        None,
    )
    .await;
    assert_eq!(second["address"], "10 Test Way, Springfield, IL 62704-1234");
    let fid = created["id"].as_str().unwrap();
    let mut moved = json!({"name":"Parted Clinic","address":"","address_line1":"22 Other Way","city":"Springfield","state":"IL","postal_code":"62704","phone":"","active":true,"reason":"Moved"});
    let (status, updated) = call(
        &f.app,
        &f.cookie,
        "PUT",
        &format!("/api/v1/practice/facilities/{fid}"),
        moved.clone(),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["address"], "22 Other Way, Springfield, IL 62704");
    assert_eq!(updated["address_line2"], "");
    // Saving the same parts again with the old free-text form ignored keeps the
    // parts authoritative: the stored line is still built by the server.
    moved["address"] = json!("10 Test St");
    let (_, again) = call(
        &f.app,
        &f.cookie,
        "PUT",
        &format!("/api/v1/practice/facilities/{fid}"),
        moved,
        Some(2),
    )
    .await;
    assert_eq!(again["address"], "22 Other Way, Springfield, IL 62704");
    cleanup(f).await;
}
#[tokio::test]
async fn a_partial_facility_address_is_rejected() {
    let f = setup().await;
    for parts in [
        json!({"address_line1":"10 Test Way"}),
        json!({"address_line1":"10 Test Way","city":"Springfield"}),
        json!({"address_line1":"10 Test Way","city":"Springfield","state":"IL"}),
        json!({"address_line1":"10 Test Way","city":"Springfield","postal_code":"62704"}),
        json!({"city":"Springfield","state":"IL","postal_code":"62704"}),
        json!({"address_line1":"10 Test Way","city":"Springfield","state":"ILL","postal_code":"62704"}),
        json!({"address_line1":"10 Test Way","city":"Springfield","state":"IL","postal_code":"6270"}),
        json!({"address_line1":"10 Test Way","city":"Springfield","state":"IL","postal_code":"62704-12"}),
        json!({"address_line1":"10 Test Way","state":"IL","postal_code":"62704"}),
        json!({"address_line2":"Suite 9"}),
    ] {
        let mut facility = json!({"name":"Partial Clinic","address":"10 Test St","phone":"","active":true,"reason":"Setup"});
        for (key, value) in parts.as_object().unwrap() {
            facility[key] = value.clone();
        }
        let (status, body) = call(
            &f.app,
            &f.cookie,
            "POST",
            "/api/v1/practice/facilities",
            facility,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{parts}: {body}");
        assert!(
            body.to_string()
                .contains("Enter the street, city, state and ZIP code."),
            "{parts}: {body}"
        );
    }
    let recorded: i64 = sqlx::query_scalar("SELECT count(*) FROM practice_facilities")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(recorded, 0);
    cleanup(f).await;
}
#[tokio::test]
async fn a_facility_saved_with_only_free_text_keeps_empty_parts_and_its_address() {
    let f = setup().await;
    let facility = json!({"name":"Legacy Clinic","address":" 10 Test St, Springfield, IL. 62704 ","phone":"5550100","active":true,"reason":"Setup"});
    let (status, created) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/facilities",
        facility.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["address"], "10 Test St, Springfield, IL. 62704");
    for field in [
        "address_line1",
        "address_line2",
        "city",
        "state",
        "postal_code",
    ] {
        assert_eq!(created[field], "", "{created}");
    }
    let fid = created["id"].as_str().unwrap();
    let mut renamed = facility;
    renamed["name"] = json!("Legacy Clinic Renamed");
    let (status, updated) = call(
        &f.app,
        &f.cookie,
        "PUT",
        &format!("/api/v1/practice/facilities/{fid}"),
        renamed,
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["address"], "10 Test St, Springfield, IL. 62704");
    assert_eq!(updated["address_line1"], "");
    cleanup(f).await;
}
#[tokio::test]
async fn a_nine_digit_zip_with_a_hyphen_is_stored_as_nine_digits() {
    let f = setup().await;
    let facility = json!({"name":"Zipped Clinic","address":"","address_line1":"10 Test Way","city":"Springfield","state":"IL","postal_code":" 62704-1234 ","phone":"","active":true,"reason":"Setup"});
    let (status, created) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/facilities",
        facility,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["postal_code"], "627041234");
    let stored: String = sqlx::query_scalar(
        "SELECT postal_code FROM practice_facilities WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.tenant)
    .bind(Uuid::parse_str(created["id"].as_str().unwrap()).unwrap())
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(stored, "627041234");
    assert_eq!(
        created["address"],
        "10 Test Way, Springfield, IL 62704-1234"
    );
    cleanup(f).await;
}
#[tokio::test]
async fn the_claim_identity_migration_backfills_past_addresses_without_rewriting_history() {
    // tests/migration_smoke.rs runs migrations up to a chosen version through a
    // filtered Migrator; this does the same to reach 0108 with real rows.
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("practice_claim_identity_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let tenant = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let db = PgPoolOptions::new()
        .max_connections(4)
        .after_connect({
            let schema = schema.clone();
            move |c, _| {
                let query = format!("SET search_path TO {schema}");
                Box::pin(async move {
                    sqlx::query(&query).execute(c).await?;
                    Ok(())
                })
            }
        })
        .connect(&url)
        .await
        .unwrap();
    let through_108 = Migrator {
        migrations: Cow::Owned(
            suncharts_engine::MIGRATOR
                .iter()
                .filter(|migration| migration.version <= 108)
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    through_108.run(&db).await.unwrap();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'owner@example.test','synthetic-not-a-login-hash','owner')")
        .bind(tenant)
        .bind(owner)
        .execute(&db)
        .await
        .unwrap();
    let matched = Uuid::new_v4();
    let hyphen = Uuid::new_v4();
    let legacy = Uuid::new_v4();
    let long_street = Uuid::new_v4();
    let long_city = Uuid::new_v4();
    for (name, address) in [
        ("Backfilled Clinic", "10 Test Way, Springfield, IL. 62704"),
        (
            "Hyphenated Clinic",
            "10 Test Way, Suite 9, Springfield, IL 62704-1234",
        ),
        ("Legacy Clinic", "10 Test St"),
        (
            "Long Street Clinic",
            "A street line that is definitely more than fifty five characters long, Boston, MA. 02108",
        ),
        (
            "Long City Clinic",
            "1 Main, a city name far too long to fit inside thirty characters, MA. 02108",
        ),
    ] {
        let id = match name {
            "Backfilled Clinic" => matched,
            "Hyphenated Clinic" => hyphen,
            "Legacy Clinic" => legacy,
            "Long Street Clinic" => long_street,
            _ => long_city,
        };
        sqlx::query("INSERT INTO practice_facilities(tenant_id,id,name,address) VALUES($1,$2,$3,$4)")
            .bind(tenant)
            .bind(id)
            .bind(name)
            .bind(address)
            .execute(&db)
            .await
            .unwrap();
    }
    // A provider that already exists must also come through the new column with
    // an empty code, so no historical row can break the taxonomy constraint.
    sqlx::query("INSERT INTO practice_providers(tenant_id,id,display_name) VALUES($1,$2,'Synthetic Doctor')")
        .bind(tenant)
        .bind(owner)
        .execute(&db)
        .await
        .unwrap();
    let before: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT id::text,address,version FROM practice_facilities ORDER BY id")
            .fetch_all(&db)
            .await
            .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let parts: Vec<(String, String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT id::text,address,address_line1,address_line2,city,state,postal_code FROM practice_facilities ORDER BY id",
    )
    .fetch_all(&db)
    .await
    .unwrap();
    let row = |id: Uuid| {
        let (stored, address, line1, line2, city, state, postal) = parts
            .iter()
            .find(|(stored, ..)| stored == &id.to_string())
            .unwrap();
        (
            stored.clone(),
            address.clone(),
            line1.clone(),
            line2.clone(),
            city.clone(),
            state.clone(),
            postal.clone(),
        )
    };
    assert_eq!(
        row(matched),
        (
            matched.to_string(),
            "10 Test Way, Springfield, IL. 62704".to_string(),
            "10 Test Way".to_string(),
            String::new(),
            "Springfield".to_string(),
            "IL".to_string(),
            "62704".to_string()
        )
    );
    assert_eq!(
        row(hyphen),
        (
            hyphen.to_string(),
            "10 Test Way, Suite 9, Springfield, IL 62704-1234".to_string(),
            "10 Test Way, Suite 9".to_string(),
            String::new(),
            "Springfield".to_string(),
            "IL".to_string(),
            "627041234".to_string()
        )
    );
    // A row whose free text does not fit the shape, or whose street or city is
    // too long for its column, is left exactly as it was with empty parts.
    for untouched in [legacy, long_street, long_city] {
        let address = before
            .iter()
            .find(|(id, _, _)| id == &untouched.to_string())
            .unwrap()
            .1
            .clone();
        assert_eq!(
            row(untouched),
            (
                untouched.to_string(),
                address,
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new()
            )
        );
    }
    // No version moved and no history row was written, so the guards that keep
    // administration history append-only are never reached by the backfill.
    let versions: Vec<(String, i64)> =
        sqlx::query_as("SELECT id::text,version FROM practice_facilities ORDER BY id")
            .fetch_all(&db)
            .await
            .unwrap();
    assert_eq!(
        versions,
        before
            .iter()
            .map(|(id, _, v)| (id.clone(), *v))
            .collect::<Vec<_>>()
    );
    let history: i64 = sqlx::query_scalar("SELECT count(*) FROM practice_admin_history")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(history, 0);
    // An existing provider keeps its own taxonomy space rather than a stray value.
    let taxonomy: String =
        sqlx::query_scalar("SELECT taxonomy FROM practice_providers WHERE tenant_id=$1 AND id=$2")
            .bind(tenant)
            .bind(owner)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(taxonomy, "");
    db.close().await;
    let base = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
}
