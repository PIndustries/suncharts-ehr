// SPDX-License-Identifier: AGPL-3.0-only
//! Public code catalogs shipped inside the binary and installed for every practice, so no
//! practice ever uploads ICD-10-CM, ICD-10-PCS or HCPCS. The files come from `catalogs/` and
//! `catalogs/manifest.json`; the manifest records each edition and its SHA-256. CPT is never
//! bundled and never written here: it stays behind its own licensed install path.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    terminology::{self, Import},
};
use chrono::Utc;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

const MANIFEST: &str = include_str!("../catalogs/manifest.json");

/// Fixed identity recorded as the installer. Every row it writes carries a tenant of its own,
/// is audited as `terminology.release.installed_builtin`, and is auditable to this one id.
pub const BUILTIN_CATALOG_ACTOR: Uuid = Uuid::from_u128(0x53c40000000040008000000000000051);

/// Every shipped catalog: the file name it is known by and its gzip bytes, compiled in.
pub const BUILTIN: &[(&str, &[u8])] = &[
    (
        "icd-10-cm-FY2026.json.gz",
        include_bytes!("../catalogs/icd-10-cm-FY2026.json.gz"),
    ),
    (
        "icd-10-cm-FY2027.json.gz",
        include_bytes!("../catalogs/icd-10-cm-FY2027.json.gz"),
    ),
    (
        "icd-10-pcs-FY2027.json.gz",
        include_bytes!("../catalogs/icd-10-pcs-FY2027.json.gz"),
    ),
    (
        "hcpcs-2026-01.json.gz",
        include_bytes!("../catalogs/hcpcs-2026-01.json.gz"),
    ),
    (
        "hcpcs-2026-04.json.gz",
        include_bytes!("../catalogs/hcpcs-2026-04.json.gz"),
    ),
    (
        "hcpcs-2026-07.json.gz",
        include_bytes!("../catalogs/hcpcs-2026-07.json.gz"),
    ),
    (
        "hcpcs-2026-10.json.gz",
        include_bytes!("../catalogs/hcpcs-2026-10.json.gz"),
    ),
    (
        "hcpcs-2027-01.json.gz",
        include_bytes!("../catalogs/hcpcs-2027-01.json.gz"),
    ),
];

/// One `catalogs/manifest.json` dataset entry.
#[derive(Deserialize)]
struct Dataset {
    file: String,
    system: String,
    edition: String,
    sha256: String,
    /// Compared against the embedded files by the tests below, so this field is read only under
    /// `cargo test` and the non-test build reports it unused.
    #[cfg_attr(not(test), allow(dead_code))]
    code_count: usize,
}

#[derive(Deserialize)]
struct Manifest {
    datasets: Vec<Dataset>,
}

fn manifest() -> Result<Vec<Dataset>> {
    let parsed: Manifest = serde_json::from_str(MANIFEST)
        .map_err(|_| Error::Integrity("the shipped catalog manifest cannot be read"))?;
    Ok(parsed.datasets)
}

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn gunzip(bytes: &[u8]) -> Result<Vec<u8>> {
    use std::io::Read;
    // The largest catalog expands to a few tens of MiB; refuse anything far beyond that rather
    // than trusting an embedded blob.
    const LIMIT: u64 = 256 * 1024 * 1024;
    let mut plain = Vec::new();
    std::io::Read::read_to_end(
        &mut flate2::read::GzDecoder::new(bytes).take(LIMIT),
        &mut plain,
    )
    .map_err(|_| Error::Integrity("a shipped catalog could not be decompressed"))?;
    if plain.len() as u64 >= LIMIT {
        return Err(Error::Integrity("a shipped catalog is too large"));
    }
    Ok(plain)
}

/// Every practice, as one tenant id per practice. There is no dedicated practices table:
/// `browser_users` is the table with exactly one row per person in a practice and its bootstrap
/// owner is the first row written when a practice is created, so its distinct tenant ids are the
/// practices. A tenant with no staff user yet picks the lists up on a later pass.
async fn practices(pool: &PgPool) -> Result<Vec<Uuid>> {
    Ok(
        sqlx::query_scalar("SELECT DISTINCT tenant_id FROM browser_users ORDER BY tenant_id")
            .fetch_all(pool)
            .await?,
    )
}

