// SPDX-License-Identifier: AGPL-3.0-only
// A synthetic SunCharts Connect for saved-card charges and card links. It answers with the
// same envelopes the real broker returns; a test chooses what the bank says next.
use super::*;
use async_trait::async_trait;
use std::{collections::BTreeMap, sync::Mutex};

pub(crate) struct Charge {
    pub(crate) patient: Uuid,
    pub(crate) setup: Value,
    pub(crate) amount: i64,
    /// "succeeded", "processing", "card_declined" or "authentication_required".
    pub(crate) outcome: &'static str,
    pub(crate) refunded: i64,
    pub(crate) created: i64,
}
pub(crate) struct Link {
    pub(crate) amount: i64,
    /// "open", "paid" or "expired".
    pub(crate) state: &'static str,
    pub(crate) created: i64,
}
pub(crate) struct Bank {
    pub(crate) charges: BTreeMap<Uuid, Charge>,
    pub(crate) links: BTreeMap<Uuid, Link>,
    /// Every body sent to the broker, with its path.
    pub(crate) posted: Vec<(String, Value)>,
    /// What the bank answers to the next new charge.
    pub(crate) answer: &'static str,
    /// The broker refuses the next charges before creating anything.
    pub(crate) refusal: Option<(u16, &'static str)>,
    /// The charge happens but its answer is lost on the way back, once.
    pub(crate) lose_answer: bool,
    /// The card link request never reaches the broker.
    pub(crate) lose_links: bool,
    /// The patient pays in the same moment staff cancel the link.
    pub(crate) pay_on_expire: bool,
    pub(crate) expires: usize,
}
pub(crate) struct FakeCards {
    pub(crate) installation: Uuid,
    pub(crate) live: bool,
    pub(crate) state: Mutex<Bank>,
}
impl FakeCards {
    pub(crate) fn new(live: bool) -> Self {
        Self {
            installation: Uuid::new_v4(),
            live,
            state: Mutex::new(Bank {
                charges: BTreeMap::new(),
                links: BTreeMap::new(),
                posted: Vec::new(),
                answer: "succeeded",
                refusal: None,
                lose_answer: false,
                lose_links: false,
                pay_on_expire: false,
                expires: 0,
            }),
        }
    }
    pub(crate) fn answer(&self, answer: &'static str) {
        self.state.lock().unwrap().answer = answer;
    }
    /// How many charges the bank was actually asked to make.
    pub(crate) fn charges(&self) -> usize {
        self.state.lock().unwrap().charges.len()
    }
    pub(crate) fn sent(&self, path_end: &str) -> Vec<Value> {
        self.state
            .lock()
            .unwrap()
            .posted
            .iter()
            .filter(|(path, _)| path.ends_with(path_end))
            .map(|(_, body)| body.clone())
            .collect()
    }
    fn base(&self, binding: &Binding, id: Uuid) -> Value {
        json!({"contract_version":1,"installation_id":self.installation,"remote_tenant_id":binding.tenant,
            "account_id":"acct_synthetic","livemode":self.live,"request_id":id})
    }
    fn intent(&self, id: Uuid, amount: i64, status: &str, refunded: i64, created: i64) -> Value {
        let intent = format!("pi_{}", id.simple());
        let paid = status == "succeeded";
        let charge = if status == "processing" {
            Value::Null
        } else {
            json!({"id":format!("ch_{}",id.simple()),"livemode":self.live,"amount":amount,"amount_refunded":refunded,
                "paid":paid,"captured":paid,"disputed":false,"created":created,"currency":"usd","payment_intent":intent})
        };
        json!({"id":intent,"livemode":self.live,"status":status,"amount":amount,
            "amount_received":if paid{amount}else{0},"currency":"usd","metadata":{"native_payment_id":id},"latest_charge":charge})
    }
    fn charge(&self, binding: &Binding, id: Uuid, charge: &Charge) -> Value {
        let failed = ["card_declined", "authentication_required"].contains(&charge.outcome);
        let mut out = self.base(binding, id);
        out["patient_id"] = json!(charge.patient);
        out["setup_request_id"] = charge.setup.clone();
        out["amount_cents"] = json!(charge.amount);
        out["currency"] = json!("usd");
        out["cancelled"] = json!(failed);
        out["outcome"] = json!(charge.outcome);
        out["payment_intent"] = self.intent(
            id,
            charge.amount,
            if failed { "canceled" } else { charge.outcome },
            charge.refunded,
            charge.created,
        );
        out
    }
    fn link(&self, binding: &Binding, id: Uuid, link: &Link) -> Value {
        let session = format!(
            "cs_{}_{}",
            if self.live { "live" } else { "test" },
            id.simple()
        );
        let paid = link.state == "paid";
        let mut out = self.base(binding, id);
        out["cancelled"] = json!(link.state == "expired");
        out["recovery_required"] = json!(false);
        out["session"] = json!({"id":session,"mode":"payment","livemode":self.live,"amount_total":link.amount,"currency":"usd",
            "client_reference_id":id,"metadata":{"native_payment_id":id},
            "status":match link.state{"paid"=>"complete","expired"=>"expired",_=>"open"},
            "payment_status":if paid{"paid"}else{"unpaid"},
            "url":if link.state=="open"{json!(format!("https://checkout.stripe.com/c/pay/{session}"))}else{Value::Null},
            "payment_intent":if paid{self.intent(id,link.amount,"succeeded",0,link.created)}else{Value::Null}});
        out
    }
}
fn refusal(status: u16, code: &str) -> Reply {
    Reply {
        status,
        body: json!({"error":code,"message":"synthetic"}),
    }
}
#[async_trait]
impl Broker for FakeCards {
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
        let mut bank = self.state.lock().unwrap();
        let ok = |body: Value| Ok(Reply { status: 200, body });
        let missing = || {
            Ok(Reply {
                status: 404,
                body: Value::Null,
            })
        };
        if path == "/status" {
            return ok(
                json!({"installation_id":self.installation,"remote_tenant_id":binding.tenant,"account_id":"acct_synthetic","livemode":self.live,"checkout_contract_version":1,"hosted_checkout_enabled":true,"charges_enabled":true,"card_payments_active":true,"details_submitted":true}),
            );
        }
        if let Some(body) = &body {
            assert_eq!(body["account_id"], "acct_synthetic", "{path}");
            assert_eq!(body["livemode"], self.live, "{path}");
            bank.posted.push((path.to_owned(), body.clone()));
        }
        if let Some(rest) = path.strip_prefix("/patient-billing/") {
            let (patient, rest) = rest.split_once("/saved-card-payments").unwrap();
            let patient = Uuid::parse_str(patient).unwrap();
            if method == Method::GET {
                let id = rest.trim_start_matches('/').split('?').next().unwrap();
                assert!(
                    rest.ends_with(&format!(
                        "?account_id=acct_synthetic&livemode={}&remote_tenant_id={}",
                        self.live, binding.tenant
                    )),
                    "{rest}"
                );
                let id = Uuid::parse_str(id).unwrap();
                return match bank.charges.get(&id) {
                    Some(charge) if charge.patient == patient => {
                        ok(self.charge(binding, id, charge))
                    }
                    _ => missing(),
                };
            }
            assert!(rest.is_empty(), "{rest}");
            let body = body.unwrap();
            // Nothing but the amount and opaque identifiers leaves the EHR.
            assert_eq!(body.as_object().unwrap().len(), 7, "{body}");
            assert_eq!(body["remote_tenant_id"], json!(binding.tenant));
            assert_eq!(body["currency"], "usd");
            if let Some((status, code)) = bank.refusal {
                return Ok(refusal(status, code));
            }
            let id: Uuid = serde_json::from_value(body["request_id"].clone()).unwrap();
            if !bank.charges.contains_key(&id) {
                let charge = Charge {
                    patient,
                    setup: body["setup_request_id"].clone(),
                    amount: body["amount_cents"].as_i64().unwrap(),
                    outcome: bank.answer,
                    refunded: 0,
                    created: Utc::now().timestamp(),
                };
                bank.charges.insert(id, charge);
                if bank.lose_answer {
                    bank.lose_answer = false;
                    return Err(Error::Invalid("synthetic lost response"));
                }
            }
            // A repeat of the same request never charges again: it reports what happened.
            let charge = &bank.charges[&id];
            assert_eq!(charge.amount, body["amount_cents"]);
            return ok(self.charge(binding, id, charge));
        }
        if path == "/hosted-checkouts" {
            if bank.lose_links {
                return Err(Error::Invalid("synthetic lost request"));
            }
            let body = body.unwrap();
            let id: Uuid = serde_json::from_value(body["request_id"].clone()).unwrap();
            let amount = body["amount_cents"].as_i64().unwrap();
            let link = bank.links.entry(id).or_insert(Link {
                amount,
                state: "open",
                created: Utc::now().timestamp(),
            });
            let value = self.link(binding, id, link);
            return ok(value);
        }
        if let Some(rest) = path.strip_prefix("/hosted-checkout-requests/") {
            let (id, expire) = match rest.strip_suffix("/expire") {
                Some(id) => (id, true),
                None => (rest, false),
            };
            let id = Uuid::parse_str(id).unwrap();
            if expire {
                assert_eq!(method, Method::POST);
                assert_eq!(body.unwrap().as_object().unwrap().len(), 2);
                bank.expires += 1;
                let pay = bank.pay_on_expire;
                let Some(link) = bank.links.get_mut(&id) else {
                    return missing();
                };
                if link.state == "open" {
                    link.state = if pay { "paid" } else { "expired" };
                }
            }
            return match bank.links.get(&id) {
                Some(link) => ok(self.link(binding, id, link)),
                None => missing(),
            };
        }
        let session = path.strip_prefix("/hosted-checkouts/").unwrap();
        match bank
            .links
            .iter()
            .find(|(id, _)| session.ends_with(&id.simple().to_string()))
        {
            Some((id, link)) => ok(self.link(binding, *id, link)),
            None => missing(),
        }
    }
}

