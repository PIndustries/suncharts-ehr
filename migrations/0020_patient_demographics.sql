-- Native contact details do not rewrite patient identity or historical claim snapshots.
CREATE FUNCTION valid_patient_contact(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; item jsonb; maxlen integer; nested jsonb; part text; val jsonb;
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOR k,item IN SELECT key,value FROM jsonb_each(v) LOOP
  IF k NOT IN ('preferred_name','pronouns','language','administrative_gender','phone','email','address','emergency_contact') THEN RETURN false; END IF;
  IF item='null'::jsonb THEN CONTINUE; END IF;
  IF k IN ('address','emergency_contact') THEN
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
   nested=item;
   FOR part,val IN SELECT key,value FROM jsonb_each(nested) LOOP
    maxlen=CASE WHEN k='address' THEN CASE part WHEN 'line1' THEN 200 WHEN 'line2' THEN 200 WHEN 'city' THEN 100 WHEN 'region' THEN 100 WHEN 'postal_code' THEN 32 WHEN 'country' THEN 2 ELSE 0 END ELSE CASE part WHEN 'name' THEN 200 WHEN 'relationship' THEN 100 WHEN 'phone' THEN 40 ELSE 0 END END;
    IF maxlen=0 THEN RETURN false; END IF;
    IF val='null'::jsonb THEN CONTINUE; END IF;
    IF jsonb_typeof(val) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    IF length(val#>>'{}') NOT BETWEEN 1 AND maxlen OR (val#>>'{}')<>btrim(val#>>'{}') OR (val#>>'{}')~'[[:cntrl:]]' THEN RETURN false; END IF;
    IF part='country' AND (val#>>'{}')!~'^[A-Z]{2}$' THEN RETURN false; END IF;
    IF part='phone' AND ((val#>>'{}')!~'[0-9]' OR (val#>>'{}')!~'^[0-9+(). xX#-]+$') THEN RETURN false; END IF;
   END LOOP;
   IF k='emergency_contact' AND (nested->>'name' IS NULL OR length(nested->>'name')=0) THEN RETURN false; END IF;
  ELSE
   maxlen=CASE k WHEN 'preferred_name' THEN 100 WHEN 'pronouns' THEN 100 WHEN 'language' THEN 100 WHEN 'administrative_gender' THEN 20 WHEN 'phone' THEN 40 WHEN 'email' THEN 254 END;
   IF jsonb_typeof(item) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
   IF length(item#>>'{}') NOT BETWEEN 1 AND maxlen OR (item#>>'{}')<>btrim(item#>>'{}') OR (item#>>'{}')~'[[:cntrl:]]' THEN RETURN false; END IF;
   IF k='administrative_gender' AND (item#>>'{}') NOT IN ('female','male','other','unknown') THEN RETURN false; END IF;
   IF k='phone' AND ((item#>>'{}')!~'[0-9]' OR (item#>>'{}')!~'^[0-9+(). xX#-]+$') THEN RETURN false; END IF;
   IF k='email' AND (item#>>'{}')!~'^[^@[:space:]]+@[^@[:space:].][^@[:space:]]*\.[^@[:space:].]+$' THEN RETURN false; END IF;
  END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE TABLE patient_demographics (
 tenant_id uuid NOT NULL, patient_id uuid NOT NULL,
 version bigint NOT NULL CHECK(version>0), content jsonb NOT NULL CHECK(valid_patient_contact(content)),
 PRIMARY KEY(tenant_id,patient_id), FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id)
);
CREATE TABLE patient_demographics_history (
 tenant_id uuid NOT NULL, patient_id uuid NOT NULL, version bigint NOT NULL CHECK(version>0),
 content jsonb NOT NULL CHECK(valid_patient_contact(content)), author_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000 AND reason=btrim(reason) AND reason!~'[[:cntrl:]]'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,patient_id,version),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patient_demographics(tenant_id,patient_id)
);
CREATE TRIGGER patient_demographics_history_immutable BEFORE UPDATE OR DELETE ON patient_demographics_history FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER patient_demographics_no_delete BEFORE DELETE ON patient_demographics FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION preserve_patient_contact_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'contact identity immutable and version must advance once' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER patient_demographics_update_guard BEFORE UPDATE ON patient_demographics FOR EACH ROW EXECUTE FUNCTION preserve_patient_contact_identity();
