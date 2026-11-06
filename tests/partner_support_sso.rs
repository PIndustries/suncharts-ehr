// SPDX-License-Identifier: AGPL-3.0-only
//! Delegated partner support is tenant-admin, revalidated and audited without staff credentials.

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
    let code = body["code"].as_str().unwrap_or_default();
    let grant = if code.contains("logout") {
        Uuid::from_u128(1)
    } else if code.contains("workflow") {
        Uuid::from_u128(3)
    } else if code.contains("owner-review") {
        Uuid::from_u128(4)
    } else {
        Uuid::from_u128(2)
    };
    let (role, purpose) = if grant == Uuid::from_u128(3) {
        ("workflow_manager", "workflow_management")
    } else {
        ("partner_admin", "support")
    };
    let now = chrono::Utc::now().timestamp();
    Json(json!({
        "iss":cloud.issuer,"aud":cloud.audience,"sub":"partner:synthetic",
        "jti":grant,"role":role,"purpose":purpose,"partner_id":cloud.partner,
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
    let workflow_grant = Uuid::from_u128(3).to_string();
    let workflow = body["jti"].as_str() == Some(workflow_grant.as_str());
    Json(json!({
        "active":true,"jti":body["jti"],"aud":cloud.audience,
        "role":if workflow {"workflow_manager"} else {"partner_admin"},
        "purpose":if workflow {"workflow_management"} else {"support"},
        "sub":"partner:synthetic",
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
async fn delegated_support_is_tenant_admin_revalidated_and_audited() {
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
    assert_eq!(me["role"], "owner");
    assert_eq!(me["delegated"], true);
    assert_eq!(me["delegated_role"], "partner_admin");
    assert_eq!(me["display_name"], "partner:synthetic");
    assert!(me["email"].is_null());

    let credential_dir = std::env::temp_dir().join(format!(
        "suncharts-partner-provider-settings-{}",
        Uuid::new_v4()
    ));
    std::env::set_var(
        "ENGINE_CREDENTIAL_KEY_FILE",
        credential_dir.join("provider-master.key"),
    );
    let account_key = "synthetic-delegated-account-key-not-real";
    let (status, setting, _) = call(
        &app,
        "POST",
        "/api/v1/billing/provider-settings",
        Some(&cookie),
        Some(&audience),
        Some(json!({
            "label":"Delegated Claim.MD",
            "usage":"T",
            "account_key":account_key,
            "start_at":"2026-11-01T00:00:00Z",
            "response_id":"0",
            "interval_seconds":60
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{setting}");
    assert_eq!(setting["label"], "Delegated Claim.MD");
    assert!(!setting.to_string().contains(account_key));
    let setting_id = Uuid::parse_str(setting["id"].as_str().unwrap()).unwrap();
    let partner_id = Uuid::parse_str(setting["partner_id"].as_str().unwrap()).unwrap();
    let (status, settings, _) = call(
        &app,
        "GET",
        "/api/v1/billing/provider-settings",
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{settings}");
    assert_eq!(settings["items"].as_array().unwrap().len(), 1);
    assert_eq!(settings["items"][0]["id"], setting_id.to_string());
    let (saved_tenant, guide_reference): (Uuid, String) = sqlx::query_as(
        "SELECT s.tenant_id,p.content->>'guide_reference'
           FROM edi_provider_settings s
           JOIN edi_partners p ON p.tenant_id=s.tenant_id AND p.id=s.partner_id
          WHERE s.id=$1 AND p.id=$2",
    )
    .bind(setting_id)
    .bind(partner_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(saved_tenant, tenant);
    assert_eq!(
        guide_reference,
        "Claim.MD native professional-claims JSON upload"
    );

    let mrn = format!("PARTNER-{}", Uuid::new_v4().simple());
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/patients",
            Some(&cookie),
            Some(&audience),
            Some(json!({
                "mrn":mrn,
                "given_name":"Synthetic",
                "family_name":"Partner Admin",
                "birth_date":"1990-01-01"
            })),
        )
        .await
        .0,
        StatusCode::CREATED
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

    let workflow_definition_id = Uuid::new_v4();
    let workflow_author = Uuid::new_v4();
    let workflow_definition = json!({
        "steps":[{"key":"review","title":"Review intake","kind":"human_approval","required":true,"manual_approval":true,"depends_on":[]}]
    });
    sqlx::query("INSERT INTO care_pathway_definitions(tenant_id,id,slug,name,description,trigger_type,definition,request_id,create_request,created_by,updated_by) VALUES($1,$2,'intake-review','Intake review','','appointment_created',$3,$4,'{}',$5,$5)")
        .bind(tenant).bind(workflow_definition_id).bind(&workflow_definition)
        .bind(Uuid::new_v4()).bind(workflow_author).execute(&db).await.unwrap();

    let (status, workflow_me, workflow_cookie) =
        accept("synthetic-workflow-code-abcdefghijklmnopqrstuvwxyz").await;
    assert_eq!(status, StatusCode::OK, "{workflow_me}");
    let workflow_cookie = workflow_cookie.unwrap();
    let (status, workflow_me, _) =
        call(&app, "GET", "/auth/me", Some(&workflow_cookie), None, None).await;
    assert_eq!(status, StatusCode::OK, "{workflow_me}");
    assert_eq!(workflow_me["delegated_role"], "workflow_manager");

    for (method, path, body, origin) in [
        ("GET", "/api/v1/patients", None, None),
        (
            "POST",
            "/api/v1/patients",
            Some(
                json!({"mrn":"DENIED","given_name":"No","family_name":"Access","birth_date":"1990-01-01"}),
            ),
            Some(audience.as_str()),
        ),
        ("GET", "/api/v1/billing/provider-settings", None, None),
        ("GET", "/api/v1/billing/claims", None, None),
        ("GET", "/api/v1/practice/workspace-settings", None, None),
        ("GET", "/api/v1/care-pathways/instances", None, None),
    ] {
        assert_eq!(
            call(&app, method, path, Some(&workflow_cookie), origin, body)
                .await
                .0,
            StatusCode::FORBIDDEN,
            "workflow manager unexpectedly accessed {method} {path}"
        );
    }
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/care-pathways/definitions",
            Some(&workflow_cookie),
            None,
            None,
        )
        .await
        .0,
        StatusCode::OK
    );
    let change_path =
        format!("/api/v1/care-pathways/definitions/{workflow_definition_id}/change-requests");
    let (status, requested, _) = call(
        &app,
        "POST",
        &change_path,
        Some(&workflow_cookie),
        Some(&audience),
        Some(json!({
            "base_version":1,
            "proposal":{
                "name":"Intake review revised",
                "description":"Partner proposed; owner approval required",
                "trigger_type":"appointment_created",
                "definition":workflow_definition
            },
            "reason":"Add the clinic intake review step"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{requested}");
    assert_eq!(requested["status"], "pending");
    let request_id = requested["id"].as_str().unwrap();
    let (_, _, owner_cookie) =
        accept("synthetic-owner-review-code-abcdefghijklmnopqrstuvwxyz").await;
    let owner_cookie = owner_cookie.unwrap();
    let review_path = format!("/api/v1/care-pathways/change-requests/{request_id}/actions");
    let (status, reviewed, _) = call(
        &app,
        "POST",
        &review_path,
        Some(&owner_cookie),
        Some(&audience),
        Some(json!({"action":"approve","reason":"Clinic owner approved the draft"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reviewed}");
    assert_eq!(reviewed["status"], "approved");
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/care-pathways/sandbox",
            Some(&workflow_cookie),
            Some(&audience),
            Some(json!({"definition":workflow_definition,"context":{}})),
        )
        .await
        .0,
        StatusCode::OK
    );

    let (_, _, revoked_cookie) = accept("synthetic-revoked-code-abcdefghijklmnopqrstuvwxyz").await;
    let revoked_cookie = revoked_cookie.unwrap();
    active.store(false, Ordering::SeqCst);
    assert_eq!(
        call(&app, "GET", "/auth/me", Some(&revoked_cookie), None, None,)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let actions: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_events WHERE action LIKE 'partner_admin.%' ORDER BY id",
    )
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(
        actions,
        vec![
            "partner_admin.session_created",
            "partner_admin.logout",
            "partner_admin.session_created",
            "partner_admin.session_created",
            "partner_admin.revoked"
        ]
    );

    cloud_task.abort();
    std::env::remove_var("ENGINE_CONNECT_CLOUD_URL");
    std::env::remove_var("ENGINE_CONNECT_ALLOW_LOOPBACK");
    std::env::remove_var("ENGINE_CREDENTIAL_KEY_FILE");
    std::fs::remove_dir_all(credential_dir).unwrap();
}
