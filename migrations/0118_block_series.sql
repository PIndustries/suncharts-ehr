-- SPDX-License-Identifier: AGPL-3.0-only
-- Repeating block time. A series is the record that a set of blocks was made together ("Lunch,
-- every weekday until March"). Every occurrence is an ordinary block in schedule_blocks that
-- carries the series it came from, so one can be removed alone, or the rest of the series with it.

CREATE TABLE schedule_block_series (
 tenant_id uuid NOT NULL, id uuid NOT NULL, clinician_id uuid NOT NULL,
 label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
 repeat text NOT NULL CHECK (length(repeat) BETWEEN 1 AND 200),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 request_id uuid NOT NULL, request_digest text NOT NULL,
 PRIMARY KEY (tenant_id,id), UNIQUE(tenant_id,request_id)
);
ALTER TABLE schedule_blocks ADD COLUMN series_id uuid;
CREATE INDEX schedule_blocks_series ON schedule_blocks(tenant_id,series_id,starts_at) WHERE series_id IS NOT NULL;
