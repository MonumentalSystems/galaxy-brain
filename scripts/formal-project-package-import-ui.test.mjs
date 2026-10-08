import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  FORMAL_PROJECT_PACKAGE_RESPONSE_LIMIT,
  formalProjectPackageErrorMessage,
  normalizeFormalProjectPackageSummary,
  readFormalProjectPackageResponse,
} from "../lib/formal-project-package-client.js"

const COMMIT = "1".repeat(40)
const TREE = "2".repeat(40)
const MATHLIB = "3".repeat(40)
const MANIFEST_HASH = "4".repeat(64)
const AUTHORED_HASH = "5".repeat(64)
const FIELD_HASH = "6".repeat(64)
const CORRESPONDENCE_HASH = "7".repeat(64)

const expected = {
  projectId: "leanproofs",
  repository: "MonumentalSystems/LeanProofs",
  commit: COMMIT,
  tree: TREE,
  environment: {
    leanToolchain: "leanprover/lean4:v4.30.0",
    mathlibRevision: MATHLIB,
  },
  manifestSha256: MANIFEST_HASH,
  repositoryFieldDagSha256: FIELD_HASH,
  repositoryFieldDag: { graph_id: "leanproofs" },
  artifacts: {
    formalGraph: { format: "jsonl", sha256: "8".repeat(64) },
    repositoryGraph: { format: "json", sha256: "9".repeat(64) },
    authoredConceptualDag: { format: "json", sha256: AUTHORED_HASH },
    repositoryFieldDag: { format: "json", sha256: FIELD_HASH },
    correspondence: { format: "json", sha256: CORRESPONDENCE_HASH },
  },
}

function response(overrides = {}) {
  return {
    schemaId: "gb.formal-project-package.summary.v1",
    registrationId: "10000000-0000-4000-8000-000000000001",
    projectId: expected.projectId,
    repository: expected.repository,
    commit: expected.commit,
    tree: expected.tree,
    environment: expected.environment,
    conversionProfile: "rosetta-authored-conceptual-dag-to-galaxy-repository-field.v1",
    manifestSha256: expected.manifestSha256,
    proofGraphRef: { graph_id: "leanproofs", content_sha256: FIELD_HASH },
    artifacts: {
      formalGraph: { materialized: false, sha256: expected.artifacts.formalGraph.sha256 },
      repositoryGraph: { materialized: false, sha256: expected.artifacts.repositoryGraph.sha256 },
      authoredConceptualDag: { materialized: true, sha256: AUTHORED_HASH },
      repositoryFieldDag: { materialized: true, sha256: FIELD_HASH },
      correspondence: { materialized: true, sha256: CORRESPONDENCE_HASH },
    },
    registeredByPrincipalId: "10000000-0000-4000-8000-000000000002",
    registeredByNostrPubkey: "a".repeat(64),
    registeredAt: "2026-09-26T12:00:00Z",
    ...overrides,
  }
}

test("normalizes the import response only when it matches the exact reviewed package", () => {
  const summary = normalizeFormalProjectPackageSummary(response(), expected)
  assert.deepEqual(summary.proofGraphRef, {
    graphId: "leanproofs",
    contentSha256: FIELD_HASH,
  })
  assert.equal(summary.artifacts.formalGraph.materialized, false)
  assert.equal(summary.artifacts.repositoryFieldDag.materialized, true)
  assert.equal(Object.isFrozen(summary), true)

  assert.throws(
    () => normalizeFormalProjectPackageSummary(response({
      proofGraphRef: { graph_id: "other", content_sha256: FIELD_HASH },
    }), expected),
    /proofGraphRef\.graph_id does not match the reviewed package/u,
  )
  assert.throws(
    () => normalizeFormalProjectPackageSummary(response({
      artifacts: { ...response().artifacts, formalGraph: { materialized: true, sha256: "8".repeat(64) } },
    }), expected),
    /materialization state is invalid/u,
  )
})

