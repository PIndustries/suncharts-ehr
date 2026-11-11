// SPDX-License-Identifier: AGPL-3.0-only
use super::*;
use axum::{body::Body, http::StatusCode};
use std::sync::{Arc, Mutex};

const ORIGINAL: &[u8] = b"PK\x03\x04synthetic original Office package";
const EDITED: &[u8] = b"PK\x03\x04synthetic edited Office package";
const OFFICE_MIME: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

fn settings(origin: &str) -> Config {
    Config {
        origin: origin.into(),
        callback_origin: "http://127.0.0.1:8099".into(),
        secret: Zeroizing::new("synthetic-only-office-key-at-least-32-characters".into()),
    }
}

#[test]
fn exact_origins_and_purpose_scoped_expiring_capabilities() {
    assert_eq!(
        origin("https://office.example.test", false, false).unwrap(),
        "https://office.example.test"
    );
    for bad in [
        "http://office.example.test",
        "https://office.example.test/path",
        "https://user@office.example.test",
        "https://office.example.test?x=1",
        "https://office.example.test/#x",
        "http://host.docker.internal:8099",
    ] {
        assert!(origin(bad, false, false).is_err(), "{bad}");
    }
    assert!(origin("http://127.0.0.1:8099", true, false).is_ok());
    assert!(origin("http://host.docker.internal:8099", true, false).is_err());
    assert!(origin("http://host.docker.internal:8099", true, true).is_ok());
    let c = settings("https://office.example.test");
    let id = Uuid::new_v4();
    let token = c
        .capability(id, "office_source", Utc::now().timestamp() + 60)
        .unwrap();
    assert!(c.check_capability(&token, id, "office_source").is_ok());
    assert!(c.check_capability(&token, id, "office_callback").is_err());
    assert!(c
        .check_capability(&token, Uuid::new_v4(), "office_source")
        .is_err());
    let expired = c
        .capability(id, "office_source", Utc::now().timestamp() - 1)
        .unwrap();
    assert!(c.check_capability(&expired, id, "office_source").is_err());
    let missing_exp = c
        .sign(&json!({"session_id":id,"purpose":"office_source"}))
        .unwrap();
    assert!(c
        .check_capability(&missing_exp, id, "office_source")
        .is_err());
    let mut changed = settings("https://office.example.test");
    changed.secret = Zeroizing::new("another-synthetic-key-at-least-32-characters".into());
    assert!(changed
        .check_capability(&token, id, "office_source")
        .is_err());
    assert_ne!(changed.fingerprint(), c.fingerprint());
}

#[test]
fn callback_jwt_authenticates_exact_fields_and_algorithm() {
    let c = settings("https://office.example.test");
    let body = json!({"key":"sce_synthetic","status":6,"users":["synthetic"],"url":"https://office.example.test/edited.docx"});
    let token = c.sign(&json!({"payload":body})).unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    assert_eq!(signed_callback(&c, &headers, &body).unwrap(), body);
    assert_eq!(
        signed_callback(&c, &HeaderMap::new(), &json!({"token":token})).unwrap(),
        body
    );
    let mut tampered = body.clone();
    tampered["url"] = json!("https://attacker.example.test/file");
    assert!(signed_callback(&c, &headers, &tampered).is_err());
    assert!(signed_callback(&c, &HeaderMap::new(), &body).is_err());
    let wrong_algorithm = jsonwebtoken::encode(
        &Header::new(Algorithm::HS384),
        &body,
        &EncodingKey::from_secret(c.secret.as_bytes()),
    )
    .unwrap();
    assert!(signed_callback(&c, &HeaderMap::new(), &json!({"token":wrong_algorithm})).is_err());
    assert!(c.decode(&"a".repeat(65537)).is_err());
}

#[derive(Default)]
struct FakeOffice {
    commands: Mutex<Vec<Value>>,
    error: Mutex<i64>,
    wrong_key: Mutex<bool>,
    download_calls: Mutex<usize>,
}

