import type { GalaxyGraphQuery, UnifiedGraphInput } from "./unified-graph"

export const CONVERSATION_GRAPH_SCHEMA_ID: "gb.conversation.v1"
export const CONVERSATION_PAGE_LIMIT: 500
export const CONVERSATION_TURN_LIMIT: 1000
export const CONVERSATION_TURN_CONTENT_MAX_BYTES: 65536

export function canonicalGraphQueryParameter(
  parameters: URLSearchParams,
  name: "ref" | "conversation",
): string | null

export interface ConversationGraphSelection {
  conversationId: string
  conversationReference: string
  selectedReference: string
}

export function resolveConversationGraphSelection(value?: {
  reference?: string | null
  conversationReference?: string | null
}): ConversationGraphSelection | null

export function resolveConversationGraphRoute(value?: {
  reference?: string | null
  conversationReference?: string | null
  mode?: string
}): ConversationGraphSelection | null

export function conversationGraphPagePath(
  selection: ConversationGraphSelection,
  continuation?: { afterOrdinal: number; version: number } | null,
): string

export function conversationMarkdownExportPath(conversationReference: string): string

export function assembleConversationGraphPages(
  pages: unknown[],
  selection: { reference?: string | null; conversationReference?: string | null },
  query?: GalaxyGraphQuery,
): {
  graphInput: UnifiedGraphInput
  conversationReference: string
  selectedReference: string
  version: number
  contentHash: string
  loadedTurnCount: number
  turnContentByReference: Readonly<Record<string, string>>
  hasMore: boolean
  nextContinuation: { afterOrdinal: number; version: number } | null
}
