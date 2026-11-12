-- Finite, patient-present collection against a reviewed immutable native invoice.
-- Schedules authorize neither off-session collection nor new patient responsibility.
CREATE TABLE patient_installment_plans (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,account_id uuid NOT NULL,invoice_id uuid NOT NULL,
 request_id uuid NOT NULL,creation_hash text NOT NULL,requested_by uuid NOT NULL,reason text NOT NULL,
 livemode boolean NOT NULL,total_cents bigint NOT NULL CHECK(total_cents BETWEEN 50 AND 100000000),
 responsibility_cents bigint NOT NULL CHECK(responsibility_cents>=total_cents),
 baseline_version bigint NOT NULL,account_snapshot jsonb NOT NULL,ledger_ids jsonb NOT NULL,
 schedule jsonb NOT NULL CHECK(jsonb_typeof(schedule)='array' AND jsonb_array_length(schedule) BETWEEN 1 AND 60),
 version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,invoice_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES billing_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,invoice_id) REFERENCES patient_invoice_snapshots(tenant_id,id)
);
CREATE FUNCTION protect_installment_plan() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-'version') IS DISTINCT FROM (to_jsonb(OLD)-'version') OR NEW.version<OLD.version
 THEN RAISE EXCEPTION 'installment contract is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER installment_plan_protected BEFORE UPDATE ON patient_installment_plans FOR EACH ROW EXECUTE FUNCTION protect_installment_plan();
CREATE TRIGGER installment_plan_no_delete BEFORE DELETE ON patient_installment_plans FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE invoice_checkout_attempts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,account_id uuid NOT NULL,plan_id uuid NOT NULL,
 installment_number integer NOT NULL CHECK(installment_number BETWEEN 1 AND 60),
 setting_id uuid NOT NULL,credential_revision bigint NOT NULL,installation_id uuid NOT NULL,
 provider_account_id text NOT NULL,livemode boolean NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 50 AND 100000000),
 currency text NOT NULL DEFAULT 'usd' CHECK(currency='usd'),request_id uuid NOT NULL,creation_hash text NOT NULL,
 requested_by uuid NOT NULL,reason text NOT NULL,return_url text NOT NULL,
 status text NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','open','paid','expired','needs_review','refunded')),
 provider_session_id text,provider_payment_intent text,provider_charge_id text,provider_captured_at timestamptz,
 checkout_url text,paid_entry_id uuid,refunded_cents bigint NOT NULL DEFAULT 0 CHECK(refunded_cents BETWEEN 0 AND amount_cents),
 version bigint NOT NULL DEFAULT 1,attempts integer NOT NULL DEFAULT 0,
 next_poll_at timestamptz NOT NULL DEFAULT now(),lease_id uuid,lease_until timestamptz,last_result text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,paid_entry_id),
 UNIQUE(provider_account_id,livemode,provider_session_id),UNIQUE(provider_account_id,livemode,provider_payment_intent),
 UNIQUE(provider_account_id,livemode,provider_charge_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES billing_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,plan_id) REFERENCES patient_installment_plans(tenant_id,id),
 FOREIGN KEY(tenant_id,setting_id,credential_revision) REFERENCES payment_credentials(tenant_id,setting_id,revision),
 FOREIGN KEY(tenant_id,paid_entry_id,account_id) REFERENCES billing_entries(tenant_id,id,account_id)
);
CREATE UNIQUE INDEX invoice_checkout_one_unresolved_account ON invoice_checkout_attempts(tenant_id,account_id)
 WHERE status IN ('creating','open','needs_review');
CREATE INDEX invoice_checkout_poll ON invoice_checkout_attempts(next_poll_at,lease_until) WHERE status NOT IN ('expired','refunded');
CREATE FUNCTION protect_invoice_checkout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','provider_session_id','provider_payment_intent','provider_charge_id','provider_captured_at','checkout_url','paid_entry_id','refunded_cents','version','attempts','next_poll_at','lease_id','lease_until','last_result','updated_at'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','provider_session_id','provider_payment_intent','provider_charge_id','provider_captured_at','checkout_url','paid_entry_id','refunded_cents','version','attempts','next_poll_at','lease_id','lease_until','last_result','updated_at'])
 OR (OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id)
 OR (OLD.provider_payment_intent IS NOT NULL AND NEW.provider_payment_intent IS DISTINCT FROM OLD.provider_payment_intent)
 OR (OLD.provider_charge_id IS NOT NULL AND NEW.provider_charge_id IS DISTINCT FROM OLD.provider_charge_id)
 OR (OLD.provider_captured_at IS NOT NULL AND NEW.provider_captured_at IS DISTINCT FROM OLD.provider_captured_at)
 OR (OLD.paid_entry_id IS NOT NULL AND NEW.paid_entry_id IS DISTINCT FROM OLD.paid_entry_id)
 OR NEW.refunded_cents<OLD.refunded_cents OR NEW.version<OLD.version
 THEN RAISE EXCEPTION 'invoice checkout binding and captured evidence are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER invoice_checkout_protected BEFORE UPDATE ON invoice_checkout_attempts FOR EACH ROW EXECUTE FUNCTION protect_invoice_checkout();
CREATE TRIGGER invoice_checkout_no_delete BEFORE DELETE ON invoice_checkout_attempts FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE invoice_checkout_refunds (
 tenant_id uuid NOT NULL,operation_id uuid NOT NULL,cumulative_cents bigint NOT NULL,
 delta_cents bigint NOT NULL CHECK(delta_cents>0),entry_id uuid,actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,operation_id,cumulative_cents),UNIQUE(tenant_id,entry_id),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES invoice_checkout_attempts(tenant_id,id),
 FOREIGN KEY(tenant_id,entry_id) REFERENCES billing_entries(tenant_id,id)
);
CREATE TRIGGER invoice_checkout_refunds_immutable BEFORE UPDATE OR DELETE ON invoice_checkout_refunds FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE patient_installment_events (
 tenant_id uuid NOT NULL,id uuid NOT NULL,plan_id uuid NOT NULL,operation_id uuid,actor_id uuid NOT NULL,
 action text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,plan_id) REFERENCES patient_installment_plans(tenant_id,id),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES invoice_checkout_attempts(tenant_id,id)
);
CREATE TRIGGER patient_installment_events_immutable BEFORE UPDATE OR DELETE ON patient_installment_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
