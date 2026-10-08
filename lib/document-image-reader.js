import { createGalaxyObjectReference, parseGalaxyObjectReference } from "./galaxy-object-reference.js"
import {
  MAX_RASTER_IMAGE_BYTES,
  normalizeRasterImageManifest,
  rasterImageTypeForMediaType,
} from "./raster-image-contract.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

export class ExactImageDocumentError extends Error {}

function exactText(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1
    || Array.from(value).length > maximum || CONTROL.test(value)) {
    throw new ExactImageDocumentError(`${label} is invalid`)
  }
  return value
}

function exactUuid(value, label) {
  const normalized = exactText(value, 36, label).toLowerCase()
  if (normalized !== value || !UUID.test(normalized)) throw new ExactImageDocumentError(`${label} is invalid`)
  return normalized
}

function exactSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ExactImageDocumentError(`${label} is invalid`)
  }
  return value
}

export function isExactRasterImageMediaType(value) {
  return rasterImageTypeForMediaType(value) !== null
}

/** Bind one immutable revision to its one authoritative original image. */
export function exactImageDocumentDescriptor(value, expectedRevisionId) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaId !== "gb.document-revision.v1") {
    throw new ExactImageDocumentError("Document revision is invalid")
  }
  const revisionId = exactUuid(value.revision_id, "Document revision identifier")
  if (revisionId !== exactUuid(expectedRevisionId, "Requested document revision identifier")) {
    throw new ExactImageDocumentError("Galaxy Brain returned a stale document revision")
  }
  const documentId = exactUuid(value.document_id, "Document identifier")
  const revisionSha256 = exactSha256(value.revision_sha256, "Document revision hash")
  const documentRef = createGalaxyObjectReference("document", documentId, {
    mode: "pinned",
    revision: `sha256:${revisionSha256}`,
  })
  if (value.ref !== documentRef) {
    throw new ExactImageDocumentError("Document reference does not match its exact revision")
  }
  if (!value.artifact || typeof value.artifact !== "object" || Array.isArray(value.artifact)) {
    throw new ExactImageDocumentError("Document artifact is invalid")
  }
  const artifactId = exactUuid(value.artifact.id, "Document artifact identifier")
  const contentSha256 = exactSha256(value.artifact.content_sha256, "Document content hash")
  const mediaType = exactText(value.artifact.media_type, 160, "Document media type")
  if (!isExactRasterImageMediaType(mediaType)) {
    throw new ExactImageDocumentError("Document media type is not a supported raster image")
  }
  if (!Number.isSafeInteger(value.artifact.byte_size)
    || value.artifact.byte_size < 1 || value.artifact.byte_size > MAX_RASTER_IMAGE_BYTES) {
    throw new ExactImageDocumentError("Raster image exceeds the exact reader limit")
  }
  let rasterImage
  try {
    rasterImage = normalizeRasterImageManifest(value.raster_image, {
      mediaType,
      byteSize: value.artifact.byte_size,
      contentSha256,
    })
  } catch (error) {
    throw new ExactImageDocumentError(error instanceof Error ? error.message : "Raster image manifest is invalid")
  }
  if (!Array.isArray(value.representations) || value.representations.length < 1 || value.representations.length > 32) {
    throw new ExactImageDocumentError("Document representations are invalid")
  }
  const originals = value.representations.filter((item) => item?.kind === "original")
  if (originals.length !== 1) throw new ExactImageDocumentError("Document must have exactly one original representation")
  const original = originals[0]
  const representationId = exactUuid(original.id, "Original representation identifier")
  if (original.media_type !== mediaType
    || exactSha256(original.content_sha256, "Original representation hash") !== contentSha256) {
    throw new ExactImageDocumentError("Original representation does not match the document artifact")
  }
  const expectedPath = `/documents/${revisionId}/representations/${representationId}/content`
  if (original.content_path !== expectedPath) {
    throw new ExactImageDocumentError("Original representation content path is invalid")
  }
  return Object.freeze({
    artifactId,
    byteSize: value.artifact.byte_size,
    contentSha256,
    contentUrl: `/api/eln${expectedPath}?${new URLSearchParams({
      document_id: documentId,
      revision_sha256: revisionSha256,
    })}`,
    displayFilename: exactText(value.display_filename, 512, "Document display filename"),
    documentId,
    documentRef,
    mediaType,
    rasterImage,
    representationId,
    representationRef: `gb:representation:document:${encodeURIComponent(documentId)}:${encodeURIComponent(representationId)}`,
    revisionId,
    revisionSha256,
    title: exactText(value.title, 500, "Document title"),
  })
}

