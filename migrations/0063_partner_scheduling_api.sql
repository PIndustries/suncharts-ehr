-- SPDX-License-Identifier: AGPL-3.0-only
-- Instance-local scheduling contract for authorized partner applications.
CREATE TABLE scheduling_services (
 tenant_id uuid NOT NULL,id uuid NOT NULL,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 clinician_id uuid NOT NULL,duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 5 AND 480),
 category text NOT NULL CHECK(length(category) BETWEEN 1 AND 100),facility text NOT NULL DEFAULT '' CHECK(length(facility)<=200),
 room text NOT NULL DEFAULT '' CHECK(length(room)<=100),enabled boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,clinician_id) REFERENCES browser_users(tenant_id,id),
 CHECK(room='' OR facility<>'')
);
CREATE INDEX scheduling_services_active ON scheduling_services(tenant_id,clinician_id) WHERE enabled;

INSERT INTO scheduling_services(tenant_id,id,name,clinician_id,duration_minutes,category,created_by)
SELECT tenant_id,gen_random_uuid(),appointment_title,default_clinician_id,duration_minutes,appointment_category,updated_by
FROM previsit_booking_profiles;

CREATE TABLE scheduling_holds (
 tenant_id uuid NOT NULL,id uuid NOT NULL,service_id uuid NOT NULL,actor_id uuid NOT NULL,
 starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
 expires_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status IN('active','booked','released','expired')),
 request_id uuid NOT NULL,request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,service_id) REFERENCES scheduling_services(tenant_id,id)
);
CREATE INDEX scheduling_holds_active ON scheduling_holds(tenant_id,starts_at,ends_at) WHERE status='active';

CREATE TABLE scheduling_external_appointments (
 tenant_id uuid NOT NULL,source_system text NOT NULL CHECK(source_system ~ '^[a-z0-9][a-z0-9_.-]{1,79}$'),
 external_reference text NOT NULL CHECK(length(external_reference) BETWEEN 1 AND 200),appointment_id uuid NOT NULL,service_id uuid NOT NULL,
 request_id uuid NOT NULL,request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,source_system,external_reference),
 UNIQUE(tenant_id,appointment_id),UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,appointment_id) REFERENCES appointments(tenant_id,id),
 FOREIGN KEY(tenant_id,service_id) REFERENCES scheduling_services(tenant_id,id)
);

CREATE TABLE scheduling_partner_mutations (
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,appointment_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN('reschedule','cancel')),
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),resulting_version bigint NOT NULL CHECK(resulting_version>0),
 actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,request_id),
 FOREIGN KEY(tenant_id,appointment_id) REFERENCES appointments(tenant_id,id)
);

CREATE TABLE scheduling_webhook_subscriptions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
 endpoint text NOT NULL CHECK(length(endpoint) BETWEEN 8 AND 2000),events text[] NOT NULL,
 encrypted_signing_secret bytea NOT NULL,signing_secret_hash text NOT NULL CHECK(signing_secret_hash ~ '^[0-9a-f]{64}$'),enabled boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE scheduling_webhook_outbox (
 tenant_id uuid NOT NULL,id bigint GENERATED ALWAYS AS IDENTITY,subscription_id uuid NOT NULL,event_id uuid NOT NULL,
 event_type text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),delivered_at timestamptz,
 attempt_count integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),last_error text,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,subscription_id,event_id),
 FOREIGN KEY(tenant_id,subscription_id) REFERENCES scheduling_webhook_subscriptions(tenant_id,id)
);
CREATE INDEX scheduling_webhook_due ON scheduling_webhook_outbox(next_attempt_at) WHERE delivered_at IS NULL;

CREATE TRIGGER scheduling_external_links_immutable BEFORE UPDATE OR DELETE ON scheduling_external_appointments
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
