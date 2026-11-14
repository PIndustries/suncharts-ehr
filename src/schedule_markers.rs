// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! What each appointment on the visible schedule still needs, in one read.
//!
//! Every fact is gathered for the whole date range with a fixed number of
//! queries, whatever the number of appointments. Billing and clinical facts
//! are left out for staff whose access policy hides those areas.
use crate::{
    auth::Actor,
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Query, State as ExtractState},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::{postgres::PgArguments, query::QueryScalar, Postgres, Transaction};
use std::collections::HashMap;
use uuid::Uuid;

/// An intake form sent to the patient without an appointment counts for
/// appointments that start within this many days after it was sent.
const PATIENT_FORM_DAYS: i64 = 60;
/// An eligibility answer is used for appointments that start within this many
/// days after the check, the same freshness the one-click check applies.
const ELIGIBILITY_DAYS: i64 = 30;

pub fn router() -> Router<State> {
    Router::new().route("/api/v1/schedule/markers", get(markers))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Range {
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    provider: Option<Uuid>,
}

/// Which optional groups of facts this staff member may see.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Access {
    pub billing: bool,
    pub insurance: bool,
    pub clinical: bool,
}

/// Runs the range reads and counts them, so a test can show the number does
/// not grow with the schedule.
struct Reads<'t, 'c> {
    tx: &'t mut Transaction<'c, Postgres>,
    count: usize,
}
impl Reads<'_, '_> {
    async fn rows(
        &mut self,
        query: QueryScalar<'_, Postgres, Value, PgArguments>,
    ) -> Result<Vec<Value>> {
        self.count += 1;
        Ok(query.fetch_all(&mut **self.tx).await?)
    }
}

fn uuid(value: &Value) -> Option<Uuid> {
    value.as_str().and_then(|text| Uuid::parse_str(text).ok())
}
fn time(value: &Value) -> Option<DateTime<Utc>> {
    value
        .as_str()
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|at| at.with_timezone(&Utc))
}

/// Mirrors the eligibility summary staff see in the chart: any active benefit
/// code means active, otherwise any inactive code means not active, and an
/// answer with neither could not be confirmed.
fn eligibility_status(check: &Value) -> &'static str {
    if check["status"] != "completed" {
        return "check_failed";
    }
    let codes: Vec<String> = check["codes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|code| match code {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .collect();
    if codes
        .iter()
        .any(|code| ["1", "2", "3", "4", "5"].contains(&code.as_str()))
    {
        "active"
    } else if codes
        .iter()
        .any(|code| ["6", "7", "8"].contains(&code.as_str()))
    {
        "not_active"
    } else {
        "check_failed"
    }
}

fn coverage_rank(content: &Value) -> u8 {
    match content["priority"].as_str() {
        Some("primary") => 0,
        Some("secondary") => 1,
        Some("tertiary") => 2,
        _ => 3,
    }
}
/// The coverage that pays first on the service date, as the chart picks it.
fn coverage_on<'a>(coverages: Option<&'a Vec<Value>>, service_date: &str) -> Option<&'a Value> {
    coverages?
        .iter()
        .filter(|coverage| {
            let content = &coverage["content"];
            content["status"] == "active"
                && content["effective_date"]
                    .as_str()
                    .is_none_or(|start| start <= service_date)
                && content["end_date"]
                    .as_str()
                    .is_none_or(|end| end.is_empty() || end >= service_date)
        })
        .min_by_key(|coverage| coverage_rank(&coverage["content"]))
}

