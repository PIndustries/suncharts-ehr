// SPDX-License-Identifier: AGPL-3.0-only
use super::quick::{enrollment_with_route, quick_with_route, QuickRequest};
use super::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

type Received = Arc<Mutex<Vec<HashMap<String, String>>>>;

/// A disposable schema with one synthetic patient, payer and self-held coverage, and a
/// loopback stand-in for Claim.MD whose next answer each test sets.
struct Fixture {
    url: String,
    schema: String,
    pool: PgPool,
    state: State,
    tenant: Uuid,
    patient: Uuid,
    payer: Uuid,
    coverage: Uuid,
    actor: Actor,
    route: Route,
    received: Received,
    answer: Arc<Mutex<Value>>,
    server: tokio::task::JoinHandle<()>,
}

fn staff(tenant: Uuid, role: crate::auth::Role) -> Actor {
    Actor {
        sub: Uuid::new_v4(),
        tenant_id: tenant,
        role,
        patient_id: None,
        iss: "synthetic".into(),
        aud: "synthetic".into(),
        iat: 0,
        exp: i64::MAX,
    }
}

async fn fixture(name: &str) -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("{name}_{}", Uuid::new_v4().simple());
    let scoped = schema.clone();
    let admin = PgPool::connect(&url).await.unwrap();
    crate::test_db::create_schema(&admin, &schema).await;
    admin.close().await;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(6)
        .after_connect(move |c, _| {
            let query = format!("SET search_path TO {scoped}");
            Box::pin(async move {
                sqlx::query(&query).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    crate::MIGRATOR.run(&pool).await.unwrap();
    let tenant = Uuid::new_v4();
    let patient = Uuid::new_v4();
    let payer = Uuid::new_v4();
    let coverage = Uuid::new_v4();
    let actor = staff(tenant, crate::auth::Role::Owner);
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-ELIG','Synthetic','Patient','1980-01-01')").bind(tenant).bind(patient).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,$3,$2,'synthetic')").bind(tenant).bind(payer).bind(json!({"name":"Synthetic payer","payer_code":"SYN"})).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,$2,'synthetic')").bind(tenant).bind(coverage).bind(patient).bind(payer).bind(json!({"relationship":"self","member_id":"SYNTHETIC-MEMBER","status":"active"})).execute(&pool).await.unwrap();
    let state = State {
        backend: Arc::new(crate::postgres::PostgresBackend(pool.clone())),
        secret: "synthetic-eligibility-secret".into(),
        allow_legacy_gateway: false,
        issuer: "synthetic".into(),
        audience: "synthetic".into(),
        browser: Some(
            crate::browser::BrowserAuth::new(pool.clone(), "http://127.0.0.1:8099".into()).unwrap(),
        ),
    };
    let received: Received = Arc::new(Mutex::new(Vec::new()));
    let answer = Arc::new(Mutex::new(json!({})));
    let handler = |received: Received, answer: Arc<Mutex<Value>>| {
        axum::routing::post(
            move |axum::Form(fields): axum::Form<HashMap<String, String>>| {
                let received = received.clone();
                let answer = answer.clone();
                async move {
                    received.lock().unwrap().push(fields);
                    Json(answer.lock().unwrap().clone())
                }
            },
        )
    };
    let service = Router::new()
        .route(
            "/services/eligdata/",
            handler(received.clone(), answer.clone()),
        )
        .route(
            "/services/enroll/",
            handler(received.clone(), answer.clone()),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, service).await.unwrap() });
    let route = Route {
        key: "synthetic-eligibility".into(),
        tenant_id: tenant,
        partner_id: Uuid::new_v4(),
        endpoint: format!("http://{address}/services/upload/"),
        usage: "T".into(),
        credential_env: None,
        credential_value: None,
        loopback_test: true,
        adapter: Adapter::ClaimMd,
        retrieval: None,
        sftp: None,
    };
    Fixture {
        url,
        schema,
        pool,
        state,
        tenant,
        patient,
        payer,
        coverage,
        actor,
        route,
        received,
        answer,
        server,
    }
}

impl Fixture {
    fn answer(&self, value: Value) {
        *self.answer.lock().unwrap() = value;
    }
    fn sent(&self) -> usize {
        self.received.lock().unwrap().len()
    }
    fn last(&self) -> HashMap<String, String> {
        self.received.lock().unwrap().last().cloned().unwrap()
    }
    /// A sign-in with a provider profile. An empty NPI leaves the profile without one.
    async fn provider(&self, id: Uuid, name: &str, npi: &str) {
        sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role,display_name) VALUES($1,$2,$3,'synthetic','clinician',$4) ON CONFLICT DO NOTHING").bind(self.tenant).bind(id).bind(format!("{}@example.test", id.simple())).bind(name).execute(&self.pool).await.unwrap();
        sqlx::query(
            "INSERT INTO practice_providers(tenant_id,id,display_name,npi) VALUES($1,$2,$3,$4)",
        )
        .bind(self.tenant)
        .bind(id)
        .bind(name)
        .bind(npi)
        .execute(&self.pool)
        .await
        .unwrap();
    }
    async fn organization(&self, name: &str, tax: &str) -> Uuid {
        let id = Uuid::new_v4();
        let sealed = crate::provider_settings::seal_secret(
            &self.pool,
            self.tenant,
            id,
            "billing-organization-tax",
            tax,
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO practice_billing_organizations(tenant_id,id,name,tax_id_type,encrypted_tax_id,tax_id_last4,active) VALUES($1,$2,$3,'E',$4,$5,true)").bind(self.tenant).bind(id).bind(name).bind(sealed).bind(&tax[5..]).execute(&self.pool).await.unwrap();
        id
    }
    async fn coverage(&self, payer: Uuid, content: Value) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,$2,'synthetic')").bind(self.tenant).bind(id).bind(self.patient).bind(payer).bind(content).execute(&self.pool).await.unwrap();
        id
    }
    async fn one_click(&self, actor: &Actor, coverage: Uuid, input: Value) -> Result<Value> {
        let input: QuickRequest = serde_json::from_value(input).unwrap();
        quick_with_route(
            &self.state,
            actor,
            self.patient,
            coverage,
            input,
            Some(self.route.clone()),
        )
        .await
    }
    async fn checks(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM claimmd_eligibility_checks WHERE tenant_id=$1")
            .bind(self.tenant)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
    async fn close(self) {
        self.server.abort();
        self.pool.close().await;
        let admin = PgPool::connect(&self.url).await.unwrap();
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&admin)
            .await
            .unwrap();
        admin.close().await;
    }
}

