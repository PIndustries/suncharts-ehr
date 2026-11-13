-- Card payments taken on a reader reuse the hosted card attempt tables, so receipts, ledger
-- entries, allocation, refund observation and review all stay on one path. Additive only:
-- every existing row keeps channel 'hosted' and no reader.
ALTER TABLE copay_checkout_attempts
 ADD COLUMN channel text NOT NULL DEFAULT 'hosted' CHECK(channel IN ('hosted','reader')),
 ADD COLUMN reader_id text CHECK(reader_id IS NULL OR reader_id ~ '^tmr_[A-Za-z0-9]+$'),
 ADD COLUMN reader_cancel_requested_at timestamptz,
 ADD CONSTRAINT copay_checkout_reader_channel CHECK((channel='reader')=(reader_id IS NOT NULL));
ALTER TABLE invoice_checkout_attempts
 ADD COLUMN channel text NOT NULL DEFAULT 'hosted' CHECK(channel IN ('hosted','reader')),
 ADD COLUMN reader_id text CHECK(reader_id IS NULL OR reader_id ~ '^tmr_[A-Za-z0-9]+$'),
 ADD COLUMN reader_cancel_requested_at timestamptz,
 ADD CONSTRAINT invoice_checkout_reader_channel CHECK((channel='reader')=(reader_id IS NOT NULL));

-- Open reader payments are checked every couple of seconds.
CREATE INDEX copay_checkout_reader_poll ON copay_checkout_attempts(next_poll_at)
 WHERE channel='reader' AND status IN ('creating','open');
CREATE INDEX invoice_checkout_reader_poll ON invoice_checkout_attempts(next_poll_at)
 WHERE channel='reader' AND status IN ('creating','open');

-- The channel and reader are part of the immutable binding; a cancel request is never withdrawn.
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
 OR (OLD.reader_cancel_requested_at IS NOT NULL AND NEW.reader_cancel_requested_at IS DISTINCT FROM OLD.reader_cancel_requested_at)
 OR (OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id)
 OR (OLD.provider_payment_intent IS NOT NULL AND NEW.provider_payment_intent IS DISTINCT FROM OLD.provider_payment_intent)
 OR (OLD.provider_charge_id IS NOT NULL AND NEW.provider_charge_id IS DISTINCT FROM OLD.provider_charge_id)
 OR (OLD.provider_captured_at IS NOT NULL AND NEW.provider_captured_at IS DISTINCT FROM OLD.provider_captured_at)
 OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id)
 OR NEW.refunded_cents<OLD.refunded_cents
 THEN RAISE EXCEPTION 'hosted copay binding and captured evidence are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION protect_invoice_checkout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','provider_session_id','provider_payment_intent','provider_charge_id','provider_captured_at','checkout_url','paid_entry_id','refunded_cents','version','attempts','next_poll_at','lease_id','lease_until','last_result','updated_at','reader_cancel_requested_at'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','provider_session_id','provider_payment_intent','provider_charge_id','provider_captured_at','checkout_url','paid_entry_id','refunded_cents','version','attempts','next_poll_at','lease_id','lease_until','last_result','updated_at','reader_cancel_requested_at'])
 OR (OLD.reader_cancel_requested_at IS NOT NULL AND NEW.reader_cancel_requested_at IS DISTINCT FROM OLD.reader_cancel_requested_at)
 OR (OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id)
 OR (OLD.provider_payment_intent IS NOT NULL AND NEW.provider_payment_intent IS DISTINCT FROM OLD.provider_payment_intent)
 OR (OLD.provider_charge_id IS NOT NULL AND NEW.provider_charge_id IS DISTINCT FROM OLD.provider_charge_id)
 OR (OLD.provider_captured_at IS NOT NULL AND NEW.provider_captured_at IS DISTINCT FROM OLD.provider_captured_at)
 OR (OLD.paid_entry_id IS NOT NULL AND NEW.paid_entry_id IS DISTINCT FROM OLD.paid_entry_id)
 OR NEW.refunded_cents<OLD.refunded_cents OR NEW.version<OLD.version
 THEN RAISE EXCEPTION 'invoice checkout binding and captured evidence are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
