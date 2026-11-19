// SPDX-License-Identifier: AGPL-3.0-only
//! Versioned native reference catalogs. No bundled proprietary CPT dataset and
//! no automatic inference of diagnosis-to-procedure medical necessity.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    postgres::audit,
    State,
};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State as ExtractState},
    http::header,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, QueryBuilder, Transaction};
use std::collections::HashSet;
use uuid::Uuid;

const MAX_IMPORT_BYTES: usize = 64 * 1024 * 1024;
const MAX_CODES: usize = 150_000;
fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn reply(value: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}
fn clean(value: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        Err(Error::Invalid(
            "catalog text is missing or exceeds its limit",
        ))
    } else {
        Ok(value.to_owned())
    }
}
fn system(value: &str) -> Result<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "icd-10-cm" | "icd10cm" | "icd_10_cm" | "http://hl7.org/fhir/sid/icd-10-cm" => {
            Ok("ICD-10-CM")
        }
        "icd-10-pcs" | "icd10pcs" | "icd_10_pcs" | "http://www.cms.gov/medicare/coding/icd10" => {
            Ok("ICD-10-PCS")
        }
        "hcpcs" | "hcpcs-ii" | "http://www.cms.gov/medicare/coding/hcpcsreleasecodesets" => {
            Ok("HCPCS")
        }
        "cpt" | "http://www.ama-assn.org/go/cpt" => Ok("CPT"),
        _ => Err(Error::Invalid("unsupported terminology system")),
    }
}
fn canonical_code(system: &str, value: &str) -> Result<String> {
    let code = value.trim().to_ascii_uppercase();
    let compact = code.replace('.', "");
    let bytes = compact.as_bytes();
    let valid = match system {
        "ICD-10-CM" => {
            (3..=7).contains(&bytes.len())
                && bytes[0].is_ascii_uppercase()
                && bytes[1].is_ascii_alphanumeric()
                && bytes[2..].iter().all(u8::is_ascii_alphanumeric)
                && (!code.contains('.')
                    || (compact.len() > 3
                        && code.len() == compact.len() + 1
                        && code.as_bytes().get(3) == Some(&b'.')))
        }
        "ICD-10-PCS" => {
            bytes.len() == 7
                && code == compact
                && bytes
                    .iter()
                    .all(|b| b.is_ascii_alphanumeric() && !b"IO".contains(b))
        }
        "HCPCS" => {
            bytes.len() == 5
                && code == compact
                && bytes[0].is_ascii_uppercase()
                && bytes[1..].iter().all(u8::is_ascii_digit)
        }
        "CPT" => {
            bytes.len() == 5
                && code == compact
                && bytes[..4].iter().all(u8::is_ascii_digit)
                && (bytes[4].is_ascii_digit() || b"FTUM".contains(&bytes[4]))
        }
        _ => false,
    };
    if !valid {
        return Err(Error::Invalid(
            "catalog code has invalid syntax for its system",
        ));
    }
    if system == "ICD-10-CM" && compact.len() > 3 {
        Ok(format!("{}.{}", &compact[..3], &compact[3..]))
    } else {
        Ok(compact)
    }
}
fn true_value() -> bool {
    true
}
fn object() -> Value {
    json!({})
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CodeInput {
    pub(crate) code: String,
    pub(crate) display: String,
    pub(crate) short_display: Option<String>,
    pub(crate) billable: bool,
    #[serde(default = "true_value")]
    pub(crate) active: bool,
    pub(crate) effective_start: Option<NaiveDate>,
    pub(crate) effective_end: Option<NaiveDate>,
    #[serde(default = "object")]
    pub(crate) metadata: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Import {
    pub(crate) request_id: Uuid,
    pub(crate) system: String,
    pub(crate) edition: String,
    pub(crate) source_name: String,
    pub(crate) source_url: String,
    pub(crate) source_sha256: String,
    pub(crate) effective_start: NaiveDate,
    pub(crate) effective_end: Option<NaiveDate>,
    pub(crate) rights: String,
    pub(crate) rights_attested: bool,
    pub(crate) license_reference: Option<String>,
    pub(crate) license_valid_until: Option<NaiveDate>,
    pub(crate) reason: String,
    pub(crate) codes: Vec<CodeInput>,
}
impl Import {
    pub(crate) fn validate(&mut self) -> Result<()> {
        self.system = system(&self.system)?.into();
        self.edition = clean(&self.edition, 120)?;
        self.source_name = clean(&self.source_name, 200)?;
        self.source_url = clean(&self.source_url, 2000)?;
        self.reason = clean(&self.reason, 1000)?;
        self.source_sha256 = self.source_sha256.trim().to_ascii_lowercase();
        let source = url::Url::parse(&self.source_url)
            .map_err(|_| Error::Invalid("catalog source URL must be HTTPS"))?;
        if source.scheme() != "https"
            || source.host_str().is_none()
            || !source.username().is_empty()
            || source.password().is_some()
            || source.query().is_some()
            || source.fragment().is_some()
        {
            return Err(Error::Invalid(
                "catalog source URL must be HTTPS without credentials, query or fragment",
            ));
        }
        if self.source_sha256.len() != 64
            || !self.source_sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(Error::Invalid(
                "catalog source SHA-256 must contain 64 hexadecimal characters",
            ));
        }
        if self
            .effective_end
            .is_some_and(|end| end < self.effective_start)
            || self.codes.is_empty()
            || self.codes.len() > MAX_CODES
        {
            return Err(Error::Invalid(
                "catalog requires valid effective dates and 1 to 150000 codes",
            ));
        }
        if !self.rights_attested || !["public_use", "licensed"].contains(&self.rights.as_str()) {
            return Err(Error::Invalid(
                "owner authorization to import and use this dataset is required",
            ));
        }
        self.license_reference = self
            .license_reference
            .as_deref()
            .map(|v| clean(v, 500))
            .transpose()?;
        if self.rights == "licensed" && self.license_reference.is_none() {
            return Err(Error::Invalid(
                "licensed catalogs require a license reference",
            ));
        }
        if self.system == "CPT" && self.rights != "licensed" {
            return Err(Error::Invalid(
                "CPT requires an authorized tenant license; public-use imports are not permitted",
            ));
        }
        if self
            .license_valid_until
            .is_some_and(|date| date < Utc::now().date_naive())
        {
            return Err(Error::Invalid("catalog license has expired"));
        }
        let mut keys = HashSet::with_capacity(self.codes.len());
        for row in &mut self.codes {
            row.code = canonical_code(&self.system, &row.code)?;
            if !keys.insert(row.code.clone()) {
                return Err(Error::Invalid("catalog contains duplicate canonical codes"));
            }
            row.display = clean(&row.display, 10000)?;
            row.short_display = row
                .short_display
                .as_deref()
                .map(|v| clean(v, 256))
                .transpose()?;
            row.effective_start = Some(row.effective_start.unwrap_or(self.effective_start));
            row.effective_end = row.effective_end.or(self.effective_end);
            if row
                .effective_end
                .is_some_and(|end| end < row.effective_start.unwrap_or(self.effective_start))
            {
                return Err(Error::Invalid("catalog code effective dates are invalid"));
            }
            if !row.metadata.is_object()
                || serde_json::to_vec(&row.metadata).map_or(true, |bytes| bytes.len() > 4096)
            {
                return Err(Error::Invalid(
                    "catalog code metadata must be a bounded object",
                ));
            }
        }
        self.codes.sort_by(|a, b| a.code.cmp(&b.code));
        Ok(())
    }
}

// License agreement references and owner identity are intentionally not included
// in staff reference responses. All catalog content remains tenant scoped.
const RELEASE_PUBLIC:&str="jsonb_build_object('id',r.id,'system',r.system,'edition',r.edition,'source_name',r.source_name,'source_url',r.source_url,'source_sha256',r.source_sha256,'effective_start',r.effective_start,'effective_end',r.effective_end,'rights',r.rights,'license_valid_until',r.license_valid_until,'code_count',r.code_count,'created_at',r.created_at)";
const CODE_PUBLIC:&str="jsonb_build_object('release_id',r.id,'system',r.system,'edition',r.edition,'source_name',r.source_name,'source_url',r.source_url,'source_sha256',r.source_sha256,'code',c.code,'display',c.display,'short_display',c.short_display,'billable',c.billable,'active',c.active,'effective_start',greatest(r.effective_start,c.effective_start),'effective_end',least(r.effective_end,c.effective_end),'metadata',c.metadata)";
const LICENSE_VISIBLE:&str="(r.rights<>'licensed' OR r.license_valid_until IS NULL OR r.license_valid_until>=CURRENT_DATE)";
async fn release(tx: &mut Transaction<'_, Postgres>, actor: &Actor, id: Uuid) -> Result<Value> {
    sqlx::query_scalar(&format!("SELECT {RELEASE_PUBLIC} FROM terminology_releases r WHERE r.tenant_id=$1 AND r.id=$2 AND {LICENSE_VISIBLE}"))
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/terminology/releases", get(list_releases))
        .route(
            "/api/v1/terminology/releases",
            post(import).layer(DefaultBodyLimit::max(MAX_IMPORT_BYTES)),
        )
        .route("/api/v1/terminology/cpt-install", post(cpt_install))
        .route("/api/v1/terminology/codes", get(search))
        .route(
            "/api/v1/terminology/releases/{release}/codes/{code}",
            get(detail),
        )
}
async fn import(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Json(mut input): Json<Import>,
) -> Result<Response> {
    if !matches!(actor.role, Role::Owner) {
        return Err(Error::Forbidden);
    }
    input.validate()?;
    let mut tx = db(&state)?.begin().await?;
    let (value, created) =
        store_release(&mut tx, &actor, &input, "terminology.release.imported").await?;
    tx.commit().await?;
    Ok(reply(json!({"release":value,"created":created})))
}
/// Stores one validated release for the actor's tenant: replay and edition checks under the
/// tenant's import lock, the release row, its codes and one audit entry. Returns the release
/// and whether it was created (false when the same request or edition already exists).
pub(crate) async fn store_release(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    input: &Import,
    audit_action: &str,
) -> Result<(Value, bool)> {
    let mut content =
        serde_json::to_value(input).map_err(|_| Error::Invalid("invalid catalog import"))?;
    content
        .as_object_mut()
        .ok_or(Error::Invalid("invalid catalog import"))?
        .remove("request_id");
    let encoded =
        serde_json::to_string(&content).map_err(|_| Error::Invalid("invalid catalog import"))?;
    if encoded.len() > MAX_IMPORT_BYTES {
        return Err(Error::Invalid("catalog import exceeds 64 MiB"));
    }
    let digest = crate::oauth::hash(&encoded);
    drop(encoded);
    drop(content);
    // Serialize tenant imports: request-ID replay and edition uniqueness are
    // evaluated before any rows are visible or any expensive insertion begins.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("{}:terminology-import", actor.tenant_id))
        .execute(&mut **tx)
        .await?;
    let prior:Option<(Uuid,String)>=sqlx::query_as("SELECT id,request_digest FROM terminology_releases WHERE tenant_id=$1 AND (request_id=$2 OR (system=$3 AND edition=$4)) ORDER BY (request_id=$2) DESC LIMIT 1")
        .bind(actor.tenant_id).bind(input.request_id).bind(&input.system).bind(&input.edition).fetch_optional(&mut **tx).await?;
    if let Some((id, previous)) = prior {
        if previous != digest {
            return Err(Error::Conflict("catalog request or edition already exists with different content; import a new edition"));
        }
        let value = release(tx, actor, id).await?;
        return Ok((value, false));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO terminology_releases(tenant_id,id,system,edition,source_name,source_url,source_sha256,effective_start,effective_end,rights,rights_attested,license_reference,license_valid_until,request_id,request_digest,code_count,created_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13,$14,$15,$16,$17)")
        .bind(actor.tenant_id).bind(id).bind(&input.system).bind(&input.edition).bind(&input.source_name).bind(&input.source_url).bind(&input.source_sha256).bind(input.effective_start).bind(input.effective_end).bind(&input.rights).bind(&input.license_reference).bind(input.license_valid_until).bind(input.request_id).bind(&digest).bind(input.codes.len() as i32).bind(actor.sub).bind(&input.reason).execute(&mut **tx).await?;
    for rows in input.codes.chunks(500) {
        let mut query=QueryBuilder::<Postgres>::new("INSERT INTO terminology_codes(tenant_id,release_id,code,code_key,display,short_display,billable,active,effective_start,effective_end,metadata) ");
        query.push_values(rows, |mut b, row| {
            b.push_bind(actor.tenant_id)
                .push_bind(id)
                .push_bind(&row.code)
                .push_bind(row.code.replace('.', ""))
                .push_bind(&row.display)
                .push_bind(&row.short_display)
                .push_bind(row.billable)
                .push_bind(row.active)
                .push_bind(row.effective_start)
                .push_bind(row.effective_end)
                .push_bind(&row.metadata);
        });
        query.build().execute(&mut **tx).await?;
    }
    audit(tx, actor, audit_action, id).await?;
    let value = release(tx, actor, id).await?;
    Ok((value, true))
}

/// The official file a licensed practice installs CPT from. CMS publishes the physician fee
/// schedule relative value file with every CPT code it prices and the AMA short descriptor; the
/// file is fetched only when an owner attests the practice holds a CPT license, and only for
/// that practice. Nothing licensed is bundled with this program.
pub(crate) struct CptSource {
    pub(crate) edition: &'static str,
    pub(crate) source_name: &'static str,
    pub(crate) url: &'static str,
    pub(crate) sha256: &'static str,
    pub(crate) member: &'static str,
    pub(crate) effective_start: (i32, u32, u32),
}
pub(crate) const CPT_SOURCE: CptSource = CptSource {
    edition: "2026 (CMS PFS RVU26D, October 2026)",
    source_name: "CMS Physician Fee Schedule relative value file RVU26D (CPT short descriptors)",
    url: "https://www.cms.gov/files/zip/rvu26d-updated-08-26-2026.zip",
    sha256: "521ff0f4ecbf13b5d99dc1dc04d9f82e5361e55c6b4b6b3033043598bf8406e6",
    member: "PPRRVU2026_Oct_nonQPP.csv",
    effective_start: (2026, 1, 1),
};
const MAX_CPT_ARCHIVE: usize = 32 * 1024 * 1024;
const MAX_CPT_MEMBER: u64 = 64 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CptInstall {
    request_id: Uuid,
    license_attested: bool,
    license_reference: String,
    #[serde(default)]
    license_valid_until: Option<NaiveDate>,
}
/// One CSV record, quoted fields allowed (a quoted field may hold commas and doubled quotes).
fn csv_fields(line: &str) -> Vec<String> {
    let (mut out, mut field, mut quoted, mut chars) =
        (Vec::new(), String::new(), false, line.chars().peekable());
    while let Some(c) = chars.next() {
        match (c, quoted) {
            ('"', true) if chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            ('"', _) => quoted = !quoted,
            (',', false) => out.push(std::mem::take(&mut field)),
            _ => field.push(c),
        }
    }
    out.push(field);
    out
}
/// Builds the CPT import from the CMS archive bytes: every CPT code (four digits and a digit
/// or F, T, U, M) with its short descriptor, one row per code, the row without a modifier
/// preferred. A code CMS lists as deleted is kept but marked inactive.
pub(crate) fn cpt_import_from_archive(
    bytes: &[u8],
    source: &CptSource,
    license_reference: &str,
    license_valid_until: Option<NaiveDate>,
    request_id: Uuid,
) -> Result<Import> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let bad = || Error::Invalid("The CMS file is not in the expected format.");
    let digest = format!("{:x}", Sha256::digest(bytes));
    if digest != source.sha256 {
        return Err(Error::Invalid(
            "The CMS file did not match the expected version.",
        ));
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| bad())?;
    let mut member = archive.by_name(source.member).map_err(|_| bad())?;
    if member.size() > MAX_CPT_MEMBER {
        return Err(bad());
    }
    let mut raw = Vec::with_capacity(member.size() as usize);
    member.read_to_end(&mut raw).map_err(|_| bad())?;
    // The file is Latin-1: every byte is one character.
    let text: String = raw.iter().map(|&b| b as char).collect();
    let mut lines = text.lines();
    lines
        .by_ref()
        .find(|line| {
            let f = csv_fields(line);
            f.len() > 3
                && f[0].trim() == "HCPCS"
                && f[1].trim() == "MOD"
                && f[2].trim() == "DESCRIPTION"
        })
        .ok_or_else(bad)?;
    let start = NaiveDate::from_ymd_opt(
        source.effective_start.0,
        source.effective_start.1,
        source.effective_start.2,
    )
    .ok_or_else(bad)?;
    let mut rows: std::collections::BTreeMap<String, (bool, String, String)> = Default::default();
    for line in lines {
        let f = csv_fields(line);
        if f.len() < 4 {
            continue;
        }
        let (code, modifier, description, status) =
            (f[0].trim(), f[1].trim(), f[2].trim(), f[3].trim());
        let b = code.as_bytes();
        let cpt = b.len() == 5
            && b[..4].iter().all(u8::is_ascii_digit)
            && (b[4].is_ascii_digit() || b"FTUM".contains(&b[4]));
        if !cpt || description.is_empty() {
            continue;
        }
        let base = modifier.is_empty();
        match rows.get(code) {
            Some((true, _, _)) => {}
            Some((false, _, _)) if !base => {}
            _ => {
                rows.insert(
                    code.to_owned(),
                    (base, description.to_owned(), status.to_owned()),
                );
            }
        }
    }
    if rows.is_empty() {
        return Err(bad());
    }
    let codes = rows
        .into_iter()
        .map(|(code, (_, display, status))| CodeInput {
            code,
            display,
            short_display: None,
            billable: true,
            active: status != "D",
            effective_start: None,
            effective_end: None,
            metadata: json!({ "medicare_status": status }),
        })
        .collect();
    let mut input = Import {
        request_id,
        system: "CPT".into(),
        edition: source.edition.into(),
        source_name: source.source_name.into(),
        source_url: source.url.into(),
        source_sha256: digest,
        effective_start: start,
        effective_end: None,
        rights: "licensed".into(),
        rights_attested: true,
        license_reference: Some(license_reference.into()),
        license_valid_until,
        reason:
            "CPT list installed from the CMS fee schedule file under the practice's CPT license"
                .into(),
        codes,
    };
    input.validate()?;
    Ok(input)
}
async fn download_cpt(source: &CptSource) -> Result<Vec<u8>> {
    let failed =
        Error::Unavailable("The CPT file could not be downloaded from CMS. Try again later.");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| {
            Error::Unavailable("The CPT file could not be downloaded from CMS. Try again later.")
        })?;
    let response = client.get(source.url).send().await.map_err(|_| {
        Error::Unavailable("The CPT file could not be downloaded from CMS. Try again later.")
    })?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n as usize > MAX_CPT_ARCHIVE)
    {
        return Err(failed);
    }
    let bytes = response.bytes().await.map_err(|_| {
        Error::Unavailable("The CPT file could not be downloaded from CMS. Try again later.")
    })?;
    if bytes.len() > MAX_CPT_ARCHIVE {
        return Err(failed);
    }
    Ok(bytes.to_vec())
}
/// The CPT edition this tenant already has from the built-in source, if any.
async fn installed_cpt(tx: &mut Transaction<'_, Postgres>, actor: &Actor) -> Result<Option<Uuid>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM terminology_releases WHERE tenant_id=$1 AND system='CPT' AND edition=$2",
    )
    .bind(actor.tenant_id)
    .bind(CPT_SOURCE.edition)
    .fetch_optional(&mut **tx)
    .await?)
}
/// Installs CPT for a practice whose owner attests it holds a CPT license, from bytes already
/// fetched (the handler downloads them; tests pass a synthetic archive).
pub(crate) async fn install_cpt(
    pool: &PgPool,
    actor: &Actor,
    request: (Uuid, &str, Option<NaiveDate>),
    source: &CptSource,
    bytes: &[u8],
) -> Result<(Value, bool)> {
    let input = cpt_import_from_archive(bytes, source, request.1, request.2, request.0)?;
    let mut tx = pool.begin().await?;
    let stored = store_release(&mut tx, actor, &input, "terminology.release.cpt_installed").await?;
    tx.commit().await?;
    Ok(stored)
}
async fn cpt_install(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Json(body): Json<CptInstall>,
) -> Result<Response> {
    if !matches!(actor.role, Role::Owner) {
        return Err(Error::Forbidden);
    }
    if !body.license_attested {
        return Err(Error::Invalid(
            "Confirm that your practice holds a CPT license.",
        ));
    }
    let reference = clean(&body.license_reference, 500)
        .map_err(|_| Error::Invalid("Enter the CPT license reference."))?;
    if body
        .license_valid_until
        .is_some_and(|date| date < Utc::now().date_naive())
    {
        return Err(Error::Invalid("The CPT license date has passed."));
    }
    let pool = db(&state)?;
    let mut tx = pool.begin().await?;
    if let Some(id) = installed_cpt(&mut tx, &actor).await? {
        let value = release(&mut tx, &actor, id).await?;
        tx.commit().await?;
        return Ok(reply(json!({"release":value,"created":false})));
    }
    tx.commit().await?;
    let bytes = download_cpt(&CPT_SOURCE).await?;
    let (value, created) = install_cpt(
        pool,
        &actor,
        (body.request_id, &reference, body.license_valid_until),
        &CPT_SOURCE,
        &bytes,
    )
    .await?;
    Ok(reply(json!({"release":value,"created":created})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseQuery {
    system: Option<String>,
    after: Option<Uuid>,
    limit: Option<i64>,
}
async fn list_releases(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Query(query): Query<ReleaseQuery>,
) -> Result<Response> {
    actor.staff()?;
    let selected = query.system.as_deref().map(system).transpose()?;
    let limit = page_size(query.limit)?;
    let mut tx = db(&state)?.begin().await?;
    let rows:Vec<(Uuid,Value)>=sqlx::query_as(&format!("SELECT r.id,{RELEASE_PUBLIC} FROM terminology_releases r WHERE r.tenant_id=$1 AND ($2::text IS NULL OR r.system=$2) AND ($3::uuid IS NULL OR r.id>$3) AND {LICENSE_VISIBLE} ORDER BY r.id LIMIT $4"))
        .bind(actor.tenant_id).bind(selected).bind(query.after).bind(limit+1).fetch_all(&mut *tx).await?;
    let has_more = rows.len() > limit as usize;
    let items: Vec<Value> = rows
        .into_iter()
        .take(limit as usize)
        .map(|(_, value)| value)
        .collect();
    let next = if has_more {
        items.last().and_then(|v| v.get("id")).cloned()
    } else {
        None
    };
    audit(
        &mut tx,
        &actor,
        "terminology.releases.read",
        actor.tenant_id,
    )
    .await?;
    tx.commit().await?;
    Ok(reply(json!({"items":items,"next_cursor":next})))
}
fn page_size(limit: Option<i64>) -> Result<i64> {
    let limit = limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        Err(Error::Invalid("catalog page size must be 1 to 100"))
    } else {
        Ok(limit)
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CodeCursor {
    release_id: Uuid,
    code: String,
    context: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchQuery {
    system: String,
    q: Option<String>,
    service_date: Option<NaiveDate>,
    billable: Option<bool>,
    active: Option<bool>,
    release_id: Option<Uuid>,
    limit: Option<i64>,
    after: Option<String>,
}
fn cursor(value: Option<&str>) -> Result<Option<CodeCursor>> {
    value
        .map(|value| {
            if value.len() > 256 {
                return Err(Error::Invalid("invalid catalog cursor"));
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(value)
                .map_err(|_| Error::Invalid("invalid catalog cursor"))?;
            let cursor: CodeCursor = serde_json::from_slice(&bytes)
                .map_err(|_| Error::Invalid("invalid catalog cursor"))?;
            if cursor.code.is_empty()
                || cursor.code.len() > 8
                || cursor.context.len() != 64
                || !cursor.context.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(Error::Invalid("invalid catalog cursor"));
            }
            Ok(cursor)
        })
        .transpose()
}
async fn search(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Query(query): Query<SearchQuery>,
) -> Result<Response> {
    actor.staff()?;
    let selected = system(&query.system)?;
    let limit = page_size(query.limit)?;
    let search = query.q.as_deref().unwrap_or("").trim();
    if search.len() > 200 || search.chars().any(char::is_control) {
        return Err(Error::Invalid("catalog search exceeds its limit"));
    }
    let cursor = cursor(query.after.as_deref())?;
    if cursor
        .as_ref()
        .is_some_and(|c| query.release_id.is_some_and(|id| id != c.release_id))
    {
        return Err(Error::Invalid(
            "catalog cursor belongs to a different release",
        ));
    }
    let requested = cursor.as_ref().map(|c| c.release_id).or(query.release_id);
    let date = query
        .service_date
        .unwrap_or_else(|| Utc::now().date_naive());
    let mut tx = db(&state)?.begin().await?;
    let id:Option<Uuid>=sqlx::query_scalar(&format!("SELECT r.id FROM terminology_releases r WHERE r.tenant_id=$1 AND r.system=$2 AND {LICENSE_VISIBLE} AND (($3::uuid IS NOT NULL AND r.id=$3) OR ($3::uuid IS NULL AND r.effective_start<=$4 AND (r.effective_end IS NULL OR r.effective_end>=$4))) ORDER BY r.effective_start DESC,r.created_at DESC,r.id DESC LIMIT 1"))
        .bind(actor.tenant_id).bind(selected).bind(requested).bind(date).fetch_optional(&mut *tx).await?;
    let Some(id) = id else {
        if requested.is_some() {
            return Err(Error::NotFound);
        }
        audit(&mut tx, &actor, "terminology.codes.search", actor.tenant_id).await?;
        tx.commit().await?;
        return Ok(reply(
            json!({"items":[],"release":null,"next_cursor":null,"service_date":date}),
        ));
    };
    let publication = release(&mut tx, &actor, id).await?;
    let context = crate::oauth::hash(&json!({"system":selected,"q":search.to_lowercase(),"service_date":date,"billable":query.billable,"active":query.active.unwrap_or(true),"release_id":id}).to_string());
    if cursor
        .as_ref()
        .is_some_and(|cursor| cursor.context != context)
    {
        return Err(Error::Invalid(
            "catalog cursor belongs to a different search or service date",
        ));
    }
    let code_prefix = format!(
        "{}%",
        search
            .replace('.', "")
            .to_ascii_uppercase()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let words = search
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .take(20)
        .map(|word| format!("{word}:*"))
        .collect::<Vec<_>>()
        .join(" & ");
    let rows:Vec<Value>=sqlx::query_scalar(&format!("SELECT {CODE_PUBLIC} FROM terminology_codes c JOIN terminology_releases r ON r.tenant_id=c.tenant_id AND r.id=c.release_id WHERE c.tenant_id=$1 AND c.release_id=$2 AND ($3::text='' OR c.code_key LIKE $4 OR c.search_text@@to_tsquery('simple',$5)) AND ($6::boolean IS NULL OR c.billable=$6) AND c.active=$7 AND greatest(r.effective_start,c.effective_start)<=$8 AND (least(r.effective_end,c.effective_end) IS NULL OR least(r.effective_end,c.effective_end)>=$8) AND ($9::text IS NULL OR c.code>$9) ORDER BY c.code LIMIT $10"))
        .bind(actor.tenant_id).bind(id).bind(search).bind(code_prefix).bind(words).bind(query.billable).bind(query.active.unwrap_or(true)).bind(date).bind(cursor.as_ref().map(|c|c.code.as_str())).bind(limit+1).fetch_all(&mut *tx).await?;
    let has_more = rows.len() > limit as usize;
    let items: Vec<Value> = rows.into_iter().take(limit as usize).collect();
    let next = if has_more {
        items.last().and_then(|v| v["code"].as_str()).map(|code| {
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&CodeCursor {
                    release_id: id,
                    code: code.into(),
                    context: context.clone(),
                })
                .expect("serializable cursor"),
            )
        })
    } else {
        None
    };
    audit(&mut tx, &actor, "terminology.codes.search", id).await?;
    tx.commit().await?;
    Ok(reply(
        json!({"items":items,"release":publication,"next_cursor":next,"service_date":date}),
    ))
}
async fn code(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
    value: &str,
) -> Result<Value> {
    let key = value.trim().to_ascii_uppercase().replace('.', "");
    if key.len() > 8 || key.is_empty() {
        return Err(Error::Invalid("invalid catalog code"));
    }
    sqlx::query_scalar(&format!("SELECT {CODE_PUBLIC} FROM terminology_codes c JOIN terminology_releases r ON r.tenant_id=c.tenant_id AND r.id=c.release_id WHERE c.tenant_id=$1 AND c.release_id=$2 AND c.code_key=$3 AND {LICENSE_VISIBLE}"))
        .bind(actor.tenant_id).bind(id).bind(key).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn detail(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path((id, value)): Path<(Uuid, String)>,
) -> Result<Response> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    let value = code(&mut tx, &actor, id, &value).await?;
    audit(&mut tx, &actor, "terminology.code.read", id).await?;
    tx.commit().await?;
    Ok(reply(value))
}
/// Validate a selection within the caller's clinical mutation transaction. The
/// caller checks its required system and records its normal atomic audit event.
pub(crate) async fn resolve_code(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    release_id: Uuid,
    value: &str,
    service_date: NaiveDate,
    require_billable: bool,
) -> Result<Value> {
    let mut value = code(tx, actor, release_id, value).await?;
    let start: NaiveDate = serde_json::from_value(value["effective_start"].clone())
        .map_err(|_| Error::Conflict("catalog effective dates are invalid"))?;
    let end: Option<NaiveDate> = serde_json::from_value(value["effective_end"].clone())
        .map_err(|_| Error::Conflict("catalog effective dates are invalid"))?;
    if value["active"] != true || start > service_date || end.is_some_and(|end| end < service_date)
    {
        return Err(Error::Invalid(
            "selected code is not active for this service date",
        ));
    }
    if require_billable && value["billable"] != true {
        return Err(Error::Invalid(
            "select a billable code rather than a category heading",
        ));
    }
    // This is clinical selection provenance, distinct from catalog effective
    // dates. Preserve the exact service date validated by this transaction.
    value["service_date"] = json!(service_date);
    Ok(value)
}

#[cfg(test)]
#[path = "terminology_cpt_tests.rs"]
mod cpt_tests;
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Import {
        serde_json::from_value(json!({"request_id":Uuid::new_v4(),"system":"ICD-10-CM","edition":"synthetic","source_name":"Synthetic fixture","source_url":"https://example.test/catalog","source_sha256":"a".repeat(64),"effective_start":"2026-10-01","effective_end":"2027-09-30","rights":"public_use","rights_attested":true,"reason":"Synthetic only","codes":[{"code":"z0000","display":"Synthetic diagnosis","billable":true}]})).unwrap()
    }
    #[test]
    fn canonical_codes_preserve_categories_and_validate_systems() {
        assert_eq!(canonical_code("ICD-10-CM", " z0000 ").unwrap(), "Z00.00");
        assert!(canonical_code("ICD-10-CM", "Z.0000").is_err());
        assert!(canonical_code("ICD-10-CM", "Z00.").is_err());
        assert_eq!(canonical_code("ICD-10-CM", "QA00101").unwrap(), "QA0.0101");
        for code in ["0001F", "0001T", "0001U", "0001M", "99999"] {
            assert!(canonical_code("CPT", code).is_ok());
        }
        assert!(canonical_code("CPT", "J0000").is_err());
        assert!(canonical_code("HCPCS", "J0000").is_ok());
        assert!(canonical_code("ICD-10-PCS", "0I00000").is_err());
    }
    #[test]
    fn import_requires_explicit_rights_and_licensed_cpt() {
        let mut input = fixture();
        input.validate().unwrap();
        assert_eq!(input.codes[0].code, "Z00.00");
        input.rights_attested = false;
        assert!(input.validate().is_err());
        let mut input = fixture();
        input.system = "CPT".into();
        input.codes[0].code = "99999".into();
        assert!(input.validate().is_err());
        input.rights = "licensed".into();
        assert!(input.validate().is_err());
        input.license_reference = Some("synthetic-license".into());
        input.validate().unwrap();
        input.license_valid_until = Some(NaiveDate::from_ymd_opt(2000, 1, 1).unwrap());
        assert!(input.validate().is_err());
    }
    #[test]
    fn import_rejects_duplicate_codes_and_secret_bearing_urls() {
        let mut input = fixture();
        let mut duplicate = fixture().codes.remove(0);
        duplicate.code = "Z00.00".into();
        input.codes.push(duplicate);
        assert!(input.validate().is_err());
        for url in [
            "http://example.test/catalog",
            "https://user:password@example.test/catalog",
            "https://example.test/catalog?token=secret",
        ] {
            let mut input = fixture();
            input.source_url = url.into();
            assert!(input.validate().is_err());
        }
    }
}
