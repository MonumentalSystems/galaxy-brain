-- Bind the private Paper Bench's immutable PDF row to the canonical durable
-- document revision created from the same exact bytes. Existing Paper Bench
-- rows remain readable and acquire a bridge on the next same-byte save.

ALTER TABLE gb_paper_revisions
  ADD CONSTRAINT gb_paper_revisions_exact_identity_key
  UNIQUE (tenant_id, paper_id, id, metadata_hash);

ALTER TABLE gb_paper_documents
  ADD CONSTRAINT gb_paper_documents_exact_content_key
  UNIQUE (tenant_id, paper_id, paper_revision_id, id, content_sha256);

CREATE TABLE gb_paper_document_bridges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  paper_document_id UUID NOT NULL,
  paper_id UUID NOT NULL,
  paper_revision_id UUID NOT NULL,
  paper_metadata_hash TEXT NOT NULL CHECK (paper_metadata_hash ~ '^[0-9a-f]{64}$'),
  document_id UUID NOT NULL,
  document_revision_id UUID NOT NULL,
  document_revision_sha256 TEXT NOT NULL CHECK (
    document_revision_sha256 ~ '^[0-9a-f]{64}$'
  ),
  artifact_id UUID NOT NULL,
  source_id UUID NOT NULL,
  original_representation_id UUID NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, paper_document_id),
  UNIQUE (tenant_id, paper_revision_id),
  UNIQUE (tenant_id, document_id, document_revision_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, paper_id, paper_revision_id, paper_metadata_hash)
    REFERENCES gb_paper_revisions(tenant_id, paper_id, id, metadata_hash) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, paper_id, paper_revision_id, paper_document_id, content_sha256)
    REFERENCES gb_paper_documents(tenant_id, paper_id, paper_revision_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, artifact_id, content_sha256)
    REFERENCES gb_artifacts(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, source_id, artifact_id)
    REFERENCES gb_artifact_sources(tenant_id, id, artifact_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, document_id, document_revision_id, document_revision_sha256)
    REFERENCES gb_document_revisions(tenant_id, document_id, id, revision_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, document_revision_id, artifact_id)
    REFERENCES gb_document_revisions(tenant_id, id, original_artifact_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, document_revision_id, original_representation_id, content_sha256)
    REFERENCES gb_document_representations(tenant_id, document_revision_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_paper_document_bridges_document
  ON gb_paper_document_bridges(tenant_id, document_id, document_revision_id);

CREATE OR REPLACE FUNCTION gb_reject_paper_document_bridge_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'paper document bridges are append-only';
END;
$$;

CREATE TRIGGER gb_paper_document_bridges_append_only
BEFORE UPDATE OR DELETE ON gb_paper_document_bridges
FOR EACH ROW EXECUTE FUNCTION gb_reject_paper_document_bridge_mutation();

ALTER TABLE gb_paper_document_bridges ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_paper_document_bridges FORCE ROW LEVEL SECURITY;

CREATE POLICY gb_paper_document_bridges_tenant_isolation
  ON gb_paper_document_bridges
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user AND NOT role.rolsuper AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_paper_documents', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_paper_documents', 'INSERT')
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE public.gb_paper_document_bridges TO %I',
      runtime_role.rolname
    );
    EXECUTE format(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.gb_paper_document_bridges FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
