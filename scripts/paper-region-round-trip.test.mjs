import assert from "node:assert/strict"
import test from "node:test"

import {
  createDocumentAnchorCanvasItem,
  hydrateDocumentAnchorCanvasPlacements,
} from "../lib/canvas/document-anchor-placement.js"
import { atlasPlacementHref, parseAtlasLocation } from "../lib/canvas/atlas-location.js"
import { runRecoverableDocumentAnchorPlacement } from "../lib/canvas/document-anchor-placement-recovery.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { parsePaperReaderLocation } from "../lib/paper-reader.js"
import { paperTaskInput } from "../lib/paper-reader-task-saga.js"

const documentRevisionId = "123e4567-e89b-42d3-a456-426614174000"
const canvasId = "323e4567-e89b-42d3-a456-426614174000"
const representationSha = "b".repeat(64)
const anchorSha = "a".repeat(64)
const anchorId = `sha256:${anchorSha}`
const anchorRef = createGalaxyObjectReference("document.anchor", anchorId, {
  mode: "pinned",
  revision: `sha256:${representationSha}`,
})
const anchor = {
  schemaId: "gb.anchor.v1",
  id: anchorId,
  ref: anchorRef,
  document_revision_id: documentRevisionId,
  representation_sha256: representationSha,
  anchor_sha256: anchorSha,
  title: "A bounded proof",
  selector_kind: "page-region",
  selector: {
    kind: "page-region",
    page: 7,
    coordinateSpace: "normalized-page",
    polygon: [0.1, 0.2, 0.5, 0.2, 0.5, 0.4, 0.1, 0.4],
  },
}

function memoryStorage() {
  const values = new Map()
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
  }
}

test("one exact paper region round-trips through Atlas and a HAM task resource", async () => {
  const storage = memoryStorage()
  const scope = {
    tenantId: "tenant-a",
    principalId: "principal-a",
    documentRevisionId,
    anchorId,
  }
  let item
  const placed = await runRecoverableDocumentAnchorPlacement({
    storage,
    scope,
    async resolveCanvasId() { return canvasId },
    async place(operationId, exactCanvasId) {
      assert.equal(exactCanvasId, canvasId)
      item = createDocumentAnchorCanvasItem(
        anchor,
        operationId,
        { x: 120, y: 240, zIndex: 3 },
        7,
      )
      return { canvasId: exactCanvasId, placementId: item.id, replayed: false }
    },
  })
  assert.equal(placed.recovery.canvasId, canvasId)
  assert.equal(placed.recovery.placementId, item.id)

  const afterReload = await runRecoverableDocumentAnchorPlacement({
    storage,
    scope,
    async resolveCanvasId() { throw new Error("confirmed recovery must not resolve a new default") },
    async place(operationId, exactCanvasId) {
      assert.equal(operationId, placed.recovery.operationId)
      assert.equal(exactCanvasId, canvasId)
      return { canvasId: exactCanvasId, placementId: item.id, replayed: true }
    },
  })
  assert.equal(afterReload.recovered, true)
  assert.equal(afterReload.recovery.placementId, item.id)

  const durableSnapshot = JSON.parse(JSON.stringify({
    schemaId: "gb.canvas.snapshot.v1",
    items: [item],
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }))

  const hydrated = await hydrateDocumentAnchorCanvasPlacements(
    durableSnapshot,
    async ({ documentRevisionId: requestedRevision, anchorId: requestedAnchor }) => {
      assert.equal(requestedRevision, documentRevisionId)
      assert.equal(requestedAnchor, anchorId)
      return anchor
    },
  )
  assert.equal(hydrated.length, 1)

  const atlasLocation = new URL(atlasPlacementHref(canvasId, item.id), "https://galaxy.example")
  assert.equal(atlasLocation.pathname, "/workspace")
  assert.deepEqual(parseAtlasLocation(atlasLocation.search), {
    canvasId,
    placementId: hydrated[0].id,
  })

  const sourceLocation = new URL(hydrated[0].display.href, "https://galaxy.example")
  assert.equal(sourceLocation.pathname, `/documents/${documentRevisionId}`)
  assert.deepEqual(parsePaperReaderLocation(sourceLocation.search), {
    schemaId: "gb.paper-reader-location.v1",
    view: "pdf",
    page: 7,
    anchorId,
  })

  const request = {
    schemaId: "gb.paper-task-request.v1",
    idempotencyKey: placed.recovery.operationId,
    requestedAt: "2026-09-24T12:00:00.000Z",
    anchor,
    title: "Investigate this exact region",
    goal: "Explain the highlighted proof step.",
    sourceHref: hydrated[0].display.href,
  }
  assert.deepEqual(paperTaskInput(request).resourceKeys, [anchorRef])
  assert.deepEqual(
    parsePaperReaderLocation(new URL(request.sourceHref, "https://galaxy.example").search),
    parsePaperReaderLocation(sourceLocation.search),
  )
})