test("bounds response parsing and never surfaces arbitrary upstream detail", async () => {
  const valid = await readFormalProjectPackageResponse(Response.json({ ok: true }))
  assert.deepEqual(valid, { ok: true })
  await assert.rejects(
    () => readFormalProjectPackageResponse(new Response("x".repeat(
      FORMAL_PROJECT_PACKAGE_RESPONSE_LIMIT + 1,
    ))),
    /exceeds its byte bound/u,
  )
  assert.equal(
    formalProjectPackageErrorMessage(422),
    "The server rejected the package structure or cross-bindings.",
  )
  assert.doesNotMatch(formalProjectPackageErrorMessage(422), /upstream secret/u)
})

test("browser import reviews four exact local files before signing one bounded envelope", async () => {
  const [component, panel, atlas, worker] = await Promise.all([
    readFile(new URL("../components/graph/formal-project-package-import.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/graph/proof-graph-registry-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../workers/formal-project-package.worker.ts", import.meta.url), "utf8"),
  ])
  for (const role of [
    "manifestBytes",
    "authoredConceptualDagBytes",
    "repositoryFieldDagBytes",
    "correspondenceBytes",
  ]) {
    assert.match(component, new RegExp(`role: "${role}"`, "u"))
  }
  assert.equal((component.match(/type="file"/gu) || []).length, 1)
  assert.match(component, /FILE_FIELDS\.map/u)
  assert.match(component, /new Uint8Array\(await file\.arrayBuffer\(\)\)/u)
  assert.match(component, /new Worker\([\s\S]*formal-project-package\.worker\.ts/u)
  assert.match(component, /complete\[role\]\.bytes\.slice\(\)\.buffer/u)
  assert.match(worker, /parseFormalProjectPackage\(input\)/u)
  assert.match(worker, /encodeFormalProjectPackageEnvelope\(input\)/u)
  assert.match(component, /approvedReview\.generation !== reviewGeneration\.current/u)
  assert.match(component, /const controller = new AbortController\(\)/u)
  assert.match(component, /operation === operationGeneration\.current/u)
  assert.match(component, /mountedRef\.current/u)
  assert.match(component, /useLayoutEffect\(\(\) => \{/u)
  assert.match(component, /mountedRef\.current = false[\s\S]*requestControllerRef\.current\?\.abort\(\)/u)
  assert.match(component, /signal: controller\.signal/u)
  assert.match(component, /readFormalProjectPackageResponse\(response\)/u)
  assert.match(component, /formalProjectPackageErrorMessage\(response\.status\)/u)
  assert.doesNotMatch(component, /proofRegistryErrorMessage/u)
  assert.match(component, /getCanonicalNostrRequestTarget\(IMPORT_PATH\)/u)
  assert.match(component, /signNostrHttpRequest\([\s\S]*body,[\s\S]*\)/u)
  assert.match(component, /"Content-Type": FORMAL_PROJECT_PACKAGE_MEDIA_TYPE/u)
  assert.match(component, /body: body\.slice\(\)\.buffer/u)
  assert.match(component, /Review immutable package/u)
  assert.match(component, /break-all font-mono text-\[10px\][^>]*>sha256:\{review\.expected\.manifestSha256\}/u)
  assert.doesNotMatch(component, /shortHash/u)
  assert.match(component, /let committed = false/u)
  assert.match(component, /committed = response\.ok/u)
  assert.match(component, /The package was imported, but the registry refresh or selection failed/u)
  assert.match(component, /completion === "failed"/u)
  assert.match(component, /exact passive proof graph could not be selected/u)
  assert.match(component, /creates no mission, workspace, claim, run, or verification state/u)
  assert.doesNotMatch(panel, /FormalProjectPackageImport|selectionContext/u)
  assert.match(atlas, /commandId === "proof\.package\.import"/u)
  assert.match(atlas, /setFormalPackageImportOpen\(true\)/u)
})
