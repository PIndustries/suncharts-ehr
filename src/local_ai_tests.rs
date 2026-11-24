// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic data only. Each test runs in its own disposable schema.
use super::*;
use crate::{
    auth::{Actor, Role},
    browser::BrowserAuth,
    postgres::PostgresBackend,
};
use axum::{body::Body, http::Request};
use chrono::Utc;
use http_body_util::BodyExt;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

const SECRET: &str = "synthetic-local-ai-test-secret";

struct Fixture {
    db: PgPool,
    owner: Actor,
    patient: Uuid,
    visit: Uuid,
}
async fn pool_at(revision: Option<i64>) -> PgPool {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("local_ai_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    crate::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(6)
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
    match revision {
        None => crate::MIGRATOR.run(&db).await.unwrap(),
        Some(revision) => sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(
                crate::MIGRATOR
                    .iter()
                    .filter(|m| m.version <= revision)
                    .cloned()
                    .collect(),
            ),
            ..sqlx::migrate::Migrator::DEFAULT
        }
        .run(&db)
        .await
        .unwrap(),
    }
    db
}
fn actor(tenant: Uuid, role: Role) -> Actor {
    let now = Utc::now().timestamp();
    Actor {
        sub: Uuid::new_v4(),
        tenant_id: tenant,
        role,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    }
}
async fn user(db: &PgPool, a: &Actor, role: &str) {
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,disabled) VALUES($1,$2,$3,'synthetic-not-a-login',$4,false)").bind(a.sub).bind(a.tenant_id).bind(format!("{}@example.test",a.sub.simple())).bind(role).execute(db).await.unwrap();
}
/// A tenant with an owner, an open encounter whose note is `note`, and an ICD-10-CM list.
async fn setup_with(note: Value) -> Fixture {
    let db = pool_at(None).await;
    let owner = actor(Uuid::new_v4(), Role::Owner);
    user(&db, &owner, "owner").await;
    let (patient, appointment, visit) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-MRN-4417','Zelda','Quillfeather','1987-03-09')").bind(owner.tenant_id).bind(patient).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')").bind(owner.tenant_id).bind(appointment).bind(patient).bind(owner.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,note) VALUES($1,$2,$3,$4,$5,$6)").bind(owner.tenant_id).bind(visit).bind(patient).bind(appointment).bind(owner.sub).bind(note).execute(&db).await.unwrap();
    let release = Uuid::new_v4();
    sqlx::query("INSERT INTO terminology_releases(tenant_id,id,system,edition,source_name,source_url,source_sha256,effective_start,rights,rights_attested,request_id,request_digest,code_count,created_by,reason) VALUES($1,$2,'ICD-10-CM','synthetic','Synthetic list','https://example.test/list',$3,'2020-01-01','public_use',true,$4,$5,40,$6,'Synthetic')").bind(owner.tenant_id).bind(release).bind("a".repeat(64)).bind(Uuid::new_v4()).bind("b".repeat(64)).bind(owner.sub).execute(&db).await.unwrap();
    let mut codes = vec![
        (
            "E11.9",
            "Type 2 diabetes mellitus without complications (catalog wording)",
            true,
        ),
        ("I10", "Essential (primary) hypertension", true),
        ("E11", "Type 2 diabetes mellitus", false),
        (
            "J06.9",
            "Acute upper respiratory infection, unspecified",
            true,
        ),
    ];
    codes.extend([
        ("G24", "Dystonia", false),
        ("G24.1", "Genetic torsion dystonia", true),
        ("G24.3", "Spasmodic torticollis", true),
        (
            "G44.229",
            "Chronic tension-type headache, not intractable",
            true,
        ),
        (
            "G44.209",
            "Tension-type headache, unspecified, not intractable",
            true,
        ),
    ]);
    let many: Vec<String> = (0..12).map(|i| format!("Q10.{}", i)).collect();
    for c in &many {
        codes.push((c.as_str(), "Synthetic listed code", true));
    }
    for (code, display, billable) in codes {
        sqlx::query("INSERT INTO terminology_codes(tenant_id,release_id,code,code_key,display,billable,active,effective_start) VALUES($1,$2,$3,$4,$5,$6,true,'2020-01-01')").bind(owner.tenant_id).bind(release).bind(code).bind(code.replace('.', "")).bind(display).bind(billable).execute(&db).await.unwrap();
    }
    Fixture {
        db,
        owner,
        patient,
        visit,
    }
}
async fn setup() -> Fixture {
    setup_with(json!({"subjective":"Synthetic history text","objective":"Synthetic exam text","assessment":"Type 2 diabetes mellitus without complications, stable on metformin.","plan":"Continue metformin. Recheck blood pressure; essential hypertension is controlled."})).await
}

type Sent = Arc<Mutex<Vec<Value>>>;
impl Fixture {
    async fn ask(&self, a: &Actor, request: Uuid, position: i64) -> (Result<Value>, Sent) {
        let sent: Sent = Arc::default();
        let log = sent.clone();
        let out = request_for(&self.db, a, self.visit, request, move |body| async move {
            log.lock().unwrap().push(body);
            Ok(json!({"request_id":request,"status":"queued","position":position}))
        })
        .await;
        (out, sent)
    }
    async fn read_with(&self, a: &Actor, job: Value) -> Result<Value> {
        self.step(a, job, Ok(0)).await.0
    }
    /// Reads while Connect reports `job`; a second job, if one is submitted, is logged and
    /// accepted at `place` (or refused with the error text when `place` is an error).
    async fn step(
        &self,
        a: &Actor,
        job: Value,
        place: std::result::Result<i64, Error>,
    ) -> (Result<Value>, Sent) {
        let sent: Sent = Arc::default();
        let log = sent.clone();
        let out = read(
            &self.db,
            a,
            self.visit,
            |_| async move { Ok(job) },
            move |body| async move {
                log.lock().unwrap().push(body.clone());
                place.map(
                    |n| json!({"request_id":body["request_id"],"status":"queued","position":n}),
                )
            },
        )
        .await;
        (out, sent)
    }
    /// Finishes the first job with `first`, then the second with `second`; returns the body sent
    /// for the second job and the final reading.
    async fn two_steps(&self, a: &Actor, id: Uuid, first: &str, second: &str) -> (Value, Value) {
        let (out, sent) = self.step(a, done(id, first), Ok(3)).await;
        let out = out.unwrap();
        assert_eq!(out["status"], "queued", "{out}");
        let body = sent
            .lock()
            .unwrap()
            .first()
            .cloned()
            .expect("a second job was submitted");
        let second_id = choose_job_id(id);
        assert_eq!(body["request_id"], json!(second_id));
        (
            body,
            self.read_with(a, done(second_id, second)).await.unwrap(),
        )
    }
    async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sql)
            .bind(self.owner.tenant_id)
            .fetch_one(&self.db)
            .await
            .unwrap()
    }
    async fn audits(&self, action: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action=$2 AND resource_id=$3",
        )
        .bind(self.owner.tenant_id)
        .bind(action)
        .bind(self.visit)
        .fetch_one(&self.db)
        .await
        .unwrap()
    }
}
use request as request_for;
fn done(request: Uuid, content: &str) -> Value {
    json!({"request_id":request,"status":"done","position":null,"content":content,"model":"synthetic-model","machine":"primary","prompt_tokens":10,"completion_tokens":10,"elapsed_ms":5,"error":null})
}
fn err_text<T: std::fmt::Debug>(r: Result<T>) -> String {
    r.unwrap_err().to_string()
}

#[test]
fn answers_are_found_inside_fences_and_text() {
    assert_eq!(first_object("```json\n{\"a\":1}\n```"), Some("{\"a\":1}"));
    assert_eq!(
        first_object("Here you go: {\"a\":{\"b\":\"}\"}} thanks"),
        Some("{\"a\":{\"b\":\"}\"}}")
    );
    assert_eq!(
        first_object("{\"a\":\"\\\"}\"} tail"),
        Some("{\"a\":\"\\\"}\"}")
    );
    assert_eq!(first_object("no object"), None);
    assert_eq!(first_object("{\"a\":1"), None);
}
#[test]
fn codes_are_normalised_and_shape_checked() {
    assert_eq!(normalise_code(" e119 ").as_deref(), Some("E11.9"));
    assert_eq!(normalise_code("i10").as_deref(), Some("I10"));
    assert_eq!(normalise_code("S06.0X0A").as_deref(), Some("S06.0X0A"));
    assert_eq!(normalise_code("U07.1"), None);
    assert_eq!(normalise_code("11.9"), None);
    assert_eq!(normalise_code("E1"), None);
    assert_eq!(normalise_code("E11.99999"), None);
    assert_eq!(normalise_code("not a code"), None);
}

