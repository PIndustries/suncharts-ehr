// SPDX-License-Identifier: AGPL-3.0-only
//! Opt-in localhost UI acceptance. Never compiled into the production engine.
use super::*;
use argon2::{
    password_hash::{rand_core::OsRng, SaltString},
    Argon2, PasswordHasher,
};
use axum::extract::{FromRequestParts, Request as HttpRequest};
use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt, path::PathBuf};

#[derive(Clone)]
struct Harness {
    state: State,
    broker: Arc<FakeBroker>,
    tenant: Uuid,
}
async fn return_refresh_injected(
    ExtractState(h): ExtractState<Harness>,
    Path(id): Path<Uuid>,
    request: HttpRequest,
) -> Result<Json<Value>> {
    let (mut parts, _) = request.into_parts();
    let actor = Actor::from_request_parts(&mut parts, &h.state).await?;
    // Exactly the production authorization + audited reconciliation helper;
    // only the provider transport is injected. Browser CSRF/origin checks occur
    // in Actor's normal BrowserAuth extraction, not a synthesized UI identity.
    Ok(Json(
        return_refresh_with(&h.state, &actor, id, h.broker.as_ref(), policy(false)).await?,
    ))
}
async fn counters(
    ExtractState(h): ExtractState<Harness>,
    request: HttpRequest,
) -> Result<Json<Value>> {
    let (mut parts, _) = request.into_parts();
    let actor = Actor::from_request_parts(&mut parts, &h.state).await?;
    if actor.tenant_id != h.tenant || !matches!(actor.role, crate::auth::Role::Owner) {
        return Err(Error::Forbidden);
    }
    let creates = h.broker.state.lock().unwrap().posts;
    let pool = db(&h.state)?;
    Ok(Json(
        json!({"provider":"injected local FakeBroker, not Stripe",
        "checkout_creates":creates,"initial_checkout_creates":2,
        "receipts":count(pool,"billing_copay_receipts").await,
        "ledger_entries":count(pool,"billing_entries").await}),
    ))
}

#[tokio::test]
#[ignore = "explicit local browser fixture; requires opt-in environment and exits after 30 minutes"]
async fn local_copay_return_browser_fixture() {
    assert_eq!(
        std::env::var("SUNCHARTS_COPAY_RETURN_BROWSER_FIXTURE").as_deref(),
        Ok("1")
    );
    let database = url::Url::parse(&std::env::var("TEST_DATABASE_URL").unwrap()).unwrap();
    assert_eq!(database.host_str(), Some("127.0.0.1"));
    assert_eq!(database.port(), Some(55589));
    assert_eq!(database.path(), "/claim_tracking_test");
    let output = PathBuf::from("/private/tmp/suncharts-copay-return-browser/browser-auth.json");
    assert!(
        !output.exists(),
        "preserve existing fixture evidence; use a reviewed new path before rerunning"
    );
    let origin = "http://127.0.0.1:55612";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:55612")
        .await
        .unwrap();
    let (pool, actor, patient, appointment, mut state) = setup().await;
    let password = format!("Synthetic-{}", Uuid::new_v4());
    let encoded = Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .unwrap()
        .to_string();
    let email = "copay-return-owner@example.test";
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role,display_name) VALUES($1,$2,$3,$4,'owner','Synthetic return reviewer')")
        .bind(actor.sub).bind(actor.tenant_id).bind(email).bind(encoded).execute(&pool).await.unwrap();
    state.browser = Some(crate::browser::BrowserAuth::new(pool.clone(), origin.into()).unwrap());
    let second = rcm_ok(&state,&actor,"POST","/api/v1/appointments",json!({
        "patient_id":patient,"clinician_id":actor.sub,"starts_at":"2026-10-26T14:00:00Z","ends_at":"2026-10-26T14:30:00Z",
        "title":"Synthetic unpaid return","reason":"Local browser fixture only"}),None).await;
    let second_id: Uuid = serde_json::from_value(second["id"].clone()).unwrap();
    rcm_ok(
        &state,
        &actor,
        "POST",
        &format!("/api/v1/appointments/{second_id}/check-in"),
        Value::Null,
        None,
    )
    .await;
    let broker = Arc::new(FakeBroker::new(false));
    let mut cases = Vec::new();
    for (index, appointment) in [appointment, second_id].into_iter().enumerate() {
        let visit = rcm_ok(
            &state,
            &actor,
            "POST",
            "/api/v1/visits",
            json!({"appointment_id":appointment}),
            None,
        )
        .await;
        let visit_path = format!("/api/v1/visits/{}", visit["id"].as_str().unwrap());
        let noted = rcm_ok(&state,&actor,"PUT",&format!("{visit_path}/note"),json!({
            "subjective":"Synthetic return fixture","objective":"No real clinical data",
            "assessment":"Local checkout routing check","plan":"No patient care or external payment"}),visit["version"].as_i64()).await;
        rcm_ok(
            &state,
            &actor,
            "POST",
            &format!("{visit_path}/sign"),
            Value::Null,
            noted["version"].as_i64(),
        )
        .await;
        let operation = create_with(
            &pool,
            &actor,
            patient,
            appointment,
            input(false),
            origin,
            broker.as_ref(),
            policy(false),
        )
        .await
        .unwrap();
        assert_eq!(operation.status, "open");
        if index == 0 {
            broker
                .state
                .lock()
                .unwrap()
                .paid_requests
                .insert(operation.id);
        }
        cases.push(json!({"case":if index==0{"provider_paid_pending_native_reconciliation"}else{"provider_unpaid"},
            "return_url":format!("{origin}/?copay_checkout={}",operation.id),"operation_id":operation.id,
            "appointment_id":appointment,"visit_id":visit["id"]}));
    }
    assert_eq!(broker.state.lock().unwrap().posts, 2);
    assert_eq!(count(&pool, "billing_copay_receipts").await, 0);
    state.allow_legacy_gateway = false; // Browser acceptance uses native login only.
    let harness = Harness {
        state: state.clone(),
        broker,
        tenant: actor.tenant_id,
    };
    let app = Router::new()
        .route(
            "/api/v1/billing/copay-checkouts/{id}/refresh",
            post(return_refresh_injected),
        )
        .route("/__fixture/status", get(counters))
        .with_state(harness)
        .fallback_service(crate::app(state));
    let evidence = json!({"origin":origin,"email":email,"password":password,"tenant_id":actor.tenant_id,
        "patient_id":patient,"cases":cases,"provider_evidence":"injected local FakeBroker; no real Stripe calls",
        "normal_browser_auth_required":true,"counter_url":format!("{origin}/__fixture/status"),
        "initial_checkout_creates":2,"initial_receipts":0,"initial_ledger_entries":0,
        "expires_at":(Utc::now()+chrono::Duration::minutes(30)).to_rfc3339()});
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&output)
        .unwrap();
    file.write_all(serde_json::to_string_pretty(&evidence).unwrap().as_bytes())
        .unwrap();
    file.sync_all().unwrap();
    println!(
        "Local-only browser fixture prepared; protected login details in {}",
        output.display()
    );
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(1800),
        axum::serve(listener, app),
    )
    .await;
    if let Ok(result) = result {
        result.unwrap();
    }
}
