-- Immutable live proof-verification evidence. Generic proof-work mutations may
-- read this ledger, but they cannot manufacture accepted verification. The
-- registrar remains sealed until a later migration installs an authenticated,
-- code-owned verifier authority and explicitly grants it EXECUTE.

CREATE OR REPLACE FUNCTION gb_proof_declaration_ids_valid(values_to_check TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(values_to_check) BETWEEN 1 AND 128
     AND gb_text_array_is_unique(values_to_check)
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(values_to_check) AS declaration(value)
        WHERE value IS NULL
           OR gb_js_utf16_length(value) NOT BETWEEN 1 AND 512
           OR value <> gb_python_trim(value)
     )
$$;

CREATE TABLE gb_proof_work_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  workspace_id UUID NOT NULL,
  node_id TEXT NOT NULL CHECK (
    char_length(node_id) BETWEEN 1 AND 512
    AND node_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  candidate_sha256 TEXT NOT NULL CHECK (candidate_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_artifact_id UUID NOT NULL,
  receipt_content_sha256 TEXT NOT NULL CHECK (
    receipt_content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  receipt_media_type TEXT NOT NULL CHECK (
    char_length(receipt_media_type) BETWEEN 1 AND 200
  ),
  adapter_id TEXT NOT NULL CHECK (
    adapter_id ~ '^[a-z0-9][a-z0-9._-]{0,79}$'
  ),
  adapter_version TEXT NOT NULL CHECK (
    adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$'
  ),
  adapter_implementation_sha256 TEXT NOT NULL CHECK (
    adapter_implementation_sha256 ~ '^[0-9a-f]{64}$'
  ),
  verifier_system TEXT NOT NULL CHECK (
    verifier_system IN ('hyades', 'lean-replay')
  ),
  verification_method TEXT NOT NULL CHECK (
    verification_method IN ('hyades-run', 'lean-replay')
    AND (
      (verifier_system = 'hyades' AND verification_method = 'hyades-run')
      OR
      (verifier_system = 'lean-replay' AND verification_method = 'lean-replay')
    )
  ),
  solution_sha256 TEXT NOT NULL CHECK (
    solution_sha256 ~ '^[0-9a-f]{64}$'
    AND solution_sha256 = candidate_sha256
  ),
  outcome TEXT NOT NULL DEFAULT 'accepted' CHECK (outcome = 'accepted'),
  sorry_free BOOLEAN NOT NULL DEFAULT TRUE CHECK (sorry_free),
  subject_graph_id TEXT NOT NULL CHECK (
    char_length(subject_graph_id) BETWEEN 1 AND 512
    AND subject_graph_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  subject_graph_content_sha256 TEXT NOT NULL CHECK (
    subject_graph_content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  subject_node_id TEXT NOT NULL CHECK (subject_node_id = node_id),
  subject_declaration_ids TEXT[] NOT NULL CHECK (
    gb_proof_declaration_ids_valid(subject_declaration_ids)
  ),
  source_repository TEXT NOT NULL CHECK (
    gb_js_utf16_length(source_repository) BETWEEN 1 AND 512
    AND source_repository = gb_python_trim(source_repository)
  ),
  source_commit TEXT NOT NULL CHECK (
    source_commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
  ),
  lean_toolchain TEXT NOT NULL CHECK (
    gb_js_utf16_length(lean_toolchain) BETWEEN 1 AND 200
    AND lean_toolchain = gb_python_trim(lean_toolchain)
  ),
  mathlib_revision TEXT NOT NULL CHECK (
    mathlib_revision ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
  ),
  verified_at TIMESTAMPTZ NOT NULL,
  hyades_run JSONB CHECK (
    (verifier_system = 'lean-replay' AND hyades_run IS NULL)
    OR
    (verifier_system = 'hyades'
      AND hyades_run IS NOT NULL
      AND jsonb_typeof(hyades_run) = 'object'
      AND hyades_run ->> 'workflow_id' IS NOT NULL
      AND hyades_run ->> 'run_id' IS NOT NULL
      AND hyades_run = jsonb_build_object(
        'workflow_id', hyades_run ->> 'workflow_id',
        'run_id', hyades_run ->> 'run_id',
        'status', 'completed'
      )
      AND gb_js_utf16_length(hyades_run ->> 'workflow_id') BETWEEN 1 AND 200
      AND gb_js_utf16_length(hyades_run ->> 'run_id') BETWEEN 1 AND 200
      AND octet_length(hyades_run::text) <= 1024)
  ),
  actor_principal_id UUID NOT NULL,
  actor_nostr_pubkey TEXT NOT NULL CHECK (
    actor_nostr_pubkey ~ '^[0-9a-f]{64}$'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (
    tenant_id, workspace_id, node_id, candidate_sha256, receipt_content_sha256
  ),
  FOREIGN KEY (tenant_id, workspace_id, node_id)
    REFERENCES gb_proof_work_items(tenant_id, workspace_id, node_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, receipt_artifact_id, receipt_content_sha256)
    REFERENCES gb_artifacts(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, subject_graph_id, subject_graph_content_sha256)
    REFERENCES gb_proof_graphs(tenant_id, graph_id, content_sha256)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (adapter_id, adapter_version, adapter_implementation_sha256)
    REFERENCES gb_proof_verifier_adapters(
      adapter_id, adapter_version, implementation_sha256
    ) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_proof_work_verifications_node
  ON gb_proof_work_verifications(
    tenant_id, workspace_id, node_id, accepted_at DESC
  );

ALTER TABLE gb_proof_work_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_proof_work_verifications_tenant_isolation
  ON gb_proof_work_verifications
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION gb_guard_proof_work_verification_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  table_owner NAME;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(table_class.relowner)
    INTO table_owner
    FROM pg_catalog.pg_class AS table_class
   WHERE table_class.oid = TG_RELID;

  -- A mistaken future table grant must not turn an ordinary runtime role into
  -- verification authority. The sealed SECURITY DEFINER registrar executes as
  -- the migration owner; direct runtime INSERT remains rejected independently
  -- of the ACL.
  IF current_user IS DISTINCT FROM table_owner THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'accepted proof verification requires the trusted registrar';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gb_proof_work_verifications_insert_guard
BEFORE INSERT ON gb_proof_work_verifications
FOR EACH ROW EXECUTE FUNCTION gb_guard_proof_work_verification_insert();

CREATE OR REPLACE FUNCTION gb_reject_proof_work_verification_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'proof work verifications are append-only';
END;
$$;

CREATE TRIGGER gb_proof_work_verifications_append_only
BEFORE UPDATE OR DELETE ON gb_proof_work_verifications
FOR EACH ROW EXECUTE FUNCTION gb_reject_proof_work_verification_mutation();

CREATE OR REPLACE FUNCTION gb_record_accepted_proof_verification(
  p_tenant_id UUID,
  p_workspace_id UUID,
  p_node_id TEXT,
  p_candidate_sha256 TEXT,
  p_receipt_artifact_id UUID,
  p_receipt_content_sha256 TEXT,
  p_receipt_media_type TEXT,
  p_adapter_id TEXT,
  p_adapter_version TEXT,
  p_adapter_implementation_sha256 TEXT,
  p_verifier_system TEXT,
  p_verification_method TEXT,
  p_solution_sha256 TEXT,
  p_subject_declaration_ids TEXT[],
  p_source_repository TEXT,
  p_source_commit TEXT,
  p_lean_toolchain TEXT,
  p_mathlib_revision TEXT,
  p_verified_at TIMESTAMPTZ,
  p_hyades_run JSONB,
  p_actor_principal_id UUID,
  p_actor_nostr_pubkey TEXT,
  p_idempotency_key TEXT,
  p_request_sha256 TEXT
)
RETURNS TABLE (
  verification_id UUID,
  replayed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tenant_context UUID;
  principal_context UUID;
  workspace RECORD;
  work_item RECORD;
  receipt_artifact RECORD;
  expected_subject RECORD;
  expected_declaration_ids TEXT[];
  existing RECORD;
  new_verification_id UUID := gen_random_uuid();
BEGIN
  BEGIN
    tenant_context := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
    principal_context := NULLIF(current_setting('app.principal_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'proof verification identity context is invalid';
  END;

  IF tenant_context IS NULL OR tenant_context IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'proof verification tenant mismatch';
  END IF;
  IF principal_context IS NULL
     OR principal_context IS DISTINCT FROM p_actor_principal_id
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
              SELECT 1
                FROM public.app_agents AS agent
               WHERE agent.principal_id = principal.id
                 AND agent.tenant_id = p_tenant_id
                 AND agent.nostr_pubkey = p_actor_nostr_pubkey
            ))
            OR
            (principal.kind = 'human' AND EXISTS (
              SELECT 1
                FROM public.app_users AS app_user
                JOIN public.app_nostr_keys AS nostr_key
                  ON nostr_key.user_id = app_user.id
               WHERE app_user.principal_id = principal.id
                 AND nostr_key.pubkey = p_actor_nostr_pubkey
            ))
          )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'proof verification actor mismatch';
  END IF;

  IF p_node_id IS NULL
     OR char_length(p_node_id) NOT BETWEEN 1 AND 512
     OR p_node_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
     OR p_candidate_sha256 IS NULL
     OR p_candidate_sha256 !~ '^[0-9a-f]{64}$'
     OR p_receipt_content_sha256 IS NULL
     OR p_receipt_content_sha256 !~ '^[0-9a-f]{64}$'
     OR p_receipt_media_type IS NULL
     OR char_length(p_receipt_media_type) NOT BETWEEN 1 AND 200
     OR p_adapter_id IS NULL
     OR p_adapter_id !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
     OR p_adapter_version IS NULL
     OR p_adapter_version !~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$'
     OR p_adapter_implementation_sha256 IS NULL
     OR p_adapter_implementation_sha256 !~ '^[0-9a-f]{64}$'
     OR p_verifier_system IS NULL
     OR p_verifier_system NOT IN ('hyades', 'lean-replay')
     OR p_verification_method IS NULL
     OR p_verification_method NOT IN ('hyades-run', 'lean-replay')
     OR (p_verifier_system = 'hyades' AND p_verification_method <> 'hyades-run')
     OR (p_verifier_system = 'lean-replay' AND p_verification_method <> 'lean-replay')
     OR p_solution_sha256 IS DISTINCT FROM p_candidate_sha256
     OR p_subject_declaration_ids IS NULL
     OR NOT gb_proof_declaration_ids_valid(p_subject_declaration_ids)
     OR p_source_repository IS NULL
     OR gb_js_utf16_length(p_source_repository) NOT BETWEEN 1 AND 512
     OR p_source_repository <> gb_python_trim(p_source_repository)
     OR p_source_commit IS NULL
     OR p_source_commit !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
     OR p_lean_toolchain IS NULL
     OR gb_js_utf16_length(p_lean_toolchain) NOT BETWEEN 1 AND 200
     OR p_lean_toolchain <> gb_python_trim(p_lean_toolchain)
     OR p_mathlib_revision IS NULL
     OR p_mathlib_revision !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
     OR p_verified_at IS NULL
     OR (p_verifier_system = 'lean-replay' AND p_hyades_run IS NOT NULL)
     OR (p_verifier_system = 'hyades' AND (
       p_hyades_run IS NULL
       OR jsonb_typeof(p_hyades_run) <> 'object'
       OR p_hyades_run ->> 'workflow_id' IS NULL
       OR p_hyades_run ->> 'run_id' IS NULL
       OR p_hyades_run <> jsonb_build_object(
         'workflow_id', p_hyades_run ->> 'workflow_id',
         'run_id', p_hyades_run ->> 'run_id',
         'status', 'completed'
       )
       OR gb_js_utf16_length(p_hyades_run ->> 'workflow_id') NOT BETWEEN 1 AND 200
       OR gb_js_utf16_length(p_hyades_run ->> 'run_id') NOT BETWEEN 1 AND 200
       OR octet_length(p_hyades_run::text) > 1024
     ))
     OR p_actor_nostr_pubkey IS NULL
     OR p_actor_nostr_pubkey !~ '^[0-9a-f]{64}$'
     OR p_idempotency_key IS NULL
     OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]+$'
     OR p_request_sha256 IS NULL
     OR p_request_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'proof verification input is invalid';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0)
  );

  SELECT * INTO existing
    FROM public.gb_proof_work_verifications
   WHERE tenant_id = p_tenant_id
     AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.workspace_id IS DISTINCT FROM p_workspace_id
       OR existing.node_id IS DISTINCT FROM p_node_id
       OR existing.candidate_sha256 IS DISTINCT FROM p_candidate_sha256
       OR existing.receipt_artifact_id IS DISTINCT FROM p_receipt_artifact_id
       OR existing.receipt_content_sha256 IS DISTINCT FROM p_receipt_content_sha256
       OR existing.receipt_media_type IS DISTINCT FROM p_receipt_media_type
       OR existing.adapter_id IS DISTINCT FROM p_adapter_id
       OR existing.adapter_version IS DISTINCT FROM p_adapter_version
       OR existing.adapter_implementation_sha256 IS DISTINCT FROM p_adapter_implementation_sha256
       OR existing.verifier_system IS DISTINCT FROM p_verifier_system
       OR existing.verification_method IS DISTINCT FROM p_verification_method
       OR existing.solution_sha256 IS DISTINCT FROM p_solution_sha256
       OR existing.subject_declaration_ids IS DISTINCT FROM p_subject_declaration_ids
       OR existing.source_repository IS DISTINCT FROM p_source_repository
       OR existing.source_commit IS DISTINCT FROM p_source_commit
       OR existing.lean_toolchain IS DISTINCT FROM p_lean_toolchain
       OR existing.mathlib_revision IS DISTINCT FROM p_mathlib_revision
       OR existing.verified_at IS DISTINCT FROM p_verified_at
       OR existing.hyades_run IS DISTINCT FROM p_hyades_run
       OR existing.actor_principal_id IS DISTINCT FROM p_actor_principal_id
       OR existing.actor_nostr_pubkey IS DISTINCT FROM p_actor_nostr_pubkey
       OR existing.request_sha256 IS DISTINCT FROM p_request_sha256 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'proof verification idempotency conflict';
    END IF;
    RETURN QUERY SELECT existing.id, TRUE;
    RETURN;
  END IF;

  -- Keep lock order aligned with the proof-work transition route: workspace,
  -- then work item. A future authenticated verifier route can call this
  -- registrar and append the generic transition in the same transaction.
  SELECT workspace_row.*,
         activation.source_graph_id,
         activation.source_graph_sha256
    INTO workspace
    FROM public.gb_proof_workspaces AS workspace_row
    JOIN public.gb_proof_mission_activations AS activation
      ON activation.tenant_id = workspace_row.tenant_id
     AND activation.workspace_id = workspace_row.id
   WHERE workspace_row.tenant_id = p_tenant_id
     AND workspace_row.id = p_workspace_id
   FOR SHARE OF workspace_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'proof verification requires an activated mission workspace';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.gb_proof_mission_activations AS activation
      JOIN public.gb_proof_mission_activation_nodes AS activation_node
        ON activation_node.tenant_id = activation.tenant_id
       AND activation_node.activation_id = activation.id
     WHERE activation.tenant_id = p_tenant_id
       AND activation.workspace_id = p_workspace_id
       AND activation_node.node_id = p_node_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'proof verification node is outside the activated mission';
  END IF;

  SELECT item.* INTO work_item
    FROM public.gb_proof_work_items AS item
   WHERE item.tenant_id = p_tenant_id
     AND item.workspace_id = p_workspace_id
     AND item.node_id = p_node_id
   FOR UPDATE;
  IF NOT FOUND
     OR work_item.state #>> '{proof,status}' NOT IN ('candidate', 'attested')
     OR work_item.state #>> '{proof,candidate_sha256}'
        IS DISTINCT FROM p_candidate_sha256 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'proof verification does not match the current candidate';
  END IF;

  SELECT source_graph.graph_json #>> '{revision,repository}' AS source_repository,
         source_graph.graph_json #>> '{revision,commit}' AS source_commit,
         source_graph.graph_json #>> '{revision,lean_toolchain}' AS lean_toolchain,
         source_graph.graph_json #>> '{revision,mathlib_revision}' AS mathlib_revision,
         target.value #>> '{formal_binding,binding_kind}' AS binding_kind,
         target.value #>> '{formal_binding,declaration_equivalence_claimed}' AS equivalence_claimed,
         target.value #> '{formal_binding,declaration_ids}' AS declaration_ids
    INTO expected_subject
    FROM public.gb_proof_graphs AS mission_graph
    JOIN public.gb_proof_graphs AS source_graph
      ON source_graph.tenant_id = mission_graph.tenant_id
     AND source_graph.graph_id = workspace.source_graph_id
     AND source_graph.content_sha256 = workspace.source_graph_sha256
    CROSS JOIN LATERAL jsonb_array_elements(mission_graph.graph_json -> 'targets') AS target(value)
   WHERE mission_graph.tenant_id = p_tenant_id
     AND mission_graph.graph_id = workspace.graph_id
     AND mission_graph.content_sha256 = workspace.graph_content_sha256
     AND target.value ->> 'target_id' = p_node_id;
  IF NOT FOUND
     OR expected_subject.binding_kind NOT IN ('declaration', 'declaration-bundle')
     OR expected_subject.equivalence_claimed IS DISTINCT FROM 'true'
     OR jsonb_typeof(expected_subject.declaration_ids) <> 'array' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'proof verification subject is not an exact formal target';
  END IF;
  BEGIN
    SELECT array_agg(value ORDER BY ordinality)
      INTO STRICT expected_declaration_ids
      FROM jsonb_array_elements_text(expected_subject.declaration_ids)
           WITH ORDINALITY AS declaration(value, ordinality);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'proof verification subject declarations are invalid';
  END;
  IF expected_declaration_ids IS DISTINCT FROM p_subject_declaration_ids
     OR expected_subject.source_repository IS DISTINCT FROM p_source_repository
     OR expected_subject.source_commit IS DISTINCT FROM p_source_commit
     OR expected_subject.lean_toolchain IS DISTINCT FROM p_lean_toolchain
     OR expected_subject.mathlib_revision IS DISTINCT FROM p_mathlib_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'proof verification evidence does not match the registered graph subject';
  END IF;

  SELECT artifact.media_type, artifact.byte_size INTO receipt_artifact
    FROM public.gb_artifacts AS artifact
   WHERE artifact.tenant_id = p_tenant_id
     AND artifact.id = p_receipt_artifact_id
     AND artifact.content_sha256 = p_receipt_content_sha256;
  IF NOT FOUND
     OR receipt_artifact.media_type IS DISTINCT FROM p_receipt_media_type
     OR receipt_artifact.byte_size NOT BETWEEN 1 AND 1048576 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'proof verification receipt artifact is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.gb_proof_verifier_adapters AS adapter
     WHERE adapter.adapter_id = p_adapter_id
       AND adapter.adapter_version = p_adapter_version
       AND adapter.implementation_sha256 = p_adapter_implementation_sha256
       AND adapter.enabled
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '0A000',
      MESSAGE = 'proof verifier adapter is not enabled';
  END IF;

  INSERT INTO public.gb_proof_work_verifications (
    id, tenant_id, workspace_id, node_id, candidate_sha256,
    receipt_artifact_id, receipt_content_sha256, receipt_media_type,
    adapter_id, adapter_version, adapter_implementation_sha256,
    verifier_system, verification_method, solution_sha256,
    outcome, sorry_free,
    subject_graph_id, subject_graph_content_sha256, subject_node_id,
    subject_declaration_ids,
    source_repository, source_commit, lean_toolchain, mathlib_revision,
    verified_at, hyades_run,
    actor_principal_id, actor_nostr_pubkey,
    idempotency_key, request_sha256
  ) VALUES (
    new_verification_id, p_tenant_id, p_workspace_id, p_node_id,
    p_candidate_sha256,
    p_receipt_artifact_id, p_receipt_content_sha256, p_receipt_media_type,
    p_adapter_id, p_adapter_version, p_adapter_implementation_sha256,
    p_verifier_system, p_verification_method, p_solution_sha256,
    'accepted', TRUE,
    workspace.graph_id, workspace.graph_content_sha256, p_node_id,
    p_subject_declaration_ids,
    p_source_repository, p_source_commit, p_lean_toolchain,
    p_mathlib_revision, p_verified_at, p_hyades_run,
    p_actor_principal_id, p_actor_nostr_pubkey,
    p_idempotency_key, p_request_sha256
  );

  RETURN QUERY SELECT new_verification_id, FALSE;
END;
$$;

REVOKE ALL ON TABLE gb_proof_work_verifications FROM PUBLIC;
REVOKE ALL ON FUNCTION gb_record_accepted_proof_verification(
  UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB,
  UUID, TEXT, TEXT, TEXT
) FROM PUBLIC;

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
      'GRANT SELECT ON TABLE public.gb_proof_work_verifications TO %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE public.gb_proof_work_verifications FROM %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION public.gb_record_accepted_proof_verification(UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB, UUID, TEXT, TEXT, TEXT) FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
