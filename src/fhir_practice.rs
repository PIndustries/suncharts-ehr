// SPDX-License-Identifier: AGPL-3.0-only
//! Read-only projections of native scheduling, provider, facility and coverage records.
use super::{origin, search_bundle, Failure, Fhir};
use crate::{auth::Actor, error::Error, State};
use axum::{
    extract::{OriginalUri, Path, RawQuery, State as ExtractState},
    routing::get,
    Router,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(super) const RESOURCES: [&str; 4] = ["Appointment", "Practitioner", "Location", "Coverage"];
pub(super) fn routes() -> Router<State> {
    let mut r = Router::new();
    for kind in RESOURCES {
        r = r
            .route(&format!("/fhir/{kind}"), get(search))
            .route(&format!("/fhir/{kind}/{{id}}"), get(read));
    }
    r
}
pub(super) fn capability(kind: &str) -> Value {
    let mut params = vec![json!({"name":"_id","type":"token"})];
    if matches!(kind, "Appointment" | "Coverage") {
        params.push(json!({"name":"patient","type":"reference","documentation":"Exact patient UUID or relative Patient reference"}));
    } else {
        params.push(json!({"name":"name","type":"string","documentation":"Case-insensitive prefix of the recorded display name"}));
        params.push(json!({"name":"active","type":"token","documentation":"Exact true or false; Location uses status instead"}));
        if kind == "Location" {
            params.pop();
            params
                .push(json!({"name":"status","type":"token","documentation":"active or inactive"}));
        }
    }
    json!({"type":kind,"documentation":if kind=="Coverage" {"Staff-only; OAuth2 billing.read is required. Native coverage registration does not establish eligibility."} else {"Staff-only; OAuth2 clinical.read is required."},"versioning":"no-version","interaction":[{"code":"read"},{"code":"search-type"}],"searchParam":params})
}
#[derive(Default)]
struct Query {
    params: BTreeMap<String, String>,
    id: Option<Uuid>,
    patient: Option<Uuid>,
    after: Option<Uuid>,
    count: i64,
    name: Option<String>,
    active: Option<bool>,
}
impl Query {
    fn parse(kind: &str, raw: Option<&str>) -> Result<Self, Failure> {
        let mut q = Self {
            count: 50,
            ..Default::default()
        };
        let patient_kind = matches!(kind, "Appointment" | "Coverage");
        for (k, v) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
            let allowed = matches!(k.as_ref(), "_id" | "_after" | "_count")
                || (patient_kind && k == "patient")
                || (!patient_kind && k == "name")
                || (kind == "Practitioner" && k == "active")
                || (kind == "Location" && k == "status");
            if !allowed || q.params.insert(k.into_owned(), v.into_owned()).is_some() {
                return Err(Error::Invalid("unsupported or repeated search parameter").into());
            }
        }
        for (key, dest) in [
            ("_id", &mut q.id),
            ("_after", &mut q.after),
            ("patient", &mut q.patient),
        ] {
            if let Some(v) = q.params.get(key) {
                *dest = Some(
                    if key == "patient" {
                        v.strip_prefix("Patient/").unwrap_or(v)
                    } else {
                        v
                    }
                    .parse()
                    .map_err(|_| Error::Invalid("expected UUID or relative Patient reference"))?,
                );
            }
        }
        if let Some(v) = q.params.get("_count") {
            q.count = v.parse().map_err(|_| Error::Invalid("invalid count"))?;
        }
        if !(1..=100).contains(&q.count) {
            return Err(Error::Invalid("count must be between 1 and 100").into());
        }
        q.name = q.params.get("name").cloned();
        if q.name
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.chars().count() > 200)
        {
            return Err(Error::Invalid("name must contain 1 to 200 characters").into());
        }
        q.active = match q
            .params
            .get(if kind == "Location" {
                "status"
            } else {
                "active"
            })
            .map(String::as_str)
        {
            None => None,
            Some("true") if kind == "Practitioner" => Some(true),
            Some("false") if kind == "Practitioner" => Some(false),
            Some("active") if kind == "Location" => Some(true),
            Some("inactive") if kind == "Location" => Some(false),
            _ => return Err(Error::Invalid("unsupported resource status filter").into()),
        };
        Ok(q)
    }
}
async fn rows(
    s: &State,
    a: &Actor,
    kind: &str,
    q: &Query,
    read: bool,
) -> Result<Vec<Value>, Failure> {
    let db = &s.browser.as_ref().ok_or(Error::NotFound)?.db;
    let mut tx = db.begin().await.map_err(Error::from)?;
    let source=match kind {
        "Appointment"=>"SELECT to_jsonb(a)-'tenant_id' AS data,a.id,a.patient_id,NULL::text AS name,NULL::boolean AS active FROM appointments a WHERE a.tenant_id=$1",
        "Coverage"=>"SELECT (to_jsonb(c)-'tenant_id') || jsonb_build_object('payer_name',p.content->>'name') AS data,c.id,c.patient_id,NULL::text AS name,NULL::boolean AS active FROM insurance_coverages c JOIN ehr_payers p ON p.tenant_id=c.tenant_id AND p.id=c.payer_id WHERE c.tenant_id=$1",
        "Location"=>"SELECT to_jsonb(f)-'tenant_id' AS data,f.id,NULL::uuid AS patient_id,f.name,f.active FROM practice_facilities f WHERE f.tenant_id=$1",
        "Practitioner"=>"SELECT jsonb_build_object('id',u.id,'display_name',coalesce(nullif(p.display_name,''),nullif(u.display_name,''),u.email),'npi',coalesce(p.npi,''),'active',NOT u.disabled AND u.role IN ('owner','clinician') AND coalesce(p.active,true)) AS data,u.id,NULL::uuid AS patient_id,coalesce(nullif(p.display_name,''),nullif(u.display_name,''),u.email) AS name,(NOT u.disabled AND u.role IN ('owner','clinician') AND coalesce(p.active,true)) AS active FROM browser_users u LEFT JOIN practice_providers p ON p.tenant_id=u.tenant_id AND p.id=u.id WHERE u.tenant_id=$1 AND (u.role IN ('owner','clinician') OR p.id IS NOT NULL)",
        _=>return Err(Error::NotFound.into())
    };
    // Only fixed source fragments above are interpolated; all caller values bind.
    let sql=format!("SELECT data FROM ({source}) r WHERE ($2::uuid IS NULL OR id=$2) AND ($3::uuid IS NULL OR patient_id=$3) AND ($4::uuid IS NULL OR id>$4) AND ($5::text IS NULL OR starts_with(lower(name),lower($5))) AND ($6::boolean IS NULL OR active=$6) ORDER BY id LIMIT $7");
    let rows = sqlx::query_scalar(&sql)
        .bind(a.tenant_id)
        .bind(q.id)
        .bind(q.patient)
        .bind(q.after)
        .bind(&q.name)
        .bind(q.active)
        .bind(q.count + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(Error::from)?;
    crate::postgres::audit(
        &mut tx,
        a,
        if read {
            "practice.fhir_read"
        } else {
            "practice.fhir_search"
        },
        q.id.or(q.patient).unwrap_or(a.tenant_id),
    )
    .await?;
    tx.commit().await.map_err(Error::from)?;
    Ok(rows)
}
fn nonempty(v: &Value) -> Option<&str> {
    v.as_str().filter(|v| !v.is_empty())
}
fn reference(kind: &str, id: &Value) -> Value {
    json!({"reference":format!("{kind}/{}",id.as_str().unwrap_or_default())})
}
fn resource(kind: &str, row: &Value, base: &str) -> Value {
    let mut out = json!({"resourceType":kind,"id":row["id"]});
    match kind {
        "Appointment" => {
            out["status"] = json!(match row["status"].as_str().unwrap_or("") {
                "booked" => "booked",
                "checked_in" => "checked-in",
                "in_progress" => "fulfilled",
                "completed" => "fulfilled",
                "cancelled" => "cancelled",
                "no_show" => "noshow",
                _ => "proposed",
            });
            out["description"] = row["title"].clone();
            out["start"] = row["starts_at"].clone();
            out["end"] = row["ends_at"].clone();
            // Native booking does not capture each participant's acceptance.
            out["participant"] = json!([{"actor":reference("Patient",&row["patient_id"]),"status":"needs-action"},{"actor":reference("Practitioner",&row["clinician_id"]),"status":"needs-action"}]);
            if let Some(category) = nonempty(&row["category"]) {
                out["serviceCategory"] = json!([{"text":category}]);
            }
            if let Some(note) = nonempty(&row["notes"]) {
                out["comment"] = json!(note);
            }
            let location = [nonempty(&row["facility"]), nonempty(&row["room"])]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ");
            if !location.is_empty() {
                out["supportingInformation"] = json!([{"display":location}]);
            }
        }
        "Practitioner" => {
            out["active"] = row["active"].clone();
            out["name"] = json!([{"text":row["display_name"]}]);
            if let Some(npi) = nonempty(&row["npi"]) {
                out["identifier"] =
                    json!([{"system":"http://hl7.org/fhir/sid/us-npi","value":npi}]);
            }
        }
        "Location" => {
            out["status"] = json!(if row["active"] == true {
                "active"
            } else {
                "inactive"
            });
            out["name"] = row["name"].clone();
            out["mode"] = json!("instance");
            if let Some(addr) = nonempty(&row["address"]) {
                out["address"] = json!({"text":addr});
            }
            if let Some(phone) = nonempty(&row["phone"]) {
                out["telecom"] = json!([{"system":"phone","value":phone}]);
            }
        }
        "Coverage" => {
            let c = &row["content"];
            match c["status"].as_str() {
                Some("active") => out["status"] = json!("active"),
                Some("entered_in_error") => out["status"] = json!("entered-in-error"),
                _ => {
                    // Native inactive does not distinguish expiration/cancellation.
                    out["_status"] = json!({"extension":[{"url":"http://hl7.org/fhir/StructureDefinition/data-absent-reason","valueCode":"unknown"}]});
                    out["extension"] = json!([{"url":format!("{base}/fhir/StructureDefinition/native-coverage-status"),"valueCode":"inactive"}]);
                }
            }
            out["beneficiary"] = reference("Patient", &row["patient_id"]);
            out["identifier"] = json!([{"system":format!("{base}/identifier/coverage-member"),"value":c["member_id"]}]);
            out["relationship"] = json!({"coding":[{"system":"http://terminology.hl7.org/CodeSystem/subscriber-relationship","code":c["relationship"]}]});
            out["subscriber"] = if c["relationship"] == "self" {
                reference("Patient", &row["patient_id"])
            } else {
                json!({"display":c["subscriber_name"]})
            };
            out["period"] = json!({"start":c["effective_date"]});
            if !c["end_date"].is_null() {
                out["period"]["end"] = c["end_date"].clone();
            }
            out["order"] = json!(match c["priority"].as_str() {
                Some("secondary") => 2,
                Some("tertiary") => 3,
                _ => 1,
            });
            out["payor"] = json!([{"identifier":{"system":format!("{base}/identifier/payer"),"value":row["payer_id"]},"display":row["payer_name"]}]);
            let mut classes = vec![];
            for (key, code) in [("group_number", "group"), ("plan_name", "plan")] {
                if let Some(v) = nonempty(&c[key]) {
                    classes.push(json!({"type":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/coverage-class","code":code}]},"value":v}));
                }
            }
            if !classes.is_empty() {
                out["class"] = json!(classes);
            }
        }
        _ => {}
    }
    out
}
async fn read(
    actor: Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<String>,
    OriginalUri(uri): OriginalUri,
) -> Result<Fhir, Failure> {
    let a = actor?;
    a.staff()?;
    let kind = uri.path().split('/').nth(2).ok_or(Error::NotFound)?;
    let q = Query {
        id: Some(id.parse().map_err(|_| Error::NotFound)?),
        count: 1,
        ..Default::default()
    };
    let rows = rows(&s, &a, kind, &q, true).await?;
    Ok(Fhir(resource(
        kind,
        rows.first().ok_or(Error::NotFound)?,
        origin(&s)?,
    )))
}
async fn search(
    actor: Result<Actor, Error>,
    ExtractState(s): ExtractState<State>,
    RawQuery(raw): RawQuery,
    OriginalUri(uri): OriginalUri,
) -> Result<Fhir, Failure> {
    let a = actor?;
    a.staff()?;
    let kind = uri.path().split('/').nth(2).ok_or(Error::NotFound)?;
    let q = Query::parse(kind, raw.as_deref())?;
    let mut rows = rows(&s, &a, kind, &q, false).await?;
    let more = rows.len() > q.count as usize;
    if more {
        rows.pop();
    }
    let base = origin(&s)?;
    let mut links = vec![
        json!({"relation":"self","url":format!("{base}/fhir/{kind}{}",raw.as_ref().map(|v|format!("?{v}")).unwrap_or_default())}),
    ];
    if more {
        if let Some(last) = rows.last() {
            let mut next = url::Url::parse(&format!("{base}/fhir/{kind}"))
                .map_err(|_| Error::Invalid("invalid installation URL"))?;
            for (k, v) in &q.params {
                if k != "_after" {
                    next.query_pairs_mut().append_pair(k, v);
                }
            }
            next.query_pairs_mut()
                .append_pair("_after", last["id"].as_str().ok_or(Error::NotFound)?);
            links.push(json!({"relation":"next","url":next.as_str()}));
        }
    }
    Ok(search_bundle(links,rows.iter().map(|r|json!({"fullUrl":format!("{base}/fhir/{kind}/{}",r["id"].as_str().unwrap_or_default()),"resource":resource(kind,r,base),"search":{"mode":"match"}})).collect()))
}
