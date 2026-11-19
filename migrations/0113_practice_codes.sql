-- SPDX-License-Identifier: AGPL-3.0-only
-- The practice's own code settings. An owner turns each terminology system on or off for the
-- practice, and keeps a practice list of codes with a price, default units and modifiers. The
-- list and the switches drive dropdowns and charge pricing; a code leaves the dropdowns by being
-- turned off, never by deletion, so a code already on a charge keeps its meaning. Tenant
-- isolation follows the other tenant tables: tenant_id leads every key and lookup.

CREATE TABLE practice_code_sets (
 tenant_id uuid NOT NULL, system text NOT NULL CHECK(system IN ('ICD-10-CM','ICD-10-PCS','HCPCS','CPT')),
 enabled boolean NOT NULL, version bigint NOT NULL CHECK(version>0),
 updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,system)
);

CREATE TABLE practice_codes (
 tenant_id uuid NOT NULL, id uuid NOT NULL, system text NOT NULL CHECK(system IN ('ICD-10-CM','ICD-10-PCS','HCPCS','CPT')),
 code text NOT NULL CHECK(length(code) BETWEEN 3 AND 8), display text NOT NULL CHECK(length(display) BETWEEN 1 AND 1000),
 enabled boolean NOT NULL, price_cents bigint NULL CHECK(price_cents IS NULL OR price_cents BETWEEN 0 AND 10000000),
 default_units integer NOT NULL CHECK(default_units BETWEEN 1 AND 9999),
 modifiers text NOT NULL DEFAULT '' CHECK(modifiers='' OR (modifiers !~ '^[ ]|[ ]$' AND length(modifiers)<=11 AND array_length(regexp_split_to_array(modifiers,' +'),1)<=4 AND modifiers ~ '^([0-9A-Z]{2}( [0-9A-Z]{2})*)?$')),
 version bigint NOT NULL CHECK(version>0), request_id uuid,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,system,code), UNIQUE(tenant_id,request_id)
);
CREATE INDEX practice_code_list ON practice_codes(tenant_id,system,code);
