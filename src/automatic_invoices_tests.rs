// SPDX-License-Identifier: AGPL-3.0-only
use super::*;
use async_trait::async_trait;
use sqlx::postgres::PgPoolOptions;
use std::{collections::HashMap, sync::Mutex};

const POLICY: Policy = Policy {
    production: false,
    live_enabled: false,
};

#[derive(Default)]
struct Calls {
    records: HashMap<Uuid, Value>,
    issued: Vec<(Uuid, i64)>,
    closed: Vec<String>,
    defer_create_once: bool,
    incomplete_creation: Option<Uuid>,
    lose_create_reply: bool,
    mismatched_evidence: bool,
    change_before_create_returns: Option<(Actor, Uuid, i64)>,
}

struct InvoiceBroker {
    installation: Uuid,
    calls: Mutex<Calls>,
}

#[async_trait]
impl Broker for InvoiceBroker {
    async fn installation(&self, _: &PgPool, _: Uuid, _: Uuid, _: i64) -> Result<Uuid> {
        Ok(self.installation)
    }
    async fn call(
        &self,
        db: &PgPool,
        binding: &Binding,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        assert_eq!(binding.installation, self.installation);
        if path == "/status" {
            return Ok(json!({
                "installation_id":self.installation,"remote_tenant_id":binding.tenant,
                "account_id":"acct_synthetic","livemode":false,"checkout_contract_version":1,
                "hosted_checkout_enabled":true,"charges_enabled":true,"card_payments_active":true,
                "details_submitted":true
            }));
        }
        let path = url::Url::parse(&format!("https://synthetic.test{path}")).unwrap();
        let parts: Vec<_> = path.path_segments().unwrap().collect();
        assert_eq!(parts[0], "patient-billing");
        let patient = Uuid::parse_str(parts[1]).unwrap();
        assert_eq!(parts[2], "invoices");
        if method == Method::POST && parts.len() == 3 {
            let change = self
                .calls
                .lock()
                .unwrap()
                .change_before_create_returns
                .take();
            if let Some((actor, account, credit)) = change {
                entry(db, &actor, account, "adjustment_credit", credit).await;
                revision(db, &actor, patient, account).await;
            }
        }
        let mut calls = self.calls.lock().unwrap();
        if method == Method::GET {
            let request = Uuid::parse_str(parts[3]).unwrap();
            let query: HashMap<_, _> = path.query_pairs().collect();
            assert_eq!(query["account_id"], "acct_synthetic");
            assert_eq!(query["livemode"], "false");
            assert_eq!(query["remote_tenant_id"], binding.tenant.to_string());
            if calls.incomplete_creation == Some(request) {
                return Err(Error::Conflict("invoice_creation_incomplete"));
            }
            let mut found = calls
                .records
                .get(&request)
                .cloned()
                .ok_or(Error::NotFound)?;
            if calls.mismatched_evidence {
                found["native_account_id"] = json!(Uuid::new_v4());
            }
            return Ok(found);
        }
        let body = body.unwrap();
        assert_eq!(body["account_id"], "acct_synthetic");
        assert_eq!(body["remote_tenant_id"], binding.tenant.to_string());
        assert_eq!(body["livemode"], false);
        if parts.len() == 3 {
            assert_eq!(body["currency"], "usd");
            assert_eq!(body.as_object().unwrap().len(), 8);
            let request: Uuid = serde_json::from_value(body["request_id"].clone()).unwrap();
            let amount = body["amount_cents"].as_i64().unwrap();
            if std::mem::take(&mut calls.defer_create_once) {
                calls.incomplete_creation = Some(request);
                return Err(Error::Invalid("synthetic draft creation interrupted"));
            }
            if let Some(original) = calls.incomplete_creation.take() {
                assert_eq!(request, original);
            }
            let record = json!({
                "installation_id":self.installation,"remote_tenant_id":binding.tenant,
                "external_patient_ref":patient,"stripe_account_id":"acct_synthetic","livemode":false,
                "request_id":request,"native_account_id":body["native_account_id"],
                "native_invoice_id":body["native_invoice_id"],"stripe_invoice_id":format!("in_{}",request.simple()),
                "status":"draft","amount_due":amount,"amount_paid":0,"amount_remaining":amount,"currency":"usd"
            });
            assert!(calls.records.insert(request, record.clone()).is_none());
            calls.issued.push((patient, amount));
            return if std::mem::take(&mut calls.lose_create_reply) {
                Err(Error::Invalid("synthetic reply lost"))
            } else {
                Ok(record)
            };
        }
        assert_eq!(parts[4], "close");
        let request = Uuid::parse_str(parts[3]).unwrap();
        let action = body["action"].as_str().unwrap().to_owned();
        let record = calls.records.get_mut(&request).unwrap();
        record["status"] = json!(action);
        record["amount_remaining"] = json!(0);
        if action == "paid" {
            record["amount_paid"] = record["amount_due"].clone();
        } else {
            record["amount_due"] = json!(0);
        }
        let record = record.clone();
        calls.closed.push(action);
        Ok(record)
    }

