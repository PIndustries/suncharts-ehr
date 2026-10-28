-- SPDX-License-Identifier: AGPL-3.0-only
-- Explicit bounded series retain ordinary appointment identities and revision history.
CREATE TABLE appointment_series (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,clinician_id uuid NOT NULL,
 request_id uuid NOT NULL,request_digest text NOT NULL,frequency text NOT NULL CHECK(frequency IN ('daily','weekly','monthly')),
 repeat_interval integer NOT NULL CHECK(repeat_interval BETWEEN 1 AND 12),timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 100),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object' AND jsonb_typeof(plan->'occurrences')='array' AND jsonb_array_length(plan->'occurrences') BETWEEN 2 AND 52),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,clinician_id) REFERENCES browser_users(tenant_id,id)
);
CREATE FUNCTION preserve_appointment_series() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','updated_at']) OR NEW.version<>OLD.version+1 OR OLD.status<>'active' OR NEW.status<>'cancelled' THEN RAISE EXCEPTION 'series plan and identity are immutable; only versioned future cancellation is allowed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER appointment_series_identity BEFORE UPDATE ON appointment_series FOR EACH ROW EXECUTE FUNCTION preserve_appointment_series();
CREATE TRIGGER appointment_series_no_delete BEFORE DELETE ON appointment_series FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE appointment_series_occurrences (
 tenant_id uuid NOT NULL,series_id uuid NOT NULL,position integer NOT NULL CHECK(position BETWEEN 1 AND 52),
 appointment_id uuid NOT NULL,planned jsonb NOT NULL CHECK(jsonb_typeof(planned)='object' AND planned ?& ARRAY['starts_at','ends_at','local_start','local_end','utc_offset_minutes']),
 PRIMARY KEY(tenant_id,series_id,position),UNIQUE(tenant_id,appointment_id),
 FOREIGN KEY(tenant_id,series_id) REFERENCES appointment_series(tenant_id,id),
 FOREIGN KEY(tenant_id,appointment_id) REFERENCES appointments(tenant_id,id)
);
CREATE FUNCTION validate_series_occurrence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM appointment_series s JOIN appointments ap ON ap.tenant_id=s.tenant_id AND ap.patient_id=s.patient_id AND ap.clinician_id=s.clinician_id WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.series_id AND ap.id=NEW.appointment_id AND ap.status='booked') THEN RAISE EXCEPTION 'series occurrence must reference its native patient and provider'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER series_occurrence_patient BEFORE INSERT ON appointment_series_occurrences FOR EACH ROW EXECUTE FUNCTION validate_series_occurrence();
CREATE TRIGGER series_occurrence_immutable BEFORE UPDATE OR DELETE ON appointment_series_occurrences FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE appointment_series_events (
 tenant_id uuid NOT NULL,series_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),
 action text NOT NULL CHECK(action IN ('create','cancel_upcoming')),actor_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,series_id,version),FOREIGN KEY(tenant_id,series_id) REFERENCES appointment_series(tenant_id,id)
);
CREATE TRIGGER appointment_series_events_immutable BEFORE UPDATE OR DELETE ON appointment_series_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE INDEX series_patient_recent ON appointment_series(tenant_id,patient_id,created_at DESC,id);
