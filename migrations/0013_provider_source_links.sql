-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE edi_remote_source_links (
 tenant_id uuid NOT NULL,source_history_id uuid NOT NULL,report_id uuid NOT NULL,
 request_id uuid NOT NULL,creation_hash text NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,source_history_id),UNIQUE(tenant_id,report_id),UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,source_history_id) REFERENCES historical_records(tenant_id,id),
 FOREIGN KEY(tenant_id,report_id) REFERENCES edi_remote_reports(tenant_id,id)
);
CREATE TRIGGER edi_remote_source_immutable BEFORE UPDATE OR DELETE ON edi_remote_source_links FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
