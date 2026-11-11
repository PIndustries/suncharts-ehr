// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
pub mod access_policies;
pub mod action_governance;
pub mod ai_privacy;
pub mod ai_provider_adapter;
pub mod auth;
pub mod automation_event_runtime;
pub mod backend;
pub mod billing;
mod branding;
pub mod browser;
pub mod builtin_connectors;
pub mod ca277;
pub mod care_pathways;
pub mod checkout;
mod claim_cob;
pub mod claimmd;
pub mod claimmd_eligibility;
pub mod claimmd_extended;
pub mod claimmd_operations;
pub mod claims;
pub mod claude_adapter;
pub mod clearinghouse;
pub mod clinical;
pub mod connect_identity;
pub mod connect_onboarding;
pub mod connect_services;
pub mod connect_transport;
pub mod connect_updates;
pub mod connector_catalog;
pub mod copay_checkout;
pub mod delivery;
pub mod demographics;
pub mod documents;
pub mod era835;
pub mod era_batches;
pub mod era_chains;
pub mod era_file;
pub mod erebine_adapter;
pub mod error;
pub mod erx_setup;
pub mod events;
pub mod fees;
pub mod fhir;
pub mod gmail_referral_adapter;
pub mod health_history;
pub mod immunizations;
pub mod instance_integrations;
pub mod labs;
pub mod managed_connect;
pub mod migration;
pub mod model;
pub mod oauth;
pub mod office;
pub mod partner_scheduling;
pub mod partner_support;
pub mod patient_identity;
pub mod patient_lifecycle;
pub mod patient_portal;
pub mod payments;
pub mod postgres;
pub mod practice;
pub mod practice_admin;
pub mod prescribing;
pub mod previsit;
pub mod provider_settings;
pub mod recurrence;
pub mod referral_delivery;
pub mod referrals;
pub mod reminders;
pub mod remittance_automation;
pub mod retrieval;
pub mod ringcentral_adapter;
pub mod rooming;
pub mod scheduling;
pub mod settlements;
pub mod sftp_transport;
pub mod specialty_workspace;
pub mod stedi;
pub mod sun_tools;
pub mod terminology;
#[doc(hidden)]
pub mod test_db;
pub mod visit_diagnoses;
pub mod workflow_dispatcher;
pub mod workflow_evidence;
pub mod workflow_triggers;
pub mod x12;

use auth::Actor;
use axum::{
    extract::{DefaultBodyLimit, Path, State as ExtractState},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use backend::ClinicalBackend;
use error::{Error, Result};
use model::*;
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use uuid::Uuid;

#[derive(Clone)]
pub struct State {
    pub backend: Arc<dyn ClinicalBackend>,
    pub secret: String,
    pub allow_legacy_gateway: bool,
    pub issuer: String,
    pub audience: String,
    pub browser: Option<Arc<browser::BrowserAuth>>,
}
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

async fn readiness(ExtractState(state): ExtractState<State>) -> impl IntoResponse {
    let Some(auth) = state.browser.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "browser database unavailable",
        )
            .into_response();
    };
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&auth.db)
        .await
    {
        Ok(1) => (
            StatusCode::OK,
            Json(crate::managed_connect::readiness(&auth.db).await),
        )
            .into_response(),
        _ => (StatusCode::SERVICE_UNAVAILABLE, "database unavailable").into_response(),
    }
}

enum LoginPresentation {
    Local,
    Connect(String),
    Pending,
}

#[derive(Clone, Copy)]
enum DeploymentEnvironment {
    Development,
    Production,
}

impl DeploymentEnvironment {
    fn from_env() -> Self {
        match std::env::var("ENGINE_ENVIRONMENT").as_deref() {
            Ok("production") => Self::Production,
            _ => Self::Development,
        }
    }

    fn notice(self) -> &'static str {
        match self {
            Self::Development => "Development preview · Synthetic data only",
            Self::Production => "Production environment",
        }
    }

    fn short(self) -> &'static str {
        match self {
            Self::Development => "Synthetic data",
            Self::Production => "Production",
        }
    }
}

