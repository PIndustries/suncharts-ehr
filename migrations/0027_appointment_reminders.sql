-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE reminder_sender_settings (
 tenant_id uuid PRIMARY KEY,id uuid NOT NULL UNIQUE,from_email text NOT NULL,credential_revision bigint NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false,verified boolean NOT NULL DEFAULT false,last_test_at timestamptz,last_test_result text,
 version bigint NOT NULL DEFAULT 1,UNIQUE(tenant_id,id)
);
CREATE TABLE reminder_credentials (
 tenant_id uuid NOT NULL,setting_id uuid NOT NULL,revision bigint NOT NULL,encrypted_key bytea NOT NULL,from_email text NOT NULL,
 PRIMARY KEY(tenant_id,setting_id,revision),FOREIGN KEY(tenant_id,setting_id) REFERENCES reminder_sender_settings(tenant_id,id)
);
CREATE TRIGGER reminder_credentials_immutable BEFORE UPDATE OR DELETE ON reminder_credentials FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE reminder_sender_events (
 tenant_id uuid NOT NULL,setting_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,action text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,setting_id,version),FOREIGN KEY(tenant_id,setting_id) REFERENCES reminder_sender_settings(tenant_id,id)
);
CREATE TRIGGER reminder_sender_events_immutable BEFORE UPDATE OR DELETE ON reminder_sender_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE patient_reminder_preferences (
 tenant_id uuid NOT NULL,patient_id uuid NOT NULL,channel text NOT NULL CHECK(channel IN ('email','phone')),destination text NOT NULL,
 consented boolean NOT NULL,verified boolean NOT NULL,automatic_email boolean NOT NULL,reason text NOT NULL,version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,patient_id),FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 CHECK(NOT automatic_email OR (channel='email' AND consented AND verified))
);
CREATE TABLE patient_reminder_preference_history (
 tenant_id uuid NOT NULL,patient_id uuid NOT NULL,version bigint NOT NULL,content jsonb NOT NULL,reason text NOT NULL,actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,patient_id,version),FOREIGN KEY(tenant_id,patient_id) REFERENCES patient_reminder_preferences(tenant_id,patient_id)
);
CREATE TRIGGER patient_reminder_preference_history_immutable BEFORE UPDATE OR DELETE ON patient_reminder_preference_history FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE appointment_reminders (
 tenant_id uuid NOT NULL,id uuid NOT NULL,appointment_id uuid NOT NULL,patient_id uuid NOT NULL,
 request_id uuid NOT NULL,creation_hash text NOT NULL,definition_key text NOT NULL,before_minutes integer NOT NULL CHECK(before_minutes BETWEEN 1 AND 525600),
 due_at timestamptz NOT NULL,starts_at timestamptz NOT NULL,appointment_version bigint NOT NULL,preference_version bigint,
 channel text NOT NULL CHECK(channel IN ('email','phone')),destination text,automatic_email boolean NOT NULL DEFAULT false,
 status text NOT NULL CHECK(status IN ('scheduled','needs_contact','sending','accepted','delivered','failed','manual_contacted','manual_no_answer','manual_failed','cancelled','superseded','missed','needs_review')),
 invalidated boolean NOT NULL DEFAULT false,version bigint NOT NULL DEFAULT 1,attempts integer NOT NULL DEFAULT 0,
 first_attempt_at timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_id uuid,lease_until timestamptz,
 sender_setting_id uuid,sender_revision bigint,from_email text,provider_id uuid,last_result text,last_poll_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,appointment_id,definition_key),
 FOREIGN KEY(tenant_id,appointment_id,patient_id) REFERENCES appointments(tenant_id,id,patient_id),
 FOREIGN KEY(tenant_id,sender_setting_id,sender_revision) REFERENCES reminder_credentials(tenant_id,setting_id,revision)
);
CREATE INDEX appointment_reminders_due ON appointment_reminders(status,next_attempt_at,due_at);
CREATE TABLE appointment_reminder_events (
 tenant_id uuid NOT NULL,reminder_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,action text NOT NULL,reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,reminder_id,version),
 FOREIGN KEY(tenant_id,reminder_id) REFERENCES appointment_reminders(tenant_id,id)
);
CREATE TRIGGER appointment_reminder_events_immutable BEFORE UPDATE OR DELETE ON appointment_reminder_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION reminder_system_actor() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '53c40000-0000-4000-8000-000000000017'::uuid $$;
CREATE FUNCTION reminder_record_event(t uuid,r uuid,actor uuid,action_name text,why text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text,1));
 INSERT INTO appointment_reminder_events(tenant_id,reminder_id,version,actor_id,action,reason) SELECT tenant_id,id,version,actor,action_name,why FROM appointment_reminders WHERE tenant_id=t AND id=r;
 INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES(t,actor,'appointment.reminder_change',r);
