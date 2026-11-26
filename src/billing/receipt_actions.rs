// SPDX-License-Identifier: AGPL-3.0-only
//! Explicit receipt refunds and allocation of unused patient credit.
use super::*;

pub(super) fn router() -> Router<State> {
    Router::new().route(
        "/api/v1/patients/{p}/billing/copays/{id}/actions",
        post(change),
    )
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Input {
    request_id: Uuid,
    kind: String,
    amount_cents: i64,
    reason: String,
    method: String,
    account_id: Option<Uuid>,
}
async fn change(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, receipt)): Path<(Uuid, Uuid)>,
    Json(v): Json<Input>,
) -> Result<Json<Value>> {
    write(&a)?;
    crate::access_policies::require_native(&s, &a, "billing", "edit").await?;
    let (result, card) = record(db(&s)?, &a, p, receipt, &v).await?;
    if let Some(operation) = card {
        crate::copay_checkout::refund_receipt(
            db(&s)?,
            &a,
            operation,
            v.request_id,
            v.amount_cents,
            &v.reason,
        )
        .await?;
        let mut tx = db(&s)?.begin().await?;
        tenant_lock(&mut tx, &a).await?;
        let completed: bool = sqlx::query_scalar("SELECT o.refunded_cents>=r.baseline_refunded_cents+r.amount_cents FROM billing_receipt_actions r JOIN copay_checkout_attempts o ON o.tenant_id=r.tenant_id AND o.receipt_id=r.receipt_id WHERE r.tenant_id=$1 AND r.request_id=$2")
            .bind(a.tenant_id).bind(v.request_id).fetch_one(&mut *tx).await?;
        if completed {
            sqlx::query("UPDATE billing_receipt_actions SET status='completed' WHERE tenant_id=$1 AND request_id=$2")
                .bind(a.tenant_id).bind(v.request_id).execute(&mut *tx).await?;
            crate::postgres::audit(&mut tx, &a, "billing.receipt_refund_confirmed", receipt)
                .await?;
        }
        tx.commit().await?;
        return Ok(Json(
            json!({"status":if completed {"completed"} else {"pending"},"request_id":v.request_id}),
        ));
    }
    Ok(Json(result))
}
async fn record(
    pool: &sqlx::PgPool,
    a: &Actor,
    p: Uuid,
    receipt: Uuid,
    v: &Input,
) -> Result<(Value, Option<Uuid>)> {
    text(&v.reason, 1000)?;
    choice(&v.kind, &["refund", "apply"])?;
    choice(&v.method, &["cash", "check", "card", "external"])?;
    if !(1..=100000000).contains(&v.amount_cents) || (v.kind == "apply") != v.account_id.is_some() {
        return Err(Error::Invalid(
            "Enter an amount and choose the encounter for a credit.",
        ));
    }
    let hash = digest(&(p, receipt, v))?;
    let mut tx = pool.begin().await?;
    tenant_lock(&mut tx, a).await?;
    patient(&mut tx, a, p).await?;
    let row = copay_rows(&mut tx, a, p, Some(receipt))
        .await?
        .into_iter()
        .next()
        .ok_or(Error::NotFound)?;
    let operation = row["hosted_checkout"]["id"]
        .as_str()
        .and_then(|s| Uuid::parse_str(s).ok());
    let prior: Option<(String,String)> = sqlx::query_as("SELECT creation_hash,status FROM billing_receipt_actions WHERE tenant_id=$1 AND request_id=$2")
        .bind(a.tenant_id).bind(v.request_id).fetch_optional(&mut *tx).await?;
    if let Some((old, status)) = prior {
        if old != hash {
            return Err(Error::Conflict(
                "This request was already used for different details.",
            ));
        }
        tx.commit().await?;
        return Ok((
            json!({"status":status,"request_id":v.request_id}),
            if status == "pending" { operation } else { None },
        ));
    }
    let pending: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM billing_receipt_actions WHERE tenant_id=$1 AND receipt_id=$2 AND status='pending')")
        .bind(a.tenant_id).bind(receipt).fetch_one(&mut *tx).await?;
    if pending
        || row["voided"] == true
        || row["reversed_cents"].as_i64().unwrap_or(0) > 0
        || row["hosted_checkout"]["status"] == "needs_review"
    {
        return Err(Error::Conflict(
            "Review this receipt and any pending refund before using its credit.",
        ));
    }
    let card = operation.is_some();
    if (v.method == "card") != card
        || (v.kind == "refund"
            && !card
            && !["cash", "check"].contains(&row["method"].as_str().unwrap_or_default()))
    {
        return Err(Error::Invalid(
            "Choose cash or check for a recorded refund, or the original card for a card refund.",
        ));
    }
    let amount = row["amount_cents"].as_i64().ok_or(Error::NotFound)?;
    let refunded = row["hosted_checkout"]["refunded_cents"]
        .as_i64()
        .unwrap_or(0)
        + row["cash_refunded_cents"].as_i64().unwrap_or(0);
    let unused = amount
        - row["allocated_cents"].as_i64().unwrap_or(0)
        - row["hosted_checkout"]["refunded_unapplied_cents"]
            .as_i64()
            .unwrap_or(0)
        - row["cash_refunded_cents"].as_i64().unwrap_or(0);
    let limit = if v.kind == "refund" && card {
        amount - refunded
    } else {
        unused
    };
    if v.amount_cents > limit {
        return Err(Error::Conflict(
            "The amount exceeds the credit available on this receipt. Refresh and try again.",
        ));
    }
    if row["hosted_checkout"]["livemode"] == false
        && std::env::var("ENGINE_ENVIRONMENT").as_deref() == Ok("production")
    {
        return Err(Error::Invalid(
            "Test payments cannot change production balances.",
        ));
    }
    if v.kind == "refund" && !card && !["cash", "check"].contains(&v.method.as_str()) {
        return Err(Error::Invalid(
            "Record whether the refund was paid by cash or check.",
        ));
    }
    let pending = card && v.kind == "refund";
    sqlx::query("INSERT INTO billing_receipt_actions(tenant_id,request_id,receipt_id,kind,amount_cents,reason,method,account_id,creation_hash,actor_id,status,baseline_refunded_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)")
        .bind(a.tenant_id).bind(v.request_id).bind(receipt).bind(&v.kind).bind(v.amount_cents).bind(v.reason.trim()).bind(&v.method).bind(v.account_id).bind(hash).bind(a.sub).bind(if pending {"pending"} else {"completed"}).bind(refunded).execute(&mut *tx).await?;
    if let Some(account) = v.account_id {
        let target = account_row(&mut tx, a, p, account).await?;
        let same_appointment: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM visits WHERE tenant_id=$1 AND id=$2 AND appointment_id=$3)")
            .bind(a.tenant_id).bind(target.content["visit_id"].as_str().and_then(|s| Uuid::parse_str(s).ok())).bind(row["appointment_id"].as_str().and_then(|s| Uuid::parse_str(s).ok())).fetch_one(&mut *tx).await?;
        if same_appointment {
            return Err(Error::Invalid("Choose another encounter for this credit."));
        }
        if target.status != "posted" {
            return Err(Error::Conflict(
                "Post the encounter charges before applying credit.",
            ));
        }
        // Reuse the reviewed patient balance, including reservations for open payment requests.
        let balances = crate::visit_billing::balances(
            &mut tx,
            a.tenant_id,
            Some(&[p]),
            Some(&[account]),
            None,
        )
        .await?;
        let balance = balances
            .first()
            .and_then(|r| r["owes_now_cents"].as_i64())
            .unwrap_or(0);
        let reserved: i64 = sqlx::query_scalar("SELECT coalesce(sum(amount_cents),0)::bigint FROM payment_attempts WHERE tenant_id=$1 AND account_id=$2 AND status IN ('creating','open','needs_review') AND paid_entry_id IS NULL")
            .bind(a.tenant_id).bind(account).fetch_one(&mut *tx).await?;
        let pending: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM invoice_checkout_attempts WHERE tenant_id=$1 AND account_id=$2 AND status IN ('creating','open','needs_review')) OR EXISTS(SELECT 1 FROM copay_checkout_attempts c JOIN visits v ON v.tenant_id=c.tenant_id AND v.appointment_id=c.appointment_id WHERE c.tenant_id=$1 AND v.id=$3 AND c.status IN ('creating','open','needs_review'))")
            .bind(a.tenant_id).bind(account).bind(target.content["visit_id"].as_str().and_then(|s| Uuid::parse_str(s).ok())).fetch_one(&mut *tx).await?;
        if pending {
            return Err(Error::Conflict(
                "Finish or cancel the encounter's open card payment before applying credit.",
            ));
        }
        let balance = balance - reserved;
        if v.amount_cents > balance {
            return Err(Error::Conflict(
                "The credit exceeds the patient's current encounter balance.",
            ));
        }
        let entry = Uuid::new_v4();
        let mut content = json!({"kind":"payment","amount_cents":v.amount_cents,"party":"patient","method":if card {json!("card")} else {row["method"].clone()},"reference":receipt,"occurred_on":Utc::now().date_naive(),"reason":v.reason,"copay_receipt_id":receipt,"hosted_copay_operation_id":operation,"test_mode":row["hosted_checkout"]["livemode"]==false});
        if !card {
            content
                .as_object_mut()
                .unwrap()
                .remove("hosted_copay_operation_id");
        }
        sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id) VALUES($1,$2,$3,'payment',$4,$5,$2,$6,$7)")
            .bind(a.tenant_id).bind(entry).bind(account).bind(-v.amount_cents).bind(content).bind(digest(&(receipt,entry,v.amount_cents))?).bind(a.sub).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO billing_copay_allocations(tenant_id,receipt_id,patient_id,account_id,entry_id,amount_cents,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(a.tenant_id).bind(receipt).bind(p).bind(account).bind(entry).bind(v.amount_cents).bind(a.sub).execute(&mut *tx).await?;
        sqlx::query("UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(account)
            .execute(&mut *tx)
            .await?;
        account_revision(&mut tx, a, p, account, &v.reason).await?;
    }
    crate::postgres::audit(
        &mut tx,
        a,
        if v.kind == "apply" {
            "billing.receipt_credit_applied"
        } else {
            "billing.receipt_refund_requested"
        },
        receipt,
    )
    .await?;
    tx.commit().await?;
    Ok((
        json!({"status":"completed","request_id":v.request_id}),
        if pending { operation } else { None },
    ))
}

#[cfg(test)]
pub(crate) async fn record_test(
    pool: &sqlx::PgPool,
    a: &Actor,
    p: Uuid,
    receipt: Uuid,
    input: Value,
) -> Result<(Value, Option<Uuid>)> {
    record(pool, a, p, receipt, &serde_json::from_value(input).unwrap()).await
}
