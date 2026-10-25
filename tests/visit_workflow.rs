// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::Utc;
use http_body_util::BodyExt;
use jsonwebtoken::{encode, EncodingKey, Header};
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::Arc;
use suncharts_engine::{
    auth::{Actor, Role},
    postgres::PostgresBackend,
    State,
};
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &str = "synthetic-test-secret-not-for-production-123456";
fn actor(tenant: Uuid, role: Role, patient_id: Option<Uuid>) -> Actor {
    let now = Utc::now().timestamp();
    Actor {
        sub: Uuid::new_v4(),
        tenant_id: tenant,
        role,
        patient_id,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 60,
    }
}
fn token(a: &Actor) -> String {
    encode(
        &Header::default(),
        a,
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}
fn application(db: PgPool) -> Router {
    suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db)),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: None,
    })
}
async fn database() -> PgPool {
    let url = std::env::var("TEST_DATABASE_URL")
        .expect("TEST_DATABASE_URL must point at a disposable PostgreSQL database");
    let setup = PgPool::connect(&url).await.unwrap();
    let schema = format!("engine_test_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&setup)
        .await
        .unwrap();
    setup.close().await;
    let pool = PgPoolOptions::new()
        .max_connections(6)
        .after_connect(move |c, _| {
            let sql = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(&sql).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&pool).await.unwrap();
    pool
}
async fn call(
    app: &Router,
    a: Option<&Actor>,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(a) = a {
        req = req.header("authorization", format!("Bearer {}", token(a)));
    }
    if let Some(v) = version {
        req = req.header("if-match", format!("\"{v}\""));
    }
    let req = if body.is_null() {
        req.body(Body::empty()).unwrap()
    } else {
        req.header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    assert_eq!(resp.headers()["cache-control"], "no-store");
    assert!(resp.headers()["link"].to_str().unwrap().contains("/source"));
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let value =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, value)
}
fn id(v: &Value) -> Uuid {
    Uuid::parse_str(v["id"].as_str().unwrap()).unwrap()
}
fn soap() -> Value {
    json!({"subjective":"Synthetic follow-up","objective":"Well appearing","assessment":"Routine follow-up","plan":"Return in four weeks"})
}
fn vitals() -> Value {
    json!({"systolic_mm_hg":120,"diastolic_mm_hg":80,"heart_rate_bpm":72,"temperature_c":36.8,"weight_kg":70.0,"height_cm":175.0,"oxygen_saturation_pct":98.0})
}

#[tokio::test]
async fn complete_visit_is_durable_scoped_versioned_and_append_only() {
    let db = database().await;
    let app = application(db.clone());
    let tenant = Uuid::new_v4();
    let doctor = actor(tenant, Role::Clinician, None);
    let desk = actor(tenant, Role::FrontDesk, None);
    let other = actor(Uuid::new_v4(), Role::Clinician, None);
    let readonly = actor(tenant, Role::ReadOnly, None);
    let peer = actor(tenant, Role::Clinician, None);
    let new_patient = json!({"mrn":"SIM-001","given_name":"Avery","family_name":"Synthetic","birth_date":"1990-01-01"});
    assert_eq!(
        call(
            &app,
            None,
            "POST",
            "/api/v1/patients",
            new_patient.clone(),
            None
        )
        .await
        .0,
        401
    );
    let mut expired = doctor.clone();
    expired.iat -= 200;
    expired.exp -= 200;
    assert_eq!(
        call(
            &app,
            Some(&expired),
            "POST",
            "/api/v1/patients",
            new_patient.clone(),
            None
        )
        .await
        .0,
        401
    );
    let mut wrong_audience = doctor.clone();
    wrong_audience.aud = "another-service".into();
    assert_eq!(
        call(
            &app,
            Some(&wrong_audience),
            "POST",
            "/api/v1/patients",
            new_patient.clone(),
            None
        )
        .await
        .0,
        401
    );
    assert_eq!(
        call(
            &app,
            Some(&readonly),
            "POST",
            "/api/v1/patients",
            new_patient.clone(),
            None
        )
        .await
        .0,
        403
    );
    let (status, p) = call(
        &app,
        Some(&desk),
        "POST",
        "/api/v1/patients",
        new_patient.clone(),
        None,
    )
    .await;
    assert_eq!(status, 201, "{p}");
    let patient = id(&p);
    assert_eq!(
        call(
            &app,
            Some(&desk),
            "POST",
            "/api/v1/patients",
            new_patient.clone(),
            None
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(
            &app,
            Some(&other),
            "GET",
            &format!("/api/v1/patients/{patient}"),
            Value::Null,
            None
        )
        .await
        .0,
        404
    );
    let (status, _) = call(
        &app,
        Some(&other),
        "POST",
        "/api/v1/patients",
        new_patient,
        None,
    )
    .await;
    assert_eq!(status, 201, "MRNs are tenant-local");
    let patient_actor = actor(tenant, Role::Patient, Some(patient));
    let wrong_patient = actor(tenant, Role::Patient, Some(Uuid::new_v4()));
    assert_eq!(
        call(
            &app,
            Some(&patient_actor),
            "GET",
            &format!("/api/v1/patients/{patient}"),
            Value::Null,
            None
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(
            &app,
            Some(&wrong_patient),
            "GET",
            "/api/v1/portal/record",
            Value::Null,
            None
        )
        .await
        .0,
        404
    );
    let booking = json!({"patient_id":patient,"clinician_id":doctor.sub,"starts_at":"2026-11-01T15:00:00Z","ends_at":"2026-11-01T15:30:00Z"});
    let mut wrong_booking = booking.clone();
    wrong_booking["patient_id"] = json!(Uuid::new_v4());
    assert_eq!(
        call(
            &app,
            Some(&desk),
            "POST",
            "/api/v1/appointments",
            wrong_booking,
            None
        )
        .await
        .0,
        404
    );
    let (status, appointment) = call(
        &app,
        Some(&desk),
        "POST",
        "/api/v1/appointments",
        booking.clone(),
        None,
    )
    .await;
    assert_eq!(status, 201, "{appointment}");
    let appointment = id(&appointment);
    assert_eq!(
        call(
            &app,
            Some(&desk),
            "POST",
            "/api/v1/appointments",
            booking,
            None
        )
        .await
        .0,
        409
    );
    let start = json!({"appointment_id":appointment});
    assert_eq!(
        call(
            &app,
            Some(&doctor),
            "POST",
            "/api/v1/visits",
            start.clone(),
            None
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(
            &app,
            Some(&desk),
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
        call(
            &app,
            Some(&peer),
            "POST",
            "/api/v1/visits",
            start.clone(),
            None
        )
        .await
        .0,
        403
    );
    let (status, v) = call(&app, Some(&doctor), "POST", "/api/v1/visits", start, None).await;
    assert_eq!(status, 201, "{v}");
    let visit = id(&v);
    let path = format!("/api/v1/visits/{visit}");
    assert_eq!(v["version"], 1);
    assert_eq!(
        call(&app, Some(&other), "GET", &path, Value::Null, None)
            .await
            .0,
        404
    );
    let (_, portal) = call(
        &app,
        Some(&patient_actor),
        "GET",
        "/api/v1/portal/record",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(
        portal["visits"],
        json!([]),
        "drafts must not reach patients"
    );
    assert_eq!(
        call(
            &app,
            Some(&doctor),
            "POST",
            &format!("{path}/sign"),
            Value::Null,
            Some(1)
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(
            &app,
            Some(&desk),
            "PUT",
            &format!("{path}/note"),
            soap(),
            Some(1)
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(
            &app,
            Some(&peer),
            "PUT",
            &format!("{path}/note"),
            soap(),
            Some(1)
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(
            &app,
            Some(&doctor),
            "PUT",
            &format!("{path}/note"),
            soap(),
            None
        )
        .await
        .0,
        428
    );
    let mut invalid = vitals();
    invalid["temperature_c"] = json!(90);
    assert_eq!(
        call(
            &app,
            Some(&doctor),
            "PUT",
            &format!("{path}/vitals"),
            invalid,
            Some(1)
        )
        .await
        .0,
        400
    );
    let (status, v) = call(
        &app,
        Some(&doctor),
        "PUT",
        &format!("{path}/vitals"),
        vitals(),
        Some(1),
    )
    .await;
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["version"], 2);
    assert_eq!(
        call(
            &app,
            Some(&doctor),
            "PUT",
            &format!("{path}/note"),
            soap(),
            Some(1)
        )
        .await
        .0,
        409
    );
    // Two simultaneous edits with one version: exactly one succeeds.
    let p = format!("{path}/note");
    let (left, right) = tokio::join!(
        call(&app, Some(&doctor), "PUT", &p, soap(), Some(2)),
        call(&app, Some(&doctor), "PUT", &p, soap(), Some(2))
    );
    let mut statuses = [left.0.as_u16(), right.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    // An audit failure must roll back signing AND appointment completion.
    sqlx::raw_sql("CREATE FUNCTION fail_sign_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='visit.sign' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_sign BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_sign_audit();").execute(&db).await.unwrap();
    assert_eq!(
        call(
            &app,
            Some(&doctor),
            "POST",
            &format!("{path}/sign"),
            Value::Null,
            Some(3)
        )
        .await
        .0,
        500
    );
    let state: String =
        sqlx::query_scalar("SELECT status FROM appointments WHERE tenant_id=$1 AND id=$2")
            .bind(tenant)
            .bind(appointment)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(state, "in_progress");
    sqlx::query("DROP TRIGGER fail_sign ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    let (status, signed) = call(
        &app,
        Some(&doctor),
        "POST",
        &format!("{path}/sign"),
        Value::Null,
        Some(3),
    )
    .await;
    assert_eq!(status, 200, "{signed}");
    assert_eq!(signed["status"], "signed");
    assert_eq!(signed["signed_by"], json!(doctor.sub));
    assert_eq!(signed["version"], 4);
    assert_eq!(
        call(
            &app,
            Some(&doctor),
            "PUT",
            &format!("{path}/note"),
            soap(),
            Some(4)
        )
        .await
        .0,
        409
    );
    let amendment =
        json!({"reason":"Correct transcription","text":"Follow-up interval is six weeks."});
    let (status, amended) = call(
        &app,
        Some(&doctor),
        "POST",
        &format!("{path}/amendments"),
        amendment,
        Some(4),
    )
    .await;
    assert_eq!(status, 200, "{amended}");
    assert_eq!(amended["note"], signed["note"]);
    assert_eq!(amended["version"], 5);
    // New service instance reads the durable signed record, including the attributed correction.
    let restarted = application(db.clone());
    let (status, portal) = call(
        &restarted,
        Some(&patient_actor),
        "GET",
        "/api/v1/portal/record",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, 200, "{portal}");
    assert_eq!(portal["visits"][0]["note"], soap());
    assert_eq!(portal["amendments"][0]["author_id"], json!(doctor.sub));
    assert_eq!(portal["amendments"][0]["reason"], "Correct transcription");
    let mutation = sqlx::query("UPDATE visits SET note='{}' WHERE tenant_id=$1 AND id=$2")
        .bind(tenant)
        .bind(visit)
        .execute(&db)
        .await;
    assert!(
        mutation.is_err(),
        "database must also reject signed content edits"
    );
    assert!(sqlx::query("DELETE FROM amendments WHERE tenant_id=$1")
        .bind(tenant)
        .execute(&db)
        .await
        .is_err());
    assert!(sqlx::query("DELETE FROM audit_events WHERE tenant_id=$1")
        .bind(tenant)
        .execute(&db)
        .await
        .is_err());
    let signed_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='visit.sign'",
    )
    .bind(tenant)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(signed_audits, 1);
    let response = restarted
        .oneshot(
            Request::builder()
                .uri("/source")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "application/gzip");
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert!(bytes.len() > 1000);
    db.close().await;
}

#[test]
fn api_contract_defines_the_complete_visit() {
    let spec: Value = serde_json::from_str(include_str!("../api/openapi.json")).unwrap();
    assert_eq!(spec["info"]["license"]["identifier"], "Apache-2.0");
    for p in [
        "/api/v1/patients",
        "/api/v1/appointments",
        "/api/v1/visits",
        "/api/v1/visits/{id}/sign",
        "/api/v1/visits/{id}/amendments",
        "/api/v1/portal/record",
    ] {
        assert!(spec["paths"][p].is_object());
    }
}

#[tokio::test]
async fn standalone_browser_sessions_require_origin_and_revoke_on_logout() {
    use argon2::{
        password_hash::{rand_core::OsRng, SaltString},
        Argon2, PasswordHasher,
    };
    let db = database().await;
    let user = Uuid::new_v4();
    let tenant = Uuid::new_v4();
    let hash = Argon2::default()
        .hash_password(
            b"synthetic-browser-test-password",
            &SaltString::generate(&mut OsRng),
        )
        .unwrap()
        .to_string();
    sqlx::query("INSERT INTO browser_users (id,tenant_id,email,password_hash,role) VALUES ($1,$2,'clinician@example.test',$3,'clinician')")
        .bind(user).bind(tenant).bind(hash).execute(&db).await.unwrap();
    let origin = "http://127.0.0.1:8090";
    let router = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(
            suncharts_engine::browser::BrowserAuth::new(db.clone(), origin.into()).unwrap(),
        ),
    });
    let request = |path: &str, method: &str, origin: &str, cookie: &str, body: Value| {
        Request::builder()
            .uri(path)
            .method(method)
            .header("origin", origin)
            .header("cookie", cookie)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let login =
        json!({"email":"clinician@example.test","password":"synthetic-browser-test-password"});
    assert_eq!(
        router
            .clone()
            .oneshot(request(
                "/auth/login",
                "POST",
                "https://untrusted.example",
                "",
                login.clone()
            ))
            .await
            .unwrap()
            .status(),
        403
    );
    let response = router
        .clone()
        .oneshot(request("/auth/login", "POST", origin, "", login))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let header = response.headers()["set-cookie"].to_str().unwrap();
    assert!(header.contains("HttpOnly"));
    assert!(header.contains("SameSite=Strict"));
    let cookie = header.split(';').next().unwrap().to_owned();
    let me = router
        .clone()
        .oneshot(request("/auth/me", "GET", origin, &cookie, Value::Null))
        .await
        .unwrap();
    assert_eq!(me.status(), 200);
    let who: Value =
        serde_json::from_slice(&me.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(who["user_id"], json!(user));
    assert_eq!(who["tenant_id"], json!(tenant));
    let patient = json!({"mrn":"WEB-001","given_name":"Taylor","family_name":"Synthetic","birth_date":"1992-05-01"});
    assert_eq!(
        router
            .clone()
            .oneshot(request(
                "/api/v1/patients",
                "POST",
                "https://untrusted.example",
                &cookie,
                patient.clone()
            ))
            .await
            .unwrap()
            .status(),
        403
    );
    let created = router
        .clone()
        .oneshot(request(
            "/api/v1/patients",
            "POST",
            origin,
            &cookie,
            patient,
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), 201);
    let created: Value =
        serde_json::from_slice(&created.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let response = router
        .clone()
        .oneshot(request(
            &format!(
                "/api/v1/patients/{}/workspace",
                created["id"].as_str().unwrap()
            ),
            "GET",
            origin,
            &cookie,
            Value::Null,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let list = router
        .clone()
        .oneshot(request(
            "/api/v1/patients",
            "GET",
            origin,
            &cookie,
            Value::Null,
        ))
        .await
        .unwrap();
    assert_eq!(list.status(), 200);
    let list: Value =
        serde_json::from_slice(&list.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    let response = router
        .clone()
        .oneshot(request(
            "/auth/logout",
            "POST",
            origin,
            &cookie,
            Value::Null,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        router
            .clone()
            .oneshot(request("/auth/me", "GET", origin, &cookie, Value::Null))
            .await
            .unwrap()
            .status(),
        401
    );
    let gui = router
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(gui.status(), 200);
    db.close().await;
}

#[tokio::test]
async fn gateway_rejects_malformed_time_claims_and_requires_explicit_enablement() {
    let db = database().await;
    let app = application(db.clone());
    let a = actor(Uuid::new_v4(), Role::Clinician, None);
    let base = serde_json::to_value(a).unwrap();
    async fn status(app: &Router, claims: &Value) -> StatusCode {
        let token = encode(
            &Header::default(),
            claims,
            &EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/patients")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
    }
    assert_eq!(status(&app, &base).await, StatusCode::OK);
    for nbf in [
        json!("99999999999"),
        json!(true),
        json!([]),
        json!({}),
        Value::Null,
        json!(-1),
        json!(Utc::now().timestamp() + 3600),
    ] {
        let mut claims = base.clone();
        claims["nbf"] = nbf;
        assert_eq!(status(&app, &claims).await, StatusCode::UNAUTHORIZED);
    }
    let mut past = base.clone();
    past["nbf"] = json!(Utc::now().timestamp() - 5);
    assert_eq!(status(&app, &past).await, StatusCode::OK);
    for exp in [Value::Null, json!("99999999999"), json!(true), json!({})] {
        let mut claims = base.clone();
        claims["exp"] = exp;
        assert_eq!(status(&app, &claims).await, StatusCode::UNAUTHORIZED);
    }
    let mut missing = base.clone();
    missing.as_object_mut().unwrap().remove("exp");
    assert_eq!(status(&app, &missing).await, StatusCode::UNAUTHORIZED);
    let disabled = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: None,
    });
    assert_eq!(status(&disabled, &base).await, StatusCode::UNAUTHORIZED);
    db.close().await;
}
