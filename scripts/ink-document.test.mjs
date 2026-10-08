import assert from "node:assert/strict"
import test from "node:test"

import {
  MAX_INK_POINTS,
  normalizeInkDocument,
  normalizeInkStrokes,
  renderInkDocumentSvg,
  selectInkOriginalRepresentation,
  serializeInkDocument,
} from "../lib/ink-document.js"
import { prepareDurableDocumentImport } from "../lib/durable-document-import.js"

const DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174009"
const REVISION_ID = "123e4567-e89b-42d3-a456-426614174000"
const REPRESENTATION_ID = "123e4567-e89b-42d3-a456-426614174001"
const HASH = "a".repeat(64)
const REVISION_HASH = "b".repeat(64)

test("ink serialization is deterministic, bounded JSON and renders only safe generated SVG", () => {
  const strokes = [{
    color: "#315F49",
    width: 4,
    opacity: 1,
    points: [{ x: 1, y: 2 }, { x: 10.25, y: 20.5 }],
  }]
  const first = serializeInkDocument(strokes)
  assert.equal(first, serializeInkDocument(strokes))
  const parsed = JSON.parse(first)
  assert.equal(normalizeInkDocument(parsed).schemaId, "gb.ink-document.v1")
  const svg = renderInkDocumentSvg(parsed)
  assert.match(svg, /<path d="M1 2 L10\.25 20\.5"/u)
  assert.match(svg, /stroke="#315f49"/u)
  assert.doesNotMatch(svg, /<script|<foreignObject|\shref=/iu)
  assert.equal(Object.isFrozen(normalizeInkStrokes(strokes)), true)
})

test("ink rejects unsupported fields, out-of-bounds points, and excessive point counts", () => {
  assert.throws(() => serializeInkDocument([{ color: "#315f49", width: 4, opacity: 1, points: [{ x: 0, y: 0 }, { x: 961, y: 1 }] }]), /outside/u)
  assert.throws(() => serializeInkDocument([{ color: "#315f49", width: 4, opacity: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], href: "https://evil.test" }]), /not supported/u)
  assert.throws(() => serializeInkDocument([{ color: "#315f49", width: 4, opacity: 1, points: Array.from({ length: MAX_INK_POINTS + 1 }, () => ({ x: 1, y: 1 })) }]), /too many points/u)
  assert.throws(() => normalizeInkDocument({ ...JSON.parse(serializeInkDocument([{ color: "#315f49", width: 4, opacity: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }])), html: "<script/>" }), /not supported/u)
})

test("Save and place ink bytes reach canonical durable upload preparation as JSON", async () => {
  const document = serializeInkDocument([{
    color: "#315f49", width: 4, opacity: 1, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
  }])
  const bytes = new TextEncoder().encode(document)
  const prepared = await prepareDurableDocumentImport({
    name: "atlas-ink.json",
    type: "application/json",
    size: bytes.byteLength,
    async arrayBuffer() { return bytes.slice().buffer },
  }, {
    title: "Winding sketch",
    filename: "atlas-ink.json",
    sourceKind: "upload",
    sourceUri: null,
    arxivId: null,
  })
  assert.equal(prepared.mediaType, "application/json")
  assert.equal(prepared.bytes.byteLength, bytes.byteLength)
  assert.match(prepared.idempotencyKey, /^document-import:[0-9a-f]{64}$/u)
})

test("ink representation selection binds the exact imported revision, media type, and bytes", () => {
  const imported = {
    document_id: DOCUMENT_ID,
    revision_id: REVISION_ID,
    revision_sha256: REVISION_HASH,
    content_sha256: HASH,
  }
  assert.deepEqual(selectInkOriginalRepresentation({
    schemaId: "gb.document.representations.v1",
    document_revision_id: REVISION_ID,
    representations: [{
      id: REPRESENTATION_ID,
      kind: "original",
      media_type: "application/json",
      content_sha256: HASH,
    }],
  }, imported), {
    schemaId: "gb.canvas.ink-placement.v1",
    documentId: DOCUMENT_ID,
    revisionSha256: REVISION_HASH,
    documentRevisionId: REVISION_ID,
    representationId: REPRESENTATION_ID,
    contentSha256: HASH,
  })
  assert.throws(() => selectInkOriginalRepresentation({
    schemaId: "gb.document.representations.v1",
    document_revision_id: REVISION_ID,
    representations: [{
      id: REPRESENTATION_ID,
      kind: "original",
      media_type: "application/json",
      content_sha256: "b".repeat(64),
    }],
  }, imported), /unavailable/u)
})
