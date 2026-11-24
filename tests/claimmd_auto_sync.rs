// SPDX-License-Identifier: AGPL-3.0-only
//! Automatic Claim.MD modification and note refresh against a loopback stand-in.
use axum::{routing::post, Json, Router};
use serde_json::json;
use sqlx::{postgres::PgPoolOptions, PgPool};
use suncharts_engine::{
    claimmd_operations,
    delivery::{Adapter, Route},
};
use uuid::Uuid;

#[tokio::test]
async fn automatic_pass_saves_changes_and_notes_once() {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("auto_sync_{}", Uuid::new_v4().simple());
    let scoped = schema.clone();
    let admin = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&admin, &schema).await;
    let pool = PgPoolOptions::new()
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
    suncharts_engine::MIGRATOR.run(&pool).await.unwrap();
    let tenant = Uuid::new_v4();
    let partner = Uuid::new_v4();
    let setting = Uuid::new_v4();
    sqlx::query("INSERT INTO edi_partners(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,$3,$2,'synthetic')")
        .bind(tenant).bind(partner).bind(json!({"name":"Synthetic Claim.MD"})).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO edi_provider_settings(tenant_id,id,partner_id,provider,usage,label,encrypted_key,credential_fingerprint,start_at,response_id,interval_seconds,enabled,verified) VALUES($1,$2,$3,'claim_md','T','Synthetic loopback',repeat('s',32)::bytea,$4,clock_timestamp(),'0',30,true,true)")
        .bind(tenant).bind(setting).bind(partner).bind(Uuid::new_v4().to_string()).execute(&pool).await.unwrap();

    // The stand-in answers only with what comes after the position it is asked for.
    let service = Router::new()
        .route(
            "/services/modify/",
            post(|axum::Form(f): axum::Form<std::collections::HashMap<String, String>>| async move {
                if f.get("ModID").map(String::as_str) == Some("0") {
                    Json(json!({"LastModid":"501","claim":[{"claimmd_id":"135961467","claimid":"123ABC","pcn":"ACNT456","modification":[
                        {"modid":"500","field":"Billing NPI","was":"1","value":"2","mod_time":"2021-03-19 11:20:48am","username":"Staff One"},
                        {"modid":"501","field":"Payer ID","was":"A","value":"B","mod_time":"2021-03-19 11:21:48am","username":"Staff One"}]}]}))
                } else {
                    Json(json!({"LastModid":"501"}))
                }
            }),
        )
        .route(
            "/services/notes/",
            post(|axum::Form(f): axum::Form<std::collections::HashMap<String, String>>| async move {
                if f.get("NoteID").map(String::as_str) == Some("0") {
                    Json(json!({"LastNoteID":"900","notes":[{"note":"Reviewed.","claimmd_id":"135961467","claimid":"123ABC","username":"Staff One","date_time":"2021-03-19 11:20:48am","noteid":"900","pcn":"ACNT456"}]}))
                } else {
                    Json(json!({"LastNoteID":"900"}))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, service).await.unwrap() });
    let route = Route {
        key: format!("synthetic-auto-{}", Uuid::new_v4().simple()),
        tenant_id: tenant,
        partner_id: partner,
        endpoint: format!("http://{address}/services/upload/"),
        usage: "T".into(),
        credential_env: None,
        credential_value: None,
        loopback_test: true,
        adapter: Adapter::ClaimMd,
        retrieval: None,
        sftp: None,
    };

    claimmd_operations::auto_sync_setting(&pool, tenant, setting, &route)
        .await
        .unwrap();
    let count = |kind: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM claimmd_operation_records WHERE tenant_id=$1 AND setting_id=$2 AND kind=$3")
                .bind(tenant).bind(setting).bind(kind).fetch_one(&pool).await.unwrap()
        }
    };
    assert_eq!(count("modification").await, 2);
    assert_eq!(count("note").await, 1);
    let cursors: (String, String) = sqlx::query_as("SELECT modification_id,note_id FROM claimmd_operation_cursors WHERE tenant_id=$1 AND setting_id=$2")
        .bind(tenant).bind(setting).fetch_one(&pool).await.unwrap();
    assert_eq!(cursors, ("501".to_string(), "900".to_string()));

    claimmd_operations::auto_sync_setting(&pool, tenant, setting, &route)
        .await
        .unwrap();
    assert_eq!(count("modification").await, 2);
    assert_eq!(count("note").await, 1);

    server.abort();
    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
