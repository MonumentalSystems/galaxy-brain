import { createGalaxyObjectReference } from "./galaxy-object-reference.js"
import {
  selectExactDerivedDocumentState,
  shouldAcceptDerivedDocumentCompletion,
} from "./document-derived-reader.js"

export const MAX_EXACT_TEXT_DOCUMENT_BYTES = 2 * 1024 * 1024
export const MAX_EXACT_TEXT_SELECTION_CHARS = 16_000
export const MAX_EXACT_TEXT_SELECTOR_BYTES = 32_768

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u
const ANCHOR_ID = /^sha256:[0-9a-f]{64}$/u

export class ExactTextDocumentError extends Error {}

function exactString(value, maximum, label) {
  if (
    typeof value !== "string"
    || value.length < 1
    || Array.from(value).length > maximum
    || CONTROL.test(value)
  ) {
    throw new ExactTextDocumentError(`${label} is invalid`)
  }
  return value
}

function exactUuid(value, label) {
  const normalized = exactString(value, 36, label).toLowerCase()
  if (!UUID.test(normalized) || value !== normalized) {
    throw new ExactTextDocumentError(`${label} is invalid`)
  }
  return normalized
}

function exactSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ExactTextDocumentError(`${label} is invalid`)
  }
  return value
}

function normalizedMediaType(value, label) {
  if (typeof value !== "string" || value !== value.trim().toLowerCase() || !MEDIA_TYPE.test(value)) {
    throw new ExactTextDocumentError(`${label} is invalid`)
  }
  return value
}

export function isExactTextDocumentMediaType(value) {
  if (typeof value !== "string") return false
  const mediaType = value.trim().toLowerCase()
  return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/xml"
}

export function isExactMarkdownMediaType(value) {
  return value === "text/markdown" || value === "text/x-markdown"
}

export function isExactHtmlDocumentDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return value.mediaType === "text/html"
}

export function shouldAcceptExactHtmlDerivedCompletion(completion, current) {
  return shouldAcceptDerivedDocumentCompletion(completion, current)
}

/**
 * Validate and select only the current receipt-bound HTML projections. This is
 * deliberately stricter than the generic PDF chooser: source identity,
 * manifest identity, output identity, status, and fallback lineage must all
 * agree before a derived view becomes renderable.
 */
export function selectExactHtmlDerivedState(descriptor, representations, receipts) {
  if (!isExactHtmlDocumentDescriptor(descriptor)) {
    throw new ExactTextDocumentError("Derived HTML reading state is invalid")
  }
  try {
    return selectExactDerivedDocumentState(descriptor, representations, receipts, { label: "HTML" })
  } catch {
    throw new ExactTextDocumentError("Derived HTML reading state is invalid")
  }
}

export function exactTextDocumentAnchorSearch(search, anchorId) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""))
  params.delete("paperAnchor")
  if (anchorId === null) params.delete("documentAnchor")
  else if (typeof anchorId === "string" && ANCHOR_ID.test(anchorId)) params.set("documentAnchor", anchorId)
  else throw new ExactTextDocumentError("Document anchor identifier is invalid")
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ""
}

/**
 * Bind an immutable document revision to its one authoritative original text
 * representation. Derived representations are intentionally ignored here.
 */
