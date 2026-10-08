export type ShareBundleMode = "object-only" | "canvas-only" | "canvas-plus-conversation"

export type CreateObjectShareBundleInput = {
  schemaId: "gb.share-bundle.v1"
  mode: "object-only"
  selector:
    | { objectRef: string }
    | { nodeId: string; revisionId: string }
  idempotencyKey: string
}

export type CreateCanvasShareBundleInput = {
  schemaId: "gb.share-bundle.v1"
  mode: "canvas-only"
  selector: {
    canvasId: string
    version: number
    contentHash: string
  }
  idempotencyKey: string
}

export type CreateCanvasConversationShareBundleInput = {
  schemaId: "gb.share-bundle.v2"
  mode: "canvas-plus-conversation"
  selector: {
    canvasId: string
    version: number
    contentHash: string
    conversationRef: string
  }
  idempotencyKey: string
}

export type CreateShareBundleInput =
  | CreateObjectShareBundleInput
  | CreateCanvasShareBundleInput
  | CreateCanvasConversationShareBundleInput

export type SharedObjectPayload = {
  schemaId: "gb.share-object.v1"
  ref: string
  kind: string
  revision: string
  title: string
  content?: string
  tags?: string[]
  version?: number
  provider?: string
  source?: Record<string, unknown>
}

export type SharedCanvasSnapshot = {
  schemaId: "gb.canvas.snapshot.v1"
  items: Array<{
    id: string
    subjectRef: string
    nodeType: string
    x: number
    y: number
    width: number
    height: number
    [key: string]: unknown
  }>
  edges: Array<{
    id: string
    sourceItemId: string
    targetItemId: string
    edgeKind: string
    [key: string]: unknown
  }>
  frames?: Array<{
    id: string
    title: string
    x: number
    y: number
    width: number
    height: number
    tone: "neutral" | "sage" | "amber" | "plum"
  }>
  removedItemIds: string[]
  removedEdgeIds: string[]
}

export type SharedCanvasPayload = {
  schemaId: "gb.share-canvas.v1"
  canvasId: string
  title: string
  version: number
  contentHash: string
  snapshot: SharedCanvasSnapshot
}

export type SharedConversationPayload = {
  schemaId: "gb.share-redacted-conversation.v1"
  conversationId: string
  ref: string
  title: string
  goal: string
  version: number
  contentHash: string
  turns: Array<{
    turnId: string
    ordinal: number
    role: "user" | "assistant" | "system" | "tool"
    sourceRef: string
    sourceContentHash: string
    publication:
      | {
          status: "published"
          content: string
          contentSha256: string
        }
      | {
          status: "redacted"
          reason: "role-excluded"
        }
  }>
  edges: Array<{
    edgeId: string
    fromTurnId: string
    toTurnId: string
    kind: "continues" | "forks" | "joins"
  }>
}

export type SharedCanvasConversationPayload = {
  schemaId: "gb.share-canvas-redacted-conversation.v1"
  canvas: SharedCanvasPayload
  conversation: SharedConversationPayload
}

type ShareBundleBase = {
  id: string
  contentHash: string
  createdAt: string
}

export type ObjectShareBundle = ShareBundleBase & {
  schemaId: "gb.share-bundle.v1"
  mode: "object-only"
  source: Record<string, unknown>
  payload: SharedObjectPayload
}

export type CanvasShareBundle = ShareBundleBase & {
  schemaId: "gb.share-bundle.v1"
  mode: "canvas-only"
  source: {
    canvasId: string
    version: number
    contentHash: string
  }
  payload: SharedCanvasPayload
}

export type CanvasConversationShareBundle = ShareBundleBase & {
  schemaId: "gb.share-bundle.v2"
  mode: "canvas-plus-conversation"
  source: {
    canvasId: string
    version: number
    contentHash: string
    conversationRef: string
  }
  payload: SharedCanvasConversationPayload
}

export type ShareBundle = ObjectShareBundle | CanvasShareBundle | CanvasConversationShareBundle

// Read-only compatibility shape for snapshots created before gb.share-bundle.v1.
export type LegacyShareSnapshot = {
  id: string
  target_type: "surface" | "component" | "node"
  target_id: string
  access: "public-read"
  snapshot_json: Record<string, unknown>
  created_at: string
}
