// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic data only: a made-up fee schedule file built in the test, never the CMS file.
use super::*;
use crate::{browser::BrowserAuth, postgres::PostgresBackend};
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use sha2::{Digest, Sha256};
use sqlx::postgres::PgPoolOptions;
use std::io::Write;
use std::sync::Arc;
use tower::ServiceExt;

const SECRET: &str = "synthetic-cpt-install-test-secret";
const CSV: &str = "\
,,2026 National Physician Fee Schedule Relative Value File,,\n\
HCPCS,MOD,DESCRIPTION,CODE,PAYMENT\n\
99213,26,Office visit professional part,A,\n\
99213,,Office o/p est low 20 min,A,\n\
99214,,Office o/p est mod 30 min,A,\n\
99214,TC,Office visit technical part,A,\n\
J0585,,Botulinum toxin a per unit,E,\n\
0001F,,\"Heart failure, composite\",M,\n\
99999,,Deleted synthetic service,D,\n\
1234,,Too short,A,\n\
55555,,,A,\n";

fn archive(member: &str, body: &str) -> Vec<u8> {
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    out.start_file(member, zip::write::SimpleFileOptions::default())
        .unwrap();
    out.write_all(body.as_bytes()).unwrap();
    out.finish().unwrap().into_inner()
}
fn source(bytes: &[u8]) -> CptSource {
    CptSource {
        edition: "synthetic CPT edition",
        source_name: "Synthetic fee schedule file",
        url: "https://example.test/synthetic.zip",
        sha256: Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str()),
        member: "SYNTHETIC.csv",
        effective_start: (2026, 1, 1),
    }
}

#[test]
fn cpt_archive_takes_one_row_per_cpt_code() {
    let bytes = archive("SYNTHETIC.csv", CSV);
    let input = cpt_import_from_archive(
        &bytes,
        &source(&bytes),
        "Synthetic license",
        None,
        Uuid::new_v4(),
    )
    .unwrap();
    let rows: Vec<(&str, &str, bool)> = input
        .codes
        .iter()
        .map(|c| (c.code.as_str(), c.display.as_str(), c.active))
        .collect();
    assert_eq!(
        rows,
        vec![
            ("0001F", "Heart failure, composite", true),
            ("99213", "Office o/p est low 20 min", true),
            ("99214", "Office o/p est mod 30 min", true),
            ("99999", "Deleted synthetic service", false),
        ]
    );
    assert_eq!(input.codes[0].metadata, json!({"medicare_status":"M"}));
    assert_eq!(
        (input.system.as_str(), input.rights.as_str()),
        ("CPT", "licensed")
    );
    assert_eq!(
        input.license_reference.as_deref(),
        Some("Synthetic license")
    );
}
#[test]
fn cpt_archive_refuses_other_versions_and_shapes() {
    let bytes = archive("SYNTHETIC.csv", CSV);
    let mut wrong = source(&bytes);
    wrong.sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
    assert!(cpt_import_from_archive(&bytes, &wrong, "x", None, Uuid::new_v4()).is_err());
    let headless = archive("SYNTHETIC.csv", "99213,,Office visit,A\n");
    assert!(
        cpt_import_from_archive(&headless, &source(&headless), "x", None, Uuid::new_v4()).is_err()
    );
    let other = archive("OTHER.csv", CSV);
    assert!(cpt_import_from_archive(&other, &source(&other), "x", None, Uuid::new_v4()).is_err());
    assert!(cpt_import_from_archive(
        b"not a zip",
        &source(b"not a zip"),
        "x",
        None,
        Uuid::new_v4()
    )
    .is_err());
}
#[test]
fn csv_fields_keep_quoted_commas() {
    assert_eq!(
        csv_fields("a,\"b, c\",\"d \"\"e\"\"\",,f"),
        vec!["a", "b, c", "d \"e\"", "", "f"]
    );
}

