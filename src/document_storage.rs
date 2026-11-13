// SPDX-License-Identifier: AGPL-3.0-only
//! Owner-only view of where patient files are kept, and the operator-started
//! move of files out of database rows into file storage.
//!
//! Nothing here runs on its own. Each call moves a bounded batch; every file
//! is stored, read back, decrypted and compared with the hash and size
//! recorded at upload before its row is switched, in the same transaction as
//! its audit event. A file that cannot be verified stays in the database.
use crate::{
    auth::Actor,
    document_store::{sha256_hex, DocumentStore},
    error::{Error, Result},
    State,
};
use axum::{
    extract::State as ExtractState,
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::time::{Duration, Instant};
use uuid::Uuid;

const BATCH_FILES: usize = 25;
const BATCH_BYTES: i64 = 200 * 1024 * 1024;
/// Rows looked at per call, so files that cannot be moved never stall a batch.
const BATCH_EXAMINED: usize = 100;
const BATCH_TIME: Duration = Duration::from_secs(45);
const NOT_CONFIGURED: &str = "File storage is not set up on this server.";
const DATABASE_COPY_DAMAGED: &str =
    "The saved copy does not match its recorded fingerprint. The file was left where it is.";
const STORED_COPY_UNVERIFIED: &str =
    "The stored copy could not be verified. The file was left where it is.";

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/practice/document-storage", get(status))
        .route("/api/v1/practice/document-storage/move", post(move_files))
}
fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
/// Files and bytes held in each location for one practice.
async fn counts(pool: &PgPool, tenant: Uuid) -> Result<Value> {
    let rows: Vec<(String, i64, i64)> = sqlx::query_as("SELECT storage,count(*)::bigint,coalesce(sum(size_bytes),0)::bigint FROM (SELECT storage,size_bytes FROM patient_documents WHERE tenant_id=$1 UNION ALL SELECT storage,size_bytes FROM patient_document_file_versions WHERE tenant_id=$1) f GROUP BY storage")
        .bind(tenant)
        .fetch_all(pool)
        .await?;
    let mut out = json!({"database":{"count":0,"bytes":0},"s3":{"count":0,"bytes":0}});
    for (storage, count, bytes) in rows {
        out[storage] = json!({"count":count,"bytes":bytes});
    }
    Ok(out)
}
async fn status(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let a = crate::practice_admin::owner(&s, &h, false).await?;
    let store = &s.browser.as_ref().ok_or(Error::NotFound)?.documents;
    let mut tx = db(&s)?.begin().await?;
    crate::partner_support::verify_owner_in_tx(&mut tx, &a, &h).await?;
    crate::postgres::audit(&mut tx, &a, "practice.document_storage.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({
        "mode": store.mode(),
        "storage_available": store.reachable(),
        "files": counts(db(&s)?, a.tenant_id).await?,
    })))
}

