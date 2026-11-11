// SPDX-License-Identifier: AGPL-3.0-only
use super::*;

#[derive(sqlx::FromRow)]
struct Setup {
    request_id: Uuid,
    patient_id: Uuid,
    setting_id: Uuid,
    credential_revision: i64,
    installation_id: Uuid,
    provider_account_id: String,
    livemode: bool,
    return_url: String,
    requested_by: Uuid,
    status: String,
    provider_evidence: Option<Value>,
    created_at: DateTime<Utc>,
}
impl Setup {
    fn check(&self, c: &Context) -> Result<()> {
        if self.patient_id != c.patient
            || self.setting_id != c.setting.id
            || self.credential_revision != c.setting.credential_revision
            || self.installation_id != c.installation
            || self.provider_account_id != c.account
            || self.livemode != c.live
        {
            return Err(Error::Conflict("This card setup belongs to an earlier payment connection. Keep the request for review."));
        }
        Ok(())
    }
    fn terminal(&self) -> bool {
        matches!(self.status.as_str(), "succeeded" | "expired")
    }
}
async fn load(tx: &mut Transaction<'_, Postgres>, tenant: Uuid, request: Uuid) -> Result<Setup> {
    sqlx::query_as(
        "SELECT * FROM patient_payment_setups WHERE tenant_id=$1 AND request_id=$2 FOR UPDATE",
    )
    .bind(tenant)
    .bind(request)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::NotFound)
}
fn clean_setup(c: &Context, tenant: Uuid, op: &Setup, raw: &Value) -> Result<Value> {
    let mut out = c.envelope(tenant, raw)?;
    if raw["request_id"] != op.request_id.to_string() {
        return Err(invalid());
    }
    let status = choice_field(
        raw,
        "status",
        &[
            "creating",
            "open",
            "pending",
            "succeeded",
            "expired",
            "needs_review",
        ],
    )?;
    let customer = if raw["customer_id"].is_null() {
        Value::Null
    } else {
        json!(identifier(&raw["customer_id"], "cus_")?)
    };
    let deadline: DateTime<Utc> =
        serde_json::from_value(raw["retry_safe_until"].clone()).map_err(|_| invalid())?;
    // Broker reservation may be later, or an older customer reservation may shorten its window.
    if deadline > Utc::now() + chrono::Duration::hours(24) {
        return Err(invalid());
    }
    let deadline = deadline.min(op.created_at + chrono::Duration::hours(23));
    let recovery = raw["recovery_required"].as_bool().ok_or_else(invalid)?;
    let session = if raw["session"].is_null() {
        if !matches!(status.as_str(), "creating" | "needs_review") {
            return Err(invalid());
        }
        Value::Null
    } else {
        if customer.is_null() {
            return Err(invalid());
        }
        let v = &raw["session"];
        let id = identifier(&v["id"], if c.live { "cs_live_" } else { "cs_test_" })?;
        let session_status = choice_field(v, "status", &["open", "complete", "expired"])?;
        let url = if session_status == "open" {
            let text = v["url"].as_str().ok_or_else(invalid)?;
            let url = url::Url::parse(text).map_err(|_| invalid())?;
            if text.len() > 4096
                || url.scheme() != "https"
                || url.host_str() != Some("checkout.stripe.com")
                || url.port().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(invalid());
            }
            json!(text)
        } else {
            if !v["url"].is_null() {
                return Err(invalid());
            }
            Value::Null
        };
        let intent = if v["setup_intent_id"].is_null() {
            Value::Null
        } else {
            json!(identifier(&v["setup_intent_id"], "seti_")?)
        };
        let intent_status = if v["setup_intent_status"].is_null() {
            Value::Null
        } else {
            json!(choice_field(
                v,
                "setup_intent_status",
                &[
                    "requires_payment_method",
                    "requires_confirmation",
                    "requires_action",
                    "processing",
                    "canceled",
                    "succeeded"
                ]
            )?)
        };
        let pm = if v["payment_method_id"].is_null() {
            Value::Null
        } else {
            json!(identifier(&v["payment_method_id"], "pm_")?)
        };
        if intent.is_null() != intent_status.is_null()
            || (!pm.is_null() && intent_status != "succeeded")
            || (intent_status == "succeeded" && pm.is_null())
        {
            return Err(invalid());
        }
        let expected = match session_status.as_str() {
            "open" => "open",
            "expired" => "expired",
            _ => {
                if intent.is_null() {
                    return Err(invalid());
                }
                if intent_status == "succeeded" {
                    "succeeded"
                } else {
                    "pending"
                }
            }
        };
        if status != expected || recovery {
            return Err(invalid());
        }
        json!({"id":id,"url":url,"status":session_status,"setup_intent_id":intent,"setup_intent_status":intent_status,"payment_method_id":pm})
    };
    if session.is_null() && recovery != (status == "needs_review") {
        return Err(invalid());
    }
    if let Some(old) = &op.provider_evidence {
        if !old["customer_id"].is_null() && old["customer_id"] != customer {
            return Err(invalid());
        }
        if !old["session"]["id"].is_null() && old["session"]["id"] != session["id"] {
            return Err(invalid());
        }
        if op.terminal() && op.status != status {
            return Err(invalid());
        }
    }
    out["request_id"] = json!(op.request_id);
    out["customer_id"] = customer;
    out["status"] = json!(status);
    out["session"] = session;
    out["retry_safe_until"] = json!(deadline);
    out["recovery_required"] = json!(recovery);
    Ok(out)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::payments) struct Input {
    request_id: Uuid,
    consent: bool,
}

