// SPDX-License-Identifier: AGPL-3.0-only
//! The patient banner endpoint: scoping, what each role receives, and which appointment and
//! eligibility check it picks. Synthetic data only.
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

const SECRET: &str = "synthetic-banner-test-secret";
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
async fn user(db: &PgPool, a: &Actor, role: &str) {
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login',$4,false)").bind(a.sub).bind(a.tenant_id).bind(format!("{}@example.test",a.sub.simple())).bind(role).execute(db).await.unwrap();
}
async fn patient(db: &PgPool, tenant: Uuid, mrn: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Avery','Synthetic','1990-01-01')").bind(tenant).bind(id).bind(mrn).execute(db).await.unwrap();
    id
}
async fn setup() -> (PgPool, Actor, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("patient_banner_test_{}", Uuid::new_v4().simple());
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
    let owner = actor(Uuid::new_v4(), Role::Owner);
    user(&db, &owner, "owner").await;
    let p = patient(&db, owner.tenant_id, "SYN-BANNER").await;
    (db, owner, p)
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
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&body)
            .unwrap_or_else(|_| json!({"message":String::from_utf8_lossy(&body)})),
    )
}
async fn banner(r: &Router, a: &Actor, p: Uuid) -> Value {
    let (status, value) = call(
        r,
        a,
        "GET",
        &format!("/api/v1/patients/{p}/banner"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}
/// An appointment `offset` minutes from now (negative is in the past), 30 minutes long.
async fn appointment(
    db: &PgPool,
    a: &Actor,
    p: Uuid,
    offset: i64,
    status: &str,
    title: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status,title) VALUES($1,$2,$3,$4,now()+make_interval(mins=>$5),now()+make_interval(mins=>$5+30),$6,$7)").bind(a.tenant_id).bind(id).bind(p).bind(a.sub).bind(offset as i32).bind(status).bind(title).execute(db).await.unwrap();
    id
}
async fn visit(db: &PgPool, a: &Actor, p: Uuid, appointment: Uuid, signed: bool) -> Uuid {
    let id = Uuid::new_v4();
    let note = json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"});
    if signed {
        sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,'{}'::jsonb,$5,now())").bind(a.tenant_id).bind(id).bind(p).bind(appointment).bind(a.sub).bind(note).execute(db).await.unwrap();
    } else {
        sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status) VALUES($1,$2,$3,$4,$5,'in_progress')").bind(a.tenant_id).bind(id).bind(p).bind(appointment).bind(a.sub).execute(db).await.unwrap();
    }
    id
}
async fn coverage(db: &PgPool, a: &Actor, p: Uuid, name: &str) -> Uuid {
    let (payer, id) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,$3,$2,'synthetic')").bind(a.tenant_id).bind(payer).bind(json!({"name":name,"payer_code":"SYN"})).execute(db).await.unwrap();
    sqlx::query("INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,$2,'synthetic')").bind(a.tenant_id).bind(id).bind(p).bind(payer).bind(json!({"relationship":"self","member_id":"SYNTHETIC-MEMBER","status":"active"})).execute(db).await.unwrap();
    id
}
async fn check(
    db: &PgPool,
    a: &Actor,
    p: Uuid,
    coverage: Uuid,
    minutes_ago: i32,
    status: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    let answer = (status == "completed")
        .then(|| json!({"elig":[{"benefit":[{"benefit_coverage_code":"1"}]}]}));
    sqlx::query("INSERT INTO claimmd_eligibility_checks(tenant_id,id,patient_id,coverage_id,request_id,creation_hash,route_key,request_snapshot,response_snapshot,status,actor_id,created_at,completed_at) VALUES($1,$2,$3,$4,$2,'synthetic','synthetic',$5,$6,$7,$8,now()-make_interval(mins=>$9),CASE WHEN $7='pending' THEN NULL ELSE now()-make_interval(mins=>$9) END)")
        .bind(a.tenant_id).bind(id).bind(p).bind(coverage).bind(json!({"request":{"provider_taxid":"123456789"},"member_id":"SYNTHETIC-MEMBER"})).bind(answer).bind(status).bind(a.sub).bind(minutes_ago).execute(db).await.unwrap();
    id
}
async fn policy(db: &PgPool, owner: &Actor, staff: &Actor, base: &str, permissions: Value) {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,$3,$4,$5,$6)").bind(owner.tenant_id).bind(id).bind(format!("Synthetic {}", id.simple())).bind(base).bind(permissions).bind(owner.sub).execute(db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)").bind(owner.tenant_id).bind(staff.sub).bind(id).bind(owner.sub).execute(db).await.unwrap();
}

