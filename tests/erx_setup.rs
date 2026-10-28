// SPDX-License-Identifier: AGPL-3.0-only
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::{Arc, OnceLock};
use suncharts_engine::{browser::BrowserAuth, postgres::PostgresBackend, State};
use tokio::sync::{Mutex, OwnedMutexGuard};
use tower::ServiceExt;
use uuid::Uuid;
const ORIGIN: &str = "http://127.0.0.1:8099";
static KEY: OnceLock<std::path::PathBuf> = OnceLock::new();
static SERIAL: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
struct Fixture {
    db: PgPool,
    app: Router,
    tenant: Uuid,
    owner: Uuid,
    clinician: Uuid,
    patient: Uuid,
    facility: Uuid,
    h: HeaderMap,
    clinician_h: HeaderMap,
    _guard: OwnedMutexGuard<()>,
}
impl Fixture {
    async fn new() -> Self {
        let guard = SERIAL
            .get_or_init(|| Arc::new(Mutex::new(())))
            .clone()
            .lock_owned()
            .await;
        KEY.get_or_init(|| {
            let p = std::env::temp_dir().join(format!("erx-setup-key-{}", Uuid::new_v4()));
            std::fs::write(&p, [73u8; 32]).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
            }
            std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", &p);
            p
        });
        let url =
            std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
        let schema = format!("erx_{}", Uuid::new_v4().simple());
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
        let tenant = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let clinician = Uuid::new_v4();
        let patient = Uuid::new_v4();
        let facility = Uuid::new_v4();
        let h = session(&db, tenant, owner, "owner").await;
        let clinician_h = session(&db, tenant, clinician, "clinician").await;
        for user in [owner, clinician] {
            sqlx::query("INSERT INTO practice_providers(tenant_id,id,display_name,npi) VALUES($1,$2,'Synthetic Prescriber','1234567893')").bind(tenant).bind(user).execute(&db).await.unwrap();
        }
        sqlx::query("INSERT INTO practice_facilities(tenant_id,id,name,address,phone) VALUES($1,$2,'Synthetic Facility','1 Example Road','555-0100')").bind(tenant).bind(facility).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'ERX-SYNTHETIC','Synthetic','Patient','1980-01-01')").bind(tenant).bind(patient).execute(&db).await.unwrap();
        let app = suncharts_engine::app(State {
            backend: Arc::new(PostgresBackend(db.clone())),
            secret: "synthetic-unused".into(),
            allow_legacy_gateway: false,
            issuer: "suncharts".into(),
            audience: "suncharts-engine".into(),
            browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
        });
        Self {
            db,
            app,
            tenant,
            owner,
            clinician,
            patient,
            facility,
            h,
            clinician_h,
            _guard: guard,
        }
    }
    async fn call(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        call(&self.app, &self.h, method, path, body).await
    }
    async fn status(&self) -> Value {
        let (s, v) = self
            .call("GET", "/api/v1/prescribing/erx", Value::Null)
            .await;
        assert_eq!(s, 200, "{v}");
        v
    }
    fn setup(&self) -> Value {
        json!({"request_id":Uuid::new_v4(),"version":0,"candidate_profile":"weno_ez","enrollment_stage":"not_started","organization_reference":"Synthetic clinic evaluation","requested_capabilities":["non_controlled","epcs"],"credentials":null,"clear_credentials":false,"reason":"Evaluate documented options; no provider enrolled"})
    }
    fn mapping(&self) -> Value {
        json!({"request_id":Uuid::new_v4(),"version":0,"facility_id":self.facility,"vendor_user_id":"SYNTHETIC-PRESCRIBER","vendor_username":"synthetic@example.test","vendor_location_id":"SYNTHETIC-LOCATION","enrollment_reported":false,"credentials":null,"clear_credentials":false,"reason":"Prepare local mapping only"})
    }
    fn attempt_path(&self) -> String {
        format!("/api/v1/patients/{}/prescribing/erx/attempts", self.patient)
    }
}
async fn session(db: &PgPool, tenant: Uuid, user: Uuid, role: &str) -> HeaderMap {
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-login',$4)").bind(user).bind(tenant).bind(format!("{}@example.test",user.simple())).bind(role).execute(db).await.unwrap();
    let token = format!("synthetic-erx-session-{}", Uuid::new_v4());
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
    let mut q = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    for (k, v) in h {
        q = q.header(k, v);
    }
    let r = app
        .clone()
        .oneshot(q.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let s = r.status();
    let b = r.into_body().collect().await.unwrap().to_bytes();
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}
#[tokio::test]
async fn no_provider_is_selected_or_activated_by_candidate_preparation() {
    let f = Fixture::new().await;
    let initial = f.status().await;
    assert_eq!(initial["connection"]["candidate_profile"], "none");
    assert_eq!(initial["readiness"]["active_provider"], Value::Null);
    assert_eq!(initial["readiness"]["launch_available"], false);
    let body = f.setup();
    let path = "/api/v1/prescribing/erx/connection";
    let (s, c) = f.call("PUT", path, body.clone()).await;
    assert_eq!(s, 200, "{c}");
    assert_eq!(c["active"], false);
    assert_eq!(c["version"], 1);
    assert_eq!(f.call("PUT", path, body).await.1, c);
    let (s, m) = f
        .call(
            "PUT",
            &format!("/api/v1/prescribing/erx/prescribers/{}", f.owner),
            f.mapping(),
        )
        .await;
    assert_eq!(s, 200, "{m}");
    let status = f.status().await;
    assert_eq!(status["readiness"]["ready"], false);
    assert_eq!(status["readiness"]["vendor_contacted"], false);
    assert_eq!(status["readiness"]["epcs_available"], false);
    assert!(sqlx::query(
        "UPDATE erx_connections SET active=true,version=version+1 WHERE tenant_id=$1"
    )
    .bind(f.tenant)
    .execute(&f.db)
    .await
    .is_err());
    f.db.close().await;
}
#[tokio::test]
async fn secrets_are_encrypted_never_reflected_and_request_replay_compares_them() {
    let f = Fixture::new().await;
    let mut v = f.setup();
    let secret = "SYNTHETIC-ERX-PASSWORD-NOT-LIVE";
    v["credentials"] = json!({"username":"SYNTHETIC-USER","password":secret,"api_key":"SYNTHETIC-KEY","encryption_key":"SYNTHETIC-ENCRYPTION"});
    let (s, out) = f
        .call("PUT", "/api/v1/prescribing/erx/connection", v.clone())
        .await;
    assert_eq!(s, 200, "{out}");
    assert_eq!(out["credentials"]["stored"], true);
    assert!(!out.to_string().contains(secret));
    assert!(!f.status().await.to_string().contains(secret));
    let stored: Vec<u8> =
        sqlx::query_scalar("SELECT encrypted_credentials FROM erx_connections WHERE tenant_id=$1")
            .bind(f.tenant)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert!(!stored.windows(secret.len()).any(|s| s == secret.as_bytes()));
    let rows:String=sqlx::query_scalar("SELECT coalesce(string_agg(to_jsonb(a)::text,''),'') FROM audit_events a WHERE tenant_id=$1").bind(f.tenant).fetch_one(&f.db).await.unwrap();
    assert!(!rows.contains(secret));
    let history: String = sqlx::query_scalar(
        "SELECT string_agg(public_snapshot::text,'') FROM erx_setup_history WHERE tenant_id=$1",
    )
    .bind(f.tenant)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert!(!history.contains(secret));
    assert!(!history.contains("SYNTHETIC-USER"));
    let request_bytes: Vec<u8> =
        sqlx::query_scalar("SELECT encrypted_request FROM erx_setup_requests WHERE tenant_id=$1")
            .bind(f.tenant)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert!(!request_bytes
        .windows(secret.len())
        .any(|s| s == secret.as_bytes()));
    assert_eq!(
        f.call("PUT", "/api/v1/prescribing/erx/connection", v.clone())
            .await
            .1,
        out
    );
    v["credentials"]["password"] = json!("DIFFERENT-SYNTHETIC-PASSWORD");
    assert_eq!(
        f.call("PUT", "/api/v1/prescribing/erx/connection", v)
            .await
            .0,
        409
    );
    f.db.close().await;
}
#[tokio::test]
async fn configuration_requires_owner_and_prescriber_changes_bind_to_self_or_owner() {
    let f = Fixture::new().await;
    assert_eq!(
        call(
            &f.app,
            &f.clinician_h,
            "PUT",
            "/api/v1/prescribing/erx/connection",
            f.setup()
        )
        .await
        .0,
        403
    );
    assert_eq!(
        f.call("PUT", "/api/v1/prescribing/erx/connection", f.setup())
            .await
            .0,
        200
    );
    let self_path = format!("/api/v1/prescribing/erx/prescribers/{}", f.clinician);
    assert_eq!(
        call(&f.app, &f.clinician_h, "PUT", &self_path, f.mapping())
            .await
            .0,
        200
    );
    let owner_path = format!("/api/v1/prescribing/erx/prescribers/{}", f.owner);
    assert_eq!(
        call(&f.app, &f.clinician_h, "PUT", &owner_path, f.mapping())
            .await
            .0,
        403
    );
    let nurse = session(&f.db, f.tenant, Uuid::new_v4(), "nurse").await;
    assert_eq!(
        call(&f.app, &nurse, "PUT", &self_path, f.mapping()).await.0,
        403
    );
    let view = call(
        &f.app,
        &f.clinician_h,
        "GET",
        "/api/v1/prescribing/erx",
        Value::Null,
    )
    .await;
    assert_eq!(view.1["mappings"].as_array().unwrap().len(), 1);
    assert_eq!(view.1["prescribers"].as_array().unwrap().len(), 1);
    let foreign = session(&f.db, Uuid::new_v4(), Uuid::new_v4(), "owner").await;
    let other = call(
        &f.app,
        &foreign,
        "GET",
        "/api/v1/prescribing/erx",
        Value::Null,
    )
    .await
    .1;
    assert_eq!(other["connection"]["version"], 0);
    assert_eq!(other["mappings"], json!([]));
    let mut origin = f.h.clone();
    origin.insert(
        "origin",
        HeaderValue::from_static("https://untrusted.example"),
    );
    assert_eq!(
        call(
            &f.app,
            &origin,
            "PUT",
            "/api/v1/prescribing/erx/connection",
            f.setup()
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
            "/api/v1/prescribing/erx",
            Value::Null
        )
        .await
        .0,
        401
    );
    f.db.close().await;
}
#[tokio::test]
async fn candidate_change_does_not_reuse_prior_vendor_credentials_or_mapping() {
    let f = Fixture::new().await;
    let mut body = f.setup();
    body["credentials"] = json!({"password":"SYNTHETIC-OLD-VENDOR-PASSWORD"});
    assert_eq!(
        f.call("PUT", "/api/v1/prescribing/erx/connection", body.clone())
            .await
            .0,
        200
    );
    let mut mapping = f.mapping();
    mapping["credentials"] = json!({"password":"SYNTHETIC-PRESCRIBER-PASSWORD"});
    let mp = format!("/api/v1/prescribing/erx/prescribers/{}", f.owner);
    assert_eq!(f.call("PUT", &mp, mapping.clone()).await.0, 200);
    body["request_id"] = json!(Uuid::new_v4());
    body["version"] = json!(1);
    body["candidate_profile"] = json!("dosespot_full");
    body["credentials"] = Value::Null;
    assert_eq!(
        f.call("PUT", "/api/v1/prescribing/erx/connection", body.clone())
            .await
            .0,
        409
    );
    body["clear_credentials"] = json!(true);
    let (s, out) = f
        .call("PUT", "/api/v1/prescribing/erx/connection", body)
        .await;
    assert_eq!(s, 200, "{out}");
    assert_eq!(out["profile_revision"], 2);
    assert_eq!(out["credentials"]["stored"], false);
    assert_eq!(f.status().await["mappings"][0]["profile_current"], false);
    mapping["request_id"] = json!(Uuid::new_v4());
    mapping["version"] = json!(1);
    mapping["credentials"] = Value::Null;
    assert_eq!(f.call("PUT", &mp, mapping.clone()).await.0, 409);
    mapping["clear_credentials"] = json!(true);
    assert_eq!(f.call("PUT", &mp, mapping).await.0, 200);
    f.db.close().await;
}
#[tokio::test]
async fn blocked_attempts_are_durable_idempotent_and_never_modify_native_orders() {
    let f = Fixture::new().await;
    let draft = json!({"request_id":Uuid::new_v4(),"content":{"medication_name":"Synthetic local-only order","rxnorm_code":"","strength":"10 mg","dosage_form":"tablet","dose":"One tablet","route":"oral","frequency":"Daily","instructions":"Synthetic instructions","indication":"Synthetic indication","quantity":"30","quantity_unit":"tablets","refills":0,"days_supply":30,"start_date":null,"end_date":null,"substitution_allowed":false,"controlled_substance":false,"pharmacy_id":null},"visit_id":null,"prior_prescription_id":null,"relationship":null,"reason":"Synthetic local draft"});
    let (native_status, native) = f
        .call(
            "POST",
            &format!("/api/v1/patients/{}/prescriptions", f.patient),
            draft,
        )
        .await;
    assert_eq!(native_status, 200, "{native}");

    let body = json!({"request_id":Uuid::new_v4(),"connection_version":0,"native_prescription_id":native["id"],"reason":"Inspect enrollment prerequisites"});
    let (s, out) = f.call("POST", &f.attempt_path(), body.clone()).await;
    assert_eq!(s, 200, "{out}");
    assert_eq!(out["outcome"], "blocked");
    assert_eq!(out["vendor_contacted"], false);
    assert_eq!(f.call("POST", &f.attempt_path(), body.clone()).await.1, out);
    assert_eq!(
        f.call("GET", &f.attempt_path(), Value::Null).await.1["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let foreign = session(&f.db, Uuid::new_v4(), Uuid::new_v4(), "owner").await;
    assert_eq!(
        call(&f.app, &foreign, "GET", &f.attempt_path(), Value::Null)
            .await
            .0,
        404
    );
    let other_patient = Uuid::new_v4();
    let (s, _) = f
        .call(
            "POST",
            &format!("/api/v1/patients/{other_patient}/prescribing/erx/attempts"),
            body,
        )
        .await;
    assert_eq!(s, 404);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM native_prescriptions WHERE tenant_id=$1"
        )
        .bind(f.tenant)
        .fetch_one(&f.db)
        .await
        .unwrap(),
        1
    );
    assert!(sqlx::query(
        "UPDATE erx_readiness_attempts SET vendor_contacted=true WHERE tenant_id=$1"
    )
    .bind(f.tenant)
    .execute(&f.db)
    .await
    .is_err());
    let current = f
        .call(
            "GET",
            &format!(
                "/api/v1/patients/{}/prescriptions/{}",
                f.patient,
                native["id"].as_str().unwrap()
            ),
            Value::Null,
        )
        .await
        .1;
    assert_eq!(current, native);
    f.db.close().await;
}
#[tokio::test]
async fn audit_failure_rolls_back_settings_history_and_replay_record() {
    let f = Fixture::new().await;
    sqlx::query("CREATE FUNCTION reject_erx_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='prescribing.erx.connection_saved' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&f.db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_erx_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_erx_audit()").execute(&f.db).await.unwrap();
    let body = f.setup();
    assert_eq!(
        f.call("PUT", "/api/v1/prescribing/erx/connection", body.clone())
            .await
            .0,
        500
    );
    for table in ["erx_connections", "erx_setup_history", "erx_setup_requests"] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&f.db)
                .await
                .unwrap(),
            0
        );
    }
    sqlx::query("DROP TRIGGER reject_erx_audit ON audit_events")
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        f.call("PUT", "/api/v1/prescribing/erx/connection", body)
            .await
            .0,
        200
    );
    f.db.close().await;
}
#[tokio::test]
async fn lost_server_key_fails_closed_even_when_current_credentials_are_cleared() {
    let f = Fixture::new().await;
    let body = f.setup();
    assert_eq!(
        f.call("PUT", "/api/v1/prescribing/erx/connection", body)
            .await
            .0,
        200
    );
    let key = KEY.get().unwrap();
    let backup = key.with_extension("held");
    std::fs::rename(key, &backup).unwrap();
    let result = f.status().await;
    assert_eq!(result["credential_storage_ready"], false);
    let mut change = f.setup();
    change["version"] = json!(1);
    let response = f
        .call("PUT", "/api/v1/prescribing/erx/connection", change)
        .await;
    std::fs::rename(&backup, key).unwrap();
    assert_eq!(response.0, 400);
    assert_eq!(f.status().await["connection"]["version"], 1);
    assert_eq!(f.status().await["credential_storage_ready"], true);
    f.db.close().await;
}
#[tokio::test]
async fn concurrent_setup_retries_commit_once_and_reported_access_cannot_activate_a_provider() {
    let f = Fixture::new().await;
    let mut body = f.setup();
    body["candidate_profile"] = json!("photon");
    body["enrollment_stage"] = json!("test_access_reported");
    let (a, b) = tokio::join!(
        f.call("PUT", "/api/v1/prescribing/erx/connection", body.clone()),
        f.call("PUT", "/api/v1/prescribing/erx/connection", body.clone())
    );
    assert_eq!(a.0, 200, "{}", a.1);
    assert_eq!(a.1, b.1);
    assert_eq!(a.1["version"], 1);
    assert_eq!(a.1["active"], false);
    assert_eq!(a.1["vendor_verified"], false);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM erx_setup_history WHERE tenant_id=$1")
            .bind(f.tenant)
            .fetch_one(&f.db)
            .await
            .unwrap(),
        1
    );
    let status = f.status().await;
    assert_eq!(status["readiness"]["ready"], false);
    assert_eq!(status["readiness"]["active_provider"], Value::Null);
    body["request_id"] = json!(Uuid::new_v4());
    body["organization_reference"] = json!("Stale edit must not overwrite");
    assert_eq!(
        f.call("PUT", "/api/v1/prescribing/erx/connection", body.clone())
            .await
            .0,
        409
    );
    body["version"] = json!(1);
    body["active"] = json!(true);
    assert_eq!(
        f.call("PUT", "/api/v1/prescribing/erx/connection", body)
            .await
            .0,
        422
    );
    assert_eq!(f.status().await["connection"]["version"], 1);
    f.db.close().await;
}

