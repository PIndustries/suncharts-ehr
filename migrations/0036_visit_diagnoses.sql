-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE visit_diagnoses (
    tenant_id uuid NOT NULL,
    visit_id uuid NOT NULL,
    diagnoses jsonb NOT NULL CHECK (jsonb_typeof(diagnoses)='array' AND jsonb_array_length(diagnoses)<=20),
    updated_by uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(tenant_id,visit_id),
    FOREIGN KEY(tenant_id,visit_id) REFERENCES visits(tenant_id,id)
);
CREATE TABLE visit_diagnosis_revisions (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    visit_id uuid NOT NULL,
    visit_version bigint NOT NULL,
    actor_id uuid NOT NULL,
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
    snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(tenant_id,id),
    UNIQUE(tenant_id,visit_id,visit_version),
    FOREIGN KEY(tenant_id,visit_id) REFERENCES visits(tenant_id,id)
);
CREATE TRIGGER diagnosis_revision_immutable BEFORE UPDATE OR DELETE ON visit_diagnosis_revisions
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER diagnosis_no_delete BEFORE DELETE ON visit_diagnoses
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER signed_diagnoses_immutable BEFORE INSERT OR UPDATE ON visit_diagnoses
FOR EACH ROW EXECUTE FUNCTION preserve_signed_rooming();
