// SPDX-License-Identifier: AGPL-3.0-only
//! Who may draft, sign and correct a visit note. Synthetic people and records only.
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
    backend::ClinicalBackend,
    browser::BrowserAuth,
    model::StartVisit,
    postgres::PostgresBackend,
    State,
};
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &str = "synthetic-note-permissions-secret";
const ORIGIN: &str = "http://127.0.0.1:8097";

struct Practice {
    db: PgPool,
    app: Router,
    tenant: Uuid,
    doctor: Actor,
    peer: Actor,
    owner: Actor,
    nurse: Actor,
    assistant: Actor,
    desk: Actor,
    readonly: Actor,
    patient: Uuid,
}

fn actor(tenant_id: Uuid, role: Role) -> Actor {
    let now = Utc::now().timestamp();
    Actor {
        sub: Uuid::new_v4(),
        tenant_id,
        role,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    }
}
async fn staff(db: &PgPool, tenant: Uuid, role: Role, key: &str, name: &str) -> Actor {
    let a = actor(tenant, role);
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,display_name,role) VALUES($1,$2,$3,'synthetic-not-a-login',$4,$5)")
        .bind(tenant)
        .bind(a.sub)
        .bind(format!("{key}-{}@example.test", a.sub.simple()))
        .bind(name)
        .bind(key)
        .execute(db)
        .await
        .unwrap();
    a
}
async fn setup() -> Practice {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("note_permissions_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
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
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let tenant = Uuid::new_v4();
    let doctor = staff(
        &db,
        tenant,
        Role::Clinician,
        "clinician",
        "Dr. Avery Assigned",
    )
    .await;
    let peer = staff(
        &db,
        tenant,
        Role::Clinician,
        "clinician",
        "Dr. Casey Covering",
    )
    .await;
    let owner = staff(&db, tenant, Role::Owner, "owner", "Dr. Olive Owner").await;
    let nurse = staff(&db, tenant, Role::Nurse, "nurse", "Nico Nurse").await;
    let assistant = staff(
        &db,
        tenant,
        Role::MedicalAssistant,
        "medical_assistant",
        "Morgan Assistant",
    )
    .await;
    let desk = staff(&db, tenant, Role::FrontDesk, "front_desk", "Frankie Desk").await;
    let readonly = staff(&db, tenant, Role::ReadOnly, "read_only", "Robin Reader").await;
    let patient = Uuid::new_v4();
    sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,'SYN-NOTE-RULES','Avery','Synthetic','1990-01-01')")
        .bind(tenant)
        .bind(patient)
        .execute(&db)
        .await
        .unwrap();
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
    });
    Practice {
        db,
        app,
        tenant,
        doctor,
        peer,
        owner,
        nurse,
        assistant,
        desk,
        readonly,
        patient,
    }
}
impl Practice {
    /// A visit assigned to the doctor, started on the given synthetic day.
    async fn visit(&self, day: u8) -> Value {
        let appointment = Uuid::new_v4();
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5::timestamptz,$5::timestamptz+interval '30 minutes','checked_in')")
            .bind(self.tenant)
            .bind(appointment)
            .bind(self.patient)
            .bind(self.doctor.sub)
            .bind(format!("2026-11-{day:02}T15:00:00Z"))
            .execute(&self.db)
            .await
            .unwrap();
        let visit = PostgresBackend(self.db.clone())
            .start_visit(
                &self.doctor,
                StartVisit {
                    appointment_id: appointment,
                },
            )
            .await
            .unwrap();
        serde_json::to_value(visit).unwrap()
    }
    async fn call(
        &self,
        who: &Actor,
        method: &str,
        path: &str,
        body: Value,
        version: Option<i64>,
    ) -> (StatusCode, Value) {
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            who,
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("Authorization", format!("Bearer {token}"))
            .header("Origin", ORIGIN);
        if let Some(version) = version {
            request = request.header("If-Match", format!("\"{version}\""));
        }
        let request = if body.is_null() {
            request.body(Body::empty()).unwrap()
        } else {
            request
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    async fn save(&self, who: &Actor, visit: &Value, note: Value) -> (StatusCode, Value) {
        self.call(
            who,
            "PUT",
            &format!("/api/v1/visits/{}/note", text(&visit["id"])),
            note,
            visit["version"].as_i64(),
        )
        .await
    }
    async fn sign(&self, who: &Actor, visit: &Value) -> (StatusCode, Value) {
        self.call(
            who,
            "POST",
            &format!("/api/v1/visits/{}/sign", text(&visit["id"])),
            Value::Null,
            visit["version"].as_i64(),
        )
        .await
    }
    async fn amend(&self, who: &Actor, visit: &Value, words: &str) -> (StatusCode, Value) {
        self.call(
            who,
            "POST",
            &format!("/api/v1/visits/{}/amendments", text(&visit["id"])),
            json!({"reason":"Synthetic correction","text":words}),
            visit["version"].as_i64(),
        )
        .await
    }
    async fn previous(&self, who: &Actor, visit: &Value) -> (StatusCode, Value) {
        self.call(
            who,
            "GET",
            &format!("/api/v1/visits/{}/previous-note", text(&visit["id"])),
            Value::Null,
            None,
        )
        .await
    }
    async fn authorship(&self, who: &Actor, visit: &Value) -> Value {
        let (status, data) = self
            .call(
                who,
                "GET",
                &format!("/api/v1/visits/{}/note-authorship", text(&visit["id"])),
                Value::Null,
                None,
            )
            .await;
        assert_eq!(status, 200, "{data}");
        data
    }
    async fn diagnoses(&self, who: &Actor, visit: &Value) -> (StatusCode, Value) {
        self.call(
            who,
            "PUT",
            &format!("/api/v1/visits/{}/diagnoses", text(&visit["id"])),
            json!({"diagnoses":[{"code":"R51.9","display":"Synthetic headache"}],"reason":"Synthetic assessment"}),
            visit["version"].as_i64(),
        )
        .await
    }
    async fn audited(&self, action: &str, visit: &Value) -> Vec<Uuid> {
        sqlx::query_scalar(
            "SELECT actor_id FROM audit_events WHERE tenant_id=$1 AND action=$2 AND resource_id=$3 ORDER BY id",
        )
        .bind(self.tenant)
        .bind(action)
        .bind(Uuid::parse_str(text(&visit["id"])).unwrap())
        .fetch_all(&self.db)
        .await
        .unwrap()
    }
    /// A support session as Connect delegation creates it: the Owner role, with the
    /// grant as the actor and no staff account.
    async fn support(&self, subject: &str) -> Actor {
        let session = actor(self.tenant, Role::Owner);
        sqlx::query("INSERT INTO partner_support_sessions(token_hash,tenant_id,grant_id,partner_id,customer_id,order_id,issuer,audience,expires_at,actor_subject,delegated_role) VALUES($1,$2,$3,$4,$5,$6,'https://connect.example.test','https://ehr.example.test',now()+interval '10 minutes',$7,'partner_admin')")
            .bind(format!("synthetic-{}", session.sub.simple()))
            .bind(self.tenant)
            .bind(session.sub)
            .bind(Uuid::new_v4())
            .bind(Uuid::new_v4())
            .bind(Uuid::new_v4())
            .bind(subject)
            .execute(&self.db)
            .await
            .unwrap();
        session
    }
}
fn text(value: &Value) -> &str {
    value.as_str().unwrap()
}
fn soap(subjective: &str) -> Value {
    json!({"subjective":subjective,"objective":"Well appearing","assessment":"Routine follow-up","plan":"Return in four weeks"})
}
/// The text sections of a returned note, without the record of who saved it.
fn sections(note: &Value) -> Value {
    let mut note = note.clone();
    note.as_object_mut().unwrap().remove("saved_by");
    note
}

#[tokio::test]
async fn clinical_staff_share_drafting_and_every_save_names_its_writer() {
    let f = setup().await;
    // An earlier signed note, so "Same as last visit" has something to offer.
    let earlier = f.visit(3).await;
    let (_, earlier) = f.save(&f.doctor, &earlier, soap("Earlier visit")).await;
    assert_eq!(f.sign(&f.doctor, &earlier).await.0, 200);

    let mut visit = f.visit(10).await;
    for (who, name) in [
        (&f.doctor, "Dr. Avery Assigned"),
        (&f.peer, "Dr. Casey Covering"),
        (&f.owner, "Dr. Olive Owner"),
        (&f.nurse, "Nico Nurse"),
        (&f.assistant, "Morgan Assistant"),
    ] {
        let before = Utc::now();
        let written = soap(&format!("Drafted by {name}"));
        let (status, saved) = f.save(who, &visit, written.clone()).await;
        assert_eq!(status, 200, "{name}: {saved}");
        assert_eq!(sections(&saved["note"]), written);
        assert_eq!(saved["note"]["saved_by"]["id"], who.sub.to_string());
        assert_eq!(saved["note"]["saved_by"]["name"], name);
        assert!(saved["note"]["saved_by"].get("support").is_none());
        let at: chrono::DateTime<Utc> =
            serde_json::from_value(saved["note"]["saved_by"]["at"].clone()).unwrap();
        assert!(at >= before - chrono::Duration::seconds(1) && at <= Utc::now());
        // Drafting never changes who the visit is assigned to.
        assert_eq!(saved["clinician_id"], f.doctor.sub.to_string());
        assert_eq!(saved["status"], "in_progress");
        assert_eq!(
            f.audited("visit.note_save", &saved).await.last(),
            Some(&who.sub)
        );
        let seen = f.authorship(who, &saved).await;
        assert_eq!(seen["can_draft"], true, "{name}");
        assert_eq!(seen["last_saved"]["name"], name);
        assert_eq!(seen["assigned"]["name"], "Dr. Avery Assigned");
        assert_eq!(seen["is_assigned"], who.sub == f.doctor.sub);
        let (status, found) = f.previous(who, &saved).await;
        assert_eq!(status, 200, "{name}: {found}");
        assert_eq!(found["source"]["note"]["subjective"], "Earlier visit");
        assert_eq!(found["source"]["own"], who.sub == f.doctor.sub);
        let (status, coded) = f.diagnoses(who, &saved).await;
        assert_eq!(status, 200, "{name}: {coded}");
        assert_eq!(coded["history"][0]["actor_id"], who.sub.to_string());
        visit = coded["visit"].clone();
    }
    // Four of the five writers were not the assigned clinician; each is on record.
    assert_eq!(
        f.audited("visit.note_save_for_assigned", &visit).await,
        [f.peer.sub, f.owner.sub, f.nurse.sub, f.assistant.sub]
    );

    // Front desk and read-only staff read the note but cannot write it.
    let stored = visit["note"].clone();
    for who in [&f.desk, &f.readonly] {
        assert_eq!(f.save(who, &visit, soap("Not allowed")).await.0, 403);
        assert_eq!(f.previous(who, &visit).await.0, 403);
        assert_eq!(f.diagnoses(who, &visit).await.0, 403);
        let seen = f.authorship(who, &visit).await;
        assert_eq!(seen["can_draft"], false);
        assert_eq!(seen["can_sign"], false);
        assert_eq!(seen["last_saved"]["name"], "Morgan Assistant");
        let (status, read) = f
            .call(
                who,
                "GET",
                &format!("/api/v1/visits/{}", text(&visit["id"])),
                Value::Null,
                None,
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(read["note"], stored);
    }
    // A disabled assistant with a still-valid credential cannot keep writing.
    sqlx::query("UPDATE browser_users SET disabled=true WHERE tenant_id=$1 AND id=$2")
        .bind(f.tenant)
        .bind(f.assistant.sub)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        f.save(&f.assistant, &visit, soap("Not allowed")).await.0,
        403
    );
    assert_eq!(f.previous(&f.assistant, &visit).await.0, 403);
    assert_eq!(f.authorship(&f.assistant, &visit).await["can_draft"], false);
    // Patients and other practices never reach the note.
    let mut patient = actor(f.tenant, Role::Patient);
    patient.patient_id = Some(f.patient);
    assert_eq!(f.save(&patient, &visit, soap("Not allowed")).await.0, 403);
    assert_eq!(f.previous(&patient, &visit).await.0, 403);
    let outsider = actor(Uuid::new_v4(), Role::Clinician);
    assert_eq!(f.save(&outsider, &visit, soap("Not allowed")).await.0, 404);
    assert_eq!(f.previous(&outsider, &visit).await.0, 404);
    let (status, _) = f
        .call(
            &outsider,
            "GET",
            &format!("/api/v1/visits/{}/note-authorship", text(&visit["id"])),
            Value::Null,
            None,
        )
        .await;
    assert_eq!(status, 404);
    let (_, unchanged) = f
        .call(
            &f.doctor,
            "GET",
            &format!("/api/v1/visits/{}", text(&visit["id"])),
            Value::Null,
            None,
        )
        .await;
    assert_eq!(unchanged["note"], stored);
    assert_eq!(unchanged["version"], visit["version"]);
}

#[tokio::test]
async fn a_covering_clinician_or_the_owner_signs_as_themselves_and_the_visit_stays_assigned() {
    let f = setup().await;
    for (signer, name, day) in [
        (&f.peer, "Dr. Casey Covering", 10u8),
        (&f.owner, "Dr. Olive Owner", 11),
    ] {
        let visit = f.visit(day).await;
        let appointment = Uuid::parse_str(text(&visit["appointment_id"])).unwrap();
        let (status, drafted) = f.save(signer, &visit, soap("Covering visit")).await;
        assert_eq!(status, 200, "{drafted}");
        let before = f.authorship(signer, &drafted).await;
        assert_eq!(before["can_sign"], true);
        assert_eq!(before["is_assigned"], false);
        let (status, signed) = f.sign(signer, &drafted).await;
        assert_eq!(status, 200, "{signed}");
        assert_eq!(signed["status"], "signed");
        // The signature names the person who actually signed.
        assert_eq!(signed["signed_by"], signer.sub.to_string());
        // The visit and its appointment stay with the assigned clinician for billing.
        assert_eq!(signed["clinician_id"], f.doctor.sub.to_string());
        let booked: Uuid = sqlx::query_scalar(
            "SELECT clinician_id FROM appointments WHERE tenant_id=$1 AND id=$2",
        )
        .bind(f.tenant)
        .bind(appointment)
        .fetch_one(&f.db)
        .await
        .unwrap();
        assert_eq!(booked, f.doctor.sub);
        assert_eq!(f.audited("visit.sign", &signed).await, [signer.sub]);
        assert_eq!(
            f.audited("visit.sign_for_assigned", &signed).await,
            [signer.sub]
        );
        let seen = f.authorship(&f.desk, &signed).await;
        assert_eq!(seen["signed"]["id"], signer.sub.to_string());
        assert_eq!(seen["signed"]["name"], name);
        assert_eq!(seen["assigned"]["id"], f.doctor.sub.to_string());
        assert_eq!(seen["assigned"]["name"], "Dr. Avery Assigned");
        assert_eq!(seen["can_sign"], false);

        // Whoever may sign also releases and publishes the patient summary.
        let checkout = format!(
            "/api/v1/patients/{}/visits/{}/checkout",
            f.patient,
            text(&signed["id"])
        );
        let (status, preview) = f.call(signer, "GET", &checkout, Value::Null, None).await;
        assert_eq!(status, 200, "{preview}");
        // The summary names who saw the patient when that is not the assigned clinician.
        assert_eq!(
            preview["preview_snapshot"]["visit"]["signed_by_label"],
            name
        );
        let release = json!({"action":"release_avs","instructions":"Synthetic patient instructions.","follow_up_instructions":"Return in two weeks.","reason":"Synthetic clinician review","reviewed":true,"reviewed_snapshot_digest":preview["preview_digest"]});
        for refused in [&f.nurse, &f.assistant, &f.desk] {
            let (status, _) = f
                .call(
                    refused,
                    "POST",
                    &format!("{checkout}/actions"),
                    release.clone(),
                    Some(0),
                )
                .await;
            assert_eq!(status, 403);
        }
        let (status, released) = f
            .call(
                signer,
                "POST",
                &format!("{checkout}/actions"),
                release,
                Some(0),
            )
            .await;
        assert_eq!(status, 200, "{released}");
        let by: Uuid = sqlx::query_scalar(
            "SELECT released_by FROM avs_releases WHERE tenant_id=$1 AND visit_id=$2",
        )
        .bind(f.tenant)
        .bind(Uuid::parse_str(text(&signed["id"])).unwrap())
        .fetch_one(&f.db)
        .await
        .unwrap();
        assert_eq!(by, signer.sub);
        let publish = format!(
            "/api/v1/patients/{}/portal/avs/{}",
            f.patient,
            text(&signed["id"])
        );
        let body = json!({"avs_version":1,"visible":true,"reason":"Synthetic publication review"});
        let (status, _) = f
            .call(&f.nurse, "POST", &publish, body.clone(), Some(0))
            .await;
        assert_eq!(status, 403);
        let (status, published) = f.call(signer, "POST", &publish, body, Some(0)).await;
        assert_eq!(status, 200, "{published}");
        assert_eq!(published["visible"], true);
    }
    // The assigned clinician signing their own visit leaves no covering record.
    let own = f.visit(12).await;
    let (_, drafted) = f.save(&f.doctor, &own, soap("Own visit")).await;
    let (status, signed) = f.sign(&f.doctor, &drafted).await;
    assert_eq!(status, 200, "{signed}");
    assert_eq!(signed["signed_by"], f.doctor.sub.to_string());
    assert!(f
        .audited("visit.sign_for_assigned", &signed)
        .await
        .is_empty());
    let (_, preview) = f
        .call(
            &f.doctor,
            "GET",
            &format!(
                "/api/v1/patients/{}/visits/{}/checkout",
                f.patient,
                text(&signed["id"])
            ),
            Value::Null,
            None,
        )
        .await;
    assert!(preview["preview_snapshot"]["visit"]["signed_by_label"].is_null());
    assert!(f
        .audited("visit.note_save_for_assigned", &signed)
        .await
        .is_empty());
}

#[tokio::test]
async fn nurses_and_medical_assistants_draft_but_never_sign_or_amend() {
    let f = setup().await;
    let visit = f.visit(10).await;
    let (status, drafted) = f
        .save(&f.assistant, &visit, soap("Drafted for the doctor"))
        .await;
    assert_eq!(status, 200, "{drafted}");
    for who in [&f.nurse, &f.assistant, &f.desk, &f.readonly] {
        assert_eq!(f.sign(who, &drafted).await.0, 403);
        let seen = f.authorship(who, &drafted).await;
        assert_eq!(seen["can_sign"], false);
        assert_eq!(seen["can_amend"], false);
    }
    let (_, still) = f
        .call(
            &f.doctor,
            "GET",
            &format!("/api/v1/visits/{}", text(&drafted["id"])),
            Value::Null,
            None,
        )
        .await;
    assert_eq!(still["status"], "in_progress");
    assert!(still["signed_by"].is_null());
    // The assigned clinician signs what the assistant drafted; both are on record.
    let (status, signed) = f.sign(&f.doctor, &still).await;
    assert_eq!(status, 200, "{signed}");
    assert_eq!(signed["signed_by"], f.doctor.sub.to_string());
    assert_eq!(
        signed["note"]["saved_by"]["id"],
        f.assistant.sub.to_string()
    );
    assert_eq!(signed["note"]["saved_by"]["name"], "Morgan Assistant");
    for who in [&f.nurse, &f.assistant, &f.desk, &f.readonly] {
        assert_eq!(f.amend(who, &signed, "Not allowed").await.0, 403);
        assert_eq!(f.authorship(who, &signed).await["can_amend"], false);
    }
    let amendments: i64 =
        sqlx::query_scalar("SELECT count(*) FROM amendments WHERE tenant_id=$1 AND visit_id=$2")
            .bind(f.tenant)
            .bind(Uuid::parse_str(text(&signed["id"])).unwrap())
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(amendments, 0);
}

#[tokio::test]
async fn any_clinician_or_the_owner_amends_and_a_signed_note_never_changes() {
    let f = setup().await;
    let visit = f.visit(10).await;
    let (_, drafted) = f.save(&f.assistant, &visit, soap("Signed text")).await;
    // Signed by the covering clinician; assigned to the doctor.
    let (status, mut signed) = f.sign(&f.peer, &drafted).await;
    assert_eq!(status, 200, "{signed}");
    let original = signed["note"].clone();
    let other = staff(&f.db, f.tenant, Role::Clinician, "clinician", "Dr. Third").await;
    for (who, name) in [
        (&f.peer, "Dr. Casey Covering"),
        (&f.doctor, "Dr. Avery Assigned"),
        (&other, "Dr. Third"),
        (&f.owner, "Dr. Olive Owner"),
    ] {
        assert_eq!(f.authorship(who, &signed).await["can_amend"], true);
        let (status, amended) = f
            .amend(who, &signed, &format!("Correction by {name}"))
            .await;
        assert_eq!(status, 200, "{name}: {amended}");
        assert_eq!(amended["note"], original);
        assert_eq!(amended["signed_by"], f.peer.sub.to_string());
        assert_eq!(amended["signed_at"], signed["signed_at"]);
        assert_eq!(amended["clinician_id"], f.doctor.sub.to_string());
        assert_eq!(
            f.audited("visit.amend", &amended).await.last(),
            Some(&who.sub)
        );
        signed = amended;
    }
    let seen = f.authorship(&f.readonly, &signed).await;
    let authors: Vec<(&str, &str)> = seen["amendments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| (text(&a["author_id"]), text(&a["author_name"])))
        .collect();
    assert_eq!(
        authors,
        [
            (f.peer.sub.to_string().as_str(), "Dr. Casey Covering"),
            (f.doctor.sub.to_string().as_str(), "Dr. Avery Assigned"),
            (other.sub.to_string().as_str(), "Dr. Third"),
            (f.owner.sub.to_string().as_str(), "Dr. Olive Owner"),
        ]
    );
    let written: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT author_id,text FROM amendments WHERE tenant_id=$1 AND visit_id=$2 ORDER BY created_at,id",
    )
    .bind(f.tenant)
    .bind(Uuid::parse_str(text(&signed["id"])).unwrap())
    .fetch_all(&f.db)
    .await
    .unwrap();
    assert_eq!(written.len(), 4);
    assert_eq!(
        written[1],
        (f.doctor.sub, "Correction by Dr. Avery Assigned".into())
    );

    // Signed content is immutable for everyone, as before.
    for who in [&f.peer, &f.doctor, &f.owner, &f.assistant] {
        let (status, body) = f.save(who, &signed, soap("Rewritten")).await;
        assert_eq!(status, 409, "{body}");
        assert_eq!(
            f.sign(who, &signed).await.0,
            if who.sub == f.assistant.sub { 403 } else { 409 }
        );
        assert_eq!(f.diagnoses(who, &signed).await.0, 409);
    }
    assert_eq!(f.authorship(&f.peer, &signed).await["can_draft"], false);
    assert_eq!(f.authorship(&f.peer, &signed).await["can_sign"], false);
    let id = Uuid::parse_str(text(&signed["id"])).unwrap();
    for change in [
        "UPDATE visits SET note=jsonb_set(note,'{plan}','\"Rewritten\"') WHERE id=$1",
        "UPDATE visits SET signed_by=gen_random_uuid() WHERE id=$1",
        "UPDATE visits SET clinician_id=gen_random_uuid() WHERE id=$1",
        "UPDATE visits SET status='in_progress',signed_by=NULL,signed_at=NULL WHERE id=$1",
        "DELETE FROM amendments WHERE visit_id=$1",
        "UPDATE amendments SET author_id=gen_random_uuid() WHERE visit_id=$1",
    ] {
        assert!(
            sqlx::query(change).bind(id).execute(&f.db).await.is_err(),
            "{change}"
        );
    }
    let (_, read) = f
        .call(
            &f.desk,
            "GET",
            &format!("/api/v1/visits/{id}"),
            Value::Null,
            None,
        )
        .await;
    assert_eq!(read["note"], original);
    assert_eq!(read["signed_by"], f.peer.sub.to_string());
}

#[tokio::test]
async fn a_delegated_support_session_drafts_but_never_signs_or_amends() {
    let f = setup().await;
    let support = f.support("platform_admin:synthetic-support").await;
    let known: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM browser_users WHERE id=$1)")
        .bind(support.sub)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert!(!known, "a support grant is never a staff account");

    let visit = f.visit(10).await;
    let seen = f.authorship(&support, &visit).await;
    assert_eq!(seen["delegated"], true);
    assert_eq!(seen["can_draft"], true);
    assert_eq!(seen["can_sign"], false);
    assert_eq!(seen["can_amend"], false);
    assert_eq!(f.previous(&support, &visit).await.0, 200);

    let (status, drafted) = f.save(&support, &visit, soap("Drafted by support")).await;
    assert_eq!(status, 200, "{drafted}");
    // The draft is attributed to the support grant, never to a member of staff.
    assert_eq!(drafted["note"]["saved_by"]["id"], support.sub.to_string());
    assert_eq!(drafted["note"]["saved_by"]["name"], "Support staff");
    assert_eq!(drafted["note"]["saved_by"]["support"], true);
    assert_eq!(drafted["clinician_id"], f.doctor.sub.to_string());
    assert_eq!(f.audited("visit.note_save", &drafted).await, [support.sub]);
    assert_eq!(
        f.audited("visit.note_save_for_assigned", &drafted).await,
        [support.sub]
    );
    let (status, coded) = f.diagnoses(&support, &drafted).await;
    assert_eq!(status, 200, "{coded}");
    assert_eq!(coded["history"][0]["actor_id"], support.sub.to_string());
    let drafted = coded["visit"].clone();
    let seen = f.authorship(&f.doctor, &drafted).await;
    assert_eq!(seen["last_saved"]["name"], "Support staff");
    assert_eq!(seen["last_saved"]["support"], true);

    // Signing is a clinician's own act: the support session is refused.
    assert_eq!(f.sign(&support, &drafted).await.0, 403);
    let (_, still) = f
        .call(
            &f.doctor,
            "GET",
            &format!("/api/v1/visits/{}", text(&drafted["id"])),
            Value::Null,
            None,
        )
        .await;
    assert_eq!(still["status"], "in_progress");
    assert!(f.audited("visit.sign", &drafted).await.is_empty());

    let (status, signed) = f.sign(&f.doctor, &drafted).await;
    assert_eq!(status, 200, "{signed}");
    assert_eq!(signed["signed_by"], f.doctor.sub.to_string());
    // What support drafted stays named as support in the signed record.
    assert_eq!(signed["note"]["saved_by"]["support"], true);
    assert_eq!(f.amend(&support, &signed, "Not allowed").await.0, 403);
    assert_eq!(f.authorship(&support, &signed).await["can_amend"], false);
    assert!(f.audited("visit.amend", &signed).await.is_empty());
    // Nor may it release the patient summary.
    let checkout = format!(
        "/api/v1/patients/{}/visits/{}/checkout",
        f.patient,
        text(&signed["id"])
    );
    let (status, preview) = f.call(&support, "GET", &checkout, Value::Null, None).await;
    assert_eq!(status, 200, "{preview}");
    let (status, _) = f
        .call(
            &support,
            "POST",
            &format!("{checkout}/actions"),
            json!({"action":"release_avs","instructions":"Synthetic patient instructions.","follow_up_instructions":"","reason":"Synthetic review","reviewed":true,"reviewed_snapshot_digest":preview["preview_digest"]}),
            Some(0),
        )
        .await;
    assert_eq!(status, 403);
    // The session ending does not turn its draft into a staff member's work.
    sqlx::query("DELETE FROM partner_support_sessions WHERE grant_id=$1")
        .bind(support.sub)
        .execute(&f.db)
        .await
        .unwrap();
    let seen = f.authorship(&f.doctor, &signed).await;
    assert_eq!(seen["last_saved"]["name"], "Support staff");
    assert_eq!(seen["last_saved"]["id"], support.sub.to_string());
}

