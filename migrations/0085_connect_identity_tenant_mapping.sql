-- Connect has its own clinic identifier. A self-hosted EHR keeps its local tenant
-- identifier, so identity sessions must preserve both instead of assuming they
-- are the same UUID.
ALTER TABLE connect_identity_sessions
 ADD COLUMN issuer_tenant_id uuid;
UPDATE connect_identity_sessions SET issuer_tenant_id=tenant_id WHERE issuer_tenant_id IS NULL;
ALTER TABLE connect_identity_sessions ALTER COLUMN issuer_tenant_id SET NOT NULL;

ALTER TABLE patient_connect_sessions
 ADD COLUMN issuer_tenant_id uuid;
UPDATE patient_connect_sessions SET issuer_tenant_id=tenant_id WHERE issuer_tenant_id IS NULL;
ALTER TABLE patient_connect_sessions ALTER COLUMN issuer_tenant_id SET NOT NULL;
