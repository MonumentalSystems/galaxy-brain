export const CONVERSATION_FORK_MAX_RESPONSE_BYTES: 65536
export const CONVERSATION_FORK_MAX_MESSAGE_BYTES: 65536

export interface ConversationForkIntent {
  schemaId: "gb.conversation-fork.intent.v1"
  conversationId: string
  conversationReference: string
  parentTurnId: string
  parentTurnReference: string
  expectedVersion: number
  message: string
  idempotencyKey: string
  requestBody: string
}

export interface ConversationForkReceipt {
  schemaId: "gb.conversation.mutation-receipt.v1"
  conversationId: string
  version: number
  contentHash: string
  revisionId: string
  turnId: string
  operation: "fork"
  replayed: boolean
  conversationReference: string
}

export interface ConversationForkTargetIdentity {
  tenantId: string
  conversationReference: string
  parentTurnReference: string
  expectedVersion: number
  title: string
}

export interface ConversationForkRecovery {
  schemaId: "gb.conversation-fork-recovery.v1"
  tenantId: string
  target: ConversationForkTargetIdentity
  intent: ConversationForkIntent
}

export class ConversationForkError extends Error {
  code: "invalid_request" | "invalid_response" | "stale_conversation" | "request_failed" | "transport_error" | "transport_unavailable"
  ambiguous: boolean
  status: number | null
}

export function prepareConversationForkIntent(value: {
  conversationReference: string
  parentTurnReference: string
  expectedVersion: number
  message: string
}, options?: { idempotencyKey?: string }): ConversationForkIntent

export function forkConversationTurn(
  intent: ConversationForkIntent,
  options?: { fetcher?: typeof fetch; signal?: AbortSignal },
): Promise<ConversationForkReceipt>

export function reconcileConversationFork(
  result: { tenantId: string; intent: ConversationForkIntent; receipt: ConversationForkReceipt },
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

export function serializeConversationForkRecovery(value: ConversationForkRecovery): string

export function parseConversationForkRecovery(
  value: string,
  tenantId: string,
): ConversationForkRecovery | null

export function conversationForkRecoveryStorageKey(tenantId: string): string

export function conversationForkReceiptApplies(
  result: { tenantId: string; intent: ConversationForkIntent; receipt: ConversationForkReceipt },
  tenantId: string,
  conversationReference: string,
): boolean
