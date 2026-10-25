ALTER TABLE historical_records ADD CONSTRAINT historical_tenant_identity UNIQUE(tenant_id,id);
CREATE TABLE clinical_entries (
 tenant_id uuid NOT NULL, id uuid NOT NULL, patient_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('problem','allergy','medication')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), content jsonb NOT NULL,
 source_history_id uuid, created_by uuid NOT NULL, updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,source_history_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,source_history_id) REFERENCES historical_records(tenant_id,id)
);
CREATE INDEX clinical_patient ON clinical_entries(tenant_id,patient_id,kind,id);
CREATE TABLE clinical_revisions (
 tenant_id uuid NOT NULL, entry_id uuid NOT NULL, version bigint NOT NULL,
 content jsonb NOT NULL, author_id uuid NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,entry_id,version),
 FOREIGN KEY(tenant_id,entry_id) REFERENCES clinical_entries(tenant_id,id)
);
CREATE TRIGGER clinical_revision_immutable BEFORE UPDATE OR DELETE ON clinical_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE clinical_list_state (
 tenant_id uuid NOT NULL, patient_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('problem','allergy','medication')),
 version bigint NOT NULL DEFAULT 1, review_state text NOT NULL DEFAULT 'unknown' CHECK(review_state IN ('unknown','needs_review','reviewed','no_known')),
 reviewed_by uuid, reviewed_at timestamptz, PRIMARY KEY(tenant_id,patient_id,kind),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id)
);
CREATE TABLE clinical_reviews (
 tenant_id uuid NOT NULL, patient_id uuid NOT NULL, kind text NOT NULL, version bigint NOT NULL,
 review_state text NOT NULL, author_id uuid NOT NULL, note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,patient_id,kind,version),
 FOREIGN KEY(tenant_id,patient_id,kind) REFERENCES clinical_list_state(tenant_id,patient_id,kind)
);
CREATE TRIGGER clinical_review_immutable BEFORE UPDATE OR DELETE ON clinical_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