#[tokio::test]
async fn asking_queues_at_once_and_sends_only_the_note() {
    let f = setup().await;
    let id = Uuid::new_v4();
    let (out, sent) = f.ask(&f.owner, id, 2).await;
    let out = out.unwrap();
    assert_eq!(out, json!({"request_id":id,"status":"queued","position":2}));
    let sent = sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    let body = &sent[0];
    assert_eq!(body["purpose"], "extraction");
    assert_eq!(body["request_id"], json!(id));
    assert_eq!(body["json"], true);
    assert_eq!(body["max_tokens"], 900);
    let text = body.to_string();
    assert!(text.contains("Type 2 diabetes mellitus without complications"));
    assert!(text.contains("essential hypertension is controlled"));
    // The assessment and plan are enough, so the history and exam stay home too.
    assert!(!text.contains("Synthetic history text"));
    for private in ["Zelda", "Quillfeather", "SYN-MRN-4417", "1987", "03-09"] {
        assert!(!text.contains(private), "{private} was sent");
    }
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][1]["role"], "user");
    assert_eq!(f.patient.to_string().len(), 36);
    assert!(!text.contains(&f.patient.to_string()));
    assert!(!text.contains(&f.visit.to_string()));
    let (status, position, version): (String, i32, i64) = sqlx::query_as(
        "SELECT status,position,note_version FROM diagnosis_suggestion_requests WHERE id=$1",
    )
    .bind(id)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!((status.as_str(), position, version), ("queued", 2, 1));
    assert_eq!(f.audits("visit.diagnosis_suggestions_requested").await, 1);
    // Nothing reached the chart.
    assert_eq!(
        f.count("SELECT count(*) FROM visit_diagnoses WHERE tenant_id=$1")
            .await,
        0
    );
    let v: i64 = sqlx::query_scalar("SELECT version FROM visits WHERE id=$1")
        .bind(f.visit)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(v, 1);
}

#[tokio::test]
async fn history_and_exam_are_read_only_when_assessment_and_plan_are_empty() {
    let f = setup_with(json!({"subjective":"Cough for three days.","objective":"Throat red.","assessment":"  ","plan":""})).await;
    let (out, sent) = f.ask(&f.owner, Uuid::new_v4(), 0).await;
    out.unwrap();
    let text = sent.lock().unwrap()[0].to_string();
    assert!(text.contains("Cough for three days.") && text.contains("Throat red."));
}
#[tokio::test]
async fn an_empty_note_or_missing_code_list_is_refused_before_anything_is_sent() {
    let f = setup_with(json!({"subjective":"","objective":"","assessment":"","plan":""})).await;
    let (out, sent) = f.ask(&f.owner, Uuid::new_v4(), 0).await;
    assert_eq!(err_text(out), "Write the assessment or plan first.");
    assert!(sent.lock().unwrap().is_empty());
    let g = setup().await;
    sqlx::query(
        "INSERT INTO practice_code_sets(tenant_id,system,enabled,version,updated_by) VALUES($1,'ICD-10-CM',false,1,$1)",
    )
    .bind(g.owner.tenant_id)
    .execute(&g.db)
    .await
    .unwrap();
    let (out, sent) = g.ask(&g.owner, Uuid::new_v4(), 0).await;
    assert_eq!(
        err_text(out),
        "Install the ICD-10 code list in Practice administration first."
    );
    assert!(sent.lock().unwrap().is_empty());
    assert_eq!(
        g.count("SELECT count(*) FROM diagnosis_suggestion_requests WHERE tenant_id=$1")
            .await,
        0
    );
}
#[tokio::test]
async fn asking_again_while_waiting_returns_the_same_request() {
    let f = setup().await;
    let first = Uuid::new_v4();
    f.ask(&f.owner, first, 3).await.0.unwrap();
    let (again, sent) = f.ask(&f.owner, Uuid::new_v4(), 0).await;
    assert_eq!(
        again.unwrap(),
        json!({"request_id":first,"status":"queued","position":3})
    );
    assert!(sent.lock().unwrap().is_empty());
    assert_eq!(
        f.count("SELECT count(*) FROM diagnosis_suggestion_requests WHERE tenant_id=$1")
            .await,
        1
    );
}
#[tokio::test]
async fn a_refused_submit_stores_nothing_and_says_why() {
    let f = setup().await;
    let out = request_for(&f.db, &f.owner, f.visit, Uuid::new_v4(), |_| async {
        Err(Error::Unavailable(
            "Too many requests are waiting. Try again in a few minutes.",
        ))
    })
    .await;
    assert_eq!(
        err_text(out),
        "Too many requests are waiting. Try again in a few minutes."
    );
    let off = request_for(&f.db, &f.owner, f.visit, Uuid::new_v4(), |_| async {
        Err(Error::Conflict(
            "SunCharts AI is not switched on for this practice yet.",
        ))
    })
    .await;
    assert_eq!(
        err_text(off),
        "SunCharts AI is not switched on for this practice yet."
    );
    assert_eq!(
        f.count("SELECT count(*) FROM diagnosis_suggestion_requests WHERE tenant_id=$1")
            .await,
        0
    );
}

#[tokio::test]
async fn reading_while_the_job_waits_keeps_it_waiting_and_shows_the_place() {
    let f = setup().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 3).await.0.unwrap();
    let out = f
        .read_with(
            &f.owner,
            json!({"request_id":id,"status":"queued","position":1}),
        )
        .await
        .unwrap();
    assert_eq!(
        (out["status"].as_str(), out["position"].as_i64()),
        (Some("queued"), Some(1))
    );
    assert!(out["suggestions"].is_null());
    // The step is named while waiting; counts appear only once the codes are being chosen.
    assert_eq!(out["stage"], "extract");
    assert!(out["problems_found"].is_null() && out["services_found"].is_null());
    assert!(out["started_at"].as_str().is_some_and(|t| t.ends_with('Z')));
    let running = f
        .read_with(
            &f.owner,
            json!({"request_id":id,"status":"running","position":null}),
        )
        .await
        .unwrap();
    assert_eq!(running["position"], 0);
    sqlx::query("UPDATE diagnosis_suggestion_requests SET stage='choose',problems='[{\"a\":1},{\"a\":2},{\"a\":3}]'::jsonb,services='[{\"b\":1}]'::jsonb WHERE id=$1")
        .bind(id)
        .execute(&f.db)
        .await
        .unwrap();
    let choosing = f
        .read_with(
            &f.owner,
            json!({"request_id":id,"status":"queued","position":0}),
        )
        .await
        .unwrap();
    assert_eq!(choosing["stage"], "choose");
    assert_eq!(
        (
            choosing["problems_found"].as_i64(),
            choosing["services_found"].as_i64()
        ),
        (Some(3), Some(1))
    );
    // Connect being unreachable leaves what we last knew.
    let unreachable = read(
        &f.db,
        &f.owner,
        f.visit,
        |_| async { Err(Error::Unavailable("x")) },
        |_| async { panic!("nothing to submit") },
    )
    .await
    .unwrap();
    assert_eq!(unreachable["status"], "queued");
    let none = setup().await;
    assert_eq!(
        none.read_with(&none.owner, json!({})).await.unwrap()["status"],
        "none"
    );
}

const MARKER: &str = "ZEBRA-MARKER-8841 appears only in this sentence of the plan.";
const FIRST_ANSWER: &str = "Here you go:\n```json\n{\"problems\":[\
 {\"problem\":\"Cervical dystonia\",\"evidence\":\"Cervical dystonia (spasmodic torticollis)\",\"search_terms\":[\"spasmodic torticollis\",\"cervical dystonia\",\"dystonia\"]},\
 {\"problem\":\"Chronic tension-type headache\",\"evidence\":\"Chronic   tension-type headache\",\"search_terms\":[\"tension-type headache\",\"chronic tension headache\"]},\
 {\"problem\":\"Essential hypertension\",\"evidence\":\"Essential hypertension\",\"search_terms\":[\"hypertension\"]},\
 {\"problem\":\"Type 2 diabetes mellitus\",\"evidence\":\"made up words\",\"search_terms\":[\"type 2 diabetes mellitus\"]},\
 {\"problem\":\"Anxiety about travel\",\"evidence\":\"Anxiety about travel\",\"search_terms\":[\"anxiety\"]}]}\n```";
