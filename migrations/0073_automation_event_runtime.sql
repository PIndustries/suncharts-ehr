-- Instance-local, durable trigger event runtime. Provider actions remain in reviewed dispatchers.
CREATE TABLE automation_trigger_subscriptions (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 installation_id uuid NOT NULL,
 connector_key text NOT NULL CHECK (connector_key ~ '^[a-z][a-z0-9_.-]{1,159}$'),
 trigger_key text NOT NULL CHECK (trigger_key ~ '^[a-z][a-z0-9_.-]{1,159}$'),
 event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9_-]*){2,}$' AND length(event_type)<=180),
 transport text NOT NULL CHECK (transport IN ('internal','webhook','websocket','polling')),
 status text NOT NULL DEFAULT 'configured' CHECK (status IN ('configured','active','inactive','error')),
 configuration jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (configuration='{}'::jsonb),
 version bigint NOT NULL DEFAULT 1 CHECK (version>0),
 created_by uuid NOT NULL,
 configured_at timestamptz NOT NULL DEFAULT now(),
 activated_at timestamptz,
 deactivated_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 UNIQUE (tenant_id,connector_key,trigger_key),
 FOREIGN KEY (tenant_id,installation_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX automation_trigger_subscriptions_active
 ON automation_trigger_subscriptions(tenant_id,event_type,id) WHERE status='active';

CREATE TABLE automation_trigger_subscription_history (
 tenant_id uuid NOT NULL,
 subscription_id uuid NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK (action IN ('configured','activated','deactivated')),
 reason_digest text NOT NULL CHECK (length(reason_digest)=64),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,subscription_id,sequence),
 FOREIGN KEY (tenant_id,subscription_id) REFERENCES automation_trigger_subscriptions(tenant_id,id)
);
CREATE TRIGGER automation_trigger_subscription_history_immutable
 BEFORE UPDATE OR DELETE ON automation_trigger_subscription_history
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION preserve_automation_subscription_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
    NEW.installation_id IS DISTINCT FROM OLD.installation_id OR
    NEW.connector_key IS DISTINCT FROM OLD.connector_key OR NEW.trigger_key IS DISTINCT FROM OLD.trigger_key OR
    NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.transport IS DISTINCT FROM OLD.transport OR
    NEW.configuration IS DISTINCT FROM OLD.configuration OR NEW.created_by IS DISTINCT FROM OLD.created_by OR
    NEW.configured_at IS DISTINCT FROM OLD.configured_at OR NEW.version<>OLD.version+1 OR
    NEW.updated_at<OLD.updated_at THEN
   RAISE EXCEPTION 'invalid automation subscription revision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_subscription_identity_immutable BEFORE UPDATE ON automation_trigger_subscriptions
 FOR EACH ROW EXECUTE FUNCTION preserve_automation_subscription_identity();
CREATE TRIGGER automation_subscriptions_no_delete BEFORE DELETE ON automation_trigger_subscriptions
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE automation_events (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9_-]*){2,}$' AND length(event_type)<=180),
 source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_.-]{1,159}$'),
 source_event_id text NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 240),
 dedup_key text NOT NULL CHECK (length(dedup_key)=64),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND pg_column_size(payload)<=262144),
 payload_digest text NOT NULL CHECK (length(payload_digest)=64),
 classification text NOT NULL CHECK (classification IN ('non_phi','phi')),
 occurred_at timestamptz NOT NULL,
 retained_until timestamptz NOT NULL,
 payload_erased_at timestamptz,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 UNIQUE (tenant_id,dedup_key),
 CHECK (retained_until>created_at),
 CHECK (payload_erased_at IS NULL OR (classification='phi' AND payload='{}'::jsonb AND payload_erased_at>=retained_until))
);
CREATE INDEX automation_events_retention ON automation_events(tenant_id,retained_until,id);
CREATE FUNCTION preserve_automation_event_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'automation events cannot be deleted' USING ERRCODE='23514';
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
    NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.source IS DISTINCT FROM OLD.source OR
    NEW.source_event_id IS DISTINCT FROM OLD.source_event_id OR NEW.dedup_key IS DISTINCT FROM OLD.dedup_key OR
    NEW.payload_digest IS DISTINCT FROM OLD.payload_digest OR NEW.classification IS DISTINCT FROM OLD.classification OR
    NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.retained_until IS DISTINCT FROM OLD.retained_until OR
    NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
    OLD.payload_erased_at IS NOT NULL OR NEW.payload_erased_at IS NULL OR
    OLD.classification<>'phi' OR NEW.payload<>'{}'::jsonb OR NEW.payload_erased_at<OLD.retained_until THEN
   RAISE EXCEPTION 'automation event identity and retained payload are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_events_immutable BEFORE UPDATE OR DELETE ON automation_events
 FOR EACH ROW EXECUTE FUNCTION preserve_automation_event_identity();

CREATE TABLE automation_event_deliveries (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 event_id uuid NOT NULL,
 subscription_id uuid NOT NULL,
 replay_of uuid,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','delivered','dead_letter','cancelled')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
 max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,
 lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 120),
 lease_expires_at timestamptz,
 last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,80}$'),
 delivered_at timestamptz,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,event_id) REFERENCES automation_events(tenant_id,id),
 FOREIGN KEY (tenant_id,subscription_id) REFERENCES automation_trigger_subscriptions(tenant_id,id),
 FOREIGN KEY (tenant_id,replay_of) REFERENCES automation_event_deliveries(tenant_id,id),
 CHECK ((status='leased')=(lease_token IS NOT NULL)),
 CHECK ((status='leased')=(lease_owner IS NOT NULL)),
 CHECK ((status='leased')=(lease_expires_at IS NOT NULL)),
 CHECK ((status='delivered')=(delivered_at IS NOT NULL))
);
CREATE INDEX automation_event_deliveries_queue
 ON automation_event_deliveries(status,next_attempt_at,tenant_id,id)
 WHERE status IN ('pending','leased');
CREATE UNIQUE INDEX automation_event_initial_delivery
 ON automation_event_deliveries(tenant_id,event_id,subscription_id)
 WHERE replay_of IS NULL;

CREATE TABLE automation_event_delivery_history (
 tenant_id uuid NOT NULL,
 delivery_id uuid NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{1,119}$'),
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object' AND pg_column_size(evidence)<=32768),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,delivery_id,sequence),
 FOREIGN KEY (tenant_id,delivery_id) REFERENCES automation_event_deliveries(tenant_id,id)
);
CREATE TRIGGER automation_event_delivery_history_immutable
 BEFORE UPDATE OR DELETE ON automation_event_delivery_history
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION preserve_automation_delivery_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
    NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id OR
    NEW.replay_of IS DISTINCT FROM OLD.replay_of OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts OR
    NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'automation delivery identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_delivery_identity_immutable BEFORE UPDATE ON automation_event_deliveries
 FOR EACH ROW EXECUTE FUNCTION preserve_automation_delivery_identity();
CREATE TRIGGER automation_deliveries_no_delete BEFORE DELETE ON automation_event_deliveries
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