async fn fake_office() -> (String, Arc<FakeOffice>, tokio::task::JoinHandle<()>) {
    let fake = Arc::new(FakeOffice::default());
    let router = Router::new()
        .route("/edited.docx", get(|ExtractState(f): ExtractState<Arc<FakeOffice>>| async move {
            *f.download_calls.lock().unwrap() += 1;
            EDITED
        }))
        .route("/redirect", get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/edited.docx")], "") }))
        .route("/empty", get(|| async { "" }))
        .route("/oversized", get(|| async { Body::from(vec![b'x'; MAX_FILE + 1]) }))
        .route("/command", post(|ExtractState(f): ExtractState<Arc<FakeOffice>>, Json(body): Json<Value>| async move {
            let c = settings("https://unused.example.test");
            let command = c.decode(body["token"].as_str().unwrap()).unwrap();
            f.commands.lock().unwrap().push(command.clone());
            Json(json!({"error":*f.error.lock().unwrap(),"key":if *f.wrong_key.lock().unwrap(){json!("wrong-key")}else{command["key"].clone()}}))
        }))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (origin, fake, task)
}

#[tokio::test]
async fn saved_file_fetch_is_origin_pinned_bounded_and_never_follows_redirects() {
    let (origin, fake, server) = fake_office().await;
    let c = settings(&origin);
    assert_eq!(
        fetch_saved(&c, &format!("{origin}/edited.docx"))
            .await
            .unwrap(),
        EDITED
    );
    for path in ["/redirect", "/empty", "/oversized"] {
        assert!(fetch_saved(&c, &format!("{origin}{path}")).await.is_err());
    }
    for url in [
        "http://127.0.0.1:1/edited.docx".to_owned(),
        format!("{origin}/edited.docx#fragment"),
        origin.replace("http://", "http://user@") + "/edited.docx",
    ] {
        assert!(fetch_saved(&c, &url).await.is_err());
    }
    assert_eq!(*fake.download_calls.lock().unwrap(), 1);
    server.abort();
}

struct Fixture {
    pool: PgPool,
    state: State,
    actor: Actor,
    patient: Uuid,
    document: Uuid,
    session: Uuid,
    auth_hash: String,
}
async fn fixture(c: &Config) -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable database required");
    let schema = format!("office_security_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    crate::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |conn, _| {
            let sql = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(&sql).execute(conn).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    crate::MIGRATOR.run(&pool).await.unwrap();
    let mut actor = crate::delivery::worker(Uuid::new_v4());
    actor.role = crate::auth::Role::Clinician;
    let patient = Uuid::new_v4();
    let document = Uuid::new_v4();
    let sid = Uuid::new_v4();
    let auth_hash = crate::browser::hash(&format!("synthetic-browser-{}", Uuid::new_v4()));
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-login','clinician')").bind(actor.tenant_id).bind(actor.sub).bind(format!("{}@example.test",actor.sub)).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(&auth_hash).bind(actor.tenant_id).bind(actor.sub).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-OFFICE','Avery','Synthetic','1990-01-01')").bind(actor.tenant_id).bind(patient).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO patient_documents(tenant_id,id,patient_id,request_id,create_request,content,filename,content_type,bytes,sha256,size_bytes,uploaded_by,updated_by) VALUES($1,$2,$3,$4,'{}',$5,'synthetic.docx',$6,$7,$8,$9,$10,$10)").bind(actor.tenant_id).bind(document).bind(patient).bind(Uuid::new_v4()).bind(json!({"title":"Synthetic Office","category":"consult","status":"active","document_date":"2026-11-11","visit_id":null,"notes":""})).bind(OFFICE_MIME).bind(ORIGINAL).bind(format!("{:x}",Sha256::digest(ORIGINAL))).bind(ORIGINAL.len() as i64).bind(actor.sub).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO office_editor_sessions(id,tenant_id,patient_id,document_id,actor_id,auth_session_hash,request_id,base_version,current_version,mode,config_hash,expires_at,metadata_version) VALUES($1,$2,$3,$4,$5,$6,$7,1,1,'edit',$8,now()+interval '1 hour',1)").bind(sid).bind(actor.tenant_id).bind(patient).bind(document).bind(actor.sub).bind(&auth_hash).bind(Uuid::new_v4()).bind(c.fingerprint()).execute(&pool).await.unwrap();
    let state = State {
        backend: Arc::new(crate::postgres::PostgresBackend(pool.clone())),
        browser: Some(
            crate::browser::BrowserAuth::new(pool.clone(), c.callback_origin.clone()).unwrap(),
        ),
        secret: "synthetic-office-only".into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
    };
    Fixture {
        pool,
        state,
        actor,
        patient,
        document,
        session: sid,
        auth_hash,
    }
}
async fn version_count(f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM patient_document_file_versions")
        .fetch_one(&f.pool)
        .await
        .unwrap()
}
async fn callback_body(f: &Fixture, origin: &str, operation: Uuid) -> Value {
    json!({"key":format!("sce_{}",f.session.simple()),"status":6,"forcesavetype":0,"users":[f.actor.sub.to_string()],"userdata":operation.to_string(),"filetype":"docx","url":format!("{origin}/edited.docx")})
}
async fn deliver(f: &Fixture, origin: &str, body: Value) -> Result<Json<Value>> {
    let c = settings(origin);
    let token = c.sign(&json!({"payload":body})).unwrap();
    let mut h = HeaderMap::new();
    h.insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    callback_with_config(f.state.clone(), f.session, c, h, body).await
}

