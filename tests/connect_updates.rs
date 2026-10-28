// SPDX-License-Identifier: AGPL-3.0-only
//! Actual PostgreSQL boundaries for durable service updates and browser notifications.
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Request, StatusCode},
    Router,
};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use suncharts_engine::{
    browser::BrowserAuth,
    connect_updates::{self, EventTransport},
    error::Result,
    postgres::PostgresBackend,
    State,
};
use tower::ServiceExt;
use uuid::Uuid;
const ORIGIN: &str = "http://127.0.0.1:8099";
static KEY: OnceLock<()> = OnceLock::new();
struct Fixture {
    db: PgPool,
    app: Router,
    tenant: Uuid,
    user: Uuid,
    setting: Uuid,
    installation: Uuid,
    headers: HeaderMap,
}
impl Fixture {
    async fn new() -> Self {
        KEY.get_or_init(|| {
            let key = std::env::temp_dir()
                .join(format!("connect-updates-{}", Uuid::new_v4()))
                .join("master.key");
            std::fs::create_dir_all(key.parent().unwrap()).unwrap();
            std::fs::write(&key, [42u8; 32]).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
            }
            std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", key);
        });
        let url =
            std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
        let schema = format!("connect_updates_{}", Uuid::new_v4().simple());
        let initial = PgPool::connect(&url).await.unwrap();
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&initial)
            .await
            .unwrap();
        initial.close().await;
        let db = PgPoolOptions::new()
            .max_connections(5)
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
        suncharts_engine::MIGRATOR.run(&db).await.unwrap();
        let tenant = Uuid::new_v4();
        let user = Uuid::new_v4();
        let setting = Uuid::new_v4();
        let installation = Uuid::new_v4();
        let headers = user_session(&db, tenant, user, "owner").await;
        sqlx::query("INSERT INTO connect_service_settings(tenant_id,id,installation_id,enabled,verified,support_available,reminders_available,from_email) VALUES($1,$2,$3,true,true,true,true,'synthetic@example.test')").bind(tenant).bind(setting).bind(installation).execute(&db).await.unwrap();
        let encrypted = seal_secret(
            tenant,
            setting,
            "connect-service",
            "scs_inst_synthetic_update_credential_123456789",
        );
        sqlx::query("INSERT INTO connect_service_credentials(tenant_id,setting_id,revision,installation_id,encrypted_token) VALUES($1,$2,1,$3,$4)").bind(tenant).bind(setting).bind(installation).bind(encrypted).execute(&db).await.unwrap();
        let app = suncharts_engine::app(State {
            backend: Arc::new(PostgresBackend(db.clone())),
            secret: "synthetic-unused-gateway".into(),
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
            setting,
            installation,
            headers,
        }
    }
    async fn due(&self) {
        sqlx::query(
            "UPDATE connect_update_sync SET next_attempt_at=clock_timestamp(),lease_until=NULL",
        )
        .execute(&self.db)
        .await
        .unwrap();
    }
    fn page(&self, after: i64, items: Value) -> PageTransport {
        let list = items.as_array().unwrap();
        PageTransport {
            installation: self.installation,
            after,
            page: json!({"installation_id":self.installation,"next_cursor":list.last().map(|v|v["id"].as_i64().unwrap()).unwrap_or(after),"items":items,"has_more":false}),
        }
    }
    async fn import_reply(&self, id: i64, after: i64) -> (Uuid, Uuid) {
        let ticket = Uuid::new_v4();
        let message = Uuid::new_v4();
        self.due().await;
        assert!(connect_updates::process_one_with_transport(
            &self.db,
            &self.page(
                after,
                json!([event(id, "support.reply", ticket, Some(message))])
            )
        )
        .await
        .unwrap());
        (ticket, message)
    }
    async fn notifications(&self, h: &HeaderMap) -> Value {
        let (status, v) = call(
            &self.app,
            h,
            "GET",
            "/api/v1/connect/services/notifications",
            Value::Null,
        )
        .await;
        assert_eq!(status, 200, "{v}");
        v
    }
}
async fn user_session(db: &PgPool, tenant: Uuid, user: Uuid, role: &str) -> HeaderMap {
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-a-login',$4) ON CONFLICT(id) DO NOTHING").bind(user).bind(tenant).bind(format!("{}@example.test",user.simple())).bind(role).execute(db).await.unwrap();
    let token = format!("synthetic-session-{}", Uuid::new_v4());
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(suncharts_engine::oauth::hash(&token)).bind(tenant).bind(user).execute(db).await.unwrap();
    let mut h = HeaderMap::new();
    h.insert("origin", HeaderValue::from_static(ORIGIN));
    h.insert(
        "cookie",
        HeaderValue::from_str(&format!("sce_session={token}")).unwrap(),
    );
    h
}
async fn call(
    app: &Router,
    h: &HeaderMap,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    for (k, v) in h {
        request = request.header(k, v);
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
fn event(id: i64, kind: &str, resource: Uuid, message: Option<Uuid>) -> Value {
    json!({"id":id,"kind":kind,"resource_id":resource,"message_id":message,"created_at":Utc::now()})
}
struct PageTransport {
    installation: Uuid,
    after: i64,
    page: Value,
}
#[async_trait::async_trait]
impl EventTransport for PageTransport {
    async fn fetch(&self, installation: Uuid, key: &str, after: i64) -> Result<Value> {
        assert_eq!(installation, self.installation);
        assert_eq!(after, self.after);
        assert_eq!(key, "scs_inst_synthetic_update_credential_123456789");
        Ok(self.page.clone())
    }
}
#[tokio::test]
async fn durable_notifications_are_tenant_scoped_per_user_and_replay_safe() {
    let f = Fixture::new().await;
    let (ticket, message) = f.import_reply(1, 0).await;
    let data = f.notifications(&f.headers).await;
    assert_eq!(data["unread_count"], 1);
    assert_eq!(data["items"][0]["ticket_id"], ticket.to_string());
    assert_eq!(data["items"][0]["message_id"], message.to_string());
    assert!(!data.to_string().contains("scs_inst_"));
    let other = user_session(&f.db, f.tenant, Uuid::new_v4(), "front_desk").await;
    assert_eq!(f.notifications(&other).await["unread_count"], 1);
    let foreign = user_session(&f.db, Uuid::new_v4(), Uuid::new_v4(), "owner").await;
    assert_eq!(f.notifications(&foreign).await["unread_count"], 0);
    let reader = user_session(&f.db, f.tenant, Uuid::new_v4(), "read_only").await;
    assert_eq!(
        call(
            &f.app,
            &reader,
            "GET",
            "/api/v1/connect/services/notifications",
            Value::Null
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(
            &f.app,
            &HeaderMap::new(),
            "GET",
            "/api/v1/connect/services/notifications",
            Value::Null
        )
        .await
        .0,
        401
    );
    let path = "/api/v1/connect/services/notifications/read";
    let body = json!({"event_ids":[data["items"][0]["id"]]});
    assert_eq!(
        call(&f.app, &foreign, "POST", path, body.clone()).await.0,
        404
    );
    let mut bad = f.headers.clone();
    bad.insert("origin", HeaderValue::from_static("https://wrong.example"));
    assert_eq!(call(&f.app, &bad, "POST", path, body.clone()).await.0, 403);
    let (status, read) = call(&f.app, &f.headers, "POST", path, body.clone()).await;
    assert_eq!(status, 200);
    assert_eq!(read["unread_count"], 0);
    assert_eq!(call(&f.app, &f.headers, "POST", path, body).await.0, 200);
    assert_eq!(f.notifications(&other).await["unread_count"], 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM connect_notification_reads")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    // Restoring an older cursor cannot create another notification from the same remote event.
    sqlx::query("UPDATE connect_update_sync SET cloud_cursor=0,next_attempt_at=clock_timestamp()")
        .execute(&f.db)
        .await
        .unwrap();
    let page = f.page(0, json!([event(1, "support.reply", ticket, Some(message))]));
    assert!(connect_updates::process_one_with_transport(&f.db, &page)
        .await
        .unwrap());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM connect_update_events")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    f.db.close().await;
}
#[tokio::test]
async fn malformed_pages_and_audit_failures_cannot_advance_or_publish() {
    let f = Fixture::new().await;
    let ticket = Uuid::new_v4();
    let message = Uuid::new_v4();
    let valid = json!({"installation_id":f.installation,"items":[event(1,"support.reply",ticket,Some(message))],"next_cursor":1,"has_more":false});
    let mut wrong = valid.clone();
    wrong["installation_id"] = json!(Uuid::new_v4());
    let mut unordered = valid.clone();
    unordered["items"] = json!([
        event(2, "support.updated", ticket, None),
        event(1, "support.updated", ticket, None)
    ]);
    let mut missing_message = valid.clone();
    missing_message["items"][0]["message_id"] = Value::Null;
    let mut content = valid.clone();
    content["items"][0]["message"] = json!("never persist remote content");
    let mut skipped = valid.clone();
    skipped["next_cursor"] = json!(2);
    for page in [wrong, unordered, missing_message, content, skipped] {
        f.due().await;
        assert!(connect_updates::process_one_with_transport(
            &f.db,
            &PageTransport {
                installation: f.installation,
                after: 0,
                page
            }
        )
        .await
        .is_err());
    }
    sqlx::query("CREATE FUNCTION reject_update_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='connect.service_change_received' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&f.db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_update_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_update_audit()").execute(&f.db).await.unwrap();
    f.due().await;
    assert!(connect_updates::process_one_with_transport(
        &f.db,
        &PageTransport {
            installation: f.installation,
            after: 0,
            page: valid.clone()
        }
    )
    .await
    .is_err());
    let (cursor, events): (i64, i64) = sqlx::query_as(
        "SELECT cloud_cursor,(SELECT count(*) FROM connect_update_events) FROM connect_update_sync",
    )
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!((cursor, events), (0, 0));
    sqlx::query("DROP TRIGGER reject_update_audit ON audit_events")
        .execute(&f.db)
        .await
        .unwrap();
    f.due().await;
    connect_updates::process_one_with_transport(
        &f.db,
        &PageTransport {
            installation: f.installation,
            after: 0,
            page: valid,
        },
    )
    .await
    .unwrap();
    let id: i64 = sqlx::query_scalar("SELECT id FROM connect_update_events")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(id, 1);
    sqlx::query("CREATE FUNCTION reject_read_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='connect.notification_acknowledged' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&f.db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_read_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_read_audit()").execute(&f.db).await.unwrap();
    assert_eq!(
        call(
            &f.app,
            &f.headers,
            "POST",
            "/api/v1/connect/services/notifications/read",
            json!({"event_ids":[id]})
        )
        .await
        .0,
        500
    );
    assert_eq!(f.notifications(&f.headers).await["unread_count"], 1);
    f.db.close().await;
}
async fn stream(f: &Fixture, headers: &HeaderMap, after: Option<i64>) -> Body {
    let mut request = Request::builder().uri("/api/v1/connect/services/events");
    for (k, v) in headers {
        request = request.header(k, v);
    }
    if let Some(after) = after {
        request = request.header("last-event-id", after.to_string());
    }
    let response = f
        .app
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    response.into_body()
}
async fn frame(body: &mut Body) -> Option<String> {
    tokio::time::timeout(Duration::from_secs(5), body.frame())
        .await
        .unwrap()
        .map(|v| String::from_utf8(v.unwrap().into_data().unwrap().to_vec()).unwrap())
}
#[tokio::test]
async fn initial_zero_cursor_replays_changes_after_early_disconnect() {
    let f = Fixture::new().await;
    let mut initial = stream(&f, &f.headers, None).await;
    let ready = frame(&mut initial).await.unwrap();
    assert!(ready.contains("event: ready"));
    assert!(ready.contains("id: 0\n"));
    drop(initial);
    f.import_reply(1, 0).await;
    let mut resumed = stream(&f, &f.headers, Some(0)).await;
    let ready = frame(&mut resumed).await.unwrap();
    assert!(ready.contains("id: 0\n"));
    let change = frame(&mut resumed).await.unwrap();
    assert!(change.contains("event: service.change"));
    assert!(change.contains("id: 1\n"));
    drop(resumed);
    f.db.close().await;
}
#[tokio::test]
async fn service_stream_baselines_replays_and_stops_after_logout() {
    let f = Fixture::new().await;
    f.import_reply(1, 0).await;
    let mut feed = stream(&f, &f.headers, None).await;
    let ready = frame(&mut feed).await.unwrap();
    assert!(ready.contains("event: ready"));
    assert!(ready.contains("unread_count"));
    assert!(ready.contains("\"cursor\":1"));
    f.import_reply(2, 1).await;
    let change = frame(&mut feed).await.unwrap();
    assert!(change.contains("event: service.change"));
    assert!(change.contains("id: 2"));
    assert!(!change.contains("scs_inst_"));
    // Acknowledge in another request; the live stream publishes the per-user snapshot.
    let data = f.notifications(&f.headers).await;
    let ids: Vec<_> = data["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].clone())
        .collect();
    assert_eq!(
        call(
            &f.app,
            &f.headers,
            "POST",
            "/api/v1/connect/services/notifications/read",
            json!({"event_ids":ids})
        )
        .await
        .0,
        200
    );
    // Drain the already-buffered arrival snapshot before inspecting the ack snapshot.
    for _ in 0..3 {
        let value = frame(&mut feed).await.unwrap();
        if value.contains("\"unread_count\":0") {
            break;
        }
    }
    sqlx::query("DELETE FROM browser_sessions WHERE user_id=$1")
        .bind(f.user)
        .execute(&f.db)
        .await
        .unwrap();
    assert!(frame(&mut feed).await.is_none());
    let headers = user_session(&f.db, f.tenant, f.user, "owner").await;
    let mut resumed = stream(&f, &headers, Some(1)).await;
    let _ = frame(&mut resumed).await.unwrap();
    let replay = frame(&mut resumed).await.unwrap();
    assert!(replay.contains("id: 2"));
    sqlx::query("UPDATE browser_users SET role='read_only' WHERE id=$1")
        .bind(f.user)
        .execute(&f.db)
        .await
        .unwrap();
    assert!(frame(&mut resumed).await.is_none());
    drop(resumed);
    f.db.close().await;
}
struct RevokeDuringFetch {
    db: PgPool,
    page: Value,
}
#[async_trait::async_trait]
impl EventTransport for RevokeDuringFetch {
    async fn fetch(&self, _: Uuid, _: &str, _: i64) -> Result<Value> {
        sqlx::query("UPDATE connect_service_settings SET revoked=true,enabled=false")
            .execute(&self.db)
            .await?;
        Ok(self.page.clone())
    }
}
#[tokio::test]
async fn installation_change_and_revocation_fence_late_cloud_responses() {
    let f = Fixture::new().await;
    let page = f.page(
        0,
        json!([event(
            1,
            "support.reply",
            Uuid::new_v4(),
            Some(Uuid::new_v4())
        )]),
    );
    assert!(connect_updates::process_one_with_transport(
        &f.db,
        &RevokeDuringFetch {
            db: f.db.clone(),
            page: page.page.clone()
        }
    )
    .await
    .is_err());
    assert_eq!(f.notifications(&f.headers).await["unread_count"], 0);
    sqlx::query("UPDATE connect_service_settings SET revoked=false,enabled=true")
        .execute(&f.db)
        .await
        .unwrap();
    f.due().await;
    connect_updates::process_one_with_transport(&f.db, &page)
        .await
        .unwrap();
    assert_eq!(f.notifications(&f.headers).await["unread_count"], 1);
    let mut live = stream(&f, &f.headers, None).await;
    assert!(frame(&mut live).await.unwrap().contains("event: ready"));
    let new_install = Uuid::new_v4();
    let encrypted = seal_secret(
        f.tenant,
        f.setting,
        "connect-service",
        "scs_inst_synthetic_rotated_update_credential",
    );
    sqlx::query("INSERT INTO connect_service_credentials(tenant_id,setting_id,revision,installation_id,encrypted_token) VALUES($1,$2,2,$3,$4)").bind(f.tenant).bind(f.setting).bind(new_install).bind(encrypted).execute(&f.db).await.unwrap();
    sqlx::query("UPDATE connect_service_settings SET installation_id=$2,credential_revision=2 WHERE tenant_id=$1").bind(f.tenant).bind(new_install).execute(&f.db).await.unwrap();
    let reset = frame(&mut live).await.unwrap();
    assert!(reset.contains("event: reset"));
    assert!(reset.contains("id: 1\n"));
    assert!(reset.contains("\"unread_count\":0"));
    drop(live);
    assert_eq!(f.notifications(&f.headers).await["unread_count"], 0);
    assert_eq!(
        call(
            &f.app,
            &f.headers,
            "POST",
            "/api/v1/connect/services/notifications/read",
            json!({"event_ids":[1]})
        )
        .await
        .0,
        404
    );
    connect_updates::wake(&f.db, f.tenant, new_install, 999)
        .await
        .unwrap();
    let cursor: i64 =
        sqlx::query_scalar("SELECT cloud_cursor FROM connect_update_sync WHERE installation_id=$1")
            .bind(f.installation)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(cursor, 1);
    f.db.close().await;
}
#[tokio::test]
async fn tenant_cursor_allocation_cannot_skip_a_later_committing_event() {
    let f = Fixture::new().await;
    let mut first = f.db.begin().await.unwrap();
    sqlx::query("INSERT INTO connect_update_events(tenant_id,installation_id,kind,resource_id,message_id,cloud_id) VALUES($1,$2,'support.reply',$3,$4,1)").bind(f.tenant).bind(f.installation).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&mut *first).await.unwrap();
    let (allocated, allocation) = tokio::sync::oneshot::channel();
    let (release, ready) = tokio::sync::oneshot::channel();
    let db = f.db.clone();
    let tenant = f.tenant;
    let install = f.installation;
    let mut second = tokio::spawn(async move {
        let mut tx = db.begin().await.unwrap();
        let id:i64=sqlx::query_scalar("INSERT INTO connect_update_events(tenant_id,installation_id,kind,resource_id,message_id,cloud_id) VALUES($1,$2,'support.reply',$3,$4,2) RETURNING id").bind(tenant).bind(install).bind(Uuid::new_v4()).bind(Uuid::new_v4()).fetch_one(&mut *tx).await.unwrap();
        let _ = allocated.send(id);
        let _ = ready.await;
        tx.commit().await.unwrap();
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut second)
            .await
            .is_err(),
        "second writer must wait for the first commit"
    );
    first.commit().await.unwrap();
    assert_eq!(allocation.await.unwrap(), 2);
    let max: i64 = sqlx::query_scalar("SELECT max(id) FROM connect_update_events")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(max, 1);
    release.send(()).unwrap();
    second.await.unwrap();
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM connect_update_events WHERE tenant_id=$1 AND id>1 ORDER BY id",
    )
    .bind(f.tenant)
    .fetch_all(&f.db)
    .await
    .unwrap();
    assert_eq!(ids, vec![2]);
    f.db.close().await;
}
#[tokio::test]
async fn reminder_notice_requests_evidence_but_only_committed_local_results_reach_browser() {
    let f = Fixture::new().await;
    let patient = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    let reminder = Uuid::new_v4();
    let sender = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-UPDATES','Synthetic','Reminder','1990-01-01')").bind(f.tenant).bind(patient).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,now()+interval '1 hour',now()+interval '90 minutes','booked')").bind(f.tenant).bind(appointment).bind(patient).bind(f.user).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO reminder_sender_settings(tenant_id,id,from_email,delivery_mode,enabled,verified) VALUES($1,$2,'synthetic@example.test','suncharts_connect',true,true)").bind(f.tenant).bind(sender).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO reminder_credentials(tenant_id,setting_id,revision,from_email,delivery_mode,connect_setting_id,connect_revision) VALUES($1,$2,1,'synthetic@example.test','suncharts_connect',$3,1)").bind(f.tenant).bind(sender).bind(f.setting).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO appointment_reminders(tenant_id,id,appointment_id,patient_id,request_id,creation_hash,definition_key,before_minutes,due_at,starts_at,appointment_version,channel,destination,automatic_email,status,sender_setting_id,sender_revision,provider_id,last_poll_at) VALUES($1,$2,$3,$4,$2,'synthetic-hash','custom-update',120,now(),now()+interval '1 hour',1,'email','delivered@example.test',true,'accepted',$5,1,$2,now())").bind(f.tenant).bind(reminder).bind(appointment).bind(patient).bind(sender).execute(&f.db).await.unwrap();
    let count_before: i64 = sqlx::query_scalar("SELECT count(*) FROM connect_update_events")
        .fetch_one(&f.db)
        .await
        .unwrap();
    connect_updates::process_one_with_transport(
        &f.db,
        &f.page(0, json!([event(1, "reminder.delivery", reminder, None)])),
    )
    .await
    .unwrap();
    let (status, poll): (String, Option<chrono::DateTime<Utc>>) =
        sqlx::query_as("SELECT status,last_poll_at FROM appointment_reminders WHERE id=$1")
            .bind(reminder)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(status, "accepted");
    assert!(poll.is_none());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM connect_update_events")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(
        count, count_before,
        "remote notice must not publish an unverified local delivery status"
    );
    let mut tx = f.db.begin().await.unwrap();
    sqlx::query(
        "UPDATE appointment_reminders SET status='delivered',version=version+1 WHERE id=$1",
    )
    .bind(reminder)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("SELECT reminder_record_event($1,$2,$3,'provider_delivery_checked','Synthetic verified provider receipt')").bind(f.tenant).bind(reminder).bind(f.user).execute(&mut *tx).await.unwrap();
    tx.rollback().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM connect_update_events")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(count, count_before);
    let mut tx = f.db.begin().await.unwrap();
    sqlx::query(
        "UPDATE appointment_reminders SET status='delivered',version=version+1 WHERE id=$1",
    )
    .bind(reminder)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("SELECT reminder_record_event($1,$2,$3,'provider_delivery_checked','Synthetic verified provider receipt')").bind(f.tenant).bind(reminder).bind(f.user).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let event: (String, Uuid, Uuid) = sqlx::query_as(
        "SELECT kind,resource_id,appointment_id FROM connect_update_events WHERE resource_id=$1",
    )
    .bind(reminder)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(event, ("reminder.updated".into(), reminder, appointment));
    f.db.close().await;
}

fn seal_secret(tenant: Uuid, id: Uuid, purpose: &str, secret: &str) -> Vec<u8> {
    use aws_lc_rs::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    use rand::RngCore;
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &[42u8; 32]).unwrap());
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let mut bytes = secret.as_bytes().to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(format!("suncharts:{purpose}:{tenant}:{id}:v1")),
        &mut bytes,
    )
    .unwrap();
    let mut output = vec![1u8];
    output.extend(nonce);
    output.extend(bytes);
    output
}

