-- Tenant-local catalog for declarative open-source connector manifests.
CREATE TABLE connector_installations (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 connector_id text NOT NULL CHECK (length(connector_id) BETWEEN 3 AND 120),
 request_id uuid NOT NULL,
 request_digest text NOT NULL CHECK (length(request_digest)=64),
 status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled','enabled','deactivated')),
 current_revision bigint NOT NULL DEFAULT 1 CHECK (current_revision > 0),
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 UNIQUE (tenant_id,connector_id),
 UNIQUE (tenant_id,request_id)
);

CREATE TABLE connector_installation_revisions (
 tenant_id uuid NOT NULL,
 installation_id uuid NOT NULL,
 revision bigint NOT NULL CHECK (revision > 0),
 manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object' AND pg_column_size(manifest)<=262144),
 manifest_digest text NOT NULL CHECK (length(manifest_digest)=64),
 provenance text NOT NULL CHECK (provenance IN ('builtin','community')),
 repository_url text NOT NULL CHECK (length(repository_url) BETWEEN 12 AND 2000),
 source_revision text NOT NULL CHECK (length(source_revision) BETWEEN 7 AND 200),
 source_digest text NOT NULL CHECK (length(source_digest)=64),
 created_by uuid NOT NULL,
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,installation_id,revision),
 FOREIGN KEY (tenant_id,installation_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX connector_installations_status
 ON connector_installations(tenant_id,status,connector_id,id);

CREATE TABLE connector_installation_events (
 tenant_id uuid NOT NULL,
 installation_id uuid NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK (action IN ('enable','disable','deactivate')),
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,installation_id,sequence),
 FOREIGN KEY (tenant_id,installation_id) REFERENCES connector_installations(tenant_id,id)
);

CREATE TRIGGER connector_installation_revisions_immutable
 BEFORE UPDATE OR DELETE ON connector_installation_revisions
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER connector_installation_events_immutable
 BEFORE UPDATE OR DELETE ON connector_installation_events
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION preserve_connector_installation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.connector_id IS DISTINCT FROM OLD.connector_id OR
    NEW.request_id IS DISTINCT FROM OLD.request_id OR
    NEW.request_digest IS DISTINCT FROM OLD.request_digest OR
    NEW.created_by IS DISTINCT FROM OLD.created_by OR
    NEW.created_at IS DISTINCT FROM OLD.created_at OR
    NEW.version <> OLD.version + 1 OR
    NEW.current_revision NOT IN (OLD.current_revision, OLD.current_revision + 1) OR
    (NEW.current_revision = OLD.current_revision AND NEW.status IS NOT DISTINCT FROM OLD.status) OR
    (NEW.current_revision = OLD.current_revision + 1 AND NEW.status IS DISTINCT FROM OLD.status) OR
    NEW.updated_at <= OLD.updated_at OR
    (OLD.status='deactivated' AND NEW.status IS DISTINCT FROM OLD.status) THEN
   RAISE EXCEPTION 'invalid connector installation revision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER connector_installation_identity_immutable
 BEFORE UPDATE ON connector_installations
 FOR EACH ROW EXECUTE FUNCTION preserve_connector_installation_identity();
CREATE TRIGGER connector_installations_no_delete
 BEFORE DELETE ON connector_installations
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
