import { parseGalaxyObjectReference } from "./galaxy-object-reference.js"
import {
  ExactTextDocumentError,
  isExactMarkdownMediaType,
  isExactTextDocumentMediaType,
} from "./document-text-reader.js"
import { projectDocumentStructure } from "./document-structure-projector.js"

export const MAX_ATLAS_EXACT_REPRESENTATION_BYTES = 2 * 1024 * 1024
export const MAX_ATLAS_EXACT_REPRESENTATION_CACHE_BYTES = 4 * 1024 * 1024
export const MAX_ATLAS_EXACT_REPRESENTATION_CACHE_ENTRIES = 8
export const MAX_ATLAS_EXACT_REPRESENTATION_IN_FLIGHT = 4
export const MAX_ATLAS_EXACT_REPRESENTATION_QUEUED = 16

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/u
const cache = new Map()
let cacheBytes = 0
let activeLoads = 0
const queuedLoads = []
const pendingLoads = new Map()
const DOCUMENT_STRUCTURE_MEDIA_TYPE = "application/vnd.galaxy.document-structure+json"

export class AtlasExactRepresentationError extends ExactTextDocumentError {}

function exactUuid(value, label) {
  if (typeof value !== "string" || value !== value.toLowerCase() || !UUID.test(value)) {
    throw new AtlasExactRepresentationError(`${label} is invalid`)
  }
  return value
}

function exactSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new AtlasExactRepresentationError(`${label} is invalid`)
  }
  return value
}

function exactMediaType(value) {
  if (typeof value !== "string") {
    throw new AtlasExactRepresentationError("Representation media type is invalid")
  }
  const normalized = value.trim().toLowerCase().replace(/;\s*/gu, "; ")
  if (!MEDIA_TYPE.test(normalized)) {
    throw new AtlasExactRepresentationError("Representation media type is invalid")
  }
  const [essence, ...parameters] = normalized.split(";").map((item) => item.trim())
  if (parameters.length > 1 || (parameters.length === 1 && parameters[0] !== "charset=utf-8")) {
    throw new AtlasExactRepresentationError("Representation media type parameters are unsupported")
  }
  return parameters.length === 1 ? `${essence}; charset=utf-8` : essence
}

function mediaTypeEssence(value) {
  return value.split(";", 1)[0].trim()
}

function representationId(ref, documentId) {
  const prefix = `gb:representation:document:${encodeURIComponent(documentId)}:`
  if (typeof ref !== "string" || !ref.startsWith(prefix)) {
    throw new AtlasExactRepresentationError("Representation reference is invalid")
  }
  try {
    return exactUuid(decodeURIComponent(ref.slice(prefix.length)), "Representation identifier")
  } catch (error) {
    if (error instanceof AtlasExactRepresentationError) throw error
    throw new AtlasExactRepresentationError("Representation reference is invalid")
  }
}

function representationRank(item) {
  const essence = typeof item?.mediaType === "string" ? mediaTypeEssence(item.mediaType.trim().toLowerCase()) : ""
  if (item.kind === "structure" && essence === DOCUMENT_STRUCTURE_MEDIA_TYPE) return 0
  if (item.kind === "markdown" && isExactMarkdownMediaType(essence)) return 1
  if (item.kind === "text" && isExactTextDocumentMediaType(essence)) return 2
  if (item.kind === "original" && isExactTextDocumentMediaType(essence)) return 3
  return Number.POSITIVE_INFINITY
}

export function parseAtlasExactStructure(content) {
  try {
    const structure = JSON.parse(content)
    projectDocumentStructure(structure, { maxBlocks: 20_000 })
    return structure
  } catch {
    return null
  }
}

/**
 * Choose one immutable, renderable body from an already-authorized document
 * projection. Normalized structure/Markdown/text wins over the original so
 * Atlas can show derived bodies without treating chunks as canonical objects.
 */
