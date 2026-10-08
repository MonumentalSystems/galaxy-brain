import { createGalaxyObjectReference, parseGalaxyObjectReference } from "./galaxy-object-reference.js"
import {
  AUDIO_ORIGINAL_MEDIA_TYPE,
  MAX_AUDIO_ORIGINAL_BYTES,
  normalizeAudioOriginalManifest,
} from "./audio-original-contract.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

export class ExactAudioDocumentError extends Error {}

function exactText(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || Array.from(value).length > maximum || CONTROL.test(value)) {
    throw new ExactAudioDocumentError(`${label} is invalid`)
  }
  return value
}

function exactUuid(value, label) {
  const normalized = exactText(value, 36, label).toLowerCase()
  if (normalized !== value || !UUID.test(normalized)) throw new ExactAudioDocumentError(`${label} is invalid`)
  return normalized
}

function exactSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new ExactAudioDocumentError(`${label} is invalid`)
  return value
}

function originalRepresentation(value, mediaType, contentSha256) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new ExactAudioDocumentError("Document representations are invalid")
  }
  const originals = value.filter((item) => item?.kind === "original")
  if (originals.length !== 1 || originals[0].media_type !== mediaType
    || exactSha256(originals[0].content_sha256, "Original representation hash") !== contentSha256) {
    throw new ExactAudioDocumentError("Original representation does not match the audio artifact")
  }
  return originals[0]
}

export function isExactAudioOriginalMediaType(value) {
  return typeof value === "string" && value.split(";", 1)[0].trim().toLowerCase() === AUDIO_ORIGINAL_MEDIA_TYPE
}

export function exactAudioDocumentDescriptor(value, expectedRevisionId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaId !== "gb.document-revision.v1") {
    throw new ExactAudioDocumentError("Document revision is invalid")
  }
  const revisionId = exactUuid(value.revision_id, "Document revision identifier")
  if (revisionId !== exactUuid(expectedRevisionId, "Requested document revision identifier")) {
    throw new ExactAudioDocumentError("Galaxy Brain returned a stale document revision")
  }
  const documentId = exactUuid(value.document_id, "Document identifier")
  const revisionSha256 = exactSha256(value.revision_sha256, "Document revision hash")
  const documentRef = createGalaxyObjectReference("document", documentId, {
    mode: "pinned", revision: `sha256:${revisionSha256}`,
  })
  if (value.ref !== documentRef) throw new ExactAudioDocumentError("Document reference does not match its exact revision")
  if (!value.artifact || typeof value.artifact !== "object" || Array.isArray(value.artifact)) {
    throw new ExactAudioDocumentError("Document artifact is invalid")
  }
  const artifactId = exactUuid(value.artifact.id, "Document artifact identifier")
  const contentSha256 = exactSha256(value.artifact.content_sha256, "Document content hash")
  if (!isExactAudioOriginalMediaType(value.artifact.media_type)) {
    throw new ExactAudioDocumentError("Document media type is not WebM/Opus audio")
  }
  if (!Number.isSafeInteger(value.artifact.byte_size)
    || value.artifact.byte_size < 1 || value.artifact.byte_size > MAX_AUDIO_ORIGINAL_BYTES) {
    throw new ExactAudioDocumentError("Audio original exceeds the exact reader limit")
  }
  let audioOriginal
  try {
    audioOriginal = normalizeAudioOriginalManifest(value.audio_original, {
      mediaType: value.artifact.media_type,
      byteSize: value.artifact.byte_size,
      contentSha256,
    })
  } catch (error) {
    throw new ExactAudioDocumentError(error instanceof Error ? error.message : "Audio original manifest is invalid")
  }
  const original = originalRepresentation(value.representations, AUDIO_ORIGINAL_MEDIA_TYPE, contentSha256)
  const representationId = exactUuid(original.id, "Original representation identifier")
  const expectedPath = `/documents/${revisionId}/representations/${representationId}/content`
  if (original.content_path !== expectedPath) {
    throw new ExactAudioDocumentError("Original representation content path is invalid")
  }
  return Object.freeze({
    artifactId,
    audioOriginal,
    byteSize: value.artifact.byte_size,
    contentSha256,
    contentUrl: `/api/eln${expectedPath}?${new URLSearchParams({ document_id: documentId, revision_sha256: revisionSha256 })}`,
    displayFilename: exactText(value.display_filename, 512, "Document display filename"),
    documentId,
    documentRef,
    mediaType: AUDIO_ORIGINAL_MEDIA_TYPE,
    representationId,
    representationRef: `gb:representation:document:${encodeURIComponent(documentId)}:${encodeURIComponent(representationId)}`,
    revisionId,
    revisionSha256,
    title: exactText(value.title, 500, "Document title"),
  })
}

