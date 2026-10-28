-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE prescribing_pharmacies (
 tenant_id uuid NOT NULL,id uuid NOT NULL,version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),active boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL,updated_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE patient_pharmacy_preferences (
 tenant_id uuid NOT NULL,patient_id uuid NOT NULL,pharmacy_id uuid,version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,patient_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,pharmacy_id) REFERENCES prescribing_pharmacies(tenant_id,id)
);
CREATE TABLE native_prescriptions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,visit_id uuid,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','active','cancelled','stopped','completed')),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
 signed_by uuid,signed_at timestamptz,signed_snapshot jsonb,
 fulfillment_status text NOT NULL DEFAULT 'not_authorized' CHECK(fulfillment_status IN('not_authorized','local_ready','printed','recorded_local')),
 authored_by uuid NOT NULL,updated_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 prior_prescription_id uuid,relationship text CHECK(relationship IN('renewal','replacement')),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,visit_id) REFERENCES visits(tenant_id,id),
 FOREIGN KEY(tenant_id,prior_prescription_id) REFERENCES native_prescriptions(tenant_id,id),
 CHECK((prior_prescription_id IS NULL)=(relationship IS NULL)),CHECK(prior_prescription_id IS DISTINCT FROM id),
 CHECK((signed_by IS NULL AND signed_at IS NULL AND signed_snapshot IS NULL AND status IN('draft','cancelled') AND fulfillment_status='not_authorized') OR
 (signed_by IS NOT NULL AND signed_at IS NOT NULL AND signed_snapshot IS NOT NULL AND status<>'draft' AND fulfillment_status<>'not_authorized' AND jsonb_typeof(signed_snapshot)='object' AND signed_snapshot ? 'content' AND signed_snapshot->'content'=content AND coalesce(content->>'controlled_substance','')='false'))
);
CREATE INDEX prescriptions_patient ON native_prescriptions(tenant_id,patient_id,id);
CREATE TABLE prescribing_history (
 tenant_id uuid NOT NULL,id uuid NOT NULL,resource_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('prescription','pharmacy','preference')),
 version bigint NOT NULL,action text NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,kind,resource_id,version)
);
CREATE TABLE prescribing_requests (
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,actor_id uuid NOT NULL,operation text NOT NULL,
 request jsonb NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,request_id)
);
CREATE TRIGGER prescribing_history_immutable BEFORE UPDATE OR DELETE ON prescribing_history FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER prescribing_requests_immutable BEFORE UPDATE OR DELETE ON prescribing_requests FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER prescriptions_no_delete BEFORE DELETE ON native_prescriptions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER pharmacies_no_delete BEFORE DELETE ON prescribing_pharmacies FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION preserve_prescription() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR
 NEW.authored_by IS DISTINCT FROM OLD.authored_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
 NEW.prior_prescription_id IS DISTINCT FROM OLD.prior_prescription_id OR NEW.relationship IS DISTINCT FROM OLD.relationship OR NEW.version<>OLD.version+1 THEN
 RAISE EXCEPTION 'prescription identity and version must be preserved' USING ERRCODE='23514';END IF;
 IF OLD.signed_at IS NOT NULL AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.visit_id IS DISTINCT FROM OLD.visit_id OR NEW.signed_at IS DISTINCT FROM OLD.signed_at OR NEW.signed_by IS DISTINCT FROM OLD.signed_by OR NEW.signed_snapshot IS DISTINCT FROM OLD.signed_snapshot) THEN
 RAISE EXCEPTION 'authorized prescription content is immutable' USING ERRCODE='23514';END IF;
 IF (OLD.status IN('cancelled','stopped','completed') AND NEW.status IS DISTINCT FROM OLD.status) OR (OLD.status='active' AND NEW.status='draft') THEN
 RAISE EXCEPTION 'terminal prescription cannot be reopened' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_prescription BEFORE UPDATE ON native_prescriptions FOR EACH ROW EXECUTE FUNCTION preserve_prescription();
