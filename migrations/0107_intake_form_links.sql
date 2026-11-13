-- Intake forms can be sent from the chart without an appointment, saved part
-- way through by the patient, cancelled by staff and expire on their own.
-- Additive only: existing forms keep their appointment, answers and link, and
-- have no expiry (expires_at stays NULL).
ALTER TABLE previsit_intake_packets
 ALTER COLUMN appointment_id DROP NOT NULL,
 ADD COLUMN expires_at timestamptz,
 ADD COLUMN draft jsonb CHECK (draft IS NULL OR jsonb_typeof(draft)='object'),
 ADD COLUMN draft_saved_at timestamptz,
 ADD CONSTRAINT previsit_intake_draft_open CHECK (draft IS NULL OR status IN ('sent','in_progress')),
 -- A form without an appointment is still tied to a patient of this practice.
 -- Every existing row already satisfies this through its appointment.
 ADD CONSTRAINT previsit_intake_packets_patient_fkey FOREIGN KEY (tenant_id,patient_id) REFERENCES patients(tenant_id,id);

-- One live default form per appointment, as before. A cancelled form no longer
-- blocks sending a new link for the same appointment. No existing row is
-- cancelled, so every existing row is covered exactly as it was.
CREATE UNIQUE INDEX previsit_default_appointment_packet ON previsit_intake_packets(tenant_id,appointment_id) WHERE workflow_instance_id IS NULL AND status<>'void';
DROP INDEX previsit_legacy_appointment_packet;
CREATE INDEX previsit_patient_open_packets ON previsit_intake_packets(tenant_id,patient_id) WHERE status IN ('sent','in_progress');

-- Identity, the issued questions, the link and its expiry stay frozen. Every
-- change still advances the version, except the patient saving progress on a
-- form that has not been sent in yet. A cancelled form can never change again.
CREATE OR REPLACE FUNCTION previsit_intake_packet_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.template_id IS DISTINCT FROM OLD.template_id OR NEW.template_version IS DISTINCT FROM OLD.template_version OR NEW.template_snapshot IS DISTINCT FROM OLD.template_snapshot OR NEW.access_token_hash IS DISTINCT FROM OLD.access_token_hash OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.issued_by IS DISTINCT FROM OLD.issued_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.workflow_instance_id IS DISTINCT FROM OLD.workflow_instance_id OR NEW.workflow_step_key IS DISTINCT FROM OLD.workflow_step_key OR NEW.workflow_definition_version IS DISTINCT FROM OLD.workflow_definition_version THEN
  RAISE EXCEPTION 'invalid intake packet identity or version' USING ERRCODE='23514';
 END IF;
 IF OLD.status='void' THEN
  RAISE EXCEPTION 'a cancelled intake form cannot change' USING ERRCODE='23514';
 END IF;
 IF NEW.version=OLD.version THEN
  IF OLD.status NOT IN ('sent','in_progress') OR NEW.status<>'in_progress' OR NEW.draft IS NULL OR NEW.draft_saved_at IS NULL OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by THEN
   RAISE EXCEPTION 'invalid intake packet identity or version' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'invalid intake packet identity or version' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

-- Finding a form's own history entries (for example its last saved-progress
-- entry) no longer reads every entry of the practice.
CREATE INDEX previsit_events_packet ON previsit_events(tenant_id,packet_id,created_at DESC);
