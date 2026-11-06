CREATE TABLE claude_drafts (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 request_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 patient_id uuid,
 pathway_instance_id uuid,
 step_key text,
 purpose text NOT NULL CHECK (purpose IN ('document_classification','structured_extraction','draft_summary','draft_response')),
 model text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
 status text NOT NULL CHECK (status IN ('requesting','draft','failed','approved','rejected')),
 request_digest text NOT NULL CHECK (length(request_digest)=64),
 content text CHECK (content IS NULL OR length(content) <= 131072),
 provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 200),
 provider_request_id text CHECK (provider_request_id IS NULL OR length(provider_request_id) <= 200),
 stop_reason text CHECK (stop_reason IS NULL OR length(stop_reason) <= 80),
 usage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(usage)='object'),
 failure_code text CHECK (failure_code IS NULL OR length(failure_code) <= 80),
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 created_by uuid NOT NULL,
 reviewed_by uuid,
 review_reason text CHECK (review_reason IS NULL OR length(review_reason) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 PRIMARY KEY (tenant_id,id),
 UNIQUE (tenant_id,request_id),
 CHECK ((pathway_instance_id IS NULL) = (step_key IS NULL)),
 CHECK ((status IN ('requesting','failed')) OR content IS NOT NULL),
 CHECK ((status IN ('approved','rejected')) = (reviewed_at IS NOT NULL)),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES instance_integrations(tenant_id,id),
 FOREIGN KEY (tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY (tenant_id,pathway_instance_id) REFERENCES care_pathway_instances(tenant_id,id)
);
CREATE INDEX claude_drafts_review_queue
 ON claude_drafts(tenant_id,status,created_at DESC,id)
 WHERE status='draft';
CREATE INDEX claude_drafts_pathway
 ON claude_drafts(tenant_id,pathway_instance_id,step_key,created_at DESC)
 WHERE pathway_instance_id IS NOT NULL;

CREATE TABLE claude_draft_events (
 tenant_id uuid NOT NULL,
 draft_id uuid NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,draft_id,sequence),
 FOREIGN KEY (tenant_id,draft_id) REFERENCES claude_drafts(tenant_id,id)
);
CREATE TRIGGER claude_draft_events_immutable
BEFORE UPDATE OR DELETE ON claude_draft_events
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION preserve_claude_draft_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
   RAISE EXCEPTION 'invalid Claude draft revision' USING ERRCODE='23514';
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
    NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.integration_id IS DISTINCT FROM OLD.integration_id OR
    NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.pathway_instance_id IS DISTINCT FROM OLD.pathway_instance_id OR
    NEW.step_key IS DISTINCT FROM OLD.step_key OR NEW.purpose IS DISTINCT FROM OLD.purpose OR
    NEW.model IS DISTINCT FROM OLD.model OR NEW.request_digest IS DISTINCT FROM OLD.request_digest OR
    NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'Claude draft identity is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status='requesting' THEN
   IF NEW.status NOT IN ('draft','failed') OR NEW.reviewed_by IS NOT NULL OR
      NEW.review_reason IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
     RAISE EXCEPTION 'invalid Claude provider-result transition' USING ERRCODE='23514';
   END IF;
 ELSIF OLD.status='draft' THEN
   IF NEW.status NOT IN ('approved','rejected') OR NEW.reviewed_by IS NULL OR
      NEW.review_reason IS NULL OR NEW.reviewed_at IS NULL OR
      NEW.content IS DISTINCT FROM OLD.content OR
      NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id OR
      NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id OR
      NEW.stop_reason IS DISTINCT FROM OLD.stop_reason OR
      NEW.usage IS DISTINCT FROM OLD.usage OR NEW.failure_code IS DISTINCT FROM OLD.failure_code THEN
     RAISE EXCEPTION 'invalid Claude review transition' USING ERRCODE='23514';
   END IF;
 ELSIF NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'reviewed Claude draft is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER claude_draft_identity_immutable
BEFORE UPDATE ON claude_drafts
FOR EACH ROW EXECUTE FUNCTION preserve_claude_draft_identity();
CREATE TRIGGER claude_draft_no_delete
BEFORE DELETE ON claude_drafts
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
