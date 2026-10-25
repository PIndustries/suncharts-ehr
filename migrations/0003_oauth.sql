CREATE TABLE oauth_clients (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    secret_hash text NOT NULL,
    redirect_uri text NOT NULL,
    allowed_scopes text NOT NULL,
    disabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oauth_requests (
    id uuid PRIMARY KEY,
    client_id uuid NOT NULL REFERENCES oauth_clients(id),
    redirect_uri text NOT NULL,
    state text NOT NULL,
    challenge text NOT NULL,
    scope text NOT NULL,
    expires_at timestamptz NOT NULL,
    decided_at timestamptz
);
CREATE TABLE oauth_grants (
    id uuid PRIMARY KEY,
    client_id uuid NOT NULL REFERENCES oauth_clients(id),
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES browser_users(id),
    scope text NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oauth_codes (
    hash text PRIMARY KEY,
    grant_id uuid NOT NULL REFERENCES oauth_grants(id),
    redirect_uri text NOT NULL,
    challenge text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);
CREATE TABLE oauth_tokens (
    hash text PRIMARY KEY,
    grant_id uuid NOT NULL REFERENCES oauth_grants(id),
    kind text NOT NULL CHECK (kind IN ('access','refresh')),
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
CREATE INDEX oauth_grants_tenant_user ON oauth_grants(tenant_id,user_id);
