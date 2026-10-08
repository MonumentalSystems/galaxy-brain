import assert from "node:assert/strict"
import test from "node:test"

import { exactGenerousSurfaceHref } from "../lib/generous-surface-open.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { projectSurfaceObject } from "../lib/object-projection-adapters.js"

const surfaceId = "123e4567-e89b-42d3-a456-426614174000"
const hash = "a".repeat(64)

function surfaceNode(overrides = {}) {
  const projection = projectSurfaceObject({
    id: surfaceId,
    title: "Exact Generous surface",
    status: "promoted",
    catalog_id: "generous.a2ui",
    current_version: 7,
    current_content_hash: hash,
  })
  return {
    id: projection.ref,
    ref: projection.ref,
    kind: "surface",
    title: projection.title,
    authority: "galaxy",
    projection,
    provenance: [],
    overlays: {},
    ...overrides,
  }
}

function withProjection(node, changes) {
  return { ...node, projection: { ...node.projection, ...changes } }
}

test("builds one fixed same-origin destination for an exact registered Generous surface", () => {
  const href = exactGenerousSurfaceHref(surfaceNode())
  assert.equal(
    href,
    `/surfaces?surface=${surfaceId}&version=7&hash=${hash}`,
  )
  const url = new URL(href, "https://galaxybrain.info")
  assert.equal(url.origin, "https://galaxybrain.info")
  assert.deepEqual([...url.searchParams], [
    ["surface", surfaceId],
    ["version", "7"],
    ["hash", hash],
  ])
})

test("requires the graph node and projection to name the same exact canonical surface", () => {
  const node = surfaceNode()
  const otherId = "223e4567-e89b-42d3-a456-426614174000"
  const otherRef = createGalaxyObjectReference("surface", otherId, {
    mode: "pinned",
    revision: `sha256:${hash}`,
  })
  const latestRef = createGalaxyObjectReference("surface", surfaceId)

  for (const candidate of [
    null,
    [],
    { ...node, kind: "paper" },
    { ...node, ref: otherRef },
    withProjection(node, { kind: "paper" }),
    withProjection(node, { ref: latestRef, revision: { policy: "latest", id: null, contentHash: hash } }),
    withProjection(node, { ref: node.ref.replace("sha256%3A", "sha256%3a") }),
  ]) {
    assert.equal(exactGenerousSurfaceHref(candidate), null)
  }
})

test("requires the pinned selector, revision, representation, and hash to agree", () => {
  const node = surfaceNode()
  const anotherHash = "b".repeat(64)
  const representation = node.projection.representations[0]
  const cases = [
    withProjection(node, { revision: { ...node.projection.revision, contentHash: anotherHash } }),
    withProjection(node, { revision: { ...node.projection.revision, id: `sha256:${anotherHash}` } }),
    withProjection(node, { representations: [] }),
    withProjection(node, { representations: [representation, { ...representation, ref: `${representation.ref}:copy` }] }),
    withProjection(node, { representations: [{ ...representation, kind: "json" }] }),
    withProjection(node, { representations: [{ ...representation, mediaType: "text/plain" }] }),
    withProjection(node, { representations: [{ ...representation, contentHash: anotherHash }] }),
  ]
  for (const candidate of cases) assert.equal(exactGenerousSurfaceHref(candidate), null)
})

test("requires Galaxy surface provenance, a canonical UUID, a safe positive version, and open capability", () => {
  const node = surfaceNode()
  const provenance = node.projection.provenance
  const unicodeRef = createGalaxyObjectReference("surface", "surface-研究", {
    mode: "pinned",
    revision: `sha256:${hash}`,
  })
  const cases = [
    withProjection(node, { provenance: { ...provenance, provider: "generous.remote" } }),
    withProjection(node, { provenance: { ...provenance, sourceId: "223e4567-e89b-42d3-a456-426614174000" } }),
    withProjection(node, { provenance: { ...provenance, sourceRevision: "version:0" } }),
    withProjection(node, { provenance: { ...provenance, sourceRevision: "version:01" } }),
    withProjection(node, { provenance: { ...provenance, sourceRevision: `version:${Number.MAX_SAFE_INTEGER}0` } }),
    withProjection(node, { capabilities: node.projection.capabilities.filter((item) => item !== "open") }),
    withProjection({ ...node, ref: unicodeRef }, {
      ref: unicodeRef,
      provenance: { ...provenance, sourceId: "surface-研究" },
    }),
  ]
  for (const candidate of cases) assert.equal(exactGenerousSurfaceHref(candidate), null)
})

test("does not trust caller-supplied projector labels or implementation identifiers", () => {
  const exact = surfaceNode({
    projector: { id: "paper", pluginId: "attacker", implementationId: "dynamic.module" },
  })
  assert.equal(exactGenerousSurfaceHref(exact), `/surfaces?surface=${surfaceId}&version=7&hash=${hash}`)

  const paperRef = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned",
    revision: `sha256:${hash}`,
  })
  const forged = withProjection({ ...exact, ref: paperRef, kind: "paper" }, {
    ref: paperRef,
    kind: "paper",
    provenance: { ...exact.projection.provenance, sourceId: "paper-1" },
  })
  forged.projector = { id: "surface", pluginId: "generous", implementationId: "builtin.object-projector.surface" }
  assert.equal(exactGenerousSurfaceHref(forged), null)
})
