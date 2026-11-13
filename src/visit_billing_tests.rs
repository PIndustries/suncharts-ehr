// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic data only. Each test runs in its own disposable schema.
use crate::{
    auth::{Actor, Role},
    browser::BrowserAuth,
    postgres::PostgresBackend,
    State,
};
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
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &str = "synthetic-visit-billing-test-secret";

struct Fixture {
    db: PgPool,
    app: Router,
    owner: Actor,
}
async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("visit_billing_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    crate::test_db::create_schema(&base, &schema).await;
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
    crate::MIGRATOR.run(&db).await.unwrap();
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
    user(&db, &owner, owner.sub, "owner").await;
    let app = crate::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), "http://127.0.0.1:8099".into()).unwrap()),
    });
    Fixture { db, app, owner }
}
async fn user(db: &PgPool, a: &Actor, id: Uuid, role: &str) {
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login',$4,false)").bind(id).bind(a.tenant_id).bind(format!("{}@example.test",id.simple())).bind(role).execute(db).await.unwrap();
}
impl Fixture {
    async fn staff(&self, role: Role, name: &str) -> Actor {
        let actor = Actor {
            sub: Uuid::new_v4(),
            role,
            ..self.owner.clone()
        };
        user(&self.db, &actor, actor.sub, name).await;
        actor
    }
    async fn call(
        &self,
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
        let (status, value) = self.call(&self.owner, method, path, body, version).await;
        assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
        value
    }
    /// A synthetic patient with one appointment and its visit.
    async fn visit(&self, signed: bool) -> (Uuid, Uuid, Uuid) {
        let (a, db) = (&self.owner, &self.db);
        let (p, appointment, visit) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Avery','Synthetic','1990-01-01')").bind(a.tenant_id).bind(p).bind(format!("SYN-{}",&p.simple().to_string()[..8])).execute(db).await.unwrap();
        sqlx::query("INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,$3)").bind(a.tenant_id).bind(p).bind(json!({"address":{"line1":"1 Synthetic Way","city":"Austin","region":"TX","postal_code":"78701","country":"US"}})).execute(db).await.unwrap();
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')").bind(a.tenant_id).bind(appointment).bind(p).bind(a.sub).execute(db).await.unwrap();
        if signed {
            sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,'{}'::jsonb,$5,now())").bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub).bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"})).execute(db).await.unwrap();
        } else {
            sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id) VALUES($1,$2,$3,$4,$5)").bind(a.tenant_id).bind(visit).bind(p).bind(appointment).bind(a.sub).execute(db).await.unwrap();
        }
        (p, appointment, visit)
    }
    async fn coverage(
        &self,
        p: Uuid,
        priority: &str,
        code: &str,
        copay: Option<i64>,
    ) -> (Value, Value) {
        let payer=self.ok("POST","/api/v1/billing/payers",json!({"request_id":Uuid::new_v4(),"content":{"name":format!("Synthetic {priority} plan"),"payer_code":code,"address":"Synthetic address","phone":"","active":true},"reason":"Synthetic payer"}),None).await;
        let policy=self.ok("POST",&format!("/api/v1/patients/{p}/coverages"),json!({"request_id":Uuid::new_v4(),"content":{"payer_id":id(&payer),"priority":priority,"status":"active","member_id":format!("SYN-{priority}"),"group_number":"SYN-G","plan_name":"Synthetic plan","subscriber_name":"Avery Synthetic","subscriber_birth_date":null,"relationship":"self","effective_date":"2026-01-01","end_date":null,"copay_cents":copay,"verification":"manually_verified","notes":"Synthetic"},"reason":"Synthetic coverage"}),None).await;
        (payer, policy)
    }
    async fn charges(&self, p: Uuid, visit: Uuid, coverage: Option<Uuid>, cents: i64) -> Value {
        self.ok("POST",&format!("/api/v1/patients/{p}/billing/accounts"),json!({"request_id":Uuid::new_v4(),"content":{"visit_id":visit,"coverage_id":coverage,"service_date":"2026-10-25","currency":"USD","notes":"Synthetic","lines":[{"code_system":"CPT","code":"99213","description":"Synthetic service","modifiers":"","units":1,"amount_cents":cents,"diagnosis_codes":["Z00.00 - Synthetic exam"]}]},"reason":"Synthetic charges"}),None).await
    }
    async fn post(&self, p: Uuid, account: &Value) -> Value {
        self.ok(
            "POST",
            &format!(
                "/api/v1/patients/{p}/billing/accounts/{}/actions",
                id(account)
            ),
            json!({"action":"post","reason":"Reviewed synthetic signed visit"}),
            Some(version(account)),
        )
        .await
    }
    async fn summary(&self, a: &Actor, p: Uuid, visit: Uuid) -> Value {
        let (status, value) = self
            .call(
                a,
                "GET",
                &format!("/api/v1/patients/{p}/billing/visit-summary?visit_id={visit}"),
                json!(null),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{value}");
        value
    }
    async fn prepare(&self, a: &Actor, p: Uuid, account: Uuid, body: Value) -> (StatusCode, Value) {
        self.call(
            a,
            "POST",
            &format!("/api/v1/patients/{p}/billing/accounts/{account}/claims/prepare"),
            body,
            None,
        )
        .await
    }
    /// The practice directory a claim is filled in from.
    async fn directory(&self, organization: bool) {
        let (a, db) = (&self.owner, &self.db);
        sqlx::query("INSERT INTO practice_providers(tenant_id,id,display_name,npi) VALUES($1,$2,'Synthetic Clinician','1234567893')").bind(a.tenant_id).bind(a.sub).execute(db).await.unwrap();
        sqlx::query("INSERT INTO practice_facilities(tenant_id,id,name,address) VALUES($1,$2,'Synthetic Clinic','1 Synthetic Way, Austin TX 78701')").bind(a.tenant_id).bind(Uuid::new_v4()).execute(db).await.unwrap();
        if organization {
            let id = Uuid::new_v4();
            let sealed = crate::provider_settings::seal_secret(
                db,
                a.tenant_id,
                id,
                "billing-organization-tax",
                "000000017",
            )
            .await
            .unwrap();
            sqlx::query("INSERT INTO practice_billing_organizations(tenant_id,id,name,tax_id_type,encrypted_tax_id,tax_id_last4) VALUES($1,$2,'Synthetic Billing Organization','E',$3,'0017')").bind(a.tenant_id).bind(id).bind(sealed).execute(db).await.unwrap();
        }
    }
    async fn claim(&self, claim: &Value) -> Value {
        self.ok(
            "GET",
            &format!("/api/v1/billing/claims/{}", claim.as_str().unwrap()),
            json!(null),
            None,
        )
        .await["claim"]
            .clone()
    }
    /// Mark ready and record that it was sent, as a person does.
    async fn send(&self, claim_id: &Value) -> Value {
        self.send_with(claim_id, false).await
    }
    /// `delivered` also records a delivered claim file, which billing a secondary needs.
    /// The delivery is injected evidence; no network call is made.
    async fn send_with(&self, claim_id: &Value, delivered: bool) -> Value {
        let path = format!(
            "/api/v1/billing/claims/{}/actions",
            claim_id.as_str().unwrap()
        );
        let claim = self.claim(claim_id).await;
        let ready = self
            .ok(
                "POST",
                &path,
                json!({"action":"ready","reason":"Synthetic review"}),
                Some(version(&claim)),
            )
            .await;
        if delivered {
            let address = json!({"line1":"1 Synthetic Way","line2":"","city":"Austin","state":"TX","postal_code":"78701"});
            let details = json!({"billing_address":address,"subscriber_address":address,"patient_address":address,"payer_address":address,"subscriber_given_name":"Avery","subscriber_family_name":"Synthetic","patient_sex":"U","subscriber_sex":"U","rendering_given_name":"Synthetic","rendering_family_name":"Clinician","billing_taxonomy":"208D00000X","filing_indicator":"CI","signature_on_file":true,"benefits_assigned":true,"release_authorized":true,"routine_professional_reviewed":true});
            let partner = self.ok("POST","/api/v1/billing/clearinghouses",json!({"request_id":Uuid::new_v4(),"content":{"name":"Synthetic transport","active":true,"sender_qualifier":"ZZ","sender_id":"SYN-SEND","receiver_qualifier":"ZZ","receiver_id":"SYN-RECV","application_sender":"SYN-SEND","application_receiver":"SYN-RECV","submitter_name":"Synthetic Clinic","submitter_id":"SYN-CLINIC","receiver_name":"Synthetic Receiver","receiver_identifier":"SYN-R","contact_name":"Synthetic Contact","contact_phone":"5125550101","usage":"T","guide_reference":"Synthetic contract"},"reason":"Synthetic partner"}),None).await;
            let file = self.ok("POST", &format!("/api/v1/billing/claims/{}/837p", claim_id.as_str().unwrap()), json!({"request_id":Uuid::new_v4(),"partner_id":id(&partner),"partner_version":version(&partner),"details":details,"reason":"Synthetic generated evidence only"}), Some(version(&ready))).await;
            sqlx::query(
                "UPDATE edi_submissions SET status='delivered' WHERE tenant_id=$1 AND id=$2",
            )
            .bind(self.owner.tenant_id)
            .bind(id(&file))
            .execute(&self.db)
            .await
            .unwrap();
        }
        self.ok("POST", &path, json!({"action":"record_submission","reference":"SYNTHETIC-TRANSPORT","event_date":"2026-10-25","reason":"Synthetic delivery fixture"}), Some(version(&ready))).await
    }
    /// Import, match and post one insurer response for a claim.
    #[allow(clippy::too_many_arguments)]
    async fn respond(
        &self,
        p: Uuid,
        payer: &Value,
        claim: &Value,
        charged: i64,
        paid: i64,
        patient: i64,
        status: &str,
        trace: &str,
    ) {
        let account = self
            .ok(
                "GET",
                &format!("/api/v1/patients/{p}/billing"),
                json!(null),
                None,
            )
            .await["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == claim["account_id"])
            .unwrap()
            .clone();
        let writeoff = charged - paid - patient;
        let mut adjustments = vec![];
        if writeoff > 0 {
            // A secondary insurer reports what the primary already settled as prior-payer impact.
            adjustments.push(json!({"group":if status=="2" {"OA"} else {"CO"},"reason_code":match status {"4"=>"29","2"=>"23",_=>"45"},"amount_cents":writeoff,"service_index":0}));
        }
        if patient > 0 {
            adjustments.push(
                json!({"group":"PR","reason_code":"2","amount_cents":patient,"service_index":0}),
            );
        }
        let remit = self.ok("POST","/api/v1/billing/remittances",json!({"request_id":Uuid::new_v4(),"payer_id":id(payer),"format":"normalized","document":{"payer_code":payer["content"]["payer_code"],"trace":trace,"payment_date":"2026-10-26","total_paid_cents":paid,"currency":"USD","claims":[{"control_number":claim["control_number"],"payer_control_number":format!("PCN-{trace}"),"status":status,"patient_name":"Avery Synthetic","charged_cents":charged,"paid_cents":paid,"patient_responsibility_cents":patient,"adjustments":adjustments,"services":[{"code":"HC:99213","charged_cents":charged,"paid_cents":paid,"line_control":"1"}]}]},"reason":"Reviewed synthetic ERA"}),None).await;
        let path = format!("/api/v1/billing/remittances/{}", id(&remit));
        // A denial's contractual amount stays on the balance; a payment's is written off.
        let chosen: Vec<usize> = if writeoff > 0 && status == "1" {
            vec![0]
        } else {
            vec![]
        };
        let matched = self.ok("PUT",&format!("{path}/matches"),json!({"reason":"Reviewed synthetic match","matches":[{"row_index":0,"claim_id":claim["id"],"claim_version":version(claim),"account_version":version(&account),"writeoff_adjustments":chosen}]}),Some(version(&remit))).await;
        assert_eq!(
            matched["issues"],
            json!([]),
            "synthetic match must reconcile"
        );
        self.ok(
            "POST",
            &format!("{path}/actions"),
            json!({"action":"post","reason":"Post reviewed synthetic payment"}),
            Some(version(&matched["remittance"])),
        )
        .await;
    }
    async fn pay(&self, p: Uuid, account: Uuid, cents: i64) {
        let current = self
            .ok(
                "GET",
                &format!("/api/v1/patients/{p}/billing"),
                json!(null),
                None,
            )
            .await["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == json!(account))
            .unwrap()
            .clone();
        self.ok("POST",&format!("/api/v1/patients/{p}/billing/accounts/{account}/entries"),json!({"request_id":Uuid::new_v4(),"kind":"payment","amount_cents":cents,"reverses_id":null,"party":"patient","method":"cash","reference":"SYN-CASH","occurred_on":"2026-10-26","reason":"Synthetic patient payment"}),Some(version(&current))).await;
    }
    async fn copay(&self, p: Uuid, appointment: Uuid, cents: i64) {
        self.ok("POST",&format!("/api/v1/patients/{p}/billing/copays"),json!({"request_id":Uuid::new_v4(),"appointment_id":appointment,"coverage_id":null,"amount_cents":cents,"method":"cash","reference":"","occurred_on":"2026-10-25","reason":"Synthetic copay at the desk","received_confirmed":true}),None).await;
    }
    async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sql)
            .bind(self.owner.tenant_id)
            .fetch_one(&self.db)
            .await
            .unwrap()
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
/// Every summary must add up: charges less what was paid and adjusted is the balance,
/// and the balance is split between the insurer and the patient with nothing left over.
fn adds_up(s: &Value) {
    if s["balance_cents"].is_null() {
        return;
    }
    let n = |v: &Value| v.as_i64().unwrap();
    let (i, p) = (&s["insurance"], &s["patient"]);
    assert_eq!(
        n(&s["charges_cents"])
            - n(&i["paid_cents"])
            - n(&i["adjusted_cents"])
            - n(&p["receipts_applied_cents"])
            - n(&p["other_payments_cents"])
            - n(&p["adjustment_cents"]),
        n(&s["balance_cents"]),
        "{s}"
    );
    assert_eq!(
        n(&i["pending_cents"]) + n(&i["unassigned_cents"]) + n(&p["owes_now_cents"]),
        n(&s["balance_cents"]).max(0),
        "{s}"
    );
}

#[tokio::test]
async fn self_pay_visit_moves_from_charges_to_paid_in_full_and_never_prepares_a_claim() {
    let f = setup().await;
    let (p, appointment, visit) = f.visit(false).await;
    let s = f.summary(&f.owner, p, visit).await;
    assert_eq!(
        (s["state"].as_str(), s["waiting_on"].as_str()),
        (Some("add_charges"), Some("staff"))
    );
    assert_eq!(s["insurance"]["insured"], false);
    assert!(s["charges_cents"].is_null() && s["balance_cents"].is_null());

    let draft = f.charges(p, visit, None, 12000).await;
    let s = f.summary(&f.owner, p, visit).await;
    assert_eq!(s["state"], "sign_visit");
    assert_eq!(
        s["patient"]["owes_now_cents"], 0,
        "nothing is owed until charges are final"
    );
    sqlx::query("UPDATE visits SET status='signed',signed_by=clinician_id,signed_at=now(),note=$3 WHERE tenant_id=$1 AND id=$2").bind(f.owner.tenant_id).bind(visit).bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"})).execute(&f.db).await.unwrap();
    assert_eq!(f.summary(&f.owner, p, visit).await["state"], "post_charges");

    // A partial payment at the desk before posting is applied when the charges post.
    f.copay(p, appointment, 2000).await;
    let posted = f.post(p, &draft).await;
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(s["state"], "self_pay_collect");
    assert_eq!(s["waiting_on"], "patient");
    assert_eq!(s["patient"]["responsibility_source"], "self_pay");
    assert_eq!(s["patient"]["owes_now_cents"], 10000);
    assert_eq!(s["patient"]["receipts_applied_cents"], 2000);
    assert_eq!(s["insurance"]["status"], "none");
    assert_eq!(s["insurance"]["pending_cents"], 0);

    let (status, out) = f.prepare(&f.owner, p, id(&posted), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(out, json!({"outcome":"not_needed","reason":"self_pay"}));
    assert_eq!(
        f.count("SELECT count(*) FROM ehr_claims WHERE tenant_id=$1")
            .await,
        0
    );

    // The statement is stored the first time it is needed and reused while nothing changes.
    let path = format!(
        "/api/v1/patients/{p}/billing/accounts/{}/statement",
        id(&posted)
    );
    let first = f.ok("POST", &path, json!({}), None).await;
    assert_eq!(first["created"], true);
    assert_eq!(first["invoice"]["snapshot"]["amount_due_cents"], 10000);
    assert_eq!(first["invoice"]["snapshot"]["gross_charges_cents"], 12000);
    let again = f.ok("POST", &path, json!({}), None).await;
    assert_eq!(again["created"], false);
    assert_eq!(again["invoice"]["id"], first["invoice"]["id"]);
    assert_eq!(
        f.count("SELECT count(*) FROM patient_invoice_snapshots WHERE tenant_id=$1")
            .await,
        1
    );
    let s = f.summary(&f.owner, p, visit).await;
    assert_eq!(
        s["statement"],
        json!({"current":true,"latest_id":first["invoice"]["id"],"count":1})
    );

    f.pay(p, id(&posted), 10000).await;
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(
        (s["state"].as_str(), s["waiting_on"].as_str()),
        (Some("paid_in_full"), Some("nobody"))
    );
    assert_eq!(s["patient"]["owes_now_cents"], 0);
    assert_eq!(
        s["statement"]["current"], false,
        "the earlier statement no longer matches"
    );
    // One timeline, oldest first, with the earlier statement kept.
    let codes: Vec<&str> = s["timeline"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["code"].as_str().unwrap())
        .collect();
    assert_eq!(
        codes,
        [
            "charges_added",
            "payment_received",
            "charges_posted",
            "receipt_applied",
            "statement",
            "patient_payment"
        ]
    );
    assert_eq!(
        f.count("SELECT count(*) FROM patient_invoice_snapshots WHERE tenant_id=$1")
            .await,
        1
    );

    // A credit: the patient paid more at the desk than the visit cost.
    let (p2, appointment2, visit2) = f.visit(true).await;
    f.copay(p2, appointment2, 5000).await;
    let draft = f.charges(p2, visit2, None, 3000).await;
    f.post(p2, &draft).await;
    let s = f.summary(&f.owner, p2, visit2).await;
    adds_up(&s);
    assert_eq!(s["state"], "patient_credit");
    assert_eq!(s["balance_cents"], 0);
    assert_eq!(s["patient"]["unapplied_cents"], 2000);
    assert_eq!(s["patient"]["credit_cents"], 2000);
    assert_eq!(s["patient"]["owes_now_cents"], 0);
}

#[tokio::test]
async fn insured_visit_prepares_its_claim_once_and_splits_insurance_from_patient() {
    let _key_file = crate::test_db::credential_key_lock().lock().await;
    let key_dir = std::env::temp_dir().join(format!("visit-billing-{}", Uuid::new_v4()));
    std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", key_dir.join("master.key"));
    let f = setup().await;
    f.directory(true).await;
    let (p, appointment, visit) = f.visit(true).await;
    let (payer, policy) = f.coverage(p, "primary", "SYN-P", Some(2500)).await;

    // Before charges exist the copay is the only thing due.
    let s = f.summary(&f.owner, p, visit).await;
    assert_eq!(s["state"], "add_charges");
    assert_eq!(s["insurance"]["insurer"], "Synthetic primary plan");
    assert_eq!(s["patient"]["copay_cents"], 2500);
    assert_eq!(s["patient"]["owes_now_cents"], 2500);
    f.copay(p, appointment, 1000).await;
    assert_eq!(
        f.summary(&f.owner, p, visit).await["patient"]["owes_now_cents"],
        1500
    );

    let draft = f.charges(p, visit, Some(id(&policy)), 10000).await;
    let (status, out) = f.prepare(&f.owner, p, id(&draft), json!({})).await;
    assert_eq!(
        (status, out["reason"].as_str()),
        (StatusCode::OK, Some("charges_not_posted"))
    );
    let posted = f.post(p, &draft).await;
    let account = id(&posted);

    // A visit posted before this change has no claim: the summary says one is needed and
    // never calls the unpaid amount the patient's balance.
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(s["state"], "prepare_claim");
    assert_eq!(s["balance_cents"], 9000);
    assert_eq!(s["insurance"]["status"], "not_sent");
    assert_eq!(s["insurance"]["pending_cents"], 7500);
    assert_eq!(s["patient"]["owes_now_cents"], 1500);
    assert_eq!(s["patient"]["responsibility_source"], "plan_copay");

    // Same permission as preparing a claim by hand.
    let nurse = f.staff(Role::Nurse, "nurse").await;
    assert_eq!(
        f.prepare(&nurse, p, account, json!({})).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.count("SELECT count(*) FROM ehr_claims WHERE tenant_id=$1")
            .await,
        0
    );

    let desk = f.staff(Role::FrontDesk, "front_desk").await;
    let (status, out) = f.prepare(&desk, p, account, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["outcome"], "prepared");
    assert_eq!(
        out["issues"],
        json!([]),
        "the practice directory fills every required field"
    );
    let claim_id = out["claim_id"].clone();
    // Idempotent, for the same person and for anyone else opening the visit.
    for actor in [&desk, &f.owner] {
        let (status, again) = f.prepare(actor, p, account, json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(again, json!({"outcome":"exists","claim_id":claim_id}));
    }
    assert_eq!(
        f.count("SELECT count(*) FROM ehr_claims WHERE tenant_id=$1")
            .await,
        1
    );

    let claim = f.claim(&claim_id).await;
    assert_eq!(claim["status"], "draft", "prepared, never released");
    assert_eq!(claim["frequency"], "original");
    assert_eq!(claim["snapshot"]["account"]["total_cents"], 10000);
    assert_eq!(
        claim["content"],
        json!({"billing_provider_name":"Synthetic Clinic","billing_npi":"1234567893","tax_id":"000000017","billing_address":"1 Synthetic Way, Austin TX 78701","rendering_npi":"1234567893","patient_address":"1 Synthetic Way, Austin, TX, 78701, US","subscriber_address":"1 Synthetic Way, Austin, TX, 78701, US","subscriber_birth_date":"1990-01-01","place_of_service":"11","diagnosis_codes":["Z00.00"],"line_diagnosis_pointers":[[1]],"external_control_number":"","notes":"","synthetic_test":false})
    );
    // The same audit trail as the manual action, attributed to the person who opened it.
    let (actor, reason, evidence): (Uuid, String, Value) = sqlx::query_as("SELECT actor_id,reason,evidence FROM claim_revisions WHERE tenant_id=$1 AND claim_id=$2 AND version=1").bind(f.owner.tenant_id).bind(id(&claim)).fetch_one(&f.db).await.unwrap();
    assert_eq!(actor, desk.sub);
    assert_eq!(
        reason,
        "Prepared automatically from the visit's posted charges"
    );
    assert_eq!(
        evidence,
        json!({"transport":"none","crossover_tracking_only":false,"network_transmitted":false,"prepared":"automatic"})
    );
    assert_eq!(
        f.count("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='claim.change'")
            .await,
        1
    );
    // Nothing was sent or queued.
    assert_eq!(
        f.count("SELECT count(*) FROM edi_submissions WHERE tenant_id=$1")
            .await,
        0
    );
    assert_eq!(
        f.count("SELECT count(*) FROM edi_delivery_jobs WHERE tenant_id=$1")
            .await,
        0
    );
    // Preparing did not touch the posted charges or the ledger.
    let after: (i64, i64) = sqlx::query_as(
        "SELECT version,total_cents FROM billing_accounts WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.owner.tenant_id)
    .bind(account)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(after, (version(&posted), 10000));

    // Posted charges are final: they cannot be edited under a prepared claim, so the
    // claim always matches the charges it was prepared from.
    let edit = f
        .call(
            &f.owner,
            "PUT",
            &format!("/api/v1/patients/{p}/billing/accounts/{account}"),
            json!({"content":posted["content"],"reason":"Synthetic late edit"}),
            Some(version(&posted)),
        )
        .await;
    assert_eq!(edit.0, StatusCode::CONFLICT, "{}", edit.1);
    let s = f.summary(&desk, p, visit).await;
    adds_up(&s);
    assert_eq!(
        (s["state"].as_str(), s["waiting_on"].as_str()),
        (Some("send_claim"), Some("staff"))
    );
    assert_eq!(s["claim"]["automatic"], true);
    assert!(
        s["technical"].is_null() && s["claim"]["control_number"].is_null(),
        "identifiers are owner-only"
    );
    let owner_view = f.summary(&f.owner, p, visit).await;
    assert_eq!(owner_view["technical"]["account_id"], json!(account));
    assert_eq!(
        owner_view["technical"]["claims"][0]["control_number"],
        claim["control_number"]
    );
    assert_eq!(
        owner_view["technical"]["coverage_verification"],
        "manually_verified"
    );

    // A person sends it; then the insurer is the one being waited on.
    let sent = f.send(&claim_id).await;
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(
        (s["state"].as_str(), s["waiting_on"].as_str()),
        (Some("waiting_insurer"), Some("insurer"))
    );
    assert_eq!(s["insurance"]["sent_on"], "2026-10-25");
    assert_eq!(s["insurance"]["pending_cents"], 7500);
    assert_eq!(s["patient"]["owes_now_cents"], 1500);

    // The insurer answers: paid 6000, wrote off 2000, patient responsibility 2000.
    f.respond(p, &payer, &sent, 10000, 6000, 2000, "1", "SYN-PRIMARY")
        .await;
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(
        (s["state"].as_str(), s["waiting_on"].as_str()),
        (Some("patient_owes"), Some("patient"))
    );
    assert_eq!(s["insurance"]["status"], "answered");
    assert_eq!(s["insurance"]["paid_cents"], 6000);
    assert_eq!(s["insurance"]["adjusted_cents"], 2000);
    assert_eq!(s["insurance"]["pending_cents"], 0);
    assert_eq!(s["insurance"]["unassigned_cents"], 0);
    assert_eq!(s["patient"]["responsibility_source"], "insurer_response");
    assert_eq!(s["patient"]["responsibility_cents"], 2000);
    assert_eq!(
        s["patient"]["owes_now_cents"], 1000,
        "2000 the insurer assigned less the 1000 copay paid"
    );
    assert_eq!(s["claim"]["answer"]["paid_cents"], 6000);

    // Statement on first send: one record, the same amount as the card.
    let path = format!("/api/v1/patients/{p}/billing/accounts/{account}/statement");
    assert_eq!(
        f.call(&nurse, "POST", &path, json!({}), None).await.0,
        StatusCode::FORBIDDEN
    );
    let statement = f.ok("POST", &path, json!({}), None).await;
    assert_eq!(statement["created"], true);
    assert_eq!(statement["invoice"]["snapshot"]["amount_due_cents"], 1000);
    assert_eq!(
        statement["invoice"]["snapshot"]["responsibility_cents"],
        2000
    );
    assert_eq!(f.ok("POST", &path, json!({}), None).await["created"], false);

    f.pay(p, account, 1000).await;
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(s["state"], "paid_in_full");
    assert_eq!(s["patient"]["copay_paid_cents"], 1000);
    assert_eq!(s["patient"]["copay_due_cents"], 1500);
    assert_eq!(s["patient"]["other_patient_payments_cents"], 1000);
    let codes: Vec<&str> = s["timeline"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["code"].as_str().unwrap())
        .collect();
    assert_eq!(
        codes,
        [
            "payment_received",
            "charges_added",
            "charges_posted",
            "receipt_applied",
            "claim_prepared_auto",
            "claim_ready",
            "claim_sent",
            "insurer_payment",
            "insurer_adjustment",
            "claim_answered",
            "statement",
            "patient_payment"
        ]
    );

    std::env::remove_var("ENGINE_CREDENTIAL_KEY_FILE");
}

#[tokio::test]
async fn missing_details_denials_deductibles_secondary_and_overpayment_are_reported_plainly() {
    let f = setup().await;
    // No practice directory: the claim is still prepared and says what is missing.
    let (p, _, visit) = f.visit(true).await;
    let (payer, policy) = f.coverage(p, "primary", "SYN-P", None).await;
    let posted = f
        .post(p, &f.charges(p, visit, Some(id(&policy)), 10000).await)
        .await;
    let account = id(&posted);
    let (_, out) = f.prepare(&f.owner, p, account, json!({})).await;
    assert_eq!(out["outcome"], "prepared");
    let missing: Vec<&str> = out["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["missing"].as_str().unwrap())
        .collect();
    assert!(
        missing.contains(&"billing organization tax ID")
            && missing.contains(&"provider NPI")
            && missing.contains(&"billing address"),
        "{missing:?}"
    );
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(s["state"], "fix_claim");
    assert_eq!(
        s["claim"]["issues"].as_array().unwrap().len(),
        missing.len()
    );
    assert_eq!(s["patient"]["responsibility_source"], "copay_not_recorded");
    assert_eq!(s["patient"]["owes_now_cents"], 0);
    assert_eq!(s["insurance"]["pending_cents"], 10000);

    // A person fills in the details on the draft; the claim is then ready to send.
    let claim = f.claim(&out["claim_id"]).await;
    let mut content = claim["content"].clone();
    for (key, value) in [
        ("billing_provider_name", "Synthetic Practice"),
        ("billing_npi", "1234567893"),
        ("rendering_npi", "1234567893"),
        ("tax_id", "000000001"),
        ("billing_address", "1 Synthetic Way, Austin TX 78701"),
        ("patient_address", "1 Synthetic Way, Austin TX 78701"),
        ("subscriber_address", "1 Synthetic Way, Austin TX 78701"),
    ] {
        content[key] = json!(value);
    }
    f.ok(
        "PUT",
        &format!("/api/v1/billing/claims/{}", id(&claim)),
        json!({"content":content,"reason":"Synthetic correction"}),
        Some(version(&claim)),
    )
    .await;
    assert_eq!(f.summary(&f.owner, p, visit).await["state"], "send_claim");

    // Cancelling the claim is respected: no new one appears until a person asks.
    let draft = f.claim(&out["claim_id"]).await;
    f.ok(
        "POST",
        &format!("/api/v1/billing/claims/{}/actions", id(&draft)),
        json!({"action":"void_draft","reason":"Synthetic cancel"}),
        Some(version(&draft)),
    )
    .await;
    assert_eq!(
        f.summary(&f.owner, p, visit).await["state"],
        "claim_cancelled"
    );
    assert_eq!(
        f.prepare(&f.owner, p, account, json!({})).await.1,
        json!({"outcome":"cancelled"})
    );
    let (_, again) = f.prepare(&f.owner, p, account, json!({"again":true})).await;
    assert_eq!(again["outcome"], "prepared");
    assert_eq!(
        again["issues"],
        json!([]),
        "the corrected details carry over"
    );
    assert_eq!(
        f.count("SELECT count(*) FROM ehr_claims WHERE tenant_id=$1 AND status<>'void'")
            .await,
        1
    );

    // Denied: the patient is not handed the balance; the next step is to fix and resend.
    let sent = f.send(&again["claim_id"]).await;
    f.respond(p, &payer, &sent, 10000, 0, 0, "4", "SYN-DENIED")
        .await;
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(
        (s["state"].as_str(), s["waiting_on"].as_str()),
        (Some("denied"), Some("staff"))
    );
    assert_eq!(s["insurance"]["status"], "denied");
    assert_eq!(s["patient"]["owes_now_cents"], 0);
    assert_eq!(s["insurance"]["pending_cents"], 10000);

    // Deductible: the insurer pays nothing and assigns the allowed amount to the patient.
    let (p, appointment, visit) = f.visit(true).await;
    let (payer, policy) = f.coverage(p, "primary", "SYN-D", Some(2500)).await;
    f.copay(p, appointment, 2500).await;
    let posted = f
        .post(p, &f.charges(p, visit, Some(id(&policy)), 10000).await)
        .await;
    let account = id(&posted);
    let (_, out) = f.prepare(&f.owner, p, account, json!({})).await;
    let claim = f.claim(&out["claim_id"]).await;
    f.ok(
        "PUT",
        &format!("/api/v1/billing/claims/{}", id(&claim)),
        json!({"content":content,"reason":"Synthetic correction"}),
        Some(version(&claim)),
    )
    .await;
    let sent = f.send(&out["claim_id"]).await;
    f.respond(p, &payer, &sent, 10000, 0, 8000, "1", "SYN-DEDUCTIBLE")
        .await;
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(s["state"], "patient_owes");
    assert_eq!(s["insurance"]["paid_cents"], 0);
    assert_eq!(s["insurance"]["adjusted_cents"], 2000);
    assert_eq!(s["patient"]["responsibility_cents"], 8000);
    assert_eq!(s["patient"]["owes_now_cents"], 5500);

    // Overpaid: the copay taken was more than the insurer says the patient owes.
    let (p, appointment, visit) = f.visit(true).await;
    let (payer, policy) = f.coverage(p, "primary", "SYN-O", Some(2500)).await;
    f.copay(p, appointment, 2500).await;
    let posted = f
        .post(p, &f.charges(p, visit, Some(id(&policy)), 10000).await)
        .await;
    let (_, out) = f.prepare(&f.owner, p, id(&posted), json!({})).await;
    let claim = f.claim(&out["claim_id"]).await;
    f.ok(
        "PUT",
        &format!("/api/v1/billing/claims/{}", id(&claim)),
        json!({"content":content,"reason":"Synthetic correction"}),
        Some(version(&claim)),
    )
    .await;
    let sent = f.send(&out["claim_id"]).await;
    f.respond(p, &payer, &sent, 10000, 7500, 0, "1", "SYN-OVERPAID")
        .await;
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(
        s["balance_cents"], -2500,
        "the insurer's payment left a credit on the visit"
    );
    assert_eq!(s["state"], "patient_credit");
    assert_eq!(s["patient"]["overpaid_cents"], 2500);
    assert_eq!(s["patient"]["credit_cents"], 2500);
    assert_eq!(s["patient"]["owes_now_cents"], 0);

    // Secondary coverage: once a secondary claim is open, the primary's patient amount is
    // insurance pending again; the secondary's answer then sets what the patient owes.
    let (p, _, visit) = f.visit(true).await;
    let (payer, policy) = f.coverage(p, "primary", "SYN-1", None).await;
    let (second_payer, second_policy) = f.coverage(p, "secondary", "SYN-2", None).await;
    let posted = f
        .post(p, &f.charges(p, visit, Some(id(&policy)), 10000).await)
        .await;
    let account = id(&posted);
    let (_, out) = f.prepare(&f.owner, p, account, json!({})).await;
    let claim = f.claim(&out["claim_id"]).await;
    f.ok(
        "PUT",
        &format!("/api/v1/billing/claims/{}", id(&claim)),
        json!({"content":content,"reason":"Synthetic correction"}),
        Some(version(&claim)),
    )
    .await;
    let sent = f.send_with(&out["claim_id"], true).await;
    f.respond(p, &payer, &sent, 10000, 6000, 2000, "1", "SYN-COB-PRIMARY")
        .await;
    let s = f.summary(&f.owner, p, visit).await;
    assert_eq!(
        (s["state"].as_str(), s["patient"]["owes_now_cents"].as_i64()),
        (Some("patient_owes"), Some(2000))
    );
    // Preparing again never creates a second original while the primary stands.
    assert_eq!(
        f.prepare(&f.owner, p, account, json!({})).await.1["outcome"],
        "exists"
    );
    let review = f
        .ok(
            "GET",
            &format!("/api/v1/billing/claims/{}/secondary-review", id(&claim)),
            json!(null),
            None,
        )
        .await;
    assert_eq!(review["blockers"], json!([]), "{review}");
    let remittance: (Uuid, i64) = sqlx::query_as(
        "SELECT id,version FROM era_remittances WHERE tenant_id=$1 AND trace='SYN-COB-PRIMARY'",
    )
    .bind(f.owner.tenant_id)
    .fetch_one(&f.db)
    .await
    .unwrap();
    let coordination = json!({"coverage_id":id(&second_policy),"coverage_version":version(&second_policy),"primary_claim_version":version(&review["primary_claim"]),"remittance_id":remittance.0,"remittance_version":remittance.1,"row_index":0,"not_forwarded_confirmed":true,"payer_timing_reviewed":true,"crossover_reference":"Reviewed synthetic EOB: no crossover, timing confirmed","paid_units":[1]});
    let mut secondary_content = content.clone();
    secondary_content["subscriber_birth_date"] = json!("1990-01-01");
    secondary_content["diagnosis_codes"] = json!(["Z00.00"]);
    secondary_content["line_diagnosis_pointers"] = json!([[1]]);
    let secondary = f.ok("POST", &format!("/api/v1/patients/{p}/billing/accounts/{account}/claims"), json!({"request_id":Uuid::new_v4(),"frequency":"original","parent_id":id(&claim),"coordination":coordination,"content":secondary_content,"reason":"Reviewed synthetic secondary"}), Some(version(&review["account"]))).await;
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(s["state"], "send_claim");
    assert_eq!(s["insurance"]["insurer"], "Synthetic primary plan");
    assert_eq!(s["claim"]["payer_name"], "Synthetic secondary plan");
    assert_eq!(s["claim"]["secondary"], true);
    assert_eq!(
        s["patient"]["owes_now_cents"], 0,
        "the primary's patient amount is with the secondary now"
    );
    assert_eq!(s["insurance"]["pending_cents"], 2000);
    let sent = f.send(&secondary["id"]).await;
    f.respond(
        p,
        &second_payer,
        &sent,
        10000,
        1500,
        500,
        "2",
        "SYN-COB-SECONDARY",
    )
    .await;
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(s["state"], "patient_owes");
    assert_eq!(s["insurance"]["paid_cents"], 7500);
    assert_eq!(s["patient"]["responsibility_cents"], 500);
    assert_eq!(s["patient"]["owes_now_cents"], 500);

    // Another practice cannot read or prepare anything here.
    let stranger = Actor {
        tenant_id: Uuid::new_v4(),
        sub: Uuid::new_v4(),
        ..f.owner.clone()
    };
    assert_eq!(
        f.call(
            &stranger,
            "GET",
            &format!("/api/v1/patients/{p}/billing/visit-summary?visit_id={visit}"),
            json!(null),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.prepare(&stranger, p, account, json!({})).await.0,
        StatusCode::NOT_FOUND
    );
}
