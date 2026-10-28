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
const SECRET: &str = "synthetic-diagnoses-test-secret";
fn actor(tenant_id: Uuid, role: Role) -> Actor {
    let now = Utc::now().timestamp();
    Actor {
        sub: Uuid::new_v4(),
        tenant_id,
        role,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    }
}
async fn setup() -> (PgPool, Actor, Actor, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("referrals_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(5)
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
    let doc = actor(Uuid::new_v4(), Role::Clinician);
    let nurse = actor(doc.tenant_id, Role::Nurse);
    for (a, role) in [(&doc, "clinician"), (&nurse, "nurse")] {
        sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-login',$4)").bind(a.tenant_id).bind(a.sub).bind(format!("{}@example.test",a.sub)).bind(role).execute(&db).await.unwrap();
    }
    let patient = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-DIAGNOSES','Avery','Synthetic','1990-01-01')").bind(doc.tenant_id).bind(patient).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-26T14:00:00Z','2026-10-26T14:30:00Z','checked_in')").bind(doc.tenant_id).bind(appointment).bind(patient).bind(doc.sub).execute(&db).await.unwrap();
    (db, doc, nurse, patient)
}
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
    let mut q = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        q = q.header("If-Match", format!("\"{v}\""));
    }
    let res = r
        .clone()
        .oneshot(q.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn change() -> Value {
    json!({"visit_id":null,"content":{"requested_service":"Synthetic consultation","recipient":"Synthetic receiving clinic","specialty":"General medicine","priority":"routine","clinical_reason":"Synthetic referral test","clinical_summary":"No actual clinical care","follow_up_due":"2020-01-01","document_ids":[]},"reason":"Synthetic coordination"})
}
fn create() -> Value {
    let mut v = change();
    v["request_id"] = json!(Uuid::new_v4());
    v
}
fn action(name: &str) -> Value {
    json!({"action":name,"reason":"Synthetic milestone","evidence":"Synthetic recorded phone confirmation; no transmission by app"})
}
#[tokio::test]
async fn referrals_require_evidence_and_preserve_sent_package_and_history() {
    let (db, doc, nurse, p) = setup().await;
    let r = app(db.clone());
    let base = format!("/api/v1/patients/{p}/referrals");
    let input = create();
    let (status, first) = call(&r, &doc, "POST", &base, input.clone(), None).await;
    assert_eq!(status, 200, "{first}");
    let (_, again) = call(&r, &doc, "POST", &base, input.clone(), None).await;
    assert_eq!(first["id"], again["id"]);
    assert_eq!(again["version"], 1);
    let mut mismatch = input.clone();
    mismatch["reason"] = json!("Changedrequest");
    assert_eq!(call(&r, &doc, "POST", &base, mismatch, None).await.0, 409);
    let path = format!("{base}/{}", first["id"].as_str().unwrap());
    let actions = path.clone() + "/actions";
    assert_eq!(
        call(&r, &nurse, "GET", &path, Value::Null, None).await.0,
        200
    );
    assert_eq!(
        call(&r, &nurse, "PUT", &path, change(), Some(1)).await.0,
        403
    );
    assert_eq!(
        call(&r, &doc, "POST", &actions, action("ready"), None)
            .await
            .0,
        428
    );
    assert_eq!(
        call(&r, &doc, "POST", &actions, action("completed"), Some(1))
            .await
            .0,
        409
    );
    let (status, ready) = call(&r, &doc, "POST", &actions, action("ready"), Some(1)).await;
    assert_eq!(status, 200, "{ready}");
    assert_eq!(ready["attachment_snapshot"], json!([]));
    let mut no_evidence = action("sent");
    no_evidence["evidence"] = json!("");
    assert_eq!(
        call(&r, &doc, "POST", &actions, no_evidence, Some(2))
            .await
            .0,
        400
    );
    assert_eq!(
        call(&r, &doc, "POST", &actions, action("sent"), Some(1))
            .await
            .0,
        409
    );
    let (status, sent) = call(&r, &doc, "POST", &actions, action("sent"), Some(2)).await;
    assert_eq!(status, 200, "{sent}");
    assert_eq!(sent["status"], "sent");
    assert_eq!(call(&r, &doc, "PUT", &path, change(), Some(3)).await.0, 409);
    assert!(sqlx::query("UPDATE referrals SET content=jsonb_set(content,'{recipient}','\"altered\"') WHERE tenant_id=$1 AND id=$2").bind(doc.tenant_id).bind(Uuid::parse_str(sent["id"].as_str().unwrap()).unwrap()).execute(&db).await.is_err());
    for (version, name) in [(3, "accepted"), (4, "scheduled"), (5, "completed")] {
        assert_eq!(
            call(&r, &doc, "POST", &actions, action(name), Some(version))
                .await
                .0,
            200
        );
    }
    let (_, history) = call(
        &r,
        &nurse,
        "GET",
        &(path.clone() + "/revisions"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(history["items"].as_array().unwrap().len(), 6);
    assert_eq!(history["items"][0]["status"], "completed");
    assert_eq!(history["items"][0]["author_id"], doc.sub.to_string());
    assert!(sqlx::query("DELETE FROM referral_revisions")
        .execute(&db)
        .await
        .is_err());
    assert_eq!(
        call(&r, &doc, "POST", &actions, action("sent"), Some(6))
            .await
            .0,
        409
    );
}
#[tokio::test]
async fn referrals_are_scoped_validated_and_paged_with_overdue_worklist() {
    let (db, doc, _, p) = setup().await;
    let r = app(db.clone());
    let base = format!("/api/v1/patients/{p}/referrals");
    let (_, a) = call(&r, &doc, "POST", &base, create(), None).await;
    call(&r, &doc, "POST", &base, create(), None).await;
    let path = format!("{base}/{}", a["id"].as_str().unwrap());
    let foreign = actor(Uuid::new_v4(), Role::Owner);
    assert_eq!(
        call(&r, &foreign, "GET", &path, Value::Null, None).await.0,
        404
    );
    assert_eq!(
        call(&r, &foreign, "PUT", &path, change(), Some(1)).await.0,
        404
    );
    let mut patient = actor(doc.tenant_id, Role::Patient);
    patient.patient_id = Some(p);
    assert_eq!(
        call(&r, &patient, "GET", &base, Value::Null, None).await.0,
        403
    );
    let mut invalid = create();
    invalid["visit_id"] = json!(Uuid::new_v4());
    assert_eq!(call(&r, &doc, "POST", &base, invalid, None).await.0, 404);
    for suffix in [
        "?_count=0",
        "?_count=101",
        "?status=nope",
        "?status=draft&status=sent",
        "?surprise=true",
    ] {
        assert_eq!(
            call(&r, &doc, "GET", &(base.clone() + suffix), Value::Null, None)
                .await
                .0,
            400
        );
    }
    let (_, page) = call(
        &r,
        &doc,
        "GET",
        &(base.clone() + "?_count=1"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let cursor = page["next_cursor"].as_str().unwrap();
    let (_, next) = call(
        &r,
        &doc,
        "GET",
        &(base.clone() + "?_count=1&_after=" + cursor),
        Value::Null,
        None,
    )
    .await;
    assert_ne!(page["items"][0]["id"], next["items"][0]["id"]);
    let (_, work) = call(
        &r,
        &doc,
        "GET",
        "/api/v1/referrals/worklist?overdue=true",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(work["items"].as_array().unwrap().len(), 2);
    assert!(work["items"][0]["patient_label"].is_string());
    let (_, work) = call(
        &r,
        &foreign,
        "GET",
        "/api/v1/referrals/worklist",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(work["items"], json!([]));
}
#[tokio::test]
async fn referral_writes_are_serialized_and_rollback_when_audit_fails() {
    let (db, doc, _, p) = setup().await;
    let r = app(db.clone());
    let base = format!("/api/v1/patients/{p}/referrals");
    let input = create();
    let (a, b) = tokio::join!(
        call(&r, &doc, "POST", &base, input.clone(), None),
        call(&r, &doc, "POST", &base, input, None)
    );
    assert_eq!(a.0, 200);
    assert_eq!(b.0, 200);
    assert_eq!(a.1["id"], b.1["id"]);
    let path = format!("{base}/{}", a.1["id"].as_str().unwrap());
    let (a, b) = tokio::join!(
        call(&r, &doc, "PUT", &path, change(), Some(1)),
        call(&r, &doc, "PUT", &path, change(), Some(1))
    );
    assert!([a.0, b.0].contains(&StatusCode::OK));
    assert!([a.0, b.0].contains(&StatusCode::CONFLICT));
    sqlx::query("CREATE FUNCTION reject_referral_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'patient.referrals.%' AND NEW.action NOT LIKE '%.read' AND NEW.action NOT LIKE '%.revisions' THEN RAISE EXCEPTION 'synthetic auditfailure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER referral_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_referral_audit()").execute(&db).await.unwrap();
    assert_eq!(call(&r, &doc, "PUT", &path, change(), Some(2)).await.0, 500);
    assert_eq!(
        call(
            &r,
            &doc,
            "POST",
            &(path.clone() + "/actions"),
            action("ready"),
            Some(2)
        )
        .await
        .0,
        500
    );
    assert_eq!(call(&r, &doc, "POST", &base, create(), None).await.0, 500);
    let (_, saved) = call(&r, &doc, "GET", &path, Value::Null, None).await;
    assert_eq!(saved["version"], 2);
    assert_eq!(saved["status"], "draft");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM referral_revisions")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 2);
}
#[tokio::test]
async fn referral_documents_are_patient_bound_and_readiness_captures_versions() {
    let (db, doc, _, p) = setup().await;
    let r = app(db.clone());
    let docs = format!("/api/v1/patients/{p}/documents");
    use base64::Engine;
    let payload =
        base64::engine::general_purpose::STANDARD.encode(b"%PDF-1.4\nSynthetic test only\n%%EOF");
    let content = json!({"title":"Synthetic referral letter","category":"referral","document_date":null,"visit_id":null,"notes":"Synthetic only","status":"active"});
    let(status,document)=call(&r,&doc,"POST",&docs,json!({"request_id":Uuid::new_v4(),"filename":"synthetic.pdf","content_type":"application/pdf","content_base64":payload,"content":content,"reason":"Synthetic upload"}),None).await;
    assert_eq!(status, 200, "{document}");
    let id = document["id"].clone();
    let base = format!("/api/v1/patients/{p}/referrals");
    let mut input = create();
    input["content"]["document_ids"] = json!([id]);
    let (status, referral) = call(&r, &doc, "POST", &base, input.clone(), None).await;
    assert_eq!(status, 200, "{referral}");
    let path = format!("{base}/{}", referral["id"].as_str().unwrap());
    let actions = path.clone() + "/actions";
    let (status, ready) = call(&r, &doc, "POST", &actions, action("ready"), Some(1)).await;
    assert_eq!(status, 200, "{ready}");
    assert_eq!(ready["attachment_snapshot"][0]["version"], 1);
    assert_eq!(
        ready["attachment_snapshot"][0]["sha256"],
        document["sha256"]
    );
    let mut changed = content.clone();
    changed["title"] = json!("Synthetic updated metadata");
    assert_eq!(
        call(
            &r,
            &doc,
            "PUT",
            &format!("{docs}/{}", id.as_str().unwrap()),
            json!({"content":changed,"reason":"Synthetic revision"}),
            Some(1)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        call(&r, &doc, "POST", &actions, action("sent"), Some(2))
            .await
            .0,
        409
    );
    assert_eq!(
        call(&r, &doc, "POST", &actions, action("draft"), Some(2))
            .await
            .0,
        200
    );
    assert_eq!(
        call(&r, &doc, "POST", &actions, action("ready"), Some(3))
            .await
            .0,
        200
    );
    assert_eq!(
        call(&r, &doc, "POST", &actions, action("sent"), Some(4))
            .await
            .0,
        200
    );
    let mut forged = create();
    forged["content"]["document_ids"] = json!([Uuid::new_v4()]);
    assert_eq!(call(&r, &doc, "POST", &base, forged, None).await.0, 404);
    let mut duplicate = create();
    duplicate["content"]["document_ids"] = json!([id, id]);
    assert_eq!(call(&r, &doc, "POST", &base, duplicate, None).await.0, 400);
}
