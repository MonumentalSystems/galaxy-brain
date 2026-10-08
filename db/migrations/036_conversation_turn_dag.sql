-- Durable tenant-scoped conversations. Aggregate heads are version fenced;
-- revisions, turns, turn revisions, and lineage edges are append-only.

CREATE TABLE gb_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL CHECK (
    char_length(workspace_id) BETWEEN 1 AND 128
    AND workspace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  title TEXT NOT NULL CHECK (octet_length(title) BETWEEN 1 AND 240),
  goal TEXT NOT NULL CHECK (octet_length(goal) BETWEEN 1 AND 16384),
  artifact_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(artifact_refs) = 'array'
    AND jsonb_array_length(artifact_refs) <= 32
    AND octet_length(artifact_refs::text) <= 524288
  ),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(provenance) = 'object'
    AND octet_length(provenance::text) <= 16384
  ),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  current_content_hash TEXT NOT NULL CHECK (current_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL,
  creation_idempotency_key TEXT NOT NULL CHECK (
    creation_idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'
  ),
  creation_request_hash TEXT NOT NULL CHECK (creation_request_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, creation_idempotency_key),
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_conversation_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  conversation_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  parent_content_hash TEXT CHECK (parent_content_hash IS NULL OR parent_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('create', 'append', 'fork', 'join')),
  mutation_json JSONB NOT NULL CHECK (
    jsonb_typeof(mutation_json) = 'object'
    AND octet_length(mutation_json::text) <= 131072
  ),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, conversation_id, version),
  UNIQUE (tenant_id, conversation_id, idempotency_key),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES gb_conversations(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT,
  CHECK ((version = 1 AND mutation_kind = 'create' AND parent_content_hash IS NULL)
      OR (version > 1 AND mutation_kind <> 'create' AND parent_content_hash IS NOT NULL))
);

CREATE TABLE gb_conversation_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  conversation_id UUID NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 1000000),
  introduced_in_version INTEGER NOT NULL CHECK (introduced_in_version BETWEEN 2 AND 1000001),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, conversation_id, id),
  UNIQUE (tenant_id, conversation_id, id, introduced_in_version),
  UNIQUE (tenant_id, conversation_id, ordinal),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES gb_conversations(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, conversation_id, introduced_in_version)
    REFERENCES gb_conversation_revisions(tenant_id, conversation_id, version)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT,
  CHECK (ordinal = introduced_in_version - 1)
);

CREATE TABLE gb_conversation_turn_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  conversation_id UUID NOT NULL,
  turn_id UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  introduced_in_version INTEGER NOT NULL CHECK (introduced_in_version BETWEEN 2 AND 1000001),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 65536),
  artifact_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(artifact_refs) = 'array'
    AND jsonb_array_length(artifact_refs) <= 32
    AND octet_length(artifact_refs::text) <= 524288
  ),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(provenance) = 'object'
    AND octet_length(provenance::text) <= 16384
  ),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, conversation_id, turn_id, version),
  FOREIGN KEY (tenant_id, conversation_id, turn_id, introduced_in_version)
    REFERENCES gb_conversation_turns(tenant_id, conversation_id, id, introduced_in_version)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, conversation_id, introduced_in_version)
    REFERENCES gb_conversation_revisions(tenant_id, conversation_id, version)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_conversation_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  conversation_id UUID NOT NULL,
  from_turn_id UUID NOT NULL,
  to_turn_id UUID NOT NULL,
  introduced_in_version INTEGER NOT NULL CHECK (introduced_in_version BETWEEN 2 AND 1000001),
  edge_kind TEXT NOT NULL CHECK (edge_kind IN ('continues', 'forks', 'joins')),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_turn_id <> to_turn_id),
  UNIQUE (tenant_id, conversation_id, from_turn_id, to_turn_id),
  FOREIGN KEY (tenant_id, conversation_id, from_turn_id)
    REFERENCES gb_conversation_turns(tenant_id, conversation_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, conversation_id, to_turn_id, introduced_in_version)
    REFERENCES gb_conversation_turns(tenant_id, conversation_id, id, introduced_in_version)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, conversation_id, introduced_in_version)
    REFERENCES gb_conversation_revisions(tenant_id, conversation_id, version)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_conversations_workspace
  ON gb_conversations(tenant_id, workspace_id, updated_at DESC, id);
CREATE INDEX idx_gb_conversation_revisions_history
  ON gb_conversation_revisions(tenant_id, conversation_id, version DESC);
