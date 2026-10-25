-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE edi_connections (
 tenant_id uuid NOT NULL,route_key text NOT NULL,partner_id uuid NOT NULL,usage text NOT NULL,adapter text NOT NULL,
 binding_hash text NOT NULL,start_at timestamptz NOT NULL,page_token text,
 paused boolean NOT NULL DEFAULT false,version bigint NOT NULL DEFAULT 1,
 lease_id uuid,lease_until timestamptz,next_poll_at timestamptz NOT NULL DEFAULT now(),
 last_poll_at timestamptz,last_success_at timestamptz,last_result text,pages bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,route_key),FOREIGN KEY(tenant_id,partner_id) REFERENCES edi_partners(tenant_id,id)
);
CREATE TABLE edi_connection_events (
 tenant_id uuid NOT NULL,route_key text NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,
 reason text NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,route_key,version),FOREIGN KEY(tenant_id,route_key) REFERENCES edi_connections(tenant_id,route_key)
);
CREATE TABLE edi_remote_reports (
 tenant_id uuid NOT NULL,id uuid NOT NULL,route_key text NOT NULL,remote_id text NOT NULL,
 format text NOT NULL,metadata jsonb NOT NULL,status text NOT NULL,
 version bigint NOT NULL DEFAULT 1,attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_id uuid,lease_until timestamptz,
 original_text text,original_hash text,parse_summary jsonb NOT NULL DEFAULT '{}',last_result text,
 native_kind text,native_id uuid,received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,route_key,remote_id),
 FOREIGN KEY(tenant_id,route_key) REFERENCES edi_connections(tenant_id,route_key),
 CHECK(status IN ('pending','leased','retrieved','quarantined','ignored'))
);
CREATE TABLE edi_remote_report_events (
 tenant_id uuid NOT NULL,report_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,
 reason text NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,report_id,version),FOREIGN KEY(tenant_id,report_id) REFERENCES edi_remote_reports(tenant_id,id)
);
CREATE FUNCTION protect_remote_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.route_key<>OLD.route_key OR NEW.remote_id<>OLD.remote_id OR NEW.metadata<>OLD.metadata OR NEW.format<>OLD.format
 OR (OLD.original_text IS NOT NULL AND (NEW.original_text IS DISTINCT FROM OLD.original_text OR NEW.original_hash IS DISTINCT FROM OLD.original_hash))
 OR (OLD.native_id IS NOT NULL AND (NEW.native_id IS DISTINCT FROM OLD.native_id OR NEW.native_kind IS DISTINCT FROM OLD.native_kind))
 THEN RAISE EXCEPTION 'remote report evidence is immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER protect_remote_report BEFORE UPDATE ON edi_remote_reports FOR EACH ROW EXECUTE FUNCTION protect_remote_report();
CREATE TRIGGER edi_remote_report_no_delete BEFORE DELETE ON edi_remote_reports FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER edi_connection_no_delete BEFORE DELETE ON edi_connections FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER edi_connection_events_immutable BEFORE UPDATE OR DELETE ON edi_connection_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER edi_report_events_immutable BEFORE UPDATE OR DELETE ON edi_remote_report_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
