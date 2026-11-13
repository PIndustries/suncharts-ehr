// SPDX-License-Identifier: AGPL-3.0-only
//! Where patient file bytes live: in the database row, or as an encrypted,
//! write-once object in S3-compatible storage.
//!
//! Each row records its own location, so a database holding both kinds is
//! always readable. Objects are sealed by the application before upload with a
//! per-tenant key derived from the credential master key; the storage service
//! only ever receives ciphertext. The plaintext SHA-256 kept in Postgres is
//! checked after every decrypt and no bytes are returned on a mismatch. The
//! application never deletes an object and never replaces one that exists.
use crate::error::{Error, Result};
use aws_lc_rs::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM},
    hkdf, hmac,
};
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;
use zeroize::Zeroizing;

pub(crate) const UNAVAILABLE: &str =
    "File storage is temporarily unavailable. Try again in a few minutes.";
pub(crate) const NOT_SET_UP: &str =
    "This file is kept in file storage, which is not set up on this server.";
pub(crate) const FAILED_CHECK: &str =
    "This file failed its integrity check and was not opened. Contact support.";
/// Largest plaintext a document row may describe (matches the schema check).
const MAX_PLAIN: usize = 10 * 1024 * 1024;
/// Sealed layout: 4-byte versioned header, 12-byte nonce, ciphertext, 16-byte tag.
const HEADER: [u8; 4] = *b"SCD\x01";
const OVERHEAD: usize = HEADER.len() + 12 + 16;
const KEY_SALT: &[u8] = b"suncharts:document-store:v1";
const ATTEMPTS: u32 = 3;
const HEALTH_TTL: Duration = Duration::from_secs(30);

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Write-once object name. It carries no patient identifier and no file name.
pub fn object_key(tenant: Uuid, document: Uuid, version: i64, sha256: &str) -> String {
    format!("t/{tenant}/d/{document}/v{version}-{sha256}")
}
fn aad(tenant: Uuid, document: Uuid, version: i64) -> String {
    format!("suncharts:document:{tenant}:{document}:{version}:v1")
}
fn tenant_key(master: &[u8], tenant: Uuid) -> Result<Zeroizing<[u8; 32]>> {
    let mut out = Zeroizing::new([0u8; 32]);
    hkdf::Salt::new(hkdf::HKDF_SHA256, KEY_SALT)
        .extract(master)
        .expand(&[b"tenant:", tenant.as_bytes()], hkdf::HKDF_SHA256)
        .and_then(|okm| okm.fill(&mut out[..]))
        .map_err(|_| Error::Unavailable(UNAVAILABLE))?;
    Ok(out)
}
fn cipher(master: &[u8], tenant: Uuid) -> Result<LessSafeKey> {
    let key = tenant_key(master, tenant)?;
    Ok(LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, &key[..]).map_err(|_| Error::Unavailable(UNAVAILABLE))?,
    ))
}
pub(crate) fn seal(
    master: &[u8],
    tenant: Uuid,
    document: Uuid,
    version: i64,
    plain: &[u8],
) -> Result<Vec<u8>> {
    let key = cipher(master, tenant)?;
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let mut out = Vec::with_capacity(plain.len() + OVERHEAD);
    out.extend_from_slice(&HEADER);
    out.extend_from_slice(&nonce);
    let mut body = plain.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(aad(tenant, document, version)),
        &mut body,
    )
    .map_err(|_| Error::Unavailable(UNAVAILABLE))?;
    out.extend_from_slice(&body);
    Ok(out)
}
pub(crate) fn open(
    master: &[u8],
    tenant: Uuid,
    document: Uuid,
    version: i64,
    sealed: &[u8],
) -> Result<Vec<u8>> {
    if sealed.len() < OVERHEAD || sealed[..HEADER.len()] != HEADER {
        return Err(Error::Integrity(FAILED_CHECK));
    }
    let key = cipher(master, tenant)?;
    let nonce: [u8; 12] = sealed[HEADER.len()..HEADER.len() + 12]
        .try_into()
        .map_err(|_| Error::Integrity(FAILED_CHECK))?;
    let mut body = sealed[HEADER.len() + 12..].to_vec();
    let plain = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(aad(tenant, document, version)),
            &mut body,
        )
        .map_err(|_| Error::Integrity(FAILED_CHECK))?
        .len();
    body.truncate(plain);
    Ok(body)
}

