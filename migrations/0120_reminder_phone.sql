-- SPDX-License-Identifier: AGPL-3.0-only
-- Appointment reminders by text message or automated call, sent through the practice's own
-- Twilio account. The practice saves its account, a sending number and a credential; a patient
-- who has agreed can be reminded by text or by call at the phone number on file.
CREATE TABLE reminder_phone_settings (
 tenant_id uuid PRIMARY KEY,id uuid NOT NULL UNIQUE,account_sid text NOT NULL CHECK(account_sid ~ '^AC[0-9a-f]{32}$'),
 from_number text NOT NULL CHECK(from_number ~ '^\+[1-9][0-9]{7,14}$'),credential_revision bigint NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false,verified boolean NOT NULL DEFAULT false,last_test_at timestamptz,last_test_result text,
 version bigint NOT NULL DEFAULT 1,UNIQUE(tenant_id,id)
);
CREATE TABLE reminder_phone_credentials (
 tenant_id uuid NOT NULL,setting_id uuid NOT NULL,revision bigint NOT NULL,encrypted_key bytea NOT NULL,account_sid text NOT NULL,from_number text NOT NULL,
 PRIMARY KEY(tenant_id,setting_id,revision),FOREIGN KEY(tenant_id,setting_id) REFERENCES reminder_phone_settings(tenant_id,id)
);
CREATE TRIGGER reminder_phone_credentials_immutable BEFORE UPDATE OR DELETE ON reminder_phone_credentials FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE reminder_phone_events (
 tenant_id uuid NOT NULL,setting_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,action text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,setting_id,version),FOREIGN KEY(tenant_id,setting_id) REFERENCES reminder_phone_settings(tenant_id,id)
);
CREATE TRIGGER reminder_phone_events_immutable BEFORE UPDATE OR DELETE ON reminder_phone_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
ALTER TABLE patient_reminder_preferences ADD COLUMN automatic_phone text CHECK(automatic_phone IN ('text','call'));
ALTER TABLE patient_reminder_preferences ADD CHECK(automatic_phone IS NULL OR (channel='phone' AND consented AND verified));
ALTER TABLE appointment_reminders ADD COLUMN automatic_phone text CHECK(automatic_phone IN ('text','call'));
ALTER TABLE appointment_reminders ADD CHECK(automatic_phone IS NULL OR (channel='phone' AND NOT automatic_email));
ALTER TABLE appointment_reminders ADD COLUMN phone_setting_id uuid,ADD COLUMN phone_revision bigint,ADD COLUMN provider_ref text;
ALTER TABLE appointment_reminders ADD FOREIGN KEY(tenant_id,phone_setting_id,phone_revision) REFERENCES reminder_phone_credentials(tenant_id,setting_id,revision);
CREATE OR REPLACE FUNCTION reminder_defaults(t uuid,a uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ap appointments%ROWTYPE; pref patient_reminder_preferences%ROWTYPE; before_mins integer; reminder_id uuid; valid boolean; initial text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text,1));
 SELECT * INTO ap FROM appointments WHERE tenant_id=t AND id=a;
 IF NOT FOUND OR ap.status<>'booked' OR ap.starts_at<=now() THEN RETURN; END IF;
 SELECT * INTO pref FROM patient_reminder_preferences WHERE tenant_id=t AND patient_id=ap.patient_id;
 valid:=FOUND AND pref.consented AND pref.verified AND EXISTS(SELECT 1 FROM patient_demographics d WHERE d.tenant_id=t AND d.patient_id=ap.patient_id AND d.content->>pref.channel=pref.destination);
 FOREACH before_mins IN ARRAY ARRAY[1440,120] LOOP
  IF EXISTS(SELECT 1 FROM appointment_reminders WHERE tenant_id=t AND appointment_id=a AND starts_at=ap.starts_at AND before_minutes=before_mins AND (status IN ('accepted','delivered','manual_contacted') OR (status IN ('sending','needs_review') AND first_attempt_at IS NOT NULL))) THEN CONTINUE; END IF;
  reminder_id:=gen_random_uuid();
  initial:=CASE WHEN ap.starts_at-make_interval(mins=>before_mins)<=now() THEN 'missed' WHEN valid THEN 'scheduled' ELSE 'needs_contact' END;
  INSERT INTO appointment_reminders(tenant_id,id,appointment_id,patient_id,request_id,creation_hash,definition_key,before_minutes,due_at,starts_at,appointment_version,preference_version,channel,destination,automatic_email,automatic_phone,status,last_result)
   VALUES(t,reminder_id,a,ap.patient_id,reminder_id,'automatic_default',format('default:%s:%s:%s',before_mins,ap.version,coalesce(pref.version,0)),before_mins,ap.starts_at-make_interval(mins=>before_mins),ap.starts_at,ap.version,pref.version,coalesce(pref.channel,'phone'),CASE WHEN valid THEN pref.destination ELSE NULL END,coalesce(valid AND pref.automatic_email,false),CASE WHEN valid THEN pref.automatic_phone ELSE NULL END,initial,CASE WHEN initial='missed' THEN 'default_window_already_elapsed' ELSE 'default_queued' END)
   ON CONFLICT(tenant_id,appointment_id,definition_key) DO NOTHING;
  IF FOUND THEN PERFORM reminder_record_event(t,reminder_id,reminder_system_actor(),'default_scheduled','Default reminder observed from appointment state'); END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION reminder_observe_preferences() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ap record; actor uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text,1));
 actor:=coalesce(nullif(current_setting('suncharts.reminder_actor',true),'')::uuid,reminder_system_actor());
 INSERT INTO patient_reminder_preference_history(tenant_id,patient_id,version,content,reason,actor_id) VALUES(NEW.tenant_id,NEW.patient_id,NEW.version,jsonb_build_object('channel',NEW.channel,'destination',NEW.destination,'consented',NEW.consented,'verified',NEW.verified,'automatic_email',NEW.automatic_email,'automatic_phone',NEW.automatic_phone),NEW.reason,actor);
 INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES(NEW.tenant_id,actor,'appointment.reminder_preference_change',NEW.patient_id);
 FOR ap IN SELECT id FROM appointments WHERE tenant_id=NEW.tenant_id AND patient_id=NEW.patient_id AND status='booked' AND starts_at>now() LOOP
  PERFORM reminder_invalidate(NEW.tenant_id,ap.id,'contact_permission_or_verification_changed','superseded');
  IF NEW.consented AND NEW.verified THEN PERFORM reminder_defaults(NEW.tenant_id,ap.id); END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reminder_observe_contact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.content->>'email' IS DISTINCT FROM OLD.content->>'email' OR NEW.content->>'phone' IS DISTINCT FROM OLD.content->>'phone' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('schedule:'||NEW.tenant_id,0));
  UPDATE patient_reminder_preferences SET verified=false,automatic_email=false,automatic_phone=NULL,version=version+1,reason='Native contact changed; explicit permission and destination must be reviewed' WHERE tenant_id=NEW.tenant_id AND patient_id=NEW.patient_id AND verified;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION protect_reminder_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.appointment_id<>OLD.appointment_id OR NEW.patient_id<>OLD.patient_id OR NEW.request_id<>OLD.request_id OR NEW.definition_key<>OLD.definition_key OR NEW.starts_at<>OLD.starts_at OR NEW.due_at<>OLD.due_at OR NEW.before_minutes<>OLD.before_minutes OR NEW.destination IS DISTINCT FROM OLD.destination OR NEW.channel<>OLD.channel OR NEW.automatic_email<>OLD.automatic_email OR NEW.automatic_phone IS DISTINCT FROM OLD.automatic_phone THEN RAISE EXCEPTION 'Reminder identity and message inputs are immutable' USING ERRCODE='23514'; END IF;
 NEW.version:=OLD.version+1; NEW.updated_at:=now();
 RETURN NEW;
