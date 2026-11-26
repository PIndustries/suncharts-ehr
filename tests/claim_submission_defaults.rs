// SPDX-License-Identifier: AGPL-3.0-only
//! The send-claim form is prefilled from what the practice has on file: the
//! rendering provider's taxonomy, the sole active facility's street address parts
//! (as they are now, not frozen on the claim) and a filing indicator derived from
//! the payer's name. The insurer (payer) address is left empty here because
//! Claim.MD and the 837P profile both treat it as optional.
use axum::{
    body::Body,
    extract::Query,
    http::{Request, StatusCode},
    routing::get,
    Json, Router,
};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::{Arc, OnceLock};
use suncharts_engine::{
    auth::{Actor, Role},
    browser::BrowserAuth,
    postgres::PostgresBackend,
    State,
};
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &str = "synthetic-claim-submission-defaults-secret";
const NPI: &str = "1234567893";
const TAXONOMY: &str = "207Q00000X";
const PAT_ADDRESS: &str = "1020 Patient Way";
const PAT_CITY: &str = "Austin";
const PAT_STATE: &str = "TX";
const PAT_ZIP: &str = "78701";
// The registry stand-in's primary code, asserted when the taxonomy is filled from
// the lookup. Distinct from TAXONOMY so the two sources are visibly different.
const REGISTRY_TAXONOMY: &str = "207Q00000X";

/// A stand-in NPI registry on a random loopback port, started once per binary. It
/// answers the registry path with a single primary taxonomy. Tests point
/// ENGINE_NPI_REGISTRY_URL at it; no test reaches the real registry.
fn registry_base() -> &'static String {
    static BASE: OnceLock<String> = OnceLock::new();
    BASE.get_or_init(|| {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().route("/api/", get(registry_handler));
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                    axum::serve(listener, app).await.unwrap();
                });
        });
        base
    })
}

async fn registry_handler(
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<Value>) {
    let number = q.get("number").cloned().unwrap_or_default();
    (
        StatusCode::OK,
        Json(
            json!({"result_count":1,"results":[{"number":number,"taxonomies":[
            {"code":"207Q00000X","desc":"Synthetic family","primary":false,"state":"TX"},
            {"code":"207Q00000X","desc":"Synthetic primary","primary":true,"state":"ZZ"}]}]}),
        ),
    )
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

/// One active facility with recorded street parts, a taxonomy-bearing provider,
/// and a patient demographic address. `active_facilities` toggles how many active
/// facilities exist; `taxonomy` toggles whether the provider carries one.
async fn setup(taxonomy: &str, active_facilities: usize) -> (PgPool, Actor, Uuid, Uuid, String) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    // By default the registry lookup is off so no ordinary test reaches the network.
    // The registry-sourced test re-enables it, under REGISTRY, pointing at the loopback stand-in.
    std::env::set_var("ENGINE_NPI_REGISTRY_URL", "");
    let schema = format!("claim_defaults_test_{}", Uuid::new_v4().simple());
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
    user(&db, a.tenant_id, a.sub, "owner").await;
    // practice_admin's owner() helper requires a live browser session cookie, so
    // the facility update is driven over the cookie session; billing stays on JWT.
    let cookie = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')")
        .bind(format!("{:x}", Sha256::digest(cookie.as_bytes())))
        .bind(a.tenant_id)
        .bind(a.sub)
        .execute(&db)
        .await
        .unwrap();
    let p = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-DEFAULTS','Avery','Synthetic','1990-01-01')")
        .bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,$3)")
        .bind(a.tenant_id).bind(p)
        .bind(json!({"administrative_gender":"female","address":{"line1":PAT_ADDRESS,"city":PAT_CITY,"region":PAT_STATE,"postal_code":PAT_ZIP,"country":"US"}}))
        .execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')")
        .bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,'{}'::jsonb,$5,now())")
        .bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub)
        .bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"}))
        .execute(&db).await.unwrap();
    // Rendering provider (an owner so it passes the active-provider join) with the
    // requested taxonomy.
    sqlx::query("INSERT INTO practice_providers(tenant_id,id,display_name,npi,specialty,taxonomy,active) VALUES($1,$2,'Synthetic Clinician',$3,'Synthetic specialty',$4,true)")
        .bind(a.tenant_id).bind(a.sub).bind(NPI).bind(taxonomy)
        .execute(&db).await.unwrap();
    // A single active facility with recorded street parts, plus one inactive row
    // when only one active facility is wanted (to prove `active` filters).
    let active = active_facilities.max(1);
    for index in 0..active {
        let id = Uuid::new_v4();
        let name = format!("Synthetic Facility {index}");
        let addr = format!("{index} Example Street, {PAT_CITY} {PAT_STATE} {PAT_ZIP}");
        sqlx::query("INSERT INTO practice_facilities(tenant_id,id,name,address,phone,active,address_line1,address_line2,city,state,postal_code) VALUES($1,$2,$3,$4,'',true,$5,'',$6,$7,$8)")
            .bind(a.tenant_id).bind(id).bind(&name).bind(&addr)
            .bind(format!("{index} Example Street")).bind(PAT_CITY).bind(PAT_STATE).bind(PAT_ZIP)
            .execute(&db).await.unwrap();
    }
    if active_facilities < 1 {
        sqlx::query("UPDATE practice_facilities SET active=false WHERE tenant_id=$1")
            .bind(a.tenant_id)
            .execute(&db)
            .await
            .unwrap();
    }
    (db, a, p, visit, cookie)
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

