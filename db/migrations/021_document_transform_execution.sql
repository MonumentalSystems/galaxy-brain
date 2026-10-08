-- Bind one externally visible idempotency key to the primary immutable
-- receipt for a durable document transform. Fallback child receipts remain
-- linked through fallback_receipt_id and intentionally carry no request key.

ALTER TABLE gb_transform_receipts
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN request_sha256 TEXT,
  ADD CONSTRAINT gb_transform_receipts_idempotency_pair CHECK (
    (idempotency_key IS NULL AND request_sha256 IS NULL)
    OR (
      idempotency_key IS NOT NULL
      AND char_length(idempotency_key) BETWEEN 8 AND 200
      AND idempotency_key ~ '^[!-~]+$'
      AND request_sha256 IS NOT NULL
      AND request_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT gb_transform_receipts_idempotency_unique
    UNIQUE (tenant_id, idempotency_key);
