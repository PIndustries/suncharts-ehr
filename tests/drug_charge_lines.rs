// SPDX-License-Identifier: AGPL-3.0-only
//! A charge for an injected drug (a HCPCS J-code such as botulinum toxin) can
//! carry the drug's NDC code, quantity and unit, and they reach the claim. This
//! covers the path clinic staff actually walk: save the charge with its drug
//! details, post the charges, prepare the claim, and read the prepared claim's
//! frozen charge line back. Synthetic data only.
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
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

const SECRET: &str = "synthetic-drug-charge-lines-secret";
const NPI: &str = "1234567893";
// A synthetic NDC in the labeler/package form staff type it in, with hyphens.
const NDC_TYPED: &str = "00023-1145-01";
const NDC_DIGITS: &str = "00023114501";

/// Proof that the engine this test drives really carries the drug fields: the
/// frozen struct must read them. If this fails, the server under test was
/// built without them and every assertion below would be a lie.
#[test]
fn the_charge_line_struct_reads_the_drug_fields() {
    let line: suncharts_engine::billing::ChargeLine = serde_json::from_value(drug_line(NDC_TYPED))
        .expect("ChargeLine must accept ndc_code, ndc_quantity and ndc_unit");
    assert_eq!(line.ndc_code.as_deref(), Some(NDC_TYPED));
    assert_eq!(line.ndc_quantity.as_deref(), Some("100"));
    assert_eq!(line.ndc_unit.as_deref(), Some("UN"));
}

fn app(db: PgPool) -> axum::Router {
    suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db, "http://127.0.0.1:8099".into()).unwrap()),
    })
}

async fn user(db: &PgPool, tenant: Uuid, id: Uuid, role: &str) {
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login',$4,false)")
        .bind(id)
        .bind(tenant)
        .bind(format!("{id}@example.test"))
        .bind(role)
        .execute(db)
        .await
        .unwrap();
}

/// A tenant with a signed visit and an in-network synthetic payer.
async fn setup() -> (PgPool, Actor, Uuid, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    std::env::set_var("ENGINE_NPI_REGISTRY_URL", "");
    let schema = format!("drug_charge_test_{}", Uuid::new_v4().simple());
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
    let now = chrono::Utc::now().timestamp();
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
    user(&db, a.tenant_id, a.sub, "owner").await;
    let p = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-DRUG','Avery','Synthetic','1990-01-01')")
        .bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')")
        .bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,'{}'::jsonb,$5,now())")
        .bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub)
        .bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"}))
        .execute(&db).await.unwrap();
    sqlx::query("INSERT INTO practice_providers(tenant_id,id,display_name,npi,specialty,taxonomy,active) VALUES($1,$2,'Synthetic Clinician',$3,'Synthetic specialty','207Q00000X',true)")
        .bind(a.tenant_id).bind(a.sub).bind(NPI)
        .execute(&db).await.unwrap();
    (db, a, p, visit)
}

async fn call(
    r: &axum::Router,
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
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        request = request.header("If-Match", format!("\"{v}\""));
    }
    let response = r
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"message":String::from_utf8_lossy(&bytes)})),
    )
}

