-- One-time state for Connect-managed hosted EHR bootstrap. Raw capabilities and
-- OAuth material are never stored in plaintext; provenance is immutable after completion.
CREATE TABLE managed_connect_bootstrap (
    provisioning_request_id uuid PRIMARY KEY,
    order_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    owner_user_id uuid NOT NULL REFERENCES browser_users(id),
    expected_hostname text NOT NULL,
    expected_version text NOT NULL,
    expected_image_reference text NOT NULL,
    capability_hash text NOT NULL,
    payload_hash text NOT NULL,
    client_id uuid NOT NULL REFERENCES oauth_clients(id),
    oauth_grant_id uuid NOT NULL REFERENCES oauth_grants(id),
    connection_id uuid,
    encrypted_pending bytea NOT NULL,
    encrypted_result bytea,
    installation_id uuid,
    authorization_source text,
    authorization_reference text,
    terms_version text,
    authorization_actor text,
    authorized_at timestamptz,
    granted_scope text,
    connection_status text NOT NULL DEFAULT 'pending' CHECK (connection_status IN ('pending','connecting','connected','failed')),
    managed_email_ready boolean NOT NULL DEFAULT false,
    managed_email_from text,
    support_ready boolean NOT NULL DEFAULT false,
    last_error text,
    attempts integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CHECK (expected_hostname = lower(expected_hostname)),
    CHECK (length(expected_version) BETWEEN 1 AND 80),
    CHECK (expected_image_reference LIKE '%@sha256:%'),
    CHECK (completed_at IS NULL OR
           (connection_id IS NOT NULL AND installation_id IS NOT NULL AND
            authorization_source='managed_hosted_order' AND authorization_reference IS NOT NULL AND
            terms_version IS NOT NULL AND authorization_actor IS NOT NULL AND authorized_at IS NOT NULL AND
            granted_scope IS NOT NULL))
);
ALTER TABLE oauth_grants
    ADD COLUMN authorization_source text NOT NULL DEFAULT 'owner_consent'
        CHECK (authorization_source IN ('owner_consent','managed_hosted_order')),
    ADD COLUMN authorization_order_id uuid;
ALTER TABLE oauth_grants ADD CONSTRAINT oauth_grants_managed_order_check
    CHECK ((authorization_source='owner_consent' AND authorization_order_id IS NULL) OR
           (authorization_source='managed_hosted_order' AND authorization_order_id IS NOT NULL));
CREATE FUNCTION prevent_oauth_grant_source_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.authorization_source <> OLD.authorization_source OR
       NEW.authorization_order_id IS DISTINCT FROM OLD.authorization_order_id THEN
        RAISE EXCEPTION 'OAuth grant authorization provenance is immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER oauth_grant_source_immutable
    BEFORE UPDATE ON oauth_grants
    FOR EACH ROW EXECUTE FUNCTION prevent_oauth_grant_source_rewrite();
CREATE UNIQUE INDEX managed_connect_bootstrap_one_per_tenant
    ON managed_connect_bootstrap(tenant_id)
    WHERE connection_status IN ('pending','connecting','connected');

CREATE FUNCTION prevent_managed_connect_provenance_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.completed_at IS NOT NULL AND (
        NEW.provisioning_request_id <> OLD.provisioning_request_id OR
        NEW.order_id <> OLD.order_id OR NEW.tenant_id <> OLD.tenant_id OR
        NEW.owner_user_id <> OLD.owner_user_id OR NEW.expected_hostname <> OLD.expected_hostname OR
        NEW.expected_version <> OLD.expected_version OR
        NEW.expected_image_reference <> OLD.expected_image_reference OR
        NEW.payload_hash <> OLD.payload_hash OR NEW.client_id <> OLD.client_id OR
        NEW.authorization_source <> OLD.authorization_source OR
        NEW.authorization_reference IS DISTINCT FROM OLD.authorization_reference OR
        NEW.terms_version IS DISTINCT FROM OLD.terms_version OR
        NEW.authorization_actor IS DISTINCT FROM OLD.authorization_actor OR
        NEW.authorized_at IS DISTINCT FROM OLD.authorized_at OR
        NEW.granted_scope IS DISTINCT FROM OLD.granted_scope OR
        NEW.connection_id IS DISTINCT FROM OLD.connection_id OR
        NEW.installation_id IS DISTINCT FROM OLD.installation_id OR NEW.encrypted_result IS DISTINCT FROM OLD.encrypted_result
    ) THEN
        RAISE EXCEPTION 'completed managed Connect bootstrap provenance is immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER managed_connect_bootstrap_provenance_immutable
    BEFORE UPDATE ON managed_connect_bootstrap
    FOR EACH ROW EXECUTE FUNCTION prevent_managed_connect_provenance_rewrite();