/// practice_admin routes authenticate through the browser session cookie only.
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
        .header("Origin", "http://127.0.0.1:8099")
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

/// Build a posted account and a draft claim on the Medicare payer.
async fn draft_medicare_claim(r: &Router, a: &Actor, p: Uuid, visit: Uuid) -> Value {
    draft_medicare_claim_for_policy(r, a, p, visit, "self", "Avery Synthetic").await
}

async fn draft_medicare_claim_for_policy(
    r: &Router,
    a: &Actor,
    p: Uuid,
    visit: Uuid,
    relationship: &str,
    subscriber_name: &str,
) -> Value {
    let payer = ok(
        r,
        a,
        "POST",
        "/api/v1/billing/payers",
        json!({"request_id":Uuid::new_v4(),"content":{"name":"Medicare NJ","payer_code":"SYN-MCARE","address":"Synthetic payer address","phone":"","active":true},"reason":"Synthetic payer"}),
        None,
    )
    .await;
    let coverage = ok(
        r,
        a,
        "POST",
        &format!("/api/v1/patients/{p}/coverages"),
        json!({"request_id":Uuid::new_v4(),"content":{"payer_id":id(&payer),"priority":"primary","status":"active","member_id":"SYN-MEMBER","group_number":"SYN-GROUP","plan_name":"Synthetic plan","subscriber_name":subscriber_name,"subscriber_birth_date":"1990-01-01","relationship":relationship,"effective_date":"2026-01-01","end_date":null,"copay_cents":null,"verification":"manually_verified","notes":"Synthetic"},"reason":"Synthetic coverage"}),
        None,
    )
    .await;
    let base = format!("/api/v1/patients/{p}/billing/accounts");
    let draft = ok(
        r,
        a,
        "POST",
        &base,
        json!({"request_id":Uuid::new_v4(),"content":{"visit_id":visit,"coverage_id":id(&coverage),"service_date":"2026-10-25","currency":"USD","notes":"Synthetic","lines":[{"code_system":"CPT","code":"99213","description":"Synthetic service","modifiers":"","units":1,"amount_cents":10000,"diagnosis_codes":["Z00.00"]}]},"reason":"Synthetic charges"}),
        None,
    )
    .await;
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
    let control = format!("SYN-{}", Uuid::new_v4().simple());
    ok(
        r,
        a,
        "POST",
        &format!("{account_path}/claims"),
        json!({"request_id":Uuid::new_v4(),"frequency":"original","content":claim_content(&control),"reason":"Synthetic primary"}),
        Some(version(&posted)),
    )
    .await
}

