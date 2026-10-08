ALTER TABLE gb_share_snapshots
  ADD COLUMN bundle_schema_id TEXT,
  ADD COLUMN mode TEXT,
  ADD COLUMN content_hash TEXT,
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN request_hash TEXT;

ALTER TABLE gb_share_snapshots
  DROP CONSTRAINT IF EXISTS gb_share_snapshots_target_type_check,
  DROP CONSTRAINT IF EXISTS gb_share_snapshots_access_check,
  DROP CONSTRAINT IF EXISTS gb_snapshots_creator_membership_fkey,
  ADD CONSTRAINT gb_share_snapshots_target_type_check CHECK (
    target_type IN ('surface', 'component', 'node', 'object-only', 'canvas-only')
  ),
  ADD CONSTRAINT gb_share_snapshots_access_check CHECK (
    access IN ('public-read', 'tenant-read')
  ),
  ADD CONSTRAINT gb_share_snapshots_creator_principal_fkey
    FOREIGN KEY (created_by_principal_id) REFERENCES app_principals(id) ON DELETE RESTRICT,
  ADD CONSTRAINT gb_share_snapshots_typed_bundle_check CHECK (
    (
      bundle_schema_id IS NULL
      AND mode IS NULL
      AND content_hash IS NULL
      AND idempotency_key IS NULL
      AND request_hash IS NULL
      AND target_type IN ('surface', 'component', 'node')
      AND access = 'public-read'
    )
    OR
    (
      bundle_schema_id = 'gb.share-bundle.v1'
      AND mode IN ('object-only', 'canvas-only')
      AND target_type = mode
      AND access = 'tenant-read'
      AND content_hash ~ '^sha256:[0-9a-f]{64}$'
      AND idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'
      AND request_hash ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(snapshot_json) = 'object'
      AND snapshot_json->>'schemaId' = bundle_schema_id
      AND snapshot_json->>'mode' = mode
      AND jsonb_typeof(snapshot_json->'source') = 'object'
      AND jsonb_typeof(snapshot_json->'payload') = 'object'
      AND snapshot_json - 'schemaId' - 'mode' - 'source' - 'payload' = '{}'::jsonb
      AND octet_length(snapshot_json::text) <= 8500000
    )
  );

CREATE UNIQUE INDEX uq_gb_share_snapshots_typed_idempotency
  ON gb_share_snapshots(tenant_id, idempotency_key)
  WHERE bundle_schema_id = 'gb.share-bundle.v1';

CREATE INDEX idx_gb_share_snapshots_typed_content
  ON gb_share_snapshots(tenant_id, content_hash)
  WHERE bundle_schema_id = 'gb.share-bundle.v1';

ALTER TABLE gb_share_snapshots FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION gb_reject_share_bundle_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'share bundles are append-only';
END;
$$;

DROP TRIGGER IF EXISTS gb_share_snapshots_append_only ON gb_share_snapshots;
CREATE TRIGGER gb_share_snapshots_append_only
BEFORE UPDATE OR DELETE ON gb_share_snapshots
FOR EACH ROW EXECUTE FUNCTION gb_reject_share_bundle_mutation();

DO $$
DECLARE role_name name;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles
    WHERE has_table_privilege(rolname, 'gb_share_snapshots', 'SELECT')
      AND has_table_privilege(rolname, 'gb_share_snapshots', 'INSERT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON TABLE gb_share_snapshots TO %I', role_name);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE gb_share_snapshots FROM %I', role_name);
  END LOOP;
END $$;
