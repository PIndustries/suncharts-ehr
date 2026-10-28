-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE referrals (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,visit_id uuid,
 request_id uuid NOT NULL,create_request jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','sent','accepted','scheduled','completed','cancelled','entered_in_error')),
 content jsonb NOT NULL,attachment_snapshot jsonb,created_by uuid NOT NULL,updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,visit_id,patient_id) REFERENCES visits(tenant_id,id,patient_id)
);
CREATE INDEX referrals_patient ON referrals(tenant_id,patient_id,id);
CREATE TABLE referral_revisions (
 tenant_id uuid NOT NULL,referral_id uuid NOT NULL,version bigint NOT NULL,
 status text NOT NULL,visit_id uuid,content jsonb NOT NULL,attachment_snapshot jsonb,author_id uuid NOT NULL,
 reason text NOT NULL,evidence text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,referral_id,version),
 FOREIGN KEY(tenant_id,referral_id) REFERENCES referrals(tenant_id,id)
);
CREATE TRIGGER referral_revision_immutable BEFORE UPDATE OR DELETE ON referral_revisions
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER referral_no_delete BEFORE DELETE ON referrals
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION preserve_referral_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
 NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR
 NEW.create_request IS DISTINCT FROM OLD.create_request THEN
 RAISE EXCEPTION 'referral identity is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status NOT IN ('draft','ready') AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.visit_id IS DISTINCT FROM OLD.visit_id OR NEW.attachment_snapshot IS DISTINCT FROM OLD.attachment_snapshot) THEN
 RAISE EXCEPTION 'sent referral content is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER referral_identity_immutable BEFORE UPDATE ON referrals
FOR EACH ROW EXECUTE FUNCTION preserve_referral_identity();
