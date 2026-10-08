export type GalaxyReferenceKind = "entity" | "node"

export interface GalaxyReference {
  kind: GalaxyReferenceKind
  id: string
}

export function createGalaxyReference(kind: GalaxyReferenceKind, id: string): string
export function parseGalaxyReference(value: string | null | undefined): GalaxyReference | null
export function galaxyReferenceHref(reference: string, pathname: "/graph" | "/workspace"): string
