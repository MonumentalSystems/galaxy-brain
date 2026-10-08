import type { CameraState, WorldRect } from "@canvas-harness/core"

export type AtlasSelectionHudSize = Readonly<{
  width: number
  height: number
}>

export type AtlasSelectionHudPosition = Readonly<{
  left: number
  top: number
  placement: "above" | "below" | "pinned"
}>

export function positionAtlasSelectionHud(input: Readonly<{
  nodeBounds: WorldRect
  camera: CameraState
  viewport: AtlasSelectionHudSize
  hud: AtlasSelectionHudSize
  pinnedPosition?: Readonly<{ left: number; top: number }> | null
  insets?: Readonly<Partial<{ top: number; right: number; bottom: number; left: number }>>
  margin?: number
  gap?: number
}>): AtlasSelectionHudPosition | null
