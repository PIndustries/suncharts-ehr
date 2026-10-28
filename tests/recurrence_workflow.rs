// SPDX-License-Identifier: AGPL-3.0-only
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::{Duration, Utc};
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
const SECRET: &str = "synthetic-series-test-secret";
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
async fn setup() -> (PgPool, Actor, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("series_test_{}", Uuid::new_v4().simple());
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
    let p = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-a-login','owner')").bind(a.sub).bind(a.tenant_id).bind(format!("{}@example.test",a.sub.simple())).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-RECUR','Avery','Synthetic','1990-01-01')").bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    (db, a, p)
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
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        req = req.header("If-Match", format!("\"{v}\""));
    }
    let response = r
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"message":String::from_utf8_lossy(&bytes)})),
    )
}
fn plan(a: &Actor, p: Uuid, count: usize) -> Value {
    let start = Utc::now().date_naive() + Duration::days(7);
    let occurrences=(0..count).map(|i|{let day=start+Duration::days(7*i as i64);json!({"starts_at":format!("{day}T14:00:00Z"),"ends_at":format!("{day}T14:30:00Z"),"local_start":format!("{day}T14:00:00"),"local_end":format!("{day}T14:30:00"),"utc_offset_minutes":0})}).collect::<Vec<_>>();
    json!({"request_id":Uuid::new_v4(),"patient_id":p,"clinician_id":a.sub,"title":"Synthetic recurring follow-up","category":"Follow-up","facility":"Synthetic clinic","room":"4","notes":"Synthetic series only","reason":"Synthetic recurring care plan","frequency":"weekly","interval":1,"timezone":"UTC","occurrences":occurrences})
}
fn cancellation(series: &Value) -> Value {
    json!({"action":"cancel_upcoming","reason":"Synthetic future series cancellation","occurrence_versions":series["occurrences"].as_array().unwrap().iter().map(|o|json!({"appointment_id":o["appointment_id"],"version":o["version"]})).collect::<Vec<_>>()})
}
const CREATE: &str = "/api/v1/schedule/series";
#[tokio::test]
async fn recurring_series_is_atomic_scoped_idempotent_and_ordinary_appointments_keep_history() {
    let (db, a, p) = setup().await;
    let r = app(db.clone());
    let request = plan(&a, p, 4);
    let (status, preview) = call(
        &r,
        &a,
        "POST",
        "/api/v1/schedule/series/preview",
        request.clone(),
        None,
    )
    .await;
    assert_eq!(status, 200, "{preview}");
    assert_eq!(preview["ready_to_create"], true);
    assert_eq!(preview["occurrences"].as_array().unwrap().len(), 4);
    let initial: i64 = sqlx::query_scalar("SELECT count(*) FROM appointments")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(initial, 0);
    let (one, two) = tokio::join!(
        call(&r, &a, "POST", CREATE, request.clone(), None),
        call(&r, &a, "POST", CREATE, request.clone(), None)
    );
    assert_eq!(one.0, 200, "{}", one.1);
    assert_eq!(two.0, 200, "{}", two.1);
    assert_eq!(one.1["id"], two.1["id"]);
    let series = one.1;
    assert_eq!(series["occurrences"].as_array().unwrap().len(), 4);
    assert_eq!(series["events"].as_array().unwrap().len(), 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM appointments")
        .fetch_one(&db)
        .await
        .unwrap();
    let revisions: i64 = sqlx::query_scalar("SELECT count(*) FROM appointment_revisions")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!((count, revisions), (4, 4));
    let mut changed = request.clone();
    changed["title"] = json!("Different series");
    assert_eq!(call(&r, &a, "POST", CREATE, changed, None).await.0, 409);
    let id = series["id"].as_str().unwrap();
    let first = series["occurrences"][0]["appointment_id"].as_str().unwrap();
    let (_, member) = call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/appointments/{first}/series"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(member["series"]["id"], series["id"]);
    let (_, ordinary) = call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/appointments/{first}"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(ordinary["patient_id"], json!(p));
    assert_eq!(ordinary["title"], "Synthetic recurring follow-up");
    let mut other = a.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(
            &r,
            &other,
            "GET",
            &format!("{CREATE}/{id}"),
            Value::Null,
            None
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(
            &r,
            &other,
            "GET",
            &format!("/api/v1/appointments/{first}/series"),
            Value::Null,
            None
        )
        .await
        .0,
        404
    );
    for role in [Role::ReadOnly, Role::Patient] {
        let mut denied = a.clone();
        denied.role = role;
        denied.patient_id = Some(p);
        assert_eq!(
            call(&r, &denied, "POST", CREATE, request.clone(), None)
                .await
                .0,
            403
        );
    }
    let mut foreign = request.clone();
    foreign["request_id"] = json!(Uuid::new_v4());
    foreign["patient_id"] = json!(Uuid::new_v4());
    assert_eq!(call(&r, &a, "POST", CREATE, foreign, None).await.0, 404);
    assert!(sqlx::query("UPDATE appointment_series SET plan='{}'")
        .execute(&db)
        .await
        .is_err());
    assert!(sqlx::query("DELETE FROM appointment_series_occurrences")
        .execute(&db)
        .await
        .is_err());
    assert!(
        sqlx::query("UPDATE appointment_series_events SET reason='changed'")
            .execute(&db)
            .await
            .is_err()
    );
    let rebuilt = app(db.clone());
    assert_eq!(
        call(
            &rebuilt,
            &a,
            "GET",
            &format!("{CREATE}/{id}"),
            Value::Null,
            None
        )
        .await
        .1["occurrences"],
        series["occurrences"]
    );
    db.close().await;
}
#[tokio::test]
async fn preview_conflicts_and_audit_failure_never_partially_book_a_series() {
    let (db, a, p) = setup().await;
    let r = app(db.clone());
    let request = plan(&a, p, 3);
    let conflict = &request["occurrences"][1];
    sqlx::query("INSERT INTO schedule_blocks(tenant_id,id,clinician_id,starts_at,ends_at,label,request_id,request_digest) VALUES($1,$2,$3,$4::text::timestamptz,$5::text::timestamptz,'Synthetic provider block',$6,'synthetic')").bind(a.tenant_id).bind(Uuid::new_v4()).bind(a.sub).bind(conflict["starts_at"].as_str().unwrap()).bind(conflict["ends_at"].as_str().unwrap()).bind(Uuid::new_v4()).execute(&db).await.unwrap();
    let (status, preview) = call(
        &r,
        &a,
        "POST",
        "/api/v1/schedule/series/preview",
        request.clone(),
        None,
    )
    .await;
    assert_eq!(status, 200, "{preview}");
    assert_eq!(preview["ready_to_create"], false);
    assert_eq!(preview["occurrences"][0]["available"], true);
    assert_eq!(preview["occurrences"][1]["available"], false);
    assert_eq!(
        call(&r, &a, "POST", CREATE, request.clone(), None).await.0,
        409
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM appointments")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    sqlx::query("UPDATE schedule_blocks SET active=false")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("CREATE FUNCTION fail_series_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='schedule.series_create' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_series_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_series_audit()").execute(&db).await.unwrap();
    assert_eq!(call(&r, &a, "POST", CREATE, request, None).await.0, 500);
    for table in [
        "appointments",
        "appointment_revisions",
        "appointment_series",
        "appointment_series_occurrences",
        "appointment_series_events",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&db)
                .await
                .unwrap(),
            0,
            "{table}"
        );
    }
    db.close().await;
}
#[tokio::test]
async fn cancellation_requires_current_series_and_occurrence_versions_and_preserves_started_work() {
    let (db, a, p) = setup().await;
    let r = app(db.clone());
    let (_, series) = call(&r, &a, "POST", CREATE, plan(&a, p, 4), None).await;
    let id = series["id"].as_str().unwrap();
    let target = format!("{CREATE}/{id}/actions");
    let first = series["occurrences"][0]["appointment_id"].as_str().unwrap();
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &format!("/api/v1/appointments/{first}/actions"),
            json!({"action":"check_in","reason":"Synthetic arrival"}),
            Some(1)
        )
        .await
        .0,
        200
    );
    let (_, visit) = call(
        &r,
        &a,
        "POST",
        "/api/v1/visits",
        json!({"appointment_id":first}),
        None,
    )
    .await;
    assert_eq!(visit["status"], "in_progress");
    assert_eq!(
        call(&r, &a, "POST", &target, cancellation(&series), Some(1))
            .await
            .0,
        409
    );
    let (_, fresh) = call(&r, &a, "GET", &format!("{CREATE}/{id}"), Value::Null, None).await;
    assert_eq!(
        call(&r, &a, "POST", &target, cancellation(&fresh), None)
            .await
            .0,
        428
    );
    let last = &fresh["occurrences"][3];
    let cancelled = last["appointment_id"].as_str().unwrap();
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &format!("/api/v1/appointments/{cancelled}/actions"),
            json!({"action":"cancel","reason":"Synthetic one-instance exception"}),
            Some(1)
        )
        .await
        .0,
        200
    );
    let (_, fresh) = call(&r, &a, "GET", &format!("{CREATE}/{id}"), Value::Null, None).await;
    let body = cancellation(&fresh);
    sqlx::query("CREATE FUNCTION fail_cancel_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='schedule.series_cancel' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_cancel_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_cancel_audit()").execute(&db).await.unwrap();
    assert_eq!(
        call(&r, &a, "POST", &target, body.clone(), Some(1)).await.0,
        500
    );
    let (_, rolled_back) = call(&r, &a, "GET", &format!("{CREATE}/{id}"), Value::Null, None).await;
    assert_eq!(rolled_back["version"], 1);
    assert_eq!(rolled_back["occurrences"], fresh["occurrences"]);
    assert_eq!(rolled_back["events"].as_array().unwrap().len(), 1);
    sqlx::query("DROP TRIGGER fail_cancel_audit ON audit_events")
        .execute(&db)
        .await
        .unwrap();
    let (one, two) = tokio::join!(
        call(&r, &a, "POST", &target, body.clone(), Some(1)),
        call(&r, &a, "POST", &target, body, Some(1))
    );
    let mut codes = vec![one.0.as_u16(), two.0.as_u16()];
    codes.sort();
    assert_eq!(codes, vec![200, 409]);
    let after = if one.0 == 200 { one.1 } else { two.1 };
    assert_eq!(after["version"], 2);
    assert_eq!(after["status"], "cancelled");
    assert_eq!(after["occurrences"][0]["status"], "in_progress");
    assert_eq!(after["occurrences"][1]["status"], "cancelled");
    assert_eq!(after["occurrences"][2]["status"], "cancelled");
    assert_eq!(after["occurrences"][3]["version"], 2);
    let (status, history) = call(
        &r,
        &a,
        "GET",
        &format!("/api/v1/appointments/{first}/history"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(history["items"].as_array().unwrap().len(), 3);
    let completed_visit: Value = sqlx::query_scalar(
        "SELECT to_jsonb(v)-'tenant_id' FROM visits v WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(Uuid::parse_str(visit["id"].as_str().unwrap()).unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(completed_visit["status"], "in_progress");
    db.close().await;
}
#[tokio::test]
async fn timezone_dst_month_end_and_cadence_are_validated_server_side() {
    let (db, a, p) = setup().await;
    let r = app(db.clone());
    let mut request = plan(&a, p, 2);
    request["frequency"] = json!("weekly");
    request["timezone"] = json!("America/Chicago");
    request["occurrences"] = json!([
 {"starts_at":"2027-03-07T15:00:00Z","ends_at":"2027-03-07T15:30:00Z","local_start":"2027-03-07T09:00:00","local_end":"2027-03-07T09:30:00","utc_offset_minutes":-360},
 {"starts_at":"2027-03-14T14:00:00Z","ends_at":"2027-03-14T14:30:00Z","local_start":"2027-03-14T09:00:00","local_end":"2027-03-14T09:30:00","utc_offset_minutes":-300}]);
    let (status, preview) = call(
        &r,
        &a,
        "POST",
        "/api/v1/schedule/series/preview",
        request.clone(),
        None,
    )
    .await;
    assert_eq!(status, 200, "{preview}");
    assert_eq!(preview["ready_to_create"], true);
    let mut wrong_offset = request.clone();
    wrong_offset["occurrences"][1]["utc_offset_minutes"] = json!(-360);
    assert_eq!(
        call(&r, &a, "POST", CREATE, wrong_offset, None).await.0,
        400
    );
    let mut gap = request.clone();
    gap["occurrences"][0]["local_start"] = json!("2027-03-07T02:00:00");
    gap["occurrences"][1]["local_start"] = json!("2027-03-14T02:00:00");
    assert_eq!(call(&r, &a, "POST", CREATE, gap, None).await.0, 400);
    let mut monthly = plan(&a, p, 3);
    monthly["frequency"] = json!("monthly");
    monthly["occurrences"]=json!(["2027-01-31","2027-02-28","2027-03-31"].into_iter().map(|day|json!({"starts_at":format!("{day}T14:00:00Z"),"ends_at":format!("{day}T14:30:00Z"),"local_start":format!("{day}T14:00:00"),"local_end":format!("{day}T14:30:00"),"utc_offset_minutes":0})).collect::<Vec<_>>());
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            "/api/v1/schedule/series/preview",
            monthly.clone(),
            None
        )
        .await
        .0,
        200
    );
    monthly["occurrences"][2]["local_start"] = json!("2027-03-28T14:00:00");
    assert_eq!(call(&r, &a, "POST", CREATE, monthly, None).await.0, 400);
    let mut invalid = plan(&a, p, 2);
    invalid["timezone"] = json!("Not/AZone");
    assert_eq!(call(&r, &a, "POST", CREATE, invalid, None).await.0, 400);
    let mut too_long = plan(&a, p, 28);
    too_long["interval"] = json!(2);
    let start = Utc::now().date_naive() + Duration::days(7);
    too_long["occurrences"] = json!((0..28).map(|i| {
        let day = start + Duration::days(14 * i);
        json!({"starts_at":format!("{day}T14:00:00Z"),"ends_at":format!("{day}T14:30:00Z"),"local_start":format!("{day}T14:00:00"),"local_end":format!("{day}T14:30:00"),"utc_offset_minutes":0})
    }).collect::<Vec<_>>());
    assert_eq!(call(&r, &a, "POST", CREATE, too_long, None).await.0, 400);
    let mut too_short = plan(&a, p, 1);
    too_short["frequency"] = json!("daily");
    assert_eq!(call(&r, &a, "POST", CREATE, too_short, None).await.0, 400);
    db.close().await;
}
