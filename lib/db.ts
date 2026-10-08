import { Pool } from "pg"

let pool: Pool | null = null

export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL
    pool = new Pool(
      connectionString
        ? { connectionString }
        : {
            host: process.env.POSTGRES_HOST || "localhost",
            port: Number(process.env.POSTGRES_PORT || 5433),
            database: process.env.POSTGRES_DB || "galaxy_brain",
            user: process.env.POSTGRES_USER || "galaxy_brain",
            password: process.env.POSTGRES_PASSWORD || "change-me",
          },
    )
  }
  return pool
}

let schemaReady: Promise<void> | null = null

const REQUIRED_MIGRATIONS = [
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
] as const

export function ensureAppSchema() {
  if (!schemaReady) {
    schemaReady = getPool()
      .query<{ version: string }>(
        "SELECT version FROM public.schema_migrations WHERE version = ANY($1::text[])",
        [REQUIRED_MIGRATIONS],
      )
      .then(({ rows }) => {
        const applied = new Set(rows.map((row) => row.version))
        const missing = REQUIRED_MIGRATIONS.filter((version) => !applied.has(version))
        if (missing.length) {
          throw new Error(`database migrations are missing: ${missing.join(", ")}`)
        }
      })
  }
  return schemaReady
}
