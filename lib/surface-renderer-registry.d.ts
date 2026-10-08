import type { GalaxyPluginRegistry } from "./plugins/registry.js"
import type { GalaxySurfaceSpec } from "./types/surfaces"

export interface SurfaceRendererDefinition {
  id: "generous.a2ui"
  schema: "gb.surface.v1"
  schemaDigest: "d147fafd26dd4be4cd41a1f504843366a01725a84a35668d565be4d210136729"
  catalogId: "generous.a2ui"
  catalogVersion: "1"
  catalogDigest: "60e2460ae227ccc42e3a44a2cda2740ec688ce57a68df972d67f8ab69c9d321f"
  rendererId: "generous-works"
  rendererVersion: "29250eba64b8dfd89c2307a0f4a4a5193cb129fc"
  compatibleCatalogDigests: readonly string[]
  pluginId: string
  implementationId: "builtin.surface-renderer.generous-a2ui"
}

export const BUILTIN_GENEROUS_SURFACE_RENDERER: Readonly<Omit<SurfaceRendererDefinition, "pluginId" | "implementationId">>

export function isCompatibleSurfaceCatalogDigest(digest: unknown): digest is string

export function getSurfaceRenderer(
  spec: GalaxySurfaceSpec | unknown,
  registry?: GalaxyPluginRegistry,
): SurfaceRendererDefinition | null

export function scrubResolvedSurfaceBindings(
  spec: GalaxySurfaceSpec,
  bindings: readonly Readonly<{
    status: string
    target: Readonly<{ componentId: string; prop: string }>
  }>[],
): GalaxySurfaceSpec | null
