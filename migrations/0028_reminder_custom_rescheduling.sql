-- SPDX-License-Identifier: AGPL-3.0-only
-- Preserve unsent custom offsets through rescheduling while retaining immutable
-- original definitions. Attempted, accepted and completed contact is never cloned.
CREATE OR REPLACE FUNCTION reminder_observe_appointment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE custom_ids uuid[]; prior appointment_reminders%ROWTYPE; pref patient_reminder_preferences%ROWTYPE;
 reminder_id uuid; valid boolean; initial text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text,1));
 IF TG_OP='UPDATE' AND NEW.starts_at IS DISTINCT FROM OLD.starts_at AND NEW.status='booked' AND NEW.starts_at>now() THEN
  SELECT array_agg(id) INTO custom_ids FROM appointment_reminders
   WHERE tenant_id=NEW.tenant_id AND appointment_id=NEW.id AND definition_key LIKE 'custom:%'
   AND NOT invalidated AND status IN ('scheduled','needs_contact') AND first_attempt_at IS NULL;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.status IS DISTINCT FROM OLD.status) THEN
  PERFORM reminder_invalidate(NEW.tenant_id,NEW.id,'appointment_changed',CASE WHEN NEW.status='booked' THEN 'superseded' ELSE 'cancelled' END);
 END IF;
 IF TG_OP='INSERT' OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.status IS DISTINCT FROM OLD.status THEN
  PERFORM reminder_defaults(NEW.tenant_id,NEW.id);
 END IF;
 IF custom_ids IS NOT NULL THEN
  SELECT * INTO pref FROM patient_reminder_preferences WHERE tenant_id=NEW.tenant_id AND patient_id=NEW.patient_id;
  valid:=FOUND AND pref.consented AND pref.verified AND EXISTS(SELECT 1 FROM patient_demographics d WHERE d.tenant_id=NEW.tenant_id AND d.patient_id=NEW.patient_id AND d.content->>pref.channel=pref.destination);
  FOR prior IN SELECT * FROM appointment_reminders WHERE tenant_id=NEW.tenant_id AND id=ANY(custom_ids) LOOP
   reminder_id:=gen_random_uuid();
   initial:=CASE WHEN NEW.starts_at-make_interval(mins=>prior.before_minutes)<=now() THEN 'missed' WHEN valid THEN 'scheduled' ELSE 'needs_contact' END;
   -- Explicit custom definitions remain distinct even if their offset matches a default.
   INSERT INTO appointment_reminders(tenant_id,id,appointment_id,patient_id,request_id,creation_hash,definition_key,before_minutes,due_at,starts_at,appointment_version,preference_version,channel,destination,automatic_email,status,last_result)
    VALUES(NEW.tenant_id,reminder_id,NEW.id,NEW.patient_id,reminder_id,'rescheduled_custom:'||prior.id,'custom:'||reminder_id,prior.before_minutes,NEW.starts_at-make_interval(mins=>prior.before_minutes),NEW.starts_at,NEW.version,pref.version,coalesce(pref.channel,'phone'),CASE WHEN valid THEN pref.destination ELSE NULL END,coalesce(valid AND pref.automatic_email,false),initial,CASE WHEN initial='missed' THEN 'custom_window_already_elapsed' ELSE 'custom_rescheduled' END);
   PERFORM reminder_record_event(NEW.tenant_id,reminder_id,reminder_system_actor(),'custom_rescheduled','Unsent custom offset preserved from reminder '||prior.id);
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
