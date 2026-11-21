// SPDX-License-Identifier: AGPL-3.0-only
//! Practice code settings: code-set switches, the practice code list, and their effect on
//! terminology search and the procedure box. Synthetic data only.
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
    let schema = format!("practice_codes_{}", Uuid::new_v4().simple());
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
        secret: "synthetic-practice-codes-test-secret".into(),
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
async fn user(f: &Fixture, role: &str) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let cookie = format!("synthetic-{role}-{}", Uuid::new_v4().simple());
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-a-login-hash',$4)")
        .bind(f.tenant)
        .bind(id)
        .bind(format!("{id}@example.test"))
        .bind(role)
        .execute(&f.db)
        .await
        .unwrap();
    session(&f.db, f.tenant, id, &cookie).await;
    (id, cookie)
}
fn code_body(system: &str, code: &str, display: &str) -> Value {
    json!({"request_id":Uuid::new_v4(),"system":system,"code":code,"display":display,"enabled":true,"price_cents":16981,"default_units":1,"modifiers":""})
}
async fn create(app: &Router, cookie: &str, body: Value) -> (StatusCode, Value) {
    call(app, cookie, "POST", "/api/v1/practice/codes", body, None).await
}
async fn install_icd(f: &Fixture) {
    let catalog = json!({"request_id":Uuid::new_v4(),"system":"ICD-10-CM","edition":"Synthetic FY2027","source_name":"Synthetic fixture","source_url":"https://example.test/synthetic-catalog","source_sha256":"a".repeat(64),"effective_start":"2026-01-01","effective_end":null,"rights":"public_use","rights_attested":true,"reason":"Synthetic catalog fixture only","codes":[{"code":"Z0000","display":"Synthetic encounter diagnosis","billable":true}]});
    let (status, value) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/terminology/releases",
        catalog,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
}
#[tokio::test]
async fn owner_manages_code_sets_with_versions_and_audit() {
    let f = setup().await;
    let (status, page) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/code-sets",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 4);
    assert_eq!(
        items
            .iter()
            .map(|i| i["system"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["ICD-10-CM", "ICD-10-PCS", "HCPCS", "CPT"]
    );
    for item in items {
        assert_eq!(item["enabled"], json!(true));
        assert_eq!(item["version"], json!(0));
        assert_eq!(item["installed"], json!(false));
    }
    install_icd(&f).await;
    let (_, page) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/code-sets",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(page["items"][0]["installed"], json!(true));
    assert_eq!(page["items"][0]["version"], json!(0));
    let path = "/api/v1/practice/code-sets/CPT";
    let (status, item) = call(
        &f.app,
        &f.cookie,
        "PUT",
        path,
        json!({"enabled":false}),
        Some(0),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{item}");
    assert_eq!(item["enabled"], json!(false));
    assert_eq!(item["version"], json!(1));
    assert_eq!(item["installed"], json!(false));
    // Stale version conflicts; the current version replays idempotently at version 2.
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            path,
            json!({"enabled":true}),
            Some(0)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (status, item) = call(
        &f.app,
        &f.cookie,
        "PUT",
        path,
        json!({"enabled":false}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{item}");
    assert_eq!(item["version"], json!(2));
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            path,
            json!({"enabled":true}),
            None
        )
        .await
        .0,
        StatusCode::PRECONDITION_REQUIRED
    );
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            path,
            json!({"enabled":false}),
            Some(9)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &f.app,
            &f.cookie,
            "PUT",
            "/api/v1/practice/code-sets/RXNORM",
            json!({"enabled":false}),
            Some(0)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let audits: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_events WHERE tenant_id=$1 AND action LIKE 'practice.code%' ORDER BY id",
    )
    .bind(f.tenant)
    .fetch_all(&f.db)
    .await
    .unwrap();
    assert!(
        audits.contains(&"practice.code_set.updated".to_owned()),
        "{audits:?}"
    );
    // A second tenant never sees this tenant's switches.
    let other = Uuid::new_v4();
    let other_user = Uuid::new_v4();
    let other_cookie = "synthetic-other-code-sets";
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'other@example.test','synthetic','owner')").bind(other).bind(other_user).execute(&f.db).await.unwrap();
    session(&f.db, other, other_user, other_cookie).await;
    let (_, theirs) = call(
        &f.app,
        other_cookie,
        "GET",
        "/api/v1/practice/code-sets",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(theirs["items"][3]["enabled"], json!(true));
    assert_eq!(theirs["items"][3]["version"], json!(0));
    cleanup(f).await;
}
#[tokio::test]
async fn owner_creates_updates_and_replays_codes_with_validation_and_conflicts() {
    let f = setup().await;
    let body = code_body("CPT", "99214", "Synthetic office visit");
    let (status, item) = create(&f.app, &f.cookie, body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{item}");
    assert_eq!(item["code"], "99214");
    assert_eq!(item["system"], "CPT");
    assert_eq!(item["price_cents"], json!(16981));
    assert_eq!(item["default_units"], json!(1));
    assert_eq!(item["modifiers"], json!(""));
    assert_eq!(item["version"], json!(1));
    let id = item["id"].as_str().unwrap().to_owned();
    // Replay of the same request_id returns the same item.
    let (status, replay) = create(&f.app, &f.cookie, body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay, item);
    // The same canonical code from another request is a duplicate.
    let mut again = code_body("cpt", "99214", "Other words");
    again["request_id"] = json!(Uuid::new_v4());
    let (status, dup) = create(&f.app, &f.cookie, again).await;
    assert_eq!(status, StatusCode::CONFLICT, "{dup}");
    assert_eq!(dup["message"], "This code is already in your list.");
    // Same digits in a different system is not the same code.
    let (status, hcpcs) = create(
        &f.app,
        &f.cookie,
        code_body("HCPCS", "J0000", "Synthetic HCPCS"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{hcpcs}");
    // ICD codes canonicalize the way catalogs store them.
    let (status, icd) = create(
        &f.app,
        &f.cookie,
        code_body("ICD-10-CM", "z0000", "Synthetic diagnosis"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{icd}");
    assert_eq!(icd["code"], "Z00.00");
    // Validation.
    let bad = code_body("CPT", "not a code", "Synthetic");
    assert_eq!(
        create(&f.app, &f.cookie, bad).await.0,
        StatusCode::BAD_REQUEST
    );
    let bad = code_body("RXNORM", "99999", "Synthetic");
    assert_eq!(
        create(&f.app, &f.cookie, bad).await.0,
        StatusCode::BAD_REQUEST
    );
    let bad = code_body("CPT", "99999", "");
    assert_eq!(
        create(&f.app, &f.cookie, bad).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut bad = code_body("CPT", "99999", "Synthetic");
    bad["price_cents"] = json!(10000001);
    assert_eq!(
        create(&f.app, &f.cookie, bad).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut bad = code_body("CPT", "99999", "Synthetic");
    bad["default_units"] = json!(0);
    assert_eq!(
        create(&f.app, &f.cookie, bad).await.0,
        StatusCode::BAD_REQUEST
    );
    for modifiers in ["26 25 LT AA BB", "abc", "26  25"] {
        let mut bad = code_body("CPT", "99999", "Synthetic");
        bad["modifiers"] = json!(modifiers);
        assert_eq!(
            create(&f.app, &f.cookie, bad).await.0,
            StatusCode::BAD_REQUEST,
            "{modifiers}"
        );
    }
    // Update with If-Match.
    let path = format!("/api/v1/practice/codes/{id}");
    let update = json!({"display":"Synthetic office visit, revised","enabled":true,"price_cents":null,"default_units":2,"modifiers":"26 25"});
    assert_eq!(
        call(&f.app, &f.cookie, "PUT", &path, update.clone(), Some(0))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (status, saved) = call(&f.app, &f.cookie, "PUT", &path, update.clone(), Some(1)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["version"], json!(2));
    assert_eq!(saved["display"], "Synthetic office visit, revised");
    assert_eq!(saved["price_cents"], json!(null));
    assert_eq!(saved["default_units"], json!(2));
    assert_eq!(saved["modifiers"], json!("26 25"));
    // Listing: filters, ordering, prefix and word search.
    let (status, list) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/codes",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let listed: Vec<String> = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            format!(
                "{}/{}",
                i["system"].as_str().unwrap(),
                i["code"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(
        listed,
        ["CPT/99214", "HCPCS/J0000", "ICD-10-CM/Z00.00"],
        "ordered by system then code"
    );
    let (_, only_cpt) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/codes?system=CPT&q=992",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(only_cpt["items"].as_array().unwrap().len(), 1);
    let (_, by_word) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/codes?q=revised%20office",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(by_word["items"][0]["id"], json!(id));
    let (_, off) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/codes?enabled=false",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(off["items"], json!([]));
    let audits: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_events WHERE tenant_id=$1 AND action LIKE 'practice.code%' ORDER BY id",
    )
    .bind(f.tenant)
    .fetch_all(&f.db)
    .await
    .unwrap();
    assert_eq!(
        audits
            .iter()
            .filter(|a| *a == "practice.code.created")
            .count(),
        3
    );
    assert_eq!(
        audits
            .iter()
            .filter(|a| *a == "practice.code.updated")
            .count(),
        1
    );
    cleanup(f).await;
}
#[tokio::test]
async fn charge_staff_add_codes_and_prices_and_the_rest_is_owner_only() {
    let f = setup().await;
    let (status, item) = create(
        &f.app,
        &f.cookie,
        code_body("CPT", "99213", "Synthetic visit"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{item}");
    let id = item["id"].as_str().unwrap().to_owned();
    let (_, clinician_cookie) = user(&f, "clinician").await;
    let (_, front_cookie) = user(&f, "front_desk").await;
    let (_, reader_cookie) = user(&f, "read_only").await;
    // Staff who enter charges may add a code and set a price, and nothing else. Read-only staff
    // may not write at all.
    assert_eq!(
        call(
            &f.app,
            &reader_cookie,
            "POST",
            "/api/v1/practice/codes",
            code_body("CPT", "99215", "Nope"),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, added) = call(
        &f.app,
        &clinician_cookie,
        "POST",
        "/api/v1/practice/codes",
        code_body("CPT", "99215", "Office visit, established, high"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    let added_id = added["id"].as_str().unwrap().to_owned();
    let (status, priced) = call(
        &f.app,
        &front_cookie,
        "PUT",
        &format!("/api/v1/practice/codes/{added_id}"),
        json!({"display":added["display"],"enabled":true,"price_cents":21000,"default_units":added["default_units"],"modifiers":added["modifiers"]}),
        Some(added["version"].as_i64().unwrap()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{priced}");
    assert_eq!(priced["price_cents"], 21000);
    // Turning a code off stays with the owner.
    assert_eq!(
        call(
            &f.app,
            &front_cookie,
            "PUT",
            &format!("/api/v1/practice/codes/{added_id}"),
            json!({"display":added["display"],"enabled":false,"price_cents":21000,"default_units":added["default_units"],"modifiers":added["modifiers"]}),
            Some(priced["version"].as_i64().unwrap()),
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for cookie in [&clinician_cookie, &front_cookie, &reader_cookie] {
        assert_eq!(
            call(
                &f.app,
                cookie,
                "PUT",
                &format!("/api/v1/practice/codes/{id}"),
                json!({"display":"Nope","enabled":true,"price_cents":null,"default_units":1,"modifiers":""}),
                Some(1)
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &f.app,
                cookie,
                "PUT",
                "/api/v1/practice/code-sets/CPT",
                json!({"enabled":false}),
                Some(0)
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &f.app,
                cookie,
                "GET",
                "/api/v1/practice/code-sets",
                Value::Null,
                None
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    // Reading needs the billing view permission, like fee reads.
    assert_eq!(
        call(
            &f.app,
            &clinician_cookie,
            "GET",
            "/api/v1/practice/codes",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::OK
    );
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
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'No billing','clinician',$3,$4)")
        .bind(f.tenant).bind(policy).bind(permissions).bind(f.owner)
        .execute(&f.db).await.unwrap();
    let clinician: Uuid = sqlx::query_scalar("SELECT id FROM browser_users WHERE tenant_id=$1 AND role='clinician' ORDER BY email LIMIT 1")
        .bind(f.tenant).fetch_one(&f.db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)")
        .bind(f.tenant).bind(clinician).bind(policy).bind(f.owner)
        .execute(&f.db).await.unwrap();
    assert_eq!(
        call(
            &f.app,
            &clinician_cookie,
            "GET",
            "/api/v1/practice/codes",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN,
        "billing view permission gates the list"
    );
    cleanup(f).await;
}
#[tokio::test]
async fn turning_a_system_off_hides_it_from_terminology_search() {
    let f = setup().await;
    install_icd(&f).await;
    let search = "/api/v1/terminology/codes?system=ICD-10-CM&q=synthetic&service_date=2026-11-07";
    let (status, found) = call(&f.app, &f.cookie, "GET", search, Value::Null, None).await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert!(!found["items"].as_array().unwrap().is_empty());
    assert!(found.get("disabled").is_none());
    let (status, item) = call(
        &f.app,
        &f.cookie,
        "PUT",
        "/api/v1/practice/code-sets/ICD-10-CM",
        json!({"enabled":false}),
        Some(0),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{item}");
    let (status, hidden) = call(&f.app, &f.cookie, "GET", search, Value::Null, None).await;
    assert_eq!(status, StatusCode::OK, "{hidden}");
    assert_eq!(
        hidden,
        json!({"items":[],"release":null,"next_cursor":null,"disabled":true,"service_date":"2026-11-07"})
    );
    // Turning it back on restores the catalog.
    call(
        &f.app,
        &f.cookie,
        "PUT",
        "/api/v1/practice/code-sets/ICD-10-CM",
        json!({"enabled":true}),
        Some(1),
    )
    .await;
    let (_, back) = call(&f.app, &f.cookie, "GET", search, Value::Null, None).await;
    assert!(!back["items"].as_array().unwrap().is_empty());
    assert!(back.get("disabled").is_none());
    cleanup(f).await;
}
async fn clinical_fixture(f: &Fixture) -> (Uuid, Uuid) {
    let p = Uuid::new_v4();
    let ap = Uuid::new_v4();
    let v = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-PC','Synthetic','Codes','1980-01-01')").bind(f.tenant).bind(p).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at) VALUES($1,$2,$3,$4,'2026-11-01T10:00:00Z','2026-11-01T10:30:00Z')").bind(f.tenant).bind(ap).bind(p).bind(f.owner).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id) VALUES($1,$2,$3,$4,$5)").bind(f.tenant).bind(v).bind(p).bind(ap).bind(f.owner).execute(&f.db).await.unwrap();
    (p, v)
}
async fn post_charge(f: &Fixture, p: Uuid, code: &str, description: &str) {
    let ap = Uuid::new_v4();
    let v = Uuid::new_v4();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at) VALUES($1,$2,$3,$4,'2026-11-01T14:00:00Z','2026-11-01T14:30:00Z')").bind(f.tenant).bind(ap).bind(p).bind(f.owner).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id) VALUES($1,$2,$3,$4,$5)").bind(f.tenant).bind(v).bind(p).bind(ap).bind(f.owner).execute(&f.db).await.unwrap();
    let body = json!({"request_id":Uuid::new_v4(),"source_history_id":null,"reason":"Synthetic practice-code charge","content":{"visit_id":v,"coverage_id":null,"service_date":"2026-11-01","currency":"USD","notes":"","lines":[{"code_system":"CPT","code":code,"description":description,"modifiers":"","units":1,"amount_cents":1000,"diagnosis_codes":[]}]}});
    let (status, saved) = call(
        &f.app,
        &f.cookie,
        "POST",
        &format!("/api/v1/patients/{p}/billing/accounts"),
        body,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
}
#[tokio::test]
async fn procedure_codes_offer_practice_codes_first_and_hide_disabled_rows() {
    let f = setup().await;
    let (p, _v) = clinical_fixture(&f).await;
    let codes = |q: &str| format!("/api/v1/patients/{p}/procedure-codes?q={q}");
    // Billed history alone still answers as before.
    post_charge(&f, p, "99214", "Synthetic office visit").await;
    let (status, found) = call(&f.app, &f.cookie, "GET", &codes("992"), Value::Null, None).await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert_eq!(
        found["items"][0],
        json!({"code":"99214","system":"CPT","display":"Synthetic office visit"})
    );
    // Adding the practice row puts it first and adds its pricing fields.
    let (status, item) = create(
        &f.app,
        &f.cookie,
        code_body("CPT", "99214", "Owner short name"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{item}");
    let (status, found) = call(&f.app, &f.cookie, "GET", &codes("992"), Value::Null, None).await;
    assert_eq!(status, StatusCode::OK, "{found}");
    let items = found["items"].as_array().unwrap();
    assert_eq!(items[0]["code"], "99214");
    assert_eq!(items[0]["practice_code"], json!(true));
    assert_eq!(items[0]["display"], "Owner short name");
    assert_eq!(items[0]["price_cents"], json!(16981));
    assert_eq!(items[0]["default_units"], json!(1));
    assert_eq!(items[0]["modifiers"], json!(""));
    assert_eq!(items.len(), 1, "no duplicate by code");
    // A practice-only code appears by its own words, before history matches.
    create(
        &f.app,
        &f.cookie,
        code_body("HCPCS", "A0428", "Synthetic transport service"),
    )
    .await;
    let (_, found) = call(
        &f.app,
        &f.cookie,
        "GET",
        &codes("transport"),
        Value::Null,
        None,
    )
    .await;
    let items = found["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["code"], "A0428");
    assert_eq!(items[0]["system"], "HCPCS");
    assert_eq!(items[0]["practice_code"], json!(true));
    // Turning the practice row off hides the code even from billed history.
    let path = format!("/api/v1/practice/codes/{}", item["id"].as_str().unwrap());
    let (status, off) = call(
        &f.app,
        &f.cookie,
        "PUT",
        &path,
        json!({"display":"Owner short name","enabled":false,"price_cents":16981,"default_units":1,"modifiers":""}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{off}");
    let (_, found) = call(&f.app, &f.cookie, "GET", &codes("992"), Value::Null, None).await;
    assert_eq!(
        found["items"],
        json!([]),
        "a turned-off code leaves the box"
    );
    // A system turned off contributes nothing, even from billed history.
    post_charge(&f, p, "99213", "Synthetic other visit").await;
    call(
        &f.app,
        &f.cookie,
        "PUT",
        "/api/v1/practice/code-sets/CPT",
        json!({"enabled":false}),
        Some(0),
    )
    .await;
    let (_, found) = call(&f.app, &f.cookie, "GET", &codes("992"), Value::Null, None).await;
    assert_eq!(
        found["items"],
        json!([]),
        "a system turned off never contributes"
    );
    let (_, found) = call(
        &f.app,
        &f.cookie,
        "GET",
        &codes("transport"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(
        found["items"].as_array().unwrap().len(),
        1,
        "HCPCS is still on"
    );
    cleanup(f).await;
}

#[tokio::test]
async fn bundles_are_saved_listed_renamed_and_turned_off_by_charge_staff() {
    let f = setup().await;
    let (_, front_cookie) = user(&f, "front_desk").await;
    let (_, reader_cookie) = user(&f, "read_only").await;
    let lines = json!([
        {"code_system":"CPT","code":"99213","description":"Office visit, established","modifiers":"25","units":1},
        {"code_system":"CPT","code":"64616","description":"Chemodenervation of neck muscles","modifiers":"LT","units":1},
        {"code_system":"HCPCS","code":"j0585","description":"OnabotulinumtoxinA 1 unit","modifiers":"JZ","units":200,
         "ndc_code":"00023114501","ndc_quantity":"200","ndc_unit":"UN"}
    ]);
    // Staff who enter charges save a bundle; read-only staff may not.
    let body = json!({"name":"  Synthetic injection visit ","lines":lines});
    assert_eq!(
        call(
            &f.app,
            &reader_cookie,
            "POST",
            "/api/v1/practice/charge-bundles",
            body.clone(),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, saved) = call(
        &f.app,
        &front_cookie,
        "POST",
        "/api/v1/practice/charge-bundles",
        body.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["name"], "Synthetic injection visit");
    assert_eq!(
        saved["lines"][2]["code"], "J0585",
        "codes are stored in their canonical form"
    );
    assert_eq!(saved["lines"][2]["ndc_unit"], "UN");
    assert_eq!(
        saved["lines"][0].get("amount_cents"),
        None,
        "a bundle carries no amounts"
    );
    let id = saved["id"].as_str().unwrap().to_owned();
    // The same name again is refused, whatever its capitals.
    let (status, again) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/charge-bundles",
        json!({"name":"synthetic INJECTION visit","lines":lines}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{again}");
    // Half a drug line, a diagnosis code and an empty bundle are refused.
    for bad in [
        json!({"name":"Bad","lines":[{"code_system":"HCPCS","code":"J0585","description":"Drug","units":1,"ndc_code":"00023114501"}]}),
        json!({"name":"Bad","lines":[{"code_system":"ICD-10-CM","code":"G24.3","description":"Diagnosis","units":1}]}),
        json!({"name":"Bad","lines":[]}),
        json!({"name":"","lines":lines}),
    ] {
        assert_eq!(
            call(
                &f.app,
                &f.cookie,
                "POST",
                "/api/v1/practice/charge-bundles",
                bad,
                None
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    // Everyone who can see billing gets the list.
    let (status, list) = call(
        &f.app,
        &front_cookie,
        "GET",
        "/api/v1/practice/charge-bundles",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    // Renaming needs the version; turning it off takes it out of the list and frees the name.
    let (status, renamed) = call(
        &f.app,
        &front_cookie,
        "PUT",
        &format!("/api/v1/practice/charge-bundles/{id}"),
        json!({"name":"Synthetic neck injection","lines":lines,"enabled":true}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(renamed["version"], 2);
    assert_eq!(
        call(
            &f.app,
            &front_cookie,
            "PUT",
            &format!("/api/v1/practice/charge-bundles/{id}"),
            json!({"name":"Stale","lines":lines,"enabled":true}),
            Some(1)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (status, off) = call(
        &f.app,
        &front_cookie,
        "PUT",
        &format!("/api/v1/practice/charge-bundles/{id}"),
        json!({"name":"Synthetic neck injection","lines":lines,"enabled":false}),
        Some(2),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{off}");
    let (_, list) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/charge-bundles",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(list["items"].as_array().unwrap().len(), 0);
    let (status, reused) = call(
        &f.app,
        &f.cookie,
        "POST",
        "/api/v1/practice/charge-bundles",
        json!({"name":"Synthetic neck injection","lines":lines}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reused}");
    cleanup(f).await;
}
