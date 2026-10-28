-- Clinical release, administrative checkout and follow-up are independent of accounting.
CREATE TABLE avs_releases (
 tenant_id uuid NOT NULL,visit_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND length(content->>'instructions') BETWEEN 1 AND 10000 AND length(content->>'follow_up_instructions')<=5000),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND snapshot ?& ARRAY['patient','visit','medications','orders','snapshot_at']),
 released_by uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000 AND reason=btrim(reason)),released_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,visit_id,version),FOREIGN KEY(tenant_id,visit_id) REFERENCES visits(tenant_id,id)
);
CREATE TRIGGER avs_releases_immutable BEFORE UPDATE OR DELETE ON avs_releases FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION validate_avs_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM visits WHERE tenant_id=NEW.tenant_id AND id=NEW.visit_id AND status='signed' AND clinician_id=NEW.released_by) THEN RAISE EXCEPTION 'assigned clinician must release signed visit instructions'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER avs_release_author BEFORE INSERT ON avs_releases FOR EACH ROW EXECUTE FUNCTION validate_avs_release();
CREATE TABLE visit_checkout (
 tenant_id uuid NOT NULL,visit_id uuid NOT NULL,version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 current_avs_version bigint,checked_out_at timestamptz,checked_out_by uuid,
 PRIMARY KEY(tenant_id,visit_id),FOREIGN KEY(tenant_id,visit_id) REFERENCES visits(tenant_id,id),
 FOREIGN KEY(tenant_id,visit_id,current_avs_version) REFERENCES avs_releases(tenant_id,visit_id,version),
 CHECK((checked_out_at IS NULL AND checked_out_by IS NULL) OR (checked_out_at IS NOT NULL AND checked_out_by IS NOT NULL AND current_avs_version IS NOT NULL))
);
CREATE FUNCTION preserve_checkout_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.visit_id<>OLD.visit_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid checkout identity or version'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER checkout_version BEFORE UPDATE ON visit_checkout FOR EACH ROW EXECUTE FUNCTION preserve_checkout_version();
CREATE TRIGGER checkout_no_delete BEFORE DELETE ON visit_checkout FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE checkout_events (
 tenant_id uuid NOT NULL,id uuid NOT NULL,visit_id uuid NOT NULL,checkout_version bigint NOT NULL CHECK(checkout_version>0),
 action text NOT NULL CHECK(action IN ('release_avs','checkout','delivery')),avs_version bigint NOT NULL,
 method text CHECK(method IN ('print','declined','other')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000 AND reason=btrim(reason)),actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,visit_id,checkout_version),
 FOREIGN KEY(tenant_id,visit_id) REFERENCES visit_checkout(tenant_id,visit_id),
 FOREIGN KEY(tenant_id,visit_id,avs_version) REFERENCES avs_releases(tenant_id,visit_id,version),
 CHECK((action='delivery' AND method IS NOT NULL) OR (action<>'delivery' AND method IS NULL))
);
CREATE TRIGGER checkout_events_immutable BEFORE UPDATE OR DELETE ON checkout_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE follow_up_tasks (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,visit_id uuid NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),request_id uuid NOT NULL,creation_hash text NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200 AND title=btrim(title)),
 instructions text NOT NULL CHECK(length(instructions) BETWEEN 1 AND 4000 AND instructions=btrim(instructions)),
 assigned_to uuid NOT NULL,due_date date NOT NULL CHECK(due_date BETWEEN '2000-01-01' AND '2100-12-31'),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','cancelled')),
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,visit_id,patient_id) REFERENCES visits(tenant_id,id,patient_id),
 FOREIGN KEY(tenant_id,assigned_to) REFERENCES browser_users(tenant_id,id)
);
CREATE INDEX followup_worklist ON follow_up_tasks(tenant_id,status,due_date,id);
CREATE FUNCTION preserve_follow_up_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.patient_id<>OLD.patient_id OR NEW.visit_id<>OLD.visit_id OR NEW.request_id<>OLD.request_id OR NEW.creation_hash<>OLD.creation_hash OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid follow-up identity or version'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER followup_identity BEFORE UPDATE ON follow_up_tasks FOR EACH ROW EXECUTE FUNCTION preserve_follow_up_identity();
CREATE TRIGGER followup_no_delete BEFORE DELETE ON follow_up_tasks FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE follow_up_history (
 tenant_id uuid NOT NULL,task_id uuid NOT NULL,version bigint NOT NULL,snapshot jsonb NOT NULL,
 action text NOT NULL CHECK(action IN ('create','complete','cancel','reopen','reassign','reschedule')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000 AND reason=btrim(reason)),actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,task_id,version),FOREIGN KEY(tenant_id,task_id) REFERENCES follow_up_tasks(tenant_id,id)
);
CREATE TRIGGER followup_history_immutable BEFORE UPDATE OR DELETE ON follow_up_history FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
