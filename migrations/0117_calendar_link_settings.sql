-- SPDX-License-Identifier: AGPL-3.0-only
-- The practice's own switch for private calendar links. A practice with no row allows them.
-- While it is off, nobody can make a link and existing links answer as if they did not exist;
-- turning it back on lets them work again.

CREATE TABLE practice_calendar_settings (
 tenant_id uuid PRIMARY KEY,
 links_enabled boolean NOT NULL,
 updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
