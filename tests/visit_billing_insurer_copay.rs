// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic data only. When a plan records no copay, the visit's billing summary may use the
// office-visit copay the insurer last reported for that coverage. Each test runs in its own
// disposable schema.
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

const SECRET: &str = "synthetic-insurer-copay-test-secret";

struct Fixture {
    db: PgPool,
    app: Router,
    owner: Actor,
}

async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("insurer_copay_test_{}", Uuid::new_v4().simple());
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
    let owner = Actor {
        sub: Uuid::new_v4(),
        tenant_id: Uuid::new_v4(),
        role: Role::Owner,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    };
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login','owner',false)")
        .bind(owner.sub).bind(owner.tenant_id).bind(format!("{}@example.test",owner.sub.simple())).execute(&db).await.unwrap();
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), "http://127.0.0.1:8099".into()).unwrap()),
    });
    Fixture { db, app, owner }
}

impl Fixture {
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Value,
        version: Option<i64>,
    ) -> (StatusCode, Value) {
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &self.owner,
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
        let response = self
            .app
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
    async fn ok(&self, method: &str, path: &str, body: Value, version: Option<i64>) -> Value {
        let (status, value) = self.call(method, path, body, version).await;
        assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
        value
    }
    async fn summary(&self, p: Uuid, visit: Uuid) -> Value {
        self.ok(
            "GET",
            &format!("/api/v1/patients/{p}/billing/visit-summary?visit_id={visit}"),
            json!(null),
            None,
        )
        .await
    }
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

/// A synthetic patient with one signed visit and one self-held coverage carrying `copay`.
async fn patient_with_visit(f: &Fixture, copay: Option<i64>) -> (Uuid, Uuid, Uuid) {
    let a = &f.owner;
    let (p, appointment, visit) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Avery','Synthetic','1990-01-01')")
        .bind(a.tenant_id).bind(p).bind(format!("SYN-{}", &p.simple().to_string()[..8]))
        .execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')")
        .bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,'{}'::jsonb,$5,now())")
        .bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub)
        .bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"}))
        .execute(&f.db).await.unwrap();
    let payer = Uuid::new_v4();
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,$3,$2,'synthetic')")
        .bind(a.tenant_id).bind(payer)
        .bind(json!({"name":"Synthetic plan","payer_code":"SYN","active":true}))
        .execute(&f.db).await.unwrap();
    let coverage = Uuid::new_v4();
    sqlx::query("INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,$2,'synthetic')")
        .bind(a.tenant_id).bind(coverage).bind(p).bind(payer)
        .bind(json!({"payer_id":payer,"priority":"primary","status":"active","member_id":"SYNTHETIC-MEMBER","group_number":"SYN-G","plan_name":"Synthetic plan","subscriber_name":"Avery Synthetic","subscriber_birth_date":null,"relationship":"self","effective_date":"2026-01-01","end_date":null,"copay_cents":copay,"verification":"manually_verified","notes":"Synthetic"}))
        .execute(&f.db).await.unwrap();
    (p, visit, coverage)
}

/// The visit's charges, posted against that coverage.
async fn post_charges(f: &Fixture, p: Uuid, visit: Uuid, coverage: Uuid, cents: i64) -> Value {
    let account = f
        .ok(
            "POST",
            &format!("/api/v1/patients/{p}/billing/accounts"),
            json!({"request_id":Uuid::new_v4(),"content":{"visit_id":visit,"coverage_id":coverage,"service_date":"2026-10-25","currency":"USD","notes":"Synthetic","lines":[{"code_system":"CPT","code":"99213","description":"Synthetic service","modifiers":"","units":1,"amount_cents":cents,"diagnosis_codes":["Z00.00"]}]},"reason":"Synthetic charges"}),
            None,
        )
        .await;
    f.ok(
        "POST",
        &format!(
            "/api/v1/patients/{p}/billing/accounts/{}/actions",
            id(&account)
        ),
        json!({"action":"post","reason":"Reviewed synthetic signed visit"}),
        Some(version(&account)),
    )
    .await
}

