-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE claimmd_operations (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 setting_id uuid NOT NULL,
 claim_id uuid,
 kind text NOT NULL CHECK(kind IN ('enrollment','appeal')),
 request jsonb NOT NULL,
 external_url text NOT NULL,
 status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','updated','completed','failed')),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,setting_id) REFERENCES edi_provider_settings(tenant_id,id),
 FOREIGN KEY(tenant_id,claim_id) REFERENCES ehr_claims(tenant_id,id)
);

CREATE TABLE claimmd_operation_events (
 tenant_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 version bigint NOT NULL,
 actor_id uuid,
 action text NOT NULL,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,operation_id,version),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES claimmd_operations(tenant_id,id)
);
CREATE TRIGGER claimmd_operation_events_immutable BEFORE UPDATE OR DELETE ON claimmd_operation_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE claimmd_era_documents (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 setting_id uuid NOT NULL,
 eraid text NOT NULL CHECK(eraid ~ '^[0-9]{1,20}$'),
 pcn text NOT NULL DEFAULT '',
 kind text NOT NULL CHECK(kind IN ('pdf','structured')),
 content bytea,
 structured jsonb,
 content_hash text NOT NULL,
 metadata jsonb NOT NULL,
 fetched_by uuid NOT NULL,
 fetched_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,setting_id,eraid,kind,pcn),
 FOREIGN KEY(tenant_id,setting_id) REFERENCES edi_provider_settings(tenant_id,id),
 CHECK((kind='pdf' AND content IS NOT NULL AND structured IS NULL) OR (kind='structured' AND content IS NULL AND structured IS NOT NULL))
);

CREATE TABLE claimmd_era_document_events (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 document_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 action text NOT NULL,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES claimmd_era_documents(tenant_id,id)
);
CREATE TRIGGER claimmd_era_document_events_immutable BEFORE UPDATE OR DELETE ON claimmd_era_document_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE claimmd_webhook_batches (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 setting_id uuid NOT NULL,
 account_number text NOT NULL,
 remote_account_number text,
 provider_time timestamptz NOT NULL,
 raw_hash text NOT NULL,
 event_count integer NOT NULL CHECK(event_count BETWEEN 1 AND 100),
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,raw_hash),
 FOREIGN KEY(tenant_id,setting_id) REFERENCES edi_provider_settings(tenant_id,id)
);

CREATE TABLE claimmd_webhook_events (
 tenant_id uuid NOT NULL,
 account_number text NOT NULL,
 event_id text NOT NULL,
 batch_id uuid NOT NULL,
 payload jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,account_number,event_id),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES claimmd_webhook_batches(tenant_id,id)
);
CREATE TRIGGER claimmd_webhook_batches_immutable BEFORE UPDATE OR DELETE ON claimmd_webhook_batches FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER claimmd_webhook_events_immutable BEFORE UPDATE OR DELETE ON claimmd_webhook_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