/// RFC 3986 unreserved characters pass through; everything else is %XX.
fn uri_encode(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for b in segment.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data)
        .as_ref()
        .to_vec()
}
pub(crate) fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k = hmac_sha256(&k, region.as_bytes());
    let k = hmac_sha256(&k, service.as_bytes());
    hmac_sha256(&k, b"aws4_request")
}
pub(crate) struct SignInput<'a> {
    pub access_key: &'a str,
    pub secret_key: &'a str,
    pub region: &'a str,
    pub method: &'a str,
    /// Already URI-encoded absolute path.
    pub canonical_uri: &'a str,
    /// Already canonical (sorted, encoded) query string, or empty.
    pub canonical_query: &'a str,
    /// Lower-case header names with their values; every one is signed.
    pub headers: &'a [(&'a str, &'a str)],
    pub payload_sha256: &'a str,
    /// `YYYYMMDDTHHMMSSZ`
    pub amz_date: &'a str,
}
/// AWS Signature Version 4 for S3, single-chunk payload. Returns the
/// `Authorization` header value.
pub(crate) fn authorization(v: &SignInput<'_>) -> String {
    let mut headers = v.headers.to_vec();
    headers.sort_by(|a, b| a.0.cmp(b.0));
    let canonical_headers: String = headers
        .iter()
        .map(|(name, value)| {
            format!(
                "{name}:{}\n",
                value.split_whitespace().collect::<Vec<_>>().join(" ")
            )
        })
        .collect();
    let signed = headers
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(";");
    let canonical = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        v.method, v.canonical_uri, v.canonical_query, canonical_headers, signed, v.payload_sha256
    );
    let date = &v.amz_date[..8];
    let scope = format!("{date}/{}/s3/aws4_request", v.region);
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{scope}\n{}",
        v.amz_date,
        sha256_hex(canonical.as_bytes())
    );
    let signature = hex(&hmac_sha256(
        &signing_key(v.secret_key, date, v.region, "s3"),
        to_sign.as_bytes(),
    ));
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope},SignedHeaders={signed},Signature={signature}",
        v.access_key
    )
}