#[tokio::test]
async fn a_custom_policy_without_clinical_edit_blocks_drafting() {
    let f = setup().await;
    let visit = f.visit(10).await;
    let policy = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Rooming only','medical_assistant',$3,$4)")
        .bind(f.tenant)
        .bind(policy)
        .bind(json!({"clinical":{"view":true,"create":true,"edit":false,"delete":false}}))
        .bind(f.owner.sub)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)")
        .bind(f.tenant)
        .bind(f.assistant.sub)
        .bind(policy)
        .bind(f.owner.sub)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        f.save(&f.assistant, &visit, soap("Not allowed")).await.0,
        403
    );
    assert_eq!(f.diagnoses(&f.assistant, &visit).await.0, 403);
    let seen = f.authorship(&f.assistant, &visit).await;
    assert_eq!(seen["can_draft"], false);
    assert!(seen["last_saved"].is_null());
    // The nurse, with no custom policy, still drafts.
    let (status, drafted) = f.save(&f.nurse, &visit, soap("Nurse draft")).await;
    assert_eq!(status, 200, "{drafted}");
    // Giving clinical edit back restores drafting without any other change.
    sqlx::query("UPDATE practice_access_policies SET permissions=$3,version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(f.tenant)
        .bind(policy)
        .bind(json!({"clinical":{"view":true,"create":true,"edit":true,"delete":false}}))
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        f.authorship(&f.assistant, &drafted).await["can_draft"],
        true
    );
    let (status, saved) = f
        .save(&f.assistant, &drafted, soap("Assistant draft"))
        .await;
    assert_eq!(status, 200, "{saved}");
    // A clinician's custom policy can take signing away too.
    let strict = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,'Chart reader','clinician',$3,$4)")
        .bind(f.tenant)
        .bind(strict)
        .bind(json!({"clinical":{"view":true,"create":false,"edit":false,"delete":false}}))
        .bind(f.owner.sub)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,updated_by) VALUES($1,$2,$3,$4)")
        .bind(f.tenant)
        .bind(f.peer.sub)
        .bind(strict)
        .bind(f.owner.sub)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(f.save(&f.peer, &saved, soap("Not allowed")).await.0, 403);
    assert_eq!(f.sign(&f.peer, &saved).await.0, 403);
    let seen = f.authorship(&f.peer, &saved).await;
    assert_eq!(seen["can_draft"], false);
    assert_eq!(seen["can_sign"], false);
}

