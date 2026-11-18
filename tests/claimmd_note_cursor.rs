// SPDX-License-Identifier: AGPL-3.0-only
//! Claim.MD notes refresh against a loopback stand-in: every provider shape for
//! the note position must keep the activity screen usable.
use axum::{routing::post, Json, Router};
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use suncharts_engine::{
    auth::{Actor, Role},
    browser::BrowserAuth,
    claimmd_operations,
    delivery::{Adapter, Route},
    postgres::PostgresBackend,
    State,
};
use uuid::Uuid;

struct Fixture {
    url: String,
    schema: String,
    pool: PgPool,
    state: State,
    tenant: Uuid,
    setting: Uuid,
    actor: Actor,
    route: Route,
    answer: Arc<Mutex<Value>>,
    asked: Arc<Mutex<Vec<HashMap<String, String>>>>,
    server: tokio::task::JoinHandle<()>,
}

fn owner(tenant: Uuid) -> Actor {
    Actor {
        sub: Uuid::new_v4(),
        tenant_id: tenant,
        role: Role::Owner,
        patient_id: None,
        iss: "synthetic".into(),
        aud: "synthetic".into(),
        iat: 0,
        exp: i64::MAX,
    }
}

async fn fixture(name: &str) -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("{name}_{}", Uuid::new_v4().simple());
    let scoped = schema.clone();
    let admin = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&admin, &schema).await;
    admin.close().await;
    let pool = PgPoolOptions::new()
        .max_connections(6)
        .after_connect(move |c, _| {
            let query = format!("SET search_path TO {scoped}");
            Box::pin(async move {
                sqlx::query(&query).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&pool).await.unwrap();
    let tenant = Uuid::new_v4();
    let partner = Uuid::new_v4();
    let setting = Uuid::new_v4();
    let actor = owner(tenant);
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,$3,'synthetic','owner')")
        .bind(tenant)
        .bind(actor.sub)
        .bind(format!("{}@example.test", actor.sub.simple()))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO edi_partners(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,$3,$2,'synthetic')")
        .bind(tenant)
        .bind(partner)
        .bind(json!({"name":"Synthetic Claim.MD"}))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO edi_provider_settings(tenant_id,id,partner_id,provider,usage,label,encrypted_key,credential_fingerprint,start_at,response_id,interval_seconds,enabled,verified) VALUES($1,$2,$3,'claim_md','T','Synthetic loopback',repeat('s',32)::bytea,$4,clock_timestamp(),'0',30,true,true)")
        .bind(tenant)
        .bind(setting)
        .bind(partner)
        .bind(Uuid::new_v4().to_string())
        .execute(&pool)
        .await
        .unwrap();
    let state = State {
        backend: Arc::new(PostgresBackend(pool.clone())),
        secret: "synthetic-note-cursor-secret".into(),
        allow_legacy_gateway: false,
        issuer: "synthetic".into(),
        audience: "synthetic".into(),
        browser: Some(BrowserAuth::new(pool.clone(), "http://127.0.0.1:8099".into()).unwrap()),
    };
    let answer: Arc<Mutex<Value>> = Arc::new(Mutex::new(json!({})));
    let asked: Arc<Mutex<Vec<HashMap<String, String>>>> = Arc::new(Mutex::new(Vec::new()));
    let handler_answer = answer.clone();
    let handler_asked = asked.clone();
    let service = Router::new().route(
        "/services/notes/",
        post(
            move |axum::Form(fields): axum::Form<HashMap<String, String>>| {
                let asked = handler_asked.clone();
                let answer = handler_answer.clone();
                async move {
                    asked.lock().unwrap().push(fields);
                    Json(answer.lock().unwrap().clone())
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, service).await.unwrap() });
    let route = Route {
        key: format!("synthetic-notes-{}", Uuid::new_v4().simple()),
        tenant_id: tenant,
        partner_id: partner,
        endpoint: format!("http://{address}/services/upload/"),
        usage: "T".into(),
        credential_env: None,
        credential_value: None,
        loopback_test: true,
        adapter: Adapter::ClaimMd,
        retrieval: None,
        sftp: None,
    };
    Fixture {
        url,
        schema,
        pool,
        state,
        tenant,
        setting,
        actor,
        route,
        answer,
        asked,
        server,
    }
}

impl Fixture {
    fn answer(&self, value: Value) {
        *self.answer.lock().unwrap() = value;
    }
    fn note_id_sent(&self) -> String {
        self.asked
            .lock()
            .unwrap()
            .last()
            .and_then(|f| f.get("NoteID").cloned())
            .expect("the refresh reached the provider")
    }
    async fn sync(
        &self,
        claimmd_id: Option<String>,
    ) -> Result<Value, suncharts_engine::error::Error> {
        claimmd_operations::sync_notes_with_route(
            &self.actor,
            &self.state,
            self.setting,
            claimmd_id,
            &self.route,
        )
        .await
    }
    async fn cursor_is(&self, expected: &str) {
        for _ in 0..50 {
            let saved: Option<String> = sqlx::query_scalar("SELECT note_id FROM claimmd_operation_cursors WHERE tenant_id=$1 AND setting_id=$2")
                .bind(self.tenant)
                .bind(self.setting)
                .fetch_optional(&self.pool)
                .await
                .unwrap();
            if saved.as_deref() == Some(expected) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the saved note position never became {expected}");
    }
    async fn set_cursor(&self, value: &str) {
        sqlx::query("INSERT INTO claimmd_operation_cursors(tenant_id,setting_id,note_id) VALUES($1,$2,'0') ON CONFLICT DO NOTHING")
            .bind(self.tenant)
            .bind(self.setting)
            .execute(&self.pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE claimmd_operation_cursors SET note_id=$3 WHERE tenant_id=$1 AND setting_id=$2",
        )
        .bind(self.tenant)
        .bind(self.setting)
        .bind(value)
        .execute(&self.pool)
        .await
        .unwrap();
    }
    async fn note_rows(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM claimmd_operation_records WHERE tenant_id=$1 AND setting_id=$2 AND kind='note'")
            .bind(self.tenant)
            .bind(self.setting)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
    async fn close(self) {
        self.server.abort();
        self.pool.close().await;
        let admin = PgPool::connect(&self.url).await.unwrap();
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&admin)
            .await
            .unwrap();
        admin.close().await;
    }
}

fn wait_for_port() {
    // The loopback stand-in is accepted before the request runs; a short pause
    // keeps a killed server from being mistaken for a provider failure.
    std::thread::sleep(Duration::from_millis(10));
}

#[tokio::test]
async fn an_account_without_notes_keeps_the_screen_open_and_the_saved_position() {
    let f = fixture("notes_absent").await;
    wait_for_port();
    // Claim.MD sends neither LastNoteID nor a notes list for an account with none.
    f.answer(json!({}));
    let out = f.sync(None).await.expect("no notes is not an error");
    assert_eq!(out["inserted"], 0);
    assert_eq!(out["last_note_id"], "0");
    f.cursor_is("0").await;
    assert_eq!(f.note_rows().await, 0);
    f.close().await;
}

#[tokio::test]
async fn notes_with_a_numeric_position_are_saved_and_the_position_advances() {
    let f = fixture("notes_numeric").await;
    wait_for_port();
    f.answer(json!({
        "LastNoteID": "111111112",
        "notes": [
            {"note":"Claim reviewed with the payer.","claimmd_id":"135961467","claimid":"123ABC","username":"Staff One","date_time":"2021-03-19 11:20:48am","noteid":"111111111","pcn":"ACNT456"},
            {"note":"Following up next week.","claimmd_id":"135934535","claimid":"124BBB","username":"Staff One","date_time":"2021-03-19 11:20:48am","noteid":"111111112","pcn":"ACNT999"}
        ]
    }));
    let out = f.sync(None).await.expect("documented shape");
    assert_eq!(out["inserted"], 2);
    assert_eq!(out["last_note_id"], "111111112");
    assert_eq!(out["cursor_advanced"], true);
    f.cursor_is("111111112").await;
    assert_eq!(f.note_rows().await, 2);
    f.close().await;
}

#[tokio::test]
async fn a_position_returned_as_text_is_no_notes_and_never_an_error() {
    let f = fixture("notes_text_position").await;
    wait_for_port();
    f.set_cursor("111111109").await;
    // Some accounts answer with a word instead of a position when they carry
    // changes but no notes. The screen must still open and keep its changes.
    f.answer(json!({"LastNoteID": "none", "notes": []}));
    let out = f.sync(None).await.expect("a text position is not an error");
    assert_eq!(out["inserted"], 0);
    assert_eq!(out["last_note_id"], "111111109");
    f.cursor_is("111111109").await;
    assert_eq!(
        f.note_id_sent(),
        "111111109",
        "the next refresh asks for what comes after the saved position"
    );
    f.close().await;
}

#[tokio::test]
async fn a_blank_position_keeps_the_saved_position() {
    let f = fixture("notes_blank_position").await;
    wait_for_port();
    f.set_cursor("111111109").await;
    f.answer(json!({"LastNoteID": "", "notes": []}));
    let out = f
        .sync(None)
        .await
        .expect("a blank position is not an error");
    assert_eq!(out["last_note_id"], "111111109");
    f.cursor_is("111111109").await;
    f.close().await;
}

#[tokio::test]
async fn a_garbage_position_is_kept_off_the_screen_and_notes_still_arrive() {
    let f = fixture("notes_garbage_position").await;
    wait_for_port();
    f.set_cursor("111111109").await;
    // Unreadable position, but the notes themselves are real evidence: they are
    // stored and shown, the saved position stays, and no error reaches staff.
    f.answer(json!({
        "LastNoteID": "12ab",
        "notes": [
            {"note":"Payer called back.","claimmd_id":"135961467","claimid":"123ABC","username":"Staff Two","date_time":"2021-04-02 09:05:00am","noteid":"111111110","pcn":"ACNT456"}
        ]
    }));
    let out = f
        .sync(None)
        .await
        .expect("a bad position never breaks the screen");
    assert_eq!(out["inserted"], 1);
    assert_eq!(out["last_note_id"], "111111109");
    f.cursor_is("111111109").await;
    assert_eq!(f.note_rows().await, 1);
    f.close().await;
}
