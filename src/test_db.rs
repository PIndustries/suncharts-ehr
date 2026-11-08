// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! Disposable per-test Postgres schemas.
//!
//! Database tests each create their own schema in the database named by
//! `TEST_DATABASE_URL` and run the migrations inside it. Nothing drops those
//! schemas when a test ends, so each one is recorded in
//! `suncharts_test_registry.schema_owners` with the host and process that made it. The
//! first schema a test process creates also drops every recorded schema whose
//! process has exited on this host, plus any from other hosts older than a day.
//! Leftovers are therefore bounded to the most recent run, including runs that
//! crashed or were killed.
#![doc(hidden)]

use sqlx::PgPool;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// Arbitrary constant serialising creation of the owners table. The table
/// lives in its own schema because some tests drop and recreate `public`.
const OWNERS_TABLE_LOCK: i64 = 0x5375_6e43_6861_7274;
static SWEPT: AtomicBool = AtomicBool::new(false);

/// Creates `schema` on `pool`, records this process as its owner and, once per
/// process, drops schemas left behind by test processes that have exited.
pub async fn create_schema(pool: &PgPool, schema: &str) {
    assert!(
        !schema.is_empty()
            && schema
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
        "test schema name must be lowercase letters, digits and underscores: {schema}"
    );
    ensure_owners_table(pool).await;
    if !SWEPT.swap(true, Ordering::SeqCst) {
        sweep(pool).await;
    }
    sqlx::query("INSERT INTO suncharts_test_registry.schema_owners (schema_name, host, pid) VALUES ($1, $2, $3)")
        .bind(schema)
        .bind(host())
        .bind(std::process::id() as i32)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(pool)
        .await
        .unwrap();
}

async fn ensure_owners_table(pool: &PgPool) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(OWNERS_TABLE_LOCK)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("CREATE SCHEMA IF NOT EXISTS suncharts_test_registry")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS suncharts_test_registry.schema_owners (
            schema_name text PRIMARY KEY,
            host text NOT NULL,
            pid integer NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

/// Best effort: another process may be sweeping the same rows, so failures
/// are ignored and picked up by a later run.
async fn sweep(pool: &PgPool) {
    let Ok(rows) = sqlx::query_as::<_, (String, String, i32, bool)>(
        "SELECT schema_name, host, pid, created_at < now() - interval '24 hours'
         FROM suncharts_test_registry.schema_owners",
    )
    .fetch_all(pool)
    .await
    else {
        return;
    };
    let me = std::process::id() as i32;
    for (schema, owner_host, pid, old) in rows {
        let dead = if owner_host == host() {
            pid != me && !process_alive(pid)
        } else {
            old
        };
        if !dead {
            continue;
        }
        let dropped = sqlx::query(&format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"))
            .execute(pool)
            .await;
        if dropped.is_ok() {
            let _ = sqlx::query(
                "DELETE FROM suncharts_test_registry.schema_owners WHERE schema_name = $1",
            )
            .bind(&schema)
            .execute(pool)
            .await;
        }
    }
}

fn host() -> &'static str {
    static HOST: OnceLock<String> = OnceLock::new();
    HOST.get_or_init(|| {
        Command::new("hostname")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|h| h.trim().to_owned())
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| "unknown-host".to_owned())
    })
}

/// `ps -p` succeeds for any live process, whoever owns it. If `ps` cannot be
/// run the process is assumed alive so a live test never loses its schema.
fn process_alive(pid: i32) -> bool {
    Command::new("ps")
        .args(["-p", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(true)
}