#[tokio::test]
async fn two_writers_cannot_overwrite_each_other() {
    let f = setup().await;
    let opened = f.visit(10).await;
    // The assistant and the doctor both open the same version of the note.
    let (status, first) = f.save(&f.assistant, &opened, soap("Assistant text")).await;
    assert_eq!(status, 200, "{first}");
    let (status, refused) = f.save(&f.doctor, &opened, soap("Doctor text")).await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(refused["error"], "conflict");
    // Nothing of the assistant's was replaced, and the doctor can see who saved.
    let seen = f.authorship(&f.doctor, &opened).await;
    assert_eq!(seen["version"], first["version"]);
    assert_eq!(seen["last_saved"]["name"], "Morgan Assistant");
    let (_, current) = f
        .call(
            &f.doctor,
            "GET",
            &format!("/api/v1/visits/{}", text(&opened["id"])),
            Value::Null,
            None,
        )
        .await;
    assert_eq!(current["note"]["subjective"], "Assistant text");
    // A stale signature is refused the same way.
    assert_eq!(f.sign(&f.doctor, &opened).await.0, 409);
    // After loading the current note the doctor's save goes through.
    let (status, second) = f.save(&f.doctor, &current, soap("Doctor text")).await;
    assert_eq!(status, 200, "{second}");
    assert_eq!(second["note"]["saved_by"]["name"], "Dr. Avery Assigned");
    // Two saves at the same moment from one version: exactly one wins.
    let (left, right) = tokio::join!(
        f.save(&f.assistant, &second, soap("Left")),
        f.save(&f.peer, &second, soap("Right"))
    );
    let mut statuses = [left.0.as_u16(), right.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    let winner = if left.0 == 200 { &left.1 } else { &right.1 };
    let (_, stored) = f
        .call(
            &f.doctor,
            "GET",
            &format!("/api/v1/visits/{}", text(&opened["id"])),
            Value::Null,
            None,
        )
        .await;
    assert_eq!(stored["note"], winner["note"]);
    assert_eq!(stored["version"], winner["version"]);
    assert_eq!(f.audited("visit.note_save", &opened).await.len(), 3);
}

#[tokio::test]
async fn a_covering_clinician_records_intake_and_vitals_but_does_not_start_the_visit() {
    let f = setup().await;
    // Starting an encounter is unchanged: the assigned clinician or rooming staff only.
    let waiting = Uuid::new_v4();
    sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'2026-11-09T15:00:00Z','2026-11-09T15:30:00Z','checked_in')")
        .bind(f.tenant)
        .bind(waiting)
        .bind(f.patient)
        .bind(f.doctor.sub)
        .execute(&f.db)
        .await
        .unwrap();
    for who in [&f.peer, &f.owner, &f.desk] {
        let (status, _) = f
            .call(
                who,
                "POST",
                "/api/v1/visits",
                json!({"appointment_id":waiting}),
                None,
            )
            .await;
        assert_eq!(status, 403);
    }
    let visit = f.visit(10).await;
    let id = text(&visit["id"]).to_string();
    let vitals = json!({"systolic_mm_hg":120,"diastolic_mm_hg":80,"heart_rate_bpm":70,"temperature_c":36.7,"weight_kg":70.0,"height_cm":170.0,"oxygen_saturation_pct":98.0});
    let intake = json!({"status":"ready","chief_complaint":"Synthetic follow-up","intake_notes":"Synthetic intake","medications_reviewed":true,"allergies_reviewed":true});
    let rooming = format!("/api/v1/visits/{id}/rooming");
    let mut version = visit["version"].as_i64().unwrap();
    for who in [&f.peer, &f.owner, &f.nurse, &f.doctor] {
        let (status, seen) = f.call(who, "GET", &rooming, Value::Null, None).await;
        assert_eq!(status, 200, "{seen}");
        assert_eq!(seen["can_edit"], true);
        let (status, saved) = f
            .call(
                who,
                "PUT",
                &format!("/api/v1/visits/{id}/vitals"),
                vitals.clone(),
                Some(version),
            )
            .await;
        assert_eq!(status, 200, "{saved}");
        version += 1;
        assert_eq!(saved["clinician_id"], f.doctor.sub.to_string());
        assert_eq!(
            f.audited("visit.vitals_save", &visit).await.last(),
            Some(&who.sub)
        );
        let (status, saved) = f
            .call(who, "PUT", &rooming, intake.clone(), Some(version))
            .await;
        assert_eq!(status, 200, "{saved}");
        version += 1;
        assert_eq!(saved["updated_by"], who.sub.to_string());
        assert_eq!(
            f.audited("visit.rooming_save", &visit).await.last(),
            Some(&who.sub)
        );
        // Both saves are in the encounter history under the person who made them.
        let attributed: i64 = sqlx::query_scalar("SELECT count(*) FROM visit_rooming_revisions WHERE tenant_id=$1 AND visit_id=$2 AND actor_id=$3")
            .bind(f.tenant)
            .bind(Uuid::parse_str(&id).unwrap())
            .bind(who.sub)
            .fetch_one(&f.db)
            .await
            .unwrap();
        assert_eq!(attributed, 2);
    }
    // Front desk, read-only staff and a support session do not record intake or vitals.
    let support = f.support("platform_admin:synthetic-support").await;
    for who in [&f.desk, &f.readonly, &support] {
        let (status, _) = f
            .call(
                who,
                "PUT",
                &format!("/api/v1/visits/{id}/vitals"),
                vitals.clone(),
                Some(version),
            )
            .await;
        assert_eq!(status, 403);
        let (status, _) = f
            .call(who, "PUT", &rooming, intake.clone(), Some(version))
            .await;
        assert_eq!(status, 403);
        let (status, seen) = f.call(who, "GET", &rooming, Value::Null, None).await;
        assert_eq!(status, 200, "{seen}");
        assert_eq!(seen["can_edit"], false);
    }
    // After signing, a covering clinician cannot change them either.
    let (_, current) = f
        .call(
            &f.peer,
            "GET",
            &format!("/api/v1/visits/{id}"),
            Value::Null,
            None,
        )
        .await;
    let (_, drafted) = f.save(&f.peer, &current, soap("Covering visit")).await;
    let (status, signed) = f.sign(&f.peer, &drafted).await;
    assert_eq!(status, 200, "{signed}");
    let (status, _) = f
        .call(
            &f.peer,
            "PUT",
            &format!("/api/v1/visits/{id}/vitals"),
            vitals,
            signed["version"].as_i64(),
        )
        .await;
    assert_eq!(status, 409);
    let (status, _) = f
        .call(&f.peer, "PUT", &rooming, intake, signed["version"].as_i64())
        .await;
    assert_eq!(status, 409);
}

