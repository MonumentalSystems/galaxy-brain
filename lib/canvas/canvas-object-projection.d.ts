import type { GalaxyObjectProjection } from "../object-projection"
import type { GalaxyCanvasNodeData, GalaxyCanvasNodeType } from "./galaxy-canvas-adapter"

export function projectCanvasNodeObject(
  nodeType: GalaxyCanvasNodeType,
  data: GalaxyCanvasNodeData,
): GalaxyObjectProjection

export function resolvedCanvasNodeRepresentation(
  nodeType: GalaxyCanvasNodeType,
  data: GalaxyCanvasNodeData,
): {
  ref: string
  mediaType: string
  contentHash?: string | null
  content: string
} | undefined
