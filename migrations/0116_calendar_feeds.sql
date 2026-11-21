-- SPDX-License-Identifier: AGPL-3.0-only
-- A staff member's private calendar link. Their own Google or Microsoft 365 calendar subscribes
-- to it and shows when they are busy in the practice schedule: the times only, never who the
-- appointment is with or what it is for. One link per person; making a new one or turning it off
-- stops the old link at once. Only a hash of the link's secret is kept.

CREATE TABLE calendar_feeds (
 tenant_id uuid NOT NULL, user_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(length(token_hash)=64),
 created_at timestamptz NOT NULL DEFAULT now(),
 last_read_at timestamptz,
 PRIMARY KEY(tenant_id,user_id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES browser_users(tenant_id,id)
);
