import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  collectDocumentAnchorPlacementRequests,
  createDocumentAnchorCanvasItem,
  documentAnchorReaderHref,
  hydrateDocumentAnchorCanvasPlacements,
} from "../lib/canvas/document-anchor-placement.js"
import { atlasPlacementHref, atlasWorkspaceHref, parseAtlasLocation } from "../lib/canvas/atlas-location.js"
import { openHrefForAtlasNode } from "../lib/canvas/atlas-open-href.js"
import { mergeCanvasSnapshot } from "../lib/canvas/canvas-persistence.js"
import { projectCanvasNodeObject } from "../lib/canvas/canvas-object-projection.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

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

function snapshot(items) {
  return {
    schemaId: "gb.canvas.snapshot.v1",
    items,
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }
}

test("the Atlas compatibility route preserves only canonical deep-link parameters", () => {
  assert.equal(atlasWorkspaceHref(), "/workspace")
  assert.equal(atlasWorkspaceHref({
    canvas: canvasId,
    placement: ["anchor-1", "ignored"],
    ref: "gb:object:v1:paper:paper-1:latest",
    view: "list",
    shell: "legacy",
  }), `/workspace?canvas=${canvasId}&placement=anchor-1&ref=gb%3Aobject%3Av1%3Apaper%3Apaper-1%3Alatest`)
})

test("text anchors reopen through a media-neutral exact-coordinate route", () => {
  const textAnchor = {
    ...anchor,
    representation_kind: "original",
    representation_media_type: "text/markdown; charset=utf-8",
    selector: { kind: "text-quote", exact: "literal source" },
  }
  assert.equal(
    documentAnchorReaderHref(textAnchor),
    `/documents/${textAnchor.document_revision_id}?documentAnchor=${encodeURIComponent(textAnchor.id)}`,
  )
})

test("anchor placements are collision-safe presentations without copied source content", () => {
  const first = createDocumentAnchorCanvasItem(
    anchor,
    "11111111-1111-4111-8111-111111111111",
    { x: 120, y: 240, zIndex: 3 },
  )
  const second = createDocumentAnchorCanvasItem(
    anchor,
    "22222222-2222-4222-8222-222222222222",
    { x: 570, y: 240, zIndex: 4 },
  )
  assert.notEqual(first.id, second.id)
  assert.equal(first.subjectRef, second.subjectRef)
  assert.deepEqual(first.style, {
    anchorId,
    documentRevisionId,
    schemaId: "gb.canvas.document-anchor-placement.v1",
  })
  assert.equal(JSON.stringify(first).includes("A bounded proof"), false)
  assert.equal(JSON.stringify(first).includes("polygon"), false)
  assert.match(documentAnchorReaderHref(anchor), new RegExp(`^/documents/${documentRevisionId}\\?`))
  assert.match(documentAnchorReaderHref(anchor), /paperPage=7/)
  assert.match(documentAnchorReaderHref(anchor), new RegExp(`paperAnchor=sha256%3A${anchorSha}`))
  assert.equal(
    atlasPlacementHref(canvasId, first.id),
    `/workspace?canvas=${canvasId}&placement=anchor-11111111-1111-4111-8111-111111111111`,
  )
  assert.deepEqual(parseAtlasLocation(`?canvas=${canvasId}&placement=${first.id}`), {
    canvasId,
    placementId: first.id,
  })
  assert.throws(() => atlasPlacementHref(canvasId, "bad placement"), /placement id/)
})

