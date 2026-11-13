// SPDX-License-Identifier: AGPL-3.0-only
//! What each appointment on the schedule still needs: every fact, tenant scoping and
//! the facts left out for staff without billing or clinical access. Synthetic data only.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::{DateTime, Duration, Utc};
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
    owner: Uuid,
    cookie: String,
    payer: Uuid,
    template: Uuid,
    /// 15:00 UTC on a fixed day well in the future, so nothing depends on today.
    day: DateTime<Utc>,
}

impl Fixture {
    async fn new() -> Self {
        let url =
            std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
        let initial = PgPool::connect(&url).await.unwrap();
        let schema = format!("schedule_markers_{}", Uuid::new_v4().simple());
        suncharts_engine::test_db::create_schema(&initial, &schema).await;
        initial.close().await;
        let db = PgPoolOptions::new()
            .max_connections(8)
            .after_connect(move |connection, _| {
                let sql = format!("SET search_path TO {schema}");
                Box::pin(async move {
                    sqlx::query(&sql).execute(connection).await?;
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
            template: Uuid::new_v4(),
            day: "2031-03-14T15:00:00Z".parse().unwrap(),
        };
        let (owner, cookie) = fixture.staff(fixture.tenant, "owner").await;
        fixture.owner = owner;
        fixture.cookie = cookie;
        fixture
            .practice(fixture.tenant, fixture.payer, fixture.template, owner)
            .await;
        fixture
    }
    /// A staff member with a signed-in browser session.
    async fn staff(&self, tenant: Uuid, role: &str) -> (Uuid, String) {
        let user = Uuid::new_v4();
        sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,display_name) VALUES($1,$2,$3,'unused',$4,'Synthetic Staff')")
            .bind(user).bind(tenant).bind(format!("{}@example.test", user.simple())).bind(role).execute(&self.db).await.unwrap();
        let token = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')")
            .bind(format!("{:x}", Sha256::digest(token.as_bytes()))).bind(tenant).bind(user).execute(&self.db).await.unwrap();
        (user, format!("sce_session={token}"))
    }
    async fn practice(&self, tenant: Uuid, payer: Uuid, template: Uuid, owner: Uuid) {
        sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,$3,$2,'synthetic')")
            .bind(tenant).bind(payer).bind(json!({"name":"Synthetic Health Plan","payer_code":"SYN"})).execute(&self.db).await.unwrap();
        sqlx::query("INSERT INTO previsit_intake_templates(tenant_id,id,name,schema,updated_by) VALUES($1,$2,'Synthetic intake','{}'::jsonb,$3)")
            .bind(tenant).bind(template).bind(owner).execute(&self.db).await.unwrap();
    }
    /// Limits a staff member with a custom access policy that hides the named areas.
    async fn hide(&self, user: Uuid, base_role: &str, hidden: &[&str]) {
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
        sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(self.tenant).bind(policy).bind(format!("Policy {}", policy.simple())).bind(base_role).bind(Value::Object(permissions)).bind(self.owner).execute(&self.db).await.unwrap();
        sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)")
            .bind(self.tenant).bind(user).bind(policy).bind(self.owner).execute(&self.db).await.unwrap();
    }
    async fn get(&self, cookie: Option<&str>, path: &str) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method("GET")
            .uri(path)
            .header("Origin", ORIGIN);
        if let Some(cookie) = cookie {
            request = request.header("Cookie", cookie);
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(json!({})))
    }
    fn range(&self, from: DateTime<Utc>, to: DateTime<Utc>) -> String {
        format!(
            "/api/v1/schedule/markers?from={}&to={}",
            from.format("%Y-%m-%dT%H:%M:%SZ"),
            to.format("%Y-%m-%dT%H:%M:%SZ")
        )
    }
    /// Markers for the fixture's day, keyed by appointment.
    async fn markers(&self, cookie: &str) -> Value {
        let (status, body) = self
            .get(
                Some(cookie),
                &self.range(
                    self.day - Duration::hours(12),
                    self.day + Duration::hours(12),
                ),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }
    async fn patient(&self, tenant: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Synthetic','Sample','1990-01-01')")
            .bind(tenant).bind(id).bind(id.to_string()).execute(&self.db).await.unwrap();
        id
    }
    async fn appointment_at(
        &self,
        tenant: Uuid,
        patient: Uuid,
        clinician: Uuid,
        starts: DateTime<Utc>,
        status: &str,
    ) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status,title,category,facility,room,notes,request_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,'Office visit','Office visit','','','',$2,'synthetic')")
            .bind(tenant).bind(id).bind(patient).bind(clinician).bind(starts).bind(starts + Duration::minutes(30)).bind(status).execute(&self.db).await.unwrap();
        id
    }
    /// A patient with one appointment on the fixture's day.
    async fn visit_today(&self, status: &str) -> (Uuid, Uuid) {
        let patient = self.patient(self.tenant).await;
        let appointment = self
            .appointment_at(self.tenant, patient, self.owner, self.day, status)
            .await;
        (patient, appointment)
    }
    async fn coverage(&self, patient: Uuid, content: Value) -> Uuid {
        let id = Uuid::new_v4();
        let mut full = json!({"payer_id":self.payer,"priority":"primary","status":"active","member_id":"SYN-MEMBER","effective_date":"2030-01-01","end_date":null,"copay_cents":null});
        for (key, value) in content.as_object().unwrap() {
            full[key] = value.clone();
        }
        sqlx::query("INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,$2,'synthetic')")
            .bind(self.tenant).bind(id).bind(patient).bind(self.payer).bind(full).execute(&self.db).await.unwrap();
        id
    }
    /// An eligibility check recorded at `created`, answered with the given benefit
    /// codes, refused (`None`) or still waiting (`pending`).
    async fn check(
        &self,
        patient: Uuid,
        coverage: Uuid,
        created: DateTime<Utc>,
        codes: Option<&[&str]>,
        pending: bool,
    ) {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO claimmd_eligibility_checks(tenant_id,id,patient_id,coverage_id,request_id,creation_hash,route_key,request_snapshot,status,actor_id,created_at) VALUES($1,$2,$3,$4,$2,'synthetic','synthetic','{\"request\":{\"service_date\":\"1999-01-01\"}}'::jsonb,'pending',$5,$6)")
            .bind(self.tenant).bind(id).bind(patient).bind(coverage).bind(self.owner).bind(created).execute(&self.db).await.unwrap();
        if pending {
            return;
        }
        match codes {
            Some(codes) => {
                let benefits: Vec<Value> = codes
                    .iter()
                    .map(|code| json!({"benefit_coverage_code":code}))
                    .collect();
                sqlx::query("UPDATE claimmd_eligibility_checks SET status='completed',response_snapshot=$3,completed_at=now() WHERE tenant_id=$1 AND id=$2")
                    .bind(self.tenant).bind(id).bind(json!({"elig":[{"benefit":benefits}]})).execute(&self.db).await.unwrap();
            }
            None => {
                sqlx::query("UPDATE claimmd_eligibility_checks SET status='failed',completed_at=now() WHERE tenant_id=$1 AND id=$2")
                    .bind(self.tenant).bind(id).execute(&self.db).await.unwrap();
            }
        }
    }
    #[allow(clippy::too_many_arguments)]
    async fn form(
        &self,
        tenant: Uuid,
        template: Uuid,
        issuer: Uuid,
        patient: Uuid,
        appointment: Option<Uuid>,
        status: &str,
        created: DateTime<Utc>,
        expired: bool,
    ) -> Uuid {
        let id = Uuid::new_v4();
        let submitted = matches!(status, "submitted" | "reviewed");
        let reviewed = status == "reviewed";
        sqlx::query("INSERT INTO previsit_intake_packets(tenant_id,id,appointment_id,patient_id,template_id,template_version,template_snapshot,access_token_hash,status,due_at,issued_by,submitted_at,reviewed_at,reviewed_by,created_at,expires_at) VALUES($1,$2,$3,$4,$5,1,'{}'::jsonb,$6,$7,now(),$8,CASE WHEN $9 THEN now() END,CASE WHEN $10 THEN now() END,CASE WHEN $10 THEN $8 END,$11,CASE WHEN $12 THEN now()-interval '1 day' ELSE now()+interval '14 days' END)")
            .bind(tenant).bind(id).bind(appointment).bind(patient).bind(template)
            .bind(format!("{:x}", Sha256::digest(id.as_bytes()))).bind(status).bind(issuer)
            .bind(submitted).bind(reviewed).bind(created).bind(expired).execute(&self.db).await.unwrap();
        id
    }
    async fn receipt(&self, patient: Uuid, appointment: Uuid, cents: i64) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO billing_copay_receipts(tenant_id,id,patient_id,appointment_id,amount_cents,method,reference,occurred_on,reason,request_id,creation_hash,actor_id) VALUES($1,$2,$3,$4,$5,'cash','','2031-03-14','Synthetic copay',$2,'synthetic',$6)")
            .bind(self.tenant).bind(id).bind(patient).bind(appointment).bind(cents).bind(self.owner).execute(&self.db).await.unwrap();
        id
    }
    /// Ties a receipt to a card checkout, in test or live mode, with a refund.
    async fn card(
        &self,
        patient: Uuid,
        appointment: Uuid,
        receipt: Uuid,
        cents: i64,
        live: bool,
        refunded: i64,
    ) {
        sqlx::query("INSERT INTO payment_settings(tenant_id,id,mode) VALUES($1,$2,'own_stripe') ON CONFLICT (tenant_id) DO NOTHING")
            .bind(self.tenant).bind(Uuid::new_v4()).execute(&self.db).await.unwrap();
        let setting: Uuid =
            sqlx::query_scalar("SELECT id FROM payment_settings WHERE tenant_id=$1")
                .bind(self.tenant)
                .fetch_one(&self.db)
                .await
                .unwrap();
        sqlx::query("INSERT INTO payment_credentials(tenant_id,setting_id,revision,encrypted_config) VALUES($1,$2,1,'\\x00') ON CONFLICT DO NOTHING")
            .bind(self.tenant).bind(setting).execute(&self.db).await.unwrap();
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO copay_checkout_attempts(tenant_id,id,patient_id,appointment_id,setting_id,credential_revision,installation_id,provider_account_id,livemode,amount_cents,request_id,creation_hash,requested_by,reason,return_url,status,receipt_id,refunded_cents) VALUES($1,$2,$3,$4,$5,1,$2,$6,$7,$8,$2,'synthetic',$9,'Synthetic','http://127.0.0.1:8099/',$10,$11,$12)")
            .bind(self.tenant).bind(id).bind(patient).bind(appointment).bind(setting).bind(format!("acct_{}", id.simple())).bind(live).bind(cents).bind(self.owner)
            .bind(if refunded > 0 { "refunded" } else { "paid" }).bind(receipt).bind(refunded).execute(&self.db).await.unwrap();
    }
    /// A started visit for an appointment: its note not started, in progress or signed.
    async fn visit(&self, patient: Uuid, appointment: Uuid, note: &str) -> Uuid {
        let id = Uuid::new_v4();
        match note {
            "signed" => sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed','{\"subjective\":\"Synthetic\"}'::jsonb,$5,now())"),
            "in_progress" => sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note) VALUES($1,$2,$3,$4,$5,'in_progress','{\"subjective\":\"Synthetic\"}'::jsonb)"),
            _ => sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id) VALUES($1,$2,$3,$4,$5)"),
        }
        .bind(self.tenant).bind(id).bind(patient).bind(appointment).bind(self.owner).execute(&self.db).await.unwrap();
        id
    }
    /// A charge account for a visit, optionally with an invoice asking the patient for `due`.
    async fn account(&self, patient: Uuid, visit: Uuid, status: &str, due: Option<i64>) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO billing_accounts(tenant_id,id,patient_id,visit_id,content,total_cents,status,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,20000,$6,$2,'synthetic')")
            .bind(self.tenant).bind(id).bind(patient).bind(visit).bind(json!({"visit_id":visit,"service_date":"2031-03-14","lines":[]})).bind(status).execute(&self.db).await.unwrap();
        if let Some(due) = due {
            sqlx::query("INSERT INTO patient_invoice_snapshots(tenant_id,id,patient_id,account_id,request_id,creation_hash,account_version,snapshot,actor_id) VALUES($1,$2,$3,$4,$2,'synthetic',1,$5,$6)")
                .bind(self.tenant).bind(Uuid::new_v4()).bind(patient).bind(id).bind(json!({"amount_due_cents":due,"responsibility_cents":due,"credit_balance_cents":0,"currency":"USD"})).bind(self.owner).execute(&self.db).await.unwrap();
        }
        id
    }
    /// An earlier, finished visit so the patient is not new, optionally leaving a balance.
    async fn earlier_visit(&self, patient: Uuid, owes: Option<i64>) {
        let appointment = self
            .appointment_at(
                self.tenant,
                patient,
                self.owner,
                self.day - Duration::days(40),
                "completed",
            )
            .await;
        let visit = self.visit(patient, appointment, "signed").await;
        if owes.is_some() {
            self.account(patient, visit, "posted", owes).await;
        }
    }
}

