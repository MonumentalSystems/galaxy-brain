import { createGalaxyReference, parseGalaxyReference } from "./galaxy-reference-codec.js"

const CANONICAL_PREFIX = "gb:object:v1"
const MAX_IDENTIFIER_CHARACTERS = 512
const MAX_REVISION_CHARACTERS = 256
const MAX_SCOPE_CHARACTERS = 512
const MAX_REFERENCE_CHARACTERS = 16_384
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

export const GALAXY_OBJECT_KINDS = Object.freeze([
  "paper",
  "document",
  "document.anchor",
  "document.mark",
  "eln.experiment",
  "eln.observation",
  "eln.hypothesis",
  "ham.task",
  "ham.memory",
  "task-plan",
  "task-plan.job",
  "surface",
  "chat",
  "run",
  "turn",
  "claim",
  "artifact",
  "code.repo",
  "code.commit",
  "code.file",
  "code.symbol",
  "code.graph",
  "proof.graph",
  "proof.node",
])

const GALAXY_OBJECT_KIND_SET = new Set(GALAXY_OBJECT_KINDS)

function characterCount(value) {
  return Array.from(value).length
}

function normalizeBoundedValue(value, maximum) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  if (
    !normalized ||
    characterCount(normalized) > maximum ||
    CONTROL_CHARACTERS.test(normalized)
  ) {
    return null
  }
  return normalized
}

function normalizeCanonicalKind(value) {
  return typeof value === "string" && GALAXY_OBJECT_KIND_SET.has(value) ? value : null
}

function normalizeSelector(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  if (value.mode === "latest") {
    return Object.prototype.hasOwnProperty.call(value, "revision") ? null : Object.freeze({ mode: "latest" })
  }
  if (value.mode !== "pinned") return null
  const revision = normalizeBoundedValue(value.revision, MAX_REVISION_CHARACTERS)
  return revision ? Object.freeze({ mode: "pinned", revision }) : null
}

function normalizeResolutionScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const tenantId = normalizeBoundedValue(value.tenantId, MAX_SCOPE_CHARACTERS)
  const authorityScope = normalizeBoundedValue(value.authorityScope, MAX_SCOPE_CHARACTERS)
  return tenantId && authorityScope ? Object.freeze({ tenantId, authorityScope }) : null
}

function decodeBoundedValue(value, maximum) {
  try {
    return normalizeBoundedValue(decodeURIComponent(value), maximum)
  } catch {
    return null
  }
}

function canonicalReference(kind, id, selector) {
  return Object.freeze({
    schema: "gb.object-ref.v1",
    format: "canonical",
    kind,
    id,
    selector: Object.freeze(selector),
  })
}

/**
 * Serialize a typed Galaxy object reference. References name an object and a
 * revision-selection policy; they never confer access to that object.
 *
 * @param {string} kind
 * @param {string} id
 * @param {{ mode: "latest" } | { mode: "pinned", revision: string }} [selector]
 */
export function createGalaxyObjectReference(kind, id, selector = { mode: "latest" }) {
  const normalizedKind = normalizeCanonicalKind(kind)
  const normalizedId = normalizeBoundedValue(id, MAX_IDENTIFIER_CHARACTERS)
  const normalizedSelector = normalizeSelector(selector)
  if (!normalizedKind) throw new Error("Unsupported Galaxy object kind")
  if (!normalizedId) {
    throw new Error("Galaxy object references require an identifier between 1 and 512 characters without control characters")
  }
  if (!normalizedSelector) throw new Error("Galaxy object references require a latest or pinned revision selector")

  const base = `${CANONICAL_PREFIX}:${normalizedKind}:${encodeURIComponent(normalizedId)}`
  if (normalizedSelector.mode === "latest") return `${base}:latest`
  return `${base}:pinned:${encodeURIComponent(normalizedSelector.revision)}`
}

/**
 * Parse canonical object references and the legacy gb:entity:/gb:node: forms.
 * Parsing is fail-closed and bounded before percent decoding.
 *
 * @param {unknown} value
 */
