// SPDX-License-Identifier: AGPL-3.0-only
//! Practice-approved recurring plans, kept separate from encounter accounting.
use super::*;
#[path = "patient_membership_validation.rs"]
mod validation;
use validation::*;

#[derive(sqlx::FromRow)]
struct Operation {
    request_id: Uuid,
    kind: String,
    patient_id: Option<Uuid>,
    setting_id: Uuid,
    credential_revision: i64,
    installation_id: Uuid,
    provider_account_id: String,
    livemode: bool,
    requested_by: Uuid,
    request_body: Value,
    status: String,
    provider_evidence: Option<Value>,
    created_at: DateTime<Utc>,
}
impl Operation {
    fn deadline(&self) -> DateTime<Utc> {
        let local = self.created_at + chrono::Duration::hours(23);
        self.provider_evidence
            .as_ref()
            .and_then(|v| {
                let v = if self.kind == "membership" {
                    &v["membership"]
                } else {
                    v
                };
                serde_json::from_value::<DateTime<Utc>>(v["retry_safe_until"].clone()).ok()
            })
            .map_or(local, |provider| local.min(provider))
    }
    fn check(&self, c: &Context, patient: Option<Uuid>) -> Result<()> {
        if self.patient_id != patient
            || self.setting_id != c.setting.id
            || self.credential_revision != c.setting.credential_revision
            || self.installation_id != c.installation
            || self.provider_account_id != c.account
            || self.livemode != c.live
        {
            return Err(Error::Conflict("Membership belongs to an earlier payment connection. Keep its original request for review."));
        }
        Ok(())
    }
    fn read_path(&self, c: &Context, tenant: Uuid) -> Result<String> {
        let q = c.query(tenant).finish();
        Ok(match self.kind.as_str() {
            "price" => format!("/membership-prices/{}?{q}", self.request_id),
            "membership" => format!(
                "/patient-billing/{}/membership-checkouts/{}?{q}",
                self.patient_id.ok_or_else(invalid)?,
                self.request_id
            ),
            "cancel" => format!(
                "/patient-billing/{}/memberships/{}/cancellations/{}?{q}",
                self.patient_id.ok_or_else(invalid)?,
                identifier(&self.request_body["subscription_id"], "sub_")?,
                self.request_id
            ),
            _ => return Err(invalid()),
        })
    }
}
fn live_writes_allowed(live: bool) -> bool {
    writes_allowed_in(
        live,
        test_payments_available(),
        std::env::var("ENGINE_LIVE_MEMBERSHIPS_ENABLED").as_deref() == Ok("enabled"),
    )
}
fn writes_allowed_in(live: bool, test_allowed: bool, live_enabled: bool) -> bool {
    if live {
        live_enabled
    } else {
        test_allowed
    }
}
async fn account_context(
    a: &Actor,
    s: &State,
    patient: Option<Uuid>,
    source: &dyn Source,
) -> Result<Context> {
    if let Some(patient) = patient {
        return context(a, s, patient, source).await;
    }
    a.staff()?;
    crate::access_policies::require_native(s, a, "billing", "view").await?;
    let mut tx = db(s)?.begin().await?;
    let setting = setting(&mut tx, a.tenant_id).await?;
    tx.commit().await?;
    if setting.mode != "suncharts_connect" {
        return Err(Error::Conflict(
            "Connect the practice payment account before opening membership plans.",
        ));
    }
    let config = source.config(db(s)?, a.tenant_id, &setting).await?;
    let raw = source
        .request(&config, Method::GET, "/status", None)
        .await?;
    let status = bound_connect_status(&config, a.tenant_id, &raw).ok_or_else(invalid)?;
    let account = identifier(&status["account_id"], "acct_")?;
    let live = status["livemode"].as_bool().ok_or_else(invalid)?;
    if setting
        .provider_account_id
        .as_ref()
        .is_some_and(|v| v != &account)
    {
        return Err(invalid());
    }
    Ok(Context {
        installation: config.installation_id.ok_or_else(invalid)?,
        setting,
        config,
        account,
        live,
        patient: Uuid::nil(),
        archived: false,
    })
}
fn envelope(c: &Context, tenant: Uuid, v: &Value, patient: Option<Uuid>) -> Result<Value> {
    if patient.is_some() {
        return c.envelope(tenant, v);
    }
    // Account catalog has no patient scope; validate it without inventing a patient binding.
    if v.get("patient_id").is_some() {
        return Err(invalid());
    }
    let mut proof = v.clone();
    proof["patient_id"] = json!(Uuid::nil());
    let mut out = c.envelope(tenant, &proof)?;
    out.as_object_mut().unwrap().remove("patient_id");
    Ok(out)
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(in crate::payments) struct Page {
    after: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::payments) struct PriceInput {
    request_id: Uuid,
    name: String,
    amount_cents: i64,
    currency: String,
    interval: String,
    interval_count: i64,
    approved: bool,
    approval_reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::payments) struct MembershipInput {
    request_id: Uuid,
    price_id: Uuid,
    consent: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::payments) struct CancelInput {
    request_id: Uuid,
    expected_cancel_at_period_end: bool,
}
async fn authorize(
    a: &Actor,
    s: &State,
    h: &HeaderMap,
    path: &str,
    kind: &str,
    method: Method,
) -> Result<Actor> {
    let action = if method == Method::GET {
        "view"
    } else if kind == "cancel" {
        "edit"
    } else {
        "create"
    };
    let mutating = method != Method::GET;
    let current = fresh_actor(a, s, h, method, path, action).await?;
    if mutating {
        current.scheduling()?;
    }
    if kind == "price" && action != "view" {
        owner(&current)?;
    }
    Ok(current)
}
async fn load(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    request: Uuid,
) -> Result<Operation> {
    sqlx::query_as("SELECT * FROM patient_membership_operations WHERE tenant_id=$1 AND request_id=$2 FOR UPDATE").bind(tenant).bind(request).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
#[allow(clippy::too_many_arguments)]
async fn create_with(
    a: Actor,
    s: State,
    patient: Option<Uuid>,
    h: HeaderMap,
    kind: &str,
    request: Uuid,
    mut body: Value,
    source: &dyn Source,
) -> Result<Response> {
    let path = if kind == "price" {
        "/api/v1/billing/membership-prices".into()
    } else if kind == "cancel" {
        format!(
            "/api/v1/billing/patients/{}/memberships/{}/cancel-at-period-end",
            patient.ok_or_else(invalid)?,
            identifier(&body["subscription_id"], "sub_")?
        )
    } else {
        format!(
            "/api/v1/billing/patients/{}/memberships",
            patient.ok_or_else(invalid)?
        )
    };
    authorize(&a, &s, &h, &path, kind, Method::POST).await?;
    if request.is_nil() {
        return Err(Error::Invalid(
            "A stable membership request ID is required.",
        ));
    }
    let c = account_context(&a, &s, patient, source).await?;
    if kind != "cancel" && !live_writes_allowed(c.live) {
        return Err(Error::Conflict("Membership creation is not activated for this payment mode. Existing plans remain readable."));
    }
    if kind == "membership" {
        body["return_url"] = json!(format!(
            "{}/?payment_membership={request}",
            origin(&s)?.trim_end_matches('/')
        ));
    }
    body["request_id"] = json!(request);
    authorize(&a, &s, &h, &path, kind, Method::POST).await?;
    let mut tx = db(&s)?.begin().await?;
    c.unchanged(&mut tx, &a).await?;
    if kind == "membership" {
        let archived:bool=sqlx::query_scalar("SELECT coalesce((SELECT e.archived FROM patient_lifecycle_events e WHERE e.tenant_id=p.tenant_id AND e.patient_id=p.id ORDER BY e.version DESC LIMIT 1),false) FROM patients p WHERE p.tenant_id=$1 AND p.id=$2 FOR UPDATE").bind(a.tenant_id).bind(patient).fetch_one(&mut *tx).await?;
        if archived {
            return Err(Error::Conflict(
                "Restore this patient before starting or retrying a membership.",
            ));
        }
    }
    if kind == "cancel" {
        let enrollment: Uuid = sqlx::query_scalar("SELECT request_id FROM patient_membership_operations WHERE tenant_id=$1 AND patient_id=$2 AND kind='membership' AND setting_id=$3 AND provider_account_id=$4 AND livemode=$5 AND provider_evidence->'membership'->>'subscription_id'=$6 ORDER BY created_at LIMIT 1").bind(a.tenant_id).bind(patient).bind(c.setting.id).bind(&c.account).bind(c.live).bind(body["subscription_id"].as_str()).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        body["membership_request_id"] = json!(enrollment);
    }
    let prior:Option<Operation>=sqlx::query_as("SELECT * FROM patient_membership_operations WHERE tenant_id=$1 AND request_id=$2 FOR UPDATE").bind(a.tenant_id).bind(request).fetch_optional(&mut *tx).await?;
    let op = if let Some(op) = prior {
        op.check(&c, patient)?;
        if op.kind != kind || op.request_body != body || op.requested_by != a.sub {
            return Err(Error::Conflict(
                "This membership request was already reserved with different terms or permission.",
            ));
        }
        if op
            .provider_evidence
            .as_ref()
            .is_some_and(|v| evidence_recovery(&op.kind, v) != Some(false))
        {
            return Err(Error::Conflict(
                "Membership request needs review; refresh its status instead of retrying.",
            ));
        }
        if op
            .provider_evidence
            .as_ref()
            .is_some_and(|v| evidence_pending(&op.kind, v) == Some(false))
        {
            tx.commit().await?;
            return read_with(a, s, request, h, kind == "price", source).await;
        }
        if op
            .provider_evidence
            .as_ref()
            .is_some_and(|v| evidence_recovery(&op.kind, v) != Some(false))
            || Utc::now() >= op.deadline()
        {
            return Err(Error::Conflict(
                "Membership request needs review; do not replace it with another request.",
            ));
        }
        op
    } else {
        if let Some(p) = patient {
            let archived:bool=sqlx::query_scalar("SELECT coalesce((SELECT e.archived FROM patient_lifecycle_events e WHERE e.tenant_id=p.tenant_id AND e.patient_id=p.id ORDER BY e.version DESC LIMIT 1),false) FROM patients p WHERE p.tenant_id=$1 AND p.id=$2 FOR UPDATE").bind(a.tenant_id).bind(p).fetch_one(&mut *tx).await?;
            if archived && kind != "cancel" {
                return Err(Error::Conflict(
                    "Restore this patient before starting a membership.",
                ));
            }
        }
        // Serialize on the setting and refuse replacement IDs for unresolved native operations.
        let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patient_membership_operations WHERE tenant_id=$1 AND kind=$2 AND patient_id IS NOT DISTINCT FROM $3 AND status IN ('creating','open','pending','needs_review') AND ($2='price' OR $2='membership' AND request_body->>'price_id'=$4 OR $2='cancel' AND request_body->>'subscription_id'=$5))").bind(a.tenant_id).bind(kind).bind(patient).bind(body["price_id"].as_str()).bind(body["subscription_id"].as_str()).fetch_one(&mut *tx).await?;
        if pending {
            return Err(Error::Conflict(
                "A matching membership operation is unresolved. Continue its original request.",
            ));
        }
        sqlx::query("INSERT INTO patient_membership_operations(tenant_id,request_id,kind,patient_id,setting_id,credential_revision,installation_id,provider_account_id,livemode,requested_by,request_body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(a.tenant_id).bind(request).bind(kind).bind(patient).bind(c.setting.id).bind(c.setting.credential_revision).bind(c.installation).bind(&c.account).bind(c.live).bind(a.sub).bind(&body).execute(&mut *tx).await?;
        crate::postgres::audit(&mut tx, &a, "payment.membership_requested", request).await?;
        load(&mut tx, a.tenant_id, request).await?
    };
    tx.commit().await?;
    let broker_path = match kind {
        "price" => "/membership-prices".into(),
        "membership" => format!("/patient-billing/{}/membership-checkouts", patient.unwrap()),
        "cancel" => format!(
            "/patient-billing/{}/memberships/{}/cancel-at-period-end",
            patient.unwrap(),
            identifier(&body["subscription_id"], "sub_")?
        ),
        _ => return Err(invalid()),
    };
    body.as_object_mut().unwrap().remove("subscription_id");
    body.as_object_mut()
        .unwrap()
        .remove("membership_request_id");
    body["account_id"] = json!(c.account);
    body["livemode"] = json!(c.live);
    body["remote_tenant_id"] = json!(a.tenant_id);
    let raw = source
        .request(&c.config, Method::POST, &broker_path, Some(body))
        .await;
    complete(&a, &s, &h, &path, Method::POST, &c, &op, raw).await
}
pub(in crate::payments) async fn create_price(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<PriceInput>,
) -> Result<Response> {
    let body = json!({"name":v.name.trim(),"amount_cents":v.amount_cents,"currency":v.currency,"interval":v.interval,"interval_count":v.interval_count,"approved":v.approved,"approval_reason":v.approval_reason.trim()});
    validate_price_input(&body)?;
    create_with(a, s, None, h, "price", v.request_id, body, &HttpSource).await
}
pub(in crate::payments) async fn create(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<MembershipInput>,
) -> Result<Response> {
    if !v.consent || v.price_id.is_nil() {
        return Err(Error::Invalid(
            "Review an approved plan and record explicit permission for recurring enrollment.",
        ));
    }
    create_with(
        a,
        s,
        Some(p),
        h,
        "membership",
        v.request_id,
        json!({"price_id":v.price_id,"consent":true}),
        &HttpSource,
    )
    .await
}
pub(in crate::payments) async fn cancel(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, subscription)): Path<(Uuid, String)>,
    h: HeaderMap,
    Json(v): Json<CancelInput>,
) -> Result<Response> {
    identifier(&json!(subscription), "sub_")?;
    if v.expected_cancel_at_period_end {
        return Err(Error::Invalid(
            "Review the membership's current cancellation state first.",
        ));
    }
    create_with(
        a,
        s,
        Some(p),
        h,
        "cancel",
        v.request_id,
        json!({"subscription_id":subscription,"expected_cancel_at_period_end":false}),
        &HttpSource,
    )
    .await
}
pub(in crate::payments) async fn read_price(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(r): Path<Uuid>,
    h: HeaderMap,
) -> Result<Response> {
    read_with(a, s, r, h, true, &HttpSource).await
}
pub(in crate::payments) async fn read(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(r): Path<Uuid>,
    h: HeaderMap,
) -> Result<Response> {
    read_with(a, s, r, h, false, &HttpSource).await
}
async fn read_with(
    a: Actor,
    s: State,
    request: Uuid,
    h: HeaderMap,
    price: bool,
    source: &dyn Source,
) -> Result<Response> {
    let path = if price {
        format!("/api/v1/billing/membership-prices/{request}")
    } else {
        format!("/api/v1/billing/memberships/{request}")
    };
    authorize(&a, &s, &h, &path, "", Method::GET).await?;
    let mut tx = db(&s)?.begin().await?;
    let op = load(&mut tx, a.tenant_id, request).await?;
    tx.commit().await?;
    if (op.kind == "price") != price {
        return Err(Error::NotFound);
    }
    let c = account_context(&a, &s, op.patient_id, source).await?;
    op.check(&c, op.patient_id)?;
    let raw = source
        .request(
            &c.config,
            Method::GET,
            &op.read_path(&c, a.tenant_id)?,
            None,
        )
        .await;
    complete(&a, &s, &h, &path, Method::GET, &c, &op, raw).await
}
#[allow(clippy::too_many_arguments)]
async fn complete(
    a: &Actor,
    s: &State,
    h: &HeaderMap,
    path: &str,
    method: Method,
    c: &Context,
    op: &Operation,
    raw: Result<Value>,
) -> Result<Response> {
    let actor = authorize(a, s, h, path, &op.kind, method).await?;
    let mut tx = db(s)?.begin().await?;
    c.unchanged(&mut tx, a).await?;
    let current = load(&mut tx, a.tenant_id, op.request_id).await?;
    current.check(c, op.patient_id)?;
    match raw.and_then(|v| clean_operation(c, a.tenant_id, &current, &v)) {
        Ok(mut out) => {
            let target = if op.kind == "membership" {
                &out["membership"]
            } else {
                &out
            };
            let deadline: DateTime<Utc> =
                serde_json::from_value(target["retry_safe_until"].clone())
                    .map_err(|_| invalid())?;
            let allowed = evidence_pending(&op.kind, &out) == Some(true)
                && evidence_recovery(&op.kind, &out) == Some(false)
                && deadline > Utc::now()
                && current.requested_by == a.sub
                && actor.scheduling().is_ok()
                && (op.kind != "price" || owner(&actor).is_ok())
                && (op.kind == "cancel" || live_writes_allowed(c.live))
                && crate::access_policies::require_native(
                    s,
                    &actor,
                    "billing",
                    if op.kind == "cancel" {
                        "edit"
                    } else {
                        "create"
                    },
                )
                .await
                .is_ok();
            if op.kind == "membership" {
                out["membership"]["retry_allowed"] = json!(allowed);
            } else {
                out["retry_allowed"] = json!(allowed);
            }
            let status = operation_status(&op.kind, &out)?.to_owned();
            sqlx::query("UPDATE patient_membership_operations SET status=$3,provider_evidence=$4,version=version+1,updated_at=now() WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(op.request_id).bind(&status).bind(&out).execute(&mut *tx).await?;
            crate::postgres::audit(&mut tx, a, "payment.membership_verified", op.request_id)
                .await?;
            tx.commit().await?;
            Ok(response(out))
        }
        Err(e) => {
            sqlx::query("UPDATE patient_membership_operations SET status=CASE WHEN status IN ('creating','open','pending','needs_review') THEN 'needs_review' ELSE status END,version=version+1,updated_at=now() WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(op.request_id).execute(&mut *tx).await?;
            crate::postgres::audit(&mut tx, a, "payment.membership_uncertain", op.request_id)
                .await?;
            tx.commit().await?;
            Err(e)
        }
    }
}
pub(in crate::payments) async fn prices(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<Page>,
    h: HeaderMap,
) -> Result<Response> {
    list_with(a, s, None, q, h, &HttpSource).await
}
pub(in crate::payments) async fn list(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Query(q): Query<Page>,
    h: HeaderMap,
) -> Result<Response> {
    list_with(a, s, Some(p), q, h, &HttpSource).await
}
async fn list_with(
    a: Actor,
    s: State,
    patient: Option<Uuid>,
    q: Page,
    h: HeaderMap,
    source: &dyn Source,
) -> Result<Response> {
    let c = account_context(&a, &s, patient, source).await?;
    let path = patient.map_or_else(
        || "/api/v1/billing/membership-prices".into(),
        |p| format!("/api/v1/billing/patients/{p}/memberships"),
    );
    let query = {
        let mut query = c.query(a.tenant_id);
        if let Some(after) = q.after {
            query.append_pair("after", &after.to_string());
        }
        query.finish()
    };
    let broker = patient.map_or_else(
        || "/membership-prices".into(),
        |p| format!("/patient-billing/{p}/memberships"),
    );
    let raw = source
        .request(&c.config, Method::GET, &format!("{broker}?{query}"), None)
        .await?;
    let mut out = envelope(&c, a.tenant_id, &raw, patient)?;
    let rows = raw["items"]
        .as_array()
        .filter(|v| v.len() <= 20)
        .ok_or_else(invalid)?;
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for item in rows {
        let clean = if patient.is_some() {
            clean_membership(&c, item, None)?
        } else {
            clean_price(item, false)?
        };
        let id = if patient.is_some() {
            &clean["request_id"]
        } else {
            &clean["id"]
        };
        if !seen.insert(id.clone().to_string()) {
            return Err(invalid());
        }
        items.push(clean);
    }
    let more = raw["has_more"].as_bool().ok_or_else(invalid)?;
    if more && items.is_empty() {
        return Err(invalid());
    }
    let next = if more {
        if patient.is_some() {
            items.last().unwrap()["request_id"].clone()
        } else {
            items.last().unwrap()["id"].clone()
        }
    } else {
        Value::Null
    };
    if raw.get("next_cursor") != Some(&next) {
        return Err(invalid());
    }
    let actor = authorize(&a, &s, &h, &path, "", Method::GET).await?;
    let mut tx = db(&s)?.begin().await?;
    c.unchanged(&mut tx, &a).await?;
    let can_edit = actor.scheduling().is_ok()
        && crate::access_policies::require_native(&s, &actor, "billing", "edit")
            .await
            .is_ok();
    if patient.is_some() {
        for item in &mut items {
            item["cancellation_available"] = json!(false);
            let request: Uuid =
                serde_json::from_value(item["request_id"].clone()).map_err(|_| invalid())?;
            let op:Option<Operation>=sqlx::query_as("SELECT * FROM patient_membership_operations WHERE tenant_id=$1 AND request_id=$2 AND patient_id=$3 AND kind='membership' FOR UPDATE").bind(a.tenant_id).bind(request).bind(patient).fetch_optional(&mut *tx).await?;
            if let Some(op) = op {
                // A provider list cannot adopt an unknown request or a changed credential binding.
                if op.check(&c, patient).is_ok() {
                    let mut proof = raw.clone();
                    proof["membership"] = item.clone();
                    let evidence = clean_operation(&c, a.tenant_id, &op, &proof)?;
                    let status = operation_status("membership", &evidence)?;
                    sqlx::query("UPDATE patient_membership_operations SET status=$3,provider_evidence=$4,version=version+1,updated_at=now() WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(request).bind(status).bind(&evidence).execute(&mut *tx).await?;
                    crate::postgres::audit(&mut tx, &a, "payment.membership_verified", request)
                        .await?;
                    *item = evidence["membership"].clone();
                    item["cancellation_available"] = json!(
                        can_edit
                            && item["subscription_id"].is_string()
                            && item["cancel_at_period_end"] == false
                            && !matches!(
                                item["subscription_status"].as_str(),
                                Some("canceled" | "incomplete_expired")
                            )
                    );
                }
            }
        }
    }
    let can_create = actor.scheduling().is_ok()
        && crate::access_policies::require_native(&s, &actor, "billing", "create")
            .await
            .is_ok();
    let pending_rows:Vec<Operation>=sqlx::query_as("SELECT * FROM patient_membership_operations WHERE tenant_id=$1 AND patient_id IS NOT DISTINCT FROM $2 AND status IN ('creating','open','pending','needs_review') ORDER BY created_at DESC LIMIT 20").bind(a.tenant_id).bind(patient).fetch_all(&mut *tx).await?;
    let pending:Vec<Value>=pending_rows.iter().map(|op| {
        let owns = op.requested_by==actor.sub && (if op.kind=="cancel" {can_edit} else {can_create}) && (op.kind!="price" || owner(&actor).is_ok());
        let deadline=op.deadline();
        let retry = owns && op.check(&c,patient).is_ok() && deadline>Utc::now() && (op.kind=="cancel" || live_writes_allowed(c.live)) && op.provider_evidence.as_ref().is_none_or(|v| evidence_pending(&op.kind,v)==Some(true) && evidence_recovery(&op.kind,v)==Some(false));
        let mut request=op.request_body.clone();
        request.as_object_mut().unwrap().remove("return_url");
        request.as_object_mut().unwrap().remove("membership_request_id");
        json!({"request_id":op.request_id,"kind":op.kind,"status":op.status,"retry_safe_until":deadline,"retry_allowed":retry,"request":if owns{request}else{Value::Null}})
    }).collect();
    out["items"] = json!(items);
    out["has_more"] = json!(more);
    out["next_cursor"] = next;
    out["pending_operations"] = json!(pending);
    out["creation_available"] = json!(
        raw["creation_available"].as_bool().ok_or_else(invalid)?
            && live_writes_allowed(c.live)
            && !c.archived
            && actor.scheduling().is_ok()
            && (patient.is_some() || owner(&actor).is_ok())
            && crate::access_policies::require_native(&s, &actor, "billing", "create")
                .await
                .is_ok()
    );
    crate::postgres::audit(
        &mut tx,
        &a,
        "payment.memberships_read",
        patient.unwrap_or(c.setting.id),
    )
    .await?;
    tx.commit().await?;
    Ok(response(out))
}
#[cfg(test)]
#[path = "patient_membership_tests.rs"]
mod tests;