/** Build the same exact-byte handle from a recovered, authorized card projection. */
export function exactImageProjectionDescriptor(value, authorizedRevisionId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.kind !== "document") {
    throw new ExactImageDocumentError("Image projection is invalid")
  }
  const parsed = parseGalaxyObjectReference(value.ref)
  const revisionSelector = value.revision?.id
  if (!parsed || parsed.format !== "canonical" || parsed.kind !== "document"
    || parsed.selector.mode !== "pinned" || revisionSelector !== parsed.selector.revision
    || typeof revisionSelector !== "string" || !revisionSelector.startsWith("sha256:")) {
    throw new ExactImageDocumentError("Image projection is not pinned to an exact document revision")
  }
  const documentId = exactUuid(parsed.id, "Document identifier")
  const revisionSha256 = exactSha256(revisionSelector.slice(7), "Document revision hash")
  if (value.revision.contentHash !== revisionSha256) {
    throw new ExactImageDocumentError("Image projection revision hash is invalid")
  }
  const revisionId = exactUuid(authorizedRevisionId, "Authorized document revision identifier")
  let rasterImage
  try {
    rasterImage = normalizeRasterImageManifest(value.rasterImage, { mediaType: value.mediaType })
  } catch (error) {
    throw new ExactImageDocumentError(error instanceof Error ? error.message : "Raster image manifest is invalid")
  }
  const originals = Array.isArray(value.representations)
    ? value.representations.filter((item) => item?.kind === "original")
    : []
  if (originals.length !== 1 || originals[0].mediaType !== rasterImage.mediaType
    || originals[0].contentHash !== rasterImage.contentSha256) {
    throw new ExactImageDocumentError("Image projection original representation is invalid")
  }
  const prefix = `gb:representation:document:${encodeURIComponent(documentId)}:`
  if (typeof originals[0].ref !== "string" || !originals[0].ref.startsWith(prefix)) {
    throw new ExactImageDocumentError("Image projection representation reference is invalid")
  }
  let representationId
  try {
    representationId = exactUuid(decodeURIComponent(originals[0].ref.slice(prefix.length)), "Representation identifier")
  } catch (error) {
    if (error instanceof ExactImageDocumentError) throw error
    throw new ExactImageDocumentError("Image projection representation reference is invalid")
  }
  const path = `/documents/${revisionId}/representations/${representationId}/content`
  return Object.freeze({
    artifactId: "projection",
    byteSize: rasterImage.byteSize,
    contentSha256: rasterImage.contentSha256,
    contentUrl: `/api/eln${path}?${new URLSearchParams({ document_id: documentId, revision_sha256: revisionSha256 })}`,
    displayFilename: value.title,
    documentId,
    documentRef: value.ref,
    mediaType: rasterImage.mediaType,
    rasterImage,
    representationId,
    representationRef: originals[0].ref,
    revisionId,
    revisionSha256,
    title: exactText(value.title, 240, "Image title"),
  })
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function defaultDigest(bytes) {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer)))
}

