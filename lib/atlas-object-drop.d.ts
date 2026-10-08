import type { AtlasObjectHydrationResult } from "./atlas-object-hydration"

export const ATLAS_OBJECT_DRAG_MIME: "application/x-galaxy-atlas-object"
export const ATLAS_OBJECT_DRAG_SCHEMA_ID: "gb.atlas.object-drag.v1"

export interface AtlasObjectDragIntent {
  readonly schemaId: "gb.atlas.object-drag.v1"
  readonly subjectRef: string
  readonly label: string
}

export interface AuthorizedAtlasObjectDrop {
  readonly subjectRef: string
  readonly label: string
}

export function hasAtlasObjectDrag(transfer: Pick<DataTransfer, "types"> | unknown): boolean
export function writeAtlasObjectDrag(
  transfer: Pick<DataTransfer, "setData" | "effectAllowed">,
  input: { readonly subjectRef: string; readonly label: string },
): AtlasObjectDragIntent
export function parseAtlasObjectDrop(transfer: DataTransfer): AtlasObjectDragIntent
export function authorizeAtlasObjectDrop(
  intent: AtlasObjectDragIntent,
  hydration: AtlasObjectHydrationResult | undefined,
): AuthorizedAtlasObjectDrop
export function createAtlasDropOperationLock(): Readonly<{
  active(): boolean
  run(operation: () => void | Promise<void>): Promise<boolean>
}>
export function selectAtlasPendingDropRecovery<TFile, TObject>(
  pending: { readonly kind: "file" | "object"; readonly operationId?: string } | null,
  recoveries: { readonly file?: TFile | null; readonly object?: TObject | null },
): TFile | TObject | null