CREATE INDEX idx_gb_conversation_turns_page
  ON gb_conversation_turns(tenant_id, conversation_id, ordinal);
CREATE INDEX idx_gb_conversation_edges_from
  ON gb_conversation_edges(tenant_id, conversation_id, from_turn_id);
CREATE INDEX idx_gb_conversation_edges_to
  ON gb_conversation_edges(tenant_id, conversation_id, to_turn_id);

ALTER TABLE gb_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_conversation_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_conversation_turn_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_conversation_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE gb_conversation_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE gb_conversation_turns FORCE ROW LEVEL SECURITY;
ALTER TABLE gb_conversation_turn_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE gb_conversation_edges FORCE ROW LEVEL SECURITY;

CREATE POLICY gb_conversations_tenant_isolation ON gb_conversations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_conversation_revisions_tenant_isolation ON gb_conversation_revisions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_conversation_turns_tenant_isolation ON gb_conversation_turns
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_conversation_turn_revisions_tenant_isolation ON gb_conversation_turn_revisions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_conversation_edges_tenant_isolation ON gb_conversation_edges
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION gb_guard_conversation_head_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'conversations cannot be deleted';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.title, NEW.goal,
         NEW.artifact_refs, NEW.provenance, NEW.created_by_principal_id,
         NEW.creation_idempotency_key, NEW.creation_request_hash, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.title, OLD.goal,
         OLD.artifact_refs, OLD.provenance, OLD.created_by_principal_id,
         OLD.creation_idempotency_key, OLD.creation_request_hash, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'conversation identity and metadata are immutable';
  END IF;
  IF NEW.current_version <> OLD.current_version + 1
     OR NEW.current_content_hash = OLD.current_content_hash
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'conversation versions must advance exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION gb_reject_conversation_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'conversation records are append-only';
END;
$$;

CREATE OR REPLACE FUNCTION gb_verify_conversation_revision_chain()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE previous_hash TEXT;
BEGIN
  IF NEW.version = 1 THEN
    IF NEW.parent_content_hash IS NOT NULL OR NEW.mutation_kind <> 'create' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'conversation creation revision is invalid';
    END IF;
    RETURN NEW;
  END IF;
  SELECT revision.content_hash INTO previous_hash
    FROM gb_conversation_revisions AS revision
   WHERE revision.tenant_id = NEW.tenant_id
     AND revision.conversation_id = NEW.conversation_id
     AND revision.version = NEW.version - 1;
  IF previous_hash IS NULL OR previous_hash IS DISTINCT FROM NEW.parent_content_hash THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'conversation revision chain is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION gb_verify_conversation_head_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM gb_conversation_revisions AS revision
     WHERE revision.tenant_id = NEW.tenant_id
       AND revision.conversation_id = NEW.id
       AND revision.version = NEW.current_version
       AND revision.content_hash = NEW.current_content_hash
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'conversation head must match an immutable revision';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION gb_verify_conversation_edge_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  from_ordinal INTEGER;
  to_ordinal INTEGER;
