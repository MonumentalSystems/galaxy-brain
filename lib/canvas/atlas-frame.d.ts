import type { Node } from "@canvas-harness/core"
import type { CanvasSnapshot, CanvasSnapshotFrame } from "./canvas-snapshot.js"
import type { GalaxyCanvasProjection } from "./galaxy-canvas-adapter.js"
import type { CanvasCommand, CanvasEnvelope, CanvasMutationInput } from "../types/canvas.js"

export const ATLAS_FRAME_MUTATION_RECOVERY_SCHEMA: "gb.atlas-frame-mutation-recovery.v1"
export class AtlasFrameMutationConflictError extends Error {
  readonly code: "frame_identity_conflict"
  readonly canvas: CanvasEnvelope
}
export class AtlasFrameMutationTerminalError extends Error {
  readonly code: "frame_mutation_rejected"
  readonly canvas: CanvasEnvelope
  readonly status: number | null
  readonly cause: unknown
}
export class AtlasFrameMutationRecoveryError extends TypeError {}

export type AtlasFrameGeometry = Pick<CanvasSnapshotFrame, "x" | "y" | "width" | "height">
export type AtlasFrameMutationScope = Readonly<{
  tenantId: string
  principalId: string
  workspaceId: string
  canvasId: string
}>
export type AtlasFrameMutationOperation = Readonly<{
  schemaId: typeof ATLAS_FRAME_MUTATION_RECOVERY_SCHEMA
  state: "pending"
  kind: "create" | "remove"
  operationId: string
  idempotencyKey: string
  tenantId: string
  principalId: string
  workspaceId: string
  canvasId: string
  frame: CanvasSnapshotFrame
}>
export type AtlasFrameMutationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function canvasFrameFromInput(
  input: CanvasSnapshotFrame,
): CanvasSnapshotFrame
export function commandsForFrameGeometry(
  snapshot: CanvasSnapshot,
  frameId: string,
  geometry: AtlasFrameGeometry,
): CanvasCommand[]
export function frameGeometryFromNode(node: Node): AtlasFrameGeometry
export function clampAtlasFrameGeometry(geometry: AtlasFrameGeometry): AtlasFrameGeometry
export function applyFrameGeometryOverrides(
  projection: GalaxyCanvasProjection,
  overrides: Iterable<readonly [string, AtlasFrameGeometry]>,
): GalaxyCanvasProjection
export function frameCreateCommand(frame: CanvasSnapshotFrame): Extract<CanvasCommand, { type: "frame.create" }>
export function frameRemoveCommand(
  snapshot: CanvasSnapshot,
  frameId: string,
): Extract<CanvasCommand, { type: "frame.remove" }>
export function atlasFrameMutationRecoveryKey(scope: AtlasFrameMutationScope): string
export function prepareAtlasFrameMutationOperation(input: AtlasFrameMutationScope & {
  kind: "create" | "remove"
  frame: CanvasSnapshotFrame
  operationId?: string
}): AtlasFrameMutationOperation
export function readPendingAtlasFrameMutation(
  storage: AtlasFrameMutationStorage,
  scope: AtlasFrameMutationScope,
): AtlasFrameMutationOperation | null
export function writePendingAtlasFrameMutation(
  storage: AtlasFrameMutationStorage,
  scope: AtlasFrameMutationScope,
  operation: AtlasFrameMutationOperation,
): AtlasFrameMutationOperation
export function removePendingAtlasFrameMutation(
  storage: AtlasFrameMutationStorage,
  scope: AtlasFrameMutationScope,
  operationId: string,
): boolean
export function quarantineAtlasFrameMutationJournal(
  storage: AtlasFrameMutationStorage,
  scope: AtlasFrameMutationScope,
): boolean
export function isTerminalAtlasFrameMutationError(error: unknown): boolean
export function atlasFrameMutationState(
  snapshot: CanvasSnapshot,
  frame: CanvasSnapshotFrame,
): "absent" | "exact" | "collision"
export function reconcileAtlasFrameMutation(input: {
  current: CanvasEnvelope
  operation: AtlasFrameMutationOperation
  mutateCanvas: (canvasId: string, input: CanvasMutationInput) => Promise<CanvasEnvelope>
  reloadCanvas: (canvasId: string) => Promise<CanvasEnvelope>
}): Promise<Readonly<{
  canvas: CanvasEnvelope
  operation: AtlasFrameMutationOperation
  replayed: boolean
}>>
