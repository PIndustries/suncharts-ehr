-- SPDX-License-Identifier: AGPL-3.0-only
-- Every ledger writer, including remittance posting, respects outstanding hosted checkout reservations.
CREATE FUNCTION protect_hosted_payment_reservations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE remaining bigint; reserved bigint;
BEGIN
 IF NEW.effect_cents >= 0 OR NEW.content ? 'managed_payment_id' THEN RETURN NEW; END IF;
 SELECT b.total_cents INTO remaining FROM billing_accounts b WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.account_id FOR UPDATE;
 SELECT coalesce(sum(effect_cents),0) INTO reserved FROM billing_entries WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id;
 remaining := remaining+reserved+NEW.effect_cents;
 SELECT coalesce(sum(amount_cents),0) INTO reserved FROM payment_attempts
 WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id AND status IN ('creating','open','needs_review') AND paid_entry_id IS NULL;
 IF reserved>0 AND remaining<reserved THEN
  RAISE EXCEPTION 'account balance reserved by hosted checkout; expire or reconcile checkout before reducing balance' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_hosted_payment_reservations BEFORE INSERT ON billing_entries FOR EACH ROW EXECUTE FUNCTION protect_hosted_payment_reservations();