async fn setup_neuro() -> Fixture {
    setup_with(json!({"subjective":"History text","objective":"Exam text","assessment":"Cervical dystonia (spasmodic torticollis). Chronic tension-type headache. Essential hypertension. Type 2 diabetes mellitus without complications. Anxiety about travel.","plan":format!("Botulinum toxin discussed. {MARKER}")})).await
}
fn choices(items: Value) -> String {
    json!({"choices":items}).to_string()
}
async fn stage(f: &Fixture, id: Uuid) -> (String, Option<Uuid>) {
    sqlx::query_as("SELECT stage,choose_id FROM diagnosis_suggestion_requests WHERE id=$1")
        .bind(id)
        .fetch_one(&f.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn the_assistant_chooses_among_codes_looked_up_in_the_practice_list() {
    let f = setup_neuro().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let answer = choices(json!([
        {"problem":1,"code":"g243"},
        {"problem":2,"code":"G44.229"},
        {"problem":3,"code":"I10"},
        {"problem":4,"code":"E11.9"},
        {"problem":5,"code":null}
    ]));
    let (body, out) = f.two_steps(&f.owner, id, FIRST_ANSWER, &answer).await;
    // The second job carries problems, evidence and candidates, never the note or the patient.
    assert_eq!(body["purpose"], "diagnosis_suggestions");
    assert_eq!(body["json"], true);
    let text = body.to_string();
    assert!(
        text.contains("G24.3") && text.contains("Spasmodic torticollis"),
        "{text}"
    );
    assert!(
        text.contains("G44.229") && text.contains("Chronic tension-type headache, not intractable")
    );
    assert!(text.contains("Cervical dystonia (spasmodic torticollis)"));
    assert!(
        !text.contains("ZEBRA-MARKER-8841"),
        "the note was sent again"
    );
    assert!(!text.contains("Botulinum") && !text.contains("History text"));
    for private in [
        "Zelda",
        "Quillfeather",
        "SYN-MRN-4417",
        "1987",
        "03-09",
        &f.patient.to_string(),
        &f.visit.to_string(),
    ] {
        assert!(!text.contains(private), "{private} was sent");
    }
    // The non-billable parent is never offered; problems with no candidate are not sent.
    let asked = body["messages"][1]["content"].as_str().unwrap();
    assert!(!asked.contains("\"G24\"") && !asked.contains("Anxiety"));
    let list: Value = serde_json::from_str(asked.split_once('\n').unwrap().1).unwrap();
    assert_eq!(list["problems"].as_array().unwrap().len(), 4);
    assert_eq!(list["problems"][0]["problem"], 1);
    assert!(list["problems"][0]["candidates"].as_array().unwrap().len() <= 12);
    // The answer is the catalog's code, with the catalog's wording.
    assert_eq!(out["status"], "ready", "{out}");
    let codes: Vec<&str> = out["suggestions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes, ["G24.3", "G44.229", "I10", "E11.9"]);
    assert_eq!(
        out["suggestions"][0]["description"],
        "Spasmodic torticollis"
    );
    assert_eq!(
        out["suggestions"][0]["evidence"],
        "Cervical dystonia (spasmodic torticollis)"
    );
    assert_eq!(out["suggestions"][0]["evidence_found"], true);
    assert_eq!(
        out["suggestions"][1]["evidence"],
        "Chronic tension-type headache"
    );
    assert_eq!(out["suggestions"][3]["evidence"], Value::Null);
    assert_eq!(out["suggestions"][3]["evidence_found"], false);
    assert!(out["suggestions"][0]["catalog_release_id"].is_string());
    assert_eq!(out["dropped"], 0);
    assert_eq!(
        out["unmatched"],
        json!([{"problem":"Anxiety about travel","evidence":"Anxiety about travel"}])
    );
    assert_eq!(out["model"], "synthetic-model");
    assert_eq!(f.audits("visit.diagnosis_suggestions_ready").await, 1);
    assert_eq!(
        f.count("SELECT count(*) FROM visit_diagnoses WHERE tenant_id=$1")
            .await,
        0
    );
}
#[tokio::test]
async fn a_choice_outside_the_candidates_is_dropped_and_unchosen_problems_are_listed() {
    let f = setup_neuro().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    // Hypertension is already on the encounter.
    sqlx::query(
        "INSERT INTO visit_diagnoses(tenant_id,visit_id,diagnoses,updated_by) VALUES($1,$2,$3,$4)",
    )
    .bind(f.owner.tenant_id)
    .bind(f.visit)
    .bind(json!([{"id":Uuid::new_v4(),"code":"I10","display":"Hypertension","rank":1}]))
    .bind(f.owner.sub)
    .execute(&f.db)
    .await
    .unwrap();
    let answer = choices(json!([
        {"problem":1,"code":"I10"},
        {"problem":2,"code":"G44.229"},
        {"problem":2,"code":"G44.209"},
        {"problem":3,"code":"I10"},
        {"problem":4,"code":null},
        {"problem":9,"code":"E11.9"},
        {"problem":2,"code":"Z99.99"}
    ]));
    let (_, out) = f.two_steps(&f.owner, id, FIRST_ANSWER, &answer).await;
    assert_eq!(out["status"], "ready", "{out}");
    let codes: Vec<&str> = out["suggestions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["code"].as_str().unwrap())
        .collect();
    // I10 for problem 1 is real but not that problem's candidate; the second choice for a problem
    // that already has one is ignored; I10 for hypertension is already on the encounter.
    assert_eq!(codes, ["G44.229"]);
    assert_eq!(out["dropped"], 2, "{out}");
    let unmatched: Vec<&str> = out["unmatched"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["problem"].as_str().unwrap())
        .collect();
    assert_eq!(
        unmatched,
        [
            "Cervical dystonia",
            "Type 2 diabetes mellitus",
            "Anxiety about travel"
        ]
    );
    assert_eq!(out["unmatched"][1]["evidence"], Value::Null);
}
#[tokio::test]
async fn candidates_are_the_best_billable_codes_by_the_search_and_a_second_job_is_skipped_when_there_are_none(
) {
    let f = setup_neuro().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let (out, sent) = f.step(&f.owner, done(id, "{\"problems\":[{\"problem\":\"Anxiety about travel\",\"evidence\":\"Anxiety about travel\",\"search_terms\":[\"anxiety\",\"!!\"]},{\"problem\":\"Dystonia\",\"evidence\":\"Cervical dystonia (spasmodic torticollis)\",\"search_terms\":[]}]}"), Ok(1)).await;
    // The second problem is found by its own name even with no search terms.
    assert_eq!(out.unwrap()["status"], "queued");
    let body = sent.lock().unwrap()[0].clone();
    let asked = body["messages"][1]["content"].as_str().unwrap();
    let list: Value = serde_json::from_str(asked.split_once('\n').unwrap().1).unwrap();
    assert_eq!(list["problems"].as_array().unwrap().len(), 1);
    assert_eq!(list["problems"][0]["problem"], 2);
    let stored: Value =
        sqlx::query_scalar("SELECT problems FROM diagnosis_suggestion_requests WHERE id=$1")
            .bind(id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(stored.as_array().unwrap().len(), 2);
    assert_eq!(stored[0]["candidates"], json!([]));
    let (codes, place): (Vec<String>, i32) = (
        stored[1]["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["code"].as_str().unwrap().to_string())
            .collect(),
        sqlx::query_scalar("SELECT position FROM diagnosis_suggestion_requests WHERE id=$1")
            .bind(id)
            .fetch_one(&f.db)
            .await
            .unwrap(),
    );
    assert_eq!(codes, ["G24.1"]);
    assert_eq!(place, 1);
    // No problem has a candidate: no second job, the problems are all listed as unmatched.
    let g = setup_neuro().await;
    let id = Uuid::new_v4();
    g.ask(&g.owner, id, 0).await.0.unwrap();
    let (out, sent) = g.step(&g.owner, done(id, "{\"problems\":[{\"problem\":\"Anxiety about travel\",\"evidence\":\"Anxiety about travel\",\"search_terms\":[\"anxiety\"]}]}"), Ok(0)).await;
    let out = out.unwrap();
    assert!(sent.lock().unwrap().is_empty());
    assert_eq!(
        (out["status"].as_str(), out["suggestions"].clone()),
        (Some("ready"), json!([]))
    );
    assert_eq!(
        out["unmatched"],
        json!([{"problem":"Anxiety about travel","evidence":"Anxiety about travel"}])
    );
    // No problems: ready and empty.
    let h = setup_neuro().await;
    let id = Uuid::new_v4();
    h.ask(&h.owner, id, 0).await.0.unwrap();
    let (out, sent) = h.step(&h.owner, done(id, "{\"problems\":[]}"), Ok(0)).await;
    let out = out.unwrap();
    assert!(sent.lock().unwrap().is_empty());
    assert_eq!(
        (
            out["status"].as_str(),
            out["suggestions"].clone(),
            out["unmatched"].clone()
        ),
        (Some("ready"), json!([]), json!([]))
    );
}
#[tokio::test]
async fn no_more_than_eight_codes_are_kept() {
    let f = setup().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let problems: Vec<Value> = (0..12)
        .map(|i| json!({"problem":format!("Listed problem {i}"),"evidence":"metformin","search_terms":["synthetic listed code"]}))
        .collect();
    let picks: Vec<Value> = (0..10)
        .map(|i| json!({"problem":i + 1,"code":format!("Q10.{i}")}))
        .collect();
    let (_, out) = f
        .two_steps(
            &f.owner,
            id,
            &json!({"problems":problems}).to_string(),
            &choices(json!(picks)),
        )
        .await;
    assert_eq!(out["suggestions"].as_array().unwrap().len(), 8);
    assert_eq!(out["suggestions"][0]["code"], "Q10.0");
}
#[tokio::test]
async fn an_unreadable_answer_fails_the_request() {
    for content in [
        "I could not decide.",
        "{\"other\":1}",
        "{\"problems\":\"none\"}",
        "{\"suggestions\":[]}",
        "{bad json}",
    ] {
        let f = setup().await;
        let id = Uuid::new_v4();
        f.ask(&f.owner, id, 0).await.0.unwrap();
        let out = f.read_with(&f.owner, done(id, content)).await.unwrap();
        assert_eq!(
            (out["status"].as_str(), out["error"].as_str()),
            (Some("failed"), Some("unreadable")),
            "{content}"
        );
        assert!(out["suggestions"].is_null());
    }
    for content in [
        "Cannot say.",
        "{\"choices\":\"none\"}",
        "{\"suggestions\":[]}",
        "{bad}",
    ] {
        let f = setup_neuro().await;
        let id = Uuid::new_v4();
        f.ask(&f.owner, id, 0).await.0.unwrap();
        let (out, _) = f.step(&f.owner, done(id, FIRST_ANSWER), Ok(0)).await;
        assert_eq!(out.unwrap()["status"], "queued");
        let out = f
            .read_with(&f.owner, done(choose_job_id(id), content))
            .await
            .unwrap();
        assert_eq!(
            (out["status"].as_str(), out["error"].as_str()),
            (Some("failed"), Some("unreadable")),
            "{content}"
        );
    }
    let none = setup().await;
    let id = Uuid::new_v4();
    none.ask(&none.owner, id, 0).await.0.unwrap();
    let mut job = done(id, "");
    job["content"] = Value::Null;
    assert_eq!(
        none.read_with(&none.owner, job).await.unwrap()["error"],
        "unreadable"
    );
}
#[tokio::test]
async fn a_failure_in_either_step_fails_the_request() {
    let f = setup_neuro().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let (out, _) = f.step(&f.owner, done(id, FIRST_ANSWER), Ok(0)).await;
    assert_eq!(out.unwrap()["status"], "queued");
    let second = choose_job_id(id);
    // A late word about the first job changes nothing now that the second is the one waited on.
    let late = f
        .read_with(
            &f.owner,
            json!({"request_id":second,"status":"queued","position":4}),
        )
        .await
        .unwrap();
    assert_eq!(
        (late["status"].as_str(), late["position"].as_i64()),
        (Some("queued"), Some(4))
    );
    let out = f
        .read_with(
            &f.owner,
            json!({"request_id":second,"status":"failed","error":"timeout"}),
        )
        .await
        .unwrap();
    assert_eq!(
        (out["status"].as_str(), out["error"].as_str()),
        (Some("failed"), Some("timeout"))
    );
    assert_eq!(f.audits("visit.diagnosis_suggestions_failed").await, 1);
    // A refused second job fails the request; an unreachable assistant leaves it waiting.
    let g = setup_neuro().await;
    let id = Uuid::new_v4();
    g.ask(&g.owner, id, 0).await.0.unwrap();
    let (out, _) = g
        .step(
            &g.owner,
            done(id, FIRST_ANSWER),
            Err(Error::Unavailable("busy")),
        )
        .await;
    assert_eq!(out.unwrap()["status"], "queued");
    assert_eq!(stage(&g, id).await.0, "extract");
    let (out, _) = g
        .step(
            &g.owner,
            done(id, FIRST_ANSWER),
            Err(Error::Conflict("off")),
        )
        .await;
    let out = out.unwrap();
    assert_eq!(
        (out["status"].as_str(), out["error"].as_str()),
        (Some("failed"), Some("upstream_error"))
    );
}
#[tokio::test]
async fn reading_moves_the_request_on_when_the_events_were_missed_and_a_retry_reuses_the_second_job(
) {
    let f = setup_neuro().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    // The assistant could not be reached for the second job: the request keeps waiting on the first.
    let (out, first_try) = f
        .step(
            &f.owner,
            done(id, FIRST_ANSWER),
            Err(Error::Unavailable("busy")),
        )
        .await;
    assert_eq!(out.unwrap()["status"], "queued");
    assert_eq!(stage(&f, id).await, ("extract".to_string(), None));
    let (out, second_try) = f.step(&f.owner, done(id, FIRST_ANSWER), Ok(5)).await;
    let out = out.unwrap();
    assert_eq!(
        (
            out["status"].as_str(),
            out["position"].as_i64(),
            out["request_id"].clone()
        ),
        (Some("queued"), Some(5), json!(id))
    );
    let (a, b) = (
        first_try.lock().unwrap()[0].clone(),
        second_try.lock().unwrap()[0].clone(),
    );
    assert_eq!(a["request_id"], b["request_id"]);
    assert_eq!(b["request_id"], json!(choose_job_id(id)));
    assert_ne!(b["request_id"], json!(id));
    assert_eq!(
        stage(&f, id).await,
        ("choose".to_string(), Some(choose_job_id(id)))
    );
    // While it waits on the second job the encounter still has exactly one request.
    let (again, sent) = f.ask(&f.owner, Uuid::new_v4(), 0).await;
    assert_eq!(
        again.unwrap(),
        json!({"request_id":id,"status":"queued","position":5})
    );
    assert!(sent.lock().unwrap().is_empty());
    assert_eq!(
        f.count("SELECT count(*) FROM diagnosis_suggestion_requests WHERE tenant_id=$1")
            .await,
        1
    );
    // A repeat word about the finished first job is ignored.
    job_finished_with(
        &f.db,
        f.owner.tenant_id,
        id,
        |_| async move { panic!("asked again") },
        |_| async move { panic!("sent again") },
    )
    .await
    .unwrap();
    let out = f
        .read_with(
            &f.owner,
            done(
                choose_job_id(id),
                &choices(json!([{"problem":1,"code":"G24.3"}])),
            ),
        )
        .await
        .unwrap();
    assert_eq!(out["status"], "ready");
    assert_eq!(out["suggestions"][0]["code"], "G24.3");
    assert_eq!(
        out["suggestions"][0]["description"],
        "Spasmodic torticollis"
    );
}
#[tokio::test]
async fn failed_and_expired_jobs_fail_the_request_and_free_the_encounter() {
    let f = setup().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let out = f
        .read_with(
            &f.owner,
            json!({"request_id":id,"status":"failed","error":"timeout"}),
        )
        .await
        .unwrap();
    assert_eq!(
        (out["status"].as_str(), out["error"].as_str()),
        (Some("failed"), Some("timeout"))
    );
    assert_eq!(f.audits("visit.diagnosis_suggestions_failed").await, 1);
    let next = Uuid::new_v4();
    f.ask(&f.owner, next, 0).await.0.unwrap();
    let out = f
        .read_with(&f.owner, json!({"request_id":next,"status":"expired"}))
        .await
        .unwrap();
    assert_eq!(
        (out["status"].as_str(), out["error"].as_str()),
        (Some("failed"), Some("expired"))
    );
    let third = Uuid::new_v4();
    f.ask(&f.owner, third, 0).await.0.unwrap();
    let out = f
        .read_with(
            &f.owner,
            json!({"request_id":third,"status":"failed","error":"upstream_error"}),
        )
        .await
        .unwrap();
    assert_eq!(out["error"], "upstream_error");
}
#[tokio::test]
async fn the_finished_events_move_the_request_on_and_tell_browsers_without_codes() {
    let f = setup_neuro().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let sent: Sent = Arc::default();
    let log = sent.clone();
    job_finished_with(
        &f.db,
        f.owner.tenant_id,
        id,
        |_| async move { Ok(done(id, FIRST_ANSWER)) },
        move |body| async move {
            log.lock().unwrap().push(body);
            Ok(json!({"status":"queued","position":2}))
        },
    )
    .await
    .unwrap();
    // The first job finishing is not the end: the request waits on the second and nobody is told yet.
    assert_eq!(sent.lock().unwrap().len(), 1);
    let (status, position): (String, i32) =
        sqlx::query_as("SELECT status,position FROM diagnosis_suggestion_requests WHERE id=$1")
            .bind(id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!((status.as_str(), position), ("queued", 2));
    assert_eq!(f.audits("visit.diagnosis_suggestions_ready").await, 0);
    // A word about a job that is not the one being waited on is ignored.
    job_finished_with(
        &f.db,
        f.owner.tenant_id,
        id,
        |_| async move { panic!("asked again") },
        |_| async move { panic!("sent again") },
    )
    .await
    .unwrap();
    let second = choose_job_id(id);
    let content = choices(json!([{"problem":1,"code":"G24.3"}]));
    job_finished_with(
        &f.db,
        f.owner.tenant_id,
        second,
        |asked| async move {
            assert_eq!(asked, second);
            Ok(done(second, &content))
        },
        |_| async move { panic!("sent again") },
    )
    .await
    .unwrap();
    let (status, result): (String, Value) =
        sqlx::query_as("SELECT status,result FROM diagnosis_suggestion_requests WHERE id=$1")
            .bind(id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(status, "ready");
    assert_eq!(result["suggestions"][0]["code"], "G24.3");
    // The notice is an audit row on the encounter: it reaches the tenant's change feed as a
    // clinical change and has no field that could hold a code or a word of the note.
    let (action, resource): (String, Uuid) = sqlx::query_as("SELECT action,resource_id FROM audit_events WHERE tenant_id=$1 AND action LIKE 'visit.diagnosis_suggestions_%' AND action<>'visit.diagnosis_suggestions_requested'").bind(f.owner.tenant_id).fetch_one(&f.db).await.unwrap();
    assert_eq!(
        (action.as_str(), resource),
        ("visit.diagnosis_suggestions_ready", f.visit)
    );
    // A second notice for the same job changes and announces nothing.
    job_finished_with(
        &f.db,
        f.owner.tenant_id,
        second,
        |_| async move { panic!("asked again") },
        |_| async move { panic!("sent again") },
    )
    .await
    .unwrap();
    assert_eq!(f.audits("visit.diagnosis_suggestions_ready").await, 1);
    // An unknown job is ignored.
    job_finished_with(
        &f.db,
        f.owner.tenant_id,
        Uuid::new_v4(),
        |_| async move { panic!("unknown") },
        |_| async move { panic!("unknown") },
    )
    .await
    .unwrap();
}
#[tokio::test]
async fn dismissing_clears_it_and_a_late_answer_does_not_bring_it_back() {
    let f = setup().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    assert_eq!(
        dismiss(&f.db, &f.owner, f.visit).await.unwrap()["status"],
        "dismissed"
    );
    job_finished_with(
        &f.db,
        f.owner.tenant_id,
        id,
        |_| async move { panic!("dismissed") },
        |_| async move { panic!("dismissed") },
    )
    .await
    .unwrap();
    assert_eq!(
        f.read_with(&f.owner, json!({})).await.unwrap()["status"],
        "none"
    );
    assert_eq!(f.audits("visit.diagnosis_suggestions_ready").await, 0);
    // A new request can be made, since the encounter has none waiting.
    f.ask(&f.owner, Uuid::new_v4(), 0).await.0.unwrap();
}
#[tokio::test]
async fn old_and_dismissed_requests_are_swept() {
    let f = setup().await;
    let (old, dismissed, fresh) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    for (id, status, age) in [
        (old, "failed", "25 hours"),
        (dismissed, "dismissed", "1 minute"),
        (fresh, "failed", "23 hours"),
    ] {
        sqlx::query(&format!("INSERT INTO diagnosis_suggestion_requests(tenant_id,id,visit_id,requested_by,note_version,status,created_at) VALUES($1,$2,$3,$4,1,$5,now()-interval '{age}')")).bind(f.owner.tenant_id).bind(id).bind(f.visit).bind(f.owner.sub).bind(status).execute(&f.db).await.unwrap();
    }
    assert_eq!(sweep(&f.db, None).await.unwrap(), 2);
    let left: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM diagnosis_suggestion_requests")
        .fetch_all(&f.db)
        .await
        .unwrap();
    assert_eq!(left, vec![fresh]);
    // Reading removes an expired one for that practice too.
    sqlx::query("UPDATE diagnosis_suggestion_requests SET created_at=now()-interval '30 hours'")
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        f.read_with(&f.owner, json!({})).await.unwrap()["status"],
        "none"
    );
    assert_eq!(
        f.count("SELECT count(*) FROM diagnosis_suggestion_requests WHERE tenant_id=$1")
            .await,
        0
    );
}
#[tokio::test]
async fn a_changed_note_is_reported() {
    let f = setup().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    sqlx::query("UPDATE visits SET version=version+1 WHERE id=$1")
        .bind(f.visit)
        .execute(&f.db)
        .await
        .unwrap();
    let out = f
        .read_with(
            &f.owner,
            json!({"request_id":id,"status":"queued","position":0}),
        )
        .await
        .unwrap();
    assert_eq!(out["note_changed"], true);
    assert_eq!(out["note_version"], 1);
}
#[tokio::test]
async fn only_clinicians_and_owners_of_this_practice_may_use_it() {
    let f = setup().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    for role in [Role::Nurse, Role::MedicalAssistant, Role::FrontDesk] {
        let other = actor(f.owner.tenant_id, role);
        user(&f.db, &other, "nurse").await;
        assert_eq!(
            err_text(f.ask(&other, Uuid::new_v4(), 0).await.0),
            "forbidden"
        );
        assert_eq!(err_text(f.read_with(&other, json!({})).await), "forbidden");
        assert_eq!(err_text(dismiss(&f.db, &other, f.visit).await), "forbidden");
    }
    let clinician = actor(f.owner.tenant_id, Role::Clinician);
    user(&f.db, &clinician, "clinician").await;
    assert_eq!(
        f.read_with(
            &clinician,
            json!({"request_id":id,"status":"queued","position":0})
        )
        .await
        .unwrap()["mine"],
        false
    );
    // Another practice's clinician cannot see that this encounter exists.
    let stranger = actor(Uuid::new_v4(), Role::Clinician);
    user(&f.db, &stranger, "clinician").await;
    assert_eq!(
        err_text(f.ask(&stranger, Uuid::new_v4(), 0).await.0),
        "not found"
    );
    assert_eq!(
        err_text(f.read_with(&stranger, json!({})).await),
        "not found"
    );
    assert_eq!(
        err_text(dismiss(&f.db, &stranger, f.visit).await),
        "not found"
    );
}
#[tokio::test]
async fn the_routes_refuse_a_front_desk_account() {
    let f = setup().await;
    let desk = actor(f.owner.tenant_id, Role::FrontDesk);
    user(&f.db, &desk, "front_desk").await;
    let app = crate::app(State {
        backend: Arc::new(PostgresBackend(f.db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(f.db.clone(), "http://127.0.0.1:8099".into()).unwrap()),
    });
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &desk,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    for (method, path) in [
        (
            "POST",
            format!("/api/v1/visits/{}/diagnosis-suggestions", f.visit),
        ),
        (
            "GET",
            format!("/api/v1/visits/{}/diagnosis-suggestions", f.visit),
        ),
        (
            "POST",
            format!("/api/v1/visits/{}/diagnosis-suggestions/dismiss", f.visit),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(json!({"request_id":Uuid::new_v4()}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let _ = response.into_body().collect().await;
    }
    // Staff may ask whether the assistant is available; a practice with no connection is "not yet".
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &f.owner,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/ai/local-status")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body, json!({"available":false,"model":null}));
}
#[tokio::test]
async fn the_migration_applies_over_an_existing_database_and_connect_may_announce_jobs() {
    let db = pool_at(Some(122)).await;
    let tenant = Uuid::new_v4();
    let (setting, installation) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO connect_remote_events(tenant_id,installation_id,cloud_id,kind,resource_id,created_at) VALUES($1,$2,1,'reminder.delivery',$3,now())").bind(tenant).bind(installation).bind(Uuid::new_v4()).execute(&db).await.unwrap();
    assert!(sqlx::query("INSERT INTO connect_remote_events(tenant_id,installation_id,cloud_id,kind,resource_id,created_at) VALUES($1,$2,2,'ai.job',$3,now())").bind(tenant).bind(installation).bind(Uuid::new_v4()).execute(&db).await.is_err());
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(e) FROM connect_remote_events e WHERE cloud_id=1")
            .fetch_one(&db)
            .await
            .unwrap();
    crate::MIGRATOR.run(&db).await.unwrap();
    crate::MIGRATOR.run(&db).await.unwrap();
    let after: Value =
        sqlx::query_scalar("SELECT to_jsonb(e) FROM connect_remote_events e WHERE cloud_id=1")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(before, after);
    sqlx::query("INSERT INTO connect_remote_events(tenant_id,installation_id,cloud_id,kind,resource_id,created_at) VALUES($1,$2,2,'ai.job',$3,now())").bind(tenant).bind(installation).bind(Uuid::new_v4()).execute(&db).await.unwrap();
    assert!(sqlx::query("INSERT INTO connect_remote_events(tenant_id,installation_id,cloud_id,kind,resource_id,created_at) VALUES($1,$2,3,'other.kind',$3,now())").bind(tenant).bind(installation).bind(Uuid::new_v4()).execute(&db).await.is_err());
    let _ = setting;
}

#[tokio::test]
async fn the_stage_migration_applies_over_an_existing_database_with_a_waiting_request() {
    let db = pool_at(Some(123)).await;
    let tenant = Uuid::new_v4();
    let (patient, appointment, visit, request, clinician) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-MRN-1','Synthetic','Person','1990-01-01')").bind(tenant).bind(patient).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')").bind(tenant).bind(appointment).bind(patient).bind(clinician).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,note) VALUES($1,$2,$3,$4,$5,'{}')").bind(tenant).bind(visit).bind(patient).bind(appointment).bind(clinician).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO diagnosis_suggestion_requests(tenant_id,id,visit_id,requested_by,note_version,status,position) VALUES($1,$2,$3,$4,1,'queued',2)").bind(tenant).bind(request).bind(visit).bind(clinician).execute(&db).await.unwrap();
    crate::MIGRATOR.run(&db).await.unwrap();
    crate::MIGRATOR.run(&db).await.unwrap();
    let (stage, problems, choose, status, position): (String, Option<Value>, Option<Uuid>, String, Option<i32>) = sqlx::query_as("SELECT stage,problems,choose_id,status,position FROM diagnosis_suggestion_requests WHERE id=$1").bind(request).fetch_one(&db).await.unwrap();
    assert_eq!(
        (stage.as_str(), problems, choose, status.as_str(), position),
        ("extract", None, None, "queued", Some(2))
    );
    assert!(
        sqlx::query("UPDATE diagnosis_suggestion_requests SET stage='other' WHERE id=$1")
            .bind(request)
            .execute(&db)
            .await
            .is_err()
    );
    assert_eq!(
        sqlx::query("UPDATE diagnosis_suggestion_requests SET stage='choose',problems='[]',choose_id=$2 WHERE id=$1").bind(request).bind(Uuid::new_v4()).execute(&db).await.unwrap().rows_affected(),
        1
    );
}

// ---- Procedure suggestions: the same request also reads the services done at the encounter.

const SERVICES_FIRST: &str = "{\"problems\":[\
 {\"problem\":\"Cervical dystonia\",\"evidence\":\"Cervical dystonia (spasmodic torticollis)\",\"search_terms\":[\"spasmodic torticollis\"]}],\
 \"services\":[\
 {\"service\":\"Neck injection\",\"evidence\":\"Synthetic neck injection to the left splenius\",\"search_terms\":[\"neck injection\"],\"quantity\":null,\"quantity_unit\":null},\
 {\"service\":\"OnabotulinumtoxinA\",\"evidence\":\"OnabotulinumtoxinA 155 units given\",\"search_terms\":[\"onabotulinumtoxinA\"],\"quantity\":155,\"quantity_unit\":\"units\"},\
 {\"service\":\"Office visit\",\"evidence\":\"Office visit today\",\"search_terms\":[\"office visit\"],\"quantity\":null,\"quantity_unit\":null}]}";

/// A practice with its own billing list (made-up wording for CPT-shaped codes), an installed
/// HCPCS list and no CPT list, and an encounter whose procedure section names three services.
async fn setup_services() -> Fixture {
    let f = setup_with(json!({"subjective":"History text","objective":"Exam text","assessment":"Cervical dystonia (spasmodic torticollis).","plan":format!("Return in twelve weeks. {MARKER}"),"procedure":"Synthetic neck injection to the left splenius. OnabotulinumtoxinA 155 units given. Office visit today."})).await;
    let tenant = f.owner.tenant_id;
    for (system, code, display, price) in [
        ("CPT", "64616", "Synthetic neck injection", 15000),
        (
            "CPT",
            "99213",
            "Synthetic office visit, established, level three",
            9000,
        ),
        (
            "CPT",
            "99214",
            "Synthetic office visit, established, level four",
            13000,
        ),
        (
            "HCPCS",
            "J0585",
            "Injection, onabotulinumtoxinA, 1 unit",
            10,
        ),
    ] {
        sqlx::query("INSERT INTO practice_codes(tenant_id,id,system,code,display,enabled,price_cents,default_units,modifiers,version,created_by,updated_by) VALUES($1,$2,$3,$4,$5,true,$6,1,'',1,$7,$7)")
            .bind(tenant).bind(Uuid::new_v4()).bind(system).bind(code).bind(display).bind(price).bind(f.owner.sub).execute(&f.db).await.unwrap();
    }
    let release = Uuid::new_v4();
    sqlx::query("INSERT INTO terminology_releases(tenant_id,id,system,edition,source_name,source_url,source_sha256,effective_start,rights,rights_attested,request_id,request_digest,code_count,created_by,reason) VALUES($1,$2,'HCPCS','synthetic','Synthetic list','https://example.test/hcpcs',$3,'2020-01-01','public_use',true,$4,$5,2,$6,'Synthetic')").bind(tenant).bind(release).bind("c".repeat(64)).bind(Uuid::new_v4()).bind("d".repeat(64)).bind(f.owner.sub).execute(&f.db).await.unwrap();
    for (code, display) in [
        ("J0585", "Injection, onabotulinumtoxinA, 1 unit"),
        ("Q9999", "Synthetic onabotulinumtoxinA lookalike"),
    ] {
        sqlx::query("INSERT INTO terminology_codes(tenant_id,release_id,code,code_key,display,billable,active,effective_start) VALUES($1,$2,$3,$3,$4,true,true,'2020-01-01')").bind(tenant).bind(release).bind(code).bind(display).execute(&f.db).await.unwrap();
    }
    f
}
fn service_answer(items: Value) -> String {
    json!({"choices":[{"problem":1,"code":"G24.3"}],"service_choices":items}).to_string()
}
async fn stored_services(f: &Fixture, id: Uuid) -> Vec<Value> {
    let stored: Value =
        sqlx::query_scalar("SELECT services FROM diagnosis_suggestion_requests WHERE id=$1")
            .bind(id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    stored.as_array().unwrap().clone()
}

#[tokio::test]
async fn the_first_step_reads_services_from_the_procedure_and_exam_sections_too() {
    let f = setup_services().await;
    let (out, sent) = f.ask(&f.owner, Uuid::new_v4(), 0).await;
    out.unwrap();
    let body = sent.lock().unwrap()[0].clone();
    let system = body["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains("\"services\"") && system.contains("PERFORMED"));
    assert!(system.contains("quantity_unit") && system.contains("Do not give any codes"));
    let text = body["messages"][1]["content"].as_str().unwrap();
    assert!(text.contains("Synthetic neck injection") && text.contains("Exam text"));
    assert!(!text.contains("History text"));
    for private in ["Zelda", "Quillfeather", "SYN-MRN-4417", "1987"] {
        assert!(!text.contains(private), "{private} was sent");
    }
}

#[tokio::test]
async fn services_are_looked_up_in_the_practice_list_first_and_chosen_alongside_the_diagnoses() {
    let f = setup_services().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let answer = service_answer(json!([
        {"service":1,"code":"64616"},
        {"service":2,"code":"j0585"},
        {"service":3,"code":"99214"}
    ]));
    let (body, out) = f.two_steps(&f.owner, id, SERVICES_FIRST, &answer).await;

    // Candidates are what this practice can bill: its own list first, then the HCPCS list.
    let services = stored_services(&f, id).await;
    assert_eq!(services.len(), 3);
    let codes = |i: usize| -> Vec<(String, String)> {
        services[i]["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c["code"].as_str().unwrap().to_string(),
                    c["source"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    };
    assert_eq!(codes(0), [("64616".into(), "practice".into())]);
    assert_eq!(
        codes(1),
        [
            ("J0585".into(), "practice".into()),
            ("Q9999".into(), "catalog".into())
        ]
    );
    assert_eq!(services[1]["candidates"][0]["system"], "HCPCS");
    assert_eq!(services[1]["quantity"], 155.0);
    assert_eq!(services[1]["quantity_unit"], "units");
    // A code taken from an installed list says which list; the practice's own row does not.
    assert_eq!(services[1]["candidates"][0]["release_id"], Value::Null);
    assert!(services[1]["candidates"][1]["release_id"].is_string());
    // Several levels of one visit: flagged from the candidates themselves.
    assert_eq!(codes(2).len(), 2);
    assert_eq!(services[2]["level"], true);

    // The second job carries services with their candidates and evidence, not the note or the patient.
    let text = body.to_string();
    assert!(text.contains("Synthetic neck injection") && text.contains("J0585"));
    assert!(text.contains("Synthetic neck injection to the left splenius"));
    assert!(!text.contains("ZEBRA-MARKER-8841") && !text.contains("Return in twelve weeks"));
    assert!(!text.contains("History text") && !text.contains("Exam text"));
    for private in [
        "Zelda",
        "Quillfeather",
        "SYN-MRN-4417",
        "1987",
        "03-09",
        &f.patient.to_string(),
        &f.visit.to_string(),
    ] {
        assert!(!text.contains(private), "{private} was sent");
    }
    let asked = body["messages"][1]["content"].as_str().unwrap();
    let list: Value = serde_json::from_str(asked.split_once('\n').unwrap().1).unwrap();
    assert_eq!(list["problems"].as_array().unwrap().len(), 1);
    // The visit comes in levels, so it is not put to the assistant at all.
    let numbers: Vec<i64> = list["services"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["service"].as_i64().unwrap())
        .collect();
    assert_eq!(numbers, [1, 2]);
    assert!(!asked.contains("99213") && !asked.contains("Synthetic office visit"));

    // The answer: diagnoses as before, the injection and the drug, and the visit left to the clinician.
    assert_eq!(out["status"], "ready", "{out}");
    assert_eq!(out["suggestions"][0]["code"], "G24.3");
    let procedures = out["procedures"].as_array().unwrap();
    assert_eq!(procedures.len(), 2, "{out}");
    assert_eq!(procedures[0]["code"], "64616");
    assert_eq!(procedures[0]["description"], "Synthetic neck injection");
    assert_eq!(procedures[0]["source"], "practice");
    assert_eq!(
        procedures[0]["evidence"],
        "Synthetic neck injection to the left splenius"
    );
    assert_eq!(procedures[0]["evidence_found"], true);
    assert_eq!(procedures[0]["quantity"], Value::Null);
    assert_eq!(procedures[1]["code"], "J0585");
    assert_eq!(procedures[1]["system"], "HCPCS");
    assert_eq!(procedures[1]["default_units"], 1);
    assert_eq!(procedures[0]["catalog_release_id"], Value::Null);
    assert_eq!(procedures[1]["quantity"], 155.0);
    assert_eq!(procedures[1]["quantity_unit"], "units");
    assert_eq!(
        out["procedures_unmatched"],
        json!([{"service":"Office visit","evidence":"Office visit today","reason":"level"}])
    );
    assert_eq!(out["dropped"], 0);
    // Reading it again from the stored request gives the same lists, and nothing reached the chart.
    let again = f.read_with(&f.owner, done(id, "{}")).await.unwrap();
    assert_eq!(again["procedures"], out["procedures"]);
    assert_eq!(again["procedures_unmatched"], out["procedures_unmatched"]);
    assert_eq!(
        f.count("SELECT count(*) FROM visit_diagnoses WHERE tenant_id=$1")
            .await,
        0
    );
    assert_eq!(
        f.count("SELECT count(*) FROM billing_accounts WHERE tenant_id=$1")
            .await,
        0
    );
    assert_eq!(f.audits("visit.diagnosis_suggestions_ready").await, 1);
}

#[tokio::test]
async fn a_service_choice_outside_the_candidates_or_a_visit_level_is_dropped() {
    let f = setup_services().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let answer = service_answer(json!([
        {"service":1,"code":"64999"},
        {"service":2,"code":null},
        {"service":3,"code":"99213"},
        {"service":9,"code":"64616"}
    ]));
    let (_, out) = f.two_steps(&f.owner, id, SERVICES_FIRST, &answer).await;
    assert_eq!(out["status"], "ready", "{out}");
    assert_eq!(out["procedures"], json!([]));
    assert_eq!(out["dropped"], 2, "{out}");
    let reasons: Vec<(&str, &str)> = out["procedures_unmatched"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| {
            (
                u["service"].as_str().unwrap(),
                u["reason"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        reasons,
        [
            ("Neck injection", "none"),
            ("OnabotulinumtoxinA", "none"),
            ("Office visit", "level")
        ]
    );
}

#[tokio::test]
async fn a_visit_level_chosen_for_a_single_candidate_is_still_left_to_the_clinician() {
    let f = setup_services().await;
    sqlx::query("UPDATE practice_codes SET enabled=false WHERE tenant_id=$1 AND code='99213'")
        .bind(f.owner.tenant_id)
        .execute(&f.db)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let answer = service_answer(json!([{"service":3,"code":"99214"}]));
    let (_, out) = f.two_steps(&f.owner, id, SERVICES_FIRST, &answer).await;
    assert_eq!(out["procedures"], json!([]), "{out}");
    assert_eq!(out["procedures_unmatched"][2]["reason"], "level");
}

#[tokio::test]
async fn codes_already_on_the_charge_lines_are_not_offered_again() {
    let f = setup_services().await;
    sqlx::query("INSERT INTO billing_accounts(tenant_id,id,patient_id,visit_id,content,total_cents,request_id,creation_hash) VALUES($1,$2,$3,$4,$5,15000,$6,'synthetic')")
        .bind(f.owner.tenant_id).bind(Uuid::new_v4()).bind(f.patient).bind(f.visit)
        .bind(json!({"visit_id":f.visit,"lines":[{"code":"64616","code_system":"CPT","description":"Synthetic neck injection"}]}))
        .bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let answer = service_answer(json!([{"service":1,"code":"64616"},{"service":2,"code":"J0585"}]));
    let (_, out) = f.two_steps(&f.owner, id, SERVICES_FIRST, &answer).await;
    let codes: Vec<&str> = out["procedures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes, ["J0585"], "{out}");
    // Already charged is covered, not "no code found".
    let left: Vec<&str> = out["procedures_unmatched"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["service"].as_str().unwrap())
        .collect();
    assert_eq!(left, ["Office visit"]);
}

#[tokio::test]
async fn services_alone_still_reach_the_assistant_and_a_service_without_candidates_is_listed() {
    let f = setup_services().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let first = "{\"problems\":[],\"services\":[{\"service\":\"Neck injection\",\"evidence\":\"Synthetic neck injection to the left splenius\",\"search_terms\":[\"neck injection\"]},{\"service\":\"Unlisted wizardry\",\"evidence\":\"made up\",\"search_terms\":[\"wizardry\"]}]}";
    let answer = json!({"service_choices":[{"service":1,"code":"64616"}]}).to_string();
    let (body, out) = f.two_steps(&f.owner, id, first, &answer).await;
    let asked = body["messages"][1]["content"].as_str().unwrap();
    let list: Value = serde_json::from_str(asked.split_once('\n').unwrap().1).unwrap();
    assert!(list.get("problems").is_none());
    assert_eq!(list["services"].as_array().unwrap().len(), 1);
    assert_eq!(out["suggestions"], json!([]));
    assert_eq!(out["procedures"][0]["code"], "64616");
    assert_eq!(
        out["procedures_unmatched"],
        json!([{"service":"Unlisted wizardry","evidence":null,"reason":"none"}])
    );
    // Nothing to choose from at all: no second job, the services are listed as unmatched.
    let g = setup_services().await;
    let id = Uuid::new_v4();
    g.ask(&g.owner, id, 0).await.0.unwrap();
    let only = "{\"problems\":[],\"services\":[{\"service\":\"Unlisted wizardry\",\"evidence\":\"made up\",\"search_terms\":[\"wizardry\"]}]}";
    let (out, sent) = g.step(&g.owner, done(id, only), Ok(0)).await;
    let out = out.unwrap();
    assert!(sent.lock().unwrap().is_empty());
    assert_eq!(out["status"], "ready");
    assert_eq!(out["procedures_unmatched"][0]["reason"], "none");
}

#[tokio::test]
async fn a_practice_with_a_licensed_cpt_list_finds_its_codes_after_its_own() {
    let f = setup_services().await;
    let tenant = f.owner.tenant_id;
    let release = Uuid::new_v4();
    sqlx::query("INSERT INTO terminology_releases(tenant_id,id,system,edition,source_name,source_url,source_sha256,effective_start,rights,rights_attested,request_id,request_digest,code_count,created_by,reason,license_reference,license_valid_until) VALUES($1,$2,'CPT','synthetic','Synthetic licensed list','https://example.test/cpt',$3,'2020-01-01','licensed',true,$4,$5,1,$6,'Synthetic','Synthetic license','2099-01-01')").bind(tenant).bind(release).bind("e".repeat(64)).bind(Uuid::new_v4()).bind("f".repeat(64)).bind(f.owner.sub).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO terminology_codes(tenant_id,release_id,code,code_key,display,billable,active,effective_start) VALUES($1,$2,'64617','64617','Synthetic neck injection, second kind',true,true,'2020-01-01')").bind(tenant).bind(release).execute(&f.db).await.unwrap();
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    f.step(&f.owner, done(id, SERVICES_FIRST), Ok(1))
        .await
        .0
        .unwrap();
    let services = stored_services(&f, id).await;
    let found: Vec<(&str, &str)> = services[0]["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["code"].as_str().unwrap(), c["source"].as_str().unwrap()))
        .collect();
    assert_eq!(found, [("64616", "practice"), ("64617", "catalog")]);
    // A lapsed license hides the list, as it does in the procedure box.
    let h = setup_services().await;
    sqlx::query("INSERT INTO terminology_releases(tenant_id,id,system,edition,source_name,source_url,source_sha256,effective_start,rights,rights_attested,request_id,request_digest,code_count,created_by,reason,license_reference,license_valid_until) VALUES($1,$2,'CPT','synthetic','Synthetic licensed list','https://example.test/cpt',$3,'2020-01-01','licensed',true,$4,$5,1,$6,'Synthetic','Synthetic license','2020-02-01')").bind(h.owner.tenant_id).bind(release).bind("e".repeat(64)).bind(Uuid::new_v4()).bind("f".repeat(64)).bind(h.owner.sub).execute(&h.db).await.unwrap();
    sqlx::query("INSERT INTO terminology_codes(tenant_id,release_id,code,code_key,display,billable,active,effective_start) VALUES($1,$2,'64617','64617','Synthetic neck injection, second kind',true,true,'2020-01-01')").bind(h.owner.tenant_id).bind(release).execute(&h.db).await.unwrap();
    let id = Uuid::new_v4();
    h.ask(&h.owner, id, 0).await.0.unwrap();
    h.step(&h.owner, done(id, SERVICES_FIRST), Ok(1))
        .await
        .0
        .unwrap();
    assert_eq!(
        stored_services(&h, id).await[0]["candidates"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // Turned off for the practice, nothing of the HCPCS list is offered, its own codes included.
    let g = setup_services().await;
    sqlx::query("INSERT INTO practice_code_sets(tenant_id,system,enabled,version,updated_by) VALUES($1,'HCPCS',false,1,$1)").bind(g.owner.tenant_id).execute(&g.db).await.unwrap();
    let id = Uuid::new_v4();
    g.ask(&g.owner, id, 0).await.0.unwrap();
    g.step(&g.owner, done(id, SERVICES_FIRST), Ok(1))
        .await
        .0
        .unwrap();
    let drug = &stored_services(&g, id).await[1];
    assert_eq!(drug["candidates"], json!([]), "{drug}");
}

#[tokio::test]
async fn no_more_than_eight_procedures_are_kept() {
    let f = setup_services().await;
    for n in 0..10 {
        sqlx::query("INSERT INTO practice_codes(tenant_id,id,system,code,display,enabled,price_cents,default_units,modifiers,version,created_by,updated_by) VALUES($1,$2,'CPT',$3,$4,true,100,1,'',1,$5,$5)")
            .bind(f.owner.tenant_id).bind(Uuid::new_v4()).bind(format!("7000{n}")).bind(format!("Synthetic bulk service {n}")).bind(f.owner.sub).execute(&f.db).await.unwrap();
    }
    let items: Vec<Value> = (0..10).map(|n| json!({"service":format!("Bulk {n}"),"evidence":"Office visit today","search_terms":[format!("bulk service {n}")]})).collect();
    let first = json!({"problems":[],"services":items}).to_string();
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let picks: Vec<Value> = (0..10)
        .map(|n| json!({"service":n+1,"code":format!("7000{n}")}))
        .collect();
    let answer = json!({"service_choices":picks}).to_string();
    let (_, out) = f.two_steps(&f.owner, id, &first, &answer).await;
    assert_eq!(out["procedures"].as_array().unwrap().len(), 8, "{out}");
    assert_eq!(out["procedures"][0]["code"], "70000");
}

#[tokio::test]
async fn the_services_migration_applies_over_an_existing_database_with_a_waiting_request() {
    let db = pool_at(Some(124)).await;
    let tenant = Uuid::new_v4();
    let (patient, appointment, visit, request, clinician) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-MRN-1','Synthetic','Person','1990-01-01')").bind(tenant).bind(patient).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')").bind(tenant).bind(appointment).bind(patient).bind(clinician).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,note) VALUES($1,$2,$3,$4,$5,'{}')").bind(tenant).bind(visit).bind(patient).bind(appointment).bind(clinician).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO diagnosis_suggestion_requests(tenant_id,id,visit_id,requested_by,note_version,status,position,stage,problems,choose_id) VALUES($1,$2,$3,$4,1,'queued',2,'choose','[]',$5)").bind(tenant).bind(request).bind(visit).bind(clinician).bind(Uuid::new_v4()).execute(&db).await.unwrap();
    crate::MIGRATOR.run(&db).await.unwrap();
    crate::MIGRATOR.run(&db).await.unwrap();
    let (stage, services, status, position): (String, Option<Value>, String, Option<i32>) =
        sqlx::query_as(
            "SELECT stage,services,status,position FROM diagnosis_suggestion_requests WHERE id=$1",
        )
        .bind(request)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(
        (stage.as_str(), services, status.as_str(), position),
        ("choose", None, "queued", Some(2))
    );
    assert!(
        sqlx::query("UPDATE diagnosis_suggestion_requests SET services='{}' WHERE id=$1")
            .bind(request)
            .execute(&db)
            .await
            .is_err()
    );
    assert_eq!(
        sqlx::query("UPDATE diagnosis_suggestion_requests SET services='[]' WHERE id=$1")
            .bind(request)
            .execute(&db)
            .await
            .unwrap()
            .rows_affected(),
        1
    );
}

#[path = "local_ai_bakeoff_tests.rs"]
mod bakeoff;
