// SPDX-License-Identifier: AGPL-3.0-only
//! Read-only native receivables and receipts. Processor objects are not the ledger.
use super::*;

const ACCOUNTS: &str = r#"WITH account_rows AS (
 SELECT b.id,b.patient_id,p.family_name||', '||p.given_name AS patient_name,p.mrn,
 b.status,b.version,b.total_cents,b.created_at,b.content->>'service_date' AS service_date,
 b.coverage_snapshot->'payer'->'content'->>'name' AS payer_name,
 CASE WHEN b.status='posted' THEN b.total_cents+coalesce((SELECT sum(e.effect_cents) FROM billing_entries e WHERE e.tenant_id=b.tenant_id AND e.account_id=b.id),0) END AS account_balance_cents,
 i.id AS invoice_id,i.created_at AS invoice_created_at,i.snapshot->'amount_due_cents' AS invoice_due_cents,
 i.snapshot->'responsibility_cents' AS reviewed_responsibility_cents,
 i.snapshot->'credit_balance_cents' AS invoice_credit_cents,
 i.id IS NOT NULL AND (b.status<>'posted' OR b.version<>i.account_version OR EXISTS(SELECT 1 FROM billing_entries e WHERE e.tenant_id=b.tenant_id AND e.account_id=b.id AND e.created_at>i.created_at)) AS invoice_needs_review,
 coalesce((i.snapshot->>'test_activity')::boolean,false) OR EXISTS(SELECT 1 FROM billing_entries e WHERE e.tenant_id=b.tenant_id AND e.account_id=b.id AND e.content->>'test_mode'='true') AS test_activity
 FROM billing_accounts b JOIN patients p ON p.tenant_id=b.tenant_id AND p.id=b.patient_id
 LEFT JOIN LATERAL (SELECT * FROM patient_invoice_snapshots i WHERE i.tenant_id=b.tenant_id AND i.account_id=b.id ORDER BY i.created_at DESC,i.id DESC LIMIT 1) i ON true
 WHERE b.tenant_id=$1 AND ($3::uuid IS NULL OR b.patient_id=$3)
), filtered AS (SELECT * FROM account_rows WHERE test_activity=$2)
"#;
const COPAYS: &str = r#"WITH receipt_rows AS (
 SELECT r.id,r.patient_id,p.family_name||', '||p.given_name AS patient_name,p.mrn,
 r.appointment_id,r.amount_cents,r.method,r.occurred_on,r.created_at,
 o.id AS hosted_operation_id,o.livemode,o.status AS hosted_status,
 coalesce(o.refunded_cents,0) AS refunded_cents,
 coalesce((SELECT sum(x.amount_cents) FROM billing_copay_allocations x WHERE x.tenant_id=r.tenant_id AND x.receipt_id=r.id),0)::bigint AS allocated_cents,
 coalesce((SELECT sum(x.amount_cents) FROM billing_copay_allocations x JOIN billing_entries e ON e.tenant_id=x.tenant_id AND e.reverses_id=x.entry_id WHERE x.tenant_id=r.tenant_id AND x.receipt_id=r.id),0)::bigint AS reversed_cents,
 coalesce((SELECT sum(f.unapplied_cents) FROM copay_checkout_refund_events f WHERE f.tenant_id=o.tenant_id AND f.operation_id=o.id),0)::bigint AS refunded_unapplied_cents,
 EXISTS(SELECT 1 FROM billing_copay_voids v WHERE v.tenant_id=r.tenant_id AND v.receipt_id=r.id) AS voided,
 coalesce(o.livemode=false,false) AS test_activity
 FROM billing_copay_receipts r JOIN patients p ON p.tenant_id=r.tenant_id AND p.id=r.patient_id
 LEFT JOIN copay_checkout_attempts o ON o.tenant_id=r.tenant_id AND o.receipt_id=r.id
 WHERE r.tenant_id=$1 AND ($3::uuid IS NULL OR r.patient_id=$3)
), filtered AS (
 SELECT *,NOT voided AND (reversed_cents>0 OR coalesce(hosted_status='needs_review',false)) AS needs_review,
 CASE WHEN voided OR reversed_cents>0 OR hosted_status='needs_review' THEN 0 ELSE greatest(0,amount_cents-allocated_cents-refunded_unapplied_cents) END AS usable_unapplied_cents,
 CASE WHEN voided THEN 0 ELSE greatest(0,amount_cents-refunded_cents) END AS net_received_cents
 FROM receipt_rows WHERE test_activity=$2
)
"#;