#[tokio::test]
async fn banner_is_scoped_to_the_callers_practice_and_patient() {
    let (db, owner, p) = setup().await;
    let r = app(db.clone());
    let other = patient(&db, owner.tenant_id, "SYN-BANNER-2").await;
    appointment(&db, &owner, other, 60, "booked", "Other patient visit").await;
    let mine = banner(&r, &owner, p).await;
    assert_eq!(mine["patient_id"], json!(p));
    assert_eq!(
        mine["next_appointment"],
        Value::Null,
        "another patient's appointment never appears"
    );
    assert_eq!(mine["last_visit"], Value::Null);
    assert_eq!(
        mine["flags"],
        json!({"archived":false,"intake_to_review":0,"intake_sent":0,"portal_status":null,"unsigned_notes":0})
    );
    assert_eq!(
        banner(&r, &owner, other).await["next_appointment"]["title"],
        "Other patient visit"
    );
    // The same patient ID under another practice does not exist for that practice.
    let stranger = actor(Uuid::new_v4(), Role::Owner);
    user(&db, &stranger, "owner").await;
    let (status, _) = call(
        &r,
        &stranger,
        "GET",
        &format!("/api/v1/patients/{p}/banner"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &r,
        &owner,
        "GET",
        &format!("/api/v1/patients/{}/banner", Uuid::new_v4()),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // A patient sign-in is not staff.
    let mut portal = actor(owner.tenant_id, Role::Patient);
    portal.patient_id = Some(p);
    let (status, _) = call(
        &r,
        &portal,
        "GET",
        &format!("/api/v1/patients/{p}/banner"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Reading is recorded without any patient content.
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='patient.banner_read' AND resource_id=$2").bind(owner.tenant_id).bind(p).fetch_one(&db).await.unwrap();
    assert_eq!(audits, 1);
}

#[tokio::test]
async fn banner_picks_the_next_appointment_and_the_last_finished_visit() {
    let (db, owner, p) = setup().await;
    let r = app(db.clone());
    // A booked appointment that already ended, a cancelled one and a no-show are never "next".
    appointment(
        &db,
        &owner,
        p,
        -3 * 24 * 60,
        "booked",
        "Missed and never updated",
    )
    .await;
    appointment(&db, &owner, p, 30, "cancelled", "Cancelled").await;
    appointment(&db, &owner, p, 45, "no_show", "No show").await;
    assert_eq!(banner(&r, &owner, p).await["next_appointment"], Value::Null);
    appointment(&db, &owner, p, 14 * 24 * 60, "booked", "Later follow-up").await;
    let soon = appointment(&db, &owner, p, 2 * 24 * 60, "booked", "Sooner follow-up").await;
    let data = banner(&r, &owner, p).await;
    assert_eq!(data["next_appointment"]["id"], json!(soon));
    assert_eq!(data["next_appointment"]["title"], "Sooner follow-up");
    assert_eq!(data["next_appointment"]["status"], "booked");
    // A visit already under way today comes before anything booked, even after its slot ended.
    let today = appointment(&db, &owner, p, -90, "in_progress", "Today's visit").await;
    visit(&db, &owner, p, today, false).await;
    let data = banner(&r, &owner, p).await;
    assert_eq!(data["next_appointment"]["id"], json!(today));
    assert_eq!(data["next_appointment"]["status"], "in_progress");
    assert_eq!(data["flags"]["unsigned_notes"], 1);
    assert_eq!(
        data["last_visit"],
        Value::Null,
        "a visit still in progress is not the last visit"
    );
    // One left in progress days ago is stale and is not offered as today's.
    appointment(&db, &owner, p, -5 * 24 * 60, "in_progress", "Stale").await;
    assert_eq!(
        banner(&r, &owner, p).await["next_appointment"]["id"],
        json!(today)
    );
    // Last visit: the most recent finished one, by signed note or completed appointment.
    let older = appointment(&db, &owner, p, -30 * 24 * 60, "completed", "Older visit").await;
    assert_eq!(
        banner(&r, &owner, p).await["last_visit"]["appointment_id"],
        json!(older)
    );
    let recent = appointment(
        &db,
        &owner,
        p,
        -7 * 24 * 60,
        "in_progress",
        "Signed last week",
    )
    .await;
    visit(&db, &owner, p, recent, true).await;
    let data = banner(&r, &owner, p).await;
    assert_eq!(data["last_visit"]["appointment_id"], json!(recent));
    assert_eq!(data["last_visit"]["title"], "Signed last week");
}

#[tokio::test]
async fn banner_returns_the_latest_eligibility_check_for_each_coverage() {
    let (db, owner, p) = setup().await;
    let r = app(db.clone());
    let primary = coverage(&db, &owner, p, "Synthetic Primary").await;
    let secondary = coverage(&db, &owner, p, "Synthetic Secondary").await;
    assert_eq!(banner(&r, &owner, p).await["eligibility"], json!([]));
    check(&db, &owner, p, primary, 3 * 24 * 60, "completed").await;
    let latest = check(&db, &owner, p, primary, 5, "failed").await;
    check(&db, &owner, p, primary, 60, "completed").await;
    let only = check(&db, &owner, p, secondary, 600, "completed").await;
    // Another patient's check on the same day is not included.
    let other = patient(&db, owner.tenant_id, "SYN-BANNER-3").await;
    let other_coverage = coverage(&db, &owner, other, "Synthetic Other").await;
    check(&db, &owner, other, other_coverage, 1, "completed").await;
    let data = banner(&r, &owner, p).await;
    let items = data["eligibility"].as_array().unwrap();
    assert_eq!(items.len(), 2, "{data}");
    let of = |id: Uuid| {
        items
            .iter()
            .find(|item| item["coverage_id"] == json!(id))
            .unwrap()
    };
    assert_eq!(of(primary)["id"], json!(latest));
    assert_eq!(of(primary)["status"], "failed");
    assert_eq!(of(secondary)["id"], json!(only));
    assert_eq!(
        of(secondary)["response_snapshot"]["elig"][0]["benefit"][0]["benefit_coverage_code"],
        "1"
    );
    // Same redaction as the eligibility history.
    assert_eq!(
        of(primary)["request_snapshot"]["request"]["provider_taxid"],
        "*****6789"
    );
}

#[tokio::test]
async fn banner_leaves_out_money_and_insurance_answers_for_roles_without_billing() {
    let (db, owner, p) = setup().await;
    let r = app(db.clone());
    let cover = coverage(&db, &owner, p, "Synthetic Primary").await;
    check(&db, &owner, p, cover, 5, "completed").await;
    // A reviewed invoice of $45.00 on a posted encounter account.
    let appt = appointment(&db, &owner, p, -24 * 60, "completed", "Office visit").await;
    let v = visit(&db, &owner, p, appt, true).await;
    let path = format!("/api/v1/patients/{p}/billing/accounts");
    let (status,row)=call(&r,&owner,"POST",&path,json!({"request_id":Uuid::new_v4(),"source_history_id":null,"reason":"Synthetic reviewed charge","content":{"visit_id":v,"coverage_id":null,"service_date":Utc::now().date_naive(),"currency":"USD","notes":"","lines":[{"code_system":"CPT","code":"99213","description":"Synthetic visit","modifiers":"","units":1,"amount_cents":10000,"diagnosis_codes":["Z00.00"]}]}}),None).await;
    assert_eq!(status, StatusCode::OK, "{row}");
    let account = format!("{path}/{}", row["id"].as_str().unwrap());
    let (status, posted) = call(
        &r,
        &owner,
        "POST",
        &format!("{account}/actions"),
        json!({"action":"post","reason":"Reviewed synthetic charges"}),
        Some(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{posted}");
    let before = banner(&r, &owner, p).await;
    assert_eq!(
        before["billing"],
        json!({"patient_due_cents":0,"open_invoice_count":0,"invoice_review_count":0,"card_on_file":false})
    );
    let (status, invoice) = call(&r, &owner, "POST", &format!("{account}/invoices"), json!({"request_id":Uuid::new_v4(),"responsibility_cents":4500,"reason":"Reviewed synthetic patient responsibility"}), Some(2)).await;
    assert_eq!(status, StatusCode::OK, "{invoice}");
    let data = banner(&r, &owner, p).await;
    assert_eq!(data["billing"]["patient_due_cents"], 4500);
    assert_eq!(data["billing"]["open_invoice_count"], 1);
    // The banner and the billing page read the same figure.
    let (status, overview) = call(
        &r,
        &owner,
        "GET",
        &format!("/api/v1/billing/overview?patient_id={p}"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{overview}");
    assert_eq!(
        overview["summary"]["accounts"]["reviewed_patient_due_cents"],
        data["billing"]["patient_due_cents"]
    );
    assert_eq!(data["eligibility"].as_array().unwrap().len(), 1);
    // A card saved through the practice's current payment set-up.
    let setting = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO payment_settings(tenant_id,id,mode) VALUES($1,$2,'suncharts_connect')",
    )
    .bind(owner.tenant_id)
    .bind(setting)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO patient_payment_setups(tenant_id,request_id,patient_id,setting_id,credential_revision,installation_id,provider_account_id,livemode,return_url,requested_by,consent_scope,status,provider_evidence) VALUES($1,$2,$3,$4,1,$5,'acct_synthetic',false,'http://127.0.0.1:8099/?payment_setup=x',$6,'patient_present','open',NULL)").bind(owner.tenant_id).bind(Uuid::new_v4()).bind(p).bind(setting).bind(Uuid::new_v4()).bind(owner.sub).execute(&db).await.unwrap();
    assert_eq!(
        banner(&r, &owner, p).await["billing"]["card_on_file"],
        false,
        "an unfinished card set-up is not a card on file"
    );
    sqlx::query("UPDATE patient_payment_setups SET status='succeeded',provider_evidence=$3,version=version+1 WHERE tenant_id=$1 AND patient_id=$2").bind(owner.tenant_id).bind(p).bind(json!({"session":{"payment_method_id":"pm_synthetic"}})).execute(&db).await.unwrap();
    assert_eq!(banner(&r, &owner, p).await["billing"]["card_on_file"], true);

    // Front desk with Billing switched off: no balance, no card marker, no insurer answers.
    let desk = actor(owner.tenant_id, Role::FrontDesk);
    user(&db, &desk, "front_desk").await;
    policy(&db, &owner, &desk, "front_desk", json!({"clinical":{"view":true},"scheduling":{"view":true},"billing":{"view":false},"claims":{"view":true}})).await;
    let data = banner(&r, &desk, p).await;
    assert!(data.get("billing").is_none(), "{data}");
    assert!(data.get("eligibility").is_none(), "{data}");
    assert!(data["flags"].is_object() && data["last_visit"].is_object());
    assert!(!data.to_string().contains("4500"));
    // Billing allowed but not claims: balance only; the insurer's answer stays on the claims side.
    let nurse = actor(owner.tenant_id, Role::Nurse);
    user(&db, &nurse, "nurse").await;
    policy(&db, &owner, &nurse, "nurse", json!({"clinical":{"view":true},"scheduling":{"view":true},"billing":{"view":true},"claims":{"view":false}})).await;
    let data = banner(&r, &nurse, p).await;
    assert_eq!(data["billing"]["patient_due_cents"], 4500);
    assert!(data.get("eligibility").is_none(), "{data}");
    // Without the chart itself (clinical or scheduling), the banner is refused like the chart.
    let limited = actor(owner.tenant_id, Role::MedicalAssistant);
    user(&db, &limited, "medical_assistant").await;
    policy(
        &db,
        &owner,
        &limited,
        "medical_assistant",
        json!({"clinical":{"view":true},"scheduling":{"view":false},"billing":{"view":true}}),
    )
    .await;
    let (status, _) = call(
        &r,
        &limited,
        "GET",
        &format!("/api/v1/patients/{p}/banner"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call(
        &r,
        &limited,
        "GET",
        &format!("/api/v1/patients/{p}/workspace"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // A built-in role with no custom policy sees what it sees in the chart today.
    let clinician = actor(owner.tenant_id, Role::Clinician);
    user(&db, &clinician, "clinician").await;
    assert_eq!(
        banner(&r, &clinician, p).await["billing"]["patient_due_cents"],
        4500
    );
}

#[tokio::test]
async fn banner_flags_and_revision_follow_the_records() {
    let (db, owner, p) = setup().await;
    let r = app(db.clone());
    let first = banner(&r, &owner, p).await;
    assert_eq!(
        banner(&r, &owner, p).await["revision"],
        first["revision"],
        "reading does not change the revision"
    );
    // Portal: invited is not active.
    sqlx::query("INSERT INTO patient_portal_accounts(tenant_id,id,patient_id,email,status) VALUES($1,$2,$3,'avery@example.test','invited')").bind(owner.tenant_id).bind(Uuid::new_v4()).bind(p).execute(&db).await.unwrap();
    assert_eq!(
        banner(&r, &owner, p).await["flags"]["portal_status"],
        "invited"
    );
    // Intake: one sent and waiting, one sent in, one already reviewed, one cancelled.
    let template = Uuid::new_v4();
    sqlx::query("INSERT INTO previsit_intake_templates(tenant_id,id,name,version,active,schema,updated_by) VALUES($1,$2,'Synthetic intake',1,true,'{}'::jsonb,$3)").bind(owner.tenant_id).bind(template).bind(owner.sub).execute(&db).await.unwrap();
    for (n, status) in ["sent", "submitted", "reviewed", "void"]
        .into_iter()
        .enumerate()
    {
        let (submitted, reviewed) = (
            matches!(status, "submitted" | "reviewed"),
            status == "reviewed",
        );
        sqlx::query("INSERT INTO previsit_intake_packets(tenant_id,id,appointment_id,patient_id,template_id,template_version,template_snapshot,access_token_hash,status,due_at,issued_by,submitted_at,reviewed_at,reviewed_by) VALUES($1,$2,NULL,$3,$4,1,'{}'::jsonb,$5,$6,now()+interval '7 days',$7,CASE WHEN $8 THEN now() END,CASE WHEN $9 THEN now() END,CASE WHEN $9 THEN $7 END)")
            .bind(owner.tenant_id).bind(Uuid::new_v4()).bind(p).bind(template).bind(format!("{:064x}", n + 1)).bind(status).bind(owner.sub).bind(submitted).bind(reviewed).execute(&db).await.unwrap();
    }
    let data = banner(&r, &owner, p).await;
    assert_eq!(data["flags"]["intake_sent"], 1);
    assert_eq!(data["flags"]["intake_to_review"], 1);
    assert_eq!(
        data["revision"], first["revision"],
        "flags alone do not mark the chart as changed"
    );
    // A saved coverage changes the revision so an open chart can say it is out of date.
    coverage(&db, &owner, p, "Synthetic Primary").await;
    let changed = banner(&r, &owner, p).await;
    assert_ne!(changed["revision"], first["revision"]);
    assert_eq!(changed["revision"].as_str().unwrap().len(), 32);
    // Archived.
    sqlx::query("INSERT INTO patient_lifecycle_events(tenant_id,patient_id,version,archived,reason,actor_id) VALUES($1,$2,2,true,'Synthetic archive',$3)").bind(owner.tenant_id).bind(p).bind(owner.sub).execute(&db).await.unwrap();
    assert_eq!(banner(&r, &owner, p).await["flags"]["archived"], true);
}