/// One completed eligibility answer for the coverage, `days_ago` old, reporting `benefits`.
async fn completed_check(
    f: &Fixture,
    p: Uuid,
    coverage: Uuid,
    days_ago: i64,
    benefits: Vec<Value>,
) {
    let answer = json!({"elig":[{"ins_number":"SYNTHETIC-MEMBER","benefit":benefits}]});
    check(f, p, coverage, days_ago, "completed", Some(answer)).await;
}
async fn failed_check(f: &Fixture, p: Uuid, coverage: Uuid, days_ago: i64) {
    check(
        f,
        p,
        coverage,
        days_ago,
        "failed",
        Some(json!({"failure":{"kind":"timeout","http_status":504,"provider_codes":[]}})),
    )
    .await;
}
async fn check(
    f: &Fixture,
    p: Uuid,
    coverage: Uuid,
    days_ago: i64,
    status: &str,
    answer: Option<Value>,
) {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO claimmd_eligibility_checks(tenant_id,id,patient_id,coverage_id,request_id,creation_hash,route_key,request_snapshot,response_snapshot,status,actor_id,created_at,completed_at) VALUES($1,$2,$3,$4,$2,'synthetic','synthetic',$5,$6,$7,$8,now()-make_interval(days=>$9),CASE WHEN $7='pending' THEN NULL ELSE now()-make_interval(days=>$9) END)")
        .bind(f.owner.tenant_id).bind(id).bind(p).bind(coverage)
        .bind(json!({"request":{"service_date":"2026-10-25"},"member_id":"SYNTHETIC-MEMBER"}))
        .bind(answer).bind(status).bind(f.owner.sub).bind(days_ago as i32)
        .execute(&f.db).await.unwrap();
}
fn copay_benefit(service: &str, amount: &str, extra: Value) -> Value {
    let mut row = json!({"benefit_code":service,"benefit_coverage_code":"B","benefit_coverage_description":"Co-Payment","benefit_amount":amount,"inplan_network":"Y"});
    if let Some(map) = extra.as_object() {
        for (key, value) in map {
            row[key] = value.clone();
        }
    }
    row
}

#[tokio::test]
async fn an_insurer_reported_copay_is_used_only_when_the_plan_records_none() {
    let f = setup().await;
    let (p, visit, coverage) = patient_with_visit(&f, None).await;
    post_charges(&f, p, visit, coverage, 10000).await;

    // Before any check: exactly the old behaviour.
    let card = f.summary(p, visit).await;
    assert_eq!(card["patient"]["copay_cents"], Value::Null);
    assert_eq!(
        card["patient"]["responsibility_source"],
        "copay_not_recorded"
    );
    assert_eq!(card["patient"]["owes_now_cents"], 0);
    assert_eq!(card["patient"]["copay_from_insurer_check"], false);
    assert_eq!(card["patient"]["copay_source_date"], Value::Null);

    completed_check(
        &f,
        p,
        coverage,
        3,
        vec![copay_benefit("98", "15", json!(null))],
    )
    .await;
    let card = f.summary(p, visit).await;
    assert_eq!(card["patient"]["copay_cents"], 1500);
    assert_eq!(
        card["patient"]["responsibility_source"],
        "insurer_check_copay"
    );
    assert_eq!(card["patient"]["copay_from_insurer_check"], true);
    assert_eq!(card["patient"]["copay_source_date"], "2026-10-25");
    // The insurer's figure is shown as expected; what the patient owes now is unchanged.
    assert_eq!(card["patient"]["owes_now_cents"], 0);
    assert_eq!(card["patient"]["responsibility_cents"], 0);
    assert_eq!(card["insurance"]["pending_cents"], 10000);

    // A recorded copay always wins: the check is ignored, and the plan's own amount stands.
    let (p2, visit2, coverage2) = patient_with_visit(&f, Some(4000)).await;
    post_charges(&f, p2, visit2, coverage2, 10000).await;
    completed_check(
        &f,
        p2,
        coverage2,
        3,
        vec![copay_benefit("98", "15", json!(null))],
    )
    .await;
    let card = f.summary(p2, visit2).await;
    assert_eq!(card["patient"]["copay_cents"], 4000);
    assert_eq!(card["patient"]["responsibility_source"], "plan_copay");
    assert_eq!(card["patient"]["copay_from_insurer_check"], false);
    assert_eq!(card["patient"]["copay_source_date"], Value::Null);
}

