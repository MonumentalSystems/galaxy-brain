import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"

test("ordered migrations are complete and immutable-ledger compatible", async () => {
  const files = (await readdir(new URL("../db/migrations/", import.meta.url))).sort()
  assert.deepEqual(files, [
    "001_extensions.sql",
    "002_app_auth.sql",
    "003_eln.sql",
    "004_legacy_tenant_backfill.sql",
    "005_tenants_and_principals.sql",
    "006_bounded_surfaces.sql",
    "007_surface_contract_identity.sql",
    "008_research_papers.sql",
    "009_task_plans.sql",
    "010_personal_workspace_invitations.sql",
    "011_session_nostr_identity.sql",
    "012_proof_work_state.sql",
    "013_api_identity_read_permissions.sql",
    "014_paper_documents.sql",
    "015_object_links.sql",
    "016_object_link_retractions.sql",
    "017_federated_object_links.sql",
    "018_canvas_persistence.sql",
    "019_canvas_multi_document.sql",
    "020_durable_ingestion.sql",
    "021_document_transform_execution.sql",
    "022_document_transform_attempts.sql",
    "023_document_anchor_objects.sql",
    "024_document_marks.sql",
    "025_proof_graph_registry.sql",
    "026_proof_workspace_activation_gate.sql",
    "027_proof_verification_sets.sql",
    "028_proof_mission_activation.sql",
    "029_trusted_proof_verification.sql",
    "030_transform_request_coalescing.sql",
    "031_experiment_creation_idempotency.sql",
    "032_proof_coordination_task_bindings.sql",
    "033_agent_anchor_requests.sql",
    "034_object_link_proposals.sql",
    "035_typed_share_bundles.sql",
    "036_conversation_turn_dag.sql",
    "037_eln_durable_attachments.sql",
    "038_paper_document_bridge.sql",
    "039_document_chunk_identity.sql",
    "040_formal_project_packages.sql",
    "041_object_link_proposal_decisions.sql",
    "042_task_plan_dispatch_intents.sql",
    "043_durable_ingestion_source_kinds.sql",
    "044_document_chunk_search.sql",
    "045_canvas_conversation_share_bundles.sql",
    "046_canvas_frames.sql",
    "047_eln_observation_identity.sql",
    "048_canvas_projection_mode.sql",
    "049_proofs_blah_dev_verifier_authority.sql",
    "050_agent_result_return_path.sql",
  ])
  for (const file of files) {
    const sql = await readFile(new URL(`../db/migrations/${file}`, import.meta.url), "utf8")
    assert.ok(sql.trim().endsWith(";"), `${file} must contain complete SQL statements`)
  }
  const [webRuntime, verifier, apiRuntime] = await Promise.all([
    readFile(new URL("../lib/db.ts", import.meta.url), "utf8"),
    readFile(new URL("./db-verify.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8"),
  ])
  for (const file of files) {
    const version = file.replace(/\.sql$/u, "")
    assert.match(webRuntime, new RegExp(`["]${version}["]`), `web runtime must require ${version}`)
    assert.match(verifier, new RegExp(`["]${version}["]`), `database verifier must require ${version}`)
    assert.match(apiRuntime, new RegExp(`["]${version}["]`), `API runtime must require ${version}`)
  }
})

test("migration 047 keeps immutable observations separate from durable retry tombstones", async () => {
  const migration = await readFile(
    new URL("../db/migrations/047_eln_observation_identity.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /CREATE TABLE gb_eln_observations/u)
  assert.match(migration, /CREATE TABLE gb_eln_observation_revisions/u)
  assert.match(migration, /CREATE TABLE gb_eln_observation_create_receipts/u)
  assert.match(migration, /REFERENCES gb_experiments\(tenant_id, id\) ON DELETE CASCADE/u)
  const receiptBlock = migration.split("CREATE TABLE gb_eln_observation_create_receipts", 2)[1]
    .split("CREATE FUNCTION", 1)[0]
  assert.doesNotMatch(receiptBlock, /REFERENCES gb_experiments|REFERENCES gb_eln_observations/u)
  for (const table of ["gb_eln_observations", "gb_eln_observation_revisions", "gb_eln_observation_create_receipts"]) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, "u"))
  }
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE/u)
})

test("migration 048 preserves existing canvases as ambient and bounds projection modes", async () => {
  const migration = await readFile(
    new URL("../db/migrations/048_canvas_projection_mode.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /ALTER TABLE gb_canvases/u)
  assert.match(migration, /projection_mode TEXT NOT NULL DEFAULT 'ambient'/u)
  assert.match(migration, /CHECK \(projection_mode IN \('ambient', 'curated'\)\)/u)
  assert.doesNotMatch(migration, /CREATE TABLE|INSERT INTO|UPDATE |DELETE FROM|DROP /u)
})

test("migration 038 binds exact legacy paper bytes to one durable document revision", async () => {
  const migration = await readFile(
    new URL("../db/migrations/038_paper_document_bridge.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /CREATE TABLE gb_paper_document_bridges/u)
  assert.match(migration, /UNIQUE \(tenant_id, paper_document_id\)/u)
  assert.match(migration, /UNIQUE \(tenant_id, paper_revision_id\)/u)
  assert.match(migration, /UNIQUE \(tenant_id, document_id, document_revision_id\)/u)
  assert.match(migration, /paper_revision_id, paper_document_id, content_sha256/u)
  assert.match(migration, /artifact_id, content_sha256/u)
  assert.match(migration, /source_id, artifact_id/u)
  assert.match(migration, /document_id, document_revision_id, document_revision_sha256/u)
  assert.match(migration, /document_revision_id, original_representation_id, content_sha256/u)
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_key\)/u)
  assert.match(migration, /paper document bridges are append-only/u)
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u)
  assert.match(migration, /GRANT SELECT, INSERT/u)
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE/u)
})

