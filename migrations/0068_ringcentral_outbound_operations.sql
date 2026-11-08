CREATE TABLE ringcentral_outbound_drafts (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 integration_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('sms','fax','ringout')),
 request_id uuid NOT NULL,
 source text NOT NULL CHECK (source IN ('staff','workflow','ai_draft')),
 encrypted_payload bytea NOT NULL,
 payload_hash text NOT NULL CHECK (length(payload_hash)=64),
 recipient_hash text NOT NULL CHECK (length(recipient_hash)=64),
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sending','accepted','failed','needs_review','cancelled')),
 created_by uuid NOT NULL,
 approved_by uuid,
 approval_request_id uuid,
 approval_reason text CHECK (approval_reason IS NULL OR length(approval_reason) BETWEEN 1 AND 500),
 approved_at timestamptz,
 send_request_id uuid,
 sent_by uuid,
 sent_at timestamptz,
 provider_id text CHECK (provider_id IS NULL OR length(provider_id) <= 240),
 provider_uri text CHECK (provider_uri IS NULL OR length(provider_uri) <= 2000),
 provider_status text CHECK (provider_status IS NULL OR length(provider_status) <= 120),
 encrypted_provider_receipt bytea,
 last_error text CHECK (last_error IS NULL OR length(last_error) <= 120),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 UNIQUE (tenant_id,integration_id,request_id),
 UNIQUE (tenant_id,integration_id,approval_request_id),
 UNIQUE (tenant_id,integration_id,send_request_id),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id)
);
CREATE INDEX ringcentral_outbound_queue
 ON ringcentral_outbound_drafts(tenant_id,integration_id,status,created_at,id);

CREATE FUNCTION preserve_ringcentral_outbound_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.integration_id IS DISTINCT FROM OLD.integration_id OR
    NEW.kind IS DISTINCT FROM OLD.kind OR
    NEW.request_id IS DISTINCT FROM OLD.request_id OR
    NEW.source IS DISTINCT FROM OLD.source OR
    NEW.encrypted_payload IS DISTINCT FROM OLD.encrypted_payload OR
    NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR
    NEW.recipient_hash IS DISTINCT FROM OLD.recipient_hash OR
    NEW.created_by IS DISTINCT FROM OLD.created_by OR
    NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'RingCentral outbound draft source is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ringcentral_outbound_source_immutable
 BEFORE UPDATE ON ringcentral_outbound_drafts
 FOR EACH ROW EXECUTE FUNCTION preserve_ringcentral_outbound_source();
CREATE TRIGGER ringcentral_outbound_no_delete
 BEFORE DELETE ON ringcentral_outbound_drafts
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE ringcentral_outbound_events (
 tenant_id uuid NOT NULL,
 draft_id uuid NOT NULL,
 sequence bigint NOT NULL CHECK (sequence > 0),
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK (action IN ('drafted','approved','send_started','provider_accepted','provider_rejected','provider_unknown','cancelled','status_refreshed')),
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,draft_id,sequence),
 FOREIGN KEY (tenant_id,draft_id) REFERENCES ringcentral_outbound_drafts(tenant_id,id)
);
CREATE TRIGGER ringcentral_outbound_events_immutable
 BEFORE UPDATE OR DELETE ON ringcentral_outbound_events
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