export function parseGalaxyObjectReference(value) {
  if (typeof value !== "string" || !value || value.length > MAX_REFERENCE_CHARACTERS) return null

  const legacy = parseGalaxyReference(value)
  if (legacy) {
    if (!normalizeBoundedValue(legacy.id, MAX_IDENTIFIER_CHARACTERS)) return null
    return Object.freeze({
      schema: "gb.object-ref.v1",
      format: "legacy",
      kind: `legacy.${legacy.kind}`,
      id: legacy.id,
      selector: Object.freeze({ mode: "latest" }),
    })
  }

  const prefix = `${CANONICAL_PREFIX}:`
  if (!value.startsWith(prefix)) return null
  const segments = value.slice(prefix.length).split(":")
  if (segments.length !== 3 && segments.length !== 4) return null

  const [rawKind, rawId, mode, rawRevision] = segments
  const kind = normalizeCanonicalKind(rawKind)
  const id = decodeBoundedValue(rawId, MAX_IDENTIFIER_CHARACTERS)
  if (!kind || !id) return null
  if (mode === "latest" && segments.length === 3) {
    return canonicalReference(kind, id, { mode: "latest" })
  }
  if (mode !== "pinned" || segments.length !== 4) return null
  const revision = decodeBoundedValue(rawRevision, MAX_REVISION_CHARACTERS)
  return revision ? canonicalReference(kind, id, { mode: "pinned", revision }) : null
}

/** @param {unknown} reference */
export function serializeGalaxyObjectReference(reference) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new Error("Invalid Galaxy object reference")
  }
  const parsed = /** @type {Record<string, any>} */ (reference)
  if (parsed.schema !== "gb.object-ref.v1") throw new Error("Invalid Galaxy object reference")
  const id = normalizeBoundedValue(parsed.id, MAX_IDENTIFIER_CHARACTERS)
  const selector = normalizeSelector(parsed.selector)
  if (!id || !selector) throw new Error("Invalid Galaxy object reference")

  if (parsed.format === "legacy") {
    if (selector.mode !== "latest" || (parsed.kind !== "legacy.entity" && parsed.kind !== "legacy.node")) {
      throw new Error("Legacy Galaxy references only support latest entity or node selectors")
    }
    return createGalaxyReference(parsed.kind.slice("legacy.".length), id)
  }
  if (parsed.format !== "canonical") {
    throw new Error("Invalid Galaxy object reference")
  }
  const kind = normalizeCanonicalKind(parsed.kind)
  if (!kind) throw new Error("Invalid Galaxy object reference")
  return createGalaxyObjectReference(kind, id, selector)
}

/**
 * Convert a reference into a store-neutral request. The owning adapter decides
 * how to obtain a head or immutable revision and must apply authorization.
 *
 * @param {unknown} value
 * @param {unknown} scope
 */
export function planGalaxyObjectResolution(value, scope) {
  const reference = typeof value === "string" ? parseGalaxyObjectReference(value) : value
  const normalizedScope = normalizeResolutionScope(scope)
  if (!reference || typeof reference !== "object" || Array.isArray(reference) || !normalizedScope) return null

  try {
    const normalized = parseGalaxyObjectReference(serializeGalaxyObjectReference(reference))
    if (!normalized) return null
    const selectorKey = normalized.selector.mode === "latest"
      ? "latest"
      : `pinned:${encodeURIComponent(normalized.selector.revision)}`
    return Object.freeze({
      reference: normalized,
      scope: normalizedScope,
      identityKey: [
        "gb.resolve.v1",
        encodeURIComponent(normalizedScope.tenantId),
        encodeURIComponent(normalizedScope.authorityScope),
        normalized.kind,
        encodeURIComponent(normalized.id),
        selectorKey,
      ].join(":"),
      kind: normalized.kind,
      id: normalized.id,
      followLatest: normalized.selector.mode === "latest",
      revision: normalized.selector.mode === "pinned" ? normalized.selector.revision : null,
    })
  } catch {
    return null
  }
}

/**
 * Select, but do not invoke, a resolver for a planned reference. This keeps
 * parsing and dispatch free of network, database, and authorization effects.
 *
 * @param {unknown} value
 * @param {unknown} scope
 * @param {Record<string, Function>} resolvers
 */
export function selectGalaxyObjectResolver(value, scope, resolvers) {
  const request = planGalaxyObjectResolution(value, scope)
  if (!request || !resolvers || typeof resolvers !== "object" || Array.isArray(resolvers)) return null
  if (!Object.prototype.hasOwnProperty.call(resolvers, request.kind)) return null
  const resolver = resolvers[request.kind]
  return typeof resolver === "function" ? Object.freeze({ request, resolver }) : null
}
