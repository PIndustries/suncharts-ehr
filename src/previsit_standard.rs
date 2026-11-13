// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
//! The standard new-patient intake form every practice starts with.
//!
//! The form is defined here, in the same shape as a practice's own intake
//! form, and copied into each issued form when it is sent. Changing this file
//! therefore never changes a form a patient has already been given.
use serde_json::{json, Value};

/// Raised whenever the standard questions change, so an issued form records
/// which edition the patient answered.
pub(crate) const STANDARD_VERSION: i64 = 1;
pub(crate) const TEMPLATE_NAME: &str = "Standard intake form";
pub(crate) const ATTESTATION: &str = "I confirm this information is complete and accurate to the best of my knowledge. I understand the practice will review it before adding it to my chart.";

const STATES: &[(&str, &str)] = &[
    ("AL", "Alabama"),
    ("AK", "Alaska"),
    ("AZ", "Arizona"),
    ("AR", "Arkansas"),
    ("CA", "California"),
    ("CO", "Colorado"),
    ("CT", "Connecticut"),
    ("DE", "Delaware"),
    ("DC", "District of Columbia"),
    ("FL", "Florida"),
    ("GA", "Georgia"),
    ("HI", "Hawaii"),
    ("ID", "Idaho"),
    ("IL", "Illinois"),
    ("IN", "Indiana"),
    ("IA", "Iowa"),
    ("KS", "Kansas"),
    ("KY", "Kentucky"),
    ("LA", "Louisiana"),
    ("ME", "Maine"),
    ("MD", "Maryland"),
    ("MA", "Massachusetts"),
    ("MI", "Michigan"),
    ("MN", "Minnesota"),
    ("MS", "Mississippi"),
    ("MO", "Missouri"),
    ("MT", "Montana"),
    ("NE", "Nebraska"),
    ("NV", "Nevada"),
    ("NH", "New Hampshire"),
    ("NJ", "New Jersey"),
    ("NM", "New Mexico"),
    ("NY", "New York"),
    ("NC", "North Carolina"),
    ("ND", "North Dakota"),
    ("OH", "Ohio"),
    ("OK", "Oklahoma"),
    ("OR", "Oregon"),
    ("PA", "Pennsylvania"),
    ("RI", "Rhode Island"),
    ("SC", "South Carolina"),
    ("SD", "South Dakota"),
    ("TN", "Tennessee"),
    ("TX", "Texas"),
    ("UT", "Utah"),
    ("VT", "Vermont"),
    ("VA", "Virginia"),
    ("WA", "Washington"),
    ("WV", "West Virginia"),
    ("WI", "Wisconsin"),
    ("WY", "Wyoming"),
];

const RELATIONSHIPS: &[&str] = &[
    "Spouse or partner",
    "Parent",
    "Child",
    "Sibling",
    "Friend",
    "Other",
];
const LANGUAGES: &[&str] = &[
    "English",
    "Spanish",
    "Chinese",
    "Vietnamese",
    "Tagalog",
    "Arabic",
    "French",
    "Korean",
    "Russian",
    "Other",
];

/// The text box that appears only when the patient chooses "Other".
fn other(key: &str) -> Value {
    json!({"key":format!("{key}_other"),"label":"Please tell us","type":"text","required":true,"max_length":100,"show_if":{"key":key,"equals":"Other"}})
}
/// Holds the record the patient picked from a list; never shown as a question.
fn picked(key: &str, coverage_field: Option<&str>) -> Value {
    let mut field = json!({"key":format!("{key}_id"),"label":"Chosen from the list","type":"text","required":false,"hidden":true,"max_length":120});
    if let Some(name) = coverage_field {
        field["coverage_field"] = json!(name);
    }
    field
}

