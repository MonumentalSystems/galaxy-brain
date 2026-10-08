import { createHash } from "node:crypto"

export {
  DOCUMENT_IMPORT_SCHEMA_ID,
  encodeDurableImportMetadata,
  IngestionContractError,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_METADATA_BYTES,
  MAX_IMPORT_METADATA_HEADER_CHARS,
  prepareDurableDocumentImport,
} from "./durable-document-import.js"
import { IngestionContractError } from "./durable-document-import.js"

/**
 * A transform result is a preview, not a stored Galaxy object. The original
 * bytes and their hash remain distinct from a lossy Markdown projection.
 * A future structure-sensitive parser can fill `document.structure` without
 * changing source identity or pretending MarkItDown recovered page geometry.
 */

export const DOCUMENT_TRANSFORM_SCHEMA_ID = "galaxy.document-transform.v1"
export const DOCUMENT_STRUCTURE_SCHEMA_ID = "gb.document-structure.v1"
export const MAX_TRANSFORM_FILE_BYTES = 25 * 1024 * 1024
export const MAX_TRANSFORM_MARKDOWN_CHARS = 8_000_000

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls",
  ".html", ".htm", ".csv", ".json", ".xml", ".epub", ".msg", ".eml",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".webp",
  ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".zip",
])
const PLAIN_TEXT_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"])

export function isPlainTextFilename(filename) {
  if (typeof filename !== "string") return false
  return PLAIN_TEXT_EXTENSIONS.has(filename.slice(filename.lastIndexOf(".")).toLowerCase())
}

export function canTransformFilename(filename) {
  if (typeof filename !== "string") return false
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase()
  return SUPPORTED_EXTENSIONS.has(extension) || PLAIN_TEXT_EXTENSIONS.has(extension)
}

export function validateFileSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new IngestionContractError("File source must be an object")
  }
  const { filename, mediaType, byteSize, sha256 } = source
  if (
    typeof filename !== "string" || filename.length === 0 || filename.length > 255 ||
    filename.includes("/") || filename.includes("\\") || /[\x00-\x1f\x7f]/.test(filename)
  ) {
    throw new IngestionContractError("Invalid file name")
  }
  if (!canTransformFilename(filename)) {
    throw new IngestionContractError("Unsupported file type")
  }
  if (typeof mediaType !== "string" || mediaType.length > 128 || /[\x00-\x1f\x7f]/.test(mediaType)) {
    throw new IngestionContractError("Invalid media type")
  }
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_TRANSFORM_FILE_BYTES) {
    throw new IngestionContractError("File size is outside the transform limit")
  }
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new IngestionContractError("Invalid source SHA-256")
  }
  return { filename, mediaType: mediaType || "application/octet-stream", byteSize, sha256 }
}

export function createMarkdownFallbackResult(source, markdown) {
  const file = validateFileSource(source)
  if (isPlainTextFilename(file.filename)) {
    throw new IngestionContractError("Plain-text files use the local transform")
  }
  if (typeof markdown !== "string" || markdown.length > MAX_TRANSFORM_MARKDOWN_CHARS) {
    throw new IngestionContractError("Invalid Markdown projection")
  }
  return {
    schemaId: DOCUMENT_TRANSFORM_SCHEMA_ID,
    persisted: false,
    source: { kind: "file", ...file },
    document: { structure: null, markdown },
    transform: {
      pluginId: "markitdown",
      capability: "transform",
      representation: "markdown",
      fidelity: "flat",
    },
  }
}

export function createPlainTextResult(source, bytes) {
  const file = validateFileSource(source)
  if (!isPlainTextFilename(file.filename) || !(bytes instanceof Uint8Array) || bytes.byteLength !== file.byteSize) {
    throw new IngestionContractError("Invalid plain-text source")
  }
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    throw new IngestionContractError("Plain-text source SHA-256 does not match bytes")
  }
  let markdown
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new IngestionContractError("Plain-text file must be valid UTF-8")
  }
  if (markdown.length > MAX_TRANSFORM_MARKDOWN_CHARS) {
    throw new IngestionContractError("Markdown projection exceeds the transform limit")
  }
  return {
    schemaId: DOCUMENT_TRANSFORM_SCHEMA_ID,
    persisted: false,
    source: { kind: "file", ...file },
    document: { structure: null, markdown },
    transform: {
      pluginId: "plain-text",
      capability: "transform",
      representation: "markdown",
      fidelity: "verbatim",
    },
  }
}
