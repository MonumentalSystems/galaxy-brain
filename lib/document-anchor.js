import { createHash } from "node:crypto"
import { isDocumentAnchorTextMediaType } from "./document-anchor-media.js"

export { isDocumentAnchorTextMediaType } from "./document-anchor-media.js"

export const DOCUMENT_ANCHOR_SCHEMA_ID = "gb.anchor.v1"
export const MAX_ANCHOR_SELECTOR_BYTES = 32_768
export const MAX_TEXT_QUOTE_CHARS = 16_000
export const MAX_TEXT_CONTEXT_CHARS = 2_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/u
const SELECTOR_KEYS = {
  "page-region": new Set(["kind", "page", "coordinateSpace", "polygon", "quoteHash"]),
  "text-quote": new Set(["kind", "exact", "prefix", "suffix", "page"]),
  "json-pointer": new Set(["kind", "pointer"]),
}

export class DocumentAnchorContractError extends Error {}

function invalid(message) {
  throw new DocumentAnchorContractError(message)
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}

function exactKeys(value, permitted, label) {
  const unknown = Object.keys(value).filter((key) => !permitted.has(key))
  if (unknown.length) invalid(`${label} has unknown fields: ${unknown.sort().join(", ")}`)
}

function aliasedField(value, snakeCase, camelCase, fallback) {
  const hasSnakeCase = Object.hasOwn(value, snakeCase)
  const hasCamelCase = Object.hasOwn(value, camelCase)
  if (hasSnakeCase && hasCamelCase) {
    invalid(`Representation cannot contain both ${snakeCase} and ${camelCase}`)
  }
  if (hasSnakeCase) return value[snakeCase]
  if (hasCamelCase) return value[camelCase]
  return fallback
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("Canonical JSON cannot contain a non-finite number")
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
  }
  invalid("Canonical JSON contains an unsupported value")
}

function serializeCanonicalValue(value) {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return String(value)
    if (value < 0 || value > 1) invalid("Canonical decimal numbers must be normalized")
    return value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "")
  }
  if (Array.isArray(value)) return `[${value.map(serializeCanonicalValue).join(",")}]`
  return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}:${serializeCanonicalValue(item)}`).join(",")}}`
}

