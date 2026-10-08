-- Immutable, experiment-scoped ELN observations with durable retry receipts.

CREATE TABLE gb_eln_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  experiment_id TEXT NOT NULL,
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, experiment_id, id),
  FOREIGN KEY (tenant_id, experiment_id)
    REFERENCES gb_experiments(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE gb_eln_observation_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  body TEXT NOT NULL CHECK (
    char_length(btrim(body)) BETWEEN 1 AND 4000
    AND body = btrim(body)
  ),
  observed_at TIMESTAMPTZ NOT NULL,
  revision_sha256 TEXT NOT NULL CHECK (revision_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, observation_id, version),
  UNIQUE (tenant_id, observation_id, revision_sha256),
  FOREIGN KEY (tenant_id, observation_id)
    REFERENCES gb_eln_observations(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_eln_observations_experiment
  ON gb_eln_observations(tenant_id, experiment_id, created_at, id);

-- This is deliberately not linked to either the experiment or observation.
-- It remains as a tombstone after experiment deletion so an ambiguous retry
-- can receive 410 instead of creating a second observation elsewhere.
CREATE TABLE gb_eln_observation_create_receipts (
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^eln-observation:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  experiment_id TEXT NOT NULL,
  observation_id UUID NOT NULL,
  created_by_principal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key),
  UNIQUE (tenant_id, observation_id),
  FOREIGN KEY (tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE FUNCTION gb_reject_eln_observation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ELN observations and receipts are append-only';
END;
$$;

CREATE TRIGGER gb_eln_observations_append_only
BEFORE UPDATE ON gb_eln_observations
FOR EACH ROW EXECUTE FUNCTION gb_reject_eln_observation_mutation();

CREATE TRIGGER gb_eln_observation_revisions_append_only
BEFORE UPDATE ON gb_eln_observation_revisions
FOR EACH ROW EXECUTE FUNCTION gb_reject_eln_observation_mutation();

CREATE TRIGGER gb_eln_observation_receipts_append_only
BEFORE UPDATE ON gb_eln_observation_create_receipts
FOR EACH ROW EXECUTE FUNCTION gb_reject_eln_observation_mutation();

ALTER TABLE gb_eln_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_eln_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE gb_eln_observation_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_eln_observation_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE gb_eln_observation_create_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_eln_observation_create_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY gb_eln_observations_tenant_isolation ON gb_eln_observations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY gb_eln_observation_revisions_tenant_isolation ON gb_eln_observation_revisions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY gb_eln_observation_receipts_tenant_isolation ON gb_eln_observation_create_receipts
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
      'GRANT SELECT, INSERT ON TABLE public.gb_eln_observations, public.gb_eln_observation_revisions, public.gb_eln_observation_create_receipts TO %I',
      runtime_role.rolname
    );
    EXECUTE format(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.gb_eln_observations, public.gb_eln_observation_revisions, public.gb_eln_observation_create_receipts FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END;
$$;
