import { projectSurface } from "./surface-projection.js"
import {
  BUILTIN_GENEROUS_SURFACE_RENDERER,
  getSurfaceRenderer,
  isCompatibleSurfaceCatalogDigest,
  scrubResolvedSurfaceBindings,
} from "./surface-renderer-registry.js"

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(",")}}`
}

function boundedStringArray(value, maximumItems, maximumLength) {
  return value === undefined || (
    Array.isArray(value)
    && value.length <= maximumItems
    && value.every((item) => typeof item === "string" && item.length <= maximumLength)
  )
}

export function validRenderableSurfaceSpec(value) {
  return Boolean(
    projectSurface(value).ok
    && getSurfaceRenderer(value)?.implementationId === "builtin.surface-renderer.generous-a2ui",
  )
}

/**
 * Validate an ephemeral surface materialization against the immutable revision
 * selected by its owning view. The immutable definition is optional so Atlas
 * can validate an exact resolver-owned revision without becoming another
 * canonical surface store.
 */
export function validateResolvedSurface(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value
  if (
    candidate.surface_id !== expected.surfaceId
    || candidate.version !== expected.version
    || candidate.definition_content_hash !== expected.contentHash
    || candidate.schema_digest !== BUILTIN_GENEROUS_SURFACE_RENDERER.schemaDigest
    || !isCompatibleSurfaceCatalogDigest(candidate.catalog_digest)
    || candidate.renderer_version !== BUILTIN_GENEROUS_SURFACE_RENDERER.rendererVersion
    || !validRenderableSurfaceSpec(candidate.definition)
    || (expected.definition !== undefined
      && stableJson(candidate.definition) !== stableJson(expected.definition))
    || !validRenderableSurfaceSpec(candidate.materialized_spec)
    || !Array.isArray(candidate.bindings)
    || typeof candidate.resolved_at !== "string"
    || candidate.resolved_at.length < 1
    || candidate.resolved_at.length > 256
  ) return null

  const expectedBindings = new Map(candidate.definition.bindings.map((binding) => [binding.id, binding]))
  if (candidate.bindings.length !== expectedBindings.size) return null
  const observed = new Set()
  for (const binding of candidate.bindings) {
    const expectedBinding = expectedBindings.get(binding?.binding_id)
    if (
      !expectedBinding
      || observed.has(binding.binding_id)
      || binding.target?.componentId !== expectedBinding.target.componentId
      || binding.target?.prop !== expectedBinding.target.prop
      || binding.source_kind !== expectedBinding.source.kind
      || !["resolved", "error"].includes(binding.status)
      || typeof binding.resolved_at !== "string"
      || binding.resolved_at.length < 1
      || binding.resolved_at.length > 256
      || binding.resolved_at !== candidate.resolved_at
      || !boundedStringArray(binding.source_ids, 2_000, 512)
      || !boundedStringArray(binding.source_revisions, 2_000, 512)
      || !(binding.freshness === undefined || binding.freshness === null
        || (typeof binding.freshness === "string" && binding.freshness.length <= 256))
      || !(binding.error === undefined
        || (typeof binding.error === "string" && binding.error.length <= 1_000))
      || (binding.status === "resolved" && binding.error !== undefined)
      || (binding.status === "error" && (
        typeof binding.error !== "string"
        || binding.error.length < 1
        || binding.source_ids !== undefined
        || binding.source_revisions !== undefined
        || binding.freshness !== undefined
      ))
    ) return null
    observed.add(binding.binding_id)
  }
  const scrubbedDefinition = scrubResolvedSurfaceBindings(candidate.definition, candidate.bindings)
  const scrubbedMaterialization = scrubResolvedSurfaceBindings(candidate.materialized_spec, candidate.bindings)
  if (!scrubbedDefinition || !scrubbedMaterialization
    || stableJson(scrubbedDefinition) !== stableJson(scrubbedMaterialization)) return null
  return candidate
}
