import { readBoundedResponseText } from "./bounded-response.js"
import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "./galaxy-object-reference.js"

export const DOCUMENT_MARK_MAX_BODY_BYTES = 65_536
export const DOCUMENT_MARK_MAX_RESPONSE_BYTES = 131_072
export const DOCUMENT_MARK_MAX_TEXT_QUOTE_CHARACTERS = 16_000
export const DOCUMENT_MARK_LIST_LIMIT = 1_000
export const DOCUMENT_MARK_LIST_MAX_RESPONSE_BYTES = 128 * 1024 * 1024

const RECOVERY_SCHEMA = "gb.document-mark-recovery.v1"
const RECOVERY_PREFIX = "galaxy-brain:document-mark-recovery:v1"
const INTENT_SCHEMA = "gb.document-mark-create.intent.v1"
const MARK_SCHEMA = "gb.document-mark.v1"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const SHA_ID = /^sha256:[0-9a-f]{64}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const COLOR = /^#[0-9a-f]{6}$/u
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u
const AUTHORITY_CONTROL = /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u
const PREPARE_KEYS = new Set([
  "anchor", "requestedAt", "kind", "bodyMarkdown", "color", "semanticRole", "tags", "state",
])
const INTENT_KEYS = new Set([
  "schemaId", "anchor", "requestedAt", "kind", "bodyMarkdown", "color", "semanticRole", "tags",
  "state", "idempotencyKey", "requestBody",
])
const ANCHOR_KEYS = new Set([
  "schemaId", "id", "ref", "document_revision_id", "representation_id", "representation_sha256",
  "selector", "selector_kind", "selector_sha256", "anchor_sha256",
])
const RECOVERY_KEYS = new Set(["schemaId", "tenantId", "principalId", "documentRevisionId", "intent"])
const MARK_KEYS = new Set([
  "schemaId", "id", "ref", "document_revision_id", "anchor_id", "anchor_ref", "kind", "version",
  "revision_id", "content_hash", "body_markdown", "color", "semantic_role", "tags", "state",
  "created_by_principal_id", "created_at", "updated_at", "replayed",
])
const MARK_SNAPSHOT_KEYS = new Set([...MARK_KEYS].filter((key) => key !== "replayed"))
const MARK_LIST_KEYS = new Set(["schemaId", "document_revision_id", "anchor_id", "marks"])

function fail(code, message, options) {
  throw new DocumentMarkClientError(code, message, options)
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value, amount) {
  return (value >>> amount) | (value << (32 - amount))
}

/** Browser-safe synchronous SHA-256 over exact UTF-8 bytes. */
function sha256Text(value) {
  const source = new TextEncoder().encode(value)
  const paddedLength = Math.ceil((source.byteLength + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(source)
  padded[source.byteLength] = 0x80
  const view = new DataView(padded.buffer)
  const bitLength = source.byteLength * 8
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const words = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + (index * 4), false)
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]
      const right = words[index - 2]
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3)
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10)
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = state
    for (let index = 0; index < 64; index += 1) {
      const choice = (e & f) ^ (~e & g)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const first = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0
      const second = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + first) >>> 0
      d = c
      c = b
      b = a
      a = (first + second) >>> 0
    }
    state[0] = (state[0] + a) >>> 0
    state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0
    state[3] = (state[3] + d) >>> 0
    state[4] = (state[4] + e) >>> 0
    state[5] = (state[5] + f) >>> 0
    state[6] = (state[6] + g) >>> 0
    state[7] = (state[7] + h) >>> 0
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("")
}

function canonicalJson(value) {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_request", "Canonical JSON contains a non-finite number.")
    if (Number.isSafeInteger(value)) return String(value)
    if (value < 0 || value > 1) fail("invalid_request", "Canonical JSON decimal is outside its normalized range.")
    return value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "")
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  }
  fail("invalid_request", "Canonical JSON contains an unsupported value.")
}

