-- Connect-backed staff and linked-patient sessions remain separate from local sessions so every
-- request can be revalidated against Connect unlink/revocation state.
ALTER TABLE browser_sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'local'
 CHECK(auth_method IN ('local','break_glass'));
CREATE TABLE connect_identity_sessions (
 token_hash text PRIMARY KEY,tenant_id uuid NOT NULL,user_id uuid NOT NULL,grant_id uuid NOT NULL,
 issuer text NOT NULL,audience text NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,
 last_introspected_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,user_id) REFERENCES browser_users(tenant_id,id)
);
CREATE TABLE patient_connect_sessions (
 token_hash text PRIMARY KEY,tenant_id uuid NOT NULL,account_id uuid NOT NULL,account_version bigint NOT NULL,
 grant_id uuid NOT NULL,issuer text NOT NULL,audience text NOT NULL,expires_at timestamptz NOT NULL,
 revoked_at timestamptz,last_introspected_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,account_id) REFERENCES patient_portal_accounts(tenant_id,id)
);
DO $$
DECLARE constraint_name text;
BEGIN
 SELECT c.conname INTO constraint_name FROM pg_constraint c
 JOIN pg_class t ON t.oid=c.conrelid
 WHERE t.relname='patient_portal_accounts' AND c.contype='c'
   AND pg_get_constraintdef(c.oid) LIKE '%password_hash IS NOT NULL%';
 IF constraint_name IS NULL THEN RAISE EXCEPTION 'patient portal active-password constraint not found'; END IF;
 EXECUTE format('ALTER TABLE patient_portal_accounts DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE patient_portal_accounts ADD COLUMN identity_mode text NOT NULL DEFAULT 'local'
 CHECK(identity_mode IN ('local','connect'));
ALTER TABLE patient_portal_accounts ADD CONSTRAINT patient_portal_accounts_active_identity
 CHECK(status<>'active' OR (identity_mode='local' AND password_hash IS NOT NULL)
                       OR (identity_mode='connect' AND password_hash IS NULL));