    async fn reply(
        &self,
        db: &PgPool,
        binding: &Binding,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<connect::Reply> {
        let (status, body) = match self.call(db, binding, method, path, body).await {
            Ok(body) => (200, body),
            Err(Error::NotFound) => (404, Value::Null),
            Err(Error::Conflict("invoice_creation_incomplete")) => {
                (409, json!({"error":"invoice_creation_incomplete"}))
            }
            Err(error) => return Err(error),
        };
        Ok(connect::Reply { status, body })
    }
}

async fn fixture(tenant: Uuid) -> (PgPool, Actor) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable database required");
    let root = PgPool::connect(&url).await.unwrap();
    let schema = format!("automatic_invoice_test_{}", Uuid::new_v4().simple());
    crate::test_db::create_schema(&root, &schema).await;
    root.close().await;
    let db = PgPoolOptions::new()
        .after_connect(move |c, _| {
            let command = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(&command).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    crate::MIGRATOR.run(&db).await.unwrap();
    sqlx::query(
        "INSERT INTO payment_settings(tenant_id,id,mode) VALUES($1,$2,'suncharts_connect')",
    )
    .bind(tenant)
    .bind(Uuid::new_v4())
    .execute(&db)
    .await
    .unwrap();
    (db, crate::delivery::worker(tenant))
}

async fn account(db: &PgPool, a: &Actor, patient: Uuid, total: i64, insured: bool) -> Uuid {
    sqlx::query(
        "INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date)
         VALUES($1,$2,$3,'Avery','Synthetic','1990-01-01')",
    )
    .bind(a.tenant_id)
    .bind(patient)
    .bind(format!("SYN-{}", patient.simple()))
    .execute(db)
    .await
    .unwrap();
    let id = Uuid::new_v4();
    let appointment = Uuid::new_v4();
    let visit = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status)
        VALUES($1,$2,$3,$4,'2026-10-23T14:00:00Z','2026-10-23T14:30:00Z','completed')",
    )
    .bind(a.tenant_id)
    .bind(appointment)
    .bind(patient)
    .bind(a.sub)
    .execute(db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,signed_by,signed_at)
        VALUES($1,$2,$3,$4,$5,'signed','{}',$5,now())")
        .bind(a.tenant_id).bind(visit).bind(patient).bind(appointment).bind(a.sub)
        .execute(db).await.unwrap();
    let lines = json!([{"code_system":"CPT","code":"99213","description":"Synthetic service",
        "modifiers":"","units":1,"amount_cents":total}]);
    let coverage = insured.then(|| {
        json!({"coverage":{"content":{"priority":"primary","copay_cents":2000}},
            "payer":{"content":{"name":"Synthetic insurer","payer_code":"SYNTH"}}})
    });
    sqlx::query("INSERT INTO billing_accounts(tenant_id,id,patient_id,visit_id,content,total_cents,request_id,creation_hash,status,coverage_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic','posted',$8)")
        .bind(a.tenant_id).bind(id).bind(patient)
        .bind(visit).bind(json!({"visit_id":visit,"service_date":"2026-10-23","lines":lines}))
        .bind(total).bind(Uuid::new_v4()).bind(coverage)
        .execute(db).await.unwrap();
    id
}

