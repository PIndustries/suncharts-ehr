-- SPDX-License-Identifier: AGPL-3.0-only
-- A practice owner chooses whether an insurance payment (ERA/835) whose every
-- claim line matches exactly one of our claims and whose amounts reconcile
-- posts itself. There was no practice-wide billing settings store before this:
-- payer, clearinghouse and reminder settings live per connection or per feed,
-- and none of them is a single owner-editable practice switch. One row per
-- practice, defaulting to on, is the smallest store that holds it. No existing
-- row is rewritten and no ledger entry is touched.
CREATE TABLE practice_era_posting_settings (
 tenant_id uuid PRIMARY KEY,
 auto_post boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- Every change is attributed and kept, the same way the other practice
-- settings stores keep their history.
CREATE TABLE practice_era_posting_setting_history (
 tenant_id uuid NOT NULL,
 version bigint NOT NULL,
 actor_id uuid NOT NULL,
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
 auto_post boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,version),
 FOREIGN KEY(tenant_id) REFERENCES practice_era_posting_settings(tenant_id)
);
CREATE FUNCTION preserve_era_posting_setting_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ERA posting setting history is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER era_posting_setting_history_immutable BEFORE UPDATE OR DELETE ON practice_era_posting_setting_history FOR EACH ROW EXECUTE FUNCTION preserve_era_posting_setting_history();
-- A version only ever moves forward by one, so a stale form cannot overwrite
-- a newer choice.
CREATE FUNCTION protect_era_posting_setting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id <> OLD.tenant_id OR NEW.version <> OLD.version + 1 THEN
  RAISE EXCEPTION 'invalid ERA posting setting identity or version' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER era_posting_setting_guard BEFORE UPDATE ON practice_era_posting_settings FOR EACH ROW EXECUTE FUNCTION protect_era_posting_setting();
CREATE TRIGGER era_posting_setting_no_delete BEFORE DELETE ON practice_era_posting_settings FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
