import { builtinPluginRegistry } from "./plugins/builtins.js"

export const BUILTIN_GENEROUS_SURFACE_RENDERER = Object.freeze({
  id: "generous.a2ui",
  schema: "gb.surface.v1",
  schemaDigest: "d147fafd26dd4be4cd41a1f504843366a01725a84a35668d565be4d210136729",
  catalogId: "generous.a2ui",
  catalogVersion: "1",
  catalogDigest: "60e2460ae227ccc42e3a44a2cda2740ec688ce57a68df972d67f8ab69c9d321f",
  rendererId: "generous-works",
  rendererVersion: "29250eba64b8dfd89c2307a0f4a4a5193cb129fc",
  /**
   * Every revision keeps the catalog digest it was saved under, so changing
   * the catalog would otherwise orphan every surface saved before the change.
   * A catalog listed here must be one this renderer draws completely: list a
   * previous digest only when the change was purely additive.
   *
   * c2ac0690… is the catalog before SVGPreview was added, and is otherwise
   * identical (test_surface_contract.py recomputes it).
   */
  compatibleCatalogDigests: Object.freeze([
    "60e2460ae227ccc42e3a44a2cda2740ec688ce57a68df972d67f8ab69c9d321f",
    "c2ac06907552b576c9967a85779c539d83ea6b81dab7129058a056e791c5e375",
  ]),
})

/**
 * Whether a saved surface or revision was written against a catalog this
 * renderer can draw. Use this, not equality with `catalogDigest`, for anything
 * that was persisted; `catalogDigest` names only the catalog new saves get.
 */
export function isCompatibleSurfaceCatalogDigest(digest) {
  return typeof digest === "string"
    && BUILTIN_GENEROUS_SURFACE_RENDERER.compatibleCatalogDigests.includes(digest)
}

const SURFACE_RENDERER_IMPLEMENTATIONS = Object.freeze({
  "builtin.surface-renderer.generous-a2ui": BUILTIN_GENEROUS_SURFACE_RENDERER,
})

function registeredSurfaceRenderer(registration) {
  const implementation = SURFACE_RENDERER_IMPLEMENTATIONS[registration.handler.implementationId]
  if (!implementation || implementation.id !== registration.id) return null
  return Object.freeze({
    ...implementation,
    pluginId: registration.pluginId,
    implementationId: registration.handler.implementationId,
  })
}

/**
 * Select a renderer using only static registry metadata and code-owned
 * implementation IDs. Unregistered or unknown implementations fail closed.
 */
export function getSurfaceRenderer(spec, registry = builtinPluginRegistry) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null
  for (const registration of registry.listContributions("surfaceRenderers")) {
    const renderer = registeredSurfaceRenderer(registration)
    if (
      renderer
      && spec.schema === renderer.schema
      && spec.catalog?.id === renderer.catalogId
      && spec.catalog?.version === renderer.catalogVersion
    ) return renderer
  }
  return null
}

/**
 * Replace successful binding targets with a stable marker so a materialized
 * surface can be compared with its immutable definition. Descendants are
 * processed before ancestors, making overlapping targets order-independent.
 */
export function scrubResolvedSurfaceBindings(spec, bindings) {
  const clone = JSON.parse(JSON.stringify(spec))
  const resolved = bindings
    .filter((binding) => binding.status === "resolved")
    .map((binding) => ({ binding, segments: binding.target.prop.split(".") }))
    .sort((left, right) => (
      right.segments.length - left.segments.length
      || left.binding.target.componentId.localeCompare(right.binding.target.componentId)
      || left.binding.target.prop.localeCompare(right.binding.target.prop)
    ))

  for (const { binding, segments } of resolved) {
    if (segments.some((segment) => !segment)) return null
    const component = clone.surfaceUpdate.components.find((item) => item.id === binding.target.componentId)
    const values = component ? Object.values(component.component) : []
    const props = values.length === 1 ? values[0] : null
    if (!props || typeof props !== "object" || Array.isArray(props)) return null
    let parent = props
    for (const segment of segments.slice(0, -1)) {
      const child = parent[segment]
      if (!child || typeof child !== "object" || Array.isArray(child)) return null
      parent = child
    }
    parent[segments.at(-1)] = "__galaxy_resolved_binding_value__"
  }
  return clone
}
