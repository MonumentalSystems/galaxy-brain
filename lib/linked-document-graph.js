import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "./galaxy-object-reference.js"
import { parseHamMemoryId } from "./ham-memory-contract.js"

const SHA256_REVISION = /^sha256:[a-f0-9]{64}$/u
const DOCUMENT_KINDS = new Set(["document", "document.anchor"])
const CHAT_KINDS = new Set(["chat"])
const SURFACE_KINDS = new Set(["surface"])
const ELN_OBSERVATION_KINDS = new Set(["eln.observation"])
const PINNED_LINK_ENDPOINT_KINDS = new Set(["paper", "document", "document.anchor", "eln.observation", "chat", "surface"])
export const LINKED_PROJECTION_LIMIT = 64

function exactPinnedReference(value, kinds) {
  const parsed = parseGalaxyObjectReference(value)
  if (
    !parsed
    || parsed.format !== "canonical"
    || parsed.selector.mode !== "pinned"
    || !SHA256_REVISION.test(parsed.selector.revision)
    || !kinds.has(parsed.kind)
  ) return null
  return serializeGalaxyObjectReference(parsed)
}

export function isPinnedDocumentProjectionReference(value) {
  return exactPinnedReference(value, DOCUMENT_KINDS) !== null
}

export function isPinnedChatProjectionReference(value) {
  return exactPinnedReference(value, CHAT_KINDS) !== null
}

export function isPinnedSurfaceProjectionReference(value) {
  return exactPinnedReference(value, SURFACE_KINDS) !== null
}

export function isPinnedElnObservationProjectionReference(value) {
  return exactPinnedReference(value, ELN_OBSERVATION_KINDS) !== null
}

export function isLatestHamMemoryProjectionReference(value) {
  const parsed = parseGalaxyObjectReference(value)
  if (
    !parsed
    || parsed.format !== "canonical"
    || parsed.kind !== "ham.memory"
    || parsed.selector.mode !== "latest"
  ) return false
  try {
    return parseHamMemoryId(parsed.id) === parsed.id
  } catch {
    return false
  }
}

export function isGraphGatewayProjectionReference(value) {
  return isPinnedDocumentProjectionReference(value)
    || isPinnedChatProjectionReference(value)
    || isPinnedSurfaceProjectionReference(value)
    || isPinnedElnObservationProjectionReference(value)
    || isLatestHamMemoryProjectionReference(value)
}

function linkedGatewayReference(value) {
  const pinned = exactPinnedReference(value, PINNED_LINK_ENDPOINT_KINDS)
  if (pinned) return pinned
  if (!isLatestHamMemoryProjectionReference(value)) return null
  const parsed = parseGalaxyObjectReference(value)
  return parsed ? serializeGalaxyObjectReference(parsed) : null
}

export function selectMissingLinkedProjectionReferences(links, authorizedReferences, limit = LINKED_PROJECTION_LIMIT) {
  const authorized = new Set(authorizedReferences)
  const candidates = []
  const seen = new Set()
  for (const link of Array.isArray(links) ? links : []) {
    for (const value of [link?.from_ref, link?.to_ref]) {
      const reference = linkedGatewayReference(value)
      if (!reference || authorized.has(reference) || seen.has(reference)) continue
      seen.add(reference)
      candidates.push(reference)
    }
  }
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, LINKED_PROJECTION_LIMIT)
    : LINKED_PROJECTION_LIMIT
  return Object.freeze({
    references: Object.freeze(candidates.slice(0, boundedLimit)),
    total: candidates.length,
    capped: candidates.length > boundedLimit,
  })
}

export function linkedProjectionProviderStatus(attemptedReferences, resolvedReferences, capped = false) {
  const attempted = new Set(attemptedReferences)
  if (attempted.size === 0) return null
  const resolved = new Set(resolvedReferences)
  const resolvedCount = [...attempted].filter((reference) => resolved.has(reference)).length
  if (resolvedCount === 0) return "unavailable"
  return capped || resolvedCount < attempted.size ? "partial" : "ready"
}
