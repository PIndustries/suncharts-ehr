-- SunCharts AI reads an encounter's note in the background and suggests diagnosis codes.
-- A request waits in line with the assistant; this table holds what the clinician has been told
-- and, once the answer is in, the checked suggestions. Suggestions are never part of the chart:
-- nothing here changes a diagnosis, and old rows are swept after a day.
CREATE TABLE diagnosis_suggestion_requests (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 visit_id uuid NOT NULL,
 requested_by uuid NOT NULL,
 note_version bigint NOT NULL,
 status text NOT NULL CHECK (status IN ('queued','ready','failed','dismissed')),
 position integer CHECK (position IS NULL OR position >= 0),
 result jsonb CHECK (result IS NULL OR jsonb_typeof(result)='object'),
 error text CHECK (error IS NULL OR length(error) <= 200),
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 PRIMARY KEY (tenant_id, id),
 FOREIGN KEY (tenant_id, visit_id) REFERENCES visits(tenant_id, id),
 CHECK (status <> 'queued' OR (result IS NULL AND finished_at IS NULL))
);
-- One unfinished request per encounter.
CREATE UNIQUE INDEX diagnosis_suggestion_one_waiting ON diagnosis_suggestion_requests(tenant_id, visit_id) WHERE status = 'queued';
CREATE INDEX diagnosis_suggestion_by_visit ON diagnosis_suggestion_requests(tenant_id, visit_id, created_at DESC);
CREATE INDEX diagnosis_suggestion_age ON diagnosis_suggestion_requests(created_at);
-- Connect now also tells the EHR when a queued assistant job has finished.
ALTER TABLE connect_remote_events DROP CONSTRAINT connect_remote_events_kind_check;
ALTER TABLE connect_remote_events ADD CONSTRAINT connect_remote_events_kind_check
 CHECK (kind IN ('support.reply','support.updated','reminder.delivery','ai.job'));
