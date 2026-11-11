-- Patient archive/restore is append-only. Existing patient rows and all linked
-- clinical and financial history are preserved without a backfill or rewrite.
CREATE TABLE patient_lifecycle_events (
 tenant_id uuid NOT NULL,
 patient_id uuid NOT NULL,
 version bigint NOT NULL CHECK (version >= 2),
 archived boolean NOT NULL,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,patient_id,version),
 FOREIGN KEY (tenant_id,patient_id) REFERENCES patients(tenant_id,id)
);
CREATE FUNCTION preserve_patient_lifecycle_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Patient lifecycle history is immutable; append an archive or restore event' USING ERRCODE='23514';
END $$;
CREATE TRIGGER patient_lifecycle_event_immutable
 BEFORE UPDATE OR DELETE ON patient_lifecycle_events
 FOR EACH ROW EXECUTE FUNCTION preserve_patient_lifecycle_event();
