-- SPDX-License-Identifier: AGPL-3.0-only
-- Candidate enrollment metadata is deliberately separate from active prescribing authority.
CREATE TABLE erx_connections (
 tenant_id uuid PRIMARY KEY,id uuid NOT NULL,version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 candidate_profile text NOT NULL CHECK(candidate_profile IN('none','photon','weno_ez','weno_online','dosespot_full','other')),
 profile_revision bigint NOT NULL DEFAULT 1 CHECK(profile_revision>0),
 enrollment_stage text NOT NULL CHECK(enrollment_stage IN('not_started','contact_planned','awaiting_vendor','agreement_in_progress','test_access_reported')),
 organization_reference text NOT NULL DEFAULT '',requested_capabilities jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(requested_capabilities)='array'),
 encrypted_credentials bytea,active boolean NOT NULL DEFAULT false CHECK(NOT active),
 updated_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE TABLE erx_prescribers (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 connection_id uuid NOT NULL,profile_revision bigint NOT NULL CHECK(profile_revision>0),
 facility_id uuid,vendor_user_id text NOT NULL DEFAULT '',vendor_username text NOT NULL DEFAULT '',vendor_location_id text NOT NULL DEFAULT '',
 enrollment_reported boolean NOT NULL DEFAULT false,encrypted_credentials bytea,updated_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id),FOREIGN KEY(tenant_id,user_id) REFERENCES practice_providers(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES erx_connections(tenant_id,id),FOREIGN KEY(tenant_id,facility_id) REFERENCES practice_facilities(tenant_id,id)
);
CREATE TABLE erx_setup_history (
 tenant_id uuid NOT NULL,id uuid NOT NULL,resource_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('connection','prescriber')),
 version bigint NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 public_snapshot jsonb NOT NULL,encrypted_credentials bytea,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,resource_id,kind,version)
);
CREATE TABLE erx_setup_requests (
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,actor_id uuid NOT NULL,operation text NOT NULL,
 encrypted_request bytea NOT NULL,public_response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,request_id)
);
CREATE TABLE erx_readiness_attempts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,actor_id uuid NOT NULL,request_id uuid NOT NULL,
 candidate_profile text NOT NULL,connection_version bigint NOT NULL,prescriber_version bigint,
 outcome text NOT NULL DEFAULT 'blocked' CHECK(outcome='blocked'),vendor_contacted boolean NOT NULL DEFAULT false CHECK(NOT vendor_contacted),
 native_prescription_id uuid,missing jsonb NOT NULL CHECK(jsonb_typeof(missing)='array'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,native_prescription_id) REFERENCES native_prescriptions(tenant_id,id)
);
CREATE TRIGGER erx_history_immutable BEFORE UPDATE OR DELETE ON erx_setup_history FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER erx_requests_immutable BEFORE UPDATE OR DELETE ON erx_setup_requests FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER erx_attempts_immutable BEFORE UPDATE OR DELETE ON erx_readiness_attempts FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER erx_connection_no_delete BEFORE DELETE ON erx_connections FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER erx_prescriber_no_delete BEFORE DELETE ON erx_prescribers FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE INDEX erx_attempt_patient ON erx_readiness_attempts(tenant_id,patient_id,created_at DESC,id);
CREATE FUNCTION erx_setup_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid eRx setup version or identity';END IF;
 IF TG_TABLE_NAME='erx_connections' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.profile_revision<>OLD.profile_revision+(CASE WHEN NEW.candidate_profile IS DISTINCT FROM OLD.candidate_profile THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'invalid eRx candidate revision'; END IF;
 ELSE
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id THEN RAISE EXCEPTION 'eRx prescriber identity is immutable';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER erx_connection_identity BEFORE UPDATE ON erx_connections FOR EACH ROW EXECUTE FUNCTION erx_setup_identity_guard();
CREATE TRIGGER erx_prescriber_identity BEFORE UPDATE ON erx_prescribers FOR EACH ROW EXECUTE FUNCTION erx_setup_identity_guard();
