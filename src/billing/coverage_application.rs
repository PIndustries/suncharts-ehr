// SPDX-License-Identifier: AGPL-3.0-only
//! Apply insurance to posted self-pay charges before any claim has been prepared.
use super::*;

pub(super) fn router() -> Router<State> {
    Router::new().route(
        "/api/v1/patients/{p}/billing/accounts/{id}/coverage",
        get(options).post(apply),
    )
}

#[derive(Serialize, sqlx::FromRow)]
struct CoverageChoice {
    id: Uuid,
    version: i64,
    payer_name: String,
    plan_name: String,
    priority: String,
    member_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Application {
    request_id: Uuid,
    coverage_id: Uuid,
    coverage_version: i64,
    reason: String,
}

async fn billing_edit(tx: &mut Transaction<'_, Postgres>, a: &Actor) -> Result<()> {
    write(a)?;
    if !crate::access_policies::allows(tx, a, "billing", "edit").await? {
        return Err(Error::Forbidden);
    }
    Ok(())
}

fn stored_content(account: &Account) -> Result<AccountContent> {
    serde_json::from_value(account.content.clone())
        .map_err(|_| Error::Invalid("invalid stored billing account"))
}

async fn blocked_reason(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    account: &Account,
    content: &AccountContent,
) -> Result<Option<&'static str>> {
    if account.status != "posted" {
        return Ok(Some(
            "Insurance can be applied here only after charges are posted.",
        ));
    }
    if content.coverage_id.is_some() || account.coverage_snapshot.is_some() {
        return Ok(Some("These charges already have insurance applied."));
    }
    let Some(visit_id) = content
        .visit_id
        .filter(|_| account.source_history_id.is_none())
    else {
        return Ok(Some(
            "Open the original signed encounter to review these charges.",
        ));
    };
    let visit: Option<(String, Uuid)> = sqlx::query_as(
        "SELECT status,appointment_id FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND id=$3",
    )
    .bind(a.tenant_id)
    .bind(account.patient_id)
    .bind(visit_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((_, appointment_id)) = visit.filter(|(status, _)| status == "signed") else {
        return Ok(Some(
            "This encounter must be signed before insurance can be applied.",
        ));
    };

    // A self-pay account normally has no claims. Even a canceled record may represent
    // an export, an in-flight delivery or an older charge account for this same visit.
    let claim_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM ehr_claims c JOIN billing_accounts b
              ON b.tenant_id=c.tenant_id AND b.id=c.account_id AND b.patient_id=c.patient_id
            WHERE c.tenant_id=$1 AND c.patient_id=$2 AND (c.account_id=$3 OR b.visit_id=$4)
        )",
    )
    .bind(a.tenant_id)
    .bind(account.patient_id)
    .bind(account.id)
    .bind(visit_id)
    .fetch_one(&mut **tx)
    .await?;
    if claim_exists {
        return Ok(Some("This visit already has claim history. Review the existing claim before changing billing coverage."));
    }

    let (ledger_effect, unsupported_ledger): (i64, bool) = sqlx::query_as(
        "SELECT coalesce(sum(e.effect_cents),0)::bigint,
            coalesce(bool_or(e.kind<>'reversal'
                AND NOT EXISTS(SELECT 1 FROM billing_entries r WHERE r.tenant_id=e.tenant_id
                    AND r.account_id=e.account_id AND r.reverses_id=e.id)
                AND (e.content->>'party' IS DISTINCT FROM 'patient'
                    OR (e.kind<>'payment' AND NOT (e.kind='adjustment_debit' AND (
                        e.content->>'managed_payment_id' IS NOT NULL OR e.content->>'hosted_copay_operation_id' IS NOT NULL
                        OR e.content->>'invoice_checkout_operation_id' IS NOT NULL))))),false)
         FROM billing_entries e WHERE e.tenant_id=$1 AND e.account_id=$2",
    )
    .bind(a.tenant_id)
    .bind(account.id)
    .fetch_one(&mut **tx)
    .await?;
    if ledger_effect <= -account.total_cents || unsupported_ledger {
        return Ok(Some("The balance is settled or has accounting adjustments. Review the ledger before changing billing coverage."));
    }

    let (pending_payment, invoice_or_plan): (bool, bool) = sqlx::query_as(
        "WITH appointment_checkouts AS (
            SELECT o.receipt_id,o.status FROM copay_checkout_attempts o WHERE o.tenant_id=$1 AND o.patient_id=$3
              AND (o.appointment_id=$4 OR EXISTS(SELECT 1 FROM copay_checkout_splits s
                    WHERE s.tenant_id=o.tenant_id AND s.operation_id=o.id AND s.appointment_id=$4))
         )
         SELECT
            EXISTS(SELECT 1 FROM payment_attempts o WHERE o.tenant_id=$1 AND o.account_id=$2
                   AND (o.status IN ('creating','open','needs_review') OR EXISTS(
                       SELECT 1 FROM payment_refund_requests r WHERE r.tenant_id=o.tenant_id
                         AND r.payment_id=o.id AND r.status='pending')))
            OR EXISTS(SELECT 1 FROM invoice_checkout_attempts o WHERE o.tenant_id=$1 AND o.account_id=$2
                   AND o.status IN ('creating','open','needs_review'))
            OR EXISTS(SELECT 1 FROM appointment_checkouts o WHERE o.status IN ('creating','open','needs_review'))
            OR EXISTS(SELECT 1 FROM billing_receipt_actions r JOIN billing_copay_receipts c
                    ON c.tenant_id=r.tenant_id AND c.id=r.receipt_id
                    WHERE r.tenant_id=$1 AND c.patient_id=$3 AND r.status='pending'
                       AND (r.account_id=$2 OR c.appointment_id=$4 OR EXISTS(
                            SELECT 1 FROM appointment_checkouts o WHERE o.receipt_id=r.receipt_id)
                         OR EXISTS(SELECT 1 FROM billing_copay_allocations x WHERE x.tenant_id=r.tenant_id
                                     AND x.receipt_id=r.receipt_id AND x.account_id=$2))),
            EXISTS(SELECT 1 FROM automatic_patient_invoice_operations o
                    WHERE o.tenant_id=$1 AND o.account_id=$2 AND (o.closed_at IS NULL OR o.status='paid'))
            OR EXISTS(SELECT 1 FROM connected_payment_invoices o WHERE o.tenant_id=$1 AND o.account_id=$2
                    AND o.status NOT IN ('void','uncollectible','cancelled','expired'))
            OR EXISTS(SELECT 1 FROM patient_installment_plans p WHERE p.tenant_id=$1 AND p.account_id=$2
                    AND p.cancelled_at IS NULL)",
    )
    .bind(a.tenant_id)
    .bind(account.id)
    .bind(account.patient_id)
    .bind(appointment_id)
    .fetch_one(&mut **tx)
    .await?;
    if pending_payment {
        return Ok(Some("A payment or refund is still in progress. Resolve it before changing billing coverage."));
    }
    if invoice_or_plan {
        return Ok(Some("An electronic invoice or payment plan needs review before billing coverage can change."));
    }
    Ok(None)
}

