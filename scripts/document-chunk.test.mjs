import assert from "node:assert/strict"
import test from "node:test"

import {
  CHUNK_MANIFEST_SCHEMA_ID,
  CHUNK_SCHEMA_ID,
  DocumentChunkContractError,
  canonicalChunkJson,
  currentDocumentChunker,
  materializeDocumentChunks,
} from "../lib/document-chunk.js"

const ID = "123e4567-e89b-42d3-a456-426614174000"
const HASH = "a".repeat(64)
const STRUCTURE = {
  schemaId: "gb.document-structure.v1",
  pages: [{ number: 1 }],
  blocks: [
    { id: "heading", kind: "section_header", text: "Résumé 😀", latex: null, page: 1, region: null },
    { id: "equation", kind: "formula", text: null, latex: "E=mc^2", page: 1, region: null },
    { id: "table", kind: "table", text: "A | B", latex: null, page: 1, region: null },
  ],
  readingOrder: ["equation", "heading", "table"],
}

test("document structure chunks follow declared reading order with exact pointer identities", () => {
  const manifest = materializeDocumentChunks({
    representationId: ID,
    representationSha256: HASH,
    kind: "document-structure",
    content: STRUCTURE,
  })

  assert.equal(manifest.schemaId, CHUNK_MANIFEST_SCHEMA_ID)
  assert.equal(manifest.canonicalObject, false)
  assert.equal(Object.hasOwn(manifest, "ref"), false)
  assert.equal(manifest.chunkCount, 3)
  assert.deepEqual(manifest.chunks.map(({ ordinal, selector, textContent }) => ({ ordinal, selector, textContent })), [
    { ordinal: 0, selector: { kind: "json-pointer", pointer: "/blocks/1" }, textContent: "E=mc^2" },
    { ordinal: 1, selector: { kind: "json-pointer", pointer: "/blocks/0" }, textContent: "Résumé 😀" },
    { ordinal: 2, selector: { kind: "json-pointer", pointer: "/blocks/2" }, textContent: "A | B" },
  ])
  assert.deepEqual(manifest.chunks.map((chunk) => chunk.chunkSha256), [
    "5a5a0334fbd0078324baea35c4367dd27de300ad8b52a24d1f965d1694e26b76",
    "a3d8bf7d3e61dad5a9f4c2a48b32353639963533f3abd249198ce8b22264bf11",
    "112b3fcaa43480da6d35f5452d6c6c54ce5a45fd9f9c3b1778b9144a2d1d5046",
  ])
  assert.ok(manifest.chunks.every((chunk) => chunk.schemaId === CHUNK_SCHEMA_ID && chunk.id === `sha256:${chunk.chunkSha256}`))
})

test("empty structure blocks are skipped while chunk ordinals remain dense", () => {
  const manifest = materializeDocumentChunks({
    representationId: ID,
    representationSha256: HASH,
    kind: "document-structure",
    content: {
      schemaId: "gb.document-structure.v1",
      blocks: [
        { id: "first", text: "First", latex: null },
        { id: "empty", text: "", latex: null },
        { id: "last", text: "Last", latex: null },
      ],
      readingOrder: ["first", "empty", "last"],
    },
  })

  assert.deepEqual(manifest.chunks.map(({ ordinal, selector, textContent, chunkSha256 }) => ({
    ordinal, selector, textContent, chunkSha256,
  })), [
    {
      ordinal: 0,
      selector: { kind: "json-pointer", pointer: "/blocks/0" },
      textContent: "First",
      chunkSha256: "a3d8bf7d3e61dad5a9f4c2a48b32353639963533f3abd249198ce8b22264bf11",
    },
    {
      ordinal: 1,
      selector: { kind: "json-pointer", pointer: "/blocks/2" },
      textContent: "Last",
      chunkSha256: "112b3fcaa43480da6d35f5452d6c6c54ce5a45fd9f9c3b1778b9144a2d1d5046",
    },
  ])
})

