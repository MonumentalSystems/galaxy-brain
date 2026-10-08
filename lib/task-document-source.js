import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DEFAULT_CONCURRENCY = 4

/**
 * Accept only canonical, byte-for-byte round-trippable pinned document anchors.
 * A resource string is an identifier, never authority; the API still performs
 * the tenant-scoped authorization before a reader link can be built.
 *
 * @param {unknown} value
 */
export function parsePinnedDocumentAnchorResource(value) {
  const parsed = parseGalaxyObjectReference(value)
  if (
    !parsed
    || parsed.format !== "canonical"
    || parsed.kind !== "document.anchor"
    || parsed.selector.mode !== "pinned"
  ) return null
  try {
    if (serializeGalaxyObjectReference(parsed) !== value) return null
  } catch {
    return null
  }
  return Object.freeze({
    resourceRef: value,
    anchorId: parsed.id,
    revision: parsed.selector.revision,
  })
}

function exactReaderLink(resource, anchor) {
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return null
  if (
    anchor.schemaId !== "gb.anchor.v1"
    || anchor.id !== resource.anchorId
    || anchor.ref !== resource.resourceRef
    || typeof anchor.document_revision_id !== "string"
    || !UUID.test(anchor.document_revision_id)
  ) return null

  const selector = anchor.selector
  const selectedPage = selector && typeof selector === "object" && !Array.isArray(selector)
    && Number.isSafeInteger(selector.page) && selector.page > 0
    ? selector.page
    : 1
  const query = new URLSearchParams({
    paperView: "pdf",
    paperPage: String(selectedPage),
    paperAnchor: resource.anchorId,
  })
  return Object.freeze({
    resourceRef: resource.resourceRef,
    anchorId: resource.anchorId,
    href: `/documents/${encodeURIComponent(anchor.document_revision_id.toLowerCase())}?${query}`,
  })
}

/**
 * Resolve authorized document resources with bounded concurrency. Duplicate
 * claims are fetched once and failures remain unlinked rather than weakening
 * the exact-reference check.
 *
 * @param {unknown[]} resourceRefs
 * @param {{ fetcher?: typeof fetch, signal?: AbortSignal, concurrency?: number }} [options]
 */
export async function loadTaskDocumentSources(resourceRefs, options = {}) {
  if (!Array.isArray(resourceRefs)) return []
  const fetcher = options.fetcher ?? fetch
  if (typeof fetcher !== "function") throw new TypeError("A fetch function is required")
  const requestedConcurrency = Number.isSafeInteger(options.concurrency) ? options.concurrency : DEFAULT_CONCURRENCY
  const concurrency = Math.max(1, Math.min(8, requestedConcurrency))
  const resources = []
  const seen = new Set()
  for (const value of resourceRefs) {
    const resource = parsePinnedDocumentAnchorResource(value)
    if (!resource || seen.has(resource.resourceRef)) continue
    seen.add(resource.resourceRef)
    resources.push(resource)
  }

  const resolved = new Array(resources.length).fill(null)
  let cursor = 0
  async function worker() {
    while (cursor < resources.length) {
      const index = cursor
      cursor += 1
      const resource = resources[index]
      try {
        const response = await fetcher(
          `/api/eln/document-anchors/${encodeURIComponent(resource.anchorId)}`,
          { cache: "no-store", signal: options.signal },
        )
        if (!response.ok) continue
        resolved[index] = exactReaderLink(resource, await response.json())
      } catch {
        // Authorization, transport, malformed JSON, and aborts all fail closed.
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, resources.length) },
    () => worker(),
  ))
  return resolved.filter(Boolean)
}
