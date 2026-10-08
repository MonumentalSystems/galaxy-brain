import assert from "node:assert/strict"
import test from "node:test"

import {
  DocumentAnchorContractError,
  canonicalAnchorJson,
  createDocumentAnchor,
  documentAnchorRequestHash,
  isDocumentAnchorTextMediaType,
  validateDocumentAnchorSelector,
} from "../lib/document-anchor.js"

const ID = "123e4567-e89b-42d3-a456-426614174000"
const HASH = "a".repeat(64)
const structure = {
  schemaId: "gb.document-structure.v1",
  pages: [{ number: 0 }, { number: 1 }],
  blocks: [
    { id: "heading", text: "A theorem", page: 0 },
    { id: "equation", latex: "x^2", page: 1 },
  ],
  readingOrder: ["heading", "equation"],
}

const pdfRepresentation = {
  id: ID,
  kind: "original",
  media_type: "application/pdf",
  content_sha256: HASH,
  page_count: 2,
}
const textRepresentation = {
  id: ID,
  kind: "text",
  media_type: "text/plain",
  content_sha256: HASH,
  content: "first context theorem suffix; second context theorem ending",
}
const structureRepresentation = {
  id: ID,
  kind: "document-structure",
  media_type: "application/vnd.galaxy.document-structure+json",
  content_sha256: HASH,
  content: structure,
}

test("page regions are normalized, bounded, page-aware, and hash-addressed", () => {
  const selector = {
    polygon: [0, 0, 1, 0, 1, 0.5, 0, 0.5],
    coordinateSpace: "normalized-page",
    page: 2,
    quoteHash: "b".repeat(64),
    kind: "page-region",
  }
  const anchor = createDocumentAnchor(structureRepresentation, selector)
  assert.deepEqual(anchor.selector, {
    kind: "page-region",
    page: 2,
    coordinateSpace: "normalized-page",
    polygon: [0, 0, 1, 0, 1, 0.5, 0, 0.5],
    quoteHash: "b".repeat(64),
  })
  assert.equal(anchor.id, `sha256:${anchor.anchorSha256}`)
  assert.equal(anchor.selectorSha256, "602bcc56c77ff0313118206810801e4eb070758cc1a49e8b04ddb5d6080be7c6")
  assert.equal(anchor.anchorSha256, "dfe2319bbefb0999a0a3a25bc94447dc8a907216561c535dad73bb1e10c259ad")
  assert.equal(documentAnchorRequestHash(structureRepresentation, selector), "9e9ddb7bc39a13137b896f28d267deeaca655da4e4538ac9e5051edfe3e4bfc6")

  const shuffled = { ...structureRepresentation, contentSha256: HASH }
  delete shuffled.content_sha256
  assert.equal(createDocumentAnchor(shuffled, { ...selector }).id, anchor.id)
})

test("page regions reject unbound coordinate systems, malformed polygons, and invalid pages", () => {
  const base = {
    kind: "page-region", page: 1, coordinateSpace: "normalized-page",
    polygon: [0, 0, 1, 0, 1, 1, 0, 1],
  }
  assert.throws(() => validateDocumentAnchorSelector({ ...base, page: 0 }, structureRepresentation), /1-based/)
  assert.throws(() => validateDocumentAnchorSelector({ ...base, page: 3 }, structureRepresentation), /page range/)
  assert.throws(() => validateDocumentAnchorSelector({ ...base, polygon: [0, 0, 1, 1] }, structureRepresentation), /4 to 64/)
  assert.throws(() => validateDocumentAnchorSelector({ ...base, polygon: [0, 0, 0.2, 0.2, 0.4, 0.4, 0.6, 0.6] }, structureRepresentation), /non-zero area/)
  assert.throws(() => validateDocumentAnchorSelector({ ...base, polygon: [0, 0, 2, 0, 1, 1, 0, 1] }, structureRepresentation), /normalized/)
  assert.throws(() => validateDocumentAnchorSelector({ ...base, coordinateSpace: "pdf-points" }, structureRepresentation), /normalized-page/)
  assert.throws(() => validateDocumentAnchorSelector({ ...base, unknown: true }, structureRepresentation), /unknown fields/)
  assert.throws(() => validateDocumentAnchorSelector(base, pdfRepresentation), /page-aware document structure/)
})

