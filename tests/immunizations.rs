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
    let schema = format!("immunization_test_{}", Uuid::new_v4().simple());
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
fn vaccine(kind: &str, performer: Uuid) -> Value {
    let mut c = json!({"record_type":kind,"status":if kind=="not_given"{"not_done"}else{"completed"},"vaccine_name":"Synthetic vaccine","vaccine_code":{"system":"http://hl7.org/fhir/sid/cvx","code":"999","display":"Synthetic fixture only"},"occurred_at":null,"occurred_on":"2026-10-01","occurrence_text":null,"primary_source":false,"report_origin":"Synthetic patient report","visit_id":null,"performer_id":null,"manufacturer":"","lot_number":"","expiration_date":null,"route":"","site":"","dose":null,"not_done_reason":"","notes":"Synthetic only"});
    if kind == "administered" {
        c["occurred_on"] = Value::Null;
        c["occurred_at"] = json!("2026-10-01T10:00:00Z");
        c["performer_id"] = json!(performer);
        c["dose"] = json!({"value":"00.500","unit":"mL"});
        c["route"] = json!("Intramuscular");
        c["site"] = json!("Left deltoid");
        c["lot_number"] = json!("SYN-LOT");
        c["primary_source"] = json!(true);
        c["report_origin"] = json!("");
    }
    if kind == "not_given" {
        c["not_done_reason"] = json!("Synthetic declined vaccination");
    }
    json!({"request_id":Uuid::new_v4(),"content":c,"reason":"Synthetic record source"})
}
#[tokio::test]
async fn native_event_workflow_replay_corrections_errors_and_immutable_history() {
    let (db, doc, nurse, p) = setup().await;
    let r = app(db.clone());
    let base = format!("/api/v1/patients/{p}/immunizations");
    for kind in ["administered", "historical", "not_given"] {
        let v = vaccine(kind, nurse.sub);
        let (status, first) = call(&r, &nurse, "POST", &base, v.clone(), None).await;
        assert_eq!(status, 200, "{first}");
        assert_eq!(first["version"], 1);
        assert_eq!(
            call(&r, &nurse, "POST", &base, v.clone(), None).await.1,
            first
        );
        let mut reuse = v.clone();
        reuse["content"]["notes"] = json!("Different content");
        assert_eq!(call(&r, &nurse, "POST", &base, reuse, None).await.0, 409);
        assert_eq!(call(&r, &doc, "POST", &base, v.clone(), None).await.0, 409);
        let id = first["id"].as_str().unwrap();
        let path = format!("{base}/{id}");
        let mut change = v;
        change["request_id"] = json!(Uuid::new_v4());
        change["reason"] = json!("Synthetic correction");
        change["content"]["notes"] = json!("Corrected synthetic note");
        let (status, updated) = call(&r, &doc, "PUT", &path, change.clone(), Some(1)).await;
        assert_eq!(status, 200, "{updated}");
        assert_eq!(updated["version"], 2);
        assert_eq!(
            call(&r, &doc, "PUT", &path, change.clone(), Some(1))
                .await
                .1,
            updated
        );
        change["request_id"] = json!(Uuid::new_v4());
        assert_eq!(call(&r, &doc, "PUT", &path, change, Some(1)).await.0, 409);
        let error =
            json!({"request_id":Uuid::new_v4(),"reason":"Synthetic event entered in error"});
        let (status, entered) = call(
            &r,
            &doc,
            "POST",
            &format!("{path}/entered-in-error"),
            error.clone(),
            Some(2),
        )
        .await;
        assert_eq!(status, 200, "{entered}");
        assert_eq!(entered["content"]["status"], "entered_in_error");
        assert_eq!(
            call(
                &r,
                &doc,
                "POST",
                &format!("{path}/entered-in-error"),
                error,
                Some(2)
            )
            .await
            .1,
            entered
        );
        sqlx::query("UPDATE browser_users SET display_name='Synthetic Nurse <script>' WHERE tenant_id=$1 AND id=$2").bind(nurse.tenant_id).bind(nurse.sub).execute(&db).await.unwrap();
        let (_, history) = call(
            &r,
            &doc,
            "GET",
            &format!("{path}/revisions"),
            Value::Null,
            None,
        )
        .await;
        assert_eq!(history["items"].as_array().unwrap().len(), 3);
        assert_eq!(history["items"][2]["actor_id"], nurse.sub.to_string());
        assert_eq!(
            history["items"][2]["author_label"],
            "Synthetic Nurse <script>"
        );
        assert_eq!(
            history["items"][2]["snapshot"]["content"]["notes"],
            "Synthetic only"
        );
    }
    assert!(sqlx::query("DELETE FROM immunization_revisions")
        .execute(&db)
        .await
        .is_err());
    assert!(sqlx::query("DELETE FROM immunizations")
        .execute(&db)
        .await
        .is_err());
    db.close().await;
}
#[tokio::test]
async fn role_tenant_context_validation_and_audit_failure_fail_closed() {
    let (db, doc, nurse, p) = setup().await;
    let r = app(db.clone());
    let path = format!("/api/v1/patients/{p}/immunizations");
    for role in [
        Role::MedicalAssistant,
        Role::ReadOnly,
        Role::FrontDesk,
        Role::Patient,
    ] {
        let mut denied = nurse.clone();
        denied.role = role;
        denied.patient_id = Some(p);
        assert_eq!(
            call(
                &r,
                &denied,
                "POST",
                &path,
                vaccine("historical", nurse.sub),
                None
            )
            .await
            .0,
            403
        );
    }
    let mut foreign = doc.clone();
    foreign.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(
            &r,
            &foreign,
            "POST",
            &path,
            vaccine("historical", nurse.sub),
            None
        )
        .await
        .0,
        404
    );
    for (key, value) in [
        ("occurred_on", json!("2099-01-01")),
        ("performer_id", json!(Uuid::new_v4())),
        ("visit_id", json!(Uuid::new_v4())),
        ("occurred_at", json!("2026-10-01T11:00:00Z")),
        ("report_origin", json!("")),
    ] {
        let mut bad = vaccine("historical", nurse.sub);
        bad["content"][key] = value;
        assert_eq!(
            call(&r, &doc, "POST", &path, bad, None).await.0,
            400,
            "{key}"
        );
    }
    let mut historic = vaccine("historical", nurse.sub);
    historic["content"]["occurred_on"] = Value::Null;
    historic["content"]["occurrence_text"] =
        json!("Reported childhood vaccine; exact date not known");
    assert_eq!(call(&r, &doc, "POST", &path, historic, None).await.0, 200);
    sqlx::query("CREATE FUNCTION deny_immunization_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.immunization.create' THEN RAISE EXCEPTION 'synthetic audit failure';END IF;RETURN NEW;END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER deny_immunization_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_immunization_audit()").execute(&db).await.unwrap();
    assert_eq!(
        call(
            &r,
            &doc,
            "POST",
            &path,
            vaccine("administered", nurse.sub),
            None
        )
        .await
        .0,
        500
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM immunizations")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM immunization_requests")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    db.close().await;
}
#[tokio::test]
async fn fhir_projection_writes_occurrence_precision_and_scoped_search() {
    let (db, doc, nurse, p) = setup().await;
    let r = app(db.clone());
    let base = format!("/api/v1/patients/{p}/immunizations");
    let (_, native) = call(
        &r,
        &nurse,
        "POST",
        &base,
        vaccine("administered", nurse.sub),
        None,
    )
    .await;
    let id = native["id"].as_str().unwrap();
    let path = format!("/fhir/Immunization/{id}");
    let (status, out) = call(&r, &doc, "GET", &path, Value::Null, None).await;
    assert_eq!(status, 200, "{out}");
    assert_eq!(out["doseQuantity"]["value"], json!(0.5));
    assert_eq!(
        out["performer"][0]["actor"]["identifier"]["value"],
        nurse.sub.to_string()
    );
    assert!(out.get("occurrenceString").is_none());
    let (_, page) = call(
        &r,
        &doc,
        "GET",
        &format!("/fhir/Immunization?patient=Patient/{p}&date=2026-10-01&_count=1"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(page["entry"].as_array().unwrap().len(), 1);
    let mut historic = vaccine("historical", nurse.sub);
    historic["content"]["occurred_on"] = Value::Null;
    historic["content"]["occurrence_text"] = json!("Childhood; exact date unknown");
    let (_, h) = call(&r, &nurse, "POST", &base, historic, None).await;
    let (_, unknown) = call(
        &r,
        &doc,
        "GET",
        &format!("/fhir/Immunization/{}", h["id"].as_str().unwrap()),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(unknown["occurrenceString"], "Childhood; exact date unknown");
    assert!(unknown.get("occurrenceDateTime").is_none());
    let mut write = out.clone();
    for key in ["id", "meta", "recorded"] {
        write.as_object_mut().unwrap().remove(key);
    }
    write["performer"][0]["actor"]
        .as_object_mut()
        .unwrap()
        .remove("display");
    let (status, created) = call(
        &r,
        &nurse,
        "POST",
        "/fhir/Immunization",
        write.clone(),
        None,
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let new_path = format!("/fhir/Immunization/{}", created["id"].as_str().unwrap());
    write["id"] = created["id"].clone();
    write["note"] = json!([{"text":"FHIR correction"}]);
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &nurse,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let req = Request::builder()
        .method("PUT")
        .uri(&new_path)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/fhir+json")
        .header("if-match", "W/\"1\"")
        .header("x-change-reason", "Synthetic FHIR correction")
        .body(Body::from(write.to_string()))
        .unwrap();
    let response = r.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["etag"], "W/\"2\"");
    let mut bad = write;
    bad["protocolApplied"] = json!([]);
    assert_eq!(
        call(&r, &nurse, "POST", "/fhir/Immunization", bad, None)
            .await
            .0,
        400
    );
    let mut foreign = doc.clone();
    foreign.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(&r, &foreign, "GET", &path, Value::Null, None).await.0,
        404
    );
    let mut patient = doc.clone();
    patient.role = Role::Patient;
    patient.patient_id = Some(p);
    assert_eq!(
        call(&r, &patient, "GET", &path, Value::Null, None).await.0,
        403
    );
    let (_, page) = call(
        &r,
        &doc,
        "GET",
        &format!("/fhir/Immunization?patient={p}&_count=1"),
        Value::Null,
        None,
    )
    .await;
    let next = page["link"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["relation"] == "next")
        .unwrap()["url"]
        .as_str()
        .unwrap();
    let next = next.strip_prefix("http://127.0.0.1:8099").unwrap();
    let (_, next) = call(&r, &doc, "GET", next, Value::Null, None).await;
    assert_ne!(
        page["entry"][0]["resource"]["id"],
        next["entry"][0]["resource"]["id"]
    );
    db.close().await;
}
#[tokio::test]
async fn concurrent_replay_and_failed_corrections_preserve_all_snapshots() {
    let (db, doc, nurse, p) = setup().await;
    let r = app(db.clone());
    let base = format!("/api/v1/patients/{p}/immunizations");
    let v = vaccine("historical", nurse.sub);
    let (a, b) = tokio::join!(
        call(&r, &doc, "POST", &base, v.clone(), None),
        call(&r, &doc, "POST", &base, v.clone(), None)
    );
    assert_eq!(a.0, 200);
    assert_eq!(a.1, b.1);
    let id = a.1["id"].as_str().unwrap();
    let path = format!("{base}/{id}");
    let mut correction = v;
    correction["request_id"] = json!(Uuid::new_v4());
    correction["content"]["notes"] = json!("Must roll back");
    assert_eq!(
        call(&r, &doc, "PUT", &path, correction.clone(), None)
            .await
            .0,
        428
    );
    sqlx::query("CREATE FUNCTION deny_immunization_mutation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN('patient.immunization.correct','patient.immunization.entered_error') THEN RAISE EXCEPTION 'synthetic audit failure';END IF;RETURN NEW;END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER deny_immunization_mutation_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_immunization_mutation_audit()").execute(&db).await.unwrap();
    assert_eq!(
        call(&r, &doc, "PUT", &path, correction, Some(1)).await.0,
        500
    );
    let (status, still) = call(&r, &doc, "GET", &path, Value::Null, None).await;
    assert_eq!(status, 200);
    assert_eq!(still, a.1);
    assert_eq!(
        call(
            &r,
            &doc,
            "POST",
            &format!("{path}/entered-in-error"),
            json!({"request_id":Uuid::new_v4(),"reason":"Must roll back"}),
            Some(1)
        )
        .await
        .0,
        500
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM immunization_revisions")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM immunization_requests")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    db.close().await;
}
#[tokio::test]
async fn nurse_oauth_scope_and_revocation_are_enforced() {
    use sha2::{Digest, Sha256};
    let (db, _doc, nurse, p) = setup().await;
    let r = app(db.clone());
    let client = Uuid::new_v4();
    let grant = Uuid::new_v4();
    let token = format!("sce_at_{}", Uuid::new_v4());
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO oauth_clients(id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES($1,$2,'Synthetic immunization client','unused','https://example.test/return','clinical.read clinical.write')").bind(client).bind(nurse.tenant_id).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,'clinical.read')").bind(grant).bind(client).bind(nurse.tenant_id).bind(nurse.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '5 minutes')").bind(hash).bind(grant).execute(&db).await.unwrap();
    let payload = json!({"resourceType":"Immunization","status":"completed","vaccineCode":{"text":"Synthetic historical vaccine"},"patient":{"reference":format!("Patient/{p}")},"occurrenceString":"Reported childhood; date unknown","primarySource":false,"reportOrigin":{"text":"Synthetic patient report"},"extension":[{"url":"http://127.0.0.1:8099/StructureDefinition/immunization-record-type","valueCode":"historical"}]});
    let send = || {
        Request::builder()
            .method("POST")
            .uri("/fhir/Immunization")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/fhir+json")
            .body(Body::from(payload.to_string()))
            .unwrap()
    };
    assert_eq!(r.clone().oneshot(send()).await.unwrap().status(), 403);
    sqlx::query("UPDATE oauth_grants SET scope='clinical.write' WHERE id=$1")
        .bind(grant)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(r.clone().oneshot(send()).await.unwrap().status(), 201);
    sqlx::query("UPDATE oauth_grants SET revoked_at=now() WHERE id=$1")
        .bind(grant)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(r.clone().oneshot(send()).await.unwrap().status(), 401);
    db.close().await;
}
#[tokio::test]
async fn exact_occurrence_instant_survives_notes_only_correction() {
    let (db, doc, nurse, p) = setup().await;
    let r = app(db.clone());
    let base = format!("/api/v1/patients/{p}/immunizations");
    let mut v = vaccine("administered", nurse.sub);
    v["content"]["occurred_at"] = json!("2025-11-02T01:30:47.123456789-05:00");
    let (status, created) = call(&r, &doc, "POST", &base, v, None).await;
    assert_eq!(status, 200, "{created}");
    assert_eq!(
        created["content"]["occurred_at"],
        "2025-11-02T06:30:47.123456789Z"
    );
    let mut c = created["content"].clone();
    c["notes"] = json!("Notes-only correction");
    let (status, corrected) = call(
        &r,
        &doc,
        "PUT",
        &format!("{base}/{}", created["id"].as_str().unwrap()),
        json!({"request_id":Uuid::new_v4(),"content":c,"reason":"Correct synthetic notes"}),
        Some(1),
    )
    .await;
    assert_eq!(status, 200, "{corrected}");
    assert_eq!(
        corrected["content"]["occurred_at"],
        created["content"]["occurred_at"]
    );
    db.close().await;
}
