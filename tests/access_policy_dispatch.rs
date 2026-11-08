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
    clinician: Uuid,
    patient: Uuid,
    appointment: Uuid,
    policy: Uuid,
    cookie: String,
    schema: String,
    url: String,
}

async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("access_dispatch_{}", Uuid::new_v4().simple());
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
    let (tenant, clinician, patient, appointment, policy) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,display_name,role) VALUES($1,$2,'dispatch@example.test','synthetic-no-login-hash','Synthetic clinician','clinician')")
        .bind(tenant).bind(clinician).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-DISPATCH','Taylor','Synthetic','1990-01-01')")
        .bind(tenant).bind(patient).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at) VALUES($1,$2,$3,$4,now()+interval '1 day',now()+interval '1 day 30 minutes')")
        .bind(tenant).bind(appointment).bind(patient).bind(clinician).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Synthetic dispatch policy','clinician',$3,$4)")
        .bind(tenant).bind(policy).bind(permissions(None)).bind(clinician).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$2)")
        .bind(tenant).bind(clinician).bind(policy).execute(&db).await.unwrap();
    let cookie = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at,auth_method) VALUES($1,$2,$3,now()+interval '1 hour','break_glass')")
        .bind(format!("{:x}", Sha256::digest(cookie.as_bytes()))).bind(tenant).bind(clinician).execute(&db).await.unwrap();
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: "synthetic-dispatch-policy-secret".into(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
    });
    Fixture {
        db,
        app,
        tenant,
        clinician,
        patient,
        appointment,
        policy,
        cookie,
        schema,
        url,
    }
}

fn permissions(denied: Option<(&str, &str)>) -> Value {
    let mut value = json!({});
    for resource in [
        "workflows",
        "scheduling",
        "communications",
        "ai",
        "clinical",
    ] {
        value[resource] = json!({"view":true,"create":true,"edit":true,"delete":true});
    }
    if let Some((resource, operation)) = denied {
        if operation == "view" {
            value[resource] = json!({"view":false,"create":false,"edit":false,"delete":false});
        } else {
            value[resource][operation] = json!(false);
        }
    }
    value
}

async fn set_permissions(f: &Fixture, denied: Option<(&str, &str)>) {
    // Direct fixture change isolates per-operation authorization from the separately
    // tested owner policy API and its intentional session revocation behavior.
    sqlx::query("UPDATE practice_access_policies SET permissions=$3 WHERE tenant_id=$1 AND id=$2")
        .bind(f.tenant)
        .bind(f.policy)
        .bind(permissions(denied))
        .execute(&f.db)
        .await
        .unwrap();
}

async fn pending(f: &Fixture, kind: &str) -> (Uuid, Uuid) {
    let (definition, instance, dispatch) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let content = json!({"steps":[{"key":"review","title":"Synthetic operation","kind":kind,"required":true,"manual_approval":true,"depends_on":[]}]});
    sqlx::query("INSERT INTO care_pathway_definitions(tenant_id,id,slug,status,name,trigger_type,definition,request_id,create_request,created_by,updated_by) VALUES($1,$2,$3,'active','Synthetic operation','manual',$4,$5,'{}',$6,$6)")
        .bind(f.tenant).bind(definition).bind(format!("synthetic-{}",definition.simple())).bind(&content).bind(Uuid::new_v4()).bind(f.clinician).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO care_pathway_definition_revisions(tenant_id,definition_id,version,status,name,description,trigger_type,definition,author_id,reason) VALUES($1,$2,1,'active','Synthetic operation','','manual',$3,$4,'Synthetic fixture')")
        .bind(f.tenant).bind(definition).bind(content).bind(f.clinician).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO care_pathway_instances(tenant_id,id,definition_id,definition_version,patient_id,appointment_id,trigger_type,trigger_key,started_by) VALUES($1,$2,$3,1,$4,$5,'manual','synthetic',$6)")
        .bind(f.tenant).bind(instance).bind(definition).bind(f.patient).bind(f.appointment).bind(f.clinician).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO care_pathway_steps(tenant_id,instance_id,step_key,position,title,kind,required,manual_approval,state,evidence,updated_by) VALUES($1,$2,'review',0,'Synthetic operation',$3,true,true,'awaiting_approval',$4,$5)")
        .bind(f.tenant).bind(instance).bind(kind).bind(json!({"workflow_dispatch_id":dispatch})).bind(f.clinician).execute(&f.db).await.unwrap();
    let input = if kind == "appointment_cancel" {
        json!({"appointment_id":f.appointment,"expected_version":1})
    } else if kind.starts_with("ai_") {
        json!({"instruction":"Summarize synthetic material","source_text":"Synthetic fixture only"})
    } else {
        // A denied actor must never reach downstream payload validation or I/O.
        json!({})
    };
    let digest = format!("{:x}", Sha256::digest(input.to_string().as_bytes()));
    sqlx::query("INSERT INTO workflow_dispatches(tenant_id,id,request_id,pathway_instance_id,step_key,kind,input,input_digest,created_by) VALUES($1,$2,$3,$4,'review',$5,$6,$7,$8)")
        .bind(f.tenant).bind(dispatch).bind(Uuid::new_v4()).bind(instance).bind(kind).bind(input).bind(digest).bind(f.clinician).execute(&f.db).await.unwrap();
    (dispatch, instance)
}

