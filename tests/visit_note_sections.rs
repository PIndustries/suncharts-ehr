// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::Utc;
use http_body_util::BodyExt;
use jsonwebtoken::{encode, EncodingKey, Header};
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::Arc;
use suncharts_engine::{
    auth::{Actor, Role},
    postgres::PostgresBackend,
    State,
};
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &str = "synthetic-test-secret-not-for-production-123456";
fn actor(tenant: Uuid, role: Role, patient_id: Option<Uuid>) -> Actor {
    let now = Utc::now().timestamp();
    Actor {
        sub: Uuid::new_v4(),
        tenant_id: tenant,
        role,
        patient_id,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 60,
    }
}
fn token(a: &Actor) -> String {
    encode(
        &Header::default(),
        a,
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}
fn application(db: PgPool) -> Router {
    suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db)),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: None,
    })
}
async fn database() -> PgPool {
    let url = std::env::var("TEST_DATABASE_URL")
        .expect("TEST_DATABASE_URL must point at a disposable PostgreSQL database");
    let setup = PgPool::connect(&url).await.unwrap();
    let schema = format!("engine_test_{}", Uuid::new_v4().simple());
    suncharts_engine::test_db::create_schema(&setup, &schema).await;
    setup.close().await;
    let pool = PgPoolOptions::new()
        .max_connections(6)
        .after_connect(move |c, _| {
            let sql = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(&sql).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&pool).await.unwrap();
    pool
}
async fn call(
    app: &Router,
    a: Option<&Actor>,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(a) = a {
        req = req.header("authorization", format!("Bearer {}", token(a)));
    }
    if let Some(v) = version {
        req = req.header("if-match", format!("\"{v}\""));
    }
    let req = if body.is_null() {
        req.body(Body::empty()).unwrap()
    } else {
        req.header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    assert_eq!(resp.headers()["cache-control"], "no-store");
    assert!(resp.headers()["link"].to_str().unwrap().contains("/source"));
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let value =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, value)
}
fn id(v: &Value) -> Uuid {
    Uuid::parse_str(v["id"].as_str().unwrap()).unwrap()
}
fn soap() -> Value {
    json!({"subjective":"Synthetic follow-up","objective":"Well appearing","assessment":"Routine follow-up","plan":"Return in four weeks"})
}
async fn patient(app: &Router, desk: &Actor, family: &str) -> Uuid {
    let (status, p) = call(
        app,
        Some(desk),
        "POST",
        "/api/v1/patients",
        json!({"given_name":"Avery","family_name":family,"birth_date":"1990-01-01"}),
        None,
    )
    .await;
    assert_eq!(status, 201, "{p}");
    id(&p)
}
/// Books, checks in and starts a visit on the given synthetic day of November 2026.
async fn started(app: &Router, desk: &Actor, doctor: &Actor, patient: Uuid, day: u8) -> Value {
    let booking = json!({"patient_id":patient,"clinician_id":doctor.sub,
        "starts_at":format!("2026-11-{day:02}T15:00:00Z"),"ends_at":format!("2026-11-{day:02}T15:30:00Z")});
    let (status, appointment) = call(
        app,
        Some(desk),
        "POST",
        "/api/v1/appointments",
        booking,
        None,
    )
    .await;
    assert_eq!(status, 201, "{appointment}");
    let appointment = id(&appointment);
    let (status, checked) = call(
        app,
        Some(desk),
        "POST",
        &format!("/api/v1/appointments/{appointment}/check-in"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, 200, "{checked}");
    let (status, visit) = call(
        app,
        Some(doctor),
        "POST",
        "/api/v1/visits",
        json!({"appointment_id":appointment}),
        None,
    )
    .await;
    assert_eq!(status, 201, "{visit}");
    visit
}
async fn save(app: &Router, doctor: &Actor, visit: &Value, note: Value) -> (StatusCode, Value) {
    call(
        app,
        Some(doctor),
        "PUT",
        &format!("/api/v1/visits/{}/note", id(visit)),
        note,
        visit["version"].as_i64(),
    )
    .await
}
async fn signed(
    app: &Router,
    desk: &Actor,
    doctor: &Actor,
    patient: Uuid,
    day: u8,
    note: Value,
) -> Value {
    let visit = started(app, desk, doctor, patient, day).await;
    let (status, saved) = save(app, doctor, &visit, note).await;
    assert_eq!(status, 200, "{saved}");
    let (status, done) = call(
        app,
        Some(doctor),
        "POST",
        &format!("/api/v1/visits/{}/sign", id(&saved)),
        Value::Null,
        saved["version"].as_i64(),
    )
    .await;
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["status"], "signed");
    done
}
async fn previous(app: &Router, who: &Actor, visit: &Value) -> (StatusCode, Value) {
    call(
        app,
        Some(who),
        "GET",
        &format!("/api/v1/visits/{}/previous-note", id(visit)),
        Value::Null,
        None,
    )
    .await
}
/// A note as returned, without the server's record of who last saved it.
fn text_of(note: &Value) -> Value {
    let mut note = note.clone();
    if let Some(fields) = note.as_object_mut() {
        fields.remove("saved_by");
    }
    note
}
async fn stored_note(db: &PgPool, visit: &Value) -> String {
    // The text sections as stored, without the server's record of who last saved.
    sqlx::query_scalar("SELECT (note - 'saved_by')::text FROM visits WHERE id=$1")
        .bind(id(visit))
        .fetch_one(db)
        .await
        .unwrap()
}
async fn audits(db: &PgPool, action: &str, resource: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action=$1 AND resource_id=$2")
        .bind(action)
        .bind(resource)
        .fetch_one(db)
        .await
        .unwrap()
}

#[tokio::test]
async fn notes_without_a_procedure_keep_their_stored_shape_and_still_sign() {
    let db = database().await;
    let app = application(db.clone());
    let tenant = Uuid::new_v4();
    let doctor = actor(tenant, Role::Clinician, None);
    let desk = actor(tenant, Role::FrontDesk, None);
    let p = patient(&app, &desk, "Synthetic").await;

    // A draft and a signed note written before the Procedure section existed.
    let legacy = "{\"plan\": \"Return in four weeks\", \"objective\": \"Well appearing\", \"assessment\": \"Routine follow-up\", \"subjective\": \"Synthetic follow-up\"}";
    let old_signed = signed(&app, &desk, &doctor, p, 2, soap()).await;
    assert_eq!(stored_note(&db, &old_signed).await, legacy);
    assert!(old_signed["note"].get("procedure").is_none());
    assert!(old_signed["note"].get("started_from").is_none());

    let draft = started(&app, &desk, &doctor, p, 3).await;
    sqlx::query("UPDATE visits SET note=$2::jsonb,version=version+1 WHERE id=$1")
        .bind(id(&draft))
        .bind(legacy)
        .execute(&db)
        .await
        .unwrap();
    let (status, read) = call(
        &app,
        Some(&doctor),
        "GET",
        &format!("/api/v1/visits/{}", id(&draft)),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(text_of(&read["note"]), soap());
    let (status, done) = call(
        &app,
        Some(&doctor),
        "POST",
        &format!("/api/v1/visits/{}/sign", id(&draft)),
        Value::Null,
        read["version"].as_i64(),
    )
    .await;
    assert_eq!(status, 200, "{done}");
    // Signing never rewrites the note: the stored text is byte-for-byte what was drafted.
    assert_eq!(stored_note(&db, &done).await, legacy);

    // An empty or blank Procedure is left out, so the stored note matches the old shape.
    for blank in ["", "   \n"] {
        let visit = started(
            &app,
            &desk,
            &doctor,
            p,
            if blank.is_empty() { 4 } else { 5 },
        )
        .await;
        let mut note = soap();
        note["procedure"] = json!(blank);
        let (status, saved) = save(&app, &doctor, &visit, note).await;
        assert_eq!(status, 200, "{saved}");
        assert_eq!(stored_note(&db, &saved).await, legacy);
    }

    // The signed note cannot be changed, with or without the new field.
    let mut changed = soap();
    changed["procedure"] = json!("Added after signing");
    let (status, _) = save(&app, &doctor, &old_signed, changed).await;
    assert_eq!(status, 409);
    let direct = sqlx::query(
        "UPDATE visits SET note=note||'{\"procedure\":\"Added after signing\"}'::jsonb WHERE id=$1",
    )
    .bind(id(&old_signed))
    .execute(&db)
    .await;
    assert!(
        direct.is_err(),
        "the database must refuse to alter a signed note"
    );
    assert_eq!(stored_note(&db, &old_signed).await, legacy);
}

#[tokio::test]
async fn procedure_round_trips_through_draft_sign_amend_and_read() {
    let db = database().await;
    let app = application(db.clone());
    let tenant = Uuid::new_v4();
    let doctor = actor(tenant, Role::Clinician, None);
    let desk = actor(tenant, Role::FrontDesk, None);
    let p = patient(&app, &desk, "Synthetic").await;
    let visit = started(&app, &desk, &doctor, p, 6).await;

    let mut note = soap();
    note["procedure"] = json!("x".repeat(10001));
    assert_eq!(save(&app, &doctor, &visit, note.clone()).await.0, 400);
    note["procedure"] = json!(7);
    assert_ne!(save(&app, &doctor, &visit, note.clone()).await.0, 200);
    note["procedure"] = json!("Synthetic procedure text\nSecond line");
    note["unexpected"] = json!("x");
    assert_ne!(save(&app, &doctor, &visit, note.clone()).await.0, 200);
    note.as_object_mut().unwrap().remove("unexpected");
    // The four original sections stay required.
    let mut missing = note.clone();
    missing["plan"] = json!("  ");
    assert_eq!(save(&app, &doctor, &visit, missing).await.0, 400);

    let (status, saved) = save(&app, &doctor, &visit, note.clone()).await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(text_of(&saved["note"]), note);
    let (status, done) = call(
        &app,
        Some(&doctor),
        "POST",
        &format!("/api/v1/visits/{}/sign", id(&saved)),
        Value::Null,
        saved["version"].as_i64(),
    )
    .await;
    assert_eq!(status, 200, "{done}");
    assert_eq!(text_of(&done["note"]), note);
    let before = stored_note(&db, &done).await;

    let (status, amended) = call(
        &app,
        Some(&doctor),
        "POST",
        &format!("/api/v1/visits/{}/amendments", id(&done)),
        json!({"reason":"Procedure clarification","text":"Synthetic correction to the procedure section"}),
        done["version"].as_i64(),
    )
    .await;
    assert_eq!(status, 200, "{amended}");
    assert_eq!(text_of(&amended["note"]), note);
    assert_eq!(stored_note(&db, &amended).await, before);

    let (status, record) = call(
        &app,
        Some(&doctor),
        "GET",
        &format!("/api/v1/patients/{p}/record"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, 200, "{record}");
    assert_eq!(text_of(&record["visits"][0]["note"]), note);
    assert_eq!(record["amendments"].as_array().unwrap().len(), 1);
    let (status, chart) = call(
        &app,
        Some(&doctor),
        "GET",
        &format!("/api/v1/patients/{p}/workspace"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, 200, "{chart}");
    assert_eq!(chart["visits"][0]["note"]["procedure"], note["procedure"]);
}

#[tokio::test]
async fn previous_note_prefers_the_same_clinician_and_only_offers_signed_notes() {
    let db = database().await;
    let app = application(db.clone());
    let tenant = Uuid::new_v4();
    let doctor = actor(tenant, Role::Clinician, None);
    let peer = actor(tenant, Role::Clinician, None);
    let desk = actor(tenant, Role::FrontDesk, None);
    let nurse = actor(tenant, Role::Nurse, None);
    let readonly = actor(tenant, Role::ReadOnly, None);
    let outsider = actor(Uuid::new_v4(), Role::Clinician, None);
    let outsider_desk = Actor {
        role: Role::FrontDesk,
        sub: Uuid::new_v4(),
        ..outsider.clone()
    };
    let p = patient(&app, &desk, "Synthetic").await;
    let sibling = patient(&app, &desk, "Sibling").await;
    let elsewhere = patient(&app, &outsider_desk, "Elsewhere").await;
    sqlx::query("INSERT INTO browser_users (id,tenant_id,email,password_hash,role,display_name) VALUES ($1,$2,'peer@example.test','x','clinician','Dr. Peer Synthetic')")
        .bind(peer.sub)
        .bind(tenant)
        .execute(&db)
        .await
        .unwrap();

    // Nothing signed yet for this patient, whatever exists for others.
    let with = |text: &str| {
        let mut note = soap();
        note["subjective"] = json!(text);
        note
    };
    signed(&app, &desk, &doctor, sibling, 1, with("Another patient")).await;
    signed(
        &app,
        &outsider_desk,
        &outsider,
        elsewhere,
        1,
        with("Another practice"),
    )
    .await;
    let first_open = started(&app, &desk, &doctor, p, 2).await;
    let (status, none) = previous(&app, &doctor, &first_open).await;
    assert_eq!(status, 200, "{none}");
    assert_eq!(none, json!({"source":null}));
    assert_eq!(
        audits(&db, "visit.previous_note.read", id(&first_open)).await,
        1
    );
    // An unsigned draft is never a source, even the clinician's own.
    let (status, drafted) = save(&app, &doctor, &first_open, with("Unsigned draft")).await;
    assert_eq!(status, 200);

    let mut own = with("Own earlier note");
    own["procedure"] = json!("Synthetic earlier procedure");
    let own_signed = signed(&app, &desk, &doctor, p, 4, own.clone()).await;
    let peer_signed = signed(&app, &desk, &peer, p, 6, with("Peer later note")).await;
    let later = signed(
        &app,
        &desk,
        &doctor,
        p,
        20,
        with("Own note after this visit"),
    )
    .await;

    let current = started(&app, &desk, &doctor, p, 10).await;
    let (status, found) = previous(&app, &doctor, &current).await;
    assert_eq!(status, 200, "{found}");
    let source = &found["source"];
    // The clinician's own earlier note wins over a colleague's more recent one, and a
    // visit dated after this one is not "last visit".
    assert_eq!(source["visit_id"], own_signed["id"]);
    assert_ne!(source["visit_id"], later["id"]);
    assert_eq!(source["version"], own_signed["version"]);
    assert_eq!(source["same_clinician"], true);
    assert_eq!(source["visit_date"], "2026-11-04T15:00:00Z");
    assert_eq!(
        source["note"],
        json!({"subjective":"Own earlier note","objective":"Well appearing","assessment":"Routine follow-up","plan":"Return in four weeks","procedure":"Synthetic earlier procedure"})
    );
    // Only note text is offered: no vitals, diagnoses, charges or provenance.
    let mut keys: Vec<_> = source.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "clinician_id",
            "clinician_name",
            "note",
            "own",
            "same_clinician",
            "signed_at",
            "version",
            "visit_date",
            "visit_id"
        ]
    );
    assert_eq!(
        audits(&db, "visit.previous_note.read", id(&own_signed)).await,
        1
    );

    // A clinician with no signed note of their own gets the newest by anyone, named.
    let peer_first = started(&app, &desk, &peer, sibling, 9).await;
    let (status, found) = previous(&app, &peer, &peer_first).await;
    assert_eq!(status, 200, "{found}");
    assert_eq!(found["source"]["note"]["subjective"], "Another patient");
    assert_eq!(found["source"]["same_clinician"], false);
    assert_eq!(found["source"]["clinician_id"], doctor.sub.to_string());
    assert_eq!(found["source"]["clinician_name"], "");
    let peer_current = started(&app, &desk, &peer, p, 12).await;
    let (_, found) = previous(&app, &peer, &peer_current).await;
    assert_eq!(found["source"]["visit_id"], peer_signed["id"]);
    assert_eq!(found["source"]["same_clinician"], true);
    assert_eq!(found["source"]["clinician_name"], "Dr. Peer Synthetic");
    assert_eq!(drafted["status"], "in_progress");

    // Permissions match writing the note: clinical staff of the same practice only. A
    // colleague covering this visit is offered the assigned clinician's earlier note.
    let (status, covering) = previous(&app, &peer, &current).await;
    assert_eq!(status, 200, "{covering}");
    assert_eq!(covering["source"]["visit_id"], own_signed["id"]);
    assert_eq!(covering["source"]["same_clinician"], true);
    assert_eq!(covering["source"]["own"], false);
    assert_eq!(previous(&app, &desk, &current).await.0, 403);
    // A nurse whose account is not on file is not clinical staff here.
    assert_eq!(previous(&app, &nurse, &current).await.0, 403);
    assert_eq!(previous(&app, &readonly, &current).await.0, 403);
    assert_eq!(previous(&app, &outsider, &current).await.0, 404);
    let unknown = json!({"id":Uuid::new_v4()});
    assert_eq!(previous(&app, &doctor, &unknown).await.0, 404);
    let unauthenticated = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/visits/{}/previous-note", id(&current)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), 401);

    // Reading the earlier note changes nothing about it, and the live change feed
    // (every visit action except reads) has nothing new to report for it.
    let changes: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE resource_id=$1 AND action LIKE 'visit.%' AND action NOT LIKE '%.read' AND id>(SELECT max(id) FROM audit_events WHERE resource_id=$1 AND action='visit.sign')")
        .bind(id(&own_signed))
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(changes, 0);
    let (_, reread) = call(
        &app,
        Some(&doctor),
        "GET",
        &format!("/api/v1/visits/{}", id(&own_signed)),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(reread["version"], own_signed["version"]);
    assert_eq!(text_of(&reread["note"]), own);
}

#[tokio::test]
async fn a_note_started_from_an_earlier_one_records_where_it_came_from() {
    let db = database().await;
    let app = application(db.clone());
    let tenant = Uuid::new_v4();
    let doctor = actor(tenant, Role::Clinician, None);
    let desk = actor(tenant, Role::FrontDesk, None);
    let outsider = actor(Uuid::new_v4(), Role::Clinician, None);
    let outsider_desk = Actor {
        role: Role::FrontDesk,
        sub: Uuid::new_v4(),
        ..outsider.clone()
    };
    let p = patient(&app, &desk, "Synthetic").await;
    let sibling = patient(&app, &desk, "Sibling").await;
    let elsewhere = patient(&app, &outsider_desk, "Elsewhere").await;
    let mut earlier = soap();
    earlier["procedure"] = json!("Synthetic earlier procedure");
    let source = signed(&app, &desk, &doctor, p, 3, earlier.clone()).await;
    let source_text = stored_note(&db, &source).await;
    let other_patient = signed(&app, &desk, &doctor, sibling, 2, soap()).await;
    let other_practice = signed(&app, &outsider_desk, &outsider, elsewhere, 3, soap()).await;
    let unsigned = started(&app, &desk, &doctor, p, 5).await;
    let visit = started(&app, &desk, &doctor, p, 9).await;

    let from = |visit_id: &Value, version: i64, sections: Value| {
        let mut note = soap();
        note["plan"] = json!("Edited after bringing the earlier text in");
        note["procedure"] = json!("Synthetic earlier procedure");
        note["started_from"] = json!({"visit_id":visit_id,"version":version,"sections":sections});
        note
    };
    let all = json!(["procedure", "subjective", "plan"]);
    let version = source["version"].as_i64().unwrap();
    // The reference must be a signed note of this patient in this practice.
    for (bad, why) in [
        (
            from(&other_patient["id"], 3, all.clone()),
            "another patient",
        ),
        (
            from(&other_practice["id"], 3, all.clone()),
            "another practice",
        ),
        (from(&unsigned["id"], 1, all.clone()), "an unsigned visit"),
        (from(&visit["id"], 1, all.clone()), "the note itself"),
        (
            from(&json!(Uuid::new_v4()), 1, all.clone()),
            "an unknown visit",
        ),
        (
            from(&source["id"], version + 1, all.clone()),
            "a future version",
        ),
        (from(&source["id"], 0, all.clone()), "a zero version"),
        (from(&source["id"], version, json!([])), "no sections"),
        (
            from(&source["id"], version, json!(["vitals"])),
            "an unknown section",
        ),
        (
            from(&source["id"], version, json!(["plan", "plan"])),
            "a repeated section",
        ),
    ] {
        let (status, body) = save(&app, &doctor, &visit, bad).await;
        assert_eq!(status, 400, "{why}: {body}");
    }
    assert_eq!(
        audits(&db, "visit.note_started_from_earlier", id(&visit)).await,
        0
    );

    let mut claimed = from(&source["id"], version, all.clone());
    claimed["started_from"]["visit_date"] = json!("1999-01-01T00:00:00Z");
    let (status, saved) = save(&app, &doctor, &visit, claimed).await;
    assert_eq!(status, 200, "{saved}");
    // Sections are stored in note order and the date comes from the earlier visit itself.
    let recorded = json!({"visit_id":source["id"],"version":version,
        "sections":["subjective","plan","procedure"],"visit_date":"2026-11-03T15:00:00Z"});
    assert_eq!(saved["note"]["started_from"], recorded);
    assert_eq!(
        saved["note"]["plan"],
        "Edited after bringing the earlier text in"
    );
    assert_eq!(
        audits(&db, "visit.note_started_from_earlier", id(&visit)).await,
        1
    );

    // Saving again with the same origin does not repeat the audit entry.
    let mut again = from(
        &source["id"],
        version,
        json!(["subjective", "plan", "procedure"]),
    );
    again["objective"] = json!("Edited again");
    let (status, saved) = save(&app, &doctor, &saved, again).await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["note"]["started_from"], recorded);
    assert_eq!(
        audits(&db, "visit.note_started_from_earlier", id(&visit)).await,
        1
    );

    let (status, done) = call(
        &app,
        Some(&doctor),
        "POST",
        &format!("/api/v1/visits/{}/sign", id(&saved)),
        Value::Null,
        saved["version"].as_i64(),
    )
    .await;
    assert_eq!(status, 200, "{done}");
    // The origin stays with the signed note for a reviewer.
    assert_eq!(done["note"]["started_from"], recorded);

    // Nothing about the earlier note changed.
    assert_eq!(stored_note(&db, &source).await, source_text);
    let (_, reread) = call(
        &app,
        Some(&doctor),
        "GET",
        &format!("/api/v1/visits/{}", id(&source)),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(reread["version"], source["version"]);
    assert_eq!(reread["signed_at"], source["signed_at"]);
    assert_eq!(text_of(&reread["note"]), earlier);
    assert_eq!(
        audits(&db, "visit.note_started_from_earlier", id(&source)).await,
        0
    );

    // Removing the origin (after an undo) is accepted and leaves a plain note.
    let plain = started(&app, &desk, &doctor, p, 12).await;
    let (status, first) = save(
        &app,
        &doctor,
        &plain,
        from(&source["id"], version, json!(["plan"])),
    )
    .await;
    assert_eq!(status, 200, "{first}");
    let (status, cleared) = save(&app, &doctor, &first, soap()).await;
    assert_eq!(status, 200, "{cleared}");
    assert!(cleared["note"].get("started_from").is_none());
}
