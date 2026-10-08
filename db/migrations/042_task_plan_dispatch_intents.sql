-- Durable authorization boundary for task-plan execution. A dispatch intent is
-- reserved while its plan revision is current, before Galaxy calls Hyades.
-- Retries replay this immutable record and the same downstream idempotency key.
CREATE TABLE gb_task_plan_dispatch_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  task_plan_id UUID NOT NULL,
  task_plan_version INTEGER NOT NULL CHECK (task_plan_version > 0),
  task_plan_content_hash TEXT NOT NULL CHECK (task_plan_content_hash ~ '^[0-9a-f]{64}$'),
  ham_task_id TEXT NOT NULL CHECK (char_length(ham_task_id) BETWEEN 1 AND 200),
  expected_task_version INTEGER NOT NULL CHECK (expected_task_version > 0),
  requested_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, task_plan_id, task_plan_version)
    REFERENCES gb_task_plan_revisions(tenant_id, task_plan_id, version) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_task_plan_dispatch_intents_plan
  ON gb_task_plan_dispatch_intents(tenant_id, task_plan_id, created_at DESC);

ALTER TABLE gb_task_plan_dispatch_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_task_plan_dispatch_intents FORCE ROW LEVEL SECURITY;

CREATE POLICY gb_task_plan_dispatch_intents_tenant_isolation
  ON gb_task_plan_dispatch_intents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION gb_reject_task_plan_dispatch_intent_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'task plan dispatch intents are append-only';
END
$$;

CREATE TRIGGER gb_task_plan_dispatch_intents_append_only
BEFORE UPDATE OR DELETE ON gb_task_plan_dispatch_intents
FOR EACH ROW EXECUTE FUNCTION gb_reject_task_plan_dispatch_intent_mutation();

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user AND NOT role.rolsuper AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'INSERT')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT ON TABLE public.gb_task_plan_dispatch_intents TO %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.gb_task_plan_dispatch_intents FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END
$$;

COMMENT ON TABLE gb_task_plan_dispatch_intents IS
  'Append-only exact-revision dispatch reservations. Execution truth and run state remain authoritative in Hyades.';
