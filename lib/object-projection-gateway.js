import { parseGalaxyObjectReference } from "./galaxy-object-reference.js"
import { parseHamMemoryId, projectHamMemoryForBrowser } from "./ham-memory-contract.js"
import { resolveHamSearchBearer, evaluateHamSearchTenantAccess } from "./ham-search-proxy-config.js"
import { projectHamTaskDetailForBrowser } from "./ham-task-browser-projection.js"
import { evaluateHamTaskTenantAccess, resolveHamTaskProxyConfig } from "./ham-task-proxy-config.js"
import { parseObjectProjectionSourceResponse } from "./object-projection-resolution.js"

const SOURCE_REQUEST_SCHEMA_ID = "gb.object-projection-source-request.v3"
const SOURCE_REQUEST_SCHEMA_ID_V2 = "gb.object-projection-source-request.v2"
const SOURCE_REQUEST_SCHEMA_ID_V1 = "gb.object-projection-source-request.v1"
const SOURCE_RESPONSE_SCHEMA_ID = "gb.object-projection-source-response.v3"
const LOCAL_KINDS = new Set([
  "paper",
  "document",
  "document.anchor",
  "eln.experiment",
  "eln.observation",
  "surface",
  "chat",
  "proof.graph",
  "proof.node",
])
const HAM_TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/
const MAX_UPSTREAM_BYTES = 2_097_152
const PROVIDER_CONCURRENCY = 8
const PROVIDER_TIMEOUT_MS = 5_000
const REQUEST_TIMEOUT_MS = 8_000

function boundedDisplayText(value, maximum, fallback) {
  if (typeof value !== "string") return fallback
  const normalized = value.replace(/[\u0000-\u0020\u007f-\u009f]+/gu, " ").trim()
  if (!normalized) return fallback
  const characters = Array.from(normalized)
  return characters.length <= maximum
    ? normalized
    : `${characters.slice(0, maximum - 1).join("")}…`
}

export class ObjectProjectionGatewayError extends Error {
  constructor(message = "Object projection provider is unavailable") {
    super(message)
    this.name = "ObjectProjectionGatewayError"
  }
}

function unavailable(requestedRef) {
  return Object.freeze({ requestedRef, status: "unavailable" })
}

function configuredOrigin(value) {
  if (typeof value !== "string" || !value) return null
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return null
    }
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

function providerSignal(overallSignal) {
  return AbortSignal.any([overallSignal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)])
}

async function boundedJson(response, maximumBytes = MAX_UPSTREAM_BYTES) {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (mediaType !== "application/json") {
    await response.body?.cancel().catch(() => undefined)
    throw new ObjectProjectionGatewayError()
  }
  const declared = Number(response.headers.get("content-length") || 0)
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new ObjectProjectionGatewayError()
  }
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ObjectProjectionGatewayError()
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof ObjectProjectionGatewayError) throw error
    throw new ObjectProjectionGatewayError()
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(joined)
    return text ? JSON.parse(text) : null
  } catch {
    throw new ObjectProjectionGatewayError()
  }
}

async function isLegacyProjectionSchemaRejection(response) {
  if (response.status !== 422) return false
  try {
    const payload = await boundedJson(response, 4_096)
    return Boolean(
      payload
      && typeof payload === "object"
      && !Array.isArray(payload)
      && Object.keys(payload).length === 1
      && payload.detail === "Unsupported projection request schema",
    )
  } catch {
    return false
  }
}

