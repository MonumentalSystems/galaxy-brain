-- A correction is a new event; assertion rows remain immutable and auditable.
-- The 015 membership FK would pin a member forever. Preserve the historical
-- actor principal instead; the API checks active tenant membership at write time.
ALTER TABLE gb_object_links
  DROP CONSTRAINT gb_object_links_tenant_id_created_by_principal_id_fkey,
  ADD CONSTRAINT gb_object_links_created_by_principal_id_fkey
    FOREIGN KEY (created_by_principal_id)
    REFERENCES app_principals(id) ON DELETE RESTRICT;

CREATE TABLE gb_object_link_retractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  link_id UUID NOT NULL,
  expected_version INTEGER NOT NULL CHECK (expected_version = 1),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1024),
  retracted_by_principal_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, link_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, link_id)
    REFERENCES gb_object_links(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (retracted_by_principal_id)
    REFERENCES app_principals(id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_object_link_retractions_link
  ON gb_object_link_retractions(tenant_id, link_id, created_at DESC);

ALTER TABLE gb_object_link_retractions ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_object_link_retractions_tenant_isolation ON gb_object_link_retractions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER gb_object_link_retractions_append_only
BEFORE UPDATE OR DELETE ON gb_object_link_retractions
FOR EACH ROW EXECUTE FUNCTION gb_reject_object_link_mutation();

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user AND NOT role.rolsuper AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_object_links', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_object_links', 'INSERT')
      AND NOT pg_catalog.has_table_privilege(role.oid, 'public.gb_object_links', 'UPDATE')
      AND NOT pg_catalog.has_table_privilege(role.oid, 'public.gb_object_links', 'DELETE')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT ON TABLE public.gb_object_link_retractions TO %I',
      runtime_role.rolname
    );
  END LOOP;
END
$$;
