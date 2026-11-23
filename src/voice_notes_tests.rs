// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic data only. Each test runs in its own disposable schema.
use super::*;
use crate::{
    auth::{Actor, Role},
    browser::BrowserAuth,
    document_store::DocumentStore,
    postgres::PostgresBackend,
};
use axum::{body::Body, http::Request};
use chrono::Utc;
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

const SECRET: &str = "synthetic-voice-notes-test-secret";
const WORDS: &str =
    "Synthetic dictation: knee pain after a fall, mild swelling, ice and rest advised.";
const DRAFT: &str = r#"{"subjective":"Knee pain after a fall.","objective":"Mild swelling.","assessment":"","plan":"Ice and rest."}"#;

struct Fixture {
    db: PgPool,
    owner: Actor,
    patient: Uuid,
    visit: Uuid,
    store: Arc<DocumentStore>,
}
async fn pool() -> PgPool {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("voice_notes_test_{}", Uuid::new_v4().simple());
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
    crate::MIGRATOR.run(&db).await.unwrap();
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
async fn setup() -> Fixture {
    let db = pool().await;
    let owner = actor(Uuid::new_v4(), Role::Owner);
    user(&db, &owner, "owner").await;
    let (patient, appointment, visit) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-MRN-5521','Zelda','Quillfeather','1987-03-09')").bind(owner.tenant_id).bind(patient).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-10-25T14:00:00Z','2026-10-25T14:30:00Z','checked_in')").bind(owner.tenant_id).bind(appointment).bind(patient).bind(owner.sub).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,note) VALUES($1,$2,$3,$4,$5,'{}')").bind(owner.tenant_id).bind(visit).bind(patient).bind(appointment).bind(owner.sub).execute(&db).await.unwrap();
    Fixture {
        db,
        owner,
        patient,
        visit,
        store: DocumentStore::database(),
    }
}

/// A stand-in for SunCharts Connect.
#[derive(Default)]
struct Stub {
    down: Mutex<bool>,
    transcribed: Mutex<Vec<Value>>,
    chats: Mutex<Vec<Value>>,
    jobs: Mutex<HashMap<Uuid, Value>>,
}
impl Stub {
    fn set(&self, id: Uuid, status: &str, content: Option<&str>) {
        self.jobs.lock().unwrap().insert(
            id,
            json!({"request_id":id,"status":status,"position":1,"content":content,"error":null}),
        );
    }
    fn down(&self, value: bool) {
        *self.down.lock().unwrap() = value;
    }
    fn last_chat(&self) -> Value {
        self.chats.lock().unwrap().last().cloned().unwrap()
    }
}
impl Connect for Stub {
    fn available(&self) -> impl Future<Output = bool> + Send {
        async move { !*self.down.lock().unwrap() }
    }
    fn transcribe(&self, body: Value) -> impl Future<Output = crate::error::Result<Value>> + Send {
        async move {
            if *self.down.lock().unwrap() {
                return Err(Error::Conflict("off"));
            }
            self.transcribed.lock().unwrap().push(body.clone());
            Ok(
                json!({"request_id":body["request_id"],"kind":"transcribe","status":"queued","position":2}),
            )
        }
    }
    fn chat(&self, body: Value) -> impl Future<Output = crate::error::Result<Value>> + Send {
        async move {
            if *self.down.lock().unwrap() {
                return Err(Error::Unavailable("down"));
            }
            self.chats.lock().unwrap().push(body.clone());
            Ok(json!({"request_id":body["request_id"],"status":"queued","position":1}))
        }
    }
    fn job(&self, id: Uuid) -> impl Future<Output = crate::error::Result<Value>> + Send {
        async move {
            self.jobs
                .lock()
                .unwrap()
                .get(&id)
                .cloned()
                .ok_or(Error::Unavailable("unknown"))
        }
    }
}

