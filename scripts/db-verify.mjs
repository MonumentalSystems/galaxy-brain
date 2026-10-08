import process from "node:process"
import { readFile } from "node:fs/promises"

import pg from "pg"

import {
  parseMigrationExecution,
  verifyConcurrentIndex,
} from "./concurrent-index-migration.mjs"

const { Client } = pg
const connectionString = process.env.DATABASE_VERIFY_URL?.trim()

if (!connectionString) throw new Error("DATABASE_VERIFY_URL is required")

const requiredMigrations = [
  "001_extensions",
  "002_app_auth",
  "003_eln",
  "004_legacy_tenant_backfill",
  "005_tenants_and_principals",
  "006_bounded_surfaces",
  "007_surface_contract_identity",
  "008_research_papers",
  "009_task_plans",
  "010_personal_workspace_invitations",
  "011_session_nostr_identity",
  "012_proof_work_state",
  "013_api_identity_read_permissions",
  "014_paper_documents",
  "015_object_links",
  "016_object_link_retractions",
  "017_federated_object_links",
  "018_canvas_persistence",
  "019_canvas_multi_document",
  "020_durable_ingestion",
  "021_document_transform_execution",
  "022_document_transform_attempts",
  "023_document_anchor_objects",
  "024_document_marks",
  "025_proof_graph_registry",
  "026_proof_workspace_activation_gate",
  "027_proof_verification_sets",
  "028_proof_mission_activation",
  "029_trusted_proof_verification",
  "030_transform_request_coalescing",
  "031_experiment_creation_idempotency",
  "032_proof_coordination_task_bindings",
  "033_agent_anchor_requests",
  "034_object_link_proposals",
  "035_typed_share_bundles",
  "036_conversation_turn_dag",
  "037_eln_durable_attachments",
  "038_paper_document_bridge",
  "039_document_chunk_identity",
  "040_formal_project_packages",
  "041_object_link_proposal_decisions",
  "042_task_plan_dispatch_intents",
  "043_durable_ingestion_source_kinds",
  "044_document_chunk_search",
  "045_canvas_conversation_share_bundles",
  "046_canvas_frames",
  "047_eln_observation_identity",
  "048_canvas_projection_mode",
  "049_proofs_blah_dev_verifier_authority",
  "050_agent_result_return_path",
]
const expectedSurfaceContract = {
  schemaDigest: "d147fafd26dd4be4cd41a1f504843366a01725a84a35668d565be4d210136729",
  catalogDigest: "60e2460ae227ccc42e3a44a2cda2740ec688ce57a68df972d67f8ab69c9d321f",
  rendererVersion: "29250eba64b8dfd89c2307a0f4a4a5193cb129fc",
}
const tablePatterns = ["app\\_%", "gb\\_%"]
const client = new Client({ connectionString })

