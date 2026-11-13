// SPDX-License-Identifier: AGPL-3.0-only
//! One-click eligibility: the server fills in the request from the chart, the
//! coverage and the practice directory, and asks staff only for what is missing.
use super::*;
use crate::auth::Role;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct QuickRequest {
    request_id: Uuid,
    #[serde(default)]
    appointment_id: Option<Uuid>,
    #[serde(default)]
    visit_id: Option<Uuid>,
    #[serde(default)]
    service_date: Option<NaiveDate>,
    /// Sent when the page ran the check by itself. The server then applies the
    /// "is a fresh check worth it" rules and may answer `skipped`.
    #[serde(default)]
    automatic: bool,
    /// Answers to an earlier `needs` reply.
    #[serde(default)]
    provider_id: Option<Uuid>,
    #[serde(default)]
    billing_organization_id: Option<Uuid>,
}

const SUFFIXES: &[&str] = &["jr", "sr", "ii", "iii", "iv", "v"];

/// Splits a subscriber name written the way people write it on an insurance card:
/// "Given Family", "Given Middle Family" or "Family, Given Middle". Returns nothing
/// when a given and a family name cannot both be found.
pub(super) fn subscriber_parts(name: &str) -> Option<(String, Option<String>, String)> {
    let clean = |value: &str| value.split_whitespace().collect::<Vec<_>>().join(" ");
    let (given, middle, family) = if let Some((family, rest)) = name.split_once(',') {
        let mut rest = rest.split_whitespace();
        let given = rest.next()?.to_owned();
        (given, rest.collect::<Vec<_>>().join(" "), clean(family))
    } else {
        let mut parts: Vec<&str> = name.split_whitespace().collect();
        while parts.len() > 2
            && SUFFIXES.contains(
                &parts[parts.len() - 1]
                    .trim_end_matches('.')
                    .to_ascii_lowercase()
                    .as_str(),
            )
        {
            parts.pop();
        }
        if parts.len() < 2 {
            return None;
        }
        let family = parts.pop()?.to_owned();
        let given = parts.remove(0).to_owned();
        (given, parts.join(" "), family)
    };
    if bounded(&given, 100).is_err() || bounded(&family, 100).is_err() {
        return None;
    }
    let middle = Some(middle).filter(|value| bounded(value, 100).is_ok());
    Some((given, middle, family))
}

fn sex(demographics: Option<&Value>) -> Option<String> {
    match demographics.and_then(|value| value["administrative_gender"].as_str()) {
        Some("female") => Some("F".into()),
        Some("male") => Some("M".into()),
        _ => None,
    }
}

/// The last name Claim.MD expects for a person, from a directory display name such as
/// "Dr. Synthetic Provider, MD".
fn provider_names(display: &str) -> (Option<String>, String) {
    let base = display.split(',').next().unwrap_or(display);
    let mut parts: Vec<&str> = base
        .split_whitespace()
        .filter(|part| !part.trim_end_matches('.').eq_ignore_ascii_case("dr"))
        .collect();
    let family = parts.pop().unwrap_or(display.trim()).to_owned();
    (
        Some(parts.join(" ")).filter(|value| !value.is_empty()),
        family,
    )
}

fn needs(insurer: &str, items: Vec<Value>, automatic: bool) -> Value {
    json!({"outcome":"needs","needs":items,"insurer":insurer,"automatic":automatic})
}

async fn checked(pool: &PgPool, tenant: Uuid, check: Check) -> Result<Value> {
    let check = named(pool, tenant, vec![check]).await?.remove(0);
    Ok(json!({"outcome":"checked","check":check}))
}

