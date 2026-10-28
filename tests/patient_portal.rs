// SPDX-License-Identifier: AGPL-3.0-only
//! Native patient identity and explicit publication boundaries, using synthetic records.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::Arc;
use suncharts_engine::{browser::BrowserAuth, postgres::PostgresBackend, State};
use tower::ServiceExt;
use uuid::Uuid;
const ORIGIN: &str = "http://127.0.0.1:8099";
struct Fixture {
    db: PgPool,
    app: Router,
    tenant: Uuid,
    user: Uuid,
    patient: Uuid,
    other: Uuid,
    staff: String,
}
impl Fixture {
    async fn new() -> Self {
        let url =
            std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
        let initial = PgPool::connect(&url).await.unwrap();
        let schema = format!("portal_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&initial)
            .await
            .unwrap();
        initial.close().await;
        let db = PgPoolOptions::new()
            .max_connections(8)
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
        suncharts_engine::MIGRATOR.run(&db).await.unwrap();
        let tenant = Uuid::new_v4();
        let user = Uuid::new_v4();
        let patient = Uuid::new_v4();
        let other = Uuid::new_v4();
        for (p, mrn) in [(patient, "PORTAL-1"), (other, "PORTAL-2")] {
            sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Synthetic','Patient','2000-01-01')").bind(tenant).bind(p).bind(mrn).execute(&db).await.unwrap();
        }
        let staff = staff_session(&db, tenant, user, "clinician").await;
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
            patient,
            other,
            staff,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        cookie: &str,
        body: Option<Value>,
        version: Option<i64>,
    ) -> (StatusCode, Value, String) {
        let account = if let Some(token) = cookie.strip_prefix("sce_portal=") {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT account_id FROM patient_portal_sessions WHERE token_hash=$1",
            )
            .bind(format!("{:x}", Sha256::digest(token.as_bytes())))
            .fetch_optional(&self.db)
            .await
            .unwrap()
        } else {
            None
        };
        request(
            &self.app, method, path, cookie, body, version, ORIGIN, account,
        )
        .await
    }
    async fn invite(&self, p: Uuid, email: &str, version: i64) -> Value {
        let (status, value, _) = self
            .request(
                "POST",
                &format!("/api/v1/patients/{p}/portal/invite"),
                &self.staff,
                Some(json!({"email":email,"reason":"Verified synthetic identity"})),
                Some(version),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{value}");
        value
    }
    async fn activate(&self, url: &str) -> (StatusCode, Value, String) {
        self.request("POST","/api/v1/patient-portal/activate","",Some(json!({"token":url.split("#invite=").nth(1).unwrap(),"password":"synthetic strong passphrase 2026"})),None).await
    }
    async fn login(&self, email: &str) -> String {
        let(status,value,cookie)=self.request("POST","/api/v1/patient-portal/login","",Some(json!({"practice_id":self.tenant,"email":email,"password":"synthetic strong passphrase 2026"})),None).await;
        assert_eq!(status, StatusCode::OK, "{value}");
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        cookie.split(';').next().unwrap().to_string()
    }
    async fn portal(&self, p: Uuid, email: &str) -> String {
        let invite = self.invite(p, email, 0).await;
        assert_eq!(
            self.activate(invite["invitation_url"].as_str().unwrap())
                .await
                .0,
            StatusCode::OK
        );
        self.login(email).await
    }
    async fn appointment(&self, p: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at) VALUES($1,$2,$3,$4,now()+interval '5 days',now()+interval '5 days 30 minutes')").bind(self.tenant).bind(id).bind(p).bind(self.user).execute(&self.db).await.unwrap();
        id
    }
    async fn signed_avs(&self) -> Uuid {
        let ap = self.appointment(self.patient).await;
        let visit = Uuid::new_v4();
        sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,note,signed_by,signed_at) VALUES($1,$2,$3,$4,$5,'signed','{}',$5,now())").bind(self.tenant).bind(visit).bind(self.patient).bind(ap).bind(self.user).execute(&self.db).await.unwrap();
        for version in [1i64, 2] {
            sqlx::query("INSERT INTO avs_releases(tenant_id,visit_id,version,content,snapshot,released_by,reason) VALUES($1,$2,$3,$4,$5,$6,'Reviewed synthetic instructions')").bind(self.tenant).bind(visit).bind(version).bind(json!({"instructions":format!("Instructions version {version}"),"follow_up_instructions":"Return in a week","private":"DO NOT RELEASE"})).bind(json!({"patient":{"given_name":"Synthetic"},"visit":{"id":visit,"staff_note":"DO NOT RELEASE"},"medications":[{"title":"Reviewed medication","staff_note":"DO NOT RELEASE"}],"orders":[],"snapshot_at":"2026-10-27T00:00:00Z","internal":"DO NOT RELEASE"})).bind(self.user).execute(&self.db).await.unwrap();
        }
        visit
    }
}
async fn staff_session(db: &PgPool, tenant: Uuid, user: Uuid, role: &str) -> String {
    sqlx::query("INSERT INTO browser_users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,'unused',$4)").bind(user).bind(tenant).bind(format!("{}@example.test",user)).bind(role).execute(db).await.unwrap();
    let token = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(format!("{:x}",Sha256::digest(token.as_bytes()))).bind(tenant).bind(user).execute(db).await.unwrap();
    format!("sce_session={token}")
}
#[allow(clippy::too_many_arguments)]
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    cookie: &str,
    body: Option<Value>,
    version: Option<i64>,
    origin: &str,
    account: Option<Uuid>,
) -> (StatusCode, Value, String) {
    let mut r = Request::builder()
        .method(method)
        .uri(path)
        .header("Cookie", cookie)
        .header("Origin", origin);
    if let Some(version) = version {
        r = r.header("If-Match", format!("\"{version}\""));
    }
    if let Some(account) = account {
        r = r.header("X-SunCharts-Portal-Account", account.to_string());
    }
    let data = if let Some(body) = body {
        r = r.header("Content-Type", "application/json");
        body.to_string()
    } else {
        String::new()
    };
    let response = app
        .clone()
        .oneshot(r.body(Body::from(data)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("Set-Cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(json!({}));
    (status, value, cookie)
}
#[tokio::test]
async fn invitation_single_use_expiry_replacement_origin_logout_and_revocation() {
    let f = Fixture::new().await;
    let inv = f.invite(f.patient, "patient@example.test", 0).await;
    let link = inv["invitation_url"].as_str().unwrap();
    assert_eq!(f.activate(link).await.0, StatusCode::OK);
    assert_eq!(f.activate(link).await.0, StatusCode::UNAUTHORIZED);
    let cookie = f.login("patient@example.test").await;
    assert_eq!(
        f.request(
            "GET",
            "/api/v1/patient-portal/dashboard",
            &f.staff,
            None,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED,
        "staff identity must never become patient identity"
    );
    assert_eq!(
        request(
            &f.app,
            "POST",
            "/api/v1/patient-portal/logout",
            &cookie,
            Some(json!({})),
            None,
            "https://evil.example",
            None,
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request(
            "POST",
            "/api/v1/patient-portal/logout",
            &cookie,
            Some(json!({})),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.request(
            "GET",
            "/api/v1/patient-portal/dashboard",
            &cookie,
            None,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let cookie = f.login("patient@example.test").await;
    assert_eq!(
        f.request(
            "POST",
            &format!("/api/v1/patients/{}/portal/revoke", f.patient),
            &f.staff,
            Some(json!({"reason":"Synthetic revoke"})),
            Some(2)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.request(
            "GET",
            "/api/v1/patient-portal/dashboard",
            &cookie,
            None,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let replacement = f.invite(f.patient, "patient@example.test", 3).await;
    assert_eq!(f.activate(link).await.0, StatusCode::UNAUTHORIZED);
    sqlx::query("UPDATE patient_portal_invites SET expires_at=now()-interval '1 second' WHERE used_at IS NULL").execute(&f.db).await.unwrap();
    assert_eq!(
        f.activate(replacement["invitation_url"].as_str().unwrap())
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let newest = f.invite(f.patient, "patient@example.test", 4).await;
    assert_eq!(
        f.activate(newest["invitation_url"].as_str().unwrap())
            .await
            .0,
        StatusCode::OK
    );
    let hashes: Vec<String> = sqlx::query_scalar("SELECT token_hash FROM patient_portal_invites")
        .fetch_all(&f.db)
        .await
        .unwrap();
    assert!(hashes.iter().all(|h| !link.contains(h)));
}
#[tokio::test]
async fn pinned_release_default_deny_cross_patient_and_staff_role() {
    let f = Fixture::new().await;
    let cookie = f.portal(f.patient, "one@example.test").await;
    let other_cookie = f.portal(f.other, "two@example.test").await;
    let visit = f.signed_avs().await;
    let path = format!("/api/v1/patient-portal/avs/{visit}");
    assert_eq!(
        f.request("GET", &path, &cookie, None, None).await.0,
        StatusCode::NOT_FOUND
    );
    let staffpath = format!("/api/v1/patients/{}/portal/avs/{visit}", f.patient);
    let front = staff_session(&f.db, f.tenant, Uuid::new_v4(), "front_desk").await;
    assert_eq!(
        f.request(
            "POST",
            &staffpath,
            &front,
            Some(json!({"avs_version":1,"visible":true,"reason":"Reviewed"})),
            Some(0)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request(
            "POST",
            &staffpath,
            &f.staff,
            Some(json!({"avs_version":1,"visible":true,"reason":"Reviewed"})),
            Some(0)
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, value, _) = f.request("GET", &path, &cookie, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["version"], 1);
    assert_eq!(value["instructions"], "Instructions version 1");
    assert!(!value.to_string().contains("DO NOT RELEASE"));
    assert_eq!(
        f.request("GET", &path, &other_cookie, None, None).await.0,
        StatusCode::NOT_FOUND
    );
    let foreign = staff_session(&f.db, Uuid::new_v4(), Uuid::new_v4(), "owner").await;
    assert_eq!(
        f.request(
            "GET",
            &format!("/api/v1/patients/{}/portal", f.patient),
            &foreign,
            None,
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.request(
            "POST",
            &staffpath,
            &f.staff,
            Some(json!({"avs_version":2,"visible":true,"reason":"New version reviewed"})),
            Some(0)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.request(
            "POST",
            &staffpath,
            &f.staff,
            Some(json!({"avs_version":1,"visible":false,"reason":"Withdrawn"})),
            Some(1)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.request("GET", &path, &cookie, None, None).await.0,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn concurrent_messages_idempotency_closed_threads_and_isolation() {
    let f = Fixture::new().await;
    let cookie = f.portal(f.patient, "one@example.test").await;
    let other = f.portal(f.other, "two@example.test").await;
    let req = Uuid::new_v4();
    let body = json!({"request_id":req,"kind":"message","appointment_id":null,"subject":"Synthetic question","body":"Nonurgent synthetic question"});
    let first = f.request(
        "POST",
        "/api/v1/patient-portal/threads",
        &cookie,
        Some(body.clone()),
        None,
    );
    let second = f.request(
        "POST",
        "/api/v1/patient-portal/threads",
        &cookie,
        Some(body),
        None,
    );
    let (a, b) = tokio::join!(first, second);
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert_eq!(a.1["id"], b.1["id"]);
    let id = a.1["id"].as_str().unwrap();
    let path = format!("/api/v1/patient-portal/threads/{id}");
    assert_eq!(
        f.request("GET", &path, &other, None, None).await.0,
        StatusCode::NOT_FOUND
    );
    let staffpath = format!("/api/v1/portal-inbox/{id}");
    let request_a = Uuid::new_v4();
    let request_b = Uuid::new_v4();
    let r1 = f.request(
        "POST",
        &staffpath,
        &f.staff,
        Some(json!({"request_id":request_a,"body":"First staff reply"})),
        Some(1),
    );
    let r2 = f.request(
        "POST",
        &staffpath,
        &f.staff,
        Some(json!({"request_id":request_b,"body":"Concurrent staff reply"})),
        Some(1),
    );
    let (a, b) = tokio::join!(r1, r2);
    assert!(
        (a.0 == StatusCode::OK && b.0 == StatusCode::CONFLICT)
            || (b.0 == StatusCode::OK && a.0 == StatusCode::CONFLICT),
        "{a:?} {b:?}"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM patient_portal_messages")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(count, 2);
    assert_eq!(
        f.request(
            "POST",
            &format!("{staffpath}/status"),
            &f.staff,
            Some(json!({"status":"closed","reason":"Resolved synthetic request"})),
            Some(2)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.request(
            "POST",
            &path,
            &cookie,
            Some(json!({"request_id":Uuid::new_v4(),"body":"Late reply"})),
            Some(3)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let ro = staff_session(&f.db, f.tenant, Uuid::new_v4(), "read_only").await;
    assert_eq!(
        f.request("GET", "/api/v1/portal-inbox", &ro, None, None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert!(
        sqlx::query("UPDATE patient_portal_messages SET body='changed'")
            .execute(&f.db)
            .await
            .is_err()
    );
    let other_appointment = f.appointment(f.other).await;
    assert_eq!(f.request("POST","/api/v1/patient-portal/threads",&cookie,Some(json!({"request_id":Uuid::new_v4(),"kind":"appointment_change","appointment_id":other_appointment,"subject":"Change","body":"Please change"})),None).await.0,StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn stale_tab_cannot_read_write_or_logout_a_different_cookie_account() {
    let f = Fixture::new().await;
    let cookie_a = f.portal(f.patient, "account-a@example.test").await;
    let cookie_b = f.portal(f.other, "account-b@example.test").await;
    let (_, session_a, _) = f
        .request(
            "GET",
            "/api/v1/patient-portal/session",
            &cookie_a,
            None,
            None,
        )
        .await;
    let (_, session_b, _) = f
        .request(
            "GET",
            "/api/v1/patient-portal/session",
            &cookie_b,
            None,
            None,
        )
        .await;
    assert_eq!(
        session_a.as_object().unwrap().len(),
        1,
        "bootstrap must return identity only, without PHI"
    );
    let a = Uuid::parse_str(session_a["account_id"].as_str().unwrap()).unwrap();
    assert_ne!(session_a["account_id"], session_b["account_id"]);
    for (method, path, body) in [
        ("GET", "/api/v1/patient-portal/dashboard", None),
        ("GET", "/api/v1/patient-portal/threads", None),
        (
            "POST",
            "/api/v1/patient-portal/threads",
            Some(
                json!({"request_id":Uuid::new_v4(),"kind":"message","appointment_id":null,"subject":"Account A draft","body":"Private text from account A"}),
            ),
        ),
        ("POST", "/api/v1/patient-portal/logout", Some(json!({}))),
    ] {
        let (status, value, set_cookie) =
            request(&f.app, method, path, &cookie_b, body, None, ORIGIN, Some(a)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{method} {path}: {value}");
        assert!(
            set_cookie.is_empty(),
            "a stale tab must not expire the current account's cookie"
        );
        assert!(!value.to_string().contains("Private text"));
    }
    assert_eq!(
        f.request(
            "GET",
            "/api/v1/patient-portal/dashboard",
            &cookie_b,
            None,
            None
        )
        .await
        .0,
        StatusCode::OK,
        "other tab's valid session remains intact"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM patient_portal_threads")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(count, 0, "A's private draft must never be persisted for B");
    assert_eq!(
        request(
            &f.app,
            "GET",
            "/api/v1/patient-portal/dashboard",
            &cookie_b,
            None,
            None,
            ORIGIN,
            None
        )
        .await
        .0,
        StatusCode::CONFLICT,
        "patient data requires an explicit account binding"
    );
}

#[tokio::test]
async fn authentication_budget_does_not_persist_an_installation_wide_lockout() {
    let f = Fixture::new().await;
    sqlx::query("INSERT INTO patient_portal_rate_limits(key,attempts) VALUES('login-global',10000),('activate-global',10000)").execute(&f.db).await.unwrap();
    let cookie = f.portal(f.patient, "unaffected@example.test").await;
    assert_eq!(
        f.request(
            "GET",
            "/api/v1/patient-portal/dashboard",
            &cookie,
            None,
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let key = format!(
        "{:x}",
        Sha256::digest(format!("{}:{}", f.tenant, "blocked@example.test").as_bytes())
    );
    sqlx::query("INSERT INTO patient_portal_rate_limits(key,attempts) VALUES($1,11)")
        .bind(key)
        .execute(&f.db)
        .await
        .unwrap();
    let(status,_,_)=f.request("POST","/api/v1/patient-portal/login","",Some(json!({"practice_id":f.tenant,"email":"blocked@example.test","password":"synthetic strong passphrase 2026"})),None).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "per-account attempt limits remain enforced"
    );
    let cookie = f.login("unaffected@example.test").await;
    assert_eq!(
        f.request(
            "GET",
            "/api/v1/patient-portal/dashboard",
            &cookie,
            None,
            None
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn appointment_change_requests_only_accept_booked_or_checked_in_visits() {
    let f = Fixture::new().await;
    let cookie = f.portal(f.patient, "schedule-patient@example.test").await;
    for status in [
        "booked",
        "checked_in",
        "in_progress",
        "completed",
        "cancelled",
        "no_show",
    ] {
        let appointment = f.appointment(f.patient).await;
        sqlx::query(
            "UPDATE appointments SET status=$3,version=version+1 WHERE tenant_id=$1 AND id=$2",
        )
        .bind(f.tenant)
        .bind(appointment)
        .bind(status)
        .execute(&f.db)
        .await
        .unwrap();
        let request_id = Uuid::new_v4();
        let body = json!({"request_id":request_id,"kind":"appointment_change","appointment_id":appointment,"subject":"Appointment change","body":"Please review my requested change"});
        let (response, value, _) = f
            .request(
                "POST",
                "/api/v1/patient-portal/threads",
                &cookie,
                Some(body.clone()),
                None,
            )
            .await;
        let allowed = matches!(status, "booked" | "checked_in");
        assert_eq!(
            response,
            if allowed {
                StatusCode::OK
            } else {
                StatusCode::CONFLICT
            },
            "{status}: {value}"
        );
        let saved: String =
            sqlx::query_scalar("SELECT status FROM appointments WHERE tenant_id=$1 AND id=$2")
                .bind(f.tenant)
                .bind(appointment)
                .fetch_one(&f.db)
                .await
                .unwrap();
        assert_eq!(
            saved, status,
            "requests must never change the booking automatically"
        );
        if status == "booked" {
            sqlx::query("UPDATE appointments SET status='completed',version=version+1 WHERE tenant_id=$1 AND id=$2").bind(f.tenant).bind(appointment).execute(&f.db).await.unwrap();
            let (replay, replayed, _) = f
                .request(
                    "POST",
                    "/api/v1/patient-portal/threads",
                    &cookie,
                    Some(body),
                    None,
                )
                .await;
            assert_eq!(
                replay,
                StatusCode::OK,
                "a confirmed historical request remains safely retryable"
            );
            assert_eq!(replayed["id"], value["id"]);
            assert_eq!(f.request("POST","/api/v1/patient-portal/threads",&cookie,Some(json!({"request_id":Uuid::new_v4(),"kind":"appointment_change","appointment_id":appointment,"subject":"Another change","body":"New request after completion"})),None).await.0,StatusCode::CONFLICT);
        }
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM patient_portal_threads WHERE kind='appointment_change'",
    )
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(count, 2);
}
