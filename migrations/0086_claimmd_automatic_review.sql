-- Claim.MD retrieval remains automatic. Prepare downloaded remittances for
-- review by default while preserving explicit owner opt-outs. Ledger posting
-- continues to require staff review.
ALTER TABLE edi_era_feeds ALTER COLUMN auto_stage SET DEFAULT true;

UPDATE edi_era_feeds f
SET auto_stage = true,
    version = version + 1
WHERE NOT f.auto_stage
  AND NOT EXISTS (
    SELECT 1
    FROM edi_era_feed_events e
    WHERE e.tenant_id = f.tenant_id
      AND e.route_key = f.route_key
      AND e.evidence->>'action' IN ('enable_staging', 'disable_staging')
  );