pub(in crate::payments) async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(patient): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Input>,
) -> Result<Response> {
    create_with(a, s, patient, h, v, &HttpSource).await
}
async fn create_with(
    a: Actor,
    s: State,
    patient: Uuid,
    h: HeaderMap,
    v: Input,
    source: &dyn Source,
) -> Result<Response> {
    a.scheduling()?;
    crate::access_policies::require_native(&s, &a, "billing", "create").await?;
    if v.request_id.is_nil() || !v.consent {
        return Err(Error::Invalid(
            "Explicit patient permission to save a card is required.",
        ));
    }
    let c = context(&a, &s, patient, source).await?;
    let path = format!("/api/v1/billing/patients/{patient}/payment-setups");
    fresh_actor(&a, &s, &h, Method::POST, &path, "create").await?;
    let return_url = format!(
        "{}/?payment_setup={}",
        origin(&s)?.trim_end_matches('/'),
        v.request_id
    );
    let mut tx = db(&s)?.begin().await?;
    c.unchanged(&mut tx, &a).await?;
    let prior: Option<Setup> = sqlx::query_as(
        "SELECT * FROM patient_payment_setups WHERE tenant_id=$1 AND request_id=$2 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    let op = if let Some(op) = prior {
        op.check(&c)?;
        if op.return_url != return_url || op.requested_by != a.sub {
            return Err(Error::Conflict(
                "Card setup request was already reserved with different consent.",
            ));
        }
        if op.terminal() {
            tx.commit().await?;
            return Ok(response(op.provider_evidence.ok_or_else(invalid)?));
        }
        if Utc::now() >= op.created_at + chrono::Duration::hours(23) {
            return Err(Error::Conflict(
                "Card setup needs review. Refresh this request; do not create a replacement.",
            ));
        }
        op
    } else {
        let archived:bool=sqlx::query_scalar("SELECT coalesce((SELECT e.archived FROM patient_lifecycle_events e WHERE e.tenant_id=p.tenant_id AND e.patient_id=p.id ORDER BY e.version DESC LIMIT 1),false) FROM patients p WHERE p.tenant_id=$1 AND p.id=$2 FOR UPDATE").bind(a.tenant_id).bind(patient).fetch_one(&mut *tx).await?;
        if archived {
            return Err(Error::Conflict(
                "Restore this patient before saving a payment method.",
            ));
        }
        let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patient_payment_setups WHERE tenant_id=$1 AND patient_id=$2 AND status IN ('creating','open','pending','needs_review'))").bind(a.tenant_id).bind(patient).fetch_one(&mut *tx).await?;
        if pending {
            return Err(Error::Conflict(
                "A card setup is already pending. Refresh the existing request.",
            ));
        }
        sqlx::query("INSERT INTO patient_payment_setups(tenant_id,request_id,patient_id,setting_id,credential_revision,installation_id,provider_account_id,livemode,return_url,requested_by,consent_scope,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'patient_present','creating')").bind(a.tenant_id).bind(v.request_id).bind(patient).bind(c.setting.id).bind(c.setting.credential_revision).bind(c.installation).bind(&c.account).bind(c.live).bind(&return_url).bind(a.sub).execute(&mut *tx).await?;
        crate::postgres::audit(&mut tx, &a, "payment.patient_setup_requested", v.request_id)
            .await?;
        load(&mut tx, a.tenant_id, v.request_id).await?
    };
    tx.commit().await?;
    let raw=source.request(&c.config,Method::POST,&format!("/patient-billing/{patient}/setup-checkouts"),Some(json!({"account_id":c.account,"livemode":c.live,"remote_tenant_id":a.tenant_id,"request_id":v.request_id,"return_url":return_url,"consent":true}))).await;
    complete(&a, &s, &h, &path, Method::POST, "create", &c, &op, raw).await
}
pub(in crate::payments) async fn read(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(request): Path<Uuid>,
    h: HeaderMap,
) -> Result<Response> {
    read_with(a, s, request, h, &HttpSource).await
}
async fn read_with(
    a: Actor,
    s: State,
    request: Uuid,
    h: HeaderMap,
    source: &dyn Source,
) -> Result<Response> {
    a.staff()?;
    crate::access_policies::require_native(&s, &a, "billing", "view").await?;
    let mut tx = db(&s)?.begin().await?;
    let op = load(&mut tx, a.tenant_id, request).await?;
    tx.commit().await?;
    let c = context(&a, &s, op.patient_id, source).await?;
    op.check(&c)?;
    let raw = source
        .request(
            &c.config,
            Method::GET,
            &format!(
                "/patient-billing/{}/setup-checkouts/{request}?{}",
                op.patient_id,
                c.query(a.tenant_id).finish()
            ),
            None,
        )
        .await;
    complete(
        &a,
        &s,
        &h,
        &format!("/api/v1/billing/payment-setups/{request}"),
        Method::GET,
        "view",
        &c,
        &op,
        raw,
    )
    .await
}
#[allow(clippy::too_many_arguments)]
async fn complete(
    a: &Actor,
    s: &State,
    h: &HeaderMap,
    path: &str,
    method: Method,
    action: &str,
    c: &Context,
    op: &Setup,
    raw: Result<Value>,
) -> Result<Response> {
    fresh_actor(a, s, h, method, path, action).await?;
    let mut tx = db(s)?.begin().await?;
    c.unchanged(&mut tx, a).await?;
    let current = load(&mut tx, a.tenant_id, op.request_id).await?;
    current.check(c)?;
    let evidence = raw.and_then(|v| clean_setup(c, a.tenant_id, &current, &v));
    match evidence {
        Ok(mut value) => {
            let deadline: DateTime<Utc> =
                serde_json::from_value(value["retry_safe_until"].clone()).map_err(|_| invalid())?;
            value["retry_allowed"] = json!(
                value["session"].is_null()
                    && deadline > Utc::now()
                    && current.requested_by == a.sub
                    && a.scheduling().is_ok()
                    && crate::access_policies::require_native(s, a, "billing", "create")
                        .await
                        .is_ok()
            );
            sqlx::query("UPDATE patient_payment_setups SET status=$3,provider_evidence=$4,version=version+1,updated_at=now() WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(op.request_id).bind(value["status"].as_str()).bind(&value).execute(&mut *tx).await?;
            crate::postgres::audit(&mut tx, a, "payment.patient_setup_verified", op.request_id)
                .await?;
            tx.commit().await?;
            Ok(response(value))
        }
        Err(error) => {
            if !current.terminal() {
                sqlx::query("UPDATE patient_payment_setups SET status='needs_review',version=version+1,updated_at=now() WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(op.request_id).execute(&mut *tx).await?;
                crate::postgres::audit(
                    &mut tx,
                    a,
                    "payment.patient_setup_uncertain",
                    op.request_id,
                )
                .await?;
            }
            tx.commit().await?;
            Err(error)
        }
    }
}

#[cfg(test)]
#[path = "patient_payment_profile_tests.rs"]
mod tests;
