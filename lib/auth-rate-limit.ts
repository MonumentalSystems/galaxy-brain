import "server-only"

import { headers } from "next/headers"

import { hashOpaqueToken } from "@/lib/auth-security"
import { ensureAppSchema, getPool } from "@/lib/db"

function forwardedAddress(requestHeaders: Headers) {
  return (
    requestHeaders.get("x-real-ip")?.trim() ||
    requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  )
}

export async function authRequestIdentifier(request?: Request) {
  const requestHeaders = request?.headers || (await headers())
  return forwardedAddress(requestHeaders)
}

export async function takeAuthRateLimit(
  scope: string,
  identifier: string,
  limit: number,
  windowSeconds: number,
) {
  await ensureAppSchema()
  const bucketKey = hashOpaqueToken(`${scope}:${identifier}`)
  const result = await getPool().query(
    `INSERT INTO app_auth_rate_limits (bucket_key, attempt_count, expires_at)
     VALUES ($1, 1, now() + ($3::text || ' seconds')::interval)
     ON CONFLICT (bucket_key) DO UPDATE SET
       attempt_count = CASE
         WHEN app_auth_rate_limits.expires_at <= now() THEN 1
         ELSE app_auth_rate_limits.attempt_count + 1
       END,
       expires_at = CASE
         WHEN app_auth_rate_limits.expires_at <= now()
           THEN now() + ($3::text || ' seconds')::interval
         ELSE app_auth_rate_limits.expires_at
       END
     RETURNING attempt_count <= $2 AS allowed`,
    [bucketKey, limit, windowSeconds],
  )
  return result.rows[0]?.allowed === true
}

export function rateLimitResponse() {
  return Response.json(
    { error: "Too many authentication attempts. Wait a moment and try again." },
    { status: 429, headers: { "Retry-After": "60" } },
  )
}
