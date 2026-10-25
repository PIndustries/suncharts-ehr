-- Local insurance administration and an append-only billing ledger. No payment rail.
CREATE TABLE ehr_payers (
 tenant_id uuid NOT NULL,id uuid NOT NULL,content jsonb NOT NULL,version bigint NOT NULL DEFAULT 1,
 request_id uuid NOT NULL,creation_hash text NOT NULL,source_history_id uuid,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,source_history_id),
 FOREIGN KEY(tenant_id,source_history_id) REFERENCES historical_records(tenant_id,id)
);
CREATE TABLE payer_revisions (
 tenant_id uuid NOT NULL,payer_id uuid NOT NULL,version bigint NOT NULL,snapshot jsonb NOT NULL,
 actor_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,payer_id,version),FOREIGN KEY(tenant_id,payer_id) REFERENCES ehr_payers(tenant_id,id)
);
CREATE TRIGGER payer_revisions_immutable BEFORE UPDATE OR DELETE ON payer_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE insurance_coverages (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,payer_id uuid NOT NULL,
 content jsonb NOT NULL,version bigint NOT NULL DEFAULT 1,request_id uuid NOT NULL,creation_hash text NOT NULL,source_history_id uuid,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,patient_id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,source_history_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,payer_id) REFERENCES ehr_payers(tenant_id,id),
 FOREIGN KEY(tenant_id,source_history_id) REFERENCES historical_records(tenant_id,id)
);
CREATE TABLE coverage_revisions (
 tenant_id uuid NOT NULL,coverage_id uuid NOT NULL,version bigint NOT NULL,snapshot jsonb NOT NULL,
 actor_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,coverage_id,version),FOREIGN KEY(tenant_id,coverage_id) REFERENCES insurance_coverages(tenant_id,id)
);
CREATE TRIGGER coverage_revisions_immutable BEFORE UPDATE OR DELETE ON coverage_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE billing_accounts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,visit_id uuid,coverage_id uuid,
 content jsonb NOT NULL,coverage_snapshot jsonb,total_cents bigint NOT NULL CHECK(total_cents BETWEEN 1 AND 1000000000),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','void')),version bigint NOT NULL DEFAULT 1,
 request_id uuid NOT NULL,creation_hash text NOT NULL,source_history_id uuid,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,patient_id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,source_history_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,visit_id,patient_id) REFERENCES visits(tenant_id,id,patient_id),
 FOREIGN KEY(tenant_id,coverage_id,patient_id) REFERENCES insurance_coverages(tenant_id,id,patient_id),
 FOREIGN KEY(tenant_id,source_history_id) REFERENCES historical_records(tenant_id,id),
 CHECK (visit_id IS NOT NULL OR source_history_id IS NOT NULL)
);
CREATE UNIQUE INDEX billing_visit_once ON billing_accounts(tenant_id,visit_id) WHERE status<>'void' AND visit_id IS NOT NULL;
CREATE TABLE billing_account_revisions (
 tenant_id uuid NOT NULL,account_id uuid NOT NULL,version bigint NOT NULL,snapshot jsonb NOT NULL,
 actor_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,account_id,version),FOREIGN KEY(tenant_id,account_id) REFERENCES billing_accounts(tenant_id,id)
);
CREATE TRIGGER billing_revisions_immutable BEFORE UPDATE OR DELETE ON billing_account_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE billing_entries (
 tenant_id uuid NOT NULL,id uuid NOT NULL,account_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('payment','adjustment_credit','adjustment_debit','reversal')),
 effect_cents bigint NOT NULL CHECK(effect_cents<>0 AND abs(effect_cents)<=1000000000),
 content jsonb NOT NULL,request_id uuid NOT NULL,creation_hash text NOT NULL,reverses_id uuid,
 actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,account_id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,reverses_id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES billing_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,reverses_id,account_id) REFERENCES billing_entries(tenant_id,id,account_id)
);
CREATE TRIGGER billing_entries_immutable BEFORE UPDATE OR DELETE ON billing_entries FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER billing_accounts_no_delete BEFORE DELETE ON billing_accounts FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION protect_posted_billing() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status IN ('posted','void') AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.total_cents<>OLD.total_cents
 OR NEW.coverage_snapshot IS DISTINCT FROM OLD.coverage_snapshot OR NEW.patient_id<>OLD.patient_id
 OR NEW.visit_id IS DISTINCT FROM OLD.visit_id OR NEW.coverage_id IS DISTINCT FROM OLD.coverage_id
 OR NEW.source_history_id IS DISTINCT FROM OLD.source_history_id OR NEW.status<>OLD.status
 OR NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id) THEN
 RAISE EXCEPTION 'posted or void billing content is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER protect_posted_billing BEFORE UPDATE ON billing_accounts FOR EACH ROW EXECUTE FUNCTION protect_posted_billing();
