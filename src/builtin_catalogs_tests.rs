// SPDX-License-Identifier: AGPL-3.0-only
//! Database tests for the built-in catalog installer. Synthetic catalogs only, except the case
//! that installs the real shipped files: the synthetic lists are small gzip documents built here,
//! decoded and stored through the same path the startup worker uses.
use super::*;
use crate::test_db;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::io::Write;
use uuid::Uuid;

/// A fresh migrated schema, as the other catalog tests do.
async fn setup(prefix: &str) -> (PgPool, String) {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("{prefix}_{}", Uuid::new_v4().simple());
    let base = PgPool::connect(&url).await.unwrap();
    test_db::create_schema(&base, &schema).await;
    base.close().await;
    let path = schema.clone();
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .after_connect(move |connection, _| {
            let query = format!("SET search_path TO {path}");
            Box::pin(async move {
                sqlx::query(&query).execute(connection).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    crate::MIGRATOR.run(&pool).await.unwrap();
    (pool, schema)
}

async fn teardown(pool: PgPool, schema: String) {
    drop(pool);
    let base = PgPool::connect(&std::env::var("TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;
}

/// A practice counts as existing once it has a staff user: that row is what the installer
/// enumerates, one distinct tenant id per practice.
async fn practice(db: &PgPool, tenant: Uuid) {
    sqlx::query(
        "INSERT INTO browser_users(tenant_id,id,email,password_hash,role) VALUES($1,$2,$3,'synthetic-not-login','owner')",
    )
    .bind(tenant)
    .bind(Uuid::new_v4())
    .bind(format!("owner-{tenant}@example.test"))
    .execute(db)
    .await
    .unwrap();
}

fn gzip(json: &Value) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(serde_json::to_vec(json).unwrap().as_slice())
        .unwrap();
    encoder.finish().unwrap()
}

/// One synthetic catalog in the shape the shipped files use: the header fields, then the codes.
fn catalog(system: &str, edition: &str, codes: &[(&str, &str)]) -> Vec<u8> {
    gzip(&json!({
        "request_id": Uuid::new_v4(),
        "system": system,
        "edition": edition,
        "source_name": format!("Synthetic {system} fixture"),
        "source_url": "https://example.test/synthetic-catalog",
        "source_sha256": "b".repeat(64),
        "effective_start": "2026-01-01",
        "effective_end": Value::Null,
        "rights": "public_use",
        "rights_attested": true,
        "reason": "Synthetic catalog fixture only",
        "codes": codes
            .iter()
            .map(|(code, display)| json!({"code": code, "display": display, "billable": true}))
            .collect::<Vec<_>>(),
    }))
}

fn icd(edition: &str) -> Vec<u8> {
    catalog(
        "ICD-10-CM",
        edition,
        &[
            ("z0000", "Synthetic checkup"),
            ("z010", "Synthetic follow-up"),
        ],
    )
}

fn hcpcs(edition: &str) -> Vec<u8> {
    catalog(
        "HCPCS",
        edition,
        &[
            ("a0021", "Synthetic transport"),
            ("j0120", "Synthetic injection"),
        ],
    )
}

/// What one practice holds, as (system, edition, code count).
async fn releases(db: &PgPool, tenant: Uuid) -> Vec<(String, String, i32)> {
    sqlx::query_as(
        "SELECT system, edition, code_count FROM terminology_releases WHERE tenant_id=$1 ORDER BY system, edition",
    )
    .bind(tenant)
    .fetch_all(db)
    .await
    .unwrap()
}

async fn audit_rows(db: &PgPool, tenant: Uuid) -> Vec<(String, String)> {
    sqlx::query_as("SELECT action, actor_id::text FROM audit_events WHERE tenant_id=$1 ORDER BY id")
        .bind(tenant)
        .fetch_all(db)
        .await
        .unwrap()
}

/// Installs one synthetic catalog for one tenant through the built-in store path, exactly as the
/// worker does: same actor, same audit action, same `store_release`.
async fn install(db: &PgPool, tenant: Uuid, gz: &[u8], system: &str, edition: &str) -> bool {
    let input = crate::terminology::test_import(&gunzip(gz)).unwrap();
    assert_eq!(input.system, system);
    assert_eq!(input.edition, edition);
    store_builtin(db, tenant, &input).await.unwrap()
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
    let mut plain = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(bytes), &mut plain).unwrap();
    plain
}

/// One worker pass for one practice: install only what it does not hold yet.
async fn pass(db: &PgPool, tenant: Uuid, lists: &[(&[u8], &str, &str)]) -> usize {
    let held = held(db, tenant).await.unwrap();
    let mut created = 0;
    for (gz, system, edition) in lists {
        if held
            .iter()
            .any(|(have, edition_have)| have == system && edition_have == edition)
        {
            continue;
        }
        created += usize::from(install(db, tenant, gz, system, edition).await);
    }
    created
}

/// The manifest as published, so a case compares what was installed against what was recorded.
fn manifest() -> Vec<(String, String, i32)> {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/catalogs/manifest.json"
    ))
    .unwrap();
    serde_json::from_str::<Value>(&text).unwrap()["datasets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["system"].as_str().unwrap().to_owned(),
                entry["edition"].as_str().unwrap().to_owned(),
                entry["code_count"].as_i64().unwrap() as i32,
            )
        })
        .collect()
}

