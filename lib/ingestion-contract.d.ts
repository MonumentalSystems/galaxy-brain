export const DOCUMENT_TRANSFORM_SCHEMA_ID: "galaxy.document-transform.v1"
import type { DocumentLocalIndexStatus } from "./document-local-index.js"

export {
  DOCUMENT_IMPORT_SCHEMA_ID,
  IngestionContractError,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_METADATA_BYTES,
  MAX_IMPORT_METADATA_HEADER_CHARS,
  encodeDurableImportMetadata,
  prepareDurableDocumentImport,
} from "./durable-document-import.js"
export type {
  DurableDocumentImport,
  DurableDocumentImportMetadata,
  PreparedDurableDocumentImport,
} from "./durable-document-import.js"
export const DOCUMENT_STRUCTURE_SCHEMA_ID: "gb.document-structure.v1"
export const MAX_TRANSFORM_FILE_BYTES: number
export const MAX_TRANSFORM_MARKDOWN_CHARS: number

export type FileSource = {
  filename: string
  mediaType: string
  byteSize: number
  sha256: string
}


export type GalaxyDocumentBlock = {
  id: string
  kind: string
  order: number
  text: string | null
  latex: string | null
  page: number | null
  region: Record<string, unknown> | null
}

export type GalaxyDocumentStructure = {
  schemaId: "gb.document-structure.v1"
  pages: unknown[]
  blocks: GalaxyDocumentBlock[]
  readingOrder: string[]
}

export type DurableDocumentRepresentation = {
  id: string
  kind: "original" | "document-structure" | "markdown" | "text" | "thumbnail"
  media_type: string
  content_sha256: string
  artifact_id: string | null
  content: GalaxyDocumentStructure | string | null
  created_at: string
}

export type DurableTransformReceipt = {
  id: string
  plugin_id: "docling" | "markitdown" | "plain-text"
  plugin_version: string
  engine: string
  engine_version: string
  config_sha256: string
  input_sha256: string
  output_sha256: string | null
  status: "success" | "partial" | "fallback" | "failed" | "skipped"
  diagnostic_code: string | null
  output_manifest: Record<string, unknown>
  fallback_receipt_id: string | null
  created_at: string
}

export type DurableDocumentTransform = {
  schemaId: "gb.document.transform.v1"
  persisted: true
  document_revision_id: string
  representations: DurableDocumentRepresentation[]
  local_index?: DocumentLocalIndexStatus
  receipt: DurableTransformReceipt
  fallbackReceipt: DurableTransformReceipt | null
  replayed: boolean
  error?: string
}

export type MarkdownFallbackResult = {
  schemaId: "galaxy.document-transform.v1"
  persisted: false
  source: { kind: "file" } & FileSource
  document: { structure: null; markdown: string }
  transform: {
    pluginId: "markitdown"
    capability: "transform"
    representation: "markdown"
    fidelity: "flat"
  }
}

export type PlainTextResult = {
  schemaId: "galaxy.document-transform.v1"
  persisted: false
  source: { kind: "file" } & FileSource
  document: { structure: null; markdown: string }
  transform: {
    pluginId: "plain-text"
    capability: "transform"
    representation: "markdown"
    fidelity: "verbatim"
  }
}

export function isPlainTextFilename(filename: unknown): boolean
export function canTransformFilename(filename: unknown): boolean
export function validateFileSource(source: unknown): FileSource
export function createMarkdownFallbackResult(source: unknown, markdown: unknown): MarkdownFallbackResult
export function createPlainTextResult(source: unknown, bytes: unknown): PlainTextResult
