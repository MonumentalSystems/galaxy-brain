import type { CanvasSnapshot, CanvasSnapshotEdge, CanvasSnapshotFrame, CanvasSnapshotItem } from "@/lib/canvas/canvas-snapshot"

export type CanvasProjectionMode = "ambient" | "curated"

export type CanvasRecord = {
  canvasId: string
  workspaceId: string
  slug: string
  title: string
  isDefault: boolean
  projectionMode: CanvasProjectionMode
  version: number
  contentHash: string
  createdAt?: string
  updatedAt?: string
}

export type CanvasEnvelope = CanvasRecord & {
  content: CanvasSnapshot
  mutationId?: string
  replayed?: boolean
}

export type CanvasRevision = {
  id: string
  version: number
  content_hash: string
  idempotency_key: string
  created_by_principal_id: string
  created_at: string
}

export type CanvasChangeEvent = {
  schemaId: "gb.canvas.changed.v1"
  canvasId: string
  version: number
  contentHash: string
  mutationId: string
}

export type CanvasCommand =
  | { type: "item.place"; item: CanvasSnapshotItem }
  | { type: "item.move"; itemId: string; position: { x: number; y: number } }
  | { type: "item.resize"; itemId: string; size: { width: number; height: number } }
  | { type: "item.remove"; itemId: string }
  | { type: "item.reorder"; itemId: string; zIndex: number }
  | { type: "edge.connect"; edge: CanvasSnapshotEdge }
  | { type: "edge.disconnect"; edgeId: string }
  | { type: "frame.create"; frame: CanvasSnapshotFrame }
  | { type: "frame.move"; frameId: string; position: { x: number; y: number } }
  | { type: "frame.resize"; frameId: string; size: { width: number; height: number } }
  | { type: "frame.remove"; frameId: string }

export type CanvasMutationInput = {
  expectedVersion: number
  expectedContentHash: string
  idempotencyKey: string
  commands: CanvasCommand[]
}