END $$;
CREATE FUNCTION reminder_defaults(t uuid,a uuid) RETURNS void LANGUAGE plpgsql AS $$
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
  INSERT INTO appointment_reminders(tenant_id,id,appointment_id,patient_id,request_id,creation_hash,definition_key,before_minutes,due_at,starts_at,appointment_version,preference_version,channel,destination,automatic_email,status,last_result)
   VALUES(t,reminder_id,a,ap.patient_id,reminder_id,'automatic_default',format('default:%s:%s:%s',before_mins,ap.version,coalesce(pref.version,0)),before_mins,ap.starts_at-make_interval(mins=>before_mins),ap.starts_at,ap.version,pref.version,coalesce(pref.channel,'phone'),CASE WHEN valid THEN pref.destination ELSE NULL END,coalesce(valid AND pref.automatic_email,false),initial,CASE WHEN initial='missed' THEN 'default_window_already_elapsed' ELSE 'default_queued' END)
   ON CONFLICT(tenant_id,appointment_id,definition_key) DO NOTHING;
  IF FOUND THEN PERFORM reminder_record_event(t,reminder_id,reminder_system_actor(),'default_scheduled','Default reminder observed from appointment state'); END IF;
 END LOOP;
END $$;
CREATE FUNCTION reminder_invalidate(t uuid,a uuid,why text,terminal text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text,1));
 FOR r IN UPDATE appointment_reminders SET invalidated=true,status=CASE WHEN status='sending' THEN 'sending' WHEN first_attempt_at IS NOT NULL THEN 'needs_review' ELSE terminal END,last_result=why,version=version+1,updated_at=now()
 WHERE tenant_id=t AND appointment_id=a AND status IN ('scheduled','needs_contact','failed','sending','needs_review') AND provider_id IS NULL AND NOT invalidated RETURNING id LOOP
  PERFORM reminder_record_event(t,r.id,reminder_system_actor(),'appointment_or_contact_changed',why);
 END LOOP;
END $$;
CREATE FUNCTION reminder_observe_appointment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.status IS DISTINCT FROM OLD.status) THEN
  PERFORM reminder_invalidate(NEW.tenant_id,NEW.id,'appointment_changed',CASE WHEN NEW.status='booked' THEN 'superseded' ELSE 'cancelled' END);
 END IF;
 IF TG_OP='INSERT' OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.status IS DISTINCT FROM OLD.status THEN PERFORM reminder_defaults(NEW.tenant_id,NEW.id); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reminder_appointment_changes AFTER INSERT OR UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION reminder_observe_appointment();
CREATE FUNCTION reminder_observe_preferences() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ap record; actor uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text,1));
 actor:=coalesce(nullif(current_setting('suncharts.reminder_actor',true),'')::uuid,reminder_system_actor());
 INSERT INTO patient_reminder_preference_history(tenant_id,patient_id,version,content,reason,actor_id) VALUES(NEW.tenant_id,NEW.patient_id,NEW.version,jsonb_build_object('channel',NEW.channel,'destination',NEW.destination,'consented',NEW.consented,'verified',NEW.verified,'automatic_email',NEW.automatic_email),NEW.reason,actor);
 INSERT INTO audit_events(tenant_id,actor_id,action,resource_id) VALUES(NEW.tenant_id,actor,'appointment.reminder_preference_change',NEW.patient_id);
 FOR ap IN SELECT id FROM appointments WHERE tenant_id=NEW.tenant_id AND patient_id=NEW.patient_id AND status='booked' AND starts_at>now() LOOP
  PERFORM reminder_invalidate(NEW.tenant_id,ap.id,'contact_permission_or_verification_changed','superseded');
  IF NEW.consented AND NEW.verified THEN PERFORM reminder_defaults(NEW.tenant_id,ap.id); END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER reminder_preference_changes AFTER INSERT OR UPDATE ON patient_reminder_preferences FOR EACH ROW EXECUTE FUNCTION reminder_observe_preferences();
CREATE FUNCTION reminder_observe_contact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.content->>'email' IS DISTINCT FROM OLD.content->>'email' OR NEW.content->>'phone' IS DISTINCT FROM OLD.content->>'phone' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('schedule:'||NEW.tenant_id,0));
  UPDATE patient_reminder_preferences SET verified=false,automatic_email=false,version=version+1,reason='Native contact changed; explicit permission and destination must be reviewed' WHERE tenant_id=NEW.tenant_id AND patient_id=NEW.patient_id AND verified;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reminder_native_contact_changed AFTER UPDATE ON patient_demographics FOR EACH ROW EXECUTE FUNCTION reminder_observe_contact();
CREATE FUNCTION protect_reminder_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.appointment_id<>OLD.appointment_id OR NEW.patient_id<>OLD.patient_id OR NEW.request_id<>OLD.request_id OR NEW.definition_key<>OLD.definition_key OR NEW.starts_at<>OLD.starts_at OR NEW.due_at<>OLD.due_at OR NEW.before_minutes<>OLD.before_minutes OR NEW.destination IS DISTINCT FROM OLD.destination OR NEW.channel<>OLD.channel OR NEW.automatic_email<>OLD.automatic_email THEN RAISE EXCEPTION 'Reminder identity and message inputs are immutable' USING ERRCODE='23514'; END IF;
 NEW.version:=OLD.version+1; NEW.updated_at:=now();
 RETURN NEW;
END $$;
CREATE TRIGGER reminder_identity_immutable BEFORE UPDATE ON appointment_reminders FOR EACH ROW EXECUTE FUNCTION protect_reminder_identity();
CREATE TRIGGER reminders_no_delete BEFORE DELETE ON appointment_reminders FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
