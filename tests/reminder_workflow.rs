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
    let schema = format!("reminder_test_{}", Uuid::new_v4().simple());
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
#[derive(Default)]
struct Mail(std::sync::Mutex<Vec<(Value, String)>>);
#[async_trait::async_trait]
impl suncharts_engine::reminders::EmailTransport for Mail {
    async fn send(
        &self,
        _key: &str,
        message: &Value,
        idempotency: &str,
    ) -> suncharts_engine::reminders::SendResult {
        self.0
            .lock()
            .unwrap()
            .push((message.clone(), idempotency.into()));
        suncharts_engine::reminders::SendResult::Accepted(Uuid::from_u128(42))
    }
    async fn delivery(
        &self,
        _key: &str,
        _id: Uuid,
        _to: &str,
        _from: &str,
    ) -> suncharts_engine::error::Result<suncharts_engine::reminders::DeliveryResult> {
        Ok(suncharts_engine::reminders::DeliveryResult::Delivered)
    }
}
struct RejectedRetry;
#[async_trait::async_trait]
impl suncharts_engine::reminders::EmailTransport for RejectedRetry {
    async fn send(&self, _: &str, _: &Value, _: &str) -> suncharts_engine::reminders::SendResult {
        suncharts_engine::reminders::SendResult::Rejected(401)
    }
    async fn delivery(
        &self,
        _: &str,
        _: Uuid,
        _: &str,
        _: &str,
    ) -> suncharts_engine::error::Result<suncharts_engine::reminders::DeliveryResult> {
        unreachable!()
    }
}
#[tokio::test]
async fn consent_defaults_invalidation_delivery_and_atomic_audit() {
    let keydir = std::env::temp_dir().join(format!("reminder-key-{}", Uuid::new_v4()));
    std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", keydir.join("master.key"));
    let (db, a, p, appointment) = setup().await;
    let r = app(db.clone());
    let prefs = format!("/api/v1/patients/{p}/reminder-preferences");
    let reminders = format!("/api/v1/appointments/{appointment}/reminders");
    let preference = json!({"channel":"email","destination":"synthetic@example.test","consented":true,"verified":true,"automatic_email":true,"reason":"Synthetic patient granted permission and staff verified the current address"});
    let (status, initial) = call(&r, &a, "GET", &reminders, Value::Null, None).await;
    assert_eq!(status, 200, "{initial}");
    assert_eq!(initial["items"].as_array().unwrap().len(), 2);
    assert!(initial["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|x| x["status"] == "needs_contact"));
    let mut invalid = preference.clone();
    invalid["destination"] = json!("wrong@example.test");
    assert_eq!(call(&r, &a, "PUT", &prefs, invalid, Some(0)).await.0, 400);
    let mut phone = preference.clone();
    phone["channel"] = json!("phone");
    phone["destination"] = json!("555-0100");
    assert_eq!(call(&r, &a, "PUT", &prefs, phone, Some(0)).await.0, 400);
    let (status, saved) = call(&r, &a, "PUT", &prefs, preference.clone(), Some(0)).await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["version"], 1);
    assert_eq!(
        call(&r, &a, "PUT", &prefs, preference.clone(), Some(0))
            .await
            .0,
        409
    );
    let (_, rows) = call(&r, &a, "GET", &reminders, Value::Null, None).await;
    assert_eq!(
        rows["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|x| x["status"] == "scheduled")
            .count(),
        2
    );
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(&r, &other, "GET", &prefs, Value::Null, None).await.0,
        404
    );
    let mut staff = a.clone();
    staff.role = Role::FrontDesk;
    let settings = "/api/v1/schedule/reminder-settings";
    assert_eq!(
        call(&r, &staff, "GET", settings, Value::Null, None).await.0,
        403
    );
    let (status, sender) = call(
        &r,
        &a,
        "PUT",
        settings,
        json!({"api_key":"re_synthetic_test_only_123456","from_email":"reminders@example.test"}),
        Some(0),
    )
    .await;
    assert_eq!(status, 200, "{sender}");
    assert!(!sender.to_string().contains("re_synthetic"));
    let cipher: Vec<u8> =
        sqlx::query_scalar("SELECT encrypted_key FROM reminder_credentials WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(!String::from_utf8_lossy(&cipher).contains("re_synthetic"));
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            "/api/v1/schedule/reminder-settings/activation",
            json!({"enabled":true}),
            Some(1)
        )
        .await
        .0,
        400
    );
    // Provider verification is fixture evidence; no external service or real credential is called.
    sqlx::query("UPDATE reminder_sender_settings SET verified=true WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .execute(&db)
        .await
        .unwrap();
    let (status, active) = call(
        &r,
        &a,
        "POST",
        "/api/v1/schedule/reminder-settings/activation",
        json!({"enabled":true}),
        Some(1),
    )
    .await;
    assert_eq!(status, 200, "{active}");
    let create = json!({"request_id":Uuid::new_v4(),"before_minutes":3000,"reason":"Synthetic custom reminder"});
    let (status, custom) = call(&r, &a, "POST", &reminders, create.clone(), Some(1)).await;
    assert_eq!(status, 200, "{custom}");
    let (_, replayed) = call(&r, &a, "POST", &reminders, create.clone(), Some(1)).await;
    assert_eq!(custom["id"], replayed["id"]);
    let mut changed = create.clone();
    changed["before_minutes"] = json!(3001);
    assert_eq!(
        call(&r, &a, "POST", &reminders, changed, Some(1)).await.0,
        409
    );
    // Unknown prior provider acceptance cannot be erased by staff cancellation
    // or a manual outcome. Retrying retains the lifetime attempt count.
    let custom_id = custom["id"].as_str().unwrap();
    sqlx::query("UPDATE appointment_reminders SET status='needs_review',first_attempt_at=now(),attempts=5 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(Uuid::parse_str(custom_id).unwrap()).execute(&db).await.unwrap();
    let unknown_path = format!("/api/v1/schedule/reminders/{custom_id}");
    let (_, held) = call(&r, &a, "GET", &unknown_path, Value::Null, None).await;
    assert_eq!(held["reminder"]["actions"], json!(["retry"]));
    for action in [
        "cancel",
        "manual_contacted",
        "manual_no_answer",
        "manual_failed",
    ] {
        assert_eq!(
            call(
                &r,
                &a,
                "POST",
                &format!("{unknown_path}/actions"),
                json!({"action":action,"reason":"Synthetic unsafe status overwrite"}),
                held["reminder"]["version"].as_i64()
            )
            .await
            .0,
            409
        );
    }
    let (status, retry) = call(
        &r,
        &a,
        "POST",
        &format!("{unknown_path}/actions"),
        json!({"action":"retry","reason":"Synthetic same-request retry"}),
        held["reminder"]["version"].as_i64(),
    )
    .await;
    assert_eq!(status, 200, "{retry}");
    assert_eq!(retry["attempts"], 5);
    assert!(
        suncharts_engine::reminders::process_one_with_transport(&db, &RejectedRetry)
            .await
            .unwrap()
    );
    let (_, rejected_retry) = call(&r, &a, "GET", &unknown_path, Value::Null, None).await;
    assert_eq!(rejected_retry["reminder"]["status"], "needs_review");
    assert_eq!(
        rejected_retry["reminder"]["last_result"],
        "retry_rejected_prior_acceptance_unknown"
    );
    sqlx::query("UPDATE appointment_reminders SET status='needs_review',first_attempt_at=now()-interval '24 hours' WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(Uuid::parse_str(custom_id).unwrap()).execute(&db).await.unwrap();
    let (_, expired) = call(&r, &a, "GET", &unknown_path, Value::Null, None).await;
    assert_eq!(expired["reminder"]["actions"], json!([]));
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &format!("{unknown_path}/actions"),
            json!({"action":"retry","reason":"Synthetic unsafe expired retry"}),
            expired["reminder"]["version"].as_i64()
        )
        .await
        .0,
        409
    );
    // Restore this synthetic fixture to its never-sent state for transport tests.
    sqlx::query("UPDATE appointment_reminders SET status='scheduled',first_attempt_at=NULL,attempts=0,next_attempt_at=now()-interval '1 minute' WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(Uuid::parse_str(custom_id).unwrap()).execute(&db).await.unwrap();
    let mail = Mail::default();
    assert!(
        suncharts_engine::reminders::process_one_with_transport(&db, &mail)
            .await
            .unwrap()
    );
    let id = custom["id"].as_str().unwrap();
    let detail = format!("/api/v1/schedule/reminders/{id}");
    let (_, accepted) = call(&r, &a, "GET", &detail, Value::Null, None).await;
    assert_eq!(accepted["reminder"]["status"], "accepted");
    assert_eq!(accepted["reminder"]["actions"], json!(["refresh_delivery"]));
    let msg = mail.0.lock().unwrap()[0].0.clone();
    assert!(!msg.to_string().contains("Avery"));
    assert!(!msg.to_string().contains("SYN-REMINDER"));
    assert_eq!(msg["to"], json!(["synthetic@example.test"]));
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &format!("{detail}/actions"),
            json!({"action":"cancel","reason":"Synthetic cancellation"}),
            accepted["reminder"]["version"].as_i64()
        )
        .await
        .0,
        409
    );
    // Disabling new sends still permits reconciliation of the pinned accepted request.
    let version = active["version"].as_i64().unwrap();
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            "/api/v1/schedule/reminder-settings/activation",
            json!({"enabled":false}),
            Some(version)
        )
        .await
        .0,
        200
    );
    assert!(
        suncharts_engine::reminders::process_one_with_transport(&db, &mail)
            .await
            .unwrap()
    );
    let (_, delivered) = call(&r, &a, "GET", &detail, Value::Null, None).await;
    assert_eq!(delivered["reminder"]["status"], "delivered");
    assert_eq!(mail.0.lock().unwrap().len(), 1);
    // Native contact edits revoke verification and supersede unsent frozen destinations.
    sqlx::query("UPDATE patient_demographics SET content=jsonb_set(content,'{email}','\"new@example.test\"'),version=version+1 WHERE tenant_id=$1 AND patient_id=$2").bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    let (_, revoked) = call(&r, &a, "GET", &prefs, Value::Null, None).await;
    assert_eq!(revoked["content"]["verified"], false);
    assert_eq!(revoked["content"]["automatic_email"], false);
    let (_, rows) = call(&r, &a, "GET", &reminders, Value::Null, None).await;
    assert!(rows["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|x| x["status"] != "scheduled"));
    let mut fresh = preference.clone();
    fresh["destination"] = json!("new@example.test");
    let (status, newpref) = call(&r, &a, "PUT", &prefs, fresh.clone(), Some(2)).await;
    assert_eq!(status, 200, "{newpref}");
    // Unsent custom definitions retain their offset; unknown sends never clone.
    for offset in [17, 19, 20000, 120] {
        let(status,custom)=call(&r,&a,"POST",&reminders,json!({"request_id":Uuid::new_v4(),"before_minutes":offset,"reason":"Synthetic reschedule definition"}),Some(1)).await;
        assert_eq!(status, 200, "{custom}");
        if offset == 19 {
            sqlx::query("UPDATE appointment_reminders SET status='needs_review',first_attempt_at=now(),attempts=1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(Uuid::parse_str(custom["id"].as_str().unwrap()).unwrap()).execute(&db).await.unwrap();
        }
    }
    // Trigger-observed reschedules preserve old rows and schedule the new version.
    sqlx::query("UPDATE appointments SET starts_at=starts_at+interval '1 day',ends_at=ends_at+interval '1 day',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(appointment).execute(&db).await.unwrap();
    let (_, rescheduled) = call(&r, &a, "GET", &reminders, Value::Null, None).await;
    assert_eq!(
        rescheduled["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|x| x["status"] == "scheduled")
            .count(),
        4
    );
    let custom_rows:Vec<(i32,String,chrono::DateTime<Utc>,chrono::DateTime<Utc>)>=sqlx::query_as("SELECT before_minutes,status,due_at,starts_at FROM appointment_reminders WHERE tenant_id=$1 AND appointment_id=$2 AND definition_key LIKE 'custom:%'").bind(a.tenant_id).bind(appointment).fetch_all(&db).await.unwrap();
    let offset17: Vec<_> = custom_rows.iter().filter(|r| r.0 == 17).collect();
    assert_eq!(offset17.len(), 2);
    assert!(offset17.iter().any(|r| r.1 == "superseded"));
    let moved = offset17.iter().find(|r| r.1 == "scheduled").unwrap();
    assert_eq!(moved.2, moved.3 - chrono::Duration::minutes(17));
    let offset19: Vec<_> = custom_rows.iter().filter(|r| r.0 == 19).collect();
    assert_eq!(offset19.len(), 1);
    assert_eq!(offset19[0].1, "needs_review");
    assert!(custom_rows.iter().any(|r| r.0 == 20000 && r.1 == "missed"));
    assert_eq!(
        custom_rows
            .iter()
            .filter(|r| r.0 == 120 && r.1 == "scheduled")
            .count(),
        1,
        "custom same-offset default remains a separate explicit definition"
    );
    let history:i64=sqlx::query_scalar("SELECT count(*) FROM appointment_reminder_events WHERE tenant_id=$1 AND action='custom_rescheduled'").bind(a.tenant_id).fetch_one(&db).await.unwrap();
    assert_eq!(history, 3);
    sqlx::query(
        "UPDATE appointments SET status='cancelled',version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(appointment)
    .execute(&db)
    .await
    .unwrap();
    let (_, due) = call(
        &r,
        &a,
        "GET",
        "/api/v1/schedule/reminders?state=due",
        Value::Null,
        None,
    )
    .await;
    assert!(due["items"].as_array().unwrap().is_empty());
    let (_, all) = call(
        &r,
        &a,
        "GET",
        "/api/v1/schedule/reminders?state=all",
        Value::Null,
        None,
    )
    .await;
    let items = all["items"].as_array().unwrap();
    assert!(items.len() > 1);
    for pair in items.windows(2) {
        let left =
            chrono::DateTime::parse_from_rfc3339(pair[0]["due_at"].as_str().unwrap()).unwrap();
        let right =
            chrono::DateTime::parse_from_rfc3339(pair[1]["due_at"].as_str().unwrap()).unwrap();
        assert!(
            left <= right,
            "worklist must prioritize earlier reminder times"
        );
    }
    let after = format!(
        "/api/v1/schedule/reminders?state=all&after={}",
        items[0]["id"].as_str().unwrap()
    );
    let (_, next) = call(&r, &a, "GET", &after, Value::Null, None).await;
    assert_eq!(next["items"].as_array().unwrap(), &items[1..]);

    // Audit failure rolls back preference + its history and queue mutation atomically.
    sqlx::query("CREATE FUNCTION fail_reminder_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='appointment.reminder_preference_change' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_reminder_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_reminder_audit()").execute(&db).await.unwrap();
    fresh["consented"] = json!(false);
    fresh["verified"] = json!(false);
    fresh["automatic_email"] = json!(false);
    assert_eq!(call(&r, &a, "PUT", &prefs, fresh, Some(3)).await.0, 500);
    let (_, unchanged) = call(&r, &a, "GET", &prefs, Value::Null, None).await;
    assert_eq!(unchanged["version"], 3);
    assert_eq!(unchanged["content"]["consented"], true);
    sqlx::query("DROP TRIGGER fail_reminder_audit ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    // Audit ordering is acquired before queue/preferences mutation: a later event
    // cannot become visible while an earlier tenant event remains uncommitted.
    let mut earlier = db.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))")
        .bind(a.tenant_id.to_string())
        .execute(&mut *earlier)
        .await
        .unwrap();
    let rr = r.clone();
    let aa = a.clone();
    let pp = prefs.clone();
    let waiting = tokio::spawn(async move {
        call(&rr,&aa,"PUT",&pp,json!({"channel":"email","destination":"new@example.test","consented":false,"verified":false,"automatic_email":false,"reason":"Synthetic permission withdrawn"}),Some(3)).await
    });
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    assert!(!waiting.is_finished());
    let earlier_id:i64=sqlx::query_scalar("INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES($1,$2,'synthetic.earlier_event',$3) RETURNING id").bind(a.tenant_id).bind(a.sub).bind(p).fetch_one(&mut *earlier).await.unwrap();
    earlier.commit().await.unwrap();
    let (status, result) = waiting.await.unwrap();
    assert_eq!(status, 200, "{result}");
    let later_id:i64=sqlx::query_scalar("SELECT max(id) FROM audit_events WHERE tenant_id=$1 AND action='appointment.reminder_preference_change'").bind(a.tenant_id).fetch_one(&db).await.unwrap();
    assert!(later_id > earlier_id);
    db.close().await;
    let _ = std::fs::remove_dir_all(keydir);
}
