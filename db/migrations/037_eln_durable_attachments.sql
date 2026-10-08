-- Immutable experiment bindings to exact, tenant-owned document revisions.

ALTER TABLE gb_document_revisions
  ADD CONSTRAINT gb_document_revisions_tenant_document_id_sha256_key
  UNIQUE (tenant_id, document_id, id, revision_sha256);

CREATE TABLE gb_experiment_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  experiment_id TEXT NOT NULL,
  document_id UUID NOT NULL,
  document_revision_id UUID NOT NULL,
  document_revision_sha256 TEXT NOT NULL CHECK (document_revision_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, experiment_id, id),
  UNIQUE (tenant_id, experiment_id, document_id, document_revision_sha256),
  UNIQUE (tenant_id, experiment_id, idempotency_key),
  FOREIGN KEY (tenant_id, experiment_id)
    REFERENCES gb_experiments(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, document_id, document_revision_id, document_revision_sha256)
    REFERENCES gb_document_revisions(tenant_id, document_id, id, revision_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_experiment_attachments_experiment
  ON gb_experiment_attachments(tenant_id, experiment_id, created_at, id);

CREATE TABLE gb_experiment_attachment_requests (
  tenant_id UUID NOT NULL,
  experiment_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  attachment_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, experiment_id, idempotency_key),
  FOREIGN KEY (tenant_id, experiment_id)
    REFERENCES gb_experiments(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, experiment_id, attachment_id)
    REFERENCES gb_experiment_attachments(tenant_id, experiment_id, id) ON DELETE CASCADE
);

CREATE FUNCTION gb_reject_experiment_attachment_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'experiment attachments are immutable';
END;
$$;

CREATE TRIGGER gb_experiment_attachments_append_only
BEFORE UPDATE ON gb_experiment_attachments
FOR EACH ROW EXECUTE FUNCTION gb_reject_experiment_attachment_update();

CREATE TRIGGER gb_experiment_attachment_requests_append_only
BEFORE UPDATE ON gb_experiment_attachment_requests
FOR EACH ROW EXECUTE FUNCTION gb_reject_experiment_attachment_update();

-- Runtime roles have no DELETE privilege. The absence of a row-delete trigger is
-- intentional: deleting the owning experiment cascades only these bindings and
-- their request receipts while the durable document graph remains RESTRICTed.

ALTER TABLE gb_experiment_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_experiment_attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE gb_experiment_attachment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_experiment_attachment_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY gb_experiment_attachments_tenant_isolation
  ON gb_experiment_attachments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY gb_experiment_attachment_requests_tenant_isolation
  ON gb_experiment_attachment_requests
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user AND NOT role.rolsuper AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_experiments', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_experiments', 'INSERT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_experiments', 'UPDATE')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_experiments', 'DELETE')
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE public.gb_experiment_attachments, public.gb_experiment_attachment_requests TO %I',
      runtime_role.rolname
    );
    EXECUTE format(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.gb_experiment_attachments, public.gb_experiment_attachment_requests FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