export function exactTextDocumentDescriptor(value, expectedRevisionId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExactTextDocumentError("Document revision is invalid")
  }
  if (value.schemaId !== "gb.document-revision.v1") {
    throw new ExactTextDocumentError("Document revision schema is invalid")
  }
  const revisionId = exactUuid(value.revision_id, "Document revision identifier")
  if (revisionId !== exactUuid(expectedRevisionId, "Requested document revision identifier")) {
    throw new ExactTextDocumentError("Galaxy Brain returned a stale document revision")
  }
  const documentId = exactUuid(value.document_id, "Document identifier")
  const revisionSha256 = exactSha256(value.revision_sha256, "Document revision hash")
  const expectedRef = createGalaxyObjectReference("document", documentId, {
    mode: "pinned",
    revision: `sha256:${revisionSha256}`,
  })
  if (value.ref !== expectedRef) {
    throw new ExactTextDocumentError("Document reference does not match its exact revision")
  }
  if (!value.artifact || typeof value.artifact !== "object" || Array.isArray(value.artifact)) {
    throw new ExactTextDocumentError("Document artifact is invalid")
  }
  const artifactId = exactUuid(value.artifact.id, "Document artifact identifier")
  const contentSha256 = exactSha256(value.artifact.content_sha256, "Document content hash")
  const mediaType = normalizedMediaType(value.artifact.media_type, "Document media type")
  if (!isExactTextDocumentMediaType(mediaType)) {
    throw new ExactTextDocumentError("Document media type is not supported by the exact text reader")
  }
  if (!Number.isSafeInteger(value.artifact.byte_size)
    || value.artifact.byte_size < 1
    || value.artifact.byte_size > MAX_EXACT_TEXT_DOCUMENT_BYTES) {
    throw new ExactTextDocumentError("Document text exceeds the exact reader limit")
  }
  if (!Array.isArray(value.representations) || value.representations.length < 1 || value.representations.length > 32) {
    throw new ExactTextDocumentError("Document representations are invalid")
  }
  const originals = value.representations.filter((item) => item?.kind === "original")
  if (originals.length !== 1) {
    throw new ExactTextDocumentError("Document must have exactly one original representation")
  }
  const original = originals[0]
  const representationId = exactUuid(original.id, "Original representation identifier")
  if (
    normalizedMediaType(original.media_type, "Original representation media type") !== mediaType
    || exactSha256(original.content_sha256, "Original representation hash") !== contentSha256
  ) {
    throw new ExactTextDocumentError("Original representation does not match the document artifact")
  }
  const expectedContentPath = `/documents/${revisionId}/representations/${representationId}/content`
  if (original.content_path !== expectedContentPath) {
    throw new ExactTextDocumentError("Original representation content path is invalid")
  }
  const contentUrl = `/api/eln${expectedContentPath}?${new URLSearchParams({
    document_id: documentId,
    revision_sha256: revisionSha256,
  })}`
  const representationRef = `gb:representation:document:${encodeURIComponent(documentId)}:${encodeURIComponent(representationId)}`
  return Object.freeze({
    artifactId,
    byteSize: value.artifact.byte_size,
    contentSha256,
    contentUrl,
    documentId,
    documentRef: expectedRef,
    displayFilename: exactString(value.display_filename, 512, "Document display filename"),
    markdown: isExactMarkdownMediaType(mediaType),
    mediaType,
    representationId,
    representationRef,
    revisionId,
    revisionSha256,
    title: exactString(value.title, 500, "Document title"),
  })
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function exactTextQuoteCanonicalJson(selector) {
  return JSON.stringify({ exact: selector.exact, kind: "text-quote" })
}

function exactTextAnchorCanonicalJson(descriptor, selector) {
  return JSON.stringify({
    representationId: descriptor.representationId,
    representationSha256: descriptor.contentSha256,
    selector: { exact: selector.exact, kind: "text-quote" },
  })
}

/**
 * Convert one browser-visible selection into an exact source selector.
 * Rendered Markdown or KaTeX text is accepted only when those same code points
 * occur once, contiguously, in the verified immutable source.
 */
export function exactTextQuoteForSelection(source, selection) {
  if (typeof source !== "string" || typeof selection !== "string" || !selection.trim()) {
    throw new ExactTextDocumentError("Select a non-empty exact source passage")
  }
  if (Array.from(selection).length > MAX_EXACT_TEXT_SELECTION_CHARS || /[\uD800-\uDFFF]/u.test(selection)) {
    throw new ExactTextDocumentError("The exact selection exceeds the anchor limit")
  }
  const selector = Object.freeze({ kind: "text-quote", exact: selection })
  if (new TextEncoder().encode(exactTextQuoteCanonicalJson(selector)).byteLength > MAX_EXACT_TEXT_SELECTOR_BYTES) {
    throw new ExactTextDocumentError("The exact selection exceeds the anchor limit")
  }
  const first = source.indexOf(selection)
  if (first < 0) {
    throw new ExactTextDocumentError("The rendered selection is not a literal passage in the verified source")
  }
  if (source.indexOf(selection, first + 1) >= 0) {
    throw new ExactTextDocumentError("The selected passage occurs more than once in the verified source")
  }
  return selector
}

function exactAnchorRecordString(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || Array.from(value).length > maximum || CONTROL.test(value)) {
    throw new ExactTextDocumentError(`${label} is invalid`)
  }
  return value
}

/**
 * Verify that the server acknowledgement is the exact canonical anchor for the
 * selected passage and immutable representation requested by this reader.
 */
