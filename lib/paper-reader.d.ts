import type { DocumentAnchorSelector } from "./document-anchor.js"

export const PAPER_READER_LOCATION_SCHEMA: "gb.paper-reader-location.v1"

export type ReaderRepresentation = {
  id: string
  kind: "original" | "document-structure" | "markdown" | "text"
  media_type: string
  content_sha256: string
  artifact_id?: string | null
  content: unknown
  page_count?: number | null
  pageCount?: number | null
  created_at?: string
  content_url?: string | null
}

export type PaperReaderLocation = {
  schemaId: "gb.paper-reader-location.v1"
  view: "pdf" | "structure" | "markdown"
  page: number
  anchorId: string | null
}

export function rectangleToPageRegion(
  page: number,
  region: { x: number; y: number; width: number; height: number },
): Extract<DocumentAnchorSelector, { kind: "page-region" }>
export function pageCountForStructure(representation: unknown): number
export function chooseReaderRepresentations(representations: unknown): {
  original: ReaderRepresentation | null
  structure: ReaderRepresentation | null
  markdown: ReaderRepresentation | null
  text: ReaderRepresentation | null
}
export function chooseReaderRepresentationState(representations: unknown, receipts: unknown): {
  original: ReaderRepresentation | null
  structure: ReaderRepresentation | null
  markdown: ReaderRepresentation | null
  text: ReaderRepresentation | null
  receipt: import("./ingestion-contract.js").DurableTransformReceipt | null
  primaryReceipt: import("./ingestion-contract.js").DurableTransformReceipt | null
}
export function textQuoteAnchorForSelection(
  representations: unknown,
  exact: string,
  page: number,
): {
  representation: ReaderRepresentation
  selector: Extract<DocumentAnchorSelector, { kind: "text-quote" }>
}
export function projectExactTextQuote(
  pages: unknown,
  selector: unknown,
): { pageNumber: number; quote: string; startOffset: number; endOffset: number } | null
export function projectExactPageRegion(
  selector: unknown,
): { pageNumber: number; x: number; y: number; width: number; height: number } | null
export function shouldAcceptPaperMarkCompletion(
  completion: { generation: number; selectionGeneration: number; documentRevisionId: string },
  current: { generation: number; selectionGeneration: number; documentRevisionId: string },
  options?: { requireSelection?: boolean },
): boolean
export function shouldCommitPaperAnchorCompletion(
  expectedSelectionGeneration: number | undefined,
  currentSelectionGeneration: number,
): boolean
export function parsePaperReaderLocation(search: string): PaperReaderLocation
export function paperReaderSearch(search: string, state: Omit<PaperReaderLocation, "schemaId">): string
export function validateReaderDocumentIdentity(value: unknown): { documentRevisionId: string; title: string }