#[tokio::test]
async fn staff_context_rejects_shared_cookie_switch_without_mutation_or_logout() {
    let f = Fixture::new().await;
    let other_tenant = Uuid::new_v4();
    let other_user = Uuid::new_v4();
    let other = session(&f.db, other_tenant, other_user, "owner").await;
    let mut stale = other.clone();
    stale.insert(
        "x-suncharts-staff-context",
        HeaderValue::from_str(&format!("{}:{}", f.tenant, f.owner)).unwrap(),
    );
    for (method, path, body) in [
        ("GET", "/api/v1/patients", Value::Null),
        (
            "POST",
            "/api/v1/patients",
            json!({"mrn":"STALE-CONTEXT","given_name":"Synthetic","family_name":"Stale","birth_date":"1980-01-01"}),
        ),
        ("PUT", "/api/v1/prescribing/erx/connection", f.setup()),
        ("POST", "/auth/logout", json!({})),
    ] {
        let (status, data) = call(&f.app, &stale, method, path, body).await;
        assert_eq!(status, StatusCode::CONFLICT, "{path}: {data}");
        assert_eq!(
            data["message"],
            "Staff account changed. Sign in again to continue."
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM patients WHERE tenant_id=$1")
            .bind(other_tenant)
            .fetch_one(&f.db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM erx_connections WHERE tenant_id=$1")
            .bind(other_tenant)
            .fetch_one(&f.db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        call(&f.app, &other, "GET", "/auth/me", Value::Null).await.0,
        StatusCode::OK
    );
    let mut matched = other.clone();
    matched.insert(
        "x-suncharts-staff-context",
        HeaderValue::from_str(&format!("{other_tenant}:{other_user}")).unwrap(),
    );
    assert_eq!(
        call(&f.app, &matched, "GET", "/api/v1/patients", Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    let mut request = Request::builder().method("POST").uri("/auth/logout");
    for (key, value) in &stale {
        request = request.header(key, value);
    }
    let rejected = f
        .app
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::CONFLICT);
    assert!(!rejected.headers().contains_key("set-cookie"));
    let created=call(&f.app,&matched,"POST","/api/v1/patients",json!({"mrn":"BOUND-CONTEXT","given_name":"Synthetic","family_name":"Bound","birth_date":"1980-01-01"})).await;
    assert_eq!(created.0, StatusCode::CREATED, "{}", created.1);
    let mut duplicate = matched.clone();
    duplicate.append(
        "x-suncharts-staff-context",
        matched["x-suncharts-staff-context"].clone(),
    );
    assert_eq!(
        call(&f.app, &duplicate, "GET", "/auth/me", Value::Null)
            .await
            .0,
        StatusCode::CONFLICT
    );
    for invalid in [
        "bad-context".to_string(),
        format!("{other_tenant}:{}", f.owner),
    ] {
        matched.insert(
            "x-suncharts-staff-context",
            HeaderValue::from_str(&invalid).unwrap(),
        );
        assert_eq!(
            call(&f.app, &matched, "GET", "/auth/me", Value::Null)
                .await
                .0,
            StatusCode::CONFLICT
        );
    }
}
