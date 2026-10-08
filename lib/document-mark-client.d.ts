export const DOCUMENT_MARK_MAX_BODY_BYTES: 65536
export const DOCUMENT_MARK_MAX_RESPONSE_BYTES: 131072
export const DOCUMENT_MARK_MAX_TEXT_QUOTE_CHARACTERS: 16000
export const DOCUMENT_MARK_LIST_LIMIT: 1000
export const DOCUMENT_MARK_LIST_MAX_RESPONSE_BYTES: number

export type DocumentMarkTextQuoteSelector = Readonly<{
  kind: "text-quote"
  exact: string
  prefix?: string
  suffix?: string
  page?: number
}>

export type DocumentMarkPageRegionSelector = Readonly<{
  kind: "page-region"
  page: number
  coordinateSpace: "normalized-page"
  polygon: readonly [number, number, number, number, number, number, number, number]
  quoteHash?: string
}>

export type DocumentMarkAnchor = Readonly<{
  schemaId: "gb.anchor.v1"
  id: `sha256:${string}`
  ref: string
  document_revision_id: string
  representation_id: string
  representation_sha256: string
  selector: DocumentMarkTextQuoteSelector | DocumentMarkPageRegionSelector
  selector_kind: "text-quote" | "page-region"
  selector_sha256: string
  anchor_sha256: string
}>

export type DocumentMarkCreateIntent = Readonly<{
  schemaId: "gb.document-mark-create.intent.v1"
  anchor: DocumentMarkAnchor
  requestedAt: string
  kind: "highlight" | "note"
  bodyMarkdown: string
  color: string
  semanticRole: "evidence" | "note"
  tags: readonly string[]
  state: "active"
  idempotencyKey: string
  requestBody: string
}>

export type DurableDocumentMark = Readonly<{
  schemaId: "gb.document-mark.v1"
  id: string
  ref: string
  document_revision_id: string
  anchor_id: `sha256:${string}`
  anchor_ref: string
  kind: "highlight" | "note"
  version: 1
  revision_id: string
  content_hash: string
  body_markdown: string
  color: string
  semantic_role: "evidence" | "note"
  tags: readonly string[]
  state: "active"
  created_by_principal_id: string
  created_at: string
  updated_at: string
  replayed: boolean
}>

export type DurableDocumentMarkSnapshot = Readonly<{
  schemaId: "gb.document-mark.v1"
  id: string
  ref: string
  document_revision_id: string
  anchor_id: `sha256:${string}`
  anchor_ref: string
  kind: "highlight" | "note" | "ink"
  version: number
  revision_id: string
  content_hash: string
  body_markdown: string
  color: string
  semantic_role: "note" | "claim" | "evidence" | "question"
  tags: readonly string[]
  state: "active" | "resolved"
  created_by_principal_id: string
  created_at: string
  updated_at: string
}>

export type DocumentMarkList = Readonly<{
  schemaId: "gb.document-mark.list.v1"
  document_revision_id: string
  anchor_id: `sha256:${string}`
  marks: readonly DurableDocumentMarkSnapshot[]
  completeness: "complete" | "possibly-incomplete"
}>

export type DocumentMarkRecoveryScope = Readonly<{
  tenantId: string
  principalId: string
  documentRevisionId: string
}>

export type DocumentMarkRecovery = Readonly<DocumentMarkRecoveryScope & {
  schemaId: "gb.document-mark-recovery.v1"
  intent: DocumentMarkCreateIntent
}>

export type DocumentMarkRecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> & Partial<Pick<Storage, "key" | "length">>

export class DocumentMarkClientError extends Error {
  readonly code: string
  readonly ambiguous: boolean
  readonly status: number | null
}

export function prepareDocumentMarkCreateIntent(
  value: {
    anchor: DocumentMarkAnchor | Record<string, unknown>
    requestedAt: string
    kind: "highlight" | "note"
    bodyMarkdown: string
    color: string
    semanticRole: "evidence" | "note"
    tags: readonly string[]
    state: "active"
  },
  options: { idempotencyKey: string },
): DocumentMarkCreateIntent
export function parseDocumentMarkCreateIntent(value: unknown): DocumentMarkCreateIntent
export function validateDurableDocumentMark(
  value: unknown,
  expected: { intent: DocumentMarkCreateIntent; principalId: string },
): DurableDocumentMark
export function validateDurableDocumentMarkSnapshot(
  value: unknown,
  expected: { documentRevisionId: string; anchorId: string; anchorRef: string },
): DurableDocumentMarkSnapshot
export function parseDocumentMarkList(
  value: unknown,
  expected: { documentRevisionId: string; anchorId: string; anchorRef: string },
): DocumentMarkList
export function listDocumentMarks(
  anchor: Pick<DocumentMarkAnchor, "id" | "ref" | "document_revision_id">,
  options?: { fetcher?: typeof fetch; signal?: AbortSignal; origin?: string },
): Promise<DocumentMarkList>
export function createDocumentMark(
  intent: DocumentMarkCreateIntent,
  options: { principalId: string; fetcher?: typeof fetch; signal?: AbortSignal },
): Promise<DurableDocumentMark>
export function documentMarkRecoveryStorageKey(scope: DocumentMarkRecoveryScope, operationKey: string): string
export function writeDocumentMarkRecovery(
  storage: DocumentMarkRecoveryStorage,
  scope: DocumentMarkRecoveryScope,
  intent: DocumentMarkCreateIntent,
): DocumentMarkRecovery
export function readDocumentMarkRecoveries(
  storage: DocumentMarkRecoveryStorage & Required<Pick<Storage, "key" | "length">>,
  scope: DocumentMarkRecoveryScope,
): readonly DocumentMarkRecovery[]
export function removeDocumentMarkRecovery(
  storage: DocumentMarkRecoveryStorage,
  scope: DocumentMarkRecoveryScope,
  operationKey: string,
): void
export function createDocumentMarkRecoverably(
  intent: DocumentMarkCreateIntent,
  options: {
    scope: DocumentMarkRecoveryScope
    storage: DocumentMarkRecoveryStorage
    fetcher?: typeof fetch
    signal?: AbortSignal
  },
): Promise<DurableDocumentMark>
