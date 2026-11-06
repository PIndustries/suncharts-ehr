-- Preserve the Connect grant type for attribution. All accepted partner grants remain
-- tenant, customer, audience and time scoped; workflow managers have owner authority
-- inside that assigned customer instance and no platform or cross-tenant authority.
ALTER TABLE partner_support_sessions
  ADD COLUMN delegated_role text NOT NULL DEFAULT 'partner_admin'
  CHECK (delegated_role IN ('partner_support','partner_admin','workflow_manager'));
