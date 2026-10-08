-- Immutable tenant-owned proof DAG artifacts. This registry stores structural
-- truth only: registration never creates proof workspaces, tasks, claims, or
-- claimable frontier state.

CREATE OR REPLACE FUNCTION gb_proof_graph_target_ids(graph JSONB)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT COALESCE(array_agg(target.value ->> 'target_id' ORDER BY target.ordinality), '{}')
  FROM jsonb_array_elements(graph -> 'targets') WITH ORDINALITY AS target(value, ordinality)
$$;

CREATE OR REPLACE FUNCTION gb_proof_graph_node_ref_ids(
  graph_id TEXT,
  content_sha256 TEXT,
  target_ids TEXT[]
)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  WITH indexed AS (
    SELECT target_id, ordinality,
           ordinality - 1 AS target_index
      FROM unnest(target_ids) WITH ORDINALITY AS target(target_id, ordinality)
  )
  SELECT array_agg(
    CASE
      WHEN char_length(graph_id || '#' || target_id) <= 512
        THEN graph_id || '#' || target_id
      ELSE 'proof-node-' || content_sha256 || '-' || target_index::text
    END
    ORDER BY ordinality
  )
  FROM indexed
$$;

CREATE OR REPLACE FUNCTION gb_text_array_sorted(values_to_sort TEXT[])
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT COALESCE(array_agg(value ORDER BY value), '{}')
  FROM unnest(values_to_sort) AS item(value)
$$;

