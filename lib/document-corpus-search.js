import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"

export const DOCUMENT_CORPUS_SEARCH_SCHEMA_ID = "gb.document-corpus-search.v1"
export const DOCUMENT_CORPUS_SEARCH_DEFAULT_LIMIT = 8
export const DOCUMENT_CORPUS_SEARCH_MAX_LIMIT = 20
export const DOCUMENT_CORPUS_SEARCH_MAX_QUERY_CHARACTERS = 500
export const DOCUMENT_CORPUS_SEARCH_MAX_QUERY_BYTES = 2_048
export const DOCUMENT_CORPUS_SEARCH_MAX_RESPONSE_BYTES = 65_536
export const DOCUMENT_CORPUS_SEARCH_MAX_SNIPPET_CHARACTERS = 320

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/u
const CONTENT_ID = /^sha256:[0-9a-f]{64}$/u
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u
const INVALID_UNICODE = /[\uD800-\uDFFF]/u
const REPRESENTATION_KINDS = new Set(["document-structure", "markdown", "text"])

function invalid(message) {
  throw new TypeError(`Invalid ${DOCUMENT_CORPUS_SEARCH_SCHEMA_ID}: ${message}`)
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`)
  return value
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    invalid(`${label} fields are invalid`)
  }
}

function boundedText(value, label, maximumBytes, maximumCharacters = maximumBytes) {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !value
    || CONTROL.test(value)
    || INVALID_UNICODE.test(value)
    || Array.from(value).length > maximumCharacters
    || new TextEncoder().encode(value).byteLength > maximumBytes
  ) invalid(`${label} must be bounded text`)
  return value
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) invalid(`${label} must be a UUID`)
  return value.toLowerCase()
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) invalid(`${label} must be a lowercase SHA-256 digest`)
  return value
}

function selector(value, label) {
  const source = record(value, label)
  if (source.kind === "json-pointer") {
    exactKeys(source, ["kind", "pointer"], label)
    if (typeof source.pointer !== "string" || !/^\/blocks\/(?:0|[1-9][0-9]{0,5})$/u.test(source.pointer)) {
      invalid(`${label}.pointer is invalid`)
    }
    return Object.freeze({ kind: "json-pointer", pointer: source.pointer })
  }
  exactKeys(source, ["kind", "unit", "start", "end", "overlap"], label)
  if (source.kind !== "text-position" || source.unit !== "unicode-code-point") {
    invalid(`${label} kind is unsupported`)
  }
  for (const key of ["start", "end", "overlap"]) {
    if (!Number.isSafeInteger(source[key]) || source[key] < 0 || source[key] > 100_000_000) {
      invalid(`${label}.${key} is invalid`)
    }
  }
  if (source.end <= source.start || source.overlap >= source.end - source.start) {
    invalid(`${label} range is invalid`)
  }
  return Object.freeze({
    kind: "text-position",
    unit: "unicode-code-point",
    start: source.start,
    end: source.end,
    overlap: source.overlap,
  })
}

export function createDocumentCorpusSearchRequest(value) {
  const source = record(value, "request")
  exactKeys(source, Object.hasOwn(source, "limit") ? ["query", "limit"] : ["query"], "request")
  const query = typeof source.query === "string" ? source.query.trim() : source.query
  boundedText(
    query,
    "request.query",
    DOCUMENT_CORPUS_SEARCH_MAX_QUERY_BYTES,
    DOCUMENT_CORPUS_SEARCH_MAX_QUERY_CHARACTERS,
  )
  const limit = source.limit ?? DOCUMENT_CORPUS_SEARCH_DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DOCUMENT_CORPUS_SEARCH_MAX_LIMIT) {
    invalid(`request.limit must be between 1 and ${DOCUMENT_CORPUS_SEARCH_MAX_LIMIT}`)
  }
  return Object.freeze({ query, limit })
}

function pinnedDocumentReference(value, documentId, revisionSha256, label) {
  const parsed = parseGalaxyObjectReference(value)
  if (
    !parsed
    || parsed.format !== "canonical"
    || parsed.kind !== "document"
    || parsed.id !== documentId
    || parsed.selector.mode !== "pinned"
    || parsed.selector.revision !== `sha256:${revisionSha256}`
    || serializeGalaxyObjectReference(parsed) !== value
  ) invalid(`${label} must be the exact pinned document reference`)
  return value
}

function parseSource(value, index) {
  const label = `items[${index}].source`
  const source = record(value, label)
  exactKeys(source, [
    "manifestId", "representationId", "representationSha256", "representationKind",
    "chunkContentSha256", "selector",
  ], label)
  if (typeof source.manifestId !== "string" || !CONTENT_ID.test(source.manifestId)) {
    invalid(`${label}.manifestId is invalid`)
  }
  const representationId = uuid(source.representationId, `${label}.representationId`)
  const representationSha256 = sha256(source.representationSha256, `${label}.representationSha256`)
  if (!REPRESENTATION_KINDS.has(source.representationKind)) {
    invalid(`${label}.representationKind is unsupported`)
  }
  const chunkContentSha256 = sha256(source.chunkContentSha256, `${label}.chunkContentSha256`)
  return Object.freeze({
    manifestId: source.manifestId,
    representationId,
    representationSha256,
    representationKind: source.representationKind,
    chunkContentSha256,
    selector: selector(source.selector, `${label}.selector`),
  })
}

function parseItem(value, index) {
  const label = `items[${index}]`
  const item = record(value, label)
  exactKeys(item, [
    "documentRef", "documentId", "documentRevisionId", "revisionSha256", "title",
    "displayFilename", "snippet", "matchSource", "source",
  ], label)
  const documentId = uuid(item.documentId, `${label}.documentId`)
  const documentRevisionId = uuid(item.documentRevisionId, `${label}.documentRevisionId`)
  const revisionSha256 = sha256(item.revisionSha256, `${label}.revisionSha256`)
  if (item.matchSource !== "content") invalid(`${label}.matchSource is unsupported`)
  return Object.freeze({
    documentRef: pinnedDocumentReference(item.documentRef, documentId, revisionSha256, `${label}.documentRef`),
    documentId,
    documentRevisionId,
    revisionSha256,
    title: boundedText(item.title, `${label}.title`, 4_096, 1_000),
    displayFilename: boundedText(item.displayFilename, `${label}.displayFilename`, 2_048, 512),
    snippet: boundedText(
      item.snippet,
      `${label}.snippet`,
      2_048,
      DOCUMENT_CORPUS_SEARCH_MAX_SNIPPET_CHARACTERS,
    ),
    matchSource: item.matchSource,
    source: parseSource(item.source, index),
  })
}

export function parseDocumentCorpusSearchResponse(value, requestValue) {
  const request = createDocumentCorpusSearchRequest(requestValue)
  const response = record(value, "response")
  exactKeys(response, ["schemaId", "query", "items", "continuation"], "response")
  if (response.schemaId !== DOCUMENT_CORPUS_SEARCH_SCHEMA_ID) invalid("response.schemaId is unsupported")
  if (response.query !== request.query) invalid("response.query does not match the request")
  if (!Array.isArray(response.items) || response.items.length > request.limit) {
    invalid("response.items exceeds the requested limit")
  }
  const items = Object.freeze(response.items.map(parseItem))
  if (new Set(items.map((item) => item.documentRef)).size !== items.length) {
    invalid("response.items contains duplicate document references")
  }
  const continuation = record(response.continuation, "response.continuation")
  exactKeys(continuation, ["hasMore"], "response.continuation")
  if (typeof continuation.hasMore !== "boolean") invalid("response.continuation.hasMore is invalid")
  const normalized = Object.freeze({
    schemaId: DOCUMENT_CORPUS_SEARCH_SCHEMA_ID,
    query: request.query,
    items,
    continuation: Object.freeze({ hasMore: continuation.hasMore }),
  })
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > DOCUMENT_CORPUS_SEARCH_MAX_RESPONSE_BYTES) {
    throw new RangeError(`${DOCUMENT_CORPUS_SEARCH_SCHEMA_ID} response exceeds its byte bound`)
  }
  return normalized
}

export async function readDocumentCorpusSearchResponse(response, requestValue) {
  if (!response || typeof response !== "object" || !response.headers || !response.body) {
    invalid("HTTP response is unavailable")
  }
  if (!(response.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    invalid("HTTP response media type is unsupported")
  }
  const declaredLength = Number(response.headers.get("Content-Length") || 0)
  if (Number.isFinite(declaredLength) && declaredLength > DOCUMENT_CORPUS_SEARCH_MAX_RESPONSE_BYTES) {
    throw new RangeError(`${DOCUMENT_CORPUS_SEARCH_SCHEMA_ID} response exceeds its byte bound`)
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > DOCUMENT_CORPUS_SEARCH_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new RangeError(`${DOCUMENT_CORPUS_SEARCH_SCHEMA_ID} response exceeds its byte bound`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let payload
  try {
    const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    payload = JSON.parse(json)
  } catch {
    invalid("HTTP response must be UTF-8 JSON")
  }
  return parseDocumentCorpusSearchResponse(payload, requestValue)
}
