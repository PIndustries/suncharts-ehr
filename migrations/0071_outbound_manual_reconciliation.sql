-- Preserve ambiguous provider outcomes for explicit, evidence-backed reconciliation.
ALTER TABLE gmail_outbound_drafts
 DROP CONSTRAINT gmail_outbound_drafts_status_check,
 ADD CONSTRAINT gmail_outbound_drafts_status_check
 CHECK (status IN ('draft','approved','sending','sent','failed','needs_review','cancelled'));

ALTER TABLE ringcentral_outbound_events
 DROP CONSTRAINT ringcentral_outbound_events_action_check,
 ADD CONSTRAINT ringcentral_outbound_events_action_check
 CHECK (action IN ('drafted','approved','send_started','provider_accepted','provider_rejected','provider_unknown','cancelled','status_refreshed','manually_reconciled'));