function record(value, label, code = "invalid_request") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} is invalid.`, code === "invalid_response" ? { ambiguous: true } : undefined)
  }
  return value
}

function exactKeys(value, expected, label, code = "invalid_request") {
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    fail(code, `${label} is invalid.`, code === "invalid_response" ? { ambiguous: true } : undefined)
  }
}

function uuid(value, label, code = "invalid_request") {
  if (typeof value !== "string" || !UUID.test(value)) {
    fail(code, `${label} is invalid.`, code === "invalid_response" ? { ambiguous: true } : undefined)
  }
  return value.toLowerCase()
}

function idempotencyKey(value) {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    fail("invalid_request", "Document mark idempotency identity is invalid.")
  }
  return value
}

function boundedAuthorityPart(value, label) {
  if (typeof value !== "string" || !value || value.length > 512 || AUTHORITY_CONTROL.test(value)) {
    fail("invalid_request", `${label} is invalid.`)
  }
  return value
}

function timestamp(value, label, code = "invalid_request") {
  const match = typeof value === "string" ? ISO_DATE_TIME.exec(value) : null
  const year = Number(match?.[1])
  const month = Number(match?.[2])
  const day = Number(match?.[3])
  const hour = Number(match?.[4])
  const minute = Number(match?.[5])
  const second = Number(match?.[6])
  const offsetHour = match?.[8] === undefined ? 0 : Number(match[8])
  const offsetMinute = match?.[9] === undefined ? 0 : Number(match[9])
  const maximumDay = Number.isSafeInteger(year) && Number.isSafeInteger(month) && month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0
  if (!match || value.length > 64 || AUTHORITY_CONTROL.test(value) || year < 1 || month < 1 || month > 12
    || day < 1 || day > maximumDay || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59 || !Number.isFinite(Date.parse(value))) {
    fail(code, `${label} is invalid.`, code === "invalid_response" ? { ambiguous: true } : undefined)
  }
  return value
}

function markdown(value, code = "invalid_request") {
  if (typeof value !== "string" || value.includes("\u0000") || UNPAIRED_SURROGATE.test(value)
    || new TextEncoder().encode(value).byteLength > DOCUMENT_MARK_MAX_BODY_BYTES) {
    fail(code, "Document mark Markdown is outside its bounded size.")
  }
  return value
}

function tags(value, code = "invalid_request") {
  if (!Array.isArray(value) || value.length > 64) fail(code, "Document mark tags are invalid.")
  const result = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== "string" || item.includes("\u0000") || UNPAIRED_SURROGATE.test(item)) {
      fail(code, "Document mark tag is invalid.")
    }
    const normalized = item.trim()
    if (!normalized || [...normalized].length > 100 || new TextEncoder().encode(normalized).byteLength > 400) {
      fail(code, "Document mark tag is outside its bounded size.")
    }
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return Object.freeze(result)
}

function exactPinnedReference(value, kind, idPattern, label, code = "invalid_request") {
  const parsed = typeof value === "string" ? parseGalaxyObjectReference(value) : null
  if (!parsed || parsed.format !== "canonical" || parsed.kind !== kind || parsed.selector.mode !== "pinned"
    || !idPattern.test(parsed.id) || !/^sha256:[0-9a-f]{64}$/u.test(parsed.selector.revision)
    || serializeGalaxyObjectReference(parsed) !== value) {
    fail(code, `${label} is invalid.`, code === "invalid_response" ? { ambiguous: true } : undefined)
  }
  return parsed
}

function normalizedRectangle(selector) {
  const source = record(selector, "Document anchor selector")
  exactKeys(source, new Set([
    "kind", "page", "coordinateSpace", "polygon", ...(source.quoteHash === undefined ? [] : ["quoteHash"]),
  ]), "Document anchor selector")
  if (source.kind !== "page-region" || source.coordinateSpace !== "normalized-page"
    || !Number.isSafeInteger(source.page) || source.page < 1 || source.page > 1_000_000
    || !Array.isArray(source.polygon) || source.polygon.length !== 8) {
    fail("invalid_request", "Document mark page region must be one exact rectangular page coordinate.")
  }
  const polygon = source.polygon.map((coordinate) => {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1) {
      fail("invalid_request", "Document mark page region coordinates are invalid.")
    }
    const normalized = Math.floor((coordinate * 1_000_000) + 0.5) / 1_000_000
    return Object.is(normalized, -0) ? 0 : normalized
  })
  const [left, top, right, topAgain, rightAgain, bottom, leftAgain, bottomAgain] = polygon
  if (!(left < right && top < bottom)
    || topAgain !== top || rightAgain !== right || leftAgain !== left || bottomAgain !== bottom) {
    fail("invalid_request", "Document mark page region must be an axis-aligned rectangle.")
  }
  if (source.quoteHash !== undefined && (typeof source.quoteHash !== "string" || !SHA256.test(source.quoteHash))) {
    fail("invalid_request", "Document mark page-region quote hash is invalid.")
  }
  return Object.freeze({
    kind: "page-region",
    page: source.page,
    coordinateSpace: "normalized-page",
    polygon: Object.freeze(polygon),
    ...(source.quoteHash === undefined ? {} : { quoteHash: source.quoteHash }),
  })
}

function normalizedQuote(selector) {
  const source = record(selector, "Document anchor selector")
  exactKeys(source, new Set([
    "kind", "exact", ...(source.prefix === undefined ? [] : ["prefix"]),
    ...(source.suffix === undefined ? [] : ["suffix"]), ...(source.page === undefined ? [] : ["page"]),
  ]), "Document anchor selector")
  if (source.kind !== "text-quote" || typeof source.exact !== "string" || !source.exact
    || [...source.exact].length > DOCUMENT_MARK_MAX_TEXT_QUOTE_CHARACTERS
    || UNPAIRED_SURROGATE.test(source.exact)) {
    fail("invalid_request", "Document mark text quote is invalid or exceeds its canonical bound.")
  }
  const result = { kind: "text-quote", exact: source.exact }
  for (const key of ["prefix", "suffix"]) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== "string" || [...source[key]].length > 2_000 || UNPAIRED_SURROGATE.test(source[key])) {
        fail("invalid_request", "Document mark text quote context is invalid.")
      }
      result[key] = source[key]
    }
  }
  if (source.page !== undefined) {
    if (!Number.isSafeInteger(source.page) || source.page < 1 || source.page > 1_000_000) {
      fail("invalid_request", "Document mark text quote page is invalid.")
    }
    result.page = source.page
  }
  return Object.freeze(result)
}

function markableAnchor(value) {
  const source = record(value, "Document mark anchor")
  const id = source.id
  if (source.schemaId !== "gb.anchor.v1" || typeof id !== "string" || !SHA_ID.test(id)) {
    fail("invalid_request", "Document mark anchor identity is invalid.")
  }
  const ref = exactPinnedReference(source.ref, "document.anchor", SHA_ID, "Document mark anchor reference")
  const documentRevisionId = uuid(source.document_revision_id, "Document revision")
  const representationId = uuid(source.representation_id, "Document anchor representation")
  if (ref.id !== id || typeof source.representation_sha256 !== "string" || !SHA256.test(source.representation_sha256)
    || ref.selector.revision !== `sha256:${source.representation_sha256}`) {
    fail("invalid_request", "Document mark anchor reference does not match its immutable representation.")
  }
  const selector = source.selector?.kind === "text-quote"
    ? normalizedQuote(source.selector)
    : source.selector?.kind === "page-region"
      ? normalizedRectangle(source.selector)
      : fail("invalid_request", "Document marks require an exact quote or rectangular page region.")
  if (source.selector_kind !== selector.kind) fail("invalid_request", "Document mark selector identity is inconsistent.")
  const selectorJson = canonicalJson(selector)
  if (new TextEncoder().encode(selectorJson).byteLength > 32_768) {
    fail("invalid_request", "Document mark selector exceeds its canonical bound.")
  }
  const selectorSha256 = sha256Text(selectorJson)
  const anchorSha256 = sha256Text(canonicalJson({
    representationId,
    representationSha256: source.representation_sha256,
    selector,
  }))
  if (source.selector_sha256 !== selectorSha256 || source.anchor_sha256 !== anchorSha256
    || id !== `sha256:${anchorSha256}` || ref.id !== `sha256:${anchorSha256}`) {
    fail("invalid_request", "Document mark selector does not match its canonical anchor identity.")
  }
  return Object.freeze({
    schemaId: "gb.anchor.v1",
    id,
    ref: source.ref,
    document_revision_id: documentRevisionId,
    representation_id: representationId,
    representation_sha256: source.representation_sha256,
    selector,
    selector_kind: selector.kind,
    selector_sha256: selectorSha256,
    anchor_sha256: anchorSha256,
  })
}

function normalizedMarkFields(source) {
  const kind = source.kind
  const semanticRole = source.semanticRole
  if (!new Set(["highlight", "note"]).has(kind)
    || !new Set(["evidence", "note"]).has(semanticRole)
    || (kind === "highlight" && semanticRole !== "evidence")
    || (kind === "note" && semanticRole !== "note")) {
    fail("invalid_request", "Document mark kind and semantic role are inconsistent.")
  }
  if (source.state !== "active") fail("invalid_request", "A new document mark must be active.")
  const normalizedColor = typeof source.color === "string" ? source.color.toLowerCase() : ""
  if (!COLOR.test(normalizedColor)) fail("invalid_request", "Document mark color is invalid.")
  return {
    kind,
    bodyMarkdown: markdown(source.bodyMarkdown),
    color: normalizedColor,
    semanticRole,
    tags: tags(source.tags),
    state: "active",
  }
}

export class DocumentMarkClientError extends Error {
  constructor(code, message, { ambiguous = false, status = null } = {}) {
    super(message)
    this.name = "DocumentMarkClientError"
    this.code = code
    this.ambiguous = ambiguous
    this.status = Number.isSafeInteger(status) ? status : null
  }
}

/** Freeze one exact create request. The caller, not this helper, owns the idempotency identity. */
export function prepareDocumentMarkCreateIntent(value, options = {}) {
  const source = record(value, "Document mark intent")
  exactKeys(source, PREPARE_KEYS, "Document mark intent")
  const anchor = markableAnchor(source.anchor)
  const requestedAt = timestamp(source.requestedAt, "Document mark request time")
  const fields = normalizedMarkFields(source)
  const key = idempotencyKey(options.idempotencyKey)
  const request = Object.freeze({
    kind: fields.kind,
    body_markdown: fields.bodyMarkdown,
    color: fields.color,
    semantic_role: fields.semanticRole,
    tags: fields.tags,
    state: fields.state,
    idempotency_key: key,
  })
  const requestBody = JSON.stringify(request)
  if (new TextEncoder().encode(requestBody).byteLength > 131_072) {
    fail("invalid_request", "Document mark request exceeds its transport bound.")
  }
  return Object.freeze({
    schemaId: INTENT_SCHEMA,
    anchor,
    requestedAt,
    ...fields,
    idempotencyKey: key,
    requestBody,
  })
}

/** Parse persisted intent only when every field regenerates the same request bytes. */
export function parseDocumentMarkCreateIntent(value) {
  const source = record(value, "Document mark intent")
  exactKeys(source, INTENT_KEYS, "Document mark intent")
  if (source.schemaId !== INTENT_SCHEMA) fail("invalid_request", "Document mark intent schema is unsupported.")
  exactKeys(record(source.anchor, "Document mark anchor"), ANCHOR_KEYS, "Document mark anchor")
  const expected = prepareDocumentMarkCreateIntent({
    anchor: source.anchor,
    requestedAt: source.requestedAt,
    kind: source.kind,
    bodyMarkdown: source.bodyMarkdown,
    color: source.color,
    semanticRole: source.semanticRole,
    tags: source.tags,
    state: source.state,
  }, { idempotencyKey: source.idempotencyKey })
  if (source.requestBody !== expected.requestBody) {
    fail("invalid_request", "Document mark request body does not match its frozen intent.")
  }
  return expected
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function documentMarkContentHash(intent) {
  return sha256Text(canonicalJson({
    schemaId: MARK_SCHEMA,
    anchorId: intent.anchor.id,
    kind: intent.kind,
    bodyMarkdown: intent.bodyMarkdown,
    color: intent.color,
    semanticRole: intent.semanticRole,
    tags: intent.tags,
    state: intent.state,
  }))
}

function documentMarkSnapshotContentHash(source) {
  return sha256Text(canonicalJson({
    schemaId: MARK_SCHEMA,
    anchorId: source.anchor_id,
    kind: source.kind,
    bodyMarkdown: source.body_markdown,
    color: source.color,
    semanticRole: source.semantic_role,
    tags: source.tags,
    state: source.state,
  }))
}

/** Validate one current list snapshot without applying create-ack-only rules. */
export function validateDurableDocumentMarkSnapshot(value, expected = {}) {
  const expectedDocumentRevisionId = uuid(expected.documentRevisionId, "Document revision", "invalid_response")
  const expectedAnchorId = typeof expected.anchorId === "string" && SHA_ID.test(expected.anchorId)
    ? expected.anchorId
    : fail("invalid_response", "Document mark anchor is invalid.")
  const expectedAnchorRef = exactPinnedReference(
    expected.anchorRef, "document.anchor", SHA_ID, "Document mark anchor reference", "invalid_response",
  )
  if (expectedAnchorRef.id !== expectedAnchorId) fail("invalid_response", "Document mark anchor reference is inconsistent.")
  const source = record(value, "Document mark snapshot", "invalid_response")
  exactKeys(source, MARK_SNAPSHOT_KEYS, "Document mark snapshot", "invalid_response")
  const markId = uuid(source.id, "Document mark id", "invalid_response")
  const revisionId = uuid(source.revision_id, "Document mark revision id", "invalid_response")
  const documentRevisionId = uuid(source.document_revision_id, "Document revision", "invalid_response")
  const createdBy = uuid(source.created_by_principal_id, "Document mark author", "invalid_response")
  const markRef = exactPinnedReference(source.ref, "document.mark", UUID, "Document mark reference", "invalid_response")
  const anchorRef = exactPinnedReference(source.anchor_ref, "document.anchor", SHA_ID, "Document mark anchor reference", "invalid_response")
  const bodyMarkdown = markdown(source.body_markdown, "invalid_response")
  const normalizedTags = tags(source.tags, "invalid_response")
  const createdAt = timestamp(source.created_at, "Document mark creation time", "invalid_response")
  const updatedAt = timestamp(source.updated_at, "Document mark update time", "invalid_response")
  if (source.schemaId !== MARK_SCHEMA || documentRevisionId !== expectedDocumentRevisionId
    || source.anchor_id !== expectedAnchorId || source.anchor_ref !== expected.anchorRef || anchorRef.id !== expectedAnchorId
    || markRef.id !== markId || !new Set(["highlight", "note", "ink"]).has(source.kind)
    || !Number.isSafeInteger(source.version) || source.version < 1
    || typeof source.content_hash !== "string" || !SHA256.test(source.content_hash)
    || markRef.selector.revision !== `sha256:${source.content_hash}`
    || typeof source.color !== "string" || !COLOR.test(source.color)
    || !new Set(["note", "claim", "evidence", "question"]).has(source.semantic_role)
    || !new Set(["active", "resolved"]).has(source.state)
    || !sameArray(source.tags, normalizedTags)
    || source.content_hash !== documentMarkSnapshotContentHash({ ...source, body_markdown: bodyMarkdown, tags: normalizedTags })
    || Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail("invalid_response", "Document mark snapshot is inconsistent.")
  }
  return Object.freeze({
    schemaId: MARK_SCHEMA,
    id: markId,
    ref: source.ref,
    document_revision_id: documentRevisionId,
    anchor_id: source.anchor_id,
    anchor_ref: source.anchor_ref,
    kind: source.kind,
    version: source.version,
    revision_id: revisionId,
    content_hash: source.content_hash,
    body_markdown: bodyMarkdown,
    color: source.color,
    semantic_role: source.semantic_role,
    tags: normalizedTags,
    state: source.state,
    created_by_principal_id: createdBy,
    created_at: createdAt,
    updated_at: updatedAt,
  })
}

/** Parse the bounded current-snapshot list returned for one immutable anchor. */
export function parseDocumentMarkList(value, expected = {}) {
  const documentRevisionId = uuid(expected.documentRevisionId, "Document revision", "invalid_response")
  const anchorId = typeof expected.anchorId === "string" && SHA_ID.test(expected.anchorId)
    ? expected.anchorId
    : fail("invalid_response", "Document mark anchor is invalid.")
  const anchorRef = exactPinnedReference(
    expected.anchorRef, "document.anchor", SHA_ID, "Document mark anchor reference", "invalid_response",
  )
  if (anchorRef.id !== anchorId) fail("invalid_response", "Document mark anchor reference is inconsistent.")
  const source = record(value, "Document mark list", "invalid_response")
  exactKeys(source, MARK_LIST_KEYS, "Document mark list", "invalid_response")
  if (source.schemaId !== "gb.document-mark.list.v1"
    || uuid(source.document_revision_id, "Document revision", "invalid_response") !== documentRevisionId
    || source.anchor_id !== anchorId || !Array.isArray(source.marks)
    || source.marks.length > DOCUMENT_MARK_LIST_LIMIT) {
    fail("invalid_response", "Document mark list does not match the requested anchor.")
  }
  const marks = source.marks.map((mark) => validateDurableDocumentMarkSnapshot(mark, {
    documentRevisionId,
    anchorId,
    anchorRef: expected.anchorRef,
  }))
  const markIds = new Set(marks.map((mark) => mark.id))
  const revisionIds = new Set(marks.map((mark) => mark.revision_id))
  if (markIds.size !== marks.length || revisionIds.size !== marks.length) {
    fail("invalid_response", "Document mark list contains duplicate snapshots.")
  }
  return Object.freeze({
    schemaId: "gb.document-mark.list.v1",
    document_revision_id: documentRevisionId,
    anchor_id: anchorId,
    marks: Object.freeze(marks),
    completeness: marks.length === DOCUMENT_MARK_LIST_LIMIT ? "possibly-incomplete" : "complete",
  })
}

/** Validate the complete acknowledgement against both the frozen bytes and browser principal. */
export function validateDurableDocumentMark(value, expected = {}) {
  const intent = parseDocumentMarkCreateIntent(expected.intent)
  const principalId = uuid(expected.principalId, "Document mark principal", "invalid_response")
  const source = record(value, "Document mark acknowledgement", "invalid_response")
  exactKeys(source, MARK_KEYS, "Document mark acknowledgement", "invalid_response")
  const markId = uuid(source.id, "Document mark id", "invalid_response")
  const revisionId = uuid(source.revision_id, "Document mark revision id", "invalid_response")
  const documentRevisionId = uuid(source.document_revision_id, "Document revision", "invalid_response")
  const createdBy = uuid(source.created_by_principal_id, "Document mark author", "invalid_response")
  const markRef = exactPinnedReference(source.ref, "document.mark", UUID, "Document mark reference", "invalid_response")
  const anchorRef = exactPinnedReference(source.anchor_ref, "document.anchor", SHA_ID, "Document mark anchor reference", "invalid_response")
  const expectedContentHash = documentMarkContentHash(intent)
  if (source.schemaId !== MARK_SCHEMA || documentRevisionId !== intent.anchor.document_revision_id
    || source.anchor_id !== intent.anchor.id || source.anchor_ref !== intent.anchor.ref || anchorRef.id !== source.anchor_id
    || markRef.id !== markId || source.content_hash !== expectedContentHash
    || markRef.selector.revision !== `sha256:${source.content_hash}` || source.kind !== intent.kind
    || source.version !== 1 || !Number.isSafeInteger(source.version) || revisionId !== source.revision_id.toLowerCase()
    || source.body_markdown !== intent.bodyMarkdown || source.color !== intent.color
    || source.semantic_role !== intent.semanticRole || source.state !== intent.state
    || !Array.isArray(source.tags) || !sameArray(source.tags, intent.tags)
    || createdBy !== principalId || typeof source.replayed !== "boolean") {
    fail("invalid_response", "Document mark acknowledgement does not match its frozen request.", { ambiguous: true })
  }
  const createdAt = timestamp(source.created_at, "Document mark creation time", "invalid_response")
  const updatedAt = timestamp(source.updated_at, "Document mark update time", "invalid_response")
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail("invalid_response", "Document mark acknowledgement timestamps are inconsistent.", { ambiguous: true })
  }
  return Object.freeze({
    schemaId: MARK_SCHEMA,
    id: markId,
    ref: source.ref,
    document_revision_id: documentRevisionId,
    anchor_id: source.anchor_id,
    anchor_ref: source.anchor_ref,
    kind: source.kind,
    version: source.version,
    revision_id: revisionId,
    content_hash: source.content_hash,
    body_markdown: source.body_markdown,
    color: source.color,
    semantic_role: source.semantic_role,
    tags: Object.freeze([...source.tags]),
    state: source.state,
    created_by_principal_id: createdBy,
    created_at: createdAt,
    updated_at: updatedAt,
    replayed: source.replayed,
  })
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json" || response.redirected) {
    fail("invalid_response", "The document mark service returned an invalid response.", {
      ambiguous: response.ok || response.status >= 500,
      status: response.status,
    })
  }
  try {
    return JSON.parse(await readBoundedResponseText(response, DOCUMENT_MARK_MAX_RESPONSE_BYTES))
  } catch {
    fail("invalid_response", "The document mark service response could not be verified.", {
      ambiguous: response.ok || response.status >= 500,
      status: response.status,
    })
  }
}

/** Fetch one bounded current-snapshot list from the authenticated same-origin proxy. */
export async function listDocumentMarks(anchorValue, options = {}) {
  const anchor = record(anchorValue, "Document mark anchor")
  const documentRevisionId = uuid(anchor.document_revision_id, "Document revision")
  const anchorId = typeof anchor.id === "string" && SHA_ID.test(anchor.id)
    ? anchor.id
    : fail("invalid_request", "Document mark anchor is invalid.")
  const anchorRef = exactPinnedReference(anchor.ref, "document.anchor", SHA_ID, "Document mark anchor reference")
  if (anchorRef.id !== anchorId) fail("invalid_request", "Document mark anchor reference is inconsistent.")
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== "function") fail("transport_unavailable", "Document mark transport is unavailable.")
  const requestPath = `/api/eln/documents/${encodeURIComponent(documentRevisionId)}/anchors/${encodeURIComponent(anchorId)}/marks`
  let response
  try {
    response = await fetcher(requestPath, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")) throw error
    fail("transport_error", "Document marks could not be loaded.")
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (response.redirected || contentType !== "application/json") {
    fail("invalid_response", "The document mark list response is invalid.", { status: response.status })
  }
  if (response.url) {
    const origin = options.origin ?? globalThis.location?.origin
    if (!origin) fail("invalid_response", "Document mark response origin is unavailable.", { status: response.status })
    const expectedUrl = new URL(requestPath, origin)
    const actualUrl = new URL(response.url, origin)
    if (actualUrl.origin !== expectedUrl.origin || actualUrl.pathname !== expectedUrl.pathname || actualUrl.search) {
      fail("invalid_response", "The document mark list response was redirected.", { status: response.status })
    }
  }
  let body
  try {
    body = JSON.parse(await readBoundedResponseText(response, DOCUMENT_MARK_LIST_MAX_RESPONSE_BYTES))
  } catch (error) {
    if (error instanceof DocumentMarkClientError) throw error
    fail("invalid_response", "The document mark list response could not be verified.", { status: response.status })
  }
  if (!response.ok) fail("request_failed", "Document marks could not be loaded.", { status: response.status })
  return parseDocumentMarkList(body, { documentRevisionId, anchorId, anchorRef: anchor.ref })
}

/** Submit exactly the bytes frozen by prepareDocumentMarkCreateIntent. */
export async function createDocumentMark(intentValue, options = {}) {
  const intent = parseDocumentMarkCreateIntent(intentValue)
  const principalId = uuid(options.principalId, "Document mark principal")
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== "function") fail("transport_unavailable", "Document mark transport is unavailable.")
  let response
  try {
    response = await fetcher(
      `/api/eln/documents/${encodeURIComponent(intent.anchor.document_revision_id)}/anchors/${encodeURIComponent(intent.anchor.id)}/marks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: intent.requestBody,
        signal: options.signal,
      },
    )
  } catch (error) {
    if (options.signal?.aborted || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")) throw error
    fail("transport_error", "The document mark request may have reached the server. Retry the exact frozen request.", {
      ambiguous: true,
    })
  }
  const body = await readJsonResponse(response)
  if (!response.ok) {
    fail("request_failed", "The document mark was not accepted.", {
      ambiguous: response.status >= 500,
      status: response.status,
    })
  }
  return validateDurableDocumentMark(body, { intent, principalId })
}

