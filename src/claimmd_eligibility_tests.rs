// SPDX-License-Identifier: AGPL-3.0-only
use super::*;
use std::sync::{Arc, Mutex};
#[tokio::test]
async fn loopback_rejection_is_retained_without_sensitive_text_or_duplicate_requests() {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("eligibility_evidence_{}", Uuid::new_v4().simple());
    let scoped = schema.clone();
    let admin = PgPool::connect(&url).await.unwrap();
    crate::test_db::create_schema(&admin, &schema).await;
    admin.close().await;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(6)
        .after_connect(move |c, _| {
            let query = format!("SET search_path TO {scoped}");
            Box::pin(async move {
                sqlx::query(&query).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    crate::MIGRATOR.run(&pool).await.unwrap();
    let tenant = Uuid::new_v4();
    let patient = Uuid::new_v4();
    let payer = Uuid::new_v4();
    let coverage = Uuid::new_v4();
    let actor = Actor {
        sub: Uuid::new_v4(),
        tenant_id: tenant,
        role: crate::auth::Role::Owner,
        patient_id: None,
        iss: "synthetic".into(),
        aud: "synthetic".into(),
        iat: 0,
        exp: i64::MAX,
    };
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-ELIG','Synthetic','Patient','1980-01-01')").bind(tenant).bind(patient).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,$3,$2,'synthetic')").bind(tenant).bind(payer).bind(json!({"name":"Synthetic payer","payer_code":"SYN"})).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,$2,'synthetic')").bind(tenant).bind(coverage).bind(patient).bind(payer).bind(json!({"relationship":"self","member_id":"SYNTHETIC-MEMBER","status":"active"})).execute(&pool).await.unwrap();
    let state = State {
        backend: Arc::new(crate::postgres::PostgresBackend(pool.clone())),
        secret: "synthetic-eligibility-secret".into(),
        allow_legacy_gateway: false,
        issuer: "synthetic".into(),
        audience: "synthetic".into(),
        browser: Some(
            crate::browser::BrowserAuth::new(pool.clone(), "http://127.0.0.1:8099".into()).unwrap(),
        ),
    };
    let received = Arc::new(Mutex::new(
        Vec::<std::collections::HashMap<String, String>>::new(),
    ));
    let output = received.clone();
    let service=Router::new().route("/services/eligdata/",axum::routing::post(move|axum::Form(fields):axum::Form<std::collections::HashMap<String,String>>|{let output=output.clone();async move{output.lock().unwrap().push(fields);Json(json!({"error":[{"error_code":"42","error_message":"Synthetic patient-name 000000001 synthetic-loopback-key"}]}))}}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, service).await.unwrap() });
    let route = Route {
        key: "synthetic-eligibility".into(),
        tenant_id: tenant,
        partner_id: Uuid::new_v4(),
        endpoint: format!("http://{address}/services/upload/"),
        usage: "T".into(),
        credential_env: None,
        credential_value: None,
        loopback_test: true,
        adapter: Adapter::ClaimMd,
        retrieval: None,
        sftp: None,
    };
    let request = super::tests::request();
    let request_id = request.request_id;
    let replay: EligibilityRequest =
        serde_json::from_value(serde_json::to_value(&request).unwrap()).unwrap();
    assert!(run_with_route(
        &state,
        &actor,
        patient,
        coverage,
        request,
        Some(route.clone())
    )
    .await
    .is_err());
    let saved:Value=sqlx::query_scalar("SELECT jsonb_build_object('status',status,'request_snapshot',request_snapshot,'response_snapshot',response_snapshot) FROM claimmd_eligibility_checks WHERE tenant_id=$1 AND request_id=$2").bind(tenant).bind(request_id).fetch_one(&pool).await.unwrap();
    assert_eq!(saved["status"], "failed");
    assert_eq!(
        saved["response_snapshot"],
        json!({"failure":{"kind":"provider_rejected","http_status":200,"provider_codes":["42"],"provider_hints":["key","name","patient"]}})
    );
    assert_eq!(
        saved["request_snapshot"]["request"]["provider_taxid"],
        "*****0001"
    );
    assert!(!saved.to_string().contains("000000001"));
    assert!(!saved.to_string().contains("synthetic-loopback-key"));
    assert_eq!(
        received.lock().unwrap()[0]["prov_taxid"],
        "000000001",
        "only the provider POST receives the full tax identity"
    );
    assert!(
        run_with_route(&state, &actor, patient, coverage, replay, Some(route))
            .await
            .is_err()
    );
    assert_eq!(
        received.lock().unwrap().len(),
        1,
        "failed request replay never resends to payer"
    );
    let events: Vec<String> = sqlx::query_scalar(
        "SELECT status FROM claimmd_eligibility_events WHERE tenant_id=$1 ORDER BY created_at,status",
    )
    .bind(tenant)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(events, vec!["pending", "failed"]);
    server.abort();
    pool.close().await;
    let admin = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