async function readBoundedBytes(stream) {
  const reader = stream.getReader()
  const chunks = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array)) throw new ExactImageDocumentError("Exact image response is invalid")
      received += value.byteLength
      if (received > MAX_RASTER_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ExactImageDocumentError("Exact image response exceeds the reader limit")
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

function defaultDecodeImage(url, signal) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", aborted)
      image.onload = null
      image.onerror = null
      callback(value)
    }
    const aborted = () => finish(reject, new DOMException("Image load aborted", "AbortError"))
    image.decoding = "async"
    image.onload = () => finish(resolve, { width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => finish(reject, new ExactImageDocumentError("Exact image bytes could not be decoded"))
    signal?.addEventListener("abort", aborted, { once: true })
    image.src = url
    if (signal?.aborted) aborted()
  })
}

/** Fetch, hash, decode, and dimension-check one same-origin immutable image Blob URL. */
export async function loadExactImageObjectUrl(descriptor, options = {}) {
  const fetcher = options.fetcher ?? globalThis.fetch
  const digest = options.digest ?? defaultDigest
  const createObjectURL = options.createObjectURL ?? globalThis.URL?.createObjectURL?.bind(globalThis.URL)
  const revokeObjectURL = options.revokeObjectURL ?? globalThis.URL?.revokeObjectURL?.bind(globalThis.URL)
  const decodeImage = options.decodeImage ?? defaultDecodeImage
  if (typeof fetcher !== "function" || typeof digest !== "function"
    || typeof createObjectURL !== "function" || typeof revokeObjectURL !== "function"
    || typeof decodeImage !== "function") {
    throw new ExactImageDocumentError("Exact image transport is unavailable")
  }
  const response = await fetcher(descriptor.contentUrl, {
    cache: "no-store",
    redirect: "error",
    signal: options.signal,
    headers: { Accept: descriptor.mediaType },
  })
  if (!response || response.redirected === true || !response.ok) {
    await response?.body?.cancel?.().catch(() => undefined)
    throw new ExactImageDocumentError("Exact image content is unavailable")
  }
  if (response.url) {
    const origin = options.origin ?? globalThis.location?.origin
    if (!origin) throw new ExactImageDocumentError("Exact image origin is unavailable")
    const actual = new URL(response.url, origin)
    const expected = new URL(descriptor.contentUrl, origin)
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search !== expected.search) {
      await response.body?.cancel?.().catch(() => undefined)
      throw new ExactImageDocumentError("Exact image response was redirected")
    }
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  const declaredHash = response.headers.get("x-content-sha256")
  const etag = response.headers.get("etag")
  const declaredLength = response.headers.get("content-length")
  if (mediaType !== descriptor.mediaType || declaredHash !== descriptor.contentSha256
    || etag !== `"sha256-${descriptor.contentSha256}"`
    || (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) !== descriptor.byteSize))
    || !response.body) {
    await response.body?.cancel?.().catch(() => undefined)
    throw new ExactImageDocumentError("Exact image response does not match its representation")
  }
  const bytes = await readBoundedBytes(response.body)
  if (bytes.byteLength !== descriptor.byteSize || await digest(bytes) !== descriptor.contentSha256) {
    throw new ExactImageDocumentError("Exact image bytes do not match their content hash")
  }
  const url = createObjectURL(new Blob([bytes], { type: descriptor.mediaType }))
  let revoked = false
  const revoke = () => {
    if (revoked) return
    revoked = true
    revokeObjectURL(url)
  }
  try {
    const dimensions = await decodeImage(url, options.signal)
    if (dimensions?.width !== descriptor.rasterImage.width
      || dimensions?.height !== descriptor.rasterImage.height) {
      throw new ExactImageDocumentError("Exact image dimensions do not match the trusted manifest")
    }
    return Object.freeze({ url, revoke, width: dimensions.width, height: dimensions.height })
  } catch (error) {
    revoke()
    if (error instanceof ExactImageDocumentError || error?.name === "AbortError") throw error
    throw new ExactImageDocumentError("Exact image bytes could not be decoded")
  }
}
