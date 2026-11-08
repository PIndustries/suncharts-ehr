-- Native reference catalogs are instance-local and tenant scoped. Licensed CPT
-- content is imported only by the authorized tenant and never bundled in source.
CREATE TABLE terminology_releases (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 system text NOT NULL CHECK (system IN ('ICD-10-CM','ICD-10-PCS','HCPCS','CPT')),
 edition text NOT NULL CHECK (length(edition) BETWEEN 1 AND 120),
 source_name text NOT NULL CHECK (length(source_name) BETWEEN 1 AND 200),
 source_url text NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2000),
 source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
 effective_start date NOT NULL,
 effective_end date CHECK (effective_end IS NULL OR effective_end >= effective_start),
 rights text NOT NULL CHECK (rights IN ('public_use','licensed')),
 rights_attested boolean NOT NULL CHECK (rights_attested),
 license_reference text CHECK (license_reference IS NULL OR length(license_reference) BETWEEN 1 AND 500),
 license_valid_until date,
 request_id uuid NOT NULL,
 request_digest text NOT NULL CHECK (length(request_digest)=64),
 code_count integer NOT NULL CHECK (code_count BETWEEN 1 AND 150000),
 created_by uuid NOT NULL,
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 UNIQUE (tenant_id,request_id),
 UNIQUE (tenant_id,system,edition),
 CHECK (system <> 'CPT' OR (rights='licensed' AND license_reference IS NOT NULL))
);
CREATE INDEX terminology_release_lookup ON terminology_releases(tenant_id,system,effective_start DESC,id);
CREATE TABLE terminology_codes (
 tenant_id uuid NOT NULL,
 release_id uuid NOT NULL,
 code text NOT NULL CHECK (length(code) BETWEEN 3 AND 8),
 code_key text NOT NULL CHECK (length(code_key) BETWEEN 3 AND 7),
 display text NOT NULL CHECK (length(display) BETWEEN 1 AND 1000),
 short_display text CHECK (short_display IS NULL OR length(short_display) BETWEEN 1 AND 256),
 billable boolean NOT NULL,
 active boolean NOT NULL,
 effective_start date NOT NULL,
 effective_end date CHECK (effective_end IS NULL OR effective_end >= effective_start),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object' AND pg_column_size(metadata)<=8192),
 search_text tsvector GENERATED ALWAYS AS (to_tsvector('simple',display || ' ' || coalesce(short_display,''))) STORED,
 PRIMARY KEY (tenant_id,release_id,code),
 UNIQUE (tenant_id,release_id,code_key),
 FOREIGN KEY (tenant_id,release_id) REFERENCES terminology_releases(tenant_id,id)
);
CREATE INDEX terminology_code_prefix ON terminology_codes(tenant_id,release_id,code_key text_pattern_ops);
CREATE INDEX terminology_code_search ON terminology_codes USING gin(search_text);
CREATE TRIGGER terminology_releases_immutable BEFORE UPDATE OR DELETE ON terminology_releases
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER terminology_codes_immutable BEFORE UPDATE OR DELETE ON terminology_codes
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
