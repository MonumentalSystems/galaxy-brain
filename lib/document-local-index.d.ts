export const DOCUMENT_LOCAL_INDEX_STATUS_SCHEMA: "gb.document-local-index-status.v1"

export type DocumentLocalIndexStatus =
  | {
      readonly schemaId: "gb.document-local-index-status.v1"
      readonly status: "not-built"
    }
  | {
      readonly schemaId: "gb.document-local-index-status.v1"
      readonly status: "ready"
      readonly chunk_count: number
      readonly chunks_sha256: string
      readonly source: {
        readonly manifest_id: string
        readonly representation_id: string
        readonly representation_sha256: string
        readonly representation_kind: "document-structure" | "markdown" | "text"
        readonly chunker: string
        readonly chunker_version: string
        readonly chunker_config_sha256: string
      }
    }

export function parseDocumentLocalIndexStatus(value: unknown): DocumentLocalIndexStatus | undefined
