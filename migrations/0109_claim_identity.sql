-- SPDX-License-Identifier: AGPL-3.0-only
-- A claim needs a rendering provider taxonomy and a facility street address in
-- their own fields, so one can be filled from the directory without a person
-- reading an address line back. Additive only: every existing row keeps its
-- free-text address and gets empty structured parts, and no version changes,
-- so nothing that quoted a current version is invalidated by this upgrade.
ALTER TABLE practice_providers
 ADD COLUMN taxonomy text NOT NULL DEFAULT '' CHECK (taxonomy='' OR taxonomy ~ '^[0-9A-Z]{10}$');
ALTER TABLE practice_facilities
 ADD COLUMN address_line1 text NOT NULL DEFAULT '' CHECK (length(address_line1)<=55),
 ADD COLUMN address_line2 text NOT NULL DEFAULT '' CHECK (length(address_line2)<=55),
 ADD COLUMN city text NOT NULL DEFAULT '' CHECK (length(city)<=30),
 ADD COLUMN state text NOT NULL DEFAULT '' CHECK (state='' OR state ~ '^[A-Z]{2}$'),
 ADD COLUMN postal_code text NOT NULL DEFAULT '' CHECK (postal_code='' OR postal_code ~ '^[0-9]{5}([0-9]{4})?$');
-- Read the historical free-text form "street, city, ST 12345" or
-- "street, city, ST 12345-6789" into the parts it already contains. Only a row
-- whose line and city both fit their column is filled; every other row keeps
-- empty parts and is left exactly as it was, including its address text. The
-- address column itself is not rewritten and no version is touched, so this
-- writes no history row and no guard on history can be reached.
WITH matches AS (
    SELECT tenant_id, id,
        trim((regexp_match(address,
            '^\s*(.+?),\s*([^,]+?),\s*([A-Za-z]{2})\.?\s+([0-9]{5})(-?[0-9]{4})?\s*$'))[1]) AS line1,
        trim((regexp_match(address,
            '^\s*(.+?),\s*([^,]+?),\s*([A-Za-z]{2})\.?\s+([0-9]{5})(-?[0-9]{4})?\s*$'))[2]) AS city,
        upper((regexp_match(address,
            '^\s*(.+?),\s*([^,]+?),\s*([A-Za-z]{2})\.?\s+([0-9]{5})(-?[0-9]{4})?\s*$'))[3]) AS state,
        (regexp_match(address,
            '^\s*(.+?),\s*([^,]+?),\s*([A-Za-z]{2})\.?\s+([0-9]{5})(-?[0-9]{4})?\s*$'))[4]
            || coalesce(replace((regexp_match(address,
            '^\s*(.+?),\s*([^,]+?),\s*([A-Za-z]{2})\.?\s+([0-9]{5})(-?[0-9]{4})?\s*$'))[5], '-', ''), '') AS postal
    FROM practice_facilities
)
UPDATE practice_facilities f
    SET address_line1 = m.line1, city = m.city, state = m.state, postal_code = m.postal
    FROM matches m
    WHERE f.tenant_id = m.tenant_id AND f.id = m.id
      AND m.line1 IS NOT NULL
      AND length(m.line1) <= 55 AND length(m.city) <= 30;
