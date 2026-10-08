const READ_OPERATIONS = new Set(["page", "detail", "events"])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function evaluateHamTaskTenantAccess(user, environment) {
  const configuredTenant = environment.HAM_TASK_GALAXY_TENANT_ID
  if (typeof configuredTenant !== "string" || !UUID_PATTERN.test(configuredTenant)) {
    return {
      allowed: false,
      status: 503,
      message: "HAM task integration is not bound to a Galaxy tenant",
    }
  }
  if (!user || user.tenantId.toLowerCase() !== configuredTenant.toLowerCase()) {
    return {
      allowed: false,
      status: 403,
      message: "HAM task integration is not authorized for this Galaxy tenant",
    }
  }
  return { allowed: true, tenantId: configuredTenant.toLowerCase() }
}

export function resolveHamTaskProxyConfig(operation, environment) {
  const readOnly = READ_OPERATIONS.has(operation)
  const baseUrl = environment.HAM_TASK_API_INTERNAL
  const bearerToken = readOnly
    ? environment.GALAXY_DEPLOY_HAM_TASK_READ_BEARER_TOKEN
      || environment.HAM_TASK_READ_BEARER_TOKEN
    : environment.GALAXY_DEPLOY_HAM_TASK_WRITE_BEARER_TOKEN
      || environment.HAM_TASK_WRITE_BEARER_TOKEN
  if (typeof baseUrl !== "string" || !baseUrl || typeof bearerToken !== "string" || !bearerToken) {
    return null
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    bearerToken,
    readOnly,
  }
}
