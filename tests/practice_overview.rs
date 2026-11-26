// SPDX-License-Identifier: AGPL-3.0-only
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::Arc;
use suncharts_engine::{browser::BrowserAuth, postgres::PostgresBackend, State};
use tower::ServiceExt;
use uuid::Uuid;
const ORIGIN: &str = "http://127.0.0.1:8099";
#[allow(dead_code)]
struct Fixture {
    db: PgPool,
    app: Router,
    tenant: Uuid,
    owner: Uuid,
    cookie: String,
    schema: String,
    url: String,
}
async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("practice_overview_{}", Uuid::new_v4().simple());
    let schema_clone = schema.clone();
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |c, _| {
            let query = format!("SET search_path TO {schema_clone}");
            Box::pin(async move {
                sqlx::query(&query).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let tenant = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let cookie = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'owner@example.test','synthetic-not-a-login-hash','owner')").bind(tenant).bind(owner).execute(&db).await.unwrap();
    session(&db, tenant, owner, &cookie).await;
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: "synthetic-practice-admin-test-secret".into(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
    });
    Fixture {
        db,
        app,
        tenant,
        owner,
        cookie,
        schema,
        url,
    }
}
async fn session(db: &PgPool, tenant: Uuid, user: Uuid, cookie: &str) {
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(format!("{:x}",Sha256::digest(cookie.as_bytes()))).bind(tenant).bind(user).execute(db).await.unwrap();
}
async fn cleanup(f: Fixture) {
    f.db.close().await;
    let base = PgPool::connect(&f.url).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", f.schema))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
}
async fn call(
    app: &Router,
    cookie: &str,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let mut q = Request::builder()
        .method(method)
        .uri(path)
        .header("Cookie", format!("sce_session={cookie}"))
        .header("Origin", ORIGIN)
        .header("Content-Type", "application/json");
    if let Some(v) = version {
        q = q.header("If-Match", format!("\"{v}\""));
    }
    let response = app
        .clone()
        .oneshot(q.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let data = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&data).unwrap_or(Value::Null))
}
#[tokio::test]
async fn overview_counts_patients_gaps_claims_and_money() {
    let f = setup().await;
    // Two patients: one insured with no address, one self-pay with an address and phone.
    let insured = Uuid::new_v4();
    let selfpay = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-OV-1','Synthetic','Insured','1980-01-01'),($1,$3,'SYN-OV-2','Synthetic','Selfpay','1981-02-02')").bind(f.tenant).bind(insured).bind(selfpay).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,'{\"address\":{\"line1\":\"1 Synthetic Way\",\"city\":\"Synthetic\",\"region\":\"SY\",\"postal_code\":\"00000\",\"country\":\"US\"},\"phone\":\"5555550100\"}')").bind(f.tenant).bind(selfpay).execute(&f.db).await.unwrap();
    let payer = Uuid::new_v4();
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) SELECT $1,$2,'{\"name\":\"Synthetic Plan\",\"payer_code\":\"SYN01\",\"active\":true}'::jsonb,$3,'x'").bind(f.tenant).bind(payer).bind(Uuid::new_v4()).execute(&f.db).await.ok();
    sqlx::query("INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,'{\"status\":\"active\",\"priority\":\"primary\",\"member_id\":\"\"}',$5,'x')").bind(f.tenant).bind(Uuid::new_v4()).bind(insured).bind(payer).bind(Uuid::new_v4()).execute(&f.db).await.ok();
    let (status, v) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/overview?tz=America/New_York",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["time_zone"], "America/New_York");
    assert_eq!(v["patients"]["active"], 2);
    assert_eq!(v["patients"]["missing_address"], 1);
    assert_eq!(v["patients"]["missing_phone"], 1);
    let insured_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM insurance_coverages WHERE tenant_id=$1")
            .bind(f.tenant)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(v["patients"]["insured"], insured_rows);
    assert_eq!(v["patients"]["self_pay"], 2 - insured_rows);
    // The owner may see billing, so claims, money and the 30-day trend are there.
    assert!(v["claims"]["by_status"].is_object());
    assert_eq!(v["claims"]["needs_correction"], 0);
    assert_eq!(v["money"]["collected_today_cents"], 0);
    assert!(v["money"]["payment_account_balance"].is_null());
    assert_eq!(v["trend"].as_array().unwrap().len(), 30);
    // Money received is counted once per payment: a desk receipt on its day, a voided one not at all.
    let appointment = Uuid::new_v4();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,now(),now()+interval '30 minutes','checked_in')").bind(f.tenant).bind(appointment).bind(selfpay).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    let (kept, voided) = (Uuid::new_v4(), Uuid::new_v4());
    for (id, cents) in [(kept, 2500_i64), (voided, 1000)] {
        sqlx::query("INSERT INTO billing_copay_receipts(tenant_id,id,patient_id,appointment_id,amount_cents,method,reference,occurred_on,reason,request_id,creation_hash,actor_id) VALUES($1,$2,$3,$4,$5,'cash','',(now() AT TIME ZONE 'America/New_York')::date,'Synthetic cash',$6,'x',$7)").bind(f.tenant).bind(id).bind(selfpay).bind(appointment).bind(cents).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    }
    sqlx::query("INSERT INTO billing_copay_voids(tenant_id,receipt_id,reason,actor_id) VALUES($1,$2,'Synthetic void',$3)").bind(f.tenant).bind(voided).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    let (_, v) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/overview?tz=America/New_York",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(v["money"]["collected_today_cents"], 2500);
    assert_eq!(v["money"]["collected_month_cents"], 2500);
    assert_eq!(
        v["trend"].as_array().unwrap().last().unwrap()["collected_cents"],
        2500,
        "the 30-day line agrees with the tile"
    );

    let visit = Uuid::new_v4();
    let account = Uuid::new_v4();
    let invoice = Uuid::new_v4();
    let plan = Uuid::new_v4();
    let setting = Uuid::new_v4();
    let payment = Uuid::new_v4();
    let checkout = Uuid::new_v4();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id) VALUES($1,$2,$3,$4,$5)")
        .bind(f.tenant).bind(visit).bind(selfpay).bind(appointment).bind(f.owner).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO billing_accounts(tenant_id,id,patient_id,visit_id,content,total_cents,status,request_id,creation_hash) VALUES($1,$2,$3,$4,'{}',10000,'posted',$2,'synthetic')")
        .bind(f.tenant).bind(account).bind(selfpay).bind(visit).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO patient_invoice_snapshots(tenant_id,id,patient_id,account_id,request_id,creation_hash,account_version,snapshot,actor_id) VALUES($1,$2,$3,$4,$2,'synthetic',1,'{}',$5)")
        .bind(f.tenant).bind(invoice).bind(selfpay).bind(account).bind(f.owner).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO patient_installment_plans(tenant_id,id,patient_id,account_id,invoice_id,request_id,creation_hash,requested_by,reason,livemode,total_cents,responsibility_cents,baseline_version,account_snapshot,ledger_ids,schedule) VALUES($1,$2,$3,$4,$5,$2,'synthetic',$6,'Synthetic test',true,7500,7500,1,'{}','[]',jsonb_build_array(jsonb_build_object('due_on',current_date,'amount_cents',7500)))")
        .bind(f.tenant).bind(plan).bind(selfpay).bind(account).bind(invoice).bind(f.owner).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO payment_settings(tenant_id,id,mode) VALUES($1,$2,'own_stripe')")
        .bind(f.tenant)
        .bind(setting)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO payment_credentials(tenant_id,setting_id,revision,encrypted_config) VALUES($1,$2,1,'synthetic'::bytea)")
        .bind(f.tenant).bind(setting).execute(&f.db).await.unwrap();
    for (id, cents, content) in [
        (
            payment,
            7500_i64,
            json!({"method":"card","party":"patient","invoice_checkout_operation_id":checkout}),
        ),
        (Uuid::new_v4(), 1000, json!({"test_mode":true})),
        (Uuid::new_v4(), 2500, json!({"copay_receipt_id":kept})),
    ] {
        sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id) VALUES($1,$2,$3,'payment',-($4::bigint),$5,$2,'synthetic',$6)")
            .bind(f.tenant).bind(id).bind(account).bind(cents).bind(content).bind(f.owner).execute(&f.db).await.unwrap();
    }
    sqlx::query("INSERT INTO invoice_checkout_attempts(tenant_id,id,patient_id,account_id,plan_id,installment_number,setting_id,credential_revision,installation_id,provider_account_id,livemode,amount_cents,request_id,creation_hash,requested_by,reason,return_url,status,paid_entry_id) VALUES($1,$2,$3,$4,$5,1,$6,1,$6,'synthetic',true,7500,$2,'synthetic',$7,'Synthetic test','https://example.test','paid',$8)")
        .bind(f.tenant).bind(checkout).bind(selfpay).bind(account).bind(plan).bind(setting).bind(f.owner).bind(payment).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO billing_copay_receipts(tenant_id,id,patient_id,appointment_id,amount_cents,method,reference,occurred_on,reason,request_id,creation_hash,actor_id) VALUES($1,$2,$3,$4,1000,'cash','',(now() AT TIME ZONE 'America/New_York')::date-1,'Synthetic yesterday',$2,'synthetic',$5)")
        .bind(f.tenant).bind(Uuid::new_v4()).bind(selfpay).bind(appointment).bind(f.owner).execute(&f.db).await.unwrap();

    let path = "/api/v1/billing/collections/today?tz=America/New_York";
    let (status, collections) = call(&f.app, &f.cookie, "GET", path, Value::Null, None).await;
    assert_eq!(status, StatusCode::OK, "{collections}");
    assert_eq!(collections["total_cents"], 10000);
    let rows = collections["items"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["id"], payment.to_string());
    assert_eq!(rows[0]["invoice_id"], invoice.to_string());
    assert_eq!(rows[0]["account_id"], account.to_string());
    assert_eq!(rows[1]["id"], kept.to_string());
    assert_eq!(rows[1]["source"], "copay");
    assert_eq!(rows[1]["patient_id"], selfpay.to_string());
    assert_eq!(collections["time_zone"], "America/New_York");

    let (_, overview) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/overview?tz=America/New_York",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(
        collections["total_cents"],
        overview["money"]["collected_today_cents"]
    );

    // Every page retains the practice-wide total, with one row per underlying payment.
    sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id) SELECT $1,gen_random_uuid(),$2,'payment',-1,'{}',gen_random_uuid(),'synthetic',$3 FROM generate_series(1,50)")
        .bind(f.tenant).bind(account).bind(f.owner).execute(&f.db).await.unwrap();
    let (_, first) = call(&f.app, &f.cookie, "GET", path, Value::Null, None).await;
    assert_eq!(first["items"].as_array().unwrap().len(), 50);
    let cursor = first["next_cursor"]
        .as_str()
        .unwrap()
        .replace('+', "%2B")
        .replace('|', "%7C");
    let (_, second) = call(
        &f.app,
        &f.cookie,
        "GET",
        &format!("{path}&after={cursor}"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(second["total_cents"], 10050);
    assert_eq!(second["items"].as_array().unwrap().len(), 2);
    assert_eq!(second["items"][0]["id"], payment.to_string());
    assert_eq!(second["items"][1]["id"], kept.to_string());
    assert!(second["next_cursor"].is_null());

    let (staff, policy) = (Uuid::new_v4(), Uuid::new_v4());
    let staff_cookie = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'staff@example.test','synthetic','front_desk')")
        .bind(f.tenant).bind(staff).execute(&f.db).await.unwrap();
    session(&f.db, f.tenant, staff, &staff_cookie).await;
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Synthetic collections view','front_desk',$3,$4)")
        .bind(f.tenant).bind(policy).bind(json!({"billing":{"view":true}})).bind(f.owner).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)")
        .bind(f.tenant).bind(staff).bind(policy).bind(f.owner).execute(&f.db).await.unwrap();
    let (status, _) = call(&f.app, &staff_cookie, "GET", path, Value::Null, None).await;
    assert_eq!(status, StatusCode::OK);
    sqlx::query("UPDATE practice_access_policies SET permissions='{\"billing\":{\"view\":false}}' WHERE tenant_id=$1 AND id=$2")
        .bind(f.tenant).bind(policy).execute(&f.db).await.unwrap();
    let (status, _) = call(&f.app, &staff_cookie, "GET", path, Value::Null, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // An unknown time zone falls back to UTC rather than failing.
    let (status, v) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/overview?tz=Not/AZone",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(
        (status, v["time_zone"].as_str()),
        (StatusCode::OK, Some("UTC"))
    );
    cleanup(f).await;
}