fn webm(extra: usize) -> Vec<u8> {
    let mut v = vec![0x1a, 0x45, 0xdf, 0xa3];
    v.extend(std::iter::repeat_n(7u8, 64 + extra));
    v
}
fn recording(mode: &str, consent: bool) -> Recording {
    Recording {
        audio: webm(0),
        content_type: "audio/webm".into(),
        mode: mode.into(),
        consent,
        duration: Some(12.5),
    }
}
fn refusal<T>(r: R<T>) -> (u16, String) {
    match r {
        Ok(_) => panic!("expected a refusal"),
        Err(Refuse::Plain(status, _, message)) => (status.as_u16(), message.to_string()),
        Err(Refuse::Err(e)) => {
            let response = e.into_response();
            (response.status().as_u16(), String::new())
        }
    }
}
impl Fixture {
    async fn record(&self, c: &Stub, mode: &str) -> Value {
        record(
            &self.db,
            &self.store,
            &self.owner,
            self.visit,
            recording(mode, true),
            c,
        )
        .await
        .unwrap_or_else(|_| panic!("record refused"))
    }
    async fn list(&self, c: &Stub, all: bool) -> Value {
        list(&self.db, &self.owner, self.visit, all, c)
            .await
            .unwrap_or_else(|_| panic!("list refused"))
    }
    async fn row(&self, id: Uuid) -> (String, Option<i32>, Option<String>, Option<String>) {
        sqlx::query_as("SELECT stage,position,error,transcript FROM voice_notes WHERE id=$1")
            .bind(id)
            .fetch_one(&self.db)
            .await
            .unwrap()
    }
    async fn event(&self, c: &Stub, job: Uuid) {
        job_event_with(&self.db, c, self.owner.tenant_id, job)
            .await
            .unwrap();
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
fn id_of(item: &Value) -> Uuid {
    item["id"].as_str().unwrap().parse().unwrap()
}

#[tokio::test]
async fn recording_saves_a_file_and_a_row_and_submits_only_the_audio() {
    let f = setup().await;
    let c = Stub::default();
    let item = f.record(&c, "encounter").await;
    let id = id_of(&item);
    assert_eq!(item["stage"], "waiting");
    assert_eq!(item["position"], 2);
    assert_eq!(item["mode"], "encounter");
    assert_eq!(item["consent_recorded"], true);
    assert_eq!(item["duration_seconds"], 12.5);
    assert_eq!(item["patient_id"], json!(f.patient));
    assert_eq!(item["transcript"], Value::Null);
    assert_eq!(item["draft"], Value::Null);
    // The recording is an encounter file the Files tab lists.
    let (title, visit, ct, size): (String, String, String, i64) = sqlx::query_as("SELECT content->>'title',content->>'visit_id',content_type,size_bytes FROM patient_documents WHERE tenant_id=$1 AND id=$2")
        .bind(f.owner.tenant_id).bind(item["file_id"].as_str().unwrap().parse::<Uuid>().unwrap()).fetch_one(&f.db).await.unwrap();
    assert!(
        title.starts_with("Voice note · Recorded encounter · "),
        "{title}"
    );
    assert_eq!(
        (visit, ct.as_str(), size),
        (f.visit.to_string(), "audio/webm", 68)
    );
    // What went to Connect: the id, the type, the audio and the language. Nothing about the patient.
    let sent = c.transcribed.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["request_id"], json!(id));
    assert_eq!(sent[0]["content_type"], "audio/webm");
    assert_eq!(sent[0]["language"], "en");
    assert_eq!(
        STANDARD
            .decode(sent[0]["audio_base64"].as_str().unwrap())
            .unwrap(),
        webm(0)
    );
    let keys: Vec<_> = sent[0].as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys.len(), 4, "{keys:?}");
    // One audit row for the recording, then the stage notice; both on the encounter.
    assert_eq!(f.audits("visit.voice_note_recorded").await, 1);
    assert_eq!(f.audits("visit.voice_note_waiting").await, 1);
}