function normalizedScope(value) {
  const source = record(value, "Document mark recovery scope")
  return Object.freeze({
    tenantId: boundedAuthorityPart(source.tenantId, "Tenant"),
    principalId: uuid(source.principalId, "Principal"),
    documentRevisionId: uuid(source.documentRevisionId, "Document revision"),
  })
}

function recoveryNamespace(scopeValue) {
  const scope = normalizedScope(scopeValue)
  return `${RECOVERY_PREFIX}:${encodeURIComponent(scope.tenantId)}:${encodeURIComponent(scope.principalId)}:${encodeURIComponent(scope.documentRevisionId)}:`
}

export function documentMarkRecoveryStorageKey(scopeValue, operationKey) {
  return `${recoveryNamespace(scopeValue)}${encodeURIComponent(idempotencyKey(operationKey))}`
}

function normalizeRecovery(value, expectedScope) {
  const source = record(value, "Document mark recovery")
  exactKeys(source, RECOVERY_KEYS, "Document mark recovery")
  const scope = normalizedScope(source)
  const expected = normalizedScope(expectedScope)
  const intent = parseDocumentMarkCreateIntent(source.intent)
  if (source.schemaId !== RECOVERY_SCHEMA || scope.tenantId !== expected.tenantId
    || scope.principalId !== expected.principalId || scope.documentRevisionId !== expected.documentRevisionId
    || intent.anchor.document_revision_id !== expected.documentRevisionId) {
    fail("invalid_request", "Document mark recovery authority is inconsistent.")
  }
  return Object.freeze({ schemaId: RECOVERY_SCHEMA, ...scope, intent })
}

