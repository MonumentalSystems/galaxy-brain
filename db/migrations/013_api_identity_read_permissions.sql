-- The Galaxy Brain API validates every proxied request against the canonical
-- tenant/principal records. Agent validation also reads app_agents, so the
-- restricted API role needs read-only access to that identity table.
DO $$
DECLARE runtime_role RECORD;
BEGIN
  FOR runtime_role IN
    SELECT role.rolname
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname <> current_user
       AND NOT role.rolsuper
       AND NOT role.rolbypassrls
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_tenants', 'SELECT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_principals', 'SELECT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.app_tenant_memberships', 'SELECT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'SELECT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'INSERT')
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'UPDATE')
       AND pg_catalog.has_table_privilege(role.oid, 'public.gb_task_plans', 'DELETE')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE public.app_agents TO %I',
      runtime_role.rolname
    );
  END LOOP;
END
$$;
