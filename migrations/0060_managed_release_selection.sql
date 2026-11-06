-- A managed installation's original bootstrap provenance remains immutable. Upgrades are
-- separately authorized as an append-only, predecessor-linked release-selection chain.
-- The bootstrap request is already globally unique; this additional key makes the tenant
-- binding explicit to PostgreSQL for the composite provenance foreign key below.
ALTER TABLE managed_connect_bootstrap
    ADD CONSTRAINT managed_connect_bootstrap_tenant_request_unique
    UNIQUE (tenant_id, provisioning_request_id);

CREATE TABLE managed_release_selections (
    selection_id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    bootstrap_request_id uuid NOT NULL REFERENCES managed_connect_bootstrap(provisioning_request_id),
    installation_id uuid NOT NULL,
    release_id uuid NOT NULL,
    supersedes_selection_id uuid,
    selected_version text NOT NULL,
    selected_image_reference text NOT NULL,
    reason text NOT NULL CHECK (reason IN ('rollout','rollback')),
    authorization_source text NOT NULL CHECK (authorization_source='connect_release_executor'),
    selected_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (length(selected_version) BETWEEN 1 AND 80),
    CHECK (selected_image_reference LIKE 'ghcr.io/pindustries/suncharts-ehr@sha256:%'),
    UNIQUE (tenant_id, selection_id),
    UNIQUE (tenant_id, supersedes_selection_id),
    FOREIGN KEY (tenant_id, supersedes_selection_id)
        REFERENCES managed_release_selections(tenant_id, selection_id),
    FOREIGN KEY (tenant_id, bootstrap_request_id)
        REFERENCES managed_connect_bootstrap(tenant_id, provisioning_request_id)
);

CREATE INDEX managed_release_selections_current
    ON managed_release_selections(tenant_id, recorded_at DESC, selection_id DESC);
CREATE UNIQUE INDEX managed_release_selections_one_initial
    ON managed_release_selections(tenant_id)
    WHERE supersedes_selection_id IS NULL;

CREATE TRIGGER managed_release_selections_append_only
    BEFORE UPDATE OR DELETE ON managed_release_selections
    FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