#[tokio::test]
async fn an_encounter_recording_needs_consent_and_a_big_file_is_refused() {
    let f = setup().await;
    let c = Stub::default();
    let (status, message) = refusal(
        record(
            &f.db,
            &f.store,
            &f.owner,
            f.visit,
            recording("encounter", false),
            &c,
        )
        .await,
    );
    assert_eq!((status, message.as_str()), (422, NEEDS_CONSENT));
    // A dictation needs no consent.
    assert_eq!(
        record(
            &f.db,
            &f.store,
            &f.owner,
            f.visit,
            recording("dictation", false),
            &c
        )
        .await
        .is_ok(),
        true
    );
    let mut big = recording("dictation", false);
    big.audio = webm(MAX_AUDIO);
    let (status, message) = refusal(record(&f.db, &f.store, &f.owner, f.visit, big, &c).await);
    assert_eq!((status, message.as_str()), (413, TOO_BIG));
    assert_eq!(f.count_notes().await, 1);
    assert_eq!(c.transcribed.lock().unwrap().len(), 1);
}
impl Fixture {
    async fn count_notes(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM voice_notes")
            .fetch_one(&self.db)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn the_form_is_read_and_codec_notes_are_dropped() {
    let boundary = "synthetic-boundary-1";
    let mut body = Vec::new();
    let mut part = |name: &str, kind: Option<&str>, data: &[u8]| {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"{}\r\n",
                if kind.is_some() {
                    "; filename=\"a.webm\""
                } else {
                    ""
                }
            )
            .as_bytes(),
        );
        if let Some(kind) = kind {
            body.extend_from_slice(format!("Content-Type: {kind}\r\n").as_bytes());
        }
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    };
    part("mode", None, b"encounter");
    part("consent", None, b"true");
    part("duration_seconds", None, b"31.5");
    part("audio", Some("audio/webm;codecs=opus"), &webm(0));
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let r = parse_upload(&format!("multipart/form-data; boundary={boundary}"), &body)
        .ok()
        .unwrap();
    assert_eq!(
        (
            r.content_type.as_str(),
            r.mode.as_str(),
            r.consent,
            r.duration
        ),
        ("audio/webm", "encounter", true, Some(31.5))
    );
    assert_eq!(r.audio, webm(0));
    assert_eq!(refusal(parse_upload("application/json", b"{}")).0, 422);
    // A type outside the list is refused.
    let mut other = Vec::new();
    other.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"\r\nContent-Type: video/webm\r\n\r\nxx\r\n--{boundary}--\r\n").as_bytes());
    assert_eq!(
        refusal(parse_upload(
            &format!("multipart/form-data; boundary={boundary}"),
            &other
        ))
        .0,
        422
    );
}

#[tokio::test]
async fn a_signed_note_and_the_wrong_roles_are_refused() {
    let f = setup().await;
    let c = Stub::default();
    for role in [Role::Nurse, Role::MedicalAssistant, Role::FrontDesk] {
        let other = actor(f.owner.tenant_id, role);
        user(&f.db, &other, "nurse").await;
        assert_eq!(
            refusal(
                record(
                    &f.db,
                    &f.store,
                    &other,
                    f.visit,
                    recording("dictation", false),
                    &c
                )
                .await
            )
            .0,
            403
        );
        assert_eq!(
            refusal(list(&f.db, &other, f.visit, false, &c).await).0,
            403
        );
    }
    let item = f.record(&c, "dictation").await;
    sqlx::query("UPDATE visits SET status='signed',signed_by=$2,signed_at=now() WHERE id=$1")
        .bind(f.visit)
        .bind(f.owner.sub)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        refusal(
            record(
                &f.db,
                &f.store,
                &f.owner,
                f.visit,
                recording("dictation", false),
                &c
            )
            .await
        )
        .0,
        409
    );
    assert_eq!(
        refusal(retry(&f.db, &f.store, &f.owner, f.visit, id_of(&item), &c).await).0,
        409
    );
    // Reading what was already there is still allowed.
    assert_eq!(
        f.list(&c, false).await["items"].as_array().unwrap().len(),
        1
    );
}

