-- Durable, reviewed execution boundary between Workflow Studio and native EHR operations.
CREATE TABLE workflow_dispatches (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 request_id uuid NOT NULL,
 pathway_instance_id uuid NOT NULL,
 step_key text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('availability_query','slot_hold','appointment_booking','appointment_reschedule','appointment_cancel','intake_request','communication_send','ai_extract_draft','ai_response_draft')),
 status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','executing','downstream_review','completed','rejected','failed')),
 input jsonb NOT NULL CHECK (jsonb_typeof(input)='object' AND pg_column_size(input)<=262144),
 input_digest text NOT NULL CHECK (length(input_digest)=64),
 downstream_kind text CHECK (downstream_kind IS NULL OR downstream_kind IN ('gmail_draft','ringcentral_draft','claude_draft')),
 downstream_id uuid,
 result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result)='object' AND pg_column_size(result)<=262144),
 failure_code text CHECK (failure_code IS NULL OR length(failure_code)<=100),
 version bigint NOT NULL DEFAULT 1 CHECK (version>0),
 created_by uuid NOT NULL,
 reviewed_by uuid,
 review_reason text CHECK (review_reason IS NULL OR length(review_reason) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 UNIQUE (tenant_id,request_id),
 FOREIGN KEY (tenant_id,pathway_instance_id,step_key) REFERENCES care_pathway_steps(tenant_id,instance_id,step_key),
 CHECK ((downstream_kind IS NULL)=(downstream_id IS NULL)),
 CHECK ((status IN ('executing','downstream_review','completed','rejected','failed'))=(reviewed_at IS NOT NULL))
);
CREATE UNIQUE INDEX workflow_dispatch_step_open
 ON workflow_dispatches(tenant_id,pathway_instance_id,step_key)
 WHERE status IN ('pending_review','executing','downstream_review');
CREATE INDEX workflow_dispatch_worklist
 ON workflow_dispatches(tenant_id,status,created_at,id);

CREATE TABLE workflow_dispatch_events (
 tenant_id uuid NOT NULL,
 dispatch_id uuid NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object' AND pg_column_size(evidence)<=262144),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,dispatch_id,sequence),
 FOREIGN KEY (tenant_id,dispatch_id) REFERENCES workflow_dispatches(tenant_id,id)
);
CREATE TRIGGER workflow_dispatch_events_immutable BEFORE UPDATE OR DELETE ON workflow_dispatch_events
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION preserve_workflow_dispatch_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
    NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.pathway_instance_id IS DISTINCT FROM OLD.pathway_instance_id OR
    NEW.step_key IS DISTINCT FROM OLD.step_key OR NEW.kind IS DISTINCT FROM OLD.kind OR
    NEW.input IS DISTINCT FROM OLD.input OR NEW.input_digest IS DISTINCT FROM OLD.input_digest OR
    NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
    NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN
   RAISE EXCEPTION 'invalid workflow dispatch revision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_dispatch_identity_immutable BEFORE UPDATE ON workflow_dispatches
 FOR EACH ROW EXECUTE FUNCTION preserve_workflow_dispatch_identity();
CREATE TRIGGER workflow_dispatch_no_delete BEFORE DELETE ON workflow_dispatches
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
