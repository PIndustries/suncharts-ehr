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
    let schema = format!("practice_admin_{}", Uuid::new_v4().simple());
    let schema_clone = schema.clone();
    let base = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&base)
        .await
        .unwrap();
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