#[tokio::test]
async fn saved_versions_require_current_identity_permissions_and_document_context() {
    let c = settings("https://office.example.test");
    let f = fixture(&c).await;
    let mut v = session(&f.pool, f.session, &c).await.unwrap();
    assert!(current_actor(&f.state, &v, true).await.is_ok());
    assert!(staff_binding(&f.actor, f.patient, f.document, &v).is_ok());
    assert!(staff_binding(&f.actor, Uuid::new_v4(), f.document, &v).is_err());
    let mut wrong_tenant = f.actor.clone();
    wrong_tenant.tenant_id = Uuid::new_v4();
    assert!(staff_binding(&wrong_tenant, f.patient, f.document, &v).is_err());
    v.actor_id = Uuid::new_v4();
    assert!(current_actor(&f.state, &v, true).await.is_err());
    v.actor_id = f.actor.sub;
    v.mode = "view".into();
    assert!(current_actor(&f.state, &v, true).await.is_err());
    v.mode = "edit".into();
    sqlx::query("UPDATE browser_users SET disabled=true WHERE id=$1")
        .bind(f.actor.sub)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(current_actor(&f.state, &v, true).await.is_err());
    sqlx::query("UPDATE browser_users SET disabled=false WHERE id=$1")
        .bind(f.actor.sub)
        .execute(&f.pool)
        .await
        .unwrap();
    let policy = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Office view only','clinician',$3,$4)").bind(f.actor.tenant_id).bind(policy).bind(json!({"clinical":{"view":true,"edit":false,"create":false,"delete":false}})).bind(f.actor.sub).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$2)").bind(f.actor.tenant_id).bind(f.actor.sub).bind(policy).execute(&f.pool).await.unwrap();
    assert!(current_actor(&f.state, &v, false).await.is_ok());
    assert!(current_actor(&f.state, &v, true).await.is_err());
    sqlx::query("UPDATE practice_access_assignments SET policy_id=NULL WHERE user_id=$1")
        .bind(f.actor.sub)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE browser_sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",
    )
    .bind(&f.auth_hash)
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(current_actor(&f.state, &v, false).await.is_err());
    let mut tx = f.pool.begin().await.unwrap();
    assert!(verify_editable(&mut tx, &f.actor, &v).await.is_ok());
    tx.rollback().await.unwrap();
    sqlx::query("UPDATE patient_documents SET content=jsonb_set(content,'{status}','\"archived\"') WHERE id=$1").bind(f.document).execute(&f.pool).await.unwrap();
    let mut tx = f.pool.begin().await.unwrap();
    assert!(verify_editable(&mut tx, &f.actor, &v).await.is_err());
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn requested_office_callback_appends_once_and_preserves_original_atomically() {
    let (origin, fake, server) = fake_office().await;
    let f = fixture(&settings(&origin)).await;
    let operation = Uuid::new_v4();
    let body = callback_body(&f, &origin, operation).await;
    assert!(deliver(&f, &origin, body.clone()).await.is_err());
    sqlx::query("INSERT INTO office_editor_saves(id,session_id,expected_version,status) VALUES($1,$2,1,'pending')").bind(operation).bind(f.session).execute(&f.pool).await.unwrap();
    let mut wrong_key = body.clone();
    wrong_key["key"] = json!("sce_other");
    assert!(deliver(&f, &origin, wrong_key).await.is_err());
    let mut wrong_users = body.clone();
    wrong_users["users"] = json!([Uuid::new_v4().to_string()]);
    assert_eq!(
        deliver(&f, &origin, wrong_users).await.unwrap().0["error"],
        1
    );
    let mut autosave = body.clone();
    autosave["forcesavetype"] = json!(2);
    assert_eq!(deliver(&f, &origin, autosave).await.unwrap().0["error"], 1);
    assert_eq!(*fake.download_calls.lock().unwrap(), 0);
    assert_eq!(version_count(&f).await, 0);
    // Failing the final audit must roll back the version, operation completion and session.
    sqlx::query("CREATE FUNCTION reject_office_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='patient.document.office_saved' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&f.pool).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_office_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_office_audit()").execute(&f.pool).await.unwrap();
    assert_eq!(
        deliver(&f, &origin, body.clone()).await.unwrap().0["error"],
        1
    );
    assert_eq!(version_count(&f).await, 0);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM office_editor_saves WHERE id=$1")
            .bind(operation)
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        "pending"
    );
    sqlx::query("DROP TRIGGER reject_office_audit ON audit_events")
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        deliver(&f, &origin, body.clone()).await.unwrap().0["error"],
        0
    );
    assert_eq!(version_count(&f).await, 1);
    assert_eq!(
        deliver(&f, &origin, body.clone()).await.unwrap().0["error"],
        0
    );
    assert_eq!(version_count(&f).await, 1);
    let original: Vec<u8> = sqlx::query_scalar("SELECT bytes FROM patient_documents WHERE id=$1")
        .bind(f.document)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(original, ORIGINAL);
    let edited: Vec<u8> = sqlx::query_scalar(
        "SELECT bytes FROM patient_document_file_versions WHERE document_id=$1 AND version=2",
    )
    .bind(f.document)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(edited, EDITED);
    let mut altered_replay = body.clone();
    altered_replay["url"] = json!(format!("{origin}/edited.docx?changed=1"));
    assert!(deliver(&f, &origin, altered_replay).await.is_err());
    assert!(
        sqlx::query("UPDATE patient_document_file_versions SET bytes=$1 WHERE document_id=$2")
            .bind(ORIGINAL)
            .bind(f.document)
            .execute(&f.pool)
            .await
            .is_err()
    );
    let mut stale = session(&f.pool, f.session, &settings(&origin))
        .await
        .unwrap();
    stale.current_version = 1;
    let mut tx = f.pool.begin().await.unwrap();
    assert!(verify_editable(&mut tx, &f.actor, &stale).await.is_err());
    tx.rollback().await.unwrap();
    sqlx::query("UPDATE browser_users SET disabled=true WHERE id=$1")
        .bind(f.actor.sub)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(deliver(&f, &origin, body).await.is_err());
    server.abort();
}

