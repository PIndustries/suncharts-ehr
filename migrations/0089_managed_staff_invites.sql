CREATE TABLE managed_staff_invites (
 tenant_id uuid NOT NULL,
 user_id uuid NOT NULL,
 request_id uuid NOT NULL,
 invite_id uuid,
 state text NOT NULL CHECK (state IN ('pending','accepted','revoked','expired','inactive','unavailable')),
 delivery jsonb NOT NULL DEFAULT '{}'::jsonb,
 accepted_at timestamptz,
 expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,user_id),
 UNIQUE (tenant_id,request_id),
 FOREIGN KEY (tenant_id,user_id) REFERENCES browser_users(tenant_id,id) ON DELETE CASCADE
);