async fn claim_file(db: &PgPool, tenant: Uuid, claim: Uuid) -> (String, String) {
    sqlx::query_as::<_, (String, String)>(
        "SELECT control_number, snapshot->'account'->'coverage_snapshot'->'payer'->'content'->>'name' FROM ehr_claims WHERE tenant_id=$1 AND id=$2",
    )
    .bind(tenant)
    .bind(claim)
    .fetch_one(db)
    .await
    .unwrap()
}

fn x12_details() -> Value {
    let addr = |l1: &str, city: &str, state: &str, zip: &str| json!({"line1":l1,"line2":"","city":city,"state":state,"postal_code":zip});
    json!({
        "billing_address":addr("0 Example Street",PAT_CITY,PAT_STATE,PAT_ZIP),
        "subscriber_address":addr(PAT_ADDRESS,PAT_CITY,PAT_STATE,PAT_ZIP),
        "patient_address":addr(PAT_ADDRESS,PAT_CITY,PAT_STATE,PAT_ZIP),
        "payer_address":addr("","","",""),
        "subscriber_given_name":"Avery",
        "subscriber_family_name":"Synthetic",
        "patient_sex":"F",
        "subscriber_sex":"F",
        "rendering_given_name":"Synthetic",
        "rendering_family_name":"Clinician",
        "billing_taxonomy":TAXONOMY,
        "filing_indicator":"MB",
        "signature_on_file":true,
        "benefits_assigned":true,
        "release_authorized":true,
        "routine_professional_reviewed":true,
        "synthetic_test_reviewed":true
    })
}

async fn synthetic_trading_partner(r: &Router, a: &Actor) -> Value {
    ok(
        r,
        a,
        "POST",
        "/api/v1/billing/clearinghouses",
        json!({"request_id":Uuid::new_v4(),"content":{"name":"Synthetic transport","active":true,"sender_qualifier":"ZZ","sender_id":"SYN-SEND","receiver_qualifier":"ZZ","receiver_id":"SYN-RECV","application_sender":"SYN-SEND","application_receiver":"SYN-RECV","submitter_name":"Synthetic Clinic","submitter_id":"SYN-CLINIC","receiver_name":"Synthetic Receiver","receiver_identifier":"SYN-R","contact_name":"Synthetic Contact","contact_phone":"5125550101","usage":"T","guide_reference":"Synthetic contract"},"reason":"Synthetic partner"}),
        None,
    )
    .await
}

