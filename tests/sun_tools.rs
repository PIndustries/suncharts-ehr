// SPDX-License-Identifier: AGPL-3.0-only
//! Synthetic local aggregates only. No provider requests or patient text output.
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
const SECRET: &str = "synthetic-local-sun-tools-secret";
fn actor(tenant: Uuid, role: Role) -> Actor {
    let now = Utc::now().timestamp();
    Actor {
        sub: Uuid::new_v4(),
        tenant_id: tenant,
        role,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    }
}
fn token(actor: &Actor) -> String {
    let mut actor = actor.clone();
    actor.iat = Utc::now().timestamp();
    actor.exp = actor.iat + 120;
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &actor,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}
async fn call(router: &Router, token: Option<&str>, path: &str) -> (StatusCode, Value, String) {
    let mut request = Request::builder().method("GET").uri(path);
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cache = response
        .headers()
        .get("cache-control")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        cache,
    )
}
async fn post(router: &Router, actor: &Actor, path: &str, body: Value) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("Authorization", format!("Bearer {}", token(actor)))
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn proposal_draft(
    db: &PgPool,
    actor: &Actor,
    integration: Uuid,
    proposal: &Value,
    approved: bool,
) -> Uuid {
    let draft = Uuid::new_v4();
    let preview = Uuid::new_v4();
    // Synthetic trusted persisted output; no provider request is made. Validation
    // reads the completed draft and approval provenance, not encrypted source.
    sqlx::query("INSERT INTO ai_privacy_previews(tenant_id,id,created_by,binding_digest,encrypted_payload,metadata,expires_at) VALUES($1,$2,$3,$4,$5,'{}',now()+interval '15 minutes')")
        .bind(actor.tenant_id).bind(preview).bind(actor.sub).bind("0".repeat(64)).bind(vec![0u8;32]).execute(db).await.unwrap();
    sqlx::query("INSERT INTO claude_drafts(tenant_id,id,request_id,integration_id,purpose,model,status,request_digest,created_by,content,privacy_preview_id,privacy) VALUES($1,$2,$3,$4,'workflow_design','synthetic-model','draft',$5,$6,$7,$8,'{\"status\":\"approved\"}')")
        .bind(actor.tenant_id).bind(draft).bind(Uuid::new_v4()).bind(integration).bind("0".repeat(64)).bind(actor.sub).bind(proposal.to_string()).bind(preview).execute(db).await.unwrap();
    if approved {
        sqlx::query("INSERT INTO ai_privacy_approvals(tenant_id,preview_id,draft_id,approved_by) VALUES($1,$2,$3,$4)")
            .bind(actor.tenant_id).bind(preview).bind(draft).bind(actor.sub).execute(db).await.unwrap();
    }
    draft
}
async fn workflow_proposal_checks(
    db: &PgPool,
    router: &Router,
    owner: &Actor,
    other: &Actor,
    nurse: &Actor,
) {
    let integration = Uuid::new_v4();
    sqlx::query("INSERT INTO instance_integrations(tenant_id,id,provider,label,auth_type,status,enabled,credential_revision,capabilities,created_by,updated_by) VALUES($1,$2,'erebine','Synthetic design','api_key','connected',true,1,'[\"workflow_design\",\"draft_response\"]',$3,$3)")
        .bind(owner.tenant_id).bind(integration).bind(owner.sub).execute(db).await.unwrap();
    let before:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM care_pathway_definitions),(SELECT count(*) FROM care_pathway_instances)").fetch_one(db).await.unwrap();
    let proposal = json!({"name":"Synthetic intake","description":"Synthetic form draft","trigger_type":"appointment_created","definition":{"columns":[{"key":"intake","title":"Intake"}],"steps":[{"key":"form","title":"Intake preferences","kind":"patient_form","phase":"intake","form_fields":[{"key":"contact","label":"Contact preference","field_type":"choice","options":["Portal","Phone"]}]},{"key":"reply","title":"Reviewed reply","kind":"ai_response_draft","phase":"intake","manual_approval":true,"depends_on":["form"],"ai":{"integration_id":integration,"instruction":"Prepare a draft reply","source_field":"/intake/reply"}}]}});
    let draft = proposal_draft(db, owner, integration, &proposal, true).await;
    let path = "/api/v1/sun/workflow-proposals/validate";
    let (status, validated) = post(router, owner, path, json!({"draft_id":draft})).await;
    assert_eq!(status, StatusCode::OK, "{validated}");
    assert_eq!(validated["valid"], true);
    assert_eq!(validated["application"], "unsaved_studio_draft_only");
    assert_eq!(
        validated["proposal"]["definition"]["steps"][1]["ai"]["integration_id"],
        integration.to_string()
    );
    assert!(validated["warnings"].as_array().unwrap().len() >= 2);
    assert_eq!(
        post(router, nurse, path, json!({"draft_id":draft})).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        post(router, other, path, json!({"draft_id":draft})).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        post(
            router,
            owner,
            path,
            json!({"draft_id":draft,"proposal":proposal})
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let unreviewed = proposal_draft(db, owner, integration, &proposal, false).await;
    assert_eq!(
        post(router, owner, path, json!({"draft_id":unreviewed}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    for invalid_kind in ["unsupported_mapping", "order"] {
        let mut invalid = proposal.clone();
        invalid["definition"]["steps"][1] = json!({"key":"unsafe","title":"Unsafe node","kind":invalid_kind,"manual_approval":false});
        let id = proposal_draft(db, owner, integration, &invalid, true).await;
        assert_eq!(
            post(router, owner, path, json!({"draft_id":id})).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let mut invalid = proposal.clone();
    invalid["definition"]["steps"][1]["ai"]["integration_id"] = json!(Uuid::new_v4());
    let id = proposal_draft(db, owner, integration, &invalid, true).await;
    assert_eq!(
        post(router, owner, path, json!({"draft_id":id})).await.0,
        StatusCode::CONFLICT
    );
    invalid = proposal.clone();
    invalid["definition"]["steps"][1]["kind"] = json!("ai_extract_draft");
    let id = proposal_draft(db, owner, integration, &invalid, true).await;
    assert_eq!(
        post(router, owner, path, json!({"draft_id":id})).await.0,
        StatusCode::CONFLICT
    );
    let request = json!({"integration_id":integration,"purpose":"workflow_design","instruction":"Design a native form","source_text":"Synthetic catalog only"});
    assert_eq!(
        post(router, nurse, "/api/v1/ai/privacy/preview", request.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let mut generate = request;
    generate["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        post(router, nurse, "/api/v1/ai/drafts", generate.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        post(router, owner, "/api/v1/ai/drafts", generate).await.0,
        StatusCode::BAD_REQUEST
    );
    let after:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM care_pathway_definitions),(SELECT count(*) FROM care_pathway_instances)").fetch_one(db).await.unwrap();
    assert_eq!(
        before, after,
        "validation must not save definitions or execute workflows"
    );
    let audit_count:i64=sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='sun.workflow_proposal.validated' AND resource_id=$2").bind(owner.tenant_id).bind(draft).fetch_one(db).await.unwrap();
    assert_eq!(audit_count, 1);
    sqlx::raw_sql("CREATE FUNCTION deny_sun_proposal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='sun.workflow_proposal.validated' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER deny_sun_proposal_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_sun_proposal_audit();").execute(db).await.unwrap();
    assert_eq!(
        post(router, owner, path, json!({"draft_id":draft})).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
}
async fn oauth(db: &PgPool, actor: &Actor, scopes: &str) -> (String, Uuid) {
    let client = Uuid::new_v4();
    let grant = Uuid::new_v4();
    let token = format!("sce_at_synthetic_{}", Uuid::new_v4().simple());
    sqlx::query("INSERT INTO oauth_clients(id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES($1,$2,'Synthetic local tools','unused','https://example.test/callback','clinical.read scheduling.read')")
        .bind(client).bind(actor.tenant_id).execute(db).await.unwrap();
    sqlx::query(
        "INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(grant)
    .bind(client)
    .bind(actor.tenant_id)
    .bind(actor.sub)
    .bind(scopes)
    .execute(db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '5 minutes')")
        .bind(suncharts_engine::oauth::hash(&token)).bind(grant).execute(db).await.unwrap();
    (token, grant)
}
async fn patients(db: &PgPool, actor: &Actor, count: usize) -> Uuid {
    let first = Uuid::new_v4();
    for index in 0..count {
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'PrivateSyntheticGiven','PrivateSyntheticFamily','1990-01-02')")
            .bind(actor.tenant_id).bind(if index==0{first}else{Uuid::new_v4()}).bind(format!("SYN-PRIVATE-{index}")).execute(db).await.unwrap();
    }
    first
}
async fn workflows(db: &PgPool, actor: &Actor) -> Vec<Uuid> {
    let definition = Uuid::new_v4();
    sqlx::query("INSERT INTO care_pathway_definitions(tenant_id,id,slug,name,trigger_type,definition,request_id,create_request,created_by,updated_by) VALUES($1,$2,'synthetic-tools','Private workflow title','manual','{}',$3,'{}',$4,$4)")
        .bind(actor.tenant_id).bind(definition).bind(Uuid::new_v4()).bind(actor.sub).execute(db).await.unwrap();
    let mut ids = Vec::new();
    for status in ["active", "completed", "cancelled"] {
        let id = Uuid::new_v4();
        ids.push(id);
        sqlx::query("INSERT INTO care_pathway_instances(tenant_id,id,definition_id,definition_version,trigger_type,trigger_key,status,started_by) VALUES($1,$2,$3,1,'manual',$4,$4,$5)")
            .bind(actor.tenant_id).bind(id).bind(definition).bind(status).bind(actor.sub).execute(db).await.unwrap();
        for (position, state) in ["ready", "awaiting_approval", "completed"]
            .into_iter()
            .enumerate()
        {
            sqlx::query("INSERT INTO care_pathway_steps(tenant_id,instance_id,step_key,position,title,kind,required,manual_approval,state,updated_by) VALUES($1,$2,$3,$4,'Private step title','staff_task',true,true,$3,$5)")
                .bind(actor.tenant_id).bind(id).bind(state).bind(position as i32).bind(actor.sub).execute(db).await.unwrap();
        }
    }
    ids
}
#[tokio::test]
async fn local_context_counts_exact_tenant_records_and_preserves_roles_scopes_and_audit() {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("sun_tools_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
    let search_path = schema.clone();
    let db = PgPoolOptions::new()
        .max_connections(5)
        .after_connect(move |connection, _| {
            let query = format!("SET search_path TO {search_path}");
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
    let other = actor(Uuid::new_v4(), Role::Owner);
    let nurse = actor(owner.tenant_id, Role::Nurse);
    let readonly = actor(owner.tenant_id, Role::ReadOnly);
    for (actor, role) in [
        (&owner, "owner"),
        (&other, "owner"),
        (&nurse, "nurse"),
        (&readonly, "read_only"),
    ] {
        sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,$3,'unused',$4)").bind(actor.tenant_id).bind(actor.sub).bind(format!("{}@example.test",actor.sub)).bind(role).execute(&db).await.unwrap();
    }
    let patient = patients(&db, &owner, 153).await;
    let other_patient = patients(&db, &other, 7).await;
    sqlx::query("INSERT INTO previsit_booking_profiles(tenant_id,public_slug,default_clinician_id,booking_timezone,updated_by) VALUES($1,'synthetic-local-tools',$2,'America/Chicago',$2)").bind(owner.tenant_id).bind(owner.sub).execute(&db).await.unwrap();
    let today: chrono::NaiveDate =
        sqlx::query_scalar("SELECT (now() AT TIME ZONE 'America/Chicago')::date")
            .fetch_one(&db)
            .await
            .unwrap();
    let mut appointment_ids = Vec::new();
    for (index, status) in [
        "booked",
        "checked_in",
        "in_progress",
        "completed",
        "cancelled",
        "no_show",
    ]
    .into_iter()
    .enumerate()
    {
        let id = Uuid::new_v4();
        appointment_ids.push(id);
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,($5::date::timestamp AT TIME ZONE 'America/Chicago')+make_interval(hours=>$6),($5::date::timestamp AT TIME ZONE 'America/Chicago')+make_interval(hours=>$6,mins=>30),$7)")
            .bind(owner.tenant_id).bind(id).bind(patient).bind(owner.sub).bind(today).bind(index as i32+10).bind(status).execute(&db).await.unwrap();
    }
    // Starts before today's boundary (even though it overlaps it), and exactly
    // at tomorrow's boundary, are not appointments starting today.
    for minute in [-10, 24 * 60] {
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,($5::date::timestamp AT TIME ZONE 'America/Chicago')+make_interval(mins=>$6),($5::date::timestamp AT TIME ZONE 'America/Chicago')+make_interval(mins=>$6+30),'booked')")
            .bind(owner.tenant_id).bind(Uuid::new_v4()).bind(patient).bind(owner.sub).bind(today).bind(minute).execute(&db).await.unwrap();
    }
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,now(),now()+interval '30 minutes','booked')")
        .bind(other.tenant_id).bind(Uuid::new_v4()).bind(other_patient).bind(other.sub).execute(&db).await.unwrap();
    let workflow_ids = workflows(&db, &owner).await;
    workflows(&db, &other).await;
    let router = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), "http://127.0.0.1:8099".into()).unwrap()),
    });
    let path = "/api/v1/sun/context";
    let (status, context, cache) = call(&router, Some(&token(&owner)), path).await;
    assert_eq!(status, StatusCode::OK, "{context}");
    assert_eq!(cache, "no-store");
    assert_eq!(context["facts"]["patients"]["total"], 153);
    assert_eq!(context["practice_timezone"], "America/Chicago");
    assert_eq!(context["timezone_source"], "practice_booking_settings");
    assert!(chrono::DateTime::parse_from_rfc3339(context["observed_at"].as_str().unwrap()).is_ok());
    assert_eq!(context["facts"]["appointments"]["date"], today.to_string());
    assert_eq!(context["facts"]["appointments"]["total"], 6);
    assert_eq!(
        context["facts"]["appointments"]["by_status"],
        json!({"booked":1,"checked_in":1,"in_progress":1,"completed":1,"cancelled":1,"no_show":1,"other":0})
    );
    assert_eq!(context["facts"]["workflows"]["total"], 3);
    assert_eq!(
        context["facts"]["workflows"]["by_status"],
        json!({"active":1,"completed":1,"cancelled":1,"other":0})
    );
    assert_eq!(context["facts"]["workflows"]["ready_steps"], 1);
    assert_eq!(context["facts"]["workflows"]["awaiting_approval_steps"], 1);
    assert_eq!(
        context["capabilities"],
        json!([
            "patients.count",
            "appointments.today.count",
            "workflows.count"
        ])
    );
    assert_eq!(context["unavailable"], json!([]));
    let encoded = context.to_string();
    for hidden in [
        "PrivateSyntheticGiven",
        "PrivateSyntheticFamily",
        "SYN-PRIVATE",
        "1990-01-02",
        "Private workflow title",
        "Private step title",
    ] {
        assert!(!encoded.contains(hidden));
    }
    for id in [owner.tenant_id, owner.sub, patient, other_patient]
        .into_iter()
        .chain(appointment_ids)
        .chain(workflow_ids)
    {
        assert!(!encoded.contains(&id.to_string()));
    }
    let (_, page, _) = call(&router, Some(&token(&owner)), "/api/v1/patients").await;
    assert_eq!(page["items"].as_array().unwrap().len(), 50);
    for allowed in [&nurse, &readonly] {
        let (status, value, _) = call(&router, Some(&token(allowed)), path).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["facts"], context["facts"]);
    }
    let (status, foreign, _) = call(&router, Some(&token(&other)), path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(foreign["facts"]["patients"]["total"], 7);
    assert_eq!(foreign["practice_timezone"], "UTC");
    assert_eq!(foreign["timezone_source"], "UTC_default");
    let mut patient_actor = actor(owner.tenant_id, Role::Patient);
    patient_actor.patient_id = Some(patient);
    assert_eq!(
        call(&router, Some(&token(&patient_actor)), path).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(call(&router, None, path).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        call(
            &router,
            Some(&token(&owner)),
            &format!("{path}?tenant_id={}", other.tenant_id)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );

    let (clinical, grant) = oauth(&db, &owner, "clinical.read").await;
    let (status, limited, _) = call(&router, Some(&clinical), path).await;
    assert_eq!(status, StatusCode::OK, "{limited}");
    assert_eq!(limited["facts"]["patients"]["total"], 153);
    assert!(limited["facts"].get("appointments").is_none());
    assert_eq!(
        limited["capabilities"],
        json!(["patients.count", "workflows.count"])
    );
    assert_eq!(
        limited["unavailable"][0]["tool"],
        "appointments.today.count"
    );
    let (combined, _) = oauth(&db, &owner, "clinical.read scheduling.read").await;
    let (status, complete, _) = call(&router, Some(&combined), path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(complete["facts"]["appointments"]["total"], 6);
    let (scheduling, _) = oauth(&db, &owner, "scheduling.read").await;
    assert_eq!(
        call(&router, Some(&scheduling), path).await.0,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE oauth_grants SET revoked_at=now() WHERE id=$1")
        .bind(grant)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        call(&router, Some(&clinical), path).await.0,
        StatusCode::UNAUTHORIZED
    );
    workflow_proposal_checks(&db, &router, &owner, &other, &nurse).await;
    sqlx::raw_sql("CREATE FUNCTION deny_sun_context_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='sun.context.read' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER deny_sun_context_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_sun_context_audit();").execute(&db).await.unwrap();
    let (status, failed, _) = call(&router, Some(&token(&owner)), path).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(failed.get("facts").is_none());
    drop(router);
    db.close().await;
    let base = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
}