async fn ok(
    r: &axum::Router,
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

fn id(v: &Value) -> Uuid {
    Uuid::parse_str(
        v["id"]
            .as_str()
            .unwrap_or_else(|| panic!("missing id: {v}")),
    )
    .unwrap()
}
fn version(v: &Value) -> i64 {
    v["version"].as_i64().unwrap()
}

fn claim_content(control_number: &str) -> Value {
    json!({
        "billing_provider_name":"Synthetic Practice",
        "billing_npi":NPI,
        "rendering_npi":NPI,
        "tax_id":"000000001",
        "billing_address":"0 Example Street, Austin TX 78701",
        "patient_address":"0 Example Street, Austin TX 78701",
        "subscriber_address":"0 Example Street, Austin TX 78701",
        "subscriber_birth_date":"1990-01-01",
        "place_of_service":"11",
        "diagnosis_codes":["Z00.00"],
        "line_diagnosis_pointers":[[1]],
        "external_control_number":control_number,
        "notes":"Synthetic only",
        "synthetic_test":true
    })
}

/// A charge line for an injected drug: the J-code plus the drug's NDC details.
fn drug_line(ndc: &str) -> Value {
    json!({
        "code_system":"HCPCS",
        "code":"J0585",
        "description":"Synthetic injected drug",
        "modifiers":"JW",
        "units":1,
        "amount_cents":12500,
        "diagnosis_codes":["Z00.00"],
        "ndc_code":ndc,
        "ndc_quantity":"100",
        "ndc_unit":"UN"
    })
}

async fn save_account(r: &axum::Router, a: &Actor, p: Uuid, visit: Uuid, line: Value) -> Value {
    let payer = ok(
        r,
        a,
        "POST",
        "/api/v1/billing/payers",
        json!({"request_id":Uuid::new_v4(),"content":{"name":"Synthetic Payer","payer_code":"SYN-DRUG","address":"Synthetic payer address","phone":"","active":true},"reason":"Synthetic payer"}),
        None,
    )
    .await;
    let coverage = ok(
        r,
        a,
        "POST",
        &format!("/api/v1/patients/{p}/coverages"),
        json!({"request_id":Uuid::new_v4(),"content":{"payer_id":id(&payer),"priority":"primary","status":"active","member_id":"SYN-MEMBER","group_number":"SYN-GROUP","plan_name":"Synthetic plan","subscriber_name":"Avery Synthetic","subscriber_birth_date":"1990-01-01","relationship":"self","effective_date":"2026-01-01","end_date":null,"copay_cents":null,"verification":"manually_verified","notes":"Synthetic"},"reason":"Synthetic coverage"}),
        None,
    )
    .await;
    ok(
        r,
        a,
        "POST",
        &format!("/api/v1/patients/{p}/billing/accounts"),
        json!({"request_id":Uuid::new_v4(),"content":{"visit_id":visit,"coverage_id":id(&coverage),"service_date":"2026-10-25","currency":"USD","notes":"Synthetic","lines":[line]},"reason":"Synthetic charges"}),
        None,
    )
    .await
}

async fn claim_snapshot_row(db: &PgPool, tenant: Uuid, claim: Uuid) -> Value {
    sqlx::query_scalar::<_, Value>(
        "SELECT snapshot->'account'->'content'->'lines' FROM ehr_claims WHERE tenant_id=$1 AND id=$2",
    )
    .bind(tenant)
    .bind(claim)
    .fetch_one(db)
    .await
    .unwrap()
}

#[tokio::test]
async fn an_injected_drug_charge_keeps_its_ndc_through_to_the_prepared_claim() {
    let (db, a, p, visit) = setup().await;
    let r = app(db.clone());
    // Staff save the charge with the NDC typed with hyphens.
    let draft = save_account(&r, &a, p, visit, drug_line(NDC_TYPED)).await;
    let account_path = format!("/api/v1/patients/{p}/billing/accounts/{}", id(&draft));
    let line = &draft["content"]["lines"][0];
    assert_eq!(line["ndc_code"], json!(NDC_DIGITS), "stored as 11 digits");
    assert_eq!(line["ndc_quantity"], json!("100"));
    assert_eq!(line["ndc_unit"], json!("UN"));
    // Post the charges.
    let posted = ok(
        &r,
        &a,
        "POST",
        &format!("{account_path}/actions"),
        json!({"action":"post","reason":"Reviewed synthetic signed visit"}),
        Some(version(&draft)),
    )
    .await;
    // Prepare the claim off the posted account.
    let control = format!("SYN-{}", Uuid::new_v4().simple());
    let claim = ok(
        &r,
        &a,
        "POST",
        &format!("{account_path}/claims"),
        json!({"request_id":Uuid::new_v4(),"frequency":"original","content":claim_content(&control),"reason":"Synthetic primary"}),
        Some(version(&posted)),
    )
    .await;
    // The claim's frozen charge line carries the drug's 11-digit NDC.
    let lines = claim_snapshot_row(&db, a.tenant_id, id(&claim)).await;
    let line = &lines[0];
    assert_eq!(line["code"], json!("J0585"));
    assert_eq!(line["ndc_code"], json!(NDC_DIGITS));
    assert_eq!(line["ndc_quantity"], json!("100"));
    assert_eq!(line["ndc_unit"], json!("UN"));
    db.close().await;
}

#[tokio::test]
async fn a_partial_drug_set_is_refused_and_nothing_is_saved() {
    let (db, a, p, visit) = setup().await;
    let r = app(db.clone());
    let mut line = drug_line(NDC_TYPED);
    line["ndc_unit"] = json!("");
    let (status, value) = call(
        &r,
        &a,
        "POST",
        &format!("/api/v1/patients/{p}/billing/accounts"),
        json!({"request_id":Uuid::new_v4(),"content":{"visit_id":visit,"coverage_id":null,"service_date":"2026-10-25","currency":"USD","notes":"Synthetic","lines":[line]},"reason":"Synthetic charges"}),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "expected a refusal: {value}"
    );
    assert_eq!(
        value["message"].as_str().unwrap_or_default(),
        "Enter the drug's 11-digit NDC code, the quantity given and its unit, or leave all three blank."
    );
    // A line with no drug at all still saves, and stays without drug keys.
    let mut plain = drug_line(NDC_TYPED);
    plain["ndc_code"] = json!("");
    plain["ndc_quantity"] = json!("");
    plain["ndc_unit"] = json!("");
    let (status, value) = call(
        &r,
        &a,
        "POST",
        &format!("/api/v1/patients/{p}/billing/accounts"),
        json!({"request_id":Uuid::new_v4(),"content":{"visit_id":visit,"coverage_id":null,"service_date":"2026-10-25","currency":"USD","notes":"Synthetic","lines":[plain]},"reason":"Synthetic charges"}),
        None,
    )
    .await;
    // No coverage means self-pay; the drug keys are simply absent.
    assert_eq!(status, StatusCode::OK, "{value}");
    let line = &value["content"]["lines"][0];
    assert!(
        line.get("ndc_code").is_none(),
        "a line without a drug sends no {line}"
    );
    db.close().await;
}
