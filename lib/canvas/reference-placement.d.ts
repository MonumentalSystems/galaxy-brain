import type { CanvasEnvelope, CanvasMutationInput } from "../types/canvas"
import type { CanvasSnapshot, CanvasSnapshotItem } from "./canvas-snapshot.js"

export const REFERENCE_PLACEMENT_STYLE: "gb.canvas.reference-placement.v1"
export const MAX_PLACEABLE_REFERENCE_CHARACTERS: 1024
export const MAX_REFERENCE_PLACEMENT_COORDINATE: 10000000

export type ReferencePlacementPoint = Readonly<{ x: number; y: number }>

export type PlaceableReferenceKind =
  | "paper"
  | "document"
  | "document.anchor"
  | "eln.experiment"
  | "eln.observation"
  | "ham.task"
  | "ham.memory"
  | "chat"
  | "surface"
  | "proof.graph"
  | "proof.node"

export type PlaceableReferenceInspection =
  | {
      ok: true
      subjectRef: string
      kind: PlaceableReferenceKind
      nodeType: string
    }
  | {
      ok: false
      code: "invalid_reference" | "noncanonical_reference" | "unsupported_kind"
    }

export function inspectPlaceableReference(
  value: unknown,
  options?: { allowSurface?: boolean },
): PlaceableReferenceInspection
export function createReferenceCanvasItem(
  subjectRef: string,
  operationId: string,
  snapshot: CanvasSnapshot,
  point?: ReferencePlacementPoint | null,
): CanvasSnapshotItem
export function normalizeReferencePlacementPoint(value?: unknown): ReferencePlacementPoint | null
export function referencePlacementState(
  snapshot: CanvasSnapshot,
  item: CanvasSnapshotItem,
): "absent" | "replayed" | "collision"
export function validateReferencePlacementEnvelope(
  canvas: CanvasEnvelope,
  item: CanvasSnapshotItem,
): CanvasEnvelope
export function reconcileReferencePlacement(input: {
  current: CanvasEnvelope
  subjectRef: string
  operationId: string
  point?: ReferencePlacementPoint | null
  mutateCanvas: (canvasId: string, input: CanvasMutationInput) => Promise<CanvasEnvelope>
  reloadCanvas: (canvasId: string) => Promise<CanvasEnvelope>
}): Promise<{
  canvas: CanvasEnvelope
  item: CanvasSnapshotItem
  replayed: boolean
}>
