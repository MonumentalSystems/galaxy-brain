-- A HAM completion remains a review candidate until an authenticated human
-- explicitly accepts or rejects it.  Both candidate snapshots and decisions
-- are immutable, tenant-bound audit records.

ALTER TABLE gb_artifact_sources
  DROP CONSTRAINT IF EXISTS gb_artifact_sources_source_kind_check;

ALTER TABLE gb_artifact_sources
  ADD CONSTRAINT gb_artifact_sources_source_kind_check
  CHECK (source_kind IN (
    'upload', 'url', 'arxiv', 'legacy-paper', 'datasource', 'ham-task-result'
  ));

CREATE TABLE gb_agent_result_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  document_revision_id UUID NOT NULL,
  anchor_id TEXT NOT NULL,
  anchor_ref TEXT NOT NULL CHECK (anchor_ref LIKE 'gb:object:v1:document.anchor:%:pinned:%'),
  ham_task_id TEXT NOT NULL CHECK (
    ham_task_id ~ '^[A-Za-z0-9]([A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$'
  ),
  created_task_ref TEXT NOT NULL CHECK (created_task_ref LIKE 'gb:object:v1:ham.task:%:pinned:%'),
  terminal_task_version BIGINT NOT NULL CHECK (terminal_task_version BETWEEN 1 AND 9007199254740991),
  terminal_task_ref TEXT NOT NULL CHECK (terminal_task_ref LIKE 'gb:object:v1:ham.task:%:pinned:%'),
  terminal_event_id TEXT NOT NULL CHECK (
    terminal_event_id ~ '^[1-9][0-9]{0,15}$'
    AND terminal_event_id::numeric <= 9007199254740991
  ),
  occurred_at TIMESTAMPTZ NOT NULL,
  run_id TEXT CHECK (
    run_id IS NULL OR run_id ~ '^[A-Za-z0-9]([A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$'
  ),
  performed_by_ref TEXT CHECK (
    performed_by_ref IS NULL OR performed_by_ref ~ '^[A-Za-z0-9._:-]{1,200}$'
  ),
  result_sha256 TEXT NOT NULL CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  summary_markdown TEXT NOT NULL CHECK (octet_length(convert_to(summary_markdown, 'UTF8')) BETWEEN 1 AND 65536),
  evidence_refs JSONB NOT NULL CHECK (
    jsonb_typeof(evidence_refs) = 'array'
    AND jsonb_array_length(evidence_refs) BETWEEN 1 AND 50
    AND octet_length(evidence_refs::text) <= 1048576
  ),
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, document_revision_id, anchor_id, ham_task_id, terminal_task_version, terminal_event_id, result_sha256),
  FOREIGN KEY (tenant_id, document_revision_id)
    REFERENCES gb_document_revisions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, document_revision_id, anchor_id)
    REFERENCES gb_document_anchors(tenant_id, document_revision_id, id) ON DELETE RESTRICT
);

CREATE TABLE gb_agent_result_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  candidate_id UUID NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  reason TEXT NOT NULL CHECK (octet_length(convert_to(reason, 'UTF8')) BETWEEN 1 AND 4096),
  document_id UUID,
  document_revision_id UUID,
  document_revision_sha256 TEXT CHECK (
    document_revision_sha256 IS NULL OR document_revision_sha256 ~ '^[0-9a-f]{64}$'
  ),
  created_by_principal_id UUID NOT NULL REFERENCES app_principals(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, candidate_id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (
    (decision = 'accepted' AND document_id IS NOT NULL AND document_revision_id IS NOT NULL AND document_revision_sha256 IS NOT NULL)
    OR
    (decision = 'rejected' AND document_id IS NULL AND document_revision_id IS NULL AND document_revision_sha256 IS NULL)
  ),
  FOREIGN KEY (tenant_id, candidate_id)
    REFERENCES gb_agent_result_candidates(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, document_id)
    REFERENCES gb_documents(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, document_revision_id)
    REFERENCES gb_document_revisions(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_agent_result_candidates_lookup
  ON gb_agent_result_candidates (
    tenant_id, document_revision_id, anchor_id, ham_task_id,
    terminal_task_version, terminal_event_id, result_sha256
  );
CREATE INDEX idx_gb_agent_result_decisions_created
  ON gb_agent_result_decisions(tenant_id, created_at DESC, id DESC);

ALTER TABLE gb_agent_result_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_agent_result_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE gb_agent_result_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_agent_result_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY gb_agent_result_candidates_tenant_isolation ON gb_agent_result_candidates
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY gb_agent_result_decisions_tenant_isolation ON gb_agent_result_decisions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER gb_agent_result_candidates_append_only
BEFORE UPDATE OR DELETE ON gb_agent_result_candidates
FOR EACH ROW EXECUTE FUNCTION gb_reject_object_link_mutation();

CREATE TRIGGER gb_agent_result_decisions_append_only
BEFORE UPDATE OR DELETE ON gb_agent_result_decisions
FOR EACH ROW EXECUTE FUNCTION gb_reject_object_link_mutation();

CREATE FUNCTION gb_validate_agent_result_decision_actor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
    FROM public.app_tenant_memberships AS membership
    JOIN public.app_principals AS principal ON principal.id = membership.principal_id
   WHERE membership.tenant_id = NEW.tenant_id
     AND membership.principal_id = NEW.created_by_principal_id
     AND principal.kind = 'human'
   FOR SHARE OF membership, principal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent result decisions require a human tenant member'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER gb_agent_result_decisions_actor_guard
BEFORE INSERT ON gb_agent_result_decisions
FOR EACH ROW EXECUTE FUNCTION gb_validate_agent_result_decision_actor();

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user AND NOT role.rolsuper AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_object_links', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_object_links', 'INSERT')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT ON TABLE public.gb_agent_result_candidates, public.gb_agent_result_decisions TO %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.gb_agent_result_candidates, public.gb_agent_result_decisions FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END
$$;

COMMENT ON TABLE gb_agent_result_candidates IS
  'Immutable terminal HAM result snapshots awaiting explicit human review.';
COMMENT ON TABLE gb_agent_result_decisions IS
  'Append-only human accept/reject decisions; only acceptance materializes Galaxy knowledge.';
