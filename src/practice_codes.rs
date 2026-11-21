// SPDX-License-Identifier: AGPL-3.0-only
//! Practice code settings. Owners turn each terminology system on or off for the practice and
//! keep a practice list of codes with a price, default units and modifiers. Dropdowns and charge
//! pricing follow these settings. Nothing here rewrites clinical or billing history: a code
//! leaves the dropdowns by being turned off, never by deletion.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{Path, Query, State as ExtractState},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

const SYSTEMS: [&str; 4] = ["ICD-10-CM", "ICD-10-PCS", "HCPCS", "CPT"];
const SET_VIEW: &str = "jsonb_build_object('enabled',s.enabled,'version',s.version)";
const CODE_VIEW:&str="jsonb_build_object('id',c.id,'system',c.system,'code',c.code,'display',c.display,'enabled',c.enabled,'price_cents',c.price_cents,'default_units',c.default_units,'modifiers',c.modifiers,'version',c.version)";
const DUPLICATE_CODE: &str = "This code is already in your list.";

fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::Unauthorized)?.db)
}
fn reply(v: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response()
}
/// A quoted If-Match version; 0 is accepted because a code-set row may not exist yet.
fn version(h: &HeaderMap) -> Result<i64> {
    let raw = h
        .get(header::IF_MATCH)
        .ok_or(Error::VersionRequired)?
        .to_str()
        .map_err(|_| Error::Invalid("invalid If-Match"))?;
    raw.strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 0)
        .ok_or(Error::Invalid("If-Match must be a quoted record version"))
}
async fn owner(s: &State, h: &HeaderMap, write: bool) -> Result<Actor> {
    let a = s
        .browser
        .as_ref()
        .ok_or(Error::Unauthorized)?
        .authenticate(h, write)
        .await?;
    if !matches!(a.role, Role::Owner) {
        return Err(Error::Forbidden);
    }
    Ok(a)
}
/// Who may add a code to the practice list or set its price: the owner, and the staff who enter
/// charges. Staff other than the owner may add a code and change a price, and nothing else: turning
/// a code off, renaming it, and switching a whole code set stay with the owner.
async fn price_editor(s: &State, h: &HeaderMap) -> Result<Actor> {
    let a = s
        .browser
        .as_ref()
        .ok_or(Error::Unauthorized)?
        .authenticate(h, true)
        .await?;
    a.scheduling()?;
    if !matches!(a.role, Role::Owner) {
        crate::access_policies::require_native(s, &a, "billing", "edit").await?;
    }
    Ok(a)
}
async fn locked<'a>(s: &'a State, a: &Actor) -> Result<Transaction<'a, Postgres>> {
    let mut tx = db(s)?.begin().await?;
    crate::billing::tenant_lock(&mut tx, a).await?;
    Ok(tx)
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
/// Modifiers for a practice code: empty, or up to four two-character uppercase alphanumeric
/// codes separated by single spaces. Stored and returned exactly in that form.
fn modifiers(s: &str) -> Result<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let parts: Vec<&str> = trimmed.split(' ').filter(|p| !p.is_empty()).collect();
    if trimmed.contains("  ")
        || parts.len() > 4
        || parts
            .iter()
            .any(|p| p.len() != 2 || !p.bytes().all(|b| b.is_ascii_alphanumeric()))
    {
        return Err(Error::Invalid(
            "modifiers are up to four two-character uppercase codes separated by single spaces",
        ));
    }
    Ok(parts
        .iter()
        .map(|p| p.to_ascii_uppercase())
        .collect::<Vec<_>>()
        .join(" "))
}
/// True when the tenant has any release installed for the system, whatever its license dates.
pub(crate) async fn installed(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    code_system: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM terminology_releases WHERE tenant_id=$1 AND system=$2)",
    )
    .bind(tenant)
    .bind(code_system)
    .fetch_one(&mut **tx)
    .await?)
}
async fn set_item(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    name: &'static str,
) -> Result<Value> {
    let stored: Option<Value> = sqlx::query_scalar(&format!(
        "SELECT {SET_VIEW} FROM practice_code_sets s WHERE tenant_id=$1 AND system=$2"
    ))
    .bind(tenant)
    .bind(name)
    .fetch_optional(&mut **tx)
    .await?;
    let mut item = match stored {
        Some(v) => v,
        None => json!({"enabled":true,"version":0}),
    };
    item["system"] = json!(name);
    item["installed"] = json!(installed(tx, tenant, name).await?);
    Ok(item)
}
/// Whether the tenant left the system on. No settings row means on.
pub(crate) async fn system_enabled(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    code_system: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT coalesce(enabled,true) FROM practice_code_sets WHERE tenant_id=$1 AND system=$2",
    )
    .bind(tenant)
    .bind(code_system)
    .fetch_optional(&mut **tx)
    .await?
    .unwrap_or(true))
}
/// Whether a practice row exists for the code and is on. None means no row: the code is not
/// hidden, it simply carries no practice settings.
pub(crate) async fn code_on(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    code_system: &str,
    code: &str,
) -> Result<Option<bool>> {
    Ok(sqlx::query_scalar(
        "SELECT enabled FROM practice_codes WHERE tenant_id=$1 AND system=$2 AND code=$3",
    )
    .bind(tenant)
    .bind(code_system)
    .bind(code)
    .fetch_optional(&mut **tx)
    .await?)
}
/// The practice rows that are on for a system, as dropdown/pricing items, ordered by code.
pub(crate) async fn enabled_items(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    code_system: &str,
) -> Result<Vec<Value>> {
    Ok(sqlx::query_scalar(&format!("SELECT {CODE_VIEW} FROM practice_codes c WHERE c.tenant_id=$1 AND c.system=$2 AND c.enabled ORDER BY c.code"))
        .bind(tenant)
        .bind(code_system)
        .fetch_all(&mut **tx)
        .await?)
}

