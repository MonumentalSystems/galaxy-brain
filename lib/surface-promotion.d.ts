import type { GalaxySurfaceRecord, GalaxySurfaceRevision } from "./types/surfaces"

export function surfacePromotionProvenance(value: unknown): Record<string, unknown>
export function surfaceHeadMatchesReview(
  value: unknown,
  reviewed: GalaxySurfaceRevision | null | undefined,
): value is GalaxySurfaceRecord
export function normalizeSurfacePromotionResponse(
  value: unknown,
  reviewed: GalaxySurfaceRevision,
): Readonly<{
  surface: GalaxySurfaceRecord
  revision: GalaxySurfaceRevision
  replayed: boolean
  currentIsPromotedRevision: boolean
}>