export function canonicalAnchorJson(value) {
  return serializeCanonicalValue(canonicalValue(value))
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function normalizedRepresentation(value) {
  const input = plainObject(value, "Representation")
  const id = input.id
  const kind = input.kind
  const mediaType = aliasedField(input, "media_type", "mediaType", "")
  const contentSha256 = aliasedField(input, "content_sha256", "contentSha256", undefined)
  if (typeof id !== "string" || !UUID.test(id)) invalid("Representation id must be a UUID")
  if (!new Set(["original", "document-structure", "markdown", "text"]).has(kind)) {
    invalid("Representation kind cannot be anchored")
  }
  if (typeof mediaType !== "string" || mediaType.length > 200) invalid("Representation media type is invalid")
  if (typeof contentSha256 !== "string" || !SHA256.test(contentSha256)) {
    invalid("Representation content SHA-256 is invalid")
  }
  return {
    id: id.toLowerCase(), kind, mediaType: mediaType.toLowerCase().split(";", 1)[0].trim(),
    contentSha256, content: input.content,
    pageCount: aliasedField(input, "page_count", "pageCount", null),
  }
}

function boundedString(value, label, maximum, required = false) {
  if (value === undefined && !required) return undefined
  if (typeof value !== "string" || (required && value.length === 0)
    || [...value].length > maximum || /[\uD800-\uDFFF]/u.test(value)) {
    invalid(`${label} is invalid or exceeds ${maximum} characters`)
  }
  return value
}

function pageNumber(value, representation, label = "Selector page") {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a 1-based page number`)
  let pageCount = representation.pageCount
  if (representation.kind === "document-structure") {
    const structure = plainObject(representation.content, "Document structure")
    if (structure.schemaId !== "gb.document-structure.v1" || !Array.isArray(structure.pages)) {
      invalid("Document structure content is invalid")
    }
    pageCount = structure.pages.length
  }
  if (pageCount === null) {
    invalid(`${label} requires representation page metadata`)
  }
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || value > pageCount) {
    invalid(`${label} is outside the representation page range`)
  }
  return value
}

function normalizePageRegion(selector, representation) {
  if (representation.kind !== "document-structure") {
    invalid("Page-region selectors require a page-aware document structure representation")
  }
  if (selector.coordinateSpace !== "normalized-page") {
    invalid("Page-region coordinateSpace must be normalized-page")
  }
  if (!Array.isArray(selector.polygon) || selector.polygon.length < 8 || selector.polygon.length > 128
    || selector.polygon.length % 2 !== 0) {
    invalid("Page-region polygon must contain 4 to 64 coordinate pairs")
  }
  const polygon = selector.polygon.map((coordinate) => {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1) {
      invalid("Page-region polygon coordinates must be finite normalized numbers")
    }
    if (Object.is(coordinate, -0)) return 0
    return Math.floor((coordinate * 1_000_000) + 0.5) / 1_000_000
  })
  let twiceArea = 0
  for (let index = 0; index < polygon.length; index += 2) {
    const next = (index + 2) % polygon.length
    twiceArea += polygon[index] * polygon[next + 1] - polygon[next] * polygon[index + 1]
  }
  if (Math.abs(twiceArea) <= Number.EPSILON) invalid("Page-region polygon must enclose a non-zero area")
  const normalized = {
    kind: "page-region",
    page: pageNumber(selector.page, representation),
    coordinateSpace: "normalized-page",
    polygon,
  }
  if (selector.quoteHash !== undefined) {
    if (typeof selector.quoteHash !== "string" || !SHA256.test(selector.quoteHash)) {
      invalid("Page-region quoteHash must be a lowercase SHA-256 digest")
    }
    normalized.quoteHash = selector.quoteHash
  }
  return normalized
}

function normalizeTextQuote(selector, representation) {
  const isDerivedText = new Set(["markdown", "text"]).has(representation.kind)
  const isTextualOriginal = representation.kind === "original"
    && isDocumentAnchorTextMediaType(representation.mediaType)
  if ((!isDerivedText && !isTextualOriginal) || typeof representation.content !== "string") {
    invalid("Text-quote selectors require a flat text representation or textual original")
  }
  const exact = boundedString(selector.exact, "Text-quote exact", MAX_TEXT_QUOTE_CHARS, true)
  const prefix = boundedString(selector.prefix, "Text-quote prefix", MAX_TEXT_CONTEXT_CHARS)
  const suffix = boundedString(selector.suffix, "Text-quote suffix", MAX_TEXT_CONTEXT_CHARS)
  const needle = `${prefix ?? ""}${exact}${suffix ?? ""}`
  const firstMatch = representation.content.indexOf(needle)
  if (firstMatch === -1) invalid("Text-quote selector does not identify content in the representation")
  if (representation.content.indexOf(needle, firstMatch + 1) !== -1) {
    invalid("Text-quote selector is ambiguous in the representation")
  }
  const normalized = { kind: "text-quote", exact }
  if (prefix !== undefined) normalized.prefix = prefix
  if (suffix !== undefined) normalized.suffix = suffix
  if (selector.page !== undefined) {
    if (representation.pageCount === null) invalid("Text-quote page requires representation page metadata")
    normalized.page = pageNumber(selector.page, representation)
  }
  return normalized
}

function normalizeJsonPointer(selector, representation) {
  if (representation.kind !== "document-structure") {
    invalid("JSON-pointer selectors require a document structure representation")
  }
  const structure = plainObject(representation.content, "Document structure")
  if (structure.schemaId !== "gb.document-structure.v1" || !Array.isArray(structure.blocks)) {
    invalid("Document structure content is invalid")
  }
  const pointer = boundedString(selector.pointer, "JSON pointer", 128, true)
  const match = /^\/blocks\/(0|[1-9]\d*)$/u.exec(pointer)
  if (!match || Number(match[1]) >= structure.blocks.length) {
    invalid("JSON pointer must identify an existing /blocks/<index> item")
  }
  return { kind: "json-pointer", pointer }
}

export function validateDocumentAnchorSelector(selectorValue, representationValue) {
  const selector = plainObject(selectorValue, "Anchor selector")
  const representation = normalizedRepresentation(representationValue)
  const permitted = SELECTOR_KEYS[selector.kind]
  if (!permitted) invalid("Anchor selector kind is unsupported")
  exactKeys(selector, permitted, "Anchor selector")
  let normalized
  if (selector.kind === "page-region") normalized = normalizePageRegion(selector, representation)
  else if (selector.kind === "text-quote") normalized = normalizeTextQuote(selector, representation)
  else normalized = normalizeJsonPointer(selector, representation)
  if (new TextEncoder().encode(canonicalAnchorJson(normalized)).byteLength > MAX_ANCHOR_SELECTOR_BYTES) {
    invalid("Anchor selector exceeds 32768 UTF-8 bytes")
  }
  return normalized
}

function anchorIdentity(representation, selector) {
  return {
    representationId: representation.id,
    representationSha256: representation.contentSha256,
    selector,
  }
}

export function createDocumentAnchor(representationValue, selectorValue) {
  const representation = normalizedRepresentation(representationValue)
  const selector = validateDocumentAnchorSelector(selectorValue, representationValue)
  const selectorSha256 = sha256(canonicalAnchorJson(selector))
  const anchorSha256 = sha256(canonicalAnchorJson(anchorIdentity(representation, selector)))
  return {
    schemaId: DOCUMENT_ANCHOR_SCHEMA_ID,
    id: `sha256:${anchorSha256}`,
    representationId: representation.id,
    representationSha256: representation.contentSha256,
    selector,
    selectorSha256,
    anchorSha256,
  }
}

export function documentAnchorRequestHash(representationValue, selectorValue) {
  const representation = normalizedRepresentation(representationValue)
  const selector = validateDocumentAnchorSelector(selectorValue, representationValue)
  return sha256(canonicalAnchorJson({
    schemaId: "gb.anchor.create.v1",
    ...anchorIdentity(representation, selector),
  }))
}
