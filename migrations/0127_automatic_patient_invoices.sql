CREATE TABLE automatic_patient_invoice_jobs (
 tenant_id uuid NOT NULL, account_id uuid NOT NULL, patient_id uuid NOT NULL,
 generation bigint NOT NULL DEFAULT 1, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
 lease_id uuid, lease_until timestamptz,
 PRIMARY KEY (tenant_id, account_id),
 FOREIGN KEY (tenant_id,account_id,patient_id) REFERENCES billing_accounts(tenant_id,id,patient_id)
);
CREATE INDEX automatic_patient_invoice_jobs_due ON automatic_patient_invoice_jobs(next_attempt_at);

CREATE TABLE automatic_patient_invoice_operations (
 tenant_id uuid NOT NULL, account_id uuid NOT NULL, patient_id uuid NOT NULL,
 native_invoice_id uuid NOT NULL, account_version bigint NOT NULL,
 request_id uuid NOT NULL, amount_cents bigint NOT NULL CHECK (amount_cents > 0),
 patient_payment_cents bigint NOT NULL,
 setting_id uuid NOT NULL, credential_revision bigint NOT NULL, installation_id uuid NOT NULL,
 stripe_account_id text NOT NULL, livemode boolean NOT NULL,
 stripe_invoice_id text, creation_attempted boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'preparing'
   CHECK (status IN ('preparing','draft','open','paid','void','uncollectible','needs_review')),
 closed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,request_id), UNIQUE (tenant_id,native_invoice_id),
 FOREIGN KEY (tenant_id,account_id,patient_id) REFERENCES billing_accounts(tenant_id,id,patient_id),
 FOREIGN KEY (tenant_id,native_invoice_id) REFERENCES patient_invoice_snapshots(tenant_id,id)
);
CREATE UNIQUE INDEX automatic_patient_invoice_operations_active
 ON automatic_patient_invoice_operations(tenant_id,account_id) WHERE closed_at IS NULL;
