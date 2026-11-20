-- One payment taken in parts (card, cash, check) shares a group id so it reads as one transaction.
ALTER TABLE billing_copay_receipts ADD COLUMN payment_group_id uuid;
CREATE INDEX billing_copay_receipts_payment_group_idx ON billing_copay_receipts(tenant_id,payment_group_id) WHERE payment_group_id IS NOT NULL;
-- The card operation carries the group until its receipt exists.
ALTER TABLE copay_checkout_attempts ADD COLUMN payment_group_id uuid;