try {
  await client.connect()
  const migrations = await client.query(
    "SELECT version FROM public.schema_migrations ORDER BY version",
  )
  const applied = new Set(migrations.rows.map((row) => row.version))
  const missingMigrations = requiredMigrations.filter((version) => !applied.has(version))
  const searchIndexMigration = parseMigrationExecution(
    await readFile(new URL("../db/migrations/044_document_chunk_search.sql", import.meta.url), "utf8"),
  )
  if (searchIndexMigration.mode !== "concurrent-index") {
    throw new Error("document chunk search migration must declare a concurrent index")
  }
  const searchIndex = await client.query(
    `SELECT index_schema.nspname AS index_schema,
            index_class.relname AS index_name,
            table_schema.nspname AS table_schema,
            table_class.relname AS table_name,
            access_method.amname AS access_method,
            index_catalog.indnkeyatts AS key_attribute_count,
            index_catalog.indisvalid AS is_valid,
            index_catalog.indisready AS is_ready,
            pg_get_indexdef(index_catalog.indexrelid, 1, true) AS expression,
            CASE WHEN index_catalog.indpred IS NULL THEN NULL
                 ELSE pg_get_expr(index_catalog.indpred, index_catalog.indrelid, true)
             END AS predicate
       FROM pg_catalog.pg_class AS index_class
       JOIN pg_catalog.pg_namespace AS index_schema
         ON index_schema.oid = index_class.relnamespace
       JOIN pg_catalog.pg_index AS index_catalog
         ON index_catalog.indexrelid = index_class.oid
       JOIN pg_catalog.pg_class AS table_class
         ON table_class.oid = index_catalog.indrelid
       JOIN pg_catalog.pg_namespace AS table_schema
         ON table_schema.oid = table_class.relnamespace
       JOIN pg_catalog.pg_am AS access_method
         ON access_method.oid = index_class.relam
      WHERE index_schema.nspname = $1
        AND index_class.relname = $2`,
    [searchIndexMigration.spec.index.schema, searchIndexMigration.spec.index.name],
  )
  let searchIndexOk = false
  let searchIndexError = null
  try {
    verifyConcurrentIndex(searchIndexMigration.spec, searchIndex.rows[0] ?? null)
    searchIndexOk = searchIndex.rowCount === 1
  } catch (error) {
    searchIndexError = error instanceof Error ? error.message : String(error)
  }

  const counts = await client.query(
    `SELECT relname AS table_name, n_live_tup::bigint AS approximate_rows
       FROM pg_stat_user_tables
      WHERE relname LIKE $1 ESCAPE '\\' OR relname LIKE $2 ESCAPE '\\'
      ORDER BY relname`,
    tablePatterns,
  )
  const invalidForeignKeys = await client.query(`
    SELECT conrelid::regclass::text AS table_name, conname
      FROM pg_constraint
     WHERE contype = 'f'
       AND NOT convalidated
       AND NOT (
         conrelid = 'public.gb_proof_workspaces'::regclass
         AND conname = 'gb_proof_workspaces_registered_graph_fkey'
       )
     ORDER BY 1, 2
  `)
  const ownerCounts = await client.query(`
    SELECT
      (SELECT count(*)::bigint FROM app_users) AS users,
      (SELECT count(*)::bigint FROM app_sessions) AS sessions,
      (SELECT count(*)::bigint FROM app_passkeys) AS passkeys,
      (SELECT count(*)::bigint FROM app_nostr_keys) AS nostr_keys,
      (SELECT count(*)::bigint FROM app_tenants) AS tenants,
      (SELECT count(*)::bigint FROM app_principals) AS principals,
      (SELECT count(*)::bigint FROM app_agents) AS agents,
      (SELECT count(*)::bigint FROM gb_experiments) AS experiments,
      (SELECT count(*)::bigint FROM gb_hypotheses) AS hypotheses,
      (SELECT count(*)::bigint FROM gb_surfaces) AS surfaces,
      (SELECT count(*)::bigint FROM gb_papers) AS papers,
      (SELECT count(*)::bigint FROM gb_paper_annotations) AS paper_annotations,
      (SELECT count(*)::bigint FROM gb_paper_documents) AS paper_documents,
      (SELECT count(*)::bigint FROM gb_paper_document_bridges) AS paper_document_bridges,
      (SELECT count(*)::bigint FROM gb_object_links) AS object_links,
      (SELECT count(*)::bigint FROM gb_object_link_retractions) AS object_link_retractions,
      (SELECT count(*)::bigint FROM gb_task_plans) AS task_plans,
      (SELECT count(*)::bigint FROM gb_task_plan_revisions) AS task_plan_revisions,
      (SELECT count(*)::bigint FROM gb_proof_workspaces) AS proof_workspaces,
      (SELECT count(*)::bigint FROM gb_proof_graphs) AS proof_graphs,
      (SELECT count(*)::bigint FROM gb_proof_verification_sets) AS proof_verification_sets,
      (SELECT count(*)::bigint FROM gb_proof_verification_records) AS proof_verification_records,
      (SELECT count(*)::bigint FROM gb_proof_mission_activations) AS proof_mission_activations,
      (SELECT count(*)::bigint FROM gb_proof_mission_activation_nodes) AS proof_mission_activation_nodes,
      (SELECT count(*)::bigint FROM gb_proof_work_verifications) AS proof_work_verifications,
      (SELECT count(*)::bigint FROM gb_proof_work_transitions) AS proof_work_transitions,
      (SELECT count(*)::bigint FROM gb_canvases) AS canvases,
      (SELECT count(*)::bigint FROM gb_canvas_items WHERE deleted_at IS NULL) AS canvas_items,
      (SELECT count(*)::bigint FROM gb_canvas_edges WHERE deleted_at IS NULL) AS canvas_edges,
      (SELECT count(*)::bigint FROM gb_canvas_revisions) AS canvas_revisions,
      (SELECT count(*)::bigint FROM gb_documents WHERE deleted_at IS NULL) AS documents,
      (SELECT count(*)::bigint FROM gb_document_revisions) AS document_revisions,
      (SELECT count(*)::bigint FROM gb_artifacts) AS artifacts,
      (SELECT count(*)::bigint FROM gb_transform_receipts) AS transform_receipts,
      (SELECT count(*)::bigint FROM gb_transform_attempts) AS transform_attempts,
      (SELECT count(*)::bigint FROM gb_transform_request_keys) AS transform_request_keys,
      (SELECT count(*)::bigint FROM gb_document_anchors) AS document_anchors,
      (SELECT count(*)::bigint FROM gb_document_marks) AS document_marks,
      (SELECT count(*)::bigint FROM gb_document_mark_revisions) AS document_mark_revisions,
      (SELECT count(*)::bigint FROM gb_agent_anchor_requests) AS agent_anchor_requests
  `)
  const surfaceIdentity = await client.query(
    `SELECT
       (SELECT count(*)::bigint
          FROM gb_surfaces surface
          LEFT JOIN gb_surface_revisions revision
            ON revision.tenant_id = surface.tenant_id
           AND revision.surface_id = surface.id
           AND revision.version = surface.current_version
         WHERE revision.id IS NULL
            OR surface.schema_digest IS DISTINCT FROM revision.schema_digest
            OR surface.catalog_digest IS DISTINCT FROM revision.catalog_digest
            OR surface.renderer_version IS DISTINCT FROM revision.renderer_version)
         AS current_surface_mismatches,
       (SELECT count(*)::bigint FROM gb_surface_revisions
         WHERE schema_digest <> $1 OR catalog_digest <> $2 OR renderer_version <> $3)
         AS historical_revisions`,
    [
      expectedSurfaceContract.schemaDigest,
      expectedSurfaceContract.catalogDigest,
      expectedSurfaceContract.rendererVersion,
    ],
  )
  const currentSurfaceIdentityMismatch = surfaceIdentity.rows[0].current_surface_mismatches !== "0"
  const activationBoundary = await client.query(`
    SELECT COALESCE(procedure.prosecdef, false) AS security_definer,
           COALESCE(
             'search_path=pg_catalog, public' = ANY(procedure.proconfig),
             false
           ) AS pinned_search_path,
           NOT EXISTS (
             SELECT 1
               FROM pg_catalog.aclexplode(
                 COALESCE(
                   procedure.proacl,
                   pg_catalog.acldefault('f', procedure.proowner)
                 )
               ) AS privilege
              WHERE privilege.grantee = 0
                AND privilege.privilege_type = 'EXECUTE'
           ) AS public_execute_revoked,
           (SELECT count(*) = 2
              FROM pg_catalog.pg_class AS table_class
              JOIN pg_catalog.pg_namespace AS table_schema
                ON table_schema.oid = table_class.relnamespace
             WHERE table_schema.nspname = 'public'
               AND table_class.relname IN (
                 'gb_proof_mission_activations',
                 'gb_proof_mission_activation_nodes'
               )
               AND table_class.relrowsecurity) AS activation_tables_use_rls
      FROM (SELECT pg_catalog.to_regprocedure(
        'public.gb_activate_proof_mission(uuid,text,text,uuid,text,jsonb,uuid,text,jsonb,uuid,text,text,uuid,text,text,text)'
      ) AS oid) AS expected
      LEFT JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = expected.oid
  `)
  const activationBoundaryOk =
    activationBoundary.rows[0].security_definer &&
    activationBoundary.rows[0].pinned_search_path &&
    activationBoundary.rows[0].public_execute_revoked &&
    activationBoundary.rows[0].activation_tables_use_rls

  const trustedVerificationBoundary = await client.query(`
    SELECT COALESCE(procedure.prosecdef, false) AS security_definer,
           COALESCE(
             'search_path=pg_catalog, public' = ANY(procedure.proconfig),
             false
           ) AS pinned_search_path,
           NOT EXISTS (
             SELECT 1
               FROM pg_catalog.aclexplode(
                 COALESCE(
                   procedure.proacl,
                   pg_catalog.acldefault('f', procedure.proowner)
                 )
               ) AS privilege
              WHERE privilege.privilege_type = 'EXECUTE'
                AND privilege.grantee <> procedure.proowner
                AND privilege.grantee IS DISTINCT FROM authority.oid
           ) AS authority_only_execute,
           COALESCE(
             authority.oid IS NOT NULL
             AND NOT authority.rolcanlogin
             AND NOT authority.rolsuper
             AND NOT authority.rolbypassrls
             AND NOT authority.rolcreaterole
             AND NOT authority.rolcreatedb
             AND NOT authority.rolreplication
             AND pg_catalog.has_function_privilege(authority.oid, procedure.oid, 'EXECUTE')
             AND NOT pg_catalog.has_table_privilege(authority.oid, table_class.oid, 'INSERT')
             AND NOT pg_catalog.has_table_privilege(authority.oid, table_class.oid, 'UPDATE')
             AND NOT pg_catalog.has_table_privilege(authority.oid, table_class.oid, 'DELETE')
             AND NOT pg_catalog.has_table_privilege(authority.oid, table_class.oid, 'TRUNCATE'),
             false
           ) AS restricted_verifier_authority,
           NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_auth_members AS membership
               JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
              WHERE membership.roleid = authority.oid
                AND (member.rolsuper OR member.rolbypassrls)
           ) AS verifier_members_respect_rls,
           EXISTS (
             SELECT 1
               FROM public.gb_proof_verifier_adapters AS adapter
              WHERE adapter.adapter_id = 'proofs-blah-dev'
                AND adapter.adapter_version = '1'
                AND adapter.enabled
           ) AS proofs_blah_dev_adapter_registered,
           COALESCE(table_class.relrowsecurity, false) AS ledger_uses_rls,
           EXISTS (
             SELECT 1
               FROM pg_catalog.pg_trigger AS trigger
              WHERE trigger.tgrelid = table_class.oid
                AND trigger.tgname = 'gb_proof_work_verifications_insert_guard'
                AND trigger.tgenabled <> 'D'
           ) AS insert_guard_enabled,
           EXISTS (
             SELECT 1
               FROM pg_catalog.pg_trigger AS trigger
              WHERE trigger.tgrelid = table_class.oid
                AND trigger.tgname = 'gb_proof_work_verifications_append_only'
                AND trigger.tgenabled <> 'D'
           ) AS append_only_guard_enabled
      FROM (SELECT pg_catalog.to_regprocedure(
        'public.gb_record_accepted_proof_verification(uuid,uuid,text,text,uuid,text,text,text,text,text,text,text,text,text[],text,text,text,text,timestamp with time zone,jsonb,uuid,text,text,text)'
      ) AS oid) AS expected
      LEFT JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = expected.oid
      LEFT JOIN pg_catalog.pg_class AS table_class
        ON table_class.oid = pg_catalog.to_regclass('public.gb_proof_work_verifications')
      LEFT JOIN pg_catalog.pg_roles AS authority
        ON authority.rolname = 'gb_proof_verifier'
  `)
  const trustedVerificationBoundaryOk =
    trustedVerificationBoundary.rows[0].security_definer &&
    trustedVerificationBoundary.rows[0].pinned_search_path &&
    trustedVerificationBoundary.rows[0].authority_only_execute &&
    trustedVerificationBoundary.rows[0].restricted_verifier_authority &&
    trustedVerificationBoundary.rows[0].verifier_members_respect_rls &&
    trustedVerificationBoundary.rows[0].proofs_blah_dev_adapter_registered &&
    trustedVerificationBoundary.rows[0].ledger_uses_rls &&
    trustedVerificationBoundary.rows[0].insert_guard_enabled &&
    trustedVerificationBoundary.rows[0].append_only_guard_enabled

  const report = {
    ok:
      missingMigrations.length === 0 &&
      invalidForeignKeys.rowCount === 0 &&
      searchIndexOk &&
      !currentSurfaceIdentityMismatch &&
      activationBoundaryOk &&
      trustedVerificationBoundaryOk,
    migrations: migrations.rows.map((row) => row.version),
    missingMigrations,
    invalidForeignKeys: invalidForeignKeys.rows,
    documentChunkSearchIndex: {
      ok: searchIndexOk,
      error: searchIndexError,
      catalog: searchIndex.rows[0] ?? null,
    },
    representativeCounts: ownerCounts.rows[0],
    surfaceContractIdentity: {
      currentSurfaceMismatches: surfaceIdentity.rows[0].current_surface_mismatches,
      historicalRevisions: surfaceIdentity.rows[0].historical_revisions,
    },
    proofMissionActivationBoundary: activationBoundary.rows[0],
    trustedProofVerificationBoundary: trustedVerificationBoundary.rows[0],
    tables: counts.rows,
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  await client.end()
}
