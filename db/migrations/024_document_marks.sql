-- Durable reader marks are mutable projections backed by immutable revisions.
-- A mark is not a paper, representation, anchor, HAM task, or canvas item: it
-- binds authored reader state to one exact gb.anchor.v1 object. Relationships
-- to tasks use the existing append-only gb_object_links graph.

ALTER TABLE gb_document_anchors
  ADD CONSTRAINT gb_document_anchors_revision_identity_unique
  UNIQUE (tenant_id, document_revision_id, id);

CREATE TABLE gb_document_marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  document_revision_id UUID NOT NULL,
  anchor_id TEXT NOT NULL CHECK (anchor_id ~ '^sha256:[0-9a-f]{64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('highlight', 'note', 'ink')),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  current_revision_id UUID NOT NULL,
  current_content_hash TEXT NOT NULL CHECK (current_content_hash ~ '^[0-9a-f]{64}$'),
  body_markdown TEXT NOT NULL CHECK (octet_length(body_markdown) <= 65536),
  color TEXT NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  semantic_role TEXT NOT NULL CHECK (semantic_role IN ('note', 'claim', 'evidence', 'question')),
  tags TEXT[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(tags) <= 64 AND array_position(tags, NULL) IS NULL
  ),
  state TEXT NOT NULL CHECK (state IN ('active', 'resolved', 'deleted')),
  creation_idempotency_key TEXT NOT NULL CHECK (
    char_length(creation_idempotency_key) BETWEEN 8 AND 200
  ),
  creation_request_hash TEXT NOT NULL CHECK (creation_request_hash ~ '^[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, creation_idempotency_key),
  UNIQUE (tenant_id, id, current_version, current_revision_id),
  FOREIGN KEY (tenant_id, document_revision_id, anchor_id)
    REFERENCES gb_document_anchors(tenant_id, document_revision_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_document_mark_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  mark_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  body_markdown TEXT NOT NULL CHECK (octet_length(body_markdown) <= 65536),
  color TEXT NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  semantic_role TEXT NOT NULL CHECK (semantic_role IN ('note', 'claim', 'evidence', 'question')),
  tags TEXT[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(tags) <= 64 AND array_position(tags, NULL) IS NULL
  ),
  state TEXT NOT NULL CHECK (state IN ('active', 'resolved', 'deleted')),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mark_id, version),
  UNIQUE (tenant_id, mark_id, version, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, mark_id)
    REFERENCES gb_document_marks(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

ALTER TABLE gb_document_marks
  ADD CONSTRAINT gb_document_marks_current_revision_fkey
  FOREIGN KEY (tenant_id, id, current_version, current_revision_id)
  REFERENCES gb_document_mark_revisions(tenant_id, mark_id, version, id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX idx_gb_document_marks_anchor
  ON gb_document_marks(tenant_id, document_revision_id, anchor_id, created_at, id);
CREATE INDEX idx_gb_document_mark_revisions_mark
  ON gb_document_mark_revisions(tenant_id, mark_id, version DESC);

ALTER TABLE gb_document_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_document_mark_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_document_marks_tenant_isolation ON gb_document_marks
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_document_mark_revisions_tenant_isolation ON gb_document_mark_revisions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION gb_guard_document_mark_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'document marks cannot be deleted';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.id <> OLD.id
     OR NEW.document_revision_id <> OLD.document_revision_id
     OR NEW.anchor_id <> OLD.anchor_id
     OR NEW.kind <> OLD.kind
     OR NEW.creation_idempotency_key <> OLD.creation_idempotency_key
     OR NEW.creation_request_hash <> OLD.creation_request_hash
     OR NEW.created_by_principal_id <> OLD.created_by_principal_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'document mark identity is immutable';
  END IF;
  IF NEW.current_version <> OLD.current_version + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'document mark versions must advance by one';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gb_document_marks_guard
  BEFORE UPDATE OR DELETE ON gb_document_marks
  FOR EACH ROW EXECUTE FUNCTION gb_guard_document_mark_mutation();

CREATE OR REPLACE FUNCTION gb_verify_document_mark_current_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM gb_document_mark_revisions AS revision
     WHERE revision.tenant_id = NEW.tenant_id
       AND revision.mark_id = NEW.id
       AND revision.id = NEW.current_revision_id
       AND revision.version = NEW.current_version
       AND revision.content_hash = NEW.current_content_hash
       AND revision.body_markdown = NEW.body_markdown
       AND revision.color = NEW.color
       AND revision.semantic_role = NEW.semantic_role
       AND revision.tags = NEW.tags
       AND revision.state = NEW.state
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'document mark current state must match its immutable revision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER gb_document_marks_current_revision
  AFTER INSERT OR UPDATE ON gb_document_marks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gb_verify_document_mark_current_revision();

CREATE OR REPLACE FUNCTION gb_reject_document_mark_revision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'document mark revisions are append-only';
END;
$$;

CREATE TRIGGER gb_document_mark_revisions_append_only
  BEFORE UPDATE OR DELETE ON gb_document_mark_revisions
  FOR EACH ROW EXECUTE FUNCTION gb_reject_document_mark_revision_mutation();

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
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.gb_document_marks TO %I',
      runtime_role.rolname
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE public.gb_document_mark_revisions TO %I',
      runtime_role.rolname
    );
    EXECUTE format(
      'REVOKE DELETE ON TABLE public.gb_document_marks FROM %I',
      runtime_role.rolname
    );
    EXECUTE format(
      'REVOKE UPDATE, DELETE ON TABLE public.gb_document_mark_revisions FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
