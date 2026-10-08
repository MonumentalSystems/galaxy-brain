import type { GalaxySurfaceSpec, SurfaceBinding, SurfaceComponentType } from "./types/surfaces"

export interface ProjectedSurfaceNode {
  id: string
  type: SurfaceComponentType
  props: Record<string, unknown>
  childIds: string[]
  children: ProjectedSurfaceNode[]
}

export type ProjectedSurface =
  | { ok: true; roots: ProjectedSurfaceNode[]; bindings: SurfaceBinding[] }
  | { ok: false; error: string }

export function projectSurface(value: GalaxySurfaceSpec | unknown): ProjectedSurface
export function surfaceDisplayText(
  value: Record<string, unknown> | unknown,
  fields: string[],
  fallback?: string,
): string
export function projectSurfaceProvenance(value: unknown): Record<string, unknown>