test("migration 036 stores a tenant-scoped immutable conversation turn DAG", async () => {
  const migration = await readFile(
    new URL("../db/migrations/036_conversation_turn_dag.sql", import.meta.url),
    "utf8",
  )
  for (const table of [
    "gb_conversations",
    "gb_conversation_revisions",
    "gb_conversation_turns",
    "gb_conversation_turn_revisions",
    "gb_conversation_edges",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`))
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`))
    assert.match(migration, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`))
  }
  assert.match(migration, /edge_kind IN \('continues', 'forks', 'joins'\)/)
  assert.match(migration, /conversation records are append-only/)
  assert.match(migration, /conversation versions must advance exactly once/)
  assert.match(migration, /conversation revision chain is invalid/)
  assert.match(migration, /conversation edges must point forward in the turn DAG/)
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/)
  assert.match(migration, /UNIQUE \(tenant_id, conversation_id, idempotency_key\)/)
  assert.match(migration, /UNIQUE \(tenant_id, conversation_id, from_turn_id, to_turn_id\)/)
  assert.doesNotMatch(migration, /UNIQUE \(tenant_id, conversation_id, from_turn_id, to_turn_id, edge_kind\)/)
  assert.equal(
    (migration.match(/REFERENCES app_tenant_memberships\(tenant_id, principal_id\)/g) || []).length,
    5,
  )
  assert.match(migration, /introduced_in_version INTEGER NOT NULL/)
  assert.match(migration, /REFERENCES gb_conversation_revisions\(tenant_id, conversation_id, version\)/)
  assert.match(migration, /turn incoming edge shape does not match its conversation revision/)
  assert.match(migration, /turn parent set does not match its conversation revision/)
  assert.match(migration, /turn revision must exactly match its introducing conversation revision/)
  assert.match(migration, /CREATE CONSTRAINT TRIGGER gb_conversation_edges_revision_shape/)
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.gb_conversation_revisions/)
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public\.gb_conversation_revisions/)
  assert.doesNotMatch(migration, /raw_(?:log|transcript)|credential|secret/i)

  const functionBodies = Array.from(
    migration.matchAll(/LANGUAGE plpgsql\s+AS \$\$([\s\S]*?)\$\$;/g),
    (match) => match[1],
  )
  assert.ok(functionBodies.length >= 8)
  for (const body of functionBodies) {
    assert.ok(
      (body.match(/^\s*DECLARE\b/gm) || []).length <= 1,
      "each PL/pgSQL function must have at most one DECLARE section",
    )
  }
})

test("migration 037 binds ELN attachments to exact tenant document revisions", async () => {
  const migration = await readFile(
    new URL("../db/migrations/037_eln_durable_attachments.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /CREATE TABLE gb_experiment_attachments/u)
  assert.match(migration, /CREATE TABLE gb_experiment_attachment_requests/u)
  assert.match(migration, /UNIQUE \(tenant_id, document_id, id, revision_sha256\)/u)
  assert.match(migration, /FOREIGN KEY \(tenant_id, document_id, document_revision_id, document_revision_sha256\)/u)
  assert.match(migration, /UNIQUE \(tenant_id, experiment_id, document_id, document_revision_sha256\)/u)
  assert.match(migration, /UNIQUE \(tenant_id, experiment_id, id\)/u)
  assert.match(migration, /UNIQUE \(tenant_id, experiment_id, idempotency_key\)/u)
  assert.match(migration, /PRIMARY KEY \(tenant_id, experiment_id, idempotency_key\)/u)
  assert.match(
    migration,
    /FOREIGN KEY \(tenant_id, experiment_id, attachment_id\)\s+REFERENCES gb_experiment_attachments\(tenant_id, experiment_id, id\) ON DELETE CASCADE/u,
  )
  assert.match(migration, /gb_experiments\(tenant_id, id\) ON DELETE CASCADE/u)
  assert.match(migration, /BEFORE UPDATE ON gb_experiment_attachments/u)
  assert.match(migration, /BEFORE UPDATE ON gb_experiment_attachment_requests/u)
  assert.doesNotMatch(migration, /BEFORE UPDATE OR DELETE ON gb_experiment_attachments/u)
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u)
  assert.match(migration, /GRANT SELECT, INSERT/u)
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE/u)
  assert.doesNotMatch(migration, /linked_papers/u)
})

test("migration 034 keeps relation proposals tenant-scoped, pending, and outside active links", async () => {
  const migration = await readFile(new URL("../db/migrations/034_object_link_proposals.sql", import.meta.url), "utf8")
  assert.match(migration, /CREATE TABLE IF NOT EXISTS gb_object_link_proposals/)
  assert.match(migration, /status text NOT NULL DEFAULT 'pending' CHECK \(status = 'pending'\)/)
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/)
  assert.match(migration, /BEFORE UPDATE OR DELETE/)
  assert.match(migration, /GRANT SELECT, INSERT/)
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE/)
  assert.doesNotMatch(migration, /INSERT INTO gb_object_links/)
})

test("migration 035 upgrades legacy storage to typed immutable tenant share bundles", async () => {
  const migration = await readFile(new URL("../db/migrations/035_typed_share_bundles.sql", import.meta.url), "utf8")
  assert.match(migration, /bundle_schema_id = 'gb\.share-bundle\.v1'/)
  assert.match(migration, /mode IN \('object-only', 'canvas-only'\)/)
  assert.match(migration, /access = 'tenant-read'/)
  assert.match(migration, /snapshot_json - 'schemaId' - 'mode' - 'source' - 'payload' = '\{\}'::jsonb/)
  assert.match(migration, /UNIQUE INDEX uq_gb_share_snapshots_typed_idempotency/)
  assert.match(migration, /FORCE ROW LEVEL SECURITY/)
  assert.match(migration, /BEFORE UPDATE OR DELETE/)
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE/)
  assert.doesNotMatch(migration, /UPDATE gb_share_snapshots/)
  const api = await readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8")
  const provisioner = await readFile(new URL("./provision-local-runtime-roles.mjs", import.meta.url), "utf8")
  assert.match(api, /"gb_share_snapshots": frozenset\(\("select", "insert"\)\)/)
  assert.match(api, /RUNTIME_DML_FORBIDDEN[\s\S]*"gb_share_snapshots": frozenset\(\("update", "delete"\)\)/)
  assert.match(provisioner, /apiImmutableInsertTables[\s\S]*"gb_share_snapshots"/)
})

test("migration 031 binds experiment creation replays without rewriting legacy rows", async () => {
  const migration = await readFile(
    new URL("../db/migrations/031_experiment_creation_idempotency.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /ADD COLUMN creation_idempotency_key TEXT/)
  assert.match(migration, /ADD COLUMN creation_request_hash TEXT/)
  assert.match(migration, /creation_idempotency_key IS NULL AND creation_request_hash IS NULL/)
  assert.match(migration, /creation_request_hash ~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.match(migration, /UNIQUE \(tenant_id, creation_idempotency_key\)/)
  assert.doesNotMatch(migration, /UPDATE gb_experiments/)
  assert.match(migration, /CREATE TABLE gb_experiment_creation_receipts/)
  assert.match(migration, /PRIMARY KEY \(tenant_id, idempotency_key\)/)
  assert.match(migration, /UNIQUE \(tenant_id, experiment_id\)/)
  assert.match(migration, /CREATE POLICY gb_experiment_creation_receipts_tenant_isolation/)
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.gb_experiment_creation_receipts/)
  assert.doesNotMatch(
    migration,
    /GRANT[^;]*(?:UPDATE|DELETE)[^;]*gb_experiment_creation_receipts/,
  )
  assert.doesNotMatch(
    migration,
    /experiment_id[^;]*REFERENCES gb_experiments/,
  )
  const api = await readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8")
  const provisioner = await readFile(new URL("./provision-local-runtime-roles.mjs", import.meta.url), "utf8")
  assert.match(api, /TENANT_RLS_TABLES[\s\S]*"gb_experiment_creation_receipts"/)
  assert.match(
    api,
    /"gb_experiment_creation_receipts": frozenset\(\("select", "insert"\)\)/,
  )
  assert.match(
    api,
    /"gb_experiment_creation_receipts": frozenset\(\("update", "delete"\)\)/,
  )
  assert.match(provisioner, /apiImmutableInsertTables[\s\S]*"gb_experiment_creation_receipts"/)
})

test("migration 021 binds transform replays to one immutable primary receipt", async () => {
  const migration = await readFile(
    new URL("../db/migrations/021_document_transform_execution.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /ADD COLUMN idempotency_key TEXT/)
  assert.match(migration, /ADD COLUMN request_sha256 TEXT/)
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_key\)/)
  assert.match(migration, /idempotency_key IS NULL AND request_sha256 IS NULL/)
  assert.match(migration, /request_sha256 IS NOT NULL/)
})

test("migration 022 leases provider work outside the immutable receipt ledger", async () => {
  const migration = await readFile(
    new URL("../db/migrations/022_document_transform_attempts.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /CREATE TABLE gb_transform_attempts/)
  assert.match(migration, /state IN \('running', 'finished'\)/)
  assert.match(migration, /lease_token UUID/)
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_key\)/)
  assert.match(migration, /gb_transform_receipts_attempt_binding_unique/)
  assert.match(migration, /gb_transform_receipts_fallback_binding_unique/)
  assert.match(
    migration,
    /FOREIGN KEY \(\s*tenant_id, fallback_receipt_id, document_revision_id,\s*input_artifact_id, input_sha256\s*\)/,
  )
  assert.match(migration, /REFERENCES gb_transform_receipts\(/)
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/)
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.gb_transform_attempts/)
  assert.doesNotMatch(migration, /GRANT[^;]*DELETE[^;]*gb_transform_attempts/)
})

test("migration 030 durably binds replay aliases and indexes canonical transform requests", async () => {
  const migration = await readFile(
    new URL("../db/migrations/030_transform_request_coalescing.sql", import.meta.url),
    "utf8",
  )
  const api = await readFile(
    new URL("../services/galaxy-brain-api/server.py", import.meta.url),
    "utf8",
  )
  assert.match(migration, /CREATE TABLE gb_transform_request_keys/)
  assert.match(migration, /PRIMARY KEY \(tenant_id, idempotency_key\)/)
  assert.match(migration, /SELECT tenant_id, idempotency_key, request_sha256, document_revision_id/)
  assert.match(migration, /idx_gb_transform_attempts_request/)
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/)
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.gb_transform_request_keys/)
  assert.doesNotMatch(migration, /GRANT[^;]*(?:UPDATE|DELETE)[^;]*gb_transform_request_keys/)
  assert.match(
    api,
    /SELECT request_sha256 FROM gb_transform_request_keys\s+WHERE tenant_id = %s AND idempotency_key = %s"""/,
  )
})

test("migration 023 makes document anchors exact immutable content-addressed objects", async () => {
  const migration = await readFile(
    new URL("../db/migrations/023_document_anchor_objects.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /ADD COLUMN document_revision_id UUID/)
  assert.match(migration, /ADD COLUMN identity_version TEXT/)
  assert.match(migration, /ADD COLUMN selector_kind TEXT/)
  assert.match(migration, /ADD COLUMN selector_sha256 TEXT/)
  assert.match(migration, /ADD COLUMN anchor_sha256 TEXT/)
  assert.match(migration, /representation\.document_revision_id/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_anchor_canonical_json/)
  assert.match(migration, /digest\(convert_to\(gb_anchor_canonical_json\(anchor\.selector_json\), 'UTF8'\), 'sha256'\)/)
  assert.match(
    migration,
    /gb_anchor_canonical_json\(jsonb_build_object\([\s\S]*'representationId', representation_id::text,[\s\S]*'representationSha256', representation_sha256,[\s\S]*'selector', selector_json/,
  )
  assert.match(migration, /selector_kind = selector_json ->> 'kind'/)
  assert.match(migration, /selector_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.match(migration, /anchor_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.match(migration, /identity_version = 'legacy-v0' OR id = 'sha256:' \|\| anchor_sha256/)
  assert.match(migration, /CREATE TRIGGER gb_document_anchors_canonical_insert/)
  assert.match(migration, /DROP CONSTRAINT gb_document_anchors_selector_json_check/)
  assert.match(migration, /octet_length\(selector_json::text\) <= 65536/)
  assert.match(
    migration,
    /FOREIGN KEY \(\s*tenant_id, document_revision_id, representation_id, representation_sha256\s*\)/,
  )
  assert.match(
    migration,
    /REFERENCES gb_document_representations\(\s*tenant_id, document_revision_id, id, content_sha256\s*\)/,
  )
  assert.match(migration, /CREATE UNIQUE INDEX uq_gb_document_anchors_canonical_content/)
  assert.match(migration, /ON gb_document_anchors\(tenant_id, anchor_sha256\)/)
  assert.match(migration, /WHERE identity_version = 'gb\.anchor\.v1'/)
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.gb_document_anchors/)
  assert.match(migration, /REVOKE UPDATE, DELETE ON TABLE public\.gb_document_anchors/)
  assert.doesNotMatch(migration, /ADD COLUMN (?:idempotency_key|request_sha256)/)
})

test("migration 024 stores reader marks as versioned anchor-bound objects", async () => {
  const migration = await readFile(
    new URL("../db/migrations/024_document_marks.sql", import.meta.url),
    "utf8",
  )
  for (const table of ["gb_document_marks", "gb_document_mark_revisions"]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`))
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`))
    assert.match(migration, new RegExp(`CREATE POLICY ${table}_tenant_isolation`))
  }
  assert.match(migration, /REFERENCES gb_document_anchors\(tenant_id, document_revision_id, id\)/)
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/)
  assert.match(migration, /document mark current state must match its immutable revision/)
  assert.match(migration, /CREATE CONSTRAINT TRIGGER gb_document_marks_current_revision/)
  assert.match(migration, /document mark revisions are append-only/)
  assert.match(migration, /document mark versions must advance by one/)
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.gb_document_marks/)
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.gb_document_mark_revisions/)
  assert.match(migration, /REVOKE UPDATE, DELETE ON TABLE public\.gb_document_mark_revisions/)
  assert.doesNotMatch(migration, /CREATE TABLE gb_.*task.*link/)
})

test("migration 033 stores agent anchor retries as append-only tenant evidence", async () => {
  const migration = await readFile(
    new URL("../db/migrations/033_agent_anchor_requests.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /CREATE TABLE gb_agent_anchor_requests/)
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_key\)/)
  assert.match(migration, /gb_document_revisions_agent_anchor_identity_unique/)
  assert.match(migration, /gb_document_anchors_agent_request_binding_unique/)
  assert.match(migration, /document_ref = 'gb:object:v1:document:' \|\| document_id::text/)
  assert.match(migration, /REFERENCES gb_document_revisions\(/)
  assert.match(migration, /tenant_id, document_id, id, revision_sha256/)
  assert.match(migration, /REFERENCES gb_document_anchors\(/)
  assert.match(migration, /tenant_id, document_revision_id, id,[\s\S]*representation_id, representation_sha256/)
  assert.match(migration, /REFERENCES app_tenant_memberships\(tenant_id, principal_id\)/)
  assert.match(migration, /ALTER TABLE gb_agent_anchor_requests ENABLE ROW LEVEL SECURITY/)
  assert.match(migration, /CREATE POLICY gb_agent_anchor_requests_tenant_isolation/)
  assert.match(migration, /agent anchor requests are append-only/)
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.gb_agent_anchor_requests/)
  assert.match(migration, /REVOKE UPDATE, DELETE ON TABLE public\.gb_agent_anchor_requests/)
})

test("migration 025 registers exact immutable proof DAG bytes without creating work state", async () => {
  const [migration, verifier] = await Promise.all([
    readFile(new URL("../db/migrations/025_proof_graph_registry.sql", import.meta.url), "utf8"),
    readFile(new URL("./db-verify.mjs", import.meta.url), "utf8"),
  ])
  assert.match(migration, /CREATE TABLE gb_proof_graphs/)
  assert.match(migration, /artifact_id UUID NOT NULL/)
  assert.match(migration, /graph_json JSONB NOT NULL/)
  assert.match(migration, /REFERENCES gb_artifacts\(tenant_id, id, content_sha256\)/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_verify_proof_graph_artifact/)
  assert.match(migration, /convert_from\(artifact\.content_bytes, 'UTF8'\)::jsonb/)
  assert.match(migration, /parsed <> NEW\.graph_json/)
  assert.match(migration, /UNIQUE \(tenant_id, content_sha256\)/)
  assert.match(migration, /gb_proof_graph_target_ids\(graph_json\) = target_ids/)
  assert.match(migration, /gb_proof_graph_node_ref_ids\(graph_id, content_sha256, target_ids\) = node_ref_ids/)
  assert.match(migration, /ordinality - 1 AS target_index/)
  assert.doesNotMatch(migration, /row_number\(\) OVER \(ORDER BY target_id\)/)
  assert.match(migration, /graph_kind IN \('repository-field', 'campaign', 'mission'\)/)
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/)
  assert.match(migration, /proof graph registrations are append-only/)
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.gb_proof_graphs/)
  assert.match(migration, /REVOKE UPDATE, DELETE ON TABLE public\.gb_proof_graphs/)
  assert.match(migration, /gb_proof_workspaces_registered_graph_fkey/)
  assert.match(migration, /ON DELETE RESTRICT NOT VALID/)
  assert.match(
    verifier,
    /conrelid = 'public\.gb_proof_workspaces'::regclass[\s\S]*conname = 'gb_proof_workspaces_registered_graph_fkey'/,
  )
  assert.match(migration, /CREATE TRIGGER gb_proof_workspaces_registered_graph_guard/)
  assert.match(migration, /proof workspace graph binding is immutable/)
  assert.match(migration, /proof workspace nodes must equal the registered target set/)
  assert.doesNotMatch(migration, /INSERT INTO gb_proof_workspaces/)
  assert.doesNotMatch(migration, /INSERT INTO gb_proof_work_items/)
})

test("migration 026 fails closed before any new proof workspace activation", async () => {
  const migration = await readFile(
    new URL("../db/migrations/026_proof_workspace_activation_gate.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_reject_unactivated_proof_workspace_insert\(\)/)
  assert.match(migration, /ERRCODE = '55000'/)
  assert.match(migration, /proof workspace activation requires an accepted proof baseline/)
  assert.match(migration, /CREATE TRIGGER gb_proof_workspaces_activation_gate/)
  assert.match(migration, /BEFORE INSERT ON gb_proof_workspaces/)
  assert.match(migration, /ENABLE ALWAYS TRIGGER gb_proof_workspaces_activation_gate/)
  assert.doesNotMatch(migration, /BEFORE[^;]*(?:UPDATE|DELETE)[^;]*ON gb_proof_workspaces/)
  assert.doesNotMatch(migration, /DROP TRIGGER|CREATE OR REPLACE FUNCTION gb_guard_registered_proof_workspace/)
  assert.doesNotMatch(migration, /(?:INSERT INTO|UPDATE|DELETE FROM) gb_proof_workspaces/)
  assert.doesNotMatch(migration, /gb_proof_work_(?:items|transitions)/)
})

test("migration 027 registers immutable receipt-backed proof verification sets", async () => {
  const migration = await readFile(
    new URL("../db/migrations/027_proof_verification_sets.sql", import.meta.url),
    "utf8",
  )
  for (const table of ["gb_proof_verification_sets", "gb_proof_verification_records"]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`))
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`))
  }
  assert.match(migration, /CREATE TABLE gb_proof_verifier_adapters/)
  assert.match(migration, /adapter_id ~ '\^\[a-z0-9\]\[a-z0-9\._-\]\{0,79\}\$'/)
  assert.match(migration, /adapter_version ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9\._\+-\]\{0,39\}\$'/)
  assert.match(migration, /CHECK \(enabled\)/)
  assert.doesNotMatch(migration, /INSERT INTO gb_proof_verifier_adapters/)
  assert.match(migration, /adapter_implementation_sha256 TEXT NOT NULL/)
  assert.match(migration, /solution_sha256 = candidate_sha256/)
  assert.match(migration, /outcome TEXT NOT NULL CHECK \(outcome = 'accepted'\)/)
  assert.match(migration, /sorry_free BOOLEAN NOT NULL CHECK \(sorry_free\)/)
  assert.match(migration, /subject_json JSONB NOT NULL/)
  assert.match(migration, /REFERENCES gb_proof_verifier_adapters\(/)
  assert.match(migration, /REFERENCES gb_proof_graphs\(tenant_id, graph_id, content_sha256\)/)
  assert.match(migration, /REFERENCES gb_artifacts\(tenant_id, id, content_sha256\)/)
  assert.match(migration, /cardinality\(node_ids\) BETWEEN 0 AND 10000/)
  assert.match(migration, /gb_proof_verification_set_node_ids\(set_json\) = node_ids/)
  assert.match(migration, /NEW\.node_ids <@ graph\.target_ids/)
  assert.match(migration, /graph\.graph_kind <> 'repository-field'/)
  assert.match(migration, /artifact\.media_type <> 'application\/json'/)
  assert.match(migration, /decode\(expected\.receipt_content_base64, 'base64'\)/)
  assert.match(migration, /CREATE CONSTRAINT TRIGGER gb_proof_verification_sets_complete/)
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/)
  assert.match(migration, /persisted_count <> NEW\.item_count/)
  assert.match(migration, /proof verification registrations are append-only/)
  assert.match(migration, /CREATE TRIGGER gb_proof_verifier_adapters_append_only/)
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.gb_proof_verification_sets, public\.gb_proof_verification_records/)
  assert.match(migration, /REVOKE UPDATE, DELETE ON TABLE public\.gb_proof_verification_sets, public\.gb_proof_verification_records/)
  assert.doesNotMatch(migration, /INSERT INTO gb_proof_workspaces/)
  assert.doesNotMatch(migration, /INSERT INTO gb_proof_work_items/)
  assert.doesNotMatch(migration, /INSERT INTO gb_proof_work_transitions/)
})

test("migration 028 atomically activates only exact empty-baseline proof missions", async () => {
  const migration = await readFile(
    new URL("../db/migrations/028_proof_mission_activation.sql", import.meta.url),
    "utf8",
  )
  for (const table of ["gb_proof_mission_activations", "gb_proof_mission_activation_nodes"]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`))
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`))
    assert.match(migration, new RegExp(`CREATE POLICY ${table}_tenant_isolation`))
  }
  assert.match(migration, /ADD COLUMN verifier_system TEXT NOT NULL/)
  assert.match(migration, /verifier_system IN \('hyades', 'lean-replay'\)/)
  assert.match(migration, /ADD COLUMN verification_method TEXT NOT NULL/)
  assert.match(migration, /verifier_system = 'hyades' AND verification_method = 'hyades-run'/)
  assert.match(migration, /verifier_system = 'lean-replay' AND verification_method = 'lean-replay'/)
  assert.match(migration, /verifier_system = 'hyades' AND provider_run_ref IS NOT NULL/)
  assert.match(migration, /verifier_system = 'lean-replay' AND provider_run_ref IS NULL/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, source_graph_id, source_graph_sha256\)/)
  assert.match(migration, /REFERENCES gb_proof_graphs\(tenant_id, graph_id, content_sha256\)/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, mission_intent_artifact_id, mission_intent_sha256\)/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, verification_set_id, verification_set_sha256\)/)
  assert.match(migration, /REFERENCES gb_proof_verification_sets\(tenant_id, id, content_sha256\)/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_activate_proof_mission\(/)
  assert.match(migration, /SECURITY DEFINER/)
  assert.match(migration, /SET search_path = pg_catalog, public/)
  assert.match(migration, /tenant_context IS DISTINCT FROM p_tenant_id/)
  assert.match(migration, /principal_context IS DISTINCT FROM p_activated_by_principal_id/)
  assert.match(migration, /agent\.nostr_pubkey = p_activated_by_nostr_pubkey/)
  assert.match(migration, /nostr_key\.pubkey = p_activated_by_nostr_pubkey/)
  assert.match(migration, /pg_advisory_xact_lock\(/)
  assert.match(migration, /hashtextextended\(p_tenant_id::text \|\| ':' \|\| p_idempotency_key, 0\)/)
  assert.match(migration, /source_graph\.graph_kind <> 'repository-field'/)
  assert.match(migration, /verification_set\.graph_id IS DISTINCT FROM p_source_graph_id/)
  assert.match(migration, /verification_set\.graph_content_sha256 IS DISTINCT FROM p_source_graph_sha256/)
  assert.match(migration, /verification_set\.item_count <> 0/)
  assert.match(migration, /non-empty proof verification baselines are not activatable yet/)
  assert.match(migration, /derived_verified_ids := '\{\}'/)
  assert.match(migration, /mission intent JSON does not match its exact artifact/)
  assert.match(migration, /mission graph JSON does not match its exact artifact/)
  assert.match(migration, /galaxy\.proof-mission-compiler\.v1/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_proof_mission_target_projection/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_proof_mission_relation_projection/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_expected_proof_mission_graph/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_js_utf16_sort_key/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_proof_mission_source_metadata_valid/)
  assert.match(migration, /IF NOT gb_proof_mission_source_metadata_valid\(source_graph\.graph_json\)/)
  assert.match(migration, /OR NOT nomination \? 'nominated'/)
  assert.match(
    migration,
    /ORDER BY gb_js_utf16_sort_key\(relation\.value ->> 'relation_id'\) COLLATE "C"/,
  )
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_python_trim/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_text_array_sorted_c/)
  assert.match(migration, /\\00A0\\1680\\2000-\\200A/)
  assert.match(migration, /ORDER BY value COLLATE "C"/)
  assert.match(migration, /mission targets do not match the exact source projection/)
  assert.match(migration, /mission graph is not the canonical source projection/)
  assert.match(migration, /derived_main_target_id = ANY\(derived_milestones\)/)
  assert.match(migration, /WITH RECURSIVE prerequisite_closure/)
  assert.match(migration, /derived_main_target_id = ANY\(source_graph\.target_ids\)/)
  assert.match(migration, /derived_target_ids <@ source_graph\.target_ids/)
  assert.match(migration, /gb_text_array_sorted_c\(derived_target_ids\) <> expected_target_ids/)
  assert.match(migration, /mission relations do not match the exact source closure/)
  assert.match(migration, /CREATE TRIGGER gb_proof_graphs_activation_guard/)
  assert.match(migration, /claimable proof graphs require atomic mission activation/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_reject_unactivated_proof_workspace_insert\(\)/)
  assert.match(migration, /activation\.verification_set_sha256|verification_set_sha256/)
  assert.match(migration, /CREATE CONSTRAINT TRIGGER gb_proof_mission_activation_complete/)
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/)
  assert.match(migration, /NOT node\.prerequisite_node_ids <@ NEW\.target_ids/)
  assert.match(migration, /proof mission activations are append-only/)
  assert.match(migration, /REVOKE ALL ON FUNCTION gb_activate_proof_mission/)
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.gb_proof_mission_activations/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.gb_activate_proof_mission/)
  assert.doesNotMatch(migration, /INSERT INTO public\.gb_proof_work_transitions/)
  assert.doesNotMatch(migration, /INSERT INTO public\.gb_task_plans/)

  const provisioner = await readFile(
    new URL("./provision-local-runtime-roles.mjs", import.meta.url),
    "utf8",
  )
  assert.match(provisioner, /"gb_proof_verification_sets"/)
  assert.match(provisioner, /"gb_proof_verification_records"/)
  assert.match(provisioner, /const apiReadOnlyTables = \[/)
  assert.match(provisioner, /"gb_proof_mission_activations"/)
  assert.match(provisioner, /"gb_proof_mission_activation_nodes"/)
  assert.match(provisioner, /GRANT SELECT ON TABLE \$\{apiReadOnlyTables/)
  assert.match(provisioner, /GRANT EXECUTE ON FUNCTION gb_activate_proof_mission/)
  assert.match(provisioner, /REVOKE ALL ON FUNCTION gb_activate_proof_mission/)

  const verifier = await readFile(new URL("./db-verify.mjs", import.meta.url), "utf8")
  assert.match(verifier, /to_regprocedure\(/)
  assert.match(verifier, /gb_activate_proof_mission\(uuid,text,text,uuid,text,jsonb,uuid,text,jsonb,uuid,text,text,uuid,text,text,text\)/)
  assert.match(verifier, /procedure\.prosecdef/)
  assert.match(verifier, /search_path=pg_catalog, public/)
  assert.match(verifier, /privilege\.grantee = 0/)
  assert.match(verifier, /activation_tables_use_rls/)
  assert.match(verifier, /proofMissionActivationBoundary/)
})

test("migration 029 seals accepted live proof verification behind a future authority", async () => {
  const migration = await readFile(
    new URL("../db/migrations/029_trusted_proof_verification.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /CREATE TABLE gb_proof_work_verifications/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, workspace_id, node_id\)/)
  assert.match(migration, /REFERENCES gb_proof_work_items\(tenant_id, workspace_id, node_id\)/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, receipt_artifact_id, receipt_content_sha256\)/)
  assert.match(migration, /REFERENCES gb_artifacts\(tenant_id, id, content_sha256\)/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, actor_principal_id\)/)
  assert.match(migration, /REFERENCES app_tenant_memberships\(tenant_id, principal_id\)/)
  assert.match(migration, /FOREIGN KEY \(adapter_id, adapter_version, adapter_implementation_sha256\)/)
  assert.match(migration, /REFERENCES gb_proof_verifier_adapters\(/)
  assert.match(migration, /verifier_system TEXT NOT NULL/)
  assert.match(migration, /verification_method TEXT NOT NULL/)
  assert.match(migration, /solution_sha256 = candidate_sha256/)
  assert.match(migration, /verifier_system = 'hyades'\s+AND hyades_run IS NOT NULL/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, subject_graph_id, subject_graph_content_sha256\)/)
  assert.match(migration, /subject_declaration_ids TEXT\[\] NOT NULL/)
  assert.match(migration, /source_repository TEXT NOT NULL/)
  assert.match(migration, /source_commit TEXT NOT NULL/)
  assert.match(migration, /lean_toolchain TEXT NOT NULL/)
  assert.match(migration, /mathlib_revision TEXT NOT NULL/)
  assert.match(migration, /verified_at TIMESTAMPTZ NOT NULL/)
  assert.match(migration, /hyades_run ->> 'workflow_id' IS NOT NULL/)
  assert.match(migration, /hyades_run ->> 'run_id' IS NOT NULL/)
  assert.match(migration, /'status', 'completed'/)
  assert.match(migration, /outcome TEXT NOT NULL DEFAULT 'accepted' CHECK \(outcome = 'accepted'\)/)
  assert.match(migration, /sorry_free BOOLEAN NOT NULL DEFAULT TRUE CHECK \(sorry_free\)/)
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_key\)/)
  assert.match(migration, /CREATE POLICY gb_proof_work_verifications_tenant_isolation/)
  assert.match(migration, /proof work verifications are append-only/)
  assert.match(migration, /CREATE TRIGGER gb_proof_work_verifications_insert_guard/)
  assert.match(migration, /current_user IS DISTINCT FROM table_owner/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_record_accepted_proof_verification\(/)
  assert.match(migration, /SECURITY DEFINER/)
  assert.match(migration, /SET search_path = pg_catalog, public/)
  assert.match(migration, /tenant_context IS DISTINCT FROM p_tenant_id/)
  assert.match(migration, /principal_context IS DISTINCT FROM p_actor_principal_id/)
  assert.match(migration, /agent\.nostr_pubkey = p_actor_nostr_pubkey/)
  assert.match(migration, /nostr_key\.pubkey = p_actor_nostr_pubkey/)
  assert.match(migration, /pg_advisory_xact_lock\(/)
  assert.match(migration, /proof verification idempotency conflict/)
  assert.match(migration, /JOIN public\.gb_proof_mission_activations/)
  assert.match(migration, /JOIN public\.gb_proof_mission_activation_nodes/)
  assert.match(migration, /work_item\.state #>> '\{proof,status\}' NOT IN \('candidate', 'attested'\)/)
  assert.match(migration, /work_item\.state #>> '\{proof,candidate_sha256\}'/)
  assert.match(migration, /proof verification subject is not an exact formal target/)
  assert.match(migration, /proof verification evidence does not match the registered graph subject/)
  assert.match(migration, /receipt_artifact\.byte_size NOT BETWEEN 1 AND 1048576/)
  assert.match(migration, /adapter\.implementation_sha256 = p_adapter_implementation_sha256/)
  assert.match(migration, /adapter\.enabled/)
  assert.match(migration, /REVOKE ALL ON TABLE gb_proof_work_verifications FROM PUBLIC/)
  assert.match(migration, /REVOKE ALL ON FUNCTION gb_record_accepted_proof_verification/)
  assert.match(migration, /GRANT SELECT ON TABLE public\.gb_proof_work_verifications/)
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.gb_proof_work_verifications/)
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION public\.gb_record_accepted_proof_verification/)
  assert.doesNotMatch(migration, /INSERT INTO gb_proof_verifier_adapters/)

  const provisioner = await readFile(
    new URL("./provision-local-runtime-roles.mjs", import.meta.url),
    "utf8",
  )
  assert.match(provisioner, /apiReadOnlyTables[\s\S]*"gb_proof_work_verifications"/)
  assert.match(provisioner, /REVOKE ALL ON FUNCTION gb_record_accepted_proof_verification/)
  assert.doesNotMatch(provisioner, /GRANT EXECUTE ON FUNCTION gb_record_accepted_proof_verification/)

  const verifier = await readFile(new URL("./db-verify.mjs", import.meta.url), "utf8")
  assert.match(verifier, /gb_record_accepted_proof_verification\(uuid,uuid,text,text,uuid,text,text,text,text,text,text,text,text,text\[\],text,text,text,text,timestamp with time zone,jsonb,uuid,text,text,text\)/)
  assert.match(verifier, /authority_only_execute/)
  assert.match(verifier, /gb_proof_work_verifications_insert_guard/)
  assert.match(verifier, /gb_proof_work_verifications_append_only/)
  assert.match(verifier, /trustedProofVerificationBoundary/)
})

test("migration 048 grants the sealed registrar only to the proofs.blah.dev verifier authority", async () => {
  const migration = await readFile(
    new URL("../db/migrations/049_proofs_blah_dev_verifier_authority.sql", import.meta.url),
    "utf8",
  )
  const adapterSource = await readFile(
    new URL("../services/galaxy-brain-api/proofs_blah_dev_adapter.py", import.meta.url),
    "utf8",
  )
  assert.match(migration, /CREATE ROLE gb_proof_verifier\s+NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION\s+NOBYPASSRLS/)
  assert.match(migration, /gb_proof_verifier must be a restricted NOLOGIN role/)
  assert.match(migration, /attribute\.attname IN \('verifier_system', 'verification_method'\)/)
  assert.match(migration, /IF dropped <> 3 THEN/)
  for (const table of ["gb_proof_work_verifications", "gb_proof_verification_records"]) {
    assert.match(migration, new RegExp(`ADD CONSTRAINT ${table}_verifier_system_check CHECK \\(\\s+verifier_system IN \\('hyades', 'lean-replay', 'proofs-blah-dev'\\)`))
    assert.match(migration, new RegExp(`ADD CONSTRAINT ${table}_verification_method_check`))
  }
  assert.equal(
    migration.match(/\(verifier_system = 'proofs-blah-dev' AND verification_method = 'signed-report'\)/g).length,
    2,
  )
  assert.match(migration, /\(verifier_system IN \('lean-replay', 'proofs-blah-dev'\) AND hyades_run IS NULL\)/)
  assert.match(migration, /\(verifier_system IN \('lean-replay', 'proofs-blah-dev'\) AND provider_run_ref IS NULL\)/)
  assert.doesNotMatch(migration, /'prove2me'/i)
  assert.match(migration, /CREATE OR REPLACE FUNCTION gb_record_accepted_proof_verification\(/)
  assert.match(migration, /SECURITY DEFINER\s+SET search_path = pg_catalog, public/)
  assert.match(migration, /p_verifier_system NOT IN \('hyades', 'lean-replay', 'proofs-blah-dev'\)/)
  assert.match(migration, /p_verifier_system = 'proofs-blah-dev' AND p_verification_method <> 'signed-report'/)
  assert.match(migration, /p_verifier_system IN \('lean-replay', 'proofs-blah-dev'\) AND p_hyades_run IS NOT NULL/)
  assert.match(migration, /proof verification evidence does not match the registered graph subject/)

  const registered = migration.match(/'proofs-blah-dev', '1', '([0-9a-f]{64})', TRUE/)
  assert.ok(registered)
  assert.equal(
    registered[1],
    createHash("sha256").update(adapterSource.replace(/\r\n/g, "\n")).digest("hex"),
  )

  assert.match(migration, /GRANT EXECUTE ON FUNCTION gb_record_accepted_proof_verification\([\s\S]*?\) TO gb_proof_verifier;/)
  assert.match(migration, /GRANT SELECT, UPDATE ON TABLE gb_proof_workspaces, gb_proof_work_items\s+TO gb_proof_verifier;/)
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE gb_proof_work_transitions, gb_artifacts\s+TO gb_proof_verifier;/)
  assert.match(migration, /GRANT SELECT ON TABLE gb_proof_work_verifications TO gb_proof_verifier;/)
  assert.doesNotMatch(migration, /GRANT [^;]*INSERT[^;]*gb_proof_work_verifications/)
  assert.doesNotMatch(migration, /GRANT [^;]*(?:DELETE|TRUNCATE)/)
  assert.match(migration, /'REVOKE gb_proof_verifier FROM %I'/)
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.gb_record_accepted_proof_verification\([^']*\) FROM %I/)
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.gb_proof_work_verifications FROM %I/)
  assert.doesNotMatch(migration, /DROP TRIGGER|DISABLE TRIGGER/)

  const provisioner = await readFile(
    new URL("./provision-local-runtime-roles.mjs", import.meta.url),
    "utf8",
  )
  assert.match(provisioner, /LOCAL_VERIFIER_DATABASE_ROLE/)
  assert.match(provisioner, /GRANT gb_proof_verifier TO %I/)
  assert.match(provisioner, /local runtime roles can assume the trusted proof verifier authority/)
  assert.doesNotMatch(provisioner, /GRANT EXECUTE ON FUNCTION gb_record_accepted_proof_verification/)

  const verifier = await readFile(new URL("./db-verify.mjs", import.meta.url), "utf8")
  assert.match(verifier, /restricted_verifier_authority/)
  assert.match(verifier, /verifier_members_respect_rls/)
  assert.match(verifier, /proofs_blah_dev_adapter_registered/)

  const api = await readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8")
  assert.match(api, /GB_PROOF_VERIFIER_DATABASE_URL/)
  assert.match(api, /SET LOCAL ROLE gb_proof_verifier/)
  assert.match(api, /API database role can assume the trusted proof verifier authority/)
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8")
  assert.match(
    compose,
    /GB_PROOF_VERIFIER_DATABASE_URL: \$\{GALAXY_DEPLOY_GB_PROOF_VERIFIER_DATABASE_URL:-\}/,
  )
})

test("migration 020 creates an immutable tenant-scoped durable ingestion spine", async () => {
  const migration = await readFile(new URL("../db/migrations/020_durable_ingestion.sql", import.meta.url), "utf8")
  for (const table of [
    "gb_artifacts", "gb_artifact_sources", "gb_documents", "gb_document_revisions",
    "gb_document_representations", "gb_transform_receipts", "gb_document_anchors",
    "gb_document_chunks",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`))
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`))
  }
  assert.match(migration, /content_bytes BYTEA NOT NULL/)
  assert.match(migration, /UNIQUE \(tenant_id, content_sha256\)/)
  assert.match(migration, /digest\(content_bytes, 'sha256'\)/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, source_id, original_artifact_id\)/)
  assert.match(migration, /REFERENCES gb_artifact_sources\(tenant_id, id, artifact_id\)/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, id, current_revision_id, current_version\)/)
  assert.match(migration, /REFERENCES gb_document_revisions\(tenant_id, document_id, id, version\)/)
  assert.match(migration, /gb_reject_ingestion_evidence_mutation/)
  assert.match(migration, /REFERENCES app_principals\(id\) ON DELETE RESTRICT/)
  assert.match(migration, /plugin_id TEXT NOT NULL/)
  assert.match(migration, /plugin_version TEXT NOT NULL/)
  assert.match(migration, /status IN \('success', 'partial', 'fallback', 'failed', 'skipped'\)/)
  assert.match(migration, /output_manifest JSONB NOT NULL/)
  assert.match(migration, /fallback_receipt_id UUID/)
  assert.match(migration, /digest\(convert_to\(config_json::text, 'UTF8'\), 'sha256'\)/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, document_revision_id, input_artifact_id\)/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, input_artifact_id, input_sha256\)/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, document_revision_id, output_representation_id, output_sha256\)/)
  assert.match(migration, /digest\(convert_to\(text_content, 'UTF8'\), 'sha256'\)/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, representation_id, representation_sha256\)/)
  assert.match(migration, /REFERENCES gb_document_representations\(tenant_id, id, content_sha256\)/)
  assert.doesNotMatch(migration, /diagnostic TEXT/)
  assert.doesNotMatch(migration, /GRANT[^;]*UPDATE[^;]*gb_artifacts/)
})

test("migration 043 aligns datasource provenance with the durable import contract", async () => {
  const migration = await readFile(
    new URL("../db/migrations/043_durable_ingestion_source_kinds.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /DROP CONSTRAINT IF EXISTS gb_artifact_sources_source_kind_check/u)
  assert.match(migration, /'upload', 'url', 'arxiv', 'legacy-paper', 'datasource'/u)
  assert.doesNotMatch(migration, /CREATE TABLE|ADD COLUMN|UPDATE gb_artifact_sources/u)
})

test("migration 042 reserves immutable exact-revision task-plan dispatch intents", async () => {
  const migration = await readFile(
    new URL("../db/migrations/042_task_plan_dispatch_intents.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /CREATE TABLE gb_task_plan_dispatch_intents/u)
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_key\)/u)
  assert.match(migration, /REFERENCES gb_task_plan_revisions\(tenant_id, task_plan_id, version\)/u)
  assert.match(migration, /BEFORE UPDATE OR DELETE ON gb_task_plan_dispatch_intents/u)
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u)
  assert.match(migration, /GRANT SELECT, INSERT/u)
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE/u)
  const api = await readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8")
  const provisioner = await readFile(new URL("./provision-local-runtime-roles.mjs", import.meta.url), "utf8")
  assert.match(api, /"gb_task_plan_dispatch_intents": frozenset\(\("select", "insert"\)\)/u)
  assert.match(api, /"gb_task_plan_dispatch_intents": frozenset\(\("update", "delete", "truncate"\)\)/u)
  assert.match(provisioner, /apiImmutableInsertTables[\s\S]*"gb_task_plan_dispatch_intents"/u)
})

test("migration 041 records append-only human proposal decisions without proof semantics", async () => {
  const migration = await readFile(
    new URL("../db/migrations/041_object_link_proposal_decisions.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /CREATE TABLE gb_object_link_proposal_decisions/u)
  assert.match(migration, /decision IN \('accepted', 'rejected'\)/u)
  assert.match(migration, /UNIQUE \(tenant_id, proposal_id\)/u)
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_key\)/u)
  assert.match(migration, /REFERENCES gb_object_links\(tenant_id, id\)/u)
  assert.match(migration, /REFERENCES app_principals\(id\) ON DELETE RESTRICT/u)
  assert.doesNotMatch(migration, /FOREIGN KEY \(tenant_id, created_by_principal_id\)/u)
  assert.match(migration, /CREATE FUNCTION gb_validate_object_link_proposal_decision_actor/u)
  assert.match(migration, /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, public/u)
  assert.match(migration, /FROM public\.app_principals AS principal/u)
  assert.match(migration, /membership\.tenant_id = NEW\.tenant_id/u)
  assert.match(migration, /membership\.principal_id = NEW\.created_by_principal_id/u)
  assert.match(migration, /principal\.kind = 'human'/u)
  assert.match(migration, /FOR KEY SHARE/u)
  assert.match(migration, /FOR SHARE/u)
  assert.match(migration, /gb_object_link_proposal_decisions_actor_guard/u)
  assert.match(migration, /BEFORE INSERT ON gb_object_link_proposal_decisions/u)
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/u)
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u)
  assert.match(migration, /BEFORE UPDATE OR DELETE/u)
  assert.match(migration, /GRANT SELECT, INSERT/u)
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE/u)
  assert.doesNotMatch(migration, /gb_proof|proof_status|verification_status/u)
})

test("migration 040 binds exact passive formal-project package artifacts", async () => {
  const [migration, api, proxy, scope] = await Promise.all([
    readFile(new URL("../db/migrations/040_formal_project_packages.sql", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8"),
    readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/eln-scope.js", import.meta.url), "utf8"),
  ])
  assert.match(migration, /CREATE TABLE gb_formal_project_packages/u)
  assert.match(migration, /UNIQUE \(tenant_id, manifest_sha256\)/u)
  assert.match(migration, /REFERENCES gb_artifacts\(tenant_id, id, content_sha256\)/u)
  assert.match(migration, /REFERENCES gb_proof_graphs\(tenant_id, graph_id, content_sha256\)/u)
  assert.match(migration, /projected_graph\.graph_kind <> 'repository-field'/u)
  assert.match(migration, /graph_json #>> '\{source_revision,repository\}'[\s\S]*NEW\.repository/u)
  assert.match(migration, /graph_json #>> '\{source_revision,commit\}'[\s\S]*NEW\.commit_oid/u)
  assert.match(migration, /manifest_artifact\.media_type <> 'application\/json'/u)
  assert.match(migration, /manifest_artifact\.byte_size < 1[\s\S]*manifest_artifact\.byte_size > 65536/u)
  assert.match(migration, /authored_artifact\.media_type <> 'application\/json'/u)
  assert.match(migration, /authored_artifact\.byte_size < 1[\s\S]*authored_artifact\.byte_size > 16777216/u)
  assert.match(migration, /correspondence_artifact\.byte_size < 1[\s\S]*correspondence_artifact\.byte_size > 16777216/u)
  assert.match(migration, /authored ->> 'schemaVersion'[\s\S]*rosetta-authored-conceptual-dag\/1\.0\.0/u)
  assert.match(migration, /authored ->> 'project'[\s\S]*NEW\.project_id/u)
  assert.match(migration, /authored ->> 'revision'[\s\S]*NEW\.commit_oid/u)
  assert.match(migration, /correspondence ->> 'schemaVersion'[\s\S]*rosetta-authored-formal-correspondence\/1\.0\.0/u)
  assert.match(migration, /correspondence ->> 'project'[\s\S]*NEW\.project_id/u)
  assert.match(migration, /correspondence ->> 'revision'[\s\S]*NEW\.commit_oid/u)
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u)
  assert.match(migration, /formal project packages are append-only/u)
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.gb_formal_project_packages/u)
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public\.gb_formal_project_packages/u)
  assert.match(api, /parse_formal_project_package_envelope/u)
  assert.match(api, /_persist_passive_proof_graph/u)
  assert.match(api, /@app\.post\("\/formal-project-packages"/u)
  assert.match(api, /"gb_formal_project_packages": frozenset\(\("select", "insert"\)\)/u)
  assert.match(api, /"gb_formal_project_packages": frozenset\(\("update", "delete", "truncate"\)\)/u)
  assert.match(proxy, /MAX_FORMAL_PROJECT_PACKAGE_BODY_BYTES = 50_397_208/u)
  assert.match(proxy, /getVerifiedNostrRequestIdentity\(request, signedMutationBody\)/u)
  assert.match(scope, /path\[0\] === "formal-project-packages"[\s\S]*proof-graph:write/u)
  for (const forbidden of ["gb_proof_workspaces", "gb_proof_work_items", "gb_proof_work_transitions"]) {
    assert.doesNotMatch(migration, new RegExp(`INSERT INTO ${forbidden}`, "u"))
  }
})

test("migration 039 gives local document chunks versioned deterministic identities", async () => {
  const migration = await readFile(
    new URL("../db/migrations/039_document_chunk_identity.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /gb\.document-chunk\.legacy\.v0/)
  assert.match(migration, /gb\.document-chunk\.v1/)
  const disableTrigger = migration.indexOf("DISABLE TRIGGER gb_document_chunks_append_only")
  const legacyBackfill = migration.indexOf("UPDATE gb_document_chunks")
  const enableTrigger = migration.indexOf("ENABLE TRIGGER gb_document_chunks_append_only")
  assert.ok(disableTrigger >= 0 && disableTrigger < legacyBackfill)
  assert.ok(enableTrigger > legacyBackfill)
  assert.match(migration, /CREATE TABLE gb_document_chunk_manifests/)
  assert.match(migration, /gb\.document-chunk-manifest\.v1/)
  assert.match(migration, /ALTER TABLE gb_document_chunk_manifests ENABLE ROW LEVEL SECURITY/)
  assert.match(migration, /gb_document_chunk_manifests_append_only/)
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.gb_document_chunk_manifests/)
  assert.match(migration, /selector_canonical::jsonb = selector_json/)
  assert.match(migration, /chunker_config_canonical::jsonb = chunker_config_json/)
  assert.match(migration, /digest\(convert_to\(identity_canonical, 'UTF8'\), 'sha256'\)/)
  assert.match(migration, /DROP CONSTRAINT gb_document_chunks_pkey/)
  assert.match(migration, /PRIMARY KEY \(tenant_id, representation_id, id\)/)
  assert.match(migration, /DROP CONSTRAINT gb_document_chunks_tenant_id_representation_id_ordinal_key/)
  assert.match(migration, /UNIQUE \(\s*tenant_id, representation_id, identity_version,\s*chunker, chunker_version, chunker_config_sha256, ordinal\s*\)/)
  assert.doesNotMatch(migration, /CREATE TABLE gb_(?:object_links|relation_proposals|ham_)/)
})

test("migration 044 opts one exact partial FTS index into verified concurrent creation", async () => {
  const migration = await readFile(
    new URL("../db/migrations/044_document_chunk_search.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /^-- galaxy-migration: concurrent-index-v1 /u)
  assert.match(migration, /CREATE INDEX CONCURRENTLY idx_gb_document_chunks_v1_fts_simple/u)
  assert.match(migration, /ON public\.gb_document_chunks/u)
  assert.match(migration, /USING GIN \(to_tsvector\('simple'::regconfig, text_content\)\)/u)
  assert.match(migration, /WHERE identity_version = 'gb\.document-chunk\.v1'/u)
  assert.doesNotMatch(migration, /CREATE TABLE|INSERT INTO|UPDATE |DELETE FROM/u)
})

test("migration 045 adds only the explicit tenant-scoped canvas plus conversation bundle mode", async () => {
  const migration = await readFile(
    new URL("../db/migrations/045_canvas_conversation_share_bundles.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /canvas-plus-conversation/u)
  assert.match(migration, /gb\.share-bundle\.v2/u)
  assert.match(migration, /gb\.share-bundle\.v1' AND mode IN \('object-only', 'canvas-only'\)/u)
  assert.match(migration, /access = 'tenant-read'/u)
  assert.match(migration, /octet_length\(snapshot_json::text\) <= 8500000/u)
  assert.doesNotMatch(migration, /public-read[^\n]*canvas-plus-conversation|CREATE TABLE|INSERT INTO|UPDATE |DELETE FROM/u)
})

test("migration 046 adds only bounded presentation frames to the canvas aggregate", async () => {
  const migration = await readFile(
    new URL("../db/migrations/046_canvas_frames.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /ALTER TABLE gb_canvases/u)
  assert.match(migration, /frames_json JSONB NOT NULL DEFAULT '\[\]'::jsonb/u)
  assert.match(migration, /jsonb_typeof\(frames_json\) = 'array'/u)
  assert.match(migration, /jsonb_array_length\(frames_json\) <= 100/u)
  assert.match(migration, /octet_length\(frames_json::text\) <= 262144/u)
  assert.doesNotMatch(migration, /CREATE TABLE|GRANT|subject_ref|semantic_ref/u)
})

test("local API runtime provisions durable ingestion and conversation tables with least privilege", async () => {
  const provisioner = await readFile(new URL("./provision-local-runtime-roles.mjs", import.meta.url), "utf8")
  assert.match(provisioner, /proofMutableTables[\s\S]*"gb_documents"/)
  assert.match(provisioner, /proofMutableTables[\s\S]*"gb_conversations"/)
  for (const table of [
    "gb_artifacts", "gb_artifact_sources", "gb_document_revisions",
    "gb_document_representations", "gb_transform_receipts", "gb_document_anchors",
    "gb_document_chunks", "gb_document_chunk_manifests", "gb_object_link_proposals",
    "gb_object_link_proposal_decisions", "gb_transform_request_keys",
    "gb_conversation_revisions", "gb_conversation_turns",
    "gb_conversation_turn_revisions", "gb_conversation_edges",
  ]) {
    assert.match(provisioner, new RegExp(`apiImmutableInsertTables[\\s\\S]*"${table}"`))
  }
})


test("Nostr sessions retain the exact public key that authenticated", async () => {
  const migration = await readFile(
    new URL("../db/migrations/011_session_nostr_identity.sql", import.meta.url),
    "utf8",
  )
  const auth = await readFile(new URL("../lib/auth.ts", import.meta.url), "utf8")
  const login = await readFile(new URL("../app/api/auth/nostr/verify/route.ts", import.meta.url), "utf8")
  assert.match(migration, /auth_method IN \('password', 'passkey', 'nostr'\)/)
  assert.match(migration, /nostr_pubkey TEXT REFERENCES app_nostr_keys\(pubkey\) ON DELETE CASCADE/)
  assert.match(migration, /auth_method = 'nostr' AND nostr_pubkey IS NOT NULL/)
  assert.match(auth, /s\.auth_method AS "authMethod"/)
  assert.match(auth, /s\.nostr_pubkey AS "nostrPubkey"/)
  assert.match(login, /method: "nostr", pubkey: event\.pubkey/)
})

test("agent identity is a Nostr key with replay defense and no active legacy bearer", async () => {
  const migration = await readFile(
    new URL("../db/migrations/011_session_nostr_identity.sql", import.meta.url),
    "utf8",
  )
  const provisioner = await readFile(new URL("./provision-local-runtime-roles.mjs", import.meta.url), "utf8")
  assert.match(migration, /ADD COLUMN IF NOT EXISTS nostr_pubkey TEXT/)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS scopes TEXT\[\]/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS app_nostr_auth_events/)
  assert.match(migration, /event_id TEXT PRIMARY KEY/)
  assert.match(migration, /SET revoked_at = COALESCE\(token\.revoked_at, now\(\)\)/)
  assert.match(migration, /human and agent Nostr keys must be distinct/)
  assert.match(provisioner, /"app_nostr_auth_events"/)
})

test("the production cutover runbook registers agent public keys without bearer tokens", async () => {
  const runbook = await readFile(
    new URL("../docs/NEON_TO_POSTGRES_MIGRATION.md", import.meta.url),
    "utf8",
  )
  assert.match(runbook, /registers only the agent's public key/)
  assert.match(runbook, /fresh NIP-98\s+proof/)
  assert.doesNotMatch(runbook, /returned token|agent bearer tokens/)
})

test("database verification permits immutable historical surface identities", async () => {
  const verify = await readFile(new URL("./db-verify.mjs", import.meta.url), "utf8")
  assert.match(verify, /AS historical_revisions/)
  assert.match(verify, /surface\.schema_digest IS DISTINCT FROM revision\.schema_digest/)
  assert.match(verify, /currentSurfaceIdentityMismatch = surfaceIdentity\.rows\[0\]\.current_surface_mismatches !== "0"/)
  assert.doesNotMatch(verify, /Object\.values\(surfaceIdentity/)
})

test("migration 006 rows receive a distinct legacy contract identity", async () => {
  const migration = await readFile(
    new URL("../db/migrations/007_surface_contract_identity.sql", import.meta.url),
    "utf8",
  )
  const manifest = JSON.parse(await readFile(
    new URL("../services/galaxy-brain-api/contracts/gb.surface.v1.json", import.meta.url),
    "utf8",
  ))
  const assignedDigests = [...migration.matchAll(/(?:schema|catalog)_digest = '([0-9a-f]{64})'/g)]
    .map((match) => match[1])
  const legacySchemaDigest = createHash("sha256").update("gb.surface.v1:migration-006-unvalidated").digest("hex")
  const legacyCatalogDigest = createHash("sha256").update("generous.a2ui:migration-006-unvalidated").digest("hex")

  assert.equal(assignedDigests.length, 4)
  assert.deepEqual(new Set(assignedDigests), new Set([legacySchemaDigest, legacyCatalogDigest]))
  assert.ok(assignedDigests.every((digest) => !Object.values(manifest.digests).includes(digest)))
  assert.match(migration, /explicit legacy marker digests/)
  assert.match(migration, /did not validate the strict manifest/)
})

test("web and API runtimes verify migrations without schema DDL", async () => {
  const webDb = await readFile(new URL("../lib/db.ts", import.meta.url), "utf8")
  const api = await readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8")
  const verifier = await readFile(new URL("./db-verify.mjs", import.meta.url), "utf8")
  for (const source of [webDb, api]) {
    assert.doesNotMatch(source, /CREATE\s+(?:EXTENSION|TABLE|INDEX)/i)
    assert.doesNotMatch(source, /ALTER\s+TABLE/i)
    assert.match(source, /schema_migrations/)
  }
  for (const source of [webDb, api, verifier]) {
    assert.match(source, /014_paper_documents/)
    assert.match(source, /015_object_links/)
    assert.match(source, /016_object_link_retractions/)
    assert.match(source, /017_federated_object_links/)
    assert.match(source, /018_canvas_persistence/)
    assert.match(source, /019_canvas_multi_document/)
    assert.match(source, /020_durable_ingestion/)
    assert.match(source, /021_document_transform_execution/)
    assert.match(source, /022_document_transform_attempts/)
    assert.match(source, /023_document_anchor_objects/)
  }
})

test("durable canvases use tenant RLS, bounded placement rows, and an immutable revision ledger", async () => {
  const migration = await readFile(
    new URL("../db/migrations/018_canvas_persistence.sql", import.meta.url),
    "utf8",
  )
  const api = await readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8")
  const provisioner = await readFile(new URL("./provision-local-runtime-roles.mjs", import.meta.url), "utf8")
  for (const table of ["gb_canvases", "gb_canvas_items", "gb_canvas_edges", "gb_canvas_revisions"]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`))
    assert.match(migration, new RegExp(`CREATE POLICY ${table}_tenant_isolation`))
    assert.match(api, new RegExp(`TENANT_RLS_TABLES[\\s\\S]*["']${table}["']`))
    assert.match(provisioner, new RegExp(`"${table}"`))
  }
  assert.match(migration, /gb_canvas_revisions_append_only/)
  assert.match(migration, /canvas revisions are append-only/)
  assert.match(migration, /UNIQUE \(tenant_id, canvas_id, version\)/)
  assert.match(migration, /UNIQUE \(tenant_id, canvas_id, idempotency_key\)/)
  assert.match(migration, /UNIQUE \(tenant_id, workspace_id\)/)
  assert.equal((migration.match(/USING \(tenant_id = NULLIF\(current_setting\('app\.tenant_id'/g) || []).length, 4)
  assert.doesNotMatch(migration, /USING \([^)]*created_by_principal_id/)
  assert.match(migration, /removed_item_ids JSONB NOT NULL/)
  assert.match(migration, /removed_edge_ids JSONB NOT NULL/)
  assert.match(migration, /snapshot_json->>'schemaId' = 'gb\.canvas\.snapshot\.v1'/)
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.gb_canvas_revisions/)
  assert.doesNotMatch(migration, /GRANT[^;]*UPDATE[^;]*gb_canvas_revisions/)
  assert.match(api, /"gb_canvas_revisions": frozenset\(\("select", "insert"\)\)/)
  assert.match(api, /"gb_canvas_revisions": frozenset\(\("update", "delete"\)\)/)
})