/// The system Actor that installs built-in catalogs for a practice: an owner of that practice and
/// of nothing else, with the fixed audit subject above.
fn actor(tenant_id: Uuid) -> Actor {
    let now = Utc::now().timestamp();
    Actor {
        sub: BUILTIN_CATALOG_ACTOR,
        tenant_id,
        role: Role::Owner,
        patient_id: None,
        iss: "suncharts-builtin-catalogs".into(),
        aud: "suncharts-engine".into(),
        iat: now,
        exp: now + 120,
    }
}

/// Installs one shipped catalog for one practice, in its own transaction, as the built-in actor
/// with the built-in audit action. Returns whether a release was created.
///
/// Two servers starting at once settle here rather than colliding: `store_release` takes the
/// tenant's import lock and then re-reads (system, edition) and the request id, so the loser
/// replays as "not created". A concurrent insert that lands as a unique violation rather than a
/// replay is turned into the same quiet answer.
async fn store_builtin(pool: &PgPool, tenant_id: Uuid, input: &Import) -> Result<bool> {
    let actor = actor(tenant_id);
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        // A pool or server problem is the pass's own failure, so it goes back to the caller.
        Err(e) => return Err(Error::Database(e)),
    };
    let created = match terminology::store_release(
        &mut tx,
        &actor,
        input,
        "terminology.release.installed_builtin",
    )
    .await
    {
        Ok((_, created)) => created,
        // The edition or request already exists, with identical content. Nothing is wrong and
        // nothing is logged as a failure.
        Err(Error::Conflict(_)) => {
            let _ = tx.rollback().await;
            return Ok(false);
        }
        // A unique violation is a concurrent installer winning the same race one step later.
        Err(Error::Database(e))
            if e.as_database_error()
                .is_some_and(|d| d.code().as_deref() == Some("23505")) =>
        {
            let _ = tx.rollback().await;
            return Ok(false);
        }
        Err(e) => {
            let _ = tx.rollback().await;
            return Err(e);
        }
    };
    tx.commit().await?;
    Ok(created)
}

/// (system, edition) already stored for a tenant. A catalog is keyed by its system and edition
/// rather than a row id, so a practice that already holds a list is recognised whichever server
/// installed it and under whichever request id. Read once per practice per pass: a practice
/// holding every list costs two reads in total and no decompression at all.
async fn held(pool: &PgPool, tenant: Uuid) -> Result<Vec<(String, String)>> {
    Ok(
        sqlx::query_as("SELECT system, edition FROM terminology_releases WHERE tenant_id=$1")
            .bind(tenant)
            .fetch_all(pool)
            .await?,
    )
}

/// Decompresses, parses and validates one shipped catalog, confirming it declares exactly what
/// the manifest says it is.
pub(crate) fn decode(gz: &[u8], system: &str, edition: &str) -> Result<Import> {
    let mut input: Import = serde_json::from_slice(&gunzip(gz)?)
        .map_err(|_| Error::Integrity("a shipped catalog cannot be parsed"))?;
    // validate() normalises the system name, so compare before it runs.
    if terminology::canonical_system(&input.system)? != system || input.edition != edition {
        return Err(Error::Integrity(
            "a shipped catalog names a different system or edition than its manifest entry",
        ));
    }
    // validate() rejects a CPT release that is not licensed, which is the point: nothing shipped
    // in the binary can install a proprietary CPT list. Each file's request id is UUIDv5 over
    // "system/edition" in a fixed namespace, so every server derives the same one.
    input.validate()?;
    Ok(input)
}

