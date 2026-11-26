// SPDX-License-Identifier: AGPL-3.0-only
//! A claim's billing provider is the organization: its legal name, tax ID and,
//! when the practice bills under a group NPI, that NPI. The rendering provider
//! stays the clinician who saw the patient. With zero active organizations or
//! one without an organization NPI, the clinician's NPI is the billing default.
//! With several active organizations, staff review the billing identity.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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

const SECRET: &str = "synthetic-claim-billing-npi-secret";
const ORIGIN: &str = "http://127.0.0.1:8099";
const CLINICIAN_NPI: &str = "1234567893";
const ORG_NPI: &str = "1245319599";
const SECOND_ORG_NPI: &str = "1548469802";
const FOREIGN_ORG_NPI: &str = "1447325998";

fn app(db: PgPool) -> Router {
    suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db, ORIGIN.into()).unwrap()),
    })
}

async fn database() -> PgPool {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("claim_billing_npi_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(6)
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
    db
}

/// Billing routes accept the JWT; the practice administration routes behind it
/// accept the browser session cookie only.
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
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Origin", ORIGIN)
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        request = request.header("If-Match", format!("\"{v}\""));
    }
    send(r, request, body).await
}

async fn call_cookie(
    r: &Router,
    cookie: &str,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Cookie", format!("sce_session={cookie}"))
        .header("Origin", ORIGIN)
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        request = request.header("If-Match", format!("\"{v}\""));
    }
    send(r, request, body).await
}

async fn send(r: &Router, q: axum::http::request::Builder, body: Value) -> (StatusCode, Value) {
    let request = if body.is_null() {
        q.body(Body::empty()).unwrap()
    } else {
        q.body(Body::from(body.to_string())).unwrap()
    };
    let response = r.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"message":String::from_utf8_lossy(&bytes)})),
    )
}

async fn ok(
    r: &Router,
    a: &Actor,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> Value {
    let (status, value) = call(r, a, method, path, body, version).await;
    assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
    value
}

async fn ok_cookie(
    r: &Router,
    cookie: &str,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> Value {
    let (status, value) = call_cookie(r, cookie, method, path, body, version).await;
    assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
    value
}

fn id(v: &Value) -> Uuid {
    Uuid::parse_str(
        v["id"]
            .as_str()
            .unwrap_or_else(|| panic!("missing id: {v}")),
    )
    .unwrap()
}
fn version(v: &Value) -> i64 {
    v["version"]
        .as_i64()
        .unwrap_or_else(|| panic!("missing version: {v}"))
}

/// One tenant with a signed visit, an active provider directory entry carrying the
/// clinician NPI, one active facility, and a browser session for the owner.
async fn fixture(db: &PgPool) -> (Router, Actor, Uuid, Uuid, String) {
    let now = Utc::now().timestamp();
    let a = Actor {
        sub: Uuid::new_v4(),
        tenant_id: Uuid::new_v4(),
        role: Role::Owner,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    };
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login','owner',false)")
        .bind(a.sub).bind(a.tenant_id).bind(format!("{}@example.test", a.sub.simple()))
        .execute(db).await.unwrap();
    let cookie = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')")
        .bind(format!("{:x}", Sha256::digest(cookie.as_bytes())))
        .bind(a.tenant_id).bind(a.sub)
        .execute(db).await.unwrap();
    let p = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-BNPI','Avery','Synthetic','1990-01-01')")
        .bind(a.tenant_id).bind(p).execute(db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')")
        .bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,'{}'::jsonb,$5,now())")
        .bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub)
        .bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"}))
        .execute(db).await.unwrap();
    sqlx::query("INSERT INTO practice_providers(tenant_id,id,display_name,npi,specialty,taxonomy,active) VALUES($1,$2,'Synthetic Clinician',$3,'Synthetic specialty','207Q00000X',true)")
        .bind(a.tenant_id).bind(a.sub).bind(CLINICIAN_NPI)
        .execute(db).await.unwrap();
    sqlx::query("INSERT INTO practice_facilities(tenant_id,id,name,address,active) VALUES($1,$2,'Synthetic Clinic','1 Synthetic Way, Austin TX 78701',true)")
        .bind(a.tenant_id).bind(Uuid::new_v4()).execute(db).await.unwrap();
    (app(db.clone()), a, p, visit, cookie)
}

/// Creates a billing organization through the owner API (so the tax ID is sealed
/// as production seals it) and sets its NPI the way migration 0111 stores it.
struct OrgSpec<'a> {
    tenant: Uuid,
    name: &'a str,
    npi: &'a str,
    tax: &'a str,
    tax_id_type: &'a str,
    active: bool,
}

