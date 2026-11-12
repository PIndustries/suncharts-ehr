// SPDX-License-Identifier: AGPL-3.0-only
//! Verified patient-scoped processor views and explicitly consented card setup.
//! Setup evidence never posts a payment or changes an invoice/clinical record.
use super::*;
use async_trait::async_trait;
use axum::{
    extract::{FromRequestParts, Query},
    response::{IntoResponse, Response},
};
use std::collections::HashSet;
#[path = "patient_memberships.rs"]
pub(super) mod memberships;
#[path = "patient_payment_profile_setup.rs"]
pub(super) mod setup;

#[async_trait]
trait Source: Sync {
    async fn config(&self, pool: &PgPool, tenant: Uuid, setting: &Settings) -> Result<Credentials>;
    async fn request(
        &self,
        config: &Credentials,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value>;
}
struct HttpSource;
#[async_trait]
impl Source for HttpSource {
    async fn config(&self, pool: &PgPool, tenant: Uuid, setting: &Settings) -> Result<Credentials> {
        credentials(pool, tenant, setting.id, setting.credential_revision).await
    }
    async fn request(
        &self,
        config: &Credentials,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        if config.mode != "suncharts_connect" {
            return Err(invalid());
        }
        let installation = config.installation_id.ok_or_else(invalid)?;
        let token = config.broker_token.as_deref().ok_or_else(invalid)?;
        let url = format!(
            "{}/api/v1/payments/connect/installations/{installation}{path}",
            broker_base()?
        );
        let mut call = crate::stedi::client()?
            .request(method.clone(), url)
            .bearer_auth(token);
        if let Some(body) = body {
            call = call.json(&body);
        }
        let reply = call.send().await.map_err(|_| {
            Error::Invalid(
                "Patient payment request is uncertain. Keep this request and refresh its status.",
            )
        })?;
        if reply.status() == reqwest::StatusCode::NOT_FOUND && method == Method::GET {
            return Err(Error::NotFound);
        }
        if !reply.status().is_success() {
            if reply.status().is_client_error() && method == Method::POST {
                return Err(Error::Conflict(
                    "The payment service declined this setup request. Refresh its status before further action.",
                ));
            }
            return Err(Error::Invalid(
                "Patient payment service is unavailable. No patient balance was changed.",
            ));
        }
        serde_json::from_slice(&crate::stedi::bytes(reply, 262144).await?).map_err(|_| invalid())
    }
}
fn invalid() -> Error {
    Error::Invalid(
        "Patient payment response could not be verified. Refresh the connection before continuing.",
    )
}
fn identifier(v: &Value, prefix: &str) -> Result<String> {
    v.as_str()
        .filter(|s| s.len() > prefix.len() && ident(s, prefix))
        .map(str::to_owned)
        .ok_or_else(invalid)
}
fn text_field(v: &Value, key: &str, max: usize) -> Result<String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(invalid)
}
fn number(v: &Value, key: &str, min: i64, max: i64) -> Result<i64> {
    v[key]
        .as_i64()
        .filter(|n| (*n >= min) && (*n <= max))
        .ok_or_else(invalid)
}
fn optional_number(v: &Value, key: &str, min: i64, max: i64) -> Result<Value> {
    if v[key].is_null() {
        Ok(Value::Null)
    } else {
        Ok(json!(number(v, key, min, max)?))
    }
}
fn choice_field(v: &Value, key: &str, choices: &[&str]) -> Result<String> {
    let value = text_field(v, key, 40)?;
    if choices.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(invalid())
    }
}
fn currency(v: &Value) -> Result<String> {
    let value = text_field(v, "currency", 3)?;
    if value.len() == 3 && value.bytes().all(|b| b.is_ascii_lowercase()) {
        Ok(value)
    } else {
        Err(invalid())
    }
}
const MAX_AMOUNT: i64 = 9_007_199_254_740_991;
const MAX_TIME: i64 = 7_258_118_400;
fn clean_item(v: &Value, kind: &str) -> Result<Value> {
    let prefix = match kind {
        "payment_methods" => "pm_",
        "invoices" => "in_",
        _ => "sub_",
    };
    let mut out = json!({"id":identifier(&v["id"],prefix)?});
    if kind == "payment_methods" {
        let last4 = text_field(v, "last4", 4)?;
        if last4.len() != 4 || !last4.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid());
        }
        out["brand"] = json!(text_field(v, "brand", 30)?);
        out["last4"] = json!(last4);
        out["exp_month"] = json!(number(v, "exp_month", 1, 12)?);
        out["exp_year"] = json!(number(v, "exp_year", 2000, 2200)?);
        out["allow_redisplay"] = json!(choice_field(
            v,
            "allow_redisplay",
            &["always", "limited", "unspecified"]
        )?);
    } else {
        out["currency"] = json!(currency(v)?);
        out["created"] = json!(number(v, "created", 0, MAX_TIME)?);
        if kind == "invoices" {
            out["status"] = json!(choice_field(
                v,
                "status",
                &["draft", "open", "paid", "uncollectible", "void"]
            )?);
            for key in ["total", "amount_due", "amount_paid", "amount_remaining"] {
                out[key] = json!(number(
                    v,
                    key,
                    if key == "total" { -MAX_AMOUNT } else { 0 },
                    MAX_AMOUNT
                )?);
            }
            out["due_date"] = optional_number(v, "due_date", 0, MAX_TIME)?;
        } else {
            out["status"] = json!(choice_field(
                v,
                "status",
                &[
                    "incomplete",
                    "incomplete_expired",
                    "trialing",
                    "active",
                    "past_due",
                    "canceled",
                    "unpaid",
                    "paused"
                ]
            )?);
            out["cancel_at_period_end"] =
                json!(v["cancel_at_period_end"].as_bool().ok_or_else(invalid)?);
            let lines = v["items"]
                .as_array()
                .filter(|a| a.len() <= 100)
                .ok_or_else(invalid)?;
            let mut items = Vec::new();
            let mut seen = HashSet::new();
            for line in lines {
                let id = identifier(&line["id"], "si_")?;
                if !seen.insert(id.clone()) {
                    return Err(invalid());
                }
                let interval = if line["interval"].is_null() {
                    Value::Null
                } else {
                    json!(choice_field(
                        line,
                        "interval",
                        &["day", "week", "month", "year"]
                    )?)
                };
                items.push(json!({"id":id,"quantity":optional_number(line,"quantity",0,MAX_AMOUNT)?,"unit_amount":optional_number(line,"unit_amount",0,MAX_AMOUNT)?,"interval":interval,"interval_count":optional_number(line,"interval_count",1,1000)?,"current_period_start":optional_number(line,"current_period_start",0,MAX_TIME)?,"current_period_end":optional_number(line,"current_period_end",0,MAX_TIME)?}));
            }
            out["items"] = json!(items);
        }
    }
    Ok(out)
}
fn clean_section(v: &Value, kind: &str) -> Result<Value> {
    let status = choice_field(v, "status", &["not_created", "unavailable", "available"])?;
    if status != "available" {
        if !v["data"].is_null() {
            return Err(invalid());
        }
        return Ok(json!({"status":status,"data":null}));
    }
    let data = &v["data"];
    let rows = data["items"]
        .as_array()
        .filter(|r| r.len() <= 20)
        .ok_or_else(invalid)?;
    let more = data["has_more"].as_bool().ok_or_else(invalid)?;
    if more && rows.is_empty() {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for row in rows {
        let item = clean_item(row, kind)?;
        if !seen.insert(item["id"].as_str().unwrap().to_owned()) {
            return Err(invalid());
        }
        items.push(item);
    }
    let next = if more {
        items.last().unwrap()["id"].clone()
    } else {
        Value::Null
    };
    if data["next_cursor"] != next {
        return Err(invalid());
    }
    Ok(json!({"status":status,"data":{"items":items,"has_more":more,"next_cursor":next}}))
}
struct Context {
    setting: Settings,
    config: Credentials,
    installation: Uuid,
    account: String,
    live: bool,
    patient: Uuid,
    archived: bool,
}
async fn context(a: &Actor, s: &State, patient: Uuid, source: &dyn Source) -> Result<Context> {
    a.staff()?;
    crate::access_policies::require_native(s, a, "billing", "view").await?;
    let pool = db(s)?;
    let mut tx = pool.begin().await?;
    let archived:bool=sqlx::query_scalar("SELECT coalesce((SELECT e.archived FROM patient_lifecycle_events e WHERE e.tenant_id=p.tenant_id AND e.patient_id=p.id ORDER BY e.version DESC LIMIT 1),false) FROM patients p WHERE p.tenant_id=$1 AND p.id=$2").bind(a.tenant_id).bind(patient).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let setting = setting(&mut tx, a.tenant_id).await?;
    tx.commit().await?;
    if setting.mode != "suncharts_connect" {
        return Err(Error::Conflict(
            "Connect the practice payment account before opening patient payment methods.",
        ));
    }
    let config = source.config(pool, a.tenant_id, &setting).await?;
    let status = source
        .request(&config, Method::GET, "/status", None)
        .await?;
    let status = bound_connect_status(&config, a.tenant_id, &status).ok_or_else(invalid)?;
    let account = identifier(&status["account_id"], "acct_")?;
    let live = status["livemode"].as_bool().ok_or_else(invalid)?;
    if setting
        .provider_account_id
        .as_ref()
        .is_some_and(|id| *id != account)
    {
        return Err(invalid());
    }
    let installation = config.installation_id.ok_or_else(invalid)?;
    Ok(Context {
        setting,
        config,
        installation,
        account,
        live,
        patient,
        archived,
    })
}
impl Context {
    fn query(&self, tenant: Uuid) -> url::form_urlencoded::Serializer<'static, String> {
        let mut q = url::form_urlencoded::Serializer::new(String::new());
        q.append_pair("account_id", &self.account)
            .append_pair("livemode", if self.live { "true" } else { "false" })
            .append_pair("remote_tenant_id", &tenant.to_string());
        q
    }
    fn envelope(&self, tenant: Uuid, v: &Value) -> Result<Value> {
        let checked: DateTime<Utc> =
            serde_json::from_value(v["checked_at"].clone()).map_err(|_| invalid())?;
        if v["contract_version"] != 1
            || v["installation_id"] != self.installation.to_string()
            || v["remote_tenant_id"] != tenant.to_string()
            || v["patient_id"] != self.patient.to_string()
            || v["account_id"] != self.account
            || v["livemode"] != self.live
            || (Utc::now() - checked).num_seconds().unsigned_abs() > 300
        {
            return Err(invalid());
        }
        Ok(
            json!({"contract_version":1,"installation_id":self.installation,"remote_tenant_id":tenant,"patient_id":self.patient,"account_id":self.account,"livemode":self.live,"checked_at":checked}),
        )
    }
    async fn unchanged(&self, tx: &mut Transaction<'_, Postgres>, a: &Actor) -> Result<()> {
        let current = setting(tx, a.tenant_id).await?;
        if current.id != self.setting.id
            || current.version != self.setting.version
            || current.credential_revision != self.setting.credential_revision
            || current.mode != self.setting.mode
            || current.provider_account_id != self.setting.provider_account_id
        {
            return Err(Error::Conflict(
                "Payment account changed. Refresh before continuing.",
            ));
        }
        Ok(())
    }
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(super) struct ProfileQuery {
    methods_after: Option<String>,
    invoices_after: Option<String>,
    subscriptions_after: Option<String>,
}
async fn fresh_actor(
    a: &Actor,
    s: &State,
    h: &HeaderMap,
    method: Method,
    path: &str,
    action: &str,
) -> Result<Actor> {
    let mut parts = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .body(())
        .map_err(|_| invalid())?
        .into_parts()
        .0;
    parts.headers = h.clone();
    let current = Actor::from_request_parts(&mut parts, s).await?;
    if current.sub != a.sub || current.tenant_id != a.tenant_id {
        return Err(Error::Unauthorized);
    }
    current.staff()?;
    if action == "create" {
        current.scheduling()?;
    }
    crate::access_policies::require_native(s, &current, "billing", action).await?;
    Ok(current)
}
fn response(value: Value) -> Response {
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(value),
    )
        .into_response()
}
pub(super) async fn read(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(patient): Path<Uuid>,
    Query(q): Query<ProfileQuery>,
    h: HeaderMap,
) -> Result<Response> {
    read_with(a, s, patient, q, h, &HttpSource).await
}
async fn read_with(
    a: Actor,
    s: State,
    patient: Uuid,
    q: ProfileQuery,
    h: HeaderMap,
    source: &dyn Source,
) -> Result<Response> {
    let c = context(&a, &s, patient, source).await?;
    let query = {
        let mut query = c.query(a.tenant_id);
        for (key, value, prefix) in [
            ("methods_after", q.methods_after, "pm_"),
            ("invoices_after", q.invoices_after, "in_"),
            ("subscriptions_after", q.subscriptions_after, "sub_"),
        ] {
            if let Some(value) = value {
                identifier(&json!(value), prefix)?;
                query.append_pair(key, &value);
            }
        }
        query.finish()
    };
    let raw = source
        .request(
            &c.config,
            Method::GET,
            &format!("/patient-billing/{patient}?{query}"),
            None,
        )
        .await?;
    let mut out = c.envelope(a.tenant_id, &raw)?;
    let status = choice_field(
        &raw["customer"],
        "status",
        &["not_created", "creating", "available"],
    )?;
    let customer = if raw["customer"]["id"].is_null() {
        Value::Null
    } else {
        json!(identifier(&raw["customer"]["id"], "cus_")?)
    };
    if (status == "available") != customer.is_string() {
        return Err(invalid());
    }
    out["customer"] = json!({"status":status,"id":customer});
    for kind in ["payment_methods", "invoices", "subscriptions"] {
        out[kind] = clean_section(&raw[kind], kind)?;
    }
    let current = fresh_actor(
        &a,
        &s,
        &h,
        Method::GET,
        &format!("/api/v1/billing/patients/{patient}/payment-profile"),
        "view",
    )
    .await?;
    out["setup_available"] = json!(
        raw["setup_available"].as_bool().ok_or_else(invalid)?
            && !c.archived
            && current.scheduling().is_ok()
            && crate::access_policies::require_native(&s, &current, "billing", "create")
                .await
                .is_ok()
    );
    let mut tx = db(&s)?.begin().await?;
    c.unchanged(&mut tx, &a).await?;
    let active:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('request_id',request_id,'status',status) FROM patient_payment_setups WHERE tenant_id=$1 AND patient_id=$2 AND status IN ('creating','open','pending','needs_review') ORDER BY created_at DESC LIMIT 1").bind(a.tenant_id).bind(patient).fetch_optional(&mut *tx).await?;
    out["active_setup"] = json!(active);
    crate::postgres::audit(&mut tx, &a, "payment.patient_profile_read", patient).await?;
    tx.commit().await?;
    Ok(response(out))
}
