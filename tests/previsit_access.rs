// SPDX-License-Identifier: AGPL-3.0-only
//! Synthetic public-booking and patient-intake acceptance journey.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::{Duration, Utc};
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
    user: Uuid,
    cookie: String,
}
impl Fixture {
    async fn new() -> Self {
        let url =
            std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
        let initial = PgPool::connect(&url).await.unwrap();
        let schema = format!("previsit_{}", Uuid::new_v4().simple());
        suncharts_engine::test_db::create_schema(&initial, &schema).await;
        initial.close().await;
        let db = PgPoolOptions::new()
            .max_connections(8)
            .after_connect(move |connection, _| {
                let sql = format!("SET search_path TO {schema}");
                Box::pin(async move {
                    sqlx::query(&sql).execute(connection).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        suncharts_engine::MIGRATOR.run(&db).await.unwrap();
        let tenant = Uuid::new_v4();
        let user = Uuid::new_v4();
        sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,display_name) VALUES($1,$2,'owner@example.test','unused','owner','Synthetic Owner')").bind(user).bind(tenant).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO practice_providers(tenant_id,id,display_name,specialty) VALUES($1,$2,'Synthetic Clinician','Rehabilitation')").bind(tenant).bind(user).execute(&db).await.unwrap();
        let token = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(format!("{:x}",Sha256::digest(token.as_bytes()))).bind(tenant).bind(user).execute(&db).await.unwrap();
        let app = suncharts_engine::app(State {
            backend: Arc::new(PostgresBackend(db.clone())),
            secret: "unused-synthetic".into(),
            allow_legacy_gateway: false,
            issuer: "suncharts".into(),
            audience: "suncharts-engine".into(),
            browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
        });
        Self {
            db,
            app,
            tenant,
            user,
            cookie: format!("sce_session={token}"),
        }
    }
    async fn call(
        &self,
        method: &str,
        path: &str,
        staff: bool,
        body: Option<Value>,
        version: Option<i64>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("Origin", ORIGIN);
        if staff {
            request = request.header("Cookie", &self.cookie);
        }
        if let Some(v) = version {
            request = request.header("If-Match", format!("\"{v}\""));
        }
        let data = if let Some(value) = body {
            request = request.header("Content-Type", "application/json");
            value.to_string()
        } else {
            String::new()
        };
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::from(data)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(json!({})))
    }
    async fn configure(&self) {
        let schema = json!({"attestation":"I confirm these synthetic answers.","sections":[{"label":"Patient details","fields":[{"key":"insurance_plan","label":"Insurance plan","type":"text","required":true},{"key":"functional_status","label":"Functional status","type":"textarea","required":true},{"key":"consent","label":"Consent","type":"checkbox","required":true}]}]});
        assert_eq!(self.call("POST","/api/v1/previsit/templates",true,Some(json!({"id":null,"name":"Synthetic intake","schema":schema,"active":true,"reason":"Synthetic acceptance setup"})),Some(0)).await.0,StatusCode::CREATED);
        assert_eq!(self.call("PUT","/api/v1/previsit/settings",true,Some(json!({"public_slug":"synthetic-rehab","enabled":true,"default_clinician_id":self.user,"appointment_title":"New rehabilitation visit","appointment_category":"New patient","duration_minutes":60,"booking_horizon_days":30,"booking_timezone":"UTC","available_weekdays":[1,2,3,4,5,6,7],"day_start":"00:00:00","day_end":"23:59:00","slot_minutes":15,"welcome_text":"Synthetic booking page","reason":"Synthetic acceptance setup"})),Some(0)).await.0,StatusCode::OK);
    }
}

#[tokio::test]
async fn public_booking_assigns_mrn_intake_and_staff_readiness_with_audited_review() {
    let fixture = Fixture::new().await;
    fixture.configure().await;
    let (profile_status, profile) = fixture
        .call(
            "GET",
            "/api/public/v1/booking/synthetic-rehab",
            false,
            None,
            None,
        )
        .await;
    assert_eq!(profile_status, StatusCode::OK);
    assert_eq!(profile["provider_name"], "Synthetic Clinician");
    let starts = (Utc::now() + Duration::days(2))
        .date_naive()
        .and_hms_opt(10, 0, 0)
        .unwrap()
        .and_utc();
    let request_id = Uuid::new_v4();
    let (status,booking)=fixture.call("POST","/api/public/v1/booking/synthetic-rehab",false,Some(json!({"request_id":request_id,"given_name":"Synthetic","family_name":"Patient","birth_date":"1990-01-01","email":"patient@example.test","phone":"+1 555 010 2026","starts_at":starts})),None).await;
    assert_eq!(status, StatusCode::CREATED, "{booking}");
    let assigned_mrn: String = sqlx::query_scalar("SELECT mrn FROM patients WHERE tenant_id=$1")
        .bind(fixture.tenant)
        .fetch_one(&fixture.db)
        .await
        .unwrap();
    assert!(assigned_mrn.starts_with("SC-"));
    let intake = booking["intake_url"].as_str().unwrap();
    let token = intake.split("#token=").nth(1).unwrap();
    let (packet_status, packet) = fixture
        .call(
            "POST",
            "/api/public/v1/intake/read",
            false,
            Some(json!({"token":token})),
            None,
        )
        .await;
    assert_eq!(packet_status, StatusCode::OK);
    assert_eq!(packet["status"], "sent");
    let (submit_status,submitted)=fixture.call("POST","/api/public/v1/intake/submit",false,Some(json!({"token":token,"response":{"insurance_plan":"Synthetic Plan","functional_status":"Uses a synthetic mobility aid","consent":true},"attested_name":"Synthetic Patient","attested":true})),None).await;
    assert_eq!(submit_status, StatusCode::OK, "{submitted}");
    assert_eq!(submitted["version"], 2);
    let (ready_status, ready) = fixture
        .call("GET", "/api/v1/previsit/readiness", true, None, None)
        .await;
    assert_eq!(ready_status, StatusCode::OK);
    assert_eq!(ready["items"][0]["status"], "submitted");
    let packet_id = ready["items"][0]["packet_id"].as_str().unwrap();
    let (review_status, review) = fixture
        .call(
            "POST",
            &format!("/api/v1/previsit/packets/{packet_id}/review"),
            true,
            Some(json!({})),
            Some(2),
        )
        .await;
    assert_eq!(review_status, StatusCode::OK, "{review}");
    assert_eq!(review["status"], "reviewed");
    let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM patients WHERE tenant_id=$1),(SELECT count(*) FROM previsit_intake_responses WHERE tenant_id=$1),(SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action IN('appointment.public_booked','previsit.packet_review'))").bind(fixture.tenant).fetch_one(&fixture.db).await.unwrap();
    assert_eq!(counts, (1, 1, 2));
}

