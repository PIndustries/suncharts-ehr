-- Workflow forms are immutable patient packets pinned to the run's definition.
ALTER TABLE previsit_intake_packets
 DROP CONSTRAINT previsit_intake_packets_tenant_id_appointment_id_key,
 ALTER COLUMN template_id DROP NOT NULL,
 ADD COLUMN workflow_instance_id uuid,
 ADD COLUMN workflow_step_key text,
 ADD COLUMN workflow_definition_version bigint,
 ADD CONSTRAINT previsit_workflow_binding_complete CHECK (
  (workflow_instance_id IS NULL AND workflow_step_key IS NULL AND workflow_definition_version IS NULL AND template_id IS NOT NULL)
  OR (workflow_instance_id IS NOT NULL AND workflow_step_key IS NOT NULL AND workflow_definition_version IS NOT NULL AND workflow_definition_version>0 AND template_id IS NULL AND template_version=workflow_definition_version)
 ),
 ADD FOREIGN KEY(tenant_id,workflow_instance_id,workflow_step_key)
  REFERENCES care_pathway_steps(tenant_id,instance_id,step_key);
CREATE UNIQUE INDEX previsit_legacy_appointment_packet ON previsit_intake_packets(tenant_id,appointment_id) WHERE workflow_instance_id IS NULL;
CREATE UNIQUE INDEX previsit_workflow_step_packet ON previsit_intake_packets(tenant_id,workflow_instance_id,workflow_step_key) WHERE workflow_instance_id IS NOT NULL;

CREATE OR REPLACE FUNCTION previsit_intake_packet_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.template_id IS DISTINCT FROM OLD.template_id OR NEW.template_version IS DISTINCT FROM OLD.template_version OR NEW.template_snapshot IS DISTINCT FROM OLD.template_snapshot OR NEW.access_token_hash IS DISTINCT FROM OLD.access_token_hash OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.issued_by IS DISTINCT FROM OLD.issued_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.workflow_instance_id IS DISTINCT FROM OLD.workflow_instance_id OR NEW.workflow_step_key IS DISTINCT FROM OLD.workflow_step_key OR NEW.workflow_definition_version IS DISTINCT FROM OLD.workflow_definition_version OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'invalid intake packet identity or version' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
