import { resolveObjectProjectionReferences } from "./atlas-object-hydration.js"
import {
  CODE_GRAPH_SNAPSHOT_MEDIA_TYPE,
  MAX_CODE_GRAPH_SNAPSHOT_BYTES,
  normalizeCodeGraphSnapshotReview,
} from "./code-graph-snapshot-import.js"
import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "./galaxy-object-reference.js"

const SHA256 = /^[a-f0-9]{64}$/u
const SHA256_REVISION = /^sha256:[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const REPRESENTATION_PREFIX = "gb:representation:document:"
const CODE_OBJECT_KINDS = new Set(["code.graph", "code.repo", "code.file", "code.symbol"])
const WORKER_ERROR_CODES = Object.freeze({
  "over-cap": Object.freeze({ code: "worker-over-cap", message: "The exact snapshot exceeds the interactive graph bound." }),
  "invalid-snapshot": Object.freeze({ code: "worker-invalid", message: "The exact snapshot is not a valid Codebase Memory graph." }),
  "selected-pin": Object.freeze({ code: "selection", message: "The selected code object is not available in this exact snapshot." }),
  "session-stale": Object.freeze({ code: "worker-session", message: "The exact snapshot worker session is no longer current." }),
  "invalid-request": Object.freeze({ code: "worker-invalid", message: "The exact snapshot worker rejected an invalid request." }),
})

export class CodeGraphSnapshotSourceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "CodeGraphSnapshotSourceError"
    this.code = code
  }
}

function fail(code, message) {
  throw new CodeGraphSnapshotSourceError(code, message)
}

function exactReference(value) {
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical" || parsed.kind !== "document"
    || parsed.selector.mode !== "pinned" || !SHA256_REVISION.test(parsed.selector.revision)) return null
  const serialized = serializeGalaxyObjectReference(parsed)
  return serialized === value ? parsed : null
}

export function validateCodeGraphLensReferences(sourceRef, selectedRef = null) {
  const source = sourceRef === null ? null : exactReference(sourceRef)
  const parsedSelection = selectedRef ? parseGalaxyObjectReference(selectedRef) : null
  const exactSelection = parsedSelection?.format === "canonical"
    && serializeGalaxyObjectReference(parsedSelection) === selectedRef
    ? parsedSelection
    : null
  const selectedCodeObject = Boolean(exactSelection && CODE_OBJECT_KINDS.has(exactSelection.kind))
  if (sourceRef !== null && !source) fail("source-reference", "codeSnapshot must be an exact pinned document reference.")
  if (!source && selectedCodeObject) {
    fail("selection", "A pinned code object requires one exact codeSnapshot source.")
  }
  if (source && selectedRef && (!selectedCodeObject || exactSelection.selector.mode !== "pinned")) {
    fail("selection", "The selected ref must be an exact pinned code object from this snapshot.")
  }
  return source ? Object.freeze({ sourceRef, selectedRef }) : null
}

function representationId(reference, documentId) {
  const prefix = `${REPRESENTATION_PREFIX}${encodeURIComponent(documentId)}:`
  if (typeof reference !== "string" || !reference.startsWith(prefix)) return null
  try {
    const encoded = reference.slice(prefix.length)
    const decoded = decodeURIComponent(encoded)
    return encoded && encodeURIComponent(decoded) === encoded && UUID.test(decoded) ? decoded : null
  } catch {
    return null
  }
}

