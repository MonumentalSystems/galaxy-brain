import type { AtlasObjectHydrationResult } from "./atlas-object-hydration"
import type { GalaxySurfaceSpec } from "./types/surfaces"

export type AtlasSurfaceHydrationResult = Exclude<AtlasObjectHydrationResult, { readonly status: "resolved" }> | (
  Extract<AtlasObjectHydrationResult, { readonly status: "resolved" }> & {
    readonly surfaceSpec?: GalaxySurfaceSpec
  }
)

export function surfaceResolutionIdentity(result: unknown): Readonly<{
  surfaceId: string
  version: number
  contentHash: string
}> | null

export function hydrateAtlasSurfaceSpecs(
  byReference: Readonly<Record<string, AtlasObjectHydrationResult>>,
  resolveSurface: (surfaceId: string, version: number, signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal,
  concurrency?: number,
): Promise<Readonly<Record<string, AtlasSurfaceHydrationResult>>>
