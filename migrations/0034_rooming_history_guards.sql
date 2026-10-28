-- SPDX-License-Identifier: AGPL-3.0-only
-- Preserve attributed intake and protect it if future writers omit application checks.
CREATE TRIGGER rooming_revision_immutable BEFORE UPDATE OR DELETE ON visit_rooming_revisions
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER rooming_intake_no_delete BEFORE DELETE ON visit_rooming
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
ALTER TABLE visit_rooming ADD CONSTRAINT rooming_ready_requires_review
CHECK (status <> 'ready' OR (length(trim(chief_complaint)) > 0 AND medications_reviewed AND allergies_reviewed));
CREATE FUNCTION preserve_signed_rooming() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE visit_status text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.visit_id IS DISTINCT FROM OLD.visit_id THEN
            RAISE EXCEPTION 'rooming identity is immutable' USING ERRCODE = '23514';
        END IF;
    END IF;
    SELECT status INTO visit_status FROM visits
      WHERE tenant_id = NEW.tenant_id AND id = NEW.visit_id FOR SHARE;
    IF visit_status = 'signed' THEN
        RAISE EXCEPTION 'signed intake is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER signed_rooming_immutable BEFORE INSERT OR UPDATE ON visit_rooming
FOR EACH ROW EXECUTE FUNCTION preserve_signed_rooming();
