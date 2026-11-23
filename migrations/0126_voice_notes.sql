-- SPDX-License-Identifier: AGPL-3.0-only
-- Voice notes: a clinician records a dictation or a visit on an encounter. The recording is kept
-- in the chart as an encounter file; this table holds where it is on its way to a drafted note:
-- saved, waiting in line for the transcription service, transcribing, drafting, then ready.
-- The transcript and the draft live here only until the clinician uses or dismisses them; nothing
-- here is part of the signed note, and dismissing a voice note clears its text.
CREATE TABLE voice_notes (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 visit_id uuid NOT NULL,
 patient_id uuid NOT NULL,
 created_by uuid NOT NULL,
 mode text NOT NULL CHECK (mode IN ('dictation','encounter')),
 consent_recorded boolean NOT NULL DEFAULT false,
 consent_at timestamptz,
 document_id uuid NOT NULL,
 content_type text NOT NULL CHECK (content_type IN ('audio/webm','audio/mp4','audio/ogg','audio/wav','audio/mpeg')),
 duration_seconds double precision CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 86400),
 stage text NOT NULL DEFAULT 'saved' CHECK (stage IN ('saved','waiting','transcribing','drafting','ready','failed')),
 position integer CHECK (position IS NULL OR position >= 0),
 transcribe_request_id uuid NOT NULL,
 draft_request_id uuid,
 transcript text CHECK (transcript IS NULL OR length(transcript) <= 200000),
 draft jsonb CHECK (draft IS NULL OR jsonb_typeof(draft)='object'),
 error text CHECK (error IS NULL OR error IN ('unavailable','timeout','upstream_error','empty','draft_invalid')),
 dismissed boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 PRIMARY KEY (tenant_id, id),
 FOREIGN KEY (tenant_id, visit_id) REFERENCES visits(tenant_id, id),
 FOREIGN KEY (tenant_id, document_id, patient_id) REFERENCES patient_documents(tenant_id, id, patient_id),
 CHECK (mode <> 'encounter' OR (consent_recorded AND consent_at IS NOT NULL)),
 CHECK (stage <> 'ready' OR draft IS NOT NULL),
 CHECK (stage NOT IN ('ready','failed') OR finished_at IS NOT NULL)
);
CREATE UNIQUE INDEX voice_notes_transcribe_job ON voice_notes(tenant_id, transcribe_request_id);
CREATE INDEX voice_notes_draft_job ON voice_notes(tenant_id, draft_request_id) WHERE draft_request_id IS NOT NULL;
CREATE INDEX voice_notes_by_visit ON voice_notes(tenant_id, visit_id, created_at DESC);
CREATE INDEX voice_notes_unfinished ON voice_notes(stage, updated_at) WHERE stage IN ('saved','waiting','transcribing','drafting');
