import pg from "pg"

const { Client } = pg

const connectionString = process.env.DATABASE_MIGRATION_URL?.trim()
const webRole = process.env.LOCAL_WEB_DATABASE_ROLE?.trim()
const webPassword = process.env.LOCAL_WEB_DATABASE_PASSWORD
const apiRole = process.env.LOCAL_API_DATABASE_ROLE?.trim()
const apiPassword = process.env.LOCAL_API_DATABASE_PASSWORD
// Optional separate login for the trusted proof verifier. It receives only
// membership in the migration-owned NOLOGIN gb_proof_verifier authority and must
// SET ROLE explicitly; runtime roles never receive that membership.
const verifierRole = process.env.LOCAL_VERIFIER_DATABASE_ROLE?.trim() || ""
const verifierPassword = process.env.LOCAL_VERIFIER_DATABASE_PASSWORD

if (!connectionString) throw new Error("DATABASE_MIGRATION_URL is required")

const roleNamePattern = /^[a-z_][a-z0-9_]{0,62}$/
for (const [label, role, password] of [
  ["web", webRole, webPassword],
  ["API", apiRole, apiPassword],
]) {
  if (!role || !roleNamePattern.test(role)) {
    throw new Error(`LOCAL_${label.toUpperCase()}_DATABASE_ROLE must be a safe PostgreSQL role name`)
  }
  if (!password || password.length < 16) {
    throw new Error(`LOCAL_${label.toUpperCase()}_DATABASE_PASSWORD must be at least 16 characters`)
  }
}
if (webRole === apiRole) throw new Error("local web and API database roles must be distinct")
if (verifierRole) {
  if (!roleNamePattern.test(verifierRole)) {
    throw new Error("LOCAL_VERIFIER_DATABASE_ROLE must be a safe PostgreSQL role name")
  }
  if (!verifierPassword || verifierPassword.length < 16) {
    throw new Error("LOCAL_VERIFIER_DATABASE_PASSWORD must be at least 16 characters")
  }
  if (verifierRole === webRole || verifierRole === apiRole || verifierRole === "gb_proof_verifier") {
    throw new Error("local verifier database role must be distinct from runtime roles and the authority")
  }
}

const webTables = [
  "app_users",
  "app_sessions",
  "app_passkeys",
  "app_nostr_keys",
  "app_nostr_auth_events",
  "app_auth_challenges",
  "app_password_reset_tokens",
  "app_auth_rate_limits",
  "app_tenants",
  "app_principals",
  "app_tenant_memberships",
  "app_agents",
  "app_api_tokens",
  "app_registration_invitations",
  "app_nostr_request_events",
]
const apiCrudTables = [
  "gb_datasource_plugins",
  "gb_experiments",
  "gb_hypotheses",
  "gb_experiment_metrics",
  "gb_datasource_connections",
  "gb_datasource_sync_runs",
  "gb_node_revisions",
  "gb_surfaces",
  "gb_surface_revisions",
  "gb_papers",
  "gb_paper_revisions",
  "gb_paper_annotations",
  "gb_paper_claims",
  "gb_claim_evidence_links",
  "gb_paper_task_links",
  "gb_task_plans",
  "gb_task_plan_revisions",
]
const apiImmutableInsertTables = [
  "gb_share_snapshots",
  "gb_experiment_creation_receipts",
  "gb_experiment_attachments",
  "gb_experiment_attachment_requests",
  "gb_eln_observations",
  "gb_eln_observation_revisions",
  "gb_eln_observation_create_receipts",
  "gb_paper_documents",
  "gb_paper_document_bridges",
  "gb_object_links",
  "gb_object_link_proposals",
  "gb_object_link_proposal_decisions",
  "gb_task_plan_dispatch_intents",
  "gb_object_link_retractions",
  "gb_artifacts",
  "gb_artifact_sources",
  "gb_document_revisions",
  "gb_document_representations",
  "gb_transform_receipts",
  "gb_transform_request_keys",
  "gb_document_anchors",
  "gb_document_chunks",
  "gb_document_chunk_manifests",
  "gb_document_mark_revisions",
  "gb_agent_anchor_requests",
  "gb_agent_result_candidates",
  "gb_agent_result_decisions",
  "gb_proof_graphs",
  "gb_formal_project_packages",
  "gb_proof_verification_sets",
  "gb_proof_verification_records",
  "gb_conversation_revisions",
  "gb_conversation_turns",
  "gb_conversation_turn_revisions",
  "gb_conversation_edges",
]
const apiReadOnlyTables = [
  "gb_proof_mission_activations",
  "gb_proof_mission_activation_nodes",
  "gb_proof_work_verifications",
]
const proofMutableTables = [
  "gb_proof_workspaces",
  "gb_proof_work_items",
  "gb_canvases",
  "gb_canvas_items",
  "gb_canvas_edges",
  "gb_documents",
  "gb_transform_attempts",
  "gb_document_marks",
  "gb_conversations",
]
const immutableLedgerTables = [
  "gb_proof_work_transitions",
  "gb_canvas_revisions",
]
const tenantTables = [...apiCrudTables, ...apiImmutableInsertTables, ...apiReadOnlyTables, ...proofMutableTables, ...immutableLedgerTables]
  .filter((table) => table !== "gb_datasource_plugins")

