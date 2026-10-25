-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE edi_delivery_jobs (
 tenant_id uuid NOT NULL,id uuid NOT NULL,submission_id uuid NOT NULL,route_key text NOT NULL,
 requested_by uuid NOT NULL,request_id uuid NOT NULL,creation_hash text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','retry','unknown','blocked','delivered','cancelled')),
 version bigint NOT NULL DEFAULT 1,attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid,lease_until timestamptz,receipt_reference text,receipt jsonb NOT NULL DEFAULT '{}',last_result text,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,submission_id) REFERENCES edi_submissions(tenant_id,id)
);
CREATE UNIQUE INDEX edi_delivery_one_active ON edi_delivery_jobs(tenant_id,submission_id) WHERE status<>'cancelled';
CREATE TABLE edi_delivery_events (
 tenant_id uuid NOT NULL,job_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,
 evidence jsonb NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,job_id,version),FOREIGN KEY(tenant_id,job_id) REFERENCES edi_delivery_jobs(tenant_id,id)
);
CREATE TRIGGER edi_delivery_events_immutable BEFORE UPDATE OR DELETE ON edi_delivery_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER edi_delivery_no_delete BEFORE DELETE ON edi_delivery_jobs FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE edi_277ca_documents (
 tenant_id uuid NOT NULL,id uuid NOT NULL,original_text text NOT NULL,original_hash text NOT NULL,parsed jsonb NOT NULL,
 origin text NOT NULL CHECK(origin IN ('clearinghouse','payer')),source_history_id uuid,request_id uuid NOT NULL,creation_hash text NOT NULL,
 actor_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,original_hash),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,source_history_id),
 FOREIGN KEY(tenant_id,source_history_id) REFERENCES historical_records(tenant_id,id)
);
CREATE TABLE edi_277ca_reviews (
 tenant_id uuid NOT NULL,document_id uuid NOT NULL,row_index integer NOT NULL,version bigint NOT NULL,
 submission_id uuid NOT NULL,claim_version bigint NOT NULL,submission_version bigint NOT NULL,
 actor_id uuid NOT NULL,decision text NOT NULL,reason text NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,document_id,row_index,version),FOREIGN KEY(tenant_id,document_id) REFERENCES edi_277ca_documents(tenant_id,id),
 FOREIGN KEY(tenant_id,submission_id) REFERENCES edi_submissions(tenant_id,id)
);
CREATE TRIGGER edi_277ca_doc_immutable BEFORE UPDATE OR DELETE ON edi_277ca_documents FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER edi_277ca_review_immutable BEFORE UPDATE OR DELETE ON edi_277ca_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
