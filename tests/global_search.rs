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
const SECRET: &str = "synthetic-global-search-secret";
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
async fn call(app: &Router, a: &Actor, query: &str) -> (StatusCode, Value) {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        a,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/search?{query}"))
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn seed(db: &PgPool, a: &Actor) -> Uuid {
    let p = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    let visit = Uuid::new_v4();
    let payer = Uuid::new_v4();
    let account = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,display_name) VALUES($1,$2,$3,'synthetic','owner','Synthetic Provider')").bind(a.sub).bind(a.tenant_id).bind(format!("{}@example.test",a.sub)).execute(db).await.unwrap();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-1234','Avery','Synthetic','1990-01-01')").bind(a.tenant_id).bind(p).execute(db).await.unwrap();
    sqlx::query(
        "INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,$3)",
    )
    .bind(a.tenant_id)
    .bind(p)
    .bind(json!({"phone":"(555) 010-1234","email":"avery@example.test"}))
    .execute(db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at) VALUES($1,$2,$3,$4,now()+interval '1 day',now()+interval '1 day 30 minutes')").bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id) VALUES($1,$2,$3,$4,$5)").bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub).execute(db).await.unwrap();
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,'{\"name\":\"Synthetic Payer\"}',$3,'synthetic')").bind(a.tenant_id).bind(payer).bind(Uuid::new_v4()).execute(db).await.unwrap();
    sqlx::query("INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,'{\"member_id\":\"MEM-SYN-9876\"}',$5,'synthetic')").bind(a.tenant_id).bind(Uuid::new_v4()).bind(p).bind(payer).bind(Uuid::new_v4()).execute(db).await.unwrap();
    sqlx::query("INSERT INTO billing_accounts(tenant_id,id,patient_id,visit_id,content,total_cents,request_id,creation_hash) VALUES($1,$2,$3,$4,'{}',2500,$5,'synthetic')").bind(a.tenant_id).bind(account).bind(p).bind(visit).bind(Uuid::new_v4()).execute(db).await.unwrap();
    sqlx::query("INSERT INTO ehr_claims(tenant_id,id,patient_id,account_id,payer_id,control_number,frequency,content,snapshot,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,'SYN-CLAIM-1','original','{}','{}',$6,'synthetic')").bind(a.tenant_id).bind(Uuid::new_v4()).bind(p).bind(account).bind(payer).bind(Uuid::new_v4()).execute(db).await.unwrap();
    sqlx::query("INSERT INTO billing_copay_receipts(tenant_id,id,patient_id,appointment_id,amount_cents,method,reference,occurred_on,reason,request_id,creation_hash,actor_id) VALUES($1,$2,$3,$4,1250,'cash','Synthetic receipt',current_date,'Synthetic test',$5,'synthetic',$6)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(p).bind(appointment).bind(Uuid::new_v4()).bind(a.sub).execute(db).await.unwrap();
    sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id) VALUES($1,$2,$3,'payment',-500,'{}',$4,'synthetic',$5)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(account).bind(Uuid::new_v4()).bind(a.sub).execute(db).await.unwrap();
    sqlx::query("INSERT INTO patient_documents(tenant_id,id,patient_id,request_id,create_request,content,filename,content_type,bytes,sha256,size_bytes,uploaded_by,updated_by) VALUES($1,$2,$3,$4,'{}','{\"title\":\"Synthetic file\",\"status\":\"active\",\"category\":\"other\"}','synthetic.pdf','application/pdf',$5,$6,1,$7,$7)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(p).bind(Uuid::new_v4()).bind(vec![0u8]).bind("0".repeat(64)).bind(a.sub).execute(db).await.unwrap();
    sqlx::query("INSERT INTO referrals(tenant_id,id,patient_id,request_id,create_request,content,created_by,updated_by) VALUES($1,$2,$3,$4,'{}','{\"requested_service\":\"Synthetic consult\",\"recipient\":\"Synthetic specialist\"}',$5,$5)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(p).bind(Uuid::new_v4()).bind(a.sub).execute(db).await.unwrap();
    sqlx::query("INSERT INTO lab_orders(tenant_id,id,patient_id,request_id,creation_hash,content,status,created_by) VALUES($1,$2,$3,$4,'synthetic','{\"title\":\"Synthetic panel\",\"tests\":[{\"label\":\"Synthetic test\"}]}','draft',$5)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(p).bind(Uuid::new_v4()).bind(a.sub).execute(db).await.unwrap();
    p
}
fn group<'a>(v: &'a Value, key: &str) -> &'a Value {
    v["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["key"] == key)
        .unwrap()
}
#[tokio::test]
async fn global_search_groups_isolation_roles_and_paging() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("SKIP global search: TEST_DATABASE_URL is not set");
        return;
    };
    let schema = format!("global_search_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(4)
        .after_connect(move |c, _| {
            let query = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(&query).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let owner = actor(Uuid::new_v4(), Role::Owner);
    let foreign = actor(Uuid::new_v4(), Role::Owner);
    let patient = seed(&db, &owner).await;
    let foreign_patient = seed(&db, &foreign).await;
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), "http://127.0.0.1:8099".into()).unwrap()),
    });
    let (status, v) = call(&app, &owner, "q=sYnThEtIc&limit=99").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    for key in [
        "patients",
        "appointments",
        "encounters",
        "claims",
        "payments",
        "files",
        "referrals",
        "orders",
    ] {
        let rows = group(&v, key)["items"].as_array().unwrap();
        assert!(!rows.is_empty(), "missing {key}: {v}");
        assert!(rows.len() <= 5);
        for row in rows {
            assert_eq!(row["patient_id"], patient.to_string());
            assert_ne!(row["patient_id"], foreign_patient.to_string());
        }
    }
    assert_eq!(group(&v, "payments")["items"].as_array().unwrap().len(), 2);
    for q in [
        "SYN-123",
        "1990-01",
        "MEM-SYN-98",
        "555010",
        "avery@exam",
        "01/01/1990",
        "ENC-0001",
        "SYN-CLAIM",
    ] {
        let encoded = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("q", q)
            .finish();
        let (status, result) = call(&app, &owner, &encoded).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            result["groups"]
                .as_array()
                .unwrap()
                .iter()
                .any(|g| !g["items"].as_array().unwrap().is_empty()),
            "{q}"
        );
    }
    let (_, v) = call(&app, &owner, "q=chedule").await;
    assert!(v["groups"]
        .as_array()
        .unwrap()
        .iter()
        .all(|g| g["items"].as_array().unwrap().is_empty()));
    let (_, v) = call(&app, &owner, "q=Sche").await;
    assert_eq!(group(&v, "actions")["items"][0]["id"], "schedule");
    for i in 0..7 {
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Synthetic','Extra','1990-01-01')").bind(owner.tenant_id).bind(Uuid::new_v4()).bind(format!("SYN-EXTRA-{i}")).execute(&db).await.unwrap();
    }
    let (_, v) = call(&app, &owner, "q=syn&group=patients&limit=5").await;
    assert_eq!(group(&v, "patients")["items"].as_array().unwrap().len(), 5);
    assert_eq!(group(&v, "patients")["more"], true);
    let (_, next) = call(&app, &owner, "q=syn&group=patients&offset=5").await;
    for row in group(&next, "patients")["items"].as_array().unwrap() {
        assert!(!group(&v, "patients")["items"]
            .as_array()
            .unwrap()
            .contains(row));
    }
    let mut restricted = actor(owner.tenant_id, Role::ReadOnly);
    let policy = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,'synthetic','read_only')").bind(restricted.sub).bind(owner.tenant_id).bind(format!("{}@example.test",restricted.sub)).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Synthetic clinical only','read_only',$3,$4)").bind(owner.tenant_id).bind(policy).bind(json!({"clinical":{"view":true},"scheduling":{"view":true}})).bind(owner.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)").bind(owner.tenant_id).bind(restricted.sub).bind(policy).bind(owner.sub).execute(&db).await.unwrap();
    let (status, v) = call(&app, &restricted, "q=synthetic").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert!(!group(&v, "patients")["items"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(v["groups"]
        .as_array()
        .unwrap()
        .iter()
        .all(|g| g["key"] != "claims" && g["key"] != "payments"));
    restricted.role = Role::Patient;
    restricted.patient_id = Some(patient);
    assert_eq!(
        call(&app, &restricted, "q=synthetic").await.0,
        StatusCode::FORBIDDEN
    );
    let (_, v) = call(&app, &owner, "q=s").await;
    assert!(v["groups"].as_array().unwrap().is_empty());
    let (_, v) = call(&app, &owner, "q=%25%27%20OR%201%3D1--").await;
    assert!(v["groups"]
        .as_array()
        .unwrap()
        .iter()
        .all(|g| g["items"].as_array().unwrap().is_empty()));
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='global_search.read'",
    )
    .bind(owner.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(audits > 0);
    db.close().await;
}
