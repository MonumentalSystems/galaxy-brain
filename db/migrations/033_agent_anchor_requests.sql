-- Idempotent request evidence for agent-created immutable document anchors.
-- Anchor identity remains content-addressed in gb_document_anchors; this ledger
-- binds a caller retry key to one exact authenticated request without making
-- the provider-local document revision UUID part of the public contract.

ALTER TABLE gb_document_revisions
  ADD CONSTRAINT gb_document_revisions_agent_anchor_identity_unique UNIQUE (
    tenant_id, document_id, id, revision_sha256
  );

ALTER TABLE gb_document_anchors
  ADD CONSTRAINT gb_document_anchors_agent_request_binding_unique UNIQUE (
    tenant_id, document_revision_id, id, representation_id, representation_sha256
  );

CREATE TABLE gb_agent_anchor_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[!-~]+$'
  ),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  document_ref TEXT NOT NULL CHECK (octet_length(document_ref) BETWEEN 1 AND 16384),
  document_id UUID NOT NULL,
  document_revision_id UUID NOT NULL,
  document_revision_sha256 TEXT NOT NULL CHECK (document_revision_sha256 ~ '^[0-9a-f]{64}$'),
  representation_id UUID NOT NULL,
  representation_sha256 TEXT NOT NULL CHECK (representation_sha256 ~ '^[0-9a-f]{64}$'),
  anchor_id TEXT NOT NULL CHECK (anchor_id ~ '^sha256:[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (
    document_ref = 'gb:object:v1:document:' || document_id::text
      || ':pinned:sha256%3A' || document_revision_sha256
  ),
  FOREIGN KEY (
    tenant_id, document_id, document_revision_id, document_revision_sha256
  ) REFERENCES gb_document_revisions(
    tenant_id, document_id, id, revision_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, document_revision_id, anchor_id,
    representation_id, representation_sha256
  ) REFERENCES gb_document_anchors(
    tenant_id, document_revision_id, id,
    representation_id, representation_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_agent_anchor_requests_anchor
  ON gb_agent_anchor_requests(tenant_id, anchor_id, created_at, id);

ALTER TABLE gb_agent_anchor_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY gb_agent_anchor_requests_tenant_isolation ON gb_agent_anchor_requests
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION gb_reject_agent_anchor_request_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'agent anchor requests are append-only';
END;
$$;

CREATE TRIGGER gb_agent_anchor_requests_append_only
  BEFORE UPDATE OR DELETE ON gb_agent_anchor_requests
  FOR EACH ROW EXECUTE FUNCTION gb_reject_agent_anchor_request_mutation();

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
      'GRANT SELECT, INSERT ON TABLE public.gb_agent_anchor_requests TO %I',
      runtime_role.rolname
    );
    EXECUTE format(
      'REVOKE UPDATE, DELETE ON TABLE public.gb_agent_anchor_requests FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
