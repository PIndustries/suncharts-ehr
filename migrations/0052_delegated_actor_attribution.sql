-- Retain the authenticated Connect actor on every delegated support session. The actor remains a
-- grant-scoped UUID for authorization; this subject is attribution metadata, not a local EHR user.
ALTER TABLE partner_support_sessions
    ADD COLUMN actor_subject TEXT NOT NULL DEFAULT 'legacy:unattributed'
        CHECK (length(actor_subject) BETWEEN 1 AND 500);
