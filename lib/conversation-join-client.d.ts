export const CONVERSATION_JOIN_MAX_RESPONSE_BYTES: 65536
export const CONVERSATION_JOIN_MAX_MESSAGE_BYTES: 65536
export const CONVERSATION_JOIN_MIN_PARENTS: 2
export const CONVERSATION_JOIN_MAX_PARENTS: 8

export interface ConversationJoinIntent {
  schemaId: "gb.conversation-join.intent.v1"
  conversationId: string
  conversationReference: string
  parentTurnIds: readonly string[]
  parentTurnReferences: readonly string[]
  expectedVersion: number
  message: string
  idempotencyKey: string
  requestBody: string
}

export interface ConversationJoinReceipt {
  schemaId: "gb.conversation.mutation-receipt.v1"
  conversationId: string
  version: number
  contentHash: string
  revisionId: string
  turnId: string
  operation: "join"
  replayed: boolean
  conversationReference: string
}

export interface ConversationJoinTargetIdentity {
  tenantId: string
  conversationReference: string
  parentTurnReferences: readonly string[]
  expectedVersion: number
  labels: readonly string[]
}

export interface ConversationJoinRecovery {
  schemaId: "gb.conversation-join-recovery.v1"
  tenantId: string
  target: ConversationJoinTargetIdentity
  intent: ConversationJoinIntent
}

export class ConversationJoinError extends Error {
  code: "invalid_request" | "invalid_response" | "stale_conversation" | "request_failed" | "transport_error" | "transport_unavailable"
  ambiguous: boolean
  status: number | null
}

export function deriveConversationJoinCandidates(
  projection: {
    nodes?: readonly unknown[]
    edges?: readonly unknown[]
    continuation?: {
      hasMore?: boolean
      omitted?: { nodes?: number; edges?: number; fanout?: number }
    }
  },
  conversationReference: string,
  contentHash: string,
  authorizedTurnReferences: readonly string[],
): readonly string[]

export function prepareConversationJoinIntent(value: {
  conversationReference: string
  parentTurnReferences: readonly string[]
  expectedVersion: number
  message: string
}, options?: { idempotencyKey?: string }): ConversationJoinIntent

export function joinConversationTurns(
  intent: ConversationJoinIntent,
  options?: { fetcher?: typeof fetch; signal?: AbortSignal },
): Promise<ConversationJoinReceipt>

export function reconcileConversationJoin(
  result: { tenantId: string; intent: ConversationJoinIntent; receipt: ConversationJoinReceipt },
  snapshot: {
    conversationReference: string | null
    version: number | null
    contentHash: string | null
    projection: {
      provenance?: { scope?: { tenantId?: string } }
      nodes?: readonly unknown[]
      edges?: readonly unknown[]
    }
  },
): string | null

export function serializeConversationJoinRecovery(value: ConversationJoinRecovery): string

export function parseConversationJoinRecovery(
  value: string,
  tenantId: string,
): ConversationJoinRecovery | null

export function conversationJoinRecoveryStorageKey(tenantId: string): string

export function conversationJoinReceiptApplies(
  result: { tenantId: string; intent: ConversationJoinIntent; receipt: ConversationJoinReceipt },
  tenantId: string,
  conversationReference: string,
): boolean