const ACCOUNT_SUMMARY: &str = "SELECT jsonb_build_object('accounts',count(*),'latest_invoices',count(invoice_id),'invoice_review_count',count(*) FILTER(WHERE invoice_needs_review),'open_invoice_count',count(*) FILTER(WHERE invoice_id IS NOT NULL AND NOT invoice_needs_review AND (invoice_due_cents #>> '{}')::bigint>0),'reviewed_patient_due_cents',coalesce(sum((invoice_due_cents #>> '{}')::bigint) FILTER(WHERE invoice_id IS NOT NULL AND NOT invoice_needs_review),0),'posted_gross_cents',coalesce(sum(total_cents) FILTER(WHERE status='posted'),0),'posted_account_balance_cents',coalesce(sum(account_balance_cents),0)) FROM filtered";
/// The receivable totals shown as "Patient owes" on the billing pages. Every caller that shows
/// a patient balance reads it here so the figures always agree.
pub(crate) async fn account_summary(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    test: bool,
    patient: Option<Uuid>,
) -> Result<Value> {
    Ok(sqlx::query_scalar(&format!("{ACCOUNTS} {ACCOUNT_SUMMARY}"))
        .bind(tenant)
        .bind(test)
        .bind(patient)
        .fetch_one(&mut **tx)
        .await?)
}
pub(super) fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/billing/overview", get(overview))
        .route("/api/v1/billing/patients", get(patients))
        .route(
            "/api/v1/billing/patients/{id}/invoices",
            get(patient_invoice_history),
        )
        .route("/api/v1/billing/invoices/{id}", get(invoice))
        .route("/api/v1/billing/copay-receipts/{id}", get(receipt))
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct OverviewQuery {
    patient_id: Option<Uuid>,
    mode: Option<String>,
    accounts_after: Option<Uuid>,
    copays_after: Option<Uuid>,
    limit: Option<i64>,
}
async fn overview(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<OverviewQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mode = q.mode.as_deref().unwrap_or("recorded");
    choice(mode, &["recorded", "test"])?;
    let limit = q.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(Error::Invalid(
            "billing overview limit must be between 1 and 100",
        ));
    }
    let mut tx = db(&s)?.begin().await?;
    // Lists and aggregate totals describe one database snapshot, including while
    // another staff member posts a payment. The only write here is the read audit.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let patient = match q.patient_id {
        Some(id) => Some(patient_summary(&mut tx, &a, id).await?),
        None => None,
    };
    let account_summary =
        account_summary(&mut tx, a.tenant_id, mode == "test", q.patient_id).await?;
    let copay_summary:Value=sqlx::query_scalar(&format!("{COPAYS} SELECT jsonb_build_object('receipts',count(*),'net_received_cents',coalesce(sum(net_received_cents),0),'usable_unapplied_cents',coalesce(sum(usable_unapplied_cents),0),'review_count',count(*) FILTER(WHERE needs_review),'void_count',count(*) FILTER(WHERE voided)) FROM filtered"))
        .bind(a.tenant_id).bind(mode=="test").bind(q.patient_id).fetch_one(&mut *tx).await?;
    let accounts = page(
        &mut tx,
        &a,
        ACCOUNTS,
        mode == "test",
        q.patient_id,
        q.accounts_after,
        limit,
    )
    .await?;
    let copays = page(
        &mut tx,
        &a,
        COPAYS,
        mode == "test",
        q.patient_id,
        q.copays_after,
        limit,
    )
    .await?;
    crate::postgres::audit(&mut tx, &a, "billing.overview_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"mode":mode,"patient":patient,"currency":"USD","summary":{"accounts":account_summary,"copays":copay_summary},"accounts":accounts,"copays":copays,"invoice_policy":"Only the latest invoice per account is counted. Current patient amount is not asserted after account or ledger changes. Historical invoices remain unchanged.","collection_policy":"Recorded receipts net of verified refunds; allocations are not additional collections. Test card receipts are separate."}),
    ))
}
async fn page(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    cte: &str,
    test: bool,
    patient: Option<Uuid>,
    after: Option<Uuid>,
    limit: i64,
) -> Result<Value> {
    let mut rows:Vec<Value>=sqlx::query_scalar(&format!("{cte} SELECT to_jsonb(f) FROM filtered f WHERE ($4::uuid IS NULL OR (f.created_at,f.id)<(SELECT created_at,id FROM filtered WHERE id=$4)) ORDER BY f.created_at DESC,f.id DESC LIMIT $5"))
        .bind(a.tenant_id).bind(test).bind(patient).bind(after).bind(limit+1).fetch_all(&mut **tx).await?;
    let next = if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        rows.last().map(|row| row["id"].clone())
    } else {
        None
    };
    Ok(json!({"items":rows,"next_cursor":next}))
}
async fn invoice(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let row:Value=sqlx::query_scalar("SELECT to_jsonb(i)-'tenant_id'-'creation_hash'-'request_id' FROM patient_invoice_snapshots i WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    crate::postgres::audit(&mut tx, &a, "billing.invoice_read", id).await?;
    tx.commit().await?;
    Ok(Json(row))
}
async fn receipt(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let (patient,appointment,p):(Value,Value,Uuid)=sqlx::query_as("SELECT jsonb_build_object('given_name',p.given_name,'family_name',p.family_name,'mrn',p.mrn),jsonb_build_object('id',a.id,'starts_at',a.starts_at),r.patient_id FROM billing_copay_receipts r JOIN patients p ON p.tenant_id=r.tenant_id AND p.id=r.patient_id JOIN appointments a ON a.tenant_id=r.tenant_id AND a.id=r.appointment_id AND a.patient_id=r.patient_id WHERE r.tenant_id=$1 AND r.id=$2")
        .bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let row = copay_rows(&mut tx, &a, p, Some(id))
        .await?
        .into_iter()
        .next()
        .ok_or(Error::NotFound)?;
    crate::postgres::audit(&mut tx, &a, "billing.copay_receipt_read", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"receipt":row,"context":{"patient":patient,"appointment":appointment,"practiceName":crate::branding::InstanceBranding::from_env().display_name,"printedAt":Utc::now()}}),
    ))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct PatientsQuery {
    q: Option<String>,
    after: Option<Uuid>,
    limit: Option<i64>,
}
fn page_limit(value: Option<i64>) -> Result<i64> {
    let limit = value.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(Error::Invalid(
            "billing page limit must be between 1 and 100",
        ));
    }
    Ok(limit)
}
async fn patient_summary(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Value> {
    sqlx::query_scalar("SELECT jsonb_build_object('id',p.id,'given_name',p.given_name,'family_name',p.family_name,'mrn',p.mrn,'archived',coalesce((SELECT e.archived FROM patient_lifecycle_events e WHERE e.tenant_id=p.tenant_id AND e.patient_id=p.id ORDER BY e.version DESC LIMIT 1),false)) FROM patients p WHERE p.tenant_id=$1 AND p.id=$2")
        .bind(a.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
fn paginated(mut rows: Vec<Value>, limit: i64) -> Value {
    let next = if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        rows.last().map(|row| row["id"].clone())
    } else {
        None
    };
    json!({"items":rows,"next_cursor":next})
}
async fn patients(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<PatientsQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    let limit = page_limit(q.limit)?;
    let search = q.q.unwrap_or_default().trim().to_owned();
    if search.chars().count() > 120 {
        return Err(Error::Invalid(
            "patient search must be at most 120 characters",
        ));
    }
    let pattern = format!(
        "%{}%",
        search
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let mut tx = db(&s)?.begin().await?;
    let rows: Vec<Value> = sqlx::query_scalar(r#"WITH filtered AS (
        SELECT p.id,p.given_name,p.family_name,p.mrn,
        coalesce((SELECT e.archived FROM patient_lifecycle_events e WHERE e.tenant_id=p.tenant_id AND e.patient_id=p.id ORDER BY e.version DESC LIMIT 1),false) AS archived
        FROM patients p WHERE p.tenant_id=$1 AND (p.given_name||' '||p.family_name ILIKE $2 OR p.family_name||', '||p.given_name ILIKE $2 OR p.mrn ILIKE $2)
    ) SELECT to_jsonb(f) FROM filtered f WHERE ($3::uuid IS NULL OR (f.family_name,f.given_name,f.id)>(SELECT family_name,given_name,id FROM filtered WHERE id=$3))
    ORDER BY f.family_name,f.given_name,f.id LIMIT $4"#)
        .bind(a.tenant_id).bind(pattern).bind(q.after).bind(limit+1).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "billing.patients_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(paginated(rows, limit)))
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct InvoiceHistoryQuery {
    mode: Option<String>,
    after: Option<Uuid>,
    limit: Option<i64>,
}
async fn patient_invoice_history(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    Query(q): Query<InvoiceHistoryQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    let limit = page_limit(q.limit)?;
    let mode = q.mode.as_deref().unwrap_or("recorded");
    choice(mode, &["recorded", "test"])?;
    let mut tx = db(&s)?.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let patient = patient_summary(&mut tx, &a, id).await?;
    let rows:Vec<Value> = sqlx::query_scalar(r#"WITH invoices AS (
        SELECT i.*,b.status AS account_status,p.family_name||', '||p.given_name AS patient_name,p.mrn,
        (b.status<>'posted' OR b.version<>i.account_version OR EXISTS(SELECT 1 FROM billing_entries e WHERE e.tenant_id=b.tenant_id AND e.account_id=b.id AND e.created_at>i.created_at)) AS needs_review,
        NOT EXISTS(SELECT 1 FROM patient_invoice_snapshots newer WHERE newer.tenant_id=i.tenant_id AND newer.account_id=i.account_id AND (newer.created_at,newer.id)>(i.created_at,i.id)) AS is_latest,
        coalesce((i.snapshot->>'test_activity')::boolean,false) OR EXISTS(SELECT 1 FROM billing_entries e WHERE e.tenant_id=b.tenant_id AND e.account_id=b.id AND e.content->>'test_mode'='true') AS test_activity
        FROM patient_invoice_snapshots i JOIN billing_accounts b ON b.tenant_id=i.tenant_id AND b.id=i.account_id
        JOIN patients p ON p.tenant_id=i.tenant_id AND p.id=i.patient_id
        WHERE i.tenant_id=$1 AND i.patient_id=$2
    ), filtered AS (SELECT * FROM invoices WHERE test_activity=$3)
    SELECT to_jsonb(f)-'tenant_id'-'creation_hash'-'request_id' FROM filtered f
    WHERE ($4::uuid IS NULL OR (f.created_at,f.id)<(SELECT created_at,id FROM filtered WHERE id=$4))
    ORDER BY f.created_at DESC,f.id DESC LIMIT $5"#)
        .bind(a.tenant_id).bind(id).bind(mode=="test").bind(q.after).bind(limit+1).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "billing.patient_invoices_read", id).await?;
    tx.commit().await?;
    let mut page = paginated(rows, limit);
    page["patient"] = patient;
    page["mode"] = json!(mode);
    Ok(Json(page))
}
