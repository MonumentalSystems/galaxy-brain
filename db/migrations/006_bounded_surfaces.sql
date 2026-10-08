CREATE TABLE gb_surfaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  created_by_principal_id UUID NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'promoted', 'archived')),
  schema_version TEXT NOT NULL CHECK (schema_version = 'gb.surface.v1'),
  catalog_id TEXT NOT NULL CHECK (catalog_id = 'generous.a2ui'),
  catalog_version TEXT NOT NULL CHECK (catalog_version = '1'),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  current_content_hash TEXT NOT NULL CHECK (current_content_hash ~ '^[0-9a-f]{64}$'),
  current_spec JSONB NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}',
  creation_idempotency_key TEXT NOT NULL CHECK (char_length(creation_idempotency_key) BETWEEN 8 AND 200),
  creation_request_hash TEXT NOT NULL CHECK (creation_request_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, creation_idempotency_key),
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_surface_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  surface_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('draft', 'promoted', 'archived')),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  spec JSONB NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, surface_id, version),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, surface_id)
    REFERENCES gb_surfaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_surfaces_tenant_updated
  ON gb_surfaces(tenant_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_gb_surfaces_tenant_status
  ON gb_surfaces(tenant_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_gb_surface_revisions_surface
  ON gb_surface_revisions(tenant_id, surface_id, version DESC);

ALTER TABLE gb_surfaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_surface_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_surfaces_tenant_isolation ON gb_surfaces
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_surface_revisions_tenant_isolation ON gb_surface_revisions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Existing production API roles predate these tables. Carry forward the same
-- DML capability only for restricted roles that already have the complete API
-- privilege set on the previous revision ledger. Fresh local roles are granted
-- explicitly by provision-local-runtime-roles.mjs after migrations.
DO $$
DECLARE
  runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user
      AND NOT role.rolsuper
      AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_node_revisions', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_node_revisions', 'INSERT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_node_revisions', 'UPDATE')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_node_revisions', 'DELETE')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.gb_surfaces, public.gb_surface_revisions TO %I',
      runtime_role.rolname
    );
  END LOOP;
END
$$;
