export type AtlasLocation = {
  canvasId: string | null
  placementId: string | null
}

export type AtlasWorkspaceSearchParams = Record<
  string,
  string | string[] | undefined
> & {
  canvas?: string | string[]
  placement?: string | string[]
  ref?: string | string[]
  /** Exact placement intent; deliberately not part of AtlasLocation selection. */
  placeRef?: string | string[]
}

export function atlasPlacementHref(canvasId: string, placementId: string): string
export function atlasCanvasHref(canvasId: string): string
export function atlasWorkspaceHref(searchParams?: AtlasWorkspaceSearchParams): string
export function parseAtlasLocation(search: string): AtlasLocation
