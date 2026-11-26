// SPDX-License-Identifier: AGPL-3.0-only
//! Practice-scoped, audited staff search. No clinical note text is searched or returned.
use crate::{
    auth::Actor,
    error::{Error, Result},
    postgres::audit,
    State,
};
use axum::{
    extract::{Query, State as ExtractState},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn router() -> Router<State> {
    Router::new().route("/api/v1/search", get(search))
}
#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    limit: Option<i64>,
    offset: Option<i64>,
    group: Option<String>,
}
async fn search(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    let term = q.q.trim();
    if term.chars().count() > 150 {
        return Err(Error::Invalid("search is too long"));
    }
    let permissions = crate::access_policies::can_view(
        &s,
        &a,
        &["clinical", "scheduling", "billing", "claims", "practice"],
    )
    .await?;
    let chart = permissions[0] && permissions[1];
    let limit = q.limit.unwrap_or(5).clamp(1, 5);
    let offset = q.offset.unwrap_or(0).clamp(0, 10000);
    let mut groups = Vec::new();
    if term.chars().count() < 2 {
        return Ok(Json(json!({"groups":groups})));
    }
    // Escape user wildcard characters; both full fields and individual word starts match.
    let pattern = format!(
        "{}%",
        term.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let mut tx = db.begin().await?;
    let member_ids = if permissions[2] {
        "(SELECT string_agg(c.content->>'member_id',' ') FROM insurance_coverages c WHERE c.tenant_id=p.tenant_id AND c.patient_id=p.id)"
    } else {
        "NULL::text"
    };
    let name = "p.given_name || ' ' || p.family_name";
    let patient_join = "JOIN patients p ON p.tenant_id=r.tenant_id AND p.id=r.patient_id";
    // All SQL fragments below are constants; user input is exclusively bound.
    let specs = vec![
        ("patients", "Patients", chart,
         format!("SELECT p.id,p.id AS patient_id,{name} AS title,concat_ws(' · ',p.birth_date,p.mrn) AS detail,concat_ws(' ',p.given_name,p.family_name,p.birth_date,to_char(p.birth_date,'MM/DD/YYYY'),p.mrn,d.content->>'phone',regexp_replace(d.content->>'phone','[^0-9]','','g'),d.content->>'email', {member_ids}) AS words,p.family_name AS priority FROM patients p LEFT JOIN patient_demographics d ON d.tenant_id=p.tenant_id AND d.patient_id=p.id WHERE p.tenant_id=$1")),
        ("appointments", "Appointments", permissions[0] && permissions[1],
         format!("SELECT r.id,r.patient_id,{name} AS title,concat_ws(' · ',r.starts_at,coalesce(nullif(pp.display_name,''),u.display_name),r.status) AS detail,concat_ws(' ',{name},r.id,r.starts_at,pp.display_name,u.display_name) AS words,CASE WHEN r.starts_at>=current_date THEN extract(epoch from r.starts_at) ELSE 100000000000-extract(epoch from r.starts_at) END AS priority FROM appointments r {patient_join} LEFT JOIN browser_users u ON u.tenant_id=r.tenant_id AND u.id=r.clinician_id LEFT JOIN practice_providers pp ON pp.tenant_id=r.tenant_id AND pp.id=r.clinician_id WHERE r.tenant_id=$1")),
        ("encounters", "Encounters", chart,
         format!("SELECT r.id,r.patient_id,'ENC-' || lpad(n.encounter_number::text,greatest(4,length(n.encounter_number::text)),'0') AS title,concat_ws(' · ',{name},r.created_at::date,r.status) AS detail,concat_ws(' ',{name},r.id,'ENC-' || lpad(n.encounter_number::text,greatest(4,length(n.encounter_number::text)),'0'),n.encounter_number,r.created_at::date,r.status) AS words,-extract(epoch from r.created_at) AS priority FROM visits r {patient_join} JOIN ({}) n ON n.id=r.id WHERE r.tenant_id=$1",crate::postgres::ENCOUNTER_NUMBERS)),
        ("claims", "Claims", permissions[0] && permissions[2] && permissions[3],
         format!("SELECT r.id,r.patient_id,r.control_number AS title,concat_ws(' · ',{name},py.content->>'name',r.status) AS detail,concat_ws(' ',r.control_number,r.payer_control_number,{name},py.content->>'name',r.status) AS words,r.control_number AS priority FROM ehr_claims r {patient_join} JOIN ehr_payers py ON py.tenant_id=r.tenant_id AND py.id=r.payer_id WHERE r.tenant_id=$1")),
        ("payments", "Payments / receipts", chart && permissions[2],
         format!("SELECT r.id,r.patient_id,r.appointment_id,NULL::uuid AS account_id,'receipt' AS source,coalesce(rn.number,'R-' || upper(left(replace(r.id::text,'-',''),8))) AS title,concat_ws(' · ',to_char(r.amount_cents/100.0,'FM999999990.00'),{name},r.occurred_on) AS detail,concat_ws(' ',r.id,'R-' || upper(left(replace(r.id::text,'-',''),8)),r.reference,r.amount_cents,to_char(r.amount_cents/100.0,'FM999999990.00'),{name},rn.number) AS words,-extract(epoch from r.created_at) AS priority FROM billing_copay_receipts r {patient_join} LEFT JOIN LATERAL (SELECT 'ENC-' || lpad(n.encounter_number::text,greatest(4,length(n.encounter_number::text)),'0') || '-' || lpad(dense_rank() OVER (ORDER BY rr.created_at,coalesce(rr.payment_group_id,rr.id))::text,2,'0') AS number,rr.id FROM billing_copay_receipts rr JOIN visits v ON v.tenant_id=rr.tenant_id AND v.appointment_id=rr.appointment_id JOIN ({}) n ON n.id=v.id WHERE rr.tenant_id=r.tenant_id AND rr.appointment_id=r.appointment_id) rn ON rn.id=r.id WHERE r.tenant_id=$1 UNION ALL SELECT r.id,b.patient_id,NULL::uuid,b.id,'ledger','Payment ' || r.id::text,concat_ws(' · ',to_char(abs(r.effect_cents)/100.0,'FM999999990.00'),{name}),concat_ws(' ',r.id,r.content->>'reference',abs(r.effect_cents),to_char(abs(r.effect_cents)/100.0,'FM999999990.00'),{name}),-extract(epoch from r.created_at) FROM billing_entries r JOIN billing_accounts b ON b.tenant_id=r.tenant_id AND b.id=r.account_id JOIN patients p ON p.tenant_id=b.tenant_id AND p.id=b.patient_id WHERE r.tenant_id=$1 AND r.kind='payment' AND NOT (r.content ? 'copay_receipt_id')",crate::postgres::ENCOUNTER_NUMBERS)),
        ("files", "Files", chart,
         format!("SELECT r.id,r.patient_id,coalesce(r.content->>'title',r.filename) AS title,concat_ws(' · ',r.filename,{name}) AS detail,concat_ws(' ',r.filename,r.content->>'title',{name}) AS words,r.filename AS priority FROM patient_documents r {patient_join} WHERE r.tenant_id=$1")),
        ("referrals", "Referrals", chart,
         format!("SELECT r.id,r.patient_id,r.content->>'requested_service' AS title,concat_ws(' · ',{name},r.content->>'recipient',r.status) AS detail,concat_ws(' ',{name},r.content->>'requested_service',r.content->>'recipient',r.status) AS words,-extract(epoch from r.created_at) AS priority FROM referrals r {patient_join} WHERE r.tenant_id=$1")),
        ("orders", "Orders", chart,
         format!("SELECT r.id,r.patient_id,r.content->>'title' AS title,concat_ws(' · ',{name},r.content->>'destination',r.status) AS detail,concat_ws(' ',{name},r.content->>'title',r.content->>'destination',(SELECT string_agg(t->>'label',' ') FROM jsonb_array_elements(r.content->'tests') t),r.status) AS words,-extract(epoch from r.created_at) AS priority FROM lab_orders r {patient_join} WHERE r.tenant_id=$1")),
    ];
    for (key, label, allowed, sql) in specs {
        if !allowed || q.group.as_deref().is_some_and(|g| g != key) {
            continue;
        }
        let query = format!("SELECT jsonb_build_object('id',id,'patient_id',patient_id,'title',title,'detail',detail,'kind',$5::text,'source',to_jsonb(entries)->>'source','account_id',to_jsonb(entries)->>'account_id','appointment_id',to_jsonb(entries)->>'appointment_id') FROM ({sql}) entries WHERE words ILIKE $2 OR (' ' || words) ILIKE ('% ' || $2) OR (' ' || regexp_replace(words,'[[:punct:]]',' ','g')) ILIKE ('% ' || $2) ORDER BY priority,id LIMIT $3 OFFSET $4");
        let mut items: Vec<Value> = sqlx::query_scalar(&query)
            .bind(a.tenant_id)
            .bind(&pattern)
            .bind(limit + 1)
            .bind(offset)
            .bind(key)
            .fetch_all(&mut *tx)
            .await?;
        let more = items.len() as i64 > limit;
        items.truncate(limit as usize);
        groups.push(json!({"key":key,"label":label,"items":items,"more":more,"offset":offset}));
    }
    if q.group.is_none() || q.group.as_deref() == Some("actions") {
        let mut actions = Vec::new();
        let register = crate::access_policies::allows(&mut tx, &a, "clinical", "create").await?;
        let book = crate::access_policies::allows(&mut tx, &a, "scheduling", "create").await?;
        for (id, label, allowed) in [
            ("schedule", "Schedule", permissions[1]),
            ("billing", "Billing", permissions[2]),
            (
                "billing-setup",
                "Practice billing setup",
                permissions[4] && matches!(a.role, crate::auth::Role::Owner),
            ),
            (
                "new-patient",
                "New patient",
                chart
                    && register
                    && matches!(
                        a.role,
                        crate::auth::Role::Owner
                            | crate::auth::Role::Clinician
                            | crate::auth::Role::FrontDesk
                    ),
            ),
            (
                "new-appointment",
                "New appointment",
                permissions[1] && book && a.scheduling().is_ok(),
            ),
        ] {
            if allowed
                && (label.to_lowercase().starts_with(&term.to_lowercase())
                    || label
                        .to_lowercase()
                        .contains(&format!(" {}", term.to_lowercase())))
            {
                actions.push(
                    json!({"id":id,"title":label,"detail":"Page or action","kind":"actions"}),
                );
            }
        }
        let mut items: Vec<Value> = actions
            .into_iter()
            .skip(offset as usize)
            .take((limit + 1) as usize)
            .collect();
        let more = items.len() as i64 > limit;
        items.truncate(limit as usize);
        groups.push(json!({"key":"actions","label":"Pages & actions","items":items,"more":more,"offset":offset}));
    }
    audit(&mut tx, &a, "global_search.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"groups":groups})))
}