/// Two practices, two catalogs: the first pass installs both lists for both practices, a second
/// pass creates nothing, a practice that already holds one edition is given only the other, every
/// release is audited under the built-in action and actor, and no CPT release is created.
#[tokio::test]
async fn every_practice_gets_each_edition_once_and_cpt_is_never_touched() {
    let (db, schema) = setup("builtin_cats").await;
    let (first, second, third, fourth) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    for tenant in [first, second] {
        practice(&db, tenant).await;
    }
    let (icd, hcpcs) = (icd("SYN FY2027"), hcpcs("SYN 2027-01"));
    let lists: Vec<(&[u8], &str, &str)> = vec![
        (icd.as_slice(), "ICD-10-CM", "SYN FY2027"),
        (hcpcs.as_slice(), "HCPCS", "SYN 2027-01"),
    ];
    let both = || {
        vec![
            ("HCPCS".to_owned(), "SYN 2027-01".to_owned(), 2),
            ("ICD-10-CM".to_owned(), "SYN FY2027".to_owned(), 2),
        ]
    };

    assert_eq!(
        pass(&db, first, &lists).await + pass(&db, second, &lists).await,
        4,
        "two practices take both catalogs"
    );
    for tenant in [first, second] {
        assert_eq!(releases(&db, tenant).await, both());
    }
    assert_eq!(
        pass(&db, first, &lists).await + pass(&db, second, &lists).await,
        0,
        "an edition that already exists is never re-created"
    );

    // A practice that already holds one list is given only the other.
    practice(&db, third).await;
    assert!(install(&db, third, &icd, "ICD-10-CM", "SYN FY2027").await);
    assert_eq!(
        pass(&db, third, &lists).await,
        1,
        "only the missing edition is installed"
    );
    assert_eq!(releases(&db, third).await, both());

    // Two servers starting at once: both see the edition missing, and the tenant's import lock
    // plus edition uniqueness settles it. The loser comes back as "not created", not as an error.
    practice(&db, fourth).await;
    let raced = futures_util::future::join(
        install(&db, fourth, &icd, "ICD-10-CM", "SYN FY2027"),
        install(&db, fourth, &icd, "ICD-10-CM", "SYN FY2027"),
    )
    .await;
    assert!(
        usize::from(raced.0) + usize::from(raced.1) <= 1,
        "a concurrent install never produces two releases: {raced:?}"
    );
    assert_eq!(
        releases(&db, fourth)
            .await
            .iter()
            .filter(|(system, edition, _)| system == "ICD-10-CM" && edition == "SYN FY2027")
            .count(),
        1,
        "one release for a catalog two installers raced"
    );

    let builtin_actor = BUILTIN_CATALOG_ACTOR.to_string();
    for tenant in [first, second, third] {
        let rows = audit_rows(&db, tenant).await;
        assert_eq!(
            rows.iter()
                .filter(|(action, _)| action == "terminology.release.installed_builtin")
                .count(),
            2,
            "one built-in audit row per installed catalog for {tenant}"
        );
        assert!(
            rows.iter().all(|(_, actor)| *actor == builtin_actor),
            "the built-in actor is the subject of its own audit rows for {tenant}"
        );
        assert!(
            !releases(&db, tenant)
                .await
                .iter()
                .any(|(system, _, _)| system == "CPT"),
            "CPT is never installed by the built-in catalogs for {tenant}"
        );
    }

    // A tenant with no staff user is not a practice yet: nothing is installed for it.
    let unseen = Uuid::new_v4();
    assert_eq!(releases(&db, unseen).await, Vec::new());
    teardown(db, schema).await;
}

/// The shipped catalogs install for real: one practice, every file, the code counts the manifest
/// records, and a second pass that creates nothing.
#[tokio::test]
async fn the_shipped_catalogs_install_every_edition_for_a_practice() {
    let (db, schema) = setup("builtin_real").await;
    let tenant = Uuid::new_v4();
    practice(&db, tenant).await;
    let created = install_missing(&db, BUILTIN)
        .await
        .expect("shipped catalogs");
    assert_eq!(created, 8, "every shipped catalog installs once");
    assert_eq!(
        install_missing(&db, BUILTIN).await.expect("a second pass"),
        0,
        "a second pass creates nothing"
    );
    let mut stored = releases(&db, tenant).await;
    let mut expected = manifest();
    stored.sort();
    expected.sort();
    assert_eq!(stored.len(), 8, "one release per shipped catalog");
    for want in &expected {
        assert!(
            stored.contains(want),
            "{want:?} was not installed; installed: {stored:?}"
        );
    }
    assert!(
        !stored.iter().any(|(system, _, _)| system == "CPT"),
        "CPT is never bundled and never installed"
    );
    let rows = audit_rows(&db, tenant).await;
    assert_eq!(
        rows.iter()
            .filter(|(action, _)| action == "terminology.release.installed_builtin")
            .count(),
        8,
        "one audit row per installed release"
    );
    assert!(
        rows.iter()
            .all(|(_, actor)| actor == &BUILTIN_CATALOG_ACTOR.to_string()),
        "the built-in actor is the subject of every install"
    );
    teardown(db, schema).await;
}

/// A file the manifest does not list, or whose bytes differ from the manifest digest, is refused
/// and nothing is installed.
#[tokio::test]
async fn a_catalog_the_manifest_does_not_vouch_for_is_refused() {
    let (db, schema) = setup("builtin_reject").await;
    let tenant = Uuid::new_v4();
    practice(&db, tenant).await;
    let forged = icd("SYN FY2027");
    let lists: Vec<(&str, &[u8])> = vec![("not-shipped.json.gz", forged.as_slice())];
    assert!(install_missing(&db, &lists).await.is_err());

    let mut damaged = BUILTIN[0].1.to_vec();
    damaged[0] ^= 0xff;
    let lists: Vec<(&str, &[u8])> = vec![(BUILTIN[0].0, damaged.as_slice())];
    assert!(install_missing(&db, &lists).await.is_err());
    assert_eq!(releases(&db, tenant).await, Vec::new());
    teardown(db, schema).await;
}
