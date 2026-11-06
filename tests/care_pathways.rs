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
            {"key":"intake","title":"Complete intake","kind":"patient_form","required":true,"manual_approval":false,"depends_on":[],"completion_events":[{"event_type":"intake.reviewed"}]},
            {"key":"eligibility","title":"Review eligibility","kind":"eligibility_query","required":true,"manual_approval":true,"assigned_role":"front_desk","depends_on":["intake"],"completion_events":[{"event_type":"eligibility.returned","condition":{"field":"/reviewed","operator":"equals","value":true}}]},
            {"key":"estimate","title":"Review estimate","kind":"payment_request","required":false,"manual_approval":true,"assigned_role":"front_desk","depends_on":["eligibility"],"condition":{"field":"/insurance/present","operator":"equals","value":true}}
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

    let (status, sandbox) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/care-pathways/sandbox",
        json!({"definition":created["definition"],"context":{"insurance":{"present":true}}}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sandbox}");
    assert_eq!(sandbox["valid"], true);
    assert_eq!(sandbox["side_effects"], false);

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

    let event_request = Uuid::new_v4();
    let (status, observed) = call(
        &router,
        &front_desk,
        "POST",
        "/api/v1/care-pathways/events",
        json!({"request_id":event_request,"event_type":"intake.reviewed","patient_id":patient,"appointment_id":null,"visit_id":null,"context":{},"evidence":{"form_revision":"synthetic"},"reason":"Synthetic intake reviewed"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{observed}");
    assert_eq!(observed["pathway_instances"][0], instance["id"]);
    let (_, intake_complete) = call(
        &router,
        &front_desk,
        "GET",
        &format!("/api/v1/care-pathways/instances/{instance_id}"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(intake_complete["steps"][0]["state"], "completed");
    assert_eq!(intake_complete["steps"][1]["state"], "ready");
    let (_, replayed_event) = call(
        &router,
        &front_desk,
        "POST",
        "/api/v1/care-pathways/events",
        json!({"request_id":event_request,"event_type":"intake.reviewed","patient_id":patient,"appointment_id":null,"visit_id":null,"context":{},"evidence":{"form_revision":"synthetic"},"reason":"Synthetic intake replay"}),
        None,
    )
    .await;
    assert_eq!(
        replayed_event["pathway_instances"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
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

    let (status, restored) = call(
        &router,
        &owner,
        "POST",
        &format!("/api/v1/care-pathways/definitions/{definition_id}/restore"),
        json!({"version":1,"reason":"Restore reviewed synthetic revision"}),
        Some(2),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(restored["status"], "draft");
    assert_eq!(restored["version"], 3);

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

#[test]
fn coordinated_care_starter_is_configuration_not_runtime_branching() {
    let template = suncharts_engine::care_pathways::coordinated_care_starter();
    assert_eq!(template["trigger_type"], "appointment_created");
    assert_eq!(template["definition"]["steps"].as_array().unwrap().len(), 6);
    assert!(template["definition"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|step| step["key"] == "functional-status"));
    assert_eq!(
        template["definition"]["builder"]["nodes"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
    assert!(template["definition"]["builder"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|node| node["node_type"] == "form"
            && !node["form_fields"].as_array().unwrap().is_empty()));
}
