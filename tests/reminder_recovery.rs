// SPDX-License-Identifier: AGPL-3.0-only
//! Synthetic PostgreSQL worker recovery tests. No external email request is made.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use suncharts_engine::{
    auth::{Actor, Role},
    browser::BrowserAuth,
    postgres::PostgresBackend,
    reminders::{self, DeliveryResult, EmailTransport, SendResult},
    State,
};
use tower::ServiceExt;
use uuid::Uuid;
const SECRET: &str = "synthetic-reminder-recovery-jwt-key";
const EMAIL_KEY: &str = "re_synthetic_recovery_fixture_123";
static KEY_PATH: OnceLock<PathBuf> = OnceLock::new();
struct Fixture {
    pool: PgPool,
    app: Router,
    actor: Actor,
    patient: Uuid,
    sender: Uuid,
}
async fn call(
    app: &Router,
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
    if let Some(version) = version {
        request = request.header("If-Match", format!("\"{version}\""));
    }
    let response = app
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
impl Fixture {
    async fn new() -> Self {
        KEY_PATH.get_or_init(|| {
            let path = std::env::temp_dir()
                .join(format!("suncharts-reminder-recovery-{}", Uuid::new_v4()))
                .join("master.key");
            std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", &path);
            path
        });
        let url =
            std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
        let schema = format!("reminder_recovery_{}", Uuid::new_v4().simple());
        let initial = PgPool::connect(&url).await.unwrap();
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&initial)
            .await
            .unwrap();
        initial.close().await;
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .after_connect(move |c, _| {
                let query = format!("SET search_path TO {schema}");
                Box::pin(async move {
                    sqlx::query(&query).execute(c).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        suncharts_engine::MIGRATOR.run(&pool).await.unwrap();
        Self::on_pool(pool).await
    }
    async fn on_pool(pool: PgPool) -> Self {
        let now = Utc::now().timestamp();
        let actor = Actor {
            sub: Uuid::new_v4(),
            tenant_id: Uuid::new_v4(),
            role: Role::Owner,
            patient_id: None,
            iss: "suncharts".into(),
            aud: "suncharts-engine".into(),
            iat: now,
            exp: now + 120,
        };
        let app = suncharts_engine::app(State {
            backend: Arc::new(PostgresBackend(pool.clone())),
            secret: SECRET.into(),
            allow_legacy_gateway: true,
            issuer: "suncharts".into(),
            audience: "suncharts-engine".into(),
            browser: Some(BrowserAuth::new(pool.clone(), "http://127.0.0.1:8099".into()).unwrap()),
        });
        let patient = Uuid::new_v4();
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'PRIVATE-SYNTHETIC-MRN','PRIVATE_PATIENT_GIVEN','PRIVATE_PATIENT_FAMILY','1990-01-01')").bind(actor.tenant_id).bind(patient).execute(&pool).await.unwrap();
        let(status,_)=call(&app,&actor,"PUT",&format!("/api/v1/patients/{patient}/demographics"),json!({"content":{"email":"recipient@example.test"},"reason":"Synthetic contact fixture"}),Some(0)).await;
        assert_eq!(status, 200);
        let(status,_)=call(&app,&actor,"PUT",&format!("/api/v1/patients/{patient}/reminder-preferences"),json!({"channel":"email","destination":"recipient@example.test","consented":true,"verified":true,"automatic_email":true,"reason":"Synthetic explicit reminder permission"}),Some(0)).await;
        assert_eq!(status, 200);
        let (status, setting) = call(
            &app,
            &actor,
            "PUT",
            "/api/v1/schedule/reminder-settings",
            json!({"from_email":"clinic@example.test","api_key":EMAIL_KEY}),
            Some(0),
        )
        .await;
        assert_eq!(status, 200, "{setting}");
        let sender = Uuid::parse_str(setting["id"].as_str().unwrap()).unwrap();
        // Supply previously verified fixture configuration without calling the real domain API.
        sqlx::query(
            "UPDATE reminder_sender_settings SET enabled=true,verified=true WHERE tenant_id=$1",
        )
        .bind(actor.tenant_id)
        .execute(&pool)
        .await
        .unwrap();
        Self {
            pool,
            app,
            actor,
            patient,
            sender,
        }
    }
    async fn due(&self, minutes_until: i64) -> (Uuid, Uuid) {
        let appointment = Uuid::new_v4();
        let starts = Utc::now() + Duration::minutes(minutes_until);
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,title,notes) VALUES($1,$2,$3,$4,$5,$6,'PRIVATE_SYNTHETIC_CONSULTATION','PRIVATE_SYNTHETIC_NOTE')").bind(self.actor.tenant_id).bind(appointment).bind(self.patient).bind(self.actor.sub).bind(starts).bind(starts+Duration::minutes(30)).execute(&self.pool).await.unwrap();
        let(status,r)=call(&self.app,&self.actor,"POST",&format!("/api/v1/appointments/{appointment}/reminders"),json!({"request_id":Uuid::new_v4(),"before_minutes":240,"reason":"Synthetic due reminder"}),Some(1)).await;
        assert_eq!(status, 200, "{r}");
        (
            appointment,
            Uuid::parse_str(r["id"].as_str().unwrap()).unwrap(),
        )
    }
    async fn state(&self, id: Uuid) -> (String, bool, Option<Uuid>) {
        sqlx::query_as("SELECT status,invalidated,lease_id FROM appointment_reminders WHERE tenant_id=$1 AND id=$2").bind(self.actor.tenant_id).bind(id).fetch_one(&self.pool).await.unwrap()
    }
}
#[derive(Default)]
struct Capture {
    attempts: Vec<(String, Value)>,
    receipts: HashMap<String, Uuid>,
}
struct Fake {
    capture: Mutex<Capture>,
    uncertain: usize,
    sends: AtomicUsize,
    polls: AtomicUsize,
    delivered: AtomicBool,
}
impl Fake {
    fn new(uncertain: usize) -> Self {
        Self {
            capture: Mutex::new(Capture::default()),
            uncertain,
            sends: AtomicUsize::new(0),
            polls: AtomicUsize::new(0),
            delivered: AtomicBool::new(false),
        }
    }
}
#[async_trait::async_trait]
impl EmailTransport for Fake {
    async fn send(&self, key: &str, message: &Value, idempotency: &str) -> SendResult {
        assert_eq!(key, EMAIL_KEY);
        assert_eq!(message["to"], json!(["recipient@example.test"]));
        assert_eq!(message["from"], "clinic@example.test");
        let encoded = message.to_string();
        assert!(
            !encoded.contains(EMAIL_KEY),
            "sender credential entered notification payload"
        );
        for private in [
            "PRIVATE_PATIENT_GIVEN",
            "PRIVATE_PATIENT_FAMILY",
            "PRIVATE-SYNTHETIC-MRN",
            "PRIVATE_SYNTHETIC_CONSULTATION",
            "PRIVATE_SYNTHETIC_NOTE",
        ] {
            assert!(
                !encoded.contains(private),
                "clinical fixture content entered notification payload"
            );
        }
        let receipt = {
            let mut capture = self.capture.lock().unwrap();
            capture.attempts.push((idempotency.into(), message.clone()));
            *capture
                .receipts
                .entry(idempotency.into())
                .or_insert_with(Uuid::new_v4)
        };
        let attempt = self.sends.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        if attempt < self.uncertain {
            SendResult::Uncertain
        } else {
            SendResult::Accepted(receipt)
        }
    }
    async fn delivery(
        &self,
        key: &str,
        _id: Uuid,
        to: &str,
        from: &str,
    ) -> suncharts_engine::error::Result<DeliveryResult> {
        assert_eq!(key, EMAIL_KEY);
        assert_eq!(to, "recipient@example.test");
        assert_eq!(from, "clinic@example.test");
        self.polls.fetch_add(1, Ordering::SeqCst);
        Ok(if self.delivered.load(Ordering::SeqCst) {
            DeliveryResult::Delivered
        } else {
            DeliveryResult::Pending
        })
    }
}
#[tokio::test]
async fn expired_invalidated_send_is_held_without_starving_the_next_reminder() {
    let f = Fixture::new().await;
    let (old_appointment, old) = f.due(150).await;
    let (_, next) = f.due(210).await;
    sqlx::query("UPDATE appointment_reminders SET status='sending',lease_id=$3,lease_until=now()-interval '1 minute',first_attempt_at=now()-interval '2 minutes',sender_setting_id=$4,sender_revision=1,from_email='clinic@example.test' WHERE tenant_id=$1 AND id=$2").bind(f.actor.tenant_id).bind(old).bind(Uuid::new_v4()).bind(f.sender).execute(&f.pool).await.unwrap();
    // The worker died after its durable claim. Appointment cancellation invalidates it.
    sqlx::query(
        "UPDATE appointments SET status='cancelled',version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.actor.tenant_id)
    .bind(old_appointment)
    .execute(&f.pool)
    .await
    .unwrap();
    let state = f.state(old).await;
    assert_eq!(state.0, "sending");
    assert!(state.1);
    let fake = Fake::new(0);
    assert!(reminders::process_one_with_transport(&f.pool, &fake)
        .await
        .unwrap());
    let state = f.state(old).await;
    assert_eq!(state.0, "needs_review");
    assert!(state.1);
    assert!(state.2.is_none());
    assert_eq!(fake.sends.load(Ordering::SeqCst), 0);
    assert!(reminders::process_one_with_transport(&f.pool, &fake)
        .await
        .unwrap());
    assert_eq!(f.state(next).await.0, "accepted");
    assert_eq!(fake.sends.load(Ordering::SeqCst), 1);
    f.pool.close().await;
}
#[tokio::test]
async fn competing_workers_send_one_private_minimal_message_and_acceptance_is_not_delivery() {
    let f = Fixture::new().await;
    let (_, id) = f.due(150).await;
    let fake = Fake::new(0);
    let (a, b) = tokio::join!(
        reminders::process_one_with_transport(&f.pool, &fake),
        reminders::process_one_with_transport(&f.pool, &fake)
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(fake.sends.load(Ordering::SeqCst), 1);
    assert_eq!(f.state(id).await.0, "accepted");
    assert_eq!(fake.capture.lock().unwrap().receipts.len(), 1);
    // Stopping future sends must not prevent reconciliation of this accepted message.
    sqlx::query("UPDATE reminder_sender_settings SET enabled=false WHERE tenant_id=$1")
        .bind(f.actor.tenant_id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE appointment_reminders SET last_poll_at=NULL WHERE tenant_id=$1 AND id=$2")
        .bind(f.actor.tenant_id)
        .bind(id)
        .execute(&f.pool)
        .await
        .unwrap();
    fake.delivered.store(true, Ordering::SeqCst);
    assert!(reminders::process_one_with_transport(&f.pool, &fake)
        .await
        .unwrap());
    assert_eq!(f.state(id).await.0, "delivered");
    assert!(fake.polls.load(Ordering::SeqCst) >= 1);
    f.pool.close().await;
}
#[tokio::test]
async fn uncertain_send_retries_exact_provider_key_then_holds_when_too_old() {
    let f = Fixture::new().await;
    let (_, id) = f.due(150).await;
    let fake = Fake::new(1);
    assert!(reminders::process_one_with_transport(&f.pool, &fake)
        .await
        .unwrap());
    assert_eq!(f.state(id).await.0, "scheduled");
    sqlx::query(
        "UPDATE appointment_reminders SET next_attempt_at=now() WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.actor.tenant_id)
    .bind(id)
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(reminders::process_one_with_transport(&f.pool, &fake)
        .await
        .unwrap());
    assert_eq!(f.state(id).await.0, "accepted");
    {
        let capture = fake.capture.lock().unwrap();
        assert_eq!(capture.attempts.len(), 2);
        assert_eq!(capture.attempts[0], capture.attempts[1]);
        assert_eq!(capture.receipts.len(), 1);
    }
    let (_, held) = f.due(210).await;
    let uncertain = Fake::new(usize::MAX);
    assert!(reminders::process_one_with_transport(&f.pool, &uncertain)
        .await
        .unwrap());
    assert_eq!(f.state(held).await.0, "scheduled");
    sqlx::query("UPDATE appointment_reminders SET next_attempt_at=now(),first_attempt_at=now()-interval '24 hours' WHERE tenant_id=$1 AND id=$2").bind(f.actor.tenant_id).bind(held).execute(&f.pool).await.unwrap();
    assert!(reminders::process_one_with_transport(&f.pool, &uncertain)
        .await
        .unwrap());
    assert_eq!(f.state(held).await.0, "needs_review");
    assert_eq!(uncertain.sends.load(Ordering::SeqCst), 1);
    f.pool.close().await;
}

#[tokio::test]
async fn unavailable_managed_installation_does_not_starve_another_tenants_sender() {
    let blocked = Fixture::new().await;
    let eligible = Fixture::on_pool(blocked.pool.clone()).await;
    let (_, held) = blocked.due(150).await;
    let (_, next) = eligible.due(210).await;
    let (status, service) = call(
        &blocked.app, &blocked.actor, "PUT", "/api/v1/connect/services/settings",
        json!({"installation_id":Uuid::new_v4(),"installation_token":format!("scs_inst_{}", "a".repeat(64))}), Some(0),
    ).await;
    assert_eq!(status, 200, "{service}");
    // Simulate prior installation verification without contacting the platform.
    sqlx::query("UPDATE connect_service_settings SET enabled=true,verified=true,reminders_available=true,from_email='managed@example.test' WHERE tenant_id=$1")
        .bind(blocked.actor.tenant_id).execute(&blocked.pool).await.unwrap();
    let version: i64 =
        sqlx::query_scalar("SELECT version FROM reminder_sender_settings WHERE tenant_id=$1")
            .bind(blocked.actor.tenant_id)
            .fetch_one(&blocked.pool)
            .await
            .unwrap();
    let (status, sender) = call(
        &blocked.app,
        &blocked.actor,
        "PUT",
        "/api/v1/schedule/reminder-settings",
        json!({"delivery_mode":"suncharts_connect"}),
        Some(version),
    )
    .await;
    assert_eq!(status, 200, "{sender}");
    sqlx::query(
        "UPDATE reminder_sender_settings SET enabled=true,verified=true WHERE tenant_id=$1",
    )
    .bind(blocked.actor.tenant_id)
    .execute(&blocked.pool)
    .await
    .unwrap();
    // Service revocation leaves an enabled native sender and its pending reminder.
    sqlx::query(
        "UPDATE connect_service_settings SET enabled=false,revoked=true WHERE tenant_id=$1",
    )
    .bind(blocked.actor.tenant_id)
    .execute(&blocked.pool)
    .await
    .unwrap();
    let fake = Fake::new(0);
    assert!(reminders::process_one_with_transport(&blocked.pool, &fake)
        .await
        .unwrap());
    assert_eq!(blocked.state(held).await.0, "needs_review");
    assert_eq!(fake.sends.load(Ordering::SeqCst), 0);
    assert!(reminders::process_one_with_transport(&blocked.pool, &fake)
        .await
        .unwrap());
    assert_eq!(eligible.state(next).await.0, "accepted");
    assert_eq!(fake.sends.load(Ordering::SeqCst), 1);
    blocked.pool.close().await;
}