#[tokio::test]
async fn an_old_a_failed_or_conflicting_answer_is_not_used() {
    let f = setup().await;

    // Older than 45 days.
    let (p, visit, coverage) = patient_with_visit(&f, None).await;
    post_charges(&f, p, visit, coverage, 10000).await;
    completed_check(
        &f,
        p,
        coverage,
        46,
        vec![copay_benefit("98", "15", json!(null))],
    )
    .await;
    let card = f.summary(p, visit).await;
    assert_eq!(card["patient"]["copay_cents"], Value::Null);
    assert_eq!(
        card["patient"]["responsibility_source"],
        "copay_not_recorded"
    );
    assert_eq!(card["patient"]["copay_from_insurer_check"], false);

    // The insurer never answered.
    let (p, visit, coverage) = patient_with_visit(&f, None).await;
    post_charges(&f, p, visit, coverage, 10000).await;
    failed_check(&f, p, coverage, 2).await;
    let card = f.summary(p, visit).await;
    assert_eq!(card["patient"]["copay_cents"], Value::Null);
    assert_eq!(
        card["patient"]["responsibility_source"],
        "copay_not_recorded"
    );

    // Copays that disagree are not resolved by picking one.
    let (p, visit, coverage) = patient_with_visit(&f, None).await;
    post_charges(&f, p, visit, coverage, 10000).await;
    completed_check(
        &f,
        p,
        coverage,
        2,
        vec![
            copay_benefit("98", "15", json!({"inplan_network":"Y"})),
            copay_benefit("98", "60", json!({"inplan_network":"N"})),
        ],
    )
    .await;
    let card = f.summary(p, visit).await;
    assert_eq!(card["patient"]["copay_cents"], Value::Null);
    assert_eq!(
        card["patient"]["responsibility_source"],
        "copay_not_recorded"
    );

    // A coinsurance percentage is never a copay.
    let (p, visit, coverage) = patient_with_visit(&f, None).await;
    post_charges(&f, p, visit, coverage, 10000).await;
    completed_check(
        &f,
        p,
        coverage,
        2,
        vec![
            json!({"benefit_code":"30","benefit_coverage_code":"A","benefit_percent":"20","benefit_amount":"40","inplan_network":"Y"}),
        ],
    )
    .await;
    let card = f.summary(p, visit).await;
    assert_eq!(card["patient"]["copay_cents"], Value::Null);
    assert_eq!(
        card["patient"]["responsibility_source"],
        "copay_not_recorded"
    );
}

