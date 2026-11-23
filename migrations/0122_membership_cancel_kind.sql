-- Retiring a membership price is a stored request like the other native membership requests.
-- Cancelling a membership now is stored as a cancellation whose request records the kind, so it needs no column.
DO $$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint
  WHERE conrelid='patient_membership_operations'::regclass AND contype='c'
   AND (pg_get_constraintdef(oid) LIKE '%kind = ANY%' OR pg_get_constraintdef(oid) LIKE '%(kind = ''price''::text) = (patient_id IS NULL)%')
 LOOP
  EXECUTE format('ALTER TABLE patient_membership_operations DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE patient_membership_operations
 ADD CONSTRAINT patient_membership_operations_kind_check CHECK(kind IN ('price','membership','cancel','price_retire')),
 ADD CONSTRAINT patient_membership_operations_scope_check CHECK((kind IN ('price','price_retire'))=(patient_id IS NULL));