test("canvas workspaces support named canvases with one durable default and removable memberships", async () => {
  const migration = await readFile(
    new URL("../db/migrations/019_canvas_multi_document.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /ADD COLUMN slug TEXT/)
  assert.match(migration, /ADD COLUMN is_default BOOLEAN/)
  assert.match(migration, /SET slug = 'main'/)
  assert.match(migration, /DROP CONSTRAINT gb_canvases_tenant_id_workspace_id_key/)
  assert.match(migration, /CREATE UNIQUE INDEX uq_gb_canvases_active_slug/)
  assert.match(migration, /CREATE UNIQUE INDEX uq_gb_canvases_active_default/)
  assert.match(migration, /WHERE is_default AND deleted_at IS NULL/)
  for (const table of ["gb_canvases", "gb_canvas_items", "gb_canvas_edges", "gb_canvas_revisions"]) {
    assert.match(
      migration,
      new RegExp(`DROP CONSTRAINT ${table}_tenant_id_created_by_principal_id_fkey`),
    )
    assert.match(
      migration,
      new RegExp(`ADD CONSTRAINT ${table}_created_by_principal_id_fkey[\\s\\S]*REFERENCES app_principals\\(id\\)`),
    )
  }
  assert.doesNotMatch(migration, /REFERENCES app_tenant_memberships\(tenant_id, principal_id\)/)
  assert.match(migration, /every active canvas workspace must have exactly one default/)
})

test("object links are tenant-scoped, append-only assertions with runtime least privilege", async () => {
  const migration = await readFile(new URL("../db/migrations/015_object_links.sql", import.meta.url), "utf8")
  const correctionMigration = await readFile(new URL("../db/migrations/016_object_link_retractions.sql", import.meta.url), "utf8")
  const federationMigration = await readFile(new URL("../db/migrations/017_federated_object_links.sql", import.meta.url), "utf8")
  const api = await readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8")
  const provisioner = await readFile(new URL("./provision-local-runtime-roles.mjs", import.meta.url), "utf8")
  assert.match(migration, /CREATE TABLE gb_object_links/)
  assert.match(migration, /CREATE POLICY gb_object_links_tenant_isolation/)
  assert.match(migration, /gb_object_links_append_only/)
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.gb_object_links/)
  assert.match(correctionMigration, /CREATE TABLE gb_object_link_retractions/)
  assert.match(correctionMigration, /CREATE POLICY gb_object_link_retractions_tenant_isolation/)
  assert.match(correctionMigration, /gb_object_link_retractions_append_only/)
  assert.match(correctionMigration, /UNIQUE \(tenant_id, link_id\)/)
  assert.match(correctionMigration, /GRANT SELECT, INSERT ON TABLE public\.gb_object_link_retractions/)
  assert.match(correctionMigration, /DROP CONSTRAINT gb_object_links_tenant_id_created_by_principal_id_fkey/)
  assert.match(correctionMigration, /REFERENCES app_principals\(id\) ON DELETE RESTRICT/)
  assert.doesNotMatch(correctionMigration, /REFERENCES app_tenant_memberships\(tenant_id, principal_id\)/)
  assert.match(federationMigration, /'formalized_by'/)
  assert.match(federationMigration, /'derived'/)
  assert.match(federationMigration, /source_snapshot/)
  assert.match(api, /"gb_object_links": frozenset\(\("select", "insert"\)\)/)
  assert.match(api, /"gb_object_links": frozenset\(\("update", "delete"\)\)/)
  assert.match(api, /"gb_object_link_retractions": frozenset\(\("select", "insert"\)\)/)
  assert.match(api, /"gb_object_link_retractions": frozenset\(\("update", "delete"\)\)/)
  assert.match(provisioner, /"gb_object_links"/)
  assert.match(provisioner, /"gb_object_link_retractions"/)
})

test("personal workspace invitations store only hashed one-time secrets and preserve runtime grants", async () => {
  const migration = await readFile(
    new URL("../db/migrations/010_personal_workspace_invitations.sql", import.meta.url),
    "utf8",
  )
  const roleProvisioner = await readFile(new URL("./provision-local-runtime-roles.mjs", import.meta.url), "utf8")
  assert.match(migration, /token_hash TEXT NOT NULL UNIQUE/)
  assert.doesNotMatch(migration, /\btoken\s+TEXT\b/)
  assert.match(migration, /accepted_user_id UUID REFERENCES app_users/)
  assert.match(migration, /REFERENCES app_tenant_memberships\(tenant_id, principal_id\)/)
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.app_registration_invitations/)
  assert.match(roleProvisioner, /"app_registration_invitations"/)
})

