-- A diagnosis suggestion request now runs in two steps: the assistant first lists the problems the
-- note states, the EHR looks up real codes for them in the practice's own list, and the assistant
-- then chooses among those codes. These columns hold where the request is, what the first step
-- found with its candidate codes, and the second job's id. Existing requests are in the first step.
ALTER TABLE diagnosis_suggestion_requests
 ADD COLUMN stage text NOT NULL DEFAULT 'extract' CHECK (stage IN ('extract','choose')),
 ADD COLUMN problems jsonb CHECK (problems IS NULL OR jsonb_typeof(problems)='array'),
 ADD COLUMN choose_id uuid;
CREATE INDEX diagnosis_suggestion_choose_job ON diagnosis_suggestion_requests(tenant_id, choose_id) WHERE choose_id IS NOT NULL;
