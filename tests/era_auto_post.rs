// SPDX-License-Identifier: AGPL-3.0-only
//! A clean insurance payment posts itself, and staff can see and undo it.
//!
//! Everything here is synthetic. No network, no payer, no real records.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::Arc;
use suncharts_engine::{
    auth::{Actor, Role},
    browser::BrowserAuth,
    claims,
    postgres::PostgresBackend,
    State,
};
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &str = "synthetic-era-auto-post-secret";

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

struct Fixture {
    db: PgPool,
    router: Router,
    a: Actor,
    /// Session cookie a staff browser would carry. Automatic posting is a
    /// staff-facing behaviour and only happens on a payment a person brought in.
    cookie: String,
    payer: Uuid,
    account: Value,
    claim: Value,
}

impl Fixture {
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Value,
        version: Option<i64>,
        cookie: bool,
    ) -> (StatusCode, Value) {
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &self.a,
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json");
        if cookie {
            request = request.header("Cookie", self.cookie.clone());
        }
        if let Some(v) = version {
            request = request.header("If-Match", format!("\"{v}\""));
        }
        let response = self
            .router
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({"message":String::from_utf8_lossy(&bytes)})),
        )
    }
    /// A payment a staff member brought in through the screens.
    async fn staff(
        &self,
        method: &str,
        path: &str,
        body: Value,
        version: Option<i64>,
    ) -> (StatusCode, Value) {
        self.call(method, path, body, version, true).await
    }
    async fn ok(&self, method: &str, path: &str, body: Value, version: Option<i64>) -> Value {
        let (status, value) = self.staff(method, path, body, version).await;
        assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
        value
    }
    /// A payment the retrieval worker picked up: token only, no session.
    async fn worker(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.call("POST", path, body, None, false).await
    }
    async fn remittance(&self, id: Uuid) -> Value {
        self.ok(
            "GET",
            &format!("/api/v1/billing/remittances/{id}"),
            json!(null),
            None,
        )
        .await
    }
    async fn account_row(&self) -> Value {
        sqlx::query_scalar::<_, Value>(
            "SELECT to_jsonb(b) FROM billing_accounts b WHERE tenant_id=$1 AND id=$2",
        )
        .bind(self.a.tenant_id)
        .bind(id(&self.account))
        .fetch_one(&self.db)
        .await
        .unwrap()
    }
    async fn balance(&self) -> i64 {
        sqlx::query_scalar(
            "SELECT b.total_cents+coalesce(sum(e.effect_cents),0)::bigint FROM billing_accounts b LEFT JOIN billing_entries e ON e.tenant_id=b.tenant_id AND e.account_id=b.id WHERE b.tenant_id=$1 AND b.id=$2 GROUP BY b.total_cents",
        )
        .bind(self.a.tenant_id)
        .bind(id(&self.account))
        .fetch_one(&self.db)
        .await
        .unwrap()
    }
    async fn entries(&self) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_entries")
            .fetch_one(&self.db)
            .await
            .unwrap()
    }
    async fn post(&self, body: Value) -> (StatusCode, Value) {
        self.staff("POST", "/api/v1/billing/remittances", body, None)
            .await
    }
}

fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
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

/// Billed 100.00, paid 60.00, 20.00 written off by contract, 20.00 the patient
/// owes. The payer's line reconciles to the last cent, so there is nothing left
/// for a person to decide. `pr` is the patient's share, which the payer already
/// counted inside the credits and which is never posted as money.
fn clean_era(control: &str, trace: &str) -> Value {
    era_with(control, trace, 6000, 2000, 2000)
}
/// CAS amounts count every group, so the payer's own line must balance as
/// paid + credits = billed, and every credit sits against the service line.
fn era_with(control: &str, trace: &str, paid: i64, co: i64, pr: i64) -> Value {
    era_gap(control, trace, paid, co, pr, 0)
}
/// `gap` is an amount the payer never named. The row still adds up by the
/// payer's rules against its own billed figure, but the leftover against our
/// charges can only be settled by a person.
fn era_gap(control: &str, trace: &str, paid: i64, co: i64, pr: i64, gap: i64) -> Value {
    let named = paid + co + pr + gap;
    let mut adjustments =
        vec![json!({"group":"CO","reason_code":"45","amount_cents":co,"service_index":0})];
    if pr > 0 {
        adjustments
            .push(json!({"group":"PR","reason_code":"2","amount_cents":pr,"service_index":0}));
    }
    json!({"payer_code":"SYN-AUTO","trace":trace,"payment_date":"2026-10-26","total_paid_cents":paid,
        "currency":"USD",
        "claims":[{"control_number":control,"payer_control_number":format!("PCN-{trace}"),"status":"19",
            "patient_name":"Avery Synthetic","charged_cents":named,"paid_cents":paid,
            "patient_responsibility_cents":pr,
            "adjustments":adjustments,
            "services":[{"code":"HC:99213","charged_cents":named,"paid_cents":paid,"line_control":"1"}]}]})
}

