export type GraphScale = "corpus" | "project" | "task" | "run" | "object" | "atomic"
export type GraphLayoutRequest = {
  schemaId: "gb.graph-layout.v1"
  projectionHash: string
  scale: GraphScale
  nodes: Array<{ id: string; layer?: number }>
  edges: Array<{ source: string; target: string }>
}
export type GraphLayoutResult = {
  key: string
  positions: Record<string, { x: number; y: number }>
  mode: "force" | "fallback"
}
export const GRAPH_LAYOUT_SCHEMA_ID: "gb.graph-layout.v1"
export const GRAPH_LAYOUT_FORCE_LIMIT: number
export const GRAPH_LAYOUT_NODE_LIMIT: number
export function normalizeGraphLayoutRequest(value: unknown): GraphLayoutRequest
export function deterministicGraphFallback(value: unknown): GraphLayoutResult
export function graphLayoutCacheKey(projectionHash: string, scale: GraphScale): string
