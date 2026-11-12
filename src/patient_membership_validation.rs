// SPDX-License-Identifier: AGPL-3.0-only
use super::*;
fn uuid(v: &Value) -> Result<Uuid> {
    serde_json::from_value::<Uuid>(v.clone())
        .ok()
        .filter(|v| !v.is_nil())
        .ok_or_else(invalid)
}
fn date(v: &Value) -> Result<DateTime<Utc>> {
    serde_json::from_value(v.clone()).map_err(|_| invalid())
}
fn nullable_id(v: &Value, key: &str, prefix: &str) -> Result<Value> {
    let value = v.get(key).ok_or_else(invalid)?;
    if value.is_null() {
        Ok(Value::Null)
    } else {
        Ok(json!(identifier(value, prefix)?))
    }
}
pub(super) fn validate_price_input(v: &Value) -> Result<()> {
    text_field(v, "name", 100)?;
    number(v, "amount_cents", 50, 100_000_000)?;
    let interval = choice_field(v, "interval", &["day", "week", "month", "year"])?;
    number(
        v,
        "interval_count",
        1,
        match interval.as_str() {
            "day" => 365,
            "week" => 52,
            "month" => 12,
            _ => 1,
        },
    )?;
    if v["currency"] != "usd" || v["approved"] != true {
        return Err(Error::Invalid(
            "An explicitly approved fixed USD price is required.",
        ));
    }
    text_field(v, "approval_reason", 500)?;
    Ok(())
}
pub(super) fn clean_price(v: &Value, snapshot: bool) -> Result<Value> {
    let id = uuid(&v["id"])?;
    let request = uuid(&v["request_id"])?;
    let status = choice_field(
        v,
        "status",
        if snapshot {
            &["approved"]
        } else {
            &[
                "creating",
                "active",
                "inactive",
                "needs_review",
                "unavailable",
            ]
        },
    )?;
    let interval = choice_field(v, "interval", &["day", "week", "month", "year"])?;
    let count = number(
        v,
        "interval_count",
        1,
        match interval.as_str() {
            "day" => 365,
            "week" => 52,
            "month" => 12,
            _ => 1,
        },
    )?;
    if v["currency"] != "usd" {
        return Err(invalid());
    }
    let provider = nullable_id(v, "provider_price_id", "price_")?;
    if matches!(status.as_str(), "active" | "inactive" | "approved") && provider.is_null() {
        return Err(invalid());
    }
    if matches!(status.as_str(), "creating" | "needs_review") && !provider.is_null() {
        return Err(invalid());
    }
    Ok(
        json!({"id":id,"request_id":request,"provider_price_id":provider,"name":text_field(v,"name",100)?,"amount_cents":number(v,"amount_cents",50,100_000_000)?,"currency":"usd","interval":interval,"interval_count":count,"status":status,"created_at":date(&v["created_at"])?}),
    )
}
fn retry_fields(v: &Value, local: Option<DateTime<Utc>>) -> Result<(DateTime<Utc>, bool)> {
    let mut until = date(&v["retry_safe_until"])?;
    if until > Utc::now() + chrono::Duration::hours(24) {
        return Err(invalid());
    }
    if let Some(created) = local {
        until = until.min(created + chrono::Duration::hours(23));
    }
    Ok((until, v["recovery_required"].as_bool().ok_or_else(invalid)?))
}
fn checkout_url(v: &Value, status: &str) -> Result<Value> {
    let raw = v.get("url").ok_or_else(invalid)?;
    if status != "open" {
        return if raw.is_null() {
            Ok(Value::Null)
        } else {
            Err(invalid())
        };
    }
    let text = raw
        .as_str()
        .filter(|v| v.len() <= 4096)
        .ok_or_else(invalid)?;
    let u = url::Url::parse(text).map_err(|_| invalid())?;
    if u.scheme() != "https"
        || u.host_str() != Some("checkout.stripe.com")
        || u.port().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err(invalid());
    }
    Ok(json!(text))
}
fn subscription(v: &Value, price: &Value) -> Result<Value> {
    let out = clean_item(v, "subscriptions")?;
    if out["currency"] != "usd" {
        return Err(invalid());
    }
    let lines = out["items"].as_array().ok_or_else(invalid)?;
    if lines.len() != 1
        || lines[0]["quantity"] != 1
        || lines[0]["unit_amount"] != price["amount_cents"]
        || lines[0]["interval"] != price["interval"]
        || lines[0]["interval_count"] != price["interval_count"]
    {
        return Err(invalid());
    }
    Ok(out)
}
pub(super) fn clean_membership(c: &Context, v: &Value, op: Option<&Operation>) -> Result<Value> {
    let request = uuid(&v["request_id"])?;
    let price = clean_price(&v["price"], true)?;
    let created = date(&v["created_at"])?;
    let (until, recovery) = retry_fields(v, op.map(|v| v.created_at))?;
    let until = op.map_or(until, |op| until.min(op.deadline()));
    let status = choice_field(
        v,
        "status",
        &[
            "creating",
            "open",
            "active",
            "pending",
            "canceled",
            "expired",
            "needs_review",
        ],
    )?;
    let customer = nullable_id(v, "customer_id", "cus_")?;
    let subid = nullable_id(v, "subscription_id", "sub_")?;
    let substatus = if v.get("subscription_status").ok_or_else(invalid)?.is_null() {
        Value::Null
    } else {
        json!(choice_field(
            v,
            "subscription_status",
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
        )?)
    };
    let cancel = match v.get("cancel_at_period_end").ok_or_else(invalid)? {
        Value::Null => Value::Null,
        Value::Bool(b) => json!(b),
        _ => return Err(invalid()),
    };
    let end = optional_number(v, "current_period_end", 0, MAX_TIME)?;
    if v.get("current_period_end").is_none() {
        return Err(invalid());
    }
    let session = if v.get("session").ok_or_else(invalid)?.is_null() {
        if !matches!(status.as_str(), "creating" | "needs_review")
            || recovery != (status == "needs_review")
            || !subid.is_null()
            || !substatus.is_null()
            || !cancel.is_null()
            || !end.is_null()
        {
            return Err(invalid());
        }
        Value::Null
    } else {
        if customer.is_null() || recovery {
            return Err(invalid());
        }
        let raw = &v["session"];
        let sid = identifier(&raw["id"], if c.live { "cs_live_" } else { "cs_test_" })?;
        let st = choice_field(raw, "status", &["open", "complete", "expired"])?;
        let accepted = raw["authorization_accepted"]
            .as_bool()
            .ok_or_else(invalid)?;
        let sub = if raw.get("subscription").ok_or_else(invalid)?.is_null() {
            Value::Null
        } else {
            subscription(&raw["subscription"], &price)?
        };
        if st == "complete" && (!accepted || sub.is_null()) {
            return Err(invalid());
        }
        if st != "complete" && !sub.is_null() {
            return Err(invalid());
        }
        let expected = match st.as_str() {
            "open" => "open",
            "expired" => "expired",
            _ => match sub["status"].as_str() {
                Some("active") => "active",
                Some("canceled" | "incomplete_expired") => "canceled",
                _ => "pending",
            },
        };
        if status != expected
            || subid != sub["id"]
            || substatus != sub["status"]
            || cancel != sub["cancel_at_period_end"]
            || end != sub["items"][0]["current_period_end"]
        {
            return Err(invalid());
        }
        json!({"id":sid,"url":checkout_url(raw,&st)?,"status":st,"authorization_accepted":accepted,"subscription":sub})
    };
    let terms = text_field(v, "terms", 1200)?;
    let expected=format!("You authorize USD {}.{:02} every {} {}{} for {}. This membership renews automatically until canceled. Cancellation takes effect at the end of the paid period; cancellation does not issue a refund.",price["amount_cents"].as_i64().unwrap()/100,price["amount_cents"].as_i64().unwrap()%100,price["interval_count"],price["interval"].as_str().unwrap(),if price["interval_count"]==1{""}else{"s"},price["name"].as_str().unwrap());
    if terms != expected {
        return Err(invalid());
    }
    if let Some(op) = op {
        if request != op.request_id || price["id"] != op.request_body["price_id"] {
            return Err(invalid());
        }
        if let Some(old) = &op.provider_evidence {
            let old = &old["membership"];
            for key in ["price", "terms", "customer_id"] {
                if !old[key].is_null() && old[key] != v[key] {
                    return Err(invalid());
                }
            }
            if !old["subscription_id"].is_null() && old["subscription_id"] != subid {
                return Err(invalid());
            }
            if !old["session"]["id"].is_null() && old["session"]["id"] != session["id"] {
                return Err(invalid());
            }
            if matches!(op.status.as_str(), "expired" | "canceled") && op.status != status {
                return Err(invalid());
            }
        }
    }
    Ok(
        json!({"request_id":request,"price":price,"terms":terms,"customer_id":customer,"status":status,"session":session,"subscription_id":subid,"subscription_status":substatus,"cancel_at_period_end":cancel,"current_period_end":end,"retry_safe_until":until,"recovery_required":recovery,"retry_allowed":false,"created_at":created}),
    )
}
pub(super) fn clean_operation(
    c: &Context,
    tenant: Uuid,
    op: &Operation,
    v: &Value,
) -> Result<Value> {
    let mut out = envelope(c, tenant, v, op.patient_id)?;
    if op.kind == "membership" {
        out["membership"] = clean_membership(c, &v["membership"], Some(op))?;
        return Ok(out);
    }
    let (until, recovery) = retry_fields(v, Some(op.created_at))?;
    let until = until.min(op.deadline());
    out["retry_safe_until"] = json!(until);
    out["recovery_required"] = json!(recovery);
    if op.kind == "price" {
        let price = clean_price(&v["price"], false)?;
        if price["request_id"] != op.request_id.to_string() {
            return Err(invalid());
        }
        for key in [
            "name",
            "amount_cents",
            "currency",
            "interval",
            "interval_count",
        ] {
            if price[key] != op.request_body[key] {
                return Err(invalid());
            }
        }
        if recovery != (price["status"] == "needs_review") {
            return Err(invalid());
        }
        if let Some(old) = &op.provider_evidence {
            for key in ["id", "provider_price_id"] {
                if !old["price"][key].is_null() && old["price"][key] != price[key] {
                    return Err(invalid());
                }
            }
        }
        out["price"] = price;
    } else {
        if v["request_id"] != op.request_id.to_string() {
            return Err(invalid());
        }
        let member = uuid(&v["membership_request_id"])?;
        if json!(member) != op.request_body["membership_request_id"] {
            return Err(invalid());
        }
        let sub = clean_item(&v["subscription"], "subscriptions")?;
        if sub["id"] != op.request_body["subscription_id"] {
            return Err(invalid());
        }
        let status = choice_field(
            v,
            "status",
            &["scheduled", "canceled", "pending", "needs_review"],
        )?;
        let expected = if matches!(
            sub["status"].as_str(),
            Some("canceled" | "incomplete_expired")
        ) {
            "canceled"
        } else if sub["cancel_at_period_end"] == true {
            "scheduled"
        } else if recovery {
            "needs_review"
        } else {
            "pending"
        };
        if status != expected || recovery != (status == "needs_review") {
            return Err(invalid());
        }
        if let Some(old) = &op.provider_evidence {
            if old["membership_request_id"] != json!(member) {
                return Err(invalid());
            }
        }
        out["request_id"] = json!(op.request_id);
        out["membership_request_id"] = json!(member);
        out["subscription"] = sub;
        out["status"] = json!(status);
    }
    Ok(out)
}
pub(super) fn operation_status<'a>(kind: &str, v: &'a Value) -> Result<&'a str> {
    match kind {
        "price" => v["price"]["status"].as_str(),
        "membership" => v["membership"]["status"].as_str(),
        _ => v["status"].as_str(),
    }
    .ok_or_else(invalid)
}
pub(super) fn evidence_pending(kind: &str, v: &Value) -> Option<bool> {
    Some(match kind {
        "price" => v["price"]["provider_price_id"].is_null() && v["price"]["status"] == "creating",
        "membership" => {
            v["membership"]["session"].is_null() && v["membership"]["status"] == "creating"
        }
        _ => v["status"] == "pending",
    })
}
pub(super) fn evidence_recovery(kind: &str, v: &Value) -> Option<bool> {
    if kind == "membership" {
        v["membership"]["recovery_required"].as_bool()
    } else {
        v["recovery_required"].as_bool()
    }
}