/// A card on file for `patient`, saved under `scope` on the payment account the fake stands for.
pub(crate) async fn saved_card(
    pool: &PgPool,
    a: &Actor,
    patient: Uuid,
    broker: &FakeCards,
    scope: &str,
) -> Uuid {
    let request = Uuid::new_v4();
    let setting: Uuid = sqlx::query_scalar("SELECT id FROM payment_settings WHERE tenant_id=$1")
        .bind(a.tenant_id)
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO patient_payment_setups(tenant_id,request_id,patient_id,setting_id,credential_revision,installation_id,provider_account_id,livemode,return_url,requested_by,consent_scope,consent_version,consent_recorded_at,status,provider_evidence) VALUES($1,$2,$3,$4,1,$5,'acct_synthetic',$6,'https://synthetic.example/?payment_setup=x',$7,$8,$9,$10,'succeeded',$11)")
        .bind(a.tenant_id)
        .bind(request)
        .bind(patient)
        .bind(setting)
        .bind(broker.installation)
        .bind(broker.live)
        .bind(a.sub)
        .bind(scope)
        .bind((scope == CONSENT_SCOPE).then_some(CONSENT_VERSION))
        .bind((scope == CONSENT_SCOPE).then(Utc::now))
        .bind(json!({"session":{"id":"cs_test_saved","status":"complete","payment_method_id":format!("pm_{}",request.simple())}}))
        .execute(pool)
        .await
        .unwrap();
    request
}

#[test]
fn consent_wording_fits_the_card_page_and_names_no_one() {
    // Stripe shows up to 1200 characters of custom text above the Save button.
    assert!(CONSENT_WORDING.len() < 1200);
    assert!(CONSENT_WORDING.contains("charge it later"));
    assert!(CONSENT_VERSION
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_'));
}
