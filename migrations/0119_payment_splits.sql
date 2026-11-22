-- One card charge can pay for several encounters. Each row is the part of the charge meant
-- for one appointment; the parts add up to the charge. A charge for a single encounter has no
-- rows here, so every existing charge reads exactly as before. Additive only.
CREATE TABLE copay_checkout_splits (
 tenant_id uuid NOT NULL,operation_id uuid NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 0 AND 49),
 patient_id uuid NOT NULL,appointment_id uuid NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 PRIMARY KEY(tenant_id,operation_id,appointment_id),
 UNIQUE(tenant_id,operation_id,position),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES copay_checkout_attempts(tenant_id,id),
 FOREIGN KEY(tenant_id,appointment_id,patient_id) REFERENCES appointments(tenant_id,id,patient_id)
);
CREATE INDEX copay_checkout_splits_appointment_idx ON copay_checkout_splits(tenant_id,appointment_id);
CREATE TRIGGER copay_checkout_splits_immutable BEFORE UPDATE OR DELETE ON copay_checkout_splits FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
