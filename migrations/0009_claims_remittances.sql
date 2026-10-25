CREATE TABLE ehr_claims (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,account_id uuid NOT NULL,
 payer_id uuid NOT NULL,control_number text NOT NULL,frequency text NOT NULL CHECK(frequency IN ('original','replacement','void_request')),
 parent_id uuid,content jsonb NOT NULL,snapshot jsonb NOT NULL,status text NOT NULL DEFAULT 'draft'
 CHECK(status IN ('draft','ready','submitted','accepted','rejected','adjudicated','void')),
 version bigint NOT NULL DEFAULT 1,payer_control_number text NOT NULL DEFAULT '',
 request_id uuid NOT NULL,creation_hash text NOT NULL,source_history_id uuid,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,control_number),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,source_history_id),
 FOREIGN KEY(tenant_id,account_id,patient_id) REFERENCES billing_accounts(tenant_id,id,patient_id),
 FOREIGN KEY(tenant_id,payer_id) REFERENCES ehr_payers(tenant_id,id),
 FOREIGN KEY(tenant_id,parent_id) REFERENCES ehr_claims(tenant_id,id),
 FOREIGN KEY(tenant_id,source_history_id) REFERENCES historical_records(tenant_id,id)
);
CREATE UNIQUE INDEX claim_active_account ON ehr_claims(tenant_id,account_id) WHERE status IN ('draft','ready','submitted','accepted');
CREATE TABLE claim_revisions (
 tenant_id uuid NOT NULL,claim_id uuid NOT NULL,version bigint NOT NULL,snapshot jsonb NOT NULL,
 actor_id uuid NOT NULL,reason text NOT NULL,evidence jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,claim_id,version),FOREIGN KEY(tenant_id,claim_id) REFERENCES ehr_claims(tenant_id,id)
);
CREATE TRIGGER claim_revisions_immutable BEFORE UPDATE OR DELETE ON claim_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION protect_claim_packet() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status<>'draft' AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
 OR NEW.account_id<>OLD.account_id OR NEW.patient_id<>OLD.patient_id OR NEW.payer_id<>OLD.payer_id
 OR NEW.frequency<>OLD.frequency OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
 OR NEW.control_number<>OLD.control_number OR NEW.source_history_id IS DISTINCT FROM OLD.source_history_id
 OR NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id) THEN
 RAISE EXCEPTION 'released claim packet is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER claim_packet_immutable BEFORE UPDATE ON ehr_claims FOR EACH ROW EXECUTE FUNCTION protect_claim_packet();
CREATE TRIGGER claim_no_delete BEFORE DELETE ON ehr_claims FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE era_remittances (
 tenant_id uuid NOT NULL,id uuid NOT NULL,payer_id uuid NOT NULL,trace text NOT NULL,
 document jsonb NOT NULL,original_text text,document_hash text NOT NULL,
 status text NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','reconciled','posted','reversed','rejected')),
 version bigint NOT NULL DEFAULT 1,matches jsonb NOT NULL DEFAULT '[]',
 request_id uuid NOT NULL,creation_hash text NOT NULL,source_history_id uuid,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,payer_id,trace),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,source_history_id),
 FOREIGN KEY(tenant_id,payer_id) REFERENCES ehr_payers(tenant_id,id),
 FOREIGN KEY(tenant_id,source_history_id) REFERENCES historical_records(tenant_id,id)
);
CREATE TABLE era_revisions (
 tenant_id uuid NOT NULL,remittance_id uuid NOT NULL,version bigint NOT NULL,snapshot jsonb NOT NULL,
 actor_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,remittance_id,version),FOREIGN KEY(tenant_id,remittance_id) REFERENCES era_remittances(tenant_id,id)
);
CREATE TRIGGER era_revisions_immutable BEFORE UPDATE OR DELETE ON era_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE era_postings (
 tenant_id uuid NOT NULL,remittance_id uuid NOT NULL,row_index integer NOT NULL,claim_id uuid NOT NULL,account_id uuid NOT NULL,
 claim_status_before text NOT NULL,claim_control_before text NOT NULL,posted_claim_version bigint NOT NULL,
 patient_responsibility_cents bigint NOT NULL,writeoff_cents bigint NOT NULL,
 PRIMARY KEY(tenant_id,remittance_id,row_index),UNIQUE(tenant_id,remittance_id,claim_id),
 FOREIGN KEY(tenant_id,remittance_id) REFERENCES era_remittances(tenant_id,id),
 FOREIGN KEY(tenant_id,claim_id) REFERENCES ehr_claims(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES billing_accounts(tenant_id,id)
);
CREATE TABLE era_posting_entries (
 tenant_id uuid NOT NULL,remittance_id uuid NOT NULL,entry_id uuid NOT NULL,account_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,entry_id),FOREIGN KEY(tenant_id,remittance_id) REFERENCES era_remittances(tenant_id,id),
 FOREIGN KEY(tenant_id,entry_id,account_id) REFERENCES billing_entries(tenant_id,id,account_id)
);
CREATE TRIGGER era_postings_immutable BEFORE UPDATE OR DELETE ON era_postings FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER era_posting_entries_immutable BEFORE UPDATE OR DELETE ON era_posting_entries FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION protect_era_document() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.document IS DISTINCT FROM OLD.document OR NEW.original_text IS DISTINCT FROM OLD.original_text
 OR NEW.document_hash<>OLD.document_hash OR NEW.payer_id<>OLD.payer_id OR NEW.trace<>OLD.trace
 OR NEW.source_history_id IS DISTINCT FROM OLD.source_history_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id
 OR (OLD.status IN ('posted','reversed','rejected') AND NEW.matches IS DISTINCT FROM OLD.matches) THEN
 RAISE EXCEPTION 'remittance evidence is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER era_document_immutable BEFORE UPDATE ON era_remittances FOR EACH ROW EXECUTE FUNCTION protect_era_document();
CREATE TRIGGER era_no_delete BEFORE DELETE ON era_remittances FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
