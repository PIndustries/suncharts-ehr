CREATE TABLE era_row_entries (
 tenant_id uuid NOT NULL,remittance_id uuid NOT NULL,row_index integer NOT NULL,entry_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,entry_id),FOREIGN KEY(tenant_id,entry_id) REFERENCES billing_entries(tenant_id,id),
 FOREIGN KEY(tenant_id,remittance_id) REFERENCES era_remittances(tenant_id,id)
);
INSERT INTO era_row_entries SELECT e.tenant_id,p.remittance_id,p.row_index,e.id FROM billing_entries e JOIN era_posting_entries x ON x.tenant_id=e.tenant_id AND x.entry_id=e.id JOIN era_postings p ON p.tenant_id=x.tenant_id AND p.remittance_id=x.remittance_id AND p.account_id=x.account_id WHERE NOT EXISTS(SELECT 1 FROM era_posting_entries parent WHERE parent.tenant_id=e.tenant_id AND parent.remittance_id=x.remittance_id AND parent.entry_id=e.reverses_id);
CREATE TRIGGER era_row_entries_immutable BEFORE UPDATE OR DELETE ON era_row_entries FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE era_claim_heads (
 tenant_id uuid NOT NULL,claim_id uuid NOT NULL,remittance_id uuid NOT NULL,row_index integer NOT NULL,claim_version bigint NOT NULL,
 PRIMARY KEY(tenant_id,claim_id),FOREIGN KEY(tenant_id,claim_id) REFERENCES ehr_claims(tenant_id,id),
 FOREIGN KEY(tenant_id,remittance_id,row_index) REFERENCES era_postings(tenant_id,remittance_id,row_index)
);
INSERT INTO era_claim_heads SELECT p.tenant_id,p.claim_id,p.remittance_id,p.row_index,c.version FROM era_postings p JOIN ehr_claims c ON c.tenant_id=p.tenant_id AND c.id=p.claim_id JOIN era_remittances r ON r.tenant_id=p.tenant_id AND r.id=p.remittance_id WHERE r.status='posted' AND p.posted_claim_version=c.version;
CREATE TABLE era_posting_contexts (
 tenant_id uuid NOT NULL,remittance_id uuid NOT NULL,row_index integer NOT NULL,prior_head jsonb,
 PRIMARY KEY(tenant_id,remittance_id,row_index),FOREIGN KEY(tenant_id,remittance_id,row_index) REFERENCES era_postings(tenant_id,remittance_id,row_index)
);
INSERT INTO era_posting_contexts SELECT p.tenant_id,p.remittance_id,p.row_index,CASE WHEN x.original_remittance_id IS NOT NULL THEN jsonb_build_object('remittance_id',x.original_remittance_id,'row_index',x.original_row_index) ELSE NULL END FROM era_postings p LEFT JOIN era_claim_recoveries x ON x.tenant_id=p.tenant_id AND x.remittance_id=p.remittance_id AND x.row_index=p.row_index;
CREATE TRIGGER era_posting_contexts_immutable BEFORE UPDATE OR DELETE ON era_posting_contexts FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
ALTER TABLE era_remittances ADD COLUMN receipt_part integer NOT NULL DEFAULT 0 CHECK(receipt_part>=0);
ALTER TABLE era_remittances DROP CONSTRAINT era_remittances_tenant_id_payer_id_trace_key;
ALTER TABLE era_remittances ADD UNIQUE(tenant_id,payer_id,trace,receipt_part);
CREATE TABLE era_batches (
 tenant_id uuid NOT NULL,id uuid NOT NULL,request_id uuid NOT NULL,creation_hash text NOT NULL,
 original_text text NOT NULL,original_hash text NOT NULL,source_history_id uuid,
 status text NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','reviewed','posted','reversed')),version bigint NOT NULL DEFAULT 1,
 reviewed_versions jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,original_hash),UNIQUE(tenant_id,source_history_id),
 FOREIGN KEY(tenant_id,source_history_id) REFERENCES historical_records(tenant_id,id)
);
CREATE TABLE era_batch_items (
 tenant_id uuid NOT NULL,batch_id uuid NOT NULL,position integer NOT NULL,remittance_id uuid NOT NULL,controls jsonb NOT NULL,
 PRIMARY KEY(tenant_id,batch_id,position),UNIQUE(tenant_id,remittance_id),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES era_batches(tenant_id,id),FOREIGN KEY(tenant_id,remittance_id) REFERENCES era_remittances(tenant_id,id)
);
CREATE TABLE era_batch_events (
 tenant_id uuid NOT NULL,batch_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,batch_id,version),FOREIGN KEY(tenant_id,batch_id) REFERENCES era_batches(tenant_id,id)
);
CREATE TRIGGER era_batch_items_immutable BEFORE UPDATE OR DELETE ON era_batch_items FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER era_batch_events_immutable BEFORE UPDATE OR DELETE ON era_batch_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION protect_era_batch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.request_id<>OLD.request_id OR NEW.creation_hash<>OLD.creation_hash OR NEW.original_text<>OLD.original_text OR NEW.original_hash<>OLD.original_hash OR NEW.source_history_id IS DISTINCT FROM OLD.source_history_id THEN RAISE EXCEPTION 'ERA batch source is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER era_batch_source_immutable BEFORE UPDATE ON era_batches FOR EACH ROW EXECUTE FUNCTION protect_era_batch();
CREATE TRIGGER era_batch_no_delete BEFORE DELETE ON era_batches FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION protect_era_receipt_part() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.receipt_part<>OLD.receipt_part THEN RAISE EXCEPTION 'ERA receipt part is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER era_receipt_part_immutable BEFORE UPDATE ON era_remittances FOR EACH ROW EXECUTE FUNCTION protect_era_receipt_part();
