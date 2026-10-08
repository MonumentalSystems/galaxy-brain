const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NOSTR_PUBKEY_PATTERN = /^[0-9a-f]{64}$/

function configuredUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null
}

export function evaluateHamAdminAccess(user, environment) {
  const tenantId = configuredUuid(environment.HAM_ADMIN_GALAXY_TENANT_ID)
  const principalId = configuredUuid(environment.HAM_ADMIN_GALAXY_PRINCIPAL_ID)
  const ownerPubkey = typeof environment.HAM_ADMIN_OWNER_NOSTR_PUBKEY === "string"
    && NOSTR_PUBKEY_PATTERN.test(environment.HAM_ADMIN_OWNER_NOSTR_PUBKEY)
    ? environment.HAM_ADMIN_OWNER_NOSTR_PUBKEY
    : null
  if (!tenantId || !principalId || !ownerPubkey) {
    return {
      allowed: false,
      status: 503,
      message: "HAM owner administration is not bound to a Galaxy owner",
    }
  }
  if (
    !user ||
    user.principalKind !== "human" ||
    user.role !== "owner" ||
    user.tenantId.toLowerCase() !== tenantId ||
    user.principalId.toLowerCase() !== principalId ||
    user.authMethod !== "nostr" ||
    user.nostrPubkey !== ownerPubkey
  ) {
    return {
      allowed: false,
      status: 403,
      message: "HAM owner administration is not authorized for this Galaxy identity",
    }
  }
  return { allowed: true, tenantId, principalId, ownerPubkey }
}
