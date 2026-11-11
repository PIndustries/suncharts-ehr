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
const SECRET: &str = "synthetic-secondary-claim-test-secret";
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
async fn setup() -> (PgPool, Actor, Uuid, Uuid) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("secondary_claims_test_{}", Uuid::new_v4().simple());
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
    user(&db, &a, a.sub, "owner", false).await;
    let p = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-CHECKOUT','Avery','Synthetic','1990-01-01')").bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')").bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(&db).await.unwrap();
    (db, a, p, appointment)
}
async fn user(db: &PgPool, a: &Actor, id: Uuid, role: &str, disabled: bool) {
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login',$4,$5)").bind(id).bind(a.tenant_id).bind(format!("{}@example.test",id.simple())).bind(role).bind(disabled).execute(db).await.unwrap();
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

async fn ok(
    r: &Router,
    a: &Actor,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> Value {
    let (status, value) = call(r, a, method, path, body, version).await;
    assert_eq!(status, StatusCode::OK, "{path}: {value}");
    value
}
fn id(v: &Value) -> Uuid {
    Uuid::parse_str(
        v["id"]
            .as_str()
            .unwrap_or_else(|| panic!("missing synthetic entity id: {v}")),
    )
    .unwrap()
}
fn version(v: &Value) -> i64 {
    v["version"].as_i64().unwrap()
}
fn details() -> Value {
    let address = json!({"line1":"1 Synthetic Way","line2":"","city":"Austin","state":"TX","postal_code":"78701"});
    json!({"billing_address":address,"subscriber_address":address,"patient_address":address,"payer_address":address,"subscriber_given_name":"Avery","subscriber_family_name":"Synthetic","patient_sex":"U","subscriber_sex":"U","rendering_given_name":"Synthetic","rendering_family_name":"Clinician","billing_taxonomy":"208D00000X","filing_indicator":"CI","signature_on_file":true,"benefits_assigned":true,"release_authorized":true,"routine_professional_reviewed":true})
}
fn content() -> Value {
    json!({"billing_provider_name":"Synthetic Practice","billing_npi":"1234567893","rendering_npi":"1234567893","tax_id":"000000001","billing_address":"1 Synthetic Way, Austin TX78701","patient_address":"1 Synthetic Way, Austin TX78701","subscriber_address":"1 Synthetic Way, Austin TX78701","subscriber_birth_date":"1990-01-01","place_of_service":"11","diagnosis_codes":["Z00.00"],"line_diagnosis_pointers":[[1]],"external_control_number":"","notes":"Synthetic only"})
}
async fn adjudicate(
    r: &Router,
    a: &Actor,
    payer: Uuid,
    claim: &Value,
    account: &Value,
    settlement: (i64, &str, &str),
) -> Value {
    let (paid, status, trace) = settlement;
    let primary = trace == "SYN-PRIMARY";
    let repeated = trace == "SYN-REPEATED";
    let adjustments = if primary {
        json!([{ "group":"CO","reason_code":"45","amount_cents":2000,"service_index":0},{"group":"PR","reason_code":"2","amount_cents":2000,"service_index":0}])
    } else if repeated {
        json!([{ "group":"CO","reason_code":"45","amount_cents":1000,"service_index":0},{ "group":"OA","reason_code":"23","amount_cents":8000,"service_index":0},{"group":"PR","reason_code":"2","amount_cents":500,"service_index":0}])
    } else {
        json!([{ "group":"OA","reason_code":"23","amount_cents":8000,"service_index":0},{"group":"PR","reason_code":"2","amount_cents":500,"service_index":0}])
    };
    let remit = if status == "19" {
        let body=format!("BPR*I*60*C*CHK************20261026~TRN*1*SYN-PRIMARY~N1*PR*Synthetic*PI*SYN-P~N1*PE*Practice*XX*1234567893~CLP*{}*19*100*60*20*12*SYN-PRIMARY~SVC*HC:99213*100*60~CAS*CO*45*20~CAS*PR*2*20~REF*6R*1~",claim["control_number"].as_str().unwrap());
        let count = body.split('~').filter(|s| !s.is_empty()).count() + 2;
        let raw = format!("ST*835*0001~{body}SE*{count}*0001~");
        ok(r,a,"POST","/api/v1/billing/remittances",json!({"request_id":Uuid::new_v4(),"payer_id":payer,"format":"x12_835","original_text":raw,"reason":"Reviewed synthetic forwarded835"}),None).await
    } else {
        ok(r,a,"POST","/api/v1/billing/remittances",json!({"request_id":Uuid::new_v4(),"payer_id":payer,"format":"normalized","document":{"payer_code":if primary{"SYN-P"}else{"SYN-S"},"trace":trace,"payment_date":"2026-10-26","total_paid_cents":paid,"currency":"USD","claims":[{"control_number":claim["control_number"],"payer_control_number":if primary{"SYN-PRIMARY"}else{"SYN-SECONDARY"},"status":status,"patient_name":"Avery Synthetic","charged_cents":10000,"paid_cents":paid,"patient_responsibility_cents":if primary{2000}else{500},"adjustments":adjustments,"services":[{"code":"HC:99213","charged_cents":10000,"paid_cents":paid,"line_control":"1"}]}]},"reason":"Reviewed synthetic ERA"}),None).await
    };
    let path = format!("/api/v1/billing/remittances/{}", id(&remit));
    let matched=ok(r,a,"PUT",&format!("{path}/matches"),json!({"reason":"Reviewed synthetic match","matches":[{"row_index":0,"claim_id":id(claim),"claim_version":version(claim),"account_version":version(account),"writeoff_adjustments":if primary||repeated{vec![0]}else{vec![]}}]}),Some(version(&remit))).await;
    if repeated {
        assert!(matched["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| issue
                .as_str()
                .unwrap()
                .contains("already-posted primary credit")));
        assert_eq!(
            call(
                r,
                a,
                "POST",
                &format!("{path}/actions"),
                json!({"action":"post","reason":"Must not repeat primary credit"}),
                Some(version(&matched["remittance"]))
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        return matched["remittance"].clone();
    }
    assert_eq!(
        matched["issues"],
        json!([]),
        "synthetic match must reconcile"
    );
    ok(
        r,
        a,
        "POST",
        &format!("{path}/actions"),
        json!({"action":"post","reason":"Post reviewed synthetic payment"}),
        Some(version(&matched["remittance"])),
    )
    .await
}

async fn run_secondary_flow(primary_status: &str, denied: bool) {
    let (db, a, p, appointment) = setup().await;
    let r = app(db.clone());
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,'{}'::jsonb,$5,now())").bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub).bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"})).execute(&db).await.unwrap();
    let mut policies = vec![];
    for (priority, code) in [("primary", "SYN-P"), ("secondary", "SYN-S")] {
        let payer=ok(&r,&a,"POST","/api/v1/billing/payers",json!({"request_id":Uuid::new_v4(),"content":{"name":format!("Synthetic {priority}"),"payer_code":code,"address":"Synthetic address","phone":"","active":true},"reason":"Synthetic payer"}),None).await;
        let policy=ok(&r,&a,"POST",&format!("/api/v1/patients/{p}/coverages"),json!({"request_id":Uuid::new_v4(),"content":{"payer_id":id(&payer),"priority":priority,"status":"active","member_id":format!("SYN-{priority}"),"group_number":"SYN-G","plan_name":"Synthetic plan","subscriber_name":"Avery Synthetic","subscriber_birth_date":"1990-01-01","relationship":"self","effective_date":"2026-01-01","end_date":null,"copay_cents":null,"verification":"manually_verified","notes":"Synthetic"},"reason":"Synthetic coverage"}),None).await;
        policies.push((payer, policy));
    }
    let base = format!("/api/v1/patients/{p}/billing/accounts");
    let draft=ok(&r,&a,"POST",&base,json!({"request_id":Uuid::new_v4(),"content":{"visit_id":visit,"coverage_id":id(&policies[0].1),"service_date":"2026-10-25","currency":"USD","notes":"Synthetic","lines":[{"code_system":"CPT","code":"99213","description":"Synthetic service","modifiers":"","units":1,"amount_cents":10000,"diagnosis_codes":["Z00.00"]}]},"reason":"Synthetic charges"}),None).await;
    let account_path = format!("{base}/{}", id(&draft));
    let claims_path = format!("{account_path}/claims");
    let posted = ok(
        &r,
        &a,
        "POST",
        &format!("{account_path}/actions"),
        json!({"action":"post","reason":"Reviewed synthetic signed visit"}),
        Some(version(&draft)),
    )
    .await;
    let first=ok(&r,&a,"POST",&claims_path,json!({"request_id":Uuid::new_v4(),"frequency":"original","content":content(),"reason":"Synthetic primary"}),Some(version(&posted))).await;
    let primary_path = format!("/api/v1/billing/claims/{}", id(&first));
    let ready = ok(
        &r,
        &a,
        "POST",
        &format!("{primary_path}/actions"),
        json!({"action":"ready","reason":"Synthetic review"}),
        Some(version(&first)),
    )
    .await;
    let partner=ok(&r,&a,"POST","/api/v1/billing/clearinghouses",json!({"request_id":Uuid::new_v4(),"content":{"name":"Synthetic transport","active":true,"sender_qualifier":"ZZ","sender_id":"SYN-SEND","receiver_qualifier":"ZZ","receiver_id":"SYN-RECV","application_sender":"SYN-SEND","application_receiver":"SYN-RECV","submitter_name":"Synthetic Clinic","submitter_id":"SYN-CLINIC","receiver_name":"Synthetic Receiver","receiver_identifier":"SYN-R","contact_name":"Synthetic Contact","contact_phone":"5125550101","usage":"T","guide_reference":"Synthetic contract"},"reason":"Synthetic partner"}),None).await;
    let generate = |d: Value| json!({"request_id":Uuid::new_v4(),"partner_id":id(&partner),"partner_version":version(&partner),"details":d,"reason":"Synthetic generated evidence only"});
    let primary_artifact = ok(
        &r,
        &a,
        "POST",
        &format!("{primary_path}/837p"),
        generate(details()),
        Some(version(&ready)),
    )
    .await;
    // Inject only synthetic accepted transport evidence; no network call is made.
    sqlx::query("UPDATE edi_submissions SET status='delivered' WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id(&primary_artifact))
        .execute(&db)
        .await
        .unwrap();
    let submitted=ok(&r,&a,"POST",&format!("{primary_path}/actions"),json!({"action":"record_submission","reference":"SYNTHETIC-PRIMARY-TRANSPORT","event_date":"2026-10-25","reason":"Synthetic delivery fixture"}),Some(version(&ready))).await;
    let remittance = adjudicate(
        &r,
        &a,
        id(&policies[0].0),
        &submitted,
        &posted,
        (6000, primary_status, "SYN-PRIMARY"),
    )
    .await;
    let review = ok(
        &r,
        &a,
        "GET",
        &format!("{primary_path}/secondary-review"),
        json!(null),
        None,
    )
    .await;
    if primary_status == "1" {
        assert_eq!(review["blockers"], json!([]));
    } else {
        assert!(!review["blockers"].as_array().unwrap().is_empty());
    }
    assert_eq!(review["coverages"].as_array().unwrap().len(), 1);
    let account = &review["account"];
    let primary = &review["primary_claim"];
    let coordination = json!({"coverage_id":id(&policies[1].1),"coverage_version":version(&policies[1].1),"primary_claim_version":version(primary),"remittance_id":id(&remittance),"remittance_version":version(&remittance),"row_index":0,"not_forwarded_confirmed":true,"payer_timing_reviewed":true,"crossover_reference":"Reviewed synthetic EOB: no crossover, timing confirmed","paid_units":[1]});
    let request = json!({"request_id":Uuid::new_v4(),"frequency":"original","parent_id":id(primary),"coordination":coordination,"content":content(),"reason":"Reviewed synthetic secondary"});
    if primary_status == "19" {
        assert_eq!(
            call(
                &r,
                &a,
                "POST",
                &claims_path,
                request.clone(),
                Some(version(account))
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM ehr_claims")
                .fetch_one(&db)
                .await
                .unwrap(),
            1
        );
        run_crossover(CrossoverFixture {
            db: &db,
            router: &r,
            actor: &a,
            review: &review,
            policies: &policies,
            primary_remit: &remittance,
            primary_artifact: &primary_artifact,
            denied,
        })
        .await;
        db.close().await;
        return;
    }
    let primary_resend = json!({"request_id":Uuid::new_v4(),"frequency":"original","content":content(),"reason":"Must not resend original primary"});
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &claims_path,
            primary_resend,
            Some(version(account))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    for key in ["not_forwarded_confirmed", "payer_timing_reviewed"] {
        let mut bad = request.clone();
        bad["coordination"][key] = json!(false);
        assert_eq!(
            call(&r, &a, "POST", &claims_path, bad, Some(version(account)))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let mut stale = request.clone();
    stale["coordination"]["primary_claim_version"] = json!(1);
    assert_eq!(
        call(&r, &a, "POST", &claims_path, stale, Some(version(account)))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let mut foreign = request.clone();
    foreign["coordination"]["coverage_id"] = json!(Uuid::new_v4());
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &claims_path,
            foreign,
            Some(version(account))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let before: Value = sqlx::query_scalar(
        "SELECT to_jsonb(b) FROM billing_accounts b WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id(account))
    .fetch_one(&db)
    .await
    .unwrap();
    let mut other_tenant = a.clone();
    other_tenant.tenant_id = Uuid::new_v4();
    assert_eq!(
        call(
            &r,
            &other_tenant,
            "GET",
            &format!("{primary_path}/secondary-review"),
            json!(null),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    sqlx::raw_sql("CREATE FUNCTION reject_secondary_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='claim.change' THEN RAISE EXCEPTION 'synthetic secondary audit refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_secondary_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_secondary_audit();").execute(&db).await.unwrap();
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &claims_path,
            request.clone(),
            Some(version(account))
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM ehr_claims")
            .fetch_one(&db)
            .await
            .unwrap(),
        1,
        "audit refusal must roll back new secondary"
    );
    sqlx::raw_sql("DROP TRIGGER reject_secondary_audit ON audit_events; DROP FUNCTION reject_secondary_audit();").execute(&db).await.unwrap();
    let secondary = ok(
        &r,
        &a,
        "POST",
        &claims_path,
        request.clone(),
        Some(version(account)),
    )
    .await;
    let replay = ok(
        &r,
        &a,
        "POST",
        &claims_path,
        request.clone(),
        Some(version(account)),
    )
    .await;
    assert_eq!(id(&secondary), id(&replay));
    let mut duplicate = request.clone();
    duplicate["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &claims_path,
            duplicate,
            Some(version(account))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(secondary["snapshot"]["account"]["id"], account["id"]);
    assert_eq!(
        secondary["snapshot"]["account"]["content"]["lines"],
        posted["content"]["lines"]
    );
    assert_eq!(secondary["payer_id"], policies[1].0["id"]);
    assert_eq!(
        secondary["snapshot"]["coordination_of_benefits"]["adjudication"]["paid_cents"],
        6000
    );
    let after: Value = sqlx::query_scalar(
        "SELECT to_jsonb(b) FROM billing_accounts b WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id(account))
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        before, after,
        "preparing secondary must not change charges or ledger"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_accounts")
            .fetch_one(&db)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        2
    );
    let sp = format!("/api/v1/billing/claims/{}", id(&secondary));
    assert_eq!(
        call(&r, &a, "GET", &format!("{sp}/cms1500"), json!(null), None)
            .await
            .0,
        StatusCode::CONFLICT,
        "secondary paper preview cannot omit other-payer data"
    );
    let ready = ok(
        &r,
        &a,
        "POST",
        &format!("{sp}/actions"),
        json!({"action":"ready","reason":"Reviewed secondary"}),
        Some(version(&secondary)),
    )
    .await;
    let artifact = ok(
        &r,
        &a,
        "POST",
        &format!("{sp}/837p"),
        generate(details()),
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
    assert!(payload.contains("SBR*S*18"));
    assert!(payload.contains("SBR*P*18"));
    assert!(payload.contains("AMT*D*60.00~"));
    assert!(payload.contains(
        "SVD*SYN-P*60.00*HC:99213**1~CAS*CO*45*20.00~CAS*PR*2*20.00~DTP*573*D8*20261026~"
    ));
    assert_eq!(payload.matches("SV1*").count(), 1);
    assert!(payload.contains("SV1*HC:99213*100.00*UN*1*11**1~"));
    assert_eq!(
        call(
            &r,
            &a,
            "POST",
            &format!("/api/v1/billing/remittances/{}/actions", id(&remittance)),
            json!({"action":"reverse","reason":"Must refuse active dependent secondary"}),
            Some(version(&remittance))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE edi_submissions SET status='delivered' WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id(&artifact))
        .execute(&db)
        .await
        .unwrap();
    let sent=ok(&r,&a,"POST",&format!("{sp}/actions"),json!({"action":"record_submission","reference":"SYNTHETIC-SECONDARY","event_date":"2026-10-26","reason":"Synthetic only"}),Some(version(&ready))).await;
    let rejected_repeat = adjudicate(
        &r,
        &a,
        id(&policies[1].0),
        &sent,
        account,
        (500, "2", "SYN-REPEATED"),
    )
    .await;
    assert_eq!(rejected_repeat["status"], "staged");
    adjudicate(
        &r,
        &a,
        id(&policies[1].0),
        &sent,
        account,
        (1500, "2", "SYN-SECONDARY"),
    )
    .await;
    let balance:i64=sqlx::query_scalar("SELECT b.total_cents+coalesce(sum(e.effect_cents),0)::bigint FROM billing_accounts b LEFT JOIN billing_entries e ON e.tenant_id=b.tenant_id AND e.account_id=b.id WHERE b.tenant_id=$1 AND b.id=$2 GROUP BY b.total_cents").bind(a.tenant_id).bind(id(account)).fetch_one(&db).await.unwrap();
    assert_eq!(balance, 500);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_accounts")
            .fetch_one(&db)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        3
    );
    let account = sqlx::query_scalar::<_, Value>(
        "SELECT to_jsonb(b) FROM billing_accounts b WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id(account))
    .fetch_one(&db)
    .await
    .unwrap();
    let invoice=ok(&r,&a,"POST",&format!("{account_path}/invoices"),json!({"request_id":Uuid::new_v4(),"responsibility_cents":500,"reason":"Reviewed final secondary PR500"}),Some(version(&account))).await;
    assert_eq!(invoice["snapshot"]["amount_due_cents"], 500);
    assert_eq!(invoice["snapshot"]["gross_charges_cents"], 10000);
    let detail = ok(&r, &a, "GET", &sp, json!(null), None).await;
    let correction=ok(&r,&a,"POST",&claims_path,json!({"request_id":Uuid::new_v4(),"frequency":"replacement","parent_id":id(&detail["claim"]),"content":content(),"reason":"Synthetic corrected secondary"}),Some(version(&account))).await;
    assert_eq!(correction["payer_id"], secondary["payer_id"]);
    assert_eq!(
        correction["snapshot"]["coordination_of_benefits"],
        secondary["snapshot"]["coordination_of_benefits"],
        "corrections retain primary and secondary identity evidence"
    );
    let voided = ok(
        &r,
        &a,
        "POST",
        &format!("/api/v1/billing/claims/{}/actions", id(&correction)),
        json!({"action":"void_draft","reason":"Synthetic correction withdrawn"}),
        Some(version(&correction)),
    )
    .await;
    assert_eq!(voided["status"], "void");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_entries")
            .fetch_one(&db)
            .await
            .unwrap(),
        3,
        "correction and void cannot add charges or payment entries"
    );

    db.close().await;
}

#[tokio::test]
async fn secondary_claim_reuses_one_account_and_carries_primary_adjudication_once() {
    run_secondary_flow("1", false).await;
}
#[tokio::test]
async fn forwarded_primary_era_blocks_duplicate_secondary_route() {
    run_secondary_flow("19", false).await;
}

fn crossover_raw(control: &str, denied: bool, variant: &str) -> String {
    let paid = if denied { "0" } else { "15" };
    let status = if denied { "4" } else { "2" };
    let pr = if denied { "0" } else { "5" };
    let final_cas = if denied {
        "CAS*OA*96*20~"
    } else {
        "CAS*PR*2*5~"
    };
    let npi = if variant == "payee" {
        "9876543210"
    } else {
        "1234567893"
    };
    let date = if variant == "date" {
        "20261024"
    } else {
        "20261025"
    };
    let code = if variant == "code" { "99214" } else { "99213" };
    let control = if variant == "control" {
        "WRONG-ORIGINAL"
    } else {
        control
    };
    let body = format!("BPR*I*{paid}*C*CHK************20261027~TRN*1*SYN-CROSS-{variant}~N1*PR*Synthetic secondary*PI*SYN-S~N1*PE*Practice*XX*{npi}~CLP*{control}*{status}*100*{paid}*{pr}*12*SYN-SECONDARY~SVC*HC:{code}*100*{paid}~DTM*472*{date}~CAS*OA*23*80~{final_cas}REF*6R*1~");
    let count = body.split('~').filter(|s| !s.is_empty()).count() + 2;
    format!("ST*835*0001~{body}SE*{count}*0001~")
}
struct CrossoverFixture<'a> {
    db: &'a PgPool,
    router: &'a Router,
    actor: &'a Actor,
    review: &'a Value,
    policies: &'a [(Value, Value)],
    primary_remit: &'a Value,
    primary_artifact: &'a Value,
    denied: bool,
}
async fn run_crossover(f: CrossoverFixture<'_>) {
    let CrossoverFixture {
        db,
        router: r,
        actor: a,
        review,
        policies,
        primary_remit,
        primary_artifact,
        denied,
    } = f;
    let primary = &review["primary_claim"];
    let account = &review["account"];
    let primary_path = format!("/api/v1/billing/claims/{}", id(primary));
    let account_path = format!(
        "/api/v1/patients/{}/billing/accounts/{}",
        primary["patient_id"].as_str().unwrap(),
        id(account)
    );
    let claims_path = format!("{account_path}/claims");
    assert_eq!(
        review["crossover_candidates"],
        json!([]),
        "forwarding alone cannot invent destination or received evidence"
    );
    let frozen_account: Value = sqlx::query_scalar(
        "SELECT to_jsonb(b) FROM billing_accounts b WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id(account))
    .fetch_one(db)
    .await
    .unwrap();
    let frozen_entries: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM billing_entries e WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .fetch_one(db)
    .await
    .unwrap();
    let mut received = None;
    for variant in ["payee", "date", "code", "control", "valid"] {
        let raw = crossover_raw(primary["control_number"].as_str().unwrap(), denied, variant);
        let rem=ok(r,a,"POST","/api/v1/billing/remittances",json!({"request_id":Uuid::new_v4(),"payer_id":id(&policies[1].0),"format":"x12_835","original_text":raw,"reason":"Synthetic received secondary crossover"}),None).await;
        let candidate_review = ok(
            r,
            a,
            "GET",
            &format!("{primary_path}/secondary-review"),
            json!(null),
            None,
        )
        .await;
        assert_eq!(
            candidate_review["crossover_candidates"]
                .as_array()
                .unwrap()
                .len(),
            usize::from(variant == "valid"),
            "only exact payer/provider/date/services/control evidence is offered: {variant}"
        );
        if variant == "valid" {
            received = Some(rem);
        }
    }
    let received = received.unwrap();
    let rp = format!("/api/v1/billing/remittances/{}", id(&received));
    let mut body = json!({"request_id":Uuid::new_v4(),"frequency":"original","parent_id":id(primary),"content":content(),"reason":"Reviewed synthetic crossover link","crossover":{"coverage_id":id(&policies[1].1),"coverage_version":version(&policies[1].1),"primary_claim_version":version(primary),"primary_remittance_id":id(primary_remit),"primary_remittance_version":version(primary_remit),"primary_row_index":0,"secondary_remittance_id":id(&received),"secondary_remittance_version":version(&received),"secondary_row_index":0,"linkage_confirmed":true,"linkage_reference":"Reviewed synthetic primary forwarding and secondary835"}});
    for (field, bad_value) in [
        ("linkage_confirmed", json!(false)),
        ("secondary_remittance_version", json!(999)),
        ("coverage_id", json!(Uuid::new_v4())),
    ] {
        let mut invalid = body.clone();
        invalid["crossover"][field] = bad_value;
        let status = call(r, a, "POST", &claims_path, invalid, Some(version(account)))
            .await
            .0;
        assert!(matches!(
            status,
            StatusCode::CONFLICT | StatusCode::BAD_REQUEST
        ));
    }
    let other = Actor {
        tenant_id: Uuid::new_v4(),
        ..a.clone()
    };
    assert_eq!(
        call(
            r,
            &other,
            "POST",
            &claims_path,
            body.clone(),
            Some(version(account))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    sqlx::raw_sql("CREATE FUNCTION reject_crossover_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='claim.change' THEN RAISE EXCEPTION 'synthetic crossover audit refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_crossover_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_crossover_audit();").execute(db).await.unwrap();
    assert_eq!(
        call(
            r,
            a,
            "POST",
            &claims_path,
            body.clone(),
            Some(version(account))
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM ehr_claims")
            .fetch_one(db)
            .await
            .unwrap(),
        1
    );
    sqlx::raw_sql("DROP TRIGGER reject_crossover_audit ON audit_events; DROP FUNCTION reject_crossover_audit();").execute(db).await.unwrap();
    let first = ok(
        r,
        a,
        "POST",
        &claims_path,
        body.clone(),
        Some(version(account)),
    )
    .await;
    let first_replay = ok(
        r,
        a,
        "POST",
        &claims_path,
        body.clone(),
        Some(version(account)),
    )
    .await;
    assert_eq!(id(&first), id(&first_replay));
    // An incorrect unposted link can be withdrawn, preserving history, then linked again.
    let withdrawn = ok(
        r,
        a,
        "POST",
        &format!("/api/v1/billing/claims/{}/actions", id(&first)),
        json!({"action":"withdraw_crossover","reason":"Synthetic unposted linkage correction"}),
        Some(version(&first)),
    )
    .await;
    assert_eq!(withdrawn["status"], "void");
    body["request_id"] = json!(Uuid::new_v4());
    let tracker = ok(
        r,
        a,
        "POST",
        &claims_path,
        body.clone(),
        Some(version(account)),
    )
    .await;
    let replay = ok(
        r,
        a,
        "POST",
        &claims_path,
        body.clone(),
        Some(version(account)),
    )
    .await;
    assert_eq!(id(&tracker), id(&replay));
    assert_eq!(tracker["status"], "submitted");
    let listing = ok(
        r,
        a,
        "GET",
        &format!(
            "/api/v1/billing/claims?patient_id={}&account_id={}",
            primary["patient_id"].as_str().unwrap(),
            id(account)
        ),
        json!(null),
        None,
    )
    .await;
    assert_eq!(
        listing["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == tracker["id"])
            .unwrap()["crossover_tracking_only"],
        true
    );
    assert_eq!(
        listing["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == primary["id"])
            .unwrap()["crossover_tracking_only"],
        false
    );

    assert_eq!(tracker["payer_id"], policies[1].0["id"]);
    assert_eq!(
        tracker["content"]["external_control_number"],
        primary["control_number"]
    );
    assert_eq!(
        tracker["snapshot"]["coordination_of_benefits"]["crossover"]["remittance_id"],
        received["id"]
    );
    assert_eq!(
        tracker["snapshot"]["account"]["content"]["lines"],
        account["content"]["lines"]
    );
    let after: Value = sqlx::query_scalar(
        "SELECT to_jsonb(b) FROM billing_accounts b WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id(account))
    .fetch_one(db)
    .await
    .unwrap();
    assert_eq!(after, frozen_account);
    let entries: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM billing_entries e WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .fetch_one(db)
    .await
    .unwrap();
    assert_eq!(
        entries, frozen_entries,
        "tracking, withdrawal and relinking cannot alter charges/payments"
    );
    body["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        call(r, a, "POST", &claims_path, body, Some(version(account)))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let cp = format!("/api/v1/billing/claims/{}", id(&tracker));
    for endpoint in ["packet", "cms1500"] {
        assert_eq!(
            call(r, a, "GET", &format!("{cp}/{endpoint}"), json!(null), None)
                .await
                .0,
            StatusCode::CONFLICT
        );
    }
    assert_eq!(
        call(
            r,
            a,
            "POST",
            &format!("{cp}/actions"),
            json!({"action":"ready","reason":"Never send crossover again"}),
            Some(version(&tracker))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(call(r,a,"POST",&format!("{cp}/837p"),json!({"request_id":Uuid::new_v4(),"partner_id":primary_artifact["partner_id"],"partner_version":primary_artifact["partner_version"],"details":details(),"reason":"Must never generate crossover outbound"}),Some(version(&tracker))).await.0,StatusCode::CONFLICT);
    // A deliberately corrupt synthetic artifact binding cannot bypass downstream guards.
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM edi_submissions")
            .fetch_one(db)
            .await
            .unwrap(),
        1,
        "no secondary artifact was generated"
    );
    let corrupt_artifact = Uuid::new_v4();
    sqlx::query("INSERT INTO edi_submissions(tenant_id,id,claim_id,partner_id,claim_version,partner_version,claim_snapshot,partner_snapshot,details,payload,payload_hash,interchange_control,group_control,transaction_control,request_id,creation_hash) SELECT tenant_id,$3,$4,partner_id,$5,partner_version,$6,partner_snapshot,details,payload,payload_hash,'999999999',group_control,transaction_control,$3,'synthetic-corrupt-binding' FROM edi_submissions WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id(primary_artifact)).bind(corrupt_artifact).bind(id(&tracker)).bind(version(&tracker)).bind(&tracker).execute(db).await.unwrap();
    let artifact_path = format!("/api/v1/billing/submissions/{corrupt_artifact}");
    assert_eq!(
        call(
            r,
            a,
            "GET",
            &format!("{artifact_path}/file"),
            json!(null),
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(call(r,a,"POST",&format!("{artifact_path}/delivery"),json!({"request_id":Uuid::new_v4(),"route_key":"synthetic-never-configured","reason":"Must not send"}),Some(version(primary_artifact))).await.0,StatusCode::CONFLICT);
    assert_eq!(call(r,a,"POST",&format!("{artifact_path}/actions"),json!({"action":"record_delivery","reference":"SYN","event_date":"2026-10-27","reason":"Must not record outbound"}),Some(version(primary_artifact))).await.0,StatusCode::CONFLICT);

    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM edi_delivery_jobs")
            .fetch_one(db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM edi_submissions")
            .fetch_one(db)
            .await
            .unwrap(),
        2,
        "only the primary and deliberately injected synthetic artifact exist"
    );
    assert_eq!(
        call(
            r,
            a,
            "POST",
            &format!("/api/v1/billing/remittances/{}/actions", id(primary_remit)),
            json!({"action":"reverse","reason":"Must reverse dependent secondary first"}),
            Some(version(primary_remit))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let matches = json!({"reason":"Reviewed exact synthetic secondary row","matches":[{"row_index":0,"claim_id":id(&tracker),"claim_version":version(&tracker),"account_version":version(account),"writeoff_adjustments":[]}]});
    let matched = ok(
        r,
        a,
        "PUT",
        &format!("{rp}/matches"),
        matches,
        Some(version(&received)),
    )
    .await;
    assert_eq!(matched["issues"], json!([]));
    let posted = ok(
        r,
        a,
        "POST",
        &format!("{rp}/actions"),
        json!({"action":"post","reason":"Post reviewed secondary crossover response"}),
        Some(version(&matched["remittance"])),
    )
    .await;
    let balance: i64 = sqlx::query_scalar(
        "SELECT 10000+sum(effect_cents)::bigint FROM billing_entries WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .fetch_one(db)
    .await
    .unwrap();
    assert_eq!(
        balance,
        if denied { 2000 } else { 500 },
        "denial without explicitPR must not assign new liability or clear existing liability"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_accounts")
            .fetch_one(db)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_entries")
            .fetch_one(db)
            .await
            .unwrap(),
        if denied { 2 } else { 3 }
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM patient_invoice_snapshots")
            .fetch_one(db)
            .await
            .unwrap(),
        0,
        "ERA alone cannot manufacture a patient invoice"
    );
    let current_account: Value = sqlx::query_scalar(
        "SELECT to_jsonb(b) FROM billing_accounts b WHERE tenant_id=$1 AND id=$2",
    )
    .bind(a.tenant_id)
    .bind(id(account))
    .fetch_one(db)
    .await
    .unwrap();
    let invoice=ok(r,a,"POST",&format!("{account_path}/invoices"),json!({"request_id":Uuid::new_v4(),"responsibility_cents":balance,"reason":"Explicit review of remaining synthetic patient share"}),Some(version(&current_account))).await;
    assert_eq!(invoice["snapshot"]["amount_due_cents"], balance);
    let current = ok(r, a, "GET", &cp, json!(null), None).await;
    assert_eq!(
        call(
            r,
            a,
            "POST",
            &format!("{cp}/actions"),
            json!({"action":"withdraw_crossover","reason":"Must first reverse posted secondary"}),
            Some(version(&current["claim"]))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    ok(
        r,
        a,
        "POST",
        &format!("{rp}/actions"),
        json!({"action":"reverse","reason":"Synthetic secondary correction"}),
        Some(version(&posted)),
    )
    .await;
    let reversed = ok(r, a, "GET", &cp, json!(null), None).await;
    ok(r,a,"POST",&format!("{cp}/actions"),json!({"action":"withdraw_crossover","reason":"Synthetic linkage withdrawn after reversal"}),Some(version(&reversed["claim"]))).await;
    ok(r,a,"POST",&format!("/api/v1/billing/remittances/{}/actions",id(primary_remit)),json!({"action":"reverse","reason":"Synthetic primary correction after dependent reversal"}),Some(version(primary_remit))).await;
    let balance: i64 = sqlx::query_scalar(
        "SELECT 10000+sum(effect_cents)::bigint FROM billing_entries WHERE tenant_id=$1",
    )
    .bind(a.tenant_id)
    .fetch_one(db)
    .await
    .unwrap();
    assert_eq!(
        balance, 10000,
        "ordered reversals restore original balance exactly once"
    );
}

#[tokio::test]
async fn denied_secondary_crossover_without_pr_preserves_existing_liability() {
    run_secondary_flow("19", true).await;
}
