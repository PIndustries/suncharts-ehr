// SPDX-License-Identifier: AGPL-3.0-only
//! Staff sign-in invitations on a practice whose sign-in is handled by
//! SunCharts Connect. Connect is a local stand-in on a loopback port that
//! follows the published invitation contract; nothing here contacts a real
//! service and every person and address is synthetic.
use axum::{
    body::Body,
    extract::{Path, State as AxumState},
    http::{HeaderMap, Request, StatusCode},
    routing::{get, post},
    Json, Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use suncharts_engine::{browser::BrowserAuth, postgres::PostgresBackend, State};
use tower::ServiceExt;
use uuid::Uuid;

const ORIGIN: &str = "http://127.0.0.1:8099";
const TOKEN: &str = "scs_inst_synthetic_private_token_1234567890abcdefgh";
const OWNER_PASSWORD: &str = "synthetic-owner-emergency-2026";

/// One practice as the stand-in Connect sees it.
#[derive(Default)]
struct Clinic {
    /// Every answer is 503 while set.
    down: bool,
    /// The next N requests are answered 503, then service resumes.
    fail_next: u32,
    /// Invitation emails are not accepted by the mail provider while set.
    mail_fails: bool,
    /// Answer 429 while set.
    busy: bool,
    /// Existing Connect memberships by email: true is active.
    members: HashMap<String, bool>,
    records: Vec<Value>,
    /// (method, path after the installation, authorization, body)
    seen: Vec<(String, String, String, Value)>,
}
type Cloud = Arc<Mutex<HashMap<Uuid, Clinic>>>;

fn refuse(status: u16, code: &str, message: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::from_u16(status).unwrap(),
        Json(json!({"error":code,"message":message})),
    )
}
/// Records the request and applies the outage switches and the installation credential check.
fn admit(
    cloud: &Cloud,
    installation: Uuid,
    h: &HeaderMap,
    method: &str,
    path: &str,
    body: Value,
) -> Result<(), (StatusCode, Json<Value>)> {
    let mut all = cloud.lock().unwrap();
    let clinic = all.entry(installation).or_default();
    let authorization = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    clinic
        .seen
        .push((method.into(), path.into(), authorization.clone(), body));
    if clinic.down {
        return Err(refuse(503, "unavailable", "synthetic outage"));
    }
    if clinic.fail_next > 0 {
        clinic.fail_next -= 1;
        return Err(refuse(503, "unavailable", "synthetic brief outage"));
    }
    if authorization != format!("Bearer {TOKEN}") {
        return Err(refuse(401, "unauthorized", "authentication required"));
    }
    if clinic.busy {
        return Err(refuse(
            429,
            "rate_limited",
            "too many attempts; wait a few minutes and try again",
        ));
    }
    Ok(())
}
fn invite_for(clinic: &mut Clinic, v: &Value) -> Result<Value, (StatusCode, Json<Value>)> {
    let email = v["email"].as_str().unwrap_or_default().to_lowercase();
    if !email
        .split_once('@')
        .is_some_and(|(l, d)| !l.is_empty() && d.contains('.'))
    {
        return Err(refuse(400, "bad_request", "enter a valid email address"));
    }
    if !matches!(
        v["role"].as_str(),
        Some("owner" | "clinician" | "front_desk" | "read_only" | "nurse" | "medical_assistant")
    ) {
        return Err(refuse(400, "bad_request", "unsupported staff role"));
    }
    if let Some(old) = clinic
        .records
        .iter()
        .find(|r| r["request_id"] == v["request_id"])
    {
        let same = ["remote_user_id", "email", "display_name", "role"]
            .iter()
            .all(|k| old[*k] == v[*k]);
        return if same {
            Ok(old.clone())
        } else {
            Err(refuse(
                409,
                "conflict",
                "request_id is already bound to another invitation",
            ))
        };
    }
    let (state, delivery) = match clinic.members.get(&email) {
        Some(false) => {
            return Err(refuse(409,"conflict","this staff member has an inactive Connect membership; review it in Connect before inviting"))
        }
        Some(true) => (
            "accepted",
            json!({"transport":"none","accepted":false,"detail":"existing_active_membership"}),
        ),
        None => {
            // A new invitation replaces any outstanding one for the same email.
            for r in clinic
                .records
                .iter_mut()
                .filter(|r| r["email"] == email && r["state"] == "pending")
            {
                r["state"] = json!("revoked");
            }
            (
                "pending",
                if clinic.mail_fails {
                    json!({"transport":"email","accepted":false,"detail":"email_not_sent"})
                } else {
                    json!({"transport":"email","accepted":true,"detail":"provider_accepted"})
                },
            )
        }
    };
    let record = json!({"request_id":v["request_id"],"remote_user_id":v["remote_user_id"],"email":email,"display_name":v["display_name"],"role":v["role"],"invite_id":Uuid::new_v4(),"state":state,"delivery":delivery,"accepted_at":null,"expires_at":"2026-11-20T15:00:00Z","created_at":"2026-11-13T15:00:00Z"});
    clinic.records.insert(0, record.clone());
    Ok(record)
}
async fn cloud_list(
    AxumState(cloud): AxumState<Cloud>,
    Path(installation): Path<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    admit(
        &cloud,
        installation,
        &h,
        "GET",
        "/staff-invites",
        Value::Null,
    )?;
    let all = cloud.lock().unwrap();
    Ok(Json(
        json!({"has_more":false,"items":all[&installation].records}),
    ))
}
async fn cloud_create(
    AxumState(cloud): AxumState<Cloud>,
    Path(installation): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    admit(
        &cloud,
        installation,
        &h,
        "POST",
        "/staff-invites",
        v.clone(),
    )?;
    let mut all = cloud.lock().unwrap();
    invite_for(all.get_mut(&installation).unwrap(), &v).map(Json)
}
async fn cloud_resend(
    AxumState(cloud): AxumState<Cloud>,
    Path((installation, previous)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let path = format!("/staff-invites/{previous}/resend");
    admit(&cloud, installation, &h, "POST", &path, v.clone())?;
    let mut all = cloud.lock().unwrap();
    let clinic = all.get_mut(&installation).unwrap();
    let Some(old) = clinic
        .records
        .iter()
        .find(|r| r["request_id"] == previous.to_string())
        .cloned()
    else {
        return Err(refuse(404, "not_found", "not found"));
    };
    if v["request_id"] == previous.to_string() {
        return Err(refuse(
            400,
            "bad_request",
            "resend requires a new request_id",
        ));
    }
    let mut again = old;
    again["request_id"] = v["request_id"].clone();
    invite_for(clinic, &again).map(Json)
}
/// The stand-in runs on its own thread so it outlives each test's runtime.
/// Its address, the credential key and emergency sign-in are process-wide
/// settings shared by every test in this file.
fn cloud() -> &'static Cloud {
    static CLOUD: OnceLock<Cloud> = OnceLock::new();
    CLOUD.get_or_init(|| {
        let cloud: Cloud = Arc::default();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let keydir = std::env::temp_dir().join(format!("staff-invite-key-{}", Uuid::new_v4()));
        std::env::set_var("ENGINE_CREDENTIAL_KEY_FILE", keydir.join("master.key"));
        std::env::set_var("ENGINE_CONNECT_ALLOW_LOOPBACK", "true");
        std::env::set_var("ENGINE_CONNECT_CLOUD_URL", &base);
        std::env::set_var("ENGINE_BREAK_GLASS_LOCAL_AUTH", "true");
        let app = Router::new()
            .route(
                "/api/v1/ehr-services/installations/{installation}/staff-invites",
                get(cloud_list).post(cloud_create),
            )
            .route(
                "/api/v1/ehr-services/installations/{installation}/staff-invites/{request}/resend",
                post(cloud_resend),
            )
            .with_state(cloud.clone());
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                    axum::serve(listener, app).await.unwrap();
                });
        });
        cloud
    })
}