/// Installs every shipped catalog every practice does not already have. Returns the number of
/// releases created. Each (tenant, catalog) pair is independent: one failure is logged and the
/// rest continue.
pub async fn install_missing(pool: &PgPool, catalogs: &[(&str, &[u8])]) -> Result<usize> {
    let datasets = manifest()?;
    // Verify every embedded file against the manifest before any of it reaches the database.
    let mut wanted = Vec::with_capacity(catalogs.len());
    for (name, gz) in catalogs {
        let entry = datasets
            .iter()
            .find(|entry| entry.file == *name)
            .ok_or_else(|| Error::Integrity("a shipped catalog is not listed in the manifest"))?;
        if hex_sha256(gz) != entry.sha256 {
            return Err(Error::Integrity(
                "a shipped catalog does not match its manifest digest",
            ));
        }
        wanted.push((name, gz, entry));
    }
    let mut created = 0usize;
    for tenant in practices(pool).await? {
        // One read tells us every edition this practice already has.
        let releases = held(pool, tenant).await?;
        for (name, gz, entry) in &wanted {
            // A practice that has the list costs nothing further for it: no decompression, no
            // import, no audit row. Each catalog is decompressed one at a time.
            let missing = !releases
                .iter()
                .any(|(system, edition)| *system == entry.system && *edition == entry.edition);
            if !missing {
                continue;
            }
            let input = match decode(gz, &entry.system, &entry.edition) {
                Ok(input) => input,
                // A damaged shipped file is not this practice's problem: log it, and carry on
                // with the other catalogs and the other practices.
                Err(e) => {
                    eprintln!("built-in catalog {name} could not be prepared: {e}");
                    continue;
                }
            };
            match store_builtin(pool, tenant, &input).await {
                Ok(true) => created += 1,
                Ok(false) => {}
                // One failed release is not this practice's whole pass: log it, carry on with
                // the other catalogs and the other practices.
                Err(e) => eprintln!("built-in catalog {name} failed for tenant {tenant}: {e}"),
            }
        }
    }
    Ok(created)
}

/// Startup worker: the first pass runs 30 s after boot, then every 6 hours, so a practice
/// created after this server started receives the lists too. Failures are logged and retried on
/// the next pass; the loop itself never stops.
pub async fn run(pool: PgPool) {
    let mut tick = tokio::time::interval_at(
        tokio::time::Instant::now() + std::time::Duration::from_secs(30),
        std::time::Duration::from_secs(6 * 60 * 60),
    );
    loop {
        tick.tick().await;
        match install_missing(&pool, BUILTIN).await {
            Ok(0) => {}
            Ok(created) => eprintln!("built-in catalogs: installed {created} releases"),
            Err(e) => eprintln!("built-in catalogs: pass skipped ({e})"),
        }
    }
}

#[cfg(test)]
#[path = "builtin_catalogs_tests.rs"]
mod tests_db;

#[cfg(test)]
mod tests {
    use super::*;

    /// Every manifest entry is embedded and its bytes match, and nothing extra is embedded.
    #[test]
    fn every_shipped_catalog_matches_the_manifest() {
        let datasets = manifest().expect("manifest parses");
        assert_eq!(
            datasets.len(),
            BUILTIN.len(),
            "manifest and embedded catalogs differ in size"
        );
        for entry in &datasets {
            let embedded = BUILTIN
                .iter()
                .find(|(name, _)| *name == entry.file)
                .unwrap_or_else(|| panic!("{} is not embedded", entry.file));
            assert_eq!(
                hex_sha256(embedded.1),
                entry.sha256,
                "{} does not match its manifest digest",
                entry.file
            );
            assert_ne!(entry.system, "CPT", "CPT is never shipped");
        }
        for (name, _) in BUILTIN {
            assert!(
                datasets.iter().any(|entry| entry.file == *name),
                "{name} is embedded but not in the manifest"
            );
        }
    }

    /// A shipped file expands, parses, validates and holds exactly the code count the manifest
    /// records, so the install path cannot silently truncate or reject a list.
    #[test]
    fn each_shipped_catalog_validates_with_its_manifest_code_count() {
        for entry in manifest().expect("manifest parses") {
            let (_, gz) = BUILTIN
                .iter()
                .find(|(name, _)| *name == entry.file)
                .expect("checked by the digest test");
            let input = decode(gz, &entry.system, &entry.edition)
                .unwrap_or_else(|e| panic!("{} cannot be installed: {e}", entry.file));
            assert_eq!(
                input.codes.len(),
                entry.code_count,
                "{} code count",
                entry.file
            );
            assert_ne!(input.system, "CPT", "{} must not be CPT", entry.file);
        }
    }
}
