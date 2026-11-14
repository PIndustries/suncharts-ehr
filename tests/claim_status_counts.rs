// SPDX-License-Identifier: AGPL-3.0-only
//! The published contract for the claims status counts used by the claims list chips.
use serde_json::{json, Value};

#[test]
fn the_contract_lists_the_claim_status_counts_endpoint() {
    let spec: Value = serde_json::from_str(include_str!("../api/openapi.json")).unwrap();
    let operation = &spec["paths"]["/api/v1/billing/claims/status-counts"]["get"];
    assert_eq!(operation["operationId"], "claimStatusCounts");
    assert!(
        operation["parameters"].is_null(),
        "counts take no filters; they cover every claim in the tenant"
    );
    assert_eq!(
        operation["security"],
        json!([{"oauth2":["billing.read"]},{"browserSession":[]}])
    );
    assert_eq!(
        operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/ClaimStatusCounts"
    );
    let counts = &spec["components"]["schemas"]["ClaimStatusCounts"];
    assert_eq!(counts["type"], "object");
    assert_eq!(counts["additionalProperties"]["type"], "integer");
}
