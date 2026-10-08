export const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001"

const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAPER_RECOVERY_PREFIX = "galaxy.paper-task-link-recovery.v2:"

export const ACCOUNT_BROWSER_STORAGE_PREFIXES = Object.freeze([
  "galaxy",
  "flowise",
  "knowledgeGraph",
  "userPreferences",
  "ham",
])

function normalizedTenantId(tenantId) {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error("tenant-scoped browser storage requires a valid tenant identifier")
  }
  return tenantId.toLowerCase()
}

function storedKeys(storage) {
  if (typeof storage.length !== "number" || typeof storage.key !== "function") return []
  const keys = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key) keys.push(key)
  }
  return keys
}

function isExplicitTenantKey(key) {
  return /:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)
    || new RegExp(`^${PAPER_RECOVERY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9a-f-]{36}:`, "i").test(key)
}

export function tenantStorageKey(baseKey, tenantId) {
  if (!baseKey) {
    throw new Error("tenant-scoped browser storage requires a valid tenant identifier")
  }
  return `${baseKey}:${normalizedTenantId(tenantId)}`
}

export function migrateDefaultTenantStorage(
  storage,
  tenantId,
  legacyKeys = [],
  legacyPrefixes = [],
) {
  if (normalizedTenantId(tenantId) !== DEFAULT_TENANT_ID) return 0
  const candidates = new Set(legacyKeys)
  for (const key of storedKeys(storage)) {
    if (isExplicitTenantKey(key)) continue
    if (legacyPrefixes.some((prefix) => key.startsWith(prefix))) candidates.add(key)
  }
  let migrated = 0
  for (const legacyKey of candidates) {
    const scopedKey = tenantStorageKey(legacyKey, tenantId)
    const legacyValue = storage.getItem(legacyKey)
    if (legacyValue == null) continue
    if (storage.getItem(scopedKey) == null) {
      storage.setItem(scopedKey, legacyValue)
      migrated += 1
    }
    storage.removeItem(legacyKey)
  }
  return migrated
}

export function clearTenantStorage(
  storage,
  tenantId,
  legacyPrefixes = ACCOUNT_BROWSER_STORAGE_PREFIXES,
) {
  const normalized = normalizedTenantId(tenantId)
  const suffix = `:${normalized}`
  const paperPrefix = `${PAPER_RECOVERY_PREFIX}${normalized}:`
  const keys = storedKeys(storage).filter((key) => (
    key.endsWith(suffix)
    || key.startsWith(paperPrefix)
    || (
      normalized === DEFAULT_TENANT_ID
      && !isExplicitTenantKey(key)
      && legacyPrefixes.some((prefix) => key.startsWith(prefix))
    )
  ))
  for (const key of keys) storage.removeItem(key)
  return keys.length
}

export function tenantScopedStorage(
  storage,
  tenantId,
  legacyPrefixes = ACCOUNT_BROWSER_STORAGE_PREFIXES,
) {
  const normalized = normalizedTenantId(tenantId)
  const suffix = `:${normalized}`
  const scopedKeys = () => storedKeys(storage)
    .filter((key) => key.endsWith(suffix))
    .map((key) => key.slice(0, -suffix.length))

  return {
    getItem: (key) => storage.getItem(tenantStorageKey(key, normalized)),
    setItem: (key, value) => storage.setItem(tenantStorageKey(key, normalized), value),
    removeItem: (key) => storage.removeItem(tenantStorageKey(key, normalized)),
    clear: () => clearTenantStorage(storage, normalized, legacyPrefixes),
    key: (index) => scopedKeys()[index] ?? null,
    get length() {
      return scopedKeys().length
    },
  }
}
