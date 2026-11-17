-- SPDX-License-Identifier: AGPL-3.0-only
-- A practice that bills under its organization (group) NPI records it here.
-- Blank means the practice has no organization NPI and claims keep billing under
-- the clinician's own NPI. The checksum is enforced in the API; the column stores
-- only a blank or a ten-digit code. No history row is rewritten: the append-only
-- history trigger on practice_billing_organization_history is untouched by this
-- ALTER on practice_billing_organizations.
ALTER TABLE practice_billing_organizations ADD COLUMN npi text NOT NULL DEFAULT '' CHECK (npi='' OR npi ~ '^[0-9]{10}$');
