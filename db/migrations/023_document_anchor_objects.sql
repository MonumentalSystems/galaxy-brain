-- Promote document anchors from loose representation selectors to immutable,
-- content-addressed gb.anchor.v1 objects. Historical IDs remain stable and
-- are explicitly marked legacy; every future insert must use canonical v1.

-- Produce stable best-effort digests for historical rows. Canonical v1 hashes
-- are supplied by the shared JS/Python contract; PostgreSQL jsonb cannot
-- reproduce ECMAScript/Python number serialization for every valid float, so
-- database checks bind those hashes to the canonical ID without re-hashing.
CREATE OR REPLACE FUNCTION gb_anchor_canonical_json(value JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  value_kind TEXT := jsonb_typeof(value);
  encoded TEXT;
BEGIN
  CASE value_kind
    WHEN 'object' THEN
      SELECT '{' || COALESCE(
        string_agg(
          to_jsonb(entry.key)::text || ':' || gb_anchor_canonical_json(entry.value),
          ',' ORDER BY entry.key
        ),
        ''
      ) || '}'
        INTO encoded
        FROM jsonb_each(value) AS entry;
      RETURN encoded;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(
        string_agg(gb_anchor_canonical_json(entry.value), ',' ORDER BY entry.ordinality),
        ''
      ) || ']'
        INTO encoded
        FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(value, ordinality);
      RETURN encoded;
    WHEN 'string' THEN
      RETURN to_jsonb(value #>> '{}')::text;
    WHEN 'number' THEN
      RETURN value::text;
    WHEN 'boolean' THEN
      RETURN value::text;
    WHEN 'null' THEN
      RETURN 'null';
    ELSE
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unsupported anchor JSON value';
  END CASE;
END;
$$;

ALTER TABLE gb_document_anchors
  ADD COLUMN document_revision_id UUID,
  ADD COLUMN identity_version TEXT,
  ADD COLUMN selector_kind TEXT,
  ADD COLUMN selector_sha256 TEXT,
  ADD COLUMN anchor_sha256 TEXT;

-- The migration is the only writer permitted to enrich historical evidence.
-- Re-enable the append-only trigger immediately after the bounded backfill.
ALTER TABLE gb_document_anchors
  DISABLE TRIGGER gb_document_anchors_append_only;

UPDATE gb_document_anchors AS anchor
   SET document_revision_id = representation.document_revision_id,
       identity_version = 'legacy-v0',
       selector_kind = 'legacy',
       selector_sha256 = encode(
         digest(convert_to(gb_anchor_canonical_json(anchor.selector_json), 'UTF8'), 'sha256'),
         'hex'
       )
  FROM gb_document_representations AS representation
 WHERE representation.tenant_id = anchor.tenant_id
   AND representation.id = anchor.representation_id
   AND representation.content_sha256 = anchor.representation_sha256;

UPDATE gb_document_anchors
   SET anchor_sha256 = encode(
     digest(
       convert_to(
         gb_anchor_canonical_json(jsonb_build_object(
           'representationId', representation_id::text,
           'representationSha256', representation_sha256,
           'selector', selector_json
         )),
         'UTF8'
       ),
       'sha256'
     ),
     'hex'
   );

DROP FUNCTION gb_anchor_canonical_json(JSONB);

ALTER TABLE gb_document_anchors
  ENABLE TRIGGER gb_document_anchors_append_only;

ALTER TABLE gb_document_anchors
  DROP CONSTRAINT gb_document_anchors_selector_json_check,
  ALTER COLUMN document_revision_id SET NOT NULL,
  ALTER COLUMN identity_version SET NOT NULL,
  ALTER COLUMN identity_version SET DEFAULT 'gb.anchor.v1',
  ALTER COLUMN selector_kind SET NOT NULL,
  ALTER COLUMN selector_sha256 SET NOT NULL,
  ALTER COLUMN anchor_sha256 SET NOT NULL,
  ADD CONSTRAINT gb_document_anchors_identity_version_check CHECK (
    identity_version IN ('legacy-v0', 'gb.anchor.v1')
  ),
  ADD CONSTRAINT gb_document_anchors_selector_kind_check CHECK (
    (identity_version = 'legacy-v0' AND selector_kind = 'legacy')
    OR (
      identity_version = 'gb.anchor.v1'
      AND selector_kind = selector_json ->> 'kind'
      AND selector_kind IN ('page-region', 'text-quote', 'json-pointer')
    )
  ),
  -- jsonb text inserts insignificant spaces that are absent from the
  -- 32 KiB canonical selector wire form. Keep the storage envelope bounded
  -- while admitting every selector accepted at that canonical boundary.
  ADD CONSTRAINT gb_document_anchors_selector_json_check CHECK (
    jsonb_typeof(selector_json) = 'object'
    AND octet_length(selector_json::text) <= 65536
  ),
  ADD CONSTRAINT gb_document_anchors_selector_sha256_check CHECK (
    selector_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT gb_document_anchors_anchor_sha256_check CHECK (
    anchor_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT gb_document_anchors_canonical_id_check CHECK (
    identity_version = 'legacy-v0' OR id = 'sha256:' || anchor_sha256
  ),
  ADD CONSTRAINT gb_document_anchors_revision_representation_fkey FOREIGN KEY (
    tenant_id, document_revision_id, representation_id, representation_sha256
  ) REFERENCES gb_document_representations(
    tenant_id, document_revision_id, id, content_sha256
  ) ON DELETE RESTRICT,
  ADD CONSTRAINT gb_document_anchors_exact_identity_unique UNIQUE (
    tenant_id, document_revision_id, id, anchor_sha256
  );

CREATE UNIQUE INDEX uq_gb_document_anchors_canonical_content
  ON gb_document_anchors(tenant_id, anchor_sha256)
  WHERE identity_version = 'gb.anchor.v1';

CREATE INDEX idx_gb_document_anchors_revision_kind
  ON gb_document_anchors(tenant_id, document_revision_id, selector_kind, created_at);

CREATE OR REPLACE FUNCTION gb_reject_legacy_anchor_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.identity_version <> 'gb.anchor.v1' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new document anchors must use gb.anchor.v1 identity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gb_document_anchors_canonical_insert
  BEFORE INSERT ON gb_document_anchors
  FOR EACH ROW EXECUTE FUNCTION gb_reject_legacy_anchor_insert();

-- Existing tenant RLS and append-only enforcement continue to apply. Runtime
-- roles may create and read anchors, but cannot mutate or erase evidence.
DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user AND NOT role.rolsuper AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'INSERT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'UPDATE')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'DELETE')
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE public.gb_document_anchors TO %I',
      runtime_role.rolname
    );
    EXECUTE format(
      'REVOKE UPDATE, DELETE ON TABLE public.gb_document_anchors FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
