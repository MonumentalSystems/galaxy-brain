import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  authorizeInkPlacementDescriptor,
  createInkCanvasItem,
  inkRepresentationContentPath,
  reconcileInkPlacement,
} from "../lib/canvas/ink-placement.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const OPERATION = "123e4567-e89b-42d3-a456-426614174000"
const REVISION = "123e4567-e89b-42d3-a456-426614174001"
const REPRESENTATION = "123e4567-e89b-42d3-a456-426614174002"
const DOCUMENT = "123e4567-e89b-42d3-a456-426614174003"
const HASH = "a".repeat(64)
const REVISION_HASH = "b".repeat(64)
const SUBJECT = createGalaxyObjectReference("document", DOCUMENT, {
  mode: "pinned",
  revision: `sha256:${REVISION_HASH}`,
})
const DESCRIPTOR = {
  schemaId: "gb.canvas.ink-placement.v1",
  documentId: DOCUMENT,
  revisionSha256: REVISION_HASH,
  documentRevisionId: REVISION,
  representationId: REPRESENTATION,
  contentSha256: HASH,
}

function snapshot(items = []) {
  return { schemaId: "gb.canvas.snapshot.v1", items, edges: [], removedItemIds: [], removedEdgeIds: [] }
}

function canvas(content, overrides = {}) {
  return {
    canvasId: "123e4567-e89b-42d3-a456-426614174010",
    workspaceId: "workspace-1",
    slug: "main",
    title: "Atlas",
    isDefault: true,
    version: 1,
    contentHash: `sha256:${"c".repeat(64)}`,
    content,
    ...overrides,
  }
}

test("ink placement stores only canonical identity, exact representation coordinates, and geometry", () => {
  const item = createInkCanvasItem(SUBJECT, OPERATION, DESCRIPTOR, snapshot())
  assert.deepEqual(item, {
    id: `ink-${OPERATION}`,
    subjectRef: SUBJECT,
    nodeType: "galaxy.document",
    x: 80,
    y: 80,
    width: 420,
    height: 260,
    angle: 0,
    zIndex: 0,
    displayMode: "ink",
    collapsed: false,
    style: {
      contentSha256: HASH,
      documentId: DOCUMENT,
      documentRevisionId: REVISION,
      representationId: REPRESENTATION,
      revisionSha256: REVISION_HASH,
      schemaId: "gb.canvas.ink-placement.v1",
    },
  })
  assert.doesNotMatch(JSON.stringify(item), /<svg|points|stroke=/u)
  assert.equal(
    inkRepresentationContentPath(DESCRIPTOR),
    `/api/eln/documents/${REVISION}/representations/${REPRESENTATION}/content?document_id=${DOCUMENT}&revision_sha256=${REVISION_HASH}`,
  )
})

test("ink placement requires a pinned document and rejects descriptor expansion", () => {
  assert.throws(() => createInkCanvasItem(
    createGalaxyObjectReference("document", "doc-latest"),
    OPERATION,
    DESCRIPTOR,
    snapshot(),
  ), /exact document revision/u)
  assert.throws(() => createInkCanvasItem(SUBJECT, OPERATION, { ...DESCRIPTOR, svg: "<svg/>" }, snapshot()), /not supported/u)
  assert.throws(() => createInkCanvasItem(
    createGalaxyObjectReference("document", "123e4567-e89b-42d3-a456-426614174099", {
      mode: "pinned", revision: `sha256:${REVISION_HASH}`,
    }),
    OPERATION,
    DESCRIPTOR,
    snapshot(),
  ), /does not match/u)
})

test("ink rendering requires the exact subject revision and representation authorized by hydration", () => {
  const projection = {
    ref: SUBJECT,
    kind: "document",
    revision: { policy: "pinned", id: `sha256:${REVISION_HASH}`, contentHash: REVISION_HASH },
    provenance: { sourceId: DOCUMENT },
    representations: [{
      ref: `gb:representation:document:${DOCUMENT}:${REPRESENTATION}`,
      kind: "original",
      mediaType: "application/json",
      contentHash: HASH,
    }],
  }
  assert.deepEqual(authorizeInkPlacementDescriptor(DESCRIPTOR, SUBJECT, projection), DESCRIPTOR)
  assert.throws(() => authorizeInkPlacementDescriptor(
    DESCRIPTOR,
    createGalaxyObjectReference("document", "123e4567-e89b-42d3-a456-426614174099", {
      mode: "pinned", revision: `sha256:${REVISION_HASH}`,
    }),
    projection,
  ), /does not match/u)
  assert.throws(() => authorizeInkPlacementDescriptor(DESCRIPTOR, SUBJECT, {
    ...projection,
    representations: [{ ...projection.representations[0], contentHash: "c".repeat(64) }],
  }), /representation is not authorized/u)
})

test("ink placement reconciles one stable mutation and verifies the authoritative item", async () => {
  const current = canvas(snapshot())
  let mutation
  const result = await reconcileInkPlacement({
    current,
    subjectRef: SUBJECT,
    operationId: OPERATION,
    descriptor: DESCRIPTOR,
    mutateCanvas: async (canvasId, input) => {
      mutation = { canvasId, input }
      return canvas(snapshot([input.commands[0].item]), {
        version: 2,
        contentHash: `sha256:${"d".repeat(64)}`,
      })
    },
    reloadCanvas: async () => { throw new Error("unexpected reload") },
  })
  assert.equal(result.item.id, `ink-${OPERATION}`)
  assert.equal(result.canvas.version, 2)
  assert.equal(mutation.canvasId, current.canvasId)
  assert.equal(mutation.input.idempotencyKey, `ink-place:${OPERATION}`)
  assert.equal(mutation.input.expectedVersion, 1)
})

test("Atlas canvas, selection detail, and accessible list share the exact ink representation preview", async () => {
  const [atlas, node, host, preview, loader] = await Promise.all([
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/canvas/galaxy-canvas-node.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/projections/object-projection-host.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/atlas/ink-placement-preview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/ink-preview.js", import.meta.url), "utf8"),
  ])
  assert.ok((atlas.match(/<InkPlacementPreview/g) ?? []).length >= 2)
  assert.match(node, /representationPreview=\{viewportVisible && !moving && !data\.placementState\.collapsed && ink \? \(/u)
  assert.match(host, /data-slot="object-projection-representation"/u)
  assert.match(preview, /loadInkPreviewObjectUrl/u)
  assert.match(loader, /digest !== descriptor\.contentSha256/u)
  assert.match(atlas, /authorizeInkPlacementDescriptor/u)
  assert.match(node, /authorizeInkPlacementDescriptor/u)
})
