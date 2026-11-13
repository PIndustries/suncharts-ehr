// SPDX-License-Identifier: AGPL-3.0-only
// A synthetic SunCharts Connect for card readers. It answers with the same envelopes the real
// broker returns, and a test "presents a card" by calling approve or decline.
use super::*;
use async_trait::async_trait;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

pub(crate) struct Pay {
    pub(crate) amount: i64,
    pub(crate) reader: String,
    pub(crate) intent: Option<&'static str>,
    pub(crate) action: Option<&'static str>,
    pub(crate) failure: Option<&'static str>,
    pub(crate) refunded: i64,
    pub(crate) cancelled: bool,
    pub(crate) created: i64,
}
#[derive(Default)]
pub(crate) struct World {
    pub(crate) readers: Vec<Value>,
    pub(crate) payments: BTreeMap<Uuid, Pay>,
    pub(crate) posted: Vec<Value>,
    pub(crate) starts: usize,
    pub(crate) cancels: usize,
    pub(crate) reads: usize,
    /// Refusal for the next attempts to send a payment to a reader.
    pub(crate) start_refusal: Option<(u16, &'static str)>,
    pub(crate) cancel_busy: bool,
    pub(crate) reader_offline: bool,
    pub(crate) unreachable: bool,
    pub(crate) wrong_account: bool,
    pub(crate) hosted_checkout_disabled: bool,
}
pub(crate) struct FakeReaders {
    pub(crate) installation: Uuid,
    pub(crate) live: bool,
    pub(crate) state: Mutex<World>,
}
fn refusal(status: u16, code: &str) -> Reply {
    Reply {
        status,
        body: json!({"error":code,"message":"synthetic"}),
    }
}
impl FakeReaders {
    pub(crate) fn new(live: bool) -> Self {
        Self {
            installation: Uuid::new_v4(),
            live,
            state: Mutex::new(World::default()),
        }
    }
    pub(crate) fn with_reader(live: bool) -> Self {
        let fake = Self::new(live);
        fake.state.lock().unwrap().readers.push(json!({"id":"tmr_frontdesk","label":"Front desk","device_type":"simulated_wisepos_e","status":"online","last_seen_at":1_700_000_000_000_i64,"action":{"type":null,"status":null}}));
        fake
    }
    pub(crate) fn approve(&self, id: Uuid) {
        let mut world = self.state.lock().unwrap();
        let pay = world.payments.get_mut(&id).unwrap();
        pay.intent = Some("succeeded");
        pay.action = Some("succeeded");
    }
    pub(crate) fn decline(&self, id: Uuid) {
        let mut world = self.state.lock().unwrap();
        let pay = world.payments.get_mut(&id).unwrap();
        pay.action = Some("failed");
        pay.failure = Some("card_declined");
    }
    pub(crate) fn patient_cancels(&self, id: Uuid) {
        let mut world = self.state.lock().unwrap();
        let pay = world.payments.get_mut(&id).unwrap();
        pay.action = Some("failed");
        pay.failure = Some("customer_canceled");
    }
    fn envelope(&self, binding: &Binding, id: Uuid, pay: &Pay, world: &World) -> Value {
        let intent = format!("pi_{}", id.simple());
        let paid = pay.intent == Some("succeeded");
        let charge = if paid || pay.failure == Some("card_declined") {
            json!({"id":format!("ch_{}",id.simple()),"livemode":self.live,"amount":pay.amount,"amount_refunded":pay.refunded,"paid":paid,"captured":paid,"disputed":false,"created":pay.created,"currency":"usd","payment_intent":intent})
        } else {
            Value::Null
        };
        json!({"contract_version":1,"installation_id":self.installation,"remote_tenant_id":binding.tenant,
            "account_id":if world.wrong_account{"acct_wrong"}else{"acct_synthetic"},"livemode":self.live,
            "request_id":id,"operation":id,"reader_id":pay.reader,"amount_cents":pay.amount,"currency":"usd","cancelled":pay.cancelled,
            "payment_intent":pay.intent.map(|status|json!({"id":intent,"livemode":self.live,"status":status,"amount":pay.amount,
                "amount_received":if paid{pay.amount}else{0},"currency":"usd","metadata":{"native_payment_id":id},"latest_charge":charge})),
            "reader":{"status":if world.reader_offline{"offline"}else{"online"}},
            "reader_action":{"status":pay.action,"failure_code":pay.failure,
                "failure_message":pay.failure.map(|_|"Synthetic reader message")}})
    }
}
#[async_trait]
impl Broker for FakeReaders {
    async fn installation(&self, _: &PgPool, _: Uuid, _: Uuid, _: i64) -> Result<Uuid> {
        Ok(self.installation)
    }
    async fn call(
        &self,
        pool: &PgPool,
        binding: &Binding,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let reply = self.reply(pool, binding, method, path, body).await?;
        match reply.status {
            200 => Ok(reply.body),
            404 => Err(Error::NotFound),
            _ => Err(Error::Invalid("payment provider request not confirmed")),
        }
    }
    async fn reply(
        &self,
        _: &PgPool,
        binding: &Binding,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Reply> {
        let mut world = self.state.lock().unwrap();
        if world.unreachable {
            return Err(Error::Invalid("payment provider response unavailable"));
        }
        let account = json!({"account_id":"acct_synthetic","livemode":self.live,"remote_tenant_id":binding.tenant});
        let query = format!(
            "account_id=acct_synthetic&livemode={}&remote_tenant_id={}",
            self.live, binding.tenant
        );
        let ok = |body: Value| Ok(Reply { status: 200, body });
        if path == "/status" {
            return ok(
                json!({"installation_id":self.installation,"remote_tenant_id":binding.tenant,"account_id":"acct_synthetic","livemode":self.live,"checkout_contract_version":1,"hosted_checkout_enabled":!world.hosted_checkout_disabled,"charges_enabled":true,"card_payments_active":true,"details_submitted":true}),
            );
        }
        if let Some(body) = &body {
            // Every write names the bound account, and nothing else about the practice.
            for key in ["account_id", "livemode", "remote_tenant_id"] {
                assert_eq!(body[key], account[key], "{path}");
            }
            world.posted.push(body.clone());
        }
        if let Some(rest) = path.strip_prefix("/terminal/readers") {
            if method == Method::GET {
                assert_eq!(rest, format!("?{query}"));
                return ok(json!({"readers":world.readers,"livemode":self.live}));
            }
            if rest.is_empty() {
                let body = body.unwrap();
                assert_eq!(body.as_object().unwrap().len(), 6);
                let code = body["registration_code"].as_str().unwrap();
                if code == "wrong-code" {
                    return Ok(refusal(400, "registration_code_not_accepted"));
                }
                if code == "no-address" {
                    return Ok(refusal(409, "business_address_missing"));
                }
                assert!(!(self.live && code.starts_with("simulated")));
                let reader = json!({"id":format!("tmr_added{}",world.readers.len()+1),"label":body["label"],"device_type":if code.starts_with("simulated"){"simulated_wisepos_e"}else{"stripe_s700"},"status":"online","last_seen_at":1_700_000_000_000_i64,"action":{"type":null,"status":null}});
                world.readers.push(reader.clone());
                return ok(
                    json!({"request_id":body["request_id"],"reader":reader,"livemode":self.live}),
                );
            }
            let id = rest
                .trim_start_matches('/')
                .split('?')
                .next()
                .unwrap()
                .to_owned();
            let Some(index) = world.readers.iter().position(|reader| reader["id"] == id) else {
                return Ok(refusal(404, "reader_not_found"));
            };
            if method == Method::DELETE {
                assert!(rest.ends_with(&format!("?{query}")));
                if world.readers[index]["action"]["status"] == "in_progress" {
                    return Ok(refusal(409, "reader_busy"));
                }
                world.readers.remove(index);
                return ok(json!({"removed":true,"reader_id":id}));
            }
            let body = body.unwrap();
            assert_eq!(body.as_object().unwrap().len(), 4);
            world.readers[index]["label"] = body["label"].clone();
            return ok(json!({"reader":world.readers[index],"livemode":self.live}));
        }
        if path == "/terminal/payments" {
            let body = body.unwrap();
            assert_eq!(method, Method::POST);
            assert_eq!(
                body.as_object().unwrap().len(),
                8,
                "only the binding, identifiers, amount and reader: {body}"
            );
            assert_eq!(body["currency"], "usd");
            assert_eq!(body["operation"], body["request_id"]);
            let id: Uuid = serde_json::from_value(body["request_id"].clone()).unwrap();
            world.starts += 1;
            if let Some((status, code)) = world.start_refusal {
                return Ok(refusal(status, code));
            }
            let reader = body["reader_id"].as_str().unwrap().to_owned();
            if !world
                .readers
                .iter()
                .any(|known| known["id"] == reader.as_str())
            {
                return Ok(refusal(404, "reader_not_found"));
            }
            if world.payments.get(&id).is_some_and(|pay| pay.cancelled) {
                return Ok(refusal(409, "payment_cancelled"));
            }
            let amount = body["amount_cents"].as_i64().unwrap();
            let pay = world.payments.entry(id).or_insert(Pay {
                amount,
                reader,
                intent: Some("requires_payment_method"),
                action: Some("in_progress"),
                failure: None,
                refunded: 0,
                cancelled: false,
                created: Utc::now().timestamp(),
            });
            assert_eq!(pay.amount, amount);
            let pay = &world.payments[&id];
            return ok(self.envelope(binding, id, pay, &world));
        }
        let rest = path.strip_prefix("/terminal/payments/").unwrap();
        if let Some(id) = rest.strip_suffix("/cancel") {
            let id = Uuid::parse_str(id).unwrap();
            assert_eq!(body, Some(account));
            world.cancels += 1;
            if !world.payments.contains_key(&id) {
                return Ok(refusal(404, "not_found"));
            }
            if world.cancel_busy {
                return Ok(refusal(409, "reader_busy"));
            }
            let pay = world.payments.get_mut(&id).unwrap();
            if pay.intent != Some("succeeded") {
                pay.intent = pay.intent.map(|_| "canceled");
                pay.action = None;
            }
            pay.cancelled = true;
            let pay = &world.payments[&id];
            return ok(self.envelope(binding, id, pay, &world));
        }
        assert_eq!(method, Method::GET);
        world.reads += 1;
        let id = Uuid::parse_str(rest).unwrap();
        match world.payments.get(&id) {
            Some(pay) => ok(self.envelope(binding, id, pay, &world)),
            None => Ok(refusal(404, "not_found")),
        }
    }
}

async fn setup() -> (PgPool, Actor, State) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable database required");
    let schema = format!("reader_payments_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    crate::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |conn, _| {
            let q = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(&q).execute(conn).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    crate::MIGRATOR.run(&pool).await.unwrap();
    let tenant = Uuid::new_v4();
    let mut a = crate::delivery::worker(tenant);
    a.role = Role::Owner;
    let setting = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO payment_settings(tenant_id,id,mode) VALUES($1,$2,'suncharts_connect')",
    )
    .bind(tenant)
    .bind(setting)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO payment_credentials(tenant_id,setting_id,revision,encrypted_config) VALUES($1,$2,1,''::bytea)").bind(tenant).bind(setting).execute(&pool).await.unwrap();
    let state = State {
        backend: Arc::new(crate::postgres::PostgresBackend(pool.clone())),
        browser: Some(
            crate::browser::BrowserAuth::new(pool.clone(), "http://127.0.0.1:8099".into()).unwrap(),
        ),
        secret: "synthetic-readers-only".into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
    };
    (pool, a, state)
}
fn development() -> Policy {
    Policy {
        production: false,
        live_enabled: false,
    }
}
fn production(live_enabled: bool) -> Policy {
    Policy {
        production: true,
        live_enabled,
    }
}

#[tokio::test]
async fn staff_see_the_practice_readers_and_only_the_owner_changes_them() {
    let (pool, owner, state) = setup().await;
    let broker = FakeReaders::with_reader(false);
    let listed = list_with(&state, &owner, &broker, development())
        .await
        .unwrap();
    assert_eq!(
        listed,
        json!({"status":"ready","can_manage":true,"payments_available":true,"practice_code":"simulated-wpe",
            "readers":[{"id":"tmr_frontdesk","name":"Front desk","model":"BBPOS WisePOS E","online":true,"busy":false}]})
    );
    let mut desk = owner.clone();
    desk.role = Role::FrontDesk;
    let listed = list_with(&state, &desk, &broker, development())
        .await
        .unwrap();
    assert_eq!(listed["can_manage"], false);
    assert_eq!(listed["readers"].as_array().unwrap().len(), 1);
    let mut nurse = owner.clone();
    nurse.role = Role::Nurse;
    assert!(matches!(
        list_with(&state, &nurse, &broker, development()).await,
        Err(Error::Forbidden)
    ));
    let add = || Add {
        request_id: Uuid::new_v4(),
        code: " Simulated-WPE ".into(),
        name: " Back office ".into(),
    };
    for staff in [&desk, &nurse] {
        assert!(matches!(
            add_with(&state, staff, add(), &broker, development()).await,
            Err(Error::Forbidden)
        ));
        assert!(matches!(
            rename_with(
                &state,
                staff,
                "tmr_frontdesk",
                Rename { name: "X".into() },
                &broker,
                development()
            )
            .await,
            Err(Error::Forbidden)
        ));
        assert!(matches!(
            remove_with(&state, staff, "tmr_frontdesk", &broker, development()).await,
            Err(Error::Forbidden)
        ));
    }
    assert!(broker.state.lock().unwrap().posted.is_empty());

    let added = add_with(&state, &owner, add(), &broker, development())
        .await
        .unwrap();
    assert_eq!(
        added,
        json!({"reader":{"id":"tmr_added2","name":"Back office","model":"BBPOS WisePOS E","online":true,"busy":false}})
    );
    {
        let world = broker.state.lock().unwrap();
        assert_eq!(world.posted[0]["registration_code"], "simulated-wpe");
        assert_eq!(world.posted[0]["label"], "Back office");
    }
    for (code, name) in [
        ("", "Front"),
        ("bad code!", "Front"),
        ("simulated-wpe", ""),
        ("wrong-code", "Front"),
        ("no-address", "Front"),
    ] {
        let result = add_with(
            &state,
            &owner,
            Add {
                request_id: Uuid::new_v4(),
                code: code.into(),
                name: name.into(),
            },
            &broker,
            development(),
        )
        .await;
        assert!(
            matches!(result, Err(Error::Invalid(_) | Error::Conflict(_))),
            "{code:?} {name:?}"
        );
    }
    let renamed = rename_with(
        &state,
        &owner,
        "tmr_added2",
        Rename {
            name: "Billing office".into(),
        },
        &broker,
        development(),
    )
    .await
    .unwrap();
    assert_eq!(renamed["reader"]["name"], "Billing office");
    for unknown in ["tmr_other", "not-a-reader"] {
        assert!(matches!(
            remove_with(&state, &owner, unknown, &broker, development()).await,
            Err(Error::NotFound)
        ));
    }
    broker.state.lock().unwrap().readers[0]["action"] =
        json!({"type":"process_payment_intent","status":"in_progress"});
    assert!(matches!(
        remove_with(&state, &owner, "tmr_frontdesk", &broker, development()).await,
        Err(Error::Conflict(_))
    ));
    let removed = remove_with(&state, &owner, "tmr_added2", &broker, development())
        .await
        .unwrap();
    assert_eq!(removed, json!({"removed":true}));
    assert_eq!(broker.state.lock().unwrap().readers.len(), 1);
    let audited: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_events WHERE action LIKE 'payment.reader_%' ORDER BY created_at,action",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        audited,
        [
            "payment.reader_added",
            "payment.reader_renamed",
            "payment.reader_removed"
        ]
    );
}

