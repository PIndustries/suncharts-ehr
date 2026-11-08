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
    let schema = format!("workflow_events_test_{}", Uuid::new_v4().simple());
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

fn published(request: Uuid, slug: &str, trigger: &str) -> Value {
    json!({"request_id":request,"slug":slug,"name":"Synthetic native event workflow","description":"Synthetic staff handoff","trigger_type":trigger,"definition":{"steps":[{"key":"review","title":"Review next work","kind":"staff_task","required":true,"manual_approval":false,"depends_on":[]}]},"reason":"Synthetic event test"})
}

#[tokio::test]
async fn native_booking_starts_only_published_same_tenant_workflows_once() {
    let (db, owner, _, _, patient) = setup().await;
    let router = app(db.clone());
    let (status, draft) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/care-pathways/definitions",
        published(Uuid::new_v4(), "event-draft", "appointment_created"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{draft}");
    let (status, definition) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/care-pathways/definitions",
        published(Uuid::new_v4(), "event-published", "appointment_created"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{definition}");
    let (status, active) = call(
        &router,
        &owner,
        "POST",
        &format!(
            "/api/v1/care-pathways/definitions/{}/actions",
            definition["id"].as_str().unwrap()
        ),
        json!({"action":"activate","reason":"Synthetic publish"}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{active}");
    let starts = Utc::now() + chrono::Duration::days(2);
    let booking = json!({"request_id":Uuid::new_v4(),"patient_id":patient,"clinician_id":owner.sub,"starts_at":starts,"ends_at":starts+chrono::Duration::minutes(30),"title":"Synthetic appointment","reason":"Synthetic event fixture"});
    let (status, appointment) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/appointments",
        booking.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{appointment}");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM workflow_native_starts WHERE tenant_id=$1")
            .bind(owner.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 1, "draft definitions must not receive native starts");
    suncharts_engine::workflow_triggers::tick(&db)
        .await
        .unwrap();
    suncharts_engine::workflow_triggers::tick(&db)
        .await
        .unwrap();
    let rows: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(i) FROM care_pathway_instances i WHERE tenant_id=$1")
            .bind(owner.tenant_id)
            .fetch_all(&db)
            .await
            .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["definition_id"], active["id"]);
    assert_eq!(rows[0]["definition_version"], 2);
    assert_eq!(rows[0]["patient_id"], json!(patient));
    assert_eq!(rows[0]["appointment_id"], appointment["id"]);
    let (_, replay) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/appointments",
        booking,
        None,
    )
    .await;
    assert_eq!(replay["id"], appointment["id"]);
    assert_eq!(
        suncharts_engine::workflow_triggers::tick(&db)
            .await
            .unwrap(),
        0
    );
    let other = actor(Uuid::new_v4(), Role::Owner);
    let (status, _) = call(
        &router,
        &other,
        "GET",
        &format!(
            "/api/v1/care-pathways/instances/{}",
            rows[0]["id"].as_str().unwrap()
        ),
        json!({}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let phase: String =
        sqlx::query_scalar("SELECT status FROM workflow_native_starts WHERE tenant_id=$1")
            .bind(owner.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(phase, "completed");
    let source:Value=sqlx::query_scalar("SELECT payload FROM automation_events WHERE tenant_id=$1 AND event_type='suncharts.appointment.created'").bind(owner.tenant_id).fetch_one(&db).await.unwrap();
    assert!(source.get("given_name").is_none());
    assert!(source.get("notes").is_none());
}

#[tokio::test]
async fn withdrawn_published_revision_never_starts_a_replacement_workflow() {
    let (db, owner, _, _, patient) = setup().await;
    let router = app(db.clone());
    let (_, definition) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/care-pathways/definitions",
        published(Uuid::new_v4(), "withdrawn", "appointment_created"),
        None,
    )
    .await;
    let action = format!(
        "/api/v1/care-pathways/definitions/{}/actions",
        definition["id"].as_str().unwrap()
    );
    assert_eq!(
        call(
            &router,
            &owner,
            "POST",
            &action,
            json!({"action":"activate","reason":"Synthetic publish"}),
            Some(1)
        )
        .await
        .0,
        StatusCode::OK
    );
    let starts = Utc::now() + chrono::Duration::days(3);
    let (status,body)=call(&router,&owner,"POST","/api/v1/appointments",json!({"request_id":Uuid::new_v4(),"patient_id":patient,"clinician_id":owner.sub,"starts_at":starts,"ends_at":starts+chrono::Duration::minutes(30),"reason":"Synthetic event fixture"}),None).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(
        call(
            &router,
            &owner,
            "POST",
            &action,
            json!({"action":"archive","reason":"Synthetic withdraw before event delivery"}),
            Some(2)
        )
        .await
        .0,
        StatusCode::OK
    );
    suncharts_engine::workflow_triggers::tick(&db)
        .await
        .unwrap();
    let status: String =
        sqlx::query_scalar("SELECT status FROM workflow_native_starts WHERE tenant_id=$1")
            .bind(owner.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(status, "superseded");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM care_pathway_instances WHERE tenant_id=$1")
            .bind(owner.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn public_and_partner_bookings_enqueue_once_and_preserve_partner_webhooks() {
    let (db, owner, _, _, patient) = setup().await;
    let router = app(db.clone());
    let (status, definition) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/care-pathways/definitions",
        published(Uuid::new_v4(), "booking-handoff", "appointment_created"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{definition}");
    let (status, active) = call(
        &router,
        &owner,
        "POST",
        &format!(
            "/api/v1/care-pathways/definitions/{}/actions",
            definition["id"].as_str().unwrap()
        ),
        json!({"action":"activate","reason":"Synthetic publish"}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{active}");
    sqlx::query("INSERT INTO previsit_booking_profiles(tenant_id,public_slug,enabled,default_clinician_id,duration_minutes,booking_horizon_days,available_weekdays,day_start,day_end,slot_minutes,updated_by) VALUES($1,'synthetic-event-booking',true,$2,30,30,ARRAY[1,2,3,4,5,6,7]::smallint[],'00:00','23:59',15,$2)")
        .bind(owner.tenant_id).bind(owner.sub).execute(&db).await.unwrap();
    let starts = (Utc::now() + chrono::Duration::days(2))
        .date_naive()
        .and_hms_opt(10, 0, 0)
        .unwrap()
        .and_utc();
    let public_request = json!({"request_id":Uuid::new_v4(),"given_name":"Synthetic","family_name":"Booking","birth_date":"1990-01-01","email":"booking@example.test","phone":"+1 555 010 2026","starts_at":starts});
    let mut public_appointment = Value::Null;
    for expected in [StatusCode::CREATED, StatusCode::OK] {
        // This endpoint must work without a browser session or bearer token.
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/public/v1/booking/synthetic-event-booking")
                    .header("Content-Type", "application/json")
                    .body(Body::from(public_request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(status, expected, "{body}");
        if public_appointment.is_null() {
            public_appointment = body["appointment_id"].clone();
        } else {
            assert_eq!(body["appointment_id"], public_appointment);
            assert_eq!(body["already_recorded"], true);
        }
    }
    let service = Uuid::new_v4();
    sqlx::query("INSERT INTO scheduling_services(tenant_id,id,name,clinician_id,duration_minutes,category,created_by) VALUES($1,$2,'Synthetic booking',$3,30,'Review',$3)")
        .bind(owner.tenant_id).bind(service).bind(owner.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO scheduling_webhook_subscriptions(tenant_id,id,label,endpoint,events,encrypted_signing_secret,signing_secret_hash,created_by) VALUES($1,$2,'Synthetic subscription','https://example.invalid/events',ARRAY['appointment.created'],decode('00','hex'),repeat('0',64),$3)")
        .bind(owner.tenant_id).bind(Uuid::new_v4()).bind(owner.sub).execute(&db).await.unwrap();
    let (status, hold) = call(
        &router, &owner, "POST", "/api/v1/scheduling/holds",
        json!({"request_id":Uuid::new_v4(),"service_id":service,"starts_at":starts+chrono::Duration::days(1)}), None,
    ).await;
    assert_eq!(status, StatusCode::CREATED, "{hold}");
    let partner_request = json!({"request_id":Uuid::new_v4(),"source_system":"synthetic-partner","external_reference":"synthetic-booking","hold_id":hold["id"],"patient_id":patient});
    let mut partner_appointment = Value::Null;
    for expected in [StatusCode::CREATED, StatusCode::OK] {
        let (status, body) = call(
            &router,
            &owner,
            "POST",
            "/api/v1/scheduling/appointments",
            partner_request.clone(),
            None,
        )
        .await;
        assert_eq!(status, expected, "{body}");
        if partner_appointment.is_null() {
            partner_appointment = body["appointment_id"].clone();
        } else {
            assert_eq!(body["appointment"]["id"], partner_appointment);
            assert_eq!(body["already_recorded"], true);
        }
    }
    let counts: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM automation_events WHERE tenant_id=$1 AND event_type='suncharts.appointment.created'),(SELECT count(*) FROM workflow_native_starts WHERE tenant_id=$1),(SELECT count(*) FROM scheduling_webhook_outbox WHERE tenant_id=$1 AND event_type='appointment.created')")
        .bind(owner.tenant_id).fetch_one(&db).await.unwrap();
    assert_eq!(
        counts,
        (2, 2, 1),
        "booking retries must not add event, workflow or webhook deliveries"
    );
    assert_eq!(
        suncharts_engine::workflow_triggers::tick(&db)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        suncharts_engine::workflow_triggers::tick(&db)
            .await
            .unwrap(),
        0
    );
    let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(i) FROM care_pathway_instances i WHERE tenant_id=$1 ORDER BY appointment_id")
        .bind(owner.tenant_id).fetch_all(&db).await.unwrap();
    assert_eq!(rows.len(), 2);
    for row in &rows {
        assert_eq!(row["definition_id"], active["id"]);
        assert_eq!(row["definition_version"], 2);
        assert!(
            row["appointment_id"] == public_appointment
                || row["appointment_id"] == partner_appointment
        );
        assert!(row["patient_id"].as_str().is_some());
        for private in ["given_name", "family_name", "email", "phone", "notes"] {
            assert!(row["context"].get(private).is_none());
        }
    }
    let public_actor_matches: bool = sqlx::query_scalar("SELECT e.created_by=a.patient_id FROM automation_events e JOIN appointments a ON a.tenant_id=e.tenant_id AND a.id::text=e.payload->>'appointment_id' WHERE e.tenant_id=$1 AND a.id=$2")
        .bind(owner.tenant_id).bind(Uuid::parse_str(public_appointment.as_str().unwrap()).unwrap()).fetch_one(&db).await.unwrap();
    assert!(
        public_actor_matches,
        "public event provenance stays bound to its patient"
    );
}