BEGIN
  SELECT ordinal INTO from_ordinal FROM gb_conversation_turns
   WHERE tenant_id = NEW.tenant_id AND conversation_id = NEW.conversation_id AND id = NEW.from_turn_id;
  SELECT ordinal INTO to_ordinal FROM gb_conversation_turns
   WHERE tenant_id = NEW.tenant_id AND conversation_id = NEW.conversation_id AND id = NEW.to_turn_id;
  IF from_ordinal IS NULL OR to_ordinal IS NULL OR from_ordinal >= to_ordinal THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'conversation edges must point forward in the turn DAG';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION gb_assert_conversation_turn_shape(
  checked_tenant_id UUID,
  checked_conversation_id UUID,
  checked_turn_id UUID,
  checked_version INTEGER
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  revision_kind TEXT;
  revision_mutation JSONB;
  revision_creator UUID;
  revision_hash TEXT;
  head_version INTEGER;
  head_hash TEXT;
  turn_creator UUID;
  expected_kind TEXT;
  expected_count INTEGER;
  incoming_count INTEGER;
  invalid_edge_count INTEGER;
  turn_revision_count INTEGER;
BEGIN
  SELECT mutation_kind, mutation_json, created_by_principal_id, content_hash
    INTO revision_kind, revision_mutation, revision_creator, revision_hash
    FROM gb_conversation_revisions
   WHERE tenant_id = checked_tenant_id
     AND conversation_id = checked_conversation_id
     AND version = checked_version;
  IF revision_kind IS NULL OR revision_kind = 'create' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'turn must bind to its introducing conversation revision';
  END IF;

  SELECT current_version, current_content_hash INTO head_version, head_hash
    FROM gb_conversations
   WHERE tenant_id = checked_tenant_id AND id = checked_conversation_id;
  IF head_version IS DISTINCT FROM checked_version OR head_hash IS DISTINCT FROM revision_hash THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'introducing revision must be the committed conversation head';
  END IF;

  IF revision_mutation->>'turnId' IS DISTINCT FROM checked_turn_id::text
     OR jsonb_typeof(revision_mutation->'parentTurnIds') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'conversation revision does not identify its introduced turn';
  END IF;

  SELECT created_by_principal_id INTO turn_creator
    FROM gb_conversation_turns
   WHERE tenant_id = checked_tenant_id
     AND conversation_id = checked_conversation_id
     AND id = checked_turn_id
     AND introduced_in_version = checked_version;
  IF turn_creator IS NULL OR turn_creator IS DISTINCT FROM revision_creator THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'introduced turn creator must match its conversation revision';
  END IF;

  SELECT count(*) INTO turn_revision_count
    FROM gb_conversation_turn_revisions AS turn_revision
   WHERE turn_revision.tenant_id = checked_tenant_id
     AND turn_revision.conversation_id = checked_conversation_id
     AND turn_revision.turn_id = checked_turn_id
     AND turn_revision.introduced_in_version = checked_version
     AND turn_revision.created_by_principal_id = revision_creator
     AND turn_revision.role = revision_mutation #>> '{message,role}'
     AND turn_revision.content = revision_mutation #>> '{message,content}'
     AND turn_revision.artifact_refs = revision_mutation->'artifactRefs'
     AND turn_revision.provenance = revision_mutation->'provenance'
     AND turn_revision.content_hash = revision_mutation->>'turnContentHash';
  IF turn_revision_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'turn revision must exactly match its introducing conversation revision';
  END IF;

  expected_count := jsonb_array_length(revision_mutation->'parentTurnIds');
  IF revision_kind = 'append' THEN
    expected_kind := 'continues';
    IF expected_count NOT IN (0, 1) OR (expected_count = 0 AND checked_version <> 2) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'append revisions require a root or one continues parent';
    END IF;
  ELSIF revision_kind = 'fork' THEN
    expected_kind := 'forks';
    IF expected_count <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'fork revisions require exactly one forks parent';
    END IF;
  ELSIF revision_kind = 'join' THEN
    expected_kind := 'joins';
    IF expected_count NOT BETWEEN 2 AND 8 THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'join revisions require two to eight joins parents';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'turn revision has an unsupported mutation kind';
  END IF;

  SELECT count(*), count(*) FILTER (
           WHERE edge_kind <> expected_kind
              OR introduced_in_version <> checked_version
              OR created_by_principal_id <> revision_creator
         )
    INTO incoming_count, invalid_edge_count
    FROM gb_conversation_edges
   WHERE tenant_id = checked_tenant_id
     AND conversation_id = checked_conversation_id
     AND to_turn_id = checked_turn_id;
  IF incoming_count <> expected_count OR invalid_edge_count <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'turn incoming edge shape does not match its conversation revision';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM gb_conversation_edges AS edge
     WHERE edge.tenant_id = checked_tenant_id
       AND edge.conversation_id = checked_conversation_id
       AND edge.to_turn_id = checked_turn_id
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(revision_mutation->'parentTurnIds') AS parent(value)
          WHERE parent.value::uuid = edge.from_turn_id
       )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(revision_mutation->'parentTurnIds') AS parent(value)
     WHERE NOT EXISTS (
       SELECT 1
         FROM gb_conversation_edges AS edge
        WHERE edge.tenant_id = checked_tenant_id
          AND edge.conversation_id = checked_conversation_id
          AND edge.to_turn_id = checked_turn_id
          AND edge.from_turn_id = parent.value::uuid
     )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'turn parent set does not match its conversation revision';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION gb_verify_conversation_revision_turn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  introduced_turn_id UUID;
  head_version INTEGER;
  head_hash TEXT;
