CREATE TABLE gb_canvases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL CHECK (
    char_length(workspace_id) BETWEEN 1 AND 128
    AND workspace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  current_content_hash TEXT NOT NULL CHECK (current_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL,
  creation_idempotency_key TEXT NOT NULL CHECK (
    char_length(creation_idempotency_key) BETWEEN 8 AND 200
    AND creation_idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  creation_request_hash TEXT NOT NULL CHECK (creation_request_hash ~ '^[0-9a-f]{64}$'),
  removed_item_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(removed_item_ids) = 'array'
    AND jsonb_array_length(removed_item_ids) <= 2000
    AND octet_length(removed_item_ids::text) <= 262144
  ),
  removed_edge_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(removed_edge_ids) = 'array'
    AND jsonb_array_length(removed_edge_ids) <= 4000
    AND octet_length(removed_edge_ids::text) <= 524288
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, workspace_id),
  UNIQUE (tenant_id, creation_idempotency_key),
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_canvas_items (
  id TEXT NOT NULL CHECK (
    char_length(id) BETWEEN 1 AND 128
    AND id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  canvas_id UUID NOT NULL,
  subject_ref TEXT NOT NULL CHECK (
    char_length(subject_ref) BETWEEN 1 AND 16384
    AND subject_ref LIKE 'gb:object:v1:%'
  ),
  node_type TEXT NOT NULL CHECK (node_type IN (
    'galaxy.paper', 'galaxy.note', 'galaxy.document', 'galaxy.media',
    'galaxy.eln-record', 'galaxy.task', 'galaxy.proof', 'galaxy.surface'
  )),
  x DOUBLE PRECISION NOT NULL CHECK (x >= -10000000 AND x <= 10000000),
  y DOUBLE PRECISION NOT NULL CHECK (y >= -10000000 AND y <= 10000000),
  width DOUBLE PRECISION NOT NULL CHECK (width >= 80 AND width <= 2400),
  height DOUBLE PRECISION NOT NULL CHECK (height >= 80 AND height <= 2400),
  angle DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (angle >= -360 AND angle <= 360),
  z_index INTEGER NOT NULL DEFAULT 0 CHECK (z_index BETWEEN -1000000 AND 1000000),
  display_mode TEXT NOT NULL DEFAULT 'card' CHECK (
    char_length(display_mode) BETWEEN 1 AND 80
    AND display_mode ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  collapsed BOOLEAN NOT NULL DEFAULT false,
  style_json JSONB NOT NULL DEFAULT '{}' CHECK (
    jsonb_typeof(style_json) = 'object'
    AND octet_length(style_json::text) <= 32768
  ),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, canvas_id, id),
  FOREIGN KEY (tenant_id, canvas_id)
    REFERENCES gb_canvases(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_canvas_edges (
  id TEXT NOT NULL CHECK (
    char_length(id) BETWEEN 1 AND 128
    AND id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  canvas_id UUID NOT NULL,
  source_item_id TEXT NOT NULL,
  target_item_id TEXT NOT NULL,
  edge_kind TEXT NOT NULL DEFAULT 'presentation' CHECK (edge_kind = 'presentation'),
  label TEXT CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 240),
  semantic_ref TEXT CHECK (
    semantic_ref IS NULL OR (
      char_length(semantic_ref) BETWEEN 1 AND 16384
      AND semantic_ref LIKE 'gb:object:v1:%'
    )
  ),
  style_json JSONB NOT NULL DEFAULT '{}' CHECK (
    jsonb_typeof(style_json) = 'object'
    AND octet_length(style_json::text) <= 32768
  ),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CHECK (source_item_id <> target_item_id),
  CHECK (semantic_ref IS NULL),
  PRIMARY KEY (tenant_id, canvas_id, id),
  FOREIGN KEY (tenant_id, canvas_id)
    REFERENCES gb_canvases(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, canvas_id, source_item_id)
    REFERENCES gb_canvas_items(tenant_id, canvas_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, canvas_id, target_item_id)
    REFERENCES gb_canvas_items(tenant_id, canvas_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_canvas_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  canvas_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  mutation_json JSONB NOT NULL CHECK (
    jsonb_typeof(mutation_json) = 'object'
    AND octet_length(mutation_json::text) <= 262144
  ),
  snapshot_json JSONB NOT NULL CHECK (
    jsonb_typeof(snapshot_json) = 'object'
    AND snapshot_json->>'schemaId' = 'gb.canvas.snapshot.v1'
    AND octet_length(snapshot_json::text) <= 8388608
  ),
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, canvas_id, version),
  UNIQUE (tenant_id, canvas_id, idempotency_key),
  FOREIGN KEY (tenant_id, canvas_id)
    REFERENCES gb_canvases(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_canvases_tenant_updated
  ON gb_canvases(tenant_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_gb_canvas_items_canvas
  ON gb_canvas_items(tenant_id, canvas_id, z_index, id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_gb_canvas_edges_canvas
  ON gb_canvas_edges(tenant_id, canvas_id, id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_gb_canvas_revisions_canvas
  ON gb_canvas_revisions(tenant_id, canvas_id, version DESC);

ALTER TABLE gb_canvases ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_canvas_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_canvas_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_canvas_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_canvases_tenant_isolation ON gb_canvases
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_canvas_items_tenant_isolation ON gb_canvas_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_canvas_edges_tenant_isolation ON gb_canvas_edges
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_canvas_revisions_tenant_isolation ON gb_canvas_revisions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION gb_reject_canvas_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'canvas revisions are append-only';
END;
$$;

CREATE TRIGGER gb_canvas_revisions_append_only
BEFORE UPDATE OR DELETE ON gb_canvas_revisions
FOR EACH ROW EXECUTE FUNCTION gb_reject_canvas_revision_mutation();

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
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.gb_canvases, public.gb_canvas_items, public.gb_canvas_edges TO %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT ON TABLE public.gb_canvas_revisions TO %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
