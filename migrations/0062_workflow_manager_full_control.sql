-- Preserve migration 0061 exactly as deployed. Partner support and workflow-management
-- sessions now share full authority inside the assigned customer tenant; purpose remains
-- attribution metadata and no longer restricts the delegated role.
ALTER TABLE partner_support_sessions
    DROP CONSTRAINT partner_support_sessions_delegated_role_check,
    DROP CONSTRAINT partner_support_sessions_check1,
    ADD CONSTRAINT partner_support_sessions_delegated_role_check
        CHECK (delegated_role IN ('partner_support','partner_admin','workflow_manager'));

COMMENT ON COLUMN partner_support_sessions.purpose IS
    'Legacy attribution metadata retained from schema 61; authorization is tenant scoped by delegated_role.';

COMMENT ON TABLE care_pathway_change_requests IS
    'Historical workflow proposals retained for audit; active partner workflow changes use versioned pathway definitions.';
