-- Atomic proof-mission activation. Passive repository fields remain durable,
-- browseable structure; only this migration-owned function may turn one exact
-- source graph, mission intent, and verification baseline into a claimable
-- mission workspace.

-- Migration 027 could not faithfully project future non-empty baselines because
-- it omitted two already-validated adapter outputs. No non-empty record can
-- exist yet (the adapter allowlist is deliberately empty), so these columns can
-- be made mandatory without rewriting historical evidence.
ALTER TABLE gb_proof_verification_records
  ADD COLUMN verifier_system TEXT NOT NULL CHECK (
    verifier_system IN ('hyades', 'lean-replay')
  ),
  ADD COLUMN verification_method TEXT NOT NULL CHECK (
    verification_method IN ('hyades-run', 'lean-replay')
    AND (
      (verifier_system = 'hyades' AND verification_method = 'hyades-run')
      OR
      (verifier_system = 'lean-replay' AND verification_method = 'lean-replay')
    )
  ),
  ADD CONSTRAINT gb_proof_verification_records_provider_method_check CHECK (
    (verifier_system = 'hyades' AND provider_run_ref IS NOT NULL)
    OR
    (verifier_system = 'lean-replay' AND provider_run_ref IS NULL)
  );

CREATE TABLE gb_proof_mission_activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  source_graph_id TEXT NOT NULL CHECK (
    char_length(source_graph_id) BETWEEN 1 AND 512
    AND source_graph_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  source_graph_sha256 TEXT NOT NULL CHECK (source_graph_sha256 ~ '^[0-9a-f]{64}$'),
  mission_intent_artifact_id UUID NOT NULL,
  mission_intent_sha256 TEXT NOT NULL CHECK (mission_intent_sha256 ~ '^[0-9a-f]{64}$'),
  mission_intent_json JSONB NOT NULL CHECK (
    jsonb_typeof(mission_intent_json) = 'object'
    AND octet_length(mission_intent_json::text) BETWEEN 2 AND 65536
  ),
  mission_graph_id TEXT NOT NULL CHECK (
    char_length(mission_graph_id) BETWEEN 1 AND 512
    AND mission_graph_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  mission_graph_sha256 TEXT NOT NULL CHECK (mission_graph_sha256 ~ '^[0-9a-f]{64}$'),
  verification_set_id UUID NOT NULL,
  verification_set_sha256 TEXT NOT NULL CHECK (verification_set_sha256 ~ '^[0-9a-f]{64}$'),
  workspace_id UUID NOT NULL,
  workspace_key TEXT NOT NULL CHECK (
    char_length(workspace_key) BETWEEN 1 AND 512
    AND workspace_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  main_target_id TEXT NOT NULL CHECK (
    char_length(main_target_id) BETWEEN 1 AND 512
    AND main_target_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  curated_milestone_target_ids TEXT[] NOT NULL CHECK (
    cardinality(curated_milestone_target_ids) BETWEEN 0 AND 500
    AND array_position(curated_milestone_target_ids, NULL) IS NULL
    AND gb_text_array_is_unique(curated_milestone_target_ids)
  ),
  target_ids TEXT[] NOT NULL CHECK (
    cardinality(target_ids) BETWEEN 1 AND 2000
    AND array_position(target_ids, NULL) IS NULL
    AND gb_text_array_is_unique(target_ids)
  ),
  inherited_verified_node_ids TEXT[] NOT NULL CHECK (
    cardinality(inherited_verified_node_ids) BETWEEN 0 AND 2000
    AND array_position(inherited_verified_node_ids, NULL) IS NULL
    AND gb_text_array_is_unique(inherited_verified_node_ids)
  ),
  initial_frontier_node_ids TEXT[] NOT NULL CHECK (
    cardinality(initial_frontier_node_ids) BETWEEN 0 AND 2000
    AND array_position(initial_frontier_node_ids, NULL) IS NULL
    AND gb_text_array_is_unique(initial_frontier_node_ids)
  ),
  activated_by_principal_id UUID NOT NULL,
  activated_by_nostr_pubkey TEXT NOT NULL CHECK (
    activated_by_nostr_pubkey ~ '^[0-9a-f]{64}$'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, workspace_id),
  UNIQUE (tenant_id, workspace_key),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, source_graph_id, source_graph_sha256)
    REFERENCES gb_proof_graphs(tenant_id, graph_id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, mission_intent_artifact_id, mission_intent_sha256)
    REFERENCES gb_artifacts(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, mission_graph_id, mission_graph_sha256)
    REFERENCES gb_proof_graphs(tenant_id, graph_id, content_sha256)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, verification_set_id, verification_set_sha256)
    REFERENCES gb_proof_verification_sets(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES gb_proof_workspaces(tenant_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, activated_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT,
  CHECK (main_target_id = ANY(target_ids)),
  CHECK (curated_milestone_target_ids <@ target_ids),
  CHECK (inherited_verified_node_ids <@ target_ids),
  CHECK (initial_frontier_node_ids <@ target_ids)
);

-- This is the immutable initial projection. It records why a node was complete,
-- available, or still prerequisite-bound at activation time. Mutable claims,
-- runs, candidates, and later proof transitions remain in the existing work
-- state tables and never rewrite this snapshot.
CREATE TABLE gb_proof_mission_activation_nodes (
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  activation_id UUID NOT NULL,
  node_id TEXT NOT NULL CHECK (
    char_length(node_id) BETWEEN 1 AND 512
    AND node_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  prerequisite_node_ids TEXT[] NOT NULL CHECK (
    cardinality(prerequisite_node_ids) BETWEEN 0 AND 2000
    AND array_position(prerequisite_node_ids, NULL) IS NULL
    AND gb_text_array_is_unique(prerequisite_node_ids)
  ),
  initial_proof_status TEXT NOT NULL CHECK (initial_proof_status IN ('open', 'verified')),
  initial_frontier_status TEXT NOT NULL CHECK (
    initial_frontier_status IN ('complete', 'available', 'prerequisites')
  ),
  verification_set_id UUID,
  verification_node_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, activation_id, node_id),
  FOREIGN KEY (tenant_id, activation_id)
    REFERENCES gb_proof_mission_activations(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, verification_set_id, verification_node_id)
    REFERENCES gb_proof_verification_records(tenant_id, verification_set_id, node_id)
    ON DELETE RESTRICT,
  CHECK (
    (initial_proof_status = 'verified'
      AND initial_frontier_status = 'complete'
      AND verification_set_id IS NOT NULL
      AND verification_node_id = node_id)
    OR
    (initial_proof_status = 'open'
      AND initial_frontier_status IN ('available', 'prerequisites')
      AND verification_set_id IS NULL
      AND verification_node_id IS NULL)
  )
);

CREATE INDEX idx_gb_proof_mission_activations_source
  ON gb_proof_mission_activations(
    tenant_id, source_graph_id, source_graph_sha256, activated_at DESC
  );
CREATE INDEX idx_gb_proof_mission_activation_nodes_frontier
  ON gb_proof_mission_activation_nodes(
    tenant_id, activation_id, initial_frontier_status, node_id
  );

ALTER TABLE gb_proof_mission_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_proof_mission_activation_nodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_proof_mission_activations_tenant_isolation
  ON gb_proof_mission_activations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY gb_proof_mission_activation_nodes_tenant_isolation
  ON gb_proof_mission_activation_nodes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION gb_reject_proof_mission_activation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'proof mission activations are append-only';
END;
$$;

CREATE TRIGGER gb_proof_mission_activations_append_only
BEFORE UPDATE OR DELETE ON gb_proof_mission_activations
FOR EACH ROW EXECUTE FUNCTION gb_reject_proof_mission_activation_mutation();

CREATE TRIGGER gb_proof_mission_activation_nodes_append_only
BEFORE UPDATE OR DELETE ON gb_proof_mission_activation_nodes
FOR EACH ROW EXECUTE FUNCTION gb_reject_proof_mission_activation_mutation();

-- Direct proof-graph registration remains available only for passive
-- repository fields. A mission row must have a matching activation record,
-- which runtime roles cannot insert directly.
CREATE OR REPLACE FUNCTION gb_guard_activated_proof_graph_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.graph_kind = 'repository-field' THEN
    RETURN NEW;
  END IF;
  IF NEW.graph_kind <> 'mission' OR NOT EXISTS (
    SELECT 1
      FROM gb_proof_mission_activations AS activation
     WHERE activation.tenant_id = NEW.tenant_id
       AND activation.mission_graph_id = NEW.graph_id
       AND activation.mission_graph_sha256 = NEW.content_sha256
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'claimable proof graphs require atomic mission activation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gb_proof_graphs_activation_guard
BEFORE INSERT ON gb_proof_graphs
FOR EACH ROW EXECUTE FUNCTION gb_guard_activated_proof_graph_insert();

-- Replace migration 026's unconditional gate with an exact activation gate.
-- The registered-graph and immutable-binding guard from migration 025 remains
-- active and independently validates the mission target set.
CREATE OR REPLACE FUNCTION gb_reject_unactivated_proof_workspace_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM gb_proof_mission_activations AS activation
     WHERE activation.tenant_id = NEW.tenant_id
       AND activation.workspace_id = NEW.id
       AND activation.workspace_key = NEW.workspace_key
       AND activation.mission_graph_id = NEW.graph_id
       AND activation.mission_graph_sha256 = NEW.graph_content_sha256
       AND activation.target_ids = NEW.node_ids
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'proof workspace activation requires an accepted proof baseline';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION gb_text_array_sorted_c(values_to_sort TEXT[])
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT COALESCE(array_agg(value ORDER BY value COLLATE "C"), '{}')
    FROM unnest(values_to_sort) AS item(value)
$$;

CREATE OR REPLACE FUNCTION gb_verify_proof_mission_activation_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  persisted_node_ids TEXT[];
  persisted_verified_ids TEXT[];
  persisted_frontier_ids TEXT[];
  persisted_item_verified_ids TEXT[];
BEGIN
  SELECT COALESCE(array_agg(node.node_id ORDER BY node.node_id COLLATE "C"), '{}'),
         COALESCE(array_agg(node.node_id ORDER BY node.node_id COLLATE "C")
           FILTER (WHERE node.initial_proof_status = 'verified'), '{}'),
         COALESCE(array_agg(node.node_id ORDER BY node.node_id COLLATE "C")
           FILTER (WHERE node.initial_frontier_status = 'available'), '{}')
    INTO persisted_node_ids, persisted_verified_ids, persisted_frontier_ids
    FROM gb_proof_mission_activation_nodes AS node
   WHERE node.tenant_id = NEW.tenant_id
     AND node.activation_id = NEW.id;

  SELECT COALESCE(array_agg(item.node_id ORDER BY item.node_id COLLATE "C"), '{}')
    INTO persisted_item_verified_ids
    FROM gb_proof_work_items AS item
   WHERE item.tenant_id = NEW.tenant_id
     AND item.workspace_id = NEW.workspace_id
     AND item.state #>> '{proof,status}' = 'verified'
     AND item.state #>> '{proof,verification,verification_set_sha256}'
         = NEW.verification_set_sha256;

  IF persisted_node_ids <> gb_text_array_sorted_c(NEW.target_ids)
     OR persisted_verified_ids <> gb_text_array_sorted_c(NEW.inherited_verified_node_ids)
     OR persisted_frontier_ids <> gb_text_array_sorted_c(NEW.initial_frontier_node_ids)
     OR persisted_item_verified_ids <> gb_text_array_sorted_c(NEW.inherited_verified_node_ids)
     OR EXISTS (
       SELECT 1 FROM gb_proof_mission_activation_nodes AS node
        WHERE node.tenant_id = NEW.tenant_id
          AND node.activation_id = NEW.id
          AND NOT node.prerequisite_node_ids <@ NEW.target_ids
     )
     OR NOT EXISTS (
       SELECT 1 FROM gb_proof_workspaces AS workspace
        WHERE workspace.tenant_id = NEW.tenant_id
          AND workspace.id = NEW.workspace_id
          AND workspace.workspace_key = NEW.workspace_key
          AND workspace.graph_id = NEW.mission_graph_id
          AND workspace.graph_content_sha256 = NEW.mission_graph_sha256
          AND workspace.node_ids = NEW.target_ids
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'proof mission activation is incomplete';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER gb_proof_mission_activation_complete
AFTER INSERT ON gb_proof_mission_activations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gb_verify_proof_mission_activation_complete();

-- Server payload assumption: the caller has already stored the exact canonical
-- intent bytes and exact canonical mission DAG bytes in gb_artifacts. The
-- function receives those immutable artifact IDs/hashes plus their parsed JSON;
-- it rechecks every binding before writing any claimable state.
CREATE OR REPLACE FUNCTION gb_python_trim(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT regexp_replace(
    value,
    U&'^[\0009-\000D\001C-\0020\0085\00A0\1680\2000-\200A\2028-\2029\202F\205F\3000]+|[\0009-\000D\001C-\0020\0085\00A0\1680\2000-\200A\2028-\2029\202F\205F\3000]+$',
    '',
    'g'
  )
$$;

-- ECMAScript Array.prototype.sort compares strings by UTF-16 code units.
-- PostgreSQL's C collation compares UTF-8 bytes, which differs for valid
-- non-BMP/BMP pairs such as U+10000 and U+E000. Mission relation ordering is
-- part of the canonical JSON and therefore must use the browser's ordering.
CREATE OR REPLACE FUNCTION gb_js_utf16_sort_key(value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  character_index INTEGER;
  code_point INTEGER;
  scalar_value INTEGER;
  sort_key TEXT := '';
BEGIN
  FOR character_index IN 1..char_length(value) LOOP
    code_point := ascii(substr(value, character_index, 1));
    IF code_point <= 65535 THEN
      sort_key := sort_key || lpad(to_hex(code_point), 4, '0');
    ELSE
      scalar_value := code_point - 65536;
      sort_key := sort_key
        || lpad(to_hex(55296 + (scalar_value >> 10)), 4, '0')
        || lpad(to_hex(56320 + (scalar_value & 1023)), 4, '0');
    END IF;
  END LOOP;
  RETURN sort_key;
END;
$$;

CREATE OR REPLACE FUNCTION gb_js_utf16_length(value TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  character_index INTEGER;
  result INTEGER := 0;
BEGIN
  FOR character_index IN 1..char_length(value) LOOP
    result := result + CASE
      WHEN ascii(substr(value, character_index, 1)) <= 65535 THEN 1
      ELSE 2
    END;
  END LOOP;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION gb_mission_text_valid(
  value JSONB,
  maximum_utf16_length INTEGER,
  required BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  normalized TEXT;
BEGIN
  IF value IS NULL OR value = 'null'::jsonb THEN
    RETURN NOT required;
  END IF;
  IF jsonb_typeof(value) <> 'string' THEN
    RETURN FALSE;
  END IF;
  normalized := gb_python_trim(value #>> '{}');
  RETURN (NOT required OR normalized <> '')
    AND gb_js_utf16_length(normalized) <= maximum_utf16_length;
END;
$$;

CREATE OR REPLACE FUNCTION gb_mission_text_array_valid(
  value JSONB,
  nullable BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item_count INTEGER;
  unique_count INTEGER;
BEGIN
  IF value IS NULL OR value = 'null'::jsonb THEN
    RETURN nullable;
  END IF;
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > 2000 THEN
    RETURN FALSE;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(value) AS item(element)
     WHERE NOT gb_mission_text_valid(item.element, 512, TRUE)
  ) THEN
    RETURN FALSE;
  END IF;
  SELECT count(*), count(DISTINCT gb_python_trim(item.element #>> '{}'))
    INTO item_count, unique_count
    FROM jsonb_array_elements(value) AS item(element);
  RETURN item_count = unique_count;
END;
$$;

CREATE OR REPLACE FUNCTION gb_proof_mission_source_metadata_valid(source_graph JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  target JSONB;
  relation JSONB;
  binding JSONB;
  correspondence JSONB;
  nomination JSONB;
  step JSONB;
  dependency_kind_count INTEGER;
BEGIN
  FOR target IN SELECT value FROM jsonb_array_elements(source_graph -> 'targets')
  LOOP
    IF NOT gb_mission_text_valid(target -> 'target_kind', 120, FALSE)
       OR NOT gb_mission_text_valid(target -> 'title', 200, FALSE)
       OR NOT gb_mission_text_valid(target -> 'natural_language_summary', 4000, FALSE)
       OR NOT gb_mission_text_valid(target -> 'category', 120, FALSE)
       OR (target ? 'source_id' AND NOT gb_mission_text_valid(target -> 'source_id', 512, TRUE))
       OR (target ? 'source_label' AND NOT gb_mission_text_valid(target -> 'source_label', 1000, TRUE)) THEN
      RETURN FALSE;
    END IF;

    binding := target -> 'formal_binding';
    IF binding IS NULL OR binding = 'null'::jsonb THEN
      binding := '{}'::jsonb;
    ELSIF jsonb_typeof(binding) <> 'object' THEN
      RETURN FALSE;
    END IF;
    IF NOT gb_mission_text_valid(binding -> 'status', 120, FALSE)
       OR (binding ? 'binding_kind' AND NOT gb_mission_text_valid(binding -> 'binding_kind', 120, TRUE))
       OR (binding ? 'mapping_rule' AND NOT gb_mission_text_valid(binding -> 'mapping_rule', 4000, TRUE))
       OR (binding ? 'module_ids' AND NOT gb_mission_text_array_valid(binding -> 'module_ids'))
       OR (binding ? 'declaration_ids' AND NOT gb_mission_text_array_valid(binding -> 'declaration_ids'))
       OR (binding ? 'declaration_equivalence_claimed'
           AND jsonb_typeof(binding -> 'declaration_equivalence_claimed') <> 'boolean') THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  FOR relation IN SELECT value FROM jsonb_array_elements(source_graph -> 'relations')
  LOOP
    IF (relation ? 'source_edge_id'
        AND NOT gb_mission_text_valid(relation -> 'source_edge_id', 512, TRUE))
       OR (relation ? 'assertion_level'
           AND NOT gb_mission_text_valid(relation -> 'assertion_level', 120, TRUE)) THEN
      RETURN FALSE;
    END IF;

    IF relation ? 'formal_correspondence' THEN
      correspondence := relation -> 'formal_correspondence';
      IF jsonb_typeof(correspondence) <> 'object'
         OR NOT gb_mission_text_valid(correspondence -> 'status', 120, TRUE)
         OR NOT correspondence ? 'support_kind'
         OR NOT correspondence ? 'declaration_path'
         OR NOT correspondence ? 'dependency_kinds_by_step'
         OR NOT (
           correspondence -> 'support_kind' = 'null'::jsonb
           OR gb_mission_text_valid(correspondence -> 'support_kind', 120, TRUE)
         )
         OR NOT gb_mission_text_array_valid(
           correspondence -> 'declaration_path', TRUE
         )
         OR jsonb_typeof(correspondence -> 'dependency_kinds_by_step') <> 'array'
         OR jsonb_array_length(correspondence -> 'dependency_kinds_by_step') > 2000 THEN
        RETURN FALSE;
      END IF;
      dependency_kind_count := 0;
      FOR step IN
        SELECT value FROM jsonb_array_elements(
          correspondence -> 'dependency_kinds_by_step'
        )
      LOOP
        IF NOT gb_mission_text_array_valid(step) THEN
          RETURN FALSE;
        END IF;
        dependency_kind_count := dependency_kind_count + jsonb_array_length(step);
        IF dependency_kind_count > 2000 THEN
          RETURN FALSE;
        END IF;
      END LOOP;
    END IF;

    nomination := relation -> 'bridge_nomination';
    IF nomination IS NOT NULL AND nomination <> 'null'::jsonb THEN
      IF jsonb_typeof(nomination) <> 'object'
         OR NOT nomination ? 'nominated'
         OR jsonb_typeof(nomination -> 'nominated') <> 'boolean'
         OR NOT gb_mission_text_valid(nomination -> 'reason', 4000, TRUE) THEN
        RETURN FALSE;
      END IF;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION gb_jsonb_trimmed_text_array(value JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT COALESCE(
    jsonb_agg(to_jsonb(gb_python_trim(item.value)) ORDER BY item.ordinality),
    '[]'::jsonb
  )
    FROM jsonb_array_elements_text(value)
         WITH ORDINALITY AS item(value, ordinality)
$$;

CREATE OR REPLACE FUNCTION gb_jsonb_trimmed_text_matrix(value JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT COALESCE(
    jsonb_agg(gb_jsonb_trimmed_text_array(item.value) ORDER BY item.ordinality),
    '[]'::jsonb
  )
    FROM jsonb_array_elements(value)
         WITH ORDINALITY AS item(value, ordinality)
$$;

CREATE OR REPLACE FUNCTION gb_proof_mission_target_projection(source_target JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  WITH binding AS (
    SELECT CASE
      WHEN jsonb_typeof(source_target -> 'formal_binding') = 'object'
        THEN source_target -> 'formal_binding'
      ELSE '{}'::jsonb
    END AS value
  )
  SELECT jsonb_build_object(
      'target_id', gb_python_trim(source_target ->> 'target_id'),
      'target_kind', gb_python_trim(COALESCE(source_target ->> 'target_kind', '')),
      'title', COALESCE(
        NULLIF(gb_python_trim(source_target ->> 'title'), ''),
        gb_python_trim(source_target ->> 'target_id')
      ),
      'natural_language_summary', gb_python_trim(COALESCE(source_target ->> 'natural_language_summary', '')),
      'category', gb_python_trim(COALESCE(source_target ->> 'category', ''))
    )
    || CASE WHEN source_target ? 'source_id'
      THEN jsonb_build_object('source_id', gb_python_trim(source_target ->> 'source_id'))
      ELSE '{}'::jsonb END
    || CASE WHEN source_target ? 'source_label'
      THEN jsonb_build_object('source_label', gb_python_trim(source_target ->> 'source_label'))
      ELSE '{}'::jsonb END
    || jsonb_build_object(
      'formal_binding',
      jsonb_build_object('status', gb_python_trim(COALESCE(binding.value ->> 'status', '')))
      || CASE WHEN binding.value ? 'binding_kind'
        THEN jsonb_build_object('binding_kind', gb_python_trim(binding.value ->> 'binding_kind'))
        ELSE '{}'::jsonb END
      || CASE WHEN binding.value ? 'mapping_rule'
        THEN jsonb_build_object('mapping_rule', gb_python_trim(binding.value ->> 'mapping_rule'))
        ELSE '{}'::jsonb END
      || CASE WHEN binding.value ? 'module_ids'
        THEN jsonb_build_object(
          'module_ids', gb_jsonb_trimmed_text_array(binding.value -> 'module_ids')
        ) ELSE '{}'::jsonb END
      || CASE WHEN binding.value ? 'declaration_ids'
        THEN jsonb_build_object(
          'declaration_ids', gb_jsonb_trimmed_text_array(binding.value -> 'declaration_ids')
        ) ELSE '{}'::jsonb END
      || CASE WHEN binding.value ? 'declaration_equivalence_claimed'
        THEN jsonb_build_object(
          'declaration_equivalence_claimed',
          binding.value -> 'declaration_equivalence_claimed'
        ) ELSE '{}'::jsonb END
    )
  FROM binding
$$;

CREATE OR REPLACE FUNCTION gb_proof_mission_relation_projection(source_relation JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT jsonb_build_object(
      'relation_id', gb_python_trim(source_relation ->> 'relation_id'),
      'relation_type', gb_python_trim(source_relation ->> 'relation_type'),
      'prerequisite_target_id', gb_python_trim(source_relation ->> 'prerequisite_target_id'),
      'dependent_target_id', gb_python_trim(source_relation ->> 'dependent_target_id')
    )
    || CASE WHEN source_relation ? 'source_edge_id'
      THEN jsonb_build_object('source_edge_id', gb_python_trim(source_relation ->> 'source_edge_id'))
      ELSE '{}'::jsonb END
    || CASE WHEN source_relation ? 'assertion_level'
      THEN jsonb_build_object('assertion_level', gb_python_trim(source_relation ->> 'assertion_level'))
      ELSE '{}'::jsonb END
    || CASE WHEN source_relation ? 'formal_correspondence'
      THEN jsonb_build_object(
        'formal_correspondence',
        jsonb_build_object(
          'status', gb_python_trim(source_relation #>> '{formal_correspondence,status}'),
          'support_kind', CASE
            WHEN source_relation #> '{formal_correspondence,support_kind}' = 'null'::jsonb
              THEN 'null'::jsonb
            ELSE to_jsonb(gb_python_trim(source_relation #>> '{formal_correspondence,support_kind}'))
          END,
          'declaration_path', CASE
            WHEN source_relation #> '{formal_correspondence,declaration_path}' = 'null'::jsonb
              THEN 'null'::jsonb
            ELSE gb_jsonb_trimmed_text_array(
              source_relation #> '{formal_correspondence,declaration_path}'
            )
          END,
          'dependency_kinds_by_step', gb_jsonb_trimmed_text_matrix(
            source_relation #> '{formal_correspondence,dependency_kinds_by_step}'
          )
        )
      ) ELSE '{}'::jsonb END
    || CASE WHEN jsonb_typeof(source_relation -> 'bridge_nomination') = 'object'
      THEN jsonb_build_object(
        'bridge_nomination', jsonb_build_object(
          'nominated', source_relation #> '{bridge_nomination,nominated}',
          'reason', gb_python_trim(source_relation #>> '{bridge_nomination,reason}')
        )
      ) ELSE '{}'::jsonb END
$$;

CREATE OR REPLACE FUNCTION gb_expected_proof_mission_graph(
  source_graph JSONB,
  mission_intent JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  main_target_id TEXT := mission_intent ->> 'main_target_id';
  mission_id TEXT := mission_intent ->> 'mission_id';
  selected_target_ids TEXT[];
  milestone_ids TEXT[];
  selected_targets JSONB;
  selected_relations JSONB;
  selected_relation_ids TEXT[];
  mission_title TEXT;
  milestone_id TEXT;
  generated_index INTEGER := 1;
  generated_relation_id TEXT;
BEGIN
  WITH RECURSIVE prerequisite_closure(target_id) AS (
    SELECT main_target_id
    UNION
    SELECT gb_python_trim(relation.value ->> 'prerequisite_target_id')
      FROM prerequisite_closure AS closure
      JOIN LATERAL jsonb_array_elements(source_graph -> 'relations') AS relation(value)
        ON gb_python_trim(relation.value ->> 'dependent_target_id') = closure.target_id
       AND gb_python_trim(relation.value ->> 'relation_type') IN (
         'DEPENDS_ON', 'REDUCES_TO', 'USES', 'AUTHORED_PREREQUISITE'
       )
  )
  SELECT COALESCE(array_agg(target_id ORDER BY target_id COLLATE "C"), '{}')
    INTO selected_target_ids
    FROM prerequisite_closure;

  SELECT COALESCE(array_agg(value ORDER BY value COLLATE "C"), '{}')
    INTO milestone_ids
    FROM jsonb_array_elements_text(
      mission_intent -> 'curated_milestone_target_ids'
    ) AS item(value);

  SELECT COALESCE(
           jsonb_agg(
             gb_proof_mission_target_projection(target.value)
             ORDER BY gb_python_trim(target.value ->> 'target_id') COLLATE "C"
           ),
           '[]'::jsonb
         )
    INTO selected_targets
    FROM jsonb_array_elements(source_graph -> 'targets') AS target(value)
   WHERE gb_python_trim(target.value ->> 'target_id') = ANY(selected_target_ids);

  SELECT gb_proof_mission_target_projection(target.value) ->> 'title'
    INTO mission_title
    FROM jsonb_array_elements(source_graph -> 'targets') AS target(value)
   WHERE gb_python_trim(target.value ->> 'target_id') = main_target_id
   LIMIT 1;

  SELECT COALESCE(
           jsonb_agg(
             gb_proof_mission_relation_projection(relation.value)
             ORDER BY gb_python_trim(relation.value ->> 'relation_id') COLLATE "C"
           ),
           '[]'::jsonb
         ),
         COALESCE(
           array_agg(
             gb_python_trim(relation.value ->> 'relation_id')
             ORDER BY gb_python_trim(relation.value ->> 'relation_id') COLLATE "C"
           ),
           '{}'
         )
    INTO selected_relations, selected_relation_ids
    FROM jsonb_array_elements(source_graph -> 'relations') AS relation(value)
   WHERE gb_python_trim(relation.value ->> 'prerequisite_target_id') = ANY(selected_target_ids)
     AND gb_python_trim(relation.value ->> 'dependent_target_id') = ANY(selected_target_ids);

  FOR milestone_id IN
    SELECT value FROM unnest(milestone_ids) AS milestone(value)
     ORDER BY value COLLATE "C"
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(selected_relations) AS relation(value)
       WHERE relation.value ->> 'relation_type' = 'MILESTONE_OF'
         AND relation.value ->> 'prerequisite_target_id' = milestone_id
         AND relation.value ->> 'dependent_target_id' = main_target_id
    ) THEN
      LOOP
        generated_relation_id := 'mission-milestone-'
          || lpad(generated_index::text, 6, '0');
        generated_index := generated_index + 1;
        EXIT WHEN NOT generated_relation_id = ANY(selected_relation_ids);
      END LOOP;
      selected_relation_ids := array_append(
        selected_relation_ids, generated_relation_id
      );
      selected_relations := selected_relations || jsonb_build_array(
        jsonb_build_object(
          'relation_id', generated_relation_id,
          'relation_type', 'MILESTONE_OF',
          'prerequisite_target_id', milestone_id,
          'dependent_target_id', main_target_id
        )
      );
    END IF;
  END LOOP;

  SELECT COALESCE(
           jsonb_agg(
             relation.value
             ORDER BY gb_js_utf16_sort_key(relation.value ->> 'relation_id') COLLATE "C"
           ),
           '[]'::jsonb
         )
    INTO selected_relations
    FROM jsonb_array_elements(selected_relations) AS relation(value);

  RETURN jsonb_build_object(
    'schema_id', 'galaxy.proof-dag.v1',
    'graph_id', mission_id,
    'graph_kind', 'mission',
    'title', COALESCE(NULLIF(mission_title, ''), main_target_id),
    'mission', jsonb_build_object(
      'main_target_id', main_target_id,
      'curated_milestone_target_ids', to_jsonb(milestone_ids)
    ),
    'provenance', jsonb_build_object(
      'source_graph', mission_intent -> 'source_graph',
      'compiler', 'galaxy.proof-mission-compiler.v1'
    ),
    'targets', selected_targets,
    'relations', selected_relations
  );
END;
$$;

CREATE OR REPLACE FUNCTION gb_activate_proof_mission(
  p_tenant_id UUID,
  p_source_graph_id TEXT,
  p_source_graph_sha256 TEXT,
  p_mission_intent_artifact_id UUID,
  p_mission_intent_sha256 TEXT,
  p_mission_intent_json JSONB,
  p_mission_graph_artifact_id UUID,
  p_mission_graph_sha256 TEXT,
  p_mission_graph_json JSONB,
  p_verification_set_id UUID,
  p_verification_set_sha256 TEXT,
  p_workspace_key TEXT,
  p_activated_by_principal_id UUID,
  p_activated_by_nostr_pubkey TEXT,
  p_idempotency_key TEXT,
  p_request_sha256 TEXT
)
RETURNS TABLE (
  activation_id UUID,
  workspace_id UUID,
  mission_graph_id TEXT,
  mission_graph_content_sha256 TEXT,
  replayed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tenant_context UUID;
  principal_context UUID;
  source_graph RECORD;
  verification_set RECORD;
  intent_artifact RECORD;
  mission_artifact RECORD;
  existing RECORD;
  new_activation_id UUID := gen_random_uuid();
  new_workspace_id UUID := gen_random_uuid();
  derived_mission_graph_id TEXT;
  derived_title TEXT;
  derived_main_target_id TEXT;
  derived_milestones TEXT[];
  derived_target_ids TEXT[];
  expected_target_ids TEXT[];
  expected_mission_graph JSONB;
  derived_node_ref_ids TEXT[];
  derived_verified_ids TEXT[];
  derived_frontier_ids TEXT[];
BEGIN
  BEGIN
    tenant_context := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
    principal_context := NULLIF(current_setting('app.principal_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'proof mission activation identity context is invalid';
  END;
  IF tenant_context IS NULL OR tenant_context IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'proof mission activation tenant mismatch';
  END IF;
  IF principal_context IS NULL
     OR principal_context IS DISTINCT FROM p_activated_by_principal_id
     OR NOT EXISTS (
       SELECT 1
         FROM public.app_principals AS principal
         JOIN public.app_tenant_memberships AS membership
           ON membership.principal_id = principal.id
          AND membership.tenant_id = p_tenant_id
        WHERE principal.id = principal_context
          AND principal.status = 'active'
          AND (
            (principal.kind = 'agent' AND EXISTS (
              SELECT 1 FROM public.app_agents AS agent
               WHERE agent.principal_id = principal.id
                 AND agent.tenant_id = p_tenant_id
                 AND agent.nostr_pubkey = p_activated_by_nostr_pubkey
            ))
            OR
            (principal.kind = 'human' AND EXISTS (
              SELECT 1
                FROM public.app_users AS app_user
                JOIN public.app_nostr_keys AS nostr_key
                  ON nostr_key.user_id = app_user.id
               WHERE app_user.principal_id = principal.id
                 AND nostr_key.pubkey = p_activated_by_nostr_pubkey
            ))
          )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'proof mission activation actor mismatch';
  END IF;

  -- Serialize exact-key replays before inspecting the immutable ledger. This
  -- turns concurrent identical requests into deterministic replay instead of a
  -- raw unique-key race, while unrelated tenants/keys can still activate in
  -- parallel.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0)
  );

  SELECT * INTO existing
    FROM public.gb_proof_mission_activations
   WHERE tenant_id = p_tenant_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.request_sha256 IS DISTINCT FROM p_request_sha256
       OR existing.source_graph_id IS DISTINCT FROM p_source_graph_id
       OR existing.source_graph_sha256 IS DISTINCT FROM p_source_graph_sha256
       OR existing.mission_intent_sha256 IS DISTINCT FROM p_mission_intent_sha256
       OR existing.mission_graph_sha256 IS DISTINCT FROM p_mission_graph_sha256
       OR existing.verification_set_id IS DISTINCT FROM p_verification_set_id
       OR existing.verification_set_sha256 IS DISTINCT FROM p_verification_set_sha256
       OR existing.workspace_key IS DISTINCT FROM p_workspace_key THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'proof mission activation idempotency conflict';
    END IF;
    RETURN QUERY SELECT existing.id, existing.workspace_id,
      existing.mission_graph_id, existing.mission_graph_sha256, TRUE;
    RETURN;
  END IF;

  SELECT * INTO source_graph
    FROM public.gb_proof_graphs
   WHERE tenant_id = p_tenant_id
     AND graph_id = p_source_graph_id
     AND content_sha256 = p_source_graph_sha256;
  IF NOT FOUND OR source_graph.graph_kind <> 'repository-field' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission source must be an exact passive repository-field graph';
  END IF;

  SELECT * INTO verification_set
    FROM public.gb_proof_verification_sets
   WHERE tenant_id = p_tenant_id
     AND id = p_verification_set_id
     AND content_sha256 = p_verification_set_sha256;
  IF NOT FOUND
     OR verification_set.graph_id IS DISTINCT FROM p_source_graph_id
     OR verification_set.graph_content_sha256 IS DISTINCT FROM p_source_graph_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'verification set does not match the exact mission source';
  END IF;
  -- PR17 deliberately activates only the explicit zero-inheritance baseline.
  -- Future non-empty baseline projection requires a separate reviewed slice;
  -- in particular, activation must not fabricate mutable proof authority from
  -- opaque receipts or infer verifier method from adapter names.
  IF verification_set.item_count <> 0 OR EXISTS (
    SELECT 1 FROM public.gb_proof_verification_records AS record
     WHERE record.tenant_id = p_tenant_id
       AND record.verification_set_id = p_verification_set_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '0A000',
      MESSAGE = 'non-empty proof verification baselines are not activatable yet';
  END IF;

  SELECT media_type, byte_size, content_bytes INTO intent_artifact
    FROM public.gb_artifacts
   WHERE tenant_id = p_tenant_id
     AND id = p_mission_intent_artifact_id
     AND content_sha256 = p_mission_intent_sha256;
  IF NOT FOUND OR intent_artifact.media_type <> 'application/json'
     OR intent_artifact.byte_size < 1 OR intent_artifact.byte_size > 65536 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission intent artifact is invalid';
  END IF;
  BEGIN
    IF convert_from(intent_artifact.content_bytes, 'UTF8')::jsonb <> p_mission_intent_json THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission intent JSON does not match its exact artifact';
    END IF;
  EXCEPTION WHEN character_not_in_repertoire OR untranslatable_character OR invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission intent artifact is not UTF-8 JSON';
  END;

  IF jsonb_typeof(p_mission_intent_json) <> 'object'
     OR p_mission_intent_json <> jsonb_build_object(
       'schema_id', 'galaxy.proof-mission-intent.v1',
       'source_graph', jsonb_build_object(
         'graph_id', p_source_graph_id,
         'graph_kind', 'repository-field',
         'content_sha256', p_source_graph_sha256
       ),
       'mission_id', p_mission_intent_json ->> 'mission_id',
       'main_target_id', p_mission_intent_json ->> 'main_target_id',
       'curated_milestone_target_ids', p_mission_intent_json -> 'curated_milestone_target_ids',
       'relation_direction', 'prerequisite-to-dependent'
     )
     OR jsonb_typeof(p_mission_intent_json -> 'curated_milestone_target_ids') <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission intent contract is invalid';
  END IF;

  derived_mission_graph_id := p_mission_intent_json ->> 'mission_id';
  derived_main_target_id := p_mission_intent_json ->> 'main_target_id';
  SELECT COALESCE(array_agg(value ORDER BY value COLLATE "C"), '{}') INTO derived_milestones
    FROM jsonb_array_elements_text(p_mission_intent_json -> 'curated_milestone_target_ids') AS item(value);
  IF derived_mission_graph_id IS NULL
     OR char_length(derived_mission_graph_id) NOT BETWEEN 1 AND 120
     OR derived_mission_graph_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
     OR derived_main_target_id IS NULL
     OR char_length(derived_main_target_id) NOT BETWEEN 1 AND 512
     OR derived_main_target_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
     OR cardinality(derived_milestones) > 500
     OR NOT gb_text_array_is_unique(derived_milestones) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission intent selection is invalid';
  END IF;

  IF NOT gb_proof_mission_source_metadata_valid(source_graph.graph_json) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission source metadata is invalid';
  END IF;

  SELECT media_type, byte_size, content_bytes INTO mission_artifact
    FROM public.gb_artifacts
   WHERE tenant_id = p_tenant_id
     AND id = p_mission_graph_artifact_id
     AND content_sha256 = p_mission_graph_sha256;
  IF NOT FOUND OR mission_artifact.media_type <> 'application/json'
     OR mission_artifact.byte_size < 1 OR mission_artifact.byte_size > 16777216 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission graph artifact is invalid';
  END IF;
  BEGIN
    IF convert_from(mission_artifact.content_bytes, 'UTF8')::jsonb <> p_mission_graph_json THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission graph JSON does not match its exact artifact';
    END IF;
  EXCEPTION WHEN character_not_in_repertoire OR untranslatable_character OR invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission graph artifact is not UTF-8 JSON';
  END;

  derived_title := COALESCE(NULLIF(gb_python_trim(p_mission_graph_json ->> 'title'), ''), derived_mission_graph_id);
  derived_target_ids := gb_proof_graph_target_ids(p_mission_graph_json);
  derived_node_ref_ids := gb_proof_graph_node_ref_ids(
    derived_mission_graph_id, p_mission_graph_sha256, derived_target_ids
  );
  expected_mission_graph := gb_expected_proof_mission_graph(
    source_graph.graph_json, p_mission_intent_json
  );

  -- Recompute the authoritative prerequisite closure from the passive source.
  -- The SECURITY DEFINER boundary must not trust the API compiler (or a caller
  -- with direct EXECUTE capability) to supply a complete mission.
  WITH RECURSIVE prerequisite_closure(target_id) AS (
    SELECT derived_main_target_id
    UNION
    SELECT gb_python_trim(relation.value ->> 'prerequisite_target_id')
      FROM prerequisite_closure AS closure
      JOIN LATERAL jsonb_array_elements(source_graph.graph_json -> 'relations')
        AS relation(value)
        ON gb_python_trim(relation.value ->> 'dependent_target_id') = closure.target_id
       AND gb_python_trim(relation.value ->> 'relation_type') IN (
         'DEPENDS_ON', 'REDUCES_TO', 'USES', 'AUTHORED_PREREQUISITE'
       )
  )
  SELECT COALESCE(array_agg(target_id ORDER BY target_id COLLATE "C"), '{}')
    INTO expected_target_ids
    FROM prerequisite_closure;

  IF p_mission_graph_json ->> 'schema_id' <> 'galaxy.proof-dag.v1'
     OR p_mission_graph_json ->> 'graph_id' IS DISTINCT FROM derived_mission_graph_id
     OR p_mission_graph_json ->> 'graph_kind' <> 'mission'
     OR p_mission_graph_json -> 'mission' <> jsonb_build_object(
       'main_target_id', derived_main_target_id,
       'curated_milestone_target_ids', to_jsonb(derived_milestones)
     )
     OR p_mission_graph_json -> 'provenance' <> jsonb_build_object(
       'source_graph', jsonb_build_object(
         'graph_id', p_source_graph_id,
         'graph_kind', 'repository-field',
         'content_sha256', p_source_graph_sha256
       ),
       'compiler', 'galaxy.proof-mission-compiler.v1'
     )
     OR cardinality(derived_target_ids) NOT BETWEEN 1 AND 2000
     OR NOT gb_text_array_is_unique(derived_target_ids)
     OR NOT derived_main_target_id = ANY(source_graph.target_ids)
     OR derived_main_target_id = ANY(derived_milestones)
     OR NOT derived_target_ids <@ source_graph.target_ids
     OR gb_text_array_sorted_c(derived_target_ids) <> expected_target_ids
     OR NOT derived_main_target_id = ANY(derived_target_ids)
     OR NOT derived_milestones <@ derived_target_ids
     OR jsonb_array_length(p_mission_graph_json -> 'relations') > 10000 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission graph does not match its exact source and intent';
  END IF;

  IF p_mission_graph_json <> expected_mission_graph THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission graph is not the canonical source projection';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(source_graph.graph_json -> 'targets') AS source_target(value)
     WHERE gb_python_trim(source_target.value ->> 'target_id') = ANY(expected_target_ids)
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_mission_graph_json -> 'targets') AS mission_target(value)
          WHERE mission_target.value = gb_proof_mission_target_projection(source_target.value)
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission targets do not match the exact source projection';
  END IF;

  -- Every source relation whose endpoints are in the closure must survive with
  -- the same structural identity. The only permitted extra relations are one
  -- generated MILESTONE_OF edge for each curated milestone that did not
  -- already have that visible edge in the source. This prevents a direct
  -- function caller from deleting a prerequisite edge while retaining the
  -- right node set.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(source_graph.graph_json -> 'relations') AS source_relation(value)
     WHERE gb_python_trim(source_relation.value ->> 'prerequisite_target_id') = ANY(expected_target_ids)
       AND gb_python_trim(source_relation.value ->> 'dependent_target_id') = ANY(expected_target_ids)
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_mission_graph_json -> 'relations') AS mission_relation(value)
          WHERE mission_relation.value
                  = gb_proof_mission_relation_projection(source_relation.value)
       )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_mission_graph_json -> 'relations') AS mission_relation(value)
     WHERE NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(source_graph.graph_json -> 'relations') AS source_relation(value)
        WHERE gb_proof_mission_relation_projection(source_relation.value)
                = mission_relation.value
          AND gb_python_trim(source_relation.value ->> 'prerequisite_target_id') = ANY(expected_target_ids)
          AND gb_python_trim(source_relation.value ->> 'dependent_target_id') = ANY(expected_target_ids)
     )
       AND NOT (
         mission_relation.value = jsonb_build_object(
           'relation_id', mission_relation.value ->> 'relation_id',
           'relation_type', 'MILESTONE_OF',
           'prerequisite_target_id', mission_relation.value ->> 'prerequisite_target_id',
           'dependent_target_id', derived_main_target_id
         )
         AND mission_relation.value ->> 'prerequisite_target_id' = ANY(derived_milestones)
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(source_graph.graph_json -> 'relations') AS source_relation(value)
            WHERE gb_python_trim(source_relation.value ->> 'relation_type') = 'MILESTONE_OF'
              AND gb_python_trim(source_relation.value ->> 'prerequisite_target_id')
                    = mission_relation.value ->> 'prerequisite_target_id'
              AND gb_python_trim(source_relation.value ->> 'dependent_target_id') = derived_main_target_id
         )
       )
  ) OR EXISTS (
    SELECT 1
      FROM unnest(derived_milestones) AS milestone(target_id)
     WHERE NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(source_graph.graph_json -> 'relations') AS source_relation(value)
        WHERE gb_python_trim(source_relation.value ->> 'relation_type') = 'MILESTONE_OF'
          AND gb_python_trim(source_relation.value ->> 'prerequisite_target_id') = milestone.target_id
          AND gb_python_trim(source_relation.value ->> 'dependent_target_id') = derived_main_target_id
     )
       AND 1 <> (
         SELECT count(*)
           FROM jsonb_array_elements(p_mission_graph_json -> 'relations') AS mission_relation(value)
          WHERE mission_relation.value ->> 'relation_type' = 'MILESTONE_OF'
            AND mission_relation.value ->> 'prerequisite_target_id' = milestone.target_id
            AND mission_relation.value ->> 'dependent_target_id' = derived_main_target_id
       )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_mission_graph_json -> 'relations') AS relation(value)
     GROUP BY relation.value ->> 'relation_id'
    HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mission relations do not match the exact source closure';
  END IF;

  derived_verified_ids := '{}';

  WITH prerequisites AS (
    SELECT target_id,
           COALESCE(array_agg(
             DISTINCT (relation.value ->> 'prerequisite_target_id') COLLATE "C"
             ORDER BY (relation.value ->> 'prerequisite_target_id') COLLATE "C"
           )
             FILTER (WHERE relation.value IS NOT NULL), '{}') AS prerequisite_ids
      FROM unnest(derived_target_ids) AS target(target_id)
      LEFT JOIN LATERAL jsonb_array_elements(p_mission_graph_json -> 'relations') AS relation(value)
        ON relation.value ->> 'dependent_target_id' = target_id
       AND relation.value ->> 'relation_type' IN (
         'DEPENDS_ON', 'REDUCES_TO', 'USES', 'AUTHORED_PREREQUISITE'
       )
     GROUP BY target_id
  )
  SELECT COALESCE(array_agg(target_id ORDER BY target_id COLLATE "C"), '{}')
    INTO derived_frontier_ids
    FROM prerequisites
   WHERE NOT target_id = ANY(derived_verified_ids)
     AND prerequisite_ids <@ derived_verified_ids;

  INSERT INTO public.gb_proof_mission_activations (
    id, tenant_id, source_graph_id, source_graph_sha256,
    mission_intent_artifact_id, mission_intent_sha256, mission_intent_json,
    mission_graph_id, mission_graph_sha256,
    verification_set_id, verification_set_sha256,
    workspace_id, workspace_key, main_target_id, curated_milestone_target_ids,
    target_ids, inherited_verified_node_ids, initial_frontier_node_ids,
    activated_by_principal_id, activated_by_nostr_pubkey,
    idempotency_key, request_sha256
  ) VALUES (
    new_activation_id, p_tenant_id, p_source_graph_id, p_source_graph_sha256,
    p_mission_intent_artifact_id, p_mission_intent_sha256, p_mission_intent_json,
    derived_mission_graph_id, p_mission_graph_sha256,
    p_verification_set_id, p_verification_set_sha256,
    new_workspace_id, p_workspace_key, derived_main_target_id, derived_milestones,
    derived_target_ids, derived_verified_ids, derived_frontier_ids,
    p_activated_by_principal_id, p_activated_by_nostr_pubkey,
    p_idempotency_key, p_request_sha256
  );

  INSERT INTO public.gb_proof_graphs (
    tenant_id, schema_id, graph_id, graph_kind, title,
    artifact_id, content_sha256, graph_json, target_ids, node_ref_ids,
    target_count, relation_count,
    registered_by_principal_id, registered_by_nostr_pubkey
  ) VALUES (
    p_tenant_id, 'galaxy.proof-dag.v1', derived_mission_graph_id, 'mission', derived_title,
    p_mission_graph_artifact_id, p_mission_graph_sha256, p_mission_graph_json,
    derived_target_ids, derived_node_ref_ids, cardinality(derived_target_ids),
    jsonb_array_length(p_mission_graph_json -> 'relations'),
    p_activated_by_principal_id, p_activated_by_nostr_pubkey
  ) ON CONFLICT (tenant_id, content_sha256) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM public.gb_proof_graphs AS graph
     WHERE graph.tenant_id = p_tenant_id
       AND graph.graph_id = derived_mission_graph_id
       AND graph.graph_kind = 'mission'
       AND graph.artifact_id = p_mission_graph_artifact_id
       AND graph.content_sha256 = p_mission_graph_sha256
       AND graph.graph_json = p_mission_graph_json
       AND graph.target_ids = derived_target_ids
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'mission graph identity conflicts with an existing registration';
  END IF;

  INSERT INTO public.gb_proof_workspaces (
    id, tenant_id, workspace_key, graph_id, graph_content_sha256, node_ids,
    schema_version, current_version,
    created_by_principal_id, created_by_nostr_pubkey,
    creation_idempotency_key, creation_request_hash
  ) VALUES (
    new_workspace_id, p_tenant_id, p_workspace_key,
    derived_mission_graph_id, p_mission_graph_sha256, derived_target_ids,
    'galaxy.proof-work-state.v1', 1,
    p_activated_by_principal_id, p_activated_by_nostr_pubkey,
    p_idempotency_key, p_request_sha256
  );

  INSERT INTO public.gb_proof_mission_activation_nodes (
    tenant_id, activation_id, node_id, prerequisite_node_ids,
    initial_proof_status, initial_frontier_status,
    verification_set_id, verification_node_id
  )
  WITH prerequisites AS (
    SELECT target_id,
           COALESCE(array_agg(
             DISTINCT (relation.value ->> 'prerequisite_target_id') COLLATE "C"
             ORDER BY (relation.value ->> 'prerequisite_target_id') COLLATE "C"
           )
             FILTER (WHERE relation.value IS NOT NULL), '{}') AS prerequisite_ids
      FROM unnest(derived_target_ids) AS target(target_id)
      LEFT JOIN LATERAL jsonb_array_elements(p_mission_graph_json -> 'relations') AS relation(value)
        ON relation.value ->> 'dependent_target_id' = target_id
       AND relation.value ->> 'relation_type' IN (
         'DEPENDS_ON', 'REDUCES_TO', 'USES', 'AUTHORED_PREREQUISITE'
       )
     GROUP BY target_id
  )
  SELECT p_tenant_id, new_activation_id, target_id, prerequisite_ids,
         CASE WHEN target_id = ANY(derived_verified_ids) THEN 'verified' ELSE 'open' END,
         CASE
           WHEN target_id = ANY(derived_verified_ids) THEN 'complete'
           WHEN prerequisite_ids <@ derived_verified_ids THEN 'available'
           ELSE 'prerequisites'
         END,
         CASE WHEN target_id = ANY(derived_verified_ids) THEN p_verification_set_id END,
         CASE WHEN target_id = ANY(derived_verified_ids) THEN target_id END
    FROM prerequisites;

  RETURN QUERY SELECT new_activation_id, new_workspace_id,
    derived_mission_graph_id, p_mission_graph_sha256, FALSE;
END;
$$;

REVOKE ALL ON FUNCTION gb_activate_proof_mission(
  UUID, TEXT, TEXT, UUID, TEXT, JSONB, UUID, TEXT, JSONB, UUID, TEXT,
  TEXT, UUID, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON TABLE gb_proof_mission_activations, gb_proof_mission_activation_nodes FROM PUBLIC;

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
      'GRANT SELECT ON TABLE public.gb_proof_mission_activations, public.gb_proof_mission_activation_nodes TO %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE public.gb_proof_mission_activations, public.gb_proof_mission_activation_nodes FROM %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.gb_activate_proof_mission(UUID, TEXT, TEXT, UUID, TEXT, JSONB, UUID, TEXT, JSONB, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT) TO %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
