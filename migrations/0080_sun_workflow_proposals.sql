-- Workflow proposals remain reviewed AI drafts. No workflow definitions, live
-- instances, provider capabilities or approval policies are changed here.
ALTER TABLE claude_drafts DROP CONSTRAINT claude_drafts_purpose_check;
ALTER TABLE claude_drafts ADD CONSTRAINT claude_drafts_purpose_check
 CHECK (purpose IN ('document_classification','structured_extraction','draft_summary','draft_response','workflow_design'));
