export const DOCUMENT_STRUCTURE_PROJECTION_SCHEMA = "gb.document-structure-projection.v1"
export const DOCUMENT_STRUCTURE_BATCH_SCHEMA = "gb.document-structure-projection-batch.v1"

const DEFAULT_MAX_BLOCKS = 20_000
const MAX_PAGES = 10_000
const DEFAULT_BATCH_SIZE = 100
const MAX_BATCH_SIZE = 500
const MAX_STRING_CHARS = 2_000_000

export class DocumentStructureProjectionError extends Error {
  constructor(message) {
    super(message)
    this.name = "DocumentStructureProjectionError"
  }
}

function invalid(message) {
  throw new DocumentStructureProjectionError(message)
}

function optionalText(value, label) {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || value.length > MAX_STRING_CHARS) invalid(`${label} is invalid`)
  return value
}

function copyRegion(value) {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Document block region is invalid")
  const copy = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof key !== "string" || key.length === 0 || key.length > 128) invalid("Document block region is invalid")
    if (typeof item === "number") {
      if (!Number.isFinite(item)) invalid("Document block region is invalid")
      copy[key] = item
    } else if (typeof item === "string" || typeof item === "boolean" || item === null) {
      copy[key] = item
    } else {
      invalid("Document block region is invalid")
    }
  }
  return copy
}

function validateOptions(options) {
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 100_000) invalid("Document structure block limit is invalid")
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) invalid("Document structure batch size is invalid")
  return { maxBlocks, batchSize }
}

export function projectDocumentStructure(structure, options = {}) {
  const { maxBlocks } = validateOptions(options)
  if (!structure || typeof structure !== "object" || Array.isArray(structure)) invalid("Document structure is required")
  if (structure.schemaId !== "gb.document-structure.v1") invalid("Document structure schema is unsupported")
  if (!Array.isArray(structure.pages) || !Array.isArray(structure.blocks) || !Array.isArray(structure.readingOrder)) {
    invalid("Document structure pages, blocks, and reading order are required")
  }
  if (structure.pages.length > MAX_PAGES) invalid(`Document structure exceeds the ${MAX_PAGES} page projection limit`)
  if (structure.blocks.length > maxBlocks) invalid(`Document structure exceeds the ${maxBlocks} block projection limit`)

  const byId = new Map()
  const normalized = structure.blocks.map((block, sourceIndex) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) invalid("Document block is invalid")
    if (typeof block.id !== "string" || !block.id || block.id.length > 512 || byId.has(block.id)) invalid("Document block ids must be unique and bounded")
    if (typeof block.kind !== "string" || !block.kind || block.kind.length > 128) invalid("Document block kind is invalid")
    if (!Number.isSafeInteger(block.order) || block.order < 0) invalid("Document block order is invalid")
    if (block.page !== null && block.page !== undefined && (!Number.isSafeInteger(block.page) || block.page < 1)) {
      invalid("Document block page is invalid")
    }
    const value = {
      id: block.id,
      kind: block.kind,
      order: block.order,
      text: optionalText(block.text, "Document block text"),
      latex: optionalText(block.latex, "Document block LaTeX"),
      page: block.page ?? null,
      region: copyRegion(block.region),
      sourceIndex,
    }
    byId.set(value.id, value)
    return value
  })

  const ordered = []
  const seen = new Set()
  for (const id of structure.readingOrder) {
    if (typeof id !== "string" || !byId.has(id) || seen.has(id)) invalid("Document reading order must reference each block at most once")
    seen.add(id)
    ordered.push(byId.get(id))
  }
  if (seen.size !== normalized.length) invalid("Document reading order must reference every block exactly once")

  return {
    schemaId: DOCUMENT_STRUCTURE_PROJECTION_SCHEMA,
    pages: structure.pages.slice(),
    totalBlocks: ordered.length,
    blocks: ordered.map((block, readingOrderIndex) => ({
      id: block.id,
      kind: block.kind,
      order: block.order,
      readingOrderIndex,
      text: block.text,
      latex: block.latex,
      page: block.page,
      region: block.region,
    })),
  }
}

export function* projectDocumentStructureBatches(structure, options = {}) {
  const { batchSize } = validateOptions(options)
  const projection = projectDocumentStructure(structure, options)
  if (projection.totalBlocks === 0) {
    yield {
      schemaId: DOCUMENT_STRUCTURE_BATCH_SCHEMA,
      batchIndex: 0,
      start: 0,
      totalBlocks: 0,
      done: true,
      pages: projection.pages,
      blocks: [],
    }
    return
  }
  for (let start = 0, batchIndex = 0; start < projection.totalBlocks; start += batchSize, batchIndex += 1) {
    const blocks = projection.blocks.slice(start, start + batchSize)
    yield {
      schemaId: DOCUMENT_STRUCTURE_BATCH_SCHEMA,
      batchIndex,
      start,
      totalBlocks: projection.totalBlocks,
      done: start + blocks.length >= projection.totalBlocks,
      pages: batchIndex === 0 ? projection.pages : null,
      blocks,
    }
  }
}