/// Connection settings for S3-compatible storage (path-style addressing).
pub struct S3Settings {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
}
/// Minimal S3 client: PUT, GET, HEAD and DELETE object, and HEAD bucket.
pub struct S3Client {
    http: reqwest::Client,
    origin: String,
    host: String,
    region: String,
    bucket: String,
    access_key: String,
    secret_key: Zeroizing<String>,
}
impl S3Client {
    pub fn new(v: S3Settings) -> std::result::Result<Self, String> {
        let url = url::Url::parse(&v.endpoint)
            .map_err(|_| "ENGINE_DOCUMENT_S3_ENDPOINT is not a valid URL".to_string())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(
                "ENGINE_DOCUMENT_S3_ENDPOINT must be http(s)://host[:port] with no path, query or credentials"
                    .into(),
            );
        }
        if v.region.is_empty()
            || !v
                .region
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("ENGINE_DOCUMENT_S3_REGION is missing or invalid".into());
        }
        if !(3..=63).contains(&v.bucket.len())
            || !v
                .bucket
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
        {
            return Err("ENGINE_DOCUMENT_S3_BUCKET is missing or invalid".into());
        }
        let printable = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_graphic());
        if !printable(&v.access_key) || !printable(&v.secret_key) {
            return Err("document storage access key or secret key is empty or malformed".into());
        }
        let host = match url.port() {
            Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
            None => url.host_str().unwrap_or_default().to_string(),
        };
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "document storage client could not be created".to_string())?;
        Ok(Self {
            http,
            origin: format!("{}://{host}", url.scheme()),
            host,
            region: v.region,
            bucket: v.bucket,
            access_key: v.access_key,
            secret_key: Zeroizing::new(v.secret_key),
        })
    }
    fn path(&self, key: Option<&str>) -> String {
        let mut path = format!("/{}", uri_encode(&self.bucket));
        if let Some(key) = key {
            for segment in key.split('/') {
                path.push('/');
                path.push_str(&uri_encode(segment));
            }
        }
        path
    }
    /// One signed request, retried on connection errors and 5xx. Every call
    /// here is idempotent, so a retry cannot change the outcome.
    async fn send(
        &self,
        method: reqwest::Method,
        key: Option<&str>,
        body: Option<&[u8]>,
    ) -> Result<reqwest::Response> {
        let path = self.path(key);
        let payload = sha256_hex(body.unwrap_or_default());
        let mut failure = String::new();
        for attempt in 0..ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(200 * 4u64.pow(attempt - 1))).await;
            }
            let date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
            let auth = authorization(&SignInput {
                access_key: &self.access_key,
                secret_key: &self.secret_key,
                region: &self.region,
                method: method.as_str(),
                canonical_uri: &path,
                canonical_query: "",
                headers: &[
                    ("host", &self.host),
                    ("x-amz-content-sha256", &payload),
                    ("x-amz-date", &date),
                ],
                payload_sha256: &payload,
                amz_date: &date,
            });
            let mut request = self
                .http
                .request(method.clone(), format!("{}{path}", self.origin))
                .header("x-amz-content-sha256", &payload)
                .header("x-amz-date", &date)
                .header(reqwest::header::AUTHORIZATION, auth);
            if let Some(body) = body {
                request = request.body(body.to_vec());
            }
            match request.send().await {
                Ok(response) if response.status().is_server_error() => {
                    failure = format!("HTTP {}", response.status().as_u16());
                }
                Ok(response) => return Ok(response),
                Err(e) => {
                    failure = if e.is_timeout() {
                        "timed out".into()
                    } else if e.is_connect() {
                        "connection failed".into()
                    } else {
                        "request failed".into()
                    };
                }
            }
        }
        eprintln!("document storage {method} did not succeed after {ATTEMPTS} attempts: {failure}");
        Err(Error::Unavailable(UNAVAILABLE))
    }
    fn refused(method: &str, status: reqwest::StatusCode) -> Error {
        eprintln!(
            "document storage {method} was refused with HTTP {}",
            status.as_u16()
        );
        Error::Unavailable(UNAVAILABLE)
    }
    pub async fn head_bucket(&self) -> Result<()> {
        let r = self.send(reqwest::Method::HEAD, None, None).await?;
        if r.status().is_success() {
            Ok(())
        } else {
            Err(Self::refused("HEAD bucket", r.status()))
        }
    }
    pub async fn put_object(&self, key: &str, body: &[u8]) -> Result<()> {
        let r = self
            .send(reqwest::Method::PUT, Some(key), Some(body))
            .await?;
        if r.status().is_success() {
            Ok(())
        } else {
            Err(Self::refused("PUT", r.status()))
        }
    }
    /// Stored size, or `None` when the object does not exist.
    pub async fn head_object(&self, key: &str) -> Result<Option<u64>> {
        let r = self.send(reqwest::Method::HEAD, Some(key), None).await?;
        if r.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !r.status().is_success() {
            return Err(Self::refused("HEAD", r.status()));
        }
        r.headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .map(Some)
            .ok_or_else(|| {
                eprintln!("document storage HEAD returned no object size");
                Error::Unavailable(UNAVAILABLE)
            })
    }
    /// Object bytes, or `None` when the object does not exist. Refuses bodies
    /// larger than `max` instead of buffering them.
    pub async fn get_object(&self, key: &str, max: usize) -> Result<Option<Vec<u8>>> {
        let mut r = self.send(reqwest::Method::GET, Some(key), None).await?;
        if r.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !r.status().is_success() {
            return Err(Self::refused("GET", r.status()));
        }
        if r.content_length().is_some_and(|n| n > max as u64) {
            return Err(Error::Integrity(FAILED_CHECK));
        }
        let mut out = Vec::new();
        loop {
            match r.chunk().await {
                Ok(Some(chunk)) => {
                    if out.len() + chunk.len() > max {
                        return Err(Error::Integrity(FAILED_CHECK));
                    }
                    out.extend_from_slice(&chunk);
                }
                Ok(None) => return Ok(Some(out)),
                Err(_) => {
                    eprintln!("document storage GET ended before the object was complete");
                    return Err(Error::Unavailable(UNAVAILABLE));
                }
            }
        }
    }
    /// Provided for operators and tests. The application itself never deletes.
    pub async fn delete_object(&self, key: &str) -> Result<()> {
        let r = self.send(reqwest::Method::DELETE, Some(key), None).await?;
        if r.status().is_success() || r.status() == reqwest::StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(Self::refused("DELETE", r.status()))
        }
    }
}

