import {
  HAM_RELATION_OVERLAY_MAX_LINKS_PER_MEMORY,
  HAM_RELATION_OVERLAY_MAX_RELATIONS,
  HAM_RELATION_OVERLAY_RESPONSE_SCHEMA_ID,
  parseHamRelationOverlayRequest,
  parseHamRelationOverlayResponse,
} from "./ham-relation-overlay-contract.js"
import { parseGalaxyObjectReference } from "./galaxy-object-reference.js"
import {
  evaluateHamSearchTenantAccess,
  resolveHamSearchBearer,
} from "./ham-search-proxy-config.js"

const UPSTREAM_MAX_BYTES = 1_048_576
const PROVIDER_CONCURRENCY = 6
const PROVIDER_TIMEOUT_MS = 5_000
const OVERALL_TIMEOUT_MS = 8_000
const MEMORY_ID = /^[1-9][0-9]{0,18}$/u
const MAX_INT64 = 9_223_372_036_854_775_807n
const TYPED_RELATIONS = new Set(["cites", "verifies", "contradicts", "depends-on"])

export class HamRelationOverlayProxyError extends Error {
  constructor(message = "HAM relation overlay is unavailable", status = 503) {
    super(message)
    this.name = "HamRelationOverlayProxyError"
    this.status = status
  }
}

function configuredOrigin(value) {
  if (typeof value !== "string" || !value) return null
  try {
    const url = new URL(value)
    if (
      !new Set(["http:", "https:"]).has(url.protocol)
      || url.username || url.password || url.search || url.hash
    ) return null
    url.pathname = url.pathname.replace(/\/+$/, "")
    return url
  } catch {
    return null
  }
}

function childUrl(base, path) {
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
  return url
}

function configuration(identity, environment) {
  const access = evaluateHamSearchTenantAccess(identity, environment)
  if (!access.allowed) throw new HamRelationOverlayProxyError(access.message, access.status)
  const base = configuredOrigin(environment.HAM_API_INTERNAL)
  const bearer = resolveHamSearchBearer(environment)
  if (!base || !bearer) throw new HamRelationOverlayProxyError()
  return {
    base,
    bearer,
    tenantId: access.tenantId,
    actorId: identity.nostrPubkey || `galaxy:${identity.principalId}`,
  }
}

