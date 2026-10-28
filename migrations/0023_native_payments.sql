-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE payment_settings (
 tenant_id uuid PRIMARY KEY,id uuid NOT NULL UNIQUE,mode text NOT NULL CHECK(mode IN ('own_stripe','suncharts_connect')),
 credential_revision bigint NOT NULL DEFAULT 1,enabled boolean NOT NULL DEFAULT false,verified boolean NOT NULL DEFAULT false,
 provider_account_id text,last_test_at timestamptz,last_test_result text,version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE TABLE payment_credentials (
 tenant_id uuid NOT NULL,setting_id uuid NOT NULL,revision bigint NOT NULL,encrypted_config bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,setting_id,revision),
 FOREIGN KEY(tenant_id,setting_id) REFERENCES payment_settings(tenant_id,id)
);
CREATE TRIGGER payment_credentials_immutable BEFORE UPDATE OR DELETE ON payment_credentials FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE payment_setting_events (
 tenant_id uuid NOT NULL,setting_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,action text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,setting_id,version),
 FOREIGN KEY(tenant_id,setting_id) REFERENCES payment_settings(tenant_id,id)
);
CREATE TRIGGER payment_setting_events_immutable BEFORE UPDATE OR DELETE ON payment_setting_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE payment_attempts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,account_id uuid NOT NULL,setting_id uuid NOT NULL,credential_revision bigint NOT NULL,
 request_id uuid NOT NULL,creation_hash text NOT NULL,requested_by uuid NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 50 AND 100000000),currency text NOT NULL DEFAULT 'usd' CHECK(currency='usd'),
 status text NOT NULL CHECK(status IN ('creating','open','paid','expired','needs_review','refunded')),
 provider_mode text NOT NULL CHECK(provider_mode IN ('own_stripe','suncharts_connect')),provider_session_id text,provider_payment_intent text,provider_charge_id text,provider_account_id text NOT NULL,
 checkout_url text,paid_entry_id uuid,refunded_cents bigint NOT NULL DEFAULT 0 CHECK(refunded_cents>=0 AND refunded_cents<=amount_cents),
 version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),UNIQUE(setting_id,provider_session_id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES billing_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,setting_id,credential_revision) REFERENCES payment_credentials(tenant_id,setting_id,revision),
 FOREIGN KEY(tenant_id,paid_entry_id) REFERENCES billing_entries(tenant_id,id)
);
CREATE INDEX payment_attempts_account ON payment_attempts(tenant_id,account_id,created_at);
CREATE TABLE payment_events (
 tenant_id uuid NOT NULL,payment_id uuid NOT NULL,version bigint NOT NULL,actor_id uuid NOT NULL,action text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,payment_id,version),
 FOREIGN KEY(tenant_id,payment_id) REFERENCES payment_attempts(tenant_id,id)
);
CREATE TRIGGER payment_events_immutable BEFORE UPDATE OR DELETE ON payment_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE payment_ledger_links (
 tenant_id uuid NOT NULL,payment_id uuid NOT NULL,entry_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('payment','refund')),
 confirmed_cents bigint NOT NULL,PRIMARY KEY(tenant_id,entry_id),UNIQUE(tenant_id,payment_id,kind,confirmed_cents),
 FOREIGN KEY(tenant_id,payment_id) REFERENCES payment_attempts(tenant_id,id),FOREIGN KEY(tenant_id,entry_id) REFERENCES billing_entries(tenant_id,id)
);
CREATE TRIGGER payment_ledger_links_immutable BEFORE UPDATE OR DELETE ON payment_ledger_links FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE payment_webhook_receipts (
 setting_id uuid NOT NULL,event_id text NOT NULL,payload_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(setting_id,event_id),FOREIGN KEY(setting_id) REFERENCES payment_settings(id)
);
CREATE TRIGGER payment_webhook_receipts_immutable BEFORE UPDATE OR DELETE ON payment_webhook_receipts FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE payment_refund_requests (
 tenant_id uuid NOT NULL,id uuid NOT NULL,payment_id uuid NOT NULL,request_id uuid NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents>0),
 provider_refund_id text,status text NOT NULL DEFAULT 'pending',created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),FOREIGN KEY(tenant_id,payment_id) REFERENCES payment_attempts(tenant_id,id)
);
