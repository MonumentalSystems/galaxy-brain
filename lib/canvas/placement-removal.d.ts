import type { CanvasEnvelope, CanvasMutationInput } from "../types/canvas"
import type { CanvasSnapshot } from "./canvas-snapshot.js"

export type PlacementRemovalState = "present" | "removed" | "untracked" | "collision"

export class PlacementRemovalConflictError extends Error {
  readonly code: "placement_identity_conflict"
}

export function placementRemovalState(
  snapshot: CanvasSnapshot,
  placementId: string,
  expectedSubjectRef?: string,
): PlacementRemovalState

export function validatePlacementRemovalEnvelope(
  canvas: CanvasEnvelope,
  placementId: string,
  expectedCanvasId?: string,
  expectedSubjectRef?: string,
): CanvasEnvelope

export function reconcilePlacementRemoval(input: {
  current: CanvasEnvelope
  placementId: string
  subjectRef: string
  operationId: string
  mutateCanvas: (canvasId: string, input: CanvasMutationInput) => Promise<CanvasEnvelope>
  reloadCanvas: (canvasId: string) => Promise<CanvasEnvelope>
}): Promise<{
  canvas: CanvasEnvelope
  placementId: string
  replayed: boolean
}>