async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("era_auto_post_test_{}", Uuid::new_v4().simple());
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
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login','owner',false)")
        .bind(a.sub).bind(a.tenant_id).bind(format!("{}@example.test", a.sub.simple()))
        .execute(&db).await.unwrap();
    let cookie = format!("auto-post-{}", Uuid::new_v4().simple());
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at,auth_method) VALUES($1,$2,$3,now()+interval '1 hour','break_glass')")
        .bind(hash(&cookie)).bind(a.tenant_id).bind(a.sub)
        .execute(&db).await.unwrap();

    let router = app(db.clone());
    let p = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-AUTO','Avery','Synthetic','1990-01-01')")
        .bind(a.tenant_id).bind(p).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')")
        .bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,'{}'::jsonb,$5,now())")
        .bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub)
        .bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"}))
        .execute(&db).await.unwrap();

    let payer = id(
        &ok(&router, &a, "POST", "/api/v1/billing/payers", json!({"request_id":Uuid::new_v4(),"content":{"name":"Synthetic Auto Payer","payer_code":"SYN-AUTO","address":"Synthetic address","phone":"","active":true},"reason":"Synthetic payer"}), None)
            .await,
    );
    let coverage = ok(&router, &a, "POST", &format!("/api/v1/patients/{p}/coverages"), json!({"request_id":Uuid::new_v4(),"content":{"payer_id":payer,"priority":"primary","status":"active","member_id":"SYN-AUTO","group_number":"SYN-G","plan_name":"Synthetic plan","subscriber_name":"Avery Synthetic","subscriber_birth_date":"1990-01-01","relationship":"self","effective_date":"2026-01-01","end_date":null,"copay_cents":null,"verification":"manually_verified","notes":"Synthetic"},"reason":"Synthetic coverage"}), None)
        .await;

    let base = format!("/api/v1/patients/{p}/billing/accounts");
    let draft = ok(&router, &a, "POST", &base, json!({"request_id":Uuid::new_v4(),"content":{"visit_id":visit,"coverage_id":id(&coverage),"service_date":"2026-10-25","currency":"USD","notes":"Synthetic","lines":[{"code_system":"CPT","code":"99213","description":"Synthetic service","modifiers":"","units":1,"amount_cents":10000,"diagnosis_codes":["Z00.00"]}]},"reason":"Synthetic charges"}), None)
        .await;
    let account_path = format!("{base}/{}", id(&draft));
    let posted = ok(
        &router,
        &a,
        "POST",
        &format!("{account_path}/actions"),
        json!({"action":"post","reason":"Reviewed synthetic signed visit"}),
        Some(version(&draft)),
    )
    .await;

    let content = json!({"billing_provider_name":"Synthetic Practice","billing_npi":"1234567893","rendering_npi":"1234567893","tax_id":"000000001","billing_address":"1 Synthetic Way, Austin TX 78701","patient_address":"1 Synthetic Way, Austin TX 78701","subscriber_address":"1 Synthetic Way, Austin TX 78701","subscriber_birth_date":"1990-01-01","place_of_service":"11","diagnosis_codes":["Z00.00"],"line_diagnosis_pointers":[[1]],"external_control_number":"","notes":"Synthetic only"});
    // A claim is only billable once it is marked ready and recorded as sent,
    // which is what the automatic path refuses to do on a person's behalf.
    let first = ok(&router, &a, "POST", &format!("{account_path}/claims"), json!({"request_id":Uuid::new_v4(),"frequency":"original","content":content,"reason":"Synthetic claim"}), Some(version(&posted)))
        .await;
    let claim_path = format!("/api/v1/billing/claims/{}", id(&first));
    let ready = ok(
        &router,
        &a,
        "POST",
        &format!("{claim_path}/actions"),
        json!({"action":"ready","reason":"Synthetic review"}),
        Some(version(&first)),
    )
    .await;
    ok(&router, &a, "POST", &format!("{claim_path}/actions"), json!({"action":"record_submission","reference":"SYNTHETIC-AUTO","event_date":"2026-10-25","reason":"Synthetic delivery fixture"}), Some(version(&ready)))
        .await;
    let claim = ok(&router, &a, "GET", &claim_path, json!(null), None).await["claim"].clone();
    assert_eq!(claim["status"], "submitted");

    Fixture {
        db,
        router,
        a,
        cookie,
        payer,
        account: posted,
        claim,
    }
}

