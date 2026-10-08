import "server-only"

import type { CurrentUser } from "@/lib/auth"
import {
  buildHamSupersedeUpstreamBody,
  buildHamMemoryView,
  findHamMemoryLinkSource,
  HAM_MEMORY_UPSTREAM_REQUEST_MAX_BYTES,
  HAM_MEMORY_UPSTREAM_RESPONSE_MAX_BYTES,
  hamMemoryAdjacentIds,
  parseHamMemoryId,
} from "@/lib/ham-memory-contract.js"
import {
  evaluateHamSearchTenantAccess,
  resolveHamSearchBearer,
} from "@/lib/ham-search-proxy-config.js"
import { refreshCommittedHamMemory } from "@/lib/ham-memory-mutation-result.js"

type HamMemoryMutation =
  | {
      action: "supersede"
      body: {
        expectedVersion: number
        idempotencyKey: string
        content?: string
        title?: string | null
        type?: string | null
        project?: string | null
        repo?: string | null
        task?: string | null
        sequence?: string | null
        scopes?: string[]
        cues?: string[]
        reason?: string | null
      }
    }
  | { action: "link"; targetMemoryId: string; relation: string }
  | { action: "unlink"; linkId: string; expectedVersion: number; reason?: string | null }

type HamProxyConfig = {
  baseUrl: string
  bearerToken: string
  tenantId: string
  actorId: string
}

export class HamMemoryProxyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail?: string,
  ) {
    super(message)
  }
}

function configuredBaseUrl() {
  const value = process.env.HAM_API_INTERNAL
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.pathname = url.pathname.replace(/\/+$/, "")
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/$/, "")
  } catch {
    return null
  }
}

function getConfig(user: CurrentUser): HamProxyConfig {
  const access = evaluateHamSearchTenantAccess(user, process.env)
  if (!access.allowed) {
    throw new HamMemoryProxyError(access.message, access.status)
  }
  const baseUrl = configuredBaseUrl()
  const bearerToken = resolveHamSearchBearer(process.env)
  if (!baseUrl || !bearerToken) {
    throw new HamMemoryProxyError("HAM memory transport is not configured", 503)
  }
  return {
    baseUrl,
    bearerToken,
    tenantId: access.tenantId,
    actorId: user.nostrPubkey || `galaxy:${user.principalId}`,
  }
}

function safeUpstreamDetail(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const candidate = (value as { detail?: unknown; error?: unknown }).detail
    ?? (value as { error?: unknown }).error
  if (typeof candidate === "string" && candidate.length <= 500) return candidate
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const code = (candidate as { code?: unknown }).code
    return typeof code === "string" && code.length <= 120 ? code : undefined
  }
  return undefined
}

export function assertHamMemoryMutationOrigin(request: Request) {
  const origin = request.headers.get("origin")
  let expectedOrigin: string
  try {
    expectedOrigin = new URL(process.env.AUTH_ORIGIN || request.url).origin
  } catch {
    throw new HamMemoryProxyError("HAM memory mutation origin is not configured", 503)
  }
  let suppliedOrigin: string | null = null
  try {
    suppliedOrigin = origin ? new URL(origin).origin : null
  } catch {
    suppliedOrigin = null
  }
  if (!suppliedOrigin || suppliedOrigin !== expectedOrigin) {
    throw new HamMemoryProxyError("HAM memory mutation origin is not allowed", 403)
  }
}

export async function readHamMemoryResponseText(
  response: Response,
  maximumBytes = HAM_MEMORY_UPSTREAM_RESPONSE_MAX_BYTES,
) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new HamMemoryProxyError("HAM memory response is too large", 502)
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new HamMemoryProxyError("HAM memory response is too large", 502)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof HamMemoryProxyError) throw error
    throw new HamMemoryProxyError("HAM memory response could not be read", 502)
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

