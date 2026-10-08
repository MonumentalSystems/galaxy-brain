-- Canonical transform requests are reconciled independently of caller-chosen
-- idempotency keys. Every accepted key remains durably bound to its first
-- request, including keys that replay already-completed canonical work.

CREATE TABLE gb_transform_request_keys (
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[!-~]+$'
  ),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  document_revision_id UUID NOT NULL,
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, document_revision_id)
    REFERENCES gb_document_revisions(tenant_id, id) ON DELETE RESTRICT
);

INSERT INTO gb_transform_request_keys (
  tenant_id, idempotency_key, request_sha256, document_revision_id,
  created_by_principal_id, created_at
)
SELECT tenant_id, idempotency_key, request_sha256, document_revision_id,
       created_by_principal_id, created_at
  FROM gb_transform_attempts;

CREATE INDEX idx_gb_transform_attempts_request
  ON gb_transform_attempts(tenant_id, request_sha256, created_at, id);

ALTER TABLE gb_transform_request_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_transform_request_keys_tenant_isolation ON gb_transform_request_keys
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
      'GRANT SELECT, INSERT ON TABLE public.gb_transform_request_keys TO %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
