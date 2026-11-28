// SPDX-License-Identifier: AGPL-3.0-only
//! Apply insurance to posted self-pay charges before any claim has been prepared.
use super::*;

pub(super) fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/billing/coverage-needs-action", get(worklist))
        .route(
            "/api/v1/patients/{p}/billing/accounts/{id}/coverage",
            get(options).post(apply),
        )
}

#[derive(Serialize, sqlx::FromRow)]
pub(super) struct CoverageChoice {
    pub(super) id: Uuid,
    payer_id: Uuid,
    version: i64,
    payer_name: String,
    plan_name: String,
    priority: String,
    member_id: String,
    electronic: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Application {
    request_id: Uuid,
    coverage_id: Uuid,
    coverage_version: i64,
    reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prepare_for_claim: Option<bool>,
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

const HAS_CLAIM: &str = r#"EXISTS(
    SELECT 1 FROM ehr_claims c JOIN billing_accounts other
      ON other.tenant_id=c.tenant_id AND other.id=c.account_id AND other.patient_id=c.patient_id
    WHERE c.tenant_id=b.tenant_id AND c.patient_id=b.patient_id
      AND (c.account_id=b.id OR other.visit_id=b.visit_id)
)"#;

async fn application_blockers(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    accounts: &[Uuid],
) -> Result<std::collections::HashMap<Uuid, String>> {
    let rows: Vec<(Uuid, Option<String>)> = sqlx::query_as(&format!(r#"
        SELECT b.id, CASE
            WHEN b.status<>'posted' THEN 'unposted'
            WHEN b.coverage_id IS NOT NULL OR b.coverage_snapshot IS NOT NULL
                 OR b.content->>'coverage_id' IS NOT NULL THEN 'already_applied'
            WHEN b.visit_id IS NULL OR b.source_history_id IS NOT NULL THEN 'open_encounter'
            WHEN v.status IS DISTINCT FROM 'signed' THEN 'sign_encounter'
            WHEN {HAS_CLAIM} THEN 'existing_claim'
            WHEN ledger.effect <= -b.total_cents OR ledger.unsupported THEN 'review_ledger'
            WHEN payments.pending THEN 'pending_payment'
            WHEN payments.invoice_or_plan THEN 'invoice_or_plan'
        END
        FROM billing_accounts b
        LEFT JOIN visits v ON v.tenant_id=b.tenant_id AND v.patient_id=b.patient_id AND v.id=b.visit_id
        CROSS JOIN LATERAL (
            SELECT coalesce(sum(e.effect_cents),0)::bigint,
            coalesce(bool_or(e.kind<>'reversal'
                AND NOT EXISTS(SELECT 1 FROM billing_entries r WHERE r.tenant_id=e.tenant_id
                    AND r.account_id=e.account_id AND r.reverses_id=e.id)
                AND (e.content->>'party' IS DISTINCT FROM 'patient'
                    OR (e.kind<>'payment' AND NOT (e.kind='adjustment_debit' AND (
                        e.content->>'managed_payment_id' IS NOT NULL OR e.content->>'hosted_copay_operation_id' IS NOT NULL
                        OR e.content->>'invoice_checkout_operation_id' IS NOT NULL))))),false)
         FROM billing_entries e WHERE e.tenant_id=b.tenant_id AND e.account_id=b.id
        ) ledger(effect,unsupported)
        CROSS JOIN LATERAL (
            WITH appointment_checkouts AS (
            SELECT o.receipt_id,o.status FROM copay_checkout_attempts o WHERE o.tenant_id=b.tenant_id AND o.patient_id=b.patient_id
              AND (o.appointment_id=v.appointment_id OR EXISTS(SELECT 1 FROM copay_checkout_splits s
                    WHERE s.tenant_id=o.tenant_id AND s.operation_id=o.id AND s.appointment_id=v.appointment_id))
         )
         SELECT
            EXISTS(SELECT 1 FROM payment_attempts o WHERE o.tenant_id=b.tenant_id AND o.account_id=b.id
                   AND (o.status IN ('creating','open','needs_review') OR EXISTS(
                       SELECT 1 FROM payment_refund_requests r WHERE r.tenant_id=o.tenant_id
                         AND r.payment_id=o.id AND r.status='pending')))
            OR EXISTS(SELECT 1 FROM invoice_checkout_attempts o WHERE o.tenant_id=b.tenant_id AND o.account_id=b.id
                   AND o.status IN ('creating','open','needs_review'))
            OR EXISTS(SELECT 1 FROM appointment_checkouts o WHERE o.status IN ('creating','open','needs_review'))
            OR EXISTS(SELECT 1 FROM billing_receipt_actions r JOIN billing_copay_receipts c
                    ON c.tenant_id=r.tenant_id AND c.id=r.receipt_id
                    WHERE r.tenant_id=b.tenant_id AND c.patient_id=b.patient_id AND r.status='pending'
                       AND (r.account_id=b.id OR c.appointment_id=v.appointment_id OR EXISTS(
                            SELECT 1 FROM appointment_checkouts o WHERE o.receipt_id=r.receipt_id)
                         OR EXISTS(SELECT 1 FROM billing_copay_allocations x WHERE x.tenant_id=r.tenant_id
                                     AND x.receipt_id=r.receipt_id AND x.account_id=b.id))),
            EXISTS(SELECT 1 FROM automatic_patient_invoice_operations o
                    WHERE o.tenant_id=b.tenant_id AND o.account_id=b.id AND (o.closed_at IS NULL OR o.status='paid'))
            OR EXISTS(SELECT 1 FROM connected_payment_invoices o WHERE o.tenant_id=b.tenant_id AND o.account_id=b.id
                    AND o.status NOT IN ('void','uncollectible','cancelled','expired'))
            OR EXISTS(SELECT 1 FROM patient_installment_plans p WHERE p.tenant_id=b.tenant_id AND p.account_id=b.id
                    AND p.cancelled_at IS NULL)
        ) payments(pending,invoice_or_plan)
        WHERE b.tenant_id=$1 AND b.id=ANY($2)
    "#)).bind(a.tenant_id).bind(accounts).fetch_all(&mut **tx).await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, code)| code.map(|code| (id, code)))
        .collect())
}

fn blocker_message(code: &str) -> &'static str {
    match code {
        "unposted" => "Insurance can be applied here only after charges are posted.",
        "already_applied" => "These charges already have insurance applied.",
        "open_encounter" => "Open the original signed encounter to review these charges.",
        "sign_encounter" => "This encounter must be signed before insurance can be applied.",
        "existing_claim" => "This visit already has claim history. Review the existing claim before changing billing coverage.",
        "review_ledger" => "The balance is settled or has accounting adjustments. Review the ledger before changing billing coverage.",
        "pending_payment" => "A payment or refund is still in progress. Resolve it before changing billing coverage.",
        "invoice_or_plan" => "An electronic invoice or payment plan needs review before billing coverage can change.",
        "no_coverage" => "No active coverage on file was effective on the service date.",
        "inactive_payer" => "The insurance company on file is inactive. Review the payer directory before applying insurance.",
        "payer_id" => "Add an electronic payer ID before applying this insurance and preparing a claim.",
        "snapshot_payer_id" => "The insurance saved with these charges has no electronic payer ID. Open the encounter to review the billing coverage.",
        _ => "Review the billing account before applying insurance.",
    }
}

async fn blocked_reason(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    account_id: Uuid,
) -> Result<Option<&'static str>> {
    Ok(application_blockers(tx, a, &[account_id])
        .await?
        .get(&account_id)
        .map(|code| blocker_message(code)))
}