struct Fixture {
    db: PgPool,
    app: Router,
    tenant: Uuid,
    owner: Uuid,
    cookie: String,
    installation: Uuid,
    schema: String,
    url: String,
}
impl Fixture {
    fn clinic<T>(&self, f: impl FnOnce(&mut Clinic) -> T) -> T {
        f(cloud()
            .lock()
            .unwrap()
            .entry(self.installation)
            .or_default())
    }
    fn seen(&self) -> Vec<(String, String, String, Value)> {
        self.clinic(|c| c.seen.clone())
    }
    /// Requests that ask Connect to send something (everything but status reads).
    fn sends(&self) -> Vec<(String, Value)> {
        self.seen()
            .into_iter()
            .filter(|s| s.0 == "POST")
            .map(|s| (s.1, s.3))
            .collect()
    }
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Value,
        version: Option<i64>,
    ) -> (StatusCode, Value) {
        call(&self.app, &self.cookie, method, path, body, version).await
    }
    /// Sign-in status of one staff member, read from Connect now.
    async fn status(&self, id: &str) -> Value {
        let (code, v) = self
            .call(
                "GET",
                "/api/v1/practice/staff/invitations?fresh=true",
                Value::Null,
                None,
            )
            .await;
        assert_eq!(code, StatusCode::OK, "{v}");
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["staff_id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    }
    async fn add(&self, email: &str, role: &str) -> (StatusCode, Value) {
        self.call(
            "POST",
            "/api/v1/practice/staff",
            json!({"email":email,"display_name":"Synthetic Desk","role":role,"reason":"Synthetic hire"}),
            None,
        )
        .await
    }
    async fn history(&self, id: &str) -> Vec<Value> {
        sqlx::query_scalar("SELECT jsonb_build_object('reason',reason,'content',content) FROM practice_admin_history WHERE tenant_id=$1 AND kind='staff' AND resource_id=$2 ORDER BY version")
            .bind(self.tenant).bind(Uuid::parse_str(id).unwrap()).fetch_all(&self.db).await.unwrap()
    }
}
async fn session(db: &PgPool, tenant: Uuid, user: Uuid, cookie: &str, method: &str) {
    sqlx::query("INSERT INTO browser_sessions(token_hash,tenant_id,user_id,expires_at,auth_method) VALUES($1,$2,$3,now()+interval '1 hour',$4)").bind(format!("{:x}",Sha256::digest(cookie.as_bytes()))).bind(tenant).bind(user).bind(method).execute(db).await.unwrap();
}
async fn call(
    app: &Router,
    cookie: &str,
    method: &str,
    path: &str,
    body: Value,
    version: Option<i64>,
) -> (StatusCode, Value) {
    let mut q = Request::builder()
        .method(method)
        .uri(path)
        .header("Cookie", format!("sce_session={cookie}"))
        .header("Origin", ORIGIN);
    if let Some(v) = version {
        q = q.header("If-Match", format!("\"{v}\""));
    }
    let body = if body.is_null() {
        Body::empty()
    } else {
        q = q.header("Content-Type", "application/json");
        Body::from(body.to_string())
    };
    let response = app.clone().oneshot(q.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let data = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&data).unwrap_or(Value::Null))
}
/// A practice with one owner. `managed` connects it to the stand-in Connect,
/// after which the owner works through an emergency (break-glass) session,
/// the only local session a managed practice accepts.
async fn setup(managed: bool, owner_hash: &str) -> Fixture {
    cloud();
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("staff_invitations_{}", Uuid::new_v4().simple());
    let schema_clone = schema.clone();
    let base = PgPool::connect(&url).await.unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |c, _| {
            let query = format!("SET search_path TO {schema_clone}");
            Box::pin(async move {
                sqlx::query(&query).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::MIGRATOR.run(&db).await.unwrap();
    let (tenant, owner, installation) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role,display_name) VALUES($1,$2,$3,$4,'owner','Synthetic Owner')").bind(tenant).bind(owner).bind(format!("owner-{}@example.test",owner.simple())).bind(owner_hash).execute(&db).await.unwrap();
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: "synthetic-staff-invitation-test-secret".into(),
        allow_legacy_gateway: false,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), ORIGIN.into()).unwrap()),
    });
    let mut cookie = Uuid::new_v4().to_string();
    session(&db, tenant, owner, &cookie, "local").await;
    if managed {
        let services = "/api/v1/connect/services/settings";
        let (status, saved) = call(
            &app,
            &cookie,
            "PUT",
            services,
            json!({"installation_id":installation,"installation_token":TOKEN}),
            Some(0),
        )
        .await;
        assert_eq!(status, 200, "{saved}");
        // Verification fixture only; the real check calls the service.
        sqlx::query("UPDATE connect_service_settings SET verified=true WHERE tenant_id=$1")
            .bind(tenant)
            .execute(&db)
            .await
            .unwrap();
        let (status, enabled) = call(
            &app,
            &cookie,
            "POST",
            &format!("{services}/activation"),
            json!({"enabled":true}),
            Some(1),
        )
        .await;
        assert_eq!(status, 200, "{enabled}");
        // Password sessions stop working the moment Connect handles sign-in.
        assert_eq!(
            call(
                &app,
                &cookie,
                "GET",
                "/api/v1/practice/staff",
                Value::Null,
                None
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        cookie = Uuid::new_v4().to_string();
        session(&db, tenant, owner, &cookie, "break_glass").await;
    }
    Fixture {
        db,
        app,
        tenant,
        owner,
        cookie,
        installation,
        schema,
        url,
    }
}
async fn cleanup(f: Fixture) {
    f.db.close().await;
    let base = PgPool::connect(&f.url).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", f.schema))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
}
fn unique(name: &str) -> String {
    format!("{name}-{}@example.test", Uuid::new_v4().simple())
}

#[tokio::test]
async fn managed_create_invites_through_connect_and_takes_no_password() {
    let f = setup(true, "synthetic-not-a-login-hash").await;
    let (status, listed) = f
        .call("GET", "/api/v1/practice/staff", Value::Null, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["sign_in"], "connect");

    // A password is neither needed nor accepted, and a refused request creates nothing.
    let email = unique("desk");
    let (status, refused) = f
        .call(
            "POST",
            "/api/v1/practice/staff",
            json!({"email":email,"password":"synthetic-staff-password-2026","display_name":"Synthetic Desk","role":"front_desk","reason":"Synthetic hire"}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM browser_users WHERE tenant_id=$1")
        .bind(f.tenant)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(rows, 1);
    assert!(f.sends().is_empty());

    let (status, created) = f
        .add(&format!("  {}  ", email.to_uppercase()), "front_desk")
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(created["email"], email);
    assert_eq!(created["invitation"]["status"], "waiting");
    assert_eq!(created["invitation"]["sent_at"], "2026-11-13T15:00:00Z");
    assert_eq!(created["invitation"]["expires_at"], "2026-11-20T15:00:00Z");
    assert_eq!(created["version"], 2);
    assert!(created.get("password_hash").is_none());

    // Exactly one call, to this installation, with its credential and the contract body.
    let seen = f.seen();
    let posts: Vec<_> = seen.iter().filter(|s| s.0 == "POST").collect();
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].1, "/staff-invites");
    assert_eq!(posts[0].2, format!("Bearer {TOKEN}"));
    let body = &posts[0].3;
    let request = body["request_id"].as_str().unwrap();
    assert!(Uuid::parse_str(request).is_ok());
    assert_eq!(
        *body,
        json!({"request_id":request,"remote_user_id":id,"email":email,"display_name":"Synthetic Desk","role":"front_desk"})
    );

    // The stored hash is a real hash of bytes nobody kept, so no password signs in.
    let hash: String =
        sqlx::query_scalar("SELECT password_hash FROM browser_users WHERE tenant_id=$1 AND id=$2")
            .bind(f.tenant)
            .bind(Uuid::parse_str(&id).unwrap())
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert!(hash.starts_with("$argon2"));

    // The account's history says what happened and holds no link or token.
    let history = f.history(&id).await;
    assert_eq!(history.len(), 2);
    assert_eq!(history[0]["reason"], "Synthetic hire");
    assert_eq!(history[1]["reason"], "Invitation emailed");
    assert_eq!(history[1]["content"]["invitation_status"], "waiting");
    assert_eq!(history[1]["content"]["invitation_request"], request);
    let text = history[1].to_string();
    for secret in ["token", "invite_url", "invite_id", TOKEN] {
        assert!(!text.contains(secret), "{secret}");
    }
    let audited: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='practice.staff.invitation_requested' AND actor_id=$2 AND resource_id=$3").bind(f.tenant).bind(f.owner).bind(Uuid::parse_str(&id).unwrap()).fetch_one(&f.db).await.unwrap();
    assert_eq!(audited, 1);

    // The list shows them waiting, with the date the invitation runs out.
    let waiting = f.status(&id).await;
    assert_eq!(waiting["status"], "waiting");
    assert_eq!(waiting["expires_at"], "2026-11-20T15:00:00Z");

    // Once they accept, Connect reports it and the row needs no action.
    f.clinic(|c| c.records[0]["state"] = json!("accepted"));
    assert_eq!(f.status(&id).await["status"], "can_sign_in");
    // An invitation that ran out says so.
    f.clinic(|c| c.records[0]["state"] = json!("expired"));
    assert_eq!(f.status(&id).await["status"], "expired");
    cleanup(f).await;
}

#[tokio::test]
async fn a_brief_outage_is_retried_as_the_same_request() {
    let f = setup(true, "synthetic-not-a-login-hash").await;
    f.clinic(|c| c.fail_next = 1);
    let (status, created) = f.add(&unique("retry"), "nurse").await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["invitation"]["status"], "waiting");
    let sends = f.sends();
    assert_eq!(sends.len(), 2, "one failed attempt and one retry");
    assert_eq!(
        sends[0], sends[1],
        "the retry repeats the request_id and content"
    );
    assert_eq!(
        f.clinic(|c| c.records.len()),
        1,
        "Connect made one invitation"
    );
    assert_eq!(sends[0].1["role"], "nurse");
    cleanup(f).await;
}

