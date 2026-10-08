-- Bind every newly created experiment to one tenant-scoped request identity.
-- Legacy experiments remain valid with both fields absent.

ALTER TABLE gb_experiments
  ADD COLUMN creation_idempotency_key TEXT,
  ADD COLUMN creation_request_hash TEXT,
  ADD CONSTRAINT gb_experiments_creation_idempotency_pair CHECK (
    (creation_idempotency_key IS NULL AND creation_request_hash IS NULL)
    OR (
      creation_idempotency_key IS NOT NULL
      AND creation_request_hash IS NOT NULL
      AND char_length(creation_idempotency_key) BETWEEN 8 AND 200
      AND creation_idempotency_key ~ '^[!-~]+$'
      AND creation_request_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT gb_experiments_creation_idempotency_unique
    UNIQUE (tenant_id, creation_idempotency_key);

-- The receipt deliberately has no foreign key to gb_experiments. It is the
-- durable tombstone which prevents a delete followed by an identical retry
-- from allocating a second experiment identity.
CREATE TABLE gb_experiment_creation_receipts (
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[!-~]+$'
  ),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  experiment_id TEXT NOT NULL CHECK (char_length(experiment_id) BETWEEN 1 AND 200),
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key),
  UNIQUE (tenant_id, experiment_id)
);

ALTER TABLE gb_experiment_creation_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_experiment_creation_receipts_tenant_isolation
  ON gb_experiment_creation_receipts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user AND NOT role.rolsuper AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_experiments', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_experiments', 'INSERT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_experiments', 'UPDATE')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_experiments', 'DELETE')
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE public.gb_experiment_creation_receipts TO %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