function privateHeaders(identity, environment, version = "v2") {
  const proxyToken = environment.GALAXY_API_PROXY_TOKEN
  if (typeof proxyToken !== "string" || !proxyToken) throw new ObjectProjectionGatewayError()
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${proxyToken}`,
    "Content-Type": "application/json",
    "X-GB-Proxy-Token": proxyToken,
    "X-GB-Tenant-ID": identity.tenantId,
    "X-GB-Principal-ID": identity.principalId,
    "X-GB-Principal-Kind": identity.kind,
    "X-GB-Projection-Gateway": version,
  })
  if (identity.nostrPubkey) headers.set("X-GB-Nostr-Pubkey", identity.nostrPubkey)
  return headers
}

async function localSources(references, identity, environment, fetchImpl, signal) {
  if (references.length === 0) return []
  const base = configuredOrigin(environment.GALAXY_API_INTERNAL || "http://localhost:8044")
  if (!base) throw new ObjectProjectionGatewayError()
  const request = async (schemaId, version) => fetchImpl(
    childUrl(base, "/object-projection-sources/resolve"),
    {
      method: "POST",
      headers: privateHeaders(identity, environment, version),
      body: JSON.stringify({ schemaId, references }),
      cache: "no-store",
      redirect: "error",
      signal: providerSignal(signal),
    },
  )
  let response
  let requestSchemaId = SOURCE_REQUEST_SCHEMA_ID
  try {
    const contracts = [
      [SOURCE_REQUEST_SCHEMA_ID, "v3"],
      [SOURCE_REQUEST_SCHEMA_ID_V2, "v2"],
      [SOURCE_REQUEST_SCHEMA_ID_V1, "v1"],
    ]
    for (const [schemaId, version] of contracts) {
      requestSchemaId = schemaId
      response = await request(schemaId, version)
      const retryOlder = response.status === 404
        || await isLegacyProjectionSchemaRejection(response)
      if (!retryOlder) break
      if (response.status === 404) await response.body?.cancel().catch(() => undefined)
    }
  } catch {
    throw new ObjectProjectionGatewayError()
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new ObjectProjectionGatewayError()
  }
  const payload = await boundedJson(response)
  try {
    return parseObjectProjectionSourceResponse(payload, {
      schemaId: requestSchemaId,
      references,
    }).results
  } catch {
    throw new ObjectProjectionGatewayError()
  }
}

function hamHeaders(bearer, tenantId) {
  return new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${bearer}`,
    "X-GB-User-ID": tenantId,
    "X-HAM-Actor-Type": "service",
    "X-GB-Performed-By": "service:galaxy-brain-bff",
  })
}

async function fetchHamPayload(base, path, bearer, tenantId, fetchImpl, signal) {
  let response
  try {
    response = await fetchImpl(childUrl(base, path), {
      method: "GET",
      headers: hamHeaders(bearer, tenantId),
      cache: "no-store",
      redirect: "error",
      signal: providerSignal(signal),
    })
  } catch {
    throw new ObjectProjectionGatewayError()
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new ObjectProjectionGatewayError()
  }
  return boundedJson(response)
}

function hamTaskConfig(identity, environment) {
  const access = evaluateHamTaskTenantAccess(identity, environment)
  if (!access.allowed && access.status === 403) return null
  const config = resolveHamTaskProxyConfig("detail", environment)
  const base = config && configuredOrigin(config.baseUrl)
  if (!access.allowed || !config || !base) throw new ObjectProjectionGatewayError()
  return { base, bearer: config.bearerToken, tenantId: access.tenantId }
}

function hamMemoryConfig(identity, environment) {
  const access = evaluateHamSearchTenantAccess(identity, environment)
  if (!access.allowed && access.status === 403) return null
  const base = configuredOrigin(environment.HAM_API_INTERNAL)
  const bearer = resolveHamSearchBearer(environment)
  if (!access.allowed || !base || !bearer) throw new ObjectProjectionGatewayError()
  return { base, bearer, tenantId: access.tenantId }
}

