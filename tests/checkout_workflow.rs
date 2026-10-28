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
const SECRET: &str = "synthetic-checkout-test-secret";
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
    let schema = format!("checkout_test_{}", Uuid::new_v4().simple());
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
    let v = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-CHECKOUT','Avery','Synthetic','1990-01-01')").bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','completed')").bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,$7,$5,now())").bind(a.tenant_id).bind(v).bind(p).bind(appointment).bind(a.sub).bind(json!({"subjective":"PRIVATE-SOAP-MUST-NOT-BE-IN-AVS","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"})).bind(json!({"systolic_mm_hg":120,"diastolic_mm_hg":80,"heart_rate_bpm":70,"temperature_c":36.7,"weight_kg":70,"height_cm":170,"oxygen_saturation_pct":98})).execute(&db).await.unwrap();
    (db, a, p, v)
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
fn path(p: Uuid, v: Uuid) -> String {
    format!("/api/v1/patients/{p}/visits/{v}/checkout")
}
fn release(digest: &Value) -> Value {
    json!({"action":"release_avs","instructions":"Synthetic patient instructions.\nContinue the reviewed treatment plan.","follow_up_instructions":"Return in two weeks.","reason":"Synthetic clinician review","reviewed":true,"reviewed_snapshot_digest":digest})
}
#[tokio::test]
async fn released_avs_checkout_and_patient_access_are_scoped_immutable_and_independent() {
    let (db, a, p, v) = setup().await;
    let r = app(db.clone());
    let base = path(p, v);
    let actions = format!("{base}/actions");
    let (status, empty) = call(&r, &a, "GET", &base, Value::Null, None).await;
    assert_eq!(status, 200, "{empty}");
    assert_eq!(empty["version"], 0);
    assert!(empty["current_avs"].is_null());
    assert!(!empty.to_string().contains("PRIVATE-SOAP"));
    assert_eq!(empty["preview_snapshot"]["vitals"]["heart_rate_bpm"], 70);
    assert!(empty["preview_snapshot"]["visit"]["clinician_label"]
        .as_str()
        .unwrap()
        .ends_with("@example.test"));
    assert_eq!(
        empty["preview_snapshot"]["list_reviews"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        empty["preview_snapshot"]["list_reviews"][0]["review_state"],
        "unknown"
    );
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(&r, &other, "GET", &base, Value::Null, None).await.0,
        404
    );
    let mut desk = a.clone();
    desk.sub = Uuid::new_v4();
    desk.role = Role::FrontDesk;
    user(&db, &a, desk.sub, "front_desk", false).await;
    assert_eq!(
        call(
            &r,
            &desk,
            "POST",
            &actions,
            release(&empty["preview_digest"]),
            Some(0)
        )
        .await
        .0,
        403
    );
    let mut another = a.clone();
    another.sub = Uuid::new_v4();
    assert_eq!(
        call(
            &r,
            &another,
            "POST",
            &actions,
            release(&empty["preview_digest"]),
            Some(0)
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &actions,
            release(&empty["preview_digest"]),
            None
        )
        .await
        .0,
        428
    );
    assert_eq!(
        call(
            &r,
            &desk,
            "POST",
            &actions,
            json!({"action":"checkout","reason":"Synthetic checkout"}),
            Some(0)
        )
        .await
        .0,
        409
    );
    let (status, released) = call(
        &r,
        &a,
        "POST",
        &actions,
        release(&empty["preview_digest"]),
        Some(0),
    )
    .await;
    assert_eq!(status, 200, "{released}");
    assert_eq!(released["version"], 1);
    assert_eq!(released["current_avs"]["version"], 1);
    assert_eq!(released["current_avs"]["released_by"], json!(a.sub));
    assert!(!released.to_string().contains("PRIVATE-SOAP"));
    assert_eq!(
        call(
            &r,
            &desk,
            "POST",
            &actions,
            json!({"action":"checkout","reason":"Synthetic checkout"}),
            Some(1)
        )
        .await
        .0,
        409
    );
    let (status,delivered)=call(&r,&desk,"POST",&actions,json!({"action":"delivery","method":"print","avs_version":1,"reason":"Synthetic printed instructions handed to patient"}),Some(1)).await;
    assert_eq!(status, 200, "{delivered}");
    let (status, checked) = call(
        &r,
        &desk,
        "POST",
        &actions,
        json!({"action":"checkout","reason":"Synthetic departure reviewed"}),
        Some(2),
    )
    .await;
    assert_eq!(status, 200, "{checked}");
    assert_eq!(checked["checkout"]["completed"], true);
    let mut patient = a.clone();
    patient.role = Role::Patient;
    patient.patient_id = Some(p);
    let portal = format!("/api/v1/portal/visits/{v}/avs");
    let (status, avs) = call(&r, &patient, "GET", &portal, Value::Null, None).await;
    assert_eq!(status, 200);
    assert_eq!(avs["version"], 1);
    assert!(avs["reason"].is_null());
    assert!(!avs.to_string().contains("PRIVATE-SOAP"));
    patient.patient_id = Some(Uuid::new_v4());
    assert_eq!(
        call(&r, &patient, "GET", &portal, Value::Null, None)
            .await
            .0,
        404
    );
    assert_eq!(call(&r, &a, "GET", &portal, Value::Null, None).await.0, 403);
    let (status, amended) = call(
        &r,
        &a,
        "POST",
        &actions,
        release(&checked["preview_digest"]),
        Some(3),
    )
    .await;
    assert_eq!(status, 200, "{amended}");
    assert_eq!(amended["current_avs"]["version"], 2);
    assert_eq!(amended["releases"].as_array().unwrap().len(), 2);
    assert_eq!(amended["checkout"]["completed"], false);
    assert_eq!(
        call(
            &r,
            &desk,
            "POST",
            &actions,
            json!({"action":"delivery","method":"print","avs_version":1,"reason":"Old version"}),
            Some(4)
        )
        .await
        .0,
        409
    );
    assert!(
        sqlx::query("UPDATE avs_releases SET content='{}' WHERE tenant_id=$1 AND visit_id=$2")
            .bind(a.tenant_id)
            .bind(v)
            .execute(&db)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM checkout_events WHERE tenant_id=$1 AND visit_id=$2")
            .bind(a.tenant_id)
            .bind(v)
            .execute(&db)
            .await
            .is_err()
    );
    let ledger: i64 = sqlx::query_scalar("SELECT count(*) FROM billing_entries WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .fetch_one(&db)
        .await
        .unwrap();
    let acknowledgments: i64 =
        sqlx::query_scalar("SELECT count(*) FROM lab_acknowledgments WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!((ledger, acknowledgments), (0, 0));
    db.close().await;
}
#[tokio::test]
async fn avs_preview_change_concurrency_and_audit_failure_do_not_release_unreviewed_content() {
    let (db, a, p, v) = setup().await;
    let r = app(db.clone());
    let base = path(p, v);
    let actions = format!("{base}/actions");
    let (_, before) = call(&r, &a, "GET", &base, Value::Null, None).await;
    let med = Uuid::new_v4();
    sqlx::query("INSERT INTO clinical_entries(tenant_id,id,patient_id,kind,content,created_by,updated_by) VALUES($1,$2,$3,'medication',$4,$5,$5)").bind(a.tenant_id).bind(med).bind(p).bind(json!({"title":"Synthetic medication","status":"active","verification":"confirmed","codes":[],"detail":{"dose":"5 mg","route":"oral","frequency":"daily"},"notes":"PRIVATE-MED-NOTES"})).bind(a.sub).execute(&db).await.unwrap();
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &actions,
            release(&before["preview_digest"]),
            Some(0)
        )
        .await
        .0,
        409
    );
    let (_, fresh) = call(&r, &a, "GET", &base, Value::Null, None).await;
    assert_eq!(fresh["preview_snapshot"]["medications"][0]["dose"], "5 mg");
    assert!(!fresh.to_string().contains("PRIVATE-MED-NOTES"));
    for (kind, title, detail) in [
        (
            "allergy",
            "Synthetic allergy",
            json!({"reaction":"Synthetic reaction","severity":"moderate","criticality":"high"}),
        ),
        (
            "problem",
            "Synthetic active problem",
            json!({"problem_type":"problem"}),
        ),
    ] {
        sqlx::query("INSERT INTO clinical_entries(tenant_id,id,patient_id,kind,content,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(p).bind(kind).bind(json!({"title":title,"status":"active","verification":"confirmed","codes":[],"detail":detail,"notes":"PRIVATE-LIST-NOTES"})).bind(a.sub).execute(&db).await.unwrap();
    }
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &actions,
            release(&fresh["preview_digest"]),
            Some(0)
        )
        .await
        .0,
        409
    );
    let (_, fresh) = call(&r, &a, "GET", &base, Value::Null, None).await;
    assert_eq!(
        fresh["preview_snapshot"]["allergies"][0]["reaction"],
        "Synthetic reaction"
    );
    assert_eq!(
        fresh["preview_snapshot"]["problems"][0]["title"],
        "Synthetic active problem"
    );
    assert!(!fresh.to_string().contains("PRIVATE-LIST-NOTES"));
    let body = release(&fresh["preview_digest"]);
    let (first, second) = tokio::join!(
        call(&r, &a, "POST", &actions, body.clone(), Some(0)),
        call(&r, &a, "POST", &actions, body.clone(), Some(0))
    );
    let mut statuses = vec![first.0.as_u16(), second.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, vec![200, 409]);
    sqlx::query("CREATE FUNCTION fail_checkout_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='checkout.avs_release' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_checkout_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_checkout_audit()").execute(&db).await.unwrap();
    let (_, current) = call(&r, &a, "GET", &base, Value::Null, None).await;
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &actions,
            release(&current["preview_digest"]),
            Some(1)
        )
        .await
        .0,
        500
    );
    let (_, after) = call(&r, &a, "GET", &base, Value::Null, None).await;
    assert_eq!(after["version"], 1);
    assert_eq!(after["releases"].as_array().unwrap().len(), 1);
    assert_eq!(after["events"].as_array().unwrap().len(), 1);
    let original: Value =
        sqlx::query_scalar("SELECT note FROM visits WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(v)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(original["subjective"], "PRIVATE-SOAP-MUST-NOT-BE-IN-AVS");
    db.close().await;
}
#[tokio::test]
async fn follow_up_tasks_have_enabled_assignees_versions_owner_permissions_and_atomic_history() {
    let (db, a, p, v) = setup().await;
    let r = app(db.clone());
    let task_create = format!("/api/v1/patients/{p}/visits/{v}/follow-ups");
    let assigned = Uuid::new_v4();
    user(&db, &a, assigned, "front_desk", false).await;
    let request = json!({"request_id":Uuid::new_v4(),"title":"Synthetic result callback","instructions":"Confirm the ordered test and document the callback.","assignee_id":assigned,"due_date":"2026-10-26","reason":"Synthetic follow-up plan"});
    let (status, created) = call(&r, &a, "POST", &task_create, request.clone(), None).await;
    assert_eq!(status, 200, "{created}");
    assert_eq!(created["version"], 1);
    assert_eq!(created["assignee_id"], json!(assigned));
    assert_eq!(created["created_by"], json!(a.sub));
    assert_eq!(created["can_update"], true);
    assert_eq!(
        call(&r, &a, "POST", &task_create, request.clone(), None)
            .await
            .1["id"],
        created["id"]
    );
    let mut changed = request.clone();
    changed["title"] = json!("Changed request");
    assert_eq!(
        call(&r, &a, "POST", &task_create, changed, None).await.0,
        409
    );
    let task_id = created["id"].as_str().unwrap();
    let actions = format!("/api/v1/follow-up/tasks/{task_id}/actions");
    let mut assignee_actor = a.clone();
    assignee_actor.sub = assigned;
    assignee_actor.role = Role::FrontDesk;
    let mut stranger = a.clone();
    stranger.role = Role::Clinician;
    stranger.sub = Uuid::new_v4();
    user(&db, &a, stranger.sub, "clinician", false).await;
    assert_eq!(
        call(
            &r,
            &stranger,
            "POST",
            &actions,
            json!({"action":"complete","reason":"Not assigned"}),
            Some(1)
        )
        .await
        .0,
        403
    );
    let mut readonly = a.clone();
    readonly.role = Role::ReadOnly;
    assert_eq!(
        call(
            &r,
            &readonly,
            "POST",
            &actions,
            json!({"action":"complete","reason":"Read only"}),
            Some(1)
        )
        .await
        .0,
        403
    );
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(
            &r,
            &other,
            "GET",
            &format!("/api/v1/follow-up/tasks/{task_id}"),
            Value::Null,
            None
        )
        .await
        .0,
        404
    );
    let (status, completed) = call(
        &r,
        &assignee_actor,
        "POST",
        &actions,
        json!({"action":"complete","reason":"Synthetic callback documented"}),
        Some(1),
    )
    .await;
    assert_eq!(status, 200, "{completed}");
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["version"], 2);
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &actions,
            json!({"action":"reopen","reason":"Synthetic follow-up still needed"}),
            Some(1)
        )
        .await
        .0,
        409
    );
    let (status, reopened) = call(
        &r,
        &a,
        "POST",
        &actions,
        json!({"action":"reopen","reason":"Synthetic follow-up still needed"}),
        Some(2),
    )
    .await;
    assert_eq!(status, 200, "{reopened}");
    assert_eq!(reopened["status"], "open");
    let (_, work) = call(
        &r,
        &a,
        "GET",
        "/api/v1/follow-up/tasks?status=all",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(work["total"], 1);
    assert_eq!(work["items"][0]["patient_id"], json!(p));
    assert_eq!(work["items"][0]["mrn"], "SYN-CHECKOUT");
    let disabled = Uuid::new_v4();
    user(&db, &a, disabled, "clinician", true).await;
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &actions,
            json!({"action":"reassign","assignee_id":disabled,"reason":"Disabled staff"}),
            Some(3)
        )
        .await
        .0,
        400
    );
    let (_, users) = call(
        &r,
        &a,
        "GET",
        "/api/v1/follow-up/assignees",
        Value::Null,
        None,
    )
    .await;
    assert!(!users.to_string().contains(&disabled.to_string()));
    sqlx::query("CREATE FUNCTION fail_followup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='followup.action' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_followup_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_followup_audit()").execute(&db).await.unwrap();
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &actions,
            json!({"action":"cancel","reason":"Synthetic cancellation"}),
            Some(3)
        )
        .await
        .0,
        500
    );
    let (_, after) = call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/follow-up/tasks/{task_id}"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(after["status"], "open");
    assert_eq!(after["version"], 3);
    assert_eq!(after["events"].as_array().unwrap().len(), 3);
    assert!(
        sqlx::query("UPDATE follow_up_history SET reason='changed' WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .execute(&db)
            .await
            .is_err()
    );
    let mut bad = request.clone();
    bad["request_id"] = json!(Uuid::new_v4());
    bad["assignee_id"] = json!(Uuid::new_v4());
    assert_eq!(call(&r, &a, "POST", &task_create, bad, None).await.0, 400);
    db.close().await;
}
#[tokio::test]
async fn unsigned_release_validation_and_followup_concurrency_enforce_real_transitions() {
    let (db, a, p, v) = setup().await;
    let r = app(db.clone());
    let unsigned = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-26T14:00:00Z','2026-10-26T14:30:00Z','in_progress')").bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id) VALUES($1,$2,$3,$4,$5)").bind(a.tenant_id).bind(unsigned).bind(p).bind(appointment).bind(a.sub).execute(&db).await.unwrap();
    let (_, preview) = call(&r, &a, "GET", &path(p, unsigned), Value::Null, None).await;
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &format!("{}/actions", path(p, unsigned)),
            release(&preview["preview_digest"]),
            Some(0)
        )
        .await
        .0,
        409
    );
    let base = path(p, v);
    let actions = format!("{base}/actions");
    let (_, first) = call(&r, &a, "GET", &base, Value::Null, None).await;
    let (_, repeat) = call(&r, &a, "GET", &base, Value::Null, None).await;
    assert_eq!(first["preview_digest"], repeat["preview_digest"]);
    let mut unreviewed = release(&first["preview_digest"]);
    unreviewed["reviewed"] = json!(false);
    assert_eq!(
        call(&r, &a, "POST", &actions, unreviewed, Some(0)).await.0,
        400
    );
    let mut forged = release(&first["preview_digest"]);
    forged["signed_by"] = json!(Uuid::new_v4());
    assert_eq!(call(&r, &a, "POST", &actions, forged, Some(0)).await.0, 422);
    let order = Uuid::new_v4();
    sqlx::query("INSERT INTO lab_orders(tenant_id,id,patient_id,visit_id,request_id,creation_hash,content,status,created_by) VALUES($1,$2,$3,$4,$5,'synthetic',$6,'draft',$7)").bind(a.tenant_id).bind(order).bind(p).bind(v).bind(Uuid::new_v4()).bind(json!({"title":"Synthetic panel","category":"laboratory","priority":"routine","destination":"Synthetic laboratory","tests":[{"key":"test","label":"Synthetic analyte"}],"clinical_reason":"PRIVATE-ORDER-REASON"})).bind(a.sub).execute(&db).await.unwrap();
    let (_, order_preview) = call(&r, &a, "GET", &base, Value::Null, None).await;
    assert_eq!(
        order_preview["preview_snapshot"]["orders"][0]["title"],
        "Synthetic panel"
    );
    assert_eq!(
        order_preview["preview_snapshot"]["orders"][0]["status"],
        "draft"
    );
    assert!(!order_preview.to_string().contains("PRIVATE-ORDER-REASON"));
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &actions,
            release(&first["preview_digest"]),
            Some(0)
        )
        .await
        .0,
        409
    );
    let assignee = Uuid::new_v4();
    user(&db, &a, assignee, "front_desk", false).await;
    let target = format!("/api/v1/patients/{p}/visits/{v}/follow-ups");
    let create = json!({"request_id":Uuid::new_v4(),"title":"Synthetic future call","instructions":"Synthetic patient callback","assignee_id":assignee,"due_date":"2026-10-27","reason":"Synthetic plan"});
    let (_, task) = call(&r, &a, "POST", &target, create.clone(), None).await;
    let task_path = format!(
        "/api/v1/follow-up/tasks/{}/actions",
        task["id"].as_str().unwrap()
    );
    let body = json!({"action":"complete","reason":"Synthetic call complete"});
    let (one, two) = tokio::join!(
        call(&r, &a, "POST", &task_path, body.clone(), Some(1)),
        call(&r, &a, "POST", &task_path, body, Some(1))
    );
    let mut statuses = vec![one.0.as_u16(), two.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, vec![200, 409]);
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &task_path,
            json!({"action":"complete","reason":"Already complete"}),
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
            &task_path,
            json!({"action":"reopen","reason":"Synthetic reopen"}),
            Some(2)
        )
        .await
        .0,
        200
    );
    let (status, rescheduled) = call(
        &r,
        &a,
        "POST",
        &task_path,
        json!({"action":"reschedule","due_date":"2026-11-01","reason":"Synthetic scheduled call"}),
        Some(3),
    )
    .await;
    assert_eq!(status, 200, "{rescheduled}");
    assert_eq!(rescheduled["due_date"], "2026-11-01");
    let (status, cancelled) = call(
        &r,
        &a,
        "POST",
        &task_path,
        json!({"action":"cancel","reason":"Synthetic cancellation reviewed"}),
        Some(4),
    )
    .await;
    assert_eq!(status, 200, "{cancelled}");
    assert_eq!(cancelled["status"], "cancelled");
    let readonly_id = Uuid::new_v4();
    user(&db, &a, readonly_id, "read_only", false).await;
    let mut bad = create.clone();
    bad["request_id"] = json!(Uuid::new_v4());
    bad["assignee_id"] = json!(readonly_id);
    assert_eq!(call(&r, &a, "POST", &target, bad, None).await.0, 400);
    let mut invalid_date = create;
    invalid_date["request_id"] = json!(Uuid::new_v4());
    invalid_date["due_date"] = json!("1999-01-01");
    assert_eq!(
        call(&r, &a, "POST", &target, invalid_date, None).await.0,
        400
    );
    let rebuilt = app(db.clone());
    let (_, restored) = call(
        &rebuilt,
        &a,
        "GET",
        &format!("/api/v1/follow-up/tasks/{}", task["id"].as_str().unwrap()),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(restored["version"], 5);
    assert_eq!(restored["events"].as_array().unwrap().len(), 5);
    db.close().await;
}
