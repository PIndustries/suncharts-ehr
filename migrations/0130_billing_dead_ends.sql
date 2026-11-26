-- Staff decisions and confirmed portal deliveries are append-only evidence.
CREATE TABLE billing_denial_resolutions (
 tenant_id uuid NOT NULL, claim_id uuid NOT NULL, request_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('patient_balance','write_off')),
 reason text NOT NULL, actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,claim_id), UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,claim_id) REFERENCES ehr_claims(tenant_id,id)
);
CREATE TRIGGER billing_denial_resolutions_immutable BEFORE UPDATE OR DELETE ON billing_denial_resolutions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE billing_statement_deliveries (
 tenant_id uuid NOT NULL, id uuid NOT NULL, invoice_id uuid NOT NULL,
 request_id uuid NOT NULL, channel text NOT NULL CHECK(channel='portal'),
 actor_id uuid NOT NULL, thread_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,invoice_id) REFERENCES patient_invoice_snapshots(tenant_id,id),
 FOREIGN KEY(tenant_id,thread_id) REFERENCES patient_portal_threads(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES browser_users(tenant_id,id)
);
CREATE TRIGGER billing_statement_deliveries_immutable BEFORE UPDATE OR DELETE ON billing_statement_deliveries FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
