import "server-only"

import type { CurrentUser } from "@/lib/auth"
import {
  evaluateHamSearchTenantAccess,
  resolveHamSearchBearer,
} from "@/lib/ham-search-proxy-config.js"
import {
  HamSearchBodyTooLargeError,
  HAM_SEARCH_RESPONSE_MAX_BYTES,
  readBoundedHamSearchText,
} from "@/lib/ham-search-bounds.js"

export class HamSearchProxyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail?: string,
  ) {
    super(message)
  }
}

function getConfig(user: CurrentUser) {
  const access = evaluateHamSearchTenantAccess(user, process.env)
  if (!access.allowed) {
    throw new HamSearchProxyError(access.message, access.status)
  }
  const baseUrl = process.env.HAM_API_INTERNAL
  const bearerToken = resolveHamSearchBearer(process.env)
  if (!baseUrl || !bearerToken) {
    throw new HamSearchProxyError("HAM search is not configured", 503)
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), bearerToken, tenantId: access.tenantId }
}

function safeUpstreamDetail(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const candidate = (value as { detail?: unknown; error?: unknown }).detail
    ?? (value as { error?: unknown }).error
  return typeof candidate === "string" && candidate.length <= 500 ? candidate : undefined
}

export function assertHamSearchOrigin(request: Request) {
  const origin = request.headers.get("origin")
  const expectedOrigin = (process.env.AUTH_ORIGIN || new URL(request.url).origin).replace(/\/$/, "")
  if (!origin || origin.replace(/\/$/, "") !== expectedOrigin) {
    throw new HamSearchProxyError("Search request origin is not allowed", 403)
  }
}

export async function fetchHamSearch(
  user: CurrentUser,
  route: { path: string; body: unknown },
) {
  const config = getConfig(user)
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${config.bearerToken}`,
    "Content-Type": "application/json",
    "X-GB-User-ID": config.tenantId,
    "X-HAM-Actor-Type": "interactive",
    "X-GB-Performed-By": `human:${user.id}`,
  })

  let response: Response
  try {
    response = await fetch(`${config.baseUrl}${route.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(route.body),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new HamSearchProxyError("HAM search service is unavailable", 502)
  }

  let responseText: string
  try {
    responseText = await readBoundedHamSearchText(
      response,
      HAM_SEARCH_RESPONSE_MAX_BYTES,
      "HAM search response is too large",
    )
  } catch (error) {
    if (error instanceof HamSearchBodyTooLargeError) {
      throw new HamSearchProxyError(error.message, 502)
    }
    throw new HamSearchProxyError("HAM search response could not be read", 502)
  }
  let responseBody: unknown = null
  try {
    responseBody = responseText ? JSON.parse(responseText) : null
  } catch {
    throw new HamSearchProxyError("HAM returned a non-JSON search response", 502)
  }
  if (!response.ok) {
    throw new HamSearchProxyError(
      "HAM search request failed",
      response.status,
      safeUpstreamDetail(responseBody),
    )
  }
  return responseBody
}
