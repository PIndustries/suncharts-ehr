-- Receipts may be recorded at check-in before a visit or posted charge account exists.
CREATE TABLE billing_copay_receipts (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 patient_id uuid NOT NULL,
 appointment_id uuid NOT NULL,
 coverage_id uuid,
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 method text NOT NULL CHECK(method IN ('cash','check','external')),
 reference text NOT NULL,
 occurred_on date NOT NULL,
 reason text NOT NULL,
 coverage_snapshot jsonb,
 request_id uuid NOT NULL,
 creation_hash text NOT NULL,
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,id,patient_id),
 UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,appointment_id,patient_id) REFERENCES appointments(tenant_id,id,patient_id),
 FOREIGN KEY(tenant_id,coverage_id,patient_id) REFERENCES insurance_coverages(tenant_id,id,patient_id)
);
CREATE TABLE billing_copay_allocations (
 tenant_id uuid NOT NULL,
 receipt_id uuid NOT NULL,
 patient_id uuid NOT NULL,
 account_id uuid NOT NULL,
 entry_id uuid NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,entry_id),
 FOREIGN KEY(tenant_id,receipt_id,patient_id) REFERENCES billing_copay_receipts(tenant_id,id,patient_id),
 FOREIGN KEY(tenant_id,account_id,patient_id) REFERENCES billing_accounts(tenant_id,id,patient_id),
 FOREIGN KEY(tenant_id,entry_id,account_id) REFERENCES billing_entries(tenant_id,id,account_id)
);
CREATE TABLE billing_copay_voids (
 tenant_id uuid NOT NULL,
 receipt_id uuid NOT NULL,
 reason text NOT NULL,
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,receipt_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES billing_copay_receipts(tenant_id,id)
);
CREATE TRIGGER billing_copay_receipts_immutable BEFORE UPDATE OR DELETE ON billing_copay_receipts FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER billing_copay_allocations_immutable BEFORE UPDATE OR DELETE ON billing_copay_allocations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER billing_copay_voids_immutable BEFORE UPDATE OR DELETE ON billing_copay_voids FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
