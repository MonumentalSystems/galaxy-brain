import type { CameraState, Node } from "@canvas-harness/core"

export const ATLAS_MEDIUM_ZOOM: number
export const ATLAS_CAMERA_PAN_STEP: number
export type AtlasCameraPanDirection = "up" | "down" | "left" | "right"
export function panAtlasCamera(
  camera: CameraState,
  direction: AtlasCameraPanDirection,
): CameraState
export function cameraForAtlasNodes(
  nodes: ReadonlyArray<Pick<Node, "id" | "x" | "y">>,
  selectedNodeId?: string,
): { x: number; y: number; z: number }
