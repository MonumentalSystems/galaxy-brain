-- Extend immutable assertions to reproducible code and proof referents. Existing
-- rows remain valid; new writes are additionally constrained by the API's
-- canonical-reference and provenance validators.
ALTER TABLE gb_object_links
  DROP CONSTRAINT gb_object_links_relation_check,
  ADD CONSTRAINT gb_object_links_relation_check CHECK (
    relation IN (
      'related', 'cites', 'part_of', 'derived_from', 'context_for',
      'formalized_by', 'defined_in', 'implements', 'depends_on', 'documents',
      'corresponds_to'
    )
  ),
  DROP CONSTRAINT gb_object_links_basis_check,
  ADD CONSTRAINT gb_object_links_basis_check
    CHECK (basis IN ('authored', 'imported', 'derived')),
  DROP CONSTRAINT gb_object_links_check1,
  ADD CONSTRAINT gb_object_links_provenance_basis_check CHECK (
    -- 015 rows predate source_system and cannot be rewritten because the
    -- assertion ledger is append-only. The API requires the richer shape for
    -- every new write; this first branch preserves only those historical rows.
    (NOT (provenance ? 'source_system') AND (
      (basis = 'authored' AND provenance->>'source' = 'manual') OR
      (basis = 'imported' AND provenance->>'source' = 'import' AND provenance ? 'source_ref')
    )) OR (
      jsonb_typeof(provenance->'source_system') = 'string'
      AND char_length(provenance->>'source_system') BETWEEN 1 AND 128
      AND (
        NOT (provenance ? 'confidence') OR (
          jsonb_typeof(provenance->'confidence') = 'number'
          AND (provenance->>'confidence')::numeric BETWEEN 0 AND 1
        )
      )
      AND (
        (basis = 'authored' AND provenance->>'source' = 'manual'
          AND NOT (provenance ?| ARRAY['source_snapshot', 'extractor_version', 'confidence'])) OR
        (basis = 'imported' AND provenance->>'source' = 'import'
          AND provenance ?& ARRAY['source_ref', 'source_snapshot', 'extractor_version']
          AND jsonb_typeof(provenance->'source_ref') = 'string'
          AND char_length(provenance->>'source_ref') BETWEEN 1 AND 512
          AND provenance->>'source_snapshot' ~ '^sha256:[0-9a-f]{64}$'
          AND jsonb_typeof(provenance->'extractor_version') = 'string'
          AND char_length(provenance->>'extractor_version') BETWEEN 1 AND 128) OR
        (basis = 'derived' AND provenance->>'source' = 'derivation'
          AND provenance ?& ARRAY['source_ref', 'source_snapshot', 'extractor_version']
          AND jsonb_typeof(provenance->'source_ref') = 'string'
          AND char_length(provenance->>'source_ref') BETWEEN 1 AND 512
          AND provenance->>'source_snapshot' ~ '^sha256:[0-9a-f]{64}$'
          AND jsonb_typeof(provenance->'extractor_version') = 'string'
          AND char_length(provenance->>'extractor_version') BETWEEN 1 AND 128)
      )
    )
  );

COMMENT ON COLUMN gb_object_links.provenance IS
  'Bounded assertion origin. Imported/derived rows pin a sha256 source snapshot and extractor version.';
