-- Durable, content-addressed document ingestion. Original bytes are stored
-- before any optional transform is attempted; all evidence-bearing rows are
-- append-only and tenant isolated.

CREATE TABLE gb_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size BIGINT NOT NULL CHECK (byte_size BETWEEN 0 AND 104857600),
  media_type TEXT NOT NULL CHECK (char_length(media_type) BETWEEN 1 AND 200),
  content_bytes BYTEA NOT NULL,
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_sha256),
  UNIQUE (tenant_id, id, content_sha256),
  CHECK (octet_length(content_bytes) = byte_size),
  CHECK (encode(digest(content_bytes, 'sha256'), 'hex') = content_sha256)
);

CREATE TABLE gb_artifact_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  artifact_id UUID NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('upload', 'url', 'arxiv', 'legacy-paper')),
  original_filename TEXT CHECK (original_filename IS NULL OR char_length(original_filename) BETWEEN 1 AND 512),
  source_uri TEXT CHECK (source_uri IS NULL OR char_length(source_uri) BETWEEN 1 AND 4096),
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(source_metadata) = 'object' AND octet_length(source_metadata::text) <= 65536
  ),
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, artifact_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, artifact_id) REFERENCES gb_artifacts(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE gb_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  display_filename TEXT NOT NULL CHECK (char_length(display_filename) BETWEEN 1 AND 512),
  current_revision_id UUID,
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, id)
);

CREATE TABLE gb_document_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  document_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  display_filename TEXT NOT NULL CHECK (char_length(display_filename) BETWEEN 1 AND 512),
  original_artifact_id UUID NOT NULL,
  source_id UUID NOT NULL,
  revision_sha256 TEXT NOT NULL CHECK (revision_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_id, version),
  UNIQUE (tenant_id, document_id, id, version),
  UNIQUE (tenant_id, id, original_artifact_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES gb_documents(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, original_artifact_id) REFERENCES gb_artifacts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, source_id, original_artifact_id)
    REFERENCES gb_artifact_sources(tenant_id, id, artifact_id) ON DELETE RESTRICT
);

ALTER TABLE gb_documents ADD CONSTRAINT gb_documents_current_revision_fkey
  FOREIGN KEY (tenant_id, id, current_revision_id, current_version)
  REFERENCES gb_document_revisions(tenant_id, document_id, id, version) ON DELETE RESTRICT;

CREATE TABLE gb_document_representations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  document_revision_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('original', 'document-structure', 'markdown', 'text', 'thumbnail')),
  media_type TEXT NOT NULL CHECK (char_length(media_type) BETWEEN 1 AND 200),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_id UUID,
  content_json JSONB,
  content_bytes BYTEA,
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, content_sha256),
  UNIQUE (tenant_id, document_revision_id, id, content_sha256),
  UNIQUE (tenant_id, document_revision_id, kind, content_sha256),
  CHECK (num_nonnulls(artifact_id, content_json, content_bytes) = 1),
  CHECK (content_json IS NULL OR jsonb_typeof(content_json) IN ('object', 'array', 'string')),
  CHECK (content_json IS NULL OR octet_length(content_json::text) <= 16777216),
  CHECK (content_bytes IS NULL OR octet_length(content_bytes) <= 16777216),
  CHECK (
    artifact_id IS NOT NULL
    OR content_bytes IS NOT NULL AND encode(digest(content_bytes, 'sha256'), 'hex') = content_sha256
    OR content_json IS NOT NULL AND encode(digest(convert_to(content_json::text, 'UTF8'), 'sha256'), 'hex') = content_sha256
  ),
  FOREIGN KEY (tenant_id, document_revision_id) REFERENCES gb_document_revisions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, artifact_id, content_sha256)
    REFERENCES gb_artifacts(tenant_id, id, content_sha256) ON DELETE RESTRICT
);

