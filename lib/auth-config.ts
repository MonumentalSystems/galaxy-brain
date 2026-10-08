import "server-only"

import { isWebAuthnRpIdAllowed } from "@/lib/auth-security"

export function getAuthOrigin() {
  const configured = process.env.AUTH_ORIGIN?.trim().replace(/\/$/, "")
  if (configured) return configured
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_ORIGIN must be configured in production.")
  }
  return "http://localhost:3000"
}

export function getWebAuthnConfig() {
  const origin = getAuthOrigin()
  const hostname = new URL(origin).hostname
  const rpID = process.env.WEBAUTHN_RP_ID?.trim() || hostname
  if (!isWebAuthnRpIdAllowed(origin, rpID)) {
    throw new Error("WEBAUTHN_RP_ID must equal the auth hostname or one of its parent domains.")
  }
  return {
    origin,
    rpID,
    rpName: process.env.WEBAUTHN_RP_NAME?.trim() || "Galaxy Brain",
  }
}

export function getRecoveryContact() {
  return process.env.AUTH_RECOVERY_CONTACT?.trim() || null
}
