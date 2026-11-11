-- Appointment-bound hosted checkout is separate from legacy posted-account payments.
CREATE TABLE copay_checkout_attempts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,appointment_id uuid NOT NULL,
 coverage_id uuid,coverage_snapshot jsonb,
 setting_id uuid NOT NULL,credential_revision bigint NOT NULL,installation_id uuid NOT NULL,
 provider_account_id text NOT NULL,livemode boolean NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 50 AND 100000000),
 currency text NOT NULL DEFAULT 'usd' CHECK(currency='usd'),
 request_id uuid NOT NULL,creation_hash text NOT NULL,requested_by uuid NOT NULL,reason text NOT NULL,return_url text NOT NULL,
 status text NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','open','paid','expired','needs_review','refunded')),
 provider_session_id text,provider_payment_intent text,provider_charge_id text,provider_captured_at timestamptz,checkout_url text,receipt_id uuid,
 refunded_cents bigint NOT NULL DEFAULT 0 CHECK(refunded_cents BETWEEN 0 AND amount_cents),
 version bigint NOT NULL DEFAULT 1,attempts integer NOT NULL DEFAULT 0,
 next_poll_at timestamptz NOT NULL DEFAULT now(),lease_id uuid,lease_until timestamptz,last_result text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,receipt_id),
 UNIQUE(setting_id,provider_account_id,livemode,provider_session_id),
 UNIQUE(provider_account_id,livemode,provider_charge_id),
 UNIQUE(provider_account_id,livemode,provider_payment_intent),
 FOREIGN KEY(tenant_id,appointment_id,patient_id) REFERENCES appointments(tenant_id,id,patient_id),
 FOREIGN KEY(tenant_id,coverage_id,patient_id) REFERENCES insurance_coverages(tenant_id,id,patient_id),
 FOREIGN KEY(tenant_id,setting_id,credential_revision) REFERENCES payment_credentials(tenant_id,setting_id,revision),
 FOREIGN KEY(tenant_id,receipt_id,patient_id) REFERENCES billing_copay_receipts(tenant_id,id,patient_id)
);
CREATE UNIQUE INDEX copay_checkout_one_unresolved_appointment ON copay_checkout_attempts(tenant_id,appointment_id)
 WHERE status IN ('creating','open','needs_review') AND receipt_id IS NULL;
CREATE INDEX copay_checkout_poll ON copay_checkout_attempts(next_poll_at,lease_until) WHERE status<>'expired';
CREATE TABLE copay_checkout_events (
 tenant_id uuid NOT NULL,operation_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,
 action text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,operation_id,version),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES copay_checkout_attempts(tenant_id,id)
);
CREATE FUNCTION protect_copay_checkout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.patient_id<>OLD.patient_id
 OR NEW.appointment_id<>OLD.appointment_id OR NEW.coverage_id IS DISTINCT FROM OLD.coverage_id
 OR NEW.coverage_snapshot IS DISTINCT FROM OLD.coverage_snapshot OR NEW.setting_id<>OLD.setting_id
 OR NEW.credential_revision<>OLD.credential_revision OR NEW.installation_id<>OLD.installation_id
 OR NEW.provider_account_id<>OLD.provider_account_id OR NEW.livemode<>OLD.livemode
 OR NEW.amount_cents<>OLD.amount_cents OR NEW.currency<>OLD.currency OR NEW.request_id<>OLD.request_id
 OR NEW.creation_hash<>OLD.creation_hash OR NEW.requested_by<>OLD.requested_by OR NEW.reason<>OLD.reason
 OR NEW.return_url<>OLD.return_url OR NEW.created_at<>OLD.created_at
 OR (OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id)
 OR (OLD.provider_payment_intent IS NOT NULL AND NEW.provider_payment_intent IS DISTINCT FROM OLD.provider_payment_intent)
 OR (OLD.provider_charge_id IS NOT NULL AND NEW.provider_charge_id IS DISTINCT FROM OLD.provider_charge_id)
 OR (OLD.provider_captured_at IS NOT NULL AND NEW.provider_captured_at IS DISTINCT FROM OLD.provider_captured_at)
 OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id)
 OR NEW.refunded_cents<OLD.refunded_cents
 THEN RAISE EXCEPTION 'hosted copay binding and captured evidence are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER copay_checkout_protected BEFORE UPDATE ON copay_checkout_attempts FOR EACH ROW EXECUTE FUNCTION protect_copay_checkout();
CREATE TRIGGER copay_checkout_no_delete BEFORE DELETE ON copay_checkout_attempts FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER copay_checkout_events_immutable BEFORE UPDATE OR DELETE ON copay_checkout_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

-- Verified refund observations append accounting evidence; original receipts stay immutable.
CREATE TABLE copay_checkout_refund_events (
 tenant_id uuid NOT NULL,operation_id uuid NOT NULL,cumulative_cents bigint NOT NULL,
 delta_cents bigint NOT NULL CHECK(delta_cents>0),unapplied_cents bigint NOT NULL CHECK(unapplied_cents>=0),
 actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,operation_id,cumulative_cents),
 CHECK(cumulative_cents>0 AND delta_cents<=cumulative_cents AND unapplied_cents<=delta_cents),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES copay_checkout_attempts(tenant_id,id)
);
CREATE TABLE copay_checkout_refund_allocations (
 tenant_id uuid NOT NULL,operation_id uuid NOT NULL,cumulative_cents bigint NOT NULL,
 account_id uuid NOT NULL,allocation_entry_id uuid NOT NULL,entry_id uuid,
 amount_cents bigint NOT NULL CHECK(amount_cents>0),
 PRIMARY KEY(tenant_id,operation_id,cumulative_cents,allocation_entry_id),
 UNIQUE(tenant_id,entry_id),
 FOREIGN KEY(tenant_id,operation_id,cumulative_cents) REFERENCES copay_checkout_refund_events(tenant_id,operation_id,cumulative_cents),
 FOREIGN KEY(tenant_id,allocation_entry_id,account_id) REFERENCES billing_entries(tenant_id,id,account_id),
 FOREIGN KEY(tenant_id,entry_id,account_id) REFERENCES billing_entries(tenant_id,id,account_id)
);
CREATE TRIGGER copay_checkout_refund_events_immutable BEFORE UPDATE OR DELETE ON copay_checkout_refund_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER copay_checkout_refund_allocations_immutable BEFORE UPDATE OR DELETE ON copay_checkout_refund_allocations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
