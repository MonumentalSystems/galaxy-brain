CREATE TABLE gb_paper_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  paper_id UUID NOT NULL,
  paper_revision_id UUID NOT NULL,
  stored_by_principal_id UUID NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'application/pdf' CHECK (media_type = 'application/pdf'),
  filename TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 512),
  byte_size BIGINT NOT NULL CHECK (byte_size BETWEEN 5 AND 100000000),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_url TEXT NOT NULL CHECK (char_length(source_url) BETWEEN 1 AND 2048),
  pdf_bytes BYTEA NOT NULL,
  stored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, paper_revision_id),
  CHECK (octet_length(pdf_bytes) = byte_size),
  FOREIGN KEY (tenant_id, paper_id) REFERENCES gb_papers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, paper_revision_id) REFERENCES gb_paper_revisions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, stored_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_paper_documents_paper
  ON gb_paper_documents(tenant_id, paper_id, stored_at DESC);

ALTER TABLE gb_paper_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_paper_documents_tenant_isolation ON gb_paper_documents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

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
      'GRANT SELECT, INSERT ON TABLE public.gb_paper_documents TO %I',
      runtime_role.rolname
    );
  END LOOP;
END
$$;