const client = new Client({ connectionString })

async function executeFormatted(format, ...values) {
  const placeholders = values.map((_, index) => `$${index + 2}::text`).join(", ")
  const result = await client.query(
    `SELECT pg_catalog.format($1${placeholders ? `, ${placeholders}` : ""}) AS ddl`,
    [format, ...values],
  )
  await client.query(result.rows[0].ddl)
}

async function resetRole(role, password, databaseName, migrationRole) {
  const existing = await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1", [role])
  if (existing.rowCount === 0) {
    await executeFormatted(
      "CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L",
      role,
      password,
    )
  } else {
    await executeFormatted(
      "ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L",
      role,
      password,
    )
  }

  const memberships = await client.query(
    `SELECT parent.rolname
     FROM pg_catalog.pg_auth_members AS membership
     JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
     JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
     WHERE member.rolname = $1`,
    [role],
  )
  for (const membership of memberships.rows) {
    await executeFormatted("REVOKE %I FROM %I", membership.rolname, role)
  }

  await executeFormatted("REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I", databaseName, role)
  await executeFormatted("REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I", role)
  await executeFormatted("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I", role)
  await executeFormatted("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I", role)
  await executeFormatted(
    "ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I",
    migrationRole,
    role,
  )
  await executeFormatted(
    "ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I",
    migrationRole,
    role,
  )
  await executeFormatted("GRANT CONNECT ON DATABASE %I TO %I", databaseName, role)
  await executeFormatted("GRANT USAGE ON SCHEMA public TO %I", role)
  await executeFormatted("GRANT SELECT ON TABLE schema_migrations TO %I", role)
}