export function writeDocumentMarkRecovery(storage, scopeValue, intentValue) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    fail("storage_unavailable", "Document mark recovery storage is unavailable.")
  }
  const scope = normalizedScope(scopeValue)
  const intent = parseDocumentMarkCreateIntent(intentValue)
  const recovery = normalizeRecovery({ schemaId: RECOVERY_SCHEMA, ...scope, intent }, scope)
  const key = documentMarkRecoveryStorageKey(scope, intent.idempotencyKey)
  const existingRaw = storage.getItem(key)
  if (existingRaw !== null) {
    try {
      if (typeof existingRaw !== "string" || !existingRaw || existingRaw.length > 200_000) {
        throw new TypeError("invalid recovery")
      }
      const existing = normalizeRecovery(JSON.parse(existingRaw), scope)
      if (key !== documentMarkRecoveryStorageKey(scope, existing.intent.idempotencyKey)
        || JSON.stringify(existing.intent) !== JSON.stringify(intent)) {
        throw new TypeError("conflicting recovery")
      }
      return existing
    } catch {
      fail("recovery_conflict", "Document mark recovery identity is already occupied.")
    }
  }
  storage.setItem(key, JSON.stringify(recovery))
  return recovery
}

export function readDocumentMarkRecoveries(storage, scopeValue) {
  if (!storage || typeof storage.length !== "number" || typeof storage.key !== "function"
    || typeof storage.getItem !== "function" || typeof storage.removeItem !== "function") {
    fail("storage_unavailable", "Document mark recovery storage is unavailable.")
  }
  const scope = normalizedScope(scopeValue)
  const prefix = recoveryNamespace(scope)
  const recoveries = []
  const invalid = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith(prefix)) continue
    try {
      const raw = storage.getItem(key)
      if (typeof raw !== "string" || !raw || raw.length > 200_000) throw new TypeError("invalid recovery")
      const recovery = normalizeRecovery(JSON.parse(raw), scope)
      if (key !== documentMarkRecoveryStorageKey(scope, recovery.intent.idempotencyKey)) throw new TypeError("key mismatch")
      recoveries.push(recovery)
    } catch {
      invalid.push(key)
    }
  }
  invalid.forEach((key) => storage.removeItem(key))
  return Object.freeze(recoveries.sort((left, right) => (
    left.intent.requestedAt.localeCompare(right.intent.requestedAt)
      || left.intent.idempotencyKey.localeCompare(right.intent.idempotencyKey)
  )))
}

