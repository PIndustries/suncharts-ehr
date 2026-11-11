// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
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
const SECRET: &str = "synthetic-lifecycle-test-secret";
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
async fn setup() -> (PgPool, Actor, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("lifecycle_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(5)
        .after_connect(move |c, _| {
            let q = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(&q).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let now = Utc::now().timestamp();
    let a = Actor {
        sub: Uuid::new_v4(),
        tenant_id: Uuid::new_v4(),
        role: Role::Owner,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    };
    let p = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-CONTACT','Avery','Synthetic','1990-01-01')").bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    (db, a, p)
}
async fn call(
    r: &Router,
    a: &Actor,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        a,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let mut q = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        q = q.header("If-Match", format!("\"{v}\""));
    }
    let response = r
        .clone()
        .oneshot(q.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn change(archived: bool) -> Value {
    json!({"archived":archived,"reason":"Synthetic lifecycle review"})
}
async fn lifecycle(
    r: &Router,
    a: &Actor,
    p: Uuid,
    method: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    call(
        r,
        a,
        method,
        &format!("/api/v1/patients/{p}/lifecycle"),
        body,
        version,
    )
    .await
}
async fn rows(db: &PgPool, table: &str) -> Value {
    sqlx::query_scalar(&format!(
        "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM {table} t"
    ))
    .fetch_one(db)
    .await
    .unwrap()
}
#[tokio::test]
async fn archive_restore_preserves_chart_history_and_filters_only_the_directory() {
    let (db, a, p) = setup().await;
    let r = app(db.clone());
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-OTHER','Another','Synthetic','1995-01-01')").bind(a.tenant_id).bind(other).execute(&db).await.unwrap();
    let appointment = Uuid::new_v4();
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-11-11T14:00:00Z','2026-11-11T14:30:00Z','completed')").bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed','{\"subjective\":\"Synthetic signed note\",\"objective\":\"Original\",\"assessment\":\"Original\",\"plan\":\"Original\"}',$5,now())").bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub).execute(&db).await.unwrap();
    let account = Uuid::new_v4();
    sqlx::query("INSERT INTO billing_accounts(tenant_id,id,patient_id,visit_id,content,total_cents,status,request_id,creation_hash) VALUES($1,$2,$3,$4,'{}',10000,'posted',$5,'synthetic-lifecycle')").bind(a.tenant_id).bind(account).bind(p).bind(visit).bind(Uuid::new_v4()).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id) VALUES($1,$2,$3,'payment',-2000,'{}',$4,'synthetic-payment',$5)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(account).bind(Uuid::new_v4()).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO patient_documents(tenant_id,id,patient_id,request_id,create_request,content,filename,content_type,bytes,sha256,size_bytes,uploaded_by,updated_by) VALUES($1,$2,$3,$4,'{}','{\"status\":\"active\",\"title\":\"Synthetic original\",\"category\":\"other\"}','synthetic.pdf','application/pdf',$5,encode(sha256($5),'hex'),octet_length($5),$6,$6)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(p).bind(Uuid::new_v4()).bind(b"%PDF-1.4 synthetic original".as_slice()).bind(a.sub).execute(&db).await.unwrap();
    let financial_and_files = [
        rows(&db, "billing_accounts").await,
        rows(&db, "billing_entries").await,
        rows(&db, "patient_documents").await,
    ];
    let before = [
        rows(&db, "patients").await,
        rows(&db, "appointments").await,
        rows(&db, "visits").await,
    ];
    let (status, initial) = lifecycle(&r, &a, p, "GET", Value::Null, None).await;
    assert_eq!(status, 200);
    assert_eq!(initial["version"], 1);
    assert_eq!(initial["archived"], false);
    let (status, saved) = lifecycle(&r, &a, p, "PUT", change(true), Some(1)).await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["version"], 2);
    assert_eq!(saved["history"][0]["actor_id"], a.sub.to_string());
    let (_, active) = call(&r, &a, "GET", "/api/v1/patients", Value::Null, None).await;
    assert_eq!(active["items"].as_array().unwrap().len(), 1);
    assert_eq!(active["items"][0]["id"], other.to_string());
    let (_, archived) = call(
        &r,
        &a,
        "GET",
        "/api/v1/patients?status=archived",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(archived["items"][0]["id"], p.to_string());
    assert_eq!(archived["items"][0]["archived"], true);
    let (_, all) = call(
        &r,
        &a,
        "GET",
        "/api/v1/patients?status=all",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(all["items"].as_array().unwrap().len(), 2);
    let (status, chart) = call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/patients/{p}/workspace"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(chart["patient"]["archived"], true);
    assert_eq!(chart["visits"][0]["id"], visit.to_string());
    assert_eq!(chart["visits"][0]["status"], "signed");
    let (status, saved) = lifecycle(&r, &a, p, "PUT", change(false), Some(2)).await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["version"], 3);
    assert_eq!(saved["archived"], false);
    assert_eq!(saved["history"].as_array().unwrap().len(), 2);
    assert_eq!(
        before,
        [
            rows(&db, "patients").await,
            rows(&db, "appointments").await,
            rows(&db, "visits").await
        ]
    );
    assert_eq!(
        financial_and_files,
        [
            rows(&db, "billing_accounts").await,
            rows(&db, "billing_entries").await,
            rows(&db, "patient_documents").await
        ]
    );
    assert!(
        sqlx::query("UPDATE patient_lifecycle_events SET reason='rewrite'")
            .execute(&db)
            .await
            .is_err()
    );
    assert!(sqlx::query("DELETE FROM patient_lifecycle_events")
        .execute(&db)
        .await
        .is_err());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM audit_events WHERE action IN ('patient.archived','patient.restored')").fetch_one(&db).await.unwrap(),2);
}
#[tokio::test]
async fn lifecycle_requires_scoped_authority_reason_and_fresh_version_with_atomic_audit() {
    let (db, a, p) = setup().await;
    let r = app(db.clone());
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        lifecycle(&r, &other, p, "PUT", change(true), Some(1))
            .await
            .0,
        404
    );
    for role in [
        Role::ReadOnly,
        Role::Nurse,
        Role::MedicalAssistant,
        Role::Patient,
        Role::PartnerSupport,
    ] {
        let mut restricted = a.clone();
        restricted.role = role;
        assert!(matches!(
            lifecycle(&r, &restricted, p, "PUT", change(true), Some(1))
                .await
                .0
                .as_u16(),
            401 | 403
        ));
    }
    assert_eq!(lifecycle(&r, &a, p, "PUT", change(true), None).await.0, 428);
    for reason in ["", "   ", "reason\ncontrol"] {
        assert_eq!(
            lifecycle(
                &r,
                &a,
                p,
                "PUT",
                json!({"archived":true,"reason":reason}),
                Some(1)
            )
            .await
            .0,
            400
        );
    }
    let (one, two) = tokio::join!(
        lifecycle(&r, &a, p, "PUT", change(true), Some(1)),
        lifecycle(&r, &a, p, "PUT", change(true), Some(1))
    );
    let mut statuses = [one.0.as_u16(), two.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    assert_eq!(
        lifecycle(&r, &a, p, "PUT", change(false), Some(1)).await.0,
        409
    );
    sqlx::query("CREATE FUNCTION reject_lifecycle_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.restored' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_lifecycle_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_audit()").execute(&db).await.unwrap();
    assert_eq!(
        lifecycle(&r, &a, p, "PUT", change(false), Some(2)).await.0,
        500
    );
    let (_, data) = lifecycle(&r, &a, p, "GET", Value::Null, None).await;
    assert_eq!(data["version"], 2);
    assert_eq!(data["archived"], true);
    assert_eq!(data["history"].as_array().unwrap().len(), 1);
    let mut clerk = a.clone();
    clerk.role = Role::FrontDesk;
    clerk.sub = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'synthetic-clerk@example.test','not-login','front_desk')").bind(a.tenant_id).bind(clerk.sub).execute(&db).await.unwrap();
    let policy = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Synthetic limited','front_desk','{\"clinical\":{\"view\":true,\"create\":true,\"edit\":false}}',$3)").bind(a.tenant_id).bind(policy).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query(
        "INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$2)",
    )
    .bind(a.tenant_id)
    .bind(clerk.sub)
    .bind(policy)
    .execute(&db)
    .await
    .unwrap();
    let (status, data) = lifecycle(&r, &clerk, p, "GET", Value::Null, None).await;
    assert_eq!(status, 200);
    assert_eq!(data["can_manage"], false);
    assert_eq!(
        lifecycle(&r, &clerk, p, "PUT", change(false), Some(2))
            .await
            .0,
        403
    );
}
#[tokio::test]
async fn archived_patient_blocks_new_work_but_not_existing_appointment_recovery() {
    let (db, a, p) = setup().await;
    let r = app(db.clone());
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'synthetic-owner@example.test','not-login','owner')").bind(a.tenant_id).bind(a.sub).execute(&db).await.unwrap();
    let request = Uuid::new_v4();
    let booking = json!({"request_id":request,"patient_id":p,"clinician_id":a.sub,"starts_at":"2026-11-12T14:00:00Z","ends_at":"2026-11-12T14:30:00Z"});
    let (status, booked) = call(
        &r,
        &a,
        "POST",
        "/api/v1/appointments",
        booking.clone(),
        None,
    )
    .await;
    assert_eq!(status, 201, "{booked}");
    let appointment = booked["id"].as_str().unwrap();
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &format!("/api/v1/appointments/{appointment}/check-in"),
            Value::Null,
            None
        )
        .await
        .0,
        200
    );
    assert_eq!(
        lifecycle(&r, &a, p, "PUT", change(true), Some(1)).await.0,
        200
    );
    let (status, retry) = call(
        &r,
        &a,
        "POST",
        "/api/v1/appointments",
        booking.clone(),
        None,
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(retry["id"], booked["id"]);
    let mut next = booking;
    next["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        call(&r, &a, "POST", "/api/v1/appointments", next, None)
            .await
            .0,
        409
    );
    let (status, error) = call(
        &r,
        &a,
        "POST",
        "/api/v1/visits",
        json!({"appointment_id":appointment}),
        None,
    )
    .await;
    assert_eq!(status, 409);
    assert!(error["message"].as_str().unwrap().contains("archived"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM visits")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        lifecycle(&r, &a, p, "PUT", change(false), Some(2)).await.0,
        200
    );
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            "/api/v1/visits",
            json!({"appointment_id":appointment}),
            None
        )
        .await
        .0,
        201
    );
}
#[tokio::test]
async fn existing_encounter_can_be_completed_after_archive_without_reopening_registration() {
    let (db, a, p) = setup().await;
    let r = app(db.clone());
    let appointment = Uuid::new_v4();
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-11-12T14:00:00Z','2026-11-12T14:30:00Z','in_progress')").bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id) VALUES($1,$2,$3,$4,$5)").bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub).execute(&db).await.unwrap();
    assert_eq!(
        lifecycle(&r, &a, p, "PUT", change(true), Some(1)).await.0,
        200
    );
    let(status,note)=call(&r,&a,"PUT",&format!("/api/v1/visits/{visit}/note"),json!({"subjective":"Synthetic existing encounter","objective":"Recorded","assessment":"Recorded","plan":"Complete existing care"}),Some(1)).await;
    assert_eq!(status, 200, "{note}");
    let (status, signed) = call(
        &r,
        &a,
        "POST",
        &format!("/api/v1/visits/{visit}/sign"),
        Value::Null,
        Some(2),
    )
    .await;
    assert_eq!(status, 200, "{signed}");
    assert_eq!(signed["status"], "signed");
    assert_eq!(
        lifecycle(&r, &a, p, "GET", Value::Null, None).await.1["archived"],
        true
    );
    assert_eq!(call(&r,&a,"PUT",&format!("/api/v1/visits/{visit}/note"),json!({"subjective":"Attempt rewrite","objective":"Recorded","assessment":"Recorded","plan":"Recorded"}),Some(3)).await.0,409);
}
