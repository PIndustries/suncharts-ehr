-- SPDX-License-Identifier: AGPL-3.0-only
-- Intake is separate from clinician-authored SOAP. Revisions retain attribution.
CREATE TABLE visit_rooming (
    tenant_id uuid NOT NULL,
    visit_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('not_started','in_progress','ready')),
    chief_complaint text NOT NULL DEFAULT '' CHECK (length(chief_complaint)<=2000),
    intake_notes text NOT NULL DEFAULT '' CHECK (length(intake_notes)<=10000),
    medications_reviewed boolean NOT NULL DEFAULT false,
    allergies_reviewed boolean NOT NULL DEFAULT false,
    updated_by uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(tenant_id,visit_id),
    FOREIGN KEY(tenant_id,visit_id) REFERENCES visits(tenant_id,id)
);
CREATE TABLE visit_rooming_revisions (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    visit_id uuid NOT NULL,
    visit_version bigint NOT NULL,
    kind text NOT NULL CHECK (kind IN ('intake','vitals')),
    actor_id uuid NOT NULL,
    snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(tenant_id,id),
    UNIQUE(tenant_id,visit_id,visit_version),
    FOREIGN KEY(tenant_id,visit_id) REFERENCES visits(tenant_id,id)
);
