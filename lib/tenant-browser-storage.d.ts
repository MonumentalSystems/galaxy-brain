export const DEFAULT_TENANT_ID: string
export const ACCOUNT_BROWSER_STORAGE_PREFIXES: readonly string[]

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> &
  Partial<Pick<Storage, "key" | "length">>

export function tenantStorageKey(baseKey: string, tenantId: string): string

export function migrateDefaultTenantStorage(
  storage: BrowserStorage,
  tenantId: string,
  legacyKeys?: string[],
  legacyPrefixes?: string[],
): number

export function clearTenantStorage(
  storage: BrowserStorage,
  tenantId: string,
  legacyPrefixes?: readonly string[],
): number

export function tenantScopedStorage(
  storage: BrowserStorage,
  tenantId: string,
  legacyPrefixes?: readonly string[],
): Storage
