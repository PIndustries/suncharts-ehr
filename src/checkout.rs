// SPDX-License-Identifier: AGPL-3.0-only
//! Explicit clinical release, administrative checkout and owned follow-up work.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
type Tx<'a> = Transaction<'a, Postgres>;
fn database(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn bounded(value: &mut String, max: usize, required: bool, multiline: bool) -> Result<()> {
    *value = value.trim().to_string();
    if (required && value.is_empty())
        || value.chars().count() > max
        || value
            .chars()
            .any(|c| c.is_control() && !(multiline && matches!(c, '\n' | '\r' | '\t')))
    {
        return Err(Error::Invalid("invalid text length or control characters"));
    }
    Ok(())
}
fn version(headers: &HeaderMap) -> Result<i64> {
    headers
        .get("If-Match")
        .and_then(|h| h.to_str().ok())
        .and_then(|v| v.strip_prefix('"'))
        .and_then(|v| v.strip_suffix('"'))
        .and_then(|v| v.parse().ok())
        .filter(|v| *v >= 0)
        .ok_or(Error::VersionRequired)
}
async fn visit(tx: &mut Tx<'_>, a: &Actor, p: Uuid, v: Uuid, write: bool) -> Result<Value> {
    let sql = if write {
        "SELECT to_jsonb(v)-'tenant_id'-'note'-'vitals' FROM visits v WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR NO KEY UPDATE"
    } else {
        "SELECT to_jsonb(v)-'tenant_id'-'note'-'vitals' FROM visits v WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR SHARE"
    };
    sqlx::query_scalar(sql)
        .bind(a.tenant_id)
        .bind(p)
        .bind(v)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
fn signed(v: &Value) -> Result<()> {
    if v["status"] != "signed" {
        Err(Error::Conflict(
            "sign the encounter before release or checkout",
        ))
    } else {
        Ok(())
    }
}
async fn state(tx: &mut Tx<'_>, a: &Actor, v: Uuid) -> Result<Value> {
    Ok(sqlx::query_scalar::<_,Value>("SELECT to_jsonb(c)-'tenant_id' FROM visit_checkout c WHERE tenant_id=$1 AND visit_id=$2").bind(a.tenant_id).bind(v).fetch_optional(&mut **tx).await?.unwrap_or(json!({"visit_id":v,"version":0,"current_avs_version":null,"checked_out_at":null,"checked_out_by":null})))
}
async fn task_rows(tx: &mut Tx<'_>, a: &Actor, p: Uuid, v: Uuid) -> Result<Vec<Value>> {
    let mut rows:Vec<Value>=sqlx::query_scalar("SELECT (to_jsonb(t)-'tenant_id'-'creation_hash'-'request_id'-'assigned_to')||jsonb_build_object('assignee_id',t.assigned_to,'assignee_label',u.email,'assignee_enabled',NOT u.disabled,'patient_name',p.family_name||', '||p.given_name,'mrn',p.mrn,'starts_at',ap.starts_at) FROM follow_up_tasks t JOIN browser_users u ON u.tenant_id=t.tenant_id AND u.id=t.assigned_to JOIN patients p ON p.tenant_id=t.tenant_id AND p.id=t.patient_id JOIN visits v ON v.tenant_id=t.tenant_id AND v.id=t.visit_id JOIN appointments ap ON ap.tenant_id=v.tenant_id AND ap.id=v.appointment_id WHERE t.tenant_id=$1 AND t.patient_id=$2 AND t.visit_id=$3 ORDER BY t.due_date,t.id LIMIT 101").bind(a.tenant_id).bind(p).bind(v).fetch_all(&mut **tx).await?;
    for row in &mut rows {
        row["can_update"] = json!(
            a.scheduling().is_ok()
                && (matches!(a.role, Role::Owner)
                    || row["created_by"] == json!(a.sub)
                    || row["assignee_id"] == json!(a.sub))
        );
    }
    Ok(rows)
}
async fn read_payload(tx: &mut Tx<'_>, a: &Actor, p: Uuid, v: Uuid, visit: Value) -> Result<Value> {
    let s = state(tx, a, v).await?;
    let releases:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id' FROM avs_releases r WHERE tenant_id=$1 AND visit_id=$2 ORDER BY version DESC LIMIT 51").bind(a.tenant_id).bind(v).fetch_all(&mut **tx).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id' FROM checkout_events e WHERE tenant_id=$1 AND visit_id=$2 ORDER BY checkout_version DESC LIMIT 101").bind(a.tenant_id).bind(v).fetch_all(&mut **tx).await?;
    let preview_snapshot = clinical_snapshot(tx, a, p, v).await?;
    let preview_digest = snapshot_digest(&preview_snapshot)?;
    let mut tasks = task_rows(tx, a, p, v).await?;
    let followups_truncated = tasks.len() > 100;
    tasks.truncate(100);
    Ok(
        json!({"preview_snapshot":preview_snapshot,"preview_digest":preview_digest,"patient_id":p,"visit_id":v,"version":s["version"],"visit":visit,"current_avs":releases.first(),"releases":releases.iter().take(50).collect::<Vec<_>>(),"releases_truncated":releases.len()>50,"checkout":{"completed":!s["checked_out_at"].is_null(),"checked_out_at":s["checked_out_at"],"checked_out_by":s["checked_out_by"]},"events":events.iter().take(100).collect::<Vec<_>>(),"events_truncated":events.len()>100,"followups":tasks,"followups_truncated":followups_truncated}),
    )
}
pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/patients/{patient}/visits/{visit}/checkout",
            get(read),
        )
        .route(
            "/api/v1/patients/{patient}/visits/{visit}/checkout/actions",
            post(action),
        )
        .route(
            "/api/v1/patients/{patient}/visits/{visit}/follow-ups",
            post(create_task),
        )
        .route("/api/v1/follow-up/tasks", get(worklist))
        .route("/api/v1/follow-up/assignees", get(assignees))
        .route("/api/v1/follow-up/tasks/{task}", get(task_detail))
        .route("/api/v1/follow-up/tasks/{task}/actions", post(task_action))
        .route("/api/v1/portal/visits/{visit}/avs", get(patient_avs))
}
async fn read(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path((p, v)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = database(&s)?.begin().await?;
    let vis = visit(&mut tx, &a, p, v, false).await?;
    let data = read_payload(&mut tx, &a, p, v, vis).await?;
    crate::postgres::audit(&mut tx, &a, "checkout.read", v).await?;
    tx.commit().await?;
    Ok(Json(data))
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum CheckoutAction {
    ReleaseAvs {
        instructions: String,
        follow_up_instructions: String,
        reason: String,
        reviewed: bool,
        reviewed_snapshot_digest: String,
    },
    Checkout {
        reason: String,
    },
    Delivery {
        method: String,
        avs_version: i64,
        reason: String,
    },
}
async fn clinical_snapshot(tx: &mut Tx<'_>, a: &Actor, p: Uuid, v: Uuid) -> Result<Value> {
    let patient:Value=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'mrn',mrn,'given_name',given_name,'family_name',family_name,'birth_date',birth_date) FROM patients WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(p).fetch_one(&mut **tx).await?;
    let encounter:Value=sqlx::query_scalar("SELECT jsonb_build_object('id',v.id,'appointment_id',v.appointment_id,'visit_version',v.version,'signed_by',v.signed_by,'signed_at',v.signed_at,'title',a.title,'category',a.category,'starts_at',a.starts_at,'clinician_id',v.clinician_id,'clinician_label',COALESCE(u.email,'Assigned clinician'),'facility',a.facility,'room',a.room) FROM visits v JOIN appointments a ON a.tenant_id=v.tenant_id AND a.id=v.appointment_id LEFT JOIN browser_users u ON u.tenant_id=v.tenant_id AND u.id=v.clinician_id WHERE v.tenant_id=$1 AND v.id=$2").bind(a.tenant_id).bind(v).fetch_one(&mut **tx).await?;
    let meds:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'version',version,'title',content->'title','status',content->'status','verification',content->'verification','codes',content->'codes','dose',content#>'{detail,dose}','route',content#>'{detail,route}','frequency',content#>'{detail,frequency}') FROM clinical_entries WHERE tenant_id=$1 AND patient_id=$2 AND kind='medication' AND content->>'status' IN ('active','on_hold','intended') AND content->>'verification' NOT IN ('refuted','entered_in_error') ORDER BY created_at,id LIMIT 101").bind(a.tenant_id).bind(p).fetch_all(&mut **tx).await?;
    let allergies:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'version',version,'title',content->'title','status',content->'status','verification',content->'verification','codes',content->'codes','reaction',content#>'{detail,reaction}','severity',content#>'{detail,severity}','criticality',content#>'{detail,criticality}') FROM clinical_entries WHERE tenant_id=$1 AND patient_id=$2 AND kind='allergy' AND content->>'status'='active' AND content->>'verification' NOT IN ('refuted','entered_in_error') ORDER BY created_at,id LIMIT 101").bind(a.tenant_id).bind(p).fetch_all(&mut **tx).await?;
    let problems:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'version',version,'title',content->'title','status',content->'status','verification',content->'verification','codes',content->'codes','onset_date',content->'onset_date','problem_type',content#>'{detail,problem_type}') FROM clinical_entries WHERE tenant_id=$1 AND patient_id=$2 AND kind='problem' AND content->>'status'='active' AND content->>'verification' NOT IN ('refuted','entered_in_error') ORDER BY created_at,id LIMIT 101").bind(a.tenant_id).bind(p).fetch_all(&mut **tx).await?;
    let reviews:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('kind',k.kind,'version',COALESCE(l.version,1),'review_state',COALESCE(l.review_state,'unknown'),'reviewed_at',l.reviewed_at) FROM (VALUES ('allergy'),('medication'),('problem')) AS k(kind) LEFT JOIN clinical_list_state l ON l.kind=k.kind AND l.tenant_id=$1 AND l.patient_id=$2 ORDER BY k.kind").bind(a.tenant_id).bind(p).fetch_all(&mut **tx).await?;
    let vitals: Option<Value> =
        sqlx::query_scalar("SELECT vitals FROM visits WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(v)
            .fetch_one(&mut **tx)
            .await?;
    let orders:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'version',version,'status',status,'title',content->'title','category',content->'category','priority',content->'priority','destination',content->'destination','tests',content->'tests') FROM lab_orders WHERE tenant_id=$1 AND patient_id=$2 AND visit_id=$3 ORDER BY created_at,id LIMIT 101 FOR SHARE").bind(a.tenant_id).bind(p).bind(v).fetch_all(&mut **tx).await?;
    if meds.len() > 100 || orders.len() > 100 || allergies.len() > 100 || problems.len() > 100 {
        return Err(Error::Conflict(
            "AVS snapshot exceeds the supported clinical list or order limit",
        ));
    }
    Ok(
        json!({"patient":patient,"visit":encounter,"medications":meds,"allergies":allergies,"problems":problems,"list_reviews":reviews,"vitals":vitals,"orders":orders}),
    )
}
fn snapshot_digest(snapshot: &Value) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(snapshot).map_err(|_| Error::Invalid("invalid AVS snapshot"))?
        )
    ))
}
async fn action(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path((p, v)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<CheckoutAction>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    let expected = version(&headers)?;
    let mut tx = database(&s)?.begin().await?;
    if matches!(&input, CheckoutAction::ReleaseAvs { .. }) {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,3))")
            .bind(a.tenant_id.to_string())
            .execute(&mut *tx)
            .await?;
    }
    let vis = visit(&mut tx, &a, p, v, true).await?;
    signed(&vis)?;
    let current = state(&mut tx, &a, v).await?;
    if current["version"].as_i64() != Some(expected) {
        return Err(Error::Conflict("checkout changed; reload before saving"));
    }
    sqlx::query(
        "INSERT INTO visit_checkout(tenant_id,visit_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    )
    .bind(a.tenant_id)
    .bind(v)
    .execute(&mut *tx)
    .await?;
    let (kind, avs, method, reason) = match input {
        CheckoutAction::ReleaseAvs {
            mut instructions,
            mut follow_up_instructions,
            mut reason,
            reviewed,
            reviewed_snapshot_digest,
        } => {
            a.clinical()?;
            if vis["clinician_id"] != json!(a.sub) {
                return Err(Error::Forbidden);
            }
            if !reviewed {
                return Err(Error::Invalid("explicit clinical review is required"));
            }
            bounded(&mut instructions, 10000, true, true)?;
            bounded(&mut follow_up_instructions, 5000, false, true)?;
            bounded(&mut reason, 1000, true, false)?;
            let next = current["current_avs_version"].as_i64().unwrap_or(0) + 1;
            for kind in ["allergy", "medication", "problem"] {
                crate::clinical::list_lock(&mut tx, &a, p, kind).await?;
            }
            let mut snapshot = clinical_snapshot(&mut tx, &a, p, v).await?;
            if snapshot_digest(&snapshot)? != reviewed_snapshot_digest {
                return Err(Error::Conflict(
                    "patient summary changed; refresh and review the current AVS snapshot",
                ));
            }
            snapshot["snapshot_at"] = json!(Utc::now());
            sqlx::query("INSERT INTO avs_releases(tenant_id,visit_id,version,content,snapshot,released_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(a.tenant_id).bind(v).bind(next).bind(json!({"instructions":instructions,"follow_up_instructions":follow_up_instructions})).bind(snapshot).bind(a.sub).bind(&reason).execute(&mut *tx).await?;
            sqlx::query("UPDATE visit_checkout SET version=version+1,current_avs_version=$3,checked_out_at=NULL,checked_out_by=NULL WHERE tenant_id=$1 AND visit_id=$2").bind(a.tenant_id).bind(v).bind(next).execute(&mut *tx).await?;
            ("release_avs", next, None, reason)
        }
        CheckoutAction::Delivery {
            method,
            avs_version,
            mut reason,
        } => {
            bounded(&mut reason, 1000, true, false)?;
            if !["print", "declined", "other"].contains(&method.as_str()) {
                return Err(Error::Invalid("unsupported AVS delivery method"));
            }
            if current["current_avs_version"].as_i64() != Some(avs_version) {
                return Err(Error::Conflict(
                    "delivery must reference the current released AVS version",
                ));
            }
            sqlx::query(
                "UPDATE visit_checkout SET version=version+1 WHERE tenant_id=$1 AND visit_id=$2",
            )
            .bind(a.tenant_id)
            .bind(v)
            .execute(&mut *tx)
            .await?;
            ("delivery", avs_version, Some(method), reason)
        }
        CheckoutAction::Checkout { mut reason } => {
            bounded(&mut reason, 1000, true, false)?;
            let avs = current["current_avs_version"]
                .as_i64()
                .ok_or(Error::Conflict(
                    "release patient instructions before checkout",
                ))?;
            if !current["checked_out_at"].is_null() {
                return Err(Error::Conflict("administrative checkout already recorded"));
            }
            let delivered:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM checkout_events WHERE tenant_id=$1 AND visit_id=$2 AND avs_version=$3 AND action='delivery')").bind(a.tenant_id).bind(v).bind(avs).fetch_one(&mut *tx).await?;
            if !delivered {
                return Err(Error::Conflict(
                    "record AVS delivery or patient decline before checkout",
                ));
            }
            sqlx::query("UPDATE visit_checkout SET version=version+1,checked_out_at=now(),checked_out_by=$3 WHERE tenant_id=$1 AND visit_id=$2").bind(a.tenant_id).bind(v).bind(a.sub).execute(&mut *tx).await?;
            ("checkout", avs, None, reason)
        }
    };
    sqlx::query("INSERT INTO checkout_events(tenant_id,id,visit_id,checkout_version,action,avs_version,method,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(v).bind(expected+1).bind(kind).bind(avs).bind(method).bind(reason).bind(a.sub).execute(&mut *tx).await?;
    crate::postgres::audit(
        &mut tx,
        &a,
        match kind {
            "release_avs" => "checkout.avs_release",
            "delivery" => "checkout.delivery",
            _ => "checkout.complete",
        },
        v,
    )
    .await?;
    let payload = read_payload(&mut tx, &a, p, v, vis).await?;
    tx.commit().await?;
    Ok(Json(payload))
}
async fn patient_avs(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(v): Path<Uuid>,
) -> Result<Json<Value>> {
    let p = if matches!(a.role, Role::Patient) {
        a.patient_id.ok_or(Error::Forbidden)?
    } else {
        return Err(Error::Forbidden);
    };
    let mut tx = database(&s)?.begin().await?;
    let vis = visit(&mut tx, &a, p, v, false).await?;
    signed(&vis)?;
    let released:Value=sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id'-'reason' FROM avs_releases r WHERE tenant_id=$1 AND visit_id=$2 ORDER BY version DESC LIMIT 1").bind(a.tenant_id).bind(v).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    crate::postgres::audit(&mut tx, &a, "checkout.patient_avs_read", v).await?;
    tx.commit().await?;
    Ok(Json(released))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NewTask {
    request_id: Uuid,
    title: String,
    instructions: String,
    assignee_id: Uuid,
    due_date: NaiveDate,
    reason: String,
}
fn due_date(value: NaiveDate) -> Result<()> {
    if !(NaiveDate::from_ymd_opt(2000, 1, 1).unwrap()
        ..=NaiveDate::from_ymd_opt(2100, 12, 31).unwrap())
        .contains(&value)
    {
        Err(Error::Invalid("follow-up date outside supported range"))
    } else {
        Ok(())
    }
}
async fn assignee(tx: &mut Tx<'_>, a: &Actor, id: Uuid) -> Result<()> {
    let enabled:Option<Uuid>=sqlx::query_scalar("SELECT id FROM browser_users WHERE tenant_id=$1 AND id=$2 AND NOT disabled AND role IN ('owner','clinician','front_desk') FOR SHARE").bind(a.tenant_id).bind(id).fetch_optional(&mut **tx).await?;
    enabled.ok_or(Error::Invalid(
        "choose an enabled staff member in this practice",
    ))?;
    Ok(())
}
async fn task(tx: &mut Tx<'_>, a: &Actor, id: Uuid, lock: bool) -> Result<Value> {
    let sql = if lock {
        "SELECT to_jsonb(t) FROM follow_up_tasks t WHERE tenant_id=$1 AND id=$2 FOR UPDATE"
    } else {
        "SELECT to_jsonb(t) FROM follow_up_tasks t WHERE tenant_id=$1 AND id=$2 FOR SHARE"
    };
    sqlx::query_scalar(sql)
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn task_payload(tx: &mut Tx<'_>, a: &Actor, id: Uuid) -> Result<Value> {
    let mut data:Value=sqlx::query_scalar("SELECT (to_jsonb(t)-'tenant_id'-'request_id'-'creation_hash'-'assigned_to')||jsonb_build_object('assignee_id',t.assigned_to,'assignee_label',u.email,'assignee_enabled',NOT u.disabled,'patient_name',p.family_name||', '||p.given_name,'mrn',p.mrn,'starts_at',ap.starts_at) FROM follow_up_tasks t JOIN browser_users u ON u.tenant_id=t.tenant_id AND u.id=t.assigned_to JOIN patients p ON p.tenant_id=t.tenant_id AND p.id=t.patient_id JOIN visits v ON v.tenant_id=t.tenant_id AND v.id=t.visit_id JOIN appointments ap ON ap.tenant_id=v.tenant_id AND ap.id=v.appointment_id WHERE t.tenant_id=$1 AND t.id=$2").bind(a.tenant_id).bind(id).fetch_one(&mut **tx).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(h)-'tenant_id'-'task_id' FROM follow_up_history h WHERE tenant_id=$1 AND task_id=$2 ORDER BY version DESC LIMIT 101").bind(a.tenant_id).bind(id).fetch_all(&mut **tx).await?;
    data["can_update"] = json!(
        a.scheduling().is_ok()
            && (matches!(a.role, Role::Owner)
                || data["created_by"] == json!(a.sub)
                || data["assignee_id"] == json!(a.sub))
    );
    data["events_truncated"] = json!(events.len() > 100);
    data["events"] = json!(events.into_iter().take(100).collect::<Vec<_>>());
    Ok(data)
}
async fn task_revision(
    tx: &mut Tx<'_>,
    a: &Actor,
    id: Uuid,
    action: &str,
    reason: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO follow_up_history(tenant_id,task_id,version,snapshot,action,reason,actor_id) SELECT tenant_id,id,version,(to_jsonb(t)-'tenant_id'-'request_id'-'creation_hash'-'assigned_to')||jsonb_build_object('assignee_id',assigned_to),$3,$4,$5 FROM follow_up_tasks t WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(action).bind(reason).bind(a.sub).execute(&mut **tx).await?;
    Ok(())
}
async fn create_task(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path((p, v)): Path<(Uuid, Uuid)>,
    Json(mut input): Json<NewTask>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    bounded(&mut input.title, 200, true, false)?;
    bounded(&mut input.instructions, 4000, true, true)?;
    bounded(&mut input.reason, 1000, true, false)?;
    due_date(input.due_date)?;
    let hash = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&input).map_err(|_| Error::Invalid("invalid follow-up request"))?
        )
    );
    let mut tx = database(&s)?.begin().await?;
    visit(&mut tx, &a, p, v, true).await?;
    let prior:Option<(Uuid,Uuid,Uuid,String)>=sqlx::query_as("SELECT id,patient_id,visit_id,creation_hash FROM follow_up_tasks WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(input.request_id).fetch_optional(&mut *tx).await?;
    if let Some((id, patient, visit, old_hash)) = prior {
        if patient != p || visit != v || hash != old_hash {
            return Err(Error::Conflict(
                "follow-up request ID reused with different content",
            ));
        }
        let data = task_payload(&mut tx, &a, id).await?;
        crate::postgres::audit(&mut tx, &a, "followup.retry_read", id).await?;
        tx.commit().await?;
        return Ok(Json(data));
    }
    assignee(&mut tx, &a, input.assignee_id).await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO follow_up_tasks(tenant_id,id,patient_id,visit_id,request_id,creation_hash,title,instructions,assigned_to,due_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(a.tenant_id).bind(id).bind(p).bind(v).bind(input.request_id).bind(hash).bind(input.title).bind(input.instructions).bind(input.assignee_id).bind(input.due_date).bind(a.sub).execute(&mut *tx).await?;
    task_revision(&mut tx, &a, id, "create", &input.reason).await?;
    crate::postgres::audit(&mut tx, &a, "followup.create", id).await?;
    let data = task_payload(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(Json(data))
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum TaskAction {
    Complete { reason: String },
    Cancel { reason: String },
    Reopen { reason: String },
    Reassign { assignee_id: Uuid, reason: String },
    Reschedule { due_date: NaiveDate, reason: String },
}
async fn task_action(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<TaskAction>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    let expected = version(&headers)?;
    let mut tx = database(&s)?.begin().await?;
    let old = task(&mut tx, &a, id, true).await?;
    if old["version"].as_i64() != Some(expected) {
        return Err(Error::Conflict("follow-up changed; reload before saving"));
    }
    if !matches!(a.role, Role::Owner)
        && old["created_by"] != json!(a.sub)
        && old["assigned_to"] != json!(a.sub)
    {
        return Err(Error::Forbidden);
    }
    let (kind, mut reason, status, new_assignee, new_due) = match input {
        TaskAction::Complete { reason } => {
            if old["status"] != "open" {
                return Err(Error::Conflict("only open follow-up can be completed"));
            }
            ("complete", reason, "completed", None, None)
        }
        TaskAction::Cancel { reason } => {
            if old["status"] != "open" {
                return Err(Error::Conflict("only open follow-up can be cancelled"));
            }
            ("cancel", reason, "cancelled", None, None)
        }
        TaskAction::Reopen { reason } => {
            if old["status"] == "open" {
                return Err(Error::Conflict("follow-up is already open"));
            }
            let assigned: Uuid = serde_json::from_value(old["assigned_to"].clone())
                .map_err(|_| Error::Conflict("invalid follow-up assignee"))?;
            assignee(&mut tx, &a, assigned).await?;
            ("reopen", reason, "open", None, None)
        }
        TaskAction::Reassign {
            assignee_id,
            reason,
        } => {
            if old["status"] != "open" {
                return Err(Error::Conflict("reopen follow-up before reassignment"));
            }
            assignee(&mut tx, &a, assignee_id).await?;
            ("reassign", reason, "open", Some(assignee_id), None)
        }
        TaskAction::Reschedule {
            due_date: due,
            reason,
        } => {
            if old["status"] != "open" {
                return Err(Error::Conflict("reopen follow-up before rescheduling"));
            }
            due_date(due)?;
            ("reschedule", reason, "open", None, Some(due))
        }
    };
    bounded(&mut reason, 1000, true, false)?;
    sqlx::query("UPDATE follow_up_tasks SET status=$3,assigned_to=COALESCE($4,assigned_to),due_date=COALESCE($5,due_date),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(status).bind(new_assignee).bind(new_due).execute(&mut *tx).await?;
    task_revision(&mut tx, &a, id, kind, &reason).await?;
    crate::postgres::audit(&mut tx, &a, "followup.action", id).await?;
    let data = task_payload(&mut tx, &a, id).await?;
    tx.commit().await?;
    Ok(Json(data))
}
async fn task_detail(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = database(&s)?.begin().await?;
    task(&mut tx, &a, id, false).await?;
    let data = task_payload(&mut tx, &a, id).await?;
    crate::postgres::audit(&mut tx, &a, "followup.read", id).await?;
    tx.commit().await?;
    Ok(Json(data))
}
async fn assignees(ExtractState(s): ExtractState<State>, a: Actor) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = database(&s)?.begin().await?;
    let users:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'label',email,'role',role) FROM browser_users WHERE tenant_id=$1 AND NOT disabled AND role IN ('owner','clinician','front_desk') ORDER BY email,id LIMIT 501").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "followup.assignees.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":users.iter().take(500).collect::<Vec<_>>(),"has_more":users.len()>500}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkQuery {
    status: Option<String>,
    assignee_id: Option<Uuid>,
}
async fn worklist(
    ExtractState(s): ExtractState<State>,
    a: Actor,
    Query(input): Query<WorkQuery>,
) -> Result<Json<Value>> {
    a.staff()?;
    let status = input.status.as_deref().unwrap_or("open");
    if !["open", "completed", "cancelled", "all"].contains(&status) {
        return Err(Error::Invalid("unsupported follow-up status"));
    }
    let mut tx = database(&s)?.begin().await?;
    let mut rows:Vec<Value>=sqlx::query_scalar("SELECT (to_jsonb(t)-'tenant_id'-'request_id'-'creation_hash'-'assigned_to')||jsonb_build_object('assignee_id',t.assigned_to,'assignee_label',u.email,'assignee_enabled',NOT u.disabled,'patient_name',p.family_name||', '||p.given_name,'mrn',p.mrn,'starts_at',ap.starts_at,'total',count(*) OVER()) FROM follow_up_tasks t JOIN browser_users u ON u.tenant_id=t.tenant_id AND u.id=t.assigned_to JOIN patients p ON p.tenant_id=t.tenant_id AND p.id=t.patient_id JOIN visits v ON v.tenant_id=t.tenant_id AND v.id=t.visit_id JOIN appointments ap ON ap.tenant_id=v.tenant_id AND ap.id=v.appointment_id WHERE t.tenant_id=$1 AND ($2='all' OR t.status=$2) AND ($3::uuid IS NULL OR t.assigned_to=$3) ORDER BY t.due_date,t.created_at,t.id LIMIT 101").bind(a.tenant_id).bind(status).bind(input.assignee_id).fetch_all(&mut *tx).await?;
    let total = rows.first().and_then(|v| v["total"].as_i64()).unwrap_or(0);
    for row in &mut rows {
        row.as_object_mut().unwrap().remove("total");
        row["can_update"] = json!(
            a.scheduling().is_ok()
                && (matches!(a.role, Role::Owner)
                    || row["created_by"] == json!(a.sub)
                    || row["assignee_id"] == json!(a.sub))
        );
    }
    crate::postgres::audit(&mut tx, &a, "followup.worklist.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":rows.into_iter().take(100).collect::<Vec<_>>(),"total":total,"has_more":total>100,"status":status}),
    ))
}