fn render_index(
    login: LoginPresentation,
    branding: &branding::InstanceBranding,
    environment: DeploymentEnvironment,
) -> String {
    let (local_visibility, connect_visibility, connect_url, description, state_visibility) =
        match login {
            LoginPresentation::Local => (
                "",
                "hidden",
                "#".to_owned(),
                "Sign in to your self-hosted SunCharts EHR.",
                "hidden",
            ),
            LoginPresentation::Connect(url) => (
                "hidden",
                "",
                url,
                "Use your SunCharts Connect passkey or emailed sign-in link.",
                "",
            ),
            LoginPresentation::Pending => (
                "hidden",
                "hidden",
                "#".to_owned(),
                "Checking your sign-in options…",
                "",
            ),
        };
    web_content("index.html", include_str!("../web/index.html"))
        .replace("__CLINIC_LOGIN_BRAND__", &branding.login_html())
        .replace("__CLINIC_SIDEBAR_IDENTITY__", &branding.sidebar_html())
        // Branding HTML can contain the build placeholder, so expand branding before the
        // final build substitution. This keeps every visible build label consistent.
        .replace("__SUN_CHARTS_BUILD__", env!("SUN_CHARTS_BUILD"))
        .replace("__LOCAL_LOGIN_VISIBILITY__", local_visibility)
        .replace("__CONNECT_LOGIN_VISIBILITY__", connect_visibility)
        .replace("__CONNECT_LOGIN_URL__", &connect_url)
        .replace("__LOGIN_DESCRIPTION__", description)
        .replace("__CONNECT_STATE_VISIBILITY__", state_visibility)
        .replace("__ENVIRONMENT_NOTICE__", environment.notice())
        .replace("__ENVIRONMENT_SHORT__", environment.short())
}

async fn index(ExtractState(state): ExtractState<State>) -> axum::response::Html<String> {
    let login = match state.browser.as_ref() {
        Some(auth) => match connect_identity::connected(&auth.db).await {
            Ok(false) => LoginPresentation::Local,
            Ok(true) => match connect_identity::staff_sign_in_url(auth.origin()) {
                Ok(url) => LoginPresentation::Connect(url),
                Err(_) => LoginPresentation::Pending,
            },
            Err(_) => LoginPresentation::Pending,
        },
        None => LoginPresentation::Pending,
    };
    axum::response::Html(render_index(
        login,
        &branding::InstanceBranding::from_env(),
        DeploymentEnvironment::from_env(),
    ))
}

fn web_content(name: &'static str, embedded: &'static str) -> String {
    if matches!(
        DeploymentEnvironment::from_env(),
        DeploymentEnvironment::Production
    ) {
        return embedded.to_owned();
    }
    std::env::var("ENGINE_WEB_ROOT")
        .ok()
        .and_then(|root| std::fs::read_to_string(PathBuf::from(root).join(name)).ok())
        .unwrap_or_else(|| embedded.to_owned())
}

