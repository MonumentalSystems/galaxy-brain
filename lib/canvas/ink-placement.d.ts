import type { CanvasEnvelope, CanvasMutationInput } from "../types/canvas"
import type { CanvasSnapshot, CanvasSnapshotItem } from "./canvas-snapshot.js"

export const INK_PLACEMENT_STYLE: "gb.canvas.ink-placement.v1"

export type InkPlacementDescriptor = {
  schemaId: "gb.canvas.ink-placement.v1"
  documentId: string
  revisionSha256: string
  documentRevisionId: string
  representationId: string
  contentSha256: string
}

export function normalizeInkPlacementDescriptor(value: unknown): Readonly<InkPlacementDescriptor>
export function authorizeInkPlacementDescriptor(
  value: unknown,
  subjectRef: string,
  projection: import("../object-projection").GalaxyObjectProjection,
): Readonly<InkPlacementDescriptor>
export function inkRepresentationContentPath(value: unknown): string
export function createInkCanvasItem(
  subjectRef: string,
  operationId: string,
  descriptor: InkPlacementDescriptor,
  snapshot: CanvasSnapshot,
): CanvasSnapshotItem
export function reconcileInkPlacement(input: {
  current: CanvasEnvelope
  subjectRef: string
  operationId: string
  descriptor: InkPlacementDescriptor
  mutateCanvas: (canvasId: string, input: CanvasMutationInput) => Promise<CanvasEnvelope>
  reloadCanvas: (canvasId: string) => Promise<CanvasEnvelope>
}): Promise<{ canvas: CanvasEnvelope; item: CanvasSnapshotItem; replayed: boolean }>
