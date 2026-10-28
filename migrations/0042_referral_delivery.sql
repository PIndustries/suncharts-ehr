-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE referral_delivery_destinations (
 tenant_id uuid NOT NULL,id uuid NOT NULL,name text NOT NULL,endpoint text NOT NULL,
 enabled boolean NOT NULL,loopback_test boolean NOT NULL DEFAULT false,version bigint NOT NULL DEFAULT 1,
 encrypted_credential bytea NOT NULL,creation_hash text NOT NULL,updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE referral_delivery_destination_revisions (
 tenant_id uuid NOT NULL,destination_id uuid NOT NULL,version bigint NOT NULL,snapshot jsonb NOT NULL,
 actor_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,destination_id,version),FOREIGN KEY(tenant_id,destination_id) REFERENCES referral_delivery_destinations(tenant_id,id)
);
CREATE TRIGGER referral_destination_history_immutable BEFORE UPDATE OR DELETE ON referral_delivery_destination_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE referral_delivery_previews (
 tenant_id uuid NOT NULL,digest text NOT NULL,referral_id uuid NOT NULL,patient_id uuid NOT NULL,
 referral_version bigint NOT NULL,destination_id uuid NOT NULL,destination_version bigint NOT NULL,
 payload jsonb NOT NULL,manifest jsonb NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,digest),FOREIGN KEY(tenant_id,referral_id) REFERENCES referrals(tenant_id,id)
);
CREATE TABLE referral_delivery_jobs (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,referral_id uuid NOT NULL,
 referral_version bigint NOT NULL,destination_id uuid NOT NULL,destination_version bigint NOT NULL,
 destination_name text NOT NULL,endpoint text NOT NULL,loopback_test boolean NOT NULL,
 encrypted_credential bytea NOT NULL,payload jsonb NOT NULL,manifest jsonb NOT NULL,review_digest text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','sending','sent','uncertain','not_sent','cancelled')),
 version bigint NOT NULL DEFAULT 1,actor_id uuid NOT NULL,actor_role text NOT NULL,reason text NOT NULL,
 receipt text, outcome_reason text NOT NULL DEFAULT '',lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,referral_id) REFERENCES referrals(tenant_id,id),
 FOREIGN KEY(tenant_id,destination_id) REFERENCES referral_delivery_destinations(tenant_id,id)
);
CREATE UNIQUE INDEX referral_delivery_one_active ON referral_delivery_jobs(tenant_id,referral_id) WHERE status IN ('queued','sending','uncertain');
CREATE TABLE referral_delivery_events (
 tenant_id uuid NOT NULL,job_id uuid NOT NULL,version bigint NOT NULL,status text NOT NULL,
 actor_id uuid NOT NULL,reason text NOT NULL,receipt text,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,job_id,version),FOREIGN KEY(tenant_id,job_id) REFERENCES referral_delivery_jobs(tenant_id,id)
);
CREATE TRIGGER referral_delivery_event_immutable BEFORE UPDATE OR DELETE ON referral_delivery_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION preserve_referral_delivery_reservation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM referral_delivery_jobs j WHERE j.tenant_id=OLD.tenant_id AND j.referral_id=OLD.id AND j.status IN ('queued','sending','uncertain')) THEN
 RAISE EXCEPTION 'referral is reserved for external delivery; reconcile or cancel the job first' USING ERRCODE='23514';
 END IF;RETURN NEW;END $$;
CREATE TRIGGER referral_delivery_reservation BEFORE UPDATE ON referrals FOR EACH ROW EXECUTE FUNCTION preserve_referral_delivery_reservation();
CREATE FUNCTION preserve_referral_delivery_job_package() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
 NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.referral_id IS DISTINCT FROM OLD.referral_id OR
 NEW.referral_version IS DISTINCT FROM OLD.referral_version OR NEW.destination_id IS DISTINCT FROM OLD.destination_id OR
 NEW.destination_version IS DISTINCT FROM OLD.destination_version OR NEW.endpoint IS DISTINCT FROM OLD.endpoint OR
 NEW.loopback_test IS DISTINCT FROM OLD.loopback_test OR NEW.encrypted_credential IS DISTINCT FROM OLD.encrypted_credential OR
 NEW.payload IS DISTINCT FROM OLD.payload OR NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.review_digest IS DISTINCT FROM OLD.review_digest OR
 NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.actor_role IS DISTINCT FROM OLD.actor_role OR NEW.reason IS DISTINCT FROM OLD.reason THEN
 RAISE EXCEPTION 'reviewed delivery package is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER referral_delivery_package_immutable BEFORE UPDATE ON referral_delivery_jobs FOR EACH ROW EXECUTE FUNCTION preserve_referral_delivery_job_package();
CREATE TRIGGER referral_delivery_job_no_delete BEFORE DELETE ON referral_delivery_jobs FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