#[tokio::test]
async fn matching_self_policyholder_correction_preserves_posted_sources_and_releases_correct_packet(
) {
    let (db, a, p, visit, _) = setup(TAXONOMY, 1).await;
    let r = app(db.clone());
    let draft =
        draft_medicare_claim_for_policy(&r, &a, p, visit, "other", "synthetic, avery").await;
    let claim_id = id(&draft);
    let account_id = Uuid::parse_str(draft["account_id"].as_str().unwrap()).unwrap();
    let path = format!("/api/v1/billing/claims/{claim_id}");
    let actions = format!("{path}/actions");
    let mut content = draft["content"].clone();
    content["subscriber_address"] = json!("");
    content["encounter"] = json!({"prior_authorization_number":"SYN-PA-123"});
    let draft = ok(
        &r,
        &a,
        "PUT",
        &path,
        json!({"content":content,"reason":"Synthetic authorization before correction"}),
        Some(version(&draft)),
    )
    .await;
    let read_sources = || {
        sqlx::query_scalar::<_, Value>(
            "SELECT jsonb_build_object('account',to_jsonb(b),'coverage',to_jsonb(c),'demographics',to_jsonb(d),
             'ledger',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM billing_entries e WHERE e.tenant_id=b.tenant_id AND e.account_id=b.id))
             FROM billing_accounts b JOIN insurance_coverages c ON c.tenant_id=b.tenant_id AND c.id=b.coverage_id
             JOIN patient_demographics d ON d.tenant_id=b.tenant_id AND d.patient_id=b.patient_id
             WHERE b.tenant_id=$1 AND b.id=$2",
        ).bind(a.tenant_id).bind(account_id)
    };
    let sources = read_sources().fetch_one(&db).await.unwrap();
    let before = ok(&r, &a, "GET", &path, Value::Null, None).await;
    assert_eq!(before["can_confirm_self_policyholder"], true);
    let issues = before["preflight_issues"].as_array().unwrap();
    assert!(issues.contains(&json!("Policy holder relationship must be confirmed")));
    assert!(issues.contains(&json!("Subscriber address is required")));
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &actions,
            json!({"action":"ready","reason":"Synthetic check"}),
            Some(version(&draft))
        )
        .await
        .0,
        StatusCode::CONFLICT,
    );
    let confirm = json!({"action":"confirm_self_policyholder","reason":"Confirmed the saved synthetic policy holder and address"});
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &actions,
            confirm.clone(),
            Some(version(&draft) - 1)
        )
        .await
        .0,
        StatusCode::CONFLICT,
    );
    let corrected = ok(
        &r,
        &a,
        "POST",
        &actions,
        confirm.clone(),
        Some(version(&draft)),
    )
    .await;
    assert_eq!(corrected["status"], "draft");
    assert_eq!(version(&corrected), version(&draft) + 1);
    assert_eq!(corrected["control_number"], draft["control_number"]);
    let coverage_path = "/account/coverage_snapshot/coverage/content/relationship";
    let mut expected_snapshot = draft["snapshot"].clone();
    *expected_snapshot.pointer_mut(coverage_path).unwrap() = json!("self");
    assert_eq!(corrected["snapshot"], expected_snapshot);
    let mut expected_content = draft["content"].clone();
    expected_content["subscriber_address"] =
        json!(format!("{PAT_ADDRESS}, {PAT_CITY}, {PAT_STATE} {PAT_ZIP}"));
    assert_eq!(corrected["content"], expected_content);
    assert_eq!(read_sources().fetch_one(&db).await.unwrap(), sources);
    let evidence: Value = sqlx::query_scalar(
        "SELECT evidence FROM claim_revisions WHERE tenant_id=$1 AND claim_id=$2 AND version=$3",
    )
    .bind(a.tenant_id)
    .bind(claim_id)
    .bind(version(&corrected))
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(evidence["action"], "confirm_self_policyholder");
    assert_eq!(evidence["network_transmitted"], false);
    let detail = ok(&r, &a, "GET", &path, Value::Null, None).await;
    assert_eq!(detail["can_confirm_self_policyholder"], false);
    assert_eq!(detail["preflight_issues"], json!([]));
    assert_eq!(
        detail["submission_defaults"]["subscriber_address"]["line1"],
        PAT_ADDRESS
    );
    let preview = ok(&r, &a, "GET", &format!("{path}/cms1500"), Value::Null, None).await;
    let html = preview["message"].as_str().unwrap();
    assert!(html.contains("PATIENT RELATIONSHIP TO INSURED</label>Self"));
    assert!(html.contains("SYN-PA-123"));
    let ready = ok(
        &r,
        &a,
        "POST",
        &actions,
        json!({"action":"ready","reason":"Reviewed synthetic correction"}),
        Some(version(&corrected)),
    )
    .await;
    let partner = synthetic_trading_partner(&r, &a).await;
    let artifact = ok(
        &r,
        &a,
        "POST",
        &format!("{path}/837p"),
        json!({"request_id":Uuid::new_v4(),"partner_id":id(&partner),"partner_version":version(&partner),"details":x12_details(),"reason":"Synthetic correction artifact only"}),
        Some(version(&ready)),
    )
    .await;
    let payload: String =
        sqlx::query_scalar("SELECT payload FROM edi_submissions WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id(&artifact))
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(payload.contains("SBR*P*18*"));
    assert!(payload.contains("REF*G1*SYN-PA-123~"));
    assert_eq!(
        call(&r, &a, "POST", &actions, confirm, Some(version(&ready)))
            .await
            .0,
        StatusCode::CONFLICT,
    );
    db.close().await;
}

