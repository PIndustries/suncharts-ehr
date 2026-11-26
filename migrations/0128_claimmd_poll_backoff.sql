-- Preserve the most recent legacy reservations during an upgrade. Treat all
-- reservations in a legacy bucket as recent as that bucket's final request.
CREATE TABLE claimmd_api_reservations (
 account_hash text NOT NULL,
 reserved_at timestamptz NOT NULL
);
CREATE INDEX claimmd_api_reservations_recent
 ON claimmd_api_reservations (account_hash,reserved_at DESC);
INSERT INTO claimmd_api_reservations(account_hash,reserved_at)
 SELECT account_hash,updated_at
 FROM claimmd_api_rate_windows
 CROSS JOIN LATERAL generate_series(1,request_count)
 WHERE updated_at>clock_timestamp()-interval '60 seconds';

-- A provider cooldown spans all routes that use the same Claim.MD account key.
CREATE TABLE claimmd_api_cooldowns (
 account_hash text PRIMARY KEY,
 blocked_until timestamptz NOT NULL
);
ALTER TABLE edi_connections ADD COLUMN poll_failures integer NOT NULL DEFAULT 0
 CHECK (poll_failures BETWEEN 0 AND 6);
ALTER TABLE edi_era_feeds ADD COLUMN poll_failures integer NOT NULL DEFAULT 0
 CHECK (poll_failures BETWEEN 0 AND 6);
