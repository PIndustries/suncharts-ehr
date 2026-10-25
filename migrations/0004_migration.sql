CREATE TABLE migration_jobs (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    source_instance text NOT NULL,
    manifest jsonb NOT NULL,
    status text NOT NULL DEFAULT 'collecting' CHECK(status IN ('collecting','reconciled','imported')),
    version bigint NOT NULL DEFAULT 1,
    digest text,
    report jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    imported_at timestamptz,
    UNIQUE(tenant_id,id)
);
CREATE TABLE migration_items (
    tenant_id uuid NOT NULL,
    job_id uuid NOT NULL,
    kind text NOT NULL,
    source_id text NOT NULL,
    patient_source_id text,
    data jsonb NOT NULL,
    source_data jsonb NOT NULL,
    digest text NOT NULL,
    PRIMARY KEY(job_id,kind,source_id),
    FOREIGN KEY(tenant_id,job_id) REFERENCES migration_jobs(tenant_id,id)
);
CREATE TABLE source_identifiers (
    tenant_id uuid NOT NULL,
    source_instance text NOT NULL,
    kind text NOT NULL,
    source_id text NOT NULL,
    target_id uuid NOT NULL,
    source_digest text NOT NULL,
    PRIMARY KEY(tenant_id,source_instance,kind,source_id)
);
CREATE TABLE historical_records (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    patient_id uuid,
    job_id uuid NOT NULL,
    kind text NOT NULL,
    source_instance text NOT NULL,
    source_id text NOT NULL,
    data jsonb NOT NULL,
    source_data jsonb NOT NULL,
    source_digest text NOT NULL,
    imported_by uuid NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
    FOREIGN KEY(tenant_id,job_id) REFERENCES migration_jobs(tenant_id,id)
);
CREATE INDEX historical_patient ON historical_records(tenant_id,patient_id,imported_at,id);
CREATE TRIGGER historical_append_only BEFORE UPDATE OR DELETE ON historical_records FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
