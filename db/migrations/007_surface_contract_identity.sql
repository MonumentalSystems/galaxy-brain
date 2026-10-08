ALTER TABLE gb_surfaces
  ADD COLUMN schema_digest TEXT,
  ADD COLUMN catalog_digest TEXT,
  ADD COLUMN renderer_version TEXT;

ALTER TABLE gb_surface_revisions
  ADD COLUMN schema_digest TEXT,
  ADD COLUMN catalog_digest TEXT,
  ADD COLUMN renderer_version TEXT;

-- Migration 006 enforced only bounded JSON and a component-name allowlist. It
-- did not validate the strict manifest introduced with this migration. Preserve
-- those rows under explicit legacy marker digests rather than falsely claiming
-- that they passed the current contract. New writes receive the active manifest
-- digests from the API after strict validation.
-- schema marker: SHA-256("gb.surface.v1:migration-006-unvalidated")
-- catalog marker: SHA-256("generous.a2ui:migration-006-unvalidated")
UPDATE gb_surfaces
SET schema_digest = 'feeb5158ab6de04573027d7e746d94429bfbf4d4eeb52df70deb1f5ddd00ef01',
    catalog_digest = 'a5284076c3e684f2c0dcfcb95c7ab6e75dd0c6d698a4f10d6fe0bbab5603f1cf',
    renderer_version = '29250eba64b8dfd89c2307a0f4a4a5193cb129fc'
WHERE schema_digest IS NULL
   OR catalog_digest IS NULL
   OR renderer_version IS NULL;

UPDATE gb_surface_revisions
SET schema_digest = 'feeb5158ab6de04573027d7e746d94429bfbf4d4eeb52df70deb1f5ddd00ef01',
    catalog_digest = 'a5284076c3e684f2c0dcfcb95c7ab6e75dd0c6d698a4f10d6fe0bbab5603f1cf',
    renderer_version = '29250eba64b8dfd89c2307a0f4a4a5193cb129fc'
WHERE schema_digest IS NULL
   OR catalog_digest IS NULL
   OR renderer_version IS NULL;

ALTER TABLE gb_surfaces
  ALTER COLUMN schema_digest SET NOT NULL,
  ALTER COLUMN catalog_digest SET NOT NULL,
  ALTER COLUMN renderer_version SET NOT NULL,
  ADD CONSTRAINT gb_surfaces_schema_digest_format
    CHECK (schema_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT gb_surfaces_catalog_digest_format
    CHECK (catalog_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT gb_surfaces_renderer_version_length
    CHECK (char_length(renderer_version) BETWEEN 1 AND 200);

ALTER TABLE gb_surface_revisions
  ALTER COLUMN schema_digest SET NOT NULL,
  ALTER COLUMN catalog_digest SET NOT NULL,
  ALTER COLUMN renderer_version SET NOT NULL,
  ADD CONSTRAINT gb_surface_revisions_schema_digest_format
    CHECK (schema_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT gb_surface_revisions_catalog_digest_format
    CHECK (catalog_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT gb_surface_revisions_renderer_version_length
    CHECK (char_length(renderer_version) BETWEEN 1 AND 200);

-- ALTER TABLE preserves the restricted runtime roles' existing table grants.
-- Assert that the migration owner did not accidentally broaden table access.
DO $$
DECLARE
  runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user
      AND NOT role.rolsuper
      AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_surface_revisions', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_surface_revisions', 'INSERT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_surface_revisions', 'UPDATE')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_surface_revisions', 'DELETE')
  LOOP
    IF NOT (
      pg_catalog.has_table_privilege(runtime_role.rolname, 'public.gb_surfaces', 'SELECT')
      AND pg_catalog.has_table_privilege(runtime_role.rolname, 'public.gb_surfaces', 'INSERT')
      AND pg_catalog.has_table_privilege(runtime_role.rolname, 'public.gb_surfaces', 'UPDATE')
      AND pg_catalog.has_table_privilege(runtime_role.rolname, 'public.gb_surfaces', 'DELETE')
    ) THEN
      RAISE EXCEPTION 'surface runtime grant mismatch for role %', runtime_role.rolname;
    END IF;
  END LOOP;
END
$$;
