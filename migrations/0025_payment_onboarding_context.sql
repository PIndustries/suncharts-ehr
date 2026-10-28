-- SPDX-License-Identifier: AGPL-3.0-only
-- A verified broker may point owners to the platform's authenticated setup screen.
ALTER TABLE payment_settings ADD COLUMN onboarding_url text;
