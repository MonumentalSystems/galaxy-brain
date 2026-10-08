import type {
  DurableDocumentAnchor,
  DurableDocumentRevision,
} from "./paper-reader-client"
import type { TextQuoteSelector } from "./document-anchor.js"
import type { DurableTransformReceipt, GalaxyDocumentStructure } from "./ingestion-contract.js"
import type { ReaderRepresentation } from "./paper-reader.js"

export const MAX_EXACT_TEXT_DOCUMENT_BYTES: number
export const MAX_EXACT_TEXT_SELECTION_CHARS: 16000
export const MAX_EXACT_TEXT_SELECTOR_BYTES: 32768

export class ExactTextDocumentError extends Error {}

export type ExactTextDocumentDescriptor = Readonly<{
  artifactId: string
  byteSize: number
  contentSha256: string
  contentUrl: string
  documentId: string
  documentRef: string
  displayFilename: string
  markdown: boolean
  mediaType: string
  representationId: string
  representationRef: string
  revisionId: string
  revisionSha256: string
  title: string
}>

export function isExactTextDocumentMediaType(value: unknown): boolean
export function isExactMarkdownMediaType(value: unknown): boolean
export function isExactHtmlDocumentDescriptor(value: unknown): boolean
export function shouldAcceptExactHtmlDerivedCompletion(
  completion: { generation: number; revisionId: string } | null | undefined,
  current: { generation: number; revisionId: string } | null | undefined,
): boolean
export type ExactHtmlDerivedState = Readonly<{
  structure: (ReaderRepresentation & { kind: "document-structure"; content: GalaxyDocumentStructure }) | null
  markdown: (ReaderRepresentation & { kind: "markdown"; content: string }) | null
  receipt: DurableTransformReceipt | null
  primaryReceipt: DurableTransformReceipt | null
  fallbackReceipt: DurableTransformReceipt | null
}>
export function selectExactHtmlDerivedState(
  descriptor: ExactTextDocumentDescriptor,
  representations: unknown,
  receipts: unknown,
): ExactHtmlDerivedState
export function exactTextDocumentAnchorSearch(search: string, anchorId: string | null): string
export function exactTextDocumentDescriptor(
  value: DurableDocumentRevision,
  expectedRevisionId: string,
): ExactTextDocumentDescriptor
export function loadExactTextDocument(
  descriptor: ExactTextDocumentDescriptor,
  options?: {
    fetcher?: typeof fetch
    signal?: AbortSignal
    origin?: string
    digest?: (bytes: Uint8Array) => Promise<string>
  },
): Promise<string>
export function exactTextQuoteForSelection(source: string, selection: string): TextQuoteSelector
export function validateExactTextAnchorResponse(
  value: unknown,
  descriptor: ExactTextDocumentDescriptor,
  selector: TextQuoteSelector,
  options?: { digest?: (bytes: Uint8Array) => Promise<string> },
): Promise<Readonly<DurableDocumentAnchor>>
