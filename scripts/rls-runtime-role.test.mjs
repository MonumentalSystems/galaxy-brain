import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import pg from "pg"

import { canonicalAnchorJson } from "../lib/document-anchor.js"

const { Client } = pg

const confirmation = process.env.RLS_TEST_CONFIRMATION
const adminUrl = process.env.DATABASE_MIGRATION_URL
const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
const runtimePassword = process.env.RLS_RUNTIME_PASSWORD

if (confirmation !== "ephemeral-ci-database") {
  throw new Error("refusing RLS role test without RLS_TEST_CONFIRMATION=ephemeral-ci-database")
}
if (!adminUrl || !runtimeUrl || !runtimePassword) {
  throw new Error("DATABASE_MIGRATION_URL, RLS_RUNTIME_DATABASE_URL, and RLS_RUNTIME_PASSWORD are required")
}
if (!/^[A-Za-z0-9_-]{12,128}$/.test(runtimePassword)) {
  throw new Error("RLS_RUNTIME_PASSWORD must contain 12-128 safe test characters")
}

const roleName = "galaxy_api_runtime_test"
const tenantA = "10000000-0000-4000-8000-000000000001"
const tenantB = "10000000-0000-4000-8000-000000000002"
const principalA = "20000000-0000-4000-8000-000000000001"
const principalB = "20000000-0000-4000-8000-000000000002"
const principalAOther = "20000000-0000-4000-8000-000000000003"
const canvasCreatorPrincipal = "20000000-0000-4000-8000-000000000004"
const canvasA = "30000000-0000-4000-8000-000000000001"
const experimentA = "rls-runtime-tenant-a"
const experimentB = "rls-runtime-tenant-b"
const insertedA = "rls-runtime-insert-a"
const rejectedB = "rls-runtime-reject-b"
const observationA = "40000000-0000-4000-8000-000000000099"
const observationKey = "eln-observation:50000000-0000-4000-8000-000000000099"
const tenantTables = [
  "gb_experiments",
  "gb_experiment_creation_receipts",
  "gb_experiment_attachments",
  "gb_experiment_attachment_requests",
  "gb_eln_observations",
  "gb_eln_observation_revisions",
  "gb_eln_observation_create_receipts",
  "gb_hypotheses",
  "gb_experiment_metrics",
  "gb_datasource_connections",
  "gb_datasource_sync_runs",
  "gb_share_snapshots",
  "gb_node_revisions",
  "gb_surfaces",
  "gb_surface_revisions",
  "gb_papers",
  "gb_paper_revisions",
  "gb_paper_annotations",
  "gb_paper_documents",
  "gb_paper_document_bridges",
  "gb_object_link_proposals",
  "gb_object_link_proposal_decisions",
  "gb_paper_claims",
  "gb_claim_evidence_links",
  "gb_paper_task_links",
  "gb_task_plans",
  "gb_task_plan_revisions",
  "gb_proof_graphs",
  "gb_formal_project_packages",
  "gb_proof_workspaces",
  "gb_proof_work_items",
  "gb_proof_work_transitions",
  "gb_canvases",
  "gb_canvas_items",
  "gb_canvas_edges",
  "gb_canvas_revisions",
  "gb_artifacts",
  "gb_artifact_sources",
  "gb_documents",
  "gb_document_revisions",
  "gb_document_representations",
  "gb_transform_receipts",
  "gb_transform_attempts",
  "gb_transform_request_keys",
  "gb_document_anchors",
  "gb_document_chunks",
  "gb_document_chunk_manifests",
  "gb_document_marks",
  "gb_document_mark_revisions",
  "gb_agent_anchor_requests",
]
const immutableInsertTables = [
  "gb_share_snapshots",
  "gb_experiment_creation_receipts",
  "gb_experiment_attachments",
  "gb_experiment_attachment_requests",
  "gb_eln_observations",
  "gb_eln_observation_revisions",
  "gb_eln_observation_create_receipts",
  "gb_paper_documents",
  "gb_paper_document_bridges",
  "gb_object_link_proposals",
  "gb_object_link_proposal_decisions",
  "gb_proof_work_transitions",
  "gb_canvas_revisions",
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
  "gb_proof_graphs",
  "gb_formal_project_packages",
]
const mutableNoDeleteTables = [
  "gb_proof_workspaces", "gb_proof_work_items", "gb_canvases", "gb_canvas_items",
  "gb_canvas_edges", "gb_documents", "gb_transform_attempts",
  "gb_document_marks",
]
const crudTables = tenantTables.filter(
  (table) => !immutableInsertTables.includes(table) && !mutableNoDeleteTables.includes(table),
)

const admin = new Client({ connectionString: adminUrl })
let runtime

async function removeFixtures() {
  await admin.query("DELETE FROM gb_canvases WHERE id = $1", [canvasA])
  await admin.query(
    "DELETE FROM gb_eln_observation_create_receipts WHERE tenant_id = $1 AND idempotency_key = $2",
    [tenantA, observationKey],
  )
  await admin.query("DELETE FROM gb_experiment_creation_receipts WHERE experiment_id = ANY($1::text[])",
    [[experimentA, experimentB, insertedA, rejectedB]])
  await admin.query(
    "DELETE FROM gb_experiments WHERE id = ANY($1::text[])",
    [[experimentA, experimentB, insertedA, rejectedB]],
  )
  await admin.query(
    "DELETE FROM app_tenant_memberships WHERE tenant_id = ANY($1::uuid[])",
    [[tenantA, tenantB]],
  )
  await admin.query(
    "DELETE FROM app_principals WHERE id = ANY($1::uuid[])",
    [[principalA, principalB, principalAOther, canvasCreatorPrincipal]],
  )
  await admin.query("DELETE FROM app_tenants WHERE id = ANY($1::uuid[])", [[tenantA, tenantB]])
}

