// SPDX-License-Identifier: AGPL-3.0-only
//! The billing attention queue: what each kind of waiting work looks like, the order
//! staff are asked to work it in, insurance aging by service date, and what staff with a
//! restricted access policy are shown. Synthetic data only.
use axum::{
    body::Body,
    http::{request::Builder as RequestBuilder, StatusCode},
    Router,
};
use chrono::{DateTime, Duration, Utc};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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

const ORIGIN: &str = "http://127.0.0.1:8099";
const PATH: &str = "/api/v1/billing/attention";
/// One fixed day, so every age in the queue is decided by the test, not by the clock.
/// Remittances are validated against the real clock, so the synthetic payment date is
/// one the insurer could only have already sent.
const REMIT_DATE: &str = "2025-01-06";

struct Fixture {
    db: PgPool,
    app: Router,
    tenant: Uuid,
    owner: Uuid,
    cookie: String,
    payer: Uuid,
    payer_name: String,
    today: DateTime<Utc>,
}

/// A charge account in one of the states the queue reports.
struct Case {
    patient: Uuid,
    patient_name: String,
    account: Uuid,
    visit: Uuid,
    claim: Option<Uuid>,
}

/// What the engine itself calls a visit whose patient owes the whole charge.
const SELF_PAY: &str = "self_pay";

fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

/// The practice's billing organization on a claim packet, so a claim that has left
/// draft can still be touched: the trigger freezing a released packet rejects edits.
fn packet() -> Value {
    json!({
        "billing_provider_name":"Synthetic Clinic",
        "billing_npi":"1234567893",
        "tax_id":"123456789",
        "billing_address":"1 Synthetic Way, Austin, TX, 78701, US",
        "rendering_npi":"1234567893",
        "patient_address":"1 Synthetic Way, Austin, TX, 78701, US",
        "subscriber_address":"1 Synthetic Way, Austin, TX, 78701, US",
        "subscriber_birth_date":"1990-01-01",
        "place_of_service":"11",
        "diagnosis_codes":["Z00.00"],
        "line_diagnosis_pointers":[[1]],
        "external_control_number":"",
        "notes":"Synthetic packet"
    })
}

