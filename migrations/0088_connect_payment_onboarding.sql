-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE connect_service_settings
    ADD COLUMN connection_id uuid;

UPDATE connect_service_settings AS settings
SET connection_id = (
    SELECT bootstrap.connection_id
    FROM managed_connect_bootstrap AS bootstrap
    WHERE bootstrap.tenant_id = settings.tenant_id
      AND bootstrap.connection_id IS NOT NULL
    ORDER BY bootstrap.completed_at DESC NULLS LAST, bootstrap.updated_at DESC
    LIMIT 1
)
WHERE settings.connection_id IS NULL
  AND EXISTS (
      SELECT 1
      FROM managed_connect_bootstrap AS bootstrap
      WHERE bootstrap.tenant_id = settings.tenant_id
        AND bootstrap.connection_id IS NOT NULL
  );
