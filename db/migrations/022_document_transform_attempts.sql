-- Mutable, leased coordination for transforms. Durable representations and
-- receipts remain append-only; this row only fences provider execution and
-- points at the immutable primary receipt after finalization.

ALTER TABLE gb_transform_receipts
  ADD CONSTRAINT gb_transform_receipts_attempt_binding_unique UNIQUE (
    tenant_id, id, document_revision_id, input_artifact_id, input_sha256,
    idempotency_key, request_sha256
  ),
  ADD CONSTRAINT gb_transform_receipts_fallback_binding_unique UNIQUE (
    tenant_id, id, document_revision_id, input_artifact_id, input_sha256
  ),
  DROP CONSTRAINT gb_transform_receipts_fallback_fkey,
  ADD CONSTRAINT gb_transform_receipts_fallback_fkey FOREIGN KEY (
    tenant_id, fallback_receipt_id, document_revision_id,
    input_artifact_id, input_sha256
  ) REFERENCES gb_transform_receipts(
    tenant_id, id, document_revision_id, input_artifact_id, input_sha256
  ) ON DELETE RESTRICT;

CREATE TABLE gb_transform_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  document_revision_id UUID NOT NULL,
  input_artifact_id UUID NOT NULL,
  input_sha256 TEXT NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[!-~]+$'
  ),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('running', 'finished')),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  primary_receipt_id UUID,
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (
    (state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND primary_receipt_id IS NULL)
    OR (state = 'finished' AND lease_token IS NULL AND lease_expires_at IS NULL AND primary_receipt_id IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, document_revision_id, input_artifact_id)
    REFERENCES gb_document_revisions(tenant_id, id, original_artifact_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, input_artifact_id, input_sha256)
    REFERENCES gb_artifacts(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, primary_receipt_id, document_revision_id, input_artifact_id,
    input_sha256, idempotency_key, request_sha256
  ) REFERENCES gb_transform_receipts(
    tenant_id, id, document_revision_id, input_artifact_id,
    input_sha256, idempotency_key, request_sha256
  ) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_transform_attempts_lease
  ON gb_transform_attempts(tenant_id, state, lease_expires_at);

ALTER TABLE gb_transform_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_transform_attempts_tenant_isolation ON gb_transform_attempts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

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
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.gb_transform_attempts TO %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