const POSTED_REVIEW: &str = r#"(SELECT r.snapshot->'self_pay_reviewed_coverage_ids'
    FROM billing_account_revisions r WHERE r.tenant_id=b.tenant_id AND r.account_id=b.id AND r.snapshot->>'status'='posted'
    ORDER BY r.version LIMIT 1)"#;
const EFFECTIVE_COVERAGES: &str = r#"
    FROM insurance_coverages c JOIN ehr_payers payer ON payer.tenant_id=c.tenant_id AND payer.id=c.payer_id
    WHERE c.tenant_id=b.tenant_id AND c.patient_id=b.patient_id AND c.content->>'status'='active'
      AND (c.content->>'effective_date')::date<=b.service_date
      AND coalesce((c.content->>'end_date')::date,'infinity'::date)>=b.service_date
"#;
const CHOICE_FIELDS: &str = r#"
    c.id, c.version, payer.id AS payer_id, payer.content->>'name' AS payer_name,
    c.content->>'plan_name' AS plan_name, c.content->>'priority' AS priority,
    c.content->>'member_id' AS member_id, btrim(coalesce(payer.content->>'payer_code',''))<>'' AS electronic
"#;
const CHOICE_ORDER: &str = "CASE selected.priority WHEN 'primary' THEN 1 WHEN 'secondary' THEN 2 ELSE 3 END, selected.payer_name, selected.id";

