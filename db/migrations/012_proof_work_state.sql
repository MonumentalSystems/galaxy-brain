CREATE TABLE gb_proof_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  workspace_key TEXT NOT NULL CHECK (
    char_length(workspace_key) BETWEEN 1 AND 512
    AND workspace_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  graph_id TEXT NOT NULL CHECK (
    char_length(graph_id) BETWEEN 1 AND 512
    AND graph_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  graph_content_sha256 TEXT NOT NULL CHECK (graph_content_sha256 ~ '^[0-9a-f]{64}$'),
  node_ids TEXT[] NOT NULL CHECK (
    cardinality(node_ids) BETWEEN 1 AND 10000
    AND array_position(node_ids, NULL) IS NULL
  ),
  schema_version TEXT NOT NULL DEFAULT 'galaxy.proof-work-state.v1'
    CHECK (schema_version = 'galaxy.proof-work-state.v1'),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_by_principal_id UUID NOT NULL,
  created_by_nostr_pubkey TEXT NOT NULL CHECK (created_by_nostr_pubkey ~ '^[0-9a-f]{64}$'),
  creation_idempotency_key TEXT NOT NULL CHECK (char_length(creation_idempotency_key) BETWEEN 8 AND 200),
  creation_request_hash TEXT NOT NULL CHECK (creation_request_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, workspace_key),
  UNIQUE (tenant_id, creation_idempotency_key),
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_proof_work_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  workspace_id UUID NOT NULL,
  node_id TEXT NOT NULL CHECK (
    char_length(node_id) BETWEEN 1 AND 512
    AND node_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_by_principal_id UUID NOT NULL,
  updated_by_nostr_pubkey TEXT NOT NULL CHECK (updated_by_nostr_pubkey ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, node_id),
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES gb_proof_workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, updated_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_proof_work_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  workspace_id UUID NOT NULL,
  workspace_version INTEGER NOT NULL CHECK (workspace_version > 1),
  node_id TEXT NOT NULL CHECK (
    char_length(node_id) BETWEEN 1 AND 512
    AND node_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  item_version INTEGER NOT NULL CHECK (item_version > 0),
  transition_type TEXT NOT NULL CHECK (
    transition_type IN (
      'claim.acquire', 'claim.release', 'work.set', 'proof.candidate',
      'proof.attest', 'proof.verify', 'proof.reject', 'proof.supersede',
      'proof.override', 'external.set'
    )
  ),
  transition JSONB NOT NULL CHECK (jsonb_typeof(transition) = 'object'),
  prior_state JSONB CHECK (prior_state IS NULL OR jsonb_typeof(prior_state) = 'object'),
  next_state JSONB NOT NULL CHECK (jsonb_typeof(next_state) = 'object'),
  actor_principal_id UUID NOT NULL,
  actor_nostr_pubkey TEXT NOT NULL CHECK (actor_nostr_pubkey ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, workspace_version),
  UNIQUE (tenant_id, workspace_id, node_id, item_version),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES gb_proof_workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE app_nostr_request_events (
  event_id TEXT PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
  tenant_id UUID NOT NULL,
  principal_id UUID NOT NULL,
  pubkey TEXT NOT NULL CHECK (pubkey ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_gb_proof_workspaces_graph
  ON gb_proof_workspaces(tenant_id, graph_id, graph_content_sha256);
CREATE INDEX idx_gb_proof_work_items_workspace
  ON gb_proof_work_items(tenant_id, workspace_id, node_id);
CREATE INDEX idx_gb_proof_work_transitions_workspace
  ON gb_proof_work_transitions(tenant_id, workspace_id, workspace_version DESC);
CREATE INDEX idx_app_nostr_request_events_expires_at
  ON app_nostr_request_events(expires_at);

ALTER TABLE gb_proof_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_proof_work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_proof_work_transitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_proof_workspaces_tenant_isolation ON gb_proof_workspaces
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_proof_work_items_tenant_isolation ON gb_proof_work_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_proof_work_transitions_tenant_isolation ON gb_proof_work_transitions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION gb_reject_proof_transition_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'proof work transitions are append-only';
END;
$$;

CREATE TRIGGER gb_proof_work_transitions_append_only
BEFORE UPDATE OR DELETE ON gb_proof_work_transitions
FOR EACH ROW EXECUTE FUNCTION gb_reject_proof_transition_mutation();

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname <> current_user
       AND NOT role.rolsuper
       AND NOT role.rolbypassrls
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'SELECT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'INSERT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'UPDATE')
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'DELETE')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.gb_proof_workspaces, public.gb_proof_work_items TO %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT ON TABLE public.gb_proof_work_transitions TO %I',
      runtime_role.rolname
    );
  END LOOP;

  FOR runtime_role IN
    SELECT role.rolname
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname <> current_user
       AND NOT role.rolsuper
       AND NOT role.rolbypassrls
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_sessions', 'SELECT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_sessions', 'INSERT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_sessions', 'UPDATE')
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_sessions', 'DELETE')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, DELETE ON TABLE public.app_nostr_request_events TO %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