struct Fixture {
    db: PgPool,
    app: Router,
    owner: Actor,
}
async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("cpt_install_test_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    crate::test_db::create_schema(&base, &schema).await;
    base.close().await;
    let db = PgPoolOptions::new()
        .max_connections(4)
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
    let now = Utc::now().timestamp();
    let owner = Actor {
        sub: Uuid::new_v4(),
        tenant_id: Uuid::new_v4(),
        role: Role::Owner,
        patient_id: None,
        iss: "suncharts".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    };
    let app = crate::app(State {
        backend: Arc::new(PostgresBackend(db.clone())),
        secret: SECRET.into(),
        allow_legacy_gateway: true,
        issuer: "suncharts".into(),
        audience: "suncharts-engine".into(),
        browser: Some(BrowserAuth::new(db.clone(), "http://127.0.0.1:8099".into()).unwrap()),
    });
    Fixture { db, app, owner }
}
async fn call(f: &Fixture, actor: &Actor, path: &str, body: Value) -> (u16, Value) {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        actor,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = f.app.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn licensed_owner_installs_cpt_once_and_others_cannot() {
    let f = setup().await;
    let bytes = archive("SYNTHETIC.csv", CSV);
    let synthetic = source(&bytes);
    let (release, created) = install_cpt(
        &f.db,
        &f.owner,
        (Uuid::new_v4(), "Synthetic license 1", None),
        &synthetic,
        &bytes,
    )
    .await
    .unwrap();
    assert!(created);
    assert_eq!(
        (
            release["system"].as_str(),
            release["code_count"].as_i64(),
            release["rights"].as_str()
        ),
        (Some("CPT"), Some(4), Some("licensed"))
    );
    let action: String =
        sqlx::query_scalar("SELECT action FROM audit_events WHERE tenant_id=$1 AND resource_id=$2")
            .bind(f.owner.tenant_id)
            .bind(Uuid::parse_str(release["id"].as_str().unwrap()).unwrap())
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(action, "terminology.release.cpt_installed");
    let codes: Vec<String> =
        sqlx::query_scalar("SELECT code FROM terminology_codes WHERE tenant_id=$1 ORDER BY code")
            .bind(f.owner.tenant_id)
            .fetch_all(&f.db)
            .await
            .unwrap();
    assert_eq!(codes, ["0001F", "99213", "99214", "99999"]);
    // The same edition again is refused as a different import rather than stored twice.
    assert!(install_cpt(
        &f.db,
        &f.owner,
        (Uuid::new_v4(), "Synthetic license 2", None),
        &synthetic,
        &bytes
    )
    .await
    .is_err());
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM terminology_releases WHERE tenant_id=$1")
            .bind(f.owner.tenant_id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(count, 1);
    // The install route: owners only, a license must be attested and named, and nothing is
    // downloaded for these refusals.
    let front = Actor {
        sub: Uuid::new_v4(),
        role: Role::FrontDesk,
        ..f.owner.clone()
    };
    let good = json!({"request_id":Uuid::new_v4(),"license_attested":true,"license_reference":"Synthetic license"});
    assert_eq!(
        call(&f, &front, "/api/v1/terminology/cpt-install", good.clone())
            .await
            .0,
        403
    );
    assert_eq!(
        call(
            &f,
            &f.owner,
            "/api/v1/terminology/cpt-install",
            json!({"request_id":Uuid::new_v4(),"license_attested":false,"license_reference":"x"})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(
            &f,
            &f.owner,
            "/api/v1/terminology/cpt-install",
            json!({"request_id":Uuid::new_v4(),"license_attested":true,"license_reference":"  "})
        )
        .await
        .0,
        400
    );
    assert_eq!(call(&f, &f.owner, "/api/v1/terminology/cpt-install", json!({"request_id":Uuid::new_v4(),"license_attested":true,"license_reference":"x","license_valid_until":"2000-01-01"})).await.0, 400);
    // A practice that already has the built-in edition gets it back without a download.
    let other = Fixture {
        owner: Actor {
            tenant_id: Uuid::new_v4(),
            sub: Uuid::new_v4(),
            ..f.owner.clone()
        },
        ..f
    };
    let mut input = cpt_import_from_archive(
        &bytes,
        &synthetic,
        "Synthetic license",
        None,
        Uuid::new_v4(),
    )
    .unwrap();
    input.edition = CPT_SOURCE.edition.into();
    let mut tx = other.db.begin().await.unwrap();
    store_release(
        &mut tx,
        &other.owner,
        &input,
        "terminology.release.cpt_installed",
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let (status, body) = call(
        &other,
        &other.owner,
        "/api/v1/terminology/cpt-install",
        good,
    )
    .await;
    assert_eq!(
        (status, body["created"].as_bool()),
        (200, Some(false)),
        "{body}"
    );
    // The ordinary file import still works through the same storage path.
    let (status, body) = call(&other, &other.owner, "/api/v1/terminology/releases", json!({"request_id":Uuid::new_v4(),"system":"HCPCS","edition":"synthetic","source_name":"Synthetic fixture","source_url":"https://example.test/catalog","source_sha256":"a".repeat(64),"effective_start":"2026-10-01","effective_end":null,"rights":"public_use","rights_attested":true,"license_reference":null,"license_valid_until":null,"reason":"Synthetic only","codes":[{"code":"J0585","display":"Synthetic drug","billable":true}]})).await;
    assert_eq!(
        (status, body["created"].as_bool()),
        (200, Some(true)),
        "{body}"
    );
}
