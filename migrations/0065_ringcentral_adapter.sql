CREATE TABLE ringcentral_oauth_flows (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 integration_id uuid NOT NULL,
 state_hash text NOT NULL UNIQUE CHECK (length(state_hash)=64),
 encrypted_verifier bytea NOT NULL,
 redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2000),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id)
);
CREATE INDEX ringcentral_oauth_flows_pending
 ON ringcentral_oauth_flows(tenant_id,integration_id,expires_at) WHERE used_at IS NULL;

CREATE TABLE ringcentral_oauth_tokens (
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 revision bigint NOT NULL CHECK (revision > 0),
 encrypted_tokens bytea NOT NULL,
 access_expires_at timestamptz NOT NULL,
 refresh_expires_at timestamptz,
 granted_scope text NOT NULL DEFAULT '' CHECK (length(granted_scope) <= 2000),
 owner_id text CHECK (owner_id IS NULL OR length(owner_id) <= 200),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,integration_id,revision),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id)
);
CREATE TRIGGER ringcentral_oauth_tokens_immutable
 BEFORE UPDATE OR DELETE ON ringcentral_oauth_tokens
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE ringcentral_webhooks (
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 hook_key_hash text NOT NULL UNIQUE CHECK (length(hook_key_hash)=64),
 encrypted_verification_token bytea NOT NULL,
 provider_subscription_id text CHECK (provider_subscription_id IS NULL OR length(provider_subscription_id) <= 200),
 expires_at timestamptz,
 enabled boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,integration_id),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id)
);

CREATE TABLE ringcentral_stream_health (
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'offline' CHECK (state IN ('offline','connecting','connected','needs_attention')),
 last_connected_at timestamptz,
 last_event_at timestamptz,
 last_error text CHECK (last_error IS NULL OR length(last_error) <= 120),
 session_id uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,integration_id),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id)
);

CREATE TABLE ringcentral_inbound_events (
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 id uuid NOT NULL,
 provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 240),
 event_uri text NOT NULL CHECK (length(event_uri) BETWEEN 1 AND 2000),
 event_kind text NOT NULL CHECK (event_kind IN ('sms','fax','voicemail','call','message','unknown')),
 occurred_at timestamptz,
 encrypted_payload bytea NOT NULL,
 payload_hash text NOT NULL CHECK (length(payload_hash)=64),
 status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','reviewed','ignored')),
 linked_patient_id uuid,
 reviewed_by uuid,
 reviewed_at timestamptz,
 review_reason text CHECK (review_reason IS NULL OR length(review_reason) BETWEEN 1 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 UNIQUE (tenant_id,integration_id,provider_event_id),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id),
 FOREIGN KEY (tenant_id,linked_patient_id) REFERENCES patients(tenant_id,id)
);
CREATE INDEX ringcentral_inbound_review_queue
 ON ringcentral_inbound_events(tenant_id,status,created_at,id);
CREATE FUNCTION preserve_ringcentral_inbound_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.integration_id IS DISTINCT FROM OLD.integration_id OR
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id OR
    NEW.event_uri IS DISTINCT FROM OLD.event_uri OR
    NEW.event_kind IS DISTINCT FROM OLD.event_kind OR
    NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR
    NEW.encrypted_payload IS DISTINCT FROM OLD.encrypted_payload OR
    NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR
    NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'RingCentral inbound event source is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ringcentral_inbound_event_source_immutable
 BEFORE UPDATE ON ringcentral_inbound_events
 FOR EACH ROW EXECUTE FUNCTION preserve_ringcentral_inbound_event();
CREATE TRIGGER ringcentral_inbound_events_no_delete
 BEFORE DELETE ON ringcentral_inbound_events
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