#[tokio::test]
async fn someone_who_already_has_access_is_told_so_and_inactive_access_is_explained() {
    let f = setup(true, "synthetic-not-a-login-hash").await;
    let (member, former) = (unique("member"), unique("former"));
    f.clinic(|c| {
        c.members.insert(member.clone(), true);
        c.members.insert(former.clone(), false);
    });
    let (status, created) = f.add(&member, "clinician").await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["invitation"]["status"], "can_sign_in");
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(f.status(&id).await["status"], "can_sign_in");
    assert_eq!(
        f.history(&id).await[1]["reason"],
        "Invitation not needed: already has a SunCharts account"
    );

    // Connect refuses a turned-off membership; the account is still saved and the reason is kept.
    let (status, created) = f.add(&former, "front_desk").await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["invitation"]["status"], "access_off");
    let id = created["id"].as_str().unwrap().to_owned();
    let saved: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM browser_users WHERE tenant_id=$1 AND email=$2)",
    )
    .bind(f.tenant)
    .bind(&former)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert!(saved);
    assert_eq!(f.status(&id).await["status"], "access_off");
    assert_eq!(
        f.history(&id).await[1]["reason"],
        "Invitation not sent: this person's SunCharts access is turned off"
    );
    cleanup(f).await;
}

#[tokio::test]
async fn connect_down_keeps_the_account_and_a_later_send_works() {
    let f = setup(true, "synthetic-not-a-login-hash").await;
    f.clinic(|c| c.down = true);
    let email = unique("desk");
    let (status, created) = f.add(&email, "front_desk").await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(
        created["invitation"],
        json!({"status":"not_sent","reason":"unreachable","staff_id":created["id"],"version":2})
    );
    let id = created["id"].as_str().unwrap().to_owned();
    let listed = f
        .call("GET", "/api/v1/practice/staff", Value::Null, None)
        .await
        .1;
    assert!(listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x["id"] == id.as_str() && x["email"] == email.as_str()));
    assert_eq!(
        f.history(&id).await[1]["reason"],
        "Invitation not sent: SunCharts could not be reached"
    );
    let failed: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='practice.staff.invitation_failed' AND resource_id=$2").bind(f.tenant).bind(Uuid::parse_str(&id).unwrap()).fetch_one(&f.db).await.unwrap();
    assert_eq!(failed, 1);

    // While Connect is away the page still loads and says status is unavailable.
    let (status, away) = f
        .call(
            "GET",
            "/api/v1/practice/staff/invitations?fresh=true",
            Value::Null,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{away}");
    assert_eq!(away["available"], false);
    assert_eq!(f.status(&id).await["status"], "not_sent");

    // Back up: Connect has no record, so the row says the invitation was not sent, and why.
    f.clinic(|c| c.down = false);
    let row = f.status(&id).await;
    assert_eq!(
        (row["status"].as_str(), row["reason"].as_str()),
        (Some("not_sent"), Some("unreachable"))
    );

    // Other refusals keep the account too and are named.
    f.clinic(|c| c.busy = true);
    let path = format!("/api/v1/practice/staff/{id}/invitation");
    let (status, busy) = f.call("POST", &path, Value::Null, None).await;
    assert_eq!(status, StatusCode::OK, "{busy}");
    assert_eq!(
        (busy["status"].as_str(), busy["reason"].as_str()),
        (Some("not_sent"), Some("busy"))
    );
    f.clinic(|c| c.busy = false);

    let (status, sent) = f.call("POST", &path, Value::Null, None).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["status"], "waiting");
    assert_eq!(sent["staff_id"], id.as_str());
    assert_eq!(sent["version"], 4);
    assert_eq!(f.status(&id).await["status"], "waiting");
    let last = f.sends().last().cloned().unwrap();
    assert_eq!(last.0, "/staff-invites");
    assert_eq!(last.1["remote_user_id"], id.as_str());
    assert_eq!(last.1["email"], email.as_str());

    // An email the mail provider did not take is "not sent", with "send again" available.
    f.clinic(|c| c.mail_fails = true);
    let (_, undelivered) = f.call("POST", &path, Value::Null, None).await;
    assert_eq!(
        (
            undelivered["status"].as_str(),
            undelivered["reason"].as_str()
        ),
        (Some("not_sent"), Some("email_not_delivered"))
    );
    cleanup(f).await;
}