try {
  await admin.connect()
  await admin.query("DROP OWNED BY galaxy_api_runtime_test")
    .catch((error) => {
      if (error.code !== "42704") throw error
    })
  await admin.query("DROP ROLE IF EXISTS galaxy_api_runtime_test")
  await admin.query(
    `CREATE ROLE ${roleName} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${runtimePassword}'`,
  )
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`)
  await admin.query(`GRANT SELECT ON schema_migrations TO ${roleName}`)
  await admin.query(
    `GRANT SELECT ON app_tenants, app_principals, app_tenant_memberships, app_agents TO ${roleName}`,
  )
  await admin.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${crudTables.join(", ")}, gb_datasource_plugins TO ${roleName}`,
  )
  await admin.query(`GRANT SELECT, INSERT ON ${immutableInsertTables.join(", ")} TO ${roleName}`)
  await admin.query(`GRANT SELECT, INSERT, UPDATE ON ${mutableNoDeleteTables.join(", ")} TO ${roleName}`)
  await admin.query(`GRANT USAGE, SELECT ON SEQUENCE gb_experiment_metrics_id_seq TO ${roleName}`)

  await removeFixtures()
  await admin.query(
    `INSERT INTO app_tenants (id, slug, name, status)
     VALUES ($1, 'rls-runtime-a', 'RLS Runtime A', 'active'),
            ($2, 'rls-runtime-b', 'RLS Runtime B', 'active')`,
    [tenantA, tenantB],
  )
  await admin.query(
    `INSERT INTO app_principals (id, kind, display_name, status)
     VALUES ($1, 'service', 'RLS Runtime A', 'active'),
            ($2, 'service', 'RLS Runtime B', 'active'),
             ($3, 'service', 'RLS Runtime A other principal', 'active'),
             ($4, 'service', 'RLS Runtime canvas creator', 'active')`,
    [principalA, principalB, principalAOther, canvasCreatorPrincipal],
  )
  await admin.query(
    `INSERT INTO app_tenant_memberships (tenant_id, principal_id, role)
     VALUES ($1, $2, 'service'), ($3, $4, 'service'), ($1, $5, 'service'),
            ($1, $6, 'service')`,
    [tenantA, principalA, tenantB, principalB, principalAOther, canvasCreatorPrincipal],
  )
  runtime = new Client({ connectionString: runtimeUrl })
  await runtime.connect()

  const roleResult = await runtime.query(
    `SELECT current_user AS role_name, rolsuper, rolbypassrls
     FROM pg_catalog.pg_roles
     WHERE rolname = current_user`,
  )
  assert.deepEqual(roleResult.rows, [{ role_name: roleName, rolsuper: false, rolbypassrls: false }])

  const tableResult = await runtime.query(
    `SELECT tables.relname, tables.relrowsecurity,
            pg_catalog.pg_has_role(
              current_user,
              pg_catalog.pg_get_userbyid(tables.relowner),
              'MEMBER'
            ) AS can_assume_owner
     FROM pg_catalog.pg_class AS tables
     JOIN pg_catalog.pg_namespace AS schemas ON schemas.oid = tables.relnamespace
     WHERE schemas.nspname = 'public' AND tables.relname = ANY($1::text[])
     ORDER BY tables.relname`,
    [tenantTables],
  )
  assert.equal(tableResult.rows.length, tenantTables.length)
  for (const table of tableResult.rows) {
    assert.equal(table.relrowsecurity, true, `${table.relname} must enable RLS`)
    assert.equal(table.can_assume_owner, false, `${roleName} must not own or assume ${table.relname}`)
  }

  const artifactPrivileges = await runtime.query(
    `SELECT has_table_privilege(current_user, 'gb_artifacts', 'SELECT') AS can_select,
            has_table_privilege(current_user, 'gb_artifacts', 'INSERT') AS can_insert,
            has_table_privilege(current_user, 'gb_artifacts', 'UPDATE') AS can_update,
            has_table_privilege(current_user, 'gb_artifacts', 'DELETE') AS can_delete`,
  )
  assert.deepEqual(artifactPrivileges.rows, [{
    can_select: true, can_insert: true, can_update: false, can_delete: false,
  }])
  const anchorPrivileges = await runtime.query(
    `SELECT has_table_privilege(current_user, 'gb_document_anchors', 'SELECT') AS can_select,
            has_table_privilege(current_user, 'gb_document_anchors', 'INSERT') AS can_insert,
            has_table_privilege(current_user, 'gb_document_anchors', 'UPDATE') AS can_update,
            has_table_privilege(current_user, 'gb_document_anchors', 'DELETE') AS can_delete`,
  )
  assert.deepEqual(anchorPrivileges.rows, [{
    can_select: true, can_insert: true, can_update: false, can_delete: false,
  }])
  const proposalPrivileges = await runtime.query(
    `SELECT has_table_privilege(current_user, 'gb_object_link_proposals', 'SELECT') AS can_select,
            has_table_privilege(current_user, 'gb_object_link_proposals', 'INSERT') AS can_insert,
            has_table_privilege(current_user, 'gb_object_link_proposals', 'UPDATE') AS can_update,
            has_table_privilege(current_user, 'gb_object_link_proposals', 'DELETE') AS can_delete`,
  )
  assert.deepEqual(proposalPrivileges.rows, [{
    can_select: true, can_insert: true, can_update: false, can_delete: false,
  }])
  const packagePrivileges = await runtime.query(
    `SELECT has_table_privilege(current_user, 'gb_formal_project_packages', 'SELECT') AS can_select,
            has_table_privilege(current_user, 'gb_formal_project_packages', 'INSERT') AS can_insert,
            has_table_privilege(current_user, 'gb_formal_project_packages', 'UPDATE') AS can_update,
            has_table_privilege(current_user, 'gb_formal_project_packages', 'DELETE') AS can_delete,
            has_table_privilege(current_user, 'gb_formal_project_packages', 'TRUNCATE') AS can_truncate`,
  )
  assert.deepEqual(packagePrivileges.rows, [{
    can_select: true, can_insert: true, can_update: false, can_delete: false, can_truncate: false,
  }])

  await runtime.query("SELECT set_config('app.tenant_id', $1, false)", [tenantA])
  await runtime.query("SELECT set_config('app.principal_id', $1, false)", [principalA])
  await runtime.query("BEGIN")

  async function insertJsonArtifact(value) {
    const contentBytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(JSON.stringify(value), "utf8")
    const contentSha256 = createHash("sha256").update(contentBytes).digest("hex")
    const id = (await runtime.query(
      `INSERT INTO gb_artifacts (
         tenant_id, content_sha256, byte_size, media_type, content_bytes, created_by_principal_id
       ) VALUES ($1, $2, $3, 'application/json', $4, $5) RETURNING id`,
      [tenantA, contentSha256, contentBytes.byteLength, contentBytes, principalA],
    )).rows[0].id
    return { id, contentBytes, contentSha256 }
  }

  const packageCommit = "1".repeat(40)
  const packageTree = "2".repeat(40)
  const packageMathlib = "3".repeat(40)
  const authoredPackage = await insertJsonArtifact({
    schemaVersion: "rosetta-authored-conceptual-dag/1.0.0",
    project: "rls-formal-project",
    revision: packageCommit,
    nodes: [],
    edges: [],
  })
  const correspondencePackage = await insertJsonArtifact({
    schemaVersion: "rosetta-authored-formal-correspondence/1.0.0",
    project: "rls-formal-project",
    revision: packageCommit,
    nodeMappings: {},
    edgeCorrespondence: [],
  })
  const proofGraphJson = {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: "rls-formal-project",
    graph_kind: "repository-field",
    title: "RLS formal project",
    source_revision: {
      repository: "MonumentalSystems/RlsFormalProject",
      commit: packageCommit,
      tree: packageTree,
      lean_toolchain: "leanprover/lean4:v4.30.0",
      mathlib_revision: packageMathlib,
    },
    targets: [{ target_id: "root", title: "Root" }],
    relations: [],
  }
  const proofGraphPackage = await insertJsonArtifact(proofGraphJson)
  await runtime.query(
    `INSERT INTO gb_proof_graphs (
       tenant_id, graph_id, graph_kind, title, artifact_id, content_sha256, graph_json,
       target_ids, node_ref_ids, target_count, relation_count,
       registered_by_principal_id, registered_by_nostr_pubkey
     ) VALUES ($1, 'rls-formal-project', 'repository-field', 'RLS formal project', $2, $3, $4,
               ARRAY['root'], ARRAY['rls-formal-project#root'], 1, 0, $5, $6)`,
    [tenantA, proofGraphPackage.id, proofGraphPackage.contentSha256, proofGraphJson, principalA, "a".repeat(64)],
  )
  function formalManifest(authoredSha256) {
    return {
      schemaId: "rosetta.formal-project-package.v1",
      projectId: "rls-formal-project",
      repository: "MonumentalSystems/RlsFormalProject",
      commit: packageCommit,
      tree: packageTree,
      environment: {
        leanToolchain: "leanprover/lean4:v4.30.0",
        mathlibRevision: packageMathlib,
      },
      conversionProfile: "rosetta-authored-conceptual-dag-to-galaxy-repository-field.v1",
      artifacts: {
        formalGraph: { format: "jsonl", sha256: "4".repeat(64) },
        repositoryGraph: { format: "json", sha256: "5".repeat(64) },
        authoredConceptualDag: { format: "json", sha256: authoredSha256 },
        repositoryFieldDag: { format: "json", sha256: proofGraphPackage.contentSha256 },
        correspondence: { format: "json", sha256: correspondencePackage.contentSha256 },
      },
    }
  }
  async function insertFormalPackage(manifestPackage, authoredPackageRef) {
    return runtime.query(
      `INSERT INTO gb_formal_project_packages (
         tenant_id, project_id, repository, commit_oid, tree_oid, lean_toolchain,
         mathlib_revision, conversion_profile, manifest_artifact_id, manifest_sha256,
         manifest_json, authored_dag_artifact_id, authored_dag_sha256,
         repository_field_graph_id, repository_field_dag_sha256,
         correspondence_artifact_id, correspondence_sha256, formal_graph_sha256,
         repository_graph_sha256, registered_by_principal_id, registered_by_nostr_pubkey
       ) VALUES (
         $1, 'rls-formal-project', 'MonumentalSystems/RlsFormalProject', $2, $3,
         'leanprover/lean4:v4.30.0', $4,
         'rosetta-authored-conceptual-dag-to-galaxy-repository-field.v1', $5, $6, $7,
         $8, $9, 'rls-formal-project', $10, $11, $12, $13, $14, $15, $16
       ) RETURNING manifest_sha256`,
      [
        tenantA, packageCommit, packageTree, packageMathlib,
        manifestPackage.id, manifestPackage.contentSha256,
        JSON.parse(manifestPackage.contentBytes.toString("utf8")),
        authoredPackageRef.id, authoredPackageRef.contentSha256,
        proofGraphPackage.contentSha256,
        correspondencePackage.id, correspondencePackage.contentSha256,
        "4".repeat(64), "5".repeat(64), principalA, "a".repeat(64),
      ],
    )
  }
  const validManifest = await insertJsonArtifact(formalManifest(authoredPackage.contentSha256))
  assert.deepEqual(
    (await insertFormalPackage(validManifest, authoredPackage)).rows,
    [{ manifest_sha256: validManifest.contentSha256 }],
  )
  const oversizedManifestBytes = Buffer.concat([
    Buffer.from(JSON.stringify(formalManifest(authoredPackage.contentSha256)), "utf8"),
    Buffer.alloc(65_537, 0x20),
  ])
  const oversizedManifest = await insertJsonArtifact(oversizedManifestBytes)
  await runtime.query("SAVEPOINT oversized_formal_manifest")
  await assert.rejects(
    insertFormalPackage(oversizedManifest, authoredPackage),
    (error) => error.code === "23514" && /64 KiB/u.test(error.message),
  )
  await runtime.query("ROLLBACK TO SAVEPOINT oversized_formal_manifest")
  await runtime.query("RELEASE SAVEPOINT oversized_formal_manifest")
  const oversizedAuthored = await insertJsonArtifact({
    schemaVersion: "rosetta-authored-conceptual-dag/1.0.0",
    project: "rls-formal-project",
    revision: packageCommit,
    padding: "x".repeat(16_777_216),
  })
  const oversizedAuthoredManifest = await insertJsonArtifact(
    formalManifest(oversizedAuthored.contentSha256),
  )
  await runtime.query("SAVEPOINT oversized_formal_authored")
  await assert.rejects(
    insertFormalPackage(oversizedAuthoredManifest, oversizedAuthored),
    (error) => error.code === "23514" && /16 MiB/u.test(error.message),
  )
  await runtime.query("ROLLBACK TO SAVEPOINT oversized_formal_authored")
  await runtime.query("RELEASE SAVEPOINT oversized_formal_authored")
  await runtime.query("ROLLBACK")

  const artifactBytes = Buffer.from("durable evidence bytes", "utf8")
  const artifactHash = createHash("sha256").update(artifactBytes).digest("hex")
  await runtime.query("BEGIN")
  await assert.rejects(
    runtime.query(
      `INSERT INTO gb_artifacts (
         tenant_id, content_sha256, byte_size, media_type, content_bytes, created_by_principal_id
       ) VALUES ($1, $2, $3, 'text/plain', $4, $5)`,
      [tenantA, "0".repeat(64), artifactBytes.byteLength, artifactBytes, principalA],
    ),
    (error) => error.code === "23514",
  )
  await runtime.query("ROLLBACK")
  await runtime.query("BEGIN")
  const artifactId = (await runtime.query(
    `INSERT INTO gb_artifacts (
       tenant_id, content_sha256, byte_size, media_type, content_bytes, created_by_principal_id
     ) VALUES ($1, $2, $3, 'text/plain', $4, $5) RETURNING id`,
    [tenantA, artifactHash, artifactBytes.byteLength, artifactBytes, principalA],
  )).rows[0].id
  const sourceId = (await runtime.query(
    `INSERT INTO gb_artifact_sources (
       tenant_id, artifact_id, source_kind, original_filename, idempotency_key,
       request_sha256, created_by_principal_id
     ) VALUES ($1, $2, 'upload', 'evidence.txt', 'rls-artifact-source', $3, $4) RETURNING id`,
    [tenantA, artifactId, "1".repeat(64), principalA],
  )).rows[0].id
  const documentId = (await runtime.query(
    `INSERT INTO gb_documents (tenant_id, title, display_filename, created_by_principal_id)
     VALUES ($1, 'Evidence', 'evidence.txt', $2) RETURNING id`,
    [tenantA, principalA],
  )).rows[0].id
  const revisionId = (await runtime.query(
    `INSERT INTO gb_document_revisions (
       tenant_id, document_id, version, title, display_filename, original_artifact_id,
       source_id, revision_sha256, created_by_principal_id
     ) VALUES ($1, $2, 1, 'Evidence', 'evidence.txt', $3, $4, $5, $6) RETURNING id`,
    [tenantA, documentId, artifactId, sourceId, "2".repeat(64), principalA],
  )).rows[0].id
  await runtime.query(
    "UPDATE gb_documents SET current_revision_id = $1 WHERE tenant_id = $2 AND id = $3",
    [revisionId, tenantA, documentId],
  )
  const representationId = (await runtime.query(
    `INSERT INTO gb_document_representations (
       tenant_id, document_revision_id, kind, media_type, content_sha256, artifact_id,
       created_by_principal_id
     ) VALUES ($1, $2, 'original', 'text/plain', $3, $4, $5) RETURNING id`,
    [tenantA, revisionId, artifactHash, artifactId, principalA],
  )).rows[0].id
  async function rejectsForeignKey(statement, parameters) {
    await runtime.query("SAVEPOINT ingestion_invariant")
    await assert.rejects(runtime.query(statement, parameters), (error) => error.code === "23503")
    await runtime.query("ROLLBACK TO SAVEPOINT ingestion_invariant")
    await runtime.query("RELEASE SAVEPOINT ingestion_invariant")
  }
  const otherBytes = Buffer.from("different evidence bytes", "utf8")
  const otherHash = createHash("sha256").update(otherBytes).digest("hex")
  const otherArtifactId = (await runtime.query(
    `INSERT INTO gb_artifacts (
       tenant_id, content_sha256, byte_size, media_type, content_bytes, created_by_principal_id
     ) VALUES ($1, $2, $3, 'text/plain', $4, $5) RETURNING id`,
    [tenantA, otherHash, otherBytes.byteLength, otherBytes, principalA],
  )).rows[0].id
  const otherSourceId = (await runtime.query(
    `INSERT INTO gb_artifact_sources (
       tenant_id, artifact_id, source_kind, original_filename, idempotency_key,
       request_sha256, created_by_principal_id
     ) VALUES ($1, $2, 'upload', 'other-evidence.txt', 'rls-other-artifact-source', $3, $4)
     RETURNING id`,
    [tenantA, otherArtifactId, "8".repeat(64), principalA],
  )).rows[0].id
  const otherDocumentId = (await runtime.query(
    `INSERT INTO gb_documents (tenant_id, title, display_filename, created_by_principal_id)
     VALUES ($1, 'Other evidence', 'other-evidence.txt', $2) RETURNING id`,
    [tenantA, principalA],
  )).rows[0].id
  const otherRevisionId = (await runtime.query(
    `INSERT INTO gb_document_revisions (
       tenant_id, document_id, version, title, display_filename, original_artifact_id,
       source_id, revision_sha256, created_by_principal_id
     ) VALUES ($1, $2, 1, 'Other evidence', 'other-evidence.txt', $3, $4, $5, $6)
     RETURNING id`,
    [tenantA, otherDocumentId, otherArtifactId, otherSourceId, "9".repeat(64), principalA],
  )).rows[0].id
  function anchorEvidence(selector, selectedRepresentationId = representationId, selectedRepresentationHash = artifactHash) {
    const canonicalSelector = canonicalAnchorJson(selector)
    const selectorHash = createHash("sha256").update(canonicalSelector).digest("hex")
    const anchorHash = createHash("sha256")
      .update(canonicalAnchorJson({
        representationId: selectedRepresentationId,
        representationSha256: selectedRepresentationHash,
        selector,
      }))
      .digest("hex")
    return { selectorHash, anchorHash }
  }
  const textSelector = {
    kind: "text-quote",
    exact: "durable evidence",
  }
  const textAnchor = anchorEvidence(textSelector)
  const anchorId = `sha256:${textAnchor.anchorHash}`
  await runtime.query(
    `INSERT INTO gb_document_anchors (
       id, tenant_id, document_revision_id, representation_id, representation_sha256,
       identity_version, selector_kind, selector_json, selector_sha256, anchor_sha256,
       created_by_principal_id
     ) VALUES ($1, $2, $3, $4, $5, 'gb.anchor.v1', 'text-quote', $6::jsonb, $7, $8, $9)`,
    [
      anchorId, tenantA, revisionId, representationId, artifactHash,
      JSON.stringify(textSelector), textAnchor.selectorHash, textAnchor.anchorHash, principalA,
    ],
  )
  assert.deepEqual(
    (await runtime.query(
      `SELECT id, document_revision_id, selector_kind, selector_sha256, anchor_sha256
         FROM gb_document_anchors WHERE tenant_id = $1 AND id = $2`,
      [tenantA, anchorId],
    )).rows,
    [{
      id: anchorId,
      document_revision_id: revisionId,
      selector_kind: "text-quote",
      selector_sha256: textAnchor.selectorHash,
      anchor_sha256: textAnchor.anchorHash,
    }],
  )
  const markId = "60000000-0000-4000-8000-000000000001"
  const markRevision1 = "70000000-0000-4000-8000-000000000001"
  const markRevision2 = "70000000-0000-4000-8000-000000000002"
  await runtime.query(
    `INSERT INTO gb_document_marks (
       id, tenant_id, document_revision_id, anchor_id, kind, current_version,
       current_revision_id, current_content_hash, body_markdown, color,
       semantic_role, tags, state, creation_idempotency_key,
       creation_request_hash, created_by_principal_id
     ) VALUES ($1, $2, $3, $4, 'note', 1, $5, $6, 'reader note', '#6d7a68',
               'note', ARRAY['vortex'], 'active', 'rls-reader-mark-create', $7, $8)`,
    [markId, tenantA, revisionId, anchorId, markRevision1, "a".repeat(64), "b".repeat(64), principalA],
  )
  await runtime.query(
    `INSERT INTO gb_document_mark_revisions (
       id, tenant_id, mark_id, version, content_hash, body_markdown, color,
       semantic_role, tags, state, idempotency_key, request_hash,
       created_by_principal_id
     ) VALUES ($1, $2, $3, 1, $4, 'reader note', '#6d7a68', 'note',
               ARRAY['vortex'], 'active', 'rls-reader-mark-create', $5, $6)`,
    [markRevision1, tenantA, markId, "a".repeat(64), "b".repeat(64), principalA],
  )
  await runtime.query(
    `INSERT INTO gb_document_mark_revisions (
       id, tenant_id, mark_id, version, content_hash, body_markdown, color,
       semantic_role, tags, state, idempotency_key, request_hash,
       created_by_principal_id
     ) VALUES ($1, $2, $3, 2, $4, 'revised note', '#6d7a68', 'evidence',
               ARRAY['vortex'], 'resolved', 'rls-reader-mark-update', $5, $6)`,
    [markRevision2, tenantA, markId, "c".repeat(64), "d".repeat(64), principalA],
  )
  await runtime.query(
    `UPDATE gb_document_marks
        SET current_version = 2, current_revision_id = $1, current_content_hash = $2,
            body_markdown = 'revised note', semantic_role = 'evidence', state = 'resolved',
            updated_at = now()
      WHERE tenant_id = $3 AND id = $4`,
    [markRevision2, "c".repeat(64), tenantA, markId],
  )
  await runtime.query("SET CONSTRAINTS gb_document_marks_current_revision IMMEDIATE")
  assert.deepEqual(
    (await runtime.query(
      "SELECT current_version, state FROM gb_document_marks WHERE tenant_id = $1 AND id = $2",
      [tenantA, markId],
    )).rows,
    [{ current_version: 2, state: "resolved" }],
  )
  await runtime.query("SAVEPOINT mark_append_only")
  await assert.rejects(
    runtime.query(
      "UPDATE gb_document_mark_revisions SET body_markdown = 'rewrite' WHERE tenant_id = $1 AND mark_id = $2",
      [tenantA, markId],
    ),
    (error) => ["42501", "55000"].includes(error.code),
  )
  await runtime.query("ROLLBACK TO SAVEPOINT mark_append_only")
  await runtime.query("RELEASE SAVEPOINT mark_append_only")
  const boundarySelector = {
    kind: "text-quote",
    exact: "€".repeat(10_912),
  }
  assert.equal(Buffer.byteLength(canonicalAnchorJson(boundarySelector), "utf8"), 32_768)
  const boundaryAnchor = anchorEvidence(boundarySelector)
  await runtime.query(
    `INSERT INTO gb_document_anchors (
       id, tenant_id, document_revision_id, representation_id, representation_sha256,
       identity_version, selector_kind, selector_json, selector_sha256, anchor_sha256,
       created_by_principal_id
     ) VALUES ($1, $2, $3, $4, $5, 'gb.anchor.v1', 'text-quote', $6::jsonb, $7, $8, $9)`,
    [
      `sha256:${boundaryAnchor.anchorHash}`, tenantA, revisionId, representationId, artifactHash,
      JSON.stringify(boundarySelector), boundaryAnchor.selectorHash, boundaryAnchor.anchorHash, principalA,
    ],
  )
  const regionSelector = {
    kind: "page-region",
    page: 1,
    coordinateSpace: "normalized-page",
    polygon: [0.1, 0.2, 0.4, 0.2, 0.4, 0.6, 0.1, 0.6],
  }
  const regionAnchor = anchorEvidence(regionSelector)
  await rejectsForeignKey(
    `INSERT INTO gb_document_anchors (
       id, tenant_id, document_revision_id, representation_id, representation_sha256,
       identity_version, selector_kind, selector_json, selector_sha256, anchor_sha256,
       created_by_principal_id
     ) VALUES ($1, $2, $3, $4, $5, 'gb.anchor.v1', 'page-region', $6::jsonb, $7, $8, $9)`,
    [
      `sha256:${regionAnchor.anchorHash}`, tenantA, otherRevisionId,
      representationId, artifactHash, JSON.stringify(regionSelector),
      regionAnchor.selectorHash, regionAnchor.anchorHash, principalA,
    ],
  )
  await runtime.query("SAVEPOINT anchor_id_invariant")
  await assert.rejects(
    runtime.query(
      `INSERT INTO gb_document_anchors (
         id, tenant_id, document_revision_id, representation_id, representation_sha256,
         identity_version, selector_kind, selector_json, selector_sha256, anchor_sha256,
         created_by_principal_id
       ) VALUES ($1, $2, $3, $4, $5, 'gb.anchor.v1', 'page-region', $6::jsonb, $7, $8, $9)`,
      [
        `sha256:${"0".repeat(64)}`, tenantA, revisionId,
        representationId, artifactHash, JSON.stringify(regionSelector),
        regionAnchor.selectorHash, regionAnchor.anchorHash, principalA,
      ],
    ),
    (error) => error.code === "23514",
  )
  await runtime.query("ROLLBACK TO SAVEPOINT anchor_id_invariant")
  await runtime.query("RELEASE SAVEPOINT anchor_id_invariant")
  await rejectsForeignKey(
    `INSERT INTO gb_document_revisions (
       tenant_id, document_id, version, title, display_filename, original_artifact_id,
       source_id, revision_sha256, created_by_principal_id
     ) VALUES ($1, $2, 2, 'Evidence', 'evidence.txt', $3, $4, $5, $6)`,
    [tenantA, documentId, otherArtifactId, sourceId, "6".repeat(64), principalA],
  )
  await rejectsForeignKey(
    "UPDATE gb_documents SET current_version = 2 WHERE tenant_id = $1 AND id = $2",
    [tenantA, documentId],
  )
  await rejectsForeignKey(
    `INSERT INTO gb_document_representations (
       tenant_id, document_revision_id, kind, media_type, content_sha256, artifact_id,
       created_by_principal_id
     ) VALUES ($1, $2, 'thumbnail', 'text/plain', $3, $4, $5)`,
    [tenantA, revisionId, "3".repeat(64), artifactId, principalA],
  )
  const configHash = createHash("sha256").update("{}").digest("hex")
  await runtime.query("SAVEPOINT transform_idempotency_pair")
  await assert.rejects(
    runtime.query(
      `INSERT INTO gb_transform_receipts (
         tenant_id, document_revision_id, input_artifact_id, plugin_id, plugin_version,
         engine, engine_version, config_sha256, input_sha256, status, diagnostic_code,
         idempotency_key, created_by_principal_id
       ) VALUES ($1, $2, $3, 'docling', '1', 'docling', 'api-v1', $4, $5,
                 'failed', 'docling.unavailable', 'rls-transform-null-hash', $6)`,
      [tenantA, revisionId, artifactId, configHash, artifactHash, principalA],
    ),
    (error) => error.code === "23514",
  )
  await runtime.query("ROLLBACK TO SAVEPOINT transform_idempotency_pair")
  await runtime.query("RELEASE SAVEPOINT transform_idempotency_pair")
  await rejectsForeignKey(
    `INSERT INTO gb_transform_receipts (
       tenant_id, document_revision_id, input_artifact_id, plugin_id, plugin_version,
       engine, engine_version, config_sha256, input_sha256, status, created_by_principal_id
     ) VALUES ($1, $2, $3, 'test', '1', 'test', '1', $4, $5, 'failed', $6)`,
    [tenantA, revisionId, artifactId, configHash, "4".repeat(64), principalA],
  )
  await rejectsForeignKey(
    `INSERT INTO gb_transform_receipts (
       tenant_id, document_revision_id, input_artifact_id, plugin_id, plugin_version,
       engine, engine_version, config_sha256, input_sha256, output_representation_id,
       output_sha256, status, created_by_principal_id
     ) VALUES ($1, $2, $3, 'test', '1', 'test', '1', $4, $5, $6, $7, 'success', $8)`,
    [
      tenantA, revisionId, artifactId, configHash, artifactHash, representationId,
      "5".repeat(64), principalA,
    ],
  )
  const otherReceiptId = (await runtime.query(
    `INSERT INTO gb_transform_receipts (
       tenant_id, document_revision_id, input_artifact_id, plugin_id, plugin_version,
       engine, engine_version, config_sha256, input_sha256, status, diagnostic_code,
       created_by_principal_id
     ) VALUES ($1, $2, $3, 'plain-text', '1', 'utf-8', 'unicode-15', $4, $5,
               'failed', 'plain_text.invalid_utf8', $6)
     RETURNING id`,
    [tenantA, otherRevisionId, otherArtifactId, configHash, otherHash, principalA],
  )).rows[0].id
  await rejectsForeignKey(
    `INSERT INTO gb_transform_receipts (
       tenant_id, document_revision_id, input_artifact_id, plugin_id, plugin_version,
       engine, engine_version, config_sha256, input_sha256, status, diagnostic_code,
       fallback_receipt_id, created_by_principal_id
     ) VALUES ($1, $2, $3, 'docling', '1', 'docling', 'api-v1', $4, $5,
               'failed', 'docling.unavailable', $6, $7)`,
    [tenantA, revisionId, artifactId, configHash, artifactHash, otherReceiptId, principalA],
  )
  const fallbackReceiptId = (await runtime.query(
    `INSERT INTO gb_transform_receipts (
       tenant_id, document_revision_id, input_artifact_id, plugin_id, plugin_version,
       engine, engine_version, config_sha256, input_sha256, status, diagnostic_code,
       created_by_principal_id
     ) VALUES ($1, $2, $3, 'plain-text', '1', 'utf-8', 'unicode-15', $4, $5,
               'failed', 'plain_text.invalid_utf8', $6)
     RETURNING id`,
    [tenantA, revisionId, artifactId, configHash, artifactHash, principalA],
  )).rows[0].id
  const transformRequestHash = "7".repeat(64)
  const primaryReceiptId = (await runtime.query(
    `INSERT INTO gb_transform_receipts (
       tenant_id, document_revision_id, input_artifact_id, plugin_id, plugin_version,
       engine, engine_version, config_sha256, input_sha256, status, diagnostic_code,
       fallback_receipt_id, idempotency_key, request_sha256, created_by_principal_id
     ) VALUES ($1, $2, $3, 'docling', '1', 'docling', 'api-v1', $4, $5,
               'failed', 'docling.unavailable', $6, 'rls-transform-attempt-1', $7, $8)
     RETURNING id`,
    [
      tenantA, revisionId, artifactId, configHash, artifactHash, fallbackReceiptId,
      transformRequestHash, principalA,
    ],
  )).rows[0].id
  const attemptId = (await runtime.query(
    `INSERT INTO gb_transform_attempts (
       tenant_id, document_revision_id, input_artifact_id, input_sha256,
       idempotency_key, request_sha256, state, lease_token, lease_expires_at,
       created_by_principal_id
     ) VALUES ($1, $2, $3, $4, 'rls-transform-attempt-1', $5, 'running',
               '90000000-0000-4000-8000-000000000001', now() + interval '5 minutes', $6)
     RETURNING id`,
    [tenantA, revisionId, artifactId, artifactHash, transformRequestHash, principalA],
  )).rows[0].id
  await runtime.query(
    `UPDATE gb_transform_attempts
        SET state = 'finished', primary_receipt_id = $1,
            lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE tenant_id = $2 AND id = $3`,
    [primaryReceiptId, tenantA, attemptId],
  )
  assert.deepEqual(
    (await runtime.query(
      "SELECT state, primary_receipt_id FROM gb_transform_attempts WHERE id = $1",
      [attemptId],
    )).rows,
    [{ state: "finished", primary_receipt_id: primaryReceiptId }],
  )
  await runtime.query("COMMIT")
  await runtime.query(
    `INSERT INTO gb_canvases (
       id, tenant_id, workspace_id, slug, title, is_default, current_content_hash,
       created_by_principal_id, creation_idempotency_key, creation_request_hash
     ) VALUES ($1, $2, 'rls-shared-canvas', 'main', 'Tenant shared canvas', true, $3, $4, 'rls-canvas-create-a', $5)`,
    [canvasA, tenantA, `sha256:${"a".repeat(64)}`, canvasCreatorPrincipal, "b".repeat(64)],
  )
  assert.deepEqual(
    (await runtime.query("SELECT id FROM gb_canvases WHERE id = $1", [canvasA])).rows,
    [{ id: canvasA }],
  )
  await runtime.query("SELECT set_config('app.principal_id', $1, false)", [principalAOther])
  assert.deepEqual(
    (await runtime.query("SELECT id FROM gb_canvases WHERE id = $1", [canvasA])).rows,
    [{ id: canvasA }],
  )
  await admin.query(
    "DELETE FROM app_tenant_memberships WHERE tenant_id = $1 AND principal_id = $2",
    [tenantA, canvasCreatorPrincipal],
  )
  assert.deepEqual(
    (await runtime.query(
      "SELECT id, created_by_principal_id FROM gb_canvases WHERE id = $1",
      [canvasA],
    )).rows,
    [{ id: canvasA, created_by_principal_id: canvasCreatorPrincipal }],
  )
  await admin.query(
    "INSERT INTO app_tenant_memberships (tenant_id, principal_id, role) VALUES ($1, $2, 'service')",
    [tenantA, canvasCreatorPrincipal],
  )
  await admin.query(
    `INSERT INTO gb_experiments (id, user_id, title, tenant_id, created_by_principal_id)
     VALUES ($1, 'rls-runtime-a', 'Tenant A', $2, $3),
            ($4, 'rls-runtime-b', 'Tenant B', $5, $6)`,
    [experimentA, tenantA, principalA, experimentB, tenantB, principalB],
  )
  await runtime.query("SELECT set_config('app.principal_id', $1, false)", [principalA])
  const visibleToA = await runtime.query(
    "SELECT id FROM gb_experiments WHERE id = ANY($1::text[]) ORDER BY id",
    [[experimentA, experimentB]],
  )
  assert.deepEqual(visibleToA.rows, [{ id: experimentA }])

  await runtime.query(
    `INSERT INTO gb_experiments (id, user_id, title, tenant_id, created_by_principal_id)
     VALUES ($1, 'rls-runtime-a', 'Allowed tenant A insert', $2, $3)`,
    [insertedA, tenantA, principalA],
  )
  await runtime.query(
    `INSERT INTO gb_eln_observations (id, tenant_id, experiment_id, created_by_principal_id)
     VALUES ($1, $2, $3, $4)`,
    [observationA, tenantA, insertedA, principalA],
  )
  await runtime.query(
    `INSERT INTO gb_eln_observation_revisions (
       tenant_id, observation_id, version, body, observed_at,
       revision_sha256, created_by_principal_id
     ) VALUES ($1, $2, 1, 'Stable reading', '2026-09-28T16:30:00Z', $3, $4)`,
    [tenantA, observationA, "5".repeat(64), principalA],
  )
  await runtime.query(
    `INSERT INTO gb_eln_observation_create_receipts (
       tenant_id, idempotency_key, request_sha256, experiment_id,
       observation_id, created_by_principal_id
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantA, observationKey, "6".repeat(64), insertedA, observationA, principalA],
  )
  assert.deepEqual(
    (await runtime.query(
      `SELECT observation.id, revision.body, revision.revision_sha256
         FROM gb_eln_observations AS observation
         JOIN gb_eln_observation_revisions AS revision
           ON revision.tenant_id = observation.tenant_id
          AND revision.observation_id = observation.id
        WHERE observation.tenant_id = $1 AND observation.id = $2`,
      [tenantA, observationA],
    )).rows,
    [{ id: observationA, body: "Stable reading", revision_sha256: "5".repeat(64) }],
  )
  await assert.rejects(
    runtime.query(
      "UPDATE gb_eln_observation_revisions SET body = 'rewritten' WHERE tenant_id = $1 AND observation_id = $2",
      [tenantA, observationA],
    ),
    (error) => error.code === "42501",
  )
  const attachmentId = (await runtime.query(
    `INSERT INTO gb_experiment_attachments (
       tenant_id, experiment_id, document_id, document_revision_id,
       document_revision_sha256, created_by_principal_id, idempotency_key, request_sha256
     ) VALUES ($1, $2, $3, $4, $5, $6, 'rls-attachment-create', $7)
     RETURNING id`,
    [tenantA, insertedA, documentId, revisionId, "2".repeat(64), principalA, "3".repeat(64)],
  )).rows[0].id
  await runtime.query(
    `INSERT INTO gb_experiment_attachment_requests (
       tenant_id, experiment_id, idempotency_key, request_sha256, attachment_id
     ) VALUES ($1, $2, 'rls-attachment-create', $3, $4)`,
    [tenantA, insertedA, "3".repeat(64), attachmentId],
  )
  await assert.rejects(
    runtime.query(
      `INSERT INTO gb_experiment_attachment_requests (
         tenant_id, experiment_id, idempotency_key, request_sha256, attachment_id
       ) VALUES ($1, $2, 'rls-attachment-cross-experiment', $3, $4)`,
      [tenantA, experimentA, "4".repeat(64), attachmentId],
    ),
    (error) => error.code === "23503",
  )
  await assert.rejects(
    runtime.query("DELETE FROM gb_experiment_attachments WHERE tenant_id = $1 AND id = $2", [tenantA, attachmentId]),
    (error) => error.code === "42501",
  )
  await runtime.query("DELETE FROM gb_experiments WHERE tenant_id = $1 AND id = $2", [tenantA, insertedA])
  assert.deepEqual(
    (await runtime.query(
      "SELECT id FROM gb_eln_observations WHERE tenant_id = $1 AND id = $2",
      [tenantA, observationA],
    )).rows,
    [],
  )
  assert.deepEqual(
    (await runtime.query(
      "SELECT observation_id FROM gb_eln_observation_create_receipts WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantA, observationKey],
    )).rows,
    [{ observation_id: observationA }],
  )
  assert.deepEqual(
    (await runtime.query(
      "SELECT id FROM gb_experiment_attachments WHERE tenant_id = $1 AND id = $2",
      [tenantA, attachmentId],
    )).rows,
    [],
  )
  assert.deepEqual(
    (await runtime.query(
      "SELECT attachment_id FROM gb_experiment_attachment_requests WHERE tenant_id = $1 AND attachment_id = $2",
      [tenantA, attachmentId],
    )).rows,
    [],
  )
  assert.deepEqual(
    (await runtime.query("SELECT id FROM gb_documents WHERE tenant_id = $1 AND id = $2", [tenantA, documentId])).rows,
    [{ id: documentId }],
  )
  await assert.rejects(
    runtime.query(
      `INSERT INTO gb_experiments (id, user_id, title, tenant_id, created_by_principal_id)
       VALUES ($1, 'rls-runtime-b', 'Rejected tenant B insert', $2, $3)`,
      [rejectedB, tenantB, principalB],
    ),
    (error) => error.code === "42501",
  )

  await runtime.query("SELECT set_config('app.tenant_id', $1, false)", [tenantB])
  await runtime.query("SELECT set_config('app.principal_id', $1, false)", [principalB])
  const visibleToB = await runtime.query(
    "SELECT id FROM gb_experiments WHERE id = ANY($1::text[]) ORDER BY id",
    [[experimentA, experimentB, insertedA]],
  )
  assert.deepEqual(visibleToB.rows, [{ id: experimentB }])

  // Migration 049 grants the sealed registrar only to the NOLOGIN verifier
  // authority. The ordinary runtime can neither assume it nor bypass it.
  await assert.rejects(
    runtime.query("SET ROLE gb_proof_verifier"),
    (error) => error.code === "42501",
  )
  await assert.rejects(
    runtime.query(
      `SELECT * FROM gb_record_accepted_proof_verification(${Array(24).fill("NULL").join(", ")})`,
    ),
    (error) => error.code === "42501",
  )
  await assert.rejects(
    runtime.query("INSERT INTO gb_proof_work_verifications (tenant_id) VALUES ($1)", [tenantB]),
    (error) => error.code === "42501",
  )

  console.log("restricted API runtime role enforced two-tenant RLS isolation")
} finally {
  if (runtime) await runtime.end().catch(() => {})
  if (admin._connected) {
    await removeFixtures().catch(() => {})
    await admin.query(`DROP OWNED BY ${roleName}`).catch(() => {})
    await admin.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => {})
    await admin.end().catch(() => {})
  }
}
