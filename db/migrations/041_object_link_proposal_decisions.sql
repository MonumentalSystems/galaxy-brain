-- Human review is an append-only decision over an immutable agent proposal.
-- Accepting a proposal records the exact authored object-link assertion in the
-- same transaction; rejecting it deliberately leaves no active link.
CREATE TABLE gb_object_link_proposal_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app_tenants(id) ON DELETE RESTRICT,
  proposal_id UUID NOT NULL,
  decision_version INTEGER NOT NULL CHECK (decision_version = 2),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  reason TEXT NOT NULL CHECK (
    octet_length(convert_to(reason, 'UTF8')) BETWEEN 1 AND 4096
  ),
  object_link_id UUID,
  created_by_principal_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'
  ),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, proposal_id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (
    (decision = 'accepted' AND object_link_id IS NOT NULL) OR
    (decision = 'rejected' AND object_link_id IS NULL)
  ),
  FOREIGN KEY (tenant_id, proposal_id)
    REFERENCES gb_object_link_proposals(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, object_link_id)
    REFERENCES gb_object_links(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_principal_id)
    REFERENCES app_principals(id) ON DELETE RESTRICT
);

CREATE INDEX idx_gb_object_link_proposal_decisions_created
  ON gb_object_link_proposal_decisions(tenant_id, created_at DESC, id DESC);

ALTER TABLE gb_object_link_proposal_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gb_object_link_proposal_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY gb_object_link_proposal_decisions_tenant_isolation
  ON gb_object_link_proposal_decisions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Preserve the principal as durable audit provenance without pinning a tenant
-- membership forever. The actor must nevertheless be a human member of the
-- exact tenant while the decision is created. Row locks close the race with a
-- concurrent membership or principal deletion.
CREATE FUNCTION gb_validate_object_link_proposal_decision_actor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
    FROM public.app_tenant_memberships AS membership
   WHERE membership.tenant_id = NEW.tenant_id
     AND membership.principal_id = NEW.created_by_principal_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'relation proposal decision actor must be a human tenant member'
      USING ERRCODE = '23503';
  END IF;

  -- A principal kind update does not change a key, so lock this row more
  -- strongly than the membership FK row.
  PERFORM 1
    FROM public.app_principals AS principal
   WHERE principal.id = NEW.created_by_principal_id
     AND principal.kind = 'human'
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'relation proposal decision actor must be a human tenant member'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER gb_object_link_proposal_decisions_actor_guard
BEFORE INSERT ON gb_object_link_proposal_decisions
FOR EACH ROW EXECUTE FUNCTION gb_validate_object_link_proposal_decision_actor();

CREATE TRIGGER gb_object_link_proposal_decisions_append_only
BEFORE UPDATE OR DELETE ON gb_object_link_proposal_decisions
FOR EACH ROW EXECUTE FUNCTION gb_reject_object_link_mutation();

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname FROM pg_catalog.pg_roles AS role
    WHERE role.rolname <> current_user AND NOT role.rolsuper AND NOT role.rolbypassrls
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_object_link_proposals', 'SELECT')
      AND pg_catalog.has_table_privilege(role.oid, 'public.gb_object_link_proposals', 'INSERT')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT ON TABLE public.gb_object_link_proposal_decisions TO %I',
      runtime_role.rolname
    );
    EXECUTE pg_catalog.format(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.gb_object_link_proposal_decisions FROM %I',
      runtime_role.rolname
    );
  END LOOP;
END
$$;

COMMENT ON TABLE gb_object_link_proposal_decisions IS
  'Append-only human decisions over agent relation proposals. Decision state never implies proof or verification.';
