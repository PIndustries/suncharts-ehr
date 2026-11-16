// SPDX-License-Identifier: AGPL-3.0-only
//! Staff mark an appointment as needing no intake form, and undo the mark.
//! Synthetic data only.
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
        let schema = format!("intake_not_needed_{}", Uuid::new_v4().simple());
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
        let cookie = Self::session(&db, tenant, user).await;
        let app = Self::app(&db);
        Self {
            db,
            app,
            tenant,
            user,
            cookie,
        }
    }
    fn app(db: &PgPool) -> Router {
        suncharts_engine::app(State {
            backend: Arc::new(PostgresBackend(db.clone())),
            secret: "unused-synthetic".into(),
            allow_legacy_gateway: false,
            issuer: "suncharts".into(),
            audience: "suncharts-engine".into(),
            browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
        })
    }
    async fn session(db: &PgPool, tenant: Uuid, user: Uuid) -> String {
        let token = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')")
            .bind(format!("{:x}",Sha256::digest(token.as_bytes()))).bind(tenant).bind(user)
            .execute(db).await.unwrap();
        format!("sce_session={token}")
    }
    async fn request_with(
        &self,
        cookie: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("Origin", ORIGIN)
            .header("Cookie", cookie);
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
    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let cookie = self.cookie.clone();
        self.request_with(&cookie, method, path, body).await
    }
    async fn add_patient(&self) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Synthetic','Sample','1990-01-01')")
            .bind(self.tenant).bind(id).bind(id.to_string()).execute(&self.db).await.unwrap();
        id
    }
    async fn add_appointment(&self, patient: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        let starts = Utc::now() + Duration::days(2);
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status,title) VALUES($1,$2,$3,$4,$5,$5+interval '1 hour','booked','Synthetic visit')")
            .bind(self.tenant).bind(id).bind(patient).bind(self.user).bind(starts)
            .execute(&self.db).await.unwrap();
        id
    }
    /// A second practice with its own appointment, for cross-tenant checks.
    async fn other_tenant_appointment(&self) -> Uuid {
        let tenant = Uuid::new_v4();
        let clinician = Uuid::new_v4();
        sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,display_name) VALUES($1,$2,'other@example.test','unused','owner','Other Synthetic Owner')")
            .bind(clinician).bind(tenant).execute(&self.db).await.unwrap();
        let patient = Uuid::new_v4();
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Synthetic','Other','1990-01-01')")
            .bind(tenant).bind(patient).bind(patient.to_string()).execute(&self.db).await.unwrap();
        let appointment = Uuid::new_v4();
        let starts = Utc::now() + Duration::days(2);
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status,title) VALUES($1,$2,$3,$4,$5,$5+interval '1 hour','booked','Synthetic visit')")
            .bind(tenant).bind(appointment).bind(patient).bind(clinician).bind(starts)
            .execute(&self.db).await.unwrap();
        appointment
    }
    async fn mark(&self, appointment: Uuid, body: Value) -> (StatusCode, Value) {
        self.request(
            "POST",
            &format!("/api/v1/previsit/appointments/{appointment}/not-needed"),
            Some(body),
        )
        .await
    }
    async fn undo(&self, appointment: Uuid) -> (StatusCode, Value) {
        self.request(
            "DELETE",
            &format!("/api/v1/previsit/appointments/{appointment}/not-needed"),
            None,
        )
        .await
    }
    async fn readiness(&self, cookie: Option<&str>) -> Vec<Value> {
        let (status, body) = match cookie {
            Some(cookie) => {
                let cookie = cookie.to_owned();
                self.request_with(&cookie, "GET", "/api/v1/previsit/readiness", None)
                    .await
            }
            None => {
                self.request("GET", "/api/v1/previsit/readiness", None)
                    .await
            }
        };
        assert_eq!(status, StatusCode::OK, "{body}");
        body["items"].as_array().unwrap().clone()
    }
    fn status_for(items: &[Value], appointment: Uuid) -> String {
        items
            .iter()
            .find(|item| item["appointment_id"] == json!(appointment))
            .unwrap_or_else(|| panic!("appointment {appointment} missing from readiness"))["status"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    async fn active_marks(&self, appointment: Uuid) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM previsit_intake_not_needed WHERE tenant_id=$1 AND appointment_id=$2 AND cleared_at IS NULL")
            .bind(self.tenant).bind(appointment).fetch_one(&self.db).await.unwrap()
    }
    async fn audit_actions(&self, appointment: Uuid) -> Vec<String> {
        sqlx::query_scalar("SELECT action FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND action LIKE 'previsit.intake_not_needed%' ORDER BY action")
            .bind(self.tenant).bind(appointment).fetch_all(&self.db).await.unwrap()
    }
}

