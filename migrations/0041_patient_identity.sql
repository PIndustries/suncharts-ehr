-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE patients ADD COLUMN identity_version bigint NOT NULL DEFAULT 1 CHECK(identity_version>0);
CREATE TABLE patient_identity_revisions (
 tenant_id uuid NOT NULL,patient_id uuid NOT NULL,version bigint NOT NULL,
 snapshot jsonb NOT NULL,actor_id uuid,reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,patient_id,version),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id)
);
INSERT INTO patient_identity_revisions(tenant_id,patient_id,version,snapshot,reason)
 SELECT tenant_id,id,identity_version,jsonb_build_object('id',id,'mrn',mrn,'given_name',given_name,'family_name',family_name,'birth_date',birth_date),'Identity recorded before correction history was enabled' FROM patients;
CREATE TRIGGER patient_identity_history_immutable BEFORE UPDATE OR DELETE ON patient_identity_revisions
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION preserve_patient_registration_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
 RAISE EXCEPTION 'patient registration identity is immutable' USING ERRCODE='23514';
 END IF;
 IF (NEW.mrn IS DISTINCT FROM OLD.mrn OR NEW.given_name IS DISTINCT FROM OLD.given_name OR NEW.family_name IS DISTINCT FROM OLD.family_name OR NEW.birth_date IS DISTINCT FROM OLD.birth_date) AND NEW.identity_version <> OLD.identity_version+1 THEN
 RAISE EXCEPTION 'patient identity correction requires next version' USING ERRCODE='23514';
 END IF;
 IF NEW.identity_version NOT IN (OLD.identity_version,OLD.identity_version+1) THEN
 RAISE EXCEPTION 'invalid identity version transition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER patient_registration_identity_guard BEFORE UPDATE ON patients
FOR EACH ROW EXECUTE FUNCTION preserve_patient_registration_identity();
