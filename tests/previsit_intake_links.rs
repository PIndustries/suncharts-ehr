// SPDX-License-Identifier: AGPL-3.0-only
//! Standard intake form, chart-sent links, saved progress and reviewed chart updates.
//! Synthetic data only.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::{DateTime, Duration, Utc};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::Arc;
use suncharts_engine::{browser::BrowserAuth, postgres::PostgresBackend, State};
use tower::ServiceExt;
use uuid::Uuid;
const ORIGIN: &str = "http://127.0.0.1:8099";
const CLOSED: &str =
    "This link has expired or is no longer active. Please ask the practice for a new one.";

struct Fixture {
    db: PgPool,
    app: Router,
    tenant: Uuid,
    user: Uuid,
    cookie: String,
}
impl Fixture {
    async fn new() -> Self {
        let url =
            std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
        let initial = PgPool::connect(&url).await.unwrap();
        let schema = format!("intake_links_{}", Uuid::new_v4().simple());
        suncharts_engine::test_db::create_schema(&initial, &schema).await;
        initial.close().await;
        let db = PgPoolOptions::new()
            .max_connections(8)
            .after_connect(move |connection, _| {
                let sql = format!("SET search_path TO {schema}");
                Box::pin(async move {
                    sqlx::query(&sql).execute(connection).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        suncharts_engine::MIGRATOR.run(&db).await.unwrap();
        let tenant = Uuid::new_v4();
        let user = Uuid::new_v4();
        sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,display_name) VALUES($1,$2,'owner@example.test','unused','owner','Synthetic Owner')").bind(user).bind(tenant).execute(&db).await.unwrap();
        let token = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(format!("{:x}",Sha256::digest(token.as_bytes()))).bind(tenant).bind(user).execute(&db).await.unwrap();
        let app = suncharts_engine::app(State {
            backend: Arc::new(PostgresBackend(db.clone())),
            secret: "unused-synthetic".into(),
            allow_legacy_gateway: false,
            issuer: "suncharts".into(),
            audience: "suncharts-engine".into(),
            browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
        });
        Self {
            db,
            app,
            tenant,
            user,
            cookie: format!("sce_session={token}"),
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        staff: bool,
        body: Option<Value>,
        version: Option<i64>,
        client: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("Origin", ORIGIN);
        if staff {
            request = request.header("Cookie", &self.cookie);
        }
        if let Some(v) = version {
            request = request.header("If-Match", format!("\"{v}\""));
        }
        if let Some(address) = client {
            request = match address.strip_prefix("cf:") {
                Some(visitor) => request.header("CF-Connecting-IP", visitor),
                None => request.header("X-Forwarded-For", address),
            };
        }
        let data = if let Some(value) = body {
            request = request.header("Content-Type", "application/json");
            value.to_string()
        } else {
            String::new()
        };
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::from(data)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(json!({})))
    }
    async fn staff(
        &self,
        method: &str,
        path: &str,
        body: Value,
        version: Option<i64>,
    ) -> (StatusCode, Value) {
        self.request(method, path, true, Some(body), version, None)
            .await
    }
    /// A patient request; each test patient uses its own address so the
    /// per-client limits of one test never affect another step.
    async fn patient(&self, action: &str, body: Value) -> (StatusCode, Value) {
        self.request(
            "POST",
            &format!("/api/public/v1/intake/{action}"),
            false,
            Some(body),
            None,
            Some("203.0.113.10"),
        )
        .await
    }
    async fn add_patient(&self) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Synthetic','Sample','1990-01-01')")
            .bind(self.tenant).bind(id).bind(id.to_string()).execute(&self.db).await.unwrap();
        id
    }
    async fn add_appointment(&self, patient: Uuid, starts: DateTime<Utc>) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status,title) VALUES($1,$2,$3,$4,$5,$5+interval '1 hour','booked','Synthetic visit')")
            .bind(self.tenant).bind(id).bind(patient).bind(self.user).bind(starts).execute(&self.db).await.unwrap();
        id
    }
    async fn save_template(&self, schema: Value, version: i64, id: Option<Uuid>) -> StatusCode {
        self.staff("POST", "/api/v1/previsit/templates", json!({"id":id,"name":"Synthetic intake","schema":schema,"active":true,"reason":"Synthetic setup"}), Some(version)).await.0
    }
    /// Sends the default form from the chart and returns (form id, link secret).
    async fn send(&self, patient: Uuid, body: Value) -> (Uuid, String, Value) {
        let (status, sent) = self
            .staff(
                "POST",
                &format!("/api/v1/patients/{patient}/intake-forms"),
                body,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{sent}");
        assert_eq!(sent["secret_shown_once"], true);
        let token = sent["intake_url"]
            .as_str()
            .unwrap()
            .strip_prefix("/intake#token=")
            .unwrap()
            .to_owned();
        (
            sent["packet_id"].as_str().unwrap().parse().unwrap(),
            token,
            sent,
        )
    }
    async fn status_of(&self, packet: Uuid) -> (String, i64) {
        sqlx::query_as("SELECT status,version FROM previsit_intake_packets WHERE id=$1")
            .bind(packet)
            .fetch_one(&self.db)
            .await
            .unwrap()
    }
}

fn standard_answers() -> Value {
    json!({
        "first_name":"Synthetic","last_name":"Sample","date_of_birth":"1990-01-01","sex":"Female",
        "preferred_name":"Syn","preferred_language":"English",
        "phone":"(555) 010-2026","phone_type":"Mobile","email":"synthetic.sample@example.test",
        "address_line1":"100 Example Street","address_line2":"Unit 2","city":"Sampleville","state":"TX","zip":"75001",
        "emergency_name":"Example Contact","emergency_relationship":"Sibling","emergency_phone":"555-010-3030",
        "responsible_party":"Myself","payment_method":"Insurance",
        "insurance_company":"Example Health Plan","insurance_member_id":"SYN-12345","insurance_relationship":"Self",
        "pharmacy_name":"Example Pharmacy"
    })
}
fn submission(token: &str, response: Value) -> Value {
    json!({"token":token,"response":response,"attested_name":"Synthetic Sample","attested":true})
}

#[tokio::test]
async fn standard_form_is_the_default_and_saved_forms_keep_working_unchanged() {
    let f = Fixture::new().await;
    let patient = f.add_patient().await;
    let (_, settings) = f
        .request("GET", "/api/v1/previsit/settings", true, None, None, None)
        .await;
    assert!(settings["template"].is_null());
    assert_eq!(settings["intake_mode"], "standard");
    let steps: Vec<&str> = settings["standard"]["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|section| section["label"].as_str().unwrap())
        .collect();
    assert_eq!(
        steps,
        [
            "About you",
            "Contact",
            "More about you",
            "Emergency contact",
            "Paying for your visits",
            "Primary insurance",
            "Secondary insurance",
            "Pharmacy and one last question"
        ]
    );
    let text = settings["standard"].to_string().to_lowercase();
    assert!(!text.contains("social security") && !text.contains("driver"));

    // Nothing saved: sending works and uses the standard form.
    let (_, token, sent) = f.send(patient, json!({})).await;
    assert_eq!(sent["practice_name"], "Your practice");
    let expires: DateTime<Utc> = sent["expires_at"].as_str().unwrap().parse().unwrap();
    let month = Utc::now() + Duration::days(30);
    assert!((expires - month).num_minutes().abs() < 5, "{expires}");
    let (status, form) = f.patient("read", json!({"token":token})).await;
    assert_eq!(status, StatusCode::OK, "{form}");
    assert_eq!(form["template"]["base"], "standard");
    assert_eq!(form["template"]["sections"].as_array().unwrap().len(), 8);
    assert!(form["appointment"].is_null());
    assert_eq!(form["practice_name"], "Your practice");
    // Only the name the practice already holds is given back, so it can be filled in.
    assert_eq!(
        form["patient"],
        json!({"given_name":"Synthetic","family_name":"Sample"})
    );
    assert!(!form.to_string().contains("1990-01-01"));
    sqlx::query("INSERT INTO practice_facilities(tenant_id,id,name) VALUES($1,$2,'Synthetic Family Clinic')").bind(f.tenant).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    let (_, form) = f.patient("read", json!({"token":token})).await;
    assert_eq!(form["practice_name"], "Synthetic Family Clinic");
    let (_, settings) = f
        .request("GET", "/api/v1/previsit/settings", true, None, None, None)
        .await;
    assert_eq!(settings["template"]["schema"]["base"], "standard");
    assert_eq!(settings["template"]["version"], 1);
    let template: Uuid = settings["template"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let revisions: i64 =
        sqlx::query_scalar("SELECT count(*) FROM previsit_intake_template_revisions")
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(revisions, 1);

    // The practice's own questions become extra steps after the standard ones.
    let own = json!({"label":"Our questions","fields":[{"key":"referring_doctor","label":"Who referred you?","type":"text","required":false,"help":"Leave blank if nobody did."}]});
    let clash = json!({"base":"standard","attestation":"I confirm.","sections":[{"label":"Clash","fields":[{"key":"first_name","label":"First name again","type":"text"}]}]});
    assert_eq!(
        f.save_template(clash, 1, Some(template)).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.save_template(
            json!({"base":"something-else","attestation":"I confirm.","sections":[own]}),
            1,
            Some(template)
        )
        .await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.save_template(
            json!({"base":"standard","attestation":"I confirm these synthetic answers.","sections":[own]}),
            1,
            Some(template)
        )
        .await,
        StatusCode::CREATED
    );
    let (_, token, _) = f.send(patient, json!({})).await;
    let (_, form) = f.patient("read", json!({"token":token})).await;
    let sections = form["template"]["sections"].as_array().unwrap();
    assert_eq!(sections.len(), 9);
    assert_eq!(sections[8]["label"], "Our questions");
    assert_eq!(
        form["template"]["attestation"],
        "I confirm these synthetic answers."
    );

    // A saved form with no mode recorded is used exactly as saved.
    let g = Fixture::new().await;
    let patient = g.add_patient().await;
    let saved = json!({"attestation":"I confirm these synthetic answers.","sections":[{"label":"Patient details","fields":[{"key":"insurance_plan","label":"Insurance plan","type":"text","required":true},{"key":"consent","label":"Consent","type":"checkbox","required":true}]}]});
    assert_eq!(
        g.save_template(saved.clone(), 0, None).await,
        StatusCode::CREATED
    );
    let (_, settings) = g
        .request("GET", "/api/v1/previsit/settings", true, None, None, None)
        .await;
    assert_eq!(settings["intake_mode"], "own");
    let (_, token, _) = g.send(patient, json!({})).await;
    let (_, form) = g.patient("read", json!({"token":token})).await;
    assert_eq!(form["template"], saved);
    let templates: i64 = sqlx::query_scalar("SELECT count(*) FROM previsit_intake_templates")
        .fetch_one(&g.db)
        .await
        .unwrap();
    assert_eq!(templates, 1);
}

#[tokio::test]
async fn conditional_and_skippable_questions_are_checked_when_saved_and_when_answered() {
    let f = Fixture::new().await;
    let patient = f.add_patient().await;
    let form = |sections: Value| json!({"attestation":"I confirm.","sections":sections});
    let pet = json!({"key":"has_pet","label":"Do you have a pet?","type":"select","required":true,"options":["Yes","No"]});
    for bad in [
        // Points at a later question.
        json!([{"label":"One","fields":[{"key":"pet_name","label":"Pet name","type":"text","show_if":{"key":"has_pet","equals":"Yes"}},pet]}]),
        // Points at itself.
        json!([{"label":"One","fields":[{"key":"pet_name","label":"Pet name","type":"text","show_if":{"key":"pet_name","equals":"Yes"}}]}]),
        // Points at nothing.
        json!([{"label":"One","fields":[pet,{"key":"pet_name","label":"Pet name","type":"text","show_if":{"key":"missing","equals":"Yes"}}]}]),
        // Both kinds of rule at once, an empty list and a stray setting.
        json!([{"label":"One","fields":[pet,{"key":"pet_name","label":"Pet name","type":"text","show_if":{"key":"has_pet","equals":"Yes","any_of":["Yes"]}}]}]),
        json!([{"label":"One","fields":[pet,{"key":"pet_name","label":"Pet name","type":"text","show_if":{"key":"has_pet","any_of":[]}}]}]),
        json!([{"label":"One","fields":[pet,{"key":"pet_name","label":"Pet name","type":"text","show_if":{"key":"has_pet","equals":"Yes","then":"x"}}]}]),
        // A section may depend only on a question from an earlier section.
        json!([{"label":"One","show_if":{"key":"has_pet","equals":"Yes"},"fields":[pet]}]),
        json!([{"label":"One","skippable":"yes","fields":[pet]}]),
        // "Needed with" may name only an earlier question.
        json!([{"label":"One","fields":[{"key":"a","label":"A","type":"text","required_with":"b"},{"key":"b","label":"B","type":"text"}]}]),
        json!([{"label":"One","intro":"x".repeat(501),"fields":[pet]}]),
        json!([{"label":"One","fields":[{"key":"a","label":"A","type":"text","help":"x".repeat(301)}]}]),
        json!([{"label":"One","fields":[{"key":"a","label":"A","type":"select","options":["x","y"],"option_labels":["only one"]}]}]),
        json!([{"label":"One","fields":[{"key":"a","label":"A","type":"text","autocomplete":"cc-number"}]}]),
    ] {
        assert_eq!(
            f.save_template(form(bad.clone()), 0, None).await,
            StatusCode::BAD_REQUEST,
            "{bad}"
        );
    }
    let sections = json!([
        {"label":"Pets","intro":"A short introduction.","fields":[pet,
            {"key":"pet_name","label":"Pet name","type":"text","required":true,"help":"Any name.","show_if":{"key":"has_pet","equals":"Yes"}},
            {"key":"pet_count","label":"How many?","type":"number","required":false}]},
        {"label":"Optional extras","skippable":true,"skip_label":"Skip this","fields":[
            {"key":"extra_a","label":"Extra A","type":"text","required":true},
            {"key":"extra_b","label":"Extra B","type":"text","required":false}]},
        {"label":"Vet","show_if":{"key":"has_pet","any_of":["Yes"]},"fields":[
            {"key":"vet","label":"Vet name","type":"text","required":true},
            {"key":"vet_visit","label":"Seen this year","type":"checkbox","required":false,"show_if":{"key":"pet_name","equals":"Rex"}}]}
    ]);
    assert_eq!(
        f.save_template(form(sections), 0, None).await,
        StatusCode::CREATED
    );
    let (packet, token, _) = f.send(patient, json!({})).await;
    let stored = || async {
        sqlx::query_scalar::<_, Value>("SELECT response FROM previsit_intake_responses WHERE packet_id=$1 ORDER BY version DESC LIMIT 1")
            .bind(packet).fetch_one(&f.db).await.unwrap()
    };
    // Hidden questions are not required, and answers to them are not kept.
    let (status, body) = f
        .patient(
            "submit",
            submission(
                &token,
                json!({"has_pet":"No","pet_name":"Rex","vet":"Dr Example","vet_visit":true}),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(stored().await, json!({"has_pet":"No"}));
    // Shown questions are required.
    for missing in [
        json!({"has_pet":"Yes"}),
        json!({"has_pet":"Yes","pet_name":"Rex"}),
        json!({"has_pet":"Yes","pet_name":"   ","vet":"Dr Example"}),
        json!({"pet_name":"Rex","vet":"Dr Example"}),
        // A skippable section that is started must be finished.
        json!({"has_pet":"No","extra_b":"Only the optional one"}),
    ] {
        let (status, body) = f
            .patient("submit", submission(&token, missing.clone()))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{missing} {body}");
        assert_eq!(body["message"], "Please answer every required question.");
    }
    let full = json!({"has_pet":"Yes","pet_name":"Rex","pet_count":"2","extra_a":"A","vet":"Dr Example","vet_visit":true});
    assert_eq!(
        f.patient("submit", submission(&token, full.clone()))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(stored().await, full);
    // A question that depends on a hidden question is hidden too.
    let (status, _) = f.patient("submit", submission(&token, json!({"has_pet":"Yes","pet_name":"Milo","extra_a":"A","vet":"Dr Example","vet_visit":true}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        stored().await,
        json!({"has_pet":"Yes","pet_name":"Milo","extra_a":"A","vet":"Dr Example"})
    );
    // Types, choices and unknown questions are still refused.
    for bad in [
        json!({"has_pet":"Maybe"}),
        json!({"has_pet":"No","pet_count":"many"}),
        json!({"has_pet":"No","unknown":"x"}),
        json!({"has_pet":"No","vet_visit":"true"}),
    ] {
        assert_eq!(
            f.patient("submit", submission(&token, bad.clone())).await.0,
            StatusCode::BAD_REQUEST,
            "{bad}"
        );
    }
}

#[tokio::test]
async fn links_are_sent_replaced_cancelled_and_expire_with_one_plain_message() {
    let f = Fixture::new().await;
    let patient = f.add_patient().await;
    let other = f.add_patient().await;
    let closed = (
        StatusCode::NOT_FOUND,
        json!({"error":"not_found","message":CLOSED}),
    );

    // Sent from the chart with no appointment.
    let (first, first_token, _) = f.send(patient, json!({})).await;
    let (status, form) = f.patient("read", json!({"token":first_token})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(form["status"], "sent");
    let (status, detail) = f
        .request(
            "GET",
            &format!("/api/v1/previsit/packets/{first}"),
            true,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert!(detail["appointment_id"].is_null() && detail["starts_at"].is_null());
    assert_eq!(detail["patient_identity"]["birth_date"], "1990-01-01");

    // "Send a new link" cancels the form that was not sent in and issues a fresh one.
    let (second, second_token, sent) = f.send(patient, json!({})).await;
    assert_eq!(sent["replaced"], 1);
    assert_eq!(f.status_of(first).await, ("void".to_owned(), 2));
    assert_eq!(
        f.patient("read", json!({"token":first_token})).await,
        closed
    );
    assert_eq!(
        f.patient("read", json!({"token":second_token})).await.0,
        StatusCode::OK
    );
    let cancelled: i64 = sqlx::query_scalar("SELECT count(*) FROM previsit_events WHERE packet_id=$1 AND action='intake_packet_cancelled' AND details->>'replaced'='true'").bind(first).fetch_one(&f.db).await.unwrap();
    assert_eq!(cancelled, 1);

    // An unknown link gets exactly the same answer.
    assert_eq!(
        f.patient("read", json!({"token":"not-a-real-link"})).await,
        closed
    );

    // Cancel needs the current version and a reason, and works once.
    let cancel = format!("/api/v1/previsit/packets/{second}/cancel");
    assert_eq!(
        f.staff(
            "POST",
            &cancel,
            json!({"reason":"Sent to the wrong person"}),
            None
        )
        .await
        .0,
        StatusCode::PRECONDITION_REQUIRED
    );
    assert_eq!(
        f.staff(
            "POST",
            &cancel,
            json!({"reason":"Sent to the wrong person"}),
            Some(7)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.staff("POST", &cancel, json!({"reason":""}), Some(1))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.request(
            "POST",
            &cancel,
            false,
            Some(json!({"reason":"No session"})),
            Some(1),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, body) = f
        .staff(
            "POST",
            &cancel,
            json!({"reason":"Sent to the wrong person"}),
            Some(1),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "void");
    for action in ["read", "save", "submit"] {
        let body = match action {
            "read" => json!({"token":second_token}),
            "save" => json!({"token":second_token,"answers":{}}),
            _ => submission(&second_token, standard_answers()),
        };
        assert_eq!(f.patient(action, body).await, closed, "{action}");
    }
    assert_eq!(
        f.staff("POST", &cancel, json!({"reason":"Again"}), Some(2))
            .await
            .0,
        StatusCode::CONFLICT
    );
    // A cancelled form can never be changed again, even directly.
    assert!(sqlx::query(
        "UPDATE previsit_intake_packets SET status='sent',version=version+1 WHERE id=$1"
    )
    .bind(second)
    .execute(&f.db)
    .await
    .is_err());

    // An expired link: same message for reading, saving and sending.
    let (third, third_token, _) = f.send(patient, json!({})).await;
    assert!(
        sqlx::query("UPDATE previsit_intake_packets SET expires_at=now()-interval '1 minute',version=version+1 WHERE id=$1").bind(third).execute(&f.db).await.is_err(),
        "the expiry of an issued link is fixed"
    );
    let snapshot: (Uuid, Value) = sqlx::query_as(
        "SELECT template_id,template_snapshot FROM previsit_intake_packets WHERE id=$1",
    )
    .bind(third)
    .fetch_one(&f.db)
    .await
    .unwrap();
    let expired = Uuid::new_v4();
    let expired_token = "synthetic-expired-link";
    sqlx::query("INSERT INTO previsit_intake_packets(tenant_id,id,patient_id,template_id,template_version,template_snapshot,access_token_hash,due_at,issued_by,expires_at,created_at) VALUES($1,$2,$3,$4,1,$5,$6,now()-interval '1 day',$7,now()-interval '1 minute',now()-interval '31 days')")
        .bind(f.tenant).bind(expired).bind(other).bind(snapshot.0).bind(&snapshot.1).bind(format!("{:x}", Sha256::digest(expired_token.as_bytes()))).bind(f.user).execute(&f.db).await.unwrap();
    for action in ["read", "save", "submit"] {
        let body = match action {
            "read" => json!({"token":expired_token}),
            "save" => json!({"token":expired_token,"answers":{"first_name":"Late"}}),
            _ => submission(expired_token, standard_answers()),
        };
        assert_eq!(f.patient(action, body).await, closed, "{action}");
    }
    assert_eq!(f.status_of(expired).await, ("sent".to_owned(), 1));

    // A filled-in form cannot be cancelled, and once reviewed its link is closed too.
    let (status, body) = f
        .patient("submit", submission(&third_token, standard_answers()))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        f.staff(
            "POST",
            &format!("/api/v1/previsit/packets/{third}/cancel"),
            json!({"reason":"Too late"}),
            Some(2)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.staff(
            "POST",
            &format!("/api/v1/previsit/packets/{third}/review"),
            json!({}),
            Some(2)
        )
        .await
        .0,
        StatusCode::OK
    );
    for action in ["read", "save", "submit"] {
        let body = match action {
            "read" => json!({"token":third_token}),
            "save" => json!({"token":third_token,"answers":{}}),
            _ => submission(&third_token, standard_answers()),
        };
        assert_eq!(f.patient(action, body).await, closed, "reviewed {action}");
    }
    // A filled-in form is kept when a new link is sent.
    let (_, _, sent) = f.send(patient, json!({})).await;
    assert_eq!(sent["replaced"], 0);
    assert_eq!(f.status_of(third).await.0, "reviewed");

    // The chart list shows every form, with or without an appointment.
    let (status, list) = f
        .request(
            "GET",
            &format!("/api/v1/patients/{patient}/intake-packets"),
            true,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let statuses: Vec<&str> = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses, ["sent", "reviewed", "void", "void"]);
    // The counts say how many of the listed forms are cancelled.
    assert_eq!(
        list["summary"],
        json!({"total":4,"submitted":0,"reviewed":1,"cancelled":2})
    );
    assert!(list["items"][0]["appointment_id"].is_null());
    assert_eq!(list["items"][0]["expired"], false);
    assert_eq!(list["items"][0]["default_form"], true);
    let (_, list) = f
        .request(
            "GET",
            &format!("/api/v1/patients/{other}/intake-packets"),
            true,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(list["items"][0]["expired"], true);

    // Another practice cannot send to, or cancel for, this patient.
    assert_eq!(
        f.staff(
            "POST",
            &format!("/api/v1/patients/{}/intake-forms", Uuid::new_v4()),
            json!({}),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn appointment_forms_work_without_a_saved_form_and_can_be_resent() {
    let f = Fixture::new().await;
    let patient = f.add_patient().await;
    let other = f.add_patient().await;
    let soon = f
        .add_appointment(patient, Utc::now() + Duration::days(2))
        .await;
    let far = f
        .add_appointment(patient, Utc::now() + Duration::days(90))
        .await;
    let theirs = f
        .add_appointment(other, Utc::now() + Duration::days(3))
        .await;
    let issue = format!("/api/v1/appointments/{soon}/intake-packet");
    // The worklist route no longer needs a saved form.
    let (status, issued) = f.staff("POST", &issue, json!({}), None).await;
    assert_eq!(status, StatusCode::CREATED, "{issued}");
    assert!(issued["expires_at"].is_string());
    let first: Uuid = issued["packet_id"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        f.staff("POST", &issue, json!({}), None).await.0,
        StatusCode::CONFLICT
    );
    // Sending a new link for the same appointment replaces the open one.
    let (second, token, sent) = f.send(patient, json!({"appointment_id":soon})).await;
    assert_eq!(sent["replaced"], 1);
    assert_eq!(f.status_of(first).await.0, "void");
    let (_, form) = f.patient("read", json!({"token":token})).await;
    assert_eq!(form["appointment"]["title"], "Synthetic visit");
    let (_, ready) = f
        .request("GET", "/api/v1/previsit/readiness", true, None, None, None)
        .await;
    let rows: Vec<&Value> = ready["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["appointment_id"] == soon.to_string())
        .collect();
    assert_eq!(rows.len(), 1, "one worklist row per appointment: {ready}");
    assert_eq!(rows[0]["packet_id"], second.to_string());
    assert_eq!(rows[0]["status"], "sent");
    // A form for another appointment, or for none, leaves this appointment's link alone.
    let (loose, _, sent) = f.send(patient, json!({})).await;
    assert_eq!(sent["replaced"], 0);
    assert_eq!(f.status_of(second).await.0, "sent");
    let (for_far, _, sent) = f.send(patient, json!({"appointment_id":far})).await;
    assert_eq!(sent["replaced"], 1, "only the form with no appointment");
    assert_eq!(f.status_of(loose).await.0, "void");
    assert_eq!(f.status_of(second).await.0, "sent");
    let (_, _, sent) = f.send(patient, json!({})).await;
    assert_eq!(sent["replaced"], 0);
    assert_eq!(f.status_of(for_far).await.0, "sent");
    // An appointment must be this patient's.
    assert_eq!(
        f.staff(
            "POST",
            &format!("/api/v1/patients/{patient}/intake-forms"),
            json!({"appointment_id":theirs}),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.status_of(second).await.0,
        "sent",
        "a refused send cancels nothing"
    );
    // Once filled in, the appointment's form is kept and cannot be replaced.
    assert_eq!(
        f.patient("submit", submission(&token, standard_answers()))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        f.staff(
            "POST",
            &format!("/api/v1/patients/{patient}/intake-forms"),
            json!({"appointment_id":soon}),
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    // A link for a visit far ahead stays usable through that visit.
    let (_, _, sent) = f.send(patient, json!({"appointment_id":far})).await;
    let expires: DateTime<Utc> = sent["expires_at"].as_str().unwrap().parse().unwrap();
    assert!(expires > Utc::now() + Duration::days(90));
}

#[tokio::test]
async fn too_many_wrong_links_or_requests_are_slowed_down() {
    let f = Fixture::new().await;
    let patient = f.add_patient().await;
    let (_, token, _) = f.send(patient, json!({})).await;
    let read = |token: String, client: &'static str| {
        let f = &f;
        async move {
            f.request(
                "POST",
                "/api/public/v1/intake/read",
                false,
                Some(json!({"token":token})),
                None,
                Some(client),
            )
            .await
        }
    };
    // One client guessing links is stopped, for working links too.
    for attempt in 0..30 {
        let (status, _) = read(format!("guess-{attempt}"), "198.51.100.20").await;
        assert_eq!(status, StatusCode::NOT_FOUND, "attempt {attempt}");
    }
    let (status, body) = read("guess-again".into(), "198.51.100.20").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        body["message"],
        "Too many tries in a short time. Please wait a few minutes and try again."
    );
    assert_eq!(
        read(token.clone(), "198.51.100.20").await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    // Other patients are not affected.
    assert_eq!(read(token.clone(), "198.51.100.21").await.0, StatusCode::OK);
    // One link cannot be hammered, whoever is asking.
    for attempt in 1..120 {
        let client = if attempt % 2 == 0 {
            "198.51.100.22"
        } else {
            "198.51.100.23"
        };
        assert_eq!(
            read(token.clone(), client).await.0,
            StatusCode::OK,
            "attempt {attempt}"
        );
    }
    assert_eq!(
        read(token.clone(), "198.51.100.24").await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    // The window passes and the link works again.
    sqlx::query("UPDATE patient_portal_rate_limits SET window_started=now()-interval '16 minutes'")
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(read(token.clone(), "198.51.100.20").await.0, StatusCode::OK);

    // Visitors with no usable address share one bucket, which is never locked
    // out for dead links: one person cannot stop every other patient.
    let direct = |token: String| {
        let f = &f;
        async move {
            f.request(
                "POST",
                "/api/public/v1/intake/read",
                false,
                Some(json!({"token":token})),
                None,
                None,
            )
            .await
            .0
        }
    };
    for attempt in 0..35 {
        assert_eq!(
            direct(format!("guess-{attempt}")).await,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(direct(token.clone()).await, StatusCode::OK);
    // Behind a proxy the address it saw (the last hop) counts, whatever the caller put first.
    for attempt in 0..30 {
        read(format!("guess-{attempt}"), "198.51.100.30").await;
    }
    assert_eq!(
        read(token.clone(), "203.0.113.99, 198.51.100.30").await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        read(token.clone(), "198.51.100.30, 203.0.113.98").await.0,
        StatusCode::OK
    );
    // Cloudflare's visitor address wins when it is present.
    assert_eq!(
        read(token.clone(), "cf:198.51.100.30").await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    // Made-up header values never mint new counters, and IPv6 visitors count by network.
    let counters = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM patient_portal_rate_limits WHERE key LIKE 'intake:client:%'",
        )
        .fetch_one(&f.db)
        .await
        .unwrap()
    };
    let before = counters().await;
    for made_up in ["not-an-address-1", "not-an-address-2", "cf:zzz", "1.2.3"] {
        assert_eq!(read(token.clone(), made_up).await.0, StatusCode::OK);
    }
    assert_eq!(counters().await, before);
    for address in [
        "2001:db8:1:2::1",
        "2001:db8:1:2::ffff",
        "cf:2001:db8:1:2:9::7",
    ] {
        assert_eq!(read(token.clone(), address).await.0, StatusCode::OK);
    }
    assert_eq!(counters().await, before + 1);
    // Old counters are cleared away rather than kept.
    sqlx::query("UPDATE patient_portal_rate_limits SET window_started=now()-interval '31 minutes'")
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(direct(token.clone()).await, StatusCode::OK);
    assert_eq!(counters().await, 1);
}

#[test]
fn every_one_form_per_appointment_check_ignores_cancelled_forms() {
    // Booking workflows, the worklist and the chart all ask "does this
    // appointment already have a form?"; a cancelled form must never count.
    let check = "appointment_id=$2 AND workflow_instance_id IS NULL";
    for (name, source) in [
        ("previsit", include_str!("../src/previsit.rs")),
        (
            "workflow_dispatcher",
            include_str!("../src/workflow_dispatcher.rs"),
        ),
    ] {
        let found: Vec<&str> = source
            .match_indices(check)
            .map(|(at, _)| &source[at..at + check.len() + 20])
            .collect();
        assert!(!found.is_empty(), "{name}");
        for text in found {
            assert!(
                text.starts_with(&format!("{check} AND status<>'void'")),
                "{name}: {text}"
            );
        }
    }
}

#[tokio::test]
async fn progress_is_saved_resumed_and_cleared_when_the_form_is_sent() {
    let f = Fixture::new().await;
    let patient = f.add_patient().await;
    let (packet, token, _) = f.send(patient, json!({})).await;
    let (status, saved) = f
        .patient(
            "save",
            json!({"token":token,"answers":{"first_name":"Synthetic","phone":"555"}}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["status"], "in_progress");
    // Nothing is required while saving, and saving does not change the version staff act on.
    assert_eq!(f.status_of(packet).await, ("in_progress".to_owned(), 1));
    let (status, _) = f.patient("save", json!({"token":token,"answers":{"first_name":"Synthetic","last_name":"Sample","payment_method":"Self-pay"}})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, form) = f.patient("read", json!({"token":token})).await;
    assert_eq!(form["status"], "in_progress");
    assert_eq!(
        form["draft"],
        json!({"first_name":"Synthetic","last_name":"Sample","payment_method":"Self-pay"})
    );
    assert!(form["draft_saved_at"].is_string());
    let events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM previsit_events WHERE packet_id=$1 AND action='intake_saved'",
    )
    .bind(packet)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(events, 1, "saving is logged at most once every few minutes");
    for bad in [
        json!({"unknown_question":"x"}),
        json!({"first_name":7}),
        json!({"state":"Texas"}),
        json!({"first_name":"x".repeat(101)}),
        json!(["not", "an", "object"]),
    ] {
        assert_eq!(
            f.patient("save", json!({"token":token,"answers":bad}))
                .await
                .0,
            StatusCode::BAD_REQUEST,
            "{bad}"
        );
    }
    // Staff see that the patient has started.
    let (_, list) = f
        .request(
            "GET",
            &format!("/api/v1/patients/{patient}/intake-packets"),
            true,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(list["items"][0]["status"], "in_progress");
    assert!(list["items"][0]["started_at"].is_string());
    assert!(
        list["items"][0].get("draft").is_none(),
        "the list never carries answers"
    );

    // Sending checks the whole form in plain words.
    let mut bad = standard_answers();
    bad["zip"] = json!("7500");
    let (status, body) = f.patient("submit", submission(&token, bad)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body["message"],
        "Please check your phone numbers, email addresses, ZIP code and dates."
    );
    let mut bad = standard_answers();
    bad["insurance_relationship"] = json!("Spouse");
    assert_eq!(
        f.patient("submit", submission(&token, bad)).await.0,
        StatusCode::BAD_REQUEST,
        "a policy holder other than the patient must be named"
    );
    let mut second = standard_answers();
    second["insurance2_plan"] = json!("Started but no company");
    assert_eq!(
        f.patient("submit", submission(&token, second)).await.0,
        StatusCode::BAD_REQUEST
    );
    // A second insurance needs its member ID and policy holder only once a company is given.
    let mut second = standard_answers();
    second["insurance2_company"] = json!("Example Second Plan");
    assert_eq!(
        f.patient("submit", submission(&token, second.clone()))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    second["insurance2_member_id"] = json!("SYN-2");
    assert_eq!(
        f.patient("submit", submission(&token, second.clone()))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    second["insurance2_relationship"] = json!("Self");
    assert_eq!(
        f.patient("submit", submission(&token, second)).await.0,
        StatusCode::OK
    );
    // Self-pay: the insurance steps are not shown, not required and not kept.
    let mut self_pay = standard_answers();
    self_pay["payment_method"] = json!("Self-pay");
    let (status, body) = f.patient("submit", submission(&token, self_pay)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["version"], 3);
    let (response, draft, saved_at): (Value, Option<Value>, Option<DateTime<Utc>>) = sqlx::query_as("SELECT (SELECT response FROM previsit_intake_responses r WHERE r.packet_id=p.id ORDER BY version DESC LIMIT 1),draft,draft_saved_at FROM previsit_intake_packets p WHERE id=$1").bind(packet).fetch_one(&f.db).await.unwrap();
    assert!(draft.is_none() && saved_at.is_none());
    assert!(response.get("insurance_company").is_none());
    assert_eq!(response["payment_method"], "Self-pay");
    assert_eq!(
        f.patient(
            "save",
            json!({"token":token,"answers":{"first_name":"Later"}})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, form) = f.patient("read", json!({"token":token})).await;
    assert_eq!(form["status"], "submitted");
    assert!(form["draft"].is_null());
}

#[tokio::test]
async fn reviewed_answers_reach_the_chart_only_where_staff_chose() {
    let f = Fixture::new().await;
    let patient = f.add_patient().await;
    sqlx::query("INSERT INTO patient_demographics(tenant_id,patient_id,version,content) VALUES($1,$2,1,$3)")
        .bind(f.tenant).bind(patient).bind(json!({"phone":"+1 555 010 0000","pronouns":"they/them","address":{"line1":"1 Old Road","city":"Oldtown"}})).execute(&f.db).await.unwrap();
    let (packet, token, _) = f.send(patient, json!({})).await;
    let mut answers = standard_answers();
    // "Other" stands for what the patient wrote beside it.
    answers["emergency_relationship"] = json!("Other");
    answers["emergency_relationship_other"] = json!("Neighbour");
    assert_eq!(
        f.patient("submit", submission(&token, answers)).await.0,
        StatusCode::OK
    );
    let promote = format!("/api/v1/previsit/packets/{packet}/demographics");
    let chosen = json!([
        "sex",
        "preferred_language",
        "email",
        "city",
        "state",
        "zip",
        "emergency_name",
        "emergency_relationship",
        "emergency_phone"
    ]);
    let body = |fields: Value| json!({"fields":fields,"demographics_version":1,"reason":"Checked with the patient at the desk"});
    // Nothing is copied before the form is reviewed.
    assert_eq!(
        f.staff("POST", &promote, body(chosen.clone()), Some(2))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.staff(
            "POST",
            &format!("/api/v1/previsit/packets/{packet}/review"),
            json!({}),
            Some(2)
        )
        .await
        .0,
        StatusCode::OK
    );
    // Name and date of birth are for comparison only; other answers stay on the form.
    for key in [
        "first_name",
        "last_name",
        "date_of_birth",
        "race",
        "pharmacy_name",
        "insurance_member_id",
    ] {
        assert_eq!(
            f.staff("POST", &promote, body(json!([key])), Some(3))
                .await
                .0,
            StatusCode::BAD_REQUEST,
            "{key}"
        );
    }
    let (status, saved) = f.staff("POST", &promote, body(chosen), Some(3)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["version"], 2);
    assert_eq!(
        saved["content"],
        json!({
            "preferred_name":null,
            "pronouns":"they/them",
            "language":"English",
            "administrative_gender":"female",
            // Not selected, so the chart's own values stay.
            "phone":"+1 555 010 0000",
            "email":"synthetic.sample@example.test",
            "address":{"line1":"1 Old Road","line2":null,"city":"Sampleville","region":"TX","postal_code":"75001","country":"US"},
            "emergency_contact":{"name":"Example Contact","relationship":"Neighbour","phone":"555-010-3030"}
        })
    );
    let (history, reason): (i64, String) = sqlx::query_as("SELECT version,reason FROM patient_demographics_history WHERE patient_id=$1 ORDER BY version DESC LIMIT 1").bind(patient).fetch_one(&f.db).await.unwrap();
    assert_eq!(history, 2);
    assert!(
        reason.contains("Checked with the patient at the desk")
            && reason.contains(&packet.to_string())
    );
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action IN('patient.demographics_update','previsit.demographics_promoted')").bind(f.tenant).fetch_one(&f.db).await.unwrap();
    assert_eq!(audits, 2);
    let event: Value = sqlx::query_scalar("SELECT details FROM previsit_events WHERE packet_id=$1 AND action='intake_demographics_promoted'").bind(packet).fetch_one(&f.db).await.unwrap();
    assert_eq!(event["demographics_version"], 2);
    // A stale chart version is refused rather than overwritten.
    assert_eq!(
        f.staff("POST", &promote, body(json!(["phone"])), Some(3))
            .await
            .0,
        StatusCode::CONFLICT
    );
    // Patient identity was never touched.
    let identity: (String, String) =
        sqlx::query_as("SELECT given_name,family_name FROM patients WHERE id=$1")
            .bind(patient)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(identity, ("Synthetic".to_owned(), "Sample".to_owned()));
}

#[tokio::test]
async fn forms_issued_before_this_change_still_open_save_and_submit() {
    let f = Fixture::new().await;
    let patient = f.add_patient().await;
    let appointment = f
        .add_appointment(patient, Utc::now() + Duration::days(1))
        .await;
    // Exactly what an existing row looks like: an older single-page form, an
    // appointment, and none of the new columns set.
    let old = json!({"attestation":"I confirm these synthetic answers.","sections":[{"label":"Patient details","fields":[{"key":"insurance_plan","label":"Insurance plan","type":"text","required":true},{"key":"functional_status","label":"Functional status","type":"textarea","required":false},{"key":"consent","label":"Consent","type":"checkbox","required":true}]}]});
    assert_eq!(
        f.save_template(old.clone(), 0, None).await,
        StatusCode::CREATED
    );
    let template: Uuid = sqlx::query_scalar("SELECT id FROM previsit_intake_templates")
        .fetch_one(&f.db)
        .await
        .unwrap();
    let packet = Uuid::new_v4();
    let token = "synthetic-older-link";
    sqlx::query("INSERT INTO previsit_intake_packets(tenant_id,id,appointment_id,patient_id,template_id,template_version,template_snapshot,access_token_hash,due_at,issued_by) VALUES($1,$2,$3,$4,$5,1,$6,$7,now()+interval '1 day',$8)")
        .bind(f.tenant).bind(packet).bind(appointment).bind(patient).bind(template).bind(&old).bind(format!("{:x}", Sha256::digest(token.as_bytes()))).bind(f.user).execute(&f.db).await.unwrap();
    let (status, form) = f.patient("read", json!({"token":token})).await;
    assert_eq!(status, StatusCode::OK, "{form}");
    assert_eq!(form["template"], old);
    assert!(form["expires_at"].is_null() && form["draft"].is_null());
    assert_eq!(form["appointment"]["title"], "Synthetic visit");
    assert_eq!(
        f.patient(
            "save",
            json!({"token":token,"answers":{"insurance_plan":"Synthetic Plan"}})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.patient(
            "submit",
            submission(
                token,
                json!({"insurance_plan":"Synthetic Plan","consent":false})
            )
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let answers = json!({"insurance_plan":"Synthetic Plan","functional_status":"","consent":true});
    let (status, body) = f
        .patient("submit", submission(token, answers.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["version"], 2);
    let stored: Value =
        sqlx::query_scalar("SELECT response FROM previsit_intake_responses WHERE packet_id=$1")
            .bind(packet)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(stored, answers, "older forms are stored exactly as sent");
    // The chart list still shows the form with its appointment.
    let (_, list) = f
        .request(
            "GET",
            &format!("/api/v1/patients/{patient}/intake-packets"),
            true,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(list["items"][0]["appointment_title"], "Synthetic visit");
    assert_eq!(list["items"][0]["expired"], false);
}

#[tokio::test]
async fn pick_lists_need_a_working_link_and_return_only_names() {
    let f = Fixture::new().await;
    let patient = f.add_patient().await;
    let (packet, token, _) = f.send(patient, json!({})).await;
    let other_tenant = Uuid::new_v4();
    for (tenant, name, active) in [
        (f.tenant, "Example Health Plan", true),
        (f.tenant, "Example Closed Plan", false),
        (f.tenant, "Zeta Mutual", true),
        (other_tenant, "Example Other Practice Plan", true),
    ] {
        sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,'synthetic')")
            .bind(tenant).bind(Uuid::new_v4()).bind(json!({"name":name,"payer_code":"SYN-CODE","phone":"555-010-9999","address":"1 Private Lane","active":active})).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    }
    // Insurers the practice already looked up in its clearinghouse directory.
    sqlx::query("INSERT INTO claimmd_payer_directory_snapshots(tenant_id,id,route_key,query,response,actor_id) VALUES($1,$2,'synthetic',$3,$4,$5)")
        .bind(f.tenant).bind(Uuid::new_v4()).bind(json!({"name":"example"})).bind(json!({"payer":[{"payerid":"EX123","payer_name":"Example Mutual","payer_state":"TX","eligibility":"yes"},{"payerid":"EX999","payer_name":"Example Health Plan"},{"payerid":"bad id!","payer_name":"Example Broken"}]})).bind(f.user).execute(&f.db).await.unwrap();
    for (name, active) in [("Example Pharmacy", true), ("Example Old Pharmacy", false)] {
        sqlx::query("INSERT INTO prescribing_pharmacies(tenant_id,id,content,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5)")
            .bind(f.tenant).bind(Uuid::new_v4()).bind(json!({"name":name,"address":"1 Example Street\nSampleville","phone":"555-010-7777","ncpdp_id":"1234567","npi":""})).bind(active).bind(f.user).execute(&f.db).await.unwrap();
    }
    let ask = |token: &str, kind: &str, query: &str| {
        let body = json!({"token":token,"kind":kind,"query":query});
        let f = &f;
        async move { f.patient("lookup", body).await }
    };
    let (status, found) = ask(&token, "insurer", "exam").await;
    assert_eq!(status, StatusCode::OK, "{found}");
    let items = found["items"].as_array().unwrap();
    let names: Vec<&str> = items
        .iter()
        .map(|item| item["name"].as_str().unwrap())
        .collect();
    // The practice's own companies first, then ones it has looked up; no closed or foreign ones.
    assert_eq!(names, ["Example Health Plan", "Example Mutual"]);
    assert_eq!(items[1]["id"], "claimmd:EX123");
    assert!(items[0]["id"].as_str().unwrap().parse::<Uuid>().is_ok());
    for item in items {
        let keys: Vec<&String> = item.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "name"], "only a name and a reference: {item}");
    }
    let text = found.to_string();
    for private in [
        "SYN-CODE",
        "555-010",
        "Private Lane",
        "payer_state",
        "eligibility",
    ] {
        assert!(!text.contains(private), "{private}");
    }
    // Well-known insurers follow the practice's own, by name only, without repeating one the practice has.
    sqlx::query("INSERT INTO ehr_payers(tenant_id,id,content,request_id,creation_hash) VALUES($1,$2,$3,$4,'synthetic')")
        .bind(f.tenant).bind(Uuid::new_v4()).bind(json!({"name":"AETNA","payer_code":"","phone":"","address":"","active":true})).bind(Uuid::new_v4()).execute(&f.db).await.unwrap();
    let (_, found) = ask(&token, "insurer", "aetna").await;
    let items = found["items"].as_array().unwrap();
    assert_eq!(items[0]["name"], "AETNA");
    assert!(items[0]["id"].is_string());
    let rest: Vec<&str> = items[1..]
        .iter()
        .map(|item| item["name"].as_str().unwrap())
        .collect();
    assert_eq!(rest, ["Aetna Medicare", "Aetna Better Health"]);
    assert!(items[1..].iter().all(|item| item.get("id").is_none()));
    let (_, found) = ask(&token, "insurer", "horizon").await;
    assert_eq!(
        found["items"],
        json!([{"name":"Horizon Blue Cross Blue Shield of New Jersey"}])
    );
    let (_, found) = ask(&token, "insurer", "blue").await;
    assert_eq!(
        found["items"].as_array().unwrap().len(),
        10,
        "never more than ten"
    );
    assert_eq!(found["items"][0]["name"], "Blue Cross Blue Shield");
    let (_, found) = ask(&token, "pharmacy", "example").await;
    assert_eq!(
        found["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["Example Pharmacy, 1 Example Street Sampleville"]
    );
    assert!(!found.to_string().contains("1234567") && !found.to_string().contains("555-010"));
    // Too little to search on returns nothing; wildcards are plain text.
    for query in ["", "e", "%%", "__"] {
        assert_eq!(
            ask(&token, "insurer", query).await.1,
            json!({"items":[]}),
            "{query}"
        );
    }
    assert_eq!(
        ask(&token, "patients", "example").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        ask(&token, "insurer", &"x".repeat(81)).await.0,
        StatusCode::BAD_REQUEST
    );
    // A wrong link gets the usual closed answer and no names; a link is always required.
    let closed = (
        StatusCode::NOT_FOUND,
        json!({"error":"not_found","message":CLOSED}),
    );
    assert_eq!(ask("not-a-real-link", "insurer", "exam").await, closed);
    let (status, body) = f
        .patient("lookup", json!({"kind":"insurer","query":"exam"}))
        .await;
    assert!(status.is_client_error() && body.get("items").is_none());
    // One link cannot be used to page through the list at speed.
    sqlx::query("UPDATE patient_portal_rate_limits SET attempts=240 WHERE key=$1")
        .bind(format!("intake:lookup:{packet}"))
        .execute(&f.db)
        .await
        .unwrap();
    let (status, body) = ask(&token, "insurer", "exam").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(body.get("items").is_none());
    sqlx::query("DELETE FROM patient_portal_rate_limits")
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        f.staff(
            "POST",
            &format!("/api/v1/previsit/packets/{packet}/cancel"),
            json!({"reason":"Synthetic cancel"}),
            Some(1)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(ask(&token, "insurer", "exam").await, closed);
    // Looking up names never writes to the form or its history.
    let events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM previsit_events WHERE packet_id=$1 AND action NOT IN('intake_packet_issued','intake_packet_cancelled')",
    )
    .bind(packet)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(events, 0);
}
