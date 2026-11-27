-- SPDX-License-Identifier: AGPL-3.0-only
-- Applying insurance to posted self-pay charges preserves both the charge lines and
-- the earlier financial records. The recorded version retires earlier statements as
-- measures of current patient responsibility without changing their history.
CREATE TABLE billing_account_coverage_applications (
    tenant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    coverage_id uuid NOT NULL,
    account_version bigint NOT NULL CHECK(account_version > 1),
    request_id uuid NOT NULL,
    creation_hash text NOT NULL,
    actor_id uuid NOT NULL,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(tenant_id,account_id),
    UNIQUE(tenant_id,request_id),
    FOREIGN KEY(tenant_id,account_id,patient_id) REFERENCES billing_accounts(tenant_id,id,patient_id),
    FOREIGN KEY(tenant_id,coverage_id,patient_id) REFERENCES insurance_coverages(tenant_id,id,patient_id),
    FOREIGN KEY(tenant_id,account_id,account_version) REFERENCES billing_account_revisions(tenant_id,account_id,version)
);
CREATE TRIGGER billing_coverage_applications_immutable
BEFORE UPDATE OR DELETE ON billing_account_coverage_applications
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE OR REPLACE FUNCTION protect_posted_billing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'posted' AND NEW.status = 'posted'
       AND current_setting('suncharts.billing_coverage_application', true) = 'on'
       AND OLD.coverage_id IS NULL AND OLD.coverage_snapshot IS NULL
       AND (OLD.content->>'coverage_id') IS NULL
       AND NEW.coverage_id IS NOT NULL
       AND NEW.coverage_snapshot#>>'{coverage,id}' = NEW.coverage_id::text
       AND NEW.content->>'coverage_id' = NEW.coverage_id::text
       AND NEW.version = OLD.version + 1
       AND (NEW.content-'coverage_id') IS NOT DISTINCT FROM (OLD.content-'coverage_id')
       AND (to_jsonb(NEW)-ARRAY['coverage_id','coverage_snapshot','content','version'])
           IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['coverage_id','coverage_snapshot','content','version']) THEN
        RETURN NEW;
    END IF;
    IF OLD.status = 'posted' AND NEW.status = 'posted' AND billing_correction_allowed()
       AND NEW.patient_id = OLD.patient_id AND NEW.visit_id IS NOT DISTINCT FROM OLD.visit_id
       AND NEW.coverage_id IS NOT DISTINCT FROM OLD.coverage_id
       AND NEW.coverage_snapshot IS NOT DISTINCT FROM OLD.coverage_snapshot
       AND NEW.source_history_id IS NOT DISTINCT FROM OLD.source_history_id
       AND NEW.tenant_id = OLD.tenant_id AND NEW.id = OLD.id THEN
        RETURN NEW;
    END IF;
    IF OLD.status IN ('posted','void') AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.total_cents<>OLD.total_cents
       OR NEW.coverage_snapshot IS DISTINCT FROM OLD.coverage_snapshot OR NEW.patient_id<>OLD.patient_id
       OR NEW.visit_id IS DISTINCT FROM OLD.visit_id OR NEW.coverage_id IS DISTINCT FROM OLD.coverage_id
       OR NEW.source_history_id IS DISTINCT FROM OLD.source_history_id OR NEW.status<>OLD.status
       OR NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id) THEN
        RAISE EXCEPTION 'posted or void billing content is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