async fn organization(
    db: &PgPool,
    r: &Router,
    owner: &Actor,
    owner_cookie: &str,
    spec: &OrgSpec<'_>,
) {
    let OrgSpec {
        tenant,
        name,
        npi,
        tax,
        tax_id_type,
        active,
    } = *spec;
    let org = Uuid::new_v4();
    // The browser session's user must be an enabled owner of this tenant, so a
    // foreign tenant gets its own owner and cookie in the same fixture schema.
    let cookie = if tenant == owner.tenant_id {
        owner_cookie.to_owned()
    } else {
        let staff = Uuid::new_v4();
        sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login','owner',false)")
            .bind(staff).bind(tenant).bind(format!("{}@example.test", staff.simple()))
            .execute(db).await.unwrap();
        let fresh = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')")
            .bind(format!("{:x}", Sha256::digest(fresh.as_bytes())))
            .bind(tenant).bind(staff)
            .execute(db).await.unwrap();
        fresh
    };
    let out = ok_cookie(
        r,
        &cookie,
        "POST",
        "/api/v1/practice/billing-organizations",
        json!({"request_id":org,"name":name,"npi":npi,"tax_id":tax,"tax_id_type":tax_id_type,"active":active,"reason":"Synthetic reviewed tax identity"}),
        None,
    )
    .await;
    assert_eq!(out["id"], org.to_string(), "{out}");
    if !active {
        let path = format!("/api/v1/practice/billing-organizations/{org}");
        ok_cookie(
            r,
            &cookie,
            "PUT",
            &path,
            json!({"name":name,"npi":npi,"tax_id_type":tax_id_type,"active":false,"reason":"Synthetic retirement"}),
            Some(1),
        )
        .await;
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM practice_billing_organizations WHERE tenant_id=$1 AND id=$2 AND npi=$3",
    )
    .bind(tenant)
    .bind(org)
    .bind(npi)
    .fetch_one(db)
    .await
    .unwrap();
    assert_eq!(count, 1, "organization row recorded with its NPI");
}

