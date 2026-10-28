// SPDX-License-Identifier: AGPL-3.0-only
//! Enrollment preparation only. Candidate profiles never confer vendor or EPCS authority.
//! No provider protocol is implemented without its current approved contract.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    postgres::audit,
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::HeaderMap,
    routing::{get, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
const CAPABILITIES: &[&str] = &[
    "non_controlled",
    "epcs",
    "renewals",
    "cancel",
    "rx_change",
    "medication_history",
    "formulary",
    "prior_authorization",
];
const PROFILES: &[&str] = &[
    "none",
    "photon",
    "weno_ez",
    "weno_online",
    "dosespot_full",
    "other",
];
/// Internal boundary for a future approved adapter. No implementation is registered.
/// A launch is never evidence of signing, transmission, delivery or dispensing.
#[async_trait::async_trait]
pub trait EnrolledErxAdapter: Send + Sync {
    fn profile(&self) -> &'static str;
    fn approved_contract_revision(&self) -> &str;
    async fn launch_hosted_workflow(&self, request: ApprovedLaunch) -> Result<HostedLaunch>;
}
pub struct ApprovedLaunch {
    pub tenant_id: Uuid,
    pub patient_id: Uuid,
    pub prescriber_id: Uuid,
    pub correlation_id: Uuid,
    pub immutable_context: Value,
}
/// Intentionally not serializable/debuggable: a vendor URL may be a bearer credential.
pub struct HostedLaunch {
    pub url: String,
    pub vendor_request_id: String,
}
#[derive(Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields)]
struct Credentials {
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    encryption_key: String,
}
impl Credentials {
    fn validate(&self) -> Result<()> {
        for v in [
            &self.username,
            &self.password,
            &self.api_key,
            &self.encryption_key,
        ] {
            if v.len() > 8192 || v.chars().any(char::is_control) {
                return Err(Error::Invalid(
                    "vendor credential is too long or contains control characters",
                ));
            }
        }
        if [
            &self.username,
            &self.password,
            &self.api_key,
            &self.encryption_key,
        ]
        .iter()
        .all(|v| v.is_empty())
        {
            return Err(Error::Invalid(
                "provide a credential or leave the credential block absent to retain stored values",
            ));
        }
        Ok(())
    }
}
#[derive(sqlx::FromRow)]
struct Connection {
    tenant_id: Uuid,
    id: Uuid,
    version: i64,
    candidate_profile: String,
    profile_revision: i64,
    enrollment_stage: String,
    organization_reference: String,
    requested_capabilities: Value,
    encrypted_credentials: Option<Vec<u8>>,
}
#[derive(sqlx::FromRow)]
struct Prescriber {
    user_id: Uuid,
    version: i64,
    connection_id: Uuid,
    profile_revision: i64,
    facility_id: Option<Uuid>,
    vendor_user_id: String,
    vendor_username: String,
    vendor_location_id: String,
    enrollment_reported: bool,
    encrypted_credentials: Option<Vec<u8>>,
}
fn pool(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::Unauthorized)?.db)
}
async fn actor(s: &State, h: &HeaderMap, write: bool) -> Result<Actor> {
    let a = s
        .browser
        .as_ref()
        .ok_or(Error::Unauthorized)?
        .authenticate(h, write)
        .await?;
    a.rooming()?;
    Ok(a)
}
fn text(v: &str, max: usize, required: bool) -> Result<()> {
    if (required && v.trim().is_empty())
        || v.chars().count() > max
        || v.chars().any(char::is_control)
    {
        Err(Error::Invalid(
            "eRx setup text is missing, too long or contains control characters",
        ))
    } else {
        Ok(())
    }
}
async fn locked<'a>(s: &'a State, a: &Actor) -> Result<Transaction<'a, Postgres>> {
    let mut tx = pool(s)?.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,320032))")
        .bind(a.tenant_id.to_string())
        .execute(&mut *tx)
        .await?;
    crate::scheduling::tenant_lock(&mut tx, a).await?;
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM browser_users WHERE tenant_id=$1 AND id=$2 AND NOT disabled FOR SHARE",
    )
    .bind(a.tenant_id)
    .bind(a.sub)
    .fetch_optional(&mut *tx)
    .await?;
    if !role.as_deref().is_some_and(|r| {
        matches!(
            (&a.role, r),
            (Role::Owner, "owner") | (Role::Clinician, "clinician")
        )
    }) {
        return Err(Error::Forbidden);
    }
    Ok(tx)
}
async fn connection(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
) -> Result<Option<Connection>> {
    Ok(sqlx::query_as("SELECT tenant_id,id,version,candidate_profile,profile_revision,enrollment_stage,organization_reference,requested_capabilities,encrypted_credentials FROM erx_connections WHERE tenant_id=$1").bind(tenant).fetch_optional(&mut **tx).await?)
}
async fn prescriber(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    user: Uuid,
) -> Result<Option<Prescriber>> {
    Ok(sqlx::query_as("SELECT user_id,version,connection_id,profile_revision,facility_id,vendor_user_id,vendor_username,vendor_location_id,enrollment_reported,encrypted_credentials FROM erx_prescribers WHERE tenant_id=$1 AND user_id=$2").bind(tenant).bind(user).fetch_optional(&mut **tx).await?)
}
fn credential_fields(tenant: Uuid, id: Uuid, purpose: &str, enc: Option<&Vec<u8>>) -> Value {
    match enc {
        None => json!({"stored":false,"readable":true}),
        Some(enc) => {
            match crate::provider_settings::open_secret(tenant, id, purpose, enc).and_then(|s| {
                serde_json::from_str::<Credentials>(s.expose())
                    .map_err(|_| Error::Invalid("saved credential cannot be decoded"))
            }) {
                Ok(c) => {
                    json!({"stored":true,"readable":true,"username":!c.username.is_empty(),"password":!c.password.is_empty(),"api_key":!c.api_key.is_empty(),"encryption_key":!c.encryption_key.is_empty()})
                }
                Err(_) => json!({"stored":true,"readable":false}),
            }
        }
    }
}
fn connection_public(c: &Connection) -> Value {
    json!({"id":c.id,"version":c.version,"candidate_profile":c.candidate_profile,"profile_revision":c.profile_revision,"enrollment_stage":c.enrollment_stage,"organization_reference":c.organization_reference,"requested_capabilities":c.requested_capabilities,"credentials":credential_fields(c.tenant_id,c.id,"erx-connection",c.encrypted_credentials.as_ref()),"active":false,"vendor_verified":false})
}
fn prescriber_public(tenant: Uuid, p: &Prescriber, current_revision: i64) -> Value {
    json!({"user_id":p.user_id,"version":p.version,"connection_id":p.connection_id,"profile_revision":p.profile_revision,"profile_current":p.profile_revision==current_revision,"facility_id":p.facility_id,"vendor_user_id":p.vendor_user_id,"vendor_username":p.vendor_username,"vendor_location_id":p.vendor_location_id,"enrollment_reported":p.enrollment_reported,"credentials":credential_fields(tenant,p.user_id,"erx-prescriber",p.encrypted_credentials.as_ref()),"vendor_verified":false})
}
fn candidate_profiles() -> Value {
    json!([
        {"id":"none","name":"No provider selected","workflow":"not_selected","documentation_url":null},
        {"id":"photon","name":"Photon — candidate","workflow":"documented_sandbox_and_embedded_prescribing","documentation_url":"https://docs.photon.health/docs/integration-guide","note":"Public integration guides describe sandbox and embedded workflows. No account or vendor connection is configured here; enrollment and integration approval remain required."},
    {"id":"weno_ez","name":"Weno EZ — candidate","workflow":"vendor_hosted_composition","documentation_url":"https://wenoexchange.com/wp-content/uploads/2025/08/EZ_Integration_Overview.pdf","note":"Composition, signing and sending occur on vendor screens. Current API guide requires an enrolled developer account. This is not transmission of native drafts."},
        {"id":"weno_online","name":"Weno Online API — candidate","workflow":"native_order_with_vendor_signing","documentation_url":"https://wenoexchange.com/wp-content/uploads/2025/07/WOL_API_Overview-07-21-2025.pdf","note":"Separate partner onboarding, approved message schema, drug and pharmacy data, verified receipt endpoint and certification are required."},
        {"id":"dosespot_full","name":"DoseSpot Full — candidate","workflow":"contracted_native_integration","documentation_url":"https://dosespot.com/full-integration/","note":"Partner agreement, technical access and integration review are required."},
        {"id":"other","name":"Another provider — evaluation only","workflow":"contract_required","documentation_url":null}
       ])
}
async fn readiness(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    c: Option<&Connection>,
    p: Option<&Prescriber>,
) -> Result<Value> {
    let mut missing = vec![
        "no_active_vendor_adapter",
        "vendor_enrollment_not_verified",
        "current_api_contract_required",
        "vendor_acceptance_test_required",
    ];
    if c.is_none_or(|c| c.candidate_profile == "none") {
        missing.push("provider_not_selected");
    }
    let profile:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM practice_providers p JOIN browser_users u ON u.tenant_id=p.tenant_id AND u.id=p.id WHERE p.tenant_id=$1 AND p.id=$2 AND p.active AND p.npi<>'' AND NOT u.disabled AND u.role IN('owner','clinician'))").bind(a.tenant_id).bind(a.sub).fetch_one(&mut **tx).await?;
    if !profile {
        missing.push("active_local_prescriber_profile_required");
    }
    match (c, p) {
        (Some(c), Some(p)) => {
            if p.profile_revision != c.profile_revision || p.connection_id != c.id {
                missing.push("prescriber_candidate_mapping_stale");
            }
            if !p.enrollment_reported {
                missing.push("prescriber_enrollment_not_reported");
            }
            if p.vendor_user_id.is_empty()
                || p.vendor_location_id.is_empty()
                || p.facility_id.is_none()
            {
                missing.push("prescriber_and_location_mapping_incomplete");
            }
            if let Some(f) = p.facility_id {
                let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM practice_facilities WHERE tenant_id=$1 AND id=$2 AND active)").bind(a.tenant_id).bind(f).fetch_one(&mut **tx).await?;
                if !active {
                    missing.push("mapped_facility_inactive");
                }
            }
            if credential_fields(
                a.tenant_id,
                p.user_id,
                "erx-prescriber",
                p.encrypted_credentials.as_ref(),
            )["readable"]
                != true
            {
                missing.push("credential_key_unavailable");
            }
        }
        _ => missing.push("prescriber_mapping_required"),
    }
    if c.is_some_and(|c| {
        credential_fields(
            a.tenant_id,
            c.id,
            "erx-connection",
            c.encrypted_credentials.as_ref(),
        )["readable"]
            != true
    }) {
        missing.push("credential_key_unavailable");
    }
    missing.sort_unstable();
    missing.dedup();
    Ok(
        json!({"state":"not_enrolled","ready":false,"active_provider":null,"launch_available":false,"transmission_available":false,"epcs_available":false,"receipt_sync_available":false,"vendor_contacted":false,"missing":missing,"message":"Enrollment preparation only. Saving candidate settings or credentials does not connect a provider. Local prescription authorization is not an electronic transmission."}),
    )
}
async fn replay(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    request: Uuid,
    op: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let old:Option<(Uuid,String,Vec<u8>,Value)>=sqlx::query_as("SELECT actor_id,operation,encrypted_request,public_response FROM erx_setup_requests WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(request).fetch_optional(&mut **tx).await?;
    let Some((by, operation, encrypted, out)) = old else {
        return Ok(None);
    };
    if by != a.sub || operation != op {
        return Err(Error::Conflict(
            "request identity already used by another eRx operation",
        ));
    }
    let secret =
        crate::provider_settings::open_secret(a.tenant_id, request, "erx-request", &encrypted)?;
    let saved: Value = serde_json::from_str(secret.expose())
        .map_err(|_| Error::Invalid("saved eRx request cannot be decoded"))?;
    if saved != *input {
        return Err(Error::Conflict(
            "request identity reused with different eRx settings",
        ));
    }
    Ok(Some(out))
}
async fn remember(
    tx: &mut Transaction<'_, Postgres>,
    s: &State,
    a: &Actor,
    request: Uuid,
    op: &str,
    input: &Value,
    out: &Value,
) -> Result<()> {
    let encrypted = crate::provider_settings::seal_secret(
        pool(s)?,
        a.tenant_id,
        request,
        "erx-request",
        &input.to_string(),
    )
    .await?;
    sqlx::query("INSERT INTO erx_setup_requests(tenant_id,request_id,actor_id,operation,encrypted_request,public_response) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(request).bind(a.sub).bind(op).bind(encrypted).bind(out).execute(&mut **tx).await?;
    Ok(())
}
#[allow(clippy::too_many_arguments)]
async fn record(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    kind: &str,
    v: i64,
    reason: &str,
    out: &Value,
    encrypted: Option<&Vec<u8>>,
) -> Result<()> {
    sqlx::query("INSERT INTO erx_setup_history(tenant_id,id,resource_id,kind,version,actor_id,reason,public_snapshot,encrypted_credentials) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(a.tenant_id).bind(Uuid::new_v4()).bind(id).bind(kind).bind(v).bind(a.sub).bind(reason.trim()).bind(out).bind(encrypted).execute(&mut **tx).await?;
    audit(tx, a, &format!("prescribing.erx.{kind}_saved"), id).await
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Setup {
    request_id: Uuid,
    version: i64,
    candidate_profile: String,
    enrollment_stage: String,
    organization_reference: String,
    requested_capabilities: Vec<String>,
    credentials: Option<Credentials>,
    #[serde(default)]
    clear_credentials: bool,
    reason: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrescriberSetup {
    request_id: Uuid,
    version: i64,
    facility_id: Option<Uuid>,
    vendor_user_id: String,
    vendor_username: String,
    vendor_location_id: String,
    enrollment_reported: bool,
    credentials: Option<Credentials>,
    #[serde(default)]
    clear_credentials: bool,
    reason: String,
}
async fn credential_update(
    s: &State,
    tenant: Uuid,
    id: Uuid,
    purpose: &str,
    value: Option<&Credentials>,
    clear: bool,
    old: Option<&Vec<u8>>,
) -> Result<Option<Vec<u8>>> {
    if clear && value.is_some() {
        return Err(Error::Invalid(
            "choose credential replacement or clearing, not both",
        ));
    }
    if let Some(v) = value {
        v.validate()?;
        Ok(Some(
            crate::provider_settings::seal_secret(
                pool(s)?,
                tenant,
                id,
                purpose,
                &serde_json::to_string(v)
                    .map_err(|_| Error::Invalid("credential encoding failed"))?,
            )
            .await?,
        ))
    } else if clear {
        Ok(None)
    } else {
        if let Some(enc) = old {
            crate::provider_settings::open_secret(tenant, id, purpose, enc)?;
        }
        Ok(old.cloned())
    }
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/prescribing/erx", get(status))
        .route("/api/v1/prescribing/erx/connection", put(save_connection))
        .route(
            "/api/v1/prescribing/erx/prescribers/{user}",
            put(save_prescriber),
        )
        .route(
            "/api/v1/patients/{patient}/prescribing/erx/attempts",
            get(attempts).post(check_readiness),
        )
}
async fn status(ExtractState(s): ExtractState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let a = actor(&s, &h, false).await?;
    let storage_ready = crate::provider_settings::credential_storage_ready(pool(&s)?).await?;
    let mut tx = pool(&s)?.begin().await?;
    let c = connection(&mut tx, a.tenant_id).await?;
    let own = prescriber(&mut tx, a.tenant_id, a.sub).await?;
    let r = readiness(&mut tx, &a, c.as_ref(), own.as_ref()).await?;
    let providers:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',p.id,'display_name',p.display_name,'npi',p.npi,'active',p.active) FROM practice_providers p JOIN browser_users u ON u.tenant_id=p.tenant_id AND u.id=p.id WHERE p.tenant_id=$1 AND ($2 OR p.id=$3) AND u.role IN('owner','clinician') ORDER BY p.display_name,p.id LIMIT 201").bind(a.tenant_id).bind(matches!(a.role,Role::Owner)).bind(a.sub).fetch_all(&mut *tx).await?;
    let facilities:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name,'active',active) FROM practice_facilities WHERE tenant_id=$1 ORDER BY name,id LIMIT 201").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    let users: Vec<Uuid> = providers
        .iter()
        .filter_map(|p| p["id"].as_str().and_then(|s| Uuid::parse_str(s).ok()))
        .collect();
    let stored:Vec<Prescriber>=sqlx::query_as("SELECT user_id,version,connection_id,profile_revision,facility_id,vendor_user_id,vendor_username,vendor_location_id,enrollment_reported,encrypted_credentials FROM erx_prescribers WHERE tenant_id=$1 AND user_id=ANY($2) ORDER BY user_id").bind(a.tenant_id).bind(users).fetch_all(&mut *tx).await?;
    let mappings: Vec<Value> = stored
        .iter()
        .map(|p| prescriber_public(a.tenant_id, p, c.as_ref().map_or(0, |c| c.profile_revision)))
        .collect();
    audit(&mut tx, &a, "prescribing.erx.setup_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"connection":c.as_ref().map(connection_public).unwrap_or(json!({"version":0,"candidate_profile":"none","profile_revision":0,"enrollment_stage":"not_started","organization_reference":"","requested_capabilities":[],"credentials":{"stored":false,"readable":true},"active":false,"vendor_verified":false})),"readiness":r,"credential_storage_ready":storage_ready,"profiles":candidate_profiles(),"prescribers":providers.iter().take(200).collect::<Vec<_>>(),"prescribers_truncated":providers.len()>200,"facilities":facilities.iter().take(200).collect::<Vec<_>>(),"facilities_truncated":facilities.len()>200,"mappings":mappings}),
    ))
}
async fn save_connection(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Json(v): Json<Setup>,
) -> Result<Json<Value>> {
    let a = actor(&s, &h, true).await?;
    if !matches!(a.role, Role::Owner) {
        return Err(Error::Forbidden);
    }
    text(&v.reason, 1000, true)?;
    text(&v.organization_reference, 200, false)?;
    if !PROFILES.contains(&v.candidate_profile.as_str())
        || ![
            "not_started",
            "contact_planned",
            "awaiting_vendor",
            "agreement_in_progress",
            "test_access_reported",
        ]
        .contains(&v.enrollment_stage.as_str())
        || v.requested_capabilities.len() > 8
        || v.requested_capabilities
            .iter()
            .any(|x| !CAPABILITIES.contains(&x.as_str()))
    {
        return Err(Error::Invalid(
            "unsupported eRx candidate, enrollment stage or requested capability",
        ));
    }
    let input = json!(v);
    let mut tx = locked(&s, &a).await?;
    if let Some(out) = replay(&mut tx, &a, v.request_id, "connection", &input).await? {
        tx.commit().await?;
        return Ok(Json(out));
    }
    let old = connection(&mut tx, a.tenant_id).await?;
    if old.as_ref().map_or(0, |c| c.version) != v.version {
        return Err(Error::Conflict(
            "eRx enrollment settings changed; compare before saving",
        ));
    }
    if v.candidate_profile == "none" && v.credentials.is_some() {
        return Err(Error::Invalid(
            "record a candidate profile before storing its vendor credentials",
        ));
    }
    let changed = old
        .as_ref()
        .is_some_and(|c| c.candidate_profile != v.candidate_profile);
    if changed
        && old
            .as_ref()
            .is_some_and(|c| c.encrypted_credentials.is_some())
        && !v.clear_credentials
        && v.credentials.is_none()
    {
        return Err(Error::Conflict(
            "changing candidates requires explicit credential clearing or replacement",
        ));
    }
    let id = old.as_ref().map_or_else(Uuid::new_v4, |c| c.id);
    let enc = credential_update(
        &s,
        a.tenant_id,
        id,
        "erx-connection",
        v.credentials.as_ref(),
        v.clear_credentials,
        old.as_ref().and_then(|c| c.encrypted_credentials.as_ref()),
    )
    .await?;
    sqlx::query("INSERT INTO erx_connections(tenant_id,id,candidate_profile,enrollment_stage,organization_reference,requested_capabilities,encrypted_credentials,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id) DO UPDATE SET candidate_profile=$3,enrollment_stage=$4,organization_reference=$5,requested_capabilities=$6,encrypted_credentials=$7,updated_by=$8,updated_at=clock_timestamp(),version=erx_connections.version+1,profile_revision=erx_connections.profile_revision+CASE WHEN erx_connections.candidate_profile<>$3 THEN 1 ELSE 0 END").bind(a.tenant_id).bind(id).bind(&v.candidate_profile).bind(&v.enrollment_stage).bind(v.organization_reference.trim()).bind(json!(v.requested_capabilities)).bind(&enc).bind(a.sub).execute(&mut *tx).await?;
    let c = connection(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::NotFound)?;
    let out = connection_public(&c);
    record(
        &mut tx,
        &a,
        id,
        "connection",
        c.version,
        &v.reason,
        &out,
        enc.as_ref(),
    )
    .await?;
    remember(&mut tx, &s, &a, v.request_id, "connection", &input, &out).await?;
    tx.commit().await?;
    Ok(Json(out))
}
async fn save_prescriber(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Path(user): Path<Uuid>,
    Json(v): Json<PrescriberSetup>,
) -> Result<Json<Value>> {
    let a = actor(&s, &h, true).await?;
    if !matches!(a.role, Role::Owner) && a.sub != user {
        return Err(Error::Forbidden);
    }
    text(&v.reason, 1000, true)?;
    for s in [&v.vendor_user_id, &v.vendor_username, &v.vendor_location_id] {
        text(s, 200, false)?;
    }
    let input = json!({"user":user,"body":v});
    let mut tx = locked(&s, &a).await?;
    if let Some(out) = replay(&mut tx, &a, v.request_id, "prescriber", &input).await? {
        tx.commit().await?;
        return Ok(Json(out));
    }
    let c = connection(&mut tx, a.tenant_id)
        .await?
        .ok_or(Error::Conflict("save candidate enrollment settings first"))?;
    if c.candidate_profile == "none" {
        return Err(Error::Conflict(
            "choose an evaluation candidate before recording a prescriber mapping",
        ));
    }
    let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM practice_providers p JOIN browser_users u ON u.tenant_id=p.tenant_id AND u.id=p.id WHERE p.tenant_id=$1 AND p.id=$2 AND u.role IN('owner','clinician') AND NOT u.disabled)").bind(a.tenant_id).bind(user).fetch_one(&mut *tx).await?;
    if !allowed {
        return Err(Error::NotFound);
    }
    if let Some(f) = v.facility_id {
        let found: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM practice_facilities WHERE tenant_id=$1 AND id=$2)",
        )
        .bind(a.tenant_id)
        .bind(f)
        .fetch_one(&mut *tx)
        .await?;
        if !found {
            return Err(Error::NotFound);
        }
    }
    let old = prescriber(&mut tx, a.tenant_id, user).await?;
    if old.as_ref().map_or(0, |p| p.version) != v.version {
        return Err(Error::Conflict(
            "prescriber setup changed; compare the saved mapping",
        ));
    }
    if old.as_ref().is_some_and(|p| {
        p.profile_revision != c.profile_revision && p.encrypted_credentials.is_some()
    }) && !v.clear_credentials
        && v.credentials.is_none()
    {
        return Err(Error::Conflict(
            "candidate changed; explicitly clear or replace old prescriber credentials",
        ));
    }
    let enc = credential_update(
        &s,
        a.tenant_id,
        user,
        "erx-prescriber",
        v.credentials.as_ref(),
        v.clear_credentials,
        old.as_ref().and_then(|p| p.encrypted_credentials.as_ref()),
    )
    .await?;
    sqlx::query("INSERT INTO erx_prescribers(tenant_id,user_id,connection_id,profile_revision,facility_id,vendor_user_id,vendor_username,vendor_location_id,enrollment_reported,encrypted_credentials,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,user_id) DO UPDATE SET profile_revision=$4,facility_id=$5,vendor_user_id=$6,vendor_username=$7,vendor_location_id=$8,enrollment_reported=$9,encrypted_credentials=$10,updated_by=$11,updated_at=clock_timestamp(),version=erx_prescribers.version+1").bind(a.tenant_id).bind(user).bind(c.id).bind(c.profile_revision).bind(v.facility_id).bind(v.vendor_user_id.trim()).bind(v.vendor_username.trim()).bind(v.vendor_location_id.trim()).bind(v.enrollment_reported).bind(&enc).bind(a.sub).execute(&mut *tx).await?;
    let p = prescriber(&mut tx, a.tenant_id, user)
        .await?
        .ok_or(Error::NotFound)?;
    let out = prescriber_public(a.tenant_id, &p, c.profile_revision);
    record(
        &mut tx,
        &a,
        user,
        "prescriber",
        p.version,
        &v.reason,
        &out,
        enc.as_ref(),
    )
    .await?;
    remember(&mut tx, &s, &a, v.request_id, "prescriber", &input, &out).await?;
    tx.commit().await?;
    Ok(Json(out))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadinessCheck {
    request_id: Uuid,
    connection_version: i64,
    native_prescription_id: Option<Uuid>,
    reason: String,
}
async fn check_readiness(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Path(patient): Path<Uuid>,
    Json(v): Json<ReadinessCheck>,
) -> Result<Json<Value>> {
    let a = actor(&s, &h, true).await?;
    a.clinical()?;
    text(&v.reason, 1000, true)?;
    let input = json!({"patient":patient,"body":v});
    let mut tx = locked(&s, &a).await?;
    let found: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(patient)
            .fetch_one(&mut *tx)
            .await?;
    if !found {
        return Err(Error::NotFound);
    }
    if let Some(out) = replay(&mut tx, &a, v.request_id, "readiness", &input).await? {
        tx.commit().await?;
        return Ok(Json(out));
    }
    if let Some(id) = v.native_prescription_id {
        let found:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM native_prescriptions WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)").bind(a.tenant_id).bind(patient).bind(id).fetch_one(&mut *tx).await?;
        if !found {
            return Err(Error::NotFound);
        }
    }
    let c = connection(&mut tx, a.tenant_id).await?;
    if c.as_ref().map_or(0, |c| c.version) != v.connection_version {
        return Err(Error::Conflict(
            "candidate setup changed; reload before checking readiness",
        ));
    }
    let p = prescriber(&mut tx, a.tenant_id, a.sub).await?;
    let r = readiness(&mut tx, &a, c.as_ref(), p.as_ref()).await?;
    let id = Uuid::new_v4();
    let out:Value=sqlx::query_scalar("INSERT INTO erx_readiness_attempts(tenant_id,id,patient_id,actor_id,request_id,candidate_profile,connection_version,prescriber_version,native_prescription_id,missing) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING to_jsonb(erx_readiness_attempts)-'tenant_id'-'request_id'").bind(a.tenant_id).bind(id).bind(patient).bind(a.sub).bind(v.request_id).bind(c.as_ref().map_or("none",|c|c.candidate_profile.as_str())).bind(v.connection_version).bind(p.as_ref().map(|p|p.version)).bind(v.native_prescription_id).bind(&r["missing"]).fetch_one(&mut *tx).await?;
    audit(&mut tx, &a, "prescribing.erx.readiness_blocked", id).await?;
    remember(&mut tx, &s, &a, v.request_id, "readiness", &input, &out).await?;
    tx.commit().await?;
    Ok(Json(out))
}
async fn attempts(
    ExtractState(s): ExtractState<State>,
    h: HeaderMap,
    Path(patient): Path<Uuid>,
) -> Result<Json<Value>> {
    let a = actor(&s, &h, false).await?;
    let mut tx = pool(&s)?.begin().await?;
    let found: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(patient)
            .fetch_one(&mut *tx)
            .await?;
    if !found {
        return Err(Error::NotFound);
    }
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(a)-'tenant_id'-'request_id' FROM erx_readiness_attempts a WHERE tenant_id=$1 AND patient_id=$2 ORDER BY created_at DESC,id LIMIT 101").bind(a.tenant_id).bind(patient).fetch_all(&mut *tx).await?;
    let truncated = items.len() > 100;
    items.truncate(100);
    audit(&mut tx, &a, "prescribing.erx.attempts_read", patient).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"truncated":truncated})))
}
