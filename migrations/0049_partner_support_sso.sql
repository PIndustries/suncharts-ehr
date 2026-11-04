-- Delegated support sessions are separate from staff identities and never contain EHR passwords.
CREATE TABLE partner_support_sessions (
 token_hash text PRIMARY KEY,
 tenant_id uuid NOT NULL,
 grant_id uuid NOT NULL UNIQUE,
 partner_id uuid NOT NULL,
 customer_id uuid NOT NULL,
 order_id uuid NOT NULL,
 issuer text NOT NULL,
 audience text NOT NULL,
 expires_at timestamptz NOT NULL,
 last_introspected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(expires_at>created_at),
 CHECK(issuer LIKE 'https://%' OR issuer LIKE 'http://127.0.0.1:%' OR issuer LIKE 'http://[::1]:%'),
 CHECK(audience LIKE 'https://%' OR audience LIKE 'http://127.0.0.1:%' OR audience LIKE 'http://[::1]:%')
);
CREATE INDEX partner_support_sessions_expiry ON partner_support_sessions(expires_at)
 WHERE revoked_at IS NULL;
