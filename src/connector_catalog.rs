// SPDX-License-Identifier: AGPL-3.0-only
//! Declarative, instance-local connector catalog.
//!
//! Manifests describe compiled connector capabilities. They cannot contain
//! executable code, HTTP targets, headers, templates, or arbitrary scripts.
use crate::{
    auth::{Actor, Role},
    error::{Error, Result},
    postgres::audit,
    State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashSet;
use url::Url;
use uuid::Uuid;

const API_VERSION: &str = "suncharts.dev/connector/v1";
const OPEN_LICENSES: &[&str] = &[
    "AGPL-3.0-only",
    "Apache-2.0",
    "MIT",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "MPL-2.0",
];
const ROLES: &[&str] = &[
    "owner",
    "clinician",
    "nurse",
    "medical_assistant",
    "front_desk",
    "read_only",
];

fn db(state: &State) -> Result<&PgPool> {
    Ok(&state.browser.as_ref().ok_or(Error::NotFound)?.db)
}
fn owner(actor: &Actor) -> Result<()> {
    if matches!(actor.role, Role::Owner) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
fn reply(value: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}
fn bounded(value: &str, min: usize, max: usize) -> bool {
    let count = value.chars().count();
    count >= min && count <= max && !value.chars().any(char::is_control)
}
fn identifier(value: &str, min: usize, max: usize) -> bool {
    bounded(value, min, max)
        && value.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' | b'0'..=b'9' => true,
            b'.' | b'_' | b'-' => index > 0,
            _ => false,
        })
        && !value.ends_with(['.', '_', '-'])
}
fn automation_event_type(value: &str) -> bool {
    value.len() <= 180
        && value.split('.').count() >= 3
        && value.split('.').all(|segment| {
            identifier(segment, 1, 80)
                && !matches!(
                    segment,
                    "all" | "any" | "generic" | "everything" | "wildcard" | "*"
                )
        })
}
fn semver(value: &str) -> bool {
    fn identifiers(value: &str, forbid_numeric_leading_zero: bool) -> bool {
        !value.is_empty()
            && value.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                    && (!forbid_numeric_leading_zero
                        || !part.bytes().all(|byte| byte.is_ascii_digit())
                        || part == "0"
                        || !part.starts_with('0'))
            })
    }
    let (without_build, build) = value
        .split_once('+')
        .map_or((value, None), |(base, build)| (base, Some(build)));
    let (base, prerelease) = without_build
        .split_once('-')
        .map_or((without_build, None), |(base, pre)| (base, Some(pre)));
    let mut segments = base.split('.');
    let valid = (0..3).all(|_| {
        segments.next().is_some_and(|segment| {
            !segment.is_empty()
                && segment.bytes().all(|byte| byte.is_ascii_digit())
                && (segment == "0" || !segment.starts_with('0'))
        })
    });
    valid
        && segments.next().is_none()
        && prerelease.is_none_or(|part| identifiers(part, true))
        && build.is_none_or(|part| identifiers(part, false))
        && bounded(value, 5, 80)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}
