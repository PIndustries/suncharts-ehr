ALTER TABLE visits ADD CONSTRAINT visits_patient_identity UNIQUE(tenant_id,id,patient_id);
CREATE TABLE lab_orders (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,visit_id uuid,
 request_id uuid NOT NULL,creation_hash text NOT NULL,content jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('draft','ordered','in_progress','completed','cancelled','entered_in_error')),
 version bigint NOT NULL DEFAULT 1,source_history_id uuid,
 created_by uuid NOT NULL,placed_by uuid,placed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,patient_id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,source_history_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,visit_id,patient_id) REFERENCES visits(tenant_id,id,patient_id),
 FOREIGN KEY(tenant_id,source_history_id) REFERENCES historical_records(tenant_id,id)
);
CREATE TABLE lab_order_revisions (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,version bigint NOT NULL,snapshot jsonb NOT NULL,
 author_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,order_id,version),FOREIGN KEY(tenant_id,order_id) REFERENCES lab_orders(tenant_id,id)
);
CREATE TRIGGER lab_order_history_immutable BEFORE UPDATE OR DELETE ON lab_order_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE lab_specimens (
 tenant_id uuid NOT NULL,id uuid NOT NULL,order_id uuid NOT NULL,request_id uuid NOT NULL,creation_hash text NOT NULL,
 content jsonb NOT NULL,author_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,order_id),UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES lab_orders(tenant_id,id)
);
CREATE TRIGGER lab_specimen_history_immutable BEFORE UPDATE OR DELETE ON lab_specimens FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE lab_reports (
 tenant_id uuid NOT NULL,id uuid NOT NULL,order_id uuid NOT NULL,request_id uuid NOT NULL,creation_hash text NOT NULL,
 content jsonb NOT NULL,status text NOT NULL CHECK(status IN ('preliminary','final','corrected','entered_in_error')),
 version bigint NOT NULL DEFAULT 1,source_history_id uuid,
 author_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,source_history_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES lab_orders(tenant_id,id),
 FOREIGN KEY(tenant_id,source_history_id) REFERENCES historical_records(tenant_id,id)
);
CREATE TABLE lab_report_revisions (
 tenant_id uuid NOT NULL,report_id uuid NOT NULL,version bigint NOT NULL,snapshot jsonb NOT NULL,
 author_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,report_id,version),FOREIGN KEY(tenant_id,report_id) REFERENCES lab_reports(tenant_id,id)
);
CREATE TRIGGER lab_report_history_immutable BEFORE UPDATE OR DELETE ON lab_report_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE lab_acknowledgments (
 tenant_id uuid NOT NULL,report_id uuid NOT NULL,version bigint NOT NULL,author_id uuid NOT NULL,
 note text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,report_id,version,author_id),
 FOREIGN KEY(tenant_id,report_id,version) REFERENCES lab_report_revisions(tenant_id,report_id,version)
);
CREATE TRIGGER lab_acknowledgment_immutable BEFORE UPDATE OR DELETE ON lab_acknowledgments FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE INDEX lab_order_patient ON lab_orders(tenant_id,patient_id,created_at,id);
CREATE INDEX lab_report_order ON lab_reports(tenant_id,order_id,id);