test("Unicode text windows count code points and expose exact overlap selectors", () => {
  const manifest = materializeDocumentChunks({
    representationId: ID,
    representationSha256: "b".repeat(64),
    kind: "markdown",
    content: "A😀BC𝄞DEF",
  }, { windowCodePoints: 4, overlapCodePoints: 1 })

  assert.deepEqual(manifest.chunks.map(({ selector, textContent }) => ({ selector, textContent })), [
    {
      selector: { kind: "text-position", unit: "unicode-code-point", start: 0, end: 4, overlap: 0 },
      textContent: "A😀BC",
    },
    {
      selector: { kind: "text-position", unit: "unicode-code-point", start: 3, end: 7, overlap: 1 },
      textContent: "C𝄞DE",
    },
    {
      selector: { kind: "text-position", unit: "unicode-code-point", start: 6, end: 8, overlap: 1 },
      textContent: "EF",
    },
  ])
  assert.deepEqual(manifest.chunks.map((chunk) => chunk.chunkSha256), [
    "f3d68efe714fe63d218869b000f25ef9312021183a132f8a274a7cf4da6cce43",
    "77518ab7ecd09776e2e861426d03539572aa4884405b4f5d17f7f28dd551dea5",
    "c2552dfb45f37e0878dcfef82e6fdce2fe1253cc31ea9f0279de450e332e94b0",
  ])
})

test("current descriptors are content-free and identities bind digest, selector, and chunker config", () => {
  assert.deepEqual(currentDocumentChunker("document-structure"), {
    id: "galaxy.document-structure-blocks",
    version: "1",
    config: { strategy: "declared-reading-order-json-pointer" },
    configSha256: "82c5aabe05e41ab2627a14003ae41f01ec34b10f5facca787dd711414201bb1b",
  })
  assert.equal(
    currentDocumentChunker("text", { windowCodePoints: 4, overlapCodePoints: 1 }).configSha256,
    "3f9ccbb6993cadc1788f969c8b54ce98739d2a0f03d164ffb074716d71fddfd4",
  )
  const input = { representationId: ID, representationSha256: HASH, kind: "text", content: "abcdef" }
  const baseline = materializeDocumentChunks(input, { windowCodePoints: 4, overlapCodePoints: 1 })
  const anotherRow = materializeDocumentChunks({ ...input, representationId: "223e4567-e89b-42d3-a456-426614174000" }, { windowCodePoints: 4, overlapCodePoints: 1 })
  const newDigest = materializeDocumentChunks({ ...input, representationSha256: "c".repeat(64) }, { windowCodePoints: 4, overlapCodePoints: 1 })
  const newConfig = materializeDocumentChunks(input, { windowCodePoints: 5, overlapCodePoints: 1 })
  assert.deepEqual(anotherRow.chunks.map((chunk) => chunk.id), baseline.chunks.map((chunk) => chunk.id))
  assert.notEqual(newDigest.chunks[0].id, baseline.chunks[0].id)
  assert.notEqual(newConfig.chunks[0].id, baseline.chunks[0].id)
  assert.equal(canonicalChunkJson({ z: 1, a: { y: 2, x: 1 } }), '{"a":{"x":1,"y":2},"z":1}')
})

test("chunk materialization fails closed on ambiguous structure and unsafe bounds", () => {
  const representation = {
    representationId: ID,
    representationSha256: HASH,
    kind: "document-structure",
    content: STRUCTURE,
  }
  for (const readingOrder of (
    [["heading", "equation"], ["heading", "heading", "table"], ["heading", "equation", "missing"]]
  )) {
    assert.throws(
      () => materializeDocumentChunks({ ...representation, content: { ...STRUCTURE, readingOrder } }),
      /readingOrder/,
    )
  }
  assert.throws(() => materializeDocumentChunks({
    ...representation,
    content: { ...STRUCTURE, blocks: [{ ...STRUCTURE.blocks[0], text: "😀".repeat(262_145) }], readingOrder: ["heading"] },
  }), /1048576/)
  assert.throws(() => materializeDocumentChunks({
    representationId: ID, representationSha256: HASH, kind: "text", content: "x".repeat(100_001),
  }, { windowCodePoints: 1, overlapCodePoints: 0 }), /chunk limit/)
  assert.throws(() => materializeDocumentChunks({
    representationId: ID, representationSha256: HASH, kind: "text", content: "\uD800",
  }), /valid Unicode/)
  assert.throws(() => materializeDocumentChunks({
    representationId: ID, representationSha256: HASH, kind: "original", content: "x",
  }), DocumentChunkContractError)
  assert.throws(() => currentDocumentChunker("text", { windowCodePoints: 4, overlapCodePoints: 4 }), /smaller/)
})

test("empty text has a deterministic descriptor and no invented chunk object", () => {
  const manifest = materializeDocumentChunks({
    representationId: ID, representationSha256: HASH, kind: "text", content: "",
  })
  assert.equal(manifest.chunkCount, 0)
  assert.deepEqual(manifest.chunks, [])
  assert.equal(manifest.canonicalObject, false)
})