#[tokio::test]
async fn the_schedule_note_marker_and_banner_follow_a_note_whoever_drafted_it() {
    let f = setup().await;
    let visit = f.visit(10).await;
    let appointment = text(&visit["appointment_id"]).to_string();
    let markers = "/api/v1/schedule/markers?from=2026-11-10T00:00:00Z&to=2026-11-11T00:00:00Z";
    let banner = format!("/api/v1/patients/{}/banner", f.patient);
    let note_marker = |body: &Value| {
        body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["appointment_id"] == appointment)
            .map(|item| item["note"].clone())
            .unwrap()
    };
    let (status, before) = f.call(&f.doctor, "GET", markers, Value::Null, None).await;
    assert_eq!(status, 200, "{before}");
    assert_eq!(note_marker(&before), "not_started");
    // The assistant drafts the doctor's note: every viewer sees it as started and unsigned.
    let (_, drafted) = f.save(&f.assistant, &visit, soap("Assistant draft")).await;
    for who in [&f.doctor, &f.peer, &f.desk] {
        let (_, during) = f.call(who, "GET", markers, Value::Null, None).await;
        assert_eq!(note_marker(&during), "in_progress");
        let (status, shown) = f.call(who, "GET", &banner, Value::Null, None).await;
        assert_eq!(status, 200, "{shown}");
        assert_eq!(shown["flags"]["unsigned_notes"], 1, "{shown}");
    }
    // The covering clinician signs it: the marker turns signed and the flag clears.
    assert_eq!(f.sign(&f.peer, &drafted).await.0, 200);
    let (_, after) = f.call(&f.doctor, "GET", markers, Value::Null, None).await;
    assert_eq!(note_marker(&after), "signed");
    let (_, shown) = f.call(&f.doctor, "GET", &banner, Value::Null, None).await;
    assert_eq!(shown["flags"]["unsigned_notes"], 0, "{shown}");
}
