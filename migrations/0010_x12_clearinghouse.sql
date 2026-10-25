-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE edi_partners (
 tenant_id uuid NOT NULL,id uuid NOT NULL,content jsonb NOT NULL,version bigint NOT NULL DEFAULT 1,
 source_history_id uuid,request_id uuid NOT NULL,creation_hash text NOT NULL,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,source_history_id),
 FOREIGN KEY(tenant_id,source_history_id) REFERENCES historical_records(tenant_id,id)
);
CREATE TABLE edi_partner_revisions (
 tenant_id uuid NOT NULL,partner_id uuid NOT NULL,version bigint NOT NULL,snapshot jsonb NOT NULL,
 actor_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,partner_id,version),FOREIGN KEY(tenant_id,partner_id) REFERENCES edi_partners(tenant_id,id)
);
CREATE TRIGGER edi_partner_revisions_immutable BEFORE UPDATE OR DELETE ON edi_partner_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE edi_control_sequences (tenant_id uuid PRIMARY KEY,next_value bigint NOT NULL DEFAULT 1 CHECK(next_value BETWEEN 1 AND 1000000000));
CREATE TABLE edi_submissions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,claim_id uuid NOT NULL,partner_id uuid NOT NULL,
 claim_version bigint NOT NULL,partner_version bigint NOT NULL,claim_snapshot jsonb NOT NULL,partner_snapshot jsonb NOT NULL,
 details jsonb NOT NULL,payload text NOT NULL,payload_hash text NOT NULL,interchange_control text NOT NULL,group_control text NOT NULL,
 transaction_control text NOT NULL,status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','delivered','cancelled')),
 technical_status text NOT NULL DEFAULT 'pending' CHECK(technical_status IN ('pending','accepted','rejected','needs_review')),
 payer_outcome text NOT NULL DEFAULT 'pending' CHECK(payer_outcome IN ('pending','accepted','rejected')),
 version bigint NOT NULL DEFAULT 1,delivered_claim_version bigint,request_id uuid NOT NULL,creation_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,interchange_control),
 FOREIGN KEY(tenant_id,claim_id) REFERENCES ehr_claims(tenant_id,id),FOREIGN KEY(tenant_id,partner_id) REFERENCES edi_partners(tenant_id,id)
);
CREATE UNIQUE INDEX edi_claim_active ON edi_submissions(tenant_id,claim_id) WHERE status<>'cancelled';
CREATE TABLE edi_submission_events (
 tenant_id uuid NOT NULL,submission_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,
 reason text NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,submission_id,version),FOREIGN KEY(tenant_id,submission_id) REFERENCES edi_submissions(tenant_id,id)
);
CREATE TABLE edi_acknowledgments (
 tenant_id uuid NOT NULL,id uuid NOT NULL,submission_id uuid NOT NULL,format text NOT NULL,
 original_text text NOT NULL,original_hash text NOT NULL,parsed jsonb NOT NULL,source_history_id uuid,
 actor_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,submission_id,original_hash),UNIQUE(tenant_id,source_history_id),
 FOREIGN KEY(tenant_id,submission_id) REFERENCES edi_submissions(tenant_id,id),FOREIGN KEY(tenant_id,source_history_id) REFERENCES historical_records(tenant_id,id)
);
CREATE TRIGGER edi_events_immutable BEFORE UPDATE OR DELETE ON edi_submission_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER edi_ack_immutable BEFORE UPDATE OR DELETE ON edi_acknowledgments FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER edi_submission_no_delete BEFORE DELETE ON edi_submissions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER edi_partner_no_delete BEFORE DELETE ON edi_partners FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION protect_edi_payload() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['version','status','technical_status','payer_outcome','delivered_claim_version']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['version','status','technical_status','payer_outcome','delivered_claim_version']) THEN
 RAISE EXCEPTION 'generated EDI artifact is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER edi_payload_immutable BEFORE UPDATE ON edi_submissions FOR EACH ROW EXECUTE FUNCTION protect_edi_payload();
