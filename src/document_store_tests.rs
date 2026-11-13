// SPDX-License-Identifier: AGPL-3.0-only
//! Document storage against a disposable Postgres schema and an in-process
//! S3-compatible server that exists only for these tests. The server checks
//! every request's SigV4 signature and keeps every body it is sent, so the
//! tests can prove it never receives plaintext.
use crate::{
    auth::{Actor, Role},
    browser::BrowserAuth,
    document_store::{authorization, object_key, sha256_hex, DocumentStore, S3Settings, SignInput},
    postgres::PostgresBackend,
    State,
};
use axum::{
    body::{Body, Bytes},
    extract::State as ExtractState,
    http::{header, HeaderMap, Method, Request, StatusCode, Uri},
    response::Response,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &str = "synthetic-document-store-test-secret";
const ORIGIN: &str = "http://127.0.0.1:8099";
const BUCKET: &str = "synthetic-files";
const REGION: &str = "us-test-1";
const ACCESS: &str = "synthetic-access-key";
const S3_SECRET: &str = "synthetic-s3cr3t-key-value";
const MASTER: [u8; 32] = [42; 32];
const PDF: &[u8] = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\nsynthetic patient file\n%%EOF\n";

#[derive(Default)]
struct Fake {
    objects: Mutex<HashMap<String, Vec<u8>>>,
    puts: Mutex<Vec<(String, Vec<u8>)>>,
    requests: AtomicUsize,
    bad_signatures: AtomicUsize,
    down: AtomicBool,
    corrupt_reads: AtomicBool,
}
impl Fake {
    fn put_count(&self, key: &str) -> usize {
        self.puts
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _)| k == key)
            .count()
    }
    /// Every body ever received is sealed and none contains `plain`.
    fn assert_only_ciphertext(&self, plain: &[u8]) {
        for (key, body) in self.puts.lock().unwrap().iter() {
            assert_eq!(&body[..4], b"SCD\x01", "{key}");
            assert!(
                !body.windows(plain.len()).any(|w| w == plain),
                "plaintext reached file storage in {key}"
            );
        }
    }
}
fn signed(method: &Method, uri: &Uri, headers: &HeaderMap, body: &[u8]) -> bool {
    let value = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let (Some(given), Some(host), Some(payload), Some(date)) = (
        value("authorization"),
        value("host"),
        value("x-amz-content-sha256"),
        value("x-amz-date"),
    ) else {
        return false;
    };
    payload == sha256_hex(body)
        && given
            == authorization(&SignInput {
                access_key: ACCESS,
                secret_key: S3_SECRET,
                region: REGION,
                method: method.as_str(),
                canonical_uri: uri.path(),
                canonical_query: "",
                headers: &[
                    ("host", host),
                    ("x-amz-content-sha256", payload),
                    ("x-amz-date", date),
                ],
                payload_sha256: payload,
                amz_date: date,
            })
}
async fn fake_handler(
    ExtractState(f): ExtractState<Arc<Fake>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let reply = |status: StatusCode| {
        Response::builder()
            .status(status)
            .body(Body::empty())
            .unwrap()
    };
    f.requests.fetch_add(1, Ordering::SeqCst);
    if f.down.load(Ordering::SeqCst) {
        return reply(StatusCode::SERVICE_UNAVAILABLE);
    }
    if !signed(&method, &uri, &headers, &body) {
        f.bad_signatures.fetch_add(1, Ordering::SeqCst);
        return reply(StatusCode::FORBIDDEN);
    }
    let path = uri.path();
    if path == format!("/{BUCKET}") {
        return reply(if method == Method::HEAD {
            StatusCode::OK
        } else {
            StatusCode::METHOD_NOT_ALLOWED
        });
    }
    let Some(key) = path.strip_prefix(&format!("/{BUCKET}/")) else {
        return reply(StatusCode::NOT_FOUND);
    };
    let mut objects = f.objects.lock().unwrap();
    match method {
        Method::PUT => {
            f.puts.lock().unwrap().push((key.into(), body.to_vec()));
            objects.insert(key.into(), body.to_vec());
            reply(StatusCode::OK)
        }
        Method::HEAD => match objects.get(key) {
            Some(v) => Response::builder()
                .header(header::CONTENT_LENGTH, v.len())
                .body(Body::empty())
                .unwrap(),
            None => reply(StatusCode::NOT_FOUND),
        },
        Method::GET => match objects.get(key) {
            Some(v) => {
                let mut v = v.clone();
                if f.corrupt_reads.load(Ordering::SeqCst) {
                    let middle = v.len() / 2;
                    v[middle] ^= 0x01;
                }
                Response::new(Body::from(v))
            }
            None => reply(StatusCode::NOT_FOUND),
        },
        Method::DELETE => {
            objects.remove(key);
            reply(StatusCode::NO_CONTENT)
        }
        _ => reply(StatusCode::METHOD_NOT_ALLOWED),
    }
}
async fn fake_s3() -> (String, Arc<Fake>) {
    let fake = Arc::new(Fake::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .fallback(fake_handler)
        .with_state(fake.clone());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (endpoint, fake)
}
fn s3_store(endpoint: &str) -> Arc<DocumentStore> {
    DocumentStore::s3(
        S3Settings {
            endpoint: endpoint.into(),
            region: REGION.into(),
            bucket: BUCKET.into(),
            access_key: ACCESS.into(),
            secret_key: S3_SECRET.into(),
        },
        MASTER.to_vec(),
    )
    .unwrap()
}

struct Fx {
    db: PgPool,
    fake: Arc<Fake>,
    endpoint: String,
    /// New files go to the fake file storage.
    remote: Router,
    /// New files stay in the database, as on an install that set nothing.
    local: Router,
    store: Arc<DocumentStore>,
    clinician: Actor,
    tenant: Uuid,
    patient: Uuid,
    cookie: String,
}
fn app(db: &PgPool, store: Arc<DocumentStore>) -> Router {
    crate::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::with_document_store(db.clone(), ORIGIN.into(), store).unwrap()),
    })
}
async fn fixture() -> Fx {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("document_store_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    crate::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(8)
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
    crate::MIGRATOR.run(&db).await.unwrap();
    let now = chrono::Utc::now().timestamp();
    let tenant = Uuid::new_v4();
    let clinician = Actor {
        sub: Uuid::new_v4(),
        tenant_id: tenant,
        role: Role::Clinician,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 600,
    };
    let owner = Uuid::new_v4();
    for (id, role) in [(clinician.sub, "clinician"), (owner, "owner")] {
        sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-login',$4)").bind(tenant).bind(id).bind(format!("{id}@example.test")).bind(role).execute(&db).await.unwrap();
    }
    let cookie = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(format!("{:x}", Sha256::digest(cookie.as_bytes()))).bind(tenant).bind(owner).execute(&db).await.unwrap();
    let patient = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-STORE','Avery','Synthetic','1990-01-01')").bind(tenant).bind(patient).execute(&db).await.unwrap();
    let (endpoint, fake) = fake_s3().await;
    let store = s3_store(&endpoint);
    // As at startup, which confirms the bucket before serving.
    store.check().await.unwrap();
    Fx {
        remote: app(&db, store.clone()),
        local: app(&db, DocumentStore::database()),
        db,
        fake,
        endpoint,
        store,
        clinician,
        tenant,
        patient,
        cookie,
    }
}
async fn send(r: &Router, q: Request<Body>) -> (StatusCode, Vec<u8>) {
    let res = r.clone().oneshot(q).await.unwrap();
    let status = res.status();
    (
        status,
        res.into_body().collect().await.unwrap().to_bytes().to_vec(),
    )
}
impl Fx {
    fn token(&self) -> String {
        // Gateway tokens are short-lived, so mint a fresh one per request.
        let mut actor = self.clinician.clone();
        actor.iat = chrono::Utc::now().timestamp();
        actor.exp = actor.iat + 120;
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &actor,
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap()
    }
    /// Clinical staff call with a JSON body.
    async fn staff(
        &self,
        r: &Router,
        method: &str,
        path: &str,
        body: Value,
        version: Option<i64>,
    ) -> (StatusCode, Value) {
        let mut q = Request::builder()
            .method(method)
            .uri(path)
            .header("Authorization", format!("Bearer {}", self.token()))
            .header("Content-Type", "application/json");
        if let Some(v) = version {
            q = q.header("If-Match", format!("\"{v}\""));
        }
        let (status, bytes) = send(r, q.body(Body::from(body.to_string())).unwrap()).await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    async fn raw(&self, r: &Router, path: &str) -> (StatusCode, Vec<u8>) {
        let q = Request::builder()
            .uri(path)
            .header("Authorization", format!("Bearer {}", self.token()))
            .header("Accept", "application/pdf")
            .body(Body::empty())
            .unwrap();
        send(r, q).await
    }
    /// Owner browser session call.
    async fn owner(&self, r: &Router, method: &str, path: &str) -> (StatusCode, Value) {
        let q = Request::builder()
            .method(method)
            .uri(path)
            .header("Cookie", format!("sce_session={}", self.cookie))
            .header("Origin", ORIGIN)
            .body(Body::empty())
            .unwrap();
        let (status, bytes) = send(r, q).await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    fn upload_body(&self, content: &[u8], mime: &str) -> Value {
        json!({"request_id":Uuid::new_v4(),"filename":"synthetic.pdf","content_type":mime,"content_base64":STANDARD.encode(content),"content":{"title":"Synthetic consult","category":"consult","document_date":"2026-10-26","visit_id":null,"notes":"Synthetic only","status":"active"},"reason":"Synthetic upload"})
    }
    async fn upload(&self, r: &Router, content: &[u8]) -> Uuid {
        let (status, doc) = self
            .staff(
                r,
                "POST",
                &format!("/api/v1/patients/{}/documents", self.patient),
                self.upload_body(content, "application/pdf"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{doc}");
        doc["id"].as_str().unwrap().parse().unwrap()
    }
    async fn download(&self, r: &Router, id: Uuid) -> (StatusCode, Vec<u8>) {
        self.raw(
            r,
            &format!("/api/v1/patients/{}/documents/{id}/download", self.patient),
        )
        .await
    }
    /// (storage, bytes present, object key) of an original upload.
    async fn location(&self, id: Uuid) -> (String, bool, Option<String>) {
        sqlx::query_as(
            "SELECT storage,bytes IS NOT NULL,object_key FROM patient_documents WHERE id=$1",
        )
        .bind(id)
        .fetch_one(&self.db)
        .await
        .unwrap()
    }
    fn key(&self, id: Uuid, version: i64, content: &[u8]) -> String {
        object_key(self.tenant, id, version, &sha256_hex(content))
    }
}
fn numbered_pdf(n: usize) -> Vec<u8> {
    format!("%PDF-1.4\nsynthetic file {n}\n%%EOF\n").into_bytes()
}

#[tokio::test]
async fn s3_upload_stores_only_ciphertext_and_every_reader_returns_the_file() {
    let f = fixture().await;
    let id = f.upload(&f.remote, PDF).await;
    let key = f.key(id, 1, PDF);
    assert_eq!(
        f.location(id).await,
        ("s3".into(), false, Some(key.clone()))
    );
    assert_eq!(f.fake.objects.lock().unwrap().len(), 1);
    assert_eq!(f.fake.objects.lock().unwrap()[&key].len(), PDF.len() + 32);
    f.fake.assert_only_ciphertext(PDF);
    assert_eq!(
        f.download(&f.remote, id).await,
        (StatusCode::OK, PDF.to_vec())
    );
    let p = f.patient;
    for path in [
        format!("/api/v1/patients/{p}/documents/{id}/preview"),
        format!("/api/v1/patients/{p}/documents/{id}/files/1/download"),
        format!("/api/v1/patients/{p}/documents/{id}/files/1/preview"),
        format!("/fhir/Binary/{id}"),
    ] {
        assert_eq!(
            f.raw(&f.remote, &path).await,
            (StatusCode::OK, PDF.to_vec()),
            "{path}"
        );
    }
    let (status, meta) = f
        .staff(
            &f.remote,
            "GET",
            &format!("/api/v1/patients/{p}/documents/{id}"),
            json!({}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(meta["sha256"], sha256_hex(PDF));
    assert!(meta.get("object_key").is_none() && meta.get("storage").is_none());
    // Referral packages read attachments through the same per-row path.
    let mut tx = f.db.begin().await.unwrap();
    let reviewed = crate::documents::validate_current_link(&mut tx, f.tenant, p, id)
        .await
        .unwrap();
    let linked = crate::documents::linked_file_bytes(&mut tx, &f.store, f.tenant, p, id, &reviewed)
        .await
        .unwrap();
    assert_eq!(linked, PDF);
    assert_eq!(f.fake.bad_signatures.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn replayed_upload_returns_the_same_document_without_storing_again() {
    let f = fixture().await;
    let body = f.upload_body(PDF, "application/pdf");
    let path = format!("/api/v1/patients/{}/documents", f.patient);
    let (status, first) = f.staff(&f.remote, "POST", &path, body.clone(), None).await;
    assert_eq!(status, StatusCode::OK);
    let requests = f.fake.requests.load(Ordering::SeqCst);
    let (status, again) = f.staff(&f.remote, "POST", &path, body.clone(), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["id"], again["id"]);
    assert_eq!(f.fake.puts.lock().unwrap().len(), 1);
    assert_eq!(
        f.fake.requests.load(Ordering::SeqCst),
        requests,
        "a replay must not touch file storage"
    );
    // The same request identity with other content is still refused.
    let mut other = body;
    other["content_base64"] = json!(STANDARD.encode(numbered_pdf(1)));
    let (status, _) = f.staff(&f.remote, "POST", &path, other, None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(f.fake.puts.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn later_file_versions_are_stored_and_read_the_same_way() {
    let f = fixture().await;
    let p = f.patient;
    let text = b"Synthetic original letter";
    let (status, doc) = f
        .staff(
            &f.remote,
            "POST",
            &format!("/api/v1/patients/{p}/documents"),
            f.upload_body(text, "text/plain"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{doc}");
    let id: Uuid = doc["id"].as_str().unwrap().parse().unwrap();
    let save = json!({"request_id":Uuid::new_v4(),"text_content":"Synthetic edited letter","annotations":[],"reason":"Synthetic edit"});
    let files = format!("/api/v1/patients/{p}/documents/{id}/files");
    let (status, saved) = f
        .staff(&f.remote, "POST", &files, save.clone(), Some(1))
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["version"], 2);
    assert_eq!(saved["text_content"], "Synthetic edited letter");
    let (storage, in_row, key): (String, bool, Option<String>) = sqlx::query_as("SELECT storage,bytes IS NOT NULL,object_key FROM patient_document_file_versions WHERE document_id=$1 AND version=2").bind(id).fetch_one(&f.db).await.unwrap();
    assert_eq!((storage.as_str(), in_row), ("s3", false));
    assert_eq!(key.unwrap(), f.key(id, 2, b"Synthetic edited letter"));
    // Replay stores nothing new.
    let (status, replay) = f.staff(&f.remote, "POST", &files, save, Some(1)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay["version"], 2);
    assert_eq!(f.fake.puts.lock().unwrap().len(), 2);
    assert_eq!(
        f.raw(&f.remote, &format!("{files}/2/download")).await,
        (StatusCode::OK, b"Synthetic edited letter".to_vec())
    );
    assert_eq!(
        f.raw(&f.remote, &format!("{files}/1/download")).await.1,
        text
    );
    f.fake.assert_only_ciphertext(text);
    f.fake.assert_only_ciphertext(b"Synthetic edited letter");
}

#[tokio::test]
async fn database_mode_is_unchanged_and_never_contacts_file_storage() {
    let f = fixture().await;
    let id = f.upload(&f.local, PDF).await;
    assert_eq!(f.location(id).await, ("database".into(), true, None));
    let stored: Vec<u8> = sqlx::query_scalar("SELECT bytes FROM patient_documents WHERE id=$1")
        .bind(id)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(stored, PDF);
    assert_eq!(
        f.download(&f.local, id).await,
        (StatusCode::OK, PDF.to_vec())
    );
    let (status, state) = f
        .owner(&f.local, "GET", "/api/v1/practice/document-storage")
        .await;
    assert_eq!(status, StatusCode::OK, "{state}");
    assert_eq!(
        state,
        json!({"mode":"database","storage_available":null,"files":{"database":{"count":1,"bytes":PDF.len()},"s3":{"count":0,"bytes":0}}})
    );
    let (status, refused) = f
        .owner(&f.local, "POST", "/api/v1/practice/document-storage/move")
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(f.location(id).await.0, "database");
    // Only the fixture's startup bucket check has reached file storage.
    assert_eq!(f.fake.requests.load(Ordering::SeqCst), 1);
    let (status, ready) = send(
        &f.local,
        Request::builder()
            .uri("/ready")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let ready: Value = serde_json::from_slice(&ready).unwrap();
    assert_eq!(
        ready["document_store"],
        json!({"mode":"database","reachable":null})
    );
}

#[tokio::test]
async fn rows_in_either_place_are_readable_side_by_side() {
    let f = fixture().await;
    let (first, second) = (numbered_pdf(1), numbered_pdf(2));
    let in_database = f.upload(&f.local, &first).await;
    let in_storage = f.upload(&f.remote, &second).await;
    assert_eq!(f.location(in_database).await.0, "database");
    assert_eq!(f.location(in_storage).await.0, "s3");
    assert_eq!(
        f.download(&f.remote, in_database).await,
        (StatusCode::OK, first.clone())
    );
    assert_eq!(
        f.download(&f.remote, in_storage).await,
        (StatusCode::OK, second)
    );
    // A server with file storage switched off still serves its database rows
    // and answers clearly, with no bytes, for the rest.
    assert_eq!(
        f.download(&f.local, in_database).await,
        (StatusCode::OK, first)
    );
    let (status, body) = f.download(&f.local, in_storage).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["error"], "unavailable");
    assert_eq!(body["message"], crate::document_store::NOT_SET_UP);
}

#[tokio::test]
async fn move_verifies_each_file_before_switching_and_resumes_across_calls() {
    let f = fixture().await;
    let p = f.patient;
    let mut ids = Vec::new();
    for n in 0..27 {
        ids.push((f.upload(&f.local, &numbered_pdf(n)).await, numbered_pdf(n)));
    }
    let text = b"Synthetic letter";
    let (_, doc) = f
        .staff(
            &f.local,
            "POST",
            &format!("/api/v1/patients/{p}/documents"),
            f.upload_body(text, "text/plain"),
            None,
        )
        .await;
    let letter: Uuid = doc["id"].as_str().unwrap().parse().unwrap();
    let (status, _) = f
        .staff(&f.local, "POST", &format!("/api/v1/patients/{p}/documents/{letter}/files"), json!({"request_id":Uuid::new_v4(),"text_content":"Synthetic letter, edited","annotations":[],"reason":"Synthetic edit"}), Some(1))
        .await;
    assert_eq!(status, StatusCode::OK);
    // Only the fixture's startup bucket check has reached file storage.
    assert_eq!(f.fake.requests.load(Ordering::SeqCst), 1);
    let status_path = "/api/v1/practice/document-storage";
    let move_path = "/api/v1/practice/document-storage/move";
    let (_, before) = f.owner(&f.remote, "GET", status_path).await;
    assert_eq!(before["mode"], "s3");
    assert_eq!(before["storage_available"], true);
    assert_eq!(before["files"]["database"]["count"], 29);
    assert_eq!(before["files"]["s3"]["count"], 0);
    // Only an owner session may read or start it.
    let (status, _) = f.staff(&f.remote, "POST", move_path, json!({}), None).await;
    assert!(
        matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN),
        "{status}"
    );
    let (status, _) = f
        .staff(&f.remote, "GET", status_path, json!({}), None)
        .await;
    assert!(
        matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN),
        "{status}"
    );
    assert_eq!(f.fake.puts.lock().unwrap().len(), 0);

    let (status, first) = f.owner(&f.remote, "POST", move_path).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["moved"], 25);
    assert_eq!(first["remaining"], 4);
    assert_eq!(first["failed"], json!([]));
    assert_eq!(first["storage_available"], true);
    // Mid-way, every file is still readable from wherever it is.
    for (id, content) in &ids {
        assert_eq!(
            f.download(&f.remote, *id).await,
            (StatusCode::OK, content.clone())
        );
    }
    let (status, second) = f.owner(&f.remote, "POST", move_path).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(second["moved"], 4);
    assert_eq!(second["remaining"], 0);
    let (status, third) = f.owner(&f.remote, "POST", move_path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (&third["moved"], &third["remaining"]),
        (&json!(0), &json!(0))
    );

    for (id, content) in &ids {
        let key = f.key(*id, 1, content);
        assert_eq!(
            f.location(*id).await,
            ("s3".into(), false, Some(key.clone()))
        );
        assert_eq!(f.fake.put_count(&key), 1);
        assert_eq!(
            f.download(&f.remote, *id).await,
            (StatusCode::OK, content.clone())
        );
        f.fake.assert_only_ciphertext(content);
    }
    let files = format!("/api/v1/patients/{p}/documents/{letter}/files");
    assert_eq!(
        f.raw(&f.remote, &format!("{files}/1/download")).await.1,
        text
    );
    assert_eq!(
        f.raw(&f.remote, &format!("{files}/2/download")).await.1,
        b"Synthetic letter, edited"
    );
    let left: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM patient_documents WHERE bytes IS NOT NULL)+(SELECT count(*) FROM patient_document_file_versions WHERE bytes IS NOT NULL)").fetch_one(&f.db).await.unwrap();
    assert_eq!(left, 0);
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action='practice.document_storage.moved'",
    )
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(audited, 29);
    let (_, after) = f.owner(&f.remote, "GET", status_path).await;
    assert_eq!(after["files"]["database"]["count"], 0);
    assert_eq!(after["files"]["s3"]["count"], 29);
    // Metadata edits keep working on a moved document.
    let (id, _) = &ids[0];
    let (status, updated) = f
        .staff(&f.remote, "PUT", &format!("/api/v1/patients/{p}/documents/{id}"), json!({"content":{"title":"Renamed","category":"consult","document_date":null,"visit_id":null,"notes":"","status":"active"},"reason":"Synthetic rename"}), Some(1))
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(f.fake.bad_signatures.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_corrupted_read_back_leaves_the_file_in_the_database_and_is_reported() {
    let f = fixture().await;
    let id = f.upload(&f.local, PDF).await;
    let key = f.key(id, 1, PDF);
    let move_path = "/api/v1/practice/document-storage/move";
    f.fake.corrupt_reads.store(true, Ordering::SeqCst);
    let (status, result) = f.owner(&f.remote, "POST", move_path).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["moved"], 0);
    assert_eq!(result["remaining"], 1);
    assert_eq!(result["failed"][0]["document_id"], id.to_string());
    assert_eq!(result["failed"][0]["file_version"], 1);
    assert!(result["failed"][0]["reason"]
        .as_str()
        .unwrap()
        .contains("left where it is"));
    assert_eq!(f.location(id).await, ("database".into(), true, None));
    assert_eq!(
        f.download(&f.remote, id).await,
        (StatusCode::OK, PDF.to_vec())
    );
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action='practice.document_storage.moved'",
    )
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(audited, 0);
    // Once reads are sound again the same call finishes the job, re-verifying
    // the copy that is already there instead of writing over it.
    f.fake.corrupt_reads.store(false, Ordering::SeqCst);
    let (status, result) = f.owner(&f.remote, "POST", move_path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (&result["moved"], &result["remaining"]),
        (&json!(1), &json!(0))
    );
    assert_eq!(f.fake.put_count(&key), 1);
    assert_eq!(f.location(id).await, ("s3".into(), false, Some(key)));
    assert_eq!(
        f.download(&f.remote, id).await,
        (StatusCode::OK, PDF.to_vec())
    );
}

#[tokio::test]
async fn concurrent_move_calls_share_the_work_without_repeating_any_file() {
    let f = fixture().await;
    let mut ids = Vec::new();
    for n in 0..8 {
        ids.push((f.upload(&f.local, &numbered_pdf(n)).await, numbered_pdf(n)));
    }
    let move_path = "/api/v1/practice/document-storage/move";
    let (a, b, c) = tokio::join!(
        f.owner(&f.remote, "POST", move_path),
        f.owner(&f.remote, "POST", move_path),
        f.owner(&f.remote, "POST", move_path)
    );
    let mut moved = 0;
    for (status, result) in [a, b, c] {
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["failed"], json!([]));
        moved += result["moved"].as_i64().unwrap();
    }
    // A call can skip rows another call holds, so finish with one more pass.
    let (_, rest) = f.owner(&f.remote, "POST", move_path).await;
    assert_eq!(moved + rest["moved"].as_i64().unwrap(), 8);
    assert_eq!(rest["remaining"], 0);
    for (id, content) in &ids {
        assert_eq!(f.fake.put_count(&f.key(*id, 1, content)), 1);
        assert_eq!(
            f.download(&f.remote, *id).await,
            (StatusCode::OK, content.clone())
        );
    }
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action='practice.document_storage.moved'",
    )
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(audited, 8);
}

#[tokio::test]
async fn an_outage_gives_a_clean_temporary_error_and_writes_nothing() {
    let f = fixture().await;
    let kept = f.upload(&f.remote, PDF).await;
    let waiting = f.upload(&f.local, &numbered_pdf(1)).await;
    let documents: i64 = sqlx::query_scalar("SELECT count(*) FROM patient_documents")
        .fetch_one(&f.db)
        .await
        .unwrap();
    let objects = f.fake.objects.lock().unwrap().len();
    f.fake.down.store(true, Ordering::SeqCst);
    let path = format!("/api/v1/patients/{}/documents", f.patient);
    let (status, body) = f
        .staff(
            &f.remote,
            "POST",
            &path,
            f.upload_body(&numbered_pdf(2), "application/pdf"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        body,
        json!({"error":"unavailable","message":crate::document_store::UNAVAILABLE})
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM patient_documents")
            .fetch_one(&f.db)
            .await
            .unwrap(),
        documents
    );
    assert_eq!(f.fake.objects.lock().unwrap().len(), objects);
    assert_eq!(f.fake.puts.lock().unwrap().len(), 1);
    // Reads of stored files fail the same clean way; database rows still open.
    let (status, body) = f.download(&f.remote, kept).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(!body.windows(4).any(|w| w == b"%PDF"));
    assert_eq!(f.download(&f.remote, waiting).await.0, StatusCode::OK);
    let (status, _) = f
        .owner(&f.remote, "POST", "/api/v1/practice/document-storage/move")
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(f.location(waiting).await, ("database".into(), true, None));
    // The server stays ready and reports the dependency as out of reach.
    f.store.check().await.unwrap_err();
    let (status, ready) = send(
        &f.remote,
        Request::builder()
            .uri("/ready")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let ready: Value = serde_json::from_slice(&ready).unwrap();
    assert_eq!(
        ready["document_store"],
        json!({"mode":"s3","reachable":false})
    );
    // Recovery needs nothing but the store coming back.
    f.fake.down.store(false, Ordering::SeqCst);
    assert_eq!(
        f.download(&f.remote, kept).await,
        (StatusCode::OK, PDF.to_vec())
    );
    let (status, body) = f
        .staff(
            &f.remote,
            "POST",
            &path,
            f.upload_body(&numbered_pdf(2), "application/pdf"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn a_damaged_or_swapped_stored_file_is_refused_with_no_bytes() {
    let f = fixture().await;
    let (one, two) = (numbered_pdf(1), numbered_pdf(2));
    let a = f.upload(&f.remote, &one).await;
    let b = f.upload(&f.remote, &two).await;
    let (key_a, key_b) = (f.key(a, 1, &one), f.key(b, 1, &two));
    let refused = |result: (StatusCode, Vec<u8>)| {
        assert_eq!(result.0, StatusCode::INTERNAL_SERVER_ERROR);
        let body: Value = serde_json::from_slice(&result.1).unwrap();
        assert_eq!(
            body,
            json!({"error":"integrity","message":crate::document_store::FAILED_CHECK})
        );
    };
    let original = f.fake.objects.lock().unwrap()[&key_a].clone();
    // One flipped ciphertext bit.
    f.fake.objects.lock().unwrap().get_mut(&key_a).unwrap()[40] ^= 1;
    refused(f.download(&f.remote, a).await);
    // Another document's valid object in its place.
    let other = f.fake.objects.lock().unwrap()[&key_b].clone();
    f.fake.objects.lock().unwrap().insert(key_a.clone(), other);
    refused(f.download(&f.remote, a).await);
    // Missing altogether.
    f.fake.objects.lock().unwrap().remove(&key_a);
    refused(f.download(&f.remote, a).await);
    refused(
        f.raw(
            &f.remote,
            &format!(
                "/api/v1/patients/{}/documents/{a}/files/1/download",
                f.patient
            ),
        )
        .await,
    );
    // Restored, it opens again; the neighbour was never affected.
    f.fake.objects.lock().unwrap().insert(key_a, original);
    assert_eq!(f.download(&f.remote, a).await, (StatusCode::OK, one));
    assert_eq!(f.download(&f.remote, b).await, (StatusCode::OK, two));
}

#[tokio::test]
async fn the_database_permits_only_the_one_way_move() {
    let f = fixture().await;
    let p = f.patient;
    let id = f.upload(&f.local, PDF).await;
    let (_, doc) = f
        .staff(
            &f.local,
            "POST",
            &format!("/api/v1/patients/{p}/documents"),
            f.upload_body(b"Synthetic letter", "text/plain"),
            None,
        )
        .await;
    let letter: Uuid = doc["id"].as_str().unwrap().parse().unwrap();
    f.staff(&f.local, "POST", &format!("/api/v1/patients/{p}/documents/{letter}/files"), json!({"request_id":Uuid::new_v4(),"text_content":"Synthetic letter, edited","annotations":[],"reason":"Synthetic edit"}), Some(1)).await;
    let key = f.key(id, 1, PDF);
    let rejected = |sql: &'static str| {
        let db = f.db.clone();
        let (key, wrong) = (key.clone(), f.key(Uuid::new_v4(), 1, PDF));
        async move {
            let result = sqlx::query(sql)
                .bind(id)
                .bind(&key)
                .bind(&wrong)
                .execute(&db)
                .await;
            assert!(result.is_err(), "must be rejected: {sql}");
        }
    };
    // $1 document, $2 its correct object key, $3 a key for some other document.
    rejected("UPDATE patient_documents SET bytes=NULL WHERE id=$1 AND $2<>$3").await;
    rejected("UPDATE patient_documents SET bytes='\\x00' WHERE id=$1 AND $2<>$3").await;
    rejected("UPDATE patient_documents SET object_key=$2 WHERE id=$1 AND $2<>$3").await;
    rejected("UPDATE patient_documents SET storage='s3',object_key=$2 WHERE id=$1 AND $2<>$3")
        .await;
    rejected("UPDATE patient_documents SET storage='s3',bytes=NULL WHERE id=$1 AND $2<>$3").await;
    rejected(
        "UPDATE patient_documents SET storage='s3',bytes=NULL,object_key=$3 WHERE id=$1 AND $2<>$3",
    )
    .await;
    rejected("UPDATE patient_documents SET storage='s3',bytes=NULL,object_key=$2,sha256=repeat('0',64) WHERE id=$1 AND $2<>$3").await;
    rejected("UPDATE patient_documents SET storage='s3',bytes=NULL,object_key=$2,version=version+1 WHERE id=$1 AND $2<>$3").await;
    rejected("UPDATE patient_documents SET storage='s3',bytes=NULL,object_key=$2,content=content||'{\"title\":\"x\"}' WHERE id=$1 AND $2<>$3").await;
    rejected("DELETE FROM patient_documents WHERE id=$1 AND $2<>$3").await;
    rejected("INSERT INTO patient_documents(tenant_id,id,patient_id,request_id,create_request,content,filename,content_type,sha256,size_bytes,uploaded_by,updated_by,storage,object_key) SELECT tenant_id,gen_random_uuid(),patient_id,gen_random_uuid(),create_request,content,filename,content_type,sha256,size_bytes,uploaded_by,updated_by,'s3',$2 FROM patient_documents WHERE id=$1 AND $2<>$3").await;
    assert_eq!(f.location(id).await, ("database".into(), true, None));
    // The exact move is accepted, and it cannot be undone or repointed.
    sqlx::query("UPDATE patient_documents SET storage='s3',bytes=NULL,object_key=$2 WHERE id=$1")
        .bind(id)
        .bind(&key)
        .execute(&f.db)
        .await
        .unwrap();
    rejected("UPDATE patient_documents SET storage='database',object_key=NULL,bytes='%PDF' WHERE id=$1 AND $2<>$3").await;
    rejected("UPDATE patient_documents SET object_key=$3 WHERE id=$1 AND $2<>$3").await;
    rejected("UPDATE patient_documents SET object_key=NULL WHERE id=$1 AND $2<>$3").await;
    // File versions: append-only apart from the same move.
    let version_key = f.key(letter, 2, b"Synthetic letter, edited");
    for sql in [
        "UPDATE patient_document_file_versions SET reason='changed' WHERE document_id=$1",
        "UPDATE patient_document_file_versions SET bytes=NULL WHERE document_id=$1",
        "UPDATE patient_document_file_versions SET storage='s3',bytes=NULL,object_key=$2,reason='changed' WHERE document_id=$1",
        "UPDATE patient_document_file_versions SET storage='s3',bytes=NULL,object_key=$2||'x' WHERE document_id=$1",
        "DELETE FROM patient_document_file_versions WHERE document_id=$1",
    ] {
        let result = sqlx::query(sql).bind(letter).bind(&version_key).execute(&f.db).await;
        assert!(result.is_err(), "must be rejected: {sql}");
    }
    sqlx::query("UPDATE patient_document_file_versions SET storage='s3',bytes=NULL,object_key=$2 WHERE document_id=$1 AND version=2").bind(letter).bind(&version_key).execute(&f.db).await.unwrap();
    for sql in [
        "UPDATE patient_document_file_versions SET storage='database',object_key=NULL,bytes='x' WHERE document_id=$1 AND $2<>''",
        "DELETE FROM patient_document_file_versions WHERE document_id=$1 AND $2<>''",
    ] {
        let result = sqlx::query(sql).bind(letter).bind(&version_key).execute(&f.db).await;
        assert!(result.is_err(), "must be rejected: {sql}");
    }
}

#[tokio::test]
async fn startup_refuses_incomplete_or_unreachable_file_storage() {
    let f = fixture().await;
    let dir =
        std::env::temp_dir().join(format!("suncharts-store-test-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let (access, secret, empty) = (dir.join("access"), dir.join("secret"), dir.join("empty"));
    std::fs::write(&access, format!("{ACCESS}\n")).unwrap();
    std::fs::write(&secret, format!("{S3_SECRET}\n")).unwrap();
    std::fs::write(&empty, "\n").unwrap();
    let complete: HashMap<&str, String> = HashMap::from([
        ("ENGINE_DOCUMENT_STORE", "s3".to_string()),
        ("ENGINE_DOCUMENT_S3_ENDPOINT", f.endpoint.clone()),
        ("ENGINE_DOCUMENT_S3_REGION", REGION.to_string()),
        ("ENGINE_DOCUMENT_S3_BUCKET", BUCKET.to_string()),
        (
            "ENGINE_DOCUMENT_S3_ACCESS_KEY_FILE",
            access.to_str().unwrap().to_string(),
        ),
        (
            "ENGINE_DOCUMENT_S3_SECRET_KEY_FILE",
            secret.to_str().unwrap().to_string(),
        ),
    ]);
    let start = |settings: HashMap<&'static str, String>| {
        let db = f.db.clone();
        async move {
            let lookup = move |name: &str| settings.get(name).cloned();
            DocumentStore::configure(&lookup, Some(MASTER.to_vec()), &db).await
        }
    };
    let store = start(complete.clone()).await.unwrap();
    assert_eq!(store.mode(), "s3");
    assert_eq!(store.reachable(), Some(true));
    // Nothing set, or `database`, keeps today's behaviour.
    assert_eq!(start(HashMap::new()).await.unwrap().mode(), "database");
    let mut database = complete.clone();
    database.insert("ENGINE_DOCUMENT_STORE", "database".into());
    assert_eq!(start(database).await.unwrap().mode(), "database");
    let refused = |settings: HashMap<&'static str, String>, expect: &'static str| {
        let start = &start;
        async move {
            let error = start(settings)
                .await
                .err()
                .expect("startup must be refused");
            assert!(error.contains(expect), "{error}");
            assert!(
                !error.contains(S3_SECRET) && !error.contains(ACCESS),
                "{error}"
            );
        }
    };
    let mut unknown = complete.clone();
    unknown.insert("ENGINE_DOCUMENT_STORE", "filesystem".into());
    refused(unknown, "must be database or s3").await;
    for name in [
        "ENGINE_DOCUMENT_S3_ENDPOINT",
        "ENGINE_DOCUMENT_S3_REGION",
        "ENGINE_DOCUMENT_S3_BUCKET",
        "ENGINE_DOCUMENT_S3_ACCESS_KEY_FILE",
        "ENGINE_DOCUMENT_S3_SECRET_KEY_FILE",
    ] {
        let mut missing = complete.clone();
        missing.remove(name);
        refused(missing, name).await;
        let mut blank = complete.clone();
        blank.insert(name, String::new());
        refused(blank, name).await;
    }
    let mut unreadable = complete.clone();
    unreadable.insert(
        "ENGINE_DOCUMENT_S3_SECRET_KEY_FILE",
        dir.join("absent").to_str().unwrap().into(),
    );
    refused(
        unreadable,
        "ENGINE_DOCUMENT_S3_SECRET_KEY_FILE could not be read",
    )
    .await;
    let mut blank_file = complete.clone();
    blank_file.insert(
        "ENGINE_DOCUMENT_S3_ACCESS_KEY_FILE",
        empty.to_str().unwrap().into(),
    );
    refused(blank_file, "ENGINE_DOCUMENT_S3_ACCESS_KEY_FILE is empty").await;
    let mut path_endpoint = complete.clone();
    path_endpoint.insert(
        "ENGINE_DOCUMENT_S3_ENDPOINT",
        format!("{}/prefix", f.endpoint),
    );
    refused(path_endpoint, "ENGINE_DOCUMENT_S3_ENDPOINT").await;
    // Reachable server, but the bucket does not exist or the key is wrong.
    let mut other_bucket = complete.clone();
    other_bucket.insert("ENGINE_DOCUMENT_S3_BUCKET", "another-bucket".into());
    refused(other_bucket, "could not be reached").await;
    std::fs::write(&secret, "a-different-secret\n").unwrap();
    refused(complete.clone(), "could not be reached").await;
    std::fs::write(&secret, format!("{S3_SECRET}\n")).unwrap();
    // Storage that does not answer.
    f.fake.down.store(true, Ordering::SeqCst);
    refused(complete.clone(), "could not be reached").await;
    f.fake.down.store(false, Ordering::SeqCst);
    let mut closed = complete.clone();
    closed.insert("ENGINE_DOCUMENT_S3_ENDPOINT", "http://127.0.0.1:1".into());
    refused(closed, "could not be reached").await;
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn the_client_puts_gets_heads_and_deletes_with_valid_signatures() {
    let (endpoint, fake) = fake_s3().await;
    let store = s3_store(&endpoint);
    let client = store.client().unwrap();
    client.head_bucket().await.unwrap();
    assert_eq!(client.head_object("t/a/d/b/v1-c").await.unwrap(), None);
    assert_eq!(client.get_object("t/a/d/b/v1-c", 100).await.unwrap(), None);
    client
        .put_object("t/a/d/b/v1-c", b"sealed bytes")
        .await
        .unwrap();
    assert_eq!(client.head_object("t/a/d/b/v1-c").await.unwrap(), Some(12));
    assert_eq!(
        client
            .get_object("t/a/d/b/v1-c", 100)
            .await
            .unwrap()
            .unwrap(),
        b"sealed bytes"
    );
    assert!(
        client.get_object("t/a/d/b/v1-c", 5).await.is_err(),
        "oversized bodies are refused"
    );
    client.delete_object("t/a/d/b/v1-c").await.unwrap();
    assert_eq!(client.head_object("t/a/d/b/v1-c").await.unwrap(), None);
    assert_eq!(fake.bad_signatures.load(Ordering::SeqCst), 0);
    assert!(fake.requests.load(Ordering::SeqCst) >= 8);
}
