import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "../galaxy-object-reference.js"

const GRAPH_FIELD_REFERENCE_KINDS = new Set([
  "paper",
  "document",
  "document.anchor",
  "eln.experiment",
  "eln.observation",
  "ham.task",
  "ham.memory",
  "task-plan",
  "task-plan.job",
  "surface",
  "proof.graph",
  "proof.node",
])

const LENS_DESTINATIONS = Object.freeze([
  Object.freeze({ id: "graph", pathname: "/graph", label: "Open in Graph" }),
  Object.freeze({ id: "field", pathname: "/field", label: "Open in Field" }),
])

const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/u

function exactCanonicalReference(value) {
  const parsed = parseGalaxyObjectReference(value)
  if (parsed?.format !== "canonical") return null
  try {
    return serializeGalaxyObjectReference(parsed) === value ? parsed : null
  } catch {
    return null
  }
}

function sameObject(requested, resolved) {
  if (requested.kind !== resolved.kind || requested.id !== resolved.id) return false
  if (requested.selector.mode !== "pinned") return true
  return resolved.selector.mode === "pinned"
    && resolved.selector.revision === requested.selector.revision
}

/**
 * Build side-effect-free lens links only from an authorized Atlas resolution.
 * The destination must independently authorize the canonical reference again.
 */
export function atlasContextLensLinks(subjectRef, hydration) {
  if (
    !hydration
    || typeof hydration !== "object"
    || Array.isArray(hydration)
    || hydration.status !== "resolved"
    || hydration.requestedRef !== subjectRef
  ) return Object.freeze([])

  const requested = exactCanonicalReference(subjectRef)
  const resolved = exactCanonicalReference(hydration.resolvedRef)
  if (
    !requested
    || !resolved
    || !sameObject(requested, resolved)
    || (resolved.kind === "eln.observation" && (
      resolved.selector.mode !== "pinned" || !SHA256_REVISION.test(resolved.selector.revision)
    ))
    || !GRAPH_FIELD_REFERENCE_KINDS.has(resolved.kind)
    || hydration.projection?.schemaId !== "gb.object-projection.v1"
    || hydration.projection.ref !== hydration.resolvedRef
    || hydration.projection.kind !== resolved.kind
  ) return Object.freeze([])

  const encoded = encodeURIComponent(hydration.resolvedRef)
  return Object.freeze(LENS_DESTINATIONS.map((destination) => Object.freeze({
    id: destination.id,
    label: destination.label,
    href: `${destination.pathname}?ref=${encoded}`,
  })))
}
