CREATE FUNCTION protect_recoupment_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.remittance_id<>OLD.remittance_id OR NEW.row_index<>OLD.row_index THEN
 RAISE EXCEPTION 'recoupment source identity is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER recoupment_identity_immutable BEFORE UPDATE ON era_recoupment_cases FOR EACH ROW EXECUTE FUNCTION protect_recoupment_identity();
CREATE TRIGGER recoupment_no_delete BEFORE DELETE ON era_recoupment_cases FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
