-- Charging a saved card later, and cancelling an unfinished card link. Additive only: every
-- existing row keeps its values, and every card saved before this change keeps the
-- 'patient_present' scope, so it can never be charged without the patient.

-- A card setup now records what the patient agreed to. 'later_charges' is the wording shown on
-- the card page (its version is kept) and the time the processor confirmed the saved card.
ALTER TABLE patient_payment_setups
 DROP CONSTRAINT patient_payment_setups_consent_scope_check,
 ADD CONSTRAINT patient_payment_setups_consent_scope_check CHECK(consent_scope IN ('patient_present','later_charges')),
 ADD COLUMN consent_version text,
 ADD COLUMN consent_recorded_at timestamptz,
 ADD COLUMN cancelled_at timestamptz,
 ADD COLUMN cancelled_by uuid,
 ADD CONSTRAINT patient_payment_setup_consent_version CHECK((consent_scope='later_charges')=(consent_version IS NOT NULL)),
 ADD CONSTRAINT patient_payment_setup_consent_time CHECK(consent_recorded_at IS NULL OR consent_scope='later_charges');

-- A saved-card charge is one more channel on the existing card attempt tables, so receipts,
-- ledger entries, allocation, refunds and review stay on one path. `saved_card_setup_id` is the
-- card setup whose consent allows the charge. `reader_cancel_requested_at` also records a staff
-- request to cancel an unfinished card link.
ALTER TABLE copay_checkout_attempts
 DROP CONSTRAINT copay_checkout_attempts_channel_check,
 ADD CONSTRAINT copay_checkout_attempts_channel_check CHECK(channel IN ('hosted','reader','saved_card')),
 ADD COLUMN saved_card_setup_id uuid,
 ADD CONSTRAINT copay_checkout_saved_card_channel CHECK((channel='saved_card')=(saved_card_setup_id IS NOT NULL)),
 ADD CONSTRAINT copay_checkout_saved_card_setup FOREIGN KEY(tenant_id,saved_card_setup_id) REFERENCES patient_payment_setups(tenant_id,request_id);
ALTER TABLE invoice_checkout_attempts
 DROP CONSTRAINT invoice_checkout_attempts_channel_check,
 ADD CONSTRAINT invoice_checkout_attempts_channel_check CHECK(channel IN ('hosted','reader','saved_card')),
 ADD COLUMN saved_card_setup_id uuid,
 ADD CONSTRAINT invoice_checkout_saved_card_channel CHECK((channel='saved_card')=(saved_card_setup_id IS NOT NULL)),
 ADD CONSTRAINT invoice_checkout_saved_card_setup FOREIGN KEY(tenant_id,saved_card_setup_id) REFERENCES patient_payment_setups(tenant_id,request_id);

-- The consenting card setup is part of the immutable binding of a copay attempt. The invoice
-- trigger already treats every column outside its short list as immutable.
CREATE OR REPLACE FUNCTION protect_copay_checkout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.patient_id<>OLD.patient_id
 OR NEW.appointment_id<>OLD.appointment_id OR NEW.coverage_id IS DISTINCT FROM OLD.coverage_id
 OR NEW.coverage_snapshot IS DISTINCT FROM OLD.coverage_snapshot OR NEW.setting_id<>OLD.setting_id
 OR NEW.credential_revision<>OLD.credential_revision OR NEW.installation_id<>OLD.installation_id
 OR NEW.provider_account_id<>OLD.provider_account_id OR NEW.livemode<>OLD.livemode
 OR NEW.amount_cents<>OLD.amount_cents OR NEW.currency<>OLD.currency OR NEW.request_id<>OLD.request_id
 OR NEW.creation_hash<>OLD.creation_hash OR NEW.requested_by<>OLD.requested_by OR NEW.reason<>OLD.reason
 OR NEW.return_url<>OLD.return_url OR NEW.created_at<>OLD.created_at
 OR NEW.channel<>OLD.channel OR NEW.reader_id IS DISTINCT FROM OLD.reader_id
 OR NEW.saved_card_setup_id IS DISTINCT FROM OLD.saved_card_setup_id
 OR (OLD.reader_cancel_requested_at IS NOT NULL AND NEW.reader_cancel_requested_at IS DISTINCT FROM OLD.reader_cancel_requested_at)
 OR (OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id)
 OR (OLD.provider_payment_intent IS NOT NULL AND NEW.provider_payment_intent IS DISTINCT FROM OLD.provider_payment_intent)
 OR (OLD.provider_charge_id IS NOT NULL AND NEW.provider_charge_id IS DISTINCT FROM OLD.provider_charge_id)
 OR (OLD.provider_captured_at IS NOT NULL AND NEW.provider_captured_at IS DISTINCT FROM OLD.provider_captured_at)
 OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id)
 OR NEW.refunded_cents<OLD.refunded_cents
 THEN RAISE EXCEPTION 'hosted copay binding and captured evidence are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