async function hamSource(reference, parsed, identity, environment, fetchImpl, signal, configs) {
  if (parsed.selector.mode !== "latest") return unavailable(reference)
  if (parsed.kind === "ham.task") {
    if (!HAM_TASK_ID.test(parsed.id)) return unavailable(reference)
    if (configs.task === undefined) configs.task = hamTaskConfig(identity, environment)
    if (configs.task === null) return unavailable(reference)
    const payload = await fetchHamPayload(
      configs.task.base,
      `/tasks/${encodeURIComponent(parsed.id)}`,
      configs.task.bearer,
      configs.task.tenantId,
      fetchImpl,
      signal,
    )
    if (payload === undefined) return unavailable(reference)
    if (
      !payload || typeof payload !== "object" || Array.isArray(payload)
      || payload.task_id !== parsed.id
      || !Number.isSafeInteger(payload.version) || payload.version < 1
    ) throw new ObjectProjectionGatewayError()
    let task
    try {
      task = projectHamTaskDetailForBrowser(payload)
    } catch {
      throw new ObjectProjectionGatewayError()
    }
    if (!task || task.id !== parsed.id) throw new ObjectProjectionGatewayError()
    return Object.freeze({
      requestedRef: reference,
      status: "resolved",
      resolvedRef: reference,
      provider: "ham",
      sourceKind: "ham.task",
      source: Object.freeze({
        id: task.id,
        title: boundedDisplayText(task.title, 240, "Untitled task"),
        goal: boundedDisplayText(task.goal, 4_000, undefined),
        why: boundedDisplayText(task.why, 4_000, undefined),
        ...(task.version ? { version: task.version } : {}),
      }),
    })
  }
  try {
    if (parseHamMemoryId(parsed.id) !== parsed.id) return unavailable(reference)
  } catch {
    return unavailable(reference)
  }
  if (configs.memory === undefined) configs.memory = hamMemoryConfig(identity, environment)
  if (configs.memory === null) return unavailable(reference)
  const payload = await fetchHamPayload(
    configs.memory.base,
    `/memories/${parsed.id}`,
    configs.memory.bearer,
    configs.memory.tenantId,
    fetchImpl,
    signal,
  )
  if (payload === undefined) return unavailable(reference)
  const payloadId = typeof payload?.id === "number" && Number.isSafeInteger(payload.id) && payload.id > 0
    ? String(payload.id)
    : payload?.id
  if (payloadId !== parsed.id || !Number.isSafeInteger(payload?.version) || payload.version < 1) {
    throw new ObjectProjectionGatewayError()
  }
  let memory
  try {
    memory = projectHamMemoryForBrowser(payload)
  } catch {
    throw new ObjectProjectionGatewayError()
  }
  if (memory.id !== parsed.id) throw new ObjectProjectionGatewayError()
  return Object.freeze({
    requestedRef: reference,
    status: "resolved",
    resolvedRef: reference,
    provider: "ham",
    sourceKind: "ham.memory",
    source: Object.freeze({
      id: memory.id,
      title: boundedDisplayText(memory.title, 240, `HAM memory ${memory.id}`),
      content: boundedDisplayText(memory.content, 4_000, "Memory content unavailable"),
      ...(memory.version ? { version: memory.version } : {}),
    }),
  })
}

/**
 * Resolve authorization-filtered, projector-minimal sources. Canonical bodies
 * and provider diagnostics never cross this boundary.
 */
export async function resolveObjectProjectionSources(
  references,
  identity,
  environment = process.env,
  fetchImpl = fetch,
) {
  const parsed = references.map((reference) => parseGalaxyObjectReference(reference))
  const local = []
  const ham = []
  for (let index = 0; index < references.length; index += 1) {
    if (LOCAL_KINDS.has(parsed[index]?.kind)) local.push(references[index])
    else if (["ham.task", "ham.memory"].includes(parsed[index]?.kind)) ham.push(index)
  }

  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  try {
    const [localResults, hamResults] = await Promise.all([
      localSources(local, identity, environment, fetchImpl, signal),
      (async () => {
        const results = new Map()
        const configs = {}
        // The local resolver occupies one outbound slot while it is active, so
        // HAM shares the same global eight-request ceiling.
        const concurrency = Math.max(1, PROVIDER_CONCURRENCY - (local.length ? 1 : 0))
        for (let start = 0; start < ham.length; start += concurrency) {
          const batch = ham.slice(start, start + concurrency)
          const values = await Promise.all(batch.map((index) => hamSource(
            references[index], parsed[index], identity, environment, fetchImpl, signal, configs,
          )))
          batch.forEach((index, offset) => results.set(references[index], values[offset]))
        }
        return results
      })(),
    ])
    const localByRef = new Map(localResults.map((result) => [result?.requestedRef, result]))
    return Object.freeze({
      schemaId: SOURCE_RESPONSE_SCHEMA_ID,
      results: Object.freeze(references.map((reference, index) => {
        if (LOCAL_KINDS.has(parsed[index]?.kind)) return localByRef.get(reference) || unavailable(reference)
        return hamResults.get(reference) || unavailable(reference)
      })),
    })
  } catch (error) {
    controller.abort()
    if (error instanceof ObjectProjectionGatewayError) throw error
    throw new ObjectProjectionGatewayError()
  }
}
