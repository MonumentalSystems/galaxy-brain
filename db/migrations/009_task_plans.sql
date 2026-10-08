CREATE TABLE gb_task_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  ham_task_id TEXT NOT NULL CHECK (char_length(ham_task_id) BETWEEN 1 AND 200),
  created_by_principal_id UUID NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  schema_version TEXT NOT NULL CHECK (schema_version = 'gb.task-plan.v1'),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  current_content_hash TEXT NOT NULL CHECK (current_content_hash ~ '^[0-9a-f]{64}$'),
  current_spec JSONB NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}',
  creation_idempotency_key TEXT NOT NULL CHECK (char_length(creation_idempotency_key) BETWEEN 8 AND 200),
  creation_request_hash TEXT NOT NULL CHECK (creation_request_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ham_task_id),
  UNIQUE (tenant_id, creation_idempotency_key),
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_task_plan_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  task_plan_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  schema_version TEXT NOT NULL CHECK (schema_version = 'gb.task-plan.v1'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  spec JSONB NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, task_plan_id, version),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, task_plan_id)
    REFERENCES gb_task_plans(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_task_plans_task
  ON gb_task_plans(tenant_id, ham_task_id, updated_at DESC);
CREATE INDEX idx_gb_task_plan_revisions_plan
  ON gb_task_plan_revisions(tenant_id, task_plan_id, version DESC);

ALTER TABLE gb_task_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_task_plan_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_task_plans_tenant_isolation ON gb_task_plans
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_task_plan_revisions_tenant_isolation ON gb_task_plan_revisions
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
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.gb_task_plans, public.gb_task_plan_revisions TO %I',
      runtime_role.rolname
    );
  END LOOP;
END
$$;
