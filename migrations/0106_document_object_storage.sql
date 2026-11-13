-- SPDX-License-Identifier: AGPL-3.0-only
-- Patient file bytes may live in the row (as before) or as an encrypted,
-- write-once object in file storage. Each row records where its bytes are, so
-- a database holding both kinds is always readable. Additive: existing rows
-- keep storage='database' and their bytes.
ALTER TABLE patient_documents
 ADD COLUMN storage text NOT NULL DEFAULT 'database' CHECK (storage IN ('database','s3')),
 ADD COLUMN object_key text,
 ALTER COLUMN bytes DROP NOT NULL;
-- Exactly one location. The object name is fully determined by the row, so a
-- row can never point at another tenant's, document's or version's object.
ALTER TABLE patient_documents ADD CONSTRAINT patient_documents_storage_location CHECK (
 (storage='database' AND bytes IS NOT NULL AND object_key IS NULL) OR
 (storage='s3' AND bytes IS NULL AND object_key IS NOT NULL
  AND object_key='t/'||tenant_id::text||'/d/'||id::text||'/v1-'||sha256));

ALTER TABLE patient_document_file_versions
 ADD COLUMN storage text NOT NULL DEFAULT 'database' CHECK (storage IN ('database','s3')),
 ADD COLUMN object_key text,
 ALTER COLUMN bytes DROP NOT NULL;
ALTER TABLE patient_document_file_versions ADD CONSTRAINT patient_document_file_versions_storage_location CHECK (
 (storage='database' AND bytes IS NOT NULL AND object_key IS NULL) OR
 (storage='s3' AND bytes IS NULL AND object_key IS NOT NULL
  AND object_key='t/'||tenant_id::text||'/d/'||document_id::text||'/v'||version::text||'-'||sha256));

-- The original upload stays immutable. The single permitted change to where
-- its bytes are kept is the one-way move out of the row, and that statement
-- may change nothing else. The content hash and size never change, so the
-- moved file is still verified against the values recorded at upload.
CREATE OR REPLACE FUNCTION preserve_patient_document_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR
 NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR
 NEW.create_request IS DISTINCT FROM OLD.create_request OR NEW.filename IS DISTINCT FROM OLD.filename OR
 NEW.content_type IS DISTINCT FROM OLD.content_type OR
 NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR
 NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
 RAISE EXCEPTION 'document original and upload attribution are immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.storage='database' AND NEW.storage='s3' THEN
  IF NEW.bytes IS NOT NULL OR NEW.object_key IS NULL OR
  NEW.content IS DISTINCT FROM OLD.content OR NEW.version IS DISTINCT FROM OLD.version OR
  NEW.updated_by IS DISTINCT FROM OLD.updated_by OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
  RAISE EXCEPTION 'moving a document file may not change anything else' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.storage IS DISTINCT FROM OLD.storage OR NEW.object_key IS DISTINCT FROM OLD.object_key OR
 NEW.bytes IS DISTINCT FROM OLD.bytes THEN
 RAISE EXCEPTION 'document original and upload attribution are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

-- File versions stay append-only: no delete, and the only update is the same
-- one-way move with every other column unchanged.
CREATE FUNCTION preserve_patient_document_file_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.storage='database' AND NEW.storage='s3' AND NEW.bytes IS NULL AND NEW.object_key IS NOT NULL AND
 NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id AND NEW.document_id IS NOT DISTINCT FROM OLD.document_id AND
 NEW.patient_id IS NOT DISTINCT FROM OLD.patient_id AND NEW.version IS NOT DISTINCT FROM OLD.version AND
 NEW.request_id IS NOT DISTINCT FROM OLD.request_id AND NEW.request_hash IS NOT DISTINCT FROM OLD.request_hash AND
 NEW.filename IS NOT DISTINCT FROM OLD.filename AND NEW.content_type IS NOT DISTINCT FROM OLD.content_type AND
 NEW.sha256 IS NOT DISTINCT FROM OLD.sha256 AND NEW.size_bytes IS NOT DISTINCT FROM OLD.size_bytes AND
 NEW.annotations IS NOT DISTINCT FROM OLD.annotations AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id AND
 NEW.reason IS NOT DISTINCT FROM OLD.reason AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
 RETURN NEW;
 END IF;
 RAISE EXCEPTION 'clinical history is append-only' USING ERRCODE='23514';
END $$;
DROP TRIGGER patient_document_file_versions_immutable ON patient_document_file_versions;
CREATE TRIGGER patient_document_file_versions_immutable BEFORE UPDATE ON patient_document_file_versions
FOR EACH ROW EXECUTE FUNCTION preserve_patient_document_file_version();
CREATE TRIGGER patient_document_file_versions_no_delete BEFORE DELETE ON patient_document_file_versions
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
-- Finds the files still held in rows without scanning moved ones.
CREATE INDEX patient_documents_in_database ON patient_documents(tenant_id,id) WHERE storage='database';
CREATE INDEX patient_document_file_versions_in_database ON patient_document_file_versions(tenant_id,document_id,version) WHERE storage='database';