END $$;
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
   INSERT INTO appointment_reminders(tenant_id,id,appointment_id,patient_id,request_id,creation_hash,definition_key,before_minutes,due_at,starts_at,appointment_version,preference_version,channel,destination,automatic_email,automatic_phone,status,last_result)
    VALUES(NEW.tenant_id,reminder_id,NEW.id,NEW.patient_id,reminder_id,'rescheduled_custom:'||prior.id,'custom:'||reminder_id,prior.before_minutes,NEW.starts_at-make_interval(mins=>prior.before_minutes),NEW.starts_at,NEW.version,pref.version,coalesce(pref.channel,'phone'),CASE WHEN valid THEN pref.destination ELSE NULL END,coalesce(valid AND pref.automatic_email,false),CASE WHEN valid THEN pref.automatic_phone ELSE NULL END,initial,CASE WHEN initial='missed' THEN 'custom_window_already_elapsed' ELSE 'custom_rescheduled' END);
   PERFORM reminder_record_event(NEW.tenant_id,reminder_id,reminder_system_actor(),'custom_rescheduled','Unsent custom offset preserved from reminder '||prior.id);
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reminder_invalidate(t uuid,a uuid,why text,terminal text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text,1));
 FOR r IN UPDATE appointment_reminders SET invalidated=true,status=CASE WHEN status='sending' THEN 'sending' WHEN first_attempt_at IS NOT NULL THEN 'needs_review' ELSE terminal END,last_result=why,version=version+1,updated_at=now()
 WHERE tenant_id=t AND appointment_id=a AND status IN ('scheduled','needs_contact','failed','sending','needs_review') AND provider_id IS NULL AND provider_ref IS NULL AND NOT invalidated RETURNING id LOOP
  PERFORM reminder_record_event(t,r.id,reminder_system_actor(),'appointment_or_contact_changed',why);
 END LOOP;
END $$;
