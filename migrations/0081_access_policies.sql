-- SPDX-License-Identifier: AGPL-3.0-only
-- Custom policies restrict an existing native staff role; they never replace it.
CREATE TABLE practice_access_policies (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 base_role text NOT NULL CHECK(base_role IN ('clinician','nurse','medical_assistant','front_desk','read_only')),
 permissions jsonb NOT NULL CHECK(jsonb_typeof(permissions)='object'),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE UNIQUE INDEX practice_access_policy_name ON practice_access_policies(tenant_id,lower(name));
CREATE TABLE practice_access_assignments (
 tenant_id uuid NOT NULL,
 user_id uuid NOT NULL,
 policy_id uuid,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES browser_users(tenant_id,id),
 FOREIGN KEY(tenant_id,policy_id) REFERENCES practice_access_policies(tenant_id,id)
);
CREATE TABLE practice_access_revisions (
 tenant_id uuid NOT NULL,
 id uuid PRIMARY KEY,
 resource_id uuid NOT NULL,
 resource_kind text NOT NULL CHECK(resource_kind IN ('policy','assignment')),
 version bigint NOT NULL CHECK(version>0),
 actor_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 content jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,resource_kind,resource_id,version)
);
CREATE TRIGGER practice_access_revision_immutable BEFORE UPDATE OR DELETE ON practice_access_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
