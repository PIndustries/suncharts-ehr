// SPDX-License-Identifier: AGPL-3.0-only
use super::*;

pub(super) fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/patients/{p}/billing/accounts/{id}/denial",
            post(resolve_denial),
        )
        .route(
            "/api/v1/patients/{p}/billing/statements/{id}/deliveries",
            get(deliveries).post(send_statement),
        )
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Resolution {
    request_id: Uuid,
    claim_id: Uuid,
    action: String,
    reason: String,
}
async fn resolve_denial(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<Resolution>,
) -> Result<Json<Value>> {
    write(&a)?;
    if v.request_id.is_nil() {
        return Err(Error::Invalid("A request ID is required."));
    }
    crate::access_policies::require_native(&s, &a, "claims", "edit").await?;
    text(&v.reason, 1000)?;
    choice(&v.action, &["patient_balance", "write_off"])?;
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let b = account_row(&mut tx, &a, p, id).await?;
    let claim = crate::claims::claim_row(&mut tx, &a, v.claim_id).await?;
    if claim.account_id != id || claim.patient_id != p {
        return Err(Error::NotFound);
    }
    let prior:Option<(Uuid,String,String)>=sqlx::query_as("SELECT request_id,action,reason FROM billing_denial_resolutions WHERE tenant_id=$1 AND claim_id=$2").bind(a.tenant_id).bind(v.claim_id).fetch_optional(&mut *tx).await?;
    if let Some((request, action, reason)) = prior {
        if request != v.request_id || action != v.action || reason != v.reason {
            return Err(Error::Conflict(
                "This denial was already reviewed. Refresh the encounter.",
            ));
        }
        return Ok(Json(json!({"saved":true})));
    }
    if b.status != "posted" || b.version != crate::expected(&h)? {
        return Err(Error::Conflict(
            "The account changed. Refresh before continuing.",
        ));
    }
    let rows =
        crate::visit_billing::balances(&mut tx, a.tenant_id, Some(&[p]), Some(&[id]), None).await?;
    let row = rows.first().ok_or(Error::NotFound)?;
    if claim.status != "adjudicated"
        || row["denied"] != true
        || row["claim_id"] != json!(v.claim_id)
    {
        return Err(Error::Conflict(
            "Only a current payer denial can be moved to the patient balance or written off.",
        ));
    }
    let balance = row["balance_cents"].as_i64().unwrap_or(0);
    if balance <= 0 {
        return Err(Error::Conflict("There is no balance left to adjust."));
    }
    let reserved:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM payment_attempts WHERE tenant_id=$1 AND account_id=$2 AND status IN ('creating','open','needs_review')) OR EXISTS(SELECT 1 FROM invoice_checkout_attempts WHERE tenant_id=$1 AND account_id=$2 AND status IN ('creating','open','needs_review')) OR EXISTS(SELECT 1 FROM copay_checkout_attempts c JOIN visits v ON v.tenant_id=c.tenant_id AND v.appointment_id=c.appointment_id WHERE c.tenant_id=$1 AND v.id=$3 AND c.status IN ('creating','open','needs_review'))").bind(a.tenant_id).bind(id).bind(b.content["visit_id"].as_str().and_then(|v|Uuid::parse_str(v).ok())).fetch_one(&mut *tx).await?;
    if reserved {
        return Err(Error::Conflict(
            "Finish or cancel the open payment before changing this balance.",
        ));
    }
    if v.action == "write_off" {
        let entry = Uuid::new_v4();
        let content = json!({"kind":"adjustment_credit","amount_cents":balance,"party":"insurer","method":"none","reference":v.claim_id,"occurred_on":Utc::now().date_naive(),"reason":v.reason});
        sqlx::query("INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id) VALUES($1,$2,$3,'adjustment_credit',$4,$5,$6,$7,$8)").bind(a.tenant_id).bind(entry).bind(id).bind(-balance).bind(content).bind(v.request_id).bind(digest(&v)?).bind(a.sub).execute(&mut *tx).await?;
        sqlx::query("UPDATE billing_accounts SET version=version+1 WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        account_revision(&mut tx, &a, p, id, &v.reason).await?;
    } else {
        let (credit, _) = patient_ledger_totals(&mut tx, a.tenant_id, id).await?;
        issue_patient_invoice(
            &mut tx,
            &a,
            p,
            &b,
            (v.request_id, &digest(&v)?),
            (balance + credit).clamp(0, b.total_cents),
            &format!("Denied claim moved to patient balance: {}", v.reason),
        )
        .await?;
    }
    sqlx::query("INSERT INTO billing_denial_resolutions(tenant_id,claim_id,request_id,action,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(v.claim_id).bind(v.request_id).bind(v.action).bind(v.reason).bind(a.sub).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "billing.denial_resolved", v.claim_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"saved":true})))
}
async fn invoice(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    id: Uuid,
) -> Result<Value> {
    sqlx::query_scalar("SELECT to_jsonb(i)-'tenant_id'-'creation_hash'-'request_id' FROM patient_invoice_snapshots i WHERE tenant_id=$1 AND patient_id=$2 AND id=$3")
        .bind(a.tenant_id).bind(p).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn deliveries(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    invoice(&mut tx, &a, p, id).await?;
    let portal:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patient_portal_accounts WHERE tenant_id=$1 AND patient_id=$2 AND status='active')").bind(a.tenant_id).bind(p).fetch_one(&mut *tx).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',d.id,'at',d.created_at,'channel',d.channel,'actor_id',d.actor_id,'actor_label',coalesce(nullif(u.display_name,''),u.email)) FROM billing_statement_deliveries d JOIN browser_users u ON u.tenant_id=d.tenant_id AND u.id=d.actor_id WHERE d.tenant_id=$1 AND d.invoice_id=$2 ORDER BY d.created_at DESC,d.id").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "billing.statement_deliveries_read", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"portal":portal,"items":items})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Send {
    request_id: Uuid,
}
async fn send_statement(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    Json(v): Json<Send>,
) -> Result<Json<Value>> {
    write(&a)?;
    if v.request_id.is_nil() {
        return Err(Error::Invalid("A request ID is required."));
    }
    let mut tx = db(&s)?.begin().await?;
    tenant_lock(&mut tx, &a).await?;
    let i = invoice(&mut tx, &a, p, id).await?;
    let prior: Option<Uuid> = sqlx::query_scalar(
        "SELECT invoice_id FROM billing_statement_deliveries WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(prior) = prior {
        if prior != id {
            return Err(Error::Conflict(
                "Request already used for another statement.",
            ));
        }
        return Ok(Json(json!({"sent":true,"channel":"portal"})));
    }
    let portal:Uuid=sqlx::query_scalar("SELECT id FROM patient_portal_accounts WHERE tenant_id=$1 AND patient_id=$2 AND status='active' FOR SHARE").bind(a.tenant_id).bind(p).fetch_optional(&mut *tx).await?.ok_or(Error::Conflict("No sending channel is configured"))?;
    let thread = Uuid::new_v4();
    // The portal statement route authenticates the patient and reads only a delivered snapshot.
    let body=format!("Your statement is ready. Amount due when prepared: ${:.2}. View and print your statement: {}/patient-portal#statement={id}",i["snapshot"]["amount_due_cents"].as_i64().unwrap_or(0) as f64/100.0,s.browser.as_ref().ok_or(Error::NotFound)?.origin());
    sqlx::query("INSERT INTO patient_portal_threads(tenant_id,id,patient_id,account_id,kind,subject,request_id,request_hash) VALUES($1,$2,$3,$4,'message','Your statement',$5,$6)").bind(a.tenant_id).bind(thread).bind(p).bind(portal).bind(v.request_id).bind(digest(&(id,v.request_id))?).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO patient_portal_messages(tenant_id,id,thread_id,thread_version,author_kind,author_id,body,request_id) VALUES($1,$2,$3,1,'staff',$4,$5,$6)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(thread).bind(a.sub).bind(body).bind(v.request_id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO billing_statement_deliveries(tenant_id,id,invoice_id,request_id,channel,actor_id,thread_id) VALUES($1,$2,$3,$4,'portal',$5,$6)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(id).bind(v.request_id).bind(a.sub).bind(thread).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO patient_portal_events(tenant_id,patient_id,actor_id,actor_kind,action,resource_id,version) VALUES($1,$2,$3,'staff','statement_sent',$4,1)").bind(a.tenant_id).bind(p).bind(a.sub).bind(thread).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "billing.statement_sent", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"sent":true,"channel":"portal"})))
}