CREATE OR REPLACE FUNCTION gb_text_array_is_unique(values_to_check TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(values_to_check) = count(DISTINCT value)
  FROM unnest(values_to_check) AS item(value)
$$;

CREATE TABLE gb_proof_graphs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  schema_id TEXT NOT NULL DEFAULT 'galaxy.proof-dag.v1'
    CHECK (schema_id = 'galaxy.proof-dag.v1'),
  graph_id TEXT NOT NULL CHECK (
    char_length(graph_id) BETWEEN 1 AND 512
    AND graph_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  graph_kind TEXT NOT NULL CHECK (
    graph_kind IN ('repository-field', 'campaign', 'mission')
  ),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  artifact_id UUID NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  graph_json JSONB NOT NULL CHECK (jsonb_typeof(graph_json) = 'object'),
  target_ids TEXT[] NOT NULL CHECK (
    cardinality(target_ids) BETWEEN 1 AND 10000
    AND array_position(target_ids, NULL) IS NULL
  ),
  node_ref_ids TEXT[] NOT NULL CHECK (
    cardinality(node_ref_ids) BETWEEN 1 AND 10000
    AND array_position(node_ref_ids, NULL) IS NULL
  ),
  target_count INTEGER NOT NULL CHECK (target_count BETWEEN 1 AND 10000),
  relation_count INTEGER NOT NULL CHECK (relation_count BETWEEN 0 AND 50000),
  registered_by_principal_id UUID NOT NULL,
  registered_by_nostr_pubkey TEXT NOT NULL CHECK (
    registered_by_nostr_pubkey ~ '^[0-9a-f]{64}$'
  ),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_sha256),
  UNIQUE (tenant_id, graph_id, content_sha256),
  FOREIGN KEY (tenant_id, artifact_id, content_sha256)
    REFERENCES gb_artifacts(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, registered_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT,
  CHECK (COALESCE(graph_json ->> 'schema_id', '') = schema_id),
  CHECK (COALESCE(graph_json ->> 'graph_id', '') = graph_id),
  CHECK (COALESCE(btrim(graph_json ->> 'graph_kind'), '') = graph_kind),
  CHECK (COALESCE(NULLIF(btrim(graph_json ->> 'title'), ''), graph_id) = title),
  CHECK (COALESCE(jsonb_typeof(graph_json -> 'targets'), '') = 'array'),
  CHECK (COALESCE(jsonb_typeof(graph_json -> 'relations'), '') = 'array'),
  CHECK (jsonb_array_length(graph_json -> 'targets') = target_count),
  CHECK (jsonb_array_length(graph_json -> 'relations') = relation_count),
  CHECK (gb_proof_graph_target_ids(graph_json) = target_ids),
  CHECK (gb_text_array_is_unique(target_ids)),
  CHECK (gb_text_array_is_unique(node_ref_ids)),
  CHECK (gb_proof_graph_node_ref_ids(graph_id, content_sha256, target_ids) = node_ref_ids)
);

CREATE OR REPLACE FUNCTION gb_verify_proof_graph_artifact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  artifact RECORD;
  parsed JSONB;
BEGIN
  SELECT content_sha256, byte_size, content_bytes
    INTO artifact
    FROM gb_artifacts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.artifact_id;
  IF NOT FOUND OR artifact.content_sha256 <> NEW.content_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof graph artifact hash does not match';
  END IF;
  IF artifact.byte_size < 1 OR artifact.byte_size > 16777216 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof graph artifact exceeds 16 MiB';
  END IF;
  BEGIN
    parsed := convert_from(artifact.content_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof graph artifact is not UTF-8 JSON';
  END;
  IF parsed <> NEW.graph_json THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof graph parsed JSON does not match artifact bytes';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gb_proof_graphs_verify_artifact
BEFORE INSERT ON gb_proof_graphs
FOR EACH ROW EXECUTE FUNCTION gb_verify_proof_graph_artifact();

CREATE INDEX idx_gb_proof_graphs_identity
  ON gb_proof_graphs(tenant_id, graph_id, registered_at DESC, content_sha256);

ALTER TABLE gb_proof_graphs ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_proof_graphs_tenant_isolation ON gb_proof_graphs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION gb_reject_proof_graph_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'proof graph registrations are append-only';
END;
$$;

CREATE TRIGGER gb_proof_graphs_append_only
BEFORE UPDATE OR DELETE ON gb_proof_graphs
FOR EACH ROW EXECUTE FUNCTION gb_reject_proof_graph_mutation();

-- Existing deployments may contain legacy proof-work overlays whose original
-- graph bytes cannot be reconstructed. Preserve those rows but require every
-- newly written workspace to bind an exact registered graph artifact.
ALTER TABLE gb_proof_workspaces
  ADD CONSTRAINT gb_proof_workspaces_registered_graph_fkey
  FOREIGN KEY (tenant_id, graph_id, graph_content_sha256)
  REFERENCES gb_proof_graphs(tenant_id, graph_id, content_sha256)
  ON DELETE RESTRICT NOT VALID;

CREATE OR REPLACE FUNCTION gb_guard_registered_proof_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  registered RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id <> OLD.tenant_id
       OR NEW.id <> OLD.id
       OR NEW.workspace_key <> OLD.workspace_key
       OR NEW.graph_id <> OLD.graph_id
       OR NEW.graph_content_sha256 <> OLD.graph_content_sha256
       OR NEW.node_ids <> OLD.node_ids
       OR NEW.schema_version <> OLD.schema_version
       OR NEW.created_by_principal_id <> OLD.created_by_principal_id
       OR NEW.created_by_nostr_pubkey <> OLD.created_by_nostr_pubkey
       OR NEW.creation_idempotency_key <> OLD.creation_idempotency_key
       OR NEW.creation_request_hash <> OLD.creation_request_hash
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'proof workspace graph binding is immutable';
    END IF;
    RETURN NEW;
  END IF;

  SELECT graph_kind, target_ids
    INTO registered
    FROM gb_proof_graphs
   WHERE tenant_id = NEW.tenant_id
     AND graph_id = NEW.graph_id
     AND content_sha256 = NEW.graph_content_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof workspace graph is not registered';
  END IF;
  IF registered.graph_kind NOT IN ('campaign', 'mission') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'passive proof graphs cannot create workspaces';
  END IF;
  IF NOT gb_text_array_is_unique(NEW.node_ids)
     OR gb_text_array_sorted(NEW.node_ids) <> gb_text_array_sorted(registered.target_ids) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof workspace nodes must equal the registered target set';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gb_proof_workspaces_registered_graph_guard
BEFORE INSERT OR UPDATE ON gb_proof_workspaces
FOR EACH ROW EXECUTE FUNCTION gb_guard_registered_proof_workspace();

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
      'GRANT SELECT, INSERT ON TABLE public.gb_proof_graphs TO %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'REVOKE UPDATE, DELETE ON TABLE public.gb_proof_graphs FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
