CREATE TABLE gmail_oauth_sessions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,integration_id uuid NOT NULL,
 state_hash text NOT NULL UNIQUE CHECK (length(state_hash)=64),encrypted_session bytea NOT NULL,
 redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2000),expires_at timestamptz NOT NULL,
 claimed_at timestamptz,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id));
CREATE INDEX gmail_oauth_sessions_pending ON gmail_oauth_sessions(tenant_id,integration_id,expires_at) WHERE claimed_at IS NULL;

CREATE TABLE gmail_watches (
 tenant_id uuid NOT NULL,integration_id uuid NOT NULL,mailbox text NOT NULL CHECK (length(mailbox) BETWEEN 3 AND 320),
 delivery_mode text NOT NULL DEFAULT 'poll' CHECK (delivery_mode IN ('poll','pubsub')),
 topic_name text CHECK (topic_name IS NULL OR length(topic_name) BETWEEN 10 AND 500),label_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(label_ids)='array'),
 history_id text NOT NULL CHECK (history_id ~ '^[0-9]{1,30}$'),expires_at timestamptz NOT NULL,
 verification_hash text CHECK (verification_hash IS NULL OR length(verification_hash)=64),oidc_audience text CHECK (oidc_audience IS NULL OR length(oidc_audience) BETWEEN 1 AND 2000),
 oidc_service_account text CHECK (oidc_service_account IS NULL OR length(oidc_service_account) BETWEEN 3 AND 320),enabled boolean NOT NULL DEFAULT true,
 poll_seconds integer NOT NULL DEFAULT 300 CHECK (poll_seconds BETWEEN 60 AND 3600),next_poll_at timestamptz NOT NULL DEFAULT now(),poll_lease_id uuid,poll_lease_until timestamptz,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','needs_attention','disabled')),
 last_error text CHECK (last_error IS NULL OR length(last_error)<=120),version bigint NOT NULL DEFAULT 1 CHECK (version>0),
 created_by uuid NOT NULL,updated_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,integration_id),FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id));
ALTER TABLE gmail_watches ADD CONSTRAINT gmail_watch_delivery_configuration CHECK (
 (delivery_mode='poll' AND topic_name IS NULL AND verification_hash IS NULL AND oidc_audience IS NULL AND oidc_service_account IS NULL)
 OR
 (delivery_mode='pubsub' AND topic_name IS NOT NULL AND verification_hash IS NOT NULL AND oidc_audience IS NOT NULL AND oidc_service_account IS NOT NULL));
CREATE INDEX gmail_watches_poll_due ON gmail_watches(next_poll_at) WHERE enabled AND delivery_mode='poll' AND status='active';

CREATE TABLE gmail_pubsub_notifications (
 tenant_id uuid NOT NULL,integration_id uuid NOT NULL,pubsub_message_id text NOT NULL CHECK (length(pubsub_message_id) BETWEEN 1 AND 200),
 mailbox text NOT NULL CHECK (length(mailbox) BETWEEN 3 AND 320),history_id text NOT NULL CHECK (history_id ~ '^[0-9]{1,30}$'),
 payload_digest text NOT NULL CHECK (length(payload_digest)=64),status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','processed','needs_attention')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),lease_id uuid,lease_until timestamptz,last_error text CHECK (last_error IS NULL OR length(last_error)<=120),
 received_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz,
 PRIMARY KEY (tenant_id,integration_id,pubsub_message_id),FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id));
CREATE INDEX gmail_pubsub_due ON gmail_pubsub_notifications(received_at) WHERE status='queued';

CREATE TABLE gmail_referral_inbox (
 tenant_id uuid NOT NULL,id uuid NOT NULL,integration_id uuid NOT NULL,gmail_message_id text NOT NULL CHECK (length(gmail_message_id) BETWEEN 1 AND 200),
 thread_id text CHECK (thread_id IS NULL OR length(thread_id)<=200),internal_date timestamptz,sender text CHECK (sender IS NULL OR length(sender)<=1000),
 recipients jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(recipients)='array'),subject text CHECK (subject IS NULL OR length(subject)<=2000),
 snippet text CHECK (snippet IS NULL OR length(snippet)<=5000),body_text text CHECK (body_text IS NULL OR length(body_text)<=1048576),
 labels jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(labels)='array'),status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','linked','dismissed')),
 patient_id uuid,version bigint NOT NULL DEFAULT 1 CHECK (version>0),reviewed_by uuid,reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),UNIQUE (tenant_id,integration_id,gmail_message_id),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id),FOREIGN KEY (tenant_id,patient_id) REFERENCES patients(tenant_id,id));
CREATE INDEX gmail_referral_inbox_worklist ON gmail_referral_inbox(tenant_id,status,created_at,id);

CREATE TABLE gmail_referral_attachments (
 tenant_id uuid NOT NULL,inbox_id uuid NOT NULL,part_id text NOT NULL CHECK (length(part_id) BETWEEN 1 AND 300),
 filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 500),mime_type text NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 200),
 size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 10485760),digest text NOT NULL CHECK (length(digest)=64),content bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY (tenant_id,inbox_id,part_id),
 FOREIGN KEY (tenant_id,inbox_id) REFERENCES gmail_referral_inbox(tenant_id,id));
CREATE TRIGGER gmail_referral_attachments_immutable BEFORE UPDATE OR DELETE ON gmail_referral_attachments
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE gmail_adapter_events (
 tenant_id uuid NOT NULL,integration_id uuid NOT NULL,sequence bigint GENERATED ALWAYS AS IDENTITY,
 action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
 actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY (tenant_id,integration_id,sequence),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id));
CREATE TRIGGER gmail_adapter_events_immutable BEFORE UPDATE OR DELETE ON gmail_adapter_events
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
