-- Owner-reviewed fee proposals are additive. No existing account or ledger is changed.
CREATE TABLE practice_fee_schedules (
 tenant_id uuid NOT NULL, id uuid NOT NULL, request_id uuid NOT NULL,
 creation_hash text NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','retired')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), content jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,request_id)
);
CREATE TABLE practice_fee_entries (
 tenant_id uuid NOT NULL, schedule_id uuid NOT NULL, entry_key text NOT NULL,
 code_system text NOT NULL, code text NOT NULL, modifiers text NOT NULL,
 unit_amount_cents bigint NOT NULL CHECK(unit_amount_cents BETWEEN 1 AND 100000000), content jsonb NOT NULL,
 PRIMARY KEY(tenant_id,schedule_id,entry_key),
 FOREIGN KEY(tenant_id,schedule_id) REFERENCES practice_fee_schedules(tenant_id,id)
);
CREATE INDEX practice_fee_entry_lookup ON practice_fee_entries(tenant_id,code_system,code,modifiers);
CREATE TABLE practice_fee_history (
 tenant_id uuid NOT NULL, schedule_id uuid NOT NULL, version bigint NOT NULL,
 actor_id uuid NOT NULL, reason text NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,schedule_id,version), FOREIGN KEY(tenant_id,schedule_id) REFERENCES practice_fee_schedules(tenant_id,id)
);
CREATE FUNCTION preserve_practice_fee_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Fee source entries and history are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER practice_fee_entry_immutable BEFORE UPDATE OR DELETE ON practice_fee_entries FOR EACH ROW EXECUTE FUNCTION preserve_practice_fee_evidence();
CREATE TRIGGER practice_fee_history_immutable BEFORE UPDATE OR DELETE ON practice_fee_history FOR EACH ROW EXECUTE FUNCTION preserve_practice_fee_evidence();
CREATE FUNCTION preserve_practice_fee_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Fee proposals cannot be deleted' USING ERRCODE='23514'; END IF;
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.request_id<>OLD.request_id OR NEW.creation_hash<>OLD.creation_hash OR NEW.content<>OLD.content OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
 OR NOT ((OLD.status='draft' AND NEW.status IN ('approved','retired')) OR (OLD.status='approved' AND NEW.status='retired'))
 THEN RAISE EXCEPTION 'Fee proposals are immutable; create a replacement proposal' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER practice_fee_proposal_immutable BEFORE UPDATE OR DELETE ON practice_fee_schedules FOR EACH ROW EXECUTE FUNCTION preserve_practice_fee_proposal();
