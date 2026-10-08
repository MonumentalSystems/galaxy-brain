import { createHash } from "node:crypto"

export const CHUNK_SCHEMA_ID = "gb.document-chunk.v1"
export const CHUNK_MANIFEST_SCHEMA_ID = "gb.document-chunk-manifest.v1"
export const CHUNKER_STRUCTURE_ID = "galaxy.document-structure-blocks"
export const CHUNKER_STRUCTURE_VERSION = "1"
export const CHUNKER_TEXT_ID = "galaxy.unicode-code-point-windows"
export const CHUNKER_TEXT_VERSION = "1"
export const DEFAULT_WINDOW_CODE_POINTS = 1_200
export const DEFAULT_OVERLAP_CODE_POINTS = 200
export const MAX_WINDOW_CODE_POINTS = 250_000
export const MAX_DOCUMENT_CHUNKS = 100_000
export const MAX_CHUNK_TEXT_BYTES = 1_048_576
export const MAX_TEXT_REPRESENTATION_BYTES = 16_777_216

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/u
const CANONICAL_KEY = /^[A-Za-z][A-Za-z0-9]*$/u
const INVALID_UNICODE = /[\uD800-\uDFFF]/u

export class DocumentChunkContractError extends Error {}

function invalid(message) {
  throw new DocumentChunkContractError(message)
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}

function canonicalValue(value) {
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "string") {
    if (INVALID_UNICODE.test(value)) invalid("Canonical JSON contains invalid Unicode")
    return value
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) invalid("Canonical JSON numbers must be safe integers")
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === "object") {
    const entries = Object.keys(value).sort().map((key) => {
      if (!CANONICAL_KEY.test(key)) invalid("Canonical JSON object keys must be ASCII contract names")
      return [key, canonicalValue(value[key])]
    })
    return Object.fromEntries(entries)
  }
  invalid("Canonical JSON contains an unsupported value")
}

