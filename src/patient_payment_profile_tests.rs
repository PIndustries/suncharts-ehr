// SPDX-License-Identifier: AGPL-3.0-only
use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

struct Fake {
    pool: PgPool,
    tenant: Uuid,
    installation: Uuid,
    calls: Mutex<Vec<(Method, String)>>,
    behavior: Mutex<String>,
    request: Mutex<Option<Uuid>>,
    patient: Mutex<Option<Uuid>>,
}
impl Fake {
    fn set(&self, name: &str) {
        *self.behavior.lock().unwrap() = name.into();
    }
    fn envelope(&self, patient: Uuid) -> Value {
        json!({"contract_version":1,"installation_id":self.installation,"remote_tenant_id":self.tenant,"account_id":"acct_synthetic","livemode":false,"patient_id":patient,"checked_at":Utc::now()})
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
            broker_token: Some("scp_inst_synthetic_token".into()),
        })
    }
    async fn request(
        &self,
        _: &Credentials,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        self.calls
            .lock()
            .unwrap()
            .push((method.clone(), path.to_owned()));
        if path == "/status" {
            return Ok(
                json!({"installation_id":self.installation,"remote_tenant_id":self.tenant,"account_id":"acct_synthetic","livemode":false}),
            );
        }
        let mode = self.behavior.lock().unwrap().clone();
        if mode == "disable" {
            sqlx::query("UPDATE browser_users SET disabled=true WHERE tenant_id=$1")
                .bind(self.tenant)
                .execute(&self.pool)
                .await?;
        }
        if mode == "change" {
            sqlx::query("UPDATE payment_settings SET credential_revision=credential_revision+1,version=version+1 WHERE tenant_id=$1").bind(self.tenant).execute(&self.pool).await?;
        }
        let patient =
            Uuid::parse_str(path.split('/').nth(2).unwrap().split('?').next().unwrap()).unwrap();
        let mut out = self.envelope(patient);
        if !path.contains("setup-checkouts") {
            out["customer"] = json!({"status":"available","id":"cus_synthetic"});
            out["setup_available"] = json!(true);
            out["payment_methods"] = json!({"status":"available","data":{"items":[{"id":"pm_synthetic","brand":"visa","last4":"4242","exp_month":12,"exp_year":2030,"allow_redisplay":"always","billing_details":{"secret":"must-not-leak"}}],"has_more":false,"next_cursor":null}});
            for key in ["invoices", "subscriptions"] {
                out[key] = json!({"status":"available","data":{"items":[],"has_more":false,"next_cursor":null}});
            }
        } else {
            if method == Method::POST {
                let v = body.unwrap();
                assert_eq!(v["consent"], true);
                assert_eq!(v["livemode"], false);
                assert_eq!(v["account_id"], "acct_synthetic");
                let request: Uuid = serde_json::from_value(v["request_id"].clone()).unwrap();
                let reserved:i64=sqlx::query_scalar("SELECT count(*) FROM patient_payment_setups WHERE tenant_id=$1 AND request_id=$2 AND patient_id=$3").bind(self.tenant).bind(request).bind(patient).fetch_one(&self.pool).await?;
                assert_eq!(
                    reserved, 1,
                    "reservation must commit before provider side effect"
                );
                if let Some(prior) = *self.request.lock().unwrap() {
                    assert_eq!(prior, request, "retries must keep stable id");
                }
                *self.request.lock().unwrap() = Some(request);
                *self.patient.lock().unwrap() = Some(patient);
                if mode == "lost" {
                    return Err(Error::Invalid("Synthetic transport lost response"));
                }
            }
            let request = self.request.lock().unwrap().unwrap();
            assert_eq!(*self.patient.lock().unwrap(), Some(patient));
            let complete = mode == "succeeded";
            out["request_id"] = json!(request);
            out["customer_id"] = json!("cus_synthetic");
            out["status"] = json!(if mode == "creating" {
                "creating"
            } else if complete {
                "succeeded"
            } else {
                "open"
            });
            out["session"] = if mode == "creating" {
                Value::Null
            } else {
                json!({"id":"cs_test_synthetic","url":if complete{Value::Null}else{json!("https://checkout.stripe.com/c/pay/synthetic#stripe-fragment")},"status":if complete{"complete"}else{"open"},"setup_intent_id":if complete{json!("seti_synthetic")}else{Value::Null},"setup_intent_status":if complete{json!("succeeded")}else{Value::Null},"payment_method_id":if complete{json!("pm_synthetic")}else{Value::Null},"client_secret":"must-not-leak"})
            };
            out["retry_safe_until"] = json!(Utc::now() + chrono::Duration::hours(23));
            out["recovery_required"] = json!(false);
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
        let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("patient_profile_{}", Uuid::new_v4().simple());
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
        crate::MIGRATOR.run(&pool).await.unwrap();
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
            request: Mutex::new(None),
            patient: Mutex::new(None),
        });
        Self {
            pool,
            state,
            actor,
            patient,
            fake,
        }
    }
    fn app(&self) -> Router {
        let f = self.fake.clone();
        let f2 = f.clone();
        let f3 = f.clone();
        Router::new()
            .route(
                "/api/v1/billing/patients/{id}/payment-profile",
                get(
                    move |a: Actor,
                          ExtractState(s): ExtractState<State>,
                          Path(p): Path<Uuid>,
                          Query(q): Query<ProfileQuery>,
                          h: HeaderMap| {
                        let f = f.clone();
                        async move { super::super::read_with(a, s, p, q, h, f.as_ref()).await }
                    },
                ),
            )
            .route(
                "/api/v1/billing/patients/{id}/payment-setups",
                post(
                    move |a: Actor,
                          ExtractState(s): ExtractState<State>,
                          Path(p): Path<Uuid>,
                          h: HeaderMap,
                          Json(v): Json<Input>| {
                        let f = f2.clone();
                        async move { create_with(a, s, p, h, v, f.as_ref()).await }
                    },
                ),
            )
            .route(
                "/api/v1/billing/payment-setups/{id}",
                get(
                    move |a: Actor,
                          ExtractState(s): ExtractState<State>,
                          Path(id): Path<Uuid>,
                          h: HeaderMap| {
                        let f = f3.clone();
                        async move { read_with(a, s, id, h, f.as_ref()).await }
                    },
                ),
            )
            .with_state(self.state.clone())
    }
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Value,
        cookie: bool,
        actor: Option<&Actor>,
    ) -> (u16, Value) {
        let mut r = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if cookie {
            r = r
                .header("cookie", "sce_session=synthetic_profile_cookie")
                .header("origin", "http://127.0.0.1:8099");
        } else {
            let jwt = jsonwebtoken::encode(
                &jsonwebtoken::Header::default(),
                actor.unwrap_or(&self.actor),
                &jsonwebtoken::EncodingKey::from_secret(self.state.secret.as_bytes()),
            )
            .unwrap();
            r = r.header("authorization", format!("Bearer {jwt}"));
        }
        let response = self
            .app()
            .oneshot(r.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 262144).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(!text.contains("must-not-leak"));
        assert!(!text.contains("scp_inst_"));
        (status, serde_json::from_str(&text).unwrap())
    }
    async fn untouched(&self) {
        for table in [
            "billing_entries",
            "payment_attempts",
            "billing_copay_receipts",
            "copay_checkout_attempts",
            "patient_invoice_snapshots",
        ] {
            let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&self.pool)
                .await
                .unwrap();
            assert_eq!(n, 0, "{table}");
        }
    }
}
#[tokio::test]
async fn setup_lost_response_resumes_exact_request_and_never_posts_money() {
    let f = Fixture::new().await;
    let request = Uuid::new_v4();
    let create = format!("/api/v1/billing/patients/{}/payment-setups", f.patient);
    let read = format!("/api/v1/billing/payment-setups/{request}");
    let input = json!({"request_id":request,"consent":true});
    f.fake.set("lost");
    assert_eq!(
        f.call("POST", &create, input.clone(), false, None).await.0,
        400
    );
    let status: String = sqlx::query_scalar(
        "SELECT status FROM patient_payment_setups WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(f.actor.tenant_id)
    .bind(request)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(status, "needs_review");
    let posts = || {
        f.fake
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| *m == Method::POST)
            .count()
    };
    assert_eq!(posts(), 1);
    assert_eq!(
        f.call(
            "POST",
            &create,
            json!({"request_id":Uuid::new_v4(),"consent":true}),
            false,
            None
        )
        .await
        .0,
        409
    );
    assert_eq!(posts(), 1);
    f.fake.set("creating");
    let (code, v) = f.call("GET", &read, Value::Null, false, None).await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["retry_allowed"], true);
    assert_eq!(posts(), 1);
    f.fake.set("open");
    let (code, v) = f.call("POST", &create, input.clone(), false, None).await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["status"], "open");
    assert_eq!(v["retry_allowed"], false);
    assert_eq!(posts(), 2);
    let (code, v) = f
        .call(
            "GET",
            &format!("/api/v1/billing/patients/{}/payment-profile", f.patient),
            Value::Null,
            false,
            None,
        )
        .await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["active_setup"]["request_id"], request.to_string());
    f.fake.set("succeeded");
    let (code, v) = f.call("GET", &read, Value::Null, false, None).await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["session"]["payment_method_id"], "pm_synthetic");
    assert_eq!(v["status"], "succeeded");
    assert_eq!(f.call("POST", &create, input, false, None).await.0, 200);
    assert_eq!(posts(), 2, "terminal retry never calls provider create");
    let mutation = sqlx::query(
        "UPDATE patient_payment_setups SET patient_id=$3 WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(f.actor.tenant_id)
    .bind(request)
    .bind(Uuid::new_v4())
    .execute(&f.pool)
    .await;
    assert!(mutation.is_err());
    f.untouched().await;
}
#[tokio::test]
async fn profile_binding_scope_revocation_and_archive_are_enforced() {
    let f = Fixture::new().await;
    let path = format!("/api/v1/billing/patients/{}/payment-profile", f.patient);
    let (code, v) = f.call("GET", &path, Value::Null, false, None).await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["payment_methods"]["data"]["items"][0]["last4"], "4242");
    let before = f.fake.calls.lock().unwrap().len();
    let mut other = f.actor.clone();
    other.tenant_id = Uuid::new_v4();
    assert_eq!(
        f.call("GET", &path, Value::Null, false, Some(&other))
            .await
            .0,
        404
    );
    assert_eq!(f.fake.calls.lock().unwrap().len(), before);
    f.fake.set("wrongpatient");
    assert_eq!(f.call("GET", &path, Value::Null, false, None).await.0, 400);
    f.fake.set("wrongmode");
    assert_eq!(f.call("GET", &path, Value::Null, false, None).await.0, 400);
    f.fake.set("open");
    sqlx::query("INSERT INTO patient_lifecycle_events(tenant_id,patient_id,version,archived,reason,actor_id) VALUES($1,$2,2,true,'Synthetic archive',$3)").bind(f.actor.tenant_id).bind(f.patient).bind(f.actor.sub).execute(&f.pool).await.unwrap();
    let (code, v) = f.call("GET", &path, Value::Null, false, None).await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["setup_available"], false);
    assert_eq!(
        f.call(
            "POST",
            &format!("/api/v1/billing/patients/{}/payment-setups", f.patient),
            json!({"request_id":Uuid::new_v4(),"consent":true}),
            false,
            None
        )
        .await
        .0,
        409
    );
    f.fake.set("change");
    assert_eq!(f.call("GET", &path, Value::Null, false, None).await.0, 409);
    f.fake.set("disable");
    assert_eq!(f.call("GET", &path, Value::Null, true, None).await.0, 401);
    f.untouched().await;
}
#[tokio::test]
async fn setup_cross_binding_and_missing_consent_never_create() {
    let f = Fixture::new().await;
    let path = format!("/api/v1/billing/patients/{}/payment-setups", f.patient);
    let request = Uuid::new_v4();
    assert_eq!(
        f.call(
            "POST",
            &path,
            json!({"request_id":request,"consent":false}),
            false,
            None
        )
        .await
        .0,
        400
    );
    assert!(f.fake.calls.lock().unwrap().is_empty());
    let mut reader = f.actor.clone();
    reader.role = Role::ReadOnly;
    assert_eq!(
        f.call(
            "POST",
            &path,
            json!({"request_id":request,"consent":true}),
            false,
            Some(&reader)
        )
        .await
        .0,
        403
    );
    f.fake.set("wrongmode");
    assert_eq!(
        f.call(
            "POST",
            &path,
            json!({"request_id":request,"consent":true}),
            false,
            None
        )
        .await
        .0,
        400
    );
    let stored: Option<Value> = sqlx::query_scalar(
        "SELECT provider_evidence FROM patient_payment_setups WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(f.actor.tenant_id)
    .bind(request)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(stored.is_none());
    let mut other = f.actor.clone();
    other.tenant_id = Uuid::new_v4();
    let read = format!("/api/v1/billing/payment-setups/{request}");
    assert_eq!(
        f.call("GET", &read, Value::Null, false, Some(&other))
            .await
            .0,
        404
    );
    sqlx::query("UPDATE payment_settings SET credential_revision=credential_revision+1,version=version+1 WHERE tenant_id=$1").bind(f.actor.tenant_id).execute(&f.pool).await.unwrap();
    let before = f.fake.calls.lock().unwrap().len();
    assert_eq!(f.call("GET", &read, Value::Null, false, None).await.0, 409);
    assert_eq!(
        f.fake.calls.lock().unwrap().len(),
        before + 1,
        "only account status, no setup request after credential replacement"
    );
    f.untouched().await;
}