#[tokio::test]
async fn the_insurer_answer_is_never_written_into_the_coverage() {
    let f = setup().await;
    let (p, visit, coverage) = patient_with_visit(&f, None).await;
    post_charges(&f, p, visit, coverage, 10000).await;
    let before: Value =
        sqlx::query_scalar("SELECT content FROM insurance_coverages WHERE tenant_id=$1 AND id=$2")
            .bind(f.owner.tenant_id)
            .bind(coverage)
            .fetch_one(&f.db)
            .await
            .unwrap();
    let revisions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM coverage_revisions WHERE tenant_id=$1 AND coverage_id=$2",
    )
    .bind(f.owner.tenant_id)
    .bind(coverage)
    .fetch_one(&f.db)
    .await
    .unwrap();

    completed_check(
        &f,
        p,
        coverage,
        2,
        vec![copay_benefit("98", "15", json!(null))],
    )
    .await;
    for _ in 0..3 {
        let card = f.summary(p, visit).await;
        assert_eq!(card["patient"]["copay_cents"], 1500);
    }

    let after: Value =
        sqlx::query_scalar("SELECT content FROM insurance_coverages WHERE tenant_id=$1 AND id=$2")
            .bind(f.owner.tenant_id)
            .bind(coverage)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(after, before, "the coverage record is untouched");
    assert_eq!(after["copay_cents"], Value::Null);
    let later: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM coverage_revisions WHERE tenant_id=$1 AND coverage_id=$2",
    )
    .bind(f.owner.tenant_id)
    .bind(coverage)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(
        later, revisions,
        "reading the visit adds no coverage history"
    );
    // The eligibility evidence itself is unchanged too.
    let checks: i64 =
        sqlx::query_scalar("SELECT count(*) FROM claimmd_eligibility_checks WHERE tenant_id=$1")
            .bind(f.owner.tenant_id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(checks, 1);
    // The insurer's own screen still offers its copay to be saved by hand: using the answer
    // on the visit does not record it behind the practice's back.
    let (status, history) = f
        .call(
            "GET",
            &format!("/api/v1/patients/{p}/coverages/{coverage}/claimmd-eligibility"),
            json!(null),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    assert_eq!(history["items"].as_array().unwrap().len(), 1);
    let offered = history["items"][0]["response_snapshot"].to_string();
    assert!(offered.contains("15"), "{offered}");
    let content: Value =
        sqlx::query_scalar("SELECT content FROM insurance_coverages WHERE tenant_id=$1 AND id=$2")
            .bind(f.owner.tenant_id)
            .bind(coverage)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(content["copay_cents"], Value::Null);
}

/// Charges that are not posted yet, and a visit with no coverage at all, are worded exactly
/// as they were: an insurer's answer only stands in for a plan copay that was never recorded.
#[tokio::test]
async fn an_unposted_visit_and_a_self_pay_visit_are_unchanged() {
    let f = setup().await;
    // Draft charges: no figure is final, so no copay is claimed from the check.
    let (p, visit, coverage) = patient_with_visit(&f, None).await;
    let account = f
        .ok(
            "POST",
            &format!("/api/v1/patients/{p}/billing/accounts"),
            json!({"request_id":Uuid::new_v4(),"content":{"visit_id":visit,"coverage_id":coverage,"service_date":"2026-10-25","currency":"USD","notes":"Synthetic","lines":[{"code_system":"CPT","code":"99213","description":"Synthetic service","modifiers":"","units":1,"amount_cents":10000,"diagnosis_codes":["Z00.00"]}]},"reason":"Synthetic charges"}),
            None,
        )
        .await;
    completed_check(
        &f,
        p,
        coverage,
        2,
        vec![copay_benefit("98", "15", json!(null))],
    )
    .await;
    let card = f.summary(p, visit).await;
    assert_eq!(card["account"]["status"], "draft");
    assert_eq!(card["patient"]["copay_cents"], Value::Null);
    assert_eq!(card["patient"]["responsibility_source"], "not_final");
    assert_eq!(card["patient"]["copay_from_insurer_check"], false);
    let _ = account;

    // Self-pay: nothing is insured, so the whole charge is the patient's.
    let (p, appointment, visit) = {
        let a = &f.owner;
        let (p, appointment, visit) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Avery','Synthetic','1990-01-01')")
            .bind(a.tenant_id).bind(p).bind(format!("SYN-{}", &p.simple().to_string()[..8]))
            .execute(&f.db).await.unwrap();
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')")
            .bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(&f.db).await.unwrap();
        sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,'{}'::jsonb,$5,now())")
            .bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub)
            .bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"}))
            .execute(&f.db).await.unwrap();
        (p, appointment, visit)
    };
    let _ = appointment;
    let account = f
        .ok(
            "POST",
            &format!("/api/v1/patients/{p}/billing/accounts"),
            json!({"request_id":Uuid::new_v4(),"content":{"visit_id":visit,"coverage_id":null,"service_date":"2026-10-25","currency":"USD","notes":"Synthetic","lines":[{"code_system":"CPT","code":"99213","description":"Synthetic service","modifiers":"","units":1,"amount_cents":10000,"diagnosis_codes":["Z00.00"]}]},"reason":"Synthetic charges"}),
            None,
        )
        .await;
    f.ok(
        "POST",
        &format!(
            "/api/v1/patients/{p}/billing/accounts/{}/actions",
            id(&account)
        ),
        json!({"action":"post","reason":"Reviewed synthetic signed visit"}),
        Some(version(&account)),
    )
    .await;
    let card = f.summary(p, visit).await;
    assert_eq!(card["patient"]["copay_cents"], Value::Null);
    assert_eq!(card["patient"]["responsibility_source"], "self_pay");
    assert_eq!(card["patient"]["owes_now_cents"], 10000);
    assert_eq!(card["patient"]["copay_from_insurer_check"], false);
}
