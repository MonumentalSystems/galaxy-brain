import { isFreshAuthentication } from "./ham-admin-contract.js"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function evaluateProofCampaignAccess(user, environment) {
  const galaxyTenantId = environment.PROOF_CAMPAIGN_GALAXY_TENANT_ID
  if (typeof galaxyTenantId !== "string" || !UUID_PATTERN.test(galaxyTenantId)) {
    return { allowed: false, status: 503, message: "Proof campaign control is not bound to a Galaxy tenant" }
  }
  if (!user || user.tenantId.toLowerCase() !== galaxyTenantId.toLowerCase()) {
    return { allowed: false, status: 403, message: "Proof campaign control is not authorized for this Galaxy tenant" }
  }
  if (user.role !== "owner" && user.role !== "admin") {
    return { allowed: false, status: 403, message: "Proof campaign control requires a Galaxy owner or admin" }
  }
  return { allowed: true }
}

function normalizedOrigin(value) {
  if (typeof value !== "string" || !value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export function evaluateProofCampaignMutationAuthority(
  user,
  requestUrl,
  requestOrigin,
  environment,
  nowMs = Date.now(),
) {
  const expectedOrigin = normalizedOrigin(environment.AUTH_ORIGIN || requestUrl)
  if (!expectedOrigin || normalizedOrigin(requestOrigin) !== expectedOrigin) {
    return { allowed: false, status: 403, message: "Proof campaign mutation origin is not allowed" }
  }
  const configured = Number(environment.PROOF_CAMPAIGN_MAX_SESSION_AGE_MINUTES || 15)
  const maxAgeMinutes = Number.isFinite(configured) ? configured : 15
  if (!isFreshAuthentication(user?.authenticatedAt, nowMs, maxAgeMinutes)) {
    return { allowed: false, status: 403, message: "Proof campaign mutation requires recent authentication" }
  }
  return { allowed: true }
}

export function resolveProofCampaignProxyConfig(environment) {
  const baseUrl = environment.HYADES_PROGRAM_CONTROL_API_INTERNAL
  const bearerToken = environment.GALAXY_DEPLOY_HYADES_PROGRAM_OPERATOR_BEARER_TOKEN
    || environment.HYADES_PROGRAM_OPERATOR_BEARER_TOKEN
  const hyadesTenant = environment.HYADES_PROGRAM_TENANT
  const hamProject = environment.HYADES_PROGRAM_HAM_PROJECT
  if (![baseUrl, bearerToken, hyadesTenant, hamProject].every((value) => typeof value === "string" && value.trim())) {
    return null
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    bearerToken,
    hyadesTenant,
    hamProject,
  }
}