pub(super) async fn effective_choices(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    service_date: NaiveDate,
) -> Result<Vec<CoverageChoice>> {
    Ok(sqlx::query_as(&format!(r#"
        SELECT selected.* FROM (SELECT $1::uuid AS tenant_id, $2::uuid AS patient_id, $3::date AS service_date) b
        CROSS JOIN LATERAL (SELECT {CHOICE_FIELDS}
          {EFFECTIVE_COVERAGES} AND payer.content->'active'='true'::jsonb) selected
        ORDER BY {CHOICE_ORDER}
    "#)).bind(a.tenant_id).bind(p).bind(service_date).fetch_all(&mut **tx).await?)
}

async fn reviewed_self_pay(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    account_id: Uuid,
    choices: &[CoverageChoice],
) -> Result<bool> {
    if choices.is_empty() {
        return Ok(false);
    }
    let reviewed: Option<Value> = sqlx::query_scalar(&format!(
        "SELECT {POSTED_REVIEW} FROM (SELECT $1::uuid AS tenant_id, $2::uuid AS id) b"
    ))
    .bind(a.tenant_id)
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(reviewed
        .as_ref()
        .and_then(Value::as_array)
        .is_some_and(|ids| {
            choices
                .iter()
                .all(|coverage| ids.contains(&json!(coverage.id)))
        }))
}

/// True when an effective coverage is on file but was not considered when posting as self-pay.
pub(crate) async fn added_after_posting(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    patient: Uuid,
    account_id: Uuid,
    service_date: NaiveDate,
) -> Result<bool> {
    let choices = effective_choices(tx, a, patient, service_date).await?;
    Ok(!choices.is_empty() && !reviewed_self_pay(tx, a, account_id, &choices).await?)
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
    let blockers = application_blockers(&mut tx, &a, &[account.id]).await?;
    let choices = effective_choices(&mut tx, &a, p, content.service_date).await?;
    let reviewed = reviewed_self_pay(&mut tx, &a, account.id, &choices).await?;
    let blocker = blockers
        .get(&account.id)
        .map(String::as_str)
        .or_else(|| choices.is_empty().then_some("no_coverage"));
    crate::postgres::audit(&mut tx, &a, "billing.coverage_options_read", id).await?;
    tx.commit().await?;
    let mut result = json!({
        "account_id": id,
        "account_version": account.version,
        "service_date": content.service_date,
        "choices": if blocker.is_some() { &[][..] } else { &choices },
        "recorded_choices": choices,
        "reviewed_self_pay": reviewed
    });
    if let Some(code) = blocker {
        result["blocker_code"] = json!(code);
        result["blocked_reason"] = json!(blocker_message(code));
    }
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CoveragePage {
    limit: Option<i64>,
    after: Option<String>,
}

#[derive(sqlx::FromRow)]
struct CoveragePageRow {
    account_id: Uuid,
    account_version: i64,
    patient_id: Uuid,
    patient_name: String,
    visit_id: Option<Uuid>,
    encounter_number: Option<i64>,
    service_date: NaiveDate,
    total_cents: i64,
    coverage_snapshot: Option<Value>,
}

#[derive(sqlx::FromRow)]
struct WorklistChoice {
    account_id: Uuid,
    #[sqlx(flatten)]
    choice: CoverageChoice,
}

async fn worklist(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<CoveragePage>,
) -> Result<Json<Value>> {
    a.staff()?;
    let limit = q.limit.unwrap_or(30);
    if !(1..=100).contains(&limit) {
        return Err(Error::Invalid(
            "coverage worklist limit must be between 1 and 100",
        ));
    }
    let cursor_error = Error::Invalid("invalid coverage worklist cursor");
    let (date, id) = match q.after {
        None => (None, None),
        Some(value) => {
            let (date, id) = value
                .split_once(':')
                .ok_or(Error::Invalid("invalid coverage worklist cursor"))?;
            (
                Some(
                    NaiveDate::parse_from_str(date, "%Y-%m-%d")
                        .map_err(|_| Error::Invalid("invalid coverage worklist cursor"))?,
                ),
                Some(Uuid::parse_str(id).map_err(|_| cursor_error)?),
            )
        }
    };
    let mut tx = db(&s)?.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    if !crate::access_policies::allows(&mut tx, &a, "billing", "view").await? {
        return Err(Error::Forbidden);
    }
    let can_apply_coverage =
        write(&a).is_ok() && crate::access_policies::allows(&mut tx, &a, "billing", "edit").await?;
    let can_prepare_claim = a.scheduling().is_ok()
        && crate::access_policies::allows(&mut tx, &a, "claims", "create").await?;
    let encounter_numbers = crate::postgres::ENCOUNTER_NUMBERS;
    let mut rows: Vec<CoveragePageRow> = sqlx::query_as(&format!(r#"
        WITH charges AS (
            SELECT b.*, (b.content->>'service_date')::date AS service_date
            FROM billing_accounts b WHERE b.tenant_id=$1 AND b.status='posted'
        ), encounter_numbers AS ({encounter_numbers}), page AS (
            SELECT b.* FROM charges b
            WHERE ($2::date IS NULL OR (b.service_date,b.id)>($2,$3::uuid)) AND (
                (b.coverage_id IS NULL AND b.coverage_snapshot IS NULL AND b.content->>'coverage_id' IS NULL
                 AND EXISTS(SELECT 1 {EFFECTIVE_COVERAGES}
                    AND NOT coalesce({POSTED_REVIEW} ? c.id::text,false)))
                OR (b.coverage_snapshot IS NOT NULL AND NOT {HAS_CLAIM}
                    AND EXISTS(SELECT 1 FROM billing_account_coverage_applications x
                       WHERE x.tenant_id=b.tenant_id AND x.account_id=b.id AND x.patient_id=b.patient_id))
            )
            ORDER BY b.service_date,b.id LIMIT $4
        )
        SELECT b.id AS account_id,b.version AS account_version,b.patient_id,p.family_name||', '||p.given_name AS patient_name,
            b.visit_id,n.encounter_number,b.service_date,b.total_cents,b.coverage_snapshot
        FROM page b JOIN patients p ON p.tenant_id=b.tenant_id AND p.id=b.patient_id
        LEFT JOIN encounter_numbers n ON n.id=b.visit_id
        ORDER BY b.service_date,b.id
    "#)).bind(a.tenant_id).bind(date).bind(id).bind(limit+1).fetch_all(&mut *tx).await?;
    let next_cursor = if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        rows.last()
            .map(|row| format!("{}:{}", row.service_date, row.account_id))
    } else {
        None
    };
    let ids: Vec<Uuid> = rows.iter().map(|row| row.account_id).collect();
    let unapplied_ids: Vec<Uuid> = rows
        .iter()
        .filter(|row| row.coverage_snapshot.is_none())
        .map(|row| row.account_id)
        .collect();
    let mut blockers = std::collections::HashMap::new();
    let mut choices = std::collections::HashMap::<Uuid, Vec<CoverageChoice>>::new();
    if !unapplied_ids.is_empty() {
        blockers = application_blockers(&mut tx, &a, &unapplied_ids).await?;
        let selected: Vec<WorklistChoice> = sqlx::query_as(&format!(
            r#"
            SELECT b.id AS account_id, selected.*
            FROM (SELECT id,tenant_id,patient_id,(content->>'service_date')::date AS service_date
                FROM billing_accounts WHERE tenant_id=$1 AND id=ANY($2)) b
            CROSS JOIN LATERAL (SELECT {CHOICE_FIELDS} {EFFECTIVE_COVERAGES}
                AND payer.content->'active'='true'::jsonb
                AND NOT coalesce({POSTED_REVIEW} ? c.id::text,false)) selected
            ORDER BY b.id, {CHOICE_ORDER}
        "#
        ))
        .bind(a.tenant_id)
        .bind(&unapplied_ids)
        .fetch_all(&mut *tx)
        .await?;
        for row in selected {
            choices.entry(row.account_id).or_default().push(row.choice);
        }
    }
    let mut balances = std::collections::HashMap::new();
    if !ids.is_empty() {
        for row in
            crate::visit_billing::balances(&mut tx, a.tenant_id, None, Some(&ids), None).await?
        {
            if let Some(id) = row["id"].as_str().and_then(|id| Uuid::parse_str(id).ok()) {
                balances.insert(id, row);
            }
        }
    }
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let balance = balances
            .remove(&row.account_id)
            .ok_or(Error::Invalid("posted charges have no balance"))?;
        let (state, policies, blocker) = if let Some(snapshot) = &row.coverage_snapshot {
            let coverage = &snapshot["coverage"];
            let payer = &snapshot["payer"];
            let payer_code = payer["content"]["payer_code"]
                .as_str()
                .unwrap_or_default()
                .trim();
            (
                "prepare_claim",
                vec![json!({
                    "id":coverage["id"], "version":coverage["version"], "payer_id":payer["id"],
                    "payer_name":payer["content"]["name"], "plan_name":coverage["content"]["plan_name"],
                    "priority":coverage["content"]["priority"], "member_id":coverage["content"]["member_id"],
                    "electronic": !payer_code.is_empty()
                })],
                payer_code.is_empty().then_some("snapshot_payer_id"),
            )
        } else {
            let selected = choices.remove(&row.account_id).unwrap_or_default();
            let code = blockers
                .get(&row.account_id)
                .map(String::as_str)
                .or_else(|| {
                    if selected.is_empty() {
                        Some("inactive_payer")
                    } else if selected.iter().all(|choice| !choice.electronic) {
                        Some("payer_id")
                    } else {
                        None
                    }
                });
            let choices = selected
                .into_iter()
                .map(|choice| {
                    let mut out = json!(choice);
                    if !choice.electronic {
                        out["blocker_code"] = json!("payer_id");
                        out["blocked_reason"] = json!(blocker_message("payer_id"));
                    }
                    out
                })
                .collect();
            ("apply_coverage", choices, code)
        };
        let mut item = json!({
            "account_id":row.account_id, "account_version":row.account_version, "patient_id":row.patient_id,
            "patient_name":row.patient_name, "visit_id":row.visit_id, "encounter_number":row.encounter_number,
            "service_date":row.service_date, "total_cents":row.total_cents, "patient_paid_cents":balance["patient_payments_cents"],
            "patient_owes_now_cents":balance["owes_now_cents"], "state":state, "choices":policies
        });
        if let Some(code) = blocker {
            item["blocker_code"] = json!(code);
            item["blocked_reason"] = json!(blocker_message(code));
        }
        items.push(item);
    }
    crate::postgres::audit(&mut tx, &a, "billing.coverage_worklist_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":items,"next_cursor":next_cursor,"can_apply_coverage":can_apply_coverage,
        "can_prepare_claim":can_prepare_claim}),
    ))
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
    if v.prepare_for_claim == Some(true)
        && !crate::access_policies::allows(&mut tx, &a, "claims", "create").await?
    {
        return Err(Error::Forbidden);
    }
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
    if let Some(reason) = blocked_reason(&mut tx, &a, old.id).await? {
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
    if v.prepare_for_claim == Some(true)
        && snapshot["payer"]["content"]["payer_code"]
            .as_str()
            .is_none_or(|code| code.trim().is_empty())
    {
        return Err(Error::Conflict(blocker_message("payer_id")));
    }

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