fn https_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && bounded(value, 12, 2000)
    })
}
fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectorManifest {
    pub api_version: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub license: String,
    pub homepage: String,
    pub repository: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub auth_schemes: Vec<AuthScheme>,
    #[serde(default)]
    pub triggers: Vec<TriggerDefinition>,
    #[serde(default)]
    pub actions: Vec<ActionDefinition>,
    pub lifecycle: Lifecycle,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthScheme {
    pub id: String,
    pub kind: AuthKind,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub credential_fields: Vec<CredentialField>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    None,
    ApiKey,
    Oauth2,
    Oauth2Client,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialField {
    pub id: String,
    pub title: String,
    pub secret: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TriggerDefinition {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub event_type: String,
    pub transport: TriggerTransport,
    pub auth_scheme: Option<String>,
    #[serde(default)]
    pub required_roles: Vec<String>,
    #[serde(default)]
    pub required_scopes: Vec<String>,
    pub phi: PhiClass,
    pub output: ObjectSchema,
    /// Optional compiled action staged when this exact trigger is delivered.
    /// Every action input field must be an exact typed projection of this trigger output.
    #[serde(default)]
    pub dispatch_action: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerTransport {
    InternalEvent,
    Webhook,
    Websocket,
    Polling,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ActionDefinition {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// Resolves only to a connector implementation compiled into the EHR.
    pub implementation: String,
    pub transport: ActionTransport,
    pub auth_scheme: Option<String>,
    #[serde(default)]
    pub required_roles: Vec<String>,
    #[serde(default)]
    pub required_scopes: Vec<String>,
    pub phi: PhiClass,
    pub effect: ActionEffect,
    pub approval: ApprovalPolicy,
    pub idempotency: IdempotencyClass,
    pub retry: RetryClass,
    pub input: ObjectSchema,
    pub output: ObjectSchema,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionTransport {
    Native,
    ProviderApi,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionEffect {
    Read,
    Write,
    ExternalSend,
    ClinicalWrite,
    BillingWrite,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    None,
    Staff,
    Clinical,
    Owner,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IdempotencyClass {
    None,
    RequestKey,
    NaturalKey,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetryClass {
    Never,
    ReadOnly,
    SafeIdempotent,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PhiClass {
    None,
    Identifiers,
    Limited,
    Clinical,
    Billing,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ObjectSchema {
    #[serde(default)]
    pub fields: Vec<FieldSchema>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FieldSchema {
    pub id: String,
    pub title: String,
    pub field_type: FieldType,
    pub required: bool,
    pub phi: PhiClass,
    #[serde(default)]
    pub enum_values: Vec<String>,
    #[serde(default)]
    pub fields: Vec<FieldSchema>,
    #[serde(default)]
    pub items: Vec<FieldSchema>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    String,
    Integer,
    Number,
    Boolean,
    Uuid,
    DateTime,
    Object,
    Array,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Lifecycle {
    pub setup: bool,
    pub deactivate: bool,
    pub sample_events: bool,
}

impl ConnectorManifest {
    pub fn validate(&self) -> Result<()> {
        if self.api_version != API_VERSION
            || !identifier(&self.id, 3, 120)
            || !bounded(&self.name, 2, 120)
            || !semver(&self.version)
            || !OPEN_LICENSES.contains(&self.license.as_str())
            || !https_url(&self.homepage)
            || !https_url(&self.repository)
            || !bounded(&self.description, 0, 1000)
            || self.auth_schemes.len() > 8
            || self.triggers.len() > 64
            || self.actions.len() > 128
            || self.triggers.is_empty() && self.actions.is_empty()
        {
            return Err(Error::Invalid("invalid connector manifest metadata"));
        }
        let mut auth = HashSet::new();
        for scheme in &self.auth_schemes {
            if !identifier(&scheme.id, 2, 80)
                || !auth.insert(scheme.id.as_str())
                || scheme.scopes.len() > 64
                || scheme.credential_fields.len() > 16
                || !unique_bounded(&scheme.scopes, 1, 240)
            {
                return Err(Error::Invalid("invalid connector authentication scheme"));
            }
            let mut fields = HashSet::new();
            for field in &scheme.credential_fields {
                if !identifier(&field.id, 2, 80)
                    || !bounded(&field.title, 1, 120)
                    || !fields.insert(field.id.as_str())
                {
                    return Err(Error::Invalid("invalid connector credential field"));
                }
            }
            if matches!(scheme.kind, AuthKind::None)
                && (!scheme.scopes.is_empty() || !scheme.credential_fields.is_empty())
            {
                return Err(Error::Invalid(
                    "unauthenticated connector scheme has credentials",
                ));
            }
            if matches!(scheme.kind, AuthKind::ApiKey)
                && (scheme.credential_fields.is_empty()
                    || scheme.credential_fields.iter().any(|field| !field.secret))
            {
                return Err(Error::Invalid(
                    "API key connector scheme requires secret credential fields",
                ));
            }
        }
        let mut components = HashSet::new();
        for trigger in &self.triggers {
            validate_component(
                ComponentDescriptor {
                    id: &trigger.id,
                    title: &trigger.title,
                    description: &trigger.description,
                    auth_scheme: trigger.auth_scheme.as_deref(),
                    roles: &trigger.required_roles,
                    scopes: &trigger.required_scopes,
                    schema: &trigger.output,
                },
                &auth,
                &mut components,
            )?;
            if !automation_event_type(&trigger.event_type) {
                return Err(Error::Invalid("invalid connector trigger event"));
            }
        }
        for action in &self.actions {
            validate_component(
                ComponentDescriptor {
                    id: &action.id,
                    title: &action.title,
                    description: &action.description,
                    auth_scheme: action.auth_scheme.as_deref(),
                    roles: &action.required_roles,
                    scopes: &action.required_scopes,
                    schema: &action.input,
                },
                &auth,
                &mut components,
            )?;
            validate_schema(&action.output, 0)?;
            if !identifier(&action.implementation, 3, 160) {
                return Err(Error::Invalid("invalid compiled connector implementation"));
            }
            if matches!(action.effect, ActionEffect::ExternalSend)
                && (action.approval == ApprovalPolicy::None || action.retry != RetryClass::Never)
            {
                return Err(Error::Invalid(
                    "external send must be reviewed and never retried",
                ));
            }
            if matches!(action.effect, ActionEffect::ClinicalWrite)
                && !matches!(
                    action.approval,
                    ApprovalPolicy::Clinical | ApprovalPolicy::Owner
                )
            {
                return Err(Error::Invalid("clinical write requires clinical approval"));
            }
            if matches!(action.effect, ActionEffect::BillingWrite)
                && (action.approval != ApprovalPolicy::Owner || action.retry != RetryClass::Never)
            {
                return Err(Error::Invalid(
                    "billing write requires owner approval and no automatic retry",
                ));
            }
            if action.effect != ActionEffect::Read
                && action.required_roles.iter().any(|role| role == "read_only")
            {
                return Err(Error::Invalid(
                    "read-only roles cannot invoke connector writes",
                ));
            }
            if action.effect == ActionEffect::Write && action.idempotency == IdempotencyClass::None
            {
                return Err(Error::Invalid(
                    "generic connector writes require declared idempotency",
                ));
            }
            if action.retry == RetryClass::ReadOnly && action.effect != ActionEffect::Read {
                return Err(Error::Invalid("read-only retry requires a read action"));
            }
            if action.retry == RetryClass::SafeIdempotent
                && action.idempotency == IdempotencyClass::None
            {
                return Err(Error::Invalid(
                    "safe retry requires a declared idempotency key",
                ));
            }
        }
        for trigger in &self.triggers {
            let Some(dispatch_action) = trigger.dispatch_action.as_deref() else {
                continue;
            };
            let Some(action) = self
                .actions
                .iter()
                .find(|action| action.id == dispatch_action)
            else {
                return Err(Error::Invalid(
                    "connector trigger dispatch action was not found",
                ));
            };
            if !action
                .input
                .fields
                .iter()
                .all(|input| trigger.output.fields.iter().any(|output| output == input))
            {
                return Err(Error::Invalid(
                    "connector dispatch action is not a typed trigger projection",
                ));
            }
        }
        let encoded =
            serde_json::to_vec(self).map_err(|_| Error::Invalid("invalid connector manifest"))?;
        if encoded.len() > 262_144 {
            return Err(Error::Invalid("connector manifest exceeds its limit"));
        }
        Ok(())
    }
}

fn unique_bounded(values: &[String], min: usize, max: usize) -> bool {
    values.len() <= 64
        && values.iter().all(|value| bounded(value, min, max))
        && values.iter().collect::<HashSet<_>>().len() == values.len()
}

struct ComponentDescriptor<'a> {
    id: &'a str,
    title: &'a str,
    description: &'a str,
    auth_scheme: Option<&'a str>,
    roles: &'a [String],
    scopes: &'a [String],
    schema: &'a ObjectSchema,
}

fn validate_component<'a>(
    component: ComponentDescriptor<'a>,
    auth: &HashSet<&str>,
    components: &mut HashSet<&'a str>,
) -> Result<()> {
    if !identifier(component.id, 3, 120)
        || !components.insert(component.id)
        || !bounded(component.title, 2, 120)
        || !bounded(component.description, 0, 1000)
        || component
            .auth_scheme
            .is_some_and(|scheme| !auth.contains(scheme))
        || component.roles.len() > ROLES.len()
        || component
            .roles
            .iter()
            .any(|role| !ROLES.contains(&role.as_str()))
        || component.roles.iter().collect::<HashSet<_>>().len() != component.roles.len()
        || !unique_bounded(component.scopes, 1, 240)
    {
        return Err(Error::Invalid("invalid connector component"));
    }
    validate_schema(component.schema, 0)
}
fn validate_schema(schema: &ObjectSchema, depth: usize) -> Result<()> {
    if depth > 4 || schema.fields.len() > 50 {
        return Err(Error::Invalid("connector schema exceeds its limit"));
    }
    let mut ids = HashSet::new();
    for field in &schema.fields {
        if !identifier(&field.id, 1, 80)
            || !bounded(&field.title, 1, 120)
            || !ids.insert(field.id.as_str())
            || field.enum_values.len() > 100
            || !unique_bounded(&field.enum_values, 1, 240)
            || field.fields.len() > 50
            || field.items.len() > 1
            || (!field.enum_values.is_empty() && field.field_type != FieldType::String)
        {
            return Err(Error::Invalid("invalid connector schema field"));
        }
        if field.field_type == FieldType::Object {
            if field.fields.is_empty() || !field.items.is_empty() {
                return Err(Error::Invalid("invalid object connector field"));
            }
            validate_schema(
                &ObjectSchema {
                    fields: field.fields.clone(),
                },
                depth + 1,
            )?;
        } else if field.field_type == FieldType::Array {
            if field.items.len() != 1 || !field.fields.is_empty() {
                return Err(Error::Invalid("invalid array connector field"));
            }
            validate_schema(
                &ObjectSchema {
                    fields: field.items.clone(),
                },
                depth + 1,
            )?;
        } else if !field.fields.is_empty() || !field.items.is_empty() {
            return Err(Error::Invalid("scalar connector field has nested schema"));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallRequest {
    request_id: Uuid,
    manifest: ConnectorManifest,
    provenance: Provenance,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BuiltinInstallRequest {
    request_id: Uuid,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviseRequest {
    manifest: ConnectorManifest,
    provenance: Provenance,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Provenance {
    repository_url: String,
    source_revision: String,
    source_digest: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogAction {
    action: String,
    reason: String,
}

impl Provenance {
    fn validate(&self, manifest: &ConnectorManifest) -> Result<()> {
        if !https_url(&self.repository_url)
            || self.repository_url != manifest.repository
            || !bounded(&self.source_revision, 7, 200)
            || !digest(&self.source_digest)
        {
            Err(Error::Invalid("invalid connector source provenance"))
        } else {
            Ok(())
        }
    }
}
fn reason(value: &str) -> Result<&str> {
    let value = value.trim();
    if bounded(value, 1, 1000) {
        Ok(value)
    } else {
        Err(Error::Invalid("connector change reason is required"))
    }
}
fn manifest_value(manifest: &ConnectorManifest) -> Result<(Value, String)> {
    manifest.validate()?;
    let value =
        serde_json::to_value(manifest).map_err(|_| Error::Invalid("invalid connector manifest"))?;
    let canonical =
        serde_json::to_string(&value).map_err(|_| Error::Invalid("invalid connector manifest"))?;
    Ok((value, crate::oauth::hash(&canonical)))
}

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/connector-catalog/builtins", get(list_builtins))
        .route(
            "/api/v1/connector-catalog/builtins/{connector_id}/install",
            post(install_builtin),
        )
        .route(
            "/api/v1/connector-catalog/installations",
            get(list).post(install),
        )
        .route(
            "/api/v1/connector-catalog/installations/{id}",
            get(detail).put(revise),
        )
        .route(
            "/api/v1/connector-catalog/installations/{id}/actions",
            post(action),
        )
}

async fn list_builtins(actor: Actor, ExtractState(state): ExtractState<State>) -> Result<Response> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    let installed: HashSet<String> =
        sqlx::query_scalar("SELECT connector_id FROM connector_installations WHERE tenant_id=$1")
            .bind(actor.tenant_id)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .collect();
    let items: Vec<Value> = crate::builtin_connectors::manifests()
        .into_iter()
        .map(|manifest| {
            json!({
                "installed": installed.contains(&manifest.id),
                "manifest": manifest,
                "provenance": "builtin"
            })
        })
        .collect();
    audit(
        &mut tx,
        &actor,
        "connector.catalog.builtins.list",
        actor.tenant_id,
    )
    .await?;
    tx.commit().await?;
    Ok(reply(json!({"items":items})))
}

async fn install_builtin(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(connector_id): Path<String>,
    Json(input): Json<BuiltinInstallRequest>,
) -> Result<Response> {
    owner(&actor)?;
    let change_reason = reason(&input.reason)?.to_owned();
    let manifest = crate::builtin_connectors::manifest(&connector_id).ok_or(Error::NotFound)?;
    let (_, source_digest) = manifest_value(&manifest)?;
    let provenance = Provenance {
        repository_url: manifest.repository.clone(),
        source_revision: format!("suncharts-engine-{}", env!("CARGO_PKG_VERSION")),
        source_digest,
    };
    install_manifest(
        actor,
        state,
        input.request_id,
        manifest,
        provenance,
        "builtin",
        &change_reason,
    )
    .await
}

async fn list(actor: Actor, ExtractState(state): ExtractState<State>) -> Result<Response> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',i.id,'connector_id',i.connector_id,'status',i.status,'revision',i.current_revision,'version',i.version,'manifest_version',r.manifest->>'version','name',r.manifest->>'name','license',r.manifest->>'license','provenance',r.provenance,'repository_url',r.repository_url,'source_revision',r.source_revision,'created_at',i.created_at,'updated_at',i.updated_at) FROM connector_installations i JOIN connector_installation_revisions r ON r.tenant_id=i.tenant_id AND r.installation_id=i.id AND r.revision=i.current_revision WHERE i.tenant_id=$1 ORDER BY i.connector_id LIMIT 200")
        .bind(actor.tenant_id).fetch_all(&mut *tx).await?;
    audit(&mut tx, &actor, "connector.catalog.list", actor.tenant_id).await?;
    tx.commit().await?;
    Ok(reply(json!({"items":items})))
}

async fn detail(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    actor.staff()?;
    let mut tx = db(&state)?.begin().await?;
    let installation:Value=sqlx::query_scalar("SELECT jsonb_build_object('id',i.id,'connector_id',i.connector_id,'status',i.status,'revision',i.current_revision,'version',i.version,'manifest',r.manifest,'manifest_digest',r.manifest_digest,'provenance',r.provenance,'repository_url',r.repository_url,'source_revision',r.source_revision,'source_digest',r.source_digest,'created_at',i.created_at,'updated_at',i.updated_at) FROM connector_installations i JOIN connector_installation_revisions r ON r.tenant_id=i.tenant_id AND r.installation_id=i.id AND r.revision=i.current_revision WHERE i.tenant_id=$1 AND i.id=$2")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let revisions:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('revision',revision,'manifest_version',manifest->>'version','manifest_digest',manifest_digest,'provenance',provenance,'repository_url',repository_url,'source_revision',source_revision,'source_digest',source_digest,'created_by',created_by,'reason',reason,'created_at',created_at) FROM connector_installation_revisions WHERE tenant_id=$1 AND installation_id=$2 ORDER BY revision DESC LIMIT 100")
        .bind(actor.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('sequence',sequence,'actor_id',actor_id,'action',action,'reason',reason,'created_at',created_at) FROM connector_installation_events WHERE tenant_id=$1 AND installation_id=$2 ORDER BY sequence DESC LIMIT 100")
        .bind(actor.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    audit(&mut tx, &actor, "connector.catalog.read", id).await?;
    tx.commit().await?;
    Ok(reply(
        json!({"installation":installation,"revisions":revisions,"events":events}),
    ))
}

async fn install(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Json(input): Json<InstallRequest>,
) -> Result<Response> {
    owner(&actor)?;
    let change_reason = reason(&input.reason)?.to_owned();
    input.provenance.validate(&input.manifest)?;
    install_manifest(
        actor,
        state,
        input.request_id,
        input.manifest,
        input.provenance,
        "community",
        &change_reason,
    )
    .await
}

async fn install_manifest(
    actor: Actor,
    state: State,
    request_id: Uuid,
    connector: ConnectorManifest,
    provenance: Provenance,
    provenance_kind: &str,
    change_reason: &str,
) -> Result<Response> {
    debug_assert!(matches!(provenance_kind, "builtin" | "community"));
    provenance.validate(&connector)?;
    let (manifest, digest) = manifest_value(&connector)?;
    let request_digest = crate::oauth::hash(&format!(
        "{}:{}:{}",
        connector.id, digest, provenance.source_digest
    ));
    let mut tx = db(&state)?.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "{}:connector-install:{}",
            actor.tenant_id, request_id
        ))
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("{}:connector-id:{}", actor.tenant_id, connector.id))
        .execute(&mut *tx)
        .await?;
    if let Some((id,old_digest))=sqlx::query_as::<_,(Uuid,String)>("SELECT id,request_digest FROM connector_installations WHERE tenant_id=$1 AND request_id=$2")
        .bind(actor.tenant_id).bind(request_id).fetch_optional(&mut *tx).await? {
        if old_digest!=request_digest{return Err(Error::Conflict("request ID was reused for a different connector"));}
        let value=current(&mut tx,&actor,id).await?;tx.commit().await?;return Ok(reply(value));
    }
    if sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM connector_installations WHERE tenant_id=$1 AND connector_id=$2)",
    )
    .bind(actor.tenant_id)
    .bind(&connector.id)
    .fetch_one(&mut *tx)
    .await?
    {
        return Err(Error::Conflict("connector is already installed"));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO connector_installations(tenant_id,id,connector_id,request_id,request_digest,created_by) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(actor.tenant_id).bind(id).bind(&connector.id).bind(request_id).bind(request_digest).bind(actor.sub).execute(&mut *tx).await?;
    insert_revision(
        &mut tx,
        &actor,
        RevisionRecord {
            installation_id: id,
            revision: 1,
            manifest: &manifest,
            manifest_digest: &digest,
            provenance: provenance_kind,
            source: &provenance,
            reason: change_reason,
        },
    )
    .await?;
    audit(&mut tx, &actor, "connector.catalog.install", id).await?;
    let value = current(&mut tx, &actor, id).await?;
    tx.commit().await?;
    Ok(reply(value))
}

async fn revise(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<ReviseRequest>,
) -> Result<Response> {
    owner(&actor)?;
    let expected = crate::expected(&headers)?;
    let reason = reason(&input.reason)?;
    input.provenance.validate(&input.manifest)?;
    let (manifest, digest) = manifest_value(&input.manifest)?;
    let mut tx = db(&state)?.begin().await?;
    let row:Option<(String,String,i64,i64)>=sqlx::query_as("SELECT connector_id,status,current_revision,version FROM connector_installations WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
    let (connector, status, revision, version) = row.ok_or(Error::NotFound)?;
    if version != expected {
        return Err(Error::Conflict("connector installation changed; reload"));
    }
    if status == "deactivated" {
        return Err(Error::Conflict("deactivated connector cannot be revised"));
    }
    if connector != input.manifest.id {
        return Err(Error::Conflict("connector identity cannot change"));
    }
    let current_version:String=sqlx::query_scalar("SELECT manifest->>'version' FROM connector_installation_revisions WHERE tenant_id=$1 AND installation_id=$2 AND revision=$3")
        .bind(actor.tenant_id).bind(id).bind(revision).fetch_one(&mut *tx).await?;
    if current_version == input.manifest.version {
        return Err(Error::Conflict("connector manifest version must change"));
    }
    let next = revision + 1;
    insert_revision(
        &mut tx,
        &actor,
        RevisionRecord {
            installation_id: id,
            revision: next,
            manifest: &manifest,
            manifest_digest: &digest,
            provenance: "community",
            source: &input.provenance,
            reason,
        },
    )
    .await?;
    sqlx::query("UPDATE connector_installations SET current_revision=$3,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).bind(next).execute(&mut *tx).await?;
    audit(&mut tx, &actor, "connector.catalog.revise", id).await?;
    let value = current(&mut tx, &actor, id).await?;
    tx.commit().await?;
    Ok(reply(value))
}

async fn action(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<CatalogAction>,
) -> Result<Response> {
    owner(&actor)?;
    let expected = crate::expected(&headers)?;
    let reason = reason(&input.reason)?;
    let mut tx = db(&state)?.begin().await?;
    let row:Option<(String,i64)>=sqlx::query_as("SELECT status,version FROM connector_installations WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
    let (old, version) = row.ok_or(Error::NotFound)?;
    if version != expected {
        return Err(Error::Conflict("connector installation changed; reload"));
    }
    let next = match (old.as_str(), input.action.as_str()) {
        ("disabled", "enable") => "enabled",
        ("enabled", "disable") => "disabled",
        ("disabled" | "enabled", "deactivate") => "deactivated",
        _ => return Err(Error::Conflict("invalid connector installation action")),
    };
    sqlx::query("UPDATE connector_installations SET status=$3,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2")
        .bind(actor.tenant_id).bind(id).bind(next).execute(&mut *tx).await?;
    if next != "enabled" {
        let subscriptions:Vec<Uuid>=sqlx::query_scalar("UPDATE automation_trigger_subscriptions SET status='inactive',version=version+1,deactivated_at=now(),updated_at=now() WHERE tenant_id=$1 AND installation_id=$2 AND status IN ('active','error') RETURNING id")
            .bind(actor.tenant_id).bind(id).fetch_all(&mut *tx).await?;
        let reason_digest = crate::oauth::hash(reason);
        for subscription in subscriptions {
            sqlx::query("INSERT INTO automation_trigger_subscription_history(tenant_id,subscription_id,actor_id,action,reason_digest) VALUES($1,$2,$3,'deactivated',$4)")
                .bind(actor.tenant_id).bind(subscription).bind(actor.sub).bind(&reason_digest).execute(&mut *tx).await?;
            audit(
                &mut tx,
                &actor,
                "automation.subscription.connector_disabled",
                subscription,
            )
            .await?;
        }
        let deliveries:Vec<Uuid>=sqlx::query_scalar("UPDATE automation_event_deliveries d SET status='cancelled',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_code='connector_disabled',updated_at=now() FROM automation_trigger_subscriptions s WHERE d.tenant_id=$1 AND s.tenant_id=d.tenant_id AND s.id=d.subscription_id AND s.installation_id=$2 AND d.status IN ('pending','leased') RETURNING d.id")
            .bind(actor.tenant_id).bind(id).fetch_all(&mut *tx).await?;
        for delivery in deliveries {
            sqlx::query("INSERT INTO automation_event_delivery_history(tenant_id,delivery_id,actor_id,action,evidence) VALUES($1,$2,$3,'cancelled',jsonb_build_object('reason_code','connector_disabled'))")
                .bind(actor.tenant_id).bind(delivery).bind(actor.sub).execute(&mut *tx).await?;
            audit(
                &mut tx,
                &actor,
                "automation.delivery.connector_disabled",
                delivery,
            )
            .await?;
        }
    }
    sqlx::query("INSERT INTO connector_installation_events(tenant_id,installation_id,actor_id,action,reason) VALUES($1,$2,$3,$4,$5)")
        .bind(actor.tenant_id).bind(id).bind(actor.sub).bind(&input.action).bind(reason).execute(&mut *tx).await?;
    audit(&mut tx, &actor, "connector.catalog.action", id).await?;
    let value = current(&mut tx, &actor, id).await?;
    tx.commit().await?;
    Ok(reply(value))
}

struct RevisionRecord<'a> {
    installation_id: Uuid,
    revision: i64,
    manifest: &'a Value,
    manifest_digest: &'a str,
    provenance: &'a str,
    source: &'a Provenance,
    reason: &'a str,
}

async fn insert_revision(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    record: RevisionRecord<'_>,
) -> Result<()> {
    sqlx::query("INSERT INTO connector_installation_revisions(tenant_id,installation_id,revision,manifest,manifest_digest,provenance,repository_url,source_revision,source_digest,created_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
        .bind(actor.tenant_id)
        .bind(record.installation_id)
        .bind(record.revision)
        .bind(record.manifest)
        .bind(record.manifest_digest)
        .bind(record.provenance)
        .bind(&record.source.repository_url)
        .bind(&record.source.source_revision)
        .bind(&record.source.source_digest)
        .bind(actor.sub)
        .bind(record.reason)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn current(tx: &mut Transaction<'_, Postgres>, actor: &Actor, id: Uuid) -> Result<Value> {
    sqlx::query_scalar("SELECT jsonb_build_object('id',i.id,'connector_id',i.connector_id,'status',i.status,'revision',i.current_revision,'version',i.version,'manifest',r.manifest,'manifest_digest',r.manifest_digest,'provenance',r.provenance,'repository_url',r.repository_url,'source_revision',r.source_revision,'source_digest',r.source_digest,'created_at',i.created_at,'updated_at',i.updated_at) FROM connector_installations i JOIN connector_installation_revisions r ON r.tenant_id=i.tenant_id AND r.installation_id=i.id AND r.revision=i.current_revision WHERE i.tenant_id=$1 AND i.id=$2")
        .bind(actor.tenant_id).bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> ConnectorManifest {
        ConnectorManifest {
            api_version: API_VERSION.into(),
            id: "org.example.messaging".into(),
            name: "Synthetic messaging".into(),
            version: "1.2.3".into(),
            license: "Apache-2.0".into(),
            homepage: "https://example.test/connectors/messaging".into(),
            repository: "https://example.test/source/messaging".into(),
            description: "Synthetic connector fixture".into(),
            auth_schemes: vec![AuthScheme {
                id: "oauth".into(),
                kind: AuthKind::Oauth2,
                scopes: vec!["messages.send".into()],
                credential_fields: vec![],
            }],
            triggers: vec![],
            actions: vec![ActionDefinition {
                id: "send_message".into(),
                title: "Send message".into(),
                description: "Synthetic reviewed send".into(),
                implementation: "messaging.send".into(),
                transport: ActionTransport::ProviderApi,
                auth_scheme: Some("oauth".into()),
                required_roles: vec!["owner".into()],
                required_scopes: vec!["messages.send".into()],
                phi: PhiClass::Identifiers,
                effect: ActionEffect::ExternalSend,
                approval: ApprovalPolicy::Staff,
                idempotency: IdempotencyClass::RequestKey,
                retry: RetryClass::Never,
                input: ObjectSchema {
                    fields: vec![FieldSchema {
                        id: "recipient".into(),
                        title: "Recipient".into(),
                        field_type: FieldType::String,
                        required: true,
                        phi: PhiClass::Identifiers,
                        enum_values: vec![],
                        fields: vec![],
                        items: vec![],
                    }],
                },
                output: ObjectSchema { fields: vec![] },
            }],
            lifecycle: Lifecycle {
                setup: true,
                deactivate: true,
                sample_events: true,
            },
        }
    }

    #[test]
    fn accepts_bounded_reviewed_manifest() {
        assert!(manifest().validate().is_ok());
    }
    #[test]
    fn rejects_external_send_without_review_or_with_retry() {
        let mut value = manifest();
        value.actions[0].approval = ApprovalPolicy::None;
        assert!(value.validate().is_err());
        let mut value = manifest();
        value.actions[0].retry = RetryClass::SafeIdempotent;
        assert!(value.validate().is_err());
    }
    #[test]
    fn rejects_unknown_fields_and_executable_payloads() {
        let mut value = serde_json::to_value(manifest()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("script".into(), json!("fetch('https://example.test')"));
        assert!(serde_json::from_value::<ConnectorManifest>(value).is_err());
    }
    #[test]
    fn rejects_non_open_license_and_untrusted_url() {
        let mut value = manifest();
        value.license = "Proprietary".into();
        assert!(value.validate().is_err());
        let mut value = manifest();
        value.repository = "http://example.test/source".into();
        assert!(value.validate().is_err());
    }
    #[test]
    fn rejects_schema_depth_and_unknown_auth() {
        let mut value = manifest();
        value.actions[0].auth_scheme = Some("missing".into());
        assert!(value.validate().is_err());
        let mut value = manifest();
        let mut field = value.actions[0].input.fields[0].clone();
        field.field_type = FieldType::Object;
        for _ in 0..6 {
            field = FieldSchema {
                id: "nested".into(),
                title: "Nested".into(),
                field_type: FieldType::Object,
                required: true,
                phi: PhiClass::None,
                enum_values: vec![],
                fields: vec![field],
                items: vec![],
            };
        }
        value.actions[0].input.fields = vec![field];
        assert!(value.validate().is_err());
    }
    #[test]
    fn requires_secret_api_keys_and_idempotency_for_safe_retry() {
        let mut value = manifest();
        value.auth_schemes = vec![AuthScheme {
            id: "key".into(),
            kind: AuthKind::ApiKey,
            scopes: vec![],
            credential_fields: vec![CredentialField {
                id: "account_key".into(),
                title: "Account key".into(),
                secret: false,
            }],
        }];
        value.actions[0].auth_scheme = Some("key".into());
        assert!(value.validate().is_err());

        let mut value = manifest();
        value.actions[0].effect = ActionEffect::Write;
        value.actions[0].retry = RetryClass::SafeIdempotent;
        value.actions[0].idempotency = IdempotencyClass::None;
        assert!(value.validate().is_err());
    }
    #[test]
    fn semantic_version_and_digest_are_strict() {
        assert!(semver("1.2.3-alpha+1"));
        assert!(!semver("01.2.3"));
        assert!(!semver("1.2"));
        assert!(digest(&"a".repeat(64)));
        assert!(!digest(&"z".repeat(64)));
    }

    #[test]
    fn automation_event_types_are_exact_and_namespaced() {
        assert!(automation_event_type("suncharts.appointment.created"));
        assert!(!automation_event_type("appointment.created"));
        assert!(!automation_event_type("suncharts.appointment.all"));
        assert!(!automation_event_type("suncharts..created"));
    }
}
