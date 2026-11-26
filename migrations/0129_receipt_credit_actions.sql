-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE billing_receipt_actions (
 tenant_id uuid NOT NULL, request_id uuid NOT NULL, receipt_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('refund','apply')),
 amount_cents bigint NOT NULL CHECK (amount_cents > 0),
 reason text NOT NULL, method text NOT NULL, account_id uuid,
 creation_hash text NOT NULL, actor_id uuid NOT NULL,
 status text NOT NULL CHECK (status IN ('pending','completed')),
 baseline_refunded_cents bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,request_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES billing_copay_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES billing_accounts(tenant_id,id)
);
CREATE INDEX billing_receipt_actions_receipt ON billing_receipt_actions(tenant_id,receipt_id);
CREATE VIEW billing_receipt_cash_refunds AS
 SELECT tenant_id,receipt_id,sum(amount_cents)::bigint AS amount_cents
 FROM billing_receipt_actions WHERE kind='refund' AND method IN ('cash','check') AND status='completed'
 GROUP BY tenant_id,receipt_id;