test("cold hydration fetches each exact authorized anchor once and retains both placements", async () => {
  const first = createDocumentAnchorCanvasItem(anchor, "11111111-1111-4111-8111-111111111111")
  const second = createDocumentAnchorCanvasItem(anchor, "22222222-2222-4222-8222-222222222222")
  let calls = 0
  const content = snapshot([first, second])
  const requests = collectDocumentAnchorPlacementRequests(content)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].items.length, 2)

  const placements = await hydrateDocumentAnchorCanvasPlacements(content, async (request) => {
    calls += 1
    assert.deepEqual(request, { documentRevisionId, anchorId, subjectRef: anchorRef })
    return anchor
  })
  assert.equal(calls, 1)
  assert.equal(placements.length, 2)
  assert.deepEqual(placements.map((item) => item.id), [first.id, second.id])
  assert.ok(placements.every((item) => item.display.href.includes(`/documents/${documentRevisionId}`)))
  const projected = projectCanvasNodeObject("galaxy.document", {
    schemaId: "gb.canvas.node.v1",
    placementId: placements[0].id,
    subjectRef: placements[0].subjectRef,
    display: placements[0].display,
    placementState: { displayMode: "card", collapsed: false, style: placements[0].style },
  })
  assert.equal(projected.provenance.provider, "galaxy.document")

  const nodeData = {
    schemaId: "gb.canvas.node.v1",
    placementId: placements[0].id,
    subjectRef: placements[0].subjectRef,
    availability: "resolved",
    display: placements[0].display,
    placementState: {
      displayMode: placements[0].displayMode,
      collapsed: placements[0].collapsed,
      style: placements[0].style,
    },
  }
  assert.equal(
    openHrefForAtlasNode(nodeData, {
      status: "resolved",
      handles: [{ href: `/workspace?ref=${encodeURIComponent(anchorRef)}` }],
    }),
    placements[0].display.href,
  )
  assert.equal(
    openHrefForAtlasNode({
      ...nodeData,
      placementState: { ...nodeData.placementState, style: {} },
    }, {
      status: "resolved",
      handles: [{ href: `/workspace?ref=${encodeURIComponent(anchorRef)}` }],
    }),
    `/workspace?ref=${encodeURIComponent(anchorRef)}`,
  )

  const merged = mergeCanvasSnapshot({ placements, relations: [] }, content)
  assert.equal(merged.placements.length, 2)
  assert.deepEqual(merged.placements.map((item) => item.subjectRef), [anchorRef, anchorRef])
})

test("cold hydration fails closed for denied, stale, and mismatched anchor responses", async () => {
  const item = createDocumentAnchorCanvasItem(anchor, "11111111-1111-4111-8111-111111111111")
  assert.deepEqual(
    await hydrateDocumentAnchorCanvasPlacements(snapshot([item]), async () => { throw new Error("403") }),
    [],
  )
  assert.deepEqual(
    await hydrateDocumentAnchorCanvasPlacements(snapshot([item]), async () => ({
      ...anchor,
      ref: createGalaxyObjectReference("document.anchor", anchorId, {
        mode: "pinned",
        revision: `sha256:${"c".repeat(64)}`,
      }),
      representation_sha256: "c".repeat(64),
    })),
    [],
  )
  const tampered = structuredClone(item)
  tampered.style.documentRevisionId = "223e4567-e89b-42d3-a456-426614174000"
  assert.deepEqual(
    await hydrateDocumentAnchorCanvasPlacements(snapshot([tampered]), async () => anchor),
    [],
  )
})

test("reader placement and Atlas hydration are wired to durable APIs", async () => {
  const [reader, runtime, atlas] = await Promise.all([
    readFile(new URL("../components/papers/durable-paper-reader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/canvas/document-anchor-canvas.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
  ])
  assert.match(reader, /placeDocumentAnchorRecoverably/)
  assert.match(reader, /validateDocumentAnchorPlacementRecovery/)
  assert.match(reader, /atlasPlacementHref\(recovery\.canvasId, recovery\.placementId\)/)
  assert.match(reader, />Place on atlas</)
  assert.match(reader, />Open placed card in Atlas</)
  assert.match(runtime, /expectedVersion: current\.version/)
  assert.match(runtime, /expectedContentHash: current\.contentHash/)
  assert.match(runtime, /commands: \[\{ type: "item\.place", item \}\]/)
  assert.match(runtime, /place: \(operationId, canvasId\) => placeDocumentAnchorOnCanvas/)
  assert.match(runtime, /advanceDocumentAnchorPlacementRecovery/)
  assert.match(runtime, /updated\.replayed === true[\s\S]*getCanvas/)
  assert.match(atlas, /hydrateDocumentAnchorCanvasPlacements/)
  assert.match(atlas, /requestAuthorizedDocumentAnchor/)
  assert.match(atlas, /mergeCanvasSnapshot\(baseProjection, durableCanvas\.content\)/)
})