#[tokio::test]
async fn an_unreachable_connect_keeps_the_recording_saved_and_retry_sends_it() {
    let f = setup().await;
    let c = Stub::default();
    c.down(true);
    let item = f.record(&c, "dictation").await;
    let id = id_of(&item);
    assert_eq!(
        (item["stage"].as_str(), item["error"].as_str()),
        (Some("saved"), Some("unavailable"))
    );
    assert_eq!(f.list(&c, false).await["available"], false);
    let file: Uuid = item["file_id"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM patient_documents WHERE id=$1")
            .bind(file)
            .fetch_one(&f.db)
            .await
            .unwrap(),
        1
    );
    // Still down: the voice note stays saved.
    let again = retry(&f.db, &f.store, &f.owner, f.visit, id, &c)
        .await
        .ok()
        .unwrap();
    assert_eq!(again["stage"], "saved");
    c.down(false);
    let sent = retry(&f.db, &f.store, &f.owner, f.visit, id, &c)
        .await
        .ok()
        .unwrap();
    assert_eq!(
        (sent["stage"].as_str(), sent["error"].as_str()),
        (Some("waiting"), None)
    );
    assert_eq!(c.transcribed.lock().unwrap()[0]["request_id"], json!(id));
    assert_eq!(f.list(&c, false).await["available"], true);
}