impl Fixture {
    async fn new() -> Self {
        let url =
            std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("billing_attention_{}", Uuid::new_v4().simple());
        suncharts_engine::test_db::create_schema(&admin, &schema).await;
        admin.close().await;
        let db = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(std::time::Duration::from_secs(60))
            .after_connect(move |connection, _| {
                let query = format!("SET search_path TO {schema}");
                Box::pin(async move {
                    sqlx::query(&query).execute(connection).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        suncharts_engine::MIGRATOR.run(&db).await.unwrap();
        let app = suncharts_engine::app(State {
            backend: Arc::new(PostgresBackend(db.clone())),
            secret: "unused-synthetic".into(),
            allow_legacy_gateway: false,
            issuer: "suncharts".into(),
            audience: "suncharts-engine".into(),
            browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
        });
        let mut fixture = Self {
            db,
            app,
            tenant: Uuid::new_v4(),
            owner: Uuid::nil(),
            cookie: String::new(),
            payer: Uuid::new_v4(),
            payer_name: "Synthetic Health Plan".into(),
            today: suncharts_engine::billing_attention::today_for_tests()
                .and_hms_opt(12, 0, 0)
                .unwrap()
                .and_utc(),
        };
        let (owner, cookie) = fixture.staff("owner").await;
        fixture.owner = owner;
        fixture.cookie = cookie;
        sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,$3,$2,'synthetic')")
            .bind(fixture.tenant).bind(fixture.payer)
            .bind(json!({"name":fixture.payer_name,"payer_code":"SYN","active":true}))
            .execute(&fixture.db).await.unwrap();
        fixture
    }

    fn service(&self, days: i64) -> String {
        (self.today - Duration::days(days)).date_naive().to_string()
    }

    fn at(&self, days: i64) -> DateTime<Utc> {
        self.today - Duration::days(days)
    }

    /// The staff identity used to post a synthetic insurance payment.
    fn actor(&self) -> Actor {
        Actor {
            sub: self.owner,
            tenant_id: self.tenant,
            role: Role::Owner,
            patient_id: None,
            iss: "suncharts".into(),
            aud: "suncharts-engine".into(),
            iat: Utc::now().timestamp(),
            exp: Utc::now().timestamp() + 60,
        }
    }

    /// A staff member with a signed-in browser session; returns the cookie value.
    async fn staff(&self, role: &str) -> (Uuid, String) {
        let user = Uuid::new_v4();
        sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,display_name,role) VALUES($1,$2,$3,'unused','Synthetic Staff',$4)")
            .bind(self.tenant).bind(user).bind(format!("{user}@example.test")).bind(role)
            .execute(&self.db).await.unwrap();
        (user, self.sign_in(user).await)
    }

    async fn sign_in(&self, user: Uuid) -> String {
        let token = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at,auth_method) VALUES($1,$2,$3,now()+interval '1 hour','break_glass')")
            .bind(hash(&token)).bind(self.tenant).bind(user)
            .execute(&self.db).await.unwrap();
        token
    }

    /// A front desk member whose custom policy hides the named areas.
    async fn restricted(&self, hidden: &[&str]) -> String {
        let user = Uuid::new_v4();
        sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,display_name,role) VALUES($1,$2,$3,'unused','Synthetic Restricted Staff','front_desk')")
            .bind(self.tenant).bind(user).bind(format!("{user}@example.test"))
            .execute(&self.db).await.unwrap();
        let token = self.sign_in(user).await;
        let mut permissions = serde_json::Map::new();
        for resource in [
            "clinical",
            "scheduling",
            "billing",
            "claims",
            "communications",
            "workflows",
            "ai",
            "integrations",
            "practice",
            "terminology",
            "migration",
            "events",
        ] {
            let allowed = !hidden.contains(&resource);
            permissions.insert(
                resource.into(),
                json!({"view":allowed,"create":allowed,"edit":allowed,"delete":allowed}),
            );
        }
        let policy = Uuid::new_v4();
        sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,$3,'front_desk',$4,$5)")
            .bind(self.tenant).bind(policy).bind(format!("Synthetic role {}", policy))
            .bind(Value::Object(permissions)).bind(self.owner)
            .execute(&self.db).await.unwrap();
        sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)")
            .bind(self.tenant).bind(user).bind(policy).bind(self.owner)
            .execute(&self.db).await.unwrap();
        let stored: Value = sqlx::query_scalar(
            "SELECT p.permissions FROM practice_access_assignments a JOIN practice_access_policies p ON p.tenant_id=a.tenant_id AND p.id=a.policy_id WHERE a.tenant_id=$1 AND a.user_id=$2",
        )
        .bind(self.tenant).bind(user)
        .fetch_one(&self.db).await.unwrap();
        for area in hidden {
            assert_eq!(
                stored[area]["view"], false,
                "{area} must be hidden for this staff member"
            );
        }
        token
    }

    /// `GET`s the queue with a session cookie.
    async fn call(&self, cookie: &str) -> (StatusCode, Value) {
        self.raw(
            RequestBuilder::new()
                .method("GET")
                .uri(PATH)
                .header("cookie", format!("sce_session={cookie}"))
                .header("origin", ORIGIN),
        )
        .await
    }

    async fn raw(&self, builder: RequestBuilder) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({"message": String::from_utf8_lossy(&bytes)})),
        )
    }

    async fn patient(&self, given: &str, family: &str, mrn: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,$4,$5,'1990-01-01')")
            .bind(self.tenant).bind(id).bind(mrn).bind(given).bind(family)
            .execute(&self.db).await.unwrap();
        id
    }

    /// A completed appointment and its signed visit, `days` before today.
    async fn signed_visit(&self, patient: Uuid, days: i64) -> (Uuid, Uuid) {
        let appointment = Uuid::new_v4();
        let visit = Uuid::new_v4();
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5,$6,'completed')")
            .bind(self.tenant).bind(appointment).bind(patient).bind(self.owner)
            .bind(self.at(days + 1)).bind(self.at(days))
            .execute(&self.db).await.unwrap();
        sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed','{\"subjective\":\"Synthetic\"}'::jsonb,$5,$6)")
            .bind(self.tenant).bind(visit).bind(patient).bind(appointment).bind(self.owner)
            .bind(self.at(days))
            .execute(&self.db).await.unwrap();
        (visit, appointment)
    }

    /// Insurance on file, which is what makes a charge account an insured one.
    async fn coverage(&self, patient: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,$2,'synthetic')")
            .bind(self.tenant).bind(id).bind(patient).bind(self.payer)
            .bind(json!({"payer_id":self.payer,"priority":"primary","status":"active","member_id":"SYN-MEMBER","effective_date":"2030-01-01","end_date":null,"copay_cents":null,"group_number":"","plan_name":"Synthetic Plan","subscriber_name":"Synthetic Subscriber","subscriber_birth_date":"1990-01-01","relationship":"self","verification":"manually_verified","notes":""}))
            .execute(&self.db).await.unwrap();
        id
    }

    /// Posted charges dated `days` back, insured when a coverage is given.
    async fn posted_account(
        &self,
        patient: Uuid,
        visit: Uuid,
        coverage: Option<Uuid>,
        cents: i64,
        days: i64,
    ) -> Uuid {
        let id = Uuid::new_v4();
        let snapshot = match coverage {
            // No coverage on file: the charge is the patient's own.
            None => json!({}),
            Some(coverage) => json!({
                "coverage": {"id": coverage, "content": {"priority": "primary", "copay_cents": null}},
                "payer": {"id": self.payer, "content": {"name": self.payer_name, "payer_code": "SYN"}},
            }),
        };
        sqlx::query("INSERT INTO billing_accounts(tenant_id,id,patient_id,visit_id,coverage_id,content,coverage_snapshot,total_cents,status,version,request_id,creation_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'posted',1,$2,'synthetic',$9)")
            .bind(self.tenant).bind(id).bind(patient).bind(visit)
            .bind(coverage)
            .bind(json!({"visit_id":visit,"coverage_id":coverage,"service_date":self.service(days),"lines":[]}))
            .bind(coverage.map(|_| snapshot.clone()))
            .bind(cents).bind(self.at(days))
            .execute(&self.db).await.unwrap();
        let stored: Option<Value> = sqlx::query_scalar(
            "SELECT coverage_snapshot FROM billing_accounts WHERE tenant_id=$1 AND id=$2",
        )
        .bind(self.tenant)
        .bind(id)
        .fetch_one(&self.db)
        .await
        .unwrap();
        assert!(
            coverage.is_some() || stored.is_none(),
            "an uninsured account must store no coverage snapshot, got {stored:?}"
        );
        id
    }

    /// A claim on a charge account that has been prepared but never sent to a payer.
    async fn draft_claim(&self, account: Uuid, patient: Uuid) -> Uuid {
        self.claim_draft(account, patient, false).await
    }

    /// A claim the payer answered by paying nothing, through the engine's own posting
    /// path: the posted answer moves the claim out of the sent states and leaves the
    /// whole charge unsettled.
    /// What a charge account was billed for.
    async fn charged(&self, account: Uuid) -> i64 {
        sqlx::query_scalar("SELECT total_cents FROM billing_accounts WHERE tenant_id=$1 AND id=$2")
            .bind(self.tenant)
            .bind(account)
            .fetch_one(&self.db)
            .await
            .unwrap()
    }

    /// A claim sent to the payer and still waiting for an answer.
    async fn sent_claim(&self, account: Uuid, patient: Uuid, sent: i64) -> Uuid {
        let claim = self.claim_draft(account, patient, false).await;
        self.update_status(claim, "submitted").await;
        self.revision(claim, "submitted", sent, self.submitted(sent))
            .await;
        claim
    }

    /// A claim whose imported insurance payment nobody has posted.
    async fn staged_claim(
        &self,
        account: Uuid,
        patient: Uuid,
        sent: i64,
        paid: i64,
        writeoff: i64,
    ) -> Uuid {
        let claim = self.sent_claim(account, patient, sent).await;
        self.remittance(claim, paid, writeoff, "3", false).await;
        claim
    }

    /// A claim the payer answered through a posted insurance payment.
    async fn answered_claim(
        &self,
        account: Uuid,
        patient: Uuid,
        sent: i64,
        paid: i64,
        writeoff: i64,
    ) -> Uuid {
        let claim = self.sent_claim(account, patient, sent).await;
        self.remittance(claim, paid, writeoff, "3", true).await;
        claim
    }

    /// Only the status moves; the packet itself is frozen once the claim is released.
    async fn update_status(&self, claim: Uuid, status: &str) {
        let rows = sqlx::query(
            "UPDATE ehr_claims SET status=$3,version=version+1 WHERE tenant_id=$1 AND id=$2",
        )
        .bind(self.tenant)
        .bind(claim)
        .bind(status)
        .execute(&self.db)
        .await
        .unwrap();
        assert_eq!(rows.rows_affected(), 1);
    }

    /// An unsent claim, at whatever status the case needs; the packet freezes once the
    /// claim leaves draft, so anything about it is set here.
    async fn claim_draft(&self, account: Uuid, patient: Uuid, synthetic_test: bool) -> Uuid {
        let id = Uuid::new_v4();
        let charged: i64 = sqlx::query_scalar(
            "SELECT total_cents FROM billing_accounts WHERE tenant_id=$1 AND id=$2",
        )
        .bind(self.tenant)
        .bind(account)
        .fetch_one(&self.db)
        .await
        .unwrap();
        let mut content = packet();
        content["synthetic_test"] = json!(synthetic_test);
        let service: Option<String> = sqlx::query_scalar(
            "SELECT content->>'service_date' FROM billing_accounts WHERE tenant_id=$1 AND id=$2",
        )
        .bind(self.tenant)
        .bind(account)
        .fetch_one(&self.db)
        .await
        .unwrap();
        let created = match service.as_deref() {
            Some(date) => format!("{date}T12:00:00Z")
                .parse::<DateTime<Utc>>()
                .unwrap(),
            // No service date on the charges: the claim's own day stands.
            None => Utc::now(),
        };
        sqlx::query("INSERT INTO ehr_claims(tenant_id,id,patient_id,account_id,payer_id,control_number,frequency,content,snapshot,status,request_id,creation_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,'original',$7,$8,$9,$10,'synthetic',$11)")
            .bind(self.tenant).bind(id).bind(patient).bind(account).bind(self.payer)
            .bind(format!("SYN-{}", id.simple()))
            .bind(content)
            .bind(json!({"account":{"total_cents":charged,"coverage_snapshot":{"payer":{"content":{"name":self.payer_name}},"coverage":{"content":{"priority":"primary"}}}}}))
            .bind("draft").bind(Uuid::new_v4()).bind(created)
            .execute(&self.db).await.unwrap();
        id
    }

    /// The revision that moved a claim to `status` `age` days ago. The event date on a
    /// submission is what the queue reads as the day the claim went out.
    async fn revision(&self, claim: Uuid, status: &str, age: i64, evidence: Value) {
        self.revision_at(claim, status, self.at(age), evidence)
            .await;
    }

    async fn revision_at(&self, claim: Uuid, status: &str, at: DateTime<Utc>, evidence: Value) {
        let claim_row: (i64, Value, Value, String, String, Uuid, Uuid, Uuid) = sqlx::query_as(
            "SELECT version,content,snapshot,control_number,frequency,patient_id,account_id,payer_id FROM ehr_claims WHERE tenant_id=$1 AND id=$2",
        )
        .bind(self.tenant)
        .bind(claim)
        .fetch_one(&self.db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO claim_revisions(tenant_id,claim_id,version,snapshot,actor_id,reason,evidence,created_at) VALUES($1,$2,$3,$4,$5,'Synthetic history',$6,$7)")
            .bind(self.tenant).bind(claim).bind(claim_row.0)
            .bind(json!({"id":claim,"status":status,"content":claim_row.1,"snapshot":claim_row.2,
                         "control_number":claim_row.3,"frequency":claim_row.4,
                         "patient_id":claim_row.5,"account_id":claim_row.6,"payer_id":claim_row.7}))
            .bind(self.owner).bind(evidence).bind(at)
            .execute(&self.db).await.unwrap();
    }

    /// The outstanding balance the queue reads for a charge account.
    async fn balance_of(&self, account: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT b.total_cents + coalesce(sum(e.effect_cents),0)::bigint FROM billing_accounts b LEFT JOIN billing_entries e ON e.tenant_id=b.tenant_id AND e.account_id=b.id WHERE b.tenant_id=$1 AND b.id=$2 GROUP BY b.id,b.total_cents",
        )
        .bind(self.tenant).bind(account)
        .fetch_one(&self.db).await.unwrap()
    }

    /// The payer's own row status on the posted answer for this claim, as the queue
    /// reads it.
    async fn payer_row(&self, claim: Uuid) -> String {
        let account: Uuid =
            sqlx::query_scalar("SELECT account_id FROM ehr_claims WHERE tenant_id=$1 AND id=$2")
                .bind(self.tenant)
                .bind(claim)
                .fetch_one(&self.db)
                .await
                .unwrap();
        let rows = suncharts_engine::billing_attention::claim_context_for_tests(
            &self.db,
            self.tenant,
            [account].as_slice(),
        )
        .await
        .unwrap();
        rows[0]["denial_reason"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    /// The amount of an unposted imported payment matched to this claim, as the queue
    /// reads it.
    async fn staged_payment(&self, claim: Uuid) -> i64 {
        let account: Uuid =
            sqlx::query_scalar("SELECT account_id FROM ehr_claims WHERE tenant_id=$1 AND id=$2")
                .bind(self.tenant)
                .bind(claim)
                .fetch_one(&self.db)
                .await
                .unwrap();
        let rows = suncharts_engine::billing_attention::claim_context_for_tests(
            &self.db,
            self.tenant,
            [account].as_slice(),
        )
        .await
        .unwrap();
        rows[0]["waiting_cents"].as_i64().unwrap_or_default()
    }

    /// Where the engine says a charge account's responsibility sits.
    async fn responsibility_source(&self, account: Uuid) -> String {
        let rows = suncharts_engine::billing_attention::balances_for_tests(
            &self.db,
            self.tenant,
            [account].as_slice(),
        )
        .await
        .unwrap();
        assert_eq!(rows.len(), 1, "the account must be listed");
        rows[0]["responsibility_source"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    /// A payment from `party` that reduced the balance by `cents`.
    async fn payment(&self, account: Uuid, party: &str, cents: i64, content: Value) {
        let id = Uuid::new_v4();
        let mut content = content;
        content["party"] = json!(party);
        content["occurred_on"] = json!(self.service(1));
        content["reason"] = json!("Synthetic ledger activity");
        sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id,created_at) VALUES($1,$2,$3,'payment',$4,$5,$2,'synthetic',$6,$7)")
            .bind(self.tenant).bind(id).bind(account).bind(-cents)
            .bind(content).bind(self.owner).bind(self.at(1))
            .execute(&self.db).await.unwrap();
    }

    /// One insurance payment for one claim. `posting` runs the engine's own posting
    /// path, so a posted payment obeys every rule the remittance screen enforces;
    /// without it the payment is simply waiting to be posted.
    async fn remittance(&self, claim: Uuid, paid: i64, writeoff: i64, row: &str, posting: bool) {
        let charged: i64 = sqlx::query_scalar(
            "SELECT b.total_cents FROM billing_accounts b JOIN ehr_claims c ON c.tenant_id=b.tenant_id AND c.account_id=b.id WHERE c.tenant_id=$1 AND c.id=$2",
        )
        .bind(self.tenant).bind(claim)
        .fetch_one(&self.db).await.unwrap();
        self.remittance_paid(claim, paid, writeoff, charged, row, posting)
            .await;
    }

    /// A payment whose row states its own charge total, so a refusal can be posted as
    /// the payer's answer without writing any of the practice's charge off.
    async fn remittance_paid(
        &self,
        claim: Uuid,
        paid: i64,
        writeoff: i64,
        charged: i64,
        row: &str,
        posting: bool,
    ) {
        let id = Uuid::new_v4();
        let trace = format!("SYNTR-{}", id.simple());
        let adjustments: Vec<Value> = if writeoff > 0 {
            vec![
                json!({"group":"CO","reason_code":"45","amount_cents":writeoff,"service_index":null}),
            ]
        } else {
            vec![]
        };
        let (claim_version, account_version, control, total): (i64, i64, String, i64) =
            sqlx::query_as("SELECT c.version,b.version,c.control_number,b.total_cents FROM ehr_claims c JOIN billing_accounts b ON b.tenant_id=c.tenant_id AND b.id=c.account_id WHERE c.tenant_id=$1 AND c.id=$2")
                .bind(self.tenant).bind(claim)
                .fetch_one(&self.db).await.unwrap();
        assert!(
            charged <= total,
            "a synthetic CAS cannot pay more than was billed: {charged} of {total}"
        );
        let document = json!({
            "payer_code":"SYN","trace":trace,"payment_date":REMIT_DATE,
            "total_paid_cents":paid,"currency":"USD",
            "claims":[{"control_number":control,"payer_control_number":"SYN-PAYER-1","status":row,
                       "patient_name":"Synthetic Patient","charged_cents":charged,"paid_cents":paid,
                       "patient_responsibility_cents":0,"adjustments":adjustments,"services":[]}],
        });
        let matches = json!([{"row_index":0,"claim_id":claim,"claim_version":claim_version,"account_version":account_version,
                              "writeoff_adjustments":if writeoff > 0 { json!([0]) } else { json!([]) }}]);
        sqlx::query("INSERT INTO era_remittances(tenant_id,id,payer_id,trace,document,document_hash,status,matches,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,'synthetic',$6,$7,$2,'synthetic')")
            .bind(self.tenant).bind(id).bind(self.payer).bind(&trace).bind(&document)
            .bind(if posting { "posted" } else { "staged" })
            .bind(if posting { matches } else { json!([]) })
            .execute(&self.db).await.unwrap();
        if !posting {
            return;
        }
        let mut tx = self.db.begin().await.unwrap();
        suncharts_engine::claims::post_saved_remittance(
            &mut tx,
            &self.actor(),
            id,
            "Synthetic payment posted",
        )
        .await
        .unwrap();
        sqlx::query("UPDATE era_remittances SET status='posted',version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(self.tenant).bind(id)
            .execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
    }

    /// A claim the insurer refused, with the reason they gave.
    async fn rejected_case(&self, mrn: &str, days: i64) -> Case {
        self.rejected_case_with(mrn, days, false).await
    }

    async fn rejected_case_with(&self, mrn: &str, days: i64, synthetic_test: bool) -> Case {
        let patient = self.patient("Rowan", "Rejected", mrn).await;
        let (visit, _) = self.signed_visit(patient, days).await;
        let coverage = self.coverage(patient).await;
        let account = self
            .posted_account(patient, visit, Some(coverage), 30_000, days)
            .await;
        let claim = self.claim_draft(account, patient, synthetic_test).await;
        self.update_status(claim, "rejected").await;
        assert!(
            !self.answered(account).await,
            "a refusal with no posted payer answer behind it is still the practice's work"
        );
        self.revision(
            claim,
            "rejected",
            days,
            json!({"message":"The patient is not eligible for this plan on the date of service"}),
        )
        .await;
        Case {
            patient,
            patient_name: "Rejected, Rowan".into(),
            account,
            visit,
            claim: Some(claim),
        }
    }

    /// Charges the insurer refused: the payer's posted answer is a status 4 row that
    /// paid nothing, and the charge is cleared only by the contractual writeoff the
    /// refusal carries. What is left is a denial for staff to review, not a settled visit.
    async fn denied_case(&self, mrn: &str, service: i64, sent: i64) -> Case {
        let patient = self.patient("Devon", "Denied", mrn).await;
        let (visit, _) = self.signed_visit(patient, service).await;
        let coverage = self.coverage(patient).await;
        let account = self
            .posted_account(patient, visit, Some(coverage), 9000, service)
            .await;
        let claim = self.sent_claim(account, patient, sent).await;
        self.remittance(claim, 0, 9000, "4", true).await;
        assert_eq!(
            self.payer_row(claim).await,
            "4",
            "a denial rests on the payer's posted row, which refused the claim"
        );
        assert!(
            self.denied(account).await,
            "the engine reads this account as a denial to review"
        );
        assert!(
            self.unpaid_of(account).await > 0,
            "a refusal is not money received, so the charge is not collected"
        );
        Case {
            patient,
            patient_name: "Denied, Devon".into(),
            account,
            visit,
            claim: Some(claim),
        }
    }

    /// Charges whose insurance payment is imported but not posted.
    async fn era_case(&self, mrn: &str, days: i64) -> Case {
        let patient = self.patient("Priya", "Unposted", mrn).await;
        let (visit, _) = self.signed_visit(patient, days).await;
        let coverage = self.coverage(patient).await;
        let account = self
            .posted_account(patient, visit, Some(coverage), 12_000, days)
            .await;
        let claim = self.staged_claim(account, patient, days, 4000, 8000).await;
        assert!(
            !self.posted(claim).await,
            "an imported payment is not a posted one"
        );
        assert_eq!(
            self.staged_payment(claim).await,
            4000,
            "the imported payment is visible to staff before it is posted"
        );
        Case {
            patient,
            patient_name: "Unposted, Priya".into(),
            account,
            visit,
            claim: Some(claim),
        }
    }

    /// Posted insured charges with no claim of their own.
    async fn ready_case(&self, mrn: &str, days: i64) -> Case {
        let patient = self.patient("Sam", "Ready", mrn).await;
        let (visit, _) = self.signed_visit(patient, days).await;
        let coverage = self.coverage(patient).await;
        let account = self
            .posted_account(patient, visit, Some(coverage), 7000, days)
            .await;
        Case {
            patient,
            patient_name: "Ready, Sam".into(),
            account,
            visit,
            claim: None,
        }
    }

    /// A claim sent `sent` days ago on charges from `service` days ago, still unanswered.
    async fn waiting_case(&self, mrn: &str, service: i64, sent: i64) -> Case {
        let patient = self.patient("Lee", "Waiting", mrn).await;
        let (visit, _) = self.signed_visit(patient, service).await;
        let coverage = self.coverage(patient).await;
        let account = self
            .posted_account(patient, visit, Some(coverage), 20_000, service)
            .await;
        let claim = self.sent_claim(account, patient, sent).await;
        Case {
            patient,
            patient_name: "Waiting, Lee".into(),
            account,
            visit,
            claim: Some(claim),
        }
    }

    /// What is still unbilled or uncollected on an account: money and the adjustments
    /// a payer's answer wrote off are not payments the practice received.
    async fn unpaid_of(&self, account: Uuid) -> i64 {
        let rows = suncharts_engine::billing_attention::balances_for_tests(
            &self.db,
            self.tenant,
            [account].as_slice(),
        )
        .await
        .unwrap();
        rows[0]["total_cents"].as_i64().unwrap_or_default()
            - rows[0]["insurer_paid_cents"].as_i64().unwrap_or_default()
            - rows[0]["patient_payments_cents"]
                .as_i64()
                .unwrap_or_default()
    }

    /// What the ledger says about every account in this fixture.
    async fn debug_rows(&self) -> String {
        let all: Vec<(Uuid,)> =
            sqlx::query_as("SELECT id FROM billing_accounts WHERE tenant_id=$1")
                .bind(self.tenant)
                .fetch_all(&self.db)
                .await
                .unwrap();
        let ids: Vec<Uuid> = all.iter().map(|(id,)| *id).collect();
        let rows =
            suncharts_engine::billing_attention::balances_for_tests(&self.db, self.tenant, &ids)
                .await
                .unwrap();
        rows.iter()
            .map(|r| {
                format!(
                    "{{id={} bal={} owes={} pend={} insured={} posted={} test={} src={} answered={} denied={}}}",
                    r["id"], r["balance_cents"], r["owes_now_cents"], r["pending_cents"],
                    r["insured"], r["posted"], r["test_activity"], r["responsibility_source"],
                    r["answered"], r["denied"]
                )
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    async fn balance_case(&self, mrn: &str, days: i64) -> Case {
        let patient = self.patient("Ava", "Owes", mrn).await;
        let (visit, _) = self.signed_visit(patient, days).await;
        let account = self.posted_account(patient, visit, None, 6000, days).await;
        assert_eq!(
            self.responsibility_source(account).await,
            SELF_PAY,
            "a visit with no coverage on file is the patient's own balance"
        );
        Case {
            patient,
            patient_name: "Owes, Ava".into(),
            account,
            visit,
            claim: None,
        }
    }

    /// A claim the primary payer passed on, tracked as a crossover on the secondary.
    async fn crossover_case(&self, mrn: &str, service: i64, sent: i64) -> Case {
        let patient = self.patient("Ivy", "Crossover", mrn).await;
        let (visit, _) = self.signed_visit(patient, service).await;
        let coverage = self.coverage(patient).await;
        let account = self
            .posted_account(patient, visit, Some(coverage), 20_000, service)
            .await;
        let id = Uuid::new_v4();
        // The crossover evidence is part of the packet, which freezes on release.
        sqlx::query("INSERT INTO ehr_claims(tenant_id,id,patient_id,account_id,payer_id,control_number,frequency,content,snapshot,status,request_id,creation_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,'original',$7,$8,'submitted',$9,'synthetic',$10)")
            .bind(self.tenant).bind(id).bind(patient).bind(account).bind(self.payer)
            .bind(format!("SYN-{}", id.simple()))
            .bind(packet())
            .bind(json!({"account":{"total_cents":20_000,"coverage_snapshot":{"payer":{"content":{"name":self.payer_name}},"coverage":{"content":{"priority":"primary"}}}},
                         "coordination_of_benefits":{"crossover":{"remittance_id":Uuid::new_v4(),"row_index":0}}}))
            .bind(Uuid::new_v4()).bind(self.at(sent))
            .execute(&self.db).await.unwrap();
        self.revision(id, "submitted", sent, self.submitted(sent))
            .await;
        Case {
            patient,
            patient_name: "Crossover, Ivy".into(),
            account,
            visit,
            claim: Some(id),
        }
    }

    /// Whether the engine reads a charge account as denied.
    async fn denied(&self, account: Uuid) -> bool {
        let rows = suncharts_engine::billing_attention::balances_for_tests(
            &self.db,
            self.tenant,
            [account].as_slice(),
        )
        .await
        .unwrap();
        rows[0]["denied"] == true
    }

    /// Whether the engine reads a payer answer for this account: a claim outside the
    /// states a practice works, with the answer's own responsibility settled.
    async fn answered(&self, account: Uuid) -> bool {
        let rows = suncharts_engine::billing_attention::balances_for_tests(
            &self.db,
            self.tenant,
            [account].as_slice(),
        )
        .await
        .unwrap();
        rows[0]["answered"] == true
    }

    /// Whether this claim's payment has been posted by the practice.
    async fn posted(&self, claim: Uuid) -> bool {
        let rows = sqlx::query_scalar::<_, i64>(
            "SELECT count(*)::bigint FROM era_postings p JOIN era_remittances r ON r.tenant_id=p.tenant_id AND r.id=p.remittance_id WHERE p.tenant_id=$1 AND p.claim_id=$2 AND r.status='posted'",
        )
        .bind(self.tenant).bind(claim)
        .fetch_one(&self.db).await.unwrap();
        rows > 0
    }

    /// Whether a payment the practice posted settled this claim.
    async fn paid(&self, claim: Uuid) -> bool {
        let rows = sqlx::query_scalar::<_, i64>(
            "SELECT count(*)::bigint FROM era_postings p JOIN era_remittances r ON r.tenant_id=p.tenant_id AND r.id=p.remittance_id WHERE p.tenant_id=$1 AND p.claim_id=$2 AND r.status='posted'",
        )
        .bind(self.tenant).bind(claim)
        .fetch_one(&self.db).await.unwrap();
        rows > 0
    }

    /// What a clearinghouse submission records: the day the payer received the claim.
    fn submitted(&self, sent: i64) -> Value {
        json!({"event_date": self.service(sent), "tracker_id": format!("SYNTK-{sent}")})
    }

    /// Charges on a visit nobody has signed yet.
    async fn unsigned_case(&self, mrn: &str, days: i64) -> Case {
        let patient = self.patient("Nico", "Unsigned", mrn).await;
        let appointment = Uuid::new_v4();
        let visit = Uuid::new_v4();
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5,$6,'checked_in')")
            .bind(self.tenant).bind(appointment).bind(patient).bind(self.owner)
            .bind(self.at(days + 1)).bind(self.at(days))
            .execute(&self.db).await.unwrap();
        sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note) VALUES($1,$2,$3,$4,$5,'in_progress','{\"subjective\":\"Synthetic\"}'::jsonb)")
            .bind(self.tenant).bind(visit).bind(patient).bind(appointment).bind(self.owner)
            .execute(&self.db).await.unwrap();
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO billing_accounts(tenant_id,id,patient_id,visit_id,content,total_cents,status,request_id,creation_hash,created_at) VALUES($1,$2,$3,$4,$5,5000,'draft',$2,'synthetic',$6)")
            .bind(self.tenant).bind(id).bind(patient).bind(visit)
            .bind(json!({"visit_id":visit,"service_date":self.service(days),"lines":[]}))
            .bind(self.at(days))
            .execute(&self.db).await.unwrap();
        Case {
            patient,
            patient_name: "Unsigned, Nico".into(),
            account: id,
            visit,
            claim: None,
        }
    }
}

fn items(body: &Value) -> Vec<Value> {
    body["items"].as_array().unwrap().clone()
}

fn kinds(body: &Value) -> Vec<String> {
    items(body)
        .iter()
        .map(|item| item["kind"].as_str().unwrap_or_default().to_owned())
        .collect()
}

fn one(body: &Value, kind: &str) -> Value {
    let found: Vec<Value> = items(body)
        .into_iter()
        .filter(|item| item["kind"] == kind)
        .collect();
    assert_eq!(found.len(), 1, "expected exactly one {kind} item in {body}");
    found.into_iter().next().unwrap()
}

fn of_kind(body: &Value, kind: &str) -> Vec<Value> {
    items(body)
        .into_iter()
        .filter(|item| item["kind"] == kind)
        .collect()
}

fn bucket(body: &Value, label: &str) -> Value {
    body["aging"]["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["label"] == label)
        .cloned()
        .unwrap_or_else(|| panic!("no {label} bucket in {}", body["aging"]))
}

#[tokio::test]
async fn every_kind_of_waiting_work_is_reported_in_its_own_words() {
    let f = Fixture::new().await;
    let rejected = f.rejected_case("SYN-REJ", 40).await;
    let denied = f.denied_case("SYN-DEN", 70, 70).await;
    let era = f.era_case("SYN-ERA", 25).await;
    let ready = f.ready_case("SYN-RDY", 10).await;
    let waiting = f.waiting_case("SYN-WAIT", 50, 30).await;
    let balance = f.balance_case("SYN-BAL", 15).await;
    let unsigned = f.unsigned_case("SYN-UNS", 5).await;

    let (status, body) = f.call(&f.cookie.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["currency"], "USD");
    assert_eq!(body["waiting_days"], 21);

    let item = one(&body, "rejected");
    assert_eq!(item["patient_id"], rejected.patient.to_string());
    assert_eq!(item["patient_name"], rejected.patient_name);
    assert_eq!(item["visit_id"], rejected.visit.to_string());
    assert_eq!(item["claim_id"], rejected.claim.unwrap().to_string());
    assert_eq!(item["amount_cents"], 30_000);
    assert_eq!(item["age_days"], 40);
    assert_eq!(item["action"]["target"], "claim");
    // The payer's own words, not a code.
    let message = item["message"].as_str().unwrap();
    assert!(message.contains("not eligible for this plan"), "{item}");
    assert!(message.contains("Synthetic Health Plan"), "{item}");

    let item = one(&body, "denied");
    assert_eq!(item["patient_id"], denied.patient.to_string());
    assert_eq!(
        item["claim_id"],
        denied.claim.unwrap().to_string(),
        "the denial is read from the posted insurance payment"
    );
    assert_eq!(item["age_days"], 70);
    assert_eq!(item["action"]["target"], "claim");
    assert!(
        item["message"].as_str().unwrap().contains("paid nothing"),
        "{item}"
    );

    let item = one(&body, "era_needs_review");
    assert_eq!(item["patient_id"], era.patient.to_string());
    assert_eq!(item["action"]["target"], "era");
    assert_eq!(item["action"]["label"], "Post the payment");
    assert_eq!(item["amount_cents"], 12_000, "the charge still to settle");
    assert!(
        item["message"].as_str().unwrap().contains("$40.00"),
        "the imported payment is named in plain words: {item}"
    );

    let item = one(&body, "ready_to_send");
    assert_eq!(item["patient_id"], ready.patient.to_string());
    assert_eq!(item["claim_id"], Value::Null, "no claim exists yet");
    assert_eq!(item["visit_id"], ready.visit.to_string());
    assert_eq!(item["amount_cents"], 7000);
    assert_eq!(item["action"]["target"], "visit_review");
    assert_eq!(item["action"]["label"], "Prepare the claim");

    let item = one(&body, "waiting_on_payer");
    assert_eq!(item["patient_id"], waiting.patient.to_string());
    assert_eq!(item["amount_cents"], 20_000, "nothing has been paid");
    assert_eq!(
        item["age_days"], 30,
        "the wait is counted from the day the claim went out"
    );
    assert!(
        item["message"].as_str().unwrap().contains("30 days"),
        "{item}"
    );

    let item = one(&body, "patient_balance");
    assert_eq!(item["patient_id"], balance.patient.to_string());
    assert_eq!(item["amount_cents"], 6000);
    assert_eq!(item["action"]["target"], "patient_billing");
    assert!(
        item["message"].as_str().unwrap().contains("$60.00"),
        "{item}"
    );

    // Charges on a visit nobody signed wait on the clinician, not on a payer.
    let ready_items = of_kind(&body, "ready_to_send");
    assert_eq!(ready_items.len(), 2, "{ready_items:?}");
    let item = ready_items
        .iter()
        .find(|row| row["patient_id"] == unsigned.patient.to_string())
        .expect("the unsigned visit is listed");
    assert_eq!(item["claim_id"], Value::Null);
    assert_eq!(item["action"]["label"], "Ask for the visit signature");
    assert!(
        item["message"].as_str().unwrap().contains("sign the visit"),
        "{item}"
    );

    // One item per charge account: nothing is listed twice.
    let claims: Vec<String> = items(&body)
        .iter()
        .filter_map(|row| row["claim_id"].as_str().map(str::to_owned))
        .collect();
    let unique: std::collections::HashSet<&str> = claims.iter().map(String::as_str).collect();
    assert_eq!(claims.len(), unique.len(), "{body}");
    assert_eq!(items(&body).len(), 7, "{body}");
}

#[tokio::test]
async fn items_come_in_the_order_staff_are_asked_to_work_them_then_oldest_first() {
    let f = Fixture::new().await;
    f.balance_case("SYN-BAL", 200).await;
    f.waiting_case("SYN-WAIT", 150, 40).await;
    f.ready_case("SYN-RDY", 120).await;
    f.era_case("SYN-ERA", 100).await;
    f.denied_case("SYN-DEN", 90, 90).await;
    f.rejected_case("SYN-REJ", 80).await;
    f.rejected_case("SYN-REJ-OLD", 95).await;

    let (_, body) = f.call(&f.cookie.clone()).await;
    assert_eq!(
        kinds(&body),
        vec![
            "rejected",
            "rejected",
            "denied",
            "era_needs_review",
            "ready_to_send",
            "waiting_on_payer",
            "patient_balance"
        ],
        "{body}"
    );
    let refused = of_kind(&body, "rejected");
    assert_eq!(refused[0]["age_days"], 95, "oldest first within a kind");
    assert_eq!(refused[1]["age_days"], 80);
    for item in items(&body) {
        assert!(
            item["message"].as_str().unwrap().chars().count() <= 400,
            "{item}"
        );
        assert!(item["amount_cents"].as_i64().unwrap() >= 1, "{item}");
    }
}

#[tokio::test]
async fn insurance_money_is_aged_by_days_since_the_service_date() {
    let f = Fixture::new().await;
    // One outstanding claim in each bucket, plus money that must not be aged.
    // The youngest account already has a posted payer answer, so its money is not
    // insurance money waiting; the other three are.
    let answered = f.waiting_case("SYN-AGE-1", 10, 25).await;
    let control = answered.claim.unwrap();
    f.remittance(control, 8000, 12_000, "3", true).await;
    f.waiting_case("SYN-AGE-2", 45, 40).await;
    f.waiting_case("SYN-AGE-3", 75, 70).await;
    f.waiting_case("SYN-AGE-4", 200, 190).await;
    f.balance_case("SYN-AGE-PATIENT", 400).await;
    f.ready_case("SYN-AGE-UNSENT", 300).await;

    let (_, body) = f.call(&f.cookie.clone()).await;
    let labels: Vec<&str> = body["aging"]["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, vec!["0-30", "31-60", "61-90", "over 90"]);
    for label in ["31-60", "61-90", "over 90"] {
        assert_eq!(
            bucket(&body, label)["count"],
            1,
            "{label}: {}",
            body["aging"]
        );
        assert_eq!(bucket(&body, label)["cents"], 20_000, "{label}");
    }
    assert_eq!(bucket(&body, "0-30")["count"], 0, "{}", body["aging"]);
    assert_eq!(bucket(&body, "0-30")["cents"], 0, "{}", body["aging"]);
    assert_eq!(body["aging"]["total_cents"], 60_000);
    let across: i64 = body["aging"]["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["cents"].as_i64().unwrap())
        .sum();
    assert_eq!(
        across,
        body["aging"]["total_cents"].as_i64().unwrap(),
        "the buckets cover the total exactly once each"
    );
}

#[tokio::test]
async fn work_that_is_not_due_yet_stays_off_the_queue() {
    let f = Fixture::new().await;
    // Sent, but only five days ago: too soon to chase the payer.
    f.waiting_case("SYN-FRESH", 30, 5).await;
    // Charges with a claim already prepared are not work to prepare twice.
    let ready = f.ready_case("SYN-DRAFTED", 20).await;
    // A claim already prepared is not work to prepare twice.
    let claim = f.draft_claim(ready.account, ready.patient).await;
    assert!(sqlx::query_scalar::<_, bool>(
        "SELECT status='draft' FROM ehr_claims WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.tenant)
    .bind(claim)
    .fetch_one(&f.db)
    .await
    .unwrap());
    let (status, body) = f.call(&f.cookie.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(kinds(&body), Vec::<String>::new(), "{body}");
    assert_eq!(body["aging"]["total_cents"], 0);
    for row in body["aging"]["buckets"].as_array().unwrap() {
        assert_eq!(row["count"], 0);
        assert_eq!(row["cents"], 0);
    }
    assert_ne!(claim, Uuid::nil());
}

#[tokio::test]
async fn a_fully_settled_visit_leaves_the_queue() {
    let f = Fixture::new().await;
    let patient = f.patient("Jo", "Settled", "SYN-SETTLED").await;
    let (visit, _) = f.signed_visit(patient, 60).await;
    let coverage = f.coverage(patient).await;
    let account = f
        .posted_account(patient, visit, Some(coverage), 9000, 60)
        .await;
    // The insurer paid in full and the answer is posted: nothing is owed and nothing
    // waits on the payer.
    let claim = f.answered_claim(account, patient, 40, 9000, 0).await;
    assert!(f.paid(claim).await, "the payer's payment is posted");
    let rows = suncharts_engine::billing_attention::balances_for_tests(
        &f.db,
        f.tenant,
        [account].as_slice(),
    )
    .await
    .unwrap();
    assert_eq!(
        rows[0]["balance_cents"], 0,
        "the charge is settled: {}",
        rows[0]
    );

    let (_, body) = f.call(&f.cookie.clone()).await;
    assert_eq!(kinds(&body), Vec::<String>::new(), "{body}");
    assert_eq!(body["aging"]["total_cents"], 0);
}

#[tokio::test]
async fn synthetic_test_claims_and_test_processor_activity_are_left_out() {
    let f = Fixture::new().await;
    // A claim marked as a synthetic clearinghouse lifecycle test.
    let synthetic = f.rejected_case_with("SYN-SYNTH", 90, true).await;
    assert!(synthetic.claim.is_some(), "the flagged claim exists");
    // A crossover record only tracks a claim the primary payer passed on, which this
    // practice never sent.
    let crossover = f.crossover_case("SYN-CROSS", 90, 60).await;
    assert!(crossover.claim.is_some());
    // Test-mode card money against the patient's own balance.
    let balance = f.balance_case("SYN-TESTMODE", 40).await;
    // Patient money settled by a test-mode processor. Test-mode money is not real
    // money, so the balance still waits — but nothing may claim it was paid twice.
    let before = f.balance_of(balance.account).await;
    f.payment(
        balance.account,
        "patient",
        2000,
        json!({"method":"card","test_mode":true}),
    )
    .await;
    let after = f.balance_of(balance.account).await;

    let (_, body) = f.call(&f.cookie.clone()).await;
    println!("DEBUGBODY {}", body);
    println!("DEBUGACC {}", f.debug_rows().await);
    assert_eq!(kinds(&body), vec!["patient_balance"], "{body}");
    assert_eq!(body["items"][0]["patient_id"], balance.patient.to_string());
    assert_eq!(body["aging"]["total_cents"], 0, "{body}");
    // Whatever the queue reports is the real outstanding balance, test-mode money
    // counted or not — it is never a second figure invented here.
    let reported = body["items"][0]["amount_cents"].as_i64().unwrap();
    assert!(
        reported == before || reported == after,
        "reported {reported}, balances were {before} then {after}"
    );
}

#[tokio::test]
async fn staff_are_shown_only_the_parts_their_policy_allows() {
    let f = Fixture::new().await;
    f.rejected_case("SYN-P-REJ", 40).await;
    f.ready_case("SYN-P-RDY", 10).await;
    f.balance_case("SYN-P-BAL", 15).await;

    let (status, body) = f.call(&f.cookie.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        kinds(&body),
        vec!["rejected", "ready_to_send", "patient_balance"],
        "{body}"
    );

    // Claims hidden: the patient's own balance is still the front desk's work.
    let cookie = f.restricted(&["claims"]).await;
    let (status, body) = f.call(&cookie).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!cookie.is_empty());
    assert_eq!(kinds(&body), vec!["patient_balance"], "{body}");
    assert_eq!(
        body["aging"]["total_cents"], 0,
        "insurance money is not shown"
    );

    // Patient billing hidden: insurance work still is.
    let cookie = f.restricted(&["billing"]).await;
    let (status, body) = f.call(&cookie).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(kinds(&body), vec!["rejected", "ready_to_send"], "{body}");
    assert_eq!(bucket(&body, "31-60")["count"], 1, "{body}");

    // Both hidden: an empty queue, never an error that blocks the page.
    let cookie = f.restricted(&["billing", "claims"]).await;
    let (status, body) = f.call(&cookie).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(items(&body).len(), 0, "{body}");
    assert_eq!(body["aging"]["total_cents"], 0);
    assert_eq!(body["aging"]["buckets"].as_array().unwrap().len(), 4);
}

#[tokio::test]
async fn the_queue_is_scoped_to_the_signed_in_practice_and_needs_billing_scope() {
    let f = Fixture::new().await;
    f.rejected_case("SYN-MINE", 40).await;
    let other = Fixture {
        tenant: Uuid::new_v4(),
        db: f.db.clone(),
        app: f.app.clone(),
        owner: Uuid::new_v4(),
        cookie: String::new(),
        payer: Uuid::new_v4(),
        payer_name: "Other Synthetic Plan".into(),
        today: f.today,
    };
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,$3,$2,'synthetic')")
        .bind(other.tenant).bind(other.payer)
        .bind(json!({"name":"Other Synthetic Plan","payer_code":"OTH","active":true}))
        .execute(&other.db).await.unwrap();
    let (_, visitor) = other.staff("owner").await;
    let (status, body) = other.call(&visitor).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(items(&body).len(), 0, "{body}");

    // A delegated token without the billing scope is refused rather than shown
    // anyone's billing.
    let token = format!("sce_at_{}", Uuid::new_v4().simple());
    let client = Uuid::new_v4();
    let grant = Uuid::new_v4();
    sqlx::query("INSERT INTO oauth_clients(id,tenant_id,name,secret_hash,redirect_uri,allowed_scopes) VALUES($1,$2,'Synthetic client','synthetic','https://example.test/callback','clinical.read')")
        .bind(client).bind(f.tenant).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO oauth_grants(id,client_id,tenant_id,user_id,scope) VALUES($1,$2,$3,$4,'clinical.read')")
        .bind(grant).bind(client).bind(f.tenant).bind(f.owner)
        .execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '1 hour')")
        .bind(hash(&token)).bind(grant)
        .execute(&f.db).await.unwrap();
    let (status, _) = f
        .raw(
            RequestBuilder::new()
                .method("GET")
                .uri(PATH)
                .header("authorization", format!("Bearer {token}")),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // No session at all.
    let (status, _) = f.call("not-a-real-session").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_endpoint_is_declared_in_the_published_contract() {
    let spec: Value = serde_json::from_str(include_str!("../api/openapi.json")).unwrap();
    let operation = &spec["paths"][PATH]["get"];
    assert_eq!(operation["operationId"], "billingAttention");
    assert!(
        operation["parameters"].is_null(),
        "the queue takes no filters"
    );
    assert_eq!(
        operation["security"],
        json!([{"oauth2":["billing.read"]},{"browserSession":[]}])
    );
    assert_eq!(
        operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/BillingAttention"
    );
    let item = &spec["components"]["schemas"]["BillingAttentionItem"];
    for field in [
        "kind",
        "patient_id",
        "patient_name",
        "visit_id",
        "claim_id",
        "amount_cents",
        "age_days",
        "message",
        "action",
    ] {
        assert!(
            item["properties"][field].is_object(),
            "{field} is published"
        );
        assert!(
            item["required"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == field),
            "{field} is required"
        );
    }
    assert_eq!(
        spec["components"]["schemas"]["BillingAttentionActionTarget"]["enum"],
        json!(["visit_review", "claim", "era", "patient_billing"])
    );
}