fn item(body: &Value, appointment: Uuid) -> &Value {
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["appointment_id"] == appointment.to_string())
        .unwrap_or_else(|| panic!("no markers for appointment {appointment}"))
}

#[tokio::test]
async fn intake_form_and_new_patient_facts_follow_each_appointment() {
    let f = Fixture::new().await;
    let recent = f.day - Duration::days(3);
    let mut expected = Vec::new();
    for status in ["sent", "in_progress", "submitted", "reviewed"] {
        let (patient, appointment) = f.visit_today("booked").await;
        let packet = f
            .form(
                f.tenant,
                f.template,
                f.owner,
                patient,
                Some(appointment),
                status,
                recent,
                false,
            )
            .await;
        expected.push((appointment, status, packet));
    }
    // No form, a cancelled form and a form whose link ran out all read as "none sent".
    let (_, none) = f.visit_today("booked").await;
    let (cancelled_patient, cancelled) = f.visit_today("booked").await;
    f.form(
        f.tenant,
        f.template,
        f.owner,
        cancelled_patient,
        Some(cancelled),
        "void",
        recent,
        false,
    )
    .await;
    let (expired_patient, expired) = f.visit_today("booked").await;
    f.form(
        f.tenant,
        f.template,
        f.owner,
        expired_patient,
        Some(expired),
        "sent",
        recent,
        true,
    )
    .await;
    // A form sent from the chart without an appointment counts for a visit soon after…
    let (chart_patient, chart) = f.visit_today("booked").await;
    let chart_packet = f
        .form(
            f.tenant,
            f.template,
            f.owner,
            chart_patient,
            None,
            "submitted",
            recent,
            false,
        )
        .await;
    // …but not for a visit months later, and not when sent after the visit started.
    let (old_patient, old) = f.visit_today("booked").await;
    f.form(
        f.tenant,
        f.template,
        f.owner,
        old_patient,
        None,
        "reviewed",
        f.day - Duration::days(90),
        false,
    )
    .await;
    let (late_patient, late) = f.visit_today("completed").await;
    f.form(
        f.tenant,
        f.template,
        f.owner,
        late_patient,
        None,
        "sent",
        f.day + Duration::hours(2),
        false,
    )
    .await;
    // The form sent for the appointment itself wins over one sent from the chart.
    let (both_patient, both) = f.visit_today("booked").await;
    f.form(
        f.tenant,
        f.template,
        f.owner,
        both_patient,
        None,
        "reviewed",
        recent,
        false,
    )
    .await;
    let own = f
        .form(
            f.tenant,
            f.template,
            f.owner,
            both_patient,
            Some(both),
            "sent",
            recent,
            false,
        )
        .await;

    // New patient: nothing earlier here or in imported history.
    let (returning, second) = f.visit_today("booked").await;
    f.earlier_visit(returning, None).await;
    let (missed, after_missed) = f.visit_today("booked").await;
    f.appointment_at(
        f.tenant,
        missed,
        f.owner,
        f.day - Duration::days(10),
        "no_show",
    )
    .await;
    f.appointment_at(
        f.tenant,
        missed,
        f.owner,
        f.day - Duration::days(9),
        "cancelled",
    )
    .await;
    let (imported, after_import) = f.visit_today("booked").await;
    let job = Uuid::new_v4();
    sqlx::query("INSERT INTO migration_jobs(id,tenant_id,source_instance,manifest) VALUES($1,$2,'synthetic','{}'::jsonb)")
        .bind(job).bind(f.tenant).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO historical_records(id,tenant_id,patient_id,job_id,kind,source_instance,source_id,data,source_data,source_digest,imported_by) VALUES($1,$2,$3,$4,'appointment','synthetic','1','{}'::jsonb,'{}'::jsonb,'synthetic',$5)")
        .bind(Uuid::new_v4()).bind(f.tenant).bind(imported).bind(job).bind(f.owner).execute(&f.db).await.unwrap();
    // Two visits on the same day: only the first is the patient's first.
    let twice = f.patient(f.tenant).await;
    let first = f
        .appointment_at(
            f.tenant,
            twice,
            f.owner,
            f.day - Duration::hours(2),
            "booked",
        )
        .await;
    let later = f
        .appointment_at(
            f.tenant,
            twice,
            f.owner,
            f.day + Duration::hours(2),
            "booked",
        )
        .await;

    let body = f.markers(&f.cookie).await;
    for (appointment, status, packet) in expected {
        assert_eq!(
            item(&body, appointment)["forms"],
            json!({"status":status,"packet_id":packet})
        );
    }
    for appointment in [none, cancelled, expired, old, late] {
        assert_eq!(item(&body, appointment)["forms"], Value::Null);
    }
    assert_eq!(
        item(&body, chart)["forms"],
        json!({"status":"submitted","packet_id":chart_packet})
    );
    assert_eq!(
        item(&body, both)["forms"],
        json!({"status":"sent","packet_id":own})
    );

    assert_eq!(item(&body, none)["new_patient"], true);
    assert_eq!(item(&body, second)["new_patient"], false);
    assert_eq!(
        item(&body, after_missed)["new_patient"],
        true,
        "a missed or cancelled appointment is not a first visit"
    );
    assert_eq!(item(&body, after_import)["new_patient"], false);
    assert_eq!(item(&body, first)["new_patient"], true);
    assert_eq!(item(&body, later)["new_patient"], false);
}

