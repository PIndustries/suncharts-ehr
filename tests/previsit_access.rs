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

#[tokio::test]
async fn patient_intake_history_retains_old_completed_forms_and_is_metadata_only_and_scoped() {
    let fixture = Fixture::new().await;
    fixture.configure().await;
    let patient = Uuid::new_v4();
    let other_patient = Uuid::new_v4();
    let foreign_patient = Uuid::new_v4();
    for (tenant, id) in [
        (fixture.tenant, patient),
        (fixture.tenant, other_patient),
        (Uuid::new_v4(), foreign_patient),
    ] {
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Synthetic','History','1990-01-01')")
            .bind(tenant).bind(id).bind(id.to_string()).execute(&fixture.db).await.unwrap();
    }
    let (template, template_schema): (Uuid, Value) =
        sqlx::query_as("SELECT id,schema FROM previsit_intake_templates WHERE tenant_id=$1")
            .bind(fixture.tenant)
            .fetch_one(&fixture.db)
            .await
            .unwrap();
    let mut ids = Vec::new();
    for (index, (appointment_status, status)) in [
        ("completed", "submitted"),
        ("checked_in", "reviewed"),
        ("in_progress", "sent"),
        ("booked", "void"),
        ("completed", "submitted"),
    ]
    .iter()
    .enumerate()
    {
        let appointment = Uuid::new_v4();
        let packet = Uuid::new_v4();
        let target = if index == 4 { other_patient } else { patient };
        let starts = Utc::now() - Duration::days(400 + index as i64);
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status,title) VALUES($1,$2,$3,$4,$5,$5+interval '1 hour',$6,'Synthetic historical appointment')")
            .bind(fixture.tenant).bind(appointment).bind(target).bind(fixture.user).bind(starts).bind(appointment_status).execute(&fixture.db).await.unwrap();
        sqlx::query("INSERT INTO previsit_intake_packets(tenant_id,id,appointment_id,patient_id,template_id,template_version,template_snapshot,access_token_hash,status,due_at,issued_by,submitted_at,reviewed_at,reviewed_by,created_at) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,CASE WHEN $8 IN('submitted','reviewed') THEN $9 END,CASE WHEN $8='reviewed' THEN $9 END,CASE WHEN $8='reviewed' THEN $10 END,$9)")
            .bind(fixture.tenant).bind(packet).bind(appointment).bind(target).bind(template).bind(&template_schema).bind(format!("{:x}", Sha256::digest(packet.as_bytes()))).bind(status).bind(starts).bind(fixture.user).execute(&fixture.db).await.unwrap();
        if ["submitted", "reviewed"].contains(status) {
            sqlx::query("INSERT INTO previsit_intake_responses(tenant_id,packet_id,version,response,attested_name,attested) VALUES($1,$2,1,$3,'Synthetic Patient',true)")
                .bind(fixture.tenant).bind(packet).bind(json!({"insurance_plan":"Synthetic retained answer","consent":true})).execute(&fixture.db).await.unwrap();
        }
        ids.push(packet);
    }
    let snapshot_sql = "SELECT jsonb_build_object('packets',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM previsit_intake_packets p),'responses',(SELECT jsonb_agg(to_jsonb(r) ORDER BY packet_id) FROM previsit_intake_responses r),'appointments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM appointments a))";
    let before: Value = sqlx::query_scalar(snapshot_sql)
        .fetch_one(&fixture.db)
        .await
        .unwrap();
    let path = format!("/api/v1/patients/{patient}/intake-packets");
    let (_, readiness) = fixture
        .call("GET", "/api/v1/previsit/readiness", true, None, None)
        .await;
    assert_eq!(
        readiness["items"],
        json!([]),
        "these retained forms are outside transient readiness"
    );
    let mut after = None;
    let mut seen = Vec::new();
    loop {
        let query = format!(
            "{path}?limit=1{}",
            after.map(|id| format!("&after={id}")).unwrap_or_default()
        );
        let (status, page) = fixture.call("GET", &query, true, None, None).await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(
            page["summary"],
            json!({"total":4,"submitted":1,"reviewed":1})
        );
        let item = &page["items"][0];
        assert_eq!(item["template_name"], "Synthetic intake");
        for secret in [
            "response",
            "attested_name",
            "template_snapshot",
            "access_token_hash",
            "intake_url",
        ] {
            assert!(item.get(secret).is_none(), "metadata must exclude {secret}");
        }
        seen.push(item["packet_id"].as_str().unwrap().parse::<Uuid>().unwrap());
        after = page["next_cursor"].as_str().map(str::to_owned);
        if after.is_none() {
            break;
        }
    }
    assert_eq!(seen, ids[..4]);
    let (_, first) = fixture.call("GET", &path, true, None, None).await;
    assert_eq!(first["items"][0]["appointment_status"], "completed");
    assert_eq!(first["items"][0]["has_response"], true);
    assert_eq!(first["items"][1]["appointment_status"], "checked_in");
    let detail_path = format!("/api/v1/previsit/packets/{}", ids[0]);
    let (status, detail) = fixture.call("GET", &detail_path, true, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        detail["response"]["insurance_plan"],
        "Synthetic retained answer"
    );
    assert_eq!(
        fixture.call("GET", &path, false, None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        fixture
            .call(
                "GET",
                &format!("/api/v1/patients/{foreign_patient}/intake-packets"),
                true,
                None,
                None
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    for suffix in [
        format!("?after={}", ids[4]),
        "?limit=0".into(),
        "?limit=101".into(),
    ] {
        assert_eq!(
            fixture
                .call("GET", &(path.clone() + &suffix), true, None, None)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let after: Value = sqlx::query_scalar(snapshot_sql)
        .fetch_one(&fixture.db)
        .await
        .unwrap();
    assert_eq!(
        before, after,
        "list/detail must never rewrite submitted evidence or appointments"
    );
    // A valid staff session with billing-only custom policy must not read this clinical history.
    sqlx::query("UPDATE browser_users SET role='read_only' WHERE tenant_id=$1 AND id=$2")
        .bind(fixture.tenant)
        .bind(fixture.user)
        .execute(&fixture.db)
        .await
        .unwrap();
    let policy = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Synthetic billing only','read_only',$3,$4)")
        .bind(fixture.tenant).bind(policy).bind(json!({"billing":{"view":true},"clinical":{"view":false}})).bind(fixture.user).execute(&fixture.db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$2)").bind(fixture.tenant).bind(fixture.user).bind(policy).execute(&fixture.db).await.unwrap();
    assert_eq!(
        fixture.call("GET", &path, true, None, None).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        fixture.call("GET", &detail_path, true, None, None).await.0,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE practice_access_policies SET permissions=$3,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(fixture.tenant).bind(policy).bind(json!({"clinical":{"view":true}})).execute(&fixture.db).await.unwrap();
    let allowed = fixture.call("GET", &path, true, None, None).await;
    assert_eq!(
        allowed.0,
        StatusCode::OK,
        "the documented route remains reachable for clinical-view policies: {}",
        allowed.1
    );
}

// Explicit local UI acceptance only; no provider workers or production credentials.
#[tokio::test]
#[ignore = "opt-in bounded synthetic patient intake browser fixture"]
async fn patient_contact_intake_browser_fixture() {
    use argon2::{
        password_hash::{rand_core::OsRng, SaltString},
        Argon2, PasswordHasher,
    };
    use std::{
        io::Write,
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
    };
    assert_eq!(
        std::env::var("SUNCHARTS_PATIENT_INTAKE_BROWSER").as_deref(),
        Ok("synthetic-local-only")
    );
    let url = url::Url::parse(&std::env::var("TEST_DATABASE_URL").unwrap()).unwrap();
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert_eq!(url.port(), Some(55589));
    assert_eq!(url.path(), "/claim_tracking_test");
    let fixture = Fixture::new().await;
    fixture.configure().await;
    let starts = (Utc::now() + Duration::days(2))
        .date_naive()
        .and_hms_opt(10, 0, 0)
        .unwrap()
        .and_utc();
    let (status, booked) = fixture.call("POST", "/api/public/v1/booking/synthetic-rehab", false, Some(json!({"request_id":Uuid::new_v4(),"given_name":"Synthetic","family_name":"Contact Intake","birth_date":"1990-01-01","email":"intake-patient@example.test","phone":"+1 555 010 2026","starts_at":starts})), None).await;
    assert_eq!(status, StatusCode::CREATED);
    let token = booked["intake_url"]
        .as_str()
        .unwrap()
        .split("#token=")
        .nth(1)
        .unwrap();
    let (status, _) = fixture.call("POST", "/api/public/v1/intake/submit", false, Some(json!({"token":token,"response":{"insurance_plan":"Synthetic retained plan","functional_status":"Synthetic patient reports using a mobility aid.","consent":true},"attested_name":"Synthetic Contact Intake","attested":true})), None).await;
    assert_eq!(status, StatusCode::OK);
    let patient: Uuid = sqlx::query_scalar("SELECT id FROM patients WHERE tenant_id=$1")
        .bind(fixture.tenant)
        .fetch_one(&fixture.db)
        .await
        .unwrap();
    // This isolated UI fixture intentionally represents a completed historical appointment.
    sqlx::query("UPDATE appointments SET status='completed',starts_at=now()-interval '400 days',ends_at=now()-interval '400 days'+interval '1 hour' WHERE tenant_id=$1 AND patient_id=$2").bind(fixture.tenant).bind(patient).execute(&fixture.db).await.unwrap();
    let (_, history) = fixture
        .call(
            "GET",
            &format!("/api/v1/patients/{patient}/intake-packets"),
            true,
            None,
            None,
        )
        .await;
    assert_eq!(history["summary"]["submitted"], 1);
    let baseline: Value = sqlx::query_scalar("SELECT jsonb_build_object('packet_hash',md5((SELECT row_to_json(p)::text FROM previsit_intake_packets p WHERE tenant_id=$1)),'response_hash',md5((SELECT row_to_json(r)::text FROM previsit_intake_responses r WHERE tenant_id=$1)))").bind(fixture.tenant).fetch_one(&fixture.db).await.unwrap();
    let password = Uuid::new_v4().to_string();
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .unwrap()
        .to_string();
    sqlx::query("UPDATE browser_users SET password_hash=$3 WHERE tenant_id=$1 AND id=$2")
        .bind(fixture.tenant)
        .bind(fixture.user)
        .bind(hash)
        .execute(&fixture.db)
        .await
        .unwrap();
    let origin = "http://127.0.0.1:55626";
    let router = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(fixture.db.clone())),
        secret: "unused-synthetic".into(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(fixture.db.clone(), origin.into()).unwrap()),
    });
    let directory = std::path::Path::new("/private/tmp/suncharts-patient-intake-browser");
    std::fs::create_dir_all(directory).unwrap();
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let schema: String = sqlx::query_scalar("SELECT current_schema()")
        .fetch_one(&fixture.db)
        .await
        .unwrap();
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join("browser-auth.json"))
        .unwrap();
    file.write_all(json!({"origin":origin,"email":"owner@example.test","password":password,"patient_id":patient,"tenant_id":fixture.tenant,"schema":schema,"baseline":baseline,"synthetic_only":true,"provider_calls":0}).to_string().as_bytes()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:55626")
        .await
        .unwrap();
    println!("Synthetic contact/intake fixture ready at http://127.0.0.1:55626; protected login file written.");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            tokio::time::sleep(std::time::Duration::from_secs(1800)).await;
        })
        .await
        .unwrap();
}
