-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE connect_service_settings (
 tenant_id uuid PRIMARY KEY,id uuid NOT NULL UNIQUE,installation_id uuid NOT NULL,credential_revision bigint NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false,verified boolean NOT NULL DEFAULT false,revoked boolean NOT NULL DEFAULT false,
 reminders_available boolean NOT NULL DEFAULT false,support_available boolean NOT NULL DEFAULT false,from_email text,
 last_test_result text,last_test_at timestamptz,version bigint NOT NULL DEFAULT 1,UNIQUE(tenant_id,id)
);
CREATE TABLE connect_service_credentials (
 tenant_id uuid NOT NULL,setting_id uuid NOT NULL,revision bigint NOT NULL,installation_id uuid NOT NULL,encrypted_token bytea NOT NULL,
 PRIMARY KEY(tenant_id,setting_id,revision),FOREIGN KEY(tenant_id,setting_id) REFERENCES connect_service_settings(tenant_id,id)
);
CREATE TRIGGER connect_service_credentials_immutable BEFORE UPDATE OR DELETE ON connect_service_credentials FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE connect_service_events (
 tenant_id uuid NOT NULL,setting_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,action text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,setting_id,version),FOREIGN KEY(tenant_id,setting_id) REFERENCES connect_service_settings(tenant_id,id)
);
CREATE TRIGGER connect_service_events_immutable BEFORE UPDATE OR DELETE ON connect_service_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
ALTER TABLE reminder_sender_settings ADD COLUMN delivery_mode text NOT NULL DEFAULT 'own_resend' CHECK(delivery_mode IN ('own_resend','suncharts_connect'));
ALTER TABLE reminder_credentials ALTER COLUMN encrypted_key DROP NOT NULL;
ALTER TABLE reminder_credentials ADD COLUMN delivery_mode text NOT NULL DEFAULT 'own_resend' CHECK(delivery_mode IN ('own_resend','suncharts_connect'));
ALTER TABLE reminder_credentials ADD COLUMN connect_setting_id uuid;
ALTER TABLE reminder_credentials ADD COLUMN connect_revision bigint;
ALTER TABLE reminder_credentials ADD FOREIGN KEY(tenant_id,connect_setting_id,connect_revision) REFERENCES connect_service_credentials(tenant_id,setting_id,revision);
ALTER TABLE reminder_credentials ADD CHECK((delivery_mode='own_resend' AND encrypted_key IS NOT NULL AND connect_setting_id IS NULL AND connect_revision IS NULL) OR (delivery_mode='suncharts_connect' AND encrypted_key IS NULL AND connect_setting_id IS NOT NULL AND connect_revision IS NOT NULL));
CREATE TABLE connect_support_requests (
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,setting_id uuid NOT NULL,credential_revision bigint NOT NULL,
 path text NOT NULL,body_hash text NOT NULL,actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,request_id),FOREIGN KEY(tenant_id,setting_id,credential_revision) REFERENCES connect_service_credentials(tenant_id,setting_id,revision)
);
CREATE TRIGGER connect_support_requests_immutable BEFORE UPDATE OR DELETE ON connect_support_requests FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
