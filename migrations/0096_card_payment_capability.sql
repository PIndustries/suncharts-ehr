-- SPDX-License-Identifier: AGPL-3.0-only
-- General charge readiness may be true for a transfers-only Stripe account.
-- Preserve all prior settings; card readiness requires a fresh bound provider proof.
ALTER TABLE payment_settings ADD COLUMN card_payments_active boolean NOT NULL DEFAULT false;
