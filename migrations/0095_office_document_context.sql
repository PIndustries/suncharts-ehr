-- SPDX-License-Identifier: AGPL-3.0-only
-- Do not guess an old editor's document context. Existing sessions remain NULL
-- and must be reopened; original uploads and saved versions are unchanged.
ALTER TABLE office_editor_sessions ADD COLUMN metadata_version bigint CHECK(metadata_version>=1);
-- protect_office_editor_session already treats all fields other than its explicit
-- mutable allowlist as immutable, including this new binding.
