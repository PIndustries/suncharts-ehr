-- SPDX-License-Identifier: AGPL-3.0-only
-- Preserve original uploads and metadata histories. File version 1 remains the
-- original row; subsequent working copies and annotations are append-only.
ALTER TABLE patient_documents DROP CONSTRAINT patient_documents_content_type_check;
ALTER TABLE patient_documents ADD CONSTRAINT patient_documents_content_type_check
 CHECK(content_type IN ('application/pdf','image/png','image/jpeg','text/plain',
 'audio/mpeg','audio/wav','audio/ogg','audio/webm','audio/mp4',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
CREATE TABLE patient_document_file_versions (
 tenant_id uuid NOT NULL, document_id uuid NOT NULL, patient_id uuid NOT NULL,
 version bigint NOT NULL CHECK(version>1), request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(length(request_hash)=64),
 filename text NOT NULL, content_type text NOT NULL,
 bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 10485760),
 sha256 text NOT NULL CHECK(length(sha256)=64),
 size_bytes bigint NOT NULL CHECK(size_bytes=octet_length(bytes)),
 annotations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(annotations)='array'),
 actor_id uuid NOT NULL, reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,document_id,version), UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,document_id,patient_id) REFERENCES patient_documents(tenant_id,id,patient_id)
);
CREATE TRIGGER patient_document_file_versions_immutable BEFORE UPDATE OR DELETE ON patient_document_file_versions
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
