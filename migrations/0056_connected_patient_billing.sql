-- Electronic patient invoicing and payment methods are available only through SunCharts Connect.
UPDATE payment_settings
 SET enabled=false, verified=false, last_test_result='connect_required', version=version+1, updated_at=now()
 WHERE mode='own_stripe';

CREATE TABLE connected_payment_customers (
 tenant_id uuid NOT NULL,
 patient_id uuid NOT NULL,
 setting_id uuid NOT NULL,
 provider_customer_id text NOT NULL CHECK(provider_customer_id~'^cus_[A-Za-z0-9]+$'),
 version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,patient_id),
 UNIQUE(tenant_id,provider_customer_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,setting_id) REFERENCES payment_settings(tenant_id,id)
);

CREATE TABLE connected_payment_invoices (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 patient_id uuid NOT NULL,
 account_id uuid NOT NULL,
 setting_id uuid NOT NULL,
 request_id uuid NOT NULL,
 provider_invoice_id text CHECK(provider_invoice_id IS NULL OR provider_invoice_id~'^in_[A-Za-z0-9]+$'),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 status text NOT NULL DEFAULT 'creating',
 hosted_invoice_url text,
 invoice_pdf text,
 version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,request_id),
 UNIQUE(setting_id,provider_invoice_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES billing_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,setting_id) REFERENCES payment_settings(tenant_id,id)
);

CREATE TABLE connected_payment_events (
 tenant_id uuid NOT NULL,
 invoice_id uuid NOT NULL,
 version bigint NOT NULL,
 actor_id uuid NOT NULL,
 action text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,invoice_id,version),
 FOREIGN KEY(tenant_id,invoice_id) REFERENCES connected_payment_invoices(tenant_id,id)
);
CREATE TRIGGER connected_payment_events_immutable BEFORE UPDATE OR DELETE ON connected_payment_events
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
