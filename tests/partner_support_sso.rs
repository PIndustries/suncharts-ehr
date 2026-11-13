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
    let grant = Uuid::from_u128(if code.contains("logout") {
        1
    } else if code.contains("expired") {
        3
    } else if code.contains("wrong-tenant") {
        4
    } else if code.contains("local-revocation") {
        5
    } else {
        2
    });
    let now = chrono::Utc::now().timestamp();
    Json(json!({
        "iss":cloud.issuer,"aud":cloud.audience,"sub":"partner:synthetic",
        "jti":grant,"role":"partner_admin","purpose":"support","partner_id":cloud.partner,
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
    Json(json!({
        "active":true,"jti":body["jti"],"aud":cloud.audience,"role":"partner_admin",
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
    call_version(app, method, path, cookie, origin, body, None).await
}

async fn call_version(
    app: &Router,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    origin: Option<&str>,
    body: Option<Value>,
    version: Option<i64>,
) -> (StatusCode, Value, Option<String>) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    if let Some(origin) = origin {
        request = request.header(header::ORIGIN, origin);
    }
    if let Some(version) = version {
        request = request.header(header::IF_MATCH, format!("\"{version}\""));
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
    let schema = format!("partner_support_test_{}", Uuid::new_v4().simple());
    let base = sqlx::PgPool::connect(&database_url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
    let search = schema.clone();
    let db = PgPoolOptions::new()
        .max_connections(5)
        .after_connect(move |connection, _| {
            let query = format!("SET search_path TO {search}");
            Box::pin(async move {
                sqlx::query(&query).execute(connection).await?;
                Ok(())
            })
        })
        .connect(&database_url)
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

    // The delegate is an owner through live Connect authentication, not through a
    // fabricated local browser_users row. Policy and staff administration must
    // preserve that authority and attribute mutations to the grant UUID.
    let grant = Uuid::from_u128(1);
    let delegate_is_local: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM browser_users WHERE tenant_id=$1 AND id=$2)",
    )
    .bind(tenant)
    .bind(grant)
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(!delegate_is_local);
    let gateway_secret = "synthetic-delegation-boundary-secret";
    let gateway = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: gateway_secret.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), audience.clone()).unwrap()),
    });
    let now = chrono::Utc::now().timestamp();
    let gateway_token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &suncharts_engine::auth::Actor {
            sub: grant,
            tenant_id: tenant,
            role: suncharts_engine::auth::Role::Owner,
            patient_id: None,
            iss: "suncharts".into(),
            aud: "suncharts-engine".into(),
            iat: now,
            exp: now + 60,
        },
        &jsonwebtoken::EncodingKey::from_secret(gateway_secret.as_bytes()),
    )
    .unwrap();
    for (path, expected) in [
        ("/api/v1/practice/access-policies", StatusCode::FORBIDDEN),
        ("/api/v1/practice/staff", StatusCode::UNAUTHORIZED),
    ] {
        let response = gateway
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header(header::AUTHORIZATION, format!("Bearer {gateway_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            expected,
            "a signed gateway Owner cannot impersonate the delegated browser grant: {path}"
        );
    }
    let (status, catalog, _) = call(
        &app,
        "GET",
        "/api/v1/practice/access-policies",
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{catalog}");
    let policy_input = json!({"name":"Delegated front desk","base_role":"front_desk","permissions":{"clinical":{"view":true,"create":false,"edit":false,"delete":false}},"reason":"Synthetic delegated policy review"});
    let (status, policy, _) = call(
        &app,
        "POST",
        "/api/v1/practice/access-policies",
        Some(&cookie),
        Some(&audience),
        Some(policy_input.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{policy}");
    let policy_id = Uuid::parse_str(policy["id"].as_str().unwrap()).unwrap();
    let (status, updated, _) = call_version(
        &app,
        "PUT",
        &format!("/api/v1/practice/access-policies/{policy_id}"),
        Some(&cookie),
        Some(&audience),
        Some(policy_input.clone()),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["version"], 2);
    let staff = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,display_name,role) VALUES($1,$2,'delegated-front-desk@example.test','synthetic-not-login','Synthetic front desk','front_desk')")
        .bind(staff).bind(tenant).execute(&db).await.unwrap();
    let (status, staff_list, _) = call(
        &app,
        "GET",
        "/api/v1/practice/staff",
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{staff_list}");
    let (status, updated_staff, _) = call_version(&app, "PUT", &format!("/api/v1/practice/staff/{staff}"), Some(&cookie), Some(&audience), Some(json!({"display_name":"Synthetic delegated update","role":"front_desk","disabled":false,"reason":"Synthetic delegated staff review"})), Some(1)).await;
    assert_eq!(status, StatusCode::OK, "{updated_staff}");
    assert_eq!(updated_staff["version"], 2);
    let (status, assignment, _) = call_version(
        &app,
        "PUT",
        &format!("/api/v1/practice/staff/{staff}/access-policy"),
        Some(&cookie),
        Some(&audience),
        Some(json!({"policy_id":policy_id,"reason":"Synthetic delegated assignment"})),
        Some(0),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{assignment}");
    let authors: Vec<Uuid> =
        sqlx::query_scalar("SELECT actor_id FROM practice_access_revisions WHERE tenant_id=$1")
            .bind(tenant)
            .fetch_all(&db)
            .await
            .unwrap();
    assert_eq!(authors.len(), 3);
    assert!(authors.iter().all(|id| *id == grant));
    let staff_author: Uuid = sqlx::query_scalar("SELECT actor_id FROM practice_admin_history WHERE tenant_id=$1 AND resource_id=$2 AND version=2")
        .bind(tenant).bind(staff).fetch_one(&db).await.unwrap();
    assert_eq!(staff_author, grant);
    let other_tenant = Uuid::new_v4();
    let other_policy = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Other tenant policy','front_desk','{}',$3)")
        .bind(other_tenant).bind(other_policy).bind(Uuid::new_v4()).execute(&db).await.unwrap();
    let (status, _, _) = call_version(
        &app,
        "PUT",
        &format!("/api/v1/practice/access-policies/{other_policy}"),
        Some(&cookie),
        Some(&audience),
        Some(policy_input),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

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

    let (status, registered, _) = call(
        &app,
        "POST",
        "/api/v1/patients",
        Some(&cookie),
        Some(&audience),
        Some(json!({
            "given_name":"Synthetic",
            "family_name":"Partner Admin",
            "birth_date":"1990-01-01"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{registered}");

    // In a clinician's visit the support session may help draft the note, named as
    // support in the note and the audit trail. It can never sign or amend.
    let patient = Uuid::parse_str(registered["id"].as_str().unwrap()).unwrap();
    let clinician = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,display_name,role) VALUES($1,$2,'delegated-clinician@example.test','synthetic-not-login','Dr. Synthetic Clinician','clinician')")
        .bind(clinician).bind(tenant).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-11-10T15:00:00Z','2026-11-10T15:30:00Z','in_progress')")
        .bind(tenant).bind(appointment).bind(patient).bind(clinician).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id) VALUES($1,$2,$3,$4,$5)")
        .bind(tenant).bind(visit).bind(patient).bind(appointment).bind(clinician).execute(&db).await.unwrap();
    let (status, authorship, _) = call(
        &app,
        "GET",
        &format!("/api/v1/visits/{visit}/note-authorship"),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{authorship}");
    assert_eq!(authorship["delegated"], true);
    assert_eq!(authorship["can_draft"], true);
    assert_eq!(authorship["can_sign"], false);
    assert_eq!(authorship["can_amend"], false);
    assert_eq!(authorship["assigned"]["name"], "Dr. Synthetic Clinician");
    let (status, drafted, _) = call_version(
        &app,
        "PUT",
        &format!("/api/v1/visits/{visit}/note"),
        Some(&cookie),
        Some(&audience),
        Some(json!({"subjective":"Synthetic support draft","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"})),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{drafted}");
    assert_eq!(drafted["note"]["saved_by"]["id"], grant.to_string());
    assert_eq!(drafted["note"]["saved_by"]["name"], "Support staff");
    assert_eq!(drafted["note"]["saved_by"]["support"], true);
    assert_eq!(drafted["clinician_id"], clinician.to_string());
    let note_author: Uuid = sqlx::query_scalar(
        "SELECT actor_id FROM audit_events WHERE tenant_id=$1 AND action='visit.note_save' AND resource_id=$2",
    )
    .bind(tenant)
    .bind(visit)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(note_author, grant);
    let (status, _, _) = call_version(
        &app,
        "POST",
        &format!("/api/v1/visits/{visit}/sign"),
        Some(&cookie),
        Some(&audience),
        None,
        Some(2),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let unsigned: String = sqlx::query_scalar("SELECT status FROM visits WHERE id=$1")
        .bind(visit)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(unsigned, "in_progress");
    sqlx::query("UPDATE visits SET status='signed',signed_by=$2,signed_at=now(),version=version+1 WHERE id=$1")
        .bind(visit).bind(clinician).execute(&db).await.unwrap();
    let (status, _, _) = call_version(
        &app,
        "POST",
        &format!("/api/v1/visits/{visit}/amendments"),
        Some(&cookie),
        Some(&audience),
        Some(json!({"reason":"Synthetic","text":"Synthetic correction"})),
        Some(3),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let amendments: i64 = sqlx::query_scalar("SELECT count(*) FROM amendments WHERE visit_id=$1")
        .bind(visit)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(amendments, 0);
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
            "partner_admin.revoked"
        ]
    );

    for path in ["/api/v1/practice/access-policies", "/api/v1/practice/staff"] {
        assert_eq!(
            call(&app, "GET", path, Some(&revoked_cookie), None, None)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    // These cases retain an active mock grant; local expiry/revocation or a
    // tenant mismatch must still fail before the policy/admin transaction guard.
    active.store(true, Ordering::SeqCst);
    for (code, grant, scenario) in [
        (
            "synthetic-expired-code-abcdefghijklmnopqrstuvwxyz",
            Uuid::from_u128(3),
            "expired",
        ),
        (
            "synthetic-wrong-tenant-code-abcdefghijklmnopqrstuvwxyz",
            Uuid::from_u128(4),
            "wrong_tenant",
        ),
        (
            "synthetic-local-revocation-code-abcdefghijklmnopqrstuvwxyz",
            Uuid::from_u128(5),
            "revoked",
        ),
    ] {
        let (status, _, invalid_cookie) = accept(code).await;
        assert_eq!(status, StatusCode::OK);
        let invalid_cookie = invalid_cookie.unwrap();
        match scenario {
            "expired" => {
                sqlx::query("UPDATE partner_support_sessions SET created_at=now()-interval '20 minutes',expires_at=now()-interval '1 minute' WHERE grant_id=$1").bind(grant).execute(&db).await.unwrap();
            }
            "wrong_tenant" => {
                sqlx::query("UPDATE partner_support_sessions SET tenant_id=$2 WHERE grant_id=$1")
                    .bind(grant)
                    .bind(other_tenant)
                    .execute(&db)
                    .await
                    .unwrap();
            }
            _ => {
                sqlx::query(
                    "UPDATE partner_support_sessions SET revoked_at=now() WHERE grant_id=$1",
                )
                .bind(grant)
                .execute(&db)
                .await
                .unwrap();
            }
        }
        for path in ["/api/v1/practice/access-policies", "/api/v1/practice/staff"] {
            assert_eq!(
                call(&app, "GET", path, Some(&invalid_cookie), None, None)
                    .await
                    .0,
                StatusCode::UNAUTHORIZED,
                "{scenario}: {path}"
            );
        }
    }
    let other_version: i64 = sqlx::query_scalar(
        "SELECT version FROM practice_access_policies WHERE tenant_id=$1 AND id=$2",
    )
    .bind(other_tenant)
    .bind(other_policy)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(other_version, 1);

    cloud_task.abort();
    std::env::remove_var("ENGINE_CONNECT_CLOUD_URL");
    std::env::remove_var("ENGINE_CONNECT_ALLOW_LOOPBACK");
    std::env::remove_var("ENGINE_CREDENTIAL_KEY_FILE");
    std::fs::remove_dir_all(credential_dir).unwrap();
    db.close().await;
    let cleanup = sqlx::PgPool::connect(&database_url).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&cleanup)
        .await
        .unwrap();
    cleanup.close().await;
}