/// Posts charges under a synthetic payer and returns the draft and its persisted
/// content before opening the detail route can fill in any missing fields.
async fn prepare_content(
    r: &Router,
    a: &Actor,
    db: &PgPool,
    p: Uuid,
    visit: Uuid,
) -> (Uuid, Value) {
    let payer = ok(r, a, "POST", "/api/v1/billing/payers",
        json!({"request_id":Uuid::new_v4(),"content":{"name":"Medicare NJ","payer_code":"SYN-MCARE","address":"Synthetic payer address","phone":"","active":true},"reason":"Synthetic payer"}), None).await;
    let coverage = ok(r, a, "POST", &format!("/api/v1/patients/{p}/coverages"),
        json!({"request_id":Uuid::new_v4(),"content":{"payer_id":id(&payer),"priority":"primary","status":"active","member_id":"SYN-MEMBER","group_number":"SYN-GROUP","plan_name":"Synthetic plan","subscriber_name":"Avery Synthetic","subscriber_birth_date":"1990-01-01","relationship":"self","effective_date":"2026-01-01","end_date":null,"copay_cents":null,"verification":"manually_verified","notes":"Synthetic"},"reason":"Synthetic coverage"}), None).await;
    let base = format!("/api/v1/patients/{p}/billing/accounts");
    let draft = ok(r, a, "POST", &base,
        json!({"request_id":Uuid::new_v4(),"content":{"visit_id":visit,"coverage_id":id(&coverage),"service_date":"2026-10-25","currency":"USD","notes":"Synthetic","lines":[{"code_system":"CPT","code":"99213","description":"Synthetic service","modifiers":"","units":1,"amount_cents":10000,"diagnosis_codes":["Z00.00"]}]},"reason":"Synthetic charges"}), None).await;
    let account_path = format!("{base}/{}", id(&draft));
    let posted = ok(
        r,
        a,
        "POST",
        &format!("{account_path}/actions"),
        json!({"action":"post","reason":"Reviewed synthetic signed visit"}),
        Some(version(&draft)),
    )
    .await;
    let account = id(&posted);
    let out = ok(
        r,
        a,
        "POST",
        &format!("{base}/{account}/claims/prepare"),
        json!({}),
        None,
    )
    .await;
    assert_eq!(out["outcome"], "prepared", "{out}");
    let claim: Uuid = serde_json::from_value(out["claim_id"].clone()).expect("claim id");
    let content = sqlx::query_scalar("SELECT content FROM ehr_claims WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(claim)
        .fetch_one(db)
        .await
        .unwrap();
    (claim, content)
}

#[tokio::test]
async fn sole_organization_npi_becomes_the_billing_provider_npi() {
    let _key_file = suncharts_engine::test_db::credential_key_lock()
        .lock()
        .await;
    let db = database().await;
    let (r, a, p, visit, cookie) = fixture(&db).await;
    organization(
        &db,
        &r,
        &a,
        &cookie,
        &OrgSpec {
            tenant: a.tenant_id,
            name: "Synthetic Group Practice",
            npi: ORG_NPI,
            tax: "000000017",
            tax_id_type: "E",
            active: true,
        },
    )
    .await;
    // A retired organization must not widen the active count back up.
    organization(
        &db,
        &r,
        &a,
        &cookie,
        &OrgSpec {
            tenant: a.tenant_id,
            name: "Retired Organization",
            npi: ORG_NPI,
            tax: "000000018",
            tax_id_type: "E",
            active: false,
        },
    )
    .await;
    // Another tenant's active organization with an NPI is never seen.
    let foreign = Uuid::new_v4();
    organization(
        &db,
        &r,
        &a,
        &cookie,
        &OrgSpec {
            tenant: foreign,
            name: "Foreign Group",
            npi: FOREIGN_ORG_NPI,
            tax: "000000019",
            tax_id_type: "E",
            active: true,
        },
    )
    .await;
    let (_, content) = prepare_content(&r, &a, &db, p, visit).await;
    assert_eq!(
        content["billing_npi"], ORG_NPI,
        "the sole active organization's NPI bills the claim"
    );
    assert_eq!(
        content["rendering_npi"], CLINICIAN_NPI,
        "the clinician who saw the patient still renders"
    );
    db.close().await;
}

#[tokio::test]
async fn without_an_organization_npi_the_clinician_npi_bills() {
    let _key_file = suncharts_engine::test_db::credential_key_lock()
        .lock()
        .await;
    let db = database().await;
    let (r, a, p, visit, cookie) = fixture(&db).await;
    organization(
        &db,
        &r,
        &a,
        &cookie,
        &OrgSpec {
            tenant: a.tenant_id,
            name: "Synthetic Solo Practice",
            npi: "",
            tax: "000000017",
            tax_id_type: "E",
            active: true,
        },
    )
    .await;
    let (_, content) = prepare_content(&r, &a, &db, p, visit).await;
    assert_eq!(content["billing_npi"], CLINICIAN_NPI);
    assert_eq!(content["rendering_npi"], CLINICIAN_NPI);
    db.close().await;
}

#[tokio::test]
async fn without_active_organizations_the_clinicians_npi_is_the_default() {
    let _key_file = suncharts_engine::test_db::credential_key_lock()
        .lock()
        .await;
    let db = database().await;
    let (r, a, p, visit, _) = fixture(&db).await;
    let (_, content) = prepare_content(&r, &a, &db, p, visit).await;
    assert_eq!(content["billing_npi"], CLINICIAN_NPI);
    assert_eq!(content["rendering_npi"], CLINICIAN_NPI);
    assert_eq!(content["tax_id"], "");
    db.close().await;
}

#[tokio::test]
async fn two_active_organizations_require_reviewed_billing_identity() {
    let _key_file = suncharts_engine::test_db::credential_key_lock()
        .lock()
        .await;
    let db = database().await;
    let (r, a, p, visit, cookie) = fixture(&db).await;
    organization(
        &db,
        &r,
        &a,
        &cookie,
        &OrgSpec {
            tenant: a.tenant_id,
            name: "Synthetic Group One",
            npi: ORG_NPI,
            tax: "000000017",
            tax_id_type: "E",
            active: true,
        },
    )
    .await;
    organization(
        &db,
        &r,
        &a,
        &cookie,
        &OrgSpec {
            tenant: a.tenant_id,
            name: "Synthetic Group Two",
            npi: SECOND_ORG_NPI,
            tax: "000000018",
            tax_id_type: "E",
            active: true,
        },
    )
    .await;
    sqlx::query("INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,$3)")
        .bind(a.tenant_id).bind(p)
        .bind(json!({"address":{"line1":"2 Synthetic Way","city":"Austin","region":"TX","postal_code":"78701","country":"US"}}))
        .execute(&db).await.unwrap();
    let (claim, mut content) = prepare_content(&r, &a, &db, p, visit).await;
    assert_eq!(
        content["billing_npi"], "",
        "the practice must review which organization bills this claim"
    );
    assert_eq!(content["tax_id"], "");
    assert_eq!(content["rendering_npi"], CLINICIAN_NPI);

    let path = format!("/api/v1/billing/claims/{claim}");
    let actions = format!("{path}/actions");
    let detail = ok(&r, &a, "GET", &path, Value::Null, None).await;
    let status = detail["preflight_issues"].as_array().unwrap();
    assert!(status.iter().any(|issue| issue == "Tax ID is required"));
    assert!(status
        .iter()
        .any(|issue| issue == "Billing and rendering NPIs require valid check digits"));
    let release = json!({"action":"ready","reason":"Reviewed synthetic billing identity"});
    let before = version(&detail["claim"]);
    let (blocked, _) = call(&r, &a, "POST", &actions, release.clone(), Some(before)).await;
    assert_eq!(blocked, StatusCode::CONFLICT);

    content["billing_provider_name"] = json!("Synthetic Group Two");
    content["billing_npi"] = json!(SECOND_ORG_NPI);
    content["tax_id"] = json!("000000018");
    content["tax_id_type"] = json!("E");
    let edited = ok(
        &r,
        &a,
        "PUT",
        &path,
        json!({"content":content,"reason":"Chose Synthetic Group Two"}),
        Some(before),
    )
    .await;
    assert_eq!(edited["content"]["billing_npi"], SECOND_ORG_NPI);
    assert_eq!(edited["content"]["rendering_npi"], CLINICIAN_NPI);
    let detail = ok(&r, &a, "GET", &path, Value::Null, None).await;
    assert_eq!(detail["preflight_issues"], json!([]));
    let ready = ok(
        &r,
        &a,
        "POST",
        &actions,
        release,
        Some(version(&detail["claim"])),
    )
    .await;
    assert_eq!(ready["status"], "ready");
    assert_eq!(
        ready["content"]["billing_provider_name"],
        "Synthetic Group Two"
    );
    assert_eq!(ready["content"]["billing_npi"], SECOND_ORG_NPI);
    assert_eq!(ready["content"]["tax_id"], "000000018");
    assert_eq!(ready["content"]["rendering_npi"], CLINICIAN_NPI);
    db.close().await;
}

#[tokio::test]
async fn a_practice_billing_under_an_ssn_prepares_the_claim_as_an_ssn() {
    let _key_file = suncharts_engine::test_db::credential_key_lock()
        .lock()
        .await;
    let db = database().await;
    let (r, a, p, visit, cookie) = fixture(&db).await;
    organization(
        &db,
        &r,
        &a,
        &cookie,
        &OrgSpec {
            tenant: a.tenant_id,
            name: "Synthetic Sole Proprietor",
            npi: "",
            tax: "000000017",
            tax_id_type: "S",
            active: true,
        },
    )
    .await;
    let (_, content) = prepare_content(&r, &a, &db, p, visit).await;
    assert_eq!(
        content["tax_id_type"], "S",
        "the prepared claim says the tax ID is a Social Security number"
    );
    assert_eq!(content["tax_id"], "000000017");
    db.close().await;
}

#[tokio::test]
async fn a_practice_billing_under_an_ein_prepares_the_claim_as_an_ein() {
    let _key_file = suncharts_engine::test_db::credential_key_lock()
        .lock()
        .await;
    let db = database().await;
    let (r, a, p, visit, cookie) = fixture(&db).await;
    organization(
        &db,
        &r,
        &a,
        &cookie,
        &OrgSpec {
            tenant: a.tenant_id,
            name: "Synthetic Group Practice",
            npi: "",
            tax: "000000017",
            tax_id_type: "E",
            active: true,
        },
    )
    .await;
    let (_, content) = prepare_content(&r, &a, &db, p, visit).await;
    assert_eq!(content["tax_id_type"], "E");
    db.close().await;
}
