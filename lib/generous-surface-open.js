import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "./object-projection.js"
import { getObjectProjector } from "./object-projector-registry.js"

const SHA256 = /^[a-f0-9]{64}$/u
const SURFACE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const VERSION = /^version:([1-9][0-9]*)$/u

/**
 * Build the fixed same-origin viewer destination for one exact, registered
 * Generous surface projection. Graph nodes are presentation data, so every
 * identity-bearing field is revalidated instead of trusting a node label or
 * caller-supplied projector metadata.
 */
export function exactGenerousSurfaceHref(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null
  if (node.kind !== "surface" || typeof node.ref !== "string") return null
  if (
    !node.projection
    || typeof node.projection !== "object"
    || Array.isArray(node.projection)
    || node.projection.ref !== node.ref
  ) return null

  let projection
  try {
    projection = createGalaxyObjectProjection(node.projection)
  } catch {
    return null
  }
  if (projection.kind !== "surface" || projection.ref !== node.ref) return null

  const reference = parseGalaxyObjectReference(node.ref)
  if (
    !reference
    || reference.format !== "canonical"
    || reference.kind !== "surface"
    || reference.selector.mode !== "pinned"
    || serializeGalaxyObjectReference(reference) !== node.ref
    || !SURFACE_UUID.test(reference.id)
  ) return null

  const revision = reference.selector.revision
  if (!revision.startsWith("sha256:")) return null
  const hash = revision.slice("sha256:".length)
  if (!SHA256.test(hash)) return null
  if (
    projection.revision.policy !== "pinned"
    || projection.revision.id !== revision
    || projection.revision.contentHash !== hash
  ) return null

  if (
    projection.representations.length !== 1
    || projection.representations[0].kind !== "surface"
    || projection.representations[0].mediaType !== "application/json"
    || projection.representations[0].contentHash !== hash
  ) return null

  const provenance = projection.provenance
  const versionMatch = VERSION.exec(provenance.sourceRevision ?? "")
  if (
    provenance.provider !== "galaxy.surface"
    || provenance.sourceId !== reference.id
    || !versionMatch
  ) return null
  const version = Number(versionMatch[1])
  if (!Number.isSafeInteger(version) || version < 1) return null
  if (!projection.capabilities.includes("open")) return null

  let projector
  try {
    projector = getObjectProjector(projection)
  } catch {
    return null
  }
  if (
    projector.id !== "surface"
    || projector.pluginId !== "generous"
    || projector.implementationId !== "builtin.object-projector.surface"
  ) return null

  const parameters = new URLSearchParams({
    surface: reference.id,
    version: String(version),
    hash,
  })
  return `/surfaces?${parameters}`
}
