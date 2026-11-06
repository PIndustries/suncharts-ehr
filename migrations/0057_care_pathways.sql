CREATE TABLE care_pathway_definitions (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
 description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
 trigger_type text NOT NULL,
 definition jsonb NOT NULL,
 request_id uuid NOT NULL,
 create_request jsonb NOT NULL,
 created_by uuid NOT NULL,
 updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 UNIQUE (tenant_id,slug),
 UNIQUE (tenant_id,request_id)
);

CREATE TABLE care_pathway_definition_revisions (
 tenant_id uuid NOT NULL,
 definition_id uuid NOT NULL,
 version bigint NOT NULL,
 status text NOT NULL,
 name text NOT NULL,
 description text NOT NULL,
 trigger_type text NOT NULL,
 definition jsonb NOT NULL,
 author_id uuid NOT NULL,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,definition_id,version),
 FOREIGN KEY (tenant_id,definition_id) REFERENCES care_pathway_definitions(tenant_id,id)
);
CREATE TRIGGER care_pathway_definition_revision_immutable
BEFORE UPDATE OR DELETE ON care_pathway_definition_revisions
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION preserve_care_pathway_definition_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
    NEW.slug IS DISTINCT FROM OLD.slug OR NEW.request_id IS DISTINCT FROM OLD.request_id OR
    NEW.create_request IS DISTINCT FROM OLD.create_request OR NEW.created_by IS DISTINCT FROM OLD.created_by OR
    NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'care pathway definition identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER care_pathway_definition_identity_immutable BEFORE UPDATE ON care_pathway_definitions
FOR EACH ROW EXECUTE FUNCTION preserve_care_pathway_definition_identity();
CREATE TRIGGER care_pathway_definition_no_delete BEFORE DELETE ON care_pathway_definitions
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE care_pathway_instances (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 definition_id uuid NOT NULL,
 definition_version bigint NOT NULL,
 patient_id uuid,
 appointment_id uuid,
 visit_id uuid,
 trigger_type text NOT NULL,
 trigger_key text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 context jsonb NOT NULL DEFAULT '{}'::jsonb,
 started_by uuid NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 UNIQUE (tenant_id,definition_id,definition_version,trigger_key),
 FOREIGN KEY (tenant_id,definition_id) REFERENCES care_pathway_definitions(tenant_id,id),
 FOREIGN KEY (tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY (tenant_id,appointment_id) REFERENCES appointments(tenant_id,id),
 FOREIGN KEY (tenant_id,visit_id) REFERENCES visits(tenant_id,id)
);
CREATE INDEX care_pathway_instances_patient ON care_pathway_instances(tenant_id,patient_id,started_at DESC);
CREATE INDEX care_pathway_instances_worklist ON care_pathway_instances(tenant_id,status,updated_at DESC);

CREATE TABLE care_pathway_steps (
 tenant_id uuid NOT NULL,
 instance_id uuid NOT NULL,
 step_key text NOT NULL,
 position integer NOT NULL CHECK (position >= 0),
 title text NOT NULL,
 kind text NOT NULL,
 required boolean NOT NULL,
 manual_approval boolean NOT NULL,
 state text NOT NULL CHECK (state IN ('blocked','ready','in_progress','awaiting_approval','completed','skipped')),
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 assigned_role text CHECK (assigned_role IS NULL OR assigned_role IN ('owner','clinician','nurse','medical_assistant','front_desk')),
 escalation_role text CHECK (escalation_role IS NULL OR escalation_role IN ('owner','clinician','nurse','medical_assistant','front_desk')),
 due_at timestamptz,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,instance_id,step_key),
 FOREIGN KEY (tenant_id,instance_id) REFERENCES care_pathway_instances(tenant_id,id)
);

CREATE TABLE care_pathway_events (
 tenant_id uuid NOT NULL,
 instance_id uuid NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY,
 step_key text,
 event_type text NOT NULL,
 actor_id uuid NOT NULL,
 reason text NOT NULL,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,instance_id,sequence),
 FOREIGN KEY (tenant_id,instance_id) REFERENCES care_pathway_instances(tenant_id,id)
);
CREATE TRIGGER care_pathway_event_immutable
BEFORE UPDATE OR DELETE ON care_pathway_events
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION preserve_care_pathway_instance_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
    NEW.definition_id IS DISTINCT FROM OLD.definition_id OR NEW.definition_version IS DISTINCT FROM OLD.definition_version OR
    NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id OR
    NEW.visit_id IS DISTINCT FROM OLD.visit_id OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type OR
    NEW.trigger_key IS DISTINCT FROM OLD.trigger_key OR NEW.started_by IS DISTINCT FROM OLD.started_by OR
    NEW.started_at IS DISTINCT FROM OLD.started_at THEN
   RAISE EXCEPTION 'care pathway instance identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER care_pathway_instance_identity_immutable BEFORE UPDATE ON care_pathway_instances
FOR EACH ROW EXECUTE FUNCTION preserve_care_pathway_instance_identity();
CREATE TRIGGER care_pathway_instance_no_delete BEFORE DELETE ON care_pathway_instances
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER care_pathway_step_no_delete BEFORE DELETE ON care_pathway_steps
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION preserve_care_pathway_step_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.instance_id IS DISTINCT FROM OLD.instance_id OR
    NEW.step_key IS DISTINCT FROM OLD.step_key OR NEW.position IS DISTINCT FROM OLD.position OR
    NEW.title IS DISTINCT FROM OLD.title OR NEW.kind IS DISTINCT FROM OLD.kind OR
    NEW.required IS DISTINCT FROM OLD.required OR NEW.manual_approval IS DISTINCT FROM OLD.manual_approval OR
    NEW.assigned_role IS DISTINCT FROM OLD.assigned_role OR NEW.escalation_role IS DISTINCT FROM OLD.escalation_role OR
    NEW.due_at IS DISTINCT FROM OLD.due_at THEN
   RAISE EXCEPTION 'care pathway step definition is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER care_pathway_step_identity_immutable BEFORE UPDATE ON care_pathway_steps
FOR EACH ROW EXECUTE FUNCTION preserve_care_pathway_step_identity();