test("surface contract catalog is digest-pinned and served before dynamic routes", async () => {
  const manifestSource = await readFile(
    new URL("../services/galaxy-brain-api/contracts/gb.surface.v1.json", import.meta.url),
    "utf8",
  )
  const manifest = JSON.parse(manifestSource)
  const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    }
    return value
  }
  assert.equal(digest(canonical(manifest.schema)), manifest.digests.schema)
  assert.equal(digest(canonical(manifest.catalog)), manifest.digests.catalog)
  assert.equal(manifest.schema.id, "gb.surface.v1")
  assert.equal(manifest.catalog.id, "generous.a2ui")
  assert.equal(manifest.catalog.version, "1")
  assert.match(manifest.catalog.renderer.version, /^[0-9a-f]{40}$/)
  assert.ok(Object.keys(manifest.catalog.components).length >= 16)
  for (const [name, component] of Object.entries(manifest.catalog.components)) {
    assert.equal(component.propsSchema.type, "object", `${name} must declare an object prop schema`)
    assert.ok(Array.isArray(component.bindingTargets), `${name} must declare binding targets`)
  }

  const api = await readFile(
    new URL("../services/galaxy-brain-api/server.py", import.meta.url),
    "utf8",
  )
  const contractRoute = api.indexOf('@app.get("/surfaces/contract")')
  const dynamicRoute = api.indexOf('@app.get("/surfaces/{surface_id}")')
  assert.ok(contractRoute >= 0)
  assert.ok(dynamicRoute > contractRoute)
})

