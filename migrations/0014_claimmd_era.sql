-- Independent provider ERA cursor; automation stages evidence, never posts money.
CREATE TABLE edi_era_feeds (
 tenant_id uuid NOT NULL,route_key text NOT NULL,cursor_id text NOT NULL DEFAULT '0',
 auto_stage boolean NOT NULL DEFAULT false,version bigint NOT NULL DEFAULT 1,
 next_poll_at timestamptz NOT NULL DEFAULT now(),lease_id uuid,lease_until timestamptz,
 last_success_at timestamptz,last_result text,pages bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,route_key),FOREIGN KEY(tenant_id,route_key) REFERENCES edi_connections(tenant_id,route_key)
);
CREATE TABLE edi_era_feed_events (
 tenant_id uuid NOT NULL,route_key text NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,
 reason text NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,route_key,version),FOREIGN KEY(tenant_id,route_key) REFERENCES edi_era_feeds(tenant_id,route_key)
);
CREATE TRIGGER edi_era_feed_events_immutable BEFORE UPDATE OR DELETE ON edi_era_feed_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE edi_era_automation (
 tenant_id uuid NOT NULL,report_id uuid NOT NULL,status text NOT NULL CHECK(status IN ('held','staged')),
 remittance_id uuid,CHECK((status='staged')=(remittance_id IS NOT NULL)),issues jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,report_id),FOREIGN KEY(tenant_id,report_id) REFERENCES edi_remote_reports(tenant_id,id),
 FOREIGN KEY(tenant_id,remittance_id) REFERENCES era_remittances(tenant_id,id)
);
CREATE TRIGGER edi_era_automation_immutable BEFORE UPDATE OR DELETE ON edi_era_automation FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