export function codeGraphSnapshotDescriptorFromResolution(sourceRef, resolution) {
  const parsed = exactReference(sourceRef)
  if (!parsed) fail("source-reference", "codeSnapshot must be an exact pinned document reference.")
  if (!resolution || resolution.status !== "resolved" || resolution.requestedRef !== sourceRef
    || resolution.resolvedRef !== sourceRef || resolution.provider !== "galaxy.document"
    || !UUID.test(resolution.documentRevisionId || "")) {
    fail("authorization", "The exact code snapshot is unavailable or unauthorized.")
  }
  const projection = resolution.projection
  if (projection?.ref !== sourceRef || projection.kind !== "document"
    || projection.provenance?.provider !== "galaxy.document"
    || projection.revision?.policy !== "pinned"
    || projection.revision.id !== parsed.selector.revision
    || projection.mediaType !== CODE_GRAPH_SNAPSHOT_MEDIA_TYPE) {
    fail("projection", "The authorized document is not an exact JSON snapshot.")
  }
  const originals = projection.representations?.filter((item) => (
    item.kind === "original" && item.mediaType === CODE_GRAPH_SNAPSHOT_MEDIA_TYPE
  )) ?? []
  if (originals.length !== 1 || !SHA256.test(originals[0].contentHash || "")) {
    fail("projection", "The snapshot requires one exact application/json original representation.")
  }
  const selectedRepresentationId = representationId(originals[0].ref, parsed.id)
  if (!selectedRepresentationId) fail("projection", "The snapshot original representation is not addressable.")
  const query = new URLSearchParams({
    document_id: parsed.id,
    revision_sha256: parsed.selector.revision.slice("sha256:".length),
  })
  return Object.freeze({
    sourceRef,
    projection,
    revisionId: resolution.documentRevisionId,
    representationId: selectedRepresentationId,
    contentSha256: originals[0].contentHash,
    contentUrl: `/api/eln/documents/${encodeURIComponent(resolution.documentRevisionId)}/representations/${encodeURIComponent(selectedRepresentationId)}/content?${query}`,
  })
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")
}

async function readBoundedBody(response, signal) {
  if (!response.body) fail("body", "The exact snapshot response has no body.")
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Code snapshot request aborted", "AbortError")
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_CODE_GRAPH_SNAPSHOT_BYTES) {
        await reader.cancel().catch(() => undefined)
        fail("size", "The exact code snapshot exceeds the 32 MiB graph-lens bound.")
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
  return bytes
}

function exactResponseUrl(response, descriptor, baseUrl) {
  const base = baseUrl ?? globalThis.location?.href
  if (!base || typeof response.url !== "string" || !response.url) return false
  try {
    const expected = new URL(descriptor.contentUrl, base)
    const actual = new URL(response.url, base)
    return actual.origin === expected.origin
      && actual.pathname === expected.pathname
      && actual.search === expected.search
  } catch {
    return false
  }
}

export async function fetchExactCodeGraphSnapshot(descriptor, options = {}) {
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== "function") fail("fetch", "A fetch function is required.")
  const response = await fetcher(descriptor.contentUrl, {
    method: "GET",
    headers: { Accept: CODE_GRAPH_SNAPSHOT_MEDIA_TYPE },
    cache: "no-store",
    redirect: "error",
    signal: options.signal,
  })
  if (!response?.ok) {
    await response?.body?.cancel?.().catch(() => undefined)
    fail("fetch", "The exact code snapshot could not be loaded.")
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  const lengthHeader = response.headers.get("content-length")
  const declaredLength = lengthHeader === null ? null : Number(lengthHeader)
  const headerSha256 = response.headers.get("x-content-sha256")
  const etag = response.headers.get("etag")
  if (!exactResponseUrl(response, descriptor, options.baseUrl)
    || mediaType !== CODE_GRAPH_SNAPSHOT_MEDIA_TYPE
    || (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > MAX_CODE_GRAPH_SNAPSHOT_BYTES))
    || headerSha256 !== descriptor.contentSha256
    || etag !== `"sha256-${descriptor.contentSha256}"`) {
    await response.body?.cancel?.().catch(() => undefined)
    fail("headers", "The exact snapshot response failed its media, length, or digest contract.")
  }
  const bytes = await readBoundedBody(response, options.signal)
  const rawSha256 = await sha256Hex(bytes)
  if ((declaredLength !== null && bytes.byteLength !== declaredLength) || rawSha256 !== descriptor.contentSha256) {
    fail("integrity", "The exact snapshot bytes do not match their authorized digest and length.")
  }
  return Object.freeze({ bytes, rawSha256 })
}

export class CodeGraphSnapshotSessionClient {
  constructor(workerFactory, options = {}) {
    if (typeof workerFactory !== "function") throw new TypeError("A code graph worker factory is required")
    this.workerFactory = workerFactory
    this.resolve = options.resolve ?? resolveObjectProjectionReferences
    this.fetcher = options.fetcher ?? globalThis.fetch
    this.baseUrl = options.baseUrl
    this.worker = null
    this.sessionKey = null
    this.review = null
    this.activeSourceIdentity = null
    this.sessionIdentity = null
    this.descriptor = null
    this.rawSha256 = null
    this.nextId = 1
    this.pending = new Map()
    this.loadGeneration = 0
  }

