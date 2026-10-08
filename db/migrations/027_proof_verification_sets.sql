-- Immutable, receipt-backed proof verification baselines. A verification set
-- is evidence bound to one exact registered proof graph; registration does not
-- create a proof workspace, task, claim, or claimable frontier.

CREATE OR REPLACE FUNCTION gb_proof_verification_set_node_ids(set_json JSONB)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT COALESCE(array_agg(item.value ->> 'node_id' ORDER BY item.ordinality), '{}')
  FROM jsonb_array_elements(set_json -> 'items') WITH ORDINALITY AS item(value, ordinality)
$$;

CREATE TABLE gb_proof_verification_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  schema_id TEXT NOT NULL DEFAULT 'galaxy.proof-verification-set.v1'
    CHECK (schema_id = 'galaxy.proof-verification-set.v1'),
  graph_id TEXT NOT NULL CHECK (
    char_length(graph_id) BETWEEN 1 AND 512
    AND graph_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  graph_content_sha256 TEXT NOT NULL CHECK (graph_content_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_id UUID NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  set_json JSONB NOT NULL CHECK (jsonb_typeof(set_json) = 'object'),
  node_ids TEXT[] NOT NULL CHECK (
    cardinality(node_ids) BETWEEN 0 AND 10000
    AND array_position(node_ids, NULL) IS NULL
  ),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 10000),
  registered_by_principal_id UUID NOT NULL,
  registered_by_nostr_pubkey TEXT NOT NULL CHECK (
    registered_by_nostr_pubkey ~ '^[0-9a-f]{64}$'
  ),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, content_sha256),
  UNIQUE (tenant_id, content_sha256),
  FOREIGN KEY (tenant_id, graph_id, graph_content_sha256)
    REFERENCES gb_proof_graphs(tenant_id, graph_id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, artifact_id, content_sha256)
    REFERENCES gb_artifacts(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, registered_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT,
  CHECK (COALESCE(set_json ->> 'schema_id', '') = schema_id),
  CHECK (COALESCE(set_json #>> '{graph_ref,graph_id}', '') = graph_id),
  CHECK (COALESCE(set_json #>> '{graph_ref,content_sha256}', '') = graph_content_sha256),
  CHECK (COALESCE(jsonb_typeof(set_json -> 'items'), '') = 'array'),
  CHECK (jsonb_array_length(set_json -> 'items') = item_count),
  CHECK (gb_proof_verification_set_node_ids(set_json) = node_ids),
  CHECK (gb_text_array_is_unique(node_ids))
);

CREATE OR REPLACE FUNCTION gb_verify_proof_verification_set_artifact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  artifact RECORD;
  graph RECORD;
  parsed JSONB;
BEGIN
  SELECT byte_size, media_type, content_bytes
    INTO artifact
    FROM gb_artifacts
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.artifact_id
     AND content_sha256 = NEW.content_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof verification set artifact hash does not match';
  END IF;
  IF artifact.byte_size < 1 OR artifact.byte_size > 16777216 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof verification set artifact exceeds 16 MiB';
  END IF;
  IF artifact.media_type <> 'application/json' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof verification set artifact media type is invalid';
  END IF;
  BEGIN
    parsed := convert_from(artifact.content_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof verification set artifact is not UTF-8 JSON';
  END;
  IF parsed <> NEW.set_json THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof verification set JSON does not match artifact bytes';
  END IF;

  SELECT graph_kind, target_ids INTO graph
    FROM gb_proof_graphs
   WHERE tenant_id = NEW.tenant_id
     AND graph_id = NEW.graph_id
     AND content_sha256 = NEW.graph_content_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof verification set graph is not registered';
  END IF;
  IF graph.graph_kind <> 'repository-field' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof verification baselines require a passive repository-field graph';
  END IF;
  IF NOT NEW.node_ids <@ graph.target_ids THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof verification set references an unknown graph node';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gb_proof_verification_sets_verify_artifact
BEFORE INSERT ON gb_proof_verification_sets
FOR EACH ROW EXECUTE FUNCTION gb_verify_proof_verification_set_artifact();

-- This allowlist is migration-owned rather than tenant- or request-owned. It is
-- deliberately empty in this migration: self-described receipt JSON is not a
-- proof verifier. A later migration may register a versioned implementation
-- only when the server can authenticate or replay its exact receipt bytes.
CREATE TABLE gb_proof_verifier_adapters (
  adapter_id TEXT NOT NULL CHECK (adapter_id ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  adapter_version TEXT NOT NULL CHECK (adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$'),
  implementation_sha256 TEXT NOT NULL CHECK (implementation_sha256 ~ '^[0-9a-f]{64}$'),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (adapter_id, adapter_version),
  UNIQUE (adapter_id, adapter_version, implementation_sha256),
  CHECK (enabled)
);

CREATE TABLE gb_proof_verification_records (
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  verification_set_id UUID NOT NULL,
  verification_set_sha256 TEXT NOT NULL CHECK (verification_set_sha256 ~ '^[0-9a-f]{64}$'),
  item_index INTEGER NOT NULL CHECK (item_index BETWEEN 0 AND 9999),
  node_id TEXT NOT NULL CHECK (
    char_length(node_id) BETWEEN 1 AND 512
    AND node_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  candidate_sha256 TEXT NOT NULL CHECK (candidate_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_artifact_id UUID NOT NULL,
  receipt_content_sha256 TEXT NOT NULL CHECK (receipt_content_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_media_type TEXT NOT NULL CHECK (char_length(receipt_media_type) BETWEEN 1 AND 200),
  adapter_id TEXT NOT NULL CHECK (adapter_id ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  adapter_version TEXT NOT NULL CHECK (adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$'),
  adapter_implementation_sha256 TEXT NOT NULL
    CHECK (adapter_implementation_sha256 ~ '^[0-9a-f]{64}$'),
  solution_sha256 TEXT NOT NULL CHECK (
    solution_sha256 ~ '^[0-9a-f]{64}$' AND solution_sha256 = candidate_sha256
  ),
  outcome TEXT NOT NULL CHECK (outcome = 'accepted'),
  sorry_free BOOLEAN NOT NULL CHECK (sorry_free),
  subject_json JSONB NOT NULL CHECK (
    jsonb_typeof(subject_json) = 'object'
    AND octet_length(subject_json::text) BETWEEN 2 AND 65536
  ),
  source_commit TEXT NOT NULL CHECK (source_commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  lean_toolchain TEXT NOT NULL CHECK (char_length(lean_toolchain) BETWEEN 1 AND 200),
  mathlib_revision TEXT NOT NULL CHECK (mathlib_revision ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  verified_at TIMESTAMPTZ NOT NULL,
  provider_run_ref JSONB CHECK (
    provider_run_ref IS NULL
    OR jsonb_typeof(provider_run_ref) = 'object'
       AND octet_length(provider_run_ref::text) <= 16384
  ),
  PRIMARY KEY (tenant_id, verification_set_id, node_id),
  UNIQUE (tenant_id, verification_set_id, item_index),
  UNIQUE (tenant_id, verification_set_id, receipt_content_sha256),
  FOREIGN KEY (tenant_id, verification_set_id, verification_set_sha256)
    REFERENCES gb_proof_verification_sets(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, receipt_artifact_id, receipt_content_sha256)
    REFERENCES gb_artifacts(tenant_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (adapter_id, adapter_version, adapter_implementation_sha256)
    REFERENCES gb_proof_verifier_adapters(
      adapter_id, adapter_version, implementation_sha256
    ) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION gb_verify_proof_verification_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected RECORD;
  receipt_artifact RECORD;
BEGIN
  SELECT verification_set.set_json -> 'items' -> NEW.item_index ->> 'node_id' AS node_id,
         verification_set.set_json -> 'items' -> NEW.item_index ->> 'candidate_sha256' AS candidate_sha256,
         verification_set.set_json -> 'items' -> NEW.item_index #>> '{receipt,media_type}' AS receipt_media_type,
         verification_set.set_json -> 'items' -> NEW.item_index #>> '{receipt,adapter_id}' AS adapter_id,
         verification_set.set_json -> 'items' -> NEW.item_index #>> '{receipt,adapter_version}' AS adapter_version,
         verification_set.set_json -> 'items' -> NEW.item_index #>> '{receipt,content_sha256}' AS receipt_content_sha256,
         verification_set.set_json -> 'items' -> NEW.item_index #>> '{receipt,content_base64}' AS receipt_content_base64,
         verification_set.graph_id AS graph_id,
         verification_set.graph_content_sha256 AS graph_content_sha256,
         target.value #> '{formal_binding,declaration_ids}' AS declaration_ids,
         target.value #>> '{formal_binding,binding_kind}' AS binding_kind,
         target.value #>> '{formal_binding,declaration_equivalence_claimed}' AS equivalence_claimed,
         graph.graph_json #>> '{revision,repository}' AS source_repository,
         graph.graph_json #>> '{revision,commit}' AS source_commit,
         graph.graph_json #>> '{revision,lean_toolchain}' AS lean_toolchain,
         graph.graph_json #>> '{revision,mathlib_revision}' AS mathlib_revision
    INTO expected
    FROM gb_proof_verification_sets AS verification_set
    JOIN gb_proof_graphs AS graph
      ON graph.tenant_id = verification_set.tenant_id
     AND graph.graph_id = verification_set.graph_id
     AND graph.content_sha256 = verification_set.graph_content_sha256
    CROSS JOIN LATERAL jsonb_array_elements(graph.graph_json -> 'targets') AS target(value)
   WHERE verification_set.tenant_id = NEW.tenant_id
     AND verification_set.id = NEW.verification_set_id
     AND verification_set.content_sha256 = NEW.verification_set_sha256
     AND target.value ->> 'target_id' = NEW.node_id;
  IF NOT FOUND
     OR expected.node_id IS DISTINCT FROM NEW.node_id
     OR expected.candidate_sha256 IS DISTINCT FROM NEW.candidate_sha256
     OR expected.receipt_media_type IS DISTINCT FROM NEW.receipt_media_type
     OR expected.adapter_id IS DISTINCT FROM NEW.adapter_id
     OR expected.adapter_version IS DISTINCT FROM NEW.adapter_version
     OR expected.receipt_content_sha256 IS DISTINCT FROM NEW.receipt_content_sha256
     OR expected.binding_kind NOT IN ('declaration', 'declaration-bundle')
     OR expected.equivalence_claimed IS DISTINCT FROM 'true'
     OR expected.declaration_ids IS DISTINCT FROM NEW.subject_json -> 'declaration_ids'
     OR expected.graph_id IS DISTINCT FROM NEW.subject_json ->> 'graph_id'
     OR expected.graph_content_sha256 IS DISTINCT FROM NEW.subject_json ->> 'graph_content_sha256'
     OR NEW.node_id IS DISTINCT FROM NEW.subject_json ->> 'node_id'
     OR expected.source_repository IS DISTINCT FROM NEW.subject_json ->> 'source_repository'
     OR expected.source_commit IS DISTINCT FROM NEW.source_commit
     OR expected.lean_toolchain IS DISTINCT FROM NEW.lean_toolchain
     OR expected.mathlib_revision IS DISTINCT FROM NEW.mathlib_revision THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof verification record does not match its immutable set';
  END IF;

  SELECT media_type, content_bytes INTO receipt_artifact
    FROM gb_artifacts
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.receipt_artifact_id
     AND content_sha256 = NEW.receipt_content_sha256;
  IF NOT FOUND
     OR receipt_artifact.media_type IS DISTINCT FROM NEW.receipt_media_type
     OR receipt_artifact.content_bytes IS DISTINCT FROM decode(expected.receipt_content_base64, 'base64') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof verification receipt bytes do not match the immutable set';
  END IF;
  RETURN NEW;
EXCEPTION WHEN invalid_parameter_value OR data_exception THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof verification receipt encoding is invalid';
END;
$$;

CREATE TRIGGER gb_proof_verification_records_verify
BEFORE INSERT ON gb_proof_verification_records
FOR EACH ROW EXECUTE FUNCTION gb_verify_proof_verification_record();

CREATE OR REPLACE FUNCTION gb_verify_proof_verification_set_completeness()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  persisted_count INTEGER;
BEGIN
  SELECT count(*)::integer INTO persisted_count
    FROM gb_proof_verification_records
   WHERE tenant_id = NEW.tenant_id
     AND verification_set_id = NEW.id
     AND verification_set_sha256 = NEW.content_sha256;
  IF persisted_count <> NEW.item_count THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'proof verification set receipt records are incomplete';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER gb_proof_verification_sets_complete
AFTER INSERT ON gb_proof_verification_sets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gb_verify_proof_verification_set_completeness();

CREATE INDEX idx_gb_proof_verification_sets_graph
  ON gb_proof_verification_sets(
    tenant_id, graph_id, graph_content_sha256, registered_at DESC, content_sha256
  );

ALTER TABLE gb_proof_verification_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_proof_verification_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_proof_verification_sets_tenant_isolation ON gb_proof_verification_sets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY gb_proof_verification_records_tenant_isolation ON gb_proof_verification_records
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION gb_reject_proof_verification_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'proof verification registrations are append-only';
END;
$$;

CREATE TRIGGER gb_proof_verification_sets_append_only
BEFORE UPDATE OR DELETE ON gb_proof_verification_sets
FOR EACH ROW EXECUTE FUNCTION gb_reject_proof_verification_mutation();

CREATE TRIGGER gb_proof_verification_records_append_only
BEFORE UPDATE OR DELETE ON gb_proof_verification_records
FOR EACH ROW EXECUTE FUNCTION gb_reject_proof_verification_mutation();

CREATE TRIGGER gb_proof_verifier_adapters_append_only
BEFORE UPDATE OR DELETE ON gb_proof_verifier_adapters
FOR EACH ROW EXECUTE FUNCTION gb_reject_proof_verification_mutation();

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
      'GRANT SELECT, INSERT ON TABLE public.gb_proof_verification_sets, public.gb_proof_verification_records TO %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'REVOKE UPDATE, DELETE ON TABLE public.gb_proof_verification_sets, public.gb_proof_verification_records FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
