import {
  ACCOUNT_BROWSER_STORAGE_PREFIXES,
  migrateDefaultTenantStorage,
  tenantScopedStorage,
} from "./tenant-browser-storage"

// Check if code is running in a browser environment
export const isBrowser = (): boolean => {
  return typeof window !== "undefined"
}

const unavailableStorage: Storage = {
  getItem: (_key: string) => null,
  setItem: (_key: string, _value: string) => {},
  removeItem: (_key: string) => {},
  clear: () => {},
  key: (_index: number) => null,
  length: 0,
}

let activeBrowserTenantId: string | null = null

export const setBrowserTenantScope = (tenantId: string) => {
  if (!isBrowser() || activeBrowserTenantId === tenantId.toLowerCase()) return
  migrateDefaultTenantStorage(
    window.localStorage,
    tenantId,
    [],
    [...ACCOUNT_BROWSER_STORAGE_PREFIXES],
  )
  migrateDefaultTenantStorage(
    window.sessionStorage,
    tenantId,
    [],
    [...ACCOUNT_BROWSER_STORAGE_PREFIXES],
  )
  activeBrowserTenantId = tenantId.toLowerCase()
}

export const safeUnscopedLocalStorage = (): Storage => {
  return isBrowser() ? window.localStorage : unavailableStorage
}

// Safe localStorage implementation that works in both browser and server environments
export const safeLocalStorage = () => {
  if (!isBrowser() || !activeBrowserTenantId) return unavailableStorage
  return tenantScopedStorage(window.localStorage, activeBrowserTenantId)
}

// Safe sessionStorage implementation
export const safeSessionStorage = () => {
  if (!isBrowser() || !activeBrowserTenantId) return unavailableStorage
  return tenantScopedStorage(window.sessionStorage, activeBrowserTenantId)
}

// Safe window.navigator implementation
export const safeNavigator = () => {
  if (isBrowser()) {
    return window.navigator
  }

  // SSR fallback — no-op implementation for server-side rendering
  return {
    userAgent: "",
    language: "",
    languages: [],
    clipboard: {
      writeText: async () => {},
      readText: async () => "",
    },
  } as unknown as Navigator
}

// Safe document implementation
export const safeDocument = () => {
  if (isBrowser()) {
    return window.document
  }

  // SSR fallback — no-op implementation for server-side rendering
  return {} as Document
}
