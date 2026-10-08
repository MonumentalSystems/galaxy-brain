import assert from "node:assert/strict"
import test from "node:test"

import {
  DocumentStructureProjectionError,
  projectDocumentStructure,
  projectDocumentStructureBatches,
} from "../lib/document-structure-projector.js"

const structure = {
  schemaId: "gb.document-structure.v1",
  pages: [{ number: 1, width: 612, height: 792 }, { number: 2, width: 612, height: 792 }],
  blocks: [
    { id: "definition", kind: "text", order: 20, text: "Definition", latex: null, page: 1, region: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 } },
    { id: "equation", kind: "formula", order: 10, text: null, latex: "E=mc^2", page: 2, region: { left: 10, top: 20, right: 50, bottom: 60 } },
    { id: "caption", kind: "caption", order: 30, text: "Figure 1", latex: null, page: 2, region: null },
  ],
  readingOrder: ["equation", "definition", "caption"],
}

test("projector preserves authored reading order, page, kind, LaTeX, and regions", () => {
  const projected = projectDocumentStructure(structure)
  assert.equal(projected.schemaId, "gb.document-structure-projection.v1")
  assert.deepEqual(projected.blocks.map((block) => block.id), ["equation", "definition", "caption"])
  assert.deepEqual(projected.blocks.map((block) => block.readingOrderIndex), [0, 1, 2])
  assert.equal(projected.blocks[0].kind, "formula")
  assert.equal(projected.blocks[0].page, 2)
  assert.equal(projected.blocks[0].latex, "E=mc^2")
  assert.deepEqual(projected.blocks[0].region, { left: 10, top: 20, right: 50, bottom: 60 })
  assert.notEqual(projected.blocks[0].region, structure.blocks[1].region)
  assert.deepEqual(projected.pages, structure.pages)
})

test("progressive batches are bounded and carry page metadata only once", () => {
  const batches = [...projectDocumentStructureBatches(structure, { batchSize: 2 })]
  assert.equal(batches.length, 2)
  assert.deepEqual(batches[0].blocks.map((block) => block.id), ["equation", "definition"])
  assert.deepEqual(batches[1].blocks.map((block) => block.id), ["caption"])
  assert.equal(batches[0].done, false)
  assert.equal(batches[1].done, true)
  assert.deepEqual(batches[0].pages, structure.pages)
  assert.equal(batches[1].pages, null)
  assert.equal(batches[1].start, 2)
  assert.equal(batches[1].totalBlocks, 3)
})

test("empty structures still emit one terminal batch", () => {
  const batches = [...projectDocumentStructureBatches({
    schemaId: "gb.document-structure.v1",
    pages: [],
    blocks: [],
    readingOrder: [],
  })]
  assert.deepEqual(batches, [{
    schemaId: "gb.document-structure-projection-batch.v1",
    batchIndex: 0,
    start: 0,
    totalBlocks: 0,
    done: true,
    pages: [],
    blocks: [],
  }])
})

test("projector rejects oversized, ambiguous, and malformed structures", () => {
  assert.throws(
    () => projectDocumentStructure(structure, { maxBlocks: 2 }),
    (error) => error instanceof DocumentStructureProjectionError && /exceeds/.test(error.message),
  )
  assert.throws(
    () => projectDocumentStructure({ ...structure, readingOrder: ["missing"] }),
    /reading order/,
  )
  assert.throws(
    () => projectDocumentStructure({ ...structure, readingOrder: ["equation", "equation"] }),
    /reading order/,
  )
  assert.throws(
    () => projectDocumentStructure({ ...structure, readingOrder: ["equation", "definition"] }),
    /every block/,
  )
  assert.throws(
    () => projectDocumentStructure({ ...structure, blocks: [structure.blocks[0], structure.blocks[0]] }),
    /unique/,
  )
  assert.throws(
    () => projectDocumentStructure({ ...structure, blocks: [{ ...structure.blocks[0], region: { x: Number.NaN } }] }),
    /region/,
  )
  assert.throws(
    () => [...projectDocumentStructureBatches(structure, { batchSize: 501 })],
    /batch size/,
  )
  assert.throws(
    () => projectDocumentStructure({ ...structure, pages: Array.from({ length: 10_001 }) }),
    /page projection limit/,
  )
})
