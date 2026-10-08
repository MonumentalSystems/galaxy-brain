-- Add one explicit immutable composite share scope under a new bundle schema.
-- Existing object-only and canvas-only rows retain their closed v1 contract.

ALTER TABLE gb_share_snapshots
  DROP CONSTRAINT gb_share_snapshots_target_type_check,
  DROP CONSTRAINT gb_share_snapshots_typed_bundle_check,
  ADD CONSTRAINT gb_share_snapshots_target_type_check CHECK (
    target_type IN (
      'surface', 'component', 'node',
      'object-only', 'canvas-only', 'canvas-plus-conversation'
    )
  ),
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
      (
        (bundle_schema_id = 'gb.share-bundle.v1' AND mode IN ('object-only', 'canvas-only'))
        OR
        (bundle_schema_id = 'gb.share-bundle.v2' AND mode = 'canvas-plus-conversation')
      )
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

DROP INDEX uq_gb_share_snapshots_typed_idempotency;
CREATE UNIQUE INDEX uq_gb_share_snapshots_typed_idempotency
  ON gb_share_snapshots(tenant_id, idempotency_key)
  WHERE bundle_schema_id IN ('gb.share-bundle.v1', 'gb.share-bundle.v2');

DROP INDEX idx_gb_share_snapshots_typed_content;
CREATE INDEX idx_gb_share_snapshots_typed_content
  ON gb_share_snapshots(tenant_id, content_hash)
  WHERE bundle_schema_id IN ('gb.share-bundle.v1', 'gb.share-bundle.v2');
