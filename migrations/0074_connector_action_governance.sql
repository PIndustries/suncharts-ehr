-- Reviewed, tenant-scoped execution records for native connector actions.
CREATE TABLE connector_action_invocations (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 request_id uuid NOT NULL,
 connector_key text NOT NULL CHECK (connector_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
 action_key text NOT NULL CHECK (action_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
 action_version text NOT NULL CHECK (length(action_version) BETWEEN 1 AND 64),
 operation_class text NOT NULL CHECK (operation_class IN ('read','idempotent_update','clinical_write','communication','charge')),
 authority text NOT NULL CHECK (authority IN ('staff','scheduling','rooming','clinical','owner')),
 approval_policy text NOT NULL CHECK (approval_policy IN ('none','owner','clinician','owner_or_clinician')),
 retry_class text NOT NULL CHECK (retry_class IN ('never','bounded_safe')),
 separation_of_duties boolean NOT NULL DEFAULT false,
 sandbox boolean NOT NULL DEFAULT false,
 sample_id text CHECK (sample_id IS NULL OR length(sample_id) BETWEEN 1 AND 120),
 input jsonb NOT NULL CHECK (jsonb_typeof(input)='object' AND pg_column_size(input)<=262144),
 input_digest text NOT NULL CHECK (length(input_digest)=64),
 status text NOT NULL CHECK (status IN ('pending_review','ready','executing','retry_wait','succeeded','failed','needs_reconciliation','rejected','cancelled','sandboxed')),
 result_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_evidence)='object' AND pg_column_size(result_evidence)<=262144),
 failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 100),
 created_by uuid NOT NULL,
 reviewed_by uuid,
 review_reason text CHECK (review_reason IS NULL OR length(review_reason) BETWEEN 1 AND 1000),
 reviewed_at timestamptz,
 attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
 max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
 next_attempt_at timestamptz,
 lease_owner uuid,
 lease_expires_at timestamptz,
 version bigint NOT NULL DEFAULT 1 CHECK (version>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 UNIQUE (tenant_id,request_id),
 CHECK ((sandbox AND sample_id IS NOT NULL AND status='sandboxed') OR (NOT sandbox AND sample_id IS NULL)),
 CHECK (retry_class='bounded_safe' OR max_attempts=1),
 CHECK (operation_class IN ('read','idempotent_update') OR retry_class='never'),
 CHECK (operation_class<>'charge' OR approval_policy='owner'),
 CHECK (operation_class NOT IN ('clinical_write','communication') OR approval_policy IN ('owner','clinician','owner_or_clinician')),
 CHECK ((status='executing')=(lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
 CHECK ((reviewed_at IS NULL)=(reviewed_by IS NULL))
);
CREATE INDEX connector_action_worklist
 ON connector_action_invocations(tenant_id,status,next_attempt_at,created_at,id);

CREATE FUNCTION preserve_connector_action_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
    NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.connector_key IS DISTINCT FROM OLD.connector_key OR
    NEW.action_key IS DISTINCT FROM OLD.action_key OR NEW.action_version IS DISTINCT FROM OLD.action_version OR
    NEW.operation_class IS DISTINCT FROM OLD.operation_class OR NEW.authority IS DISTINCT FROM OLD.authority OR
    NEW.approval_policy IS DISTINCT FROM OLD.approval_policy OR NEW.retry_class IS DISTINCT FROM OLD.retry_class OR
    NEW.separation_of_duties IS DISTINCT FROM OLD.separation_of_duties OR NEW.sandbox IS DISTINCT FROM OLD.sandbox OR
    NEW.sample_id IS DISTINCT FROM OLD.sample_id OR NEW.input IS DISTINCT FROM OLD.input OR
    NEW.input_digest IS DISTINCT FROM OLD.input_digest OR NEW.created_by IS DISTINCT FROM OLD.created_by OR
    NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts OR
    NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN
   RAISE EXCEPTION 'invalid connector action invocation revision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER connector_action_identity_immutable BEFORE UPDATE ON connector_action_invocations
 FOR EACH ROW EXECUTE FUNCTION preserve_connector_action_identity();
CREATE TRIGGER connector_action_invocations_no_delete BEFORE DELETE ON connector_action_invocations
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE connector_action_events (
 tenant_id uuid NOT NULL,
 invocation_id uuid NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object' AND pg_column_size(evidence)<=262144),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,invocation_id,sequence),
 FOREIGN KEY (tenant_id,invocation_id) REFERENCES connector_action_invocations(tenant_id,id)
);
CREATE TRIGGER connector_action_events_immutable BEFORE UPDATE OR DELETE ON connector_action_events
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