async fn options(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let mut tx = db(&s)?.begin().await?;
    billing_edit(&mut tx, &a).await?;
    let account = account_row(&mut tx, &a, p, id).await?;
    let content = stored_content(&account)?;
    let mut blocked = blocked_reason(&mut tx, &a, &account, &content).await?;
    let mut choices: Vec<CoverageChoice> = Vec::new();
    if blocked.is_none() {
        choices = sqlx::query_as(
            "SELECT c.id,c.version,payer.content->>'name' AS payer_name, c.content->>'plan_name' AS plan_name,
                    c.content->>'priority' AS priority, c.content->>'member_id' AS member_id
             FROM insurance_coverages c JOIN ehr_payers payer
                ON payer.tenant_id=c.tenant_id AND payer.id=c.payer_id
             WHERE c.tenant_id=$1 AND c.patient_id=$2 AND c.content->>'status'='active'
               AND payer.content->'active'='true'::jsonb AND (c.content->>'effective_date')::date<=$3
               AND coalesce((c.content->>'end_date')::date,'infinity'::date)>=$3
             ORDER BY CASE c.content->>'priority' WHEN 'primary' THEN 1 WHEN 'secondary' THEN 2 ELSE 3 END,
                      payer.content->>'name',c.id",
        )
        .bind(a.tenant_id)
        .bind(p)
        .bind(content.service_date)
        .fetch_all(&mut *tx)
        .await?;
        if choices.is_empty() {
            blocked = Some("No active coverage on file was effective on the service date.");
        }
    }
    crate::postgres::audit(&mut tx, &a, "billing.coverage_options_read", id).await?;
    tx.commit().await?;
    let mut result = json!({
        "account_id": id,
        "account_version": account.version,
        "service_date": content.service_date,
        "choices": choices
    });
    if let Some(reason) = blocked {
        result["blocked_reason"] = json!(reason);
    }
    Ok(Json(result))
}

