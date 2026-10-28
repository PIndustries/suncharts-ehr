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
const SECRET: &str = "synthetic-reminder-test-secret";
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
async fn setup() -> (PgPool, Actor, Uuid, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("connect_services_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(6)
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
    user(&db, &a, a.sub, "owner", false).await;
    let p = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-REMINDER','Avery','Synthetic','1990-01-01')").bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    sqlx::query(
        "INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,$3)",
    )
    .bind(a.tenant_id)
    .bind(p)
    .bind(json!({"email":"synthetic@example.test","phone":"555-0100"}))
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,now()+interval '48 hours',now()+interval '48 hours 30 minutes','booked')").bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(&db).await.unwrap();
    (db, a, p, appointment)
}
async fn user(db: &PgPool, a: &Actor, id: Uuid, role: &str, disabled: bool) {
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login',$4,$5)").bind(id).bind(a.tenant_id).bind(format!("{}@example.test",id.simple())).bind(role).bind(disabled).execute(db).await.unwrap();
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
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        request = request.header("If-Match", format!("\"{v}\""));
    }
    let response = r
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&body)
            .unwrap_or_else(|_| json!({"message":String::from_utf8_lossy(&body)})),
    )
}
struct Transport(std::sync::Mutex<Vec<String>>);
#[async_trait::async_trait]
impl suncharts_engine::reminders::EmailTransport for Transport {
    async fn send(
        &self,
        key: &str,
        payload: &Value,
        idempotency: &str,
    ) -> suncharts_engine::reminders::SendResult {
        self.0.lock().unwrap().push(key.into());
        assert!(payload.get("starts_at").is_some());
        assert!(!payload.to_string().contains("Avery"));
        suncharts_engine::reminders::SendResult::Accepted(
            Uuid::parse_str(idempotency.strip_prefix("suncharts-reminder-").unwrap()).unwrap(),
        )
    }
    async fn delivery(
        &self,
        key: &str,
        _: Uuid,
        _: &str,
        from: &str,
    ) -> suncharts_engine::error::Result<suncharts_engine::reminders::DeliveryResult> {
        self.0.lock().unwrap().push(key.into());
        assert_eq!(from, "SunCharts <appointments@suncharts.app>");
        Ok(suncharts_engine::reminders::DeliveryResult::Delivered)
    }
}
#[tokio::test]
async fn encrypted_service_setup_and_managed_receipt_remains_pinned_after_mode_change() {
    let keydir = std::env::temp_dir().join(format!("connect-service-key-{}", Uuid::new_v4()));
    std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", keydir.join("master.key"));
    let (db, a, p, appointment) = setup().await;
    let r = app(db.clone());
    let services = "/api/v1/connect/services/settings";
    let installation = Uuid::new_v4();
    let input = json!({"installation_id":installation,"installation_token":"scs_inst_synthetic_private_token_12345"});
    let (status, saved) = call(&r, &a, "PUT", services, input.clone(), Some(0)).await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["enabled"], false);
    assert_eq!(saved["verified"], false);
    assert!(!saved.to_string().contains("scs_inst_"));
    let encrypted: Vec<u8> = sqlx::query_scalar(
        "SELECT encrypted_token FROM connect_service_credentials WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(!String::from_utf8_lossy(&encrypted).contains("scs_inst_"));
    assert_eq!(
        call(&r, &a, "PUT", services, input.clone(), Some(0))
            .await
            .0,
        409
    );
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &format!("{services}/test"),
            json!({}),
            Some(2)
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &format!("{services}/activation"),
            json!({"enabled":true}),
            Some(1)
        )
        .await
        .0,
        409
    );
    let mut staff = a.clone();
    staff.role = Role::FrontDesk;
    assert_eq!(
        call(&r, &staff, "GET", services, Value::Null, None).await.0,
        200
    );
    assert_eq!(
        call(&r, &staff, "PUT", services, input, Some(1)).await.0,
        403
    );
    let mut foreign = a.clone();
    foreign.tenant_id = Uuid::new_v4();
    let (_, empty) = call(&r, &foreign, "GET", services, Value::Null, None).await;
    assert!(empty["setting"].is_null());
    assert_eq!(
        call(&r, &foreign, "DELETE", services, Value::Null, Some(1))
            .await
            .0,
        404
    );
    let mut patient = a.clone();
    patient.role = Role::Patient;
    patient.patient_id = Some(p);
    assert_eq!(
        call(
            &r,
            &patient,
            "GET",
            "/api/v1/connect/services/tickets",
            Value::Null,
            None
        )
        .await
        .0,
        403
    );
    assert_eq!(call(&r,&a,"POST","/api/v1/connect/services/tickets",json!({"request_id":Uuid::new_v4(),"subject":"Synthetic support","message":"Operational only"}),None).await.0,409);
    // Mock-verification fixture only. Native production test always calls the fixed authenticated origin.
    sqlx::query("UPDATE connect_service_settings SET verified=true,reminders_available=true,support_available=true,from_email='SunCharts <appointments@suncharts.app>' WHERE tenant_id=$1").bind(a.tenant_id).execute(&db).await.unwrap();
    let (status, enabled) = call(
        &r,
        &a,
        "POST",
        &format!("{services}/activation"),
        json!({"enabled":true}),
        Some(1),
    )
    .await;
    assert_eq!(status, 200, "{enabled}");
    // A failed local audit prevents the external support mutation entirely.
    sqlx::query("CREATE FUNCTION fail_support_reservation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='connect.support_request_reserved' THEN RAISE EXCEPTION 'synthetic reservation audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_support_reservation BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_support_reservation()").execute(&db).await.unwrap();
    assert_eq!(call(&r,&a,"POST","/api/v1/connect/services/tickets",json!({"request_id":Uuid::new_v4(),"subject":"Synthetic operational support","message":"Synthetic configuration issue"}),None).await.0,500);
    let reservations: i64 = sqlx::query_scalar("SELECT count(*) FROM connect_support_requests")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(reservations, 0);
    sqlx::query("DROP TRIGGER fail_support_reservation ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    let prior_support = Uuid::new_v4();
    sqlx::query("INSERT INTO connect_support_requests(tenant_id,request_id,setting_id,credential_revision,path,body_hash,actor_id) VALUES($1,$2,$3,1,'/tickets','different_payload',$4)").bind(a.tenant_id).bind(prior_support).bind(Uuid::parse_str(saved["id"].as_str().unwrap()).unwrap()).bind(a.sub).execute(&db).await.unwrap();
    assert_eq!(call(&r,&a,"POST","/api/v1/connect/services/tickets",json!({"request_id":prior_support,"subject":"Synthetic changed request","message":"Different operational payload"}),None).await.0,409);
    let sender = "/api/v1/schedule/reminder-settings";
    let (status, managed) = call(
        &r,
        &a,
        "PUT",
        sender,
        json!({"delivery_mode":"suncharts_connect"}),
        Some(0),
    )
    .await;
    assert_eq!(status, 200, "{managed}");
    assert_eq!(managed["delivery_mode"], "suncharts_connect");
    // Managed sender testing verifies the already authenticated installation capability and pinned revision.
    let (status, tested) = call(
        &r,
        &a,
        "POST",
        &format!("{sender}/test"),
        json!({}),
        Some(1),
    )
    .await;
    assert_eq!(status, 200, "{tested}");
    assert_eq!(tested["authenticated"], true);
    let (status, activated) = call(
        &r,
        &a,
        "POST",
        &format!("{sender}/activation"),
        json!({"enabled":true}),
        Some(2),
    )
    .await;
    assert_eq!(status, 200, "{activated}");
    let prefs = format!("/api/v1/patients/{p}/reminder-preferences");
    assert_eq!(call(&r,&a,"PUT",&prefs,json!({"channel":"email","destination":"synthetic@example.test","consented":true,"verified":true,"automatic_email":true,"reason":"Synthetic explicit consent and address verification"}),Some(0)).await.0,200);
    let(status,reminder)=call(&r,&a,"POST",&format!("/api/v1/appointments/{appointment}/reminders"),json!({"request_id":Uuid::new_v4(),"before_minutes":3000,"reason":"Synthetic managed reminder"}),Some(1)).await;
    assert_eq!(status, 200, "{reminder}");
    let transport = Transport(std::sync::Mutex::new(vec![]));
    assert!(
        suncharts_engine::reminders::process_one_with_transport(&db, &transport)
            .await
            .unwrap()
    );
    assert_eq!(
        transport.0.lock().unwrap().as_slice(),
        ["scs_inst_synthetic_private_token_12345"]
    );
    let(status,own)=call(&r,&a,"PUT",sender,json!({"delivery_mode":"own_resend","from_email":"own@example.test","api_key":"re_synthetic_different_account_1234"}),Some(3)).await;
    assert_eq!(status, 200, "{own}");
    assert_eq!(own["delivery_mode"], "own_resend");
    // Also rotate the service installation token: accepted receipts still use old immutable token.
    let(status,rotated)=call(&r,&a,"PUT",services,json!({"installation_id":installation,"installation_token":"scs_inst_rotated_different_token_56789"}),Some(2)).await;
    assert_eq!(status, 200, "{rotated}");
    assert!(
        suncharts_engine::reminders::process_one_with_transport(&db, &transport)
            .await
            .unwrap()
    );
    assert_eq!(
        transport.0.lock().unwrap().as_slice(),
        [
            "scs_inst_synthetic_private_token_12345",
            "scs_inst_synthetic_private_token_12345"
        ]
    );
    let (_, delivered) = call(
        &r,
        &a,
        "GET",
        &format!(
            "/api/v1/schedule/reminders/{}",
            reminder["id"].as_str().unwrap()
        ),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(delivered["reminder"]["status"], "delivered");
    let (status, revoked) = call(&r, &a, "DELETE", services, Value::Null, Some(3)).await;
    assert_eq!(status, 200, "{revoked}");
    assert_eq!(revoked["remote_revocation_required"], true);
    let (_, after) = call(&r, &a, "GET", services, Value::Null, None).await;
    assert_eq!(after["setting"]["enabled"], false);
    assert_eq!(after["setting"]["revoked"], true);
    assert!(!after.to_string().contains("scs_inst_"));
    // Audit failure prevents saving a credential/configuration revision.
    sqlx::query("CREATE FUNCTION reject_service_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='connect.services_saved_disabled' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_service_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_service_audit()").execute(&db).await.unwrap();
    assert_eq!(call(&r,&a,"PUT",services,json!({"installation_id":installation,"installation_token":"scs_inst_never_committed_token_12345"}),Some(4)).await.0,500);
    let (_, unchanged) = call(&r, &a, "GET", services, Value::Null, None).await;
    assert_eq!(unchanged["setting"]["version"], 4);
    db.close().await;
    let _ = std::fs::remove_dir_all(keydir);
}