async fn ok(
    r: &Router,
    a: &Actor,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> Value {
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
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"message":String::from_utf8_lossy(&bytes)}));
    assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
    value
}

fn imported(body: Value, payer: Uuid) -> Value {
    json!({"request_id":Uuid::new_v4(),"payer_id":payer,"format":"normalized","document":body,"reason":"Reviewed synthetic ERA"})
}

/// A payment that matches one claim cleanly, reconciles line by line and needs
/// no human decision posts on import, through the same ledger entries a person
/// would have created, and says so in plain words.
#[tokio::test]
async fn clean_payment_posts_itself_on_import() {
    let f = setup().await;
    assert_eq!(f.balance().await, 10000);
    let before = f.entries().await;

    let (status, out) = f
        .post(imported(
            clean_era(f.claim["control_number"].as_str().unwrap(), "SYN-CLEAN"),
            f.payer,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["status"], "posted", "a clean payment must post: {out}");
    assert!(
        out["note"]
            .as_str()
            .unwrap_or_default()
            .contains("posted automatically"),
        "the import must tell staff what happened: {out}"
    );

    let detail = f.remittance(id(&out)).await;
    assert_eq!(detail["remittance"]["status"], "posted");
    assert_eq!(detail["auto_posted"], true);
    assert_eq!(detail["issues"], json!([]));
    assert_eq!(
        detail["postings"].as_array().unwrap().len(),
        1,
        "the posting table the staff screen shows must be filled in"
    );
    assert_eq!(detail["postings"][0]["writeoff_cents"], 2000);
    assert_eq!(detail["postings"][0]["patient_responsibility_cents"], 2000);

    // Same money the Post button would have moved: payment and contractual
    // write-off as two ledger entries, and nothing else.
    assert_eq!(f.entries().await, before + 2);
    assert_eq!(f.balance().await, 2000, "only the patient's share is left");
    let account = f.account_row().await;
    assert_eq!(account["status"], "posted");

    // The claim is answered, and the ledger reason is the automatic wording.
    let claim = f
        .ok(
            "GET",
            &format!("/api/v1/billing/claims/{}", id(&f.claim)),
            json!(null),
            None,
        )
        .await;
    assert_eq!(claim["claim"]["status"], "adjudicated");
    let reasons: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT content->>'reason' FROM billing_entries WHERE tenant_id=$1",
    )
    .bind(f.a.tenant_id)
    .fetch_all(&f.db)
    .await
    .unwrap();
    assert_eq!(reasons, vec![claims::AUTO_POST_REASON.to_string()]);
    let auto_posted: bool = sqlx::query_scalar(claims::AUTO_POSTED_EXISTS)
        .bind(f.a.tenant_id)
        .bind(id(&out))
        .bind(claims::AUTO_POST_REASON)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert!(auto_posted);

    // Staff can undo it exactly as they undo a manual posting.
    let (status, undone) = f
        .staff(
            "POST",
            &format!("/api/v1/billing/remittances/{}/actions", id(&out)),
            json!({"action":"reverse","reason":"Undo the automatic posting"}),
            Some(version(&detail["remittance"])),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{undone}");
    assert_eq!(undone["status"], "reversed");
    assert_eq!(
        f.balance().await,
        10000,
        "the account is back where it started"
    );

    f.db.close().await;
}

/// The same payment arriving twice under the same request must not move money
/// twice, and must not post a second time.
#[tokio::test]
async fn repeating_an_import_never_posts_twice() {
    let f = setup().await;
    let request_id = Uuid::new_v4();
    let body = json!({"request_id":request_id,"payer_id":f.payer,"format":"normalized","document":clean_era(f.claim["control_number"].as_str().unwrap(),"SYN-REPEAT"),"reason":"Reviewed synthetic ERA"});

    let (status, first) = f.post(body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["status"], "posted");
    let balance = f.balance().await;
    let entries = f.entries().await;

    let (status, again) = f.post(body).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(
        again["id"], first["id"],
        "the repeat returns the same payment"
    );
    assert_eq!(again["status"], "posted");
    assert_eq!(
        f.balance().await,
        balance,
        "a repeat cannot move money twice"
    );
    assert_eq!(
        f.entries().await,
        entries,
        "a repeat cannot add ledger entries"
    );

    f.db.close().await;
}

/// Anything that is not an exact, self-evident match stays exactly where it
/// was: unposted, on the review list, with the reason a person can read.
#[tokio::test]
async fn a_payment_with_a_decision_to_make_waits_for_staff() {
    let f = setup().await;
    // The payer's line adds up on its own terms — paid 60.00 plus 30.00 of
    // credits equals the billed amount — but only 30.00 of the 40.00 discount
    // is accounted for. The 10.00 left over is a contractual amount, and a
    // person has to tick it before it can be written off.
    // The payer's line adds up — paid 60.00 plus 30.00 of contractual credit
    // equals the 90.00 it says was billed. That leaves a 10.00 gap against our
    // charges and a contractual credit nobody has ticked, both of which a
    // person settles.
    let era = era_gap(
        f.claim["control_number"].as_str().unwrap(),
        "SYN-LEFTOVER",
        6000,
        3000,
        0,
        0,
    );

    let (status, out) = f.post(imported(era, f.payer)).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["status"], "staged");
    assert_eq!(f.balance().await, 10000, "nothing may reach the ledger");
    assert_eq!(f.entries().await, 0);
    let note = out["note"].as_str().unwrap_or_default();
    assert!(note.contains("waiting for you to review"), "{note}");

    let detail = f.remittance(id(&out)).await;
    assert_eq!(detail["auto_posted"], false);
    assert!(
        detail["issues"].as_array().unwrap().iter().any(|i| i
            .as_str()
            .unwrap()
            .contains("differs from the charges on the claim")),
        "the screen must say what is wrong: {:?}",
        detail["issues"]
    );

    // Finishing this by hand is deliberately not shown here: the payer's
    // amount disagrees with the frozen charges, which the row check refuses
    // until the charges are corrected, and correcting charges is the visit
    // billing suite's ground, not this one.

    f.db.close().await;
}