try {
  await client.connect()
  const identity = await client.query(
    "SELECT current_database() AS database_name, current_user AS migration_role",
  )
  const { database_name: databaseName, migration_role: migrationRole } = identity.rows[0]
  if (webRole === migrationRole || apiRole === migrationRole || verifierRole === migrationRole) {
    throw new Error("local runtime database roles must differ from the migration role")
  }

  await client.query("BEGIN")
  try {
    await resetRole(webRole, webPassword, databaseName, migrationRole)
    await resetRole(apiRole, apiPassword, databaseName, migrationRole)
    if (verifierRole) {
      await resetRole(verifierRole, verifierPassword, databaseName, migrationRole)
      await executeFormatted("GRANT gb_proof_verifier TO %I", verifierRole)
    }

    await executeFormatted(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${webTables.map(() => "%I").join(", ")} TO %I`,
      ...webTables,
      webRole,
    )
    await executeFormatted(
      "GRANT SELECT ON TABLE app_tenants, app_principals, app_tenant_memberships, app_agents TO %I",
      apiRole,
    )
    await executeFormatted(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${apiCrudTables.map(() => "%I").join(", ")} TO %I`,
      ...apiCrudTables,
      apiRole,
    )
    await executeFormatted(
      `GRANT SELECT, INSERT ON TABLE ${apiImmutableInsertTables.map(() => "%I").join(", ")} TO %I`,
      ...apiImmutableInsertTables,
      apiRole,
    )
    await executeFormatted(
      `GRANT SELECT ON TABLE ${apiReadOnlyTables.map(() => "%I").join(", ")} TO %I`,
      ...apiReadOnlyTables,
      apiRole,
    )
    await executeFormatted(
      `GRANT SELECT, INSERT, UPDATE ON TABLE ${proofMutableTables.map(() => "%I").join(", ")} TO %I`,
      ...proofMutableTables,
      apiRole,
    )
    await executeFormatted(
      `GRANT SELECT, INSERT ON TABLE ${immutableLedgerTables.map(() => "%I").join(", ")} TO %I`,
      ...immutableLedgerTables,
      apiRole,
    )
    await executeFormatted("GRANT USAGE, SELECT ON SEQUENCE gb_experiment_metrics_id_seq TO %I", apiRole)
    await executeFormatted(
      "REVOKE ALL ON FUNCTION gb_activate_proof_mission(UUID, TEXT, TEXT, UUID, TEXT, JSONB, UUID, TEXT, JSONB, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT) FROM %I",
      webRole,
    )
    await executeFormatted(
      "REVOKE ALL ON FUNCTION gb_activate_proof_mission(UUID, TEXT, TEXT, UUID, TEXT, JSONB, UUID, TEXT, JSONB, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT) FROM %I",
      apiRole,
    )
    await executeFormatted(
      "GRANT EXECUTE ON FUNCTION gb_activate_proof_mission(UUID, TEXT, TEXT, UUID, TEXT, JSONB, UUID, TEXT, JSONB, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT) TO %I",
      apiRole,
    )
    await executeFormatted(
      "REVOKE ALL ON FUNCTION gb_record_accepted_proof_verification(UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB, UUID, TEXT, TEXT, TEXT) FROM %I",
      webRole,
    )
    await executeFormatted(
      "REVOKE ALL ON FUNCTION gb_record_accepted_proof_verification(UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB, UUID, TEXT, TEXT, TEXT) FROM %I",
      apiRole,
    )

    const apiSafety = await client.query(
      `SELECT runtime.rolsuper, runtime.rolbypassrls,
              EXISTS (
                SELECT 1
                FROM pg_catalog.pg_roles AS privileged
                WHERE (privileged.rolsuper OR privileged.rolbypassrls)
                  AND pg_catalog.pg_has_role(runtime.rolname, privileged.rolname, 'MEMBER')
              ) AS can_assume_bypass,
              EXISTS (
                SELECT 1
                FROM pg_catalog.pg_class AS tables
                JOIN pg_catalog.pg_namespace AS schemas ON schemas.oid = tables.relnamespace
                WHERE schemas.nspname = 'public'
                  AND tables.relname = ANY($2::text[])
                  AND pg_catalog.pg_has_role(
                    runtime.rolname,
                    pg_catalog.pg_get_userbyid(tables.relowner),
                    'MEMBER'
                  )
              ) AS can_assume_owner
       FROM pg_catalog.pg_roles AS runtime
       WHERE runtime.rolname = $1`,
      [apiRole, tenantTables],
    )
    if (
      apiSafety.rowCount !== 1 ||
      apiSafety.rows[0].rolsuper ||
      apiSafety.rows[0].rolbypassrls ||
      apiSafety.rows[0].can_assume_bypass ||
      apiSafety.rows[0].can_assume_owner
    ) {
      throw new Error("provisioned local API role can bypass tenant row-level security")
    }
    const verifierAuthority = await client.query(
      `SELECT runtime.rolname
       FROM pg_catalog.pg_roles AS runtime
       WHERE runtime.rolname = ANY($1::text[])
         AND pg_catalog.pg_has_role(runtime.rolname, 'gb_proof_verifier', 'MEMBER')`,
      [[webRole, apiRole]],
    )
    if (verifierAuthority.rowCount !== 0) {
      throw new Error("provisioned local runtime roles can assume the trusted proof verifier authority")
    }

    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
  console.log(
    `provisioned restricted local runtime roles: ${[webRole, apiRole, verifierRole].filter(Boolean).join(", ")}`,
  )
} finally {
  await client.end().catch(() => undefined)
}
