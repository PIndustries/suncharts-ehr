-- Native scheduling extends existing visit appointments without rewriting history.
ALTER TABLE appointments DROP CONSTRAINT appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check CHECK
 (status IN ('booked','checked_in','in_progress','completed','cancelled','no_show'));
ALTER TABLE appointments ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 ADD COLUMN title text NOT NULL DEFAULT 'Office visit' CHECK (length(title) BETWEEN 1 AND 200),
 ADD COLUMN category text NOT NULL DEFAULT 'Office visit' CHECK (length(category) BETWEEN 1 AND 100),
 ADD COLUMN facility text NOT NULL DEFAULT '' CHECK (length(facility) <= 200),
 ADD COLUMN room text NOT NULL DEFAULT '' CHECK (length(room) <= 100),
 ADD COLUMN notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
 ADD COLUMN source_history_id uuid,
 ADD COLUMN request_id uuid,
 ADD COLUMN request_digest text;
CREATE UNIQUE INDEX appointment_request ON appointments(tenant_id,request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX appointment_source ON appointments(tenant_id,source_history_id) WHERE source_history_id IS NOT NULL;
CREATE TABLE appointment_revisions (
 tenant_id uuid NOT NULL, appointment_id uuid NOT NULL, version bigint NOT NULL,
 snapshot jsonb NOT NULL, actor_id uuid NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,appointment_id,version),
 FOREIGN KEY (tenant_id,appointment_id) REFERENCES appointments(tenant_id,id)
);
CREATE TRIGGER append_only_appointment_revisions BEFORE UPDATE OR DELETE ON appointment_revisions
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE schedule_blocks (
 tenant_id uuid NOT NULL, id uuid NOT NULL, clinician_id uuid NOT NULL,
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK (ends_at>starts_at),
 label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
 version bigint NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true,
 request_id uuid NOT NULL, request_digest text NOT NULL,
 PRIMARY KEY (tenant_id,id), UNIQUE(tenant_id,request_id)
);
CREATE INDEX schedule_blocks_range ON schedule_blocks(tenant_id,clinician_id,starts_at) WHERE active;
-- Preserve a baseline for appointments that existed before versioned scheduling.
INSERT INTO appointment_revisions (tenant_id,appointment_id,version,snapshot,actor_id,reason)
 SELECT tenant_id,id,version,to_jsonb(a)-'tenant_id'-'request_digest'-'request_id',clinician_id,
 'Existing appointment at scheduling upgrade; original author not inferred' FROM appointments a;
CREATE TABLE schedule_block_cancellations (
 tenant_id uuid NOT NULL, block_id uuid NOT NULL, actor_id uuid NOT NULL,
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,block_id),
 FOREIGN KEY (tenant_id,block_id) REFERENCES schedule_blocks(tenant_id,id)
);
CREATE TRIGGER append_only_block_cancellations BEFORE UPDATE OR DELETE ON schedule_block_cancellations
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
