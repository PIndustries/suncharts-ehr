-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE edi_provider_settings (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 partner_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider='claim_md'),
 usage text NOT NULL CHECK(usage IN ('T','P')),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
 encrypted_key bytea NOT NULL,
 credential_fingerprint text NOT NULL UNIQUE,
 credential_revision bigint NOT NULL DEFAULT 1,
 start_at timestamptz NOT NULL,
 response_id text NOT NULL DEFAULT '0',
 interval_seconds bigint NOT NULL DEFAULT 60 CHECK(interval_seconds BETWEEN 30 AND 86400),
 enabled boolean NOT NULL DEFAULT false,
 verified boolean NOT NULL DEFAULT false,
 last_test_at timestamptz,
 last_test_result text,
 version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,partner_id) REFERENCES edi_partners(tenant_id,id)
);
CREATE TABLE edi_provider_setting_events (
 tenant_id uuid NOT NULL,
 setting_id uuid NOT NULL,
 version bigint NOT NULL,
 actor_id uuid NOT NULL,
 action text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,setting_id,version),
 FOREIGN KEY(tenant_id,setting_id) REFERENCES edi_provider_settings(tenant_id,id)
);
CREATE TRIGGER edi_provider_setting_events_immutable BEFORE UPDATE OR DELETE ON edi_provider_setting_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