export function atlasExactRepresentationDescriptor(projection, authorizedRevisionId) {
  if (!projection || typeof projection !== "object" || Array.isArray(projection) || projection.kind !== "document") {
    return null
  }
  const parsed = parseGalaxyObjectReference(projection.ref)
  const revision = projection.revision?.id
  if (!parsed || parsed.format !== "canonical" || parsed.kind !== "document"
    || parsed.selector.mode !== "pinned" || parsed.selector.revision !== revision
    || typeof revision !== "string" || !revision.startsWith("sha256:")) {
    throw new AtlasExactRepresentationError("Document projection is not pinned to an exact revision")
  }
  const documentId = exactUuid(parsed.id, "Document identifier")
  const revisionSha256 = exactSha256(revision.slice(7), "Document revision hash")
  if (projection.revision?.contentHash !== revisionSha256) {
    throw new AtlasExactRepresentationError("Document projection revision hash is invalid")
  }
  const revisionId = exactUuid(authorizedRevisionId, "Authorized document revision identifier")
  if (!Array.isArray(projection.representations) || projection.representations.length > 32) {
    throw new AtlasExactRepresentationError("Document representations are invalid")
  }
  const candidates = projection.representations
    .map((item, index) => ({ item, index, rank: representationRank(item) }))
    .filter((candidate) => Number.isFinite(candidate.rank))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
  if (candidates.length === 0) return null

  const preferredRank = candidates[0].rank
  if (candidates.filter((candidate) => candidate.rank === preferredRank).length !== 1) {
    throw new AtlasExactRepresentationError("Document projection has ambiguous current body representations")
  }

  const selected = candidates[0].item
  const mediaType = exactMediaType(selected.mediaType)
  const essence = mediaTypeEssence(mediaType)
  const contentSha256 = exactSha256(selected.contentHash, "Representation hash")
  const selectedRepresentationId = representationId(selected.ref, documentId)
  const contentUrl = `/api/eln/documents/${encodeURIComponent(revisionId)}/representations/${encodeURIComponent(selectedRepresentationId)}/content?${new URLSearchParams({
    document_id: documentId,
    revision_sha256: revisionSha256,
  })}`
  const identity = [
    projection.ref,
    revisionId,
    selected.ref,
    contentSha256,
    mediaType,
  ].join("\u0000")
  return Object.freeze({
    contentSha256,
    contentUrl,
    documentId,
    documentRef: projection.ref,
    identity,
    kind: selected.kind,
    markdown: isExactMarkdownMediaType(essence),
    mediaType,
    representationId: selectedRepresentationId,
    representationRef: selected.ref,
    revisionId,
    revisionSha256,
  })
}

function scopedCacheIdentity(scope, identity) {
  if (typeof scope !== "string" || scope.length < 1 || scope.length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(scope)) {
    throw new AtlasExactRepresentationError("Exact representation authorization scope is invalid")
  }
  return `${scope}\u0000${identity}`
}

function cacheGet(identity) {
  const found = cache.get(identity)
  if (!found) return null
  cache.delete(identity)
  cache.set(identity, found)
  return found.content
}

function cacheSet(identity, content, byteSize) {
  const previous = cache.get(identity)
  if (previous) {
    cacheBytes -= previous.byteSize
    cache.delete(identity)
  }
  if (byteSize > MAX_ATLAS_EXACT_REPRESENTATION_CACHE_BYTES) return
  cache.set(identity, Object.freeze({ content, byteSize }))
  cacheBytes += byteSize
  while (
    cache.size > MAX_ATLAS_EXACT_REPRESENTATION_CACHE_ENTRIES
    || cacheBytes > MAX_ATLAS_EXACT_REPRESENTATION_CACHE_BYTES
  ) {
    const oldest = cache.entries().next().value
    if (!oldest) break
    cache.delete(oldest[0])
    cacheBytes -= oldest[1].byteSize
  }
}

export function clearAtlasExactRepresentationCache(scope) {
  if (scope === undefined) {
    for (const entry of pendingLoads.values()) entry.controller.abort()
    pendingLoads.clear()
    cache.clear()
    cacheBytes = 0
    return
  }
  const prefix = scopedCacheIdentity(scope, "")
  for (const [identity, entry] of pendingLoads) {
    if (!identity.startsWith(prefix)) continue
    entry.controller.abort()
    pendingLoads.delete(identity)
  }
  for (const [identity, entry] of cache) {
    if (!identity.startsWith(prefix)) continue
    cache.delete(identity)
    cacheBytes -= entry.byteSize
  }
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function defaultDigest(bytes) {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer)))
}

function aborted(signal) {
  if (signal?.aborted) throw new DOMException("Exact representation request aborted", "AbortError")
}

function releaseLoadSlot() {
  activeLoads -= 1
  while (queuedLoads.length > 0) {
    const next = queuedLoads.shift()
    if (next.start()) return
  }
}

