-- SPDX-License-Identifier: AGPL-3.0-only
-- Connectivity evidence is separate from owner settings and never activates services.
CREATE TABLE connect_service_health (
 tenant_id uuid PRIMARY KEY,setting_id uuid NOT NULL,credential_revision bigint NOT NULL,installation_id uuid NOT NULL,
 availability text NOT NULL CHECK(availability IN ('available','unavailable')),
 checked_at timestamptz NOT NULL,verified_at timestamptz,result text NOT NULL,
 reminders_available boolean NOT NULL,support_available boolean NOT NULL,
 FOREIGN KEY(tenant_id,setting_id,credential_revision) REFERENCES connect_service_credentials(tenant_id,setting_id,revision)
);
