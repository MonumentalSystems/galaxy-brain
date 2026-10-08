import { isFreshAuthentication } from "./ham-admin-contract.js"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HYADES_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function normalizedServerUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null
  try {
    const parsed = new URL(value)
    if (!["http:", "https:"].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.search || parsed.hash) return null
    return parsed.toString().replace(/\/$/, "")
  } catch {
    return null
  }
}

export function evaluateTaskPlanRunAccess(user, environment) {
  const tenantId = environment.TASK_PLAN_EXECUTOR_GALAXY_TENANT_ID
  if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
    return { allowed: false, status: 503, message: "Task-plan execution is not bound to a Galaxy tenant" }
  }
  if (!user || user.tenantId.toLowerCase() !== tenantId.toLowerCase()) {
    return { allowed: false, status: 403, message: "Task-plan execution is not authorized for this Galaxy tenant" }
  }
  if (user.role !== "owner" && user.role !== "admin") {
    return { allowed: false, status: 403, message: "Task-plan execution requires a Galaxy owner or admin" }
  }
  return { allowed: true }
}

function normalizedOrigin(value) {
  if (typeof value !== "string" || !value) return null
  try { return new URL(value).origin } catch { return null }
}

export function evaluateTaskPlanRunMutationAuthority(
  user,
  requestUrl,
  requestOrigin,
  environment,
  nowMs = Date.now(),
) {
  const expectedOrigin = normalizedOrigin(environment.AUTH_ORIGIN || requestUrl)
  if (!expectedOrigin || normalizedOrigin(requestOrigin) !== expectedOrigin) {
    return { allowed: false, status: 403, message: "Task-plan execution origin is not allowed" }
  }
  const configured = Number(environment.TASK_PLAN_EXECUTOR_MAX_SESSION_AGE_MINUTES || 15)
  const maxAgeMinutes = Number.isFinite(configured) ? configured : 15
  if (!isFreshAuthentication(user?.authenticatedAt, nowMs, maxAgeMinutes)) {
    return { allowed: false, status: 403, message: "Task-plan execution requires recent authentication" }
  }
  return { allowed: true }
}

export function resolveTaskPlanRunConfig(environment) {
  const baseUrl = normalizedServerUrl(
    environment.HYADES_TASK_PLAN_API_INTERNAL || environment.HYADES_PROGRAM_CONTROL_API_INTERNAL,
  )
  const bearerToken = environment.GALAXY_DEPLOY_HYADES_TASK_PLAN_OPERATOR_BEARER_TOKEN
    || environment.HYADES_TASK_PLAN_OPERATOR_BEARER_TOKEN
  const hyadesTenant = environment.HYADES_TASK_PLAN_TENANT
  const hamProject = environment.HYADES_TASK_PLAN_HAM_PROJECT
  const galaxyApiUrl = normalizedServerUrl(environment.GALAXY_API_INTERNAL || "http://galaxy-brain-api:8044")
  const galaxyApiToken = environment.GALAXY_API_PROXY_TOKEN
  if (!baseUrl || !galaxyApiUrl
    || typeof bearerToken !== "string" || !bearerToken.trim()
    || typeof galaxyApiToken !== "string" || !galaxyApiToken.trim()
    || typeof hyadesTenant !== "string" || !HYADES_SCOPE_PATTERN.test(hyadesTenant)
    || typeof hamProject !== "string" || !HYADES_SCOPE_PATTERN.test(hamProject)) return null
  return { baseUrl, bearerToken, hyadesTenant, hamProject, galaxyApiUrl, galaxyApiToken }
}