test("text quotes must resolve exact bounded flat text with optional immediate context", () => {
  assert.deepEqual(validateDocumentAnchorSelector({
    kind: "text-quote", exact: "theorem", prefix: "second context ", suffix: " ending",
  }, textRepresentation), {
    kind: "text-quote", exact: "theorem", prefix: "second context ", suffix: " ending",
  })
  assert.throws(() => validateDocumentAnchorSelector({ kind: "text-quote", exact: "absent" }, textRepresentation), /does not identify/)
  assert.throws(() => validateDocumentAnchorSelector({ kind: "text-quote", exact: "theorem", prefix: "wrong" }, textRepresentation), /does not identify/)
  assert.throws(() => validateDocumentAnchorSelector({ kind: "text-quote", exact: "theorem" }, textRepresentation), /ambiguous/)
  assert.throws(() => validateDocumentAnchorSelector({ kind: "text-quote", exact: "x".repeat(16_001) }, textRepresentation), /16000/)
  assert.throws(() => validateDocumentAnchorSelector({ kind: "text-quote", exact: "ending", page: 1 }, textRepresentation), /page metadata/)
  assert.throws(() => validateDocumentAnchorSelector({ kind: "text-quote", exact: "theorem", prefix: null }, textRepresentation), /invalid|must be a string/)
  assert.equal(validateDocumentAnchorSelector(
    { kind: "text-quote", exact: "ending", page: 2 },
    { ...textRepresentation, page_count: 2 },
  ).page, 2)
  assert.throws(() => validateDocumentAnchorSelector({ kind: "text-quote", exact: "A theorem" }, structureRepresentation), /flat text/)
})

test("text quotes bind exact textual originals without making binary originals eligible", () => {
  const original = {
    ...textRepresentation,
    kind: "original",
    media_type: "text/x-python; charset=utf-8",
  }
  const selector = { kind: "text-quote", exact: "ending" }
  assert.deepEqual(validateDocumentAnchorSelector(selector, original), selector)
  assert.equal(createDocumentAnchor(original, selector).id, createDocumentAnchor(textRepresentation, selector).id)
  assert.equal(isDocumentAnchorTextMediaType("application/json; charset=utf-8"), true)
  assert.equal(isDocumentAnchorTextMediaType("application/pdf"), false)
  assert.equal(isDocumentAnchorTextMediaType("text/"), false)
  assert.throws(() => validateDocumentAnchorSelector(selector, {
    ...original, media_type: "application/pdf",
  }), /textual original/)
})

test("structure selectors validate pages and restricted block pointers against content", () => {
  assert.deepEqual(validateDocumentAnchorSelector({ kind: "json-pointer", pointer: "/blocks/1" }, structureRepresentation), {
    kind: "json-pointer", pointer: "/blocks/1",
  })
  assert.throws(() => validateDocumentAnchorSelector({ kind: "json-pointer", pointer: "/blocks/2" }, structureRepresentation), /existing/)
  assert.throws(() => validateDocumentAnchorSelector({ kind: "json-pointer", pointer: "/pages/0" }, structureRepresentation), /existing/)
  assert.throws(() => validateDocumentAnchorSelector({
    kind: "page-region", page: 3, coordinateSpace: "normalized-page",
    polygon: [0, 0, 1, 0, 1, 1, 0, 1],
  }, structureRepresentation), /page range/)
})

test("identity includes exact representation evidence and canonical selector JSON", () => {
  const selector = { kind: "json-pointer", pointer: "/blocks/0" }
  const first = createDocumentAnchor(structureRepresentation, selector)
  const changed = createDocumentAnchor({ ...structureRepresentation, content_sha256: "c".repeat(64) }, selector)
  assert.notEqual(first.id, changed.id)
  assert.notEqual(documentAnchorRequestHash(structureRepresentation, selector), first.anchorSha256)
  assert.equal(canonicalAnchorJson({ z: 1, a: { y: 2, x: 1 } }), '{"a":{"x":1,"y":2},"z":1}')
  const unicode = createDocumentAnchor(
    { ...textRepresentation, content: "😀 theorem" },
    { kind: "text-quote", exact: "😀" },
  )
  assert.equal(unicode.selectorSha256, "d7b7dbc280f7d8aecbc6a6676a49c2208bd5c747d6c22413f5d45bbb4e05b9f3")
  assert.equal(unicode.anchorSha256, "08ee44d6e44cd9d2de8ad5de8cbe64c578025e2389afccb77e5011ebf7aa08f7")
  assert.throws(() => createDocumentAnchor({ ...structureRepresentation, id: "not-a-uuid" }, selector), DocumentAnchorContractError)
  assert.throws(() => createDocumentAnchor({
    ...textRepresentation,
    media_type: null,
    mediaType: "text/plain",
  }, { kind: "text-quote", exact: "ending" }), /both media_type and mediaType/)
})

test("sub-micro normalized coordinates have one cross-runtime canonical identity", () => {
  const anchor = createDocumentAnchor(structureRepresentation, {
    kind: "page-region", page: 1, coordinateSpace: "normalized-page",
    polygon: [1e-7, 0.2, 0.8, 0.2, 0.8, 0.9, 1e-7, 0.9],
  })
  assert.deepEqual(anchor.selector.polygon, [0, 0.2, 0.8, 0.2, 0.8, 0.9, 0, 0.9])
  assert.equal(anchor.selectorSha256, "be1fa13af017bb5c25c82bca1ebe5d5d155baa2a381f8a938baafd1b40ab77ac")
  assert.equal(anchor.anchorSha256, "fbf8b9cfefdf5656a16855422f8b9ccc97afda9510e3fbf878fe0a4a777a38f6")
})
