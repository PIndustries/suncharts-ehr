CREATE TABLE browser_users (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    email text NOT NULL UNIQUE CHECK (email=lower(email)),
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner','clinician','front_desk','read_only')),
    disabled boolean NOT NULL DEFAULT false,
    UNIQUE (tenant_id,id)
);
CREATE TABLE browser_sessions (
    token_hash text PRIMARY KEY,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamptz NOT NULL,
    FOREIGN KEY (tenant_id,user_id) REFERENCES browser_users(tenant_id,id)
);
CREATE INDEX browser_sessions_expiry ON browser_sessions(expires_at);
