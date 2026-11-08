// SPDX-License-Identifier: AGPL-3.0-only
//! Tenant custom-role restrictions, intersected with every native authorization check.
//! The route middleware also covers handlers which authenticate browser sessions directly.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    State,
};
use axum::{
    extract::{FromRequestParts, MatchedPath, Path, Request, State as ExtractState},
    http::{header, HeaderMap, Method},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::{
    collections::{BTreeMap, HashSet},
    sync::OnceLock,
};
use uuid::Uuid;

const RESOURCES: &[(&str, &str, &[&str])] = &[
    (
        "clinical",
        "Patients & encounters",
        &["clinical", "labs", "referrals", "followup", "specialty"],
    ),
    ("scheduling", "Schedule & pre-visit", &["schedule"]),
    ("billing", "Patient billing", &["billing"]),
    ("claims", "Claims & remittances", &["claims", "edi"]),
    (
        "communications",
        "Messages & communication drafts",
        &["portal", "communications"],
    ),
    (
        "workflows",
        "Workflow definitions & runs",
        &["workflows", "automation"],
    ),
    ("ai", "Sun & reviewed AI drafts", &["ai_review"]),
    ("integrations", "Integrations & Connect", &["apps"]),
    ("practice", "Practice configuration", &["practice", "admin"]),
    ("terminology", "Terminology catalog", &[]),
    ("migration", "Data import", &["migration"]),
    ("events", "Live update notices", &[]),
];
const BASE_ROLES: &[&str] = &[
    "clinician",
    "nurse",
    "medical_assistant",
    "front_desk",
    "read_only",
];
#[derive(Clone, Copy, Default, Deserialize, Serialize, Debug)]
#[serde(default, deny_unknown_fields)]
pub struct Permissions {
    pub view: bool,
    pub create: bool,
    pub edit: bool,
    pub delete: bool,
}
impl Permissions {
    fn all() -> Self {
        Self {
            view: true,
            create: true,
            edit: true,
            delete: true,
        }
    }
    fn intersect(self, other: Self) -> Self {
        Self {
            view: self.view && other.view,
            create: self.create && other.create,
            edit: self.edit && other.edit,
            delete: self.delete && other.delete,
        }
    }
    fn permits(self, action: Action) -> bool {
        self.view
            && match action {
                Action::View => true,
                Action::Create => self.create,
                Action::Edit => self.edit,
                Action::Delete => self.delete,
                Action::Compound => self.edit && self.delete,
            }
    }
}
type PolicyPermissions = BTreeMap<String, Permissions>;
fn defaults() -> PolicyPermissions {
    RESOURCES
        .iter()
        .map(|(key, _, _)| ((*key).into(), Permissions::all()))
        .collect()
}
fn normalized(input: &PolicyPermissions) -> PolicyPermissions {
    RESOURCES
        .iter()
        .map(|(key, _, _)| ((*key).into(), input.get(*key).copied().unwrap_or_default()))
        .collect()
}
fn role_key(actor: &Actor) -> String {
    serde_json::to_value(&actor.role)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}
fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::Unauthorized)?.db)
}
fn reply(value: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

#[derive(Clone, sqlx::FromRow)]
struct Policy {
    id: Uuid,
    name: String,
    base_role: String,
    permissions: Value,
    version: i64,
}
impl Policy {
    fn flags(&self, actor: &Actor) -> Result<PolicyPermissions> {
        if self.base_role != role_key(actor) {
            return Ok(normalized(&BTreeMap::new()));
        }
        let input =
            serde_json::from_value(self.permissions.clone()).map_err(|_| Error::Forbidden)?;
        Ok(normalized(&input))
    }
    fn public(&self) -> Value {
        json!({"id":self.id,"name":self.name,"base_role":self.base_role,"permissions":self.permissions,"version":self.version})
    }
}
async fn assigned(pool: &PgPool, actor: &Actor) -> Result<Option<Policy>> {
    if matches!(
        actor.role,
        Role::Owner | Role::Patient | Role::PartnerSupport
    ) {
        return Ok(None);
    }
    Ok(sqlx::query_as("SELECT p.id,p.name,p.base_role,p.permissions,p.version FROM practice_access_assignments a JOIN practice_access_policies p ON p.tenant_id=a.tenant_id AND p.id=a.policy_id WHERE a.tenant_id=$1 AND a.user_id=$2")
  .bind(actor.tenant_id).bind(actor.sub).fetch_optional(pool).await?)
}

/// Internal native calls do not re-enter HTTP middleware. Reviewed workflow
/// execution must intersect the target resource policy before invoking helpers.
pub(crate) async fn require_native(
    state: &State,
    actor: &Actor,
    resource: &str,
    operation: &str,
) -> Result<()> {
    let action = match operation {
        "view" => Action::View,
        "create" => Action::Create,
        "edit" => Action::Edit,
        "delete" => Action::Delete,
        _ => return Err(Error::Forbidden),
    };
    if !RESOURCES.iter().any(|(key, _, _)| *key == resource) {
        return Err(Error::Forbidden);
    }
    if let Some(policy) = assigned(db(state)?, actor).await? {
        if !policy
            .flags(actor)?
            .get(resource)
            .copied()
            .unwrap_or_default()
            .permits(action)
        {
            return Err(Error::Forbidden);
        }
    }
    Ok(())
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Action {
    View,
    Create,
    Edit,
    Delete,
    Compound,
}
fn normalized_route(path: &str) -> String {
    path.split('/')
        .map(|part| {
            if part.starts_with('{') && part.ends_with('}') {
                "{}"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}
fn known_route(method: &Method, path: &str) -> bool {
    static ROUTES: OnceLock<HashSet<(String, String)>> = OnceLock::new();
    let routes = ROUTES.get_or_init(|| {
        let doc: Value = serde_json::from_str(include_str!("../api/openapi.json"))
            .expect("embedded API contract is valid JSON");
        doc["paths"]
            .as_object()
            .into_iter()
            .flat_map(|paths| paths.iter())
            .flat_map(|(path, ops)| {
                ops.as_object()
                    .into_iter()
                    .flat_map(|ops| ops.keys())
                    .filter(|key| {
                        ["get", "post", "put", "patch", "delete", "head"].contains(&key.as_str())
                    })
                    .map(move |method| (method.to_uppercase(), normalized_route(path)))
            })
            .collect()
    });
    let name = if *method == Method::HEAD {
        "GET"
    } else {
        method.as_str()
    };
    routes.contains(&(name.into(), path.into()))
        || matches!(
            (name, path),
            ("GET", "/api/v1/browser/events")
                | ("GET", "/api/v1/practice/access-policies")
                | ("POST", "/api/v1/practice/access-policies")
                | ("PUT", "/api/v1/practice/access-policies/{}")
                | ("PUT", "/api/v1/practice/staff/{}/access-policy")
        )
}
fn action(method: &Method, path: &str) -> Option<Action> {
    match *method {
        Method::GET | Method::HEAD => Some(Action::View),
        Method::PUT | Method::PATCH => Some(Action::Edit),
        Method::DELETE => Some(Action::Delete),
        Method::POST => {
            if path.starts_with("/api/v1/care-pathways/instances/")
                && path.ends_with("/intake-packet")
                || path.starts_with("/api/v1/previsit/packets/") && path.ends_with("/demographics")
            {
                return Some(Action::Edit);
            }
            let end = path.rsplit('/').next()?;
            if end == "actions" || path.contains("/actions/") {
                return Some(Action::Compound);
            }
            if [
                "cancel",
                "remove",
                "revoke",
                "archive",
                "expire",
                "disable",
                "entered-in-error",
            ]
            .contains(&end)
            {
                return Some(Action::Delete);
            }
            if [
                "acknowledge",
                "activation",
                "activate",
                "apply",
                "approve",
                "check-in",
                "commit",
                "complete",
                "install",
                "models",
                "preview",
                "privacy-preview",
                "read",
                "reconcile",
                "refresh",
                "reschedule",
                "review",
                "send",
                "sign",
                "start",
                "status",
                "subscription",
                "sync",
                "test",
                "validate",
                "watch",
                "publish",
                "submit",
                "assign",
            ]
            .contains(&end)
            {
                return Some(Action::Edit);
            }
            if [
                "277ca",
                "837p",
                "accounts",
                "acknowledgments",
                "amendments",
                "appointments",
                "attempts",
                "blocks",
                "claims",
                "clearinghouses",
                "clients",
                "clinical",
                "coverages",
                "definitions",
                "delivery",
                "destinations",
                "dispatch",
                "documents",
                "drafts",
                "entries",
                "era-batches",
                "facilities",
                "follow-ups",
                "from-source",
                "health-history",
                "holds",
                "immunizations",
                "installations",
                "intake-packet",
                "integrations",
                "intents",
                "invite",
                "items",
                "migrations",
                "onboarding",
                "orders",
                "outbound",
                "outbound-drafts",
                "patients",
                "payers",
                "payments",
                "pharmacies",
                "prescriptions",
                "provider-settings",
                "providers",
                "referrals",
                "refunds",
                "releases",
                "reminders",
                "remittances",
                "replies",
                "reports",
                "rooms",
                "series",
                "specimens",
                "staff",
                "subscriptions",
                "templates",
                "threads",
                "tickets",
                "trigger",
                "visits",
                "webhooks",
                "access-policies",
            ]
            .contains(&end)
            {
                return Some(Action::Create);
            }
            // Known record-level POST routes are commands, not collection creation.
            if end == "{}"
                && (path.contains("/inbox/")
                    || path.contains("/clinical-review/")
                    || path.contains("/portal-inbox/")
                    || path.contains("/portal/avs/"))
            {
                return Some(Action::Edit);
            }
            None
        }
        _ => None,
    }
}
fn resources(path: &str) -> Option<Vec<&'static str>> {
    let segments = path.split('/').collect::<Vec<_>>();
    if path == "/api/v1/sun/context" {
        return Some(vec!["clinical", "scheduling", "workflows"]);
    }
    if path == "/api/v1/practice/worklist" {
        return Some(vec!["practice", "clinical", "scheduling"]);
    }
    if path == "/api/v1/patients/{}/workspace" {
        return Some(vec!["clinical", "scheduling"]);
    }
    if path == "/api/v1/patients/{}/history" {
        return Some(vec!["clinical", "billing", "claims", "migration"]);
    }
    if path.starts_with("/api/v1/patients/{}/history/") && path.ends_with("/claim-mapping") {
        return Some(vec!["clinical", "claims", "migration"]);
    }
    if path.starts_with("/api/v1/patients/{}/portal") {
        return Some(vec!["clinical", "communications"]);
    }
    if path.starts_with("/api/v1/events") || path == "/api/v1/browser/events" {
        return Some(RESOURCES.iter().map(|(key, _, _)| *key).collect());
    }
    if path.starts_with("/fhir/") {
        return match segments.get(2).copied() {
            Some("Coverage") => Some(vec!["billing"]),
            Some("Appointment" | "Schedule" | "Slot") => Some(vec!["scheduling"]),
            Some(
                "Patient" | "Encounter" | "Observation" | "Condition" | "MedicationRequest"
                | "AllergyIntolerance" | "Immunization" | "DocumentReference" | "DiagnosticReport"
                | "ServiceRequest" | "Procedure" | "CarePlan",
            ) => Some(vec!["clinical"]),
            _ => None,
        };
    }
    if !path.starts_with("/api/v1/") {
        return None;
    }
    // Classify nested patient financial/scheduling routes before generic clinical reads.
    if segments.iter().any(|part| {
        [
            "claims",
            "submissions",
            "remittances",
            "277ca",
            "era-batches",
            "era-automation",
            "era-chains",
            "settlements",
            "recoupments",
            "clearinghouses",
            "retrieved-reports",
            "claimmd",
            "enrollments",
        ]
        .contains(part)
    }) {
        return Some(vec!["claims"]);
    }
    if segments
        .iter()
        .any(|part| ["billing", "coverages", "billing-mapping", "claim-mapping"].contains(part))
    {
        return Some(vec!["billing"]);
    }
    if segments
        .iter()
        .any(|part| ["appointments", "scheduling", "schedule", "previsit"].contains(part))
    {
        return Some(vec!["scheduling"]);
    }
    match segments.get(3).copied() {
        Some(
            "patients" | "visits" | "labs" | "prescribing" | "immunizations" | "referrals"
            | "referral-delivery" | "follow-up",
        ) => Some(vec!["clinical"]),
        Some("portal-inbox" | "patient-portal" | "portal") => Some(vec!["communications"]),
        Some("care-pathways" | "workflow-dispatches" | "automation") => Some(vec!["workflows"]),
        Some("ai" | "sun") => Some(vec!["ai"]),
        Some("integrations") => {
            if path.contains("/outbound")
                || path.contains("/inbox")
                || path.contains("/gmail/referrals")
            {
                Some(vec!["communications"])
            } else {
                Some(vec!["integrations"])
            }
        }
        Some("connect" | "connection" | "connector-catalog" | "oauth") => {
            Some(vec!["integrations"])
        }
        Some("practice") => Some(vec!["practice"]),
        Some("terminology") => Some(vec!["terminology"]),
        Some("migrations") => Some(vec!["migration"]),
        _ => None,
    }
}
fn permitted(permissions: &PolicyPermissions, method: &Method, path: &str) -> bool {
    let path = normalized_route(path);
    if matches!(
        path.as_str(),
        "/api/v1/practice/access-policy/current" | "/api/v1/practice/workspace-settings"
    ) && matches!(*method, Method::GET | Method::HEAD)
    {
        return true;
    }
    if !known_route(method, &path) {
        return false;
    }
    let (Some(action), Some(resources)) = (action(method, &path), resources(&path)) else {
        return false;
    };
    resources.iter().all(|resource| {
        permissions
            .get(*resource)
            .copied()
            .unwrap_or_default()
            .permits(action)
    })
}
fn public_callback(path: &str) -> bool {
    matches!(
        path,
        "/api/v1/connect/identity/accept" | "/api/v1/connect/support/accept"
    ) || path.starts_with("/api/v1/payments/webhooks/")
        || path.starts_with("/api/v1/integrations/ringcentral/webhooks/")
        || path.ends_with("/gmail/pubsub")
        || path.ends_with("/oauth/callback")
}
pub async fn enforce(
    ExtractState(state): ExtractState<State>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    if !(path.starts_with("/api/v1/") || path.starts_with("/fhir/")) || public_callback(path) {
        return next.run(request).await;
    }
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let staff_credential = crate::browser::cookie(request.headers()).is_some()
        || bearer.is_some_and(|token| token.starts_with("sce_at_") || state.allow_legacy_gateway);
    // Public token/webhook routes keep their own authentication. Protected handlers
    // still reject requests without their required browser/OAuth/gateway identity.
    if !staff_credential {
        return next.run(request).await;
    }
    let (mut parts, body) = request.into_parts();
    let actor = match Actor::from_request_parts(&mut parts, &state).await {
        Ok(actor) => actor,
        Err(error) => return error.into_response(),
    };
    let route = parts
        .extensions
        .get::<MatchedPath>()
        .map(|p| p.as_str())
        .unwrap_or(parts.uri.path());
    if let Some(browser) = &state.browser {
        match assigned(&browser.db, &actor).await {
            Ok(Some(policy)) => match policy.flags(&actor) {
                Ok(flags) if permitted(&flags, &parts.method, route) => {}
                Ok(_) => return Error::Forbidden.into_response(),
                Err(error) => return error.into_response(),
            },
            Ok(None) => {}
            Err(error) => return error.into_response(),
        }
    }
    // Only middleware inserts this verified actor, after custom-policy enforcement.
    parts.extensions.insert(actor);
    next.run(Request::from_parts(parts, body)).await
}

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/practice/access-policy/current", get(current))
        .route(
            "/api/v1/practice/access-policies",
            get(catalog).post(create),
        )
        .route("/api/v1/practice/access-policies/{id}", put(update))
        .route("/api/v1/practice/staff/{id}/access-policy", put(assign))
}
fn module_permissions(flags: &PolicyPermissions) -> BTreeMap<String, Permissions> {
    let mut modules = BTreeMap::new();
    for (key, _, names) in RESOURCES {
        for name in *names {
            modules.insert((*name).into(), flags.get(*key).copied().unwrap_or_default());
        }
    }
    for (module, required) in [
        ("clinical", vec!["clinical", "scheduling"]),
        ("practice", vec!["practice", "clinical", "scheduling"]),
    ] {
        modules.insert(
            module.into(),
            required.iter().fold(Permissions::all(), |value, key| {
                value.intersect(flags.get(*key).copied().unwrap_or_default())
            }),
        );
    }
    modules
}
async fn current(actor: Actor, ExtractState(state): ExtractState<State>) -> Result<Response> {
    actor.staff()?;
    let policy = assigned(db(&state)?, &actor).await?;
    let flags = match &policy {
        Some(policy) => policy.flags(&actor)?,
        None => defaults(),
    };
    Ok(reply(
        json!({"native_role":role_key(&actor),"policy":policy.as_ref().map(|p|json!({"id":p.id,"name":p.name,"base_role":p.base_role,"version":p.version})),"permissions":flags,"module_permissions":module_permissions(&flags),"restricted":policy.is_some(),"native_role_ceiling":true}),
    ))
}
async fn owner(state: &State, headers: &HeaderMap, write: bool) -> Result<Actor> {
    if headers.contains_key(header::AUTHORIZATION) {
        return Err(Error::Forbidden);
    }
    let actor = state
        .browser
        .as_ref()
        .ok_or(Error::Unauthorized)?
        .authenticate(headers, write)
        .await?;
    if !matches!(actor.role, Role::Owner) {
        return Err(Error::Forbidden);
    }
    Ok(actor)
}
async fn locked<'a>(
    state: &'a State,
    actor: &Actor,
    headers: &HeaderMap,
) -> Result<Transaction<'a, Postgres>> {
    let mut tx = db(state)?.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,320032))")
        .bind(actor.tenant_id.to_string())
        .execute(&mut *tx)
        .await?;
    crate::partner_support::verify_owner_in_tx(&mut tx, actor, headers).await?;
    Ok(tx)
}
fn reason(value: &str) -> Result<()> {
    if value.trim().is_empty()
        || value.chars().count() > 1000
        || value.chars().any(char::is_control)
    {
        Err(Error::Invalid(
            "a reason of 1 to 1000 plain-text characters is required",
        ))
    } else {
        Ok(())
    }
}
fn version(headers: &HeaderMap, zero: bool) -> Result<i64> {
    headers
        .get(header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix('"'))
        .and_then(|v| v.strip_suffix('"'))
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| if zero { *v >= 0 } else { *v > 0 })
        .ok_or(Error::VersionRequired)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    name: String,
    base_role: String,
    permissions: PolicyPermissions,
    reason: String,
}
impl Change {
    fn validate(&self) -> Result<()> {
        reason(&self.reason)?;
        if self.name.trim().is_empty()
            || self.name.chars().count() > 80
            || self.name.chars().any(char::is_control)
            || !BASE_ROLES.contains(&self.base_role.as_str())
        {
            return Err(Error::Invalid(
                "a policy name and supported non-owner native role are required",
            ));
        }
        for (key, flags) in &self.permissions {
            if !RESOURCES.iter().any(|(resource, _, _)| key == resource)
                || (!flags.view && (flags.create || flags.edit || flags.delete))
            {
                return Err(Error::Invalid(
                    "invalid policy resource or write permission without view",
                ));
            }
        }
        Ok(())
    }
}
async fn snapshot(tx: &mut Transaction<'_, Postgres>, actor: &Actor, id: Uuid) -> Result<Policy> {
    sqlx::query_as("SELECT id,name,base_role,permissions,version FROM practice_access_policies WHERE tenant_id=$1 AND id=$2 FOR UPDATE").bind(actor.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
async fn record(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    id: Uuid,
    kind: &str,
    version: i64,
    why: &str,
    content: &Value,
) -> Result<()> {
    sqlx::query("INSERT INTO practice_access_revisions(tenant_id,id,resource_id,resource_kind,version,actor_id,reason,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(actor.tenant_id).bind(Uuid::new_v4()).bind(id).bind(kind).bind(version).bind(actor.sub).bind(why.trim()).bind(content).execute(&mut **tx).await?;
    crate::postgres::audit(tx, actor, "practice.access_policy.changed", id).await
}
async fn revoke_sessions(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    users: &[Uuid],
) -> Result<()> {
    if users.is_empty() {
        return Ok(());
    }
    sqlx::query("DELETE FROM browser_sessions WHERE tenant_id=$1 AND user_id=ANY($2)")
        .bind(tenant)
        .bind(users)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE connect_identity_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND user_id=ANY($2)").bind(tenant).bind(users).execute(&mut **tx).await?;
    sqlx::query("UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND user_id=ANY($2)").bind(tenant).bind(users).execute(&mut **tx).await?;
    Ok(())
}
async fn catalog(ExtractState(state): ExtractState<State>, headers: HeaderMap) -> Result<Response> {
    let actor = owner(&state, &headers, false).await?;
    let mut tx = locked(&state, &actor, &headers).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',p.id,'name',p.name,'base_role',p.base_role,'permissions',p.permissions,'version',p.version,'assigned_users',(SELECT count(*) FROM practice_access_assignments a WHERE a.tenant_id=p.tenant_id AND a.policy_id=p.id)) FROM practice_access_policies p WHERE p.tenant_id=$1 ORDER BY lower(p.name),p.id LIMIT 100").bind(actor.tenant_id).fetch_all(&mut *tx).await?;
    let users:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',u.id,'display_name',u.display_name,'role',u.role,'disabled',u.disabled,'policy_id',a.policy_id,'assignment_version',COALESCE(a.version,0)) FROM browser_users u LEFT JOIN practice_access_assignments a ON a.tenant_id=u.tenant_id AND a.user_id=u.id WHERE u.tenant_id=$1 ORDER BY lower(u.display_name),u.id LIMIT 1001").bind(actor.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(
        &mut tx,
        &actor,
        "practice.access_policy.read",
        actor.tenant_id,
    )
    .await?;
    tx.commit().await?;
    Ok(reply(
        json!({"items":items,"users":users.iter().take(1000).collect::<Vec<_>>(),"users_has_more":users.len()>1000,"resources":RESOURCES.iter().map(|(key,label,modules)|json!({"key":key,"label":label,"modules":modules})).collect::<Vec<_>>(),"actions":["view","create","edit","delete"],"base_roles":BASE_ROLES,"defaults":defaults(),"workspace_defaults":crate::specialty_workspace::WorkspaceContent::default(),"limits":{"native_role_ceiling":true,"owner_assignment":false,"compound_actions_require_edit_and_delete":true,"unmapped_routes_denied":true,"policy_changes_require_sign_in":true},"action_semantics":{"create":"Known collection creation routes","edit":"PUT/PATCH and catalogued sign, approve, submit, refresh and other commands","delete":"DELETE and explicit cancel, revoke, archive, expire, disable and entered-in-error commands","compound":"Generic action commands require both edit and delete; native role checks still apply"}}),
    ))
}
async fn create(
    ExtractState(state): ExtractState<State>,
    headers: HeaderMap,
    Json(input): Json<Change>,
) -> Result<Response> {
    let actor = owner(&state, &headers, true).await?;
    input.validate()?;
    let mut tx = locked(&state, &actor, &headers).await?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM practice_access_policies WHERE tenant_id=$1")
            .bind(actor.tenant_id)
            .fetch_one(&mut *tx)
            .await?;
    if count >= 100 {
        return Err(Error::Invalid("at most 100 custom policies are supported"));
    }
    let id = Uuid::new_v4();
    let permissions = serde_json::to_value(normalized(&input.permissions))
        .map_err(|_| Error::Invalid("invalid policy permissions"))?;
    sqlx::query("INSERT INTO practice_access_policies(tenant_id,id,name,base_role,permissions,updated_by) VALUES($1,$2,$3,$4,$5,$6)").bind(actor.tenant_id).bind(id).bind(input.name.trim()).bind(&input.base_role).bind(permissions).bind(actor.sub).execute(&mut *tx).await?;
    let policy = snapshot(&mut tx, &actor, id).await?;
    record(
        &mut tx,
        &actor,
        id,
        "policy",
        1,
        &input.reason,
        &policy.public(),
    )
    .await?;
    tx.commit().await?;
    Ok(reply(policy.public()))
}
async fn update(
    ExtractState(state): ExtractState<State>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<Change>,
) -> Result<Response> {
    let actor = owner(&state, &headers, true).await?;
    input.validate()?;
    let expected = version(&headers, false)?;
    let mut tx = locked(&state, &actor, &headers).await?;
    let prior = snapshot(&mut tx, &actor, id).await?;
    if prior.version != expected {
        return Err(Error::Conflict(
            "access policy changed; reload before saving",
        ));
    }
    let users: Vec<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM practice_access_assignments WHERE tenant_id=$1 AND policy_id=$2",
    )
    .bind(actor.tenant_id)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    if prior.base_role != input.base_role && !users.is_empty() {
        return Err(Error::Conflict(
            "remove user assignments before changing the native role ceiling",
        ));
    }
    let permissions = serde_json::to_value(normalized(&input.permissions))
        .map_err(|_| Error::Invalid("invalid policy permissions"))?;
    sqlx::query("UPDATE practice_access_policies SET name=$3,base_role=$4,permissions=$5,version=version+1,updated_by=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(actor.tenant_id).bind(id).bind(input.name.trim()).bind(input.base_role).bind(permissions).bind(actor.sub).execute(&mut *tx).await?;
    let policy = snapshot(&mut tx, &actor, id).await?;
    record(
        &mut tx,
        &actor,
        id,
        "policy",
        policy.version,
        &input.reason,
        &policy.public(),
    )
    .await?;
    revoke_sessions(&mut tx, actor.tenant_id, &users).await?;
    tx.commit().await?;
    Ok(reply(policy.public()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Assignment {
    policy_id: Option<Uuid>,
    reason: String,
}
async fn assign(
    ExtractState(state): ExtractState<State>,
    headers: HeaderMap,
    Path(user): Path<Uuid>,
    Json(input): Json<Assignment>,
) -> Result<Response> {
    let actor = owner(&state, &headers, true).await?;
    reason(&input.reason)?;
    let expected = version(&headers, true)?;
    let mut tx = locked(&state, &actor, &headers).await?;
    let role: String = sqlx::query_scalar(
        "SELECT role FROM browser_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(actor.tenant_id)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    if role == "owner" || user == actor.sub {
        return Err(Error::Invalid(
            "owner access cannot be restricted by a custom policy",
        ));
    }
    if let Some(id) = input.policy_id {
        let policy = snapshot(&mut tx, &actor, id).await?;
        if policy.base_role != role {
            return Err(Error::Invalid(
                "custom policy native role must match the staff member's existing role",
            ));
        }
    }
    let current:Option<i64>=sqlx::query_scalar("SELECT version FROM practice_access_assignments WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE").bind(actor.tenant_id).bind(user).fetch_optional(&mut *tx).await?;
    if current.unwrap_or(0) != expected {
        return Err(Error::Conflict(
            "staff policy assignment changed; reload before saving",
        ));
    }
    let next = expected + 1;
    sqlx::query("INSERT INTO practice_access_assignments(tenant_id,user_id,policy_id,version,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,user_id) DO UPDATE SET policy_id=excluded.policy_id,version=excluded.version,updated_by=excluded.updated_by,updated_at=now()").bind(actor.tenant_id).bind(user).bind(input.policy_id).bind(next).bind(actor.sub).execute(&mut *tx).await?;
    let value = json!({"user_id":user,"policy_id":input.policy_id,"assignment_version":next,"sign_in_required":true});
    record(
        &mut tx,
        &actor,
        user,
        "assignment",
        next,
        &input.reason,
        &value,
    )
    .await?;
    revoke_sessions(&mut tx, actor.tenant_id, &[user]).await?;
    tx.commit().await?;
    Ok(reply(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_time_connect_handoffs_replace_stale_browser_sessions() {
        assert!(public_callback("/api/v1/connect/identity/accept"));
        assert!(public_callback("/api/v1/connect/support/accept"));
        assert!(!public_callback("/api/v1/connect/services"));
    }
    #[test]
    fn route_permissions_fail_closed_and_classify_commands() {
        let mut flags = defaults();
        assert!(permitted(&flags, &Method::GET, "/api/v1/patients"));
        assert!(!permitted(
            &flags,
            &Method::GET,
            "/api/v1/patients/{id}/new-unreviewed-export"
        ));
        flags.get_mut("clinical").unwrap().create = false;
        assert!(!permitted(&flags, &Method::POST, "/api/v1/patients"));
        assert!(permitted(&flags, &Method::POST, "/api/v1/visits/{id}/sign"));
        flags.get_mut("clinical").unwrap().delete = false;
        assert!(!permitted(
            &flags,
            &Method::POST,
            "/api/v1/patients/{patient}/orders/{order}/actions"
        ));
        assert!(permitted(&flags, &Method::PUT, "/api/v1/visits/{id}/note"));
        flags.get_mut("scheduling").unwrap().delete = false;
        assert!(!permitted(
            &flags,
            &Method::POST,
            "/api/v1/scheduling/appointments/{id}/cancel"
        ));
        assert!(permitted(
            &flags,
            &Method::POST,
            "/api/v1/scheduling/appointments/{id}/reschedule"
        ));
    }
    #[test]
    fn aggregates_and_nested_patient_domains_require_their_sources() {
        let mut flags = defaults();
        flags.get_mut("communications").unwrap().view = false;
        for (method, path) in [
            (Method::GET, "/api/v1/patients/{patient}/portal"),
            (Method::POST, "/api/v1/patients/{patient}/portal/invite"),
            (Method::POST, "/api/v1/patients/{patient}/portal/revoke"),
            (
                Method::POST,
                "/api/v1/patients/{patient}/portal/avs/{visit}",
            ),
        ] {
            assert!(!permitted(&flags, &method, path), "{path}");
        }
        flags.get_mut("billing").unwrap().view = false;
        assert!(!permitted(
            &flags,
            &Method::GET,
            "/api/v1/patients/{p}/billing/accounts"
        ));
        assert!(!permitted(
            &flags,
            &Method::GET,
            "/api/v1/patients/{id}/history"
        ));
        assert!(permitted(
            &flags,
            &Method::GET,
            "/api/v1/patients/{id}/record"
        ));
        flags.get_mut("billing").unwrap().view = true;
        flags.get_mut("claims").unwrap().view = false;
        assert!(!permitted(
            &flags,
            &Method::GET,
            "/api/v1/patients/{p}/history/{id}/claim-mapping"
        ));
        flags.get_mut("scheduling").unwrap().view = false;
        assert!(!permitted(
            &flags,
            &Method::GET,
            "/api/v1/patients/{id}/workspace"
        ));
        assert!(!permitted(&flags, &Method::GET, "/api/v1/sun/context"));
        assert!(!permitted(
            &flags,
            &Method::GET,
            "/api/v1/practice/worklist"
        ));
        assert!(!permitted(&flags, &Method::GET, "/api/v1/browser/events"));
        assert!(permitted(
            &flags,
            &Method::GET,
            "/api/v1/practice/access-policy/current"
        ));
        let denied = normalized(&BTreeMap::new());
        assert!(permitted(
            &denied,
            &Method::GET,
            "/api/v1/practice/workspace-settings"
        ));
        assert!(!permitted(
            &denied,
            &Method::PUT,
            "/api/v1/practice/workspace-settings"
        ));
    }
    #[test]
    fn policy_defaults_are_deny_and_cannot_remove_view_under_write() {
        assert!(!normalized(&BTreeMap::new())["clinical"].view);
        let change = Change {
            name: "Scoped nurse".into(),
            base_role: "nurse".into(),
            permissions: BTreeMap::from([(
                "clinical".into(),
                Permissions {
                    edit: true,
                    ..Default::default()
                },
            )]),
            reason: "Synthetic policy".into(),
        };
        assert!(change.validate().is_err());
    }
}
