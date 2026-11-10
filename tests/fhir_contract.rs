// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries

use serde_json::Value;
use std::collections::BTreeSet;

#[test]
fn openapi_fhir_surface_matches_the_bounded_runtime_contract() {
    let spec: Value = serde_json::from_str(include_str!("../api/openapi.json")).unwrap();
    let paths = spec["paths"].as_object().unwrap();
    let description = paths["/fhir/metadata"]["get"]["description"]
        .as_str()
        .unwrap();

    assert!(description.contains("17 bounded native projections"));
    assert!(description.contains(
        "Patient, Condition, AllergyIntolerance, MedicationStatement, ServiceRequest and Immunization"
    ));
    assert!(!description.contains("Patient read/search only"));
    for unsupported_claim in [
        "No general HL7 v2",
        "US Core",
        "SMART App Launch",
        "Bulk Data",
        "certification assertion",
    ] {
        assert!(description.contains(unsupported_claim));
    }

    let expected_resources = BTreeSet::from([
        "AllergyIntolerance",
        "Appointment",
        "Binary",
        "Condition",
        "Coverage",
        "DiagnosticReport",
        "DocumentReference",
        "Encounter",
        "Immunization",
        "Location",
        "MedicationRequest",
        "MedicationStatement",
        "Observation",
        "Patient",
        "Practitioner",
        "ServiceRequest",
        "Specimen",
    ]);
    let advertised_resources = paths
        .keys()
        .filter_map(|path| {
            path.strip_prefix("/fhir/")
                .and_then(|tail| tail.split('/').next())
                .filter(|resource| *resource != "metadata")
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(advertised_resources, expected_resources);

    let writable = [
        "Patient",
        "Condition",
        "AllergyIntolerance",
        "MedicationStatement",
        "ServiceRequest",
        "Immunization",
    ];
    for resource in writable {
        let collection = &paths[&format!("/fhir/{resource}")];
        let item = &paths[&format!("/fhir/{resource}/{{id}}")];
        assert!(collection.get("get").is_some(), "{resource} search missing");
        assert!(
            collection.get("post").is_some(),
            "{resource} create missing"
        );
        assert!(item.get("get").is_some(), "{resource} read missing");
        assert!(item.get("put").is_some(), "{resource} update missing");
    }

    for resource in expected_resources
        .iter()
        .filter(|resource| !writable.contains(resource) && **resource != "Binary")
    {
        let collection = &paths[&format!("/fhir/{resource}")];
        let item = &paths[&format!("/fhir/{resource}/{{id}}")];
        assert!(collection.get("get").is_some(), "{resource} search missing");
        assert!(
            collection.get("post").is_none(),
            "{resource} must be read-only"
        );
        assert!(item.get("get").is_some(), "{resource} read missing");
        assert!(item.get("put").is_none(), "{resource} must be read-only");
    }

    assert!(paths.get("/fhir/Binary").is_none());
    assert!(paths["/fhir/Binary/{id}"].get("get").is_some());
    assert!(paths["/fhir/Binary/{id}"].get("put").is_none());
}
