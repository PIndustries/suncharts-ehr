-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE lab_orders ADD COLUMN diagnosis_snapshot jsonb;
ALTER TABLE billing_accounts ADD COLUMN diagnosis_snapshot jsonb;
ALTER TABLE lab_orders ADD CONSTRAINT order_diagnosis_snapshot_object CHECK (diagnosis_snapshot IS NULL OR jsonb_typeof(diagnosis_snapshot)='object');
ALTER TABLE billing_accounts ADD CONSTRAINT account_diagnosis_snapshot_object CHECK (diagnosis_snapshot IS NULL OR jsonb_typeof(diagnosis_snapshot)='object');
CREATE FUNCTION preserve_final_diagnosis_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'draft' AND (NEW.diagnosis_snapshot IS DISTINCT FROM OLD.diagnosis_snapshot OR NEW.visit_id IS DISTINCT FROM OLD.visit_id) THEN
        RAISE EXCEPTION 'finalized diagnosis links are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER order_final_diagnosis_links BEFORE UPDATE ON lab_orders FOR EACH ROW EXECUTE FUNCTION preserve_final_diagnosis_links();
CREATE TRIGGER account_final_diagnosis_links BEFORE UPDATE ON billing_accounts FOR EACH ROW EXECUTE FUNCTION preserve_final_diagnosis_links();