async fn revision(db: &PgPool, a: &Actor, patient: Uuid, account: Uuid) {
    let mut tx = db.begin().await.unwrap();
    sqlx::query("UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(account)
        .execute(&mut *tx)
        .await
        .unwrap();
    billing::account_revision(&mut tx, a, patient, account, "Synthetic change")
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

async fn entry(db: &PgPool, a: &Actor, account: Uuid, kind: &str, cents: i64) {
    sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id)
        VALUES($1,$2,$3,$4,$5,$6,$2,'synthetic',$7)")
        .bind(a.tenant_id).bind(Uuid::new_v4()).bind(account).bind(kind).bind(-cents)
        .bind(json!({"party":"patient","method":"cash","reason":"Synthetic"}))
        .bind(a.sub).execute(db).await.unwrap();
}

async fn adjudicate(db: &PgPool, a: &Actor, patient: Uuid, account: Uuid) {
    let (payer, claim, remit) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let mut tx = db.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash)
        VALUES($1,$2,'{}',$2,'synthetic')",
    )
    .bind(a.tenant_id)
    .bind(payer)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("INSERT INTO ehr_claims(tenant_id,id,patient_id,account_id,payer_id,control_number,frequency,content,snapshot,status,request_id,creation_hash)
        SELECT $1,$2,$3,$4,$5,'SYNTHETIC','original','{}',jsonb_build_object('account',to_jsonb(b)),'adjudicated',$2,'synthetic'
        FROM billing_accounts b WHERE tenant_id=$1 AND id=$4")
        .bind(a.tenant_id).bind(claim).bind(patient).bind(account).bind(payer).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO era_remittances(tenant_id,id,payer_id,trace,document,document_hash,status,request_id,creation_hash)
        VALUES($1,$2,$3,'SYNTHETIC',$4,'synthetic','posted',$2,'synthetic')")
        .bind(a.tenant_id).bind(remit).bind(payer)
        .bind(json!({"payment_date":"2026-10-23","claims":[{"status":"1","paid_cents":15000,"patient_responsibility_cents":5000}]}))
        .execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO era_postings(tenant_id,remittance_id,row_index,claim_id,account_id,claim_status_before,claim_control_before,posted_claim_version,patient_responsibility_cents,writeoff_cents)
        VALUES($1,$2,0,$3,$4,'submitted','',1,5000,0)")
        .bind(a.tenant_id).bind(remit).bind(claim).bind(account).execute(&mut *tx).await.unwrap();
    sqlx::query(
        "INSERT INTO era_claim_heads(tenant_id,claim_id,remittance_id,row_index,claim_version)
        VALUES($1,$2,$3,0,1)",
    )
    .bind(a.tenant_id)
    .bind(claim)
    .bind(remit)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    revision(db, a, patient, account).await;
}

async fn tick(db: &PgPool, broker: &dyn Broker) {
    sqlx::query("UPDATE automatic_patient_invoice_jobs SET next_attempt_at=now()")
        .execute(db)
        .await
        .unwrap();
    poll(db, broker, POLICY).await.unwrap();
}

