-- Bind an exact trigger subscription to its reviewed manifest action without
-- rewriting the already-applied automation runtime migration.
ALTER TABLE automation_trigger_subscriptions
 ADD COLUMN action_key text
 CHECK (action_key IS NULL OR action_key ~ '^[a-z][a-z0-9_.-]{1,159}$');

UPDATE automation_trigger_subscriptions s
 SET action_key=t.trigger->>'dispatch_action',
     version=s.version+1,
     updated_at=now()
 FROM connector_installations i
 JOIN connector_installation_revisions r
   ON r.tenant_id=i.tenant_id
  AND r.installation_id=i.id
  AND r.revision=i.current_revision
 CROSS JOIN LATERAL jsonb_array_elements(r.manifest->'triggers') t(trigger)
 WHERE i.tenant_id=s.tenant_id
   AND i.id=s.installation_id
   AND t.trigger->>'id'=s.trigger_key
   AND t.trigger->>'dispatch_action' IS NOT NULL;

CREATE OR REPLACE FUNCTION preserve_automation_subscription_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
    NEW.installation_id IS DISTINCT FROM OLD.installation_id OR
    NEW.connector_key IS DISTINCT FROM OLD.connector_key OR NEW.trigger_key IS DISTINCT FROM OLD.trigger_key OR
    NEW.action_key IS DISTINCT FROM OLD.action_key OR
    NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.transport IS DISTINCT FROM OLD.transport OR
    NEW.configuration IS DISTINCT FROM OLD.configuration OR NEW.created_by IS DISTINCT FROM OLD.created_by OR
    NEW.configured_at IS DISTINCT FROM OLD.configured_at OR NEW.version<>OLD.version+1 OR
    NEW.updated_at<OLD.updated_at THEN
   RAISE EXCEPTION 'invalid automation subscription revision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
