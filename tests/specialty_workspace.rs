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
const SECRET: &str = "synthetic-specialty-test-secret";
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
    let schema = format!("specialty_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
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
    let owner = actor(Uuid::new_v4(), Role::Owner);
    let nurse = actor(owner.tenant_id, Role::Nurse);
    for (a, role) in [(&owner, "owner"), (&nurse, "nurse")] {
        sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,display_name,role) VALUES($1,$2,$3,'synthetic-not-login','Synthetic staff',$4)").bind(a.tenant_id).bind(a.sub).bind(format!("{}@example.test",a.sub)).bind(role).execute(&db).await.unwrap();
    }
    let patient = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-SPECIALTY','Avery','Synthetic','1990-01-01')").bind(owner.tenant_id).bind(patient).execute(&db).await.unwrap();
    (db, owner, nurse, patient)
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
#[tokio::test]
async fn owner_configuration_and_specialty_records_are_versioned_and_tenant_scoped() {
    let (db, owner, nurse, patient) = setup().await;
    let r = app(db.clone());
    let (settings_status, settings) = call(
        &r,
        &owner,
        "GET",
        "/api/v1/practice/workspace-settings",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(settings_status, StatusCode::OK);
    assert_eq!(settings["version"], 0);
    assert_eq!(settings["content"]["hidden_modules"], json!(["specialty"]));
    assert!(settings["content"].get("specialty_workspaces").is_none());
    for tab in ["functional_status", "specialty_care"] {
        assert!(!settings["content"]["chart_tabs"]
            .as_array()
            .unwrap()
            .contains(&json!(tab)));
    }
    let mut content = json!({"module_order":["practice","clinical","schedule","labs","referrals","followup","portal","specialty","billing","claims","edi","apps","migration","admin"],"hidden_modules":["labs"],"chart_tabs":["overview","profile","functional_status","specialty_care","visits"],"module_labels":{"clinical":"People & visits"},"module_groups":{"schedule":"care"}});
    for (field, invalid) in [
        ("module_labels", json!({"unknown_module":"Unexpected"})),
        ("module_labels", json!({"clinical":"  "})),
        ("module_labels", json!({"clinical":"Name\nwith control"})),
        ("module_groups", json!({"schedule":"arbitrary-script"})),
    ] {
        let mut invalid_content = content.clone();
        invalid_content[field] = invalid;
        assert_eq!(
            call(
                &r,
                &owner,
                "PUT",
                "/api/v1/practice/workspace-settings",
                json!({"content":invalid_content,"reason":"Synthetic rejected navigation"}),
                Some(0)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (status, saved) = call(
        &r,
        &owner,
        "PUT",
        "/api/v1/practice/workspace-settings",
        json!({"content":content,"reason":"Synthetic specialty configuration"}),
        Some(0),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["version"], 1);
    content["module_order"].as_array_mut().unwrap().extend(
        ["workflows", "automation", "communications", "ai_review"]
            .into_iter()
            .map(|key| json!(key)),
    );
    content["require_identity_correction_reason"] = json!(true);
    assert_eq!(saved["content"], content);
    let (read_status, reloaded) = call(
        &r,
        &owner,
        "GET",
        "/api/v1/practice/workspace-settings",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(read_status, StatusCode::OK);
    assert_eq!(
        reloaded["content"], content,
        "hidden chart tabs must stay hidden after reload"
    );
    assert_eq!(
        call(
            &r,
            &nurse,
            "PUT",
            "/api/v1/practice/workspace-settings",
            json!({"content":content,"reason":"Forbidden nurse change"}),
            Some(1)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let functional = json!({"request_id":Uuid::new_v4(),"visit_id":null,"supersedes_id":null,"content":{"mobility":"assistance","transfers":"supervision","self_care":"modified_independent","communication":"independent","falls_last_90_days":1,"assistive_devices":["Synthetic cane"],"patient_goal":"Walk safely to the synthetic mailbox","scale_name":"Synthetic mobility scale","scale_score":"4","notes":"Synthetic fixture only"},"reason":"Synthetic assessment"});
    let (status, assessment) = call(
        &r,
        &nurse,
        "POST",
        &format!("/api/v1/patients/{patient}/functional-status"),
        functional.clone(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{assessment}");
    assert_eq!(
        call(
            &r,
            &nurse,
            "POST",
            &format!("/api/v1/patients/{patient}/functional-status"),
            functional,
            None
        )
        .await
        .1,
        assessment
    );
    let care = json!({"request_id":Uuid::new_v4(),"visit_id":null,"kind":"neurotoxin","content":{"medication":"Synthetic toxin","fulfillment":"buy_and_bill","specialty_pharmacy":"","prior_authorization":"approved","authorization_reference":"SYN-AUTH-001","next_task":"Reserve synthetic inventory after human review","task_due":"2026-11-20","ndc":"00000-0000-00","hcpcs_j_code":"J0585","planned_units":100,"administered_units":0,"wasted_units":0,"lot_number":"","expiration_date":null,"follow_up_due":"2026-12-01","notes":"Synthetic only"},"reason":"Synthetic treatment plan"});
    let (status, item) = call(
        &r,
        &owner,
        "POST",
        &format!("/api/v1/patients/{patient}/specialty-care"),
        care,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{item}");
    let id = item["id"].as_str().unwrap();
    let (status, started) = call(
        &r,
        &owner,
        "POST",
        &format!("/api/v1/patients/{patient}/specialty-care/{id}/actions"),
        json!({"action":"start","reason":"Synthetic start"}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    assert_eq!(started["status"], "in_progress");
    let updated_content = json!({"medication":"Synthetic toxin","fulfillment":"buy_and_bill","specialty_pharmacy":"","prior_authorization":"approved","authorization_reference":"SYN-AUTH-001","next_task":"Human review of synthetic inventory complete","task_due":"2026-11-21","ndc":"00000-0000-00","hcpcs_j_code":"J0585","planned_units":100,"administered_units":90,"wasted_units":10,"lot_number":"SYN-LOT","expiration_date":"2027-01-01","follow_up_due":"2026-12-01","notes":"Synthetic reviewed administration"});
    let (status, updated) = call(
        &r,
        &nurse,
        "PUT",
        &format!("/api/v1/patients/{patient}/specialty-care/{id}"),
        json!({"visit_id":null,"content":updated_content,"reason":"Synthetic human review"}),
        Some(2),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["version"], 3);
    assert_eq!(updated["content"]["wasted_units"], 10);
    let (_, history) = call(
        &r,
        &owner,
        "GET",
        &format!("/api/v1/patients/{patient}/specialty-care/{id}/revisions"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(history["items"].as_array().unwrap().len(), 3);
    assert!(sqlx::query("DELETE FROM specialty_care_item_revisions")
        .execute(&db)
        .await
        .is_err());
    assert!(sqlx::query("DELETE FROM functional_status_assessments")
        .execute(&db)
        .await
        .is_err());
    db.close().await;
}

#[tokio::test]
async fn legacy_workspace_reads_preserve_storage_and_native_tabs_save_independently() {
    let (db, owner, _, _) = setup().await;
    let r = app(db.clone());
    let legacy = json!({
        "module_order": ["practice", "clinical", "schedule", "labs", "referrals", "followup", "portal", "specialty", "billing", "claims", "edi", "apps", "migration", "admin"],
        "hidden_modules": ["labs"],
        "specialty_workspaces": [],
        "chart_tabs": ["overview", "profile", "visits"]
    });
    sqlx::query("INSERT INTO practice_workspace_settings(tenant_id,version,content,updated_by) VALUES($1,7,$2,$3)")
        .bind(owner.tenant_id)
        .bind(&legacy)
        .bind(owner.sub)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO practice_workspace_setting_revisions(tenant_id,version,content,actor_id,reason) VALUES($1,7,$2,$3,'Synthetic legacy workspace')")
        .bind(owner.tenant_id)
        .bind(&legacy)
        .bind(owner.sub)
        .execute(&db)
        .await
        .unwrap();
    let before: (i64, Value, Uuid, chrono::DateTime<Utc>) = sqlx::query_as(
        "SELECT version,content,updated_by,updated_at FROM practice_workspace_settings WHERE tenant_id=$1",
    )
    .bind(owner.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    let (status, settings) = call(
        &r,
        &owner,
        "GET",
        "/api/v1/practice/workspace-settings",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{settings}");
    assert_eq!(settings["version"], 7);
    assert_eq!(
        settings["content"]["hidden_modules"],
        json!(["labs", "specialty"])
    );
    assert_eq!(settings["content"]["chart_tabs"], legacy["chart_tabs"]);
    assert!(settings["content"].get("specialty_workspaces").is_none());
    let after: (i64, Value, Uuid, chrono::DateTime<Utc>) = sqlx::query_as(
        "SELECT version,content,updated_by,updated_at FROM practice_workspace_settings WHERE tenant_id=$1",
    )
    .bind(owner.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(after, before, "reading a legacy layout must not rewrite it");
    let revision_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM practice_workspace_setting_revisions WHERE tenant_id=$1",
    )
    .bind(owner.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(revision_count, 1);

    let mut content = settings["content"].clone();
    content["hidden_modules"] = json!(["labs"]);
    for (version, tab) in [(7, "functional_status"), (8, "specialty_care")] {
        content["chart_tabs"] = json!(["overview", tab]);
        let (status, saved) = call(
            &r,
            &owner,
            "PUT",
            "/api/v1/practice/workspace-settings",
            json!({"content":content,"reason":"Synthetic independent chart configuration"}),
            Some(version),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{saved}");
        assert_eq!(saved["version"], version + 1);
        assert_eq!(saved["content"], content);
        let (status, reloaded) = call(
            &r,
            &owner,
            "GET",
            "/api/v1/practice/workspace-settings",
            Value::Null,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{reloaded}");
        assert_eq!(reloaded["version"], version + 1);
        assert_eq!(
            reloaded["content"], content,
            "the unhidden navigation and selected chart area must survive reload"
        );
    }

    let mut stale = content.clone();
    stale["chart_tabs"] = json!(["overview"]);
    assert_eq!(
        call(
            &r,
            &owner,
            "PUT",
            "/api/v1/practice/workspace-settings",
            json!({"content":stale,"reason":"Synthetic stale configuration"}),
            Some(8),
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let stored: (i64, Value) = sqlx::query_as(
        "SELECT version,content FROM practice_workspace_settings WHERE tenant_id=$1",
    )
    .bind(owner.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(stored, (9, content));
    let revision_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM practice_workspace_setting_revisions WHERE tenant_id=$1",
    )
    .bind(owner.tenant_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(revision_count, 3, "a stale save must not append a revision");
    db.close().await;
}

#[tokio::test]
async fn legacy_enabled_workspace_saves_preserve_explicit_navigation_choices() {
    let (db, owner, _, _) = setup().await;
    let r = app(db.clone());
    let (_, settings) = call(
        &r,
        &owner,
        "GET",
        "/api/v1/practice/workspace-settings",
        Value::Null,
        None,
    )
    .await;
    let mut content = settings["content"].clone();
    for (version, hidden_modules) in [(0, json!(["labs"])), (1, json!(["labs", "specialty"]))] {
        content["hidden_modules"] = hidden_modules;
        content["specialty_workspaces"] = json!(["spasticity_movement"]);
        let (status, saved) = call(
            &r,
            &owner,
            "PUT",
            "/api/v1/practice/workspace-settings",
            json!({"content":content,"reason":"Synthetic legacy enabled workspace"}),
            Some(version),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{saved}");
        content
            .as_object_mut()
            .unwrap()
            .remove("specialty_workspaces");
        assert_eq!(saved["content"], content);
        assert_eq!(saved["version"], version + 1);
        let stored: Value = sqlx::query_scalar(
            "SELECT content FROM practice_workspace_settings WHERE tenant_id=$1",
        )
        .bind(owner.tenant_id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(stored, content);
    }
    db.close().await;
}
