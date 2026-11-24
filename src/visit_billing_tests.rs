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
    /// The practice directory a claim is filled in from, including its billing organization.
    async fn directory(&self, organization: bool) {
        self.directory_without_organization().await;
        if organization {
            self.billing_organization("Synthetic Billing Organization", "000000017")
                .await;
        }
    }
    /// The clinician and the place, with no billing organization: the practice can name a provider
    /// and an address but holds no tax ID for a claim.
    async fn directory_without_organization(&self) {
        let (a, db) = (&self.owner, &self.db);
        sqlx::query("INSERT INTO practice_providers(tenant_id,id,display_name,npi) VALUES($1,$2,'Synthetic Clinician','1234567893')").bind(a.tenant_id).bind(a.sub).execute(db).await.unwrap();
        sqlx::query("INSERT INTO practice_facilities(tenant_id,id,name,address) VALUES($1,$2,'Synthetic Clinic','1 Synthetic Way, Austin TX 78701')").bind(a.tenant_id).bind(Uuid::new_v4()).execute(db).await.unwrap();
    }
    /// The practice adds one billing organization with a tax ID, as it does after a claim was
    /// already prepared. Returns the organization's id.
    async fn billing_organization(&self, name: &str, tax: &str) -> Uuid {
        let (a, db) = (&self.owner, &self.db);
        let id = Uuid::new_v4();
        let sealed = crate::provider_settings::seal_secret(
            db,
            a.tenant_id,
            id,
            "billing-organization-tax",
            tax,
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO practice_billing_organizations(tenant_id,id,name,tax_id_type,encrypted_tax_id,tax_id_last4) VALUES($1,$2,$3,'E',$4,$5)")
            .bind(a.tenant_id)
            .bind(id)
            .bind(name)
            .bind(sealed)
            .bind(&tax[5..])
            .execute(db)
            .await
            .unwrap();
        id
    }
    /// The claim detail as the owner sees it: the stored content, the plain-language problems
    /// still on it, its version, and what a person must still supply. A claim is named by its id,
    /// as a UUID or as the JSON string an endpoint returned, so callers never build a URL by hand.
    async fn detail(&self, claim_id: &Value) -> Value {
        self.ok(
            "GET",
            &format!("/api/v1/billing/claims/{}", id(claim_id)),
            json!(null),
            None,
        )
        .await
    }
    async fn claim(&self, claim_id: &Value) -> Value {
        self.detail(claim_id).await["claim"].clone()
    }
    /// A claim id as the URL form, so a hand-built path cannot carry JSON quotes.
    fn path_id(&self, claim_id: &Value) -> String {
        id(claim_id).to_string()
    }
    /// The `claim.refilled` revisions a draft has, newest version first.
    async fn refills(&self, claim_id: &Value) -> Vec<Value> {
        let claim_id = id(claim_id);
        sqlx::query_scalar(
            "SELECT jsonb_build_object('version',version,'reason',reason,'evidence',evidence) FROM claim_revisions WHERE tenant_id=$1 AND claim_id=$2 AND reason='claim.refilled' ORDER BY version DESC",
        )
        .bind(self.owner.tenant_id)
        .bind(claim_id)
        .fetch_all(&self.db)
        .await
        .unwrap()
    }
    async fn audit_count(&self, action: &str, claim_id: &Value) -> i64 {
        let id = id(claim_id);
        sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action=$2 AND resource_id=$3",
        )
        .bind(self.owner.tenant_id)
        .bind(action)
        .bind(id)
        .fetch_one(&self.db)
        .await
        .unwrap()
    }
    /// Point the patient's chart somewhere else, the way a front-desk correction does. The
    /// demographics row is append-only in its version, so a write bumps it as the API would.
    async fn move_patient(&self, p: Uuid, line1: &str) {
        sqlx::query(
            "UPDATE patient_demographics SET version = version + 1, content = content || jsonb_build_object('address', jsonb_build_object('line1',$3,'city','Austin','region','TX','postal_code','78701','country','US')) WHERE tenant_id=$1 AND patient_id=$2",
        )
        .bind(self.owner.tenant_id)
        .bind(p)
        .bind(line1)
        .execute(&self.db)
        .await
        .unwrap();
    }
    /// Empties the patient's recorded address — the chart incomplete when the claim was prepared,
    /// as an address left blank at reception is in real life.
    async fn clear_patient_address(&self, p: Uuid) {
        sqlx::query("UPDATE patient_demographics SET version = version + 1, content = content - 'address' WHERE tenant_id=$1 AND patient_id=$2")
            .bind(self.owner.tenant_id)
            .bind(p)
            .execute(&self.db)
            .await
            .unwrap();
    }
    /// A policy holder who is someone other than the patient: the coverage says `spouse`, so the
    /// subscriber's own address and date of birth are theirs, never taken from the patient.
    async fn spouse_coverage(&self, p: Uuid, code: &str) -> (Value, Value) {
        let payer = self.ok("POST","/api/v1/billing/payers",json!({"request_id":Uuid::new_v4(),"content":{"name":"Synthetic spouse plan","payer_code":code,"address":"Synthetic address","phone":"","active":true},"reason":"Synthetic payer"}),None).await;
        let policy = self.ok("POST",&format!("/api/v1/patients/{p}/coverages"),json!({"request_id":Uuid::new_v4(),"content":{"payer_id":id(&payer),"priority":"primary","status":"active","member_id":"SYN-SPOUSE","group_number":"SYN-G","plan_name":"Synthetic plan","subscriber_name":"Sam Synthetic","subscriber_birth_date":null,"relationship":"spouse","effective_date":"2026-01-01","end_date":null,"copay_cents":null,"verification":"manually_verified","notes":"Synthetic"},"reason":"Synthetic coverage"}),None).await;
        (payer, policy)
    }
    /// The patient's date of birth is recorded as unknown. The registration requires a date, so an
    /// unverified patient is registered with a placeholder; it is not a date a claim may carry as
    /// the policy holder's birth date, which is how a draft prepared then ends up with none.
    async fn unknown_patient_birth_date(&self, p: Uuid) {
        // A placeholder in the future, so no claim can carry it as a policy holder's birth date.
        let unknown = chrono::Utc::now().date_naive() + chrono::Duration::days(1);
        self.edit_patient(p, &format!("birth_date=DATE '{}'", unknown))
            .await;
        self.record_identity(p, "Synthetic birth date unknown at registration")
            .await;
    }
    /// The chart's date of birth is corrected to the patient's real one, after the claim was
    /// prepared.
    async fn set_patient_birth_date(&self, p: Uuid, date: &str) {
        self.edit_patient(p, &format!("birth_date=DATE '{date}'"))
            .await;
        self.record_identity(p, "Synthetic birth date recorded")
            .await;
    }
    /// The patient's registration identity is append-only in its version, so a correction to it
    /// bumps `identity_version` and leaves a revision behind, exactly as the patient API does.
    async fn edit_patient(&self, p: Uuid, set: &str) {
        sqlx::query(&format!(
            "UPDATE patients SET identity_version = identity_version + 1, {set} WHERE tenant_id=$1 AND id=$2"
        ))
        .bind(self.owner.tenant_id)
        .bind(p)
        .execute(&self.db)
        .await
        .unwrap();
    }
    async fn record_identity(&self, p: Uuid, reason: &str) {
        let snapshot: Value = sqlx::query_scalar(
            "SELECT jsonb_build_object('id',id,'mrn',mrn,'given_name',given_name,'family_name',family_name,'birth_date',birth_date) FROM patients WHERE tenant_id=$1 AND id=$2",
        )
        .bind(self.owner.tenant_id)
        .bind(p)
        .fetch_one(&self.db)
        .await
        .unwrap();
        let version: i64 = sqlx::query_scalar(
            "SELECT identity_version FROM patients WHERE tenant_id=$1 AND id=$2",
        )
        .bind(self.owner.tenant_id)
        .bind(p)
        .fetch_one(&self.db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO patient_identity_revisions(tenant_id,patient_id,version,snapshot,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        )
        .bind(self.owner.tenant_id)
        .bind(p)
        .bind(version)
        .bind(snapshot)
        .bind(self.owner.sub)
        .bind(reason)
        .execute(&self.db)
        .await
        .unwrap();
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
        // A trace ending in KEEP leaves the contractual amount on the balance for review.
        let chosen: Vec<usize> = if writeoff > 0 && status == "1" && !trace.ends_with("KEEP") {
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
    async fn banner(&self, p: Uuid) -> Value {
        self.ok(
            "GET",
            &format!("/api/v1/patients/{p}/banner"),
            json!(null),
            None,
        )
        .await["billing"]["patient_due_cents"]
            .clone()
    }
    async fn overview(&self, query: &str) -> Value {
        self.ok(
            "GET",
            &format!("/api/v1/billing/overview{query}"),
            json!(null),
            None,
        )
        .await
    }
    /// One ledger entry on the visit; returns its id.
    async fn entry(
        &self,
        p: Uuid,
        account: Uuid,
        kind: &str,
        cents: Option<i64>,
        reverses: Option<&Value>,
    ) -> Value {
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
        self.ok("POST",&format!("/api/v1/patients/{p}/billing/accounts/{account}/entries"),json!({"request_id":Uuid::new_v4(),"kind":kind,"amount_cents":cents,"reverses_id":reverses,"party":"patient","method":if kind=="payment" {"cash"} else {"none"},"reference":"SYN-REVIEW","occurred_on":"2026-10-26","reason":"Synthetic reviewed entry"}),Some(version(&current))).await["id"].clone()
    }
    async fn owes(&self, p: Uuid, visit: Uuid) -> i64 {
        let s = self.summary(&self.owner, p, visit).await;
        adds_up(&s);
        s["patient"]["owes_now_cents"].as_i64().unwrap()
    }
    async fn statement(&self, p: Uuid, account: Uuid) -> Value {
        self.ok(
            "POST",
            &format!("/api/v1/patients/{p}/billing/accounts/{account}/statement"),
            json!({}),
            None,
        )
        .await
    }
    /// A prepared claim with every detail filled in, sent, for a visit with no directory.
    async fn sent_claim(&self, p: Uuid, account: Uuid) -> Value {
        let (_, out) = self.prepare(&self.owner, p, account, json!({})).await;
        let claim = self.claim(&out["claim_id"]).await;
        self.ok(
            "PUT",
            &format!("/api/v1/billing/claims/{}", id(&claim)),
            json!({"content":filled(&claim["content"]),"reason":"Synthetic correction"}),
            Some(version(&claim)),
        )
        .await;
        self.send(&out["claim_id"]).await
    }
    async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sql)
            .bind(self.owner.tenant_id)
            .fetch_one(&self.db)
            .await
            .unwrap()
    }
    /// The signed note's SOAP text, read straight from storage.
    async fn note(&self, visit: Uuid) -> Value {
        sqlx::query_scalar("SELECT note FROM visits WHERE tenant_id=$1 AND id=$2")
            .bind(self.owner.tenant_id)
            .bind(visit)
            .fetch_one(&self.db)
            .await
            .unwrap()
    }
    /// Diagnoses and history as the encounter screen receives them.
    async fn diagnoses_of(&self, a: &Actor, visit: Uuid) -> Value {
        let (status, body) = self
            .call(
                a,
                "GET",
                &format!("/api/v1/visits/{visit}/diagnoses"),
                json!({}),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }
    /// A diagnosis list written through the encounter screen.
    async fn save_diagnoses(
        &self,
        a: &Actor,
        visit: Uuid,
        version: i64,
        codes: &[&str],
        reason: &str,
    ) -> (StatusCode, Value) {
        let body = json!({
            "diagnoses": codes.iter().enumerate().map(|(i, code)| json!({
                "code": code,
                "display": format!("Synthetic diagnosis {}", i + 1),
                "catalog_release_id": Value::Null,
            })).collect::<Vec<_>>(),
            "reason": reason,
        });
        self.call(
            a,
            "PUT",
            &format!("/api/v1/visits/{visit}/diagnoses"),
            body,
            Some(version),
        )
        .await
    }
    async fn action_count(&self, action: &str, resource: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action=$2 AND resource_id=$3",
        )
        .bind(self.owner.tenant_id)
        .bind(action)
        .bind(resource)
        .fetch_one(&self.db)
        .await
        .unwrap()
    }
}
fn filled(content: &Value) -> Value {
    let mut content = content.clone();
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
    content
}
fn id(v: &Value) -> Uuid {
    if let Some(text) = v.as_str() {
        return Uuid::parse_str(text).unwrap_or_else(|_| panic!("invalid id: {v}"));
    }
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
    // Until the insurer answers, patient money beyond the patient's share is credit on the
    // account, not a smaller insurance claim: the insurer's share is still charges less the
    // patient's share, so the split exceeds the balance by exactly that credit.
    let status = i["status"].as_str().unwrap_or("");
    let waiting_on_insurer = s["insurance"]["insured"] == true
        && !matches!(status, "none" | "not_billed" | "answered" | "denied");
    let expected = if waiting_on_insurer {
        n(&s["balance_cents"]) + n(&p["overpaid_cents"])
    } else {
        n(&s["balance_cents"]).max(0)
    };
    assert_eq!(
        n(&i["pending_cents"]) + n(&i["unassigned_cents"]) + n(&p["owes_now_cents"]),
        expected,
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
    assert_eq!(s["patient"]["copay_due_cents"], 2500);
    assert_eq!(
        s["patient"]["owes_now_cents"], 0,
        "nothing is a balance until the charges are posted"
    );
    f.copay(p, appointment, 1000).await;
    assert_eq!(
        f.summary(&f.owner, p, visit).await["patient"]["copay_due_cents"],
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
        json!({"billing_provider_name":"Synthetic Clinic","billing_npi":"1234567893","tax_id":"000000017","billing_address":"1 Synthetic Way, Austin TX 78701","rendering_npi":"1234567893","patient_address":"1 Synthetic Way, Austin, TX, 78701, US","subscriber_address":"1 Synthetic Way, Austin, TX, 78701, US","subscriber_birth_date":"1990-01-01","place_of_service":"11","diagnosis_codes":["Z00.00"],"line_diagnosis_pointers":[[1]],"external_control_number":"","notes":"","synthetic_test":false,"tax_id_type":"E"})
    );
    // The visit summary carries the prepared claim's own form and the patient and account it was
    // built from, so the review panel judges what will be sent and never calls it missing.
    let summary = f.summary(&f.owner, p, visit).await;
    for field in [
        "billing_provider_name",
        "billing_npi",
        "rendering_npi",
        "billing_address",
        "patient_address",
        "place_of_service",
    ] {
        assert!(
            summary["claim"]["content"][field]
                .as_str()
                .is_some_and(|v| !v.trim().is_empty()),
            "{field} is on the summary's claim"
        );
    }
    assert_eq!(summary["claim"]["content"], claim["content"]);
    assert!(summary["claim"]["snapshot"]["patient"].is_object());
    assert!(summary["claim"]["snapshot"]["account"].is_object());
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
    // The review panel checks the claim itself: the summary carries its content and the patient
    // and account it was built from, so nothing the claim already has is reported missing.
    assert_eq!(s["claim"]["content"]["subscriber_birth_date"], "1990-01-01");
    assert_eq!(s["claim"]["content"]["diagnosis_codes"], json!(["Z00.00"]));
    assert!(s["claim"]["snapshot"]["account"].is_object());
    assert!(s["claim"]["snapshot"]["patient"].is_object());
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

#[tokio::test]
async fn every_screen_shows_the_same_patient_owes_now_and_support_sessions_never_prepare_claims() {
    let f = setup().await;
    let (p, _, visit) = f.visit(true).await;
    let (_, policy) = f.coverage(p, "primary", "SYN-P", Some(2500)).await;
    let posted = f
        .post(p, &f.charges(p, visit, Some(id(&policy)), 10000).await)
        .await;
    let account = id(&posted);
    // A posted insured visit: the copay is the patient's, the rest is insurance pending.
    let card = f.summary(&f.owner, p, visit).await;
    assert_eq!(card["patient"]["owes_now_cents"], 2500);
    assert_eq!(card["insurance"]["pending_cents"], 7500);
    assert_eq!(f.banner(p).await, 2500, "banner agrees with the card");
    let page = f.overview(&format!("?patient_id={p}")).await;
    assert_eq!(
        page["summary"]["accounts"]["reviewed_patient_due_cents"],
        2500
    );
    assert_eq!(page["summary"]["accounts"]["patient_owes_now_cents"], 2500);
    let row = &page["accounts"]["items"][0];
    assert_eq!(row["patient_owes_now_cents"], 2500);
    assert_eq!(
        row["insurance_pending_cents"], 7500,
        "never part of the patient's balance"
    );
    assert_eq!(row["billing_state"], card["state"]);
    assert_eq!(row["billing_state"], "prepare_claim");

    // A delegated support session acts with the owner's authority: when it asks, it prepares the
    // claim, recorded in its own name. Opening the visit alone writes nothing (the screen never
    // asks on a support session's behalf).
    let support = Actor {
        sub: Uuid::new_v4(),
        ..f.owner.clone()
    };
    sqlx::query("INSERT INTO partner_support_sessions(token_hash,tenant_id,grant_id,partner_id,customer_id,order_id,issuer,audience,expires_at,actor_subject,delegated_role) VALUES($1,$2,$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'https://connect.suncharts.app','https://clinic.suncharts.app',clock_timestamp()+interval '15 minutes','synthetic-support','partner_admin')").bind(support.sub.to_string()).bind(support.tenant_id).bind(support.sub).execute(&f.db).await.unwrap();
    let seen = f.summary(&support, p, visit).await;
    assert_eq!(seen["viewer"]["delegated"], true);
    assert_eq!(seen["state"], "prepare_claim");
    assert_eq!(card["viewer"]["delegated"], false);
    assert_eq!(
        f.count("SELECT count(*) FROM ehr_claims WHERE tenant_id=$1")
            .await,
        0,
        "reading the summary prepares nothing"
    );
    let (status, out) = f.prepare(&support, p, account, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["outcome"], "prepared");
    // Asking again, from the practice or the support session, returns the same claim.
    let (_, again) = f.prepare(&f.owner, p, account, json!({})).await;
    assert_eq!(again["outcome"], "exists");
    assert_eq!(again["claim_id"], out["claim_id"]);
    let preparer: Uuid =
        sqlx::query_scalar("SELECT actor_id FROM claim_revisions WHERE tenant_id=$1")
            .bind(f.owner.tenant_id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(
        preparer, support.sub,
        "recorded as the support session that asked"
    );
    // Exactly what the first open writes: one draft claim, its first revision, one audit row.
    assert_eq!(
        f.count("SELECT count(*) FROM ehr_claims WHERE tenant_id=$1 AND status='draft'")
            .await,
        1
    );
    assert_eq!(
        f.count("SELECT count(*) FROM claim_revisions WHERE tenant_id=$1")
            .await,
        1
    );
    assert_eq!(
        f.count("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='claim.change'")
            .await,
        1
    );
    for table in [
        "edi_submissions",
        "edi_delivery_jobs",
        "patient_invoice_snapshots",
        "billing_entries",
    ] {
        assert_eq!(
            f.count(&format!("SELECT count(*) FROM {table} WHERE tenant_id=$1"))
                .await,
            0,
            "{table}"
        );
    }
    assert_eq!(
        f.count("SELECT count(*) FROM billing_account_revisions WHERE tenant_id=$1")
            .await,
        2,
        "charges untouched"
    );
    // A reader without claims access is shown the same money.
    let hidden = f
        .summary(&f.staff(Role::Nurse, "nurse").await, p, visit)
        .await;
    assert_eq!(hidden["patient"]["owes_now_cents"], 2500);

    // A second visit for the same patient, self-pay: the banner is the sum of the cards.
    let (appointment2, visit2) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-26T14:00:00Z','2026-10-26T14:30:00Z','checked_in')").bind(f.owner.tenant_id).bind(appointment2).bind(p).bind(f.owner.sub).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,'{}'::jsonb,$5,now())").bind(f.owner.tenant_id).bind(visit2).bind(p).bind(appointment2).bind(f.owner.sub).bind(json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"})).execute(&f.db).await.unwrap();
    // Draft charges are not a balance anywhere.
    let draft = f.charges(p, visit2, None, 12000).await;
    assert_eq!(f.banner(p).await, 2500);
    let second = f.post(p, &draft).await;
    f.pay(p, id(&second), 2000).await;
    let cards = [
        f.summary(&f.owner, p, visit).await,
        f.summary(&f.owner, p, visit2).await,
    ];
    assert_eq!(cards[1]["patient"]["owes_now_cents"], 10000);
    let total: i64 = cards
        .iter()
        .map(|card| card["patient"]["owes_now_cents"].as_i64().unwrap())
        .sum();
    assert_eq!(total, 12500);
    assert_eq!(f.banner(p).await, total);
    let page = f.overview(&format!("?patient_id={p}")).await;
    assert_eq!(
        page["summary"]["accounts"]["reviewed_patient_due_cents"],
        total
    );
    let rows: i64 = page["accounts"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["patient_owes_now_cents"].as_i64().unwrap())
        .sum();
    assert_eq!(rows, total, "rows, tile, banner and cards are one figure");

    // A reviewed statement keeps its amount until the insurer answers or the account changes.
    let current = f
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
    f.ok("POST", &format!("/api/v1/patients/{p}/billing/accounts/{account}/invoices"), json!({"request_id":Uuid::new_v4(),"responsibility_cents":4500,"reason":"Reviewed synthetic coinsurance"}), Some(version(&current))).await;
    let card = f.summary(&f.owner, p, visit).await;
    assert_eq!(
        card["patient"]["responsibility_source"],
        "reviewed_statement"
    );
    assert_eq!(card["patient"]["owes_now_cents"], 4500);
    assert_eq!(card["insurance"]["pending_cents"], 5500);
    adds_up(&card);
    assert_eq!(f.banner(p).await, 14500);

    // The practice-wide page costs the same number of balance statements for many visits
    // as for one.
    for _ in 0..12 {
        let (other, _, other_visit) = f.visit(true).await;
        f.post(other, &f.charges(other, other_visit, None, 5000).await)
            .await;
    }
    super::query_log::take(f.owner.tenant_id);
    let one = f.overview("?limit=1").await;
    let for_one = super::query_log::take(f.owner.tenant_id);
    let many = f.overview("?limit=50").await;
    let for_many = super::query_log::take(f.owner.tenant_id);
    assert_eq!(one["accounts"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(many["accounts"]["items"].as_array().unwrap().len(), 14);
    // Two balance statements (totals and rows), plus one for every open draft on the page
    // together: 2 for one self-pay row, 3 for fourteen rows that include a draft claim.
    assert_eq!((for_one, for_many), (2, 3), "no per-row statements");
    assert_eq!(
        many["summary"]["accounts"]["reviewed_patient_due_cents"],
        14500 + 12 * 5000
    );
}

/// The independent money review's cases, with its numbers.
#[tokio::test]
async fn an_automatic_statement_never_pins_what_the_patient_owes() {
    let f = setup().await;
    // Refund after a statement: copay $30, charges $200, patient pays $100, statement,
    // staff refund $70. Nothing is owed.
    let (p, _, visit) = f.visit(true).await;
    let (_, policy) = f.coverage(p, "primary", "SYN-A", Some(3000)).await;
    let account = id(&f
        .post(p, &f.charges(p, visit, Some(id(&policy)), 20000).await)
        .await);
    f.entry(p, account, "payment", Some(10000), None).await;
    assert_eq!(f.owes(p, visit).await, 0);
    assert_eq!(f.statement(p, account).await["created"], true);
    f.entry(p, account, "adjustment_debit", Some(7000), None)
        .await;
    assert_eq!(
        f.owes(p, visit).await,
        0,
        "the refund leaves the $30 copay covered"
    );
    assert_eq!(f.banner(p).await, 0);

    // Bounced payment: pays $50, statement, payment reversed. The copay is owed again.
    let (p, _, visit) = f.visit(true).await;
    let (_, policy) = f.coverage(p, "primary", "SYN-B", Some(3000)).await;
    let account = id(&f
        .post(p, &f.charges(p, visit, Some(id(&policy)), 20000).await)
        .await);
    let payment = f.entry(p, account, "payment", Some(5000), None).await;
    f.statement(p, account).await;
    f.entry(p, account, "reversal", None, Some(&payment)).await;
    assert_eq!(f.owes(p, visit).await, 3000);
    assert_eq!(f.banner(p).await, 3000);

    // Self-pay $200 with a $50 adjustment, statement at $150, adjustment reversed: $200,
    // and the next statement is a new one for $200.
    let (p, _, visit) = f.visit(true).await;
    let account = id(&f.post(p, &f.charges(p, visit, None, 20000).await).await);
    let discount = f
        .entry(p, account, "adjustment_credit", Some(5000), None)
        .await;
    assert_eq!(f.owes(p, visit).await, 15000);
    let first = f.statement(p, account).await;
    assert_eq!(first["invoice"]["snapshot"]["amount_due_cents"], 15000);
    f.entry(p, account, "reversal", None, Some(&discount)).await;
    assert_eq!(f.owes(p, visit).await, 20000);
    let second = f.statement(p, account).await;
    assert_eq!(second["created"], true);
    assert_eq!(second["invoice"]["snapshot"]["amount_due_cents"], 20000);
    assert_eq!(f.banner(p).await, 20000);

    // An unapplied desk receipt is taken off once, not twice. Self-pay $200, a $50 receipt
    // left unapplied because an open payment link reserves the balance.
    let (p, appointment, visit) = f.visit(true).await;
    let account = id(&f.post(p, &f.charges(p, visit, None, 20000).await).await);
    sqlx::query("DO $$ DECLARE c record; BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='payment_attempts'::regclass AND confrelid='payment_credentials'::regclass LOOP EXECUTE 'ALTER TABLE payment_attempts DROP CONSTRAINT '||quote_ident(c.conname); END LOOP; END $$").execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO payment_attempts(tenant_id,id,account_id,setting_id,credential_revision,request_id,creation_hash,requested_by,amount_cents,status,provider_account_id,provider_mode) VALUES($1,$2,$3,$2,1,$2,'synthetic',$4,20000,'open','acct_synthetic','own_stripe')").bind(f.owner.tenant_id).bind(Uuid::new_v4()).bind(account).bind(f.owner.sub).execute(&f.db).await.unwrap();
    f.copay(p, appointment, 5000).await;
    let s = f.summary(&f.owner, p, visit).await;
    assert_eq!(s["patient"]["unapplied_cents"], 5000, "{s}");
    assert_eq!(s["patient"]["owes_now_cents"], 15000);
    assert_eq!(
        f.statement(p, account).await["invoice"]["snapshot"]["amount_due_cents"],
        15000
    );
    // The $50 not yet applied explains the rest of the $200 balance.
    let after = f.summary(&f.owner, p, visit).await;
    assert_eq!(
        after["patient"]["owes_now_cents"], 15000,
        "still $150 after the statement is saved"
    );
    assert_eq!(after["patient"]["unapplied_cents"], 5000);
    assert_eq!(f.banner(p).await, 15000);
}

#[tokio::test]
async fn a_reviewed_invoice_and_an_earlier_answer_keep_their_amounts() {
    let f = setup().await;
    // Insurer says the patient owes $50; staff then review an invoice at $80; the patient
    // pays $30. $50 of the invoice remains.
    let (p, _, visit) = f.visit(true).await;
    let (payer, policy) = f.coverage(p, "primary", "SYN-R", None).await;
    let account = id(&f
        .post(p, &f.charges(p, visit, Some(id(&policy)), 20000).await)
        .await);
    let sent = f.sent_claim(p, account).await;
    f.respond(
        p,
        &payer,
        &sent,
        20000,
        10000,
        5000,
        "1",
        "SYN-REVIEWED-KEEP",
    )
    .await;
    assert_eq!(f.owes(p, visit).await, 5000);
    let current = f
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
    f.ok("POST", &format!("/api/v1/patients/{p}/billing/accounts/{account}/invoices"), json!({"request_id":Uuid::new_v4(),"responsibility_cents":8000,"reason":"Reviewed synthetic responsibility"}), Some(version(&current))).await;
    assert_eq!(f.owes(p, visit).await, 8000);
    f.entry(p, account, "payment", Some(3000), None).await;
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(s["patient"]["responsibility_source"], "reviewed_statement");
    assert_eq!(
        s["patient"]["owes_now_cents"], 5000,
        "a payment does not discard the reviewed invoice"
    );
    assert_eq!(f.banner(p).await, 5000);

    // Primary answered with $50 for the patient; a replacement claim is then rejected.
    // The $50 does not disappear.
    let (p, _, visit) = f.visit(true).await;
    let (payer, policy) = f.coverage(p, "primary", "SYN-K", Some(1000)).await;
    let account = id(&f
        .post(p, &f.charges(p, visit, Some(id(&policy)), 20000).await)
        .await);
    let sent = f.sent_claim(p, account).await;
    f.respond(p, &payer, &sent, 20000, 10000, 5000, "1", "SYN-ANSWERED")
        .await;
    assert_eq!(f.owes(p, visit).await, 5000);
    let primary = f.claim(&sent["id"]).await;
    let current = f
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
    let replacement = f.ok("POST", &format!("/api/v1/patients/{p}/billing/accounts/{account}/claims"), json!({"request_id":Uuid::new_v4(),"frequency":"replacement","parent_id":id(&primary),"content":primary["content"],"reason":"Synthetic correction"}), Some(version(&current))).await;
    // While the corrected claim is open the answer is not final: the plan copay applies.
    assert_eq!(f.owes(p, visit).await, 1000);
    let submitted = f.send(&replacement["id"]).await;
    f.ok("POST", &format!("/api/v1/billing/claims/{}/actions", id(&submitted)), json!({"action":"record_rejection","reference":"SYNTHETIC-REJECTION","event_date":"2026-10-27","reason":"Synthetic rejection"}), Some(version(&submitted))).await;
    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(s["state"], "denied");
    assert_eq!(s["patient"]["responsibility_source"], "insurer_response");
    assert_eq!(
        s["patient"]["owes_now_cents"], 5000,
        "the primary's answer still stands"
    );
    assert_eq!(f.banner(p).await, 5000);
}

/// A draft claim carries whatever the practice, chart and coverage held the moment it was
/// prepared. These tests cover the refill: a draft is completed from current records before it is
/// shown, checked or released; a value a person typed is never replaced; and nothing already sent
/// is touched. All data is synthetic.
mod refill {
    use super::*;

    /// An insured visit whose claim was prepared with nothing else in the practice directory, so
    /// every fillable field is blank and every one of them is asked of staff. The insurer's
    /// identifier is distinct per call: a payer code stands for one insurer, and reusing one across
    /// two payers is a data error the service refuses, not a second insurer.
    async fn bare_draft(f: &Fixture, payer_code: &str) -> (Uuid, Uuid, Uuid, Value) {
        let (p, _, visit) = f.visit(true).await;
        let (_, policy) = f.coverage(p, "primary", payer_code, None).await;
        let posted = f
            .post(p, &f.charges(p, visit, Some(id(&policy)), 5000).await)
            .await;
        let (_, out) = f.prepare(&f.owner, p, id(&posted), json!({})).await;
        assert_eq!(out["outcome"], "prepared", "{out}");
        (p, visit, id(&posted), out["claim_id"].clone())
    }

    /// Staff type every detail the system does not hold, the way a biller does today.
    async fn type_everything(f: &Fixture, claim_id: &Value, birth_date: &Value) -> Value {
        let draft = f.claim(claim_id).await;
        let mut content = draft["content"].clone();
        // A claim frozen before the tax ID type existed simply has no such key, and the payer file
        // has always sent such a tax ID as an EIN.
        content.as_object_mut().unwrap().remove("tax_id_type");
        content["subscriber_birth_date"] = birth_date.clone();
        for (key, value) in [
            ("billing_provider_name", "Typed By Hand Practice"),
            ("billing_npi", "1234567893"),
            ("rendering_npi", "1234567893"),
            ("tax_id", "000000099"),
            ("billing_address", "7 Hand Typed Road, Austin TX 78701"),
            ("patient_address", "1 Synthetic Way, Austin TX 78701"),
            ("subscriber_address", "1 Synthetic Way, Austin TX 78701"),
        ] {
            content[key] = json!(value);
        }
        f.ok(
            "PUT",
            &format!("/api/v1/billing/claims/{}", id(claim_id)),
            json!({"content":content,"reason":"Synthetic correction by hand"}),
            Some(version(&draft)),
        )
        .await
    }

    #[tokio::test]
    async fn a_draft_claim_is_completed_from_records_filled_in_after_it_was_prepared() {
        let f = setup().await;
        // The practice has its clinician and its place, but its billing setup is unfinished: no
        // billing organization and so no tax ID, and the claim is prepared with the tax ID blank.
        f.directory_without_organization().await;
        let (p, visit, account, claim_id) = bare_draft(&f, "SYN-R1").await;

        let before = f.detail(&claim_id).await;
        assert_eq!(
            before["claim"]["content"]["tax_id"].as_str(),
            Some(""),
            "the draft is prepared with no tax ID to take"
        );
        assert!(
            asked_for(&before["preflight_issues"], &["Tax ID"]),
            "the tax ID problem is shown while the practice really has none: {}",
            before["preflight_issues"]
        );
        let v0 = version(&before["claim"]);
        assert!(f.refills(&claim_id).await.is_empty());

        // The office manager finishes the billing setup and registers the tax ID. Nobody opens the
        // claim or edits it.
        f.billing_organization("Synthetic Billing Organization", "000000017")
            .await;

        // Opening the claim shows it filled, and the "Tax ID is required" problem is gone.
        let after = f.detail(&claim_id).await;
        // The stored JSON is read as well as the API's copy of it: an empty optional is dropped
        // from storage by every other claim write, and a refill must not change that shape.
        let stored = stored_content(&f, &claim_id).await;
        let content = &after["claim"]["content"];
        assert_eq!(&stored, content, "the screen shows exactly what is stored");
        assert_eq!(content["tax_id"], "000000017");
        assert_eq!(
            content["tax_id_type"], "E",
            "the claim says how this tax ID was issued"
        );
        assert_eq!(
            content["billing_provider_name"], "Synthetic Clinic",
            "the place the practice already held still stands: a refill completes blanks, it does              not re-decide fields that were answered"
        );
        assert!(
            !asked_for(&after["preflight_issues"], &["Tax ID"]),
            "the tax ID problem is gone: {}",
            after["preflight_issues"]
        );

        // The claim version rules hold, and exactly one change is recorded.
        assert_eq!(version(&after["claim"]), v0 + 1);
        let refills = f.refills(&claim_id).await;
        assert_eq!(refills.len(), 1, "one refill for one real change");
        assert_eq!(
            refills[0]["evidence"]["filled"],
            json!(["tax_id", "tax_id_type"])
        );
        // The audit entry commits with the revision it belongs to: one `claim.change` for the one
        // change, and only that revision carries the refill reason.
        assert_eq!(
            f.audit_count("claim.change", &claim_id).await,
            refills.len() as i64 + 1,
            "the prepare and the refill each write one audit entry"
        );
        assert_eq!(
            refills[0]["reason"], "claim.refilled",
            "the refill is named in the claim's own history"
        );

        // Looking again completes nothing further, so nothing is rewritten or re-audited.
        let again = f.detail(&claim_id).await;
        assert_eq!(version(&again["claim"]), version(&after["claim"]));
        assert_eq!(f.refills(&claim_id).await.len(), 1);
        assert_eq!(f.audit_count("claim.change", &claim_id).await, 2);

        // The visit card and the claim list agree with the detail screen.
        let summary = f.summary(&f.owner, p, visit).await;
        assert_eq!(
            summary["state"].as_str(),
            Some("send_claim"),
            "what the refill completed was enough for the card to say: send it"
        );
        assert!(
            !asked_for(&summary["claim"]["issues"], &["Tax ID", "tax ID"]),
            "the visit card agrees with the claim screen: {}",
            summary["claim"]["issues"]
        );
        let listed = f
            .ok(
                "GET",
                &format!("/api/v1/billing/claims?account_id={account}"),
                json!(null),
                None,
            )
            .await;
        assert_eq!(listed["items"].as_array().unwrap().len(), 1);

        // The tax ID, the organization name and the NPIs reached the draft without a person
        // typing any of them, so a release is no longer blocked on the details the practice holds.
        let (status, released) = f
            .call(
                &f.owner,
                "POST",
                &format!("/api/v1/billing/claims/{}/actions", f.path_id(&claim_id)),
                json!({"action":"ready","reason":"Synthetic review"}),
                Some(version(&after["claim"])),
            )
            .await;
        // With the practice's details completed nothing else blocks this synthetic claim, so it
        // releases; if anything still did, it would be a preflight problem, never a stale copy.
        assert!(
            status == axum::http::StatusCode::OK
                || released["message"].as_str()
                    == Some("resolve claim preflight issues before releasing the packet"),
            "release outcome: {status} {released}"
        );
        let restated = f.detail(&claim_id).await;
        assert!(
            !asked_for(&restated["preflight_issues"], &["Tax ID"]),
            "the practice's details are no longer asked: {}",
            restated["preflight_issues"]
        );
    }

    #[tokio::test]
    async fn a_refill_never_replaces_what_staff_entered_on_the_draft() {
        let f = setup().await;
        f.directory(false).await;
        let (p, _, _, claim_id) = bare_draft(&f, "SYN-R2").await;
        let draft = f.claim(&claim_id).await;
        let birth = draft["content"]["subscriber_birth_date"].clone();
        assert_eq!(birth, "1990-01-01", "the patient's own date of birth");

        // Staff type a tax ID of their own — one no practice record holds — and the rest too.
        let edited = type_everything(&f, &claim_id, &birth).await;
        assert_eq!(edited["content"]["tax_id"], "000000099");
        let v = version(&edited);
        assert!(f.refills(&claim_id).await.is_empty());

        // The practice records its own tax ID, organization and place afterwards.
        f.billing_organization("Synthetic Billing Organization", "000000017")
            .await;
        f.move_patient(p, "99 Later Way").await;

        let after = f.detail(&claim_id).await;
        let content = &after["claim"]["content"];
        assert_eq!(
            content["tax_id"], "000000099",
            "the tax ID typed by hand stands"
        );
        assert!(
            content["tax_id_type"].is_null() || content["tax_id_type"] == "",
            "a tax ID typed before the field existed is left exactly as it was, so the payer file              still sends it as an EIN, as it always was: {}",
            content["tax_id_type"]
        );
        assert_eq!(
            content["billing_provider_name"], "Typed By Hand Practice",
            "the name typed by hand stands"
        );
        assert_eq!(
            content["billing_address"], "7 Hand Typed Road, Austin TX 78701",
            "the address typed by hand stands"
        );
        assert_eq!(
            content["patient_address"], "1 Synthetic Way, Austin TX 78701",
            "the address typed by hand stands, not the one the chart later holds"
        );
        assert_eq!(content["subscriber_birth_date"], birth);
        assert_eq!(
            version(&after["claim"]),
            v,
            "nothing was blank, so the draft was not rewritten"
        );
        assert!(
            f.refills(&claim_id).await.is_empty(),
            "a draft with nothing missing is never refilled"
        );
        // One `claim.change` for the person's own edit, and no refill revision at all.
        assert_eq!(f.audit_count("claim.change", &claim_id).await, 2);
    }

    #[tokio::test]
    async fn a_claim_already_sent_is_never_touched_by_a_refill() {
        let f = setup().await;
        let (_, _, _, claim_id) = bare_draft(&f, "SYN-R3").await;
        let draft = f.claim(&claim_id).await;
        let birth = draft["content"]["subscriber_birth_date"].clone();
        type_everything(&f, &claim_id, &birth).await;

        // A person releases it and records that it went out.
        let ready = f
            .ok(
                "POST",
                &format!("/api/v1/billing/claims/{}/actions", f.path_id(&claim_id)),
                json!({"action":"ready","reason":"Synthetic review"}),
                Some(version(&f.claim(&claim_id).await)),
            )
            .await;
        assert_eq!(ready["status"], "ready");
        let sent = f
            .ok(
                "POST",
                &format!("/api/v1/billing/claims/{}/actions", f.path_id(&claim_id)),
                json!({"action":"record_submission","reference":"SYNTHETIC-TRANSPORT","event_date":"2026-10-26","reason":"Synthetic delivery fixture"}),
                Some(version(&ready)),
            )
            .await;
        assert_eq!(sent["status"], "submitted");
        let content_before = sent["content"].clone();
        let v_before = version(&sent);
        assert!(f.refills(&claim_id).await.is_empty());

        // The practice fills in everything it was missing, after the claim went out.
        f.billing_organization("Synthetic Billing Organization", "000000017")
            .await;
        sqlx::query(
            "INSERT INTO practice_providers(tenant_id,id,display_name,npi) VALUES($1,$2,'Synthetic Clinician','1234567893')",
        )
        .bind(f.owner.tenant_id)
        .bind(f.owner.sub)
        .execute(&f.db)
        .await
        .unwrap();

        // Every screen that reads the claim leaves the sent content alone.
        for _ in 0..2 {
            let after = f.detail(&claim_id).await;
            assert_eq!(
                after["claim"]["content"], content_before,
                "a sent claim keeps exactly the content that was sent"
            );
            assert_eq!(version(&after["claim"]), v_before);
        }
        assert!(
            f.refills(&claim_id).await.is_empty(),
            "a sent claim is never refilled"
        );
        // One audit entry per real state change — prepare, the person's edit, the release and the
        // recorded submission — and not one from the reads above.
        assert_eq!(f.audit_count("claim.change", &claim_id).await, 4);
    }

    #[tokio::test]
    async fn a_self_policy_draft_takes_the_patient_address_and_birth_date_once_the_chart_is_completed(
    ) {
        let f = setup().await;
        // The chart is incomplete: no address recorded and no date of birth.
        let (p, _, visit) = f.visit(true).await;
        f.clear_patient_address(p).await;
        f.unknown_patient_birth_date(p).await;
        // The practice directory is complete, so only the chart keeps the claim from being sent.
        f.directory(true).await;
        // The patient is their own policy holder: the subscriber's details are the patient's.
        let (_, policy) = f.coverage(p, "primary", "SYN-SELF", None).await;
        let posted = f
            .post(p, &f.charges(p, visit, Some(id(&policy)), 5000).await)
            .await;
        let (_, out) = f.prepare(&f.owner, p, id(&posted), json!({})).await;
        let claim_id = out["claim_id"].clone();

        // The chart's three fields are what stand between this claim and the insurer. The
        // practice's own half is already complete, so nothing else can account for them arriving.
        let missing = issues_of(&f.detail(&claim_id).await["preflight_issues"]);
        let outstanding = f.detail(&claim_id).await["preflight_issues"].clone();
        for wanted in [
            ["Patient address"].as_slice(),
            ["Subscriber address", "policy holder's address"].as_slice(),
            ["Subscriber date of birth", "policy holder's date of birth"].as_slice(),
        ] {
            assert!(
                asked_for(&outstanding, wanted),
                "{} should still be asked for: {missing:?}",
                wanted[0]
            );
        }

        // Reception completes the chart. Nobody opens or edits the claim after that.
        f.move_patient(p, "99 Later Way").await;
        f.set_patient_birth_date(p, "1991-02-03").await;

        let after = f.detail(&claim_id).await;
        let content = &after["claim"]["content"];
        assert_eq!(
            content["patient_address"].as_str(),
            Some("99 Later Way, Austin, TX, 78701, US")
        );
        assert_eq!(
            content["subscriber_address"], content["patient_address"],
            "the policy holder is the patient, so their address is the patient's"
        );
        assert_eq!(content["subscriber_birth_date"], "1991-02-03");
        // Opening the claim is what completed it: the visit card now reports nothing outstanding.
        let card = f.summary(&f.owner, p, visit).await;
        assert_eq!(
            card["state"].as_str(),
            Some("send_claim"),
            "the card asks staff to send it, not to fix it: {}",
            card["claim"]["issues"]
        );
        assert_eq!(card["claim"]["issues"], json!([]));
        for wanted in [
            ["Patient address", "patient address"].as_slice(),
            ["Subscriber address", "policy holder's address"].as_slice(),
            ["Subscriber date of birth", "policy holder's date of birth"].as_slice(),
        ] {
            assert!(
                !asked_for(&after["preflight_issues"], wanted),
                "{} is still asked for: {}",
                wanted[0],
                after["preflight_issues"]
            );
        }
        assert_eq!(
            f.refills(&claim_id).await[0]["evidence"]["filled"],
            json!([
                "patient_address",
                "subscriber_address",
                "subscriber_birth_date"
            ]),
            "only the chart's three fields are completed, nothing else"
        );
        // The chart's completion is the only change, recorded once, and then stable.
        assert_eq!(f.refills(&claim_id).await.len(), 1);
        assert_eq!(f.audit_count("claim.change", &claim_id).await, 2);
        assert_eq!(
            version(&f.detail(&claim_id).await["claim"]),
            version(&after["claim"]),
            "a completed draft is not rewritten by being looked at again"
        );
    }

    #[tokio::test]
    async fn a_refill_leaves_a_blank_subscriber_blank_when_the_policy_holder_is_someone_else() {
        let f = setup().await;
        f.directory(true).await;
        let (p, visit) = {
            let (p, _, visit) = f.visit(true).await;
            (p, visit)
        };
        // The policy holder is the patient's spouse: a different person whose own address and
        // date of birth the practice has not recorded.
        let (_, policy) = f.spouse_coverage(p, "SYN-SPOUSE").await;
        let posted = f
            .post(p, &f.charges(p, visit, Some(id(&policy)), 5000).await)
            .await;
        let (_, out) = f.prepare(&f.owner, p, id(&posted), json!({})).await;

        let content = &f.detail(&out["claim_id"]).await["claim"]["content"];
        assert_eq!(
            content["patient_address"].as_str(),
            Some("1 Synthetic Way, Austin, TX, 78701, US"),
            "the patient's own address comes from the chart"
        );
        assert_eq!(
            content["subscriber_address"].as_str(),
            Some(""),
            "the patient's address is never copied onto a policy holder who is someone else"
        );
        assert!(
            content["subscriber_birth_date"].is_null(),
            "the patient's date of birth is never copied onto a policy holder who is someone else"
        );
    }
}

/// A signed visit whose note carries its own synthetic SOAP text.
/// Adds one resource to an account's own policy, leaving the rest of it as written.
async fn grant_policy_module(f: &Fixture, who: &Actor, resource: &str) {
    sqlx::query("UPDATE practice_access_policies SET permissions = permissions || jsonb_build_object($3, $4::jsonb) WHERE tenant_id=$1 AND id=(SELECT policy_id FROM practice_access_assignments WHERE tenant_id=$1 AND user_id=$2)")
        .bind(f.owner.tenant_id).bind(who.sub).bind(resource)
        .bind(json!({"view":true,"create":true,"edit":true,"delete":true}).to_string())
        .execute(&f.db).await.unwrap();
}

async fn signed_visit(f: &Fixture, signer: &Actor) -> (Uuid, Uuid, Uuid, Value) {
    let (p, appointment, visit) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let note = json!({"subjective":"Synthetic","objective":"Synthetic","assessment":"Synthetic","plan":"Synthetic"});
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Avery','Synthetic','1990-01-01')")
        .bind(f.owner.tenant_id).bind(p).bind(format!("SYN-{}", &p.simple().to_string()[..8]))
        .execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')")
        .bind(f.owner.tenant_id).bind(appointment).bind(p).bind(signer.sub)
        .execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,vitals,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed',$6,'{}'::jsonb,$5,now())")
        .bind(f.owner.tenant_id).bind(visit).bind(p).bind(appointment).bind(signer.sub).bind(&note)
        .execute(&f.db).await.unwrap();
    (p, appointment, visit, note)
}

/// A custom access policy that leaves a base role only the billing screens.
async fn billing_only_policy(f: &Fixture, who: &Actor, base_role: &str, billing_edit: bool) {
    let (policy, other) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,version,updated_by) VALUES($1,$2,$6,$3,$4,1,$5)")
        .bind(f.owner.tenant_id).bind(policy).bind(base_role)
        .bind(json!({"billing":{"view":true,"create":true,"edit":billing_edit,"delete":billing_edit}}))
        .bind(f.owner.sub)
        .bind(format!("Synthetic billing only {}", policy.simple()))
        .execute(&f.db).await.unwrap();
    // A second base role proves the policy is read as belonging to its own role.
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,version,updated_by) VALUES($1,$2,$6,$3,$4,1,$5)")
        .bind(f.owner.tenant_id).bind(other).bind("nurse")
        .bind(json!({"billing":{"view":true,"create":true,"edit":true,"delete":true}}))
        .bind(f.owner.sub)
        .bind(format!("Synthetic other base {}", other.simple()))
        .execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,version,updated_by) VALUES($1,$2,$3,1,$4)")
        .bind(f.owner.tenant_id).bind(who.sub).bind(policy).bind(f.owner.sub)
        .execute(&f.db).await.unwrap();
}

#[tokio::test]
async fn a_signed_visit_diagnosis_list_stays_correctable_as_billing_data() {
    let f = setup().await;
    let signer = f.staff(Role::Clinician, "clinician").await;
    let (_, _, visit, note) = signed_visit(&f, &signer).await;
    let read = f.diagnoses_of(&f.owner, visit).await;
    assert_eq!(read["visit"]["status"], "signed");
    assert_eq!(read["can_edit"], true, "the list is open to the owner");
    assert!(
        read["history"].as_array().unwrap().is_empty(),
        "a signed visit with no coding yet has nothing in its history"
    );

    // The owner corrects the coding of a visit that is already signed. The signed
    // note is untouched, and the change is attributed in the revision history and
    // named in the audit trail as a correction rather than a routine save.
    let (status, out) = f
        .save_diagnoses(
            &f.owner,
            visit,
            read["version"].as_i64().unwrap(),
            &["R51.9", "M54.5"],
            "Coding corrected for the claim",
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["visit"]["status"], "signed");
    assert_eq!(out["can_edit"], true);
    assert_eq!(out["diagnoses"].as_array().unwrap().len(), 2);
    assert_eq!(f.note(visit).await, note, "the signed note is unchanged");
    let revision: Option<(String, String, Value)> = sqlx::query_as(
        "SELECT reason, (SELECT coalesce(nullif(u.display_name,''),u.email) FROM browser_users u WHERE u.tenant_id=visit_diagnosis_revisions.tenant_id AND u.id=visit_diagnosis_revisions.actor_id), snapshot FROM visit_diagnosis_revisions WHERE tenant_id=$1 AND visit_id=$2 AND visit_version=$3",
    )
    .bind(f.owner.tenant_id)
    .bind(visit)
    .bind(out["version"].as_i64().unwrap())
    .fetch_optional(&f.db)
    .await
    .unwrap();
    let (reason, actor, snapshot) = revision.expect("the correction writes an attributed revision");
    assert_eq!(reason, "Coding corrected for the claim");
    assert!(
        actor.ends_with("@example.test"),
        "the revision names who corrected it: {actor}"
    );
    assert_eq!(snapshot.as_array().unwrap().len(), 2);
    assert_eq!(f.action_count("visit.diagnoses_corrected", visit).await, 1);
    assert_eq!(
        f.action_count("visit.diagnoses_save", visit).await,
        0,
        "a change to a signed visit is never audited as a routine save"
    );
    let open_note: Value =
        sqlx::query_scalar("SELECT note FROM visits WHERE tenant_id=$1 AND id=$2")
            .bind(f.owner.tenant_id)
            .bind(visit)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(open_note, note, "the correction cannot reach the note");

    // A second correction, by the clinician who signed the note, replaces the list
    // and leaves its own attributed revision behind.
    let as_signer = f.diagnoses_of(&signer, visit).await;
    assert_eq!(as_signer["can_edit"], true, "the signer may correct");
    let (status, out) = f
        .save_diagnoses(
            &signer,
            visit,
            as_signer["version"].as_i64().unwrap(),
            &["R51.9"],
            "Signer's billing correction",
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["diagnoses"].as_array().unwrap().len(), 1);
    assert_eq!(f.note(visit).await, note);
    assert_eq!(f.action_count("visit.diagnoses_corrected", visit).await, 2);

    // A front desk account — the role the billing endpoints accept for a write —
    // corrects the same list, and a stale version is still refused.
    let desk = f.staff(Role::FrontDesk, "front_desk").await;
    let as_desk = f.diagnoses_of(&desk, visit).await;
    assert_eq!(as_desk["can_edit"], true, "a biller may correct");
    let stale = as_signer["version"].as_i64().unwrap();
    assert!(
        stale < as_desk["version"].as_i64().unwrap(),
        "the correction moved the visit's shared version"
    );
    let (status, body) = f
        .save_diagnoses(
            &desk,
            visit,
            stale,
            &["Z00.00"],
            "Front desk on a stale version",
        )
        .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "the shared version check still applies to a correction: {body}"
    );
    let (status, out) = f
        .save_diagnoses(
            &desk,
            visit,
            as_desk["version"].as_i64().unwrap(),
            &["R51.9", "Z00.00"],
            "Front desk billing correction",
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["diagnoses"].as_array().unwrap().len(), 2);
    assert_eq!(f.note(visit).await, note);

    // A custom access policy is honoured both ways. A front desk account whose policy
    // keeps the billing write still corrects; the same account with the billing edit
    // taken away is refused, and its own read is told so.
    let limited = f.staff(Role::FrontDesk, "front_desk").await;
    // The policy allows what it is given: the read stays open, and the billing write stays
    // with the practice's billing screens rather than the encounter record.
    billing_only_policy(&f, &limited, "front_desk", true).await;
    grant_policy_module(&f, &limited, "clinical").await;
    let held = f.diagnoses_of(&limited, visit).await;
    assert_eq!(
        held["can_edit"], true,
        "a billing edit grant still corrects"
    );
    let (status, out) = f
        .save_diagnoses(
            &limited,
            visit,
            held["version"].as_i64().unwrap(),
            &["R51.9"],
            "Policy-limited billing correction",
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    let saved = out;
    let disabled = f.staff(Role::FrontDesk, "front_desk").await;
    billing_only_policy(&f, &disabled, "front_desk", false).await;
    grant_policy_module(&f, &disabled, "clinical").await;
    let refused = f.diagnoses_of(&disabled, visit).await;
    assert_eq!(
        refused["can_edit"], false,
        "a policy without the billing edit is told not to offer it"
    );
    let (status, _) = f
        .save_diagnoses(
            &disabled,
            visit,
            refused["version"].as_i64().unwrap(),
            &["Z00.00"],
            "Policy-refused correction",
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A role without billing rights cannot, whatever else it may record.
    let nurse = f.staff(Role::Nurse, "nurse").await;
    let as_nurse = f.diagnoses_of(&nurse, visit).await;
    assert_eq!(
        as_nurse["can_edit"], false,
        "the screen is told not to offer the edit"
    );
    let (status, _) = f
        .save_diagnoses(
            &nurse,
            visit,
            as_nurse["version"].as_i64().unwrap(),
            &["Z00.00"],
            "Nurse attempts a correction",
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let reader = f.staff(Role::ReadOnly, "read_only").await;
    let (status, _) = f
        .save_diagnoses(
            &reader,
            visit,
            as_nurse["version"].as_i64().unwrap(),
            &["Z00.00"],
            "Reader attempts a correction",
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Nothing about a refused write reached the record: same list, same version, same
    // note, and one audit entry for each correction that actually happened.
    let after = f.diagnoses_of(&f.owner, visit).await;
    assert_eq!(
        after["diagnoses"], saved["diagnoses"],
        "a refused correction leaves the list as it was"
    );
    assert_eq!(after["version"], saved["version"]);
    assert_eq!(f.note(visit).await, note);
    // one each by the owner, the signing clinician, the front desk account and the
    // policy-limited one; the refusals leave none.
    assert_eq!(f.action_count("visit.diagnoses_corrected", visit).await, 4);

    // An in-progress visit behaves exactly as it always has: the clinical roles that
    // draft a note write its diagnoses, a biller who does not draft does not, and the
    // write is audited as a plain save.
    let (_, _, open) = f.visit(false).await;
    let open_read = f.diagnoses_of(&desk, open).await;
    assert_eq!(
        open_read["can_edit"], false,
        "front desk does not draft a visit"
    );
    let (status, _) = f
        .save_diagnoses(
            &desk,
            open,
            open_read["version"].as_i64().unwrap(),
            &["R51.9"],
            "Front desk attempts a draft",
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, out) = f
        .save_diagnoses(&signer, open, 1, &["R51.9"], "Initial synthetic coding")
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["can_edit"], true);
    assert_eq!(f.action_count("visit.diagnoses_save", open).await, 1);
    assert_eq!(
        f.action_count("visit.diagnoses_corrected", open).await,
        0,
        "an in-progress visit is never audited as a correction"
    );
}

/// What a claim row holds, read straight from storage. Used where a test must look at a draft
/// without going through the detail screen, which is itself what completes the draft.
async fn stored_content(f: &Fixture, claim_id: &Value) -> Value {
    sqlx::query_scalar("SELECT content FROM ehr_claims WHERE tenant_id=$1 AND id=$2")
        .bind(f.owner.tenant_id)
        .bind(id(claim_id))
        .fetch_one(&f.db)
        .await
        .unwrap()
}

/// What the claim detail screen reports as still wrong with a claim, in the words `preflight`
/// writes: "Tax ID is required", "Subscriber address is required", and so on.
fn issues_of(issues: &Value) -> Vec<String> {
    issues
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| issue.as_str().unwrap().to_owned())
        .collect()
}

/// Whether a billing screen still asks for the thing named. The claim detail reports `preflight`'s
/// own sentences; the visit card runs them through `plain_issue`, which names the field and the
/// thing missing in plainer words. Both spellings are searched, so no screen can quietly disagree
/// with another about what a claim still needs.
fn asked_for(issues: &Value, wanted: &[&str]) -> bool {
    issues_of(issues).iter().any(|issue| {
        let issue = issue.to_ascii_lowercase();
        wanted
            .iter()
            .any(|want| issue.contains(&want.to_ascii_lowercase()))
    })
}

// ---- Charge corrections on posted accounts ---------------------------------------------------

async fn correct(
    f: &Fixture,
    a: &Actor,
    p: Uuid,
    account: &Value,
    lines: Value,
) -> (StatusCode, Value) {
    let mut content = account["content"].clone();
    content["lines"] = lines;
    f.call(
        a,
        "POST",
        &format!("/api/v1/patients/{p}/billing/accounts/{}/corrections", id(account)),
        json!({"request_id":Uuid::new_v4(),"content":content,"reason":"Synthetic charge correction"}),
        Some(version(account)),
    )
    .await
}

fn synthetic_lines(code: &str, cents: i64) -> Value {
    json!([{"code_system":"CPT","code":code,"description":"Synthetic service","modifiers":"","units":1,"amount_cents":cents,"diagnosis_codes":["Z00.00 - Synthetic exam"]}])
}

#[tokio::test]
async fn posted_charges_can_be_corrected_and_the_trail_is_kept() {
    let f = setup().await;
    let (p, _, visit) = f.visit(true).await;
    let posted = f.post(p, &f.charges(p, visit, None, 5000).await).await;
    assert_eq!(posted["status"], "posted");

    let (status, corrected) =
        correct(&f, &f.owner, p, &posted, synthetic_lines("99214", 7500)).await;
    assert_eq!(status, StatusCode::OK, "{corrected}");
    assert_eq!(
        corrected["status"], "posted",
        "a correction never changes the status"
    );
    assert_eq!(corrected["total_cents"], 7500);
    assert_eq!(corrected["content"]["lines"][0]["code"], "99214");
    assert_eq!(version(&corrected), version(&posted) + 1);

    let (before, after): (i64, i64) = sqlx::query_as(
        "SELECT before_total_cents,after_total_cents FROM billing_account_corrections WHERE tenant_id=$1 AND account_id=$2",
    )
    .bind(f.owner.tenant_id)
    .bind(id(&posted))
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(
        (before, after),
        (5000, 7500),
        "the correction keeps the before and after"
    );

    // A stale copy is refused rather than overwriting the newer charges.
    let (stale, _) = correct(&f, &f.owner, p, &posted, synthetic_lines("99212", 4000)).await;
    assert_eq!(stale, StatusCode::CONFLICT);
}

#[tokio::test]
async fn posted_charges_stay_locked_outside_a_correction() {
    let f = setup().await;
    let (p, _, visit) = f.visit(true).await;
    let posted = f.post(p, &f.charges(p, visit, None, 5000).await).await;
    let refused =
        sqlx::query("UPDATE billing_accounts SET total_cents=1 WHERE tenant_id=$1 AND id=$2")
            .bind(f.owner.tenant_id)
            .bind(id(&posted))
            .execute(&f.db)
            .await;
    assert!(
        refused.is_err(),
        "the database still refuses any other write to posted charges"
    );
}

#[tokio::test]
async fn a_draft_account_is_not_corrected_it_is_simply_edited() {
    let f = setup().await;
    let (p, _, visit) = f.visit(true).await;
    let draft = f.charges(p, visit, None, 5000).await;
    let (status, _) = correct(&f, &f.owner, p, &draft, synthetic_lines("99214", 7500)).await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn a_draft_claim_is_voided_so_a_fresh_one_follows_the_corrected_charges() {
    let f = setup().await;
    f.directory(true).await;
    let (p, _, visit) = f.visit(true).await;
    let (_, policy) = f.coverage(p, "primary", "SYN-CORR1", None).await;
    let posted = f
        .post(p, &f.charges(p, visit, Some(id(&policy)), 5000).await)
        .await;
    let (_, prepared) = f.prepare(&f.owner, p, id(&posted), json!({})).await;
    assert_eq!(prepared["outcome"], "prepared", "{prepared}");

    let (status, corrected) =
        correct(&f, &f.owner, p, &posted, synthetic_lines("99214", 7500)).await;
    assert_eq!(status, StatusCode::OK, "{corrected}");
    let claim_status: String =
        sqlx::query_scalar("SELECT status FROM ehr_claims WHERE tenant_id=$1 AND id=$2")
            .bind(f.owner.tenant_id)
            .bind(id(&prepared["claim_id"]))
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(
        claim_status, "void",
        "the draft built from the old charges is voided"
    );

    // The correction prepared the replacement draft itself; asking again returns it.
    let (_, fresh) = f.prepare(&f.owner, p, id(&corrected), json!({})).await;
    assert_eq!(fresh["outcome"], "exists", "{fresh}");
    let total: i64 = sqlx::query_scalar("SELECT (snapshot->'account'->>'total_cents')::bigint FROM ehr_claims WHERE tenant_id=$1 AND id=$2")
        .bind(f.owner.tenant_id)
        .bind(id(&fresh["claim_id"]))
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(total, 7500, "the fresh claim bills the corrected charges");
}

#[tokio::test]
async fn parts_of_one_payment_share_a_group_that_the_summary_and_group_endpoint_return() {
    let f = setup().await;
    let (p, appointment, visit) = f.visit(false).await;
    let group = Uuid::new_v4();
    let part = |cents: i64, method: &str, reference: &str, group: Option<Uuid>| {
        let mut body = json!({"request_id":Uuid::new_v4(),"appointment_id":appointment,"coverage_id":null,"amount_cents":cents,"method":method,"reference":reference,"occurred_on":"2026-10-25","reason":"Synthetic copay at the desk","received_confirmed":true});
        if let Some(group) = group {
            body["payment_group_id"] = json!(group);
        }
        body
    };
    let path = format!("/api/v1/patients/{p}/billing/copays");
    let cash = f
        .ok("POST", &path, part(2500, "cash", "", Some(group)), None)
        .await;
    assert_eq!(cash["payment_group_id"], json!(group));
    let check_body = part(2500, "check", "1042", Some(group));
    let check = f.ok("POST", &path, check_body.clone(), None).await;
    // Repeating the same request returns the same receipt with its group.
    let again = f.ok("POST", &path, check_body, None).await;
    assert_eq!(again["id"], check["id"]);
    assert_eq!(again["payment_group_id"], json!(group));
    let alone = f
        .ok("POST", &path, part(1000, "cash", "", None), None)
        .await;
    assert!(alone["payment_group_id"].is_null());

    let s = f.summary(&f.owner, p, visit).await;
    let receipts = s["patient"]["receipts"]
        .as_array()
        .or_else(|| s["receipts"].as_array())
        .unwrap();
    assert_eq!(receipts.len(), 3);
    assert_eq!(
        receipts
            .iter()
            .filter(|r| r["payment_group_id"] == json!(group))
            .count(),
        2
    );

    let out = f
        .ok(
            "GET",
            &format!("/api/v1/patients/{p}/billing/payment-groups/{group}"),
            json!(null),
            None,
        )
        .await;
    let got = out["receipts"].as_array().unwrap();
    assert_eq!(got.len(), 2);
    assert!(got.iter().all(|r| r["payment_group_id"] == json!(group)));
    let other = f
        .ok(
            "GET",
            &format!(
                "/api/v1/patients/{p}/billing/payment-groups/{}",
                Uuid::new_v4()
            ),
            json!(null),
            None,
        )
        .await;
    assert!(other["receipts"].as_array().unwrap().is_empty());
}

/// Before the insurer answers, patient money above the plan copay is credit on the account: the
/// insurance pending figure stays charges less the copay, and the encounter list reports the same
/// figures for each encounter.
#[tokio::test]
async fn patient_overpayment_before_the_insurer_answers_is_credit_not_a_smaller_claim() {
    let f = setup().await;
    f.directory(true).await;
    let (p, appointment, visit) = f.visit(true).await;
    let (_payer, policy) = f.coverage(p, "primary", "SYN-P", Some(2500)).await;
    let draft = f.charges(p, visit, Some(id(&policy)), 10000).await;
    let posted = f.post(p, &draft).await;
    f.copay(p, appointment, 4000).await;

    let s = f.summary(&f.owner, p, visit).await;
    adds_up(&s);
    assert_eq!(s["insurance"]["pending_cents"], 7500, "{s}");
    assert_eq!(s["patient"]["owes_now_cents"], 0, "{s}");
    assert_eq!(s["patient"]["overpaid_cents"], 1500, "{s}");

    let (status, list) = f
        .call(
            &f.owner,
            "GET",
            &format!("/api/v1/patients/{p}/billing/encounters"),
            json!(null),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let items = list["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{list}");
    let row = &items[0];
    assert_eq!(row["account_id"], json!(id(&posted)));
    assert_eq!(row["total_cents"], 10000);
    assert_eq!(row["pending_cents"], 7500);
    assert_eq!(row["owes_now_cents"], 0);
    assert_eq!(row["overpaid_cents"], 1500);
    assert_eq!(row["patient_payments_cents"], 4000);

    let (status, _) = f
        .call(
            &f.owner,
            "GET",
            &format!("/api/v1/patients/{}/billing/encounters", Uuid::new_v4()),
            json!(null),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
