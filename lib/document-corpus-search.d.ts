export const DOCUMENT_CORPUS_SEARCH_SCHEMA_ID: "gb.document-corpus-search.v1"
export const DOCUMENT_CORPUS_SEARCH_DEFAULT_LIMIT: 8
export const DOCUMENT_CORPUS_SEARCH_MAX_LIMIT: 20
export const DOCUMENT_CORPUS_SEARCH_MAX_QUERY_CHARACTERS: 500
export const DOCUMENT_CORPUS_SEARCH_MAX_QUERY_BYTES: 2048
export const DOCUMENT_CORPUS_SEARCH_MAX_RESPONSE_BYTES: 65536
export const DOCUMENT_CORPUS_SEARCH_MAX_SNIPPET_CHARACTERS: 320

export type DocumentCorpusSearchRequest = Readonly<{
  query: string
  limit: number
}>

export type DocumentCorpusSearchSelector =
  | Readonly<{ kind: "json-pointer"; pointer: `/blocks/${number}` }>
  | Readonly<{
      kind: "text-position"
      unit: "unicode-code-point"
      start: number
      end: number
      overlap: number
    }>

type DocumentCorpusSearchItemIdentity = Readonly<{
  documentRef: string
  documentId: string
  documentRevisionId: string
  revisionSha256: string
  title: string
  displayFilename: string
  snippet: string
}>

type DocumentCorpusSearchSource = Readonly<{
  manifestId: `sha256:${string}`
  representationId: string
  representationSha256: string
  representationKind: "document-structure" | "markdown" | "text"
}>

export type DocumentCorpusSearchItem = DocumentCorpusSearchItemIdentity & Readonly<{
  matchSource: "content"
  source: DocumentCorpusSearchSource & Readonly<{
    chunkContentSha256: string
    selector: DocumentCorpusSearchSelector
  }>
}>

export type DocumentCorpusSearchResponse = Readonly<{
  schemaId: "gb.document-corpus-search.v1"
  query: string
  items: readonly DocumentCorpusSearchItem[]
  continuation: Readonly<{ hasMore: boolean }>
}>

export function createDocumentCorpusSearchRequest(value: {
  query: string
  limit?: number
}): DocumentCorpusSearchRequest
export function parseDocumentCorpusSearchResponse(
  value: unknown,
  request: { query: string; limit?: number },
): DocumentCorpusSearchResponse
export function readDocumentCorpusSearchResponse(
  response: Response,
  request: { query: string; limit?: number },
): Promise<DocumentCorpusSearchResponse>
