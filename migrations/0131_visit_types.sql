-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE practice_visit_types (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    definition jsonb NOT NULL CHECK(jsonb_typeof(definition) = 'object'),
    version bigint NOT NULL CHECK(version > 0),
    updated_by uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(tenant_id,id)
);
CREATE UNIQUE INDEX practice_visit_type_name
    ON practice_visit_types(tenant_id,lower(definition->>'name'))
    WHERE definition->'enabled'='true'::jsonb;

-- Frozen at the time of selection. Existing appointments have no suggested codes.
ALTER TABLE appointments ADD COLUMN visit_type jsonb
    CHECK(visit_type IS NULL OR jsonb_typeof(visit_type) = 'object');
