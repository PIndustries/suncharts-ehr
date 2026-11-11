// SPDX-License-Identifier: AGPL-3.0-only
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
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
    owner: Uuid,
    cookie: String,
    schema: String,
    url: String,
}
async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("practice_fees_{}", Uuid::new_v4().simple());
    let schema_clone = schema.clone();
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |c, _| {
            let query = format!("SET search_path TO {schema_clone}");
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
    let owner = Uuid::new_v4();
    let cookie = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'owner@example.test','synthetic-not-a-login-hash','owner')").bind(tenant).bind(owner).execute(&db).await.unwrap();
    session(&db, tenant, owner, &cookie).await;
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: "synthetic-practice-admin-test-secret".into(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
    });
    Fixture {
        db,
        app,
        tenant,
        owner,
        cookie,
        schema,
        url,
    }
}
async fn session(db: &PgPool, tenant: Uuid, user: Uuid, cookie: &str) {
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(format!("{:x}",Sha256::digest(cookie.as_bytes()))).bind(tenant).bind(user).execute(db).await.unwrap();
}
async fn cleanup(f: Fixture) {
    f.db.close().await;
    let base = PgPool::connect(&f.url).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", f.schema))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
}
async fn call(
    app: &Router,
    cookie: &str,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let mut q = Request::builder()
        .method(method)
        .uri(path)
        .header("Cookie", format!("sce_session={cookie}"))
        .header("Origin", ORIGIN)
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        q = q.header("If-Match", format!("\"{v}\""));
    }
    let response = app
        .clone()
        .oneshot(q.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let data = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&data).unwrap_or(Value::Null))
}
async fn clinical_fixture(f: &Fixture) -> (Uuid, Uuid, Uuid) {
    let p = Uuid::new_v4();
    let ap = Uuid::new_v4();
    let v = Uuid::new_v4();
    let facility = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-FEE','Synthetic','Fee','1980-01-01')").bind(f.tenant).bind(p).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO practice_providers(tenant_id,id,display_name) VALUES($1,$2,'Synthetic Provider')").bind(f.tenant).bind(f.owner).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO practice_facilities(tenant_id,id,name,address) VALUES($1,$2,'Synthetic Office','Synthetic address')").bind(f.tenant).bind(facility).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,facility) VALUES($1,$2,$3,$4,'2026-11-01T10:00:00Z','2026-11-01T10:30:00Z','Synthetic Office')").bind(f.tenant).bind(ap).bind(p).bind(f.owner).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id) VALUES($1,$2,$3,$4,$5)").bind(f.tenant).bind(v).bind(p).bind(ap).bind(f.owner).execute(&f.db).await.unwrap();
    (p, v, facility)
}
fn proposal(f: &Fixture, facility: Uuid) -> Value {
    json!({"request_id":Uuid::new_v4(),"reason":"Synthetic owner review fixture","content":{"name":"Synthetic reviewed fees","provider_id":f.owner,"facility_id":facility,"setting":"nonfacility","qp_basis":"non_qp","locality":"Synthetic locality","reference_from":"2026-01-01","reference_to":"2026-12-31","effective_from":"2026-10-01","effective_to":"2026-12-31","multiplier_basis_points":12500,"default_for_scope":true,"sources":[{"id":"synthetic","url":"https://www.cms.gov/synthetic-fixture","sha256":"a".repeat(64),"published_on":"2025-12-29"}],"entries":[{"code_system":"CPT","code":"99214","modifiers":"","reference_unit_cents":10001,"source_id":"synthetic","source_row":1,"qualification":"Synthetic numeric reference; not real Medicare data"},{"code_system":"CPT","code":"76942","modifiers":"26","reference_unit_cents":5000,"source_id":"synthetic","source_row":2,"qualification":"Synthetic professional component"}]}})
}
async fn quote(
    f: &Fixture,
    p: Uuid,
    v: Uuid,
    facility: Uuid,
    code: &str,
    mods: &str,
) -> (StatusCode, Value) {
    call(&f.app,&f.cookie,"GET",&format!("/api/v1/patients/{p}/fee-quote?visit_id={v}&service_date=2026-11-01&facility_id={facility}&setting=nonfacility&code_system=CPT&code={code}&modifiers={mods}&units=2"),Value::Null,None).await
}
#[tokio::test]
async fn approval_exact_scope_override_and_retirement_preserve_charge_evidence() {
    let f = setup().await;
    let (p, v, facility) = clinical_fixture(&f).await;
    let body = proposal(&f, facility);
    let (status, draft) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/fee-schedules",
        body.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{draft}");
    assert_eq!(draft["status"], "draft");
    let path = format!(
        "/api/v1/practice/fee-schedules/{}",
        draft["id"].as_str().unwrap()
    );
    let action_path = format!("{path}/actions");
    let (_, replay) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/fee-schedules",
        body.clone(),
        None,
    )
    .await;
    assert_eq!(draft, replay);
    assert!(quote(&f, p, v, facility, "99214", "").await.1["quote"].is_null());
    let (status, _) = call(
        &f.app,
        &f.cookie,
        "POST",
        &action_path,
        json!({"action":"approve","reason":"Review"}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status,approved)=call(&f.app,&f.cookie,"POST",&action_path,json!({"action":"approve","reason":"Verified synthetic source and scope","reviewed_scope_and_sources":true}),Some(1)).await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    let (_, q) = quote(&f, p, v, facility, "99214", "").await;
    assert_eq!(q["quote"]["unit_amount_cents"], 12501);
    assert_eq!(q["quote"]["expected_line_amount_cents"], 25002);
    assert!(quote(&f, p, v, facility, "99214", "25").await.1["quote"].is_null());
    assert!(quote(&f, p, v, facility, "76942", "").await.1["quote"].is_null());
    assert!(quote(&f, p, v, Uuid::new_v4(), "99214", "").await.1["quote"].is_null());
    let (_, context) = call(
        &f.app,
        &f.cookie,
        "GET",
        &format!("/api/v1/patients/{p}/fee-context?visit_id={v}&service_date=2026-11-01"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(context["facility_id"], json!(facility));
    assert_eq!(context["setting"], "nonfacility");
    let base = format!("/api/v1/patients/{p}/billing/accounts");
    let mut account = json!({"request_id":Uuid::new_v4(),"source_history_id":null,"reason":"Synthetic fee charge","content":{"visit_id":v,"coverage_id":null,"service_date":"2026-11-01","currency":"USD","notes":"","fee_context":{"facility_id":facility,"setting":"nonfacility"},"lines":[{"code_system":"CPT","code":"99214","description":"Synthetic service","modifiers":"","units":2,"amount_cents":24000,"diagnosis_codes":[],"fee_schedule_id":draft["id"],"fee_entry_key":"CPT:99214:","fee_snapshot":{"forged":"ignored"}}]}});
    let mut manual = account.clone();
    let line = manual["content"]["lines"][0].as_object_mut().unwrap();
    line.remove("fee_schedule_id");
    line.remove("fee_entry_key");
    line.remove("fee_snapshot");
    manual["request_id"] = json!(Uuid::new_v4());
    manual["content"]["fee_context"]["facility_id"] = json!(Uuid::new_v4());
    assert_eq!(
        call(&f.app, &f.cookie, "POST", &base, manual, None).await.0,
        StatusCode::BAD_REQUEST,
        "even manual-price context must belong to this tenant"
    );
    let (status, _) = call(&f.app, &f.cookie, "POST", &base, account.clone(), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    account["content"]["lines"][0]["fee_override_reason"] =
        json!("Owner-reviewed synthetic exception");
    let (status, saved) = call(&f.app, &f.cookie, "POST", &base, account.clone(), None).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let snapshot = &saved["content"]["lines"][0]["fee_snapshot"];
    assert_eq!(snapshot["expected_line_amount_cents"], 25002);
    assert_eq!(snapshot["actual_line_amount_cents"], 24000);
    assert!(snapshot.get("forged").is_none());
    let mut second = body.clone();
    second["request_id"] = json!(Uuid::new_v4());
    let (_, other) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/fee-schedules",
        second,
        None,
    )
    .await;
    let (status, _) = call(
        &f.app,
        &f.cookie,
        "POST",
        &format!(
            "/api/v1/practice/fee-schedules/{}/actions",
            other["id"].as_str().unwrap()
        ),
        json!({"action":"approve","reason":"Overlapping","reviewed_scope_and_sources":true}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(
        &f.app,
        &f.cookie,
        "POST",
        &action_path,
        json!({"action":"retire","reason":"Retain past evidence"}),
        Some(2),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(quote(&f, p, v, facility, "99214", "").await.1["quote"].is_null());
    sqlx::query("UPDATE practice_facilities SET version=version+1,address='Changed after original fee capture' WHERE tenant_id=$1 AND id=$2").bind(f.tenant).bind(facility).execute(&f.db).await.unwrap();
    let mut content = saved["content"].clone();
    content["notes"] = json!("Notes changed after retirement");
    content["lines"][0]["fee_snapshot"] = json!({"forged":"ignored again"});
    let (status, edited) = call(
        &f.app,
        &f.cookie,
        "PUT",
        &format!("{base}/{}", saved["id"].as_str().unwrap()),
        json!({"content":content,"reason":"Notes only"}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(&edited["content"]["lines"][0]["fee_snapshot"], snapshot);
    assert_eq!(edited["total_cents"], 24000);
    let (_, history) = call(
        &f.app,
        &f.cookie,
        "GET",
        &format!("{path}/history"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(history["items"].as_array().unwrap().len(), 3);
    let entries: i64 =
        sqlx::query_scalar("SELECT count(*) FROM billing_entries WHERE tenant_id=$1")
            .bind(f.tenant)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(entries, 0);
    let immutable =
        sqlx::query("UPDATE practice_fee_entries SET unit_amount_cents=1 WHERE tenant_id=$1")
            .bind(f.tenant)
            .execute(&f.db)
            .await;
    assert!(immutable.is_err());
    cleanup(f).await;
}
#[tokio::test]
async fn fee_admin_is_owner_only_tenant_bound_and_proposals_are_validated() {
    let f = setup().await;
    let (p, v, facility) = clinical_fixture(&f).await;
    let body = proposal(&f, facility);
    let (_, draft) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/fee-schedules",
        body.clone(),
        None,
    )
    .await;
    let other = Uuid::new_v4();
    let user = Uuid::new_v4();
    let cookie = "synthetic-other-fees";
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'other@example.test','synthetic','owner')").bind(other).bind(user).execute(&f.db).await.unwrap();
    session(&f.db, other, user, cookie).await;
    let (status, _) = call(
        &f.app,
        cookie,
        "GET",
        &format!(
            "/api/v1/practice/fee-schedules/{}",
            draft["id"].as_str().unwrap()
        ),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &f.app,
        cookie,
        "GET",
        &format!("/api/v1/patients/{p}/fee-context?visit_id={v}&service_date=2026-11-01"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    sqlx::query("UPDATE browser_users SET role='front_desk' WHERE tenant_id=$1 AND id=$2")
        .bind(other)
        .bind(user)
        .execute(&f.db)
        .await
        .unwrap();
    let (status, _) = call(
        &f.app,
        cookie,
        "POST",
        "/api/v1/practice/fee-schedules",
        body.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let mut bad = body.clone();
    bad["request_id"] = json!(Uuid::new_v4());
    bad["content"]["entries"][0]["reference_unit_cents"] = json!(0);
    let (status, _) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/fee-schedules",
        bad,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let mut bad = body;
    bad["content"]["name"] = json!("Changed retry");
    let (status, _) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/fee-schedules",
        bad,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    cleanup(f).await;
}
#[tokio::test]
async fn fees_reject_stale_directory_scopes_and_roll_back_failed_audits() {
    let f = setup().await;
    let (p, v, facility) = clinical_fixture(&f).await;
    let body = proposal(&f, facility);
    let (_, draft) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/fee-schedules",
        body.clone(),
        None,
    )
    .await;
    sqlx::query("UPDATE practice_facilities SET address='Changed synthetic locality',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(f.tenant).bind(facility).execute(&f.db).await.unwrap();
    let path = format!(
        "/api/v1/practice/fee-schedules/{}/actions",
        draft["id"].as_str().unwrap()
    );
    let approve = json!({"action":"approve","reason":"Reviewed","reviewed_scope_and_sources":true});
    assert_eq!(
        call(&f.app, &f.cookie, "POST", &path, approve.clone(), Some(1))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let mut replacement = body.clone();
    replacement["request_id"] = json!(Uuid::new_v4());
    let (_, draft) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/fee-schedules",
        replacement,
        None,
    )
    .await;
    let path = format!(
        "/api/v1/practice/fee-schedules/{}/actions",
        draft["id"].as_str().unwrap()
    );
    assert_eq!(
        call(&f.app, &f.cookie, "POST", &path, approve, Some(1))
            .await
            .0,
        StatusCode::OK
    );
    assert!(quote(&f, p, v, facility, "99214", "").await.1["quote"].is_object());
    sqlx::query("UPDATE practice_providers SET display_name='Updated synthetic clinician',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(f.tenant).bind(f.owner).execute(&f.db).await.unwrap();
    assert!(quote(&f, p, v, facility, "99214", "").await.1["quote"].is_null());
    let mut future = body.clone();
    future["request_id"] = json!(Uuid::new_v4());
    future["content"]["setting"] = json!("facility");
    let (_, unapproved) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/fee-schedules",
        future,
        None,
    )
    .await;
    sqlx::query("CREATE FUNCTION reject_fee_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='practice.fees.write' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&f.db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_fee_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_fee_audit()").execute(&f.db).await.unwrap();
    let approval_path = format!(
        "/api/v1/practice/fee-schedules/{}/actions",
        unapproved["id"].as_str().unwrap()
    );
    let(status,_)=call(&f.app,&f.cookie,"POST",&approval_path,json!({"action":"approve","reason":"Synthetic failed approval audit","reviewed_scope_and_sources":true}),Some(1)).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let (_, still_draft) = call(
        &f.app,
        &f.cookie,
        "GET",
        &format!(
            "/api/v1/practice/fee-schedules/{}",
            unapproved["id"].as_str().unwrap()
        ),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(still_draft["status"], "draft");
    assert_eq!(still_draft["version"], 1);
    let mut failing = body;
    failing["request_id"] = json!(Uuid::new_v4());
    let (status, _) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/fee-schedules",
        failing.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM practice_fee_schedules WHERE request_id=$1")
            .bind(Uuid::parse_str(failing["request_id"].as_str().unwrap()).unwrap())
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(count, 0);
    cleanup(f).await;
}
async fn bearer_call(app: &Router, token: &str, path: &str) -> StatusCode {
    app.clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}
#[tokio::test]
async fn fee_reads_require_staff_billing_permission_and_billing_oauth_scope() {
    let f = setup().await;
    let (p, v, _) = clinical_fixture(&f).await;
    let path = format!("/api/v1/patients/{p}/fee-context?visit_id={v}&service_date=2026-11-01");
    let state = State {
        backend: Arc::new(PostgresBackend(f.db.clone())),
        secret: "synthetic-patient-fee-token".into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(f.db.clone(), ORIGIN.into()).unwrap()),
    };
    let now = chrono::Utc::now().timestamp();
    let patient = suncharts_engine::auth::Actor {
        sub: Uuid::new_v4(),
        tenant_id: f.tenant,
        role: suncharts_engine::auth::Role::Patient,
        patient_id: Some(Uuid::new_v4()),
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 90,
    };
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &patient,
        &jsonwebtoken::EncodingKey::from_secret(state.secret.as_bytes()),
    )
    .unwrap();
    assert_eq!(
        bearer_call(&suncharts_engine::app(state), &token, &path).await,
        StatusCode::FORBIDDEN
    );
    let clinician = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'fee-reader@example.test','synthetic','clinician')").bind(f.tenant).bind(clinician).execute(&f.db).await.unwrap();
    let cookie = "synthetic-restricted-fee-reader";
    session(&f.db, f.tenant, clinician, cookie).await;
    let (_, catalog) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/access-policies",
        Value::Null,
        None,
    )
    .await;
    let mut permissions = catalog["defaults"].clone();
    permissions["billing"]["view"] = json!(false);
    let policy = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'No billing','clinician',$3,$4)").bind(f.tenant).bind(policy).bind(permissions).bind(f.owner).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)").bind(f.tenant).bind(clinician).bind(policy).bind(f.owner).execute(&f.db).await.unwrap();
    assert_eq!(
        call(&f.app, cookie, "GET", &path, Value::Null, None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let client = Uuid::new_v4();
    let grant = Uuid::new_v4();
    let token = format!("sce_at_{}", Uuid::new_v4());
    sqlx::query("INSERT INTO oauth_clients(id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES($1,$2,'Synthetic clinical client','synthetic','https://example.test/callback','clinical.read billing.read')").bind(client).bind(f.tenant).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,'clinical.read')").bind(grant).bind(client).bind(f.tenant).bind(f.owner).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '1 hour')").bind(format!("{:x}",Sha256::digest(token.as_bytes()))).bind(grant).execute(&f.db).await.unwrap();
    assert_eq!(
        bearer_call(&f.app, &token, &path).await,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE oauth_grants SET scope='billing.read' WHERE id=$1")
        .bind(grant)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(bearer_call(&f.app, &token, &path).await, StatusCode::OK);
    cleanup(f).await;
}
