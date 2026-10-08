import { DOCX_MEDIA_TYPE, MAX_DOCX_BYTES } from "./docx-document-contract.js"
import { createGalaxyObjectReference } from "./galaxy-object-reference.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

export class ExactDocxDocumentError extends Error {}

function string(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || Array.from(value).length > maximum || CONTROL.test(value)) {
    throw new ExactDocxDocumentError(`${label} is invalid`)
  }
  return value
}

function uuid(value, label) {
  const normalized = string(value, 36, label).toLowerCase()
  if (normalized !== value || !UUID.test(value)) throw new ExactDocxDocumentError(`${label} is invalid`)
  return value
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new ExactDocxDocumentError(`${label} is invalid`)
  return value
}

export function isExactDocxMediaType(value) {
  return typeof value === "string" && value.trim().toLowerCase() === DOCX_MEDIA_TYPE
}

export function exactDocxDocumentDescriptor(value, expectedRevisionId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaId !== "gb.document-revision.v1") {
    throw new ExactDocxDocumentError("DOCX revision is invalid")
  }
  const revisionId = uuid(value.revision_id, "DOCX revision identifier")
  if (revisionId !== uuid(expectedRevisionId, "Requested DOCX revision identifier")) {
    throw new ExactDocxDocumentError("Galaxy Brain returned a stale DOCX revision")
  }
  const documentId = uuid(value.document_id, "DOCX document identifier")
  const revisionSha256 = sha256(value.revision_sha256, "DOCX revision hash")
  const documentRef = createGalaxyObjectReference("document", documentId, {
    mode: "pinned", revision: `sha256:${revisionSha256}`,
  })
  if (value.ref !== documentRef) throw new ExactDocxDocumentError("DOCX reference does not match its exact revision")
  if (!value.artifact || typeof value.artifact !== "object" || Array.isArray(value.artifact)) {
    throw new ExactDocxDocumentError("DOCX artifact is invalid")
  }
  const artifactId = uuid(value.artifact.id, "DOCX artifact identifier")
  const contentSha256 = sha256(value.artifact.content_sha256, "DOCX content hash")
  if (value.artifact.media_type !== DOCX_MEDIA_TYPE) throw new ExactDocxDocumentError("DOCX media type is invalid")
  if (!Number.isSafeInteger(value.artifact.byte_size) || value.artifact.byte_size < 1
    || value.artifact.byte_size > MAX_DOCX_BYTES) throw new ExactDocxDocumentError("DOCX exceeds the exact reader limit")
  if (!Array.isArray(value.representations) || value.representations.length < 1 || value.representations.length > 32) {
    throw new ExactDocxDocumentError("DOCX representations are invalid")
  }
  const originals = value.representations.filter((item) => item?.kind === "original")
  if (originals.length !== 1) throw new ExactDocxDocumentError("DOCX must have exactly one original representation")
  const original = originals[0]
  const representationId = uuid(original.id, "DOCX original representation identifier")
  if (original.media_type !== DOCX_MEDIA_TYPE
    || sha256(original.content_sha256, "DOCX original representation hash") !== contentSha256) {
    throw new ExactDocxDocumentError("DOCX original representation does not match its artifact")
  }
  const expectedContentPath = `/documents/${revisionId}/representations/${representationId}/content`
  if (original.content_path !== expectedContentPath) throw new ExactDocxDocumentError("DOCX content path is invalid")
  const displayFilename = string(value.display_filename, 512, "DOCX display filename")
  const originalFilename = string(value.source?.original_filename, 512, "DOCX original filename")
  if (!displayFilename.toLowerCase().endsWith(".docx") || !originalFilename.toLowerCase().endsWith(".docx")) {
    throw new ExactDocxDocumentError("DOCX filename is invalid")
  }
  const contentUrl = `/api/eln${expectedContentPath}?${new URLSearchParams({
    document_id: documentId, revision_sha256: revisionSha256,
  })}`
  return Object.freeze({
    artifactId,
    byteSize: value.artifact.byte_size,
    contentSha256,
    contentUrl,
    documentId,
    documentRef,
    displayFilename,
    mediaType: DOCX_MEDIA_TYPE,
    originalFilename,
    representationId,
    representationRef: `gb:representation:document:${encodeURIComponent(documentId)}:${encodeURIComponent(representationId)}`,
    revisionId,
    revisionSha256,
    title: string(value.title, 500, "DOCX title"),
  })
}
