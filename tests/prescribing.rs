// SPDX-License-Identifier: AGPL-3.0-only
//! Actual PostgreSQL and HTTP authorization, immutability and reconciliation boundaries.
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
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
    patient: Uuid,
    headers: HeaderMap,
}
impl Fixture {
    async fn new() -> Self {
        let url =
            std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
        let schema = format!("rx_{}", Uuid::new_v4().simple());
        let pool = PgPool::connect(&url).await.unwrap();
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
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
        let user = Uuid::new_v4();
        let patient = Uuid::new_v4();
        let headers = session(&db, tenant, user, "clinician").await;
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'RX-SYNTHETIC','Synthetic <script>','Patient','1980-01-01')").bind(tenant).bind(patient).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO practice_providers(tenant_id,id,display_name,npi) VALUES($1,$2,'Synthetic Clinician','1234567893')").bind(tenant).bind(user).execute(&db).await.unwrap();
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
            user,
            patient,
            headers,
        }
    }
    fn path(&self, id: Option<&str>) -> String {
        format!(
            "/api/v1/patients/{}/prescriptions{}",
            self.patient,
            id.map(|id| format!("/{id}")).unwrap_or_default()
        )
    }
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Value,
        version: Option<i64>,
    ) -> (StatusCode, Value) {
        call(&self.app, &self.headers, method, path, body, version).await
    }
    async fn pharmacy(&self) -> Value {
        let(status,value)=self.call("POST","/api/v1/prescribing/pharmacies",json!({"request_id":Uuid::new_v4(),"content":{"name":"Synthetic Pharmacy","address":"1 Example Road","phone":"555-0100","ncpdp_id":"1234567","npi":"1234567893"},"active":true,"reason":"Patient confirmed pharmacy"}),None).await;
        assert_eq!(status, 200, "{value}");
        value
    }
    async fn draft(&self, pharmacy: &Value) -> Value {
        let (status, value) = self
            .call("POST", &self.path(None), draft(pharmacy), None)
            .await;
        assert_eq!(status, 200, "{value}");
        value
    }
    async fn reviewed(&self) {
        for kind in ["allergy", "medication"] {
            sqlx::query("INSERT INTO clinical_list_state(tenant_id,patient_id,kind,review_state,reviewed_by,reviewed_at) VALUES($1,$2,$3,'no_known',$4,now()) ON CONFLICT(tenant_id,patient_id,kind) DO UPDATE SET review_state='no_known',version=clinical_list_state.version+1,reviewed_by=$4,reviewed_at=now()").bind(self.tenant).bind(self.patient).bind(kind).bind(self.user).execute(&self.db).await.unwrap();
        }
    }
    async fn review(&self) -> Value {
        let (status, value) = self
            .call(
                "GET",
                &format!("/api/v1/patients/{}/prescribing-review", self.patient),
                Value::Null,
                None,
            )
            .await;
        assert_eq!(status, 200, "{value}");
        value
    }
    async fn action(&self, rx: &Value, action: &str, body: Value) -> (StatusCode, Value) {
        self.call(
            "POST",
            &format!("{}/actions/{action}", self.path(rx["id"].as_str())),
            body,
            rx["version"].as_i64(),
        )
        .await
    }
    async fn authorize(&self, rx: &Value) -> Value {
        let review = self.review().await;
        let(status,value)=self.action(rx,"authorize",json!({"request_id":Uuid::new_v4(),"reason":"Synthetic clinician reviewed order, identity, indications, dose and lists","attest":true,"review_token":review["review_token"]})).await;
        assert_eq!(status, 200, "{value}");
        value
    }
}
fn draft(pharmacy: &Value) -> Value {
    json!({"request_id":Uuid::new_v4(),"content":{"medication_name":"Synthetic non-controlled medication","rxnorm_code":"","strength":"10 mg","dosage_form":"tablet","dose":"One tablet","route":"oral","frequency":"Once daily","instructions":"Synthetic directions <script>alert(1)</script>","indication":"Synthetic indication","quantity":"30.5","quantity_unit":"tablets","refills":0,"days_supply":30,"start_date":"2026-10-27","end_date":null,"substitution_allowed":false,"controlled_substance":false,"pharmacy_id":pharmacy["id"]},"visit_id":null,"prior_prescription_id":null,"relationship":null,"reason":"Synthetic visit draft"})
}
async fn session(db: &PgPool, tenant: Uuid, user: Uuid, role: &str) -> HeaderMap {
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-login',$4)").bind(user).bind(tenant).bind(format!("{}@example.test",user.simple())).bind(role).execute(db).await.unwrap();
    let token = format!("synthetic-rx-session-{}", Uuid::new_v4());
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
    version: Option<i64>,
) -> (StatusCode, Value) {
    let mut q = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    for (k, v) in h {
        q = q.header(k, v);
    }
    if let Some(v) = version {
        q = q.header("if-match", format!("\"{v}\""));
    }
    let response = app
        .clone()
        .oneshot(q.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8(bytes.to_vec()).unwrap())),
    )
}
fn action_body() -> Value {
    json!({"request_id":Uuid::new_v4(),"reason":"Synthetic clinical reason"})
}
#[tokio::test]
async fn complete_local_workflow_keeps_authorization_distinct_from_network_and_dispensing() {
    let f = Fixture::new().await;
    let pharmacy = f.pharmacy().await;
    let pref = json!({"request_id":Uuid::new_v4(),"pharmacy_id":pharmacy["id"],"version":0,"reason":"Patient selected preferred pharmacy"});
    let (status, p) = f
        .call(
            "PUT",
            &format!("/api/v1/patients/{}/pharmacy", f.patient),
            pref.clone(),
            None,
        )
        .await;
    assert_eq!(status, 200, "{p}");
    assert_eq!(p["version"], 1);
    assert_eq!(
        f.call(
            "PUT",
            &format!("/api/v1/patients/{}/pharmacy", f.patient),
            pref,
            None
        )
        .await
        .1,
        p
    );
    let d = f.draft(&pharmacy).await;
    assert_eq!(d["status"], "draft");
    assert_eq!(d["fulfillment_status"], "not_authorized");
    assert!(d["signed_at"].is_null());
    assert_eq!(
        f.call(
            "GET",
            &(f.path(d["id"].as_str()) + "/print"),
            Value::Null,
            None
        )
        .await
        .0,
        409
    );
    let unknown = f.review().await;
    assert_eq!(unknown["can_authorize"], false);
    assert_eq!(
        unknown["lists"]["allergy"]["state"]["review_state"],
        "unknown"
    );
    assert_eq!(f.action(&d,"authorize",json!({"request_id":Uuid::new_v4(),"reason":"Manual review","attest":true,"review_token":unknown["review_token"]})).await.0,409);
    f.reviewed().await;
    let signed = f.authorize(&d).await;
    assert_eq!(signed["status"], "active");
    assert_eq!(signed["fulfillment_status"], "local_ready");
    assert_eq!(
        signed["signed_snapshot"]["pharmacy"]["content"]["name"],
        "Synthetic Pharmacy"
    );
    assert_eq!(
        signed["signed_snapshot"]["external_transmission"],
        "unconfigured"
    );
    let (status, print) = f
        .call(
            "GET",
            &(f.path(d["id"].as_str()) + "/print"),
            Value::Null,
            None,
        )
        .await;
    assert_eq!(status, 200);
    let html = print.as_str().unwrap();
    assert!(html.contains("&lt;script&gt;"));
    assert!(!html.contains("<script>"));
    assert!(html.contains("No electronic pharmacy transmission"));
    let printed = f.action(&signed, "record_print", action_body()).await;
    assert_eq!(printed.0, 200, "{}", printed.1);
    assert_eq!(printed.1["fulfillment_status"], "printed");
    let handed = f.action(&printed.1, "fulfill_local", action_body()).await;
    assert_eq!(handed.0, 200);
    assert_eq!(handed.1["status"], "active");
    assert_eq!(handed.1["fulfillment_status"], "recorded_local");
    let completed = f.action(&handed.1, "complete", action_body()).await;
    assert_eq!(completed.0, 200);
    assert_eq!(completed.1["status"], "completed");
    assert_eq!(completed.1["content"], signed["content"]);
    assert_eq!(completed.1["signed_snapshot"], signed["signed_snapshot"]);
    let history = f
        .call(
            "GET",
            &(f.path(d["id"].as_str()) + "/history"),
            Value::Null,
            None,
        )
        .await
        .1;
    assert_eq!(history["items"].as_array().unwrap().len(), 5);
    let capabilities = f
        .call("GET", "/api/v1/prescribing/capabilities", Value::Null, None)
        .await
        .1;
    assert_eq!(capabilities["external_erx_configured"], false);
    assert_eq!(capabilities["drug_interaction_checking"], false);
    f.db.close().await;
}
#[tokio::test]
async fn staff_drafts_require_explicit_current_clinician_review_and_controlled_boundary() {
    let f = Fixture::new().await;
    let pharmacy = f.pharmacy().await;
    let nurse = session(&f.db, f.tenant, Uuid::new_v4(), "nurse").await;
    let (status, d) = call(
        &f.app,
        &nurse,
        "POST",
        &f.path(None),
        draft(&pharmacy),
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        call(
            &f.app,
            &nurse,
            "POST",
            &format!("{}/actions/authorize", f.path(d["id"].as_str())),
            action_body(),
            Some(1)
        )
        .await
        .0,
        403
    );
    f.reviewed().await;
    let review = f.review().await;
    assert_eq!(f.action(&d,"authorize",json!({"request_id":Uuid::new_v4(),"reason":"Review without attestation","attest":false,"review_token":review["review_token"]})).await.0,409);
    sqlx::query("UPDATE clinical_list_state SET version=version+1,review_state='needs_review' WHERE tenant_id=$1 AND kind='allergy'").bind(f.tenant).execute(&f.db).await.unwrap();
    assert_eq!(f.action(&d,"authorize",json!({"request_id":Uuid::new_v4(),"reason":"Stale review","attest":true,"review_token":review["review_token"]})).await.0,409);
    f.reviewed().await;
    assert_eq!(f.action(&d,"authorize",json!({"request_id":Uuid::new_v4(),"reason":"Stale digest despite reviewed state","attest":true,"review_token":review["review_token"]})).await.0,409);
    let mut controlled = draft(&pharmacy);
    controlled["content"]["controlled_substance"] = json!(true);
    let controlled = f.call("POST", &f.path(None), controlled, None).await.1;
    assert_eq!(f.action(&controlled,"authorize",json!({"request_id":Uuid::new_v4(),"reason":"Controlled test","attest":true,"review_token":f.review().await["review_token"]})).await.0,409);
    sqlx::query("UPDATE practice_providers SET active=false WHERE tenant_id=$1")
        .bind(f.tenant)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(f.action(&d,"authorize",json!({"request_id":Uuid::new_v4(),"reason":"Inactive provider","attest":true,"review_token":f.review().await["review_token"]})).await.0,409);
    f.db.close().await;
}
#[tokio::test]
async fn signed_content_is_immutable_and_lineage_replacement_stops_only_after_authorization() {
    let f = Fixture::new().await;
    let pharmacy = f.pharmacy().await;
    f.reviewed().await;
    let original = f.authorize(&f.draft(&pharmacy).await).await;
    let mut body = draft(&pharmacy);
    body["prior_prescription_id"] = original["id"].clone();
    body["relationship"] = json!("replacement");
    let (status, replacement) = f.call("POST", &f.path(None), body, None).await;
    assert_eq!(status, 200);
    assert_eq!(
        f.call("GET", &f.path(original["id"].as_str()), Value::Null, None)
            .await
            .1["status"],
        "active"
    );
    let new = f.authorize(&replacement).await;
    assert_eq!(new["status"], "active");
    let prior = f
        .call("GET", &f.path(original["id"].as_str()), Value::Null, None)
        .await
        .1;
    assert_eq!(prior["status"], "stopped");
    assert_eq!(prior["signed_snapshot"], original["signed_snapshot"]);
    let mut renewal = draft(&pharmacy);
    renewal["prior_prescription_id"] = new["id"].clone();
    renewal["relationship"] = json!("renewal");
    let renewal = f.call("POST", &f.path(None), renewal, None).await.1;
    f.authorize(&renewal).await;
    assert_eq!(
        f.call("GET", &f.path(new["id"].as_str()), Value::Null, None)
            .await
            .1["status"],
        "active"
    );
    let mut update = draft(&pharmacy);
    update["content"]["dose"] = json!("Alter signed dose");
    assert_eq!(
        f.call(
            "PUT",
            &f.path(new["id"].as_str()),
            update,
            new["version"].as_i64()
        )
        .await
        .0,
        409
    );
    let id = Uuid::parse_str(new["id"].as_str().unwrap()).unwrap();
    assert!(sqlx::query("UPDATE native_prescriptions SET content=jsonb_set(content,'{dose}','\"changed\"'),version=version+1 WHERE tenant_id=$1 AND id=$2").bind(f.tenant).bind(id).execute(&f.db).await.is_err());
    assert!(
        sqlx::query("DELETE FROM native_prescriptions WHERE tenant_id=$1 AND id=$2")
            .bind(f.tenant)
            .bind(id)
            .execute(&f.db)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE prescribing_history SET reason='rewritten' WHERE tenant_id=$1")
            .bind(f.tenant)
            .execute(&f.db)
            .await
            .is_err()
    );
    f.db.close().await;
}
#[tokio::test]
async fn idempotency_versions_and_audit_failures_are_atomic() {
    let f = Fixture::new().await;
    let pharmacy = f.pharmacy().await;
    let body = draft(&pharmacy);
    let path = f.path(None);
    let (a, b) = tokio::join!(
        f.call("POST", &path, body.clone(), None),
        f.call("POST", &path, body.clone(), None)
    );
    assert_eq!(a.0, 200);
    assert_eq!(a.1, b.1);
    let id = a.1["id"].as_str().unwrap();
    let mut changed = body.clone();
    changed["content"]["dose"] = json!("different");
    assert_eq!(f.call("POST", &f.path(None), changed, None).await.0, 409);
    let mut update = body;
    update["request_id"] = json!(Uuid::new_v4());
    update["content"]["dose"] = json!("Edited draft dose");
    assert_eq!(
        f.call("PUT", &f.path(Some(id)), update.clone(), None)
            .await
            .0,
        428
    );
    let saved = f
        .call("PUT", &f.path(Some(id)), update.clone(), Some(1))
        .await;
    assert_eq!(saved.0, 200);
    assert_eq!(
        f.call("PUT", &f.path(Some(id)), update.clone(), Some(1))
            .await
            .1,
        saved.1
    );
    update["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        f.call("PUT", &f.path(Some(id)), update, Some(1)).await.0,
        409
    );
    f.reviewed().await;
    let review = f.review().await;
    sqlx::query("CREATE FUNCTION deny_rx_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='prescribing.authorize' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&f.db).await.unwrap();
    sqlx::query("CREATE TRIGGER deny_rx_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_rx_audit()").execute(&f.db).await.unwrap();
    let action = json!({"request_id":Uuid::new_v4(),"reason":"Atomic authorization test","attest":true,"review_token":review["review_token"]});
    assert_eq!(f.action(&saved.1, "authorize", action.clone()).await.0, 500);
    let current = f.call("GET", &f.path(Some(id)), Value::Null, None).await.1;
    assert_eq!(current["status"], "draft");
    assert!(current["signed_snapshot"].is_null());
    assert_eq!(current["version"], 2);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM prescribing_requests WHERE request_id=$1"
        )
        .bind(Uuid::parse_str(action["request_id"].as_str().unwrap()).unwrap())
        .fetch_one(&f.db)
        .await
        .unwrap(),
        0
    );
    sqlx::query("DROP TRIGGER deny_rx_audit ON audit_events")
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(f.action(&saved.1, "authorize", action.clone()).await.0, 200);
    assert_eq!(f.action(&saved.1, "authorize", action).await.0, 200);
    f.db.close().await;
}
#[tokio::test]
async fn tenant_patient_and_browser_origin_boundaries_hold() {
    let f = Fixture::new().await;
    let pharmacy = f.pharmacy().await;
    let d = f.draft(&pharmacy).await;
    let other_tenant = Uuid::new_v4();
    let other = session(&f.db, other_tenant, Uuid::new_v4(), "owner").await;
    assert_eq!(
        call(
            &f.app,
            &other,
            "GET",
            &f.path(d["id"].as_str()),
            Value::Null,
            None
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(
            &f.app,
            &other,
            "GET",
            "/api/v1/prescribing/pharmacies",
            Value::Null,
            None
        )
        .await
        .1["items"],
        json!([])
    );
    assert_eq!(
        call(
            &f.app,
            &other,
            "GET",
            &format!(
                "/api/v1/prescribing/pharmacies/{}",
                pharmacy["id"].as_str().unwrap()
            ),
            Value::Null,
            None
        )
        .await
        .0,
        404
    );
    let readonly = session(&f.db, f.tenant, Uuid::new_v4(), "read_only").await;
    assert_eq!(
        call(
            &f.app,
            &readonly,
            "POST",
            &f.path(None),
            draft(&pharmacy),
            None
        )
        .await
        .0,
        403
    );
    let frontdesk = session(&f.db, f.tenant, Uuid::new_v4(), "front_desk").await;
    assert_eq!(
        call(
            &f.app,
            &frontdesk,
            "POST",
            &f.path(None),
            draft(&pharmacy),
            None
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(&f.app, &frontdesk, "GET", &f.path(None), Value::Null, None)
            .await
            .0,
        200
    );
    let mut bad = f.headers.clone();
    bad.insert(
        "origin",
        HeaderValue::from_static("https://untrusted.example"),
    );
    assert_eq!(
        call(&f.app, &bad, "POST", &f.path(None), draft(&pharmacy), None)
            .await
            .0,
        403
    );
    assert_eq!(
        call(
            &f.app,
            &HeaderMap::new(),
            "GET",
            &f.path(None),
            Value::Null,
            None
        )
        .await
        .0,
        401
    );
    let second = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SECOND','Synthetic','Other','1980-01-01')").bind(f.tenant).bind(second).execute(&f.db).await.unwrap();
    let mut linked = draft(&pharmacy);
    linked["prior_prescription_id"] = d["id"].clone();
    linked["relationship"] = json!("replacement");
    assert_eq!(
        f.call(
            "POST",
            &format!("/api/v1/patients/{second}/prescriptions"),
            linked,
            None
        )
        .await
        .0,
        404
    );
    f.db.close().await;
}
#[tokio::test]
async fn pharmacy_archive_and_order_cancellation_preserve_history_and_signed_snapshots() {
    let f = Fixture::new().await;
    let pharmacy = f.pharmacy().await;
    f.reviewed().await;
    let signed = f.authorize(&f.draft(&pharmacy).await).await;
    let edit = json!({"request_id":Uuid::new_v4(),"content":{"name":"Moved Pharmacy","address":"2 New Road","phone":"555-0101","ncpdp_id":"1234567","npi":"1234567893"},"active":false,"reason":"Directory updated and archived"});
    assert_eq!(
        f.call(
            "PUT",
            &format!(
                "/api/v1/prescribing/pharmacies/{}",
                pharmacy["id"].as_str().unwrap()
            ),
            edit,
            Some(1)
        )
        .await
        .0,
        200
    );
    let current = f
        .call("GET", &f.path(signed["id"].as_str()), Value::Null, None)
        .await
        .1;
    assert_eq!(
        current["signed_snapshot"]["pharmacy"]["content"]["name"],
        "Synthetic Pharmacy"
    );
    assert_eq!(
        f.call("POST", &f.path(None), draft(&pharmacy), None)
            .await
            .0,
        404
    );
    let cancelled = f.action(&signed, "cancel", action_body()).await;
    assert_eq!(cancelled.0, 200);
    assert_eq!(cancelled.1["status"], "cancelled");
    assert_eq!(cancelled.1["signed_snapshot"], signed["signed_snapshot"]);
    assert_eq!(
        f.action(&cancelled.1, "fulfill_local", action_body())
            .await
            .0,
        409
    );
    assert_eq!(
        f.action(&cancelled.1, "authorize", action_body()).await.0,
        409
    );
    let print = f
        .call(
            "GET",
            &(f.path(signed["id"].as_str()) + "/print"),
            Value::Null,
            None,
        )
        .await;
    assert!(print.1.as_str().unwrap().contains("cancelled"));
    f.db.close().await;
}
#[tokio::test]
async fn invalid_quantities_and_missing_reason_never_create_orders() {
    let f = Fixture::new().await;
    let pharmacy = f.pharmacy().await;
    for quantity in [
        "0",
        "-1",
        "1e3",
        "0.000",
        "1.0000",
        ".5",
        "NaN",
        "100000000",
    ] {
        let mut v = draft(&pharmacy);
        v["content"]["quantity"] = json!(quantity);
        assert_eq!(
            f.call("POST", &f.path(None), v, None).await.0,
            400,
            "{quantity}"
        );
    }
    let mut v = draft(&pharmacy);
    v["reason"] = json!("");
    assert_eq!(f.call("POST", &f.path(None), v, None).await.0, 400);
    assert_eq!(
        f.call("GET", &f.path(None), Value::Null, None).await.1["items"],
        json!([])
    );
    f.db.close().await;
}
#[tokio::test]
async fn review_is_patient_bound_and_changes_when_native_orders_become_active() {
    let f = Fixture::new().await;
    let pharmacy = f.pharmacy().await;
    f.reviewed().await;
    let initial = f.review().await;
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'REVIEW-SECOND','Synthetic','Second','1980-01-01')").bind(f.tenant).bind(other).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO clinical_list_state(tenant_id,patient_id,kind,version,review_state,reviewed_by,reviewed_at) SELECT tenant_id,$2,kind,version,review_state,reviewed_by,reviewed_at FROM clinical_list_state WHERE tenant_id=$1 AND patient_id=$3").bind(f.tenant).bind(other).bind(f.patient).execute(&f.db).await.unwrap();
    let other_review = f
        .call(
            "GET",
            &format!("/api/v1/patients/{other}/prescribing-review"),
            Value::Null,
            None,
        )
        .await
        .1;
    assert_ne!(initial["review_token"], other_review["review_token"]);
    let first = f.draft(&pharmacy).await;
    let signed = f.authorize(&first).await;
    let changed = f.review().await;
    assert_ne!(initial["review_token"], changed["review_token"]);
    assert_eq!(changed["active_prescriptions"][0]["id"], signed["id"]);
    let second = f.draft(&pharmacy).await;
    assert_eq!(f.action(&second,"authorize",json!({"request_id":Uuid::new_v4(),"reason":"Stale active-order review","attest":true,"review_token":initial["review_token"]})).await.0,409);
    f.db.close().await;
}