#[tokio::test]
async fn patient_contact_filters_match_home_across_pages_and_respect_access() {
    let f = setup().await;
    let foreign_tenant = Uuid::new_v4();
    for (tenant, start, end) in [(f.tenant, 1_i32, 55_i32), (foreign_tenant, 54, 56)] {
        sqlx::query(
            "INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date)
             SELECT $1,('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
                 'SYN-' || i,'Synthetic','Patient','1980-01-01'
             FROM generate_series($2,$3) i",
        )
        .bind(tenant)
        .bind(start)
        .bind(end)
        .execute(&f.db)
        .await
        .unwrap();
    }
    let patient_id = |i: u32| Uuid::parse_str(&format!("00000000-0000-4000-8000-{i:012}")).unwrap();
    let address_present = patient_id(1);
    let phone_present = patient_id(2);
    let archived = patient_id(3);
    let foreign_only = patient_id(56);
    for (tenant, id, content) in [
        (
            f.tenant,
            address_present,
            serde_json::json!({"address":{"line1":"1 Synthetic Way"},"phone":null}),
        ),
        (
            f.tenant,
            phone_present,
            serde_json::json!({"address":{"line1":null,"city":"Synthetic"},"phone":"5555550100"}),
        ),
        (
            foreign_tenant,
            patient_id(54),
            serde_json::json!({"address":{"line1":"2 Synthetic Way"},"phone":"5555550101"}),
        ),
    ] {
        sqlx::query("INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,$3)")
            .bind(tenant).bind(id).bind(content).execute(&f.db).await.unwrap();
    }
    sqlx::query("INSERT INTO patient_lifecycle_events(tenant_id,patient_id,version,archived,reason,actor_id) VALUES($1,$2,2,true,'Synthetic archive',$3)")
        .bind(f.tenant).bind(archived).bind(f.owner).execute(&f.db).await.unwrap();
    let (status, overview) = call(
        &f.app,
        &f.cookie,
        "GET",
        "/api/v1/practice/overview",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    for (field, excluded, included) in [
        ("address", address_present, phone_present),
        ("phone", phone_present, address_present),
    ] {
        let path = format!("/api/v1/patients?missing={field}");
        let (status, first) = call(&f.app, &f.cookie, "GET", &path, Value::Null, None).await;
        assert_eq!(status, StatusCode::OK);
        let first_items = first["items"].as_array().unwrap();
        assert_eq!(first_items.len(), 50);
        let second_path = format!("{path}&after={}", first["next_cursor"].as_str().unwrap());
        let (status, second) =
            call(&f.app, &f.cookie, "GET", &second_path, Value::Null, None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(second["next_cursor"].is_null());
        let ids = first_items
            .iter()
            .chain(second["items"].as_array().unwrap())
            .map(|patient| Uuid::parse_str(patient["id"].as_str().unwrap()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids.len(), 53);
        assert_eq!(overview["patients"][format!("missing_{field}")], ids.len());
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(ids.contains(&included));
        assert!(ids.contains(&patient_id(54)));
        assert!(!ids.contains(&excluded));
        assert!(!ids.contains(&archived));
        assert!(!ids.contains(&foreign_only));
    }

    let restricted = Uuid::new_v4();
    let restricted_cookie = Uuid::new_v4().to_string();
    let policy = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,'restricted@example.test','unused','read_only')")
        .bind(f.tenant).bind(restricted).execute(&f.db).await.unwrap();
    session(&f.db, f.tenant, restricted, &restricted_cookie).await;
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Home only','read_only','{\"practice\":{\"view\":true}}',$3)")
        .bind(f.tenant).bind(policy).bind(f.owner).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)")
        .bind(f.tenant).bind(restricted).bind(policy).bind(f.owner).execute(&f.db).await.unwrap();
    let (status, _) = call(
        &f.app,
        &restricted_cookie,
        "GET",
        "/api/v1/patients?missing=phone",
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    cleanup(f).await;
}
