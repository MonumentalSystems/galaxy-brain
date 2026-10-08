import type { Node } from "@canvas-harness/core"
import type { GalaxyCanvasPlacement, GalaxyCanvasProjection } from "./galaxy-canvas-adapter.js"
import type { CanvasSnapshot, CanvasSnapshotItem } from "./canvas-snapshot.js"
import type { CanvasCommand } from "../types/canvas.js"

export type PlacementGeometry = {
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  angle?: number
  displayMode?: string
  collapsed?: boolean
  style?: Record<string, unknown>
}

export function mergeCanvasSnapshot(
  projection: GalaxyCanvasProjection,
  snapshot: CanvasSnapshot,
): GalaxyCanvasProjection
export function mergeCanvasSnapshotWithPlacementOverrides(
  projection: GalaxyCanvasProjection,
  snapshot: CanvasSnapshot,
  overrides: Iterable<readonly [string, PlacementGeometry]>,
): GalaxyCanvasProjection
export function applyCanvasPlacementOverrides(
  projection: GalaxyCanvasProjection,
  overrides: Iterable<readonly [string, PlacementGeometry]>,
): GalaxyCanvasProjection
export function snapshotItemFromPlacement(
  placement: GalaxyCanvasPlacement,
  geometry?: PlacementGeometry | GalaxyCanvasPlacement,
): CanvasSnapshotItem
export function commandsForPlacementGeometry(
  snapshot: CanvasSnapshot,
  projection: GalaxyCanvasProjection,
  placementId: string,
  geometry: PlacementGeometry,
): CanvasCommand[]
export function canvasNodeGeometry(node: Node): PlacementGeometry
