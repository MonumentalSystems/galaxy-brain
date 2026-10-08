import type {
  DurableDocumentRepresentation,
  DurableDocumentTransform,
} from "./ingestion-contract.js"

export const DOCUMENT_TRANSFORM_RESPONSE_SCHEMA: "gb.document.transform.v1"
export const DOCUMENT_TRANSFORM_OPERATION_SCHEMA: "gb.document-transform-operation.v1"

export class DocumentTransformClientError extends Error {
  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; retryable?: boolean; status?: number },
  )
  code: string
  retryable: boolean
  status: number | null
}

export type RunningDocumentTransform = {
  schemaId: "gb.document.transform.v1"
  persisted: true
  document_revision_id: string
  status: "running"
  replayed: boolean
  retryAfterMs?: number
  pollingExhausted?: true
}

export type FinalDocumentTransform = Omit<DurableDocumentTransform, "representations"> & {
  representations: DurableDocumentRepresentation[]
}

export type DocumentTransformResult = RunningDocumentTransform | FinalDocumentTransform

export type TransformStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export type DocumentTransformClientOptions = {
  fetcher?: typeof fetch
  storage?: TransformStorage
  createIdempotencyKey?: () => string
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  endpointBase?: string
  maxPolls?: number
}

export type DocumentTransformRequestOptions = {
  scope?: string
  signal?: AbortSignal
  reprocess?: boolean
}

export function validateDocumentTransformResponse(
  value: unknown,
  expectedRevisionId: string,
): DocumentTransformResult

export function retryAfterMilliseconds(value: string | null | undefined, now?: number): number

export function createDocumentTransformClient(options?: DocumentTransformClientOptions): {
  transform(documentRevisionId: string, options?: DocumentTransformRequestOptions): Promise<DocumentTransformResult>
}
