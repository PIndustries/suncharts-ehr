// SPDX-License-Identifier: AGPL-3.0-only
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
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
const SECRET: &str = "synthetic-workflow-proof-secret";
struct Fixture {
    db: PgPool,
    app: Router,
    actor: Actor,
    patient: Uuid,
    appointment: Uuid,
    visit: Uuid,
    instance: Uuid,
    schema: String,
    url: String,
}

async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("workflow_evidence_{}", Uuid::new_v4().simple());
    let admin = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
    let search = schema.clone();
    let db = PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |connection, _| {
            let sql = format!("SET search_path TO {search}");
            Box::pin(async move {
                sqlx::query(&sql).execute(connection).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let now = chrono::Utc::now().timestamp();
    let actor = Actor {
        sub: Uuid::new_v4(),
        tenant_id: Uuid::new_v4(),
        role: Role::Owner,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    };
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'proof@example.test','synthetic','owner')").bind(actor.tenant_id).bind(actor.sub).execute(&db).await.unwrap();
    let patient = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-PROOF','Taylor','Synthetic','1990-01-01')").bind(actor.tenant_id).bind(patient).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at) VALUES($1,$2,$3,$4,'2030-01-10T15:00:00Z','2030-01-10T15:30:00Z')").bind(actor.tenant_id).bind(appointment).bind(patient).bind(actor.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id) VALUES($1,$2,$3,$4,$5)").bind(actor.tenant_id).bind(visit).bind(patient).bind(appointment).bind(actor.sub).execute(&db).await.unwrap();
    let definition = Uuid::new_v4();
    let instance = Uuid::new_v4();
    let mut steps=suncharts_engine::workflow_evidence::RESOURCES.iter().map(|resource|json!({"key":resource.replace('_',"-"),"title":resource,"kind":"staff_task","required":true,"manual_approval":true,"native":{"resource":resource}})).collect::<Vec<_>>();
    steps.push(json!({"key":"ordinary","title":"Ordinary staff task","kind":"staff_task","manual_approval":false}));
    let content = json!({"steps":steps});
    sqlx::query("INSERT INTO care_pathway_definitions(tenant_id,id,slug,status,name,trigger_type,definition,request_id,create_request,created_by,updated_by) VALUES($1,$2,'synthetic-proof','active','Synthetic proof','appointment_created',$3,$4,'{}',$5,$5)").bind(actor.tenant_id).bind(definition).bind(&content).bind(Uuid::new_v4()).bind(actor.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO care_pathway_definition_revisions(tenant_id,definition_id,version,status,name,description,trigger_type,definition,author_id,reason) VALUES($1,$2,1,'active','Synthetic proof','','appointment_created',$3,$4,'Synthetic fixture')").bind(actor.tenant_id).bind(definition).bind(&content).bind(actor.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO care_pathway_instances(tenant_id,id,definition_id,definition_version,patient_id,appointment_id,visit_id,trigger_type,trigger_key,started_by) VALUES($1,$2,$3,1,$4,$5,$6,'appointment_created','synthetic',$7)").bind(actor.tenant_id).bind(instance).bind(definition).bind(patient).bind(appointment).bind(visit).bind(actor.sub).execute(&db).await.unwrap();
    for (index, step) in content["steps"].as_array().unwrap().iter().enumerate() {
        sqlx::query("INSERT INTO care_pathway_steps(tenant_id,instance_id,step_key,position,title,kind,required,manual_approval,state,updated_by) VALUES($1,$2,$3,$4,$3,'staff_task',true,$5,'ready',$6)").bind(actor.tenant_id).bind(instance).bind(step["key"].as_str().unwrap()).bind(index as i32).bind(step["manual_approval"].as_bool().unwrap()).bind(actor.sub).execute(&db).await.unwrap();
    }
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), "http://127.0.0.1:8099".into()).unwrap()),
    });
    Fixture {
        db,
        app,
        actor,
        patient,
        appointment,
        visit,
        instance,
        schema,
        url,
    }
}
async fn call(
    f: &Fixture,
    actor: &Actor,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        actor,
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
    let response = f
        .app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}
