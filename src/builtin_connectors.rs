// SPDX-License-Identifier: AGPL-3.0-only
//! Reviewed connector manifests compiled into SunCharts EHR.

use crate::connector_catalog::ConnectorManifest;
use serde_json::json;

const NATIVE_CONNECTOR_ID: &str = "suncharts.native";

fn native_manifest() -> ConnectorManifest {
    let event_reference = json!({"fields":[
        {"id":"event_type","title":"Event type","field_type":"string","required":true,"phi":"none"},
        {"id":"event_id","title":"Event identifier","field_type":"uuid","required":true,"phi":"identifiers"}
    ]});
    let envelope = json!({"fields":[
        {"id":"event_type","title":"Event type","field_type":"string","required":true,"phi":"none"},
        {"id":"event_id","title":"Event identifier","field_type":"uuid","required":true,"phi":"identifiers"},
        {"id":"patient_id","title":"Patient identifier","field_type":"uuid","required":true,"phi":"identifiers"},
        {"id":"status","title":"Record status","field_type":"string","required":true,"phi":"none"},
        {"id":"version","title":"Record version","field_type":"integer","required":true,"phi":"none"},
        {"id":"appointment_id","title":"Appointment identifier","field_type":"uuid","required":false,"phi":"identifiers"},
        {"id":"referral_id","title":"Referral identifier","field_type":"uuid","required":false,"phi":"identifiers"},
        {"id":"clinician_id","title":"Clinician identifier","field_type":"uuid","required":false,"phi":"identifiers"},
        {"id":"visit_id","title":"Visit identifier","field_type":"uuid","required":false,"phi":"identifiers"},
        {"id":"starts_at","title":"Starts at","field_type":"date_time","required":false,"phi":"limited"},
        {"id":"ends_at","title":"Ends at","field_type":"date_time","required":false,"phi":"limited"}
    ]});
    let workflow_result = json!({"fields":[
        {"id":"instance_count","title":"Started pathway count","field_type":"integer","required":true,"phi":"none"},
        {"id":"instance_ids","title":"Started pathway identifiers","field_type":"array","required":true,"phi":"identifiers","items":[
            {"id":"value","title":"Pathway identifier","field_type":"uuid","required":true,"phi":"identifiers"}
        ]}
    ]});
    let trigger = |id: &str, title: &str, event_type: &str| {
        json!({
            "id":id,
            "title":title,
            "description":"Starts a reviewed native workflow from an exact committed EHR event.",
            "event_type":event_type,
            "transport":"internal_event",
            "dispatch_action":"workflow.start",
            "auth_scheme":null,
            "required_roles":["owner","clinician","nurse","medical_assistant","front_desk"],
            "required_scopes":[],
            "phi":"identifiers",
            "output":envelope.clone()
        })
    };
    serde_json::from_value(json!({
        "api_version":"suncharts.dev/connector/v1",
        "id":NATIVE_CONNECTOR_ID,
        "name":"SunCharts native workflows",
        "version":"0.1.0",
        "license":"AGPL-3.0-only",
        "homepage":"https://suncharts.app/",
        "repository":"https://github.com/PIndustries/suncharts-ehr",
        "description":"Exact native EHR events and idempotent workflow starts compiled into SunCharts EHR.",
        "auth_schemes":[],
        "triggers":[
            trigger("appointment.created","Appointment created","suncharts.appointment.created"),
            trigger("appointment.rescheduled","Appointment rescheduled","suncharts.appointment.rescheduled"),
            trigger("appointment.cancelled","Appointment cancelled","suncharts.appointment.cancelled"),
            trigger("referral.created","Referral created","suncharts.referral.created"),
            trigger("referral.status_changed","Referral status changed","suncharts.referral.status_changed")
        ],
        "actions":[{
            "id":"workflow.start",
            "title":"Start published workflow",
            "description":"Starts the matching published care pathway once for this native event.",
            "implementation":"suncharts.workflow.start",
            "transport":"native",
            "auth_scheme":null,
            "required_roles":["owner","clinician","nurse","medical_assistant","front_desk"],
            "required_scopes":[],
            "phi":"identifiers",
            "effect":"write",
            "approval":"none",
            "idempotency":"natural_key",
            "retry":"safe_idempotent",
            "input":event_reference,
            "output":workflow_result
        }],
        "lifecycle":{"setup":false,"deactivate":true,"sample_events":true}
    }))
    .expect("built-in native connector manifest must deserialize")
}

pub fn manifests() -> Vec<ConnectorManifest> {
    vec![native_manifest()]
}

pub fn manifest(connector_id: &str) -> Option<ConnectorManifest> {
    manifests()
        .into_iter()
        .find(|candidate| candidate.id == connector_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_manifests_are_valid_and_non_secret() {
        let manifests = manifests();
        assert_eq!(manifests.len(), 1);
        for manifest in manifests {
            manifest.validate().expect("valid built-in manifest");
            assert!(manifest.auth_schemes.is_empty());
            assert!(manifest
                .actions
                .iter()
                .all(|action| action.implementation.starts_with("suncharts.")));
        }
    }

    #[test]
    fn native_triggers_dispatch_only_to_workflow_start() {
        let manifest = manifest(NATIVE_CONNECTOR_ID).expect("native connector");
        assert_eq!(manifest.triggers.len(), 5);
        assert!(manifest
            .triggers
            .iter()
            .all(|trigger| trigger.event_type.starts_with("suncharts.")));
        assert!(manifest
            .triggers
            .iter()
            .all(|trigger| trigger.dispatch_action.as_deref() == Some("workflow.start")));
        assert_eq!(manifest.actions.len(), 1);
        assert_eq!(manifest.actions[0].id, "workflow.start");
    }
}
