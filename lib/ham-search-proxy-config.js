export function resolveHamSearchBearer(environment) {
  const deploymentAlias = environment.GALAXY_DEPLOY_HAM_API_BEARER_TOKEN
  if (typeof deploymentAlias === "string" && deploymentAlias) return deploymentAlias

  const legacyBearer = environment.HAM_API_BEARER_TOKEN
  return typeof legacyBearer === "string" && legacyBearer ? legacyBearer : null
}

const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function evaluateHamSearchTenantAccess(user, environment) {
  const configuredTenant = environment.HAM_SEARCH_GALAXY_TENANT_ID
  if (typeof configuredTenant !== "string" || !TENANT_ID_PATTERN.test(configuredTenant)) {
    return {
      allowed: false,
      status: 503,
      message: "HAM search is not bound to a Galaxy tenant",
    }
  }
  if (!user || user.tenantId.toLowerCase() !== configuredTenant.toLowerCase()) {
    return {
      allowed: false,
      status: 403,
      message: "HAM search is not authorized for this Galaxy tenant",
    }
  }
  return { allowed: true, tenantId: configuredTenant.toLowerCase() }
}