async fn summary(db: &PgPool, actor: &Actor, patient: Uuid, account: Uuid) -> Value {
    let mut tx = db.begin().await.unwrap();
    let summary = visit_billing::summarize(
        &mut tx,
        actor,
        patient,
        None,
        Some(account),
        Options {
            claims: true,
            history: true,
            ..Options::default()
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    summary
}

#[tokio::test]
async fn automatic_invoices_use_net_responsibility_and_close_after_verified_payment() {
    let (db, a) = fixture(Uuid::new_v4()).await;
    let broker = InvoiceBroker {
        installation: Uuid::new_v4(),
        calls: Mutex::new(Calls::default()),
    };
    let cash = Uuid::new_v4();
    let cash_account = account(&db, &a, cash, 12000, false).await;
    entry(&db, &a, cash_account, "adjustment_credit", 2000).await;
    revision(&db, &a, cash, cash_account).await;
    let insured = Uuid::new_v4();
    let insured_account = account(&db, &a, insured, 20000, true).await;
    entry(&db, &a, insured_account, "payment", 2000).await;
    revision(&db, &a, insured, insured_account).await;
    {
        let mut calls = broker.calls.lock().unwrap();
        calls.defer_create_once = true;
        calls.lose_create_reply = true;
    }
    tick(&db, &broker).await;
    assert!(broker.calls.lock().unwrap().issued.is_empty());
    tick(&db, &broker).await;
    assert_eq!(broker.calls.lock().unwrap().issued, vec![(cash, 10000)]);
    tick(&db, &broker).await;
    assert_eq!(broker.calls.lock().unwrap().issued, vec![(cash, 10000)]);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ehr_claims WHERE tenant_id=$1 AND account_id=$2")
            .bind(a.tenant_id)
            .bind(cash_account)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 0);
    adjudicate(&db, &a, insured, insured_account).await;
    tick(&db, &broker).await;
    tick(&db, &broker).await;
    assert_eq!(
        broker.calls.lock().unwrap().issued,
        vec![(cash, 10000), (insured, 3000)]
    );

    entry(&db, &a, cash_account, "payment", 10000).await;
    revision(&db, &a, cash, cash_account).await;
    broker.calls.lock().unwrap().mismatched_evidence = true;
    tick(&db, &broker).await;
    assert!(broker.calls.lock().unwrap().closed.is_empty());
    assert!(summary(&db, &a, cash, cash_account).await["automatic_invoice"].is_null());
    for _ in 1..REVIEW_AFTER_FAILURES {
        tick(&db, &broker).await;
    }
    let review = summary(&db, &a, cash, cash_account).await;
    assert_eq!(review["patient"]["owes_now_cents"], 0);
    assert_eq!(
        review["automatic_invoice"],
        json!({"status":"needs_review"})
    );
    broker.calls.lock().unwrap().mismatched_evidence = false;
    tick(&db, &broker).await;
    assert_eq!(broker.calls.lock().unwrap().closed, vec!["paid"]);
    assert_eq!(
        summary(&db, &a, cash, cash_account).await["automatic_invoice"]["status"],
        "paid"
    );

    entry(&db, &a, insured_account, "adjustment_credit", 1000).await;
    revision(&db, &a, insured, insured_account).await;
    tick(&db, &broker).await;
    tick(&db, &broker).await;
    let calls = broker.calls.lock().unwrap();
    assert_eq!(calls.closed, vec!["paid", "void"]);
    assert_eq!(
        calls.issued,
        vec![(cash, 10000), (insured, 3000), (insured, 2000)]
    );
}

#[tokio::test]
async fn automatic_invoice_obsoleted_during_creation_is_never_current() {
    let (db, a) = fixture(Uuid::new_v4()).await;
    let broker = InvoiceBroker {
        installation: Uuid::new_v4(),
        calls: Mutex::new(Calls::default()),
    };
    let patient = Uuid::new_v4();
    let account = account(&db, &a, patient, 12000, false).await;
    revision(&db, &a, patient, account).await;
    broker.calls.lock().unwrap().change_before_create_returns = Some((a.clone(), account, 2000));

    tick(&db, &broker).await;
    assert_eq!(broker.calls.lock().unwrap().issued, vec![(patient, 12000)]);
    assert_eq!(broker.calls.lock().unwrap().closed, vec!["void"]);
    let summary = summary(&db, &a, patient, account).await;
    assert_eq!(summary["patient"]["owes_now_cents"], 10000);
    assert!(summary["automatic_invoice"].is_null());

    tick(&db, &broker).await;
    assert_eq!(
        broker.calls.lock().unwrap().issued,
        vec![(patient, 12000), (patient, 10000)]
    );
}

// Optional acceptance test for a local Connect process backed by its synthetic provider.
// The production broker and its origin checks are unchanged.
struct LocalHttpBroker {
    origin: String,
    token: String,
    installation: Uuid,
}

#[async_trait]
impl Broker for LocalHttpBroker {
    async fn installation(&self, _: &PgPool, _: Uuid, _: Uuid, _: i64) -> Result<Uuid> {
        Ok(self.installation)
    }
    async fn call(
        &self,
        db: &PgPool,
        binding: &Binding,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        self.reply(db, binding, method, path, body)
            .await?
            .confirmed()
    }
    async fn reply(
        &self,
        _: &PgPool,
        binding: &Binding,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<connect::Reply> {
        connect::HttpBroker::request(
            &self.origin,
            binding.installation,
            &self.token,
            method,
            path,
            body,
        )
        .await
    }
}

#[tokio::test]
#[ignore = "requires a local synthetic Connect broker"]
async fn automatic_invoice_through_local_connect_fixture() {
    let path = std::env::var_os("SUNCHARTS_LOCAL_BROKER_FIXTURE")
        .expect("local synthetic Connect broker handoff file required");
    let fixture_json: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let origin = url::Url::parse(fixture_json["base_url"].as_str().unwrap()).unwrap();
    assert_eq!(origin.scheme(), "http");
    assert_eq!(origin.host_str(), Some("127.0.0.1"));
    assert_eq!(
        origin.as_str(),
        format!("http://127.0.0.1:{}/", origin.port().unwrap())
    );
    let id = |name: &str| Uuid::parse_str(fixture_json[name].as_str().unwrap()).unwrap();
    assert_eq!(fixture_json["livemode"], false);
    assert_eq!(fixture_json["account_id"], "acct_synthetic");
    let broker = LocalHttpBroker {
        origin: origin.origin().ascii_serialization(),
        token: fixture_json["token"].as_str().unwrap().to_owned(),
        installation: id("installation_id"),
    };
    let (db, a) = fixture(id("remote_tenant_id")).await;
    let cash = Uuid::new_v4();
    let cash_account = account(&db, &a, cash, 12000, false).await;
    entry(&db, &a, cash_account, "adjustment_credit", 2000).await;
    revision(&db, &a, cash, cash_account).await;
    let insured = Uuid::new_v4();
    let insured_account = account(&db, &a, insured, 20000, true).await;
    entry(&db, &a, insured_account, "payment", 2000).await;
    revision(&db, &a, insured, insured_account).await;
    tick(&db, &broker).await;
    let outstanding: Vec<(Uuid, String, i64)> = sqlx::query_as(
        "SELECT patient_id,status,amount_cents FROM automatic_patient_invoice_operations
         WHERE tenant_id=$1 ORDER BY amount_cents DESC",
    )
    .bind(a.tenant_id)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(outstanding, vec![(cash, "draft".into(), 10000)]);
    adjudicate(&db, &a, insured, insured_account).await;
    tick(&db, &broker).await;
    tick(&db, &broker).await;
    let outstanding: Vec<(Uuid, String, i64)> = sqlx::query_as(
        "SELECT patient_id,status,amount_cents FROM automatic_patient_invoice_operations
         WHERE tenant_id=$1 ORDER BY amount_cents DESC",
    )
    .bind(a.tenant_id)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(
        outstanding,
        vec![
            (cash, "draft".into(), 10000),
            (insured, "draft".into(), 3000)
        ]
    );
    entry(&db, &a, cash_account, "payment", 10000).await;
    revision(&db, &a, cash, cash_account).await;
    entry(&db, &a, insured_account, "adjustment_credit", 1000).await;
    revision(&db, &a, insured, insured_account).await;
    tick(&db, &broker).await;
    tick(&db, &broker).await;
    let states: Vec<(Uuid, String, i64)> = sqlx::query_as(
        "SELECT patient_id,status,amount_cents FROM automatic_patient_invoice_operations
         WHERE tenant_id=$1 ORDER BY amount_cents DESC",
    )
    .bind(a.tenant_id)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(
        states,
        vec![
            (cash, "paid".into(), 10000),
            (insured, "void".into(), 3000),
            (insured, "draft".into(), 2000)
        ]
    );
}
