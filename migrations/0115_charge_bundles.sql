-- SPDX-License-Identifier: AGPL-3.0-only
-- A practice's named sets of procedure lines ("bundles"). Picking one on an encounter adds its
-- lines to the charge table in one step: codes, modifiers, units and a drug's NDC details. A bundle
-- carries no amounts; each line is priced from the practice's own code list when it is added. A
-- bundle leaves the list by being turned off, never by deletion. Tenant isolation follows the other
-- tenant tables: tenant_id leads every key and lookup.

CREATE TABLE practice_charge_bundles (
 tenant_id uuid NOT NULL, id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80 AND name=btrim(name)),
 lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array' AND jsonb_array_length(lines) BETWEEN 1 AND 20),
 enabled boolean NOT NULL, version bigint NOT NULL CHECK(version>0),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE UNIQUE INDEX practice_charge_bundle_name ON practice_charge_bundles(tenant_id,lower(name)) WHERE enabled;