export function removeDocumentMarkRecovery(storage, scopeValue, operationKey) {
  if (!storage || typeof storage.removeItem !== "function") fail("storage_unavailable", "Document mark recovery storage is unavailable.")
  storage.removeItem(documentMarkRecoveryStorageKey(scopeValue, operationKey))
}

function removeDocumentMarkRecoveryIfCurrent(storage, scopeValue, intentValue) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.removeItem !== "function") {
    fail("storage_unavailable", "Document mark recovery storage is unavailable.")
  }
  const scope = normalizedScope(scopeValue)
  const intent = parseDocumentMarkCreateIntent(intentValue)
  const key = documentMarkRecoveryStorageKey(scope, intent.idempotencyKey)
  const raw = storage.getItem(key)
  if (typeof raw !== "string" || !raw || raw.length > 200_000) return false
  try {
    const recovery = normalizeRecovery(JSON.parse(raw), scope)
    if (key !== documentMarkRecoveryStorageKey(scope, recovery.intent.idempotencyKey)
      || JSON.stringify(recovery.intent) !== JSON.stringify(intent)) return false
  } catch {
    return false
  }
  storage.removeItem(key)
  return true
}

/** Persist before delivery and clear only after a complete, request-bound acknowledgement. */
export async function createDocumentMarkRecoverably(intentValue, options = {}) {
  const scope = normalizedScope(options.scope)
  const intent = parseDocumentMarkCreateIntent(intentValue)
  if (intent.anchor.document_revision_id !== scope.documentRevisionId) {
    fail("invalid_request", "Document mark recovery does not match its document revision.")
  }
  writeDocumentMarkRecovery(options.storage, scope, intent)
  const mark = await createDocumentMark(intent, {
    fetcher: options.fetcher,
    signal: options.signal,
    principalId: scope.principalId,
  })
  removeDocumentMarkRecoveryIfCurrent(options.storage, scope, intent)
  return mark
}