fn insurance(prefix: &str, rank: &str, label: &str, skippable: bool) -> Value {
    let key = |name: &str| format!("{prefix}_{name}");
    let other_holder = json!({"key":key("relationship"),"any_of":["Spouse","Child","Other"]});
    let mut section = json!({
        "label":label,
        "coverage":rank,
        "intro":"You can find these details on your insurance card.",
        "show_if":{"key":"payment_method","equals":"Insurance"},
        "fields":[
            {"key":key("company"),"label":"Insurance company","type":"text","required":true,"max_length":200,"lookup":"insurer","id_key":key("company_id"),"help":"Start typing and choose yours from the list.","coverage_field":"company"},
            picked(&key("company"), Some("payer_ref")),
            {"key":key("member_id"),"label":"Member or policy ID","type":"text","required":true,"max_length":150,"coverage_field":"member_id"},
            {"key":key("plan"),"label":"Plan name","type":"text","required":false,"max_length":200,"coverage_field":"plan_name"},
            {"key":key("group"),"label":"Group number","type":"text","required":false,"max_length":150,"coverage_field":"group_number"},
            {"key":key("phone"),"label":"Insurance phone number","type":"phone","required":false,"format":"phone","inputmode":"tel","help":"Usually on the back of your card.","coverage_field":"phone"},
            {"key":key("relationship"),"label":"Who holds this policy?","type":"select","required":true,"options":["Self","Spouse","Child","Other"],"option_labels":["I do","My spouse","My parent","Someone else"],"coverage_field":"relationship"},
            {"key":key("holder_name"),"label":"Policy holder's full name","type":"text","required":true,"max_length":200,"show_if":other_holder,"coverage_field":"subscriber_name"},
            {"key":key("holder_dob"),"label":"Policy holder's date of birth","type":"date","required":true,"format":"past_date","show_if":other_holder,"coverage_field":"subscriber_birth_date"},
            {"key":key("holder_sex"),"label":"Policy holder's sex","type":"select","required":false,"options":["Female","Male","Unknown"],"show_if":other_holder,"coverage_field":"subscriber_sex"}
        ]
    });
    if skippable {
        section["skippable"] = json!(true);
        section["skip_label"] = json!("I don't have a second insurance");
    }
    section
}