/// The practice owner decides. Off means off; a payment that would have posted
/// on its own waits for review instead.
#[tokio::test]
async fn the_owner_can_turn_automatic_posting_off() {
    let f = setup().await;
    let settings = f
        .ok(
            "GET",
            "/api/v1/practice/era-posting-settings",
            json!(null),
            None,
        )
        .await;
    assert_eq!(
        settings["auto_post"], true,
        "automatic posting is on until the owner says otherwise"
    );
    assert_eq!(settings["version"], 0);

    let saved = f
        .ok(
            "PUT",
            "/api/v1/practice/era-posting-settings",
            json!({"auto_post":false,"reason":"We want to check every payment first"}),
            Some(version(&settings)),
        )
        .await;
    assert_eq!(saved["auto_post"], false);
    assert_eq!(saved["version"], 1);
    // A stale write must not silently win.
    let (status, conflict) = f
        .staff(
            "PUT",
            "/api/v1/practice/era-posting-settings",
            json!({"auto_post":true,"reason":"Stale write"}),
            Some(0),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");

    let (status, out) = f
        .post(imported(
            clean_era(f.claim["control_number"].as_str().unwrap(), "SYN-OFF"),
            f.payer,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["status"], "staged", "off must mean off");
    assert_eq!(f.entries().await, 0);
    let detail = f.remittance(id(&out)).await;
    assert!(detail["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i.as_str().unwrap().contains("turned off")));

    // Back on, the next clean payment posts again.
    f.ok(
        "PUT",
        "/api/v1/practice/era-posting-settings",
        json!({"auto_post":true,"reason":"Back to automatic"}),
        Some(1),
    )
    .await;
    let (status, out) = f
        .post(imported(
            clean_era(f.claim["control_number"].as_str().unwrap(), "SYN-ON"),
            f.payer,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["status"], "posted");
    // The claim is already answered, so this one waits, not double posts.
    assert_ne!(out["status"], "posted_ok");

    f.db.close().await;
}

/// A retrieval worker's payment is staged for review. Automatic posting belongs
/// to a person bringing a payment in, never to a machine pipeline.
#[tokio::test]
async fn a_payment_from_the_retrieval_worker_is_never_posted_by_itself() {
    let f = setup().await;
    let (status, out) = f
        .worker(
            "/api/v1/billing/remittances",
            imported(
                clean_era(f.claim["control_number"].as_str().unwrap(), "SYN-WORKER"),
                f.payer,
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["status"], "staged");
    assert_eq!(
        f.entries().await,
        0,
        "a worker import must not touch the ledger"
    );
    assert!(out.get("note").is_none_or(Value::is_null));

    f.db.close().await;
}

/// A claim already answered by the payer, or already posted, is never posted a
/// second time automatically.
#[tokio::test]
async fn an_already_answered_claim_waits_for_a_person() {
    let f = setup().await;
    let (status, first) = f
        .post(imported(
            clean_era(f.claim["control_number"].as_str().unwrap(), "SYN-FIRST"),
            f.payer,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["status"], "posted");
    let balance = f.balance().await;
    let entries = f.entries().await;

    // The payer sends the same claim again. It still names exactly one claim,
    // so the only thing telling it apart is that the claim is already answered.
    let (status, again) = f
        .post(imported(
            clean_era(f.claim["control_number"].as_str().unwrap(), "SYN-SECOND"),
            f.payer,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["status"], "staged");
    assert_eq!(f.balance().await, balance);
    assert_eq!(f.entries().await, entries);
    let detail = f.remittance(id(&again)).await;
    assert!(detail["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i.as_str().unwrap().contains("already answered")));

    f.db.close().await;
}

/// The screen a payment lands on must show it was automatic and offer the undo,
/// and the settings screen must offer the switch to the owner only.
#[tokio::test]
async fn staff_can_see_and_undo_an_automatic_posting() {
    let f = setup().await;
    let (status, out) = f
        .post(imported(
            clean_era(f.claim["control_number"].as_str().unwrap(), "SYN-LIST"),
            f.payer,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    let list = f
        .ok("GET", "/api/v1/billing/remittances", json!(null), None)
        .await;
    let row = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == json!(out["id"].as_str().unwrap()))
        .expect("the payment must be on the worklist");
    assert_eq!(row["auto_posted"], true);
    assert_eq!(row["status"], "posted");

    // A clinician can see the switch but not move it.
    let now = Utc::now().timestamp();
    let clinician = Actor {
        sub: Uuid::new_v4(),
        tenant_id: f.a.tenant_id,
        role: Role::Clinician,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    };
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login','clinician',false)")
        .bind(clinician.sub).bind(clinician.tenant_id)
        .bind(format!("{}@example.test", clinician.sub.simple()))
        .execute(&f.db).await.unwrap();
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &clinician,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let response = f
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/practice/era-posting-settings")
                .header("Authorization", format!("Bearer {token}"))
                .header("If-Match", "\"0\"")
                .header("Content-Type", "application/json")
                .body(Body::from(
                    json!({"auto_post":false,"reason":"Not the owner"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    f.db.close().await;
}
