import type { DurableDocumentImport, DurableDocumentImportMetadata } from "./durable-document-import.js"

export const WEB_CAPTURE_RESULT_SCHEMA_ID: "gb.web-capture.result.v1"
export const WEB_CAPTURE_PLAN_ID: "web.capture-default"

export type WebCapture = Readonly<{
  url: string
  title: string
  format: "html" | "markdown" | "text"
  content: string
  selection: string
  tags: readonly string[]
  note: string
  region: Readonly<{ cssSelector: string; xpath: string; tagName: string; label: string }> | null
  source: string
  capturedAt: string | null
}>

export function executeWebCaptureIngestion(
  request: Readonly<{ capture: WebCapture; idempotencyKey: string }>,
  ports: Readonly<{
    persistOriginal(input: Readonly<{
      bytes: Uint8Array
      mediaType: string
      filename: string
      metadata: DurableDocumentImportMetadata
      idempotencyKey: string
    }>): Promise<unknown>
    transformDocument(revisionId: string, options: Readonly<{ scope: string; signal?: AbortSignal }>): Promise<unknown>
    mirrorCapture?(capture: WebCapture): Promise<{ id?: string | null } | null>
  }>,
): Promise<Readonly<{
  schemaId: "gb.web-capture.result.v1"
  id: string | null
  title: string
  url: string
  capturedAt: string | null
  document: DurableDocumentImport
  ingestion: Readonly<{ status: string; plan: unknown; derivation: unknown }>
  transform: unknown | null
  hamMirror: Readonly<{ status: "not-configured" | "mirrored" | "unavailable"; id?: string | null }>
}>>
