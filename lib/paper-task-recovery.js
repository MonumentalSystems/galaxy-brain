const RECOVERY_PREFIX = "galaxy.paper-task-link-recovery.v2"
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function paperTaskRecoveryNamespace(tenantId, principalId) {
  if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(principalId)) {
    throw new Error("Paper task recovery requires canonical tenant and principal identifiers")
  }
  return `${RECOVERY_PREFIX}:${tenantId.toLowerCase()}:${principalId.toLowerCase()}:`
}

function recoveryKey(namespace, idempotencyKey) {
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    throw new Error("Paper task recovery idempotency key is invalid")
  }
  return `${namespace}${idempotencyKey}`
}

export function writePaperTaskRecovery(storage, namespace, operation) {
  storage.setItem(recoveryKey(namespace, operation.idempotencyKey), JSON.stringify(operation))
}

export function removePaperTaskRecovery(storage, namespace, idempotencyKey) {
  storage.removeItem(recoveryKey(namespace, idempotencyKey))
}

export function readPaperTaskRecoveries(storage, namespace) {
  const recoveries = []
  const invalidKeys = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith(namespace)) continue
    try {
      const parsed = JSON.parse(storage.getItem(key) || "null")
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid recovery entry")
      recoveries.push(parsed)
    } catch {
      invalidKeys.push(key)
    }
  }
  for (const key of invalidKeys) storage.removeItem(key)
  return recoveries.sort((left, right) => {
    const byTime = String(left.createdAt || "").localeCompare(String(right.createdAt || ""))
    return byTime || String(left.idempotencyKey || "").localeCompare(String(right.idempotencyKey || ""))
  })
}
