import "server-only"

import { getAuthOrigin } from "@/lib/auth-config"

export const GENEROUS_CONNECT_PURPOSE_PREFIX = "generous-connect:"

const NOSTR_PUBKEY = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STATE = /^[A-Za-z0-9_-]{32,256}$/

export function safeReturnTo(value: string | null | undefined, fallback = "/workspace") {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback
  try {
    const parsed = new URL(value, getAuthOrigin())
    return parsed.origin === getAuthOrigin() ? `${parsed.pathname}${parsed.search}${parsed.hash}` : fallback
  } catch {
    return fallback
  }
}

export function isValidGenerousState(value: unknown): value is string {
  return typeof value === "string" && STATE.test(value)
}

export function getGenerousCallbackUrl() {
  const configured = process.env.CONNECT_CALLBACK_URL?.trim()
    || process.env.GENEROUS_CONNECT_CALLBACK_URL?.trim()
    || "https://www.generous.works/api/galaxy-brain/connect/callback"
  const parsed = new URL(configured)
  if (parsed.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Error("CONNECT_CALLBACK_URL must use HTTPS in production.")
  }
  parsed.hash = ""
  parsed.search = ""
  return parsed.toString()
}

export function isAllowedGenerousCallback(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const parsed = new URL(value)
    return parsed.toString() === getGenerousCallbackUrl()
  } catch {
    return false
  }
}

export function generousConnectionPurpose(tenantId: string, nostrPubkey: string) {
  if (!UUID.test(tenantId) || !NOSTR_PUBKEY.test(nostrPubkey)) {
    throw new Error("A valid Galaxy tenant and Nostr identity are required.")
  }
  return `${GENEROUS_CONNECT_PURPOSE_PREFIX}${tenantId}:${nostrPubkey}`
}

export function parseGenerousConnectionPurpose(purpose: string) {
  if (!purpose.startsWith(GENEROUS_CONNECT_PURPOSE_PREFIX)) return null
  const [tenantId, nostrPubkey, extra] = purpose.slice(GENEROUS_CONNECT_PURPOSE_PREFIX.length).split(":")
  if (extra !== undefined || !UUID.test(tenantId) || !NOSTR_PUBKEY.test(nostrPubkey)) return null
  return { tenantId, nostrPubkey }
}
