// SPDX-License-Identifier: AGPL-3.0-only
use super::*;
use axum::body::to_bytes;
use std::sync::{Arc, Mutex};
struct Fake {
    pool: PgPool,
    tenant: Uuid,
    installation: Uuid,
    calls: Mutex<Vec<(Method, String)>>,
    behavior: Mutex<String>,
    price: Uuid,
    price_request: Uuid,
}
impl Fake {
    fn set(&self, v: &str) {
        *self.behavior.lock().unwrap() = v.into();
    }
    fn envelope(&self, patient: Option<Uuid>) -> Value {
        let mut v = json!({"contract_version":1,"installation_id":self.installation,"remote_tenant_id":self.tenant,"account_id":"acct_synthetic","livemode":false,"checked_at":Utc::now()});
        if let Some(p) = patient {
            v["patient_id"] = json!(p);
        }
        v
    }
    fn price(&self, request: Uuid, status: &str) -> Value {
        json!({"id":self.price,"request_id":request,"provider_price_id":"price_synthetic","name":"Synthetic Monthly Care","amount_cents":2500,"currency":"usd","interval":"month","interval_count":1,"status":status,"created_at":"2026-11-01T00:00:00Z"})
    }
    fn subscription(&self, cancel: bool) -> Value {
        json!({"id":"sub_synthetic","status":"active","currency":"usd","created":1793491200,"cancel_at_period_end":cancel,"items":[{"id":"si_synthetic","quantity":1,"unit_amount":2500,"interval":"month","interval_count":1,"current_period_start":1793491200,"current_period_end":1796083200}]})
    }
}
#[async_trait]
impl Source for Fake {
    async fn config(&self, _: &PgPool, _: Uuid, _: &Settings) -> Result<Credentials> {
        Ok(Credentials {
            mode: "suncharts_connect".into(),
            api_key: None,
            webhook_secret: None,
            installation_id: Some(self.installation),
            broker_token: Some("scp_inst_synthetic".into()),
        })
    }
    async fn request(
        &self,
        config: &Credentials,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        self.calls
            .lock()
            .unwrap()
            .push((method.clone(), path.into()));
        if path == "/status" {
            return Ok(
                json!({"installation_id":self.installation,"remote_tenant_id":self.tenant,"account_id":"acct_synthetic","livemode":false}),
            );
        }
        let mode = self.behavior.lock().unwrap().clone();
        let base = path.split('?').next().unwrap();
        if method == Method::GET && (base == "/membership-prices" || base.ends_with("/memberships"))
        {
            let patient = if base == "/membership-prices" {
                None
            } else {
                Some(Uuid::parse_str(base.split('/').nth(2).unwrap()).unwrap())
            };
            let mut out = self.envelope(patient);
            let mut items = Vec::new();
            if let Some(patient) = patient.filter(|_| mode == "active_list") {
                let requests:Vec<Uuid>=sqlx::query_scalar("SELECT request_id FROM patient_membership_operations WHERE tenant_id=$1 AND patient_id=$2 AND kind='membership' ORDER BY request_id").bind(self.tenant).bind(patient).fetch_all(&self.pool).await?;
                for request in requests {
                    let proof = self
                        .request(
                            config,
                            Method::GET,
                            &format!(
                                "/patient-billing/{}/membership-checkouts/{request}",
                                patient
                            ),
                            None,
                        )
                        .await?;
                    items.push(proof["membership"].clone());
                }
            }
            out["items"] = json!(items);
            out["has_more"] = json!(false);
            out["next_cursor"] = Value::Null;
            out["creation_available"] = json!(true);
            return Ok(out);
        }
        let request = if let Some(b) = &body {
            serde_json::from_value(b["request_id"].clone()).unwrap()
        } else {
            Uuid::parse_str(path.split('?').next().unwrap().rsplit('/').next().unwrap()).unwrap()
        };
        let op: Operation = sqlx::query_as(
            "SELECT * FROM patient_membership_operations WHERE tenant_id=$1 AND request_id=$2",
        )
        .bind(self.tenant)
        .bind(request)
        .fetch_one(&self.pool)
        .await?;
        if mode == "lost" {
            return Err(Error::Invalid("Synthetic lost response"));
        }
        if mode == "disable" {
            sqlx::query("UPDATE browser_users SET disabled=true WHERE tenant_id=$1")
                .bind(self.tenant)
                .execute(&self.pool)
                .await?;
        }
        if mode == "rotation" {
            sqlx::query("UPDATE payment_settings SET credential_revision=credential_revision+1,version=version+1 WHERE tenant_id=$1").bind(self.tenant).execute(&self.pool).await?;
        }
        let mut out = self.envelope(op.patient_id);
        if op.kind == "price" {
            out["price"] = self.price(request, "active");
            out["retry_safe_until"] = json!(op.created_at + chrono::Duration::hours(23));
            out["recovery_required"] = json!(false);
        } else if op.kind == "membership" {
            let active = matches!(mode.as_str(), "active" | "cancel" | "active_list");
            let pending = mode == "creating" || mode == "review" || mode == "missing";
            let sub = if active {
                self.subscription(mode == "cancel")
            } else {
                Value::Null
            };
            let session = if pending {
                Value::Null
            } else {
                json!({"id":"cs_test_synthetic","url":if active{Value::Null}else{json!("https://checkout.stripe.com/c/pay/synthetic")},"status":if active{"complete"}else{"open"},"authorization_accepted":active,"subscription":sub})
            };
            out["membership"] = json!({"request_id":request,"price":self.price(self.price_request,"approved"),"terms":"You authorize USD 25.00 every 1 month for Synthetic Monthly Care. This membership renews automatically until canceled. Cancellation takes effect at the end of the paid period; cancellation does not issue a refund.","customer_id":"cus_synthetic","status":if mode=="review"{"needs_review"}else if pending{"creating"}else if active{"active"}else{"open"},"session":session,"subscription_id":if active{json!("sub_synthetic")}else{Value::Null},"subscription_status":if active{json!("active")}else{Value::Null},"cancel_at_period_end":if active{json!(mode=="cancel")}else{Value::Null},"current_period_end":if active{json!(1796083200_i64)}else{Value::Null},"retry_safe_until":op.created_at+chrono::Duration::hours(23),"recovery_required":mode=="review","created_at":op.created_at});
            if mode == "missing" {
                out["membership"].as_object_mut().unwrap().remove("session");
            }
            if mode == "badterms" {
                out["membership"]["terms"] = json!("Different payment authorization");
            }
        } else {
            let enrollment:Uuid=sqlx::query_scalar("SELECT request_id FROM patient_membership_operations WHERE tenant_id=$1 AND patient_id=$2 AND kind='membership' LIMIT 1").bind(self.tenant).bind(op.patient_id).fetch_one(&self.pool).await?;
            out["request_id"] = json!(request);
            out["membership_request_id"] = json!(enrollment);
            out["status"] = json!("scheduled");
            out["subscription"] = self.subscription(true);
            out["retry_safe_until"] = json!(op.created_at + chrono::Duration::hours(23));
            out["recovery_required"] = json!(false);
        }
        if mode == "expiredwindow" {
            out["membership"]["status"] = json!("creating");
            out["membership"]["session"] = Value::Null;
            out["membership"]["retry_safe_until"] =
                json!(Utc::now() - chrono::Duration::minutes(1));
        }
        if mode == "wrongpatient" {
            out["patient_id"] = json!(Uuid::new_v4());
        }
        if mode == "wrongmode" {
            out["livemode"] = json!(true);
        }
        out["secret"] = json!("must-not-leak");
        Ok(out)
    }
}
struct Fixture {
    pool: PgPool,
    state: State,
    actor: Actor,
    patient: Uuid,
    fake: Arc<Fake>,
}
impl Fixture {
    async fn new() -> Self {
        Self::at_revision(102).await
    }
    async fn at_revision(revision: i64) -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("patient_membership_{}", Uuid::new_v4().simple());
        crate::test_db::create_schema(&admin, &schema).await;
        admin.close().await;
        let pool = sqlx::postgres::PgPoolOptions::new()
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
        sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(
                crate::MIGRATOR
                    .iter()
                    .filter(|m| m.version <= revision)
                    .cloned()
                    .collect(),
            ),
            ..sqlx::migrate::Migrator::DEFAULT
        }
        .run(&pool)
        .await
        .unwrap();
        let tenant = Uuid::new_v4();
        let patient = Uuid::new_v4();
        let now = Utc::now().timestamp();
        let actor = Actor {
            sub: Uuid::new_v4(),
            tenant_id: tenant,
            role: Role::Owner,
            patient_id: None,
            iss: "suncharts".into(),
            aud: "suncharts-engine".into(),
            iat: now,
            exp: now + 120,
        };
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-PROFILE','Avery','Synthetic','1990-01-01')").bind(tenant).bind(patient).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO payment_settings(tenant_id,id,mode,provider_account_id) VALUES($1,$2,'suncharts_connect','acct_synthetic')").bind(tenant).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,'synthetic@example.test','not-a-login','owner')").bind(actor.sub).bind(tenant).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')").bind(crate::browser::hash("synthetic_profile_cookie")).bind(tenant).bind(actor.sub).execute(&pool).await.unwrap();
        let state = State {
            backend: Arc::new(crate::postgres::PostgresBackend(pool.clone())),
            browser: Some(
                crate::browser::BrowserAuth::new(pool.clone(), "http://127.0.0.1:8099".into())
                    .unwrap(),
            ),
            secret: "synthetic-profile-secret-32-characters".into(),
            allow_legacy_gateway: true,
            issuer: "suncharts".into(),
            audience: "suncharts-engine".into(),
        };
        let fake = Arc::new(Fake {
            pool: pool.clone(),
            tenant,
            installation: Uuid::new_v4(),
            calls: Mutex::new(vec![]),
            behavior: Mutex::new("open".into()),
            price: Uuid::new_v4(),
            price_request: Uuid::new_v4(),
        });
        Self {
            pool,
            state,
            actor,
            patient,
            fake,
        }
    }
}
impl Fixture {
    fn headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            "cookie",
            "sce_session=synthetic_profile_cookie".parse().unwrap(),
        );
        h.insert("origin", "http://127.0.0.1:8099".parse().unwrap());
        h
    }
    async fn create_member(&self, request: Uuid) -> Result<Response> {
        create_with(
            self.actor.clone(),
            self.state.clone(),
            Some(self.patient),
            self.headers(),
            "membership",
            request,
            json!({"price_id":self.fake.price,"consent":true}),
            self.fake.as_ref(),
        )
        .await
    }
    async fn read_member(&self, request: Uuid) -> Result<Response> {
        read_with(
            self.actor.clone(),
            self.state.clone(),
            request,
            self.headers(),
            false,
            self.fake.as_ref(),
        )
        .await
    }
    fn posts(&self) -> usize {
        self.fake
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| *m == Method::POST)
            .count()
    }
    async fn untouched(&self) {
        for table in [
            "billing_accounts",
            "billing_entries",
            "billing_copay_receipts",
            "patient_invoice_snapshots",
            "connected_payment_customers",
        ] {
            let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&self.pool)
                .await
                .unwrap();
            assert_eq!(n, 0, "{table}");
        }
    }
}
async fn value(r: Response) -> Value {
    let bytes = to_bytes(r.into_body(), 262144).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(!text.contains("must-not-leak"));
    serde_json::from_str(&text).unwrap()
}
#[tokio::test]
async fn membership_gateway_consent_reservation_read_and_cancel_never_change_ledger() {
    let f = Fixture::new().await;
    let request = Uuid::new_v4();
    let open = value(f.create_member(request).await.unwrap()).await;
    assert_eq!(open["membership"]["status"], "open");
    assert_eq!(f.posts(), 1);
    let replay = value(f.create_member(request).await.unwrap()).await;
    assert_eq!(
        replay["membership"]["session"],
        open["membership"]["session"]
    );
    assert_eq!(f.posts(), 1, "known checkout replay uses read only");
    f.fake.set("active");
    let active = value(f.read_member(request).await.unwrap()).await;
    assert_eq!(active["membership"]["status"], "active");
    let cancel = Uuid::new_v4();
    let out = value(
        create_with(
            f.actor.clone(),
            f.state.clone(),
            Some(f.patient),
            f.headers(),
            "cancel",
            cancel,
            json!({"subscription_id":"sub_synthetic","expected_cancel_at_period_end":false}),
            f.fake.as_ref(),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(out["status"], "scheduled");
    assert_eq!(out["retry_allowed"], false);
    let before = f.posts();
    f.read_member(cancel).await.unwrap();
    assert_eq!(f.posts(), before);
    let blocked=sqlx::query("UPDATE patient_membership_operations SET request_body='{}' WHERE tenant_id=$1 AND request_id=$2").bind(f.actor.tenant_id).bind(request).execute(&f.pool).await;
    assert!(blocked.is_err());
    f.untouched().await;
}
#[tokio::test]
async fn membership_gateway_uncertain_response_keeps_original_request_and_rejects_unproven_retry() {
    let f = Fixture::new().await;
    let r = Uuid::new_v4();
    f.fake.set("lost");
    assert!(f.create_member(r).await.is_err());
    assert_eq!(f.posts(), 1);
    assert!(f.create_member(Uuid::new_v4()).await.is_err());
    assert_eq!(f.posts(), 1);
    f.fake.set("creating");
    let v = value(f.read_member(r).await.unwrap()).await;
    assert_eq!(v["membership"]["retry_allowed"], true);
    assert_eq!(f.posts(), 1);
    f.fake.set("missing");
    assert!(f.read_member(r).await.is_err());
    f.fake.set("review");
    let v = value(f.read_member(r).await.unwrap()).await;
    assert_eq!(v["membership"]["retry_allowed"], false);
    assert!(f.create_member(r).await.is_err());
    assert_eq!(f.posts(), 1, "explicit review never retried");
    f.untouched().await;
}
#[tokio::test]
async fn membership_gateway_revalidates_identity_mode_terms_and_current_session() {
    for behavior in [
        "wrongpatient",
        "wrongmode",
        "badterms",
        "disable",
        "rotation",
    ] {
        let f = Fixture::new().await;
        f.fake.set(behavior);
        let r = Uuid::new_v4();
        assert!(f.create_member(r).await.is_err(), "{behavior}");
        let evidence:Option<Value>=sqlx::query_scalar("SELECT provider_evidence FROM patient_membership_operations WHERE tenant_id=$1 AND request_id=$2").bind(f.actor.tenant_id).bind(r).fetch_one(&f.pool).await.unwrap();
        assert!(evidence.is_none(), "{behavior}");
        f.untouched().await;
    }
}
#[tokio::test]
async fn membership_gateway_owner_approval_and_binding_are_required_for_prices() {
    let f = Fixture::new().await;
    let r = Uuid::new_v4();
    let body = json!({"name":"Synthetic Monthly Care","amount_cents":2500,"currency":"usd","interval":"month","interval_count":1,"approved":true,"approval_reason":"Synthetic owner approval"});
    validate_price_input(&body).unwrap();
    let v = value(
        create_with(
            f.actor.clone(),
            f.state.clone(),
            None,
            f.headers(),
            "price",
            r,
            body.clone(),
            f.fake.as_ref(),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(v["price"]["status"], "active");
    let mut changed = body.clone();
    changed["amount_cents"] = json!(3000);
    assert!(create_with(
        f.actor.clone(),
        f.state.clone(),
        None,
        f.headers(),
        "price",
        r,
        changed,
        f.fake.as_ref()
    )
    .await
    .is_err());
    sqlx::query("UPDATE browser_users SET role='clinician' WHERE tenant_id=$1")
        .bind(f.actor.tenant_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let before = f.posts();
    assert!(create_with(
        f.actor.clone(),
        f.state.clone(),
        None,
        f.headers(),
        "price",
        Uuid::new_v4(),
        body,
        f.fake.as_ref()
    )
    .await
    .is_err());
    assert_eq!(f.posts(), before);
    f.untouched().await;
}

#[tokio::test]
async fn membership_gateway_pending_requests_survive_reload_without_replacement_ids() {
    let f = Fixture::new().await;
    let request = Uuid::new_v4();
    f.fake.set("lost");
    assert!(f.create_member(request).await.is_err());
    f.fake.set("open");
    let out = value(
        list_with(
            f.actor.clone(),
            f.state.clone(),
            Some(f.patient),
            Page::default(),
            f.headers(),
            f.fake.as_ref(),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(out["pending_operations"][0]["request_id"], json!(request));
    assert_eq!(out["pending_operations"][0]["retry_allowed"], true);
    assert_eq!(
        out["pending_operations"][0]["request"],
        json!({"request_id":request,"price_id":f.fake.price,"consent":true})
    );
    assert_eq!(f.posts(), 1, "listing never retries creation");
    // A different staff member may review the pending identifier, but not reuse the initiator's consent.
    let mut other = f.actor.clone();
    other.sub = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,'other@example.test','not-a-login','owner')").bind(other.sub).bind(other.tenant_id).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')").bind(crate::browser::hash("synthetic_other_membership_cookie")).bind(other.tenant_id).bind(other.sub).execute(&f.pool).await.unwrap();
    let mut headers = f.headers();
    headers.insert(
        "cookie",
        "sce_session=synthetic_other_membership_cookie"
            .parse()
            .unwrap(),
    );
    let out = value(
        list_with(
            other,
            f.state.clone(),
            Some(f.patient),
            Page::default(),
            headers,
            f.fake.as_ref(),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(out["pending_operations"][0]["retry_allowed"], false);
    assert!(out["pending_operations"][0]["request"].is_null());
    f.untouched().await;
}
#[tokio::test]
async fn membership_gateway_additive_upgrade_preserves_existing_records_and_setup_consent() {
    let f = Fixture::at_revision(100).await;
    sqlx::query("INSERT INTO patient_payment_setups(tenant_id,request_id,patient_id,setting_id,credential_revision,installation_id,provider_account_id,livemode,return_url,requested_by,consent_scope,status,provider_evidence) SELECT tenant_id,$2,$3,id,credential_revision,$4,'acct_synthetic',false,'http://127.0.0.1:8099/?payment_setup=historical',$5,'patient_present','succeeded','{\"historical\":true}'::jsonb FROM payment_settings WHERE tenant_id=$1").bind(f.actor.tenant_id).bind(Uuid::new_v4()).bind(f.patient).bind(f.fake.installation).bind(f.actor.sub).execute(&f.pool).await.unwrap();
    let tables:Vec<String>=sqlx::query_scalar("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'_sqlx_migrations' ORDER BY tablename").fetch_all(&f.pool).await.unwrap();
    let mut before = Vec::new();
    for table in &tables {
        assert!(table
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'_'));
        // Later additive columns are null on existing rows; every existing value must be unchanged.
        let q=format!("SELECT coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(r)) ORDER BY jsonb_strip_nulls(to_jsonb(r))::text),'[]'::jsonb) FROM \"{table}\" r");
        before.push(
            sqlx::query_scalar::<_, Value>(&q)
                .fetch_one(&f.pool)
                .await
                .unwrap(),
        );
    }
    let metadata: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM _sqlx_migrations m WHERE version<=100",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    crate::MIGRATOR.run(&f.pool).await.unwrap();
    crate::MIGRATOR.run(&f.pool).await.unwrap();
    for (table, expected) in tables.iter().zip(before) {
        // Later additive columns are null on existing rows; every existing value must be unchanged.
        let q=format!("SELECT coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(r)) ORDER BY jsonb_strip_nulls(to_jsonb(r))::text),'[]'::jsonb) FROM \"{table}\" r");
        assert_eq!(
            expected,
            sqlx::query_scalar::<_, Value>(&q)
                .fetch_one(&f.pool)
                .await
                .unwrap(),
            "{table}"
        );
    }
    let after: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM _sqlx_migrations m WHERE version<=100",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(metadata, after);
    // A card saved before later charges existed keeps its in-person consent and gains nothing.
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM patient_payment_setups WHERE consent_scope='patient_present' AND consent_version IS NULL AND consent_recorded_at IS NULL AND cancelled_at IS NULL AND cancelled_by IS NULL")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM patient_membership_operations")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
}

#[test]
fn membership_gateway_live_activation_is_separate_and_production_rejects_test_writes() {
    assert!(!writes_allowed_in(true, true, false));
    assert!(!writes_allowed_in(true, false, false));
    assert!(!writes_allowed_in(false, false, true));
    assert!(writes_allowed_in(false, true, false));
    assert!(writes_allowed_in(true, false, true));
}

#[tokio::test]
async fn membership_gateway_provider_deadline_cannot_be_extended_or_retried_after_expiry() {
    let f = Fixture::new().await;
    let request = Uuid::new_v4();
    f.fake.set("lost");
    assert!(f.create_member(request).await.is_err());
    f.fake.set("expiredwindow");
    let expired = value(f.read_member(request).await.unwrap()).await;
    assert_eq!(expired["membership"]["retry_allowed"], false);
    assert!(f.create_member(request).await.is_err());
    assert_eq!(f.posts(), 1);
    f.fake.set("creating");
    let later = value(f.read_member(request).await.unwrap()).await;
    assert_eq!(
        later["membership"]["retry_safe_until"],
        expired["membership"]["retry_safe_until"]
    );
    assert_eq!(later["membership"]["retry_allowed"], false);
    assert!(f.create_member(request).await.is_err());
    assert_eq!(f.posts(), 1);
    f.untouched().await;
}

#[tokio::test]
async fn membership_gateway_lost_return_list_reconciles_native_mapping_for_edit_only_cancellation()
{
    let mut f = Fixture::new().await;
    let request = Uuid::new_v4();
    f.create_member(request).await.unwrap();
    let before:Value=sqlx::query_scalar("SELECT provider_evidence FROM patient_membership_operations WHERE tenant_id=$1 AND request_id=$2").bind(f.actor.tenant_id).bind(request).fetch_one(&f.pool).await.unwrap();
    assert!(before["membership"]["subscription_id"].is_null());
    let policy = Uuid::new_v4();
    sqlx::query("UPDATE browser_users SET role='clinician' WHERE tenant_id=$1 AND id=$2")
        .bind(f.actor.tenant_id)
        .bind(f.actor.sub)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Membership cancellation only','clinician',$3,$4)").bind(f.actor.tenant_id).bind(policy).bind(json!({"billing":{"view":true,"create":false,"edit":true,"delete":false}})).bind(f.actor.sub).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$2)").bind(f.actor.tenant_id).bind(f.actor.sub).bind(policy).execute(&f.pool).await.unwrap();
    f.actor.role = Role::Clinician;
    f.fake.set("active_list");
    let out = value(
        list_with(
            f.actor.clone(),
            f.state.clone(),
            Some(f.patient),
            Page::default(),
            f.headers(),
            f.fake.as_ref(),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(out["items"][0]["status"], "active");
    assert_eq!(out["items"][0]["cancellation_available"], true);
    assert_eq!(out["creation_available"], false);
    assert!(out["pending_operations"].as_array().unwrap().is_empty());
    assert_eq!(
        f.posts(),
        1,
        "lost-return reconciliation is read-only at broker"
    );
    let stored:Value=sqlx::query_scalar("SELECT provider_evidence FROM patient_membership_operations WHERE tenant_id=$1 AND request_id=$2").bind(f.actor.tenant_id).bind(request).fetch_one(&f.pool).await.unwrap();
    assert_eq!(stored["membership"]["subscription_id"], "sub_synthetic");
    assert!(
        f.create_member(Uuid::new_v4()).await.is_err(),
        "create right was revoked"
    );
    let cancel = value(
        create_with(
            f.actor.clone(),
            f.state.clone(),
            Some(f.patient),
            f.headers(),
            "cancel",
            Uuid::new_v4(),
            json!({"subscription_id":"sub_synthetic","expected_cancel_at_period_end":false}),
            f.fake.as_ref(),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(cancel["status"], "scheduled");
    assert_eq!(f.posts(), 2);
    f.untouched().await;
}