test("Compose gates both runtimes on the one-shot migrator and separate URLs", async () => {
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8")
  const localCompose = await readFile(new URL("../docker-compose.local-db.yml", import.meta.url), "utf8")
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8")
  const exampleEnv = await readFile(new URL("../.env.example", import.meta.url), "utf8")
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8")
  const roleProvisioner = await readFile(new URL("./provision-local-runtime-roles.mjs", import.meta.url), "utf8")
  const migratorStage = dockerfile
    .split("FROM base AS migrator", 2)[1]
    .split("FROM node:26-slim AS runner", 1)[0]
  assert.match(compose, /target: migrator/)
  assert.match(migratorStage, /scripts\/concurrent-index-migration\.mjs/)
  assert.match(compose, /DATABASE_MIGRATION_URL/)
  assert.match(compose, /GB_DATABASE_URL/)
  assert.match(compose, /condition: service_completed_successfully/)
  assert.match(localCompose, /provision-local-runtime-roles\.mjs/)
  assert.match(localCompose, /LOCAL_WEB_DATABASE_ROLE/)
  assert.match(localCompose, /LOCAL_API_DATABASE_ROLE/)
  assert.match(readme, /-f docker-compose\.local-db\.yml/)
  assert.match(exampleEnv, /DATABASE_URL=postgres:\/\/galaxy_brain_web:/)
  assert.match(exampleEnv, /GB_DATABASE_URL=postgres:\/\/galaxy_brain_api:/)
  assert.match(exampleEnv, /DATABASE_MIGRATION_URL=postgres:\/\/galaxy_brain_migrator:/)
  assert.match(compose, /GB_OBJECT_REFERENCE_RESOLVER_URL/)
  assert.match(compose, /GALAXY_DEPLOY_OBJECT_REFERENCE_RESOLVER_TOKEN/)
  assert.match(exampleEnv, /GB_OBJECT_REFERENCE_RESOLVER_TOKEN=/)
  assert.match(roleProvisioner, /NOBYPASSRLS/)
  assert.match(roleProvisioner, /NOINHERIT/)
  assert.match(roleProvisioner, /local runtime database roles must differ from the migration role/)
})

