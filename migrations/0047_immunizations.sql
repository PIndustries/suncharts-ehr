-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE immunizations (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND content ? 'status' AND content ? 'record_type'),performer_snapshot jsonb,created_by uuid NOT NULL,updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 CHECK(content->>'status' IN('completed','not_done','entered_in_error')),
 CHECK(content->>'record_type' IN('administered','historical','not_given'))
);
CREATE INDEX immunizations_patient ON immunizations(tenant_id,patient_id,id);
CREATE TABLE immunization_revisions (
 tenant_id uuid NOT NULL,immunization_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,immunization_id,version),FOREIGN KEY(tenant_id,immunization_id) REFERENCES immunizations(tenant_id,id)
);
CREATE TABLE immunization_requests (
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,actor_id uuid NOT NULL,operation text NOT NULL,
 request jsonb NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,request_id)
);
CREATE TRIGGER immunization_revisions_immutable BEFORE UPDATE OR DELETE ON immunization_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immunization_requests_immutable BEFORE UPDATE OR DELETE ON immunization_requests FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immunizations_no_delete BEFORE DELETE ON immunizations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION preserve_immunization_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version<>OLD.version+1 THEN
 RAISE EXCEPTION 'immunization identity and version must be preserved' USING ERRCODE='23514';END IF;
 IF OLD.content->>'status'='entered_in_error' OR NEW.content->>'record_type' IS DISTINCT FROM OLD.content->>'record_type' THEN
 RAISE EXCEPTION 'error records and immunization record type are immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_immunization_identity BEFORE UPDATE ON immunizations FOR EACH ROW EXECUTE FUNCTION preserve_immunization_identity();
