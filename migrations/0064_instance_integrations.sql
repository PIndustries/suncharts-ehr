CREATE TABLE instance_integrations (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 provider text NOT NULL CHECK (provider IN ('ringcentral','gmail','claude','healthclinics')),
 label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
 auth_type text NOT NULL CHECK (auth_type IN ('oauth2','api_key','oauth2_client')),
 status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','pending','connected','needs_attention','revoked')),
 enabled boolean NOT NULL DEFAULT false,
 capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities)='array'),
 config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config)='object'),
 credential_revision bigint NOT NULL DEFAULT 0 CHECK (credential_revision >= 0),
 credential_hint text CHECK (credential_hint IS NULL OR length(credential_hint) <= 32),
 last_test_at timestamptz,
 last_test_result text CHECK (last_test_result IS NULL OR length(last_test_result) <= 120),
 last_error text CHECK (last_error IS NULL OR length(last_error) <= 240),
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 created_by uuid NOT NULL,
 updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id)
);
CREATE INDEX instance_integrations_provider ON instance_integrations(tenant_id,provider,created_at,id);

CREATE TABLE instance_integration_credentials (
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 revision bigint NOT NULL CHECK (revision > 0),
 encrypted_secret bytea NOT NULL,
 fingerprint text NOT NULL CHECK (length(fingerprint)=64),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,integration_id,revision),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id)
);
CREATE TRIGGER instance_integration_credentials_immutable
BEFORE UPDATE OR DELETE ON instance_integration_credentials
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE instance_integration_oauth_intents (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 integration_id uuid NOT NULL,
 state_hash text NOT NULL UNIQUE CHECK (length(state_hash)=64),
 encrypted_state bytea NOT NULL,
 redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2000),
 requested_scopes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(requested_scopes)='array'),
 encrypted_callback bytea,
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id)
);
CREATE INDEX instance_integration_oauth_pending
 ON instance_integration_oauth_intents(tenant_id,integration_id,expires_at)
 WHERE used_at IS NULL;

CREATE TABLE instance_integration_events (
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY,
 version bigint NOT NULL,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,integration_id,sequence),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id)
);
CREATE TRIGGER instance_integration_events_immutable
BEFORE UPDATE OR DELETE ON instance_integration_events
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION preserve_instance_integration_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
    NEW.provider IS DISTINCT FROM OLD.provider OR NEW.auth_type IS DISTINCT FROM OLD.auth_type OR
    NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'instance integration identity is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.credential_revision < OLD.credential_revision THEN
   RAISE EXCEPTION 'instance integration credential revision cannot decrease' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER instance_integration_identity_immutable
BEFORE UPDATE ON instance_integrations
FOR EACH ROW EXECUTE FUNCTION preserve_instance_integration_identity();
CREATE TRIGGER instance_integration_no_delete
BEFORE DELETE ON instance_integrations
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