pub(super) async fn check(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path((patient_id, coverage_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<QuickRequest>,
) -> Result<Response> {
    Ok(reply(
        quick_with_route(&state, &actor, patient_id, coverage_id, input, None).await?,
    ))
}

// The optional route is private and used by the synthetic loopback contract test.
pub(super) async fn quick_with_route(
    state: &State,
    actor: &Actor,
    patient_id: Uuid,
    coverage_id: Uuid,
    input: QuickRequest,
    route_override: Option<Route>,
) -> Result<Value> {
    actor.scheduling()?;
    let pool = db(state)?;
    let tenant = actor.tenant_id;
    let digest = crate::oauth::hash(
        &serde_json::to_string(&("one-click", patient_id, coverage_id, &input))
            .map_err(|_| Error::Invalid("invalid eligibility request"))?,
    );
    if let Some(existing) = existing(pool, actor, input.request_id).await? {
        if existing.creation_hash != digest {
            return Err(Error::Conflict("eligibility request ID was already used"));
        }
        let check = existing.into_check();
        if check.status == "pending" {
            return Err(Error::Conflict(
                "This eligibility check is still running. Wait a moment, then refresh.",
            ));
        }
        return checked(pool, tenant, check).await;
    }
    type Context = (String, String, NaiveDate, Option<Value>, Value, Uuid, Value);
    let row: Option<Context> = sqlx::query_as(
        "SELECT p.given_name,p.family_name,p.birth_date,d.content,c.content,py.id,py.content
           FROM patients p
           JOIN insurance_coverages c ON c.tenant_id=p.tenant_id AND c.patient_id=p.id
           JOIN ehr_payers py ON py.tenant_id=c.tenant_id AND py.id=c.payer_id
           LEFT JOIN patient_demographics d ON d.tenant_id=p.tenant_id AND d.patient_id=p.id
          WHERE p.tenant_id=$1 AND p.id=$2 AND c.id=$3",
    )
    .bind(tenant)
    .bind(patient_id)
    .bind(coverage_id)
    .fetch_optional(pool)
    .await?;
    let (patient_given, patient_family, patient_birth, demographics, coverage, payer_id, payer) =
        row.ok_or(Error::NotFound)?;
    let skipped = |reason: &str| Ok(json!({"outcome":"skipped","reason":reason}));
    let insurer = payer["name"].as_str().unwrap_or("").to_owned();
    if coverage["status"].as_str() != Some("active") {
        return if input.automatic {
            skipped("coverage_not_active")
        } else {
            Err(Error::Invalid(
                "This coverage is not active. Eligibility can only be checked for active coverage.",
            ))
        };
    }
    let has_payer_code = payer["payer_code"]
        .as_str()
        .is_some_and(|value| !value.is_empty());
    if input.automatic {
        if !has_payer_code {
            return skipped("no_payer_id");
        }
        // A fresh answer is not worth another request to the insurer, and a failure
        // is not retried behind the staff member's back.
        let (recent, failed, pending): (bool, bool, bool) = sqlx::query_as(
            "SELECT
               EXISTS(SELECT 1 FROM claimmd_eligibility_checks WHERE tenant_id=$1 AND coverage_id=$2 AND status='completed' AND request_snapshot->'request'->>'service_date' >= to_char((now() AT TIME ZONE 'UTC')::date-30,'YYYY-MM-DD')),
               EXISTS(SELECT 1 FROM claimmd_eligibility_checks WHERE tenant_id=$1 AND coverage_id=$2 AND status='failed' AND created_at>now()-interval '12 hours'),
               EXISTS(SELECT 1 FROM claimmd_eligibility_checks WHERE tenant_id=$1 AND coverage_id=$2 AND status='pending' AND created_at>now()-interval '5 minutes')",
        )
        .bind(tenant)
        .bind(coverage_id)
        .fetch_one(pool)
        .await?;
        if recent {
            return skipped("recent_check");
        }
        if failed {
            return skipped("recent_failure");
        }
        if pending {
            return skipped("in_progress");
        }
    }

    let mut missing = Vec::new();
    if !has_payer_code {
        missing.push(json!({"kind":"payer_id","payer_id":payer_id}));
    }
    if coverage["member_id"]
        .as_str()
        .is_none_or(|value| value.trim().is_empty())
    {
        missing.push(json!({"kind":"member_id"}));
    }

    // Who holds the policy.
    let own_policy = coverage["relationship"].as_str() == Some("self");
    let patient_sex = sex(demographics.as_ref());
    let mut subscriber = (patient_given, None, patient_family);
    let mut subscriber_birth = Some(patient_birth);
    if !own_policy {
        match subscriber_parts(coverage["subscriber_name"].as_str().unwrap_or("")) {
            Some(parts) => subscriber = parts,
            None => missing.push(json!({"kind":"subscriber_name"})),
        }
        subscriber_birth = coverage["subscriber_birth_date"]
            .as_str()
            .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok());
        if subscriber_birth.is_none() {
            missing.push(json!({"kind":"subscriber_birth_date"}));
        }
    }

    // The visit this check is for, when there is one.
    let mut appointment_id = input.appointment_id;
    let mut clinician = None;
    if let Some(visit_id) = input.visit_id {
        let (visit_appointment, visit_clinician): (Uuid, Uuid) = sqlx::query_as(
            "SELECT appointment_id,clinician_id FROM visits WHERE tenant_id=$1 AND id=$2 AND patient_id=$3",
        )
        .bind(tenant)
        .bind(visit_id)
        .bind(patient_id)
        .fetch_optional(pool)
        .await?
        .ok_or(Error::NotFound)?;
        if appointment_id.is_some_and(|id| id != visit_appointment) {
            return Err(Error::Invalid(
                "The visit and the appointment do not belong together.",
            ));
        }
        appointment_id = Some(visit_appointment);
        clinician = Some(visit_clinician);
    }
    let mut appointment_date = None;
    if let Some(id) = appointment_id {
        let (appointment_clinician, date): (Uuid, NaiveDate) = sqlx::query_as(
            "SELECT ap.clinician_id,(ap.starts_at AT TIME ZONE coalesce(bp.booking_timezone,'UTC'))::date FROM appointments ap LEFT JOIN previsit_booking_profiles bp ON bp.tenant_id=ap.tenant_id WHERE ap.tenant_id=$1 AND ap.id=$2 AND ap.patient_id=$3",
        )
        .bind(tenant)
        .bind(id)
        .bind(patient_id)
        .fetch_optional(pool)
        .await?
        .ok_or(Error::NotFound)?;
        clinician = clinician.or(Some(appointment_clinician));
        appointment_date = Some(date);
    }
    let service_date = match input.service_date.or(appointment_date) {
        Some(date) => date,
        None => sqlx::query_scalar(
            "SELECT (now() AT TIME ZONE coalesce((SELECT booking_timezone FROM previsit_booking_profiles WHERE tenant_id=$1),'UTC'))::date",
        )
        .bind(tenant)
        .fetch_one(pool)
        .await?,
    };

    // The practice directory, and what the last check used when staff had to choose.
    let providers: Vec<ProviderDefault> = sqlx::query_as("SELECT p.id,p.version,p.display_name,p.npi,p.specialty FROM practice_providers p JOIN browser_users u ON u.tenant_id=p.tenant_id AND u.id=p.id WHERE p.tenant_id=$1 AND p.active AND NOT u.disabled AND u.role IN ('owner','clinician') ORDER BY p.display_name,p.id LIMIT 100")
        .bind(tenant).fetch_all(pool).await?;
    let providers: Vec<ProviderDefault> = providers
        .into_iter()
        .filter(|provider| valid_npi(&provider.npi))
        .collect();
    let organizations = crate::practice_billing::choices(pool, tenant).await?;
    let remembered: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT request_snapshot->'request'->>'provider_id',request_snapshot->'request'->>'billing_organization_id' FROM claimmd_eligibility_checks WHERE tenant_id=$1 AND request_snapshot->'request' ? 'billing_organization_id' ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .bind(tenant)
    .fetch_optional(pool)
    .await?;
    let (last_provider, last_organization) = remembered.unwrap_or_default();
    let parse = |value: Option<String>| value.and_then(|value| Uuid::parse_str(&value).ok());
    let booking_default: Option<Uuid> = sqlx::query_scalar(
        "SELECT default_clinician_id FROM previsit_booking_profiles WHERE tenant_id=$1",
    )
    .bind(tenant)
    .fetch_optional(pool)
    .await?;

    let find_provider =
        |id: Option<Uuid>| id.and_then(|id| providers.iter().find(|provider| provider.id == id));
    let provider = if let Some(id) = input.provider_id {
        Some(find_provider(Some(id)).ok_or(Error::Invalid(
            "That provider is no longer available. Choose again.",
        ))?)
    } else {
        find_provider(clinician)
            .or_else(|| find_provider(booking_default))
            .or_else(|| find_provider(parse(last_provider)))
            .or_else(|| (providers.len() == 1).then(|| &providers[0]))
    };
    if provider.is_none() {
        missing.push(if providers.is_empty() {
            json!({"kind":"provider_npi"})
        } else {
            json!({"kind":"provider","choices":providers.iter().map(|provider| json!({"id":provider.id,"display_name":provider.display_name,"npi":provider.npi})).collect::<Vec<_>>()})
        });
    }
    let organization_id =
        |value: &Value| value["id"].as_str().and_then(|id| Uuid::parse_str(id).ok());
    let find_organization = |id: Option<Uuid>| {
        id.and_then(|id| {
            organizations
                .iter()
                .find(|value| organization_id(value) == Some(id))
        })
    };
    let organization = if let Some(id) = input.billing_organization_id {
        Some(find_organization(Some(id)).ok_or(Error::Invalid(
            "That billing organization is no longer available. Choose again.",
        ))?)
    } else {
        find_organization(parse(last_organization))
            .or_else(|| (organizations.len() == 1).then(|| &organizations[0]))
    };
    if organization.is_none() {
        missing.push(if organizations.is_empty() {
            json!({"kind":"billing_organization_missing"})
        } else {
            json!({"kind":"billing_organization","choices":organizations.iter().map(|value| json!({"id":value["id"],"name":value["name"],"tax_id_type":value["tax_id_type"],"tax_id_last4":value["tax_id_last4"]})).collect::<Vec<_>>()})
        });
    }
    let route = match route_override {
        Some(route) => Some(route),
        None => match route(pool, tenant).await {
            Ok(route) => Some(route),
            Err(Error::Conflict(_)) => {
                missing.push(json!({"kind":"claim_connection"}));
                None
            }
            Err(error) => return Err(error),
        },
    };
    let (Some(provider), Some(organization), Some(route), true) =
        (provider, organization, route, missing.is_empty())
    else {
        return Ok(needs(&insurer, missing, input.automatic));
    };

    let (given, middle, family) = subscriber;
    let request = EligibilityRequest {
        request_id: input.request_id,
        service_date,
        service_codes: vec!["30".into()],
        procedure_code: None,
        insured_given_name: given,
        insured_middle_name: middle,
        insured_family_name: family,
        insured_birth_date: subscriber_birth,
        insured_sex: own_policy.then(|| patient_sex.clone()).flatten(),
        patient_sex: (!own_policy).then_some(patient_sex).flatten(),
        provider_id: Some(provider.id),
        provider_version: Some(provider.version),
        billing_organization_id: organization_id(organization),
        billing_organization_version: organization["version"].as_i64(),
        provider_npi: String::new(),
        provider_taxid: String::new(),
        provider_taxid_type: String::new(),
        provider_name: None,
        provider_taxonomy: None,
    };
    let mut snapshot = serde_json::Map::new();
    snapshot.insert("one_click".into(), json!(true));
    snapshot.insert("automatic".into(), json!(input.automatic));
    snapshot.insert("insurer".into(), json!(insurer));
    snapshot.insert("provider_name".into(), json!(provider.display_name));
    snapshot.insert(
        "billing_organization_name".into(),
        organization["name"].clone(),
    );
    if let Some(id) = appointment_id {
        snapshot.insert("appointment_id".into(), json!(id));
    }
    let outcome = run_core(
        state,
        actor,
        patient_id,
        coverage_id,
        request,
        Some(route),
        Derived {
            digest: Some(digest),
            snapshot,
        },
    )
    .await;
    match outcome {
        Ok(check) => checked(pool, tenant, check).await,
        Err(Error::Invalid(RATE_LIMITED)) if input.automatic => skipped("rate_limited"),
        Err(error) => Err(error),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EnrollmentRequest {
    check_id: Uuid,
}

/// Starts Claim.MD's eligibility enrollment for the provider, billing organization and
/// insurer a failed check used. The tax ID never leaves the server.
pub(super) async fn enrollment(
    actor: Actor,
    ExtractState(state): ExtractState<State>,
    Path((patient_id, coverage_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<EnrollmentRequest>,
) -> Result<Response> {
    let pool = db(&state)?;
    let (setting, route) = crate::claimmd_extended::route(pool, actor.tenant_id, None)
        .await
        .map_err(|error| match error {
            Error::Conflict(_) => Error::Conflict(
                "Claim.MD is not connected, or more than one connection is set up. Open Claim connections to check.",
            ),
            other => other,
        })?;
    Ok(reply(
        enrollment_with_route(
            &state,
            &actor,
            patient_id,
            coverage_id,
            input,
            setting,
            route,
        )
        .await?,
    ))
}

pub(super) async fn enrollment_with_route(
    state: &State,
    actor: &Actor,
    patient_id: Uuid,
    coverage_id: Uuid,
    input: EnrollmentRequest,
    setting: Uuid,
    route: Route,
) -> Result<Value> {
    if !matches!(actor.role, Role::Owner) {
        return Err(Error::Forbidden);
    }
    let pool = db(state)?;
    let snapshot: Value = sqlx::query_scalar(
        "SELECT request_snapshot FROM claimmd_eligibility_checks WHERE tenant_id=$1 AND id=$2 AND patient_id=$3 AND coverage_id=$4",
    )
    .bind(actor.tenant_id)
    .bind(input.check_id)
    .bind(patient_id)
    .bind(coverage_id)
    .fetch_optional(pool)
    .await?
    .ok_or(Error::NotFound)?;
    let text = |value: &Value| value.as_str().unwrap_or("").to_owned();
    let payerid = text(&snapshot["payerid"]);
    let npi = text(&snapshot["request"]["provider_npi"]);
    let organization = snapshot["request"]["billing_organization_id"]
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok())
        .ok_or(Error::Invalid(
            "This check did not record a billing organization. Start the setup from Claim connections instead.",
        ))?;
    let (_, tax) = crate::practice_billing::tax_identity(pool, actor.tenant_id, organization)
        .await?
        .ok_or(Error::Invalid(
            "The billing organization used for this check is no longer active. Run the check again, then set up eligibility.",
        ))?;
    if payerid.is_empty() || !valid_npi(&npi) {
        return Err(Error::Invalid(
            "This check did not record the insurer and provider. Run the check again, then set up eligibility.",
        ));
    }
    let mut display = text(&snapshot["provider_name"]);
    if display.is_empty() {
        if let Some(id) = snapshot["request"]["provider_id"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())
        {
            display = sqlx::query_scalar(
                "SELECT display_name FROM practice_providers WHERE tenant_id=$1 AND id=$2",
            )
            .bind(actor.tenant_id)
            .bind(id)
            .fetch_optional(pool)
            .await?
            .unwrap_or_default();
        }
    }
    let (given, family) = provider_names(&display);
    let mut fields = vec![
        ("payerid".to_owned(), payerid.clone()),
        ("enroll_type".to_owned(), "elig".to_owned()),
        ("prov_taxid".to_owned(), tax.expose().to_owned()),
        ("prov_npi".to_owned(), npi.clone()),
    ];
    if !family.is_empty() {
        fields.push(("prov_name_l".into(), family.clone()));
    }
    if let Some(given) = &given {
        fields.push(("prov_name_f".into(), given.clone()));
    }
    acquire_rate_limit(pool, &route).await?;
    match post_evidence(&route, "enroll", fields).await {
        Ok(response) => match crate::claimmd_extended::provider_link(&response) {
            Ok(link) => {
                let reason = "Eligibility setup started from an eligibility check";
                let request = json!({
                    "payerid": payerid, "enroll_type": "elig",
                    "prov_taxid": format!("*****{}", &tax.expose()[5..]), "prov_npi": npi,
                    "prov_name_l": family, "prov_name_f": given,
                    "eligibility_check_id": input.check_id, "reason": reason
                });
                let id = crate::claimmd_extended::record_enrollment(
                    pool, actor, setting, &request, &link, reason,
                )
                .await?;
                Ok(json!({"status":"started","id":id,"external_url":link}))
            }
            // Claim.MD answered without a form to fill in.
            Err(_) => Ok(json!({"status":"no_link"})),
        },
        Err(failure) => Ok(json!({"status":"refused","failure":failure})),
    }
}
