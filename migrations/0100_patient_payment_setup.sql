-- Hosted setup stores an opaque provider binding, never card details or clinical data.
CREATE TABLE patient_payment_setups (
 tenant_id uuid NOT NULL,
 request_id uuid NOT NULL,
 patient_id uuid NOT NULL,
 setting_id uuid NOT NULL,
 credential_revision bigint NOT NULL,
 installation_id uuid NOT NULL,
 provider_account_id text NOT NULL,
 livemode boolean NOT NULL,
 return_url text NOT NULL,
 requested_by uuid NOT NULL,
 consent_scope text NOT NULL CHECK(consent_scope='patient_present'),
 status text NOT NULL CHECK(status IN ('creating','open','pending','succeeded','expired','needs_review')),
 provider_evidence jsonb,
 version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,request_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,setting_id) REFERENCES payment_settings(tenant_id,id)
);
CREATE UNIQUE INDEX patient_payment_setup_unresolved
 ON patient_payment_setups(tenant_id,patient_id,setting_id)
 WHERE status IN ('creating','open','pending','needs_review');
CREATE FUNCTION preserve_patient_payment_setup_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR
 ROW(NEW.tenant_id,NEW.request_id,NEW.patient_id,NEW.setting_id,NEW.credential_revision,NEW.installation_id,NEW.provider_account_id,NEW.livemode,NEW.return_url,NEW.requested_by,NEW.consent_scope,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.tenant_id,OLD.request_id,OLD.patient_id,OLD.setting_id,OLD.credential_revision,OLD.installation_id,OLD.provider_account_id,OLD.livemode,OLD.return_url,OLD.requested_by,OLD.consent_scope,OLD.created_at)
 THEN RAISE EXCEPTION 'Hosted setup identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER patient_payment_setup_identity BEFORE UPDATE OR DELETE ON patient_payment_setups
 FOR EACH ROW EXECUTE FUNCTION preserve_patient_payment_setup_identity();