fn kinds(reply: &Value) -> Vec<String> {
    assert_eq!(reply["outcome"], "needs", "{reply}");
    reply["needs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|need| need["kind"].as_str().unwrap().to_owned())
        .collect()
}

fn active_plan() -> Value {
    json!({"elig":[{"ins_name_f":"SYNTHETIC","ins_name_l":"PATIENT","ins_number":"SYNTHETIC-MEMBER","benefit":[{"benefit_code":"30","benefit_coverage_code":"1","benefit_coverage_description":"Active Coverage"}]}]})
}

#[tokio::test]
async fn loopback_rejection_is_retained_without_sensitive_text_or_duplicate_requests() {
    let f = fixture("eligibility_evidence").await;
    f.answer(json!({"error":[{"error_code":"42","error_message":"Synthetic patient-name 000000001 synthetic-loopback-key"}]}));
    let request = super::tests::request();
    let request_id = request.request_id;
    let replay: EligibilityRequest =
        serde_json::from_value(serde_json::to_value(&request).unwrap()).unwrap();
    let refused = run_with_route(
        &f.state,
        &f.actor,
        f.patient,
        f.coverage,
        request,
        Some(f.route.clone()),
    )
    .await
    .unwrap_err();
    let Error::Invalid(message) = refused else {
        panic!("a refused check is a plain staff message");
    };
    for technical in ["diagnostic", "HTTP", "structured"] {
        assert!(!message.contains(technical), "{message}");
    }
    let saved:Value=sqlx::query_scalar("SELECT jsonb_build_object('status',status,'request_snapshot',request_snapshot,'response_snapshot',response_snapshot) FROM claimmd_eligibility_checks WHERE tenant_id=$1 AND request_id=$2").bind(f.tenant).bind(request_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(saved["status"], "failed");
    assert_eq!(
        saved["response_snapshot"],
        json!({"failure":{"kind":"provider_rejected","http_status":200,"provider_codes":["42"],"provider_hints":["key","name","patient"]}})
    );
    assert_eq!(
        saved["request_snapshot"]["request"]["provider_taxid"],
        "*****0001"
    );
    assert!(!saved.to_string().contains("000000001"));
    assert!(!saved.to_string().contains("synthetic-loopback-key"));
    assert_eq!(
        f.last()["prov_taxid"],
        "000000001",
        "only the provider POST receives the full tax identity"
    );
    assert!(run_with_route(
        &f.state,
        &f.actor,
        f.patient,
        f.coverage,
        replay,
        Some(f.route.clone())
    )
    .await
    .is_err());
    assert_eq!(f.sent(), 1, "failed request replay never resends to payer");
    let events: Vec<String> = sqlx::query_scalar(
        "SELECT status FROM claimmd_eligibility_events WHERE tenant_id=$1 ORDER BY created_at,status",
    )
    .bind(f.tenant)
    .fetch_all(&f.pool)
    .await
    .unwrap();
    assert_eq!(events, vec!["pending", "failed"]);
    f.close().await;
}

#[tokio::test]
async fn one_click_builds_the_request_from_the_chart_and_asks_only_for_what_is_missing() {
    let _key_file = crate::test_db::credential_key_lock().lock().await;
    let key_dir = std::env::temp_dir().join(format!("suncharts-eligibility-{}", Uuid::new_v4()));
    std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", key_dir.join("master.key"));
    let f = fixture("eligibility_one_click").await;
    f.answer(active_plan());
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role,display_name) VALUES($1,$2,'owner@example.test','synthetic','owner','Synthetic Owner')").bind(f.tenant).bind(f.actor.sub).execute(&f.pool).await.unwrap();
    sqlx::query(
        "INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,$3)",
    )
    .bind(f.tenant)
    .bind(f.patient)
    .bind(json!({"administrative_gender":"female"}))
    .execute(&f.pool)
    .await
    .unwrap();
    let click = |extra: Value| {
        let mut body = json!({"request_id":Uuid::new_v4()});
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        body
    };

    // Nothing to send with: say exactly what the practice has to add, and send nothing.
    let reply = f
        .one_click(&f.actor, f.coverage, click(json!({})))
        .await
        .unwrap();
    assert_eq!(
        kinds(&reply),
        ["provider_npi", "billing_organization_missing"]
    );
    assert_eq!(reply["insurer"], "Synthetic payer");
    let no_npi = Uuid::new_v4();
    f.provider(no_npi, "Synthetic Unlisted", "").await;
    let reply = f
        .one_click(&f.actor, f.coverage, click(json!({})))
        .await
        .unwrap();
    assert_eq!(
        kinds(&reply),
        ["provider_npi", "billing_organization_missing"]
    );

    // One provider with an NPI and one billing organization: no question at all.
    f.provider(f.actor.sub, "Dr. Synthetic Owner, MD", "1234567893")
        .await;
    let first_org = f.organization("Synthetic Billing <One>", "000000017").await;
    let dated = click(json!({"service_date":"2026-11-05"}));
    let reply = f
        .one_click(&f.actor, f.coverage, dated.clone())
        .await
        .unwrap();
    assert_eq!(reply["outcome"], "checked", "{reply}");
    let check = &reply["check"];
    assert_eq!(check["status"], "completed");
    assert_eq!(check["actor_name"], "Synthetic Owner");
    assert_eq!(check["request_snapshot"]["automatic"], false);
    assert_eq!(
        check["request_snapshot"]["provider_name"],
        "Dr. Synthetic Owner, MD"
    );
    assert_eq!(
        check["request_snapshot"]["request"]["provider_taxid"],
        "*****0017"
    );
    assert!(!reply.to_string().contains("000000017"));
    let sent = f.last();
    for (field, value) in [
        ("ins_name_f", "Synthetic"),
        ("ins_name_l", "Patient"),
        ("ins_dob", "19800101"),
        ("ins_sex", "F"),
        ("pat_rel", "18"),
        ("payerid", "SYN"),
        ("ins_number", "SYNTHETIC-MEMBER"),
        ("fdos", "20261105"),
        ("service_code", "30"),
        ("prov_npi", "1234567893"),
        ("prov_taxid", "000000017"),
        ("prov_taxid_type", "E"),
    ] {
        assert_eq!(sent.get(field).map(String::as_str), Some(value), "{field}");
    }
    for field in [
        "pat_name_f",
        "pat_name_l",
        "pat_dob",
        "pat_sex",
        "proc_code",
    ] {
        assert!(!sent.contains_key(field), "{field}");
    }

    // The same click replayed returns the saved answer and never asks the insurer twice.
    let again = f
        .one_click(&f.actor, f.coverage, dated.clone())
        .await
        .unwrap();
    assert_eq!(again["check"]["id"], check["id"]);
    assert_eq!(f.sent(), 1);
    let mut reused = dated.clone();
    reused["service_date"] = json!("2026-11-06");
    assert!(matches!(
        f.one_click(&f.actor, f.coverage, reused).await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(f.sent(), 1);

    // Two billing organizations and no earlier choice would be a real question, but
    // the last check already used one, so it stays the practice's choice.
    let second_org = f.organization("Synthetic Billing Two", "000000028").await;
    let reply = f
        .one_click(
            &f.actor,
            f.coverage,
            click(json!({"service_date":"2026-11-06"})),
        )
        .await
        .unwrap();
    assert_eq!(reply["outcome"], "checked", "{reply}");
    assert_eq!(f.last()["prov_taxid"], "000000017");
    // When that organization is retired and two others remain, staff are asked once,
    // with the list and no tax IDs.
    sqlx::query(
        "UPDATE practice_billing_organizations SET active=false WHERE tenant_id=$1 AND id=$2",
    )
    .bind(f.tenant)
    .bind(first_org)
    .execute(&f.pool)
    .await
    .unwrap();
    let third_org = f.organization("Synthetic Billing Three", "000000039").await;
    let sent_before = f.sent();
    let reply = f
        .one_click(&f.actor, f.coverage, click(json!({})))
        .await
        .unwrap();
    assert_eq!(kinds(&reply), ["billing_organization"]);
    let choices = reply["needs"][0]["choices"].as_array().unwrap();
    assert_eq!(choices.len(), 2);
    assert_eq!(choices[0]["name"], "Synthetic Billing Three");
    assert_eq!(choices[0]["tax_id_last4"], "0039");
    assert_eq!(choices[1]["id"], json!(second_org));
    assert!(!reply.to_string().contains("000000039") && !reply.to_string().contains("000000028"));
    assert_eq!(
        f.sent(),
        sent_before,
        "a question is never sent to the insurer"
    );
    // The answer is used, and remembered for the next click.
    let reply = f
        .one_click(
            &f.actor,
            f.coverage,
            click(json!({"billing_organization_id":second_org})),
        )
        .await
        .unwrap();
    assert_eq!(reply["outcome"], "checked", "{reply}");
    assert_eq!(f.last()["prov_taxid"], "000000028");
    let reply = f
        .one_click(&f.actor, f.coverage, click(json!({})))
        .await
        .unwrap();
    assert_eq!(reply["outcome"], "checked", "{reply}");
    assert_eq!(f.last()["prov_taxid"], "000000028");
    for gone in [first_org, Uuid::new_v4()] {
        assert!(matches!(
            f.one_click(
                &f.actor,
                f.coverage,
                click(json!({"billing_organization_id":gone}))
            )
            .await,
            Err(Error::Invalid(_))
        ));
    }
    let _ = third_org;

    // Provider: the appointment's clinician, then the practice's booking clinician.
    let clinician = Uuid::new_v4();
    let booking = Uuid::new_v4();
    f.provider(clinician, "Synthetic Clinician", "1245319599")
        .await;
    f.provider(booking, "Synthetic Booking", "1111111112").await;
    sqlx::query("INSERT INTO previsit_booking_profiles(tenant_id,public_slug,enabled,default_clinician_id,duration_minutes,booking_horizon_days,booking_timezone,available_weekdays,day_start,day_end,slot_minutes,updated_by) VALUES($1,$2,true,$3,30,30,'America/Chicago',ARRAY[1,2,3,4,5]::smallint[],'08:00','17:00',15,$3)").bind(f.tenant).bind(format!("synthetic-{}", f.tenant.simple())).bind(booking).execute(&f.pool).await.unwrap();
    let appointment = Uuid::new_v4();
    // 03:00 UTC is still the evening before in the practice's time zone.
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at) VALUES($1,$2,$3,$4,'2026-11-20T03:00:00Z','2026-11-20T03:30:00Z')").bind(f.tenant).bind(appointment).bind(f.patient).bind(clinician).execute(&f.pool).await.unwrap();
    let reply = f
        .one_click(
            &f.actor,
            f.coverage,
            click(json!({"appointment_id":appointment})),
        )
        .await
        .unwrap();
    assert_eq!(reply["outcome"], "checked", "{reply}");
    assert_eq!(f.last()["prov_npi"], "1245319599");
    assert_eq!(f.last()["fdos"], "20261119");
    assert_eq!(
        reply["check"]["request_snapshot"]["appointment_id"],
        json!(appointment)
    );
    let visit = Uuid::new_v4();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id) VALUES($1,$2,$3,$4,$5)").bind(f.tenant).bind(visit).bind(f.patient).bind(appointment).bind(clinician).execute(&f.pool).await.unwrap();
    let reply = f
        .one_click(&f.actor, f.coverage, click(json!({"visit_id":visit})))
        .await
        .unwrap();
    assert_eq!(reply["outcome"], "checked", "{reply}");
    assert_eq!(f.last()["prov_npi"], "1245319599");
    assert_eq!(f.last()["fdos"], "20261119");
    let reply = f
        .one_click(
            &f.actor,
            f.coverage,
            click(json!({"service_date":"2026-11-07"})),
        )
        .await
        .unwrap();
    assert_eq!(reply["outcome"], "checked", "{reply}");
    assert_eq!(
        f.last()["prov_npi"],
        "1111111112",
        "no visit: the booking clinician"
    );
    let reply = f
        .one_click(
            &f.actor,
            f.coverage,
            click(json!({"provider_id":f.actor.sub})),
        )
        .await
        .unwrap();
    assert_eq!(
        f.last()["prov_npi"],
        "1234567893",
        "an explicit answer wins"
    );
    let today: String = sqlx::query_scalar(
        "SELECT to_char((now() AT TIME ZONE 'America/Chicago')::date,'YYYYMMDD')",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        f.last()["fdos"],
        today,
        "no visit and no date: today at the practice"
    );
    assert_eq!(reply["outcome"], "checked");
    assert!(matches!(
        f.one_click(
            &f.actor,
            f.coverage,
            click(json!({"appointment_id":Uuid::new_v4()}))
        )
        .await,
        Err(Error::NotFound)
    ));

    // Someone else holds the policy: the subscriber comes from the coverage and the
    // patient is sent as the dependent.
    let dependent = f.coverage(f.payer, json!({"relationship":"child","member_id":"SYNTHETIC-FAMILY","status":"active","subscriber_name":"Parent"})).await;
    let sent_before = f.sent();
    let reply = f
        .one_click(&f.actor, dependent, click(json!({})))
        .await
        .unwrap();
    assert_eq!(kinds(&reply), ["subscriber_name", "subscriber_birth_date"]);
    sqlx::query("UPDATE insurance_coverages SET content=content||$3 WHERE tenant_id=$1 AND id=$2")
        .bind(f.tenant)
        .bind(dependent)
        .bind(json!({"subscriber_name":"Parent Q Synthetic Jr."}))
        .execute(&f.pool)
        .await
        .unwrap();
    let reply = f
        .one_click(&f.actor, dependent, click(json!({})))
        .await
        .unwrap();
    assert_eq!(kinds(&reply), ["subscriber_birth_date"]);
    assert_eq!(f.sent(), sent_before);
    sqlx::query("UPDATE insurance_coverages SET content=content||$3 WHERE tenant_id=$1 AND id=$2")
        .bind(f.tenant)
        .bind(dependent)
        .bind(json!({"subscriber_birth_date":"1955-02-03"}))
        .execute(&f.pool)
        .await
        .unwrap();
    let reply = f
        .one_click(
            &f.actor,
            dependent,
            click(json!({"service_date":"2026-11-05"})),
        )
        .await
        .unwrap();
    assert_eq!(reply["outcome"], "checked", "{reply}");
    let sent = f.last();
    for (field, value) in [
        ("ins_name_f", "Parent"),
        ("ins_name_m", "Q"),
        ("ins_name_l", "Synthetic"),
        ("ins_dob", "19550203"),
        ("pat_rel", "G8"),
        ("pat_name_f", "Synthetic"),
        ("pat_name_l", "Patient"),
        ("pat_dob", "19800101"),
        ("pat_sex", "F"),
        ("ins_number", "SYNTHETIC-FAMILY"),
    ] {
        assert_eq!(sent.get(field).map(String::as_str), Some(value), "{field}");
    }
    assert!(
        !sent.contains_key("ins_sex"),
        "the subscriber's sex is not on file"
    );

    // An insurer without a payer ID, and a coverage that is not active.
    let unlisted = Uuid::new_v4();
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,$3,$2,'synthetic')").bind(f.tenant).bind(unlisted).bind(json!({"name":"Synthetic unlisted payer","payer_code":""})).execute(&f.pool).await.unwrap();
    let no_code = f
        .coverage(
            unlisted,
            json!({"relationship":"self","member_id":"SYNTHETIC-OTHER","status":"active"}),
        )
        .await;
    let reply = f
        .one_click(&f.actor, no_code, click(json!({})))
        .await
        .unwrap();
    assert_eq!(kinds(&reply), ["payer_id"]);
    assert_eq!(reply["needs"][0]["payer_id"], json!(unlisted));
    assert_eq!(reply["insurer"], "Synthetic unlisted payer");
    let inactive = f
        .coverage(
            f.payer,
            json!({"relationship":"self","member_id":"SYNTHETIC-OLD","status":"inactive"}),
        )
        .await;
    assert!(matches!(
        f.one_click(&f.actor, inactive, click(json!({}))).await,
        Err(Error::Invalid(_))
    ));

    // Same permission as the full request: scheduling staff only, own tenant only.
    for role in [
        crate::auth::Role::Nurse,
        crate::auth::Role::ReadOnly,
        crate::auth::Role::Patient,
    ] {
        assert!(matches!(
            f.one_click(&staff(f.tenant, role), f.coverage, click(json!({})))
                .await,
            Err(Error::Forbidden)
        ));
    }
    assert!(matches!(
        f.one_click(
            &staff(Uuid::new_v4(), crate::auth::Role::Owner),
            f.coverage,
            click(json!({}))
        )
        .await,
        Err(Error::NotFound)
    ));
    let front_desk = staff(f.tenant, crate::auth::Role::FrontDesk);
    let reply = f
        .one_click(&front_desk, f.coverage, click(json!({})))
        .await
        .unwrap();
    assert_eq!(reply["outcome"], "checked");
    assert_eq!(
        reply["check"]["actor_name"],
        Value::Null,
        "an unknown sign-in has no name to show"
    );

    // Without being asked: only when a fresh answer is worth another request.
    let sent_before = f.sent();
    let automatic =
        |coverage: Uuid| f.one_click(&f.actor, coverage, click(json!({"automatic":true})));
    let reply = automatic(inactive).await.unwrap();
    assert_eq!(
        reply,
        json!({"outcome":"skipped","reason":"coverage_not_active"})
    );
    let reply = automatic(no_code).await.unwrap();
    assert_eq!(reply["reason"], "no_payer_id");
    let reply = automatic(f.coverage).await.unwrap();
    assert_eq!(
        reply["reason"], "recent_check",
        "today's answer is still good"
    );
    assert_eq!(f.sent(), sent_before);
    let fresh = f.coverage(f.payer, json!({"relationship":"self","member_id":"SYNTHETIC-FRESH","status":"active","priority":"secondary"})).await;
    let reply = automatic(fresh).await.unwrap();
    assert_eq!(reply["outcome"], "checked", "{reply}");
    assert_eq!(reply["check"]["request_snapshot"]["automatic"], true);
    assert_eq!(f.sent(), sent_before + 1);
    let stale = f
        .coverage(
            f.payer,
            json!({"relationship":"self","member_id":"SYNTHETIC-STALE","status":"active","priority":"secondary"}),
        )
        .await;
    f.one_click(&f.actor, stale, click(json!({"service_date":"2026-01-05"})))
        .await
        .unwrap();
    let reply = automatic(stale).await.unwrap();
    assert_eq!(
        reply["outcome"], "checked",
        "an answer for a visit months ago is checked again"
    );

    // A refusal is saved as a failed check and returned to show in place. What
    // Claim.MD wrote is never kept, and it is not retried behind anyone's back.
    f.answer(json!({"error":[{"error_code":"31","error_message":"Provider 1234567893 is not enrolled for eligibility with Synthetic payer SYNTHETIC-FRESH"}]}));
    let refused = f.coverage(f.payer, json!({"relationship":"self","member_id":"SYNTHETIC-REFUSED","status":"active","priority":"tertiary"})).await;
    let body = click(json!({}));
    let checks_before = f.checks().await;
    let reply = f.one_click(&f.actor, refused, body.clone()).await.unwrap();
    assert_eq!(reply["outcome"], "checked", "{reply}");
    assert_eq!(reply["check"]["status"], "failed");
    assert_eq!(
        reply["check"]["response_snapshot"],
        json!({"failure":{"kind":"provider_rejected","http_status":200,"provider_codes":["31"],"provider_hints":["eligibility","enroll","payer","provider"]}})
    );
    assert_eq!(f.checks().await, checks_before + 1);
    let stored: String = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(c))::text FROM claimmd_eligibility_checks c WHERE tenant_id=$1",
    )
    .bind(f.tenant)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    for text in [
        "not enrolled",
        "SYNTHETIC-FRESH\"}]",
        "000000017",
        "000000028",
        "synthetic-loopback-key",
    ] {
        assert!(!stored.contains(text), "{text}");
    }
    let sent_before = f.sent();
    let replay = f.one_click(&f.actor, refused, body).await.unwrap();
    assert_eq!(replay["check"]["id"], reply["check"]["id"]);
    assert_eq!(
        automatic(refused).await.unwrap()["reason"],
        "recent_failure"
    );
    assert_eq!(f.sent(), sent_before);

    // The owner can start Claim.MD's eligibility setup from that failed check. The
    // tax ID is resolved on the server and masked in what is kept.
    let failed_check: Uuid = serde_json::from_value(reply["check"]["id"].clone()).unwrap();
    let partner = Uuid::new_v4();
    let setting = Uuid::new_v4();
    sqlx::query("INSERT INTO edi_partners(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,'{}',$3,'synthetic')").bind(f.tenant).bind(partner).bind(Uuid::new_v4()).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO edi_provider_settings(tenant_id,id,partner_id,provider,usage,label,encrypted_key,credential_fingerprint,start_at) VALUES($1,$2,$3,'claim_md','T','Synthetic',$4,$5,now())").bind(f.tenant).bind(setting).bind(partner).bind(vec![0u8; 16]).bind(setting.to_string()).execute(&f.pool).await.unwrap();
    let enroll = |actor: Actor| {
        let input = serde_json::from_value(json!({"check_id":failed_check})).unwrap();
        let (state, route) = (f.state.clone(), f.route.clone());
        async move {
            enrollment_with_route(&state, &actor, f.patient, refused, input, setting, route).await
        }
    };
    assert!(matches!(
        enroll(front_desk.clone()).await,
        Err(Error::Forbidden)
    ));
    f.answer(json!({"link":{"url":"https://www.claim.md/enroll/synthetic/"}}));
    let started = enroll(f.actor.clone()).await.unwrap();
    assert_eq!(started["status"], "started");
    assert_eq!(
        started["external_url"],
        "https://www.claim.md/enroll/synthetic/"
    );
    let sent = f.last();
    for (field, value) in [
        ("enroll_type", "elig"),
        ("payerid", "SYN"),
        ("prov_taxid", "000000028"),
        ("prov_npi", "1111111112"),
        ("prov_name_l", "Booking"),
        ("prov_name_f", "Synthetic"),
    ] {
        assert_eq!(sent.get(field).map(String::as_str), Some(value), "{field}");
    }
    let operation: Value =
        sqlx::query_scalar("SELECT request FROM claimmd_operations WHERE tenant_id=$1")
            .bind(f.tenant)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(operation["prov_taxid"], "*****0028");
    assert_eq!(operation["enroll_type"], "elig");
    f.answer(json!({"error":[{"error_message":"Provider is already enrolled 000000028"}]}));
    let refusal = enroll(f.actor.clone()).await.unwrap();
    assert_eq!(refusal["status"], "refused");
    assert_eq!(
        refusal["failure"]["provider_hints"],
        json!(["already", "enroll", "provider"])
    );
    assert!(!refusal.to_string().contains("000000028"));
    f.answer(json!({"result":{"status":"ok"}}));
    assert_eq!(
        enroll(f.actor.clone()).await.unwrap(),
        json!({"status":"no_link"})
    );

    std::env::remove_var("ENGINE_CREDENTIAL_KEY_FILE");
    let _ = std::fs::remove_dir_all(key_dir);
    f.close().await;
}

#[test]
fn subscriber_names_split_the_way_they_are_written_on_the_card() {
    use super::quick::subscriber_parts;
    let parts = |name| {
        subscriber_parts(name)
            .map(|(given, middle, family)| (given, middle.unwrap_or_default(), family))
    };
    let name = |given: &str, middle: &str, family: &str| {
        Some((given.to_owned(), middle.to_owned(), family.to_owned()))
    };
    assert_eq!(parts("Parent Synthetic"), name("Parent", "", "Synthetic"));
    assert_eq!(
        parts("  Parent   Q  Synthetic "),
        name("Parent", "Q", "Synthetic")
    );
    assert_eq!(
        parts("Synthetic, Parent Q"),
        name("Parent", "Q", "Synthetic")
    );
    assert_eq!(
        parts("Parent Synthetic Jr."),
        name("Parent", "", "Synthetic")
    );
    assert_eq!(
        parts("Parent Q Synthetic III"),
        name("Parent", "Q", "Synthetic")
    );
    for unclear in ["", "   ", "Parent", "Synthetic,", ", Parent"] {
        assert_eq!(parts(unclear), None, "{unclear:?}");
    }
}