#[tokio::test]
async fn a_different_policyholder_cannot_be_marked_as_the_patient() {
    let (db, a, p, visit, _) = setup(TAXONOMY, 1).await;
    let r = app(db.clone());
    let draft =
        draft_medicare_claim_for_policy(&r, &a, p, visit, "other", "Different Synthetic").await;
    let path = format!("/api/v1/billing/claims/{}", id(&draft));
    let before = ok(&r, &a, "GET", &path, Value::Null, None).await;
    assert_eq!(before["can_confirm_self_policyholder"], false);
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &format!("{path}/actions"),
            json!({"action":"confirm_self_policyholder","reason":"Synthetic mismatch"}),
            Some(version(&draft)),
        )
        .await
        .0,
        StatusCode::CONFLICT,
    );
    let after = ok(&r, &a, "GET", &path, Value::Null, None).await;
    assert_eq!(after["claim"], before["claim"]);
    db.close().await;
}

#[tokio::test]
async fn submission_defaults_prefill_taxonomy_facility_address_and_filing_indicator() {
    let (db, a, p, visit, cookie) = setup(TAXONOMY, 1).await;
    let r = app(db.clone());
    let claim = draft_medicare_claim(&r, &a, p, visit).await;
    let claim_id = id(&claim);
    let (_, payer_name) = claim_file(&db, a.tenant_id, claim_id).await;
    assert_eq!(payer_name, "Medicare NJ");

    let path = format!("/api/v1/billing/claims/{claim_id}");
    let detail = ok(&r, &a, "GET", &path, Value::Null, None).await;
    let defaults = &detail["submission_defaults"];
    assert_eq!(defaults["billing_taxonomy"], TAXONOMY);
    assert_eq!(defaults["billing_taxonomy_source"], "provider");
    assert_eq!(defaults["filing_indicator"], "MB");
    assert_eq!(defaults["billing_address"]["line1"], "0 Example Street");
    assert_eq!(defaults["billing_address"]["city"], PAT_CITY);
    assert_eq!(defaults["billing_address"]["state"], PAT_STATE);
    assert_eq!(defaults["billing_address"]["postal_code"], PAT_ZIP);

    // Change the sole facility's parts through the API; the same GET must reflect
    // the facility as it is now, not the frozen claim.
    let facilities = ok_cookie(
        &r,
        &cookie,
        "GET",
        "/api/v1/practice/facilities",
        Value::Null,
        None,
    )
    .await;
    let facility = facilities["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["active"] == json!(true))
        .expect("an active facility exists");
    let facility_id = facility["id"].as_str().unwrap();
    let facility_version = facility["version"].as_i64().unwrap();
    ok_cookie(
        &r,
        &cookie,
        "PUT",
        &format!("/api/v1/practice/facilities/{facility_id}"),
        json!({"name":facility["name"],"address":"","address_line1":"990 Changed Street","address_line2":"Suite 5","city":"Round Rock","state":"TX","postal_code":"78664","phone":"","active":true,"reason":"Synthetic facility address change"}),
        Some(facility_version),
    )
    .await;
    let after = ok(&r, &a, "GET", &path, Value::Null, None).await;
    let after = &after["submission_defaults"]["billing_address"];
    assert_eq!(after["line1"], "990 Changed Street");
    assert_eq!(after["line2"], "Suite 5");
    assert_eq!(after["city"], "Round Rock");
    assert_eq!(after["state"], "TX");
    assert_eq!(after["postal_code"], "78664");

    // The blank payer address on the prefilled form is accepted by the 837P path:
    // the artifact generates and no payer N3/N4 is emitted.
    let ready = ok(
        &r,
        &a,
        "POST",
        &format!("/api/v1/billing/claims/{claim_id}/actions"),
        json!({"action":"ready","reason":"Synthetic review"}),
        Some(version(&claim)),
    )
    .await;
    let partner = synthetic_trading_partner(&r, &a).await;
    let artifact = ok(
        &r,
        &a,
        "POST",
        &format!("/api/v1/billing/claims/{claim_id}/837p"),
        json!({"request_id":Uuid::new_v4(),"partner_id":id(&partner),"partner_version":version(&partner),"details":x12_details(),"reason":"Synthetic generated evidence only"}),
        Some(version(&ready)),
    )
    .await;
    let payload: String =
        sqlx::query_scalar("SELECT payload FROM edi_submissions WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id(&artifact))
            .fetch_one(&db)
            .await
            .unwrap();
    let segs: Vec<&str> = payload.split('~').filter(|s| !s.is_empty()).collect();
    let pr = segs
        .iter()
        .rposition(|s| s.starts_with("NM1*PR*2*"))
        .expect("a payer NM1*PR segment");
    assert!(
        !segs[pr + 1].starts_with("N3") && !segs[pr + 1].starts_with("N4"),
        "blank payer address must emit no N3/N4, next segment was {:?}",
        segs[pr + 1]
    );
    db.close().await;
}

#[tokio::test]
async fn two_active_facilities_leave_the_billing_address_empty() {
    let (db, a, p, visit, _cookie) = setup(TAXONOMY, 2).await;
    let r = app(db.clone());
    let claim = draft_medicare_claim(&r, &a, p, visit).await;
    let detail = ok(
        &r,
        &a,
        "GET",
        &format!("/api/v1/billing/claims/{}", id(&claim)),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(
        detail["submission_defaults"]["billing_address"],
        json!({"line1":"","line2":"","city":"","state":"","postal_code":""})
    );
    // The taxonomy and filing indicator are unaffected by the facility count.
    assert_eq!(detail["submission_defaults"]["billing_taxonomy"], TAXONOMY);
    assert_eq!(detail["submission_defaults"]["filing_indicator"], "MB");
    db.close().await;
}

#[tokio::test]
async fn a_provider_without_a_taxonomy_prefills_an_empty_taxonomy() {
    let (db, a, p, visit, _cookie) = setup("", 1).await;
    let r = app(db.clone());
    let claim = draft_medicare_claim(&r, &a, p, visit).await;
    let detail = ok(
        &r,
        &a,
        "GET",
        &format!("/api/v1/billing/claims/{}", id(&claim)),
        Value::Null,
        None,
    )
    .await;
    let defaults = &detail["submission_defaults"];
    assert_eq!(defaults["billing_taxonomy"], "");
    assert_eq!(defaults["billing_taxonomy_source"], "");
    // Only the taxonomy is missing; the facility and payer still prefill.
    assert_eq!(defaults["filing_indicator"], "MB");
    assert_eq!(defaults["billing_address"]["line1"], "0 Example Street");
    db.close().await;
}

/// The registry environment is process-wide, so the test that drives the lookup
/// holds this while it sets it and reads the claim. It uses the same NPI the
/// provider row carries, so the claim resolves to a provider with no taxonomy and
/// the registry supplies the code without anything being stored.
static REGISTRY: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tokio::test]
// The registry environment is process-wide, so this test holds the guard across the
// claim read to keep it stable. The lock only serialises these tests.
#[allow(clippy::await_holding_lock)]
async fn a_missing_provider_taxonomy_is_filled_from_the_registry_as_a_source() {
    let _guard = REGISTRY.lock().unwrap();
    let (db, a, p, visit, _cookie) = setup("", 1).await;
    std::env::set_var("ENGINE_NPI_REGISTRY_URL", registry_base());
    let r = app(db.clone());
    let claim = draft_medicare_claim(&r, &a, p, visit).await;
    let detail = ok(
        &r,
        &a,
        "GET",
        &format!("/api/v1/billing/claims/{}", id(&claim)),
        Value::Null,
        None,
    )
    .await;
    let defaults = &detail["submission_defaults"];
    assert_eq!(defaults["billing_taxonomy"], REGISTRY_TAXONOMY);
    assert_eq!(defaults["billing_taxonomy_source"], "npi_registry");
    // Nothing was written back: the provider row still carries no taxonomy.
    let stored: String =
        sqlx::query_scalar("SELECT taxonomy FROM practice_providers WHERE tenant_id=$1 AND npi=$2")
            .bind(a.tenant_id)
            .bind(NPI)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(stored, "");
    std::env::set_var("ENGINE_NPI_REGISTRY_URL", "");
    db.close().await;
}
