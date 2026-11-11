-- Registration identifiers remain stable across identity corrections.
-- Existing and migrated MRNs are preserved; reviewed imports can still insert
-- their established identifiers when creating a new patient.
CREATE FUNCTION preserve_patient_mrn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.mrn IS DISTINCT FROM OLD.mrn THEN
  RAISE EXCEPTION 'MRN is system-assigned and cannot be changed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER patient_mrn_immutable BEFORE UPDATE OF mrn ON patients
 FOR EACH ROW EXECUTE FUNCTION preserve_patient_mrn();