fn web_asset(name: &'static str, content_type: &'static str, embedded: &'static str) -> Response {
    let body = web_content(name, embedded);
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod login_presentation_tests {
    use super::{
        branding::InstanceBranding, render_index, DeploymentEnvironment, LoginPresentation,
    };

    #[test]
    fn connected_first_paint_contains_only_connect_sign_in() {
        let html = render_index(
            LoginPresentation::Connect(
                "https://connect.suncharts.app/ehr/launch?audience=https%3A%2F%2Fclinic.example"
                    .to_owned(),
            ),
            &InstanceBranding::default(),
            DeploymentEnvironment::Development,
        );
        assert!(html.contains("id=\"local-login-fields\" hidden"));
        assert!(html.contains(
            "id=\"connect-login\" class=\"primary\" href=\"https://connect.suncharts.app/ehr/launch?audience=https%3A%2F%2Fclinic.example\" >"
        ));
        assert!(html.contains("class=\"login-panel\""));
        assert!(html.contains("class=\"login-connection\""));
        assert!(html.contains("Open the patient portal"));
        assert!(html.contains("Secure organizational access"));
        assert!(!html.contains("__CONNECT_LOGIN_"));
        assert!(!html.contains("__LOCAL_LOGIN_"));
    }

    #[test]
    fn unresolved_first_paint_does_not_expose_local_credentials() {
        let html = render_index(
            LoginPresentation::Pending,
            &InstanceBranding::default(),
            DeploymentEnvironment::Development,
        );
        assert!(html.contains("id=\"local-login-fields\" hidden"));
        assert!(html.contains("id=\"connect-login\" class=\"primary\" href=\"#\" hidden"));
        assert!(html.contains("Checking your sign-in options…"));
    }

    #[test]
    fn managed_brand_is_present_on_login_and_sidebar() {
        let html = render_index(
            LoginPresentation::Pending,
            &InstanceBranding {
                display_name: "Synthetic Specialty Clinic".into(),
                logo_url: Some("https://connect.suncharts.app/api/v1/managed-ehr/branding/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into()),
                managed: true,
            },
            DeploymentEnvironment::Development,
        );
        assert!(html.contains("Synthetic Specialty Clinic"));
        assert!(html.contains(&format!("Build {}", env!("SUN_CHARTS_BUILD"))));
        assert_eq!(html.matches("/managed-ehr/branding/assets/").count(), 2);
        assert!(!html.contains("__CLINIC_"));
        assert!(!html.contains("__SUN_CHARTS_BUILD__"));
        assert!(!html.contains("identity-preview"));
    }

    #[test]
    fn production_first_paint_has_no_synthetic_or_development_labels() {
        let html = render_index(
            LoginPresentation::Pending,
            &InstanceBranding::default(),
            DeploymentEnvironment::Production,
        );
        assert!(html.contains("Production environment"));
        assert!(html.contains("class=\"shell-environment\">Production</span>"));
        assert!(!html.contains("Synthetic data"));
        assert!(!html.contains("Development preview"));
        assert!(!html.contains("__ENVIRONMENT_"));
    }
}

pub fn app(state: State) -> Router {
    Router::new()
        .merge(access_policies::router())
        .merge(action_governance::router())
        .merge(automation_event_runtime::router())
        .merge(oauth::router())
        .merge(clinical::router())
        .merge(health_history::routes())
        .merge(immunizations::routes())
        .merge(instance_integrations::router())
        .merge(gmail_referral_adapter::router())
        .merge(ringcentral_adapter::router())
        .merge(documents::routes())
        .merge(office::router())
        .merge(referrals::routes())
        .merge(referral_delivery::routes())
        .merge(patient_identity::routes())
        .merge(patient_lifecycle::routes())
        .merge(fees::routes())
        .merge(patient_portal::router())
        .merge(prescribing::router())
        .merge(erx_setup::router())
        .merge(labs::router())
        .merge(scheduling::router())
        .merge(recurrence::router())
        .merge(reminders::router())
        .merge(connect_services::router())
        .merge(connect_updates::router())
        .merge(connect_onboarding::router())
        .merge(connector_catalog::router())
        .merge(practice::router())
        .merge(practice_admin::router())
        .merge(previsit::router())
        .merge(partner_scheduling::router())
        .merge(specialty_workspace::router())
        .merge(rooming::routes())
        .merge(visit_diagnoses::routes())
        .merge(terminology::router())
        .merge(demographics::router())
        .merge(billing::router())
        .merge(claimmd_eligibility::router())
        .merge(care_pathways::routes())
        .merge(payments::router())
        .merge(copay_checkout::router())
        .merge(claims::router())
        .merge(checkout::router())
        .merge(era_batches::router())
        .merge(era_chains::router())
        .merge(settlements::router())
        .merge(clearinghouse::router())
        .merge(delivery::router())
        .merge(provider_settings::router())
        .merge(claimmd_operations::router())
        .merge(claude_adapter::router())
        .merge(sun_tools::router())
        .merge(workflow_dispatcher::router())
        .merge(workflow_evidence::router())
        .merge(claimmd_extended::router())
        .merge(retrieval::router())
        .merge(remittance_automation::router())
        .merge(ca277::router())
        .merge(events::router())
        .merge(migration::router())
        .merge(fhir::router())
        .route("/", get(index))
        .route(
            "/api/v1/connect/support/accept",
            get(index).post(partner_support::accept),
        )
        .route(
            "/connect-onboarding.js",
            get(|| async {
                web_asset(
                    "connect-onboarding.js",
                    "text/javascript; charset=utf-8",
                    include_str!("../web/connect-onboarding.js"),
                )
            }),
        )
        .route(
            "/connect-services.js",
            get(|| async {
                web_asset(
                    "connect-services.js",
                    "text/javascript; charset=utf-8",
                    include_str!("../web/connect-services.js"),
                )
            }),
        )
        .route(
            "/appointment-workflows.js",
            get(|| async {
                web_asset(
                    "appointment-workflows.js",
                    "text/javascript; charset=utf-8",
                    include_str!("../web/appointment-workflows.js"),
                )
            }),
        )
        .route(
            "/payments.js",
            get(|| async {
                web_asset(
                    "payments.js",
                    "application/javascript",
                    include_str!("../web/payments.js"),
                )
            }),
        )
        .route(
            "/avs-print.css",
            get(|| async {
                web_asset(
                    "avs-print.css",
                    "text/css",
                    include_str!("../web/avs-print.css"),
                )
            }),
        )
        .route(
            "/checkout.js",
            get(|| async {
                web_asset(
                    "checkout.js",
                    "application/javascript",
                    include_str!("../web/checkout.js"),
                )
            }),
        )
        .route(
            "/erx-setup.js",
            get(|| async {
                web_asset(
                    "erx-setup.js",
                    "application/javascript",
                    include_str!("../web/erx-setup.js"),
                )
            }),
        )
        .route(
            "/prescribing.js",
            get(|| async {
                web_asset(
                    "prescribing.js",
                    "application/javascript",
                    include_str!("../web/prescribing.js"),
                )
            }),
        )
        .route(
            "/portal-staff.js",
            get(|| async {
                web_asset(
                    "portal-staff.js",
                    "application/javascript",
                    include_str!("../web/portal-staff.js"),
                )
            }),
        )
        .route(
            "/patient-portal",
            get(|| async {
                web_asset(
                    "patient-portal.html",
                    "text/html; charset=utf-8",
                    include_str!("../web/patient-portal.html"),
                )
            }),
        )
        .route(
            "/patient-portal.js",
            get(|| async {
                web_asset(
                    "patient-portal.js",
                    "application/javascript",
                    include_str!("../web/patient-portal.js"),
                )
            }),
        )
        .route(
            "/patient-portal.css",
            get(|| async {
                web_asset(
                    "patient-portal.css",
                    "text/css",
                    include_str!("../web/patient-portal.css"),
                )
            }),
        )
        .route(
            "/dialog.js",
            get(|| async {
                web_asset(
                    "dialog.js",
                    "application/javascript",
                    include_str!("../web/dialog.js"),
                )
            }),
        )
        .route(
            "/app.js",
            get(|| async {
                web_asset(
                    "app.js",
                    "application/javascript",
                    include_str!("../web/app.js"),
                )
            }),
        )
        .route(
            "/shell.js",
            get(|| async {
                web_asset(
                    "shell.js",
                    "application/javascript",
                    include_str!("../web/shell.js"),
                )
            }),
        )
        .route(
            "/demographics.js",
            get(|| async {
                web_asset(
                    "demographics.js",
                    "application/javascript",
                    include_str!("../web/demographics.js"),
                )
            }),
        )
        .route(
            "/fees.js",
            get(|| async {
                web_asset(
                    "fees.js",
                    "application/javascript",
                    include_str!("../web/fees.js"),
                )
            }),
        )
        .route(
            "/practice-admin.js",
            get(|| async {
                web_asset(
                    "practice-admin.js",
                    "application/javascript",
                    include_str!("../web/practice-admin.js"),
                )
            }),
        )
        .route(
            "/specialty-workspace.js",
            get(|| async {
                web_asset(
                    "specialty-workspace.js",
                    "application/javascript",
                    include_str!("../web/specialty-workspace.js"),
                )
            }),
        )
        .route(
            "/care-pathways.js",
            get(|| async {
                web_asset(
                    "care-pathways.js",
                    "application/javascript",
                    include_str!("../web/care-pathways.js"),
                )
            }),
        )
        .route(
            "/live-events.js",
            get(|| async {
                web_asset(
                    "live-events.js",
                    "application/javascript",
                    include_str!("../web/live-events.js"),
                )
            }),
        )
        .route(
            "/workflow-editor.js",
            get(|| async {
                web_asset(
                    "workflow-editor.js",
                    "application/javascript",
                    include_str!("../web/workflow-editor.js"),
                )
            }),
        )
        .route(
            "/workflow-editor.LICENSE.txt",
            get(|| async {
                web_asset(
                    "workflow-editor.LICENSE.txt",
                    "text/plain",
                    include_str!("../web/workflow-editor.LICENSE.txt"),
                )
            }),
        )
        .route(
            "/workflow-studio.js",
            get(|| async {
                web_asset(
                    "workflow-studio.js",
                    "application/javascript",
                    include_str!("../web/workflow-studio.js"),
                )
            }),
        )
        .route(
            "/workflow-preparation.js",
            get(|| async {
                web_asset(
                    "workflow-preparation.js",
                    "application/javascript",
                    include_str!("../web/workflow-preparation.js"),
                )
            }),
        )
        .route(
            "/automation-center.js",
            get(|| async {
                web_asset(
                    "automation-center.js",
                    "application/javascript",
                    include_str!("../web/automation-center.js"),
                )
            }),
        )
        .route(
            "/integrations.js",
            get(|| async {
                web_asset(
                    "integrations.js",
                    "application/javascript",
                    include_str!("../web/integrations.js"),
                )
            }),
        )
        .route(
            "/sun-events.js",
            get(|| async {
                web_asset(
                    "sun-events.js",
                    "application/javascript",
                    include_str!("../web/sun-events.js"),
                )
            }),
        )
        .route(
            "/sun-orb.js",
            get(|| async {
                web_asset(
                    "sun-orb.js",
                    "application/javascript",
                    include_str!("../web/sun-orb.js"),
                )
            }),
        )
        .route(
            "/sun-orb.css",
            get(|| async {
                web_asset(
                    "sun-orb.css",
                    "text/css",
                    include_str!("../web/sun-orb.css"),
                )
            }),
        )
        .route(
            "/sun-workflow.js",
            get(|| async {
                web_asset(
                    "sun-workflow.js",
                    "application/javascript",
                    include_str!("../web/sun-workflow.js"),
                )
            }),
        )
        .route(
            "/workflow-communications.js",
            get(|| async {
                web_asset(
                    "workflow-communications.js",
                    "application/javascript",
                    include_str!("../web/workflow-communications.js"),
                )
            }),
        )
        .route(
            "/workflow-access.js",
            get(|| async {
                web_asset(
                    "workflow-access.js",
                    "application/javascript",
                    include_str!("../web/workflow-access.js"),
                )
            }),
        )
        .route(
            "/workflow-journey.css",
            get(|| async {
                web_asset(
                    "workflow-journey.css",
                    "text/css",
                    include_str!("../web/workflow-journey.css"),
                )
            }),
        )
        .route(
            "/workflow-workspace.css",
            get(|| async {
                web_asset(
                    "workflow-workspace.css",
                    "text/css",
                    include_str!("../web/workflow-workspace.css"),
                )
            }),
        )
        .route(
            "/sun.js",
            get(|| async {
                web_asset(
                    "sun.js",
                    "application/javascript",
                    include_str!("../web/sun.js"),
                )
            }),
        )
        .route(
            "/theme.js",
            get(|| async {
                web_asset(
                    "theme.js",
                    "application/javascript",
                    include_str!("../web/theme.js"),
                )
            }),
        )
        .route(
            "/theme.css",
            get(|| async { web_asset("theme.css", "text/css", include_str!("../web/theme.css")) }),
        )
        .route(
            "/terminology.js",
            get(|| async {
                web_asset(
                    "terminology.js",
                    "application/javascript",
                    include_str!("../web/terminology.js"),
                )
            }),
        )
        .route(
            "/sun.css",
            get(|| async { web_asset("sun.css", "text/css", include_str!("../web/sun.css")) }),
        )
        .route(
            "/patient-lifecycle.js",
            get(|| async {
                web_asset(
                    "patient-lifecycle.js",
                    "text/javascript; charset=utf-8",
                    include_str!("../web/patient-lifecycle.js"),
                )
            }),
        )
        .route(
            "/patient-identity.js",
            get(|| async {
                web_asset(
                    "patient-identity.js",
                    "application/javascript",
                    include_str!("../web/patient-identity.js"),
                )
            }),
        )
        .route(
            "/referral-delivery.js",
            get(|| async {
                web_asset(
                    "referral-delivery.js",
                    "application/javascript",
                    include_str!("../web/referral-delivery.js"),
                )
            }),
        )
        .route(
            "/connect-updates.js",
            get(|| async {
                web_asset(
                    "connect-updates.js",
                    "application/javascript",
                    include_str!("../web/connect-updates.js"),
                )
            }),
        )
        .route(
            "/document-files.js",
            get(|| async {
                web_asset(
                    "document-files.js",
                    "application/javascript",
                    include_str!("../web/document-files.js"),
                )
            }),
        )
        .route(
            "/terminology-autocomplete.css",
            get(|| async {
                web_asset(
                    "terminology-autocomplete.css",
                    "text/css",
                    include_str!("../web/terminology-autocomplete.css"),
                )
            }),
        )
        .route(
            "/encounter-navigation.css",
            get(|| async {
                web_asset(
                    "encounter-navigation.css",
                    "text/css",
                    include_str!("../web/encounter-navigation.css"),
                )
            }),
        )
        .route(
            "/document-files-groups.css",
            get(|| async {
                web_asset(
                    "document-files-groups.css",
                    "text/css",
                    include_str!("../web/document-files-groups.css"),
                )
            }),
        )
        .route(
            "/claim-workflow.css",
            get(|| async {
                web_asset(
                    "claim-workflow.css",
                    "text/css",
                    include_str!("../web/claim-workflow.css"),
                )
            }),
        )
        .route(
            "/document-files.css",
            get(|| async {
                web_asset(
                    "document-files.css",
                    "text/css",
                    include_str!("../web/document-files.css"),
                )
            }),
        )
        .route(
            "/vendor/pdfjs/pdf.mjs",
            get(|| async {
                web_asset(
                    "vendor/pdfjs/pdf.mjs",
                    "application/javascript",
                    include_str!("../web/vendor/pdfjs/pdf.mjs"),
                )
            }),
        )
        .route(
            "/vendor/pdfjs/pdf.worker.mjs",
            get(|| async {
                web_asset(
                    "vendor/pdfjs/pdf.worker.mjs",
                    "application/javascript",
                    include_str!("../web/vendor/pdfjs/pdf.worker.mjs"),
                )
            }),
        )
        .route(
            "/document-office.js",
            get(|| async {
                web_asset(
                    "document-office.js",
                    "application/javascript",
                    include_str!("../web/document-office.js"),
                )
            }),
        )
        .route(
            "/documents.js",
            get(|| async {
                web_asset(
                    "documents.js",
                    "application/javascript",
                    include_str!("../web/documents.js"),
                )
            }),
        )
        .route(
            "/referrals.js",
            get(|| async {
                web_asset(
                    "referrals.js",
                    "application/javascript",
                    include_str!("../web/referrals.js"),
                )
            }),
        )
        .route(
            "/immunizations.js",
            get(|| async {
                web_asset(
                    "immunizations.js",
                    "application/javascript",
                    include_str!("../web/immunizations.js"),
                )
            }),
        )
        .route(
            "/health-history.js",
            get(|| async {
                web_asset(
                    "health-history.js",
                    "application/javascript",
                    include_str!("../web/health-history.js"),
                )
            }),
        )
        .route(
            "/visit-diagnoses.js",
            get(|| async {
                web_asset(
                    "visit-diagnoses.js",
                    "application/javascript",
                    include_str!("../web/visit-diagnoses.js"),
                )
            }),
        )
        .route(
            "/rooming.js",
            get(|| async {
                web_asset(
                    "rooming.js",
                    "application/javascript",
                    include_str!("../web/rooming.js"),
                )
            }),
        )
        .route(
            "/practice.js",
            get(|| async {
                web_asset(
                    "practice.js",
                    "application/javascript",
                    include_str!("../web/practice.js"),
                )
            }),
        )
        .route(
            "/style.css",
            get(|| async { web_asset("style.css", "text/css", include_str!("../web/style.css")) }),
        )
        .route(
            "/navigation-history.js",
            get(|| async {
                web_asset(
                    "navigation-history.js",
                    "application/javascript",
                    include_str!("../web/navigation-history.js"),
                )
            }),
        )
        .route(
            "/patient-print.css",
            get(|| async {
                web_asset(
                    "patient-print.css",
                    "text/css",
                    include_str!("../web/patient-print.css"),
                )
            }),
        )
        .route(
            "/cms1500.css",
            get(|| async {
                web_asset(
                    "cms1500.css",
                    "text/css",
                    include_str!("../web/cms1500.css"),
                )
            }),
        )
        .route(
            "/cms1500.js",
            get(|| async {
                web_asset(
                    "cms1500.js",
                    "application/javascript",
                    include_str!("../web/cms1500.js"),
                )
            }),
        )
        .route(
            "/clinical.js",
            get(|| async {
                web_asset(
                    "clinical.js",
                    "application/javascript",
                    include_str!("../web/clinical.js"),
                )
            }),
        )
        .route(
            "/labs.js",
            get(|| async {
                web_asset(
                    "labs.js",
                    "application/javascript",
                    include_str!("../web/labs.js"),
                )
            }),
        )
        .route(
            "/scheduling.js",
            get(|| async {
                web_asset(
                    "scheduling.js",
                    "application/javascript",
                    include_str!("../web/scheduling.js"),
                )
            }),
        )
        .route(
            "/billing.js",
            get(|| async {
                web_asset(
                    "billing.js",
                    "application/javascript",
                    include_str!("../web/billing.js"),
                )
            }),
        )
        .route(
            "/patient-revenue.js",
            get(|| async {
                web_asset(
                    "patient-revenue.js",
                    "application/javascript",
                    include_str!("../web/patient-revenue.js"),
                )
            }),
        )
        .route(
            "/encounter-start.js",
            get(|| async {
                web_asset(
                    "encounter-start.js",
                    "application/javascript",
                    include_str!("../web/encounter-start.js"),
                )
            }),
        )
        .route(
            "/claimmd-eligibility.js",
            get(|| async {
                web_asset(
                    "claimmd-eligibility.js",
                    "application/javascript",
                    include_str!("../web/claimmd-eligibility.js"),
                )
            }),
        )
        .route(
            "/era-batches.js",
            get(|| async {
                web_asset(
                    "era-batches.js",
                    "application/javascript",
                    include_str!("../web/era-batches.js"),
                )
            }),
        )
        .route(
            "/settlements.js",
            get(|| async {
                web_asset(
                    "settlements.js",
                    "application/javascript",
                    include_str!("../web/settlements.js"),
                )
            }),
        )
        .route(
            "/retrieval.js",
            get(|| async {
                web_asset(
                    "retrieval.js",
                    "application/javascript",
                    include_str!("../web/retrieval.js"),
                )
            }),
        )
        .route(
            "/provider-settings.js",
            get(|| async {
                web_asset(
                    "provider-settings.js",
                    "application/javascript",
                    include_str!("../web/provider-settings.js"),
                )
            }),
        )
        .route(
            "/claimmd-native.js",
            get(|| async {
                web_asset(
                    "claimmd-native.js",
                    "application/javascript",
                    include_str!("../web/claimmd-native.js"),
                )
            }),
        )
        .route(
            "/claimmd-operations.js",
            get(|| async {
                web_asset(
                    "claimmd-operations.js",
                    "application/javascript",
                    include_str!("../web/claimmd-operations.js"),
                )
            }),
        )
        .route(
            "/claimmd-extended.js",
            get(|| async {
                web_asset(
                    "claimmd-extended.js",
                    "application/javascript",
                    include_str!("../web/claimmd-extended.js"),
                )
            }),
        )
        .route(
            "/delivery.js",
            get(|| async {
                web_asset(
                    "delivery.js",
                    "application/javascript",
                    include_str!("../web/delivery.js"),
                )
            }),
        )
        .route(
            "/clearinghouse.js",
            get(|| async {
                web_asset(
                    "clearinghouse.js",
                    "application/javascript",
                    include_str!("../web/clearinghouse.js"),
                )
            }),
        )
        .route(
            "/claims.js",
            get(|| async {
                web_asset(
                    "claims.js",
                    "application/javascript",
                    include_str!("../web/claims.js"),
                )
            }),
        )
        .route("/auth/login", post(browser::login))
        .route("/auth/recovery/login", post(browser::recovery_login))
        .route("/auth/mode", get(connect_identity::mode))
        .route(
            "/api/v1/connect/identity/accept",
            get(index).post(connect_identity::accept),
        )
        .route("/auth/logout", post(browser::logout))
        .route("/auth/me", get(browser::me))
        .route("/health", get(|| async { "ok" }))
        .route("/ready", get(readiness))
        .route(
            "/version",
            get(|| async {
                let release: serde_json::Value =
                    serde_json::from_str(include_str!("../deploy/release-metadata.json"))
                        .expect("release metadata must be valid JSON");
                Json(json!({"build": env!("SUN_CHARTS_BUILD"), "release": release}))
            }),
        )
        .route(
            "/source",
            get(|| async {
                (
                    [
                        (header::CONTENT_TYPE, "application/gzip"),
                        (
                            header::CONTENT_DISPOSITION,
                            "attachment; filename=suncharts-ehr-source.tar.gz",
                        ),
                    ],
                    include_bytes!(concat!(env!("OUT_DIR"), "/source.tar.gz")).as_slice(),
                )
            }),
        )
        .route(
            "/openapi.json",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    include_str!("../api/openapi.json"),
                )
            }),
        )
        .route("/api/v1/patients", post(create_patient).get(patients))
        .route("/api/v1/patients/{id}/workspace", get(workspace))
        .route("/api/v1/patients/{id}", get(patient))
        .route("/api/v1/patients/{id}/record", get(record))
        .route("/api/v1/appointments", post(book))
        .route("/api/v1/appointments/{id}/check-in", post(check_in))
        .route("/api/v1/visits", post(start_visit))
        .route("/api/v1/visits/{id}", get(visit))
        .route("/api/v1/visits/{id}/note", put(note))
        .route("/api/v1/visits/{id}/vitals", put(vitals))
        .route("/api/v1/visits/{id}/sign", post(sign))
        .route("/api/v1/visits/{id}/amendments", post(amend))
        .route("/api/v1/portal/record", get(portal))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            access_policies::enforce,
        ))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), headers))
        .with_state(state)
}

