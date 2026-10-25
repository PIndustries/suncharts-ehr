CREATE TABLE era_provider_reviews (
 tenant_id uuid NOT NULL,remittance_id uuid NOT NULL,version bigint NOT NULL,
 decisions jsonb NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,remittance_id,version),FOREIGN KEY(tenant_id,remittance_id) REFERENCES era_remittances(tenant_id,id)
);
CREATE TRIGGER era_provider_reviews_immutable BEFORE UPDATE OR DELETE ON era_provider_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE era_provider_entries (
 tenant_id uuid NOT NULL,id uuid NOT NULL,remittance_id uuid NOT NULL,row_index integer NOT NULL,
 provider_id text NOT NULL,payer_id uuid NOT NULL,effect_cents bigint NOT NULL,category text NOT NULL,
 evidence jsonb NOT NULL,reverses_id uuid,actor_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,reverses_id),
 FOREIGN KEY(tenant_id,remittance_id) REFERENCES era_remittances(tenant_id,id),
 FOREIGN KEY(tenant_id,payer_id) REFERENCES ehr_payers(tenant_id,id),
 FOREIGN KEY(tenant_id,reverses_id) REFERENCES era_provider_entries(tenant_id,id)
);
CREATE UNIQUE INDEX provider_original_row ON era_provider_entries(tenant_id,remittance_id,row_index) WHERE reverses_id IS NULL;
CREATE TRIGGER era_provider_entries_immutable BEFORE UPDATE OR DELETE ON era_provider_entries FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE era_recoupment_cases (
 tenant_id uuid NOT NULL,id uuid NOT NULL,remittance_id uuid NOT NULL,row_index integer NOT NULL,
 version bigint NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','disputed','acknowledged','closed','void')),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,remittance_id,row_index),
 FOREIGN KEY(tenant_id,remittance_id) REFERENCES era_remittances(tenant_id,id)
);
CREATE TABLE era_recoupment_events (
 tenant_id uuid NOT NULL,case_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL,
 evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,case_id,version),FOREIGN KEY(tenant_id,case_id) REFERENCES era_recoupment_cases(tenant_id,id)
);
CREATE TRIGGER era_recoupment_events_immutable BEFORE UPDATE OR DELETE ON era_recoupment_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE era_claim_recoveries (
 tenant_id uuid NOT NULL,remittance_id uuid NOT NULL,row_index integer NOT NULL,
 original_remittance_id uuid NOT NULL,original_row_index integer NOT NULL,
 PRIMARY KEY(tenant_id,remittance_id,row_index),
 FOREIGN KEY(tenant_id,remittance_id,row_index) REFERENCES era_postings(tenant_id,remittance_id,row_index),
 FOREIGN KEY(tenant_id,original_remittance_id,original_row_index) REFERENCES era_postings(tenant_id,remittance_id,row_index)
);
CREATE TRIGGER era_claim_recoveries_immutable BEFORE UPDATE OR DELETE ON era_claim_recoveries FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