#[tokio::test]
async fn staff_made_before_invitations_show_not_invited_and_can_be_sent_one() {
    // The clinic's situation today: a front-desk account with a password nobody can use.
    let f = setup(true, "synthetic-not-a-login-hash").await;
    let (desk, signed_in) = (Uuid::new_v4(), Uuid::new_v4());
    let email = unique("frontdesk");
    for (id, email, name) in [
        (desk, email.clone(), "Synthetic Front Desk"),
        (signed_in, unique("clinician"), "Synthetic Clinician"),
    ] {
        sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role,display_name) VALUES($1,$2,$3,'synthetic-not-a-login-hash','front_desk',$4)").bind(f.tenant).bind(id).bind(email).bind(name).execute(&f.db).await.unwrap();
    }
    // Someone who has signed in through Connect before needs nothing.
    sqlx::query("INSERT INTO connect_identity_sessions(token_hash,tenant_id,issuer_tenant_id,user_id,grant_id,issuer,audience,expires_at) VALUES($1,$2,$3,$4,$5,'http://127.0.0.1:1',$6,now()+interval '1 hour')").bind(Uuid::new_v4().to_string()).bind(f.tenant).bind(Uuid::new_v4()).bind(signed_in).bind(Uuid::new_v4()).bind(ORIGIN).execute(&f.db).await.unwrap();
    assert_eq!(
        f.status(&signed_in.to_string()).await["status"],
        "can_sign_in"
    );
    assert_eq!(f.status(&desk.to_string()).await["status"], "not_invited");
    // The owner here works from an emergency session and has never used Connect.
    assert_eq!(
        f.status(&f.owner.to_string()).await["status"],
        "not_invited"
    );

    let path = format!("/api/v1/practice/staff/{desk}/invitation");
    let (status, sent) = f.call("POST", &path, Value::Null, None).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["status"], "waiting");
    let sends = f.sends();
    assert_eq!(sends.len(), 1);
    assert_eq!(
        sends[0].1,
        json!({"request_id":sends[0].1["request_id"],"remote_user_id":desk,"email":email,"display_name":"Synthetic Front Desk","role":"front_desk"})
    );
    assert_eq!(f.status(&desk.to_string()).await["status"], "waiting");
    f.clinic(|c| c.records[0]["state"] = json!("accepted"));
    assert_eq!(f.status(&desk.to_string()).await["status"], "can_sign_in");
    cleanup(f).await;
}