export async function validateExactTextAnchorResponse(value, descriptor, selector, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaId !== "gb.anchor.v1") {
    throw new ExactTextDocumentError("Exact anchor response is invalid")
  }
  if (
    !selector
    || typeof selector !== "object"
    || Array.isArray(selector)
    || Object.keys(selector).sort().join(",") !== "exact,kind"
    || selector.kind !== "text-quote"
    || typeof selector.exact !== "string"
  ) {
    throw new ExactTextDocumentError("Exact anchor selector is invalid")
  }
  const normalizedSelector = exactTextQuoteForSelection(selector.exact, selector.exact)
  if (
    !value.selector
    || typeof value.selector !== "object"
    || Array.isArray(value.selector)
    || Object.keys(value.selector).sort().join(",") !== "exact,kind"
    || value.selector.kind !== normalizedSelector.kind
    || value.selector.exact !== normalizedSelector.exact
    || value.selector_kind !== "text-quote"
  ) {
    throw new ExactTextDocumentError("Exact anchor response changed the selected passage")
  }
  const digest = options.digest ?? defaultDigest
  if (typeof digest !== "function") throw new ExactTextDocumentError("Exact anchor verifier is unavailable")
  const encoder = new TextEncoder()
  const selectorSha256 = await digest(encoder.encode(exactTextQuoteCanonicalJson(normalizedSelector)))
  const anchorSha256 = await digest(encoder.encode(exactTextAnchorCanonicalJson(descriptor, normalizedSelector)))
  const anchorId = `sha256:${anchorSha256}`
  const anchorRef = createGalaxyObjectReference("document.anchor", anchorId, {
    mode: "pinned",
    revision: `sha256:${descriptor.contentSha256}`,
  })
  if (
    value.id !== anchorId
    || value.ref !== anchorRef
    || value.document_ref !== descriptor.documentRef
    || value.document_id !== descriptor.documentId
    || value.document_revision_id !== descriptor.revisionId
    || value.document_revision_sha256 !== descriptor.revisionSha256
    || value.representation_id !== descriptor.representationId
    || value.representation_kind !== "original"
    || value.representation_media_type !== descriptor.mediaType
    || value.representation_sha256 !== descriptor.contentSha256
    || value.selector_sha256 !== selectorSha256
    || value.anchor_sha256 !== anchorSha256
    || value.title !== descriptor.title
    || value.display_filename !== descriptor.displayFilename
  ) {
    throw new ExactTextDocumentError("Exact anchor response does not match the immutable selection")
  }
  exactAnchorRecordString(value.created_at, 128, "Exact anchor timestamp")
  if (
    !value.source
    || typeof value.source !== "object"
    || Array.isArray(value.source)
  ) {
    throw new ExactTextDocumentError("Exact anchor source is invalid")
  }
  exactAnchorRecordString(value.source.id, 512, "Exact anchor source identifier")
  exactAnchorRecordString(value.source.kind, 128, "Exact anchor source kind")
  if (value.source.uri !== null) {
    exactAnchorRecordString(value.source.uri, 2_048, "Exact anchor source URI")
  }
  if (value.transform_receipt_ids !== undefined && (
    !Array.isArray(value.transform_receipt_ids)
    || value.transform_receipt_ids.some((item) => typeof item !== "string" || !item)
  )) {
    throw new ExactTextDocumentError("Exact anchor receipts are invalid")
  }
  if (value.replayed !== undefined && typeof value.replayed !== "boolean") {
    throw new ExactTextDocumentError("Exact anchor replay state is invalid")
  }
  return Object.freeze(value)
}

async function defaultDigest(bytes) {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer)))
}

async function readBoundedBytes(stream, maximumBytes) {
  const reader = stream.getReader()
  const chunks = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined)
        throw new ExactTextDocumentError("Exact document response is invalid")
      }
      received += value.byteLength
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ExactTextDocumentError("Exact document response exceeds the reader limit")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Fetch, bound, hash, and decode one exact immutable UTF-8 representation. */
export async function loadExactTextDocument(descriptor, options = {}) {
  const fetcher = options.fetcher ?? globalThis.fetch
  const digest = options.digest ?? defaultDigest
  if (typeof fetcher !== "function" || typeof digest !== "function") {
    throw new ExactTextDocumentError("Exact document transport is unavailable")
  }
  const response = await fetcher(descriptor.contentUrl, {
    cache: "no-store",
    redirect: "error",
    signal: options.signal,
    headers: { Accept: descriptor.mediaType },
  })
  if (!response || response.redirected === true || !response.ok) {
    await response?.body?.cancel?.().catch(() => undefined)
    throw new ExactTextDocumentError("Exact document content is unavailable")
  }
  if (response.url) {
    const origin = options.origin ?? globalThis.location?.origin
    if (!origin) throw new ExactTextDocumentError("Exact document origin is unavailable")
    const actual = new URL(response.url, origin)
    const expected = new URL(descriptor.contentUrl, origin)
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search !== expected.search) {
      await response.body?.cancel?.().catch(() => undefined)
      throw new ExactTextDocumentError("Exact document response was redirected")
    }
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  const contentSha256 = response.headers.get("x-content-sha256")
  const etag = response.headers.get("etag")
  const declaredLength = response.headers.get("content-length")
  if (
    mediaType !== descriptor.mediaType
    || contentSha256 !== descriptor.contentSha256
    || etag !== `"sha256-${descriptor.contentSha256}"`
    || (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) !== descriptor.byteSize))
    || !response.body
  ) {
    await response.body?.cancel?.().catch(() => undefined)
    throw new ExactTextDocumentError("Exact document response does not match its representation")
  }
  const bytes = await readBoundedBytes(response.body, MAX_EXACT_TEXT_DOCUMENT_BYTES)
  if (bytes.byteLength !== descriptor.byteSize || await digest(bytes) !== descriptor.contentSha256) {
    throw new ExactTextDocumentError("Exact document bytes do not match their content hash")
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new ExactTextDocumentError("Exact document content is not valid UTF-8")
  }
}