BEGIN
  SELECT current_version, current_content_hash INTO head_version, head_hash
    FROM gb_conversations WHERE tenant_id = NEW.tenant_id AND id = NEW.conversation_id;
  IF head_version IS DISTINCT FROM NEW.version OR head_hash IS DISTINCT FROM NEW.content_hash THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'conversation revision must be the committed aggregate head';
  END IF;
  IF NEW.mutation_kind = 'create' THEN
    RETURN NULL;
  END IF;
  IF COALESCE(NEW.mutation_json->>'turnId', '') !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'conversation revision turn identifier is invalid';
  END IF;
  introduced_turn_id := (NEW.mutation_json->>'turnId')::uuid;
  PERFORM gb_assert_conversation_turn_shape(
    NEW.tenant_id, NEW.conversation_id, introduced_turn_id, NEW.version
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION gb_verify_conversation_bound_turn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE checked_turn_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'gb_conversation_edges' THEN
    checked_turn_id := NEW.to_turn_id;
  ELSE
    checked_turn_id := NEW.turn_id;
  END IF;
  PERFORM gb_assert_conversation_turn_shape(
    NEW.tenant_id, NEW.conversation_id, checked_turn_id, NEW.introduced_in_version
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION gb_verify_conversation_bound_turn_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM gb_assert_conversation_turn_shape(
    NEW.tenant_id, NEW.conversation_id, NEW.id, NEW.introduced_in_version
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER gb_conversations_guard
BEFORE UPDATE OR DELETE ON gb_conversations
FOR EACH ROW EXECUTE FUNCTION gb_guard_conversation_head_mutation();
CREATE TRIGGER gb_conversation_revisions_append_only
BEFORE UPDATE OR DELETE ON gb_conversation_revisions
FOR EACH ROW EXECUTE FUNCTION gb_reject_conversation_ledger_mutation();
CREATE TRIGGER gb_conversation_turns_append_only
BEFORE UPDATE OR DELETE ON gb_conversation_turns
FOR EACH ROW EXECUTE FUNCTION gb_reject_conversation_ledger_mutation();
CREATE TRIGGER gb_conversation_turn_revisions_append_only
BEFORE UPDATE OR DELETE ON gb_conversation_turn_revisions
FOR EACH ROW EXECUTE FUNCTION gb_reject_conversation_ledger_mutation();
CREATE TRIGGER gb_conversation_edges_append_only
BEFORE UPDATE OR DELETE ON gb_conversation_edges
FOR EACH ROW EXECUTE FUNCTION gb_reject_conversation_ledger_mutation();
CREATE TRIGGER gb_conversation_revisions_chain
BEFORE INSERT ON gb_conversation_revisions
FOR EACH ROW EXECUTE FUNCTION gb_verify_conversation_revision_chain();
CREATE TRIGGER gb_conversation_edges_forward_only
BEFORE INSERT ON gb_conversation_edges
FOR EACH ROW EXECUTE FUNCTION gb_verify_conversation_edge_order();
CREATE CONSTRAINT TRIGGER gb_conversations_current_revision
AFTER INSERT OR UPDATE ON gb_conversations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gb_verify_conversation_head_revision();
CREATE CONSTRAINT TRIGGER gb_conversation_revisions_bound_turn
AFTER INSERT ON gb_conversation_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gb_verify_conversation_revision_turn();
CREATE CONSTRAINT TRIGGER gb_conversation_turns_revision_shape
AFTER INSERT ON gb_conversation_turns
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gb_verify_conversation_bound_turn_record();
CREATE CONSTRAINT TRIGGER gb_conversation_turn_revisions_shape
AFTER INSERT ON gb_conversation_turn_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gb_verify_conversation_bound_turn();
CREATE CONSTRAINT TRIGGER gb_conversation_edges_revision_shape
AFTER INSERT ON gb_conversation_edges
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gb_verify_conversation_bound_turn();

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname <> current_user
       AND NOT role.rolsuper
       AND NOT role.rolbypassrls
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_canvases', 'SELECT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_canvases', 'INSERT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_canvases', 'UPDATE')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.gb_conversations TO %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT ON TABLE public.gb_conversation_revisions, public.gb_conversation_turns, public.gb_conversation_turn_revisions, public.gb_conversation_edges TO %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'REVOKE DELETE, TRUNCATE ON TABLE public.gb_conversations FROM %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.gb_conversation_revisions, public.gb_conversation_turns, public.gb_conversation_turn_revisions, public.gb_conversation_edges FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