/// The facts for every appointment overlapping the range, plus the number of
/// range reads it took.
pub(crate) async fn collect(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    provider: Option<Uuid>,
    access: Access,
) -> Result<(Vec<Value>, usize)> {
    let mut reads = Reads { tx, count: 0 };
    // A patient is new when no earlier kept appointment exists here or in imported history.
    let appointments = reads
        .rows(
            sqlx::query_scalar(
                "SELECT jsonb_build_object('id',ap.id,'patient_id',ap.patient_id,'starts_at',ap.starts_at,
                 'service_date',to_char((ap.starts_at AT TIME ZONE coalesce(bp.booking_timezone,'UTC'))::date,'YYYY-MM-DD'),
                 'visit_id',v.id,
                 'note',CASE WHEN v.id IS NULL THEN NULL WHEN v.status='signed' THEN 'signed' WHEN v.note IS NULL THEN 'not_started' ELSE 'in_progress' END,
                 'charges',CASE WHEN v.id IS NULL THEN NULL ELSE coalesce(b.status,'none') END,
                 'new_patient',NOT EXISTS(SELECT 1 FROM appointments o WHERE o.tenant_id=ap.tenant_id AND o.patient_id=ap.patient_id AND o.id<>ap.id AND o.status NOT IN ('cancelled','no_show') AND (o.starts_at,o.id)<(ap.starts_at,ap.id))
                  AND NOT EXISTS(SELECT 1 FROM historical_records h WHERE h.tenant_id=ap.tenant_id AND h.patient_id=ap.patient_id AND h.kind IN ('appointment','encounter','visit')))
                 FROM appointments ap
                 LEFT JOIN previsit_booking_profiles bp ON bp.tenant_id=ap.tenant_id
                 LEFT JOIN visits v ON v.tenant_id=ap.tenant_id AND v.appointment_id=ap.id
                 LEFT JOIN billing_accounts b ON b.tenant_id=v.tenant_id AND b.visit_id=v.id AND b.status<>'void'
                 WHERE ap.tenant_id=$1 AND ap.starts_at<$3 AND ap.ends_at>$2 AND ($4::uuid IS NULL OR ap.clinician_id=$4)
                 ORDER BY ap.starts_at,ap.id LIMIT 1001",
            )
            .bind(tenant)
            .bind(from)
            .bind(to)
            .bind(provider),
        )
        .await?;
    if appointments.len() > 1000 {
        return Err(Error::Invalid(
            "too many schedule entries; narrow the date or provider filter",
        ));
    }
    let appointment_ids: Vec<Uuid> = appointments.iter().filter_map(|a| uuid(&a["id"])).collect();
    let mut patient_ids: Vec<Uuid> = appointments
        .iter()
        .filter_map(|a| uuid(&a["patient_id"]))
        .collect();
    patient_ids.sort();
    patient_ids.dedup();

    let packets = reads
        .rows(
            sqlx::query_scalar(
                "SELECT jsonb_build_object('id',id,'appointment_id',appointment_id,'patient_id',patient_id,'status',status,'created_at',created_at,
                 'expired',status IN ('sent','in_progress') AND expires_at IS NOT NULL AND expires_at<=now(),
                 'default_form',workflow_instance_id IS NULL)
                 FROM previsit_intake_packets
                 WHERE tenant_id=$1 AND status<>'void'
                 AND (appointment_id=ANY($2) OR (appointment_id IS NULL AND patient_id=ANY($3) AND created_at>=$4 AND created_at<$5))
                 ORDER BY created_at DESC,id DESC LIMIT 5001",
            )
            .bind(tenant)
            .bind(&appointment_ids)
            .bind(&patient_ids)
            .bind(from - Duration::days(PATIENT_FORM_DAYS))
            .bind(to),
        )
        .await?;
    let mut appointment_forms: HashMap<Uuid, &Value> = HashMap::new();
    let mut patient_forms: HashMap<Uuid, Vec<&Value>> = HashMap::new();
    // Newest first: the practice's own form wins over a journey step's form.
    for packet in packets.iter().filter(|p| p["expired"] != true) {
        match (uuid(&packet["appointment_id"]), uuid(&packet["patient_id"])) {
            (Some(appointment), _) => {
                let kept = appointment_forms.entry(appointment).or_insert(packet);
                if kept["default_form"] != true && packet["default_form"] == true {
                    *kept = packet;
                }
            }
            (None, Some(patient)) => patient_forms.entry(patient).or_default().push(packet),
            _ => {}
        }
    }

    let mut coverages: HashMap<Uuid, Vec<Value>> = HashMap::new();
    let mut checks: HashMap<Uuid, Vec<Value>> = HashMap::new();
    let mut copays: HashMap<Uuid, Value> = HashMap::new();
    let mut balances: HashMap<Uuid, i64> = HashMap::new();
    if access.billing {
        for coverage in reads
            .rows(
                sqlx::query_scalar(
                    "SELECT jsonb_build_object('id',id,'patient_id',patient_id,'content',jsonb_build_object('status',content->'status','priority',content->'priority','effective_date',content->'effective_date','end_date',content->'end_date','copay_cents',content->'copay_cents'))
                     FROM insurance_coverages WHERE tenant_id=$1 AND patient_id=ANY($2) ORDER BY id LIMIT 20001",
                )
                .bind(tenant)
                .bind(&patient_ids),
            )
            .await?
        {
            if let Some(patient) = uuid(&coverage["patient_id"]) {
                coverages.entry(patient).or_default().push(coverage);
            }
        }
        // Net of verified refunds; a voided receipt counts for nothing. Test-mode card
        // payments are kept apart so they never read as money received.
        for row in reads
            .rows(
                sqlx::query_scalar(
                    "SELECT jsonb_build_object('appointment_id',r.appointment_id,
                     'paid_cents',coalesce(sum(r.net) FILTER(WHERE NOT r.test),0)::bigint,
                     'test_paid_cents',coalesce(sum(r.net) FILTER(WHERE r.test),0)::bigint)
                     FROM (SELECT c.appointment_id,
                      CASE WHEN EXISTS(SELECT 1 FROM billing_copay_voids x WHERE x.tenant_id=c.tenant_id AND x.receipt_id=c.id) THEN 0 ELSE greatest(0,c.amount_cents-coalesce(o.refunded_cents,0)) END AS net,
                      coalesce(o.livemode=false,false) AS test
                      FROM billing_copay_receipts c LEFT JOIN copay_checkout_attempts o ON o.tenant_id=c.tenant_id AND o.receipt_id=c.id
                      WHERE c.tenant_id=$1 AND c.appointment_id=ANY($2)) r
                     GROUP BY r.appointment_id",
                )
                .bind(tenant)
                .bind(&appointment_ids),
            )
            .await?
        {
            if let Some(appointment) = uuid(&row["appointment_id"]) {
                copays.insert(appointment, row);
            }
        }
        // What each patient owes now: the one figure the visit billing card, the patient
        // banner and the patient billing page show. Insurance-pending money is not in it.
        let rows = reads
            .rows(crate::visit_billing::balances_query(
                tenant,
                Some(&patient_ids),
                None,
                Some(false),
            ))
            .await?;
        balances = crate::visit_billing::owed_by_patient(&rows);
    }
    if access.insurance {
        let coverage_ids: Vec<Uuid> = coverages
            .values()
            .flatten()
            .filter_map(|coverage| uuid(&coverage["id"]))
            .collect();
        for check in reads
            .rows(
                sqlx::query_scalar(
                    "SELECT jsonb_build_object('coverage_id',coverage_id,'status',status,'created_at',created_at,
                     'service_date',coalesce(request_snapshot->'request'->>'service_date',request_snapshot->>'service_date'),
                     'codes',CASE WHEN status='completed' THEN jsonb_path_query_array(response_snapshot,'$.elig[*].benefit[*].benefit_coverage_code') END)
                     FROM claimmd_eligibility_checks
                     WHERE tenant_id=$1 AND coverage_id=ANY($2) AND status IN ('completed','failed') AND created_at>=$3 AND created_at<$4
                     ORDER BY created_at DESC,id DESC LIMIT 5001",
                )
                .bind(tenant)
                .bind(&coverage_ids)
                .bind(from - Duration::days(ELIGIBILITY_DAYS + 1))
                .bind(to + Duration::days(1)),
            )
            .await?
        {
            if let Some(coverage) = uuid(&check["coverage_id"]) {
                checks.entry(coverage).or_default().push(check);
            }
        }
    }

    let mut items = Vec::with_capacity(appointments.len());
    for appointment in &appointments {
        let (Some(id), Some(patient), Some(starts)) = (
            uuid(&appointment["id"]),
            uuid(&appointment["patient_id"]),
            time(&appointment["starts_at"]),
        ) else {
            continue;
        };
        let service_date = appointment["service_date"].as_str().unwrap_or_default();
        let mut item = Map::new();
        item.insert("appointment_id".into(), json!(id));
        item.insert("patient_id".into(), json!(patient));
        item.insert("new_patient".into(), appointment["new_patient"].clone());
        item.insert("visit_id".into(), appointment["visit_id"].clone());
        let form = appointment_forms.get(&id).copied().or_else(|| {
            patient_forms.get(&patient)?.iter().copied().find(|packet| {
                time(&packet["created_at"]).is_some_and(|sent| {
                    sent <= starts && sent >= starts - Duration::days(PATIENT_FORM_DAYS)
                })
            })
        });
        item.insert(
            "forms".into(),
            form.map_or(
                Value::Null,
                |packet| json!({"status":packet["status"],"packet_id":packet["id"]}),
            ),
        );
        if access.clinical {
            item.insert("note".into(), appointment["note"].clone());
        }
        if access.billing {
            let coverage = coverage_on(coverages.get(&patient), service_date);
            if access.insurance {
                let insurance = match coverage {
                    None => json!({"status":"self_pay"}),
                    Some(coverage) => {
                        let found = uuid(&coverage["id"])
                            .and_then(|coverage_id| checks.get(&coverage_id))
                            .and_then(|list| {
                                list.iter().find(|check| {
                                    check["service_date"].as_str() == Some(service_date)
                                        || time(&check["created_at"]).is_some_and(|at| {
                                            at <= starts + Duration::days(1)
                                                && at >= starts - Duration::days(ELIGIBILITY_DAYS)
                                        })
                                })
                            });
                        match found {
                            Some(check) => {
                                json!({"status":eligibility_status(check),"coverage_id":coverage["id"],"checked_at":check["created_at"]})
                            }
                            None => json!({"status":"not_checked","coverage_id":coverage["id"]}),
                        }
                    }
                };
                item.insert("insurance".into(), insurance);
            }
            let due = coverage
                .and_then(|coverage| coverage["content"]["copay_cents"].as_i64())
                .filter(|cents| *cents > 0);
            let paid = copays.get(&id);
            let paid_cents = paid.and_then(|row| row["paid_cents"].as_i64()).unwrap_or(0);
            let test_paid_cents = paid
                .and_then(|row| row["test_paid_cents"].as_i64())
                .unwrap_or(0);
            item.insert(
                "copay".into(),
                if due.is_none() && paid_cents == 0 && test_paid_cents == 0 {
                    Value::Null
                } else {
                    json!({"due_cents":due.unwrap_or(0),"paid_cents":paid_cents,"test_paid_cents":test_paid_cents})
                },
            );
            item.insert(
                "balance_cents".into(),
                json!(balances.get(&patient).copied().unwrap_or(0)),
            );
            item.insert("charges".into(), appointment["charges"].clone());
        }
        items.push(Value::Object(item));
    }
    Ok((items, reads.count))
}

