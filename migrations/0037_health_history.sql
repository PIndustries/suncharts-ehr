-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE health_history_entries (
 tenant_id uuid NOT NULL, id uuid NOT NULL, patient_id uuid NOT NULL,
 request_id uuid NOT NULL, create_request jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), content jsonb NOT NULL,
 created_by uuid NOT NULL, updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 CHECK(content->>'kind' IN ('surgery','dental'))
);
CREATE INDEX health_history_patient ON health_history_entries(tenant_id,patient_id,id);
CREATE TABLE health_history_revisions (
 tenant_id uuid NOT NULL, entry_id uuid NOT NULL, version bigint NOT NULL,
 content jsonb NOT NULL, author_id uuid NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,entry_id,version),
 FOREIGN KEY(tenant_id,entry_id) REFERENCES health_history_entries(tenant_id,id)
);
CREATE TRIGGER health_history_revision_immutable BEFORE UPDATE OR DELETE ON health_history_revisions
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER health_history_no_delete BEFORE DELETE ON health_history_entries
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION preserve_health_history_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
 NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR
 NEW.create_request IS DISTINCT FROM OLD.create_request OR NEW.content->>'kind' IS DISTINCT FROM OLD.content->>'kind' THEN
 RAISE EXCEPTION 'health history identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER health_history_identity_immutable BEFORE UPDATE ON health_history_entries
FOR EACH ROW EXECUTE FUNCTION preserve_health_history_identity();
