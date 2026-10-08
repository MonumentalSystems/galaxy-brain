import type { GalaxyCanvasProjection } from "./galaxy-canvas-adapter"
import type { CanvasRecord } from "../types/canvas"

export function normalizeCanvasProjectionMode(value: unknown): "ambient" | "curated"
export function selectAtlasBaseProjection(
  canvas: CanvasRecord | null,
  projection: GalaxyCanvasProjection,
): GalaxyCanvasProjection
