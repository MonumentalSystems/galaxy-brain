export const DOCUMENT_ANCHOR_SCHEMA_ID: "gb.anchor.v1"
export const MAX_ANCHOR_SELECTOR_BYTES: number
export const MAX_TEXT_QUOTE_CHARS: number
export const MAX_TEXT_CONTEXT_CHARS: number

export type PageRegionSelector = {
  kind: "page-region"
  page: number
  coordinateSpace: "normalized-page"
  polygon: number[]
  quoteHash?: string
}
export type TextQuoteSelector = {
  kind: "text-quote"
  exact: string
  prefix?: string
  suffix?: string
  page?: number
}
export type JsonPointerSelector = { kind: "json-pointer"; pointer: `/blocks/${number}` }
export type DocumentAnchorSelector = PageRegionSelector | TextQuoteSelector | JsonPointerSelector

export type AnchorableRepresentation = {
  id: string
  kind: "original" | "document-structure" | "markdown" | "text"
  media_type?: string
  mediaType?: string
  content_sha256?: string
  contentSha256?: string
  content?: unknown
  page_count?: number
  pageCount?: number
}

export type DocumentAnchor = {
  schemaId: "gb.anchor.v1"
  id: `sha256:${string}`
  representationId: string
  representationSha256: string
  selector: DocumentAnchorSelector
  selectorSha256: string
  anchorSha256: string
}

export class DocumentAnchorContractError extends Error {}
export function canonicalAnchorJson(value: unknown): string
export function isDocumentAnchorTextMediaType(value: unknown): boolean
export function validateDocumentAnchorSelector(selector: unknown, representation: unknown): DocumentAnchorSelector
export function createDocumentAnchor(representation: unknown, selector: unknown): DocumentAnchor
export function documentAnchorRequestHash(representation: unknown, selector: unknown): string
