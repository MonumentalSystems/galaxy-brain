-- Give derived document chunks a versioned, reproducible identity. Chunks stay
-- local indexing evidence: they are not Galaxy objects and do not create graph
-- or HAM relations.

ALTER TABLE gb_document_chunks
  ADD COLUMN identity_version TEXT,
  ADD COLUMN identity_canonical TEXT,
  ADD COLUMN selector_canonical TEXT,
  ADD COLUMN selector_sha256 TEXT,
  ADD COLUMN chunker_config_json JSONB,
  ADD COLUMN chunker_config_canonical TEXT,
  ADD COLUMN chunker_config_sha256 TEXT;

-- Migration 020 declared the table before there was a producer. Preserve any
-- operator-created rows explicitly as legacy evidence instead of silently
-- relabelling them as the v1 contract.
ALTER TABLE gb_document_chunks
  DISABLE TRIGGER gb_document_chunks_append_only;

UPDATE gb_document_chunks
   SET identity_version = 'gb.document-chunk.legacy.v0',
       identity_canonical = '{}',
       selector_canonical = selector_json::text,
       selector_sha256 = encode(digest(convert_to(selector_json::text, 'UTF8'), 'sha256'), 'hex'),
       chunker_config_json = '{"legacy":true}'::jsonb,
       chunker_config_canonical = '{"legacy":true}',
       chunker_config_sha256 = encode(digest(convert_to('{"legacy":true}', 'UTF8'), 'sha256'), 'hex');

ALTER TABLE gb_document_chunks
  ENABLE TRIGGER gb_document_chunks_append_only;

