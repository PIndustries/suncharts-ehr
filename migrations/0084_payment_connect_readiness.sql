-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE payment_settings
 ADD COLUMN charges_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN payouts_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN details_submitted boolean NOT NULL DEFAULT false,
 ADD COLUMN requirements_currently_due jsonb NOT NULL DEFAULT '[]'::jsonb,
 ADD COLUMN requirements_past_due jsonb NOT NULL DEFAULT '[]'::jsonb;
