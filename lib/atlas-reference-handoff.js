import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"

export const ATLAS_REFERENCE_HANDOFF_PARAMETER = "placeRef"

const MAX_HANDOFF_REFERENCE_CHARACTERS = 1024
const SHA256_REVISION = /^sha256:([0-9a-f]{64})$/u
const VERSION_REVISION = /^version:[1-9][0-9]*$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const HANDOFF_PROFILES = Object.freeze({
  document: Object.freeze({ provider: "galaxy.document", sourceRevisionRequired: true, provenanceRevision: "pinned" }),
  chat: Object.freeze({ provider: "galaxy.conversation", sourceRevisionRequired: false, provenanceRevision: "pinned" }),
  surface: Object.freeze({ provider: "galaxy.surface", sourceRevisionRequired: false, provenanceRevision: "version" }),
})

function rejected(code) {
  return Object.freeze({ ok: false, code })
}

/** Inspect the deliberately narrow reference profile supported by Atlas handoff. */
export function inspectAtlasReferenceHandoff(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_HANDOFF_REFERENCE_CHARACTERS
  ) {
    return rejected("invalid_reference")
  }

  const reference = parseGalaxyObjectReference(value)
  if (!reference || reference.format !== "canonical") return rejected("invalid_reference")
  if (serializeGalaxyObjectReference(reference) !== value) return rejected("noncanonical_reference")
  const profile = HANDOFF_PROFILES[reference.kind]
  if (!profile) return rejected("unsupported_kind")
  if (reference.selector.mode !== "pinned") return rejected("pinned_required")

  const revision = SHA256_REVISION.exec(reference.selector.revision)
  if (!revision) return rejected("invalid_revision")
  return Object.freeze({
    ok: true,
    subjectRef: value,
    kind: reference.kind,
    objectId: reference.id,
    revisionSha256: revision[1],
  })
}

/** Build an Atlas URL containing intent only, never an implicit placement command. */
export function atlasReferenceHandoffHref(subjectRef) {
  const inspected = inspectAtlasReferenceHandoff(subjectRef)
  if (!inspected.ok) {
    throw new TypeError(`Invalid Atlas reference handoff: ${inspected.code}`)
  }
  return `/workspace?${new URLSearchParams({
    [ATLAS_REFERENCE_HANDOFF_PARAMETER]: inspected.subjectRef,
  }).toString()}`
}

/** Parse handoff intent independently of canvas/placement selection. */
export function parseAtlasReferenceHandoff(search) {
  const parameters = new URLSearchParams(String(search || "").replace(/^\?/, ""))
  const values = parameters.getAll(ATLAS_REFERENCE_HANDOFF_PARAMETER)
  if (values.length === 0) return Object.freeze({ state: "none" })
  if (values.length !== 1) {
    return Object.freeze({ state: "invalid", code: "duplicate_intent" })
  }

  const inspected = inspectAtlasReferenceHandoff(values[0])
  if (!inspected.ok) return Object.freeze({ state: "invalid", code: inspected.code })
  return Object.freeze({
    state: "ready",
    subjectRef: inspected.subjectRef,
    kind: inspected.kind,
    objectId: inspected.objectId,
    revisionSha256: inspected.revisionSha256,
  })
}

/** Remove only the one-shot handoff intent after dismissal, failure, or success. */
export function clearAtlasReferenceHandoffHref(href) {
  if (typeof href !== "string" || !href) {
    throw new TypeError("Invalid Atlas reference handoff URL")
  }
  const target = new URL(href, "https://galaxy.invalid")
  target.searchParams.delete(ATLAS_REFERENCE_HANDOFF_PARAMETER)
  return `${target.pathname}${target.search}${target.hash}`
}

/**
 * Re-authorize an exact handoff response before presenting placement confirmation.
 * This does not place anything and never substitutes a latest or different revision.
 */
export function authorizeAtlasReferenceHandoff(subjectRef, resolution, expected) {
  const inspected = inspectAtlasReferenceHandoff(subjectRef)
  if (!inspected.ok) return inspected
  if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) {
    return rejected("unavailable")
  }
  if (resolution.status !== "resolved") return rejected("unavailable")
  if (
    resolution.requestedRef !== inspected.subjectRef ||
    resolution.resolvedRef !== inspected.subjectRef ||
    !resolution.projection ||
    typeof resolution.projection !== "object" ||
    Array.isArray(resolution.projection) ||
    resolution.projection.ref !== inspected.subjectRef
  ) {
    return rejected("identity_mismatch")
  }

  const projection = resolution.projection
  const profile = HANDOFF_PROFILES[inspected.kind]
  const sourceRevisionId = resolution.documentRevisionId
  if (
    projection.kind !== inspected.kind ||
    resolution.provider !== profile.provider ||
    projection.provenance?.provider !== profile.provider ||
    projection.provenance?.sourceId !== inspected.objectId
  ) {
    return rejected("source_mismatch")
  }
  if (profile.sourceRevisionRequired && (typeof sourceRevisionId !== "string" || !UUID.test(sourceRevisionId))) {
    return rejected("revision_mismatch")
  }
  if (!profile.sourceRevisionRequired && sourceRevisionId !== undefined) {
    return rejected("revision_mismatch")
  }

  const pinnedRevision = `sha256:${inspected.revisionSha256}`
  if (
    projection.revision?.policy !== "pinned" ||
    projection.revision?.id !== pinnedRevision ||
    projection.revision?.contentHash !== inspected.revisionSha256
  ) {
    return rejected("revision_mismatch")
  }
  if (
    (profile.provenanceRevision === "pinned" && projection.provenance?.sourceRevision !== pinnedRevision) ||
    (profile.provenanceRevision === "version" && !VERSION_REVISION.test(projection.provenance?.sourceRevision || ""))
  ) return rejected("revision_mismatch")
  if (!Array.isArray(projection.capabilities) || !projection.capabilities.includes("place")) {
    return rejected("source_mismatch")
  }

  if (expected !== undefined) {
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
      return rejected("source_mismatch")
    }
    if (
      (expected.kind !== undefined && expected.kind !== inspected.kind) ||
      (expected.objectId !== undefined && expected.objectId !== inspected.objectId) ||
      (expected.sourceRevisionId !== undefined && expected.sourceRevisionId !== sourceRevisionId) ||
      (expected.revisionSha256 !== undefined && expected.revisionSha256 !== inspected.revisionSha256)
    ) {
      return rejected("source_mismatch")
    }
  }

  return Object.freeze({
    ok: true,
    subjectRef: inspected.subjectRef,
    kind: inspected.kind,
    objectId: inspected.objectId,
    ...(sourceRevisionId ? { sourceRevisionId } : {}),
    revisionSha256: inspected.revisionSha256,
    projection,
  })
}