test("transfer requires explicit target confirmation and preserves checksums", async () => {
  const transfer = await readFile(new URL("./transfer-database.sh", import.meta.url), "utf8")
  assert.match(transfer, /RESTORE_CONFIRMATION/)
  assert.match(transfer, /restore-to-empty-galaxy-target/)
  assert.match(transfer, /sha256sum --check/)
  assert.match(transfer, /refusing restore/)
  assert.match(transfer, /write-pg-service\.mjs/)
  assert.match(transfer, /MIGRATION_SOURCE_MODE/)
  assert.match(transfer, /fresh-auth/)
  assert.match(transfer, /MIGRATION-MODE/)
  assert.match(transfer, /cd "\$artifact_dir"/)
  assert.match(transfer, /sha256sum --check SHA256SUMS/)
  assert.doesNotMatch(transfer, /checksum_files=\("\$artifact_dir/)
})

test("fresh-auth verification requires empty auth tables while preserving ELN comparisons", async () => {
  const compare = await readFile(new URL("./db-compare.mjs", import.meta.url), "utf8")
  assert.match(compare, /expectedFreshAuthCounts/)
  assert.match(compare, /app_tenants: "1"/)
  assert.match(compare, /Galaxy API/)
})

test("tenant and principal boundaries are enforced at the proxy and database", async () => {
  const migration = await readFile(new URL("../db/migrations/005_tenants_and_principals.sql", import.meta.url), "utf8")
  const proxy = await readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8")
  const api = await readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8")
  const roleProvisioner = await readFile(new URL("./provision-local-runtime-roles.mjs", import.meta.url), "utf8")
  assert.match(migration, /CREATE TABLE app_principals/)
  assert.match(migration, /CREATE TABLE app_tenant_memberships/)
  assert.match(migration, /CREATE TABLE app_agents/)
  assert.match(migration, /CREATE TABLE app_api_tokens/)
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, experiment_id\)/)
  assert.match(migration, /FOREIGN KEY \(tenant_id, connection_id\)/)
  const surfaceMigration = await readFile(new URL("../db/migrations/006_bounded_surfaces.sql", import.meta.url), "utf8")
  assert.match(surfaceMigration, /CREATE TABLE gb_surfaces/)
  assert.match(surfaceMigration, /CREATE TABLE gb_surface_revisions/)
  assert.match(surfaceMigration, /ENABLE ROW LEVEL SECURITY/)
  assert.match(surfaceMigration, /FOREIGN KEY \(tenant_id, surface_id\)/)
  assert.match(surfaceMigration, /has_table_privilege/)
  assert.match(surfaceMigration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.gb_surfaces/)
  const contractMigration = await readFile(
    new URL("../db/migrations/007_surface_contract_identity.sql", import.meta.url),
    "utf8",
  )
  assert.match(contractMigration, /ADD COLUMN schema_digest TEXT/)
  assert.match(contractMigration, /ADD COLUMN catalog_digest TEXT/)
  assert.match(contractMigration, /ADD COLUMN renderer_version TEXT/)
  assert.match(contractMigration, /ALTER COLUMN schema_digest SET NOT NULL/)
  assert.match(contractMigration, /has_table_privilege/)
  const paperMigration = await readFile(
    new URL("../db/migrations/008_research_papers.sql", import.meta.url),
    "utf8",
  )
  for (const table of ["gb_papers", "gb_paper_revisions", "gb_paper_annotations", "gb_paper_claims", "gb_claim_evidence_links", "gb_paper_task_links"]) {
    assert.match(paperMigration, new RegExp(`CREATE TABLE ${table}`))
  }
  assert.match(paperMigration, /ENABLE ROW LEVEL SECURITY/)
  assert.match(paperMigration, /REFERENCES gb_papers\(tenant_id, id\)/)
  assert.match(paperMigration, /paper_revision_id UUID NOT NULL/)
  assert.match(paperMigration, /REFERENCES gb_paper_revisions\(tenant_id, id\)/)
  assert.equal((paperMigration.match(/request_hash TEXT NOT NULL/g) || []).length, 2)
  const paperDocumentMigration = await readFile(
    new URL("../db/migrations/014_paper_documents.sql", import.meta.url),
    "utf8",
  )
  assert.match(paperDocumentMigration, /CREATE TABLE gb_paper_documents/)
  assert.match(paperDocumentMigration, /pdf_bytes BYTEA NOT NULL/)
  assert.match(paperDocumentMigration, /UNIQUE \(tenant_id, paper_revision_id\)/)
  assert.match(paperDocumentMigration, /octet_length\(pdf_bytes\) = byte_size/)
  assert.match(paperDocumentMigration, /GRANT SELECT, INSERT ON TABLE public\.gb_paper_documents/)
  assert.doesNotMatch(paperDocumentMigration, /GRANT[^;]*UPDATE/)
  assert.match(api, /"gb_paper_documents": frozenset\(\("select", "insert"\)\)/)
  assert.match(api, /"gb_paper_documents": frozenset\(\("update", "delete"\)\)/)
  const taskPlanMigration = await readFile(
    new URL("../db/migrations/009_task_plans.sql", import.meta.url),
    "utf8",
  )
  for (const table of ["gb_task_plans", "gb_task_plan_revisions"]) {
    assert.match(taskPlanMigration, new RegExp(`CREATE TABLE ${table}`))
    assert.match(api, new RegExp(`TENANT_RLS_TABLES[\\s\\S]*["']${table}["']`))
  }
  assert.match(taskPlanMigration, /UNIQUE \(tenant_id, ham_task_id\)/)
  assert.match(taskPlanMigration, /REFERENCES gb_task_plans\(tenant_id, id\)/)
  assert.match(taskPlanMigration, /ENABLE ROW LEVEL SECURITY/)
  const proofWorkMigration = await readFile(
    new URL("../db/migrations/012_proof_work_state.sql", import.meta.url),
    "utf8",
  )
  for (const table of ["gb_proof_workspaces", "gb_proof_work_items", "gb_proof_work_transitions"]) {
    assert.match(proofWorkMigration, new RegExp(`CREATE TABLE ${table}`))
    assert.match(api, new RegExp(`TENANT_RLS_TABLES[\\s\\S]*["']${table}["']`))
  }
  assert.match(proofWorkMigration, /graph_content_sha256 TEXT NOT NULL/)
  assert.match(proofWorkMigration, /'proof\.attest'/)
  assert.match(proofWorkMigration, /'proof\.override'/)
  assert.match(proofWorkMigration, /proof work transitions are append-only/)
  assert.match(proofWorkMigration, /ENABLE ROW LEVEL SECURITY/)
  const identityReadMigration = await readFile(
    new URL("../db/migrations/013_api_identity_read_permissions.sql", import.meta.url),
    "utf8",
  )
  assert.match(identityReadMigration, /GRANT SELECT ON TABLE public\.app_agents/)
  assert.match(identityReadMigration, /has_table_privilege\(role\.oid, 'public\.gb_task_plans', 'DELETE'\)/)
  assert.match(roleProvisioner, /app_tenant_memberships, app_agents TO %I/)
  assert.match(api, /RUNTIME_IDENTITY_READ_TABLES[\s\S]*"app_agents"/)
  assert.match(api, /lacks required identity read privileges/)
  assert.match(api, /has forbidden identity write privileges/)
  assert.match(api, /"013_api_identity_read_permissions"/)
  for (const table of ["gb_papers", "gb_paper_revisions", "gb_paper_annotations", "gb_paper_claims", "gb_claim_evidence_links", "gb_paper_task_links"]) {
    assert.match(api, new RegExp(`TENANT_RLS_TABLES[\\s\\S]*[\"']${table}[\"']`))
  }
  assert.match(migration, /REFERENCES app_tenant_memberships\(tenant_id, principal_id\)/)
  assert.match(proxy, /X-GB-Tenant-ID/)
  assert.match(proxy, /X-GB-Principal-ID/)
  assert.match(api, /set_config\('app\.tenant_id'/)
  assert.match(api, /ContextVar/)
  assert.match(api, /identity\.tenant_id if identity else ""/)
  assert.match(api, /rolbypassrls/)
  assert.match(api, /pg_has_role/)
  assert.match(api, /relrowsecurity/)
  assert.match(api, /lacks required DML privileges/)
  assert.match(api, /_verify_runtime_rls_role\(cur\)/)
})

test("CI proves tenant isolation with a restricted non-owner API role", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
  const roleTest = await readFile(new URL("./rls-runtime-role.test.mjs", import.meta.url), "utf8")
  assert.match(workflow, /RLS_TEST_CONFIRMATION: ephemeral-ci-database/)
  assert.match(workflow, /node scripts\/rls-runtime-role\.test\.mjs/)
  assert.match(workflow, /Docker Compose startup smoke test/)
  assert.match(workflow, /--profile local-db up --build --wait/)
  assert.match(workflow, /curl --fail --show-error --silent/)
  assert.match(roleTest, /NOBYPASSRLS/)
  assert.match(roleTest, /NOINHERIT/)
  assert.match(roleTest, /relrowsecurity/)
  assert.match(roleTest, /can_assume_owner/)
  assert.match(roleTest, /tenantTables[\s\S]*"gb_object_link_proposals"/)
  assert.match(roleTest, /immutableInsertTables[\s\S]*"gb_object_link_proposals"/)
  assert.match(roleTest, /tenantTables[\s\S]*"gb_object_link_proposal_decisions"/)
  assert.match(roleTest, /immutableInsertTables[\s\S]*"gb_object_link_proposal_decisions"/)
  assert.match(roleTest, /has_table_privilege\(current_user, 'gb_object_link_proposals', 'UPDATE'\)/)
  assert.match(roleTest, /assert\.rejects/)
  assert.match(roleTest, /error\.code === "42501"/)
})

test("human sessions use active explicit defaults and expose a tenant switch", async () => {
  const auth = await readFile(new URL("../lib/auth.ts", import.meta.url), "utf8")
  const switchRoute = await readFile(new URL("../app/api/tenants/[tenantId]/select/route.ts", import.meta.url), "utf8")
  assert.match(auth, /WITH chosen_tenant AS MATERIALIZED/)
  assert.match(auth, /CASE WHEN m\.tenant_id = u\.default_tenant_id THEN 0 ELSE 1 END/)
  assert.match(auth, /UPDATE app_users u/)
  assert.match(auth, /\$2::uuid IS NULL OR m\.tenant_id = \$2::uuid/)
  assert.match(auth, /p\.status = 'active'/)
  assert.match(auth, /t\.status = 'active'/)
  assert.match(auth, /switchCurrentTenant/)
  assert.match(switchRoute, /Invalid request origin/)
})
