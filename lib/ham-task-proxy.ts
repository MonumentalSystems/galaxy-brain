import "server-only"

import type { CurrentUser } from "@/lib/auth"
import { readBoundedResponseText, ResponseBodyTooLargeError } from "@/lib/bounded-response.js"
import {
  buildHamTaskCreateBody,
  HAM_TASK_DETAIL_RESPONSE_MAX_BYTES,
  HAM_TASK_EVENTS_RESPONSE_MAX_BYTES,
  parseHamTaskAcceptanceCriteria,
  parseHamTaskActivityMode,
  parseHumanTaskResources,
} from "@/lib/ham-task-contract"
import { evaluateHamTaskTenantAccess, resolveHamTaskProxyConfig } from "@/lib/ham-task-proxy-config"
import { getHamTaskProxyRoute } from "@/lib/ham-task-proxy-policy"

type ProxyOperation = "create" | "page" | "detail" | "events" | "externalComplete"

export class HamTaskProxyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message)
  }
}

export function getHamTaskProjectRef() {
  return process.env.HAM_TASK_PROJECT_REF || "galaxy-brain"
}

export function hamTaskMutationsEnabled() {
  return process.env.HAM_TASK_MUTATIONS === "enabled"
}

function getConfig(operation: ProxyOperation, user: CurrentUser) {
  const readOnly = operation === "page" || operation === "detail" || operation === "events"
  const access = evaluateHamTaskTenantAccess(user, process.env)
  if (!access.allowed) {
    throw new HamTaskProxyError(
      access.message || "HAM task integration is not authorized",
      access.status || 403,
    )
  }
  const config = resolveHamTaskProxyConfig(operation, process.env)
  if (!config) {
    throw new HamTaskProxyError(
      readOnly
        ? "HAM task read transport is not configured"
        : "HAM task write transport is not configured",
      503,
    )
  }
  if (!readOnly && !hamTaskMutationsEnabled()) {
    throw new HamTaskProxyError("HAM task mutations are disabled by Galaxy Brain policy", 403)
  }
  return config
}

export function createHumanTaskPayload(
  input: unknown,
  user: CurrentUser,
  idempotencyKey: string,
) {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {}
  const title = typeof source.title === "string" ? source.title.trim() : ""
  const goal = typeof source.goal === "string" ? source.goal.trim() : ""
  const why = typeof source.why === "string" ? source.why.trim() : ""
  const resourceMode = typeof source.resourceMode === "string" ? source.resourceMode : "observe"
  const resourceKeys = Array.isArray(source.resourceKeys) ? source.resourceKeys : []

  if (!title || !goal || !why) {
    throw new HamTaskProxyError("title, goal, and why are required", 400)
  }
  if (title.length > 200 || goal.length > 4_000 || why.length > 4_000) {
    throw new HamTaskProxyError("task input exceeds the allowed length", 400)
  }
  if (!resourceKeys.some((key) => typeof key === "string" && key.trim()) && resourceMode !== "observe") {
    throw new HamTaskProxyError("a resource key is required before selecting resource intent", 400)
  }
  // HAM owns the canonical Task. The authenticated human is the requester;
  // the BFF credential is transport authority only and is never represented
  // as an executor or claimant. Activity mode is context, not a capability.
  let resources
  let riskMode
  let acceptanceCriteria
  try {
    resources = parseHumanTaskResources(resourceKeys, resourceMode)
    riskMode = parseHamTaskActivityMode(source.riskMode)
    acceptanceCriteria = parseHamTaskAcceptanceCriteria(source.acceptanceCriteria)
  } catch (error) {
    throw new HamTaskProxyError(error instanceof Error ? error.message : "Task input is invalid", 400)
  }

  return buildHamTaskCreateBody({
    title,
    goal,
    rationale: why,
    activityMode: riskMode,
    requesterRef: `galaxy-brain:user:${user.id}`,
    idempotencyKey,
    resources,
    acceptanceCriteria,
  })
}

export async function fetchHamTask(
  operation: ProxyOperation,
  options: {
    user: CurrentUser
    projectRef?: string
    taskId?: string
    body?: unknown
    idempotencyKey?: string | null
    signal?: AbortSignal
  },
) {
  const config = getConfig(operation, options.user)
  const route = getHamTaskProxyRoute(operation, options)
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${config.bearerToken}`,
    "Content-Type": "application/json",
    "X-GB-Performed-By": "service:galaxy-brain-bff",
    "X-GB-Requester-ID": options.user.id,
    "X-GB-Requester-Type": "human",
  })
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey)

  let response: Response
  try {
    const timeout = AbortSignal.timeout(15_000)
    response = await fetch(`${config.baseUrl}${route.path}`, {
      method: route.method,
      headers,
      body: route.method === "GET" ? undefined : JSON.stringify(options.body || {}),
      cache: "no-store",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    })
  } catch {
    throw new HamTaskProxyError("HAM task service is unavailable", 502)
  }

  if (operation === "detail" && !response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new HamTaskProxyError("HAM task request failed", response.status)
  }
  let responseText: string
  try {
    const maximumResponseBytes = operation === "detail"
      ? HAM_TASK_DETAIL_RESPONSE_MAX_BYTES
      : operation === "events"
        ? HAM_TASK_EVENTS_RESPONSE_MAX_BYTES
        : null
    responseText = maximumResponseBytes === null
      ? await response.text()
      : await readBoundedResponseText(response, maximumResponseBytes)
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      throw new HamTaskProxyError("HAM task response is too large", 502)
    }
    throw new HamTaskProxyError("HAM task response could not be read", 502)
  }
  let responseBody: unknown = null
  try {
    responseBody = responseText ? JSON.parse(responseText) : null
  } catch {
    responseBody = { error: "HAM returned a non-JSON response" }
  }
  if (!response.ok) {
    throw new HamTaskProxyError("HAM task request failed", response.status, responseBody)
  }
  return responseBody
}
