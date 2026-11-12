// SPDX-License-Identifier: AGPL-3.0-only
//! Payment sources appear once; allocating a receipt is not another collection.
use super::*;
const ROWS: &str = r#"WITH rows AS (
 SELECT 'copay'::text AS kind,r.id,r.created_at,NULL::uuid AS account_id,NULL::text AS visit_id,r.appointment_id,
 CASE WHEN EXISTS(SELECT 1 FROM billing_copay_voids v WHERE v.tenant_id=r.tenant_id AND v.receipt_id=r.id) THEN 0 ELSE r.amount_cents END AS received_cents,
 coalesce(o.refunded_cents,0) AS refunded_cents,
 greatest(0,r.amount_cents-coalesce((SELECT sum(x.amount_cents) FROM billing_copay_allocations x WHERE x.tenant_id=r.tenant_id AND x.receipt_id=r.id),0)::bigint-coalesce((SELECT sum(f.unapplied_cents) FROM copay_checkout_refund_events f WHERE f.tenant_id=o.tenant_id AND f.operation_id=o.id),0)::bigint) AS unapplied_cents,
 EXISTS(SELECT 1 FROM billing_copay_allocations x WHERE x.tenant_id=r.tenant_id AND x.receipt_id=r.id) AS ledger_recorded,
 r.reference,
 CASE WHEN EXISTS(SELECT 1 FROM billing_copay_voids v WHERE v.tenant_id=r.tenant_id AND v.receipt_id=r.id) THEN 'voided'
 WHEN EXISTS(SELECT 1 FROM billing_copay_allocations x JOIN billing_entries e ON e.tenant_id=x.tenant_id AND e.reverses_id=x.entry_id WHERE x.tenant_id=r.tenant_id AND x.receipt_id=r.id) THEN 'needs_review'
 ELSE coalesce(o.status,'recorded') END AS status,
 coalesce(o.livemode=false,false) AS test_activity,r.id AS receipt_id
 FROM billing_copay_receipts r LEFT JOIN copay_checkout_attempts o ON o.tenant_id=r.tenant_id AND o.receipt_id=r.id
 WHERE r.tenant_id=$1 AND r.patient_id=$2
 UNION ALL
 SELECT 'account_payment',p.id,p.created_at,p.account_id,b.content->>'visit_id',NULL::uuid,
 CASE WHEN p.paid_entry_id IS NOT NULL THEN p.amount_cents END,p.refunded_cents,0,p.paid_entry_id IS NOT NULL,
 coalesce(p.provider_charge_id,p.id::text),p.status,true,NULL::uuid
 FROM payment_attempts p JOIN billing_accounts b ON b.tenant_id=p.tenant_id AND b.id=p.account_id
 WHERE p.tenant_id=$1 AND b.patient_id=$2
 UNION ALL
 SELECT 'recorded_payment',e.id,e.created_at,e.account_id,b.content->>'visit_id',NULL::uuid,
 -e.effect_cents,0,0,true,e.content->>'reference',
 CASE WHEN EXISTS(SELECT 1 FROM billing_entries reversal WHERE reversal.tenant_id=e.tenant_id AND reversal.reverses_id=e.id) THEN 'reversed' ELSE 'recorded' END,
 coalesce(e.content->>'test_mode'='true',false),NULL::uuid
 FROM billing_entries e JOIN billing_accounts b ON b.tenant_id=e.tenant_id AND b.id=e.account_id
 WHERE e.tenant_id=$1 AND b.patient_id=$2 AND e.kind='payment' AND e.content->>'party'='patient'
 AND NOT(e.content ?| ARRAY['copay_receipt_id','managed_payment_id','invoice_checkout_operation_id'])
 AND NOT EXISTS(SELECT 1 FROM billing_copay_allocations x WHERE x.tenant_id=e.tenant_id AND x.entry_id=e.id)
 AND NOT EXISTS(SELECT 1 FROM payment_ledger_links x WHERE x.tenant_id=e.tenant_id AND x.entry_id=e.id)
), filtered AS (SELECT * FROM rows WHERE test_activity=$3)
SELECT to_jsonb(f) FROM filtered f
WHERE ($4::text IS NULL OR (f.created_at,f.kind,f.id)<(SELECT created_at,kind,id FROM filtered WHERE kind=$4 AND id=$5))
ORDER BY created_at DESC,kind DESC,id DESC LIMIT $6"#;
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct HistoryQuery {
    mode: Option<String>,
    after: Option<String>,
    limit: Option<i64>,
}
pub(super) fn router() -> Router<State> {
    Router::new().route("/api/v1/billing/patients/{id}/payment-history", get(read))
}
async fn read(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(patient_id): Path<Uuid>,
    Query(q): Query<HistoryQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    crate::access_policies::require_native(&s, &a, "billing", "view").await?;
    let mode = q.mode.as_deref().unwrap_or("recorded");
    choice(mode, &["recorded", "test"])?;
    let limit = q.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(Error::Invalid(
            "payment history limit must be between 1 and 100",
        ));
    }
    let (kind, id) = match q.after {
        None => (None, None),
        Some(v) => {
            let (kind, id) = v
                .split_once(':')
                .ok_or(Error::Invalid("invalid payment history cursor"))?;
            choice(
                kind,
                &[
                    "copay",
                    "account_payment",
                    "recorded_payment",
                    "invoice_checkout",
                ],
            )?;
            let id = Uuid::parse_str(id)
                .map_err(|_| Error::Invalid("invalid payment history cursor"))?;
            (Some(kind.to_owned()), Some(id))
        }
    };
    let mut tx = db(&s)?.begin().await?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(patient_id)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let mut rows: Vec<Value> = sqlx::query_scalar(ROWS)
        .bind(a.tenant_id)
        .bind(patient_id)
        .bind(mode == "test")
        .bind(kind)
        .bind(id)
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await?;
    // A void or unresolved receipt must not advertise spendable credit.
    for row in &mut rows {
        if ["voided", "needs_review"].contains(&row["status"].as_str().unwrap_or_default()) {
            row["unapplied_cents"] = json!(0);
        }
    }
    let next = if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        rows.last().map(|r| {
            format!(
                "{}:{}",
                r["kind"].as_str().unwrap(),
                r["id"].as_str().unwrap()
            )
        })
    } else {
        None
    };
    crate::postgres::audit(
        &mut tx,
        &a,
        "billing.patient_payment_history_read",
        patient_id,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"patient_id":patient_id,"mode":mode,"currency":"USD","items":rows,"next_cursor":next}),
    ))
}
