-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE connect_onboarding_intents ADD COLUMN transport text NOT NULL DEFAULT 'direct_https'
 CHECK (transport IN ('direct_https','outbound_websocket'));
ALTER TABLE connect_onboarding_intents ADD COLUMN connect_installation_id uuid;
CREATE TABLE connect_transport_health (
 tenant_id uuid NOT NULL, intent_id uuid NOT NULL, session_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('connecting','connected','offline')),
 last_seen_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,intent_id), FOREIGN KEY(tenant_id,intent_id) REFERENCES connect_onboarding_intents(tenant_id,id)
);
