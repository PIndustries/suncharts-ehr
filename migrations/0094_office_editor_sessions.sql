-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE office_editor_sessions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL,patient_id uuid NOT NULL,document_id uuid NOT NULL,
 actor_id uuid NOT NULL,auth_session_hash text NOT NULL,request_id uuid NOT NULL,
 base_version bigint NOT NULL CHECK(base_version>=1),current_version bigint NOT NULL,
 mode text NOT NULL CHECK(mode IN ('view','edit')),config_hash text NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','saving','saved','needs_review','closed')),
 save_request_id uuid,last_error text,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,request_id),FOREIGN KEY(tenant_id,document_id) REFERENCES patient_documents(tenant_id,id)
);
CREATE TABLE office_editor_saves (
 id uuid PRIMARY KEY,session_id uuid NOT NULL REFERENCES office_editor_sessions(id),
 expected_version bigint NOT NULL,command_attempts integer NOT NULL DEFAULT 1 CHECK(command_attempts BETWEEN 1 AND 10),status text NOT NULL CHECK(status IN ('pending','complete','failed')),
 callback_hash text,saved_version bigint,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX office_one_pending_save ON office_editor_saves(session_id) WHERE status='pending';
CREATE FUNCTION protect_office_editor_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','last_error','current_version','save_request_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','last_error','current_version','save_request_id']) OR NEW.current_version<OLD.current_version THEN RAISE EXCEPTION 'office session binding is immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER office_session_binding BEFORE UPDATE ON office_editor_sessions FOR EACH ROW EXECUTE FUNCTION protect_office_editor_session();
CREATE FUNCTION protect_office_editor_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id<>OLD.id OR NEW.session_id<>OLD.session_id OR NEW.expected_version<>OLD.expected_version OR NEW.created_at<>OLD.created_at OR (OLD.status='complete' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'office save evidence is immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER office_save_binding BEFORE UPDATE ON office_editor_saves FOR EACH ROW EXECUTE FUNCTION protect_office_editor_save();
CREATE TRIGGER office_sessions_no_delete BEFORE DELETE ON office_editor_sessions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER office_saves_no_delete BEFORE DELETE ON office_editor_saves FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