export function exactAudioProjectionDescriptor(value, authorizedRevisionId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.kind !== "document") {
    throw new ExactAudioDocumentError("Audio projection is invalid")
  }
  const parsed = parseGalaxyObjectReference(value.ref)
  const selector = value.revision?.id
  if (!parsed || parsed.format !== "canonical" || parsed.kind !== "document"
    || parsed.selector.mode !== "pinned" || selector !== parsed.selector.revision
    || typeof selector !== "string" || !selector.startsWith("sha256:")) {
    throw new ExactAudioDocumentError("Audio projection is not pinned to an exact document revision")
  }
  const documentId = exactUuid(parsed.id, "Document identifier")
  const revisionSha256 = exactSha256(selector.slice(7), "Document revision hash")
  if (value.revision.contentHash !== revisionSha256) throw new ExactAudioDocumentError("Audio projection revision hash is invalid")
  const revisionId = exactUuid(authorizedRevisionId, "Authorized document revision identifier")
  let audioOriginal
  try {
    audioOriginal = normalizeAudioOriginalManifest(value.audioOriginal, { mediaType: value.mediaType })
  } catch (error) {
    throw new ExactAudioDocumentError(error instanceof Error ? error.message : "Audio projection manifest is invalid")
  }
  const originals = Array.isArray(value.representations)
    ? value.representations.filter((item) => item?.kind === "original") : []
  if (originals.length !== 1 || originals[0].mediaType !== audioOriginal.mediaType
    || originals[0].contentHash !== audioOriginal.contentSha256) {
    throw new ExactAudioDocumentError("Audio projection original representation is invalid")
  }
  const prefix = `gb:representation:document:${encodeURIComponent(documentId)}:`
  if (typeof originals[0].ref !== "string" || !originals[0].ref.startsWith(prefix)) {
    throw new ExactAudioDocumentError("Audio projection representation reference is invalid")
  }
  let representationId
  try {
    representationId = exactUuid(decodeURIComponent(originals[0].ref.slice(prefix.length)), "Representation identifier")
  } catch (error) {
    if (error instanceof ExactAudioDocumentError) throw error
    throw new ExactAudioDocumentError("Audio projection representation reference is invalid")
  }
  const path = `/documents/${revisionId}/representations/${representationId}/content`
  return Object.freeze({
    artifactId: "projection",
    audioOriginal,
    byteSize: audioOriginal.byteSize,
    contentSha256: audioOriginal.contentSha256,
    contentUrl: `/api/eln${path}?${new URLSearchParams({ document_id: documentId, revision_sha256: revisionSha256 })}`,
    displayFilename: exactText(value.title, 240, "Audio title"),
    documentId,
    documentRef: value.ref,
    mediaType: AUDIO_ORIGINAL_MEDIA_TYPE,
    representationId,
    representationRef: originals[0].ref,
    revisionId,
    revisionSha256,
    title: exactText(value.title, 240, "Audio title"),
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
      if (!(value instanceof Uint8Array)) throw new ExactAudioDocumentError("Exact audio response is invalid")
      received += value.byteLength
      if (received > MAX_AUDIO_ORIGINAL_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ExactAudioDocumentError("Exact audio response exceeds the reader limit")
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

/** Fetch and verify immutable authenticated audio before exposing a local Blob URL. */
export async function loadExactAudioObjectUrl(descriptor, options = {}) {
  const fetcher = options.fetcher ?? globalThis.fetch
  const digest = options.digest ?? defaultDigest
  const createObjectURL = options.createObjectURL ?? globalThis.URL?.createObjectURL?.bind(globalThis.URL)
  const revokeObjectURL = options.revokeObjectURL ?? globalThis.URL?.revokeObjectURL?.bind(globalThis.URL)
  if (typeof fetcher !== "function" || typeof digest !== "function"
    || typeof createObjectURL !== "function" || typeof revokeObjectURL !== "function") {
    throw new ExactAudioDocumentError("Exact audio transport is unavailable")
  }
  const response = await fetcher(descriptor.contentUrl, {
    cache: "no-store", redirect: "error", signal: options.signal,
    headers: { Accept: AUDIO_ORIGINAL_MEDIA_TYPE },
  })
  if (!response || response.redirected === true || response.status !== 200) {
    await response?.body?.cancel?.().catch(() => undefined)
    throw new ExactAudioDocumentError("Exact audio content is unavailable")
  }
  const origin = options.origin ?? globalThis.location?.origin
  if (!origin) {
    await response.body?.cancel?.().catch(() => undefined)
    throw new ExactAudioDocumentError("Exact audio origin is unavailable")
  }
  if (response.url) {
    const actual = new URL(response.url, origin)
    const expected = new URL(descriptor.contentUrl, origin)
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search !== expected.search) {
      await response.body?.cancel?.().catch(() => undefined)
      throw new ExactAudioDocumentError("Exact audio response was redirected")
    }
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  const declaredLength = response.headers.get("content-length")
  if (mediaType !== AUDIO_ORIGINAL_MEDIA_TYPE
    || response.headers.get("x-content-sha256") !== descriptor.contentSha256
    || response.headers.get("etag") !== `"sha256-${descriptor.contentSha256}"`
    || (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) !== descriptor.byteSize))
    || !response.body) {
    await response.body?.cancel?.().catch(() => undefined)
    throw new ExactAudioDocumentError("Exact audio response does not match its representation")
  }
  const bytes = await readBoundedBytes(response.body)
  if (options.signal?.aborted) throw new ExactAudioDocumentError("Exact audio request was cancelled")
  const contentSha256 = await digest(bytes)
  if (options.signal?.aborted) throw new ExactAudioDocumentError("Exact audio request was cancelled")
  if (bytes.byteLength !== descriptor.byteSize || contentSha256 !== descriptor.contentSha256) {
    throw new ExactAudioDocumentError("Exact audio bytes do not match their content hash")
  }
  const url = createObjectURL(new Blob([bytes], { type: AUDIO_ORIGINAL_MEDIA_TYPE }))
  let revoked = false
  return Object.freeze({
    url,
    revoke() {
      if (revoked) return
      revoked = true
      revokeObjectURL(url)
    },
  })
}
