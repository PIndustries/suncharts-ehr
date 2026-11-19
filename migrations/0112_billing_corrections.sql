-- SPDX-License-Identifier: AGPL-3.0-only
-- Billing codes stay correctable after a visit is signed and after its charges are posted.
-- The clinical note stays locked. A correction is allowed only inside a transaction where the
-- server has set `suncharts.billing_correction` to 'on' (SET LOCAL), which it does only in its
-- billing-correction paths, each of which records who changed what and why. Every other write
-- keeps the old guards: signed diagnoses, posted charges and their diagnosis links stay
-- immutable to anything else, void accounts stay immutable to everything.

CREATE FUNCTION billing_correction_allowed() RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT coalesce(current_setting('suncharts.billing_correction', true), '') = 'on'
$$;

-- Visit diagnoses: the rooming guard, except that a billing correction may change the
-- diagnosis list of a signed visit. The visit itself must still exist and the row identity
-- must not move.
CREATE FUNCTION preserve_signed_diagnoses() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE visit_status text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.visit_id IS DISTINCT FROM OLD.visit_id THEN
            RAISE EXCEPTION 'diagnosis identity is immutable' USING ERRCODE = '23514';
        END IF;
    END IF;
    SELECT status INTO visit_status FROM visits
      WHERE tenant_id = NEW.tenant_id AND id = NEW.visit_id FOR SHARE;
    IF visit_status = 'signed' AND NOT billing_correction_allowed() THEN
        RAISE EXCEPTION 'signed diagnoses change only through a billing correction' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER signed_diagnoses_immutable ON visit_diagnoses;
CREATE TRIGGER signed_diagnoses_immutable BEFORE INSERT OR UPDATE ON visit_diagnoses
FOR EACH ROW EXECUTE FUNCTION preserve_signed_diagnoses();

-- Posted charges: a billing correction may change the lines, total and diagnosis links of a
-- POSTED account. Status, patient, visit, coverage and history links never move, and a void
-- account never changes.
CREATE OR REPLACE FUNCTION protect_posted_billing() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status = 'posted' AND NEW.status = 'posted' AND billing_correction_allowed()
    AND NEW.patient_id = OLD.patient_id AND NEW.visit_id IS NOT DISTINCT FROM OLD.visit_id
    AND NEW.coverage_id IS NOT DISTINCT FROM OLD.coverage_id
    AND NEW.coverage_snapshot IS NOT DISTINCT FROM OLD.coverage_snapshot
    AND NEW.source_history_id IS NOT DISTINCT FROM OLD.source_history_id
    AND NEW.tenant_id = OLD.tenant_id AND NEW.id = OLD.id THEN
  RETURN NEW;
 END IF;
 IF OLD.status IN ('posted','void') AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.total_cents<>OLD.total_cents
 OR NEW.coverage_snapshot IS DISTINCT FROM OLD.coverage_snapshot OR NEW.patient_id<>OLD.patient_id
 OR NEW.visit_id IS DISTINCT FROM OLD.visit_id OR NEW.coverage_id IS DISTINCT FROM OLD.coverage_id
 OR NEW.source_history_id IS DISTINCT FROM OLD.source_history_id OR NEW.status<>OLD.status
 OR NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id) THEN
 RAISE EXCEPTION 'posted or void billing content is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION preserve_final_diagnosis_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'billing_accounts' AND OLD.status = 'posted' AND NEW.status = 'posted'
       AND billing_correction_allowed() AND NEW.visit_id IS NOT DISTINCT FROM OLD.visit_id THEN
        RETURN NEW;
    END IF;
    IF OLD.status <> 'draft' AND (NEW.diagnosis_snapshot IS DISTINCT FROM OLD.diagnosis_snapshot OR NEW.visit_id IS DISTINCT FROM OLD.visit_id) THEN
        RAISE EXCEPTION 'finalized diagnosis links are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