export function canonicalChunkJson(value) {
  return JSON.stringify(canonicalValue(value))
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function utf8Bytes(value) {
  if (typeof value !== "string" || INVALID_UNICODE.test(value)) invalid("Chunk text must be valid Unicode")
  return new TextEncoder().encode(value).byteLength
}

function normalizedRepresentation(value) {
  const representation = plainObject(value, "Representation")
  const representationId = representation.representationId
  const representationSha256 = representation.representationSha256
  const kind = representation.kind
  if (typeof representationId !== "string" || !UUID.test(representationId)) {
    invalid("Representation id must be a UUID")
  }
  if (typeof representationSha256 !== "string" || !SHA256.test(representationSha256)) {
    invalid("Representation SHA-256 must be a lowercase digest")
  }
  if (!new Set(["document-structure", "markdown", "text"]).has(kind)) {
    invalid("Representation kind cannot be chunked")
  }
  return {
    representationId: representationId.toLowerCase(),
    representationSha256,
    kind,
    content: representation.content,
  }
}

function normalizedWindowOptions(value = {}) {
  const options = plainObject(value, "Chunk options")
  const unknown = Object.keys(options).filter((key) => !new Set(["windowCodePoints", "overlapCodePoints"]).has(key))
  if (unknown.length) invalid(`Chunk options have unknown fields: ${unknown.sort().join(", ")}`)
  const windowCodePoints = options.windowCodePoints ?? DEFAULT_WINDOW_CODE_POINTS
  const overlapCodePoints = options.overlapCodePoints ?? DEFAULT_OVERLAP_CODE_POINTS
  if (!Number.isSafeInteger(windowCodePoints) || windowCodePoints < 1 || windowCodePoints > MAX_WINDOW_CODE_POINTS) {
    invalid(`windowCodePoints must be between 1 and ${MAX_WINDOW_CODE_POINTS}`)
  }
  if (!Number.isSafeInteger(overlapCodePoints) || overlapCodePoints < 0 || overlapCodePoints >= windowCodePoints) {
    invalid("overlapCodePoints must be non-negative and smaller than windowCodePoints")
  }
  return { windowCodePoints, overlapCodePoints }
}

function chunker(id, version, config) {
  return { id, version, config, configSha256: sha256(canonicalChunkJson(config)) }
}

export function currentDocumentChunker(kind, options = {}) {
  if (kind === "document-structure") {
    return chunker(
      CHUNKER_STRUCTURE_ID,
      CHUNKER_STRUCTURE_VERSION,
      { strategy: "declared-reading-order-json-pointer" },
    )
  }
  if (!new Set(["markdown", "text"]).has(kind)) invalid("Representation kind cannot be chunked")
  const normalized = normalizedWindowOptions(options)
  return chunker(CHUNKER_TEXT_ID, CHUNKER_TEXT_VERSION, {
    strategy: "unicode-code-point-window",
    windowCodePoints: normalized.windowCodePoints,
    overlapCodePoints: normalized.overlapCodePoints,
  })
}

function chunkIdentity(representationSha256, selector, sourceChunker) {
  return {
    schemaId: CHUNK_SCHEMA_ID,
    representationSha256,
    selector,
    chunker: {
      id: sourceChunker.id,
      version: sourceChunker.version,
      configSha256: sourceChunker.configSha256,
    },
  }
}

function createChunk(representation, ordinal, selector, textContent, sourceChunker) {
  const byteSize = utf8Bytes(textContent)
  if (byteSize < 1 || byteSize > MAX_CHUNK_TEXT_BYTES) {
    invalid(`Chunk text must contain between 1 and ${MAX_CHUNK_TEXT_BYTES} UTF-8 bytes`)
  }
  const selectorSha256 = sha256(canonicalChunkJson(selector))
  const chunkSha256 = sha256(canonicalChunkJson(
    chunkIdentity(representation.representationSha256, selector, sourceChunker),
  ))
  return {
    schemaId: CHUNK_SCHEMA_ID,
    id: `sha256:${chunkSha256}`,
    chunkSha256,
    representationId: representation.representationId,
    representationSha256: representation.representationSha256,
    ordinal,
    selector,
    selectorSha256,
    textContent,
    contentSha256: sha256(textContent),
    chunkerId: sourceChunker.id,
    chunkerVersion: sourceChunker.version,
    chunkerConfigSha256: sourceChunker.configSha256,
  }
}

function structureChunks(representation) {
  const structure = plainObject(representation.content, "Document structure")
  if (structure.schemaId !== "gb.document-structure.v1") invalid("Document structure schema is unsupported")
  if (!Array.isArray(structure.blocks) || structure.blocks.length > MAX_DOCUMENT_CHUNKS) {
    invalid("Document structure blocks are invalid or exceed the chunk limit")
  }
  if (!Array.isArray(structure.readingOrder) || structure.readingOrder.length !== structure.blocks.length) {
    invalid("Document structure readingOrder must include every block exactly once")
  }
  const blockIndex = new Map()
  for (let index = 0; index < structure.blocks.length; index += 1) {
    const block = plainObject(structure.blocks[index], `Document block ${index}`)
    if (typeof block.id !== "string" || block.id.length < 1 || [...block.id].length > 128 || INVALID_UNICODE.test(block.id)) {
      invalid("Document block id is invalid")
    }
    if (blockIndex.has(block.id)) invalid("Document block ids must be unique")
    blockIndex.set(block.id, index)
  }
  const seen = new Set()
  const sourceChunker = currentDocumentChunker("document-structure")
  const chunks = []
  for (const blockId of structure.readingOrder) {
    if (typeof blockId !== "string" || !blockIndex.has(blockId) || seen.has(blockId)) {
      invalid("Document structure readingOrder must include every block exactly once")
    }
    seen.add(blockId)
    const index = blockIndex.get(blockId)
    const block = structure.blocks[index]
    const text = block.text
    const latex = block.latex
    if (text !== null && text !== undefined && typeof text !== "string") invalid("Document block text must be a string or null")
    if (latex !== null && latex !== undefined && typeof latex !== "string") invalid("Document block LaTeX must be a string or null")
    const parts = []
    if (text) parts.push(text)
    if (latex && latex !== text) parts.push(latex)
    if (!parts.length) continue
    chunks.push(createChunk(
      representation,
      chunks.length,
      { kind: "json-pointer", pointer: `/blocks/${index}` },
      parts.join("\n\n"),
      sourceChunker,
    ))
  }
  return { sourceChunker, chunks }
}

function textChunks(representation, options) {
  if (typeof representation.content !== "string") invalid("Text representation content must be a string")
  const byteSize = utf8Bytes(representation.content)
  if (byteSize > MAX_TEXT_REPRESENTATION_BYTES) {
    invalid(`Text representation exceeds ${MAX_TEXT_REPRESENTATION_BYTES} UTF-8 bytes`)
  }
  const normalized = normalizedWindowOptions(options)
  const sourceChunker = currentDocumentChunker(representation.kind, options)
  const codePoints = [...representation.content]
  if (!codePoints.length) return { sourceChunker, chunks: [] }
  const step = normalized.windowCodePoints - normalized.overlapCodePoints
  const chunkCount = Math.ceil(Math.max(0, codePoints.length - normalized.windowCodePoints) / step) + 1
  if (chunkCount > MAX_DOCUMENT_CHUNKS) invalid("Text representation would exceed the chunk limit")
  const chunks = []
  for (let start = 0, ordinal = 0; start < codePoints.length; start += step, ordinal += 1) {
    const end = Math.min(start + normalized.windowCodePoints, codePoints.length)
    chunks.push(createChunk(
      representation,
      ordinal,
      {
        kind: "text-position",
        unit: "unicode-code-point",
        start,
        end,
        overlap: ordinal === 0 ? 0 : normalized.overlapCodePoints,
      },
      codePoints.slice(start, end).join(""),
      sourceChunker,
    ))
    if (end === codePoints.length) break
  }
  return { sourceChunker, chunks }
}

export function materializeDocumentChunks(representationValue, options = {}) {
  const representation = normalizedRepresentation(representationValue)
  const { sourceChunker, chunks } = representation.kind === "document-structure"
    ? structureChunks(representation)
    : textChunks(representation, options)
  return {
    schemaId: CHUNK_MANIFEST_SCHEMA_ID,
    canonicalObject: false,
    representationId: representation.representationId,
    representationSha256: representation.representationSha256,
    representationKind: representation.kind,
    chunker: sourceChunker,
    chunkCount: chunks.length,
    chunks,
  }
}
