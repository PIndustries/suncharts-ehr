// SPDX-License-Identifier: AGPL-3.0-only
//! Synthetic database-only checks for the shared Sun provider/review boundary.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
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

const SECRET: &str = "synthetic-ai-provider-boundary-secret";
fn actor(tenant_id: Uuid, role: Role) -> Actor {
    let now = Utc::now().timestamp();
    Actor {
        sub: Uuid::new_v4(),
        tenant_id,
        role,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    }
}
async fn setup() -> (PgPool, Actor, Actor, Actor, Actor, String) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("ai_provider_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
    let path_schema = schema.clone();
    let db = PgPoolOptions::new()
        .max_connections(5)
        .after_connect(move |connection, _| {
            let query = format!("SET search_path TO {path_schema}");
            Box::pin(async move {
                sqlx::query(&query).execute(connection).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let owner = actor(Uuid::new_v4(), Role::Owner);
    let nurse = actor(owner.tenant_id, Role::Nurse);
    let clinician = actor(owner.tenant_id, Role::Clinician);
    let other = actor(Uuid::new_v4(), Role::Owner);
    for (user, role) in [
        (&owner, "owner"),
        (&nurse, "nurse"),
        (&clinician, "clinician"),
        (&other, "owner"),
    ] {
        sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-login',$4)")
            .bind(user.tenant_id).bind(user.sub).bind(format!("{}@example.test",user.sub)).bind(role).execute(&db).await.unwrap();
    }
    (db, owner, nurse, clinician, other, schema)
}
fn app(db: PgPool) -> Router {
    suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db, "http://127.0.0.1:8099".into()).unwrap()),
    })
}
async fn call(
    router: &Router,
    actor: &Actor,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        actor,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");
    if let Some(version) = version {
        request = request.header("If-Match", format!("\"{version}\""));
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn encrypted_providers_staff_catalog_capability_scope_replay_and_review() {
    // One test in this executable: the isolated key cannot interfere with another
    // credential test or use the developer instance's private master key.
    let key_path = std::env::temp_dir().join(format!("suncharts-ai-test-{}.key", Uuid::new_v4()));
    std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", &key_path);
    let (db, owner, nurse, clinician, other, schema) = setup().await;
    let router = app(db.clone());
    let secret = "synthetic-erebine-test-credential-0000";
    let config = json!({"model":"synthetic-model","project_id":"synthetic-project","workspace_id":"synthetic-workspace"});
    let create = json!({"provider":"erebine","label":"Synthetic Erebine","config":config,"credential":secret,"capabilities":["structured_extraction"]});
    assert_eq!(
        call(
            &router,
            &nurse,
            "POST",
            "/api/v1/integrations",
            create.clone(),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, saved) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/integrations",
        create.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["provider"], "erebine");
    assert!(!saved.to_string().contains(secret));
    let id = saved["id"].as_str().unwrap();
    let encrypted:Vec<u8>=sqlx::query_scalar("SELECT encrypted_secret FROM instance_integration_credentials WHERE tenant_id=$1 AND integration_id=$2")
        .bind(owner.tenant_id).bind(Uuid::parse_str(id).unwrap()).fetch_one(&db).await.unwrap();
    assert!(!encrypted
        .windows(secret.len())
        .any(|v| v == secret.as_bytes()));
    let (status, enabled) = call(
        &router,
        &owner,
        "POST",
        &format!("/api/v1/integrations/{id}/actions"),
        json!({"action":"enable"}),
        saved["version"].as_i64(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{enabled}");
    let mut bad = create.clone();
    bad["config"]["base_url"] = json!("https://example.test");
    assert_eq!(
        call(&router, &owner, "POST", "/api/v1/integrations", bad, None)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let (status,claude)=call(&router,&owner,"POST","/api/v1/integrations",json!({"provider":"claude","label":"Synthetic Claude","config":{"model":"claude-haiku-5-5"},"credential":"synthetic-claude-credential"}),None).await;
    assert_eq!(status, StatusCode::OK, "{claude}");
    assert_eq!(
        call(
            &router,
            &owner,
            "POST",
            &format!(
                "/api/v1/integrations/{}/actions",
                claude["id"].as_str().unwrap()
            ),
            json!({"action":"enable"}),
            claude["version"].as_i64()
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &router,
            &nurse,
            "GET",
            "/api/v1/integrations",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, catalog) = call(
        &router,
        &nurse,
        "GET",
        "/api/v1/ai/connections",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(catalog["items"].as_array().unwrap().len(), 2);
    for hidden in [
        secret,
        "synthetic-project",
        "synthetic-workspace",
        "credential_hint",
        "config",
    ] {
        assert!(!catalog.to_string().contains(hidden));
    }
    assert_eq!(
        call(
            &router,
            &other,
            "GET",
            "/api/v1/ai/connections",
            Value::Null,
            None
        )
        .await
        .1["items"],
        json!([])
    );
    let mut generate = json!({"request_id":Uuid::new_v4(),"integration_id":id,"purpose":"draft_summary","instruction":"Extract only the supplied synthetic fact.","source_text":"Synthetic appointment is Monday.","privacy_preview_id":Uuid::new_v4(),"privacy_approved":true});
    assert_eq!(
        call(
            &router,
            &nurse,
            "POST",
            "/api/v1/ai/drafts",
            generate.clone(),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    generate["purpose"] = json!("structured_extraction");
    assert_eq!(
        call(
            &router,
            &other,
            "POST",
            "/api/v1/ai/drafts",
            generate.clone(),
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut unspecified = generate.clone();
    unspecified["integration_id"] = Value::Null;
    assert_eq!(
        call(
            &router,
            &nurse,
            "POST",
            "/api/v1/ai/drafts",
            unspecified,
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );

    let mut without_approval = generate.clone();
    without_approval
        .as_object_mut()
        .unwrap()
        .remove("privacy_preview_id");
    without_approval
        .as_object_mut()
        .unwrap()
        .remove("privacy_approved");
    assert_eq!(
        call(
            &router,
            &nurse,
            "POST",
            "/api/v1/ai/drafts",
            without_approval,
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let patient = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-PRIV-123','Avery','Synthetic','1990-01-02')")
        .bind(owner.tenant_id).bind(patient).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,$3)")
        .bind(owner.tenant_id).bind(patient).bind(json!({"preferred_name":"Aves","phone":"(312) 555-0100","email":"avery@example.test","address":{"line1":"123 Main Street","city":"Chicago","postal_code":"60601"},"emergency_contact":{"name":"Morgan Example","phone":"3125550199"}})).execute(&db).await.unwrap();
    let sensitive = json!({"integration_id":id,"purpose":"structured_extraction","patient_id":patient,"instruction":"Summarize Avery and Morgan. Email avery@example.test.","source_text":format!("Aves Synthetic, MRN: SYN-PRIV-123; DOB: 1990-01-02; phone (312) 555-0100; 123 Main Street; Chicago 60601; contact Morgan Example 3125550199; local ID {patient}; ICD Z00.00 and CPT 99213.")});
    let (status, privacy) = call(
        &router,
        &nurse,
        "POST",
        "/api/v1/ai/privacy/preview",
        sensitive.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{privacy}");
    let provider_fields = format!("{} {}", privacy["instruction"], privacy["source_text"]);
    for hidden in [
        "Avery",
        "Aves",
        "Synthetic",
        "Morgan",
        "Example",
        "SYN-PRIV-123",
        "1990-01-02",
        "(312) 555-0100",
        "3125550199",
        "avery@example.test",
        "Main Street",
        "Chicago",
        "60601",
    ] {
        assert!(
            !provider_fields.contains(hidden),
            "identifier remained: {hidden}"
        );
    }
    assert!(!provider_fields.contains(&patient.to_string()));
    assert!(provider_fields.contains("Z00.00"));
    assert!(provider_fields.contains("99213"));
    assert!(privacy["redaction_count"].as_u64().unwrap() > 5);
    assert!(!privacy.to_string().contains("replacements"));
    let privacy_id = Uuid::parse_str(privacy["id"].as_str().unwrap()).unwrap();
    let encrypted: Vec<u8> = sqlx::query_scalar(
        "SELECT encrypted_payload FROM ai_privacy_previews WHERE tenant_id=$1 AND id=$2",
    )
    .bind(owner.tenant_id)
    .bind(privacy_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(!encrypted.windows(b"Avery".len()).any(|v| v == b"Avery"));
    let mut approved = sensitive.clone();
    approved["request_id"] = json!(Uuid::new_v4());
    approved["privacy_preview_id"] = json!(privacy_id);
    approved["privacy_approved"] = json!(true);
    assert_eq!(
        call(
            &router,
            &clinician,
            "POST",
            "/api/v1/ai/drafts",
            approved.clone(),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let mut changed = approved.clone();
    changed["instruction"] = json!("Changed instructions");
    assert_eq!(
        call(&router, &nurse, "POST", "/api/v1/ai/drafts", changed, None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let mut changed = approved.clone();
    changed["source_text"] = json!(format!("{} ", approved["source_text"].as_str().unwrap()));
    assert_eq!(
        call(&router, &nurse, "POST", "/api/v1/ai/drafts", changed, None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let mut changed = approved.clone();
    changed["integration_id"] = claude["id"].clone();
    assert_eq!(
        call(&router, &nurse, "POST", "/api/v1/ai/drafts", changed, None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (status, _) = call(
        &router,
        &other,
        "POST",
        "/api/v1/ai/privacy/preview",
        sensitive.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let mut foreign_patient = sensitive.clone();
    foreign_patient["patient_id"] = json!(Uuid::new_v4());
    assert_eq!(
        call(
            &router,
            &nurse,
            "POST",
            "/api/v1/ai/privacy/preview",
            foreign_patient,
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    sqlx::query("UPDATE patient_demographics SET content=content||'{\"preferred_name\":\"New name\"}'::jsonb,version=version+1 WHERE tenant_id=$1 AND patient_id=$2")
        .bind(owner.tenant_id).bind(patient).execute(&db).await.unwrap();
    assert_eq!(
        call(
            &router,
            &nurse,
            "POST",
            "/api/v1/ai/drafts",
            approved.clone(),
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let expired = Uuid::new_v4();
    sqlx::query("INSERT INTO ai_privacy_previews(tenant_id,id,created_by,binding_digest,encrypted_payload,metadata,expires_at,created_at) SELECT tenant_id,$3,created_by,binding_digest,encrypted_payload,metadata,now()-interval '1 minute',now()-interval '16 minutes' FROM ai_privacy_previews WHERE tenant_id=$1 AND id=$2")
        .bind(owner.tenant_id).bind(privacy_id).bind(expired).execute(&db).await.unwrap();
    approved["privacy_preview_id"] = json!(expired);
    assert_eq!(
        call(&router, &nurse, "POST", "/api/v1/ai/drafts", approved, None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM claude_drafts WHERE tenant_id=$1")
        .bind(owner.tenant_id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "rejected privacy approvals must not reserve a provider request"
    );

    let mut preview_input = generate.clone();
    for field in ["request_id", "privacy_preview_id", "privacy_approved"] {
        preview_input.as_object_mut().unwrap().remove(field);
    }
    let (status, preview) = call(
        &router,
        &nurse,
        "POST",
        "/api/v1/ai/privacy/preview",
        preview_input,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    generate["privacy_preview_id"] = preview["id"].clone();

    // Seed a completed provider response to prove retry and human review without
    // sending any fixture data or fake credential to a real provider.
    let draft = Uuid::new_v4();
    let request_id = Uuid::parse_str(generate["request_id"].as_str().unwrap()).unwrap();
    let digest = suncharts_engine::oauth::hash(&json!({"integration_id":id,"purpose":"structured_extraction","instruction":generate["instruction"],"source_text":generate["source_text"],"patient_id":null,"pathway_instance_id":null,"step_key":null,"workflow_revision":null,"privacy_preview_id":generate["privacy_preview_id"]}).to_string());
    let preview_id = Uuid::parse_str(preview["id"].as_str().unwrap()).unwrap();
    sqlx::query("INSERT INTO claude_drafts(tenant_id,id,request_id,integration_id,purpose,model,status,request_digest,created_by,content,privacy_preview_id,privacy) VALUES($1,$2,$3,$4,'structured_extraction','synthetic-model','draft',$5,$6,'{\"appointment\":\"Monday\"}',$7,'{\"status\":\"approved\"}')")
        .bind(owner.tenant_id).bind(draft).bind(request_id).bind(Uuid::parse_str(id).unwrap()).bind(digest).bind(nurse.sub).bind(preview_id).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO ai_privacy_approvals(tenant_id,preview_id,draft_id,approved_by) VALUES($1,$2,$3,$4)").bind(owner.tenant_id).bind(preview_id).bind(draft).bind(nurse.sub).execute(&db).await.unwrap();
    let (status, replayed) = call(
        &router,
        &nurse,
        "POST",
        "/api/v1/ai/drafts",
        generate.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replayed}");
    assert_eq!(replayed["id"], draft.to_string());
    assert_eq!(replayed["provider"], "erebine");
    assert_eq!(replayed["model"], "synthetic-model");
    let mut reuse = generate.clone();
    reuse["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        call(&router, &nurse, "POST", "/api/v1/ai/drafts", reuse, None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    generate["source_text"] = json!("Different synthetic input");
    assert_eq!(
        call(&router, &nurse, "POST", "/api/v1/ai/drafts", generate, None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &router,
            &other,
            "GET",
            &format!("/api/v1/ai/drafts/{draft}"),
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let review = json!({"action":"approve","reason":"Reviewed synthetic fixture only"});
    assert_eq!(
        call(
            &router,
            &nurse,
            "POST",
            &format!("/api/v1/ai/drafts/{draft}/actions"),
            review.clone(),
            Some(1)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, approved) = call(
        &router,
        &clinician,
        "POST",
        &format!("/api/v1/ai/drafts/{draft}/actions"),
        review.clone(),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    assert_eq!(approved["status"], "approved");
    assert_eq!(approved["provider"], "erebine");
    assert_eq!(
        call(
            &router,
            &clinician,
            "POST",
            &format!("/api/v1/ai/drafts/{draft}/actions"),
            review,
            Some(2)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM claude_draft_events WHERE tenant_id=$1 AND draft_id=$2 AND action='draft_approved'")
        .bind(owner.tenant_id).bind(draft).fetch_one(&db).await.unwrap();
    assert_eq!(count, 1);
    assert!(sqlx::query("UPDATE claude_drafts SET content='changed',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(owner.tenant_id).bind(draft).execute(&db).await.is_err());
    assert_eq!(
        call(
            &router,
            &nurse,
            "GET",
            &format!("/api/v1/integrations/{id}/erebine/models"),
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &router,
            &other,
            "GET",
            &format!("/api/v1/integrations/{id}/erebine/models"),
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    drop(router);
    db.close().await;
    let base = PgPool::connect(&std::env::var("TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
    std::fs::remove_file(key_path).unwrap();
}