#[tokio::test]
async fn events_move_a_voice_note_through_to_a_draft_and_carry_no_words() {
    let f = setup().await;
    let c = Stub::default();
    let id = id_of(&f.record(&c, "dictation").await);
    c.set(id, "queued", None);
    f.event(&c, id).await;
    assert_eq!(f.row(id).await.0, "waiting");
    c.set(id, "running", None);
    f.event(&c, id).await;
    assert_eq!(
        (f.row(id).await.0.as_str(), f.row(id).await.1),
        ("transcribing", Some(0))
    );
    c.set(id, "done", Some(WORDS));
    f.event(&c, id).await;
    let (stage, _, _, transcript) = f.row(id).await;
    assert_eq!(
        (stage.as_str(), transcript.as_deref()),
        ("drafting", Some(WORDS))
    );
    let chat = c.last_chat();
    assert_eq!(chat["json"], true);
    assert!(chat["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("Use ONLY what was said"));
    assert!(!chat["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("conversation between"));
    assert!(chat["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains(WORDS));
    assert!(!chat.to_string().contains("Quillfeather"));
    let draft_id: Uuid = chat["request_id"].as_str().unwrap().parse().unwrap();
    // A word about the first job again changes nothing and sends nothing more.
    f.event(&c, id).await;
    assert_eq!(c.chats.lock().unwrap().len(), 1);
    c.set(draft_id, "running", None);
    f.event(&c, draft_id).await;
    c.set(draft_id, "done", Some(&format!("```json\n{DRAFT}\n```")));
    f.event(&c, draft_id).await;
    assert_eq!(f.row(id).await.0, "ready");
    let item = f.list(&c, false).await["items"][0].clone();
    assert_eq!(item["draft"]["plan"], "Ice and rest.");
    assert_eq!(item["draft"]["assessment"], "");
    assert_eq!(item["transcript"], WORDS);
    // Each stage change was announced once, on the encounter, by name only.
    for stage in ["waiting", "transcribing", "drafting", "ready"] {
        assert_eq!(
            f.audits(&format!("visit.voice_note_{stage}")).await,
            1,
            "{stage}"
        );
    }
    let rows: Vec<String> =
        sqlx::query_scalar("SELECT to_jsonb(a)::text FROM audit_events a WHERE tenant_id=$1")
            .bind(f.owner.tenant_id)
            .fetch_all(&f.db)
            .await
            .unwrap();
    for row in rows {
        assert!(
            !row.contains("knee") && !row.contains("Ice and rest") && !row.contains("webm"),
            "{row}"
        );
    }
}

#[tokio::test]
async fn reading_the_list_moves_a_voice_note_on_when_the_events_were_missed() {
    let f = setup().await;
    let c = Stub::default();
    let id = id_of(&f.record(&c, "encounter").await);
    c.set(id, "running", None);
    assert_eq!(f.list(&c, false).await["items"][0]["stage"], "transcribing");
    c.set(id, "done", Some(WORDS));
    assert_eq!(f.list(&c, false).await["items"][0]["stage"], "drafting");
    assert!(c.last_chat()["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("conversation between a clinician and a patient"));
    let draft_id: Uuid = c.last_chat()["request_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    c.set(draft_id, "done", Some(DRAFT));
    let item = f.list(&c, false).await["items"][0].clone();
    assert_eq!(
        (item["stage"].as_str(), item["draft"]["subjective"].as_str()),
        (Some("ready"), Some("Knee pain after a fall."))
    );
    // A drafting job that cannot be asked for yet is asked for again by the sweep.
    let id2 = id_of(&f.record(&c, "dictation").await);
    c.set(id2, "done", Some(WORDS));
    c.down(false);
    f.event(&c, id2).await;
    assert_eq!(f.row(id2).await.0, "drafting");
}

#[tokio::test]
async fn a_drafting_job_that_could_not_be_submitted_is_submitted_by_the_next_look() {
    let f = setup().await;
    let c = Stub::default();
    let id = id_of(&f.record(&c, "dictation").await);
    c.set(id, "done", Some(WORDS));
    // The assistant is unreachable for the chat step only.
    struct ChatDown<'a>(&'a Stub, Mutex<bool>);
    impl Connect for ChatDown<'_> {
        fn available(&self) -> impl Future<Output = bool> + Send {
            self.0.available()
        }
        fn transcribe(&self, b: Value) -> impl Future<Output = crate::error::Result<Value>> + Send {
            self.0.transcribe(b)
        }
        fn chat(&self, b: Value) -> impl Future<Output = crate::error::Result<Value>> + Send {
            async move {
                if *self.1.lock().unwrap() {
                    Err(Error::Unavailable("down"))
                } else {
                    self.0.chat(b).await
                }
            }
        }
        fn job(&self, id: Uuid) -> impl Future<Output = crate::error::Result<Value>> + Send {
            self.0.job(id)
        }
    }
    let d = ChatDown(&c, Mutex::new(true));
    job_event_with(&f.db, &d, f.owner.tenant_id, id)
        .await
        .unwrap();
    let (stage, _, _, transcript) = f.row(id).await;
    assert_eq!(
        (stage.as_str(), transcript.as_deref()),
        ("transcribing", Some(WORDS))
    );
    *d.1.lock().unwrap() = false;
    let n: Note = sqlx::query_as(&format!("{NOTE} WHERE id=$1"))
        .bind(id)
        .fetch_one(&f.db)
        .await
        .unwrap();
    drive(&f.db, &d, f.owner.tenant_id, &n).await.unwrap();
    assert_eq!(f.row(id).await.0, "drafting");
}

#[tokio::test]
async fn an_empty_transcript_fails_as_empty() {
    let f = setup().await;
    let c = Stub::default();
    let id = id_of(&f.record(&c, "dictation").await);
    c.set(id, "done", Some("  ... \n "));
    f.event(&c, id).await;
    let (stage, _, error, transcript) = f.row(id).await;
    assert_eq!(
        (stage.as_str(), error.as_deref(), transcript),
        ("failed", Some("empty"), None)
    );
    assert!(c.chats.lock().unwrap().is_empty());
    assert_eq!(f.audits("visit.voice_note_failed").await, 1);
}

#[tokio::test]
async fn an_invalid_draft_fails_but_keeps_the_words_and_retry_drafts_again() {
    let f = setup().await;
    let c = Stub::default();
    let id = id_of(&f.record(&c, "dictation").await);
    c.set(id, "done", Some(WORDS));
    f.event(&c, id).await;
    let draft_id: Uuid = c.last_chat()["request_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    for bad in [
        r#"{"subjective":"a","objective":"b","assessment":"c"}"#,
        r#"{"subjective":"a","objective":1,"assessment":"c","plan":"d"}"#,
        r#"{"subjective":"","objective":"","assessment":"","plan":""}"#,
        "not json at all",
    ] {
        c.set(draft_id, "done", Some(bad));
        // Reset to drafting for each bad answer.
        sqlx::query(
            "UPDATE voice_notes SET stage='drafting',error=NULL,finished_at=NULL WHERE id=$1",
        )
        .bind(id)
        .execute(&f.db)
        .await
        .unwrap();
        f.event(&c, draft_id).await;
        let (stage, _, error, transcript) = f.row(id).await;
        assert_eq!(
            (stage.as_str(), error.as_deref(), transcript.as_deref()),
            ("failed", Some("draft_invalid"), Some(WORDS)),
            "{bad}"
        );
    }
    let item = f.list(&c, false).await["items"][0].clone();
    assert_eq!(
        (item["stage"].as_str(), item["transcript"].as_str()),
        (Some("failed"), Some(WORDS))
    );
    // Retry asks only for the draft: no second transcription.
    let again = retry(&f.db, &f.store, &f.owner, f.visit, id, &c)
        .await
        .ok()
        .unwrap();
    assert_eq!(again["stage"], "drafting");
    assert_eq!(c.transcribed.lock().unwrap().len(), 1);
    let new_id: Uuid = c.last_chat()["request_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_ne!(new_id, draft_id);
}

#[tokio::test]
async fn a_failed_transcription_is_retried_from_the_stored_recording() {
    let f = setup().await;
    let c = Stub::default();
    let id = id_of(&f.record(&c, "dictation").await);
    c.jobs.lock().unwrap().insert(
        id,
        json!({"request_id":id,"status":"failed","error":"timeout"}),
    );
    f.event(&c, id).await;
    assert_eq!(
        (f.row(id).await.0.as_str(), f.row(id).await.2.as_deref()),
        ("failed", Some("timeout"))
    );
    let again = retry(&f.db, &f.store, &f.owner, f.visit, id, &c)
        .await
        .ok()
        .unwrap();
    assert_eq!(again["stage"], "waiting");
    let sent = c.transcribed.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    assert_ne!(sent[1]["request_id"], sent[0]["request_id"]);
    assert_eq!(sent[1]["audio_base64"], sent[0]["audio_base64"]);
}

#[tokio::test]
async fn no_more_than_three_unfinished_per_encounter() {
    let f = setup().await;
    let c = Stub::default();
    for _ in 0..3 {
        f.record(&c, "dictation").await;
    }
    let (status, message) = refusal(
        record(
            &f.db,
            &f.store,
            &f.owner,
            f.visit,
            recording("dictation", false),
            &c,
        )
        .await,
    );
    assert_eq!((status, message.as_str()), (429, TOO_MANY));
}

#[tokio::test]
async fn dismissing_hides_it_clears_the_words_and_keeps_the_file() {
    let f = setup().await;
    let c = Stub::default();
    let item = f.record(&c, "dictation").await;
    let id = id_of(&item);
    c.set(id, "done", Some(WORDS));
    f.event(&c, id).await;
    let out = dismiss(&f.db, &f.owner, f.visit, id).await.ok().unwrap();
    assert_eq!(
        (out["dismissed"].as_bool(), out["id"].as_str()),
        (Some(true), item["id"].as_str())
    );
    assert_eq!(
        f.list(&c, false).await["items"].as_array().unwrap().len(),
        0
    );
    let all = f.list(&c, true).await["items"][0].clone();
    assert_eq!(
        (all["dismissed"].as_bool(), all["transcript"].clone()),
        (Some(true), Value::Null)
    );
    let file: Uuid = item["file_id"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM patient_documents WHERE id=$1")
            .bind(file)
            .fetch_one(&f.db)
            .await
            .unwrap(),
        1
    );
    // A late answer does not bring it back.
    let draft_id: Uuid = c.last_chat()["request_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    c.set(draft_id, "done", Some(DRAFT));
    f.event(&c, draft_id).await;
    let (stage, _, _, transcript) = f.row(id).await;
    assert_eq!((stage.as_str(), transcript), ("drafting", None));
}

#[tokio::test]
async fn another_practice_sees_and_changes_nothing() {
    let f = setup().await;
    let c = Stub::default();
    let id = id_of(&f.record(&c, "dictation").await);
    let stranger = actor(Uuid::new_v4(), Role::Clinician);
    user(&f.db, &stranger, "clinician").await;
    assert_eq!(
        refusal(list(&f.db, &stranger, f.visit, true, &c).await).0,
        404
    );
    assert_eq!(refusal(dismiss(&f.db, &stranger, f.visit, id).await).0, 404);
    assert_eq!(
        refusal(retry(&f.db, &f.store, &stranger, f.visit, id, &c).await).0,
        404
    );
    assert_eq!(
        refusal(
            record(
                &f.db,
                &f.store,
                &stranger,
                f.visit,
                recording("dictation", false),
                &c
            )
            .await
        )
        .0,
        404
    );
    // A Connect event under another practice's id leaves it alone.
    c.set(id, "running", None);
    job_event_with(&f.db, &c, stranger.tenant_id, id)
        .await
        .unwrap();
    assert_eq!(f.row(id).await.0, "waiting");
    // Same practice, another encounter's id.
    assert_eq!(
        refusal(dismiss(&f.db, &f.owner, Uuid::new_v4(), id).await).0,
        404
    );
}

#[tokio::test]
async fn the_routes_take_a_multipart_form_and_refuse_a_front_desk_account() {
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
    let token = |a: &Actor| {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            a,
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap()
    };
    let boundary = "synthetic-boundary-2";
    let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"mode\"\r\n\r\ndictation\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"a.webm\"\r\nContent-Type: audio/webm\r\n\r\n").into_bytes();
    body.extend(webm(0));
    body.extend(format!("\r\n--{boundary}--\r\n").into_bytes());
    let post = |who: &Actor| {
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/visits/{}/voice-notes", f.visit))
            .header("Authorization", format!("Bearer {}", token(who)))
            .header(
                "Content-Type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body.clone()))
            .unwrap()
    };
    let refused = app.clone().oneshot(post(&desk)).await.unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    // A practice not connected to Connect: the recording is kept, saved, to be sent later.
    let made = app.clone().oneshot(post(&f.owner)).await.unwrap();
    assert_eq!(made.status(), StatusCode::CREATED);
    let item: Value =
        serde_json::from_slice(&made.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        (item["stage"].as_str(), item["error"].as_str()),
        (Some("saved"), Some("unavailable"))
    );
    let listed = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/visits/{}/voice-notes", f.visit))
                .header("Authorization", format!("Bearer {}", token(&f.owner)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    let out: Value =
        serde_json::from_slice(&listed.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        (
            out["available"].clone(),
            out["items"].as_array().unwrap().len()
        ),
        (json!(false), 1)
    );
}

#[test]
fn drafts_are_checked_for_shape_and_length() {
    assert!(read_draft(DRAFT).is_some());
    let long = format!(
        r#"{{"subjective":"{}","objective":"","assessment":"","plan":""}}"#,
        "x".repeat(MAX_SECTION + 1)
    );
    assert!(read_draft(&long).is_none());
    assert!(read_draft("[]").is_none());
}
