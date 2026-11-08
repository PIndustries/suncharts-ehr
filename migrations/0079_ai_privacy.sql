-- Identifier mappings remain encrypted in this installation. Approval consumes
-- an immutable preview once; neither table is an outbound provider payload.
CREATE TABLE ai_privacy_previews (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 created_by uuid NOT NULL,
 binding_digest text NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
 encrypted_payload bytea NOT NULL CHECK (octet_length(encrypted_payload) BETWEEN 30 AND 524288),
 metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata)='object'),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 CHECK(expires_at>created_at)
);
CREATE TABLE ai_privacy_approvals (
 tenant_id uuid NOT NULL,
 preview_id uuid NOT NULL,
 draft_id uuid NOT NULL,
 approved_by uuid NOT NULL,
 approved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,preview_id),
 UNIQUE(tenant_id,draft_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES ai_privacy_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,draft_id) REFERENCES claude_drafts(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER ai_privacy_preview_immutable BEFORE UPDATE OR DELETE ON ai_privacy_previews
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER ai_privacy_approval_immutable BEFORE UPDATE OR DELETE ON ai_privacy_approvals
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
ALTER TABLE claude_drafts ADD COLUMN privacy_preview_id uuid;
ALTER TABLE claude_drafts ADD COLUMN privacy jsonb NOT NULL DEFAULT '{"status":"legacy_unreviewed"}'::jsonb CHECK(jsonb_typeof(privacy)='object');
ALTER TABLE claude_drafts ADD CONSTRAINT claude_draft_privacy_preview_fk FOREIGN KEY(tenant_id,privacy_preview_id) REFERENCES ai_privacy_previews(tenant_id,id);
CREATE FUNCTION preserve_ai_privacy_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.privacy_preview_id IS DISTINCT FROM OLD.privacy_preview_id
    OR NEW.privacy IS DISTINCT FROM OLD.privacy
 THEN RAISE EXCEPTION 'AI privacy approval is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_draft_privacy_immutable BEFORE UPDATE ON claude_drafts
 FOR EACH ROW EXECUTE FUNCTION preserve_ai_privacy_binding();