async fn apply(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(mut v): Json<Application>,
) -> Result<Json<Account>> {
    v.reason = v.reason.trim().to_owned();
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    if v.request_id.is_nil() {
        return Err(Error::Invalid("A request ID is required."));
    }
    if v.coverage_version < 1 {
        return Err(Error::Invalid("Choose a current coverage version."));
    }
    let hash = digest(&(p, id, version, &v))?;
    let mut tx = db(&s)?.begin().await?;
    billing_edit(&mut tx, &a).await?;
    tenant_lock(&mut tx, &a).await?;
    let old = account_row(&mut tx, &a, p, id).await?;
    let prior: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT account_id,creation_hash FROM billing_account_coverage_applications
         WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((prior_id, prior_hash)) = prior {
        if prior_id != id || prior_hash != hash {
            return Err(Error::Conflict(
                "Request ID reused for a different coverage application.",
            ));
        }
        return Ok(Json(old));
    }
    if old.version != version {
        return Err(Error::Conflict(
            "These charges changed. Reopen Apply insurance and review the current charges.",
        ));
    }
    let mut content = stored_content(&old)?;
    if let Some(reason) = blocked_reason(&mut tx, &a, &old, &content).await? {
        return Err(Error::Conflict(reason));
    }
    if coverage_row(&mut tx, &a, p, v.coverage_id).await?.version != v.coverage_version {
        return Err(Error::Conflict(
            "The insurance record changed. Reopen Apply insurance and review the current coverage.",
        ));
    }
    content.coverage_id = Some(v.coverage_id);
    let snapshot = account_links(&mut tx, &a, p, &content, old.source_history_id, true)
        .await?
        .ok_or(Error::Invalid("Choose a coverage to apply."))?;

    sqlx::query("SET LOCAL suncharts.billing_coverage_application = 'on'")
        .execute(&mut *tx)
        .await?;
    let changed = sqlx::query(
        "UPDATE billing_accounts SET coverage_id=$4,coverage_snapshot=$5,
            content=jsonb_set(content,'{coverage_id}',to_jsonb($4::uuid)),version=version+1
         WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 AND status='posted' AND coverage_id IS NULL",
    )
    .bind(a.tenant_id)
    .bind(p)
    .bind(id)
    .bind(v.coverage_id)
    .bind(snapshot)
    .execute(&mut *tx)
    .await?;
    if changed.rows_affected() != 1 {
        return Err(Error::Conflict(
            "These charges changed. Reopen Apply insurance and review the current charges.",
        ));
    }
    let row = account_revision(&mut tx, &a, p, id, &v.reason).await?;
    sqlx::query(
        "INSERT INTO billing_account_coverage_applications
            (tenant_id,account_id,patient_id,coverage_id,account_version,request_id,creation_hash,actor_id,reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    )
    .bind(a.tenant_id)
    .bind(id)
    .bind(p)
    .bind(v.coverage_id)
    .bind(row.version)
    .bind(v.request_id)
    .bind(hash)
    .bind(a.sub)
    .bind(&v.reason)
    .execute(&mut *tx)
    .await?;
    crate::postgres::audit(&mut tx, &a, "billing.coverage_applied", id).await?;
    tx.commit().await?;
    Ok(Json(row))
}
