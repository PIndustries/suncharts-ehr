// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Importing records from a previous system onto the right charts. Synthetic data only.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::Arc;
use suncharts_engine::{
    auth::{Actor, Role},
    browser::BrowserAuth,
    postgres::PostgresBackend,
    State,
};
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &str = "synthetic-record-import-test-secret";
const SOURCE: &str = "synthetic-emr";

struct Fixture {
    r: Router,
    db: PgPool,
    owner: Actor,
}
async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("record_import_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(5)
        .after_connect(move |c, _| {
            let q = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(&q).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let now = Utc::now().timestamp();
    let owner = Actor {
        sub: Uuid::new_v4(),
        tenant_id: Uuid::new_v4(),
        role: Role::Owner,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    };
    let r = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), "http://127.0.0.1:8099".into()).unwrap()),
    });
    Fixture { r, db, owner }
}
impl Fixture {
    fn staff(&self, role: Role) -> Actor {
        Actor {
            sub: Uuid::new_v4(),
            role,
            ..self.owner.clone()
        }
    }
    async fn send(
        &self,
        a: &Actor,
        method: &str,
        path: &str,
        body: Value,
        version: Option<i64>,
    ) -> (StatusCode, Value) {
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            a,
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();
        let mut q = Request::builder()
            .method(method)
            .uri(path)
            .header("Authorization", format!("Bearer {token}"));
        if let Some(v) = version {
            q = q.header("If-Match", format!("\"{v}\""));
        }
        let q = if body.is_null() {
            q.body(Body::empty()).unwrap()
        } else {
            q.header("Content-Type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let response = self.r.clone().oneshot(q).await.unwrap();
        let status = response.status();
        let raw = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&raw).unwrap_or(Value::Null))
    }
    async fn call(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        self.send(&self.owner, method, path, body, None).await
    }
    /// A chart entered by hand before the import.
    async fn chart(&self, given: &str, family: &str, birth: &str) -> Uuid {
        let (status, p) = self
            .call(
                "POST",
                "/api/v1/patients",
                json!({"given_name":given,"family_name":family,"birth_date":birth}),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{p}");
        p["id"].as_str().unwrap().parse().unwrap()
    }
    /// Creates a job, stages the items and returns (job id, reconcile report).
    async fn stage(&self, items: &[Value]) -> (String, Value) {
        let mut counts = serde_json::Map::new();
        for item in items {
            let kind = item["kind"].as_str().unwrap();
            let n = counts.get(kind).and_then(Value::as_u64).unwrap_or(0);
            counts.insert(kind.into(), json!(n + 1));
        }
        let (status, job) = self
            .call(
                "POST",
                "/api/v1/migrations",
                json!({"source_instance":SOURCE,"source_revision":"synthetic-export-1","expected_counts":counts,"consistency":"read_only_export"}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{job}");
        let id = job["id"].as_str().unwrap().to_owned();
        let (status, staged) = self
            .call(
                "POST",
                &format!("/api/v1/migrations/{id}/items"),
                json!({"items":items}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{staged}");
        let (status, report) = self
            .call(
                "POST",
                &format!("/api/v1/migrations/{id}/reconcile"),
                Value::Null,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{report}");
        assert_eq!(report["errors"], json!([]));
        (id, report)
    }
    async fn commit(&self, id: &str, report: &Value) -> (StatusCode, Value) {
        self.call(
            "POST",
            &format!("/api/v1/migrations/{id}/commit"),
            json!({"digest":report["digest"]}),
        )
        .await
    }
    async fn decide(
        &self,
        id: &str,
        source: &str,
        action: &str,
        chart: Option<Uuid>,
    ) -> (StatusCode, Value) {
        let mut body = json!({"source_id":source,"action":action});
        if let Some(chart) = chart {
            body["patient_id"] = json!(chart);
        }
        self.call(
            "POST",
            &format!("/api/v1/migrations/{id}/patient-decisions"),
            body,
        )
        .await
    }
    async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(&self.db).await.unwrap()
    }
    async fn imported_chart(&self, source: &str) -> Uuid {
        sqlx::query_scalar(
            "SELECT target_id FROM source_identifiers WHERE source_instance=$1 AND kind='patient' AND source_id=$2",
        )
        .bind(SOURCE)
        .bind(source)
        .fetch_one(&self.db)
        .await
        .unwrap()
    }
}
fn contact() -> Value {
    json!({"address":{"line1":"1 Synthetic Way","line2":"Suite 2","city":"Testville","region":"TX","postal_code":"75000","country":"US"},
        "phone":"+1-555-0100","email":"synthetic.patient@example.test","administrative_gender":"female","language":"Spanish"})
}
/// Records in the shape `scripts/import_ccda.py` stages for one patient.
fn person(source: &str, given: &str, family: &str, birth: &str) -> Vec<Value> {
    let record = |kind: &str, suffix: &str, data: Value, source_data: Value| json!({"kind":kind,"source_id":format!("{source}/{suffix}"),"patient_source_id":source,"data":data,"source_data":source_data});
    vec![
        json!({"kind":"patient","source_id":source,"patient_source_id":null,
            "data":{"mrn":format!("IM-{source}"),"given_name":given,"family_name":family,"birth_date":birth},
            "source_data":{"format":"hl7-ccda","contact":contact()}}),
        record(
            "form",
            "demographics",
            json!({"title":"Demographics (previous record system)","phone_mobile":"+1-555-0100"}),
            json!({"format":"hl7-ccda","section":"Demographics","contact":contact()}),
        ),
        record(
            "medical_problem",
            "problem-1",
            json!({"title":"Synthetic spasticity","codes":"ICD-10-CM G80.1"}),
            json!({"title":"Synthetic spasticity","begdate":"2020-03-04","activity":"1","comments":"Synthetic comment","diagnosis":"ICD-10-CM G80.1; SNOMED CT 1234567",
                "codes":[{"system":"ICD-10-CM","code":"G80.1","display":"Synthetic spasticity","system_oid":"2.16.840.1.113883.6.90"},
                    {"system":"SNOMED CT","code":"1234567","display":"Synthetic finding"},
                    {"system":"LOINC","code":"0000-0","display":"Synthetic survey"},
                    {"system":"ICD-10-CM","code":"Z99.9","system_conflict":true}]}),
        ),
        record(
            "medication",
            "med-1",
            json!({"title":"Synthetic relaxant 10 mg tablet"}),
            json!({"title":"Synthetic relaxant 10 mg tablet","begdate":"2023-02-01","activity":"1","dosage":"10 mg","route":"Oral",
                "codes":[{"system":"RxNorm","code":"99999","display":"Synthetic relaxant 10 MG"},{"system":"NDC","code":"00000-0000-00"}]}),
        ),
        record(
            "medication",
            "med-2",
            json!({"title":"Synthetic stopped medicine"}),
            json!({"title":"Synthetic stopped medicine","begdate":"2021-01-01","enddate":"2021-06-01","activity":"0",
                "codes":[{"system":"RxNorm","code":"88888"}]}),
        ),
        record(
            "insurance",
            "policy-1",
            json!({"title":"Synthetic Payer","policy_id":"SYN-MEMBER-1"}),
            json!({"format":"hl7-ccda","coverage":{"payer_name":"Synthetic Payer","member_id":"SYN-MEMBER-1","group_number":"SYN-GROUP","plan_name":"Synthetic PPO","relationship":"self","priority":"primary","effective_date":"2023-01-01"}}),
        ),
    ]
}
fn listed<'a>(report: &'a Value, source: &str) -> &'a Value {
    report["patients"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["source_id"] == source)
        .unwrap()
}

#[tokio::test]
async fn exact_match_attaches_to_the_existing_chart_without_touching_its_contact_details() {
    let f = setup().await;
    let chart = f.chart("Avery Quinn", "SYNTHETIC", "1990-01-01").await;
    let (status, _) = f
        .send(
            &f.owner,
            "PUT",
            &format!("/api/v1/patients/{chart}/demographics"),
            json!({"content":{"phone":"555-0000"},"reason":"Synthetic front desk entry"}),
            Some(0),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let items = person("1001", "Avery Q", "Synthetic", "1990-01-01");
    let (job, report) = f.stage(&items).await;
    let staged = listed(&report, "1001");
    assert_eq!(staged["status"], "match");
    assert_eq!(staged["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(staged["candidates"][0]["patient_id"], json!(chart));
    assert_eq!(staged["candidates"][0]["match"], "exact");
    assert!(staged["candidates"][0]["mrn"].as_str().is_some());
    // A single exact match is pre-selected, still listed for the owner to change.
    assert_eq!(
        staged["decision"],
        json!({"action":"attach","patient_id":chart,"preselected":true})
    );
    assert_eq!(report["patients_needing_decision"], 0);
    assert_eq!(report["ready_to_import"], true);
    // The chart lookup for attachments only answers for a committed job, and only to the owner.
    let links = format!("/api/v1/migrations/{job}/patient-links");
    assert_eq!(
        f.call("GET", &links, Value::Null).await.0,
        StatusCode::CONFLICT
    );
    let (status, done) = f.commit(&job, &report).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["status"], "imported");
    assert_eq!(f.count("SELECT count(*) FROM patients").await, 1);
    assert_eq!(f.imported_chart("1001").await, chart);
    assert_eq!(
        f.count("SELECT count(*) FROM audit_events WHERE action='migration.patient_attach'")
            .await,
        1
    );
    let (_, history) = f
        .call(
            "GET",
            &format!("/api/v1/patients/{chart}/history"),
            Value::Null,
        )
        .await;
    let history = history["items"].as_array().unwrap().clone();
    assert_eq!(history.len(), items.len() - 1);
    assert!(history
        .iter()
        .all(|h| h["signature_origin"] == "external_unverified"));
    // Existing native contact details are exactly as staff left them.
    let demographics = format!("/api/v1/patients/{chart}/demographics");
    let (_, native) = f.call("GET", &demographics, Value::Null).await;
    assert_eq!(native["version"], 1);
    assert_eq!(native["content"]["phone"], "555-0000");
    assert_eq!(native["content"]["email"], Value::Null);
    assert_eq!(native["content"]["address"], Value::Null);
    // "Use this" copies one imported value into an empty field and refuses a filled one.
    let form = history.iter().find(|h| h["kind"] == "form").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let use_contact = format!("/api/v1/patients/{chart}/history/{form}/use-contact");
    let (status, saved) = f.call("POST", &use_contact, json!({"field":"email"})).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["content"]["email"], "synthetic.patient@example.test");
    assert_eq!(saved["content"]["phone"], "555-0000");
    assert_eq!(
        saved["history"][0]["reason"],
        "Email copied from previous system records"
    );
    let (status, _) = f.call("POST", &use_contact, json!({"field":"phone"})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = f.call("POST", &use_contact, json!({"field":"email"})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = f.call("POST", &use_contact, json!({"field":"mrn"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, saved) = f
        .call("POST", &use_contact, json!({"field":"address"}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["content"]["address"]["city"], "Testville");
    let (_, native) = f.call("GET", &demographics, Value::Null).await;
    assert_eq!(native["content"]["phone"], "555-0000");
    assert_eq!(native["version"], 3);
    // Attachment target lookup: source patient id to the chart the records went to.
    let (status, found) = f.call("GET", &links, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        found["items"],
        json!([{"source_patient_id":"1001","patient_id":chart}])
    );
    let clinician = f.staff(Role::Clinician);
    assert_eq!(
        f.send(&clinician, "GET", &links, Value::Null, None).await.0,
        StatusCode::FORBIDDEN
    );
    // Importing the same export again finds the link and adds nothing.
    let records = f.count("SELECT count(*) FROM historical_records").await;
    let (again, report) = f.stage(&items).await;
    assert_eq!(listed(&report, "1001")["status"], "linked");
    assert_eq!(listed(&report, "1001")["chart"]["patient_id"], json!(chart));
    assert_eq!(report["ready_to_import"], true);
    assert_eq!(f.commit(&again, &report).await.0, StatusCode::OK);
    assert_eq!(f.count("SELECT count(*) FROM patients").await, 1);
    assert_eq!(
        f.count("SELECT count(*) FROM historical_records").await,
        records
    );
    assert_eq!(
        f.count("SELECT count(*) FROM source_identifiers WHERE kind='patient'")
            .await,
        1
    );
    let (_, native) = f.call("GET", &demographics, Value::Null).await;
    assert_eq!(native["version"], 3);
    f.db.close().await;
}

#[tokio::test]
async fn weak_or_multiple_matches_block_the_import_until_the_owner_decides() {
    let f = setup().await;
    // Same family name, initial and birth date, different first name.
    let similar = f.chart("Alex", "Synthetic", "1990-01-01").await;
    // Two hand-entered charts for the same person.
    let twin_a = f.chart("Blake", "Example", "1985-12-31").await;
    let twin_b = f.chart("Blake R", "Example", "1985-12-31").await;
    let mut items = person("1001", "Avery Q", "Synthetic", "1990-01-01");
    items.extend(person("2002", "Blake", "Example", "1985-12-31"));
    items.extend(person("3003", "Casey", "Unmatched", "1970-07-07"));
    // Sorted by kind then source id, as the importer orders a snapshot.
    let (job, report) = f.stage(&items).await;
    assert_eq!(listed(&report, "1001")["status"], "possible");
    assert_eq!(listed(&report, "1001")["candidates"][0]["match"], "similar");
    assert_eq!(listed(&report, "1001")["decision"], Value::Null);
    assert_eq!(listed(&report, "2002")["status"], "possible");
    assert_eq!(
        listed(&report, "2002")["candidates"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(listed(&report, "2002")["decision"], Value::Null);
    assert_eq!(listed(&report, "3003")["status"], "new");
    assert_eq!(report["patients_needing_decision"], 2);
    assert_eq!(report["ready_to_import"], false);
    let (status, refused) = f.commit(&job, &report).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(f.count("SELECT count(*) FROM patients").await, 3);
    assert_eq!(f.count("SELECT count(*) FROM historical_records").await, 0);
    // Only a listed candidate can be chosen, and a new patient needs no decision.
    assert_eq!(
        f.decide(&job, "1001", "attach", Some(twin_a)).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.decide(&job, "1001", "attach", None).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.decide(&job, "3003", "create", None).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.decide(&job, "9999", "create", None).await.0,
        StatusCode::NOT_FOUND
    );
    let clinician = f.staff(Role::Clinician);
    assert_eq!(
        f.send(
            &clinician,
            "POST",
            &format!("/api/v1/migrations/{job}/patient-decisions"),
            json!({"source_id":"1001","action":"create"}),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, view) = f.decide(&job, "1001", "create", None).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["report"]["patients_needing_decision"], 1);
    assert_eq!(
        f.commit(&job, &report).await.0,
        StatusCode::CONFLICT,
        "one patient is still undecided"
    );
    let (status, view) = f.decide(&job, "2002", "attach", Some(twin_b)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["report"]["ready_to_import"], true);
    assert_eq!(
        listed(&view["report"], "2002")["decision"],
        json!({"action":"attach","patient_id":twin_b})
    );
    // Checking the file again keeps the decisions already made.
    let (_, rechecked) = f
        .call(
            "POST",
            &format!("/api/v1/migrations/{job}/reconcile"),
            Value::Null,
        )
        .await;
    assert_eq!(rechecked["ready_to_import"], true);
    assert_eq!(
        listed(&rechecked, "1001")["decision"],
        json!({"action":"create"})
    );
    let (status, done) = f.commit(&job, &report).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    // Two new charts (the declined similar match and the unmatched patient); the twin is reused.
    assert_eq!(f.count("SELECT count(*) FROM patients").await, 5);
    assert_eq!(f.imported_chart("2002").await, twin_b);
    let created = f.imported_chart("1001").await;
    assert!(created != similar && created != twin_a && created != twin_b);
    for untouched in [similar, twin_a] {
        let (_, history) = f
            .call(
                "GET",
                &format!("/api/v1/patients/{untouched}/history"),
                Value::Null,
            )
            .await;
        assert_eq!(history["items"], json!([]));
    }
    // A chart the import created gets the previous system's contact details as its own.
    let (_, native) = f
        .call(
            "GET",
            &format!("/api/v1/patients/{created}/demographics"),
            Value::Null,
        )
        .await;
    assert_eq!(native["version"], 1);
    let mut expected = contact();
    expected["preferred_name"] = Value::Null;
    expected["pronouns"] = Value::Null;
    expected["emergency_contact"] = Value::Null;
    assert_eq!(native["content"], expected);
    assert_eq!(
        native["history"][0]["reason"],
        "Imported from previous system (synthetic-emr)"
    );
    assert_eq!(native["history"][0]["author_id"], json!(f.owner.sub));
    // The attached chart had no contact details and still has none of its own.
    let (_, native) = f
        .call(
            "GET",
            &format!("/api/v1/patients/{twin_b}/demographics"),
            Value::Null,
        )
        .await;
    assert_eq!(native["version"], 0);
    f.db.close().await;
}

#[tokio::test]
async fn owner_can_create_a_new_chart_instead_of_the_preselected_match() {
    let f = setup().await;
    let chart = f.chart("Avery", "Synthetic", "1990-01-01").await;
    let mut items = person("1001", "Avery Q", "Synthetic", "1990-01-01");
    // Contact values the chart would reject are dropped one by one, not the whole profile.
    items[0]["source_data"]["contact"] = json!({"phone":"call the neighbour","email":"synthetic.patient@example.test",
        "administrative_gender":"F","language":"English","address":{"city":"Testville","country":"Atlantis"}});
    let (job, report) = f.stage(&items).await;
    assert_eq!(listed(&report, "1001")["decision"]["action"], "attach");
    let (status, view) = f.decide(&job, "1001", "create", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        listed(&view["report"], "1001")["decision"],
        json!({"action":"create"})
    );
    assert_eq!(f.commit(&job, &report).await.0, StatusCode::OK);
    assert_eq!(f.count("SELECT count(*) FROM patients").await, 2);
    let created = f.imported_chart("1001").await;
    assert_ne!(created, chart);
    assert_eq!(
        f.count("SELECT count(*) FROM audit_events WHERE action='migration.patient_attach'")
            .await,
        0
    );
    let (_, native) = f
        .call(
            "GET",
            &format!("/api/v1/patients/{created}/demographics"),
            Value::Null,
        )
        .await;
    assert_eq!(native["content"]["email"], "synthetic.patient@example.test");
    assert_eq!(native["content"]["language"], "English");
    assert_eq!(native["content"]["phone"], Value::Null);
    assert_eq!(native["content"]["administrative_gender"], Value::Null);
    assert_eq!(native["content"]["address"]["city"], "Testville");
    assert_eq!(native["content"]["address"]["country"], Value::Null);
    let (_, history) = f
        .call(
            "GET",
            &format!("/api/v1/patients/{chart}/history"),
            Value::Null,
        )
        .await;
    assert_eq!(history["items"], json!([]));
    // Decisions close with the import.
    assert_eq!(
        f.decide(&job, "1001", "attach", Some(chart)).await.0,
        StatusCode::CONFLICT
    );
    f.db.close().await;
}

#[tokio::test]
async fn reconciling_keeps_source_codes_and_a_whole_list_can_be_accepted_at_once() {
    let f = setup().await;
    let mut items = person("1001", "Avery Q", "Synthetic", "1990-01-01");
    items.push(json!({"kind":"medication","source_id":"1001/med-3","patient_source_id":"1001","data":{"title":"Synthetic undated entry"},
        "source_data":{"title":"","begdate":"2022-01-01","activity":"1","codes":[]}}));
    let (job, report) = f.stage(&items).await;
    assert_eq!(listed(&report, "1001")["status"], "new");
    assert_eq!(f.commit(&job, &report).await.0, StatusCode::OK);
    let chart = f.imported_chart("1001").await;
    let clinician = f.staff(Role::Clinician);
    let (_, history) = f
        .call(
            "GET",
            &format!("/api/v1/patients/{chart}/history"),
            Value::Null,
        )
        .await;
    let ids = |kind: &str| -> Vec<Value> {
        history["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|h| h["kind"] == kind)
            .map(|h| h["id"].clone())
            .collect()
    };
    // The contact block and the lists staff act on lead the chart's imported records.
    assert!(history["items"][0]["source_data"]["contact"].is_object());
    assert!(history["items"].as_array().unwrap()[1..6]
        .iter()
        .all(|h| h["kind"] != "form"));
    // One entry at a time: the suggested native entry carries the source codes.
    let problem = ids("medical_problem")[0].as_str().unwrap().to_owned();
    let (status, mapping) = f
        .send(
            &clinician,
            "GET",
            &format!("/api/v1/patients/{chart}/history/{problem}/mapping"),
            Value::Null,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        mapping["content"]["codes"],
        json!([{"system":"ICD-10-CM","code":"G80.1","display":"Synthetic spasticity"},
            {"system":"SNOMED CT","code":"1234567","display":"Synthetic finding"}])
    );
    let notes = mapping["content"]["notes"].as_str().unwrap();
    assert!(notes.starts_with("Synthetic comment"));
    assert!(notes.contains("LOINC 0000-0") && notes.contains("ICD-10-CM Z99.9"));
    let (status, entry) = f
        .send(
            &clinician,
            "POST",
            &format!("/api/v1/patients/{chart}/clinical"),
            json!({"content":mapping["content"],"reason":"Reconciled from previous system records","source_history_id":problem}),
            None,
        )
        .await;
    assert!(status.is_success(), "{entry}");
    assert_eq!(entry["content"]["codes"][0]["code"], "G80.1");
    assert_eq!(entry["source_history_id"], json!(problem));
    // Reconcile all: every reviewed medication becomes its own attributed entry with its codes.
    let all = format!("/api/v1/patients/{chart}/clinical-reconcile/medication");
    let medications = ids("medication");
    assert_eq!(medications.len(), 3);
    assert_eq!(
        f.send(
            &f.staff(Role::FrontDesk),
            "POST",
            &all,
            json!({"history_ids":medications}),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.send(
            &clinician,
            "POST",
            &all,
            json!({"history_ids":[problem]}),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST,
        "a problem is not accepted into the medication list"
    );
    let (status, done) = f
        .send(
            &clinician,
            "POST",
            &all,
            json!({"history_ids":medications}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    let created = done["created"].as_array().unwrap();
    assert_eq!(created.len(), 2);
    // The entry without a name is handed back for a closer look instead of being guessed.
    assert_eq!(done["needs_review"].as_array().unwrap().len(), 1);
    for entry in created {
        assert_eq!(entry["kind"], "medication");
        assert_eq!(entry["created_by"], json!(clinician.sub));
        assert!(medications.contains(&entry["source_history_id"]));
        assert_eq!(entry["content"]["verification"], "unconfirmed");
        let (_, revisions) = f
            .send(
                &clinician,
                "GET",
                &format!(
                    "/api/v1/patients/{chart}/clinical/{}/revisions",
                    entry["id"].as_str().unwrap()
                ),
                Value::Null,
                None,
            )
            .await;
        assert_eq!(revisions["items"].as_array().unwrap().len(), 1);
        assert_eq!(revisions["items"][0]["author_id"], json!(clinician.sub));
        assert_eq!(
            revisions["items"][0]["reason"],
            "Reconciled from previous system records after clinician review"
        );
    }
    let active = created
        .iter()
        .find(|e| e["content"]["title"] == "Synthetic relaxant 10 mg tablet")
        .unwrap();
    assert_eq!(
        active["content"]["codes"],
        json!([{"system":"RxNorm","code":"99999","display":"Synthetic relaxant 10 MG"},
            {"system":"NDC","code":"00000-0000-00","display":""}])
    );
    assert_eq!(active["content"]["status"], "active");
    assert_eq!(active["content"]["detail"]["dose"], "10 mg");
    let stopped = created
        .iter()
        .find(|e| e["content"]["title"] == "Synthetic stopped medicine")
        .unwrap();
    assert_eq!(stopped["content"]["status"], "stopped");
    assert_eq!(stopped["content"]["end_date"], "2021-06-01");
    // Accepting the same list again adds nothing.
    let (_, again) = f
        .send(
            &clinician,
            "POST",
            &all,
            json!({"history_ids":medications}),
            None,
        )
        .await;
    assert_eq!(again["created"], json!([]));
    assert_eq!(again["already_reconciled"], 2);
    assert_eq!(
        f.count("SELECT count(*) FROM clinical_entries WHERE kind='medication'")
            .await,
        2
    );
    // Imported content stays attributed to the previous system; nothing was signed natively.
    assert!(history["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|h| h["signature_origin"] == "external_unverified" && h["source_instance"] == SOURCE));
    f.db.close().await;
}
