-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TRIGGER practice_admin_history_immutable
 BEFORE UPDATE OR DELETE ON practice_admin_history
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