CREATE TABLE gb_transform_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  document_revision_id UUID NOT NULL,
  input_artifact_id UUID NOT NULL,
  plugin_id TEXT NOT NULL CHECK (char_length(plugin_id) BETWEEN 1 AND 120),
  plugin_version TEXT NOT NULL CHECK (char_length(plugin_version) BETWEEN 1 AND 100),
  engine TEXT NOT NULL CHECK (char_length(engine) BETWEEN 1 AND 100),
  engine_version TEXT NOT NULL CHECK (char_length(engine_version) BETWEEN 1 AND 100),
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config_json) = 'object'),
  config_sha256 TEXT NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  input_sha256 TEXT NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  output_representation_id UUID,
  output_sha256 TEXT CHECK (output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'fallback', 'failed', 'skipped')),
  diagnostic_code TEXT CHECK (
    diagnostic_code IS NULL OR diagnostic_code ~ '^[a-z0-9][a-z0-9._-]{0,119}$'
  ),
  output_manifest JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(output_manifest) = 'object'
    AND octet_length(output_manifest::text) <= 16384
  ),
  fallback_receipt_id UUID,
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (encode(digest(convert_to(config_json::text, 'UTF8'), 'sha256'), 'hex') = config_sha256),
  CHECK (
    (status IN ('success', 'partial', 'fallback') AND output_representation_id IS NOT NULL AND output_sha256 IS NOT NULL)
    OR (status IN ('failed', 'skipped') AND output_representation_id IS NULL AND output_sha256 IS NULL)
  ),
  FOREIGN KEY (tenant_id, document_revision_id, input_artifact_id)
    REFERENCES gb_document_revisions(tenant_id, id, original_artifact_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, input_artifact_id, input_sha256)
    REFERENCES gb_artifacts(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, document_revision_id, output_representation_id, output_sha256)
    REFERENCES gb_document_representations(tenant_id, document_revision_id, id, content_sha256) ON DELETE RESTRICT
);

ALTER TABLE gb_transform_receipts
  ADD CONSTRAINT gb_transform_receipts_fallback_fkey
    FOREIGN KEY (tenant_id, fallback_receipt_id)
    REFERENCES gb_transform_receipts(tenant_id, id) ON DELETE RESTRICT;

CREATE TABLE gb_document_anchors (
  id TEXT NOT NULL CHECK (id ~ '^sha256:[0-9a-f]{64}$'),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  representation_id UUID NOT NULL,
  representation_sha256 TEXT NOT NULL CHECK (representation_sha256 ~ '^[0-9a-f]{64}$'),
  selector_json JSONB NOT NULL CHECK (jsonb_typeof(selector_json) = 'object' AND octet_length(selector_json::text) <= 32768),
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, representation_id, representation_sha256)
    REFERENCES gb_document_representations(tenant_id, id, content_sha256) ON DELETE RESTRICT
);

CREATE TABLE gb_document_chunks (
  id TEXT NOT NULL CHECK (id ~ '^sha256:[0-9a-f]{64}$'),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  representation_id UUID NOT NULL,
  representation_sha256 TEXT NOT NULL CHECK (representation_sha256 ~ '^[0-9a-f]{64}$'),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 1000000),
  selector_json JSONB NOT NULL CHECK (jsonb_typeof(selector_json) = 'object' AND octet_length(selector_json::text) <= 32768),
  text_content TEXT NOT NULL CHECK (octet_length(text_content) BETWEEN 1 AND 1048576),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  chunker TEXT NOT NULL CHECK (char_length(chunker) BETWEEN 1 AND 100),
  chunker_version TEXT NOT NULL CHECK (char_length(chunker_version) BETWEEN 1 AND 100),
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, representation_id, ordinal),
  CHECK (encode(digest(convert_to(text_content, 'UTF8'), 'sha256'), 'hex') = content_sha256),
  FOREIGN KEY (tenant_id, representation_id, representation_sha256)
    REFERENCES gb_document_representations(tenant_id, id, content_sha256) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_documents_tenant_updated ON gb_documents(tenant_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_gb_document_revisions_document ON gb_document_revisions(tenant_id, document_id, version DESC);
CREATE INDEX idx_gb_artifact_sources_artifact ON gb_artifact_sources(tenant_id, artifact_id, created_at DESC);
CREATE INDEX idx_gb_representations_revision ON gb_document_representations(tenant_id, document_revision_id, kind);

ALTER TABLE gb_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_artifact_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_document_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_document_representations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_transform_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_document_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_document_chunks ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'gb_artifacts', 'gb_artifact_sources', 'gb_documents', 'gb_document_revisions',
    'gb_document_representations', 'gb_transform_receipts', 'gb_document_anchors', 'gb_document_chunks'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION gb_reject_ingestion_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'durable ingestion evidence is append-only';
END;
$$;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'gb_artifacts', 'gb_artifact_sources', 'gb_document_revisions', 'gb_document_representations',
    'gb_transform_receipts', 'gb_document_anchors', 'gb_document_chunks'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION gb_reject_ingestion_evidence_mutation()',
      table_name || '_append_only', table_name
    );
  END LOOP;
END;
$$;

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user AND NOT role.rolsuper AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'INSERT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'UPDATE')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'DELETE')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.gb_documents TO %I', runtime_role.rolname);
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE public.gb_artifacts, public.gb_artifact_sources, public.gb_document_revisions, public.gb_document_representations, public.gb_transform_receipts, public.gb_document_anchors, public.gb_document_chunks TO %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