#[tokio::test]
async fn ambiguous_save_retries_same_operation_and_cannot_falsely_confirm_no_changes() {
    let (origin, fake, server) = fake_office().await;
    let f = fixture(&settings(&origin)).await;
    let operation = Uuid::new_v4();
    *fake.wrong_key.lock().unwrap() = true;
    let call = || {
        save_with_config(
            f.actor.clone(),
            f.state.clone(),
            f.patient,
            f.document,
            f.session,
            Save {
                request_id: operation,
                expected_version: 1,
            },
            settings(&origin),
        )
    };
    assert_eq!(call().await.unwrap().0["status"], "needs_review");
    *fake.wrong_key.lock().unwrap() = false;
    *fake.error.lock().unwrap() = 4;
    assert_eq!(call().await.unwrap().0["status"], "needs_review");
    assert_eq!(version_count(&f).await, 0);
    let commands = fake.commands.lock().unwrap().clone();
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0], commands[1]);
    assert_eq!(commands[0]["userdata"], operation.to_string());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM office_editor_saves")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        deliver(&f, &origin, callback_body(&f, &origin, operation).await)
            .await
            .unwrap()
            .0["error"],
        0
    );
    assert_eq!(call().await.unwrap().0["current_version"], 2);
    assert_eq!(fake.commands.lock().unwrap().len(), 2);
    assert_eq!(version_count(&f).await, 1);
    let next = Uuid::new_v4();
    // A first acknowledged no-change result may complete without appending content.
    let result = save_with_config(
        f.actor.clone(),
        f.state.clone(),
        f.patient,
        f.document,
        f.session,
        Save {
            request_id: next,
            expected_version: 2,
        },
        settings(&origin),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(result["status"], "saved");
    assert_eq!(result["current_version"], 2);
    assert_eq!(version_count(&f).await, 1);
    server.abort();
}

#[tokio::test]
async fn changed_encounter_metadata_or_unbound_legacy_session_cannot_save() {
    let (origin, fake, server) = fake_office().await;
    let f = fixture(&settings(&origin)).await;
    let operation = Uuid::new_v4();
    let body = callback_body(&f, &origin, operation).await;
    sqlx::query("INSERT INTO office_editor_saves(id,session_id,expected_version,status) VALUES($1,$2,1,'pending')").bind(operation).bind(f.session).execute(&f.pool).await.unwrap();
    let bound = session(&f.pool, f.session, &settings(&origin))
        .await
        .unwrap();
    sqlx::query("UPDATE patient_documents SET version=version+1,content=jsonb_set(content,'{visit_id}',to_jsonb($2::text)) WHERE id=$1").bind(f.document).bind(Uuid::new_v4().to_string()).execute(&f.pool).await.unwrap();
    assert!(current_actor(&f.state, &bound, true).await.is_err());
    assert!(deliver(&f, &origin, body).await.is_err());
    assert_eq!(*fake.download_calls.lock().unwrap(), 0);
    assert_eq!(version_count(&f).await, 0);
    let mut tx = f.pool.begin().await.unwrap();
    assert!(verify_editable(&mut tx, &f.actor, &bound).await.is_err());
    tx.rollback().await.unwrap();
    // Existing 0094 sessions have no trustworthy original metadata binding.
    let mut legacy = bound;
    legacy.metadata_version = None;
    assert!(current_actor(&f.state, &legacy, false).await.is_err());
    assert!(
        sqlx::query("UPDATE office_editor_sessions SET metadata_version=2 WHERE id=$1")
            .bind(f.session)
            .execute(&f.pool)
            .await
            .is_err(),
        "session metadata revision remains immutable"
    );
    server.abort();
}
