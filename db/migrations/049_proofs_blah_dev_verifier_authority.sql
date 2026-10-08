-- Install the first authenticated, code-owned verifier authority for the
-- accepted-verification ledger sealed by migration 029.
--
-- proofs.blah.dev signs each verification report with an Ed25519 key that is
-- pinned in the API's proofs-blah-dev adapter (proofs_blah_dev_adapter.py).
-- The adapter recomputes the canonical report digest, verifies the signature,
-- and binds the signed origin to the exact graph node. PostgreSQL cannot verify
-- that signature, so authority is not granted to the ordinary API runtime:
--
-- * gb_proof_verifier is a NOLOGIN role. It receives EXECUTE on the registrar
--   and only the proof-work privileges needed to append the matching
--   proof.verify transition in the same transaction.
-- * A separate LOGIN identity, provisioned outside migrations and configured
--   only for the verifier route, is granted membership and must explicitly
--   SET ROLE gb_proof_verifier. Runtime roles are never members, and the
--   ledger insert guard and append-only triggers are unchanged.
--
-- The verifier list stays explicit. Another provider, such as Prove2Me, may be
-- added only by a later migration together with its own authenticated adapter.

DO $$
DECLARE
  authority RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'gb_proof_verifier'
  ) THEN
    CREATE ROLE gb_proof_verifier
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
      NOBYPASSRLS;
  END IF;
  SELECT * INTO authority
    FROM pg_catalog.pg_roles
   WHERE rolname = 'gb_proof_verifier';
  IF authority.rolcanlogin
     OR authority.rolsuper
     OR authority.rolbypassrls
     OR authority.rolcreaterole
     OR authority.rolcreatedb
     OR authority.rolreplication THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'gb_proof_verifier must be a restricted NOLOGIN role';
  END IF;
END;
$$;

-- Replace the provider allowlists in place. Constraints are located by the
-- columns they reference so this does not depend on generated names, and the
-- exact count fails closed if the schema has drifted.
DO $$
DECLARE
  target RECORD;
  constraint_row RECORD;
  dropped INTEGER;
BEGIN
  FOR target IN
    SELECT *
      FROM (VALUES
        ('gb_proof_work_verifications'::TEXT),
        ('gb_proof_verification_records'::TEXT)
      ) AS target_table(table_name)
  LOOP
    dropped := 0;
    FOR constraint_row IN
      SELECT check_constraint.conname
        FROM pg_catalog.pg_constraint AS check_constraint
       WHERE check_constraint.conrelid =
             pg_catalog.to_regclass('public.' || target.table_name)
         AND check_constraint.contype = 'c'
         AND EXISTS (
           SELECT 1
             FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = check_constraint.conrelid
              AND attribute.attnum = ANY(check_constraint.conkey)
              AND attribute.attname IN ('verifier_system', 'verification_method')
         )
    LOOP
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.%I DROP CONSTRAINT %I',
        target.table_name,
        constraint_row.conname
      );
      dropped := dropped + 1;
    END LOOP;
    IF dropped <> 3 THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = pg_catalog.format(
          'unexpected verifier constraints on %s: %s', target.table_name, dropped
        );
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE gb_proof_work_verifications
  ADD CONSTRAINT gb_proof_work_verifications_verifier_system_check CHECK (
    verifier_system IN ('hyades', 'lean-replay', 'proofs-blah-dev')
  ),
  ADD CONSTRAINT gb_proof_work_verifications_verification_method_check CHECK (
    verification_method IN ('hyades-run', 'lean-replay', 'signed-report')
    AND (
      (verifier_system = 'hyades' AND verification_method = 'hyades-run')
      OR
      (verifier_system = 'lean-replay' AND verification_method = 'lean-replay')
      OR
      (verifier_system = 'proofs-blah-dev' AND verification_method = 'signed-report')
    )
  ),
  ADD CONSTRAINT gb_proof_work_verifications_hyades_run_check CHECK (
    (verifier_system IN ('lean-replay', 'proofs-blah-dev') AND hyades_run IS NULL)
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
  );

ALTER TABLE gb_proof_verification_records
  ADD CONSTRAINT gb_proof_verification_records_verifier_system_check CHECK (
    verifier_system IN ('hyades', 'lean-replay', 'proofs-blah-dev')
  ),
  ADD CONSTRAINT gb_proof_verification_records_verification_method_check CHECK (
    verification_method IN ('hyades-run', 'lean-replay', 'signed-report')
    AND (
      (verifier_system = 'hyades' AND verification_method = 'hyades-run')
      OR
      (verifier_system = 'lean-replay' AND verification_method = 'lean-replay')
      OR
      (verifier_system = 'proofs-blah-dev' AND verification_method = 'signed-report')
    )
  ),
  ADD CONSTRAINT gb_proof_verification_records_provider_method_check CHECK (
    (verifier_system = 'hyades' AND provider_run_ref IS NOT NULL)
    OR
    (verifier_system IN ('lean-replay', 'proofs-blah-dev') AND provider_run_ref IS NULL)
  );

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
     OR p_verifier_system NOT IN ('hyades', 'lean-replay', 'proofs-blah-dev')
     OR p_verification_method IS NULL
     OR p_verification_method NOT IN ('hyades-run', 'lean-replay', 'signed-report')
     OR (p_verifier_system = 'hyades' AND p_verification_method <> 'hyades-run')
     OR (p_verifier_system = 'lean-replay' AND p_verification_method <> 'lean-replay')
     OR (p_verifier_system = 'proofs-blah-dev' AND p_verification_method <> 'signed-report')
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
     OR (p_verifier_system IN ('lean-replay', 'proofs-blah-dev') AND p_hyades_run IS NOT NULL)
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
  -- then work item. The authenticated verifier route calls this registrar
  -- and appends the proof.verify transition in the same transaction.
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

-- implementation_sha256 is the SHA-256 of
-- services/galaxy-brain-api/proofs_blah_dev_adapter.py with LF line endings.
-- Changing that file requires a new adapter version and migration.
INSERT INTO gb_proof_verifier_adapters (
  adapter_id, adapter_version, implementation_sha256, enabled
) VALUES (
  'proofs-blah-dev', '1', 'a9d8f50ef9768c5947a6cee7ff9f159c2abceab8731753181319cf432a967acd', TRUE
);

REVOKE ALL ON FUNCTION gb_record_accepted_proof_verification(
  UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB,
  UUID, TEXT, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gb_record_accepted_proof_verification(
  UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB,
  UUID, TEXT, TEXT, TEXT
) TO gb_proof_verifier;

-- The authority reads current proof state, stores the exact receipt bytes, and
-- appends one proof.verify transition. It cannot write the ledger directly or
-- delete anything, and tenant RLS still applies.
GRANT USAGE ON SCHEMA public TO gb_proof_verifier;
GRANT SELECT, UPDATE ON TABLE gb_proof_workspaces, gb_proof_work_items
  TO gb_proof_verifier;
GRANT SELECT, INSERT ON TABLE gb_proof_work_transitions, gb_artifacts
  TO gb_proof_verifier;
GRANT SELECT ON TABLE gb_proof_work_verifications TO gb_proof_verifier;

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
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid = 'gb_proof_verifier'::regrole
         AND membership.member = runtime_role.rolname::regrole
    ) THEN
      EXECUTE pg_catalog.format(
        'REVOKE gb_proof_verifier FROM %I',
        runtime_role.rolname
      );
    END IF;
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION public.gb_record_accepted_proof_verification(UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB, UUID, TEXT, TEXT, TEXT) FROM %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE public.gb_proof_work_verifications FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
