CREATE TABLE patients (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    mrn text NOT NULL CHECK (length(mrn) BETWEEN 1 AND 64),
    given_name text NOT NULL CHECK (length(given_name) BETWEEN 1 AND 100),
    family_name text NOT NULL CHECK (length(family_name) BETWEEN 1 AND 100),
    birth_date date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, mrn)
);

CREATE TABLE appointments (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    patient_id uuid NOT NULL,
    clinician_id uuid NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
    status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'checked_in', 'in_progress', 'completed')),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, id, patient_id),
    FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id)
);
CREATE INDEX appointments_schedule ON appointments(tenant_id, starts_at);

CREATE TABLE visits (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    patient_id uuid NOT NULL,
    appointment_id uuid NOT NULL,
    clinician_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'signed')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    note jsonb,
    vitals jsonb,
    signed_by uuid,
    signed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, appointment_id),
    FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
    FOREIGN KEY (tenant_id, appointment_id, patient_id) REFERENCES appointments(tenant_id, id, patient_id),
    CHECK ((status = 'signed' AND signed_by IS NOT NULL AND signed_at IS NOT NULL AND note IS NOT NULL)
        OR (status = 'in_progress' AND signed_by IS NULL AND signed_at IS NULL))
);

CREATE TABLE amendments (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    visit_id uuid NOT NULL,
    author_id uuid NOT NULL,
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
    text text NOT NULL CHECK (length(text) BETWEEN 1 AND 10000),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, visit_id) REFERENCES visits(tenant_id, id)
);

CREATE TABLE audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action text NOT NULL,
    resource_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant ON audit_events(tenant_id, id);

-- Guard signed content even if a future handler forgets the application check.
CREATE FUNCTION preserve_signed_visit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'signed' AND
       (NEW.note IS DISTINCT FROM OLD.note OR NEW.vitals IS DISTINCT FROM OLD.vitals
        OR NEW.signed_by IS DISTINCT FROM OLD.signed_by OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
        OR NEW.status IS DISTINCT FROM OLD.status OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
        OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id OR NEW.clinician_id IS DISTINCT FROM OLD.clinician_id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id) THEN
        RAISE EXCEPTION 'signed visit content is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER immutable_signed_visit BEFORE UPDATE ON visits
FOR EACH ROW EXECUTE FUNCTION preserve_signed_visit();

CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'clinical history is append-only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER no_visit_delete BEFORE DELETE ON visits FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER append_only_amendments BEFORE UPDATE OR DELETE ON amendments FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER append_only_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

