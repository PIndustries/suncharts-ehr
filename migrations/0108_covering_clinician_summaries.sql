-- SPDX-License-Identifier: AGPL-3.0-only
-- A clinician covering a colleague's visit may sign its note, so the same clinician
-- must be able to release and publish its patient summary. Until now both guards
-- accepted only the visit's assigned clinician. They now accept whoever may sign:
-- the assigned clinician, the person who signed, or an enabled owner or clinician
-- of the practice. No table, column or existing row changes.
CREATE OR REPLACE FUNCTION validate_avs_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM visits v WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.visit_id AND v.status='signed'
   AND (v.clinician_id=NEW.released_by OR v.signed_by=NEW.released_by
     OR EXISTS(SELECT 1 FROM browser_users u WHERE u.tenant_id=v.tenant_id AND u.id=NEW.released_by AND u.role IN ('owner','clinician') AND NOT u.disabled)))
 THEN RAISE EXCEPTION 'a clinician must release signed visit instructions'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION patient_portal_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM visits v WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.visit_id AND v.patient_id=NEW.patient_id AND v.status='signed'
   AND (v.clinician_id=NEW.released_by OR v.signed_by=NEW.released_by
     OR EXISTS(SELECT 1 FROM browser_users u WHERE u.tenant_id=v.tenant_id AND u.id=NEW.released_by AND u.role IN ('owner','clinician') AND NOT u.disabled)))
 THEN RAISE EXCEPTION 'a clinician must publish signed visit instructions'; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.patient_id<>OLD.patient_id OR NEW.visit_id<>OLD.visit_id OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'invalid portal publication version or identity'; END IF;
 RETURN NEW;
END $$;