async fn call(f: &Fixture, dispatch: Uuid, suffix: &str) -> (StatusCode, Value) {
    call_with_token(f, dispatch, suffix, None).await
}

async fn call_with_token(
    f: &Fixture,
    dispatch: Uuid,
    suffix: &str,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/workflow-dispatches/{dispatch}/{suffix}"))
        .header("Origin", ORIGIN)
        .header("Content-Type", "application/json")
        .header("If-Match", "\"1\"");
    let request = match token {
        Some(token) => request.header("Authorization", format!("Bearer {token}")),
        None => request.header("Cookie", format!("sce_session={}", f.cookie)),
    };
    let response = f
        .app
        .clone()
        .oneshot(
            request
                .body(Body::from(
                    json!({"action":"approve","reason":"Synthetic reviewed operation"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn audit_count(f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1")
        .bind(f.tenant)
        .fetch_one(&f.db)
        .await
        .unwrap()
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

async fn oauth_token(f: &Fixture, scopes: &str) -> String {
    let client = Uuid::new_v4();
    let grant = Uuid::new_v4();
    let token = format!("sce_at_{}", Uuid::new_v4().simple());
    sqlx::query("INSERT INTO oauth_clients(id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES($1,$2,'Synthetic dispatch client','synthetic','https://example.test/callback',$3)")
        .bind(client).bind(f.tenant).bind(scopes).execute(&f.db).await.unwrap();
    sqlx::query(
        "INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(grant)
    .bind(client)
    .bind(f.tenant)
    .bind(f.clinician)
    .bind(scopes)
    .execute(&f.db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '1 hour')")
        .bind(format!("{:x}", Sha256::digest(token.as_bytes()))).bind(grant).execute(&f.db).await.unwrap();
    token
}

#[tokio::test]
async fn workflow_approval_cannot_bypass_downstream_custom_permissions() {
    let f = setup().await;
    // The booked appointment fixture legitimately creates two audited default
    // reminders. Denied requests must preserve that baseline, not erase history.
    let audit_before = audit_count(&f).await;
    let mut cancellation = None;
    for (kind, resource, operation) in [
        ("availability_query", "scheduling", "view"),
        ("slot_hold", "scheduling", "create"),
        ("appointment_booking", "scheduling", "create"),
        ("intake_request", "scheduling", "create"),
        ("appointment_reschedule", "scheduling", "edit"),
        ("appointment_cancel", "scheduling", "delete"),
        ("communication_send", "communications", "create"),
        ("ai_extract_draft", "ai", "create"),
        ("ai_response_draft", "ai", "create"),
    ] {
        set_permissions(&f, Some((resource, operation))).await;
        let (dispatch, instance) = pending(&f, kind).await;
        let (status, body) = call(&f, dispatch, "actions").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{kind}: {body}");
        let state: (String, i64, Option<Uuid>) = sqlx::query_as("SELECT status,version,reviewed_by FROM workflow_dispatches WHERE tenant_id=$1 AND id=$2")
            .bind(f.tenant).bind(dispatch).fetch_one(&f.db).await.unwrap();
        assert_eq!(state, ("pending_review".into(), 1, None), "{kind}");
        let step: (String, i64) = sqlx::query_as("SELECT state,version FROM care_pathway_steps WHERE tenant_id=$1 AND instance_id=$2 AND step_key='review'")
            .bind(f.tenant).bind(instance).fetch_one(&f.db).await.unwrap();
        assert_eq!(step, ("awaiting_approval".into(), 1), "{kind}");
        let events: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM workflow_dispatch_events WHERE tenant_id=$1 AND dispatch_id=$2",
        )
        .bind(f.tenant)
        .bind(dispatch)
        .fetch_one(&f.db)
        .await
        .unwrap();
        assert_eq!(
            events, 0,
            "{kind} must be denied before approval is recorded"
        );
        if kind.starts_with("ai_") {
            assert_eq!(
                call(&f, dispatch, "privacy-preview").await.0,
                StatusCode::FORBIDDEN
            );
        }
        if kind == "appointment_cancel" {
            cancellation = Some(dispatch);
        }
    }
    let appointment: (String, i64) =
        sqlx::query_as("SELECT status,version FROM appointments WHERE tenant_id=$1 AND id=$2")
            .bind(f.tenant)
            .bind(f.appointment)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(appointment, ("booked".into(), 1));
    assert_eq!(
        audit_count(&f).await,
        audit_before,
        "denied approval and preview have no downstream side effects"
    );
    set_permissions(&f, None).await;
    let (status, body) = call(&f, cancellation.unwrap(), "actions").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "completed");
    let appointment: (String, i64) =
        sqlx::query_as("SELECT status,version FROM appointments WHERE tenant_id=$1 AND id=$2")
            .bind(f.tenant)
            .bind(f.appointment)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(appointment, ("cancelled".into(), 2));
    cleanup(f).await;
}

#[tokio::test]
async fn oauth_workflow_approval_requires_downstream_scope_and_custom_permission() {
    let f = setup().await;
    let (dispatch, instance) = pending(&f, "appointment_cancel").await;
    let audit_before = audit_count(&f).await;
    for scopes in [
        "clinical.write",
        "clinical.write scheduling.read",
        "scheduling.write",
    ] {
        let token = oauth_token(&f, scopes).await;
        let (status, body) = call_with_token(&f, dispatch, "actions", Some(&token)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{scopes}: {body}");
    }
    let permitted_token = oauth_token(&f, "clinical.write scheduling.write").await;
    let (availability, _) = pending(&f, "availability_query").await;
    let (status, body) = call_with_token(&f, availability, "actions", Some(&permitted_token)).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "scheduling.write does not grant scheduling.read: {body}"
    );
    let availability_state: (String, i64) = sqlx::query_as(
        "SELECT status,version FROM workflow_dispatches WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.tenant)
    .bind(availability)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(availability_state, ("pending_review".into(), 1));
    set_permissions(&f, Some(("scheduling", "delete"))).await;
    let (status, body) = call_with_token(&f, dispatch, "actions", Some(&permitted_token)).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "OAuth scope cannot override custom policy: {body}"
    );
    let state: (String, i64, Option<Uuid>) = sqlx::query_as(
        "SELECT status,version,reviewed_by FROM workflow_dispatches WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.tenant)
    .bind(dispatch)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(state, ("pending_review".into(), 1, None));
    let step: (String, i64) = sqlx::query_as("SELECT state,version FROM care_pathway_steps WHERE tenant_id=$1 AND instance_id=$2 AND step_key='review'")
        .bind(f.tenant).bind(instance).fetch_one(&f.db).await.unwrap();
    assert_eq!(step, ("awaiting_approval".into(), 1));
    let appointment: (String, i64) =
        sqlx::query_as("SELECT status,version FROM appointments WHERE tenant_id=$1 AND id=$2")
            .bind(f.tenant)
            .bind(f.appointment)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(appointment, ("booked".into(), 1));
    assert_eq!(audit_count(&f).await, audit_before);
    set_permissions(&f, None).await;
    let (status, body) = call_with_token(&f, dispatch, "actions", Some(&permitted_token)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "completed");
    let appointment: (String, i64) =
        sqlx::query_as("SELECT status,version FROM appointments WHERE tenant_id=$1 AND id=$2")
            .bind(f.tenant)
            .bind(f.appointment)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(appointment, ("cancelled".into(), 2));
    cleanup(f).await;
}

#[tokio::test]
async fn native_dispatch_rejects_cancelled_runs_and_replaced_step_review_bindings() {
    let f = setup().await;
    let audit_before = audit_count(&f).await;
    for scenario in ["cancelled_run", "replaced_dispatch", "changed_step_state"] {
        let (dispatch, instance) = pending(&f, "appointment_cancel").await;
        match scenario {
            "cancelled_run" => {
                sqlx::query("UPDATE care_pathway_instances SET status='cancelled',version=version+1 WHERE tenant_id=$1 AND id=$2")
                .bind(f.tenant).bind(instance).execute(&f.db).await.unwrap();
            }
            "replaced_dispatch" => {
                sqlx::query("UPDATE care_pathway_steps SET evidence=$3,version=version+1 WHERE tenant_id=$1 AND instance_id=$2 AND step_key='review'")
                .bind(f.tenant).bind(instance).bind(json!({"workflow_dispatch_id":Uuid::new_v4()})).execute(&f.db).await.unwrap();
            }
            _ => {
                sqlx::query("UPDATE care_pathway_steps SET state='in_progress',version=version+1 WHERE tenant_id=$1 AND instance_id=$2 AND step_key='review'")
                .bind(f.tenant).bind(instance).execute(&f.db).await.unwrap();
            }
        }
        let (status, body) = call(&f, dispatch, "actions").await;
        assert_eq!(status, StatusCode::CONFLICT, "{scenario}: {body}");
        let state:(String,i64,Option<Uuid>)=sqlx::query_as("SELECT status,version,reviewed_by FROM workflow_dispatches WHERE tenant_id=$1 AND id=$2")
            .bind(f.tenant).bind(dispatch).fetch_one(&f.db).await.unwrap();
        assert_eq!(state, ("pending_review".into(), 1, None));
        let events: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM workflow_dispatch_events WHERE tenant_id=$1 AND dispatch_id=$2",
        )
        .bind(f.tenant)
        .bind(dispatch)
        .fetch_one(&f.db)
        .await
        .unwrap();
        assert_eq!(
            events, 0,
            "{scenario} must fail before approval events or native effects"
        );
    }
    let appointment: (String, i64) =
        sqlx::query_as("SELECT status,version FROM appointments WHERE tenant_id=$1 AND id=$2")
            .bind(f.tenant)
            .bind(f.appointment)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(appointment, ("booked".into(), 1));
    assert_eq!(audit_count(&f).await, audit_before);
    cleanup(f).await;
}
