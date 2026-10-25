-- A correction file may contain multiple attributed postings for one native claim.
-- Row identity remains the primary key; row journals and active heads prevent double posting.
ALTER TABLE era_postings DROP CONSTRAINT era_postings_tenant_id_remittance_id_claim_id_key;
