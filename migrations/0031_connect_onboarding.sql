-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE connect_onboarding_intents (
 tenant_id uuid NOT NULL,id uuid NOT NULL,actor_id uuid NOT NULL,session_hash text NOT NULL,state_hash text NOT NULL UNIQUE,
 issuer text NOT NULL,client_id uuid NOT NULL REFERENCES oauth_clients(id),encrypted_pending bytea NOT NULL,
 expected_service_version bigint NOT NULL,expected_reminder_version bigint NOT NULL,
 request_uri text,authorization_url text,encrypted_callback bytea,callback_hash text,encrypted_exchange bytea,
 status text NOT NULL CHECK(status IN ('preparing','awaiting_approval','callback_received','exchanged','completing','completed','denied','cancelling','cancelled','failed')),
 version bigint NOT NULL DEFAULT 1,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 confirmed_at timestamptz,lease_until timestamptz,completed_at timestamptz,last_result text,
 PRIMARY KEY(tenant_id,id)
);
CREATE UNIQUE INDEX one_connect_onboarding_per_owner ON connect_onboarding_intents(tenant_id,actor_id)
 WHERE status IN ('preparing','awaiting_approval','callback_received','exchanged','completing','cancelling');
CREATE TABLE connect_onboarding_events (
 tenant_id uuid NOT NULL,intent_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,action text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,intent_id,version),FOREIGN KEY(tenant_id,intent_id) REFERENCES connect_onboarding_intents(tenant_id,id)
);
CREATE TRIGGER connect_onboarding_events_immutable BEFORE UPDATE OR DELETE ON connect_onboarding_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER connect_onboarding_no_delete BEFORE DELETE ON connect_onboarding_intents FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
