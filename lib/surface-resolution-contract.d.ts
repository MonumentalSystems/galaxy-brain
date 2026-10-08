import type { GalaxySurfaceSpec, ResolvedGalaxySurface } from "./types/surfaces"

export function validRenderableSurfaceSpec(value: unknown): value is GalaxySurfaceSpec

export function validateResolvedSurface(
  value: unknown,
  expected: Readonly<{
    surfaceId: string
    version: number
    contentHash: string
    definition?: GalaxySurfaceSpec
  }>,
): ResolvedGalaxySurface | null