/// The nine standard steps, in the order the patient sees them.
pub(crate) fn sections() -> Vec<Value> {
    let states: Vec<&str> = STATES.iter().map(|(code, _)| *code).collect();
    let state_names: Vec<&str> = STATES.iter().map(|(_, name)| *name).collect();
    let someone_else = json!({"key":"responsible_party","equals":"Someone else"});
    vec![
        json!({"label":"About you","fields":[
            {"key":"first_name","label":"First name","type":"text","required":true,"max_length":100,"autocomplete":"given-name","chart_target":"identity.given_name"},
            {"key":"middle_name","label":"Middle name","type":"text","required":false,"max_length":100,"autocomplete":"additional-name"},
            {"key":"last_name","label":"Last name","type":"text","required":true,"max_length":100,"autocomplete":"family-name","chart_target":"identity.family_name"},
            {"key":"suffix","label":"Suffix","type":"text","required":false,"max_length":20,"help":"For example Jr. or III.","autocomplete":"honorific-suffix"},
            {"key":"date_of_birth","label":"Date of birth","type":"date","required":true,"format":"past_date","help":"Month, day and year.","autocomplete":"bday","chart_target":"identity.birth_date"},
            {"key":"sex","label":"Sex","type":"select","required":false,"options":["Female","Male","Unknown"],"option_labels":["Female","Male","Prefer not to say or unknown"],"chart_target":"demographics.administrative_gender"},
            {"key":"preferred_name","label":"Preferred name","type":"text","required":false,"max_length":100,"help":"What would you like us to call you?","chart_target":"demographics.preferred_name"},
            {"key":"preferred_language","label":"Preferred language","type":"select","required":false,"options":LANGUAGES,"other_key":"preferred_language_other","chart_target":"demographics.language"},
            other("preferred_language")
        ]}),
        json!({"label":"Contact","fields":[
            {"key":"phone","label":"Mobile or main phone","type":"phone","required":true,"format":"phone","inputmode":"tel","autocomplete":"tel","chart_target":"demographics.phone"},
            {"key":"phone_type","label":"What kind of phone is this?","type":"select","required":false,"options":["Mobile","Home","Work"]},
            {"key":"email","label":"Email","type":"email","required":false,"format":"email","inputmode":"email","autocomplete":"email","chart_target":"demographics.email"},
            {"key":"address_line1","label":"Street address","type":"text","required":true,"max_length":200,"autocomplete":"address-line1","chart_target":"demographics.address.line1"},
            {"key":"address_line2","label":"Apartment, suite or unit","type":"text","required":false,"max_length":200,"autocomplete":"address-line2","chart_target":"demographics.address.line2"},
            {"key":"city","label":"City","type":"text","required":true,"max_length":100,"autocomplete":"address-level2","chart_target":"demographics.address.city"},
            {"key":"state","label":"State","type":"select","required":true,"options":states,"option_labels":state_names,"autocomplete":"address-level1","chart_target":"demographics.address.region"},
            {"key":"zip","label":"ZIP code","type":"text","required":true,"format":"zip","inputmode":"numeric","max_length":10,"autocomplete":"postal-code","chart_target":"demographics.address.postal_code"}
        ]}),
        json!({"label":"More about you","intro":"These questions are optional. Your answers help us care for you and are kept private.","fields":[
            {"key":"marital_status","label":"Marital status","type":"select","required":false,"options":["Single","Married","Partnered","Divorced","Separated","Widowed","Other","Prefer not to say"],"other_key":"marital_status_other"},
            other("marital_status"),
            {"key":"race","label":"Race","type":"select","required":false,"options":["American Indian or Alaska Native","Asian","Black or African American","Native Hawaiian or Other Pacific Islander","White","Other","Prefer not to say"],"other_key":"race_other"},
            other("race"),
            {"key":"ethnicity","label":"Are you Hispanic or Latino?","type":"select","required":false,"options":["Yes","No","Prefer not to say"]},
            {"key":"gender_identity","label":"Gender identity","type":"select","required":false,"options":["Female","Male","Transgender female","Transgender male","Non-binary","Other","Prefer not to say"],"other_key":"gender_identity_other"},
            other("gender_identity"),
            {"key":"sexual_orientation","label":"Sexual orientation","type":"select","required":false,"options":["Straight or heterosexual","Lesbian or gay","Bisexual","Other","Don't know","Prefer not to say"],"other_key":"sexual_orientation_other"},
            other("sexual_orientation")
        ]}),
        json!({"label":"Emergency contact","intro":"Someone we can reach if we cannot reach you.","fields":[
            {"key":"emergency_name","label":"Their name","type":"text","required":true,"max_length":200,"chart_target":"demographics.emergency_contact.name"},
            {"key":"emergency_relationship","label":"How are they related to you?","type":"select","required":true,"options":RELATIONSHIPS,"other_key":"emergency_relationship_other","chart_target":"demographics.emergency_contact.relationship"},
            other("emergency_relationship"),
            {"key":"emergency_phone","label":"Their phone","type":"phone","required":true,"format":"phone","inputmode":"tel","chart_target":"demographics.emergency_contact.phone"},
            {"key":"emergency_email","label":"Their email","type":"email","required":false,"format":"email","inputmode":"email"}
        ]}),
        json!({"label":"Who is responsible for the bill","fields":[
            {"key":"responsible_party","label":"Who will pay for your care?","type":"select","required":true,"options":["Myself","Someone else"]},
            {"key":"responsible_name","label":"Their name","type":"text","required":true,"max_length":200,"show_if":someone_else},
            {"key":"responsible_relationship","label":"How are they related to you?","type":"select","required":true,"options":RELATIONSHIPS,"other_key":"responsible_relationship_other","show_if":someone_else},
            other("responsible_relationship"),
            {"key":"responsible_phone","label":"Their phone","type":"phone","required":true,"format":"phone","inputmode":"tel","show_if":someone_else}
        ]}),
        json!({"label":"How you will pay","fields":[
            {"key":"payment_method","label":"How do you plan to pay for visits?","type":"select","required":true,"options":["Insurance","Self-pay"],"option_labels":["With insurance","I will pay myself"]}
        ]}),
        insurance("insurance", "primary", "Primary insurance", false),
        insurance("insurance2", "secondary", "Secondary insurance", true),
        json!({"label":"Pharmacy and one last question","fields":[
            {"key":"pharmacy_name","label":"Preferred pharmacy","type":"text","required":false,"max_length":300,"lookup":"pharmacy","id_key":"pharmacy_name_id","help":"Start typing and choose yours from the list."},
            picked("pharmacy_name", None),
            {"key":"pharmacy_address","label":"Pharmacy address or cross streets","type":"text","required":false,"max_length":300},
            {"key":"heard_about_us","label":"How did you hear about us?","type":"select","required":false,"options":["Doctor referral","Friend or family","Insurance directory","Online search","Social media","Other"],"other_key":"heard_about_us_other"},
            other("heard_about_us")
        ]}),
    ]
}

/// True when a saved practice form asks the standard questions first.
pub(crate) fn uses_standard(schema: &Value) -> bool {
    schema.get("base").and_then(Value::as_str) == Some("standard")
}

/// What a practice that has saved nothing uses: the standard steps only.
pub(crate) fn unsaved_template() -> Value {
    json!({"base":"standard","sections":[],"attestation":ATTESTATION})
}

/// The complete form a patient is given for a saved practice form. A form in
/// standard mode gets the standard steps followed by the practice's own
/// sections; any other saved form is used exactly as saved.
pub(crate) fn resolve(schema: &Value) -> Value {
    if !uses_standard(schema) {
        return schema.clone();
    }
    let mut all = sections();
    if let Some(own) = schema.get("sections").and_then(Value::as_array) {
        all.extend(own.iter().cloned());
    }
    let attestation = schema
        .get("attestation")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(ATTESTATION);
    json!({"base":"standard","standard_version":STANDARD_VERSION,"standard_steps":sections().len(),"attestation":attestation,"sections":all})
}

/// The standard steps alone, for the read-only preview in settings.
pub(crate) fn preview() -> Value {
    resolve(&unsaved_template())
}
