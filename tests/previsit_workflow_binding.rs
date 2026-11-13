// SPDX-License-Identifier: AGPL-3.0-only
//! Synthetic version-pinned workflow forms and explicitly reviewed chart handoff.
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
    actor: Uuid,
    patient: Uuid,
    definition: Uuid,
    instance: Uuid,
    cookie: String,
    other_cookie: String,
    schema: String,
    url: String,
}
async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("workflow_intake_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
    let search = schema.clone();
    let db = PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |connection, _| {
            let command = format!("SET search_path TO {search}");
            Box::pin(async move {
                sqlx::query(&command).execute(connection).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let (tenant, actor, patient, appointment, definition, instance) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let cookie = session(&db, tenant, actor, "clinician").await;
    let other_cookie = session(&db, Uuid::new_v4(), Uuid::new_v4(), "owner").await;
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-FORM','Taylor','Synthetic','1990-01-01')").bind(tenant).bind(patient).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at) VALUES($1,$2,$3,$4,now()+interval '1 day',now()+interval '1 day 30 minutes')").bind(tenant).bind(appointment).bind(patient).bind(actor).execute(&db).await.unwrap();
    let form = json!({"key":"contact-form","title":"Synthetic contact form","kind":"patient_form","form_fields":[
     {"key":"nickname","label":"Preferred name","field_type":"short_text","required":true,"chart_target":"demographics.preferred_name"},
     {"key":"gender","label":"Administrative gender","field_type":"choice","options":["female","male","other","unknown"],"chart_target":"demographics.administrative_gender"},
     {"key":"history","label":"Patient history","field_type":"long_text"},
     {"key":"day","label":"Date","field_type":"date"},
     {"key":"score","label":"Score","field_type":"number"},
     {"key":"agree","label":"Acknowledgement","field_type":"checkbox","required":true}
    ]});
    let mut second = form.clone();
    second["key"] = json!("second-form");
    let content = json!({"steps":[form,second]});
    sqlx::query("INSERT INTO care_pathway_definitions(tenant_id,id,slug,status,name,trigger_type,definition,request_id,create_request,created_by,updated_by) VALUES($1,$2,'synthetic-form','active','Synthetic workflow','manual',$3,$4,'{}',$5,$5)").bind(tenant).bind(definition).bind(&content).bind(Uuid::new_v4()).bind(actor).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO care_pathway_definition_revisions(tenant_id,definition_id,version,status,name,description,trigger_type,definition,author_id,reason) VALUES($1,$2,1,'active','Synthetic workflow','','manual',$3,$4,'Synthetic setup')").bind(tenant).bind(definition).bind(content).bind(actor).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO care_pathway_instances(tenant_id,id,definition_id,definition_version,patient_id,appointment_id,trigger_type,trigger_key,started_by) VALUES($1,$2,$3,1,$4,$5,'manual','synthetic-run',$6)").bind(tenant).bind(instance).bind(definition).bind(patient).bind(appointment).bind(actor).execute(&db).await.unwrap();
    for (position, key) in ["contact-form", "second-form"].iter().enumerate() {
        sqlx::query("INSERT INTO care_pathway_steps(tenant_id,instance_id,step_key,position,title,kind,required,manual_approval,state,updated_by) VALUES($1,$2,$3,$4,'Synthetic form','patient_form',true,false,'ready',$5)").bind(tenant).bind(instance).bind(key).bind(position as i32).bind(actor).execute(&db).await.unwrap();
    }
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: "synthetic-intake-secret".into(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
    });
    Fixture {
        db,
        app,
        tenant,
        actor,
        patient,
        definition,
        instance,
        cookie,
        other_cookie,
        schema,
        url,
    }
}
async fn session(db: &PgPool, tenant: Uuid, user: Uuid, role: &str) -> String {
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role,display_name) VALUES($1,$2,$3,'synthetic-no-password',$4,'Synthetic form reviewer')").bind(tenant).bind(user).bind(format!("{user}@example.test")).bind(role).execute(db).await.unwrap();
    let token = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at,auth_method) VALUES($1,$2,$3,now()+interval '1 hour','break_glass')").bind(format!("{:x}",Sha256::digest(token.as_bytes()))).bind(tenant).bind(user).execute(db).await.unwrap();
    format!("sce_session={token}")
}
async fn call(
    f: &Fixture,
    cookie: Option<&str>,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Content-Type", "application/json")
        .header("Origin", ORIGIN);
    if let Some(cookie) = cookie {
        request = request.header("Cookie", cookie);
    }
    if let Some(version) = version {
        request = request.header("If-Match", format!("\"{version}\""));
    }
    let response = f
        .app
        .clone()
        .oneshot(
            request
                .body(if method == "GET" {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn issue_path(f: &Fixture, step: &str) -> String {
    format!(
        "/api/v1/care-pathways/instances/{}/steps/{step}/intake-packet",
        f.instance
    )
}
async fn cleanup(f: Fixture) {
    f.db.close().await;
    let db = PgPool::connect(&f.url).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", f.schema))
        .execute(&db)
        .await
        .unwrap();
    db.close().await;
}
fn answers() -> Value {
    json!({"nickname":"Tay","gender":"other","history":"Patient reported synthetic history","day":"2026-11-01","score":"1.5","agree":true})
}
async fn issue(f: &Fixture, step: &str) -> (Uuid, String) {
    let (status, value) = call(
        f,
        Some(&f.cookie),
        "POST",
        &issue_path(f, step),
        json!({"reason":"Issue saved workflow form"}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{value}");
    (
        value["packet_id"].as_str().unwrap().parse().unwrap(),
        value["intake_url"]
            .as_str()
            .unwrap()
            .split("token=")
            .nth(1)
            .unwrap()
            .to_owned(),
    )
}
async fn submit(f: &Fixture, token: &str, response: Value) -> (StatusCode, Value) {
    call(f,None,"POST","/api/public/v1/intake/submit",json!({"token":token,"response":response,"attested_name":"Taylor Synthetic","attested":true}),None).await
}
#[tokio::test]
async fn workflow_form_is_pinned_bound_reviewed_and_explicitly_promoted() {
    let f = setup().await;
    assert_eq!(
        call(
            &f,
            Some(&f.other_cookie),
            "POST",
            &issue_path(&f, "contact-form"),
            json!({"reason":"Wrong tenant"}),
            Some(1)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (packet, token) = issue(&f, "contact-form").await;
    let (_, retry) = call(
        &f,
        Some(&f.cookie),
        "POST",
        &issue_path(&f, "contact-form"),
        json!({"reason":"Retry same form"}),
        Some(1),
    )
    .await;
    assert_eq!(retry["packet_id"], packet.to_string());
    assert!(retry["intake_url"].is_null());
    let (second, _) = issue(&f, "second-form").await;
    assert_ne!(packet, second);
    sqlx::query("UPDATE care_pathway_definitions SET version=2,definition=jsonb_set(definition,'{steps,0,form_fields,0,label}','\"Changed after issuing\"') WHERE tenant_id=$1 AND id=$2").bind(f.tenant).bind(f.definition).execute(&f.db).await.unwrap();
    let (status, public) = call(
        &f,
        None,
        "POST",
        "/api/public/v1/intake/read",
        json!({"token":token}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{public}");
    assert_eq!(
        public["template"]["sections"][0]["fields"][0]["label"],
        "Preferred name"
    );
    let mut bad = answers();
    bad["agree"] = json!("true");
    assert_eq!(submit(&f, &token, bad).await.0, StatusCode::BAD_REQUEST);
    let mut bad = answers();
    bad["gender"] = json!("not-an-option");
    assert_eq!(submit(&f, &token, bad).await.0, StatusCode::BAD_REQUEST);
    let mut bad = answers();
    bad["score"] = json!("NaN");
    assert_eq!(submit(&f, &token, bad).await.0, StatusCode::BAD_REQUEST);
    let (status, submitted) = submit(&f, &token, answers()).await;
    assert_eq!(status, StatusCode::OK, "{submitted}");
    assert_eq!(submitted["version"], 2);
    let detail_path = format!("/api/v1/previsit/packets/{packet}");
    let promotion_path = format!("{detail_path}/demographics");
    assert_eq!(
        call(
            &f,
            Some(&f.other_cookie),
            "GET",
            &detail_path,
            json!({}),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let input =
        json!({"fields":["nickname"],"demographics_version":0,"reason":"Reviewed selected answer"});
    assert_eq!(
        call(
            &f,
            Some(&f.cookie),
            "POST",
            &promotion_path,
            input.clone(),
            Some(2)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &f,
            Some(&f.cookie),
            "POST",
            &format!("{detail_path}/review"),
            json!({}),
            Some(1)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (status, reviewed) = call(
        &f,
        Some(&f.cookie),
        "POST",
        &format!("{detail_path}/review"),
        json!({}),
        Some(2),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reviewed}");
    assert_eq!(reviewed["version"], 3);
    let (status, detail) = call(&f, Some(&f.cookie), "GET", &detail_path, json!({}), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["workflow_instance_id"], f.instance.to_string());
    assert_eq!(detail["workflow_definition_version"], 1);
    assert!(!detail.to_string().contains(&token));
    let (state,evidence):(String,Value)=sqlx::query_as("SELECT state,evidence FROM care_pathway_steps WHERE tenant_id=$1 AND instance_id=$2 AND step_key='contact-form'").bind(f.tenant).bind(f.instance).fetch_one(&f.db).await.unwrap();
    assert_eq!(state, "in_progress");
    assert_eq!(evidence["packet_status"], "reviewed");
    assert_eq!(evidence["packet_id"], packet.to_string());
    assert_eq!(
        call(
            &f,
            Some(&f.cookie),
            "POST",
            &promotion_path,
            json!({"fields":["history"],"demographics_version":0,"reason":"Unsupported mapping"}),
            Some(3)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (status, saved) = call(
        &f,
        Some(&f.cookie),
        "POST",
        &promotion_path,
        input.clone(),
        Some(3),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["content"]["preferred_name"], "Tay");
    assert!(saved["content"]["administrative_gender"].is_null());
    assert_eq!(
        call(&f, Some(&f.cookie), "POST", &promotion_path, input, Some(3))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let history:Value=sqlx::query_scalar("SELECT content FROM patient_demographics_history WHERE tenant_id=$1 AND patient_id=$2 AND version=1").bind(f.tenant).bind(f.patient).fetch_one(&f.db).await.unwrap();
    assert_eq!(history["preferred_name"], "Tay");
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM previsit_events WHERE tenant_id=$1 AND packet_id=$2 AND action='intake_demographics_promoted'").bind(f.tenant).bind(packet).fetch_one(&f.db).await.unwrap();
    assert_eq!(count, 1);
    // A reviewed form answers a patient like any other link that no longer works.
    assert_eq!(submit(&f, &token, answers()).await.0, StatusCode::NOT_FOUND);
    cleanup(f).await;
}
#[tokio::test]
async fn cancelled_forms_and_denied_chart_edits_fail_before_mutation() {
    let f = setup().await;
    let (packet, token) = issue(&f, "contact-form").await;
    assert_eq!(submit(&f, &token, answers()).await.0, StatusCode::OK);
    assert_eq!(
        call(
            &f,
            Some(&f.cookie),
            "POST",
            &format!("/api/v1/previsit/packets/{packet}/review"),
            json!({}),
            Some(2)
        )
        .await
        .0,
        StatusCode::OK
    );
    let policy = Uuid::new_v4();
    let mut flags = json!({});
    for key in ["clinical", "scheduling", "workflows", "events"] {
        flags[key] = json!({"view":true,"create":true,"edit":true,"delete":true});
    }
    flags["clinical"]["edit"] = json!(false);
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Synthetic form limits','clinician',$3,$4)").bind(f.tenant).bind(policy).bind(flags).bind(f.actor).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$2)").bind(f.tenant).bind(f.actor).bind(policy).execute(&f.db).await.unwrap();
    assert_eq!(
        call(
            &f,
            Some(&f.cookie),
            "POST",
            &format!("/api/v1/previsit/packets/{packet}/demographics"),
            json!({"fields":["nickname"],"demographics_version":0,"reason":"Denied native edit"}),
            Some(3)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM patient_demographics WHERE tenant_id=$1 AND patient_id=$2"
        )
        .bind(f.tenant)
        .bind(f.patient)
        .fetch_one(&f.db)
        .await
        .unwrap(),
        0
    );
    let (_, second_token) = issue(&f, "second-form").await;
    sqlx::query("UPDATE care_pathway_instances SET status='cancelled',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(f.tenant).bind(f.instance).execute(&f.db).await.unwrap();
    assert_eq!(
        submit(&f, &second_token, answers()).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &f,
            None,
            "POST",
            "/api/public/v1/intake/read",
            json!({"token":second_token}),
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    cleanup(f).await;
}
