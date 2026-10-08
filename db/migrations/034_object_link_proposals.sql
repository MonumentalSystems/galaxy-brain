CREATE TABLE IF NOT EXISTS gb_object_link_proposals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
    from_ref text NOT NULL CHECK (octet_length(convert_to(from_ref, 'UTF8')) BETWEEN 1 AND 16384),
    to_ref text NOT NULL CHECK (octet_length(convert_to(to_ref, 'UTF8')) BETWEEN 1 AND 16384),
    relation text NOT NULL CHECK (relation IN ('related','cites','part_of','derived_from','context_for','formalized_by','defined_in','implements','depends_on','documents','corresponds_to')),
    rationale text NOT NULL CHECK (octet_length(convert_to(rationale, 'UTF8')) BETWEEN 1 AND 4096),
    status text NOT NULL DEFAULT 'pending' CHECK (status = 'pending'),
    provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 4096),
    created_by_principal_id uuid NOT NULL,
    idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'),
    request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (from_ref <> to_ref),
    CHECK (from_ref LIKE 'gb:object:v1:%' AND to_ref LIKE 'gb:object:v1:%'),
    CHECK (provenance->>'source' = 'agent-tool' AND provenance->>'tool' = 'relations.propose'),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, created_by_principal_id)
      REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS gb_object_link_proposals_from_idx ON gb_object_link_proposals (tenant_id, from_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS gb_object_link_proposals_to_idx ON gb_object_link_proposals (tenant_id, to_ref, created_at DESC);

ALTER TABLE gb_object_link_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_object_link_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gb_object_link_proposals_tenant_isolation ON gb_object_link_proposals;
CREATE POLICY gb_object_link_proposals_tenant_isolation ON gb_object_link_proposals
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP TRIGGER IF EXISTS gb_object_link_proposals_immutable ON gb_object_link_proposals;
CREATE TRIGGER gb_object_link_proposals_immutable
BEFORE UPDATE OR DELETE ON gb_object_link_proposals
FOR EACH ROW EXECUTE FUNCTION gb_reject_object_link_mutation();

DO $$
DECLARE role_name name;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles
    WHERE has_table_privilege(rolname, 'gb_object_links', 'SELECT')
      AND has_table_privilege(rolname, 'gb_object_links', 'INSERT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON TABLE gb_object_link_proposals TO %I', role_name);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE gb_object_link_proposals FROM %I', role_name);
  END LOOP;
END $$;
