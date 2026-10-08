ALTER TABLE gb_canvases
  ADD COLUMN slug TEXT,
  ADD COLUMN is_default BOOLEAN;

-- Migration 018 allowed at most one canvas per workspace, so every active
-- canvas is unambiguously the existing workspace default.
UPDATE gb_canvases
SET slug = 'main',
    is_default = (deleted_at IS NULL);

ALTER TABLE gb_canvases
  ALTER COLUMN slug SET NOT NULL,
  ALTER COLUMN is_default SET NOT NULL,
  ALTER COLUMN is_default SET DEFAULT false,
  ADD CONSTRAINT gb_canvases_slug_check CHECK (
    char_length(slug) BETWEEN 1 AND 80
    AND slug ~ '^[a-z0-9][a-z0-9-]*$'
  ),
  DROP CONSTRAINT gb_canvases_tenant_id_workspace_id_key;

CREATE UNIQUE INDEX uq_gb_canvases_active_slug
  ON gb_canvases(tenant_id, workspace_id, slug)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX uq_gb_canvases_active_default
  ON gb_canvases(tenant_id, workspace_id)
  WHERE is_default AND deleted_at IS NULL;

CREATE INDEX idx_gb_canvases_workspace_updated
  ON gb_canvases(tenant_id, workspace_id, updated_at DESC, id)
  WHERE deleted_at IS NULL;

-- Membership is authorization state, not historical identity. Preserve the
-- stable principal as provenance while allowing tenant membership removal.
ALTER TABLE gb_canvases
  DROP CONSTRAINT gb_canvases_tenant_id_created_by_principal_id_fkey,
  ADD CONSTRAINT gb_canvases_created_by_principal_id_fkey
    FOREIGN KEY (created_by_principal_id)
    REFERENCES app_principals(id) ON DELETE RESTRICT;

ALTER TABLE gb_canvas_items
  DROP CONSTRAINT gb_canvas_items_tenant_id_created_by_principal_id_fkey,
  ADD CONSTRAINT gb_canvas_items_created_by_principal_id_fkey
    FOREIGN KEY (created_by_principal_id)
    REFERENCES app_principals(id) ON DELETE RESTRICT;

ALTER TABLE gb_canvas_edges
  DROP CONSTRAINT gb_canvas_edges_tenant_id_created_by_principal_id_fkey,
  ADD CONSTRAINT gb_canvas_edges_created_by_principal_id_fkey
    FOREIGN KEY (created_by_principal_id)
    REFERENCES app_principals(id) ON DELETE RESTRICT;

ALTER TABLE gb_canvas_revisions
  DROP CONSTRAINT gb_canvas_revisions_tenant_id_created_by_principal_id_fkey,
  ADD CONSTRAINT gb_canvas_revisions_created_by_principal_id_fkey
    FOREIGN KEY (created_by_principal_id)
    REFERENCES app_principals(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM gb_canvases
     WHERE deleted_at IS NULL
     GROUP BY tenant_id, workspace_id
    HAVING count(*) FILTER (WHERE is_default) <> 1
  ) THEN
    RAISE EXCEPTION 'every active canvas workspace must have exactly one default';
  END IF;
END;
$$;