async fn headers(
    ExtractState(state): ExtractState<State>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    let mut r = next.run(req).await;
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    let mut policy = branding::InstanceBranding::from_env().content_security_policy();
    if let Some(origin) = office::configured_origin(&state) {
        policy = policy
            .replace("script-src 'self'", &format!("script-src 'self' {origin}"))
            .replace(
                "connect-src 'self'",
                &format!("connect-src 'self' {origin}"),
            );
        policy.push_str(&format!("; frame-src 'self' {origin}"));
    }
    if !r.headers().contains_key(header::CONTENT_SECURITY_POLICY) {
        if let Ok(value) = HeaderValue::from_str(&policy) {
            r.headers_mut()
                .insert(header::CONTENT_SECURITY_POLICY, value);
        }
    }
    r.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    r.headers_mut().insert(
        header::LINK,
        HeaderValue::from_static(
            "</source>; rel=\"describedby\"; title=\"Corresponding Source (AGPL-3.0-only)\"",
        ),
    );
    r
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PatientQuery {
    after: Option<Uuid>,
    #[serde(default)]
    status: patient_lifecycle::PatientStatus,
}
async fn patients(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    axum::extract::Query(q): axum::extract::Query<PatientQuery>,
) -> Result<Json<PatientPage>> {
    Ok(Json(s.backend.patients(&a, q.after, q.status).await?))
}
async fn workspace(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Workspace>> {
    Ok(Json(s.backend.workspace(&a, id).await?))
}

fn expected(h: &HeaderMap) -> Result<i64> {
    let raw = h
        .get(header::IF_MATCH)
        .ok_or(Error::VersionRequired)?
        .to_str()
        .map_err(|_| Error::Invalid("invalid If-Match"))?;
    let v = raw
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .ok_or(Error::Invalid("If-Match must be a quoted record version"))?
        .parse::<i64>()
        .map_err(|_| Error::Invalid("invalid record version"))?;
    if v < 1 {
        return Err(Error::Invalid("invalid record version"));
    }
    Ok(v)
}
fn visit_response(v: Visit) -> Response {
    ([(header::ETAG, format!("\"{}\"", v.version))], Json(v)).into_response()
}

async fn create_patient(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(p): Json<NewPatient>,
) -> Result<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(s.backend.create_patient(&a, p).await?),
    ))
}
async fn patient(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Patient>> {
    Ok(Json(s.backend.patient(&a, id).await?))
}
async fn book(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(p): Json<NewAppointment>,
) -> Result<impl IntoResponse> {
    if let Some(browser) = &s.browser {
        scheduling::provider(&browser.db, &a, p.clinician_id).await?;
    }
    Ok((StatusCode::CREATED, Json(s.backend.book(&a, p).await?)))
}
async fn check_in(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Appointment>> {
    Ok(Json(s.backend.check_in(&a, id).await?))
}
async fn start_visit(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(p): Json<StartVisit>,
) -> Result<Response> {
    let mut r = visit_response(s.backend.start_visit(&a, p).await?);
    *r.status_mut() = StatusCode::CREATED;
    Ok(r)
}
async fn visit(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    Ok(visit_response(s.backend.visit(&a, id).await?))
}
async fn note(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(p): Json<SoapNote>,
) -> Result<Response> {
    Ok(visit_response(
        s.backend.save_note(&a, id, expected(&h)?, p).await?,
    ))
}
async fn vitals(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(p): Json<Vitals>,
) -> Result<Response> {
    Ok(visit_response(
        s.backend.save_vitals(&a, id, expected(&h)?, p).await?,
    ))
}
async fn sign(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Response> {
    Ok(visit_response(s.backend.sign(&a, id, expected(&h)?).await?))
}
async fn amend(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(p): Json<NewAmendment>,
) -> Result<Response> {
    Ok(visit_response(
        s.backend.amend(&a, id, expected(&h)?, p).await?,
    ))
}
async fn record(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Record>> {
    a.staff()?;
    Ok(Json(s.backend.record(&a, id).await?))
}
async fn portal(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Record>> {
    if !matches!(a.role, auth::Role::Patient) {
        return Err(Error::Forbidden);
    }
    Ok(Json(
        s.backend
            .record(&a, a.patient_id.ok_or(Error::Forbidden)?)
            .await?,
    ))
}
