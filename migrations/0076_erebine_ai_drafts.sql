-- Erebine uses the same instance-local credential and reviewed draft boundary.
-- Preserve existing Claude draft identities, events, and historical links.
ALTER TABLE instance_integrations DROP CONSTRAINT instance_integrations_provider_check;
ALTER TABLE instance_integrations ADD CONSTRAINT instance_integrations_provider_check
 CHECK (provider IN ('ringcentral','gmail','claude','erebine','healthclinics'));
ALTER TABLE workflow_dispatches DROP CONSTRAINT workflow_dispatches_downstream_kind_check;
ALTER TABLE workflow_dispatches ADD CONSTRAINT workflow_dispatches_downstream_kind_check
 CHECK (downstream_kind IS NULL OR downstream_kind IN ('gmail_draft','ringcentral_draft','claude_draft','ai_draft'));
