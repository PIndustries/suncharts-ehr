-- Owner-reviewed billing tax identities. No practice identity is inferred or
-- backfilled from patient claims, test values or imported records.
CREATE TABLE practice_billing_organizations (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
 tax_id_type text NOT NULL CHECK (tax_id_type IN ('E','S')),
 encrypted_tax_id bytea NOT NULL,
 tax_id_last4 text NOT NULL CHECK (tax_id_last4 ~ '^[0-9]{4}$'),
 active boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE practice_billing_organization_history (
 tenant_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 version bigint NOT NULL,
 actor_id uuid NOT NULL,
 reason text NOT NULL,
 content jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,organization_id,version),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES practice_billing_organizations(tenant_id,id)
);
CREATE FUNCTION preserve_billing_organization_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Billing organization history is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER billing_organization_history_immutable BEFORE UPDATE OR DELETE ON practice_billing_organization_history
 FOR EACH ROW EXECUTE FUNCTION preserve_billing_organization_history();