#[tokio::test]
async fn the_practice_reader_code_never_appears_or_works_in_production_or_on_a_live_account() {
    let (pool, owner, state) = setup().await;
    let simulated = || Add {
        request_id: Uuid::new_v4(),
        code: "simulated-wpe".into(),
        name: "Front desk".into(),
    };
    // A production practice is never offered, and can never use, a test account's readers.
    let test_account = FakeReaders::with_reader(false);
    for policy in [production(false), production(true)] {
        let listed = list_with(&state, &owner, &test_account, policy)
            .await
            .unwrap();
        assert_eq!(
            listed,
            json!({"status":"unavailable","readers":[],"can_manage":true})
        );
        assert!(add_with(&state, &owner, simulated(), &test_account, policy)
            .await
            .is_err());
    }
    // A live account: real readers only, in production and in a development preview alike.
    let live_account = FakeReaders::with_reader(true);
    for (policy, payments) in [
        (production(true), true),
        (production(false), false),
        (
            Policy {
                production: false,
                live_enabled: true,
            },
            true,
        ),
    ] {
        let listed = list_with(&state, &owner, &live_account, policy)
            .await
            .unwrap();
        assert_eq!(listed["status"], "ready");
        assert_eq!(listed["payments_available"], payments);
        assert!(listed.get("practice_code").is_none());
        assert!(matches!(
            add_with(&state, &owner, simulated(), &live_account, policy).await,
            Err(Error::Invalid(_))
        ));
    }
    assert!(test_account.state.lock().unwrap().posted.is_empty());
    assert!(live_account.state.lock().unwrap().posted.is_empty());
    let real = add_with(
        &state,
        &owner,
        Add {
            request_id: Uuid::new_v4(),
            code: "sepia-cerulean-aqua".into(),
            name: "Front desk".into(),
        },
        &live_account,
        production(false),
    )
    .await
    .unwrap();
    assert_eq!(real["reader"]["model"], "Stripe Reader S700");

    // Without a connected payment account there is nothing to list or add.
    sqlx::query("UPDATE payment_settings SET mode='own_stripe'")
        .execute(&pool)
        .await
        .unwrap();
    let listed = list_with(&state, &owner, &test_account, development())
        .await
        .unwrap();
    assert_eq!(
        listed,
        json!({"status":"not_connected","readers":[],"can_manage":true})
    );
    assert!(matches!(
        add_with(&state, &owner, simulated(), &test_account, development()).await,
        Err(Error::Conflict(_))
    ));
}