async fn list_code_sets(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Response> {
    let a = owner(&s, &h, false).await?;
    let mut tx = locked(&s, &a).await?;
    let mut items = Vec::with_capacity(SYSTEMS.len());
    for name in SYSTEMS {
        items.push(set_item(&mut tx, a.tenant_id, name).await?);
    }
    crate::postgres::audit(&mut tx, &a, "practice.code_sets.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(reply(json!({"items":items})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetUpdate {
    enabled: bool,
}
async fn update_code_set(
    ExtractState(s): ExtractState<State>,
    Path(raw): Path<String>,
    h: HeaderMap,
    Json(body): Json<SetUpdate>,
) -> Result<Response> {
    let a = owner(&s, &h, true).await?;
    let selected = system(&raw)?;
    let expected = version(&h)?;
    let mut tx = locked(&s, &a).await?;
    crate::partner_support::verify_owner_in_tx(&mut tx, &a, &h).await?;
    let current: Option<(bool, i64)> = sqlx::query_as(
        "SELECT enabled,version FROM practice_code_sets WHERE tenant_id=$1 AND system=$2 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(selected)
    .fetch_optional(&mut *tx)
    .await?;
    let current = current.unwrap_or((true, 0));
    if current.1 != expected {
        return Err(Error::Conflict("code set changed; reload before saving"));
    }
    if current.1 == 0 {
        sqlx::query("INSERT INTO practice_code_sets(tenant_id,system,enabled,version,updated_by) VALUES($1,$2,$3,1,$4)")
            .bind(a.tenant_id)
            .bind(selected)
            .bind(body.enabled)
            .bind(a.sub)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("UPDATE practice_code_sets SET enabled=$3,version=version+1,updated_by=$4,updated_at=now() WHERE tenant_id=$1 AND system=$2")
            .bind(a.tenant_id)
            .bind(selected)
            .bind(body.enabled)
            .bind(a.sub)
            .execute(&mut *tx)
            .await?;
    }
    let item = set_item(&mut tx, a.tenant_id, selected).await?;
    crate::postgres::audit(&mut tx, &a, "practice.code_set.updated", a.tenant_id).await?;
    tx.commit().await?;
    Ok(reply(item))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CodeQuery {
    system: Option<String>,
    #[serde(default)]
    q: Option<String>,
    enabled: Option<bool>,
}
async fn list_codes(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Query(query): Query<CodeQuery>,
) -> Result<Response> {
    a.staff()?;
    crate::access_policies::require_native(&s, &a, "billing", "view").await?;
    let selected = query.system.as_deref().map(system).transpose()?;
    let search = query.q.as_deref().unwrap_or("").trim();
    if search.chars().count() > 100 || search.chars().any(char::is_control) {
        return Err(Error::Invalid("code search exceeds its limit"));
    }
    // Code-prefix matching ignores dots and case, like the catalog search; every search word
    // must prefix-match a display word.
    let prefix = search
        .to_ascii_uppercase()
        .replace('.', "")
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let words = search
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .take(20)
        .map(|word| format!("{word}:*"))
        .collect::<Vec<_>>()
        .join(" & ");
    let mut tx = locked(&s, &a).await?;
    let items: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT {CODE_VIEW} FROM practice_codes c WHERE c.tenant_id=$1 AND ($2::text IS NULL OR c.system=$2) \
         AND ($3::boolean IS NULL OR c.enabled=$3) AND ($4::text='' OR upper(replace(c.code,'.','')) LIKE $5||'%' \
         OR ($6::text<>'' AND to_tsvector('simple',c.display)@@to_tsquery('simple',$6))) ORDER BY c.system,c.code LIMIT 500"
    ))
    .bind(a.tenant_id)
    .bind(selected)
    .bind(query.enabled)
    .bind(search)
    .bind(&prefix)
    .bind(&words)
    .fetch_all(&mut *tx)
    .await?;
    crate::postgres::audit(&mut tx, &a, "practice.codes.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(reply(json!({"items":items,"limit":500})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewCode {
    request_id: Uuid,
    system: String,
    code: String,
    display: String,
    enabled: bool,
    price_cents: Option<i64>,
    default_units: i32,
    #[serde(default)]
    modifiers: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CodeUpdate {
    display: String,
    enabled: bool,
    price_cents: Option<i64>,
    default_units: i32,
    #[serde(default)]
    modifiers: String,
}
/// Validated list fields shared by create and update. Returns the canonical modifiers.
fn fields(display: &str, price: Option<i64>, units: i32, raw_modifiers: &str) -> Result<String> {
    let display = display.trim();
    if display.is_empty() || display.chars().count() > 1000 || display.chars().any(char::is_control)
    {
        return Err(Error::Invalid("code display is missing or too long"));
    }
    if price.is_some_and(|p| !(0..=10000000).contains(&p)) {
        return Err(Error::Invalid("price must be 0 to 10000000 cents or empty"));
    }
    if !(1..=9999).contains(&units) {
        return Err(Error::Invalid("default units must be 1 to 9999"));
    }
    modifiers(raw_modifiers)
}
async fn code_row(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Value> {
    sqlx::query_scalar(&format!(
        "SELECT {CODE_VIEW} FROM practice_codes c WHERE c.tenant_id=$1 AND c.id=$2"
    ))
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::NotFound)
}
async fn create(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(body): Json<NewCode>,
) -> Result<Response> {
    let a = price_editor(&s, &h).await?;
    let is_owner = matches!(a.role, Role::Owner);
    if !is_owner && !body.enabled {
        return Err(Error::Forbidden);
    }
    let selected = system(&body.system)?;
    let code = crate::terminology::canonical_code(selected, &body.code)
        .map_err(|_| Error::Invalid("code is not valid for its system"))?;
    let display = body.display.trim().to_owned();
    let mods = fields(
        &display,
        body.price_cents,
        body.default_units,
        &body.modifiers,
    )?;
    let mut tx = locked(&s, &a).await?;
    if is_owner {
        crate::partner_support::verify_owner_in_tx(&mut tx, &a, &h).await?;
    }
    if let Some((id, existing)) = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id,system||':'||code FROM practice_codes WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(body.request_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        if existing != format!("{selected}:{code}") {
            return Err(Error::Conflict(
                "code request was already used with a different code",
            ));
        }
        let item = code_row(&mut tx, &a, id).await?;
        tx.commit().await?;
        return Ok(reply(item));
    }
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM practice_codes WHERE tenant_id=$1 AND system=$2 AND code=$3)",
    )
    .bind(a.tenant_id)
    .bind(selected)
    .bind(&code)
    .fetch_one(&mut *tx)
    .await?;
    if taken {
        return Err(Error::CodedConflict {
            code: "practice_code_exists",
            message: DUPLICATE_CODE,
        });
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_codes(tenant_id,id,system,code,display,enabled,price_cents,default_units,modifiers,version,request_id,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$11)")
        .bind(a.tenant_id)
        .bind(id)
        .bind(selected)
        .bind(&code)
        .bind(&display)
        .bind(body.enabled)
        .bind(body.price_cents)
        .bind(body.default_units)
        .bind(&mods)
        .bind(body.request_id)
        .bind(a.sub)
        .execute(&mut *tx)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(d) if d.code().as_deref() == Some("23505") => {
                Error::CodedConflict {
                    code: "practice_code_exists",
                    message: DUPLICATE_CODE,
                }
            }
            _ => e.into(),
        })?;
    let item = code_row(&mut tx, &a, id).await?;
    crate::postgres::audit(&mut tx, &a, "practice.code.created", id).await?;
    tx.commit().await?;
    Ok(reply(item))
}
async fn update(
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(body): Json<CodeUpdate>,
) -> Result<Response> {
    let a = price_editor(&s, &h).await?;
    let is_owner = matches!(a.role, Role::Owner);
    let expected = version(&h)?;
    let display = body.display.trim().to_owned();
    let mods = fields(
        &display,
        body.price_cents,
        body.default_units,
        &body.modifiers,
    )?;
    let mut tx = locked(&s, &a).await?;
    if is_owner {
        crate::partner_support::verify_owner_in_tx(&mut tx, &a, &h).await?;
    }
    let current: Option<i64> = sqlx::query_scalar(
        "SELECT version FROM practice_codes WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let current = current.ok_or(Error::NotFound)?;
    if current != expected {
        return Err(Error::Conflict("code changed; reload before saving"));
    }
    if !is_owner {
        // Staff change the price only; everything else about the code must be sent back unchanged.
        let kept: (String, bool, i32, String) = sqlx::query_as(
            "SELECT display,enabled,default_units,modifiers FROM practice_codes WHERE tenant_id=$1 AND id=$2",
        )
        .bind(a.tenant_id)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if kept.0 != display
            || kept.1 != body.enabled
            || kept.2 != body.default_units
            || kept.3 != mods
        {
            return Err(Error::Forbidden);
        }
    }
    sqlx::query("UPDATE practice_codes SET display=$3,enabled=$4,price_cents=$5,default_units=$6,modifiers=$7,version=version+1,updated_by=$8,updated_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .bind(&display)
        .bind(body.enabled)
        .bind(body.price_cents)
        .bind(body.default_units)
        .bind(&mods)
        .bind(a.sub)
        .execute(&mut *tx)
        .await?;
    let item = code_row(&mut tx, &a, id).await?;
    crate::postgres::audit(&mut tx, &a, "practice.code.updated", id).await?;
    tx.commit().await?;
    Ok(reply(item))
}

// ---- Bundles: named sets of procedure lines added to an encounter in one pick.

const BUNDLE_VIEW: &str = "jsonb_build_object('id',b.id,'name',b.name,'lines',b.lines,'enabled',b.enabled,'version',b.version)";
const DUPLICATE_BUNDLE: &str = "A bundle with this name already exists.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleLine {
    code_system: String,
    code: String,
    description: String,
    #[serde(default)]
    modifiers: String,
    units: i32,
    #[serde(default)]
    ndc_code: Option<String>,
    #[serde(default)]
    ndc_quantity: Option<String>,
    #[serde(default)]
    ndc_unit: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleBody {
    name: String,
    lines: Vec<BundleLine>,
    #[serde(default = "yes")]
    enabled: bool,
}
fn yes() -> bool {
    true
}
/// The bundle as it is stored: a trimmed name and lines whose codes are in their canonical form.
fn bundle_fields(body: &BundleBody) -> Result<(String, Value)> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "Give the bundle a name of up to 80 characters.",
        ));
    }
    if body.lines.is_empty() || body.lines.len() > 20 {
        return Err(Error::Invalid("A bundle has 1 to 20 procedure lines."));
    }
    let mut lines = Vec::with_capacity(body.lines.len());
    for line in &body.lines {
        let selected = system(&line.code_system)?;
        if !matches!(selected, "CPT" | "HCPCS") {
            return Err(Error::Invalid("A bundle holds procedure codes only."));
        }
        let code = crate::terminology::canonical_code(selected, &line.code)
            .map_err(|_| Error::Invalid("A code in this bundle is not a valid procedure code."))?;
        let mods = fields(&line.description, None, line.units, &line.modifiers)?;
        let mut stored = json!({"code_system":selected,"code":code,"description":line.description.trim(),"modifiers":mods,"units":line.units});
        let ndc = [&line.ndc_code, &line.ndc_quantity, &line.ndc_unit]
            .map(|v| v.as_deref().map(str::trim).filter(|v| !v.is_empty()));
        match ndc {
            [None, None, None] => {}
            [Some(code), Some(quantity), Some(unit)]
                if code.len() <= 20 && quantity.len() <= 20 && unit.len() <= 4 =>
            {
                stored["ndc_code"] = json!(code);
                stored["ndc_quantity"] = json!(quantity);
                stored["ndc_unit"] = json!(unit);
            }
            _ => {
                return Err(Error::Invalid(
                    "For a drug line, give its NDC code, quantity and unit together.",
                ))
            }
        }
        lines.push(stored);
    }
    Ok((name.to_owned(), Value::Array(lines)))
}
async fn bundle_row(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Value> {
    sqlx::query_scalar(&format!(
        "SELECT {BUNDLE_VIEW} FROM practice_charge_bundles b WHERE b.tenant_id=$1 AND b.id=$2"
    ))
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::NotFound)
}
async fn bundle_name_taken(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    name: &str,
    except: Option<Uuid>,
) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM practice_charge_bundles WHERE tenant_id=$1 AND enabled AND lower(name)=lower($2) AND ($3::uuid IS NULL OR id<>$3))",
    )
    .bind(a.tenant_id)
    .bind(name)
    .bind(except)
    .fetch_one(&mut **tx)
    .await?)
}
async fn list_bundles(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Response> {
    a.staff()?;
    crate::access_policies::require_native(&s, &a, "billing", "view").await?;
    let items: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT {BUNDLE_VIEW} FROM practice_charge_bundles b WHERE b.tenant_id=$1 AND b.enabled ORDER BY lower(b.name),b.id LIMIT 200"
    ))
    .bind(a.tenant_id)
    .fetch_all(db(&s)?)
    .await?;
    Ok(reply(json!({"items":items})))
}
async fn create_bundle(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(body): Json<BundleBody>,
) -> Result<Response> {
    let a = price_editor(&s, &h).await?;
    let (name, lines) = bundle_fields(&body)?;
    let mut tx = locked(&s, &a).await?;
    if bundle_name_taken(&mut tx, &a, &name, None).await? {
        return Err(Error::CodedConflict {
            code: "charge_bundle_exists",
            message: DUPLICATE_BUNDLE,
        });
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO practice_charge_bundles(tenant_id,id,name,lines,enabled,version,created_by,updated_by) VALUES($1,$2,$3,$4,true,1,$5,$5)")
        .bind(a.tenant_id)
        .bind(id)
        .bind(&name)
        .bind(&lines)
        .bind(a.sub)
        .execute(&mut *tx)
        .await?;
    let item = bundle_row(&mut tx, &a, id).await?;
    crate::postgres::audit(&mut tx, &a, "practice.charge_bundle.created", id).await?;
    tx.commit().await?;
    Ok(reply(item))
}
async fn update_bundle(
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(body): Json<BundleBody>,
) -> Result<Response> {
    let a = price_editor(&s, &h).await?;
    let expected = version(&h)?;
    let (name, lines) = bundle_fields(&body)?;
    let mut tx = locked(&s, &a).await?;
    let current: Option<i64> = sqlx::query_scalar(
        "SELECT version FROM practice_charge_bundles WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    if current.ok_or(Error::NotFound)? != expected {
        return Err(Error::Conflict("bundle changed; reload before saving"));
    }
    if body.enabled && bundle_name_taken(&mut tx, &a, &name, Some(id)).await? {
        return Err(Error::CodedConflict {
            code: "charge_bundle_exists",
            message: DUPLICATE_BUNDLE,
        });
    }
    sqlx::query("UPDATE practice_charge_bundles SET name=$3,lines=$4,enabled=$5,version=version+1,updated_by=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(id)
        .bind(&name)
        .bind(&lines)
        .bind(body.enabled)
        .bind(a.sub)
        .execute(&mut *tx)
        .await?;
    let item = bundle_row(&mut tx, &a, id).await?;
    crate::postgres::audit(&mut tx, &a, "practice.charge_bundle.updated", id).await?;
    tx.commit().await?;
    Ok(reply(item))
}

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/practice/code-sets", get(list_code_sets))
        .route("/api/v1/practice/code-sets/{system}", put(update_code_set))
        .route("/api/v1/practice/codes", get(list_codes).post(create))
        .route("/api/v1/practice/codes/{id}", put(update))
        .route(
            "/api/v1/practice/charge-bundles",
            get(list_bundles).post(create_bundle),
        )
        .route("/api/v1/practice/charge-bundles/{id}", put(update_bundle))
}
