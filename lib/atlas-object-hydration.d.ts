import type { ObjectProjectionResolutionResult } from "./object-projection-resolution"
import type { GalaxyCanvasProjection } from "./canvas/galaxy-canvas-adapter"
import type { CanvasSnapshot } from "./canvas/canvas-snapshot"

export interface AtlasObjectHydrationRequestFailure {
  readonly requestedRef: string
  readonly status: "request-failed"
}

export type AtlasObjectHydrationResult =
  | ObjectProjectionResolutionResult
  | AtlasObjectHydrationRequestFailure

export type AtlasHydrationAvailability = Readonly<Record<
  string,
  AtlasObjectHydrationResult | { readonly status: "loading" }
>>

export function applyAtlasHydrationAvailability(
  projection: GalaxyCanvasProjection,
  snapshot: CanvasSnapshot,
  hydrationByReference: AtlasHydrationAvailability,
): GalaxyCanvasProjection

export interface AtlasObjectHydrationBatch {
  readonly references: readonly string[]
  readonly results: readonly AtlasObjectHydrationResult[]
  readonly byReference: Readonly<Record<string, AtlasObjectHydrationResult>>
}

export function hydrateAtlasObjectReferences(
  subjectRefs: readonly unknown[],
  options?: {
    fetcher?: typeof fetch
    signal?: AbortSignal
    concurrency?: number
  },
): Promise<AtlasObjectHydrationBatch>

export const resolveObjectProjectionReferences: typeof hydrateAtlasObjectReferences
