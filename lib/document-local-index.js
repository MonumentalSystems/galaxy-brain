export const DOCUMENT_LOCAL_INDEX_STATUS_SCHEMA = "gb.document-local-index-status.v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/u
const CONTENT_ID = /^sha256:[0-9a-f]{64}$/u
const KINDS = new Set(["document-structure", "markdown", "text"])

function exactKeys(value, expected) {
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key))
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

export function parseDocumentLocalIndexStatus(value) {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Document local index status is invalid")
  }
  if (value.schemaId !== DOCUMENT_LOCAL_INDEX_STATUS_SCHEMA) {
    throw new TypeError("Document local index status schema is invalid")
  }
  if (value.status === "not-built") {
    if (!exactKeys(value, new Set(["schemaId", "status"]))) {
      throw new TypeError("Document local index status is invalid")
    }
    return Object.freeze({ schemaId: DOCUMENT_LOCAL_INDEX_STATUS_SCHEMA, status: "not-built" })
  }
  if (value.status !== "ready" || !exactKeys(
    value,
    new Set(["schemaId", "status", "chunk_count", "chunks_sha256", "source"]),
  )) {
    throw new TypeError("Document local index status is invalid")
  }
  if (!Number.isSafeInteger(value.chunk_count) || value.chunk_count < 0 || value.chunk_count > 100_000) {
    throw new TypeError("Document local index chunk count is invalid")
  }
  if (typeof value.chunks_sha256 !== "string" || !SHA256.test(value.chunks_sha256)) {
    throw new TypeError("Document local index digest is invalid")
  }
  const source = value.source
  if (!source || typeof source !== "object" || Array.isArray(source) || !exactKeys(
    source,
    new Set([
      "manifest_id", "representation_id", "representation_sha256", "representation_kind",
      "chunker", "chunker_version", "chunker_config_sha256",
    ]),
  )) {
    throw new TypeError("Document local index source is invalid")
  }
  if (
    typeof source.manifest_id !== "string" || !CONTENT_ID.test(source.manifest_id)
    || typeof source.representation_id !== "string" || !UUID.test(source.representation_id)
    || typeof source.representation_sha256 !== "string" || !SHA256.test(source.representation_sha256)
    || !KINDS.has(source.representation_kind)
    || !boundedText(source.chunker, 100)
    || !boundedText(source.chunker_version, 100)
    || typeof source.chunker_config_sha256 !== "string" || !SHA256.test(source.chunker_config_sha256)
  ) {
    throw new TypeError("Document local index source is invalid")
  }
  return Object.freeze({
    schemaId: DOCUMENT_LOCAL_INDEX_STATUS_SCHEMA,
    status: "ready",
    chunk_count: value.chunk_count,
    chunks_sha256: value.chunks_sha256,
    source: Object.freeze({ ...source, representation_id: source.representation_id.toLowerCase() }),
  })
}
