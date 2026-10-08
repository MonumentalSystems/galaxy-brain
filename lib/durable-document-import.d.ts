export const DOCUMENT_IMPORT_SCHEMA_ID: "gb.document.import.v1"
export const MAX_IMPORT_FILE_BYTES: number
export const MAX_IMPORT_METADATA_BYTES: number
export const MAX_IMPORT_METADATA_HEADER_CHARS: number
export { DOCX_MEDIA_TYPE, MAX_DOCX_BYTES } from "./docx-document-contract.js"

export class IngestionContractError extends Error {}
export function durableUploadMediaType(file: Pick<File, "name" | "type">, bytes: ArrayBuffer): string

export type DurableDocumentImportMetadata = {
  title: string
  filename: string
  sourceKind?: "upload" | "url" | "arxiv" | "legacy-paper" | "datasource"
  sourceUri?: string | null
  arxivId?: string | null
  captureIntentSha256?: string
  ingestionPlan?: Readonly<{ id: string; version: string; contentSha256: string }>
}

export type DurableIngestionPlanEvidence = Readonly<{
  schemaId: "gb.ingestion-plan.v1"
  id: string
  version: string
  owner: Readonly<{ pluginId: string; pluginVersion: string }>
  implementationId: string
  source: Readonly<{ contributionId: string; implementationId: string }>
  persist: Readonly<{ routeId: string; implementationId: string; originalRequired: true }>
  transformPolicy: Readonly<{
    implementationId: string
    transforms: readonly Readonly<{ contributionId: string; implementationId: string }>[]
  }>
  output: Readonly<{ kind: "document"; revisionPolicy: "pinned" }>
  contentSha256: string
}>

export type DurableDocumentImport = {
  schemaId: "gb.document.import.v1"
  persisted: true
  ref: string
  document_id: string
  revision_id: string
  artifact_id: string
  source_id: string
  title: string
  display_filename: string
  version: number
  content_sha256: string
  revision_sha256: string
  byte_size: number
  media_type: string
  source_kind: "upload" | "url" | "arxiv" | "legacy-paper" | "datasource"
  original_filename: string | null
  source_uri: string | null
  ingestion_plan: DurableIngestionPlanEvidence | null
  replayed: boolean
  deduplicatedArtifact: boolean
}

export type PreparedDurableDocumentImport = {
  bytes: ArrayBuffer
  contentSha256: string
  mediaType: string
  idempotencyKey: string
  metadataHeader: string
  placementOperationId: string
}

export function encodeDurableImportMetadata(value: DurableDocumentImportMetadata): string
export function createDocumentImportIdempotencyKey(operationHash: string): string
export function prepareDurableDocumentImport(
  file: Pick<Blob, "arrayBuffer" | "size" | "type">,
  metadata: DurableDocumentImportMetadata,
): Promise<Readonly<PreparedDurableDocumentImport>>
export function validateDurableDocumentImport(
  value: unknown,
  expected?: { ingestionPlan?: unknown },
): Readonly<DurableDocumentImport>
export function deriveImportedDocumentReference(value: unknown): string
