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
    let schema = format!("documents_test_{}", Uuid::new_v4().simple());
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
const PDF: &[u8] = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n";
fn upload_body() -> Value {
    use base64::Engine;
    json!({"request_id":Uuid::new_v4(),"filename":"synthetic.pdf","content_type":"application/pdf","content_base64":base64::engine::general_purpose::STANDARD.encode(PDF),"content":{"title":"Synthetic consult","category":"consult","document_date":"2026-10-26","visit_id":null,"notes":"Synthetic only","status":"active"},"reason":"Synthetic upload"})
}
async fn download(
    r: &Router,
    a: &Actor,
    path: &str,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        a,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let res = r
        .clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, bytes)
}
#[tokio::test]
async fn upload_download_preserve_original_and_do_not_inline_untrusted_content() {
    use base64::Engine;
    let (db, doc, nurse, p) = setup().await;
    let r = app(db.clone());
    let path = format!("/api/v1/patients/{p}/documents");
    let mut body = upload_body();
    let mut bytes = PDF.to_vec();
    bytes.resize(100_000, b' ');
    body["content_base64"] = json!(base64::engine::general_purpose::STANDARD.encode(&bytes));
    let (status, created) = call(&r, &doc, "POST", &path, body.clone(), None).await;
    assert_eq!(status, 200, "{created}");
    assert_eq!(created["size_bytes"], 100000);
    assert!(created.get("bytes").is_none());
    assert!(created.get("content_base64").is_none());
    let (_, replay) = call(&r, &doc, "POST", &path, body, None).await;
    assert_eq!(created["id"], replay["id"]);
    let id = created["id"].as_str().unwrap();
    let (status, h, stored) = download(&r, &nurse, &format!("{path}/{id}/download")).await;
    assert_eq!(status, 200);
    assert_eq!(stored, bytes);
    assert_eq!(h["content-type"], "application/pdf");
    assert_eq!(h["cache-control"], "no-store");
    assert_eq!(h["x-content-type-options"], "nosniff");
    assert!(h["content-disposition"]
        .to_str()
        .unwrap()
        .starts_with("attachment;"));
    assert!(sqlx::query(
        "UPDATE patient_documents SET bytes='changed'::bytea WHERE tenant_id=$1 AND id=$2"
    )
    .bind(doc.tenant_id)
    .bind(Uuid::parse_str(id).unwrap())
    .execute(&db)
    .await
    .is_err());
    assert!(sqlx::query(
        "DELETE FROM patient_document_revisions WHERE tenant_id=$1 AND document_id=$2"
    )
    .bind(doc.tenant_id)
    .bind(Uuid::parse_str(id).unwrap())
    .execute(&db)
    .await
    .is_err());
}
#[tokio::test]
async fn typed_upload_rejects_bad_signatures_paths_empty_large_and_unsupported_content() {
    use base64::Engine;
    let (db, doc, _, p) = setup().await;
    let r = app(db.clone());
    let path = format!("/api/v1/patients/{p}/documents");
    for field in ["filename", "content_type", "content_base64"] {
        let mut b = upload_body();
        b[field] = json!(match field {
            "filename" => "../secret.pdf",
            "content_type" => "text/html",
            _ => "not-base64!",
        });
        assert_eq!(call(&r, &doc, "POST", &path, b, None).await.0, 400);
    }
    for bytes in [&b"<html>not a PDF</html>"[..], &b""[..]] {
        let mut b = upload_body();
        b["content_base64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
        assert_eq!(call(&r, &doc, "POST", &path, b, None).await.0, 400);
    }
    let mut b = upload_body();
    b["content_base64"] =
        json!(base64::engine::general_purpose::STANDARD.encode(vec![0; 10 * 1024 * 1024 + 1]));
    assert_eq!(call(&r, &doc, "POST", &path, b, None).await.0, 400);
    let mut b = upload_body();
    b["content_base64"] = json!("a".repeat(16 * 1024 * 1024));
    assert_eq!(call(&r, &doc, "POST", &path, b, None).await.0, 413);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM patient_documents")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
#[tokio::test]
async fn documents_enforce_patient_tenant_role_and_visit_bounds() {
    let (db, doc, nurse, p) = setup().await;
    let r = app(db.clone());
    let path = format!("/api/v1/patients/{p}/documents");
    let b = upload_body();
    assert_eq!(
        call(&r, &nurse, "POST", &path, b.clone(), None).await.0,
        403
    );
    let (status, created) = call(&r, &doc, "POST", &path, b, None).await;
    assert_eq!(status, 200);
    let id = created["id"].as_str().unwrap();
    let foreign = actor(Uuid::new_v4(), Role::Clinician);
    assert_eq!(
        call(&r, &foreign, "GET", &path, Value::Null, None).await.0,
        404
    );
    assert_eq!(
        call(
            &r,
            &foreign,
            "GET",
            &format!("{path}/{id}"),
            Value::Null,
            None
        )
        .await
        .0,
        404
    );
    assert_eq!(
        download(&r, &foreign, &format!("{path}/{id}/download"))
            .await
            .0,
        404
    );
    let mut patient = actor(doc.tenant_id, Role::Patient);
    patient.patient_id = Some(p);
    assert_eq!(
        call(&r, &patient, "GET", &path, Value::Null, None).await.0,
        403
    );
    let mut b = upload_body();
    b["content"]["visit_id"] = json!(Uuid::new_v4());
    assert_eq!(call(&r, &doc, "POST", &path, b, None).await.0, 400);
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'OTHER','Other','Synthetic','1990-01-01')").bind(doc.tenant_id).bind(other).execute(&db).await.unwrap();
    assert_eq!(
        download(
            &r,
            &nurse,
            &format!("/api/v1/patients/{other}/documents/{id}/download")
        )
        .await
        .0,
        404
    );
}
#[tokio::test]
async fn metadata_is_versioned_original_immutable_and_filters_are_strict() {
    let (db, doc, _, p) = setup().await;
    let r = app(db.clone());
    let path = format!("/api/v1/patients/{p}/documents");
    let original = upload_body();
    let (_, created) = call(&r, &doc, "POST", &path, original.clone(), None).await;
    let id = created["id"].as_str().unwrap();
    let detail = format!("{path}/{id}");
    let mut content = created["content"].clone();
    content["status"] = json!("archived");
    let edit = json!({"content":content,"reason":"Archive synthetic document"});
    assert_eq!(
        call(&r, &doc, "PUT", &detail, edit.clone(), None).await.0,
        428
    );
    let (status, changed) = call(&r, &doc, "PUT", &detail, edit.clone(), Some(1)).await;
    assert_eq!(status, 200, "{changed}");
    assert_eq!(changed["version"], 2);
    assert_eq!(changed["sha256"], created["sha256"]);
    assert_eq!(call(&r, &doc, "PUT", &detail, edit, Some(1)).await.0, 409);
    let (_, history) = call(
        &r,
        &doc,
        "GET",
        &format!("{detail}/revisions"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(history["items"].as_array().unwrap().len(), 2);
    assert_eq!(history["items"][0]["actor_id"], json!(doc.sub));
    let (_, page) = call(
        &r,
        &doc,
        "GET",
        &format!("{path}?status=active"),
        Value::Null,
        None,
    )
    .await;
    assert!(page["items"].as_array().unwrap().is_empty());
    for q in [
        "status=bad",
        "_count=0",
        "_count=101",
        "status=active&status=archived",
        "unknown=1",
        "_after=bad",
    ] {
        assert_eq!(
            call(&r, &doc, "GET", &format!("{path}?{q}"), Value::Null, None)
                .await
                .0,
            400,
            "{q}"
        );
    }
    let mut collision = original;
    collision["content"]["title"] = json!("Changed upload title");
    assert_eq!(call(&r, &doc, "POST", &path, collision, None).await.0, 409);
}
#[tokio::test]
async fn audit_failures_rollback_upload_metadata_and_deny_download() {
    let (db, doc, _, p) = setup().await;
    let r = app(db.clone());
    let path = format!("/api/v1/patients/{p}/documents");
    let (_, created) = call(&r, &doc, "POST", &path, upload_body(), None).await;
    let id = created["id"].as_str().unwrap();
    sqlx::query("CREATE FUNCTION reject_document_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('patient.document.upload','patient.document.update','patient.document.download') THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER document_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_document_audit()").execute(&db).await.unwrap();
    assert_eq!(
        call(&r, &doc, "POST", &path, upload_body(), None).await.0,
        500
    );
    let mut content = created["content"].clone();
    content["title"] = json!("Changed");
    assert_eq!(
        call(
            &r,
            &doc,
            "PUT",
            &format!("{path}/{id}"),
            json!({"content":content,"reason":"Synthetic failure"}),
            Some(1)
        )
        .await
        .0,
        500
    );
    assert_eq!(
        download(&r, &doc, &format!("{path}/{id}/download")).await.0,
        500
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM patient_documents")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let (_, saved) = call(&r, &doc, "GET", &format!("{path}/{id}"), Value::Null, None).await;
    assert_eq!(saved["version"], 1);
}

#[tokio::test]
async fn simultaneous_identical_uploads_create_one_original_and_one_revision() {
    let (db, doc, _, p) = setup().await;
    let r = app(db.clone());
    let path = format!("/api/v1/patients/{p}/documents");
    let body = upload_body();
    let (one, two) = tokio::join!(
        call(&r, &doc, "POST", &path, body.clone(), None),
        call(&r, &doc, "POST", &path, body, None)
    );
    assert_eq!(one.0, 200);
    assert_eq!(two.0, 200);
    assert_eq!(one.1["id"], two.1["id"]);
    for table in ["patient_documents", "patient_document_revisions"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }
}