function providerHeaders(config) {
  return new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${config.bearer}`,
    "X-GB-User-ID": config.tenantId,
    "X-HAM-Agent-ID": config.actorId,
    "X-HAM-Actor-Type": "service",
    "X-GB-Performed-By": "service:galaxy-brain-bff",
  })
}

async function cancelBody(response) {
  await response?.body?.cancel?.().catch(() => undefined)
}

async function boundedJson(response) {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (mediaType !== "application/json") {
    await cancelBody(response)
    throw new HamRelationOverlayProxyError()
  }
  const declared = Number(response.headers.get("content-length") || 0)
  if (Number.isFinite(declared) && declared > UPSTREAM_MAX_BYTES) {
    await cancelBody(response)
    throw new HamRelationOverlayProxyError()
  }
  if (!response.body) throw new HamRelationOverlayProxyError()
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > UPSTREAM_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new HamRelationOverlayProxyError()
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof HamRelationOverlayProxyError) throw error
    throw new HamRelationOverlayProxyError()
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body)
    return JSON.parse(text)
  } catch {
    throw new HamRelationOverlayProxyError()
  }
}

async function fetchHam(config, path, fetchImpl, overallSignal) {
  let response
  try {
    response = await fetchImpl(childUrl(config.base, path), {
      method: "GET",
      headers: providerHeaders(config),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([overallSignal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]),
    })
  } catch {
    throw new HamRelationOverlayProxyError()
  }
  if (response.status === 404) {
    await cancelBody(response)
    return undefined
  }
  if (!response.ok) {
    await cancelBody(response)
    throw new HamRelationOverlayProxyError()
  }
  return boundedJson(response)
}

function rawMemoryId(value) {
  const candidate = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value
  if (typeof candidate !== "string" || !MEMORY_ID.test(candidate)) return null
  try {
    return BigInt(candidate) <= MAX_INT64 ? candidate : null
  } catch {
    return null
  }
}

function rawVersion(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647 ? value : null
}

function memoryRecord(value, expectedId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const id = rawMemoryId(value.id)
  const version = rawVersion(value.version)
  if (id !== expectedId || version === null) return null
  const metadata = value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
    ? value.metadata
    : {}
  const supersededBy = value.superseded_by && typeof value.superseded_by === "object" && !Array.isArray(value.superseded_by)
    ? value.superseded_by.id
    : value.superseded_by
  return {
    id,
    version,
    supersedesId: rawMemoryId(value.supersedes_id ?? metadata.supersedes_id),
    supersededById: rawMemoryId(value.superseded_by_id ?? supersededBy ?? metadata.superseded_by),
  }
}

function memoryReference(id) {
  return `gb:object:v1:ham.memory:${id}:latest`
}

function typedRelations(rawLinks, viewedId) {
  if (!Array.isArray(rawLinks)) return { valid: false, truncated: false, relations: [] }
  const truncated = rawLinks.length > HAM_RELATION_OVERLAY_MAX_LINKS_PER_MEMORY
  const relations = []
  for (const raw of rawLinks.slice(0, HAM_RELATION_OVERLAY_MAX_LINKS_PER_MEMORY)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.state !== "active") continue
    const id = rawMemoryId(raw.id)
    const sourceId = rawMemoryId(raw.source_id)
    const targetId = rawMemoryId(raw.target_id)
    const version = rawVersion(raw.version)
    if (
      !id || !sourceId || !targetId || sourceId === targetId || version === null
      || !TYPED_RELATIONS.has(raw.relation)
      || (sourceId !== viewedId && targetId !== viewedId)
    ) continue
    relations.push({
      kind: "typed",
      id,
      sourceRef: memoryReference(sourceId),
      targetRef: memoryReference(targetId),
      relation: raw.relation,
      state: "active",
      version,
    })
  }
  return { valid: true, truncated, relations }
}

function lifecycleRelations(memory) {
  const relations = []
  if (memory.supersedesId && memory.supersedesId !== memory.id) {
    relations.push({
      kind: "lifecycle",
      id: `supersedes:${memory.id}:${memory.supersedesId}`,
      sourceRef: memoryReference(memory.id),
      targetRef: memoryReference(memory.supersedesId),
      relation: "supersedes",
      state: "active",
      version: memory.version,
    })
  }
  if (memory.supersededById && memory.supersededById !== memory.id) {
    relations.push({
      kind: "lifecycle",
      id: `superseded-by:${memory.id}:${memory.supersededById}`,
      sourceRef: memoryReference(memory.id),
      targetRef: memoryReference(memory.supersededById),
      relation: "superseded_by",
      state: "active",
      version: memory.version,
    })
  }
  return relations
}

function relationKey(relation) {
  return `${relation.kind}\u0000${relation.id}`
}

function relationValue(relation) {
  return [
    relation.sourceRef,
    relation.targetRef,
    relation.relation,
    relation.state,
    relation.version,
  ].join("\u0000")
}

function deduplicateRelations(relations) {
  const byKey = new Map()
  const conflicts = new Set()
  for (const relation of relations) {
    const key = relationKey(relation)
    if (conflicts.has(key)) continue
    const existing = byKey.get(key)
    if (existing && relationValue(existing) !== relationValue(relation)) {
      byKey.delete(key)
      conflicts.add(key)
      continue
    }
    byKey.set(key, relation)
  }
  return [...byKey.values()].sort((left, right) => (
    left.sourceRef.localeCompare(right.sourceRef)
    || left.targetRef.localeCompare(right.targetRef)
    || left.relation.localeCompare(right.relation)
    || left.id.localeCompare(right.id)
  ))
}

async function runJobs(jobs, signal) {
  const results = new Array(jobs.length)
  let cursor = 0
  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor
      cursor += 1
      if (signal.aborted) {
        results[index] = { status: "rejected", reason: new HamRelationOverlayProxyError() }
        continue
      }
      try {
        results[index] = { status: "fulfilled", value: await jobs[index]() }
      } catch (reason) {
        results[index] = { status: "rejected", reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROVIDER_CONCURRENCY, jobs.length) }, () => worker()))
  return results
}

/**
 * Read one bounded, follow-latest relation overlay. Upstream full-memory reads
 * are used only to authorize exact IDs and observe lineage; canonical bodies
 * never enter the returned envelope.
 */
export async function resolveHamRelationOverlay(
  input,
  identity,
  environment = process.env,
  fetchImpl = fetch,
  callerSignal,
) {
  const request = parseHamRelationOverlayRequest(input)
  const config = configuration(identity, environment)
  const parsed = request.references.map((reference) => parseGalaxyObjectReference(reference))
  const ids = parsed.map((reference) => reference.id)
  const controller = new AbortController()
  const signals = [controller.signal, AbortSignal.timeout(OVERALL_TIMEOUT_MS)]
  if (callerSignal) signals.push(callerSignal)
  const signal = AbortSignal.any(signals)
  try {
    const jobs = ids.flatMap((id) => [
      () => fetchHam(config, `/memories/${id}`, fetchImpl, signal),
      () => fetchHam(config, `/memories/${id}/links`, fetchImpl, signal),
    ])
    const settled = await runJobs(jobs, signal)
    const memories = new Map()
    const linkPages = new Map()
    let truncated = false
    ids.forEach((id, index) => {
      const memoryResult = settled[index * 2]
      if (memoryResult?.status === "fulfilled") {
        const memory = memoryRecord(memoryResult.value, id)
        if (memory) memories.set(id, memory)
      }
      const linksResult = settled[index * 2 + 1]
      if (linksResult?.status === "fulfilled") {
        const links = typedRelations(linksResult.value, id)
        if (links.valid) {
          linkPages.set(id, links.relations)
          truncated ||= links.truncated
        }
      }
    })

    const resolvedRefs = new Set([...memories.keys()].map(memoryReference))
    const candidates = []
    for (const memory of memories.values()) candidates.push(...lifecycleRelations(memory))
    for (const relations of linkPages.values()) candidates.push(...relations)
    const authorized = candidates.filter((relation) => (
      resolvedRefs.has(relation.sourceRef) && resolvedRefs.has(relation.targetRef)
    ))
    let relations = deduplicateRelations(authorized)
    if (relations.length > HAM_RELATION_OVERLAY_MAX_RELATIONS) {
      truncated = true
      relations = relations.slice(0, HAM_RELATION_OVERLAY_MAX_RELATIONS)
    }
    const results = request.references.map((requestedRef, index) => {
      const memory = memories.get(ids[index])
      return memory
        ? { requestedRef, status: "resolved", version: memory.version }
        : { requestedRef, status: "unavailable" }
    })
    return parseHamRelationOverlayResponse({
      schemaId: HAM_RELATION_OVERLAY_RESPONSE_SCHEMA_ID,
      provider: {
        name: "ham",
        status: memories.size > 0 ? "partial" : "unavailable",
        consistency: "follow-latest",
        truncated,
      },
      results,
      relations,
    }, request)
  } finally {
    controller.abort()
  }
}
