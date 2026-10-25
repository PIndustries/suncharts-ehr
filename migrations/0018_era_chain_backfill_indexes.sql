-- Restore an unambiguous head after a recovery was undone by the pre-chain engine.
INSERT INTO era_claim_heads(tenant_id,claim_id,remittance_id,row_index,claim_version)
SELECT p.tenant_id,p.claim_id,x.original_remittance_id,x.original_row_index,c.version
FROM era_claim_recoveries x JOIN era_postings p ON p.tenant_id=x.tenant_id AND p.remittance_id=x.remittance_id AND p.row_index=x.row_index
JOIN era_remittances recovery ON recovery.tenant_id=x.tenant_id AND recovery.id=x.remittance_id
JOIN era_remittances original ON original.tenant_id=x.tenant_id AND original.id=x.original_remittance_id
JOIN ehr_claims c ON c.tenant_id=p.tenant_id AND c.id=p.claim_id
WHERE recovery.status='reversed' AND original.status='posted' AND c.status='adjudicated' AND c.version=p.posted_claim_version+1
ON CONFLICT DO NOTHING;
CREATE INDEX era_row_entries_lookup ON era_row_entries(tenant_id,remittance_id,row_index);
CREATE INDEX era_batches_recent ON era_batches(tenant_id,created_at DESC,id);
