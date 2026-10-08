export const CANVAS_SNAPSHOT_SCHEMA: "gb.canvas.snapshot.v1"
export const CANVAS_CHANGED_SCHEMA: "gb.canvas.changed.v1"
export const CANVAS_CHANGE_POLL_INTERVAL_MS: 5000
export const CANVAS_CHANGE_POLL_MAX_INTERVAL_MS: 30000
export const CANVAS_NODE_TYPES: readonly string[]
export const CANVAS_FRAME_TONES: readonly CanvasFrameTone[]
export type CanvasFrameTone = "neutral" | "sage" | "amber" | "plum"

export type CanvasSnapshotFrame = {
  id: string
  title: string
  x: number
  y: number
  width: number
  height: number
  tone: CanvasFrameTone
}

export type CanvasSnapshotItem = {
  id: string
  subjectRef: string
  nodeType: string
  x: number
  y: number
  width: number
  height: number
  angle: number
  zIndex: number
  displayMode: string
  collapsed: boolean
  style: Record<string, unknown>
}

export type CanvasSnapshotEdge = {
  id: string
  sourceItemId: string
  targetItemId: string
  edgeKind: string
  label?: string
  semanticRef?: string
  style: Record<string, unknown>
}

export type CanvasSnapshot = {
  schemaId: typeof CANVAS_SNAPSHOT_SCHEMA
  items: CanvasSnapshotItem[]
  edges: CanvasSnapshotEdge[]
  frames?: CanvasSnapshotFrame[]
  removedItemIds: string[]
  removedEdgeIds: string[]
}

export type CanvasChangeEvent = {
  schemaId: typeof CANVAS_CHANGED_SCHEMA
  canvasId: string
  version: number
  contentHash: string
  mutationId: string
}

export function normalizeCanvasSnapshot(value: unknown): CanvasSnapshot
export function serializeCanvasSnapshot(value: unknown): string
export function hashCanvasSnapshot(value: unknown): Promise<string>
export function validateCanvasChangeEvent(value: unknown): CanvasChangeEvent
export function canvasChangeAction(
  current: { version: number; contentHash: string },
  pendingChanges: boolean,
  event: unknown,
): "ignore" | "conflict" | "notify"
export function canvasReloadSatisfiesChange(
  canvas: { canvasId: string; version: number; contentHash: string } | null | undefined,
  event: { canvasId: string; version: number; contentHash: string },
): boolean
export function canvasChangeEventFromRevision(
  canvasId: string,
  revision: { id: string; version: number; content_hash: string },
): CanvasChangeEvent
export function canvasChangePollDelay(consecutiveFailures: number): number
