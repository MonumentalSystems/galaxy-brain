-- Explicit link assertions are tenant-owned records, not HAM semantic scores or proof receipts.
CREATE TABLE gb_object_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  from_ref TEXT NOT NULL CHECK (char_length(from_ref) BETWEEN 1 AND 16384),
  to_ref TEXT NOT NULL CHECK (char_length(to_ref) BETWEEN 1 AND 16384),
  relation TEXT NOT NULL CHECK (relation IN ('related', 'cites', 'part_of', 'derived_from', 'context_for')),
  basis TEXT NOT NULL CHECK (basis IN ('authored', 'imported')),
  provenance JSONB NOT NULL CHECK (
    jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 4096
  ),
  created_by_principal_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (from_ref LIKE 'gb:object:v1:%' AND to_ref LIKE 'gb:object:v1:%'),
  CHECK (
    (basis = 'authored' AND provenance->>'source' = 'manual') OR
    (basis = 'imported' AND provenance->>'source' = 'import'
      AND provenance ? 'source_ref')
  ),
  CHECK (from_ref <> to_ref),
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_object_links_from
  ON gb_object_links(tenant_id, from_ref, created_at DESC, id DESC);
CREATE INDEX idx_gb_object_links_to
  ON gb_object_links(tenant_id, to_ref, created_at DESC, id DESC);

ALTER TABLE gb_object_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_object_links_tenant_isolation ON gb_object_links
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION gb_reject_object_link_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'object link assertions are append-only';
END;
$$;

CREATE TRIGGER gb_object_links_append_only
BEFORE UPDATE OR DELETE ON gb_object_links
FOR EACH ROW EXECUTE FUNCTION gb_reject_object_link_mutation();

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user AND NOT role.rolsuper AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_surfaces', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_surfaces', 'INSERT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_surfaces', 'UPDATE')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_surfaces', 'DELETE')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT ON TABLE public.gb_object_links TO %I',
      runtime_role.rolname
    );
  END LOOP;
END
$$;