async function requestHam(
  config: HamProxyConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  const encodedBody = body === undefined ? undefined : JSON.stringify(body)
  if (encodedBody && new TextEncoder().encode(encodedBody).byteLength > HAM_MEMORY_UPSTREAM_REQUEST_MAX_BYTES) {
    throw new HamMemoryProxyError("HAM memory request is too large", 502)
  }
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${config.bearerToken}`,
    "X-GB-User-ID": config.tenantId,
    "X-HAM-Agent-ID": config.actorId,
    "X-HAM-Actor-Type": "interactive",
    "X-GB-Performed-By": "service:galaxy-brain-bff",
  })
  if (body !== undefined) headers.set("Content-Type", "application/json")

  let response: Response
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers,
      body: encodedBody,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new HamMemoryProxyError("HAM memory service is unavailable", 502)
  }

  const responseText = await readHamMemoryResponseText(response)
  let responseBody: unknown = null
  try {
    responseBody = responseText ? JSON.parse(responseText) : null
  } catch {
    throw new HamMemoryProxyError("HAM returned a non-JSON memory response", 502)
  }
  if (!response.ok) {
    throw new HamMemoryProxyError(
      "HAM memory request failed",
      response.status,
      safeUpstreamDetail(responseBody),
    )
  }
  return responseBody
}

function exactMemoryPath(memoryId: string) {
  return `/memories/${parseHamMemoryId(memoryId)}`
}

async function aggregateHamMemory(config: HamProxyConfig, memoryId: string) {
  const id = parseHamMemoryId(memoryId)
  const [rawMemory, rawLinks] = await Promise.all([
    requestHam(config, "GET", exactMemoryPath(id)),
    requestHam(config, "GET", `${exactMemoryPath(id)}/links`),
  ])
  const adjacentIds = hamMemoryAdjacentIds(rawMemory, rawLinks)
  const adjacent = new Map<string, unknown>()
  for (let offset = 0; offset < adjacentIds.length; offset += 6) {
    const batch = adjacentIds.slice(offset, offset + 6)
    const results = await Promise.allSettled(
      batch.map((adjacentId) => requestHam(config, "GET", exactMemoryPath(adjacentId))),
    )
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]
      if (result.status === "fulfilled") adjacent.set(batch[index], result.value)
      else if (!(result.reason instanceof HamMemoryProxyError && result.reason.status === 404)) {
        throw result.reason
      }
    }
  }
  return buildHamMemoryView(rawMemory, rawLinks, adjacent)
}

export async function fetchHamMemory(user: CurrentUser, memoryId: string) {
  return aggregateHamMemory(getConfig(user), parseHamMemoryId(memoryId))
}

export async function mutateHamMemory(
  user: CurrentUser,
  memoryId: string,
  mutation: HamMemoryMutation,
) {
  const id = parseHamMemoryId(memoryId)
  const config = getConfig(user)
  let resultMemoryId = id

  if (mutation.action === "supersede") {
    const rawMemory = await requestHam(config, "GET", exactMemoryPath(id))
    const result = await requestHam(
      config,
      "POST",
      `${exactMemoryPath(id)}/supersede`,
      buildHamSupersedeUpstreamBody(rawMemory, mutation.body),
    )
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new HamMemoryProxyError("HAM returned an invalid supersession response", 502)
    }
    resultMemoryId = parseHamMemoryId((result as { id?: unknown }).id, "Replacement memory ID")
  } else if (mutation.action === "link") {
    if (mutation.targetMemoryId === id) {
      throw new HamMemoryProxyError("A memory cannot link to itself", 400)
    }
    await requestHam(config, "POST", `${exactMemoryPath(id)}/links`, {
      target_id: mutation.targetMemoryId,
      relation: mutation.relation,
    })
  } else {
    const rawLinks = await requestHam(config, "GET", `${exactMemoryPath(id)}/links`)
    if (!Array.isArray(rawLinks)) {
      throw new HamMemoryProxyError("HAM returned an invalid memory-links response", 502)
    }
    const sourceId = findHamMemoryLinkSource(rawLinks, id, mutation.linkId)
    await requestHam(config, "POST", `${exactMemoryPath(sourceId)}/links/${mutation.linkId}/retract`, {
      expected_version: mutation.expectedVersion,
      ...(mutation.reason === undefined ? {} : { reason: mutation.reason }),
    })
  }

  // The mutation response above is the durable acknowledgement. A bounded
  // neighborhood read is only a projection refresh and must never turn a
  // committed write into a retryable failure.
  return refreshCommittedHamMemory(
    mutation.action,
    resultMemoryId,
    (committedMemoryId) => aggregateHamMemory(config, committedMemoryId),
  )
}