#[tokio::test]
async fn insurance_copay_balance_note_and_charge_facts_are_correct() {
    let f = Fixture::new().await;
    let yesterday = f.day - Duration::days(1);
    // Insurance: the latest answer for the coverage that pays first, near the visit.
    let (active_patient, active) = f.visit_today("booked").await;
    let active_coverage = f
        .coverage(active_patient, json!({"copay_cents":2500}))
        .await;
    f.check(
        active_patient,
        active_coverage,
        yesterday - Duration::days(2),
        None,
        false,
    )
    .await;
    f.check(
        active_patient,
        active_coverage,
        yesterday,
        Some(&["6", "1"]),
        false,
    )
    .await;
    f.check(
        active_patient,
        active_coverage,
        yesterday + Duration::hours(1),
        None,
        true,
    )
    .await;
    let (inactive_patient, inactive) = f.visit_today("booked").await;
    let inactive_coverage = f.coverage(inactive_patient, json!({})).await;
    f.check(
        inactive_patient,
        inactive_coverage,
        yesterday,
        Some(&["6"]),
        false,
    )
    .await;
    let (failed_patient, failed) = f.visit_today("booked").await;
    let failed_coverage = f.coverage(failed_patient, json!({})).await;
    f.check(
        failed_patient,
        failed_coverage,
        yesterday - Duration::days(1),
        Some(&["1"]),
        false,
    )
    .await;
    f.check(failed_patient, failed_coverage, yesterday, None, false)
        .await;
    let (unclear_patient, unclear) = f.visit_today("booked").await;
    let unclear_coverage = f.coverage(unclear_patient, json!({})).await;
    f.check(
        unclear_patient,
        unclear_coverage,
        yesterday,
        Some(&["A"]),
        false,
    )
    .await;
    let (unchecked_patient, unchecked) = f.visit_today("booked").await;
    let unchecked_coverage = f
        .coverage(unchecked_patient, json!({"copay_cents":1500}))
        .await;
    let (stale_patient, stale) = f.visit_today("booked").await;
    let stale_coverage = f.coverage(stale_patient, json!({})).await;
    f.check(
        stale_patient,
        stale_coverage,
        f.day - Duration::days(45),
        Some(&["1"]),
        false,
    )
    .await;
    let (_, self_pay) = f.visit_today("booked").await;
    let (ended_patient, ended) = f.visit_today("booked").await;
    f.coverage(
        ended_patient,
        json!({"end_date":"2031-01-31","copay_cents":4000}),
    )
    .await;
    let (off_patient, off) = f.visit_today("booked").await;
    f.coverage(off_patient, json!({"status":"inactive","copay_cents":4000}))
        .await;
    // With no primary coverage, the next one in line is the one that pays first.
    let (second_patient, second) = f.visit_today("booked").await;
    let tertiary = f
        .coverage(
            second_patient,
            json!({"priority":"tertiary","copay_cents":900}),
        )
        .await;
    let secondary = f
        .coverage(
            second_patient,
            json!({"priority":"secondary","copay_cents":1000}),
        )
        .await;
    f.check(second_patient, tertiary, yesterday, Some(&["6"]), false)
        .await;
    f.check(second_patient, secondary, yesterday, Some(&["1"]), false)
        .await;

    // Copay: what the plan asks for against what was received for this appointment.
    f.receipt(active_patient, active, 2500).await;
    let part = f.receipt(unchecked_patient, unchecked, 500).await;
    let voided = f.receipt(unchecked_patient, unchecked, 1000).await;
    sqlx::query("INSERT INTO billing_copay_voids(tenant_id,receipt_id,reason,actor_id) VALUES($1,$2,'Synthetic void',$3)")
        .bind(f.tenant).bind(voided).bind(f.owner).execute(&f.db).await.unwrap();
    let test_receipt = f.receipt(inactive_patient, inactive, 3000).await;
    f.card(inactive_patient, inactive, test_receipt, 3000, false, 0)
        .await;
    let refunded = f.receipt(failed_patient, failed, 2000).await;
    f.card(failed_patient, failed, refunded, 2000, true, 1500)
        .await;
    let _ = part;

    // Balance: the same figure the patient billing summary shows as "Patient owes".
    f.earlier_visit(active_patient, Some(4500)).await;
    f.earlier_visit(active_patient, Some(1200)).await;
    f.earlier_visit(inactive_patient, None).await;
    // An account changed after its invoice is not asserted as debt.
    let changed_appointment = f
        .appointment_at(
            f.tenant,
            failed_patient,
            f.owner,
            f.day - Duration::days(20),
            "completed",
        )
        .await;
    let changed_visit = f.visit(failed_patient, changed_appointment, "signed").await;
    let changed = f
        .account(failed_patient, changed_visit, "draft", Some(9900))
        .await;
    let _ = changed;

    // Note and charges for visits that have started.
    let (signed_patient, signed) = f.visit_today("completed").await;
    let signed_visit = f.visit(signed_patient, signed, "signed").await;
    f.account(signed_patient, signed_visit, "posted", None)
        .await;
    let (writing_patient, writing) = f.visit_today("in_progress").await;
    let writing_visit = f.visit(writing_patient, writing, "in_progress").await;
    f.account(writing_patient, writing_visit, "draft", None)
        .await;
    let (blank_patient, blank) = f.visit_today("in_progress").await;
    let blank_visit = f.visit(blank_patient, blank, "not_started").await;
    f.account(blank_patient, blank_visit, "void", None).await;

    let body = f.markers(&f.cookie).await;
    assert_eq!(body["billing"], true);
    assert_eq!(body["insurance"], true);
    assert_eq!(body["clinical"], true);
    let insurance = |appointment| item(&body, appointment)["insurance"].clone();
    assert_eq!(
        insurance(active)["status"],
        "active",
        "a pending check never hides the last answer"
    );
    assert_eq!(
        insurance(active)["coverage_id"],
        active_coverage.to_string()
    );
    assert!(insurance(active)["checked_at"].is_string());
    assert_eq!(insurance(inactive)["status"], "not_active");
    assert_eq!(
        insurance(failed)["status"],
        "check_failed",
        "the latest check wins"
    );
    assert_eq!(insurance(unclear)["status"], "check_failed");
    assert_eq!(
        insurance(unchecked),
        json!({"status":"not_checked","coverage_id":unchecked_coverage})
    );
    assert_eq!(
        insurance(stale)["status"],
        "not_checked",
        "an old answer is not near this visit"
    );
    for appointment in [self_pay, ended, off] {
        assert_eq!(insurance(appointment), json!({"status":"self_pay"}));
        assert_eq!(item(&body, appointment)["copay"], Value::Null);
    }
    assert_eq!(insurance(second)["status"], "active");
    assert_eq!(insurance(second)["coverage_id"], secondary.to_string());

    let copay = |appointment| item(&body, appointment)["copay"].clone();
    assert_eq!(
        copay(active),
        json!({"due_cents":2500,"paid_cents":2500,"test_paid_cents":0})
    );
    assert_eq!(
        copay(unchecked),
        json!({"due_cents":1500,"paid_cents":500,"test_paid_cents":0}),
        "a voided receipt is not money received"
    );
    assert_eq!(
        copay(inactive),
        json!({"due_cents":0,"paid_cents":0,"test_paid_cents":3000}),
        "a test card payment is kept apart"
    );
    assert_eq!(
        copay(failed),
        json!({"due_cents":0,"paid_cents":500,"test_paid_cents":0}),
        "refunds are taken off"
    );
    assert_eq!(copay(second)["due_cents"], 1000);
    assert_eq!(
        copay(unclear),
        Value::Null,
        "no copay recorded and nothing received"
    );

    assert_eq!(item(&body, active)["balance_cents"], 5700);
    assert_eq!(item(&body, inactive)["balance_cents"], 0);
    assert_eq!(item(&body, failed)["balance_cents"], 0);
    let (status, overview) = f
        .get(
            Some(&f.cookie),
            &format!("/api/v1/billing/overview?patient_id={active_patient}"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{overview}");
    assert_eq!(
        overview["summary"]["accounts"]["reviewed_patient_due_cents"],
        item(&body, active)["balance_cents"],
        "the marker and the patient billing summary agree"
    );

    for (appointment, visit, note, charges) in [
        (signed, Some(signed_visit), json!("signed"), json!("posted")),
        (
            writing,
            Some(writing_visit),
            json!("in_progress"),
            json!("draft"),
        ),
        (
            blank,
            Some(blank_visit),
            json!("not_started"),
            json!("none"),
        ),
        (active, None, Value::Null, Value::Null),
    ] {
        let facts = item(&body, appointment);
        assert_eq!(facts["visit_id"], json!(visit));
        assert_eq!(facts["note"], note);
        assert_eq!(facts["charges"], charges);
    }
}

#[tokio::test]
async fn markers_are_scoped_to_the_practice_the_range_and_the_provider() {
    let f = Fixture::new().await;
    let (patient, appointment) = f.visit_today("booked").await;
    let coverage = f.coverage(patient, json!({"copay_cents":1500})).await;
    f.check(
        patient,
        coverage,
        f.day - Duration::days(1),
        Some(&["1"]),
        false,
    )
    .await;
    let (other_clinician, _) = f.staff(f.tenant, "clinician").await;
    let colleague_patient = f.patient(f.tenant).await;
    let colleague = f
        .appointment_at(
            f.tenant,
            colleague_patient,
            other_clinician,
            f.day,
            "booked",
        )
        .await;
    let tomorrow_patient = f.patient(f.tenant).await;
    let tomorrow = f
        .appointment_at(
            f.tenant,
            tomorrow_patient,
            f.owner,
            f.day + Duration::days(1),
            "booked",
        )
        .await;

    // Another practice in the same database, with facts of its own.
    let elsewhere = Uuid::new_v4();
    let (stranger, stranger_cookie) = f.staff(elsewhere, "owner").await;
    let (their_payer, their_template) = (Uuid::new_v4(), Uuid::new_v4());
    f.practice(elsewhere, their_payer, their_template, stranger)
        .await;
    let their_patient = f.patient(elsewhere).await;
    let theirs = f
        .appointment_at(elsewhere, their_patient, stranger, f.day, "booked")
        .await;
    f.form(
        elsewhere,
        their_template,
        stranger,
        their_patient,
        Some(theirs),
        "submitted",
        f.day - Duration::days(1),
        false,
    )
    .await;

    let mine = f.markers(&f.cookie).await;
    let ids: Vec<&str> = mine["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["appointment_id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids.len(),
        2,
        "only this practice's visits on this day: {ids:?}"
    );
    assert!(ids.contains(&appointment.to_string().as_str()));
    assert!(ids.contains(&colleague.to_string().as_str()));
    assert!(!mine.to_string().contains(&their_patient.to_string()));
    assert_eq!(item(&mine, appointment)["patient_id"], patient.to_string());

    let theirs_seen = f.markers(&stranger_cookie).await;
    let items = theirs_seen["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["appointment_id"], theirs.to_string());
    assert_eq!(items[0]["forms"]["status"], "submitted");
    assert_eq!(items[0]["insurance"], json!({"status":"self_pay"}));

    let base = f.range(f.day - Duration::hours(12), f.day + Duration::hours(12));
    let (status, filtered) = f
        .get(
            Some(&f.cookie),
            &format!("{base}&provider={other_clinician}"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        filtered["items"][0]["appointment_id"],
        colleague.to_string()
    );
    // A provider of another practice selects nothing here.
    let (_, none) = f
        .get(Some(&f.cookie), &format!("{base}&provider={stranger}"))
        .await;
    assert_eq!(none["items"], json!([]));
    let (_, wider) = f
        .get(
            Some(&f.cookie),
            &f.range(f.day - Duration::hours(12), f.day + Duration::hours(36)),
        )
        .await;
    assert_eq!(wider["items"].as_array().unwrap().len(), 3);
    assert_eq!(item(&wider, tomorrow)["new_patient"], true);

    for bad in [
        f.range(f.day, f.day),
        f.range(f.day, f.day - Duration::hours(1)),
        f.range(f.day, f.day + Duration::days(32)),
        format!("{base}&clinician_id={other_clinician}"),
        "/api/v1/schedule/markers".into(),
    ] {
        let (status, _) = f.get(Some(&f.cookie), &bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    }
    let (status, _) = f.get(None, &base).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // The practice's opening hours travel with the provider list once they are set.
    let (_, providers) = f.get(Some(&f.cookie), "/api/v1/schedule/providers").await;
    assert_eq!(providers["hours"], Value::Null);
    assert_eq!(providers["items"].as_array().unwrap().len(), 2);
    sqlx::query("INSERT INTO previsit_booking_profiles(tenant_id,public_slug,default_clinician_id,booking_timezone,day_start,day_end,updated_by) VALUES($1,'synthetic-clinic',$2,'America/Chicago','08:30','16:45',$2)")
        .bind(f.tenant).bind(f.owner).execute(&f.db).await.unwrap();
    let (_, providers) = f.get(Some(&f.cookie), "/api/v1/schedule/providers").await;
    assert_eq!(
        providers["hours"],
        json!({"start":"08:30","end":"16:45","timezone":"America/Chicago"})
    );
    let (_, theirs) = f
        .get(Some(&stranger_cookie), "/api/v1/schedule/providers")
        .await;
    assert_eq!(theirs["hours"], Value::Null, "hours belong to one practice");
    // Reading the markers is recorded like reading the schedule.
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='schedule.markers_read'",
    )
    .bind(f.tenant)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert!(audited >= 4);
}

#[tokio::test]
async fn billing_and_clinical_facts_are_left_out_for_staff_without_that_access() {
    let f = Fixture::new().await;
    let (patient, appointment) = f.visit_today("completed").await;
    let coverage = f.coverage(patient, json!({"copay_cents":1500})).await;
    f.check(
        patient,
        coverage,
        f.day - Duration::days(1),
        Some(&["1"]),
        false,
    )
    .await;
    f.receipt(patient, appointment, 500).await;
    f.earlier_visit(patient, Some(4500)).await;
    let visit = f.visit(patient, appointment, "in_progress").await;
    f.account(patient, visit, "draft", None).await;
    f.form(
        f.tenant,
        f.template,
        f.owner,
        patient,
        Some(appointment),
        "submitted",
        f.day - Duration::days(1),
        false,
    )
    .await;

    let keys = |body: &Value| -> Vec<String> {
        let mut keys: Vec<String> = item(body, appointment)
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    };
    let everything = [
        "appointment_id",
        "balance_cents",
        "charges",
        "copay",
        "forms",
        "insurance",
        "new_patient",
        "note",
        "patient_id",
        "visit_id",
    ];
    let without = |hidden: &[&str]| -> Vec<String> {
        everything
            .iter()
            .filter(|key| !hidden.contains(key))
            .map(|key| key.to_string())
            .collect()
    };
    // Every staff role that can see the schedule sees the markers.
    for role in [
        "owner",
        "clinician",
        "nurse",
        "medical_assistant",
        "front_desk",
        "read_only",
    ] {
        let (_, cookie) = f.staff(f.tenant, role).await;
        let body = f.markers(&cookie).await;
        assert_eq!(keys(&body), without(&[]), "{role}");
        assert_eq!(item(&body, appointment)["balance_cents"], 4500);
        assert_eq!(
            item(&body, appointment)["copay"],
            json!({"due_cents":1500,"paid_cents":500,"test_paid_cents":0})
        );
    }
    // A front desk policy without patient billing: no insurance, copay, balance or charges.
    let (desk, desk_cookie) = f.staff(f.tenant, "front_desk").await;
    f.hide(desk, "front_desk", &["billing"]).await;
    let body = f.markers(&desk_cookie).await;
    assert_eq!(body["billing"], false);
    assert_eq!(body["insurance"], false);
    assert_eq!(body["clinical"], true);
    assert_eq!(
        keys(&body),
        without(&["insurance", "copay", "balance_cents", "charges"])
    );
    assert_eq!(item(&body, appointment)["forms"]["status"], "submitted");
    assert_eq!(item(&body, appointment)["note"], "in_progress");
    let text = body.to_string();
    for leaked in ["4500", "1500", &coverage.to_string()] {
        assert!(
            !text.contains(leaked),
            "billing detail {leaked} was returned"
        );
    }
    // Eligibility answers are claim connection data: without claims access the copay and
    // balance stay but the insurance result does not.
    let (claims, claims_cookie) = f.staff(f.tenant, "front_desk").await;
    f.hide(claims, "front_desk", &["claims"]).await;
    let body = f.markers(&claims_cookie).await;
    assert_eq!(
        (body["billing"].clone(), body["insurance"].clone()),
        (json!(true), json!(false))
    );
    assert_eq!(keys(&body), without(&["insurance"]));
    // Without clinical access the note state is left out.
    let (clerk, clerk_cookie) = f.staff(f.tenant, "front_desk").await;
    f.hide(clerk, "front_desk", &["clinical"]).await;
    let body = f.markers(&clerk_cookie).await;
    assert_eq!(body["clinical"], false);
    assert_eq!(keys(&body), without(&["note"]));
    // Without schedule access there are no markers at all, as for the schedule itself.
    let (blocked, blocked_cookie) = f.staff(f.tenant, "front_desk").await;
    f.hide(blocked, "front_desk", &["scheduling"]).await;
    let path = f.range(f.day - Duration::hours(12), f.day + Duration::hours(12));
    let (status, _) = f.get(Some(&blocked_cookie), &path).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = f
        .get(
            Some(&blocked_cookie),
            &path
                .replace("/schedule/markers?from=", "/schedule?start=")
                .replace("&to=", "&end="),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "the same rule as the schedule"
    );
    // A policy written for another role restricts everything, markers included.
    let (mismatch, mismatch_cookie) = f.staff(f.tenant, "nurse").await;
    f.hide(mismatch, "front_desk", &[]).await;
    let (status, _) = f.get(Some(&mismatch_cookie), &path).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[test]
fn the_contract_lists_the_markers_route_and_the_practice_hours() {
    let spec: Value = serde_json::from_str(include_str!("../api/openapi.json")).unwrap();
    let operation = &spec["paths"]["/api/v1/schedule/markers"]["get"];
    assert_eq!(operation["operationId"], "scheduleMarkers");
    let names: Vec<&str> = operation["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|parameter| parameter["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["from", "to", "provider"]);
    let marker = &spec["components"]["schemas"]["ScheduleMarkers"]["properties"]["items"]["items"];
    assert_eq!(
        marker["required"],
        json!([
            "appointment_id",
            "patient_id",
            "new_patient",
            "visit_id",
            "forms"
        ]),
        "billing and clinical facts are optional because some staff do not receive them"
    );
    for fact in ["insurance", "copay", "balance_cents", "note", "charges"] {
        assert!(marker["properties"][fact].is_object(), "{fact}");
    }
    assert!(spec["components"]["schemas"]["ScheduleProviders"]["properties"]["hours"].is_object());
}
