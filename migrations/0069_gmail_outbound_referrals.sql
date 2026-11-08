ALTER TABLE gmail_referral_inbox
 ADD COLUMN rfc_message_id text CHECK (rfc_message_id IS NULL OR length(rfc_message_id) BETWEEN 3 AND 998),
 ADD CONSTRAINT gmail_referral_inbox_integration_identity UNIQUE (tenant_id,integration_id,id);

CREATE TABLE gmail_outbound_drafts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,integration_id uuid NOT NULL,inbox_id uuid,
 idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 200),
 payload_digest text NOT NULL CHECK (length(payload_digest)=64),
 to_addresses jsonb NOT NULL CHECK (jsonb_typeof(to_addresses)='array'),
 cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cc_addresses)='array'),
 subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 500),
 body_text text NOT NULL CHECK (length(body_text) BETWEEN 1 AND 262144),
 rfc_message_id text NOT NULL CHECK (length(rfc_message_id) BETWEEN 3 AND 998),
 gmail_thread_id text CHECK (gmail_thread_id IS NULL OR length(gmail_thread_id)<=200),
 in_reply_to text CHECK (in_reply_to IS NULL OR length(in_reply_to) BETWEEN 3 AND 998),
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sending','sent','failed','cancelled')),
 version bigint NOT NULL DEFAULT 1 CHECK (version>0),
 created_by uuid NOT NULL,approved_by uuid,approved_at timestamptz,approval_reason text CHECK (approval_reason IS NULL OR length(approval_reason)<=500),
 send_started_by uuid,send_started_at timestamptz,sent_at timestamptz,cancelled_by uuid,cancelled_at timestamptz,
 last_error text CHECK (last_error IS NULL OR length(last_error)<=120),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),UNIQUE (tenant_id,integration_id,idempotency_key),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id),
 FOREIGN KEY (tenant_id,integration_id,inbox_id) REFERENCES gmail_referral_inbox(tenant_id,integration_id,id));
CREATE INDEX gmail_outbound_drafts_worklist ON gmail_outbound_drafts(tenant_id,integration_id,status,created_at,id);
CREATE FUNCTION protect_gmail_outbound_draft_content() RETURNS trigger AS $$
BEGIN
 IF ROW(NEW.tenant_id,NEW.id,NEW.integration_id,NEW.inbox_id,NEW.idempotency_key,NEW.payload_digest,NEW.to_addresses,NEW.cc_addresses,NEW.subject,NEW.body_text,NEW.rfc_message_id,NEW.gmail_thread_id,NEW.in_reply_to,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.tenant_id,OLD.id,OLD.integration_id,OLD.inbox_id,OLD.idempotency_key,OLD.payload_digest,OLD.to_addresses,OLD.cc_addresses,OLD.subject,OLD.body_text,OLD.rfc_message_id,OLD.gmail_thread_id,OLD.in_reply_to,OLD.created_by,OLD.created_at)
 THEN RAISE EXCEPTION 'gmail outbound draft content is immutable'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER gmail_outbound_draft_content_immutable BEFORE UPDATE ON gmail_outbound_drafts
 FOR EACH ROW EXECUTE FUNCTION protect_gmail_outbound_draft_content();
CREATE TRIGGER gmail_outbound_drafts_no_delete BEFORE DELETE ON gmail_outbound_drafts
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE gmail_outbound_attachments (
 tenant_id uuid NOT NULL,draft_id uuid NOT NULL,position integer NOT NULL CHECK (position BETWEEN 0 AND 9),
 filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),mime_type text NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 100),
 size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),digest text NOT NULL CHECK (length(digest)=64),content bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY (tenant_id,draft_id,position),
 FOREIGN KEY (tenant_id,draft_id) REFERENCES gmail_outbound_drafts(tenant_id,id));
CREATE TRIGGER gmail_outbound_attachments_immutable BEFORE UPDATE OR DELETE ON gmail_outbound_attachments
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE gmail_outbound_receipts (
 tenant_id uuid NOT NULL,draft_id uuid NOT NULL,gmail_message_id text NOT NULL CHECK (length(gmail_message_id) BETWEEN 1 AND 200),
 gmail_thread_id text CHECK (gmail_thread_id IS NULL OR length(gmail_thread_id)<=200),provider_response_digest text NOT NULL CHECK (length(provider_response_digest)=64),
 provider_response jsonb NOT NULL CHECK (jsonb_typeof(provider_response)='object'),sent_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,draft_id),UNIQUE (tenant_id,gmail_message_id),
 FOREIGN KEY (tenant_id,draft_id) REFERENCES gmail_outbound_drafts(tenant_id,id));
CREATE TRIGGER gmail_outbound_receipts_immutable BEFORE UPDATE OR DELETE ON gmail_outbound_receipts
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
