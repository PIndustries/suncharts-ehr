// SPDX-License-Identifier: AGPL-3.0-only
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

const SECRET: &str = "synthetic-care-pathways-secret";

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

async fn setup() -> (PgPool, Actor, Actor, Actor, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("care_pathways_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(5)
        .after_connect(move |connection, _| {
            let query = format!("SET search_path TO {schema}");
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
    let front_desk = actor(owner.tenant_id, Role::FrontDesk);
    let clinician = actor(owner.tenant_id, Role::Clinician);
    for (user, role) in [
        (&owner, "owner"),
        (&front_desk, "front_desk"),
        (&clinician, "clinician"),
    ] {
        sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-login',$4)")
            .bind(user.tenant_id)
            .bind(user.sub)
            .bind(format!("{}@example.test", user.sub))
            .bind(role)
            .execute(&db)
            .await
            .unwrap();
    }
    let patient = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-PATH','Taylor','Synthetic','1990-01-01')")
        .bind(owner.tenant_id)
        .bind(patient)
        .execute(&db)
        .await
        .unwrap();
    (db, owner, front_desk, clinician, patient)
}

async fn pathway_step_version(db: &PgPool, tenant: Uuid, instance: Uuid, step: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT version FROM care_pathway_steps WHERE tenant_id=$1 AND instance_id=$2 AND step_key=$3",
    )
    .bind(tenant)
    .bind(instance)
    .bind(step)
    .fetch_one(db)
    .await
    .unwrap()
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

fn definition(request_id: Uuid) -> Value {
    json!({
        "request_id":request_id,
        "slug":"synthetic-previsit",
        "name":"Synthetic pre-visit pathway",
        "description":"Synthetic records only",
        "trigger_type":"appointment_created",
        "definition":{"steps":[
            {"key":"intake","title":"Record intake coordination","kind":"staff_task","required":true,"manual_approval":false,"depends_on":[]},
            {"key":"eligibility","title":"Review staff assessment","kind":"human_approval","required":true,"manual_approval":true,"assigned_role":"front_desk","depends_on":["intake"]},
            {"key":"estimate","title":"Review estimate","kind":"human_approval","required":false,"manual_approval":true,"assigned_role":"front_desk","depends_on":["eligibility"],"condition":{"field":"/insurance/present","operator":"equals","value":true}}
        ]},
        "reason":"Synthetic pathway configuration"
    })
}

#[tokio::test]
async fn pathway_definition_trigger_and_manual_approval_are_versioned_and_tenant_scoped() {
    let (db, owner, front_desk, clinician, patient) = setup().await;
    let router = app(db.clone());
    let request_id = Uuid::new_v4();
    let input = definition(request_id);
    let (status, created) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/care-pathways/definitions",
        input.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["version"], 1);
    let (_, replay) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/care-pathways/definitions",
        input,
        None,
    )
    .await;
    assert_eq!(replay["id"], created["id"]);

    let definition_id = created["id"].as_str().unwrap();
    let (status, active) = call(
        &router,
        &owner,
        "POST",
        &format!("/api/v1/care-pathways/definitions/{definition_id}/actions"),
        json!({"action":"activate","reason":"Synthetic activation"}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{active}");
    assert_eq!(active["status"], "active");
    assert_eq!(active["version"], 2);

    let trigger = json!({
        "request_id":Uuid::new_v4(),
        "trigger_type":"appointment_created",
        "trigger_key":"synthetic-appointment-1",
        "definition_id":definition_id,
        "patient_id":patient,
        "appointment_id":null,
        "visit_id":null,
        "context":{"insurance":{"present":true}},
        "reason":"Synthetic appointment created"
    });
    let (status, started) = call(
        &router,
        &front_desk,
        "POST",
        "/api/v1/care-pathways/trigger",
        trigger.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let instance = &started["items"][0];
    assert_eq!(instance["steps"][0]["state"], "ready");
    assert_eq!(instance["steps"][1]["state"], "blocked");
    assert_eq!(instance["steps"][2]["state"], "blocked");
    let instance_id = instance["id"].as_str().unwrap();

    let (_, replayed) = call(
        &router,
        &front_desk,
        "POST",
        "/api/v1/care-pathways/trigger",
        trigger,
        None,
    )
    .await;
    assert_eq!(replayed["items"][0]["id"], instance["id"]);

    let (_, intake_complete) = call(
        &router,
        &front_desk,
        "POST",
        &format!("/api/v1/care-pathways/instances/{instance_id}/steps/intake/actions"),
        json!({"action":"complete","reason":"Synthetic form received","evidence":{"form_revision":"synthetic"}}),
        Some(1),
    )
    .await;
    assert_eq!(intake_complete["steps"][1]["state"], "ready");
    let (_, submitted) = call(
        &router,
        &front_desk,
        "POST",
        &format!("/api/v1/care-pathways/instances/{instance_id}/steps/eligibility/actions"),
        json!({"action":"complete","reason":"Synthetic eligibility reviewed","evidence":{"source":"synthetic"}}),
        Some(2),
    )
    .await;
    assert_eq!(submitted["steps"][1]["state"], "awaiting_approval");
    assert_eq!(
        call(
            &router,
            &front_desk,
            "POST",
            &format!("/api/v1/care-pathways/instances/{instance_id}/steps/eligibility/actions"),
            json!({"action":"approve","reason":"Not authorized","evidence":{}}),
            Some(3),
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, approved) = call(
        &router,
        &clinician,
        "POST",
        &format!("/api/v1/care-pathways/instances/{instance_id}/steps/eligibility/actions"),
        json!({"action":"approve","reason":"Synthetic clinical approval","evidence":{}}),
        Some(3),
    )
    .await;
    assert_eq!(approved["steps"][1]["state"], "completed");
    assert_eq!(approved["steps"][2]["state"], "ready");
    assert_eq!(approved["status"], "active");
    let (_, completed) = call(
        &router,
        &front_desk,
        "POST",
        &format!("/api/v1/care-pathways/instances/{instance_id}/steps/estimate/actions"),
        json!({"action":"skip","reason":"Synthetic patient declined prepayment","evidence":{}}),
        Some(2),
    )
    .await;
    assert_eq!(completed["steps"][2]["state"], "skipped");
    assert_eq!(completed["status"], "completed");

    let foreign = actor(Uuid::new_v4(), Role::Owner);
    assert_eq!(
        call(
            &router,
            &foreign,
            "GET",
            &format!("/api/v1/care-pathways/instances/{instance_id}"),
            Value::Null,
            None,
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert!(sqlx::query("DELETE FROM care_pathway_events")
        .execute(&db)
        .await
        .is_err());
    assert!(sqlx::query("DELETE FROM care_pathway_definition_revisions")
        .execute(&db)
        .await
        .is_err());
}

#[tokio::test]
async fn inquiry_booking_hands_off_to_visit_workflow_with_native_proof_and_optional_skips() {
    let (db, owner, front_desk, clinician, patient) = setup().await;
    let router = app(db.clone());

    let (_, inquiry) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/care-pathways/definitions",
        json!({
            "request_id":Uuid::new_v4(),
            "slug":"synthetic-inquiry-to-booking",
            "name":"Inquiry to booking",
            "description":"Synthetic first-contact handoff",
            "trigger_type":"inquiry_received",
            "definition":{"steps":[
                {"key":"review-inquiry","title":"Review inquiry","kind":"staff_task","required":true,"manual_approval":false,"assigned_role":"front_desk","depends_on":[]},
                {"key":"schedule-visit","title":"Book appointment","kind":"appointment_booking","required":true,"manual_approval":true,"assigned_role":"front_desk","depends_on":["review-inquiry"]}
            ]},
            "reason":"Synthetic inquiry workflow"
        }),
        None,
    )
    .await;
    let inquiry_id = inquiry["id"].as_str().unwrap();
    assert_eq!(
        call(
            &router,
            &owner,
            "POST",
            &format!("/api/v1/care-pathways/definitions/{inquiry_id}/actions"),
            json!({"action":"activate","reason":"Publish synthetic inquiry workflow"}),
            Some(1),
        )
        .await
        .0,
        StatusCode::OK
    );

    let (_, visit_definition) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/care-pathways/definitions",
        json!({
            "request_id":Uuid::new_v4(),
            "slug":"synthetic-booked-visit",
            "name":"Booked visit and follow-up",
            "description":"Synthetic appointment-linked visit workflow",
            "trigger_type":"appointment_created",
            "definition":{"steps":[
                {"key":"intake-forms","title":"Review intake","kind":"patient_form","required":true,"manual_approval":false,"assigned_role":"front_desk","depends_on":[],"native":{"resource":"intake_reviewed"}},
                {"key":"verify-benefits","title":"Review coverage response","kind":"eligibility_query","required":false,"manual_approval":true,"assigned_role":"front_desk","depends_on":[],"native":{"resource":"eligibility"}},
                {"key":"benefits-review","title":"Approve benefits review","kind":"human_approval","required":true,"manual_approval":true,"assigned_role":"front_desk","depends_on":["verify-benefits"]},
                {"key":"check-in","title":"Check in","kind":"staff_task","required":true,"manual_approval":false,"assigned_role":"front_desk","depends_on":["intake-forms","benefits-review"],"native":{"resource":"check_in"}},
                {"key":"clinical-visit","title":"Sign encounter","kind":"clinical_template","required":true,"manual_approval":true,"assigned_role":"clinician","depends_on":["check-in"],"native":{"resource":"signed_visit"}},
                {"key":"collect-payment","title":"Collect patient payment","kind":"payment_request","required":false,"manual_approval":true,"assigned_role":"front_desk","depends_on":["check-in"],"native":{"resource":"payment"}},
                {"key":"review-claim","title":"Review claim","kind":"human_approval","required":false,"manual_approval":true,"assigned_role":"clinician","depends_on":["clinical-visit"],"native":{"resource":"claim_review"}},
                {"key":"follow-up","title":"Complete follow-up","kind":"staff_task","required":true,"manual_approval":false,"assigned_role":"front_desk","depends_on":["clinical-visit"],"native":{"resource":"follow_up"}}
            ]},
            "reason":"Synthetic booked-visit workflow"
        }),
        None,
    )
    .await;
    let visit_definition_id = visit_definition["id"].as_str().unwrap();
    assert_eq!(
        call(
            &router,
            &owner,
            "POST",
            &format!("/api/v1/care-pathways/definitions/{visit_definition_id}/actions"),
            json!({"action":"activate","reason":"Publish synthetic booked-visit workflow"}),
            Some(1),
        )
        .await
        .0,
        StatusCode::OK
    );

    let (_, inquiry_run) = call(
        &router,
        &front_desk,
        "POST",
        "/api/v1/care-pathways/trigger",
        json!({
            "request_id":Uuid::new_v4(),
            "trigger_type":"inquiry_received",
            "trigger_key":"synthetic-inquiry-runtime-proof",
            "definition_id":inquiry_id,
            "patient_id":patient,
            "context":{"source":"synthetic"},
            "reason":"Synthetic inquiry received"
        }),
        None,
    )
    .await;
    let inquiry_instance = inquiry_run["items"][0]["id"].as_str().unwrap();
    let (_, reviewed) = call(
        &router,
        &front_desk,
        "POST",
        &format!("/api/v1/care-pathways/instances/{inquiry_instance}/steps/review-inquiry/actions"),
        json!({"action":"complete","reason":"Synthetic inquiry reviewed","evidence":{"source":"synthetic"}}),
        Some(1),
    )
    .await;
    assert_eq!(reviewed["steps"][1]["state"], "ready");

    let starts = Utc::now() + chrono::Duration::days(5);
    let (status, dispatch) = call(
        &router,
        &front_desk,
        "POST",
        &format!(
            "/api/v1/care-pathways/instances/{inquiry_instance}/steps/schedule-visit/dispatch"
        ),
        json!({
            "request_id":Uuid::new_v4(),
            "input":{
                "request_id":Uuid::new_v4(),
                "source_history_id":null,
                "title":"Synthetic workflow visit",
                "category":"Office visit",
                "facility":"Synthetic clinic",
                "room":"Room 1",
                "notes":"Synthetic runtime proof only",
                "reason":"Appointment booked from reviewed inquiry",
                "patient_id":patient,
                "clinician_id":clinician.sub,
                "starts_at":starts,
                "ends_at":starts+chrono::Duration::minutes(30)
            },
            "reason":"Prepare reviewed synthetic booking"
        }),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{dispatch}");
    let dispatch_id = dispatch["id"].as_str().unwrap();
    let (status, booked) = call(
        &router,
        &owner,
        "POST",
        &format!("/api/v1/workflow-dispatches/{dispatch_id}/actions"),
        json!({"action":"approve","reason":"Approve synthetic patient booking"}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{booked}");
    assert_eq!(booked["status"], "completed");
    let appointment =
        Uuid::parse_str(booked["result"]["appointment_id"].as_str().unwrap()).unwrap();
    let inquiry_status: String = sqlx::query_scalar(
        "SELECT status FROM care_pathway_instances WHERE tenant_id=$1 AND id=$2",
    )
    .bind(owner.tenant_id)
    .bind(Uuid::parse_str(inquiry_instance).unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(inquiry_status, "completed");

    assert_eq!(
        suncharts_engine::workflow_triggers::tick(&db)
            .await
            .unwrap(),
        1
    );
    let (visit_instance, visit_definition_version): (Uuid, i64) = sqlx::query_as(
        "SELECT id,definition_version FROM care_pathway_instances WHERE tenant_id=$1 AND definition_id=$2 AND appointment_id=$3",
    )
    .bind(owner.tenant_id)
    .bind(Uuid::parse_str(visit_definition_id).unwrap())
    .bind(appointment)
    .fetch_one(&db)
    .await
    .unwrap();

    let packet = Uuid::new_v4();
    sqlx::query("INSERT INTO previsit_intake_packets(tenant_id,id,appointment_id,patient_id,template_id,template_version,template_snapshot,access_token_hash,status,due_at,issued_by,submitted_at,reviewed_at,reviewed_by,workflow_instance_id,workflow_step_key,workflow_definition_version) VALUES($1,$2,$3,$4,NULL,$8,'{}',$5,'reviewed',now(),$6,now(),now(),$6,$7,'intake-forms',$8)")
        .bind(owner.tenant_id).bind(packet).bind(appointment).bind(patient).bind("a".repeat(64)).bind(owner.sub).bind(visit_instance).bind(visit_definition_version).execute(&db).await.unwrap();
    let step_path = |step: &str| {
        format!("/api/v1/care-pathways/instances/{visit_instance}/steps/{step}/actions")
    };
    assert_eq!(
        call(
            &router,
            &front_desk,
            "POST",
            &step_path("intake-forms"),
            json!({"action":"complete","reason":"Reviewed synthetic intake","evidence":{}}),
            Some(pathway_step_version(&db, owner.tenant_id, visit_instance, "intake-forms").await)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &router,
            &front_desk,
            "POST",
            &step_path("verify-benefits"),
            json!({"action":"skip","reason":"Synthetic self-pay visit","evidence":{}}),
            Some(
                pathway_step_version(&db, owner.tenant_id, visit_instance, "verify-benefits").await
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &router,
            &front_desk,
            "POST",
            &step_path("benefits-review"),
            json!({"action":"complete","reason":"Reviewed synthetic self-pay path","evidence":{}}),
            Some(
                pathway_step_version(&db, owner.tenant_id, visit_instance, "benefits-review").await
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &router,
            &owner,
            "POST",
            &step_path("benefits-review"),
            json!({"action":"approve","reason":"Approved synthetic self-pay path","evidence":{}}),
            Some(
                pathway_step_version(&db, owner.tenant_id, visit_instance, "benefits-review").await
            )
        )
        .await
        .0,
        StatusCode::OK
    );

    assert_eq!(
        call(
            &router,
            &owner,
            "POST",
            &format!("/api/v1/appointments/{appointment}/check-in"),
            json!({}),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &router,
            &front_desk,
            "POST",
            &step_path("check-in"),
            json!({"action":"complete","reason":"Native check-in verified","evidence":{}}),
            Some(pathway_step_version(&db, owner.tenant_id, visit_instance, "check-in").await)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(call(&router,&front_desk,"POST",&step_path("collect-payment"),json!({"action":"skip","reason":"No patient payment due in synthetic case","evidence":{}}),Some(pathway_step_version(&db, owner.tenant_id, visit_instance, "collect-payment").await)).await.0,StatusCode::OK);

    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,signed_by,signed_at,note) VALUES($1,$2,$3,$4,$5,'signed',$5,now(),'{}')")
        .bind(owner.tenant_id).bind(visit).bind(patient).bind(appointment).bind(clinician.sub).execute(&db).await.unwrap();
    assert_eq!(
        call(
            &router,
            &clinician,
            "POST",
            &step_path("clinical-visit"),
            json!({"action":"complete","reason":"Native signed visit verified","evidence":{}}),
            Some(
                pathway_step_version(&db, owner.tenant_id, visit_instance, "clinical-visit").await
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &router,
            &clinician,
            "POST",
            &step_path("clinical-visit"),
            json!({"action":"approve","reason":"Reviewed signed visit","evidence":{}}),
            Some(
                pathway_step_version(&db, owner.tenant_id, visit_instance, "clinical-visit").await
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(call(&router,&clinician,"POST",&step_path("review-claim"),json!({"action":"skip","reason":"No insurance claim for synthetic self-pay visit","evidence":{}}),Some(pathway_step_version(&db, owner.tenant_id, visit_instance, "review-claim").await)).await.0,StatusCode::OK);

    let follow_up = Uuid::new_v4();
    sqlx::query("INSERT INTO follow_up_tasks(tenant_id,id,patient_id,visit_id,request_id,creation_hash,title,instructions,assigned_to,due_date,status,created_by) VALUES($1,$2,$3,$4,$5,'synthetic','Synthetic follow-up','Synthetic instructions',$6,'2030-01-20','completed',$6)")
        .bind(owner.tenant_id).bind(follow_up).bind(patient).bind(visit).bind(Uuid::new_v4()).bind(front_desk.sub).execute(&db).await.unwrap();
    let (status, completed) = call(
        &router,
        &front_desk,
        "POST",
        &step_path("follow-up"),
        json!({"action":"complete","reason":"Native follow-up verified","evidence":{}}),
        Some(pathway_step_version(&db, owner.tenant_id, visit_instance, "follow-up").await),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{completed}");
    assert_eq!(completed["status"], "completed");
    assert_eq!(
        completed["steps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|step| step["state"] == "skipped")
            .count(),
        3
    );
    assert_eq!(
        completed["steps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|step| step["state"] == "completed")
            .count(),
        5
    );
}

#[test]
fn spasticity_template_is_configuration_not_runtime_branching() {
    let template = suncharts_engine::care_pathways::specialty_care_template();
    assert_eq!(template["trigger_type"], "appointment_created");
    let definition: suncharts_engine::care_pathways::Definition =
        serde_json::from_value(template["definition"].clone()).unwrap();
    for kind in [
        "patient_form",
        "eligibility_query",
        "payment_request",
        "clinical_template",
        "order",
        "referral",
        "communication_send",
    ] {
        assert!(
            definition.steps.iter().any(|step| step.kind == kind),
            "missing generic module {kind}"
        );
    }
    assert!(definition
        .steps
        .iter()
        .any(|step| step.key == "functional-status"
            && step.kind == "clinical_template"
            && step.manual_approval));
    assert!(
        !definition
            .steps
            .iter()
            .any(|step| step.kind == "appointment_booking"),
        "a booked-visit template must not book a duplicate appointment"
    );
    assert!(definition
        .steps
        .iter()
        .any(|step| step.key == "functional-status"
            && step
                .native
                .as_ref()
                .is_some_and(|binding| binding.resource == "functional_status")));
    assert!(definition
        .steps
        .iter()
        .any(|step| step.key == "legal-consents"
            && step.kind == "patient_form"
            && step
                .native
                .as_ref()
                .is_some_and(|binding| binding.resource == "intake_reviewed")));
    let phases: std::collections::BTreeSet<_> = definition
        .steps
        .iter()
        .filter_map(|step| step.phase.as_deref())
        .collect();
    assert_eq!(
        phases,
        std::collections::BTreeSet::from(["pre_visit", "visit", "follow_up"])
    );
    let keys: std::collections::BTreeSet<_> = definition
        .steps
        .iter()
        .map(|step| step.key.as_str())
        .collect();
    assert_eq!(
        keys.len(),
        definition.steps.len(),
        "node keys must remain unique"
    );
    for step in &definition.steps {
        assert!(
            step.depends_on
                .iter()
                .all(|dependency| keys.contains(dependency.as_str())),
            "dependency must reference a configured node"
        );
    }
    let mut reachable = std::collections::BTreeSet::new();
    while reachable.len() < keys.len() {
        let before = reachable.len();
        for step in &definition.steps {
            if step
                .depends_on
                .iter()
                .all(|dependency| reachable.contains(dependency.as_str()))
            {
                reachable.insert(step.key.as_str());
            }
        }
        assert!(
            reachable.len() > before,
            "configured journey must be acyclic"
        );
    }
}

#[tokio::test]
async fn sun_dispatch_hides_local_source_and_requires_current_run_privacy_review() {
    // No connection or provider is configured: these gates must reject before
    // any model request. All source content is synthetic.
    let (db, owner, front_desk, _, patient) = setup().await;
    let router = app(db.clone());
    let integration = Uuid::new_v4();
    let node = json!({"key":"extract","title":"Review synthetic extraction","kind":"ai_extract_draft","manual_approval":true,"assigned_role":"front_desk","ai":{"integration_id":integration,"instruction":"Extract explicit facts for Taylor Synthetic.","source_field":"/referral/body"}});
    let (status, created) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/care-pathways/definitions",
        json!({"request_id":Uuid::new_v4(),"slug":"synthetic-sun-privacy","name":"Synthetic Sun privacy","trigger_type":"referral_received","definition":{"steps":[node]},"reason":"Synthetic privacy fixture"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(
        created["definition"]["steps"][0]["ai"]["privacy"]["preview_required"],
        true
    );
    let definition_id = created["id"].as_str().unwrap();
    let (status, active) = call(
        &router,
        &owner,
        "POST",
        &format!("/api/v1/care-pathways/definitions/{definition_id}/actions"),
        json!({"action":"activate","reason":"Synthetic activation"}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{active}");
    let (status, started) = call(
        &router,
        &front_desk,
        "POST",
        "/api/v1/care-pathways/trigger",
        json!({"request_id":Uuid::new_v4(),"trigger_type":"referral_received","trigger_key":"synthetic-sun-privacy-1","definition_id":definition_id,"patient_id":patient,"context":{"referral":{"body":"Taylor Synthetic, MRN SYN-PATH, has code QA0.0101."}},"reason":"Synthetic referral"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let instance_id = started["items"][0]["id"].as_str().unwrap();

    // Editing the template does not change a running instance's frozen node.
    let mut changed_node = created["definition"]["steps"][0].clone();
    changed_node["ai"]["instruction"] = json!("New template must not change the existing run.");
    let (status, changed) = call(
        &router,
        &owner,
        "PUT",
        &format!("/api/v1/care-pathways/definitions/{definition_id}"),
        json!({"name":"Changed synthetic template","trigger_type":"referral_received","definition":{"steps":[changed_node]},"reason":"Synthetic template update"}),
        Some(2),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    let create_dispatch =
        json!({"request_id":Uuid::new_v4(),"input":{},"reason":"Prepare local synthetic work"});
    let dispatch_path =
        format!("/api/v1/care-pathways/instances/{instance_id}/steps/extract/dispatch");
    let (status, dispatch) = call(
        &router,
        &front_desk,
        "POST",
        &dispatch_path,
        create_dispatch.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{dispatch}");
    assert_eq!(dispatch["privacy_review_required"], true);
    assert!(dispatch.get("input").is_none());
    assert!(!dispatch.to_string().contains("Taylor Synthetic"));
    let id = dispatch["id"].as_str().unwrap();
    let dispatch_id = Uuid::parse_str(id).unwrap();
    let local_input: Value =
        sqlx::query_scalar("SELECT input FROM workflow_dispatches WHERE tenant_id=$1 AND id=$2")
            .bind(owner.tenant_id)
            .bind(dispatch_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(
        local_input["instruction"],
        "Extract explicit facts for Taylor Synthetic."
    );
    assert!(local_input["source_text"]
        .as_str()
        .unwrap()
        .contains("QA0.0101"));
    let (_, replay) = call(
        &router,
        &front_desk,
        "POST",
        &dispatch_path,
        create_dispatch,
        None,
    )
    .await;
    assert_eq!(replay["id"], dispatch["id"]);
    assert!(replay.get("input").is_none());
    let (_, detail) = call(
        &router,
        &owner,
        "GET",
        &format!("/api/v1/workflow-dispatches/{id}"),
        Value::Null,
        None,
    )
    .await;
    assert!(detail["dispatch"].get("input").is_none());
    assert!(!detail.to_string().contains("Taylor Synthetic"));
    let preview_path = format!("/api/v1/workflow-dispatches/{id}/privacy-preview");
    let action_path = format!("/api/v1/workflow-dispatches/{id}/actions");
    assert_eq!(
        call(
            &router,
            &front_desk,
            "POST",
            &preview_path,
            json!({}),
            Some(1)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&router, &owner, "POST", &preview_path, json!({}), None)
            .await
            .0,
        StatusCode::PRECONDITION_REQUIRED
    );
    assert_eq!(
        call(&router, &owner, "POST", &preview_path, json!({}), Some(2))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let foreign = actor(Uuid::new_v4(), Role::Owner);
    assert_eq!(
        call(&router, &foreign, "POST", &preview_path, json!({}), Some(1))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &router,
            &owner,
            "POST",
            &action_path,
            json!({"action":"approve","reason":"Missing exact privacy review"}),
            Some(1)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );

    let (_, instance) = call(
        &router,
        &owner,
        "GET",
        &format!("/api/v1/care-pathways/instances/{instance_id}"),
        Value::Null,
        None,
    )
    .await;
    let (status, cancelled) = call(
        &router,
        &owner,
        "POST",
        &format!("/api/v1/care-pathways/instances/{instance_id}/actions"),
        json!({"action":"cancel","reason":"Synthetic cancellation before execution"}),
        instance["version"].as_i64(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(
        call(&router, &owner, "POST", &preview_path, json!({}), Some(1))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(call(&router, &owner, "POST", &action_path, json!({"action":"approve","reason":"Cancelled run must not execute","privacy_preview_id":Uuid::new_v4(),"privacy_approved":true}), Some(1)).await.0, StatusCode::CONFLICT);
    let (status, version): (String, i64) = sqlx::query_as(
        "SELECT status,version FROM workflow_dispatches WHERE tenant_id=$1 AND id=$2",
    )
    .bind(owner.tenant_id)
    .bind(dispatch_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(status, "pending_review");
    assert_eq!(version, 1);
    let executions: i64 = sqlx::query_scalar("SELECT count(*) FROM workflow_dispatch_events WHERE tenant_id=$1 AND dispatch_id=$2 AND action='dispatch_approved'")
        .bind(owner.tenant_id).bind(dispatch_id).fetch_one(&db).await.unwrap();
    assert_eq!(executions, 0);
    db.close().await;
}
