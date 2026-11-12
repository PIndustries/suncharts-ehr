-- Native membership operations are processor reservations; they never change encounter ledgers.
CREATE TABLE patient_membership_operations (
 tenant_id uuid NOT NULL,
 request_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('price','membership','cancel')),
 patient_id uuid,
 setting_id uuid NOT NULL,
 credential_revision bigint NOT NULL,
 installation_id uuid NOT NULL,
 provider_account_id text NOT NULL,
 livemode boolean NOT NULL,
 requested_by uuid NOT NULL,
 request_body jsonb NOT NULL,
 status text NOT NULL DEFAULT 'creating',
 provider_evidence jsonb,
 version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,request_id),
 CHECK((kind='price')=(patient_id IS NULL)),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,setting_id) REFERENCES payment_settings(tenant_id,id)
);
CREATE INDEX patient_membership_patient ON patient_membership_operations(tenant_id,patient_id,created_at DESC);
CREATE FUNCTION preserve_patient_membership_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.tenant_id,NEW.request_id,NEW.kind,NEW.patient_id,NEW.setting_id,NEW.credential_revision,NEW.installation_id,NEW.provider_account_id,NEW.livemode,NEW.requested_by,NEW.request_body,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.tenant_id,OLD.request_id,OLD.kind,OLD.patient_id,OLD.setting_id,OLD.credential_revision,OLD.installation_id,OLD.provider_account_id,OLD.livemode,OLD.requested_by,OLD.request_body,OLD.created_at)
 THEN RAISE EXCEPTION 'Membership operation identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER patient_membership_identity BEFORE UPDATE OR DELETE ON patient_membership_operations FOR EACH ROW EXECUTE FUNCTION preserve_patient_membership_operation();