async fn readiness(f: &Fixture) -> Value {
    let (status, value) = call(
        f,
        &f.actor,
        "GET",
        &format!("/api/v1/care-pathways/instances/{}/readiness", f.instance),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}
fn proof<'a>(value: &'a Value, key: &str) -> &'a Value {
    value["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|step| step["step_key"] == key)
        .unwrap()
}
async fn action(
    f: &Fixture,
    key: &str,
    action: &str,
    evidence: Value,
    version: i64,
) -> (StatusCode, Value) {
    call(
        f,
        &f.actor,
        "POST",
        &format!(
            "/api/v1/care-pathways/instances/{}/steps/{key}/actions",
            f.instance
        ),
        json!({"action":action,"reason":"Synthetic native proof review","evidence":evidence}),
        Some(version),
    )
    .await
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

#[tokio::test]
async fn native_proof_is_rechecked_and_cannot_be_forged_or_cross_patient() {
    let f = setup().await;
    let view = readiness(&f).await;
    assert_eq!(proof(&view, "check-in")["status"], "pending");
    assert_eq!(
        proof(&view, "appointment-booked")["ready"],
        false,
        "an unrelated native appointment is not workflow booking proof"
    );
    assert_eq!(
        action(
            &f,
            "check-in",
            "complete",
            json!({"ready":true,"status":"checked_in","native":{"resource_id":f.appointment}}),
            1
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let other_patient = Uuid::new_v4();
    let other_appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-OTHER','Other','Synthetic','1990-01-01')").bind(f.actor.tenant_id).bind(other_patient).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2030-01-10T16:00Z','2030-01-10T16:30Z','checked_in')").bind(f.actor.tenant_id).bind(other_appointment).bind(other_patient).bind(f.actor.sub).execute(&f.db).await.unwrap();
    assert_eq!(
        action(
            &f,
            "check-in",
            "complete",
            json!({"native_resource_id":other_appointment}),
            1
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE appointments SET status='checked_in',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(f.actor.tenant_id).bind(f.appointment).execute(&f.db).await.unwrap();
    let (status, body) = action(
        &f,
        "check-in",
        "complete",
        json!({"status":"fabricated"}),
        1,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let saved = body["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|step| step["step_key"] == "check-in")
        .unwrap();
    assert_eq!(saved["state"], "awaiting_approval");
    assert_eq!(
        saved["evidence"]["native"]["resource_id"],
        f.appointment.to_string()
    );
    assert!(saved["evidence"].get("status").is_none());
    sqlx::query(
        "UPDATE appointments SET status='cancelled',version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.actor.tenant_id)
    .bind(f.appointment)
    .execute(&f.db)
    .await
    .unwrap();
    assert_eq!(
        action(&f, "check-in", "approve", json!({}), 2).await.0,
        StatusCode::CONFLICT,
        "approval must recheck native state"
    );
    sqlx::query("UPDATE appointments SET status='checked_in',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(f.actor.tenant_id).bind(f.appointment).execute(&f.db).await.unwrap();
    assert_eq!(
        action(&f, "check-in", "approve", json!({}), 2).await.0,
        StatusCode::OK
    );
    assert_eq!(
        action(&f, "signed-visit", "complete", json!({"signed":true}), 1)
            .await
            .0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE visits SET status='signed',signed_by=$3,signed_at=now(),note='{}',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(f.actor.tenant_id).bind(f.visit).bind(f.actor.sub).execute(&f.db).await.unwrap();
    assert_eq!(
        action(&f, "signed-visit", "complete", json!({}), 1).await.0,
        StatusCode::OK
    );
    assert_eq!(
        action(&f, "signed-visit", "approve", json!({}), 2).await.0,
        StatusCode::OK
    );
    let ordinary = action(
        &f,
        "ordinary",
        "complete",
        json!({"staff_note":"Reviewed synthetic task"}),
        1,
    )
    .await;
    assert_eq!(ordinary.0, StatusCode::OK, "{}", ordinary.1);
    let mut other = f.actor.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(
            &f,
            &other,
            "GET",
            &format!("/api/v1/care-pathways/instances/{}/readiness", f.instance),
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    for id in [first, second] {
        sqlx::query("INSERT INTO functional_status_assessments(tenant_id,patient_id,id,request_id,create_request,visit_id,content,recorded_by,reason) VALUES($1,$2,$3,$4,'{}',$5,'{}',$6,'Synthetic functional record')").bind(f.actor.tenant_id).bind(f.patient).bind(id).bind(Uuid::new_v4()).bind(f.visit).bind(f.actor.sub).execute(&f.db).await.unwrap();
    }
    let view = readiness(&f).await;
    assert_eq!(proof(&view, "functional-status")["status"], "ambiguous");
    assert_eq!(
        action(&f, "functional-status", "complete", json!({}), 1)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        action(
            &f,
            "functional-status",
            "complete",
            json!({"native_resource_id":first}),
            1
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        action(
            &f,
            "functional-status",
            "approve",
            json!({"native_resource_id":second}),
            2
        )
        .await
        .0,
        StatusCode::CONFLICT,
        "approval cannot replace the submitted native record with another valid record"
    );
    assert_eq!(
        action(&f, "functional-status", "reopen", json!({}), 2)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        action(
            &f,
            "functional-status",
            "complete",
            json!({"native_resource_id":second}),
            3
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        action(&f, "functional-status", "approve", json!({}), 4)
            .await
            .0,
        StatusCode::OK
    );
    cleanup(f).await;
}

#[tokio::test]
async fn eligibility_and_intake_require_exact_native_context_and_permission() {
    let f = setup().await;
    let payer = Uuid::new_v4();
    let coverage = Uuid::new_v4();
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,'{}',$3,'synthetic')").bind(f.actor.tenant_id).bind(payer).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,'{}',$5,'synthetic')").bind(f.actor.tenant_id).bind(coverage).bind(f.patient).bind(payer).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    let wrong_date = Uuid::new_v4();
    let exact = Uuid::new_v4();
    for (id, date) in [(wrong_date, "2029-12-01"), (exact, "2030-01-10")] {
        sqlx::query("INSERT INTO claimmd_eligibility_checks(tenant_id,id,patient_id,coverage_id,request_id,creation_hash,route_key,request_snapshot,response_snapshot,status,actor_id,completed_at) VALUES($1,$2,$3,$4,$5,'synthetic','synthetic',$6,$7,'completed',$8,now())").bind(f.actor.tenant_id).bind(id).bind(f.patient).bind(coverage).bind(Uuid::new_v4()).bind(json!({"request":{"service_date":date}})).bind(json!({"elig":[{"coverage":"inactive"}]})).bind(f.actor.sub).execute(&f.db).await.unwrap();
    }
    assert_eq!(
        action(
            &f,
            "eligibility",
            "complete",
            json!({"native_resource_id":wrong_date}),
            1
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let view = readiness(&f).await;
    assert_eq!(
        proof(&view, "eligibility")["resource_id"],
        exact.to_string()
    );
    assert_eq!(proof(&view, "eligibility")["ready"], true);
    assert!(proof(&view, "eligibility")["reason"]
        .as_str()
        .unwrap()
        .contains("does not establish active benefits"));
    let packet = Uuid::new_v4();
    sqlx::query("INSERT INTO previsit_intake_packets(tenant_id,id,appointment_id,patient_id,template_id,template_version,template_snapshot,access_token_hash,status,due_at,issued_by,submitted_at,reviewed_at,reviewed_by,workflow_instance_id,workflow_step_key,workflow_definition_version) VALUES($1,$2,$3,$4,NULL,1,'{}',$5,'reviewed',now(),$6,now(),now(),$6,$7,'intake-reviewed',1)")
        .bind(f.actor.tenant_id).bind(packet).bind(f.appointment).bind(f.patient).bind("1".repeat(64)).bind(f.actor.sub).bind(f.instance).execute(&f.db).await.unwrap();
    let view = readiness(&f).await;
    assert_eq!(proof(&view, "intake-reviewed")["ready"], true);
    assert_eq!(
        action(&f, "intake-reviewed", "complete", json!({}), 1)
            .await
            .0,
        StatusCode::OK
    );
    let clinician = Uuid::new_v4();
    let policy = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'restricted-proof@example.test','synthetic','clinician')").bind(f.actor.tenant_id).bind(clinician).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Restricted proof','clinician',$3,$4)").bind(f.actor.tenant_id).bind(policy).bind(json!({"workflows":{"view":true,"create":true,"edit":true,"delete":true},"clinical":{"view":true}})).bind(f.actor.sub).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)").bind(f.actor.tenant_id).bind(clinician).bind(policy).bind(f.actor.sub).execute(&f.db).await.unwrap();
    let mut restricted = f.actor.clone();
    restricted.sub = clinician;
    restricted.role = Role::Clinician;
    let (status, view) = call(
        &f,
        &restricted,
        "GET",
        &format!("/api/v1/care-pathways/instances/{}/readiness", f.instance),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(proof(&view, "eligibility")["status"], "forbidden");
    assert!(proof(&view, "eligibility").get("resource_id").is_none());
    assert_eq!(
        call(
            &f,
            &restricted,
            "POST",
            &format!(
                "/api/v1/care-pathways/instances/{}/steps/eligibility/actions",
                f.instance
            ),
            json!({"action":"complete","reason":"Synthetic policy boundary","evidence":{}}),
            Some(1)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    cleanup(f).await;
}

#[tokio::test]
async fn payment_and_claim_proof_require_native_receipts_not_open_checkout_or_claim_flags() {
    let f = setup().await;
    let account = Uuid::new_v4();
    let setting = Uuid::new_v4();
    let payment = Uuid::new_v4();
    let entry = Uuid::new_v4();
    sqlx::query("INSERT INTO billing_accounts(tenant_id,id,patient_id,visit_id,content,total_cents,status,request_id,creation_hash) VALUES($1,$2,$3,$4,'{}',1000,'posted',$5,'synthetic')")
        .bind(f.actor.tenant_id).bind(account).bind(f.patient).bind(f.visit).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO payment_settings(tenant_id,id,mode) VALUES($1,$2,'own_stripe')")
        .bind(f.actor.tenant_id)
        .bind(setting)
        .execute(&f.db)
        .await
        .unwrap();
    // Inert synthetic credential bytes satisfy the FK; no provider is called.
    sqlx::query("INSERT INTO payment_credentials(tenant_id,setting_id,revision,encrypted_config) VALUES($1,$2,1,$3)").bind(f.actor.tenant_id).bind(setting).bind(vec![0u8;32]).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO payment_attempts(tenant_id,id,account_id,setting_id,credential_revision,request_id,creation_hash,requested_by,amount_cents,status,provider_mode,provider_account_id) VALUES($1,$2,$3,$4,1,$5,'synthetic',$6,500,'open','own_stripe','synthetic-account')")
        .bind(f.actor.tenant_id).bind(payment).bind(account).bind(setting).bind(Uuid::new_v4()).bind(f.actor.sub).execute(&f.db).await.unwrap();
    let view = readiness(&f).await;
    assert_eq!(proof(&view, "payment")["ready"], false);
    assert_eq!(
        action(&f, "payment", "complete", json!({"paid":true}), 1)
            .await
            .0,
        StatusCode::CONFLICT
    );
    sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id) VALUES($1,$2,$3,'payment',-500,$4,$5,'synthetic',$6)")
        .bind(f.actor.tenant_id).bind(entry).bind(account).bind(json!({"managed_payment_id":payment})).bind(Uuid::new_v4()).bind(f.actor.sub).execute(&f.db).await.unwrap();
    sqlx::query("UPDATE payment_attempts SET status='paid',paid_entry_id=$3,provider_payment_intent='pi_synthetic',provider_charge_id='ch_synthetic',version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(f.actor.tenant_id).bind(payment).bind(entry).execute(&f.db).await.unwrap();
    let view = readiness(&f).await;
    assert_eq!(proof(&view, "payment")["ready"], true);
    assert_eq!(proof(&view, "payment")["test_mode"], true);
    assert_eq!(
        action(&f, "payment", "complete", json!({}), 1).await.0,
        StatusCode::OK
    );
    sqlx::query("UPDATE payment_attempts SET refunded_cents=100,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(f.actor.tenant_id).bind(payment).execute(&f.db).await.unwrap();
    assert_eq!(
        action(&f, "payment", "approve", json!({}), 2).await.0,
        StatusCode::CONFLICT,
        "refund invalidates the earlier payment proof"
    );
    let payer = Uuid::new_v4();
    let claim = Uuid::new_v4();
    let partner = Uuid::new_v4();
    let submission = Uuid::new_v4();
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,'{}',$3,'synthetic')").bind(f.actor.tenant_id).bind(payer).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO ehr_claims(tenant_id,id,patient_id,account_id,payer_id,control_number,frequency,content,snapshot,status,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,'SYN-PROOF-CLAIM','original','{}','{}','ready',$6,'synthetic')")
        .bind(f.actor.tenant_id).bind(claim).bind(f.patient).bind(account).bind(payer).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    let view = readiness(&f).await;
    assert_eq!(proof(&view, "claim-review")["ready"], true);
    assert_eq!(proof(&view, "claim-submitted")["ready"], false);
    assert_eq!(proof(&view, "claim-accepted")["ready"], false);
    sqlx::query(
        "UPDATE ehr_claims SET status='accepted',version=version+1 WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.actor.tenant_id)
    .bind(claim)
    .execute(&f.db)
    .await
    .unwrap();
    assert_eq!(
        proof(&readiness(&f).await, "claim-accepted")["ready"],
        false,
        "manual claim status alone is not payer acceptance evidence"
    );
    sqlx::query("INSERT INTO edi_partners(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,'{}',$3,'synthetic')").bind(f.actor.tenant_id).bind(partner).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO edi_submissions(tenant_id,id,claim_id,partner_id,claim_version,partner_version,claim_snapshot,partner_snapshot,details,payload,payload_hash,interchange_control,group_control,transaction_control,status,request_id,creation_hash) VALUES($1,$2,$3,$4,1,1,'{}','{}','{}','synthetic','synthetic','SYN-1','SYN-1','SYN-1','delivered',$5,'synthetic')")
        .bind(f.actor.tenant_id).bind(submission).bind(claim).bind(partner).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    let view = readiness(&f).await;
    assert_eq!(proof(&view, "claim-submitted")["ready"], true);
    assert_eq!(proof(&view, "claim-accepted")["ready"], false);
    sqlx::query("UPDATE edi_submissions SET payer_outcome='accepted',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(f.actor.tenant_id).bind(submission).execute(&f.db).await.unwrap();
    assert_eq!(proof(&readiness(&f).await, "claim-accepted")["ready"], true);
    assert_eq!(
        action(&f, "claim-accepted", "complete", json!({}), 1)
            .await
            .0,
        StatusCode::OK
    );
    cleanup(f).await;
}
