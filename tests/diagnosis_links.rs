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
    backend::ClinicalBackend,
    browser::BrowserAuth,
    model::{SoapNote, StartVisit, Visit},
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
    let schema = format!("diagnosis_links_test_{}", Uuid::new_v4().simple());
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
    (db, doc, nurse, appointment)
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
fn note() -> SoapNote {
    SoapNote {
        subjective: "Synthetic history".into(),
        objective: "Synthetic exam".into(),
        assessment: "Synthetic assessment".into(),
        plan: "Synthetic plan".into(),
    }
}
async fn started(db: &PgPool, doc: &Actor, appointment_id: Uuid) -> Visit {
    PostgresBackend(db.clone())
        .start_visit(doc, StartVisit { appointment_id })
        .await
        .unwrap()
}
fn diagnoses() -> Value {
    json!({"diagnoses":[{"code":" r51.9 ","display":" Synthetic headache "},{"code":"Z00.00","display":"Synthetic examination"}],"reason":"Synthetic encounter assessment"})
}
async fn fixture() -> (
    PgPool,
    Actor,
    Actor,
    Router,
    Visit,
    Value,
    String,
    String,
    Value,
) {
    let (db, doc, nurse, appointment) = setup().await;
    let v = started(&db, &doc, appointment).await;
    let r = app(db.clone());
    let (status, dx) = call(
        &r,
        &doc,
        "PUT",
        &format!("/api/v1/visits/{}/diagnoses", v.id),
        diagnoses(),
        Some(v.version),
    )
    .await;
    assert_eq!(status, 200, "{dx}");
    let orders = format!("/api/v1/patients/{}/orders", v.patient_id);
    let (status,order)=call(&r,&doc,"POST",&orders,json!({"request_id":Uuid::new_v4(),"visit_id":v.id,"source_history_id":null,"content":{"title":"Synthetic panel","category":"laboratory","priority":"routine","clinical_reason":"Synthetic test","destination":"Synthetic local lab","instructions":"","tests":[{"key":"panel","label":"Synthetic test","code":null}]},"reason":"Synthetic draft"}),None).await;
    assert_eq!(status, 200, "{order}");
    let accounts = format!("/api/v1/patients/{}/billing/accounts", v.patient_id);
    let content = json!({"visit_id":v.id,"coverage_id":null,"service_date":"2026-10-26","currency":"USD","lines":[{"code_system":"CPT","code":"99213","description":"Synthetic visit","modifiers":"","units":1,"amount_cents":1000,"diagnosis_codes":["Z99.9"]}],"notes":"Synthetic test"});
    let (status,account)=call(&r,&doc,"POST",&accounts,json!({"request_id":Uuid::new_v4(),"source_history_id":null,"content":content,"reason":"Synthetic draft"}),None).await;
    assert_eq!(status, 200, "{account}");
    (
        db,
        doc,
        nurse,
        r,
        v,
        dx,
        format!("{}/{}", orders, order["id"].as_str().unwrap()),
        format!("{}/{}", accounts, account["id"].as_str().unwrap()),
        content,
    )
}
fn order_selection(dx: &Value) -> Value {
    json!({"visit_version":dx["version"],"diagnosis_ids":[dx["diagnoses"][0]["id"]],"reason":"Explicit synthetic order diagnosis selection"})
}
fn account_selection(dx: &Value) -> Value {
    json!({"visit_version":dx["version"],"lines":[{"line_index":0,"diagnosis_ids":[dx["diagnoses"][0]["id"]]}],"reason":"Explicit synthetic charge diagnosis selection"})
}
#[tokio::test]
async fn selected_diagnoses_are_frozen_and_manual_charge_codes_are_preserved() {
    let (db, doc, _, r, v, dx, order, account, mut content) = fixture().await;
    let (status, o) = call(
        &r,
        &doc,
        "PUT",
        &(order.clone() + "/diagnoses"),
        order_selection(&dx),
        Some(1),
    )
    .await;
    assert_eq!(status, 200, "{o}");
    assert_eq!(o["diagnosis_snapshot"]["diagnoses"][0]["code"], "R51.9");
    assert_eq!(o["diagnosis_snapshot"]["visit_version"], dx["version"]);
    let (status, a) = call(
        &r,
        &doc,
        "PUT",
        &(account.clone() + "/diagnoses"),
        account_selection(&dx),
        Some(1),
    )
    .await;
    assert_eq!(status, 200, "{a}");
    assert_eq!(
        a["content"]["lines"][0]["diagnosis_codes"],
        json!(["Z99.9", "R51.9"])
    );
    content["notes"] = json!("Updated account note");
    content["lines"] = a["content"]["lines"].clone();
    let (status, _) = call(
        &r,
        &doc,
        "PUT",
        &account,
        json!({"content":content,"reason":"Notes only retain links"}),
        Some(2),
    )
    .await;
    assert_eq!(status, 200);
    content["lines"][0]["code"] = json!("99214");
    let (status, _) = call(
        &r,
        &doc,
        "PUT",
        &account,
        json!({"content":content,"reason":"Changing lines requires explicit unlink"}),
        Some(3),
    )
    .await;
    assert_eq!(status, 409);
    let (status,_)=call(&r,&doc,"PUT",&format!("/api/v1/visits/{}/diagnoses",v.id),json!({"diagnoses":[{"code":"Z00.00","display":"Changed after linking"}],"reason":"Synthetic reassessment"}),Some(dx["version"].as_i64().unwrap())).await;
    assert_eq!(status, 200);
    let snapshot: Value = sqlx::query_scalar(
        "SELECT diagnosis_snapshot FROM lab_orders WHERE tenant_id=$1 AND id=$2",
    )
    .bind(doc.tenant_id)
    .bind(Uuid::parse_str(order.rsplit('/').next().unwrap()).unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(snapshot["diagnoses"][0]["code"], "R51.9");
    let (status,cleared)=call(&r,&doc,"PUT",&(account+"/diagnoses"),json!({"visit_version":3,"lines":[],"reason":"Explicit unlink retains charge codes for manual review"}),Some(3)).await;
    assert_eq!(status, 200, "{cleared}");
    assert!(cleared["diagnosis_snapshot"].is_null());
    assert_eq!(
        cleared["content"]["lines"][0]["diagnosis_codes"],
        json!(["Z99.9", "R51.9"])
    );
}
#[tokio::test]
async fn diagnosis_links_require_current_resource_and_visit_versions_and_scoped_selection() {
    let (_db, doc, nurse, r, _, dx, order, account, _) = fixture().await;
    for path in [order.clone() + "/diagnoses", account.clone() + "/diagnoses"] {
        let body = if path.contains("/orders/") {
            order_selection(&dx)
        } else {
            account_selection(&dx)
        };
        let (status, _) = call(&r, &doc, "PUT", &path, body.clone(), None).await;
        assert_eq!(status, 428);
        let (status, _) = call(&r, &nurse, "PUT", &path, body.clone(), Some(1)).await;
        assert_eq!(status, 403);
        let foreign = actor(Uuid::new_v4(), Role::Clinician);
        let (status, _) = call(&r, &foreign, "PUT", &path, body.clone(), Some(1)).await;
        assert_eq!(status, 404);
        let mut stale = body.clone();
        stale["visit_version"] = json!(1);
        let (status, _) = call(&r, &doc, "PUT", &path, stale, Some(1)).await;
        assert_eq!(status, 409);
        let mut bad = body.clone();
        if path.contains("/orders/") {
            bad["diagnosis_ids"] = json!([Uuid::new_v4()]);
        } else {
            bad["lines"][0]["diagnosis_ids"] = json!([Uuid::new_v4()]);
        }
        let (status, _) = call(&r, &doc, "PUT", &path, bad, Some(1)).await;
        assert_eq!(status, 400);
        let (status, _) = call(&r, &doc, "PUT", &path, body.clone(), Some(1)).await;
        assert_eq!(status, 200);
        let (status, _) = call(&r, &doc, "PUT", &path, body, Some(1)).await;
        assert_eq!(status, 409);
    }
}
#[tokio::test]
async fn finalized_orders_and_accounts_protect_snapshot_in_api_and_database() {
    let (db, doc, _, r, v, dx, order, account, _) = fixture().await;
    let (status, _) = call(
        &r,
        &doc,
        "PUT",
        &(order.clone() + "/diagnoses"),
        order_selection(&dx),
        Some(1),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = call(
        &r,
        &doc,
        "PUT",
        &(account.clone() + "/diagnoses"),
        account_selection(&dx),
        Some(1),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = call(
        &r,
        &doc,
        "POST",
        &(order.clone() + "/actions"),
        json!({"action":"place","reason":"Synthetic local placement"}),
        Some(2),
    )
    .await;
    assert_eq!(status, 200);
    let backend = PostgresBackend(db.clone());
    let v = backend.save_note(&doc, v.id, 2, note()).await.unwrap();
    let v = backend.sign(&doc, v.id, v.version).await.unwrap();
    let (status, _) = call(
        &r,
        &doc,
        "POST",
        &(account.clone() + "/actions"),
        json!({"action":"post","reason":"Synthetic ledger posting"}),
        Some(2),
    )
    .await;
    assert_eq!(status, 200);
    for (table, path) in [("lab_orders", order), ("billing_accounts", account)] {
        let body = if table == "lab_orders" {
            json!({"visit_version":v.version,"diagnosis_ids":[],"reason":"Attempt finalized edit"})
        } else {
            json!({"visit_version":v.version,"lines":[],"reason":"Attempt finalized edit"})
        };
        let (status, _) = call(
            &r,
            &doc,
            "PUT",
            &(path.clone() + "/diagnoses"),
            body,
            Some(3),
        )
        .await;
        assert_eq!(status, 409);
        let id = Uuid::parse_str(path.rsplit('/').next().unwrap()).unwrap();
        assert!(sqlx::query(&format!(
            "UPDATE {table} SET diagnosis_snapshot=NULL WHERE tenant_id=$1 AND id=$2"
        ))
        .bind(doc.tenant_id)
        .bind(id)
        .execute(&db)
        .await
        .is_err());
    }
}
#[tokio::test]
async fn diagnosis_link_writes_and_history_rollback_if_audit_fails() {
    let (db, doc, _, r, _, dx, order, account, _) = fixture().await;
    sqlx::query("CREATE FUNCTION reject_link_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('patient.order.diagnoses','billing.account_change') THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_link_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_link_audit()").execute(&db).await.unwrap();
    for (table, path, body) in [
        ("lab_orders", order, order_selection(&dx)),
        ("billing_accounts", account, account_selection(&dx)),
    ] {
        let (status, _) = call(
            &r,
            &doc,
            "PUT",
            &(path.clone() + "/diagnoses"),
            body,
            Some(1),
        )
        .await;
        assert_eq!(status, 500);
        let id = Uuid::parse_str(path.rsplit('/').next().unwrap()).unwrap();
        let (version, snapshot): (i64, Option<Value>) = sqlx::query_as(&format!(
            "SELECT version,diagnosis_snapshot FROM {table} WHERE tenant_id=$1 AND id=$2"
        ))
        .bind(doc.tenant_id)
        .bind(id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(version, 1);
        assert!(snapshot.is_none());
    }
}