ALTER TABLE gb_document_chunks
  ALTER COLUMN identity_version SET NOT NULL,
  ALTER COLUMN identity_canonical SET NOT NULL,
  ALTER COLUMN selector_canonical SET NOT NULL,
  ALTER COLUMN selector_sha256 SET NOT NULL,
  ALTER COLUMN chunker_config_json SET NOT NULL,
  ALTER COLUMN chunker_config_canonical SET NOT NULL,
  ALTER COLUMN chunker_config_sha256 SET NOT NULL,
  DROP CONSTRAINT gb_document_chunks_pkey,
  DROP CONSTRAINT gb_document_chunks_tenant_id_representation_id_ordinal_key,
  ADD CONSTRAINT gb_document_chunks_pkey
    PRIMARY KEY (tenant_id, representation_id, id),
  ADD CONSTRAINT gb_document_chunks_selector_sha256_shape
    CHECK (selector_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT gb_document_chunks_config_sha256_shape
    CHECK (chunker_config_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT gb_document_chunks_canonical_bounds
    CHECK (
      octet_length(identity_canonical) BETWEEN 2 AND 32768
      AND octet_length(selector_canonical) BETWEEN 2 AND 32768
      AND octet_length(chunker_config_canonical) BETWEEN 2 AND 32768
    ),
  ADD CONSTRAINT gb_document_chunks_identity_version
    CHECK (identity_version IN ('gb.document-chunk.legacy.v0', 'gb.document-chunk.v1')),
  ADD CONSTRAINT gb_document_chunks_v1_identity_binding
    CHECK (
      identity_version <> 'gb.document-chunk.v1'
      OR (
        selector_canonical::jsonb = selector_json
        AND chunker_config_canonical::jsonb = chunker_config_json
        AND encode(digest(convert_to(selector_canonical, 'UTF8'), 'sha256'), 'hex') = selector_sha256
        AND encode(digest(convert_to(chunker_config_canonical, 'UTF8'), 'sha256'), 'hex') = chunker_config_sha256
        AND identity_canonical::jsonb = jsonb_build_object(
          'schemaId', identity_version,
          'representationSha256', representation_sha256,
          'selector', selector_json,
          'chunker', jsonb_build_object(
            'id', chunker,
            'version', chunker_version,
            'configSha256', chunker_config_sha256
          )
        )
        AND id = 'sha256:' || encode(
          digest(convert_to(identity_canonical, 'UTF8'), 'sha256'), 'hex'
        )
      )
    ),
  ADD CONSTRAINT gb_document_chunks_materialization_key
    UNIQUE (
      tenant_id, representation_id, identity_version,
      chunker, chunker_version, chunker_config_sha256, ordinal
    );

CREATE INDEX idx_gb_document_chunks_current_manifest
  ON gb_document_chunks (
    tenant_id, representation_id, identity_version,
    chunker, chunker_version, chunker_config_sha256, ordinal
  )
  WHERE identity_version = 'gb.document-chunk.v1';

CREATE TABLE gb_document_chunk_manifests (
  id TEXT NOT NULL CHECK (id ~ '^sha256:[0-9a-f]{64}$'),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  identity_version TEXT NOT NULL CHECK (identity_version = 'gb.document-chunk-manifest.v1'),
  identity_canonical TEXT NOT NULL CHECK (octet_length(identity_canonical) BETWEEN 2 AND 32768),
  representation_id UUID NOT NULL,
  representation_sha256 TEXT NOT NULL CHECK (representation_sha256 ~ '^[0-9a-f]{64}$'),
  representation_kind TEXT NOT NULL CHECK (representation_kind IN ('document-structure', 'markdown', 'text')),
  chunker TEXT NOT NULL CHECK (char_length(chunker) BETWEEN 1 AND 100),
  chunker_version TEXT NOT NULL CHECK (char_length(chunker_version) BETWEEN 1 AND 100),
  chunker_config_json JSONB NOT NULL CHECK (jsonb_typeof(chunker_config_json) = 'object'),
  chunker_config_canonical TEXT NOT NULL CHECK (octet_length(chunker_config_canonical) BETWEEN 2 AND 32768),
  chunker_config_sha256 TEXT NOT NULL CHECK (chunker_config_sha256 ~ '^[0-9a-f]{64}$'),
  chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 0 AND 100000),
  chunks_sha256 TEXT NOT NULL CHECK (chunks_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Chunk and manifest identities deliberately ignore the storage-row UUID:
  -- identical representation bytes have identical content addresses. Keep
  -- persistence representation-scoped so the same derived evidence can be
  -- attached to two immutable document revisions without a false collision.
  PRIMARY KEY (tenant_id, representation_id, id),
  UNIQUE (
    tenant_id, representation_id, identity_version,
    chunker, chunker_version, chunker_config_sha256
  ),
  FOREIGN KEY (tenant_id, representation_id, representation_sha256)
    REFERENCES gb_document_representations(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  CHECK (chunker_config_canonical::jsonb = chunker_config_json),
  CHECK (
    encode(digest(convert_to(chunker_config_canonical, 'UTF8'), 'sha256'), 'hex')
      = chunker_config_sha256
  ),
  CHECK (
    identity_canonical::jsonb = jsonb_build_object(
      'schemaId', identity_version,
      'representationSha256', representation_sha256,
      'chunker', jsonb_build_object(
        'id', chunker,
        'version', chunker_version,
        'configSha256', chunker_config_sha256
      )
    )
  ),
  CHECK (
    id = 'sha256:' || encode(
      digest(convert_to(identity_canonical, 'UTF8'), 'sha256'), 'hex'
    )
  )
);

ALTER TABLE gb_document_chunk_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_document_chunk_manifests FORCE ROW LEVEL SECURITY;

CREATE POLICY gb_document_chunk_manifests_tenant_isolation
  ON gb_document_chunk_manifests
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER gb_document_chunk_manifests_append_only
BEFORE UPDATE OR DELETE ON gb_document_chunk_manifests
FOR EACH ROW EXECUTE FUNCTION gb_reject_ingestion_evidence_mutation();

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user AND NOT role.rolsuper AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_document_chunks', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_document_chunks', 'INSERT')
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE public.gb_document_chunk_manifests TO %I',
      runtime_role.rolname
    );
    EXECUTE format(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.gb_document_chunk_manifests FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
