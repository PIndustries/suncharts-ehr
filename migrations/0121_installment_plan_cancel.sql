-- Staff can cancel a payment plan. Cancelling changes only the three cancellation columns
-- (and the version); the agreed schedule and consent stay immutable, payments already
-- taken stay as they are, and a cancelled plan frees its statement for a new plan.
ALTER TABLE patient_installment_plans
 ADD COLUMN cancelled_at timestamptz,
 ADD COLUMN cancelled_by uuid,
 ADD COLUMN cancel_reason text;
ALTER TABLE patient_installment_plans
 ADD CONSTRAINT installment_plan_cancel_complete CHECK(
  (cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL)
  OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL));
-- One plan per statement, counting only plans that have not been cancelled.
ALTER TABLE patient_installment_plans DROP CONSTRAINT patient_installment_plans_tenant_id_invoice_id_key;
CREATE UNIQUE INDEX installment_plan_one_active_per_invoice ON patient_installment_plans(tenant_id,invoice_id)
 WHERE cancelled_at IS NULL;
CREATE INDEX installment_plan_invoice ON patient_installment_plans(tenant_id,invoice_id);
CREATE OR REPLACE FUNCTION protect_installment_plan() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['version','cancelled_at','cancelled_by','cancel_reason'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','cancelled_at','cancelled_by','cancel_reason'])
  OR NEW.version<OLD.version
  OR (OLD.cancelled_at IS NOT NULL AND (NEW.cancelled_at,NEW.cancelled_by,NEW.cancel_reason)
      IS DISTINCT FROM (OLD.cancelled_at,OLD.cancelled_by,OLD.cancel_reason))
 THEN RAISE EXCEPTION 'installment contract is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
