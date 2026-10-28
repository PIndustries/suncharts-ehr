// SPDX-License-Identifier: AGPL-3.0-only
//! Owner-only local practice administration. Credentials never leave the write path.
use crate::{
    auth::Actor,
    error::{Error, Result},
    State,
};
use argon2::{
    password_hash::{rand_core::OsRng, SaltString},
    Argon2, PasswordHasher,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::{header, HeaderMap},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/schedule/locations", get(schedule_locations))
        .route("/api/v1/practice/staff", get(staff).post(create_staff))
        .route(
            "/api/v1/practice/staff/{id}",
            axum::routing::put(update_staff),
        )
        .route(
            "/api/v1/practice/providers",
            get(providers).post(create_provider),
        )
        .route(
            "/api/v1/practice/providers/{id}",
            axum::routing::put(update_provider),
        )
        .route(
            "/api/v1/practice/facilities",
            get(facilities).post(create_facility),
        )
        .route(
            "/api/v1/practice/facilities/{id}",
            axum::routing::put(update_facility),
        )
        .route("/api/v1/practice/rooms", get(rooms).post(create_room))
        .route(
            "/api/v1/practice/rooms/{id}",
            axum::routing::put(update_room),
        )
        .route("/api/v1/practice/admin-history/{kind}/{id}", get(history))
}
// Deliberately require a real local owner browser session. Clinical integration
// scopes must never implicitly become identity-administration privileges.
async fn owner(s: &State, h: &HeaderMap, write: bool) -> Result<Actor> {
    let a = s
        .browser
        .as_ref()
        .ok_or(Error::Unauthorized)?
        .authenticate(h, write)
        .await?;
    if !matches!(a.role, crate::auth::Role::Owner) {
        return Err(Error::Forbidden);
    }
    Ok(a)
}
async fn locked<'a>(s: &'a State, a: &Actor) -> Result<Transaction<'a, Postgres>> {
    let mut tx = s
        .browser
        .as_ref()
        .ok_or(Error::Unauthorized)?
        .db
        .begin()
        .await?;
    // Every admin mutation serializes per tenant, including last-owner checks,
    // parent directory checks, and staff-role/provider eligibility decisions.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,320032))")
        .bind(a.tenant_id.to_string())
        .execute(&mut *tx)
        .await?;
    crate::scheduling::tenant_lock(&mut tx, a).await?;
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM browser_users WHERE tenant_id=$1 AND id=$2 AND role='owner' AND NOT disabled)").bind(a.tenant_id).bind(a.sub).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(Error::Forbidden);
    }
    Ok(tx)
}
fn version(h: &HeaderMap) -> Result<i64> {
    h.get(header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix('"'))
        .and_then(|v| v.strip_suffix('"'))
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0)
        .ok_or(Error::VersionRequired)
}
fn text(s: &str, min: usize, max: usize) -> bool {
    let n = s.trim().chars().count();
    n >= min && n <= max && !s.chars().any(char::is_control)
}
fn reason(s: &str) -> Result<()> {
    if !text(s, 1, 1000) {
        return Err(Error::Invalid(
            "a reason of 1 to 1000 characters is required",
        ));
    }
    Ok(())
}
fn role(s: &str) -> bool {
    matches!(
        s,
        "owner" | "clinician" | "front_desk" | "read_only" | "nurse" | "medical_assistant"
    )
}
async fn record(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    kind: &str,
    id: Uuid,
    v: i64,
    why: &str,
    content: &Value,
) -> Result<()> {
    sqlx::query("INSERT INTO practice_admin_history(tenant_id,id,resource_id,kind,version,actor_id,reason,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(id).bind(kind).bind(v).bind(a.sub).bind(why.trim()).bind(content).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "practice.admin.write", id).await
}
async fn password_hash(password: String) -> Result<String> {
    if password.len() < 14 || password.len() > 1024 {
        return Err(Error::Invalid("password must be 14 to 1024 bytes"));
    }
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|p| p.to_string())
            .map_err(|_| Error::Invalid("password hashing failed"))
    })
    .await
    .map_err(|_| Error::Invalid("password hashing failed"))?
}
const STAFF_SELECT:&str="SELECT jsonb_build_object('id',id,'email',email,'display_name',display_name,'role',role,'disabled',disabled,'version',version) FROM browser_users WHERE tenant_id=$1 AND id=$2";
async fn staff_snapshot(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<Value> {
    sqlx::query_scalar(STAFF_SELECT)
        .bind(a.tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
async fn staff(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let a = owner(&s, &h, false).await?;
    let mut tx = locked(&s, &a).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'email',email,'display_name',display_name,'role',role,'disabled',disabled,'version',version) FROM browser_users WHERE tenant_id=$1 ORDER BY lower(display_name),email LIMIT 1001").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "practice.staff.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"has_more":items.len()>1000,"items":items.into_iter().take(1000).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewStaff {
    email: String,
    password: String,
    display_name: String,
    role: String,
    reason: String,
}
async fn create_staff(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(p): Json<NewStaff>,
) -> Result<Json<Value>> {
    let a = owner(&s, &h, true).await?;
    reason(&p.reason)?;
    let email = p.email.trim().to_lowercase();
    if !text(&email, 3, 254)
        || email.chars().any(char::is_whitespace)
        || email.matches('@').count() != 1
        || email.starts_with('@')
        || email.ends_with('@')
        || !text(&p.display_name, 1, 200)
        || !role(&p.role)
    {
        return Err(Error::Invalid(
            "valid email, display name and supported staff role are required",
        ));
    }
    let hash = password_hash(p.password).await?;
    let mut tx = locked(&s, &a).await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO browser_users(tenant_id,id,email,password_hash,display_name,role) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(id).bind(email).bind(hash).bind(p.display_name.trim()).bind(p.role).execute(&mut *tx).await?;
    let item = staff_snapshot(&mut tx, &a, id).await?;
    record(&mut tx, &a, "staff", id, 1, &p.reason, &item).await?;
    tx.commit().await?;
    Ok(Json(item))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StaffChange {
    display_name: String,
    role: String,
    disabled: bool,
    password: Option<String>,
    reason: String,
}
async fn update_staff(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(p): Json<StaffChange>,
) -> Result<Json<Value>> {
    let a = owner(&s, &h, true).await?;
    let v = version(&h)?;
    reason(&p.reason)?;
    if !text(&p.display_name, 1, 200) || !role(&p.role) {
        return Err(Error::Invalid(
            "valid display name and supported staff role are required",
        ));
    }
    let hash = match p.password {
        Some(p) => Some(password_hash(p).await?),
        None => None,
    };
    let mut tx = locked(&s, &a).await?;
    let old: Option<(String, bool, i64)> = sqlx::query_as(
        "SELECT role,disabled,version FROM browser_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(a.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (old_role, old_disabled, old_v) = old.ok_or(Error::NotFound)?;
    if old_v != v {
        return Err(Error::Conflict(
            "staff record changed; reload before saving",
        ));
    }
    if old_role == "owner" && !old_disabled && (p.role != "owner" || p.disabled) {
        let others:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM browser_users WHERE tenant_id=$1 AND id<>$2 AND role='owner' AND NOT disabled)").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
        if !others {
            return Err(Error::Conflict(
                "the last enabled practice owner cannot be disabled or demoted",
            ));
        }
    }
    let revoke = old_role != p.role || old_disabled != p.disabled || hash.is_some();
    sqlx::query("UPDATE browser_users SET display_name=$3,role=$4,disabled=$5,password_hash=coalesce($6,password_hash),version=version+1 WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(p.display_name.trim()).bind(&p.role).bind(p.disabled).bind(hash).execute(&mut *tx).await?;
    if revoke {
        sqlx::query("DELETE FROM browser_sessions WHERE tenant_id=$1 AND user_id=$2")
            .bind(a.tenant_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE oauth_grants SET revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=$1 AND user_id=$2").bind(a.tenant_id).bind(id).execute(&mut *tx).await?;
    }
    if p.disabled || !matches!(p.role.as_str(), "owner" | "clinician") {
        let changed:Option<(i64,Value)>=sqlx::query_as("UPDATE practice_providers SET active=false,version=version+1 WHERE tenant_id=$1 AND id=$2 AND active RETURNING version,to_jsonb(practice_providers)-'tenant_id'").bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
        if let Some((pv, profile)) = changed {
            record(
                &mut tx,
                &a,
                "provider",
                id,
                pv,
                "Provider deactivated by staff access change",
                &profile,
            )
            .await?;
        }
    }
    let item = staff_snapshot(&mut tx, &a, id).await?;
    record(&mut tx, &a, "staff", id, v + 1, &p.reason, &item).await?;
    tx.commit().await?;
    Ok(Json(item))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Provider {
    staff_id: Uuid,
    display_name: String,
    npi: String,
    specialty: String,
    active: bool,
    reason: String,
}
fn provider_valid(p: &Provider) -> Result<()> {
    reason(&p.reason)?;
    if !text(&p.display_name, 1, 200)
        || !text(&p.specialty, 0, 200)
        || (!p.npi.is_empty() && !valid_npi(&p.npi))
    {
        return Err(Error::Invalid(
            "valid provider name, specialty and NPI checksum are required",
        ));
    }
    Ok(())
}
fn valid_npi(n: &str) -> bool {
    if n.len() != 10
        || !n.bytes().all(|b| b.is_ascii_digit())
        || !matches!(n.as_bytes()[0], b'1' | b'2')
    {
        return false;
    }
    let s = format!("80840{n}");
    let sum: u32 = s
        .bytes()
        .rev()
        .enumerate()
        .map(|(i, c)| {
            let d = u32::from(c - b'0');
            if i % 2 == 1 {
                let x = d * 2;
                x / 10 + x % 10
            } else {
                d
            }
        })
        .sum();
    sum.is_multiple_of(10)
}
async fn eligible(tx: &mut Transaction<'_, Postgres>, a: &Actor, id: Uuid) -> Result<()> {
    let yes:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM browser_users WHERE tenant_id=$1 AND id=$2 AND NOT disabled AND role IN ('owner','clinician'))").bind(a.tenant_id).bind(id).fetch_one(&mut **tx).await?;
    if !yes {
        return Err(Error::Invalid(
            "an enabled local owner or clinician is required",
        ));
    }
    Ok(())
}
async fn providers(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    directory_list(s, h, "provider").await
}
async fn facilities(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    directory_list(s, h, "facility").await
}
async fn rooms(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    directory_list(s, h, "room").await
}
async fn directory_list(s: State, h: HeaderMap, kind: &str) -> Result<Json<Value>> {
    let a = owner(&s, &h, false).await?;
    let mut tx = locked(&s, &a).await?;
    let query=match kind {
 "provider"=>"SELECT to_jsonb(p)-'tenant_id' FROM practice_providers p WHERE tenant_id=$1 ORDER BY lower(display_name),id LIMIT 1001",
 "facility"=>"SELECT to_jsonb(p)-'tenant_id' FROM practice_facilities p WHERE tenant_id=$1 ORDER BY lower(name),id LIMIT 1001",
 _=>"SELECT to_jsonb(p)-'tenant_id' FROM practice_rooms p WHERE tenant_id=$1 ORDER BY lower(name),id LIMIT 1001"};
    let items: Vec<Value> = sqlx::query_scalar(query)
        .bind(a.tenant_id)
        .fetch_all(&mut *tx)
        .await?;
    crate::postgres::audit(&mut tx, &a, "practice.directory.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"has_more":items.len()>1000,"items":items.into_iter().take(1000).collect::<Vec<_>>()}),
    ))
}
async fn create_provider(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(p): Json<Provider>,
) -> Result<Json<Value>> {
    save_provider(s, h, None, p).await
}
async fn update_provider(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(p): Json<Provider>,
) -> Result<Json<Value>> {
    save_provider(s, h, Some(id), p).await
}
async fn save_provider(
    s: State,
    h: HeaderMap,
    id: Option<Uuid>,
    p: Provider,
) -> Result<Json<Value>> {
    let a = owner(&s, &h, true).await?;
    provider_valid(&p)?;
    let v = if id.is_some() {
        Some(version(&h)?)
    } else {
        None
    };
    if id.is_some_and(|id| id != p.staff_id) {
        return Err(Error::Invalid("provider staff identity cannot be changed"));
    }
    let mut tx = locked(&s, &a).await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM browser_users WHERE tenant_id=$1 AND id=$2)",
    )
    .bind(a.tenant_id)
    .bind(p.staff_id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    if p.active {
        eligible(&mut tx, &a, p.staff_id).await?;
    }
    let q = if v.is_none() {
        "INSERT INTO practice_providers(tenant_id,id,display_name,npi,specialty,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING to_jsonb(practice_providers)-'tenant_id'"
    } else {
        "UPDATE practice_providers SET display_name=$3,npi=$4,specialty=$5,active=$6,version=version+1 WHERE tenant_id=$1 AND id=$2 AND version=$7 RETURNING to_jsonb(practice_providers)-'tenant_id'"
    };
    let mut query = sqlx::query_scalar::<_, Value>(q)
        .bind(a.tenant_id)
        .bind(p.staff_id)
        .bind(p.display_name.trim())
        .bind(p.npi)
        .bind(p.specialty.trim())
        .bind(p.active);
    if let Some(v) = v {
        query = query.bind(v)
    }
    let item = query
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::Conflict(
            "provider changed or was not found; reload before saving",
        ))?;
    record(
        &mut tx,
        &a,
        "provider",
        p.staff_id,
        item["version"].as_i64().unwrap_or(1),
        &p.reason,
        &item,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(item))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Facility {
    name: String,
    address: String,
    phone: String,
    active: bool,
    reason: String,
}
async fn create_facility(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(p): Json<Facility>,
) -> Result<Json<Value>> {
    save_facility(s, h, None, p).await
}
async fn update_facility(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(p): Json<Facility>,
) -> Result<Json<Value>> {
    save_facility(s, h, Some(id), p).await
}
async fn save_facility(
    s: State,
    h: HeaderMap,
    id: Option<Uuid>,
    p: Facility,
) -> Result<Json<Value>> {
    let a = owner(&s, &h, true).await?;
    reason(&p.reason)?;
    if !text(&p.name, 1, 200) || !text(&p.address, 0, 1000) || !text(&p.phone, 0, 40) {
        return Err(Error::Invalid(
            "valid facility name, address and phone are required",
        ));
    }
    let v = if id.is_some() {
        Some(version(&h)?)
    } else {
        None
    };
    let id = id.unwrap_or_else(Uuid::new_v4);
    let mut tx = locked(&s, &a).await?;
    if v.is_some() {
        let old: Option<String> =
            sqlx::query_scalar("SELECT name FROM practice_facilities WHERE tenant_id=$1 AND id=$2")
                .bind(a.tenant_id)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(name) = old.filter(|name| name != p.name.trim()) {
            let booked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM appointments WHERE tenant_id=$1 AND facility=$2 AND ends_at>now() AND status NOT IN ('cancelled','no_show'))").bind(a.tenant_id).bind(name).fetch_one(&mut *tx).await?;
            if booked {
                return Err(Error::Conflict(
                    "reschedule future appointments before renaming their facility",
                ));
            }
        }
    }
    if !p.active {
        let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM practice_rooms WHERE tenant_id=$1 AND facility_id=$2 AND active)").bind(a.tenant_id).bind(id).fetch_one(&mut *tx).await?;
        if active {
            return Err(Error::Conflict(
                "disable active rooms before disabling this facility",
            ));
        }
    }
    let q = if v.is_none() {
        "INSERT INTO practice_facilities(tenant_id,id,name,address,phone,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING to_jsonb(practice_facilities)-'tenant_id'"
    } else {
        "UPDATE practice_facilities SET name=$3,address=$4,phone=$5,active=$6,version=version+1 WHERE tenant_id=$1 AND id=$2 AND version=$7 RETURNING to_jsonb(practice_facilities)-'tenant_id'"
    };
    let mut query = sqlx::query_scalar::<_, Value>(q)
        .bind(a.tenant_id)
        .bind(id)
        .bind(p.name.trim())
        .bind(p.address.trim())
        .bind(p.phone.trim())
        .bind(p.active);
    if let Some(v) = v {
        query = query.bind(v)
    }
    let item = query
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::Conflict(
            "facility changed or was not found; reload before saving",
        ))?;
    record(
        &mut tx,
        &a,
        "facility",
        id,
        item["version"].as_i64().unwrap_or(1),
        &p.reason,
        &item,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(item))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Room {
    facility_id: Uuid,
    name: String,
    active: bool,
    reason: String,
}
async fn create_room(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(p): Json<Room>,
) -> Result<Json<Value>> {
    save_room(s, h, None, p).await
}
async fn update_room(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(p): Json<Room>,
) -> Result<Json<Value>> {
    save_room(s, h, Some(id), p).await
}
async fn save_room(s: State, h: HeaderMap, id: Option<Uuid>, p: Room) -> Result<Json<Value>> {
    let a = owner(&s, &h, true).await?;
    reason(&p.reason)?;
    if !text(&p.name, 1, 100) {
        return Err(Error::Invalid("a room name is required"));
    }
    let v = if id.is_some() {
        Some(version(&h)?)
    } else {
        None
    };
    let id = id.unwrap_or_else(Uuid::new_v4);
    let mut tx = locked(&s, &a).await?;
    if v.is_some() {
        let old: Option<(Uuid,String,String)> = sqlx::query_as("SELECT r.facility_id,r.name,f.name FROM practice_rooms r JOIN practice_facilities f ON f.tenant_id=r.tenant_id AND f.id=r.facility_id WHERE r.tenant_id=$1 AND r.id=$2").bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
        if let Some((_, name, facility_name)) = old
            .filter(|(facility_id, name, _)| *facility_id != p.facility_id || name != p.name.trim())
        {
            let booked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM appointments WHERE tenant_id=$1 AND facility=$2 AND room=$3 AND ends_at>now() AND status NOT IN ('cancelled','no_show'))").bind(a.tenant_id).bind(facility_name).bind(name).fetch_one(&mut *tx).await?;
            if booked {
                return Err(Error::Conflict(
                    "reschedule future appointments before renaming or moving their room",
                ));
            }
        }
    }
    let facility: Option<bool> =
        sqlx::query_scalar("SELECT active FROM practice_facilities WHERE tenant_id=$1 AND id=$2")
            .bind(a.tenant_id)
            .bind(p.facility_id)
            .fetch_optional(&mut *tx)
            .await?;
    if facility.is_none() || (p.active && facility != Some(true)) {
        return Err(Error::Invalid(
            "an active facility is required for an active room",
        ));
    }
    let q = if v.is_none() {
        "INSERT INTO practice_rooms(tenant_id,id,facility_id,name,active) VALUES($1,$2,$3,$4,$5) RETURNING to_jsonb(practice_rooms)-'tenant_id'"
    } else {
        "UPDATE practice_rooms SET facility_id=$3,name=$4,active=$5,version=version+1 WHERE tenant_id=$1 AND id=$2 AND version=$6 RETURNING to_jsonb(practice_rooms)-'tenant_id'"
    };
    let mut query = sqlx::query_scalar::<_, Value>(q)
        .bind(a.tenant_id)
        .bind(id)
        .bind(p.facility_id)
        .bind(p.name.trim())
        .bind(p.active);
    if let Some(v) = v {
        query = query.bind(v)
    }
    let item = query
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::Conflict(
            "room changed or was not found; reload before saving",
        ))?;
    record(
        &mut tx,
        &a,
        "room",
        id,
        item["version"].as_i64().unwrap_or(1),
        &p.reason,
        &item,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(item))
}
async fn history(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Path((kind, id)): Path<(String, Uuid)>,
) -> Result<Json<Value>> {
    let a = owner(&s, &h, false).await?;
    if !matches!(kind.as_str(), "staff" | "provider" | "facility" | "room") {
        return Err(Error::NotFound);
    }
    let mut tx = locked(&s, &a).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(h)-'tenant_id' FROM practice_admin_history h WHERE tenant_id=$1 AND kind=$2 AND resource_id=$3 ORDER BY version DESC LIMIT 101").bind(a.tenant_id).bind(kind).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "practice.admin.history", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"has_more":items.len()>100,"items":items.into_iter().take(100).collect::<Vec<_>>()}),
    ))
}
/// Active directory choices for scheduling staff. Legacy appointment location
/// strings remain independent snapshots; editing a directory never rewrites them.
async fn schedule_locations(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = s
        .browser
        .as_ref()
        .ok_or(Error::NotFound)?
        .db
        .begin()
        .await?;
    let facilities: Vec<(Uuid,String)> = sqlx::query_as("SELECT id,name FROM practice_facilities WHERE tenant_id=$1 AND active ORDER BY lower(name),id LIMIT 1001").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    let rooms: Vec<(Uuid,Uuid,String)> = sqlx::query_as("SELECT r.id,r.facility_id,r.name FROM practice_rooms r JOIN practice_facilities f ON f.tenant_id=r.tenant_id AND f.id=r.facility_id WHERE r.tenant_id=$1 AND r.active AND f.active ORDER BY r.facility_id,lower(r.name),r.id LIMIT 10001").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    let has_more = facilities.len() > 1000 || rooms.len() > 10000;
    let items: Vec<Value> = facilities.into_iter().take(1000).map(|(id,name)| json!({"id":id,"name":name,"rooms":rooms.iter().take(10000).filter(|(_,facility,_)|*facility==id).map(|(id,_,name)|json!({"id":id,"name":name})).collect::<Vec<_>>()})).collect();
    crate::postgres::audit(&mut tx, &a, "practice.locations.read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"has_more":has_more})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn npi_checksum() {
        assert!(valid_npi("1234567893"));
        assert!(!valid_npi("1234567890"));
        assert!(!valid_npi("1234"));
    }
    #[test]
    fn roles_bounded() {
        assert!(role("nurse"));
        assert!(role("medical_assistant"));
        assert!(!role("patient"));
    }
}