  ensureWorker() {
    if (this.worker) return this.worker
    const worker = this.workerFactory()
    worker.addEventListener("message", (event) => {
      const pending = this.pending.get(event.data?.id)
      if (!pending) return
      this.pending.delete(event.data.id)
      if (event.data.ok) pending.resolve(event.data)
      else {
        const failure = WORKER_ERROR_CODES[event.data?.errorCode] ?? WORKER_ERROR_CODES["invalid-request"]
        pending.reject(new CodeGraphSnapshotSourceError(failure.code, failure.message))
      }
    })
    worker.addEventListener("error", () => {
      if (this.worker === worker) this.resetWorker("The code graph worker stopped unexpectedly.")
    })
    this.worker = worker
    return worker
  }

  resetWorker(message) {
    this.worker?.terminate()
    this.worker = null
    this.sessionKey = null
    this.review = null
    this.activeSourceIdentity = null
    this.sessionIdentity = null
    this.descriptor = null
    this.rawSha256 = null
    for (const pending of this.pending.values()) pending.reject(new CodeGraphSnapshotSourceError("worker", message))
    this.pending.clear()
  }

  request(message, transfer, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException("Code snapshot request aborted", "AbortError"))
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id)
        reject(new DOMException("Code snapshot request aborted", "AbortError"))
      }
      signal?.addEventListener("abort", abort, { once: true })
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value) },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error) },
      })
      try {
        worker.postMessage({ id, ...message }, transfer)
      } catch (error) {
        this.pending.delete(id)
        signal?.removeEventListener("abort", abort)
        reject(error)
      }
    })
  }

  async load({ tenantId, sourceRef, selectedRef = null, depth = 2, limit = 250, signal }) {
    const sourceIdentity = `${tenantId}\u0000${sourceRef}`
    if (this.activeSourceIdentity && this.activeSourceIdentity !== sourceIdentity) {
      this.resetWorker("The exact code snapshot source changed.")
    }
    this.activeSourceIdentity = sourceIdentity
    const generation = ++this.loadGeneration
    const assertCurrent = () => {
      if (generation !== this.loadGeneration || signal?.aborted) {
        throw new DOMException("Code snapshot request aborted", "AbortError")
      }
    }
    if (this.sessionIdentity === sourceIdentity && this.sessionKey && this.review && this.descriptor && this.rawSha256) {
      const result = await this.request({
        kind: "neighbors",
        key: this.sessionKey,
        reference: selectedRef,
        depth,
        limit,
      }, [], signal)
      assertCurrent()
      return Object.freeze({
        descriptor: this.descriptor,
        rawSha256: this.rawSha256,
        review: this.review,
        neighborhood: result.neighborhood,
      })
    }
    const resolved = await this.resolve([sourceRef], { signal })
    assertCurrent()
    const descriptor = codeGraphSnapshotDescriptorFromResolution(sourceRef, resolved.results?.[0])
    const exact = await fetchExactCodeGraphSnapshot(descriptor, {
      fetcher: this.fetcher,
      signal,
      baseUrl: this.baseUrl,
    })
    assertCurrent()
    const sessionKey = `${tenantId}\u0000${sourceRef}\u0000${exact.rawSha256}`
    let review
    if (this.sessionKey !== sessionKey) {
      if (this.sessionKey) {
        this.resetWorker("The exact code snapshot revision changed.")
        this.activeSourceIdentity = sourceIdentity
      }
      const transferable = exact.bytes.buffer.slice(exact.bytes.byteOffset, exact.bytes.byteOffset + exact.bytes.byteLength)
      const loaded = await this.request({
        kind: "load",
        key: sessionKey,
        bytes: transferable,
        tenantId,
        authorityScope: sourceRef,
      }, [transferable], signal)
      assertCurrent()
      review = normalizeCodeGraphSnapshotReview(loaded.review)
      if (review.contentSha256 !== exact.rawSha256) fail("worker", "The worker validated different snapshot bytes.")
      this.sessionKey = sessionKey
      this.review = review
      this.sessionIdentity = sourceIdentity
      this.descriptor = descriptor
      this.rawSha256 = exact.rawSha256
    }
    const result = await this.request({
      kind: "neighbors",
      key: sessionKey,
      reference: selectedRef,
      depth,
      limit,
    }, [], signal)
    assertCurrent()
    return Object.freeze({ descriptor, rawSha256: exact.rawSha256, review: review ?? this.review, neighborhood: result.neighborhood })
  }

  dispose() {
    this.resetWorker("The code graph session was closed.")
  }
}
