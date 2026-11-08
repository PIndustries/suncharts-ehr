// SPDX-License-Identifier: AGPL-3.0-only
//! Synthetic reference data only: no proprietary code descriptions are bundled.
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
    model::StartVisit,
    postgres::PostgresBackend,
    State,
};
use tower::ServiceExt;
use uuid::Uuid;
const SECRET: &str = "synthetic-terminology-test-secret";
fn actor(tenant: Uuid, role: Role) -> Actor {
    let now = Utc::now().timestamp();
    Actor {
        sub: Uuid::new_v4(),
        tenant_id: tenant,
        role,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    }
}
async fn setup() -> (PgPool, Router, Actor, Actor, Actor, String) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("terminology_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
    let path = schema.clone();
    let db = PgPoolOptions::new()
        .max_connections(5)
        .after_connect(move |connection, _| {
            let query = format!("SET search_path TO {path}");
            Box::pin(async move {
                sqlx::query(&query).execute(connection).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let owner = actor(Uuid::new_v4(), Role::Owner);
    let nurse = actor(owner.tenant_id, Role::Nurse);
    let other = actor(Uuid::new_v4(), Role::Owner);
    for (user, role) in [(&owner, "owner"), (&nurse, "nurse"), (&other, "owner")] {
        sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-login',$4)").bind(user.tenant_id).bind(user.sub).bind(format!("{}@example.test",user.sub)).bind(role).execute(&db).await.unwrap();
    }
    let router = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), "http://127.0.0.1:8099".into()).unwrap()),
    });
    (db, router, owner, nurse, other, schema)
}
async fn call(
    router: &Router,
    identity: &Actor,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    call_version(router, identity, method, path, body, None).await
}
async fn call_version(
    router: &Router,
    identity: &Actor,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let mut actor = identity.clone();
    actor.iat = Utc::now().timestamp();
    actor.exp = actor.iat + 120;
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &actor,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");
    if let Some(version) = version {
        request = request.header("If-Match", format!("\"{version}\""));
    }
    let request = request.body(Body::from(body.to_string())).unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn release() -> Value {
    json!({"request_id":Uuid::new_v4(),"system":"ICD-10-CM","edition":"Synthetic FY2027","source_name":"Synthetic official-format fixture","source_url":"https://example.test/synthetic-catalog","source_sha256":"a".repeat(64),"effective_start":"2026-10-01","effective_end":"2027-09-30","rights":"public_use","rights_attested":true,"reason":"Synthetic catalog fixture only","codes":[
        {"code":"Z00","display":"Synthetic category","billable":false},
        {"code":"Z0000","display":"Synthetic first diagnosis","billable":true},
        {"code":"Z01.00","display":"Synthetic second diagnosis","billable":true},
        {"code":"QA00101","display":"Synthetic new-format diagnosis","billable":true}
    ]})
}
#[tokio::test]
async fn catalog_import_is_atomic_immutable_date_scoped_and_tenant_isolated() {
    let (db, router, owner, nurse, other, schema) = setup().await;
    let input = release();
    assert_eq!(
        call(
            &router,
            &nurse,
            "POST",
            "/api/v1/terminology/releases",
            input.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, created) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/terminology/releases",
        input.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["created"], true);
    assert_eq!(created["release"]["code_count"], 4);
    let id = created["release"]["id"].as_str().unwrap();
    let (_, replay) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/terminology/releases",
        input.clone(),
    )
    .await;
    assert_eq!(replay["created"], false);
    assert_eq!(replay["release"]["id"], id);
    let mut changed = input.clone();
    changed["codes"][0]["display"] = json!("Changed source content");
    assert_eq!(
        call(
            &router,
            &owner,
            "POST",
            "/api/v1/terminology/releases",
            changed
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, detail) = call(
        &router,
        &nurse,
        "GET",
        &format!("/api/v1/terminology/releases/{id}/codes/z0000"),
        Value::Null,
    )
    .await;
    assert_eq!(detail["code"], "Z00.00");
    assert_eq!(detail["edition"], "Synthetic FY2027");
    assert_eq!(detail["source_sha256"], "a".repeat(64));
    let (status,first)=call(&router,&nurse,"GET","/api/v1/terminology/codes?system=icd10cm&q=synthet&service_date=2026-11-07&billable=true&limit=1",Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    assert_eq!(first["items"][0]["code"], "QA0.0101");
    let next = first["next_cursor"].as_str().unwrap();
    assert_eq!(call(&router,&nurse,"GET",&format!("/api/v1/terminology/codes?system=ICD-10-CM&q=different&service_date=2026-11-07&billable=true&after={next}"),Value::Null).await.0,StatusCode::BAD_REQUEST);
    let (_,second)=call(&router,&nurse,"GET",&format!("/api/v1/terminology/codes?system=ICD-10-CM&q=synthet&service_date=2026-11-07&billable=true&limit=1&after={next}"),Value::Null).await;
    assert_ne!(first["items"][0]["code"], second["items"][0]["code"]);
    assert_eq!(second["release"]["id"], id);
    let (_, old_date) = call(
        &router,
        &nurse,
        "GET",
        "/api/v1/terminology/codes?system=ICD-10-CM&service_date=2025-01-01",
        Value::Null,
    )
    .await;
    assert_eq!(old_date["items"], json!([]));
    let mut later = release();
    later["edition"] = json!("Synthetic FY2028");
    later["effective_start"] = json!("2027-10-01");
    later["effective_end"] = json!("2028-09-30");
    later["codes"][1]["display"] = json!("Synthetic future display");
    assert_eq!(
        call(
            &router,
            &owner,
            "POST",
            "/api/v1/terminology/releases",
            later
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, historic) = call(
        &router,
        &nurse,
        "GET",
        "/api/v1/terminology/codes?system=ICD-10-CM&q=Z0000&service_date=2026-11-07",
        Value::Null,
    )
    .await;
    assert_eq!(historic["items"][0]["display"], "Synthetic first diagnosis");
    assert!(sqlx::query(
        "UPDATE terminology_codes SET display='changed' WHERE tenant_id=$1 AND release_id=$2"
    )
    .bind(owner.tenant_id)
    .bind(Uuid::parse_str(id).unwrap())
    .execute(&db)
    .await
    .is_err());
    assert_eq!(
        call(
            &router,
            &other,
            "GET",
            &format!("/api/v1/terminology/releases/{id}/codes/Z00.00"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    let mut cpt = release();
    cpt["system"] = json!("CPT");
    cpt["edition"] = json!("Synthetic licensed fixture");
    cpt["codes"] = json!([{"code":"99999","display":"Synthetic proprietary-format fixture, not AMA content","billable":true}]);
    assert_eq!(
        call(
            &router,
            &owner,
            "POST",
            "/api/v1/terminology/releases",
            cpt.clone()
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    cpt["rights"] = json!("licensed");
    cpt["license_reference"] = json!("PRIVATE-SYNTHETIC-LICENSE");
    let (status, licensed) =
        call(&router, &owner, "POST", "/api/v1/terminology/releases", cpt).await;
    assert_eq!(status, StatusCode::OK, "{licensed}");
    assert!(!licensed.to_string().contains("PRIVATE-SYNTHETIC-LICENSE"));
    let (_, hidden) = call(
        &router,
        &other,
        "GET",
        "/api/v1/terminology/codes?system=CPT&service_date=2026-11-07",
        Value::Null,
    )
    .await;
    assert_eq!(hidden["items"], json!([]));
    let cpt_id = licensed["release"]["id"].as_str().unwrap();
    assert_eq!(
        call(
            &router,
            &other,
            "GET",
            &format!("/api/v1/terminology/releases/{cpt_id}/codes/99999"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    // A failed audit rolls back both the release publication and every code.
    sqlx::raw_sql("CREATE FUNCTION deny_terminology_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='terminology.release.imported' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER deny_terminology_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_terminology_audit();").execute(&db).await.unwrap();
    let mut denied = release();
    denied["edition"] = json!("Synthetic rollback");
    let request = Uuid::parse_str(denied["request_id"].as_str().unwrap()).unwrap();
    assert_eq!(
        call(
            &router,
            &owner,
            "POST",
            "/api/v1/terminology/releases",
            denied
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM terminology_releases WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(owner.tenant_id)
    .bind(request)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(count, 0);
    drop(router);
    db.close().await;
    let base = PgPool::connect(&std::env::var("TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
}

#[tokio::test]
async fn clinical_mutations_resolve_trusted_catalogs_and_reject_inapplicable_codes() {
    let (db, router, owner, _, other, schema) = setup().await;
    let patient = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-CATALOG','Avery','Synthetic','1990-01-01')")
        .bind(owner.tenant_id).bind(patient).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-11-07T00:30:00Z','2026-11-07T01:00:00Z','checked_in')")
        .bind(owner.tenant_id).bind(appointment).bind(patient).bind(owner.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO previsit_booking_profiles(tenant_id,public_slug,default_clinician_id,booking_timezone,updated_by) VALUES($1,'synthetic-catalog-date',$2,'UTC',$2)")
        .bind(owner.tenant_id).bind(owner.sub).execute(&db).await.unwrap();
    let visit = PostgresBackend(db.clone())
        .start_visit(
            &owner,
            StartVisit {
                appointment_id: appointment,
            },
        )
        .await
        .unwrap();
    let diagnosis_path = format!("/api/v1/visits/{}/diagnoses", visit.id);
    let mut input = release();
    input["codes"][1]["effective_start"] = json!("2026-11-07");
    input["codes"].as_array_mut().unwrap().extend([
        json!({"code":"Z02.0","display":"Synthetic inactive diagnosis","billable":true,"active":false}),
        json!({"code":"Z03.0","display":"Synthetic future diagnosis","billable":true,"effective_start":"2026-11-08"}),
        json!({"code":"Z04.0","display":"Synthetic expired diagnosis","billable":true,"effective_end":"2026-11-06"}),
    ]);
    let (status, imported) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/terminology/releases",
        input,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{imported}");
    let release_id = imported["release"]["id"].clone();
    let (status, foreign) = call(
        &router,
        &other,
        "POST",
        "/api/v1/terminology/releases",
        release(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{foreign}");
    for (code, selected, expected) in [
        ("Z00", release_id.clone(), StatusCode::BAD_REQUEST),
        ("Z02.0", release_id.clone(), StatusCode::BAD_REQUEST),
        ("Z03.0", release_id.clone(), StatusCode::BAD_REQUEST),
        ("Z04.0", release_id.clone(), StatusCode::BAD_REQUEST),
        ("Z99.9", release_id.clone(), StatusCode::NOT_FOUND),
        (
            "Z00.00",
            foreign["release"]["id"].clone(),
            StatusCode::NOT_FOUND,
        ),
    ] {
        let (status, response) = call_version(&router, &owner, "PUT", &diagnosis_path,
            json!({"diagnoses":[{"code":code,"display":"Untrusted client description","catalog_release_id":selected}],"reason":"Synthetic catalog boundary"}), Some(visit.version)).await;
        assert_eq!(status, expected, "code={code}: {response}");
    }
    let (_, unchanged) = call(&router, &owner, "GET", &diagnosis_path, Value::Null).await;
    assert_eq!(unchanged["version"], visit.version);
    assert_eq!(unchanged["diagnoses"], json!([]));
    let (status, saved) = call_version(&router, &owner, "PUT", &diagnosis_path,
        json!({"diagnoses":[{"code":"Z00.00","display":"Untrusted client description","catalog_release_id":release_id}],"reason":"Synthetic trusted selection"}), Some(visit.version)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["service_date"], "2026-11-07");
    assert_eq!(
        saved["diagnoses"][0]["catalog_snapshot"]["service_date"],
        "2026-11-07"
    );
    assert_eq!(
        saved["diagnoses"][0]["display"],
        "Synthetic first diagnosis"
    );
    assert_eq!(
        saved["diagnoses"][0]["catalog_snapshot"]["source_sha256"],
        "a".repeat(64)
    );
    assert_eq!(
        saved["history"][0]["snapshot"][0]["catalog_release_id"],
        release_id
    );

    // Current scheduling preferences must not change the date already used by
    // an immutable clinical revision, including after clearing the active list.
    sqlx::query("UPDATE previsit_booking_profiles SET booking_timezone='America/Chicago',version=version+1 WHERE tenant_id=$1")
        .bind(owner.tenant_id).execute(&db).await.unwrap();
    let current_local: chrono::NaiveDate = sqlx::query_scalar("SELECT (ap.starts_at AT TIME ZONE bp.booking_timezone)::date FROM appointments ap JOIN previsit_booking_profiles bp USING(tenant_id) WHERE ap.tenant_id=$1 AND ap.id=$2")
        .bind(owner.tenant_id).bind(appointment).fetch_one(&db).await.unwrap();
    assert_eq!(current_local.to_string(), "2026-11-06");
    let (status, cleared) = call_version(
        &router,
        &owner,
        "PUT",
        &diagnosis_path,
        json!({"diagnoses":[],"reason":"Synthetic clear after timezone change"}),
        saved["version"].as_i64(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared["service_date"], "2026-11-07");
    let (status, recoded) = call_version(&router, &owner, "PUT", &diagnosis_path,
        json!({"diagnoses":[{"code":"Z00.00","display":"Untrusted description","catalog_release_id":release_id}],"reason":"Synthetic recoding after timezone change"}), cleared["version"].as_i64()).await;
    assert_eq!(status, StatusCode::OK, "{recoded}");
    assert_eq!(
        recoded["diagnoses"][0]["catalog_snapshot"]["service_date"],
        "2026-11-07"
    );

    let long_display = "Synthetic complete continuation descriptor "
        .repeat(110)
        .trim()
        .to_owned();
    assert!(long_display.len() > 4500);
    let mut procedure_input = release();
    procedure_input["system"] = json!("HCPCS");
    procedure_input["codes"] = json!([
        {"code":"A0001","display":long_display,"billable":true},
        {"code":"A0002","display":"Synthetic nonbillable procedure","billable":false},
        {"code":"A0003","display":"Synthetic inactive procedure","billable":true,"active":false},
        {"code":"A0004","display":"Synthetic future procedure","billable":true,"effective_start":"2026-11-08"},
        {"code":"A0005","display":"Synthetic expired procedure","billable":true,"effective_end":"2026-11-06"}
    ]);
    let (status, procedures) = call(
        &router,
        &owner,
        "POST",
        "/api/v1/terminology/releases",
        procedure_input,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{procedures}");
    let procedures_id = procedures["release"]["id"].clone();
    let billing_path = format!("/api/v1/patients/{patient}/billing/accounts");
    let account = |code: &str, system: &str, selected: Value, date: &str| {
        json!({
            "request_id":Uuid::new_v4(),"reason":"Synthetic catalog billing boundary",
            "content":{"visit_id":visit.id,"coverage_id":null,"service_date":date,"currency":"USD","notes":"Synthetic only",
                "lines":[{"code_system":system,"code":code,"description":"Untrusted client description","modifiers":"","units":1,"amount_cents":100,"diagnosis_codes":[],"catalog_release_id":selected,"catalog_snapshot":{"display":"Forged provenance","source_sha256":"spoofed"}}]}
        })
    };
    for (code, system, selected, date, expected) in [
        (
            "A0002",
            "HCPCS",
            procedures_id.clone(),
            "2026-11-07",
            StatusCode::BAD_REQUEST,
        ),
        (
            "A0003",
            "HCPCS",
            procedures_id.clone(),
            "2026-11-07",
            StatusCode::BAD_REQUEST,
        ),
        (
            "A0004",
            "HCPCS",
            procedures_id.clone(),
            "2026-11-07",
            StatusCode::BAD_REQUEST,
        ),
        (
            "A0005",
            "HCPCS",
            procedures_id.clone(),
            "2026-11-07",
            StatusCode::BAD_REQUEST,
        ),
        (
            "A0001",
            "HCPCS",
            procedures_id.clone(),
            "2025-11-07",
            StatusCode::BAD_REQUEST,
        ),
        (
            "A0001",
            "CPT",
            procedures_id.clone(),
            "2026-11-07",
            StatusCode::BAD_REQUEST,
        ),
        (
            "Z00.00",
            "ICD-10-CM",
            release_id.clone(),
            "2026-11-07",
            StatusCode::BAD_REQUEST,
        ),
        (
            "Z00.00",
            "ICD-10-CM",
            foreign["release"]["id"].clone(),
            "2026-11-07",
            StatusCode::NOT_FOUND,
        ),
    ] {
        let (status, response) = call(
            &router,
            &owner,
            "POST",
            &billing_path,
            account(code, system, selected, date),
        )
        .await;
        assert_eq!(status, expected, "code={code}: {response}");
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM billing_accounts WHERE tenant_id=$1")
        .bind(owner.tenant_id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let (status, billed) = call(
        &router,
        &owner,
        "POST",
        &billing_path,
        account("A0001", "HCPCS", procedures_id.clone(), "2026-11-07"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{billed}");
    let line = &billed["content"]["lines"][0];
    assert_eq!(line["description"], long_display);
    assert_eq!(line["catalog_release_id"], procedures_id);
    assert_eq!(line["catalog_snapshot"]["source_sha256"], "a".repeat(64));
    assert_eq!(line["catalog_snapshot"]["service_date"], "2026-11-07");
    assert!(!billed.to_string().contains("Forged provenance"));
    let mut invalid_edit = billed["content"].clone();
    invalid_edit["service_date"] = json!("2025-11-07");
    let (status, rejected) = call_version(
        &router,
        &owner,
        "PUT",
        &format!("{billing_path}/{}", billed["id"].as_str().unwrap()),
        json!({"content":invalid_edit,"reason":"Synthetic inapplicable date"}),
        billed["version"].as_i64(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");
    let stored: Value =
        sqlx::query_scalar("SELECT content FROM billing_accounts WHERE tenant_id=$1 AND id=$2")
            .bind(owner.tenant_id)
            .bind(Uuid::parse_str(billed["id"].as_str().unwrap()).unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(stored, billed["content"]);

    drop(router);
    db.close().await;
    let base = PgPool::connect(&std::env::var("TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
}