struct WakeDuringFetch {
    db: PgPool,
    tenant: Uuid,
    page: Value,
}
#[async_trait::async_trait]
impl EventTransport for WakeDuringFetch {
    async fn fetch(&self, installation: Uuid, _: &str, after: i64) -> Result<Value> {
        assert_eq!(after, 0);
        connect_updates::wake(&self.db, self.tenant, installation, 2).await?;
        Ok(self.page.clone())
    }
}
#[tokio::test]
async fn websocket_hint_during_fetch_keeps_newer_cursor_immediately_due() {
    let f = Fixture::new().await;
    let first = event(1, "support.updated", Uuid::new_v4(), None);
    let transport = WakeDuringFetch {
        db: f.db.clone(),
        tenant: f.tenant,
        page: f.page(0, json!([first])).page,
    };
    assert!(
        connect_updates::process_one_with_transport(&f.db, &transport)
            .await
            .unwrap()
    );
    let (cursor,wake,due):(i64,i64,bool)=sqlx::query_as("SELECT cloud_cursor,wake_cursor,next_attempt_at<=clock_timestamp() FROM connect_update_sync WHERE tenant_id=$1").bind(f.tenant).fetch_one(&f.db).await.unwrap();
    assert_eq!((cursor, wake, due), (1, 2, true));
    let second = f.page(
        1,
        json!([event(2, "support.updated", Uuid::new_v4(), None)]),
    );
    assert!(connect_updates::process_one_with_transport(&f.db, &second)
        .await
        .unwrap());
    let (cursor,wake,due):(i64,i64,bool)=sqlx::query_as("SELECT cloud_cursor,wake_cursor,next_attempt_at<=clock_timestamp() FROM connect_update_sync WHERE tenant_id=$1").bind(f.tenant).fetch_one(&f.db).await.unwrap();
    assert_eq!((cursor, wake, due), (2, 2, false));
    f.db.close().await;
}
