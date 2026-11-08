-- Published pathways receive native events without a separate connector setup.
CREATE TABLE workflow_native_starts (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 event_id uuid NOT NULL,
 definition_id uuid NOT NULL,
 definition_version bigint NOT NULL,
 trigger_type text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','superseded','failed')),
 attempts integer NOT NULL DEFAULT 0,
 lease_until timestamptz,
 lease_token uuid,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,event_id,definition_id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES automation_events(tenant_id,id),
 FOREIGN KEY(tenant_id,definition_id,definition_version) REFERENCES care_pathway_definition_revisions(tenant_id,definition_id,version)
);
CREATE INDEX workflow_native_starts_pending ON workflow_native_starts(status,created_at);
ALTER TABLE workflow_dispatches DROP CONSTRAINT workflow_dispatches_kind_check;
ALTER TABLE workflow_dispatches ADD CONSTRAINT workflow_dispatches_kind_check CHECK(kind IN ('availability_query','slot_hold','appointment_booking','appointment_reschedule','appointment_cancel','intake_request','patient_form','communication_send','ai_extract_draft','ai_response_draft','eligibility_query','payment_request'));
ALTER TABLE workflow_dispatches DROP CONSTRAINT workflow_dispatches_downstream_kind_check;
ALTER TABLE workflow_dispatches ADD CONSTRAINT workflow_dispatches_downstream_kind_check CHECK(downstream_kind IS NULL OR downstream_kind IN ('gmail_draft','ringcentral_draft','claude_draft','ai_draft','payment','intake_packet'));
