import assert from "node:assert/strict"
import test from "node:test"

import { hydrateAtlasSurfaceSpecs, surfaceResolutionIdentity } from "../lib/atlas-surface-materialization.js"
import { projectSurfaceObject } from "../lib/object-projection-adapters.js"
import { BUILTIN_GENEROUS_SURFACE_RENDERER } from "../lib/surface-renderer-registry.js"

const SURFACE_ID = "723e4567-e89b-42d3-a456-426614174000"
const HASH = "a".repeat(64)
const SPEC = Object.freeze({
  schema: "gb.surface.v1",
  catalog: { id: "generous.a2ui", version: "1" },
  surfaceUpdate: {
    surfaceId: "atlas-surface",
    components: [{ id: "title", component: { Title: { text: "Exact surface" } } }],
  },
  bindings: [],
})

function hydration(overrides = {}) {
  const projection = projectSurfaceObject({
    id: SURFACE_ID,
    title: "Exact surface",
    status: "promoted",
    catalog_id: "generous.a2ui",
    current_version: 7,
    current_content_hash: HASH,
    placement_eligible: true,
  })
  return Object.freeze({
    requestedRef: projection.ref,
    status: "resolved",
    resolvedRef: projection.ref,
    provider: "galaxy.surface",
    projection,
    handles: [],
    ...overrides,
  })
}

function materialization(overrides = {}) {
  return {
    surface_id: SURFACE_ID,
    version: 7,
    definition_content_hash: HASH,
    schema_digest: BUILTIN_GENEROUS_SURFACE_RENDERER.schemaDigest,
    catalog_digest: BUILTIN_GENEROUS_SURFACE_RENDERER.catalogDigest,
    renderer_version: BUILTIN_GENEROUS_SURFACE_RENDERER.rendererVersion,
    definition: structuredClone(SPEC),
    materialized_spec: structuredClone(SPEC),
    bindings: [],
    resolved_at: "2026-09-27T12:00:00Z",
    ...overrides,
  }
}

test("Atlas attaches only an exact validated transient Generous materialization", async () => {
  const result = hydration()
  const calls = []
  const hydrated = await hydrateAtlasSurfaceSpecs({ [result.requestedRef]: result }, async (...args) => {
    calls.push(args)
    return materialization()
  })

  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [[SURFACE_ID, 7]])
  assert.deepEqual(hydrated[result.requestedRef].surfaceSpec, SPEC)
  assert.ok(Object.isFrozen(hydrated) && Object.isFrozen(hydrated[result.requestedRef]))
})

test("mismatched, malformed, failed, and non-surface materializations remain metadata-only", async () => {
  const result = hydration()
  const wrongHash = await hydrateAtlasSurfaceSpecs(
    { [result.requestedRef]: result },
    async () => materialization({ definition_content_hash: "b".repeat(64) }),
  )
  assert.equal(wrongHash[result.requestedRef].surfaceSpec, undefined)

  const staleRenderer = await hydrateAtlasSurfaceSpecs(
    { [result.requestedRef]: result },
    async () => materialization({ renderer_version: "stale-renderer-contract" }),
  )
  assert.equal(staleRenderer[result.requestedRef].surfaceSpec, undefined)

  const failed = await hydrateAtlasSurfaceSpecs(
    { [result.requestedRef]: result },
    async () => { throw new Error("private detail") },
  )
  assert.equal(failed[result.requestedRef].surfaceSpec, undefined)

  let calls = 0
  const malformedProjection = {
    ...result,
    projection: {
      ...result.projection,
      provenance: { ...result.projection.provenance, sourceRevision: "latest" },
    },
  }
  const malformed = await hydrateAtlasSurfaceSpecs(
    { [result.requestedRef]: malformedProjection },
    async () => { calls += 1; return materialization() },
  )
  assert.equal(calls, 0)
  assert.equal(malformed[result.requestedRef].surfaceSpec, undefined)
  assert.equal(surfaceResolutionIdentity({ status: "unavailable" }), null)
})

test("an aborted surface materialization never attaches renderer input", async () => {
  const result = hydration()
  const controller = new AbortController()
  const hydrated = await hydrateAtlasSurfaceSpecs(
    { [result.requestedRef]: result },
    async () => {
      controller.abort()
      return materialization()
    },
    controller.signal,
  )
  assert.equal(hydrated[result.requestedRef].surfaceSpec, undefined)
})
