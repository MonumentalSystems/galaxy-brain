import { AgentToolContractError } from "./contracts.js"
import { createGalaxyObjectReference } from "../galaxy-object-reference.js"
import {
  parseHamSearchRequest,
  projectHamSearchResultsForBrowser,
} from "../ham-search-contract.js"
import {
  HAM_SEARCH_RESPONSE_MAX_BYTES,
  readBoundedHamSearchText,
} from "../ham-search-bounds.js"
import {
  evaluateHamSearchTenantAccess,
  resolveHamSearchBearer,
} from "../ham-search-proxy-config.js"

const AGENT_RESULT_MAX_BYTES = 900 * 1024
const RESULT_CONTENT_MAX_BYTES = 16 * 1024
const MEMORY_ID = /^[1-9][0-9]{0,18}$/u
const MAX_INT64 = 9_223_372_036_854_775_807n
const NOSTR_PUBKEY = /^[0-9a-f]{64}$/u

function fail(code = "provider_unavailable", message = "HAM memory search is unavailable", status = 503) {
  throw new AgentToolContractError(code, message, status)
}

function configuredOrigin(value) {
  if (typeof value !== "string" || !value) return null
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.search || url.hash) return null
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

function memoryId(value) {
  if (typeof value !== "string" || !MEMORY_ID.test(value)) return null
  try {
    return BigInt(value) <= MAX_INT64 ? value : null
  } catch {
    return null
  }
}

function actorId(identity) {
  if (typeof identity?.nostrPubkey === "string" && NOSTR_PUBKEY.test(identity.nostrPubkey)) {
    return identity.nostrPubkey
  }
  if (typeof identity?.principalId !== "string" || !identity.principalId
    || identity.principalId.length > 512 || /[\r\n]/u.test(identity.principalId)) fail("forbidden", "HAM memory search is not authorized", 403)
  return `galaxy:${identity.principalId}`
}

function configuration(identity, environment) {
  if (typeof identity?.tenantId !== "string" || !identity.tenantId) {
    fail("forbidden", "HAM memory search is not authorized", 403)
  }
  const access = evaluateHamSearchTenantAccess(identity, environment)
  if (!access.allowed) fail(
    access.status === 403 ? "forbidden" : "provider_unavailable",
    access.status === 403 ? "HAM memory search is not authorized" : "HAM memory search is not configured",
    access.status,
  )
  const base = configuredOrigin(environment.HAM_API_INTERNAL)
  const bearer = resolveHamSearchBearer(environment)
  if (!base || !bearer) fail("provider_unavailable", "HAM memory search is not configured", 503)
  return Object.freeze({ base, bearer, tenantId: access.tenantId, actorId: actorId(identity) })
}

function providerHeaders(config) {
  return new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${config.bearer}`,
    "Content-Type": "application/json",
    "X-GB-User-ID": config.tenantId,
    "X-HAM-Agent-ID": config.actorId,
    "X-HAM-Actor-Type": "service",
    "X-GB-Performed-By": "service:galaxy-brain-agent-tool",
  })
}

function truncateUtf8(value, maximum) {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maximum) return Object.freeze({ value, truncated: false })
  for (let end = maximum; end >= Math.max(0, maximum - 3); end -= 1) {
    try {
      return Object.freeze({
        value: new TextDecoder("utf-8", { fatal: true }).decode(encoded.slice(0, end)),
        truncated: true,
      })
    } catch {
      // UTF-8 code points use at most four bytes; try the preceding boundary.
    }
  }
  fail("invalid_provider_response", "HAM memory search returned an invalid response", 502)
}

function outputBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function projectAgentResults(raw, mode, topK) {
  const rawItems = Array.isArray(raw) ? raw : raw?.items
  if (Array.isArray(rawItems)) {
    for (const rawItem of rawItems) {
      if (rawItem && typeof rawItem === "object" && !Array.isArray(rawItem)
        && typeof rawItem.id === "number"
        && (!Number.isSafeInteger(rawItem.id) || rawItem.id < 1)) {
        fail("invalid_provider_response", "HAM memory search returned an invalid response", 502)
      }
    }
  }
  let projected
  try {
    projected = projectHamSearchResultsForBrowser(raw)
  } catch {
    fail("invalid_provider_response", "HAM memory search returned an invalid response", 502)
  }
  const validated = projected.map((item) => {
    const id = memoryId(item.id)
    if (!id) fail("invalid_provider_response", "HAM memory search returned an invalid response", 502)
    return Object.freeze({ item, id })
  })
  let truncated = (Array.isArray(rawItems) && rawItems.length > projected.length)
    || validated.length > topK
  const items = []
  for (const { item, id } of validated.slice(0, topK)) {
    const content = truncateUtf8(item.content, RESULT_CONTENT_MAX_BYTES)
    const normalized = Object.freeze({
      ref: createGalaxyObjectReference("ham.memory", id),
      content: content.value,
      contentTruncated: content.truncated,
      tier: item.tier,
      ...(item.score === undefined ? {} : { score: item.score }),
      ...(item.hop === undefined ? {} : { hop: item.hop }),
      ...(item.via_cue === undefined ? {} : { viaCue: item.via_cue }),
      ...(item.timestamp === undefined ? {} : { timestamp: item.timestamp }),
      ...(item.state === undefined ? {} : { state: item.state }),
      ...(item.version === undefined ? {} : { version: item.version }),
      metadata: Object.freeze({ ...item.metadata }),
      ...(item.temporal === undefined ? {} : { temporal: Object.freeze({ ...item.temporal }) }),
    })
    const candidate = { provider: "ham", mode, truncated: false, items: [...items, normalized] }
    if (outputBytes(candidate) > AGENT_RESULT_MAX_BYTES) {
      truncated = true
      break
    }
    truncated ||= content.truncated
    items.push(normalized)
  }
  return Object.freeze({
    provider: "ham",
    mode,
    truncated,
    items: Object.freeze(items),
  })
}

/**
 * Read bounded HAM memory search results through server-owned configuration.
 * Tool input cannot select tenant, actor, endpoint, bearer, or provider route.
 */
export async function searchHamMemoriesForAgent(
  input,
  context,
  environment = context.environment || process.env,
  fetchImpl = context.fetchImpl || fetch,
) {
  const route = parseHamSearchRequest(input)
  const config = configuration(context.identity, environment)
  let response
  try {
    response = await fetchImpl(childUrl(config.base, route.path), {
      method: "POST",
      headers: providerHeaders(config),
      body: JSON.stringify(route.body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    fail("provider_unavailable", "HAM memory search is unavailable", 502)
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (!response.ok || mediaType !== "application/json") {
    await response.body?.cancel().catch(() => undefined)
    fail(
      response.ok ? "invalid_provider_response" : "provider_unavailable",
      response.ok ? "HAM memory search returned an invalid response" : "HAM memory search is unavailable",
      502,
    )
  }
  let raw
  try {
    const text = await readBoundedHamSearchText(
      response,
      HAM_SEARCH_RESPONSE_MAX_BYTES,
      "HAM memory search response is too large",
    )
    raw = JSON.parse(text)
  } catch {
    fail("invalid_provider_response", "HAM memory search returned an invalid response", 502)
  }
  return Object.freeze({ result: projectAgentResults(raw, route.mode, route.body.top_k) })
}

export const HAM_AGENT_SEARCH_RESULT_MAX_BYTES = AGENT_RESULT_MAX_BYTES
export const HAM_AGENT_SEARCH_CONTENT_MAX_BYTES = RESULT_CONTENT_MAX_BYTES
