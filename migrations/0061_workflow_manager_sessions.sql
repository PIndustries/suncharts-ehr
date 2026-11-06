ALTER TABLE partner_support_sessions
    ADD COLUMN delegated_role TEXT NOT NULL DEFAULT 'partner_admin'
        CHECK (delegated_role IN ('partner_admin','workflow_manager')),
    ADD COLUMN purpose TEXT NOT NULL DEFAULT 'support'
        CHECK ((delegated_role='partner_admin' AND purpose='support') OR
               (delegated_role='workflow_manager' AND purpose='workflow_management'));

CREATE TABLE care_pathway_change_requests (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL,
    definition_id UUID NOT NULL,
    base_version BIGINT NOT NULL CHECK (base_version > 0),
    proposal JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    requested_by UUID NOT NULL,
    request_reason TEXT NOT NULL CHECK (length(request_reason) BETWEEN 1 AND 1000),
    reviewed_by UUID,
    review_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id,id),
    FOREIGN KEY (tenant_id,definition_id) REFERENCES care_pathway_definitions(tenant_id,id)
);
CREATE TRIGGER care_pathway_change_request_no_delete BEFORE DELETE ON care_pathway_change_requests
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