#[tokio::test]
async fn public_booking_is_idempotent_rejects_conflicts_and_never_merges_identity() {
    let fixture = Fixture::new().await;
    fixture.configure().await;
    let starts = (Utc::now() + Duration::days(3))
        .date_naive()
        .and_hms_opt(10, 0, 0)
        .unwrap()
        .and_utc();
    let request_id = Uuid::new_v4();
    let body = json!({"request_id":request_id,"given_name":"Synthetic","family_name":"Patient","birth_date":"1991-02-03","email":"patient2@example.test","phone":"+1 555 010 3030","starts_at":starts});
    assert_eq!(
        fixture
            .call(
                "POST",
                "/api/public/v1/booking/synthetic-rehab",
                false,
                Some(body.clone()),
                None
            )
            .await
            .0,
        StatusCode::CREATED
    );
    let replay = fixture
        .call(
            "POST",
            "/api/public/v1/booking/synthetic-rehab",
            false,
            Some(body.clone()),
            None,
        )
        .await;
    assert_eq!(replay.0, StatusCode::OK);
    assert_eq!(replay.1["already_recorded"], true);
    let mut changed = body;
    changed["given_name"] = json!("Changed");
    assert_eq!(
        fixture
            .call(
                "POST",
                "/api/public/v1/booking/synthetic-rehab",
                false,
                Some(changed),
                None
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let off_cadence = starts + Duration::minutes(7);
    let unoffered = json!({"request_id":Uuid::new_v4(),"given_name":"Other","family_name":"Patient","birth_date":"1992-03-04","email":"other@example.test","phone":"+1 555 010 4040","starts_at":off_cadence});
    assert_eq!(
        fixture
            .call(
                "POST",
                "/api/public/v1/booking/synthetic-rehab",
                false,
                Some(unoffered),
                None
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let patients: i64 = sqlx::query_scalar("SELECT count(*) FROM patients WHERE tenant_id=$1")
        .bind(fixture.tenant)
        .fetch_one(&fixture.db)
        .await
        .unwrap();
    assert_eq!(patients, 1);
}
