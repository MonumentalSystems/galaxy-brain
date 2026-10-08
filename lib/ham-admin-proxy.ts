import "server-only"

import type { CurrentUser } from "@/lib/auth"
import { evaluateHamAdminAccess } from "@/lib/ham-admin-access.js"
import {
  collectHamAdminPages,
  getHamAdminReadRoutes,
  isFreshAuthentication,
} from "@/lib/ham-admin-contract.js"

const MEMBER_FETCH_CONCURRENCY = 6

export class HamAdminProxyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message)
  }
}

type HamAdminMutation = {
  method: "POST" | "DELETE"
  path: string
  body: unknown
}

function getConfig() {
  const baseUrl = process.env.HAM_ADMIN_API_INTERNAL
  const bearerToken = process.env.HAM_ADMIN_API_BEARER_TOKEN
  const tenantId = process.env.HAM_ADMIN_TENANT_ID
  if (!baseUrl || !bearerToken || !tenantId) {
    throw new HamAdminProxyError("HAM owner administration is not configured", 503)
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), bearerToken, tenantId }
}

function assertHamAdminAccess(user: CurrentUser) {
  const decision = evaluateHamAdminAccess(user, process.env)
  if (!decision.allowed) {
    throw new HamAdminProxyError(
      decision.message || "HAM owner administration is not authorized",
      decision.status || 403,
    )
  }
}

function requestHeaders(user: CurrentUser) {
  assertHamAdminAccess(user)
  const config = getConfig()
  return {
    config,
    headers: new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${config.bearerToken}`,
      "Content-Type": "application/json",
      "X-GB-User-ID": config.tenantId,
      "X-HAM-Agent-ID": user.nostrPubkey!,
      "X-HAM-Actor-Type": "interactive",
      "X-GB-Performed-By": `human:${user.id}`,
    }),
  }
}

async function requestHam(
  user: CurrentUser,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
) {
  const { config, headers } = requestHeaders(user)
  let response: Response
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new HamAdminProxyError("HAM administration service is unavailable", 502)
  }

  const responseText = await response.text()
  let responseBody: unknown = null
  try {
    responseBody = responseText ? JSON.parse(responseText) : null
  } catch {
    responseBody = { error: "HAM returned a non-JSON response" }
  }
  if (!response.ok) {
    throw new HamAdminProxyError("HAM administration request failed", response.status, responseBody)
  }
  return responseBody
}

async function requestAllRows(
  user: CurrentUser,
  idField: string,
  pathForPage: (offset: number, limit: number) => string,
) {
  try {
    return await collectHamAdminPages(
      (offset: number, limit: number) => requestHam(user, "GET", pathForPage(offset, limit)),
      idField,
    )
  } catch (error) {
    if (error instanceof HamAdminProxyError) throw error
    throw new HamAdminProxyError(
      error instanceof Error ? error.message : "HAM inventory pagination failed",
      502,
    )
  }
}

export function adminSessionIsFresh(user: CurrentUser) {
  const configured = Number(process.env.HAM_ADMIN_MAX_SESSION_AGE_MINUTES || 15)
  const maxAgeMinutes = Number.isFinite(configured) ? configured : 15
  return isFreshAuthentication(user.authenticatedAt, Date.now(), maxAgeMinutes)
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin")
  const expectedOrigin = (process.env.AUTH_ORIGIN || new URL(request.url).origin).replace(/\/$/, "")
  if (!origin || origin.replace(/\/$/, "") !== expectedOrigin) {
    throw new HamAdminProxyError("Admin mutation origin is not allowed", 403)
  }
}

export async function fetchHamAdminOverview(user: CurrentUser) {
  const identity = await requestHam(user, "GET", getHamAdminReadRoutes()[0].path)
  const role = (identity as { role?: unknown })?.role
  if (role !== "admin") {
    throw new HamAdminProxyError("Configured HAM credential is not an administrator", 403)
  }
  const [projects, principals] = await Promise.all([
    requestAllRows(user, "project_id", (offset, limit) => getHamAdminReadRoutes([], offset, limit)[1].path),
    requestAllRows(user, "pubkey", (offset, limit) => getHamAdminReadRoutes([], offset, limit)[2].path),
  ])
  const projectRows = projects as Array<{ project_id: string }>
  const membersByProject: Record<string, unknown[]> = {}
  for (let start = 0; start < projectRows.length; start += MEMBER_FETCH_CONCURRENCY) {
    const batch = projectRows.slice(start, start + MEMBER_FETCH_CONCURRENCY)
    const batchMembers = await Promise.all(batch.map(async (project) => {
      const members = await requestAllRows(
        user,
        "membership_id",
        (offset, limit) => getHamAdminReadRoutes([project.project_id], offset, limit)[3].path,
      )
      return [project.project_id, members] as const
    }))
    for (const [projectId, members] of batchMembers) membersByProject[projectId] = members
  }
  return {
    identity,
    galaxyIdentity: {
      principalId: user.principalId,
      authMethod: user.authMethod,
      nostrPubkey: user.nostrPubkey,
    },
    projects: projectRows,
    principals,
    membersByProject,
    sessionFresh: adminSessionIsFresh(user),
  }
}

export async function mutateHamAdmin(
  user: CurrentUser,
  mutation: HamAdminMutation,
) {
  if (!adminSessionIsFresh(user)) {
    throw new HamAdminProxyError(
      "Sign out and sign in with the configured Nostr key before changing HAM principals.",
      403,
      { code: "reauthentication_required", error: "Recent sign-in required." },
    )
  }
  return requestHam(user, mutation.method, mutation.path, mutation.body)
}