function acquireLoadSlot(signal) {
  aborted(signal)
  if (activeLoads < MAX_ATLAS_EXACT_REPRESENTATION_IN_FLIGHT) {
    activeLoads += 1
    return Promise.resolve(releaseLoadSlot)
  }
  if (queuedLoads.length >= MAX_ATLAS_EXACT_REPRESENTATION_QUEUED) {
    throw new AtlasExactRepresentationError("Exact representation request capacity is exhausted")
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const entry = {
      start() {
        if (settled) return false
        settled = true
        signal?.removeEventListener("abort", onAbort)
        activeLoads += 1
        resolve(releaseLoadSlot)
        return true
      },
    }
    function onAbort() {
      if (settled) return
      settled = true
      const index = queuedLoads.indexOf(entry)
      if (index >= 0) queuedLoads.splice(index, 1)
      reject(new DOMException("Exact representation request aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    queuedLoads.push(entry)
  })
}

async function withLoadSlot(signal, action) {
  const release = await acquireLoadSlot(signal)
  try {
    return await action()
  } finally {
    release()
  }
}

function subscribeCoalescedLoad(identity, signal, action) {
  aborted(signal)
  let entry = pendingLoads.get(identity)
  if (!entry) {
    const controller = new AbortController()
    entry = { controller, subscribers: 0, settled: false, promise: null }
    entry.promise = Promise.resolve()
      .then(() => action(controller.signal))
      .finally(() => {
        entry.settled = true
        if (pendingLoads.get(identity) === entry) pendingLoads.delete(identity)
      })
    pendingLoads.set(identity, entry)
  }
  entry.subscribers += 1
  return new Promise((resolve, reject) => {
    let finished = false
    function finish() {
      if (finished) return false
      finished = true
      signal?.removeEventListener("abort", onAbort)
      entry.subscribers -= 1
      if (entry.subscribers === 0 && !entry.settled) entry.controller.abort()
      return true
    }
    function onAbort() {
      if (finish()) reject(new DOMException("Exact representation request aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    entry.promise.then(
      (value) => { if (finish()) resolve(value) },
      (error) => { if (finish()) reject(error) },
    )
  })
}

async function readBoundedBytes(stream, declaredLength, signal) {
  const reader = stream.getReader()
  const chunks = []
  let received = 0
  try {
    for (;;) {
      aborted(signal)
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined)
        throw new AtlasExactRepresentationError("Exact representation response is invalid")
      }
      received += value.byteLength
      if (received > declaredLength || received > MAX_ATLAS_EXACT_REPRESENTATION_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new AtlasExactRepresentationError("Exact representation response exceeds its declared size")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (received !== declaredLength) {
    throw new AtlasExactRepresentationError("Exact representation response size is invalid")
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Fetch, bound, hash, and transiently cache one exact authorized body. */
export async function loadAtlasExactRepresentation(descriptor, options = {}) {
  aborted(options.signal)
  const cacheIdentity = options.authorizationScope
    ? scopedCacheIdentity(options.authorizationScope, descriptor.identity)
    : null
  const cached = cacheIdentity ? cacheGet(cacheIdentity) : null
  if (cached !== null) return cached
  const execute = (signal) => withLoadSlot(signal, async () => {
  const cachedAfterWait = cacheIdentity ? cacheGet(cacheIdentity) : null
  if (cachedAfterWait !== null) return cachedAfterWait
  const fetcher = options.fetcher ?? globalThis.fetch
  const digest = options.digest ?? defaultDigest
  if (typeof fetcher !== "function" || typeof digest !== "function") {
    throw new AtlasExactRepresentationError("Exact representation transport is unavailable")
  }
  const response = await fetcher(descriptor.contentUrl, {
    cache: "no-store",
    redirect: "error",
    signal,
    headers: { Accept: descriptor.mediaType },
  })
  if (!response || response.redirected === true || response.status !== 200) {
    await response?.body?.cancel?.().catch(() => undefined)
    throw new AtlasExactRepresentationError("Exact representation content is unavailable")
  }
  const origin = options.origin ?? globalThis.location?.origin
  if (response.url) {
    if (!origin) {
      await response.body?.cancel?.().catch(() => undefined)
      throw new AtlasExactRepresentationError("Exact representation origin is unavailable")
    }
    const actual = new URL(response.url, origin)
    const expected = new URL(descriptor.contentUrl, origin)
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search !== expected.search) {
      await response.body?.cancel?.().catch(() => undefined)
      throw new AtlasExactRepresentationError("Exact representation response was redirected")
    }
  }
  const rawMediaType = response.headers.get("content-type")
  let mediaType = null
  try {
    mediaType = exactMediaType(rawMediaType)
  } catch {
    // The shared mismatch path below cancels the body before failing closed.
  }
  const declaredLength = response.headers.get("content-length")
  const byteSize = declaredLength && /^\d+$/u.test(declaredLength) ? Number(declaredLength) : 0
  if (mediaType !== descriptor.mediaType
    || response.headers.get("x-content-sha256") !== descriptor.contentSha256
    || response.headers.get("etag") !== `"sha256-${descriptor.contentSha256}"`
    || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_ATLAS_EXACT_REPRESENTATION_BYTES
    || !response.body) {
    await response.body?.cancel?.().catch(() => undefined)
    throw new AtlasExactRepresentationError("Exact representation response does not match its identity")
  }
  const bytes = await readBoundedBytes(response.body, byteSize, signal)
  aborted(signal)
  if (await digest(bytes) !== descriptor.contentSha256) {
    throw new AtlasExactRepresentationError("Exact representation bytes do not match their content hash")
  }
  aborted(signal)
  let content
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new AtlasExactRepresentationError("Exact representation content is not valid UTF-8")
  }
  if (cacheIdentity) cacheSet(cacheIdentity, content, byteSize)
  return content
  })
  return cacheIdentity
    ? subscribeCoalescedLoad(cacheIdentity, options.signal, execute)
    : execute(options.signal)
}

export function loadAtlasExactRepresentationIfEligible(descriptor, options = {}) {
  if (options.eligible !== true) return Promise.resolve(null)
  const { eligible, ...loadOptions } = options
  void eligible
  return loadAtlasExactRepresentation(descriptor, loadOptions)
}