async fn markers(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(q): Query<Range>,
) -> Result<Json<Value>> {
    a.staff()?;
    if q.to <= q.from || q.to - q.from > Duration::days(31) {
        return Err(Error::Invalid(
            "schedule range must be positive and at most 31 days",
        ));
    }
    let views =
        crate::access_policies::can_view(&s, &a, &["billing", "claims", "clinical"]).await?;
    let access = Access {
        billing: views[0],
        insurance: views[0] && views[1],
        clinical: views[2],
    };
    let pool = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let mut tx = pool.begin().await?;
    // Every fact describes the same moment, even while the front desk is working.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let (items, _) = collect(&mut tx, a.tenant_id, q.from, q.to, q.provider, access).await?;
    crate::postgres::audit(&mut tx, &a, "schedule.markers_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({
        "items": items,
        "billing": access.billing,
        "insurance": access.insurance,
        "clinical": access.clinical
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The number of range reads must not depend on how busy the day is.
    #[tokio::test]
    async fn the_number_of_reads_does_not_grow_with_the_schedule() {
        let url =
            std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
        let schema = format!("schedule_marker_reads_{}", Uuid::new_v4().simple());
        let scoped = schema.clone();
        let admin = sqlx::PgPool::connect(&url).await.unwrap();
        crate::test_db::create_schema(&admin, &schema).await;
        admin.close().await;
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .after_connect(move |connection, _| {
                let query = format!("SET search_path TO {scoped}");
                Box::pin(async move {
                    sqlx::query(&query).execute(connection).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        crate::MIGRATOR.run(&pool).await.unwrap();
        let (tenant, clinician, payer) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let from: DateTime<Utc> = "2031-03-14T06:00:00Z".parse().unwrap();
        let to = from + Duration::days(1);
        sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,'{}'::jsonb,$2,'synthetic')")
            .bind(tenant).bind(payer).execute(&pool).await.unwrap();
        let everything = Access {
            billing: true,
            insurance: true,
            clinical: true,
        };
        let schedule_only = Access {
            billing: false,
            insurance: false,
            clinical: false,
        };
        let mut counts = Vec::new();
        let mut booked = 0;
        for target in [0, 2, 40] {
            while booked < target {
                let (patient, appointment, coverage) =
                    (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
                sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Synthetic','Sample','1990-01-01')")
                    .bind(tenant).bind(patient).bind(patient.to_string()).execute(&pool).await.unwrap();
                sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,title,category,facility,room,notes,request_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,'Office visit','Office visit','','','',$2,'synthetic')")
                    .bind(tenant).bind(appointment).bind(patient).bind(clinician)
                    .bind(from + Duration::minutes(15 * booked)).bind(from + Duration::minutes(15 * booked + 15)).execute(&pool).await.unwrap();
                sqlx::query("INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,$2,'synthetic')")
                    .bind(tenant).bind(coverage).bind(patient).bind(payer)
                    .bind(json!({"priority":"primary","status":"active","effective_date":"2030-01-01","copay_cents":1500})).execute(&pool).await.unwrap();
                booked += 1;
            }
            let mut tx = pool.begin().await.unwrap();
            let (items, full) = collect(&mut tx, tenant, from, to, None, everything)
                .await
                .unwrap();
            let (plain, limited) = collect(&mut tx, tenant, from, to, None, schedule_only)
                .await
                .unwrap();
            tx.rollback().await.unwrap();
            assert_eq!(items.len() as i64, target);
            assert_eq!(plain.len() as i64, target);
            if let Some(first) = items.first() {
                assert_eq!(first["insurance"]["status"], "not_checked");
                assert_eq!(first["copay"]["due_cents"], 1500);
                assert!(plain[0].get("insurance").is_none() && plain[0].get("copay").is_none());
            }
            counts.push((full, limited));
        }
        assert_eq!(
            counts,
            vec![(6, 2); 3],
            "six reads with billing facts and two without, for 0, 2 and 40 appointments"
        );
    }

    #[test]
    fn eligibility_answers_follow_the_chart_summary() {
        let check = |status: &str, codes: Value| json!({"status":status,"codes":codes});
        assert_eq!(
            eligibility_status(&check("failed", json!(null))),
            "check_failed"
        );
        assert_eq!(
            eligibility_status(&check("completed", json!(["6", "1"]))),
            "active"
        );
        assert_eq!(
            eligibility_status(&check("completed", json!([1]))),
            "active"
        );
        assert_eq!(
            eligibility_status(&check("completed", json!(["6"]))),
            "not_active"
        );
        assert_eq!(
            eligibility_status(&check("completed", json!(["A"]))),
            "check_failed"
        );
        assert_eq!(
            eligibility_status(&check("completed", json!([]))),
            "check_failed"
        );
    }

    #[test]
    fn the_coverage_that_pays_first_is_active_on_the_service_date() {
        let coverage = |id: &str, priority: &str, status: &str, start: &str, end: Value| json!({"id":id,"content":{"priority":priority,"status":status,"effective_date":start,"end_date":end}});
        let list = vec![
            coverage(
                "secondary",
                "secondary",
                "active",
                "2026-01-01",
                json!(null),
            ),
            coverage(
                "ended",
                "primary",
                "active",
                "2025-01-01",
                json!("2025-12-31"),
            ),
            coverage("inactive", "primary", "inactive", "2026-01-01", json!(null)),
            coverage("primary", "primary", "active", "2026-02-01", json!("")),
        ];
        assert_eq!(
            coverage_on(Some(&list), "2026-03-01").unwrap()["id"],
            "primary"
        );
        assert_eq!(
            coverage_on(Some(&list), "2026-01-15").unwrap()["id"],
            "secondary"
        );
        assert_eq!(
            coverage_on(Some(&list), "2025-06-01").unwrap()["id"],
            "ended"
        );
        assert!(coverage_on(Some(&list), "2024-06-01").is_none());
        assert!(coverage_on(None, "2026-03-01").is_none());
    }
}
