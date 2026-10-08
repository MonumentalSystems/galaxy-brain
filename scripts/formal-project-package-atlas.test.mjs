import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { formalProjectPackageAtlasPlacement } from "../lib/formal-project-package-atlas.js"
import { parseGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { dispatchAtlasCommand, listAtlasCommands } from "../lib/plugins/atlas-commands.js"

const HASH = "6".repeat(64)
const REGISTRATION_ID = "10000000-0000-4000-8000-000000000001"

function strictSummary(overrides = {}) {
  return {
    schemaId: "gb.formal-project-package.summary.v1",
    registrationId: REGISTRATION_ID,
    proofGraphRef: { graphId: "leanproofs", contentSha256: HASH },
    ...overrides,
  }
}

test("formal package placement pins the exact graph hash and reuses registration UUID", () => {
  const placement = formalProjectPackageAtlasPlacement(strictSummary())
  assert.equal(placement.operationId, REGISTRATION_ID)
  assert.deepEqual(parseGalaxyObjectReference(placement.subjectRef), {
    schema: "gb.object-ref.v1",
    format: "canonical",
    kind: "proof.graph",
    id: "leanproofs",
    selector: { mode: "pinned", revision: `sha256:${HASH}` },
  })
  assert.deepEqual(formalProjectPackageAtlasPlacement(strictSummary()), placement)
  assert.equal(Object.isFrozen(placement), true)
})

test("formal package placement fails closed without strict graph identity", () => {
  assert.throws(
    () => formalProjectPackageAtlasPlacement(strictSummary({ registrationId: "not-a-uuid" })),
    /registrationId must be a UUID/u,
  )
  assert.throws(
    () => formalProjectPackageAtlasPlacement(strictSummary({
      proofGraphRef: { graphId: "leanproofs", contentSha256: HASH, status: "verified" },
    })),
    /proofGraphRef is invalid/u,
  )
  assert.throws(
    () => formalProjectPackageAtlasPlacement(strictSummary({
      proofGraphRef: { graphId: "leanproofs", contentSha256: "a" },
    })),
    /proofGraphRef is invalid/u,
  )
})

test("proof package import is a code-owned empty-input Atlas command gated on a durable canvas", () => {
  const command = listAtlasCommands({ canPlaceReference: true, canImportFormalPackage: true })
    .find((candidate) => candidate.id === "proof.package.import")
  assert.deepEqual(command, {
    id: "proof.package.import",
    pluginId: "tasks",
    plugin: {
      id: "tasks",
      displayName: "Tasks",
      version: "1.0.0",
    },
    implementationId: "builtin.proof.package.import",
    title: "Import formal project",
    description: "Register an immutable Rosetta package and place its exact passive proof graph on this Atlas.",
    enabled: true,
    unavailableReason: null,
  })
  assert.deepEqual(dispatchAtlasCommand("proof.package.import", {}), {
    ok: true,
    effect: { kind: "open-proof-package-import" },
  })
  assert.deepEqual(dispatchAtlasCommand("proof.package.import", { mission: true }), {
    ok: false,
    code: "invalid_input",
  })
  const unavailable = listAtlasCommands({ canPlaceReference: true, canImportFormalPackage: false })
    .find((candidate) => candidate.id === "proof.package.import")
  assert.equal(unavailable.enabled, false)
  assert.match(unavailable.unavailableReason, /durable Atlas canvas/u)
})

test("Atlas retains the exact imported placement and exposes retry without another POST", async () => {
  const [atlas, dialog, importer] = await Promise.all([
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/atlas/formal-project-package-import-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/graph/formal-project-package-import.tsx", import.meta.url), "utf8"),
  ])
  assert.match(atlas, /formalProjectPackageAtlasPlacement\(summary\)/u)
  assert.match(atlas, /canImportFormalPackage: atlasRuntimeReady && Boolean\(atlas\?\.durableCanvas\?\.canvasId\)/u)
  assert.match(atlas, /if \(!atlasRuntimeReady \|\| !atlas\?\.durableCanvas\?\.canvasId\) return/u)
  assert.match(atlas, /setFormalPackagePlacement\(placement\)[\s\S]*placeReference\(placement\.subjectRef, placement\.operationId\)/u)
  assert.match(atlas, /parseFormalPackageSelectionContext\(selectionContext\)/u)
  assert.match(atlas, /currentAtlasTargetRef\.current[\s\S]*current\.canvasId !== binding\.canvasId/u)
  assert.match(atlas, /retryFormalProjectPackagePlacement[\s\S]*placeReference\(placement\.subjectRef, placement\.operationId\)/u)
  assert.match(atlas, /next\.searchParams\.set\("canvas", placement\.canvasId\)/u)
  assert.match(atlas, /formalPackagePlacement\.canvasId !== canvasId/u)
  assert.match(atlas, /formalPackagePlacementFailed[\s\S]*Retry placement without importing again/u)
  assert.match(atlas, /completedFormalPackage[\s\S]*setFormalPackagePlacement\(null\)/u)
  assert.match(dialog, /<FormalProjectPackageImport/u)
  assert.match(dialog, /disabled=\{Boolean\(placement\) \|\| placing \|\| selectionContext === "atlas-unavailable"\}/u)
  assert.match(dialog, /closeDisabled=\{busy\}/u)
  assert.match(dialog, /onCloseAutoFocus/u)
  assert.match(dialog, /Retry placement/u)
  assert.match(dialog, /creates no mission or live proof work/u)
  assert.match(importer, /completionMode === "atlas-placement"/u)
  assert.equal((dialog.match(/\/api\/eln\/formal-project-packages/gu) || []).length, 0)
  assert.doesNotMatch(`${atlas}\n${dialog}`, /frontier|claimedBy|verification|publication/u)
})
