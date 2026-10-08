CREATE TABLE app_registration_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  email TEXT NOT NULL CHECK (email = lower(email) AND length(email) <= 320),
  name TEXT CHECK (name IS NULL OR length(name) <= 100),
  issuer_tenant_id UUID NOT NULL,
  created_by_principal_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (issuer_tenant_id, created_by_principal_id)
    REFERENCES app_tenant_memberships(tenant_id, principal_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX idx_app_registration_invitations_issuer
  ON app_registration_invitations(issuer_tenant_id, created_at DESC);
CREATE INDEX idx_app_registration_invitations_email
  ON app_registration_invitations(email, created_at DESC);
CREATE INDEX idx_app_registration_invitations_expires_at
  ON app_registration_invitations(expires_at);

DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname <> current_user
       AND NOT role.rolsuper
       AND NOT role.rolbypassrls
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_users', 'SELECT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_users', 'INSERT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_users', 'UPDATE')
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_users', 'DELETE')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.app_registration_invitations TO %I',
      runtime_role.rolname
    );
  END LOOP;
END
$$;
