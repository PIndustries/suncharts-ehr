-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE browser_users DROP CONSTRAINT browser_users_role_check;
ALTER TABLE browser_users ADD CONSTRAINT browser_users_role_check CHECK (role IN ('owner','clinician','front_desk','read_only','nurse','medical_assistant'));
ALTER TABLE browser_users ADD COLUMN display_name text NOT NULL DEFAULT '' CHECK (length(display_name)<=200);
ALTER TABLE browser_users ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version>0);
CREATE TABLE practice_providers (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
 npi text NOT NULL DEFAULT '' CHECK (npi='' OR npi ~ '^[0-9]{10}$'),
 specialty text NOT NULL DEFAULT '' CHECK (length(specialty)<=200),
 active boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1 CHECK (version>0),
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,id) REFERENCES browser_users(tenant_id,id)
);
CREATE TABLE practice_facilities (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
 address text NOT NULL DEFAULT '' CHECK (length(address)<=1000),
 phone text NOT NULL DEFAULT '' CHECK (length(phone)<=40),
 active boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1 CHECK (version>0),
 PRIMARY KEY (tenant_id,id)
);
CREATE UNIQUE INDEX practice_facilities_name ON practice_facilities(tenant_id,lower(name));
CREATE TABLE practice_rooms (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 facility_id uuid NOT NULL,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
 active boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1 CHECK (version>0),
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,facility_id) REFERENCES practice_facilities(tenant_id,id)
);
CREATE UNIQUE INDEX practice_rooms_name ON practice_rooms(tenant_id,facility_id,lower(name));
CREATE TABLE practice_admin_history (
 tenant_id uuid NOT NULL,
 id uuid PRIMARY KEY,
 resource_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('staff','provider','facility','room')),
 version bigint NOT NULL,
 actor_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 content jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,kind,resource_id,version)
);
CREATE INDEX practice_admin_history_resource ON practice_admin_history(tenant_id,kind,resource_id,version DESC);
