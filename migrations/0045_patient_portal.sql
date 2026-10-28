-- Independent patient identity and explicit, pinned publication boundary.
CREATE TABLE patient_portal_accounts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,email text NOT NULL,
 password_hash text,status text NOT NULL CHECK(status IN ('invited','active','revoked')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,patient_id),UNIQUE(tenant_id,email),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 CHECK(email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
 CHECK(status<>'active' OR password_hash IS NOT NULL)
);
CREATE TABLE patient_portal_invites (
 token_hash text PRIMARY KEY,tenant_id uuid NOT NULL,account_id uuid NOT NULL,account_version bigint NOT NULL,
 expires_at timestamptz NOT NULL,used_at timestamptz,revoked_at timestamptz,
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,account_id) REFERENCES patient_portal_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES browser_users(tenant_id,id)
);
CREATE TABLE patient_portal_sessions (
 token_hash text PRIMARY KEY,tenant_id uuid NOT NULL,account_id uuid NOT NULL,account_version bigint NOT NULL,
 expires_at timestamptz NOT NULL,last_seen_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,account_id) REFERENCES patient_portal_accounts(tenant_id,id)
);
CREATE INDEX patient_portal_session_expiry ON patient_portal_sessions(expires_at);
CREATE TABLE patient_portal_rate_limits (key text PRIMARY KEY,window_started timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 1);
CREATE TABLE patient_portal_publications (
 tenant_id uuid NOT NULL,patient_id uuid NOT NULL,visit_id uuid NOT NULL,avs_version bigint NOT NULL,
 version bigint NOT NULL CHECK(version>0),visible boolean NOT NULL,released_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,visit_id),FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,visit_id,avs_version) REFERENCES avs_releases(tenant_id,visit_id,version),
 FOREIGN KEY(tenant_id,released_by) REFERENCES browser_users(tenant_id,id)
);
CREATE FUNCTION patient_portal_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM visits WHERE tenant_id=NEW.tenant_id AND id=NEW.visit_id AND patient_id=NEW.patient_id AND status='signed' AND clinician_id=NEW.released_by) THEN RAISE EXCEPTION 'only assigned clinician can publish signed visit instructions'; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.patient_id<>OLD.patient_id OR NEW.visit_id<>OLD.visit_id OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'invalid portal publication version or identity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER patient_portal_publication_guard BEFORE INSERT OR UPDATE ON patient_portal_publications FOR EACH ROW EXECUTE FUNCTION patient_portal_publication_guard();
CREATE TRIGGER patient_portal_publication_no_delete BEFORE DELETE ON patient_portal_publications FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE patient_portal_threads (
 tenant_id uuid NOT NULL,id uuid NOT NULL,patient_id uuid NOT NULL,account_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('message','appointment_change')),appointment_id uuid,
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 160 AND subject=btrim(subject)),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 request_id uuid NOT NULL,request_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,account_id,request_id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES patient_portal_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id),
 FOREIGN KEY(tenant_id,appointment_id,patient_id) REFERENCES appointments(tenant_id,id,patient_id),
 CHECK((kind='appointment_change')=(appointment_id IS NOT NULL))
);
CREATE INDEX patient_portal_inbox ON patient_portal_threads(tenant_id,status,updated_at DESC);
CREATE TABLE patient_portal_messages (
 tenant_id uuid NOT NULL,id uuid NOT NULL,thread_id uuid NOT NULL,thread_version bigint NOT NULL,
 author_kind text NOT NULL CHECK(author_kind IN ('patient','staff')),author_id uuid NOT NULL,
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000 AND body=btrim(body)),request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,thread_id,request_id),UNIQUE(tenant_id,thread_id,thread_version),
 FOREIGN KEY(tenant_id,thread_id) REFERENCES patient_portal_threads(tenant_id,id)
);
CREATE TRIGGER patient_portal_messages_immutable BEFORE UPDATE OR DELETE ON patient_portal_messages FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE patient_portal_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id uuid NOT NULL,patient_id uuid NOT NULL,
 actor_id uuid NOT NULL,actor_kind text NOT NULL CHECK(actor_kind IN ('staff','patient')),action text NOT NULL,
 resource_id uuid NOT NULL,version bigint,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,patient_id) REFERENCES patients(tenant_id,id)
);
CREATE TRIGGER patient_portal_events_immutable BEFORE UPDATE OR DELETE ON patient_portal_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
ALTER TABLE patient_portal_accounts ADD CONSTRAINT patient_portal_account_identity UNIQUE(tenant_id,id,patient_id);
ALTER TABLE patient_portal_threads ADD CONSTRAINT patient_portal_thread_identity FOREIGN KEY(tenant_id,account_id,patient_id) REFERENCES patient_portal_accounts(tenant_id,id,patient_id);
CREATE FUNCTION patient_portal_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.patient_id<>OLD.patient_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid portal account identity or version'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER patient_portal_account_guard BEFORE UPDATE ON patient_portal_accounts FOR EACH ROW EXECUTE FUNCTION patient_portal_account_guard();
CREATE TRIGGER patient_portal_account_no_delete BEFORE DELETE ON patient_portal_accounts FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION patient_portal_thread_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.patient_id<>OLD.patient_id OR NEW.account_id<>OLD.account_id OR NEW.kind<>OLD.kind OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id OR NEW.subject<>OLD.subject OR NEW.request_id<>OLD.request_id OR NEW.request_hash<>OLD.request_hash OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid portal thread identity or version'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER patient_portal_thread_guard BEFORE UPDATE ON patient_portal_threads FOR EACH ROW EXECUTE FUNCTION patient_portal_thread_guard();
CREATE TRIGGER patient_portal_thread_no_delete BEFORE DELETE ON patient_portal_threads FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE INDEX patient_portal_rate_window ON patient_portal_rate_limits(window_started);