#[tokio::test]
async fn send_again_uses_a_new_request_id() {
    let f = setup(true, "synthetic-not-a-login-hash").await;
    let (_, created) = f.add(&unique("desk"), "front_desk").await;
    let id = created["id"].as_str().unwrap().to_owned();
    let first = f.sends()[0].1["request_id"].as_str().unwrap().to_owned();
    assert_eq!(f.status(&id).await["status"], "waiting");

    let path = format!("/api/v1/practice/staff/{id}/invitation");
    let (status, again) = f.call("POST", &path, Value::Null, None).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["status"], "waiting");
    let sends = f.sends();
    assert_eq!(sends.len(), 2);
    assert_eq!(sends[1].0, format!("/staff-invites/{first}/resend"));
    let second = sends[1].1["request_id"].as_str().unwrap().to_owned();
    assert_ne!(second, first);
    assert_eq!(sends[1].1, json!({"request_id":second}));
    // The earlier link is replaced; the newest invitation is the one that counts.
    assert_eq!(
        f.clinic(|c| c
            .records
            .iter()
            .map(|r| r["state"].clone())
            .collect::<Vec<_>>()),
        vec![json!("pending"), json!("revoked")]
    );
    assert_eq!(f.status(&id).await["status"], "waiting");

    // After a role change the next invitation carries the current role rather than repeating the old one.
    let (status, changed) = f
        .call(
            "PUT",
            &format!("/api/v1/practice/staff/{id}"),
            json!({"display_name":"Synthetic Desk","role":"read_only","disabled":false,"reason":"Synthetic role change"}),
            Some(again["version"].as_i64().unwrap()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert!(
        changed.get("invitation").is_none(),
        "a role change alone sends nothing"
    );
    assert_eq!(f.sends().len(), 2);
    let (_, third) = f.call("POST", &path, Value::Null, None).await;
    assert_eq!(third["status"], "waiting");
    let sends = f.sends();
    assert_eq!(sends[2].0, "/staff-invites");
    assert_eq!(sends[2].1["role"], "read_only");
    assert!(
        ![first.as_str(), second.as_str()].contains(&sends[2].1["request_id"].as_str().unwrap())
    );
    cleanup(f).await;
}

#[tokio::test]
async fn email_change_invites_the_new_address_and_disabling_still_blocks() {
    let f = setup(true, "synthetic-not-a-login-hash").await;
    let (old, new) = (unique("typo"), unique("fixed"));
    let (_, created) = f.add(&old, "front_desk").await;
    let id = created["id"].as_str().unwrap().to_owned();
    let user = Uuid::parse_str(&id).unwrap();
    // A sign-in from before the change must not make the new address look ready.
    sqlx::query("INSERT INTO connect_identity_sessions(token_hash,tenant_id,issuer_tenant_id,user_id,grant_id,issuer,audience,expires_at) VALUES($1,$2,$3,$4,$5,'http://127.0.0.1:1',$6,now()+interval '1 hour')").bind(Uuid::new_v4().to_string()).bind(f.tenant).bind(Uuid::new_v4()).bind(user).bind(Uuid::new_v4()).bind(ORIGIN).execute(&f.db).await.unwrap();
    assert_eq!(f.status(&id).await["status"], "can_sign_in");

    let path = format!("/api/v1/practice/staff/{id}");
    let change = |email: &str, disabled: bool| json!({"email":email,"display_name":"Synthetic Desk","role":"front_desk","disabled":disabled,"reason":"Synthetic correction"});
    let (status, changed) = f.call("PUT", &path, change(&new, false), Some(2)).await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(changed["email"], new.as_str());
    assert_eq!(changed["invitation"]["status"], "waiting");
    assert_eq!(changed["version"], 4);
    let last = f.sends().last().cloned().unwrap();
    assert_eq!(last.0, "/staff-invites");
    assert_eq!(last.1["email"], new.as_str());
    assert_eq!(last.1["remote_user_id"], id.as_str());
    let live: i64 = sqlx::query_scalar("SELECT count(*) FROM connect_identity_sessions WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL").bind(f.tenant).bind(user).fetch_one(&f.db).await.unwrap();
    assert_eq!(live, 0, "sessions for the old address are ended");
    // The old invitation and the old sign-in no longer count for this account.
    assert_eq!(f.status(&id).await["status"], "waiting");
    f.clinic(|c| c.records.retain(|r| r["email"] != new.as_str()));
    assert_eq!(f.status(&id).await["status"], "not_invited");

    // The same email again is not a change and sends nothing.
    let sends = f.sends().len();
    let (status, same) = f.call("PUT", &path, change(&new, false), Some(4)).await;
    assert_eq!(status, StatusCode::OK, "{same}");
    assert!(same.get("invitation").is_none());
    assert_eq!(f.sends().len(), sends);

    // An address another account uses, and an owner's own address, are refused.
    let other = unique("other");
    f.add(&other, "nurse").await;
    let (status, taken) = f.call("PUT", &path, change(&other, false), Some(5)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{taken}");
    let (status, own) = f
        .call(
            "PUT",
            &format!("/api/v1/practice/staff/{}", f.owner),
            json!({"email":unique("owner-new"),"display_name":"Synthetic Owner","role":"owner","disabled":false,"reason":"Synthetic"}),
            Some(1),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{own}");

    // Disabling works as before, sends nothing, and a disabled account cannot be invited.
    let sends = f.sends().len();
    let (status, off) = f.call("PUT", &path, change(&new, true), Some(5)).await;
    assert_eq!(status, StatusCode::OK, "{off}");
    assert_eq!(off["disabled"], true);
    assert_eq!(f.status(&id).await["status"], "disabled");
    let (status, refused) = f
        .call("POST", &format!("{path}/invitation"), Value::Null, None)
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(f.sends().len(), sends);
    cleanup(f).await;
}

#[tokio::test]
async fn only_an_owner_can_read_status_or_send_invitations() {
    let f = setup(true, "synthetic-not-a-login-hash").await;
    let (_, created) = f.add(&unique("desk"), "front_desk").await;
    let id = created["id"].as_str().unwrap().to_owned();
    let before = f.seen().len();
    for role in ["clinician", "front_desk", "nurse", "read_only"] {
        let user = Uuid::new_v4();
        sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-a-login-hash',$4)").bind(f.tenant).bind(user).bind(unique(role)).bind(role).execute(&f.db).await.unwrap();
        let cookie = Uuid::new_v4().to_string();
        session(&f.db, f.tenant, user, &cookie, "break_glass").await;
        for (method, path, body) in [
            (
                "GET",
                "/api/v1/practice/staff/invitations".to_owned(),
                Value::Null,
            ),
            (
                "POST",
                format!("/api/v1/practice/staff/{id}/invitation"),
                Value::Null,
            ),
            (
                "POST",
                "/api/v1/practice/staff".to_owned(),
                json!({"email":unique("x"),"display_name":"Synthetic","role":"front_desk","reason":"Synthetic"}),
            ),
        ] {
            let (status, v) = call(&f.app, &cookie, method, &path, body, None).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{role} {method} {path} {v}");
        }
    }
    // No session at all, another practice's staff id, and a cross-site request are refused too.
    let path = format!("/api/v1/practice/staff/{id}/invitation");
    assert_eq!(
        call(&f.app, "not-a-session", "POST", &path, Value::Null, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.call(
            "POST",
            &format!("/api/v1/practice/staff/{}/invitation", Uuid::new_v4()),
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let cross = Request::builder()
        .method("POST")
        .uri(&path)
        .header("Cookie", format!("sce_session={}", f.cookie))
        .header("Origin", "https://elsewhere.example.test")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        f.app.clone().oneshot(cross).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(f.seen().len(), before, "nothing reached Connect");
    cleanup(f).await;
}

#[tokio::test]
async fn a_practice_that_signs_in_with_passwords_is_unchanged() {
    let f = setup(false, "synthetic-not-a-login-hash").await;
    let (status, listed) = f
        .call("GET", "/api/v1/practice/staff", Value::Null, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["sign_in"], "password");
    let email = unique("nurse");
    let (status, missing) = f.add(&email, "nurse").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{missing}");
    let (status, created) = f
        .call(
            "POST",
            "/api/v1/practice/staff",
            json!({"email":email,"password":"synthetic-staff-password-2026","display_name":"Synthetic Nurse","role":"nurse","reason":"Synthetic hire"}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert!(created.get("invitation").is_none());
    assert_eq!(created["version"], 1);
    let id = created["id"].as_str().unwrap().to_owned();
    // The password they were given signs them in.
    let login = Request::builder()
        .method("POST")
        .uri("/auth/login")
        .header("Origin", ORIGIN)
        .header("Content-Type", "application/json")
        .body(Body::from(
            json!({"email":email,"password":"synthetic-staff-password-2026"}).to_string(),
        ))
        .unwrap();
    assert_eq!(
        f.app.clone().oneshot(login).await.unwrap().status(),
        StatusCode::OK
    );
    let (status, statuses) = f
        .call(
            "GET",
            "/api/v1/practice/staff/invitations",
            Value::Null,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{statuses}");
    assert_eq!(
        statuses,
        json!({"sign_in":"password","available":true,"items":[]})
    );
    let (status, none) = f
        .call(
            "POST",
            &format!("/api/v1/practice/staff/{id}/invitation"),
            Value::Null,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{none}");
    // An email can be corrected; no invitation is involved.
    let (status, changed) = f
        .call(
            "PUT",
            &format!("/api/v1/practice/staff/{id}"),
            json!({"email":unique("nurse-new"),"display_name":"Synthetic Nurse","role":"nurse","disabled":false,"password":"synthetic-staff-password-2027","reason":"Synthetic correction"}),
            Some(1),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert!(changed.get("invitation").is_none());
    assert_eq!(f.history(&id).await.len(), 2);
    assert!(f.seen().is_empty(), "Connect is never called");
    cleanup(f).await;
}

#[tokio::test]
async fn emergency_sign_in_is_neither_widened_nor_broken() {
    use argon2::{
        password_hash::{rand_core::OsRng, SaltString},
        Argon2, PasswordHasher,
    };
    let hash = Argon2::default()
        .hash_password(OWNER_PASSWORD.as_bytes(), &SaltString::generate(&mut OsRng))
        .unwrap()
        .to_string();
    let f = setup(true, &hash).await;
    let owner_email: String = sqlx::query_scalar("SELECT email FROM browser_users WHERE id=$1")
        .bind(f.owner)
        .fetch_one(&f.db)
        .await
        .unwrap();
    let login = |path: &'static str, email: String, password: String| {
        let app = f.app.clone();
        async move {
            let request = Request::builder()
                .method("POST")
                .uri(path)
                .header("Origin", ORIGIN)
                .header("Content-Type", "application/json")
                .body(Body::from(
                    json!({"email":email,"password":password}).to_string(),
                ))
                .unwrap();
            app.oneshot(request).await.unwrap().status()
        }
    };
    // As before: the owner's emergency password works only on the emergency route.
    assert_eq!(
        login(
            "/auth/recovery/login",
            owner_email.clone(),
            OWNER_PASSWORD.into()
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        login("/auth/login", owner_email.clone(), OWNER_PASSWORD.into()).await,
        StatusCode::UNAUTHORIZED
    );

    // A second owner and a front-desk account added on the managed practice get no usable password.
    let (second, desk) = (unique("owner2"), unique("desk"));
    let (_, created) = f.add(&second, "owner").await;
    let second_id = created["id"].as_str().unwrap().to_owned();
    let (_, created_desk) = f.add(&desk, "front_desk").await;
    let desk_id = created_desk["id"].as_str().unwrap().to_owned();
    for (email, password) in [
        (second.clone(), ""),
        (second.clone(), "synthetic-staff-password-2026"),
        (desk.clone(), "synthetic-staff-password-2026"),
    ] {
        for path in ["/auth/recovery/login", "/auth/login"] {
            assert_eq!(
                login(path, email.clone(), password.into()).await,
                StatusCode::UNAUTHORIZED,
                "{path}"
            );
        }
    }

    // Staff who are not owners cannot be given a password on a managed practice.
    let (status, refused) = f
        .call(
            "PUT",
            &format!("/api/v1/practice/staff/{desk_id}"),
            json!({"display_name":"Synthetic Desk","role":"front_desk","disabled":false,"password":"synthetic-staff-password-2026","reason":"Synthetic"}),
            Some(2),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    // An owner's emergency password can still be set by an owner, and still only opens the emergency route.
    let (status, set) = f
        .call(
            "PUT",
            &format!("/api/v1/practice/staff/{second_id}"),
            json!({"display_name":"Synthetic Desk","role":"owner","disabled":false,"password":"synthetic-second-owner-2026","reason":"Synthetic emergency access"}),
            Some(2),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    assert_eq!(
        login(
            "/auth/recovery/login",
            second.clone(),
            "synthetic-second-owner-2026".into()
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        login("/auth/login", second, "synthetic-second-owner-2026".into()).await,
        StatusCode::UNAUTHORIZED
    );
    cleanup(f).await;
}
