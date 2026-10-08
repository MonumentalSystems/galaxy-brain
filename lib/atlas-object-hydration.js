import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"
import {
  GALAXY_OBJECT_PROJECTION_RESOLUTION_REQUEST_SCHEMA_ID,
  MAX_OBJECT_PROJECTION_REFERENCES,
  MAX_OBJECT_PROJECTION_REQUEST_BYTES,
  MAX_OBJECT_PROJECTION_RESPONSE_BYTES,
  parseObjectProjectionResolutionResponse,
} from "./object-projection-resolution.js"

const ENDPOINT = "/api/eln/object-projections/resolve"
const DEFAULT_CONCURRENCY = 3
const MAX_CONCURRENCY = 8

function canonicalSubjectReference(value) {
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical") return null
  try {
    const serialized = serializeGalaxyObjectReference(parsed)
    return serialized === value ? serialized : null
  } catch {
    return null
  }
}

function stableCanonicalReferences(values) {
  if (!Array.isArray(values)) return []
  const references = []
  const seen = new Set()
  for (const value of values) {
    const reference = canonicalSubjectReference(value)
    if (!reference || seen.has(reference)) continue
    seen.add(reference)
    references.push(reference)
  }
  return references
}

function requestFailure(requestedRef) {
  return Object.freeze({ requestedRef, status: "request-failed" })
}

function requestBody(references) {
  return JSON.stringify({
    schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_REQUEST_SCHEMA_ID,
    references,
  })
}

function requestBodyBytes(references) {
  return new TextEncoder().encode(requestBody(references)).byteLength
}

function chunks(values) {
  const result = []
  let current = []
  for (const value of values) {
    const candidate = [...current, value]
    if (
      current.length > 0
      && (candidate.length > MAX_OBJECT_PROJECTION_REFERENCES
        || requestBodyBytes(candidate) > MAX_OBJECT_PROJECTION_REQUEST_BYTES)
    ) {
      result.push(current)
      current = [value]
    } else {
      current = candidate
    }
  }
  if (current.length > 0) result.push(current)
  return result
}

async function cancelBody(response) {
  await response?.body?.cancel?.().catch(() => undefined)
}

async function parseBoundedJson(response) {
  const mediaType = response.headers?.get?.("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (mediaType !== "application/json") {
    await cancelBody(response)
    throw new TypeError("Object projection response is not JSON")
  }
  const declared = Number(response.headers?.get?.("content-length") || 0)
  if (Number.isFinite(declared) && declared > MAX_OBJECT_PROJECTION_RESPONSE_BYTES) {
    await cancelBody(response)
    throw new RangeError("Object projection response is too large")
  }
  if (!response.body) throw new TypeError("Object projection response has no body")

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_OBJECT_PROJECTION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new RangeError("Object projection response is too large")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  const encoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body)
  return JSON.parse(encoded)
}

async function resolveChunk(references, fetcher, signal) {
  const request = Object.freeze({
    schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_REQUEST_SCHEMA_ID,
    references: Object.freeze([...references]),
  })
  try {
    const response = await fetcher(ENDPOINT, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
      signal,
    })
    if (!response?.ok) {
      await cancelBody(response)
      throw new Error("Object projection request failed")
    }
    return parseObjectProjectionResolutionResponse(await parseBoundedJson(response), request).results
  } catch {
    // A transport, authorization, abort, oversized body, or malformed response
    // invalidates the whole chunk. Never retain a partially trusted payload.
    return references.map(requestFailure)
  }
}

function hydrationResult(references, results) {
  const byReference = Object.create(null)
  results.forEach((result, index) => {
    if (result.requestedRef !== references[index]) {
      throw new TypeError("Atlas hydration result order drifted")
    }
    byReference[result.requestedRef] = result
  })
  return Object.freeze({
    references: Object.freeze([...references]),
    results: Object.freeze([...results]),
    byReference: Object.freeze(byReference),
  })
}

function lockedPlacement(placement) {
  return {
    id: placement.id,
    authorized: false,
    availability: "unavailable",
    subjectRef: placement.subjectRef,
    nodeType: placement.nodeType,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: placement.angle,
    zIndex: placement.zIndex,
    displayMode: placement.displayMode,
    collapsed: placement.collapsed,
    style: placement.style,
  }
}

/**
 * Remove legacy preview content from durable placements until the gateway has
 * resolved that exact object. This is a transient render overlay only; callers
 * must never serialize it into a canvas snapshot.
 */
export function applyAtlasHydrationAvailability(projection, snapshot, hydrationByReference) {
  const removed = new Set(snapshot?.removedItemIds ?? [])
  const durable = new Map((snapshot?.items ?? [])
    .filter((item) => !removed.has(item.id))
    .map((item) => [item.id, item]))
  const lockedIds = new Set()
  const placements = projection.placements.map((placement) => {
    const item = durable.get(placement.id)
    if (
      !item
      || item.subjectRef !== placement.subjectRef
      || item.nodeType !== placement.nodeType
      || hydrationByReference?.[placement.subjectRef]?.status === "resolved"
    ) return placement
    lockedIds.add(placement.id)
    return lockedPlacement(placement)
  })
  const relations = projection.relations.filter((relation) => (
    !lockedIds.has(relation.sourcePlacementId) && !lockedIds.has(relation.targetPlacementId)
  ))
  return { placements, relations }
}

/**
 * Resolve canonical Atlas subject references without introducing a client-side
 * canonical-content store. Invalid inputs are omitted, duplicates are fetched
 * once, and each accepted reference receives exactly one stable outcome.
 *
 * @param {ReadonlyArray<unknown>} subjectRefs
 * @param {{ fetcher?: typeof fetch, signal?: AbortSignal, concurrency?: number }} [options]
 */
export async function hydrateAtlasObjectReferences(subjectRefs, options = {}) {
  const references = stableCanonicalReferences(subjectRefs)
  if (references.length === 0) return hydrationResult([], [])

  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== "function") throw new TypeError("A fetch function is required")
  const requestedConcurrency = Number.isSafeInteger(options.concurrency)
    ? options.concurrency
    : DEFAULT_CONCURRENCY
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, requestedConcurrency))
  const batches = chunks(references)
  const batchResults = new Array(batches.length)
  let cursor = 0

  async function worker() {
    while (cursor < batches.length) {
      const index = cursor
      cursor += 1
      if (options.signal?.aborted) {
        batchResults[index] = batches[index].map(requestFailure)
        continue
      }
      batchResults[index] = await resolveChunk(batches[index], fetcher, options.signal)
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, batches.length) },
    () => worker(),
  ))

  return hydrationResult(references, batchResults.flat())
}

/**
 * Context-neutral alias for callers that need the same bounded, authorized
 * object-projection gateway without any Atlas placement behavior.
 */
export const resolveObjectProjectionReferences = hydrateAtlasObjectReferences
