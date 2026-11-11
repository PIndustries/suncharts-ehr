-- Patient invoices capture reviewed responsibility independently of card collection.
CREATE TABLE patient_invoice_snapshots (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 patient_id uuid NOT NULL,
 account_id uuid NOT NULL,
 request_id uuid NOT NULL,
 creation_hash text NOT NULL,
 account_version bigint NOT NULL,
 snapshot jsonb NOT NULL,
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES billing_accounts(tenant_id,id)
);
CREATE TRIGGER patient_invoice_snapshots_immutable BEFORE UPDATE OR DELETE ON patient_invoice_snapshots
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
