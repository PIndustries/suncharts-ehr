-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE practice_workspace_settings (
 tenant_id uuid PRIMARY KEY,
 version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
 content jsonb NOT NULL,
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE practice_workspace_setting_revisions (
 tenant_id uuid NOT NULL,
 version bigint NOT NULL,
 content jsonb NOT NULL,
 actor_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,version)
);
CREATE TRIGGER practice_workspace_setting_revision_immutable BEFORE UPDATE OR DELETE ON practice_workspace_setting_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE functional_status_assessments (
 tenant_id uuid NOT NULL,
 patient_id uuid NOT NULL,
 id uuid NOT NULL,
 request_id uuid NOT NULL,
 create_request jsonb NOT NULL,
 visit_id uuid,
 supersedes_id uuid,
 content jsonb NOT NULL,
 recorded_by uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,visit_id) REFERENCES visits(tenant_id,id),
 FOREIGN KEY(tenant_id,supersedes_id) REFERENCES functional_status_assessments(tenant_id,id)
);
CREATE INDEX functional_status_patient ON functional_status_assessments(tenant_id,patient_id,recorded_at DESC,id DESC);
CREATE TRIGGER functional_status_no_mutation BEFORE UPDATE OR DELETE ON functional_status_assessments FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE specialty_care_items (
 tenant_id uuid NOT NULL,
 patient_id uuid NOT NULL,
 id uuid NOT NULL,
 request_id uuid NOT NULL,
 create_request jsonb NOT NULL,
 visit_id uuid,
 kind text NOT NULL CHECK(kind IN ('neurotoxin','baclofen_pump_refill','stretching_program','care_coordination')),
 status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','on_hold','completed','cancelled','entered_in_error')),
 content jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
 created_by uuid NOT NULL,
 updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,visit_id) REFERENCES visits(tenant_id,id)
);
CREATE INDEX specialty_care_patient ON specialty_care_items(tenant_id,patient_id,updated_at DESC,id DESC);
CREATE INDEX specialty_care_worklist ON specialty_care_items(tenant_id,kind,status,updated_at DESC,id DESC);
CREATE TABLE specialty_care_item_revisions (
 tenant_id uuid NOT NULL,
 item_id uuid NOT NULL,
 version bigint NOT NULL,
 status text NOT NULL,
 content jsonb NOT NULL,
 actor_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,item_id,version),
 FOREIGN KEY(tenant_id,item_id) REFERENCES specialty_care_items(tenant_id,id)
);
CREATE TRIGGER specialty_care_revision_immutable BEFORE UPDATE OR DELETE ON specialty_care_item_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER specialty_care_item_no_delete BEFORE DELETE ON specialty_care_items FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