struct Remote {
    client: S3Client,
    master: Zeroizing<Vec<u8>>,
}
enum Backend {
    Database,
    S3(Box<Remote>),
}
/// How one stored file is described by its row.
pub(crate) struct Stored {
    pub storage: String,
    pub bytes: Option<Vec<u8>>,
    pub object_key: Option<String>,
    pub sha256: String,
    pub size_bytes: i64,
}
#[derive(Default)]
struct Health {
    /// Result and time of the last bucket check, once there has been one.
    last: Option<(Instant, bool)>,
    refreshing: bool,
}
pub struct DocumentStore {
    backend: Backend,
    health: Mutex<Health>,
}
impl DocumentStore {
    /// File bytes stay in the database row. This is the default.
    pub fn database() -> Arc<Self> {
        Arc::new(Self {
            backend: Backend::Database,
            health: Mutex::default(),
        })
    }
    /// New files go to S3-compatible storage, sealed under `master_key`.
    pub fn s3(settings: S3Settings, master_key: Vec<u8>) -> std::result::Result<Arc<Self>, String> {
        if master_key.len() != 32 {
            return Err("credential key must contain 32 bytes".into());
        }
        Ok(Arc::new(Self {
            backend: Backend::S3(Box::new(Remote {
                client: S3Client::new(settings)?,
                master: Zeroizing::new(master_key),
            })),
            health: Mutex::default(),
        }))
    }
    /// Reads `ENGINE_DOCUMENT_STORE` and, for `s3`, every
    /// `ENGINE_DOCUMENT_S3_*` setting, then confirms the bucket answers.
    /// Any gap is an error so the server refuses to start half-configured.
    /// Messages name settings, never their values.
    pub async fn from_env(pool: &PgPool) -> std::result::Result<Arc<Self>, String> {
        Self::configure(&|name| std::env::var(name).ok(), None, pool).await
    }
    /// As [`Self::from_env`] with the settings source and, optionally, the
    /// master key supplied by the caller.
    pub(crate) async fn configure(
        setting: &(dyn Fn(&str) -> Option<String> + Sync),
        master_key: Option<Vec<u8>>,
        pool: &PgPool,
    ) -> std::result::Result<Arc<Self>, String> {
        let mode = setting("ENGINE_DOCUMENT_STORE").unwrap_or_default();
        match mode.as_str() {
            "" | "database" => {
                let remote: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patient_documents WHERE storage='s3') OR EXISTS(SELECT 1 FROM patient_document_file_versions WHERE storage='s3')")
                    .fetch_one(pool)
                    .await
                    .map_err(|_| "document storage state could not be read".to_string())?;
                if remote {
                    eprintln!("WARNING: some patient files are kept in file storage but ENGINE_DOCUMENT_STORE is not s3; those files cannot be opened until it is configured again");
                }
                Ok(Self::database())
            }
            "s3" => {
                let text = |name: &str| {
                    setting(name)
                        .filter(|v| !v.is_empty())
                        .ok_or_else(|| format!("{name} is required when ENGINE_DOCUMENT_STORE=s3"))
                };
                let file = |name: &str| -> std::result::Result<String, String> {
                    let value = std::fs::read_to_string(text(name)?)
                        .map_err(|_| format!("{name} could not be read"))?;
                    let value = value.trim_end_matches(['\r', '\n']).to_string();
                    if value.is_empty() {
                        return Err(format!("{name} is empty"));
                    }
                    Ok(value)
                };
                let settings = S3Settings {
                    endpoint: text("ENGINE_DOCUMENT_S3_ENDPOINT")?,
                    region: text("ENGINE_DOCUMENT_S3_REGION")?,
                    bucket: text("ENGINE_DOCUMENT_S3_BUCKET")?,
                    access_key: file("ENGINE_DOCUMENT_S3_ACCESS_KEY_FILE")?,
                    secret_key: file("ENGINE_DOCUMENT_S3_SECRET_KEY_FILE")?,
                };
                let master = match master_key {
                    Some(key) => key,
                    None => crate::provider_settings::document_master_key(pool)
                        .await
                        .map_err(|e| format!("document encryption key unavailable: {e}"))?
                        .to_vec(),
                };
                let store = Self::s3(settings, master)?;
                store.check().await.map_err(|_| {
                    "the ENGINE_DOCUMENT_S3_BUCKET bucket could not be reached with the configured endpoint and keys"
                        .to_string()
                })?;
                Ok(store)
            }
            _ => Err("ENGINE_DOCUMENT_STORE must be database or s3".into()),
        }
    }
    /// `database` or `s3`.
    pub fn mode(&self) -> &'static str {
        match self.backend {
            Backend::Database => "database",
            Backend::S3(_) => "s3",
        }
    }
    pub fn is_remote(&self) -> bool {
        matches!(self.backend, Backend::S3(_))
    }
    /// The underlying client, for operators and tests.
    pub fn client(&self) -> Option<&S3Client> {
        match &self.backend {
            Backend::Database => None,
            Backend::S3(remote) => Some(&remote.client),
        }
    }
    /// HEAD bucket. `Ok` in database mode, where nothing can be unreachable.
    pub async fn check(&self) -> Result<()> {
        let Backend::S3(remote) = &self.backend else {
            return Ok(());
        };
        let result = remote.client.head_bucket().await;
        let mut health = self.health.lock().unwrap();
        health.last = Some((Instant::now(), result.is_ok()));
        health.refreshing = false;
        result
    }
    /// Last known reachability for health output: `None` in database mode or
    /// before the first check. Never waits on the store, so a slow or absent
    /// store cannot stall a readiness probe; a result older than 30 seconds
    /// starts one background check.
    pub fn reachable(self: &Arc<Self>) -> Option<bool> {
        if !self.is_remote() {
            return None;
        }
        let mut health = self.health.lock().unwrap();
        let stale = health.last.is_none_or(|(at, _)| at.elapsed() >= HEALTH_TTL);
        if stale && !health.refreshing {
            health.refreshing = true;
            let store = self.clone();
            tokio::spawn(async move {
                let _ = store.check().await;
            });
        }
        health.last.map(|(_, ok)| ok)
    }
    /// Seal and store one file version, returning its object key.
    ///
    /// An object that already exists under the key is never replaced: it is
    /// read back and must decrypt to the same content. With `read_back` the
    /// newly written object is also fetched, decrypted and compared before the
    /// key is returned; otherwise its stored size is confirmed.
    pub(crate) async fn save(
        &self,
        tenant: Uuid,
        document: Uuid,
        version: i64,
        sha256: &str,
        plain: &[u8],
        read_back: bool,
    ) -> Result<String> {
        let Backend::S3(remote) = &self.backend else {
            return Err(Error::Unavailable(NOT_SET_UP));
        };
        let key = object_key(tenant, document, version, sha256);
        let existing = remote.client.head_object(&key).await?.is_some();
        if !existing {
            let sealed = seal(&remote.master, tenant, document, version, plain)?;
            remote.client.put_object(&key, &sealed).await?;
            if remote.client.head_object(&key).await? != Some(sealed.len() as u64) {
                eprintln!("document storage did not confirm the stored size of {key}");
                return Err(Error::Unavailable(UNAVAILABLE));
            }
        }
        if existing || read_back {
            let stored = Stored {
                storage: "s3".into(),
                bytes: None,
                object_key: Some(key.clone()),
                sha256: sha256.into(),
                size_bytes: plain.len() as i64,
            };
            self.load(tenant, document, version, stored).await?;
        }
        Ok(key)
    }
    /// Bytes of one file version from wherever its row says they are.
    pub(crate) async fn load(
        &self,
        tenant: Uuid,
        document: Uuid,
        version: i64,
        stored: Stored,
    ) -> Result<Vec<u8>> {
        if stored.storage == "database" {
            return stored.bytes.ok_or(Error::Integrity(FAILED_CHECK));
        }
        let Backend::S3(remote) = &self.backend else {
            return Err(Error::Unavailable(NOT_SET_UP));
        };
        let key = object_key(tenant, document, version, &stored.sha256);
        let failed = |why: &str| {
            eprintln!("document integrity check failed ({why}) for {key}; no bytes returned");
            Error::Integrity(FAILED_CHECK)
        };
        if stored.storage != "s3" || stored.object_key.as_deref() != Some(key.as_str()) {
            return Err(failed("unexpected location"));
        }
        let sealed = remote
            .client
            .get_object(&key, MAX_PLAIN + OVERHEAD)
            .await
            .map_err(|e| match e {
                Error::Integrity(_) => failed("object too large"),
                other => other,
            })?
            .ok_or_else(|| failed("object missing"))?;
        let plain = open(&remote.master, tenant, document, version, &sealed)
            .map_err(|_| failed("decryption"))?;
        if plain.len() as i64 != stored.size_bytes || sha256_hex(&plain) != stored.sha256 {
            return Err(failed("content hash"));
        }
        Ok(plain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ACCESS: &str = "AKIAIOSFODNN7EXAMPLE";
    const SECRET: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const HOST: &str = "examplebucket.s3.amazonaws.com";
    const DATE: &str = "20130524T000000Z";
    fn signature(auth: &str) -> &str {
        auth.rsplit_once("Signature=").unwrap().1
    }
    // Published examples: Amazon S3 API Reference, "Signature Calculations for
    // the Authorization Header: Transferring Payload in a Single Chunk".
    #[test]
    fn sigv4_matches_aws_get_object_example() {
        let auth = authorization(&SignInput {
            access_key: ACCESS,
            secret_key: SECRET,
            region: "us-east-1",
            method: "GET",
            canonical_uri: "/test.txt",
            canonical_query: "",
            headers: &[
                ("host", HOST),
                ("range", "bytes=0-9"),
                ("x-amz-content-sha256", EMPTY),
                ("x-amz-date", DATE),
            ],
            payload_sha256: EMPTY,
            amz_date: DATE,
        });
        assert_eq!(auth, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    }
    #[test]
    fn sigv4_matches_aws_put_object_example() {
        let body = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072";
        assert_eq!(sha256_hex(b"Welcome to Amazon S3."), body);
        let auth = authorization(&SignInput {
            access_key: ACCESS,
            secret_key: SECRET,
            region: "us-east-1",
            method: "PUT",
            canonical_uri: &format!("/{}", uri_encode("test$file.text")),
            canonical_query: "",
            // Deliberately unsorted: the signer must order them.
            headers: &[
                ("x-amz-storage-class", "REDUCED_REDUNDANCY"),
                ("host", HOST),
                ("date", "Fri, 24 May 2013 00:00:00 GMT"),
                ("x-amz-date", DATE),
                ("x-amz-content-sha256", body),
            ],
            payload_sha256: body,
            amz_date: DATE,
        });
        assert_eq!(
            signature(&auth),
            "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
        );
    }
    #[test]
    fn sigv4_matches_aws_examples_with_only_the_headers_this_client_signs() {
        let sign = |query: &str| {
            authorization(&SignInput {
                access_key: ACCESS,
                secret_key: SECRET,
                region: "us-east-1",
                method: "GET",
                canonical_uri: "/",
                canonical_query: query,
                headers: &[
                    ("host", HOST),
                    ("x-amz-content-sha256", EMPTY),
                    ("x-amz-date", DATE),
                ],
                payload_sha256: EMPTY,
                amz_date: DATE,
            })
        };
        let lifecycle = sign("lifecycle=");
        assert!(lifecycle.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date,"));
        assert_eq!(
            signature(&lifecycle),
            "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"
        );
        assert_eq!(
            signature(&sign("max-keys=2&prefix=J")),
            "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        );
    }
    // AWS General Reference, "Examples of how to derive a signing key".
    #[test]
    fn signing_key_matches_aws_derivation_example() {
        assert_eq!(
            hex(&signing_key(
                "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
                "20120215",
                "us-east-1",
                "iam"
            )),
            "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
        );
    }
    #[test]
    fn uri_encoding_keeps_unreserved_and_escapes_the_rest() {
        assert_eq!(uri_encode("Az09-._~"), "Az09-._~");
        assert_eq!(uri_encode("a b/c$é"), "a%20b%2Fc%24%C3%A9");
    }
    #[test]
    fn object_key_has_fixed_shape_and_no_names() {
        let tenant = Uuid::parse_str("11111111-2222-4333-8444-555555555555").unwrap();
        let document = Uuid::parse_str("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap();
        let sha = sha256_hex(b"file");
        assert_eq!(
            object_key(tenant, document, 3, &sha),
            format!("t/11111111-2222-4333-8444-555555555555/d/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v3-{sha}")
        );
        assert_ne!(
            object_key(tenant, document, 3, &sha),
            object_key(tenant, document, 4, &sha)
        );
    }
    #[test]
    fn sealed_files_round_trip_and_never_contain_the_plaintext() {
        let master = [7u8; 32];
        let (tenant, document) = (Uuid::new_v4(), Uuid::new_v4());
        let plain = b"%PDF-1.4 synthetic patient file %%EOF".to_vec();
        let sealed = seal(&master, tenant, document, 1, &plain).unwrap();
        assert_eq!(sealed.len(), plain.len() + OVERHEAD);
        assert_eq!(&sealed[..4], b"SCD\x01");
        assert!(!sealed.windows(plain.len()).any(|w| w == plain));
        assert_eq!(open(&master, tenant, document, 1, &sealed).unwrap(), plain);
        // A fresh nonce every time.
        assert_ne!(sealed, seal(&master, tenant, document, 1, &plain).unwrap());
    }
    #[test]
    fn tampering_or_the_wrong_context_is_detected() {
        let master = [7u8; 32];
        let (tenant, document) = (Uuid::new_v4(), Uuid::new_v4());
        let sealed = seal(&master, tenant, document, 1, b"synthetic").unwrap();
        let refused = |r: Result<Vec<u8>>| matches!(r, Err(Error::Integrity(_)));
        for index in [0, 3, 4, 15, 16, sealed.len() - 17, sealed.len() - 1] {
            let mut changed = sealed.clone();
            changed[index] ^= 1;
            assert!(
                refused(open(&master, tenant, document, 1, &changed)),
                "byte {index}"
            );
        }
        assert!(refused(open(
            &master,
            tenant,
            document,
            1,
            &sealed[..sealed.len() - 1]
        )));
        assert!(refused(open(&master, tenant, document, 1, b"SCD\x01")));
        // Another tenant derives another key.
        assert!(refused(open(&master, Uuid::new_v4(), document, 1, &sealed)));
        // Same key, different document or version: the bound context differs.
        assert!(refused(open(&master, tenant, Uuid::new_v4(), 1, &sealed)));
        assert!(refused(open(&master, tenant, document, 2, &sealed)));
        // Another master key.
        assert!(refused(open(&[8u8; 32], tenant, document, 1, &sealed)));
    }
    #[test]
    fn tenant_keys_differ_and_are_stable() {
        let master = [9u8; 32];
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        assert_eq!(
            tenant_key(&master, a).unwrap()[..],
            tenant_key(&master, a).unwrap()[..]
        );
        assert_ne!(
            tenant_key(&master, a).unwrap()[..],
            tenant_key(&master, b).unwrap()[..]
        );
        assert_ne!(tenant_key(&master, a).unwrap()[..], master[..]);
    }
    #[test]
    fn client_settings_are_validated_without_echoing_secrets() {
        let settings = |endpoint: &str, bucket: &str, secret: &str| S3Settings {
            endpoint: endpoint.into(),
            region: "us-east-1".into(),
            bucket: bucket.into(),
            access_key: "synthetic-access".into(),
            secret_key: secret.into(),
        };
        assert!(S3Client::new(settings("http://127.0.0.1:9000", "files", "s3cr3t-value")).is_ok());
        for (endpoint, bucket, secret) in [
            ("ftp://127.0.0.1", "files", "s3cr3t-value"),
            ("http://127.0.0.1:9000/prefix", "files", "s3cr3t-value"),
            ("http://user:pw@127.0.0.1", "files", "s3cr3t-value"),
            ("http://127.0.0.1:9000", "Bad_Bucket", "s3cr3t-value"),
            ("http://127.0.0.1:9000", "files", ""),
            ("http://127.0.0.1:9000", "files", "s3cr3t value"),
        ] {
            let error = S3Client::new(settings(endpoint, bucket, secret))
                .err()
                .expect("settings must be refused");
            assert!(!error.contains("s3cr3t"), "{error}");
        }
        assert!(DocumentStore::s3(
            settings("http://127.0.0.1:9000", "files", "s3cr3t-value"),
            vec![1; 31]
        )
        .is_err());
    }
}
