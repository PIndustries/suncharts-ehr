-- Durable native Claim.MD eligibility and payer-directory evidence.
CREATE TABLE claimmd_eligibility_checks (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 patient_id uuid NOT NULL,
 coverage_id uuid NOT NULL,
 request_id uuid NOT NULL,
 creation_hash text NOT NULL,
 route_key text NOT NULL,
 request_snapshot jsonb NOT NULL,
 response_snapshot jsonb,
 status text NOT NULL CHECK(status IN ('pending','completed','failed')),
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,coverage_id,patient_id) REFERENCES insurance_coverages(tenant_id,id,patient_id)
);
CREATE INDEX claimmd_eligibility_patient ON claimmd_eligibility_checks(tenant_id,patient_id,coverage_id,created_at DESC);
CREATE TABLE claimmd_eligibility_events (
 tenant_id uuid NOT NULL,
 check_id uuid NOT NULL,
 status text NOT NULL,
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,check_id,status),
 FOREIGN KEY(tenant_id,check_id) REFERENCES claimmd_eligibility_checks(tenant_id,id)
);
CREATE TABLE claimmd_payer_directory_snapshots (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 route_key text NOT NULL,
 query jsonb NOT NULL,
 response jsonb NOT NULL,
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX claimmd_payer_directory_recent ON claimmd_payer_directory_snapshots(tenant_id,created_at DESC);
CREATE TABLE claimmd_api_rate_windows (
 account_hash text NOT NULL,
 window_start timestamptz NOT NULL,
 request_count integer NOT NULL CHECK(request_count BETWEEN 1 AND 100),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_hash,window_start)
);
CREATE TRIGGER claimmd_eligibility_immutable BEFORE DELETE ON claimmd_eligibility_checks FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER claimmd_eligibility_events_immutable BEFORE UPDATE OR DELETE ON claimmd_eligibility_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER claimmd_payer_directory_immutable BEFORE UPDATE OR DELETE ON claimmd_payer_directory_snapshots FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION protect_claimmd_eligibility() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.tenant_id<>NEW.tenant_id OR OLD.id<>NEW.id OR OLD.patient_id<>NEW.patient_id OR OLD.coverage_id<>NEW.coverage_id
 OR OLD.request_id<>NEW.request_id OR OLD.creation_hash<>NEW.creation_hash OR OLD.route_key<>NEW.route_key
 OR OLD.request_snapshot<>NEW.request_snapshot OR OLD.actor_id<>NEW.actor_id OR OLD.created_at<>NEW.created_at
 OR OLD.status<>'pending' OR NEW.status NOT IN ('completed','failed') OR OLD.response_snapshot IS NOT NULL
 OR (NEW.status='completed' AND NEW.response_snapshot IS NULL) OR NEW.completed_at IS NULL THEN
  RAISE EXCEPTION 'Claim.MD eligibility evidence is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_claimmd_eligibility_update BEFORE UPDATE ON claimmd_eligibility_checks FOR EACH ROW EXECUTE FUNCTION protect_claimmd_eligibility();
