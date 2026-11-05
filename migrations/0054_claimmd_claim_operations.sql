CREATE TABLE claimmd_operation_cursors (
    tenant_id UUID NOT NULL,
    setting_id UUID NOT NULL,
    modification_id TEXT NOT NULL DEFAULT '0' CHECK (modification_id ~ '^[0-9]+$'),
    note_id TEXT NOT NULL DEFAULT '0' CHECK (note_id ~ '^[0-9]+$'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, setting_id),
    FOREIGN KEY (tenant_id, setting_id) REFERENCES edi_provider_settings(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE claimmd_operation_records (
    tenant_id UUID NOT NULL,
    setting_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('uploaded_file','modification','note','archive')),
    remote_id TEXT NOT NULL CHECK (length(remote_id) BETWEEN 1 AND 200),
    claimmd_id TEXT,
    claim_id TEXT,
    patient_control_number TEXT,
    content JSONB NOT NULL,
    actor_id UUID,
    reason TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, setting_id, kind, remote_id),
    FOREIGN KEY (tenant_id, setting_id) REFERENCES edi_provider_settings(tenant_id, id) ON DELETE RESTRICT,
    CHECK ((kind='archive' AND actor_id IS NOT NULL AND length(reason) BETWEEN 1 AND 1000)
        OR (kind<>'archive' AND actor_id IS NULL AND reason IS NULL))
);

CREATE INDEX claimmd_operation_records_claim_idx
    ON claimmd_operation_records(tenant_id, setting_id, claimmd_id, kind, recorded_at DESC);

CREATE TABLE claimmd_external_requests (
    tenant_id UUID NOT NULL,
    request_id UUID NOT NULL,
    setting_id UUID NOT NULL,
    operation TEXT NOT NULL CHECK (operation='archive'),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    actor_id UUID NOT NULL,
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
    status TEXT NOT NULL CHECK (status IN ('pending','completed','uncertain')),
    response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, request_id),
    FOREIGN KEY (tenant_id, setting_id) REFERENCES edi_provider_settings(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE claimmd_transmitted_claim_files (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL,
    setting_id UUID NOT NULL,
    request_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    transmit_date DATE NOT NULL,
    claim_form TEXT NOT NULL CHECK (claim_form IN ('1500','ub','dental')),
    page INTEGER NOT NULL CHECK (page BETWEEN 0 AND 10000),
    filters JSONB NOT NULL,
    original_x12 TEXT NOT NULL CHECK (length(original_x12) BETWEEN 1 AND 16777216),
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, request_id),
    FOREIGN KEY (tenant_id, setting_id) REFERENCES edi_provider_settings(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX claimmd_transmitted_claim_files_lookup_idx
    ON claimmd_transmitted_claim_files(tenant_id, setting_id, transmit_date DESC, page);

CREATE TRIGGER claimmd_operation_records_immutable
    BEFORE UPDATE OR DELETE ON claimmd_operation_records
    FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TRIGGER claimmd_transmitted_claim_files_immutable
    BEFORE UPDATE OR DELETE ON claimmd_transmitted_claim_files
    FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