enum Table {
    Originals,
    Versions,
}
enum Outcome {
    Moved(i64),
    Failed(Uuid, i64, &'static str),
    /// File storage did not answer; nothing was changed.
    Down,
}
/// Moves the next file after `cursor` that is still in the database, or
/// returns `None` when this table has none left past it. `SKIP LOCKED` lets
/// concurrent calls work on different files; the row lock is held from the
/// read of the bytes to the switch so nothing can change in between.
async fn move_next(
    pool: &PgPool,
    store: &DocumentStore,
    a: &Actor,
    table: &Table,
    cursor: &mut Option<(Uuid, i64)>,
) -> Result<Option<Outcome>> {
    let mut tx = pool.begin().await?;
    let after = cursor.map(|c| c.0);
    let after_version = cursor.map(|c| c.1).unwrap_or(0);
    let row: Option<(Uuid, i64, Option<Vec<u8>>, String, i64)> = match table {
        Table::Originals => sqlx::query_as("SELECT id,1::bigint,bytes,sha256,size_bytes FROM patient_documents WHERE tenant_id=$1 AND storage='database' AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED")
            .bind(a.tenant_id)
            .bind(after)
            .fetch_optional(&mut *tx)
            .await?,
        Table::Versions => sqlx::query_as("SELECT document_id,version,bytes,sha256,size_bytes FROM patient_document_file_versions WHERE tenant_id=$1 AND storage='database' AND ($2::uuid IS NULL OR (document_id,version)>($2,$3)) ORDER BY document_id,version LIMIT 1 FOR UPDATE SKIP LOCKED")
            .bind(a.tenant_id)
            .bind(after)
            .bind(after_version)
            .fetch_optional(&mut *tx)
            .await?,
    };
    let Some((document, version, bytes, sha256, size_bytes)) = row else {
        return Ok(None);
    };
    *cursor = Some((document, version));
    let bytes = bytes.unwrap_or_default();
    if bytes.len() as i64 != size_bytes || sha256_hex(&bytes) != sha256 {
        eprintln!("document {document} file version {version} does not match its recorded hash in the database; not moved");
        return Ok(Some(Outcome::Failed(
            document,
            version,
            DATABASE_COPY_DAMAGED,
        )));
    }
    // Stores the sealed file, then fetches it back, decrypts it and compares
    // hash and size. Only a verified copy lets the row change below.
    let key = match store
        .save(a.tenant_id, document, version, &sha256, &bytes, true)
        .await
    {
        Ok(key) => key,
        Err(Error::Unavailable(_)) => return Ok(Some(Outcome::Down)),
        Err(Error::Integrity(_)) => {
            return Ok(Some(Outcome::Failed(
                document,
                version,
                STORED_COPY_UNVERIFIED,
            )))
        }
        Err(e) => return Err(e),
    };
    let changed = match table {
        Table::Originals => sqlx::query("UPDATE patient_documents SET storage='s3',object_key=$3,bytes=NULL WHERE tenant_id=$1 AND id=$2 AND storage='database'")
            .bind(a.tenant_id)
            .bind(document)
            .bind(&key)
            .execute(&mut *tx)
            .await?,
        Table::Versions => sqlx::query("UPDATE patient_document_file_versions SET storage='s3',object_key=$4,bytes=NULL WHERE tenant_id=$1 AND document_id=$2 AND version=$3 AND storage='database'")
            .bind(a.tenant_id)
            .bind(document)
            .bind(version)
            .bind(&key)
            .execute(&mut *tx)
            .await?,
    };
    if changed.rows_affected() != 1 {
        return Err(Error::Conflict("file changed while it was being moved"));
    }
    crate::postgres::audit(&mut tx, a, "practice.document_storage.moved", document).await?;
    tx.commit().await?;
    Ok(Some(Outcome::Moved(size_bytes)))
}
async fn move_files(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let a = crate::practice_admin::owner(&s, &h, true).await?;
    let store = crate::documents::store(&s)?;
    let pool = db(&s)?;
    {
        let mut tx = pool.begin().await?;
        crate::partner_support::verify_owner_in_tx(&mut tx, &a, &h).await?;
        crate::postgres::audit(&mut tx, &a, "practice.document_storage.move", a.tenant_id).await?;
        tx.commit().await?;
    }
    if !store.is_remote() {
        return Err(Error::Conflict(NOT_CONFIGURED));
    }
    let started = Instant::now();
    let (mut moved, mut moved_bytes, mut examined) = (0usize, 0i64, 0usize);
    let mut failed = Vec::new();
    let mut available = true;
    'tables: for table in [Table::Originals, Table::Versions] {
        let mut cursor = None;
        loop {
            if moved >= BATCH_FILES
                || moved_bytes >= BATCH_BYTES
                || examined >= BATCH_EXAMINED
                || started.elapsed() >= BATCH_TIME
            {
                break 'tables;
            }
            let Some(outcome) = move_next(pool, store, &a, &table, &mut cursor).await? else {
                break;
            };
            examined += 1;
            match outcome {
                Outcome::Moved(bytes) => {
                    moved += 1;
                    moved_bytes += bytes;
                }
                Outcome::Failed(document, version, reason) => failed
                    .push(json!({"document_id":document,"file_version":version,"reason":reason})),
                Outcome::Down => {
                    available = false;
                    break 'tables;
                }
            }
        }
    }
    if !available && moved == 0 && failed.is_empty() {
        return Err(Error::Unavailable(crate::document_store::UNAVAILABLE));
    }
    let files = counts(pool, a.tenant_id).await?;
    Ok(Json(json!({
        "moved": moved,
        "moved_bytes": moved_bytes,
        "remaining": files["database"]["count"],
        "failed": failed,
        "storage_available": available,
    })))
}
