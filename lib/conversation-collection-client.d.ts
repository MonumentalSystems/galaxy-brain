export const CONVERSATION_COLLECTION_LIMIT: 50
export const CONVERSATION_COLLECTION_MAX_ITEMS: 200
export const CONVERSATION_COLLECTION_MAX_PAGES: 4
export const CONVERSATION_COLLECTION_MAX_RESPONSE_BYTES: 1048576

export interface ConversationCollectionSummary {
  schemaId: "gb.conversation.summary.v1"
  conversationId: string
  workspaceId: string
  ref: string
  title: string
  goalSummary: string
  version: number
  contentHash: string
  turnCount: number
  artifactCount: number
  createdAt: string
  updatedAt: string
}

export interface ConversationCollectionPage {
  schemaId: "gb.conversation.collection.v1"
  snapshotAt: string
  scope: { tenantId: string; workspaceId: string | null }
  conversations: readonly ConversationCollectionSummary[]
  continuation: { limit: number; hasMore: boolean; cursor: string | null }
}

export interface ConversationCollectionState {
  snapshotAt: string
  scope: ConversationCollectionPage["scope"]
  conversations: readonly ConversationCollectionSummary[]
  continuation: ConversationCollectionPage["continuation"]
  pageCount: number
  capped: boolean
}

export interface ConversationCollectionExpectation {
  tenantId: string
  workspaceId?: string | null
  limit?: number
}

export function conversationCollectionPath(options?: {
  workspaceId?: string | null
  cursor?: string | null
  limit?: number
}): string
export function parseConversationCollection(
  value: unknown,
  expected: ConversationCollectionExpectation,
): ConversationCollectionPage
export function readConversationCollectionResponse(
  response: Response,
  expected: ConversationCollectionExpectation,
): Promise<ConversationCollectionPage>
export function startConversationCollection(page: ConversationCollectionPage): ConversationCollectionState
export function appendConversationCollectionPage(
  current: ConversationCollectionState,
  next: ConversationCollectionPage,
): ConversationCollectionState
export function conversationGraphHref(reference: string): string
export function acceptsConversationCollectionCompletion(
  captured: { generation: number; tenantId: string; workspaceId: string | null; cursor: string | null },
  current: { generation: number; tenantId: string; workspaceId: string | null; cursor: string | null },
  signal: AbortSignal,
): boolean
