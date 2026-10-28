-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE patient_documents (
 tenant_id uuid NOT NULL, id uuid NOT NULL, patient_id uuid NOT NULL,
 request_id uuid NOT NULL, create_request jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), content jsonb NOT NULL,
 filename text NOT NULL, content_type text NOT NULL CHECK(content_type IN ('application/pdf','image/png','image/jpeg')),
 bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 10485760),
 sha256 text NOT NULL CHECK(length(sha256)=64), size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760),
 uploaded_by uuid NOT NULL, updated_by uuid NOT NULL,
 uploaded_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,patient_id), UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 CHECK(content->>'status' IN ('active','archived','entered_in_error')),
 CHECK(size_bytes=octet_length(bytes))
);
CREATE INDEX patient_documents_patient ON patient_documents(tenant_id,patient_id,id);
CREATE TABLE patient_document_revisions (
 tenant_id uuid NOT NULL, document_id uuid NOT NULL, version bigint NOT NULL,
 content jsonb NOT NULL, actor_id uuid NOT NULL, reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,document_id,version),
 FOREIGN KEY(tenant_id,document_id) REFERENCES patient_documents(tenant_id,id)
);
CREATE TRIGGER patient_document_revisions_immutable BEFORE UPDATE OR DELETE ON patient_document_revisions
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER patient_documents_no_delete BEFORE DELETE ON patient_documents
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION preserve_patient_document_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
 NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR
 NEW.create_request IS DISTINCT FROM OLD.create_request OR NEW.filename IS DISTINCT FROM OLD.filename OR
 NEW.content_type IS DISTINCT FROM OLD.content_type OR NEW.bytes IS DISTINCT FROM OLD.bytes OR
 NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR
 NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
 RAISE EXCEPTION 'document original and upload attribution are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER patient_documents_original_immutable BEFORE UPDATE ON patient_documents
FOR EACH ROW EXECUTE FUNCTION preserve_patient_document_original();