#[tokio::test]
async fn marking_shows_not_needed_in_readiness_and_undoes_cleanly() {
    let f = Fixture::new().await;
    let patient = f.add_patient().await;
    let marked = f.add_appointment(patient).await;
    let other = f.add_appointment(patient).await;
    // The worklist starts plain.
    let items = f.readiness(None).await;
    assert_eq!(Fixture::status_for(&items, marked), "not_issued");
    assert_eq!(Fixture::status_for(&items, other), "not_issued");

    let (status, body) = f.mark(marked, json!({"reason":"Follow-up visit"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({"appointment_id":marked,"status":"not_needed"}));
    let items = f.readiness(None).await;
    assert_eq!(Fixture::status_for(&items, marked), "not_needed");
    assert_eq!(Fixture::status_for(&items, other), "not_issued");
    assert_eq!(
        f.audit_actions(marked).await,
        vec!["previsit.intake_not_needed_marked".to_owned()]
    );

    // Marking again changes nothing and stays one active row.
    let (status, body) = f.mark(marked, json!({"reason":"Follow-up visit"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(f.active_marks(marked).await, 1);
    assert_eq!(
        f.audit_actions(marked).await,
        vec!["previsit.intake_not_needed_marked".to_owned()],
        "a repeat mark records no second state change"
    );

    // Undoing returns the appointment to not_issued.
    let (status, body) = f.undo(marked).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({"appointment_id":marked,"status":"not_issued"}));
    assert_eq!(f.active_marks(marked).await, 0);
    let items = f.readiness(None).await;
    assert_eq!(Fixture::status_for(&items, marked), "not_issued");
    assert_eq!(
        f.audit_actions(marked).await,
        vec![
            "previsit.intake_not_needed_cleared".to_owned(),
            "previsit.intake_not_needed_marked".to_owned()
        ]
    );
    let cleared: (Option<Uuid>, bool) = sqlx::query_as(
        "SELECT cleared_by, count(*)=1 FROM previsit_intake_not_needed WHERE tenant_id=$1 AND appointment_id=$2 GROUP BY cleared_by",
    )
    .bind(f.tenant)
    .bind(marked)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(cleared, (Some(f.user), true));
    // Undoing again is harmless and records nothing further.
    let (status, _) = f.undo(marked).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        f.audit_actions(marked).await,
        vec![
            "previsit.intake_not_needed_cleared".to_owned(),
            "previsit.intake_not_needed_marked".to_owned()
        ]
    );
}

#[tokio::test]
async fn forms_and_marks_never_both_stand_on_one_appointment() {
    let f = Fixture::new().await;
    let patient = f.add_patient().await;
    let booked = f.add_appointment(patient).await;

    // A form already sent cannot be marked away.
    let (status, sent) = f
        .request(
            "POST",
            &format!("/api/v1/patients/{patient}/intake-forms"),
            Some(json!({"appointment_id": booked})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{sent}");
    let (status, body) = f.mark(booked, json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        body["message"],
        "A form has already been sent for this appointment."
    );
    assert_eq!(f.active_marks(booked).await, 0);

    // Marked first, then a form sent: the mark clears in the same transaction.
    let marked = f.add_appointment(patient).await;
    assert_eq!(f.mark(marked, json!({})).await.0, StatusCode::OK);
    assert_eq!(
        Fixture::status_for(&f.readiness(None).await, marked),
        "not_needed"
    );
    let (status, sent) = f
        .request(
            "POST",
            &format!("/api/v1/patients/{patient}/intake-forms"),
            Some(json!({"appointment_id": marked})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{sent}");
    assert_eq!(f.active_marks(marked).await, 0);
    let items = f.readiness(None).await;
    assert_eq!(Fixture::status_for(&items, marked), "sent");
    assert_eq!(
        f.audit_actions(marked).await,
        vec![
            "previsit.intake_not_needed_cleared".to_owned(),
            "previsit.intake_not_needed_marked".to_owned()
        ]
    );
}

#[tokio::test]
async fn only_the_roles_that_issue_forms_may_mark_and_only_in_their_tenant() {
    let f = Fixture::new().await;
    let patient = f.add_patient().await;
    let appointment = f.add_appointment(patient).await;
    let foreign = f.other_tenant_appointment().await;

    // A read-only staff session sees the appointment but may not mark it.
    let readonly = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,display_name) VALUES($1,$2,'reader@example.test','unused','read_only','Synthetic Reader')")
        .bind(readonly).bind(f.tenant).execute(&f.db).await.unwrap();
    let cookie = Fixture::session(&f.db, f.tenant, readonly).await;
    let (status, body) = f
        .request_with(
            &cookie,
            "POST",
            &format!("/api/v1/previsit/appointments/{appointment}/not-needed"),
            Some(json!({"reason":"Should not be kept"})),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(f.active_marks(appointment).await, 0);
    let (status, body) = f
        .request_with(
            &cookie,
            "DELETE",
            &format!("/api/v1/previsit/appointments/{appointment}/not-needed"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // Another tenant's appointment does not exist here, in either direction.
    let (status, body) = f.mark(foreign, json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let (status, body) = f.undo(foreign).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let foreign_marks: i64 = sqlx::query_scalar("SELECT count(*) FROM previsit_intake_not_needed")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(foreign_marks, 0);
    // A mark here is never visible to that other tenant's worklist.
    assert_eq!(f.mark(appointment, json!({})).await.0, StatusCode::OK);
    let other_tenant: Uuid = sqlx::query_scalar("SELECT tenant_id FROM appointments WHERE id=$1")
        .bind(foreign)
        .fetch_one(&f.db)
        .await
        .unwrap();
    let other_user: Uuid = sqlx::query_scalar(
        "SELECT id FROM browser_users WHERE tenant_id=$1 AND role='owner' AND email='other@example.test'",
    )
    .bind(other_tenant)
    .fetch_one(&f.db)
    .await
    .unwrap();
    let other_cookie = Fixture::session(&f.db, other_tenant, other_user).await;
    let items = f.readiness(Some(&other_cookie)).await;
    assert_eq!(Fixture::status_for(&items, foreign), "not_issued");
}
