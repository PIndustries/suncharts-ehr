-- Public booking and patient-controlled pre-visit intake remain tenant scoped.
CREATE TABLE previsit_booking_profiles (
 tenant_id uuid PRIMARY KEY,
 public_slug text NOT NULL UNIQUE CHECK(public_slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
 enabled boolean NOT NULL DEFAULT false,
 default_clinician_id uuid NOT NULL,
 appointment_title text NOT NULL DEFAULT 'New patient visit' CHECK(length(appointment_title) BETWEEN 1 AND 200),
 appointment_category text NOT NULL DEFAULT 'New patient' CHECK(length(appointment_category) BETWEEN 1 AND 100),
 duration_minutes integer NOT NULL DEFAULT 60 CHECK(duration_minutes BETWEEN 5 AND 480),
 booking_horizon_days integer NOT NULL DEFAULT 180 CHECK(booking_horizon_days BETWEEN 1 AND 365),
 booking_timezone text NOT NULL DEFAULT 'UTC' CHECK(length(booking_timezone) BETWEEN 1 AND 100),
 available_weekdays smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::smallint[] CHECK(cardinality(available_weekdays) BETWEEN 1 AND 7 AND available_weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
 day_start time NOT NULL DEFAULT '08:00',day_end time NOT NULL DEFAULT '17:00',
 slot_minutes integer NOT NULL DEFAULT 30 CHECK(slot_minutes BETWEEN 5 AND 240),
 welcome_text text NOT NULL DEFAULT '' CHECK(length(welcome_text)<=1000),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,default_clinician_id) REFERENCES browser_users(tenant_id,id),CHECK(day_end>day_start)
);
CREATE TABLE previsit_booking_profile_revisions (
 tenant_id uuid NOT NULL,version bigint NOT NULL,snapshot jsonb NOT NULL,actor_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,version),FOREIGN KEY(tenant_id) REFERENCES previsit_booking_profiles(tenant_id)
);
CREATE TRIGGER previsit_booking_history_immutable BEFORE UPDATE OR DELETE ON previsit_booking_profile_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION previsit_booking_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid booking profile identity or version' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER previsit_booking_profile_guard BEFORE UPDATE ON previsit_booking_profiles FOR EACH ROW EXECUTE FUNCTION previsit_booking_profile_guard();
CREATE TRIGGER previsit_booking_profile_no_delete BEFORE DELETE ON previsit_booking_profiles FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE previsit_intake_templates (
 tenant_id uuid NOT NULL,id uuid NOT NULL,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),active boolean NOT NULL DEFAULT true,
 schema jsonb NOT NULL CHECK(jsonb_typeof(schema)='object'),
 updated_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,name)
);
CREATE UNIQUE INDEX previsit_one_active_template ON previsit_intake_templates(tenant_id) WHERE active;
CREATE FUNCTION previsit_intake_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid intake template identity or version' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER previsit_intake_template_guard BEFORE UPDATE ON previsit_intake_templates FOR EACH ROW EXECUTE FUNCTION previsit_intake_template_guard();
CREATE TRIGGER previsit_intake_template_no_delete BEFORE DELETE ON previsit_intake_templates FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE previsit_intake_template_revisions (
 tenant_id uuid NOT NULL,template_id uuid NOT NULL,version bigint NOT NULL,
 name text NOT NULL,schema jsonb NOT NULL,active boolean NOT NULL,actor_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,template_id,version),
 FOREIGN KEY(tenant_id,template_id) REFERENCES previsit_intake_templates(tenant_id,id)
);
CREATE TRIGGER previsit_template_history_immutable BEFORE UPDATE OR DELETE ON previsit_intake_template_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE previsit_intake_packets (
 tenant_id uuid NOT NULL,id uuid NOT NULL,appointment_id uuid NOT NULL,patient_id uuid NOT NULL,
 template_id uuid NOT NULL,template_version bigint NOT NULL,template_snapshot jsonb NOT NULL,
 access_token_hash text NOT NULL CHECK(access_token_hash ~ '^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'sent' CHECK(status IN('sent','in_progress','submitted','reviewed','void')),
 due_at timestamptz NOT NULL,version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 issued_by uuid NOT NULL,submitted_at timestamptz,reviewed_at timestamptz,reviewed_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,appointment_id),UNIQUE(access_token_hash),
 FOREIGN KEY(tenant_id,appointment_id,patient_id) REFERENCES appointments(tenant_id,id,patient_id),
 FOREIGN KEY(tenant_id,template_id) REFERENCES previsit_intake_templates(tenant_id,id),
 CHECK((status='reviewed' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL) OR (status<>'reviewed' AND reviewed_at IS NULL AND reviewed_by IS NULL)),
 CHECK(status IN('submitted','reviewed') OR submitted_at IS NULL)
);
CREATE INDEX previsit_readiness ON previsit_intake_packets(tenant_id,status,due_at);
CREATE FUNCTION previsit_intake_packet_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.appointment_id<>OLD.appointment_id OR NEW.patient_id<>OLD.patient_id OR NEW.template_id<>OLD.template_id OR NEW.template_version<>OLD.template_version OR NEW.template_snapshot<>OLD.template_snapshot OR NEW.access_token_hash<>OLD.access_token_hash OR NEW.due_at<>OLD.due_at OR NEW.issued_by<>OLD.issued_by OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid intake packet identity or version' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER previsit_intake_packet_guard BEFORE UPDATE ON previsit_intake_packets FOR EACH ROW EXECUTE FUNCTION previsit_intake_packet_guard();
CREATE TRIGGER previsit_intake_packet_no_delete BEFORE DELETE ON previsit_intake_packets FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE previsit_intake_responses (
 tenant_id uuid NOT NULL,packet_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),
 response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),attested_name text NOT NULL CHECK(length(attested_name) BETWEEN 1 AND 200),
 attested boolean NOT NULL CHECK(attested),submitted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,packet_id,version),
 FOREIGN KEY(tenant_id,packet_id) REFERENCES previsit_intake_packets(tenant_id,id)
);
CREATE TRIGGER previsit_response_immutable BEFORE UPDATE OR DELETE ON previsit_intake_responses FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE previsit_events (
 tenant_id uuid NOT NULL,id bigint GENERATED ALWAYS AS IDENTITY,packet_id uuid,appointment_id uuid,patient_id uuid,
 actor_id uuid,actor_kind text NOT NULL CHECK(actor_kind IN('staff','patient_guest','system')),
 action text NOT NULL CHECK(length(action) BETWEEN 1 AND 100),details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE TRIGGER previsit_events_immutable BEFORE UPDATE OR DELETE ON previsit_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE previsit_public_requests (
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,digest text NOT NULL,contact_hash text NOT NULL CHECK(contact_hash ~ '^[0-9a-f]{64}$'),
 appointment_id uuid NOT NULL,patient_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,request_id)
);
CREATE INDEX previsit_public_request_rate ON previsit_public_requests(tenant_id,contact_hash,created_at DESC);

