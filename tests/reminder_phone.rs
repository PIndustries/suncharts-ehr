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
const SECRET: &str = "synthetic-reminder-phone-test-secret";
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
    let schema = format!("reminder_phone_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
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
use suncharts_engine::reminders::{
    phone::{process_one_with_transport as process_phone, PhoneSend, PhoneTransport},
    DeliveryResult,
};
const TOKEN: &str = "0123456789abcdef0123456789abcdef";
const ACCOUNT: &str = "AC00000000000000000000000000000000";
const CLINIC: &str = "Synthetic Family Clinic";
const REFERENCE: &str = "SM0123456789abcdef0123456789abcdef";
type Sent = (String, String, String, String, String, String);
/// Records every request and answers from a queue, so a test decides what Twilio "said".
struct Fake {
    sent: std::sync::Mutex<Vec<Sent>>,
    answers: std::sync::Mutex<Vec<PhoneSend>>,
    delivery: std::sync::Mutex<Vec<DeliveryResult>>,
}
impl Fake {
    fn new(answers: Vec<PhoneSend>, delivery: Vec<DeliveryResult>) -> Self {
        Self {
            sent: Default::default(),
            answers: std::sync::Mutex::new(answers),
            delivery: std::sync::Mutex::new(delivery),
        }
    }
}
#[async_trait::async_trait]
impl PhoneTransport for Fake {
    async fn send(
        &self,
        sid: &str,
        key: &str,
        kind: &str,
        to: &str,
        from: &str,
        words: &str,
    ) -> PhoneSend {
        self.sent.lock().unwrap().push((
            sid.into(),
            key.into(),
            kind.into(),
            to.into(),
            from.into(),
            words.into(),
        ));
        self.answers.lock().unwrap().remove(0)
    }
    async fn status(
        &self,
        _sid: &str,
        _key: &str,
        _kind: &str,
        _reference: &str,
    ) -> suncharts_engine::error::Result<DeliveryResult> {
        Ok(self.delivery.lock().unwrap().remove(0))
    }
}
fn key_file() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let dir = std::env::temp_dir().join(format!("reminder-phone-key-{}", Uuid::new_v4()));
        std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", dir.join("master.key"));
    });
}
fn preference(channel: &str, automatic_phone: Option<&str>) -> Value {
    json!({"channel":channel,"destination":"(415) 555-0123","consented":true,"verified":true,"automatic_email":false,"automatic_phone":automatic_phone,"reason":"Synthetic patient allowed reminders and staff confirmed the number"})
}
/// A practice with Twilio saved, checked and on, a patient who allowed texts, and one reminder
/// that is already due. Returns the reminder id.
async fn due_reminder(
    db: &PgPool,
    r: &Router,
    a: &Actor,
    p: Uuid,
    appointment: Uuid,
    kind: &str,
) -> Uuid {
    sqlx::query("UPDATE patient_demographics SET content=jsonb_set(content,'{phone}','\"(415) 555-0123\"'),version=version+1 WHERE tenant_id=$1 AND patient_id=$2").bind(a.tenant_id).bind(p).execute(db).await.unwrap();
    sqlx::query("INSERT INTO practice_facilities(tenant_id,id,name) VALUES($1,$2,$3)")
        .bind(a.tenant_id)
        .bind(Uuid::new_v4())
        .bind(CLINIC)
        .execute(db)
        .await
        .unwrap();
    let (status, saved) = call(
        r,
        a,
        "PUT",
        "/api/v1/schedule/reminder-phone-settings",
        json!({"account_sid":ACCOUNT,"from_number":"+14155550100","auth_token":TOKEN}),
        Some(0),
    )
    .await;
    assert_eq!(status, 200, "{saved}");
    assert!(!saved.to_string().contains(TOKEN));
    assert_eq!(saved["from_number"], "+14155550100");
    let cipher: Vec<u8> = sqlx::query_scalar(
        "SELECT encrypted_key FROM reminder_phone_credentials WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .fetch_one(db)
    .await
    .unwrap();
    assert!(!String::from_utf8_lossy(&cipher).contains(TOKEN));
    // Provider verification is fixture evidence; no external service is called.
    sqlx::query("UPDATE reminder_phone_settings SET verified=true,enabled=true WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .execute(db)
        .await
        .unwrap();
    let prefs = format!("/api/v1/patients/{p}/reminder-preferences");
    let (status, saved) = call(
        r,
        a,
        "PUT",
        &prefs,
        preference("phone", Some(kind)),
        Some(0),
    )
    .await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["version"], 1);
    let (status, custom) = call(
        r,
        a,
        "POST",
        &format!("/api/v1/appointments/{appointment}/reminders"),
        json!({"request_id":Uuid::new_v4(),"before_minutes":3000,"reason":"Synthetic reminder already due"}),
        Some(1),
    )
    .await;
    assert_eq!(status, 200, "{custom}");
    assert_eq!(custom["status"], "scheduled");
    assert_eq!(custom["automatic_phone"], kind);
    Uuid::parse_str(custom["id"].as_str().unwrap()).unwrap()
}
async fn state(db: &PgPool, tenant: Uuid, id: Uuid) -> (String, Option<String>, Option<String>) {
    sqlx::query_as("SELECT status,last_result,provider_ref FROM appointment_reminders WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).fetch_one(db).await.unwrap()
}
#[tokio::test]
async fn text_reminder_is_sent_once_then_confirmed_delivered() {
    key_file();
    let (db, a, p, appointment) = setup().await;
    let r = app(db.clone());
    let prefs = format!("/api/v1/patients/{p}/reminder-preferences");
    // Automatic text or call needs the phone channel.
    assert_eq!(
        call(
            &r,
            &a,
            "PUT",
            &prefs,
            preference("email", Some("text")),
            Some(0)
        )
        .await
        .0,
        400
    );
    let mut wrong_kind = preference("phone", Some("fax"));
    wrong_kind["destination"] = json!("555-0100");
    assert_eq!(
        call(&r, &a, "PUT", &prefs, wrong_kind, Some(0)).await.0,
        400
    );
    let id = due_reminder(&db, &r, &a, p, appointment, "text").await;
    // The email worker has its own sender on and still leaves a phone reminder alone.
    let (status, sender) = call(
        &r,
        &a,
        "PUT",
        "/api/v1/schedule/reminder-settings",
        json!({"api_key":"re_synthetic_test_only_123456","from_email":"reminders@example.test"}),
        Some(0),
    )
    .await;
    assert_eq!(status, 200, "{sender}");
    sqlx::query(
        "UPDATE reminder_sender_settings SET verified=true,enabled=true WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .execute(&db)
    .await
    .unwrap();
    let mail = Mail::default();
    assert!(
        !suncharts_engine::reminders::process_one_with_transport(&db, &mail)
            .await
            .unwrap()
    );
    assert!(mail.0.lock().unwrap().is_empty());
    assert_eq!(state(&db, a.tenant_id, id).await.0, "scheduled");
    let fake = Fake::new(
        vec![PhoneSend::Accepted(REFERENCE.into())],
        vec![DeliveryResult::Delivered],
    );
    assert!(process_phone(&db, &fake).await.unwrap());
    let (status, note, reference) = state(&db, a.tenant_id, id).await;
    assert_eq!(status, "accepted");
    assert_eq!(note.as_deref(), Some("provider_accepted_not_delivered"));
    assert_eq!(reference.as_deref(), Some(REFERENCE));
    {
        let sent = fake.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        let (sid, key, kind, to, from, words) = &sent[0];
        assert_eq!((sid.as_str(), key.as_str()), (ACCOUNT, TOKEN));
        assert_eq!(kind, "text");
        assert_eq!(to, "+14155550123");
        assert_eq!(from, "+14155550100");
        assert!(words.contains(CLINIC), "{words}");
        for private in ["Avery", "Synthetic,", "SYN-REMINDER", "1990"] {
            assert!(!words.contains(private), "{words}");
        }
    }
    // The second pass only asks Twilio what happened; it never sends again.
    assert!(process_phone(&db, &fake).await.unwrap());
    let (status, note, _) = state(&db, a.tenant_id, id).await;
    assert_eq!(status, "delivered");
    assert_eq!(note.as_deref(), Some("provider_confirmed_delivery"));
    assert_eq!(fake.sent.lock().unwrap().len(), 1);
    assert!(!process_phone(&db, &fake).await.unwrap());
}
#[tokio::test]
async fn unknown_outcome_is_held_and_never_retried() {
    key_file();
    let (db, a, p, appointment) = setup().await;
    let r = app(db.clone());
    let id = due_reminder(&db, &r, &a, p, appointment, "call").await;
    let fake = Fake::new(vec![PhoneSend::Uncertain], vec![]);
    assert!(process_phone(&db, &fake).await.unwrap());
    let (status, note, reference) = state(&db, a.tenant_id, id).await;
    assert_eq!(status, "needs_review");
    assert_eq!(note.as_deref(), Some("send_outcome_unknown"));
    assert_eq!(reference, None);
    {
        let sent = fake.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].2, "call");
        assert!(sent[0].5.contains(CLINIC));
    }
    assert!(!process_phone(&db, &fake).await.unwrap());
    assert!(!process_phone(&db, &fake).await.unwrap());
    assert_eq!(fake.sent.lock().unwrap().len(), 1);
    assert_eq!(state(&db, a.tenant_id, id).await.0, "needs_review");
}
#[tokio::test]
async fn patient_who_stopped_texts_is_not_retried() {
    key_file();
    let (db, a, p, appointment) = setup().await;
    let r = app(db.clone());
    let id = due_reminder(&db, &r, &a, p, appointment, "text").await;
    let fake = Fake::new(vec![PhoneSend::Rejected(400, Some(21610))], vec![]);
    assert!(process_phone(&db, &fake).await.unwrap());
    let (status, note, reference) = state(&db, a.tenant_id, id).await;
    assert_eq!(status, "failed");
    assert_eq!(note.as_deref(), Some("patient_stopped_texts"));
    assert_eq!(reference, None);
    assert!(!process_phone(&db, &fake).await.unwrap());
    assert_eq!(fake.sent.lock().unwrap().len(), 1);
}
