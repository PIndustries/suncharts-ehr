-- SPDX-License-Identifier: AGPL-3.0-only
-- Durable, content-free service references. Cloud payloads and credentials never enter this feed.
CREATE TABLE connect_update_sync (
 tenant_id uuid NOT NULL, installation_id uuid NOT NULL, setting_id uuid NOT NULL,
 credential_revision bigint NOT NULL, cloud_cursor bigint NOT NULL DEFAULT 0 CHECK(cloud_cursor>=0),
 wake_cursor bigint NOT NULL DEFAULT 0 CHECK(wake_cursor>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_id uuid, lease_until timestamptz,
 last_result text, PRIMARY KEY(tenant_id,installation_id),
 FOREIGN KEY(tenant_id,setting_id,credential_revision) REFERENCES connect_service_credentials(tenant_id,setting_id,revision)
);
CREATE TABLE connect_remote_events (
 tenant_id uuid NOT NULL, installation_id uuid NOT NULL, cloud_id bigint NOT NULL CHECK(cloud_id>0),
 kind text NOT NULL CHECK(kind IN('support.reply','support.updated','reminder.delivery')),
 resource_id uuid NOT NULL,message_id uuid, created_at timestamptz NOT NULL,
 CHECK(kind<>'support.reply' OR message_id IS NOT NULL),
 PRIMARY KEY(tenant_id,installation_id,cloud_id)
);
CREATE TRIGGER connect_remote_events_immutable BEFORE UPDATE OR DELETE ON connect_remote_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE connect_update_counters (tenant_id uuid PRIMARY KEY,cursor bigint NOT NULL CHECK(cursor>0));
CREATE TABLE connect_update_events (
 id bigint NOT NULL,tenant_id uuid NOT NULL,installation_id uuid,
 kind text NOT NULL CHECK(kind IN('support.reply','support.updated','reminder.updated')),
 resource_id uuid NOT NULL,appointment_id uuid,message_id uuid,cloud_id bigint,reminder_version bigint,
 CHECK(kind<>'support.reply' OR message_id IS NOT NULL),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,installation_id,cloud_id),UNIQUE(tenant_id,resource_id,reminder_version),
 CHECK((kind='reminder.updated' AND installation_id IS NULL AND cloud_id IS NULL AND reminder_version IS NOT NULL AND appointment_id IS NOT NULL)
 OR(kind IN('support.reply','support.updated') AND installation_id IS NOT NULL AND cloud_id IS NOT NULL AND reminder_version IS NULL AND appointment_id IS NULL))
);
CREATE FUNCTION connect_allocate_update_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO connect_update_counters(tenant_id,cursor) VALUES(NEW.tenant_id,1)
 ON CONFLICT(tenant_id) DO UPDATE SET cursor=connect_update_counters.cursor+1 RETURNING cursor INTO NEW.id;
 RETURN NEW;
END $$;
-- The counter row remains locked until commit, so a feed cannot skip a later
-- commit that allocated an earlier sequence value.
CREATE TRIGGER connect_allocate_update_cursor BEFORE INSERT ON connect_update_events FOR EACH ROW EXECUTE FUNCTION connect_allocate_update_cursor();
CREATE INDEX connect_update_feed ON connect_update_events(tenant_id,id);
CREATE INDEX connect_support_notifications ON connect_update_events(tenant_id,installation_id,id) WHERE kind='support.reply';
CREATE TRIGGER connect_update_events_immutable BEFORE UPDATE OR DELETE ON connect_update_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE connect_notification_reads (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,event_id bigint NOT NULL,read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,user_id,event_id),FOREIGN KEY(tenant_id,user_id) REFERENCES browser_users(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES connect_update_events(tenant_id,id)
);
CREATE TRIGGER connect_notification_reads_immutable BEFORE UPDATE OR DELETE ON connect_notification_reads FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION connect_reminder_update_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO connect_update_events(tenant_id,kind,resource_id,appointment_id,reminder_version)
 SELECT NEW.tenant_id,'reminder.updated',NEW.reminder_id,r.appointment_id,NEW.version
 FROM appointment_reminders r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.reminder_id;
 RETURN NEW;
END $$;
CREATE TRIGGER connect_reminder_update_notice AFTER INSERT ON appointment_reminder_events FOR EACH ROW EXECUTE FUNCTION connect_reminder_update_notice();
