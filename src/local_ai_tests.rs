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
        read(&self.db, a, self.visit, |_| async move { Ok(job) }).await
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
    assert_eq!(body["purpose"], "diagnosis_suggestions");
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
    let running = f
        .read_with(
            &f.owner,
            json!({"request_id":id,"status":"running","position":null}),
        )
        .await
        .unwrap();
    assert_eq!(running["position"], 0);
    // Connect being unreachable leaves what we last knew.
    let unreachable = read(&f.db, &f.owner, f.visit, |_| async {
        Err(Error::Unavailable("x"))
    })
    .await
    .unwrap();
    assert_eq!(unreachable["status"], "queued");
    let none = setup().await;
    assert_eq!(
        none.read_with(&none.owner, json!({})).await.unwrap()["status"],
        "none"
    );
}

#[tokio::test]
async fn a_finished_job_is_read_checked_against_the_code_list_and_stored() {
    let f = setup().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    // I10 is already on the encounter, so it is not suggested again.
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
    let content = "Sure.\n```json\n{\"suggestions\":[\
      {\"code\":\" e119 \",\"description\":\"The model's own words\",\"evidence\":\"Type 2 diabetes   mellitus WITHOUT complications\"},\
      {\"code\":\"Z99.99\",\"description\":\"Not in the list\",\"evidence\":\"x\"},\
      {\"code\":\"I10\",\"description\":\"Already there\",\"evidence\":\"essential hypertension\"},\
      {\"code\":\"E11\",\"description\":\"A heading, not billable\",\"evidence\":\"diabetes\"},\
      {\"code\":\"J06.9\",\"description\":\"Invented\",\"evidence\":\"cough and sore throat\"},\
      {\"code\":\"E11.9\",\"description\":\"Duplicate\",\"evidence\":\"stable on metformin\"}]}\n```";
    let out = f.read_with(&f.owner, done(id, content)).await.unwrap();
    assert_eq!(out["status"], "ready");
    assert_eq!(out["dropped"], 2);
    assert_eq!(out["model"], "synthetic-model");
    assert_eq!(out["mine"], true);
    assert_eq!(out["note_changed"], false);
    assert_eq!(out["patient_id"], json!(f.patient));
    let list = out["suggestions"].as_array().unwrap();
    assert_eq!(list.len(), 2, "{out}");
    assert_eq!(list[0]["code"], "E11.9");
    assert_eq!(
        list[0]["description"],
        "Type 2 diabetes mellitus without complications (catalog wording)"
    );
    assert_eq!(list[0]["evidence_found"], true);
    assert_eq!(
        list[0]["evidence"],
        "Type 2 diabetes mellitus WITHOUT complications"
    );
    assert_eq!(list[1]["code"], "J06.9");
    assert_eq!(list[1]["evidence"], Value::Null);
    assert_eq!(list[1]["evidence_found"], false);
    assert!(list[0]["catalog_release_id"].is_string());
    // Stored once; reading again does not ask Connect or settle twice.
    let again = read(&f.db, &f.owner, f.visit, |_| async {
        panic!("asked again")
    })
    .await
    .unwrap();
    assert_eq!(again["suggestions"], out["suggestions"]);
    assert_eq!(f.audits("visit.diagnosis_suggestions_ready").await, 1);
    // Still nothing on the chart but what was already there.
    let saved: Value =
        sqlx::query_scalar("SELECT diagnoses FROM visit_diagnoses WHERE visit_id=$1")
            .bind(f.visit)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(saved.as_array().unwrap().len(), 1);
    // No note text or codes in anything the feed carries.
    let rows: Vec<(String,)> = sqlx::query_as("SELECT action FROM audit_events WHERE tenant_id=$1")
        .bind(f.owner.tenant_id)
        .fetch_all(&f.db)
        .await
        .unwrap();
    assert!(rows
        .iter()
        .all(|(a,)| !a.contains("E11") && !a.contains("diabetes")));
}
#[tokio::test]
async fn no_more_than_eight_codes_are_kept() {
    let f = setup().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let items: Vec<Value> = (0..12)
        .map(|i| json!({"code":format!("Q10.{i}"),"description":"x","evidence":"metformin"}))
        .collect();
    let out = f
        .read_with(
            &f.owner,
            done(id, &json!({"suggestions":items}).to_string()),
        )
        .await
        .unwrap();
    assert_eq!(out["suggestions"].as_array().unwrap().len(), 8);
    assert_eq!(out["suggestions"][0]["code"], "Q10.0");
}
#[tokio::test]
async fn an_unreadable_answer_fails_the_request() {
    for content in [
        "I could not decide.",
        "{\"other\":1}",
        "{\"suggestions\":\"none\"}",
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
async fn the_finished_event_settles_the_request_and_tells_browsers_without_codes() {
    let f = setup().await;
    let id = Uuid::new_v4();
    f.ask(&f.owner, id, 0).await.0.unwrap();
    let content = "{\"suggestions\":[{\"code\":\"E11.9\",\"description\":\"x\",\"evidence\":\"stable on metformin\"}]}";
    job_finished_with(&f.db, f.owner.tenant_id, id, |_| async move {
        Ok(done(id, content))
    })
    .await
    .unwrap();
    let (status, result): (String, Value) =
        sqlx::query_as("SELECT status,result FROM diagnosis_suggestion_requests WHERE id=$1")
            .bind(id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(status, "ready");
    assert_eq!(result["suggestions"][0]["code"], "E11.9");
    // The notice is an audit row on the encounter: it reaches the tenant's change feed as a
    // clinical change and has no field that could hold a code or a word of the note.
    let (action, resource): (String, Uuid) = sqlx::query_as("SELECT action,resource_id FROM audit_events WHERE tenant_id=$1 AND action LIKE 'visit.diagnosis_suggestions_%' AND action<>'visit.diagnosis_suggestions_requested'").bind(f.owner.tenant_id).fetch_one(&f.db).await.unwrap();
    assert_eq!(
        (action.as_str(), resource),
        ("visit.diagnosis_suggestions_ready", f.visit)
    );
    // A second notice for the same job changes and announces nothing.
    job_finished_with(&f.db, f.owner.tenant_id, id, |_| async move {
        panic!("asked again")
    })
    .await
    .unwrap();
    assert_eq!(f.audits("visit.diagnosis_suggestions_ready").await, 1);
    // An unknown job is ignored.
    job_finished_with(&f.db, f.owner.tenant_id, Uuid::new_v4(), |_| async move {
        panic!("unknown")
    })
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
    job_finished_with(&f.db, f.owner.tenant_id, id, |_| async move {
        panic!("dismissed")
    })
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
